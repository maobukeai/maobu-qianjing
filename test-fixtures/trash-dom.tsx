import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { TrashPage } from "../web/trash.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import type { TrashProfileView } from "../src/proxy-tools-types.ts";
import type { TrashTaskSnapshot } from "../web/trash-task.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const record = (id: string, name: string, group: string): TrashProfileView => ({ id, name, group, trashedAt: 1000, canRestore: true, canPurge: true });
  let profiles = scenario === "pagination" ? Array.from({ length: 120 }, (_, index) => record(`p${index}`, `Profile ${index}`, "Parent")) : [record("one", "One", "Parent"), record("two", "Two", "Parent/Child"), record("three", "Three", "Other"), record("literal", "Literal", "Parent/Literal")];
  const folders = [{ name: "Parent" }, { name: "Parent/Child", parentName: "Parent" }, { name: "Parent/Literal" }, { name: "Other" }];
  const writes: Array<{ action: "restore" | "purge"; ids: string[]; options?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [], heldReads: Array<ReturnType<typeof deferred<Response>>> = [];
  const snapshots: TrashTaskSnapshot[] = [];
  let nativeConfirmations = 0;
  const coordinator = createWorkspaceOperationCoordinator({ currentId: "default", activeId: "default" });
  let reads = 0, failRead = scenario === "initial-load-error", holdRead = false, holdChanges = false, holdWorkspace = false, changed = 0, workspaceReads = 0;
  const changedReady = deferred<void>(), workspaceReady = deferred<void>();
  coordinator.registerWorkspaceRefresh(async () => { workspaceReads++; if (holdWorkspace) await workspaceReady.promise; });
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/trash" && (options?.method ?? "GET") === "GET") { reads++; if (holdRead) { const response = deferred<Response>(); heldReads.push(response); return response.promise; } return failRead ? Response.json({ ok: false, error: "PRIVATE_READ_ERROR" }, { status: 503 }) : Response.json({ ok: true, profiles }); }
    if (path === "/ui/api/trash/restore" || path === "/ui/api/trash/purge") { const body = JSON.parse(String(options?.body)), response = deferred<Response>(); writes.push({ action: path.endsWith("purge") ? "purge" : "restore", ids: body.ids, options, response }); return response.promise; }
    throw new Error(`Unexpected fixture request ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value(this: HTMLElement) {
      return this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => {
    nativeConfirmations++;
    return false;
  } });
  let active = scenario !== "hidden-lifecycle";
  const render = () => dom.render(<I18nProvider><WorkspaceOperationsProvider coordinator={coordinator}><input id="outside-field" /><TrashPage active={active} folderTree={folders} onChanged={async () => { changed++; if (holdChanges) await changedReady.promise; }} onTaskSnapshotChange={snapshot => { snapshots.push(snapshot); }} /></WorkspaceOperationsProvider></I18nProvider>);
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.container) => { const found = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = (node: HTMLButtonElement | HTMLInputElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const pressEscape = () => act(async () => {
    dom.window.document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  const checkbox = (label: string) => { const found = visible<HTMLInputElement>('input[type="checkbox"]').find(node => node.getAttribute("aria-label") === label); assert.ok(found, label); return found; };
  const row = (id: string) => { const found = visible<HTMLElement>(`tr[data-trash-id="${id}"]`)[0]; assert.ok(found, id); return found; };
  const select = (id: string) => row(id).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const text = () => dom.container.textContent ?? "";
  const waitFor = async (condition: () => boolean, reason: string) => { const until = Date.now() + 2500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${reason}; tail=${text().slice(-1000)}`); };
  const search = (value: string) => act(async () => { const input = dom.container.querySelector<HTMLInputElement>('input[aria-label="Search Trash"]')!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const finish = async (index: number, result: Array<{ id: string; status: string; code?: string }>, status = 200, mutate = true) => act(async () => { if (mutate) profiles = profiles.filter(profile => !result.some(row => row.id === profile.id && (row.status === "restored" || row.status === "purged"))); writes[index]!.response.resolve(Response.json(status === 200 ? { ok: true, results: result } : { ok: false, error: "PRIVATE_RESPONSE_ERROR", results: result }, { status })); });
  const success = (index: number) => writes[index]!.ids.map(id => ({ id, status: writes[index]!.action === "restore" ? "restored" : "purged" }));
  const settled = () => snapshots.at(-1)?.phase === "settled";
  const purgeDialog = () => visible<HTMLElement>('[role="alertdialog"]', dom.window.document.body)[0];
  const openPurge = async (trigger: HTMLButtonElement, count: number) => {
    trigger.focus();
    await click(trigger, true);
    await waitFor(() => !!purgeDialog(), "Permanent deletion should open the in-app confirmation");
    const dialog = purgeDialog()!;
    assert.ok(dialog.textContent?.includes(`Permanently delete ${count} profiles`));
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(dom.window.document.activeElement, button("Cancel", dialog));
    return dialog;
  };
  try {
    await render();
    if (scenario === "hidden-lifecycle") {
      assert.equal(reads, 0); assert.equal(dom.container.querySelector('.trash-page')?.hasAttribute("hidden"), true); active = true; await render();
    }
    if (scenario === "initial-load-error") {
      await waitFor(() => dom.container.querySelector('[data-trash-empty-state="error"]') !== null, "A failed initial read is an error, not an empty list"); assert.equal(dom.container.querySelector('[data-trash-empty-state="empty"]'), null); assert.equal(text().includes("PRIVATE_READ_ERROR"), false);
      const retry = button("Retry reading Trash");
      assert.equal(visible("button").filter(node => node.textContent?.trim() === retry.textContent?.trim()).length, 1);
      failRead = false; retry.focus(); await click(retry);
      await waitFor(() => visible('tr[data-trash-id]').length === 4, "Retry should load the confirmed list");
      assert.equal(dom.window.document.activeElement, button("Refresh"));
      return;
    }
    await waitFor(() => visible('tr[data-trash-id]').length === Math.min(50, profiles.length), "The actual Trash page should load local metadata");
    if (scenario === "workspace-blocked") {
      const acquired = { lease: null as ReturnType<typeof coordinator.acquire> }; await act(async () => { acquired.lease = coordinator.acquire("workspace-backup"); }); assert.ok(acquired.lease); await click(select("one")); assert.equal(button("Restore 1 selected profiles").disabled, true); assert.equal(button("Delete permanently").disabled, true); await search("Two"); assert.ok(text().includes("Hidden by filters 1")); assert.equal(writes.length, 0); await act(async () => { coordinator.release(acquired.lease!); }); return;
    }
    if (scenario === "search-selection") {
      await click(select("one")); await search("No synthetic match");
      const resets = visible<HTMLButtonElement>("button").filter(node => node.textContent?.trim() === "Reset Trash filters");
      assert.equal(resets.length, 1, "A no-result state has one filter recovery action");
      assert.ok(!text().includes("Select all 0 results"));
      await click(resets[0]!);
      assert.equal(select("one").checked, true);
      await search("Two"); assert.ok(text().includes("Matching current filters 0 · Hidden by filters 1")); await click(select("two"));
      await click(checkbox("Folder Other")); await search(""); assert.ok(text().includes("2 selected in total")); assert.ok(text().includes("Hidden by filters 2")); await click(select("three"));
      await click(button("Reset Trash filters")); assert.ok(text().includes("3 selected in total")); assert.equal(select("one").checked, true); assert.equal(select("two").checked, true); assert.equal(select("three").checked, true); assert.equal(reads, 1); assert.equal(writes.length, 0); return;
    }
    if (scenario === "pagination") {
      await click(checkbox("Select this page")); await click(button("Next", dom.container.querySelector<HTMLElement>('.proxy-pager')!)); await click(select("p70")); await search("p119"); await click(select("p119"));
      assert.ok(text().includes("52 selected in total")); assert.ok(text().includes("Hidden by filters 51")); await click(button("Restore 52 selected profiles"), true); await waitFor(() => writes.length === 1, "Page and hidden selection form one frozen request");
      assert.equal(writes[0]!.ids.length, 52); assert.ok(writes[0]!.ids.includes("p0")); assert.ok(writes[0]!.ids.includes("p70")); assert.ok(writes[0]!.ids.includes("p119")); await finish(0, success(0)); await waitFor(settled, "Bulk restore should settle"); return;
    }
    if (scenario === "folder-scope") {
      const parent = checkbox("Folder Parent");
      assert.equal(parent.closest("label")?.querySelector("small")?.textContent, "2");
      await click(select("three")); await click(parent); await search("One"); assert.ok(text().includes("Whole folder scope: 2 · Visible now: 1 · Hidden by search: 1"));
      await click(button("Restore all 2 in folder scope"), true); await waitFor(() => writes.length === 1, "Folder scope submits one frozen request"); assert.deepEqual(writes[0]!.ids, ["one", "two"]); assert.equal(writes[0]!.ids.includes("literal"), false);
      await finish(0, success(0)); await waitFor(settled, "Folder restore should settle"); assert.ok(text().includes("1 selected in total"), "An unrelated hidden selection is preserved"); assert.ok(text().includes("Restore confirmed")); return;
    }
    await click(select("one"));
    if (["partial-new-selection", "purge-confirmation"].includes(scenario)) await click(select("two"));
    if (scenario === "purge-confirmation") {
      const trigger = button("Delete permanently");
      await openPurge(trigger, 2);
      await pressEscape();
      assert.equal(purgeDialog(), undefined);
      assert.equal(dom.window.document.activeElement, trigger);
      assert.equal(writes.length, 0);
      assert.equal(select("one").checked, true);
      assert.equal(select("two").checked, true);

      const dialog = await openPurge(trigger, 2);
      await click(button("Delete permanently", dialog), true);
      await waitFor(() => writes.length === 1, "Confirmed purge issues exactly one request");
      assert.deepEqual(writes[0]!.ids, ["one", "two"]);
      await click(button("Clear all selection")); await click(select("three")); await finish(0, [{ id: "one", status: "purged" }, { id: "two", status: "failed", code: "profile_open" }]); await waitFor(settled, "Partial purge should settle");
      const retry = button("Review and retry deleting 1 failed items");
      const retryDialog = await openPurge(retry, 1);
      await click(button("Cancel", retryDialog));
      assert.equal(purgeDialog(), undefined);
      assert.equal(dom.window.document.activeElement, retry);
      assert.equal(writes.length, 1);

      const confirmedRetry = await openPurge(retry, 1);
      await click(button("Delete permanently", confirmedRetry));
      await waitFor(() => writes.length === 2, "Each retry has an explicit new confirmation"); assert.deepEqual(writes[1]!.ids, ["two"]); await finish(1, success(1)); await waitFor(settled, "Purge retry should settle"); assert.ok(text().includes("1 selected in total")); assert.equal(select("three").checked, true);
      assert.equal(nativeConfirmations, 0);
      return;
    }
    if (scenario === "purge-hidden") {
      await openPurge(button("Delete permanently"), 1);
      active = false;
      await render();
      const outside = dom.container.querySelector<HTMLInputElement>("#outside-field")!;
      outside.focus();
      await dom.flush();
      assert.equal(dom.window.document.querySelector('[role="alertdialog"]'), null);
      assert.equal(dom.window.document.activeElement, outside);
      assert.equal(writes.length, 0);
      assert.notEqual(snapshots.at(-1)?.phase, "confirming");

      active = true;
      await render();
      await waitFor(() => !button("Delete permanently").disabled, "Returning from navigation should allow a new confirmation");
      const dialog = await openPurge(button("Delete permanently"), 1);
      await click(button("Cancel", dialog));
      assert.equal(writes.length, 0);
      assert.equal(nativeConfirmations, 0);
      return;
    }
    if (scenario === "focus-after-actions") {
      const clear = button("Clear all selection");
      clear.focus(); await click(clear);
      assert.equal(dom.window.document.activeElement, dom.container.querySelector(".trash-results"));
      await click(select("one"));
      const restore = button("Restore 1 selected profiles");
      restore.focus(); await click(restore);
      await waitFor(() => writes.length === 1, "Restore should submit");
      await finish(0, success(0));
      await waitFor(settled, "Restore should settle");
      assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-trash-task-title]"));
      await click(button("Details"));
      assert.equal(visible('[data-trash-result-id="one"]').length, 1);
      const dismiss = button("Dismiss Trash operation result");
      dismiss.focus(); await click(dismiss);
      assert.equal(dom.window.document.activeElement, button("Refresh"));
      await click(select("two"));
      const restoreAgain = button("Restore 1 selected profiles");
      restoreAgain.focus(); await click(restoreAgain);
      await waitFor(() => writes.length === 2, "The second restore should submit");
      const outside = dom.container.querySelector<HTMLInputElement>("#outside-field")!;
      outside.focus();
      await finish(1, success(1));
      await waitFor(settled, "The second restore should settle");
      assert.equal(dom.window.document.activeElement, outside);
      assert.equal(button("Details").getAttribute("aria-expanded"), "false", "A new receipt starts with its optional details collapsed");
      return;
    }
    await click(button(scenario === "partial-new-selection" ? "Restore 2 selected profiles" : "Restore 1 selected profiles"), true); await waitFor(() => writes.length === 1, "Same-frame restore calls must not duplicate");
    assert.equal(writes[0]!.options?.signal, undefined); assert.equal(writes[0]!.options?.redirect, "error");
    if (scenario === "hidden-lifecycle") {
      const outside = dom.container.querySelector<HTMLInputElement>("#outside-field")!; outside.focus(); active = false; await render(); assert.equal(reads, 1); assert.equal(coordinator.getSnapshot().operation?.kind, "profile-trash");
      await finish(0, success(0)); await waitFor(settled, "Hidden task should retain its owner and complete needed refreshes"); assert.equal(reads, 2); assert.equal(dom.window.document.activeElement, outside); assert.equal(dom.container.querySelector('.trash-page')?.hasAttribute("hidden"), true); active = true; await render(); await waitFor(() => !!visible('[data-trash-task-title]').length, "Result remains reachable after returning"); return;
    }
    if (scenario === "lease-hold") {
      holdRead = true; holdChanges = true; holdWorkspace = true; await finish(0, success(0)); await waitFor(() => heldReads.length === 1 && changed === 1 && workspaceReads === 1, "All three refresh owners should start");
      assert.equal(coordinator.acquire("workspace-backup"), null); holdRead = false; await act(async () => { heldReads.splice(0).forEach(response => response.resolve(Response.json({ ok: true, profiles }))); }); assert.equal(coordinator.getSnapshot().blocked, true);
      await act(async () => { changedReady.resolve(); }); assert.equal(coordinator.getSnapshot().blocked, true); await act(async () => { workspaceReady.resolve(); }); await waitFor(settled, "Task releases only after complete refresh"); assert.equal(coordinator.getSnapshot().blocked, false); return;
    }
    if (scenario === "unknown") {
      await finish(0, [{ id: "one", status: "restored" }], 409); await waitFor(settled, "409 with a result still has no confirmed success contract"); assert.ok(text().includes("Trash result needs confirmation")); assert.equal(snapshots.at(-1)?.receipt?.succeededIds.length, 0); assert.equal(snapshots.at(-1)?.receipt?.retryIds.length, 0);
      const counts = visible<HTMLElement>(".trash-task-counts strong");
      assert.deepEqual(counts.map(node => node.textContent), ["1"], "The compact summary shows only the unconfirmed count");
      assert.ok(text().includes("Unconfirmed items aren’t retried automatically."));
      const readsBefore = reads;
      await click(button("Refresh Trash without repeating the operation")); await dom.flush();
      assert.equal(reads, readsBefore + 1);
      assert.equal(writes.length, 1); assert.equal(text().includes("PRIVATE_RESPONSE_ERROR"), false); return;
    }
    if (scenario === "refresh-failure") {
      failRead = true; await finish(0, success(0)); await waitFor(settled, "A failed refresh still settles a confirmed operation"); assert.ok(text().includes("Restore confirmed")); assert.ok(text().includes("Some lists could not refresh. Confirmed results still apply.")); assert.equal(visible('tr[data-trash-id="one"]').length, 0, "An old list cannot show the same confirmed-restored entry as still recoverable"); assert.equal(text().includes("PRIVATE_READ_ERROR"), false);
      failRead = false; await click(button("Retry reading Trash")); await dom.flush(); profiles.push({ ...record("one", "One new entry", "Parent"), trashedAt: 2000 }); await click(button("Refresh")); await dom.flush(); assert.equal(row("one").getAttribute("data-trash-entry"), "2000:none"); assert.equal(select("one").checked, false); return;
    }
    if (scenario === "retry-entry-change" || scenario === "retry-entry-version") {
      profiles = profiles.map(profile => profile.id === "one" ? { ...profile, ...(scenario === "retry-entry-change" ? { trashedAt: 2000 } : { version: 2 }) } : profile);
      await finish(0, [{ id: "one", status: "failed", code: "profile_open" }]); await waitFor(settled, "Failed original entry should remain in its receipt"); assert.equal(select("one").checked, false, "Old selection cannot select a new entry with the same ID");
      await click(button("Retry restoring 1 failed items")); await dom.flush(); assert.equal(writes.length, 1); assert.ok(text().includes("Some original Trash records changed")); assert.equal(button("Restore 0 selected profiles").disabled, true);
      await click(select("one")); await click(button("Restore 1 selected profiles")); await waitFor(() => writes.length === 2, "Explicitly selecting the new entry starts a new operation"); await finish(1, success(1)); await waitFor(settled, "The new entry can be handled deliberately"); return;
    }
    if (scenario === "success-new-entry") {
      profiles = profiles.map(profile => profile.id === "one" ? { ...profile, trashedAt: 2000 } : profile);
      await finish(0, [{ id: "one", status: "restored" }], 200, false); await waitFor(settled, "The old restore and new Trash entry remain distinct");
      assert.ok(text().includes("Restore confirmed")); assert.equal(row("one").getAttribute("data-trash-entry"), "2000:none"); assert.equal(select("one").checked, false); await click(select("one")); await click(button("Restore 1 selected profiles")); await waitFor(() => writes.length === 2, "A new entry is a deliberate new operation, not a retry of old success"); await finish(1, success(1)); await waitFor(settled, "New entry operation should settle"); return;
    }
    if (scenario === "partial-new-selection") {
      await click(select("one")); await click(select("one")); await search("Three"); await click(select("three"));
      await finish(0, [{ id: "one", status: "restored" }, { id: "two", status: "failed", code: "profile_open" }]); await waitFor(settled, "Partial restore should preserve the new selection"); assert.ok(text().includes("3 selected in total"));
      await click(button("Retry restoring 1 failed items"), true); await waitFor(() => writes.length === 2, "Retry submits only original failed IDs"); assert.deepEqual(writes[1]!.ids, ["two"]); await finish(1, success(1)); await waitFor(settled, "Retry keeps earlier success");
      assert.ok(text().includes("2 selected in total")); assert.equal(select("three").checked, true); assert.deepEqual(snapshots.at(-1)?.receipt?.succeededIds, ["one", "two"]); await click(button("Clear unavailable selections")); assert.ok(text().includes("1 selected in total")); assert.equal(select("three").checked, true); return;
    }
    throw new Error(`Unknown scenario ${scenario}`);
  } finally {
    holdRead = false; heldReads.forEach(response => response.resolve(Response.json({ ok: true, profiles }))); changedReady.resolve(); workspaceReady.resolve(); writes.forEach(write => write.response.resolve(Response.json({ ok: false }, { status: 500 }))); await dom.cleanup();
  }
}
if (import.meta.main) { try { await run(process.argv[2] ?? "search-selection"); console.log("Trash page interaction fixture passed"); } catch (error) { console.error(error); process.exitCode = 1; } }
