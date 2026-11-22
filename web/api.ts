/** Typed client for the dashboard's /ui/api/* endpoints. */
import type { ScriptLanguage, ScriptRecord, ScriptSummary, } from "../contracts/local.ts";
import type { ScriptRun } from "../scripts.ts";
import type { PythonRuntimeStatus } from "../python-runtime.ts";
import type { RuntimeDownload } from "../runtime-download.ts";
import type { FolderInfo } from "../folders.ts";
import type { FingerprintImportComparison } from "../fingerprint-import-comparison.ts";
import type { ExtensionGroupReview } from "../extension-group-revision.ts";
import { isSafeProfileId } from "../profile-id.ts";
export type { ExtensionGroupReview } from "../extension-group-revision.ts";
export type { RuntimeDownload } from "../runtime-download.ts";
export interface UiProfile {
    id: string;
    name: string;
    /** Browser family. Legacy profiles without a value are Chromium. */
    engine: "chromium" | "firefox";
    /** "aliasmode" is the opt-in Chromium 155 beta; absent is CloakBrowser. */
    chromiumRuntime?: "aliasmode";
    group: string;
    /** Canonical account platform domain, or "" (none). */
    platform: string;
    /** Free-form custom tags. */
    tags: string[];
    /** Operator memo/notes (<= 500 chars / 2048 bytes). */
    notes?: string;
    /** Saved extension IDs. Missing on older servers; never infer zero from absence. */
    extensions?: string[];
    proxy: string | null;
    proxyError?: string;
    timezone: string;
    cookieCount: number;
    seeded: boolean;
    screen: string;
    mobilePersona?: boolean;
    has2fa: boolean;

    serial?: number | null;
    /** Creation time, ms. 0 or absent when unknown. */
    createdAt?: number;
    /** Most recent launch, ms. 0 or absent when never opened here. */
    lastOpenAt?: number;
    /** Operator-chosen "custom NO."; "" when the serial is used instead. */
    customNo?: string;
    running: boolean;
    /** The open browser runs with an older proxy or fingerprint than the saved one. */
    restartPending?: boolean;
    /** Local mode: cookies added while closed; the next start sets them. */
    pendingCookieCount?: number;
    debugPort?: number;
    startedAt?: number;

    /** Legacy stored verdict for older servers. New badges use fpImportComparison for actual coverage. */
    fpVerdict?: FingerprintVerdict | null;
    /** Legacy capture text; never used as a badge tooltip without validation. */
    fpCapturedAt?: string;
    /** Historical import comparison only. Absent on older servers; null means no comparable imported fields. */
    fpImportComparison?: FingerprintImportComparison | null;
}
export interface FingerprintDifference {
    field: string;
    expected: string;
    observed: string;
}
export interface FingerprintVerdict {
    verdict: "match" | "mismatch";
    differences: FingerprintDifference[];
}
export interface UiRoster {
    profiles: UiProfile[];
    groups: string[];
    folders?: FolderInfo[];
}
export interface DiagnoseReport {
    generatedAt: number;
    analysis: {
        verdicts: string[];
    };
}
export interface HealthResult {
    ok: boolean;
    version: string;
    root: string;
    logDir?: string;
}
export interface AppModeConfig {
    localOnly: true;
    version: 1;
    mode: "local";
    localAnalytics: boolean;
    restartRequired?: boolean;
    /** Set when this host runs every Chromium profile on one runtime, so there is no version to choose. */
    chromiumRuntime?: "aliasmode";
    /** Set when this computer's automatic creation policy chooses Chromium 155. */
    defaultChromiumRuntime?: "aliasmode";

    defaultEngine?: "chromium" | "firefox";
    /** Advertised by servers that expose the authenticated `GET /ui/api/events` SSE stream. */
    eventsStream?: boolean;
    /** Advertised by servers that expose the optional local master password lock routes. */
    appLockAvailable?: boolean;
}
export class UnauthorizedError extends Error {
    readonly status = 401;
    readonly path: string;
    readonly detail: string;
    constructor(detail: string, path: string) {
        const prefix = detail ? `${detail}. ` : "";
        super(`${prefix}Authentication required (401). Open the tokenized dashboard URL (/?token=…) logged by the CLI, or provide the session token for X-Maobu-Session / Authorization: Bearer.`);
        this.name = "UnauthorizedError";
        this.path = path;
        this.detail = detail;
    }
}
export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
    return error instanceof UnauthorizedError || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "UnauthorizedError");
}
/** Extract a standalone session token from raw input or a tokenized `/?token=…` URL. */
export function extractSessionTokenInput(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    try {
        const parsed = new URL(trimmed, "http://127.0.0.1");
        const fromQuery = parsed.searchParams.get("token")?.trim();
        if (fromQuery) return fromQuery;
    } catch {
        // Treat non-URL input as the literal token string.
    }
    const match = trimmed.match(/[?&]token=([^&#\s]+)/i);
    return match?.[1] ? decodeURIComponent(match[1].trim()) : trimmed;
}
let standaloneSessionToken: string | null = null;
const unauthorizedListeners = new Set<(error: UnauthorizedError) => void>();
export function getStandaloneSessionToken(): string | null {
    return standaloneSessionToken;
}
export function setStandaloneSessionToken(token: string | null): string | null {
    const normalized = token === null ? "" : extractSessionTokenInput(token);
    standaloneSessionToken = normalized || null;
    return standaloneSessionToken;
}
export function subscribeUnauthorized(listener: (error: UnauthorizedError) => void): () => void {
    unauthorizedListeners.add(listener);
    return () => { unauthorizedListeners.delete(listener); };
}
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!standaloneSessionToken) {
        return init === undefined ? fetch(path) : fetch(path, init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("X-Maobu-Session") && !headers.has("Authorization")) {
        headers.set("X-Maobu-Session", standaloneSessionToken);
    }
    return fetch(path, {
        ...init,
        credentials: init?.credentials ?? "same-origin",
        headers,
    });
}
export async function fetchAppMode(): Promise<AppModeConfig> {
    const path = "/ui/api/app-mode";
    const response = await apiFetch(path);
    const body = await apiJson(response, path);
    if (body.mode !== "local" || body.localOnly !== true) {
        throw new Error(body.error || "This local edition requires the local-only runtime. Restart the desktop app.");
    }
    return body as AppModeConfig;
}
/** Shell UI language (BCP47 tag), persisted server-side: localStorage is
 *  origin-scoped and the desktop shell serves the UI from a random loopback
 *  port each launch. */
export async function fetchShellLanguage(): Promise<string | null> {
    const path = "/ui/api/shell-language";
    const response = await apiFetch(path);
    const body = await apiJson(response, path);
    return typeof body.language === "string" && body.language.length > 0 ? body.language : null;
}
export async function saveShellLanguage(language: string): Promise<void> {
    const path = "/ui/api/shell-language";
    const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
    });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true)
        throw new Error(body.error || "Could not save language preference");
}
/** Browser runtimes downloading now, with the bytes received so far. */
export async function fetchRuntimeDownloads(): Promise<RuntimeDownload[]> {
    const path = "/ui/api/runtime-downloads";
    const response = await apiFetch(path);
    const body = await apiJson(response, path);
    if (!response.ok || !Array.isArray(body?.downloads) || !body.downloads.every((item: RuntimeDownload | null) =>
        !!item && (item.runtime === "aliasmode" || item.runtime === "cloakbrowser" || item.runtime === "firefox")
        && Number.isSafeInteger(item.receivedBytes) && item.receivedBytes >= 0
        && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0
        && (item.totalBytes === 0 || item.receivedBytes <= item.totalBytes)))
        throw new Error("Browser downloads returned invalid data");
    return body.downloads as RuntimeDownload[];
}

export async function fetchLogs(): Promise<{
    file: string;
    content: string;
}> {
    const path = "/ui/api/logs";
    const response = await apiFetch(path);
    const body = await apiJson(response, path);
    if (body.ok !== true)
        throw new Error(body.error || "logs are unavailable");
    return { file: String(body.file), content: String(body.content ?? "") };
}
export async function fetchHealth(): Promise<HealthResult> {
    const path = "/ui/api/health";
    const response = await apiFetch(path);
    const body = await apiJson(response, path);
    if (body.ok !== true)
        throw new Error(body.error || "猫步·千境 health check failed");
    return { ok: true, version: String(body.version ?? "unknown"), root: String(body.root ?? ""), ...(typeof body.logDir === "string" ? { logDir: body.logDir } : {}) };
}
export interface DiskSpace {
    freeBytes: number | null;
    low: boolean;
}
export async function fetchDiskSpace(): Promise<DiskSpace> {
    const path = "/ui/api/disk-space";
    const body = await apiJson(await apiFetch(path), path);
    return { freeBytes: typeof body.freeBytes === "number" ? body.freeBytes : null, low: body.low === true };
}
/** Never leak an HTML fallback into a raw JSON.parse SyntaxError. A dashboard
 * bundle and its local server can briefly differ after an update/restart. */
async function apiJson(response: Response, path: string): Promise<any> {
    const text = await response.text();
    if (response.status === 401) {
        let detail = "";
        try {
            const parsed = text.trim() ? JSON.parse(text) : null;
            if (parsed && typeof parsed === "object") {
                const candidate = (parsed as { error?: unknown; msg?: unknown }).error ?? (parsed as { msg?: unknown }).msg;
                if (typeof candidate === "string") detail = candidate.trim();
            }
        } catch {
            // Non-JSON 401 responses still carry actionable guidance below.
        }
        if (standaloneSessionToken) {
            standaloneSessionToken = null;
        }
        const err = new UnauthorizedError(detail, path);
        for (const listener of unauthorizedListeners) {
            try { listener(err); } catch { /* Listener errors must not mask UnauthorizedError. */ }
        }
        throw err;
    }
    try {
        return text.trim() ? JSON.parse(text) : {};
    }
    catch {
        const contentType = response.headers.get("content-type") || "unknown content type";
        const guidance = response.status >= 500
            ? "The local server failed before it could return JSON; check aliasmode.log, restart 猫步·千境, then reload this page."
            : "The dashboard and local server may be on different versions; stop 猫步·千境, update it, restart it, then reload this page.";
        throw new Error(`猫步·千境 API ${path} returned non-JSON (${response.status}, ${contentType}). ` +
            guidance);
    }
}
async function post(path: string): Promise<any> {
    const r = await apiFetch(path, { method: "POST" });
    return apiJson(r, path);
}
// This conditional cache belongs to one document/module only, never browser storage.
let profileRosterCache: { origin: string; etag: string | null; roster: UiRoster } | null = null;
let profileRosterRequest = 0, profileRosterCommitted = 0;
function profileRosterOrigin(): string { return typeof window === "undefined" ? "local" : window.location?.origin ?? "local"; }
export async function fetchProfiles(): Promise<UiRoster> {
    const path = "/ui/api/profiles", origin = profileRosterOrigin(), sequence = ++profileRosterRequest;
    const cached = profileRosterCache?.origin === origin ? profileRosterCache : null;
    const newer = () => profileRosterOrigin() === origin && profileRosterCache?.origin === origin && profileRosterCommitted > sequence ? profileRosterCache : null;
    try {
        const r = await apiFetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: {
            Accept: "application/json", ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        } });
        const latest = newer();
        if (latest) { void r.body?.cancel().catch(() => {}); return latest.roster; }
        if (r.status === 304) {
            // Drain the empty 304 response body so Chromium completes loading cleanly instead of emitting net::ERR_ABORTED on GC.
            await r.arrayBuffer().catch(() => {});
            const tag = r.headers.get("ETag");
            if (!cached?.etag || tag !== cached.etag) throw new Error("The local server returned an unchanged roster without a matching in-memory snapshot. Refresh the list.");
            if (profileRosterOrigin() === origin && sequence >= profileRosterCommitted) { profileRosterCache = cached; profileRosterCommitted = sequence; }
            return cached.roster;
        }
        const body = await apiJson(r, path);
        const updated = newer(); if (updated) return updated.roster;
        if (!r.ok || !body || !Array.isArray(body.profiles)) throw new Error(body?.error || "猫步·千境 API returned no profile roster");
        const roster: UiRoster = {
            profiles: body.profiles.map((profile: UiProfile) => {
                const engine = profile.engine === "firefox" ? "firefox" : "chromium";
                if (engine === "firefox") {
                    const { debugPort: _debugPort, ...firefoxProfile } = profile;
                    return { ...firefoxProfile, engine };
                }
                return { ...profile, engine };
            }),
            groups: Array.isArray(body.groups) ? body.groups.filter((name: unknown) => typeof name === "string") : [],
            ...(Array.isArray(body.folders) ? { folders: body.folders } : {}),
        };
        const tag = r.headers.get("ETag"), etag = tag && /^"[\x21\x23-\x7e]{1,200}"$/.test(tag) ? tag : null;
        if (profileRosterOrigin() === origin && sequence >= profileRosterCommitted) { profileRosterCache = { origin, etag, roster }; profileRosterCommitted = sequence; }
        return roster;
    } catch (error) { const latest = newer(); if (latest) return latest.roster; throw error; }
}
/** Runs `run` one call at a time. `load` resolves after a run that started
 *  after the call (callers waiting meanwhile share one follow-up run), so an
 *  action still sees its own result; `poll` skips while a run is in flight. */
export function serialLoader(run: () => Promise<void>): {
    load: () => Promise<void>;
    poll: () => void;
} {
    let active: {
        running: Promise<void>;
        next: Promise<void> | null;
    } | null = null;
    const load = (): Promise<void> => {
        if (active)
            return active.next ??= active.running.then(load, load);
        const running = run().finally(() => { active = null; });
        active = { running, next: null };
        return running;
    };
    return { load, poll: () => { if (!active)
            void load().catch(() => { }); } };
}
export interface ProfileCookieInput {
    name: string;
    value: string;
    domain: string;
    path: string;
}
/**
 * Add one cookie, or pasted cookies (`text`: JSON export or cookies.txt), to profiles. Open
 * browsers get them now; closed profiles get them at their next start.
 */
export async function addProfileCookies(ids: string[], input: ProfileCookieInput | {
    text: string;
}): Promise<{
    ok: boolean;
    count?: number;
    live?: number;
    nextStart?: number;
    error?: string;
    errors?: Array<{
        id: string;
        error: string;
    }>;
}> {
    const path = "/ui/api/profiles/cookies";
    const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, ...input }),
    });
    return apiJson(response, path);
}
/** Local mode: the cookies a closed profile sets at its next start (domain and name only). */
export async function fetchPendingCookies(id: string): Promise<{
    ok: boolean;
    cookies?: Array<{
        domain: string;
        name: string;
    }>;
    error?: string;
}> {
    const path = `/ui/api/profiles/${encodeURIComponent(id)}/pending-cookies`;
    return apiJson(await apiFetch(path), path);
}
export async function clearPendingCookies(id: string): Promise<{
    ok: boolean;
    removed?: number;
    error?: string;
}> {
    const path = `/ui/api/profiles/${encodeURIComponent(id)}/pending-cookies/clear`;
    return apiJson(await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), path);
}
export const openProfile = (id: string, force = false) => post(`/ui/api/profiles/${encodeURIComponent(id)}/open${force ? "?force=1" : ""}`);
export const closeProfile = (id: string) => post(`/ui/api/profiles/${encodeURIComponent(id)}/close`);
/** Close and open again, so saved proxy and fingerprint changes apply. */
export async function restartProfile(id: string): Promise<any> {
    const closed = await closeProfile(id);
    if (closed?.ok === false)
        return closed;
    const opened = await openProfile(id);
    return opened?.ok === false || opened?.warning ? opened : closed;
}
export const raiseProfile = (id: string) => post(`/ui/api/profiles/${encodeURIComponent(id)}/raise`);
/** The hosted fingerprint checker is not part of the local edition. */
export const importInbox = () => post("/ui/api/import");
// ---- Extensions registry ----------------------------------------------------
export interface Extension {
    id: string;
    name: string;
}
export async function fetchExtensions(): Promise<Extension[]> {
    const path = "/ui/api/extensions";
    const r = await apiFetch(path);
    const b = await apiJson(r, path);
    if (!r.ok || b.ok !== true || !Array.isArray(b.extensions) || !b.extensions.every((item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item) && "id" in item && extensionIds([item.id]) && "name" in item && typeof item.name === "string")) {
        throw new Error(typeof b.error === "string" ? b.error : "Extension registry is unavailable.");
    }
    return b.extensions;
}
export async function installWebStoreExtension(source: string): Promise<any> {
    const path = "/ui/api/extensions/web-store";
    const r = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
    });
    return apiJson(r, path);
}
export async function uploadExtensions(files: FileList | File[]): Promise<any> {
    const form = new FormData();
    for (const f of Array.from(files))
        form.append("files", f);
    const path = "/ui/api/extensions/upload";
    const r = await apiFetch(path, { method: "POST", body: form });
    return apiJson(r, path);
}
export async function removeExtension(id: string): Promise<any> {
    const r = await apiFetch("/ui/api/extensions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
    });
    return apiJson(r, "/ui/api/extensions/delete");
}
/** Bulk add/remove one extension across the selected profiles. */
export async function assignExtensionBulk(ids: string[], extensionId: string, op: "add" | "remove"): Promise<any> {
    const r = await apiFetch("/ui/api/profiles/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, extensionId, op }),
    });
    return apiJson(r, "/ui/api/profiles/extensions");
}
export interface GroupExtensionDefaults {
    name: string;
    extensions: string[];
}
export async function fetchGroupExtensionDefaults(): Promise<GroupExtensionDefaults[]> {
    const path = "/ui/api/groups/extensions";
    const response = await apiFetch(path, { credentials: "same-origin", cache: "no-store" });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true || !Array.isArray(body.groups) || !body.groups.every((group: any) => group && typeof group.name === "string" && group.name.trim().length > 0 && group.name.length <= 4096 && !/[\x00-\x1f\x7f]/.test(group.name) && extensionIds(group.extensions))) {
        throw new Error(body.error || "group extension defaults are unavailable");
    }
    return body.groups;
}
function extensionIds(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 10_000 && value.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 1024 && !/[\x00-\x1f\x7f]/.test(id)); }
function extensionReview(value: any, group: string, extensions: string[]): value is ExtensionGroupReview {
    if (!value || typeof value !== "object" || value.version !== 1 || value.group !== group.trim() || typeof value.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedFingerprint)
        || Object.keys(value).some(key => !["version", "group", "extensions", "expectedFingerprint", "count", "defaultAdded", "defaultRemoved", "changes", "unknown"].includes(key))
        || !extensionIds(value.extensions) || JSON.stringify([...new Set(value.extensions)].sort()) !== JSON.stringify([...new Set(extensions.map(id => id.trim()))].sort())
        || !Number.isSafeInteger(value.count) || value.count < 0 || value.unknown !== 0 || !extensionIds(value.defaultAdded) || !extensionIds(value.defaultRemoved)
        || value.defaultAdded.some((id: string) => !value.extensions.includes(id)) || value.defaultRemoved.some((id: string) => value.extensions.includes(id))
        || !Array.isArray(value.changes) || value.changes.length > value.count) return false;
    const ids = new Set<string>();
    return value.changes.every((change: any) => {
        if (!change || !isSafeProfileId(change.id) || ids.has(change.id) || typeof change.name !== "string" || typeof change.running !== "boolean" || !extensionIds(change.added) || !extensionIds(change.removed)
            || Object.keys(change).some(key => !["id", "name", "added", "removed", "running"].includes(key)) || change.added.some((id: string) => !value.extensions.includes(id) || change.removed.includes(id))) return false;
        ids.add(change.id); return true;
    });
}
export async function previewGroupExtensionDefaults(group: string, extensions: string[], signal?: AbortSignal): Promise<ExtensionGroupReview> {
    const path = "/ui/api/groups/extensions/preview";
    const response = await apiFetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group, extensions }) });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : "The extension preview could not be loaded. Your selection is kept. Try reviewing again.");
    if (!extensionReview(body.preview, group, extensions)) throw new Error("The extension preview was incomplete. Review the group again before applying.");
    return body.preview;
}
export async function setGroupExtensionDefaults(group: string, extensions: string[], expectedFingerprint?: string): Promise<any> {
    const path = "/ui/api/groups/extensions";
    const response = await apiFetch(path, {
        method: "POST",
        credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group, extensions, ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }) }),
    });
    const body = await apiJson(response, path);
    if (body.ok === false && typeof body.error === "string") return body;
    if (!response.ok || body.ok !== true || !Number.isSafeInteger(body.updatedCount) || body.updatedCount < 0) throw new Error("The extension change was not confirmed. Reload extension data before trying again.");
    return body;
}
export async function uploadExports(files: FileList | File[], assign?: {
    group?: string;
    platform?: string;
}): Promise<any> {
    const form = new FormData();
    for (const f of Array.from(files))
        form.append("files", f);
    if (assign?.group)
        form.append("group", assign.group);
    if (assign?.platform)
        form.append("platform", assign.platform);
    const path = "/ui/api/import/upload";
    const r = await apiFetch(path, { method: "POST", body: form });
    return apiJson(r, path);
}
export async function moveProfiles(ids: string[], group: string): Promise<any> {
    const r = await apiFetch("/ui/api/profiles/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, group }),
    });
    return apiJson(r, "/ui/api/profiles/move");
}
export async function deleteProfiles(ids: string[]): Promise<any> {
    const r = await apiFetch("/ui/api/profiles/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
    return apiJson(r, "/ui/api/profiles/delete");
}
export interface ProxyCheckInput {
    type?: string;
    host: string;
    port: string;
    user?: string;
    pass?: string;
}
export type ProxyCheckStatus = "working" | "unstable" | "failed" | "unavailable";
export type ProxyCheckReason = "authentication_failed" | "timeout" | "dns_failed" | "unreachable" | "connection_failed" | "intermittent" | "proxy_bypassed" | "same_exit" | "check_unavailable";
export interface ProxyCheckResult {
    status: ProxyCheckStatus;
    attempts: number;
    successes: number;
    reason?: ProxyCheckReason;
    ip?: string;
    country?: string;
    region?: string;
    city?: string;
    rotating?: boolean;
    exitComparison?: "same" | "different" | "unknown";
}
const PROXY_CHECK_STATUSES = new Set<ProxyCheckStatus>(["working", "unstable", "failed", "unavailable"]);
const PROXY_CHECK_REASONS = new Set<ProxyCheckReason>([
    "authentication_failed",
    "timeout",
    "dns_failed",
    "unreachable",
    "connection_failed",
    "intermittent",
    "proxy_bypassed",
    "same_exit",
    "check_unavailable",
]);
function proxyCheckResult(body: any): ProxyCheckResult {
    if (!PROXY_CHECK_STATUSES.has(body?.status)
        || !Number.isInteger(body?.attempts)
        || body.attempts < 1
        || !Number.isInteger(body?.successes)
        || body.successes < 0
        || body.successes > body.attempts
        || (body.reason !== undefined && !PROXY_CHECK_REASONS.has(body.reason))
        || (body.exitComparison !== undefined && !["same", "different", "unknown"].includes(body.exitComparison))
        || ["ip", "country", "region", "city"].some((field) => body[field] !== undefined && typeof body[field] !== "string")
        || (body.rotating !== undefined && typeof body.rotating !== "boolean")) {
        throw new Error("Proxy check returned invalid data");
    }
    return {
        status: body.status,
        attempts: body.attempts,
        successes: body.successes,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.ip ? { ip: body.ip } : {}),
        ...(body.country ? { country: body.country } : {}),
        ...(body.region ? { region: body.region } : {}),
        ...(body.city ? { city: body.city } : {}),
        ...(body.rotating !== undefined ? { rotating: body.rotating } : {}),
        ...(body.exitComparison !== undefined ? { exitComparison: body.exitComparison } : {}),
    };
}
export class ProxyCheckError extends Error {
    constructor(readonly kind: "invalid" | "unavailable") {
        super("Proxy check failed");
        this.name = "ProxyCheckError";
    }
}
export async function checkProxy(proxy: ProxyCheckInput): Promise<ProxyCheckResult> {
    const path = "/ui/api/proxy/check";
    const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy }),
    });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true) {
        throw new ProxyCheckError(response.status === 400 ? "invalid" : "unavailable");
    }
    return proxyCheckResult(body);
}
export interface NewProfileInput {
    name?: string;
    /** Browser family selected for a new Local profile. */
    engine?: "chromium" | "firefox";
    /** Chromium runtime of a new Chromium profile: Chromium 155 or CloakBrowser. */
    chromiumRuntime?: "aliasmode" | "cloakbrowser";
    group?: string;
    platform?: string;
    proxy?: ProxyCheckInput | null;
    screen?: string;
    /** Fingerprint OS override: "windows" | "macos" | "linux". Omitted → host OS. */
    platformOs?: string;
    /** Operator-chosen serial shown in the roster and the browser window title. */
    customNo?: string;
    username?: string;
    password?: string;
    email?: string;
    emailPassword?: string;
    twofa?: string;
}
export async function createProfile(input: NewProfileInput): Promise<any> {
    const r = await apiFetch("/ui/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    return apiJson(r, "/ui/api/profiles");
}
export async function fetchDiagnose(): Promise<DiagnoseReport | null> {
    const path = "/ui/api/diagnose/latest";
    const r = await apiFetch(path);
    return (await apiJson(r, path)).report;
}
// ---- Edit one profile (full detail, incl. secrets — loopback-only) ----------
export interface EditProfile {
    id: string;
    name: string;
    engine: "chromium" | "firefox";
    chromiumRuntime?: "aliasmode";
    /** Hardware the profile is set to report on every computer. Absent values are chosen by the engine. */
    hardware?: {
        gpu?: string;
        cores?: number;
    };
    group: string;
    platform: string;
    proxyType: string;
    /** Full "host:port[:user:pass]". */
    proxy: string;
    proxyError?: string;
    username: string;
    password: string;
    email: string;
    emailPassword: string;
    twofa: string;
    /** "1920*1080". */
    resolution: string;
    /** Fingerprint OS: "windows" | "macos" | "linux", or "" for automatic. */
    platformOs: string;
    /** Ids of extensions assigned to this profile. */
    extensions: string[];
    /** Comma-separated custom tags. */
    tags: string;
    /** Operator memo/notes (<= 500 chars / 2048 bytes). */
    notes?: string;
    /** Operator-chosen "custom NO."; "" falls back to the store serial. Local mode only. */
    customNo?: string;
    /** Stored timezone; blank uses the browser default. */
    timezone: string;
    /** Stored language tag, e.g. "en-GB"; blank when unset. */
    locale?: string;
    /** The user typed the timezone; launches keep it. */
    timezoneManual?: boolean;
    /** Processor count the profile reports, or "" when the engine chooses. */
    cores?: string;
    fingerprintSeed?: string;
    cookieCount: number;
    seeded: boolean;
    mobilePersona: boolean;
    desktopConversion?: {
        platform: "windows" | "macos";
        resolution: string;
        screenChanged: boolean;
    };

}
// ---- 2FA authenticator: current TOTP code (never the secret) ----------------
export interface TotpResult {
    code: string | null;
    secondsRemaining?: number;
    period?: number;
}
export async function fetchTotp(id: string): Promise<TotpResult> {
    const path = `/ui/api/profiles/${encodeURIComponent(id)}/totp`;
    const r = await apiFetch(path);
    const body = await apiJson(r, path);
    if (!body.ok)
        throw new Error(body.error || "2FA failed");
    return { code: body.code, secondsRemaining: body.secondsRemaining, period: body.period };
}
export async function fetchProfileEdit(id: string): Promise<EditProfile> {
    const path = `/ui/api/profiles/${encodeURIComponent(id)}`;
    const r = await apiFetch(path);
    const body = await apiJson(r, path);
    if (!body.ok)
        throw new Error(body.error || "load failed");
    return body.profile;
}
export async function updateProfile(id: string, set: Record<string, unknown>): Promise<any> {
    const r = await apiFetch(`/ui/api/profiles/${encodeURIComponent(id)}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set }),
    });
    const body = await apiJson(r, `/ui/api/profiles/${encodeURIComponent(id)}/update`);
    return { ...body, status: r.status };
}
export async function refreshProfileTimezone(id: string): Promise<{
    timezone: string;
    locale: string;
}> {
    const path = `/ui/api/profiles/${encodeURIComponent(id)}/timezone`;
    const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true || typeof body.timezone !== "string") {
        throw new Error(body.error || "timezone lookup failed");
    }
    return { timezone: body.timezone, locale: typeof body.locale === "string" ? body.locale : "" };
}
export async function convertMobileProfile(id: string): Promise<any> {
    return post(`/ui/api/profiles/${encodeURIComponent(id)}/convert-mobile`);
}
export type ExportFormat = "csv" | "txt" | "xlsx";
export interface ExportProgress {
    completed: number;
    total: number;
}
// ---- Export selected → download a CSV / .txt / Excel workbook ----------------
export async function exportProfiles(ids: string[], format: ExportFormat, onProgress?: (progress: ExportProgress) => void): Promise<void> {
    const path = "/ui/api/profiles/export";
    const r = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, format, stream: true }),
    });
    if (!r.ok) {
        const body = await apiJson(r, path);
        throw new Error(body.error || "export failed");
    }
    let blob: Blob | undefined;
    if (r.headers.get("content-type")?.includes("application/x-ndjson")) {
        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                pending += decoder.decode(value, { stream: true });
                let end: number;
                while ((end = pending.indexOf("\n")) !== -1) {
                    const record = JSON.parse(pending.slice(0, end));
                    pending = pending.slice(end + 1);
                    if (record.type === "error")
                        throw new Error(record.error);
                    if (record.type === "progress")
                        onProgress?.({ completed: record.completed, total: record.total });
                    if (record.type === "file") {
                        blob = new Blob([Uint8Array.from(atob(record.data), (char) => char.charCodeAt(0))], { type: record.mime });
                    }
                }
            }
            if (!blob || pending.trim())
                throw new Error("Export interrupted before the file was complete. Please try again.");
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    else {
        blob = await r.blob();
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maobu-qianjing-export.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
// ---- File-based bulk update (re-upload an edited export) ---------------------
export async function updateFromFile(files: FileList | File[]): Promise<any> {
    const form = new FormData();
    for (const f of Array.from(files))
        form.append("files", f);
    const path = "/ui/api/profiles/update-file";
    const r = await apiFetch(path, { method: "POST", body: form });
    return apiJson(r, path);
}
// ---- Group create / rename / delete -----------------------------------------
export async function createGroup(name: string, parentName?: string | null): Promise<any> {
    const r = await apiFetch("/ui/api/groups/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentName }),
    });
    return apiJson(r, "/ui/api/groups/create");
}
export async function renameGroup(from: string, to: string): Promise<any> {
    const r = await apiFetch("/ui/api/groups/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
    });
    return apiJson(r, "/ui/api/groups/rename");
}
export async function moveGroup(name: string, parentName: string | null): Promise<any> {
    const path = "/ui/api/groups/move";
    const r = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentName }),
    });
    return apiJson(r, path);
}
export async function deleteGroup(name: string): Promise<any> {
    const r = await apiFetch("/ui/api/groups/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    return apiJson(r, "/ui/api/groups/delete");
}
// ---- Local scripts ------------------------------------------------------------
export type { ScriptLanguage, ScriptRecord, ScriptRun, ScriptSummary };
type ScriptInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export function scriptsDesktopAvailable(): boolean {
    return typeof window !== "undefined" &&
        typeof (window as any).__TAURI_INTERNALS__?.invoke === "function";
}
async function scriptRequest(path: string, init: RequestInit = {}): Promise<any> {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke as ScriptInvoke | undefined;
    if (!invoke)
        throw new Error("Scripts require the desktop app.");
    const capability = await invoke("script_capability");
    if (typeof capability !== "string" || !capability)
        throw new Error("Scripts are unavailable in this desktop app.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${capability}`);
    if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
    const response = await apiFetch(path, { ...init, headers });
    const body = await apiJson(response, path);
    if (!response.ok || body.ok !== true)
        throw new Error(body.error || "Scripts request failed");
    return body;
}
export interface ScriptLibraryInfo {
    scripts: ScriptSummary[];
}
export async function fetchScriptLibraryInfo(): Promise<ScriptLibraryInfo> {
    const body = await scriptRequest("/ui/api/scripts");
    if (!Array.isArray(body.scripts)) {
        throw new Error("Scripts returned invalid data");
    }
    return {
        scripts: body.scripts as ScriptSummary[],
    };
}
export async function fetchScripts(): Promise<ScriptSummary[]> {
    return (await fetchScriptLibraryInfo()).scripts;
}
export async function fetchScript(id: string): Promise<ScriptRecord> {
    const body = await scriptRequest(`/ui/api/scripts/${encodeURIComponent(id)}`);
    if (!body.script || typeof body.script !== "object")
        throw new Error("Script returned invalid data");
    return body.script as ScriptRecord;
}
export async function createScript(input: Pick<ScriptRecord, "name" | "description" | "language" | "source">): Promise<ScriptRecord> {
    return (await scriptRequest("/ui/api/scripts", { method: "POST", body: JSON.stringify(input) })).script as ScriptRecord;
}
export async function updateScript(id: string, input: Pick<ScriptRecord, "name" | "description" | "language" | "source" | "revision">): Promise<ScriptRecord> {
    const { name, description, language, source, revision: expectedRevision } = input;
    return (await scriptRequest(`/ui/api/scripts/${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify({ name, description, language, source, expectedRevision }),
    })).script as ScriptRecord;
}
export async function deleteScript(id: string, expectedRevision: number): Promise<void> {
    await scriptRequest(`/ui/api/scripts/${encodeURIComponent(id)}`, {
        method: "DELETE", body: JSON.stringify({ expectedRevision }),
    });
}
export async function fetchScriptRun(): Promise<ScriptRun | null> {
    const body = await scriptRequest("/ui/api/scripts/run");
    return body.run === null ? null : body.run as ScriptRun;
}
export async function startScriptRun(input: {
    scriptId: string;
    profileIds: string[];
    inputs: object;
    useCredentials: boolean;
    concurrency?: number;
}): Promise<ScriptRun> {
    return (await scriptRequest("/ui/api/scripts/run", { method: "POST", body: JSON.stringify(input) })).run as ScriptRun;
}
export async function stopScriptRun(): Promise<ScriptRun> {
    return (await scriptRequest("/ui/api/scripts/stop", { method: "POST", body: "{}" })).run as ScriptRun;
}
function pythonRuntimeStatus(body: any): PythonRuntimeStatus | null {
    if (body.python === null)
        return null;
    if (!body.python || typeof body.python.state !== "string" || !Number.isFinite(body.python.totalBytes)) {
        throw new Error("Python runtime returned invalid data");
    }
    return body.python as PythonRuntimeStatus;
}
/** The downloaded Python runtime of Python scripts; null when this app does not download one. */
export async function fetchPythonRuntime(): Promise<PythonRuntimeStatus | null> {
    return pythonRuntimeStatus(await scriptRequest("/ui/api/scripts/python-runtime"));
}
export async function downloadPythonRuntime(): Promise<PythonRuntimeStatus | null> {
    return pythonRuntimeStatus(await scriptRequest("/ui/api/scripts/python-runtime", { method: "POST", body: "{}" }));
}
export async function fetchScriptLog(runId: string, offset: number): Promise<{
    text: string;
    nextOffset: number;
}> {
    const body = await scriptRequest(`/ui/api/scripts/log?runId=${encodeURIComponent(runId)}&offset=${offset}`);
    if (typeof body.text !== "string" || !Number.isFinite(body.nextOffset))
        throw new Error("Script log returned invalid data");
    return { text: body.text, nextOffset: body.nextOffset };
}
// ---- Real-time SSE event stream (fetch + ReadableStream; never EventSource) -
export type UiStreamEventType =
    | "connected"
    | "roster.changed"
    | "profile.lifecycle"
    | "downloads.updated"
    | "script.run"
    | "task.updated"
    | "metrics.snapshot";
export interface ProfileLifecycleEvent {
    profileId: string;
    running: boolean;
    startedAt?: number;
    debugPort?: number;
}
export interface RosterChangedEvent {
    reasons?: string[];
    profileIds?: string[];
    full?: boolean;
    resync?: boolean;
}
export interface UiStreamEvent {
    id: number | null;
    type: UiStreamEventType | string;
    data: unknown;
}
export interface OpenUiEventStreamOptions {
    lastEventId?: number | null;
    signal: AbortSignal;
    onOpen?: () => void;
    onEvent: (event: UiStreamEvent) => void;
}
export interface SseStreamParser {
    push(chunk: Uint8Array): void;
    finish(): void;
}
/** Incremental SSE frame parser handling UTF-8 chunk boundaries, comments, and CRLF/LF/CR endings. */
export function createSseParser(onEvent: (event: UiStreamEvent) => void): SseStreamParser {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let skipLeadingLf = false;
    let currentId: number | null = null;
    let currentEvent = "";
    let dataLines: string[] = [];

    const dispatch = () => {
        if (dataLines.length === 0) {
            currentEvent = "";
            return;
        }
        const raw = dataLines.join("\n");
        const eventType = currentEvent || "message";
        const eventId = currentId;
        currentEvent = "";
        dataLines = [];
        let parsed: unknown = raw;
        if (raw.length > 0) {
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = raw;
            }
        }
        onEvent({ id: eventId, type: eventType, data: parsed });
    };

    const processLine = (line: string) => {
        if (line === "") {
            dispatch();
            return;
        }
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") {
            currentEvent = value;
        } else if (field === "data") {
            dataLines.push(value);
        } else if (field === "id") {
            if (/^\d+$/.test(value)) {
                const numeric = Number(value);
                if (Number.isSafeInteger(numeric) && numeric >= 0) currentId = numeric;
            }
        }
    };

    const drainText = (text: string) => {
        if (!text) return;
        let input = text;
        if (skipLeadingLf) {
            skipLeadingLf = false;
            if (input.startsWith("\n")) input = input.slice(1);
        }
        buffer += input;
        let lineStart = 0;
        for (let i = 0; i < buffer.length; i++) {
            const ch = buffer.charCodeAt(i);
            if (ch === 10 /* \n */) {
                processLine(buffer.slice(lineStart, i));
                lineStart = i + 1;
            } else if (ch === 13 /* \r */) {
                processLine(buffer.slice(lineStart, i));
                if (i + 1 < buffer.length) {
                    if (buffer.charCodeAt(i + 1) === 10) i += 1;
                } else {
                    skipLeadingLf = true;
                }
                lineStart = i + 1;
            }
        }
        buffer = buffer.slice(lineStart);
    };

    return {
        push(chunk: Uint8Array) {
            drainText(decoder.decode(chunk, { stream: true }));
        },
        finish() {
            drainText(decoder.decode());
            if (buffer.length > 0) {
                processLine(buffer);
                buffer = "";
            }
        },
    };
}
/**
 * Opens an authenticated `GET /ui/api/events` SSE stream via `fetch()` + `ReadableStream`
 * so desktop `X-Maobu-Desktop-Session` and standalone `X-Maobu-Session` headers work
 * without ever placing session tokens in URL query parameters.
 */
export async function openUiEventStream(options: OpenUiEventStreamOptions): Promise<void> {
    const path = "/ui/api/events";
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (options.lastEventId != null && Number.isSafeInteger(options.lastEventId) && options.lastEventId > 0) {
        headers["Last-Event-ID"] = String(options.lastEventId);
    }
    const response = await apiFetch(path, {
        method: "GET",
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: options.signal,
    });
    if (response.status === 401) {
        await apiJson(response, path);
        return;
    }
    if (!response.ok) {
        let message = `Event stream failed (${response.status})`;
        try {
            const body = await apiJson(response, path);
            if (typeof body?.error === "string" && body.error.trim()) message = body.error.trim();
        } catch (error) {
            if (isUnauthorizedError(error)) throw error;
        }
        throw new Error(message);
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!response.body || !contentType.includes("text/event-stream")) {
        try { void response.body?.cancel().catch(() => {}); } catch {}
        throw new Error(`Event stream returned unexpected content type (${contentType || "unknown"})`);
    }
    options.onOpen?.();
    const reader = response.body.getReader();
    const parser = createSseParser(options.onEvent);
    try {
        while (!options.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) parser.push(value);
        }
        if (!options.signal.aborted) parser.finish();
    } finally {
        try { await reader.cancel().catch(() => {}); } catch {}
        try { reader.releaseLock(); } catch {}
    }
}
