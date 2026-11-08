import { afterEach, describe, expect, test } from "bun:test";
import { resolve, sep, join, isAbsolute, dirname } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureStateDirectories, legacyStatePaths, resolveStateRoot, statePaths } from "./paths.ts";
import * as pathModule from "./paths.ts";

const roots: string[] = [];
afterEach(() => {
  const temporaryRoot = realpathSync(tmpdir());
  for (const root of roots.splice(0)) {
    const target = realpathSync(root);
    if (dirname(target) !== temporaryRoot || !target.startsWith(join(temporaryRoot, "maobu-paths-"))) throw new Error("Unexpected path test cleanup target");
    rmSync(target, { recursive: true, force: true });
  }
});

function temporaryState() {
  const root = mkdtempSync(join(tmpdir(), "maobu-paths-"));
  roots.push(root);
  return statePaths(root);
}

describe("local state paths", () => {
  test("explicit state root wins over environment and cwd", () => {
    expect(resolveStateRoot(["--state-root", "./explicit"], { ALIASMODE_STATE_ROOT: "./env" }, "/tmp/base"))
      .toBe(resolve("/tmp/base", "explicit"));
  });

  test("environment root is used by packaged sidecars", () => {
    expect(resolveStateRoot([], { ALIASMODE_STATE_ROOT: "./env" }, "/tmp/base"))
      .toBe(resolve("/tmp/base", "env"));
  });

  test("CLI defaults to its current working directory", () => {
    expect(resolveStateRoot([], {}, "/tmp/base")).toBe(resolve("/tmp/base"));
  });

  test("active paths contain no remote store, queue, key, or device identity", () => {
    const parent = temporaryState();
    const paths = statePaths(join(parent.root, "not-created"));
    for (const field of ["cloudDatabase", "cloudProfiles", "pendingSync", "pendingSyncKey", "operatorId"]) expect(Object.hasOwn(paths, field)).toBe(false);
    expect(Object.hasOwn(pathModule, "profileDataPaths")).toBe(false);
    expect(legacyStatePaths(paths.root)).toMatchObject({
      cloudDatabase: resolve(paths.root, "cloud-cache", "profiles.sqlite"),
      pendingSyncKey: resolve(paths.root, "pending-sync.key"),
    });
    expect(existsSync(paths.root)).toBe(false);
  });

  test("directory initialization creates only local folders", () => {
    const paths = temporaryState();
    ensureStateDirectories(paths);
    expect(readdirSync(paths.root).sort()).toEqual(["browser", "extensions", "inbox", "profiles", "reports"]);
    expect(existsSync(legacyStatePaths(paths.root).cloudRoot)).toBe(false);
    expect(existsSync(legacyStatePaths(paths.root).pendingSyncKey)).toBe(false);
    expect(existsSync(legacyStatePaths(paths.root).operatorId)).toBe(false);
  });

  test("initialization leaves retained legacy data and credentials untouched", () => {
    const paths = temporaryState();
    const legacy = legacyStatePaths(paths.root);
    const cookies = join(legacy.cloudProfiles, "retained-profile", "Cookies");
    mkdirSync(dirname(cookies), { recursive: true });
    writeFileSync(cookies, "private old session");
    writeFileSync(legacy.pendingSyncKey, "retained old encryption key");
    ensureStateDirectories(paths);
    expect(readFileSync(cookies, "utf8")).toBe("private old session");
    expect(readFileSync(legacy.pendingSyncKey, "utf8")).toBe("retained old encryption key");
    expect(readdirSync(paths.profiles)).toEqual([]);
    expect(existsSync(paths.database)).toBe(false);
  });

  test("all active and legacy protection paths remain below the selected root", () => {
    const root = resolve("/tmp/maobu-state");
    const paths = statePaths(root);
    expect(paths.root).toBe(root);
    for (const path of [...Object.values(paths).filter((path) => path !== root), ...Object.values(legacyStatePaths(root))]) {
      expect(isAbsolute(path)).toBe(true);
      expect(path.startsWith(`${root}${sep}`)).toBe(true);
    }
  });
});
