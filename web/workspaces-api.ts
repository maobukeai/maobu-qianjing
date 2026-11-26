import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";

export const WORKSPACE_COLORS = ["#8169c8", "#628ac7", "#638f77", "#c4905b", "#b87594", "#7c7d8e"] as const;
export const WORKSPACE_STUDIO_ICONS = ["studio-cat", "studio-prism", "studio-rocket", "studio-globe", "studio-shield", "studio-bolt"] as const;
export const WORKSPACE_STATIC_ICONS = ["laptop", "folder", "briefcase", "globe", "star", "layers", "bag", "store", "shield", "key", "bot", "terminal", "cpu", "video", "mail", "crown"] as const;
export const WORKSPACE_ICONS = [...WORKSPACE_STUDIO_ICONS, ...WORKSPACE_STATIC_ICONS, "monogram"] as const;
export type BuiltinWorkspaceIcon = typeof WORKSPACE_ICONS[number];
export type CustomWorkspaceIcon = `custom:${string}`;
export type WorkspaceIcon = BuiltinWorkspaceIcon | CustomWorkspaceIcon;
export const CUSTOM_WORKSPACE_ICON_PATTERN = /^custom:([0-9a-f]{32}\.(png|jpg|webp|gif))$/;
export function isCustomWorkspaceIcon(value: unknown): value is CustomWorkspaceIcon {
  return typeof value === "string" && CUSTOM_WORKSPACE_ICON_PATTERN.test(value);
}
export function isValidWorkspaceIcon(value: unknown): value is WorkspaceIcon {
  return (WORKSPACE_ICONS as readonly unknown[]).includes(value) || isCustomWorkspaceIcon(value);
}
export interface WorkspaceRecord { id: string; name: string; color: string; icon: WorkspaceIcon; archived: boolean; createdAt: number; updatedAt: number; lastOpenedAt: number; }
export interface WorkspaceCatalog { currentId: string; activeId: string; workspaces: WorkspaceRecord[]; }
export interface WorkspaceOverview { workspaceId: string; root: string; profileCount: number; trashCount: number; runningCount: number; bytes: number | null; freeBytes: number | null; lastBackupAt: number | null; backupBusy: boolean; scriptRunning: boolean; }
export interface WorkspaceBackup { id: string; name: string; createdAt: number; bytes: number; profileCount: number; encrypted?: boolean; }
export interface WorkspaceJob { id: string; kind: "backup" | "restore"; status: "queued" | "running" | "succeeded" | "failed"; phase: string; completed: number; total: number; error?: string; result?: { backupId?: string; workspaceId?: string }; }
export interface WorkspaceBackups { backups: WorkspaceBackup[]; jobs: WorkspaceJob[]; }
export type WorkspaceMetadata = Pick<WorkspaceRecord, "name" | "color" | "icon">;
export type WorkspaceLocation = "data" | "backups" | "logs";
export const WORKSPACE_PREFERENCE_KEYS = ["aliasmode.roster.hiddenColumns", "aliasmode.roster.pageSize", "aliasmode.shell.sidebarCollapsed", "aliasmode.roster.groupDisclosure", "aliasmode.roster.favorites", "aliasmode.roster.savedViews", "aliasmode.roster.density", "aliasmode.onboarding.state"] as const;
type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const WORKSPACE_API_MESSAGES = [
  "The local service could not be reached.", "Workspace response was not valid JSON.",
  "Workspace request failed.", "Workspace response was incomplete.",
  "Open this action in the desktop app.",
  "Backup files must be 20 GB or smaller.",
  "Unsupported workspace preference.",
  "Backup password must contain at least 10 characters and at most 1024 UTF-8 bytes.",
  "Enter the password for this encrypted backup.",
  "The backup password is incorrect or the encrypted backup is damaged.",
  "Backup model services are invalid or unsupported.",
  "Icon files must be 2 MB or smaller.",
  "Only PNG, JPG, WebP, and GIF images are supported.",
] as const;

let capability: string | undefined;
let capabilityRequest: Promise<string> | undefined;
let preferenceWrites: Promise<void> = Promise.resolve();
export async function flushWorkspacePreferences(): Promise<void> { await preferenceWrites; }
export function clearWorkspaceCapability(): void { capability = undefined; capabilityRequest = undefined; }
async function workspaceCapability(): Promise<string> {
  if (capability) return capability;
  if (!capabilityRequest) capabilityRequest = (async () => {
    let response: Response;
    try { response = await fetch("/ui/api/workspace/capability", { credentials: "same-origin", cache: "no-store", headers: withStandaloneAuthHeaders({ Accept: "application/json" }) }); }
    catch { throw new Error("The local service could not be reached."); }
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      notifyUnauthorizedResponse(401, "/ui/api/workspace/capability", typeof body?.error === "string" ? body.error : "");
    } else if (response.status === 423) {
      notifyAppLockedFromResponse(423, body);
    }
    if (!response.ok || !body?.ok || typeof body.token !== "string" || !body.token) throw new Error("Workspace request failed.");
    capability = body.token;
    return body.token as string;
  })().finally(() => { capabilityRequest = undefined; });
  return capabilityRequest;
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function incomplete(): never { throw new Error("Workspace response was incomplete."); }
function record(value: unknown): WorkspaceRecord {
  if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || typeof value.color !== "string" || !finite(value.createdAt) || !finite(value.updatedAt) || !finite(value.lastOpenedAt)) return incomplete();
  return { id: value.id, name: value.name, color: WORKSPACE_COLORS.includes(value.color as any) ? value.color : WORKSPACE_COLORS[0], icon: isValidWorkspaceIcon(value.icon) ? value.icon : "laptop", archived: value.archived === true, createdAt: value.createdAt, updatedAt: value.updatedAt, lastOpenedAt: value.lastOpenedAt };
}
function job(value: unknown): WorkspaceJob {
  if (!object(value) || typeof value.id !== "string" || !["backup", "restore"].includes(value.kind) || !["queued", "running", "succeeded", "failed"].includes(value.status) || typeof value.phase !== "string" || !finite(value.completed) || !finite(value.total)) return incomplete();
  return { id: value.id, kind: value.kind, status: value.status, phase: value.phase, completed: value.completed, total: value.total, ...(typeof value.error === "string" ? { error: value.error } : {}), ...(object(value.result) ? { result: { ...(typeof value.result.backupId === "string" ? { backupId: value.result.backupId } : {}), ...(typeof value.result.workspaceId === "string" ? { workspaceId: value.result.workspaceId } : {}) } } : {}) };
}
async function request(path: string, init: RequestInit = {}, retry = true): Promise<Record<string, any>> {
  const token = await workspaceCapability();
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let response: Response;
  try { response = await fetch(`/ui/api${path}`, { credentials: "same-origin", cache: "no-store", ...init, headers: withStandaloneAuthHeaders({ Accept: "application/json", ...init.headers, "X-Maobu-Workspace-Capability": token }) }); }
  catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new Error("The local service could not be reached."); }
  if (response.status === 401 && retry) { clearWorkspaceCapability(); return request(path, init, false); }
  let body: unknown;
  try { body = await response.json(); } catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new Error("Workspace response was not valid JSON."); }
  if (!object(body)) return incomplete();
  if (response.status === 423) notifyAppLockedFromResponse(423, body);
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : "Workspace request failed.");
  return body;
}
function json(method: string, value: unknown): RequestInit { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }
export async function fetchWorkspaces(signal?: AbortSignal): Promise<WorkspaceCatalog> {
  const body = await request("/workspaces", { signal });
  if (typeof body.currentId !== "string" || typeof body.activeId !== "string" || !Array.isArray(body.workspaces)) return incomplete();
  return { currentId: body.currentId, activeId: body.activeId, workspaces: body.workspaces.map(record) };
}
export async function createWorkspace(metadata: WorkspaceMetadata): Promise<WorkspaceRecord> { return record((await request("/workspaces", json("POST", metadata))).workspace); }
export async function updateWorkspace(id: string, metadata: Partial<WorkspaceMetadata>): Promise<WorkspaceRecord> {
  const saved = record((await request(`/workspaces/${encodeURIComponent(id)}`, json("PATCH", metadata))).workspace);
  if (saved.id !== id) return incomplete();
  return saved;
}
export async function archiveWorkspace(id: string, archived: boolean): Promise<WorkspaceRecord> {
  const { workspace } = await request(`/workspaces/${encodeURIComponent(id)}/archive`, json("POST", { archived }));
  if (!object(workspace) || workspace.archived !== archived) return incomplete();
  const saved = record(workspace);
  if (saved.id !== id) return incomplete();
  return saved;
}
export async function activateWorkspace(id: string, closeRunning: boolean): Promise<void> {
  await flushWorkspacePreferences();
  const body = await request(`/workspaces/${encodeURIComponent(id)}/activate`, json("POST", { closeRunning }));
  if (body.restartRequired !== true) return incomplete();
}
export async function cancelActivation(): Promise<void> { await request("/workspaces/activation/cancel", json("POST", {})); }
export async function fetchWorkspacePreferences(): Promise<Record<string, string>> {
  const body = await request("/workspace/preferences");
  if (!object(body.preferences)) return incomplete();
  return Object.fromEntries(Object.entries(body.preferences).filter(([key, value]) => WORKSPACE_PREFERENCE_KEYS.includes(key as any) && typeof value === "string")) as Record<string, string>;
}
export async function saveWorkspacePreference(key: string, value: string): Promise<void> {
  if (!WORKSPACE_PREFERENCE_KEYS.includes(key as any)) throw new Error("Unsupported workspace preference.");
  const write = preferenceWrites.then(async () => { await request("/workspace/preferences", json("POST", { key, value })); });
  preferenceWrites = write.catch(() => {});
  await write;
}
export async function fetchWorkspaceOverview(signal?: AbortSignal): Promise<WorkspaceOverview> {
  const b = await request("/workspace/overview", { signal });
  if (typeof b.workspaceId !== "string" || typeof b.root !== "string" || !finite(b.profileCount) || !finite(b.trashCount) || !finite(b.runningCount)) return incomplete();
  return { workspaceId: b.workspaceId, root: b.root, profileCount: b.profileCount, trashCount: b.trashCount, runningCount: b.runningCount, bytes: finite(b.bytes) ? b.bytes : null, freeBytes: finite(b.freeBytes) ? b.freeBytes : null, lastBackupAt: finite(b.lastBackupAt) && b.lastBackupAt > 0 ? b.lastBackupAt : null, backupBusy: b.backupBusy === true, scriptRunning: b.scriptRunning === true };
}
export async function fetchWorkspaceBackups(signal?: AbortSignal): Promise<WorkspaceBackups> {
  const b = await request("/workspace/backups", { signal });
  if (!Array.isArray(b.backups) || !Array.isArray(b.jobs)) return incomplete();
  const backups = b.backups.map((v: unknown) => { if (!object(v) || typeof v.id !== "string" || typeof v.name !== "string" || !finite(v.createdAt) || !finite(v.bytes) || !finite(v.profileCount) || v.encrypted !== undefined && typeof v.encrypted !== "boolean") return incomplete(); return { id: v.id, name: v.name, createdAt: v.createdAt, bytes: v.bytes, profileCount: v.profileCount, ...(v.encrypted === undefined ? {} : { encrypted: v.encrypted }) }; });
  return { backups, jobs: b.jobs.map(job) };
}
export async function startWorkspaceBackup(password?: string): Promise<WorkspaceJob> { await flushWorkspacePreferences(); return job((await request("/workspace/backups", json("POST", { password }))).job); }
export async function restoreWorkspace(source: File | { backupId: string }, password?: string): Promise<WorkspaceJob> {
  if (typeof File !== "undefined" && source instanceof File) {
    if (source.size > 20 * 1024 ** 3) throw new Error("Backup files must be 20 GB or smaller.");
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (password !== undefined) headers["X-Maobu-Backup-Password"] = encodeURIComponent(password);
    return job((await request("/workspace/restore", { method: "POST", headers, body: source })).job);
  }
  return job((await request("/workspace/restore", json("POST", { ...source, password }))).job);
}
export async function fetchWorkspaceJob(id: string, signal?: AbortSignal): Promise<WorkspaceJob> {
  const deadline = AbortSignal.timeout(10_000);
  const next = job((await request(`/workspace/jobs/${encodeURIComponent(id)}`, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })).job);
  if (next.id !== id) return incomplete();
  return next;
}
export function workspaceBackupDownloadUrl(id: string, token: string): string { return `/ui/api/workspace/backups/${encodeURIComponent(id)}/download?capability=${encodeURIComponent(token)}`; }
const MAX_CUSTOM_ICON_BYTES = 2 * 1024 * 1024;
const customIconUrlCache = new Map<string, Promise<string>>();

export async function uploadWorkspaceIcon(file: File): Promise<CustomWorkspaceIcon> {
  if (file.size > MAX_CUSTOM_ICON_BYTES) throw new Error("Icon files must be 2 MB or smaller.");
  const body = await request("/workspace/icons", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!isCustomWorkspaceIcon(body.icon)) return incomplete();
  return body.icon;
}

export function fetchWorkspaceIconBlobUrl(icon: CustomWorkspaceIcon): Promise<string> {
  const match = CUSTOM_WORKSPACE_ICON_PATTERN.exec(icon);
  if (!match) return Promise.reject(new Error("Workspace request failed."));
  const filename = match[1]!;
  const existing = customIconUrlCache.get(filename);
  if (existing) return existing;
  const loader = (async () => {
    const fetchWithCap = async (retry: boolean): Promise<Response> => {
      const token = await workspaceCapability();
      const res = await fetch(`/ui/api/workspace/icons/${encodeURIComponent(filename)}`, {
        credentials: "same-origin",
        headers: withStandaloneAuthHeaders({ "X-Maobu-Workspace-Capability": token }),
      });
      if (res.status === 401 && retry) {
        clearWorkspaceCapability();
        return fetchWithCap(false);
      }
      return res;
    };
    const response = await fetchWithCap(true);
    if (!response.ok) throw new Error("Workspace request failed.");
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  })().catch((error) => {
    customIconUrlCache.delete(filename);
    throw error;
  });
  customIconUrlCache.set(filename, loader);
  return loader;
}
function desktopInvoke(): DesktopInvoke | undefined { return typeof window === "undefined" ? undefined : (window as any).__TAURI_INTERNALS__?.invoke; }
export function workspaceDesktopAvailable(): boolean { return typeof desktopInvoke() === "function"; }
export async function openWorkspaceLocation(kind: WorkspaceLocation): Promise<void> { const invoke = desktopInvoke(); if (!invoke) throw new Error("Open this action in the desktop app."); await invoke("open_workspace_location", { kind }); }
export async function restartWorkspace(expectedWorkspaceId: string, targetWorkspaceId: string): Promise<void> { const invoke = desktopInvoke(); if (!invoke) throw new Error("Open this action in the desktop app."); await invoke("restart_workspace", { expectedWorkspaceId, targetWorkspaceId }); }
export async function downloadWorkspaceBackup(backupId: string): Promise<"saved" | "cancelled" | "requested"> {
  const invoke = desktopInvoke();
  if (invoke) {
    const result = await invoke("export_workspace_backup", { backupId });
    if (result === null || (object(result) && (result.saved === false || result.cancelled === true || result.canceled === true))) return "cancelled";
    return object(result) && (result.saved === true || typeof result.path === "string") ? "saved" : "requested";
  }
  const anchor = document.createElement("a");
  anchor.href = workspaceBackupDownloadUrl(backupId, await workspaceCapability());
  anchor.download = ""; anchor.rel = "noreferrer"; anchor.referrerPolicy = "no-referrer";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  return "requested";
}
export function workspaceJobPercent(value: WorkspaceJob): number | null { return value.total > 0 ? Math.min(100, Math.max(0, Math.floor(value.completed / value.total * 100))) : null; }
export function workspaceJobActive(value: WorkspaceJob): boolean { return value.status === "queued" || value.status === "running"; }
/** Persisted jobs arrive oldest first. A running job takes priority over terminal history. */
export function workspaceHistoryJob(jobs: readonly WorkspaceJob[], existing: WorkspaceJob | null = null): WorkspaceJob | null {
  // An older in-flight history request must not replace a job just started here.
  if (existing && workspaceJobActive(existing) && !jobs.some(item => item.id === existing.id)) return existing;
  return jobs.findLast(workspaceJobActive) ?? jobs.at(-1) ?? existing;
}
