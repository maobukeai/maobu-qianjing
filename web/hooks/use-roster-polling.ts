import { useCallback, useEffect, useRef, useState } from "react";
import { fetchProfiles, serialLoader, type UiRoster } from "../api";

export interface UseRosterPollingOptions {
  enabled: boolean;
  intervalMs: number;
  maxBackoffMs?: number;
  /** Suspends the interval timer (e.g. while an active SSE stream is delivering updates). */
  pausePolling?: boolean;
  bulkOwnerActiveRef: React.RefObject<boolean>;
  onRoster: (roster: UiRoster) => void;
}

export interface UseRosterPollingResult {
  loaded: boolean;
  connErr: string | null;
  connectionAlertDismissed: boolean;
  dismissConnectionAlert: () => void;
  retryConnection: () => Promise<void>;
  refreshing: boolean;
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  load: () => Promise<void>;
  pollRoster: () => void;
  readFreshRoster: () => Promise<UiRoster>;
  rosterLoadSucceeded: React.RefObject<boolean>;
  lastRosterResult: React.RefObject<UiRoster | null>;
}

/**
 * Coordinates serialized roster fetching, visibility-aware polling, and
 * exponential backoff recovery when the local server is temporarily unreachable.
 */
export function useRosterPolling({
  enabled,
  intervalMs,
  maxBackoffMs = 30_000,
  pausePolling = false,
  bulkOwnerActiveRef,
  onRoster,
}: UseRosterPollingOptions): UseRosterPollingResult {
  const [loaded, setLoaded] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [connectionAlertDismissed, setConnectionAlertDismissed] =
    useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const rosterLoadSucceeded = useRef(false);
  const lastRosterResult = useRef<UiRoster | null>(null);
  const onRosterRef = useRef(onRoster);
  onRosterRef.current = onRoster;

  const consecutiveFailuresRef = useRef(0);
  const lastPollAtRef = useRef(0);

  const loadRoster = useCallback(async () => {
    try {
      const roster = await fetchProfiles();
      rosterLoadSucceeded.current = true;
      lastRosterResult.current = roster;
      lastPollAtRef.current = Date.now();
      const hadError = consecutiveFailuresRef.current > 0;
      consecutiveFailuresRef.current = 0;
      onRosterRef.current(roster);
      setConnErr(null);
      if (hadError) {
        setConnectionAlertDismissed(false);
      }
    } catch (e) {
      rosterLoadSucceeded.current = false;
      const prevFailures = consecutiveFailuresRef.current;
      consecutiveFailuresRef.current = prevFailures + 1;
      setConnErr(String(e));
      // Re-surface the offline alert when a fresh disconnection starts so a
      // previously dismissed transient error does not stay hidden permanently.
      if (prevFailures === 0) {
        setConnectionAlertDismissed(false);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadRosterRef = useRef(loadRoster);
  loadRosterRef.current = loadRoster;

  const loaderRef = useRef<ReturnType<typeof serialLoader> | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = serialLoader(() => loadRosterRef.current());
  }

  const { load, poll: pollRoster } = loaderRef.current;

  const readFreshRoster = useCallback(async () => {
    if (!bulkOwnerActiveRef.current) {
      throw new Error("The environment list could not refresh.");
    }
    await load();
    if (
      !bulkOwnerActiveRef.current ||
      !rosterLoadSucceeded.current ||
      !lastRosterResult.current
    ) {
      throw new Error("The environment list could not refresh.");
    }
    return lastRosterResult.current;
  }, [bulkOwnerActiveRef, load]);

  const dismissConnectionAlert = useCallback(() => {
    setConnectionAlertDismissed(true);
  }, []);

  const retryConnection = useCallback(async () => {
    setConnectionAlertDismissed(false);
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    if (!enabled || pausePolling) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const nextDelayMs = () => {
      const failures = consecutiveFailuresRef.current;
      if (failures <= 0) return intervalMs;
      return Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(4, failures));
    };

    const scheduleNext = () => {
      clearTimer();
      if (!alive) return;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => {
        if (!alive) return;
        if (typeof document !== "undefined" && document.hidden) return;
        pollRoster();
        scheduleNext();
      }, nextDelayMs());
    };

    const onVisibilityChange = () => {
      if (!alive || typeof document === "undefined") return;
      if (document.hidden) {
        clearTimer();
        return;
      }
      if (Date.now() - lastPollAtRef.current >= intervalMs) {
        pollRoster();
      }
      scheduleNext();
    };

    scheduleNext();
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
  }, [enabled, pausePolling, intervalMs, maxBackoffMs, pollRoster, connErr]);

  return {
    loaded,
    connErr,
    connectionAlertDismissed,
    dismissConnectionAlert,
    retryConnection,
    refreshing,
    setRefreshing,
    load,
    pollRoster,
    readFreshRoster,
    rosterLoadSucceeded,
    lastRosterResult,
  };
}
