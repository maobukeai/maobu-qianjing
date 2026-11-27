import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CookieRecord } from "../types.ts";
import { renameWhenUnlocked } from "../browser-install.ts";
import { localStateDpapiKey } from "../dpapi.ts";
import { runPlaywrightWorker } from "../playwright-runtime.ts";
import { buildLabelScript } from "./launch-args.ts";
import { IS_WINDOWS } from "./snapshot-utils.ts";

export const SEARCH_PROVIDER_BOOTSTRAP_REVISION = 2;
export const SEARCH_PROVIDER_BOOTSTRAP_MARKER = `.aliasmode-search-bootstrap-v${SEARCH_PROVIDER_BOOTSTRAP_REVISION}`;
export const UNGOOGLED_FIRST_RUN_URL = "chrome://ungoogled-first-run/";
export const NATIVE_SESSION_ARTIFACTS = [
  "Default/Sessions",
  "Default/Current Session",
  "Default/Current Tabs",
  "Default/Last Session",
  "Default/Last Tabs",
];

export const POST_STOP_CACHE_DIRS = [
  "Default/GPUCache",
  "Default/Service Worker",
  "Default/DawnCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
  // Chromium 155's copies of downloaded component packages. Without them, nothing downloads again.
  "component_crx_cache",
];
export const SITE_CACHE_DIRS = ["Default/Code Cache", "Default/Cache"];
export const CACHE_DIRS = [...SITE_CACHE_DIRS, ...POST_STOP_CACHE_DIRS];
export const FIREFOX_CACHE_DIRS = ["cache2", "startupCache", "shader-cache"];
export const FIREFOX_SITE_CACHE_DIRS = ["cache2"];
export const FIREFOX_POST_STOP_CACHE_DIRS = ["shader-cache"];

export type LaunchNavigator = (ws: string, urls: string[], replacePages?: boolean) => Promise<void>;
export type WindowLabeler = (ws: string, label: string) => Promise<void>;
export type CookieEnsurer = (ws: string, cookies: CookieRecord[]) => Promise<{ injected: boolean }>;
export type CookieSetter = (ws: string, cookies: CookieRecord[]) => Promise<void>;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** Bytes of the files under a directory; 0 when it is missing. */
export async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try { total += (await lstat(join(entry.parentPath, entry.name))).size; } catch {}
  }
  return total;
}

export function defaultBinaryPath(): string {
  const configured = process.env.CLOAKBROWSER_BINARY_PATH ?? "";
  if (configured) return configured;
  const bundled = join(process.cwd(), "cloakbrowser", "chrome.exe");
  return IS_WINDOWS && existsSync(bundled) ? bundled : "";
}

const ALIASMODE_PORT = process.env.ALIASMODE_PORT ? Number(process.env.ALIASMODE_PORT) : 50400;
export function profileCardUrl(profileId: string): string {
  return `http://127.0.0.1:${ALIASMODE_PORT}/card?id=${encodeURIComponent(profileId)}`;
}

export async function openProfileCardTab(ws: string, url: string, opts?: { reuseBlank?: boolean }): Promise<void> {
  await runPlaywrightWorker("profile-card", {
    endpoint: ws,
    url,
    ...(opts?.reuseBlank ? { reuseBlank: true } : {}),
    connectTimeoutMs: 10_000,
  });
}

export async function writeIdentityBookmark(userDataDir: string, name: string, url: string): Promise<void> {
  try {
    const dir = join(userDataDir, "Default");
    mkdirSync(dir, { recursive: true });
    const bookmarks = {
      roots: {
        bookmark_bar: { children: [{ name, type: "url", url }], name: "Bookmarks bar", type: "folder" },
        other: { children: [], name: "Other bookmarks", type: "folder" },
        synced: { children: [], name: "Mobile bookmarks", type: "folder" },
      },
      version: 1,
    };
    writeFileSync(join(dir, "Bookmarks"), JSON.stringify(bookmarks));
    const prefsPath = join(dir, "Preferences");
    let prefs: any = {};
    if (existsSync(prefsPath)) {
      try { prefs = JSON.parse(readFileSync(prefsPath, "utf8")); } catch { return; }
    }
    if (typeof prefs !== "object" || prefs === null) return;
    prefs.bookmark_bar = { ...(prefs.bookmark_bar ?? {}), show_on_all_tabs: true };
    await writeFileAtomic(prefsPath, JSON.stringify(prefs));
  } catch {}
}

export function backupUnreadableCookies(userDataDir: string, now = new Date()): string {
  const root = join(userDataDir, "cookie-backups");
  const key = localStateDpapiKey(join(userDataDir, "Local State"));
  const existing = (existsSync(root) ? readdirSync(root) : [])
    .find((name) => localStateDpapiKey(join(root, name, "Local State")) === key);
  if (existing) return join(root, existing);
  const backup = join(root, now.toISOString().replace(/[:.]/g, "-"));
  const network = join(userDataDir, "Default", "Network");
  mkdirSync(join(backup, "Default", "Network"), { recursive: true });
  copyFileSync(join(userDataDir, "Local State"), join(backup, "Local State"));
  for (const name of existsSync(network) ? readdirSync(network) : []) {
    if (name.startsWith("Cookies")) copyFileSync(join(network, name), join(backup, "Default", "Network", name));
  }
  return backup;
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.aliasmode-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, "w");
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    await renameWhenUnlocked(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export const defaultNavigate: LaunchNavigator = async (ws, urls, replacePages = false) => {
  await runPlaywrightWorker("navigate", {
    endpoint: ws,
    urls,
    replacePages,
    connectTimeoutMs: 30_000,
  });
};

export const defaultLabelWindow: WindowLabeler = async (ws, label) => {
  await runPlaywrightWorker("label-window", {
    endpoint: ws,
    script: buildLabelScript(label),
    connectTimeoutMs: 10_000,
  });
};

export const defaultSetCookies: CookieSetter = async (ws, cookies) => {
  await runPlaywrightWorker("cookie-add", { endpoint: ws, cookies, connectTimeoutMs: 30_000 });
};

export const defaultEnsureCookies: CookieEnsurer = async (ws, cookies) => {
  return runPlaywrightWorker<{ injected: boolean }>("ensure-cookies", {
    endpoint: ws,
    cookies,
    connectTimeoutMs: 30_000,
  });
};
