import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";
import type { ProfilePackagePreview } from "../web/profile-package-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

const id = "fixture_existing";
const otherId = "fixture_new";
const preview = (version: number): ProfilePackagePreview => ({
  previewId: `pkg_${String(version).repeat(32)}`,
  previewToken: String(version).repeat(64),
  expiresAt: Date.now() + 60000,
  sha256: "a".repeat(64),
  appVersion: "fixture",
  exportedAt: Date.now(),
  includeSecrets: false,
  includeSessions: false,
  profileCount: 2,
  sessionCount: 0,
  newCount: 1,
  conflictCount: 1,
  runningConflictCount: 0,
  trashedConflictCount: 0,
  profiles: [
    { id, name: `Reviewed environment ${version}`, group: "", engine: "chromium", platform: "", tags: [], hasProxy: false, proxyDisplay: null,
      hasSession: false, hasNotes: false, conflict: true, conflictReason: "existing_active" },
    { id: otherId, name: "Unselected environment", group: "", engine: "chromium", platform: "", tags: [], hasProxy: false, proxyDisplay: null,
      hasSession: false, hasNotes: false, conflict: false, conflictReason: null },
  ],
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const previews: ReturnType<typeof pending<Response>>[] = [];
const commits: ReturnType<typeof pending<Response>>[] = [];
const submittedNames: string[] = [];
const submittedPasswords: FormDataEntryValue[] = [];
const submittedPayloads: unknown[] = [];
const fetchFixture = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
  if (url === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
  if (url === "/ui/api/profiles/package/preview") {
    assert.equal(init?.method, "POST");
    const form = init?.body;
    assert.ok(form instanceof FormData);
    const file = form.get("file");
    const password = form.get("password");
    assert.ok(file instanceof File && password !== null);
    submittedNames.push(file.name);
    submittedPasswords.push(password);
    const request = pending<Response>();
    previews.push(request);
    return request.promise;
  }
  if (url === "/ui/api/profiles/package/import") {
    assert.equal(init?.method, "POST");
    submittedPayloads.push(JSON.parse(String(init?.body)));
    const request = pending<Response>();
    commits.push(request);
    return request.promise;
  }
  throw new Error(`Unexpected package fixture request: ${String(url)}`);
}, { preconnect: globalThis.fetch.preconnect });

const h = await createWebDomHarness({ fetch: fetchFixture });

try {
  const [{ I18nProvider }, { ProfilePackageImportModal }] = await Promise.all([
    import("../web/i18n.tsx"),
    import("../web/profile-package-modals.tsx"),
  ]);
  const file = new File(["synthetic preview fixture"], "first.mqprofile");
  const passwordValue = "fixture-password";
  const button = (name: string) => {
    const item = [...h.container.querySelectorAll("button")].find((node) => node.textContent.trim() === name);
    assert.ok(item, `Missing button: ${name}`);
    return item as HTMLButtonElement;
  };
  const select = (selector: string) => {
    const field = h.container.querySelector<HTMLInputElement>(selector);
    assert.ok(field, `Missing field: ${selector}`);
    return field;
  };
  const selectedFile = () => h.container.querySelector(".pkg-selected-file strong")?.textContent;
  const closeStates: string[] = [];
  const receipts: number[] = [];
  await h.render(<I18nProvider><ProfilePackageImportModal open initialFile={file}
    onClose={() => closeStates.push("closed")} onImported={(result) => receipts.push(result.overwrittenCount)} /></I18nProvider>);
  await h.flush();
  await act(async () => {
    const password = select("#pkg-import-password");
    Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype, "value")!.set!.call(password, passwordValue);
    password.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  });

  const decrypt = button("Decrypt & preview");
  if (process.argv[2] === "busy-source") {
    await act(async () => { decrypt.click(); });
    assert.equal(previews.length, 1);
    await act(async () => {
      const zone = h.container.querySelector(".pkg-dropzone")!;
      const drop = new h.window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["synthetic"], "second.mqprofile")] } });
      zone.dispatchEvent(drop);
      select("#pkg-import-password").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(selectedFile(), file.name, "a decrypting preview owns its original file");
    assert.deepEqual(closeStates, []);
    await act(async () => previews[0]!.resolve(Response.json({ ok: true, preview: preview(1) })));
    assert.match(h.container.textContent, /Reviewed environment 1/);
    assert.equal(h.window.document.activeElement?.id, "pkg-review-heading", "A ready preview focuses the review heading");
    await act(async () => { button("Back").click(); });
    assert.equal(selectedFile(), file.name);
    assert.equal(select("#pkg-import-password").value, passwordValue);
    assert.equal(h.window.document.activeElement, select("#pkg-import-password"), "Returning from review restores password focus");
    assert.deepEqual(submittedNames, [file.name]);
    assert.equal(commits.length, 0);
  } else if (process.argv[2] === "expired-review") {
    await act(async () => { decrypt.click(); decrypt.click(); });
    assert.equal(previews.length, 1, "one decrypt request per pending preview");
    await act(async () => previews[0]!.resolve(Response.json({ ok: true, preview: preview(1) })));
    await act(async () => { select('[aria-label="Select Unselected environment"]').click(); });
    assert.equal(select('[aria-label="Select all package environments"]').indeterminate, true, "Partial selection has a mixed state");
    await act(async () => { select('[value="overwrite_closed"]').click(); });
    await act(async () => { select(".pkg-overwrite-confirm input").click(); });
    const commit = button("Import 1 environments");
    await act(async () => { commit.click(); commit.click(); });
    assert.equal(commits.length, 1, "one commit request per reviewed operation");
    await act(async () => commits[0]!.resolve(Response.json({
      ok: false, code: "invalid_preview", error: "Package preview token is invalid or expired. Decrypt the package again.",
    }, { status: 409 })));
    assert.match(h.container.textContent, /This package preview is no longer available/);
    assert.equal(h.window.document.activeElement, button("Decrypt & preview"), "An expired review focuses its retry action");
    assert.ok(![...h.container.querySelectorAll("button")].some((node) => node.textContent.trim().startsWith("Import 1")));
    await act(async () => { button("Decrypt & preview").click(); });
    assert.equal(previews.length, 2);
    assert.equal(commits.length, 1);
    await act(async () => previews[1]!.resolve(Response.json({ ok: true, preview: preview(2) })));
    assert.match(h.container.textContent, /Reviewed environment 2/);
    assert.equal(select('[aria-label="Select Unselected environment"]').checked, false);
    assert.equal(select('[value="overwrite_closed"]').checked, true);
    assert.equal(select(".pkg-overwrite-confirm input").checked, false);
    assert.equal(button("Import 1 environments").disabled, true);
    await act(async () => { select(".pkg-overwrite-confirm input").click(); });
    await act(async () => { button("Import 1 environments").click(); });
    assert.equal(commits.length, 2);
    assert.deepEqual(submittedPayloads, [preview(1), preview(2)].map((item) => ({
      previewId: item.previewId,
      previewToken: item.previewToken,
      strategy: "overwrite_closed",
      selectedIds: [id],
      confirmOverwrite: true,
    })));
    await act(async () => commits[1]!.resolve(Response.json({
      ok: true, result: { strategy: "overwrite_closed", importedCount: 0, clonedCount: 0, overwrittenCount: 1, skippedCount: 1, items: [] },
    })));
    assert.deepEqual(receipts, [1]);
    assert.deepEqual(submittedNames, [file.name, file.name]);
    assert.deepEqual(submittedPasswords, [passwordValue, passwordValue]);
    assert.equal(button("Done").disabled, false);
    assert.equal(h.window.document.activeElement?.id, "pkg-receipt-heading", "Completing import focuses its result");
  } else {
    throw new Error("Expected a known app package import fixture scenario");
  }
  console.log("profile package import fixture passed");
} finally {
  await h.cleanup();
}
