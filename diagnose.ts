/**
 * Diagnostics: launch imported profiles and collect hard evidence that the
 * CloakBrowser setup is sound, so the report can be eyeballed (or forwarded)
 * to confirm everything before any real campaign traffic.
 *
 * Per profile it gathers, over CDP:
 *   - egress IP + geo (is the proxy actually in use? not bypassed?)
 *   - user agent + UA Client Hints (and whether they agree)
 *   - canvas / WebGL / audio fingerprints (unique per profile? stable on relaunch?)
 *   - WebRTC candidate IPs (real-IP leak?)
 *   - timezone / locale / screen
 *   - x.com login state (did the injected cookies land?)
 *
 * The collection shell (CDP + network) is deliberately thin and untested here;
 * the verdict logic lives in `analyze()`, which is pure and unit-tested. The
 * report intentionally omits cookie values and passwords — but it DOES contain
 * proxy hosts and egress IPs, so treat it as sensitive.
 */

import type { Profile } from "./types.ts";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints, type EgressInfo } from "./egress.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";
import { canonicalIp, sameIp } from "./ip.ts";

// Preserve diagnose.ts's existing public type surface while sharing the parser.
export type { EgressInfo } from "./egress.ts";

export interface FingerprintSample {
  userAgent?: string;
  uaDataPlatform?: string;
  uaDataBrands?: string[];
  uaDataPlatformVersion?: string;
  uaFullVersionList?: string[];
  uaFullVersion?: string;
  platform?: string;
  language?: string;
  languages?: string[];
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screen?: { width: number; height: number; availWidth: number; availHeight: number; availLeft?: number; availTop?: number; colorDepth: number; dpr: number };
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  audioHash?: string;
  webgpu?: { available: boolean; vendor?: string; architecture?: string; description?: string; device?: string };
  clientRects?: { hash?: string; width?: number; height?: number; consistent?: boolean };
  mediaDevices?: { count: number; audioInput: number; videoInput: number; audioOutput: number; labelsExposed: boolean };
  speechVoices?: { count: number; defaultVoice?: string; hash?: string };
  leakIndicators?: { webrtcApiPresent: boolean; rtcIceGathererPresent: boolean; connectionType?: string };
  errors?: Record<string, string>;
}

export interface LoginProbeConfig {
  selectors?: {
    loggedIn?: string[];
    loggedOut?: string[];
    loggedOutUrlPattern?: string;
  };
}

export interface LoginInfo {
  loggedIn: boolean;
  loggedOut: boolean;
  url?: string;
  title?: string;
}

export interface ProfileReport {
  profileId: string;
  ok: boolean;
  error?: string;
  proxyConfigured: { host: string; port: string } | null;
  /** The profile's stored screen, compared against what the browser reports. */
  screenConfigured: { width: number; height: number } | null;
  egress: EgressInfo | null;
  fingerprint: FingerprintSample | null;
  /** Second sample after a relaunch, when --relaunch is used. */
  fingerprintRelaunch?: FingerprintSample | null;
  relaunchRequested?: boolean;
  webrtcIps?: string[];
  login: LoginInfo | null;
}

export interface DiagnoseReport {
  generatedAt: number;
  baselineRealIp?: string;
  profiles: ProfileReport[];
  analysis: Analysis;
}

export interface Analysis {
  total: number;
  okCount: number;
  /** `bypassed` is a legacy response key for equal exit addresses, not proof of the route taken. */
  proxy: { ok: string[]; bypassed: string[]; matchesConfiguredHost: string[]; noEgress: string[]; inconclusive: string[]; notConfigured: string[] };
  webrtcLeaks: string[];
  webrtcCoverage: { checked: string[]; inconclusive: string[]; notApplicable: string[] };
  fingerprintCollisions: { canvas: Collision[]; audio: Collision[]; webgl: Collision[]; clientRects: Collision[]; speechVoices: Collision[] };
  fingerprintCoverage: { canvas: string[]; audio: string[]; webgl: string[]; webgpu: string[]; clientRects: string[]; mediaDevices: string[]; speechVoices: string[] };
  leakIndicators: { webrtcExposed: string[]; webrtcApiActive: string[]; mediaLabelsExposed: string[]; dnsRiskProfiles: string[] };
  uaInconsistencies: { profileId: string; reason: string }[];
  unstableFingerprints: string[];
  stability: { checked: string[]; inconclusive: string[]; notRequested: string[] };
  login: { loggedIn: string[]; loggedOut: string[]; unknown: string[] };
  screenMismatches: { profileId: string; configured: string; seen: string }[];
  verdicts: string[];
}

export interface Collision {
  value: string;
  profiles: string[];
}

// ---------------------------------------------------------------------------
// Pure analysis — the tested core.
// ---------------------------------------------------------------------------

function dupes(pairs: { profileId: string; value?: string }[]): Collision[] {
  const byValue = new Map<string, string[]>();
  for (const { profileId, value } of pairs) {
    if (!value) continue;
    const list = byValue.get(value) ?? [];
    list.push(profileId);
    byValue.set(value, list);
  }
  return [...byValue.entries()].filter(([, ps]) => ps.length > 1).map(([value, profiles]) => ({ value, profiles }));
}

/** Infer the expected platform token CloakBrowser's UA-CH should report. */
function expectedPlatform(ua: string | undefined): string | null {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("mac os") || s.includes("macintosh")) return "macOS";
  if (s.includes("linux") && !s.includes("android")) return "Linux";
  if (s.includes("windows")) return "Windows";
  return null;
}

export function analyze(profiles: ProfileReport[], baselineRealIp?: string): Analysis {
  const baseline = baselineRealIp ? canonicalIp(baselineRealIp) : null;
  const a: Analysis = {
    total: profiles.length,
    okCount: profiles.filter((p) => p.ok).length,
    proxy: { ok: [], bypassed: [], matchesConfiguredHost: [], noEgress: [], inconclusive: [], notConfigured: [] },
    webrtcLeaks: [],
    webrtcCoverage: { checked: [], inconclusive: [], notApplicable: [] },
    fingerprintCollisions: { canvas: [], audio: [], webgl: [], clientRects: [], speechVoices: [] },
    fingerprintCoverage: { canvas: [], audio: [], webgl: [], webgpu: [], clientRects: [], mediaDevices: [], speechVoices: [] },
    leakIndicators: { webrtcExposed: [], webrtcApiActive: [], mediaLabelsExposed: [], dnsRiskProfiles: [] },
    uaInconsistencies: [],
    unstableFingerprints: [],
    stability: { checked: [], inconclusive: [], notRequested: [] },
    login: { loggedIn: [], loggedOut: [], unknown: [] },
    screenMismatches: [],
    verdicts: [],
  };

  for (const p of profiles) {
    // Compare observed exits. A shared VPN/NAT can give a working proxy and the
    // host the same exit, so equality cannot by itself prove a bypass.
    const egressIp = p.egress?.ip ? canonicalIp(p.egress.ip) : null;
    if (!p.proxyConfigured) {
      a.proxy.notConfigured.push(p.profileId);
    } else if (!egressIp) {
      a.proxy.noEgress.push(p.profileId);
    } else if (!baseline) {
      // Without the system-route baseline there is no exit comparison evidence.
      a.proxy.inconclusive.push(p.profileId);
    } else if (egressIp === baseline) {
      a.proxy.bypassed.push(p.profileId);
    } else {
      a.proxy.ok.push(p.profileId);
      if (sameIp(egressIp, p.proxyConfigured.host)) a.proxy.matchesConfiguredHost.push(p.profileId);
    }

    // Empty candidates can mean a disabled API, blocked STUN, timeout or probe
    // failure. None of those are evidence of a successful real-IP leak test.
    const candidates = (p.webrtcIps ?? []).map(canonicalIp).filter((ip): ip is string => !!ip);
    if (!p.proxyConfigured) a.webrtcCoverage.notApplicable.push(p.profileId);
    else if (!baseline || !candidates.length) a.webrtcCoverage.inconclusive.push(p.profileId);
    else {
      a.webrtcCoverage.checked.push(p.profileId);
      if (candidates.includes(baseline)) a.webrtcLeaks.push(p.profileId);
    }

    // UA vs UA-CH consistency.
    const fp = p.fingerprint;
    if (fp?.userAgent && fp.uaDataPlatform) {
      const want = expectedPlatform(fp.userAgent);
      if (want && fp.uaDataPlatform !== want) {
        a.uaInconsistencies.push({ profileId: p.profileId, reason: `UA implies ${want} but UA-CH platform is ${fp.uaDataPlatform}` });
      }
    }

    // Screen: the browser-reported resolution must match the spoofed value.
    const screen = p.fingerprint?.screen;
    if (screen && p.screenConfigured) {
      if (screen.width !== p.screenConfigured.width || screen.height !== p.screenConfigured.height) {
        a.screenMismatches.push({
          profileId: p.profileId,
          configured: `${p.screenConfigured.width}x${p.screenConfigured.height}`,
          seen: `${screen.width}x${screen.height}`,
        });
      }
    }

    // Login tally.
    if (p.login?.loggedIn) a.login.loggedIn.push(p.profileId);
    else if (p.login?.loggedOut) a.login.loggedOut.push(p.profileId);
    else a.login.unknown.push(p.profileId);

    // Compare only stable measured surfaces, not the versioned UA. A missing
    // value on either side is incomplete evidence, not a stable identity.
    if (p.fingerprintRelaunch === undefined && !p.relaunchRequested) a.stability.notRequested.push(p.profileId);
    else if (!p.fingerprintRelaunch || !fp) a.stability.inconclusive.push(p.profileId);
    else {
      const next = p.fingerprintRelaunch;
      const stableFields = ["canvasHash", "audioHash", "webglVendor", "webglRenderer", "platform", "hardwareConcurrency", "deviceMemory", "language", "timezone"] as const;
      const pairs: Array<[unknown, unknown]> = stableFields.map((field) => [fp[field], next[field]]);
      pairs.push([fp.languages?.join(","), next.languages?.join(",")]);
      if (fp.screen || next.screen) pairs.push([fp.screen ? `${fp.screen.width}*${fp.screen.height}` : undefined, next.screen ? `${next.screen.width}*${next.screen.height}` : undefined]);
      const present = (value: unknown) => value !== undefined && value !== null && value !== "";
      const comparable = pairs.filter(([left, right]) => present(left) && present(right));
      const missing = pairs.some(([left, right]) => present(left) !== present(right));
      if (!comparable.length || missing) a.stability.inconclusive.push(p.profileId);
      else a.stability.checked.push(p.profileId);
      if (comparable.some(([left, right]) => left !== right)) a.unstableFingerprints.push(p.profileId);
    }

    if (fp?.leakIndicators?.webrtcApiPresent) a.leakIndicators.webrtcApiActive.push(p.profileId);
    if (fp?.mediaDevices?.labelsExposed) a.leakIndicators.mediaLabelsExposed.push(p.profileId);
    if (p.proxyConfigured && (a.webrtcLeaks.includes(p.profileId) || a.proxy.bypassed.includes(p.profileId))) {
      a.leakIndicators.dnsRiskProfiles.push(p.profileId);
    }
  }
  a.leakIndicators.webrtcExposed = [...a.webrtcLeaks];

  // Cross-profile uniqueness (noise-based surfaces should differ per seed).
  a.fingerprintCollisions.canvas = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.canvasHash })));
  a.fingerprintCollisions.audio = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.audioHash })));
  a.fingerprintCollisions.webgl = dupes(
    profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.webglRenderer })),
  );
  a.fingerprintCollisions.clientRects = dupes(
    profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.clientRects?.hash })),
  );
  a.fingerprintCollisions.speechVoices = dupes(
    profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.speechVoices?.hash })),
  );
  a.fingerprintCoverage.canvas = profiles.filter((p) => !!p.fingerprint?.canvasHash).map((p) => p.profileId);
  a.fingerprintCoverage.audio = profiles.filter((p) => !!p.fingerprint?.audioHash).map((p) => p.profileId);
  a.fingerprintCoverage.webgl = profiles.filter((p) => !!p.fingerprint?.webglRenderer).map((p) => p.profileId);
  a.fingerprintCoverage.webgpu = profiles.filter((p) => p.fingerprint?.webgpu !== undefined).map((p) => p.profileId);
  a.fingerprintCoverage.clientRects = profiles.filter((p) => !!p.fingerprint?.clientRects?.hash).map((p) => p.profileId);
  a.fingerprintCoverage.mediaDevices = profiles.filter((p) => p.fingerprint?.mediaDevices !== undefined).map((p) => p.profileId);
  a.fingerprintCoverage.speechVoices = profiles.filter((p) => p.fingerprint?.speechVoices !== undefined).map((p) => p.profileId);

  // Verdicts: plain-language pass/fail lines for the summary.
  const v = a.verdicts;
  v.push(`${a.okCount}/${a.total} profiles launched and sampled`);
  if (a.proxy.bypassed.length) v.push(`⚠️  browser exit matches the system-route baseline on ${a.proxy.bypassed.length} profile(s): ${a.proxy.bypassed.join(", ")} — exit isolation is unconfirmed; a shared VPN/NAT exit does not prove proxy bypass`);
  if (a.proxy.inconclusive.length) v.push(`⚠️  proxy bypass could NOT be checked for ${a.proxy.inconclusive.length} profile(s) — this machine's real-IP baseline was unavailable; rerun with the baseline before trusting the proxy`);
  if (a.proxy.noEgress.length) v.push(`⚠️  no egress IP captured for ${a.proxy.noEgress.length} profile(s) — cannot confirm proxy`);
  if (a.proxy.ok.length) v.push(`✅ proxy egress differs from the host IP on ${a.proxy.ok.length} measured profile(s)`);
  if (a.proxy.notConfigured.length) v.push(`ℹ️  ${a.proxy.notConfigured.length} profile(s) have no independent proxy configured; system routing applies`);
  if (a.webrtcLeaks.length) v.push(`❌ WebRTC leaks real IP on: ${a.webrtcLeaks.join(", ")}`);
  else if (a.webrtcCoverage.checked.length) v.push(`✅ no baseline IP observed in WebRTC candidates on ${a.webrtcCoverage.checked.length} measured profile(s)`);
  if (a.webrtcCoverage.inconclusive.length) v.push(`⚠️  WebRTC real-IP leak check inconclusive on ${a.webrtcCoverage.inconclusive.length} profile(s): baseline or candidate evidence missing`);
  if (a.fingerprintCollisions.canvas.length) v.push(`❌ canvas fingerprint COLLISION across profiles: ${a.fingerprintCollisions.canvas.map((c) => c.profiles.join("+")).join("; ")}`);
  else if (a.fingerprintCoverage.canvas.length >= 2) v.push(`✅ canvas fingerprints unique across ${a.fingerprintCoverage.canvas.length} measured profiles`);
  else v.push(`⚠️  canvas uniqueness needs at least two measured profiles; ${a.fingerprintCoverage.canvas.length} available`);
  if (a.fingerprintCoverage.canvas.length >= 2 && a.fingerprintCoverage.canvas.length < a.total) v.push(`⚠️  canvas uniqueness is unmeasured on ${a.total - a.fingerprintCoverage.canvas.length} profile(s)`);
  if (a.unstableFingerprints.length) v.push(`❌ fingerprint changed across relaunch on: ${a.unstableFingerprints.join(", ")}`);
  if (a.stability.inconclusive.length) v.push(`⚠️  relaunch stability inconclusive on ${a.stability.inconclusive.length} profile(s): comparable samples missing`);
  if (a.uaInconsistencies.length) v.push(`⚠️  UA/UA-CH mismatch on ${a.uaInconsistencies.length} profile(s)`);
  const screensCompared = profiles.filter((p) => p.fingerprint?.screen && p.screenConfigured).length;
  if (a.screenMismatches.length) v.push(`⚠️  screen resolution mismatch on ${a.screenMismatches.length} profile(s): ${a.screenMismatches.map((s) => `${s.profileId} ${s.seen}≠${s.configured}`).join(", ")}`);
  else if (screensCompared) v.push(`✅ screen resolution matches the spoofed value on all ${screensCompared} profile(s)`);
  v.push(`login: ${a.login.loggedIn.length} signed in, ${a.login.loggedOut.length} signed out, ${a.login.unknown.length} unknown`);

  return a;
}

// ---------------------------------------------------------------------------
// In-browser probes (serialized to the page; must be self-contained).
// ---------------------------------------------------------------------------

export async function fingerprintProbe(): Promise<FingerprintSample> {
  const out: FingerprintSample = { errors: {} };
  const err = (k: string, e: unknown) => {
    out.errors![k] = e instanceof Error ? e.message : String(e);
  };
  try {
    out.userAgent = navigator.userAgent;
    out.platform = (navigator as any).platform;
    out.language = navigator.language;
    out.languages = navigator.languages as string[];
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = (navigator as any).deviceMemory;
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: (screen as any).availLeft,
      availTop: (screen as any).availTop,
      colorDepth: screen.colorDepth,
      dpr: devicePixelRatio,
    };
  } catch (e) {
    err("nav", e);
  }
  try {
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      const hi = await uaData.getHighEntropyValues(["platform", "platformVersion", "uaFullVersion", "fullVersionList"]);
      out.uaDataPlatform = hi.platform;
      out.uaDataPlatformVersion = hi.platformVersion;
      out.uaFullVersion = hi.uaFullVersion;
      out.uaFullVersionList = hi.fullVersionList?.map((b: any) => `${b.brand} ${b.version}`);
      out.uaDataBrands = (uaData.brands ?? []).map((b: any) => `${b.brand} ${b.version}`);
    }
  } catch (e) {
    err("uaData", e);
  }
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.webglVendor = String(gl.getParameter((dbg as any).UNMASKED_VENDOR_WEBGL));
        out.webglRenderer = String(gl.getParameter((dbg as any).UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch (e) {
    err("webgl", e);
  }
  const sha = async (s: string) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    // Firefox's automation realm exposes content TypedArrays through Xrays:
    // indexing/iterating them throws, while DataView reads the actual buffer.
    const bytes = new DataView(buf);
    let hex = "";
    for (let i = 0; i < bytes.byteLength; i++) hex += bytes.getUint8(i).toString(16).padStart(2, "0");
    return hex;
  };
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext("2d")!;
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(10, 10, 100, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("Cloak fingerprint \u{1F3A8}", 2, 15);
    out.canvasHash = await sha(c.toDataURL());
  } catch (e) {
    err("canvas", e);
  }
  try {
    const Ctx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const ac = new Ctx(1, 5000, 44100);
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(ac.destination);
    osc.start(0);
    const buf: AudioBuffer = await ac.startRendering();
    const data = buf.getChannelData(0).slice(0, 1000);
    const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const littleEndian = new DataView(new Uint16Array([0x0102]).buffer).getUint8(0) === 0x02;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(samples.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, littleEndian));
    out.audioHash = await sha(String(sum));
  } catch (e) {
    err("audio", e);
  }
  try {
    const gpu = typeof navigator !== "undefined" ? (navigator as any).gpu : undefined;
    if (gpu && typeof gpu.requestAdapter === "function") {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info ?? (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : undefined);
        out.webgpu = {
          available: true,
          ...(info?.vendor ? { vendor: String(info.vendor) } : {}),
          ...(info?.architecture ? { architecture: String(info.architecture) } : {}),
          ...(info?.description ? { description: String(info.description) } : {}),
          ...(info?.device ? { device: String(info.device) } : {}),
        };
      } else {
        out.webgpu = { available: false };
      }
    }
  } catch (e) {
    err("webgpu", e);
  }
  try {
    if (typeof document !== "undefined" && typeof document.createElement === "function" && document.body && typeof document.body.appendChild === "function") {
      const probe = document.createElement("span");
      probe.textContent = "Maobu DOMRect Probe 0123456789";
      probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;font:14.25px/1.3 sans-serif;letter-spacing:0.35px;";
      document.body.appendChild(probe);
      try {
        const r1 = probe.getBoundingClientRect();
        const r2 = probe.getBoundingClientRect();
        const raw = `${r1.x}:${r1.y}:${r1.width}:${r1.height}:${r1.top}:${r1.left}`;
        const consistent = r1.x === r2.x && r1.y === r2.y && r1.width === r2.width && r1.height === r2.height;
        const hash = typeof crypto !== "undefined" && crypto.subtle ? await sha(raw) : raw;
        out.clientRects = { hash, width: r1.width, height: r1.height, consistent };
      } finally {
        probe.remove?.();
      }
    }
  } catch (e) {
    err("clientRects", e);
  }
  try {
    const md = typeof navigator !== "undefined" ? (navigator as any).mediaDevices : undefined;
    if (md && typeof md.enumerateDevices === "function") {
      const devices = await md.enumerateDevices();
      const list = Array.isArray(devices) ? devices : [];
      let audioInput = 0;
      let videoInput = 0;
      let audioOutput = 0;
      let labelsExposed = false;
      for (const d of list) {
        if (d?.kind === "audioinput") audioInput++;
        else if (d?.kind === "videoinput") videoInput++;
        else if (d?.kind === "audiooutput") audioOutput++;
        if (typeof d?.label === "string" && d.label.trim().length > 0) labelsExposed = true;
      }
      out.mediaDevices = { count: list.length, audioInput, videoInput, audioOutput, labelsExposed };
    }
  } catch (e) {
    err("mediaDevices", e);
  }
  try {
    const ss = typeof speechSynthesis !== "undefined" ? speechSynthesis : (typeof window !== "undefined" ? (window as any).speechSynthesis : undefined);
    if (ss && typeof ss.getVoices === "function") {
      const voices = ss.getVoices();
      const list = Array.isArray(voices) ? voices : [];
      const sig = list.map((v: any) => `${v?.name ?? ""}|${v?.lang ?? ""}|${v?.localService ? "1" : "0"}`).sort().join("\n");
      const def = list.find((v: any) => v?.default)?.name;
      const hash = sig && typeof crypto !== "undefined" && crypto.subtle ? await sha(sig) : undefined;
      out.speechVoices = { count: list.length, ...(def ? { defaultVoice: String(def) } : {}), ...(hash ? { hash } : {}) };
    }
  } catch (e) {
    err("speechVoices", e);
  }
  try {
    const webrtcApiPresent = typeof RTCPeerConnection !== "undefined" || typeof (globalThis as any).webkitRTCPeerConnection !== "undefined";
    const rtcIceGathererPresent = typeof (globalThis as any).RTCIceGatherer !== "undefined";
    const connectionType = typeof navigator !== "undefined" && (navigator as any).connection?.effectiveType
      ? String((navigator as any).connection.effectiveType)
      : undefined;
    out.leakIndicators = { webrtcApiPresent, rtcIceGathererPresent, ...(connectionType ? { connectionType } : {}) };
  } catch (e) {
    err("leakIndicators", e);
  }
  return out;
}

export function loginProbe(config: LoginProbeConfig = {}): LoginInfo {
  const url = location.href;
  const host = (location.hostname || "").toLowerCase();
  const customLoggedIn = config?.selectors?.loggedIn ?? [];
  const customLoggedOut = config?.selectors?.loggedOut ?? [];
  const matchesAny = (selectors: string[]) => selectors.some((selector) => {
    try { return !!document.querySelector(selector); } catch { return false; }
  });
  const isX = host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  const xLoggedInSelectors = ['[data-testid="SideNav_NewTweet_Button"]', '[data-testid="AppTabBar_Home_Link"]', '[aria-label="Home timeline"]'];
  const xLoggedOutSelectors = ['input[name="text"]', 'a[href="/login"]', '[data-testid="loginButton"]'];
  const genericLoggedInSelectors = ['a[href*="/logout" i]', 'button[aria-label*="profile" i]', 'button[aria-label*="account" i]', '[data-testid*="avatar" i]'];
  const genericLoggedOutSelectors = ['input[type="password"]', 'form[action*="login" i]', 'form[action*="signin" i]', 'a[href*="/login" i]', 'a[href*="/signin" i]'];

  let loggedIn = matchesAny(customLoggedIn);
  let loggedOut = matchesAny(customLoggedOut);
  if (!loggedIn && !loggedOut) {
    if (isX) {
      loggedIn = matchesAny(xLoggedInSelectors);
      loggedOut = matchesAny(xLoggedOutSelectors);
    } else {
      loggedIn = matchesAny(genericLoggedInSelectors);
      loggedOut = matchesAny(genericLoggedOutSelectors);
    }
  }
  if (!loggedOut) {
    if (config?.selectors?.loggedOutUrlPattern) {
      try { loggedOut = new RegExp(config.selectors.loggedOutUrlPattern, "i").test(url); } catch {}
    } else {
      loggedOut = /\/(login|signin|sign-in|i\/flow\/login|logout)\b/i.test(url);
    }
  }
  return { url, loggedIn, loggedOut, title: document.title };
}

export async function webrtcProbe(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const ips = new Set<string>();
    let pc: RTCPeerConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pc) {
        pc.onicecandidate = null;
        try { pc.close(); } catch { /* Already closed or unsupported. */ }
      }
      resolve([...ips]);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.createDataChannel("x");
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          finish();
          return;
        }
        const cand = e.candidate;
        // Modern browsers expose the parsed address; prefer it.
        const addr = ((cand as any).address || "").trim();
        if (addr && !/\.local$/i.test(addr)) {
          ips.add(addr);
          return;
        }
        // Skip mDNS-anonymized candidates (<uuid>.local) — they carry no real IP
        // and their hex would otherwise be misparsed as an address.
        const s = cand.candidate ?? "";
        if (/\.local\b/i.test(s)) return;
        // The fifth ICE candidate token is its address. Do not regex-match the
        // foundation, related address or an incomplete compressed IPv6 literal.
        const address = s.trim().split(/\s+/)[4];
        if (address && !/\.local$/i.test(address)) ips.add(address);
      };
      timer = setTimeout(finish, 3000);
      const connection = pc;
      connection.createOffer().then((offer) => connection.setLocalDescription(offer)).catch(finish);
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// CDP collection shell (untested; mirrors launcher's default-impl pattern).
// ---------------------------------------------------------------------------

/** Egress via the diagnostic page itself (interactive tooling only; the launch path never does this). */
async function diagnosePageEgress(page: any, timeoutMs: number): Promise<EgressInfo | null> {
  for (const endpoint of resolveEgressEndpoints()) {
    try {
      const response = await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response?.ok()) continue;
      const info = parseEgressResponse(await page.locator("body").innerText({ timeout: Math.min(timeoutMs, 5_000) }));
      if (info) return info;
    } catch {
      // next endpoint
    }
  }
  return null;
}

export interface DiagnoseProfileOptions {
  timeoutMs?: number;
  collectLogin?: boolean;
  loginUrl?: string;
  loginConfig?: LoginProbeConfig;
}

function resolveProfileLoginUrl(profile: Profile, explicitUrl?: string): string | null {
  const candidate = (explicitUrl ?? profile.platform ?? "").trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate)) {
    return `https://${candidate.toLowerCase()}`;
  }
  return null;
}

/** Connect over CDP and collect one profile's full sample. */
export async function diagnoseOverCDP(
  ws: string,
  profile: Profile,
  opts: DiagnoseProfileOptions = {},
): Promise<Pick<ProfileReport, "fingerprint" | "egress" | "webrtcIps" | "login">> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const customLoginUrl = opts.collectLogin === false ? null : resolveProfileLoginUrl(profile, opts.loginUrl);
  const loginExpression = `(${loginProbe.toString()})(${JSON.stringify(opts.loginConfig ?? {})})`;
  const result = await runPlaywrightWorker<{
    fingerprint: FingerprintSample;
    webrtcIps: string[];
    egress: string | null;
    login: LoginInfo | null;
  }>("diagnostics", {
    endpoint: ws,
    timeoutMs,
    collectLogin: opts.collectLogin !== false && !customLoginUrl,
    fingerprintScript: `(${fingerprintProbe.toString()})()`,
    webrtcScript: `(${webrtcProbe.toString()})()`,
    loginScript: loginExpression,
    egressUrls: resolveEgressEndpoints(),
    connectTimeoutMs: timeoutMs,
  }, { timeoutMs: timeoutMs * 3 + 20_000 });
  let login = result.login;
  if (customLoginUrl && opts.collectLogin !== false) {
    try {
      const [evaluated] = await runPlaywrightWorker<unknown[]>("page", {
        endpoint: ws,
        kind: "scripts",
        temporary: true,
        url: customLoginUrl,
        timeoutMs,
        scripts: [loginExpression],
        connectTimeoutMs: timeoutMs,
      }, { timeoutMs: timeoutMs * 2 });
      if (evaluated && typeof evaluated === "object" && !("__aliasmodeError" in evaluated)) {
        login = evaluated as LoginInfo;
      } else {
        login = { loggedIn: false, loggedOut: false, url: customLoginUrl, title: "diagnostic login probe failed" };
      }
    } catch {
      login = { loggedIn: false, loggedOut: false, url: customLoginUrl, title: "diagnostic navigation failed" };
    }
  }
  return {
    fingerprint: result.fingerprint,
    egress: result.egress ? parseEgressResponse(result.egress) : null,
    webrtcIps: result.webrtcIps,
    login,
  };
}

// ---------------------------------------------------------------------------
// Orchestration over the manager's AdsPower-shaped HTTP API.
// ---------------------------------------------------------------------------

export interface RunDiagnosticsOptions {
  baseUrl: string;
  profiles: Profile[];
  relaunch?: boolean;
  collectLogin?: boolean;
  log?: (msg: string) => void;
  /** Called with the running report after each profile, for incremental persistence. */
  onProgress?: (report: DiagnoseReport) => void;
  /** Hard cap per profile so a hung CDP connection can't stall the whole run. */
  perProfileTimeoutMs?: number;
}

/** Replace IO boundaries for alternate local transports and deterministic checks. */
export interface DiagnosticsDependencies {
  fetchFn?: typeof fetch;
  sample?: typeof diagnoseOverCDP;
  baseline?: () => Promise<string | undefined>;
}

/** Reject if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function apiStart(baseUrl: string, id: string, fetchFn: typeof fetch): Promise<{ ws: string; port: number } | null> {
  const r = await (await fetchFn(`${baseUrl}/api/v1/browser/start?user_id=${encodeURIComponent(id)}`)).json();
  if (r.code !== 0) return null;
  return { ws: r.data.ws.puppeteer, port: Number(r.data.debug_port) };
}
async function apiStop(baseUrl: string, id: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`${baseUrl}/api/v1/browser/stop?user_id=${encodeURIComponent(id)}`);
    if (!response.ok) return false;
    const body = await response.json();
    return body.code === 0;
  } catch { return false; }
}

/** This machine's system-route exit, including a system VPN when one is active. */
async function baselineRealIp(): Promise<string | undefined> {
  return (await fetchDirectEgress())?.ip;
}

/** Drive every profile through the manager, collect samples, and analyze. */
export async function runDiagnostics(opts: RunDiagnosticsOptions, dependencies: DiagnosticsDependencies = {}): Promise<DiagnoseReport> {
  const log = opts.log ?? ((m) => console.log(`[diagnose] ${m}`));
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sampleProfile = dependencies.sample ?? diagnoseOverCDP;
  const realIp = await (dependencies.baseline ?? baselineRealIp)();
  log(`this machine's system-route exit (comparison baseline): ${realIp ?? "unknown"}`);

  const timeout = opts.perProfileTimeoutMs ?? 90_000;
  const reports: ProfileReport[] = [];
  const snapshot = (): DiagnoseReport => ({ generatedAt: Date.now(), baselineRealIp: realIp, profiles: reports, analysis: analyze(reports, realIp) });

  for (const profile of opts.profiles) {
    const proxyConfigured = profile.proxy ? { host: profile.proxy.host, port: profile.proxy.port } : null;
    const screenConfigured = { width: profile.screenWidth, height: profile.screenHeight };
    try {
      const first = await apiStart(opts.baseUrl, profile.id, fetchFn);
      if (!first) {
        reports.push({ profileId: profile.id, ok: false, error: "browser/start failed", proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
        continue;
      }
      const sample = await withTimeout(
        sampleProfile(first.ws, profile, { collectLogin: opts.collectLogin }),
        timeout,
        `diagnose ${profile.id}`,
      );

      let fingerprintRelaunch: FingerprintSample | null | undefined = opts.relaunch ? null : undefined;
      if (opts.relaunch) {
        // A failed teardown followed by start can return the same generation.
        // Never call that a relaunch stability measurement.
        const stopped = await apiStop(opts.baseUrl, profile.id, fetchFn);
        if (!stopped) log(`${profile.id}: relaunch stability unavailable (teardown unconfirmed)`);
        else try {
          const second = await apiStart(opts.baseUrl, profile.id, fetchFn);
          if (second) {
            const s2 = await withTimeout(sampleProfile(second.ws, profile, { collectLogin: false }), timeout, `relaunch ${profile.id}`);
            fingerprintRelaunch = s2.fingerprint;
          }
        } catch {
          // Preserve the valid first sample and mark just the relaunch evidence
          // inconclusive when the second launch/probe cannot be measured.
          log(`${profile.id}: relaunch stability unavailable (second sample failed)`);
        }
      }

      const report: ProfileReport = { profileId: profile.id, ok: true, proxyConfigured, screenConfigured, ...sample, fingerprintRelaunch, ...(opts.relaunch ? { relaunchRequested: true } : {}) };
      reports.push(report);
      const eg = report.egress?.ip ?? "?";
      const proxyTag = !proxyConfigured ? "system-route" : !report.egress ? "egress?" : !realIp ? "baseline?" : sameIp(eg, realIp) ? "shared-exit?" : "different-exit";
      const li = report.login?.loggedIn ? "logged-in" : report.login?.loggedOut ? "logged-out" : "login?";
      log(`${profile.id}: egress=${eg} ${proxyTag} canvas=${report.fingerprint?.canvasHash?.slice(0, 8) ?? "?"} ${li}`);
    } catch (e) {
      reports.push({ profileId: profile.id, ok: false, error: e instanceof Error ? e.message : String(e), proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
      log(`${profile.id}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await apiStop(opts.baseUrl, profile.id, fetchFn);
      opts.onProgress?.(snapshot());
    }
  }

  return snapshot();
}
