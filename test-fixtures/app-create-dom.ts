import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLElement } from "happy-dom";
import type { ProfileTemplateCatalog } from "../web/profile-templates-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function run(scenario: string) {
  const fromProxy = scenario === "local-proxy-draft";
  const quickWorkspace = scenario === "workspace-quick-switch";
  const fromReuse = scenario.startsWith("reuse-");
  const recoveringLaunch = scenario === "launch-recovery";
  const forcedRuntime = scenario === "forced-host-auto" || scenario === "reuse-host-override";
  const sourceId = "reuse_source", sourceName = "Reusable source";
  const safeSource = { sourceId, name: sourceName, group: "QA", engine: "chromium", chromiumRuntime: "cloakbrowser", platformOs: "windows", screen: "1680x1050", platform: "example.com" };
  const reuseReads: Array<{ response: ReturnType<typeof deferred<Response>>; signal: AbortSignal | null | undefined }> = [];
  const currentWorkspace = { id: "default", name: "Inert fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const targetWorkspace = { ...currentWorkspace, id: `ws_${"d".repeat(32)}`, name: "Inert second workspace", color: "#638f77", icon: "folder" };
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const creations: Array<{ input: Record<string, unknown>; response: ReturnType<typeof deferred<Response>> }> = [];
  const launches: Array<{ id: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const templateWrites: Array<Record<string, any>> = [];
  const templateId = "tpl_" + "a".repeat(32);
  let templates: ProfileTemplateCatalog = { version: 1, revision: 0, templates: scenario === "forced-host-auto" ? [{ id: templateId, name: "Automatic desktop", settings: { engine: "chromium", chromiumRuntime: "", platformOs: "", screen: "", platform: "" }, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" }] : [] };
  const delayedRoster = deferred<Response>();
  let holdRoster = false, rosterWaiting = false;
  const roster = { ok: true, profiles: fromReuse ? [{ id: sourceId, name: sourceName, engine: "chromium", chromiumRuntime: "cloakbrowser", group: "QA", platform: "example.com", tags: ["source-only"], proxy: "http://private-proxy.invalid:8080", timezone: "UTC", cookieCount: 8, seeded: true, screen: "1680x1050", has2fa: true, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "source-no", running: false }] as Record<string, unknown>[] : [], groups: fromReuse ? ["QA"] : [], folders: fromReuse ? [{ name: "QA" }] : [] };
  if (recoveringLaunch) roster.profiles = [
    { id: "fixture_engine", name: "Engine fixture", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, running: false },
    { id: "fixture_proxy", name: "Proxy fixture", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], proxy: "http://proxy.invalid:8080", timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 2, running: false },
  ];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    requests.push({ path, method });
    if (!path.startsWith("/ui/api/")) { unexpected.push(path); throw new Error(`Non-fixture request blocked: ${path}`); }
    if (fromReuse && path === `/ui/api/profiles/${sourceId}/reuse` && method === "GET") {
      const response = deferred<Response>(); reuseReads.push({ response, signal: options?.signal }); return response.promise;
    }
    if (path === "/ui/api/profiles" && method === "POST") {
      const response = deferred<Response>(); creations.push({ input: JSON.parse(String(options?.body)), response }); return response.promise;
    }
    if (path === "/ui/api/profiles" && method === "GET") {
      if (holdRoster) { rosterWaiting = true; return delayedRoster.promise; }
      return json(roster);
    }
    if (recoveringLaunch && method === "POST") {
      const route = /^\/ui\/api\/profiles\/(fixture_engine|fixture_proxy)\/open$/.exec(path);
      if (route) {
        const response = deferred<Response>(); launches.push({ id: route[1]!, response }); return response.promise;
      }
      if (path === "/ui/api/profiles/fixture_engine/close") {
        roster.profiles[0]!.running = false;
        return json({ ok: true, warning: "Browser teardown completed with a warning" });
      }
    }
    if (recoveringLaunch && method === "GET" && path === "/ui/api/profiles/fixture_proxy") return json({ ok: true, profile: {
      ...roster.profiles[1], username: "", password: "", email: "", emailPassword: "", twofa: "", tags: "", proxyType: "http", resolution: "1920x1080", platformOs: "windows", extensions: [],
    } });
    if (recoveringLaunch && method === "GET" && path === "/ui/api/profiles/fixture_proxy/totp") return json({ ok: true, code: null });
    if (fromProxy && path === "/ui/api/settings/network/discover" && method === "POST") {
      const { host, ports } = JSON.parse(String(options?.body));
      assert.deepEqual(ports, [18080]);
      assert.ok(host === "::1" || host === "127.0.0.1");
      const row = host === "::1" ? { socks5: "authentication_required", suggestions: [{ type: "socks5", evidence: "handshake" }] }
        : { socks5: "unknown", suggestions: [{ type: "http", evidence: "port_hint" }, { type: "socks5", evidence: "port_hint" }] };
      return json({ ok: true, discovery: { host, checkedAt: "2026-11-09T00:00:00.000Z", results: [{ host, port: 18080, status: "listening", latencyMs: 1, ...row }] } });
    }
    if (path === "/ui/api/settings/templates" && method === "POST") {
      const body = JSON.parse(String(options?.body)); templateWrites.push(body);
      assert.equal(body.revision, templates.revision); assert.equal(body.id, undefined);
      assert.deepEqual(Object.keys(body.settings).sort(), ["chromiumRuntime", "engine", "platform", "platformOs", "screen"]);
      templates = { ...templates, revision: templates.revision + 1, templates: [...templates.templates, { id: "tpl_" + "b".repeat(32), name: body.name, settings: body.settings, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" }] };
      return json({ ok: true, catalog: templates });
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode", ...(forcedRuntime ? { chromiumRuntime: "aliasmode" } : {}) },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-fixture-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: currentWorkspace.id, activeId: currentWorkspace.id, workspaces: quickWorkspace ? [currentWorkspace, targetWorkspace] : [currentWorkspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: currentWorkspace.id, root: "inert-fixture-root", profileCount: roster.profiles.length, trashCount: 0, runningCount: quickWorkspace ? 2 : 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
      "/ui/api/settings/templates": { ok: true, catalog: templates },
      ...(scenario === "settings-navigation" || fromProxy ? {
        "/ui/api/settings": { ok: true, settings: { version: 1, updates: { repository: "", channel: "stable", checkOnStartup: false }, sync: { enabled: false, folder: "", retainSnapshots: 10 }, network: { checkLocalProxyBeforeLaunch: false } } },
        "/ui/api/settings/fingerprints": { ok: true, reports: [] },
      } : {}),
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  const previousGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  if (quickWorkspace) {
    dom.window.localStorage.setItem("aliasmode.shell.sidebarCollapsed", "1");
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  }
  dom.container.id = "root";
  // Cover any accidental window.fetch use as well as the usual global fetch.
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => {
    unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled in this fixture");
  } });
  let appRoot: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  // Run the actual bootstrap and renderer, only retaining the root for cleanup.
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) {
    const value = createRealRoot(...args); appRoot = value; return value;
  } }));
  const allButtons = () => Array.from(dom.container.querySelectorAll<HTMLButtonElement>("button"));
  const newButton = () => allButtons().find(item => item.textContent?.trim() === "New Profile");
  const dialog = () => [...dom.container.querySelectorAll<HTMLElement>('[role="dialog"][aria-labelledby="create-profile-title"]')]
    .find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const button = (node: HTMLElement, label: string) => { const found = [...node.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label); assert.ok(found, `Missing ${label}`); return found; };
  const confirmDiscard = async () => {
    const confirmation = [...dom.window.document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]'));
    assert.ok(confirmation, "Closing this edited creation draft must ask before discarding");
    await act(async () => button(confirmation, "Discard changes").click());
  };
  const nameInput = () => {
    const label = [...dialog()!.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent?.trim() === "Name");
    const input = label?.querySelector<HTMLInputElement>("input"); assert.ok(input, "Name field must have a label"); return input;
  };
  const type = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const typeName = (value: string) => type(nameInput(), value);
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 2500;
    while (!condition() && Date.now() < deadline) await dom.flush();
    assert.ok(condition(), `${message}; requested=${JSON.stringify(requests)}`);
  };
  const attemptClose = async () => act(async () => {
    const active = dialog()!;
    const close = active.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    assert.equal(close.disabled, true); assert.equal(button(active, "Cancel").disabled, true);
    close.click(); button(active, "Cancel").click();
    active.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    active.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => !!newButton(), "Actual App bootstrap did not reach the roster");
    assert.ok(appRoot, "The actual bootstrap must create a React root");
    assert.deepEqual(unexpected, []); assert.equal(creations.length, 0);
    if (recoveringLaunch) {
      const row = (id: string) => dom.container.querySelector<HTMLElement>(`tr[data-profile-id="${id}"]`);
      const errorFor = (id: string) => dom.container.querySelector<HTMLElement>(`#profile-launch-failure-${id}`);
      const start = (id: string) => row(id)?.querySelector<HTMLButtonElement>(".row-start");
      await waitFor(() => !!start("fixture_engine") && !!start("fixture_proxy"), "The fixture environments must load");
      await act(async () => { start("fixture_engine")!.click(); start("fixture_engine")!.click(); start("fixture_proxy")!.click(); });
      assert.deepEqual(launches.map(item => item.id), ["fixture_engine", "fixture_proxy"], "Repeated activation must not send a duplicate launch");
      const download = "Chromium could not be downloaded. Check your internet connection, then open the profile again.";
      const proxy = "The configured local proxy is not listening or did not respond in time. Open your desktop proxy client, enable its local port, then retry.";
      await act(async () => { launches[0]!.response.resolve(json({ ok: false, error: download }, 500)); launches[1]!.response.resolve(json({ ok: false, error: proxy }, 500)); });
      await waitFor(() => !!errorFor("fixture_engine") && !!errorFor("fixture_proxy"), "Both failures must stay beside their own environments");
      assert.ok(errorFor("fixture_engine")!.textContent.includes(download));
      assert.ok(errorFor("fixture_proxy")!.textContent.includes(proxy));
      assert.equal(start("fixture_engine")!.getAttribute("aria-label"), "Retry download for Engine fixture");
      assert.equal(start("fixture_proxy")!.getAttribute("aria-describedby"), "profile-launch-failure-fixture_proxy");
      const proxyRecovery = dom.container.querySelector<HTMLButtonElement>("#profile-launch-failure-fixture_proxy + button");
      assert.equal(proxyRecovery?.textContent, "Review proxy settings");
      await act(async () => { proxyRecovery!.click(); });
      await waitFor(() => !!dom.container.querySelector('[role="dialog"][aria-labelledby="edit-profile-title"]'), "Proxy recovery must open the same environment editor");
      assert.ok(requests.some(request => request.method === "GET" && request.path === "/ui/api/profiles/fixture_proxy"));
      const proxyEditor = dom.container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="edit-profile-title"]')!;
      await act(async () => { button(proxyEditor, "Cancel").click(); });
      await act(async () => { start("fixture_engine")!.click(); });
      assert.deepEqual(launches.map(item => item.id), ["fixture_engine", "fixture_proxy", "fixture_engine"]);
      assert.ok(start("fixture_engine")!.disabled);
      roster.profiles[0]!.running = true;
      await act(async () => { launches[2]!.response.resolve(json({ ok: true })); });
      await waitFor(() => !errorFor("fixture_engine") && !!row("fixture_engine")?.querySelector(".row-stop"), "Successful retry must clear the matching failure");
      assert.ok(errorFor("fixture_proxy")!.textContent.includes(proxy), "Retrying one environment must not clear another environment's failure");
      const dismiss = dom.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss start failure for Proxy fixture"]')!;
      await act(async () => { dismiss.click(); });
      assert.equal(errorFor("fixture_proxy"), null);
      assert.equal(dom.window.document.activeElement, start("fixture_proxy"));
      await act(async () => { row("fixture_engine")!.querySelector<HTMLButtonElement>(".row-stop")!.click(); });
      const actionAlert = () => dom.container.querySelector<HTMLElement>('.error[role="alert"] span');
      await waitFor(() => actionAlert()?.textContent === "Browser teardown completed with a warning", "Stop warnings must retain their text without being treated as a failed start");
      assert.equal(errorFor("fixture_engine"), null);
      assert.deepEqual(unexpected, []);
      return;
    }
    if (fromReuse) {
      const banner = () => dom.container.querySelector<HTMLElement>('.profiles-workspace [aria-busy="true"]');
      const note = () => dialog()?.querySelector<HTMLElement>('[role="note"][aria-label="Reused configuration"]');
      const startReuse = async () => {
        const trigger = dom.container.querySelector<HTMLButtonElement>(`tr[data-profile-id="${sourceId}"] .profile-menu-trigger`);
        assert.ok(trigger, "The source row must expose its action menu");
        await act(async () => { trigger.click(); });
        const menu = dom.window.document.querySelector<HTMLElement>(`[role="menu"][aria-label="Actions for ${sourceName}"]`);
        assert.ok(menu);
        await act(async () => { button(menu, "Create from this configuration").click(); });
        await waitFor(() => !!banner(), "Reading the safe source must expose progress");
        assert.equal(dialog(), null); assert.equal(creations.length, 0);
      };
      await startReuse();
      assert.equal(reuseReads.length, 1);
      if (scenario === "reuse-late") {
        await act(async () => { newButton()!.click(); });
        await typeName("Manual draft wins");
        assert.equal(reuseReads[0]!.signal?.aborted, true, "Opening another draft must cancel the read");
        await act(async () => { reuseReads[0]!.response.resolve(json({ ok: true, profile: safeSource })); });
        assert.equal(nameInput().value, "Manual draft wins"); assert.equal(note(), null);
        await act(async () => { button(dialog()!, "Cancel").click(); });
        await confirmDiscard();
        await startReuse();
        const proxyNav = allButtons().find(item => item.classList.contains("navitem") && item.textContent?.trim() === "Proxies");
        assert.ok(proxyNav); await act(async () => { proxyNav.click(); });
        assert.equal(reuseReads[1]!.signal?.aborted, true, "Leaving the roster must cancel the source read");
        await act(async () => { reuseReads[1]!.response.resolve(json({ ok: true, profile: safeSource })); });
        assert.equal(dialog(), null); assert.equal(creations.length, 0); assert.deepEqual(unexpected, []);
        return;
      }
      if (scenario === "reuse-failure") {
        await act(async () => { reuseReads[0]!.response.resolve(json({ ok: false, code: "not-found", error: "Source secret must never be shown" }, 404)); });
        const alert = dom.container.querySelector<HTMLElement>('.profiles-workspace [role="alert"]');
        assert.ok(alert?.textContent.includes("The source environment no longer exists."));
        assert.ok(!alert?.textContent.includes("Source secret"));
        assert.equal(dialog(), null); assert.equal(creations.length, 0);
        await act(async () => { button(alert!, "Retry").click(); });
        assert.equal(reuseReads.length, 2); assert.ok(banner());
      }
      await act(async () => { reuseReads.at(-1)!.response.resolve(json({ ok: true, profile: safeSource })); });
      await waitFor(() => !!dialog(), "The safe source must prepare a draft");
      assert.equal(nameInput().value, `${sourceName} copy`);
      assert.ok(note()?.textContent.includes("Account details, proxy settings, cookies and the original fingerprint identity were not copied."));
      assert.ok(!dialog()?.textContent.includes("source-only"));
      const field = (label: string) => [...dialog()!.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent?.trim() === label)?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
      for (const label of ["Host", "Port", "Proxy user", "Proxy pass", "Custom NO."]) assert.equal(field(label)?.value, "", `${label} must start empty`);
      assert.equal(field("Screen")?.value, safeSource.screen);
      assert.equal(field("Operating system")?.value, safeSource.platformOs);
      if (scenario === "reuse-host-override") {
        assert.ok(note()?.textContent.includes("This computer requires AliasMode Chromium. The source uses CloakBrowser; the new environment will use AliasMode Chromium."));
        assert.ok(note()?.classList.contains("warning"));
      } else assert.equal(field("Chrome version")?.value, "", "The source runtime must be preserved despite a different computer default");
      assert.equal(creations.length, 0, "Preparing a draft must never create a profile");
      await act(async () => { button(dialog()!, "Create profile").click(); });
      assert.equal(creations.length, 1);
      assert.deepEqual(creations[0]!.input, {
        name: `${sourceName} copy`, engine: "chromium", chromiumRuntime: scenario === "reuse-host-override" ? "aliasmode" : "cloakbrowser",
        group: "QA", platform: "example.com", screen: "1680x1050", platformOs: "windows", customNo: "",
        username: "", password: "", email: "", emailPassword: "", twofa: "", proxy: null,
      }, "Only the allowlisted setup may enter the ordinary creation request");
      await act(async () => { creations[0]!.response.resolve(json({ ok: true, id: "created_reuse_fixture" })); });
      await waitFor(() => !dialog(), "Explicit creation must close the completed draft");
      await act(async () => { newButton()!.click(); });
      assert.equal(nameInput().value, ""); assert.equal(note(), null, "A later draft must not retain source metadata");
      await act(async () => { button(dialog()!, "Cancel").click(); });
      assert.equal(dialog(), null); assert.deepEqual(unexpected, []);
      assert.equal(requests.filter(item => item.path === `/ui/api/profiles/${sourceId}`).length, 0, "Reusing setup must not read account detail");
      return;
    }
    if (quickWorkspace) {
      const selector = `.sidebar.collapsed button.wm-workspace-trigger.is-rail[aria-label="Switch workspace: ${currentWorkspace.name}"]`;
      await waitFor(() => !!dom.container.querySelector(selector), "The collapsed sidebar must expose its current workspace and switcher");
      const trigger = dom.container.querySelector<HTMLButtonElement>(selector)!;
      const menu = () => [...dom.window.document.querySelectorAll<HTMLElement>('.wm-switcher-popover.is-rail[role="menu"]')].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
      const confirm = () => [...dom.window.document.querySelectorAll<HTMLElement>('[role="dialog"][aria-labelledby="wm-confirm-title"]')].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
      const key = (element: HTMLElement, value: string) => act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })); });
      trigger.focus();
      await key(trigger, "ArrowDown");
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      assert.equal(trigger.getAttribute("aria-controls"), menu()?.id);
      assert.equal(menu()?.getAttribute("data-placement"), "right");
      const current = menu()?.querySelector<HTMLButtonElement>('button[role="menuitemradio"][aria-checked="true"]');
      const target = menu()?.querySelector<HTMLButtonElement>('button[role="menuitemradio"][aria-checked="false"]');
      assert.ok(current && current.textContent.includes(currentWorkspace.name));
      assert.ok(target && target.textContent.includes(targetWorkspace.name));
      assert.equal(dom.window.document.activeElement, current);
      await key(current, "ArrowDown");
      assert.equal(dom.window.document.activeElement, target);
      await key(target, "Escape");
      assert.equal(menu(), null);
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(dom.window.document.activeElement, trigger);
      await act(async () => { trigger.click(); });
      await act(async () => { menu()!.querySelector<HTMLButtonElement>('button[role="menuitemradio"][aria-checked="false"]')!.click(); });
      await waitFor(() => !!confirm()?.textContent.includes("2 browser(s) are running"), "The existing confirmation must check the running workspace");
      const confirmation = confirm();
      assert.ok(confirmation);
      assert.equal(menu(), null);
      assert.equal(confirmation.querySelector("h2")?.textContent, "Switch workspace?");
      assert.ok(confirmation.textContent.includes(`Switch to ${targetWorkspace.name} and restart the desktop app.`));
      assert.ok(confirmation.textContent.includes("Switching workspaces requires the desktop app."));
      const consent = confirmation.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(consent);
      assert.equal(consent.checked, false);
      assert.equal(button(confirmation, "Switch and restart").disabled, true);
      await act(async () => { consent.click(); });
      assert.equal(consent.checked, true);
      assert.equal(button(confirmation, "Switch and restart").disabled, true, "Consent cannot enable restart without a desktop bridge");
      const ipcCalls: string[] = [];
      const invoke = async (command: string) => {
        ipcCalls.push(command);
        throw new Error(`Unexpected native command: ${command}`);
      };
      Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
      try {
        await act(async () => { consent.click(); });
        assert.equal(consent.checked, false);
        assert.equal(button(confirmation, "Switch and restart").disabled, true, "The desktop bridge still requires consent to close running sessions");
        await act(async () => { consent.click(); });
        assert.equal(button(confirmation, "Switch and restart").disabled, false);
        await act(async () => { button(confirmation, "Cancel").click(); });
      } finally { Reflect.deleteProperty(dom.window, "__TAURI_INTERNALS__"); }
      assert.equal(confirm(), null);
      assert.equal(dom.container.querySelector(selector), trigger, "Cancel must preserve the original workspace identity in the rail");
      assert.deepEqual(ipcCalls, [], "No native command should run before confirmation");
      assert.deepEqual(unexpected, []);
      assert.ok(requests.every(item => item.method === "GET"), "Selecting and cancelling must not activate a workspace or write preferences");
      return;
    }
    if (fromProxy) {
      const settings = allButtons().find(item => item.classList.contains("navitem") && item.textContent?.trim() === "Settings");
      assert.ok(settings); await act(async () => { settings.click(); });
      const network = dom.container.querySelector<HTMLButtonElement>("#settings-tab-network")!;
      await act(async () => { network.click(); });
      const panel = dom.container.querySelector<HTMLElement>("#settings-panel")!;
      const discoveryForm = panel.querySelector("form")!;
      const hostChoice = discoveryForm.querySelector<HTMLSelectElement>("select")!;
      const selectHost = (host: string) => act(async () => { hostChoice.value = host; hostChoice.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      const find = () => act(async () => { button(panel, "Discover local proxies").click(); });
      const action = (label: string) => [...panel.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label);
      const label = <T extends HTMLElement>(source: string, selector: string) => {
        const value = [...dialog()!.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent?.trim() === source)?.querySelector<T>(selector);
        assert.ok(value, `Missing ${source}`); return value;
      };
      const value = (source: string) => label<HTMLInputElement>(source, "input").value;
      await selectHost("::1");
      await type(discoveryForm.querySelector<HTMLInputElement>("input[type=text]")!, "18080");
      await find();
      const socksActionLabel = "Use SOCKS5 proxy at [::1]:18080 in a new profile";
      await waitFor(() => !!action(socksActionLabel), "IPv6 discovery did not expose its create action");
      const entry = action(socksActionLabel)!;
      await act(async () => { entry.click(); });
      assert.ok(dialog()?.querySelector("details[open] .local-proxy-draft-note")?.textContent?.includes("SOCKS5 requires authentication."));
      assert.equal(label<HTMLSelectElement>("Proxy type", "select").value, "socks5");
      assert.deepEqual([value("Host"), value("Port"), value("Proxy user"), value("Proxy pass")], ["::1", "18080", "", ""]);
      assert.equal(dialog()?.querySelector(".profile-editor-proxy-summary")?.textContent, "[::1]:18080");
      await typeName("Keep this existing draft");
      await act(async () => { entry.click(); });
      assert.equal(nameInput().value, "Keep this existing draft", "Another discovery activation must not reset an open form");
      await type(label<HTMLInputElement>("Port", "input"), "18082");
      assert.equal(dialog()?.querySelector(".local-proxy-draft-note"), null, "Changing the endpoint must clear discovery evidence");
      await act(async () => { button(dialog()!, "Cancel").click(); });
      await confirmDiscard();
      assert.equal(dialog(), null); assert.equal(dom.window.document.activeElement, entry); assert.equal(network.getAttribute("aria-selected"), "true");
      assert.equal(creations.length, 0);
      await selectHost("127.0.0.1"); await find();
      const httpActionLabel = "Use HTTP proxy at 127.0.0.1:18080 in a new profile";
      await waitFor(() => !!action(httpActionLabel), "IPv4 discovery did not expose its create action");
      await act(async () => { action(httpActionLabel)!.click(); });
      assert.ok(dialog()?.querySelector(".local-proxy-draft-note")?.textContent?.includes("A local listener was found."));
      assert.equal(label<HTMLSelectElement>("Proxy type", "select").value, "http");
      assert.deepEqual([value("Host"), value("Port"), value("Proxy user"), value("Proxy pass"), nameInput().value], ["127.0.0.1", "18080", "", "", ""]);
      assert.equal(creations.length, 0);
      await typeName("Explicit test draft");
      await act(async () => { button(dialog()!, "Create profile").click(); });
      assert.equal(creations.length, 1);
      assert.equal(creations[0]?.input.name, "Explicit test draft");
      assert.deepEqual(creations[0]?.input.proxy, { type: "http", host: "127.0.0.1", port: "18080", user: "", pass: "" });
      await act(async () => { creations[0]!.response.resolve(json({ ok: true, id: "created_fixture" })); });
      assert.equal(dialog(), null);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(requests.filter(item => item.method !== "GET" && item.path !== "/ui/api/workspace/preferences"), [
        { path: "/ui/api/settings/network/discover", method: "POST" }, { path: "/ui/api/settings/network/discover", method: "POST" }, { path: "/ui/api/profiles", method: "POST" },
      ], "Seeding a proxy draft must not verify its exit, launch it, or save it until Create is clicked");
      return;
    }
    if (scenario === "settings-navigation") {
      const settings = allButtons().find(item => item.classList.contains("navitem") && item.textContent?.trim() === "Settings");
      assert.ok(settings); await act(async () => { settings.click(); });
      const panel = dom.container.querySelector<HTMLElement>("#settings-panel"); assert.ok(panel);
      const tab = (id: string) => { const value = dom.container.querySelector<HTMLButtonElement>(`#settings-tab-${id}`); assert.ok(value); return value; };
      assert.equal(tab("account").getAttribute("aria-selected"), "true");
      assert.ok(panel.textContent?.includes("Local workspace"));
      await act(async () => { tab("fingerprints").click(); });
      await waitFor(() => !!panel.querySelector(".quality-overview + .feature-card .feature-empty"), "Fingerprint tab did not load its empty report");
      panel.scrollTop = 536; assert.equal(panel.scrollTop, 536);
      await act(async () => { tab("network").click(); });
      assert.equal(dom.container.querySelector("#settings-panel"), panel, "Settings tabs must reuse the same scroll container");
      assert.equal(panel.scrollTop, 0, "Switching from a scrolled report must reveal the network heading and startup preference");
      assert.equal(tab("network").getAttribute("aria-selected"), "true");
      assert.equal(panel.querySelector("h2")?.textContent, "Network & proxies");
      await waitFor(() => !!panel.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)'), "The network preference did not load valid disabled-by-default settings");
      assert.equal(panel.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, false);
      panel.scrollTop = 420; assert.equal(panel.scrollTop, 420);
      await act(async () => { tab("account").click(); });
      assert.equal(dom.container.querySelector("#settings-panel"), panel);
      assert.equal(panel.scrollTop, 0, "Returning to General must reveal its first section");
      assert.equal(tab("account").getAttribute("aria-selected"), "true");
      const workspaceContext = panel.querySelector(".settings-context");
      assert.equal(workspaceContext?.querySelector("p")?.textContent, "Local workspace");
      assert.equal(workspaceContext?.querySelector("h2")?.textContent, "Inert fixture workspace");
      assert.equal(creations.length, 0); assert.deepEqual(unexpected, []);
      assert.equal(requests.filter(item => item.path === "/ui/api/settings").length, 3, "Startup proxy check, page preloading and memory saver each read their settings once");
      assert.equal(requests.filter(item => item.path === "/ui/api/settings/fingerprints").length, 1);
      assert.ok(requests.every(item => item.method === "GET"), "Navigating settings must not create profiles, scan ports, or write preferences");
      return;
    }
    let createEntry = newButton()!;
    if (scenario === "success") {
      const emptyState = () => dom.container.querySelector<HTMLElement>(".workspace-empty");
      await waitFor(() => !!emptyState(), "A confirmed empty workspace must provide its own starting actions");
      const empty = emptyState()!;
      const importEntry = button(empty, "Import profiles");
      createEntry = button(empty, "New Profile");
      assert.equal(importEntry.disabled, false);
      assert.equal(createEntry.disabled, false);
      await act(async () => { importEntry.click(); });
      const importer = dom.container.querySelector<HTMLElement>('.profile-import-dialog[role="dialog"]');
      assert.ok(importer, "The empty workspace import action must open the upload dialog");
      await act(async () => { button(importer, "Cancel").click(); });
    }
    await act(async () => { createEntry.click(); });
    await typeName("Pending draft");
    if (scenario === "forced-host-auto") {
      await act(async () => { dialog()!.querySelector<HTMLElement>(".profile-templates > summary")!.click(); }); await dom.flush();
      await act(async () => {
        const select = dialog()!.querySelector<HTMLSelectElement>(".profile-templates select")!;
        select.value = templateId; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await act(async () => { button(dialog()!, "Apply preset").click(); });
      assert.ok(dialog()!.textContent?.includes("This preset already matches the current settings."), "An Auto preset must keep its Auto intent even when this host forces a runtime");
      assert.equal(nameInput().value, "Pending draft");
      await act(async () => { button(dialog()!, "Save current settings as preset").click(); });
      await act(async () => {
        const input = dialog()!.querySelector<HTMLInputElement>(".profile-template-editor input")!;
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Saved automatic intent");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(async () => { button(dialog()!, "Save preset").click(); });
      assert.equal(templateWrites.length, 1); assert.equal(templateWrites[0]!.settings.chromiumRuntime, "");
      assert.ok(dialog()!.textContent?.includes("Preset saved."));
    }
    const active = dialog()!, submit = button(active, "Create profile");
    // Both discrete events enter before React commits disabled state. A synchronous
    // operation guard, rather than the rendered button alone, must prevent duplicates.
    await act(async () => { submit.click(); submit.click(); });
    assert.equal(creations.length, 1, "A queued double click must create one request");
    assert.equal(creations[0]!.input.name, "Pending draft");
    if (scenario === "forced-host-auto") assert.equal(creations[0]!.input.chromiumRuntime, "aliasmode", "Creation must still follow the host's runtime constraint");
    assert.ok(nameInput().closest("fieldset[disabled]"), "Pending creation must disable the whole draft");
    await attemptClose();
    assert.equal(dialog(), active, "Pending creation must keep the same editor open");
    assert.equal(nameInput().value, "Pending draft"); assert.equal(creations.length, 1);
    if (scenario === "success" || scenario === "forced-host-auto") {
      holdRoster = true;
      await act(async () => { creations[0]!.response.resolve(json({ ok: true, id: "fixture_profile" })); });
      await waitFor(() => rosterWaiting, "Successful creation must await its roster refresh");
      assert.equal(dialog(), active); assert.equal(nameInput().value, "Pending draft");
      await attemptClose(); assert.equal(dialog(), active); assert.equal(creations.length, 1);
      holdRoster = false;
      roster.profiles = [{ id: "fixture_profile", name: "Pending draft", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false }];
      await act(async () => { delayedRoster.resolve(json(roster)); });
      await waitFor(() => !dialog(), "Completed creation must close only after refreshing the roster");
      await act(async () => { newButton()!.click(); });
      assert.equal(nameInput().value, ""); await typeName("New draft stays"); await dom.flush();
      assert.equal(nameInput().value, "New draft stays", "The completed request must not clear a later draft");
    } else {
      await act(async () => {
        if (scenario === "network-error") creations[0]!.response.reject(new Error("Inert creation connection failure"));
        else creations[0]!.response.resolve(json({ ok: false, error: "Inert creation validation failure" }, 400));
      });
      assert.equal(dialog(), active); assert.equal(nameInput().value, "Pending draft");
      assert.equal(nameInput().closest("fieldset[disabled]"), null);
      assert.equal(button(active, "Create profile").disabled, false); assert.equal(button(active, "Cancel").disabled, false);
      assert.ok(active.textContent?.includes(scenario === "network-error" ? "Inert creation connection failure" : "Inert creation validation failure"));
      await typeName("Retried draft"); await act(async () => { button(active, "Create profile").click(); });
      assert.equal(creations.length, 2, "A failed operation must release the guard for an explicit retry");
      assert.equal(creations[1]!.input.name, "Retried draft");
      await act(async () => { creations[1]!.response.resolve(json({ ok: true, id: "fixture_retry" })); });
      await waitFor(() => !dialog(), "Successful retry must restore normal editor completion");
      await act(async () => { newButton()!.click(); }); assert.equal(nameInput().value, "");
    }
    await act(async () => { button(dialog()!, "Cancel").click(); });
    if (scenario === "success" || scenario === "forced-host-auto") await confirmDiscard();
    assert.equal(dialog(), null); assert.deepEqual(unexpected, []);
    assert.ok(requests.every(item => item.path.startsWith("/ui/api/")), "All requests must stay in the explicit in-memory fixture");
  } finally {
    if (appRoot) await act(async () => { appRoot!.unmount(); });
    await dom.cleanup();
    if (quickWorkspace) {
      if (previousGetComputedStyle) Object.defineProperty(globalThis, "getComputedStyle", previousGetComputedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "success"); console.log("full App creation interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
