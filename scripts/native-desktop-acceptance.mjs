// Debug native-window acceptance only. The default command prepares files; it never launches UI.
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareLocalDesktop } from "./run-local-desktop.mjs";

export const protocol = "maobu-native-acceptance-v1";
export const debugBinaryProtocol = "MAOBU_NATIVE_ACCEPTANCE_DEBUG_V1";
const prefix = "maobu-native-acceptance-";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const forbiddenInherited = /^(WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER|BROWSER_EXECUTABLE_FOLDER|RELEASE_CHANNEL_PREFERENCE|RELEASE_CHANNELS|CHANNEL_SEARCH_KIND)|ALIASMODE_(ACCEPTANCE_WEBVIEW_DEBUG(_PORT)?|RUNTIME_DESCRIPTOR|DESKTOP_EXE))$/i;
const secretInherited = /^(ALIASMODE_(CLOUD|SUPABASE|ACCESS_TOKEN|REFRESH_TOKEN|DEVICE_CREDENTIAL|QUEUE_ENCRYPTION_KEY)|HUB_)/i;
const sameObject = (left, right) => left && right && Object.keys(left).sort().join() === Object.keys(right).sort().join() && Object.keys(left).every((key) => left[key] === right[key]);

async function ordinary(path, type = "directory") {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (type === "directory" ? !info.isDirectory() : !info.isFile())) throw new Error(`Acceptance requires an ordinary ${type}: ${path}`);
  if (await realpath(path) !== path) throw new Error(`Acceptance path must be canonical: ${path}`);
  return info;
}
async function jsonFile(path, limit = 16_384) {
  const info = await ordinary(path, "file");
  if (info.size > limit) throw new Error("Acceptance JSON file is too large");
  const data = await readFile(path);
  if (data.length > limit) throw new Error("Acceptance JSON changed while reading");
  return JSON.parse(data.toString("utf8"));
}
function pathsFor(root) {
  const roaming = join(root, "roaming"), local = join(root, "local");
  return { root, backendHome: join(roaming, "com.maobu.local"), webviewData: join(local, "com.maobu.local", "webview"), roaming, local, temp: join(root, "temp"), artifacts: join(root, "artifacts") };
}
function fresh(createdAtMs, now = Date.now()) {
  return Number.isSafeInteger(createdAtMs) && createdAtMs > 0 && createdAtMs <= now + 300_000 && now - createdAtMs <= 86_400_000;
}
function nativeArgs(root, proof, validate = false) {
  return ["--native-acceptance-root", root, "--native-acceptance-proof", proof, ...(validate ? ["--native-acceptance-validate"] : [])];
}
function processEnvironment(paths) {
  return { APPDATA: paths.roaming, LOCALAPPDATA: paths.local, TEMP: paths.temp, TMP: paths.temp, WEBVIEW2_USER_DATA_FOLDER: paths.webviewData, ALIASMODE_RUNTIME_DESCRIPTOR: join(paths.backendHome, "agent-runtime.json"), ALIASMODE_DESKTOP_EXE: join(paths.root, "native-relaunch-disabled.exe") };
}
async function verifiedExecutable(runtimeRoot, expectedHash) {
  if (!isAbsolute(runtimeRoot) || !/^MaobuBrowser-local-[a-f0-9]{16}$/.test(basename(runtimeRoot))) throw new Error("Acceptance requires a prepared local runtime");
  await ordinary(runtimeRoot);
  const nativeExecutable = join(runtimeRoot, "aliasmode.exe");
  await ordinary(nativeExecutable, "file");
  const ready = await jsonFile(join(runtimeRoot, "local-build-ready.json"));
  const bytes = await readFile(nativeExecutable);
  const sha256 = hash(bytes);
  if (!bytes.includes(Buffer.from(debugBinaryProtocol))) throw new Error("Native executable lacks the debug acceptance protocol; rebuild before use. No executable was started.");
  if (ready.localOnly !== true || ready.hashes?.["aliasmode.exe"] !== sha256 || (expectedHash && expectedHash !== sha256)) throw new Error("Acceptance native executable hash changed");
  return { nativeExecutable, sha256 };
}

/** No process is started. runtimeFactory is injectable for pure filesystem tests. */
export async function prepareNativeAcceptance({ runtimeFactory = prepareLocalDesktop, temporaryDirectory = tmpdir(), now = Date.now() } = {}) {
  const runtime = await runtimeFactory();
  const binary = await verifiedExecutable(runtime.runtimeRoot);
  const base = await realpath(temporaryDirectory);
  const root = await mkdtemp(join(base, prefix));
  const paths = pathsFor(root);
  for (const path of [paths.backendHome, paths.webviewData, paths.temp, paths.artifacts]) await mkdir(path, { recursive: true });
  const proof = randomBytes(32).toString("hex");
  const marker = { version: 1, protocol, proof, createdAtMs: now, creatorPid: process.pid, root };
  await writeFile(join(root, "acceptance-marker.json"), JSON.stringify(marker, null, 2), { flag: "wx" });
  // Existing production catalog schema gives the frameless toolbar a visible QA label.
  await writeFile(join(paths.backendHome, "desktop-workspaces.json"), JSON.stringify({ version: 1, activeId: "default", workspaces: [{ id: "default", name: "原生隔离验收", color: "#8169c8", icon: "folder", createdAt: now, updatedAt: now, lastOpenedAt: now, archived: false }] }, null, 2), { flag: "wx" });
  const manifestPath = join(root, "acceptance-manifest.json");
  const manifest = {
    version: 1, protocol, purpose: "Native window, layout and editor acceptance with synthetic data only",
    createdAtMs: now, proof, paths, runtimeRoot: runtime.runtimeRoot, ...binary,
    argv: nativeArgs(root, proof), validationArgv: nativeArgs(root, proof, true),
    // TEMP stays inherited until native preflight has checked the root against system Temp.
    launcherEnvironment: { APPDATA: paths.roaming, LOCALAPPDATA: paths.local },
    processEnvironmentAfterPreflight: processEnvironment(paths),
    restricted: ["production-single-instance", "signed-updates", "native-restart", "external-open", "native-save-dialog", "webview-debugging"],
    allowedRuntimeReads: "Installed OS and WebView runtime files and installation registry may be read. Real com.maobu.local business data and UserData are excluded.",
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
  return { manifestPath, manifest };
}

/** Read-only validation; never executes an unverified (or any) executable. */
export async function validateNativeAcceptance(manifestPath, { temporaryDirectory = tmpdir(), now = Date.now() } = {}) {
  const manifest = await jsonFile(resolve(manifestPath));
  if (manifest.version !== 1 || manifest.protocol !== protocol || !fresh(manifest.createdAtMs, now) || !/^[a-f0-9]{64}$/.test(manifest.proof)) throw new Error("Invalid or expired acceptance manifest; prepare a new session");
  const root = manifest.paths?.root;
  const base = await realpath(temporaryDirectory);
  if (typeof root !== "string" || !isAbsolute(root) || normalize(root) !== root || dirname(root) !== base || !/^maobu-native-acceptance-[a-zA-Z0-9-]{6,}$/.test(basename(root))) throw new Error("Acceptance root must be a direct canonical child of system Temp");
  const paths = pathsFor(root);
  if (!sameObject(paths, manifest.paths) || resolve(manifestPath) !== join(root, "acceptance-manifest.json")) throw new Error("Acceptance paths changed");
  for (const path of [root, paths.roaming, paths.local, join(paths.local, "com.maobu.local"), paths.backendHome, paths.webviewData, paths.temp, paths.artifacts]) await ordinary(path);
  try {
    await lstat(join(root, "native-relaunch-disabled.exe"));
    throw new Error("Acceptance background-relaunch disabled path must remain absent");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const marker = await jsonFile(join(root, "acceptance-marker.json"), 4096);
  if (Object.keys(marker).sort().join() !== ["version", "protocol", "proof", "createdAtMs", "creatorPid", "root"].sort().join() || marker.version !== 1 || marker.protocol !== protocol || marker.proof !== manifest.proof || marker.root !== root || marker.createdAtMs !== manifest.createdAtMs || !Number.isInteger(marker.creatorPid) || marker.creatorPid <= 0) throw new Error("Acceptance ownership marker does not match");
  const binary = await verifiedExecutable(manifest.runtimeRoot, manifest.sha256);
  if (binary.nativeExecutable !== manifest.nativeExecutable || JSON.stringify(manifest.argv) !== JSON.stringify(nativeArgs(root, manifest.proof)) || JSON.stringify(manifest.validationArgv) !== JSON.stringify(nativeArgs(root, manifest.proof, true))) throw new Error("Acceptance executable or arguments changed");
  const expectedLauncher = { APPDATA: paths.roaming, LOCALAPPDATA: paths.local };
  const expectedProcess = processEnvironment(paths);
  if (!sameObject(manifest.launcherEnvironment, expectedLauncher) || !sameObject(manifest.processEnvironmentAfterPreflight, expectedProcess)) throw new Error("Acceptance process environment changed");
  return manifest;
}

export function acceptanceEnvironment(manifest, inherited = process.env) {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) if (forbiddenInherited.test(key) || secretInherited.test(key)) delete environment[key];
  // Do not change HOME, USERPROFILE, CODEX_HOME, or the parent's environment.
  return { ...environment, ...manifest.launcherEnvironment };
}

/** Executes only the verified binary's pre-Tauri validation command; no window/sidecar. */
export async function validateNativeAcceptanceCli(manifestPath) {
  const manifest = await validateNativeAcceptance(manifestPath);
  const { stdout } = await promisify(execFile)(manifest.nativeExecutable, manifest.validationArgv, { cwd: manifest.runtimeRoot, env: acceptanceEnvironment(manifest), windowsHide: true, timeout: 15_000, maxBuffer: 32_768 });
  const result = JSON.parse(stdout.trim());
  if (result.validated !== true || result.protocol !== debugBinaryProtocol || !sameObject(result.paths, manifest.paths)) throw new Error("Native acceptance validation response did not match the manifest");
  return { validated: true, nativeValidated: true, manifestPath: resolve(manifestPath), paths: manifest.paths };
}

/** Only this explicit entry point launches UI. Root agent performs the actual acceptance. */
export async function launchNativeAcceptance(manifestPath) {
  // The real binary checks registry/environment policy before any GUI is requested.
  await validateNativeAcceptanceCli(manifestPath);
  const manifest = await validateNativeAcceptance(manifestPath);
  const child = spawn(manifest.nativeExecutable, manifest.argv, { cwd: manifest.runtimeRoot, env: acceptanceEnvironment(manifest), detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((success, failure) => { child.once("spawn", success); child.once("error", failure); });
  child.unref();
  return { manifestPath: resolve(manifestPath), nativePid: child.pid, paths: manifest.paths };
}

export function parseAcceptanceCli(args) {
  let mode = "prepare", manifestPath;
  let modeSpecified = false, json = false;
  for (let index = 0; index < args.length; index++) {
    if (["--prepare-only", "--validate-only", "--validate-native", "--launch"].includes(args[index])) {
      if (modeSpecified) throw new Error("Choose exactly one acceptance mode");
      modeSpecified = true;
      mode = { "--prepare-only": "prepare", "--validate-only": "validate", "--validate-native": "native-validate", "--launch": "launch" }[args[index]];
    } else if (args[index] === "--manifest" && !manifestPath) {
      manifestPath = args[++index];
      if (!manifestPath || manifestPath.startsWith("--")) throw new Error("--manifest requires a path");
    } else if (args[index] === "--json" && !json) json = true;
    else throw new Error("Unknown or duplicate acceptance argument");
  }
  if ((mode === "prepare") === !!manifestPath) throw new Error("Validation/launch requires --manifest; preparation must create its own root");
  return { mode, manifestPath, json };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "win32") throw new Error("Native acceptance currently supports Windows only");
    const args = parseAcceptanceCli(process.argv.slice(2));
    const result = args.mode === "prepare" ? await prepareNativeAcceptance() : args.mode === "validate" ? { validated: true, manifestPath: resolve(args.manifestPath), paths: (await validateNativeAcceptance(args.manifestPath)).paths } : args.mode === "native-validate" ? await validateNativeAcceptanceCli(args.manifestPath) : await launchNativeAcceptance(args.manifestPath);
    console.log(args.json ? JSON.stringify(result) : `${args.mode === "launch" ? "已请求启动原生隔离验收" : args.mode === "validate" || args.mode === "native-validate" ? "隔离验收路径已验证（未启动）" : "隔离验收已准备（未启动）"}：${result.manifestPath}`);
  } catch (error) {
    console.error(`Native acceptance failed: ${error.message}`);
    process.exitCode = 1;
  }
}
