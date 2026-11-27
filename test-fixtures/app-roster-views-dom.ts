import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLElement } from "happy-dom";
import type { FolderInfo } from "../src/folders.ts";
import { FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY, type SavedProfileView } from "../src/profile-view-state.ts";
import { createWebDomHarness } from "./web-dom.ts";

const PAGE_KEY = "aliasmode.roster.pageSize", COLUMNS_KEY = "aliasmode.roster.hiddenColumns", SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function profile(index: number) {
  return { id: `environment_${index}`, name: `Environment ${index}`, engine: "chromium", chromiumRuntime: "aliasmode", group: index <= 35 ? "A" : "B", platform: "", tags: [], extensions: [], proxy: null,
    timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index, createdAt: 1, lastOpenAt: 0, customNo: "", running: index % 10 === 0, mobilePersona: false };
}
async function run(scenario: string) {
  const paletteScenario = scenario === "palette-saved-views";
  const heldCatalog = scenario === "sidebar-boot-preference" ? deferred<Response>() : null;
  const large = scenario === "saved-view-apply", heldLoad = scenario === "preference-loading-guard" || scenario === "preference-read-retry" || paletteScenario || heldCatalog !== null;
  const profiles = Array.from({ length: large ? 60 : 4 }, (_, index) => profile(index + 1));
  if (paletteScenario) profiles[3]!.group = "B";
  const folders: FolderInfo[] = [{ name: "A" }, { name: "B" }];
  if (scenario === "group-filter-hierarchy") {
    profiles[1]!.group = "A/Nested";
    profiles[2]!.group = "";
    profiles[3]!.group = "B";
    folders.push({ name: "A/Nested", parentName: "A", label: "Nested" });
  }
  const now = Date.now();
  if (scenario === "recent-flat-order") {
    profiles[0]!.group = "B"; profiles[0]!.lastOpenAt = now - 3000;
    profiles[1]!.group = "A"; profiles[1]!.lastOpenAt = now - 1000; profiles[1]!.running = false;
    profiles[2]!.group = "A"; profiles[2]!.lastOpenAt = now - 5000; profiles[2]!.running = true;
    profiles[3]!.lastOpenAt = now - 8 * 86_400_000;
  }
  const saved: SavedProfileView = { id: `view_${"a".repeat(32)}`, name: "Focused saved view", filters: { scope: "favorites", query: "Environment", group: "A", status: "stopped", sort: { key: "name", dir: -1 }, hiddenColumns: ["no", "group", "platform", "tags", "proxy", "status"], pageSize: 25 } };
  if (scenario === "missing-group-recovery") Object.assign(saved.filters, { query: "Environment 2", group: "Removed group", status: "stopped", pageSize: 20 });
  if (paletteScenario) { saved.name = "Résumé"; saved.filters.query = "id:environment_2"; }
  const similar: SavedProfileView = { ...saved, id: `view_${"b".repeat(32)}`, name: "Resume", filters: { ...saved.filters, group: "B", scope: "all", query: "" } };
  const preferences: Record<string, string> = { [FAVORITE_PROFILES_KEY]: JSON.stringify(large ? profiles.filter(item => item.group === "A").map(item => item.id) : scenario === "missing-group-recovery" || paletteScenario ? [profiles[1]!.id] : []), [SAVED_PROFILE_VIEWS_KEY]: JSON.stringify(paletteScenario ? [saved, similar] : ["saved-view-apply", "missing-group-recovery"].includes(scenario) ? [saved] : []) };
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const reads: Array<ReturnType<typeof deferred<Response>>> = [];
  const controlledRoster = scenario === "roster-recovery";
  const rosterReads: Array<ReturnType<typeof deferred<Response>>> = [];
  const rosterResponse = (entries = profiles) => Response.json({ ok: true, profiles: entries, groups: folders.map(folder => folder.name), folders });
  const writes: Array<{ key: string; value: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const metadataWrites = () => writes.filter(item => [FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY].includes(item.key));
  const workspace = { id: "default", name: "Roster views fixture", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const otherWorkspace = { ...workspace, id: "second", name: "Second workspace" };
  let workspaceId = workspace.id;
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (heldCatalog && path === "/ui/api/workspaces") return heldCatalog.promise;
    if (path === "/ui/api/profiles" && method === "GET") {
      if (!controlledRoster) return rosterResponse();
      const response = deferred<Response>(); rosterReads.push(response); return response.promise;
    }
    if (path === "/ui/api/workspace/preferences") {
      if (method === "GET") { const response = deferred<Response>(); reads.push(response); if (!heldLoad) response.resolve(Response.json({ ok: true, preferences })); return response.promise; }
      if (method === "POST") {
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(Object.keys(body).sort(), ["key", "value"]);
        const response = deferred<Response>(); writes.push({ ...body, response });
        if (![FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY].includes(body.key) && !(heldCatalog && body.key === SIDEBAR_KEY)) { preferences[body.key] = body.value; response.resolve(Response.json({ ok: true })); }
        return response.promise;
      }
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-roster-views-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: workspaceId, activeId: workspaceId, workspaces: paletteScenario ? [workspace, otherWorkspace] : [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-roster-views-fixture", profileCount: profiles.length, trashCount: 0, runningCount: profiles.filter(item => item.running).length, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected roster view fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  if (heldLoad) { dom.window.localStorage.setItem(FAVORITE_PROFILES_KEY, JSON.stringify([profiles[0]!.id])); dom.window.localStorage.setItem(SAVED_PROFILE_VIEWS_KEY, "[]"); }
  // These cases exercise an explicit compact preference; the new first-run layout is expanded.
  if (heldCatalog || scenario === "group-filter-hierarchy") dom.window.localStorage.setItem(SIDEBAR_KEY, "1");
  if (paletteScenario) dom.window.localStorage.setItem(SAVED_PROFILE_VIEWS_KEY, JSON.stringify([{ ...saved, name: "Stale cached view" }]));
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const result = createRealRoot(...args); root = result; return result; } }));
  const workspaceAccess: { refresh?: () => Promise<unknown> } = {};
  if (paletteScenario) {
    const workspaceManager = await import("../web/workspace-manager.tsx"), useActualCatalog = workspaceManager.useWorkspaceCatalog;
    mock.module("../web/workspace-manager.tsx", () => ({ ...workspaceManager, useWorkspaceCatalog() { const result = useActualCatalog(); workspaceAccess.refresh = result.refresh; return result; } }));
  }
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const rows = () => visible<HTMLElement>("tr[data-profile-id]");
  const ids = () => rows().map(node => node.dataset.profileId);
  const viewSelect = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Environment view"]')!;
  const pageSize = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Rows per page"]')!;
  const groupSelect = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Group filter"]')!;
  const search = () => dom.container.querySelector<HTMLInputElement>('.heading-search input')!;
  const views = () => dom.container.querySelector<HTMLElement>(".roster-views")!;
  const empty = () => dom.container.querySelector<HTMLElement>(".emptystate")!;
  const button = (label: string, scope: HTMLElement = dom.container) => { const item = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(item, `Missing button: ${label}`); return item; };
  const favorite = (id: string) => { const row = rows().find(item => item.dataset.profileId === id); assert.ok(row, `Missing row ${id}`); const star = row.querySelector<HTMLButtonElement>(".profile-favorite"); assert.ok(star); return star; };
  const click = async (node: HTMLButtonElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const select = async (node: HTMLSelectElement, value: string) => act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const type = async (node: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, description: string) => { const until = Date.now() + 2500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${description}; writes=${JSON.stringify(writes.map(item => ({ key: item.key, value: item.value })))}; text=${dom.container.textContent?.slice(-1400)}`); };
  const resolveWrite = async (index: number, ok = true) => act(async () => { const write = metadataWrites()[index]; assert.ok(write); if (ok) preferences[write.key] = write.value; write.response.resolve(Response.json(ok ? { ok: true } : { ok: false, error: "Inert preference write failure" }, { status: ok ? 200 : 500 })); });
  const status = (name: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('.profile-status-tabs button')].find(node => node.textContent?.startsWith(name))!;
  try {
    await act(async () => { await import("../web/app.tsx"); });
    if (controlledRoster) {
      const failRead = () => Response.json({ ok: false, error: "Fixture roster service temporarily unavailable" }, { status: 503 });
      const recovery = () => dom.container.querySelector<HTMLElement>(".roster-recovery");
      await waitFor(() => rosterReads.length === 1 && !!dom.container.querySelector('.profile-table[aria-busy="true"]'), "First read shows loading");
      await act(async () => rosterReads[0]!.resolve(failRead()));
      await waitFor(() => !dom.container.querySelector('.profile-table[aria-busy="true"]'), "First read finishes with a failure");
      assert.ok(!empty(), "A failed first read must not report that the workspace is empty");
      assert.match(recovery()!.textContent, /Could not load environments/);
      assert.equal(rows().length, 0);
      const retry = button("Retry", recovery()!);
      retry.focus();
      await click(retry, true);
      await waitFor(() => rosterReads.length === 2, "Retry reads the roster");
      assert.equal(retry.getAttribute("aria-disabled"), "true");
      await act(async () => rosterReads[1]!.resolve(rosterResponse()));
      await waitFor(() => rows().length === profiles.length && !recovery(), "Successful retry displays the roster");
      assert.equal(dom.window.document.activeElement?.id, "profiles-page-title");
      assert.equal(rosterReads.length, 2);

      await type(search(), "Environment 2");
      assert.deepEqual(ids(), ["environment_2"]);
      await click(button("Refresh profiles"));
      await waitFor(() => rosterReads.length === 3, "Refresh starts a read");
      await act(async () => rosterReads[2]!.resolve(failRead()));
      await waitFor(() => !!recovery(), "Refresh failure marks retained rows as stale");
      assert.match(recovery()!.textContent, /Showing the last loaded list/);
      assert.deepEqual(ids(), ["environment_2"]);
      await click(button("Retry", recovery()!));
      await waitFor(() => rosterReads.length === 4, "Retry refreshes the roster");
      await act(async () => rosterReads[3]!.resolve(rosterResponse([])));
      await waitFor(() => !recovery() && /No profiles yet/.test(empty()?.textContent ?? ""), "Only a successful empty response shows the canonical empty state");
      assert.equal(search().value, "Environment 2");
      assert.deepEqual(unexpected, []);
      return;
    }
    if (heldCatalog) {
      await waitFor(() => visible(".rail-toggle").length > 0, "The sidebar is usable before catalog loading completes");
      const toggle = button("Expand sidebar");
      assert.equal(reads.length, 0);
      await click(toggle);
      await waitFor(() => writes.length === 1, "The optimistic choice starts a workspace preference write");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.deepEqual([writes[0]!.key, writes[0]!.value], [SIDEBAR_KEY, "0"]);
      await act(async () => heldCatalog.resolve(Response.json({ ok: true, currentId: workspaceId, activeId: workspaceId, workspaces: [workspace] })));
      await waitFor(() => reads.length === 1, "Workspace preferences load while the earlier sidebar write is still pending");
      const remote = { [SIDEBAR_KEY]: "1", [PAGE_KEY]: "50", [SAVED_PROFILE_VIEWS_KEY]: JSON.stringify([saved]) };
      await act(async () => reads[0]!.resolve(Response.json({ ok: true, preferences: remote })));
      await waitFor(() => !viewSelect().disabled, "Other server preferences still finish loading");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.equal(dom.window.localStorage.getItem(SIDEBAR_KEY), "0");
      assert.equal(pageSize().value, "50");
      assert.ok([...viewSelect().options].some(option => option.value === `saved:${saved.id}`));
      await act(async () => writes[0]!.response.resolve(Response.json({ ok: true })));
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      return;
    }
    await waitFor(() => !!viewSelect() && rows().length > 0 && reads.length === 1, "Actual App must load the roster and request workspace preferences");
    assert.ok(root); assert.deepEqual(unexpected, []);
    if (paletteScenario) {
      const palette = () => visible<HTMLElement>('[data-command-palette="true"]', dom.window.document.body)[0];
      const options = () => visible<HTMLElement>('[role="option"]', palette()!);
      const input = () => palette()!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      const press = (node: HTMLElement, key: string, extra: Record<string, boolean> = {}) => act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })); });
      const open = async () => { await click(button("Command palette")); await waitFor(() => !!palette(), "Command palette should be visible"); };
      await click(button("Settings"));
      await open();
      assert.ok(options().some(option => option.textContent.includes("Profiles")));
      assert.ok(options().every(option => !option.hasAttribute("data-saved-view-id")));
      await press(button("Commands", palette()!), "End");
      const viewTab = button("Saved views", palette()!);
      assert.equal(viewTab.getAttribute("aria-selected"), "true");
      assert.equal(dom.window.document.activeElement, viewTab);
      assert.ok(palette()!.textContent.includes("Loading this workspace's views"));
      assert.ok(!palette()!.textContent.includes("Stale cached view"));
      assert.equal(options().length, 0);
      await act(async () => reads[0]!.resolve(Response.json({ ok: true, preferences })));
      await waitFor(() => options().length === 2, "Only the current workspace's server-backed views should appear");
      await type(input(), "resume");
      assert.deepEqual(options().map(option => option.querySelector("strong")?.textContent), ["Résumé", "Resume"]);
      assert.match(options()[0]!.textContent, /A · Favorites · Stopped/);
      assert.match(options()[1]!.textContent, /B · All environments · Stopped/);
      await type(input(), saved.filters.query);
      assert.equal(options().length, 0, "Stored raw roster queries must not be searchable in the palette");
      await type(input(), "résumé");
      assert.equal(input().getAttribute("aria-activedescendant"), options()[0]!.id);
      await press(input(), "Enter", { isComposing: true });
      assert.ok(palette()); assert.equal(writes.length, 0);
      await press(input(), "Enter");
      await waitFor(() => !palette() && dom.window.document.activeElement?.id === "profiles-page-title", "Applying the saved view should return to and focus the roster");
      assert.equal(viewSelect().value, `saved:${saved.id}`);
      assert.deepEqual(ids(), ["environment_2"]);
      assert.equal(search().value, saved.filters.query);
      assert.equal(pageSize().value, "25");
      await waitFor(() => writes.length === 2, "Existing view apply should persist its layout exactly once");
      assert.deepEqual(writes.map(({ key }) => key), [COLUMNS_KEY, PAGE_KEY]);

      await open();
      await click(button("Saved views", palette()!));
      assert.equal(options().length, 2);
      workspaceId = otherWorkspace.id;
      await act(async () => { await workspaceAccess.refresh?.(); });
      await waitFor(() => reads.length === 2 && options().length === 0, "Changing workspaces must retire the old view entries before the new read settles");
      await press(input(), "Enter");
      assert.ok(palette()); assert.equal(writes.length, 2);
      const newSaved: SavedProfileView = { ...similar, id: saved.id, name: "Second workspace view" };
      await act(async () => reads[1]!.resolve(Response.json({ ok: true, preferences: { [SAVED_PROFILE_VIEWS_KEY]: JSON.stringify([newSaved]) } })));
      await waitFor(() => options().length === 1, "The new workspace's view should appear after its read");
      assert.ok(options()[0]!.textContent.includes(newSaved.name));
      await act(async () => options()[0]!.click());
      await waitFor(() => !palette() && ids().length === 1 && ids()[0] === "environment_4", "A reused ID must resolve to the new workspace's view");
      assert.equal(metadataWrites().length, 0);
      assert.deepEqual(unexpected, []);
      return;
    }
    if (scenario === "group-filter-hierarchy") {
      assert.equal(visible('[aria-label="Group filter"]').length, 1);
      assert.deepEqual([...groupSelect().options].map(option => [option.value, option.textContent]), [
        ["all", "All groups · 4"], ["", "Ungrouped · 1"], ["A", "A · 2"], ["A/Nested", "A / Nested · 1"], ["B", "B · 1"],
      ]);
      await select(groupSelect(), "A/Nested");
      assert.deepEqual(ids(), ["environment_2"]);
      const path = visible<HTMLElement>('[aria-label="Folder path"]')[0];
      assert.equal(path?.querySelector('[aria-current="location"]')?.textContent?.trim(), "/ Nested");
      await click(button("A", path!));
      assert.equal(groupSelect().value, "A");
      assert.deepEqual(ids().sort(), ["environment_1", "environment_2"]);
      assert.equal(visible('[aria-label="Folder path"]').length, 0);
      await select(groupSelect(), "");
      assert.deepEqual(ids(), ["environment_3"]);
      assert.equal(metadataWrites().length, 0);
      assert.deepEqual(unexpected, []);
      return;
    }
    if (scenario === "preference-loading-guard" || scenario === "preference-read-retry") {
      assert.equal(viewSelect().disabled, true); assert.equal(favorite(profiles[0]!.id).disabled, true); assert.equal(button("Save current view").disabled, true);
      await click(favorite(profiles[0]!.id)); assert.equal(metadataWrites().length, 0, "Cached favorites must not be overwritten before the server read completes");
      if (scenario === "preference-loading-guard") {
        await select(pageSize(), "50");
        await waitFor(() => writes.some(write => write.key === PAGE_KEY), "A separate layout choice must persist during metadata loading");
        const remote = { [FAVORITE_PROFILES_KEY]: JSON.stringify([profiles[1]!.id]), [SAVED_PROFILE_VIEWS_KEY]: JSON.stringify([saved]), [PAGE_KEY]: "20" };
        await act(async () => { reads[0]!.resolve(Response.json({ ok: true, preferences: remote })); });
        await waitFor(() => !viewSelect().disabled, "The delayed authoritative favorites must still finish loading after a separate preference edit");
        assert.equal(pageSize().value, "50", "A late layout read must not undo the user's newer layout choice");
        assert.equal(favorite(profiles[0]!.id).getAttribute("aria-pressed"), "false"); assert.equal(favorite(profiles[1]!.id).getAttribute("aria-pressed"), "true");
        assert.ok([...viewSelect().options].some(option => option.value === `saved:${saved.id}`));
        assert.equal(dom.window.localStorage.getItem(FAVORITE_PROFILES_KEY), remote[FAVORITE_PROFILES_KEY]);
      } else {
        await act(async () => { reads[0]!.resolve(Response.json({ ok: false, error: "Inert preference read failure" }, { status: 500 })); });
        assert.equal(viewSelect().disabled, true); assert.ok(dom.container.textContent.includes("Inert preference read failure"));
        assert.ok(!views().textContent.includes("Loading this workspace's views…"), "A failed read must stop claiming that it is still loading");
        await click(button("Reload views")); await waitFor(() => reads.length === 2, "Reload views must send an explicit read retry");
        await act(async () => { reads[1]!.resolve(Response.json({ ok: true, preferences: { [FAVORITE_PROFILES_KEY]: JSON.stringify([profiles[1]!.id]), [SAVED_PROFILE_VIEWS_KEY]: "[]" } })); });
        await waitFor(() => !viewSelect().disabled, "Successful retry must unlock metadata actions");
        assert.ok(!dom.container.textContent.includes("Inert preference read failure"), "Successful reload must clear its own read failure");
        assert.equal(favorite(profiles[0]!.id).getAttribute("aria-pressed"), "false"); assert.equal(favorite(profiles[1]!.id).getAttribute("aria-pressed"), "true"); assert.equal(metadataWrites().length, 0);
      }
      return;
    }
    await waitFor(() => !viewSelect().disabled, "Workspace metadata must unlock after loading");
    if (scenario === "favorite-confirm-failure") {
      await click(favorite(profiles[0]!.id), true); await waitFor(() => metadataWrites().length === 1, "A favorite click must reach the real workspace preference API");
      assert.equal(favorite(profiles[0]!.id).getAttribute("aria-pressed"), "false", "The star must wait for server confirmation");
      assert.ok(visible<HTMLButtonElement>(".profile-favorite").every(node => node.disabled));
      assert.deepEqual(JSON.parse(metadataWrites()[0]!.value), [profiles[0]!.id]);
      await resolveWrite(0, false); assert.equal(favorite(profiles[0]!.id).getAttribute("aria-pressed"), "false"); assert.equal(dom.window.localStorage.getItem(FAVORITE_PROFILES_KEY), "[]");
      assert.ok(dom.container.textContent.includes("Inert preference write failure"));
      await click(favorite(profiles[0]!.id)); await waitFor(() => metadataWrites().length === 2, "A failed favorite write must permit retry"); await resolveWrite(1);
      assert.equal(favorite(profiles[0]!.id).getAttribute("aria-pressed"), "true"); assert.equal(dom.window.localStorage.getItem(FAVORITE_PROFILES_KEY), metadataWrites()[1]!.value);
      await select(viewSelect(), "favorites"); assert.deepEqual(ids(), [profiles[0]!.id]);
      await click(favorite(profiles[0]!.id)); await waitFor(() => metadataWrites().length === 3, "Removing a favorite must persist before removing its row"); assert.deepEqual(ids(), [profiles[0]!.id]);
      await resolveWrite(2); assert.deepEqual(ids(), []); assert.ok(empty().textContent.includes("Your favorites start here"));
      await click(button("Browse all environments", empty())); assert.equal(viewSelect().value, "all"); assert.equal(rows().length, profiles.length); return;
    }
    if (scenario === "saved-view-write") {
      await type(search(), "Environment 2"); await select(groupSelect(), "A"); await click(status("Stopped"));
      await click(button("Save current view"));
      const name = views().querySelector<HTMLInputElement>('.roster-view-editor input')!; await type(name, "Keep this view");
      await click(button("Save view", views()), true); await waitFor(() => metadataWrites().length === 1, "Save must send one serialized view preference");
      const value = JSON.parse(metadataWrites()[0]!.value) as SavedProfileView[];
      assert.equal(value[0]?.name, "Keep this view"); assert.match(value[0]!.id, /^view_[a-f0-9]{32}$/);
      assert.deepEqual(value[0]!.filters, { scope: "all", query: "Environment 2", group: "A", status: "stopped", sort: { key: "no", dir: 1 }, hiddenColumns: ["no", "group", "platform", "tags"], pageSize: 20 });
      assert.ok(![...viewSelect().options].some(option => option.textContent === "Keep this view"));
      await resolveWrite(0, false); assert.equal(name.value, "Keep this view"); assert.ok(views().textContent.includes("Your changes are kept; try again."));
      await click(button("Save view", views())); await waitFor(() => metadataWrites().length === 2, "Failed save must retain the draft for an explicit retry"); await resolveWrite(1);
      assert.ok([...viewSelect().options].some(option => option.textContent === "Keep this view")); assert.equal(views().querySelector(".roster-view-editor"), null);
      assert.equal(dom.window.localStorage.getItem(SAVED_PROFILE_VIEWS_KEY), metadataWrites()[1]!.value); return;
    }
    if (scenario === "saved-view-apply") {
      await click(button("Next page")); assert.ok(dom.container.querySelector('.page-of')?.textContent.includes("2"));
      await select(viewSelect(), `saved:${saved.id}`);
      const expected = profiles.filter(item => item.group === "A" && !item.running).sort((a, b) => b.name.localeCompare(a.name)).map(item => item.id);
      assert.equal(search().value, "Environment"); assert.equal(groupSelect().value, "A"); assert.equal(status("Stopped").getAttribute("aria-pressed"), "true"); assert.equal(pageSize().value, "25");
      assert.equal(dom.container.querySelector('.page-of b')?.textContent, "1", "Applying a view must reset the old page offset");
      assert.deepEqual(ids(), expected.slice(0, 25));
      assert.deepEqual([...dom.container.querySelectorAll<HTMLElement>('.profile-table thead th:not(.chk)')].map(node => node.className.split(" ")[0]), ["col-name", "col-action"]);
      assert.equal(dom.container.querySelector('th.col-name')?.getAttribute("aria-sort"), "descending");
      await waitFor(() => writes.some(item => item.key === PAGE_KEY) && writes.some(item => item.key === COLUMNS_KEY), "Applying a view must save its real layout preferences");
      assert.equal(writes.find(item => item.key === PAGE_KEY)?.value, "25"); assert.deepEqual(JSON.parse(writes.find(item => item.key === COLUMNS_KEY)!.value), saved.filters.hiddenColumns);
      await click(button("Next page")); assert.deepEqual(ids(), expected.slice(25));
      assert.equal(metadataWrites().length, 0, "Applying a view must not rewrite saved metadata or favorites"); return;
    }
    if (scenario === "missing-group-recovery") {
      await select(viewSelect(), `saved:${saved.id}`); assert.deepEqual(ids(), []);
      assert.equal(groupSelect().value, "Removed group"); assert.equal(groupSelect().selectedOptions[0]?.textContent, "Unavailable · Removed group");
      assert.ok(empty().textContent.includes("This group is unavailable")); assert.ok(empty().textContent.includes("Your saved view is kept."));
      await click(button("Search all groups", empty()));
      assert.equal(groupSelect().value, "all"); assert.equal(search().value, "Environment 2"); assert.equal(status("Stopped").getAttribute("aria-pressed"), "true");
      assert.deepEqual(ids(), [profiles[1]!.id], "Missing-group recovery must retain the favorites scope and other refinements");
      assert.ok([...viewSelect().options].some(option => option.value === `saved:${saved.id}`)); assert.equal(metadataWrites().length, 0); return;
    }
    if (scenario === "recent-flat-order") {
      await select(viewSelect(), "recent"); assert.deepEqual(ids(), [profiles[1]!.id, profiles[0]!.id, profiles[2]!.id]);
      assert.equal(dom.container.querySelectorAll(".profile-group-row").length, 0, "Recent launches must form one flat chronology across groups");
      assert.ok(rows()[0]?.querySelector(".sub")?.textContent.includes("A"), "Flattening chronology must retain each environment's group context");
      for (const row of rows()) {
        const source = profiles.find(profile => profile.id === row.dataset.profileId)!;
        const time = row.querySelector("time"); assert.ok(time, "A recent row must explain its position with a launch timestamp");
        assert.equal(time.getAttribute("datetime"), new Date(source.lastOpenAt).toISOString());
        assert.equal(time.getAttribute("title"), new Date(source.lastOpenAt).toLocaleString("en-US"));
        assert.ok(time.textContent.includes("Last launch ·"));
      }
      assert.equal(views().querySelector(".roster-view-note")?.textContent, "Most recent launch first.");
      await select(groupSelect(), "A"); assert.deepEqual(ids(), [profiles[1]!.id, profiles[2]!.id]);
      await click(status("Running")); assert.deepEqual(ids(), [profiles[2]!.id]); return;
    }
    if (scenario === "empty-recovery") {
      for (const [scope, title] of [["favorites", "Your favorites start here"], ["recent", "No recent launches yet"], ["attention", "Nothing needs attention"]]) {
        await select(viewSelect(), scope!); assert.ok(empty().textContent.includes(title!));
        await type(search(), "not-an-environment"); await select(groupSelect(), "B"); await click(status("Running")); assert.ok(empty().textContent.includes("No matches"));
        await click(button("Clear filters", empty())); assert.equal(viewSelect().value, scope); assert.equal(search().value, ""); assert.equal(groupSelect().value, "all"); assert.equal(status("All").getAttribute("aria-pressed"), "true");
        assert.ok(empty().textContent.includes(title!));
        await click(button("Browse all environments", empty())); assert.equal(viewSelect().value, "all"); assert.equal(rows().length, profiles.length);
      }
      return;
    }
    throw new Error(`Unknown roster view scenario: ${scenario}`);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); await dom.cleanup(); }
    finally { for (const [name, value] of previousGlobals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } }
    assert.deepEqual(unexpected, []); assert.ok(requests.every(item => item.method === "GET" || item.path === "/ui/api/workspace/preferences"), "View organization must not create, launch or mutate environments");
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "favorite-confirm-failure"); console.log("actual App roster views interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
