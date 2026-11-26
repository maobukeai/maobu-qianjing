import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";
import { activityTrigger, viewActivityTask } from "./activity-interaction.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const pendingReview = scenario.startsWith("pending-review-");
  const profile = (id: string) => ({ id, name: id, engine: "chromium", chromiumRuntime: "aliasmode", group: "Source", platform: "example.com", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, pendingCookieCount: pendingReview ? 1 : 0, seeded: true, screen: "1920x1080", has2fa: false, serial: id.charCodeAt(id.length - 1), createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  const profiles = [profile("cookie_a"), profile("cookie_b"), profile("cookie_c")], groups = ["Source"];
  const workspace = { id: "default", name: "Cookie fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }, records = [workspace, { ...workspace, id: "other", name: "Other workspace" }];
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const imports: Array<{ ids: string[]; input: Record<string, string>; response: ReturnType<typeof deferred<Response>>; options?: RequestInit }> = [];
  const pendingReads: Array<{ id: string; response: ReturnType<typeof deferred<Response>>; signal?: AbortSignal | null }> = [];
  const pendingRemovals: Array<{ id: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const rosters: Array<ReturnType<typeof deferred<Response>>> = [], views: Array<{ response: ReturnType<typeof deferred<Response>>; body: unknown }> = [];
  let holdRoster = false, holdViews = false, rosterReads = 0, currentWorkspace = "default";
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const roster = () => ({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) });
  const overview = () => ({ ok: true, workspaceId: currentWorkspace, root: "inert-cookie-fixture", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/profiles/cookies" && method === "POST") {
      const { ids, ...payload } = JSON.parse(String(options?.body)); const response = deferred<Response>(); imports.push({ ids, input: payload, response, options }); return response.promise;
    }
    const pendingRoute = /^\/ui\/api\/profiles\/([^/]+)\/pending-cookies(\/clear)?$/.exec(path);
    if (pendingReview && pendingRoute && method === (pendingRoute[2] ? "POST" : "GET")) {
      const response = deferred<Response>();
      const entry = { id: pendingRoute[1]!, response, signal: options?.signal };
      (pendingRoute[2] ? pendingRemovals : pendingReads).push(entry);
      return response.promise;
    }
    if (path === "/ui/api/profiles" && method === "GET") { rosterReads++; if (holdRoster) { const response = deferred<Response>(); rosters.push(response); return response.promise; } return json(roster()); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: { "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groups].map(name => [name, false])) } });
    if (path.startsWith("/ui/api/workspaces/") && method === "PATCH") {
      const id = path.split("/").at(-1), saved = records.find(record => record.id === id); assert.ok(saved); Object.assign(saved, JSON.parse(String(options?.body))); return json({ ok: true, workspace: saved });
    }
    if ((path === "/ui/api/workspace/overview" || path === "/ui/api/workspace/backups") && method === "GET") {
      const body = path.endsWith("overview") ? overview() : { ok: true, backups: [], jobs: [] };
      if (holdViews) { const response = deferred<Response>(); views.push({ response, body }); return response.promise; } return json(body);
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-cookie-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: currentWorkspace, activeId: currentWorkspace, workspaces: records },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App cookie request ${method} ${path}`);
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
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 3000; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; requests=${JSON.stringify(requests)}; page=${body.textContent?.slice(-1200)}`); };
  const row = (id: string) => { const found = visible<HTMLElement>(`tr[data-profile-id="${id}"]`)[0]; assert.ok(found, id); return found; };
  const select = (id: string) => row(id).querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`)!;
  const panel = () => visible<HTMLElement>(".cookie-import-task")[0]!;
  const finish = (index: number, reply: unknown, status = 200) => act(async () => { imports[index]!.response.resolve(json(reply, status)); });
  const success = (count: number) => ({ ok: true, count: 1, live: 0, nextStart: count, errors: [] });
  const releaseRosters = () => act(async () => { holdRoster = false; for (const response of rosters.splice(0)) response.resolve(json(roster())); });
  const releaseViews = () => act(async () => { holdViews = false; for (const item of views.splice(0)) item.response.resolve(json(item.body)); });
  const openWorkspace = async () => {
    await click(button("Command palette")); const command = visible<HTMLElement>('[role="option"]').find(node => node.querySelector("strong")?.textContent === "Workspace management"); assert.ok(command);
    await act(async () => { command.click(); }); await waitFor(() => visible(".wm-page").length === 1, "Workspace management must remain navigable");
  };
  const saveWorkspaceAndReload = async (name: string) => {
    const field = visible<HTMLInputElement>('.wm-identity-card input')[0]; assert.ok(field);
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, name); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    const before = requests.filter(request => request.path === "/ui/api/workspaces").length;
    await click(button("Save changes")); await waitFor(() => requests.filter(request => request.path === "/ui/api/workspaces").length > before && !!visible<HTMLElement>(".wm-success").length, "Saving metadata refreshes the real workspace catalog");
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible('tr[data-profile-id]').length === 3 && !visible<HTMLButtonElement>('[role="radio"]').find(node => node.textContent === "Compact")?.disabled, "App must load the roster and workspace preferences");
    if (pendingReview) {
      const dialog = () => visible<HTMLElement>('[role="dialog"]')[0]!;
      const open = (id: string) => click(button("1 cookie(s) at next start", row(id)));
      const resolveRead = (index: number, reply: unknown, status = 200) => act(async () => pendingReads[index]!.response.resolve(json(reply, status)));
      const oneCookie = (domain: string) => ({ ok: true, cookies: [{ domain, name: "synthetic-session" }] });
      const clear = () => button("Remove pending cookies", dialog());
      const canRemove = () => visible<HTMLButtonElement>("button", dialog()).some(item => item.textContent?.trim() === "Remove pending cookies" && !item.disabled);
      await open("cookie_a");
      if (scenario === "pending-review-ownership") {
        await click(button("Close", dialog()));
        await open("cookie_b");
        assert.deepEqual(pendingReads.map(entry => entry.id), ["cookie_a", "cookie_b"]);
        assert.equal(pendingReads[0]!.signal?.aborted, true, "Closing a pending read aborts it");
        await resolveRead(0, oneCookie("earlier.invalid"));
        assert.equal(dialog().textContent?.includes("earlier.invalid"), false, "A stale read must not populate another environment's dialog");
        assert.equal(clear().disabled, true, "Removal must wait for a verified result from the current environment");
        await click(button("Close", dialog()));
        await open("cookie_b");
        await resolveRead(1, oneCookie("superseded.invalid"));
        assert.equal(dialog().textContent?.includes("superseded.invalid"), false, "A closed request cannot replace a reopened dialog for the same environment");
        await resolveRead(2, oneCookie("current.invalid"));
        assert.ok(dialog().textContent?.includes("current.invalid"));
        await click(clear(), true);
        assert.deepEqual(pendingRemovals.map(entry => entry.id), ["cookie_b"], "Same-frame clicks must issue only one removal for the reviewed environment");
        await act(async () => { pendingRemovals[0]!.response.resolve(json({ ok: true, removed: 1 })); });
        await waitFor(() => !dialog(), "A successful removal closes its own dialog");
      } else {
        await resolveRead(0, { ok: false, error: "Fixture PRIVATE_COOKIE_VALUE" }, 503);
        assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? "", /Cookies could not be loaded/);
        assert.equal(dialog().textContent?.includes("PRIVATE_COOKIE_VALUE"), false);
        assert.equal(dialog().textContent?.includes("No cookies are queued for the next start."), false, "A failed read is not an empty queue");
        assert.equal(canRemove(), false);
        await click(button("Retry", dialog()), true);
        assert.deepEqual(pendingReads.map(entry => entry.id), ["cookie_a", "cookie_a"], "Retry performs a single read for the same environment");
        await resolveRead(1, { ok: true });
        assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? "", /Cookies could not be loaded/);
        assert.equal(canRemove(), false);
        await click(button("Retry", dialog()));
        await resolveRead(2, oneCookie("current.invalid"));
        await click(clear());
        assert.deepEqual(pendingRemovals.map(entry => entry.id), ["cookie_a"]);
        await act(async () => { pendingRemovals[0]!.response.resolve(json({ ok: true })); });
        assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? "", /Cookie removal could not be confirmed/);
        assert.equal(canRemove(), false, "An unconfirmed removal must be rechecked before another removal is available");
        await click(button("Retry", dialog()));
        await resolveRead(3, { ok: true, cookies: [] });
        assert.ok(dialog().textContent?.includes("No cookies are queued for the next start."));
        assert.equal(clear().disabled, true);
        assert.deepEqual(pendingRemovals.map(entry => entry.id), ["cookie_a"], "Retry never replays the removal");
      }
      assert.deepEqual(unexpected, []);
      return;
    }
    await click(select("cookie_a")); await click(select("cookie_c")); await click(button("More actions")); await click(button("Add cookies"));
    const textarea = visible<HTMLTextAreaElement>(".cookie-import-dialog textarea")[0]; assert.ok(textarea);
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, '[{"name":"session","value":"PRIVATE_COOKIE_FIXTURE_219","domain":"example.com","path":"/"}]'); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await click(button("Import cookies"), true); await waitFor(() => imports.length === 1, "Same-frame import submissions must issue exactly one POST");
    assert.deepEqual(imports[0]!.ids, ["cookie_a", "cookie_c"]); assert.equal(imports[0]!.options?.redirect, "error"); assert.equal(imports[0]!.options?.credentials, "same-origin"); assert.equal(imports[0]!.options?.cache, "no-store");
    assert.equal(visible(".cookie-import-dialog textarea").length, 0); assert.equal(body.textContent?.includes("PRIVATE_COOKIE_FIXTURE_219"), false);
    const initialReads = rosterReads;
    if (scenario === "owner-unmount") {
      assert.ok(root); await act(async () => { root!.unmount(); root = null; }); const readCount = requests.filter(request => request.method === "GET").length;
      assert.equal(imports[0]!.options?.signal?.aborted ?? false, false); await finish(0, success(2)); await dom.flush();
      assert.equal(rosterReads, initialReads); assert.equal(requests.filter(request => request.method === "GET").length, readCount, "Unmount must not begin roster or workspace reads"); return;
    }
    await click(button("Hide window · import continues")); assert.equal(visible('[role="dialog"]').length, 0); assert.ok(row("cookie_a").querySelector<HTMLButtonElement>(".row-start")!.disabled);
    assert.ok(button("Dismiss cookie import result").disabled);
    if (scenario === "close-navigation" || scenario === "refresh-lease") {
      await openWorkspace(); assert.ok(body.textContent?.includes("Cookie import in progress"));
      await click(button("Backup and restore")); assert.ok(button("Create full backup").disabled); assert.ok(button("Restore from file").disabled);
      if (scenario === "refresh-lease") {
        holdRoster = true; holdViews = true; await finish(0, success(2));
        await waitFor(() => rosters.length > 0 && views.length >= 2, "Cookie ownership includes roster, overview and backup history refreshes");
        await releaseRosters(); assert.ok(button("Create full backup").disabled, "A completed roster read cannot release pending workspace refreshes");
        await releaseViews(); await waitFor(() => !button("Create full backup").disabled, "Workspace maintenance unlocks after all refreshes settle");
      } else {
        assert.ok(activityTrigger(dom)); await viewActivityTask(dom, "Cookie import");
        await waitFor(() => !!panel(), "The cross-page topbar entry returns to the active import"); assert.ok(panel().textContent?.includes("Importing cookies…"));
        await finish(0, success(2)); await waitFor(() => !!panel()?.textContent?.includes("Cookie import completed"), "The hidden write continues to completion");
      }
      assert.equal(imports.length, 1); return;
    }
    if (scenario === "unknown-no-replay") {
      await finish(0, { count: 1, live: 0, nextStart: 2, errors: [] }); await waitFor(() => !!panel()?.textContent?.includes("Cookie import needs confirmation"), "Missing ok is unknown rather than success");
      assert.equal(visible<HTMLButtonElement>("button").some(node => node.textContent?.includes("Retry 2 failed")), false);
      await click(button("View cookie import details")); await click(button("Hide cookie import details")); await openWorkspace(); await viewActivityTask(dom, "Cookie import"); await dom.flush();
      assert.equal(imports.length, 1); assert.ok(panel().textContent?.includes("This request will not be sent again automatically.")); return;
    }
    await finish(0, { ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "cookie_c", error: "PRIVATE_COOKIE_FIXTURE_219" }] });
    await waitFor(() => !!panel()?.textContent?.includes("Retry 1 failed environments") && !button("Retry 1 failed environments").disabled, "Partial completion must offer only the explicit failed environment");
    assert.equal(body.textContent?.includes("PRIVATE_COOKIE_FIXTURE_219"), false);
    if (scenario === "original-workspace") {
      await openWorkspace(); currentWorkspace = "other"; await saveWorkspaceAndReload("Fixture catalog changed");
      await viewActivityTask(dom, "Cookie import"); await click(button("Retry 1 failed environments")); await dom.flush();
      assert.equal(imports.length, 1); assert.ok(panel().textContent?.includes("Return to the original workspace"));
      await openWorkspace(); currentWorkspace = "default"; await saveWorkspaceAndReload("Fixture catalog returned"); await viewActivityTask(dom, "Cookie import");
    }
    // Change the current selection: retry must keep the original failed ID and payload.
    await click(button("Clear selection")); await click(select("cookie_b"));
    await click(button("Retry 1 failed environments"), true); await waitFor(() => imports.length === 2, "Failure retry is synchronously guarded");
    assert.deepEqual(imports[1]!.ids, ["cookie_c"]); assert.deepEqual(imports[1]!.input, imports[0]!.input);
    await finish(1, success(1)); await waitFor(() => !!panel()?.textContent?.includes("Cookie import completed"), "Retry must preserve prior successes");
    assert.equal(imports.length, 2); assert.equal(body.textContent?.includes("PRIVATE_COOKIE_FIXTURE_219"), false); assert.equal(select("cookie_b").checked, true);
    await click(button("View cookie import details")); assert.ok(panel().textContent?.includes("1 open browser(s) now, 1 at next start"));
    assert.deepEqual(unexpected, []);
  } finally {
    holdRoster = false; holdViews = false; for (const response of rosters) response.resolve(json(roster())); for (const view of views) view.response.resolve(json(view.body)); for (const request of imports) request.response.resolve(json({ ok: false, error: "Fixture teardown" }, 400));
    for (const entry of [...pendingReads, ...pendingRemovals]) entry.response.resolve(json({ ok: false, error: "Fixture teardown" }, 400));
    if (root) await act(async () => { root!.unmount(); }); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
try { await run(process.argv[2] ?? "partial-retry"); console.log("actual App cookie import fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
