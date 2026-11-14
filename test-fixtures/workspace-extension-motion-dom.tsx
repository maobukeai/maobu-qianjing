import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLSelectElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { DESKTOP_MOTION_EVENT } from "../web/desktop-motion.tsx";
import { WorkspaceProvider, WorkspaceSwitcher, DevicePanel, WorkspaceManagementPage } from "../web/workspace-manager.tsx";
import { ExtensionsPage, extensionGroupPreview, type ExtensionsPageProps } from "../web/extensions-page.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const reduced = scenario.startsWith("reduced-"), surface = scenario.replace(/^reduced-/, "").split("-")[0];
  const record = (id: string, name: string) => ({ id, name, color: "#8169c8", icon: "laptop" as const, archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
  const catalog = { currentId: "one", activeId: "one", workspaces: [record("one", "Personal"), record("two", "Research")] };
  const requests: string[] = [], navigations: string[] = [], writes: string[] = [];
  const operation = deferred<boolean>(), language = deferred<void>();
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET"; requests.push(`${method} ${path}`);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/workspace/capability") return Response.json({ ok: true, token: "c".repeat(64) });
    if (path === "/ui/api/workspaces" && method === "GET") return Response.json({ ok: true, ...catalog });
    if (path === "/ui/api/workspace/overview" && method === "GET") return Response.json({ ok: true, workspaceId: "one", root: "inert-motion-fixture", profileCount: 0, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 1000, lastBackupAt: null, backupBusy: false, scriptRunning: false });
    if (path === "/ui/api/workspace/backups" && method === "GET") return Response.json({ ok: true, backups: [{ id: "fixture", name: "Motion fixture backup", createdAt: 1, bytes: 1, profileCount: 0 }], jobs: [] });
    throw new Error(`Unexpected motion fixture request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  dom.window.document.documentElement.dataset.desktopMotion = reduced ? "reduced" : "full";
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const customEventDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.window.CustomEvent });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value(this: HTMLElement) { return this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [{ width: 200, height: 40 }]; } });
  const extensionProps: ExtensionsPageProps = {
    extensions: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], profiles: [{ id: "one", name: "Fixture environment", group: "Research", engine: "chromium", running: false, extensions: ["a"] }],
    groupDefaults: [{ name: "Research", extensions: ["a"] }], selectedGroup: "Research", selectedExtensionIds: ["b"], source: "", installing: false, uploading: false, applying: false, error: null,
    onSourceChange() {}, onSelectGroup() {}, onToggleExtension() {}, onInstall: async () => true, onUpload: async () => true,
    onApplyGroupDefaults: async () => { writes.push("apply"); return operation.promise; }, onRemove: async () => { writes.push("remove"); return operation.promise; },
    onPreviewGroupDefaults: async selection => { const { signature: _s, unknown: _u, ...preview } = extensionGroupPreview(selection.group, selection.extensions, extensionProps.groupDefaults, extensionProps.profiles); return { ...preview, version: 1, unknown: 0, expectedFingerprint: "a".repeat(64) }; },
  };
  const render = () => dom.render(<I18nProvider><button type="button" data-outside>Outside fixture focus</button>{surface === "extension" || surface === "unmount" ? <ExtensionsPage {...extensionProps} /> : <WorkspaceProvider initialCatalog={catalog}>
    {surface === "switcher" ? <WorkspaceSwitcher profileCount={0} runningCount={0} connection onShowRunning={() => {}} onOpenManagement={intent => navigations.push(intent.mode)} /> : surface === "device" ? <DevicePanel runningCount={0} downloads={[]} connection version="fixture" theme="light" chooseTheme={theme => writes.push(theme)} language="en-US" setLanguage={async value => { writes.push(value); await language.promise; }} onShowRunning={() => navigations.push("running")} onSettings={() => navigations.push("settings")} onViewLogs={() => navigations.push("logs")} /> : <WorkspaceManagementPage active request={{ mode: "backups", id: 1 }} onBack={() => navigations.push("back")} onShowRunning={() => {}} />}
  </WorkspaceProvider>}</I18nProvider>);
  const active = <T extends HTMLElement>(selector: string) => [...dom.window.document.querySelectorAll<T>(selector)].find(node => !node.closest('[inert], [hidden], [aria-hidden="true"]')) ?? null;
  const button = (label: string, scope: HTMLElement = dom.window.document.body) => { const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[inert], [hidden], [aria-hidden="true"]') && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label)); assert.ok(result, `Missing ${label}`); return result; };
  const click = async (node: HTMLButtonElement) => act(async () => { node.focus(); node.click(); });
  const key = async (value: string) => { const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }); await act(async () => { dom.window.document.dispatchEvent(event); }); return event; };
  const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
  const exiting = (node: HTMLElement) => { const host = node.closest(".desktop-motion-presence") as HTMLElement | null; assert.ok(host); assert.equal(host.dataset.motionPhase, "exiting"); assert.equal(host.getAttribute("aria-hidden"), "true"); assert.ok(host.hasAttribute("inert")); return host; };
  const assertReleasedTrap = async () => { const outside = button("Outside fixture focus"); outside.focus(); const event = await key("Tab"); assert.equal(event.defaultPrevented, false); assert.equal(dom.window.document.activeElement, outside); };
  const staleClick = async (node: HTMLButtonElement) => act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  try {
    await render(); await dom.flush();
    const initialRequests = [...requests];
    if (surface === "switcher") {
      const trigger = button("Open workspace switcher"); await click(trigger);
      const menu = active<HTMLElement>('[role="menu"]'); assert.ok(menu);
      const management = button("Manage workspaces", menu);
      await key("Escape"); assert.equal(dom.window.document.activeElement, trigger);
      if (reduced) assert.equal(dom.window.document.querySelector('[role="menu"]'), null);
      else {
        const host = exiting(menu); await staleClick(management); assert.deepEqual(navigations, []); await assertReleasedTrap();
        await click(trigger); await pause(); assert.equal(active('[role="menu"]')?.closest(".desktop-motion-presence"), host); assert.ok(!host.hasAttribute("inert"));
        await click(button("Manage workspaces", active<HTMLElement>('[role="menu"]')!)); assert.deepEqual(navigations, ["manage"]); assert.equal(dom.window.document.activeElement, trigger);
      }
    } else if (surface === "device") {
      const trigger = button("Open device panel"); await click(trigger);
      const panel = active<HTMLElement>(".wm-device-popover"); assert.ok(panel);
      const dark = button("Dark", panel), settings = button("All settings", panel), select = panel.querySelector<HTMLSelectElement>("select")!;
      if (scenario === "device-pending") {
        await act(async () => { select.value = "zh-CN"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
        assert.deepEqual(writes, ["zh-CN"], "A quick preference action must not submit twice");
      }
      await click(button("Close device panel", panel)); assert.equal(dom.window.document.activeElement, trigger);
      if (reduced) assert.equal(dom.window.document.querySelector(".wm-device-popover"), null);
      else {
        exiting(panel); await staleClick(dark); await staleClick(settings);
        await act(async () => { select.value = "en-US"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
        assert.deepEqual(writes, scenario === "device-pending" ? ["zh-CN"] : []); assert.deepEqual(navigations, []); await assertReleasedTrap();
        await click(trigger); await pause(); assert.ok(active(".wm-device-popover"));
        if (scenario === "device-pending") { assert.ok(button("Dark", active<HTMLElement>(".wm-device-popover")!).disabled); await act(async () => { language.resolve(); }); assert.equal(button("Dark", active<HTMLElement>(".wm-device-popover")!).disabled, false); }
        await click(button("Close device panel"));
      }
    } else if (surface === "workspace") {
      const trigger = button("Restore as new"); await click(trigger);
      const dialog = active<HTMLElement>(".wm-confirm"); assert.ok(dialog); const restore = button("Restore as new workspace", dialog);
      await click(button("Cancel", dialog)); assert.equal(dom.window.document.activeElement, trigger);
      if (reduced) assert.equal(dom.window.document.querySelector(".wm-confirm"), null);
      else {
        exiting(dialog); await staleClick(restore); await assertReleasedTrap(); assert.deepEqual(requests, initialRequests, "Closing a preview must not restore or refresh anything");
        await click(trigger); await pause(); assert.ok(active(".wm-confirm")); await click(button("Cancel", active<HTMLElement>(".wm-confirm")!));
      }
    } else {
      const trigger = button("Review and apply"); await click(trigger);
      const dialog = active<HTMLElement>(".extensions-confirm"); assert.ok(dialog); const apply = button("Apply group default", dialog);
      if (scenario === "extension-pending") {
        await click(apply); await click(apply); assert.deepEqual(writes, ["apply"]);
        await key("Escape"); assert.ok(active(".extensions-confirm"), "Pending writes must retain their business lock");
        await act(async () => { operation.resolve(true); });
      } else await click(button("Cancel", dialog));
      assert.equal(dom.window.document.activeElement, trigger);
      if (reduced) assert.equal(dom.window.document.querySelector(".extensions-confirm"), null);
      else {
        const host = exiting(dialog); await staleClick(apply); assert.deepEqual(writes, scenario === "extension-pending" ? ["apply"] : []); await assertReleasedTrap();
        if (scenario === "unmount-exit") { await dom.unmount(); await pause(); assert.equal(dom.window.document.querySelector(".extensions-confirm"), null); }
        else {
          await click(button("Remove Alpha")); await pause(); const next = active<HTMLElement>(".extensions-confirm"); assert.ok(next); assert.equal(next.closest(".desktop-motion-presence"), host); assert.ok(next.textContent?.includes("Remove Alpha from this device?")); assert.ok(!next.textContent?.includes("Replace extension assignments"));
          const remove = button("Remove extension", next); await click(button("Cancel", next)); await staleClick(remove); assert.deepEqual(writes, scenario === "extension-pending" ? ["apply"] : []);
        }
      }
    }
    assert.deepEqual(requests, initialRequests, "Presence transitions must not add business requests");
    if (!reduced && scenario !== "unmount-exit") {
      await act(async () => { dom.window.document.documentElement.dataset.desktopMotion = "reduced"; dom.window.dispatchEvent(new dom.window.Event(DESKTOP_MOTION_EVENT)); });
      assert.equal(dom.window.document.querySelector('.desktop-motion-presence[aria-hidden="true"]'), null, "Reduced motion must finish an in-flight exit immediately");
    }
  } finally {
    operation.resolve(false); language.resolve(); await dom.cleanup();
    if (styleDescriptor) Object.defineProperty(globalThis, "getComputedStyle", styleDescriptor); else Reflect.deleteProperty(globalThis, "getComputedStyle");
    if (customEventDescriptor) Object.defineProperty(globalThis, "CustomEvent", customEventDescriptor); else Reflect.deleteProperty(globalThis, "CustomEvent");
  }
}
try { await run(process.argv[2] ?? "switcher-exit"); console.log("workspace and extension motion fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
