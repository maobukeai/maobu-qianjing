import assert from "node:assert/strict";
import { act, useState, useSyncExternalStore } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import { createCookieImportTask, postCookieImport } from "../web/cookie-import-task.ts";
import { CookieImportTaskDialog, CookieImportTaskPanel } from "../web/cookie-import-task-panel.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
async function run(scenario: string) {
  const first = deferred<Response>(), second = deferred<Response>(), calls: Array<{ ids: string[]; input: Record<string, string> }> = [];
  const task = createCookieImportTask({ post: async (ids, input) => { calls.push({ ids: [...ids], input: { ...input } }); return calls.length === 1 ? first.promise : second.promise; } });
  const dom = await createWebDomHarness();
  const surface = dom.window.document.body;
  dom.window.localStorage.setItem("aliasmode.shell.motion", "full");
  function Harness() {
    const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot), [open, setOpen] = useState(scenario !== "paging-and-unknown"), [other, setOther] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open import</button><button type="button" onClick={() => setOther(true)}>Open other dialog</button><CookieImportTaskDialog open={open} task={task} targets={[{ id: "one", name: "First" }, { id: "two", name: "Second" }]} onClose={() => setOpen(false)} />{!open && <CookieImportTaskPanel snapshot={snapshot} defaultExpanded onRetryFailed={() => { void task.retryFailed(); }} onDismiss={task.dismiss} />}{other && <div role="dialog" aria-modal="true" aria-label="Other dialog"><input autoFocus id="other-field" /><button type="button" onClick={() => setOther(false)}>Close other dialog</button></div>}</>;
  }
  const button = (label: string) => {
    const node = [...surface.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[hidden], [inert], [aria-hidden="true"]') && (item.textContent?.trim() === label || item.getAttribute("aria-label") === label));
    assert.ok(node, `Missing button ${label}`); return node;
  };
  const click = (label: string) => act(async () => { button(label).click(); });
  try {
    await dom.render(<I18nProvider><Harness /></I18nProvider>);
    if (scenario === "hide-and-retry" || scenario === "close-focus-session") {
      const textarea = surface.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, '[{"name":"auth","value":"COOKIE_PRIVATE_729","domain":"example.com","path":"/"}]');
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      if (scenario === "close-focus-session") {
        await click("Close");
        const exiting = surface.querySelector('.desktop-motion-presence[aria-hidden="true"]'); assert.ok(exiting?.hasAttribute("inert"), "Retained exit content is inert immediately");
        await click("Open other dialog"); const other = surface.querySelector<HTMLInputElement>("#other-field")!;
        assert.equal(dom.window.document.activeElement, other, "Closing releases the focus trap before the exit animation finishes");
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); }); assert.equal(dom.window.document.activeElement, other, "The old visual exit cannot reclaim focus");
        await click("Close other dialog"); await click("Open import");
        assert.equal(surface.querySelector<HTMLTextAreaElement>("textarea")?.value, "", "Each reopening has an isolated blank private draft");
        await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        await click("Open other dialog"); assert.equal(dom.window.document.activeElement, surface.querySelector("#other-field")); return;
      }
      await click("Import cookies"); assert.equal(calls.length, 1); assert.equal(surface.querySelector("textarea"), null, "Submitted private fields are removed from the DOM");
      assert.equal(surface.textContent?.includes("COOKIE_PRIVATE_729"), false);
      await click("Hide window · import continues"); assert.equal([...surface.querySelectorAll('[role="dialog"]')].filter(item => !item.closest('[inert], [aria-hidden="true"]')).length, 0); assert.equal(task.isBusy(), true);
      assert.equal(button("Dismiss cookie import result").disabled, true);
      await click("Open import"); assert.equal(surface.querySelector("textarea"), null, "Reopening a running import shows its frozen result instead of a new editable draft"); await click("Hide window · import continues");
      await act(async () => { first.resolve(Response.json({ ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "two", error: "COOKIE_PRIVATE_729" }] })); }); await dom.flush();
      assert.equal(task.getSnapshot().summary.succeeded, 1); assert.ok(surface.textContent?.includes("Second"));
      const retry = button("Retry 1 failed environments"); retry.focus(); await click("Retry 1 failed environments"); assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(call => call.ids), [["one", "two"], ["two"]]); assert.deepEqual(calls[1]?.input, calls[0]?.input);
      await act(async () => { second.resolve(Response.json({ ok: true, count: 1, live: 0, nextStart: 1, errors: [] })); }); await dom.flush();
      assert.equal(task.getSnapshot().summary.succeeded, 2); assert.equal(dom.window.document.activeElement, button("Hide cookie import details"));
      assert.equal(surface.textContent?.includes("COOKIE_PRIVATE_729"), false); await click("Dismiss cookie import result"); assert.equal(task.getSnapshot().phase, "idle");
    } else {
      const targets = Array.from({ length: 120 }, (_, index) => ({ id: `profile_${index}`, name: `Environment ${index}` }));
      let work!: ReturnType<typeof task.submit>;
      await act(async () => { work = task.submit(targets, { format: "netscape", input: { text: "example.com\tFALSE\t/\tTRUE\t0\tsession\tCOOKIE_PRIVATE_729" } }); });
      await act(async () => { first.resolve(Response.json({ ok: false, count: 1, live: 10, nextStart: 109, errors: [{ id: "profile_119", error: "COOKIE_PRIVATE_729" }] })); await work; });
      assert.equal(surface.querySelectorAll(".cookie-import-row").length, 50); await click("Next"); assert.equal(surface.querySelectorAll(".cookie-import-row").length, 50);
      await click("Needs review"); assert.equal(surface.querySelectorAll(".cookie-import-row").length, 1); assert.ok(surface.textContent?.includes("Environment 119"));
      await click("Retry 1 failed environments"); await act(async () => { second.resolve(new Response("COOKIE_PRIVATE_729", { status: 500 })); }); await dom.flush();
      assert.equal(task.getSnapshot().summary.unconfirmed, 1); assert.equal(task.getSnapshot().summary.succeeded, 119);
      assert.ok(surface.textContent?.includes("This request will not be sent again automatically."));
      assert.equal(surface.textContent?.includes("COOKIE_PRIVATE_729"), false); assert.equal(surface.textContent?.includes("Retry 1 failed environments"), false);
      await click("Hide cookie import details"); await click("View cookie import details"); assert.equal(calls.length, 2, "Viewing results never resends uncertain writes");
    }
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "hide-and-retry"); console.log("cookie import task DOM fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
