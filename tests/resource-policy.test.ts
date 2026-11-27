import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppSettings } from "../app-settings.ts";
import { buildNewProfile } from "../create.ts";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";
import {
  applyChromiumResourcePreferences,
  buildChromiumResourceArgs,
  CHROMIUM_MEMORY_SAVER_DISK_CACHE_BYTES,
  CHROMIUM_RESOURCE_POLICY_RECORD,
} from "../src/launcher/chromium-data-saver.ts";
import {
  buildFirefoxResourcePrefs,
  createLaunchPolicyResolver,
  mergeChromiumLaunchArgs,
  resolveEffectiveResourcePolicy,
} from "../src/launcher/resource-policy.ts";
import { ResourcePolicyStore } from "../src/metrics/resource-policy-store.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProfileDir() {
  const root = mkdtempSync(join(tmpdir(), "maobu-respol-"));
  tempDirs.push(root);
  const profilesRoot = join(root, "profiles");
  const userDataDir = join(profilesRoot, "p1");
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  return { root, profilesRoot, userDataDir };
}

describe("applyChromiumResourcePreferences", () => {
  test("does nothing when disabled and no record exists, and reversibly applies/restores preferences", () => {
    const { profilesRoot, userDataDir } = makeProfileDir();
    const prefsPath = join(userDataDir, "Default", "Preferences");
    const recordPath = join(userDataDir, CHROMIUM_RESOURCE_POLICY_RECORD);

    // Off with no prior record -> untouched, does not create Preferences
    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: false, muteSound: false }))
      .toEqual({ status: "unchanged" });
    expect(existsSync(prefsPath)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);

    // Seed existing user preferences
    writeFileSync(
      prefsPath,
      JSON.stringify({
        browser: { check_default_browser: false },
        profile: { default_content_setting_values: { sound: 1, cookies: 1 } },
      }, null, 2),
      "utf8",
    );

    // Enable both memorySaver and muteSound
    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: true, muteSound: true }))
      .toEqual({ status: "applied" });
    const afterApply = JSON.parse(readFileSync(prefsPath, "utf8"));
    expect(afterApply.performance_tuning.high_efficiency_mode.state).toBe(1);
    expect(afterApply.profile.default_content_setting_values.sound).toBe(2);
    expect(afterApply.profile.default_content_setting_values.cookies).toBe(1);
    expect(afterApply.browser.check_default_browser).toBe(false);
    expect(existsSync(recordPath)).toBe(true);

    // Idempotent second call
    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: true, muteSound: true }))
      .toEqual({ status: "unchanged" });

    // Disable both -> restores sound=1, removes created performance_tuning subtree and record file
    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: false, muteSound: false }))
      .toEqual({ status: "restored" });
    const afterRestore = JSON.parse(readFileSync(prefsPath, "utf8"));
    expect(afterRestore.performance_tuning).toBeUndefined();
    expect(afterRestore.profile.default_content_setting_values.sound).toBe(1);
    expect(afterRestore.profile.default_content_setting_values.cookies).toBe(1);
    expect(existsSync(recordPath)).toBe(false);
  });

  test("preserves manual user edits and blocks path traversal or corrupt preferences", () => {
    const { root, profilesRoot, userDataDir } = makeProfileDir();
    const prefsPath = join(userDataDir, "Default", "Preferences");

    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: true, muteSound: false }))
      .toEqual({ status: "applied" });

    // User manually edits high_efficiency_mode.state to 2
    const edited = JSON.parse(readFileSync(prefsPath, "utf8"));
    edited.performance_tuning.high_efficiency_mode.state = 2;
    writeFileSync(prefsPath, JSON.stringify(edited, null, 2), "utf8");

    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: false, muteSound: false }))
      .toEqual({ status: "user-change-preserved" });
    expect(JSON.parse(readFileSync(prefsPath, "utf8")).performance_tuning.high_efficiency_mode.state).toBe(2);

    // Path traversal blocked
    expect(applyChromiumResourcePreferences({
      profilesRoot,
      userDataDir: join(root, "outside"),
      memorySaver: true,
      muteSound: false,
    })).toEqual({ status: "blocked", reason: "unsafe-path" });

    // Corrupt Preferences blocked without overwriting
    writeFileSync(prefsPath, "{corrupt-json", "utf8");
    expect(applyChromiumResourcePreferences({ profilesRoot, userDataDir, memorySaver: true, muteSound: false }))
      .toEqual({ status: "blocked", reason: "preferences-invalid" });
    expect(readFileSync(prefsPath, "utf8")).toBe("{corrupt-json");
  });
});

describe("resource-policy switches, Firefox prefs, and Launcher hook", () => {
  test("builds Chromium switches and Firefox prefs matching Wave 3 blueprint §3.2", () => {
    const policy = {
      memorySaver: true,
      dataSaver: { enabled: true, blockImages: true, blockMedia: true, blockFonts: true },
    };
    const chromeArgs = buildChromiumResourceArgs(policy);
    expect(chromeArgs).toEqual([
      "--renderer-process-limit=4",
      "--enable-features=HighEfficiencyModeAvailable",
      `--disk-cache-size=${CHROMIUM_MEMORY_SAVER_DISK_CACHE_BYTES}`,
      "--blink-settings=imagesEnabled=false",
      "--disable-remote-fonts",
      "--autoplay-policy=document-user-activation-required",
      "--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
    ]);

    const firefoxPrefs = buildFirefoxResourcePrefs(policy);
    expect(firefoxPrefs).toEqual({
      "dom.ipc.processCount": 2,
      "browser.tabs.unloadOnLowMemory": true,
      "browser.sessionhistory.max_total_viewers": 0,
      "permissions.default.image": 2,
      "gfx.downloadable_fonts.enabled": false,
      "media.autoplay.default": 5,
      "media.autoplay.blocking_policy": 2,
      "media.preload.default": 0,
      "media.mediasource.enabled": false,
    });
  });

  test("mergeChromiumLaunchArgs preserves DeviceBoundSessions and caller limits without duplicate switches", () => {
    const base = [
      "--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials",
      "--renderer-process-limit=2",
    ];
    mergeChromiumLaunchArgs(base, [
      "--renderer-process-limit=4",
      "--enable-features=HighEfficiencyModeAvailable",
      "--disk-cache-size=10485760",
      "--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
    ]);
    expect(base.filter((a) => a.startsWith("--disable-features="))).toEqual([
      "--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials,PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
    ]);
    expect(base.filter((a) => a.startsWith("--renderer-process-limit="))).toEqual(["--renderer-process-limit=2"]);
    expect(base).toContain("--enable-features=HighEfficiencyModeAvailable");
    expect(base).toContain("--disk-cache-size=10485760");
  });

  test("resolveEffectiveResourcePolicy respects per-profile inherit/on/off over global settings", () => {
    const baseSettings = defaultAppSettings();
    const settings = {
      ...baseSettings,
      network: {
        ...baseSettings.network!,
        chromiumMemorySaver: true,
        firefoxMemorySaver: false,
        dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: true },
      },
    };
    const chrome = { id: "c1", engine: "chromium" as const };
    const fox = { id: "f1", engine: "firefox" as const };

    expect(resolveEffectiveResourcePolicy(chrome, settings, null)).toEqual({
      memorySaver: true,
      dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: true },
    });
    expect(resolveEffectiveResourcePolicy(chrome, settings, {
      profileId: "c1",
      memorySaverMode: "off",
      dataSaver: { mode: "off" },
      updatedAt: 1,
    })).toEqual({
      memorySaver: false,
      dataSaver: { enabled: false, blockImages: false, blockMedia: false, blockFonts: false },
    });
    expect(resolveEffectiveResourcePolicy(fox, settings, {
      profileId: "f1",
      memorySaverMode: "on",
      dataSaver: { mode: "on", blockMedia: true },
      updatedAt: 1,
    })).toEqual({
      memorySaver: true,
      dataSaver: { enabled: true, blockImages: true, blockMedia: true, blockFonts: true },
    });
  });

  test("Launcher buildArgs integrates launchPolicy cleanly for Chromium 155 and per-profile overrides", () => {
    const store = new ProfileStore(":memory:");
    const policyStore = new ResourcePolicyStore(":memory:");
    try {
      const p1 = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false);
      const p2 = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows" }, (id) => id === p1.id);
      store.upsertProfiles([p1, p2]);
      policyStore.set(p2.id, { memorySaverMode: "off", dataSaver: "off" });

      const settings = {
        ...defaultAppSettings(),
        network: {
          ...defaultAppSettings().network!,
          chromiumMemorySaver: true,
          dataSaver: { enabled: true, blockImages: true, blockMedia: true, blockFonts: true },
        },
      };
      const launchPolicy = createLaunchPolicyResolver({
        readSettings: () => settings,
        policyStore,
      });
      const launcher = new Launcher({ store, launchPolicy });

      const args1 = launcher.buildArgs(p1, 9222, "C:\\tmp\\u1", []);
      expect(args1).toContain("--renderer-process-limit=4");
      expect(args1).toContain("--enable-features=HighEfficiencyModeAvailable");
      expect(args1).toContain("--disk-cache-size=10485760");
      expect(args1).toContain("--blink-settings=imagesEnabled=false");
      expect(args1).toContain("--disable-remote-fonts");
      expect(args1).toContain("--autoplay-policy=document-user-activation-required");
      // Must merge into Chromium 155's existing --disable-features rather than overriding it
      const disableFeaturesFlags = args1.filter((a) => a.startsWith("--disable-features="));
      expect(disableFeaturesFlags).toHaveLength(1);
      expect(disableFeaturesFlags[0]).toContain("DeviceBoundSessions");
      expect(disableFeaturesFlags[0]).toContain("PreloadMediaEngagementData");

      // p2 overrides both memorySaver and dataSaver to off
      const args2 = launcher.buildArgs(p2, 9223, "C:\\tmp\\u2", []);
      expect(args2.some((a) => a.startsWith("--renderer-process-limit="))).toBe(false);
      expect(args2).not.toContain("--blink-settings=imagesEnabled=false");
      expect(args2).not.toContain("--disable-remote-fonts");
      expect(args2).toContain("--disk-cache-size=20971520");

      // Stricter automation --disk-cache-size=1 must not be raised back to 10MB
      const argsStricter = launcher.buildArgs(p1, 9224, "C:\\tmp\\u3", ["--disk-cache-size=1"]);
      expect(argsStricter.filter((a) => a.startsWith("--disk-cache-size="))).toContain("--disk-cache-size=1");

      // Firefox resolver produces CAMOU_PREFS_n memory & data saver entries
      const fox = buildNewProfile({ engine: "firefox" }, (id) => id === p1.id || id === p2.id);
      store.upsertProfile(fox);
      policyStore.set(fox.id, { memorySaverMode: "on", dataSaver: { mode: "on", blockImages: true, blockFonts: true, blockMedia: true } });
      expect(launchPolicy.resolveFirefoxPrefs(fox)).toEqual({
        "dom.ipc.processCount": 2,
        "browser.tabs.unloadOnLowMemory": true,
        "browser.sessionhistory.max_total_viewers": 0,
        "permissions.default.image": 2,
        "gfx.downloadable_fonts.enabled": false,
        "media.autoplay.default": 5,
        "media.autoplay.blocking_policy": 2,
        "media.preload.default": 0,
        "media.mediasource.enabled": false,
      });
    } finally {
      policyStore.close();
      store.close();
    }
  });
});
