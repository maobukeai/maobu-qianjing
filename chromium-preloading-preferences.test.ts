import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { applyChromiumPreloadingPreference, CHROMIUM_PRELOADING_RECORD, type ChromiumPreloadingMode } from "./chromium-preloading-preferences.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("maobu-preloading-test-")) throw new Error("Refusing cleanup outside this test's created temp directory");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture(initial?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "maobu-preloading-test-")); directories.push(directory);
  const profilesRoot = join(directory, "profiles"), userDataDir = join(profilesRoot, "synthetic");
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  const preferences = join(userDataDir, "Default", "Preferences"), record = join(userDataDir, CHROMIUM_PRELOADING_RECORD);
  if (initial !== undefined) writeFileSync(preferences, JSON.stringify(initial));
  return { directory, profilesRoot, userDataDir, preferences, record,
    apply: (mode: ChromiumPreloadingMode) => applyChromiumPreloadingPreference({ profilesRoot, userDataDir, mode }),
    read: () => JSON.parse(readFileSync(preferences, "utf8")),
  };
}
function preparedRecord(previous: { present: boolean; value?: unknown }, netPreviouslyPresent = true, phase = "prepared") {
  return { version: 1, preference: "net.network_prediction_options", managedValue: 2, phase, previous, netPreviouslyPresent };
}

test("default with no product record never opens/resets corrupt legacy Preferences", () => {
  const item = fixture(); writeFileSync(item.preferences, "{ legacy corrupt preferences");
  expect(item.apply("browser-default")).toEqual({ status: "unchanged" });
  expect(readFileSync(item.preferences, "utf8")).toBe("{ legacy corrupt preferences");
  expect(readdirSync(item.userDataDir)).toEqual(["Default"]);
});

test("default on a profile not yet created does not create files or folders", () => {
  const item = fixture();
  const userDataDir = join(item.profilesRoot, "not-created");
  expect(applyChromiumPreloadingPreference({ profilesRoot: item.profilesRoot, userDataDir, mode: "browser-default" })).toEqual({ status: "unchanged" });
  expect(existsSync(userDataDir)).toBe(false);
});

test("first startup override is reversible and keeps browser-added top-level and net fields", () => {
  const item = fixture();
  expect(item.apply("disabled")).toEqual({ status: "applied" });
  expect(item.read()).toEqual({ net: { network_prediction_options: 2 } });
  expect(JSON.parse(readFileSync(item.record, "utf8"))).toEqual(preparedRecord({ present: false }, false, "applied"));
  writeFileSync(item.preferences, JSON.stringify({ net: { network_prediction_options: 2, browser_added: { keep: true } }, browser_added: [1, 2], profile: { name: "Synthetic" } }));
  expect(item.apply("browser-default")).toEqual({ status: "restored" });
  expect(item.read()).toEqual({ net: { browser_added: { keep: true } }, browser_added: [1, 2], profile: { name: "Synthetic" } });
  expect(existsSync(item.record)).toBe(false);
  expect(readdirSync(join(item.userDataDir, "Default"))).toEqual(["Preferences"]);
});

for (const previous of [0, 1, 3, null, false, "legacy-value", { legacy: [1, "x"] }]) {
  test(`restores the actual original leaf (${JSON.stringify(previous)}), never hardcodes default 1`, () => {
    const item = fixture({ net: { network_prediction_options: previous, unrelated: "keep" }, ui: { keep: true } });
    expect(item.apply("disabled")).toEqual({ status: "applied" });
    expect(item.read().net).toEqual({ network_prediction_options: 2, unrelated: "keep" });
    expect(item.apply("disabled")).toEqual({ status: "unchanged" });
    expect(item.apply("browser-default")).toEqual({ status: "restored" });
    expect(item.read()).toEqual({ net: { network_prediction_options: previous, unrelated: "keep" }, ui: { keep: true } });
  });
}

test("does not claim ownership of a user preference that was already disabled", () => {
  const item = fixture({ net: { network_prediction_options: 2 }, other: true });
  const original = readFileSync(item.preferences, "utf8");
  expect(item.apply("disabled")).toEqual({ status: "unchanged" });
  expect(existsSync(item.record)).toBe(false);
  expect(item.apply("browser-default")).toEqual({ status: "unchanged" });
  expect(readFileSync(item.preferences, "utf8")).toBe(original);
});

test("removes empty net only when this product originally introduced it", () => {
  for (const initial of [{}, { net: {} }]) {
    const item = fixture(initial);
    expect(item.apply("disabled").status).toBe("applied");
    expect(item.apply("browser-default").status).toBe("restored");
    expect(item.read()).toEqual(initial);
  }
});

test("corrupt or incompatible Preferences is never overwritten or granted an override record", () => {
  for (const input of ["{broken", "null", "[]", '{"net":null}', '{"net":[]}', '{"net":"legacy"}', '{"net":{"network_prediction_options":1e999}}']) {
    const item = fixture(); writeFileSync(item.preferences, input);
    expect(item.apply("disabled")).toEqual({ status: "blocked", reason: "preferences-invalid" });
    expect(readFileSync(item.preferences, "utf8")).toBe(input);
    expect(existsSync(item.record)).toBe(false);
  }
});

test("an original leaf too large for the bounded recovery record is preserved rather than creating an unusable journal", () => {
  const item = fixture({ net: { network_prediction_options: "x".repeat(64 * 1024) } });
  const original = readFileSync(item.preferences, "utf8");
  expect(item.apply("disabled")).toEqual({ status: "blocked", reason: "preferences-invalid" });
  expect(readFileSync(item.preferences, "utf8")).toBe(original); expect(existsSync(item.record)).toBe(false);
});

test("corrupt management records never overwrite either file or guess an original value", () => {
  for (const record of ["{bad", "{}", JSON.stringify({ ...preparedRecord({ present: true, value: 1 }), version: 2 }), JSON.stringify(preparedRecord({ present: true }, true)), JSON.stringify(preparedRecord({ present: true, value: 1 }, false))]) {
    const item = fixture({ net: { network_prediction_options: 2 }, keep: true }); writeFileSync(item.record, record);
    const original = readFileSync(item.preferences, "utf8");
    for (const mode of ["browser-default", "disabled"] as const) expect(item.apply(mode)).toEqual({ status: "blocked", reason: "management-record-invalid" });
    expect(readFileSync(item.record, "utf8")).toBe(record); expect(readFileSync(item.preferences, "utf8")).toBe(original);
  }
});

test("an existing recovery record requires valid Preferences; corrupt files and recovery record are retained", () => {
  const item = fixture(); writeFileSync(item.preferences, "{bad"); const record = JSON.stringify(preparedRecord({ present: true, value: 3 })); writeFileSync(item.record, record);
  expect(item.apply("browser-default")).toEqual({ status: "blocked", reason: "preferences-invalid" });
  expect(readFileSync(item.record, "utf8")).toBe(record); expect(readFileSync(item.preferences, "utf8")).toBe("{bad");
});

test("prepared journal can resume a crash before the preference write and later restore exact original", () => {
  const item = fixture({ net: { network_prediction_options: 3, added: true } });
  writeFileSync(item.record, JSON.stringify(preparedRecord({ present: true, value: 3 })));
  expect(item.apply("disabled")).toEqual({ status: "applied" });
  expect(item.read().net.network_prediction_options).toBe(2);
  expect(item.apply("browser-default")).toEqual({ status: "restored" });
  expect(item.read().net).toEqual({ network_prediction_options: 3, added: true });
});

test("prepared journal safely restores a crash after preference write, before applied marker", () => {
  const item = fixture({ net: { network_prediction_options: 2, added: true } });
  writeFileSync(item.record, JSON.stringify(preparedRecord({ present: false }, false)));
  expect(item.apply("browser-default")).toEqual({ status: "restored" });
  expect(item.read()).toEqual({ net: { added: true } }); expect(existsSync(item.record)).toBe(false);
});

test("crash before applying or after restoration only removes the stale record, preserving bytes", () => {
  for (const phase of ["prepared", "applied"]) {
    const item = fixture({ net: { network_prediction_options: 0, keep: true } });
    const original = readFileSync(item.preferences, "utf8");
    writeFileSync(item.record, JSON.stringify(preparedRecord({ present: true, value: 0 }, true, phase)));
    expect(item.apply("browser-default")).toEqual({ status: "restored" });
    expect(readFileSync(item.preferences, "utf8")).toBe(original); expect(existsSync(item.record)).toBe(false);
  }
});

test("a user's later leaf edit is preserved in both modes, without rolling back later net fields", () => {
  const item = fixture({ net: { network_prediction_options: 3 } });
  expect(item.apply("disabled").status).toBe("applied");
  writeFileSync(item.preferences, JSON.stringify({ net: { network_prediction_options: 0, later: "keep" } }));
  const original = readFileSync(item.preferences, "utf8");
  expect(item.apply("disabled")).toEqual({ status: "user-change-preserved" });
  expect(existsSync(item.record)).toBe(true); expect(readFileSync(item.preferences, "utf8")).toBe(original);
  expect(item.apply("browser-default")).toEqual({ status: "user-change-preserved" });
  expect(existsSync(item.record)).toBe(false); expect(readFileSync(item.preferences, "utf8")).toBe(original);
});

test("root aliases and traversal cannot write outside the configured profile root", () => {
  const item = fixture({ keep: true });
  for (const userDataDir of [item.profilesRoot, item.directory, join(item.profilesRoot, "..", "other")]) {
    expect(applyChromiumPreloadingPreference({ profilesRoot: item.profilesRoot, userDataDir, mode: "disabled" })).toEqual({ status: "blocked", reason: "unsafe-path" });
  }
  expect(item.read()).toEqual({ keep: true }); expect(existsSync(join(item.directory, "other"))).toBe(false);
});

test("a junction under the profile directory cannot redirect Preferences into another environment", () => {
  const item = fixture();
  // Replace only this test's own empty Default directory, after validating its exact resolved target.
  const defaultDir = resolve(item.userDataDir, "Default");
  if (dirname(defaultDir) !== resolve(item.userDataDir)) throw new Error("Unexpected fixture cleanup path");
  rmdirSync(defaultDir);
  const target = join(item.directory, "other-synthetic"); mkdirSync(target); writeFileSync(join(target, "Preferences"), '{"keep":"other environment"}');
  symlinkSync(target, defaultDir, process.platform === "win32" ? "junction" : "dir");
  expect(item.apply("disabled")).toEqual({ status: "blocked", reason: "unsafe-path" });
  expect(readFileSync(join(target, "Preferences"), "utf8")).toBe('{"keep":"other environment"}'); expect(existsSync(item.record)).toBe(false);
});

test("a hard-linked Preferences file cannot make the helper read another environment's file", () => {
  const item = fixture();
  const target = join(item.directory, "other-synthetic-preferences.json"); writeFileSync(target, '{"keep":"other environment"}');
  linkSync(target, item.preferences);
  expect(item.apply("disabled")).toEqual({ status: "blocked", reason: "unsafe-path" });
  expect(readFileSync(target, "utf8")).toBe('{"keep":"other environment"}'); expect(existsSync(item.record)).toBe(false);
});

test("a dangling directory junction is refused before creating a recovery record", () => {
  const item = fixture();
  const defaultDir = resolve(item.userDataDir, "Default"); rmdirSync(defaultDir);
  const target = join(item.directory, "not-created");
  symlinkSync(target, defaultDir, process.platform === "win32" ? "junction" : "dir");
  expect(item.apply("disabled")).toEqual({ status: "blocked", reason: "unsafe-path" });
  expect(existsSync(target)).toBe(false); expect(existsSync(item.record)).toBe(false);
  // Remove only our exact junction so Windows cleanup does not resolve its missing target.
  if (dirname(defaultDir) !== resolve(item.userDataDir)) throw new Error("Unexpected fixture cleanup path");
  if (process.platform === "win32") rmdirSync(defaultDir); else unlinkSync(defaultDir);
});
