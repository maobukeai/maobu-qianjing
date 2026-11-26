import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import type { DesktopCloseIntent, DesktopCloseNative, DesktopCloseResolved } from "../web/desktop-close-state.ts";
import type { AppLockStatus } from "../web/app-lock-api.ts";
import { getBrowserRuntimeInventory } from "../runtime-inventory.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function run(scenario: string) {
  const id = "close_one", groupNames = ["Team One", "Team Two"];
  const detail = { id, name: "Saved close fixture", engine: "chromium", chromiumRuntime: "aliasmode", group: groupNames[0], platform: "", proxyType: "http", proxy: "", proxyError: "", username: "inert-user", password: "inert-password", email: "", emailPassword: "", twofa: "", resolution: "1920*1080", platformOs: "windows", extensions: ["alpha"], tags: "", customNo: "", timezone: "UTC", timezoneManual: false, locale: "en-US", cores: "8", fingerprintSeed: "777", cookieCount: 0, seeded: true, mobilePersona: false };
  const profile = (profileId: string, group: string, extensions: string[], serial: number) => ({ id: profileId, name: profileId === id ? detail.name : "Other close fixture", engine: "chromium", chromiumRuntime: "aliasmode", group, platform: "", tags: [], extensions, proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  const profiles = [profile(id, groupNames[0]!, ["alpha"], 1), profile("close_two", groupNames[1]!, ["gamma"], 2)];
  const settings = { version: 1, updates: { repository: "saved/announcements", channel: "stable", checkOnStartup: false }, sync: { enabled: true, folder: "C:/inert-close-snapshots", retainSnapshots: 10 }, network: { checkLocalProxyBeforeLaunch: false } };
  const appLockScenario = scenario.startsWith("app-lock-");
  const appMode = { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode", appLockAvailable: appLockScenario };
  const lockStatus: AppLockStatus = {
    configured: true, enabled: true, locked: false, lockOnStartup: true, idleTimeoutMinutes: 15,
    failedAttempts: 0, cooldownUntil: 0, retryAfterMs: 0, lastActivityAt: 0, updatedAt: null, corrupt: false,
  };
  const heldMode = deferred<Response>();
  const writes: Array<{ path: string; body: unknown; response: ReturnType<typeof deferred<Response>> }> = [];
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    requests.push({ path, method });
    if (method === "POST" && (path === "/ui/api/profiles" || path === `/ui/api/profiles/${id}/update`)) {
      const response = deferred<Response>(); writes.push({ path, body: JSON.parse(String(options?.body)), response }); return response.promise;
    }
    if (appLockScenario && path === "/ui/api/app-lock/status" && method === "GET") return json({ ok: true, status: lockStatus });
    if (appLockScenario && path === "/ui/api/app-lock/activity" && method === "POST") return json({ ok: true, status: lockStatus });
    if (appLockScenario && path === "/ui/api/app-lock/configure" && method === "POST") {
      const response = deferred<Response>(); writes.push({ path, body: JSON.parse(String(options?.body)), response }); return response.promise;
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: {} });
    if (path === "/ui/api/app-mode" && scenario === "loading-host") return heldMode.promise;
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": appMode,
      "/ui/api/profiles": { ok: true, profiles, groups: groupNames, folders: groupNames.map(name => ({ name })) },
      [`/ui/api/profiles/${id}`]: { ok: true, profile: detail },
      [`/ui/api/profiles/${id}/totp`]: { ok: true, code: null },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-app-close-root" },
      "/ui/api/extensions": { ok: true, extensions: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }] },
      "/ui/api/groups/extensions": { ok: true, groups: [{ name: groupNames[0], extensions: ["alpha"] }, { name: groupNames[1], extensions: ["gamma"] }] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [{ id: "default", name: "Inert close workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-app-close-root", profileCount: 2, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
      "/ui/api/settings": { ok: true, settings },
      "/ui/api/settings/assistant/services": { ok: true, catalog: { services: [], defaultId: null } },
      "/ui/api/settings/templates": { ok: true, catalog: { version: 1, revision: 0, templates: [] } },
      "/ui/api/settings/sync/files": { ok: true, files: [] },
      "/ui/api/settings/updates": { ok: true, update: null },
      "/ui/api/settings/runtimes": { ok: true, inventory: getBrowserRuntimeInventory({ runtimeRoot: "/inert-close-cache", platform: "win32", arch: "x64", chromiumDefault: "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed" }) },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App desktop-close request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });

  const sessionId = "a".repeat(64);
  let receiveIntent!: (value: DesktopCloseIntent) => void, receiveResolved!: (value: DesktopCloseResolved) => void;
  let registrations = 0, requestSequence = 0, currentIntent: DesktopCloseIntent | null = null;
  const nativeCalls: Array<{ intent: DesktopCloseIntent; decision: string }> = [];
  const native: DesktopCloseNative = {
    listenIntent: async callback => { receiveIntent = callback; return () => {}; },
    listenResolved: async callback => { receiveResolved = callback; return () => {}; },
    register: async () => { registrations++; return { sessionId }; },
    unregister: async () => {},
    resolve: async (intent, decision) => { nativeCalls.push({ intent: { ...intent }, decision }); return decision === "hold" ? "holding" : decision === "cancel" ? "cancelled" : "continuing"; },
  };
  // Only replace the adapter boundary. Actual Host, Provider, registry, hooks,
  // page-level Guard, App bootstrap, panels and owner lifecycles remain real.
  const closeModule = await import("../web/desktop-close.tsx"), ActualDesktopCloseHost = closeModule.DesktopCloseHost;
  mock.module("../web/desktop-close.tsx", () => ({ ...closeModule, DesktopCloseHost(props: Parameters<typeof ActualDesktopCloseHost>[0]) { return createElement(ActualDesktopCloseHost, { ...props, native }); } }));
  let root: Root | null = null;
  const client = await import("react-dom/client"), actualCreateRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof actualCreateRoot>) { const created = actualCreateRoot(...args); root = created; return created; } }));

  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.window.document.body) => { const node = visible<HTMLButtonElement>("button", scope).find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(node, `Missing button ${label}`); return node; };
  const click = (node: HTMLElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const type = (node: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const field = (label: string, scope: HTMLElement = dom.container) => { const node = visible<HTMLElement>("label", scope).find(item => item.querySelector("span")?.textContent?.trim() === label)?.querySelector<HTMLInputElement>("input"); assert.ok(node, `Missing field ${label}`); return node; };
  const closeDialog = () => visible<HTMLElement>(".desktop-close-dialog")[0];
  const editor = (create: boolean, active = true) => [...dom.container.querySelectorAll<HTMLElement>(`[role="dialog"][aria-labelledby="${create ? "create" : "edit"}-profile-title"]`)].find(node => !active || !node.closest('[inert], [aria-hidden="true"]'));
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 3500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; unexpected=${JSON.stringify(unexpected)}; tail=${dom.window.document.body.textContent?.slice(-1200)}`); };
  const requestClose = async () => {
    currentIntent = { sessionId, requestId: (++requestSequence).toString(16).padStart(64, "0"), deliveryId: 1 };
    await act(async () => receiveIntent(currentIntent!));
  };
  const cancelNative = () => act(async () => { assert.ok(currentIntent); receiveResolved({ sessionId, requestId: currentIntent.requestId, outcome: "cancelled" }); });
  const keep = () => click(button("Keep editing", closeDialog()!));
  const assertLabels = (labels: string[]) => { assert.ok(closeDialog()); const rendered = [...closeDialog()!.querySelectorAll("li")].map(node => node.textContent); for (const label of labels) assert.ok(rendered.includes(label), `Missing close owner ${label}: ${JSON.stringify(rendered)}`); };
  const tab = (key: string) => { const value = visible<HTMLButtonElement>(`[data-settings-tab="${key}"]`)[0]; assert.ok(value, `Missing settings tab ${key}`); return value; };
  const writesBesidesPreferences = () => requests.filter(item => item.method !== "GET" && item.path !== "/ui/api/workspace/preferences");
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => registrations === 1, "The actual outer Shell must register its real Host");
    if (scenario === "loading-host") {
      assert.ok(dom.container.querySelector(".desktop-loading-shell"));
      await requestClose(); assert.equal(nativeCalls.at(-1)?.decision, "proceed"); assert.ok(closeDialog()); await cancelNative();
      await act(async () => heldMode.resolve(json(appMode)));
      await waitFor(() => visible(".profiles-workspace").length === 1, "App should finish loading without replacing its close owner");
      assert.equal(registrations, 1); assert.equal(writes.length, 0); return;
    }
    await waitFor(() => visible("tr[data-profile-id]").length === 2, "The real App must load the inert roster");
    if (scenario.startsWith("create-") || scenario.startsWith("edit-")) {
      const create = scenario.startsWith("create-"), saving = scenario.endsWith("saving");
      await click(create ? button("New Profile", dom.container) : dom.container.querySelector<HTMLButtonElement>(`tr[data-profile-id="${id}"] .profile-name-button`)!);
      await waitFor(() => !!editor(create)?.querySelector("input"), "The real profile form must load");
      if (!create) await waitFor(() => !button("Save changes", editor(false)!).disabled || field("Name", editor(false)!).value === detail.name, "The real edit snapshot must be loaded");
      const original = editor(create)!, name = field("Name", original), value = create ? "UNSAVED_CREATE_DRAFT" : "UNSAVED_EDIT_DRAFT";
      await type(name, value); name.focus();
      if (saving) {
        await click(button(create ? "Create profile" : "Save changes", original)); await waitFor(() => writes.length === 1, "A real save must start before the native intent");
        await requestClose(); assertLabels([create ? "New profile" : "Edit profile"]);
        assert.ok(closeDialog()?.textContent?.includes("A change is still in progress"));
        assert.equal(closeDialog()?.querySelectorAll("button").length, 1); assert.equal(nativeCalls.filter(item => item.decision === "proceed").length, 0);
        assert.equal(editor(create, false), original); assert.equal(name.value, value); await keep();
        await act(async () => writes[0]!.response.resolve(json({ ok: false, error: "Synthetic save not confirmed" }, 503)));
        await waitFor(() => !button(create ? "Create profile" : "Save changes", original).disabled, "A failed save must preserve the editable draft");
        assert.equal(name.value, value); assert.equal(nativeCalls.filter(item => item.decision === "proceed").length, 0); return;
      }
      await requestClose(); assertLabels([create ? "New profile" : "Edit profile"]);
      assert.ok(!closeDialog()!.outerHTML.includes(value)); await keep();
      assert.equal(editor(create), original); assert.equal(name.value, value); assert.equal(dom.window.document.activeElement, name);
      await requestClose(); await click(button("Discard and close app", closeDialog()!), true);
      assert.equal(nativeCalls.filter(item => item.decision === "proceed").length, 1);
      assert.equal(editor(create, false), original, "Discard at the app boundary must not invoke the editor cleanup"); assert.equal(name.value, value);
      assert.equal(visible(".unsaved-changes-guard").length, 0, "Native intent must not secretly start a separate page-close intent");
      await cancelNative(); assert.equal(editor(create), original); assert.equal(name.value, value); assert.equal(writes.length, 0); return;
    }
    if (scenario === "settings-cross-page") {
      await click(button("Settings", dom.container)); await click(tab("sync"));
      await waitFor(() => visible(".sync-status-summary").length === 1, "Real SyncPanel must load");
      const folder = field("Sync folder"); await type(folder, "C:/UNSAVED_SYNC_FOLDER");
      await click(tab("updates")); await waitFor(() => visible(".feature-actions").some(node => node.textContent?.includes("Save settings") === true), "Real UpdatesPanel must load");
      const repository = field("Release repository"); await type(repository, "draft/UNSAVED_RELEASES");
      await click(tab("account")); await requestClose(); assertLabels(["Snapshot settings", "Update settings"]); await keep();
      await click(button("AI workspace", dom.container)); assert.equal(visible(".settings-workspace").length, 0);
      await requestClose(); assertLabels(["Snapshot settings", "Update settings"]); await keep();
      await click(button("Settings", dom.container)); await click(tab("sync")); assert.equal(field("Sync folder"), folder); assert.equal(folder.value, "C:/UNSAVED_SYNC_FOLDER");
      await click(tab("updates")); assert.equal(field("Release repository"), repository); assert.equal(repository.value, "draft/UNSAVED_RELEASES");
      assert.equal(requests.filter(item => item.path === "/ui/api/settings" && item.method === "GET").length, 2); assert.equal(writesBesidesPreferences().length, 0); return;
    }
    if (scenario === "network-unsaved") {
      await click(button("Settings", dom.container)); await click(tab("network"));
      const preloading = () => visible<HTMLSelectElement>('.feature-card[aria-label="Page preloading"] select')[0];
      const startupCheck = () => visible<HTMLElement>("label").find(node => node.querySelector("span")?.textContent === "Check configured local proxies before opening profiles")?.querySelector<HTMLInputElement>("input");
      await waitFor(() => !!preloading() && !preloading()!.disabled && !!startupCheck() && !startupCheck()!.disabled, "Both real network preference cards must finish their initial read");
      const select = preloading()!, checkbox = startupCheck()!;
      assert.equal(select.value, "browser-default"); assert.equal(checkbox.checked, false);
      await act(async () => { select.value = "disabled"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await click(button("AI workspace", dom.container)); await requestClose(); assertLabels(["Network settings"]); await keep();
      await click(button("Settings", dom.container)); await click(tab("network"));
      assert.equal(preloading(), select); assert.equal(select.value, "disabled"); assert.equal(startupCheck(), checkbox); assert.equal(checkbox.checked, false);
      // Revert the first owner before changing the second, proving each card
      // independently contributes dirty state rather than sharing a fake flag.
      await act(async () => { select.value = "browser-default"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await click(checkbox); assert.equal(checkbox.checked, true);
      await click(button("AI workspace", dom.container)); await requestClose(); assertLabels(["Network settings"]); await keep();
      await click(button("Settings", dom.container)); await click(tab("network"));
      assert.equal(startupCheck(), checkbox); assert.equal(checkbox.checked, true); assert.equal(select.value, "browser-default");
      assert.equal(requests.filter(item => item.path === "/ui/api/settings" && item.method === "GET").length, 3, "Returning to Network must preserve all network owners without reloading their drafts");
      assert.equal(writesBesidesPreferences().length, 0, "Editing network preferences must not scan, save, check proxies or launch anything"); return;
    }
    if (appLockScenario) {
      const save = scenario === "app-lock-saving";
      const secret = "SYNTHETIC_APP_LOCK_PASSWORD";
      await click(button("Settings", dom.container));
      const select = visible<HTMLSelectElement>("[data-app-lock-settings] select")[0];
      assert.ok(select);
      const card = visible<HTMLElement>("[data-app-lock-settings]")[0]!;
      const currentPassword = field("Current master password (required for changes)", card);
      await act(async () => { select.value = "30"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await type(currentPassword, secret);
      if (save) {
        await click(button("Save lock settings", card));
        await waitFor(() => writes.length === 1, "App-lock settings must start one configuration write");
        assert.deepEqual(writes[0]!.body, { currentPassword: secret, idleTimeoutMinutes: 30, lockOnStartup: true });
      } else {
        await requestClose();
        assertLabels(["App master password lock"]);
        assert.ok(!closeDialog()!.outerHTML.includes(secret));
        await keep();
        assert.equal(currentPassword.value, secret, "Cancelling native close must preserve the active form");
      }
      await click(tab("network"));
      assert.equal(visible("[data-app-lock-settings]").length, 0);
      await requestClose();
      assertLabels(["App master password lock"]);
      assert.ok(!closeDialog()!.outerHTML.includes(secret));
      assert.equal(nativeCalls.filter(item => item.decision === "proceed").length, 0);
      if (save) {
        assert.ok(closeDialog()?.textContent?.includes("A change is still in progress"));
        assert.equal(closeDialog()?.querySelectorAll("button").length, 1);
        lockStatus.idleTimeoutMinutes = 30;
        await act(async () => writes[0]!.response.resolve(json({ ok: true, status: lockStatus })));
        await waitFor(() => !closeDialog()?.textContent?.includes("A change is still in progress"), "Completed settings release their close barrier");
        assert.equal(nativeCalls.filter(item => item.decision === "proceed").length, 0, "Settling a save must not automatically close the app");
      }
      await keep();
      await click(tab("account"));
      assert.equal(visible("[data-app-lock-settings]")[0], card);
      assert.equal(select.value, "30");
      assert.equal(currentPassword.value, "", "Leaving the lock form must clear its transient password");
      assert.equal(writes.length, save ? 1 : 0);
      if (!save) {
        await act(async () => { select.value = "15"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      }
      await requestClose();
      assert.equal(nativeCalls.at(-1)?.decision, "proceed", "A clean form must release the close guard");
      await cancelNative();
      return;
    }
    await click(button("Manage extensions", dom.container));
    await waitFor(() => visible(".extensions-default-choice").length === 3 && visible<HTMLElement>(".extensions-workspace")[0]?.getAttribute("aria-busy") === "false", "Actual extension owner must finish its complete read");
    if (scenario === "extension-source") {
      await click(button("Add extension")); const source = field("Chrome Web Store URL or extension ID"); await type(source, "PRIVATE_UNSAVED_EXTENSION_ID");
      await click(button("AI workspace", dom.container)); await requestClose(); assertLabels(["Add extension"]); assert.ok(!closeDialog()!.outerHTML.includes("PRIVATE_UNSAVED_EXTENSION_ID")); await keep();
      await click(button("Manage extensions", dom.container));
      if (!visible<HTMLInputElement>('input[aria-label="Chrome Web Store URL or extension ID"]').length) await click(button("Add extension"));
      assert.equal(field("Chrome Web Store URL or extension ID").value, "PRIVATE_UNSAVED_EXTENSION_ID");
    } else {
      const choice = visible<HTMLElement>(".extensions-default-choice").find(node => node.querySelector("span")?.textContent === "Beta")?.querySelector<HTMLInputElement>("input"); assert.ok(choice); await click(choice);
      const group = visible<HTMLSelectElement>('select[aria-label="Extension default group"]')[0]!;
      await act(async () => { group.value = "Team Two"; group.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.ok(visible<HTMLElement>(".extensions-default-choice").find(node => node.querySelector("span")?.textContent === "Gamma")?.querySelector<HTMLInputElement>("input")?.checked);
      await click(button("AI workspace", dom.container)); await requestClose(); assertLabels(["Extension defaults"]); await keep();
      await click(button("Manage extensions", dom.container)); await waitFor(() => visible(".extensions-default-choice").length === 3, "Return to actual extension owner");
      const returned = visible<HTMLSelectElement>('select[aria-label="Extension default group"]')[0]!;
      await act(async () => { returned.value = "Team One"; returned.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.ok(visible<HTMLElement>(".extensions-default-choice").find(node => node.querySelector("span")?.textContent === "Beta")?.querySelector<HTMLInputElement>("input")?.checked, "The offscreen group's draft must remain present");
    }
    assert.equal(writesBesidesPreferences().length, 0);
  } finally {
    if (root) await act(async () => root!.unmount()); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    assert.deepEqual(unexpected, []);
    assert.equal(registrations, 1, "The actual shell must retain one native-close owner across loading and page navigation");
  }
}
await run(process.argv[2] ?? "create-dirty"); console.log("actual App desktop close fixture passed");
