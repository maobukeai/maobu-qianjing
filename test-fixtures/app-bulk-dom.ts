import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";
import { activityTask, activityTrigger, viewActivityTask } from "./activity-interaction.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function profile(index: number) {
  return { id: `batch_${index}`, name: `Environment ${index}`, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], extensions: [], proxy: null,
    timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false };
}

async function run(scenario: string) {
  const count = scenario === "bounded-stop-cross-page" || scenario === "external-workspace-change" ? 8 : scenario === "owner-unmount" ? 6 : scenario === "ineligible-targets" ? 5 : scenario === "strict-api-result" ? 1 : 2;
  let profiles = Array.from({ length: count }, (_, index) => profile(index + 1));
  if (scenario === "ineligible-targets" || scenario === "close-ineligible") profiles[0]!.running = true;
  if (scenario === "ineligible-targets") profiles[1]!.mobilePersona = true;
  const ids = profiles.map(item => item.id);
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const actions: Array<{ id: string; action: "open" | "close"; response: ReturnType<typeof deferred<Response>>; signal: AbortSignal | null | undefined }> = [];
  const heldRosters: Array<ReturnType<typeof deferred<Response>>> = [];
  let holdRoster = false, inflight = 0, peak = 0;
  const json = (value: unknown) => Response.json(value);
  const roster = () => ({ ok: true, profiles, groups: [], folders: [] });
  const workspace = { id: "default", name: "Inert fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const coordinated = scenario === "workspace-maintenance-gate" || scenario === "external-workspace-change" || scenario === "successful-batch-workspace-refresh";
  const secondWorkspace = { ...workspace, id: "second", name: "Inert second workspace" };
  let workspaceCurrent = "default";
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    requests.push({ path, method });
    if (!path.startsWith("/ui/api/")) { unexpected.push(path); throw new Error(`Non-fixture request blocked: ${path}`); }
    const action = /^\/ui\/api\/profiles\/([^/]+)\/(open|close)$/.exec(path);
    if (method === "POST" && action) {
      const response = deferred<Response>();
      actions.push({ id: decodeURIComponent(action[1]!), action: action[2] as "open" | "close", response, signal: options?.signal });
      inflight++; peak = Math.max(peak, inflight);
      return response.promise.finally(() => { inflight--; });
    }
    if (path === "/ui/api/profiles" && method === "GET") {
      if (holdRoster) { const pending = deferred<Response>(); heldRosters.push(pending); return pending.promise; }
      return json(roster());
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: {} });
    if (coordinated && path === "/ui/api/workspaces/default" && method === "PATCH") { workspace.name = JSON.parse(String(options?.body)).name; return json({ ok: true, workspace }); }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-fixture-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: workspaceCurrent, activeId: workspaceCurrent, workspaces: coordinated ? [workspace, secondWorkspace] : [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-fixture-root", profileCount: profiles.length, trashCount: 0, runningCount: profiles.filter(item => item.running).length, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled in this fixture"); } });
  let appRoot: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const root = createRealRoot(...args); appRoot = root; return root; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.container) => {
    const item = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
    assert.ok(item, `Missing interactive button: ${label}`); return item;
  };
  const click = async (item: HTMLButtonElement | HTMLInputElement, twice = false) => act(async () => { item.click(); if (twice) item.click(); });
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 2500;
    while (!condition() && Date.now() < deadline) await dom.flush();
    assert.ok(condition(), `${message}; requested=${JSON.stringify(requests)}; text=${dom.container.textContent?.slice(-2500)}`);
  };
  const tableRows = () => visible<HTMLElement>("tr[data-profile-id]");
  const tableRow = (id: string) => { const row = tableRows().find(item => item.dataset.profileId === id); assert.ok(row); return row; };
  const rowStart = (id: string) => { const item = visible<HTMLButtonElement>(".row-start", tableRow(id))[0]; assert.ok(item); return item; };
  const toolbar = (action: "open" | "close") => { const item = visible<HTMLButtonElement>(".toolbar.active > button").find(node => node.textContent?.trim() === (action === "open" ? "Start" : "Stop")); assert.ok(item); return item; };
  const panel = () => visible<HTMLElement>(".bulk-profile-task-panel")[0];
  const results = () => panel() ? visible<HTMLElement>(".bulk-task-row", panel()!) : [];
  const result = (id: string) => { const item = results().find(row => row.querySelector("code")?.textContent === id); assert.ok(item, `Missing visible task row ${id}`); return item; };
  const selectAll = async () => {
    const check = visible<HTMLInputElement>('input[aria-label="Select all visible profiles"]')[0]; assert.ok(check); await click(check);
  };
  const expand = async () => { if (panel()?.querySelector(".bulk-task-expand")?.getAttribute("aria-expanded") !== "true") await click(button("Show task details", panel()!)); };
  const finish = async (actionIndex: number, body: Record<string, unknown>, reachedGoal = body.ok === true) => act(async () => {
    const item = actions[actionIndex]; assert.ok(item);
    if (reachedGoal) { const current = profiles.find(p => p.id === item.id); if (current) current.running = item.action === "open"; }
    item.response.resolve(json(body));
  });
  const releaseRosters = async () => act(async () => { holdRoster = false; for (const pending of heldRosters.splice(0)) pending.resolve(json(roster())); });
  const settled = (success: number, failed: number, skipped: number) => !!panel()?.textContent?.includes(`Task finished: ${success} succeeded, ${failed} failed, ${skipped} skipped.`);
  const refreshing = () => !!panel() && visible<HTMLElement>('[role="status"]', panel()!).some(node => node.textContent === "Refreshing environment status before retry…");
  const openWorkspacePage = async () => {
    await click(button("Command palette"));
    const command = visible<HTMLElement>('[role="option"]', dom.window.document.body).find(node => node.querySelector("strong")?.textContent === "Workspace management"); assert.ok(command);
    await act(async () => { command.click(); });
    await waitFor(() => visible<HTMLElement>(".wm-page").length === 1, "Workspace management must remain reachable while a task runs");
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => tableRows().length === count, "Actual App bootstrap must reach its roster");
    assert.ok(appRoot); assert.deepEqual(unexpected, []);
    if (scenario === "ineligible-targets") {
      await selectAll();
      await click(rowStart(ids[3]!));
      await waitFor(() => actions.length === 1, "The separate row action must start");
      profiles = profiles.filter(item => item.id !== ids[4]);
      await click(button("Refresh profiles"));
      await waitFor(() => tableRows().length === 4, "Refresh must remove the deleted environment while preserving selected IDs");
      await click(toolbar("open"));
      await waitFor(() => !!panel() && actions.length === 2, "The batch must send only its eligible environment");
      await expand();
      assert.equal(results().length, 5);
      for (const [id, reason] of [[ids[0], "This environment is already running."], [ids[1], "Convert the imported mobile identity before starting this environment."], [ids[3], "Another action is already using this environment."], [ids[4], "This environment is no longer in the current list."]]) {
        assert.ok(result(id!).classList.contains("skipped")); assert.ok(result(id!).textContent.includes(reason!));
      }
      assert.equal(actions[1]!.id, ids[2]);
      await finish(0, { ok: true }); await finish(1, { ok: true });
      await waitFor(() => settled(1, 0, 4) && !refreshing(), "Mixed eligibility must settle honestly");
    } else if (scenario === "close-ineligible") {
      await selectAll(); await click(toolbar("close"));
      await waitFor(() => actions.length === 1, "Close must dispatch its running environment");
      assert.equal(actions[0]!.action, "close"); assert.equal(actions[0]!.id, ids[0]);
      await expand(); assert.ok(result(ids[1]!).textContent.includes("This environment is already stopped."));
      await finish(0, { ok: true });
      await waitFor(() => settled(1, 0, 1) && !refreshing(), "Close must preserve the stopped-item skip");
      assert.ok(visible<HTMLButtonElement>(".row-start", tableRow(ids[0]!)).length);
    } else {
      await selectAll(); await click(toolbar("open"), true);
      await waitFor(() => actions.length === Math.min(count, 4), "The task must dispatch at most four requests");
      assert.equal(peak, Math.min(count, 4)); assert.equal(toolbar("open").disabled, true); assert.equal(toolbar("close").disabled, true);
      if (scenario === "workspace-maintenance-gate") {
        await openWorkspacePage();
        assert.ok(dom.container.textContent?.includes("An environment batch task is running."));
        await click(button("Inert second workspaceLocal workspace"));
        assert.ok(button("Switch to this workspace").disabled);
        assert.equal(visible<HTMLInputElement>('input[maxlength="40"]')[0]?.disabled, false);
        await click(button("Backup and restore"));
        assert.ok(button("Create full backup").disabled); assert.ok(button("Restore from file").disabled);
        holdRoster = true;
        await finish(0, { ok: false, error: "Inert fixture start refused" }); await finish(1, { ok: false, error: "Inert fixture start refused" });
        await waitFor(() => heldRosters.length > 0 && !!dom.container.textContent?.includes("Refreshing the environment list. Workspace actions will unlock shortly."), "Workspace controls stay locked during the root task's final refresh");
        assert.ok(button("Create full backup").disabled);
        await releaseRosters();
        await waitFor(() => !button("Create full backup").disabled, "Workspace maintenance unlocks only after the root refresh finishes");
        assert.equal(button("Restore from file").disabled, false);
        await click(button("Workspaces2")); assert.equal(button("Switch to this workspace").disabled, false);
        assert.equal(actions.length, 2); assert.equal(requests.some(item => item.method === "POST" && /activate|backups|restore/.test(item.path)), false);
      } else if (scenario === "successful-batch-workspace-refresh") {
        await openWorkspacePage(); await click(button("Backup and restore"));
        assert.ok(button("Create full backup").disabled);
        await finish(0, { ok: true }); await finish(1, { ok: true });
        await waitFor(() => !!dom.container.textContent?.includes("Stop running browsers and scripts before creating a full backup."), "The batch's final refresh must update the workspace running count");
        assert.ok(button("Create full backup").disabled); assert.equal(button("Restore from file").disabled, false);
      } else if (scenario === "external-workspace-change") {
        await openWorkspacePage();
        const name = visible<HTMLInputElement>('input[maxlength="40"]')[0]!;
        await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "Fixture edited name"); name.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
        workspaceCurrent = "second";
        await click(button("Save changes"));
        await waitFor(() => !!dom.container.textContent?.includes("Workspace saved."), "A catalog refresh must observe an external workspace change");
        for (let index = 0; index < 4; index++) await finish(index, { ok: true });
        await viewActivityTask(dom, "Batch task");
        await waitFor(() => settled(4, 1, 3) && !refreshing(), "Queued work must stop when its originating workspace changes");
        assert.equal(actions.length, 4, "No queued environment may be dispatched against the other workspace");
        assert.ok(result(ids[4]!).textContent?.includes("The workspace changed while this task was waiting. No request was sent."));
      } else if (scenario === "bounded-stop-cross-page") {
        assert.equal(rowStart(ids[4]!).disabled, true, "Queued rows must be owned by the task");
        await click(button("AI workspace"));
        await waitFor(() => !visible<HTMLElement>(".profiles-workspace").length, "Global navigation must remain available");
        assert.equal(actions.length, 4); assert.ok((await activityTask(dom, "Batch task")).textContent.includes("0 of 8"));
        await viewActivityTask(dom, "Batch task");
        await waitFor(() => results().length === 8, "Returning through progress must preserve the same task and open its details");
        assert.equal(actions.length, 4); assert.equal(result(ids[0]!).classList.contains("running"), true);
        await click(button("Stop queued items", panel()!));
        assert.equal(results().filter(item => item.classList.contains("skipped")).length, 4);
        assert.ok(result(ids[4]!).textContent.includes("Stopped before dispatch. No request was sent for this environment."));
        assert.equal(rowStart(ids[4]!).disabled, false, "Undispatched rows must be unlocked after stopping the queue");
        assert.equal(rowStart(ids[0]!).disabled, true, "Issued requests must remain busy until their actual response");
        assert.ok(actions.every(item => !item.signal?.aborted));
        await click(button("Collapse task details", panel()!)); assert.equal(results().length, 0);
        assert.ok((await activityTask(dom, "Batch task")).textContent.includes("4 of 8")); await viewActivityTask(dom, "Batch task"); assert.equal(results().length, 8);
        for (let index = 0; index < 4; index++) await finish(index, { ok: true });
        await waitFor(() => settled(4, 0, 4) && !refreshing(), "Issued operations must settle without dispatching stopped work");
        assert.equal(actions.length, 4); assert.equal(peak, 4); assert.equal(toolbar("open").disabled, false);
        assert.ok(panel()!.querySelector(".bulk-task-indicator")!.classList.contains("has-skipped"));
      } else if (scenario === "retry-refresh-gate") {
        await finish(0, { ok: true }); holdRoster = true;
        await finish(1, { ok: false, error: "Inert action refused" });
        await waitFor(() => heldRosters.length > 0 && refreshing() && results().length === 2, "A final roster refresh must gate retries and expose the failed result");
        assert.ok(result(ids[1]!).textContent.includes("Inert action refused")); assert.ok(result(ids[1]!).textContent.includes("Attempt 1"));
        const retry = button("Retry 1 failed items", panel()!), dismiss = button("Dismiss batch task", panel()!);
        assert.equal(retry.disabled, true); assert.equal(dismiss.disabled, true); assert.equal(toolbar("open").disabled, true); assert.equal(toolbar("close").disabled, true);
        await click(retry, true); await click(dismiss); await click(toolbar("open")); assert.equal(actions.length, 2); assert.ok(panel());
        await releaseRosters();
        await waitFor(() => !refreshing() && !button("Retry 1 failed items", panel()!).disabled, "Retry must enable after the final status refresh");
        await click(button("Retry 1 failed items", panel()!), true);
        await waitFor(() => actions.length === 3, "Double retry must send a single failed environment");
        assert.deepEqual(actions.map(item => item.id), [ids[0], ids[1], ids[1]]);
        await finish(2, { ok: true });
        await waitFor(() => settled(2, 0, 0) && !refreshing(), "Retry must settle with the earlier success preserved");
        assert.ok(result(ids[0]!).textContent.includes("Attempt 1")); assert.ok(result(ids[1]!).textContent.includes("Attempt 2"));
        await click(button("Dismiss batch task", panel()!)); assert.equal(panel(), undefined); assert.equal(activityTrigger(dom), null);
      } else if (scenario === "retry-current-state") {
        await finish(0, { ok: true }); await finish(1, { ok: false, error: "Unconfirmed start" }, true);
        await waitFor(() => settled(1, 1, 0) && !refreshing() && !button("Retry 1 failed items", panel()!).disabled, "A failed confirmation must remain failed after refreshing actual state");
        await click(button("Retry 1 failed items", panel()!));
        await waitFor(() => settled(2, 0, 0) && !refreshing(), "Retry must recognize a refreshed environment that already reached its target");
        assert.equal(actions.length, 2, "An already running environment must not receive a duplicate start");
        assert.ok(result(ids[1]!).textContent.includes("Already running; no extra start request was sent."));
      } else if (scenario === "strict-api-result") {
        await finish(0, { port: 1234 }, false);
        await waitFor(() => settled(0, 1, 0) && !refreshing(), "Missing API ok must become a real item failure");
        assert.ok(result(ids[0]!).textContent.includes("The local service returned an incomplete action result."));
        assert.equal(result(ids[0]!).classList.contains("succeeded"), false);
      } else if (scenario === "owner-unmount") {
        await act(async () => { appRoot!.unmount(); appRoot = null; });
        assert.equal(dom.container.childElementCount, 0); assert.ok(actions.every(item => !item.signal?.aborted));
        for (let index = 0; index < 4; index++) await finish(index, { ok: true });
        await dom.flush(); assert.equal(actions.length, 4, "Unmount may stop queued dispatch but must not invent cancellation of issued operations");
        assert.equal(inflight, 0);
      } else throw new Error(`Unknown scenario: ${scenario}`);
    }
    assert.deepEqual(unexpected, []);
  } finally {
    if (appRoot) await act(async () => { appRoot!.unmount(); });
    // Never leave a held in-memory response alive after an assertion fails.
    holdRoster = false; for (const pending of heldRosters) pending.resolve(json(roster()));
    for (const action of actions) action.response.resolve(json({ ok: false, error: "Fixture teardown" }));
    await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}

await run(process.argv[2] ?? "bounded-stop-cross-page");
console.log("actual App bulk task interaction fixture passed");
