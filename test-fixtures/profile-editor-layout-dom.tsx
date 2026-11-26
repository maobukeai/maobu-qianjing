import assert from "node:assert/strict";
import { act, useEffect, useState } from "react";
import type { HTMLButtonElement, HTMLDetailsElement, HTMLInputElement } from "happy-dom";
import { ProfileEditorLayout, ProfileEditorSection, revealProfileEditorTarget } from "../web/features/profile-editor-layout.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  // No extensions: Account and Fingerprint form a short tail that cannot each
  // be aligned to the scrollport's top, as in the real Chromium editor.
  const sections = [{ id: "basic", label: "Basic" }, { id: "proxy", label: "Proxy" }, { id: "account", label: "Account" }, { id: "fingerprint", label: "Fingerprint" }];
  const scrolls: Array<{ section: string | null; options: unknown }> = [];
  let mounts = 0, unmounts = 0, submits = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement, options: unknown) {
    scrolls.push({ section: this.closest("[data-profile-editor-section]")?.getAttribute("data-profile-editor-section") ?? null, options });
  } });
  function DraftField() {
    const [value, setValue] = useState("original");
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return <input aria-label="Draft name" value={value} onChange={event => setValue(event.target.value)} />;
  }
  const render = ({ ready = true, sessionKey = "first", secondEditor = false }: { ready?: boolean; sessionKey?: string; secondEditor?: boolean } = {}) => dom.render(
    <form onSubmit={event => { event.preventDefault(); submits++; }}>
      <div className="test-scroll-body" style={{ overflowY: "auto", maxHeight: 400 }}>
        <ProfileEditorLayout label="Editor sections" sections={sections} ready={ready} sessionKey={sessionKey}>
          {ready ? <>
            <ProfileEditorSection sectionId="basic"><DraftField /></ProfileEditorSection>
            <ProfileEditorSection sectionId="proxy" description="Verify before saving"><input aria-label="Proxy host" required defaultValue="" /></ProfileEditorSection>
            <ProfileEditorSection sectionId="account"><input aria-label="Account user" defaultValue="" /></ProfileEditorSection>
            <ProfileEditorSection sectionId="fingerprint"><details><summary>Advanced fingerprint settings</summary><input aria-label="Screen" required defaultValue="" data-profile-field="resolution" /></details></ProfileEditorSection>
          </> : <p role="status">Loading profile</p>}
        </ProfileEditorLayout>
      </div>
      <button type="submit">Save</button>
      {secondEditor && <ProfileEditorLayout label="Other editor" sections={sections}>
        <ProfileEditorSection sectionId="basic"><input aria-label="Other draft" /></ProfileEditorSection>
        <ProfileEditorSection sectionId="proxy">Other proxy</ProfileEditorSection>
        <ProfileEditorSection sectionId="account">Other account</ProfileEditorSection>
        <ProfileEditorSection sectionId="fingerprint">Other fingerprint</ProfileEditorSection>
      </ProfileEditorLayout>}
    </form>,
  );
  const nav = () => dom.container.querySelector('nav[aria-label="Editor sections"]')!;
  const navButton = (label: string) => [...nav().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent.endsWith(label))!;
  const input = (label: string) => dom.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const section = (id: string) => dom.container.querySelector(`[data-profile-editor-section="${id}"]`)!;
  const current = () => nav().querySelector('[aria-current="location"]');
  const click = (button: HTMLButtonElement) => act(async () => { button.focus(); button.click(); });

  try {
    if (scenario === "async-and-field-focus") {
      await render({ ready: false });
      assert.ok([...nav().querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled));
      const save = dom.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      save.focus();
      await render({ secondEditor: true });
      assert.equal(dom.window.document.activeElement, save, "Loading details must not move focus from a parent-owned control");
      const ids = [...dom.container.querySelectorAll("[data-profile-editor-section]")].map(node => node.id);
      assert.equal(new Set(ids).size, ids.length, "Multiple mounted editors must have distinct section anchors");
      const target = input("Screen");
      const details = target.closest("details") as HTMLDetailsElement;
      assert.equal(details.open, false);
      await act(async () => { assert.equal(revealProfileEditorTarget(target as unknown as HTMLElement), true); });
      assert.equal(details.open, true);
      assert.equal(dom.window.document.activeElement, target);
      assert.equal(current(), navButton("Fingerprint"), "An inspection/validation field link updates the section index");
      assert.equal(dom.container.querySelector('nav[aria-label="Other editor"] [aria-current="location"]')?.textContent, "Basic");
      assert.equal(revealProfileEditorTarget(null), false);
      return;
    }

    await render();
    if (scenario === "navigation-keeps-drafts") {
      const draft = input("Draft name");
      await act(async () => {
        draft.value = "kept draft";
        draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      const initialHash = dom.window.location.hash;
      await click(navButton("Proxy"));
      assert.equal(current(), navButton("Proxy"));
      const controlled = navButton("Proxy").getAttribute("aria-controls")!;
      assert.equal(dom.window.document.getElementById(controlled), section("proxy"));
      assert.equal(dom.window.document.activeElement, section("proxy").querySelector("h3"));
      await click(navButton("Fingerprint"));
      await click(navButton("Basic"));
      assert.equal(input("Draft name"), draft, "Section navigation must retain the same field DOM node");
      assert.equal(input("Draft name").value, "kept draft");
      assert.equal(mounts, 1);
      assert.equal(unmounts, 0);
      assert.equal(submits, 0, "Navigation must not submit the parent form");
      assert.equal(dom.window.location.hash, initialHash);
      for (const id of ["basic", "proxy", "account", "fingerprint"]) {
        assert.equal(section(id).hasAttribute("hidden"), false);
        assert.equal(section(id).hasAttribute("inert"), false);
        assert.equal(section(id).getAttribute("aria-hidden"), null);
      }
      assert.equal(scrolls.at(-1)?.section, "basic");
      return;
    }

    if (scenario === "first-invalid-and-disclosure") {
      const screen = input("Screen"), host = input("Proxy host");
      await act(async () => {
        screen.dispatchEvent(new dom.window.Event("invalid", { cancelable: true }));
        host.dispatchEvent(new dom.window.Event("invalid", { cancelable: true }));
        await Promise.resolve();
      });
      assert.equal((screen.closest("details") as HTMLDetailsElement).open, true);
      assert.equal(dom.window.document.activeElement, screen, "Multiple native invalid events must keep the first invalid field focused");
      assert.equal(current(), navButton("Fingerprint"));
      assert.equal(submits, 0);
      await act(async () => {
        host.dispatchEvent(new dom.window.Event("invalid", { cancelable: true }));
        await Promise.resolve();
      });
      assert.equal(dom.window.document.activeElement, host, "The next validation attempt can focus its own first problem");
      assert.equal(current(), navButton("Proxy"));
      return;
    }

    const scroller = dom.container.querySelector(".test-scroll-body")!;
    Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10 }) });
    for (const [id, top] of [["basic", -300], ["proxy", 15], ["account", 160], ["fingerprint", 300]] as const) {
      Object.defineProperty(section(id), "getBoundingClientRect", { configurable: true, value: () => ({ top, height: 200 }) });
    }
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    });
    assert.equal(current(), navButton("Proxy"), "Scrolling the parent's modal body updates the navigation location");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, value: 500 },
    });
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    });
    assert.equal(current(), navButton("Fingerprint"), "The final short section becomes current at the bottom even if its heading cannot reach the top");
    await act(async () => {
      // Queue a scroll update before navigation too: its animation frame must
      // not override the explicit section when it runs after the click.
      scroller.dispatchEvent(new dom.window.Event("scroll"));
      navButton("Account").click();
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    });
    const accountHeading = section("account").querySelector("h3")!;
    assert.equal(dom.window.document.activeElement, accountHeading);
    assert.equal(current(), navButton("Account"), "Navigating to the short Account tail must not select Fingerprint merely because scrollIntoView reaches the bottom");
    const scrollFrame = async () => act(async () => {
      scroller.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    });
    await scrollFrame();
    assert.equal(current(), navButton("Account"), "Subsequent automatic scroll events preserve the navigation intent");
    await act(async () => { revealProfileEditorTarget(input("Account user") as unknown as HTMLElement); });
    await scrollFrame();
    assert.equal(current(), navButton("Account"), "Explicit field focus has the same priority as section navigation");
    await act(async () => { input("Account user").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    await scrollFrame();
    assert.equal(current(), navButton("Account"), "Moving a text caret is not a user request to scroll the editor");
    for (const type of ["wheel", "touchmove", "pointerdown"] as const) {
      await click(navButton("Account"));
      await act(async () => { scroller.dispatchEvent(new dom.window.Event(type, { bubbles: true })); });
      await scrollFrame();
      assert.equal(current(), navButton("Fingerprint"), `${type} restores manual scrollspy and the short final section rule`);
    }
    for (const key of ["ArrowDown", "PageDown", "End", " "]) {
      await click(navButton("Account"));
      await act(async () => { accountHeading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
      await scrollFrame();
      assert.equal(current(), navButton("Fingerprint"), `${JSON.stringify(key)} on a non-editable heading restores manual scrollspy`);
    }
    await render({ sessionKey: "next" });
    assert.equal(current(), navButton("Basic"), "A new parent editing session resets section context");
    assert.equal(mounts, 1, "A navigation session reset does not remount parent-owned form children");
  } finally {
    await dom.cleanup();
  }
}

await run(process.argv[2] ?? "navigation-keeps-drafts");
console.log("profile editor layout DOM passed");
