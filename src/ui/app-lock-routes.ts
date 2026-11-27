import { AppLockError, lockedResponse, type AppLockService } from "../app-lock.ts";
import { noStoreJson, rejectUntrustedJsonMutation } from "./shared.ts";

const APP_LOCK_PREFIX = "/ui/api/app-lock";
const MAX_JSON_BYTES = 16 * 1024;

export interface AppLockRouteOptions {
  appLock?: AppLockService;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function guardLocalRequest(req: Request, requireSettingsHeader: boolean): Response | null {
  const url = new URL(req.url);
  if (!isLoopbackHost(url.hostname)) {
    return noStoreJson({ ok: false, error: "Only same-origin local requests are allowed" }, 403);
  }
  const origin = req.headers.get("origin");
  if ((origin && origin !== url.origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    return noStoreJson({ ok: false, error: "Only same-origin local requests are allowed" }, 403);
  }
  if (requireSettingsHeader && req.headers.get("X-Maobu-Settings") !== "1") {
    return noStoreJson({ ok: false, error: "Local settings request header is required" }, 403);
  }
  return null;
}

async function readBoundedJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw Object.assign(new Error("App lock request is too large"), { status: 413 });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw Object.assign(new Error("App lock request is too large"), { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request"), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function errorResponse(error: unknown): Response {
  if (error instanceof AppLockError) {
    return noStoreJson(
      {
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.failedAttempts !== undefined ? { failedAttempts: error.failedAttempts } : {}),
        ...(error.cooldownUntil !== undefined ? { cooldownUntil: error.cooldownUntil } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      },
      error.httpStatus,
    );
  }
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : 400;
  const message = error instanceof Error ? error.message : "App lock operation failed";
  return noStoreJson({ ok: false, error: message }, status);
}

/**
 * UI API routes for the optional local master password lock:
 * - `GET  /ui/api/app-lock/status`
 * - `POST /ui/api/app-lock/setup`
 * - `POST /ui/api/app-lock/configure`
 * - `POST /ui/api/app-lock/unlock`
 * - `POST /ui/api/app-lock/lock`
 * - `POST /ui/api/app-lock/activity`
 */
export async function handleAppLockRoutes(
  req: Request,
  pathname: string,
  options: AppLockRouteOptions,
): Promise<Response | null> {
  if (pathname !== APP_LOCK_PREFIX && !pathname.startsWith(`${APP_LOCK_PREFIX}/`)) {
    return null;
  }

  const appLock = options.appLock;
  if (!appLock) {
    return noStoreJson({ ok: false, error: "App lock service is unavailable" }, 503);
  }

  if (pathname === `${APP_LOCK_PREFIX}/status`) {
    if (req.method !== "GET") {
      return noStoreJson({ ok: false, error: "Method not allowed" }, 405);
    }
    const denied = guardLocalRequest(req, false);
    if (denied) return denied;
    return noStoreJson({ ok: true, status: appLock.status() });
  }

  const action = pathname.slice(APP_LOCK_PREFIX.length);
  if (!["/setup", "/configure", "/unlock", "/lock", "/activity"].includes(action)) {
    return noStoreJson({ ok: false, error: "Unknown app lock operation" }, 404);
  }

  if (req.method !== "POST") {
    return noStoreJson({ ok: false, error: "Method not allowed" }, 405);
  }

  const localDenied = guardLocalRequest(req, true);
  if (localDenied) return localDenied;
  const mutationDenied = rejectUntrustedJsonMutation(req);
  if (mutationDenied) {
    mutationDenied.headers.set("Cache-Control", "no-store");
    return mutationDenied;
  }

  try {
    const body = await readBoundedJsonObject(req);

    if (action === "/unlock") {
      const status = await appLock.unlock(body.password);
      return noStoreJson({ ok: true, status });
    }

    // All routes other than /status and /unlock require the app to be unlocked.
    if (appLock.isLocked()) {
      const current = appLock.status();
      return lockedResponse({
        failedAttempts: current.failedAttempts,
        cooldownUntil: current.cooldownUntil,
        retryAfterMs: current.retryAfterMs,
      });
    }

    if (action === "/setup") {
      const allowed = new Set(["password", "idleTimeoutMinutes", "lockOnStartup"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        return noStoreJson({ ok: false, error: "Unexpected fields in app lock setup request" }, 400);
      }
      if (body.lockOnStartup !== undefined && typeof body.lockOnStartup !== "boolean") {
        return noStoreJson({ ok: false, error: "lockOnStartup must be a boolean" }, 400);
      }
      const status = await appLock.setup({
        password: body.password as string,
        idleTimeoutMinutes: body.idleTimeoutMinutes as number | undefined,
        lockOnStartup: body.lockOnStartup as boolean | undefined,
      });
      return noStoreJson({ ok: true, status });
    }

    if (action === "/configure") {
      const allowed = new Set(["currentPassword", "enabled", "newPassword", "idleTimeoutMinutes", "lockOnStartup"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        return noStoreJson({ ok: false, error: "Unexpected fields in app lock configure request" }, 400);
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return noStoreJson({ ok: false, error: "enabled must be a boolean" }, 400);
      }
      if (body.lockOnStartup !== undefined && typeof body.lockOnStartup !== "boolean") {
        return noStoreJson({ ok: false, error: "lockOnStartup must be a boolean" }, 400);
      }
      const status = await appLock.configure({
        currentPassword: body.currentPassword as string,
        enabled: body.enabled as boolean | undefined,
        newPassword: body.newPassword as string | undefined,
        idleTimeoutMinutes: body.idleTimeoutMinutes as number | undefined,
        lockOnStartup: body.lockOnStartup as boolean | undefined,
      });
      return noStoreJson({ ok: true, status });
    }

    if (action === "/lock") {
      const status = appLock.lock();
      return noStoreJson({ ok: true, status });
    }

    if (action === "/activity") {
      const updated = appLock.touchActivity();
      if (!updated) {
        const current = appLock.status();
        return lockedResponse({
          failedAttempts: current.failedAttempts,
          cooldownUntil: current.cooldownUntil,
          retryAfterMs: current.retryAfterMs,
        });
      }
      return noStoreJson({ ok: true, status: appLock.status() });
    }

    return noStoreJson({ ok: false, error: "Unknown app lock operation" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
