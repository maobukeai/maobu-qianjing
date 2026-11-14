import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement as DomButton, HTMLInputElement as DomInput, HTMLSelectElement as DomSelect } from "happy-dom";
import { createDesktopCloseRegistry, DesktopCloseRegistryProvider } from "../web/desktop-close.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { FeatureSettingsPanel } from "../web/settings-center.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function run(scenario: string) {
  const snapshot = (digit: string) => ({ fileName: `maobu-sync-170000000000${digit}-${digit.repeat(16)}.mqsync`, createdAt: 1700000000000 + Number(digit), modifiedAt: 1700000000000 + Number(digit), bytes: 1024 });
  const first = snapshot("1"), second = snapshot("2");
  const registry = createDesktopCloseRegistry();
  const previewGate = deferred<Response>();
  let files = [first, second], active = true, failList = false, deferPreview = false;
  const previewRequests: { fileName: string; password: string }[] = [];
  const imports: { fileName: string; password: string; previewHash: string }[] = [];
  const response = (file: typeof first) => Response.json({ ok: true, previewHash: (file.fileName === first.fileName ? "a" : "b").repeat(64), preview: { profileCount: 1, sessionCount: 0, newCount: 1, conflictCount: 0, profiles: [{ id: "p", name: file.fileName === first.fileName ? "First environment" : "Second environment", group: "", conflict: false, hasSession: false }] } });
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/settings") return Response.json({ ok: true, settings: { version: 1, updates: { repository: "fixture/announcements", channel: "stable", checkOnStartup: false }, sync: { enabled: true, folder: "/inert-fixture", retainSnapshots: 10 } } });
    if (path === "/ui/api/settings/sync/files") return failList ? Response.json({ ok: false, error: "Fixture file listing failed" }, { status: 503 }) : Response.json({ ok: true, files });
    if (path === "/ui/api/settings/sync/preview") {
      const request = JSON.parse(String(options?.body));
      previewRequests.push(request);
      return deferPreview ? previewGate.promise : response(request.fileName === first.fileName ? first : second);
    }
    if (path === "/ui/api/settings/sync/import") {
      imports.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true, imported: 1, skipped: 0 });
    }
    throw new Error(`Unexpected request ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch });
  const render = () => dom.render(<I18nProvider><DesktopCloseRegistryProvider registry={registry}>
    <FeatureSettingsPanel tab={active ? "sync" : null} /><button type="button">Outside action</button>
  </DesktopCloseRegistryProvider></I18nProvider>);
  const button = (label: string) => {
    const found = [...dom.container.querySelectorAll<DomButton>("button")].find(node => node.textContent?.trim() === label);
    assert.ok(found, `Missing ${label}`); return found;
  };
  const input = (label: string) => {
    const found = [...dom.container.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)?.querySelector<DomInput>("input");
    assert.ok(found, `Missing ${label}`); return found;
  };
  const type = (label: string, value: string) => {
    const field = input(label);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const select = (value: string) => {
    const field = dom.container.querySelector<DomSelect>(".sync-restore select")!;
    field.value = value; field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const review = () => dom.container.querySelector(".sync-preview");
  const click = (label: string) => act(async () => { button(label).click(); });
  const dirty = () => registry.getSnapshot().dirty.includes("sync-settings");
  try {
    await render(); await dom.flush();
    assert.equal(dirty(), false);
    await act(async () => { type("Snapshot password", "fixture-password"); select(first.fileName); });
    if (scenario === "exact-review") {
      await click("Preview snapshot");
      const previousImport = button("Import new profiles");
      await act(async () => { select(second.fileName); previousImport.click(); });
      assert.deepEqual(imports, [], "A replaced file cannot use an old review even within the same event turn");
      assert.ok(!review());
      await click("Preview snapshot");
      assert.match(review()?.textContent ?? "", new RegExp(second.fileName));
      assert.match(review()?.textContent ?? "", /Second environment/);
      await act(async () => { const oldImport = button("Import new profiles"); type("Snapshot password", "new-fixture-password"); oldImport.click(); });
      assert.deepEqual(imports, [], "Editing the password invalidates the review before any rerender");
      assert.ok(!review());
      await click("Preview snapshot");
      await click("Import new profiles");
      assert.deepEqual(imports, [{ fileName: second.fileName, password: "new-fixture-password", previewHash: "b".repeat(64) }]);
      assert.equal(dirty(), false);
    } else if (scenario === "list-recovery") {
      await click("Preview snapshot");
      failList = true; await click("Refresh files");
      assert.ok(review(), "A read failure retains the review evidence");
      assert.equal(button("Import new profiles").disabled, true);
      assert.equal(button("Preview snapshot").disabled, true);
      assert.equal(input("Snapshot password").value, "fixture-password");
      await click("Import new profiles");
      assert.deepEqual(imports, []);
      failList = false; await click("Retry file list");
      assert.ok(review()); assert.equal(button("Import new profiles").disabled, false);
      assert.equal(previewRequests.length, 1);
      files = [{ ...first, modifiedAt: first.modifiedAt + 100, bytes: first.bytes + 20 }, second];
      await click("Refresh files");
      assert.ok(!review(), "New metadata for the selected file invalidates the reviewed hash");
      assert.equal(dom.container.querySelector<DomSelect>(".sync-restore select")?.value, first.fileName);
      assert.equal(dirty(), true);
    } else if (scenario === "stale-response") {
      deferPreview = true;
      const trigger = button("Preview snapshot");
      await act(async () => { trigger.focus(); trigger.click(); select(second.fileName); });
      assert.deepEqual(previewRequests, [{ fileName: first.fileName, password: "fixture-password" }]);
      await act(async () => { previewGate.resolve(response(first)); });
      assert.ok(!review(), "An in-flight preview cannot reopen review after the file changes");
      assert.deepEqual(imports, []);
      deferPreview = false;
      await click("Preview snapshot");
      assert.match(review()?.textContent ?? "", /Second environment/);
    } else {
      assert.equal(dirty(), true, "An unsent password is a close draft");
      assert.deepEqual(registry.getSnapshot().dirty, ["sync-settings"]);
      assert.doesNotMatch(JSON.stringify(registry.getSnapshot()), /fixture-password/);
      assert.match(dom.container.querySelector(".sync-status-summary")?.textContent ?? "", /Manual snapshots enabled/);
      const trigger = button("Preview snapshot"); trigger.focus();
      await click("Preview snapshot");
      const heading = review()?.querySelector("h4");
      assert.ok(heading);
      assert.ok(dom.window.document.activeElement === heading, "Explicit preview focuses its review heading");
      deferPreview = true;
      await click("Preview snapshot");
      active = false; await render();
      assert.equal(dirty(), true);
      button("Outside action").focus();
      await act(async () => { previewGate.resolve(response(first)); });
      assert.ok(dom.window.document.activeElement === button("Outside action"));
      active = true; await render();
      assert.ok(dom.window.document.activeElement === button("Outside action"));
      assert.equal(input("Snapshot password").value, "fixture-password");
      await act(async () => { type("Snapshot password", ""); });
      assert.equal(dirty(), false);
    }
  } finally {
    previewGate.resolve(response(first));
    await dom.cleanup();
  }
}

try { await run(process.argv[2] ?? "exact-review"); console.log("sync preview review fixture passed"); }
catch (error) { console.error(error); process.exitCode = 1; }
