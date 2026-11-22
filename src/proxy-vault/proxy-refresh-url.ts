/**
 * Strict anti-SSRF fetcher for dynamic residential proxy IP refresh URLs.
 *
 * Security invariants:
 * - Only triggered explicitly by user action with a per-proxy 5s cooldown.
 * - Allows only http:/https:, forbids authority credentials, forbids single-label
 *   hosts and local suffixes (.localhost/.local/.internal), max URL length 2048.
 * - Resolves DNS once per hop with `{ all: true }` and rejects if ANY resolved IP
 *   falls inside a private, loopback, link-local, CGNAT, multicast, or reserved CIDR
 *   (including IPv4-mapped IPv6 folded via canonicalIp).
 * - Connects directly to the validated pinned IP (preventing DNS rebinding) without
 *   consulting system proxy environment variables or sending cookies.
 * - Follows at most 2 redirects, re-validating every hop and blocking HTTPS->HTTP
 *   downgrades, under a shared 10s timeout and 16 KiB response body limit.
 * - Never echoes the refresh URL or query parameters in any error message.
 */

import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions, type TLSSocket } from "node:tls";
import { EgressResponseError, readHttp } from "../../egress-transport.ts";
import { canonicalIp } from "../../ip.ts";

export const REFRESH_URL_MAX_LENGTH = 2048;
export const REFRESH_URL_MAX_REDIRECTS = 2;
export const REFRESH_URL_TIMEOUT_MS = 10_000;
export const REFRESH_URL_MAX_BODY_BYTES = 16 * 1024;
export const REFRESH_URL_MAX_WIRE_BYTES = 64 * 1024;
export const REFRESH_URL_COOLDOWN_MS = 5_000;

export type ProxyRefreshErrorCode =
  | "invalid_refresh_url"
  | "ssrf_blocked"
  | "https_downgrade"
  | "too_many_redirects"
  | "dns_failed"
  | "timeout"
  | "response_too_large"
  | "upstream_error"
  | "request_failed"
  | "cooldown_active"
  | "aborted";

export class ProxyRefreshError extends Error {
  constructor(
    message: string,
    readonly code: ProxyRefreshErrorCode,
    readonly status: number,
    readonly details: { retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "ProxyRefreshError";
  }
}

export interface ValidatedRefreshUrl {
  url: URL;
  host: string;
  displayHost: string;
  port: number;
}

export type RefreshDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export type RefreshTcpConnector = (
  ip: string,
  port: number,
  family: 4 | 6,
  signal: AbortSignal,
) => Promise<Socket>;

export interface ProxyRefreshOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal | null;
  lookupFn?: RefreshDnsLookup;
  connectTcp?: RefreshTcpConnector;
  tlsOptions?: Pick<TlsConnectionOptions, "ca" | "rejectUnauthorized">;
}

export interface ProxyRefreshResult {
  ok: true;
  httpStatus: number;
  redirects: number;
  refreshedAt: number;
}

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"] as const;

const IPV4_BLOCKED_CIDRS: ReadonlyArray<readonly [number, number]> = [
  // [network, mask] as unsigned 32-bit integers
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x64400000, 0xffc00000], // 100.64.0.0/10
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0000000, 0xffffff00], // 192.0.0.0/24
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15
  [0xe0000000, 0xf0000000], // 224.0.0.0/4 (multicast)
  [0xf0000000, 0xf0000000], // 240.0.0.0/4 (reserved + 255.255.255.255)
];

function parseIpv4Uint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function isBlockedIpv4Uint32(value: number): boolean {
  for (const [network, mask] of IPV4_BLOCKED_CIDRS) {
    if (((value & mask) >>> 0) === network) return true;
  }
  return false;
}

function parseIpv6BigInt(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  const doubleColonParts = lower.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const v4 = parseIpv4Uint32(token);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (doubleColonParts.length === 1) {
    const parsed = parseGroups(doubleColonParts[0]!);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  } else {
    const left = parseGroups(doubleColonParts[0]!);
    const right = parseGroups(doubleColonParts[1]!);
    if (!left || !right || left.length + right.length >= 8) return null;
    const zeros = new Array<number>(8 - left.length - right.length).fill(0);
    groups = [...left, ...zeros, ...right];
  }

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

function isBlockedIpv6BigInt(value: bigint): boolean {
  // ::/128, ::1/128, and deprecated IPv4-compatible ::/96
  if ((value >> 32n) === 0n) return true;
  // ::ffff:0:0/96 (IPv4-mapped) and ::ffff:0:0:0/96 (IPv4-translated)
  const upper96 = value >> 32n;
  if (upper96 === 0xffffn || upper96 === 0xffff00000000n) {
    return isBlockedIpv4Uint32(Number(value & 0xffffffffn) >>> 0);
  }
  // NAT64 well-known prefix 64:ff9b::/96 -> inspect embedded IPv4
  if (upper96 === 0x0064ff9b0000000000000000n) {
    return isBlockedIpv4Uint32(Number(value & 0xffffffffn) >>> 0);
  }
  // NAT64 local-use 64:ff9b:1::/48
  if ((value >> 80n) === 0x0064ff9b0001n) return true;
  // Discard prefix 100::/64
  if ((value >> 64n) === 0x0100000000000000n) return true;

  const h0 = Number((value >> 112n) & 0xffffn);
  // 6to4 2002::/16 -> inspect embedded IPv4 in bits 16..47
  if (h0 === 0x2002) {
    const embeddedV4 = Number((value >> 80n) & 0xffffffffn) >>> 0;
    if (isBlockedIpv4Uint32(embeddedV4)) return true;
  }
  // fc00::/7 (unique local)
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local) and fec0::/10 (deprecated site-local)
  if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 (multicast)
  if ((h0 & 0xff00) === 0xff00) return true;

  return false;
}

/** Return true if `rawIp` is invalid or falls into any private/local/reserved range. */
export function isBlockedIp(rawIp: string): boolean {
  const normalized = canonicalIp(rawIp);
  if (!normalized) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const v4 = parseIpv4Uint32(normalized);
    return v4 === null || isBlockedIpv4Uint32(v4);
  }
  if (version === 6) {
    const v6 = parseIpv6BigInt(normalized);
    return v6 === null || isBlockedIpv6BigInt(v6);
  }
  return true;
}

/** Normalize and assert that an IP address is publicly routable. */
export function assertPublicIp(rawIp: string): { ip: string; family: 4 | 6 } {
  const normalized = canonicalIp(rawIp);
  if (!normalized || isBlockedIp(normalized)) {
    throw new ProxyRefreshError(
      "Refresh endpoint resolves to a restricted network address.",
      "ssrf_blocked",
      400,
    );
  }
  const family = isIP(normalized);
  if (family !== 4 && family !== 6) {
    throw new ProxyRefreshError(
      "Refresh endpoint resolves to an invalid network address.",
      "ssrf_blocked",
      400,
    );
  }
  return { ip: normalized, family };
}

/**
 * Validate a proxy refresh URL syntactically (before storage or network access).
 * Never echoes the URL or query string in any thrown error.
 */
export function validateRefreshUrlSyntax(raw: unknown): ValidatedRefreshUrl {
  if (typeof raw !== "string") {
    throw new ProxyRefreshError("Refresh URL must be a string.", "invalid_refresh_url", 400);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProxyRefreshError("Refresh URL is empty.", "invalid_refresh_url", 400);
  }
  if (trimmed.length > REFRESH_URL_MAX_LENGTH || Buffer.byteLength(trimmed, "utf8") > REFRESH_URL_MAX_LENGTH) {
    throw new ProxyRefreshError(
      `Refresh URL exceeds the ${REFRESH_URL_MAX_LENGTH}-character limit.`,
      "invalid_refresh_url",
      400,
    );
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProxyRefreshError("Refresh URL contains invalid whitespace or control characters.", "invalid_refresh_url", 400);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProxyRefreshError("Refresh URL is not a valid HTTP(S) URL.", "invalid_refresh_url", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyRefreshError("Refresh URL must use http or https.", "invalid_refresh_url", 400);
  }

  // Reject both populated credentials and bare empty `@` authority markers.
  const afterScheme = trimmed.slice(url.protocol.length + 2);
  const rawAuthority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  if (url.username || url.password || rawAuthority.includes("@")) {
    throw new ProxyRefreshError("Refresh URL must not include authority credentials.", "invalid_refresh_url", 400);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) {
    throw new ProxyRefreshError("Refresh URL host is missing.", "invalid_refresh_url", 400);
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyRefreshError("Refresh URL port is invalid.", "invalid_refresh_url", 400);
  }

  if (isIP(host) !== 0) {
    assertPublicIp(host);
  } else {
    const normalizedHost = host.endsWith(".") ? host.slice(0, -1) : host;
    if (!normalizedHost || normalizedHost.includes("..") || !normalizedHost.includes(".")) {
      throw new ProxyRefreshError("Refresh URL host must be a public domain name.", "ssrf_blocked", 400);
    }
    if (
      normalizedHost === "localhost" ||
      LOCAL_HOST_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix))
    ) {
      throw new ProxyRefreshError("Refresh URL host cannot target local or internal domains.", "ssrf_blocked", 400);
    }
  }

  url.hash = "";
  return {
    url,
    host,
    displayHost: host,
    port,
  };
}

function defaultConnectTcp(ip: string, port: number, family: 4 | 6, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: ip, port, family });
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new ProxyRefreshError("Proxy IP refresh request was aborted.", "aborted", 499));
    };
    const onError = () => {
      cleanup();
      socket.destroy();
      reject(new ProxyRefreshError("Failed to connect to proxy IP refresh endpoint.", "request_failed", 502));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.off("error", onError);
    };
    socket.on("error", () => {});
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function resolvePinnedAddress(
  host: string,
  lookupFn: RefreshDnsLookup,
  signal: AbortSignal,
): Promise<{ ip: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  if (isIP(host) !== 0) {
    return assertPublicIp(host);
  }

  let records: LookupAddress[];
  try {
    records = await new Promise<LookupAddress[]>((resolve, reject) => {
      const onAbort = () =>
        reject(
          signal.reason instanceof ProxyRefreshError
            ? signal.reason
            : new ProxyRefreshError("Proxy IP refresh request was aborted.", "aborted", 499),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      lookupFn(host, { all: true, verbatim: true }).then(
        (res) => {
          signal.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  } catch (error) {
    if (error instanceof ProxyRefreshError) throw error;
    throw new ProxyRefreshError("Failed to resolve proxy IP refresh host.", "dns_failed", 502);
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new ProxyRefreshError("Proxy IP refresh host resolved to no addresses.", "dns_failed", 502);
  }

  // Every resolved IP must be public; reject mixed public+private DNS rebinding sets.
  let chosen: { ip: string; family: 4 | 6 } | null = null;
  for (const record of records) {
    const validated = assertPublicIp(record.address);
    if (!chosen) chosen = validated;
  }
  return chosen!;
}

async function sendPinnedRequest(
  target: ValidatedRefreshUrl,
  pinned: { ip: string; family: 4 | 6 },
  signal: AbortSignal,
  connectTcp: RefreshTcpConnector,
  maxBodyBytes: number,
  tlsOptions?: Pick<TlsConnectionOptions, "ca" | "rejectUnauthorized">,
): Promise<Response> {
  const socket = await connectTcp(pinned.ip, target.port, pinned.family, signal);
  let active: Socket | TLSSocket = socket;
  const onAbort = () => active.destroy();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    if (target.url.protocol === "https:") {
      active = await new Promise<TLSSocket>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error, value?: TLSSocket) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve(value!);
        };
        const secure = tlsConnect({
          socket,
          host: target.host,
          servername: isIP(target.host) ? undefined : target.host,
          rejectUnauthorized: true,
          ...tlsOptions,
        });
        active = secure;
        secure.once("secureConnect", () => {
          if (!secure.authorized && tlsOptions?.rejectUnauthorized !== false) {
            finish(new ProxyRefreshError("TLS verification failed for proxy IP refresh endpoint.", "request_failed", 502));
            return;
          }
          finish(undefined, secure);
        });
        secure.once("error", () => {
          finish(new ProxyRefreshError("TLS handshake failed for proxy IP refresh endpoint.", "request_failed", 502));
        });
        secure.once("close", () => {
          if (!secure.authorized && tlsOptions?.rejectUnauthorized !== false) {
            finish(new ProxyRefreshError("TLS handshake closed for proxy IP refresh endpoint.", "request_failed", 502));
          }
        });
        secure.resume();
      });
    }

    const requestTarget = `${target.url.pathname || "/"}${target.url.search}`;
    const rawRequest =
      `GET ${requestTarget} HTTP/1.1\r\n` +
      `Host: ${target.url.host}\r\n` +
      `User-Agent: MaobuProxyVault/1.0\r\n` +
      `Accept: application/json, text/plain, */*\r\n` +
      `Accept-Encoding: identity\r\n` +
      `Connection: close\r\n\r\n`;

    return await readHttp(active, rawRequest, signal, false, {
      maxBodyBytes,
      maxWireBytes: Math.max(REFRESH_URL_MAX_WIRE_BYTES, maxBodyBytes * 2),
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    active.destroy();
  }
}

/**
 * Trigger a dynamic residential proxy refresh URL with full SSRF defense,
 * IP pinning, bounded redirects, timeout, and size cap.
 */
export async function triggerProxyRefreshUrl(
  rawUrl: string,
  options: ProxyRefreshOptions = {},
): Promise<ProxyRefreshResult> {
  const timeoutMs = options.timeoutMs ?? REFRESH_URL_TIMEOUT_MS;
  const maxRedirects = Math.max(0, Math.min(REFRESH_URL_MAX_REDIRECTS, options.maxRedirects ?? REFRESH_URL_MAX_REDIRECTS));
  const maxBodyBytes = Math.max(1, Math.min(REFRESH_URL_MAX_BODY_BYTES, options.maxBodyBytes ?? REFRESH_URL_MAX_BODY_BYTES));
  const lookupFn = options.lookupFn ?? dnsLookup;
  const connectTcp = options.connectTcp ?? defaultConnectTcp;

  let current = validateRefreshUrlSyntax(rawUrl);

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ProxyRefreshError("Proxy IP refresh request timed out.", "timeout", 504));
  }, timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (controller.signal.aborted) {
        if (timedOut) throw new ProxyRefreshError("Proxy IP refresh request timed out.", "timeout", 504);
        throw new ProxyRefreshError("Proxy IP refresh request was aborted.", "aborted", 499);
      }

      const pinned = await resolvePinnedAddress(current.host, lookupFn, controller.signal);
      let response: Response;
      try {
        response = await sendPinnedRequest(
          current,
          pinned,
          controller.signal,
          connectTcp,
          maxBodyBytes,
          options.tlsOptions,
        );
      } catch (error) {
        if (error instanceof ProxyRefreshError) throw error;
        if (timedOut) {
          throw new ProxyRefreshError("Proxy IP refresh request timed out.", "timeout", 504);
        }
        if (controller.signal.aborted) {
          throw new ProxyRefreshError("Proxy IP refresh request was aborted.", "aborted", 499);
        }
        if (error instanceof EgressResponseError) {
          if (/too large|wire limit/i.test(error.message)) {
            throw new ProxyRefreshError(
              "Proxy IP refresh response exceeded the 16 KiB size limit.",
              "response_too_large",
              502,
            );
          }
          throw new ProxyRefreshError("Proxy IP refresh returned an invalid HTTP response.", "request_failed", 502);
        }
        throw new ProxyRefreshError("Proxy IP refresh request failed.", "request_failed", 502);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ProxyRefreshError(
            `Proxy IP refresh endpoint returned HTTP ${response.status} without redirect target.`,
            "upstream_error",
            502,
            { httpStatus: response.status },
          );
        }
        if (hop === maxRedirects) {
          throw new ProxyRefreshError(
            "Proxy IP refresh exceeded the maximum redirect limit.",
            "too_many_redirects",
            502,
          );
        }
        let resolvedNext: URL;
        try {
          resolvedNext = new URL(location, current.url);
        } catch {
          throw new ProxyRefreshError("Proxy IP refresh redirect target is invalid.", "invalid_refresh_url", 400);
        }
        if (current.url.protocol === "https:" && resolvedNext.protocol === "http:") {
          throw new ProxyRefreshError(
            "Proxy IP refresh redirect attempted an HTTPS-to-HTTP downgrade.",
            "https_downgrade",
            400,
          );
        }
        current = validateRefreshUrlSyntax(resolvedNext.href);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ProxyRefreshError(
          `Proxy IP refresh endpoint returned HTTP ${response.status}.`,
          "upstream_error",
          502,
          { httpStatus: response.status },
        );
      }

      return {
        ok: true,
        httpStatus: response.status,
        redirects: hop,
        refreshedAt: Date.now(),
      };
    }

    throw new ProxyRefreshError("Proxy IP refresh exceeded the maximum redirect limit.", "too_many_redirects", 502);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Per-proxy cooldown & in-flight guard enforcing a minimum interval between IP refresh calls. */
export class ProxyRefreshCooldown {
  private readonly inFlight = new Set<string>();
  private readonly lastTriggered = new Map<string, number>();

  constructor(readonly cooldownMs = REFRESH_URL_COOLDOWN_MS) {}

  tryAcquire(
    proxyId: string,
    persistedLastRefreshedAt = 0,
    now = Date.now(),
  ): { ok: true; release: (completedAt?: number) => void } | { ok: false; retryAfterMs: number } {
    if (this.inFlight.has(proxyId)) {
      return { ok: false, retryAfterMs: this.cooldownMs };
    }
    const last = Math.max(this.lastTriggered.get(proxyId) ?? 0, persistedLastRefreshedAt || 0);
    const elapsed = now - last;
    if (last > 0 && elapsed < this.cooldownMs) {
      return { ok: false, retryAfterMs: Math.max(1, this.cooldownMs - elapsed) };
    }
    this.inFlight.add(proxyId);
    this.lastTriggered.set(proxyId, now);
    let released = false;
    return {
      ok: true,
      release: (completedAt?: number) => {
        if (released) return;
        released = true;
        this.inFlight.delete(proxyId);
        if (completedAt !== undefined) {
          this.lastTriggered.set(proxyId, Math.max(this.lastTriggered.get(proxyId) ?? 0, completedAt));
        }
      },
    };
  }

  clear(): void {
    this.inFlight.clear();
    this.lastTriggered.clear();
  }
}
