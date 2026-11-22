import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLockStatus } from "../app-lock.ts";

export type { AppLockStatus };

export class AppLockApiError extends Error {
  override readonly name = "AppLockApiError";
  readonly status: number;
  readonly code?: string;
  readonly failedAttempts?: number;
  readonly cooldownUntil?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    details?: {
      code?: string;
      failedAttempts?: number;
      cooldownUntil?: number;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.status = status;
    this.code = details?.code;
    this.failedAttempts = details?.failedAttempts;
    this.cooldownUntil = details?.cooldownUntil;
    this.retryAfterMs = details?.retryAfterMs;
  }
}

export function isAppLockedResponse(status: number, body: unknown): boolean {
  return (
    status === 423
    && !!body
    && typeof body === "object"
    && (body as { code?: unknown }).code === "app_locked"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStatus(value: unknown): AppLockStatus {
  if (
    !isObject(value)
    || typeof value.configured !== "boolean"
    || typeof value.enabled !== "boolean"
    || typeof value.locked !== "boolean"
    || typeof value.lockOnStartup !== "boolean"
    || typeof value.idleTimeoutMinutes !== "number"
    || typeof value.failedAttempts !== "number"
    || typeof value.cooldownUntil !== "number"
    || typeof value.retryAfterMs !== "number"
    || typeof value.lastActivityAt !== "number"
  ) {
    throw new Error("App lock status response was incomplete.");
  }
  return {
    configured: value.configured,
    enabled: value.enabled,
    locked: value.locked,
    lockOnStartup: value.lockOnStartup,
    idleTimeoutMinutes: value.idleTimeoutMinutes,
    failedAttempts: value.failedAttempts,
    cooldownUntil: value.cooldownUntil,
    retryAfterMs: value.retryAfterMs,
    lastActivityAt: value.lastActivityAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    corrupt: value.corrupt === true,
  };
}

async function lockRequest(
  path: string,
  method: "GET" | "POST",
  payload?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AppLockStatus> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["X-Maobu-Settings"] = "1";
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`/ui/api/app-lock${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers,
    ...(method !== "GET" ? { body: JSON.stringify(payload ?? {}) } : {}),
    ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!isObject(body)) {
    throw new AppLockApiError("The local service returned an invalid response.", response.status);
  }
  if (!response.ok || body.ok !== true) {
    throw new AppLockApiError(
      typeof body.error === "string" && body.error ? body.error : "App lock request failed.",
      response.status,
      {
        code: typeof body.code === "string" ? body.code : undefined,
        failedAttempts: typeof body.failedAttempts === "number" ? body.failedAttempts : undefined,
        cooldownUntil: typeof body.cooldownUntil === "number" ? body.cooldownUntil : undefined,
        retryAfterMs: typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined,
      },
    );
  }
  return parseStatus(body.status);
}

export async function fetchAppLockStatus(signal?: AbortSignal): Promise<AppLockStatus> {
  return lockRequest("/status", "GET", undefined, signal);
}

export async function setupAppLock(input: {
  password: string;
  idleTimeoutMinutes?: number;
  lockOnStartup?: boolean;
}): Promise<AppLockStatus> {
  return lockRequest("/setup", "POST", input);
}

export async function configureAppLock(input: {
  currentPassword: string;
  enabled?: boolean;
  newPassword?: string;
  idleTimeoutMinutes?: number;
  lockOnStartup?: boolean;
}): Promise<AppLockStatus> {
  return lockRequest("/configure", "POST", input);
}

export async function unlockAppLock(password: string): Promise<AppLockStatus> {
  return lockRequest("/unlock", "POST", { password });
}

export async function lockAppNow(): Promise<AppLockStatus> {
  return lockRequest("/lock", "POST", {});
}

export async function reportAppLockActivity(): Promise<AppLockStatus> {
  return lockRequest("/activity", "POST", {});
}

export interface UseAppLockControllerOptions {
  /** Minimum interval between user activity heartbeats sent to backend (default 30s). */
  activityThrottleMs?: number;
  /** Interval for polling backend idle-lock transition while enabled & unlocked (default 15s). */
  idlePollMs?: number;
}

export function useAppLockController(options: UseAppLockControllerOptions = {}) {
  const activityThrottleMs = options.activityThrottleMs ?? 30_000;
  const idlePollMs = options.idlePollMs ?? 15_000;

  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastPingRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchAppLockStatus();
      setStatus(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const lockNow = useCallback(async () => {
    try {
      const next = await lockAppNow();
      setStatus(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  const notifyLocked = useCallback(() => {
    setStatus((prev) => (prev ? { ...prev, locked: true, enabled: true } : prev));
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Global Ctrl+Shift+L (Cmd+Shift+L on macOS) manual lock shortcut & active user heartbeat.
  useEffect(() => {
    if (!status?.enabled || status.locked) return;

    const pingActivity = () => {
      const now = Date.now();
      if (now - lastPingRef.current < activityThrottleMs) return;
      lastPingRef.current = now;
      void reportAppLockActivity()
        .then((next) => setStatus(next))
        .catch((err) => {
          if (err instanceof AppLockApiError && err.status === 423) {
            void refresh();
          }
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        void lockNow();
        return;
      }
      pingActivity();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", pingActivity, true);
    window.addEventListener("wheel", pingActivity, { passive: true });
    window.addEventListener("focus", pingActivity);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (status.idleTimeoutMinutes > 0) {
      timer = setInterval(() => {
        void refresh();
      }, idlePollMs);
    }

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", pingActivity, true);
      window.removeEventListener("wheel", pingActivity);
      window.removeEventListener("focus", pingActivity);
      if (timer) clearInterval(timer);
    };
  }, [status?.enabled, status?.locked, status?.idleTimeoutMinutes, activityThrottleMs, idlePollMs, lockNow, refresh]);

  return {
    status,
    loading,
    error,
    setStatus,
    refresh,
    lockNow,
    notifyLocked,
  };
}
