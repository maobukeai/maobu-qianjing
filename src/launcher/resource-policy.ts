import {
  defaultAppSettings,
  resolveDataSaverSettings,
  type AppSettings,
  type DataSaverSettings,
} from "../../app-settings.ts";
import type { JsonValue, Profile } from "../../types.ts";
import type { ProfileResourcePolicy, ResourcePolicyStore } from "../metrics/resource-policy-store.ts";
import {
  applyChromiumResourcePreferences,
  buildChromiumResourceArgs,
} from "./chromium-data-saver.ts";

export interface LaunchPolicyResolver {
  prepareChromiumProfileDir?(profilesRoot: string, userDataDir: string, profile: Profile): void;
  resolveChromiumArgs(profile: Profile): string[];
  resolveFirefoxPrefs(profile: Profile): Record<string, JsonValue>;
}

export interface EffectiveResourcePolicy {
  memorySaver: boolean;
  dataSaver: DataSaverSettings;
}

export interface CreateLaunchPolicyResolverOptions {
  readSettings?: () => AppSettings;
  policyStore?: Pick<ResourcePolicyStore, "get">;
  log?: (msg: string) => void;
}

/** Combine global workspace settings with an optional per-profile override. */
export function resolveEffectiveResourcePolicy(
  profile: Pick<Profile, "id" | "engine">,
  settings: AppSettings,
  override?: ProfileResourcePolicy | null,
): EffectiveResourcePolicy {
  const isFirefox = profile.engine === "firefox";
  const globalMemorySaver = isFirefox
    ? settings.network?.firefoxMemorySaver === true
    : settings.network?.chromiumMemorySaver === true;

  let memorySaver = globalMemorySaver;
  if (override?.memorySaverMode === "on") memorySaver = true;
  else if (override?.memorySaverMode === "off") memorySaver = false;

  const globalDataSaver = resolveDataSaverSettings(settings.network);
  let dataSaver: DataSaverSettings = globalDataSaver;
  if (override?.dataSaver.mode === "off") {
    dataSaver = { enabled: false, blockImages: false, blockMedia: false, blockFonts: false };
  } else if (override?.dataSaver.mode === "on") {
    dataSaver = {
      enabled: true,
      blockImages: override.dataSaver.blockImages ?? globalDataSaver.blockImages,
      blockMedia: override.dataSaver.blockMedia ?? globalDataSaver.blockMedia,
      blockFonts: override.dataSaver.blockFonts ?? globalDataSaver.blockFonts,
    };
  }

  return { memorySaver, dataSaver };
}

/** Build transient Firefox/Camoufox startup prefs (injected via CAMOU_PREFS_n with zero on-disk residue). */
export function buildFirefoxResourcePrefs(effective: EffectiveResourcePolicy): Record<string, JsonValue> {
  const prefs: Record<string, JsonValue> = {};
  if (effective.memorySaver) {
    prefs["dom.ipc.processCount"] = 2;
    prefs["browser.tabs.unloadOnLowMemory"] = true;
    prefs["browser.sessionhistory.max_total_viewers"] = 0;
  }
  if (effective.dataSaver.enabled) {
    if (effective.dataSaver.blockImages) {
      prefs["permissions.default.image"] = 2;
    }
    if (effective.dataSaver.blockFonts) {
      prefs["gfx.downloadable_fonts.enabled"] = false;
    }
    if (effective.dataSaver.blockMedia) {
      prefs["media.autoplay.default"] = 5;
      prefs["media.autoplay.blocking_policy"] = 2;
      prefs["media.preload.default"] = 0;
      prefs["media.mediasource.enabled"] = false;
    }
  }
  return prefs;
}

const SINGLE_VALUE_PREFIXES = [
  "--renderer-process-limit=",
  "--autoplay-policy=",
];

function mergeFeatureSwitch(targetArgs: string[], prefix: "--disable-features=" | "--enable-features=", rawList: string): void {
  const incoming = rawList.split(",").map((item) => item.trim()).filter(Boolean);
  if (incoming.length === 0) return;
  const existingIndex = targetArgs.findIndex((arg) => arg.startsWith(prefix));
  if (existingIndex < 0) {
    targetArgs.push(`${prefix}${[...new Set(incoming)].join(",")}`);
    return;
  }
  const existing = targetArgs[existingIndex]!
    .slice(prefix.length)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...incoming])];
  targetArgs[existingIndex] = `${prefix}${merged.join(",")}`;
}

/**
 * Merge policy switches into Chromium launch args without clobbering existing
 * `--disable-features` (e.g. DeviceBoundSessions) or stricter caller-forwarded limits.
 */
export function mergeChromiumLaunchArgs(targetArgs: string[], policyArgs: readonly string[]): void {
  for (const arg of policyArgs) {
    if (arg.startsWith("--disable-features=")) {
      mergeFeatureSwitch(targetArgs, "--disable-features=", arg.slice("--disable-features=".length));
      continue;
    }
    if (arg.startsWith("--enable-features=")) {
      mergeFeatureSwitch(targetArgs, "--enable-features=", arg.slice("--enable-features=".length));
      continue;
    }
    if (arg.startsWith("--disk-cache-size=")) {
      const incomingSize = Number(arg.slice("--disk-cache-size=".length));
      const existingIdx = targetArgs.findIndex((item) => item.startsWith("--disk-cache-size="));
      if (existingIdx < 0) {
        targetArgs.push(arg);
      } else if (Number.isFinite(incomingSize) && incomingSize > 0) {
        const existingSize = Number(targetArgs[existingIdx]!.slice("--disk-cache-size=".length));
        if (!Number.isFinite(existingSize) || incomingSize < existingSize) {
          targetArgs[existingIdx] = arg;
        }
      }
      continue;
    }
    if (arg.startsWith("--blink-settings=")) {
      const existingIdx = targetArgs.findIndex((item) => item.startsWith("--blink-settings="));
      if (existingIdx < 0) {
        targetArgs.push(arg);
      } else {
        const existingParts = targetArgs[existingIdx]!.slice("--blink-settings=".length).split(",").filter(Boolean);
        const newParts = arg.slice("--blink-settings=".length).split(",").filter(Boolean);
        targetArgs[existingIdx] = `--blink-settings=${[...new Set([...existingParts, ...newParts])].join(",")}`;
      }
      continue;
    }
    const singlePrefix = SINGLE_VALUE_PREFIXES.find((prefix) => arg.startsWith(prefix));
    if (singlePrefix) {
      if (!targetArgs.some((item) => item.startsWith(singlePrefix))) {
        targetArgs.push(arg);
      }
      continue;
    }
    if (!targetArgs.includes(arg)) {
      targetArgs.push(arg);
    }
  }
}

export function createLaunchPolicyResolver(
  options: CreateLaunchPolicyResolverOptions = {},
): LaunchPolicyResolver {
  const log = options.log ?? (() => {});

  const resolveForProfile = (profile: Profile): EffectiveResourcePolicy => {
    let settings: AppSettings;
    try {
      settings = options.readSettings ? options.readSettings() : defaultAppSettings();
    } catch (error) {
      log(`resource policy settings unavailable: ${error instanceof Error ? error.message : String(error)}`);
      settings = defaultAppSettings();
    }
    let override: ProfileResourcePolicy | null = null;
    if (options.policyStore) {
      try {
        override = options.policyStore.get(profile.id);
      } catch (error) {
        log(`resource policy override unavailable for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return resolveEffectiveResourcePolicy(profile, settings, override);
  };

  return {
    prepareChromiumProfileDir(profilesRoot: string, userDataDir: string, profile: Profile): void {
      if (profile.engine === "firefox") return;
      const effective = resolveForProfile(profile);
      const result = applyChromiumResourcePreferences({
        profilesRoot,
        userDataDir,
        memorySaver: effective.memorySaver,
        muteSound: effective.dataSaver.enabled && effective.dataSaver.blockMedia,
      });
      if (result.status === "blocked") {
        log(`chromium resource preferences skipped for ${profile.id}: ${result.reason}`);
      }
    },

    resolveChromiumArgs(profile: Profile): string[] {
      if (profile.engine === "firefox") return [];
      return buildChromiumResourceArgs(resolveForProfile(profile));
    },

    resolveFirefoxPrefs(profile: Profile): Record<string, JsonValue> {
      if (profile.engine !== "firefox") return {};
      return buildFirefoxResourcePrefs(resolveForProfile(profile));
    },
  };
}
