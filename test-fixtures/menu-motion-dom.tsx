import assert from "node:assert/strict";
import { act, useLayoutEffect, useRef, useState } from "react";
import type { HTMLElement as DomElement, HTMLButtonElement as DomButton, HTMLInputElement as DomInput, HTMLDivElement as DomDiv } from "happy-dom";
import { ProfileActionMenu } from "../web/profile-action-menu.tsx";
import { CommandPalette, isShortcutTargetAllowed, type CommandPaletteCommand } from "../web/command-palette.tsx";
import { useDesktopMotion } from "../web/desktop-motion.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const row = scenario.startsWith("row-");
  let reduced = false, anchor = { x: 500, y: 100 }, actions: string[] = [], closes = 0;
  const listeners = new Set<() => void>();
  const media = { get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  dom.window.matchMedia = (() => media) as any;
  const rect = (x = 0, y = 0, width = 200, height = 32) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() { return { x, y, width, height }; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value(this: DomElement) { return this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [rect()]; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value(this: DomElement) { return this.matches(".profile-menu-trigger") ? rect(anchor.x, anchor.y, 24, 24) : rect(); } });
  function RowHarness({ revision }: { revision: number }) {
    useDesktopMotion();
    return <><ProfileActionMenu label={`Actions ${revision}`} icon={<span>Menu</span>}>
      <button role="menuitem" disabled onClick={() => actions.push("disabled")}>Disabled action</button>
      <button role="menuitem" onClick={() => actions.push("edit")}>Edit action</button>
      <button role="menuitem" onClick={() => actions.push("inspect")}>Inspect action</button>
    </ProfileActionMenu><input aria-label="Outside input" /></>;
  }
  function PaletteHarness() {
    useDesktopMotion();
    const [open, setOpen] = useState(false), [nextDialog, setNextDialog] = useState(false);
    const next = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => { if (nextDialog) next.current?.focus(); }, [nextDialog]);
    const commands: CommandPaletteCommand[] = [
      { id: "disabled", label: "Disabled action", disabled: true, run: () => actions.push("disabled") },
      { id: "create", label: "Create action", run: () => actions.push("create") },
      { id: "report", label: "Open report dialog", run: () => { actions.push("report"); setNextDialog(true); } },
      { id: "refresh", label: "Refresh action", run: () => actions.push("refresh") },
      { id: "failure", label: "Failing action", run: () => { throw new Error("Inert command failure"); } },
    ];
    return <><button type="button" data-open onClick={() => setOpen(true)}>Open commands</button><input aria-label="Outside input" />
      <CommandPalette commands={commands} open={open} onClose={() => { closes++; setOpen(false); }} />
      {nextDialog && <section role="dialog" aria-label="Report dialog"><button ref={next}>Report action</button></section>}
    </>;
  }
  const render = (revision = 1) => dom.render(<I18nProvider>{row ? <RowHarness revision={revision} /> : <PaletteHarness />}</I18nProvider>);
  const raw = () => dom.window.document.querySelector<DomDiv>(row ? '.profile-actions-menu[role="menu"]' : '[data-command-palette="true"]');
  const active = () => { const node = raw(); return node && !node.closest('[inert], [aria-hidden="true"]') ? node : null; };
  const button = (label: string, root: DomElement = dom.window.document.body) => {
    const node = [...root.querySelectorAll<DomButton>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(node, `Missing button ${label}`); return node;
  };
  const click = async (label: string) => act(async () => { const node = button(label); node.focus(); node.click(); });
  const key = async (target: DomElement, key: string, options: { shiftKey?: boolean; isComposing?: boolean } = {}) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, ...options, bubbles: true, cancelable: true })); });
  const trigger = () => dom.container.querySelector<DomButton>(row ? ".profile-menu-trigger" : "button[data-open]")!;
  const search = () => raw()!.querySelector<DomInput>('input[role="combobox"]')!;
  const option = (label: string) => { const node = [...raw()!.querySelectorAll<DomElement>('[role="option"]')].find(item => item.querySelector("strong")?.textContent === label); assert.ok(node, `Missing option ${label}`); return node; };
  const open = async () => { await act(async () => { trigger().focus(); trigger().click(); }); assert.ok(active()); };
  const waitExit = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
  const system = async (value: boolean) => act(async () => { reduced = value; for (const change of [...listeners]) change(); });
  try {
    await render(); assert.equal(raw(), null, "Closed surfaces do not create a hidden portal");
    await open();
    if (scenario === "row-activation-exit") {
      assert.equal(dom.window.document.activeElement, button("Edit action"), "The first enabled action receives focus");
      await key(button("Edit action"), "ArrowUp"); assert.equal(dom.window.document.activeElement, button("Inspect action"));
      await key(button("Inspect action"), "Home"); assert.equal(dom.window.document.activeElement, button("Edit action"));
      await key(button("Edit action"), "End"); assert.equal(dom.window.document.activeElement, button("Inspect action"));
      await click("Disabled action"); assert.ok(active()); assert.deepEqual(actions, []);
      const item = button("Edit action");
      await act(async () => { item.click(); item.click(); });
      assert.deepEqual(actions, ["edit"], "A queued second click cannot execute another business action");
      assert.equal(active(), null); assert.ok(raw(), "A visual exit remains until the short transition finishes");
      assert.ok(raw()?.closest('[inert][aria-hidden="true"]')); assert.equal(trigger().getAttribute("aria-expanded"), "false"); assert.equal(trigger().getAttribute("aria-controls"), null);
      assert.equal(dom.window.document.activeElement, trigger(), "Focus returns before the visual exit finishes");
      await act(async () => { item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
      assert.deepEqual(actions, ["edit"]); await waitExit(); assert.equal(raw(), null);
    } else if (scenario === "row-reopen-position") {
      const panel = raw()!; assert.equal(panel.style.left, "308px"); assert.equal(panel.style.top, "130px");
      await key(button("Edit action"), "Escape"); assert.equal(active(), null); assert.equal(raw(), panel);
      anchor = { x: 700, y: 200 }; await render(2);
      assert.equal(panel.style.left, "308px", "A closing menu holds its last visible position");
      await open(); assert.equal(raw(), panel); assert.equal(panel.style.left, "508px"); assert.equal(panel.style.top, "230px");
      await key(button("Edit action"), "ArrowDown"); const focused = button("Inspect action"); assert.equal(dom.window.document.activeElement, focused);
      anchor = { x: 650, y: 210 }; await render(3);
      assert.equal(panel.style.left, "458px"); assert.equal(panel.style.top, "240px"); assert.equal(dom.window.document.activeElement, focused, "A roster update must not reset keyboard selection");
      await waitExit(); assert.equal(active(), panel, "An old exit timer must not remove a reopened menu");
      assert.equal(dom.window.document.querySelectorAll('.profile-actions-menu[role="menu"]').length, 1);
      await key(focused, "Tab"); assert.equal(active(), null); assert.equal(dom.window.document.activeElement, trigger());
    } else if (scenario === "row-outside-reduce") {
      const outside = dom.container.querySelector<DomInput>('input[aria-label="Outside input"]')!;
      await act(async () => { outside.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })); outside.focus(); });
      assert.equal(active(), null); assert.equal(dom.window.document.activeElement, outside, "Outside dismissal must not steal the clicked target's focus");
      await system(true); assert.equal(raw(), null, "Reduced motion finishes an existing visual exit immediately");
      await open(); await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); }); assert.equal(raw(), null);
      await open(); await act(async () => { dom.window.dispatchEvent(new dom.window.Event("scroll")); }); assert.equal(raw(), null);
      await system(false); await open(); await key(button("Edit action"), "Escape"); assert.ok(raw());
      await dom.unmount(); await waitExit(); assert.equal(raw(), null); assert.equal(listeners.size, 0, "Unmount owns all motion subscriptions and timers");
    } else if (scenario === "row-layout-focus") {
      const item = button("Inspect action"); item.focus();
      await act(async () => { raw()!.dispatchEvent(new dom.window.Event("scroll")); });
      assert.ok(active(), "Scrolling within a long menu must not dismiss it");
      assert.equal(dom.window.document.activeElement, item);
      await act(async () => { dom.window.dispatchEvent(new dom.window.Event("scroll")); });
      assert.equal(active(), null); assert.ok(raw(), "Full motion retains only the visual exit");
      assert.equal(dom.window.document.activeElement, trigger(), "Focus must leave the menu before it becomes inert");
      await waitExit(); assert.equal(raw(), null); assert.equal(dom.window.document.activeElement, trigger());
      await open();
      const outside = dom.container.querySelector<DomInput>('input[aria-label="Outside input"]')!; outside.focus();
      await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
      assert.equal(active(), null); assert.equal(dom.window.document.activeElement, outside, "Resize must not steal focus that already left the menu");
      await open();
      await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
      assert.equal(dom.window.document.activeElement, trigger());
    } else if (scenario === "palette-exit") {
      assert.equal(dom.window.document.activeElement, search()); const panel = raw()!, item = option("Create action");
      assert.equal(isShortcutTargetAllowed(null, dom.window.document as unknown as Document), false, "An interactive modal owns Ctrl+K");
      await click("Close command palette");
      assert.equal(closes, 1); assert.equal(active(), null); assert.equal(raw(), panel); assert.ok(panel.closest('[inert][aria-hidden="true"]'));
      assert.equal(dom.window.document.activeElement, trigger(), "Closing must restore focus immediately");
      assert.equal(isShortcutTargetAllowed(null, dom.window.document as unknown as Document), true, "The inert exit frame must not block reopening with Ctrl+K");
      await act(async () => { item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); }); assert.deepEqual(actions, []);
      const outside = dom.container.querySelector<DomInput>('input[aria-label="Outside input"]')!; outside.focus(); assert.equal(dom.window.document.activeElement, outside, "An exiting palette must not retain a focus trap");
      await waitExit(); assert.equal(raw(), null);
    } else if (scenario === "palette-reopen-keyboard") {
      const panel = raw()!;
      await act(async () => { const field = search(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "Refresh"); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
      assert.equal(raw()!.querySelectorAll('[role="option"]').length, 1);
      await click("Close command palette"); await open(); assert.equal(raw(), panel); assert.equal(search().value, ""); assert.equal(dom.window.document.activeElement, search());
      await waitExit(); assert.equal(active(), panel); assert.equal(dom.window.document.querySelectorAll('[data-command-palette="true"]').length, 1);
      await act(async () => { option("Disabled action").click(); }); assert.deepEqual(actions, []); assert.ok(active());
      await key(search(), "Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, button("Close command palette"));
      await key(button("Close command palette"), "Tab"); assert.equal(dom.window.document.activeElement, search());
      await key(search(), "Escape", { isComposing: true }); assert.ok(active(), "Composition must not accidentally dismiss the palette");
      await act(async () => { option("Failing action").click(); }); assert.ok(raw()!.querySelector('[role="alert"]')); assert.equal(dom.window.document.activeElement, search()); assert.equal(closes, 1);
      await key(search(), "Escape"); assert.equal(closes, 2); assert.equal(active(), null);
    } else if (scenario === "palette-execute-focus") {
      const field = search();
      await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      assert.deepEqual(actions, ["create"], "The command runs once immediately, without waiting for visual dismissal"); assert.equal(closes, 1); assert.equal(active(), null); assert.ok(raw());
      await open(); await act(async () => { option("Open report dialog").click(); });
      assert.deepEqual(actions, ["create", "report"]); assert.equal(active(), null); assert.ok(raw());
      assert.equal(dom.window.document.activeElement, button("Report action"), "Palette cleanup must not steal focus from a command's new dialog");
    } else if (scenario === "palette-reduced") {
      await click("Close command palette"); assert.ok(raw()); await system(true); assert.equal(raw(), null);
      await open(); await key(search(), "Escape"); assert.equal(raw(), null, "Reduced motion closes without a retained portal");
      await system(false); await open();
      const backdrop = raw()!.parentElement!;
      await act(async () => { backdrop.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })); }); assert.equal(active(), null); assert.ok(raw());
      await dom.unmount(); await waitExit(); assert.equal(raw(), null); assert.equal(listeners.size, 0);
    } else throw new Error(`Unknown scenario ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "row-activation-exit"); console.log("menu motion interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
