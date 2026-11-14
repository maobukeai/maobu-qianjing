import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const profile = (id: string) => ({ id, name: id, engine: "chromium", chromiumRuntime: "aliasmode", group: "Source", platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: id.charCodeAt(id.length - 1), createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  const profiles = [profile("file_a"), profile("file_b"), profile("file_c")], groups = ["Source"];
  const workspace = { id: "default", name: "File update workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const uploads: Array<{ file: File; ids: string[]; response: ReturnType<typeof deferred<Response>>; options?: RequestInit }> = [];
  const rosters: Array<ReturnType<typeof deferred<Response>>> = [], views: Array<{ response: ReturnType<typeof deferred<Response>>; body: unknown }> = [];
  let holdRoster = false, holdViews = false, failRoster = false, rosterReads = 0, jobRunning = false;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const roster = () => ({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) });
  const job = () => ({ id: "running_job", kind: "backup", status: "running", phase: "packing", completed: 0, total: 10 });
  const overview = () => ({ ok: true, workspaceId: "default", root: "inert-file-fixture", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: jobRunning, scriptRunning: false });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/profiles/update-file" && method === "POST") {
      assert.ok(options?.body instanceof FormData); const form = options.body as FormData, entries = [...form.entries()]; assert.equal(entries.length, 1); assert.equal(entries[0]?.[0], "files");
      const file: unknown = form.get("files"); assert.ok(file instanceof File); const contents = await file.text(), response = deferred<Response>();
      uploads.push({ file, ids: contents.split(/\r?\n/).slice(1).map(line => line.split(",")[0]!).filter(Boolean), response, options }); return response.promise;
    }
    if (path === "/ui/api/profiles" && method === "GET") { rosterReads++; if (holdRoster) { const response = deferred<Response>(); rosters.push(response); return response.promise; } return failRoster ? json({ ok: false, error: "PRIVATE_REFRESH_DETAIL" }, 503) : json(roster()); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: { "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groups].map(name => [name, false])) } });
    if (path === "/ui/api/workspace/jobs/running_job") return json({ ok: true, job: job() });
    if ((path === "/ui/api/workspace/overview" || path === "/ui/api/workspace/backups") && method === "GET") {
      const body = path.endsWith("overview") ? overview() : { ok: true, backups: [], jobs: jobRunning ? [job()] : [] };
      if (holdViews) { const response = deferred<Response>(); views.push({ response, body }); return response.promise; } return json(body);
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-file-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace, { ...workspace, id: "other", name: "Other workspace" }] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App file update request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const created = createRealRoot(...args); root = created; return created; } }));
  const body = dom.window.document.body;
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = body) => { const found = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (target: HTMLButtonElement | HTMLInputElement, twice = false) => act(async () => { target.click(); if (twice) target.click(); });
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 3000; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; requests=${JSON.stringify(requests)}; page=${body.textContent?.slice(-1000)}`); };
  const row = (id: string) => { const found = visible<HTMLElement>(`tr[data-profile-id="${id}"]`)[0]; assert.ok(found, id); return found; };
  const select = (id: string) => row(id).querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`)!;
  const panel = () => visible<HTMLElement>(".profile-file-update-panel")[0]!;
  const pick = async (target = "file_c") => act(async () => {
    const field = visible<HTMLElement>(".profile-file-update-dialog")[0]?.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(field);
    Object.defineProperty(field, "files", { configurable: true, value: [new File([`id,name,password\n${target},File change,PRIVATE_ACCOUNT_PAYLOAD`], "C:\\PRIVATE_LOCAL_PATH\\PRIVATE_ACCOUNT_EXPORT.csv", { type: "text/csv" })] }); field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const success = (updated = 1) => ({ ok: true, updated, skipped: 0, notFound: [], errors: [] });
  const finish = (index: number, reply: unknown = success(), status = 200) => act(async () => {
    if (reply && typeof reply === "object" && "ok" in reply && reply.ok === true) for (const id of uploads[index]!.ids) { const current = profiles.find(item => item.id === id); if (current) current.name = "File change"; }
    uploads[index]!.response.resolve(json(reply, status));
  });
  const releaseRosters = () => act(async () => { holdRoster = false; for (const response of rosters.splice(0)) response.resolve(json(roster())); });
  const releaseViews = () => act(async () => { holdViews = false; for (const view of views.splice(0)) view.response.resolve(json(view.body)); });
  const openWorkspace = async () => { await click(button("Command palette")); const command = visible<HTMLElement>('[role="option"]').find(node => node.querySelector("strong")?.textContent === "Workspace management"); assert.ok(command); await act(async () => { command.click(); }); await waitFor(() => visible(".wm-page").length === 1, "Workspace page must remain accessible"); };
  const viewFromActivity = async () => { await click(button("Background activity, 1 tasks")); await click(button("View Update profiles from file")); await waitFor(() => !!panel(), "Activity should return to the retained file update result"); };
  try {
    await act(async () => { await import("../web/app.tsx"); }); await waitFor(() => visible('tr[data-profile-id]').length === 3 && !visible<HTMLButtonElement>('[role="radio"]').find(node => node.textContent === "Compact")?.disabled, "App must load profiles and preferences");
    await click(select("file_a")); await click(button("More actions")); await click(button("Edit from file")); await pick();
    assert.equal(body.textContent?.includes("PRIVATE"), false); assert.ok(body.textContent?.includes("The current selection does not limit this update"));
    if (scenario === "workspace-block") {
      await click(button("Close")); jobRunning = true; await openWorkspace(); await waitFor(() => requests.some(request => request.path === "/ui/api/workspace/jobs/running_job"), "The coordinator must observe real backup maintenance");
      await click(button("Back to environments")); await click(button("Edit from file")); assert.ok(visible(".profile-file-update-selection").length);
      await click(button("Update profiles"), true); await dom.flush(); assert.equal(uploads.length, 0); assert.ok(body.textContent?.includes("A workspace task is in progress")); assert.equal(button("Update profiles").disabled, false); return;
    }
    await click(button("Update profiles"), true); await waitFor(() => uploads.length === 1, "Same-frame submissions must send one file only");
    assert.deepEqual(uploads[0]!.ids, ["file_c"], "File IDs, not the selected environment, determine the update scope"); assert.equal(uploads[0]!.file.name, "profile-update.csv");
    assert.equal(uploads[0]!.options?.redirect, "error"); assert.equal(uploads[0]!.options?.credentials, "same-origin"); assert.equal(uploads[0]!.options?.cache, "no-store");
    const initialReads = rosterReads;
    if (scenario === "owner-unmount") {
      assert.ok(root); await act(async () => { root!.unmount(); root = null; }); const getCount = requests.filter(request => request.method === "GET").length;
      assert.equal(uploads[0]!.options?.signal?.aborted ?? false, false); await finish(0); await dom.flush(); assert.equal(rosterReads, initialReads); assert.equal(requests.filter(request => request.method === "GET").length, getCount); return;
    }
    await click(button("Hide window · update continues")); assert.equal(visible(".profile-file-update-dialog").length, 0); assert.ok(row("file_a").querySelector<HTMLButtonElement>(".row-start")!.disabled); assert.ok(row("file_c").querySelector<HTMLButtonElement>(".row-start")!.disabled);
    assert.ok(button("Dismiss file update results").disabled);
    if (scenario === "close-ai-activity") {
      await click(button("AI workspace")); assert.ok(visible(".assistant-workspace").length); await viewFromActivity(); assert.ok(panel().textContent?.includes("Updating profiles from the selected file"));
      await finish(0); await waitFor(() => !!panel()?.textContent?.includes("File update saved"), "A hidden upload must continue to completion"); assert.equal(uploads.length, 1); return;
    }
    if (scenario === "full-refresh-lock") {
      await openWorkspace(); await click(button("Backup and restore")); assert.ok(button("Create full backup").disabled); holdRoster = true; holdViews = true; await finish(0);
      await waitFor(() => rosters.length > 0 && views.length >= 2, "Ownership includes roster, overview and backup history refreshes");
      await releaseRosters(); assert.ok(button("Create full backup").disabled); await releaseViews(); await waitFor(() => !button("Create full backup").disabled, "Maintenance unlocks after every refresh settles"); return;
    }
    if (scenario === "unknown-no-replay") {
      await finish(0, { updated: 1, skipped: 0, notFound: [], errors: [] }); await waitFor(() => !!panel()?.textContent?.includes("File update result unknown"), "Missing ok must retain unknown outcome");
      await click(button("AI workspace")); await viewFromActivity(); await click(button("Choose corrected or different file"));
      assert.equal(button("Update profiles").disabled, true); assert.ok(body.textContent?.includes("The upload may have saved")); assert.equal(uploads.length, 1); return;
    }
    if (scenario === "atomic-rejected") {
      await finish(0, { ok: false, updated: 0, skipped: 1, notFound: ["missing_one"], errors: [{ id: "file_c", error: "invalid resolution: PRIVATE_BAD_SCREEN" }, { id: "../PRIVATE_PATH", error: "PRIVATE_ACCOUNT_ERROR" }] }, 400);
      await waitFor(() => !!panel()?.textContent?.includes("File validation failed · nothing saved"), "Atomic validation refusal must not claim a partial save"); await click(button("View file update details"));
      assert.ok(panel().textContent?.includes("Valid-looking rows in this upload were not applied")); assert.ok(panel().textContent?.includes("Identifier withheld")); assert.equal(profiles.find(item => item.id === "file_c")?.name, "file_c"); assert.equal(body.textContent?.includes("PRIVATE"), false); return;
    }
    if (scenario === "refresh-failure") {
      failRoster = true; await finish(0); await waitFor(() => !!panel()?.textContent?.includes("File update saved"), "A failed refresh must preserve confirmed saving"); await click(button("View file update details"));
      assert.ok(panel().textContent?.includes("This does not undo a confirmed save")); assert.equal(panel().textContent?.includes("File update result unknown"), false); assert.equal(uploads.length, 1); return;
    }
    await finish(0, { ok: true, updated: 1, skipped: 1, notFound: ["missing_one", "missing_one"], errors: [] });
    await waitFor(() => !!panel()?.textContent?.includes("Some environments saved; file needs review"), "Partial successful update should retain unmatched-row information");
    assert.equal(profiles.find(item => item.id === "file_a")?.name, "file_a"); assert.equal(profiles.find(item => item.id === "file_c")?.name, "File change"); assert.equal(select("file_a").checked, true);
    await click(button("View file update details")); assert.ok(panel().textContent?.includes("View 1 distinct unmatched IDs"));
    await click(button("Choose corrected or different file")); assert.ok(visible(".profile-file-update-selection").length, "Closing retained the private selection"); assert.equal(button("Update profiles").disabled, true);
    await pick("file_b"); assert.equal(button("Update profiles").disabled, false); assert.ok(panel().textContent?.includes("Some environments saved; file needs review"), "Choosing another file cannot erase the partial receipt");
    await click(button("Update profiles"), true); await waitFor(() => uploads.length === 2, "An explicit new selection can start one new upload"); await finish(1);
    await waitFor(() => !!panel()?.textContent?.includes("File update saved"), "The new update gets a separate receipt"); assert.ok(panel().textContent?.includes("Earlier file update results (1)")); assert.ok(panel().textContent?.includes("Some environments saved; file needs review")); assert.equal(button("Update profiles").disabled, true); assert.equal(body.textContent?.includes("PRIVATE"), false); assert.deepEqual(unexpected, []);
  } finally {
    holdRoster = false; holdViews = false; for (const response of rosters) response.resolve(json(roster())); for (const view of views) view.response.resolve(json(view.body)); for (const upload of uploads) upload.response.resolve(json({ ok: false, error: "Fixture teardown" }, 500));
    if (root) await act(async () => { root!.unmount(); }); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
try { await run(process.argv[2] ?? "partial-and-reselect"); console.log("actual App profile file update fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
