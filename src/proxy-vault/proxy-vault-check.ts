/**
 * Independent Egress concurrent proxy checker for Proxy Vault.
 *
 * Network isolation invariants:
 * - Supports http, https, and socks5 upstreams via proxy-relay.ts.
 * - Uses egress-transport.ts (raw TCP/TLS sockets) exclusively — never consults
 *   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables.
 * - Never falls back to direct egress when proxy relay or upstream fails.
 * - Looks up host direct egress at most once per batch to detect `same_exit`.
 * - Measures median RTT across successful attempts with performance.now().
 */

import {
  fetchDirectEgress,
  parseEgressResponse,
  resolveEgressEndpoints,
  type EgressInfo,
  type EgressLookupOptions,
} from "../egress.ts";
import {
  EgressResponseError,
  fetchEgressEndpoint,
  type EgressTransportOptions,
} from "../egress-transport.ts";
import { normalizeProxySpec } from "../proxy.ts";
import {
  classifyProxyAttempts,
  type ProxyCheckAttempt,
  type ProxyCheckResult,
} from "../proxy-check.ts";
import {
  startProxyRelay,
  type ProxyRelay,
  type RelayOptions,
  type UpstreamProxy,
} from "../proxy-relay.ts";
import type { ProxySpec } from "../types.ts";
import type {
  ProxyVaultInternalRecord,
  ProxyVaultItemView,
  ProxyVaultStore,
  VaultCheckTelemetry,
} from "./proxy-vault-store.ts";

export const DEFAULT_VAULT_CHECK_CONCURRENCY = 4;
export const MAX_VAULT_CHECK_CONCURRENCY = 8;
export const DEFAULT_VAULT_CHECK_ATTEMPTS = 3;
export const DEFAULT_VAULT_CHECK_TIMEOUT_MS = 15_000;

export type VaultRelayFactory = (upstream: UpstreamProxy, options?: RelayOptions) => Promise<ProxyRelay>;
export type VaultEgressFetcher = (endpoint: string, options: EgressTransportOptions) => Promise<Response>;

export interface VaultProxyCheckResult extends ProxyCheckResult {
  latencyMs: number | null;
  checkedAt: number;
}

export interface VaultProxyCheckOptions extends EgressLookupOptions {
  attempts?: number;
  signal?: AbortSignal | null;
  /** Shared direct-IP baseline for batch checks; pass `null` if direct lookup failed. */
  direct?: EgressInfo | null;
  relayFactory?: VaultRelayFactory;
  relayOptions?: Omit<RelayOptions, "log">;
  fetchEgress?: VaultEgressFetcher;
  fetchDirect?: (options: { endpoints: readonly string[]; timeoutMs: number; signal?: AbortSignal | null }) => Promise<EgressInfo | null>;
  nowMs?: () => number;
}

export interface VaultBatchCheckOptions extends Omit<VaultProxyCheckOptions, "direct"> {
  concurrency?: number;
  vaultStore?: ProxyVaultStore;
}

export type VaultCheckStreamEvent =
  | { type: "start"; total: number; concurrency: number }
  | {
      type: "result";
      proxyId: string;
      result: VaultProxyCheckResult;
      item: ProxyVaultItemView | null;
      completed: number;
      total: number;
    }
  | {
      type: "done";
      total: number;
      completed: number;
      working: number;
      unstable: number;
      failed: number;
      unavailable: number;
      unsupported: number;
      cancelled: boolean;
    }
  | { type: "error"; error: string };

interface TimedAttempt extends ProxyCheckAttempt {
  latencyMs?: number;
  aborted?: boolean;
}

function combineSignals(a?: AbortSignal | null, b?: AbortSignal | null): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b ?? undefined;
}

function safeFailureReason(
  logs: readonly string[],
  errorMessage?: string,
): Exclude<ProxyCheckAttempt["reason"], undefined | "check_unavailable"> {
  const text = `${logs.join("\n")}\n${errorMessage ?? ""}`;
  if (/\b407\b|auth(?:entication)?|credential/i.test(text)) return "authentication_failed";
  if (/timed?\s*out|timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|name.+resolv/i.test(text)) return "dns_failed";
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|refused/i.test(text)) return "unreachable";
  return "connection_failed";
}

export function medianLatencyMs(samples: readonly number[]): number | null {
  const valid = samples.filter((v) => Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a - b);
  const mid = Math.floor(valid.length / 2);
  if (valid.length % 2 === 1) return Math.round(valid[mid]!);
  return Math.round((valid[mid - 1]! + valid[mid]!) / 2);
}

export function clampVaultCheckConcurrency(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_VAULT_CHECK_CONCURRENCY;
  return Math.max(1, Math.min(MAX_VAULT_CHECK_CONCURRENCY, Math.trunc(requested)));
}

async function defaultFetchDirectBaseline(options: {
  endpoints: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal | null;
  fetchEgress?: VaultEgressFetcher;
}): Promise<EgressInfo | null> {
  if (options.signal?.aborted) return null;
  const transport = options.fetchEgress ?? fetchEgressEndpoint;
  const directFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    transport(String(input), {
      signal: combineSignals(options.signal, init?.signal),
      timeoutMs: options.timeoutMs,
    })) as typeof fetch;
  try {
    return await fetchDirectEgress(
      { endpoints: options.endpoints, timeoutMs: options.timeoutMs },
      directFetch,
    );
  } catch {
    return null;
  }
}

async function runSingleProxyAttempt(
  proxy: ProxySpec,
  endpoints: readonly string[],
  timeoutMs: number,
  options: {
    signal?: AbortSignal | null;
    relayFactory: VaultRelayFactory;
    relayOptions?: Omit<RelayOptions, "log">;
    fetchEgress: VaultEgressFetcher;
    nowMs: () => number;
  },
): Promise<TimedAttempt> {
  if (options.signal?.aborted) {
    return { info: null, aborted: true };
  }
  const logs: string[] = [];
  let relay: ProxyRelay | undefined;
  const onAbort = () => {
    try {
      relay?.close();
    } catch {}
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    relay = await options.relayFactory(
      {
        type: proxy.type,
        host: proxy.host,
        port: Number(proxy.port),
        user: proxy.user,
        pass: proxy.pass,
      },
      {
        ...options.relayOptions,
        log: (message) => logs.push(message),
      },
    );
    if (options.signal?.aborted) {
      return { info: null, aborted: true };
    }

    let serviceFailed = false;
    let authenticationFailed = false;
    let lastErrorMessage = "";

    for (const endpoint of endpoints) {
      if (options.signal?.aborted) {
        return { info: null, aborted: true };
      }
      const attemptSignal = combineSignals(options.signal, AbortSignal.timeout(timeoutMs));
      const startedAt = options.nowMs();
      try {
        // Strictly route through the local relay port — never fall back to direct egress.
        const response = await options.fetchEgress(endpoint, {
          relayPort: relay.port,
          signal: attemptSignal,
          timeoutMs,
        });
        if (!response.ok) {
          if (response.status === 407) authenticationFailed = true;
          else serviceFailed = true;
          continue;
        }
        const info = parseEgressResponse(await response.text());
        if (info) {
          const latencyMs = Math.max(0, options.nowMs() - startedAt);
          return { info, latencyMs };
        }
        serviceFailed = true;
      } catch (error) {
        if (options.signal?.aborted) {
          return { info: null, aborted: true };
        }
        if (error instanceof EgressResponseError) {
          serviceFailed = true;
        } else {
          lastErrorMessage = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const relayReason = safeFailureReason(logs, lastErrorMessage);
    const reason =
      authenticationFailed || relayReason === "authentication_failed"
        ? "authentication_failed"
        : relayReason === "dns_failed" || relayReason === "unreachable" || relayReason === "timeout"
          ? relayReason
          : serviceFailed
            ? "check_unavailable"
            : relayReason;

    return {
      info: null,
      reason,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      return { info: null, aborted: true };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    return { info: null, reason: safeFailureReason(logs, errMsg) };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      relay?.close();
    } catch {}
  }
}

/**
 * Check a single proxy (http, https, or socks5) through proxy-relay + egress-transport,
 * measuring median RTT across successful attempts.
 */
export async function checkVaultProxy(
  input: ProxySpec,
  options: VaultProxyCheckOptions = {},
): Promise<VaultProxyCheckResult> {
  const proxy = normalizeProxySpec(input);
  if (!proxy) throw new Error("proxy is required");

  const endpoints = options.endpoints ? [...options.endpoints] : resolveEgressEndpoints();
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_CHECK_TIMEOUT_MS;
  const attemptCount = Math.max(1, Math.min(5, Math.trunc(options.attempts ?? DEFAULT_VAULT_CHECK_ATTEMPTS)));
  const relayFactory = options.relayFactory ?? startProxyRelay;
  const fetchEgress = options.fetchEgress ?? fetchEgressEndpoint;
  const nowMs = options.nowMs ?? (() => performance.now());

  const directPromise =
    options.direct !== undefined
      ? Promise.resolve(options.direct)
      : options.fetchDirect
        ? options.fetchDirect({ endpoints, timeoutMs, signal: options.signal }).catch(() => null)
        : defaultFetchDirectBaseline({ endpoints, timeoutMs, signal: options.signal, fetchEgress });

  const [direct, attempts] = await Promise.all([
    directPromise,
    Promise.all(
      Array.from({ length: attemptCount }, () =>
        runSingleProxyAttempt(proxy, endpoints, timeoutMs, {
          signal: options.signal,
          relayFactory,
          relayOptions: options.relayOptions,
          fetchEgress,
          nowMs,
        }),
      ),
    ),
  ]);

  const classified = classifyProxyAttempts(attempts, direct);
  const latencies = attempts
    .filter((attempt) => attempt.info !== null && attempt.latencyMs !== undefined)
    .map((attempt) => attempt.latencyMs!);

  return {
    ...classified,
    latencyMs: medianLatencyMs(latencies),
    checkedAt: Date.now(),
  };
}

/**
 * Concurrently check a batch of vault proxies with bounded concurrency (default 4, max 8),
 * fetching direct egress baseline once per batch, persisting results, and emitting
 * streaming progress events.
 */
export async function checkVaultProxiesBatch(
  records: readonly ProxyVaultInternalRecord[],
  onEvent: (event: VaultCheckStreamEvent) => void,
  options: VaultBatchCheckOptions = {},
): Promise<void> {
  const concurrency = clampVaultCheckConcurrency(options.concurrency);
  const total = records.length;
  onEvent({ type: "start", total, concurrency });

  const counts = {
    completed: 0,
    working: 0,
    unstable: 0,
    failed: 0,
    unavailable: 0,
    unsupported: 0,
  };

  if (total === 0 || options.signal?.aborted) {
    onEvent({
      type: "done",
      total,
      ...counts,
      cancelled: !!options.signal?.aborted,
    });
    return;
  }

  const endpoints = options.endpoints ? [...options.endpoints] : resolveEgressEndpoints();
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_CHECK_TIMEOUT_MS;
  const fetchEgress = options.fetchEgress ?? fetchEgressEndpoint;

  // Fetch host direct egress ONCE before launching the proxy worker pool.
  const direct = options.fetchDirect
    ? await options.fetchDirect({ endpoints, timeoutMs, signal: options.signal }).catch(() => null)
    : await defaultFetchDirectBaseline({ endpoints, timeoutMs, signal: options.signal, fetchEgress });

  let cursor = 0;
  const worker = async () => {
    while (!options.signal?.aborted && cursor < total) {
      const record = records[cursor++]!;
      let result: VaultProxyCheckResult;
      try {
        result = await checkVaultProxy(record.proxy, {
          ...options,
          endpoints,
          timeoutMs,
          direct,
          fetchEgress,
        });
      } catch {
        result = {
          status: "unavailable",
          attempts: options.attempts ?? DEFAULT_VAULT_CHECK_ATTEMPTS,
          successes: 0,
          reason: "check_unavailable",
          exitComparison: "unknown",
          latencyMs: null,
          checkedAt: Date.now(),
        };
      }
      if (options.signal?.aborted) break;

      const telemetry: VaultCheckTelemetry = {
        status: result.status,
        reason: result.reason,
        latencyMs: result.latencyMs,
        ip: result.ip,
        country: result.country,
        region: result.region,
        city: result.city,
        rotating: result.rotating,
        exitComparison: result.exitComparison,
        checkedAt: result.checkedAt,
      };
      const updatedItem = options.vaultStore
        ? options.vaultStore.recordCheckResult(record.id, telemetry)
        : null;

      counts.completed++;
      counts[result.status]++;
      onEvent({
        type: "result",
        proxyId: record.id,
        result,
        item: updatedItem,
        completed: counts.completed,
        total,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  onEvent({
    type: "done",
    total,
    ...counts,
    cancelled: !!options.signal?.aborted,
  });
}
