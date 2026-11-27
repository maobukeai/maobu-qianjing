import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Element, HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import type { AppSettings } from "../src/app-settings.ts";
import { getBrowserRuntimeInventory } from "../src/runtime-inventory.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { FeatureSettingsPanel, type FeatureSettingsTab } from "../web/settings-center.tsx";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function defaults(workspace: string): AppSettings {
  return { version: 1, updates: { repository: `${workspace}/saved`, channel: "stable", checkOnStartup: false }, sync: { enabled: true, folder: `/inert-${workspace}`, retainSnapshots: 10 }, network: { checkLocalProxyBeforeLaunch: false } };
}
async function run(scenario: string) {
  const coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });
  const servers = new Map([["one", defaults("one")], ["two", defaults("two")]]);
  const requests: Array<{ workspace: string; path: string; method: string; body: any }> = [];
  let heldPatch: ReturnType<typeof deferred<Response>> | null = null, nativeReads = 0;
  const delayedSettings = scenario === "hidden-load" ? deferred<Response>() : null;
  const preview = scenario === "hidden-focus" ? deferred<Response>() : null;
  const snapshotName = `maobu-sync-1700000000001-${"1".repeat(16)}.mqsync`;
  const json = (value: unknown) => Response.json(value);
  const fetcher = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : null;
    if (path === "/ui/api/shell-language") return json({ ok: true, language: "en-US" });
    const workspace = coordinator.getSnapshot().workspaceId!;
    requests.push({ workspace, path, method, body });
    if (path === "/ui/api/settings/network/discover") {
      assert.equal(method, "POST"); assert.deepEqual(body.ports, [12345]);
      return json({ ok: true, discovery: { checkedAt: "2026-11-10T00:00:00Z", host: "127.0.0.1", results: [{ host: "127.0.0.1", port: 12345, latencyMs: 2, status: "listening", socks5: "available", suggestions: [{ type: "socks5", evidence: "handshake" }] }] } });
    }
    if (path === "/ui/api/proxy/check") return json({ ok: true, status: "working", attempts: 3, successes: 3 });
    if (path === "/ui/api/settings") {
      if (method === "PATCH") {
        if (heldPatch) return heldPatch.promise;
        servers.set(workspace, { ...servers.get(workspace)!, ...body });
      }
      if (method === "GET" && delayedSettings) return delayedSettings.promise;
      return json({ ok: true, settings: servers.get(workspace) });
    }
    if (path === "/ui/api/settings/updates") return json({ ok: true, update: null });
    if (path === "/ui/api/settings/sync/files") return json({ ok: true, files: preview ? [{ fileName: snapshotName, createdAt: 1700000000001, modifiedAt: 1700000000001, bytes: 1024 }] : [] });
    if (path === "/ui/api/settings/sync/preview" && preview) return preview.promise;
    if (path === "/ui/api/settings/fingerprints") return json({ ok: true, reports: [] });
    if (path === "/ui/api/settings/runtimes") return json({ ok: true, inventory: getBrowserRuntimeInventory({ runtimeRoot: "/inert-cache", platform: "win32", arch: "x64", chromiumDefault: "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed" }) });
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ desktop: scenario === "hidden-native", fetch: fetcher });
  if (scenario === "hidden-native") mockIPC(command => {
    assert.equal(command, "signed_update_status"); nativeReads++;
    return { configured: true, status: "checking", currentVersion: "1.0.0", endpoint: "https://publisher.invalid/update.json", message: "Fixture update in progress", update: null };
  });
  const visible = (node: Element) => !node.closest("[hidden], [inert]");
  const render = (tab: FeatureSettingsTab | null) => dom.render(<WorkspaceOperationsProvider coordinator={coordinator}><I18nProvider><FeatureSettingsPanel tab={tab} /><button data-outside>Outside action</button></I18nProvider></WorkspaceOperationsProvider>);
  const field = (label: string) => {
    const node = [...dom.container.querySelectorAll("label")].find(item => visible(item) && item.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input");
    assert.ok(node, `Missing visible field ${label}`); return node;
  };
  const button = (label: string) => {
    const node = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => visible(item) && item.textContent?.trim() === label);
    assert.ok(node, `Missing visible button ${label}`); return node;
  };
  const type = (label: string, value: string) => act(async () => { const node = field(label); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const click = (label: string) => act(async () => button(label).click());
  const patches = () => requests.filter(item => item.method === "PATCH");
  const settingsReads = () => requests.filter(item => item.path === "/ui/api/settings" && item.method === "GET").length;
  const current = (tab: "sync" | "updates" | "network") => dom.container.querySelector<HTMLElement>(`[data-feature-settings-tab="${tab}"]`)!;
  try {
    if (scenario === "network-memory") {
      await render("network"); const original = field("Custom ports (optional)"); await type("Custom ports (optional)", "12345");
      await click("Discover local proxies"); await dom.flush();
      const listener = current("network").querySelector(".local-proxy-result"); assert.ok(listener);
      const verify = current("network").querySelector<HTMLButtonElement>('button[aria-label="Verify SOCKS5 exit for 127.0.0.1:12345"]'); assert.ok(verify);
      await act(async () => verify.click()); await dom.flush();
      const checked = current("network").querySelector(".feature-check-result"); assert.ok(checked); assert.ok(checked.textContent?.includes("working")); const evidence = checked.textContent;
      await render(null); assert.ok(current("network").hidden); assert.ok(current("network").hasAttribute("inert"));
      await render("sync"); await render("network");
      assert.equal(field("Custom ports (optional)"), original); assert.equal(original.value, "12345");
      assert.equal(current("network").querySelector(".local-proxy-result"), listener);
      assert.equal(current("network").querySelector(".feature-check-result"), checked); assert.equal(checked.textContent, evidence);
      assert.equal(requests.filter(value => value.path === "/ui/api/settings/network/discover").length, 1);
      assert.equal(requests.filter(value => value.path === "/ui/api/proxy/check").length, 1, "Returning to a retained result must not perform another exit check");
      assert.equal(patches().length, 0); return;
    }
    if (scenario === "null-tab") {
      await render("sync"); const original = field("Sync folder"); await type("Sync folder", "/inert-retained-through-general");
      const before = requests.length;
      await render(null); assert.ok(current("sync").hidden); assert.ok(current("sync").hasAttribute("inert"));
      assert.equal(dom.container.querySelectorAll('[data-feature-settings-tab="updates"]').length, 0, "General/advanced must not mount an unvisited update panel");
      assert.equal(requests.length, before); await render("sync");
      assert.equal(field("Sync folder"), original); assert.equal(field("Sync folder").value, "/inert-retained-through-general");
      assert.ok(current("sync").textContent?.includes("Changes not saved")); assert.equal(patches().length, 0);
      return;
    }
    if (scenario === "hidden-focus") {
      await render("sync"); await type("Snapshot password", "fixture-password");
      await act(async () => { const select = current("sync").querySelector<HTMLSelectElement>("select")!; select.value = snapshotName; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await click("Preview snapshot"); await render("updates");
      const outside = dom.container.querySelector<HTMLButtonElement>("[data-outside]")!;
      outside.focus(); outside.blur(); assert.equal(dom.window.document.activeElement, dom.window.document.body);
      await act(async () => { preview!.resolve(Response.json({ ok: false, error: "Fixture preview unavailable" }, { status: 503 })); });
      assert.equal(dom.window.document.activeElement, dom.window.document.body, "An inactive preview failure must not focus its retained password input");
      await render("sync"); assert.equal(field("Snapshot password").value, "fixture-password");
      assert.ok(current("sync").querySelector('[role="alert"]')?.textContent?.includes("Fixture preview unavailable"));
      assert.equal(dom.window.document.activeElement, dom.window.document.body, "Returning must not run a stale hidden focus request");
      return;
    }
    if (scenario === "hidden-load") {
      await render("sync"); await render("fingerprints");
      await act(async () => { delayedSettings!.resolve(json({ ok: true, settings: defaults("one") })); });
      assert.equal(requests.filter(item => item.path.endsWith("/sync/files")).length, 0, "A late settings response must not start a hidden folder read");
      await render("sync"); assert.equal(field("Sync folder").value, "/inert-one");
      assert.equal(requests.filter(item => item.path.endsWith("/sync/files")).length, 1, "Returning to sync performs the deferred folder read once");
      await render("fingerprints"); await render("sync");
      assert.equal(requests.filter(item => item.path.endsWith("/sync/files")).length, 1);
      return;
    }
    if (scenario === "hidden-native") {
      await render("updates"); assert.equal(nativeReads, 1);
      await render("sync"); const before = requests.length;
      assert.ok(current("updates").hidden); assert.ok(current("updates").hasAttribute("inert"));
      assert.equal(current("updates").querySelector(".signed-update-card"), null);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1650)); });
      assert.equal(nativeReads, 1, "An inactive retained GitHub draft must not keep the native status poll alive");
      assert.equal(requests.length, before, "Inactive panels must not issue periodic network requests");
      return;
    }
    if (scenario === "workspace-isolation") {
      await render("sync"); await type("Sync folder", "/inert-one-draft");
      heldPatch = deferred<Response>(); await click("Save settings"); assert.equal(patches().length, 1);
      await render("updates"); await type("Release repository", "one/unsaved");
      await act(async () => { coordinator.setWorkspace("two", "two"); });
      assert.equal(field("Release repository").value, "two/saved");
      await act(async () => { heldPatch!.resolve(json({ ok: true, settings: { ...defaults("one"), sync: { ...defaults("one").sync, folder: "/inert-one-draft" } } })); });
      assert.equal(field("Release repository").value, "two/saved", "An old workspace save must not rewrite the new draft session");
      await render("sync"); assert.equal(field("Sync folder").value, "/inert-two");
      assert.ok(!current("sync").textContent?.includes("Changes not saved"));
      assert.equal(patches().length, 1); assert.equal(patches()[0]!.workspace, "one");
      return;
    }
    const tab = scenario.endsWith("sync") ? "sync" : "updates", label = tab === "sync" ? "Sync folder" : "Release repository";
    const draft = tab === "sync" ? "/inert-draft-folder" : "draft/repository";
    await render(tab); const original = field(label); await type(label, draft);
    if (scenario.startsWith("failed-")) {
      heldPatch = deferred<Response>(); await click("Save settings");
      await render("fingerprints"); assert.ok(current(tab).hidden);
      // A nominally successful HTTP response without a valid settings receipt
      // must keep both the edited values and the unsaved warning.
      await act(async () => { heldPatch!.resolve(json({ ok: true, settings: {} })); });
      await render(tab); assert.equal(field(label), original); assert.equal(field(label).value, draft);
      assert.ok(current(tab).querySelector('[role="alert"]')); assert.ok(current(tab).textContent?.includes("Changes not saved"));
      assert.equal(current(tab).querySelector(".feature-success"), null);
      const error = current(tab).querySelector('[role="alert"]')!.textContent;
      await render("fingerprints"); await render(tab);
      assert.equal(current(tab).querySelector('[role="alert"]')?.textContent, error);
      assert.equal(patches().length, 1, "Returning to a failed draft must not save it automatically");
      heldPatch = null; await click("Save settings");
      assert.equal(field(label).value, draft); assert.equal(current(tab).querySelector('[role="alert"]'), null);
      assert.ok(current(tab).querySelector(".feature-success")?.textContent?.includes("Saved"));
      assert.ok(!current(tab).textContent?.includes("Changes not saved")); assert.equal(patches().length, 2);
      return;
    }
    const initialSettingsReads = settingsReads();
    await render("fingerprints"); assert.ok(current(tab).hidden); assert.ok(current(tab).hasAttribute("inert"));
    await render(tab); assert.equal(field(label), original, "A draft tab switch must retain the real form node");
    assert.equal(field(label).value, draft); assert.ok(current(tab).textContent?.includes("Changes not saved"));
    assert.equal(settingsReads(), initialSettingsReads, "Returning must not reload over the draft");
    assert.equal(patches().length, 0, "Tab changes must never auto-save");
    await click("Save settings"); assert.equal(patches().length, 1);
    assert.equal(patches()[0]!.body[tab === "sync" ? "sync" : "updates"][tab === "sync" ? "folder" : "repository"], draft);
  } finally { await dom.cleanup(); }
}
await run(process.argv[2] ?? "draft-sync");
console.log("settings tab drafts fixture passed");
