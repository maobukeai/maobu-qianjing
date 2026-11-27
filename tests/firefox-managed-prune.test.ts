import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory, pruneManagedFirefoxRuntimes } from "../firefox-managed.ts";
import { firefoxInstallDirectoryPrefix } from "../firefox-install.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(record?: unknown) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "maobu-firefox-prune-"));
  roots.push(runtimeRoot);
  const platform = process.platform, arch = process.arch;
  const managed = join(runtimeRoot, firefoxManagedDirectory(platform, arch));
  const cache = join(managed, "browser");
  const prefix = firefoxInstallDirectoryPrefix(platform, arch);
  const dir = (name: string) => { const path = join(cache, name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "firefox.exe"), "x"); return path; };
  const current = dir(`${prefix}current`), old = dir(`${prefix}old`), live = dir(`${prefix}live`), other = dir("unrelated");
  if (record !== null) writeFileSync(join(managed, FIREFOX_MANAGED_RECORD), JSON.stringify(record ?? { path: join("browser", `${prefix}current`, "firefox.exe"), sha256: "a" }));
  return { runtimeRoot, platform, arch, current, old, live, other };
}

test("removes old Firefox installs and keeps the current, live and unrelated folders", () => {
  const f = fixture();
  pruneManagedFirefoxRuntimes(f.runtimeRoot, [join(f.live, "firefox.exe")], f.platform, f.arch);
  expect(existsSync(f.current)).toBe(true);
  expect(existsSync(f.live)).toBe(true);
  expect(existsSync(f.other)).toBe(true);
  expect(existsSync(f.old)).toBe(false);
});

test("removes nothing without a readable install record", () => {
  const f = fixture(null);
  pruneManagedFirefoxRuntimes(f.runtimeRoot, [], f.platform, f.arch);
  expect(existsSync(f.old)).toBe(true);
  expect(existsSync(f.current)).toBe(true);
});

test("removes nothing when the record path is absolute", () => {
  const f = fixture({ path: "/etc/firefox", sha256: "a" });
  pruneManagedFirefoxRuntimes(f.runtimeRoot, [], f.platform, f.arch);
  expect(existsSync(f.old)).toBe(true);
});

test("removes nothing when the record path escapes the managed root", () => {
  const f = fixture({ path: "../outside/firefox.exe", sha256: "a" });
  pruneManagedFirefoxRuntimes(f.runtimeRoot, [], f.platform, f.arch);
  expect(existsSync(f.old)).toBe(true);
  expect(existsSync(f.current)).toBe(true);
});

test("does not recursively delete through a linked runtime folder", () => {
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), "maobu-firefox-external-"));
  roots.push(external);
  const sentinel = join(external, "keep.txt");
  writeFileSync(sentinel, "safe");
  const prefix = firefoxInstallDirectoryPrefix(f.platform, f.arch);
  const linked = join(dirname(f.old), `${prefix}linked`);
  symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
  try {
    pruneManagedFirefoxRuntimes(f.runtimeRoot, [join(f.live, "firefox.exe")], f.platform, f.arch);
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(f.old)).toBe(false);
  } finally {
    if (existsSync(linked) && lstatSync(linked).isSymbolicLink()) {
      if (process.platform === "win32") rmdirSync(linked); else unlinkSync(linked);
    }
  }
});

test("a missing runtime root is ignored", () => {
  expect(() => pruneManagedFirefoxRuntimes(join(tmpdir(), "maobu-missing-root-xyz"), [])).not.toThrow();
});
