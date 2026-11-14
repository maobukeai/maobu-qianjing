import assert from "node:assert/strict";
import { act, useState, useSyncExternalStore } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLDetailsElement, HTMLInputElement } from "happy-dom";
import { createProfileFileUpdate } from "../web/profile-file-update.ts";
import { ProfileFileUpdateDialog, ProfileFileUpdatePanel } from "../web/profile-file-update-panel.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const response = deferred<Response>(), following = deferred<Response>(), uploads: File[] = [], exports: string[] = []; let templates = 0;
  const task = createProfileFileUpdate({ post: async file => { uploads.push(file); return uploads.length === 1 ? response.promise : following.promise; } });
  const dom = await createWebDomHarness(), body = dom.window.document.body;
  dom.window.localStorage.setItem("aliasmode.shell.motion", "full");
  function Harness() {
    const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot), [open, setOpen] = useState(false), [other, setOther] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open file update</button><button type="button" onClick={() => setOther(true)}>Open other dialog</button><ProfileFileUpdateDialog open={open} task={task} onClose={() => setOpen(false)} selectedCount={3} onExport={format => { exports.push(format); }} onDownloadTemplate={() => { templates++; }} />{!open && <ProfileFileUpdatePanel snapshot={snapshot} defaultExpanded onChooseFile={() => setOpen(true)} onDismiss={task.dismissResults} />}{other && <div role="dialog" aria-modal="true" aria-label="Other dialog"><input autoFocus id="other-field" /><button type="button" onClick={() => setOther(false)}>Close other dialog</button></div>}</>;
  }
  const button = (text: string, scope: HTMLElement = body) => { const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[hidden], [inert], [aria-hidden="true"]') && (node.textContent?.trim() === text || node.getAttribute("aria-label") === text)); assert.ok(found, `Missing ${text}`); return found; };
  const click = (text: string, scope: HTMLElement = body) => act(async () => { button(text, scope).click(); });
  const file = () => new File(["id,name,password\nfile_one,Updated,PRIVATE_ACCOUNT_PAYLOAD"], "C:\\PRIVATE_PATH\\PRIVATE_ACCOUNT_EXPORT.csv");
  const choose = async () => act(async () => { const field = body.querySelector<HTMLInputElement>('.profile-file-update-dialog input[type="file"]')!; Object.defineProperty(field, "files", { configurable: true, value: [file()] }); field.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  try {
    await dom.render(<I18nProvider><Harness /></I18nProvider>);
    if (scenario === "focus-and-selection") {
      button("Open file update").focus(); await click("Open file update"); await choose(); assert.equal(button("Update profiles").disabled, false); assert.equal(body.textContent?.includes("PRIVATE"), false);
      await click("CSV"); await click("Download example sheet"); assert.deepEqual(exports, ["csv"]); assert.equal(templates, 1);
      const revision = task.getSnapshot().input?.revision;
      await click("Close"); assert.ok(body.querySelector('.desktop-motion-presence[aria-hidden="true"]')?.hasAttribute("inert"));
      await click("Open other dialog"); const other = body.querySelector("#other-field"); assert.equal(dom.window.document.activeElement, other);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); }); assert.equal(dom.window.document.activeElement, other, "Exit cleanup cannot steal a new modal's focus");
      await click("Close other dialog"); await click("Open file update"); assert.equal(task.getSnapshot().input?.revision, revision); assert.ok(body.querySelector('.profile-file-update-selection')); assert.equal(button("Update profiles").disabled, false, "Closing and reopening retains the unsubmitted private selection");
      await act(async () => { button("Update profiles").click(); button("Update profiles").click(); }); await dom.flush(); assert.equal(uploads.length, 1);
      await click("Hide window · update continues"); assert.equal(task.isBusy(), true); assert.equal(button("Dismiss file update results").disabled, true);
      await act(async () => { response.resolve(Response.json({ ok: true, updated: 1, skipped: 0, notFound: [], errors: [] })); }); await dom.flush();
      await click("Choose corrected or different file"); assert.equal(button("Update profiles").disabled, true); assert.equal(task.getSnapshot().input?.revision, revision);
    } else if (scenario === "file-format-rejection") {
      let request!: ReturnType<typeof task.submit>; await act(async () => { task.selectFile(file()); request = task.submit(); }); await dom.flush();
      await act(async () => { response.resolve(Response.json({ ok: false, updated: 0, skipped: 0, notFound: [], errors: [{ id: "", error: "update file could not be parsed" }] }, { status: 400 })); await request; });
      const receipt = body.querySelector('.profile-file-update-receipt')!; assert.ok(receipt.textContent?.includes("File input")); assert.ok(receipt.textContent?.includes("Validation items reported"));
      assert.ok(receipt.textContent?.includes("No environment was saved")); assert.equal(receipt.textContent?.includes("Identifier withheld"), false); assert.equal(receipt.textContent?.includes("Reported item"), false); assert.equal(body.textContent?.includes("PRIVATE"), false);
    } else {
      let first!: ReturnType<typeof task.submit>; await act(async () => { task.selectFile(file()); first = task.submit(); }); await dom.flush();
      await act(async () => { response.resolve(Response.json({ ok: false, updated: 0, skipped: 0, notFound: [], errors: Array.from({ length: 105 }, (_, index) => ({ id: index === 104 ? "../PRIVATE_INVALID_ID" : `file_${index}`, error: "PRIVATE_BACKEND_LINE_AND_CREDENTIAL" })) }, { status: 400 })); await first; });
      let current = body.querySelector('.profile-file-update-receipt')!; const issues = current.querySelector<HTMLDetailsElement>('.profile-file-update-items')!;
      await act(async () => { issues.querySelector("summary")!.click(); }); assert.equal(issues.querySelectorAll("li").length, 50); await click("Next", issues); assert.equal(issues.querySelectorAll("li").length, 50); await click("Next", issues); assert.equal(issues.querySelectorAll("li").length, 5); assert.ok(issues.textContent?.includes("Identifier withheld"));
      assert.equal(body.textContent?.includes("PRIVATE"), false); assert.equal(body.textContent?.includes("Retry failed"), false);
      let second!: ReturnType<typeof task.submit>; await act(async () => { task.selectFile(file()); second = task.submit(); }); await dom.flush();
      await act(async () => { following.resolve(Response.json({ ok: true, updated: 1, skipped: 2, notFound: Array.from({ length: 120 }, (_, index) => `missing_${index}`), errors: [] })); await second; });
      current = body.querySelector('.profile-file-update-receipt')!; const missing = current.querySelector<HTMLDetailsElement>('.profile-file-update-items')!;
      await act(async () => { missing.querySelector("summary")!.click(); }); assert.equal(missing.querySelectorAll("li").length, 50); await click("Next", missing); assert.equal(missing.querySelectorAll("li").length, 50); await click("Next", missing); assert.equal(missing.querySelectorAll("li").length, 20);
      assert.equal(task.getSnapshot().receipts.length, 2); assert.ok(body.textContent?.includes("Earlier file update results (1)")); assert.equal(body.textContent?.includes("PRIVATE"), false); assert.equal(uploads.length, 2);
    }
  } finally { response.resolve(Response.json({ ok: false, error: "Fixture teardown" }, { status: 500 })); following.resolve(Response.json({ ok: false, error: "Fixture teardown" }, { status: 500 })); await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "focus-and-selection"); console.log("profile file update DOM fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
