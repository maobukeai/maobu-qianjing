import { expect, test } from "bun:test";
import { buildStoredFingerprintReport } from "./fingerprint-report.ts";
import { assessFingerprintQuality } from "./fingerprint-quality.ts";
import { createFingerprintSource } from "./fingerprint-source.ts";
import { launchPersona } from "./launcher.ts";
import type { LaunchInfo, ObservedFingerprint, Profile } from "./types.ts";

const now = Date.parse("2026-11-09T10:00:00Z");
function profile(overrides: Partial<Profile> = {}): Profile {
  const observed: ObservedFingerprint = {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0", platform: "Win32", uaChPlatform: "Windows",
    screen: "1600*900", availableScreen: "1600*860", timezone: "Asia/Shanghai", language: "en-US", languages: "en-US,en",
    hardwareConcurrency: 4, webglVendor: "Google Inc.", webglRenderer: "ANGLE (NVIDIA)", canvas: "real-canvas-sample", audio: "real-audio-sample",
    capturedAt: new Date(now).toISOString(),
  };
  return { id: "review-1", accId: "", name: "Isolated review", group: "", engine: "chromium", chromiumRuntime: "aliasmode",
    username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", emailPassword: "PRIVATE_EMAIL_PASSWORD", twofa: "PRIVATE_2FA",
    proxy: { type: "http", host: "private-proxy.example", port: "8080", user: "PRIVATE_PROXY_USER", pass: "PRIVATE_PROXY_PASSWORD" },
    hardware: { cores: 4 }, ua: observed.ua!, timezone: "Asia/Shanghai", locale: "en-US", platformOs: "windows", screenWidth: 1600, screenHeight: 900,
    fingerprintSeed: 192837, cookies: [{ name: "session", value: "PRIVATE_COOKIE", domain: ".example.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    seeded: false, fpObserved: observed, ...overrides };
}
function launch(p: Profile, overrides: Partial<LaunchInfo> = {}): LaunchInfo {
  return { profileId: p.id, pid: 123, debugPort: 9333, ws: "ws://127.0.0.1:9333/PRIVATE_ENDPOINT", startedAt: now - 1000,
    binaryPath: "PRIVATE_BINARY_PATH", userDataDir: "PRIVATE_PROFILE_DIRECTORY", persona: launchPersona(p), ...overrides };
}
const check = (review: ReturnType<typeof buildStoredFingerprintReport>, id: string) => review.report.checks.find(item => item.id === id)!;

test("stored reports share the existing settings quality semantics without returning liveness certification", () => {
  const p = profile(), recorded = launch(p), source = createFingerprintSource(p, recorded);
  const result = buildStoredFingerprintReport(p, { launch: recorded, captureSource: source, now, hostCores: 4 });
  expect(result).toEqual({
    report: { name: p.name, ...assessFingerprintQuality(p, { launchState: "current", launch: recorded, captureSource: source, now, hostCores: 4 }) },
    launchRecordPresent: true, liveness: "not-checked",
  });
  expect(result.report.status).toBe("consistent");
  expect(result).not.toHaveProperty("running");
  expect(result.report).not.toHaveProperty("running");
});

test("saved edits are pending configuration evidence rather than an active browser measurement", () => {
  const original = profile(), recorded = launch(original), source = createFingerprintSource(original, recorded);
  const edited = { ...original, screenWidth: 1440, fingerprintSeed: 192838 };
  const result = buildStoredFingerprintReport(edited, { launch: recorded, captureSource: source, now });
  expect(check(result, "runtime_config").status).toBe("warn");
  expect(check(result, "capture_source").status).toBe("warn");
  expect(check(result, "screen_measurement").status).toBe("warn");
  expect(result.report.status).toBe("review");
  expect(result.liveness).toBe("not-checked");
});

test("a missing or legacy launch record never asserts the browser has closed or its configuration is applied", () => {
  const p = profile();
  for (const recorded of [null, launch(p, { persona: undefined })]) {
    const result = buildStoredFingerprintReport(p, { launch: recorded, now });
    expect(result.launchRecordPresent).toBe(!!recorded);
    expect(result.liveness).toBe("not-checked");
    expect(check(result, "runtime_config").status).toBe("unknown");
    expect(check(result, "capture_source").status).toBe("unknown");
    expect(result.report.status).toBe("review");
    expect(JSON.stringify(result)).not.toContain('"closed"');
  }
});

test("a launch from another profile cannot certify this profile's runtime configuration", () => {
  const p = profile(), other = launch(p, { profileId: "other-profile" });
  const result = buildStoredFingerprintReport(p, { launch: other, now });
  expect(result.launchRecordPresent).toBe(false);
  expect(check(result, "runtime_config").status).toBe("unknown");
});

test("legacy measurements remain unknown and no measurements are manufactured for unsampled profiles", () => {
  const p = profile(), recorded = launch(p);
  expect(check(buildStoredFingerprintReport(p, { launch: recorded, now }), "capture_source").status).toBe("unknown");
  const result = buildStoredFingerprintReport(profile({ fpObserved: undefined }), { launch: recorded, now });
  expect(result.report.status).toBe("unmeasured");
  expect(check(result, "browser_sample").status).toBe("unknown");
  expect(result.report.measuredAt).toBeUndefined();
});

test("report inputs remain unchanged and account secrets, raw samples and private source hashes are omitted", () => {
  const p = profile(), recorded = launch(p), source = createFingerprintSource(p, recorded);
  p.fpObserved!.errors = JSON.stringify({ canvas: "PRIVATE_PROBE_ERROR" });
  const before = JSON.stringify({ p, recorded, source });
  const result = buildStoredFingerprintReport(p, { launch: recorded, captureSource: source, now, hostCores: 4 });
  expect(JSON.stringify({ p, recorded, source })).toBe(before);
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE_USER", "PRIVATE_PASSWORD", "PRIVATE_EMAIL_PASSWORD", "PRIVATE_2FA", "PRIVATE_PROXY_USER", "PRIVATE_PROXY_PASSWORD", "PRIVATE_COOKIE", "PRIVATE_ENDPOINT", "PRIVATE_BINARY_PATH", "PRIVATE_PROFILE_DIRECTORY", "PRIVATE_PROBE_ERROR", "private-proxy.example", "real-canvas-sample", "real-audio-sample", source.configurationDigest, source.launchDigest!]) expect(serialized).not.toContain(secret);
  expect(Object.keys(result).sort()).toEqual(["launchRecordPresent", "liveness", "report"]);
  expect(check(result, "sample_errors").status).toBe("warn");
});

test("the shared report forwards the actual host limit to the existing hardware quality check", () => {
  const p = profile({ hardware: { cores: 16 } }), recorded = launch(p);
  const source = createFingerprintSource(p, recorded);
  const result = buildStoredFingerprintReport(p, { launch: recorded, captureSource: source, now, hostCores: 4 });
  expect(check(result, "hardware_configuration").status).toBe("pass");
});
