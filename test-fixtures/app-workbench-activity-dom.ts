import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement } from "happy-dom";
import type { ScriptRun } from "../src/scripts.ts";
import { createWebDomHarness } from "./web-dom.ts";
import { activityTask, activityTrigger, openActivity, viewActivityTask } from "./activity-interaction.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const profile = (id: string, serial: number) => ({ id, name: id, engine: "chromium", chromiumRuntime: "aliasmode", group: "Source", platform: "example.com", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  const profiles = [profile("activity_a", 1), profile("activity_b", 2)], groups = ["Source", "Destination"];
  const workspace = { id: "default", name: "Activity fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [], native: string[] = [];
  const cookies = deferred<Response>(); let cookieWrites = 0, scriptWrites = 0, moveWrites = 0, uploadWrites = 0, batchWrites = 0;
  const trashResponse = deferred<Response>(), trashRosterRefresh = deferred<Response>(); let trashWrites = 0, trashRestored = false;
  const trashEntry = { id: "activity_deleted", name: "Deleted fixture environment", group: "Source", trashedAt: Date.now() - 3600_000, version: 1, canRestore: true, canPurge: true };
  const proxyApplyResponse = deferred<Response>(), proxyRosterRefresh = deferred<Response>();
  const operationScope = "10000000-0000-4000-8000-000000000001", previewId = "1-10000000-0000-4000-8000-000000000002";
  const proxyRows = profiles.map((profile, index) => ({ index, profileId: profile.id, name: profile.name, group: profile.group, previousProxy: null, proxy: `http://fixture.invalid:${8000 + index}`, status: "ready" }));
  const proxyResults = proxyRows.map(row => ({ ...row, status: "updated" }));
  let proxyWrites = 0, proxyFinished = false, proxyStatusReads = 0, proxyPreviews = 0;
  let serverRun: ScriptRun | null = null;
  const script = { id: "activity_script", name: "Activity fixture script", description: "Inert fixture", language: "javascript", revision: 1, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
  const makeRun = (status: ScriptRun["status"]): ScriptRun => ({ id: "activity_run", scriptName: script.name, status, profiles: profiles.map(profile => ({ id: profile.id, name: profile.name, status: status === "finished" ? "succeeded" : "running" })) });
  const json = (value: unknown) => Response.json(value);
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/proxies/preview" && method === "POST") {
      if (++proxyPreviews === 1) return json({ ok: true, previewId, operationScope, rows: proxyRows, unusedProxies: 0 });
      const rows = [
        { ...proxyRows[0]!, proxy: "http://fixture.invalid:8100" },
        { ...proxyRows[1]!, proxy: null, status: "skipped", code: "no_replacement" },
      ];
      return json({ ok: true, previewId: `${previewId}-second`, operationScope, rows, unusedProxies: 0 });
    }
    if (path === "/ui/api/proxies/apply" && method === "POST") { proxyWrites++; return proxyApplyResponse.promise; }
    if (path.startsWith("/ui/api/proxies/operations/") && method === "GET") {
      proxyStatusReads++;
      const url = new URL(path, "http://fixture.invalid"), attemptId = url.pathname.split("/").at(-1);
      assert.equal(url.searchParams.get("previewId"), previewId); assert.equal(url.searchParams.get("operationScope"), operationScope);
      if (proxyWrites === 0) return Response.json({ ok: false, code: "operation_not_found" }, { status: 404 });
      return json({ ok: true, operation: { version: 1, operationScope, previewId, attemptId, phase: "settled", total: proxyResults.length,
        rows: proxyResults.map(({ index, profileId, status }) => ({ index, profileId, status })), startedAt: 100, finishedAt: 200 } });
    }
    if (path === "/ui/api/trash" && method === "GET") return json({ ok: true, profiles: trashRestored ? [] : [trashEntry] });
    if (path === "/ui/api/trash/restore" && method === "POST") { trashWrites++; assert.deepEqual(JSON.parse(String(options?.body)), { ids: [trashEntry.id] }); return trashResponse.promise; }
    if (path === "/ui/api/import/upload" && method === "POST") { uploadWrites++; return json({ ok: true, profiles: 1, files: 1, cookiesStripped: 0, skipped: 1, errors: [{ file: "inert.json", id: "ignored_record", error: "An unsupported row was skipped." }] }); }
    if (path === "/ui/api/profiles/move" && method === "POST") { moveWrites++; const body = JSON.parse(String(options?.body)); for (const profile of profiles) if (body.ids.includes(profile.id)) profile.group = body.group; return json({ ok: true, moved: body.ids.length, group: body.group }); }
    const batch = /^\/ui\/api\/profiles\/(activity_[ab])\/open$/.exec(path);
    if (batch && method === "POST") { batchWrites++; if (batch[1] === "activity_a") { profiles[0]!.running = true; return json({ ok: true }); } return json({ ok: false, error: "Inert browser start refusal" }); }
    if (path === "/ui/api/profiles/cookies" && method === "POST") { cookieWrites++; return cookies.promise; }
    if (path === "/ui/api/scripts" && method === "GET") return json({ ok: true, scripts: [script] });
    if (path === "/ui/api/scripts/run" && method === "GET") return json({ ok: true, run: serverRun });
    if (path === "/ui/api/scripts/run" && method === "POST") { scriptWrites++; serverRun = makeRun(scenario === "shared-script-observer" ? "running" : "finished"); return json({ ok: true, run: serverRun }); }
    if (path.startsWith("/ui/api/scripts/log?") && method === "GET") return json({ ok: true, text: "", nextOffset: 0 });
    if (path === "/ui/api/profiles" && method === "GET") { if (trashRestored) return trashRosterRefresh.promise; if (proxyFinished) return proxyRosterRefresh.promise; return json({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) }); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: { "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groups].map(name => [name, false])) } });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-activity-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/settings/assistant/services": { ok: true, catalog: { services: [], defaultId: null } },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-activity-fixture", profileCount: profiles.length, trashCount: 0, runningCount: profiles.filter(profile => profile.running).length, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected full App activity request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const created = createRealRoot(...args); root = created; return created; } }));
  const body = dom.window.document.body;
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = body) => { const node = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(node, `Missing ${label}`); return node; };
  const click = (node: HTMLButtonElement | HTMLInputElement) => act(async () => { node.click(); });
  const type = (node: HTMLTextAreaElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 3000; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; requests=${JSON.stringify(requests)}; tail=${body.textContent?.slice(-1400)}`); };
  const check = (id: string) => { const node = visible<HTMLInputElement>(`tr[data-profile-id="${id}"] td.chk input`)[0]; assert.ok(node, id); return node; };
  const selectProfiles = async () => { for (const profile of profiles) if (!check(profile.id).checked) await click(check(profile.id)); };
  const more = async () => { const entry = visible<HTMLButtonElement>(".bulk-tools-toggle")[0]; assert.ok(entry); if (entry.getAttribute("aria-expanded") !== "true") await click(entry); };
  const writeCounts = () => ({ cookieWrites, scriptWrites, moveWrites, uploadWrites, batchWrites });
  const openScript = async () => {
    Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string) => { native.push(command); assert.equal(command, "script_capability"); return "inert-script-capability"; } } });
    await more(); await click(button("Run script", visible<HTMLElement>(".bulk-advanced")[0]!));
    const monitor = () => visible<HTMLElement>(".script-run-modal")[0];
    await waitFor(() => !!monitor() && monitor()!.querySelector(".modal-body")?.getAttribute("aria-busy") === "false", "Actual run monitor must read the script library");
    const select = monitor()!.querySelector<HTMLSelectElement>("select")!; await act(async () => { select.value = script.id; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await click(button("Run script", monitor()!)); await waitFor(() => scriptWrites === 1 && !!monitor()?.textContent?.includes(script.name), "Only an explicit monitor action starts the script");
    await click(button("Close monitor", monitor()!));
  };
  const goAI = async () => { await click(button("AI workspace")); await waitFor(() => visible(".profiles-workspace").length === 0, "The real AI page should be active"); };
  try {
    await act(async () => { await import("../web/app.tsx"); }); await waitFor(() => visible("tr[data-profile-id]").length === 2, "Full App should load its actual roster");
    assert.equal(activityTrigger(dom), null); assert.equal(requests.some(request => request.path.startsWith("/ui/api/scripts")), false);
    assert.equal(requests.some(request => request.path === "/ui/api/trash"), false, "The hidden Trash page must not read until visited");
    if (scenario === "proxy-owner") {
      await click(button("Proxies"));
      await click(button("Replace proxies"));
      const input = visible<HTMLTextAreaElement>('textarea[aria-label="Replacement input"]')[0]; assert.ok(input);
      await type(input, "fixture.invalid:8000\nfixture.invalid:8001"); await click(button("Preview changes"));
      await waitFor(() => visible("[data-proxy-task-title]").length > 0 || body.textContent!.includes("Apply 2 changes"), "The actual proxy replacement should show a review");
      await click(button("Apply 2 changes")); await waitFor(() => proxyWrites === 1, "One admitted replacement must start");
      await goAI(); assert.ok((await activityTask(dom, "Proxy assignment")).classList.contains("is-running"));
      await viewActivityTask(dom, "Proxy assignment");
      await waitFor(() => dom.window.document.activeElement?.matches("[data-proxy-task-title]") ?? false, "Opening the task must return and focus its heading");
      await goAI(); proxyFinished = true;
      const events = [...proxyResults.map(row => ({ type: "replacement", row })), { type: "done" }];
      await act(async () => proxyApplyResponse.resolve(new Response(events.map(value => JSON.stringify(value)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } })));
      await waitFor(() => requests.filter(request => request.path === "/ui/api/profiles").length === 2, "Confirmed operation must refresh the roster");
      assert.ok((await activityTask(dom, "Proxy assignment")).classList.contains("is-running"));
      const focusedWhileRefreshing = dom.window.document.activeElement;
      await act(async () => proxyRosterRefresh.resolve(json({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) })));
      await waitFor(() => !activityTrigger(dom)?.querySelector(".workbench-activity-running"), "The proxy result must settle after refreshing");
      assert.equal(button("AI workspace").getAttribute("aria-current"), "page");
      assert.equal(dom.window.document.activeElement, focusedWhileRefreshing, "Background completion keeps the user's current focus");
      assert.ok((await activityTask(dom, "Proxy assignment")).classList.contains("is-complete"));
      await click(button("Proxies"));
      await click(visible<HTMLButtonElement>('.tools-tabs button[data-proxy-tab="check"]')[0]!);
      assert.equal(visible("[data-proxy-review-title]").length, 0);
      await goAI();
      await viewActivityTask(dom, "Proxy assignment");
      await waitFor(() => dom.window.document.activeElement?.matches("[data-proxy-review-title]") ?? false, "Activity must open the latest completed receipt and focus its details from the Check proxies tab");
      assert.equal(button("Replace proxies").getAttribute("aria-pressed"), "true");
      assert.match(visible(".proxy-table")[0]!.textContent!, /activity_a[\s\S]*Updated[\s\S]*activity_b[\s\S]*Updated/);

      const nextInput = visible<HTMLTextAreaElement>('textarea[aria-label="Replacement input"]')[0]!;
      await type(nextInput, "fixture.invalid:8100");
      await click(button("Preview changes"));
      await waitFor(() => proxyPreviews === 2 && visible(".proxy-table")[0]?.textContent?.includes("8100") === true, "Second preview is ready");
      assert.equal(button("Apply 1 changes").disabled, false);
      await goAI();
      assert.ok((await activityTask(dom, "Proxy assignment")).classList.contains("is-complete"), "The new preview's skipped row does not change the previous receipt's status");
      await viewActivityTask(dom, "Proxy assignment");
      await waitFor(() => dom.window.document.activeElement?.matches("[data-proxy-task-title]") ?? false, "When the old receipt has no current detail ledger, focus its summary");
      assert.equal(dom.window.document.activeElement?.textContent, "Most recent completed proxy replacement");
      assert.match(visible(".proxy-task-card")[0]!.textContent!, /2 updated · 2 rows in this batch/);
      assert.equal(button("Apply 1 changes").disabled, false, "Reading the old receipt preserves the new preview");
      assert.equal(proxyWrites, 1); assert.equal(proxyStatusReads, 2); assert.deepEqual(unexpected, []); return;
    }
    if (scenario.startsWith("trash-")) {
      await click(button("Trash")); await waitFor(() => visible('tr[data-trash-id="activity_deleted"]').length === 1, "The actual Trash page should load only after navigation");
      const entry = visible<HTMLInputElement>('tr[data-trash-id="activity_deleted"] input')[0]!; await click(entry); await click(button("Restore 1 selected profiles"));
      await waitFor(() => trashWrites === 1, "Restore must issue one frozen-ID request"); await goAI();
      assert.ok((await activityTask(dom, "Trash operation")).classList.contains("is-running"));
      await viewActivityTask(dom, "Trash operation"); await waitFor(() => dom.window.document.activeElement?.matches(".trash-task-panel h3") ?? false, "The activity entry must focus the still-owned result");
      assert.equal(trashWrites, 1, "Viewing a pending task must never replay restore"); await goAI();
      trashRestored = true;
      await act(async () => { trashResponse.resolve(json({ ok: true, results: [{ id: trashEntry.id, status: "restored" }] })); });
      await waitFor(() => requests.filter(request => request.path === "/ui/api/profiles").length === 2, "Confirmed restore must refresh the roster before releasing its task");
      assert.ok((await activityTask(dom, "Trash operation")).classList.contains("is-running"), "The task remains running through the strict roster read");
      await act(async () => { trashRosterRefresh.resolve(scenario === "trash-refresh-failure" ? json({ ok: false }) : json({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) })); });
      await waitFor(() => !activityTrigger(dom)?.querySelector(".workbench-activity-running"), "Only completed refreshes can end running ownership");
      assert.ok((await activityTask(dom, "Trash operation")).classList.contains(scenario === "trash-refresh-failure" ? "is-attention" : "is-complete"));
      await viewActivityTask(dom, "Trash operation");
      await waitFor(() => visible(".trash-task-counts strong")[0]?.textContent === "1", "The confirmed restore count must remain available across navigation");
      assert.equal(visible('tr[data-trash-id="activity_deleted"]').length, 0); assert.equal(trashWrites, 1);
      if (scenario === "trash-refresh-failure") assert.ok(visible<HTMLElement>(".trash-task-panel")[0]!.textContent!.includes("Some lists could not refresh. Confirmed results still apply."));
      await click(button("Dismiss Trash operation result")); await waitFor(() => activityTrigger(dom) === null, "Dismissing only the receipt removes its activity entry"); assert.deepEqual(unexpected, []); return;
    }
    if (scenario === "idle") {
      const before = [...requests]; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); }); assert.deepEqual(requests, before); assert.deepEqual(writeCounts(), { cookieWrites: 0, scriptWrites: 0, moveWrites: 0, uploadWrites: 0, batchWrites: 0 }); return;
    }
    if (scenario === "shared-script-observer") {
      await selectProfiles(); await openScript(); await goAI();
      assert.equal(activityTrigger(dom)?.getAttribute("aria-label"), "Background activity, 1 tasks");
      const reads = requests.filter(request => request.path === "/ui/api/scripts/run" && request.method === "GET").length, logs = requests.filter(request => request.path.startsWith("/ui/api/scripts/log?")).length;
      serverRun = makeRun("finished"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); });
      assert.equal(requests.filter(request => request.path === "/ui/api/scripts/run" && request.method === "GET").length, reads + 1, "The shell and hidden monitor must share one completion observer");
      assert.equal(requests.filter(request => request.path.startsWith("/ui/api/scripts/log?")).length, logs, "A hidden monitor and task entry must not read logs");
      assert.ok((await activityTask(dom, "Script run")).classList.contains("is-complete"));
      const completeReads = requests.length; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); }); assert.equal(requests.length, completeReads); assert.equal(scriptWrites, 1); return;
    }

    await act(async () => { const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(['[{"id":"activity_a"}]'], "inert.json", { type: "application/json" })], types: ["Files"] } }); visible<HTMLElement>(".app")[0]!.dispatchEvent(drop); });
    await waitFor(() => !!visible<HTMLElement>(".import-receipt")[0] && !button("Dismiss import result").disabled, "A real import response should produce a reviewable receipt");
    await selectProfiles(); await more();
    const destination = visible<HTMLSelectElement>('select[aria-label="Move to group"]')[0]!; await act(async () => { destination.value = "group:Destination"; destination.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await click(button("Move")); await waitFor(() => !!visible<HTMLElement>(".profile-move-feedback.is-confirmed")[0], "Real move confirmation should produce a result");
    await selectProfiles(); await click(button("Start", visible<HTMLElement>(".toolbar.active")[0]!));
    await waitFor(() => !!visible<HTMLElement>(".bulk-profile-task-panel")[0]?.textContent?.includes("1 failed") && !button("Start", visible<HTMLElement>(".toolbar.active")[0]!).disabled, "A partial batch should finish and release its refresh lease");
    await openScript();
    await more(); await click(button("Add cookies"));
    const cookieDialog = visible<HTMLElement>(".cookie-import-dialog")[0]!; assert.ok(cookieDialog);
    await type(cookieDialog.querySelector<HTMLTextAreaElement>("textarea")!, '[{"name":"session","value":"inert-fixture","domain":"example.com","path":"/"}]');
    await click(button("Import cookies", cookieDialog)); await waitFor(() => cookieWrites === 1, "The cookie import starts only after explicit submission");
    await click(button("Hide window · import continues", cookieDialog)); await goAI();
    assert.equal(activityTrigger(dom)?.getAttribute("aria-label"), "Background activity, 5 tasks");
    const beforeOpen = [...requests], beforeWrites = writeCounts(), popup = await openActivity(dom);
    assert.deepEqual(requests, beforeOpen, "Opening the activity list must not fetch any task status");
    assert.equal(popup.querySelectorAll(".workbench-activity-item").length, 5);
    assert.equal(popup.querySelectorAll(".is-running").length, 1); assert.equal(popup.querySelectorAll(".is-attention").length, 2); assert.equal(popup.querySelectorAll(".is-complete").length, 2);
    assert.equal(popup.querySelector("h3")?.textContent, "Cookie import");
    for (const [title, selector, focusSelector] of [["Cookie import", ".cookie-import-task", ".cookie-import-result-anchor"], ["Batch task", ".bulk-profile-task-panel", ".bulk-task-expand"], ["Import profiles", ".import-receipt", ".import-receipt-controls button"], ["Move environments", ".profile-move-feedback", ".profile-move-result-anchor"]]) {
      await viewActivityTask(dom, title!); await waitFor(() => !!visible<HTMLElement>(selector!)[0], `View ${title} should return from AI to its actual result`);
      await waitFor(() => visible<HTMLElement>(focusSelector!)[0] === dom.window.document.activeElement, `View ${title} should focus its result control`);
      assert.deepEqual(writeCounts(), beforeWrites, "Viewing a task must never replay its operation"); await goAI();
    }
    await viewActivityTask(dom, "Script run"); await waitFor(() => !!visible<HTMLElement>(".script-run-modal")[0], "Script task opens its real monitor over AI");
    assert.equal(dom.window.document.activeElement, button("Close run monitor")); await click(button("Close monitor")); assert.deepEqual(writeCounts(), beforeWrites);
    await act(async () => { cookies.resolve(json({ ok: true, count: 1, live: 1, nextStart: 1, errors: [] })); });
    await waitFor(() => !!activityTrigger(dom) && !activityTrigger(dom)!.querySelector(".workbench-activity-running"), "The entry should reflect external completion without losing other task owners");
    assert.equal(activityTrigger(dom)?.getAttribute("aria-label"), "Background activity, 5 tasks"); assert.deepEqual(writeCounts(), { cookieWrites: 1, scriptWrites: 1, moveWrites: 1, uploadWrites: 1, batchWrites: 2 }); assert.deepEqual(unexpected, []);
  } finally {
    if (root) await act(async () => { root!.unmount(); }); cookies.resolve(json({ ok: false, count: 0, live: 0, nextStart: 0, errors: [] }));
    const { backgroundScriptRuns } = await import("../web/background-script-run.tsx"); backgroundScriptRuns.dispose(); await dom.cleanup();
    for (const [name, descriptor] of originalGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
try { await run(process.argv[2] ?? "multiple-owners"); console.log("actual App workbench activity fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
