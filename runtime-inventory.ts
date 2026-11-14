import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { ALIASMODE_CHROMIUM_PINNED_VERSION, managedChromiumLocation } from "./aliasmode-chromium.ts";
import { cloakBrowserVersionForPlatform } from "./browser-install.ts";
import { defaultProfileEngine } from "./create.ts";
import { FIREFOX_RUNTIME_BUILDS, FIREFOX_RUNTIME_VERSION, firefoxInstallDirectoryPrefix, type FirefoxRuntimeBuild } from "./firefox-install.ts";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory } from "./firefox-managed.ts";

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

async function inspectCandidate(root: string, candidate: Candidate): Promise<RuntimeCacheState> {
  try {
    const directory = await walkDirectories(root, [candidate.directory]);
    if (!directory) return "missing";
    const parts = candidate.firefox ? await readFirefoxRecord(directory, candidate.firefox) : candidate.executable.split("/");
    if (!parts) return "incomplete";
    const parent = await walkDirectories(directory, parts.slice(0, -1));
    const executable = parent && await pathInfo(join(parent, parts.at(-1)!));
    return executable && executable.isFile() && executable.size > 0 ? "present-unverified" : "incomplete";
  } catch {
    return "unreadable";
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
    if (candidate) row.cache = directory ? await inspectCandidate(directory, candidate) : "missing";
  }));
  return inventory;
}
