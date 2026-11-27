import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  AppSettingsStore,
  DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS,
  DEFAULT_DATA_SAVER_SETTINGS,
  defaultAppSettings,
  normalizeUpdateRepository,
  parseAppSettings,
  resolveBatchLaunchMemoryGuardSettings,
  resolveDataSaverSettings,
} from "../app-settings.ts";

const roots: string[] = [];
const fixtureParent = resolve(import.meta.dir, "..", "node_modules", ".cache", "settings-tests");
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(fixtureParent + sep)) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); } });
function fixture() { mkdirSync(fixtureParent, { recursive: true }); const root = mkdtempSync(join(fixtureParent, "case-")); roots.push(root); return { root, store: new AppSettingsStore(join(root, "app-settings.json")) }; }

describe("independent application preferences", () => {
  test("fresh preferences do not contact a source, enable sync, or create files", () => {
    const { store } = fixture(); expect(store.read()).toEqual(defaultAppSettings()); expect(existsSync(store.path)).toBe(false);
  });
  test("partial patches persist across restarts and preserve other preferences", () => {
    const { root, store } = fixture();
    store.patch({ updates: { repository: " maobu/browser ", channel: "beta", checkOnStartup: true } });
    const settings = store.patch({ sync: { folder: join(root, "transport"), enabled: true, retainSnapshots: 7 } });
    expect(new AppSettingsStore(store.path).read()).toEqual(settings);
    expect(settings.updates.repository).toBe("maobu/browser"); expect(settings.updates.channel).toBe("beta");
    expect(readFileSync(store.path, "utf8")).not.toContain("password");
  });
  test("legacy settings default the local proxy gate off without rewriting the file", () => {
    const { store } = fixture(), { network: _network, ...legacy } = defaultAppSettings();
    const original = JSON.stringify(legacy); writeFileSync(store.path, original);
    expect(store.read().network).toEqual({ checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false }); expect(readFileSync(store.path, "utf8")).toBe(original);
    const updated = store.patch({ network: { checkLocalProxyBeforeLaunch: true } });
    expect(updated.network).toEqual({ checkLocalProxyBeforeLaunch: true, chromiumPreloading: "browser-default", chromiumMemorySaver: false }); expect(updated.updates).toEqual(legacy.updates); expect(updated.sync).toEqual(legacy.sync);
    expect(new AppSettingsStore(store.path).read()).toEqual(updated);
    expect(store.patch({ updates: { repository: "maobu/browser" } }).network).toEqual(updated.network);
  });
  test("signed startup checking is opt-in and independent of release browsing or other workspaces", () => {
    const { store } = fixture();
    const { signedUpdates: _signedUpdates, ...legacy } = defaultAppSettings();
    const original = JSON.stringify(legacy);
    writeFileSync(store.path, original);
    expect(store.read().signedUpdates).toEqual({ checkOnStartup: false });
    expect(readFileSync(store.path, "utf8")).toBe(original);
    const enabled = store.patch({ signedUpdates: { checkOnStartup: true } });
    expect(enabled.updates).toEqual(legacy.updates);
    expect(enabled.sync).toEqual(legacy.sync);
    expect(store.patch({ updates: { repository: "maobu/browser", checkOnStartup: true } }).signedUpdates).toEqual({ checkOnStartup: true });
    expect(new AppSettingsStore(store.path).read().signedUpdates).toEqual({ checkOnStartup: true });
    expect(fixture().store.read().signedUpdates).toEqual({ checkOnStartup: false });
    const before = readFileSync(store.path, "utf8");
    for (const signedUpdates of [null, [], true, { checkOnStartup: 1 }, { checkOnStartup: "true" }, { checkOnStartup: true, endpoint: "https://untrusted.invalid/" }]) {
      expect(() => store.patch({ signedUpdates })).toThrow();
      expect(readFileSync(store.path, "utf8")).toBe(before);
    }
  });
  test("network patches require an exact boolean schema and never persist secret fields", () => {
    const { store } = fixture(); const current = store.patch({ network: { checkLocalProxyBeforeLaunch: true } }), original = readFileSync(store.path);
    for (const network of [null, [], true, { checkLocalProxyBeforeLaunch: "false" }, { checkLocalProxyBeforeLaunch: 1 }, { endpoint: "private-network-secret" }, { checkLocalProxyBeforeLaunch: false, password: "private-network-secret" }]) {
      expect(() => store.patch({ network })).toThrow(); expect(store.read()).toEqual(current); expect(readFileSync(store.path)).toEqual(original);
    }
    expect(() => parseAppSettings({ ...defaultAppSettings(), network: {} })).toThrow("Invalid network settings");
  });
  test("page preloading is workspace-local, opt-in and strictly enum-validated", () => {
    const { store } = fixture(), other = fixture().store;
    const disabled = store.patch({ network: { chromiumPreloading: "disabled" } });
    expect(disabled.network).toEqual({ checkLocalProxyBeforeLaunch: false, chromiumPreloading: "disabled", chromiumMemorySaver: false });
    expect(other.read().network?.chromiumPreloading).toBe("browser-default");
    expect(store.patch({ network: { checkLocalProxyBeforeLaunch: true } }).network?.chromiumPreloading).toBe("disabled");
    const original = readFileSync(store.path, "utf8");
    for (const chromiumPreloading of [true, null, 2, "2", "off", "default", "disabled ", {}, []]) {
      expect(() => store.patch({ network: { chromiumPreloading } })).toThrow("Invalid network settings");
      expect(readFileSync(store.path, "utf8")).toBe(original);
    }
    expect(new AppSettingsStore(store.path).read().network?.chromiumPreloading).toBe("disabled");
    expect(store.patch({ network: { chromiumPreloading: "browser-default" } }).network).toEqual({ checkLocalProxyBeforeLaunch: true, chromiumPreloading: "browser-default", chromiumMemorySaver: false });
  });
  test("bad patches cannot overwrite previously valid settings", () => {
    const { store } = fixture(); const before = store.patch({ updates: { repository: "maobu/browser" } });
    for (const patch of [{ version: 2 }, { updates: { token: "secret" } }, { sync: { password: "secret" } }, { sync: { enabled: true } }, { sync: { folder: "relative/path" } }, { sync: { retainSnapshots: 0 } }, { updates: null }, []]) {
      expect(() => store.patch(patch)).toThrow(); expect(store.read()).toEqual(before);
    }
  });
  test("retired config is separate and corrupt settings are not silently overwritten", () => {
    const { root, store } = fixture(); const original = '{"version":1,"mode":"cloud","cloudUrl":"https://old.example"}';
    writeFileSync(join(root, "config.json"), original); store.patch({ updates: { repository: "maobu/browser" } });
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
    writeFileSync(store.path, "corrupt"); expect(() => store.read()).toThrow(); expect(() => store.patch({})).toThrow(); expect(readFileSync(store.path, "utf8")).toBe("corrupt");
  });
  test("only public GitHub repository identifiers and known schemas are accepted", () => {
    for (const repository of ["https://github.com/a/b", "a/b/c", "a/..", "-a/b", "a/b?token=secret", "a\\b", "a/b\nanything"]) expect(() => normalizeUpdateRepository(repository)).toThrow();
    expect(normalizeUpdateRepository("" )).toBe(""); expect(normalizeUpdateRepository("user/repo.name-1")).toBe("user/repo.name-1");
    expect(() => parseAppSettings({ ...defaultAppSettings(), version: 2 })).toThrow("version");
  });
  test("disabled sync preserves a foreign platform's absolute folder until the operator reconfigures it", () => {
    const { store } = fixture();
    for (const folder of ["C:\\Users\\previous-device\\OneDrive\\Maobu", "/home/previous-device/sync"]) {
      expect(store.patch({ sync: { folder, enabled: false } }).sync.folder).toBe(folder);
      expect(new AppSettingsStore(store.path).read().sync.enabled).toBe(false);
      if (!isAbsolute(folder)) expect(() => store.patch({ sync: { enabled: true } })).toThrow("absolute");
      expect(store.read().sync.enabled).toBe(false);
    }
  });
  test("malformed preferences return a fixed error without revealing file content", () => {
    const { store } = fixture(); writeFileSync(store.path, '{"password":"private-configuration-secret",BROKEN');
    let message = "";
    try { store.read(); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Application settings file is invalid"); expect(message).not.toContain("private-configuration-secret");
  });
  test("firefoxMemorySaver, dataSaver and batchLaunchMemoryGuard stay backward-compatible and strictly validated", () => {
    const { store } = fixture();
    const initial = store.read();
    expect(initial.network?.firefoxMemorySaver).toBeUndefined();
    expect(initial.network?.dataSaver).toBeUndefined();
    expect(initial.network?.batchLaunchMemoryGuard).toBeUndefined();
    expect(resolveDataSaverSettings(initial.network)).toEqual(DEFAULT_DATA_SAVER_SETTINGS);
    expect(resolveBatchLaunchMemoryGuardSettings(initial.network)).toEqual(DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS);

    const saved = store.patch({
      network: {
        firefoxMemorySaver: true,
        dataSaver: { enabled: true, blockImages: true },
        batchLaunchMemoryGuard: { softWatermarkPercent: 72, hardWatermarkPercent: 86, minAvailableMb: 2048 },
      },
    });
    expect(saved.network?.firefoxMemorySaver).toBe(true);
    expect(saved.network?.dataSaver).toEqual({ enabled: true, blockImages: true, blockMedia: false, blockFonts: false });
    expect(saved.network?.batchLaunchMemoryGuard).toEqual({ enabled: true, softWatermarkPercent: 72, hardWatermarkPercent: 86, minAvailableMb: 2048 });
    expect(new AppSettingsStore(store.path).read()).toEqual(saved);

    // Subsequent partial patches preserve existing nested fields
    const toggled = store.patch({ network: { dataSaver: { blockFonts: true }, batchLaunchMemoryGuard: { enabled: false } } });
    expect(toggled.network?.dataSaver).toEqual({ enabled: true, blockImages: true, blockMedia: false, blockFonts: true });
    expect(toggled.network?.batchLaunchMemoryGuard).toEqual({ enabled: false, softWatermarkPercent: 72, hardWatermarkPercent: 86, minAvailableMb: 2048 });
    expect(toggled.network?.firefoxMemorySaver).toBe(true);

    const beforeInvalid = readFileSync(store.path, "utf8");
    for (const badNetwork of [
      { firefoxMemorySaver: "true" },
      { dataSaver: null },
      { dataSaver: { enabled: "yes" } },
      { dataSaver: { enabled: true, extra: true } },
      { batchLaunchMemoryGuard: null },
      { batchLaunchMemoryGuard: { enabled: 1 } },
      { batchLaunchMemoryGuard: { softWatermarkPercent: 90, hardWatermarkPercent: 85 } },
      { batchLaunchMemoryGuard: { softWatermarkPercent: 80, hardWatermarkPercent: 80 } },
      { batchLaunchMemoryGuard: { softWatermarkPercent: 75.5 } },
      { batchLaunchMemoryGuard: { softWatermarkPercent: 10 } },
      { batchLaunchMemoryGuard: { hardWatermarkPercent: 100 } },
      { batchLaunchMemoryGuard: { minAvailableMb: 64 } },
      { batchLaunchMemoryGuard: { minAvailableMb: 100000 } },
      { batchLaunchMemoryGuard: { token: "secret" } },
    ]) {
      expect(() => store.patch({ network: badNetwork })).toThrow();
      expect(readFileSync(store.path, "utf8")).toBe(beforeInvalid);
    }
  });
});
