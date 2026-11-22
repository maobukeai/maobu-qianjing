import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLSelectElement } from "happy-dom";
import { ROSTER_DENSITY_KEY } from "../roster-density-state.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const held = ["loading-guard", "late-layout-edit", "read-failure-retry"].includes(scenario);
  const initialCache = held || scenario === "missing-server-value" ? "compact" : "comfortable";
  const preferences: Record<string, string> = scenario === "missing-server-value" ? {} : { [ROSTER_DENSITY_KEY]: scenario === "unknown-server-value" ? "unsupported" : "compact" };
  const profiles = [{ id: "density_fixture", name: "Density fixture environment", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false }];
  const workspace = { id: "default", name: "Density fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const reads: Array<ReturnType<typeof deferred<Response>>> = [], writes: Array<{ key: string; value: string; response: ReturnType<typeof deferred<Response>> }> = [], unexpected: string[] = [];
  const densityWrites = () => writes.filter(item => item.key === ROSTER_DENSITY_KEY);
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    if (path === "/ui/api/profiles" && method === "GET") return json({ ok: true, profiles, groups: [], folders: [] });
    if (path === "/ui/api/workspace/preferences") {
      if (method === "GET") { const response = deferred<Response>(); reads.push(response); if (!held) response.resolve(json({ ok: true, preferences })); return response.promise; }
      if (method === "POST") { const body = JSON.parse(String(options?.body)); assert.deepEqual(Object.keys(body).sort(), ["key", "value"]); const response = deferred<Response>(); writes.push({ ...body, response }); if (body.key !== ROSTER_DENSITY_KEY) { preferences[body.key] = body.value; response.resolve(json({ ok: true })); } return response.promise; }
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-density-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-density-fixture", profileCount: 1, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected density fixture request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch }); dom.container.id = "root"; dom.window.localStorage.setItem(ROSTER_DENSITY_KEY, initialCache);
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), originalCreate = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof originalCreate>) { const created = originalCreate(...args); root = created; return created; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
  const control = () => { const found = visible<HTMLElement>('.roster-density-options[role="radiogroup"]')[0]; assert.ok(found, "The active settings page or open display settings popover must expose its density control"); return found; };
  const radio = (label: string) => { const found = [...control().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(item => item.textContent === label); assert.ok(found, label); return found; };
  const selected = () => control().querySelector('[aria-checked="true"]')?.textContent;
  const density = () => dom.container.querySelector<HTMLElement>('[data-roster-density]')?.dataset.rosterDensity;
  const button = (label: string) => { const found = visible<HTMLButtonElement>("button").find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (target: HTMLButtonElement, twice = false) => act(async () => { target.click(); if (twice) target.click(); });
  const waitFor = async (test: () => boolean, why: string) => { const until = Date.now() + 2500; while (!test() && Date.now() < until) await dom.flush(); assert.ok(test(), why); };
  const resolveWrite = async (index: number, ok = true) => act(async () => { const write = densityWrites()[index]!; assert.ok(write); if (ok) preferences[write.key] = write.value; write.response.resolve(json(ok ? { ok: true } : { ok: false, error: "Inert density save failure" }, ok ? 200 : 503)); });
  const openDisplaySettings = async () => {
    const trigger = button("Choose visible columns");
    if (trigger.getAttribute("aria-expanded") !== "true") await click(trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.ok(control().closest(".popover"), "Roster density is available through the display settings popover");
  };
  const openSettings = async () => { await click(button("Settings")); assert.ok(control().closest(".is-settings")); };
  const openRoster = async () => { await click(button("All profiles")); await openDisplaySettings(); assert.ok(control().closest(".is-toolbar")); };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible<HTMLElement>('tr[data-profile-id="density_fixture"]').length === 1 && reads.length === 1, "Actual App must bootstrap its roster and authoritative preference read");
    assert.ok(root); assert.deepEqual(unexpected, []);
    await openDisplaySettings();
    if (held) {
      assert.equal(density(), "compact"); assert.ok(radio("Comfortable").disabled); await click(radio("Comfortable"), true); assert.equal(densityWrites().length, 0);
      if (scenario === "late-layout-edit") { const page = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Rows per page"]')!; await act(async () => { page.value = "50"; page.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); await waitFor(() => writes.some(write => write.key === "aliasmode.roster.pageSize"), "A separate allowed layout change must be saved while density is loading"); }
      if (scenario === "loading-guard") { await openSettings(); assert.ok(radio("Comfortable").disabled); await click(radio("Comfortable"), true); assert.equal(densityWrites().length, 0); }
      if (scenario === "read-failure-retry") {
        await act(async () => { reads[0]!.resolve(json({ ok: false, error: "Inert density read failure" }, 503)); });
        assert.ok(radio("Comfortable").disabled); assert.ok(dom.container.textContent?.includes("Inert density read failure"));
        await click(button("Reload views")); await waitFor(() => reads.length === 2, "The existing explicit preference retry must request fresh server values");
        await act(async () => { reads[1]!.resolve(json({ ok: true, preferences: { [ROSTER_DENSITY_KEY]: "comfortable" } })); });
      } else await act(async () => { reads[0]!.resolve(json({ ok: true, preferences: { [ROSTER_DENSITY_KEY]: "comfortable", "aliasmode.roster.pageSize": "20" } })); });
      await waitFor(() => !radio("Comfortable").disabled, "Density controls must unlock after the server read");
      assert.equal(selected(), "Comfortable"); assert.equal(density(), "comfortable"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "comfortable"); assert.equal(densityWrites().length, 0);
      if (scenario === "late-layout-edit") assert.equal(dom.container.querySelector<HTMLSelectElement>('select[aria-label="Rows per page"]')!.value, "50", "Authoritative density recovery must not undo a newer unrelated page-size choice");
      return;
    }
    await waitFor(() => !radio("Compact").disabled, "Density must be ready after its preference read");
    if (scenario === "missing-server-value" || scenario === "unknown-server-value") { assert.equal(density(), "comfortable"); assert.equal(selected(), "Comfortable"); assert.equal(densityWrites().length, 0); return; }
    assert.equal(density(), "compact"); assert.equal(selected(), "Compact"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "compact");
    if (scenario === "server-restore") { assert.equal(densityWrites().length, 0); await openSettings(); assert.equal(selected(), "Compact"); assert.equal(densityWrites().length, 0); return; }
    if (scenario === "save-failure-retry") {
      await openSettings(); radio("Comfortable").focus(); await click(radio("Comfortable"), true);
      await waitFor(() => densityWrites().length === 1, "Two events must share one density write");
      assert.equal(selected(), "Compact"); assert.equal(density(), "compact"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "compact"); assert.equal(dom.window.document.activeElement, radio("Comfortable"));
      assert.equal(radio("Comfortable").disabled, false); assert.equal(radio("Comfortable").getAttribute("aria-disabled"), "true");
      await resolveWrite(0, false); assert.equal(selected(), "Compact"); assert.equal(density(), "compact"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "compact"); assert.ok(visible<HTMLElement>('[role="alert"]').some(item => item.textContent?.includes("Inert density save failure")));
      await click(radio("Comfortable"), true); await waitFor(() => densityWrites().length === 2, "Save failure must allow an explicit retry"); await resolveWrite(1);
      assert.equal(selected(), "Comfortable"); assert.equal(density(), "comfortable"); assert.equal(preferences[ROSTER_DENSITY_KEY], "comfortable"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "comfortable"); await openRoster(); assert.equal(selected(), "Comfortable"); return;
    }
    assert.equal(scenario, "two-entry-persistence");
    await click(radio("Comfortable"), true); await waitFor(() => densityWrites().length === 1, "The toolbar must send the workspace preference, not a global setting"); assert.equal(densityWrites()[0]!.value, "comfortable");
    await openSettings(); assert.equal(selected(), "Compact"); assert.equal(control().getAttribute("aria-busy"), "true"); await click(radio("Comfortable"), true); assert.equal(densityWrites().length, 1);
    await resolveWrite(0); assert.equal(selected(), "Comfortable"); assert.equal(density(), "comfortable");
    await click(radio("Compact")); await waitFor(() => densityWrites().length === 2, "The settings entry must share the same save path"); assert.equal(selected(), "Comfortable"); await resolveWrite(1);
    assert.equal(preferences[ROSTER_DENSITY_KEY], "compact"); assert.equal(dom.window.localStorage.getItem(ROSTER_DENSITY_KEY), "compact"); await openRoster(); assert.equal(selected(), "Compact"); assert.equal(density(), "compact");
    assert.equal(densityWrites().length, 2); assert.ok(densityWrites().every(write => write.key === ROSTER_DENSITY_KEY));
  } finally {
    for (const read of reads) read.resolve(json({ ok: true, preferences })); for (const write of writes) write.response.resolve(json({ ok: false, error: "Fixture teardown" }, 503));
    if (root) await act(async () => { root!.unmount(); }); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
await run(process.argv[2] ?? "server-restore"); console.log("actual App density fixture passed");
