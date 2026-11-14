import assert from "node:assert/strict";
import type { HTMLElement as FixtureHTMLElement } from "happy-dom";
import { act } from "react";
import { useNavigationMotion, type WorkspaceView } from "../web/navigation-motion.ts";
import { createWebDomHarness } from "./web-dom.ts";

async function run() {
  const dom = await createWebDomHarness();
  let reduced = false;
  const systemListeners = new Set<() => void>();
  const media = {
    get matches() { return reduced; },
    addEventListener(_type: string, listener: () => void) { systemListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { systemListeners.delete(listener); },
  };
  dom.window.matchMedia = (() => media) as unknown as typeof dom.window.matchMedia;

  const resizes = new Set<{ measure(): void; observed: Element[] }>();
  class ResizeObserverFixture {
    readonly observed: Element[] = [];
    constructor(readonly measure: () => void) { resizes.add(this); }
    observe(element: Element) { this.observed.push(element); }
    disconnect() { resizes.delete(this); }
  }
  const previousResize = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverFixture });

  let proxiesTop = 120;
  let activations = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true, value(this: HTMLElement) {
      const top = this.matches("nav") ? 50 : this.dataset.view === "proxies" ? proxiesTop : 75;
      return { top, height: this.matches("button") ? 38 : 0 };
    },
  });
  const animations: Array<{ view: string | undefined; frames: Keyframe[]; timing: KeyframeAnimationOptions; cancelled: boolean }> = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "animate", {
    configurable: true, value(this: HTMLElement, frames: Keyframe[], timing: KeyframeAnimationOptions) {
      const animation = { view: this.dataset.view, frames, timing, cancelled: false };
      animations.push(animation);
      let reject!: (reason: Error) => void;
      const finished = new Promise((_, fail) => { reject = fail; });
      return { finished, cancel() { animation.cancelled = true; reject(new Error("animation interrupted")); } };
    },
  });

  function Surface({ view, ready, allowed }: { view: WorkspaceView; ready: boolean; allowed: boolean }) {
    const { navRef, contentRef } = useNavigationMotion(view, ready, allowed);
    return <><aside className="sidebar"><nav ref={navRef}><span className="rail-active-marker" /><div className="rail-nav-group">
      <button className="navitem" data-view="profiles" aria-current={view === "profiles" ? "page" : undefined} onClick={() => activations++}>Profiles</button>
      <button className="navitem" data-view="proxies" aria-current={view === "proxies" ? "page" : undefined} onClick={() => activations++}>Proxies</button>
      <button className="navitem" disabled>Disabled</button>
      <button className="navitem" hidden>Hidden</button>
    </div></nav><div><button className="navitem" data-view="trash" onClick={() => activations++}>Trash</button>
      <button className="navitem" data-view="settings" onClick={() => activations++}>Settings</button><button data-device>Device</button>
    </div></aside><div ref={contentRef}>
      <section className="workspace" data-view="profiles" hidden={view !== "profiles"}><input defaultValue="original draft" /></section>
      <section className="workspace" data-view="proxies" hidden={view !== "proxies"}>Proxy page</section>
      <section className="workspace" data-view="settings" hidden={view !== "settings"}>Settings page</section>
    </div></>;
  }
  const render = (view: WorkspaceView, ready = true, allowed = true) => dom.render(<Surface view={view} ready={ready} allowed={allowed} />);
  try {
    await render("profiles");
    const nav = dom.container.querySelector("nav")!, marker = dom.container.querySelector<FixtureHTMLElement>(".rail-active-marker")!;
    const draft = dom.container.querySelector("input")!;
    draft.value = "draft edited locally";
    assert.equal(animations.length, 0);
    assert.equal(marker.style.transform, "translateY(35px)");
    assert.equal(nav.hasAttribute("data-marker-visible"), true);
    assert.equal(marker.style.transition, "");

    const key = (target: FixtureHTMLElement, value: string, ctrlKey = false) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true }));
    const profiles = nav.querySelector<FixtureHTMLElement>("button[data-view='profiles']")!;
    const proxies = nav.querySelector<FixtureHTMLElement>("button[data-view='proxies']")!;
    const trash = dom.container.querySelector<FixtureHTMLElement>("button[data-view='trash']")!;
    const settings = dom.container.querySelector<FixtureHTMLElement>("button[data-view='settings']")!;
    const device = dom.container.querySelector<FixtureHTMLElement>("button[data-device]")!;
    profiles.focus();
    assert.equal(key(profiles, "ArrowDown"), false);
    assert.equal(dom.window.document.activeElement, proxies);
    assert.equal(key(proxies, "ArrowDown"), false);
    assert.equal(dom.window.document.activeElement, trash, "Short-rail navigation includes the footer without stopping on hidden or disabled buttons");
    assert.equal(key(trash, "End"), false);
    assert.equal(dom.window.document.activeElement, settings);
    assert.equal(key(settings, "Home", true), true);
    assert.equal(dom.window.document.activeElement, settings);
    assert.equal(key(settings, "Home"), false);
    assert.equal(dom.window.document.activeElement, profiles);
    assert.equal(key(profiles, "ArrowUp"), false);
    assert.equal(dom.window.document.activeElement, settings);
    assert.equal(key(settings, "Tab"), true);
    assert.equal(key(settings, "Enter"), true);
    assert.equal(activations, 0, "Arrow movement must not activate another page");
    assert.equal(key(device, "ArrowUp"), true);

    await render("proxies");
    assert.equal(animations.length, 1);
    assert.equal(animations[0]?.view, "proxies");
    assert.deepEqual(animations[0]?.frames[0], { opacity: 0.72, transform: "translateX(8px)" });
    assert.equal(animations[0]?.timing.duration, 180);
    assert.equal(animations[0]?.timing.fill, undefined);
    assert.equal(marker.style.transform, "translateY(80px)");
    assert.deepEqual([...resizes][0]?.observed.map(element => element.tagName), ["NAV", "DIV"]);
    proxiesTop = 140;
    for (const resize of resizes) resize.measure();
    assert.equal(marker.style.transform, "translateY(100px)");

    await render("settings");
    assert.equal(animations[0]?.cancelled, true);
    assert.equal(animations[1]?.view, "settings");
    assert.equal(nav.hasAttribute("data-marker-visible"), false);
    await render("profiles");
    assert.equal(animations[1]?.cancelled, true);
    assert.equal(animations[2]?.view, "profiles");
    assert.match(String(animations[2]?.frames[0]?.transform), /^translateX\(-\d+px\)$/);
    assert.equal(nav.hasAttribute("data-marker-visible"), true);
    assert.equal(marker.style.transform, "translateY(35px)");
    assert.equal(marker.style.transition, "");
    assert.equal(dom.container.querySelector("input"), draft);
    assert.equal(draft.value, "draft edited locally");

    reduced = true;
    for (const change of systemListeners) change();
    assert.equal(animations[2]?.cancelled, true);
    await render("proxies");
    assert.equal(animations.length, 3);
    reduced = false;
    await render("settings", true, false);
    await render("settings", true, true);
    assert.equal(animations.length, 3, "Re-enabling motion must not replay the current page");
    await act(async () => { await dom.unmount(); });
    assert.equal(resizes.size, 0);
    assert.equal(systemListeners.size, 0);
  } finally {
    try { await dom.cleanup(); }
    finally {
      if (previousResize) Object.defineProperty(globalThis, "ResizeObserver", previousResize);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  }
}

if (import.meta.main) {
  try { await run(); console.log("navigation motion fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
