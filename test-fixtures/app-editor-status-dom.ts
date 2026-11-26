import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLDetailsElement, HTMLInputElement } from "happy-dom";
import type { DesktopCloseIntent, DesktopCloseResolved } from "../web/desktop-close-state.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function run(scenario: string) {
  const create = scenario.startsWith("create-"), id = "status_profile";
  const frameless = scenario.endsWith("-window-controls");
  const detail = { id, name: "Saved status fixture", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", proxyType: "http", proxy: "", proxyError: "", username: "inert-user", password: "inert-password", email: "", emailPassword: "", twofa: "", resolution: "1920*1080", platformOs: "windows", extensions: [] as string[], tags: "", customNo: "", timezone: "UTC", timezoneManual: false, locale: "en-US", cores: "8", fingerprintSeed: "777", cookieCount: 0, seeded: true, mobilePersona: false };
  const profiles = [{ id, name: detail.name, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false }];
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const writes: Array<{ path: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const inspectionDetail = deferred<Response>();
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (method === "POST" && (path === "/ui/api/profiles" || path === `/ui/api/profiles/${id}/update`)) {
      const response = deferred<Response>(); writes.push({ path, response }); return response.promise;
    }
    if (scenario === "inspection-field-focus" && method === "GET" && path === `/ui/api/profiles/${id}`) return inspectionDetail.promise;
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/profiles": { ok: true, profiles, groups: [], folders: [] },
      [`/ui/api/profiles/${id}`]: { ok: true, profile: detail },
      [`/ui/api/profiles/${id}/totp`]: { ok: true, code: null },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-editor-status-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/groups/extensions": { ok: true, groups: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [{ id: "default", name: "Inert status workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-editor-status-root", profileCount: 1, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
      "/ui/api/settings/templates": { ok: true, catalog: { version: 1, revision: 0, templates: [] } },
      "/ui/api/settings/fingerprints": { ok: true, reports: [{ profileId: id, name: detail.name, status: "review", summary: { pass: 0, warn: 1, fail: 0, unknown: 0 }, checks: [{ id: "timezone_measurement", label: "Measured timezone and configuration", status: "warn", detail: "The saved and observed timezones differ.", evidence: { kind: "timezone", expected: "UTC", actual: "Europe/London" } }] }] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App editor-status request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  const windowActions: string[] = [], closeDecisions: string[] = [];
  let registered = false;
  if (frameless) {
    const sessionId = "a".repeat(64), requestId = "b".repeat(64);
    type WindowEvent = { payload: DesktopCloseIntent | DesktopCloseResolved };
    const listeners = new Map<string, (event: WindowEvent) => void>();
    let maximized = false;
    const actualWindow = await import("@tauri-apps/api/window");
    mock.module("@tauri-apps/api/window", () => ({ ...actualWindow, getCurrentWindow: () => ({
      async isMaximized() { return maximized; }, async isFocused() { return true; },
      async onResized() { return () => {}; }, async onFocusChanged() { return () => {}; },
      async toggleMaximize() { windowActions.push("toggleMaximize"); maximized = !maximized; },
      async minimize() { windowActions.push("minimize"); },
      async close() {
        windowActions.push("close");
        listeners.get("maobu-desktop-close-intent")?.({ payload: { sessionId, requestId, deliveryId: 1 } });
      },
      async listen(event: string, listener: (event: WindowEvent) => void) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    }) }));
    Object.defineProperties(dom.window, {
      __MAOBU_FRAMELESS__: { value: true },
      __TAURI_INTERNALS__: { value: { async invoke(command: string, args?: Record<string, unknown>) {
        if (command === "desktop_close_register") { registered = true; return { sessionId }; }
        if (command === "desktop_close_unregister" || command === "agent_runtime_ready") return;
        if (command === "default_browser_take_pending_urls") return [];
        if (command === "desktop_close_resolve") {
          assert.equal(args?.sessionId, sessionId);
          assert.equal(args?.requestId, requestId);
          closeDecisions.push(String(args?.decision));
          return args?.decision === "hold" ? "holding" : args?.decision === "cancel" ? "cancelled" : "continuing";
        }
        if (command === "signed_update_status") return { configured: false, status: "disabled", currentVersion: "0.1.0-fixture", endpoint: null, message: "", update: null };
        unexpected.push(`IPC ${command}`);
        throw new Error(`Unexpected actual App editor-status IPC: ${command}`);
      } } },
    });
  }
  let root: Root | null = null;
  const client = await import("react-dom/client"), actualCreateRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof actualCreateRoot>) { const created = actualCreateRoot(...args); root = created; return created; } }));
  // Keep App, footer and guard components intact. Frameless scenarios simulate
  // the native window boundary while using the real window and close owners.
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const editor = () => visible<HTMLElement>(`[role="dialog"][aria-labelledby="${create ? "create" : "edit"}-profile-title"]`, dom.container)[0];
  const button = (text: string, scope: HTMLElement = dom.window.document.body) => { const value = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === text || node.getAttribute("aria-label") === text); assert.ok(value, `Missing button ${text}`); return value; };
  const field = (label: string) => { const value = visible<HTMLElement>("label", editor()!).find(node => node.querySelector("span")?.textContent?.trim() === label)?.querySelector<HTMLInputElement>("input"); assert.ok(value, `Missing ${label}`); return value; };
  const footer = () => editor()!.querySelector<HTMLElement>(".modal-foot")!;
  const status = () => footer().querySelector<HTMLElement>(`[data-editor-status="${create ? "create" : "edit"}"]`)!;
  const click = (node: HTMLElement) => act(async () => node.click());
  const type = (node: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 3500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; requests=${JSON.stringify(requests)}; tail=${dom.window.document.body.textContent?.slice(-1000)}`); };
  const mutationCount = () => requests.filter(item => item.method !== "GET" && item.path !== "/ui/api/workspace/preferences").length;
  const failSave = async () => {
    await click(button(create ? "Create profile" : "Save changes", footer()));
    await waitFor(() => writes.length === 1, "A real form submission should issue one synthetic write");
    await act(async () => writes[0]!.response.resolve(json({ ok: false, error: "Synthetic save needs correction" }, 503)));
    await waitFor(() => !!status()?.textContent?.includes("Save needs attention"), "Actual footer must expose the failed save, not silently return to its default state");
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible(".profile-name-button").length === 1, "The real App must bootstrap");
    if (scenario === "inspection-field-focus") {
      await click(button(`Actions for ${detail.name}`));
      await click(button("Inspect network & fingerprint"));
      const action = () => visible<HTMLButtonElement>('[data-check-id="timezone_measurement"] button').find(node => node.textContent?.trim() === "Review Timezone settings");
      await waitFor(() => !!action(), "A timezone finding must provide the exact saved setting action");
      const trigger = action()!;
      await click(trigger);
      await waitFor(() => !!editor()?.textContent?.includes("Loading profile"), "The editor must open while its own detail request is pending");
      await act(async () => inspectionDetail.resolve(json({ ok: true, profile: detail })));
      const timezone = () => editor()?.querySelector<HTMLInputElement>('[data-profile-field="timezone"]');
      await waitFor(() => !!timezone() && dom.window.document.activeElement === timezone(), "The asynchronously loaded editor must focus the saved timezone field");
      assert.equal(timezone()!.value, "UTC");
      assert.equal(timezone()!.closest("details")?.hasAttribute("open"), true);
      assert.ok(button("Save changes", footer()).disabled);
      await click(button("Cancel", footer()));
      await waitFor(() => !editor() && dom.window.document.activeElement === trigger, "Cancel must restore focus to the initiating finding");
      assert.equal(mutationCount(), 0);
      assert.equal(requests.filter(item => item.path === `/ui/api/profiles/${id}`).length, 1);
      return;
    }
    await click(create ? button("New Profile", dom.container) : dom.container.querySelector<HTMLButtonElement>(".profile-name-button")!);
    await waitFor(() => !!editor()?.querySelector("input") && !!status(), "The real editor and footer status must be mounted");
    const original = editor()!, name = field("Name");
    if (frameless) {
      await waitFor(() => registered, "The actual desktop close host must register");
      const title = dom.window.document.getElementById(original.getAttribute("aria-labelledby")!);
      assert.equal(title?.textContent, create ? "New profile" : "Edit profile");
      await type(name, "PRIVATE_WINDOW_DRAFT");
      const controls = button("Window controls", original);
      await click(controls);
      await click(button("Maximize window", original));
      await click(controls);
      await click(button("Restore window", original));
      await click(controls);
      await click(button("Minimize window", original));
      assert.deepEqual(windowActions, ["toggleMaximize", "toggleMaximize", "minimize"]);
      await click(controls);
      await click(button("Close window", original));
      const nativeGuard = () => visible<HTMLElement>(".desktop-close-dialog")[0];
      await waitFor(() => !!nativeGuard(), "Close window must use the application close handshake");
      assert.deepEqual(closeDecisions, ["hold"], "A dirty editor must hold the native close");
      await click(button("Keep editing", nativeGuard()!));
      await waitFor(() => !nativeGuard() && dom.window.document.activeElement === controls, "Cancel must restore focus to the editor window controls");
      assert.ok(editor() === original);
      assert.equal(name.value, "PRIVATE_WINDOW_DRAFT");
      await click(button("Close", original));
      const editorGuard = () => visible<HTMLElement>(".unsaved-changes-guard")[0];
      await waitFor(() => !!editorGuard(), "The editor X must still use the editor draft guard");
      assert.deepEqual(windowActions, ["toggleMaximize", "toggleMaximize", "minimize", "close"]);
      assert.deepEqual(closeDecisions, ["hold", "cancel"]);
      assert.equal(mutationCount(), 0);
      return;
    }
    assert.equal(original.querySelector(".editor-window-controls"), null, "Regular web editors have no native window controls");
    if (!create) {
      await waitFor(() => field("Name").value === detail.name, "Actual edit detail must finish loading");
      if (scenario === "edit-invalid-screen") {
        const screen = original.querySelector<HTMLInputElement>('[data-profile-field="resolution"]'); assert.ok(screen, "Screen needs the stable field selector");
        const fingerprint = screen.closest("details") as HTMLDetailsElement | null; assert.ok(fingerprint);
        if (!fingerprint.open) await click(fingerprint.querySelector("summary")!);
        await act(async () => screen.focus());
        await type(screen, "INVALID_PRIVATE_SCREEN");
        assert.ok(dom.window.document.activeElement === screen, "Validation must not steal focus while typing");
        if (fingerprint.open) await click(fingerprint.querySelector("summary")!);
        assert.equal(fingerprint.open, false, "The problem locator must reveal a hidden field instead of relying on its current position");
        assert.ok(button("Save changes", footer()).disabled); assert.ok(status().textContent?.includes("Some changes need attention"));
        await click(button("View problem", status()));
        await waitFor(() => fingerprint.open && dom.window.document.activeElement === screen, "View problem must reveal and focus the actual invalid screen field");
        assert.equal(screen.getAttribute("aria-invalid"), "true");
        const ids = screen.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
        assert.ok(ids.some(value => dom.window.document.getElementById(value)?.textContent?.includes("Screen dimensions must be")), "Invalid field needs an associated validation error");
        assert.equal(screen.value, "INVALID_PRIVATE_SCREEN"); assert.ok(field("Name") === name);
        await type(screen, detail.resolution);
        assert.notEqual(screen.getAttribute("aria-invalid"), "true");
        assert.ok(!status().textContent?.includes("Some changes need attention"));
        assert.ok(dom.window.document.activeElement === screen, "Correcting the field should leave the caret in place");
        assert.equal(mutationCount(), 0); return;
      }
      await type(name, "PRIVATE_STATUS_DRAFT");
      assert.ok(status().textContent?.includes("1 field changed"), "A top-of-form edit should immediately appear in the fixed footer");
      if (scenario === "edit-review") {
        await click(button("Review changes", status()));
        const summary = original.querySelector<HTMLElement>('.editor-summary-anchor[tabindex="-1"]'); assert.ok(summary);
        await waitFor(() => dom.window.document.activeElement === summary, "Review must focus the actual summary destination");
        assert.ok(summary.textContent?.includes("Name")); assert.ok(!summary.outerHTML.includes("PRIVATE_STATUS_DRAFT"));
        assert.ok(field("Name") === name); assert.equal(name.value, "PRIVATE_STATUS_DRAFT"); assert.equal(mutationCount(), 0); return;
      }
      await failSave();
      const error = original.querySelector<HTMLElement>('.profile-edit-save-error[role="alert"][tabindex="-1"]'); assert.ok(error);
      await click(button("View problem", status())); await waitFor(() => dom.window.document.activeElement === error, "Unknown save problem must focus the actual save error without guessing a field");
      assert.ok(editor() === original); assert.ok(field("Name") === name); assert.equal(name.value, "PRIVATE_STATUS_DRAFT"); assert.equal(writes.length, 1); return;
    }
    assert.ok(status().textContent?.includes("No profile proxy")); assert.ok(status().textContent?.includes("Default fingerprint settings"));
    await type(name, "PRIVATE_CREATE_NAME");
    const proxy = [...original.querySelectorAll<HTMLDetailsElement>("details")].find(node => node.querySelector("summary > span")?.textContent === "Proxy"); assert.ok(proxy);
    if (!proxy.open) await click(proxy.querySelector("summary")!);
    const host = field("Host"), port = field("Port"), user = field("Proxy user"), pass = field("Proxy pass");
    if (scenario === "create-clipboard-proxy") {
      const createButton = button("Create profile", footer());
      const paste = proxy.querySelector<HTMLInputElement>('[data-profile-field="proxyPaste"]');
      assert.ok(paste);
      const pasteClipboard = (value: string) => act(async () => {
        const clipboardData = new dom.window.DataTransfer();
        clipboardData.setData("text", value);
        const event = new dom.window.ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
        paste.dispatchEvent(event);
        assert.ok(event.defaultPrevented, "The actual clipboard event must reach the proxy parser");
      });
      const invalid = "http://PRIVATE_PROXY_USER:PRIVATE_PROXY_PASS@proxy.example.invalid:bad";
      await pasteClipboard(invalid);
      assert.equal(paste.type, "password");
      assert.equal(paste.value, invalid, "A rejected paste must remain editable");
      assert.ok(!original.textContent?.includes("PRIVATE_PROXY_PASS"), "The error must not expose clipboard credentials");
      const validation = () => dom.window.document.getElementById("profile-create-validation-error");
      assert.ok(validation()?.textContent?.includes("This proxy could not be filled in"));
      assert.ok(!status().textContent?.includes("Save needs attention"), "A parse error must not be presented as a failed save");
      assert.ok(createButton.disabled, "A rejected paste must prevent an unproxied submission");
      await click(createButton);
      assert.equal(mutationCount(), 0);
      await click(button("View problem", status()));
      await waitFor(() => dom.window.document.activeElement === paste, "The footer must focus the rejected clipboard value");
      await type(paste, "http://proxy.example.invalid:18080");
      assert.ok(validation()?.textContent?.includes("Use Autofill"), "Editing the rejected input must dismiss the stale parse error");
      await type(paste, "");
      assert.equal(validation(), null);
      assert.ok(!status().textContent?.includes("Some changes need attention"));
      assert.ok(!status().textContent?.includes("Save needs attention"));
      assert.ok(!createButton.disabled, "Clearing the rejected input must restore the option to create without a proxy");
      await pasteClipboard("http://PRIVATE_PROXY_USER:PRIVATE_PROXY_PASS@proxy.example.invalid:18080");
      assert.equal(paste.value, "");
      assert.equal(host.value, "proxy.example.invalid");
      assert.equal(port.value, "18080");
      assert.ok(!createButton.disabled);
      assert.equal(mutationCount(), 0, "Clipboard auto-fill must stay in the draft");
      return;
    }
    if (scenario === "create-pending-proxy") {
      const createButton = button("Create profile", footer());
      const paste = proxy.querySelector<HTMLInputElement>('[data-profile-field="proxyPaste"]');
      assert.ok(paste);
      await type(port, "18080");
      if (proxy.open) await click(proxy.querySelector("summary")!);
      assert.ok(createButton.disabled, "A port without a host must block creation");
      await click(createButton);
      assert.equal(mutationCount(), 0);
      await click(button("View problem", status()));
      await waitFor(() => proxy.open && dom.window.document.activeElement === host, "View problem must reopen Proxy and focus the missing host");
      assert.equal(host.getAttribute("aria-invalid"), "true");
      assert.ok(dom.window.document.getElementById(host.getAttribute("aria-describedby")!)?.textContent?.includes("Enter the proxy host"));
      await type(port, "");
      assert.ok(!createButton.disabled, "Clearing incomplete fields restores the option to create without a profile proxy");

      await type(paste, "http://PRIVATE_PROXY_USER:PRIVATE_PROXY_PASS@proxy.example.invalid:18080");
      assert.ok(createButton.disabled, "Unapplied proxy input must block creation");
      await click(createButton);
      assert.equal(mutationCount(), 0);
      await click(button("View problem", status()));
      await waitFor(() => dom.window.document.activeElement === paste, "View problem must focus the unapplied proxy input");
      assert.equal(paste.getAttribute("aria-invalid"), "true");
      await click(button("Autofill", proxy));
      assert.equal(paste.value, "");
      assert.equal(host.value, "proxy.example.invalid");
      assert.equal(port.value, "18080");
      assert.ok(!createButton.disabled, "Applying the proxy must enable creation again");
      assert.ok(status().textContent?.includes("Profile proxy configured"));
      assert.equal(mutationCount(), 0, "Autofill changes the draft only");
      return;
    }
    await type(host, "PRIVATE_HOST.invalid"); await type(port, "18080"); await type(user, "PRIVATE_PROXY_USER"); await type(pass, "PRIVATE_PROXY_PASS");
    assert.ok(status().textContent?.includes("Profile proxy configured"));
    const safe = () => { for (const value of [name.value, host.value, user.value, pass.value]) assert.ok(!status().outerHTML.includes(value), "Create status must not receive names, hosts or credentials"); };
    safe();
    if (scenario === "create-summary") { assert.equal(mutationCount(), 0); return; }
    await failSave(); safe();
    const error = original.querySelector<HTMLElement>('.profile-create-error[role="alert"][tabindex="-1"]'); assert.ok(error);
    await click(button("View problem", status())); await waitFor(() => dom.window.document.activeElement === error, "Create save failure must have a reachable error destination");
    assert.ok(editor() === original); assert.equal(name.value, "PRIVATE_CREATE_NAME"); assert.equal(host.value, "PRIVATE_HOST.invalid"); assert.equal(user.value, "PRIVATE_PROXY_USER"); assert.equal(pass.value, "PRIVATE_PROXY_PASS"); assert.equal(writes.length, 1);
  } finally {
    if (root) await act(async () => root!.unmount()); await dom.cleanup();
    for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    assert.deepEqual(unexpected, []);
  }
}
await run(process.argv[2] ?? "edit-review"); console.log("actual App editor status fixture passed");
