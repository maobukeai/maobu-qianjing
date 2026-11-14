import assert from "node:assert/strict";
import { act, useRef } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { useDesktopMotion } from "../web/desktop-motion.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { useUnsavedChangesGuard } from "../web/unsaved-changes-guard.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const reduced = scenario === "reduced";
  dom.window.matchMedia = (() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} })) as any;
  let guard!: ReturnType<typeof useUnsavedChangesGuard>, actions = 0, alternate = 0, parentEscapes = 0, parentTabs = 0;
  function Shell({ label = "Edit profile" }: { label?: string }) {
    useDesktopMotion();
    const editor = useRef<HTMLDivElement>(null);
    guard = useUnsavedChangesGuard({ label, returnFocus: () => editor.current });
    return <><div ref={editor} tabIndex={-1} data-editor role="dialog" aria-label="Fixture editor"><input aria-label="Private account field" defaultValue="PRIVATE_FIELD_VALUE" /><input type="password" aria-label="Private password field" defaultValue="PRIVATE_PASSWORD_VALUE" /><button type="button" data-editor-close>Editor close</button></div><button type="button" data-outside>Outside action</button>{guard.dialog}</>;
  }
  const render = (label?: string) => dom.render(<I18nProvider><Shell label={label} /></I18nProvider>);
  const activeDialog = () => [...dom.window.document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (text: string) => { const node = [...activeDialog()!.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text); assert.ok(node, `Missing ${text}`); return node; };
  const origin = () => dom.container.querySelector<HTMLInputElement>("input")!;
  const outside = () => dom.container.querySelector<HTMLButtonElement>("[data-outside]")!;
  const host = () => dom.window.document.querySelector<HTMLElement>(".desktop-motion-presence");
  const request = async (dirty = true, onDiscard = () => { actions++; }) => act(async () => { guard.requestClose({ dirty, onDiscard }); });
  const click = (text: string, twice = false) => act(async () => { const node = button(text); node.click(); if (twice) node.click(); });
  const key = (value: string, options: { shiftKey?: boolean; repeat?: boolean; isComposing?: boolean } = {}) => act(async () => { (dom.window.document.activeElement ?? dom.window.document.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })); });
  const releaseEscape = () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  const parentEscape = (event: KeyboardEvent) => { if (event.key === "Escape") parentEscapes++; };
  const parentTab = (event: KeyboardEvent) => { if (event.key === "Tab") parentTabs++; };
  dom.window.document.addEventListener("keydown", parentEscape as any);
  dom.window.document.addEventListener("keydown", parentTab as any, true);
  try {
    await render(); origin().focus();
    if (scenario === "clean") {
      await act(async () => { assert.equal(guard.requestClose({ dirty: false, onDiscard: () => actions++ }), "closed"); assert.equal(guard.requestClose({ dirty: false, onDiscard: () => actions++ }), "ignored"); });
      assert.equal(actions, 1); assert.equal(activeDialog(), undefined);
      await request(false); assert.equal(actions, 2, "A later clean close must not require reset");
      return;
    }
    if (scenario === "frozen-intent") {
      await act(async () => { guard.requestClose({ dirty: true, onDiscard: () => actions++ }); assert.equal(guard.requestClose({ dirty: false, onDiscard: () => alternate++ }), "ignored"); });
      await render("New profile"); assert.equal(activeDialog()!.querySelector(".unsaved-changes-guard-context")?.textContent, "Edit profile");
      assert.ok(!activeDialog()!.outerHTML.includes("PRIVATE_")); assert.ok(!activeDialog()!.outerHTML.includes("Private account field"));
      assert.equal(dom.container.querySelector('[role="alertdialog"]'), null, "The actual dialog must be portaled outside the editor's root");
      await click("Discard changes", true); assert.equal(actions, 1); assert.equal(alternate, 0); return;
    }
    if (scenario === "reset") {
      await request(); const stale = button("Discard changes");
      await act(async () => guard.reset());
      await act(async () => stale.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })));
      assert.equal(actions, 0); assert.equal(activeDialog(), undefined);
      await request(true, () => alternate++); await click("Discard changes", true);
      assert.equal(actions, 0); assert.equal(alternate, 1); return;
    }
    if (scenario === "unmount") {
      await request(); const stale = button("Discard changes"), old = guard;
      await dom.unmount(); stale.click(); assert.equal(old.requestClose({ dirty: false, onDiscard: () => actions++ }), "ignored");
      await new Promise(resolve => setTimeout(resolve, 170)); assert.equal(actions, 0); return;
    }
    if (scenario === "throw" || scenario === "clean-throw") {
      await request(scenario !== "clean-throw", () => { actions++; throw new Error("PRIVATE_PASSWORD_DO_NOT_RENDER"); });
      if (scenario === "throw") await click("Discard changes", true);
      assert.equal(actions, 1); assert.ok(activeDialog());
      assert.ok(activeDialog()!.querySelector('[role="alert"]')?.textContent?.includes("The editor could not be closed"));
      assert.ok(!activeDialog()!.outerHTML.includes("PRIVATE_PASSWORD_DO_NOT_RENDER"));
      assert.equal([...activeDialog()!.querySelectorAll("button")].length, 1, "A failed frozen action must not be offered again");
      await click("Keep editing"); assert.equal(dom.window.document.activeElement, origin());
      await request(); await click("Discard changes"); assert.equal(actions, 2, "A new explicit close request can retry after continuing");
      return;
    }
    if (scenario === "fallback") {
      const old = origin(); await request(); old.remove(); await click("Keep editing");
      assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-editor]")); assert.equal(actions, 0); return;
    }
    if (scenario === "discard-focus") {
      await request(true, () => {
        actions++;
        assert.equal(host()?.getAttribute("aria-hidden"), "true", "The exit must already be inert before editor cleanup runs");
        assert.ok(host()?.hasAttribute("inert")); outside().focus();
      });
      await click("Discard changes", true); assert.equal(actions, 1); assert.equal(dom.window.document.activeElement, outside());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      assert.equal(host(), null); assert.equal(dom.window.document.activeElement, outside()); return;
    }
    await request(); assert.equal(dom.window.document.activeElement, button("Keep editing"));
    if (scenario === "keyboard") {
      await key("Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, button("Discard changes"));
      await key("Tab"); assert.equal(dom.window.document.activeElement, button("Keep editing")); assert.equal(parentTabs, 0, "The underlying editor trap must not receive confirmation Tab keys");
      await key("Escape", { isComposing: true }); assert.ok(activeDialog()); assert.equal(parentEscapes, 0, "IME Escape must not reach the underlying editor");
      await key("Escape"); assert.equal(actions, 0); assert.equal(activeDialog(), undefined); assert.equal(dom.window.document.activeElement, origin());
      await key("Escape", { repeat: true }); assert.equal(parentEscapes, 0, "Held Escape must not immediately request closing the editor again");
      releaseEscape(); return;
    }
    await click("Keep editing"); assert.equal(actions, 0); assert.equal(dom.window.document.activeElement, origin(), "Focus returns immediately before the visual exit finishes");
    if (scenario === "reduced") { assert.equal(host(), null); return; }
    assert.equal(host()?.getAttribute("aria-hidden"), "true"); assert.ok(host()?.hasAttribute("inert"));
    const stale = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".unsaved-changes-guard button")].find(node => node.textContent === "Discard changes")!;
    await act(async () => stale.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))); assert.equal(actions, 0);
    await request(true, () => alternate++); assert.ok(activeDialog());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); }); assert.ok(activeDialog(), "A prior exit timer must not remove a renewed confirmation");
    await click("Discard changes"); assert.equal(alternate, 1);
  } finally {
    const document = dom.window.document as unknown as Document;
    document.removeEventListener("keydown", parentEscape); document.removeEventListener("keydown", parentTab, true);
    await dom.cleanup();
  }
}
await run(process.argv[2] ?? "keep-editing"); console.log("unsaved changes guard fixture passed");
