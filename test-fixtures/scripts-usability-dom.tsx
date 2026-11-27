import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLElement } from "happy-dom";
import type { ScriptRecord } from "../contracts/local.ts";
import type { ScriptRun } from "../src/scripts.ts";
import type { UiProfile } from "../web/api.ts";
import { ScriptsPage, ScriptRunPanel } from "../web/scripts.tsx";
import { createDesktopCloseRegistry, DesktopCloseRegistryProvider } from "../web/desktop-close.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const monitorMode = scenario.startsWith("run-");
  const first: ScriptRecord = { id: "script_one", name: "First script", description: "First saved description", language: scenario === "hidden-python-status" ? "python" : "javascript", source: "// PRIVATE_SCRIPT_SOURCE_ONE", revision: 1, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" };
  const second: ScriptRecord = { ...first, id: "script_two", name: "Second script", description: "Second saved description", source: "// PRIVATE_SCRIPT_SOURCE_TWO" };
  const records = new Map([[first.id, first], [second.id, second]]);
  const registry = createDesktopCloseRegistry();
  const requests: string[] = [], unexpected: string[] = [], native: string[] = [];
  const patches: Array<{ id: string; input: Record<string, unknown>; response: ReturnType<typeof deferred<Response>> }> = [];
  const starts: Array<{ input: Record<string, unknown>; response: ReturnType<typeof deferred<Response>> }> = [], stops: Array<ReturnType<typeof deferred<Response>>> = [];
  const heldRunReads: Array<ReturnType<typeof deferred<Response>>> = [];
  const heldListReads: Array<ReturnType<typeof deferred<Response>>> = [];
  let serverRun: ScriptRun | null = null, failRefresh = false, runReadCount = 0;
  let holdRefresh = false;
  const makeRun = (name = "First script", status: ScriptRun["status"] = "running"): ScriptRun => ({ id: "run_fixture", scriptName: name, status, profiles: [{ id: "environment_1", name: "Selected environment", status: status === "finished" ? "succeeded" : "running" }] });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push(`${method} ${path}`);
    if (path === "/ui/api/shell-language" && method === "GET") return json({ ok: true, language: "en-US" });
    if (!path.startsWith("/ui/api/scripts")) { unexpected.push(`${method} ${path}`); throw new Error(`External fixture request blocked: ${path}`); }
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-script-capability");
    if (path === "/ui/api/scripts" && method === "GET") {
      if (holdRefresh) {
        const response = deferred<Response>();
        heldListReads.push(response);
        return response.promise;
      }
      if (failRefresh) return json({ ok: false, error: "Inert script list refresh failure" }, 500);
      return json({ ok: true, scripts: [...records.values()].map(({ source: _source, ...summary }) => summary) });
    }
    if (path === "/ui/api/scripts/python-runtime" && method === "GET" && scenario === "hidden-python-status") {
      return json({ ok: true, python: { state: "downloading", receivedBytes: 5_000_000, totalBytes: 50_000_000 } });
    }
    if (path === "/ui/api/scripts/run") {
      if (method === "GET") {
        runReadCount++;
        if (scenario === "run-load-retry" && runReadCount === 1) return json({ ok: false, error: "Inert monitor read failure" }, 500);
        if (scenario === "run-read-shared" && heldRunReads.length < 1) { const response = deferred<Response>(); heldRunReads.push(response); return response.promise; }
        return json({ ok: true, run: serverRun });
      }
      if (method === "POST") { const response = deferred<Response>(); starts.push({ input: JSON.parse(String(options?.body)), response }); return response.promise; }
    }
    if (path === "/ui/api/scripts/stop" && method === "POST") { const response = deferred<Response>(); stops.push(response); return response.promise; }
    if (path.startsWith("/ui/api/scripts/log?") && method === "GET") return json({ ok: true, text: "Fixture log only\n", nextOffset: 17 });
    const detail = /^\/ui\/api\/scripts\/([^/?]+)$/.exec(path);
    if (detail && records.has(detail[1]!)) {
      if (method === "GET") return json({ ok: true, script: records.get(detail[1]!) });
      if (method === "PATCH") { const response = deferred<Response>(); patches.push({ id: detail[1]!, input: JSON.parse(String(options?.body)), response }); return response.promise; }
    }
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected script fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string) => { native.push(command); if (command === "script_capability") return "fixture-script-capability"; throw new Error(`Unexpected native command: ${command}`); } } });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  const selected = [{ id: "environment_1", name: "Selected environment", engine: "chromium", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, running: false }] as UiProfile[];
  function Surface() {
    const [showPage, setShowPage] = useState(scenario !== "hidden-initial");
    const [open, setOpen] = useState(false);
    const [workspace, setWorkspace] = useState(0);
    return monitorMode ? <><button type="button" data-monitor-entry onClick={() => setOpen(true)}>Open monitor</button><ScriptRunPanel open={open} selectedProfiles={selected} onClose={() => setOpen(false)} /></>
      : <DesktopCloseRegistryProvider registry={registry}>
          <button type="button" data-page-toggle onClick={() => setShowPage(value => !value)}>{showPage ? "Navigate away" : "Return to scripts"}</button>
          <button type="button" onClick={() => setWorkspace(value => value + 1)}>Change fixture workspace</button>
          <ScriptsPage key={workspace} active={showPage} onViewRun={() => setOpen(true)} />
        </DesktopCloseRegistryProvider>;
  }
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[inert], [hidden], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.container) => { const item = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(item, `Missing interactive button: ${label}`); return item; };
  const field = (label: string) => { const node = [...dom.container.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input"); assert.ok(node, `Missing field: ${label}`); return node; };
  const detail = () => visible<HTMLElement>(".script-detail")[0] ?? null;
  const monitor = () => visible<HTMLElement>('.script-run-modal[role="dialog"]')[0] ?? null;
  const entry = () => dom.container.querySelector<HTMLButtonElement>("[data-monitor-entry]")!;
  const click = async (node: HTMLButtonElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const type = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const prototype = node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const select = async (node: HTMLSelectElement, value: string) => act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, description: string) => { const until = Date.now() + 2500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${description}; requests=${JSON.stringify(requests)}; text=${dom.container.textContent?.slice(-1800)}`); };
  const chooseScript = async (id: string) => {
    const row = dom.container.querySelector<HTMLButtonElement>(`.script-row[data-script-id="${id}"]`);
    assert.ok(row);
    await click(row);
    await waitFor(() => !!detail() && row.getAttribute("aria-pressed") === "true" && !row.disabled, "Selecting a script must load its actual details");
  };
  const finishPatch = async (index: number, ok = true) => act(async () => {
    const write = patches[index]; assert.ok(write);
    if (!ok) { write.response.resolve(json({ ok: false, error: "Inert script save failure" }, 409)); return; }
    const previous = records.get(write.id)!;
    const updated = { ...previous, name: String(write.input.name).trim(), description: String(write.input.description), language: write.input.language as ScriptRecord["language"], source: String(write.input.source), revision: previous.revision + 1 };
    records.set(write.id, updated); write.response.resolve(json({ ok: true, script: updated }));
  });
  const press = async (value: string, shiftKey = false, isComposing = false) => act(async () => { (dom.window.document.activeElement ?? dom.window.document.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, shiftKey, isComposing })); });
  const openMonitor = async () => { entry().focus(); await click(entry()); await waitFor(() => !!monitor(), "The monitor must open"); if (scenario !== "run-read-shared") await waitFor(() => monitor()?.querySelector('.modal-body')?.getAttribute("aria-busy") === "false", "Monitor startup must settle"); };
  try {
    await dom.render(<I18nProvider><Surface /></I18nProvider>);
    if (monitorMode) {
      await openMonitor();
      if (scenario === "run-load-retry") {
        assert.ok(monitor()?.textContent.includes("Inert monitor read failure"));
        assert.ok(!monitor()?.textContent.includes("Loading the latest run status…")); assert.equal(button("Run script", monitor()!).disabled, true);
        serverRun = makeRun("Recovered current run"); await click(button("Reload monitor", monitor()!));
        await waitFor(() => !!monitor()?.textContent.includes("Recovered current run"), "An explicit monitor reload must recover the current job");
        assert.ok(!monitor()?.textContent.includes("Inert monitor read failure")); assert.equal(starts.length, 0); assert.equal(stops.length, 0); return;
      }
      if (scenario === "run-read-shared") {
        await waitFor(() => heldRunReads.length === 1, "First monitor read must be pending");
        await click(button("Close monitor", monitor()!)); await openMonitor();
        assert.equal(heldRunReads.length, 1, "Reopening a view must share the session's pending status GET");
        serverRun = makeRun("Newest current run");
        await act(async () => { heldRunReads[0]!.resolve(json({ ok: true, run: serverRun })); });
        await waitFor(() => !!monitor()?.textContent.includes("Newest current run"), "The shared status request must update the reopened monitor");
        assert.equal(starts.length, 0); assert.equal(stops.length, 0); return;
      }
      if (scenario === "run-focus-close") {
        const close = button("Close run monitor", monitor()!);
        assert.ok(dom.window.document.activeElement === close);
        const controls = visible<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)', monitor()!);
        await act(async () => { controls.at(-1)!.focus(); }); await press("Tab"); assert.ok(dom.window.document.activeElement === close);
        await press("Tab", true); assert.ok(dom.window.document.activeElement === controls.at(-1));
        await act(async () => { entry().focus(); }); assert.ok(dom.window.document.activeElement === close);
        await act(async () => { (monitor()!.parentElement as HTMLElement).click(); }); assert.ok(monitor(), "Backdrop clicks must not hide the monitor or its inputs");
        await select(monitor()!.querySelector<HTMLSelectElement>("select")!, first.id);
        await type(monitor()!.querySelector<HTMLTextAreaElement>("textarea")!, '{"draft":"keep"}');
        await type(monitor()!.querySelector<HTMLInputElement>('input[type="number"]')!, "20");
        await press("Escape", false, true); assert.ok(monitor());
        await press("Escape"); assert.equal(monitor(), null); assert.ok(dom.window.document.activeElement === entry());
        assert.ok(dom.container.querySelector('.script-run-modal')?.closest('[inert][aria-hidden="true"]'));
        await openMonitor(); assert.equal(monitor()!.querySelector<HTMLTextAreaElement>("textarea")?.value, '{"draft":"keep"}'); assert.equal(monitor()!.querySelector<HTMLInputElement>('input[type="number"]')?.value, "20");
        assert.equal(starts.length, 0); assert.equal(stops.length, 0); return;
      }
      if (scenario === "run-start-once") {
        await select(monitor()!.querySelector<HTMLSelectElement>("select")!, first.id);
        await type(monitor()!.querySelector<HTMLTextAreaElement>("textarea")!, '{"checked":true}');
        await click(button("Run script", monitor()!), true); await waitFor(() => starts.length === 1, "A double click must dispatch one run");
        assert.deepEqual(starts[0]!.input, { scriptId: first.id, profileIds: ["environment_1"], inputs: { checked: true }, useCredentials: false, concurrency: 10 });
        await click(button("Close monitor", monitor()!)); assert.equal(monitor(), null); assert.equal(stops.length, 0);
        serverRun = makeRun(); await act(async () => { starts[0]!.response.resolve(json({ ok: true, run: serverRun })); });
        await openMonitor(); await waitFor(() => !!monitor()?.textContent.includes("First script · Running"), "A hidden pending start must still become a visible running job");
        assert.ok(monitor()!.textContent.includes("Closing this monitor keeps your inputs and does not stop a run."));
        await click(button("Stop run", monitor()!), true); await waitFor(() => stops.length === 1, "An explicit double stop must dispatch once");
        serverRun = makeRun("First script", "stopping"); await act(async () => { stops[0]!.resolve(json({ ok: true, run: serverRun })); });
        assert.ok(button("Stopping…", monitor()!).disabled); assert.equal(starts.length, 1); return;
      }
      throw new Error(`Unknown monitor scenario: ${scenario}`);
    }
    if (scenario === "hidden-initial") {
      assert.deepEqual(requests.filter(request => request.includes("/ui/api/scripts")), []);
      await click(button("Return to scripts"));
      await waitFor(() => visible(".script-row").length === 2, "First activation must load the script library");
      assert.equal(requests.filter(request => request === "GET /ui/api/scripts").length, 1);
      assert.equal(patches.length, 0);
      return;
    }
    await waitFor(() => dom.container.querySelectorAll(".script-row").length === 2, "The script library must load from its real API client");
    if (scenario === "hidden-python-status") {
      const runtimeReads = () => requests.filter(request => request === "GET /ui/api/scripts/python-runtime").length;
      await waitFor(() => dom.container.textContent.includes("Downloading the Python runtime"), "Visible Scripts page reads runtime status");
      await click(button("Navigate away"));
      const count = runtimeReads();
      await new Promise(resolve => setTimeout(resolve, 1_100));
      assert.equal(runtimeReads(), count, "The hidden Scripts page must stop its download-status poll");
      await click(button("Return to scripts"));
      await waitFor(() => runtimeReads() === count + 1, "Runtime status refreshes on return to the page");
      assert.equal(requests.filter(request => request === "GET /ui/api/scripts").length, 1);
      assert.equal(patches.length, 0);
      return;
    }
    if (scenario === "normalized-no-op") {
      await chooseScript(first.id);
      await type(field("Title"), ` ${first.name}  `);
      assert.deepEqual(registry.getSnapshot().dirty, []);
      assert.equal(button("Save details").disabled, true);
      await type(field("Description"), "A changed description");
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"]);
      await type(field("Description"), first.description);
      assert.deepEqual(registry.getSnapshot().dirty, []);
      assert.equal(button("Save details").disabled, true);
      assert.equal(patches.length, 0);
      return;
    }
    await chooseScript(first.id); await type(field("Title"), "My unsaved title"); await type(field("Description"), "My unsaved description");
    assert.ok(detail()?.textContent.includes("Your changes are not saved yet."));
    assert.ok(dom.container.querySelector(`.script-row[data-script-id="${first.id}"] .script-draft-badge`));
    if (scenario === "switch-drafts") {
      await chooseScript(second.id); assert.equal(field("Title").value, second.name); await chooseScript(first.id);
      assert.equal(field("Title").value, "My unsaved title"); assert.equal(field("Description").value, "My unsaved description"); assert.ok(detail()?.textContent.includes("Unsaved draft restored."));
      await chooseScript(second.id); records.set(first.id, { ...first, source: "// EXTERNALLY_UPDATED_SOURCE", revision: 2 }); await chooseScript(first.id);
      assert.equal(field("Title").value, "My unsaved title"); assert.ok(detail()?.textContent.includes("The saved script changed since this draft began.")); assert.equal(detail()?.querySelector(".script-source")?.textContent, "// EXTERNALLY_UPDATED_SOURCE");
      assert.equal(patches.length, 0); return;
    }
    if (scenario === "discard-undo") {
      await click(button("Discard draft")); assert.equal(field("Title").value, first.name); assert.equal(button("Save details").disabled, true);
      await click(button("Undo discard")); assert.equal(field("Title").value, "My unsaved title"); assert.equal(button("Save details").disabled, false);
      await click(button("Discard draft")); await chooseScript(second.id); await chooseScript(first.id); await click(button("Restore draft")); assert.equal(field("Description").value, "My unsaved description");
      assert.equal(patches.length, 0); return;
    }
    if (scenario === "navigation-draft") {
      const editor = detail();
      const count = requests.length;
      await click(button("Navigate away"));
      assert.equal(detail(), null);
      assert.ok(editor?.closest(".scripts-page[hidden][inert]"));
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"]);
      assert.deepEqual(registry.getSnapshot().busy, []);
      await click(button("Return to scripts"));
      await waitFor(() => !!detail(), "Returning to Scripts must reopen the last selected in-memory draft");
      assert.equal(detail(), editor);
      assert.equal(requests.length, count);
      assert.equal(field("Title").value, "My unsaved title");
      assert.equal(field("Description").value, "My unsaved description");
      assert.equal(patches.length, 0);
      return;
    }
    if (scenario === "workspace-owner") {
      await chooseScript(second.id);
      await type(field("Description"), "Another unsaved description");
      await click(button("Discard draft"));
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"], "Another script's draft must still protect close");
      await click(button("Change fixture workspace"));
      await waitFor(() => visible(".script-row").length === 2, "The new owner loads its workspace");
      assert.deepEqual(registry.getSnapshot().dirty, []);
      assert.equal(detail(), null);
      await chooseScript(first.id);
      assert.equal(field("Title").value, first.name);
      await chooseScript(second.id);
      assert.ok(!detail()?.textContent.includes("A discarded draft"));
      assert.equal(patches.length, 0);
      return;
    }
    if (scenario === "workspace-late-save") {
      await click(button("Save details"));
      await waitFor(() => patches.length === 1, "The first owner submits its save");
      assert.deepEqual(registry.getSnapshot().busy, ["script-details"]);
      await click(button("Change fixture workspace"));
      await waitFor(() => visible(".script-row").length === 2, "The new owner loads its workspace");
      assert.deepEqual(registry.getSnapshot().busy, []);
      await chooseScript(first.id);
      await type(field("Title"), "Current workspace edit");
      const count = requests.length;
      await act(async () => {
        const old = { ...first, revision: 2, name: "My unsaved title", description: "My unsaved description" };
        patches[0]!.response.resolve(json({ ok: true, script: old }));
      });
      assert.equal(requests.length, count, "A completed write from a retired owner cannot refresh the current workspace");
      assert.equal(field("Title").value, "Current workspace edit");
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"]);
      assert.deepEqual(registry.getSnapshot().busy, []);
      return;
    }
    if (scenario === "revision-review") {
      await type(field("Description"), first.description);
      records.set(first.id, { ...first, description: "External description", source: "// NEWER_SOURCE", revision: 2 });
      await click(button("Save details"));
      await waitFor(() => patches.length === 1, "The first compare-and-save must dispatch");
      await act(async () => { patches[0]!.response.resolve(json({ ok: false, error: "Script changed; reload before saving" }, 409)); });
      assert.equal(button("Save details").disabled, true);
      await click(button("Reload saved script"));
      await waitFor(() => !!detail()?.textContent.includes("External description"), "The saved details should be available for review");
      assert.equal(field("Title").value, "My unsaved title");
      assert.equal(field("Description").value, "External description");
      assert.equal(detail()?.querySelector(".script-source")?.textContent, "// NEWER_SOURCE");
      assert.equal(button("Save details").disabled, true);
      assert.equal(patches.length, 1);
      await click(button("Keep my edits on this version"));
      assert.equal(patches.length, 1);
      await click(button("Save details"));
      await waitFor(() => patches.length === 2, "Review should enable an explicit save");
      assert.equal(patches[1]!.input.expectedRevision, 2);
      assert.equal(patches[1]!.input.name, "My unsaved title");
      assert.equal(patches[1]!.input.description, "External description");
      assert.equal(patches[1]!.input.source, "// NEWER_SOURCE");
      await finishPatch(1);
      assert.deepEqual(registry.getSnapshot().dirty, []);
      return;
    }
    if (scenario === "unconfirmed-save") {
      await click(button("Save details"));
      await waitFor(() => patches.length === 1, "The explicit save must dispatch");
      await act(async () => {
        patches[0]!.response.resolve(json({ ok: true, script: { ...second, revision: 2 } }));
      });
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"]);
      assert.deepEqual(registry.getSnapshot().busy, []);
      assert.equal(field("Title").value, "My unsaved title");
      assert.equal(button("Save details").disabled, true);
      assert.ok(dom.container.textContent.includes("The script response could not be confirmed."));
      await click(button("Reload saved script"));
      await waitFor(() => !button("Save details").disabled, "Reload of unchanged saved data should enable retry");
      assert.equal(field("Title").value, "My unsaved title");
      assert.equal(patches.length, 1);
      return;
    }
    if (scenario === "hidden-save" || scenario === "save-list-pending") {
      await click(button("Save details"));
      await waitFor(() => patches.length === 1, "The explicit save must dispatch");
      assert.deepEqual(registry.getSnapshot().busy, ["script-details"]);
      if (scenario === "hidden-save") {
        await click(button("Navigate away"));
        assert.deepEqual(registry.getSnapshot().busy, ["script-details"]);
        const count = requests.length;
        await finishPatch(0);
        assert.equal(requests.length, count, "A save that settles hidden must not issue a follow-up read");
        await click(button("Return to scripts"));
        assert.equal(field("Title").value, "My unsaved title");
        assert.ok(dom.container.textContent.includes("Script details saved."));
      } else {
        holdRefresh = true;
        await finishPatch(0);
        await waitFor(() => heldListReads.length === 1, "The confirmed write refreshes the list");
        assert.deepEqual(registry.getSnapshot().busy, [], "A list read must not block close");
        assert.deepEqual(registry.getSnapshot().dirty, []);
        await act(async () => heldListReads[0]!.resolve(json({ ok: true, scripts: [...records.values()].map(({ source: _source, ...summary }) => summary) })));
      }
      assert.deepEqual(registry.getSnapshot().busy, []);
      assert.deepEqual(registry.getSnapshot().dirty, []);
      return;
    }
    if (scenario === "unavailable-draft") {
      records.delete(first.id);
      await click(button("Refresh scripts"));
      await waitFor(() => !!dom.container.querySelector(".script-missing-drafts details"), "An externally removed script should keep its unsaved details accessible");
      assert.equal(detail(), null);
      assert.deepEqual(registry.getSnapshot().dirty, ["script-details"]);
      const draft = dom.container.querySelector<HTMLElement>(".script-missing-drafts details")!;
      assert.ok(draft.textContent.includes("My unsaved title"));
      assert.ok(draft.textContent.includes("My unsaved description"));
      await act(async () => draft.setAttribute("open", ""));
      await click(button("Discard draft", draft));
      assert.deepEqual(registry.getSnapshot().dirty, []);
      assert.equal(patches.length, 0);
      return;
    }
    if (scenario === "replacement-keeps-draft") {
      const input = dom.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!;
      Object.defineProperty(input, "files", { configurable: true, value: [new dom.window.File(["// EXPLICIT_REPLACEMENT"], "replacement.js", { type: "text/javascript" })] });
      await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await waitFor(() => patches.length === 1, "Explicit file replacement must reach the real update API");
      assert.equal(patches[0]!.input.name, first.name, "Replacing a source file must not silently save edited details"); assert.equal(patches[0]!.input.source, "// EXPLICIT_REPLACEMENT");
      await finishPatch(0); assert.equal(field("Title").value, "My unsaved title"); assert.equal(detail()?.querySelector(".script-source")?.textContent, "// EXPLICIT_REPLACEMENT");
      assert.ok(detail()?.textContent.includes("Your detail draft is still unsaved.") || dom.container.textContent.includes("Your detail draft is still unsaved."));
      assert.ok(!detail()?.textContent.includes("The saved script changed since this draft began.")); assert.equal(patches.length, 1); return;
    }
    if (scenario === "save-failure" || scenario === "save-refresh-failure") {
      await click(button("Save details"), true); await waitFor(() => patches.length === 1, "Save details must serialize a single explicit update");
      assert.equal(patches[0]!.input.source, first.source); assert.equal(patches[0]!.input.expectedRevision, 1); assert.equal(field("Title").disabled, true);
      if (scenario === "save-failure") {
        await finishPatch(0, false); assert.equal(field("Title").value, "My unsaved title"); assert.ok(dom.container.textContent.includes("Inert script save failure"));
        await chooseScript(second.id); await chooseScript(first.id); assert.equal(field("Title").value, "My unsaved title");
        await click(button("Save details")); await waitFor(() => patches.length === 2, "A failed save must preserve the draft for an explicit retry"); await finishPatch(1);
      } else { failRefresh = true; await finishPatch(0); assert.ok(dom.container.textContent.includes("Your change was saved, but the script list could not refresh.")); }
      assert.equal(button("Save details").disabled, true); assert.equal(dom.container.querySelector(`.script-row[data-script-id="${first.id}"] .script-draft-badge`), null);
      assert.equal(records.get(first.id)?.name, "My unsaved title"); assert.ok(dom.container.textContent.includes("Script details saved.")); return;
    }
    throw new Error(`Unknown script details scenario: ${scenario}`);
  } finally {
    try { await dom.cleanup(); }
    finally {
      assert.deepEqual(unexpected, []); assert.ok(native.every(command => command === "script_capability"));
      assert.ok(requests.every(request => !/^POST .*\/scripts\/stop$/.test(request)) || scenario === "run-start-once", "Hiding a monitor must never stop a run");
      for (let index = 0; index < dom.window.localStorage.length; index++) { const value = dom.window.localStorage.getItem(dom.window.localStorage.key(index)!); assert.ok(!value?.includes("PRIVATE_SCRIPT_SOURCE")); assert.ok(!value?.includes("My unsaved title"), "Draft metadata must stay in memory rather than browser storage"); }
    }
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "switch-drafts"); console.log("script usability interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
