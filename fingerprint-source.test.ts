import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNewProfile } from "./create.ts";
import { ProfileStore } from "./store.ts";
import { assessFingerprintQuality } from "./fingerprint-quality.ts";
import { createFingerprintSource, fingerprintConfigurationDigest, FINGERPRINT_SOURCE_FIELDS } from "./fingerprint-source.ts";
import { launchPersona, LAUNCH_PERSONA_KEYS } from "./launcher.ts";
import type { ObservedFingerprint } from "./types.ts";

function fixture() {
  const profile = { ...buildNewProfile({ engine: "chromium", chromiumRuntime: "cloakbrowser", platformOs: "windows", screen: "1920x1080", name: "Source fixture" }, () => false), hardware: { cores: 8 }, timezone: "UTC", locale: "en-US", proxy: { type: "http" as const, host: "127.0.0.1", port: "7890", user: "private-proxy-user", pass: "private-proxy-password" } };
  const launch = { profileId: profile.id, pid: 123, debugPort: 9222, ws: "ws://fixture", startedAt: Date.now() - 1000, persona: launchPersona(profile) };
  const observed: ObservedFingerprint = { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0", platform: "Win32", uaChPlatform: "Windows", screen: "1920*1080", availableScreen: "1920*1040", hardwareConcurrency: 8, languages: "en-US,en", language: "en-US", timezone: "UTC", canvas: "canvas-one", audio: "audio-one", webglVendor: "Google Inc.", webglRenderer: "ANGLE (NVIDIA)", capturedAt: new Date().toISOString() };
  const store = new ProfileStore(":memory:"); store.upsertProfile(profile); store.recordLaunch(launch);
  const source = createFingerprintSource(store.getProfile(profile.id)!, launch);
  return { profile: store.getProfile(profile.id)!, launch, observed, store, source };
}

test("source covers launch identity inputs without treating renames as identity changes", () => {
  const f = fixture();
  try {
    expect([...FINGERPRINT_SOURCE_FIELDS].sort()).toEqual(LAUNCH_PERSONA_KEYS.filter(key => key !== "platform").sort());
    expect(fingerprintConfigurationDigest({ ...f.profile, name: "Renamed", password: "new-account-password", group: "New folder" })).toBe(f.source.configurationDigest);
    expect(fingerprintConfigurationDigest({ ...f.profile, fingerprintSeed: f.profile.fingerprintSeed + 1 })).not.toBe(f.source.configurationDigest);
    expect(fingerprintConfigurationDigest({ ...f.profile, proxy: { ...f.profile.proxy!, pass: "new-private-proxy-password" } })).not.toBe(f.source.configurationDigest);
    expect(JSON.stringify(f.source)).not.toContain("private-proxy");
  } finally { f.store.close(); }
});

test("local provenance is private, preserved on rename, and cannot be supplied by imported observations", () => {
  const f = fixture();
  try {
    expect(f.store.saveObservedFingerprint(f.profile.id, f.observed, null, f.store.getProfileIncarnation(f.profile.id)!, f.source)).toBe(true);
    expect(f.store.getFingerprintSource(f.profile.id)).toEqual(f.source);
    expect(JSON.stringify(f.store.getProfile(f.profile.id))).not.toContain("configurationDigest");
    f.store.upsertProfile({ ...f.store.getProfile(f.profile.id)!, name: "Renamed" });
    expect(f.store.getFingerprintSource(f.profile.id)).toEqual(f.source);
    f.store.upsertProfile({ ...f.store.getProfile(f.profile.id)!, fpObserved: { ...f.observed, canvas: "external-observation" } });
    expect(f.store.getFingerprintSource(f.profile.id)).toBeNull();
    f.store.upsertProfile({ ...f.profile, id: "source02", fpObserved: f.observed, fpCaptureSource: f.source } as any);
    expect(f.store.getFingerprintSource("source02")).toBeNull();
  } finally { f.store.close(); }
});

test("new browser generations and changed identity configurations cannot reuse an earlier pass", () => {
  const f = fixture();
  try {
    f.store.saveObservedFingerprint(f.profile.id, f.observed, null, f.store.getProfileIncarnation(f.profile.id)!, f.source);
    const assess = () => assessFingerprintQuality(f.store.getProfile(f.profile.id)!, { launchState: "current", launch: f.store.getLaunch(f.profile.id), captureSource: f.store.getFingerprintSource(f.profile.id) });
    expect(assess().status).toBe("consistent");
    f.store.recordLaunch({ ...f.launch, pid: 124, startedAt: Date.now() });
    expect(assess().checks.find(check => check.id === "capture_source")?.status).toBe("warn");
    expect(assess().status).toBe("review");
    f.store.upsertProfile({ ...f.store.getProfile(f.profile.id)!, fingerprintSeed: f.profile.fingerprintSeed + 1 });
    expect(assess().status).toBe("review");
    expect(assess().checks.find(check => check.id === "capture_source")?.detail).toContain("different identity configuration");
  } finally { f.store.close(); }
});

test("source persistence compares both browser generation and profile incarnation atomically", () => {
  const f = fixture();
  try {
    const incarnation = f.store.getProfileIncarnation(f.profile.id)!;
    f.store.saveObservedFingerprint(f.profile.id, f.observed, null, incarnation, f.source);
    f.store.recordLaunch({ ...f.launch, startedAt: f.launch.startedAt + 1 });
    expect(f.store.saveObservedFingerprint(f.profile.id, { ...f.observed, canvas: "wrong-generation" }, null, incarnation, f.source)).toBe(false);
    expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("canvas-one");
    f.store.deleteProfile(f.profile.id); f.store.upsertProfile(f.profile); f.store.recordLaunch(f.launch);
    expect(f.store.saveObservedFingerprint(f.profile.id, f.observed, null, incarnation, f.source)).toBe(false);
    expect(f.store.getFingerprintSource(f.profile.id)).toBeNull();
  } finally { f.store.close(); }
});

test("old databases migrate source metadata to unknown while preserving existing observations", () => {
  const path = join(mkdtempSync(join(tmpdir(), "maobu-fp-source-")), "profiles.sqlite");
  const f = fixture(); const original = new ProfileStore(path);
  original.upsertProfile(f.profile); original.saveObservedFingerprint(f.profile.id, f.observed, null); original.close(); f.store.close();
  const legacy = new Database(path); legacy.exec("ALTER TABLE profiles DROP COLUMN fp_source_json"); legacy.close();
  const migrated = new ProfileStore(path);
  try {
    const profile = migrated.getProfile(f.profile.id)!;
    expect(profile.fpObserved?.canvas).toBe("canvas-one");
    expect(migrated.getFingerprintSource(profile.id)).toBeNull();
    const report = assessFingerprintQuality(profile, { launchState: "current" });
    expect(report.status).toBe("review");
    expect(report.checks.find(check => check.id === "capture_source")?.status).toBe("unknown");
  } finally { migrated.close(); }
});

test("a coherent measured persona must also match its intended platform, hardware and locale", () => {
  const f = fixture();
  try {
    const profile = { ...f.profile, fpObserved: { ...f.observed, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/155.0.0.0", platform: "MacIntel", uaChPlatform: "macOS", hardwareConcurrency: 128, language: "fr-FR", languages: "fr-FR,fr" } };
    const report = assessFingerprintQuality(profile, { launchState: "current", launch: f.launch, captureSource: f.source });
    expect(report.status).toBe("issues");
    for (const id of ["platform_configuration", "hardware_configuration", "locale_configuration"]) expect(report.checks.find(check => check.id === id)?.status).toBe("fail");
    const pending = assessFingerprintQuality(profile, { launchState: "pending", launch: f.launch, captureSource: f.source });
    for (const id of ["platform_configuration", "hardware_configuration", "locale_configuration"]) expect(pending.checks.find(check => check.id === id)?.status).toBe("warn");
    const capped = assessFingerprintQuality({ ...f.profile, chromiumRuntime: "aliasmode", fpObserved: { ...f.observed, hardwareConcurrency: 4 } }, { launchState: "current", hostCores: 4 });
    expect(capped.checks.find(check => check.id === "hardware_configuration")?.status).toBe("pass");
    for (const profile of [
      { ...f.profile, hardware: { cores: 16 }, fpObserved: { ...f.observed, hardwareConcurrency: 16 } },
      { ...f.profile, engine: "firefox" as const, firefox: { version: 1 as const, runtimeVersion: "fixture", config: {} }, hardware: { cores: 16 }, fpObserved: { ...f.observed, hardwareConcurrency: 4 } },
    ]) expect(assessFingerprintQuality(profile, { launchState: "current", hostCores: 4 }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("pass");
    const uncappedFirefoxSample = { ...f.profile, engine: "firefox" as const, firefox: { version: 1 as const, runtimeVersion: "fixture", config: {} }, hardware: { cores: 16 }, fpObserved: { ...f.observed, hardwareConcurrency: 16 } };
    expect(assessFingerprintQuality(uncappedFirefoxSample, { launchState: "current", hostCores: 4 }).checks.find(check => check.id === "hardware_configuration")?.status).toBe("fail");
  } finally { f.store.close(); }
});
