import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Prepare an ASCII-path copy without reading or migrating any user profile. */
export async function prepareLocalDesktop() {
  const buildRoot = join(projectRoot, "src-tauri", "target", "debug");
  const runtimeBase = resolve(process.env.MAOBU_RUNTIME_DIR || tmpdir());
  if (/[^\x00-\x7f]/.test(runtimeBase)) throw new Error("请将 MAOBU_RUNTIME_DIR 设置为可写的英文路径，再启动桌面版。");
  await mkdir(runtimeBase, { recursive: true });
  const canonicalBase = await realpath(runtimeBase);
  if (/[^\x00-\x7f]/.test(canonicalBase)) throw new Error("运行目录实际位置包含中文，请将 MAOBU_RUNTIME_DIR 设置为英文路径。");
  const metadataFile = join(projectRoot, "src-tauri", "generated", "browser.json");
  const metadataBytes = await readFile(metadataFile);
  const browserMetadata = JSON.parse(metadataBytes.toString("utf8"));
  if (!browserMetadata || !Object.hasOwn(browserMetadata, "firefox") || (browserMetadata.firefox !== null && typeof browserMetadata.firefox !== "object")) throw new Error("浏览器资源元数据无效");
  const entries = [
    "aliasmode.exe", "aliasmode-sidecar.exe", "aliasmode-mcp.exe", "playwright/node/node.exe",
    "playwright/package.json", "playwright/worker.mjs", "playwright/playwright-worker.mjs", "playwright/firefox-worker.mjs",
    ...["mcp-host.mjs", "playwright-proxy.mjs", "playwright-runner.mjs", "runtime-client.mjs", "script-runner.mjs", "script-runner.py"].map((file) => `playwright/agent/${file}`),
  ];
  if (browserMetadata.firefox) {
    const executable = browserMetadata.firefox.executable;
    if (typeof executable !== "string" || isAbsolute(executable) || executable.split(/[\\/]/).some((part) => part === "..")) throw new Error("浏览器资源路径无效");
    entries.push(`firefox/${executable}`);
  }
  const hashes = {};
  for (const entry of entries) {
    const source = join(buildRoot, entry);
    if (!(await stat(source)).isFile()) throw new Error(`运行资源缺失：${entry}`);
    hashes[entry] = digest(await readFile(source));
  }
  const identity = digest(Buffer.from(JSON.stringify({ hashes, metadata: digest(metadataBytes) }))).slice(0, 16);
  const runtimeRoot = join(canonicalBase, `MaobuBrowser-local-${identity}`);
  const ready = join(runtimeRoot, "local-build-ready.json");
  const exists = await lstat(runtimeRoot).then(() => true, () => false);
  if (!exists) {
    const staging = `${runtimeRoot}-${process.pid}.staging`;
    await mkdir(staging);
    for (const entry of ["aliasmode.exe", "aliasmode-sidecar.exe", "aliasmode-mcp.exe", "playwright", ...(browserMetadata.firefox ? ["firefox"] : [])]) {
      await cp(join(buildRoot, entry), join(staging, entry), { recursive: true });
    }
    await cp(join(projectRoot, "LICENSE"), join(staging, "LICENSE"));
    await cp(join(projectRoot, "NOTICE"), join(staging, "NOTICE"));
    await writeFile(join(staging, "browser-bundle.json"), metadataBytes);
    await writeFile(join(staging, "local-build-ready.json"), JSON.stringify({ localOnly: true, hashes, source: buildRoot }));
    await rename(staging, runtimeRoot);
  }
  const actualRoot = await realpath(runtimeRoot);
  if (!actualRoot.startsWith(canonicalBase + sep) || (await lstat(runtimeRoot)).isSymbolicLink()) throw new Error("本地运行缓存路径已改变，请重新准备资源");
  const saved = JSON.parse(await readFile(ready, "utf8"));
  if (saved.localOnly !== true) throw new Error("缓存不是本地专用版本");
  // A ready marker alone is not trusted: reject changed executables and workers.
  for (const [entry, expected] of Object.entries(hashes)) {
    if (digest(await readFile(join(runtimeRoot, entry))) !== expected) throw new Error(`本地缓存已改变：${entry}。请移除该生成缓存后重试。`);
  }
  if (digest(await readFile(join(runtimeRoot, "browser-bundle.json"))) !== digest(metadataBytes)) throw new Error("缓存的内核元数据已改变");
  return { runtimeRoot, bundledFirefox: !!browserMetadata.firefox };
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
