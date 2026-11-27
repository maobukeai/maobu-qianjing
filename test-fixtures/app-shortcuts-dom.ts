import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLElement } from "happy-dom";
import { defaultAppSettings } from "../src/app-settings.ts";
import { FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY } from "../src/profile-view-state.ts";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const desktop = scenario === "desktop-boundary";
  const finder = scenario === "profile-locate";
  const unexpected: string[] = [], requests: string[] = [], native: string[] = [];
  const preferenceWrites: Array<{ key: string; value: string }> = [];
  const preferences = finder ? { [FAVORITE_PROFILES_KEY]: JSON.stringify(["Needle_extra"]), [SAVED_PROFILE_VIEWS_KEY]: "[]" } : {};
  const finderProfiles = finder ? Array.from({ length: 33 }, (_, index) => ({ id: index === 30 ? "Needle" : index === 31 ? "Needle_extra" : index === 32 ? "needle" : `finder_${index}`, name: index === 30 ? "Needle target" : index === 31 ? "Prefix neighbor" : index === 32 ? "Different lower-case target" : `Environment ${index}`, group: index === 30 ? "A" : "B", engine: "chromium", chromiumRuntime: "aliasmode", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index + 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: index === 31 })) : [];
  const workspace = { id: "default", name: "Shortcut fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const payloads: Record<string, unknown> = {
    "/ui/api/shell-language": { ok: true, language: "en-US" },
    "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
    "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-shortcut-fixture" },
    "/ui/api/profiles": { ok: true, profiles: finderProfiles, groups: finder ? ["A", "B"] : [], folders: finder ? [{ name: "A" }, { name: "B" }] : [] },
    "/ui/api/extensions": { ok: true, extensions: [] },
    "/ui/api/diagnose/latest": { ok: true, report: null },
    "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
    "/ui/api/runtime-downloads": { ok: true, downloads: [] },
    "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
    "/ui/api/workspaces": { ok: true, currentId: workspace.id, activeId: workspace.id, workspaces: [workspace] },
    "/ui/api/workspace/overview": { ok: true, workspaceId: workspace.id, root: "inert-shortcut-fixture", profileCount: 0, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
    "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    "/ui/api/settings/templates": { ok: true, catalog: { version: 1, revision: 0, templates: [] } },
    "/ui/api/settings": { ok: true, settings: defaultAppSettings() },
  };
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push(`${method} ${path}`);
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) {
      if (method === "POST") preferenceWrites.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true, preferences });
    }
    if (method === "GET" && Object.hasOwn(payloads, path)) return Response.json(payloads[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected shortcut fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  const animationGlobals = new Map(["requestAnimationFrame", "cancelAnimationFrame"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  if (desktop) Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string) => { native.push(command); if (command === "agent_runtime_ready") return null; if (command === "default_browser_take_pending_urls") return []; throw new Error(`Unexpected native invocation: ${command}`); } } });
  dom.container.id = "root";
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const result = createRealRoot(...args); root = result; return result; } }));
  const active = (selector: string) => [...dom.window.document.querySelectorAll<HTMLElement>(selector)].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const help = () => active('.shortcut-help[role="dialog"]');
  const editor = () => active('[role="dialog"][aria-labelledby="create-profile-title"]');
  const palette = () => active('[data-command-palette="true"]');
  const helpEntry = () => dom.container.querySelector<HTMLButtonElement>(".shortcut-help-trigger")!;
  const search = () => dom.container.querySelector<HTMLInputElement>('.heading-search input[aria-label="Search profiles"]')!;
  const button = (node: HTMLElement, text: string) => { const result = [...node.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim().startsWith(text)); assert.ok(result, `Missing ${text}`); return result; };
  const waitFor = async (condition: () => boolean, description: string) => {
    const until = Date.now() + 2500;
    while (!condition() && Date.now() < until) await dom.flush();
    assert.ok(condition(), `${description}; requests=${JSON.stringify(requests)}`);
  };
  const press = async (value: string, modifiers: Record<string, boolean | number | undefined> = {}, target: HTMLElement = dom.window.document.body, alreadyHandled = false) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers });
    if (alreadyHandled) event.preventDefault();
    await act(async () => { target.dispatchEvent(event); }); return event;
  };
  const type = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => !!search() && !!helpEntry(), "The actual App must expose environment search and a stable shortcut entry");
    assert.ok(root); assert.deepEqual(unexpected, []);
    if (finder) {
      const rows = () => [...dom.container.querySelectorAll<HTMLElement>('tr[data-profile-id]')].filter(node => !node.closest('[inert], [hidden], [aria-hidden="true"]'));
      const view = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Environment view"]')!;
      const group = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Group filter"]')!;
      const select = async (node: HTMLSelectElement, value: string) => act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      const status = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('.profile-status-tabs button')].find(node => node.textContent.startsWith(label))!;
      const locate = async () => {
        await act(async () => { dom.container.querySelector<HTMLButtonElement>(".command-palette-trigger")!.click(); }); assert.ok(palette());
        const tab = [...palette()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === "Environments"); assert.ok(tab);
        await act(async () => { tab.click(); });
        await type(palette()!.querySelector<HTMLInputElement>('[role="combobox"]')!, "Needle");
        assert.equal(palette()!.querySelectorAll('[role="option"]').length, 3, "The finder must search the complete roster including prefix and case neighbors");
        const option = [...palette()!.querySelectorAll<HTMLElement>('[role="option"][data-profile-id]')].find(node => node.dataset.profileId === "Needle"); assert.ok(option);
        await act(async () => { option.click(); }); assert.equal(palette(), null);
        await waitFor(() => rows().length === 1 && rows()[0]?.dataset.profileId === "Needle" && dom.window.document.activeElement?.closest('tr[data-profile-id]')?.getAttribute("data-profile-id") === "Needle", "Locating must restore the visible roster and focus only the exact selected ID");
        assert.equal(search().value, "id:Needle"); assert.equal(group().value, "all"); assert.equal(status("All").getAttribute("aria-pressed"), "true"); assert.equal(dom.container.querySelector('.page-of b')?.textContent, "1");
      };
      await waitFor(() => !view().disabled, "The finder must use authoritative loaded favorite metadata");
      const next = dom.container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!; await act(async () => { next.click(); }); assert.equal(dom.container.querySelector('.page-of b')?.textContent, "2");
      await locate();
      await select(view(), "favorites"); await select(group(), "B"); await act(async () => { status("Running").click(); }); await type(search(), "Prefix"); assert.deepEqual(rows().map(node => node.dataset.profileId), ["Needle_extra"]);
      const proxies = [...dom.container.querySelectorAll<HTMLButtonElement>("button.navitem")].find(node => node.textContent.trim() === "Proxies"); assert.ok(proxies); await act(async () => { proxies.click(); });
      await locate();
      assert.ok([...view().options].some(option => option.value === "all"));
      const saveView = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Save current view"]'); assert.ok(saveView);
      await act(async () => { saveView.click(); });
      const name = dom.container.querySelector<HTMLInputElement>('.roster-view-editor input')!; await type(name, "Located Needle"); await act(async () => { button(dom.container, "Save view").click(); });
      await waitFor(() => preferenceWrites.some(item => item.key === SAVED_PROFILE_VIEWS_KEY), "The exact-ID query must remain an ordinary saveable view filter");
      const saved = JSON.parse(preferenceWrites.find(item => item.key === SAVED_PROFILE_VIEWS_KEY)!.value);
      assert.equal(saved[0]?.filters.query, "id:Needle"); assert.equal(saved[0]?.filters.scope, "all");
      assert.ok(!requests.some(request => /^GET \/ui\/api\/profiles\/|^POST \/ui\/api\/profiles/.test(request)), "Finder location must never read account details or create/start/stop a browser"); return;
    }
    if (scenario === "entry-search") {
      helpEntry().focus(); await act(async () => { helpEntry().click(); }); assert.ok(help());
      await act(async () => { button(help()!, "Search environments").click(); });
      await waitFor(() => dom.window.document.activeElement === search(), "The guide action must focus the actual environment search");
      assert.equal(help(), null); assert.equal(editor(), null); return;
    }
    if (scenario === "palette-help-focus") {
      const commandEntry = dom.container.querySelector<HTMLButtonElement>(".command-palette-trigger")!;
      commandEntry.focus(); await act(async () => { commandEntry.click(); }); assert.ok(palette());
      const input = palette()!.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
      await type(input, "Keyboard shortcuts");
      const option = [...palette()!.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent.includes("Keyboard shortcuts")); assert.ok(option);
      await act(async () => { option.click(); }); assert.ok(help()); assert.equal(palette(), null);
      await press("Escape", {}, help()!);
      assert.equal(help(), null);
      assert.ok([helpEntry(), commandEntry].includes(dom.window.document.activeElement as HTMLButtonElement), `Closing command → help must focus a stable workbench entry instead of the vanished command input; active=${dom.window.document.activeElement?.outerHTML.slice(0, 240)}`);
      return;
    }
    if (scenario === "palette-settings-focus") {
      const proxy = dom.container.querySelector<HTMLButtonElement>('.navitem[aria-label="Proxies"]')!;
      assert.ok(proxy);
      await act(async () => { proxy.click(); });
      proxy.focus();
      assert.equal((await press("k", { ctrlKey: true }, proxy)).defaultPrevented, true);
      const input = palette()!.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
      await type(input, "Network & proxies");
      await press("Enter", {}, input);
      await waitFor(() => dom.window.document.activeElement?.id === "settings-tab-network", "The command must focus the selected settings tab");
      assert.equal(dom.window.document.activeElement?.getAttribute("aria-selected"), "true");
      assert.equal(palette(), null);
      return;
    }
    if (scenario === "typing-ime-modal") {
      search().focus();
      for (const [value, modifiers] of [["?", {}], ["/", {}], ["n", { ctrlKey: true }], ["2", { altKey: true }]] as const) {
        assert.equal((await press(value, modifiers, search())).defaultPrevented, false); assert.equal(help(), null); assert.equal(editor(), null);
      }
      dom.window.document.body.focus();
      for (const modifiers of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
        assert.equal((await press("?", modifiers)).defaultPrevented, false); assert.equal(help(), null);
      }
      await press("?", {}, dom.window.document.body, true); assert.equal(help(), null);
      const content = dom.window.document.createElement("div"); content.contentEditable = "true"; content.tabIndex = 0; dom.container.append(content); content.focus();
      assert.equal((await press("?", {}, content)).defaultPrevented, false); assert.equal(help(), null); content.remove();
      const newEntry = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "New Profile"); assert.ok(newEntry);
      await act(async () => { newEntry.click(); }); assert.ok(editor());
      for (const [value, modifiers] of [["?", {}], ["/", {}], ["k", { ctrlKey: true }], ["2", { altKey: true }]] as const) {
        assert.equal((await press(value, modifiers, editor()!)).defaultPrevented, false); assert.equal(help(), null); assert.equal(palette(), null);
      }
      await act(async () => { button(editor()!, "Cancel").click(); }); assert.equal(editor(), null);
      assert.equal((await press("?")).defaultPrevented, true); assert.ok(help(), "An inert editor exit must not block help");
      await press("Escape", {}, help()!); assert.equal(help(), null); return;
    }
    if (scenario === "desktop-boundary" || scenario === "browser-boundary") {
      const newKey = await press("n", { ctrlKey: true });
      assert.equal(newKey.defaultPrevented, desktop);
      assert.equal(!!editor(), desktop, "Only the actual desktop host may override native Ctrl+N");
      if (editor()) await act(async () => { button(editor()!, "Cancel").click(); });
      const navigation = await press("2", { altKey: true }); assert.equal(navigation.defaultPrevented, desktop);
      assert.equal(dom.container.querySelector('[role="main"]')?.getAttribute("aria-label"), desktop ? "Proxies" : "Profiles");
      if (desktop) { assert.equal((await press("1", { altKey: true })).defaultPrevented, true); }
      assert.ok(search());
      assert.equal((await press("Enter", { metaKey: true })).defaultPrevented, false, "The shell must leave AI send and editor commands alone");
      assert.equal((await press("w", { ctrlKey: true })).defaultPrevented, false, "Native window commands must remain untouched");
      return;
    }
    throw new Error(`Unknown shortcut scenario: ${scenario}`);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); await dom.cleanup(); }
    finally { for (const [name, previous] of animationGlobals) { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); } }
    assert.deepEqual(unexpected, []);
    if (desktop) {
      assert.ok(native.includes("agent_runtime_ready"), "Expected startup readiness signal on desktop");
      assert.ok(native.every((cmd) => cmd === "agent_runtime_ready" || cmd === "default_browser_take_pending_urls"), "Only startup readiness and pending external URL checks may use native IPC; shortcuts must not invoke window commands");
    } else {
      assert.deepEqual(native, [], "Browser mode must not invoke native IPC");
    }
    assert.ok(requests.every(request => request.startsWith("GET ") || request === "POST /ui/api/workspace/preferences"), "Shortcut navigation must not create or launch environments");
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "entry-search"); console.log("actual App shortcut interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
