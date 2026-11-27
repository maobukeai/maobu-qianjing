import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../aliasmode-chromium.ts";
import { AppSettingsStore } from "../app-settings.ts";
import { applyChromiumPreloadingPreference, CHROMIUM_PRELOADING_RECORD } from "../chromium-preloading-preferences.ts";
import { buildNewProfile } from "../create.ts";
import { handleFeatureSettingsRequest } from "../feature-settings.ts";
import { BrowserLaunchError, Launcher } from "../launcher.ts";
import { statePaths } from "../paths.ts";
import { ProfileStore } from "../store.ts";

const parent = resolve(import.meta.dir, "..", "node_modules/.cache/launcher-preloading-tests"), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(parent + sep)) throw new Error("Unsafe synthetic test cleanup"); rmSync(root, { recursive: true, force: true }); } });
function fixture(initial: unknown = { net: { network_prediction_options: 3, keep: true } }) {
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "case-")); roots.push(root);
  const paths = statePaths(root), settings = new AppSettingsStore(join(root, "app-settings.json")), store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", name: "Synthetic preloading" }, () => false);
  store.upsertProfile(profile); const userDataDir = join(paths.profiles, profile.id), preferences = join(userDataDir, "Default", "Preferences"), record = join(userDataDir, CHROMIUM_PRELOADING_RECORD);
  mkdirSync(join(userDataDir, "Default"), { recursive: true }); writeFileSync(preferences, JSON.stringify(initial));
  let spawned = 0, getterReads = 0, verifications = 0, holders = 0;
  const launcher = new Launcher({ store, dataRoot: paths.profiles, binaryPath: join(root, "non-executable-fixture"), expectedBinarySha256: "a".repeat(64),
    hostPlatform: "win32", hostArch: "x64", headless: true, portProbe: () => true,
    chromiumPreloading: () => { getterReads++; return settings.read().network?.chromiumPreloading ?? "browser-default"; },
    findProfileDirHolderPids: async () => { holders++; return []; }, findOwnedBrowserPids: async () => [], isPidAlive: () => false,
    fetch: async () => ({ ok: false, json: async () => ({}) }), cdpReadyTimeoutMs: 1_000, teardownPollMs: 1, teardownTimeoutMs: 100,
    lookupExitLocation: async () => null, captureFingerprint: async () => null,
    spawn: () => { spawned++; return { pid: 0, kill() {}, spawnFailed: Promise.resolve("Fixture proves no browser was executed") }; },
    log: () => {},
  });
  // Stub only the existing authority boundary. No fake executable runs and no production
  // gate is disabled. Separate opt-in real-engine coverage verifies the actual pinned asset.
  (launcher as any).verifyConfiguredBinary = async (_force: boolean, kind: string) => { verifications++; return { path: join(root, "non-executable-fixture"), sha256: kind === "aliasmode" ? ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 : "a".repeat(64) }; };
  async function startFailure() {
    try { await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false }); throw new Error("Fixture must never execute a browser"); }
    catch (error) { expect(error).toBeInstanceOf(BrowserLaunchError); return error as BrowserLaunchError; }
  }
  return { root, paths, settings, store, profile, userDataDir, preferences, record, launcher, startFailure,
    counts: () => ({ spawned, getterReads, verifications, holders }), read: () => JSON.parse(readFileSync(preferences, "utf8")),
    patch: (mode: string, origin?: string) => handleFeatureSettingsRequest(new Request("http://127.0.0.1:50400/ui/api/settings", { method: "PATCH", headers: { "X-Maobu-Settings": "1", "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ network: { chromiumPreloading: mode } }) }), store, { paths }),
  };
}

test("workspace HTTP intent reaches the next verified fresh launch, restores exact original and keeps other preferences", async () => {
  const item = fixture();
  try {
    const response = await item.patch("disabled"); expect(response!.status).toBe(200);
    expect((await response!.json()).settings.network.chromiumPreloading).toBe("disabled");
    expect(item.read().net.network_prediction_options).toBe(3); // Saving never touches a profile.
    expect((await item.startFailure()).failure).toBe("process_spawn");
    expect(item.read().net).toEqual({ network_prediction_options: 2, keep: true }); expect(existsSync(item.record)).toBe(true);
    expect(item.counts()).toEqual({ spawned: 1, getterReads: 1, verifications: 2, holders: 1 });
    expect((await item.patch("browser-default"))!.status).toBe(200);
    expect(item.read().net.network_prediction_options).toBe(2);
    expect((await item.startFailure()).failure).toBe("process_spawn");
    expect(item.read().net).toEqual({ network_prediction_options: 3, keep: true }); expect(existsSync(item.record)).toBe(false);
    expect(item.store.getLaunch(item.profile.id)).toBeNull();
  } finally { item.store.close(); }
});

test("invalid/cross-origin settings writes preserve workspace intent and never touch profiles", async () => {
  const item = fixture();
  try {
    expect((await item.patch("off"))!.status).toBe(400);
    expect((await item.patch("disabled", "https://outside.invalid"))!.status).toBe(403);
    expect(existsSync(item.settings.path)).toBe(false); expect(item.read().net.network_prediction_options).toBe(3); expect(item.counts().spawned).toBe(0);
  } finally { item.store.close(); }
});

test("explicit disabled and pending restoration refuse corrupt Preferences before legacy repair", async () => {
  for (const restore of [false, true]) {
    const item = fixture();
    try {
      item.settings.patch({ network: { chromiumPreloading: "disabled" } });
      if (restore) { expect(applyChromiumPreloadingPreference({ profilesRoot: item.paths.profiles, userDataDir: item.userDataDir, mode: "disabled" }).status).toBe("applied"); item.settings.patch({ network: { chromiumPreloading: "browser-default" } }); }
      writeFileSync(item.preferences, "{corrupt-private-fixture-marker");
      const failure = await item.startFailure(); expect(failure.preflightReason).toBe("chromium_preloading_preferences");
      expect(failure.guidance).not.toContain("private-fixture-marker"); expect(readFileSync(item.preferences, "utf8")).toBe("{corrupt-private-fixture-marker");
      expect(item.counts().spawned).toBe(0);
    } finally { item.store.close(); }
  }
});

test("default without product record lets the existing legacy repair/start behavior continue", async () => {
  const item = fixture();
  try {
    writeFileSync(item.preferences, "{legacy-corrupt");
    expect((await item.startFailure()).failure).toBe("process_spawn");
    expect(existsSync(item.record)).toBe(false); expect(item.counts().spawned).toBe(1);
  } finally { item.store.close(); }
});

test("a later user edit is preserved and an explicit disabled launch refuses to falsely claim application", async () => {
  const item = fixture();
  try {
    item.settings.patch({ network: { chromiumPreloading: "disabled" } }); expect((await item.startFailure()).failure).toBe("process_spawn");
    writeFileSync(item.preferences, JSON.stringify({ net: { network_prediction_options: 0, later: true } }));
    expect((await item.startFailure()).preflightReason).toBe("chromium_preloading_changed");
    expect(item.counts().spawned).toBe(1); expect(item.read().net).toEqual({ network_prediction_options: 0, later: true });
    item.settings.patch({ network: { chromiumPreloading: "browser-default" } }); expect((await item.startFailure()).failure).toBe("process_spawn");
    expect(item.read().net).toEqual({ network_prediction_options: 0, later: true }); expect(existsSync(item.record)).toBe(false);
  } finally { item.store.close(); }
});

test("managed155 to another verified Chromium runtime restores our override despite workspace disabled intent", async () => {
  const item = fixture();
  try {
    item.settings.patch({ network: { chromiumPreloading: "disabled" } }); await item.startFailure();
    // Public profile edits already forbid changing runtimes. Exercise the defensive
    // path for a restored/migrated legacy DB that reuses this directory as CloakBrowser.
    (item.store as any).db.query("UPDATE profiles SET chromium_runtime='' WHERE id=?").run(item.profile.id);
    writeFileSync(item.preferences, JSON.stringify({ net: { network_prediction_options: 2, later: "keep" } }));
    expect((await item.startFailure()).failure).toBe("process_spawn");
    expect(item.read().net).toEqual({ network_prediction_options: 3, later: "keep" });
    expect(existsSync(item.record)).toBe(false); expect(item.counts().getterReads).toBe(1);
  } finally { item.store.close(); }
});

test("runtime switch with a damaged pending restoration is blocked without erasing evidence", async () => {
  const item = fixture();
  try {
    item.settings.patch({ network: { chromiumPreloading: "disabled" } });
    const previousLaunch = applyChromiumPreloadingPreference({ profilesRoot: item.paths.profiles, userDataDir: item.userDataDir, mode: "disabled" });
    expect(previousLaunch.status).toBe("applied");
    (item.store as any).db.query("UPDATE profiles SET chromium_runtime='' WHERE id=?").run(item.profile.id);
    const record = readFileSync(item.record, "utf8"); writeFileSync(item.preferences, "{unreadable");
    expect((await item.startFailure()).preflightReason).toBe("chromium_preloading_preferences");
    expect(readFileSync(item.preferences, "utf8")).toBe("{unreadable"); expect(readFileSync(item.record, "utf8")).toBe(record); expect(item.counts().spawned).toBe(0);
  } finally { item.store.close(); }
});

test("healthy reattach never reads the newly saved workspace preference or touches Preferences", async () => {
  const item = fixture();
  try {
    item.settings.patch({ network: { chromiumPreloading: "disabled" } });
    writeFileSync(item.preferences, "{live-browser-owned-by-fixture");
    const existing = { profileId: item.profile.id, pid: 987654, debugPort: 28291, ws: "ws://127.0.0.1:28291/devtools/browser/fixture", startedAt: Date.now(), headless: true };
    item.store.recordLaunch(existing);
    // Isolate the preloading lifecycle boundary from independently tested ownership proof.
    (item.launcher as any).assertStoredLaunchPersona = () => {};
    (item.launcher as any).inspectLaunchLiveness = async () => ({ process: "alive", cdpAlive: true, cdpWs: existing.ws, pid: existing.pid });
    (item.launcher as any).isIdentityCertified = () => true;
    (item.launcher as any).watchSurvivorWindow = async () => {};
    const opened = await item.launcher.start(item.profile.id, [], { headless: true, restoreLocalSession: false, restoreLastSession: false });
    expect(opened.reattached).toBe(true); expect(opened.ws).toBe(existing.ws);
    expect(item.counts()).toEqual({ spawned: 0, getterReads: 0, verifications: 0, holders: 0 });
    expect(readFileSync(item.preferences, "utf8")).toBe("{live-browser-owned-by-fixture"); expect(existsSync(item.record)).toBe(false);
  } finally { item.store.close(); }
});
