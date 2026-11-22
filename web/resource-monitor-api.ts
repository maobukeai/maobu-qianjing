/** Real-time process metrics stream & trim/hibernate API client (fetch + ReadableStream, never EventSource). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSseParser, getStandaloneSessionToken, isUnauthorizedError } from "./api.ts";

export type WatermarkLevel = "normal" | "elevated" | "high" | "critical";

export interface HostMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  memoryLoadPercent: number;
}

export interface TotalsResourceSnapshot {
  runningProfiles: number;
  totalProcesses: number;
  totalRssBytes: number;
  totalPrivateBytes: number;
  totalCpuPercent: number;
}

export interface WatermarkStatus {
  level: WatermarkLevel;
  recommendedConcurrency: number;
  effectiveStartLimit: number;
  startDelayMs: number;
  memoryLoadPercent: number;
  availableBytes: number;
  paused: boolean;
  reason?: string;
}

export interface ProfileResourceMetric {
  profileId: string;
  name: string;
  engine: "chromium" | "firefox" | string;
  pid: number;
  processCount: number;
  rssBytes: number;
  privateBytes: number;
  cpuPercent: number;
  startedAt: number;
}

export interface MetricsSnapshot {
  ts: number;
  host: HostMemorySnapshot;
  totals: TotalsResourceSnapshot;
  watermark: WatermarkStatus;
  profiles: ProfileResourceMetric[];
  hibernatedProfileIds: string[];
  sampleDurationMs: number;
}

export interface TrimMemoryEntryResult {
  profileId: string;
  ok: boolean;
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
  error?: string;
}

export interface TrimMemoryActionResult {
  ok: boolean;
  results: TrimMemoryEntryResult[];
  totalFreedBytes: number;
}

export interface HibernateActionResult {
  ok: boolean;
  hibernated: string[];
  failed: Array<{ profileId: string; error: string }>;
}

const VALID_WATERMARKS = new Set<string>(["normal", "elevated", "high", "critical"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNum(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeMetricsSnapshot(raw: unknown): MetricsSnapshot | null {
  if (!isRecord(raw)) return null;
  const hostRaw = isRecord(raw.host) ? raw.host : null;
  if (!hostRaw) return null;
  const totalBytes = asNum(hostRaw.totalBytes ?? hostRaw.totalMemoryBytes);
  const availableBytes = asNum(hostRaw.availableBytes ?? hostRaw.availableMemoryBytes);
  const usedBytes = asNum(
    hostRaw.usedBytes ?? hostRaw.usedMemoryBytes,
    Math.max(0, totalBytes - availableBytes),
  );
  const memoryLoadPercent = asNum(
    hostRaw.memoryLoadPercent,
    totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  );

  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const profiles: ProfileResourceMetric[] = rawProfiles
    .filter(isRecord)
    .map((item) => {
      const profileId = asStr(item.profileId);
      if (!profileId) return null;
      return {
        profileId,
        name: asStr(item.name, profileId),
        engine: asStr(item.engine, "chromium"),
        pid: asNum(item.pid),
        processCount: Math.max(1, Math.round(asNum(item.processCount, 1))),
        rssBytes: Math.max(0, asNum(item.rssBytes)),
        privateBytes: Math.max(0, asNum(item.privateBytes)),
        cpuPercent: Math.max(0, asNum(item.cpuPercent)),
        startedAt: asNum(item.startedAt),
      };
    })
    .filter((item): item is ProfileResourceMetric => item !== null);

  const totalsRaw = isRecord(raw.totals) ? raw.totals : {};
  const computedRss = profiles.reduce((sum, item) => sum + item.rssBytes, 0);
  const computedPrivate = profiles.reduce((sum, item) => sum + item.privateBytes, 0);
  const computedCpu = profiles.reduce((sum, item) => sum + item.cpuPercent, 0);
  const computedProcs = profiles.reduce((sum, item) => sum + item.processCount, 0);

  const wmRaw = isRecord(raw.watermark) ? raw.watermark : {};
  const rawLevel = asStr(wmRaw.level ?? hostRaw.watermarkLevel, "normal");
  const level: WatermarkLevel = VALID_WATERMARKS.has(rawLevel)
    ? (rawLevel as WatermarkLevel)
    : memoryLoadPercent >= 90
      ? "critical"
      : memoryLoadPercent >= 85
        ? "high"
        : memoryLoadPercent >= 75
          ? "elevated"
          : "normal";
  const defaultLimit = level === "normal" ? 4 : level === "elevated" ? 2 : 1;
  const recommendedConcurrency = Math.max(
    1,
    Math.min(4, Math.floor(asNum(wmRaw.recommendedConcurrency ?? wmRaw.effectiveStartLimit, defaultLimit))),
  );

  const hibernatedProfileIds = Array.isArray(raw.hibernatedProfileIds)
    ? raw.hibernatedProfileIds.filter((id): id is string => typeof id === "string")
    : [];

  return {
    ts: asNum(raw.ts ?? raw.capturedAt, Date.now()),
    host: { totalBytes, availableBytes, usedBytes, memoryLoadPercent },
    totals: {
      runningProfiles: asNum(totalsRaw.runningProfiles, profiles.length),
      totalProcesses: asNum(totalsRaw.totalProcesses, computedProcs),
      totalRssBytes: asNum(totalsRaw.totalRssBytes, computedRss),
      totalPrivateBytes: asNum(totalsRaw.totalPrivateBytes, computedPrivate),
      totalCpuPercent: asNum(totalsRaw.totalCpuPercent, computedCpu),
    },
    watermark: {
      level,
      recommendedConcurrency,
      effectiveStartLimit: Math.max(
        0,
        Math.floor(asNum(wmRaw.effectiveStartLimit, level === "critical" ? 0 : recommendedConcurrency)),
      ),
      startDelayMs: Math.max(0, asNum(wmRaw.startDelayMs)),
      memoryLoadPercent: asNum(wmRaw.memoryLoadPercent, memoryLoadPercent),
      availableBytes: asNum(wmRaw.availableBytes, availableBytes),
      paused: wmRaw.paused === true || level === "critical",
      ...(typeof wmRaw.reason === "string" && wmRaw.reason ? { reason: wmRaw.reason } : {}),
    },
    profiles,
    hibernatedProfileIds,
    sampleDurationMs: asNum(raw.sampleDurationMs),
  };
}

/** Format raw bytes cleanly into compact MB / GB labels. */
export function formatMemoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/** Format CPU percentage cleanly to one decimal place. */
export function formatCpuPercent(cpu: number): string {
  if (!Number.isFinite(cpu) || cpu <= 0) return "0.0%";
  return `${cpu.toFixed(1)}%`;
}

/** Resolve bounded batch start concurrency (1..4) from the latest metrics snapshot. */
export function watermarkConcurrency(snapshot: MetricsSnapshot | null, max = 4): number {
  const safeMax = Math.max(1, Math.min(4, Math.floor(max)));
  if (!snapshot) return safeMax;
  const rec = snapshot.watermark.recommendedConcurrency;
  return Math.max(1, Math.min(safeMax, Math.floor(rec)));
}

function authHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  const token = getStandaloneSessionToken();
  if (token && !headers.has("X-Maobu-Session") && !headers.has("Authorization")) {
    headers.set("X-Maobu-Session", token);
  }
  return headers;
}

export async function fetchMetricsSnapshot(signal?: AbortSignal): Promise<{
  snapshot: MetricsSnapshot | null;
  unsupported: boolean;
}> {
  const response = await fetch("/ui/api/metrics/snapshot", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({ Accept: "application/json" }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404 || response.status === 501 || response.status === 503) {
    return { snapshot: null, unsupported: true };
  }
  if (!response.ok) {
    return { snapshot: null, unsupported: false };
  }
  const body = await response.json().catch(() => null);
  if (!isRecord(body) || body.ok === false) return { snapshot: null, unsupported: false };
  const snapshot = normalizeMetricsSnapshot(body.snapshot ?? body);
  return { snapshot, unsupported: false };
}

export interface OpenMetricsStreamOptions {
  signal: AbortSignal;
  onSnapshot: (snapshot: MetricsSnapshot) => void;
  onOpen?: () => void;
  onUnsupported?: () => void;
}

/** Open authenticated `GET /ui/api/metrics/stream` SSE stream via `fetch()` + `ReadableStream`. */
export async function openMetricsStream(options: OpenMetricsStreamOptions): Promise<void> {
  const response = await fetch("/ui/api/metrics/stream", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({ Accept: "text/event-stream" }),
    signal: options.signal,
  });
  if (response.status === 404 || response.status === 501 || response.status === 503) {
    options.onUnsupported?.();
    return;
  }
  if (!response.ok) {
    throw new Error(`Metrics stream failed (${response.status})`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || !contentType.includes("text/event-stream")) {
    try { void response.body?.cancel().catch(() => {}); } catch {}
    options.onUnsupported?.();
    return;
  }
  options.onOpen?.();
  const reader = response.body.getReader();
  const parser = createSseParser((event) => {
    if (event.type === "metrics" || event.type === "metrics.snapshot" || event.type === "message") {
      const normalized = normalizeMetricsSnapshot(event.data);
      if (normalized) options.onSnapshot(normalized);
    }
  });
  try {
    while (!options.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) parser.push(value);
    }
    if (!options.signal.aborted) parser.finish();
  } finally {
    try { await reader.cancel().catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

async function postMetricAction(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await response.json().catch(() => null);
  if (!isRecord(parsed)) throw new Error("Resource action returned an invalid response.");
  if (!response.ok || parsed.ok === false) {
    throw new Error(
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error.trim()
        : "Resource action failed.",
    );
  }
  return parsed;
}

function normalizeTrimResult(raw: unknown): TrimMemoryEntryResult | null {
  if (!isRecord(raw)) return null;
  const profileId = asStr(raw.profileId);
  if (!profileId) return null;
  const beforeBytes = asNum(raw.beforeBytes ?? raw.beforeRssBytes);
  const afterBytes = asNum(raw.afterBytes ?? raw.afterRssBytes);
  const freedBytes = asNum(
    raw.freedBytes ?? raw.reclaimedBytes,
    Math.max(0, beforeBytes - afterBytes),
  );
  return {
    profileId,
    ok: raw.ok !== false,
    beforeBytes,
    afterBytes,
    freedBytes,
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
  };
}

export async function trimProfileMemory(profileId: string): Promise<TrimMemoryActionResult> {
  const body = await postMetricAction(`/ui/api/profiles/${encodeURIComponent(profileId)}/trim-memory`);
  const singleSource = isRecord(body.result) ? body.result : body;
  const results = Array.isArray(body.results)
    ? body.results.map(normalizeTrimResult).filter((r): r is TrimMemoryEntryResult => r !== null)
    : [normalizeTrimResult({ profileId, ...singleSource })].filter((r): r is TrimMemoryEntryResult => r !== null);
  const explicitFreed =
    body.totalFreedBytes ??
    body.totalReclaimedBytes ??
    body.freedBytes ??
    body.reclaimedBytes ??
    (isRecord(body.result) ? (body.result.freedBytes ?? body.result.reclaimedBytes) : undefined);
  const totalFreedBytes = asNum(
    explicitFreed,
    results.reduce((sum, item) => sum + item.freedBytes, 0),
  );
  return { ok: true, results, totalFreedBytes };
}

export async function trimAllProfilesMemory(): Promise<TrimMemoryActionResult> {
  const body = await postMetricAction("/ui/api/metrics/trim-all");
  const results = Array.isArray(body.results)
    ? body.results.map(normalizeTrimResult).filter((r): r is TrimMemoryEntryResult => r !== null)
    : [];
  const totalFreedBytes = asNum(
    body.totalFreedBytes ?? body.totalReclaimedBytes,
    results.reduce((sum, item) => sum + item.freedBytes, 0),
  );
  return { ok: true, results, totalFreedBytes };
}

export async function hibernateProfile(profileId: string): Promise<HibernateActionResult> {
  const body = await postMetricAction(`/ui/api/profiles/${encodeURIComponent(profileId)}/hibernate`);
  let hibernated: string[];
  if (Array.isArray(body.hibernated)) {
    hibernated = body.hibernated.filter((id): id is string => typeof id === "string");
  } else if (
    body.hibernated === false ||
    body.status === "not_found" ||
    body.status === "stop_failed" ||
    (body.status === "not_running" && body.hibernated !== true)
  ) {
    hibernated = [];
  } else {
    hibernated = [profileId];
  }
  return {
    ok: true,
    hibernated,
    failed: [],
  };
}

export async function hibernateProfilesBatch(
  input: { ids: string[] } | { all: true },
): Promise<HibernateActionResult> {
  const body = await postMetricAction("/ui/api/profiles/hibernate-batch", input);
  const rows = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
  const hibernated = Array.isArray(body.hibernated)
    ? body.hibernated.filter((id): id is string => typeof id === "string")
    : rows
        .filter((row) => row.status === "hibernated" || row.hibernated === true)
        .map((row) => asStr(row.profileId))
        .filter(Boolean);
  const failed = Array.isArray(body.failed)
    ? body.failed
        .filter(isRecord)
        .map((row) => ({ profileId: asStr(row.profileId), error: asStr(row.error, "Hibernate failed") }))
        .filter((row) => !!row.profileId)
    : rows
        .filter((row) => row.status === "stop_failed")
        .map((row) => ({ profileId: asStr(row.profileId), error: asStr(row.error, "Hibernate failed") }))
        .filter((row) => !!row.profileId);
  return { ok: true, hibernated, failed };
}

export interface UseResourceMonitorOptions {
  enabled: boolean;
  runningCount: number;
  panelOpen: boolean;
  eventsStream: boolean;
}

export interface ResourceMonitorState {
  snapshot: MetricsSnapshot | null;
  byProfileId: ReadonlyMap<string, ProfileResourceMetric>;
  hibernatedIds: ReadonlySet<string>;
  streaming: boolean;
  unsupported: boolean;
  refreshNow: () => Promise<void>;
}

/**
 * Subscribe to live resource metrics strictly when needed:
 * - Zero requests when `runningCount === 0 && !panelOpen` or when `!eventsStream && !panelOpen`
 *   (protects all existing DOM test fixtures with strict URL whitelists).
 * - Automatically pauses while `document.hidden === true`.
 * - Silently degrades if `/ui/api/metrics/stream` is unavailable (404/501).
 */
export function useResourceMonitor({
  enabled,
  runningCount,
  panelOpen,
  eventsStream,
}: UseResourceMonitorOptions): ResourceMonitorState {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const unsupportedRef = useRef(false);

  const shouldConnect = enabled && !unsupported && ((runningCount > 0 && eventsStream) || panelOpen);

  const refreshNow = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await fetchMetricsSnapshot();
      if (result.unsupported) {
        unsupportedRef.current = true;
        setUnsupported(true);
        return;
      }
      if (result.snapshot) setSnapshot(result.snapshot);
    } catch {
      // Quietly degrade; explicit user actions in drawer surface errors directly.
    }
  }, [enabled]);

  useEffect(() => {
    if (!shouldConnect) {
      setStreaming(false);
      return;
    }

    let alive = true;
    let activeAbort: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const clearTimer = () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const connect = async () => {
      while (alive && !unsupportedRef.current) {
        if (typeof document !== "undefined" && document.hidden) {
          setStreaming(false);
          return;
        }
        const controller = new AbortController();
        activeAbort = controller;
        try {
          await openMetricsStream({
            signal: controller.signal,
            onOpen: () => {
              if (!alive) return;
              attempt = 0;
              setStreaming(true);
            },
            onSnapshot: (next) => {
              if (alive) setSnapshot(next);
            },
            onUnsupported: () => {
              unsupportedRef.current = true;
              if (alive) {
                setUnsupported(true);
                setStreaming(false);
              }
            },
          });
          if (!alive || controller.signal.aborted || unsupportedRef.current) break;
        } catch (error) {
          if (!alive || controller.signal.aborted || isUnauthorizedError(error)) break;
        } finally {
          if (activeAbort === controller) activeAbort = null;
        }
        if (!alive || unsupportedRef.current) break;
        setStreaming(false);
        const delay = Math.min(15_000, 1_500 * 2 ** Math.min(4, attempt));
        attempt += 1;
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            resolve();
          }, delay);
        });
      }
    };

    const onVisibilityChange = () => {
      if (!alive || typeof document === "undefined" || unsupportedRef.current) return;
      if (document.hidden) {
        clearTimer();
        activeAbort?.abort();
        activeAbort = null;
        setStreaming(false);
      } else if (!activeAbort) {
        void connect();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (panelOpen) {
      void refreshNow();
    }
    void connect();

    return () => {
      alive = false;
      clearTimer();
      activeAbort?.abort();
      activeAbort = null;
      setStreaming(false);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [shouldConnect, panelOpen, refreshNow]);

  const byProfileId = useMemo(() => {
    const map = new Map<string, ProfileResourceMetric>();
    for (const item of snapshot?.profiles ?? []) {
      map.set(item.profileId, item);
    }
    return map;
  }, [snapshot]);

  const hibernatedIds = useMemo(
    () => new Set(snapshot?.hibernatedProfileIds ?? []),
    [snapshot],
  );

  return {
    snapshot,
    byProfileId,
    hibernatedIds,
    streaming,
    unsupported,
    refreshNow,
  };
}
