import { join } from "node:path";
import type { StatePaths } from "./paths.ts";
import type { ProfileStore } from "./store.ts";
import type { Launcher } from "./launcher.ts";
import { AppSettingsStore } from "./app-settings.ts";
import { AppUpdateService, type UpdateCheckResult } from "./app-updates.ts";
import { discoverLocalProxies, parseLocalProxyDiscoveryRequest } from "./network-diagnostics.ts";
import { buildStoredFingerprintReport } from "./fingerprint-report.ts";
import { FingerprintReviewError, reviewRunningFingerprint } from "./fingerprint-review.ts";
import { getIntegrationInfo } from "../agent/integration-info.ts";
import { probeMcpIntegration } from "../agent/integration-probe.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createSyncSnapshot, listSyncSnapshots, previewSyncSnapshot, readSyncSnapshot, writeSyncSnapshot } from "./encrypted-sync.ts";
import { buildWorkspaceOverview, LocalAssistantError, LocalAssistantService } from "./local-assistant.ts";
import {
  buildAssistantActionCatalog,
  parseAndCompileProposalFromReply,
  resolveProposalWorkspaceId,
  type AssistantProposalRegistry,
  type AssistantProxyVaultLookup,
} from "./assistant-proposals.ts";
import { AssistantModelServices, AssistantServicesError } from "./assistant-model-services.ts";
import { RemoteAssistantError, type RemoteAssistantConnection } from "./remote-assistant.ts";
import { ProfileTemplateStore, PROFILE_TEMPLATES_FILE } from "./profile-templates.ts";
import { handleProfileTemplateRequest } from "./profile-template-routes.ts";
import { getBrowserRuntimeInventory, inspectBrowserRuntimeInventory, isRuntimeInventoryId, removeBrowserRuntimeCache, RuntimeCacheRemovalError, type RuntimeInventoryDeployment } from "./runtime-inventory.ts";
import { runtimeDownloads } from "./runtime-download.ts";

const services = new Map<string, { settings: AppSettingsStore; updates: AppUpdateService; lastUpdate: UpdateCheckResult | null; models: AssistantModelServices }>();
function relevantUpdate(result: UpdateCheckResult | null, preferences: { repository: string; channel: string }): boolean {
  return !!result && result.repository === preferences.repository && result.channel === preferences.channel;
}
const syncBusy = new Set<string>();
const syncPreviewKey = randomBytes(32);
const staleSyncPreview = "Preview this snapshot again before importing";
const syncInProgress = "Another snapshot operation is in progress";
const defaultAssistant = new LocalAssistantService();
const assistantRequests = new Map<string, { controller: AbortController; store: ProfileStore }>();
const assistantRequestId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function service(paths: StatePaths) {
  let value = services.get(paths.root);
  if (!value) {
    value = { settings: new AppSettingsStore(join(paths.root, "app-settings.json")), updates: new AppUpdateService(), lastUpdate: null, models: new AssistantModelServices(paths.root) };
    services.set(paths.root, value);
  }
  return value;
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
/** A custom header prevents a website from issuing simple requests to local tools. */
function guard(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || origin && origin !== url.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ ok: false, error: "Only same-origin local requests are allowed" }, 403);
  }
  if (request.headers.get("X-Maobu-Settings") !== "1") return json({ ok: false, error: "Local settings request header is required" }, 403);
  if (!["GET", "POST", "PATCH"].includes(request.method)) return json({ ok: false, error: "Method not allowed" }, 405);
  if (request.method !== "GET" && !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json({ ok: false, error: "application/json is required" }, 415);
  }
  return null;
}
async function body(request: Request): Promise<any> {
  if (Number(request.headers.get("content-length") ?? 0) > 128 * 1024) throw new Error("Settings request is too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    if (reader) while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128 * 1024) { await reader.cancel(); throw new Error("Settings request is too large"); }
      chunks.push(next.value);
    }
  } finally { reader?.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid JSON settings request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value;
}
export function initializeFeatureSettings(paths?: StatePaths): void {
  if (!paths) return;
  try {
    const entry = service(paths);
    const preferences = entry.settings.read();
    if (preferences.updates.checkOnStartup && preferences.updates.repository) {
      void entry.updates.check(preferences.updates).then(result => { if (relevantUpdate(result, entry.settings.read().updates)) entry.lastUpdate = result; }).catch(() => {});
    }
  } catch { /* A damaged optional preferences file must not prevent opening the workspace. */ }
}
export async function handleFeatureSettingsRequest(request: Request, store: ProfileStore, options: { paths?: StatePaths; desktopAvailable?: boolean; launcher?: Pick<Launcher, "certifiedActive">; assistant?: LocalAssistantService; runtimeInventory?: RuntimeInventoryDeployment; discoverLocalProxies?: typeof discoverLocalProxies; workspaceManagement?: { currentId(): string }; proxyVault?: AssistantProxyVaultLookup; proposalRegistry?: AssistantProposalRegistry } = {}): Promise<Response | null> {
  const { pathname: path, search } = new URL(request.url);
  if (!(path === "/ui/api/settings" || path.startsWith("/ui/api/settings/"))) return null;
  const rejected = guard(request);
  if (rejected) return rejected;
  try {
    if (path === "/ui/api/settings/runtimes" || path === "/ui/api/settings/runtimes/inspect") {
      const inspect = path.endsWith("/inspect");
      if (request.method !== (inspect ? "POST" : "GET")) return json({ ok: false, error: "Method not allowed" }, 405);
      if (search || inspect && Object.keys(await body(request)).length) return json({ ok: false, error: "Browser runtime inventory does not accept options" }, 400);
      const deployment = options.runtimeInventory;
      if (!deployment) return json({ ok: false, error: "Browser runtime inventory is unavailable" }, 503);
      const inventory = inspect ? await inspectBrowserRuntimeInventory(deployment) : getBrowserRuntimeInventory(deployment);
      return json({ ok: true, inventory });
    }
    if (path === "/ui/api/settings/runtimes/remove") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      if (search) return json({ ok: false, error: "Browser runtime inventory does not accept options" }, 400);
      const input = await body(request);
      if (Object.keys(input).some(key => key !== "id") || !isRuntimeInventoryId(input.id)) {
        return json({ ok: false, error: "Invalid browser runtime identifier" }, 400);
      }
      const deployment = options.runtimeInventory;
      if (!deployment) return json({ ok: false, error: "Browser runtime inventory is unavailable" }, 503);
      const launches = store.listLaunches();
      const runningBinaries: string[] = [];
      const runningEngines: ("chromium" | "firefox")[] = [];
      for (const launch of launches) {
        if (launch.binaryPath) runningBinaries.push(launch.binaryPath);
        if (launch.ownerBinaryPath) runningBinaries.push(launch.ownerBinaryPath);
        if (!launch.binaryPath && !launch.ownerBinaryPath && (launch.engine === "chromium" || launch.engine === "firefox")) {
          runningEngines.push(launch.engine);
        }
      }
      const inventory = await removeBrowserRuntimeCache(deployment, input.id, {
        runningBinaries,
        runningEngines,
        activeDownloads: runtimeDownloads(),
      });
      return json({ ok: true, inventory });
    }
    if (path === "/ui/api/settings/assistant/models" && request.method === "POST") {
      const input = await body(request);
      if (Object.keys(input).some(key => key !== "endpoint") || input.endpoint !== undefined && typeof input.endpoint !== "string") throw new LocalAssistantError("invalid-request");
      return json({ ok: true, catalog: await (options.assistant ?? defaultAssistant).listModels({ endpoint: input.endpoint, signal: request.signal }) });
    }
    const assistantServicesPath = "/ui/api/settings/assistant/services";
    if (path === assistantServicesPath || path.startsWith(`${assistantServicesPath}/`)) {
      if (!options.paths) return json({ ok: false, error: "Model services require an active local workspace." }, 503);
      const models = service(options.paths).models;
      const action = path.slice(assistantServicesPath.length);
      if (search) throw new LocalAssistantError("invalid-request");
      if (!action && request.method === "GET") return json({ ok: true, catalog: models.list() });
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      const input = await body(request);
      if (action === "/save") return json({ ok: true, catalog: models.save(input) });
      if (action === "/remove") return json({ ok: true, catalog: models.remove(input) });
      if (action === "/default") return json({ ok: true, catalog: models.setDefault(input) });
      if (action === "/test") {
        const { service: connection, apiKey } = models.connectionDraft(input);
        const assistant = options.assistant ?? defaultAssistant;
        const catalog = connection.provider === "ollama"
          ? await assistant.listModels({ endpoint: connection.endpoint, signal: request.signal })
          : await assistant.listRemoteModels({ provider: connection.provider, endpoint: connection.endpoint, apiKey: apiKey ?? "" }, request.signal);
        return json({ ok: true, catalog: { models: catalog.models, excludedRemoteModels: catalog.excludedRemoteModels } });
      }
      return json({ ok: false, error: "Unknown model service operation" }, 404);
    }
    if (path === "/ui/api/settings/assistant/chat" && request.method === "POST") {
      const input = await body(request);
      const { requestId, serviceId, serviceProvider, serviceEndpoint, ...chatInput } = input;
      if (requestId !== undefined && !assistantRequestId(requestId)) throw new LocalAssistantError("invalid-request");
      const id = requestId?.toLowerCase();
      if (id && assistantRequests.has(id)) throw new LocalAssistantError("busy");
      let connection: RemoteAssistantConnection | undefined;
      if (Object.hasOwn(input, "serviceId") || Object.hasOwn(input, "serviceProvider") || Object.hasOwn(input, "serviceEndpoint")) {
        if (!options.paths || typeof serviceId !== "string" || typeof serviceProvider !== "string" || typeof serviceEndpoint !== "string" || Object.hasOwn(chatInput, "endpoint")) throw new LocalAssistantError("invalid-request");
        const saved = service(options.paths).models.resolve(serviceId);
        if (saved.service.provider !== serviceProvider || saved.service.endpoint !== serviceEndpoint) {
          return json({ ok: false, error: "The model service changed. Select it again before sending.", code: "service-changed", retryable: false }, 409);
        }
        if (saved.service.provider === "ollama") chatInput.endpoint = saved.service.endpoint;
        else connection = { provider: saved.service.provider, endpoint: saved.service.endpoint, apiKey: saved.apiKey ?? "" };
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (request.signal.aborted) cancel(); else request.signal.addEventListener("abort", cancel, { once: true });
      if (id) assistantRequests.set(id, { controller, store });
      try {
        const reply = await (options.assistant ?? defaultAssistant).chat(chatInput, {
          signal: controller.signal,
          connection,
          workspaceOverview: () => buildWorkspaceOverview(store.listProfiles(), store.listLaunches().map(launch => launch.profileId)),
          actionCatalog: () => buildAssistantActionCatalog(store, { proxyVault: options.proxyVault }),
        });
        if (chatInput.proposalMode === true) {
          const compiled = parseAndCompileProposalFromReply(reply.message.content, store, {
            workspaceId: resolveProposalWorkspaceId(store, options),
            registry: options.proposalRegistry,
            proxyVault: options.proxyVault,
          });
          return json({
            ok: true,
            reply,
            proposal: compiled.proposal,
            ...(compiled.proposalParseError ? { proposalParseError: compiled.proposalParseError } : {}),
          });
        }
        return json({ ok: true, reply });
      } finally { request.signal.removeEventListener("abort", cancel); if (id) assistantRequests.delete(id); }
    }
    if (path === "/ui/api/settings/assistant/cancel" && request.method === "POST") {
      const input = await body(request);
      if (Object.keys(input).some(key => key !== "requestId") || !assistantRequestId(input.requestId)) throw new LocalAssistantError("invalid-request");
      const pending = assistantRequests.get(input.requestId.toLowerCase());
      if (!pending || pending.store !== store) return json({ ok: true, cancelled: false });
      pending.controller.abort();
      return json({ ok: true, cancelled: true });
    }
    if (path === "/ui/api/settings/integrations" && request.method === "GET") {
      return json({ ok: true, integration: getIntegrationInfo({ runtimeAvailable: options.desktopAvailable ?? false }) });
    }
    if (path === "/ui/api/settings/integrations/probe" && request.method === "POST") {
      await body(request);
      return json({ ok: true, probe: await probeMcpIntegration({ runtimeAvailable: options.desktopAvailable ?? false }) });
    }
    if (path === "/ui/api/settings/network/discover") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      const input = parseLocalProxyDiscoveryRequest(await body(request));
      return json({ ok: true, discovery: await (options.discoverLocalProxies ?? discoverLocalProxies)(input) });
    }
    if (path === "/ui/api/settings/fingerprints" && request.method === "GET") {
      return json({ ok: true, reports: store.listProfiles().map(profile => {
        const review = buildStoredFingerprintReport(profile, {
          captureSource: store.getFingerprintSource(profile.id), launch: store.getLaunch(profile.id),
        });
        return { ...review.report, running: review.launchRecordPresent };
      }) });
    }
    const measurement = path.match(/^\/ui\/api\/settings\/fingerprints\/([^/]+)\/measure$/);
    if (measurement && request.method === "POST") {
      const input = await body(request);
      if (Object.keys(input).length) throw new Error("Fingerprint measurement does not accept extra options");
      if (!options.launcher) return json({ ok: false, error: "Browser measurement requires a running local service" }, 503);
      return json({ ok: true, report: await reviewRunningFingerprint(decodeURIComponent(measurement[1]!), store, options.launcher) });
    }
    if (!options.paths) return json({ ok: false, error: "A local state directory is required" }, 503);
    if (path === "/ui/api/settings/templates" || path.startsWith("/ui/api/settings/templates/")) {
      const response = handleProfileTemplateRequest(path, request.method, request.method === "POST" ? await body(request) : undefined,
        new ProfileTemplateStore(join(options.paths.root, PROFILE_TEMPLATES_FILE)));
      if (response) return response;
    }
    const entry = service(options.paths);
    if (path === "/ui/api/settings") {
      if (request.method === "GET") return json({ ok: true, settings: entry.settings.read() });
      if (request.method === "PATCH") {
        const settings = entry.settings.patch(await body(request));
        if (!relevantUpdate(entry.lastUpdate, settings.updates)) entry.lastUpdate = null;
        return json({ ok: true, settings });
      }
    }
    if (path === "/ui/api/settings/updates") {
      if (request.method === "GET") return json({ ok: true, update: relevantUpdate(entry.lastUpdate, entry.settings.read().updates) ? entry.lastUpdate : null });
      if (request.method === "POST") {
        await body(request);
        const result = await entry.updates.check(entry.settings.read().updates, { force: true });
        if (relevantUpdate(result, entry.settings.read().updates)) entry.lastUpdate = result;
        return json({ ok: true, update: result });
      }
    }
    if (path.startsWith("/ui/api/settings/sync/")) {
      const settings = entry.settings.read().sync;
      if (!settings.enabled || !settings.folder) return json({ ok: false, error: "Enable a sync folder first" }, 409);
      if (path === "/ui/api/settings/sync/files" && request.method === "GET") return json({ ok: true, files: listSyncSnapshots(settings.folder) });
      if (request.method !== "POST" || !["/ui/api/settings/sync/create", "/ui/api/settings/sync/preview", "/ui/api/settings/sync/import"].includes(path)) return json({ ok: false, error: "Unknown sync operation" }, 404);
      if (syncBusy.has(options.paths.root)) return json({ ok: false, error: syncInProgress }, 409);
      syncBusy.add(options.paths.root);
      try {
        const input = await body(request);
        const allowed = path.endsWith("/create") ? ["password"] : path.endsWith("/preview") ? ["fileName", "password"] : ["fileName", "password", "previewHash"];
        if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.password !== "string"
            || !path.endsWith("/create") && typeof input.fileName !== "string"
            || path.endsWith("/import") && (typeof input.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(input.previewHash))) throw new Error("Invalid sync request");
        if (path.endsWith("/create")) {
          const profiles = store.listProfiles();
          const sessions = new Map(profiles.flatMap(profile => { const saved = store.getSessionBundle(profile.id); return saved ? [[profile.id, saved] as const] : []; }));
          const snapshot = createSyncSnapshot(profiles, sessions);
          return json({ ok: true, file: await writeSyncSnapshot(settings.folder, snapshot, input.password, { retainSnapshots: settings.retainSnapshots }), profileCount: profiles.length });
        }
        const snapshot = await readSyncSnapshot(settings.folder, input.fileName, input.password);
        const currentSettings = entry.settings.read().sync;
        if (!currentSettings.enabled || currentSettings.folder !== settings.folder) return json({ ok: false, error: staleSyncPreview }, 409);
        const snapshotDigest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        const scope = [options.paths.root, settings.folder, input.fileName, snapshotDigest];
        const token = (newIds: readonly string[]) => createHmac("sha256", syncPreviewKey).update(JSON.stringify([scope, newIds])).digest();
        if (path.endsWith("/preview")) {
          const preview = previewSyncSnapshot(snapshot, store.listSyncConflictIds());
          const newIds = preview.profiles.filter(profile => !profile.conflict).map(profile => profile.id);
          return json({ ok: true, preview, previewHash: token(newIds).toString("hex") });
        }
        const reviewedToken = Buffer.from(input.previewHash, "hex");
        const sessions = new Map(Object.entries(snapshot.sessions));
        try {
          const imported = store.importSyncProfiles(snapshot.profiles, sessions, newIds => timingSafeEqual(reviewedToken, token(newIds)));
          if (imported === null) return json({ ok: false, error: staleSyncPreview }, 409);
          return json({ ok: true, imported, skipped: snapshot.profiles.length - imported });
        } catch (error) {
          // Another local connection can own the SQLite write lock. Keep the
          // review available for an explicit retry once that writer finishes.
          if (error && typeof error === "object" && "code" in error && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(String(error.code))) {
            return json({ ok: false, error: "Workspace data is busy. Try importing again in a moment." }, 409);
          }
          throw error;
        }
      } finally { syncBusy.delete(options.paths.root); }
    }
    return json({ ok: false, error: "Unknown settings operation" }, 404);
  } catch (error) {
    if (error instanceof LocalAssistantError || error instanceof RemoteAssistantError) return json({ ok: false, error: error.message, code: error.code, retryable: error.retryable }, error.httpStatus);
    if (error instanceof AssistantServicesError) return json({ ok: false, error: error.message, code: error.code, retryable: false }, error.httpStatus);
    if (error instanceof FingerprintReviewError) return json({ ok: false, error: error.message }, error.status);
    if (error instanceof RuntimeCacheRemovalError) return json({ ok: false, error: error.message }, error.status);
    const filesystemCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const detail = ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "EEXIST"].includes(filesystemCode)
      ? "Local storage operation failed. Check the configured folder and permissions."
      : error instanceof Error ? error.message : "Settings operation failed";
    return json({ ok: false, error: detail }, 400);
  }
}
