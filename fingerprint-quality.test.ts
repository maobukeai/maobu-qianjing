import { test, expect } from "bun:test";
import { assessFingerprintQuality } from "./fingerprint-quality.ts";
import type { Profile } from "./types.ts";
import { createFingerprintSource } from "./fingerprint-source.ts";
import { firefoxLaunchConfig, firefoxLaunchHardwareConcurrency } from "./firefox-config.ts";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import type { Launcher } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

const now = Date.parse("2026-11-09T10:00:00Z");
function profile(overrides: Partial<Profile> = {}): Profile {
  return { id: "test0001", engine: "chromium", accId: "", name: "Test", group: "", username: "private-user", password: "PRIVATE_PASSWORD", twofa: "PRIVATE_2FA",
    proxy: { type: "socks5", host: "127.0.0.1", port: "1080", user: "private-user", pass: "PRIVATE_PROXY_PASSWORD" },
    ua: "", timezone: "Asia/Shanghai", locale: "zh-CN", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 12345, platformOs: "windows", cookies: [], seeded: false, ...overrides };
}
function measured(overrides: Partial<Profile["fpObserved"]> = {}): NonNullable<Profile["fpObserved"]> {
  return { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0", platform: "Win32", uaChPlatform: "Windows", screen: "1920*1080", availableScreen: "1920*1040", timezone: "Asia/Shanghai", language: "zh-CN", languages: "zh-CN,zh", capturedAt: new Date(now).toISOString(), canvas: "canvas-one", audio: "audio-one", hardwareConcurrency: 8, webglVendor: "Google Inc.", webglRenderer: "ANGLE (NVIDIA)", ...overrides };
}
const check = (p: Profile, id: string) => assessFingerprintQuality(p, { now }).checks.find((item) => item.id === id)!;

test("saved configuration never manufactures successful browser measurements", () => {
  const report = assessFingerprintQuality(profile(), { now });
  expect(report.status).toBe("unmeasured");
  expect(report.checks.find((item) => item.id === "browser_sample")!.status).toBe("unknown");
  expect(report.checks.some((item) => item.id === "platform_consistency")).toBe(false);
  expect(assessFingerprintQuality(profile({ fpObserved: { capturedAt: new Date(now).toISOString() } }), { now }).status).toBe("unmeasured");
});

test("self-consistent real measurements can pass without claiming network anonymity", () => {
  const p = profile({ fpObserved: measured() });
  const before = JSON.stringify(p);
  const launch = { profileId: p.id, pid: 123, debugPort: 9222, ws: "ws://fixture", startedAt: now - 1000 };
  const report = assessFingerprintQuality(p, { now, launchState: "current", launch, captureSource: createFingerprintSource(p, launch) });
  expect(report.status).toBe("consistent");
  expect(report.summary.fail).toBe(0);
  expect(report.summary.unknown).toBe(0);
  expect(JSON.stringify(p)).toBe(before);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_PASSWORD");
  expect(JSON.stringify(report)).not.toContain("PRIVATE_PROXY_PASSWORD");
  expect(JSON.stringify(report)).not.toContain("PRIVATE_2FA");
  expect(report.checks.find((item) => item.id === "proxy_config")!.detail).toContain("actual exit still needs a separate check");
});

test("contradictions inside one observed sample fail independently of saved inputs", () => {
  const p = profile({ fpObserved: measured({ uaChPlatform: "macOS", availableScreen: "1921*1080" }) });
  expect(check(p, "platform_consistency").status).toBe("fail");
  expect(check(p, "screen_available").status).toBe("fail");
  expect(assessFingerprintQuality(p, { now }).status).toBe("issues");
});

test("configuration changes after capture are review findings rather than fake failures", () => {
  const p = profile({ screenWidth: 1440, timezone: "Europe/Paris", fpObserved: measured() });
  expect(check(p, "screen_measurement").status).toBe("warn");
  expect(check(p, "timezone_measurement").status).toBe("warn");
  expect(assessFingerprintQuality(p, { now }).summary.fail).toBe(0);
});

test("invalid saved input is reported and credentials and error contents are never echoed", () => {
  const p = profile({ fingerprintSeed: 0, screenWidth: -1, timezone: "INVALID_TIMEZONE", locale: "%%%", proxyError: "PRIVATE_PROXY_PASSWORD" });
  const report = assessFingerprintQuality(p, { now });
  expect(report.status).toBe("issues");
  expect(report.summary.fail).toBe(5);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_PROXY_PASSWORD");
});

test("missing platform surfaces are unknown, including Firefox without client hints", () => {
  const p = profile({ fpObserved: measured({ uaChPlatform: undefined, platform: undefined }) });
  expect(check(p, "platform_consistency").status).toBe("unknown");
  const firefox = profile({ engine: "firefox", firefox: { version: 1, runtimeVersion: "test", config: {} }, fpObserved: measured({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/156.0", uaChPlatform: undefined }) });
  expect(check(firefox, "platform_consistency").status).toBe("pass");
});

test("stale, future, invalid and partial probes require review", () => {
  for (const capturedAt of ["bad-date", new Date(now - 8 * 86400000).toISOString(), new Date(now + 3600000).toISOString()]) {
    expect(assessFingerprintQuality(profile({ fpObserved: measured({ capturedAt }) }), { now }).status).toBe("review");
  }
  const p = profile({ fpObserved: measured({ errors: JSON.stringify({ canvas: "PRIVATE_ERROR_DETAIL" }) }) });
  expect(check(p, "sample_errors").status).toBe("warn");
  expect(JSON.stringify(assessFingerprintQuality(p, { now }))).not.toContain("PRIVATE_ERROR_DETAIL");
});

test("attestation with zero comparable fields cannot pass vacuously", () => {
  const p = profile({ fpObserved: measured(), fpExpected: { capturedAt: "2026-01-01" } });
  expect(check(p, "import_attestation").status).toBe("unknown");
  p.fpExpected = { canvas: "canvas-one", screen: "1920*1080" };
  expect(check(p, "import_attestation").status).toBe("pass");
  p.fpExpected.canvas = "canvas-other";
  expect(check(p, "import_attestation").status).toBe("warn");
});

test("legacy fingerprint rows remain readable in the quality GET and keep their original JSON", async () => {
  const store = new ProfileStore(":memory:");
  const p = profile();
  const valid = profile({ id: "test0002", fpObserved: measured() });
  const bad = { toString: 0, valueOf: 0, secret: "PRIVATE_LEGACY_RAW" };
  const observed = JSON.stringify({ ...measured(), screen: bad, languages: ["PRIVATE_LANG_ARRAY"], audio: bad, hardwareConcurrency: [8] });
  const expected = JSON.stringify({ canvas: "canvas-one", audio: "PRIVATE_EXPECTED_AUDIO", screen: bad });
  const database = (store as any).db;
  try {
    store.upsertProfile(p);
    store.upsertProfile(valid);
    database.query("UPDATE profiles SET fp_observed_json = ?, fp_expected_json = ? WHERE id = ?").run(observed, expected, p.id);
    const request = new Request("http://127.0.0.1:50400/ui/api/settings/fingerprints", { headers: { "X-Maobu-Settings": "1" } });
    const response = await handleUiRequest(request, {} as Launcher, store);
    expect(response?.status).toBe(200);
    const raw = await response!.text();
    const { reports } = JSON.parse(raw) as { reports: ReturnType<typeof assessFingerprintQuality>[] };
    expect(reports).toHaveLength(2);
    const legacy = reports.find(report => report.profileId === p.id)!;
    expect(legacy.checks.find(check => check.id === "screen_measurement")).toMatchObject({ status: "unknown", evidence: { actual: null } });
    expect(legacy.checks.find(check => check.id === "sample_coverage")).toMatchObject({ status: "unknown", detailMessage: { kind: "missing-surfaces", surfaces: ["languages", "hardwareConcurrency", "audio", "screen"] } });
    expect(legacy.checks.find(check => check.id === "import_attestation")?.status).toBe("unknown");
    expect(legacy.checks.some(check => check.id === "language_consistency")).toBe(false);
    for (const secret of ["PRIVATE_LEGACY_RAW", "PRIVATE_LANG_ARRAY", "PRIVATE_EXPECTED_AUDIO", "canvas-one"]) expect(raw).not.toContain(secret);
    expect(database.query("SELECT fp_observed_json, fp_expected_json FROM profiles WHERE id = ?").get(p.id)).toEqual({ fp_observed_json: observed, fp_expected_json: expected });
  } finally { store.close(); }
});

test("legacy fingerprint fields without a usable sample do not imply a measurement", () => {
  const malformed = { ua: ["legacy"], screen: { width: 1920 }, canvas: true, timezone: { name: "Asia/Shanghai" }, hardwareConcurrency: [8], capturedAt: 1794218400000 };
  const report = assessFingerprintQuality(profile({ fpObserved: malformed as unknown as Profile["fpObserved"] }), { now });
  expect(report.status).toBe("unmeasured");
  expect(report.measuredAt).toBeUndefined();
  expect(report.checks.find(check => check.id === "browser_sample")?.status).toBe("unknown");
});

test("import review counts real differences separately from missing or non-scalar observations", () => {
  const p = profile({ fpExpected: { canvas: "expected", audio: "expected-audio" }, fpObserved: measured({ audio: undefined }) });
  expect(check(p, "import_attestation")).toMatchObject({ status: "warn", detailMessage: { kind: "import-differences", count: 1 } });
});

test("partial samples do not become a complete pass through absent probe errors", () => {
  const p = profile({ fpObserved: measured({ canvas: undefined, audio: undefined, errors: "{}" }) });
  expect(check(p, "sample_coverage").status).toBe("unknown");
  expect(check(p, "sample_coverage").detailMessage).toEqual({ kind: "missing-surfaces", surfaces: ["canvas", "audio"] });
  expect(check(p, "sample_coverage").detail).toContain("Canvas and Audio");
  expect(assessFingerprintQuality(p, { now }).status).toBe("review");
});

test("measured mobile UA contradicts this desktop runtime even if stored UA was blank", () => {
  const p = profile({ fpObserved: measured({ ua: "Mozilla/5.0 (Linux; Android 14) Mobile Chrome/155" }) });
  expect(check(p, "measured_persona").status).toBe("fail");
});

test("screen readiness uses the same boundaries as profile persistence", () => {
  expect(check(profile({ screenWidth: 320, screenHeight: 200 }), "screen_config").status).toBe("pass");
  expect(check(profile({ screenWidth: 16385 }), "screen_config").status).toBe("fail");
});

test("a fresh sample cannot imply that pending or unknown launch inputs have taken effect", () => {
  const p = profile({ fpObserved: measured() });
  const launch = { profileId: p.id, pid: 123, debugPort: 9222, ws: "ws://fixture", startedAt: now - 1000 };
  const current = assessFingerprintQuality(p, { now, launchState: "current", launch, captureSource: createFingerprintSource(p, launch) });
  expect(current.status).toBe("consistent");
  expect(current.checks.find(item => item.id === "runtime_config")?.status).toBe("pass");
  for (const launchState of ["pending", "unknown"] as const) {
    const report = assessFingerprintQuality(p, { now, launchState });
    const runtime = report.checks.find(item => item.id === "runtime_config")!;
    expect(runtime.status).toBe(launchState === "pending" ? "warn" : "unknown");
    expect(runtime.recommendation).toBeTruthy();
    expect(report.status).toBe("review");
    expect(report.measuredAt).toBe(new Date(now).toISOString());
  }
  expect(assessFingerprintQuality(p, { now }).checks.find(item => item.id === "runtime_config")?.status).toBe("unknown");
});

test("Firefox processor expectations reuse the actual launch cap without changing saved hardware", () => {
  for (const [savedCores, hostCores] of [[32, 8], [4, 8], [8, 8]] as const) {
    const p = { ...buildNewProfile({ engine: "firefox", screen: "1920x1080", platformOs: "windows" }, () => false), hardware: { cores: savedCores }, fpObserved: measured() };
    const before = JSON.stringify(p), expected = firefoxLaunchConfig(p, undefined, undefined, undefined, undefined, undefined, hostCores)["navigator.hardwareConcurrency"] as number;
    expect(expected).toBe(Math.min(savedCores, hostCores));
    expect(firefoxLaunchHardwareConcurrency(p.firefox!.config, p.hardware, hostCores)).toBe(expected);
    p.fpObserved.hardwareConcurrency = expected;
    const stable = JSON.stringify(p);
    const report = assessFingerprintQuality(p, { now, launchState: "current", hostCores });
    expect(report.checks.find(check => check.id === "hardware_configuration")?.status).toBe("pass");
    expect(p.hardware.cores).toBe(savedCores); expect(JSON.stringify(p)).toBe(stable);
    expect(JSON.parse(before).hardware.cores).toBe(savedCores);
    p.fpObserved.hardwareConcurrency = expected + 1;
    expect(assessFingerprintQuality(p, { now, launchState: "current", hostCores }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("fail");
    expect(assessFingerprintQuality(p, { now, launchState: "pending", hostCores }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("warn");
  }
});

test("Chromium expectations follow emitted launch arguments, retaining the uncapped CloakBrowser policy", () => {
  for (const runtime of ["aliasmode", undefined]) {
    const p = profile({ chromiumRuntime: runtime as "aliasmode" | undefined, hardware: { cores: 32 }, fpObserved: measured() });
    const expected = Number(deriveFingerprintFlags(p, 8).find(flag => flag.startsWith("--fingerprint-hardware-concurrency="))!.split("=")[1]);
    expect(expected).toBe(runtime ? 8 : 32); p.fpObserved!.hardwareConcurrency = expected;
    expect(assessFingerprintQuality(p, { now, launchState: "current", hostCores: 8 }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("pass");
    p.fpObserved!.hardwareConcurrency = runtime ? 32 : 8;
    expect(assessFingerprintQuality(p, { now, launchState: "current", hostCores: 8 }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("fail");
  }
});

test("missing Firefox identity and invalid expected or observed processor counts remain unknown", () => {
  const valid = { ...buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false), hardware: { cores: 32 }, fpObserved: measured({ hardwareConcurrency: 8 }) };
  const cases = [
    { ...valid, firefox: undefined }, { ...valid, firefox: { ...valid.firefox!, config: null } },
    { ...valid, hardware: { cores: 0 } }, { ...valid, hardware: { cores: NaN } },
    { ...valid, hardware: { cores: 8 }, fpObserved: measured({ hardwareConcurrency: undefined }) },
    { ...valid, hardware: { cores: 8 }, fpObserved: measured({ hardwareConcurrency: "8" as any }) },
  ];
  for (const candidate of cases) expect(assessFingerprintQuality(candidate as Profile, { now, launchState: "current", hostCores: 8 }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("unknown");
  for (const hostCores of [0, -1, NaN, Infinity, 1.5]) expect(assessFingerprintQuality(valid, { now, hostCores }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("unknown");
  // An automatic Firefox identity may be graphics-fitted at launch; do not invent a typed hardware check.
  expect(assessFingerprintQuality({ ...valid, hardware: undefined }, { now }).checks.some(check => check.id === "hardware_configuration")).toBe(false);
});

test("English report text and safe evidence share the comparison's effective values", () => {
  const p = profile({ chromiumRuntime: "aliasmode", hardware: { cores: 32 }, fpObserved: measured({ hardwareConcurrency: 32, language: "en-US" }) });
  const report = assessFingerprintQuality(p, { now, launchState: "pending", hostCores: 8 });
  const processors = report.checks.find(item => item.id === "hardware_configuration")!;
  expect(processors.status).toBe("warn");
  expect(processors.evidence).toEqual({ kind: "processors", expected: 8, actual: 32, saved: 32, hostAvailable: 8 });
  expect(report.checks.find(item => item.id === "locale_configuration")?.evidence).toEqual({ kind: "locale", expected: "zh-CN", actual: "en-US" });
  expect(report.checks.find(item => item.id === "platform_configuration")?.evidence).toEqual({ kind: "platform", expected: "windows", actual: "windows" });
  expect(report.checks.every(item => !/[\u3400-\u9fff]/.test([item.label, item.detail, item.recommendation ?? ""].join(" ")))).toBe(true);
});

test("evidence and fallback text omit raw fingerprints, private locale extensions and malformed timestamps", () => {
  const p = profile({ locale: "en-US-u-ca-gregory", fpObserved: measured({ language: "en-US-x-PRIVATE-device", capturedAt: "PRIVATE_TIMESTAMP", canvas: "PRIVATE_CANVAS_HASH", audio: "PRIVATE_AUDIO_HASH", webglRenderer: "PRIVATE_RENDERER", ua: "Mozilla/5.0 Windows PRIVATE_USER_AGENT", errors: '{"canvas":"PRIVATE_PROBE_ERROR"}' }) });
  const report = assessFingerprintQuality(p, { now, launchState: "current" });
  expect(report.checks.find(item => item.id === "locale_configuration")?.status).toBe("fail");
  expect(report.checks.find(item => item.id === "locale_configuration")?.evidence).toEqual({ kind: "locale", expected: "en-US", actual: "en-US", detailsOmitted: true });
  expect(report.measuredAt).toBeUndefined();
  const serialized = JSON.stringify(report);
  for (const secret of ["PRIVATE", "fingerprintSeed", "configurationDigest", "launchDigest", "userDataDir", "ws://"]) expect(serialized).not.toContain(secret);
  expect(report.checks.find(item => item.id === "sample_errors")?.detailMessage).toEqual({ kind: "probe-errors", count: 1 });
});
