/** Stages the Linux x64 bundle inputs: sidecar, Maobu (猫步·千境) Firefox runtime and the agent runtime. */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FIREFOX_RUNTIME_VERSION, firefoxBuildForHost, installFirefox } from "../src/firefox-install.ts";
import { installSourceNode } from "../src/source-runtime.ts";
import { ALIASMODE_VERSION } from "../src/version.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

const BUN_TARGET = "bun-linux-x64-baseline";
const RUST_TARGET = "x86_64-unknown-linux-gnu";

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertManagedPath(cwd: string, target: string, kind: "directory" | "file"): void {
  if (!isAbsolute(cwd) || !isAbsolute(target) || !isWithin(cwd, target)) {
    throw new Error("bundle path escaped its project directory");
  }
  const root = lstatSync(cwd);
  if (root.isSymbolicLink() || !root.isDirectory() || relative(cwd, realpathSync(cwd)) !== "") {
    throw new Error("bundle project directory must not use symbolic links");
  }
  const parts = relative(cwd, target).split(sep).filter(Boolean);
  let current = cwd;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error("bundle paths must not use symbolic links");
    const directory = index < parts.length - 1 || kind === "directory";
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`bundle path is not a regular ${directory ? "directory" : "file"}`);
    }
    if (!isWithin(cwd, realpathSync(current))) throw new Error("bundle path escaped its project directory");
  }
}

function assertBundleWorkspace(cwd: string, defaultWorkspace: boolean): void {
  assertManagedPath(cwd, cwd, "directory");
  if (defaultWorkspace && relative(realpathSync(resolve(import.meta.dir, "..")), cwd) !== "") {
    throw new Error("run Linux bundle preparation from this source project root");
  }
  const manifest = join(cwd, "package.json");
  const configuration = join(cwd, "src-tauri", "tauri.conf.json");
  assertManagedPath(cwd, manifest, "file");
  assertManagedPath(cwd, configuration, "file");
  try {
    if (
      JSON.parse(readFileSync(manifest, "utf8")).name !== "maobu-browser"
      || JSON.parse(readFileSync(configuration, "utf8")).identifier !== "com.maobu.local"
    ) {
      throw new Error("invalid identity");
    }
  } catch {
    throw new Error("bundle preparation requires the Maobu project manifests");
  }
}

function assertRemovableDirectory(cwd: string, target: string): void {
  assertManagedPath(cwd, target, "directory");
  if (!lstatSync(target, { throwIfNoEntry: false })) return;
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("bundle cleanup refuses symbolic links");
      if (info.isDirectory()) pending.push(path);
    }
  }
}

export async function prepareLinuxBundle(cwd?: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux bundle preparation requires Linux x64");
  }
  const defaultWorkspace = cwd === undefined;
  const root = resolve(cwd ?? process.cwd());
  assertBundleWorkspace(root, defaultWorkspace);

  const tauri = join(root, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(resources, "firefox");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, `aliasmode-sidecar-${RUST_TARGET}`);
  const nodeBinary = join(playwrightRoot, "node", "node");
  const outputDirectories = [staging, generated, binaries, resources, firefoxRoot, playwrightRoot];
  const outputFiles = [sidecar, join(generated, "browser.json"), join(generated, "VERSION.txt")];
  const assertOutputs = () => {
    for (const directory of outputDirectories) assertManagedPath(root, directory, "directory");
    for (const file of outputFiles) assertManagedPath(root, file, "file");
  };

  assertOutputs();
  for (const path of [staging, firefoxRoot, playwrightRoot]) {
    assertRemovableDirectory(root, path);
    rmSync(path, { recursive: true, force: true });
  }
  for (const path of [staging, generated, binaries, resources, join(playwrightRoot, "node")]) {
    mkdirSync(path, { recursive: true });
  }

  await compileSidecar(root, sidecar, BUN_TARGET);
  assertOutputs();
  if (!statSync(sidecar).isFile()) {
    throw new Error("sidecar compiler did not create the expected Linux executable");
  }

  const build = firefoxBuildForHost();
  const firefox = await installFirefox({ cwd: staging, writeEnv: false });
  renameSync(resolve(firefox.path, ...build.executablePath.split("/").map(() => "..")), firefoxRoot);
  const firefoxExecutable = join(firefoxRoot, build.executablePath);
  assertManagedPath(root, firefoxExecutable, "file");
  if (!statSync(firefoxExecutable).isFile()) {
    throw new Error("packaged Maobu Firefox executable is missing");
  }

  cpSync(await installSourceNode(staging), nodeBinary);
  assertManagedPath(root, nodeBinary, "file");
  if (!statSync(nodeBinary).isFile()) {
    throw new Error("official Node runtime is incomplete");
  }
  stageAgentRuntime(root, playwrightRoot);
  assertOutputs();

  const metadata = {
    firefox: {
      executable: build.executablePath,
      sha256: firefox.sha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: build.archiveSha256,
    },
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
}

if (import.meta.main) {
  try {
    await prepareLinuxBundle();
    console.log("prepared Maobu Linux bundle");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
