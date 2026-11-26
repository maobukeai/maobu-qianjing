import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { HTMLButtonElement as DomButton, HTMLInputElement as DomInput, HTMLSelectElement as DomSelect } from "happy-dom";
import { getBrowserRuntimeInventory } from "../runtime-inventory.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { FeatureSettingsPanel } from "../web/settings-center.tsx";
import { createWebDomHarness } from "./web-dom.ts";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const updates = scenario === "announcement-source" || scenario === "status-retry";
  const file = (digit: string) => ({ fileName: `maobu-sync-170000000000${digit}-${digit.repeat(16)}.mqsync`, createdAt: 1700000000000 + Number(digit), modifiedAt: 1700000000000, bytes: 1024 });
  const first = file("1"), second = file("2");
  let files = [first], failFiles = false, failPreview = false, expired = scenario === "expired-preview", holdFiles = false, holdCreate = scenario === "create-refresh-failure";
  let settings = { version: 1, updates: { repository: "announcements/repo", channel: "stable", checkOnStartup: false }, sync: { enabled: scenario !== "disabled-empty", folder: "/inert-fixture-sync", retainSnapshots: 10 } };
  const requests: Array<{ path: string; method: string; body: any }> = [], native: Array<{ command: string; payload: any }> = [];
  const create = deferred<Response>(), listing = deferred<Response>(), statusRetry = deferred<unknown>(), install = deferred<void>();
  const importResponse = deferred<Response>(), rosterRefresh = deferred<void>(), workspaceRefresh = deferred<void>(), previewResponse = deferred<Response>();
  const coordinated = scenario.startsWith("import-"), coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });
  const locatedProfiles: string[] = [];
  let importedCallbacks = 0, failRosterRefresh = scenario === "import-refresh-failure";
  if (scenario === "import-refresh-failure") coordinator.registerWorkspaceRefresh(() => workspaceRefresh.promise);
  let statusReads = 0, previewCalls = 0;
  const trusted = { configured: true, status: "available", currentVersion: "1.0.0", endpoint: "https://publisher.invalid/trusted.json", message: "Trusted fixture update", update: { version: "2.0.0", currentVersion: "1.0.0", notes: "Publisher update", publishedAt: null } };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const failed = (message: string, status = 503) => json({ ok: false, error: message }, status);
  const additions = scenario === "all-conflicts" ? [] : scenario === "import-receipt-page"
    ? Array.from({ length: 12 }, (_, index) => ({ id: `new${index + 1}`, name: `New environment ${index + 1}`, group: "", conflict: false, hasSession: false }))
    : [{ id: "new", name: "New environment", group: "", conflict: false, hasSession: true }];
  const skipped = { id: "existing", name: "Existing environment", group: "", conflict: true, hasSession: false };
  const preview = () => ({ ok: true, previewHash: (previewCalls > 1 ? "b" : "a").repeat(64), preview: { profileCount: additions.length + 1, sessionCount: additions.filter(profile => profile.hasSession).length, newCount: additions.length, conflictCount: 1, profiles: [...additions, skipped] } });
  const receiptCounts = scenario === "import-receipt-count-mismatch" ? { imported: 2, skipped: 0 } : { imported: additions.length, skipped: 1 };
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : null;
    if (path === "/ui/api/shell-language") return json({ ok: true, language: "en-US" });
    requests.push({ path, method, body });
    if (path === "/ui/api/settings") { if (method === "PATCH") settings = { ...settings, ...body }; return json({ ok: true, settings }); }
    if (path === "/ui/api/settings/sync/files") { if (holdFiles) return listing.promise; return failFiles ? failed("Fixture file list unavailable") : json({ ok: true, files }); }
    if (path === "/ui/api/settings/sync/create") return holdCreate ? create.promise : json({ ok: true, file: second, profileCount: 3 });
    if (path === "/ui/api/settings/sync/preview") { previewCalls++; if (scenario === "preview-new-focus") return previewResponse.promise; return failPreview ? failed("Unable to unlock sync snapshot. Check the password and file integrity.") : json(preview()); }
    if (path === "/ui/api/settings/sync/import") return scenario === "import-unmount" ? importResponse.promise : expired ? failed("Preview this snapshot again before importing", 409) : json({ ok: true, ...receiptCounts });
    if (path === "/ui/api/settings/updates") return json({ ok: true, update: method === "GET" ? null : { status: "available", currentVersion: "1.0.0", repository: settings.updates.repository, channel: "stable", checkedAt: 1, cached: false, latest: { version: "99.0.0", tag: "v99", name: "Announcement only version", notes: "Not an installable publisher source", publishedAt: null, url: "https://github.com/announcements/repo/releases/v99", assets: [] } } });
    if (path === "/ui/api/settings/runtimes") return json({ ok: true, inventory: getBrowserRuntimeInventory({ runtimeRoot: "/inert-cache", platform: "win32", arch: "x64", chromiumDefault: "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed" }) });
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ desktop: updates, fetch: fakeFetch });
  if (updates) mockIPC((command, payload) => { native.push({ command, payload }); if (command === "signed_update_status") { statusReads++; if (scenario === "status-retry") { if (statusReads === 1) throw new Error("Fixture status unavailable"); return statusRetry.promise; } return trusted; } if (command === "signed_update_install") return install.promise; throw new Error(`Unexpected IPC ${command}`); });
  const count = (tail: string, method?: string) => requests.filter(item => item.path.endsWith(tail) && (!method || item.method === method)).length;
  const button = (label: string) => { const found = [...dom.container.querySelectorAll<DomButton>("button")].find(item => item.textContent?.trim() === label); assert.ok(found, `Missing ${label}`); return found; };
  const input = (label: string) => { const found = [...dom.container.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent === label)?.querySelector<DomInput>("input"); assert.ok(found, `Missing ${label}`); return found; };
  const type = async (label: string, value: string) => act(async () => { const field = input(label); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const click = async (label: string, twice = false) => act(async () => { const target = button(label); target.click(); if (twice) target.click(); });
  const select = async () => act(async () => { const field = dom.container.querySelector<DomSelect>("select")!; field.value = first.fileName; field.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const selected = () => dom.container.querySelector<DomSelect>("select")!.value;
  try {
    if (scenario === "disabled-empty") files = [];
    const feature = <I18nProvider><FeatureSettingsPanel tab={updates ? "updates" : "sync"}
      onProfilesImported={coordinated ? async () => { importedCallbacks++; if (failRosterRefresh) throw new Error("Fixture roster unavailable"); await rosterRefresh.promise; } : undefined}
      onLocateSnapshotProfile={coordinated ? id => locatedProfiles.push(id) : undefined} /><button>Outside action</button></I18nProvider>;
    await dom.render(coordinated ? <WorkspaceOperationsProvider coordinator={coordinator}>{feature}</WorkspaceOperationsProvider> : feature);
    if (scenario === "announcement-source") {
      assert.ok(dom.container.querySelector(".github-announcements")?.textContent?.includes("In-app installation requires a signed publisher channel."));
      const source = dom.container.querySelector(".signed-update-source")!; assert.equal(source.hasAttribute("open"), false);
      await type("Release repository", "unrelated/announcements"); await click("Save & check for updates", true);
      assert.equal(count("/settings", "PATCH"), 1); assert.equal(count("/updates", "POST"), 1);
      assert.ok(dom.container.querySelector(".update-result")?.textContent?.includes("Announcement only version"));
      assert.ok(dom.container.querySelector(".signed-update-release")?.textContent?.includes("1.0.0 → 2.0.0"));
      await click("Install verified update", true);
      const installs = native.filter(item => item.command === "signed_update_install"); assert.equal(installs.length, 1); assert.equal(installs[0]!.payload.expectedVersion, "2.0.0");
      await act(async () => { install.resolve(); }); assert.ok(dom.container.textContent?.includes("Update installed. Restart requested."));
      return;
    }
    if (scenario === "status-retry") {
      assert.ok(dom.container.querySelector(".signed-update-card .feature-badge")?.textContent?.includes("Status unavailable"));
      await click("Try again", true); assert.equal(statusReads, 2, "Retry acquires a synchronous read lock");
      await act(async () => { statusRetry.resolve(trusted); });
      assert.ok(dom.container.querySelector(".signed-update-release")); assert.equal(dom.container.querySelector(".signed-update-card [role=alert]"), null);
      return;
    }
    assert.ok(dom.container.querySelector(".sync-status-summary")?.textContent?.includes("Snapshots are encrypted locally. Your sync app handles transfers."));
    if (scenario === "disabled-empty") {
      assert.ok(dom.container.textContent?.includes("Snapshots disabled")); assert.equal(count("/sync/files"), 0);
      await act(async () => { dom.container.querySelector<DomInput>('[role="switch"]')!.click(); });
      assert.ok(dom.container.textContent?.includes("Changes not saved")); assert.equal(count("/sync/files"), 0);
      await click("Save settings", true); assert.equal(count("/settings", "PATCH"), 1);
      assert.ok(dom.container.textContent?.includes("Manual snapshots enabled")); assert.ok(dom.container.textContent?.includes("No snapshots yet.")); return;
    }
    await type("Snapshot password", "fixture-password"); await select();
    if (scenario === "create-refresh-failure") {
      await click("Create encrypted snapshot", true); assert.equal(count("/sync/create"), 1);
      assert.ok(dom.container.querySelector(".sync-operation")?.textContent?.includes("Encrypting and saving your snapshot…"));
      assert.ok(button("Save settings").disabled); failFiles = true;
      await act(async () => { create.resolve(json({ ok: true, file: second, profileCount: 3 })); });
      assert.equal(input("Snapshot password").value, ""); assert.equal(selected(), first.fileName);
      assert.ok(dom.container.querySelector(".sync-last-result")?.textContent?.includes("Encrypted snapshot saved · 3 profiles"));
      assert.ok(dom.container.querySelector(".sync-files-error"));
      failFiles = false; files = [second, first]; await click("Retry file list", true);
      assert.equal(count("/sync/create"), 1); assert.equal(count("/sync/files"), 3); assert.equal(selected(), first.fileName); assert.equal(dom.container.querySelector(".sync-files-error"), null);
      assert.ok(dom.container.querySelector(".sync-last-result")); return;
    }
    if (scenario === "failure-keeps-success") {
      await click("Create encrypted snapshot"); await type("Snapshot password", "another-password"); failPreview = true;
      await click("Preview snapshot");
      assert.ok(dom.container.querySelector(".sync-last-result")?.textContent?.includes("Encrypted snapshot saved · 3 profiles"));
      assert.equal(input("Snapshot password").value, "another-password"); assert.equal(selected(), first.fileName); assert.equal(dom.window.document.activeElement, input("Snapshot password")); return;
    }
    if (scenario === "preview-new-focus") {
      await click("Preview snapshot"); button("Outside action").focus();
      await act(async () => { previewResponse.resolve(failed("Fixture preview unavailable")); });
      assert.equal(dom.window.document.activeElement, button("Outside action"), "A late failure must not steal a new focus choice"); assert.equal(input("Snapshot password").value, "fixture-password"); return;
    }
    await click("Preview snapshot", true); assert.equal(previewCalls, 1); assert.ok(dom.container.querySelector(".sync-preview"));
    if (scenario === "all-conflicts") {
      assert.ok(dom.container.querySelector(".sync-preview [role=status]")?.textContent?.includes("There are no new environments in this snapshot."));
      assert.ok(dom.container.querySelector(".sync-preview")?.textContent?.includes("Conflict · skip"));
      const formatHelp = dom.container.querySelector(".sync-restore select")?.getAttribute("aria-describedby");
      assert.ok(formatHelp && dom.window.document.getElementById(formatHelp)?.textContent?.includes("IDs in the list, Trash, or running profiles are skipped."));
      assert.equal([...dom.container.querySelectorAll("button")].some(node => node.textContent?.trim() === "Import new profiles"), false);
      assert.equal(count("/sync/import"), 0);
      return;
    }
    if (scenario === "preview-refresh-preserve") {
      holdFiles = true; await click("Refresh files", true); assert.equal(count("/sync/files"), 2);
      await act(async () => { listing.resolve(failed("Fixture temporary file list failure")); });
      assert.equal(selected(), first.fileName); assert.equal(input("Snapshot password").value, "fixture-password"); assert.ok(dom.container.querySelector(".sync-preview"));
      holdFiles = false; await click("Retry file list", true);
      assert.equal(selected(), first.fileName); assert.ok(dom.container.querySelector(".sync-preview")); assert.equal(previewCalls, 1); assert.equal(count("/sync/files"), 3); return;
    }
    if (scenario === "missing-selected-file") {
      files = [second]; await click("Refresh files");
      assert.equal(selected(), ""); assert.equal(dom.container.querySelector(".sync-preview"), null); assert.equal(input("Snapshot password").value, "fixture-password"); assert.ok(button("Preview snapshot").disabled); return;
    }
    if (coordinated) {
      if (scenario === "import-workspace-gate") {
        let batch!: NonNullable<ReturnType<typeof coordinator.acquire>>;
        await act(async () => { batch = coordinator.acquire("profile-batch")!; });
        assert.ok(button("Import new profiles").disabled); await click("Import new profiles"); assert.equal(count("/sync/import"), 0);
        await act(async () => { coordinator.release(batch); });
      }
      button("Import new profiles").focus(); await click("Import new profiles", true); assert.equal(count("/sync/import"), 1);
      assert.equal(coordinator.acquire("workspace-switch"), null); assert.equal(coordinator.getSnapshot().operation?.kind, "profile-import");
      if (scenario === "import-unmount") {
        await dom.unmount(); assert.equal(coordinator.acquire("workspace-switch"), null, "Unmount cannot release an import whose server response is still pending");
        await act(async () => { importResponse.resolve(json({ ok: true, imported: 1, skipped: 1 })); });
        assert.equal(importedCallbacks, 0, "An unmounted panel must not begin a fresh roster read"); assert.equal(coordinator.getSnapshot().blocked, false); return;
      }
      assert.equal(coordinator.getSnapshot().operation?.phase, "refreshing"); assert.equal(importedCallbacks, 1);
      const receipt = dom.container.querySelector(".sync-import-receipt");
      assert.ok(receipt);
      assert.ok(receipt.textContent?.includes(`${receiptCounts.imported} imported · ${receiptCounts.skipped} skipped`));
      assert.equal(receipt.querySelector("code")?.textContent, first.fileName);
      assert.ok(!receipt.outerHTML.includes("fixture-password") && !receipt.outerHTML.includes("a".repeat(64)));
      if (scenario === "import-receipt-focus-moved") button("Outside action").focus();
      await act(async () => { rosterRefresh.resolve(); workspaceRefresh.resolve(); });
      assert.equal(coordinator.getSnapshot().blocked, false); assert.equal(count("/sync/import"), 1);
      if (scenario === "import-receipt-focus-moved") assert.equal(dom.window.document.activeElement, button("Outside action"));
      else assert.equal(dom.window.document.activeElement, receipt.querySelector("h3"));
      if (scenario === "import-receipt-count-mismatch") {
        assert.equal(receipt.querySelector(".sync-receipt-profiles"), null, "Uncorroborated success counts must not claim exact imported IDs");
        assert.deepEqual(locatedProfiles, []);
        return;
      }
      if (scenario === "import-refresh-failure") {
        assert.ok(receipt.querySelector('[role="alert"]')?.textContent?.includes("Profiles were imported, but the lists could not refresh."));
        assert.equal(button("Locate in list").disabled, true);
        await click("Locate in list"); assert.deepEqual(locatedProfiles, []);
        failRosterRefresh = false;
        await click("Refresh environments", true);
        assert.equal(importedCallbacks, 2, "The next action retries only the roster read and owns a synchronous dedup guard");
        assert.equal(count("/sync/import"), 1);
        assert.equal(receipt.querySelector('[role="alert"]'), null);
      } else assert.equal(dom.container.querySelector('[role="alert"]'), null);
      assert.ok(!receipt.textContent?.includes("Existing environment"));
      if (scenario === "import-receipt-page") {
        assert.equal(receipt.querySelectorAll("li").length, 10);
        await click("Next");
        assert.equal(receipt.querySelectorAll("li").length, 2);
        assert.ok(receipt.textContent?.includes("Page 2 / 2"));
        const finalRow = receipt.querySelector<DomButton>('button[aria-label="Locate New environment 12 in list"]');
        assert.ok(finalRow);
        await act(async () => { finalRow.click(); });
        assert.deepEqual(locatedProfiles, ["new12"]);
      } else {
        assert.equal(button("Locate in list").disabled, false);
        await click("Locate in list"); assert.deepEqual(locatedProfiles, ["new"]);
      }
      return;
    }
    await click("Import new profiles", true); assert.equal(count("/sync/import"), 1); assert.equal(dom.container.querySelector(".sync-preview"), null);
    assert.equal(input("Snapshot password").value, "fixture-password"); assert.equal(selected(), first.fileName); assert.equal(dom.window.document.activeElement, button("Preview snapshot"));
    expired = false; await click("Preview snapshot"); await click("Import new profiles", true);
    assert.equal(count("/sync/import"), 2); assert.equal(input("Snapshot password").value, ""); assert.equal(selected(), first.fileName);
    assert.ok(dom.container.querySelector(".sync-last-result")?.textContent?.includes("1 imported · 1 skipped"));
    const imports = requests.filter(item => item.path.endsWith("/sync/import")); assert.equal(imports[0]!.body.previewHash, "a".repeat(64)); assert.equal(imports[1]!.body.previewHash, "b".repeat(64));
  } finally { create.resolve(json({ ok: true, file: second, profileCount: 3 })); listing.resolve(json({ ok: true, files })); statusRetry.resolve(trusted); install.resolve(); importResponse.resolve(json({ ok: true, imported: 1, skipped: 1 })); rosterRefresh.resolve(); workspaceRefresh.resolve(); previewResponse.resolve(json(preview())); await dom.cleanup(); }
}
await run(process.argv[2] ?? "create-refresh-failure"); console.log("settings portability fixture passed");
