/**
 * Isolated UI acceptance fixture, never an application entry point.
 * Uses the production React bundle and real SQLite/UI handlers. Browser lifecycle,
 * proxy checks, location lookups and external extension downloads are simulated
 * here only: this tool never constructs a real Launcher or downloads an engine.
 *
 * bun --no-env-file scripts/preview-airy-ui.ts
 * bun --no-env-file scripts/preview-airy-ui.ts --rows 65
 * bun --no-env-file scripts/preview-airy-ui.ts --frameless
 * bun --no-env-file scripts/preview-airy-ui.ts --frameless --fingerprint-evidence
 * bun --no-env-file scripts/preview-airy-ui.ts --signed-update
 * bun --no-env-file scripts/preview-airy-ui.ts --frameless --runtime-download-progress
 * bun --no-env-file scripts/preview-airy-ui.ts --mcp-connection
 * bun --no-env-file scripts/preview-airy-ui.ts --sync-snapshots
 * bun --no-env-file scripts/preview-airy-ui.ts --smoke
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { AppConfigStore } from "../app-config.ts";
import { AppSettingsStore } from "../app-settings.ts";
import { getIntegrationInfo } from "../agent/integration-info.ts";
import { buildNewProfile } from "../create.ts";
import { createSyncSnapshot, writeSyncSnapshot } from "../encrypted-sync.ts";
import type { Launcher } from "../launcher.ts";
import { ensureStateDirectories, statePaths } from "../paths.ts";
import { ProfileStore } from "../store.ts";
import { ScriptLibrary } from "../scripts.ts";
import type { Profile, ProxySpec } from "../types.ts";
import { handleUiRequest, type UiRuntimeOptions } from "../ui.ts";
import { isStandaloneRequestAuthorized, serveDashboard, STANDALONE_SESSION_HEADER } from "../web.ts";
import { rejectUntrustedLocalRequest } from "../server.ts";
import { WorkspaceManagement } from "../workspace-management.ts";
import { LocalAssistantService } from "../local-assistant.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// This fixture-only bridge follows the installed Tauri SDK's core/window/event
// IPC protocol. It only changes in-page state; it cannot control an OS window.
const FRAMELESS_QA_SCRIPT = String.raw`<script data-qa-frameless-bridge>
(() => {
  "use strict";
  const root = document.documentElement;
  const callbacks = new Map(), listeners = new Map();
  let nextCallback = 1, nextEvent = 1, actionCount = 0;
  let maximized = false, focused = true;
  let closeSession = null, closeIntent = null, nextCloseRequest = 1;
  const scriptCapability = __UI_QA_SCRIPT_CAPABILITY__;
  const signedFixture = __UI_QA_SIGNED_UPDATE__;
  let updateChecks = 0;
  function signedStatus() {
    if (!signedFixture) return { configured: false, status: "disabled", currentVersion: "", endpoint: null, update: null, message: "Signed updates are disabled in the isolated UI fixture." };
    const currentVersion = "0.1.0-local.1", version = "0.2.0-ui-qa";
    return { configured: true, status: updateChecks ? "available" : "idle", currentVersion, endpoint: "https://updates.example.invalid/latest.json",
      message: updateChecks ? "【模拟更新】发现可用版本。" : "【模拟更新】可信通道已就绪。",
      update: updateChecks ? { version, currentVersion, notes: "【模拟更新】仅用于验收启动提醒和更新设置；未联网、下载或安装。", publishedAt: null } : null };
  }
  window.__MAOBU_FRAMELESS__ = true;
  window.isTauri = true;
  root.setAttribute("data-qa-window-controls", "simulated");
  function state() {
    root.setAttribute("data-qa-window-maximized", String(maximized));
    root.setAttribute("data-qa-window-focused", String(focused));
  }
  function action(name) {
    root.setAttribute("data-qa-window-action", name);
    root.setAttribute("data-qa-window-action-count", String(++actionCount));
    state();
  }
  function reject(message, command) {
    root.setAttribute("data-qa-window-rejected", String(command));
    throw new Error("Frameless QA mock: " + message);
  }
  function unregisterCallback(id) { callbacks.delete(id); }
  function transformCallback(callback, once = false) {
    if (typeof callback !== "function") throw new TypeError("Frameless QA callback must be a function");
    const id = nextCallback++;
    callbacks.set(id, { callback, once });
    return id;
  }
  function runCallback(id, data) {
    const entry = callbacks.get(id);
    if (!entry) return;
    if (entry.once) unregisterCallback(id);
    entry.callback(data);
  }
  function emit(event, payload) {
    for (const [id, listener] of Array.from(listeners)) {
      if (listener.event === event) runCallback(listener.handler, { event, id, payload });
    }
  }
  function removeListener(event, eventId) {
    const listener = listeners.get(eventId);
    if (!listener || listener.event !== event) return;
    listeners.delete(eventId);
    unregisterCallback(listener.handler);
  }
  async function invoke(command, args = {}) {
    if (command === "open_external_resource") { root.setAttribute("data-qa-external-resource", String(args.url)); return; }
    if (command === "agent_runtime_ready") return;
    if (command === "signed_update_status") return signedStatus();
    if (command === "signed_update_check" && signedFixture) {
      root.setAttribute("data-qa-signed-check-count", String(++updateChecks));
      root.setAttribute("data-qa-signed-check-mode", args.startup === true ? "startup" : "manual");
      return signedStatus();
    }
    if (command === "script_capability") return scriptCapability;
    if (command === "desktop_close_register") {
      closeSession = "f".repeat(64);
      return { sessionId: closeSession };
    }
    if (command === "desktop_close_unregister") {
      if (args.sessionId === closeSession) { closeSession = null; closeIntent = null; }
      return;
    }
    if (command === "desktop_close_resolve") {
      if (!closeIntent || args.sessionId !== closeIntent.sessionId || args.requestId !== closeIntent.requestId || args.deliveryId !== closeIntent.deliveryId) return "stale";
      if (args.decision === "hold") return "holding";
      if (args.decision !== "proceed" && args.decision !== "cancel") return "stale";
      const resolved = { sessionId: closeIntent.sessionId, requestId: closeIntent.requestId, outcome: "cancelled" };
      closeIntent = null;
      root.setAttribute("data-qa-window-close-decision", args.decision);
      if (args.decision === "proceed") queueMicrotask(() => emit("maobu-desktop-close-resolved", resolved));
      return args.decision === "proceed" ? "continuing" : "cancelled";
    }
    if (command === "plugin:event|listen") {
      if (typeof args.event !== "string" || !/^[A-Za-z0-9_:/-]+$/.test(args.event) || !callbacks.has(args.handler)) reject("invalid event listener", command);
      const target = args.target || { kind: "Any" };
      if (!(target.kind === "Any" || ["Window", "AnyLabel"].includes(target.kind) && target.label === "main")) reject("unsupported event target", command);
      const eventId = nextEvent++;
      listeners.set(eventId, { event: args.event, handler: args.handler });
      return eventId;
    }
    if (command === "plugin:event|unlisten") { removeListener(args.event, args.eventId); return; }
    const commands = ["is_maximized", "is_focused", "minimize", "toggle_maximize", "start_dragging", "close"];
    const operation = typeof command === "string" && command.startsWith("plugin:window|") ? command.slice("plugin:window|".length) : "";
    if (!commands.includes(operation)) reject("unsupported command " + String(command), command);
    if (args.label !== "main") reject("unknown window label", command);
    if (operation === "is_maximized") return maximized;
    if (operation === "is_focused") return focused;
    if (operation === "toggle_maximize") {
      maximized = !maximized; action(operation);
      emit("tauri://resize", { width: window.innerWidth, height: window.innerHeight });
    } else if (operation === "minimize") {
      focused = false; action(operation); emit("tauri://blur", null);
    } else if (operation === "close") {
      action(operation);
      if (closeSession) {
        closeIntent = closeIntent ? { ...closeIntent, deliveryId: closeIntent.deliveryId + 1 }
          : { sessionId: closeSession, requestId: (nextCloseRequest++).toString(16).padStart(64, "0"), deliveryId: 1 };
        emit("maobu-desktop-close-intent", closeIntent);
      }
    } else action(operation);
  }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    invoke, transformCallback, unregisterCallback, runCallback, callbacks
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: removeListener };
  window.addEventListener("resize", () => emit("tauri://resize", { width: window.innerWidth, height: window.innerHeight }));
  window.addEventListener("focus", () => { focused = true; state(); emit("tauri://focus", null); });
  window.addEventListener("blur", () => { focused = false; state(); emit("tauri://blur", null); });
  action("ready");
})();
</script>`;

function framelessQaHtml(html: string, scriptCapability: string, signedUpdate = false): string {
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error("Production HTML has no head for the isolated frameless QA bridge");
  if (!/^[a-f0-9]{64}$/.test(scriptCapability)) throw new Error("Invalid isolated script capability");
  const bridge = FRAMELESS_QA_SCRIPT.replace("__UI_QA_SCRIPT_CAPABILITY__", JSON.stringify(scriptCapability)).replace("__UI_QA_SIGNED_UPDATE__", JSON.stringify(signedUpdate));
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bridge);
}

function scriptLibraryRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === "/ui/api/scripts" && ["GET", "POST"].includes(request.method)
    || /^\/ui\/api\/scripts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path) && ["GET", "PATCH", "DELETE"].includes(request.method)
    || request.method === "GET" && ["/ui/api/scripts/run", "/ui/api/scripts/python-runtime", "/ui/api/scripts/log"].includes(path);
}

const executionDisabled = () => Response.json({ ok: false, error: "Script execution and runtime changes are disabled in the isolated UI fixture" }, { status: 503, headers: { "Cache-Control": "no-store" } });

/** Check the actual installed SDK against an in-memory DOM, without opening UI. */
async function smokeFramelessBridge(html: string, scriptCapability: string, signedUpdate: boolean) {
  const attributes = new Map<string, string>(), browserEvents = new Map<string, () => void>();
  const qaWindow: any = { innerWidth: 1280, innerHeight: 800, addEventListener: (name: string, handler: () => void) => browserEvents.set(name, handler) };
  const script = html.match(/<script data-qa-frameless-bridge>([\s\S]*?)<\/script>/)?.[1];
  assert(script, "Frameless QA bridge must precede the application bundle");
  runInNewContext(script, { window: qaWindow, queueMicrotask, document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } } });
  assert.equal(qaWindow.__MAOBU_FRAMELESS__, true);
  assert.equal(attributes.get("data-qa-window-controls"), "simulated");
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: qaWindow });
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = getCurrentWindow();
    assert.equal(current.label, "main");
    assert.equal(await current.isMaximized(), false);
    assert.equal(await current.isFocused(), true);
    const sizes: number[] = [], focus: boolean[] = [];
    const unresize = await current.onResized(({ payload }) => sizes.push(payload.width));
    const unfocus = await current.onFocusChanged(({ payload }) => focus.push(payload));
    await current.toggleMaximize();
    assert.equal(await current.isMaximized(), true);
    assert.equal(attributes.get("data-qa-window-maximized"), "true");
    assert.deepEqual(sizes, [1280]);
    await current.minimize();
    assert.equal(await current.isFocused(), false);
    assert.deepEqual(focus, [false]);
    browserEvents.get("focus")!();
    assert.equal(await current.isFocused(), true);
    assert.deepEqual(focus, [false, true]);
    await current.startDragging();
    assert.equal(attributes.get("data-qa-window-action"), "start_dragging");
    const bridge = qaWindow.__TAURI_INTERNALS__;
    let intent: { sessionId: string; requestId: string; deliveryId: number } | null = null;
    const unintent = await current.listen<typeof intent>("maobu-desktop-close-intent", ({ payload }) => { intent = payload; });
    const { sessionId } = await bridge.invoke("desktop_close_register");
    await current.close();
    assert.equal(attributes.get("data-qa-window-action"), "close");
    assert(intent);
    const closeRequest: { sessionId: string; requestId: string; deliveryId: number } = intent;
    assert.equal(closeRequest.sessionId, sessionId);
    assert.equal(await bridge.invoke("desktop_close_resolve", { ...closeRequest, decision: "hold" }), "holding");
    assert.equal(await bridge.invoke("desktop_close_resolve", { ...closeRequest, decision: "cancel" }), "cancelled");
    assert.equal(attributes.get("data-qa-window-close-decision"), "cancel");
    assert.equal(await bridge.invoke("desktop_close_resolve", { ...closeRequest, decision: "proceed" }), "stale");
    await bridge.invoke("desktop_close_unregister", { sessionId });
    await unresize(); await unfocus(); await unintent();
    browserEvents.get("resize")!();
    browserEvents.get("blur")!();
    assert.deepEqual(sizes, [1280]);
    assert.deepEqual(focus, [false, true]);
    let called = 0;
    const callback = bridge.transformCallback(() => called++, true);
    bridge.runCallback(callback, null); bridge.runCallback(callback, null);
    assert.equal(called, 1);
    assert.equal(bridge.callbacks.size, 0, "SDK unlisten must release registered callbacks");
    assert.equal(await bridge.invoke("script_capability"), scriptCapability);
    assert.equal((await bridge.invoke("signed_update_status")).configured, signedUpdate);
    if (signedUpdate) {
      assert.equal((await bridge.invoke("signed_update_check", { startup: true })).update.version, "0.2.0-ui-qa");
      assert.equal(attributes.get("data-qa-signed-check-count"), "1");
      assert.equal(attributes.get("data-qa-signed-check-mode"), "startup");
    }
    await assert.rejects(bridge.invoke("signed_update_install"), /unsupported command/);
    await assert.rejects(bridge.invoke("open_workspace_location"), /unsupported command/);
    await assert.rejects(bridge.invoke("plugin:window|close", { label: "other-window" }), /unknown window label/);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_BASE64 = Math.ceil(MAX_CAPTURE_BYTES / 3) * 4;
const MAX_CAPTURE_FORM_BYTES = MAX_CAPTURE_BASE64 + 64 * 1024;
const captureForm = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>UI QA 截图保存</title></head><body><main>
<h1>仅用于本地 UI 验收的截图保存工具</h1>
<form method="post" action="/__qa/capture" enctype="multipart/form-data">
<label>截图数据<textarea name="image" aria-label="截图数据" required></textarea></label>
<label>截图名称<input name="name" aria-label="截图名称" value="workbench" required maxlength="50" pattern="[A-Za-z0-9_-]+"></label>
<button type="submit">保存截图</button>
</form></main></body></html>`;

class CaptureInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** The CUA-owned screenshot is supplied through this local form, not an fs API. */
async function captureScreenshot(request: Request, root: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") return new Response(captureForm, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, POST" } });
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ ok: false, error: "同源截图表单请求才可保存" }, { status: 403, headers });
  }
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) throw new CaptureInputError("请通过截图表单提交", 415);
    const announced = request.headers.get("content-length");
    if (announced && Number(announced) > MAX_CAPTURE_FORM_BYTES) throw new CaptureInputError("截图不能超过 5 MB", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new CaptureInputError("缺少截图数据");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_CAPTURE_FORM_BYTES) {
          await reader.cancel();
          throw new CaptureInputError("截图不能超过 5 MB", 413);
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    const name = form.get("name");
    const encoded = form.get("image");
    if (form.getAll("name").length !== 1 || typeof name !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(name)) {
      throw new CaptureInputError("截图名称只能是 1–50 位字母、数字、破折号或下划线");
    }
    if (form.getAll("image").length !== 1 || typeof encoded !== "string" || !encoded) throw new CaptureInputError("缺少截图数据");
    if (encoded.length > MAX_CAPTURE_BASE64) throw new CaptureInputError("截图不能超过 5 MB", 413);
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new CaptureInputError("截图必须是标准 base64");
    const image = Buffer.from(encoded, "base64");
    if (image.length > MAX_CAPTURE_BYTES) throw new CaptureInputError("截图不能超过 5 MB", 413);
    if (image.toString("base64") !== encoded) throw new CaptureInputError("截图 base64 无效");
    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
      throw new CaptureInputError("截图必须包含 JPEG 文件头和结束标记");
    }
    const path = resolve(root, `${name}.jpg`);
    if (dirname(path) !== resolve(root)) throw new CaptureInputError("截图名称无效");
    // Exclusive creation also refuses an existing symlink: the tool never follows
    // or overwrites a path somebody placed under the fixture directory.
    try { writeFileSync(path, image, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CaptureInputError("截图名称已存在，请更换名称", 409);
      throw error;
    }
    return Response.json({ ok: true, path }, { headers });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof CaptureInputError ? error.message : "截图表单无法读取或保存" }, { status: error instanceof CaptureInputError ? error.status : 400, headers });
  }
}
const examples = [
  { id: "01", name: "Product Hunt · 主账号", group: "海外业务", host: "198.51.100.12", port: "8080", timezone: "America/Los_Angeles", platform: "", country: "US" },
  { id: "02", name: "Amazon · US 运营", group: "海外业务", host: "203.0.113.24", port: "1080", timezone: "America/New_York", platform: "", country: "US" },
  { id: "03", name: "内容发布 · 主号", group: "国内运营", host: "198.51.100.38", port: "8080", timezone: "Asia/Singapore", platform: "", country: "SG" },
  { id: "04", name: "店铺巡检", group: "国内运营", host: "203.0.113.45", port: "8080", timezone: "Asia/Hong_Kong", platform: "", country: "HK" },
  { id: "05", name: "Reddit · Research", group: "海外业务", host: "192.0.2.61", port: "1080", timezone: "Europe/London", platform: "reddit.com", country: "GB" },
  { id: "06", name: "素材采集", group: "国内运营", host: "198.51.100.72", port: "8080", timezone: "Asia/Tokyo", platform: "", country: "JP" },
  { id: "07", name: "新环境 · A", group: "临时测试", host: "", port: "", timezone: "Asia/Shanghai", platform: "", country: "CN" },
  { id: "08", name: "新环境 · B", group: "临时测试", host: "203.0.113.89", port: "1080", timezone: "Europe/Berlin", platform: "", country: "DE" },
] as const;

const syntheticRuntimeDownloads = [
  { runtime: "aliasmode", receivedBytes: 78_000_000, totalBytes: 200_000_000 },
  { runtime: "firefox", receivedBytes: 14_000_000, totalBytes: 0 },
] as const;
const QA_SNAPSHOT_PASSWORD = "synthetic-snapshot-passphrase";

export async function createUiQaFixture(rows = 8, preview: { frameless?: boolean; fingerprintEvidence?: boolean; signedUpdate?: boolean; runtimeDownloadProgress?: boolean; mcpConnection?: boolean; syncSnapshots?: boolean } = {}) {
  if (!Number.isInteger(rows) || rows < 8 || rows > 2000) throw new Error("--rows must be an integer between 8 and 2000");
  const base = join(projectRoot, "reports", "ui-qa");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "airy-"));
  const paths = statePaths(root);
  const mockIntegration = preview.mcpConnection ? getIntegrationInfo({
    runtimeAvailable: true, helperPath: join(root, "mock-helper", "aliasmode-mcp"), runtimeRoot: join(root, "mock-runtime"),
  }, { isFile: () => true }) : null;
  ensureStateDirectories(paths);
  const frameless = !!(preview.frameless || preview.signedUpdate);
  if (preview.signedUpdate) new AppSettingsStore(join(root, "app-settings.json")).patch({ signedUpdates: { checkOnStartup: true } });
  const store = new ProfileStore(paths.database);
  const appConfig = new AppConfigStore(paths.config);
  appConfig.setMode("local");
  writeFileSync(join(root, "shell.json"), JSON.stringify({ language: "zh-CN" }));
  const logRoot = join(root, "logs");
  mkdirSync(logRoot);
  writeFileSync(join(logRoot, `aliasmode-${new Date().toISOString().slice(0, 10)}.log`), "UI acceptance fixture: all browser lifecycle and network checks are simulated.\n");

  function seed(example: typeof examples[number], index: number): Profile {
    const profile = buildNewProfile({
      engine: "chromium", chromiumRuntime: "aliasmode", name: example.name,
      group: example.group, platform: example.platform, screen: "1440x900",
    }, (id) => !!store.getProfile(id));
    profile.id = `uiqa${String(index + 1).padStart(4, "0")}`;
    profile.name = index < 8 ? example.name : `${example.name} · QA ${index + 1}`;
    profile.timezone = example.timezone;
    profile.proxy = example.host ? { type: example.port === "1080" ? "socks5" : "http", host: example.host, port: example.port, user: "", pass: "" } : null;
    store.upsertProfile(profile);
    return profile;
  }
  const initial = Array.from({ length: rows }, (_, index) => seed(examples[index % examples.length]!, index));
  if (preview.syncSnapshots) {
    const folder = join(root, "isolated-snapshots");
    for (const profile of initial.slice(0, 2)) await writeSyncSnapshot(folder, createSyncSnapshot([profile]), QA_SNAPSHOT_PASSWORD);
    const newProfile = { ...initial[0]!, id: "uiqa-sync-receipt", name: "【模拟】快照恢复验收", proxy: null };
    await writeSyncSnapshot(folder, createSyncSnapshot([initial[0]!, newProfile]), QA_SNAPSHOT_PASSWORD);
    new AppSettingsStore(join(root, "app-settings.json")).patch({ sync: { enabled: true, folder } });
  }
  if (preview.fingerprintEvidence) {
    // Explicitly synthetic observations for UI layout and translation QA. They
    // receive no local capture provenance and never count as a verified identity.
    const sample = initial.at(-1)!;
    sample.name = "【模拟采样】指纹差异展示";
    sample.platformOs = "windows"; sample.locale = "zh-CN"; sample.timezone = "Asia/Shanghai";
    sample.hardware = { ...sample.hardware, cores: 8 };
    sample.fpObserved = {
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      platform: "Win32", uaChPlatform: "Windows", language: "en-US", languages: "en-US,en", hardwareConcurrency: 2,
      timezone: "America/New_York", screen: "1280x720", availableScreen: "1280x680", webglVendor: "UI QA fixture", webglRenderer: "Synthetic layout evidence",
      canvas: "0".repeat(64), audio: "1".repeat(64), capturedAt: new Date().toISOString(), errors: "{}",
    };
    store.upsertProfile(sample);
  }
  for (const group of new Set(examples.map(example => example.group))) store.createGroup(group);
  const scriptCapability = randomBytes(32).toString("hex");
  const library = new ScriptLibrary(root);
  const fixtureScript = await library.save({ name: "验收示例 · 不执行", description: "仅用于隔离脚本库列表验收；此 fixture 禁止执行脚本。", language: "javascript", source: "// Isolated UI library fixture. Never executed.\nvoid 0;\n" });
  const sessionDirectory = join(paths.profiles, initial[0]!.id);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, "qa-session.bin"), "Synthetic UI acceptance session; no real login information.\n");

  // Fake launch rows exist only in this newly-created store. No process is spawned,
  // scanned, focused or killed; no WebSocket/CDP connection is ever attempted.
  function start(id: string) {
    const profile = store.getProfile(id);
    if (!profile) throw new Error("No such fixture profile");
    store.recordLaunch({
      profileId: id, engine: profile.engine ?? "chromium", pid: 0, debugPort: 0,
      ws: `ws://127.0.0.1:0/ui-qa/${id}`, startedAt: Date.now(),
      persona: structuredClone(profile),
    });
    return { port: 0, ws: `ws://127.0.0.1:0/ui-qa/${id}` };
  }
  start(initial[0]!.id);
  start(initial[1]!.id);
  let assertWritable = () => {};
  const launcher = {
    setWorkspaceMaintenanceGuard: (guard: () => void) => { assertWritable = guard; },
    start: async (id: string) => { assertWritable(); return start(id); },
    stop: async (id: string) => { store.clearLaunch(id); return true; },
    reconcileOrphans: async () => {},
    captureLocalSession: async () => false,
    certifiedActive: async (id: string) => !!store.getLaunch(id),
    cacheCleanupSettled: async () => {},
    profileDeletionBlocked: (id: string) => !!store.getLaunch(id),
    removeUserDataDir: () => true,
    bringToFront: async () => {},
    clearCache: async () => ({ cleared: 0 }),
    dataDriveFreeBytes: () => 120 * 1024 ** 3,
    prefetchFirefoxFontPacks: () => {},
  } as unknown as Launcher;

  // Real local extension and trash registries make secondary pages inspectable.
  // These inert manifests are fixture-owned and never loaded in a browser engine.
  for (const [id, name] of [["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "页面助手 · 验收示例"], ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Cookie 工具 · 验收示例"]]) {
    const loadDir = join(paths.extensions, id!);
    mkdirSync(loadDir, { recursive: true });
    writeFileSync(join(loadDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name, version: "1.0.0" }));
    store.addExtension({ id: id!, name: name!, loadDir });
  }
  const archived = { ...structuredClone(initial[6]!), id: "uiqatrash", name: "旧环境 · 归档示例" };
  store.upsertProfile(archived);
  store.trashProfile(archived.id);

  const health = {
    version: JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version as string,
    root, instance: randomBytes(32).toString("hex"),
  };
  // Browser GET fetches omit Origin. Use the real session authorization hook,
  // rather than treating an Origin/Referer as a credential or mocking the API.
  // A unique cookie name avoids replacing other loopback apps' session cookies.
  const workspaceSession = randomBytes(32).toString("hex");
  const workspaceCookieName = `maobu_ui_qa_${randomBytes(8).toString("hex")}`;
  const management = new WorkspaceManagement({ home: root, paths, store, launcher, authorizeSession(request) {
    const prefix = `${workspaceCookieName}=`;
    const supplied = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    const headers = new Headers();
    if (supplied) headers.set(STANDALONE_SESSION_HEADER, supplied);
    return isStandaloneRequestAuthorized(new Request(request.url, { headers }), workspaceSession);
  } });
  const options: UiRuntimeOptions = {
    paths, appConfig, health, workspaceManagement: management,
    // The test UI never scans real listeners. Only these synthetic endpoints reply.
    discoverLocalProxies: async ({ host = "127.0.0.1", ports = [] } = {}) => ({
      host, checkedAt: new Date().toISOString(), results: ports.map(port => host === "::1" && port === 18080
        ? { host, port, status: "listening", latencyMs: 1, socks5: "available", suggestions: [{ type: "socks5", evidence: "handshake" }] }
        : { host, port, status: "closed", latencyMs: null, socks5: "unknown", suggestions: [] }),
    }),
    runtimeInventory: { runtimeRoot: join(root, "runtimes"), platform: process.platform, arch: process.arch,
      chromiumDefault: process.platform === "darwin" && process.arch !== "arm64" ? "cloakbrowser" : "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed" },
    assistant: new LocalAssistantService({ transport: async (_endpoint, request) => {
      if (request.path === "/api/tags") return { models: [
        { name: "ui-qa-local:latest", size: 0, details: { parameter_size: "QA", quantization_level: "SIMULATED" } },
        { name: "ui-qa-remote:cloud", remote_host: "https://never-contacted.invalid", remote_model: "fixture" },
      ] };
      const input = request.body as { model?: string; messages?: Array<{ role: string; content: string }> };
      const prompt = input.messages?.filter(message => message.role === "user").at(-1)?.content ?? "";
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => { clearTimeout(timer); reject(new Error("UI fixture request cancelled")); };
        const timer = setTimeout(() => { request.signal?.removeEventListener("abort", cancelled); resolve(); }, /cancel|取消/i.test(prompt) ? 6000 : 350);
        if (request.signal?.aborted) cancelled(); else request.signal?.addEventListener("abort", cancelled, { once: true });
      });
      const content = prompt.includes("长回复验收")
        ? ["【长回复验收：起点】", ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 项：在独立工作区核对环境名称、分组、代理和设置，记录观察结果。`), "【长回复验收：终点】"].join("\n\n")
        : "【UI 验收模拟回复】\n\n这条回复由隔离测试夹具提供，没有连接真实模型。\n\n可将浏览器工作拆为：\n1. 明确目标环境和自有测试网站。\n2. 检查代理、时区和语言。\n3. 使用 MCP 客户端执行检查，并保存结果。\n\n真实应用会将你提交的消息发送给所选本机 Ollama 模型服务。";
      return { model: input.model, done: true, message: { role: "assistant", content }, prompt_eval_count: 12, eval_count: 48 };
    }, remote: {
      async listModels(connection) {
        if (connection.endpoint !== "https://ui-qa-model.example.com/v1" || connection.provider !== "openai-compatible" || connection.apiKey !== "synthetic-model-key") throw new Error("Unknown synthetic API connection");
        return ["ui-qa-api-chat", "ui-qa-api-small"];
      },
      async chat(connection, input) {
        if (connection.endpoint !== "https://ui-qa-model.example.com/v1" || connection.provider !== "openai-compatible" || connection.apiKey !== "synthetic-model-key" || input.model !== "ui-qa-api-chat") throw new Error("Unknown synthetic API connection");
        return { content: "【API 模型验收回复】已通过设置中保存的 API 服务收到本条消息。", promptTokens: 12, completionTokens: 24 };
      },
    } }),
    proxyCheck: async (proxy: ProxySpec) => ({
      status: "working", attempts: 3, successes: 3, ip: proxy.host,
      country: examples.find((row) => row.host === proxy.host)?.country ?? "US", rotating: false,
    }),
    // GeoIP's injected transport never uses the network, including for new/edited proxies.
    timezoneFetch: async () => ({ json: async () => ({
      status: "success", timezone: "Asia/Shanghai", countryCode: "CN", country_code: "CN",
      query: "192.0.2.1", ip: "192.0.2.1",
    }) }),
    extensionFetch: async () => { throw new Error("UI QA fixture is offline; use a local ZIP/CRX instead of downloading an extension."); },
    setCookies: async () => {},
  };

  // Let the production server build/serve its actual HTML, React, CSS, fonts and
  // brand assets. The outer loopback-only acceptance entry injects test hooks into
  // the real UI handlers; none of those hooks are added to production source.
  let production: ReturnType<typeof serveDashboard> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await server?.stop(true);
    await production?.stopScripts();
    await management.settled();
    await production?.stop(true);
    for (const launch of store.listLaunches()) store.clearLaunch(launch.profileId);
    store.close();
  }
  try {
    // The inner port must be as inert as the outer port, even for a local client
    // holding the fixture capability. Wrap only synchronous server construction;
    // no production source or long-lived global method is changed.
    const serve = Bun.serve;
    try {
      Bun.serve = new Proxy(serve, { apply(target, receiver, argumentsList) {
        const options = argumentsList[0], handler = options.fetch;
        return Reflect.apply(target, receiver, [{ ...options, fetch(request: Request, server: unknown) {
          const path = new URL(request.url).pathname;
          if (request.headers.has("upgrade") || path.startsWith("/api/") || path.startsWith("/ui/api/") && !scriptLibraryRequest(request) || request.method !== "GET" && !scriptLibraryRequest(request)) return executionDisabled();
          return handler(request, server);
        } }]);
      } });
      production = serveDashboard({ launcher, store, paths, appConfig, health, workspaceManagement: management, workspaceHome: root, agentNonce: scriptCapability, port: 0, log: () => {} });
    } finally { Bun.serve = serve; }
    const sourceOrigin = `http://127.0.0.1:${production.port}`;
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0, development: false,
      async fetch(request, runtime) {
        const boundary = rejectUntrustedLocalRequest(request, { port: runtime.port, requireHost: true, clientAddress: runtime.requestIP(request)?.address });
        if (boundary) return boundary;
        const url = new URL(request.url);
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return Response.json({ error: "Cross-origin fixture access is forbidden" }, { status: 403 });
        if (url.pathname === "/__qa/capture") return captureScreenshot(request, root);
        if (preview.runtimeDownloadProgress && url.pathname === "/ui/api/runtime-downloads" && request.method === "GET") {
          return Response.json({ downloads: syntheticRuntimeDownloads }, { headers: { "Cache-Control": "no-store", "X-Maobu-UI-QA": "simulated-runtime-downloads" } });
        }
        if (mockIntegration && (url.pathname === "/ui/api/settings/integrations" || url.pathname === "/ui/api/settings/integrations/probe") && request.headers.get("X-Maobu-Settings") !== "1") {
          return Response.json({ ok: false, error: "Local settings request header is required" }, { status: 403 });
        }
        if (mockIntegration && request.method === "GET" && url.pathname === "/ui/api/settings/integrations") {
          return Response.json({ ok: true, integration: mockIntegration }, { headers: { "Cache-Control": "no-store", "X-Maobu-UI-QA": "simulated-mcp-setup" } });
        }
        if (mockIntegration && request.method === "POST" && url.pathname === "/ui/api/settings/integrations/probe") {
          const tools = mockIntegration.tools.map(tool => tool.name);
          return Response.json({ ok: true, probe: { checkedAt: Date.now(), status: "connected", connectionVerified: true, message: "Isolated MCP handshake fixture; no process was started", toolCount: tools.length, tools, server: { name: "aliasmode", version: mockIntegration.version } } }, { headers: { "Cache-Control": "no-store", "X-Maobu-UI-QA": "simulated-mcp-probe" } });
        }
        if (/^\/ui\/api\/settings\/fingerprints\/[^/]+\/measure$/.test(url.pathname)) return Response.json({ ok: false, error: "Live fingerprint capture is disabled in the isolated UI fixture" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        if (request.method !== "GET" && /^\/ui\/api\/[^/]*runtime[^/]*(?:\/|$)/.test(url.pathname)) {
          return Response.json({ ok: false, error: "Runtime installation is disabled in the isolated UI fixture" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        if (url.pathname === "/ui/api/scripts" || url.pathname.startsWith("/ui/api/scripts/")) {
          // Only library operations and read-only status reach the real handlers.
          // A valid capability never grants execution or runtime-download access.
          if (!scriptLibraryRequest(request)) return executionDisabled();
          const headers = new Headers(request.headers);
          for (const name of ["host", "connection", "content-length", "transfer-encoding"]) headers.delete(name);
          if (origin) headers.set("origin", sourceOrigin);
          // Browser GETs usually carry Referer without Origin. Validate the
          // outside fixture context before mapping its port to the real server.
          const referer = request.headers.get("referer");
          if (referer !== null) {
            try { if (new URL(referer).origin !== url.origin) return Response.json({ error: "Cross-origin fixture access is forbidden" }, { status: 403 }); }
            catch { return Response.json({ error: "Invalid fixture request context" }, { status: 403 }); }
            headers.set("referer", `${sourceOrigin}/`);
          }
          const response = await fetch(`${sourceOrigin}${url.pathname}${url.search}`, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.arrayBuffer(), signal: request.signal, redirect: "error" });
          response.headers.set("X-Maobu-UI-QA", "isolated-script-library; execution-disabled");
          return response;
        }
        if (url.pathname.startsWith("/ui/api/")) {
          const response = await management.dispatch(request, async () => await handleUiRequest(request, launcher, store, options)
            ?? Response.json({ error: "Unknown isolated UI route" }, { status: 404 }));
          if (response) {
            response.headers.set("X-Maobu-UI-QA", "simulated-browser-lifecycle");
            return response;
          }
        }
        if (request.method !== "GET" || url.pathname.startsWith("/api/")) {
          return Response.json({ error: "Only the isolated UI is available in this fixture" }, { status: 404 });
        }
        // Only local production assets are forwarded; external URLs and the
        // compatibility API cannot cause an unexpected real browser operation.
        const response = await fetch(`${sourceOrigin}${url.pathname}${url.search}`, { signal: request.signal, redirect: "error" });
        if (url.pathname === "/" && response.ok) {
          const headers = new Headers(response.headers);
          headers.set("Cache-Control", "no-store");
          headers.append("Set-Cookie", `${workspaceCookieName}=${workspaceSession}; HttpOnly; SameSite=Strict; Path=/ui/api`);
          if (frameless) {
            for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(name);
            headers.set("X-Maobu-Frameless-QA", "simulated-window-controls");
            return new Response(framelessQaHtml(await response.text(), scriptCapability, preview.signedUpdate), { status: response.status, headers });
          }
          return new Response(response.body, { status: response.status, headers });
        }
        return response;
      },
    });
    return { root, url: `http://127.0.0.1:${server.port}`, productionOrigin: sourceOrigin, store, management, close, rows, scriptCapability, fixtureScriptId: fixtureScript.id, frameless, signedUpdate: !!preview.signedUpdate, runtimeDownloadProgress: !!preview.runtimeDownloadProgress, mcpConnection: !!mockIntegration, syncSnapshots: !!preview.syncSnapshots, windowControls: frameless ? "simulated" as const : "unavailable" as const };
  } catch (error) {
    await close();
    throw error;
  }
}

async function smoke(fixture: Awaited<ReturnType<typeof createUiQaFixture>>) {
  let capability = "";
  let sessionCookie = "";
  const request = (path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    if (sessionCookie && !headers.has("cookie")) headers.set("cookie", sessionCookie);
    if (capability && !headers.has("X-Maobu-Workspace-Capability")) headers.set("X-Maobu-Workspace-Capability", capability);
    if (/^\/ui\/api\/settings(?:\/|$)/.test(path)) headers.set("X-Maobu-Settings", "1");
    return fetch(fixture.url + path, { ...options, headers, signal: AbortSignal.timeout(10_000) });
  };
  const read = async (path: string) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const send = async (method: string, path: string, body: unknown = {}, expected = 200) => {
    const response = await request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, expected, `${path}: ${response.status === expected ? "" : await response.clone().text()}`);
    const result = await response.json();
    if (expected < 400) assert.notEqual(result.ok, false, path);
    return result;
  };
  const post = (path: string, body: unknown = {}, expected = 200) => send("POST", path, body, expected);
  const waitJob = async (id: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { job } = await read(`/ui/api/workspace/jobs/${id}`);
      if (["succeeded", "failed"].includes(job.status)) {
        assert.equal(job.status, "succeeded", JSON.stringify(job));
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Fixture workspace job ${id} timed out`);
  };
  const health = await read("/ui/api/health");
  assert.equal(health.root, fixture.root);
  assert.equal((await request("/ui/api/workspaces")).status, 401, "Workspace metadata requires a capability");
  assert.equal((await request("/ui/api/workspace/capability")).status, 401, "Capability bootstrap requires a fixture session");
  const browserContext = { referer: `${fixture.url}/`, "sec-fetch-site": "same-origin", accept: "application/json" };
  assert.equal((await request("/ui/api/workspace/capability", { headers: browserContext })).status, 401, "Same-origin browser headers do not replace a session");
  const bootstrap = await request("/");
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie");
  assert.match(cookie ?? "", /^maobu_ui_qa_[a-f0-9]{16}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/ui\/api$/);
  sessionCookie = cookie!.split(";")[0]!;
  await bootstrap.arrayBuffer();
  const browserBootstrap = await request("/ui/api/workspace/capability", { headers: browserContext });
  assert.equal(browserBootstrap.status, 200, "Browser GET without Origin must authorize its established session");
  capability = (await browserBootstrap.json()).token;
  assert.match(capability, /^[a-f0-9]{64}$/);
  assert.equal((await request("/ui/api/workspace/capability", { headers: { ...browserContext, cookie: "" } })).status, 401, "Missing session remains unauthorized");
  assert.equal((await request("/ui/api/workspace/capability", { headers: { ...browserContext, cookie: sessionCookie.replace(/=[a-f0-9]+$/, "=" + "0".repeat(64)) } })).status, 401, "Incorrect session remains unauthorized");
  const untrustedContexts: HeadersInit[] = [{ origin: "https://outside.invalid" }, { referer: "https://outside.invalid/" }, { referer: "invalid referer" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of untrustedContexts) {
    assert.equal((await request("/ui/api/workspace/capability", { headers })).status, 403, "A valid session never bypasses the production request boundary");
  }
  assert.equal((await request("/ui/api/workspaces", { headers: { "X-Maobu-Workspace-Capability": "0".repeat(64) } })).status, 401, "A browser session does not replace the workspace capability");
  const catalog = await read("/ui/api/workspaces");
  assert.equal(catalog.currentId, "default");
  assert.equal(catalog.activeId, "default");
  assert.equal(catalog.workspaces.length, 1);
  await send("PATCH", "/ui/api/workspaces/default", { name: "验收工作区", color: "#628ac7", icon: "globe" });
  const separate = (await post("/ui/api/workspaces", { name: "验收独立客户", icon: "briefcase", color: "#638f77" }, 201)).workspace;
  assert.match(separate.id, /^ws_[a-f0-9]{32}$/);
  await send("PATCH", `/ui/api/workspaces/${separate.id}`, { name: "验收独立客户 · 更新" });
  await post("/ui/api/workspaces", { name: "验收独立客户 · 更新" }, 400);
  await post(`/ui/api/workspaces/${separate.id}/archive`, { archived: true });
  await post(`/ui/api/workspaces/${separate.id}/activate`, {}, 404);
  await post(`/ui/api/workspaces/${separate.id}/archive`, { archived: false });
  await post("/ui/api/workspaces/default/archive", { archived: true }, 400);
  await post(`/ui/api/workspaces/${separate.id}/activate`, { closeRunning: false }, 423);
  assert.equal((await read("/ui/api/workspace/overview")).runningCount, 2);
  let roster = await read("/ui/api/profiles");
  assert.equal(roster.profiles.length, fixture.rows);
  assert.equal(roster.profiles.filter((profile: { running: boolean }) => profile.running).length, 2);
  const html = await request("/");
  assert.equal(html.status, 200);
  const sourceHtml = await html.text();
  assert(sourceHtml.includes("<title>猫步·千境</title>"));
  assert.equal(sourceHtml.includes("<script data-qa-frameless-bridge>"), fixture.frameless);
  if (fixture.frameless) {
    assert.equal(html.headers.get("X-Maobu-Frameless-QA"), "simulated-window-controls");
    assert(sourceHtml.indexOf("<script data-qa-frameless-bridge>") < sourceHtml.indexOf("<title>"));
    await smokeFramelessBridge(sourceHtml, fixture.scriptCapability, fixture.signedUpdate);
  }
  await post("/ui/api/profiles/uiqa0003/open");
  await post("/ui/api/profiles/uiqa0001/close");
  roster = await read("/ui/api/profiles");
  assert.equal(roster.profiles.find((profile: { id: string }) => profile.id === "uiqa0003").running, true);
  assert.equal(roster.profiles.find((profile: { id: string }) => profile.id === "uiqa0001").running, false);
  const created = await post("/ui/api/profiles", { name: "验收新建环境", group: "临时测试", engine: "chromium", chromiumRuntime: "aliasmode" });
  await post(`/ui/api/profiles/${created.id}/update`, { set: { name: "验收编辑环境", group: "国内运营", proxy: "192.0.2.99:8080", proxyType: "http" } });
  assert.equal((await read(`/ui/api/profiles/${created.id}`)).profile.name, "验收编辑环境");
  await post("/ui/api/proxy/check", { proxy: { type: "http", host: "192.0.2.99", port: "8080" } });
  await post("/ui/api/profiles/delete", { ids: [created.id] });
  assert((await read("/ui/api/trash")).profiles.some((profile: { id: string }) => profile.id === created.id));
  await post("/ui/api/trash/restore", { ids: [created.id] });
  assert.equal((await read("/ui/api/profiles")).profiles.length, fixture.rows + 1);
  assert.equal((await read("/ui/api/extensions")).extensions.length, 2);
  const groupDefaults = await read("/ui/api/groups/extensions");
  assert.deepEqual(groupDefaults.groups.map((group: { name: string }) => group.name).sort(), [...new Set(examples.map(example => example.group))].sort(), "All three fixture groups must be editable in extension defaults");
  assert.deepEqual((await read("/ui/api/runtime-downloads")).downloads, fixture.runtimeDownloadProgress ? syntheticRuntimeDownloads : []);
  if (fixture.mcpConnection) {
    const setup = await read("/ui/api/settings/integrations");
    assert.equal(setup.integration.status, "ready");
    const probe = await request("/ui/api/settings/integrations/probe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(probe.headers.get("X-Maobu-UI-QA"), "simulated-mcp-probe");
    assert.equal((await probe.json()).probe.toolCount, setup.integration.tools.length);
  }
  if (fixture.syncSnapshots) {
    const { files } = await read("/ui/api/settings/sync/files");
    assert.equal(files.length, 3);
    const reviewCounts = [];
    for (const file of files) {
      const review = await request("/ui/api/settings/sync/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: file.fileName, password: QA_SNAPSHOT_PASSWORD }) });
      assert.equal(review.status, 200);
      const { preview } = await review.json();
      assert.equal(preview.conflictCount, 1);
      reviewCounts.push(preview.newCount);
    }
    assert.deepEqual(reviewCounts.sort((a, b) => a - b), [0, 0, 1]);
  }
  const script = await request("/ui/api/scripts/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(script.status, 503, "The browser fixture must not execute scripts");
  assert.match(fixture.scriptCapability, /^[a-f0-9]{64}$/);
  assert.notEqual(fixture.scriptCapability, health.instance);
  assert.notEqual(fixture.scriptCapability, capability);
  const scriptRequest = (path: string, options: RequestInit = {}, token = fixture.scriptCapability) => {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("origin", fixture.url);
    if (options.body) headers.set("content-type", "application/json");
    return request(path, { ...options, headers });
  };
  assert.equal((await request("/ui/api/scripts")).status, 401, "Script source requires its own fixture capability");
  assert.equal((await scriptRequest("/ui/api/scripts", {}, "invalid-fixture-token")).status, 401);
  assert.equal((await request("/ui/api/scripts", { headers: { origin: "https://outside.invalid", authorization: `Bearer ${fixture.scriptCapability}` } })).status, 403);
  assert.equal((await request("/ui/api/scripts", { headers: { referer: `${fixture.url}/`, authorization: `Bearer ${fixture.scriptCapability}`, "sec-fetch-site": "same-origin" } })).status, 200, "Browser GET context maps only after same-origin validation");
  for (const referer of ["https://outside.invalid/", "not a valid URL"]) {
    assert.equal((await request("/ui/api/scripts", { headers: { referer, authorization: `Bearer ${fixture.scriptCapability}` } })).status, 403, "Foreign or malformed Referer is never rewritten into a trusted origin");
  }
  const scriptList = await scriptRequest("/ui/api/scripts");
  assert.equal(scriptList.status, 200);
  const library = await scriptList.json();
  assert.equal(library.scripts.length, 1);
  assert.equal(library.scripts[0].id, fixture.fixtureScriptId);
  assert.equal(library.scripts[0].source, undefined, "Library summaries do not expose source text");
  const scriptInput = { name: "脚本库 CRUD 验收", description: "保存在隔离库中，不执行。", language: "javascript", source: "void 0;\n" };
  const addedResponse = await scriptRequest("/ui/api/scripts", { method: "POST", body: JSON.stringify(scriptInput) });
  assert.equal(addedResponse.status, 200);
  const addedScript = (await addedResponse.json()).script;
  assert.equal(addedScript.revision, 1);
  const scriptPath = `/ui/api/scripts/${addedScript.id}`;
  assert.equal((await (await scriptRequest(scriptPath)).json()).script.source, scriptInput.source);
  const editedResponse = await scriptRequest(scriptPath, { method: "PATCH", body: JSON.stringify({ ...scriptInput, name: "脚本库 CRUD · 已编辑", expectedRevision: addedScript.revision }) });
  assert.equal(editedResponse.status, 200, editedResponse.status === 200 ? undefined : await editedResponse.clone().text());
  const editedScript = (await editedResponse.json()).script;
  assert.equal(editedScript.revision, 2);
  assert.equal(editedScript.name, "脚本库 CRUD · 已编辑");
  assert.equal((await scriptRequest(scriptPath, { method: "DELETE", body: JSON.stringify({ expectedRevision: editedScript.revision }) })).status, 200);
  assert.equal((await scriptRequest(scriptPath)).status, 404);
  const runStatus = await scriptRequest("/ui/api/scripts/run");
  assert.equal(runStatus.status, 200);
  assert.equal((await runStatus.json()).run, null);
  assert.equal((await scriptRequest("/ui/api/scripts/python-runtime")).status, 200);
  for (const path of ["/ui/api/scripts/run", "/ui/api/scripts/stop", "/ui/api/scripts/python-runtime", "/ui/api/runtime/install", "/ui/api/runtimes/python/install"]) {
    const blocked = await scriptRequest(path, { method: "POST", body: JSON.stringify({ scriptId: fixture.fixtureScriptId, profileIds: ["uiqa0001"], inputs: {}, useCredentials: false }) });
    assert.equal(blocked.status, 503, `${path} must remain disabled even with a valid script capability`);
    const innerBlocked = await fetch(fixture.productionOrigin + path, { method: "POST", headers: { authorization: `Bearer ${fixture.scriptCapability}`, "content-type": "application/json" }, body: JSON.stringify({ scriptId: fixture.fixtureScriptId, profileIds: ["uiqa0001"], inputs: {}, useCredentials: false }), signal: AbortSignal.timeout(10_000) });
    assert.equal(innerBlocked.status, 503, `The internal production port must also block ${path}`);
  }
  assert.equal((await (await scriptRequest("/ui/api/scripts/run")).json()).run, null, "Blocked actions must not create a script run");
  assert.equal(JSON.parse(readFileSync(join(fixture.root, "custom-scripts", "local.json"), "utf8")).length, 1);

  // Use real close routes, maintenance checks, snapshot/archive handlers and the
  // capability-protected download. No native restart or browser process is faked.
  for (const profile of (await read("/ui/api/profiles")).profiles) {
    if (profile.running) await post(`/ui/api/profiles/${profile.id}/close`);
  }
  assert.equal((await read("/ui/api/workspace/overview")).runningCount, 0);
  const backupPassword = "isolated-ui-qa-backup-password";
  const backup = await waitJob((await post("/ui/api/workspace/backups", { password: backupPassword }, 202)).job.id);
  const records = (await read("/ui/api/workspace/backups")).backups;
  assert.equal(records.length, 1);
  assert.equal(records[0].path, undefined, "API must not expose arbitrary local backup paths");
  assert.equal(records[0].id, backup.result.backupId);
  assert.equal(records[0].encrypted, true);
  const download = await request(`/ui/api/workspace/backups/${records[0].id}/download`);
  assert.equal(download.status, 200);
  const archive = Buffer.from(await download.arrayBuffer());
  const sha256 = createHash("sha256").update(archive).digest("hex");
  assert.equal(download.headers.get("X-Backup-SHA256"), sha256);
  assert.equal(records[0].sha256, sha256);
  assert.equal(Number(download.headers.get("Content-Length")), archive.length);
  const restored = await waitJob((await post("/ui/api/workspace/restore", { backupId: records[0].id, name: "验收恢复副本", password: backupPassword }, 202)).job.id);
  const restoredId = restored.result.workspaceId;
  assert.match(restoredId, /^ws_[a-f0-9]{32}$/);
  const restoredRoot = fixture.management.catalog.pathFor(restoredId);
  const restoredStore = new ProfileStore(join(restoredRoot, "profiles.sqlite"));
  try {
    assert.equal(restoredStore.count(), fixture.rows + 1);
    assert.equal(restoredStore.getProfile(created.id)?.name, "验收编辑环境");
    assert.equal(restoredStore.listLaunches().length, 0);
    for (const extension of restoredStore.listExtensions()) assert(extension.loadDir.startsWith(join(restoredRoot, "extensions")));
  } finally { restoredStore.close(); }
  assert.equal(readFileSync(join(restoredRoot, "profiles", "uiqa0001", "qa-session.bin"), "utf8"), readFileSync(join(fixture.root, "profiles", "uiqa0001", "qa-session.bin"), "utf8"));
  assert.equal(fixture.store.count(), fixture.rows + 1);
  assert.equal((await read("/ui/api/workspaces")).currentId, "default");
  const activation = await post(`/ui/api/workspaces/${separate.id}/activate`, {});
  assert.equal(activation.restartRequired, true);
  assert.equal((await read("/ui/api/workspaces")).activeId, separate.id);
  await post("/ui/api/workspaces/activation/cancel");
  assert.equal((await read("/ui/api/workspaces")).activeId, "default");
  const savedCatalog = JSON.parse(readFileSync(join(fixture.root, "desktop-workspaces.json"), "utf8"));
  assert.equal(savedCatalog.workspaces.find((item: { id: string }) => item.id === "default").name, "验收工作区");

  const capture = await request("/__qa/capture");
  assert.equal(capture.status, 200);
  const formHtml = await capture.text();
  for (const text of ['aria-label="截图数据"', 'aria-label="截图名称"', 'value="workbench"', "保存截图"]) assert(formHtml.includes(text));
  const saveCapture = (name: string, image: string, origin: string | null = fixture.url) => {
    const body = new FormData(); body.set("name", name); body.set("image", image);
    return request("/__qa/capture", { method: "POST", headers: origin ? { origin } : {}, body });
  };
  // Header-shaped fixture bytes test the route's JPEG marker contract; this is
  // deliberately not presented as an actual application screenshot.
  const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const encoded = jpeg.toString("base64");
  assert.equal((await saveCapture("missing-origin", encoded, null)).status, 403);
  assert.equal((await saveCapture("foreign-origin", encoded, "https://outside.invalid")).status, 403);
  const outside = resolve(fixture.root, "..", "outside-capture.jpg");
  const outsideExisted = existsSync(outside);
  for (const name of ["../outside-capture", "a/b", "a\\b", "..", "a".repeat(51)]) assert.equal((await saveCapture(name, encoded)).status, 400);
  assert.equal(existsSync(outside), outsideExisted, "Capture must not write outside its fixture root");
  assert.equal((await saveCapture("bad-base64", "not base64")).status, 400);
  assert.equal((await saveCapture("not-jpeg", Buffer.from("PNG").toString("base64"))).status, 400);
  const tooLarge = Buffer.alloc(MAX_CAPTURE_BYTES + 1);
  tooLarge.set([0xff, 0xd8, 0xff]); tooLarge.set([0xff, 0xd9], tooLarge.length - 2);
  assert.equal((await saveCapture("too-large", tooLarge.toString("base64"))).status, 413);
  const saved = await saveCapture("smoke-capture", encoded);
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.ok, true);
  assert.equal(result.path, join(fixture.root, "smoke-capture.jpg"));
  assert.deepEqual(readFileSync(result.path), jpeg);
  assert.equal((await saveCapture("smoke-capture", encoded)).status, 409, "Existing files must not be overwritten");
}

if (import.meta.main) {
  const rowIndex = process.argv.indexOf("--rows");
  const fixture = await createUiQaFixture(rowIndex < 0 ? 8 : Number(process.argv[rowIndex + 1]), { frameless: process.argv.includes("--frameless"), fingerprintEvidence: process.argv.includes("--fingerprint-evidence"), signedUpdate: process.argv.includes("--signed-update"), runtimeDownloadProgress: process.argv.includes("--runtime-download-progress"), mcpConnection: process.argv.includes("--mcp-connection"), syncSnapshots: process.argv.includes("--sync-snapshots") });
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(JSON.stringify({ fixture: "isolated-ui-qa", url: fixture.url, root: fixture.root, rows: fixture.rows, running: 2, browserLifecycle: "simulated", proxyChecks: "simulated", proxyDiscovery: "simulated; [::1]:18080 is the only fixture listener", signedUpdates: fixture.signedUpdate ? "simulated check; install disabled" : "disabled", scripts: "isolated library CRUD enabled; execution and runtime installation disabled", runtimeDownloads: fixture.runtimeDownloadProgress ? "simulated transfer progress; no downloads" : "idle", mcpConnection: fixture.mcpConnection ? "simulated setup and handshake; no helper process" : "setup info only", syncSnapshots: fixture.syncSnapshots ? "three encrypted files with synthetic profiles" : "disabled", frameless: fixture.frameless, windowControls: fixture.windowControls, externalResources: "simulated", fingerprintMeasurements: process.argv.includes("--fingerprint-evidence") ? "synthetic layout observations without local provenance" : "not sampled" }));
  if (process.argv.includes("--smoke")) {
    try {
      await smoke(fixture);
      console.log("UI QA smoke passed: production HTML, isolated data, script capability/library CRUD and group defaults, execution/runtime rejection, lifecycle, workspace catalog, real backup/download SHA/restore, proxy, trash, capture validation and no engine downloads.");
    } finally {
      await fixture.close();
    }
  }
}
