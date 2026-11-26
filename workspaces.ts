import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { renameWithWindowsRetrySync } from "./windows-rename.ts";

export const WORKSPACE_COLORS = ["#8169c8", "#628ac7", "#638f77", "#c4905b", "#b87594", "#7c7d8e"] as const;
export const WORKSPACE_STUDIO_ICONS = ["studio-cat", "studio-prism", "studio-rocket", "studio-globe", "studio-shield", "studio-bolt"] as const;
export const WORKSPACE_STATIC_ICONS = ["laptop", "folder", "briefcase", "globe", "star", "layers", "bag", "store", "shield", "key", "bot", "terminal", "cpu", "video", "mail", "crown"] as const;
export const WORKSPACE_ICONS = [...WORKSPACE_STUDIO_ICONS, ...WORKSPACE_STATIC_ICONS, "monogram"] as const;
export type WorkspaceColor = typeof WORKSPACE_COLORS[number];
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
export interface Workspace {
  id: string; name: string; color: WorkspaceColor; icon: WorkspaceIcon;
  createdAt: number; updatedAt: number; lastOpenedAt: number; archived: boolean;
}
export interface WorkspaceRegistry { version: 1; activeId: string; workspaces: Workspace[] }
export interface WorkspaceInput { name: string; color?: string; icon?: string }
export interface WorkspacePatch { name?: string; color?: string; icon?: string }
export const WORKSPACE_REGISTRY_FILE = "desktop-workspaces.json";
const ID = /^ws_[0-9a-f]{32}$/;
export function isWorkspaceId(id: unknown): id is string { return id === "default" || typeof id === "string" && ID.test(id); }
/** existsSync follows links and hides dangling links; metadata checks must not. */
export function workspaceEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Validate named roots without following a directory junction or a symlink. */
export function plainDirectory(path: string, create = false): void {
  if (!workspaceEntryExists(path)) { if (!create) throw new Error("Workspace directory is missing"); mkdirSync(path, { recursive: true }); }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Linked or non-directory workspace paths are not supported");
}
export function assertNoWorkspaceLinks(path: string): void {
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("Linked or special workspace files are not supported");
    if (stat.isDirectory()) for (const name of readdirSync(current)) stack.push(join(current, name));
  }
}
export function writeWorkspaceJson(path: string, value: unknown): void {
  if (workspaceEntryExists(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error("Linked workspace metadata is not supported");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let failed = false;
  try {
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameWithWindowsRetrySync(temporary, path);
  } catch (error) { failed = true; throw error; }
  finally {
    try { if (workspaceEntryExists(temporary)) unlinkSync(temporary); }
    catch (error) { if (!failed) throw error; }
  }
}
function workspaceName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Workspace name is required");
  const name = value.trim().normalize("NFC");
  if (!name || Array.from(name).length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Workspace name must contain 1–40 characters");
  return name;
}
function appearance(color: unknown, icon: unknown): { color: WorkspaceColor; icon: WorkspaceIcon } {
  if (!(WORKSPACE_COLORS as readonly unknown[]).includes(color) || !isValidWorkspaceIcon(icon)) throw new Error("Invalid workspace color or icon");
  return { color: color as WorkspaceColor, icon };
}
function validateRegistry(value: unknown): WorkspaceRegistry {
  const registry = value as WorkspaceRegistry;
  if (!registry || registry.version !== 1 || !isWorkspaceId(registry.activeId) || !Array.isArray(registry.workspaces) || !registry.workspaces.length || registry.workspaces.length > 1000) throw new Error("Invalid workspace registry");
  const ids = new Set<string>(), names = new Set<string>();
  for (const entry of registry.workspaces) {
    if (!entry || !isWorkspaceId(entry.id) || ids.has(entry.id) || typeof entry.archived !== "boolean") throw new Error("Invalid workspace registry entry");
    const name = workspaceName(entry.name);
    if (name !== entry.name || names.has(name.toLowerCase())) throw new Error("Duplicate or invalid workspace name");
    appearance(entry.color, entry.icon);
    for (const key of ["createdAt", "updatedAt", "lastOpenedAt"] as const) if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) throw new Error("Invalid workspace timestamp");
    ids.add(entry.id); names.add(name.toLowerCase());
  }
  if (!registry.workspaces.some(entry => entry.id === "default" && !entry.archived)
    || !registry.workspaces.some(entry => entry.id === registry.activeId && !entry.archived)) throw new Error("Default or active workspace is missing or archived");
  return registry;
}

/** Default continues using home itself; new workspaces always use fixed ID paths. */
export class WorkspaceCatalog {
  readonly home: string;
  readonly currentRoot: string;
  private readonly registryPath: string;
  constructor(home: string, currentRoot: string) {
    this.home = resolve(home); this.currentRoot = resolve(currentRoot);
    plainDirectory(this.home, true);
    this.registryPath = join(this.home, WORKSPACE_REGISTRY_FILE);
    if (!workspaceEntryExists(this.registryPath)) {
      if (this.currentRoot !== this.home) throw new Error("Missing workspace registry for this data root");
      this.lock(() => {
        if (workspaceEntryExists(this.registryPath)) return;
        const now = Date.now();
        writeWorkspaceJson(this.registryPath, { version: 1, activeId: "default", workspaces: [{ id: "default", name: "个人工作区", color: WORKSPACE_COLORS[0], icon: "laptop", createdAt: now, updatedAt: now, lastOpenedAt: 0, archived: false }] });
      });
    }
    this.read(); this.currentId();
  }
  private read(): WorkspaceRegistry {
    plainDirectory(this.home);
    const stat = lstatSync(this.registryPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid or linked workspace registry");
    try {
      const registry = validateRegistry(JSON.parse(readFileSync(this.registryPath, "utf8")));
      for (const entry of registry.workspaces) this.location(entry.id);
      return registry;
    }
    catch (error) { throw new Error(`Workspace registry could not be read: ${error instanceof Error ? error.message : "invalid data"}`); }
  }
  private location(id: string): string {
    if (!isWorkspaceId(id)) throw new Error("Invalid workspace ID");
    if (id === "default") return this.home;
    const parent = join(this.home, "workspaces");
    if (workspaceEntryExists(parent)) plainDirectory(parent);
    const path = join(parent, id);
    if (workspaceEntryExists(path)) plainDirectory(path);
    return path;
  }
  private lock<T>(work: () => T): T {
    plainDirectory(this.home);
    const path = join(this.home, "desktop-workspaces.lock");
    const token = randomUUID();
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error("Invalid workspace registry lock");
      let owner: { pid?: number };
      try { owner = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Workspace registry is locked"); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error("Workspace registry is locked");
      try { process.kill(owner.pid!, 0); throw new Error("Workspace registry is busy"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Workspace registry is busy");
      }
      unlinkSync(path);
      fd = openSync(path, "wx", 0o600);
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); return work(); }
    finally {
      closeSync(fd);
      if (existsSync(path) && !lstatSync(path).isSymbolicLink()) {
        try { if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path); } catch {}
      }
    }
  }
  list(): Workspace[] { return structuredClone(this.read().workspaces); }
  activeId(): string { return this.read().activeId; }
  currentId(): string {
    const entry = this.read().workspaces.find(item => this.location(item.id) === this.currentRoot);
    if (!entry) throw new Error("Current data root is not a registered workspace");
    plainDirectory(this.currentRoot);
    return entry.id;
  }
  pathFor(id: string): string {
    if (!this.read().workspaces.some(entry => entry.id === id)) throw new Error("Workspace not found");
    return this.location(id);
  }
  create(input: WorkspaceInput): Workspace { return this.createEntry(input); }
  publishRestored(input: WorkspaceInput, stagingRoot: string, reservedId?: string): Workspace {
    const staging = resolve(stagingRoot);
    if (dirname(staging) !== join(this.home, "workspaces") || !basename(staging).startsWith(".restore-")) throw new Error("Invalid workspace restore staging path");
    plainDirectory(staging); assertNoWorkspaceLinks(staging);
    if (reservedId !== undefined && !ID.test(reservedId)) throw new Error("Invalid restored workspace ID");
    return this.createEntry(input, staging, reservedId);
  }
  private createEntry(input: WorkspaceInput, staging?: string, reservedId?: string): Workspace {
    return this.lock(() => {
      const registry = this.read();
      if (registry.workspaces.length >= 1000) throw new Error("Workspace limit reached");
      const name = workspaceName(input.name);
      if (registry.workspaces.some(entry => entry.name.toLowerCase() === name.toLowerCase())) throw new Error("Workspace name already exists");
      const looks = appearance(input.color ?? WORKSPACE_COLORS[0], input.icon ?? "folder");
      const now = Date.now();
      const entry: Workspace = { id: reservedId ?? `ws_${randomUUID().replaceAll("-", "")}`, name, ...looks, createdAt: now, updatedAt: now, lastOpenedAt: 0, archived: false };
      if (registry.workspaces.some(item => item.id === entry.id)) throw new Error("Workspace ID already exists");
      const parent = join(this.home, "workspaces"); plainDirectory(parent, true);
      const target = this.location(entry.id);
      if (existsSync(target)) throw new Error("Workspace destination already exists");
      if (staging) renameWithWindowsRetrySync(staging, target); else mkdirSync(target);
      try { registry.workspaces.push(entry); writeWorkspaceJson(this.registryPath, registry); }
      catch (error) {
        if (staging) renameWithWindowsRetrySync(target, staging);
        else { try { rmdirSync(target); } catch {} }
        throw error;
      }
      return structuredClone(entry);
    });
  }
  update(id: string, patch: WorkspacePatch): Workspace {
    return this.lock(() => {
      const registry = this.read(); const entry = registry.workspaces.find(item => item.id === id);
      if (!entry) throw new Error("Workspace not found");
      if (patch.name !== undefined) {
        const name = workspaceName(patch.name);
        if (registry.workspaces.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Workspace name already exists");
        entry.name = name;
      }
      Object.assign(entry, appearance(patch.color ?? entry.color, patch.icon ?? entry.icon));
      entry.updatedAt = Date.now(); writeWorkspaceJson(this.registryPath, registry); return structuredClone(entry);
    });
  }
  setActive(id: string): Workspace {
    return this.lock(() => {
      const registry = this.read(); const entry = registry.workspaces.find(item => item.id === id);
      if (!entry || entry.archived) throw new Error("Workspace is missing or archived");
      plainDirectory(this.location(id)); registry.activeId = id;
      entry.lastOpenedAt = Date.now(); entry.updatedAt = entry.lastOpenedAt;
      writeWorkspaceJson(this.registryPath, registry); return structuredClone(entry);
    });
  }
  archive(id: string, archived = true): Workspace {
    return this.lock(() => {
      const registry = this.read(); const entry = registry.workspaces.find(item => item.id === id);
      if (!entry) throw new Error("Workspace not found");
      if (archived && (id === "default" || id === registry.activeId || id === this.currentId())) throw new Error("The default or active workspace cannot be archived");
      entry.archived = archived; entry.updatedAt = Date.now();
      writeWorkspaceJson(this.registryPath, registry); return structuredClone(entry);
    });
  }
}
