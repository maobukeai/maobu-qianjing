import { checkProxy as runProxyCheck } from "../proxy-check.ts";
import {
  clearProfileEvents,
  isKnownProfileEventType,
  listProfileEvents,
  recordProfileEvent,
} from "../profile-timeline.ts";
import type { ProfileStore } from "../store.ts";
import {
  msg,
  noStoreJson,
  proxyCheckView,
  rejectCrossOriginMutation,
  rejectUntrustedJsonMutation,
  safeDecodeIdParam,
  type UiRuntimeOptions,
} from "./shared.ts";

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { ok: false, code: "method_not_allowed", error: `Method not allowed. Use ${allow}.` },
    { status: 405, headers: { "Cache-Control": "no-store", Allow: allow } },
  );
}

/**
 * Per-profile operation timeline (`GET/DELETE /ui/api/profiles/:id/timeline`)
 * and credential-free server-side proxy check (`POST /ui/api/profiles/:id/check-proxy`).
 */
export async function handleProfileTimelineRoutes(
  req: Request,
  pathname: string,
  store: ProfileStore,
  options: UiRuntimeOptions = {},
): Promise<Response | null> {
  const timelineMatch = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    if (req.method !== "GET" && req.method !== "DELETE") return methodNotAllowed("GET, DELETE");

    const decoded = safeDecodeIdParam(timelineMatch[1]!);
    if (!decoded.ok) {
      decoded.response.headers.set("Cache-Control", "no-store");
      return decoded.response;
    }
    const id = decoded.id;

    if (req.method === "DELETE") {
      const rejected = rejectCrossOriginMutation(req);
      if (rejected) {
        rejected.headers.set("Cache-Control", "no-store");
        return rejected;
      }
      if (!store.getProfile(id)) {
        return noStoreJson({ ok: false, code: "not_found", error: "Environment not found." }, 404);
      }
      const removed = clearProfileEvents(store, id);
      return noStoreJson({ ok: true, profileId: id, removed });
    }

    if (!store.getProfile(id)) {
      return noStoreJson({ ok: false, code: "not_found", error: "Environment not found." }, 404);
    }

    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const beforeIdParam = url.searchParams.get("beforeId");
    const typeParam = url.searchParams.get("type")?.trim() || undefined;

    let limit: number | undefined;
    if (limitParam !== null && limitParam !== "") {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return noStoreJson({ ok: false, code: "invalid_limit", error: "limit must be a positive integer." }, 400);
      }
      limit = parsed;
    }

    let beforeId: number | undefined;
    if (beforeIdParam !== null && beforeIdParam !== "") {
      const parsed = Number(beforeIdParam);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return noStoreJson({ ok: false, code: "invalid_cursor", error: "beforeId must be a positive integer." }, 400);
      }
      beforeId = parsed;
    }

    if (typeParam !== undefined && !isKnownProfileEventType(typeParam)) {
      return noStoreJson({ ok: false, code: "invalid_event_type", error: "Unsupported timeline event type." }, 400);
    }

    const page = listProfileEvents(store, id, { limit, beforeId, type: typeParam });
    return noStoreJson({ ok: true, profileId: id, ...page });
  }

  const checkProxyMatch = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/check-proxy$/);
  if (checkProxyMatch) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }

    const decoded = safeDecodeIdParam(checkProxyMatch[1]!);
    if (!decoded.ok) {
      decoded.response.headers.set("Cache-Control", "no-store");
      return decoded.response;
    }
    const id = decoded.id;
    const profile = store.getProfile(id);
    if (!profile) {
      return noStoreJson({ ok: false, code: "not_found", error: "Environment not found." }, 404);
    }
    if (profile.proxyError) {
      recordProfileEvent(store, {
        profileId: id,
        eventType: "proxy.checked",
        status: "failed",
        actor: "user",
        summary: "Saved proxy configuration is invalid.",
        detail: { reason: "invalid_proxy" },
        recoveryKind: "proxy",
      });
      return noStoreJson({ ok: false, code: "invalid_proxy", error: "Saved proxy configuration is invalid." }, 400);
    }
    if (!profile.proxy) {
      return noStoreJson({ ok: false, code: "no_proxy", error: "No proxy is configured for this environment." }, 400);
    }
    if (profile.proxy.type !== "http" && profile.proxy.type !== "socks5") {
      return noStoreJson(
        { ok: false, code: "unsupported_proxy", error: "Unsupported proxy protocol for connectivity check." },
        400,
      );
    }

    try {
      const raw = await (options.proxyCheck ?? runProxyCheck)(profile.proxy);
      const view = proxyCheckView(raw);
      const checkedAt = Date.now();
      const status =
        view.status === "working" ? "ok" : view.status === "unstable" ? "warn" : "failed";
      const location = [view.country, view.region, view.city].filter(Boolean).join(" / ");
      const summary =
        view.status === "working"
          ? `Proxy reachable${view.ip ? ` (${view.ip}${location ? `, ${location}` : ""})` : ""}.`
          : view.status === "unstable"
            ? `Proxy unstable (${view.successes}/${view.attempts} attempts succeeded).`
            : `Proxy check failed${view.reason ? `: ${view.reason}` : ""}.`;

      recordProfileEvent(store, {
        profileId: id,
        eventType: "proxy.checked",
        status,
        actor: "user",
        summary,
        detail: {
          status: view.status,
          attempts: view.attempts,
          successes: view.successes,
          ...(view.reason ? { reason: view.reason } : {}),
          ...(view.ip ? { ip: view.ip } : {}),
          ...(view.country ? { country: view.country } : {}),
          ...(view.exitComparison ? { exitComparison: view.exitComparison } : {}),
        },
        recoveryKind: view.status === "working" ? "" : "proxy",
      });

      options.emitEvent?.("task.updated", {
        kind: "profile-proxy-check",
        profileId: id,
        status: view.status,
      });

      return noStoreJson({ ok: true, checkedAt, ...view });
    } catch (error) {
      recordProfileEvent(store, {
        profileId: id,
        eventType: "proxy.checked",
        status: "failed",
        actor: "user",
        summary: `Proxy check error: ${msg(error)}`,
        recoveryKind: "proxy",
      });
      return noStoreJson({ ok: false, code: "check_failed", error: "Proxy check failed." }, 500);
    }
  }

  return null;
}
