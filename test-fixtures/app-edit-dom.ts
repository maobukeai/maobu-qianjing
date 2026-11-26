import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLDetailsElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";
import { updateProfile } from "../web/api.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function run(scenario: string) {
  const qualityScenario = scenario.startsWith("quality-"), qualityAssistant = scenario === "quality-assistant", otherId = "quality_other";
  const timezoneRebase = scenario.startsWith("edit-timezone-rebase");
  const signedScenario = scenario.startsWith("signed-startup-");
  const id = qualityScenario ? "quality_selected" : "fixture_profile";
  const detail = (name = "Loaded fixture", password = "inert-saved-password") => ({ id, name, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", proxyType: "http", proxy: "", proxyError: "", username: "inert-user", password, email: "", emailPassword: "", twofa: "", resolution: "1920*1080", platformOs: "windows", extensions: [] as string[], tags: "", customNo: "", timezone: "UTC", timezoneManual: false, locale: "en-US", cores: "8", fingerprintSeed: "777", cookieCount: 0, seeded: true, mobilePersona: false });
  const uiProfile = (name = "Inert edit fixture", profileId = id) => ({ id: profileId, name, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false,
    ...(qualityScenario && profileId === id ? { fpImportComparison: { expectedCount: 1, comparedCount: 1, matchedCount: 1, differenceFields: [], missingFields: [] }, fpVerdict: { verdict: "mismatch", differences: [{ field: "canvas", expected: "inert-raw-expected", observed: "inert-raw-observed" }] } } : {}) });
  let roster = { ok: true, profiles: qualityScenario ? [uiProfile("Other fixture", otherId), uiProfile()] : [uiProfile()], groups: [], folders: [] };
  if (scenario === "edit-extensions-clear" || scenario === "edit-fingerprint-confirm") roster = { ...roster, profiles: [{ ...uiProfile(), running: true }] };
  const stored: Record<string, unknown> = { ...detail(), tags: [] };
  let reviewReads = 0, selectedReportName = "Selected stored report";
  let heldReview: ReturnType<typeof deferred<Response>> | undefined;
  const qualityReports = () => {
    const report = (profileId: string, name: string) => ({ profileId, name, status: "review", running: false,
      summary: { pass: 1, warn: 0, fail: 0, unknown: 1 }, checks: [
        { id: "identity_seed", label: "Stored seed", status: "pass", detail: "Fixture seed is present." },
        { id: "browser_sample", label: "Runtime sample", status: "unknown", detail: "Fixture measurement is unavailable." },
      ] });
    return { ok: true, reports: [report(otherId, "First report"), report(id, selectedReportName)] };
  };
  let holdRoster = false;
  const rosterWaits: Array<ReturnType<typeof deferred<Response>>> = [];
  const details: Array<ReturnType<typeof deferred<Response>>> = [];
  const saves: Array<{ set: Record<string, unknown>; response: ReturnType<typeof deferred<Response>> }> = [];
  const totps: Array<ReturnType<typeof deferred<Response>>> = [];
  const timezones: Array<ReturnType<typeof deferred<Response>>> = [];
  const requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const nativeCalls: Array<{ command: string; args: unknown }> = [];
  const signedVersion = "1.0.0-fixture";
  const signedStatus = { configured: true, status: "idle", currentVersion: "0.1.0-fixture", endpoint: "https://example.invalid/latest.json", message: "Trusted channel ready.", update: null };
  const signedRelease = { ...signedStatus, status: "available", message: "A signed update is available.", update: { version: signedVersion, currentVersion: signedStatus.currentVersion, notes: "Synthetic release notes", publishedAt: null } };
  const signedCheck = deferred<typeof signedRelease>();
  let signedAvailable = false;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET";
    requests.push({ path, method });
    if (path === `/ui/api/profiles/${id}` && method === "GET") { const result = deferred<Response>(); details.push(result); return result.promise; }
    if (path === `/ui/api/profiles/${id}/update` && method === "POST") { const result = deferred<Response>(); saves.push({ set: JSON.parse(String(options?.body)).set, response: result }); return result.promise; }
    if (timezoneRebase && path === `/ui/api/profiles/${id}/timezone` && method === "POST") { assert.deepEqual(JSON.parse(String(options?.body)), {}); const result = deferred<Response>(); timezones.push(result); return result.promise; }
    if (path === `/ui/api/profiles/${id}/totp` && method === "GET") {
      const result = deferred<Response>(); totps.push(result);
      if (scenario !== "totp-session") result.resolve(json({ ok: true, code: null }));
      return result.promise;
    }
    if (path === "/ui/api/profiles" && method === "GET") {
      if (holdRoster) { const result = deferred<Response>(); rosterWaits.push(result); return result.promise; }
      return json(roster);
    }
    if (qualityScenario && path === "/ui/api/settings/fingerprints" && method === "GET") {
      assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
      reviewReads++;
      if (reviewReads === 2) { const pending = deferred<Response>(); heldReview = pending; return pending.promise; }
      return json(qualityReports());
    }
    if (signedScenario && method === "GET") {
      if (path === "/ui/api/settings") return json({ ok: true, settings: { version: 1, signedUpdates: { checkOnStartup: true }, updates: { repository: "", channel: "stable", checkOnStartup: false }, sync: { enabled: false, folder: "", retainSnapshots: 3 } } });
      if (path === "/ui/api/settings/updates") return json({ ok: true, update: null });
      if (path === "/ui/api/settings/runtimes") return json({ ok: true, inventory: { checked: false, host: { platform: "win32", arch: "x64" }, defaultRuntime: "aliasmode-chromium", chromiumDefault: "aliasmode-chromium", runtimes: ["aliasmode-chromium", "cloakbrowser", "aliasmode-firefox"].map(id => ({ id, pinnedVersion: "100.0.0", hostSupported: true, source: "managed", cache: "not-checked" })) } });
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-fixture-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [{ id: "default", name: "Inert fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-fixture-root", profileCount: 1, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Blocked non-fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch, desktop: signedScenario });
  const originalConfirm = Object.getOwnPropertyDescriptor(globalThis, "confirm"); let confirmations = 0, confirmDecision = true;
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => { confirmations++; return confirmDecision; } });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => { confirmations++; return confirmDecision; } });
  dom.container.id = "root";
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled in this fixture"); } });
  if (signedScenario) Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: {
    async invoke(command: string, args: unknown) {
      nativeCalls.push({ command, args });
      if (command === "agent_runtime_ready") return;
      if (command === "signed_update_status") return signedAvailable ? signedRelease : signedStatus;
      if (command === "signed_update_check") return signedCheck.promise;
      unexpected.push(`native ${command}`); throw new Error(`Blocked non-fixture native command: ${command}`);
    },
  } });
  let appRoot: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const root = createRealRoot(...args); appRoot = root; return root; } }));
  // Exit motion may retain a visual snapshot briefly. It is already inert and
  // hidden to assistive technology, so it is no longer an active editor.
  const editor = () => [...dom.container.querySelectorAll<HTMLElement>('[role="dialog"][aria-labelledby="edit-profile-title"]')]
    .find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const button = (source: string) => { const value = [...editor()!.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === source); assert.ok(value, `Missing ${source}`); return value; };
  const close = () => { const value = editor()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]'); assert.ok(value); return value; };
  const confirmDiscard = async () => {
    const confirmation = [...dom.window.document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]'));
    assert.ok(confirmation, "Closing this edited draft must first ask for an explicit discard");
    const discard = [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Discard changes"); assert.ok(discard);
    await act(async () => discard.click());
  };
  const confirmDialogButton = async (label: string) => {
    const confirmation = [...dom.window.document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]'));
    assert.ok(confirmation, `Expected confirmation dialog with "${label}"`);
    const target = [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
    assert.ok(target, `Missing confirmation button "${label}"`);
    await act(async () => target.click());
  };
  const name = () => { const value = [...editor()!.querySelectorAll("label")].find(label => label.querySelector("span")?.textContent === "Name")?.querySelector<HTMLInputElement>("input"); assert.ok(value); return value; };
  const password = () => { const value = editor()!.querySelector<HTMLInputElement>('input[aria-label="Password"]'); assert.ok(value); return value; };
  const profileButton = () => { const value = dom.container.querySelector<HTMLButtonElement>(".profile-name-button"); assert.ok(value); return value; };
  const type = (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, message: string, timeout = 2500) => { const deadline = Date.now() + timeout; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), `${message}; requests=${JSON.stringify(requests)}`); };
  const respond = (pending: ReturnType<typeof deferred<Response>>, response: Response) => act(async () => { pending.resolve(response); });
  const open = () => act(async () => { profileButton().click(); });
  const loaded = async (index = details.length - 1, next = detail()) => { await respond(details[index]!, json({ ok: true, profile: next })); assert.equal(button("Save changes").disabled, true, "A validated but unchanged editor must not issue a write"); };
  const preview = () => editor()!.querySelector<HTMLElement>(".edit-changes-summary")!;
  const field = (label: string) => { const input = [...editor()!.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input"); assert.ok(input, `Missing field ${label}`); return input; };
  const fingerprintFields = async () => { const panel = editor()!.querySelector<HTMLDetailsElement>(".fingerprint-settings"); assert.ok(panel); if (!panel.open) await act(async () => { panel.querySelector("summary")!.click(); }); assert.equal(panel.open, true); };
  const assertLocked = async () => {
    assert.ok(editor()!.querySelector("fieldset[disabled]")); assert.equal(close().disabled, true); assert.equal(button("Cancel").disabled, true);
    await act(async () => { close().click(); button("Cancel").click(); editor()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.ok(editor(), "Pending saves must not close through X, Cancel or Escape");
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => !!dom.container.querySelector(".profile-name-button"), "Actual App did not reach the inert roster");
    assert.ok(appRoot);
    if (signedScenario) {
      const banner = () => dom.container.querySelector<HTMLElement>(".signed-update-notice");
      const checks = () => nativeCalls.filter(item => item.command === "signed_update_check");
      await waitFor(() => checks().length > 0, "Opt-in signed check did not start");
      assert.equal(banner(), null, "A check in progress must not show an available update");
      assert.equal(dom.container.querySelector('[role="dialog"]'), null, "Startup must not interrupt the roster");
      await act(async () => { signedAvailable = true; signedCheck.resolve(signedRelease); });
      assert.equal(banner()?.querySelector('[role="status"]')?.textContent, `Signed desktop update ${signedVersion} is available.`);
      if (scenario === "signed-startup-view") {
        const cta = [...banner()!.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "View update");
        assert.ok(cta); await act(async () => { cta.click(); });
        const tab = dom.container.querySelector('[role="tab"][data-settings-tab="updates"]');
        assert.equal(tab?.getAttribute("aria-selected"), "true");
        assert.equal(dom.window.document.activeElement, tab, "Keyboard focus should move to the selected tab");
        await waitFor(() => dom.container.querySelector(".signed-update-card")?.textContent?.includes("Synthetic release notes") === true, "Settings did not show the available signed release");
      } else {
        const dismiss = banner()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
        assert.ok(dismiss); await act(async () => { dismiss.click(); });
        assert.ok(dom.container.querySelector(".profile-name-button"), "Dismissing must leave the current view open");
      }
      assert.equal(banner(), null);
      assert.deepEqual(checks(), [{ command: "signed_update_check", args: { startup: true } }]);
      assert.deepEqual(unexpected, []);
      assert.ok(requests.every(request => request.method === "GET" || request.path === "/ui/api/workspace/preferences"));
      return;
    }
    if (qualityScenario) {
      const badge = dom.container.querySelector(".fpbadge");
      assert.equal(badge?.textContent, "Stored import match");
      assert.doesNotMatch(badge?.getAttribute("title") ?? "", /inert-raw|verified against the import/);
      const aiPage = () => dom.container.querySelector<HTMLElement>(".assistant-workspace")!;
      const aiDraft = () => aiPage().querySelector<HTMLTextAreaElement>("textarea")!;
      let originalDraft = "";
      if (qualityAssistant) {
        const aiNav = [...dom.container.querySelectorAll<HTMLButtonElement>(".navitem")].find(item => item.textContent?.trim() === "AI workspace"); assert.ok(aiNav);
        await act(async () => { aiNav.click(); });
        const example = aiPage().querySelector<HTMLButtonElement>(".assistant-examples button"); assert.ok(example);
        await act(async () => { example.click(); });
        originalDraft = aiDraft().value; assert.ok(originalDraft.length > 0);
      }
      const settings = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "Settings");
      assert.ok(settings);
      await act(async () => { settings.click(); });
      const qualityTab = dom.container.querySelector<HTMLButtonElement>("#settings-tab-fingerprints"); assert.ok(qualityTab);
      await act(async () => { qualityTab.click(); });
      const select = () => dom.container.querySelector<HTMLSelectElement>("#settings-panel select")!;
      const filter = () => dom.container.querySelector<HTMLInputElement>("#settings-panel .quality-filter input")!;
      const cta = () => [...dom.container.querySelectorAll<HTMLButtonElement>("#settings-panel button")].find(item => item.textContent?.trim() === "Edit profile configuration")!;
      await waitFor(() => !!cta() && !cta().disabled, "Fingerprint review did not load in the actual App");
      assert.equal(select().value, otherId);
      await act(async () => { select().value = id; select().dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await act(async () => { filter().click(); });
      assert.equal(cta().getAttribute("aria-label"), "Edit Selected stored report");
      assert.equal(filter().checked, true);
      if (qualityAssistant) {
        const explain = [...dom.container.querySelectorAll<HTMLButtonElement>("#settings-panel button")].find(item => item.textContent?.trim() === "Draft AI explanation"); assert.ok(explain);
        await act(async () => { explain.click(); });
        assert.equal(aiPage().hidden, false);
        const suggestion = aiPage().querySelector<HTMLElement>(".assistant-suggestion"); assert.ok(suggestion);
        const preview = suggestion.querySelector("pre")?.textContent ?? "";
        assert.match(preview, /Browser measurement · unknown/);
        assert.doesNotMatch(preview, /quality_selected|Selected stored report|Fixture measurement|inert-raw/);
        assert.equal(aiDraft().value, originalDraft, "Preparing an explanation must not overwrite an existing draft");
        const add = [...suggestion.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "Add to draft"); assert.ok(add);
        await act(async () => { add.click(); add.click(); });
        assert.equal(aiDraft().value, `${originalDraft}\n\n${preview}`);
        assert.equal(aiPage().querySelector(".assistant-suggestion"), null);
        assert.equal(details.length, 0); assert.equal(saves.length, 0); assert.equal(reviewReads, 1);
        assert.deepEqual(unexpected, []);
        assert.ok(requests.every(request => request.method === "GET" || request.path === "/ui/api/workspace/preferences"));
        return;
      }
      const entry = cta(); entry.focus();
      await act(async () => { entry.click(); entry.click(); });
      assert.equal(details.length, 1, "The quality shortcut must not open a duplicate editor");
      await loaded(0, detail("Selected editable profile"));
      assert.equal(name().value, "Selected editable profile");
      await act(async () => { button("Cancel").click(); });
      assert.equal(editor(), null); assert.equal(saves.length, 0); assert.equal(reviewReads, 1);
      assert.equal(dom.window.document.activeElement, entry, "Cancel must return focus to the same report control");
      assert.equal(select().value, id); assert.equal(filter().checked, true);
      await act(async () => { entry.click(); }); await loaded(1, detail("Selected editable profile"));
      await type(name(), "Saved from quality report");
      await act(async () => { button("Save changes").click(); });
      assert.equal(saves.length, 1); assert.equal(saves[0]!.set.name, "Saved from quality report"); assert.equal(reviewReads, 1);
      selectedReportName = "Saved from quality report";
      roster = { ...roster, profiles: [uiProfile("Other fixture", otherId), uiProfile(selectedReportName)] };
      await respond(saves[0]!.response, json({ ok: true }));
      await waitFor(() => !editor() && !!heldReview && cta().disabled, "The editor should close while the refreshed report is pending");
      assert.equal(dom.window.document.activeElement, qualityTab, "Focus must stay in the selected tab while the report control is disabled");
      await respond(heldReview!, json(qualityReports()));
      await waitFor(() => !editor() && cta()?.getAttribute("aria-label") === "Edit Saved from quality report", "Saved editor did not return to the refreshed selected report");
      assert.equal(reviewReads, 2); assert.equal(select().value, id); assert.equal(filter().checked, true);
      assert.equal(qualityTab.getAttribute("aria-selected"), "true");
      assert.ok(dom.container.querySelector("#settings-panel")?.textContent?.includes("Showing 1 of 2 checks"));
      assert.deepEqual(unexpected, []);
      assert.deepEqual(requests.filter(request => request.method !== "GET" && request.path !== "/ui/api/workspace/preferences"), [{ path: `/ui/api/profiles/${id}/update`, method: "POST" }]);
      return;
    }
    await open();
    assert.equal(details.length, 1); assert.equal(totps.length, 0, "An unvalidated detail must not start reading TOTP");
    assert.equal(button("Save changes").disabled, true); assert.equal(editor()!.querySelector("input"), null, "Loading cannot expose an editable blank draft");
    if (scenario.startsWith("edit-")) {
      if (scenario === "edit-quarantine-preserve" || scenario === "edit-quarantine-clear") await loaded(0, { ...detail(), proxyError: "Inert stored proxy needs repair" });
      else if (timezoneRebase) await loaded(0, { ...detail(), proxy: "proxy.example:8080:person:inert-proxy-password", timezoneManual: true });
      else if (scenario === "edit-extensions-clear") await loaded(0, { ...detail(), extensions: ["inert-extension"] });
      else if (scenario === "edit-legacy-partial") await loaded(0, { ...detail(), tags: Array.from({ length: 21 }, (_, index) => `legacy${index}`).join(","), fingerprintSeed: "", resolution: "legacy screen" });
      else await loaded();
      assert.ok(editor()!.querySelector(".profile-editor-status-count")?.textContent?.includes("No changes to save"));
      assert.equal(preview(), null, "The footer is the only empty change summary");
      if (scenario === "edit-noop") {
        await act(async () => { button("Save changes").click(); }); assert.equal(saves.length, 0);
        await fingerprintFields(); await type(field("Screen"), "1920x1080"); await type(field("CPU"), "08"); await type(field("Fingerprint seed"), "0777"); await type(field("Language"), "EN-us");
        assert.equal(button("Save changes").disabled, true); assert.equal(preview(), null); assert.equal(confirmations, 0);
        await act(async () => { button("Cancel").click(); });
        await confirmDiscard();
      } else if (scenario === "edit-concurrent-fields") {
        const concurrent = updateProfile(id, { password: "concurrent-inert-password", tags: ["concurrent tag"], proxy: "concurrent.example:8080" });
        await waitFor(() => saves.length === 1, "An independent client must update its own selected fields"); Object.assign(stored, saves[0]!.set); await respond(saves[0]!.response, json({ ok: true })); await concurrent;
        assert.equal(password().value, "inert-saved-password", "The open draft retains its baseline until explicitly reopened");
        await type(name(), "Metadata-only edit"); await act(async () => { button("Save changes").click(); }); assert.equal(saves.length, 2); assert.deepEqual(saves[1]!.set, { name: "Metadata-only edit" });
        Object.assign(stored, saves[1]!.set); await respond(saves[1]!.response, json({ ok: true })); await waitFor(() => !editor(), "A metadata-only partial update must finish");
        assert.equal(stored.password, "concurrent-inert-password"); assert.deepEqual(stored.tags, ["concurrent tag"]); assert.equal(stored.proxy, "concurrent.example:8080"); assert.equal(confirmations, 0);
      } else if (scenario === "edit-quarantine-preserve" || scenario === "edit-legacy-partial") {
        await type(name(), "Metadata-only edit"); await act(async () => { button("Save changes").click(); });
        assert.deepEqual(saves[0]!.set, { name: "Metadata-only edit" }); assert.equal(confirmations, 0); await respond(saves[0]!.response, json({ ok: true })); await waitFor(() => !editor(), "Unchanged legacy fields must not block a name update");
      } else if (scenario === "edit-quarantine-clear") {
        await act(async () => { button("Remove invalid proxy").click(); }); assert.equal(saves.length, 0); assert.ok(preview().textContent?.includes("Proxy settings")); assert.ok(editor()!.textContent?.includes("direct connection"));
        await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[0]!.set, { proxy: "", proxyType: "http" });
        await respond(saves[0]!.response, json({ ok: false, error: "Inert clear refused" }, 500)); assert.ok(editor()); assert.equal(button("Save changes").disabled, false);
        await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[1]!.set, { proxy: "", proxyType: "http" }); await respond(saves[1]!.response, json({ ok: true })); await waitFor(() => !editor(), "An explicit quarantine clear must survive a failed first save"); assert.equal(confirmations, 0);
      } else if (timezoneRebase) {
        const timezoneDraft = scenario === "edit-timezone-rebase-timezone-draft" ? "Europe/Berlin" : undefined;
        const localeDraft = scenario === "edit-timezone-rebase-locale-draft" ? "de-DE" : undefined;
        await type(name(), "Draft survives timezone refresh");
        await fingerprintFields();
        if (timezoneDraft) await type(field("Timezone"), timezoneDraft);
        if (localeDraft) await type(field("Language"), localeDraft);
        await act(async () => { button("Set timezone and language from proxy").click(); });
        await confirmDialogButton("Continue"); assert.equal(timezones.length, 1); assert.equal(confirmations, 0); await assertLocked();
        stored.timezone = "Europe/Paris"; stored.locale = "fr-FR"; stored.timezoneManual = false;
        roster = { ...roster, profiles: [{ ...uiProfile(), timezone: "Europe/Paris" }] };
        await respond(timezones[0]!, json({ ok: true, timezone: "Europe/Paris", locale: "fr-FR" }));
        await waitFor(() => !button("Save changes").disabled, "A persisted automatic timezone refresh must release the editor");
        assert.equal(name().value, "Draft survives timezone refresh");
        assert.equal(field("Timezone").value, timezoneDraft ?? "Europe/Paris", "Keep a typed timezone and otherwise show the new saved timezone");
        assert.equal(field("Language").value, localeDraft ?? "fr-FR", "Keep a typed language and otherwise show the new saved language");
        const changedFields = [...preview().querySelectorAll("li > span")].map(node => node.textContent);
        assert.deepEqual(changedFields, ["Name", ...(timezoneDraft ? ["Timezone"] : []), ...(localeDraft ? ["Language"] : [])]);
        assert.equal(saves.length, 0, "Refreshing the connection must not save the draft");
        await act(async () => { button("Save changes").click(); });
        if (timezoneDraft || localeDraft) await confirmDialogButton("Save fingerprint changes");
        assert.deepEqual(saves[0]!.set, { name: "Draft survives timezone refresh", ...(timezoneDraft ? { timezone: timezoneDraft } : {}), ...(localeDraft ? { locale: localeDraft } : {}) });
        assert.equal(confirmations, 0);
        Object.assign(stored, saves[0]!.set); await respond(saves[0]!.response, json({ ok: true })); await waitFor(() => !editor(), "The remaining draft must save separately");
      } else if (scenario === "edit-invalid-locale") {
        await fingerprintFields(); await type(field("Screen"), ""); assert.equal(button("Save changes").disabled, true); assert.ok(editor()!.querySelector('[role="alert"]')?.textContent?.includes("cannot clear the saved screen size"));
        await type(field("Screen"), "PRIVATE_BAD_SCREEN"); assert.equal(button("Save changes").disabled, true); assert.ok(!editor()!.querySelector('[role="alert"]')?.textContent?.includes("PRIVATE_BAD_SCREEN"));
        await type(field("Screen"), "1920x1080"); await type(field("Language"), ""); assert.equal(button("Save changes").disabled, true); assert.ok(preview().textContent?.includes("keeps the saved language"));
        await act(async () => { button("Save changes").click(); }); assert.equal(saves.length, 0);
        await type(name(), "Name with unchanged language"); await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[0]!.set, { name: "Name with unchanged language" }); assert.equal(confirmations, 0);
        await respond(saves[0]!.response, json({ ok: true })); await waitFor(() => !editor(), "A disclosed locale no-op must not prevent an independent name edit");
      } else if (scenario === "edit-extensions-clear") {
        const checkbox = editor()!.querySelector<HTMLInputElement>(".extassign input"); assert.ok(checkbox); assert.equal(checkbox.checked, true); await act(async () => { checkbox.click(); });
        assert.ok(preview().textContent?.includes("The open browser keeps its current settings")); await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[0]!.set, { extensions: [] }); assert.equal(confirmations, 0);
        await respond(saves[0]!.response, json({ ok: true })); await waitFor(() => !editor(), "An explicit empty extension selection must save");
      } else if (scenario === "edit-fingerprint-confirm") {
        await fingerprintFields(); await type(field("Screen"), "1600x900"); assert.ok(preview().textContent?.includes("Next start")); assert.ok(!preview().textContent?.includes("1600"));
        await act(async () => { button("Save changes").click(); }); await confirmDialogButton("Cancel"); assert.equal(confirmations, 0); assert.equal(saves.length, 0);
        await act(async () => { button("Save changes").click(); }); await confirmDialogButton("Save fingerprint changes"); assert.equal(confirmations, 0); assert.deepEqual(saves[0]!.set, { resolution: "1600x900" }); await respond(saves[0]!.response, json({ ok: true })); await waitFor(() => !editor(), "Confirmed fingerprint fields must use their normalized partial patch");
      } else if (scenario === "edit-missing-ok") {
        await type(name(), "Strict result draft"); await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[0]!.set, { name: "Strict result draft" });
        await respond(saves[0]!.response, json({ saved: true })); assert.ok(editor()); assert.equal(name().value, "Strict result draft"); assert.equal(button("Save changes").disabled, false);
        await act(async () => { button("Save changes").click(); }); assert.deepEqual(saves[1]!.set, { name: "Strict result draft" }); await respond(saves[1]!.response, json({ ok: true })); await waitFor(() => !editor(), "Only an explicit ok result may complete a save");
      } else throw new Error(`Unknown edit scenario: ${scenario}`);
      assert.equal(editor(), null); assert.deepEqual(unexpected, []);
      assert.ok(requests.filter(request => request.method !== "GET" && request.path !== "/ui/api/workspace/preferences").every(request => request.path === `/ui/api/profiles/${id}/update` || timezoneRebase && request.path === `/ui/api/profiles/${id}/timezone`));
      return;
    }
    if (scenario === "load-retry") {
      await respond(details[0]!, json({ ok: false, error: "Inert profile detail unavailable" }, 503));
      assert.ok(editor()!.querySelector('[role="alert"]')?.textContent?.includes("Inert profile detail unavailable"));
      assert.equal(button("Save changes").disabled, true); assert.equal(editor()!.querySelector("input"), null);
      await act(async () => { button("Save changes").click(); }); assert.equal(saves.length, 0);
      const retry = button("Retry loading profile"); retry.focus(); await act(async () => { retry.click(); retry.click(); });
      assert.equal(details.length, 2); assert.equal(retry.disabled, true); assert.equal(retry.getAttribute("aria-busy"), "true");
      await act(async () => { details[1]!.reject(new Error("Inert detail connection timeout")); });
      assert.equal(button("Retry loading profile").disabled, false); assert.equal(button("Save changes").disabled, true); assert.equal(totps.length, 0);
      await act(async () => { button("Retry loading profile").click(); }); await loaded(2);
      assert.equal(name().value, "Loaded fixture"); assert.equal(password().value, "inert-saved-password"); assert.equal(totps.length, 1);
      await act(async () => { button("Cancel").click(); }); assert.equal(saves.length, 0);
    } else if (scenario === "load-malformed") {
      for (const [index, malformed] of [{ ...detail(), id: "different_profile" }, { id, name: "Partial fixture" }].entries()) {
        await respond(details[index]!, json({ ok: true, profile: malformed }));
        assert.ok(editor()!.querySelector('[role="alert"]')?.textContent?.includes("incomplete profile details"));
        assert.equal(button("Save changes").disabled, true); assert.equal(editor()!.querySelector("input"), null); assert.equal(totps.length, 0);
        await act(async () => { button("Retry loading profile").click(); });
      }
      await loaded(2); await act(async () => { close().click(); }); assert.equal(saves.length, 0);
    } else if (scenario.startsWith("same-id")) {
      await act(async () => { button("Cancel").click(); profileButton().click(); });
      assert.equal(details.length, 2); await loaded(1, detail("Current session", "current-inert-password"));
      await type(name(), "Current edited draft"); await type(password(), "new-inert-password");
      await act(async () => {
        if (scenario === "same-id-error") details[0]!.reject(new Error("Inert stale detail failure"));
        else details[0]!.resolve(json({ ok: true, profile: detail("Stale session", "stale-inert-password") }));
      });
      assert.equal(name().value, "Current edited draft"); assert.equal(password().value, "new-inert-password"); assert.equal(editor()!.querySelector('[role="alert"]'), null); assert.equal(totps.length, 1);
      await act(async () => { close().click(); });
      await confirmDiscard();
    } else if (scenario === "totp-session") {
      await loaded(); assert.equal(totps.length, 1);
      await act(async () => { button("Cancel").click(); profileButton().click(); }); await loaded(1, detail("New same-id session")); assert.equal(totps.length, 2);
      await respond(totps[1]!, json({ ok: true, code: "222222", secondsRemaining: 29 }));
      assert.equal(editor()!.querySelector(".authcode")?.textContent, "222 222");
      await respond(totps[0]!, json({ ok: true, code: "111111", secondsRemaining: 29 }));
      assert.equal(editor()!.querySelector(".authcode")?.textContent, "222 222");
      await act(async () => { button("Cancel").click(); });
    } else {
      await loaded(); await type(name(), "Saved draft");
      const active = editor(), save = button("Save changes"), cancel = button("Cancel"), x = close();
      // All four events arrive before React commits disabled controls. The ref
      // must prevent both duplicate writes and closing an in-flight editor.
      await act(async () => { save.click(); save.click(); cancel.click(); x.click(); active!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      assert.equal(saves.length, 1); assert.equal(editor(), active); assert.deepEqual(saves[0]!.set, { name: "Saved draft" });
      await assertLocked();
      if (scenario === "save-success") {
        holdRoster = true; await respond(saves[0]!.response, json({ ok: true, restartRequired: true }));
        await waitFor(() => rosterWaits.length === 1, "A successful edit must await its roster refresh");
        assert.equal(editor(), active); await assertLocked();
        roster = { ...roster, profiles: [uiProfile("Saved draft")] }; holdRoster = false;
        await respond(rosterWaits[0]!, json(roster)); await waitFor(() => !editor(), "The completed edit did not close");
        assert.match(dom.container.querySelector(".notice")?.textContent ?? "", /restart.*proxy and fingerprint/i);
        await open(); await loaded(1, detail("Fresh reopened draft")); await type(name(), "New draft survives"); await dom.flush(); assert.equal(name().value, "New draft survives");
        await act(async () => { button("Cancel").click(); });
        await confirmDiscard();
        const dismissNotice = dom.container.querySelector<HTMLButtonElement>(".notice-dismiss"); assert.ok(dismissNotice, "The success notice must expose a keyboard-accessible dismiss button");
        await act(async () => { dismissNotice.focus(); dismissNotice.click(); });
        await waitFor(() => !dom.container.querySelector(".notice"), "The dismissed success notice did not finish its visual exit");
      } else {
        await act(async () => {
          if (scenario === "save-network-error") saves[0]!.response.reject(new Error("Inert update connection timeout"));
          else saves[0]!.response.resolve(json({ ok: false, ...(scenario === "save-conflict" ? {} : { error: "Inert update rejected" }) }, scenario === "save-conflict" ? 409 : 500));
        });
        assert.equal(editor(), active); assert.equal(name().value, "Saved draft"); assert.equal(password().value, "inert-saved-password");
        assert.equal(editor()!.querySelector("fieldset[disabled]"), null); assert.equal(button("Save changes").disabled, false); assert.equal(button("Cancel").disabled, false); assert.equal(close().disabled, false);
        assert.ok(editor()!.querySelector('[role="alert"]')?.textContent?.includes(scenario === "save-network-error" ? "Inert update connection timeout" : scenario === "save-conflict" ? "Profile changed; reopen Edit before saving" : "Inert update rejected"));
        if (scenario === "save-conflict") {
          await dom.flush(); assert.equal(saves.length, 1, "A conflict must not automatically retry or merge the draft");
          await act(async () => { button("Cancel").click(); }); await confirmDiscard(); await open(); await loaded(1, detail("Explicitly reopened after conflict"));
          assert.equal(name().value, "Explicitly reopened after conflict"); await dom.flush(); assert.ok(editor(), "The old failed save must not close a reopened editor");
          await act(async () => { button("Cancel").click(); });
        } else {
          await type(name(), "Retry draft"); await type(password(), "retry-inert-password");
          const retry = button("Save changes"); await act(async () => { retry.click(); retry.click(); });
          assert.equal(saves.length, 2); assert.equal(saves[1]!.set.name, "Retry draft"); assert.equal(saves[1]!.set.password, "retry-inert-password");
          await respond(saves[1]!.response, json({ ok: true })); await waitFor(() => !editor(), "A successful retry must release and close the editor");
        }
      }
    }
    assert.equal(editor(), null); assert.deepEqual(unexpected, []);
    assert.ok(requests.filter(request => request.method !== "GET" && request.path !== "/ui/api/workspace/preferences").every(request => request.path === `/ui/api/profiles/${id}/update`), "Editing must not launch, restart, regenerate, create, convert or look up a network location");
  } finally { if (appRoot) await act(async () => { appRoot!.unmount(); }); await dom.cleanup(); if (originalConfirm) Object.defineProperty(globalThis, "confirm", originalConfirm); else Reflect.deleteProperty(globalThis, "confirm"); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "load-retry"); console.log("full App edit interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
