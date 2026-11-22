import { join } from "node:path";
import { AppSettingsStore, defaultAppSettings, type AppSettings } from "../../app-settings.ts";
import { buildWindowLabel, profileDisplayNo } from "../launcher/launch-args.ts";
import { resolveEffectiveResourcePolicy } from "../launcher/resource-policy.ts";
import type { Launcher } from "../../launcher.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "../../profile-id.ts";
import { API_SECURITY_HEADERS } from "../../server.ts";
import type { ProfileStore } from "../../store.ts";
import { MetricsService, type MetricsSnapshot } from "../metrics/metrics-service.ts";
import { ResourcePolicyStore } from "../metrics/resource-policy-store.ts";
import { SSE_HEARTBEAT_INTERVAL_MS, SSE_KEEPALIVE_BYTES } from "./events-bus.ts";
import {
  msg,
  noStoreJson,
  profileEngine,
  rejectCrossOriginMutation,
  rejectUntrustedJsonMutation,
  safeDecodeIdParam,
  type UiRuntimeOptions,
} from "./shared.ts";

export interface RegisteredLaunchView {
  profileId: string;
  name: string;
  displayNo: string;
  engine: "chromium" | "firefox";
  pid: number;
  ownerPid: number | null;
  binaryPath: string;
  startedAt: number;
  windowLabel: string;
}

const MAX_HIBERNATE_BATCH = 200;
const METRICS_STREAM_HIGH_WATER_MARK = 64;
const encoder = new TextEncoder();

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { ok: false, error: `${allow} is required` },
    {
      status: 405,
      headers: {
        ...API_SECURITY_HEADERS,
        Allow: allow,
        "Cache-Control": "no-store",
      },
    },
  );
}

function encodeMetricsFrame(snapshot: MetricsSnapshot): Uint8Array {
  return encoder.encode(`event: metrics\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

function readCurrentAppSettings(options: UiRuntimeOptions): AppSettings {
  if (options.appSettings) {
    try {
      return options.appSettings.read();
    } catch {
      return defaultAppSettings();
    }
  }
  if (options.paths?.root) {
    try {
      return new AppSettingsStore(join(options.paths.root, "app-settings.json")).read();
    } catch {
      return defaultAppSettings();
    }
  }
  return defaultAppSettings();
}

function withResourcePolicyStore<T>(
  options: UiRuntimeOptions,
  fn: (policyStore: ResourcePolicyStore) => T,
): { ok: true; value: T } | { ok: false } {
  if (options.resourcePolicies) {
    return { ok: true, value: fn(options.resourcePolicies) };
  }
  if (options.paths?.database) {
    const tempStore = new ResourcePolicyStore(options.paths.database);
    try {
      return { ok: true, value: fn(tempStore) };
    } finally {
      tempStore.close();
    }
  }
  return { ok: false };
}

function resolveMetricsService(
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions,
): MetricsService {
  return options.metrics ?? new MetricsService({ store, launcher });
}

function listRegisteredLaunches(store: ProfileStore): RegisteredLaunchView[] {
  const meta = store.listProfileMeta();
  const launches = store.listLaunches();
  const result: RegisteredLaunchView[] = [];
  for (const launch of launches) {
    const profile = store.getProfile(launch.profileId);
    const name = profile?.name ?? launch.profileId;
    const displayNo = profileDisplayNo(profile?.customNo, meta.get(launch.profileId)?.serial ?? null) ?? "";
    const engine: "chromium" | "firefox" =
      launch.engine === "firefox" || (profile && profileEngine(profile) === "firefox")
        ? "firefox"
        : "chromium";
    const ownerPid =
      typeof launch.firefoxOwner?.pid === "number" && launch.firefoxOwner.pid > 0
        ? launch.firefoxOwner.pid
        : null;
    result.push({
      profileId: launch.profileId,
      name,
      displayNo,
      engine,
      pid: launch.pid,
      ownerPid,
      binaryPath: launch.binaryPath ?? "",
      startedAt: launch.startedAt,
      windowLabel: buildWindowLabel(name, displayNo || null).replace(/ — $/, ""),
    });
  }
  return result;
}

function handleMetricsStream(req: Request, options: UiRuntimeOptions): Response {
  if (req.method !== "GET") return methodNotAllowed("GET");
  const crossOrigin = rejectCrossOriginMutation(req);
  if (crossOrigin) {
    crossOrigin.headers.set("Cache-Control", "no-store");
    return crossOrigin;
  }

  const metrics = options.metrics;
  if (!metrics || metrics.isClosed()) {
    return noStoreJson({ ok: false, error: "metrics stream is unavailable" }, 503);
  }

  const heartbeatMs = Math.max(25, options.metricsHeartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS);
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    req.signal.removeEventListener("abort", onAbort);
    const detach = unsubscribe;
    unsubscribe = undefined;
    detach?.();
    const ctrl = controllerRef;
    controllerRef = null;
    if (ctrl) {
      try {
        ctrl.close();
      } catch {}
    }
  };

  const onAbort = () => cleanup();

  const enqueueBytes = (bytes: Uint8Array) => {
    if (closed || !controllerRef) return;
    if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
      cleanup();
      return;
    }
    try {
      controllerRef.enqueue(bytes);
    } catch {
      cleanup();
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        if (req.signal.aborted || metrics.isClosed()) {
          cleanup();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });

        try {
          const initial = metrics.snapshot();
          enqueueBytes(encodeMetricsFrame(initial));
        } catch {
          cleanup();
          return;
        }
        if (closed) return;

        unsubscribe = metrics.subscribe((snapshot) => {
          enqueueBytes(encodeMetricsFrame(snapshot));
        });
        if (closed) {
          unsubscribe?.();
          unsubscribe = undefined;
          return;
        }

        heartbeatTimer = setInterval(() => {
          enqueueBytes(SSE_KEEPALIVE_BYTES);
        }, heartbeatMs);
      },
      cancel() {
        cleanup();
      },
    },
    new CountQueuingStrategy({ highWaterMark: METRICS_STREAM_HIGH_WATER_MARK }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      ...API_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Handles resource monitoring, memory trim, hibernation, per-profile resource policies,
 * and the authoritative Win32 window launch registry endpoint.
 */
export async function handleMetricsAndWindowsRoutes(
  req: Request,
  pathname: string,
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions,
): Promise<Response | null> {
  // 1. Authoritative window launch registry for Rust Win32WindowRegistry (zero credentials).
  if (pathname === "/ui/api/windows/registered-launches") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    return noStoreJson({ ok: true, launches: listRegisteredLaunches(store) });
  }

  // 2. Metrics snapshot & dedicated SSE stream
  if (pathname === "/ui/api/metrics/snapshot") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    const metrics = resolveMetricsService(launcher, store, options);
    return noStoreJson({ ok: true, snapshot: metrics.snapshot() });
  }

  if (pathname === "/ui/api/metrics/stream") {
    return handleMetricsStream(req, options);
  }

  // 3. Global trim-all memory
  if (pathname === "/ui/api/metrics/trim-all") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    const metrics = resolveMetricsService(launcher, store, options);
    try {
      const result = await metrics.trimAllMemory();
      return noStoreJson({ ok: true, ...result });
    } catch (error) {
      return noStoreJson({ ok: false, error: msg(error) }, 500);
    }
  }

  // 4. Batch hibernate profiles
  if (pathname === "/ui/api/profiles/hibernate-batch") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    let body: { ids?: unknown; all?: unknown };
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return noStoreJson({ ok: false, error: "Expected a JSON object" }, 400);
      }
      body = parsed as { ids?: unknown; all?: unknown };
    } catch {
      return noStoreJson({ ok: false, error: "Invalid JSON body" }, 400);
    }

    let ids: string[];
    if (body.all === true) {
      ids = store.listLaunches().map((l) => l.profileId);
    } else {
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return noStoreJson({ ok: false, error: "no profiles selected" }, 400);
      }
      if (body.ids.length > MAX_HIBERNATE_BATCH) {
        return noStoreJson({ ok: false, error: `at most ${MAX_HIBERNATE_BATCH} profiles may be hibernated at once` }, 400);
      }
      ids = body.ids.map(String);
      if (ids.some((id) => !isSafeProfileId(id))) {
        return noStoreJson({ ok: false, error: PROFILE_ID_ERROR }, 400);
      }
    }

    const metrics = resolveMetricsService(launcher, store, options);
    try {
      const result = await metrics.hibernateBatch(ids);
      return noStoreJson({ ok: true, ...result });
    } catch (error) {
      return noStoreJson({ ok: false, error: msg(error) }, 500);
    }
  }

  // 5. List all per-profile resource policies
  if (pathname === "/ui/api/profiles/resource-policies") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    const read = withResourcePolicyStore(options, (policyStore) => policyStore.list());
    return noStoreJson({ ok: true, policies: read.ok ? read.value : [] });
  }

  // 6. Per-profile trim-memory
  const trimMatch = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/trim-memory$/);
  if (trimMatch) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    const decoded = safeDecodeIdParam(trimMatch[1]!);
    if (!decoded.ok) return decoded.response;
    const profile = store.getProfile(decoded.id);
    if (!profile) return noStoreJson({ ok: false, error: "no such profile" }, 404);
    const metrics = resolveMetricsService(launcher, store, options);
    try {
      const result = await metrics.trimProfileMemory(decoded.id);
      return noStoreJson({ ok: true, result });
    } catch (error) {
      return noStoreJson({ ok: false, error: msg(error) }, 500);
    }
  }

  // 7. Per-profile hibernate
  const hibernateMatch = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/hibernate$/);
  if (hibernateMatch) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const crossOrigin = rejectCrossOriginMutation(req);
    if (crossOrigin) {
      crossOrigin.headers.set("Cache-Control", "no-store");
      return crossOrigin;
    }
    const decoded = safeDecodeIdParam(hibernateMatch[1]!);
    if (!decoded.ok) return decoded.response;
    const profile = store.getProfile(decoded.id);
    if (!profile) return noStoreJson({ ok: false, error: "no such profile" }, 404);
    const metrics = resolveMetricsService(launcher, store, options);
    try {
      const result = await metrics.hibernateProfile(decoded.id);
      if (result.status === "stop_failed") {
        return noStoreJson({ ok: false, error: "browser teardown unconfirmed", ...result }, 500);
      }
      return noStoreJson({ ok: true, ...result });
    } catch (error) {
      return noStoreJson({ ok: false, error: msg(error) }, 500);
    }
  }

  // 8. Per-profile resource policy GET / PATCH / PUT
  const policyMatch = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/resource-policy$/);
  if (policyMatch) {
    const decoded = safeDecodeIdParam(policyMatch[1]!);
    if (!decoded.ok) return decoded.response;
    const profile = store.getProfile(decoded.id);
    if (!profile) return noStoreJson({ ok: false, error: "no such profile" }, 404);

    if (req.method === "GET") {
      const crossOrigin = rejectCrossOriginMutation(req);
      if (crossOrigin) {
        crossOrigin.headers.set("Cache-Control", "no-store");
        return crossOrigin;
      }
      const settings = readCurrentAppSettings(options);
      const loaded = withResourcePolicyStore(options, (policyStore) => policyStore.get(decoded.id));
      const policy = loaded.ok
        ? loaded.value
        : { profileId: decoded.id, memorySaverMode: "inherit" as const, dataSaver: { mode: "inherit" as const }, updatedAt: 0 };
      const effective = resolveEffectiveResourcePolicy(profile, settings, policy);
      return noStoreJson({ ok: true, policy, effective });
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) {
        rejected.headers.set("Cache-Control", "no-store");
        return rejected;
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return noStoreJson({ ok: false, error: "Invalid JSON body" }, 400);
      }
      try {
        const saved = withResourcePolicyStore(options, (policyStore) => policyStore.set(decoded.id, body));
        if (!saved.ok) {
          return noStoreJson({ ok: false, error: "resource policy storage is unavailable" }, 503);
        }
        const settings = readCurrentAppSettings(options);
        const effective = resolveEffectiveResourcePolicy(profile, settings, saved.value);
        return noStoreJson({
          ok: true,
          policy: saved.value,
          effective,
          ...(store.getLaunch(decoded.id) ? { restartRequired: true } : {}),
        });
      } catch (error) {
        return noStoreJson({ ok: false, error: msg(error) }, 400);
      }
    }

    return methodNotAllowed("GET, PATCH, PUT");
  }

  return null;
}
