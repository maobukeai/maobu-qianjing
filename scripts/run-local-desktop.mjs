import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executables = ["aliasmode.exe", "aliasmode-sidecar.exe", "aliasmode-mcp.exe"];
const notices = ["LICENSE", "NOTICE"];
const browserManifestName = "browser-bundle.json";
const readyName = "local-build-ready.json";
const workerFiles = [
  "package.json", "node/node.exe", "worker.mjs", "playwright-worker.mjs", "firefox-worker.mjs",
  "agent/mcp-host.mjs", "agent/mcp-scope.mjs", "agent/playwright-proxy.mjs", "agent/playwright-runner.mjs",
  "agent/runtime-client.mjs", "agent/script-recorder.mjs", "agent/script-runner.mjs", "agent/script-runner.py",
  "node_modules/playwright-core/package.json", "node_modules/@playwright/mcp/package.json",
  "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/playwright/package.json",
].map((file) => `playwright/${file}`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function entryInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function requireFile(path, entry) {
  if (!(await entryInfo(path))?.isFile()) throw new Error(`运行资源缺失或不是普通文件：${entry}`);
}

async function addResourceFiles(files, root, relativeDirectory) {
  const directory = join(root, relativeDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) await addResourceFiles(files, root, relative);
    else if (entry.isFile()) files.set(relative, join(directory, entry.name));
    else throw new Error(`运行资源不是普通文件或目录：${relative}`);
  }
}

async function runtimeFiles(root, directories) {
  const files = new Map();
  for (const executable of executables) {
    const path = join(root, executable);
    await requireFile(path, executable);
    files.set(executable, path);
  }
  for (const directory of directories) {
    if (!(await entryInfo(join(root, directory)))?.isDirectory()) throw new Error(`运行资源目录缺失或不是普通目录：${directory}`);
    await addResourceFiles(files, root, directory);
  }
  return files;
}

async function hashFiles(files) {
  const names = [...files.keys()].sort();
  const hashes = new Array(names.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(16, names.length) }, async () => {
    while (next < names.length) {
      const index = next++;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(files.get(names[index]))) hash.update(chunk);
      hashes[index] = [names[index], hash.digest("hex")];
    }
  }));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  return new Map(hashes);
}

function firefoxExecutable(metadataBytes) {
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (metadata?.firefox === null) return null;
  const executable = metadata?.firefox?.executable;
  if (typeof executable !== "string" || win32.isAbsolute(executable) || /[:\x00]/.test(executable)) throw new Error("浏览器资源路径无效");
  const parts = executable.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("浏览器资源路径无效");
  return `firefox/${parts.join("/")}`;
}

async function verifyCache(root, directories, expected, bundleSha256) {
  if (!(await entryInfo(root))?.isDirectory() || await realpath(root) !== root) throw new Error("本地运行缓存路径已改变，请重新准备资源");
  const topEntries = new Set([...executables, ...directories, ...notices, browserManifestName, readyName]);
  for (const name of await readdir(root)) {
    if (!topEntries.has(name)) throw new Error(`本地缓存包含额外文件：${name}`);
  }
  const readyPath = join(root, readyName);
  await requireFile(readyPath, readyName);
  const ready = JSON.parse(await readFile(readyPath, "utf8"));
  if (ready?.localOnly !== true || ready.bundleSha256 !== bundleSha256
    || executables.some((name) => ready.hashes?.[name] !== expected.get(name))) {
    throw new Error("本地运行缓存标记与构建不匹配");
  }
  const files = await runtimeFiles(root, directories);
  for (const entry of [...notices, browserManifestName]) {
    const path = join(root, entry);
    await requireFile(path, entry);
    files.set(entry, path);
  }
  for (const entry of files.keys()) {
    if (!expected.has(entry)) throw new Error(`本地缓存包含额外文件：${entry}`);
  }
  const actual = await hashFiles(files);
  for (const [entry, hash] of expected) {
    if (actual.get(entry) !== hash) throw new Error(`本地缓存已改变：${entry}。请移除该生成缓存后重试。`);
  }
}

/** Prepare an ASCII-path copy without reading or migrating any user profile. */
export async function prepareLocalDesktop({ projectDirectory = projectRoot, runtimeDirectory = process.env.MAOBU_RUNTIME_DIR || tmpdir() } = {}) {
  const buildRoot = resolve(projectDirectory, "src-tauri", "target", "debug");
  const runtimeBase = resolve(runtimeDirectory);
  if (/[^\x00-\x7f]/.test(runtimeBase)) throw new Error("请将 MAOBU_RUNTIME_DIR 设置为可写的英文路径，再启动桌面版。");
  await mkdir(runtimeBase, { recursive: true });
  const canonicalBase = await realpath(runtimeBase);
  if (/[^\x00-\x7f]/.test(canonicalBase)) throw new Error("运行目录实际位置包含中文，请将 MAOBU_RUNTIME_DIR 设置为英文路径。");

  const metadataFile = resolve(projectDirectory, "src-tauri", "generated", "browser.json");
  await requireFile(metadataFile, browserManifestName);
  const metadataBytes = await readFile(metadataFile);
  const firefox = firefoxExecutable(metadataBytes);
  const directories = firefox ? ["playwright", "firefox"] : ["playwright"];
  const files = await runtimeFiles(buildRoot, directories);
  for (const entry of firefox ? [...workerFiles, firefox] : workerFiles) {
    if (!files.has(entry)) throw new Error(`运行资源缺失：${entry}`);
  }
  for (const entry of notices) {
    const path = resolve(projectDirectory, entry);
    await requireFile(path, entry);
    files.set(entry, path);
  }
  const expected = await hashFiles(files);
  expected.set(browserManifestName, digest(metadataBytes));
  const bundleSha256 = digest(JSON.stringify([...expected]));
  const runtimeRoot = join(canonicalBase, `MaobuBrowser-local-${bundleSha256.slice(0, 16)}`);
  const prepared = { runtimeRoot, bundledFirefox: !!firefox };
  if (await entryInfo(runtimeRoot)) {
    await verifyCache(runtimeRoot, directories, expected, bundleSha256);
    return prepared;
  }

  const staging = await mkdtemp(join(canonicalBase, `.MaobuBrowser-local-${bundleSha256.slice(0, 16)}-staging-`));
  let published = false;
  try {
    for (const entry of [...executables, ...directories]) {
      await cp(join(buildRoot, entry), join(staging, entry), { recursive: true });
    }
    for (const entry of notices) await cp(files.get(entry), join(staging, entry));
    await writeFile(join(staging, browserManifestName), metadataBytes);
    const hashes = Object.fromEntries(executables.map((name) => [name, expected.get(name)]));
    await writeFile(join(staging, readyName), JSON.stringify({ localOnly: true, bundleSha256, hashes, source: buildRoot }));
    // A concurrent rebuild must not publish a different set of files under the old hash.
    await verifyCache(staging, directories, expected, bundleSha256);
    try {
      await rename(staging, runtimeRoot);
      published = true;
    } catch (error) {
      if (!(await entryInfo(runtimeRoot))) throw error;
      // One of two cold launches may have published the same runtime first.
      await verifyCache(runtimeRoot, directories, expected, bundleSha256);
    }
    return prepared;
  } finally {
    if (!published && dirname(staging) === canonicalBase && (await entryInfo(staging))?.isDirectory() && await realpath(staging) === staging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function launchLocalDesktop() {
  const prepared = await prepareLocalDesktop();
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(ALIASMODE_(CLOUD|SUPABASE|ACCESS_TOKEN|REFRESH_TOKEN|DEVICE_CREDENTIAL|QUEUE_ENCRYPTION_KEY)|HUB_)/i.test(key)) delete environment[key];
  }
  const child = spawn(join(prepared.runtimeRoot, "aliasmode.exe"), [], { cwd: prepared.runtimeRoot, detached: true, stdio: "ignore", windowsHide: true, env: environment });
  await new Promise((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
  child.unref();
  return prepared;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = process.argv.includes("--prepare-only") ? await prepareLocalDesktop() : await launchLocalDesktop();
    console.log(process.argv.includes("--json") ? JSON.stringify(prepared) : `猫步·千境本地版已${process.argv.includes("--prepare-only") ? "准备" : "启动"}：${prepared.runtimeRoot}`);
  } catch (error) {
    console.error(`本地桌面启动失败：${error.message}`);
    console.error("请先完成桌面资源准备和 cargo build，再重试。");
    process.exitCode = 1;
  }
}
