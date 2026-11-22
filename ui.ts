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
import { createProxyVaultLookup } from "./assistant-proposals.ts";
import { handleFeatureSettingsRequest } from "./feature-settings.ts";
import { API_SECURITY_HEADERS } from "./server.ts";
import { handleAppLockRoutes } from "./src/ui/app-lock-routes.ts";
import { handleAssistantProposalRoutes, type AssistantProposalRouteOptions } from "./src/ui/assistant-proposals-routes.ts";
import { handleDiagnosticsRoutes, type DiagnosticsRouteOptions } from "./src/ui/diagnostics-routes.ts";
import { handleEventsUiRoutes } from "./src/ui/events-routes.ts";
import { handleGroupsAndExtensionsUiRoutes } from "./src/ui/groups-extensions-routes.ts";
import { handleMetricsAndWindowsRoutes } from "./src/ui/metrics-windows-routes.ts";
import { handleProfilePackageRoutes } from "./src/ui/profile-package-routes.ts";
import { handleProfileTimelineRoutes } from "./src/ui/profile-timeline-routes.ts";
import { handleProfilesUiRoutes } from "./src/ui/profiles-routes.ts";
import { handleProxyVaultRoutes, type ProxyVaultRouteOptions } from "./src/ui/proxy-vault-routes.ts";
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
  options: ProxyVaultRouteOptions & DiagnosticsRouteOptions & AssistantProposalRouteOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/ui/api/")) return null;

  const opts = options ?? {};
  const proxyVault = opts.proxyVault ?? createProxyVaultLookup(store);

  const featureSettings = await handleFeatureSettingsRequest(req, store, {
    paths: opts.paths,
    desktopAvailable: !!opts.health,
    launcher,
    assistant: opts.assistant,
    runtimeInventory: opts.runtimeInventory,
    discoverLocalProxies: opts.discoverLocalProxies,
    workspaceManagement: opts.workspaceManagement,
    proxyVault,
    proposalRegistry: opts.proposalRegistry,
  });
  if (featureSettings) return withUiSecurityHeaders(featureSettings);

  if (opts.workspaceManagement?.isManagementPath(pathname)) {
    const managed = await opts.workspaceManagement.handle(req);
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
    handleEventsUiRoutes(req, pathname, opts) ??
    (await handleAppLockRoutes(req, pathname, opts)) ??
    (await handleDiagnosticsRoutes(req, pathname, launcher, store, opts)) ??
    (await handleAssistantProposalRoutes(req, pathname, store, { ...opts, launcher, proxyVault })) ??
    (await handleScriptsUiRoutes(req, pathname, opts)) ??
    (await handleSystemUiRoutes(req, pathname, launcher, store, opts)) ??
    (await handleGroupsAndExtensionsUiRoutes(req, pathname, store, opts)) ??
    (await handleProxyVaultRoutes(req, pathname, store, opts)) ??
    (await handleMetricsAndWindowsRoutes(req, pathname, launcher, store, opts)) ??
    (await handleProfilePackageRoutes(req, pathname, launcher, store, opts)) ??
    (await handleProfileTimelineRoutes(req, pathname, store, opts)) ??
    (await handleProfilesUiRoutes(req, pathname, launcher, store, opts));

  return withUiSecurityHeaders(
    handled ?? Response.json({ error: `unknown ui route: ${pathname}` }, { status: 404 }),
  );
}
