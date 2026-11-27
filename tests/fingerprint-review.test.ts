import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "../create.ts";
import { reviewRunningFingerprint } from "../fingerprint-review.ts";
import { ProfileStore } from "../store.ts";
import type { FingerprintSample } from "../diagnose.ts";
import { launchPersona } from "../launcher.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new ProfileStore(":memory:"); stores.push(store);
  const profile = { ...buildNewProfile({ name: "Research", password: "private-account" }, () => false), id: "review01" };
  store.upsertProfile(profile);
  store.saveObservedFingerprint(profile.id, { canvas: "previous", capturedAt: "2026-01-01T00:00:00Z" }, null);
  const launch = { profileId: profile.id, pid: 123, debugPort: 9222, ws: "ws://127.0.0.1:9222/private-browser", startedAt: 100, persona: { proxy: null } };
  store.recordLaunch(launch);
  return { store, profile, launch, launcher: { certifiedActive: async () => true } };
}
const sample: FingerprintSample = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0", platform: "Win32", canvasHash: "canvas-live", audioHash: "audio-live", timezone: "Asia/Shanghai", language: "zh-CN", languages: ["zh-CN"], screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, dpr: 1 } };
test("measurement preserves profile identity and secrets while recording current evidence", async () => {
  const f = fixture(); let endpoint = "";
  const report = await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async ws => { endpoint = ws; return sample; }, now: () => Date.parse("2026-11-09T00:00:00Z") });
  expect(endpoint).toBe(f.launch.ws);
  expect(report.measuredAt).toBe("2026-11-09T00:00:00.000Z");
  expect(f.store.getProfile(f.profile.id)?.fpObserved).toMatchObject({ canvas: "canvas-live", audio: "audio-live", webrtc: "default_public_interface_only" });
  expect(f.store.getProfile(f.profile.id)?.password).toBe("private-account");
  expect(f.store.getProfile(f.profile.id)?.fingerprintSeed).toBe(f.profile.fingerprintSeed);
  expect(JSON.stringify(report)).not.toContain("private-account"); expect(JSON.stringify(report)).not.toContain("private-browser");
});

test("legacy fingerprint expectations do not prevent a real SQLite remeasurement or invent a verdict", async () => {
  const f = fixture();
  const database = (f.store as any).db;
  const expected = JSON.stringify({ screen: { toString: 0, valueOf: 0, secret: "PRIVATE_OLD_EXPECTATION" }, canvas: ["canvas-live"], audio: true });
  const old = JSON.stringify({ screen: { width: 1920 }, languages: ["zh-CN"], canvas: "previous" });
  database.query("UPDATE profiles SET fp_expected_json = ?, fp_observed_json = ?, fp_verdict_json = ? WHERE id = ?")
    .run(expected, old, JSON.stringify({ verdict: "match", differences: [] }), f.profile.id);
  const report = await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample });
  const saved = f.store.getProfile(f.profile.id)!;
  expect(saved.fpObserved).toMatchObject({ canvas: "canvas-live", screen: "1920*1080", languages: "zh-CN" });
  expect(saved.fpVerdict).toBeUndefined();
  expect(report.checks.find(check => check.id === "import_attestation")?.status).toBe("unknown");
  expect(JSON.stringify(report)).not.toContain("PRIVATE_OLD_EXPECTATION");
  expect(database.query("SELECT fp_expected_json FROM profiles WHERE id = ?").get(f.profile.id).fp_expected_json).toBe(expected);
});
test("a closed or uncertified browser is never opened or sampled", async () => {
  const f = fixture(); let captures = 0;
  const capture = async () => { captures++; return sample; };
  await expect(reviewRunningFingerprint(f.profile.id, f.store, { certifiedActive: async () => false }, { capture })).rejects.toThrow("could not be certified");
  await expect(reviewRunningFingerprint("missing01", f.store, f.launcher, { capture })).rejects.toThrow("Profile not found");
  f.store.clearLaunch(f.profile.id);
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture })).rejects.toThrow("Open this profile");
  expect(captures).toBe(0); expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
});
test("measurement failures and empty probes preserve previous evidence without raw errors", async () => {
  const f = fixture();
  for (const value of [null, {}, { errors: { canvas: "private-browser-error" } }, { userAgent: "" }]) {
    await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => value })).rejects.toThrow("previous measurement was preserved");
  }
  try { await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => { throw new Error("private-token"); } }); }
  catch (error) { expect(String(error)).not.toContain("private-token"); }
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample })).resolves.toBeDefined();
});
test("browser restart or profile deletion during measurement cannot overwrite the surviving identity", async () => {
  const f = fixture();
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => { f.store.recordLaunch({ ...f.launch, pid: 124, startedAt: 200 }); return sample; } })).rejects.toThrow("browser changed");
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => { f.store.deleteProfile(f.profile.id); return sample; } })).rejects.toThrow("browser changed");
  expect(f.store.getProfile(f.profile.id)).toBe(null);
});
test("concurrent measurements for the same profile are rejected and the lock is released", async () => {
  const f = fixture(); let release!: (value: FingerprintSample) => void;
  const held = new Promise<FingerprintSample>(resolve => { release = resolve; });
  const pending = reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: () => held });
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample })).rejects.toThrow("already running");
  release(sample); await pending;
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample })).resolves.toBeDefined();
});

test("certification is bound before the first await and rechecked after capture", async () => {
  const f = fixture(); let captures = 0, certifications = 0;
  await expect(reviewRunningFingerprint(f.profile.id, f.store, {
    certifiedActive: async () => { f.store.recordLaunch({ ...f.launch, pid: 999, startedAt: 999 }); return true; },
  }, { capture: async () => { captures++; return sample; } })).rejects.toThrow("browser changed");
  expect(captures).toBe(0);
  f.store.recordLaunch(f.launch);
  await reviewRunningFingerprint(f.profile.id, f.store, { certifiedActive: async () => { certifications++; return true; } }, { capture: async () => sample });
  expect(certifications).toBe(2);
});

test("losing certification or generation during the final check preserves the previous measurement", async () => {
  for (const changeGeneration of [false, true]) {
    const f = fixture(); let checks = 0;
    await expect(reviewRunningFingerprint(f.profile.id, f.store, { certifiedActive: async () => {
      checks++;
      if (checks === 2 && changeGeneration) f.store.recordLaunch({ ...f.launch, rootStartTime: "new-process-start" });
      return checks === 1 || changeGeneration;
    } }, { capture: async () => sample })).rejects.toThrow(changeGeneration ? "browser changed" : "could not be certified");
    expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  }
});

test("precise process ownership changes are rejected even when PID and endpoint are reused", async () => {
  for (const patch of [{ rootStartTime: "new-root" }, { processGroupId: 456 }, { debugPort: 9333 }, { binaryPath: "C:\\replacement.exe" }, { personaDigest: "replacement-persona" }]) {
    const f = fixture();
    await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => {
      f.store.recordLaunch({ ...f.launch, ...patch }); return sample;
    } })).rejects.toThrow("browser changed");
    expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  }
});

test("deleting and recreating the same ID with the same launch cannot receive an old measurement", async () => {
  const f = fixture(); const originalIncarnation = f.store.getProfileIncarnation(f.profile.id);
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => {
    f.store.trashProfile(f.profile.id); f.store.deleteProfile(f.profile.id);
    f.store.upsertProfile(f.profile); f.store.recordLaunch(f.launch);
    f.store.saveObservedFingerprint(f.profile.id, { canvas: "replacement-evidence" }, null);
    return sample;
  } })).rejects.toThrow("browser changed");
  expect(f.store.getProfileIncarnation(f.profile.id)).not.toBe(originalIncarnation);
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("replacement-evidence");
});

test("a profile moved to Trash while sampling retains its earlier report when restored", async () => {
  const f = fixture();
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => {
    f.store.trashProfile(f.profile.id); return sample;
  } })).rejects.toThrow("browser changed");
  f.store.restoreProfile(f.profile.id);
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
});

test("malformed samples cannot replace valid evidence or computed verdicts", async () => {
  const f = fixture();
  f.store.saveObservedFingerprint(f.profile.id, { canvas: "previous" }, { verdict: "match", differences: [] });
  const malformed: unknown[] = [
    { userAgent: 123 }, { userAgent: sample.userAgent, languages: "zh-CN" },
    { userAgent: sample.userAgent, languages: [42] }, { userAgent: sample.userAgent, hardwareConcurrency: NaN },
    { userAgent: sample.userAgent, hardwareConcurrency: 1.5 }, { userAgent: sample.userAgent, errors: { canvas: {} } },
    { canvasHash: "valid", screen: { ...sample.screen, width: 0 } },
    { canvasHash: "valid", screen: { width: 1920, height: 1080 } },
    { userAgent: "x".repeat(4097) }, { userAgent: "ua\nprivate" },
  ];
  for (const value of malformed) {
    await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => value as FingerprintSample })).rejects.toThrow("invalid data");
  }
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  expect(f.store.getProfile(f.profile.id)?.fpVerdict?.verdict).toBe("match");
});

test("valid partial evidence stays explicitly incomplete and raw page errors are never stored", async () => {
  const f = fixture();
  const report = await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => ({ canvasHash: "partial-canvas", errors: { audio: "ws://private-endpoint secret-token" } }) });
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("partial-canvas");
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.errors).not.toContain("secret-token");
  expect(report.checks.find(check => check.id === "sample_coverage")?.status).toBe("unknown");
  expect(report.status).not.toBe("consistent");
});

test("unrelated profile writes do not invalidate a valid measurement", async () => {
  const f = fixture();
  const report = await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => {
    f.store.upsertProfile({ ...f.profile, id: "unrelated01", name: "Another environment" }); return sample;
  } });
  expect(report.measuredAt).toBeTruthy();
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("canvas-live");
});

test("a seed edit during capture leaves the live measurement explicitly pending a browser restart", async () => {
  const f = fixture();
  f.store.recordLaunch({ ...f.launch, persona: launchPersona(f.store.getProfile(f.profile.id)!) });
  const report = await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => {
    const current = f.store.getProfile(f.profile.id)!;
    f.store.upsertProfile({ ...current, fingerprintSeed: current.fingerprintSeed === 0xffffffff ? 1 : current.fingerprintSeed + 1 });
    return sample;
  } });
  expect(report.measuredAt).toBeTruthy();
  expect(report.checks.find(item => item.id === "runtime_config")?.status).toBe("warn");
  expect(report.status).not.toBe("consistent");
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("canvas-live");
});

test("certification and persistence errors remain explainable and never expose raw secrets", async () => {
  const f = fixture();
  try { await reviewRunningFingerprint(f.profile.id, f.store, { certifiedActive: async () => { throw new Error("private-cert-token"); } }, { capture: async () => sample }); }
  catch (error) { expect(String(error)).toContain("could not be certified"); expect(String(error)).not.toContain("private-cert-token"); }
  const save = f.store.saveObservedFingerprint.bind(f.store);
  f.store.saveObservedFingerprint = (() => { throw new Error("private-database-token"); }) as typeof f.store.saveObservedFingerprint;
  try { await reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample }); }
  catch (error) { expect(String(error)).toContain("could not be saved"); expect(String(error)).not.toContain("private-database-token"); }
  expect(f.store.getProfile(f.profile.id)?.fpObserved?.canvas).toBe("previous");
  f.store.saveObservedFingerprint = save;
  await expect(reviewRunningFingerprint(f.profile.id, f.store, f.launcher, { capture: async () => sample })).resolves.toBeDefined();
});
