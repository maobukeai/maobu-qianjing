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
export interface DataSaverSettings {
  enabled: boolean;
  blockImages: boolean;
  blockMedia: boolean;
  blockFonts: boolean;
}
export interface BatchLaunchMemoryGuardSettings {
  enabled: boolean;
  softWatermarkPercent: number;
  hardWatermarkPercent: number;
  minAvailableMb: number;
}
export interface NetworkSettings {
  checkLocalProxyBeforeLaunch: boolean;
  chromiumPreloading?: ChromiumPreloadingMode;
  chromiumMemorySaver?: boolean;
  firefoxMemorySaver?: boolean;
  openStartPageOnLaunch?: boolean;
  dataSaver?: DataSaverSettings;
  batchLaunchMemoryGuard?: BatchLaunchMemoryGuardSettings;
}

export function resolveOpenStartPageOnLaunch(network?: NetworkSettings): boolean {
  return network?.openStartPageOnLaunch !== false;
}
export interface SignedUpdateSettings { checkOnStartup: boolean }
export interface AppSettings { version: 1; updates: UpdateSettings; sync: SyncSettings; network?: NetworkSettings; signedUpdates?: SignedUpdateSettings }

export const DEFAULT_DATA_SAVER_SETTINGS: Readonly<DataSaverSettings> = Object.freeze({
  enabled: false,
  blockImages: false,
  blockMedia: false,
  blockFonts: false,
});

export const DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS: Readonly<BatchLaunchMemoryGuardSettings> = Object.freeze({
  enabled: true,
  softWatermarkPercent: 75,
  hardWatermarkPercent: 88,
  minAvailableMb: 1536,
});

export function resolveDataSaverSettings(network?: NetworkSettings): DataSaverSettings {
  const ds = network?.dataSaver;
  return {
    enabled: ds?.enabled === true,
    blockImages: ds?.blockImages === true,
    blockMedia: ds?.blockMedia === true,
    blockFonts: ds?.blockFonts === true,
  };
}

export function resolveBatchLaunchMemoryGuardSettings(network?: NetworkSettings): BatchLaunchMemoryGuardSettings {
  const guard = network?.batchLaunchMemoryGuard;
  return {
    enabled: guard ? guard.enabled : DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS.enabled,
    softWatermarkPercent: guard ? guard.softWatermarkPercent : DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS.softWatermarkPercent,
    hardWatermarkPercent: guard ? guard.hardWatermarkPercent : DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS.hardWatermarkPercent,
    minAvailableMb: guard ? guard.minAvailableMb : DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS.minAvailableMb,
  };
}

export function defaultAppSettings(): AppSettings {
  return {
    version: 1,
    updates: { repository: "", channel: "stable", checkOnStartup: false },
    sync: { enabled: false, folder: "", retainSnapshots: 10 },
    network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false },
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

function parseDataSaverSettings(value: unknown): DataSaverSettings {
  const raw = object(value, "Data saver settings");
  if (Object.keys(raw).some((key) => !["enabled", "blockImages", "blockMedia", "blockFonts"].includes(key))) {
    throw new Error("Invalid network settings");
  }
  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.blockImages !== "boolean" ||
    typeof raw.blockMedia !== "boolean" ||
    typeof raw.blockFonts !== "boolean"
  ) {
    throw new Error("Invalid network settings");
  }
  return {
    enabled: raw.enabled,
    blockImages: raw.blockImages,
    blockMedia: raw.blockMedia,
    blockFonts: raw.blockFonts,
  };
}

function parseBatchLaunchMemoryGuardSettings(value: unknown): BatchLaunchMemoryGuardSettings {
  const raw = object(value, "Batch launch memory guard settings");
  if (
    Object.keys(raw).some(
      (key) => !["enabled", "softWatermarkPercent", "hardWatermarkPercent", "minAvailableMb"].includes(key),
    )
  ) {
    throw new Error("Invalid network settings");
  }
  const soft = raw.softWatermarkPercent;
  const hard = raw.hardWatermarkPercent;
  const minAvail = raw.minAvailableMb;
  if (
    typeof raw.enabled !== "boolean" ||
    typeof soft !== "number" || !Number.isInteger(soft) || soft < 30 || soft > 95 ||
    typeof hard !== "number" || !Number.isInteger(hard) || hard < 40 || hard > 99 ||
    soft >= hard ||
    typeof minAvail !== "number" || !Number.isInteger(minAvail) || minAvail < 128 || minAvail > 65536
  ) {
    throw new Error("Invalid network settings");
  }
  return {
    enabled: raw.enabled,
    softWatermarkPercent: soft,
    hardWatermarkPercent: hard,
    minAvailableMb: minAvail,
  };
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
  keys(
    network,
    ["checkLocalProxyBeforeLaunch", "chromiumPreloading", "chromiumMemorySaver", "firefoxMemorySaver", "openStartPageOnLaunch", "dataSaver", "batchLaunchMemoryGuard"],
    "network",
  );
  if (
    typeof network.checkLocalProxyBeforeLaunch !== "boolean"
    || (network.chromiumPreloading !== undefined && !["browser-default", "disabled"].includes(network.chromiumPreloading as string))
    || (network.chromiumMemorySaver !== undefined && typeof network.chromiumMemorySaver !== "boolean")
    || (network.firefoxMemorySaver !== undefined && typeof network.firefoxMemorySaver !== "boolean")
    || (network.openStartPageOnLaunch !== undefined && typeof network.openStartPageOnLaunch !== "boolean")
  ) throw new Error("Invalid network settings");
  const dataSaver = network.dataSaver === undefined ? undefined : parseDataSaverSettings(network.dataSaver);
  const batchLaunchMemoryGuard = network.batchLaunchMemoryGuard === undefined
    ? undefined
    : parseBatchLaunchMemoryGuardSettings(network.batchLaunchMemoryGuard);
  const signedUpdates = raw.signedUpdates === undefined ? { checkOnStartup: false } : object(raw.signedUpdates, "Signed update settings");
  keys(signedUpdates, ["checkOnStartup"], "signed update");
  if (typeof signedUpdates.checkOnStartup !== "boolean") throw new Error("Invalid signed update settings");
  return {
    version: 1,
    updates: { repository: normalizeUpdateRepository(updates.repository), channel: updates.channel as UpdateChannel, checkOnStartup: updates.checkOnStartup },
    sync: { enabled: sync.enabled, folder, retainSnapshots: sync.retainSnapshots as number },
    network: {
      checkLocalProxyBeforeLaunch: network.checkLocalProxyBeforeLaunch,
      chromiumPreloading: network.chromiumPreloading as ChromiumPreloadingMode ?? "browser-default",
      chromiumMemorySaver: network.chromiumMemorySaver === true,
      ...(network.firefoxMemorySaver !== undefined ? { firefoxMemorySaver: network.firefoxMemorySaver } : {}),
      ...(network.openStartPageOnLaunch !== undefined ? { openStartPageOnLaunch: network.openStartPageOnLaunch } : {}),
      ...(dataSaver !== undefined ? { dataSaver } : {}),
      ...(batchLaunchMemoryGuard !== undefined ? { batchLaunchMemoryGuard } : {}),
    },
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
    const patchNetwork = patch.network === undefined ? {} : object(patch.network, "Network patch");
    const mergedNetwork: Record<string, unknown> = {
      checkLocalProxyBeforeLaunch: false,
      ...current.network,
      ...patchNetwork,
    };
    if (patchNetwork.dataSaver !== undefined) {
      mergedNetwork.dataSaver = {
        ...resolveDataSaverSettings(current.network),
        ...object(patchNetwork.dataSaver, "Data saver patch"),
      };
    }
    if (patchNetwork.batchLaunchMemoryGuard !== undefined) {
      mergedNetwork.batchLaunchMemoryGuard = {
        ...resolveBatchLaunchMemoryGuardSettings(current.network),
        ...object(patchNetwork.batchLaunchMemoryGuard, "Batch launch memory guard patch"),
      };
    }
    return this.write({
      ...current,
      updates: { ...current.updates, ...(patch.updates === undefined ? {} : object(patch.updates, "Update patch")) },
      sync: { ...current.sync, ...(patch.sync === undefined ? {} : object(patch.sync, "Sync patch")) },
      network: mergedNetwork,
      signedUpdates: { checkOnStartup: false, ...current.signedUpdates, ...(patch.signedUpdates === undefined ? {} : object(patch.signedUpdates, "Signed update patch")) },
    });
  }
}
