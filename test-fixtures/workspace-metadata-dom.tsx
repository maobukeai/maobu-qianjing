import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { HTMLButtonElement as DomButton, HTMLInputElement as DomInput, HTMLElement as DomElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { createDesktopCloseRegistry, DesktopCloseRegistryProvider } from "../web/desktop-close.tsx";
import { WorkspaceManagementPage, WorkspaceProvider, useWorkspaceCatalog, type WorkspacePageRequest } from "../web/workspace-manager.tsx";
import type { WorkspaceCatalog, WorkspaceMetadata, WorkspaceRecord } from "../web/workspaces-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function run(scenario: string) {
  const record = (id: string, name: string): WorkspaceRecord => ({ id, name, color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
  const initial: WorkspaceCatalog = { currentId: "one", activeId: "one", workspaces: [record("one", "Personal"), record("two", "Research")] };
  let catalog = initial, request: WorkspacePageRequest = { mode: "manage", id: 0 }, failCatalog = false, active = true;
  let invalidArchiveReceipt = true;
  let patchGate: ReturnType<typeof deferred<Response>> | null = null;
  let refreshCatalog!: ReturnType<typeof useWorkspaceCatalog>["refresh"];
  const patches: Partial<WorkspaceMetadata>[] = [], changes: string[] = [], restarts: unknown[] = [];
  const registry = createDesktopCloseRegistry();
  const savedDetails = (patch: Partial<WorkspaceMetadata>) => {
    const saved = { ...catalog.workspaces[0]!, ...patch };
    catalog = { ...catalog, workspaces: [saved, ...catalog.workspaces.slice(1)] };
    return saved;
  };
  const json = (value: unknown) => Response.json(value);
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET";
    if (method !== "GET") changes.push(`${method} ${path}`);
    if (path === "/ui/api/shell-language") return json({ ok: true, language: "en-US" });
    if (path === "/ui/api/workspace/capability") return json({ ok: true, token: "f".repeat(64) });
    if (path === "/ui/api/workspaces" && method === "GET") {
      if (failCatalog) throw new Error("Fixture catalog is unavailable");
      return json({ ok: true, ...catalog });
    }
    if (path === "/ui/api/workspaces/one" && method === "PATCH") {
      const patch = JSON.parse(String(options?.body)); patches.push(patch);
      return patchGate ? patchGate.promise : json({ ok: true, workspace: savedDetails(patch) });
    }
    if (path === "/ui/api/workspaces/two/archive" && method === "POST") {
      assert.deepEqual(JSON.parse(String(options?.body)), { archived: true });
      const saved: WorkspaceRecord = { ...catalog.workspaces[1]!, name: "Research latest", icon: "star", archived: !invalidArchiveReceipt };
      if (saved.archived) catalog = { ...catalog, workspaces: [catalog.workspaces[0]!, saved] };
      return json({ ok: true, workspace: saved });
    }
    if (path === "/ui/api/workspace/overview") return json({ ok: true, workspaceId: "one", root: "fixture", profileCount: 0, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 1, lastBackupAt: null, backupBusy: false, scriptRunning: false });
    if (path === "/ui/api/workspace/backups") return json({ ok: true, backups: [], jobs: [] });
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ desktop: true, fetch: fixtureFetch });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value(this: DomElement) { return this.closest("[hidden], [inert]") ? [] : [{ width: 200, height: 40 }]; } });
  mockIPC((command, args) => {
    assert.equal(command, "restart_workspace");
    restarts.push(args);
    if (restarts.length === 1) throw new Error("Fixture native restart did not finish");
  });
  function Probe() { refreshCatalog = useWorkspaceCatalog().refresh; return null; }
  const noop = () => {};
  const render = () => dom.render(<I18nProvider><DesktopCloseRegistryProvider registry={registry}><WorkspaceProvider initialCatalog={initial}>
    <Probe /><WorkspaceManagementPage active={active} request={request} onBack={noop} onShowRunning={noop} />
  </WorkspaceProvider></DesktopCloseRegistryProvider></I18nProvider>);
  const dialog = () => [...dom.window.document.querySelectorAll<DomElement>('.wm-confirm[role="dialog"]')].find(node => !node.closest("[inert]")) ?? null;
  const button = (label: string, scope: DomElement = dom.window.document.body) => {
    const found = [...scope.querySelectorAll<DomButton>("button")].find(node => !node.closest("[hidden], [inert]") && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label));
    assert.ok(found, `Missing ${label}`);
    return found;
  };
  const name = () => dom.container.querySelector<DomInput>('.wm-identity-card input[maxlength="40"]')!;
  const updateName = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name(), value);
    name().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const click = (label: string, scope?: DomElement) => act(async () => { button(label, scope).click(); });
  const refresh = () => act(async () => { await refreshCatalog(); });
  const metadataDraft = () => registry.getSnapshot().dirty.includes("workspace-metadata");
  try {
    await render(); await dom.flush();
    if (scenario === "rebase") {
      savedDetails({ name: "Personal refreshed" }); await refresh();
      assert.equal(name().value, "Personal refreshed", "A clean editor follows the newest catalog record");
      assert.equal(button("Save changes").disabled, true);
      assert.equal(metadataDraft(), false);

      await updateName("Draft name");
      savedDetails({ color: "#628ac7" }); await refresh();
      assert.equal(name().value, "Draft name");
      assert.equal(button("Purple").getAttribute("aria-pressed"), "true", "Review keeps local control values stable until the user decides");
      assert.equal(button("Save changes").disabled, true);
      await act(async () => { name().form?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
      assert.deepEqual(patches, [], "The submit handler also blocks unreviewed changes");
      assert.doesNotMatch(dom.container.querySelector(".wm-metadata-review")?.textContent ?? "", /also changed/);

      savedDetails({ name: "Saved elsewhere" }); await refresh();
      const review = dom.container.querySelector(".wm-metadata-review")!;
      assert.match(review.textContent ?? "", /Saved elsewhere/);
      assert.match(review.textContent ?? "", /This field also changed in your draft/);
      await click("Keep my edits");
      assert.equal(dom.window.document.activeElement, name());
      assert.equal(name().value, "Draft name");
      assert.equal(button("Blue").getAttribute("aria-pressed"), "true");
      assert.equal(button("Save changes").disabled, false);

      patchGate = deferred<Response>();
      await click("Save changes");
      assert.deepEqual(patches, [{ name: "Draft name" }], "PATCH sends only the local edit after review");
      assert.ok(registry.getSnapshot().busy.includes("workspace-metadata"));
      await act(async () => { patchGate?.resolve(Response.json({ ok: false, error: "Fixture save rejected" }, { status: 409 })); });
      assert.equal(name().value, "Draft name");
      assert.equal(metadataDraft(), true);
      assert.deepEqual(registry.getSnapshot().busy, []);
      assert.match(dom.container.querySelector('[role="alert"]')?.textContent ?? "", /Fixture save rejected/);
      assert.equal(button("Save changes").disabled, false);

      patchGate = null; failCatalog = true;
      await click("Save changes");
      assert.equal(name().value, "Draft name");
      assert.equal(metadataDraft(), false, "The accepted receipt clears the draft when its follow-up read fails");
      assert.equal(button("Save changes").disabled, true);
      assert.match(dom.container.textContent ?? "", /Workspace saved, but the workspace list could not refresh/);

      failCatalog = false;
      await updateName("Discard this draft");
      savedDetails({ name: "Newest saved name" }); await refresh();
      await click("Use saved details");
      assert.equal(name().value, "Newest saved name");
      assert.equal(metadataDraft(), false);
      assert.deepEqual(patches, [{ name: "Draft name" }, { name: "Draft name" }]);
    } else if (scenario === "archive") {
      await click("ResearchLocal workspace");
      await click("Archive workspace");
      assert.equal(name().value, "Research", "An inconsistent archive response cannot replace the selected workspace details");
      assert.match(dom.container.querySelector('[role="alert"]')?.textContent ?? "", /Workspace response was incomplete/);
      invalidArchiveReceipt = false; failCatalog = true;
      await click("Archive workspace");
      assert.equal(name().value, "Research latest", "The accepted archive receipt contains the latest metadata even when refresh fails");
      assert.equal(button("Star").getAttribute("aria-pressed"), "true");
      assert.ok(button("Unarchive workspace"));
      assert.equal(metadataDraft(), false);
    } else {
      await updateName("Unsaved workspace title");
      let ai!: ReturnType<typeof registry.register>;
      await act(async () => { ai = registry.register("assistant-draft", { dirty: true, busy: false }); });
      active = false; await render();
      assert.equal(metadataDraft(), true, "Hidden management still owns its draft");
      request = { mode: "switch", workspaceId: "two", id: 1 }; active = true;
      await render(); await dom.flush();
      const switchDialog = dialog(); assert.ok(switchDialog);
      assert.match(switchDialog.textContent ?? "", /Switch workspace\?/);
      assert.match(switchDialog.textContent ?? "", /Research/);
      assert.match(switchDialog.textContent ?? "", /Workspace details/);
      assert.match(switchDialog.textContent ?? "", /AI message draft/);
      assert.doesNotMatch(switchDialog.textContent ?? "", /Unsaved workspace title/);
      await click("Cancel", switchDialog);
      assert.equal(dialog(), null);
      assert.equal(name().value, "Unsaved workspace title");
      assert.equal(button("PersonalCurrent workspace").getAttribute("aria-pressed"), "true");
      assert.equal(metadataDraft(), true);
      assert.deepEqual(changes, []); assert.deepEqual(restarts, []);

      catalog = { ...catalog, activeId: "two" }; await refresh();
      await click("Retry restart");
      const restartDialog = dialog(); assert.ok(restartDialog);
      assert.match(restartDialog.textContent ?? "", /Restart the desktop app\?/);
      assert.match(restartDialog.textContent ?? "", /Research/);
      assert.match(restartDialog.textContent ?? "", /Workspace details/);
      assert.match(restartDialog.textContent ?? "", /AI message draft/);
      const confirm = button("Restart desktop app", restartDialog);
      await act(async () => { ai.update({ dirty: true, busy: true }); confirm.click(); });
      assert.deepEqual(restarts, [], "A busy draft registered in the same event turn blocks restart");
      assert.equal(confirm.disabled, true);
      assert.match(restartDialog.textContent ?? "", /Wait for the current changes/);
      await act(async () => { ai.update({ dirty: false, busy: false }); });
      assert.equal(confirm.disabled, false);
      assert.doesNotMatch(restartDialog.textContent ?? "", /AI message draft/, "Live restart review follows the actual owners");
      await act(async () => { ai.update({ dirty: true, busy: false }); confirm.click(); });
      assert.deepEqual(restarts, [], "A newly dirty owner must be displayed before restart can proceed");
      assert.match(restartDialog.textContent ?? "", /AI message draft/);
      let secondAI!: ReturnType<typeof registry.register>;
      await act(async () => { secondAI = registry.register("assistant-draft", { dirty: true, busy: false }); confirm.click(); });
      assert.deepEqual(restarts, [], "A second owner under the same label also changes the reviewed revision");
      await act(async () => { secondAI.dispose(); });

      await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      assert.equal(dialog(), null);
      assert.equal(name().value, "Unsaved workspace title");
      assert.equal(metadataDraft(), true);
      assert.deepEqual(changes, []); assert.deepEqual(restarts, []);
      await click("Retry restart");
      await click("Restart desktop app", dialog()!);
      assert.deepEqual(restarts, [{ expectedWorkspaceId: "one", targetWorkspaceId: "two" }]);
      assert.match(dialog()?.textContent ?? "", /Fixture native restart did not finish/);
      assert.equal(name().value, "Unsaved workspace title");
      assert.equal(metadataDraft(), true);
      await act(async () => { ai.dispose(); });
    }
  } finally {
    patchGate?.resolve(Response.json({ ok: false, error: "Fixture teardown" }, { status: 409 }));
    await dom.cleanup();
  }
}

try { await run(process.argv[2] ?? "rebase"); console.log("workspace metadata fixture passed"); }
catch (error) { console.error(error); process.exitCode = 1; }
