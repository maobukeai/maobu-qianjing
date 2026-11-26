/** Real-time process metrics stream & trim/hibernate API client (fetch + ReadableStream, never EventSource). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppLockedError,
  getStandaloneSessionToken,
  isAppLockedError,
  isUnauthorizedError,
  notifyAppLockedFromResponse,
  notifyUnauthorizedResponse,
  readSseBody,
  UnauthorizedError,
} from "./api.ts";

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
const METRICS_READ_TIMEOUT_MS = 10_000;

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
  const path = "/ui/api/metrics/snapshot";
  const deadline = AbortSignal.timeout(METRICS_READ_TIMEOUT_MS);
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({ Accept: "application/json" }),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (response.status === 404 || response.status === 501) {
    return { snapshot: null, unsupported: true };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, isRecord(body) && typeof body.error === "string" ? body.error : "");
    return { snapshot: null, unsupported: false };
  }
  if (response.status === 423) {
    notifyAppLockedFromResponse(423, body);
    return { snapshot: null, unsupported: false };
  }
  if (!response.ok) {
    return { snapshot: null, unsupported: false };
  }
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
  const path = "/ui/api/metrics/stream";
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({ Accept: "text/event-stream" }),
    signal: options.signal,
  });
  if (response.status === 404 || response.status === 501) {
    options.onUnsupported?.();
    return;
  }
  if (response.status === 401) {
    throw notifyUnauthorizedResponse(401, path, "The local metrics session expired.") ?? new UnauthorizedError("The local metrics session expired.", path);
  }
  if (response.status === 423) {
    const lockedBody = await response.json().catch(() => null);
    if (notifyAppLockedFromResponse(423, lockedBody)) {
      throw new AppLockedError(isRecord(lockedBody) && typeof lockedBody.error === "string" ? lockedBody.error : undefined);
    }
  }
  if (!response.ok) {
    throw new Error(`Metrics stream failed (${response.status})`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || !contentType.includes("text/event-stream")) {
    try { void response.body?.cancel().catch(() => {}); } catch {}
    throw new Error("Metrics stream returned an unexpected response.");
  }
  options.onOpen?.();
  await readSseBody(response.body, {
    signal: options.signal,
    onEvent: (event) => {
      if (event.type === "metrics" || event.type === "metrics.snapshot" || event.type === "message") {
        const normalized = normalizeMetricsSnapshot(event.data);
        if (normalized) options.onSnapshot(normalized);
      }
    },
  });
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
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, parsed);
  }
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

export type ProfileResourcePolicyMode = "inherit" | "on" | "off";

export interface ProfileDataSaverOverride {
  mode: ProfileResourcePolicyMode;
  blockImages?: boolean;
  blockMedia?: boolean;
  blockFonts?: boolean;
}

export interface ProfileResourcePolicy {
  profileId: string;
  memorySaverMode: ProfileResourcePolicyMode;
  dataSaver: ProfileDataSaverOverride;
  updatedAt: number;
}

export interface EffectiveProfileResourcePolicy {
  memorySaver: boolean;
  dataSaver: {
    enabled: boolean;
    blockImages: boolean;
    blockMedia: boolean;
    blockFonts: boolean;
  };
}

function normalizeResourcePolicy(raw: unknown, fallbackProfileId: string): ProfileResourcePolicy {
  const r = isRecord(raw) ? raw : {};
  const modeVal = r.memorySaverMode;
  const memorySaverMode: ProfileResourcePolicyMode =
    modeVal === "on" || modeVal === "off" || modeVal === "inherit" ? modeVal : "inherit";
  const dsRaw = isRecord(r.dataSaver) ? r.dataSaver : {};
  const dsMode: ProfileResourcePolicyMode =
    dsRaw.mode === "on" || dsRaw.mode === "off" || dsRaw.mode === "inherit" ? dsRaw.mode : "inherit";
  const dataSaver: ProfileDataSaverOverride =
    dsMode === "on"
      ? {
          mode: "on",
          ...(typeof dsRaw.blockImages === "boolean" ? { blockImages: dsRaw.blockImages } : {}),
          ...(typeof dsRaw.blockMedia === "boolean" ? { blockMedia: dsRaw.blockMedia } : {}),
          ...(typeof dsRaw.blockFonts === "boolean" ? { blockFonts: dsRaw.blockFonts } : {}),
        }
      : { mode: dsMode };
  return {
    profileId: asStr(r.profileId, fallbackProfileId),
    memorySaverMode,
    dataSaver,
    updatedAt: asNum(r.updatedAt, 0),
  };
}

function normalizeEffectiveResourcePolicy(raw: unknown): EffectiveProfileResourcePolicy {
  const r = isRecord(raw) ? raw : {};
  const ds = isRecord(r.dataSaver) ? r.dataSaver : {};
  return {
    memorySaver: r.memorySaver === true,
    dataSaver: {
      enabled: ds.enabled === true,
      blockImages: ds.blockImages === true,
      blockMedia: ds.blockMedia === true,
      blockFonts: ds.blockFonts === true,
    },
  };
}

export async function fetchProfileResourcePolicy(
  profileId: string,
  signal?: AbortSignal,
): Promise<{
  supported: boolean;
  policy: ProfileResourcePolicy | null;
  effective: EffectiveProfileResourcePolicy | null;
}> {
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/resource-policy`;
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({ Accept: "application/json" }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404 || response.status === 501) {
    return { supported: false, policy: null, effective: null };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, isRecord(body) && typeof body.error === "string" ? body.error : "");
    throw new UnauthorizedError("Authentication required", path);
  }
  if (response.status === 423) {
    notifyAppLockedFromResponse(423, body);
  }
  if (!isRecord(body) || !response.ok || body.ok === false) {
    throw new Error(isRecord(body) && typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : "Could not load resource policy.");
  }
  return {
    supported: true,
    policy: normalizeResourcePolicy(body.policy, profileId),
    effective: normalizeEffectiveResourcePolicy(body.effective),
  };
}

export async function updateProfileResourcePolicy(
  profileId: string,
  patch: {
    memorySaverMode?: ProfileResourcePolicyMode;
    dataSaver?: ProfileDataSaverOverride;
  },
): Promise<{
  policy: ProfileResourcePolicy;
  effective: EffectiveProfileResourcePolicy;
  restartRequired: boolean;
}> {
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/resource-policy`;
  const response = await fetch(path, {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: authHeaders({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(patch),
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, isRecord(body) && typeof body.error === "string" ? body.error : "");
    throw new UnauthorizedError("Authentication required", path);
  }
  if (response.status === 423) {
    notifyAppLockedFromResponse(423, body);
  }
  if (!isRecord(body) || !response.ok || body.ok === false) {
    throw new Error(isRecord(body) && typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : "Could not update resource policy.");
  }
  return {
    policy: normalizeResourcePolicy(body.policy, profileId),
    effective: normalizeEffectiveResourcePolicy(body.effective),
    restartRequired: body.restartRequired === true,
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
  sampleTimeoutMs?: number;
}

export interface ResourceMonitorState {
  snapshot: MetricsSnapshot | null;
  byProfileId: ReadonlyMap<string, ProfileResourceMetric>;
  hibernatedIds: ReadonlySet<string>;
  streaming: boolean;
  reconnecting: boolean;
  unsupported: boolean;
  refreshNow: () => Promise<void>;
}

/**
 * Subscribe to live resource metrics strictly when needed:
 * - Zero requests when `runningCount === 0 && !panelOpen` or when `!eventsStream && !panelOpen`
 *   (protects all existing DOM test fixtures with strict URL whitelists).
 * - Automatically pauses while `document.hidden === true`.
 * - Distinguishes an unsupported endpoint (404/501) from a temporary outage.
 */
export function useResourceMonitor({
  enabled,
  runningCount,
  panelOpen,
  eventsStream,
  sampleTimeoutMs = METRICS_READ_TIMEOUT_MS,
}: UseResourceMonitorOptions): ResourceMonitorState {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const unsupportedRef = useRef(false);
  const readOwnerEnabled = useRef(false);
  const activeRead = useRef<AbortController | null>(null);
  const latestSnapshot = useRef<MetricsSnapshot | null>(null);

  const shouldConnect = enabled && !unsupported && ((runningCount > 0 && eventsStream) || panelOpen);

  const publishSnapshot = useCallback((next: MetricsSnapshot) => {
    latestSnapshot.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    readOwnerEnabled.current = enabled;
    return () => {
      readOwnerEnabled.current = false;
      activeRead.current?.abort();
    };
  }, [enabled]);

  const refreshNow = useCallback(async () => {
    if (!readOwnerEnabled.current) return;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    const snapshotAtStart = latestSnapshot.current;
    try {
      const result = await fetchMetricsSnapshot(controller.signal);
      if (controller.signal.aborted) return;
      const current = latestSnapshot.current;
      if (result.unsupported && !current) {
        unsupportedRef.current = true;
        setUnsupported(true);
        return;
      }
      // A snapshot requested earlier can arrive after a newer streamed sample.
      if (result.snapshot && (current === snapshotAtStart || !current || result.snapshot.ts > current.ts)) {
        publishSnapshot(result.snapshot);
      }
    } catch {
      // Quietly degrade; explicit user actions in drawer surface errors directly.
    } finally {
      if (activeRead.current === controller) activeRead.current = null;
    }
  }, [publishSnapshot]);

  useEffect(() => {
    if (enabled && panelOpen && (typeof document === "undefined" || !document.hidden)) void refreshNow();
  }, [enabled, panelOpen, refreshNow]);

  useEffect(() => {
    if (!shouldConnect) {
      setStreaming(false);
      setReconnecting(false);
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
      if (!alive || unsupportedRef.current || activeAbort || retryTimer !== undefined ||
          (typeof document !== "undefined" && document.hidden)) return;
      const controller = new AbortController();
      activeAbort = controller;
      const isCurrent = () => alive && activeAbort === controller && !controller.signal.aborted;
      let timedOut = false, unauthorized = false, locked = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, sampleTimeoutMs);
      };
      armWatchdog();
      try {
        await openMetricsStream({
          signal: controller.signal,
          onSnapshot: (next) => {
            if (!isCurrent()) return;
            armWatchdog();
            attempt = 0;
            publishSnapshot(next);
            setStreaming(true);
            setReconnecting(false);
          },
          onUnsupported: () => {
            if (!isCurrent()) return;
            unsupportedRef.current = true;
            setUnsupported(true);
          },
        });
      } catch (error) {
        unauthorized = isUnauthorizedError(error);
        locked = isAppLockedError(error);
      } finally {
        clearTimeout(watchdog);
      }
      if (activeAbort !== controller) return;
      activeAbort = null;
      if (!alive) return;
      setStreaming(false);
      if (unsupportedRef.current || unauthorized || locked || (controller.signal.aborted && !timedOut)) return;
      setReconnecting(true);
      const delay = Math.min(15_000, 1_500 * 2 ** Math.min(4, attempt++));
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (!alive || typeof document === "undefined" || unsupportedRef.current) return;
      if (document.hidden) {
        clearTimer();
        activeAbort?.abort();
        activeAbort = null;
        setStreaming(false);
        setReconnecting(false);
      } else {
        void connect();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
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
  }, [shouldConnect, sampleTimeoutMs, publishSnapshot]);

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
    reconnecting,
    unsupported,
    refreshNow,
  };
}
