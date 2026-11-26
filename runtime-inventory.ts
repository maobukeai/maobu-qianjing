import { realpathSync } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ALIASMODE_CHROMIUM_PINNED_VERSION, managedChromiumLocation } from "./aliasmode-chromium.ts";
import { cloakBrowserVersionForPlatform } from "./browser-install.ts";
import { defaultProfileEngine } from "./create.ts";
import { FIREFOX_RUNTIME_BUILDS, FIREFOX_RUNTIME_VERSION, firefoxInstallDirectoryPrefix, type FirefoxRuntimeBuild } from "./firefox-install.ts";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory } from "./firefox-managed.ts";
import { runtimeDownloads, type RuntimeDownload } from "./runtime-download.ts";

export type ChromiumInventoryId = "aliasmode-chromium" | "cloakbrowser";
export type RuntimeInventoryId = ChromiumInventoryId | "aliasmode-firefox";
export type RuntimeInventorySource = "managed" | "configured" | "bundled" | "unconfigured";
export type RuntimeCacheState = "not-checked" | "not-applicable" | "missing" | "present-unverified" | "incomplete" | "unreadable";

/** Launcher inputs resolved at construction, before a managed Firefox launch supplies its path. */
export interface RuntimeInventoryDeployment {
  readonly runtimeRoot: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly chromiumDefault: ChromiumInventoryId;
  readonly cloakSource: "managed" | "configured" | "bundled";
  readonly firefoxSource: "managed" | "configured" | "unconfigured";
}

export interface RuntimeInventoryRow {
  id: RuntimeInventoryId;
  pinnedVersion: string;
  hostSupported: boolean;
  source: RuntimeInventorySource;
  cache: RuntimeCacheState;
  sizeBytes?: number;
}

const RUNTIME_INVENTORY_IDS = new Set<string>(["aliasmode-chromium", "cloakbrowser", "aliasmode-firefox"]);

export function isRuntimeInventoryId(value: unknown): value is RuntimeInventoryId {
  return typeof value === "string" && RUNTIME_INVENTORY_IDS.has(value);
}

export interface BrowserRuntimeInventory {
  host: { platform: NodeJS.Platform; arch: string };
  defaultRuntime: RuntimeInventoryId;
  chromiumDefault: ChromiumInventoryId;
  checked: boolean;
  runtimes: RuntimeInventoryRow[];
}

type Candidate = { directory: string; executable: string; firefox?: FirefoxRuntimeBuild };

function catalog(deployment: RuntimeInventoryDeployment): { inventory: BrowserRuntimeInventory; candidates: Map<RuntimeInventoryId, Candidate> } {
  const { platform, arch, chromiumDefault } = deployment;
  const candidates = new Map<RuntimeInventoryId, Candidate>();
  const firefox = FIREFOX_RUNTIME_BUILDS.find(build => build.platform === platform && build.arch === arch);
  function row(id: RuntimeInventoryId, pinnedVersion: string, source: RuntimeInventorySource, candidate?: Candidate): RuntimeInventoryRow {
    if (candidate && source === "managed") candidates.set(id, candidate);
    return { id, pinnedVersion, hostSupported: !!candidate, source, cache: candidates.has(id) ? "not-checked" : "not-applicable" };
  }
  const runtimes = [
    row("aliasmode-chromium", ALIASMODE_CHROMIUM_PINNED_VERSION, "managed", managedChromiumLocation("aliasmode", platform, arch)),
    row("cloakbrowser", cloakBrowserVersionForPlatform(platform), deployment.cloakSource, managedChromiumLocation("cloakbrowser", platform, arch)),
    row("aliasmode-firefox", FIREFOX_RUNTIME_VERSION, deployment.firefoxSource, firefox && {
      directory: firefoxManagedDirectory(platform, arch), executable: firefox.executablePath, firefox,
    }),
  ];
  const defaultRuntime = defaultProfileEngine(platform) === "firefox" ? "aliasmode-firefox" : chromiumDefault;
  return { inventory: { host: { platform, arch }, defaultRuntime, chromiumDefault, checked: false, runtimes }, candidates };
}

/** Catalog reads only the application's pinned build metadata and launch policy. */
export function getBrowserRuntimeInventory(deployment: RuntimeInventoryDeployment): BrowserRuntimeInventory {
  return catalog(deployment).inventory;
}

async function pathInfo(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error("Browser cache path is a link");
  return info;
}

async function walkDirectories(base: string, segments: readonly string[]): Promise<string | null> {
  let path = base;
  for (const segment of segments) {
    path = join(path, segment);
    const info = await pathInfo(path);
    if (!info) return null;
    if (!info.isDirectory()) throw new Error("Browser cache path is not a directory");
  }
  return path;
}

const MAX_FIREFOX_RECORD_BYTES = 4096;

/** Only accept the relative layout produced by installFirefox. The recorded hash describes the intended build. */
async function readFirefoxRecord(directory: string, build: FirefoxRuntimeBuild): Promise<string[] | null> {
  const path = join(directory, FIREFOX_MANAGED_RECORD);
  const info = await pathInfo(path);
  if (!info?.isFile() || info.size < 1 || info.size > MAX_FIREFOX_RECORD_BYTES) return null;
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) return null;
    const buffer = Buffer.alloc(MAX_FIREFOX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) return null;
    let record: { path?: unknown; sha256?: unknown } | null;
    try { record = JSON.parse(buffer.toString("utf8", 0, bytesRead)); } catch { return null; }
    if (!record || typeof record !== "object" || Object.keys(record).length !== 2
        || record.sha256 !== build.executableSha256 || typeof record.path !== "string") return null;
    const parts = record.path.split(/[\\/]/);
    const prefix = firefoxInstallDirectoryPrefix(build.platform, build.arch);
    const installed = parts[1];
    if (parts[0] !== "browser" || !installed?.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(installed.slice(prefix.length))) return null;
    return parts.slice(2).join("/") === build.executablePath ? parts : null;
  } finally {
    await handle.close();
  }
}

const MAX_SIZE_DEPTH = 16;
const MAX_SIZE_ENTRIES = 50_000;

async function computeDirectorySize(directory: string): Promise<number | undefined> {
  let total = 0;
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SIZE_DEPTH || seen >= MAX_SIZE_ENTRIES) return;
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (++seen > MAX_SIZE_ENTRIES) return;
      const full = join(dir, entry);
      const info = await pathInfo(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(full, depth + 1);
      else if (info.isFile()) total += info.size;
    }
  };
  try {
    await walk(directory, 0);
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

async function inspectCandidate(root: string, candidate: Candidate): Promise<{ cache: RuntimeCacheState; sizeBytes?: number }> {
  try {
    const directory = await walkDirectories(root, [candidate.directory]);
    if (!directory) return { cache: "missing" };
    const parts = candidate.firefox ? await readFirefoxRecord(directory, candidate.firefox) : candidate.executable.split("/");
    if (!parts) {
      const sizeBytes = await computeDirectorySize(directory);
      return sizeBytes !== undefined ? { cache: "incomplete", sizeBytes } : { cache: "incomplete" };
    }
    const parent = await walkDirectories(directory, parts.slice(0, -1));
    const executable = parent && await pathInfo(join(parent, parts.at(-1)!));
    const cache: RuntimeCacheState = executable && executable.isFile() && executable.size > 0 ? "present-unverified" : "incomplete";
    const sizeBytes = await computeDirectorySize(directory);
    return sizeBytes !== undefined ? { cache, sizeBytes } : { cache };
  } catch {
    return { cache: "unreadable" };
  }
}

/** Inspect fixed cache entries on demand. No scans, executable reads or directory creation. */
export async function inspectBrowserRuntimeInventory(deployment: RuntimeInventoryDeployment): Promise<BrowserRuntimeInventory> {
  const { inventory, candidates } = catalog(deployment);
  inventory.checked = true;
  if (!candidates.size) return inventory;
  const configuredRoot = deployment.runtimeRoot;
  if (!isAbsolute(configuredRoot) || /^[\\/]{2}/.test(configuredRoot) || process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(configuredRoot)) return inventory;
  const absolute = resolve(configuredRoot);
  const { root } = parse(absolute);
  let directory: string | null;
  try {
    const base = await pathInfo(root);
    if (base && !base.isDirectory()) throw new Error("Browser cache root is not a directory");
    const segments = absolute.slice(root.length).split(sep).filter(Boolean);
    directory = base ? await walkDirectories(root, segments) : null;
  } catch {
    for (const row of inventory.runtimes) if (candidates.has(row.id)) row.cache = "unreadable";
    return inventory;
  }
  await Promise.all(inventory.runtimes.map(async row => {
    const candidate = candidates.get(row.id);
    if (!candidate) return;
    if (!directory) {
      row.cache = "missing";
      return;
    }
    const result = await inspectCandidate(directory, candidate);
    row.cache = result.cache;
    if (result.sizeBytes !== undefined) row.sizeBytes = result.sizeBytes;
  }));
  return inventory;
}

export class RuntimeCacheRemovalError extends Error {
  readonly status: 400 | 409 | 500;
  constructor(message: string, status: 400 | 409 | 500) {
    super(message);
    this.status = status;
  }
}

function runtimeDownloadFamily(id: RuntimeInventoryId): RuntimeDownload["runtime"] {
  return id === "aliasmode-firefox" ? "firefox" : id === "cloakbrowser" ? "cloakbrowser" : "aliasmode";
}

function runtimeEngineFamily(id: RuntimeInventoryId): "chromium" | "firefox" {
  return id === "aliasmode-firefox" ? "firefox" : "chromium";
}

function normalizeForComparison(path: string): string {
  const resolved = (() => {
    try { return realpathSync(path); } catch { return resolve(path); }
  })();
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathWithin(parent: string, child: string): boolean {
  const base = normalizeForComparison(parent);
  const target = normalizeForComparison(child);
  const rel = relative(base, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function safeRemoveDirectory(targetDir: string): Promise<void> {
  const info = await lstat(targetDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new RuntimeCacheRemovalError("Browser cache path is unavailable for removal.", 409);
  }
  if (!info.isDirectory()) {
    await unlink(targetDir);
    return;
  }
  const entries = await readdir(targetDir);
  for (const entry of entries) {
    const childPath = join(targetDir, entry);
    const childInfo = await lstat(childPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!childInfo) continue;
    // Unlink links directly without traversing into link targets.
    if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
      await unlink(childPath);
    } else {
      await safeRemoveDirectory(childPath);
    }
  }
  await rmdir(targetDir);
}

export async function removeBrowserRuntimeCache(
  deployment: RuntimeInventoryDeployment,
  runtimeId: RuntimeInventoryId,
  options: {
    runningBinaries?: readonly string[];
    runningEngines?: readonly ("chromium" | "firefox")[];
    activeDownloads?: readonly RuntimeDownload[];
  } = {},
): Promise<BrowserRuntimeInventory> {
  const { inventory, candidates } = catalog(deployment);
  const row = inventory.runtimes.find(item => item.id === runtimeId);
  const candidate = candidates.get(runtimeId);
  if (!row || !candidate || !row.hostSupported || row.source !== "managed") {
    throw new RuntimeCacheRemovalError("Only managed cached runtimes can be removed.", 409);
  }

  const family = runtimeDownloadFamily(runtimeId);
  const activeDownloads = options.activeDownloads ?? runtimeDownloads();
  if (activeDownloads.some(download => download.runtime === family)) {
    throw new RuntimeCacheRemovalError("Wait for the browser download to finish before removing this cache.", 409);
  }

  const engine = runtimeEngineFamily(runtimeId);
  if (options.runningEngines?.includes(engine)) {
    throw new RuntimeCacheRemovalError("Close running browsers using this runtime before removing its cache.", 409);
  }

  const configuredRoot = deployment.runtimeRoot;
  if (!isAbsolute(configuredRoot) || /^[\\/]{2}/.test(configuredRoot) || process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(configuredRoot)) {
    throw new RuntimeCacheRemovalError("Browser cache path is unavailable for removal.", 409);
  }
  const absolute = resolve(configuredRoot);
  const { root } = parse(absolute);
  let runtimeRootDir: string | null;
  let targetDir: string | null;
  try {
    const base = await pathInfo(root);
    if (base && !base.isDirectory()) throw new Error("Browser cache root is not a directory");
    const segments = absolute.slice(root.length).split(sep).filter(Boolean);
    runtimeRootDir = base ? await walkDirectories(root, segments) : null;
    targetDir = runtimeRootDir ? await walkDirectories(runtimeRootDir, [candidate.directory]) : null;
  } catch {
    throw new RuntimeCacheRemovalError("Browser cache path is unavailable for removal.", 409);
  }

  if (targetDir && options.runningBinaries?.some(binary => binary.trim().length > 0 && pathWithin(targetDir, binary))) {
    throw new RuntimeCacheRemovalError("Close running browsers using this runtime before removing its cache.", 409);
  }

  if (targetDir) {
    try {
      await safeRemoveDirectory(targetDir);
    } catch (error) {
      if (error instanceof RuntimeCacheRemovalError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)) {
        throw new RuntimeCacheRemovalError("Could not remove the runtime cache while its files are in use. Close running browsers and try again.", 409);
      }
      throw error;
    }
  }

  return inspectBrowserRuntimeInventory(deployment);
}
