import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore, parseAppConfig } from "./app-config.ts";
import * as configModule from "./app-config.ts";

const local = { version: 1, mode: "local", localAnalytics: false } as const;

describe("local-only app config", () => {
  test("fresh installs start locally without login, analytics, or promotions", () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-config-"));
    expect(new AppConfigStore(join(root, "config.json")).read()).toEqual(local);
  });

  test("old Cloud selections and malformed retired endpoints are read as Local", () => {
    for (const mode of ["cloud", "unconfigured", "local"]) {
      expect(parseAppConfig({ version: 1, mode, cloudUrl: "not a URL", localAnalytics: true })).toEqual(local);
    }
  });

  test("reading an old config preserves the original file until an explicit write", () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-config-"));
    const path = join(root, "config.json");
    const original = JSON.stringify({ version: 1, mode: "cloud", cloudUrl: "https://retired.example" });
    writeFileSync(path, original);
    const store = new AppConfigStore(path);
    expect(store.read()).toEqual(local);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(store.setMode("local")).toEqual(local);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(local);
  });

  test("only a local configuration can be written and retired service exports are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-config-"));
    const store = new AppConfigStore(join(root, "config.json"));
    expect(() => store.setMode("cloud" as never)).toThrow("local mode");
    expect(store.write({ version: 1, mode: "local", localAnalytics: true } as never)).toEqual(local);
    for (const name of ["legacyHubUrl", "normalizeSecureServiceUrl", "CLOUD_DISABLED_MESSAGE"]) expect(Object.hasOwn(configModule, name)).toBe(false);
  });

  test("unknown schemas and modes are rejected without rewriting existing data", () => {
    expect(() => parseAppConfig({ version: 2, mode: "local" })).toThrow("version");
    expect(() => parseAppConfig({ version: 1, mode: "unknown" })).toThrow("mode");
  });
});
