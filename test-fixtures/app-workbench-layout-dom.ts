import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";
function profile(index: number) {
  return { id: `environment_${index}`, name: `Environment ${index}`, engine: "chromium", chromiumRuntime: "aliasmode", group: "QA", platform: "example.test", tags: [], extensions: [], proxy: "127.0.0.1:8080",
    timezone: "UTC", cookieCount: index, seeded: true, screen: "1920x1080", has2fa: false, serial: index, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false };
}
async function run(scenario: string) {
  const profiles = Array.from({ length: 26 }, (_, index) => profile(index + 1));
  const workspace = { id: "default", name: "Layout fixture", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const secondWorkspace = { ...workspace, id: "second", name: "Second workspace" };
  let workspaceId = workspace.id;
  const preferences: Record<string, string> = scenario === "navigation-preference" ? { [SIDEBAR_KEY]: "1" } : {};
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const detailReads = () => requests.filter(item => /^\/ui\/api\/profiles\/environment_\d+$/.test(item.path));
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/profiles" && method === "GET") return Response.json({ ok: true, profiles: workspaceId === workspace.id ? profiles : profiles.map(item => ({ ...item, name: `Second ${item.name}` })), groups: ["QA"], folders: [{ name: "QA" }] });
    if (path === "/ui/api/workspace/preferences") {
      if (method === "POST") { const body = JSON.parse(String(options?.body)); preferences[body.key] = body.value; }
      return Response.json({ ok: true, preferences });
    }
    if (/^\/ui\/api\/profiles\/environment_\d+$/.test(path) && method === "GET") {
      const source = profiles.find(item => path.endsWith(`/${item.id}`)); assert.ok(source);
      return Response.json({ ok: true, profile: { ...source, username: "INERT_ACCOUNT_USER", password: "INERT_ACCOUNT_SECRET", email: "", emailPassword: "", twofa: "", proxyType: "http", proxy: "127.0.0.1:8080", proxyError: "", resolution: "1920*1080", platformOs: "windows", tags: "", timezoneManual: false, locale: "en-US", cores: "8", fingerprintSeed: "777" } });
    }
    if (/^\/ui\/api\/profiles\/environment_\d+\/totp$/.test(path) && method === "GET") {
      assert.ok(detailReads().some(item => path === `${item.path}/totp`), "Existing editor may read TOTP only after an explicit detail load");
      return Response.json({ ok: true, code: null });
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-layout-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: workspaceId, activeId: workspaceId, workspaces: [workspace, secondWorkspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId, root: "inert-layout-fixture", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
      "/ui/api/settings/fingerprints": { ok: true, reports: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected layout fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1024 });
  if (scenario === "navigation-preference") dom.window.localStorage.setItem(SIDEBAR_KEY, "1");
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const result = createRealRoot(...args); root = result; return result; } }));
  const workspaceAccess: { refresh?: () => Promise<unknown> } = {};
  const manager = await import("../web/workspace-manager.tsx"), useActualCatalog = manager.useWorkspaceCatalog;
  mock.module("../web/workspace-manager.tsx", () => ({ ...manager, useWorkspaceCatalog() { const result = useActualCatalog(); workspaceAccess.refresh = result.refresh; return result; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const rows = () => visible<HTMLElement>("tr[data-profile-id]");
  const panel = () => visible<HTMLElement>('aside[role="complementary"]').find(node => node.querySelector("h2")) ?? null;
  const editor = () => visible<HTMLElement>('[role="dialog"][aria-labelledby="edit-profile-title"]')[0] ?? null;
  const button = (label: string, scope: HTMLElement = dom.container) => { const item = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(item, `Missing button ${label}`); return item; };
  const click = async (node: HTMLButtonElement) => act(async () => { node.focus(); node.click(); });
  const waitFor = async (condition: () => boolean, description: string) => { const deadline = Date.now() + 3000; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), `${description}; requests=${JSON.stringify(requests)}; tail=${dom.container.textContent?.slice(-700)}`); };
  const detailsTrigger = (id: string) => { const row = rows().find(node => node.dataset.profileId === id); assert.ok(row, `Missing row ${id}`); return button(`View details for ${profiles.find(item => item.id === id)!.name}`, row); };
  const search = async (value: string) => act(async () => { const input = dom.container.querySelector<HTMLInputElement>(".heading-search input")!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const openDetails = async (id: string) => { const trigger = detailsTrigger(id); await click(trigger); await waitFor(() => panel()?.querySelector("h2")?.textContent === profiles.find(item => item.id === id)!.name, "Requested roster summary should open"); return trigger; };
  const closeEditor = async () => { await click(button("Cancel", editor()!)); await waitFor(() => !editor(), "Unchanged editor should close"); };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => rows().length === 20 && dom.container.querySelector<HTMLSelectElement>('select[aria-label="Environment view"]')?.disabled === false, "App must load the roster and workspace preferences");
    assert.ok(root); assert.deepEqual(unexpected, []);
    if (scenario.startsWith("navigation-")) {
      const sidebar = dom.container.querySelector<HTMLElement>('aside[aria-label="Workspace navigation"]')!;
      assert.ok(sidebar);
      const isPreserved = scenario === "navigation-preference";
      assert.equal(sidebar.classList.contains("collapsed"), isPreserved, "Ordinary width defaults to expanded and saved collapse choice survives");
      assert.equal(button(isPreserved ? "Expand sidebar" : "Collapse sidebar").getAttribute("aria-expanded"), String(!isPreserved));
      assert.equal(dom.container.querySelectorAll('select[aria-label="Environment view"]').length, 1, "Only one view picker may own filtering state");
      assert.ok(sidebar.querySelector('select[aria-label="Environment view"]'));
      assert.equal(dom.container.querySelector(".workspace-content")?.querySelector('select[aria-label="Environment view"]'), null);
      if (isPreserved) {
        await click(button("Environment views", sidebar));
        assert.equal(visible('select[aria-label="Environment view"]', sidebar).length, 1, "Collapsed rail exposes the same view picker through its flyout");
        assert.equal(dom.container.querySelectorAll('select[aria-label="Environment view"]').length, 1);
      }
      return;
    }
    if (scenario === "details-read-focus") {
      const before = requests.length;
      const trigger = await openDetails("environment_1");
      assert.equal(dom.window.document.activeElement, panel()!.querySelector("h2"));
      assert.equal(panel()!.getAttribute("aria-modal"), null); assert.ok(!panel()!.textContent?.includes("INERT_ACCOUNT"));
      assert.equal(detailReads().length, 0, "Opening summary must not fetch the credential-bearing edit DTO");
      assert.deepEqual(requests.slice(before), [], "Opening summary must reuse the already loaded roster");
      await click(button("Close environment details", panel()!));
      assert.equal(panel(), null); assert.equal(dom.window.document.activeElement, trigger);
      const row = rows().find(item => item.dataset.profileId === "environment_1")!;
      const name = row.querySelector<HTMLButtonElement>(".profile-name-button")!; assert.ok(name);
      await click(name); await waitFor(() => !!editor() && detailReads().length === 1, "Name remains a direct edit entry point");
      assert.equal(detailReads()[0]!.path, "/ui/api/profiles/environment_1"); assert.equal(panel(), null);
      await closeEditor(); assert.equal(dom.window.document.activeElement, name);
      return;
    }
    if (scenario === "workspace-isolation") {
      await openDetails("environment_1");
      assert.ok(workspaceAccess.refresh);
      workspaceId = secondWorkspace.id;
      await act(async () => { await workspaceAccess.refresh!(); });
      await waitFor(() => !panel(), "Changing workspace must retire the old summary even when IDs can be reused");
      assert.equal(detailReads().length, 0); assert.equal(visible(".profile-details-actions").length, 0);
      await click(button("Refresh profiles"));
      await waitFor(() => rows().some(row => row.textContent?.includes("Second Environment 1")), "Roster refresh loads the new workspace's record with the reused ID");
      const row = rows().find(item => item.dataset.profileId === "environment_1")!;
      await click(button("View details for Second Environment 1", row));
      assert.equal(panel()?.querySelector("h2")?.textContent, "Second Environment 1");
      assert.equal(detailReads().length, 0);
      return;
    }
    if (scenario === "details-filter-page") {
      await openDetails("environment_1");
      await search("id:environment_26"); await waitFor(() => rows().length === 1 && rows()[0]!.dataset.profileId === "environment_26", "Filter replaces visible rows");
      assert.equal(panel()?.querySelector("h2")?.textContent, "Environment 1");
      await click(button("Edit profile", panel()!)); await waitFor(() => !!editor() && detailReads().length === 1, "Summary edit must target its record after filtering");
      assert.equal(detailReads()[0]!.path, "/ui/api/profiles/environment_1");
      await closeEditor(); await click(button("Close environment details", panel()!));
      assert.equal(dom.window.document.activeElement?.id, "profiles-page-title", "A filtered-out trigger returns focus to the roster heading");
      await search(""); await waitFor(() => rows().length === 20, "Clearing search restores page one");
      await openDetails("environment_2"); await click(button("Next page"));
      await waitFor(() => rows().length === 6 && !rows().some(row => row.dataset.profileId === "environment_2"), "Paging replaces the triggering row");
      assert.equal(panel()?.querySelector("h2")?.textContent, "Environment 2");
      const beforeInspection = requests.length;
      await click(button("Inspect network & fingerprint", panel()!));
      await waitFor(() => visible<HTMLElement>(".inspection-profile strong")[0]?.textContent === "Environment 2", "Inspection must target the summary record rather than the current page");
      assert.equal(detailReads().length, 1, "Inspection navigation should not itself read account credentials");
      assert.ok(requests.slice(beforeInspection).every(item => !/\/profiles\/environment_\d+(?:\/totp)?$/.test(item.path)), "Inspection navigation must not fetch account details or codes");
      return;
    }
    throw new Error(`Unknown layout scenario ${scenario}`);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); await dom.cleanup(); }
    finally { for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
    assert.deepEqual(unexpected, []);
    assert.ok(requests.every(item => item.method === "GET" || item.path === "/ui/api/workspace/preferences"), "Layout navigation must never mutate environments or start browsers");
    assert.ok(requests.every(item => !/cookie|password|\/open$|\/close$|\/update$/.test(item.path)), "Layout actions must not request raw sessions or browser lifecycle operations");
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "details-read-focus"); console.log("actual App workbench layout fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
