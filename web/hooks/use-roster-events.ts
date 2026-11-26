import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAppLockedError,
  isUnauthorizedError,
  openUiEventStream,
  type ProfileLifecycleEvent,
  type RuntimeDownload,
  type ScriptRun,
  type UiRoster,
  type UiStreamEvent,
} from "../api";
import {
  useRosterPolling,
  type UseRosterPollingOptions,
  type UseRosterPollingResult,
} from "./use-roster-polling";

export type { ProfileLifecycleEvent, RuntimeDownload, ScriptRun };

export type RosterTransport = "sse" | "polling" | "reconnecting";

export interface UseRosterEventsOptions extends UseRosterPollingOptions {
  sseEnabled: boolean;
  onLifecyclePatch?: (ev: ProfileLifecycleEvent) => void;
  onDownloads?: (downloads: RuntimeDownload[]) => void;
  onScriptRun?: (run: ScriptRun | null) => void;
  /** Degraded polling cadence while SSE is reconnecting (default 6s). */
  fallbackPollIntervalMs?: number;
  /** Low-frequency safety reconciliation while SSE is healthy (default 60s; <= 0 disables). */
  steadySafetyRefreshMs?: number;
  /** Initial reconnect delay for exponential backoff (default 1s). */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect delay cap (default 30s). */
  reconnectMaxDelayMs?: number;
  /** Symmetrical jitter ratio applied to reconnect backoff (default 0.2 for +/-20%). */
  reconnectJitterRatio?: number;
  /** Maximum wait for the initial connected frame (default 10s). */
  streamConnectTimeoutMs?: number;
  /** Maximum silence after the handshake, including keepalive comments (default 40s). */
  streamIdleTimeoutMs?: number;
}

export interface UseRosterEventsResult extends UseRosterPollingResult {
  transport: RosterTransport;
}

const DEFAULT_FALLBACK_POLL_MS = 6_000;
const DEFAULT_STEADY_SAFETY_REFRESH_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_JITTER = 0.2;
const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 10_000;
// The local stream sends a keepalive every 15s.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 40_000;

export function computeReconnectDelayMs(
  attempt: number,
  baseMs = DEFAULT_RECONNECT_BASE_MS,
  maxMs = DEFAULT_RECONNECT_MAX_MS,
  jitterRatio = DEFAULT_RECONNECT_JITTER,
  random: () => number = Math.random,
): number {
  const safeBase = Math.max(10, baseMs);
  const safeMax = Math.max(safeBase, maxMs);
  const raw = Math.min(safeMax, safeBase * 2 ** Math.min(10, Math.max(0, attempt)));
  if (jitterRatio <= 0) return Math.round(raw);
  const boundedJitter = Math.min(0.9, jitterRatio);
  const multiplier = 1 + (random() * 2 - 1) * boundedJitter;
  return Math.max(10, Math.round(raw * multiplier));
}

export function applyProfileLifecyclePatch(
  roster: UiRoster,
  ev: ProfileLifecycleEvent,
): { roster: UiRoster; matched: boolean } {
  let matched = false;
  const profiles = roster.profiles.map((profile) => {
    if (profile.id !== ev.profileId) return profile;
    matched = true;
    if (!ev.running) {
      const { debugPort: _debugPort, startedAt: _startedAt, restartPending: _restartPending, ...stopped } = profile;
      return { ...stopped, running: false };
    }
    return {
      ...profile,
      running: true,
      ...(ev.startedAt !== undefined ? { startedAt: ev.startedAt, lastOpenAt: ev.startedAt } : {}),
      ...(profile.engine === "chromium" && ev.debugPort !== undefined ? { debugPort: ev.debugPort } : {}),
    };
  });
  return matched ? { roster: { ...roster, profiles }, matched: true } : { roster, matched: false };
}

function parseLifecycleEvent(data: unknown): ProfileLifecycleEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.profileId !== "string" || !record.profileId || typeof record.running !== "boolean") {
    return null;
  }
  return {
    profileId: record.profileId,
    running: record.running,
    ...(typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? { startedAt: record.startedAt }
      : {}),
    ...(typeof record.debugPort === "number" && Number.isFinite(record.debugPort)
      ? { debugPort: record.debugPort }
      : {}),
  };
}

function parseDownloadsEvent(data: unknown): RuntimeDownload[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const downloads = (data as { downloads?: unknown }).downloads;
  if (!Array.isArray(downloads)) return null;
  for (const item of downloads) {
    if (
      !item ||
      typeof item !== "object" ||
      (item.runtime !== "aliasmode" && item.runtime !== "cloakbrowser" && item.runtime !== "firefox") ||
      !Number.isSafeInteger(item.receivedBytes) ||
      item.receivedBytes < 0 ||
      !Number.isSafeInteger(item.totalBytes) ||
      item.totalBytes < 0
    ) {
      return null;
    }
  }
  return downloads as RuntimeDownload[];
}

type StreamState = "idle" | "connecting" | "sse" | "reconnecting" | "unauthorized";

/**
 * Real-time roster transport backed by authenticated `GET /ui/api/events` SSE.
 * Falls back transparently to `useRosterPolling` when `sseEnabled` is false or
 * while recovering from a dropped stream connection.
 */
export function useRosterEvents({
  enabled,
  intervalMs,
  maxBackoffMs,
  bulkOwnerActiveRef,
  onRoster,
  sseEnabled,
  onLifecyclePatch,
  onDownloads,
  onScriptRun,
  fallbackPollIntervalMs = DEFAULT_FALLBACK_POLL_MS,
  steadySafetyRefreshMs = DEFAULT_STEADY_SAFETY_REFRESH_MS,
  reconnectBaseDelayMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_MS,
  reconnectJitterRatio = DEFAULT_RECONNECT_JITTER,
  streamConnectTimeoutMs = DEFAULT_STREAM_CONNECT_TIMEOUT_MS,
  streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
}: UseRosterEventsOptions): UseRosterEventsResult {
  const [streamState, setStreamState] = useState<StreamState>(() =>
    enabled && sseEnabled ? "connecting" : "idle",
  );
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const onLifecyclePatchRef = useRef(onLifecyclePatch);
  onLifecyclePatchRef.current = onLifecyclePatch;
  const onDownloadsRef = useRef(onDownloads);
  onDownloadsRef.current = onDownloads;
  const onScriptRunRef = useRef(onScriptRun);
  onScriptRunRef.current = onScriptRun;

  const lastEventIdRef = useRef<number | null>(null);
  const lastSyncAtRef = useRef(0);

  const sseActive = enabled && sseEnabled;
  const pausePolling =
    sseActive && (streamState === "sse" || streamState === "connecting" || streamState === "unauthorized");
  const effectiveIntervalMs = sseActive ? fallbackPollIntervalMs : intervalMs;

  const polling = useRosterPolling({
    enabled: enabled && streamState !== "unauthorized",
    intervalMs: effectiveIntervalMs,
    maxBackoffMs,
    pausePolling,
    bulkOwnerActiveRef,
    onRoster,
  });

  const pollRosterRef = useRef(polling.pollRoster);
  pollRosterRef.current = polling.pollRoster;
  const lastRosterResultRef = polling.lastRosterResult;
  const { load, isRosterLoading } = polling;

  useEffect(() => {
    if (!sseActive) {
      setStreamState("idle");
      return;
    }

    let alive = true;
    let attempt = 0;
    let activeAbort: AbortController | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeWait: (() => void) | null = null;

    setStreamState("connecting");

    const clearWait = () => {
      if (waitTimer !== undefined) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
      wakeWait = null;
    };

    const waitForReconnect = (delayMs: number) =>
      new Promise<void>((resolve) => {
        if (!alive) {
          resolve();
          return;
        }
        const finish = () => {
          clearWait();
          resolve();
        };
        wakeWait = finish;
        waitTimer = setTimeout(finish, delayMs);
      });

    const handleStreamEvent = (event: UiStreamEvent) => {
      if (!alive) return;
      if (event.id !== null) {
        lastEventIdRef.current = event.id;
      }
      if (event.type === "connected") {
        attempt = 0;
        lastSyncAtRef.current = Date.now();
        setStreamState("sse");
        void load();
        return;
      }
      if (event.type === "roster.changed") {
        lastSyncAtRef.current = Date.now();
        void load();
        return;
      }
      if (event.type === "profile.lifecycle") {
        const patch = parseLifecycleEvent(event.data);
        if (!patch) return;
        lastSyncAtRef.current = Date.now();
        const cached = lastRosterResultRef.current;
        const patched = cached ? applyProfileLifecyclePatch(cached, patch) : null;
        if (patched?.matched) {
          lastRosterResultRef.current = patched.roster;
        }
        if (onLifecyclePatchRef.current) {
          onLifecyclePatchRef.current(patch);
          // A read started before the event could contain the old state.
          if (!patched?.matched || isRosterLoading()) void load();
        } else {
          void load();
        }
        return;
      }
      if (event.type === "downloads.updated") {
        const downloads = parseDownloadsEvent(event.data);
        if (downloads) {
          onDownloadsRef.current?.(downloads);
        }
        return;
      }
      if (event.type === "script.run") {
        if (event.data && typeof event.data === "object" && !Array.isArray(event.data) && "run" in event.data) {
          const run = (event.data as { run?: ScriptRun | null }).run ?? null;
          onScriptRunRef.current?.(run);
        }
      }
    };

    const onVisibilityChange = () => {
      if (!alive || typeof document === "undefined" || document.hidden) return;
      if (wakeWait) {
        pollRosterRef.current();
        wakeWait();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    const connectLoop = async () => {
      while (alive) {
        const controller = new AbortController();
        activeAbort = controller;
        let connected = false;
        let timedOut = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const armWatchdog = (ms: number) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, ms);
        };
        armWatchdog(streamConnectTimeoutMs);
        try {
          await openUiEventStream({
            lastEventId: lastEventIdRef.current,
            signal: controller.signal,
            onActivity: () => {
              if (connected) armWatchdog(streamIdleTimeoutMs);
            },
            onEvent: (event) => {
              if (event.type === "connected") {
                connected = true;
                armWatchdog(streamIdleTimeoutMs);
              }
              if (connected) handleStreamEvent(event);
            },
          });
        } catch (error) {
          if (!alive) break;
          if (isUnauthorizedError(error)) {
            setStreamState("unauthorized");
            return;
          }
          if (isAppLockedError(error)) {
            return;
          }
        } finally {
          clearTimeout(watchdog);
          if (activeAbort === controller) {
            activeAbort = null;
          }
        }
        if (!alive || (controller.signal.aborted && !timedOut)) break;
        setStreamState("reconnecting");
        pollRosterRef.current();
        const delayMs = computeReconnectDelayMs(
          attempt,
          reconnectBaseDelayMs,
          reconnectMaxDelayMs,
          reconnectJitterRatio,
        );
        attempt += 1;
        await waitForReconnect(delayMs);
      }
    };

    void connectLoop();

    return () => {
      alive = false;
      const wake = wakeWait;
      clearWait();
      wake?.();
      activeAbort?.abort();
      activeAbort = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [
    sseActive,
    reconnectNonce,
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    reconnectJitterRatio,
    streamConnectTimeoutMs,
    streamIdleTimeoutMs,
    lastRosterResultRef,
    load,
    isRosterLoading,
  ]);

  // Low-frequency safety reconciliation while SSE is steadily connected.
  useEffect(() => {
    if (!sseActive || streamState !== "sse" || steadySafetyRefreshMs <= 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const schedule = () => {
      clearTimer();
      if (!alive) return;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => {
        if (!alive) return;
        if (typeof document !== "undefined" && document.hidden) return;
        lastSyncAtRef.current = Date.now();
        pollRosterRef.current();
        schedule();
      }, steadySafetyRefreshMs);
    };

    const onVisibilityChange = () => {
      if (!alive || typeof document === "undefined") return;
      if (document.hidden) {
        clearTimer();
        return;
      }
      if (Date.now() - lastSyncAtRef.current >= steadySafetyRefreshMs) {
        lastSyncAtRef.current = Date.now();
        pollRosterRef.current();
      }
      schedule();
    };

    schedule();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      alive = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [sseActive, streamState, steadySafetyRefreshMs]);

  const baseRetryConnection = polling.retryConnection;
  const retryConnection = useCallback(async () => {
    if (sseActive && streamState !== "sse") {
      setReconnectNonce((value) => value + 1);
    }
    await baseRetryConnection();
  }, [baseRetryConnection, sseActive, streamState]);

  const transport: RosterTransport = !sseActive
    ? "polling"
    : streamState === "sse"
      ? "sse"
      : streamState === "unauthorized"
        ? "polling"
        : "reconnecting";

  return {
    ...polling,
    retryConnection,
    transport,
  };
}
