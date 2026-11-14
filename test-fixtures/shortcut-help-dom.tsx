import assert from "node:assert/strict";
import { act, useLayoutEffect, useRef, useState } from "react";
import type { HTMLButtonElement, HTMLInputElement as DomInputElement, HTMLElement } from "happy-dom";
import { ShortcutHelp } from "../web/shortcut-help.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { readWorkbenchShortcutContext, type WorkbenchShortcutAction } from "../web/workbench-shortcuts.ts";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const actions: WorkbenchShortcutAction[] = [];
  let desktop = true, mac = false;
  function Surface() {
    const [open, setOpen] = useState(false), [editor, setEditor] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => { if (editor) input.current?.focus(); }, [editor]);
    return <><button type="button" data-help-trigger onClick={() => setOpen(true)}>Open shortcuts</button><input data-search aria-label="Environment search" />
      <ShortcutHelp open={open} desktop={desktop} mac={mac} onClose={() => setOpen(false)} onAction={action => {
        assert.equal(readWorkbenchShortcutContext(null, dom.window.document as unknown as Document).modalOpen, false, "The guide must have closed before handing off its action");
        actions.push(action);
        if (action === "create-profile") setEditor(true);
        else if (action === "focus-profile-search") dom.container.querySelector<DomInputElement>("[data-search]")?.focus();
      }} />
      {editor && <div role="dialog" aria-modal="true" aria-label="New environment editor"><input ref={input} data-editor-input aria-label="New environment name" /></div>}
    </>;
  }
  const render = () => dom.render(<I18nProvider><Surface /></I18nProvider>);
  const trigger = () => dom.container.querySelector<HTMLButtonElement>("[data-help-trigger]")!;
  const help = () => [...dom.window.document.querySelectorAll<HTMLElement>('.shortcut-help[role="dialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const button = (label: string) => { const found = [...help()!.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.startsWith(label)); assert.ok(found, `Missing action ${label}`); return found; };
  const close = () => help()!.querySelector<HTMLButtonElement>('[aria-label="Close keyboard shortcuts"]')!;
  const key = async (value: string, options: Record<string, boolean> = {}) => act(async () => {
    const target = dom.window.document.activeElement ?? dom.window.document.body;
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }));
  });
  const open = async () => { trigger().focus(); await act(async () => { trigger().click(); }); assert.ok(help()); };
  try {
    await render();
    if (scenario === "fallback") {
      const previous = dom.window.document.createElement("input"), fallback = dom.window.document.createElement("button");
      previous.setAttribute("aria-label", "Command search that will disappear"); fallback.textContent = "Shortcut help entry";
      dom.window.document.body.append(previous, fallback); previous.focus();
      function GuideFromPalette() {
        const [open, setOpen] = useState(true);
        return <ShortcutHelp open={open} desktop onClose={() => setOpen(false)} onAction={() => {}} returnFocus={() => fallback as unknown as globalThis.HTMLElement} />;
      }
      await dom.render(<I18nProvider><GuideFromPalette /></I18nProvider>);
      previous.remove();
      await act(async () => { close().click(); });
      assert.equal(help(), null); assert.equal(dom.window.document.activeElement, fallback, "A vanished palette input must yield to the stable help entry");
      fallback.remove(); return;
    }
    if (scenario === "contexts") {
      const document = dom.window.document;
      const read = (node: unknown = document.body) => readWorkbenchShortcutContext(node as EventTarget, document as unknown as Document);
      assert.deepEqual(read(), { editable: false, modalOpen: false });
      for (const source of ['<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable=""><span>Typing</span></div>', '<div role="textbox"><span>Typing</span></div>']) {
        const host = document.createElement("div"); host.innerHTML = source; document.body.append(host);
        assert.equal(read(host.querySelector("span") ?? host.firstElementChild).editable, true); host.remove();
      }
      const notEditable = document.createElement("div"); notEditable.innerHTML = '<div contenteditable="true"><span contenteditable="false">Read only</span></div>'; document.body.append(notEditable);
      assert.equal(read(notEditable.querySelector("span")).editable, false); notEditable.remove();
      for (const source of ['<div role="dialog"></div>', '<div role="alertdialog"></div>', '<dialog open></dialog>', '<div aria-modal="true"></div>', '<div class="modal-backdrop"></div>']) {
        const host = document.createElement("div"); host.innerHTML = source; document.body.append(host);
        assert.equal(read().modalOpen, true);
        for (const attribute of ["inert", "aria-hidden", "hidden"]) {
          host.setAttribute(attribute, attribute === "aria-hidden" ? "true" : ""); assert.equal(read().modalOpen, false); host.removeAttribute(attribute);
        }
        host.style.display = "none"; assert.equal(read().modalOpen, false);
        host.style.display = "block"; host.style.visibility = "hidden"; assert.equal(read().modalOpen, false); host.remove();
      }
      return;
    }
    await open();
    assert.equal(dom.window.document.activeElement, close());
    assert.equal(readWorkbenchShortcutContext(null, dom.window.document as unknown as Document).modalOpen, true);
    if (scenario === "focus") {
      const buttons = [...help()!.querySelectorAll<HTMLButtonElement>("button")], first = buttons[0]!, last = buttons.at(-1)!;
      await act(async () => { last.focus(); }); await key("Tab"); assert.equal(dom.window.document.activeElement, first);
      await key("Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, last);
      await act(async () => { trigger().focus(); }); assert.equal(dom.window.document.activeElement, close(), "Focus must stay within the guide");
      await key("Escape", { isComposing: true }); assert.ok(help(), "IME Escape must stay with the composition");
      await key("Escape"); assert.equal(help(), null); assert.equal(dom.window.document.activeElement, trigger());
      const retained = dom.window.document.querySelector<HTMLElement>(".shortcut-help");
      assert.ok(retained?.closest('[inert][aria-hidden="true"]'), "Full motion must retain only an inactive exit snapshot");
      assert.equal(readWorkbenchShortcutContext(null, dom.window.document as unknown as Document).modalOpen, false);
      await open(); await act(async () => { close().click(); }); assert.equal(help(), null); assert.equal(dom.window.document.activeElement, trigger());
      assert.deepEqual(actions, []);
      const external = dom.window.document.createElement("button"); external.textContent = "External help trigger"; dom.window.document.body.append(external); external.focus();
      await dom.render(<I18nProvider><ShortcutHelp open desktop onClose={() => {}} onAction={() => {}} /></I18nProvider>);
      assert.equal(dom.window.document.activeElement, close());
      await dom.unmount(); assert.equal(dom.window.document.activeElement, external, "A complete guide unmount must restore its connected entry point"); external.remove();
      return;
    }
    if (scenario === "handoff") {
      const source = button("New environment");
      await act(async () => { source.click(); });
      assert.equal(help(), null); assert.deepEqual(actions, ["create-profile"]);
      const editor = dom.container.querySelector<DomInputElement>("[data-editor-input]"); assert.ok(editor);
      assert.equal(dom.window.document.activeElement, editor, "Closing the guide must not take focus back from a new editor");
      await act(async () => { source.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
      assert.deepEqual(actions, ["create-profile"], "Exit snapshot actions cannot run twice");
      await dom.flush(); assert.equal(dom.window.document.activeElement, editor); return;
    }
    if (scenario === "platforms") {
      assert.ok(help()!.textContent.includes("Ctrl")); assert.ok(help()!.textContent.includes("Alt"));
      await key("Escape"); desktop = false; mac = true; await render(); await open();
      assert.ok(help()!.textContent.includes("⌘")); assert.ok(!help()!.textContent.includes("Ctrl"));
      assert.ok(!help()!.textContent.includes("New environment")); assert.ok(!help()!.textContent.includes("Move between pages"));
      assert.equal(help()!.querySelectorAll("button").length, 3);
      await act(async () => { button("Search environments").click(); });
      assert.deepEqual(actions, ["focus-profile-search"]);
      assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-search]"), "Handoff must release the focus trap before focusing search");
      desktop = true; await render(); await open();
      assert.ok(help()!.textContent.includes("⌥")); assert.ok(!help()!.textContent.includes("Alt"));
      await key("Escape"); return;
    }
    throw new Error(`Unknown shortcut fixture: ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "focus"); console.log("shortcut help interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
