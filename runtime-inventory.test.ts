import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { defaultChromiumRuntime, managedChromiumLocation } from "./aliasmode-chromium.ts";
import { firefoxBuildForHost, firefoxInstallDirectoryPrefix } from "./firefox-install.ts";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory } from "./firefox-managed.ts";
import { Launcher } from "./launcher.ts";
import { getBrowserRuntimeInventory, inspectBrowserRuntimeInventory, type BrowserRuntimeInventory, type RuntimeInventoryDeployment } from "./runtime-inventory.ts";
import type { ProfileStore } from "./store.ts";
import { serveDashboard } from "./web.ts";

const fixtureParent = resolve(import.meta.dir, "node_modules/.cache/runtime-inventory-tests");
const fixtures: string[] = [];
function fixture() {
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, "inventory-"));
  fixtures.push(root);
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (!resolve(root).startsWith(fixtureParent + sep) || !basename(root).startsWith("inventory-") || realpathSync(root) !== root) {
      throw new Error("Runtime inventory fixture cleanup escaped its parent");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function deployment(runtimeRoot: string, platform: NodeJS.Platform = "win32", arch = "x64", env: NodeJS.ProcessEnv = {}): RuntimeInventoryDeployment {
  return { runtimeRoot, platform, arch, cloakSource: "managed", firefoxSource: "managed",
    chromiumDefault: defaultChromiumRuntime(platform, arch, env) ? "aliasmode-chromium" : "cloakbrowser" };
}
const states = (inventory: BrowserRuntimeInventory) => inventory.runtimes.map(runtime => runtime.cache);
const fakeStore = new Proxy({} as ProfileStore, { get() { throw new Error("Inventory must not access profile data"); } });
const fakeLauncher = new Proxy({} as Launcher, { get() { throw new Error("Inventory must not invoke a launcher"); } });

test("static catalog reports platform pins and the real omitted-runtime policy without accessing its cache root", () => {
  const expected = [
    ["win32", "x64", [true, true, true], "aliasmode-chromium", "aliasmode-chromium", "146.0.7680.177.5"],
    ["linux", "x64", [true, true, true], "aliasmode-firefox", "aliasmode-chromium", "146.0.7680.177.5"],
    ["darwin", "arm64", [true, true, true], "aliasmode-firefox", "aliasmode-chromium", "145.0.7632.109.2"],
    ["darwin", "x64", [false, true, true], "aliasmode-firefox", "cloakbrowser", "145.0.7632.109.2"],
    ["linux", "arm64", [false, false, false], "aliasmode-firefox", "cloakbrowser", "146.0.7680.177.5"],
    ["win32", "arm64", [false, false, false], "cloakbrowser", "cloakbrowser", "146.0.7680.177.5"],
  ] as const;
  for (const [platform, arch, supported, defaultRuntime, chromiumDefault, cloakPin] of expected) {
    const source = { ...deployment("unused", platform, arch), get runtimeRoot(): string { throw new Error("Static catalog touched the cache root"); } };
    const result = getBrowserRuntimeInventory(source);
    expect(result.host).toEqual({ platform, arch });
    expect(result.checked).toBe(false);
    expect(result.runtimes.map(runtime => runtime.hostSupported)).toEqual([...supported]);
    expect(result.runtimes.map(runtime => runtime.pinnedVersion)).toEqual(["155.0.8059.85-aliasmode.5", cloakPin, "156.0.1-beta.36"]);
    expect(result.defaultRuntime).toBe(defaultRuntime);
    expect(result.chromiumDefault).toBe(chromiumDefault);
    expect(states(result)).toEqual(supported.map(value => value ? "not-checked" : "not-applicable"));
  }
});

test("Launcher snapshots its real cache root and configured sources without exposing executable paths", () => {
  const key = "CLOAKBROWSER_BINARY_PATH";
  const previous = process.env[key];
  process.env[key] = "private-configured-cloak-path";
  try {
    const runtimeRoot = join(fixture(), "shared-home", "runtimes");
    const launcher = new Launcher({ store: { listLaunches: () => [] } as unknown as ProfileStore,
      chromiumRuntimeRoot: runtimeRoot, hostPlatform: "darwin", hostArch: "arm64", firefoxBinaryPath: "private-configured-firefox-path" });
    const snapshot = launcher.browserRuntimeDeployment;
    expect(snapshot.runtimeRoot).toBe(runtimeRoot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.chromiumDefault).toBe("cloakbrowser");
    const inventory = getBrowserRuntimeInventory(snapshot);
    expect(inventory.defaultRuntime).toBe("aliasmode-firefox");
    expect(inventory.runtimes.map(row => row.source)).toEqual(["managed", "configured", "configured"]);
    expect(states(inventory)).toEqual(["not-checked", "not-applicable", "not-applicable"]);
    expect(JSON.stringify(inventory)).not.toContain("private-configured-");
    expect(existsSync(runtimeRoot)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test("explicit inspection leaves a missing cache root absent and skips UNC roots", async () => {
  const runtimeRoot = join(fixture(), "shared-home", "runtimes");
  const result = await inspectBrowserRuntimeInventory(deployment(runtimeRoot));
  expect(result.checked).toBe(true);
  expect(states(result)).toEqual(["missing", "missing", "missing"]);
  expect(existsSync(dirname(runtimeRoot))).toBe(false);
  const network = await inspectBrowserRuntimeInventory(deployment("\\\\not-a-local-host.invalid\\private-share\\runtimes"));
  expect(states(network)).toEqual(["not-checked", "not-checked", "not-checked"]);
  expect(JSON.stringify(network)).not.toContain("private-share");
});

function putChromium(root: string, runtime: "aliasmode" | "cloakbrowser", directoryOnly = false) {
  const location = managedChromiumLocation(runtime, "win32", "x64")!;
  const path = join(root, location.directory, location.executable);
  if (directoryOnly) mkdirSync(path, { recursive: true });
  else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "synthetic, deliberately unverified bytes"); }
  return path;
}
function firefoxFixture(root: string) {
  const build = firefoxBuildForHost("win32", "x64");
  const directory = join(root, firefoxManagedDirectory("win32", "x64"));
  const installParent = join(directory, "browser");
  mkdirSync(installParent, { recursive: true });
  const installed = basename(mkdtempSync(join(installParent, firefoxInstallDirectoryPrefix("win32", "x64"))));
  const record = join(directory, FIREFOX_MANAGED_RECORD);
  const relative = `browser/${installed}/${build.executablePath}`;
  const executable = join(directory, relative);
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "synthetic Firefox bytes");
  writeFileSync(record, JSON.stringify({ path: relative.replaceAll("/", "\\"), sha256: build.executableSha256 }));
  return { build, directory, record, executable, relative };
}

test("fixed candidates distinguish found files, an incomplete cache, and uninspected configured sources", async () => {
  const root = join(fixture(), "shared-home", "runtimes");
  const source = deployment(root);
  putChromium(root, "aliasmode");
  putChromium(root, "cloakbrowser", true);
  firefoxFixture(root);
  expect(states(getBrowserRuntimeInventory(source))).toEqual(["not-checked", "not-checked", "not-checked"]);
  expect(states(await inspectBrowserRuntimeInventory(source))).toEqual(["present-unverified", "incomplete", "present-unverified"]);
  const configured = await inspectBrowserRuntimeInventory({ ...source, cloakSource: "bundled", firefoxSource: "configured" });
  expect(states(configured)).toEqual(["present-unverified", "not-applicable", "not-applicable"]);
});

test("Firefox records must be bounded and point to the exact pinned installer layout", async () => {
  const root = join(fixture(), "runtimes");
  const source = deployment(root);
  const firefox = firefoxFixture(root);
  const sha256 = firefox.build.executableSha256;
  for (const invalid of ["not-json", " ".repeat(4097), "null", "[]",
    JSON.stringify({ path: firefox.relative, sha256: "a".repeat(64) }),
    JSON.stringify({ path: firefox.relative, sha256, unexpected: true }),
    JSON.stringify({ path: firefox.executable, sha256 }),
    JSON.stringify({ path: `../${firefox.relative}`, sha256 }),
    JSON.stringify({ path: firefox.relative.replace("aliasmode.exe", "other.exe"), sha256 }),
    JSON.stringify({ path: firefox.relative.replace("aliasmode.exe", "../aliasmode.exe"), sha256 }),
  ]) {
    writeFileSync(firefox.record, invalid);
    const row = (await inspectBrowserRuntimeInventory(source)).runtimes[2]!;
    expect(row.cache).toBe("incomplete");
    expect(JSON.stringify(row)).not.toContain(sha256);
  }
});

test("cache checks stop at linked components rather than inspecting their target", async () => {
  const home = fixture();
  const root = join(home, "runtimes");
  const outside = join(home, "not-the-cache");
  const firefox = firefoxFixture(root);
  mkdirSync(outside);
  writeFileSync(join(outside, firefox.build.executablePath), "outside the fixed runtime path");
  const installed = dirname(firefox.executable);
  if (!resolve(installed).startsWith(home + sep) || realpathSync(installed) !== installed) throw new Error("Unsafe link fixture setup");
  rmSync(installed, { recursive: true });
  symlinkSync(outside, installed, process.platform === "win32" ? "junction" : "dir");
  expect((await inspectBrowserRuntimeInventory(deployment(root))).runtimes[2]?.cache).toBe("unreadable");
  const linkedParent = join(home, "linked-parent");
  symlinkSync(root, linkedParent, process.platform === "win32" ? "junction" : "dir");
  expect(states(await inspectBrowserRuntimeInventory(deployment(join(linkedParent, "missing-child"))))).toEqual(["unreadable", "unreadable", "unreadable"]);
});

test("real dashboard settings routes guard static GET and explicit cache POST before accessing local paths", async () => {
  const root = join(fixture(), "workspace-home", "runtimes");
  putChromium(root, "aliasmode");
  let reads = 0;
  const source = { ...deployment(root), get runtimeRoot() { reads++; return root; } };
  const server = serveDashboard({ port: 0, store: fakeStore, launcher: fakeLauncher, runtimeInventory: source, log: () => {} });
  const origin = `http://127.0.0.1:${server.port}`;
  const path = `${origin}/ui/api/settings/runtimes`;
  const settingsHeader = { "X-Maobu-Settings": "1", Origin: origin };
  const post = (body: string, headers = settingsHeader, suffix = "") => fetch(`${path}/inspect${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
  try {
    expect((await fetch(path)).status).toBe(403);
    expect((await post("{}", { ...settingsHeader, Origin: "https://outside.invalid" })).status).toBe(403);
    expect((await fetch(`${path}/inspect`, { headers: settingsHeader })).status).toBe(405);
    const rejected = await post('{"runtimeRoot":"private-request-path"}');
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("private-request-path");
    expect((await post("{}", settingsHeader, "?runtimeRoot=ignored")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect(reads).toBe(0);
    const listed = await fetch(path, { headers: settingsHeader });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const catalog = await listed.json() as { inventory: BrowserRuntimeInventory };
    expect(catalog.inventory.checked).toBe(false);
    expect(states(catalog.inventory)).toEqual(["not-checked", "not-checked", "not-checked"]);
    expect(reads).toBe(0);
    const inspected = await post("{}");
    expect(inspected.status).toBe(200);
    const json = await inspected.text();
    const checked = JSON.parse(json) as { inventory: BrowserRuntimeInventory };
    expect(checked.inventory.checked).toBe(true);
    expect(states(checked.inventory)).toEqual(["present-unverified", "missing", "missing"]);
    expect(json).not.toContain("workspace-home");
    expect(json).not.toContain("chrome.exe");
    expect(reads).toBe(1);
  } finally { server.stop(true); }
});
