import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { plainDirectory, workspaceEntryExists, writeWorkspaceJson } from "./workspaces.ts";
import type { ChromiumPreloadingMode } from "./chromium-preloading-preferences.ts";

export type UpdateChannel = "stable" | "beta";
export interface UpdateSettings {
  /** A repository selected by the operator, never the retired upstream service. */
  repository: string;
  channel: UpdateChannel;
  checkOnStartup: boolean;
}
export interface SyncSettings {
  enabled: boolean;
  /** A local folder which can be transported by OneDrive, Syncthing, or another client. */
  folder: string;
  retainSnapshots: number;
}
export interface NetworkSettings { checkLocalProxyBeforeLaunch: boolean; chromiumPreloading?: ChromiumPreloadingMode }
export interface SignedUpdateSettings { checkOnStartup: boolean }
export interface AppSettings { version: 1; updates: UpdateSettings; sync: SyncSettings; network?: NetworkSettings; signedUpdates?: SignedUpdateSettings }

export function defaultAppSettings(): AppSettings {
  return {
    version: 1,
    updates: { repository: "", channel: "stable", checkOnStartup: false },
    sync: { enabled: false, folder: "", retainSnapshots: 10 },
    network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default" },
    signedUpdates: { checkOnStartup: false },
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown ${name} setting`);
}
export function normalizeUpdateRepository(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub repository must be owner/repository");
  const repository = value.trim();
  if (!repository) return "";
  if (repository.length > 240 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1]!)) throw new Error("GitHub repository must be owner/repository");
  return repository;
}

/** Strict parsing prevents accidentally writing tokens or passwords as preferences. */
export function parseAppSettings(value: unknown): AppSettings {
  const raw = object(value, "Application settings"); keys(raw, ["version", "updates", "sync", "network", "signedUpdates"], "application");
  if (raw.version !== 1) throw new Error("Unsupported application settings version");
  const updates = object(raw.updates, "Update settings"); keys(updates, ["repository", "channel", "checkOnStartup"], "update");
  if (!["stable", "beta"].includes(updates.channel as string) || typeof updates.checkOnStartup !== "boolean") throw new Error("Invalid update settings");
  const sync = object(raw.sync, "Sync settings"); keys(sync, ["enabled", "folder", "retainSnapshots"], "sync");
  if (typeof sync.enabled !== "boolean" || typeof sync.folder !== "string" || sync.folder.length > 4096 || /[\x00-\x1f\x7f]/.test(sync.folder)
    || !Number.isInteger(sync.retainSnapshots) || (sync.retainSnapshots as number) < 1 || (sync.retainSnapshots as number) > 100) throw new Error("Invalid sync settings");
  const folder = sync.folder.trim();
  // A restored workspace can retain another OS's old location for review.
  // It must be a usable absolute path on this host before sync is re-enabled.
  if (folder && !(sync.enabled ? isAbsolute(folder) : posix.isAbsolute(folder) || win32.isAbsolute(folder))) throw new Error("Sync folder must be an absolute path");
  if (sync.enabled && !folder) throw new Error("Choose a sync folder before enabling sync");
  const network = raw.network === undefined ? { checkLocalProxyBeforeLaunch: false } : object(raw.network, "Network settings");
  keys(network, ["checkLocalProxyBeforeLaunch", "chromiumPreloading"], "network");
  if (typeof network.checkLocalProxyBeforeLaunch !== "boolean" || network.chromiumPreloading !== undefined && !["browser-default", "disabled"].includes(network.chromiumPreloading as string)) throw new Error("Invalid network settings");
  const signedUpdates = raw.signedUpdates === undefined ? { checkOnStartup: false } : object(raw.signedUpdates, "Signed update settings");
  keys(signedUpdates, ["checkOnStartup"], "signed update");
  if (typeof signedUpdates.checkOnStartup !== "boolean") throw new Error("Invalid signed update settings");
  return {
    version: 1,
    updates: { repository: normalizeUpdateRepository(updates.repository), channel: updates.channel as UpdateChannel, checkOnStartup: updates.checkOnStartup },
    sync: { enabled: sync.enabled, folder, retainSnapshots: sync.retainSnapshots as number },
    network: { checkLocalProxyBeforeLaunch: network.checkLocalProxyBeforeLaunch, chromiumPreloading: network.chromiumPreloading as ChromiumPreloadingMode ?? "browser-default" },
    signedUpdates: { checkOnStartup: signedUpdates.checkOnStartup },
  };
}

export class AppSettingsStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  read(): AppSettings {
    if (!workspaceEntryExists(this.path)) return defaultAppSettings();
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Application settings file is invalid or linked");
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.path, "utf8")); }
    catch { throw new Error("Application settings file is invalid"); }
    return parseAppSettings(value);
  }
  write(value: unknown): AppSettings {
    const settings = parseAppSettings(value);
    mkdirSync(dirname(this.path), { recursive: true }); plainDirectory(dirname(this.path));
    writeWorkspaceJson(this.path, settings);
    return settings;
  }
  patch(value: unknown): AppSettings {
    const patch = object(value, "Settings patch"); keys(patch, ["updates", "sync", "network", "signedUpdates"], "application");
    const current = this.read();
    return this.write({
      ...current,
      updates: { ...current.updates, ...(patch.updates === undefined ? {} : object(patch.updates, "Update patch")) },
      sync: { ...current.sync, ...(patch.sync === undefined ? {} : object(patch.sync, "Sync patch")) },
      network: { checkLocalProxyBeforeLaunch: false, ...current.network, ...(patch.network === undefined ? {} : object(patch.network, "Network patch")) },
      signedUpdates: { checkOnStartup: false, ...current.signedUpdates, ...(patch.signedUpdates === undefined ? {} : object(patch.signedUpdates, "Signed update patch")) },
    });
  }
}
