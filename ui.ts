/**
 * Dashboard API — the `/ui/api/*` namespace consumed by the web UI.
 *
 * Kept entirely separate from the AdsPower-compatible API (server.ts /
 * handleRequest) so the `/api/v1|v2/*` compatibility contract is never touched.
 *
 * SECURITY: ordinary profile responses are redacted. They expose metadata (proxy
 * host:port, cookie COUNT, group, etc.) but NEVER secrets — no password, 2FA,
 * cookie values, or proxy credentials. Same rule the `inspect` command follows.
 * Full workspace archives are a separate, explicit capability-protected route;
 * those user-requested backups intentionally contain the complete local data.
 */
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import { handleFeatureSettingsRequest } from "./feature-settings.ts";
import { API_SECURITY_HEADERS } from "./server.ts";
import { handleEventsUiRoutes } from "./src/ui/events-routes.ts";
import { handleGroupsAndExtensionsUiRoutes } from "./src/ui/groups-extensions-routes.ts";
import { handleMetricsAndWindowsRoutes } from "./src/ui/metrics-windows-routes.ts";
import { handleProfilesUiRoutes } from "./src/ui/profiles-routes.ts";
import { handleScriptsUiRoutes } from "./src/ui/scripts-routes.ts";
import {
  listUiProfiles,
  LOW_DISK_SPACE_BYTES,
  noStoreJson,
  readShellLanguage,
  rejectUntrustedJsonMutation,
  writeShellLanguage,
  type UiHealthMetadata,
  type UiProfile,
  type UiRuntimeOptions,
} from "./src/ui/shared.ts";
import { handleSystemUiRoutes } from "./src/ui/system-routes.ts";

export {
  listUiProfiles,
  LOW_DISK_SPACE_BYTES,
  readShellLanguage,
  rejectUntrustedJsonMutation,
  writeShellLanguage,
  type UiHealthMetadata,
  type UiProfile,
  type UiRuntimeOptions,
};

function withUiSecurityHeaders(response: Response): Response {
  try {
    for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) {
      if (!response.headers.has(k)) response.headers.set(k, v);
    }
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/**
 * Handle a `/ui/api/*` request. Returns null for any other path so the caller
 * can fall through to the AdsPower API handler.
 */
export async function handleUiRequest(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/ui/api/")) return null;

  const featureSettings = await handleFeatureSettingsRequest(req, store, {
    paths: options?.paths,
    desktopAvailable: !!options?.health,
    launcher,
    assistant: options?.assistant,
    runtimeInventory: options?.runtimeInventory,
    discoverLocalProxies: options?.discoverLocalProxies,
  });
  if (featureSettings) return withUiSecurityHeaders(featureSettings);

  if (options?.workspaceManagement?.isManagementPath(pathname)) {
    const managed = await options.workspaceManagement.handle(req);
    if (managed) return withUiSecurityHeaders(managed);
  }

  // Reject retired hosted endpoints before checking local script nonces.
  if (
    pathname.startsWith("/ui/api/cloud-") ||
    pathname === "/ui/api/services" ||
    pathname.startsWith("/ui/api/services/") ||
    pathname.startsWith("/ui/api/scripts/library") ||
    /^\/ui\/api\/scripts\/[^/]+\/publication$/.test(pathname)
  ) {
    return withUiSecurityHeaders(noStoreJson({ ok: false, error: "This endpoint was removed from the local edition" }, 410));
  }
  if (/^\/ui\/api\/profiles\/[^/]+\/check-fingerprint$/.test(pathname)) {
    return withUiSecurityHeaders(noStoreJson({ ok: false, error: "The hosted fingerprint check is not available in this local-only build" }, 410));
  }

  const handled =
    handleEventsUiRoutes(req, pathname, options) ??
    (await handleScriptsUiRoutes(req, pathname, options)) ??
    (await handleSystemUiRoutes(req, pathname, launcher, store, options)) ??
    (await handleGroupsAndExtensionsUiRoutes(req, pathname, store, options)) ??
    (await handleMetricsAndWindowsRoutes(req, pathname, launcher, store, options)) ??
    (await handleProfilesUiRoutes(req, pathname, launcher, store, options));

  return withUiSecurityHeaders(
    handled ?? Response.json({ error: `unknown ui route: ${pathname}` }, { status: 404 }),
  );
}
