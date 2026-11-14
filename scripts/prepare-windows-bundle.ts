import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TRUSTED_RUNTIME_ZIP_LIMITS, extractZipTo } from "../unzip.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { renameWithWindowsRetrySync } from "../windows-rename.ts";

export const NODE_WINDOWS_X64_VERSION = "22.23.2";
export const NODE_WINDOWS_X64_SHA256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
export const NODE_WINDOWS_X64_URL = `https://nodejs.org/dist/v${NODE_WINDOWS_X64_VERSION}/node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;
export const NODE_WINDOWS_X64_CACHE_NAME = `node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;

export const ALIASMODE_FIREFOX_VERSION = "156.0.1-beta.36";
export const ALIASMODE_FIREFOX_ARCHIVE_NAME = "aliasmode-156.0.1-beta.36-win.x86_64.zip";
export const ALIASMODE_FIREFOX_EXECUTABLE_NAME = "aliasmode.exe";

export interface PreparedFirefoxMetadata {
  executable: string;
  sha256: string;
  version: typeof ALIASMODE_FIREFOX_VERSION;
  archiveSha256: string;
}

/** CloakBrowser is not bundled: the app downloads it on first use. */
export interface PreparedBrowserMetadata {
  firefox: PreparedFirefoxMetadata | null;
}

export interface FirefoxArchive {
  bytes: Uint8Array;
  archiveSha256: string;
  executableSha256: string;
}

export interface PrepareWindowsBundleOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  compileSidecar?: (output: string) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
  downloadNode?: () => Promise<Uint8Array>;
  installNode?: (playwrightRoot: string) => Promise<void>;
  firefoxArchive?: FirefoxArchive;
  /** Optional offline bundle. Standard Windows builds install engines on demand. */
  bundleFirefox?: boolean;
}

async function sha256File(path: string): Promise<string> {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate the lexical path before following any of its project-owned components. */
function assertManagedPath(cwd: string, target: string, kind: "directory" | "file"): void {
  if (!isAbsolute(cwd) || !isAbsolute(target) || !isWithin(cwd, target)) throw new Error("bundle path escaped its project directory");
  const root = lstatSync(cwd);
  if (root.isSymbolicLink() || !root.isDirectory() || relative(cwd, realpathSync(cwd)) !== "") {
    throw new Error("bundle project directory must not use symbolic links or junctions");
  }
  const parts = relative(cwd, target).split(sep).filter(Boolean);
  let current = cwd;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error("bundle paths must not use symbolic links or junctions");
    const directory = index < parts.length - 1 || kind === "directory";
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`bundle path is not a regular ${directory ? "directory" : "file"}`);
    if (!isWithin(cwd, realpathSync(current))) throw new Error("bundle path escaped its project directory");
  }
}

function assertBundleWorkspace(cwd: string, defaultWorkspace: boolean): void {
  assertManagedPath(cwd, cwd, "directory");
  if (defaultWorkspace && relative(realpathSync(resolve(import.meta.dir, "..")), cwd) !== "") {
    throw new Error("run Windows bundle preparation from this source project root");
  }
  const manifest = join(cwd, "package.json"), configuration = join(cwd, "src-tauri", "tauri.conf.json");
  assertManagedPath(cwd, manifest, "file");
  assertManagedPath(cwd, configuration, "file");
  try {
    if (JSON.parse(readFileSync(manifest, "utf8")).name !== "maobu-browser"
      || JSON.parse(readFileSync(configuration, "utf8")).identifier !== "com.maobu.local") throw new Error("invalid identity");
  } catch { throw new Error("bundle preparation requires the Maobu project manifests"); }
}

/** Refuse a linked descendant as well as a linked deletion root before removing anything. */
function assertRemovableDirectory(cwd: string, target: string): void {
  assertManagedPath(cwd, target, "directory");
  if (!lstatSync(target, { throwIfNoEntry: false })) return;
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("bundle cleanup refuses symbolic links or junctions");
      if (info.isDirectory()) pending.push(path);
    }
  }
}

async function downloadOfficialNode(): Promise<Uint8Array> {
  const response = await fetch(NODE_WINDOWS_X64_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("official Node runtime download failed");
  return new Uint8Array(await response.arrayBuffer());
}

/** Production always uses the pinned digest; tests may supply a small archive and its digest. */
export async function loadVerifiedNodeArchive(cwd: string, options: {
  download?: () => Promise<Uint8Array>; expectedSha256?: string;
  rename?: (from: string, to: string) => void;
} = {}): Promise<Uint8Array> {
  cwd = resolve(cwd);
  assertBundleWorkspace(cwd, false);
  const expected = expectedSha256(options.expectedSha256 ?? NODE_WINDOWS_X64_SHA256, "official Node runtime");
  const cache = join(cwd, "node_modules", ".cache", "maobu-desktop", NODE_WINDOWS_X64_CACHE_NAME);
  assertManagedPath(cwd, cache, "file");
  if (lstatSync(cache, { throwIfNoEntry: false })) {
    const bytes = readFileSync(cache);
    if (createHash("sha256").update(bytes).digest("hex") === expected) return bytes;
  }
  const bytes = await (options.download ?? downloadOfficialNode)();
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("official Node runtime SHA-256 mismatch");
  // Recheck after the network await. A failed download never changes the previous cache.
  assertManagedPath(cwd, cache, "file");
  mkdirSync(dirname(cache), { recursive: true });
  assertManagedPath(cwd, cache, "file");
  const temporary = join(dirname(cache), `${NODE_WINDOWS_X64_CACHE_NAME}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    assertManagedPath(cwd, temporary, "file");
    assertManagedPath(cwd, cache, "file");
    (options.rename ?? renameWithWindowsRetrySync)(temporary, cache);
  } catch (error) {
    // Keep the original failure even if cleanup is denied. Never remove the previous cache.
    try {
      assertManagedPath(cwd, temporary, "file");
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
  return bytes;
}

function expectedSha256(value: string | undefined, label: string): string {
  const hash = value?.toLowerCase();
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} SHA-256 is missing or invalid`);
  }
  return hash;
}

function configuredFirefoxArchive(): FirefoxArchive {
  const archivePath = process.env.ALIASMODE_FIREFOX_ARCHIVE;
  if (!archivePath) {
    throw new Error("AliasMode Firefox archive is required; set ALIASMODE_FIREFOX_ARCHIVE to the verified CI artifact");
  }
  if (basename(archivePath) !== ALIASMODE_FIREFOX_ARCHIVE_NAME) {
    throw new Error("AliasMode Firefox archive has an unexpected filename");
  }
  const archiveReal = realpathSync(archivePath);
  if (!statSync(archiveReal).isFile()) throw new Error("AliasMode Firefox archive is not a regular file");
  return {
    bytes: readFileSync(archiveReal),
    archiveSha256: expectedSha256(process.env.ALIASMODE_FIREFOX_ARCHIVE_SHA256, "AliasMode Firefox archive"),
    executableSha256: expectedSha256(process.env.ALIASMODE_FIREFOX_EXECUTABLE_SHA256, "AliasMode Firefox executable"),
  };
}

function findFirefoxExecutable(root: string): string {
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === ALIASMODE_FIREFOX_EXECUTABLE_NAME) matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1) {
    throw new Error("AliasMode Firefox archive must contain exactly one aliasmode.exe executable");
  }
  return matches[0]!;
}

async function installFirefoxRuntime(
  archive: FirefoxArchive,
  staging: string,
  resourceRoot: string,
  hashFile: (path: string) => Promise<string>,
): Promise<PreparedFirefoxMetadata> {
  const archiveSha256 = createHash("sha256").update(archive.bytes).digest("hex");
  const expectedArchiveSha256 = expectedSha256(archive.archiveSha256, "AliasMode Firefox archive");
  const expectedExecutableSha256 = expectedSha256(archive.executableSha256, "AliasMode Firefox executable");
  if (archiveSha256 !== expectedArchiveSha256) {
    throw new Error("AliasMode Firefox archive SHA-256 does not match the approved CI artifact");
  }

  const extractedRoot = join(staging, "firefox");
  await extractZipTo(archive.bytes, extractedRoot, TRUSTED_RUNTIME_ZIP_LIMITS);
  const extractedExecutable = findFirefoxExecutable(extractedRoot);
  const extractedReal = realpathSync(extractedExecutable);
  const extractedRootReal = realpathSync(extractedRoot);
  if (!statSync(extractedReal).isFile() || !isWithin(extractedRootReal, extractedReal)) {
    throw new Error("AliasMode Firefox archive executable escaped its engine directory");
  }
  cpSync(extractedRootReal, resourceRoot, { recursive: true, errorOnExist: false });
  const executable = relative(extractedRootReal, extractedReal).replaceAll("\\", "/");
  const copiedExecutable = join(resourceRoot, executable);
  const copiedSha256 = (await hashFile(copiedExecutable)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(copiedSha256) || copiedSha256 !== expectedExecutableSha256) {
    throw new Error("packaged AliasMode Firefox executable does not match the approved SHA-256");
  }
  return {
    executable,
    sha256: copiedSha256,
    version: ALIASMODE_FIREFOX_VERSION,
    archiveSha256,
  };
}

export const WINDOWS_SIDECAR_TARGET = "bun-windows-x64-baseline";

/** Filter names before reading values so signing secrets are never copied or inspected. */
export function sidecarCompileEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const name of Object.keys(environment)) {
    if (["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"].includes(name.toUpperCase())) continue;
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

type SidecarSpawn = (command: string[], options: { cwd: string; env: Record<string, string>; stdout: "inherit"; stderr: "inherit" }) => { exited: Promise<number> };
export async function compileSidecar(cwd: string, output: string, target = WINDOWS_SIDECAR_TARGET, spawn: SidecarSpawn = Bun.spawn): Promise<void> {
  const child = spawn([
    process.execPath,
    "build",
    "--compile",
    `--target=${target}`,
    "--define=ALIASMODE_COMPILED=true",
    "--external=playwright-core",
    "--external=chromium-bidi",
    "--external=electron",
    // One program for the sidecar and the MCP helper; Cargo builds the aliasmode-mcp launcher.
    "sidecar-entry.ts",
    "--outfile",
    output,
  ], { cwd, env: sidecarCompileEnvironment(), stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`sidecar compilation exited with code ${code}`);
}

const AGENT_PACKAGE_VERSIONS: Record<string, string> = {
  "@modelcontextprotocol/sdk": "1.30.0",
  "@playwright/mcp": "0.0.56",
  "playwright": "1.58.0-alpha-2026-01-16",
  "playwright-core": "1.58.2",
};

function packageDirectory(root: string, name: string): string {
  return join(root, "node_modules", ...name.split("/"));
}

function copyRuntimePackage(
  cwd: string,
  destinationRoot: string,
  name: string,
  copied = new Set<string>(),
): void {
  if (copied.has(name)) return;
  const source = packageDirectory(cwd, name);
  const manifestPath = join(source, "package.json");
  if (!statSync(source).isDirectory() || !statSync(manifestPath).isFile()) {
    throw new Error(`desktop dependency is missing: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const expected = AGENT_PACKAGE_VERSIONS[name];
  if (expected && manifest.version !== expected) {
    throw new Error(`desktop dependency version mismatch: ${name}`);
  }
  const destination = packageDirectory(destinationRoot, name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  copied.add(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (statSync(join(source, "node_modules", ...dependency.split("/")), { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    copyRuntimePackage(cwd, destinationRoot, dependency, copied);
  }
}

/** Copies the worker scripts, agent files and their Node packages; every desktop bundle needs them. */
export function stageAgentRuntime(cwd: string, playwrightRoot: string): void {
  mkdirSync(playwrightRoot, { recursive: true });
  writeFileSync(join(playwrightRoot, "package.json"), `${JSON.stringify({ name: "maobu-browser-runtime", version: ALIASMODE_VERSION, type: "module", private: true }, null, 2)}\n`);
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "worker.mjs"));
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "playwright-worker.mjs"));
  cpSync(join(cwd, "firefox-worker.mjs"), join(playwrightRoot, "firefox-worker.mjs"));

  const agentRoot = join(playwrightRoot, "agent");
  mkdirSync(agentRoot, { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "mcp-scope.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) {
    cpSync(join(cwd, "agent", file), join(agentRoot, file));
  }
  const copied = new Set<string>();
  for (const dependency of [
    "playwright-core",
    "ws",
    "@modelcontextprotocol/sdk",
    "@playwright/mcp",
    "playwright",
  ]) {
    copyRuntimePackage(cwd, playwrightRoot, dependency, copied);
  }
}

export async function prepareWindowsBundle(
  options: PrepareWindowsBundleOptions = {},
): Promise<PreparedBrowserMetadata> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if ((options.platform ?? process.platform) !== "win32" || (options.arch ?? process.arch) !== "x64") {
    throw new Error("desktop bundle preparation requires Windows x64");
  }
  assertBundleWorkspace(cwd, options.cwd === undefined);

  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(resources, "firefox");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-x86_64-pc-windows-msvc.exe");

  const outputDirectories = [staging, generated, binaries, resources, firefoxRoot, playwrightRoot];
  const outputFiles = [sidecar, join(generated, "browser.json"), join(generated, "VERSION.txt")];
  const assertOutputs = () => {
    for (const directory of outputDirectories) assertManagedPath(cwd, directory, "directory");
    for (const file of outputFiles) assertManagedPath(cwd, file, "file");
  };
  // Preflight all destructive targets before deleting even the first directory.
  assertOutputs();
  for (const directory of [staging, firefoxRoot, playwrightRoot]) assertRemovableDirectory(cwd, directory);
  if (!options.installNode) assertManagedPath(cwd, join(cwd, "node_modules", ".cache", "maobu-desktop", NODE_WINDOWS_X64_CACHE_NAME), "file");
  for (const directory of [staging, firefoxRoot, playwrightRoot]) {
    assertRemovableDirectory(cwd, directory);
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });

  await (options.compileSidecar ?? ((output) => compileSidecar(cwd, output)))(sidecar);
  assertOutputs();
  if (!statSync(sidecar).isFile()) throw new Error("sidecar compiler did not create the expected Windows executable");

  mkdirSync(firefoxRoot, { recursive: true });
  const firefox = options.firefoxArchive || (options.bundleFirefox ?? process.env.MAOBU_BUNDLE_FIREFOX === "1")
    ? await installFirefoxRuntime(
        options.firefoxArchive ?? configuredFirefoxArchive(),
        staging,
        firefoxRoot,
        options.hashFile ?? sha256File,
      )
    : null;
  if (!firefox) writeFileSync(join(firefoxRoot, "ON-DEMAND.txt"), "Firefox is downloaded and verified when a Firefox profile is opened.\n");

  if (options.installNode) {
    await options.installNode(playwrightRoot);
  } else {
    const nodeStaging = join(staging, "node");
    const nodeBytes = await loadVerifiedNodeArchive(cwd, { download: options.downloadNode });
    assertOutputs();
    await extractZipTo(nodeBytes, nodeStaging, TRUSTED_RUNTIME_ZIP_LIMITS);
    const extractedNode = join(nodeStaging, `node-v${NODE_WINDOWS_X64_VERSION}-win-x64`, "node.exe");
    if (!statSync(extractedNode).isFile()) throw new Error("official Node runtime archive is incomplete");
    mkdirSync(join(playwrightRoot, "node"), { recursive: true });
    cpSync(extractedNode, join(playwrightRoot, "node", "node.exe"));
  }
  assertOutputs();
  assertManagedPath(cwd, join(playwrightRoot, "node", "node.exe"), "file");
  if (!statSync(join(playwrightRoot, "node", "node.exe")).isFile()) throw new Error("official Node runtime is incomplete");
  stageAgentRuntime(cwd, playwrightRoot);

  const metadata: PreparedBrowserMetadata = { firefox };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  try {
    const metadata = await prepareWindowsBundle();
    console.log(metadata.firefox
      ? `prepared Maobu Windows bundle with verified offline Firefox ${metadata.firefox.sha256}`
      : "prepared Maobu Windows bundle; browser engines install on demand");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
