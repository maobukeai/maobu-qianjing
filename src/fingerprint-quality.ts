/** Explain saved configuration and real samples without manufacturing browser test results. */
import { buildFingerprintImportComparison } from "./fingerprint-import-comparison.ts";
import { deriveFingerprintFlags, isMobileUserAgent, platformFromUA } from "./fingerprint.ts";
import { firefoxLaunchHardwareConcurrency } from "./firefox-config.ts";
import { normalizeProfileLocale } from "./profile-locale.ts";
import { MAX_SCREEN_DIMENSION, MIN_SCREEN_HEIGHT, MIN_SCREEN_WIDTH } from "./parse.ts";
import { normalizeProxySpec } from "./proxy.ts";
import type { ObservedFingerprint, Profile } from "./types.ts";
import type { LaunchInfo } from "./types.ts";
import { availableParallelism } from "node:os";
import { fingerprintConfigurationDigest, fingerprintLaunchDigest, parseFingerprintSource, type FingerprintCaptureSource } from "./fingerprint-source.ts";
import { FINGERPRINT_SURFACES, projectFingerprintEvidence, renderFingerprintMessage, type FingerprintCheckEvidence, type FingerprintCheckMessage, type PresentableFingerprintCheck } from "./fingerprint-check-presentation.ts";

export type QualityCheckStatus = "pass" | "warn" | "fail" | "unknown";
export interface QualityCheck extends PresentableFingerprintCheck {}
export interface FingerprintQualityReport {
  profileId: string;
  status: "issues" | "review" | "unmeasured" | "consistent";
  checks: QualityCheck[];
  summary: Record<QualityCheckStatus, number>;
  measuredAt?: string;
}

function nonempty(value: unknown): boolean { return value !== undefined && value !== null && value !== ""; }
function desktopPlatform(value: string | undefined): "windows" | "macos" | "linux" | null {
  if (!value) return null;
  if (/windows|win32|win64/i.test(value)) return "windows";
  if (/macos|macintel|macintosh|mac os/i.test(value)) return "macos";
  if (/linux/i.test(value)) return "linux";
  return null;
}
function screenPair(value: string | undefined): [number, number] | null {
  const match = value?.match(/^(\d+)[*x×](\d+)$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}
const timezoneValidity = new Map<string, boolean>();
function validTimezone(value: string): boolean {
  const cached = timezoneValidity.get(value);
  if (cached !== undefined) return cached;
  let valid = false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); valid = true; } catch { /* Invalid IANA name. */ }
  // A report can cover thousands of profiles sharing a timezone. Keep the cache
  // bounded and avoid retaining unusually large imported strings.
  if (value.length <= 128) {
    if (timezoneValidity.size >= 256) timezoneValidity.delete(timezoneValidity.keys().next().value!);
    timezoneValidity.set(value, valid);
  }
  return valid;
}
const OBSERVED_TEXT_FIELDS = ["ua", "platform", "languages", "webglVendor", "webglRenderer", "canvas", "audio", "screen",
  "capturedAt", "uaChPlatform", "language", "timezone", "availableScreen", "errors"] as const;

/** SQLite can contain observations from older versions with an unexpected JSON shape. */
function projectSavedObservation(value: unknown): ObservedFingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sample: ObservedFingerprint = {};
  for (const field of OBSERVED_TEXT_FIELDS) {
    const entry = raw[field];
    if (typeof entry === "string" && entry.length) sample[field] = entry;
  }
  const cores = raw.hardwareConcurrency;
  if (typeof cores === "number" && Number.isSafeInteger(cores) && cores > 0) sample.hardwareConcurrency = cores;
  const measured = [sample.ua, sample.platform, sample.screen, sample.canvas, sample.audio,
    sample.webglRenderer, sample.hardwareConcurrency, sample.timezone].some(nonempty);
  return measured ? sample : undefined;
}
/** Read the same explicit-hardware inputs that the launch path applies, without generating identity. */
function configuredProcessorCount(profile: Profile, hostCores: number): number | undefined {
  if (!Number.isSafeInteger(hostCores) || hostCores < 1) return undefined;
  let value: unknown;
  if (profile.engine === "firefox") {
    const config = profile.firefox?.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
    // Explicit hardware replaces the fitted graphics count before this shared cap policy runs.
    value = firefoxLaunchHardwareConcurrency(config, profile.hardware, hostCores);
  } else if ((profile.engine ?? "chromium") === "chromium") {
    const flag = deriveFingerprintFlags(profile, hostCores).find(flag => flag.startsWith("--fingerprint-hardware-concurrency="));
    value = flag ? Number(flag.slice("--fingerprint-hardware-concurrency=".length)) : undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 256 ? value : undefined;
}

/**
 * Offline readiness and consistency, not an anonymity score. A stored sample
 * describes its capture time; edits made afterwards need a fresh measurement.
 * Network egress, DNS and WebRTC leak tests are explicitly outside this report.
 */
export function assessFingerprintQuality(profile: Profile, options: { now?: number; launchState?: "current" | "pending" | "unknown";
  captureSource?: FingerprintCaptureSource | null; launch?: LaunchInfo | null; hostCores?: number } = {}): FingerprintQualityReport {
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, status: QualityCheckStatus, detail: string | FingerprintCheckMessage, recommendation?: string, evidence?: FingerprintCheckEvidence | null) => {
    checks.push({ id, label, status, detail: typeof detail === "string" ? detail : renderFingerprintMessage(detail),
      ...(typeof detail !== "string" ? { detailMessage: detail } : {}), ...(recommendation ? { recommendation } : {}), ...(evidence ? { evidence } : {}) });
  };
  const evidence = (value: unknown) => projectFingerprintEvidence(value, { validTimezone });
  const observed = projectSavedObservation(profile.fpObserved);
  add("identity_seed", "Fixed identity seed", Number.isInteger(profile.fingerprintSeed) && profile.fingerprintSeed > 0 && profile.fingerprintSeed <= 0xffffffff ? "pass" : "fail",
    Number.isInteger(profile.fingerprintSeed) && profile.fingerprintSeed > 0 && profile.fingerprintSeed <= 0xffffffff
      ? "The profile uses its saved, fixed seed." : "The seed is invalid, so the identity input cannot be confirmed.", "Keep the existing seed stable and avoid unnecessary identity regeneration.");
  const screenValid = Number.isInteger(profile.screenWidth) && Number.isInteger(profile.screenHeight)
    && profile.screenWidth >= MIN_SCREEN_WIDTH && profile.screenHeight >= MIN_SCREEN_HEIGHT
    && profile.screenWidth <= MAX_SCREEN_DIMENSION && profile.screenHeight <= MAX_SCREEN_DIMENSION;
  add("screen_config", "Screen configuration", screenValid ? "pass" : "fail",
    screenValid ? `${profile.screenWidth} × ${profile.screenHeight}` : "Screen dimensions are missing or outside the supported range.",
    screenValid ? undefined : "Choose a valid desktop resolution in the profile editor.");
  const timezoneValid = !!profile.timezone && validTimezone(profile.timezone);
  add("timezone_config", "Timezone configuration", !profile.timezone ? "unknown" : timezoneValid ? "pass" : "fail",
    !profile.timezone ? "No timezone is saved. The runtime may use its default." : timezoneValid ? profile.timezone : "The saved timezone is not recognized.",
    !profile.timezone || !timezoneValid ? "Choose a valid IANA timezone for the region you use." : undefined);
  let localeValid = false;
  try { localeValid = !!normalizeProfileLocale(profile.locale); } catch { /* Report invalid saved input. */ }
  add("locale_config", "Language configuration", !profile.locale ? "unknown" : localeValid ? "pass" : "fail",
    !profile.locale ? "No language is saved." : localeValid ? "A valid language tag is saved." : "The language tag is invalid.",
    !localeValid ? "Choose a valid BCP-47 language tag, such as zh-CN or en-US." : undefined,
    evidence({ kind: "locale-config", configured: localeValid ? profile.locale : null }));
  if (profile.ua && isMobileUserAgent(profile.ua)) add("desktop_persona", "Desktop identity", "warn",
    "The saved user agent describes a mobile device, but this profile uses a desktop browser.", "Review the imported identity, explicitly convert it to desktop, then measure again.");
  if (profile.engine === "firefox" && !profile.firefox) add("engine_identity", "Engine identity", "fail",
    "The Firefox profile is missing its saved Firefox identity configuration.", "Restore this profile's identity configuration from a complete backup.");
  else if ((profile.engine ?? "chromium") === "chromium" && profile.firefox) add("engine_identity", "Engine identity", "fail",
    "The Chromium profile contains a Firefox identity configuration.", "Check the engine type in the imported file.");
  else add("engine_identity", "Engine identity", "pass", "The saved identity type matches the selected engine.");

  let proxyValid = !profile.proxyError;
  try { normalizeProxySpec(profile.proxy); } catch { proxyValid = false; }
  add("proxy_config", "Network route configuration", !proxyValid ? "fail" : profile.proxy ? "pass" : "warn",
    !proxyValid ? "The proxy configuration cannot be validated. This report does not include proxy credentials." : profile.proxy
      ? "A proxy is configured. Its actual exit still needs a separate check." : "No dedicated proxy is configured. The profile will use the system network route.",
    !proxyValid ? "Replace or correct the proxy configuration before opening the profile." : "Check proxy reachability and the actual exit in network diagnostics. A listening port does not prove network isolation.");

  const launchState = options.launchState ?? "unknown";
  add("runtime_config", "Applied runtime configuration", launchState === "current" ? "pass" : launchState === "pending" ? "warn" : "unknown",
    launchState === "current" ? "The browser's launch configuration matches the currently saved configuration."
      : launchState === "pending" ? "The browser still uses its launch configuration. Saved fingerprint or proxy changes have not taken effect."
      : "The measurement's browser configuration has not been confirmed against the currently saved configuration.",
    launchState === "pending" ? "Close and reopen the profile, then measure again. A new measurement time does not prove new settings took effect."
      : launchState === "unknown" ? "Measure a browser with a recorded launch configuration to confirm the saved settings are applied." : undefined);

  if (!observed) {
    add("browser_sample", "Browser measurement", "unknown", "No usable browser fingerprint measurement is available.", "Open the profile and collect a measurement before reviewing measured consistency.");
  } else {
    add("browser_sample", "Browser measurement", "pass", "This report uses a saved browser measurement. It has not opened or changed the profile.");
    const source = parseFingerprintSource(options.captureSource);
    const sourceMatches = source && source.configurationDigest === fingerprintConfigurationDigest(profile);
    const launchMatches = source?.launchDigest && (!options.launch || source.launchDigest === fingerprintLaunchDigest(options.launch));
    add("capture_source", "Measurement source and current identity", !source || !source.launchDigest ? "unknown" : sourceMatches && launchMatches ? "pass" : "warn",
      !source || !source.launchDigest ? "The older measurement has no verifiable local configuration and launch source."
        : !sourceMatches ? "The measurement belongs to a different identity configuration and cannot verify the current settings."
        : !launchMatches ? "The measurement belongs to an earlier browser launch. The current launch has not been measured." : "The local measurement source matches the current identity configuration and browser launch.",
      !source || !sourceMatches || !launchMatches ? "Measure the current browser. Historical observations remain reference data and do not verify the current identity." : undefined);
    const missingSurfaces = FINGERPRINT_SURFACES.filter(field => !nonempty(observed[field]));
    add("sample_coverage", "Measurement coverage", missingSurfaces.length ? "unknown" : "pass",
      missingSurfaces.length ? { kind: "missing-surfaces", surfaces: missingSurfaces } : "User agent, system, language, hardware, graphics, Canvas, Audio, screen and timezone measurements are present.",
      missingSurfaces.length ? "Missing probes do not count as passes. Measure again and review browser capabilities and probe logs." : undefined);
    if (isMobileUserAgent(observed.ua ?? "")) add("measured_persona", "Measured desktop identity", "fail",
      "The desktop browser's measured user agent declares a mobile identity.", "Review identity settings and extension changes, use a matching desktop identity, then measure again.");
    const timestamp = observed.capturedAt ? Date.parse(observed.capturedAt) : NaN;
    const age = (options.now ?? Date.now()) - timestamp;
    add("sample_freshness", "Measurement time", !Number.isFinite(timestamp) ? "unknown" : age < -300_000 || age > 7 * 24 * 60 * 60_000 ? "warn" : "pass",
      !Number.isFinite(timestamp) ? "The measurement has no valid timestamp." : age < -300_000 ? "The measurement time is ahead of the current clock." : age > 7 * 24 * 60 * 60_000 ? "The measurement is more than 7 days old." : "The measurement is from the last 7 days.",
      !Number.isFinite(timestamp) || age < -300_000 || age > 7 * 24 * 60 * 60_000 ? "Measure again after changing the browser engine, profile configuration or device." : undefined);
    const uaPlatform = platformFromUA(observed.ua ?? "");
    const hintPlatform = desktopPlatform(observed.uaChPlatform);
    const navigatorPlatform = desktopPlatform(observed.platform);
    const measuredPlatforms = [uaPlatform, hintPlatform, navigatorPlatform].filter(nonempty);
    add("platform_consistency", "Measured system consistency", measuredPlatforms.length < 2 ? "unknown"
      : new Set(measuredPlatforms).size > 1 ? "fail" : "pass",
      measuredPlatforms.length < 2 ? "There are not enough comparable user agent, Client Hints or navigator.platform values."
        : new Set(measuredPlatforms).size > 1 ? "System identifiers within this measurement contradict each other." : "The measured system identifiers agree.",
      new Set(measuredPlatforms).size > 1 ? "Review engine and extension changes to system identifiers, then reopen and measure again." : undefined,
      evidence({ kind: "platform-sources", ua: uaPlatform, clientHints: hintPlatform, navigator: navigatorPlatform }));
    const configuredPlatform = desktopPlatform(profile.platformOs) ?? platformFromUA(profile.ua);
    const observedPlatform = measuredPlatforms.length && new Set(measuredPlatforms).size === 1 ? measuredPlatforms[0] : null;
    const mismatchStatus = launchState === "current" ? "fail" : "warn";
    add("platform_configuration", "Measured system and configuration", !configuredPlatform || !observedPlatform ? "unknown" : configuredPlatform === observedPlatform ? "pass" : mismatchStatus,
      !configuredPlatform || !observedPlatform ? "A comparable configured or measured system is missing." : configuredPlatform === observedPlatform ? "The measured system matches the saved system configuration." : "The measured system differs from the saved system configuration.",
      configuredPlatform && observedPlatform && configuredPlatform !== observedPlatform ? "Confirm the runtime settings are applied, check engine or extension overrides, then measure again." : undefined,
      evidence({ kind: "platform", expected: configuredPlatform, actual: observedPlatform }));
    if (profile.hardware) {
      const hostCores = options.hostCores ?? availableParallelism();
      const expectedCores = configuredProcessorCount(profile, hostCores);
      const actualCores = typeof observed.hardwareConcurrency === "number" && Number.isSafeInteger(observed.hardwareConcurrency) && observed.hardwareConcurrency > 0 ? observed.hardwareConcurrency : undefined;
      add("hardware_configuration", "Measured processors and configuration", actualCores === undefined || expectedCores === undefined ? "unknown" : actualCores === expectedCores ? "pass" : mismatchStatus,
        actualCores === undefined ? "No valid processor count was measured." : expectedCores === undefined ? "The expected processor count cannot be determined from a valid launch configuration."
          : actualCores === expectedCores ? "The measured processor count matches the effective launch policy." : "The measured processor count differs from the effective launch policy.",
        expectedCores === undefined ? "Review the saved engine identity and processor configuration, then measure again."
          : actualCores !== undefined && actualCores !== expectedCores ? "Firefox and Chromium 155 cap the configured count to available host processors. Confirm the launch configuration and measure again." : undefined,
        evidence({ kind: "processors", expected: expectedCores, actual: actualCores, saved: profile.hardware.cores, hostAvailable: hostCores }));
    }
    if (profile.locale) {
      let actualLocale: string | undefined;
      try { actualLocale = normalizeProfileLocale(observed.language); } catch { /* Unusable observed language stays unknown. */ }
      const configuredLocale = localeValid ? normalizeProfileLocale(profile.locale) : undefined;
      add("locale_configuration", "Measured language and configuration", !actualLocale || !configuredLocale ? "unknown" : actualLocale === configuredLocale ? "pass" : mismatchStatus,
        !actualLocale || !configuredLocale ? "A valid saved language or measured preferred language is missing." : actualLocale === configuredLocale ? "The measured preferred language matches the saved language configuration." : "The measured preferred language differs from the saved language configuration.",
        actualLocale && configuredLocale && actualLocale !== configuredLocale ? "Confirm language settings are applied, review extension or site language overrides, then measure again." : undefined,
        evidence({ kind: "locale", expected: configuredLocale, actual: actualLocale }));
    }
    const measuredScreen = screenPair(observed.screen);
    add("screen_measurement", "Measured screen and configuration", !measuredScreen ? "unknown"
      : measuredScreen[0] === profile.screenWidth && measuredScreen[1] === profile.screenHeight ? "pass" : "warn",
      !measuredScreen ? "The measurement has no valid screen dimensions." : measuredScreen[0] === profile.screenWidth && measuredScreen[1] === profile.screenHeight
        ? "The measured screen dimensions match the currently saved configuration." : "The last measured screen dimensions differ from the currently saved configuration.",
      measuredScreen && (measuredScreen[0] !== profile.screenWidth || measuredScreen[1] !== profile.screenHeight)
        ? "Settings may have changed after measurement. Reopen the profile and measure again." : undefined,
      evidence({ kind: "screen", expected: { width: profile.screenWidth, height: profile.screenHeight }, actual: measuredScreen ? { width: measuredScreen[0], height: measuredScreen[1] } : null }));
    const available = screenPair(observed.availableScreen);
    if (measuredScreen && available) add("screen_available", "Available screen bounds", available[0] > measuredScreen[0] || available[1] > measuredScreen[1] ? "fail" : "pass",
      available[0] > measuredScreen[0] || available[1] > measuredScreen[1] ? "The measured available screen is larger than the measured full screen." : "The available screen fits within the full screen.");
    if (observed.timezone && profile.timezone) add("timezone_measurement", "Measured timezone and configuration", observed.timezone === profile.timezone ? "pass" : "warn",
      observed.timezone === profile.timezone ? "The measured timezone matches the saved configuration." : "The last measured timezone differs from the saved configuration.", observed.timezone === profile.timezone ? undefined : "Reopen and measure again to check whether the timezone took effect.",
      evidence({ kind: "timezone", expected: profile.timezone, actual: observed.timezone }));
    if (observed.language && observed.languages) {
      const languages = observed.languages.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
      add("language_consistency", "Measured language consistency", languages[0] === observed.language.toLowerCase() ? "pass" : "warn",
        languages[0] === observed.language.toLowerCase() ? "The preferred language matches the first language in the list." : "The preferred language differs from the first language in the list.",
        languages[0] === observed.language.toLowerCase() ? undefined : "Review language settings or extension changes, then measure again.");
    }
    if (observed.errors) {
      let errorCount: number | null = null;
      try { const value = JSON.parse(observed.errors); if (value && typeof value === "object" && !Array.isArray(value)) errorCount = Object.keys(value).length; } catch { /* Invalid legacy data is not a successful probe. */ }
      if (errorCount !== 0) add("sample_errors", "Measurement completeness", "warn",
        errorCount === null ? "The measurement's error record could not be parsed." : { kind: "probe-errors", count: errorCount }, "Measure again and review probe logs. Failed probes do not count as passes.");
    }
    if (profile.fpExpected) {
      const comparison = buildFingerprintImportComparison(profile.fpExpected, profile.fpObserved);
      const differences = comparison?.differenceFields.length ?? 0;
      const missing = comparison?.missingFields.length ?? 0;
      add("import_attestation", "Imported identity check", differences ? "warn" : !comparison || missing ? "unknown" : "pass",
        !comparison ? "The import has no comparable identity fields."
          : differences ? { kind: "import-differences", count: differences }
          : missing ? "Some imported identity fields have no comparable measurement."
          : { kind: "import-matches", count: comparison.matchedCount },
        missing ? "Measure again to compare the remaining imported identity fields."
          : differences ? "Review imported fingerprint differences and check again after engine or configuration changes." : undefined);
    }
  }
  const summary = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of checks) summary[check.status]++;
  const measuredTime = observed?.capturedAt ? Date.parse(observed.capturedAt) : NaN;
  return { profileId: profile.id, status: summary.fail ? "issues" : !observed ? "unmeasured" : summary.warn || summary.unknown ? "review" : "consistent",
    checks, summary, ...(Number.isFinite(measuredTime) ? { measuredAt: new Date(measuredTime).toISOString() } : {}) };
}
