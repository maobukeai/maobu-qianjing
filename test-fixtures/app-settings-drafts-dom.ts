import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import type { WorkspaceOperationCoordinator } from "../web/workspace-operations.tsx";
import type { AppLockStatus } from "../web/app-lock-api.ts";
import type { DesktopCloseRegistry } from "../web/desktop-close-state.ts";
import type { RuntimeDownload } from "../src/runtime-download.ts";
import { getBrowserRuntimeInventory } from "../src/runtime-inventory.ts";
import { createWebDomHarness } from "./web-dom.ts";
import { activityTrigger, viewActivityTask } from "./activity-interaction.ts";

async function run(scenario: string) {
  const lockStartup = scenario === "app-lock-startup-retry";
  const lockStatusReads: Array<(response: Response) => void> = [];
  const lockStatus: AppLockStatus = { configured: true, enabled: true, locked: true, lockOnStartup: true, idleTimeoutMinutes: 0, failedAttempts: 0, cooldownUntil: 0, retryAfterMs: 0, lastActivityAt: 0, updatedAt: null, corrupt: false };
  let coordinator: WorkspaceOperationCoordinator | null = null;
  let closeRegistry: DesktopCloseRegistry | null = null;
  let currentWorkspaceId = "one", preparedWorkspaceId = "one", refreshCatalog: (() => Promise<unknown>) | null = null;
  const settings = (id: string) => ({ version: 1, updates: { repository: `${id}/saved`, channel: "stable", checkOnStartup: false }, sync: { enabled: true, folder: `/inert-${id}`, retainSnapshots: 10 }, network: { checkLocalProxyBeforeLaunch: false } });
  const records = ["one", "two"].map(id => ({ id, name: `Fixture ${id}`, color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }));
  const proxyProfiles = ["local_one", "local_two"].map((id, index) => ({ id, name: `Local candidate ${index + 1}`, group: "Drafts", engine: "chromium", chromiumRuntime: "aliasmode", platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index + 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false }));
  const localPreviews: unknown[] = [];
  let runtimeTransfers: RuntimeDownload[] = [{ runtime: "aliasmode", receivedBytes: 37_000_000, totalBytes: 100_000_000 }, { runtime: "firefox", receivedBytes: 12_000_000, totalBytes: 0 }];
  let failNextRuntimeRead = false;
  const requests: Array<{ path: string; method: string; workspace: string }> = [], unexpected: string[] = [];
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET", workspace = currentWorkspaceId;
    requests.push({ path, method, workspace });
    if (lockStartup && method === "GET" && path === "/ui/api/app-lock/status") {
      return await new Promise<Response>(resolve => lockStatusReads.push(resolve));
    }
    if (lockStartup && method === "POST" && path === "/ui/api/app-lock/unlock") {
      assert.deepEqual(JSON.parse(String(options?.body)), { password: "inert-fixture-password" });
      return Response.json({ ok: true, status: { ...lockStatus, locked: false } });
    }
    if (lockStartup && method === "POST" && path === "/ui/api/app-lock/activity") {
      return Response.json({ ok: true, status: { ...lockStatus, locked: false } });
    }
    if (scenario === "runtime-activity" && method === "GET" && path === "/ui/api/runtime-downloads") {
      if (failNextRuntimeRead) { failNextRuntimeRead = false; return Response.json({ error: "Inert transient status error" }, { status: 503 }); }
      return Response.json({ downloads: runtimeTransfers });
    }
    if (scenario === "scripts-roundtrip" && method === "GET" && path.startsWith("/ui/api/scripts")) {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer inert-script-capability");
      const script = { id: "inert_script", name: `Saved script ${workspace}`, description: `Saved description ${workspace}`, language: "javascript", revision: 1, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" };
      if (path === "/ui/api/scripts") return Response.json({ ok: true, scripts: [script] });
      if (path === "/ui/api/scripts/inert_script") return Response.json({ ok: true, script: { ...script, source: "// Inert fixture only" } });
      if (path === "/ui/api/scripts/run") return Response.json({ ok: true, run: null });
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return Response.json({ ok: true, preferences: {} });
    if (path === "/ui/api/settings/network/discover" && method === "POST" && scenario === "local-proxy-handoff") {
      assert.deepEqual(JSON.parse(String(options?.body)).ports, [80]);
      return Response.json({ ok: true, discovery: { checkedAt: "2026-11-12T00:00:00Z", host: "127.0.0.1", results: [{ host: "127.0.0.1", port: 80, latencyMs: 2, status: "listening", socks5: "unknown", suggestions: [{ type: "http", evidence: "port_hint" }] }] } });
    }
    if (path === "/ui/api/proxies/preview" && method === "POST" && scenario === "local-proxy-handoff") {
      localPreviews.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true, previewId: "1-10000000-0000-4000-8000-000000000002", operationScope: "10000000-0000-4000-8000-000000000001", unusedProxies: 0,
        rows: [{ index: 0, profileId: "local_two", name: "Local candidate 2", group: "Drafts", previousProxy: null, proxy: "http://127.0.0.1:80", status: "ready" }] });
    }
    const startup: Record<string, unknown> = {
      "/ui/api/profiles": { ok: true, profiles: scenario === "local-proxy-handoff" ? proxyProfiles : [], groups: scenario === "local-proxy-handoff" ? ["Drafts"] : [], folders: [] },
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode", ...(lockStartup ? { appLockAvailable: true } : {}) },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-settings-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: currentWorkspaceId, activeId: preparedWorkspaceId, workspaces: records },
      "/ui/api/workspace/overview": { ok: true, workspaceId: workspace, root: "inert-settings-fixture", profileCount: 0, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
      "/ui/api/settings": { ok: true, settings: settings(workspace) },
      "/ui/api/settings/assistant/services": { ok: true, catalog: { services: [], defaultId: null } },
      "/ui/api/settings/sync/files": { ok: true, files: [] },
      "/ui/api/settings/updates": { ok: true, update: null },
      "/ui/api/settings/runtimes": { ok: true, inventory: getBrowserRuntimeInventory({ runtimeRoot: "/inert-cache", platform: "win32", arch: "x64", chromiumDefault: "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed" }) },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App draft fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  // Preserve the real provider/controller. Capture its workspace identity
  // boundary so this test can simulate a catalog identity update in place.
  const operations = await import("../web/workspace-operations.tsx"), createCoordinator = operations.createWorkspaceOperationCoordinator;
  mock.module("../web/workspace-operations.tsx", () => ({ ...operations, createWorkspaceOperationCoordinator(...args: Parameters<typeof createCoordinator>) { const value = createCoordinator(...args); coordinator = value; return value; } }));
  const workspaceManager = await import("../web/workspace-manager.tsx"), useActualCatalog = workspaceManager.useWorkspaceCatalog;
  mock.module("../web/workspace-manager.tsx", () => ({ ...workspaceManager, useWorkspaceCatalog() { const value = useActualCatalog(); refreshCatalog = value.refresh; return value; } }));
  if (scenario === "scripts-roundtrip") {
    const desktopClose = await import("../web/desktop-close.tsx"), useActualCloseRegistry = desktopClose.useDesktopCloseRegistry;
    mock.module("../web/desktop-close.tsx", () => ({ ...desktopClose, useDesktopCloseRegistry() { return closeRegistry = useActualCloseRegistry(); } }));
  }
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const value = createRealRoot(...args); root = value; return value; } }));
  const visible = <T extends HTMLElement>(selector: string): T[] => [...dom.container.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string) => { const value = visible<HTMLButtonElement>("button").find(node => node.getAttribute("aria-label") === label || node.textContent?.trim() === label); assert.ok(value, `Missing visible ${label}`); return value; };
  const tab = (key: string) => { const value = visible<HTMLButtonElement>(`[data-settings-tab="${key}"]`)[0]; assert.ok(value, `Missing actual App settings tab ${key}`); return value; };
  const field = (label: string) => { const value = visible<HTMLElement>("label").find(node => node.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input"); assert.ok(value, `Missing visible ${label}`); return value; };
  const click = (node: HTMLButtonElement) => act(async () => node.click());
  const type = (node: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, why: string) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), `${why}; unexpected=${JSON.stringify(unexpected)}`); };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    if (lockStartup) {
      await waitFor(() => lockStatusReads.length === 1, "App lock startup status request");
      assert.match(dom.container.querySelector('[role="status"]')?.textContent ?? "", /Checking app lock status/);
      assert.equal(visible(".profiles-workspace").length, 0, "The workspace is still loading while the lock state is unknown");
      const hasReadProfiles = () => requests.some(request => request.path === "/ui/api/profiles");
      assert.equal(hasReadProfiles(), false);
      await act(async () => { lockStatusReads[0]!(Response.json({ ok: false }, { status: 503 })); });
      assert.equal(dom.container.querySelector('[role="alert"]')?.textContent, "Could not load app lock status.");
      assert.equal(visible(".profiles-workspace").length, 0);
      const retry = button("Try again");
      retry.focus();
      await act(async () => { retry.click(); retry.click(); });
      assert.equal(lockStatusReads.length, 2, "Repeated retry clicks must start only one status read");
      assert.equal(retry.getAttribute("aria-disabled"), "true");
      assert.equal(retry.getAttribute("aria-busy"), "true");
      await act(async () => { lockStatusReads[1]!(Response.json({ ok: true, status: lockStatus })); });
      assert.equal(visible("[data-app-lock-screen]").length, 1);
      assert.equal(hasReadProfiles(), false, "A recovered locked status must keep profiles unread");
      const password = visible<HTMLInputElement>('[data-app-lock-screen] input[type="password"]')[0];
      assert.ok(password);
      await type(password, "inert-fixture-password");
      await click(button("Unlock"));
      await waitFor(() => hasReadProfiles() && visible(".profiles-workspace").length === 1 && !visible("[data-app-lock-screen]").length, "Profiles resume loading after actual unlock");
      assert.equal(requests.filter(request => request.path === "/ui/api/app-lock/unlock").length, 1);
      assert.deepEqual(unexpected, []);
      return;
    }
    await waitFor(() => !!coordinator?.getSnapshot().workspaceId && visible<HTMLElement>(".profiles-workspace").length === 1, "The full App must bootstrap its actual workspace provider");
    if (scenario === "runtime-activity") {
      await waitFor(() => !!activityTrigger(dom), "The single shell transfer reader must expose a background task");
      await click(button("AI workspace"));
      await viewActivityTask(dom, "Browser downloads");
      const heading = () => visible<HTMLElement>("[data-browser-runtime-settings-heading]")[0];
      await waitFor(() => !!heading() && dom.window.document.activeElement === heading(), "Activity must open Settings and focus the exact browser runtime card");
      const progress = () => visible(".browser-runtime-transfer progress");
      assert.equal(progress().length, 2);
      assert.equal(progress()[0]?.getAttribute("value"), "37");
      assert.equal(progress()[1]?.hasAttribute("value"), false);
      assert.ok(heading()!.closest("section")!.textContent?.includes("Total size unknown"));
      failNextRuntimeRead = true;
      await waitFor(() => heading()?.closest("section")?.textContent?.includes("Download status temporarily unavailable") === true, "A transient failure must disclose that progress is unavailable");
      assert.equal(progress().length, 0);
      runtimeTransfers = [{ runtime: "aliasmode", receivedBytes: 62_000_000, totalBytes: 100_000_000 }];
      await waitFor(() => progress()[0]?.getAttribute("value") === "62", "An observed download must keep polling after a transient failure with no pending profile actions");
      runtimeTransfers = [];
      await waitFor(() => !activityTrigger(dom), "A confirmed empty transfer list removes the activity entry");
      assert.equal(progress().length, 0);
      assert.equal(requests.filter(item => item.path === "/ui/api/settings/runtimes").length, 1);
      assert.ok(requests.filter(item => item.path.includes("runtime")).every(item => item.method === "GET"));
      assert.deepEqual(unexpected, []);
      return;
    }
    if (scenario === "scripts-roundtrip") {
      Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { async invoke(command: string) {
        assert.equal(command, "script_capability");
        return "inert-script-capability";
      } } });
      const scriptReads = () => requests.filter(item => item.path.startsWith("/ui/api/scripts"));
      const scriptRow = () => visible<HTMLButtonElement>('.script-row[data-script-id="inert_script"]')[0];
      const draftIsRegistered = () => closeRegistry!.getSnapshot().dirty.includes("script-details");
      assert.equal(scriptReads().length, 0, "Scripts should remain lazy until the first visit");
      await click(button("Scripts"));
      await waitFor(() => !!scriptRow(), "The actual App must load the script library");
      await click(scriptRow()!);
      await waitFor(() => visible(".script-detail").length === 1, "The actual App must display script details");
      const description = field("Description");
      await type(description, "Unsaved script description");
      assert.equal(draftIsRegistered(), true);
      const readsAfterEdit = scriptReads().length;
      await click(button("AI workspace"));
      assert.equal(visible(".scripts-page").length, 0);
      assert.ok(description.closest('.scripts-page[hidden][inert]'));
      assert.equal(draftIsRegistered(), true, "A hidden draft must still participate in desktop restart protection");
      preparedWorkspaceId = "two";
      assert.ok(refreshCatalog);
      await act(async () => { await refreshCatalog!(); });
      await click(button("Scripts"));
      assert.equal(field("Description"), description);
      assert.equal(description.value, "Unsaved script description");
      assert.equal(scriptReads().length, readsAfterEdit, "A prepared switch must not remount the current workspace script owner");
      await click(button("AI workspace"));
      currentWorkspaceId = "two";
      await act(async () => { await refreshCatalog!(); });
      assert.equal(description.isConnected, false);
      assert.equal(draftIsRegistered(), false);
      assert.equal(scriptReads().length, readsAfterEdit, "A new workspace should load scripts only when visited");
      await click(button("Scripts"));
      await waitFor(() => !!scriptRow()?.textContent?.includes("Saved script two"), "The new workspace must read its own script data");
      await click(scriptRow()!);
      await waitFor(() => visible(".script-detail").length === 1, "The new workspace must load the reused script ID independently");
      assert.equal(field("Description").value, "Saved description two");
      assert.equal(draftIsRegistered(), false);
      assert.ok(scriptReads().every(item => item.method === "GET"));
      assert.deepEqual(unexpected, []);
      return;
    }
    if (scenario === "local-proxy-handoff") {
      await click(button("Proxies")); await click(button("Replace proxies"));
      const manual = visible<HTMLTextAreaElement>('textarea[aria-label="Replacement input"]')[0]; assert.ok(manual);
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(manual, "manual.invalid:9090");
        manual.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await click(button("Settings")); await click(tab("network"));
      await type(field("Custom ports (optional)"), "80"); await click(button("Discover local proxies"));
      await waitFor(() => visible(".local-proxy-result").length === 1, "The synthetic listener should appear in Settings");
      const source = button("Assign HTTP proxy at 127.0.0.1:80 to existing profiles");
      const draft = () => visible<HTMLElement>(".local-proxy-assignment")[0];
      await click(source);
      await waitFor(() => !!draft(), "Discovery should open a proxy assignment draft");
      assert.equal(localPreviews.length, 0);
      assert.equal(button("Preview selected environments").disabled, true, "The handoff must not select any environment automatically");
      const cancel = [...draft()!.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Cancel"); assert.ok(cancel);
      await click(cancel);
      assert.equal(dom.window.document.activeElement === source, true, "Cancel should restore focus to the original discovery action");
      await click(source);
      const selected = [...draft()!.querySelectorAll<HTMLElement>("li")].find(node => node.textContent?.includes("local_two"))?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(selected);
      await act(async () => selected.click());
      await click(button("AI workspace")); await click(button("Settings"));
      assert.equal(source.disabled, true, "A second handoff must not replace the pending draft");
      await click(button("Return to proxy assignment draft"));
      assert.equal(selected.checked, true);
      await click(button("Preview selected environments"));
      await waitFor(() => !draft() && visible(".proxy-table tbody tr").some(row => row.textContent?.includes("local_two")), "The single proxy should open the existing review flow");
      assert.equal(localPreviews.length, 1);
      assert.deepEqual(localPreviews[0], { mode: "single", scope: { ids: ["local_two"] }, proxy: { type: "http", host: "127.0.0.1", port: 80, user: "", pass: "" } });
      assert.equal(manual.value, "manual.invalid:9090", "The original manual input should be retained");
      assert.equal(requests.filter(item => item.path.endsWith("/apply")).length, 0);
      assert.deepEqual(unexpected, []);
      return;
    }
    await click(button("Settings")); await click(tab("sync"));
    const original = field("Sync folder"); await type(original, "/inert-uncommitted-sync-folder");
    assert.ok(visible<HTMLElement>(".sync-status-summary")[0]?.textContent?.includes("Changes not saved"));
    await click(tab("updates")); const repo = field("Release repository"); await type(repo, "draft/announcements");
    await click(tab("account")); assert.equal(visible('[data-feature-settings-tab="sync"]').length, 0); assert.equal(visible('[data-feature-settings-tab="updates"]').length, 0);
    await click(tab("sync"));
    assert.equal(field("Sync folder"), original, "The actual App must keep the owner mounted across feature and General tabs");
    assert.equal(field("Sync folder").value, "/inert-uncommitted-sync-folder"); assert.ok(visible<HTMLElement>(".sync-status-summary")[0]?.textContent?.includes("Changes not saved"));
    await click(tab("updates")); assert.equal(field("Release repository"), repo); assert.equal(repo.value, "draft/announcements");
    assert.equal(requests.filter(item => item.path === "/ui/api/settings" && item.method === "GET").length, 2, "Actual tab changes must not reload over either draft");
    assert.equal(requests.filter(item => item.method === "PATCH").length, 0, "Actual tab changes must not silently save drafts");
    if (scenario === "page-roundtrip") {
      await click(button("AI workspace"));
      assert.equal(visible(".settings-workspace").length, 0); assert.ok(dom.container.querySelector('.settings-workspace[hidden][inert]'));
      assert.equal(original.value, "/inert-uncommitted-sync-folder"); assert.equal(repo.value, "draft/announcements");
      await click(button("Settings")); assert.equal(field("Release repository"), repo);
      await click(tab("sync")); assert.equal(field("Sync folder"), original);
      assert.equal(requests.filter(item => item.path === "/ui/api/settings").length, 2, "Returning from another module must retain owners without rereading over their drafts");
    }
    if (scenario === "prepared-switch") {
      preparedWorkspaceId = "two"; assert.ok(refreshCatalog); await act(async () => { await refreshCatalog!(); });
      assert.equal(coordinator!.getSnapshot().workspaceId, "one"); assert.equal(coordinator!.getSnapshot().restartPending, true);
      assert.equal(field("Release repository"), repo); assert.equal(repo.value, "draft/announcements");
      await click(tab("sync")); assert.equal(field("Sync folder"), original); assert.equal(original.value, "/inert-uncommitted-sync-folder");
      assert.equal(requests.filter(item => item.path === "/ui/api/settings").length, 2);
    }
    if (scenario === "workspace-isolation") {
      currentWorkspaceId = "two"; preparedWorkspaceId = "two"; assert.ok(refreshCatalog);
      await act(async () => { await refreshCatalog!(); });
      assert.equal(field("Release repository").value, "two/saved"); assert.notEqual(field("Release repository"), repo);
      await click(tab("sync")); assert.equal(field("Sync folder").value, "/inert-two"); assert.notEqual(field("Sync folder"), original);
      assert.ok(!visible<HTMLElement>(".sync-status-summary")[0]?.textContent?.includes("Changes not saved"));
    }
    assert.deepEqual(unexpected, []);
  } finally {
    if (root) await act(async () => root!.unmount()); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
await run(process.argv[2] ?? "tab-roundtrip"); console.log("actual App settings drafts fixture passed");
