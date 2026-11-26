import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLProgressElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { WorkbenchActivity, type WorkbenchActivityItem } from "../web/workbench-activity.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const requests: string[] = [], calls: string[] = [];
  const fakeFetch = Object.assign(async (input: RequestInfo | URL) => { requests.push(String(input)); assert.equal(input, "/ui/api/shell-language", "The activity view must never poll or mutate a task"); return Response.json({ ok: true, language: "en-US" }); }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  dom.window.document.documentElement.dataset.desktopMotion = "full";
  let systemReduced = scenario === "reduced", available = true;
  const mediaListeners = new Set<() => void>(), realMedia = dom.window.matchMedia.bind(dom.window);
  const media = { get matches() { return systemReduced; }, media: "(prefers-reduced-motion: reduce)", addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener), removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener) };
  dom.window.matchMedia = ((query: string) => query === "(prefers-reduced-motion: reduce)" ? media : realMedia(query)) as typeof dom.window.matchMedia;
  const style = dom.window.document.createElement("style"); style.textContent = await Bun.file(new URL("../web/workbench-activity.css", import.meta.url)).text(); dom.window.document.head.append(style);
  const width = scenario.startsWith("width-") ? Number(scenario.slice(6)) : 1440;
  dom.window.happyDOM.setWindowSize({ width, height: 800 });
  const rectangle = { top: 14, bottom: 46, left: Math.max(0, width - 100), right: Math.max(0, width - 20), width: 80, height: 32, x: Math.max(0, width - 100), y: 14, toJSON() {} };
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value() { return rectangle; } });
  const task = (id: string, state: WorkbenchActivityItem["state"], title: string): WorkbenchActivityItem => ({ id, state, title, description: `${title} detail`, onView: () => { calls.push(id); after().focus(); } });
  let items: WorkbenchActivityItem[] = [task("done", "complete", "Saved import receipt"), task("attention", "attention", "Some browsers need review"), { ...task("running", "running", "Starting browsers"), progress: { done: 2, total: 8 } }, task("running-2", "running", "Background script"), task("done-2", "complete", "Cookie import finished")];
  if (scenario === "empty") items = [];
  if (scenario === "single-task") items = [task("download", "running", "Browser downloads")];
  const render = () => dom.render(<I18nProvider><button type="button" data-before>Before activity</button>{available && <WorkbenchActivity items={items} />}<button type="button" data-after>After activity</button></I18nProvider>);
  const trigger = () => dom.container.querySelector<HTMLButtonElement>(".workbench-activity-trigger")!;
  const panel = () => [...dom.window.document.querySelectorAll<HTMLElement>(".workbench-activity-popover")].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const host = () => dom.window.document.querySelector<HTMLElement>(".desktop-motion-presence");
  const views = () => [...(panel()?.querySelectorAll<HTMLButtonElement>("[data-activity-view]") ?? [])];
  const view = (id: string) => { const node = views().find(button => button.dataset.activityView === id); assert.ok(node, id); return node; };
  const before = () => dom.container.querySelector<HTMLButtonElement>("[data-before]")!, after = () => dom.container.querySelector<HTMLButtonElement>("[data-after]")!;
  const click = async (button: HTMLButtonElement) => act(async () => { button.focus(); button.click(); });
  const key = async (target: HTMLElement, value: string) => { const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }); await act(async () => { target.dispatchEvent(event); }); return event; };
  const close = async () => { const node = panel()?.querySelector<HTMLButtonElement>('button[aria-label="Close activity"]'); assert.ok(node); await click(node); };
  const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
  try {
    await render(); await dom.flush(); const initialRequests = [...requests];
    if (scenario === "empty") {
      assert.equal(trigger(), null); assert.equal(panel(), null); assert.equal(host(), null);
      assert.equal(dom.container.querySelectorAll("button").length, 2); assert.deepEqual(calls, []);
    } else if (scenario === "single-task") {
      await click(trigger());
      assert.equal(panel()?.getAttribute("aria-describedby"), null);
      assert.equal(panel()?.querySelector(".workbench-activity-summary"), null, "One task has its own status without an extra summary");
      assert.equal(panel()?.querySelector(".workbench-activity-state")?.textContent, "Running");
      assert.equal(view("download").getAttribute("aria-label"), "View Browser downloads");
      assert.equal(view("download").textContent, "", "Each arrow has a specific accessible name without repeated visible copy");
      assert.equal(panel()?.querySelector("progress"), null, "Unknown totals must not become a determinate progress bar");
      items = [{ ...items[0]!, progress: { done: 5, total: 0 } }]; await render();
      assert.equal(panel()?.querySelector("progress"), null, "Zero is not a usable total");
      assert.equal(dom.window.document.activeElement, view("download"));
    } else if (scenario === "sort-count-progress") {
      assert.equal(trigger().getAttribute("aria-label"), "Background activity, 5 tasks"); assert.equal(trigger().querySelector(".workbench-activity-count")?.textContent, "5"); assert.ok(trigger().querySelector(".workbench-activity-running"));
      await click(trigger()); assert.deepEqual(views().map(node => node.dataset.activityView), ["running", "running-2", "attention", "done", "done-2"]);
      assert.equal(dom.window.document.activeElement, view("running")); assert.deepEqual(items.map(item => item.id), ["done", "attention", "running", "running-2", "done-2"], "Sorting must not mutate the owner's items");
      const summary = panel()!.querySelector(".workbench-activity-summary")!.textContent; assert.ok(summary.includes("2 running")); assert.ok(summary.includes("1 need attention")); assert.ok(summary.includes("2 complete"));
      const progress = panel()!.querySelector<HTMLProgressElement>("progress")!; assert.equal(progress.max, 8); assert.equal(progress.value, 2); assert.equal(progress.getAttribute("aria-label"), "Progress for Starting browsers"); assert.ok(panel()!.textContent.includes("2 of 8"));
      items = items.map(item => item.id === "running" ? { ...item, progress: { done: 6, total: 8 } } : item); await render(); assert.equal(panel()!.querySelector<HTMLProgressElement>("progress")!.value, 6);
      const focused = view("running");
      items = items.map(item => item.id === "running" ? { ...item, state: "complete", progress: { done: 8, total: 8 } } : item); await render();
      assert.equal(dom.window.document.activeElement, focused, "A task moving to a completed group must keep its focused View button"); assert.equal(view("running"), focused);
      assert.ok(panel()!.querySelector(".workbench-activity-summary")!.textContent.includes("3 complete"));
      await pause(); assert.equal(trigger().querySelector(".workbench-activity-count")!.textContent, "5", "Completed tasks remain owned by the supplied data"); assert.deepEqual(calls, []);
    } else if (scenario === "view-focus-exit") {
      await click(trigger()); const old = view("running"); await act(async () => { old.click(); old.click(); });
      assert.deepEqual(calls, ["running"]); assert.equal(dom.window.document.activeElement, after(), "Opening a destination must be allowed to take focus after the popover closes");
      assert.equal(panel(), null); assert.equal(host()?.dataset.motionPhase, "exiting"); assert.ok(host()?.hasAttribute("inert"));
      await act(async () => { old.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); }); assert.deepEqual(calls, ["running"]);
      assert.equal((await key(after(), "Tab")).defaultPrevented, false); await pause(); assert.equal(host(), null);
      assert.equal(trigger().querySelector(".workbench-activity-count")!.textContent, "5");
    } else if (scenario === "keyboard") {
      trigger().focus(); await key(trigger(), "ArrowDown"); assert.equal(dom.window.document.activeElement, view("running"));
      await key(view("running"), "ArrowDown"); assert.equal(dom.window.document.activeElement, view("running-2"));
      await key(view("running-2"), "End"); assert.equal(dom.window.document.activeElement, view("done-2"));
      await key(view("done-2"), "Home"); assert.equal(dom.window.document.activeElement, view("running"));
      await key(view("running"), "Escape"); assert.equal(panel(), null); assert.equal(dom.window.document.activeElement, trigger());
      await click(trigger()); const last = view("done-2"); last.focus(); assert.equal((await key(last, "Tab")).defaultPrevented, false, "Non-modal activity must allow normal tab navigation");
      await act(async () => { after().focus(); }); assert.equal(panel(), null); assert.equal(dom.window.document.activeElement, after()); assert.deepEqual(calls, []);
    } else if (scenario === "outside-reopen") {
      await click(trigger()); const retained = host(), old = view("running");
      await act(async () => { before().dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })); before().focus(); });
      assert.equal(panel(), null); assert.equal(dom.window.document.activeElement, before()); assert.ok(retained?.hasAttribute("inert"));
      await act(async () => { old.click(); }); assert.deepEqual(calls, []);
      await click(trigger()); await pause(); assert.equal(host(), retained); assert.ok(panel()); assert.ok(!host()?.hasAttribute("inert"));
      await close(); assert.equal(dom.window.document.activeElement, trigger());
    } else if (scenario === "remove-focus") {
      await click(trigger()); assert.equal(dom.window.document.activeElement, view("running"));
      items = items.filter(item => item.id !== "running"); await render(); assert.equal(dom.window.document.activeElement, view("running-2"));
      items = items.filter(item => item.id !== "running-2"); await render(); assert.equal(dom.window.document.activeElement, view("attention"));
      items = []; await render(); assert.equal(trigger(), null); assert.equal(panel(), null); assert.equal(dom.window.document.activeElement, after());
      await pause(); assert.equal(host(), null);
      items = [task("new", "running", "A new task")]; await render(); assert.ok(trigger()); assert.equal(panel(), null, "New tasks must not reopen an old popover automatically"); assert.deepEqual(calls, []);
    } else if (scenario === "remove-closed-trigger") {
      trigger().focus(); items = []; await render(); assert.equal(dom.window.document.activeElement, after()); assert.equal(trigger(), null); assert.equal(host(), null);
    } else if (scenario === "reduced" || scenario === "system-reduce-exit") {
      await click(trigger()); if (scenario === "reduced") assert.equal(host()?.dataset.motionPhase, "present");
      await close();
      if (scenario === "system-reduce-exit") { assert.ok(host()); await act(async () => { systemReduced = true; for (const change of [...mediaListeners]) change(); }); }
      assert.equal(host(), null); assert.equal(dom.window.document.activeElement, trigger());
      await click(trigger()); await close(); assert.equal(host(), null); assert.deepEqual(calls, []);
    } else if (scenario.startsWith("width-")) {
      await click(trigger()); const popup = panel()!, computed = dom.window.getComputedStyle(popup), triggerStyle = dom.window.getComputedStyle(trigger());
      const copyDisplay = dom.window.getComputedStyle(trigger().querySelector<HTMLElement>(".workbench-activity-copy")!).display;
      if (width <= 1280) assert.equal(copyDisplay, "none"); else assert.notEqual(copyDisplay, "none");
      assert.ok(parseFloat(triggerStyle.minHeight) >= (width <= 700 ? 36 : 30)); assert.equal(computed.position, "fixed");
      const margin = width <= 700 ? 8 : 12, popupWidth = Math.min(360, width - margin * 2);
      assert.ok(parseFloat(popup.style.left) >= margin); assert.ok(parseFloat(popup.style.left) + popupWidth <= width - margin);
      assert.ok(parseFloat(popup.style.maxHeight) <= dom.window.innerHeight - rectangle.bottom - margin);
      assert.equal(host()?.parentElement, dom.window.document.body, "The task list must not be clipped inside the topbar");
      for (const selector of [".workbench-activity-state", ".workbench-activity-summary", ".workbench-activity-description", ".workbench-activity-progress small"]) {
        for (const text of popup.querySelectorAll<HTMLElement>(selector)) assert.ok(parseFloat(dom.window.getComputedStyle(text).fontSize) >= 11, `${selector} must remain readable at ${width}px`);
      }
      assert.equal(dom.window.getComputedStyle(popup.querySelector<HTMLElement>("h2")!).fontSize, "14px"); assert.equal(dom.window.getComputedStyle(popup.querySelector<HTMLElement>("h3")!).fontSize, "13px");
    } else if (scenario === "unmount") {
      await click(trigger()); available = false; await render(); assert.equal(panel(), null); assert.equal(host(), null); assert.equal(dom.window.document.activeElement, after());
      assert.equal((await key(after(), "Escape")).defaultPrevented, false); await pause(); assert.deepEqual(calls, []);
    } else throw new Error(scenario);
    assert.deepEqual(requests, initialRequests); assert.deepEqual(Object.keys(dom.window.localStorage).filter(key => key.includes("activity")), []);
  } finally { await dom.cleanup(); }
}
try { await run(process.argv[2] ?? "sort-count-progress"); console.log("workbench activity fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
