import assert from "node:assert/strict";
import { act, useRef } from "react";
import type { HTMLInputElement, HTMLDivElement as DomDivElement, HTMLButtonElement as DomButtonElement } from "happy-dom";
import { DesktopMotionSettings, MotionPresence, DESKTOP_MOTION_KEY, useDesktopMotion, usePanelMotion } from "../web/desktop-motion.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  let systemReduced = false;
  const mediaListeners = new Set<() => void>();
  const media = { get matches() { return systemReduced; }, media: "(prefers-reduced-motion: reduce)", addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener), removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener) };
  dom.window.matchMedia = (() => media) as any;
  const changeSystem = async (value: boolean) => act(async () => { systemReduced = value; for (const change of [...mediaListeners]) change(); });
  let clicks = 0, submits = 0, childReads = 0;
  const animations: Array<{ cancelled: boolean; frames: unknown }> = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "animate", { configurable: true, value(frames: unknown) { const record = { cancelled: false, frames }; animations.push(record); return { cancel: () => { record.cancelled = true; } }; } });
  function Surface({ open, label, panelKey = "one", enabled = true }: { open: boolean; label: string; panelKey?: string; enabled?: boolean }) {
    const motion = useDesktopMotion(), panel = useRef<HTMLDivElement>(null);
    usePanelMotion(panelKey, enabled, panel);
    return <><output data-current-mode>{motion.preference}/{motion.effective}</output><DesktopMotionSettings value={motion.preference} onChange={motion.setPreference} />
      <div ref={panel}><input aria-label="Retained form input" defaultValue="unsaved text" /></div>
      <MotionPresence present={open}>{() => {
        childReads++;
        return <form className="modal-backdrop" onSubmit={event => { event.preventDefault(); submits++; }}><section className="modal" role="dialog"><span>{label}</span><button type="button" data-count onClick={() => clicks++}>Count action</button><button type="submit">Submit action</button></section></form>;
      }}</MotionPresence>
    </>;
  }
  const render = (open = true, label = "Original dialog", panelKey = "one", enabled = true) => dom.render(<I18nProvider><Surface open={open} label={label} panelKey={panelKey} enabled={enabled} /></I18nProvider>);
  const choose = async (value: string) => act(async () => { const input = dom.container.querySelector<HTMLInputElement>(`input[value="${value}"]`); assert.ok(input); input.click(); });
  const host = () => dom.container.querySelector<DomDivElement>(".desktop-motion-presence");
  try {
    if (scenario === "storage-blocked") {
      Object.defineProperty(dom.window.document, "cookie", { configurable: true, get: () => { throw new Error("blocked"); }, set: () => { throw new Error("blocked"); } });
      Object.defineProperty(dom.window.localStorage, "getItem", { configurable: true, value: () => { throw new Error("blocked"); } });
      Object.defineProperty(dom.window.localStorage, "setItem", { configurable: true, value: () => { throw new Error("blocked"); } });
    }
    await render();
    if (scenario === "preference" || scenario === "storage-blocked") {
      assert.equal(dom.window.document.documentElement.dataset.desktopMotion, "full");
      await choose("reduced");
      assert.equal(dom.window.document.documentElement.dataset.desktopMotion, "reduced");
      assert.ok(dom.container.querySelector("[data-current-mode]")?.textContent?.includes("reduced/reduced"));
      if (scenario === "storage-blocked") return;
      assert.ok(dom.window.document.cookie.includes(`${DESKTOP_MOTION_KEY}=reduced`));
      assert.equal(dom.window.localStorage.getItem(DESKTOP_MOTION_KEY), "reduced");
      await choose("full"); await changeSystem(true);
      assert.equal(dom.window.document.documentElement.dataset.desktopMotion, "reduced");
      assert.ok(dom.container.querySelector("[data-current-mode]")?.textContent?.includes("full/reduced"));
      await changeSystem(false);
      assert.equal(dom.window.document.documentElement.dataset.desktopMotion, "full");
      await dom.unmount(); await render();
      assert.ok(dom.container.querySelector("[data-current-mode]")?.textContent?.includes("full/full"));
      return;
    }
    if (scenario === "presence") {
      const initial = host(); assert.ok(initial);
      await act(async () => { dom.container.querySelector<DomButtonElement>("button[data-count]")!.click(); });
      assert.equal(clicks, 1);
      const reads = childReads;
      await render(false, "Cleared state must not flash during exit");
      assert.equal(host(), initial);
      assert.equal(host()?.getAttribute("aria-hidden"), "true"); assert.ok(host()?.hasAttribute("inert"));
      assert.equal(host()?.dataset.motionPhase, "exiting");
      assert.ok(host()?.textContent?.includes("Original dialog"));
      assert.ok(!host()?.textContent?.includes("Cleared state")); assert.equal(childReads, reads);
      await act(async () => {
        dom.container.querySelector<DomButtonElement>("button[data-count]")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        dom.container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(clicks, 1); assert.equal(submits, 0, "Retained exit controls must never perform another operation");
      await render(true, "Reopened dialog");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      assert.ok(host()?.textContent?.includes("Reopened dialog"), "The old exit timer must not remove a reopened dialog");
      assert.equal(host()?.getAttribute("aria-hidden"), null); assert.ok(!host()?.hasAttribute("inert"));
      await render(false); await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      assert.equal(host(), null); return;
    }
    if (scenario === "reduced-exit") {
      await render(false); assert.ok(host());
      await changeSystem(true); assert.equal(host(), null, "Enabling reduced motion must immediately finish an existing exit");
      await render(true); assert.equal(host()?.dataset.motionPhase, "present");
      await render(false); assert.equal(host(), null, "Reduced motion must not leave an invisible exit timer or focusable form");
      return;
    }
    if (scenario === "panel") {
      const input = dom.container.querySelector<HTMLInputElement>('input[aria-label="Retained form input"]')!;
      input.value = "unsaved edited value"; input.focus();
      assert.equal(animations.length, 0, "The initial panel must not animate needlessly");
      await render(true, "Original dialog", "two");
      assert.equal(animations.length, 1); assert.equal(dom.window.document.activeElement, input); assert.equal(input.value, "unsaved edited value");
      await render(true, "Original dialog", "three");
      assert.equal(animations.length, 2); assert.equal(animations[0]?.cancelled, true);
      await choose("reduced"); assert.equal(animations[1]?.cancelled, true, "Changing motion mode must cancel running panel movement");
      await render(true, "Original dialog", "four"); assert.equal(animations.length, 2);
      await choose("full"); assert.equal(animations.length, 2, "Restoring full motion must not replay an unchanged panel");
      await render(true, "Original dialog", "five", false); await render(true, "Original dialog", "five", true);
      assert.equal(animations.length, 2); return;
    }
    throw new Error(`Unknown scenario ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "preference"); console.log("desktop motion interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
