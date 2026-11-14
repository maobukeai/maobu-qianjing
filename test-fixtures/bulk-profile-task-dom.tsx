import assert from "node:assert/strict";
import { act, useState, useSyncExternalStore } from "react";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { createBulkProfileTask } from "../web/bulk-profile-task.ts";
import { BulkProfileTaskPanel } from "../web/bulk-profile-task-panel.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred() {
  let resolve!: (value: unknown) => void;
  return { promise: new Promise<unknown>(yes => { resolve = yes; }), resolve: (value: unknown) => resolve(value) };
}
async function run(scenario: string) {
  const calls: string[] = [], first = deferred(), second = deferred();
  let dismissed = 0;
  const task = createBulkProfileTask({ action: "open", concurrency: 2,
    targets: Array.from({ length: scenario === "active-stop-retry" ? 6 : 120 }, (_, index) => ({ id: `p${index}`, name: `Environment ${index}`, ...(index === 118 ? { skipReason: "Already running" } : {}) })),
    run: id => {
      calls.push(id);
      if (scenario === "active-stop-retry") return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : Promise.resolve({ ok: true });
      return Promise.resolve(id === "p119" ? { ok: false, error: "Synthetic browser action failed" } : { ok: true });
    } });
  const pending = task.start();
  for (let index = 0; index < 5; index++) await Promise.resolve();
  if (scenario !== "active-stop-retry") await pending;
  const dom = await createWebDomHarness();
  function Harness() {
    const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
    const [expanded, setExpanded] = useState(true);
    return <BulkProfileTaskPanel snapshot={snapshot} expanded={expanded} onExpandedChange={setExpanded}
      onStopPending={task.stopPending} onRetryFailed={() => { void task.retryFailed(); }} onDismiss={() => { dismissed++; }} />;
  }
  const button = (label: string) => {
    const node = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(node, `Missing ${label}`); return node;
  };
  const click = (label: string) => act(async () => { button(label).click(); });
  try {
    await dom.render(<I18nProvider><Harness /></I18nProvider>);
    if (scenario === "active-stop-retry") {
      assert.equal(calls.length, 2);
      assert.equal(button("Dismiss batch task").disabled, true);
      await click("Dismiss batch task"); assert.equal(dismissed, 0);
      await click("Collapse task details");
      assert.equal(dom.container.querySelector(".bulk-task-details")?.hasAttribute("hidden"), true);
      assert.ok(dom.container.querySelector("progress"), "Collapsed tasks retain actual progress");
      await click("Show task details");
      await click("Stop queued items");
      assert.equal(dom.window.document.activeElement, button("Collapse task details"), "Stopping must keep keyboard focus in the task panel after its stop control disappears");
      assert.ok(dom.container.querySelector('[role="status"]')?.textContent?.includes("Waiting for 2 requests already sent"));
      assert.equal(button("Dismiss batch task").disabled, true);
      assert.equal(button("Retry 0 failed items").disabled, true);
      await act(async () => { first.resolve({ ok: false, error: "Temporary start failure" }); second.resolve({ ok: true }); await pending; });
      assert.equal(calls.length, 2);
      assert.equal(button("Dismiss batch task").disabled, false);
      await click("Failed items");
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 1);
      assert.ok(dom.container.querySelector(".bulk-task-row")?.textContent?.includes("Temporary start failure"));
      assert.ok(dom.container.querySelector(".bulk-task-row")?.textContent?.includes("Attempt 1"));
      await click("Retry 1 failed items"); await dom.flush();
      assert.deepEqual(calls, ["p0", "p1", "p0"]);
      assert.equal(task.getSnapshot().summary.skipped, 4);
      assert.equal(task.getSnapshot().rows[0]!.attempts, 2);
      assert.equal(button("Retry 0 failed items").disabled, true);
      await click("Dismiss batch task"); assert.equal(dismissed, 1);
    } else {
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 50);
      await click("Failed items");
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 1);
      assert.ok(dom.container.querySelector(".bulk-task-row")?.textContent?.includes("Environment 119"));
      await click("Skipped items");
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 1);
      assert.ok(dom.container.querySelector(".bulk-task-row")?.textContent?.includes("Already running"));
      await click("All task items"); await click("Next");
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 50);
      const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Environment 119");
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(dom.container.querySelectorAll(".bulk-task-row").length, 1);
      assert.ok(dom.container.querySelector(".bulk-task-row")?.textContent?.includes("Environment 119"));
      assert.equal(calls.length, 119, "Filtering task results must not dispatch more actions");
    }
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "active-stop-retry"); console.log("bulk profile task panel fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
