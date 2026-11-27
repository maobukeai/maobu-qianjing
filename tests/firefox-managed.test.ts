import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as browserInstall from "../browser-install.ts";
import { ensureManagedFirefox } from "../firefox-managed.ts";
import type { FirefoxRuntimeBuild, installFirefox } from "../firefox-install.ts";

const roots: string[] = [];
const restoreSpies: Array<() => void> = [];
const approvedBytes = "verified Firefox test executable";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore();
  const temporaryRoot = fs.realpathSync(tmpdir());
  for (const root of roots.splice(0)) {
    const target = fs.realpathSync(root);
    const child = relative(temporaryRoot, target);
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`) || !child.startsWith("maobu-firefox-managed-")) {
      throw new Error("Refusing to remove a test directory outside its temporary root");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "maobu-firefox-managed-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtimes");
  const platform = process.platform;
  const arch = process.arch;
  const build: FirefoxRuntimeBuild = {
    platform, arch, executablePath: platform === "win32" ? "aliasmode.exe" : "aliasmode",
    archiveSha256: hash("approved archive"), executableSha256: hash(approvedBytes),
  };
  const managedRoot = join(runtimeRoot, `firefox-${platform}-${arch}-managed`);
  const metadata = join(managedRoot, "installed.json");
  let installations = 0;
  const options: Array<Parameters<typeof installFirefox>[0]> = [];
  const writeExecutable = (cwd: string, contents = approvedBytes) => {
    const path = join(cwd, "browser", "verified-release", build.executablePath);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, contents);
    return path;
  };
  const install: typeof installFirefox = async (value) => {
    installations++;
    options.push(value);
    return { path: writeExecutable(value.cwd!), sha256: build.executableSha256 };
  };
  const ensure = (installer: typeof installFirefox = install) => ensureManagedFirefox(runtimeRoot, platform, arch, { build, install: installer });
  return { root, runtimeRoot, platform, arch, build, managedRoot, metadata, writeExecutable, install, ensure, options, get installations() { return installations; } };
}

function watchHashes() {
  const spy = spyOn(browserInstall, "sha256File");
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

test("Firefox stays absent until explicitly requested, then publishes only a verified relative installation", async () => {
  const f = fixture();
  expect(f.installations).toBe(0);
  expect(fs.existsSync(f.runtimeRoot)).toBe(false);
  const executable = await f.ensure();
  expect(f.installations).toBe(1);
  expect(f.options).toEqual([{ cwd: f.managedRoot, platform: f.platform, arch: f.arch, writeEnv: false }]);
  const saved = JSON.parse(fs.readFileSync(f.metadata, "utf8"));
  expect(saved.sha256).toBe(f.build.executableSha256);
  expect(isAbsolute(saved.path)).toBe(false);
  expect(fs.realpathSync(resolve(f.managedRoot, saved.path))).toBe(executable);
  expect(await browserInstall.sha256File(executable)).toBe(f.build.executableSha256);
  expect(fs.existsSync(join(f.managedRoot, ".env"))).toBe(false);
});

test("concurrent opens share one in-flight Firefox install", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const installationStarted = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const install: typeof installFirefox = async (options) => {
    calls++;
    entered();
    await gate;
    return f.install(options);
  };
  const first = f.ensure(install);
  await installationStarted;
  const second = f.ensure(install);
  const third = f.ensure(install);
  expect(calls).toBe(1);
  release();
  const results = await Promise.all([first, second, third]);
  expect(new Set(results).size).toBe(1);
  expect(f.installations).toBe(1);
});

test("cache hits rehash the executable without reinstalling", async () => {
  const f = fixture();
  const executable = await f.ensure();
  const spy = watchHashes();
  expect(await f.ensure()).toBe(executable);
  expect(f.installations).toBe(1);
  expect(spy).toHaveBeenCalledWith(executable);
});

test("a changed cached executable is replaced by a newly verified install", async () => {
  const f = fixture();
  const executable = await f.ensure();
  fs.writeFileSync(executable, "tampered executable");
  expect(await f.ensure()).toBe(executable);
  expect(f.installations).toBe(2);
  expect(await browserInstall.sha256File(executable)).toBe(f.build.executableSha256);
});

test("escaping cache metadata is never hashed or reused", async () => {
  const f = fixture();
  const outside = join(f.root, "user-data", f.build.executablePath);
  fs.mkdirSync(dirname(outside), { recursive: true });
  fs.writeFileSync(outside, approvedBytes);
  fs.mkdirSync(f.managedRoot, { recursive: true });
  fs.writeFileSync(f.metadata, JSON.stringify({ path: relative(f.managedRoot, outside), sha256: f.build.executableSha256 }));
  const spy = watchHashes();
  const executable = await f.ensure();
  expect(executable).not.toBe(fs.realpathSync(outside));
  expect(f.installations).toBe(1);
  expect(spy.mock.calls.map(([path]) => path)).not.toContain(fs.realpathSync(outside));
  expect(fs.readFileSync(outside, "utf8")).toBe(approvedBytes);
  expect(resolve(f.managedRoot, JSON.parse(fs.readFileSync(f.metadata, "utf8")).path)).toBe(executable);
});

test("an installer cannot return an executable outside its managed directory", async () => {
  const f = fixture();
  const outside = join(f.root, "user-data", f.build.executablePath);
  fs.mkdirSync(dirname(outside), { recursive: true });
  fs.writeFileSync(outside, approvedBytes);
  const spy = watchHashes();
  await expect(f.ensure(async () => ({ path: outside, sha256: f.build.executableSha256 }))).rejects.toThrow("escaped");
  expect(spy).not.toHaveBeenCalled();
  expect(fs.existsSync(f.metadata)).toBe(false);
  expect(fs.readFileSync(outside, "utf8")).toBe(approvedBytes);
});

test("an executable reached through a directory junction cannot escape the cache", async () => {
  const f = fixture();
  const outside = join(f.root, "user-data");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(join(outside, f.build.executablePath), approvedBytes);
  const spy = watchHashes();
  await expect(f.ensure(async (options) => {
    const link = join(options.cwd!, "linked-user-data");
    fs.symlinkSync(outside, link, "junction");
    return { path: join(link, f.build.executablePath), sha256: f.build.executableSha256 };
  })).rejects.toThrow("escaped");
  expect(spy).not.toHaveBeenCalled();
  expect(fs.existsSync(f.metadata)).toBe(false);
  expect(fs.readFileSync(join(outside, f.build.executablePath), "utf8")).toBe(approvedBytes);
});

test("a managed-directory junction is rejected before accessing or installing into user data", async () => {
  const f = fixture();
  const outside = join(f.root, "user-data");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(f.runtimeRoot, { recursive: true });
  fs.writeFileSync(join(outside, "profiles.sqlite"), "private profile bytes");
  fs.symlinkSync(outside, f.managedRoot, "junction");
  const spy = watchHashes();
  await expect(f.ensure()).rejects.toThrow(/escaped|outside/);
  expect(f.installations).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(fs.readdirSync(outside)).toEqual(["profiles.sqlite"]);
  expect(fs.readFileSync(join(outside, "profiles.sqlite"), "utf8")).toBe("private profile bytes");
});

test("a failed executable check publishes no metadata and permits a later retry", async () => {
  const f = fixture();
  await expect(f.ensure(async (options) => ({ path: f.writeExecutable(options.cwd!, "wrong executable"), sha256: f.build.executableSha256 }))).rejects.toThrow("SHA-256");
  expect(fs.existsSync(f.metadata)).toBe(false);
  expect(fs.readdirSync(f.managedRoot).filter((name) => name.includes("installed.json"))).toEqual([]);
  expect(await f.ensure()).toBe(fs.realpathSync(join(f.managedRoot, "browser", "verified-release", f.build.executablePath)));
  expect(f.installations).toBe(1);
});

test("an install reporting another approval hash cannot publish metadata", async () => {
  const f = fixture();
  await expect(f.ensure(async (options) => ({ path: f.writeExecutable(options.cwd!), sha256: hash("unapproved build") }))).rejects.toThrow("approval");
  expect(fs.existsSync(f.metadata)).toBe(false);
  expect(fs.readdirSync(f.managedRoot).filter((name) => name.includes("installed.json"))).toEqual([]);
});

test("download failure preserves prior metadata and never reads or deletes local profile data", async () => {
  const f = fixture();
  fs.mkdirSync(f.managedRoot, { recursive: true });
  const metadata = JSON.stringify({ path: "missing-old-executable", sha256: f.build.executableSha256 });
  fs.writeFileSync(f.metadata, metadata);
  const files = [join(f.root, "profiles.sqlite"), join(f.root, ".env"), join(f.runtimeRoot, "notes.txt")];
  for (const path of files) fs.writeFileSync(path, "private data: " + path);
  const reads = spyOn(fs, "readFileSync");
  restoreSpies.push(() => reads.mockRestore());
  const hashes = watchHashes();
  await expect(f.ensure(async () => { throw new Error("simulated download failure"); })).rejects.toThrow("simulated download failure");
  const readPaths = reads.mock.calls.map(([path]) => String(path));
  expect(readPaths).toContain(f.metadata);
  for (const path of files) expect(readPaths).not.toContain(path);
  expect(hashes).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.metadata, "utf8")).toBe(metadata);
  for (const path of files) expect(fs.readFileSync(path, "utf8")).toBe("private data: " + path);
  expect(fs.readdirSync(f.managedRoot)).toEqual(["installed.json"]);
});
