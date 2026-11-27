import { launchedProfile, launchIdentityChanged, type Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { LaunchInfo, ObservedFingerprint } from "./types.ts";
import { captureFingerprint } from "./fingerprint-capture.ts";
import { captureAttestationVerdict, observedFromSample } from "./fingerprint-attestation.ts";
import { assessFingerprintQuality } from "./fingerprint-quality.ts";
import type { FingerprintSample } from "./diagnose.ts";
import { createFingerprintSource } from "./fingerprint-source.ts";

export class FingerprintReviewError extends Error {
  override readonly name = "FingerprintReviewError";
  constructor(message: string, readonly status = 409) { super(message); }
}
const pending = new WeakMap<ProfileStore, Set<string>>();
const CHANGED = "The profile or browser changed while measuring. Retry on the current browser.";
const UNCERTIFIED = "The running browser could not be certified. The previous measurement was preserved.";
const EMPTY = "No fingerprint evidence was collected. The previous measurement was preserved.";
const MALFORMED = "The fingerprint probe returned invalid data. The previous measurement was preserved.";
function generation(launch: LaunchInfo | null): string {
  if (!launch) return "";
  const owner = launch.firefoxOwner;
  return JSON.stringify([
    launch.profileId, launch.engine ?? "chromium", launch.pid, launch.debugPort, launch.startedAt, launch.ws,
    launch.rootStartTime, launch.processGroupId, launch.binaryPath, launch.userDataDir, launch.binarySha256,
    launch.personaDigest, launch.persona, launch.headless, launch.ownerBinaryPath,
    owner && [owner.generation, owner.endpoint, owner.token, owner.pid, owner.browserPid, owner.binaryPath],
  ]);
}
const STRING_FIELDS = ["userAgent", "uaDataPlatform", "uaDataPlatformVersion", "uaFullVersion", "platform", "language", "timezone", "webglVendor", "webglRenderer", "canvasHash", "audioHash"] as const;
const ARRAY_FIELDS = ["languages", "uaDataBrands", "uaFullVersionList"] as const;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Reject malformed probes instead of replacing an earlier valid report with unusable evidence. */
function validatedSample(value: unknown): FingerprintSample {
  if (!record(value)) throw new FingerprintReviewError(EMPTY, 502);
  const result: FingerprintSample = {};
  for (const field of STRING_FIELDS) {
    const entry = value[field];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || entry.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry)) throw new FingerprintReviewError(MALFORMED, 502);
    if (entry.trim()) result[field] = entry;
  }
  for (const field of ARRAY_FIELDS) {
    const entry = value[field];
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || entry.length > 100 || entry.some(item => typeof item !== "string" || item.length > 1024 || /[\u0000-\u001f\u007f]/.test(item))) throw new FingerprintReviewError(MALFORMED, 502);
    if (entry.length) result[field] = entry.slice();
  }
  for (const field of ["hardwareConcurrency", "deviceMemory"] as const) {
    const entry = value[field];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry > 1_000_000 || field === "hardwareConcurrency" && !Number.isInteger(entry)) throw new FingerprintReviewError(MALFORMED, 502);
    result[field] = entry;
  }
  if (value.screen !== undefined) {
    const screen = value.screen;
    if (!record(screen)) throw new FingerprintReviewError(MALFORMED, 502);
    for (const field of ["width", "height", "availWidth", "availHeight", "colorDepth", "dpr"] as const) {
      const number = screen[field];
      if (typeof number !== "number" || !Number.isFinite(number) || number > 1_000_000
        || (field === "availWidth" || field === "availHeight" ? number < 0 : number <= 0)
        || field !== "dpr" && !Number.isInteger(number)) throw new FingerprintReviewError(MALFORMED, 502);
    }
    for (const field of ["availLeft", "availTop"] as const) {
      if (screen[field] !== undefined && (typeof screen[field] !== "number" || !Number.isFinite(screen[field]) || Math.abs(screen[field] as number) > 1_000_000)) throw new FingerprintReviewError(MALFORMED, 502);
    }
    result.screen = {
      width: screen.width as number, height: screen.height as number, availWidth: screen.availWidth as number, availHeight: screen.availHeight as number,
      colorDepth: screen.colorDepth as number, dpr: screen.dpr as number,
      ...(screen.availLeft !== undefined ? { availLeft: screen.availLeft as number } : {}), ...(screen.availTop !== undefined ? { availTop: screen.availTop as number } : {}),
    };
  }
  if (value.errors !== undefined) {
    if (!record(value.errors) || Object.keys(value.errors).length > 32
      || Object.entries(value.errors).some(([key, message]) => key.length > 128 || typeof message !== "string" || message.length > 4096)) throw new FingerprintReviewError(MALFORMED, 502);
    const safe: Record<string, string> = {};
    for (const key of Object.keys(value.errors)) {
      // Page/transport exception text is not identity evidence; retain only a neutral surface marker.
      safe[["nav", "uaData", "webgl", "canvas", "audio", "probe"].includes(key) ? key : "other"] = "Probe unavailable";
    }
    if (Object.keys(safe).length) result.errors = safe;
  }
  const evidence = [result.userAgent, result.platform, result.uaDataPlatform, result.canvasHash, result.audioHash,
    result.webglRenderer, result.timezone, result.hardwareConcurrency, result.screen];
  if (!evidence.some(entry => entry !== undefined)) throw new FingerprintReviewError(EMPTY, 502);
  return result;
}
/** Collect only from an already certified running browser, using its isolated local probe page. */
export async function reviewRunningFingerprint(
  id: string, store: ProfileStore, launcher: Pick<Launcher, "certifiedActive">,
  dependencies: { capture?: (endpoint: string) => Promise<FingerprintSample | null>; now?: () => number } = {},
) {
  const profile = store.getProfile(id);
  if (!profile) throw new FingerprintReviewError("Profile not found", 404);
  let inFlight = pending.get(store);
  if (!inFlight) { inFlight = new Set(); pending.set(store, inFlight); }
  if (inFlight.has(id)) throw new FingerprintReviewError("A fingerprint measurement is already running for this profile");
  inFlight.add(id);
  try {
    const incarnation = store.getProfileIncarnation(id);
    const launch = store.getLaunch(id), before = generation(launch);
    if (!launch) throw new FingerprintReviewError("Open this profile before measuring its fingerprint");
    if (!incarnation || !launch.ws) throw new FingerprintReviewError(UNCERTIFIED);
    const unchanged = () => {
      if (store.getProfileIncarnation(id) !== incarnation || generation(store.getLaunch(id)) !== before) throw new FingerprintReviewError(CHANGED);
    };
    const certify = async () => {
      let active: boolean;
      try { active = await launcher.certifiedActive(id); } catch { throw new FingerprintReviewError(UNCERTIFIED); }
      unchanged();
      if (!active) throw new FingerprintReviewError(UNCERTIFIED);
    };
    // Certification is asynchronous too: bind both identities before it, never after it.
    await certify();
    let raw: FingerprintSample | null;
    try { raw = await (dependencies.capture ?? captureFingerprint)(launch.ws); }
    catch { throw new FingerprintReviewError("Fingerprint measurement failed. The previous measurement was preserved.", 502); }
    unchanged();
    let sample: FingerprintSample;
    try { sample = validatedSample(raw); }
    catch (error) { if (error instanceof FingerprintReviewError) throw error; throw new FingerprintReviewError(MALFORMED, 502); }
    // A responding page is not a certification of continued process ownership.
    await certify();
    const current = store.getProfile(id);
    if (!current) throw new FingerprintReviewError(CHANGED);
    let observed: ObservedFingerprint;
    try { observed = observedFromSample(sample, { capturedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
        ...(launch.persona && "proxy" in launch.persona ? { webrtc: launch.persona.proxy ? "disable_non_proxied_udp" : "default_public_interface_only" } : {}),
      });
    } catch { throw new FingerprintReviewError(MALFORMED, 502); }
    const verdict = captureAttestationVerdict(current.fpExpected, observed);
    const launchState = !launch.persona ? "unknown" : launchIdentityChanged(current, launch) ? "pending" : "current";
    const captureSource = launch.persona ? createFingerprintSource(launchedProfile(current, launch), launch) : undefined;
    const report = { name: current.name, running: true, ...assessFingerprintQuality({ ...current, fpObserved: observed, fpVerdict: verdict ?? undefined }, { launchState, captureSource, launch }) };
    unchanged();
    let saved: boolean;
    try { saved = store.saveObservedFingerprint(id, observed, verdict, incarnation, captureSource); }
    catch { throw new FingerprintReviewError("Fingerprint measurement could not be saved. The previous measurement was preserved.", 500); }
    if (!saved) throw new FingerprintReviewError(CHANGED);
    return report;
  } finally { inFlight.delete(id); }
}
