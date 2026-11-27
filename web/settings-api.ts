import type { AppSettings, NetworkSettings, SignedUpdateSettings } from "../src/app-settings.ts";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
import type { IntegrationInfo } from "../agent/integration-info.ts";
import type { IntegrationProbeResult } from "../agent/integration-probe.ts";
import type { SyncFileRecord, SyncPreview } from "../src/encrypted-sync.ts";
import type { UpdateCheckResult } from "../src/app-updates.ts";
import type { BrowserRuntimeInventory, RuntimeInventoryId } from "../src/runtime-inventory.ts";
import type { LocalProxyDiscoveryReport, LocalProxyDiscoveryRequest } from "../src/network-diagnostics.ts";
import { isFingerprintCheckEvidence, isFingerprintCheckMessage, type PresentableFingerprintCheck } from "../src/fingerprint-check-presentation.ts";

export type { AppSettings, BrowserRuntimeInventory, IntegrationInfo, IntegrationProbeResult, SyncFileRecord, SyncPreview };
export interface DataSaverSettingsConfig {
  enabled: boolean;
  blockImages: boolean;
  blockMedia: boolean;
  blockFonts: boolean;
}
export interface BatchLaunchMemoryGuardConfig {
  enabled: boolean;
  softWatermarkPercent: number;
  hardWatermarkPercent: number;
  minAvailableMb: number;
}
export interface ExtendedNetworkSettings extends NetworkSettings {
  firefoxMemorySaver?: boolean;
  dataSaver?: DataSaverSettingsConfig;
  batchLaunchMemoryGuard?: BatchLaunchMemoryGuardConfig;
}
export const DEFAULT_DATA_SAVER_SETTINGS: DataSaverSettingsConfig = {
  enabled: false,
  blockImages: false,
  blockMedia: false,
  blockFonts: false,
};
export const DEFAULT_BATCH_LAUNCH_MEMORY_GUARD: BatchLaunchMemoryGuardConfig = {
  enabled: true,
  softWatermarkPercent: 75,
  hardWatermarkPercent: 88,
  minAvailableMb: 1536,
};
export type ResolvedAppSettings = Omit<AppSettings, "network" | "signedUpdates"> & {
  network: ExtendedNetworkSettings;
  signedUpdates: SignedUpdateSettings;
};
export function resolveResourceNetworkDefaults(network: ExtendedNetworkSettings): {
  firefoxMemorySaver: boolean;
  dataSaver: DataSaverSettingsConfig;
  batchLaunchMemoryGuard: BatchLaunchMemoryGuardConfig;
} {
  return {
    firefoxMemorySaver: network.firefoxMemorySaver === true,
    dataSaver: { ...DEFAULT_DATA_SAVER_SETTINGS, ...network.dataSaver },
    batchLaunchMemoryGuard: { ...DEFAULT_BATCH_LAUNCH_MEMORY_GUARD, ...network.batchLaunchMemoryGuard },
  };
}
export interface FingerprintReport {
  profileId: string; name: string; running?: boolean; status: "issues" | "review" | "unmeasured" | "consistent";
  summary: { pass: number; warn: number; fail: number; unknown: number };
  checks: PresentableFingerprintCheck[];
  measuredAt?: string;
}
export type LocalDiscovery = LocalProxyDiscoveryReport;
export type UpdateResult = UpdateCheckResult;
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string"; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function list(value: unknown, check: (item: any) => boolean): boolean { return Array.isArray(value) && value.every(item => object(item) && check(item)); }
function incomplete(): never { throw new Error("Settings response was incomplete."); }
function read<T>(value: unknown, check: (value: any) => boolean): T { if (!check(value)) return incomplete(); return value as T; }
function dataSaverConfig(value: unknown): boolean {
  return object(value)
    && Object.keys(value).every(key => ["enabled", "blockImages", "blockMedia", "blockFonts"].includes(key))
    && typeof value.enabled === "boolean"
    && typeof value.blockImages === "boolean"
    && typeof value.blockMedia === "boolean"
    && typeof value.blockFonts === "boolean";
}
function memoryGuardConfig(value: unknown): boolean {
  return object(value)
    && Object.keys(value).every(key => ["enabled", "softWatermarkPercent", "hardWatermarkPercent", "minAvailableMb"].includes(key))
    && typeof value.enabled === "boolean"
    && Number.isInteger(value.softWatermarkPercent) && value.softWatermarkPercent >= 30 && value.softWatermarkPercent <= 95
    && Number.isInteger(value.hardWatermarkPercent) && value.hardWatermarkPercent >= 40 && value.hardWatermarkPercent <= 99
    && value.softWatermarkPercent < value.hardWatermarkPercent
    && Number.isInteger(value.minAvailableMb) && value.minAvailableMb >= 128 && value.minAvailableMb <= 65536;
}
function settings(value: unknown): boolean {
  return object(value) && value.version === 1 && object(value.updates) && object(value.sync)
    && text(value.updates.repository) && ["stable", "beta"].includes(value.updates.channel) && typeof value.updates.checkOnStartup === "boolean"
    && typeof value.sync.enabled === "boolean" && text(value.sync.folder) && count(value.sync.retainSnapshots) && value.sync.retainSnapshots >= 1 && value.sync.retainSnapshots <= 100
    && (value.network === undefined || object(value.network)
      && Object.keys(value.network).every(key => ["checkLocalProxyBeforeLaunch", "chromiumPreloading", "chromiumMemorySaver", "firefoxMemorySaver", "openStartPageOnLaunch", "dataSaver", "batchLaunchMemoryGuard"].includes(key))
      && typeof value.network.checkLocalProxyBeforeLaunch === "boolean"
      && (value.network.chromiumPreloading === undefined || ["browser-default", "disabled"].includes(value.network.chromiumPreloading))
      && (value.network.chromiumMemorySaver === undefined || typeof value.network.chromiumMemorySaver === "boolean")
      && (value.network.firefoxMemorySaver === undefined || typeof value.network.firefoxMemorySaver === "boolean")
      && (value.network.openStartPageOnLaunch === undefined || typeof value.network.openStartPageOnLaunch === "boolean")
      && (value.network.dataSaver === undefined || dataSaverConfig(value.network.dataSaver))
      && (value.network.batchLaunchMemoryGuard === undefined || memoryGuardConfig(value.network.batchLaunchMemoryGuard)))
    && (value.signedUpdates === undefined || object(value.signedUpdates) && Object.keys(value.signedUpdates).every(key => key === "checkOnStartup") && typeof value.signedUpdates.checkOnStartup === "boolean");
}
function report(value: unknown): boolean {
  return object(value) && text(value.profileId) && text(value.name) && ["issues", "review", "unmeasured", "consistent"].includes(value.status)
    && (value.running === undefined || typeof value.running === "boolean") && (value.measuredAt === undefined || text(value.measuredAt))
    && object(value.summary) && ["pass", "warn", "fail", "unknown"].every(key => count(value.summary[key]))
    && list(value.checks, item => text(item.id) && text(item.label) && text(item.detail) && ["pass", "warn", "fail", "unknown"].includes(item.status) && (item.recommendation === undefined || text(item.recommendation))
      && (item.detailMessage === undefined || isFingerprintCheckMessage(item.detailMessage)) && (item.evidence === undefined || isFingerprintCheckEvidence(item.evidence)));
}
function githubLink(value: unknown): boolean {
  if (!text(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password; } catch { return false; }
}
function update(value: unknown): boolean {
  return object(value) && ["not-configured", "up-to-date", "available", "error"].includes(value.status) && text(value.currentVersion) && text(value.repository)
    && ["stable", "beta"].includes(value.channel) && count(value.checkedAt) && typeof value.cached === "boolean" && (value.error === undefined || text(value.error))
    && (value.latest === undefined || object(value.latest) && text(value.latest.version) && text(value.latest.tag) && text(value.latest.name) && text(value.latest.notes)
      && (value.latest.publishedAt === null || text(value.latest.publishedAt)) && githubLink(value.latest.url)
      && list(value.latest.assets, item => text(item.name) && count(item.bytes) && githubLink(item.url) && (item.sha256 === null || text(item.sha256) && /^[a-f0-9]{64}$/i.test(item.sha256))));
}
function file(value: unknown): boolean { return object(value) && text(value.fileName) && /^maobu-sync-\d{13}-[a-f0-9]{16}\.mqsync$/.test(value.fileName) && count(value.bytes) && count(value.createdAt) && count(value.modifiedAt); }
function preview(value: unknown): boolean {
  return object(value) && ["profileCount", "sessionCount", "newCount", "conflictCount"].every(key => count(value[key]))
    && value.newCount + value.conflictCount === value.profileCount && value.sessionCount <= value.profileCount
    && list(value.profiles, item => text(item.id) && text(item.name) && text(item.group) && typeof item.conflict === "boolean" && typeof item.hasSession === "boolean")
    && value.profiles.length === value.profileCount;
}
function discovery(value: unknown, requested: LocalProxyDiscoveryRequest): boolean {
  const host = requested.host ?? "127.0.0.1";
  if (!object(value) || !text(value.checkedAt) || value.host !== host || (host !== "127.0.0.1" && host !== "::1")
      || !Array.isArray(value.results) || value.results.length < 1 || value.results.length > 16) return false;
  if (!list(value.results, item => item.host === host && count(item.port) && item.port > 0 && item.port <= 65535
    && ["listening", "closed", "timeout", "unavailable"].includes(item.status) && (item.latencyMs === null || typeof item.latencyMs === "number" && Number.isFinite(item.latencyMs) && item.latencyMs >= 0)
    && ["available", "authentication_required", "rejected", "unknown"].includes(item.socks5)
    && list(item.suggestions, suggestion => ["http", "socks5"].includes(suggestion.type) && ["handshake", "port_hint"].includes(suggestion.evidence)))) return false;
  const ports = new Set(value.results.map(item => item.port));
  return ports.size === value.results.length
    && (requested.ports === undefined || requested.ports.length === ports.size && requested.ports.every(port => ports.has(port)));
}
function integration(value: unknown): boolean {
  return object(value) && text(value.version) && value.transport === "stdio" && ["ready", "helper_missing", "runtime_incomplete", "desktop_required"].includes(value.status)
    && list(value.configs, item => text(item.id) && text(item.label) && text(item.content) && ["json", "toml"].includes(item.format))
    && list(value.checks, item => text(item.id) && text(item.message) && ["pass", "warn", "fail"].includes(item.status))
    && list(value.capabilities, item => text(item.id) && text(item.label) && text(item.description) && Array.isArray(item.engines) && item.engines.every(text))
    && list(value.workflows, item => text(item.id) && text(item.label) && text(item.prompt));
}
function probe(value: unknown): boolean { return object(value) && count(value.checkedAt) && ["connected", "unavailable", "timeout", "failed"].includes(value.status)
  && typeof value.connectionVerified === "boolean" && text(value.message) && count(value.toolCount) && Array.isArray(value.tools) && value.tools.every(text)
  && (value.server === undefined || object(value.server) && value.server.name === "aliasmode" && text(value.server.version)); }
function runtimeInventory(value: unknown, checked: boolean): boolean {
  const chromiumIds = ["aliasmode-chromium", "cloakbrowser"];
  const ids = [...chromiumIds, "aliasmode-firefox"];
  if (!object(value) || value.checked !== checked || !object(value.host)
      || !text(value.host.platform) || !/^[a-z][a-z0-9-]{0,20}$/.test(value.host.platform)
      || !text(value.host.arch) || !/^[a-z0-9-]{1,24}$/.test(value.host.arch)
      || !ids.includes(value.defaultRuntime) || !chromiumIds.includes(value.chromiumDefault)
      || !Array.isArray(value.runtimes) || value.runtimes.length !== ids.length) return false;
  const cacheStates = checked ? ["not-checked", "missing", "present-unverified", "incomplete", "unreadable"] : ["not-checked"];
  return list(value.runtimes, row => ids.includes(row.id) && text(row.pinnedVersion) && /^[0-9][0-9A-Za-z.-]{0,63}$/.test(row.pinnedVersion)
    && typeof row.hostSupported === "boolean" && ["managed", "configured", "bundled", "unconfigured"].includes(row.source)
    && (row.hostSupported && row.source === "managed" ? cacheStates.includes(row.cache) : row.cache === "not-applicable")
    && (row.sizeBytes === undefined || (checked && (row.cache === "present-unverified" || row.cache === "incomplete") && count(row.sizeBytes))))
    && new Set(value.runtimes.map(row => row.id)).size === ids.length;
}
async function request<T>(path: string, method = "GET", value?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/ui/api/settings${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: withStandaloneAuthHeaders({ "X-Maobu-Settings": "1", Accept: "application/json", ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) }),
    ...(method !== "GET" ? { body: JSON.stringify(value ?? {}) } : {}),
    ...(signal ? { signal } : {}),
  });
  const result = await response.json().catch(() => {
    notifyUnauthorizedResponse(response.status, `/ui/api/settings${path}`);
    throw new Error("The local service returned an invalid response");
  });
  if (!object(result)) {
    notifyUnauthorizedResponse(response.status, `/ui/api/settings${path}`);
    throw new Error("The local service returned an invalid response");
  }
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, `/ui/api/settings${path}`, text(result.error) ? result.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, result);
  }
  if (!response.ok || result.ok !== true) throw new Error(text(result.error) ? result.error : "Settings request failed");
  return result as T;
}
function resolvedSettings(value: unknown): ResolvedAppSettings {
  const result = read<AppSettings & { network?: ExtendedNetworkSettings }>(value, settings);
  return { ...result, network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false, ...result.network }, signedUpdates: result.signedUpdates ?? { checkOnStartup: false } };
}
let inFlightSettings: { origin: string; promise: Promise<ResolvedAppSettings> } | null = null;
let recentSettings: { origin: string; at: number; value: ResolvedAppSettings } | null = null;
function settingsOrigin(): string { return typeof window === "undefined" ? "local" : window.location?.origin ?? "local"; }
export function resetSharedSettingsCache(): void { inFlightSettings = null; recentSettings = null; }
export async function fetchSettings(signal?: AbortSignal): Promise<ResolvedAppSettings> {
  const origin = settingsOrigin();
  const pending = request<any>("", "GET", undefined, signal).then(body => {
    const resolved = resolvedSettings(body.settings);
    recentSettings = { origin, at: Date.now(), value: resolved };
    return resolved;
  });
  const entry = { origin, promise: pending };
  inFlightSettings = entry;
  pending.catch(() => {
    if (recentSettings?.origin === origin) recentSettings = null;
  }).finally(() => {
    if (inFlightSettings === entry) inFlightSettings = null;
  });
  return pending;
}
/** Reuse a sibling card's in-flight or just-resolved `GET /ui/api/settings` read without issuing an extra request. */
export async function fetchSettingsShared(signal?: AbortSignal): Promise<ResolvedAppSettings> {
  const origin = settingsOrigin();
  if (inFlightSettings && inFlightSettings.origin === origin) {
    return inFlightSettings.promise;
  }
  if (recentSettings && recentSettings.origin === origin && Date.now() - recentSettings.at < 1500) {
    return recentSettings.value;
  }
  return fetchSettings(signal);
}
export async function patchSettings(value: unknown): Promise<ResolvedAppSettings> {
  const origin = settingsOrigin();
  const resolved = resolvedSettings((await request<any>("", "PATCH", value)).settings);
  recentSettings = { origin, at: Date.now(), value: resolved };
  return resolved;
}
export async function fetchLastUpdate(): Promise<UpdateResult | null> { return read((await request<any>("/updates")).update, value => value === null || update(value)); }
export async function checkForUpdate(): Promise<UpdateResult> { return read((await request<any>("/updates", "POST")).update, update); }
export async function fetchBrowserRuntimeInventory(signal?: AbortSignal): Promise<BrowserRuntimeInventory> {
  const result = await request<{ inventory: unknown }>("/runtimes", "GET", undefined, signal);
  return read(result.inventory, value => runtimeInventory(value, false));
}
export async function inspectBrowserRuntimeCache(signal?: AbortSignal): Promise<BrowserRuntimeInventory> {
  const result = await request<{ inventory: unknown }>("/runtimes/inspect", "POST", {}, signal);
  return read(result.inventory, value => runtimeInventory(value, true));
}
export async function removeBrowserRuntimeCache(id: RuntimeInventoryId, signal?: AbortSignal): Promise<BrowserRuntimeInventory> {
  const result = await request<{ inventory: unknown }>("/runtimes/remove", "POST", { id }, signal);
  return read(result.inventory, value => runtimeInventory(value, true));
}
export async function discoverProxies(input: LocalProxyDiscoveryRequest = {}): Promise<LocalDiscovery> {
  const result = await request<{ discovery: unknown }>("/network/discover", "POST", input);
  return read(result.discovery, value => discovery(value, input));
}
export async function fetchFingerprintReports(): Promise<FingerprintReport[]> { return read((await request<any>("/fingerprints")).reports, value => Array.isArray(value) && value.every(report)); }
export async function measureFingerprint(profileId: string): Promise<FingerprintReport> { return read((await request<any>(`/fingerprints/${encodeURIComponent(profileId)}/measure`, "POST")).report, report); }
export async function fetchIntegrationInfo(): Promise<IntegrationInfo> { return read((await request<any>("/integrations")).integration, integration); }
export async function probeIntegration(): Promise<IntegrationProbeResult> { return read((await request<any>("/integrations/probe", "POST")).probe, probe); }
export async function fetchSyncFiles(): Promise<SyncFileRecord[]> { return read((await request<any>("/sync/files")).files, value => Array.isArray(value) && value.every(file)); }
export async function createSyncFile(password: string): Promise<{ file: SyncFileRecord; profileCount: number }> { return read(await request<any>("/sync/create", "POST", { password }), value => object(value) && file(value.file) && count(value.profileCount)); }
export async function previewSyncFile(fileName: string, password: string): Promise<{ preview: SyncPreview; previewHash: string }> { return read(await request<any>("/sync/preview", "POST", { fileName, password }), value => object(value) && preview(value.preview) && text(value.previewHash) && /^[a-f0-9]{64}$/.test(value.previewHash)); }
export async function importSyncFile(fileName: string, password: string, previewHash: string): Promise<{ imported: number; skipped: number }> { return read(await request<any>("/sync/import", "POST", { fileName, password, previewHash }), value => object(value) && count(value.imported) && count(value.skipped)); }
