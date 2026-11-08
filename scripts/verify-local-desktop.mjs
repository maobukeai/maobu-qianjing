import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { prepareLocalDesktop } from "./run-local-desktop.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocol = "aliasmode-desktop-v1";

async function bounded(pending, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Execute the actual packaged modules, stopping before any React render/effect. */
async function probeDashboardModules() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    assert(input.length <= 24 * 1024 * 1024, "Dashboard module probe input is too large");
  }
  const assets = JSON.parse(input);
  assert(Array.isArray(assets) && assets.length > 0 && assets.length <= 16, "Invalid dashboard module list");
  let reachedRoot = false;
  let attachedRootListener = false;
  const context = vm.createContext({
    // Deliberately not a DOM node: the real React createRoot must reject this.
    // No window, native bridge, fetch, network, timers, or host module loader.
    document: { getElementById(id) {
      assert.equal(id, "root", "Unexpected DOM access during module initialization");
      reachedRoot = true;
      return { addEventListener(type) { assert.equal(type, "click"); attachedRootListener = true; } };
    } },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  }, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  assert.equal(typeof vm.SourceTextModule, "function", "Module probe requires --experimental-vm-modules");
  let stoppedAtRenderBoundary = false;
  for (const asset of assets) {
    reachedRoot = false;
    attachedRootListener = false;
    assert.equal(typeof asset.source, "string");
    const module = new vm.SourceTextModule(asset.source, {
      context, identifier: asset.url,
      importModuleDynamically() { throw new Error("Dynamic imports are not allowed during dashboard module initialization"); },
    });
    await module.link((specifier) => { throw new Error(`Dashboard bundle has an unresolved import: ${specifier}`); });
    try {
      await module.evaluate({ timeout: 3000 });
    } catch (error) {
      if (reachedRoot && attachedRootListener && error?.name === "Error" && error.message === "Target container is not a DOM element.") {
        stoppedAtRenderBoundary = true;
        continue;
      }
      throw error;
    }
  }
  assert(stoppedAtRenderBoundary, "Packaged dashboard did not reach the React createRoot boundary");
  console.log(JSON.stringify({ moduleInitialization: "ok", assets: assets.length }));
}

async function verifyDashboardModules(request, origin, html) {
  const sources = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/\b(src|type)\s*=\s*(["'])(.*?)\2/gi)].map((attribute) => [attribute[1].toLowerCase(), attribute[3]]));
    if (attributes.type?.toLowerCase() !== "module" || !attributes.src) continue;
    const url = new URL(attributes.src, origin);
    assert.equal(url.origin, origin, "Dashboard module must come from the owned local sidecar");
    assert(!url.username && !url.password, "Dashboard module URL must not contain credentials");
    const response = await request(url.pathname + url.search);
    assert.equal(response.status, 200, `Packaged dashboard module is missing: ${url.pathname}`);
    assert(/(?:java|ecma)script/i.test(response.headers.get("content-type") ?? ""), "Dashboard module has an invalid content type");
    const source = await response.text();
    assert(source.length > 0 && source.length <= 12 * 1024 * 1024, "Dashboard module size is invalid");
    sources.push({ url: url.href, source });
  }
  assert(sources.length > 0, "Packaged dashboard has no external module script");
  // An isolated child bounds both module evaluation and accidental async work.
  const child = spawn(process.execPath, ["--experimental-vm-modules", "--no-warnings", fileURLToPath(import.meta.url), "--probe-dashboard-modules"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16000); });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  try {
    child.stdin.end(JSON.stringify(sources));
    const result = await bounded(exited, 10000, "Packaged dashboard module initialization timed out");
    assert.equal(result.code, 0, `Packaged dashboard module initialization failed (${result.code ?? result.signal}):\n${errors}`);
    assert.equal(JSON.parse(output).moduleInitialization, "ok");
    return sources.length;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await bounded(exited, 3000, "Module probe cleanup timed out").catch(() => {});
  }
}

/** Every process is anchored to this verifier's newly created synthetic home. */
async function startSidecar(prepared, version, home, stateRoot = home, workspaceId = "default") {
  assert(workspaceId === "default" || /^ws_[a-f0-9]{32}$/.test(workspaceId), "Invalid synthetic workspace ID");
  assert.equal(stateRoot, workspaceId === "default" ? home : join(home, "workspaces", workspaceId));
  const nonce = randomBytes(32).toString("hex");
  const agentNonce = randomBytes(32).toString("hex");
  const child = spawn(join(prepared.runtimeRoot, "aliasmode-sidecar.exe"), [
    "start", "--port", "0", "--state-root", stateRoot, "--desktop-stdio", "--desktop-root", stateRoot,
    "--workspace-home", home, "--workspace-id", workspaceId,
  ], {
    cwd: prepared.runtimeRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ALIASMODE_PLAYWRIGHT_RUNTIME: join(prepared.runtimeRoot, "playwright"),
      ALIASMODE_DESKTOP_NONCE: nonce,
      ALIASMODE_AGENT_NONCE: agentNonce,
      ALIASMODE_DESKTOP_VERSION: version,
      ALIASMODE_BACKGROUND: "1",
      MAOBU_MANAGED_FIREFOX: prepared.bundledFirefox ? "0" : "1",
      // Retired settings must not turn this package into a remote client.
      ALIASMODE_CLOUD_URL: "https://retired.invalid",
      HUB_URL: "https://retired.invalid",
    },
  });
  let output = "", errors = "", buffer = "";
  let resolveReady;
  const ready = new Promise((resolveRecord) => { resolveReady = resolveRecord; });
  const exited = new Promise((resolveExit, reject) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", reject);
  });
  // Attach a handler immediately, including when spawn fails before readiness.
  exited.catch(() => {});
  child.stdin.on("error", () => {}); // The exit record supplies a bounded diagnostic.
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16000); });
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-32000);
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line);
        if (record.protocol === protocol && record.event === "ready" && record.nonce === nonce && record.pid === child.pid) resolveReady(record);
      } catch { /* Diagnostic lines are not protocol records. */ }
    }
  });
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      if (child.exitCode === null && child.signalCode === null) child.stdin.write(JSON.stringify({ protocol, command: "shutdown", nonce }) + "\n");
      const result = await bounded(exited, 15000, "Graceful sidecar shutdown timed out");
      assert.equal(result.code, 0, `Sidecar shutdown failed: ${errors}\n${output}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await bounded(exited, 5000, "Smoke process cleanup timed out").catch(() => {});
    }
  }
  try {
    const record = await bounded(Promise.race([
      ready,
      exited.then(({ code, signal }) => { throw new Error(`Sidecar exited before ready (${code ?? signal}): ${errors}\n${output}`); }),
    ]), 30000, "Packaged sidecar startup timed out");
    assert(Number.isInteger(record.port) && record.port > 0 && record.port <= 65535, "Invalid local port");
    const origin = `http://127.0.0.1:${record.port}`;
    let capability = "";
    const request = (path, options = {}) => {
      const headers = new Headers(options.headers);
      if (capability && !headers.has("authorization") && !headers.has("X-Maobu-Workspace-Capability")) headers.set("X-Maobu-Workspace-Capability", capability);
      return fetch(origin + path, { ...options, headers, signal: AbortSignal.timeout(10000), redirect: "error" });
    };
    const read = async (path, expected = 200, headers) => {
      const response = await request(path, { headers });
      assert.equal(response.status, expected, `${path}: ${response.status === expected ? "" : await response.clone().text()}`);
      return response.json();
    };
    const post = (path, body = {}) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const send = async (method, path, body = {}, expected = 200) => {
      const response = await request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, expected, `${path}: ${response.status === expected ? "" : await response.clone().text()}`);
      const result = await response.json();
      if (expected < 400) assert.notEqual(result.ok, false, path);
      return result;
    };
    const waitJob = async (id) => {
      assert.match(id, /^job_[a-f0-9]{32}$/);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const { job } = await read(`/ui/api/workspace/jobs/${id}`);
        if (["succeeded", "failed"].includes(job.status)) {
          assert.equal(job.status, "succeeded", JSON.stringify(job));
          return job;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error(`Packaged workspace job ${id} timed out`);
    };
    const health = await read("/ui/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.version, version);
    assert.equal(health.instance, nonce);
    assert.equal(health.root, stateRoot);
    assert.equal((await request("/ui/api/workspaces")).status, 401, "Workspace metadata must require authorization");
    assert.equal((await request("/ui/api/workspace/capability", { headers: { origin: "https://outside.invalid" } })).status, 403);
    capability = (await read("/ui/api/workspace/capability")).token;
    assert.match(capability, /^[a-f0-9]{64}$/);
    const catalog = await read("/ui/api/workspaces");
    assert.equal(catalog.currentId, workspaceId);
    assert.equal(catalog.activeId, workspaceId);
    // Native uses its independent bearer nonce; it never needs the browser token.
    assert.equal((await read("/ui/api/workspaces", 200, { authorization: `Bearer ${agentNonce}` })).currentId, workspaceId);
    assert.equal((await request("/ui/api/workspaces", { headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status, 401);
    const mode = await read("/ui/api/app-mode");
    assert.equal(mode.mode, "local");
    assert.equal(mode.localOnly, true);
    assert(!mode.cloudUrl, "Retired Cloud address leaked into app mode");
    assert.deepEqual((await read("/ui/api/runtime-downloads")).downloads, [], "Idle startup must not download engines");
    return { request, read, post, send, waitJob, stop, origin, workspaceId, root: stateRoot };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** Exercise compiled HTTP, real SQLite backups and physical workspace separation. */
async function verifyLocalDesktop() {
  const prepared = await prepareLocalDesktop();
  const base = await realpath(tmpdir());
  assert(!/[^\x00-\x7f]/.test(base), "Smoke test needs an ASCII temporary directory");
  const state = await mkdtemp(join(base, "maobu-local-smoke-"));
  const version = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).version;
  let service;
  try {
    service = await startSidecar(prepared, version, state);
    const { request, read, post, send, waitJob, origin } = service;
    const html = await request("/");
    assert.equal(html.status, 200, "Local dashboard is missing");
    const dashboardHtml = await html.text();
    assert(dashboardHtml.includes("<title>猫步·千境</title>"), "Packaged dashboard has an old product name");
    const initializedModules = await verifyDashboardModules(request, origin, dashboardHtml);
    const iconHref = dashboardHtml.match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/)?.[1];
    assert(iconHref, "Packaged dashboard favicon is missing");
    const iconResponse = await request(new URL(iconHref, origin).pathname);
    assert.equal(iconResponse.status, 200, "Packaged brand icon is missing");
    assert(iconResponse.headers.get("content-type")?.startsWith("image/png"), "Packaged brand icon is not PNG");
    const iconBytes = Buffer.from(await iconResponse.arrayBuffer());
    assert.equal(iconBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Packaged brand icon is invalid");
    const roster = await read("/ui/api/profiles");
    assert.deepEqual(roster.profiles, [], "Smoke test must use an empty synthetic profile store");
    const retired = await post("/ui/api/cloud-auth/signin", {});
    assert([404, 410].includes(retired.status), "Retired Cloud route is available");
    const switchMode = await post("/ui/api/app-mode", { mode: "cloud" });
    assert.equal(switchMode.status, 400, "Cloud mode can be re-enabled");
    const fingerprint = await post("/ui/api/profiles/missing/check-fingerprint", {});
    assert([404, 410].includes(fingerprint.status), "Hosted fingerprint endpoint is available");

    const profile = await send("POST", "/ui/api/profiles", { name: "Packaged synthetic environment", group: "Verifier", engine: "chromium", chromiumRuntime: "aliasmode" });
    assert.equal(typeof profile.id, "string");
    assert.equal((await read("/ui/api/profiles")).profiles.length, 1);
    await send("PATCH", "/ui/api/workspaces/default", { name: "Packaged verification", icon: "globe", color: "#628ac7" });
    const independent = (await send("POST", "/ui/api/workspaces", { name: "Packaged empty workspace", icon: "briefcase", color: "#638f77" }, 201)).workspace;
    assert.match(independent.id, /^ws_[a-f0-9]{32}$/);
    await send("PATCH", `/ui/api/workspaces/${independent.id}`, { name: "Packaged isolated workspace" });
    await send("POST", `/ui/api/workspaces/${independent.id}/archive`, { archived: true });
    await send("POST", `/ui/api/workspaces/${independent.id}/activate`, {}, 404);
    await send("POST", `/ui/api/workspaces/${independent.id}/archive`, { archived: false });
    const backupJob = await waitJob((await send("POST", "/ui/api/workspace/backups", {}, 202)).job.id);
    const records = (await read("/ui/api/workspace/backups")).backups;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, backupJob.result.backupId);
    assert.equal(records[0].profileCount, 1);
    assert.equal(records[0].path, undefined, "Backup API must not disclose arbitrary backend file paths");
    const download = await request(`/ui/api/workspace/backups/${records[0].id}/download`);
    assert.equal(download.status, 200);
    const archive = Buffer.from(await download.arrayBuffer());
    const sha256 = createHash("sha256").update(archive).digest("hex");
    assert.equal(archive.subarray(0, 3).toString("hex"), "1f8b08", "Workspace backup must contain genuine gzip data");
    assert.equal(download.headers.get("X-Backup-SHA256"), sha256);
    assert.equal(records[0].sha256, sha256);
    assert.equal(Number(download.headers.get("Content-Length")), archive.length);
    const restored = await waitJob((await send("POST", "/ui/api/workspace/restore", { backupId: records[0].id, name: "Packaged restored copy" }, 202)).job.id);
    assert.match(restored.result.workspaceId, /^ws_[a-f0-9]{32}$/);
    assert.notEqual(restored.result.workspaceId, independent.id);
    const catalog = await read("/ui/api/workspaces");
    assert.equal(catalog.workspaces.length, 3);
    assert.equal(catalog.currentId, "default");
    assert.equal(catalog.activeId, "default");
    assert(catalog.workspaces.some((workspace) => workspace.id === restored.result.workspaceId));
    assert.equal((await read("/ui/api/workspace/overview")).profileCount, 1);
    assert.deepEqual((await read("/ui/api/runtime-downloads")).downloads, [], "Creating and restoring metadata must not download an engine");
    assert.equal((await send("POST", `/ui/api/workspaces/${independent.id}/activate`)).restartRequired, true);
    await service.stop();
    service = undefined;

    // A second real compiled process selects the fixed root published by the
    // catalog. The empty roster proves this is physical isolation, not UI filtering.
    service = await startSidecar(prepared, version, state, join(state, "workspaces", independent.id), independent.id);
    assert.deepEqual((await service.read("/ui/api/profiles")).profiles, []);
    assert.equal((await service.read("/ui/api/workspace/overview")).profileCount, 0);
    assert.equal((await service.send("POST", "/ui/api/workspaces/default/activate")).restartRequired, true);
    await service.stop();
    service = undefined;

    // Reopening the original root must preserve its profile and backup history.
    service = await startSidecar(prepared, version, state);
    const preserved = (await service.read("/ui/api/profiles")).profiles;
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].id, profile.id);
    assert.equal(preserved[0].name, "Packaged synthetic environment");
    assert.equal((await service.read("/ui/api/workspace/backups")).backups[0].sha256, sha256);
    const registry = JSON.parse(await readFile(join(state, "desktop-workspaces.json"), "utf8"));
    assert.equal(registry.activeId, "default");
    assert.equal(registry.workspaces.length, 3);
    await service.stop();
    service = undefined;
    console.log(JSON.stringify({
      packagedStartup: "ok", dashboard: html.status, dashboardModuleInitialization: "ok", initializedModules, localOnly: true,
      retiredCloudStatus: retired.status, cloudSwitchStatus: switchMode.status,
      hostedFingerprintStatus: fingerprint.status, idleDownloads: 0,
      capabilityAuthorization: "ok", catalogCrud: "ok", backupDownloadSha256: "ok", restoreToNewWorkspace: "ok",
      physicalWorkspaceIsolation: "ok", originalProfilesPreserved: preserved.length, gracefulShutdowns: 3,
      runtimeRoot: prepared.runtimeRoot,
    }));
  } finally {
    try { await service?.stop(); }
    finally {
      // Delete only this newly-created synthetic directory, never application data.
      const actual = await realpath(state);
      const rel = relative(base, actual);
      assert(rel && !rel.startsWith("..") && !isAbsolute(rel) && dirname(actual) === base && basename(actual).startsWith("maobu-local-smoke-") && !(await lstat(state)).isSymbolicLink(), "Unsafe smoke cleanup path");
      await rm(state, { recursive: true, force: true });
    }
  }
}

const verification = process.argv.includes("--probe-dashboard-modules") ? probeDashboardModules : verifyLocalDesktop;
verification().catch((error) => { console.error(error); process.exitCode = 1; });
