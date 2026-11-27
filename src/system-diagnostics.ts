import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, readFileSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createConnection, isIPv6 } from "node:net";
import { homedir, release as osRelease, type as osType, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { managedChromiumLocation } from "./aliasmode-chromium.ts";
import { FIREFOX_RUNTIME_BUILDS, firefoxInstallDirectoryPrefix, type FirefoxRuntimeBuild } from "./firefox-install.ts";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory } from "./firefox-managed.ts";
import { getIntegrationInfo, type IntegrationInfo, type IntegrationInfoOptions } from "../agent/integration-info.ts";
import { probeMcpIntegration, type IntegrationProbeOptions, type IntegrationProbeResult } from "../agent/integration-probe.ts";
import type { Launcher } from "./launcher.ts";
import type { StatePaths } from "./paths.ts";
import { resolvePlaywrightRuntime, type PlaywrightRuntimeLayout } from "./playwright-runtime.ts";
import {
  inspectBrowserRuntimeInventory,
  type BrowserRuntimeInventory,
  type RuntimeInventoryDeployment,
  type RuntimeInventoryId,
} from "./runtime-inventory.ts";
import type { ProfileStore } from "./store.ts";
import { LOW_DISK_SPACE_BYTES } from "./ui/shared.ts";
import { ALIASMODE_VERSION } from "./version.ts";

export const MAX_DIAGNOSTIC_ZIP_BYTES = 2 * 1024 * 1024; // 2 MiB hard ceiling
export const DEFAULT_AUTOMATION_PORT = 50400;
const CRITICAL_DISK_SPACE_BYTES = 1 * 1024 ** 3;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SIDECAR_LOG_TAIL_BYTES = 256 * 1024;
const MAX_PANIC_LOG_TAIL_BYTES = 128 * 1024;

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skipped";

export type DiagnosticCheckId =
  | "webview2_os"
  | "ports"
  | "sqlite"
  | "runtimes"
  | "disk_space"
  | "mcp";

export interface DiagnosticCheckResult {
  id: DiagnosticCheckId;
  title: string;
  status: DiagnosticStatus;
  summary: string;
  durationMs: number;
  details: Record<string, unknown>;
  recommendations?: string[];
}

export interface ClientDesktopProbeInput {
  platform?: string;
  arch?: string;
  osName?: string;
  osVersion?: string | null;
  osBuild?: number | null;
  webview2Version?: string | null;
  webview2Channel?: string | null;
  webview2Available?: boolean;
}

export interface SystemDiagnosticReport {
  version: 1;
  generatedAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  desktopAvailable: boolean;
  overallStatus: "pass" | "warn" | "fail";
  summary: {
    pass: number;
    warn: number;
    fail: number;
    skipped: number;
  };
  checks: DiagnosticCheckResult[];
}

export interface RedactionContext {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  username?: string;
  extraPaths?: Array<{ path: string; replacement: string }>;
}

export interface SystemDiagnosticsOptions {
  store: ProfileStore;
  launcher: Pick<Launcher, "dataDriveFreeBytes">;
  paths?: StatePaths;
  workspaceHome?: string;
  runtimeInventory?: RuntimeInventoryDeployment;
  desktopAvailable?: boolean;
  dashboardPort?: number | null;
  automationPort?: number;
  includeMcpProbe?: boolean;
  desktopProbe?: ClientDesktopProbeInput | null;
  redactionContext?: RedactionContext;
  /** Injectable probes for deterministic testing. */
  probeTcpPort?: (host: string, port: number, timeoutMs?: number) => Promise<"listening" | "closed" | "timeout">;
  getIntegration?: (options?: IntegrationInfoOptions) => IntegrationInfo;
  probeMcp?: (options?: IntegrationProbeOptions) => Promise<IntegrationProbeResult>;
  resolvePlaywright?: () => PlaywrightRuntimeLayout;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Strict Redaction Engine
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPathReplacements(context?: RedactionContext): Array<{ regex: RegExp; replacement: string }> {
  const env = context?.env ?? process.env;
  const pairs: Array<{ raw: string; replacement: string }> = [];

  const add = (raw: string | undefined, replacement: string) => {
    const trimmed = raw?.trim();
    if (!trimmed || trimmed.length < 3) return;
    pairs.push({ raw: trimmed, replacement });
    const slash = trimmed.replaceAll("\\", "/");
    if (slash !== trimmed) pairs.push({ raw: slash, replacement });
  };

  // Replace more specific directories (AppData/LocalAppData/Temp) before home directory.
  add(env.LOCALAPPDATA, "<APP_DATA>");
  add(env.APPDATA, "<APP_DATA>");
  add(env.TEMP, "<TEMP_DIR>");
  add(env.TMP, "<TEMP_DIR>");
  if (context?.extraPaths) {
    for (const item of context.extraPaths) add(item.path, item.replacement);
  }
  add(env.USERPROFILE, "<USER_HOME>");
  add(env.HOME, "<USER_HOME>");
  try {
    add(context?.homeDir ?? homedir(), "<USER_HOME>");
  } catch {
    // Ignore restricted OS home lookups.
  }

  // Sort longest first so nested subdirectories match before parent paths.
  pairs.sort((a, b) => b.raw.length - a.raw.length);
  const seen = new Set<string>();
  const compiled: Array<{ regex: RegExp; replacement: string }> = [];
  for (const pair of pairs) {
    const key = pair.raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    compiled.push({
      regex: new RegExp(escapeRegExp(pair.raw), "gi"),
      replacement: pair.replacement,
    });
  }
  return compiled;
}

function resolveUsername(context?: RedactionContext): string | null {
  if (context?.username !== undefined) {
    return context.username.trim().length >= 3 ? context.username.trim() : null;
  }
  const env = context?.env ?? process.env;
  const fromEnv = env.USERNAME ?? env.USER;
  if (fromEnv && fromEnv.trim().length >= 3) return fromEnv.trim();
  try {
    const name = userInfo().username;
    return name && name.trim().length >= 3 ? name.trim() : null;
  } catch {
    return null;
  }
}

function isSafeIpAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "::1";
}

function redactPublicIpv4(text: string): string {
  // Match candidate dotted quads while avoiding version strings like "v1.2.3.4", "Chrome/130.0.1.2", or "version=1.2.3.4".
  return text.replace(
    /(?<![A-Za-z0-9._/-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![A-Za-z0-9._-])/g,
    (match, a: string, b: string, c: string, d: string, offset: number, whole: string) => {
      const octets = [Number(a), Number(b), Number(c), Number(d)];
      if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return match;
      }
      if (isSafeIpAddress(match)) return match;
      const prefix = whole.slice(Math.max(0, offset - 20), offset).toLowerCase();
      if (/(?:version|ver|build|chrome|edg|firefox|webview2|pv)\s*[:=/]?\s*v?$/.test(prefix)) {
        return match;
      }
      return "<REDACTED_IP>";
    },
  );
}

function redactPublicIpv6(text: string): string {
  // Match candidate hex-colon tokens and validate with node:net isIPv6(), preserving loopback ::1.
  return text.replace(
    /(?<![A-Fa-f0-9:])([A-Fa-f0-9:]{2,39})(?![A-Fa-f0-9:])/g,
    (match) => {
      if (!match.includes(":")) return match;
      const lower = match.toLowerCase();
      if (lower === "::1" || lower === "::") return match;
      if (isIPv6(match)) return "<REDACTED_IP>";
      return match;
    },
  );
}

/**
 * Strictly redacts local paths/usernames, Bearer & hex tokens, credentials (`password=`,
 * `user:pass@`), public egress IPv4/IPv6 addresses, Cookies, and CDP/WebSocket URLs.
 */
export function redactDiagnosticText(input: string, context?: RedactionContext): string {
  let text = String(input);

  // 1. Concrete environment paths first
  for (const { regex, replacement } of buildPathReplacements(context)) {
    text = text.replace(regex, replacement);
  }

  // 2. Generic OS user home paths (Windows / macOS / Linux)
  text = text.replace(/[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n\s]+/gi, "<USER_HOME>");
  text = text.replace(/[A-Za-z]:\/Users\/[^\\/:*?"<>|\r\n\s]+/gi, "<USER_HOME>");
  text = text.replace(/(?<![A-Za-z0-9_])\/(?:Users|home)\/[^/\s'"<>\\]+/g, "<USER_HOME>");

  // 3. CDP / WebSocket URLs (may embed debug ports or session UUIDs)
  text = text.replace(/\bwss?:\/\/[^\s'"<>)}\]]+/gi, "[REDACTED_CDP_URL]");

  // 4. URL credentials user:pass@host (including http/https/socks5/socks4)
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/gi,
    "$1[REDACTED]:[REDACTED]@",
  );
  // Bare proxy user:pass@host:port
  text = text.replace(
    /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._-]{2,64}):([^\s@/:;,]{2,128})@([A-Za-z0-9.-]+:\d{2,5})/g,
    "[REDACTED]:[REDACTED]@$3",
  );

  // 5. Cookie / Set-Cookie headers
  text = text.replace(
    /(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi,
    "$1[REDACTED]",
  );

  // 6. Authorization / Bearer / Maobu session headers
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  text = text.replace(
    /\b(Authorization|X-Maobu-Desktop-Session|X-Maobu-Session|X-Maobu-Workspace-Capability|X-Maobu-Backup-Password)(\s*[:=]\s*)([^\r\n,;'"}\]]+)/gi,
    (match, key: string, sep: string, value: string) => {
      if (/^(?:Bearer\s+)?\[REDACTED\]$/.test(value.trim())) return match;
      return `${key}${sep}[REDACTED]`;
    },
  );

  // 7. JSON-quoted sensitive keys
  text = text.replace(
    /("(?:password|passwd|pwd|pass|emailPassword|twofa|totp|secret|token|apiKey|api_key|nonce|cookies?|session_json|refreshUrl|authorization)")(\s*:\s*)("[^"]*"|'[^']*')/gi,
    '$1$2"[REDACTED]"',
  );

  // 8. Query/log key=value secrets
  text = text.replace(
    /\b(password|passwd|pwd|pass|emailPassword|twofa|totp|secret|token|api[_-]?key|nonce|cookie|session[_-]?id|refresh[_-]?token|access[_-]?token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;'"&}]+)/gi,
    (match, key: string, sep: string, value: string) => {
      if (/^\[REDACTED\]/.test(value.trim())) return match;
      return `${key}${sep}[REDACTED]`;
    },
  );

  // 9. Long hex tokens (>= 32 hex chars), preserving explicitly labeled sha256 digests
  text = text.replace(
    /(?<![A-Fa-f0-9])([A-Fa-f0-9]{32,})(?![A-Fa-f0-9])/g,
    (match, _group: string, offset: number, whole: string) => {
      const prefix = whole.slice(Math.max(0, offset - 16), offset).toLowerCase();
      if (/(?:sha256|digest)["']?\s*[:=]\s*["']?$/.test(prefix)) {
        return match;
      }
      return "[REDACTED_HEX]";
    },
  );

  // 10. Public egress IPv4 and IPv6
  text = redactPublicIpv4(text);
  text = redactPublicIpv6(text);

  // 11. Explicit username fallback in path segments
  const username = resolveUsername(context);
  if (username) {
    const userPathPattern = new RegExp(`([\\\\/])${escapeRegExp(username)}(?=[\\\\/]|$)`, "gi");
    text = text.replace(userPathPattern, "$1<USER>");
  }

  return text;
}

const PRESERVED_SAFE_FIELDS = new Set([
  "appVersion",
  "pinnedVersion",
  "webview2Version",
  "osVersion",
  "sha256",
  "expectedSha256",
  "generatedAt",
  "version",
]);

function redactDiagnosticObject<T>(value: T, context?: RedactionContext, keyName?: string): T {
  if (typeof value === "string") {
    if (keyName && PRESERVED_SAFE_FIELDS.has(keyName)) {
      return value;
    }
    return redactDiagnosticText(value, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticObject(item, context)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDiagnosticObject(v, context, k);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helper Probes
// ---------------------------------------------------------------------------

export async function probeLoopbackTcpPort(
  host: string,
  port: number,
  timeoutMs = 800,
): Promise<"listening" | "closed" | "timeout"> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "closed";
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (status: "listening" | "closed" | "timeout") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(status);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("listening"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", () => finish("closed"));
  });
}

async function streamSha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Target executable is not a regular file");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buf.byteLength;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function resolveManagedExecutablePath(
  deployment: RuntimeInventoryDeployment,
  id: RuntimeInventoryId,
): Promise<{ path: string; expectedSha256?: string } | null> {
  const root = resolve(deployment.runtimeRoot);
  if (id === "aliasmode-chromium" || id === "cloakbrowser") {
    const kind = id === "aliasmode-chromium" ? "aliasmode" : "cloakbrowser";
    const loc = managedChromiumLocation(kind, deployment.platform, deployment.arch);
    if (!loc) return null;
    const candidate = join(root, loc.directory, ...loc.executable.split("/"));
    const info = await lstat(candidate).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile()) return null;
    return { path: candidate };
  }
  if (id === "aliasmode-firefox") {
    const build: FirefoxRuntimeBuild | undefined = FIREFOX_RUNTIME_BUILDS.find(
      (item) => item.platform === deployment.platform && item.arch === deployment.arch,
    );
    if (!build) return null;
    const dir = join(root, firefoxManagedDirectory(deployment.platform, deployment.arch));
    const recordPath = join(dir, FIREFOX_MANAGED_RECORD);
    const info = await lstat(recordPath).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 4096) return null;
    try {
      const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as { path?: unknown; sha256?: unknown };
      if (typeof parsed.path !== "string") return null;
      const parts = parsed.path.split(/[\\/]/);
      const prefix = firefoxInstallDirectoryPrefix(build.platform, build.arch);
      const installed = parts[1];
      if (
        parts[0] !== "browser"
        || !installed?.startsWith(prefix)
        || !/^[A-Za-z0-9]{6}$/.test(installed.slice(prefix.length))
        || parts.slice(2).join("/") !== build.executablePath
      ) {
        return null;
      }
      const exePath = join(dir, ...parts);
      const exeInfo = await lstat(exePath).catch(() => null);
      if (!exeInfo || exeInfo.isSymbolicLink() || !exeInfo.isFile()) return null;
      return { path: exePath, expectedSha256: build.executableSha256 };
    } catch {
      return null;
    }
  }
  return null;
}

async function safeDirectoryBytes(target: string, budget: { remaining: number }): Promise<{ bytes: number; truncated: boolean }> {
  let bytes = 0;
  let truncated = false;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    budget.remaining--;
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isFile()) {
      bytes += info.size;
      continue;
    }
    if (info.isDirectory()) {
      const entries = await readdir(current).catch(() => [] as string[]);
      for (const name of entries) {
        stack.push(join(current, name));
      }
    }
  }
  return { bytes, truncated };
}

function sanitizeClientProbe(raw: ClientDesktopProbeInput | null | undefined): ClientDesktopProbeInput | null {
  if (!raw || typeof raw !== "object") return null;
  const safeString = (value: unknown, maxLen = 64): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().slice(0, maxLen);
    return trimmed ? trimmed : undefined;
  };
  return {
    platform: safeString(raw.platform, 24),
    arch: safeString(raw.arch, 24),
    osName: safeString(raw.osName, 64),
    osVersion: raw.osVersion === null ? null : safeString(raw.osVersion, 64) ?? null,
    osBuild: typeof raw.osBuild === "number" && Number.isSafeInteger(raw.osBuild) && raw.osBuild >= 0 ? raw.osBuild : null,
    webview2Version: raw.webview2Version === null ? null : safeString(raw.webview2Version, 64) ?? null,
    webview2Channel: raw.webview2Channel === null ? null : safeString(raw.webview2Channel, 32) ?? null,
    webview2Available: typeof raw.webview2Available === "boolean" ? raw.webview2Available : undefined,
  };
}

// ---------------------------------------------------------------------------
// 6 Core Diagnostic Checks
// ---------------------------------------------------------------------------

async function checkWebView2AndOs(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  const desktopAvailable = options.desktopAvailable === true;
  const probe = sanitizeClientProbe(options.desktopProbe);
  const hostOs = {
    platform: process.platform,
    arch: process.arch,
    osType: osType(),
    osRelease: osRelease(),
  };

  if (probe) {
    const isWindows = (probe.platform ?? process.platform) === "windows" || process.platform === "win32";
    if (isWindows) {
      if (probe.webview2Available && probe.webview2Version) {
        return {
          id: "webview2_os",
          title: "WebView2 & Operating System",
          status: "pass",
          summary: `${probe.osName ?? "Windows"}${probe.osVersion ? ` ${probe.osVersion}` : ""} · WebView2 ${probe.webview2Version}`,
          durationMs: Math.round(performance.now() - started),
          details: { ...hostOs, desktopProbe: probe },
        };
      }
      return {
        id: "webview2_os",
        title: "WebView2 & Operating System",
        status: "fail",
        summary: "Microsoft Edge WebView2 Runtime was not detected in the Windows registry.",
        durationMs: Math.round(performance.now() - started),
        details: { ...hostOs, desktopProbe: probe },
        recommendations: ["Install or repair Microsoft Edge WebView2 Runtime (Evergreen)."],
      };
    }
    return {
      id: "webview2_os",
      title: "WebView2 & Operating System",
      status: "pass",
      summary: `${probe.osName ?? hostOs.osType} (${probe.arch ?? hostOs.arch})`,
      durationMs: Math.round(performance.now() - started),
      details: { ...hostOs, desktopProbe: probe, webview2Applicable: false },
    };
  }

  if (!desktopAvailable) {
    return {
      id: "webview2_os",
      title: "WebView2 & Operating System",
      status: "skipped",
      summary: `WebView2 check skipped outside desktop shell (${hostOs.osType} ${hostOs.osRelease}).`,
      durationMs: Math.round(performance.now() - started),
      details: { ...hostOs, desktopAvailable: false, webview2ProbeSkipped: true },
    };
  }

  return {
    id: "webview2_os",
    title: "WebView2 & Operating System",
    status: "warn",
    summary: "Desktop shell did not attach WebView2 registry probe data.",
    durationMs: Math.round(performance.now() - started),
    details: { ...hostOs, desktopAvailable: true, desktopProbe: null },
    recommendations: ["Run diagnostics from the native desktop window to verify WebView2 version."],
  };
}

async function checkPortsHealth(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  const dashboardPort = options.dashboardPort ?? null;
  const automationPort = options.automationPort ?? DEFAULT_AUTOMATION_PORT;
  const probe = options.probeTcpPort ?? probeLoopbackTcpPort;

  const automationStatus = await probe("127.0.0.1", automationPort, 800);
  const launches = options.store.listLaunches();
  const activeChromium = launches.filter((l) => l.engine !== "firefox").length;
  const activeFirefox = launches.filter((l) => l.engine === "firefox").length;

  let status: DiagnosticStatus = "pass";
  const recommendations: string[] = [];
  if (dashboardPort !== null && (!Number.isInteger(dashboardPort) || dashboardPort <= 0 || dashboardPort > 65535)) {
    status = "warn";
  }
  if (automationStatus === "timeout") {
    status = "warn";
    recommendations.push(`Loopback port ${automationPort} timed out; check local firewall or port conflicts.`);
  }

  const summaryParts = [
    dashboardPort ? `Dashboard loopback :${dashboardPort}` : "Dashboard loopback active",
    `Automation :${automationPort} (${automationStatus})`,
    `${launches.length} active browser(s)`,
  ];

  return {
    id: "ports",
    title: "Loopback Ports & Active Browsers",
    status,
    summary: summaryParts.join(" · "),
    durationMs: Math.round(performance.now() - started),
    details: {
      dashboardHost: "127.0.0.1",
      dashboardPort,
      automationHost: "127.0.0.1",
      automationPort,
      automationPortStatus: automationStatus,
      activeBrowsers: {
        total: launches.length,
        chromium: activeChromium,
        firefox: activeFirefox,
      },
    },
    ...(recommendations.length ? { recommendations } : {}),
  };
}

async function checkSqliteIntegrity(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  try {
    const db = options.store.rawDatabase();
    const quickRows = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    const quickCheckValues = quickRows.map((row) => String(row.quick_check));
    const quickCheckOk = quickCheckValues.length === 1 && quickCheckValues[0] === "ok";
    const journalRow = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    const versionRow = db.query<{ user_version: number }, []>("PRAGMA user_version").get();

    const safeFileSize = async (path: string | undefined): Promise<number | null> => {
      if (!path) return null;
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) return null;
      return info.size;
    };

    const dbBytes = await safeFileSize(options.paths?.database);
    const walBytes = await safeFileSize(options.paths ? `${options.paths.database}-wal` : undefined);
    const shmBytes = await safeFileSize(options.paths ? `${options.paths.database}-shm` : undefined);

    const profileCount = options.store.count();
    const trashedCount = options.store.listTrashed().length;
    const runningCount = options.store.listLaunches().length;
    const groupCount = options.store.listGroups().length;

    return {
      id: "sqlite",
      title: "SQLite Database Integrity",
      status: quickCheckOk ? "pass" : "fail",
      summary: quickCheckOk
        ? `PRAGMA quick_check ok · ${profileCount} profiles · schema v${versionRow?.user_version ?? 0}`
        : `PRAGMA quick_check reported issues (${quickCheckValues.slice(0, 3).join("; ")})`,
      durationMs: Math.round(performance.now() - started),
      details: {
        quickCheckOk,
        quickCheckIssuesCount: quickCheckOk ? 0 : quickCheckValues.length,
        journalMode: journalRow?.journal_mode ?? "unknown",
        userVersion: versionRow?.user_version ?? 0,
        databaseBytes: dbBytes,
        walBytes,
        shmBytes,
        counts: {
          profiles: profileCount,
          trashed: trashedCount,
          running: runningCount,
          groups: groupCount,
        },
      },
      ...(!quickCheckOk
        ? { recommendations: ["Back up your workspace folder immediately and restore from a verified backup."] }
        : {}),
    };
  } catch (error) {
    return {
      id: "sqlite",
      title: "SQLite Database Integrity",
      status: "fail",
      summary: `Database integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Math.round(performance.now() - started),
      details: { error: error instanceof Error ? error.message : String(error) },
      recommendations: ["Ensure profiles.sqlite is readable and not locked by another instance."],
    };
  }
}

async function checkRuntimesAndHashes(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  const playwright = (options.resolvePlaywright ?? resolvePlaywrightRuntime)();

  let nodeHash: { present: boolean; sha256?: string; bytes?: number } = { present: false };
  let playwrightCoreHash: { present: boolean; version?: string; sha256?: string; bytes?: number } = { present: false };

  if (playwright.kind === "packaged") {
    try {
      const hashed = await streamSha256File(playwright.nodeExecutable);
      nodeHash = { present: true, ...hashed };
    } catch {
      nodeHash = { present: false };
    }
  } else {
    nodeHash = { present: true };
  }

  const pwPkgPath = join(playwright.root, "node_modules", "playwright-core", "package.json");
  try {
    const hashed = await streamSha256File(pwPkgPath);
    const pkg = JSON.parse(readFileSync(pwPkgPath, "utf8")) as { version?: unknown };
    playwrightCoreHash = {
      present: true,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      ...hashed,
    };
  } catch {
    playwrightCoreHash = { present: false };
  }

  let inventory: BrowserRuntimeInventory | null = null;
  const runtimeChecks: Array<{
    id: RuntimeInventoryId;
    pinnedVersion: string;
    source: string;
    cache: string;
    sha256?: string;
    bytes?: number;
    hashMatch?: boolean;
  }> = [];

  let anyHashMismatch = false;
  let anyCorruptCache = false;
  let installedCount = 0;

  if (options.runtimeInventory) {
    inventory = await inspectBrowserRuntimeInventory(options.runtimeInventory);
    for (const row of inventory.runtimes) {
      const entry: {
        id: RuntimeInventoryId;
        pinnedVersion: string;
        source: string;
        cache: string;
        sha256?: string;
        bytes?: number;
        hashMatch?: boolean;
      } = {
        id: row.id,
        pinnedVersion: row.pinnedVersion,
        source: row.source,
        cache: row.cache,
      };
      if (row.cache === "incomplete" || row.cache === "unreadable") {
        anyCorruptCache = true;
      }
      if (row.cache === "present-unverified") {
        const resolvedExe = await resolveManagedExecutablePath(options.runtimeInventory, row.id);
        if (resolvedExe) {
          try {
            const hashed = await streamSha256File(resolvedExe.path);
            entry.sha256 = hashed.sha256;
            entry.bytes = hashed.bytes;
            installedCount++;
            if (resolvedExe.expectedSha256) {
              entry.hashMatch = hashed.sha256.toLowerCase() === resolvedExe.expectedSha256.toLowerCase();
              if (!entry.hashMatch) anyHashMismatch = true;
            }
          } catch {
            entry.cache = "unreadable";
            anyCorruptCache = true;
          }
        }
      }
      runtimeChecks.push(entry);
    }
  }

  const packagedBroken = playwright.kind === "packaged" && (!nodeHash.present || !playwrightCoreHash.present);
  const recommendations: string[] = [];
  let status: DiagnosticStatus = "pass";
  let summary = "";

  if (anyHashMismatch) {
    status = "fail";
    summary = "One or more managed browser binaries failed SHA-256 verification.";
    recommendations.push("Re-download the affected browser runtime or reinstall the application.");
  } else if (packagedBroken) {
    status = "fail";
    summary = "Packaged Node or playwright-core runtime files are missing.";
    recommendations.push("Reinstall the Maobu Browser desktop package to restore missing runtime files.");
  } else if (anyCorruptCache) {
    status = "warn";
    summary = "A cached browser engine directory is incomplete or unreadable.";
    recommendations.push("Open a profile to trigger a clean runtime re-download.");
  } else if (options.runtimeInventory && installedCount === 0) {
    status = "pass";
    summary = "Runtime cache clean (on-demand browser engines will download on first launch).";
  } else {
    status = "pass";
    summary = `Verified ${installedCount} installed browser engine(s) · Playwright runtime (${playwright.kind}).`;
  }

  return {
    id: "runtimes",
    title: "Browser Runtimes & SHA-256 Integrity",
    status,
    summary,
    durationMs: Math.round(performance.now() - started),
    details: {
      playwrightRuntime: {
        kind: playwright.kind,
        node: nodeHash,
        playwrightCore: playwrightCoreHash,
      },
      browserRuntimes: runtimeChecks,
      defaultRuntime: inventory?.defaultRuntime ?? null,
    },
    ...(recommendations.length ? { recommendations } : {}),
  };
}

async function checkDiskSpace(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  const freeBytes = options.launcher.dataDriveFreeBytes();
  const subdirs: Record<string, number> = {};
  let truncated = false;
  let totalWorkspaceBytes = 0;

  if (options.paths) {
    const budget = { remaining: MAX_SCAN_ENTRIES };
    const targets: Array<[string, string]> = [
      ["database", options.paths.database],
      ["profiles", options.paths.profiles],
      ["extensions", options.paths.extensions],
      ["customScripts", join(options.paths.root, "custom-scripts")],
      ["logs", join(options.paths.root, "logs")],
      ["backups", join(options.paths.root, "backups")],
    ];
    for (const [label, targetPath] of targets) {
      const result = await safeDirectoryBytes(targetPath, budget);
      subdirs[label] = result.bytes;
      totalWorkspaceBytes += result.bytes;
      if (result.truncated) truncated = true;
    }
  }

  const low = freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES;
  const critical = freeBytes !== null && freeBytes < CRITICAL_DISK_SPACE_BYTES;
  let status: DiagnosticStatus = "pass";
  const recommendations: string[] = [];

  if (critical) {
    status = "fail";
    recommendations.push("Free up at least 5 GiB on the data drive to prevent browser storage eviction.");
  } else if (low || freeBytes === null) {
    status = "warn";
    if (low) recommendations.push("Less than 5 GiB free on the data drive. Clean up old backups or caches.");
  }

  const freeGiB = freeBytes !== null ? `${(freeBytes / 1024 ** 3).toFixed(2)} GiB` : "unavailable";
  return {
    id: "disk_space",
    title: "Disk Space & Workspace Storage",
    status,
    summary: `Free space: ${freeGiB} (threshold: ${(LOW_DISK_SPACE_BYTES / 1024 ** 3).toFixed(0)} GiB)`,
    durationMs: Math.round(performance.now() - started),
    details: {
      freeBytes,
      lowSpaceThresholdBytes: LOW_DISK_SPACE_BYTES,
      low,
      critical,
      workspaceBytes: totalWorkspaceBytes,
      subdirectoriesBytes: subdirs,
      scanTruncated: truncated,
    },
    ...(recommendations.length ? { recommendations } : {}),
  };
}

async function checkMcpResources(options: SystemDiagnosticsOptions): Promise<DiagnosticCheckResult> {
  const started = performance.now();
  const desktopAvailable = options.desktopAvailable === true;
  const info = (options.getIntegration ?? getIntegrationInfo)({ runtimeAvailable: desktopAvailable });

  let probeResult: IntegrationProbeResult | null = null;
  if (options.includeMcpProbe) {
    probeResult = await (options.probeMcp ?? probeMcpIntegration)({
      runtimeAvailable: desktopAvailable,
      timeoutMs: 8000,
    });
  }

  let status: DiagnosticStatus = "pass";
  let summary = "";
  const recommendations: string[] = [];

  if (probeResult) {
    if (probeResult.status === "connected") {
      status = "pass";
      summary = `MCP handshake verified (${probeResult.toolCount} read-only tools available).`;
    } else if (probeResult.status === "unavailable") {
      status = "warn";
      summary = `MCP handshake unavailable (${probeResult.errorCode ?? "unavailable"}).`;
      recommendations.push("Launch the desktop application to enable local MCP integration.");
    } else {
      status = "fail";
      summary = `MCP handshake ${probeResult.status} (${probeResult.errorCode ?? "failed"}).`;
      recommendations.push("Verify desktop installation resources and retry the MCP handshake.");
    }
  } else {
    if (info.status === "ready") {
      status = "pass";
      summary = "MCP helper and runtime resources are ready (handshake skipped).";
    } else if (info.status === "desktop_required") {
      status = "warn";
      summary = "MCP helper requires the desktop application runtime.";
    } else {
      status = "fail";
      summary = `MCP resources status: ${info.status}.`;
      recommendations.push("Reinstall or rebuild desktop agent resources.");
    }
  }

  return {
    id: "mcp",
    title: "MCP Resources & Read-Only Handshake",
    status,
    summary,
    durationMs: Math.round(performance.now() - started),
    details: {
      status: info.status,
      transport: info.transport,
      version: info.version,
      checks: info.checks.map((check) => ({
        id: check.id,
        status: check.status,
        message: check.message,
      })),
      handshakeRequested: options.includeMcpProbe === true,
      handshake: probeResult
        ? {
            status: probeResult.status,
            connectionVerified: probeResult.connectionVerified,
            toolCount: probeResult.toolCount,
            tools: probeResult.tools,
            server: probeResult.server ?? null,
            errorCode: probeResult.errorCode ?? null,
          }
        : null,
    },
    ...(recommendations.length ? { recommendations } : {}),
  };
}

/** Run all 6 system diagnostic checks and return a strictly redacted report (never containing profiles or secrets). */
export async function runSystemDiagnostics(options: SystemDiagnosticsOptions): Promise<SystemDiagnosticReport> {
  const now = (options.now ?? (() => new Date()))();
  const checks = await Promise.all([
    checkWebView2AndOs(options),
    checkPortsHealth(options),
    checkSqliteIntegrity(options),
    checkRuntimesAndHashes(options),
    checkDiskSpace(options),
    checkMcpResources(options),
  ]);

  const summary = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) {
    summary[check.status]++;
  }
  const overallStatus: "pass" | "warn" | "fail" =
    summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";

  const rawReport: SystemDiagnosticReport = {
    version: 1,
    generatedAt: now.toISOString(),
    appVersion: ALIASMODE_VERSION,
    platform: process.platform,
    arch: process.arch,
    desktopAvailable: options.desktopAvailable === true,
    overallStatus,
    summary,
    checks,
  };

  return redactDiagnosticObject(rawReport, options.redactionContext);
}

// ---------------------------------------------------------------------------
// Redacted Log Reading & Pure node:zlib Standard ZIP Builder
// ---------------------------------------------------------------------------

async function readSafeTailUtf8(filePath: string, maxBytes: number): Promise<string | null> {
  const info = await lstat(filePath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size === 0) return null;
  const bytesToRead = Math.min(info.size, maxBytes);
  const startOffset = info.size - bytesToRead;
  const handle = await open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return null;
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const { bytesRead } = await handle.read(buffer, offset, bytesToRead - offset, startOffset + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

export async function collectRedactedLogTails(options: {
  paths?: StatePaths;
  workspaceHome?: string;
  redactionContext?: RedactionContext;
  maxSidecarBytes?: number;
  maxPanicBytes?: number;
}): Promise<{ sidecarLog: string | null; panicLog: string | null }> {
  const logDirs: string[] = [];
  if (options.paths) logDirs.push(join(options.paths.root, "logs"));
  if (options.workspaceHome && (!options.paths || resolve(options.workspaceHome) !== resolve(options.paths.root))) {
    logDirs.push(join(resolve(options.workspaceHome), "logs"));
  }

  let sidecarLog: string | null = null;
  let panicLog: string | null = null;

  for (const dir of logDirs) {
    const dirInfo = await lstat(dir).catch(() => null);
    if (!dirInfo || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) continue;

    if (sidecarLog === null) {
      try {
        const latest = readdirSync(dir)
          .filter((name) => /^aliasmode-\d{4}-\d{2}-\d{2}\.log$/.test(name))
          .sort()
          .pop();
        if (latest) {
          const raw = await readSafeTailUtf8(join(dir, latest), options.maxSidecarBytes ?? MAX_SIDECAR_LOG_TAIL_BYTES);
          if (raw !== null) {
            sidecarLog = redactDiagnosticText(raw, options.redactionContext);
          }
        }
      } catch {
        // Ignore unreadable log directory.
      }
    }

    if (panicLog === null) {
      const rawPanic = await readSafeTailUtf8(
        join(dir, "desktop-panic.log"),
        options.maxPanicBytes ?? MAX_PANIC_LOG_TAIL_BYTES,
      );
      if (rawPanic !== null) {
        panicLog = redactDiagnosticText(rawPanic, options.redactionContext);
      }
    }
  }

  return { sidecarLog, panicLog };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  const time = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { time, dosDate };
}

export interface ZipEntryInput {
  name: string;
  content: Uint8Array | string;
}

/**
 * Pure `node:zlib` standard PKZIP builder (DEFLATE method 8, UTF-8 names, CRC-32).
 * Zero third-party dependencies.
 */
export function buildZipArchive(entries: readonly ZipEntryInput[], modifiedAt = new Date()): Uint8Array {
  const { time, dosDate } = dosDateTime(modifiedAt);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const rawData = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    const checksum = crc32(rawData);
    const deflated = deflateRawSync(rawData, { level: 6 });
    const useDeflate = deflated.byteLength < rawData.byteLength;
    const payload = useDeflate ? deflated : rawData;
    const method = useDeflate ? 8 : 0;

    // Local File Header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.byteLength, 18);
    localHeader.writeUInt32LE(rawData.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len
    nameBytes.copy(localHeader, 30);

    // Central Directory Header (46 bytes + name)
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.byteLength, 20);
    centralHeader.writeUInt32LE(rawData.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative local header offset
    nameBytes.copy(centralHeader, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + payload.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, eocd]));
}

function truncateTailUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const sliced = buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  const newlineIdx = sliced.indexOf("\n");
  return newlineIdx >= 0 && newlineIdx < 256 ? sliced.slice(newlineIdx + 1) : sliced;
}

export interface DiagnosticBundleOutput {
  report: SystemDiagnosticReport;
  zipBytes: Uint8Array;
  sha256: string;
  entries: string[];
}

/**
 * Generates a strictly redacted diagnostic ZIP bundle (`<= 2 MiB`) containing
 * `diagnostic-report.json` and optional redacted tails of sidecar & panic logs.
 */
export async function createDiagnosticZip(
  options: SystemDiagnosticsOptions & { includeLogs?: boolean; report?: SystemDiagnosticReport },
): Promise<DiagnosticBundleOutput> {
  const report = options.report ?? (await runSystemDiagnostics(options));
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const entries: ZipEntryInput[] = [{ name: "diagnostic-report.json", content: reportJson }];

  const includeLogs = options.includeLogs !== false;
  if (includeLogs) {
    const reportBytes = Buffer.byteLength(reportJson, "utf8");
    const logBudget = Math.max(0, MAX_DIAGNOSTIC_ZIP_BYTES - reportBytes - 64 * 1024);
    if (logBudget > 1024) {
      const sidecarCap = Math.min(MAX_SIDECAR_LOG_TAIL_BYTES, Math.floor(logBudget * 0.65));
      const panicCap = Math.min(MAX_PANIC_LOG_TAIL_BYTES, Math.floor(logBudget * 0.35));
      const { sidecarLog, panicLog } = await collectRedactedLogTails({
        paths: options.paths,
        workspaceHome: options.workspaceHome,
        redactionContext: options.redactionContext,
        maxSidecarBytes: sidecarCap,
        maxPanicBytes: panicCap,
      });
      if (sidecarLog !== null) {
        entries.push({
          name: "redacted-sidecar.log",
          content: truncateTailUtf8(sidecarLog, sidecarCap),
        });
      }
      if (panicLog !== null) {
        entries.push({
          name: "redacted-panic.log",
          content: truncateTailUtf8(panicLog, panicCap),
        });
      }
    }
  }

  let zipBytes = buildZipArchive(entries, (options.now ?? (() => new Date()))());
  if (zipBytes.byteLength > MAX_DIAGNOSTIC_ZIP_BYTES) {
    // Fallback to report-only archive if logs ever pushed compressed output above 2 MiB.
    zipBytes = buildZipArchive([entries[0]!], (options.now ?? (() => new Date()))());
    entries.splice(1);
  }
  if (zipBytes.byteLength > MAX_DIAGNOSTIC_ZIP_BYTES) {
    throw new Error("Diagnostic archive exceeds the 2 MiB export limit");
  }

  const sha256 = createHash("sha256").update(zipBytes).digest("hex");
  return {
    report,
    zipBytes,
    sha256,
    entries: entries.map((e) => e.name),
  };
}
