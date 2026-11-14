import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceCatalog } from "../workspaces.ts";
import { acceptanceEnvironment, debugBinaryProtocol, parseAcceptanceCli, prepareNativeAcceptance, validateNativeAcceptance } from "./native-desktop-acceptance.mjs";

// Every test root is created by this process under Temp and recorded before use.
const owned: string[] = [];
const testParent = join(process.cwd(), "node_modules", ".cache", "native-launcher-tests");
afterEach(async () => {
  for (const directory of owned.splice(0)) {
    const path = await realpath(directory);
    if (path !== directory || !(await lstat(path)).isDirectory() || !path.startsWith(join(await realpath(testParent), "maobu-native-launcher-tests-"))) throw new Error("Refusing unsafe test cleanup");
    await rm(path, { recursive: true });
  }
});
async function fixture(binary = Buffer.from(`mock native\0${debugBinaryProtocol}\0`)) {
  await mkdir(testParent, { recursive: true });
  const base = await mkdtemp(join(await realpath(testParent), "maobu-native-launcher-tests-"));
  owned.push(base);
  const runtimeRoot = join(base, "MaobuBrowser-local-0123456789abcdef");
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, "aliasmode.exe"), binary);
  await writeFile(join(runtimeRoot, "local-build-ready.json"), JSON.stringify({ localOnly: true, hashes: { "aliasmode.exe": createHash("sha256").update(binary).digest("hex") } }));
  const options = { temporaryDirectory: base, runtimeFactory: async () => ({ runtimeRoot, bundledFirefox: false }) };
  return { base, runtimeRoot, options };
}
test("acceptance defaults to preparation, and launch needs an explicit reviewed manifest", () => {
  expect(parseAcceptanceCli([])).toEqual({ mode: "prepare", manifestPath: undefined, json: false });
  expect(parseAcceptanceCli(["--launch", "--manifest", "C:/Temp/qa/acceptance-manifest.json", "--json"]).mode).toBe("launch");
  expect(parseAcceptanceCli(["--validate-native", "--manifest", "C:/Temp/qa/acceptance-manifest.json"]).mode).toBe("native-validate");
  for (const args of [["--launch"], ["--manifest", "arbitrary"], ["--prepare-only", "--launch"], ["--validate-only"], ["--manifest"], ["--json", "--json"], ["--unknown"]]) expect(() => parseAcceptanceCli(args)).toThrow();
});
test("prepare writes a synthetic catalog and fixed paths without executing the fixture binary", async () => {
  const fixtureData = await fixture();
  const { manifestPath, manifest } = await prepareNativeAcceptance(fixtureData.options);
  const accepted = await validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.base });
  expect(accepted.paths).toEqual(manifest.paths);
  expect(accepted.argv).toEqual(["--native-acceptance-root", manifest.paths.root, "--native-acceptance-proof", manifest.proof]);
  expect(accepted.validationArgv.at(-1)).toBe("--native-acceptance-validate");
  const catalogPath = join(manifest.paths.backendHome, "desktop-workspaces.json");
  const seededBytes = await readFile(catalogPath, "utf8");
  // Exercise the actual sidecar catalog, including its stricter color/icon
  // allowlists. Merely parsing JSON (or native path preflight) missed this drift.
  const catalog = new WorkspaceCatalog(manifest.paths.backendHome, manifest.paths.backendHome);
  expect(catalog.activeId()).toBe("default");
  expect(catalog.currentId()).toBe("default");
  expect(catalog.pathFor("default")).toBe(manifest.paths.backendHome);
  expect(catalog.list()).toEqual([{ id: "default", name: "原生隔离验收", color: "#8169c8", icon: "folder", createdAt: manifest.createdAtMs, updatedAt: manifest.createdAtMs, lastOpenedAt: manifest.createdAtMs, archived: false }]);
  expect(await readFile(catalogPath, "utf8")).toBe(seededBytes);
  expect(await lstat(join(manifest.paths.root, "acceptance.lock")).catch(() => null)).toBeNull();
  expect(await lstat(join(manifest.paths.backendHome, "agent-runtime.json")).catch(() => null)).toBeNull();
  expect(await lstat(join(manifest.paths.backendHome, "profiles.sqlite")).catch(() => null)).toBeNull();
});
test("old or release native binaries are rejected before creating a QA root or starting a process", async () => {
  const fixtureData = await fixture(Buffer.from("old native executable without protocol"));
  await expect(prepareNativeAcceptance(fixtureData.options)).rejects.toThrow("lacks the debug acceptance protocol");
});
test("validation refuses changed marker proofs, escaped paths, injected argv and mutated binaries", async () => {
  const fixtureData = await fixture();
  const { manifestPath, manifest } = await prepareNativeAcceptance(fixtureData.options);
  const validate = () => validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.base });
  const writeManifest = (value: unknown) => writeFile(manifestPath, JSON.stringify(value));
  await writeManifest({ ...manifest, paths: { ...manifest.paths, backendHome: join(fixtureData.base, "real-business-home") } });
  await expect(validate()).rejects.toThrow("paths changed");
  await writeManifest({ ...manifest, argv: [...manifest.argv, "--import-cloakpit"] });
  await expect(validate()).rejects.toThrow("arguments changed");
  await writeManifest({ ...manifest, launcherEnvironment: { ...manifest.launcherEnvironment, USERPROFILE: manifest.paths.root } });
  await expect(validate()).rejects.toThrow("environment changed");
  await writeManifest(manifest);
  const markerPath = join(manifest.paths.root, "acceptance-marker.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, proof: "0".repeat(64) }));
  await expect(validate()).rejects.toThrow("ownership marker does not match");
  await writeFile(markerPath, JSON.stringify(marker));
  await writeFile(manifest.nativeExecutable, Buffer.from(`changed binary ${debugBinaryProtocol}`));
  await expect(validate()).rejects.toThrow("hash changed");
});
test("validation refuses expired sessions, a different Temp base, and reparse data paths", async () => {
  const fixtureData = await fixture();
  const { manifestPath, manifest } = await prepareNativeAcceptance(fixtureData.options);
  await expect(validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.base, now: manifest.createdAtMs + 86_400_001 })).rejects.toThrow("expired");
  await expect(validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.runtimeRoot })).rejects.toThrow("direct canonical child");
  const saved = manifest.paths.artifacts;
  await rmdir(saved);
  await symlink(fixtureData.runtimeRoot, saved, process.platform === "win32" ? "junction" : "dir");
  await expect(validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.base })).rejects.toThrow("ordinary directory");
  await unlink(saved);
});
test("MCP is pinned to the isolated descriptor and cannot relaunch an argument-free native process", async () => {
  const fixtureData = await fixture();
  const { manifestPath, manifest } = await prepareNativeAcceptance(fixtureData.options);
  expect(manifest.processEnvironmentAfterPreflight.ALIASMODE_RUNTIME_DESCRIPTOR).toBe(join(manifest.paths.backendHome, "agent-runtime.json"));
  const blockedExecutable = join(manifest.paths.root, "native-relaunch-disabled.exe");
  expect(manifest.processEnvironmentAfterPreflight.ALIASMODE_DESKTOP_EXE).toBe(blockedExecutable);
  await writeFile(blockedExecutable, "not executable");
  await expect(validateNativeAcceptance(manifestPath, { temporaryDirectory: fixtureData.base })).rejects.toThrow("disabled path must remain absent");
});
test("the child gets isolated AppData while HOME, USERPROFILE, CODEX_HOME and system Temp stay intact", async () => {
  const fixtureData = await fixture();
  const { manifest } = await prepareNativeAcceptance(fixtureData.options);
  const inherited = { HOME: "original-home", USERPROFILE: "original-profile", CODEX_HOME: "original-codex", TEMP: "original-temp", TMP: "original-tmp", APPDATA: "original-roaming", LOCALAPPDATA: "original-local", WEBVIEW2_USER_DATA_FOLDER: "real-user-data", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222", WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER: "pipe", ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG: "1", ALIASMODE_RUNTIME_DESCRIPTOR: "real-descriptor", ALIASMODE_DESKTOP_EXE: "real-desktop-executable", ALIASMODE_ACCESS_TOKEN: "do-not-inherit", HUB_PASSWORD: "do-not-inherit" };
  const environment = acceptanceEnvironment(manifest, inherited);
  expect(environment.HOME).toBe(inherited.HOME);
  expect(environment.USERPROFILE).toBe(inherited.USERPROFILE);
  expect(environment.CODEX_HOME).toBe(inherited.CODEX_HOME);
  expect(environment.TEMP).toBe(inherited.TEMP);
  expect(environment.TMP).toBe(inherited.TMP);
  expect(environment.APPDATA).toBe(manifest.paths.roaming);
  expect(environment.LOCALAPPDATA).toBe(manifest.paths.local);
  for (const key of ["WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG", "ALIASMODE_RUNTIME_DESCRIPTOR", "ALIASMODE_DESKTOP_EXE", "ALIASMODE_ACCESS_TOKEN", "HUB_PASSWORD"]) expect(environment[key]).toBeUndefined();
  expect(inherited.APPDATA).toBe("original-roaming");
  expect(inherited.WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER).toBe("pipe");
});
