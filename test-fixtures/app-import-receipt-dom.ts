import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";
import { activityTask, activityTrigger, viewActivityTask } from "./activity-interaction.ts";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function run(scenario: string) {
  const profile = (id: string, name: string) => ({ id, name, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [] as string[], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, proxyError: "", restartPending: false });
  const profiles = [profile("existing_healthy", "Existing healthy"), { ...profile("existing_proxy_review", "Existing proxy review"), proxyError: "invalid" }, { ...profile("existing_restart_review", "Existing restart review"), restartPending: true }];
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const uploads: Array<{ files: Array<{ name: string; text: string }>; overrides: Record<string, string>; response: ReturnType<typeof deferred<Response>> }> = [];
  const heldRosters: Array<ReturnType<typeof deferred<Response>>> = [];
  let holdRoster = false, alerts = 0;
  const roster = () => ({ ok: true, profiles, groups: ["Override team"], folders: [{ name: "Override team" }] });
  const workspace = { id: "default", name: "Inert fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const workspaceGate = scenario === "workspace-maintenance-gate", secondWorkspace = { ...workspace, id: "second", name: "Inert second workspace" };
  const usingPaste = scenario === "paste-modal" || scenario === "pending-draft-freeze";
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    if (path === "/ui/api/import/upload" && method === "POST") {
      assert.ok(options?.body instanceof FormData);
      assert.ok([...options.body.keys()].every(key => ["files", "group", "platform"].includes(key)));
      const overrides = Object.fromEntries(["group", "platform"].flatMap(key => options.body instanceof FormData && options.body.has(key) ? [[key, String(options.body.get(key))]] : []));
      const files = await Promise.all(options.body.getAll("files").map(async value => { assert.ok(value instanceof File); return { name: value.name, text: await value.text() }; }));
      assert.ok(files.length); const response = deferred<Response>(); uploads.push({ files, overrides, response }); return response.promise;
    }
    if (path === "/ui/api/profiles" && method === "GET") { if (holdRoster) { const response = deferred<Response>(); heldRosters.push(response); return response.promise; } return Response.json(roster()); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return Response.json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-fixture-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: workspaceGate ? [workspace, secondWorkspace] : [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-fixture-root", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unowned fixture request blocked: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window), alert: () => { alerts++; } })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "alert", { configurable: true, value: () => { alerts++; } });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let appRoot: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const root = createRealRoot(...args); appRoot = root; return root; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.window.document.body) => { const node = visible<HTMLButtonElement>("button", scope).find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(node, `Missing ${label}`); return node; };
  const dialog = () => visible<HTMLElement>('[role="dialog"][aria-label="Import profiles"]')[0];
  const receipt = () => visible<HTMLElement>(".import-receipt")[0];
  const tableIds = () => visible<HTMLElement>("tr[data-profile-id]").map(node => node.dataset.profileId).sort();
  const click = (node: HTMLButtonElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const type = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => { const prototype = node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, message: string) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), `${message}; requests=${JSON.stringify(requests)}`); };
  const file = (name = "source.json") => new File(['[{"id":"fixture_imported","name":"Imported healthy","group":"Source team","platform":"instagram.com"}]'], name, { type: "application/json" });
  const drop = (target: HTMLElement, selected: File[]) => act(async () => { const event = new dom.window.Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: { files: selected, types: ["Files"] } }); target.dispatchEvent(event); });
  const choose = (selected: File[]) => act(async () => { const input = dialog()!.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, "files", { configurable: true, value: selected }); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const completeBody = () => ({ ok: true, profiles: 2, files: uploads[0]!.files.length, cookiesStripped: 3, skipped: 1, errors: [{ file: "C:\\PRIVATE_HOME\\source.json", id: "reported_but_unknown", error: "Authorization: Bearer PRIVATE_IMPORT_TOKEN http://person:PRIVATE_PASSWORD@proxy.invalid:8080", quarantined: true }] });
  const respond = (body: Record<string, unknown>) => act(async () => { if (body.ok === true && !profiles.some(item => item.id === "fixture_imported")) profiles.push(profile("fixture_imported", "Imported healthy")); uploads[0]!.response.resolve(Response.json(body)); });
  const rootApp = () => visible<HTMLElement>(".app")[0]!;
  const releaseRosters = () => act(async () => { holdRoster = false; for (const pending of heldRosters.splice(0)) pending.resolve(Response.json(roster())); });
  const openWorkspacePage = async () => {
    await click(button("Command palette"));
    const command = visible<HTMLElement>('[role="option"]').find(node => node.querySelector("strong")?.textContent === "Workspace management"); assert.ok(command);
    await act(async () => { command.click(); }); await waitFor(() => visible(".wm-page").length === 1, "Workspace management remains reachable during an import");
  };
  const key = (target: HTMLElement, value: string, options: { shiftKey?: boolean; isComposing?: boolean } = {}) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })); });
  try {
    await act(async () => { await import("../web/app.tsx"); }); await waitFor(() => tableIds().length === 3, "Actual App must bootstrap its roster");
    if (scenario === "global-drop-cross-page" || scenario === "refresh-gate" || workspaceGate) {
      await drop(rootApp(), [file()]); await drop(rootApp(), [file("second-attempt.json")]); await waitFor(() => uploads.length === 1, "The import owner must reject repeated global drops while pending");
      if (scenario === "global-drop-cross-page") await click(button("AI workspace"));
      if (workspaceGate) {
        await openWorkspacePage(); assert.ok(dom.container.textContent?.includes("An import is in progress."));
        await click(button("Inert second workspaceLocal workspace")); assert.equal(button("Switch to this workspace").disabled, true);
        await click(button("Backup and restore")); assert.equal(button("Create full backup").disabled, true); assert.equal(button("Restore from file").disabled, true);
        assert.ok((await activityTask(dom, "Import profiles")).classList.contains("is-running"));
      }
    } else {
      if (scenario === "group-context-defaults") {
        const groupFilter = visible<HTMLSelectElement>('select[aria-label="Group filter"]')[0]!;
        await act(async () => { groupFilter.value = "Override team"; groupFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
        assert.equal(tableIds().length, 0);
      }
      await click(button("Import profiles", visible<HTMLElement>(".profiles-workspace")[0]!)); assert.ok(dialog());
      if (scenario === "group-context-defaults") {
        const selects = [...dialog()!.querySelectorAll<HTMLSelectElement>("select")];
        assert.deepEqual(selects.map(node => node.value), ["", ""]);
        assert.deepEqual(selects.map(node => node.selectedOptions[0]?.textContent), ["Keep source groups", "Keep source platforms"]);
        assert.equal(dialog()!.querySelector(".import-transfer-details")?.hasAttribute("open"), false);
        assert.ok(!dialog()!.textContent?.includes("recreate the exact browser fingerprint"));
      }
      if (scenario === "explicit-overrides") {
        const selects = [...dialog()!.querySelectorAll<HTMLSelectElement>("select")];
        const group = selects.find(node => [...node.options].some(option => option.value === "Override team"));
        const platform = selects.find(node => [...node.options].some(option => option.value === "x.com")); assert.ok(group); assert.ok(platform);
        await act(async () => { group.value = "Override team"; group.dispatchEvent(new dom.window.Event("change", { bubbles: true })); platform.value = "x.com"; platform.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      }
      if (usingPaste) { await click(button("Paste text", dialog()!)); await type(dialog()!.querySelector<HTMLTextAreaElement>("textarea")!, "id=fixture_imported\nname=Imported healthy"); }
      else if (scenario === "modal-drop-stage-only") {
        await drop(dialog()!.querySelector<HTMLElement>(".bulkdrop")!, [file("staged.json")]); await dom.flush(); assert.equal(uploads.length, 0, "Dropping inside the dialog only stages files");
        assert.ok(dialog()!.textContent?.includes("staged.json")); await choose([file("chosen.json")]);
        await drop(dialog()!, [file("outside-staging-area.json")]); assert.equal(uploads.length, 0, "A drop elsewhere in an open dialog cannot bubble into immediate global import");
      } else await choose([file()]);
      assert.equal(uploads.length, 0, "Selecting files or entering text must wait for explicit submission");
      if (scenario === "exit-reopen") {
        const oldDialog = dialog()!, oldSave = button("Import profiles", oldDialog), presence = oldDialog.closest(".desktop-motion-presence") as HTMLElement;
        await click(button("Cancel", oldDialog)); assert.equal(dialog(), undefined); assert.equal(presence.getAttribute("aria-hidden"), "true"); assert.ok(presence.hasAttribute("inert"));
        await click(oldSave); await key(oldSave, "Enter"); assert.equal(uploads.length, 0, "Retained closing controls cannot import");
        await click(button("Import profiles", visible<HTMLElement>(".profiles-workspace")[0]!)); assert.ok(dialog()); assert.equal(dialog()!.querySelector(".filelist"), null);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); }); assert.ok(dialog(), "The previous exit timeout cannot remove a freshly reopened import draft"); assert.equal(uploads.length, 0); return;
      }
      await click(button("Import profiles", dialog()!), true); await waitFor(() => uploads.length === 1, "Submitting must dispatch exactly one upload");
      assert.equal(uploads[0]!.files[0]!.name, usingPaste ? "pasted-adspower.txt" : scenario === "modal-drop-stage-only" ? "chosen.json" : "source.json");
      if (usingPaste) assert.ok(uploads[0]!.files[0]!.text.includes("id=fixture_imported"));
    }
    assert.equal(alerts, 0); assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0]!.overrides, scenario === "explicit-overrides" ? { group: "Override team", platform: "x.com" } : {}, "Default source assignments must not be replaced by implicit empty group/platform overrides");
    if (!usingPaste) { assert.ok(uploads[0]!.files[0]!.text.includes('"group":"Source team"')); assert.ok(uploads[0]!.files[0]!.text.includes('"platform":"instagram.com"')); }
    if (dialog()) { await click(button("Cancel", dialog()!)); assert.ok(dialog(), "An issued import cannot be dismissed as if cancelled"); }
    if (scenario === "pending-draft-freeze") {
      const active = dialog()!, textarea = active.querySelector<HTMLTextAreaElement>("textarea")!, originalText = textarea.value;
      assert.equal(active.querySelector("fieldset")?.hasAttribute("disabled"), true); assert.equal(button("Cancel", active).disabled, true); assert.equal(button("Close", active).disabled, true);
      for (const node of active.querySelectorAll<HTMLElement>("button,input,select,textarea,summary,[tabindex]")) Object.defineProperty(node, "getClientRects", { configurable: true, value: () => [node.getBoundingClientRect()] });
      const controls = [...active.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')];
      assert.ok(controls.length); await act(async () => { controls[0]!.focus(); }); await key(controls[0]!, "Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, controls.at(-1));
      await key(controls.at(-1)!, "Tab"); assert.equal(dom.window.document.activeElement, controls[0]);
      await key(textarea, "Enter", { isComposing: true }); await key(textarea, "Escape", { isComposing: true }); await key(textarea, "Escape"); assert.ok(dialog()); assert.equal(uploads.length, 1);
      await type(textarea, "id=FORCED_NEW_DRAFT"); await choose([file("forced.json")]);
      await act(async () => {
        button("From file", active).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        for (const select of active.querySelectorAll<HTMLSelectElement>("select")) { select.value = [...select.options].find(option => !!option.value && option.value !== "__new__")!.value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }
      });
      assert.ok(active.querySelector("textarea")); assert.equal(active.querySelector(".filelist"), null); assert.equal(uploads.length, 1);
      await respond({ ok: false, error: "PRIVATE_IMPORT_ERROR" }); await waitFor(() => !!dialog() && !button("Import profiles", dialog()!).disabled, "A failed import must restore the original draft");
      assert.equal(dialog()!.querySelector<HTMLTextAreaElement>("textarea")!.value, originalText); assert.deepEqual([...dialog()!.querySelectorAll<HTMLSelectElement>("select")].map(node => node.value), ["", ""]); assert.equal(dialog()!.querySelector(".filelist"), null); return;
    }
    if (scenario === "false-result" || scenario === "missing-counts" || scenario === "network-error") {
      if (scenario === "network-error") await act(async () => { uploads[0]!.response.reject(new Error("http://person:PRIVATE_IMPORT_ERROR@proxy.invalid:8080")); });
      else await respond(scenario === "false-result" ? { ok: false, error: "PRIVATE_IMPORT_ERROR" } : { ok: true, files: 1, profiles: 2, errors: [] });
      await waitFor(() => !!dialog() && !button("Import profiles", dialog()!).disabled, "Failed or damaged result must leave the import draft reviewable");
      assert.equal(receipt(), undefined); assert.ok(!dialog()!.textContent?.includes("PRIVATE_IMPORT_ERROR"));
      assert.ok(dialog()!.textContent?.includes(scenario === "false-result" ? "The import was not confirmed." : scenario === "network-error" ? "The import could not be confirmed." : "The import service returned incomplete results."));
      await click(button("Cancel", dialog()!)); await openWorkspacePage(); await click(button("Backup and restore"));
      await waitFor(() => !button("Create full backup").disabled, "A failed import must release its workspace lease after recovery");
      assert.equal(button("Restore from file").disabled, false); assert.equal(alerts, 0); assert.deepEqual(unexpected, []); return;
    }
    if (scenario === "refresh-gate" || workspaceGate) holdRoster = true;
    await respond(completeBody());
    if (scenario === "refresh-gate") {
      await waitFor(() => heldRosters.length > 0, "The successful import must refresh the roster before releasing ownership");
      assert.ok(receipt()); assert.equal(button("Dismiss import result", receipt()!).disabled, true); assert.equal(button("Browse all environments", receipt()!).disabled, true);
      await click(button("Dismiss import result", receipt()!)); assert.ok(receipt(), "A refreshing receipt cannot be dismissed before the roster settles");
      await drop(rootApp(), [file("while-refreshing.json")]); assert.equal(uploads.length, 1, "The final refresh remains part of the import owner");
      await releaseRosters();
    }
    if (workspaceGate) {
      await waitFor(() => heldRosters.length > 0 && !!dom.container.textContent?.includes("Refreshing imported environments. Workspace actions will unlock shortly."), "The workspace lease stays owned through the final import refresh");
      assert.equal(button("Create full backup").disabled, true); assert.equal(button("Restore from file").disabled, true);
      await releaseRosters(); await waitFor(() => !button("Create full backup").disabled, "Workspace maintenance unlocks after all import refreshers settle");
      assert.equal(button("Restore from file").disabled, false); await click(button("Workspaces2")); assert.equal(button("Switch to this workspace").disabled, false);
      assert.equal(requests.some(item => item.method === "POST" && /activate|backups|restore/.test(item.path)), false); await viewActivityTask(dom, "Import profiles");
    }
    // Root owns the compact navigation entry. It stays visible when the summary's page is not active.
    if (scenario === "global-drop-cross-page") {
      assert.equal(receipt(), undefined); await viewActivityTask(dom, "Import profiles");
    }
    await waitFor(() => !!receipt(), "A confirmed import must produce a persistent inline receipt"); assert.equal(alerts, 0); assert.equal(uploads.length, 1);
    assert.ok(receipt()!.textContent?.includes("2 environment records imported or updated")); assert.deepEqual(visible<HTMLElement>(".import-receipt-totals strong", receipt()!).map(node => node.textContent), ["1", "3", "1"]);
    if (!visible<HTMLElement>(".import-receipt-details", receipt()!).length) await click(button("View import details", receipt()!));
    assert.ok(!receipt()!.textContent?.includes("PRIVATE")); assert.ok(receipt()!.textContent?.includes("do not establish that every invalid record was imported")); assert.ok(receipt()!.textContent?.includes("reported_but_unknown"));
    await click(button("View environments needing attention", receipt()!));
    await waitFor(() => tableIds().length === 2, "Attention must include earlier environments from the workspace"); assert.deepEqual(tableIds(), ["existing_proxy_review", "existing_restart_review"]);
    await click(button("Browse all environments", receipt()!)); await waitFor(() => tableIds().length === 4, "Browse all must clear the attention scope");
    assert.ok(tableIds().includes("fixture_imported")); await click(button("Dismiss import result", receipt()!)); assert.equal(receipt(), undefined);
    assert.equal(activityTrigger(dom), null); assert.deepEqual(unexpected, []);
  } finally {
    if (appRoot) await act(async () => { appRoot!.unmount(); });
    for (const upload of uploads) upload.response.resolve(Response.json({ ok: false })); for (const pending of heldRosters) pending.resolve(Response.json(roster())); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}

await run(process.argv[2] ?? "file-modal");
console.log("actual App import receipt interaction fixture passed");
