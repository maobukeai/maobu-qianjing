import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, KeyboardEvent } from "happy-dom";
import { MotionPresence } from "../web/desktop-motion.tsx";
import { EditorWindowControls } from "../web/editor-window-controls.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import type { WindowChrome } from "../web/window-chrome.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const calls: string[] = [];
  const chrome: WindowChrome = {
    enabled: true, focused: true, maximized: false, busy: false, error: null,
    onMouseDown() {}, dismissError() {},
    async minimize() { calls.push("minimize"); },
    async toggleMaximize() { calls.push("toggleMaximize"); },
    async close() { calls.push("close"); },
  };
  const render = ({ open = true, disabled = false, change = {} }: {
    open?: boolean; disabled?: boolean; change?: Partial<WindowChrome>;
  } = {}) => dom.render(<I18nProvider><MotionPresence present={open}>
    <section role="dialog" aria-label="Synthetic editor">
      <div className="modal-head">
        <EditorWindowControls chrome={{ ...chrome, ...change }} disabled={disabled} />
        <button className="modal-close" type="button" aria-label="Close editor" onClick={() => calls.push("editor-close")} />
      </div>
      <input aria-label="Draft" defaultValue="Synthetic draft" />
    </section>
  </MotionPresence></I18nProvider>);
  const button = (label: string) => dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const trigger = () => button("Window controls")!;
  const draft = () => dom.container.querySelector<HTMLInputElement>("input")!;
  const click = (target: HTMLButtonElement) => act(async () => { target.focus(); target.click(); });
  const dispatchEscape = (target: HTMLButtonElement, type = "keydown", repeat = false) => {
    const event = new dom.window.KeyboardEvent(type, { key: "Escape", repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  try {
    if (scenario === "reduced-and-web") {
      dom.window.document.documentElement.dataset.desktopMotion = "reduced";
      await render({ change: { enabled: false } });
      assert.equal(button("Window controls"), null);
      await render();
      await click(trigger());
      const group = button("Minimize window");
      assert.ok(group);
      await click(trigger());
      assert.equal(button("Minimize window"), null, "Reduced motion removes the collapsed panel immediately");
      return;
    }

    await render();
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.ok(dom.window.document.getElementById(trigger().getAttribute("aria-controls")!));
    assert.equal(button("Minimize window"), null);
    await click(trigger());
    assert.equal(trigger().getAttribute("aria-expanded"), "true");

    if (scenario === "actions") {
      assert.ok(button("Minimize window"));
      assert.ok(button("Maximize window"));
      assert.ok(button("Close window"));
      const closeWindow = button("Close window")!;
      await act(async () => { closeWindow.focus(); closeWindow.click(); closeWindow.click(); });
      assert.deepEqual(calls, ["close"], "Native close must be routed once through the shared chrome owner");
      assert.ok(dom.window.document.activeElement === trigger(), "A native close confirmation must have a mounted return-focus control");
      assert.equal(trigger().getAttribute("aria-expanded"), "false");
      await render({ change: { maximized: true } });
      await click(trigger());
      assert.ok(button("Restore window"));
      await click(button("Restore window")!);
      await click(trigger());
      await click(button("Minimize window")!);
      await click(button("Close editor")!);
      assert.deepEqual(calls, ["close", "toggleMaximize", "minimize", "editor-close"]);
      assert.equal(draft().value, "Synthetic draft");
      return;
    }

    if (scenario === "escape-and-focus") {
      let editorEscapes = 0;
      dom.window.document.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key === "Escape" && !event.defaultPrevented) editorEscapes++;
      });
      const maximize = button("Maximize window")!;
      await act(async () => {
        maximize.focus();
        assert.equal(dispatchEscape(maximize), true);
        assert.equal(dispatchEscape(trigger(), "keydown", true), true);
      });
      assert.equal(editorEscapes, 0, "Escape closes the disclosure without also closing the editor");
      assert.ok(dom.window.document.activeElement === trigger());
      await act(async () => { dispatchEscape(trigger(), "keyup"); dispatchEscape(trigger()); });
      assert.equal(editorEscapes, 1, "The next Escape goes to the editor");
      await click(trigger());
      await act(async () => draft().focus());
      assert.equal(trigger().getAttribute("aria-expanded"), "false", "Leaving the controls by keyboard collapses the disclosure");
      assert.ok(dom.window.document.activeElement === draft());
      assert.deepEqual(calls, []);
      return;
    }

    await render({ change: { busy: true } });
    assert.ok(button("Close window")?.disabled, "Chrome busy is reflected on the reused native buttons");
    await act(async () => button("Close window")!.click());
    await render({ disabled: true });
    assert.ok(trigger().disabled);
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    const retained = button("Close window");
    if (retained) {
      assert.ok(retained.closest('[inert][aria-hidden="true"]'));
      await act(async () => retained.click());
    }
    await render();
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    await click(trigger());
    await render({ open: false });
    const exiting = button("Close window");
    assert.ok(exiting?.closest('[inert][aria-hidden="true"]'), "The editor's visual exit makes all native actions inert");
    await act(async () => exiting?.click());
    assert.deepEqual(calls, []);
  } finally {
    await dom.cleanup();
  }
}

await run(process.argv[2] ?? "actions");
console.log("editor window controls DOM passed");
