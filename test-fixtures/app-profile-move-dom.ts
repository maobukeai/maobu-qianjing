import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const profile = (id: string, group: string) => ({ id, name: id, engine: "chromium", chromiumRuntime: "aliasmode", group, platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: id.charCodeAt(id.length - 1), createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  let profiles = [profile("move_a", "Source"), profile("move_b", "Destination"), profile("move_c", "Source")];
  const groups = ["Source", "Destination", "new", "choose"], workspace = { id: "default", name: "Move fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [], moves: Array<{ ids: string[]; group: string; response: ReturnType<typeof deferred<Response>>; signal?: AbortSignal | null }> = [], rosters: Array<ReturnType<typeof deferred<Response>>> = [];
  let holdRoster = false, failRoster = false, rosterReads = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const roster = () => ({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/profiles/move" && method === "POST") { const body = JSON.parse(String(options?.body)); const response = deferred<Response>(); moves.push({ ...body, response, signal: options?.signal }); return response.promise; }
    if (path === "/ui/api/profiles" && method === "GET") { rosterReads++; if (holdRoster) { const response = deferred<Response>(); rosters.push(response); return response.promise; } return failRoster ? json({ ok: false, error: "Inert roster refresh failure" }, 503) : json(roster()); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: { "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groups].map(name => [name, false])) } });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-move-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace, { ...workspace, id: "other", name: "Other workspace" }] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-move-fixture", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App move request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const created = createRealRoot(...args); root = created; return created; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.container) => { const found = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (target: HTMLButtonElement | HTMLInputElement, twice = false) => act(async () => { target.click(); if (twice) target.click(); });
  const row = (id: string) => { const found = visible<HTMLElement>(`tr[data-profile-id="${id}"]`)[0]; assert.ok(found, id); return found; };
  const check = (id: string) => row(id).querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`)!;
  const checked = () => visible<HTMLInputElement>('tr[data-profile-id] > td.chk input').filter(node => node.checked).map(node => node.getAttribute("aria-label")!.slice(7)).sort();
  const destination = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Move to group"]')!;
  const choose = async (label: string) => act(async () => { const field = destination(); assert.ok(field); const option = [...field.options].find(item => item.textContent === label); assert.ok(option, label); field.value = option.value; field.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const feedback = () => dom.container.querySelector<HTMLElement>(".profile-move-feedback")!;
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 2500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; requests=${JSON.stringify(requests)}; tail=${dom.container.textContent?.slice(-1500)}`); };
  const finish = async (index: number, reply?: Record<string, unknown>, mutate = true, status = 200) => act(async () => {
    const move = moves[index]!; assert.ok(move); let changed = 0;
    if (mutate) for (const id of move.ids) { const current = profiles.find(profile => profile.id === id); if (current && current.group !== move.group) { current.group = move.group; changed++; } }
    move.response.resolve(json(reply ?? { ok: true, moved: changed, group: move.group }, status));
  });
  const releaseRosters = async () => act(async () => { holdRoster = false; for (const response of rosters.splice(0)) response.resolve(json(roster())); });
  const confirmed = () => !!feedback()?.classList.contains("is-confirmed");
  const openWorkspace = async () => { await click(button("Command palette")); const command = visible<HTMLElement>('[role="option"]', dom.window.document.body).find(node => node.querySelector("strong")?.textContent === "Workspace management"); assert.ok(command); await act(async () => { command.click(); }); await waitFor(() => visible(".wm-page").length === 1, "Workspace page should remain navigable"); };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible('tr[data-profile-id]').length === 3 && !visible<HTMLButtonElement>('[role="radio"]').find(node => node.textContent === "Compact")?.disabled, "Actual App must load profiles and workspace preferences");
    await click(check("move_a")); await click(check("move_c")); await click(button("More actions"));
    if (scenario === "new-group-freeze") {
      await choose("+ new group…"); const field = dom.container.querySelector<HTMLInputElement>('.movewrap input')!; assert.ok(field);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "  New group  "); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    } else await choose(scenario === "ungrouped" ? "Ungrouped" : scenario === "literal-group-name" ? "new" : "Destination");
    if (scenario === "ungrouped") { assert.equal(destination().value, "group:"); assert.equal(button("Move").disabled, false); }
    if (scenario === "literal-group-name") { assert.equal(destination().value, "group:new"); assert.equal(dom.container.querySelector('.movewrap input'), null); }
    const initialReads = rosterReads;
    await click(button("Move"), true); await waitFor(() => moves.length === 1, "Double click must send exactly one move POST");
    assert.deepEqual(moves[0]!.ids.sort(), ["move_a", "move_c"]); assert.equal(moves[0]!.group, scenario === "ungrouped" ? "" : scenario === "literal-group-name" ? "new" : scenario === "new-group-freeze" ? "New group" : "Destination");
    assert.ok(button("Moving…").disabled); assert.ok(button("Dismiss move result").disabled); assert.ok(row("move_a").querySelector<HTMLButtonElement>(".row-start")!.disabled);
    if (scenario === "owner-unmount") {
      assert.ok(root); await act(async () => { root!.unmount(); root = null; }); assert.equal(moves[0]!.signal?.aborted ?? false, false);
      await finish(0); await dom.flush(); assert.equal(rosterReads, initialReads, "An unmounted App must not launch a new confirmation read"); assert.equal(moves.length, 1); return;
    }
    if (scenario === "new-group-freeze") {
      const field = dom.container.querySelector<HTMLInputElement>('.movewrap input')!; assert.ok(field.disabled); assert.ok(button("cancel").disabled);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "Overwritten"); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
      await click(button("cancel")); await click(button("Moving…"), true); assert.equal(moves.length, 1); assert.equal(moves[0]!.group, "New group");
      await finish(0); await waitFor(confirmed, "The captured new destination should confirm"); assert.equal(profiles.find(profile => profile.id === "move_a")!.group, "New group"); return;
    }
    assert.ok(destination().disabled);
    if (scenario === "selection-preserved" || scenario === "same-id-new-intent") {
      if (scenario === "same-id-new-intent") { await click(button("Clear selection")); await click(check("move_a")); }
      else await click(check("move_b"));
      const expected = scenario === "same-id-new-intent" ? ["move_a"] : ["move_a", "move_b", "move_c"]; assert.deepEqual(checked(), expected);
      await finish(0); await waitFor(confirmed, "The submitted move should confirm"); assert.deepEqual(checked(), expected, "A newer selection object is preserved even when it includes the same ID again"); assert.equal(destination().value, "group:Destination"); return;
    }
    if (scenario === "failure-retry" || scenario === "retry-keeps-new-target") {
      await finish(0, { ok: false, error: "Inert move refusal" }, false, 503);
      await waitFor(() => feedback().classList.contains("is-failed"), "Explicit refusal must stay a retryable failure"); assert.deepEqual(checked(), ["move_a", "move_c"]); assert.equal(destination().value, "group:Destination"); assert.equal(rosterReads, initialReads);
      if (scenario === "retry-keeps-new-target") await choose("Source");
      await click(button("Retry 2 unconfirmed destinations"), true); await waitFor(() => moves.length === 2, "Retry should send the captured attempt once"); assert.equal(moves[1]!.group, "Destination");
      await finish(1); await waitFor(confirmed, "Retry should confirm destinations"); assert.deepEqual(checked(), []);
      await click(check("move_b")); await click(button("More actions")); assert.equal(destination().value, scenario === "retry-keeps-new-target" ? "group:Source" : "choose"); return;
    }
    if (scenario === "uncertain-recheck") {
      await finish(0, { moved: 2, group: "Destination" });
      await waitFor(() => feedback().classList.contains("is-unconfirmed"), "A missing ok field must not invent success"); assert.deepEqual(checked(), ["move_a", "move_c"]); assert.equal(rosterReads, initialReads);
      await click(button("Check result without moving again"), true); await waitFor(confirmed, "Read-only recheck should confirm the actual destination"); assert.equal(moves.length, 1); assert.equal(rosterReads, initialReads + 1); assert.deepEqual(checked(), []); return;
    }
    if (scenario === "read-failure") {
      failRoster = true; await finish(0); await waitFor(() => feedback().classList.contains("is-unconfirmed"), "A completed write and failed read must remain distinct");
      assert.ok(feedback().textContent.includes("Server reported 2 group changes")); assert.ok(feedback().textContent.includes("could not refresh")); assert.deepEqual(checked(), ["move_a", "move_c"]);
      failRoster = false; await click(button("Check result without moving again"), true); await waitFor(confirmed, "A successful confirmation retry must clear only confirmed selections"); assert.equal(moves.length, 1); assert.deepEqual(checked(), []); return;
    }
    if (scenario === "read-gate-maintenance") {
      holdRoster = true; await finish(0); await waitFor(() => rosters.length > 0 && feedback().textContent.includes("Checking the move result…"), "Move ownership must include the real roster read");
      assert.deepEqual(checked(), ["move_a", "move_c"]); assert.ok(destination().disabled);
      await openWorkspace(); await click(button("Backup and restore")); assert.ok(button("Create full backup").disabled); assert.ok(button("Restore from file").disabled);
      await releaseRosters(); await waitFor(() => !button("Create full backup").disabled, "Maintenance unlocks only after move confirmation reads settle");
      await click(button("Back to environments")); await waitFor(confirmed, "Returning should preserve the checked move result"); assert.deepEqual(checked(), []); return;
    }
    if (scenario === "partial-missing") {
      profiles = profiles.filter(profile => profile.id !== "move_c"); await finish(0); await waitFor(() => feedback().classList.contains("is-partial"), "Missing IDs must not be treated as moved");
      assert.ok(feedback().textContent.includes("Server reported 1 group changes")); assert.ok(feedback().textContent.includes("No longer listed")); assert.equal(check("move_a").checked, false); assert.ok(dom.container.querySelector(".selcount")?.textContent?.includes("1 selected")); assert.equal(destination().value, "group:Destination"); return;
    }
    await finish(0); await waitFor(confirmed, "The actual move must confirm its saved destination"); assert.equal(moves.length, 1); assert.equal(rosterReads, initialReads + 1); assert.deepEqual(checked(), []);
    if (scenario === "ungrouped") {
      const filter = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Group filter"]')!; assert.ok(filter);
      await act(async () => { filter.value = ""; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.deepEqual(visible<HTMLElement>('tr[data-profile-id]').map(node => node.getAttribute("data-profile-id")).sort(), ["move_a", "move_c"], "Ungrouped is a real filter scope even though the folder catalog has no empty-name folder");
      assert.equal(dom.container.querySelector(".profile-status-tabs button")?.getAttribute("aria-pressed"), "true");
      await click(check("move_a")); await click(check("move_c")); assert.deepEqual(checked(), ["move_a", "move_c"]);
      assert.equal(moves.length, 1, "Filtering and selecting an ungrouped destination must not replay the move");
    }
    assert.equal(profiles.find(profile => profile.id === "move_a")!.group, moves[0]!.group); assert.deepEqual(unexpected, []);
  } finally {
    holdRoster = false; for (const response of rosters) response.resolve(json(roster())); for (const move of moves) move.response.resolve(json({ ok: false, error: "Fixture teardown" }, 503));
    if (root) await act(async () => { root!.unmount(); }); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
try { await run(process.argv[2] ?? "success-dupe"); console.log("actual App profile move fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
