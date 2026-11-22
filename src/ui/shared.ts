import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Launcher } from "../../launcher.ts";
import type { ProfileStore } from "../../store.ts";
import type { AppConfigStore } from "../../app-config.ts";
import type { StatePaths } from "../../paths.ts";
import type { ChromiumRuntime, FingerprintVerdict, Profile, CookieRecord, ProxySpec } from "../../types.ts";
import type { ProxyCheckResult } from "../../proxy-check.ts";
import type { discoverLocalProxies } from "../../network-diagnostics.ts";
import type { RuntimeInventoryDeployment } from "../../runtime-inventory.ts";
import type { LocalAssistantService } from "../../local-assistant.ts";
import type { FetchLike } from "../../geoip.ts";
import {
  parseStrictResolution,
  parseStrictPlatformOs,
  parseStrictTimezone,
  parseStrictCustomNo,
  parseStrictCores,
  parseStrictSeed,
  parseStrictProxy,
} from "../../parse.ts";
import type { ExtensionFetch } from "../../extensions.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "../../profile-id.ts";
import { normalizeProfileNotes } from "../../profile-notes.ts";
import type { ProfilePackagePreviewStore } from "../../profile-package.ts";
import { normalizeProfileTags } from "../../profile-tags.ts";
import { normalizeProfileLocale } from "../../profile-locale.ts";
import { proxyHostPort, proxyLegacyString } from "../../proxy.ts";
import { convertMobilePersonaToDesktop, editedProfileHardware, isMobileUserAgent } from "../../fingerprint.ts";
import { firefoxGraphicsRenderer, setFirefoxScreen, syncFirefoxTimezone } from "../../firefox-config.ts";
import type { ScriptLibrary, ScriptSupervisor } from "../../scripts.ts";
import type { PythonRuntime } from "../../python-runtime.ts";
import type { WorkspaceManagement } from "../../workspace-management.ts";
import type { UiEventBus } from "./events-bus.ts";
import type { AppSettingsStore } from "../../app-settings.ts";
import type { MetricsService } from "../metrics/metrics-service.ts";
import type { ResourcePolicyStore } from "../metrics/resource-policy-store.ts";
import { buildFingerprintImportComparison, type FingerprintImportComparison } from "../../fingerprint-import-comparison.ts";
import type { ImportOverrides } from "../../inbox.ts";

/** Readiness metadata supplied by the desktop parent process. */
export interface UiHealthMetadata {
  version: string;
  root: string;
  instance: string;
}

/** Redacted, dashboard-safe view of a profile + its live status. */
export interface UiProfile {
  id: string;
  name: string;
  /** Browser family. Legacy profiles without a value are Chromium. */
  engine: "chromium" | "firefox";
  /** Present only for the opt-in Chromium 155 beta. */
  chromiumRuntime?: ChromiumRuntime;
  group: string;
  /** Saved assignments, used by the extension library and replacement preview. */
  extensions: string[];
  /** Account platform: "x.com", "telegram.org", or "" (none). */
  platform: string;
  /** Free-form custom tags. */
  tags: string[];
  /** Operator memo/notes (<= 500 chars / 2048 bytes). */
  notes: string;
  /** "host:port" only — never user/pass. Null when the profile has no proxy. */
  proxy: string | null;
  /** Safe validation message for a quarantined legacy proxy. */
  proxyError?: string;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  mobilePersona?: boolean;
  /** Whether a 2FA secret is stored (drives the row's authenticator button). */
  has2fa: boolean;
  /** Store serial (SQLite rowid) — the roster's default "No." for this profile. */
  serial: number | null;
  /** Creation time, ms. 0 for rows imported before the column existed. */
  createdAt: number;
  /** Most recent launch, ms. 0 when this profile has never been opened here. */
  lastOpenAt: number;
  /** Operator-chosen "custom NO.", or "" when the serial is used instead. */
  customNo: string;
  running: boolean;
  /** The open browser runs with an older proxy or fingerprint than the saved one. */
  restartPending?: boolean;
  /** Cookies added while the profile was closed; the next start sets them. */
  pendingCookieCount?: number;
  debugPort?: number;
  startedAt?: number;
  /** Legacy stored verdict for older clients. Coverage may be incomplete; new UI uses fpImportComparison. */
  fpVerdict: FingerprintVerdict | null;
  /** Legacy capture text. The validated display instant lives in fpImportComparison. */
  fpCapturedAt: string;
  /** Redacted historical import comparison, recomputed from saved samples rather than a legacy verdict. */
  fpImportComparison: FingerprintImportComparison | null;
}

export interface UiRuntimeOptions {
  assistant?: LocalAssistantService;
  runtimeInventory?: RuntimeInventoryDeployment;
  discoverLocalProxies?: typeof discoverLocalProxies;
  workspaceManagement?: WorkspaceManagement;
  scripts?: {
    library: ScriptLibrary;
    runner: ScriptSupervisor;
    nonce: string;
    python?: PythonRuntime;
  };
  appConfig?: AppConfigStore;
  paths?: StatePaths;
  health?: UiHealthMetadata | null;
  timezoneFetch?: FetchLike;
  proxyCheck?: (proxy: ProxySpec) => Promise<ProxyCheckResult>;
  extensionFetch?: ExtensionFetch;
  setCookies?: (ws: string, cookies: CookieRecord[]) => Promise<void>;
  events?: UiEventBus;
  /** Optional SSE hook for Wave 4 companion services. */
  emitEvent?: (type: string, payload: unknown) => void;
  /** Optional preview store override for `.mqprofile` encrypted package routes. */
  packagePreviewStore?: ProfilePackagePreviewStore;
  metrics?: MetricsService;
  resourcePolicies?: ResourcePolicyStore;
  appSettings?: AppSettingsStore;
  metricsHeartbeatIntervalMs?: number;
}

/**
 * Below 2 GB free Chromium gives sites no new storage and below 1 GB it evicts their data;
 * Firefox evicts the least recently used sites when the disk runs low. 5 GB warns before that.
 */
export const LOW_DISK_SPACE_BYTES = 5 * 1024 ** 3;

export const APPLICATION_ROOT = resolve(import.meta.dir, "..", "..");
let appVersionPromise: Promise<string> | null = null;

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function profileEngine(profile: unknown): "chromium" | "firefox" {
  return typeof profile === "object" && profile !== null && "engine" in profile && profile.engine === "firefox"
    ? "firefox"
    : "chromium";
}

export function openResponse(profile: unknown, result: { port?: number; warning?: string }): Response {
  const engine = profileEngine(profile);
  return Response.json({
    ok: true,
    ...(engine === "firefox"
      ? { engine, capabilities: { cdp: false, pdf: false, chromeExtensions: false } }
      : { port: result.port }),
    ...(result.warning === undefined ? {} : { warning: result.warning }),
  });
}

/**
 * Map the store into redacted UiProfiles joined with running state. Status comes
 * from the launches table, which is authoritative for every browser THIS manager
 * started — campaign-launched or dashboard-launched alike (one manager per box).
 */
export function listUiProfiles(store: ProfileStore): UiProfile[] {
  const launches = new Map(store.listLaunches().map((l) => [l.profileId, l]));
  const meta = store.listProfileMeta();
  const pendingCookies = store.pendingCookieCounts();
  return store.listProfiles().map((p) => {
    const l = launches.get(p.id);
    return {
      id: p.id,
      name: p.name,
      engine: profileEngine(p),
      ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
      group: p.group,
      extensions: p.extensions ?? [],
      platform: p.platform ?? "",
      tags: p.tags ?? [],
      notes: p.notes ?? "",
      proxy: p.proxy ? proxyHostPort(p.proxy) : null,
      ...(p.proxyError ? { proxyError: p.proxyError } : {}),
      timezone: p.timezone,
      cookieCount: p.cookies.length,
      seeded: p.seeded,
      screen: `${p.screenWidth}x${p.screenHeight}`,
      has2fa: !!(p.twofa && p.twofa.trim()),
      serial: meta.get(p.id)?.serial ?? null,
      createdAt: meta.get(p.id)?.createdAt ?? 0,
      lastOpenAt: meta.get(p.id)?.lastOpenAt ?? 0,
      customNo: p.customNo ?? "",
      mobilePersona: isMobileUserAgent(p.ua),
      running: !!l,
      ...(l && launchIdentityChanged(p, l) ? { restartPending: true } : {}),
      ...(pendingCookies.get(p.id) ? { pendingCookieCount: pendingCookies.get(p.id) } : {}),
      ...(profileEngine(p) === "chromium" ? { debugPort: l?.debugPort } : {}),
      startedAt: l?.startedAt,
      fpVerdict: p.fpVerdict ?? null,
      fpCapturedAt: p.fpObserved?.capturedAt ?? "",
      fpImportComparison: buildFingerprintImportComparison(p.fpExpected, p.fpObserved),
    };
  });
}

// Imported late-bound type helper to avoid circular evaluation if needed; direct import from launcher.ts is safe:
import { launchIdentityChanged } from "../../launcher.ts";

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Blocks cross-origin/cross-site mutations on non-JSON POST routes (empty actions, multipart uploads). */
export function rejectCrossOriginMutation(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return Response.json({ ok: false, error: "cross-origin requests are forbidden" }, { status: 403 });
  }
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return Response.json({ ok: false, error: "cross-origin requests are forbidden" }, { status: 403 });
  }
  return null;
}

/** Rejects mutating JSON endpoints when Content-Type is not application/json or request is cross-origin. */
export function rejectUntrustedJsonMutation(req: Request): Response | null {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ ok: false, error: "application/json is required" }, { status: 415 });
  }
  return rejectCrossOriginMutation(req);
}

/** Safely decodes a URL path `:id` parameter and validates safe profile-id syntax, returning 400 on URIError or bad id. */
export function safeDecodeIdParam(raw: string): { ok: true; id: string } | { ok: false; response: Response } {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return { ok: false, response: Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 }) };
  }
  if (!isSafeProfileId(id)) {
    return { ok: false, response: Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 }) };
  }
  return { ok: true, id };
}

export async function readLatestDiagnose(reportsRoot = "reports"): Promise<unknown | null> {
  try {
    const f = Bun.file(join(reportsRoot, "diagnose-latest.json"));
    if (!(await f.exists())) return null;
    return await f.json();
  } catch {
    return null;
  }
}

function normalizeCookieDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  if (!input || /[\x00-\x20\x7f]/.test(input)) return null;
  const includeSubdomains = input.startsWith(".");
  const candidate = includeSubdomains ? input.slice(1) : input;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return null;
    return includeSubdomains ? `.${hostname}` : hostname;
  } catch {
    return null;
  }
}

/** One cookie from the Add cookie form, or the reason it is invalid. */
export function singleCookie(body: Record<string, unknown>): CookieRecord | string {
  const name = body.name;
  const value = body.value;
  const domain = normalizeCookieDomain(body.domain);
  const path = body.path === undefined ? "/" : body.path;
  if (typeof name !== "string" || !name || /[\s\x00-\x1f\x7f;=]/.test(name)) return "cookie name is invalid";
  if (typeof value !== "string" || /[\x00-\x1f\x7f;]/.test(value)) return "cookie value is invalid";
  if (!domain) return "cookie domain is invalid";
  if (typeof path !== "string" || !path.startsWith("/")) return "cookie path must start with /";
  return {
    name,
    value,
    domain,
    path,
    expires: Math.floor(Date.now() / 1000) + 31536000,
    secure: true,
    sameSite: "Lax",
  };
}

export const SHELL_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

function shellLanguagePath(paths?: StatePaths): string | null {
  if (!paths?.root) return null;
  return join(paths.root, "shell.json");
}

/** The saved shell language, or null when the user never chose one (the UI then follows the system language). */
export function readShellLanguage(paths?: StatePaths): string | null {
  try {
    const file = shellLanguagePath(paths);
    if (!file) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { language?: unknown };
    if (typeof raw.language === "string" && SHELL_LANGUAGE_PATTERN.test(raw.language)) {
      return raw.language;
    }
  } catch {
    // Missing or corrupt file: nothing chosen yet.
  }
  return null;
}

export function writeShellLanguage(paths: StatePaths | undefined, language: string): void {
  if (!SHELL_LANGUAGE_PATTERN.test(language)) throw new Error(`Invalid language tag: ${language}`);
  const file = shellLanguagePath(paths);
  if (!file) throw new Error("Shell language storage is unavailable");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ language })}\n`, "utf8");
}

export function proxyCheckView(result: ProxyCheckResult): ProxyCheckResult {
  return {
    status: result.status,
    attempts: result.attempts,
    successes: result.successes,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.ip ? { ip: result.ip } : {}),
    ...(result.country ? { country: result.country } : {}),
    ...(result.region ? { region: result.region } : {}),
    ...(result.city ? { city: result.city } : {}),
    ...(result.rotating !== undefined ? { rotating: result.rotating } : {}),
    ...(result.exitComparison !== undefined ? { exitComparison: result.exitComparison } : {}),
  };
}

export function appVersion(): Promise<string> {
  if (!appVersionPromise) {
    appVersionPromise = (async () => {
      try {
        const file = Bun.file(join(APPLICATION_ROOT, "VERSION.txt"));
        if (!(await file.exists())) return "dev";
        return (await file.text()).trim() || "dev";
      } catch {
        return "dev";
      }
    })();
  }
  return appVersionPromise;
}

function storedHardware(p: Profile): { gpu?: string; cores?: number } | undefined {
  const gpu = p.firefox ? firefoxGraphicsRenderer(p) : undefined;
  const cores = p.hardware?.cores ?? p.firefox?.config["navigator.hardwareConcurrency"];
  const hardware = {
    ...(typeof gpu === "string" && gpu ? { gpu } : {}),
    ...(typeof cores === "number" ? { cores } : {}),
  };
  return Object.keys(hardware).length ? hardware : undefined;
}

export function profileEditView(p: Profile) {
  const px = p.proxy;
  const proxy = px ? proxyLegacyString(px) : "";
  const conversion = isMobileUserAgent(p.ua) ? convertMobilePersonaToDesktop(p) : null;
  return {
    id: p.id,
    name: p.name,
    engine: profileEngine(p),
    ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
    ...(storedHardware(p) ? { hardware: storedHardware(p) } : {}),
    group: p.group,
    platform: p.platform ?? "",
    proxyType: px?.type ?? "http",
    proxy,
    ...(p.proxyError ? { proxyError: p.proxyError } : {}),
    username: p.username,
    password: p.password,
    email: p.email ?? "",
    emailPassword: p.emailPassword ?? "",
    twofa: p.twofa,
    resolution: `${p.screenWidth}*${p.screenHeight}`,
    extensions: p.extensions ?? [],
    tags: (p.tags ?? []).join(", "),
    notes: p.notes ?? "",
    customNo: p.customNo ?? "",
    platformOs: p.platformOs ?? "",
    timezone: p.timezone,
    ...(p.timezoneManual ? { timezoneManual: true } : {}),
    locale: p.locale ?? "",
    cores: p.hardware ? String(p.hardware.cores) : "",
    fingerprintSeed: String(p.fingerprintSeed),
    cookieCount: p.cookies.length,
    seeded: p.seeded,
    mobilePersona: !!conversion,
    ...(conversion ? {
      desktopConversion: {
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}*${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      },
    } : {}),
  };
}

/** Safe creation inputs only: never reuse an identity, account, proxy or session. */
export function reusableProfileView(p: Profile) {
  if (p.engine !== undefined && p.engine !== "chromium" && p.engine !== "firefox") return null;
  const engine = profileEngine(p);
  if (p.chromiumRuntime !== undefined && (engine !== "chromium" || p.chromiumRuntime !== "aliasmode")) return null;
  if (typeof p.name !== "string" || p.name.length > 4096 || typeof p.group !== "string" || p.group.length > 4096) return null;
  if (p.platform !== undefined && typeof p.platform !== "string") return null;
  const platform = p.platform?.trim().toLowerCase() ?? "";
  if (platform.length > 253 || platform && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(platform)) {
    return null;
  }
  try {
    const platformOs = parseStrictPlatformOs(p.platformOs ?? "");
    const screen = parseStrictResolution(`${p.screenWidth}x${p.screenHeight}`);
    return {
      sourceId: p.id,
      name: p.name,
      group: p.group,
      engine,
      ...(engine === "chromium" ? { chromiumRuntime: p.chromiumRuntime ?? "cloakbrowser" } : {}),
      platformOs,
      screen: `${screen.width}x${screen.height}`,
      platform,
    };
  } catch {
    return null;
  }
}

export function restartRequired(store: ProfileStore, id: string): { restartRequired?: true } {
  const launch = store.getLaunch(id);
  const profile = launch ? store.getProfile(id) : null;
  return profile && launchIdentityChanged(profile, launch) ? { restartRequired: true } : {};
}

/**
 * Apply a partial field set onto a profile in place. Only keys present in `set`
 * change — everything else (cookies, fingerprint seed, seeded) is preserved.
 */
export function applyEdits(p: Profile, set: Record<string, unknown>): boolean {
  let proxyChanged = false;
  if ("name" in set) p.name = String(set.name ?? "");
  if ("group" in set) p.group = String(set.group ?? "");
  if ("platform" in set) p.platform = String(set.platform ?? "");
  if ("username" in set) p.username = String(set.username ?? "");
  if ("password" in set) p.password = String(set.password ?? "");
  if ("email" in set) p.email = String(set.email ?? "");
  if ("emailPassword" in set) p.emailPassword = String(set.emailPassword ?? "");
  if ("twofa" in set) p.twofa = String(set.twofa ?? "");
  if ("resolution" in set) {
    const r = parseStrictResolution(set.resolution);
    if (profileEngine(p) === "firefox" && (p.screenWidth !== r.width || p.screenHeight !== r.height)) {
      setFirefoxScreen(p, r.width, r.height);
    }
    p.screenWidth = r.width;
    p.screenHeight = r.height;
  }
  if ("platformOs" in set) {
    const platformOs = parseStrictPlatformOs(set.platformOs);
    if (profileEngine(p) === "firefox" && platformOs !== (p.platformOs ?? "")) {
      throw new Error("Firefox operating system cannot be changed");
    }
    p.platformOs = platformOs;
  }
  if ("locale" in set) p.locale = normalizeProfileLocale(set.locale) ?? p.locale;
  if ("timezone" in set) {
    p.timezone = parseStrictTimezone(set.timezone);
    if (p.timezone) p.timezoneManual = true;
    else delete p.timezoneManual;
    syncFirefoxTimezone(p);
  }
  if ("fingerprintSeed" in set) p.fingerprintSeed = parseStrictSeed(set.fingerprintSeed);
  if ("cores" in set) {
    const hardware = editedProfileHardware(p, parseStrictCores(set.cores));
    if (hardware) p.hardware = hardware;
    else delete p.hardware;
  }
  if ("proxy" in set) {
    const nextProxy = parseStrictProxy(set.proxyType ?? p.proxy?.type ?? "http", set.proxy);
    const previousProxy = p.proxy;
    proxyChanged = !!p.proxyError ||
      previousProxy?.type !== nextProxy?.type ||
      previousProxy?.host !== nextProxy?.host ||
      previousProxy?.port !== nextProxy?.port ||
      previousProxy?.user !== nextProxy?.user ||
      previousProxy?.pass !== nextProxy?.pass;
    p.proxy = nextProxy;
    delete p.proxyError;
  }
  if ("extensions" in set) {
    const extensions = Array.isArray(set.extensions) ? set.extensions.map(String) : [];
    if (profileEngine(p) === "firefox" && extensions.length > 0) {
      throw new Error("Chrome extensions are unavailable for Firefox profiles");
    }
    p.extensions = extensions;
  }
  if ("tags" in set) p.tags = normalizeProfileTags(set.tags);
  if ("notes" in set) p.notes = normalizeProfileNotes(set.notes === null || set.notes === undefined ? "" : set.notes);
  if ("customNo" in set) p.customNo = parseStrictCustomNo(set.customNo);
  return proxyChanged;
}

export function importOverridesFromForm(form: FormData): ImportOverrides {
  const override: ImportOverrides = {};
  const group = form.get("group");
  if (typeof group === "string" && group.trim()) override.group = group.trim();
  const platform = form.get("platform");
  if (typeof platform === "string" && platform.trim()) override.platform = platform.trim();
  return override;
}
