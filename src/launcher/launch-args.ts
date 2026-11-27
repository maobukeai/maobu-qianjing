import { dirname, join } from "node:path";
import type { CookieRecord, LaunchInfo, LaunchPersona, Profile, ProxySpec } from "../types.ts";
import { ALIASMODE_CHROMIUM_WINDOW_LABEL } from "../aliasmode-chromium.ts";

/** Proxied profiles keep WebRTC on the proxy; direct ones stay on the default route (a system VPN). */
export function webRtcPolicy(profile: Profile): string {
  return profile.proxy ? "disable_non_proxied_udp" : "default_public_interface_only";
}

export function needsProxyRelay(profile: Profile): boolean {
  return !!profile.proxy && (
    profile.proxy.type === "socks5"
    || ((profile.proxy.type === "http" || profile.proxy.type === "https") && !!profile.proxy.user)
  );
}

export function proxyRelayUpstream(proxy: ProxySpec): {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  user: string;
  pass: string;
} {
  return {
    type: proxy.type === "socks5" ? "socks5" : proxy.type === "https" ? "https" : "http",
    host: proxy.host,
    port: Number(proxy.port),
    user: proxy.user,
    pass: proxy.pass,
  };
}

export function supportsFirefoxHost(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    || (platform === "linux" && arch === "x64")
    || (platform === "win32" && arch === "x64");
}

export function firefoxHelperBinaryPaths(binaryPath: string): string[] {
  if (process.platform !== "darwin") return [];
  const helper = (app: string, executable: string) => join(dirname(binaryPath), app, "Contents", "MacOS", executable);
  return [
    helper("plugin-container.app", "plugin-container"),
    // Headed windows start a GPU process; media playback starts the media plugin helper.
    helper("gpu-helper.app", "AliasMode GPU Helper"),
    helper("media-plugin-helper.app", "AliasMode Media Plugin Helper"),
  ];
}

/**
 * Profile fields a browser takes at launch. Edits to them while it runs are saved and apply at
 * the next start; the running browser and its identity checks keep the launched values.
 */
export const LAUNCH_PERSONA_KEYS = [
  "engine", "chromiumRuntime", "firefox", "hardware", "ua", "platformOs", "platform", "proxy", "proxyError",
  "timezone", "locale", "screenWidth", "screenHeight", "displayScale", "fingerprintSeed", "extensions",
] as const satisfies readonly (keyof LaunchPersona)[];

export function launchPersona(profile: Profile): LaunchPersona {
  const persona: Record<string, unknown> = {};
  for (const key of LAUNCH_PERSONA_KEYS) {
    if (profile[key] !== undefined) persona[key] = structuredClone(profile[key]);
  }
  return persona as LaunchPersona;
}

/** The profile as its running browser was launched: stored values with the launch-time identity. */
export function launchedProfile(profile: Profile, launch: Pick<LaunchInfo, "persona"> | null | undefined): Profile {
  if (!launch?.persona) return profile;
  const launched: Record<string, unknown> = { ...profile };
  for (const key of LAUNCH_PERSONA_KEYS) {
    if (launch.persona[key] === undefined) delete launched[key];
    else launched[key] = structuredClone(launch.persona[key]);
  }
  return launched as unknown as Profile;
}

/**
 * Saved edits the running browser does not have yet. The account platform only picks the first
 * page at launch, so it never needs a restart.
 */
export function launchIdentityChanged(profile: Profile, launch: Pick<LaunchInfo, "persona"> | null | undefined): boolean {
  if (!launch?.persona) return false;
  const value = (v: unknown) => JSON.stringify(v === undefined || v === "" || (Array.isArray(v) && !v.length) ? null : v);
  return LAUNCH_PERSONA_KEYS.some((key) => key !== "platform" && value(profile[key]) !== value(launch.persona![key]));
}

export function cookieIsCurrent(c: CookieRecord): boolean {
  const nowSec = Date.now() / 1000;
  const expires = Number(c.expires);
  return c.expires === undefined || expires < 0 || expires > nowSec;
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function splitLaunchUrls(launchArgs: string[]): { chromeArgs: string[]; startupUrls: string[] } {
  const chromeArgs: string[] = [];
  const startupUrls: string[] = [];
  for (const arg of launchArgs) {
    if (isHttpUrl(arg)) startupUrls.push(arg);
    else chromeArgs.push(arg);
  }
  return { chromeArgs, startupUrls };
}

const AUTOMATION_RUNTIME_LAUNCH_ARGS = new Set([
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--no-first-run",
  "--disable-features=BackForwardCache",
  "--disk-cache-size=1",
  "--media-cache-size=1",
  "--v8-cache-options=none",
  "--disable-gpu-shader-disk-cache",
  "--js-flags=--max-old-space-size=512",
  "--memory-pressure-off",
  // The automation CDP client connects to the debug port over a WebSocket;
  // Chromium >=111 rejects that connection unless the origin is permitted, so the
  // caller passes --remote-allow-origins=* (also a zendriver built-in default). It
  // only governs the DevTools endpoint's Origin check — not identity/proxy/storage.
  "--remote-allow-origins=*",
  // Suppresses the WebAuthn/passkey prompt that otherwise interrupts the automated
  // X login. JS-visible but a deliberate, long-standing Automation trade-off.
  "--disable-webauthn",
]);

/**
 * Only non-identity arguments required by the AdsPower-compatible caller may
 * cross the API. Chromium has too many aliases for a safe denylist: arbitrary
 * switches can replace proxy, profile dir, fingerprint, extensions, locale,
 * WebRTC policy, headless mode, or security settings.
 */
export function validateForwardedLaunchArgs(args: string[]): string[] {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const arg of args) {
    // Any `--<client>-launcher-pid=<pid>` is an inert ownership marker the
    // calling automation reads back from the chrome command line.
    if (AUTOMATION_RUNTIME_LAUNCH_ARGS.has(arg) || /^--[a-z0-9-]+-launcher-pid=[1-9]\d*$/.test(arg)) accepted.push(arg);
    else rejected.push(arg);
  }
  if (rejected.length) {
    throw new Error(
      `unsafe launch_args rejected: ${rejected.join(", ")}. ` +
      "Only http(s) startup URLs, approved Automation runtime flags, and --<client>-launcher-pid=<pid> are accepted.",
    );
  }
  return accepted;
}

const TELEGRAM_PLATFORM_ALIASES = new Set(["telegram.org", "telegram", "web.telegram.org"]);

/** Shared platform classification for routing and Telegram's no-concurrent-use safety guard. */
export function isTelegramPlatform(platform: string | undefined): boolean {
  return TELEGRAM_PLATFORM_ALIASES.has((platform || "").trim().toLowerCase());
}

/**
 * Home page to open as the browser's first tab for an account's platform, so a
 * launched profile lands straight on its app. Returns null for unknown/blank
 * platforms — those keep the browser's default new-tab page.
 */
export function platformHomeUrl(platform: string | undefined, telegramClient: "a" | "k" = "k"): string | null {
  const p = (platform || "").trim().toLowerCase();
  if (p === "x.com" || p === "x" || p === "twitter" || p === "twitter.com") return "https://x.com/home";
  if (p === "instagram" || p === "instagram.com" || p === "www.instagram.com") return "https://www.instagram.com/";
  if (p === "facebook" || p === "facebook.com" || p === "www.facebook.com") return "https://www.facebook.com/";
  if (p === "tiktok" || p === "tiktok.com" || p === "www.tiktok.com") return "https://www.tiktok.com/";
  if (p === "reddit" || p === "reddit.com" || p === "www.reddit.com") return "https://www.reddit.com/";
  if (isTelegramPlatform(p)) return `https://web.telegram.org/${telegramClient}/`;
  if (p === "linkedin.com" || p === "linkedin") return "https://www.linkedin.com/feed/";
  if (p === "youtube.com" || p === "youtube") return "https://www.youtube.com/";
  if (p === "threads.com" || p === "threads.net" || p === "threads") return "https://www.threads.com/";
  if (p === "pinterest.com" || p === "pinterest") return "https://www.pinterest.com/";
  if (p === "snapchat.com" || p === "snapchat") return "https://www.snapchat.com/web";
  if (p === "discord.com" || p === "discord") return "https://discord.com/app";
  if (p === "twitch.tv" || p === "twitch") return "https://www.twitch.tv/";
  if (p === "gmail.com" || p === "gmail") return "https://mail.google.com/";
  if (p === "amazon.com" || p === "amazon") return "https://www.amazon.com/";
  if (p === "ebay.com" || p === "ebay") return "https://www.ebay.com/";
  if (p === "etsy.com" || p === "etsy") return "https://www.etsy.com/";
  return null;
}

/**
 * The number an operator sees for a profile: the custom NO. they set, falling
 * back to the store serial (SQLite rowid). Null only when neither is known.
 */
export function profileDisplayNo(customNo: string | undefined, serial: number | null): string | null {
  const custom = (customNo ?? "").trim();
  if (custom) return custom;
  return serial != null ? String(serial) : null;
}

/** The window-title prefix that identifies a profile: `<name> · #<no> — `. */
export function buildWindowLabel(name: string, serial: number | string | null): string {
  const n = (name || "").trim() || "profile";
  return serial != null && serial !== "" ? `${n} · #${serial} — ` : `${n} — `;
}

export interface WindowLabelCapability {
  mode: "native" | "script" | "unavailable";
  reason: string;
}

/** Describe how window labeling works for a given host OS and browser engine. */
export function describeWindowLabelCapability(
  hostPlatform: NodeJS.Platform,
  profile: Pick<Profile, "engine" | "chromiumRuntime">,
): WindowLabelCapability {
  if (profile.engine === "firefox") {
    return { mode: "native", reason: "Camoufox applies the window label natively without touching page title" };
  }
  if (profile.chromiumRuntime && ALIASMODE_CHROMIUM_WINDOW_LABEL) {
    return { mode: "native", reason: "AliasMode Chromium 155 applies --aliasmode-window-label natively" };
  }
  if (hostPlatform === "darwin") {
    return {
      mode: "unavailable",
      reason: "macOS CloakBrowser has no native window-label switch and avoids page-visible title scripts; use AliasMode Chromium 155 or Camoufox for labeled windows",
    };
  }
  return { mode: "script", reason: "CloakBrowser uses an isolated window-title label script" };
}

/**
 * In-page script that keeps `label` prefixed on the window/tab title. The
 * platform (X is an SPA) rewrites document.title constantly, so a one-shot set
 * won't stick: re-apply on every title mutation, plus a slow interval as a
 * belt-and-suspenders. The `startsWith(label)` guard makes our own write a
 * no-op so the MutationObserver can't loop. Self-contained (serialized to the
 * page) and fully defensive — it must never throw into the host page.
 */
export function buildLabelScript(label: string): string {
  const L = JSON.stringify(label);
  return `(() => { try {
    var L = ${L};
    var apply = function(){ try { if (document.title.indexOf(L) !== 0) document.title = L + document.title; } catch(e){} };
    var start = function(){
      apply();
      try {
        var el = document.querySelector('title') || document.head || document.documentElement;
        if (el) new MutationObserver(apply).observe(el, { subtree: true, childList: true, characterData: true });
      } catch(e){}
      try { setInterval(apply, 3000); } catch(e){}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  } catch(e){} })();`;
}
