import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { prepareLocalDesktop } from "./run-local-desktop.mjs";
import { socksFixture, verifyPackagedMcp } from "./verify-packaged-mcp.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocol = "aliasmode-desktop-v1";
const snapshotPassword = "synthetic-fixture-password";

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
  const dashboardSession = randomBytes(32).toString("hex");
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
      MAOBU_DESKTOP_SESSION: dashboardSession,
      MAOBU_DESKTOP_AUTOMATION_TOKEN: "",
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
      headers.set("X-Maobu-Desktop-Session", dashboardSession);
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
    for (const path of ["/ui/api/health", "/ui/api/profiles", "/ui/api/workspace/capability", "/card?id=synthetic"]) {
      assert.equal((await fetch(origin + path, { signal: AbortSignal.timeout(5000) })).status, 401);
    }
    assert.equal((await fetch(`${origin}/ui/api/profiles`, { headers: { authorization: `Bearer ${agentNonce}` }, signal: AbortSignal.timeout(5000) })).status, 401);
    assert.equal((await fetch(`${origin}/ui/api/health`, { headers: { authorization: `Bearer ${agentNonce}` }, signal: AbortSignal.timeout(5000) })).status, 200);
    assert.equal((await request("/api/v1/status")).status, 404, "The dashboard must not expose the desktop automation API");
    assert.equal((await request("/ui/api/workspaces")).status, 401, "Workspace metadata must require authorization");
    assert.equal((await request("/ui/api/workspace/capability", { headers: { origin: "https://outside.invalid" } })).status, 403);
    capability = (await read("/ui/api/workspace/capability")).token;
    assert.match(capability, /^[a-f0-9]{64}$/);
    const catalog = await read("/ui/api/workspaces");
    assert.equal(catalog.currentId, workspaceId);
    assert.equal(catalog.activeId, workspaceId);
    // Native backup export uses its independent workspace bearer alongside the dashboard session.
    assert.equal((await read("/ui/api/workspaces", 200, { authorization: `Bearer ${agentNonce}` })).currentId, workspaceId);
    assert.equal((await request("/ui/api/workspaces", { headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status, 401);
    const mode = await read("/ui/api/app-mode");
    assert.equal(mode.mode, "local");
    assert.equal(mode.localOnly, true);
    assert(!mode.cloudUrl, "Retired Cloud address leaked into app mode");
    assert.deepEqual((await read("/ui/api/runtime-downloads")).downloads, [], "Idle startup must not download engines");
    const service = { request, read, post, send, waitJob, stop, origin, workspaceId, root: stateRoot };
    Object.defineProperty(service, "agentProof", { value: Object.freeze({ generation: nonce, nonce: agentNonce, port: record.port, sidecarPid: child.pid }) });
    return service;
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** A loopback-only protocol fixture, never a real model or an external API. */
async function verifyPackagedAssistant(settingsRequest, profile) {
  const chats = [];
  const apiChats = [];
  const apiKey = "synthetic-packaged-model-key";
  const apiModel = "packaged-fixture-api";
  let started;
  const pendingStarted = new Promise(resolveStarted => { started = resolveStarted; });
  const model = "packaged-fixture:latest";
  const local = createServer(async (request, response) => {
    try {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/tags" && request.method === "GET") {
        response.end(JSON.stringify({ models: [{ name: model, size: 1024 }, { name: "fixture:cloud", remote_model: "fixture", remote_host: "https://never-contacted.invalid" }] }));
        return;
      }
      if (request.url === "/v1/models" && request.method === "GET") {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        response.end(JSON.stringify({ data: [{ id: apiModel }] }));
        return;
      }
      assert.equal(request.method, "POST");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert(body.length <= 128 * 1024, "Assistant fixture input exceeded its bound");
      }
      const input = JSON.parse(body);
      if (request.url === "/v1/chat/completions") {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        assert.equal(input.model, apiModel);
        apiChats.push(input);
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Synthetic packaged API response." } }] }));
        return;
      }
      assert.equal(request.url, "/api/chat");
      chats.push(input);
      if (input.messages.at(-1)?.content === "Cancel this synthetic request") { started(); return; }
      response.end(JSON.stringify({ model, done: true, message: { role: "assistant", content: "Synthetic packaged model response; no model was contacted." }, prompt_eval_count: 7, eval_count: 11 }));
    } catch { response.statusCode = 500; response.end('{"error":"invalid fixture input"}'); }
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const endpoint = `http://127.0.0.1:${local.address().port}`;
  try {
    const { catalog } = await settingsRequest("assistant/models", "POST", { endpoint });
    assert.deepEqual(catalog.models.map(item => item.name), [model]);
    assert.equal(catalog.excludedRemoteModels, 1);
    const { reply } = await settingsRequest("assistant/chat", "POST", {
      endpoint, model, messages: [{ role: "user", content: "Plan a synthetic test workflow" }], includeWorkspaceOverview: true,
    });
    assert.equal(reply.message.content, "Synthetic packaged model response; no model was contacted.");
    assert.equal(reply.workspaceOverviewIncluded, true);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].stream, false);
    assert.equal(chats[0].tools, undefined);
    assert(!JSON.stringify(chats[0]).includes(profile.id), "Anonymous context exposed a profile ID");
    assert(!JSON.stringify(chats[0]).includes(profile.name), "Anonymous context exposed a profile name");
    const requestId = randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const pending = settingsRequest("assistant/chat", "POST", {
      requestId, endpoint, model, messages: [{ role: "user", content: "Cancel this synthetic request" }],
    }, 499);
    pending.catch(() => {});
    // A cancelled request must reach the fixture first; no race or arbitrary sleep.
    await bounded(Promise.race([pendingStarted, pending.then(() => { throw new Error("Packaged assistant completed before cancellation"); })]), 5000, "Packaged assistant did not reach the protocol fixture");
    assert.equal((await settingsRequest("assistant/cancel", "POST", { requestId })).cancelled, true);
    assert.equal((await pending).code, "cancelled");
    assert.equal((await settingsRequest("assistant/cancel", "POST", { requestId })).cancelled, false);
    assert.equal(chats.length, 2);

    const services = "assistant/services";
    assert.deepEqual((await settingsRequest(services)).catalog, { services: [], defaultId: null });
    const draft = { provider: "openai-compatible", endpoint: `${endpoint}/v1`, name: "Packaged API fixture", model: apiModel, apiKey };
    const tested = await settingsRequest(`${services}/test`, "POST", draft);
    assert.deepEqual(tested.catalog.models.map(item => item.name), [apiModel]);
    assert.equal(apiChats.length, 0);
    const saved = await settingsRequest(`${services}/save`, "POST", draft);
    const [connection] = saved.catalog.services;
    assert.equal(connection.credentialConfigured, true);
    assert(!JSON.stringify(saved).includes(apiKey), "Model service settings exposed the session key");
    assert.equal((await settingsRequest(`${services}/default`, "POST", { id: connection.id })).catalog.defaultId, connection.id);
    const apiReply = await settingsRequest("assistant/chat", "POST", {
      serviceId: connection.id, serviceProvider: draft.provider, serviceEndpoint: draft.endpoint,
      model: apiModel, messages: [{ role: "user", content: "Check the synthetic API fixture" }],
    });
    assert.equal(apiReply.reply.provider, draft.provider);
    assert.equal(apiReply.reply.message.content, "Synthetic packaged API response.");
    assert.equal(apiChats.length, 1);
    assert.equal(apiChats[0].stream, false);
    assert.equal(apiChats[0].tools, undefined);
    assert.deepEqual((await settingsRequest(`${services}/remove`, "POST", { id: connection.id })).catalog, { services: [], defaultId: null });
  } finally {
    local.closeAllConnections();
    await new Promise(resolveClosed => local.close(resolveClosed));
  }
}

/** Settings requests are restricted to the synthetic service; no proxy egress checks. */
function packagedSettingsRequest(service) {
  const prefix = "/ui/api/settings";
  return async (path = "", method = "GET", body, expected = 200) => {
    const headers = { "X-Maobu-Settings": "1", "Content-Type": "application/json" };
    const response = await service.request(prefix + (path ? `/${path}` : ""), {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
    if (expected < 400) assert.equal(result.ok, true);
    return result;
  };
}

/** Verify new settings against the compiled sidecar and this verifier's synthetic root. */
async function verifyPackagedSettings(service, state, profile, prepared) {
  assert.equal((await service.request("/ui/api/settings")).status, 403, "Settings require their request header");
  const settingsRequest = packagedSettingsRequest(service);
  const initial = (await settingsRequest()).settings;
  assert.equal(initial.version, 1);
  assert.equal(initial.updates.repository, "");
  assert.equal(initial.updates.checkOnStartup, false);
  assert.equal(initial.sync.enabled, false);
  assert.deepEqual(initial.signedUpdates, { checkOnStartup: false }, "The trusted startup check must be opt-in");
  assert.deepEqual(initial.network, { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false }, "Fresh workspaces must keep network preferences at their defaults");
  const networkSaved = (await settingsRequest("", "PATCH", { network: { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "disabled" } })).settings;
  assert.deepEqual(networkSaved.network, { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "disabled", chromiumMemorySaver: false });
  assert.deepEqual(networkSaved.updates, initial.updates, "Network-only saves must preserve update settings");
  assert.deepEqual(networkSaved.sync, initial.sync, "Network-only saves must preserve sync settings");
  assert.equal((await settingsRequest()).settings.network.checkLocalProxyBeforeLaunch, true);
  assert.equal(JSON.parse(await readFile(join(state, "app-settings.json"), "utf8")).network.checkLocalProxyBeforeLaunch, true, "Network preference must be durable");
  const signedSaved = (await settingsRequest("", "PATCH", { signedUpdates: { checkOnStartup: true } })).settings;
  assert.deepEqual(signedSaved, { ...networkSaved, signedUpdates: { checkOnStartup: true } }, "Opting in to the signed channel must preserve other settings");
  assert.equal(JSON.parse(await readFile(join(state, "app-settings.json"), "utf8")).signedUpdates.checkOnStartup, true);
  const greeter = await socksFixture("::1");
  try {
    await settingsRequest("network/discover", "POST", { host: "::1", ports: [greeter.port, greeter.port] }, 400);
    const { discovery } = await settingsRequest("network/discover", "POST", { host: "::1", ports: [greeter.port] });
    assert.equal(discovery.host, "::1");
    assert.equal(discovery.results.length, 1);
    const [row] = discovery.results;
    assert.equal(row.host, "::1"); assert.equal(row.port, greeter.port);
    assert.equal(row.status, "listening"); assert.equal(row.socks5, "authentication_required");
    assert.deepEqual(row.suggestions, [{ type: "socks5", evidence: "handshake" }]);
    await greeter.assertGreetingOnly();
  } finally { await greeter.close(); }
  const emptyPresets = (await settingsRequest("templates")).catalog;
  assert.deepEqual(emptyPresets, { version: 1, revision: 0, templates: [] });
  assert.equal(await lstat(join(state, "profile-templates.json")).then(() => true, () => false), false, "Reading empty presets must not write a file");
  const presetSettings = { engine: "chromium", chromiumRuntime: "", platformOs: "windows", screen: "1920x1080", platform: "example.com" };
  const presets = (await settingsRequest("templates", "POST", { revision: 0, name: "Synthetic device-default preset", settings: presetSettings })).catalog;
  assert.equal(presets.revision, 1);
  assert.equal(presets.templates.length, 1);
  assert.deepEqual(presets.templates[0].settings, presetSettings);
  assert(!JSON.stringify(presets).includes(profile.name), "A preset copied the profile name");
  const presetPreview = (await settingsRequest("templates/preview", "POST", { id: presets.templates[0].id,
    settings: { ...presetSettings, screen: "1366x768" } })).preview;
  assert.equal(presetPreview.freshIdentity, true);
  assert.deepEqual(presetPreview.changes, [{ field: "screen", before: "1366x768", after: "1920x1080" }]);
  assert.equal((await settingsRequest("updates")).update, null);
  assert.equal((await settingsRequest("updates", "POST", {})).update.status, "not-configured");
  const runtimesBefore = (await settingsRequest("runtimes")).inventory;
  assert.equal(runtimesBefore.checked, false);
  assert.equal(runtimesBefore.host.platform, "win32");
  assert.deepEqual(runtimesBefore.runtimes.map(runtime => runtime.id), ["aliasmode-chromium", "cloakbrowser", "aliasmode-firefox"]);
  assert(runtimesBefore.runtimes.every(runtime => ["not-checked", "not-applicable"].includes(runtime.cache)), "Reading the catalog must not inspect any local cache");
  assert.equal(await lstat(join(state, "runtimes")).then(() => true, () => false), false, "Runtime inventory must not create a cache directory");
  const runtimesAfter = (await settingsRequest("runtimes/inspect", "POST", {})).inventory;
  assert.equal(runtimesAfter.checked, true);
  assert(runtimesAfter.runtimes.every(runtime => ["missing", "not-applicable"].includes(runtime.cache)), "A fresh isolated cache must report no verified runtime");
  assert(!JSON.stringify(runtimesAfter).includes(JSON.stringify(state).slice(1, -1)), "The browser runtime list must not reveal its storage path");
  assert.equal(await lstat(join(state, "runtimes")).then(() => true, () => false), false, "An explicit read must not create a cache directory");
  const reports = (await settingsRequest("fingerprints")).reports;
  assert.equal(reports.length, 1);
  assert.notEqual(reports[0].status, "consistent", "An unmeasured packaged profile cannot pass fingerprint acceptance");
  const integration = (await settingsRequest("integrations")).integration;
  assert.equal(integration.status, "ready");
  assert.equal(integration.connectionVerified, false);
  assert.equal(integration.helperPath, join(prepared.runtimeRoot, "aliasmode-mcp.exe"));
  assert.equal(integration.configs.length, 3);
  assert.equal(integration.tools.length, 12, "Packaged integration catalog must include all twelve local tools");
  assert.equal(new Set(integration.tools.map(tool => tool.name)).size, 12, "Integration tool names must be unique");
  assert(integration.tools.some(tool => tool.name === "aliasmode_profiles_list"));
  for (const name of ["aliasmode_fingerprint_review", "aliasmode_network_discover"]) {
    const tool = integration.tools.find(tool => tool.name === name);
    assert(tool, `Packaged integration catalog is missing ${name}`);
    assert.equal(tool.readOnly, true); assert.equal(tool.destructive, false); assert.equal(tool.openWorld, false);
  }
  // The separate protocol fixture uses only copied resources and its synthetic
  // APPDATA descriptor; this filesystem catalog never reads a user descriptor.
  const folder = join(state, "sync-fixture");
  await settingsRequest("", "PATCH", { sync: { enabled: true, folder, retainSnapshots: 3 } });
  const syncedSettings = (await settingsRequest()).settings;
  assert.equal(syncedSettings.network.checkLocalProxyBeforeLaunch, true, "Saving sync preferences must preserve the network gate");
  assert.equal(syncedSettings.signedUpdates.checkOnStartup, true, "Saving sync preferences must preserve the signed startup check");
  const password = snapshotPassword;
  const created = await settingsRequest("sync/create", "POST", { password });
  assert.equal(created.profileCount, 1);
  const files = (await settingsRequest("sync/files")).files;
  assert.equal(files.length, 1);
  assert.equal(files[0].fileName, created.file.fileName);
  const sealed = await readFile(join(folder, created.file.fileName));
  assert(!sealed.includes(Buffer.from(profile.name)), "Encrypted snapshot contains a plaintext profile name");
  const preview = await settingsRequest("sync/preview", "POST", { password, fileName: created.file.fileName });
  assert.equal(preview.preview.profileCount, 1);
  const imported = await settingsRequest("sync/import", "POST", { password, fileName: created.file.fileName, previewHash: preview.previewHash });
  assert.equal(imported.imported, 0);
  assert.equal(imported.skipped, 1);
  await verifyPackagedAssistant(settingsRequest, profile);
  return { templateId: presets.templates[0].id, integrationToolCount: integration.tools.length,
    snapshot: { folder, fileName: created.file.fileName, sourcePreviewHash: preview.previewHash } };
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
    const createdRoster = (await read("/ui/api/profiles")).profiles;
    assert.equal(createdRoster.length, 1);
    const featureEvidence = await verifyPackagedSettings(service, state, createdRoster[0], prepared);
    const settings = packagedSettingsRequest(service);
    const { catalog: modelCatalog } = await settings("assistant/services/save", "POST", {
      name: "Packaged backup model", provider: "openai-compatible", endpoint: "http://127.0.0.1:43119/v1",
      model: "backup-fixture", apiKey: "synthetic-backup-model-key",
    });
    const modelServiceId = modelCatalog.services[0].id;
    assert.equal(modelCatalog.services[0].credentialConfigured, true);
    await settings("assistant/services/default", "POST", { id: modelServiceId });
    const mcpEvidence = await verifyPackagedMcp({ prepared, version, home: state, service, profileId: profile.id });
    await send("PATCH", "/ui/api/workspaces/default", { name: "Packaged verification", icon: "globe", color: "#628ac7" });
    const independent = (await send("POST", "/ui/api/workspaces", { name: "Packaged empty workspace", icon: "briefcase", color: "#638f77" }, 201)).workspace;
    assert.match(independent.id, /^ws_[a-f0-9]{32}$/);
    await send("PATCH", `/ui/api/workspaces/${independent.id}`, { name: "Packaged isolated workspace" });
    await send("POST", `/ui/api/workspaces/${independent.id}/archive`, { archived: true });
    await send("POST", `/ui/api/workspaces/${independent.id}/activate`, {}, 404);
    await send("POST", `/ui/api/workspaces/${independent.id}/archive`, { archived: false });
    const backupPassword = "synthetic-packaged-backup-password";
    const backupJob = await waitJob((await send("POST", "/ui/api/workspace/backups", { password: backupPassword }, 202)).job.id);
    const records = (await read("/ui/api/workspace/backups")).backups;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, backupJob.result.backupId);
    assert.equal(records[0].profileCount, 1);
    assert.equal(records[0].encrypted, true);
    assert.equal(records[0].path, undefined, "Backup API must not disclose arbitrary backend file paths");
    const download = await request(`/ui/api/workspace/backups/${records[0].id}/download`);
    assert.equal(download.status, 200);
    const archive = Buffer.from(await download.arrayBuffer());
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const encryptedMagic = Buffer.from("MAOBU-ENCRYPTED-BACKUP\0v1\n");
    assert(archive.subarray(0, encryptedMagic.length).equals(encryptedMagic), "Workspace backup must use its encrypted format");
    assert.equal(download.headers.get("X-Backup-SHA256"), sha256);
    assert.equal(records[0].sha256, sha256);
    assert.equal(Number(download.headers.get("Content-Length")), archive.length);
    const restored = await waitJob((await send("POST", "/ui/api/workspace/restore", { backupId: records[0].id, password: backupPassword, name: "Packaged restored copy" }, 202)).job.id);
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
    assert.deepEqual((await service.read("/ui/api/settings/templates", 200, { "X-Maobu-Settings": "1" })).catalog.templates, []);
    const independentSettingsRequest = packagedSettingsRequest(service);
    assert.deepEqual((await independentSettingsRequest("assistant/services")).catalog, { services: [], defaultId: null });
    const independentSettings = (await independentSettingsRequest()).settings;
    assert.deepEqual(independentSettings.network, { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false }, "A separate workspace must not inherit the original network preferences");
    assert.deepEqual(independentSettings.signedUpdates, { checkOnStartup: false }, "A separate workspace must not inherit the signed startup check");
    assert.equal((await independentSettingsRequest("", "PATCH", { network: { checkLocalProxyBeforeLaunch: true } })).settings.network.checkLocalProxyBeforeLaunch, true);
    assert.equal((await independentSettingsRequest("", "PATCH", { network: { checkLocalProxyBeforeLaunch: false } })).settings.network.checkLocalProxyBeforeLaunch, false);
    assert.equal((await independentSettingsRequest()).settings.network.checkLocalProxyBeforeLaunch, false);
    assert.equal(JSON.parse(await readFile(join(state, "app-settings.json"), "utf8")).network.checkLocalProxyBeforeLaunch, true, "Saving the independent workspace must not change the original");
    const { folder, fileName, sourcePreviewHash } = featureEvidence.snapshot;
    await independentSettingsRequest("", "PATCH", { sync: { enabled: true, folder } });
    const snapshotRequest = { password: snapshotPassword, fileName };
    await independentSettingsRequest("sync/preview", "POST", { ...snapshotRequest, password: "wrong-synthetic-password" }, 400);
    await independentSettingsRequest("sync/import", "POST", { ...snapshotRequest, previewHash: sourcePreviewHash }, 409);
    assert.deepEqual((await service.read("/ui/api/profiles")).profiles, [], "A foreign workspace preview must not import the profile");
    const targetPreview = await independentSettingsRequest("sync/preview", "POST", snapshotRequest);
    assert.equal(targetPreview.preview.newCount, 1);
    assert.equal(targetPreview.preview.profiles[0].id, profile.id);
    assert.deepEqual(await independentSettingsRequest("sync/import", "POST", { ...snapshotRequest, previewHash: targetPreview.previewHash }), { ok: true, imported: 1, skipped: 0 });
    assert.deepEqual((await service.read("/ui/api/profiles")).profiles.map(row => row.id), [profile.id]);
    await independentSettingsRequest("sync/import", "POST", { ...snapshotRequest, previewHash: targetPreview.previewHash }, 409);
    const previewAfterImport = await independentSettingsRequest("sync/preview", "POST", snapshotRequest);
    assert.equal(previewAfterImport.preview.newCount, 0);
    assert.equal(previewAfterImport.preview.conflictCount, 1);
    assert.equal((await service.send("POST", `/ui/api/workspaces/${restored.result.workspaceId}/activate`)).restartRequired, true);
    await service.stop();
    service = undefined;

    // Restored settings must retain presets while leaving automatic folder IO disabled.
    service = await startSidecar(prepared, version, state, join(state, "workspaces", restored.result.workspaceId), restored.result.workspaceId);
    assert.equal((await service.read("/ui/api/profiles")).profiles[0].id, profile.id);
    const restoredSettings = (await service.read("/ui/api/settings", 200, { "X-Maobu-Settings": "1" })).settings;
    const { catalog: restoredModels } = await packagedSettingsRequest(service)("assistant/services");
    assert.equal(restoredModels.defaultId, modelServiceId);
    assert.deepEqual(restoredModels.services, [{ ...modelCatalog.services[0], credentialConfigured: false }]);
    assert.equal(restoredSettings.sync.enabled, false);
    assert.equal(restoredSettings.sync.folder, join(state, "sync-fixture"));
    assert.deepEqual(restoredSettings.signedUpdates, { checkOnStartup: false }, "Restored workspaces must opt in again to startup checks");
    assert.deepEqual(restoredSettings.network, { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "disabled", chromiumMemorySaver: false }, "Full backups must preserve saved network preferences");
    const restoredSettingsRequest = packagedSettingsRequest(service);
    const changedRestoredSettings = (await restoredSettingsRequest("", "PATCH", { network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default" } })).settings;
    assert.deepEqual(changedRestoredSettings, { ...restoredSettings, network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false } }, "Changing restored network preferences must preserve all other restored settings");
    assert.equal(JSON.parse(await readFile(join(state, "app-settings.json"), "utf8")).network.checkLocalProxyBeforeLaunch, true, "Restored workspace settings must not overwrite the original");
    assert.equal((await service.read("/ui/api/settings/templates", 200, { "X-Maobu-Settings": "1" })).catalog.templates[0].id, featureEvidence.templateId);
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
    const originalSettings = (await packagedSettingsRequest(service)()).settings;
    assert.deepEqual(originalSettings.network, { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "disabled", chromiumMemorySaver: false }, "The original network preferences must survive all workspace switches");
    assert.deepEqual(originalSettings.signedUpdates, { checkOnStartup: true }, "The original signed startup check must survive all workspace switches");
    for (const id of [independent.id, restored.result.workspaceId]) assert.equal(JSON.parse(await readFile(join(state, "workspaces", id, "app-settings.json"), "utf8")).network.checkLocalProxyBeforeLaunch, false, "Other workspaces must retain their independent network setting");
    assert.deepEqual((await service.read("/ui/api/runtime-downloads")).downloads, [], "Settings checks must not download a browser");
    const registry = JSON.parse(await readFile(join(state, "desktop-workspaces.json"), "utf8"));
    assert.equal(registry.activeId, "default");
    assert.equal(registry.workspaces.length, 3);
    await service.stop();
    service = undefined;
    console.log(JSON.stringify({
      packagedStartup: "ok", dashboard: html.status, dashboardModuleInitialization: "ok", initializedModules, localOnly: true,
      retiredCloudStatus: retired.status, cloudSwitchStatus: switchMode.status,
      hostedFingerprintStatus: fingerprint.status, idleDownloads: 0,
      desktopSessionAuthorization: "ok", capabilityAuthorization: "ok", catalogCrud: "ok", encryptedBackupDownloadSha256: "ok", restoreToNewWorkspace: "ok", modelCatalogBackupAndIsolation: "ok",
      settingsAndEncryptedSnapshots: "ok", encryptedSnapshotCrossWorkspaceImport: "ok", profilePresetBackupAndIsolation: "ok", networkPreferenceBackupAndIsolation: "ok", anonymousAssistantContext: "ok", assistantProtocolFixtureAndCancellation: "ok", assistantApiServiceFixture: "ok", mcpResourceReadiness: "ok", integrationToolCount: featureEvidence.integrationToolCount,
      ...mcpEvidence, browserRuntimeInventory: "ok", signedStartupPreferenceIsolation: "ok", ipv6DiscoveryGreetingOnly: true,
      physicalWorkspaceIsolation: "ok", originalProfilesPreserved: preserved.length, gracefulShutdowns: 4,
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
