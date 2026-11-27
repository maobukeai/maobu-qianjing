import { expect, test } from "bun:test";
import { defaultAppSettings, parseAppSettings } from "../src/app-settings.ts";
import { buildNewProfile } from "../src/create.ts";
import { CHROMIUM_MEMORY_SAVER_RENDERER_LIMIT, Launcher } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";

const base = () => ({ ...defaultAppSettings(), network: { checkLocalProxyBeforeLaunch: false } as Record<string, unknown> });

test("memory saver is off by default and for older settings files", () => {
  expect(defaultAppSettings().network?.chromiumMemorySaver).toBe(false);
  expect(parseAppSettings(base()).network?.chromiumMemorySaver).toBe(false);
});

test("memory saver accepts booleans only", () => {
  const on = base(); on.network.chromiumMemorySaver = true;
  expect(parseAppSettings(on).network?.chromiumMemorySaver).toBe(true);
  const bad = base(); bad.network.chromiumMemorySaver = "yes";
  expect(() => parseAppSettings(bad)).toThrow();
});

test("Launcher injects renderer process limit only when memory saver is enabled and logs getter errors", () => {
  const store = new ProfileStore(":memory:");
  try {
    const profile = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false);
    store.upsertProfile(profile);
    const limitFlag = `--renderer-process-limit=${CHROMIUM_MEMORY_SAVER_RENDERER_LIMIT}`;

    const off = new Launcher({ store, chromiumMemorySaver: () => false });
    expect(off.buildArgs(profile, 9222, "C:\\tmp\\u", [])).not.toContain(limitFlag);

    const on = new Launcher({ store, chromiumMemorySaver: () => true });
    expect(on.buildArgs(profile, 9222, "C:\\tmp\\u", [])).toContain(limitFlag);

    const logs: string[] = [];
    const broken = new Launcher({
      store,
      log: (message) => logs.push(message),
      chromiumMemorySaver: () => { throw new Error("settings unreadable"); },
    });
    expect(broken.buildArgs(profile, 9222, "C:\\tmp\\u", [])).not.toContain(limitFlag);
    expect(logs.some((line) => line.includes("chromium memory saver setting unavailable: settings unreadable"))).toBe(true);
  } finally {
    store.close();
  }
});
