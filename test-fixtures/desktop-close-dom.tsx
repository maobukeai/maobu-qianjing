import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLElement, HTMLInputElement } from "happy-dom";
import { createNativeDesktopCloseAdapter, DesktopCloseHost, DesktopCloseRegistryProvider, useDesktopCloseDraft, useDesktopCloseRegistry } from "../web/desktop-close.tsx";
import type { DesktopCloseIntent, DesktopCloseNative, DesktopCloseRegistry, DesktopCloseResolved, DesktopCloseResolution } from "../web/desktop-close-state.ts";
import { useDesktopMotion } from "../web/desktop-motion.tsx";
import { useUnsavedChangesGuard } from "../web/unsaved-changes-guard.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";
const sessionId = "a".repeat(64), requestId = "b".repeat(64);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function run(scenario: string) {
  const dom = await createWebDomHarness();
  dom.window.matchMedia = (() => ({ matches: scenario === "reduced", addEventListener() {}, removeEventListener() {} })) as any;
  let onIntent!: (value: DesktopCloseIntent) => void, onResolved!: (value: DesktopCloseResolved) => void;
  const calls: string[] = [], unregister: string[] = [];
  let native: DesktopCloseNative = {
    listenIntent: async callback => { onIntent = callback; return () => { calls.push("unlisten-intent"); }; },
    listenResolved: async callback => { onResolved = callback; return () => { calls.push("unlisten-resolved"); }; },
    register: async () => ({ sessionId }),
    unregister: async value => { unregister.push(value); },
    resolve: async (_value, decision) => { calls.push(decision); return decision === "hold" ? "holding" : decision === "cancel" ? "cancelled" : "continuing"; },
  };
  if (scenario === "broken-metadata") {
    (dom.window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async () => { throw new Error("PRIVATE_BROKEN_BRIDGE"); } };
    native = createNativeDesktopCloseAdapter()!; assert.ok(native);
  }
  if (scenario === "connection-error") native.listenResolved = async () => { throw new Error("PRIVATE_NATIVE_STACK"); };
  let registry!: DesktopCloseRegistry, setValue!: (value: string) => void;
  let pageGuard!: ReturnType<typeof useUnsavedChangesGuard>;
  function Child({ active }: { active: boolean }) { useDesktopCloseDraft("sync-settings", { dirty: true, busy: false, active }); return null; }
  function Shell({ busy = false, active = true, child = false }: { busy?: boolean; active?: boolean; child?: boolean }) {
    useDesktopMotion(); registry = useDesktopCloseRegistry();
    const [value, update] = useState("baseline"); setValue = update;
    useDesktopCloseDraft("profile-edit", { dirty: value !== "baseline", busy, active }, registry);
    pageGuard = useUnsavedChangesGuard({ label: "Edit profile" });
    return <DesktopCloseRegistryProvider registry={registry}><DesktopCloseHost registry={registry} native={native} returnFocus={() => dom.container.querySelector("[data-editor]") as unknown as globalThis.HTMLElement} />
      <section data-editor tabIndex={-1}><input aria-label="Private form input" value={value} onChange={event => update(event.target.value)} /><input type="password" defaultValue="PRIVATE_PASSWORD_VALUE" /><button type="button" data-outside>Outside</button></section>
      {child && <Child active={active} />}{pageGuard.dialog}</DesktopCloseRegistryProvider>;
  }
  const render = (props: { busy?: boolean; active?: boolean; child?: boolean } = {}) => dom.render(<I18nProvider><Shell {...props} /></I18nProvider>);
  const input = () => dom.container.querySelector<HTMLInputElement>("input")!;
  const activeDialog = () => [...dom.window.document.querySelectorAll<HTMLElement>('.desktop-close-dialog[role="alertdialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]'));
  const button = (text: string) => { const node = [...activeDialog()!.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text); assert.ok(node, `Missing ${text}`); return node; };
  const request = (deliveryId = 1) => act(async () => { onIntent({ sessionId, requestId, deliveryId }); });
  const resolved = (value: Partial<DesktopCloseResolved> = {}) => act(async () => { onResolved({ sessionId, requestId, outcome: "cancelled", ...value }); });
  const click = (text: string, twice = false) => act(async () => { const node = button(text); node.click(); if (twice) node.click(); });
  const key = (value: string, options = {}) => act(async () => { (dom.window.document.activeElement ?? dom.window.document.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })); });
  try {
    await render(); await dom.flush(); input().focus();
    if (scenario === "connection-error" || scenario === "broken-metadata") { assert.ok(dom.container.querySelector('[role="alert"]')); assert.ok(!dom.window.document.body.textContent.includes("PRIVATE_NATIVE_STACK")); assert.ok(!dom.window.document.body.textContent.includes("PRIVATE_BROKEN_BRIDGE")); return; }
    if (scenario === "clean") {
      await request(); assert.deepEqual(calls, ["proceed"]); assert.ok(activeDialog()?.textContent?.includes("Waiting for the desktop"));
      assert.equal(input().value, "baseline"); await resolved(); assert.equal(activeDialog(), undefined); assert.equal(dom.window.document.activeElement, input()); return;
    }
    await act(async () => setValue("INVALID_PRIVATE_DRAFT"));
    if (scenario === "busy") {
      await render({ busy: true }); await request(); assert.deepEqual(calls, ["hold"]);
      assert.ok(activeDialog()?.textContent?.includes("A change is still in progress")); assert.equal(activeDialog()?.querySelectorAll("button").length, 1);
      await render({ busy: false }); assert.deepEqual(calls, ["hold"], "Finishing a save must not auto-close");
      await click("Keep editing"); assert.equal(input().value, "INVALID_PRIVATE_DRAFT"); return;
    }
    if (scenario === "nested-guard") {
      await act(async () => { pageGuard.requestClose({ dirty: true, onDiscard() { throw new Error("Must not discard page while closing app"); } }); });
      const lower = dom.window.document.querySelector<HTMLElement>(".unsaved-changes-guard")!; assert.ok(lower);
      await request(); await key("Escape"); assert.equal(activeDialog(), undefined); assert.equal(pageGuard.pending, true, "App close Escape must not close the page guard");
      assert.ok(lower.isConnected); assert.equal(dom.window.document.activeElement, lower.querySelector("button"), "Return to the original page confirmation without discarding it"); return;
    }
    let preexisting: HTMLElement | null = null;
    if (scenario === "inert-restoration") { preexisting = dom.window.document.createElement("div"); preexisting.setAttribute("inert", ""); preexisting.setAttribute("aria-hidden", "true"); dom.window.document.body.append(preexisting); }
    await request(); assert.ok(activeDialog()); assert.equal(dom.window.document.activeElement, button("Keep editing"));
    assert.ok(dom.container.hasAttribute("inert")); assert.equal(dom.container.getAttribute("aria-hidden"), "true");
    assert.ok(!activeDialog()!.outerHTML.includes("INVALID_PRIVATE_DRAFT")); assert.ok(!activeDialog()!.outerHTML.includes("PRIVATE_PASSWORD_VALUE"));
    if (scenario === "keyboard") {
      await key("Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, button("Discard and close app"));
      await key("Tab"); assert.equal(dom.window.document.activeElement, button("Keep editing"));
      await key("Escape", { isComposing: true }); assert.ok(activeDialog()); assert.deepEqual(calls, ["hold"]);
      await key("Escape"); assert.equal(activeDialog(), undefined); assert.equal(dom.window.document.activeElement, input());
      await key("Escape", { repeat: true }); assert.equal(pageGuard.pending, false); return;
    }
    if (scenario === "discard-native-cancel") {
      await click("Discard and close app", true); assert.deepEqual(calls, ["hold", "proceed"]);
      assert.ok(activeDialog()?.textContent?.includes("Waiting for the desktop")); assert.equal(input().value, "INVALID_PRIVATE_DRAFT");
      await resolved(); assert.equal(activeDialog(), undefined); assert.equal(input().value, "INVALID_PRIVATE_DRAFT"); assert.equal(dom.window.document.activeElement, input()); return;
    }
    if (scenario === "late-cancel") {
      const pending = deferred<DesktopCloseResolution>(); native.resolve = async (_value, decision) => { calls.push(decision); return pending.promise; };
      await act(async () => { button("Keep editing").click(); }); await resolved(); pending.resolve("cancelled"); await dom.flush();
      assert.equal(activeDialog(), undefined); assert.equal(input().value, "INVALID_PRIVATE_DRAFT"); return;
    }
    if (scenario === "cancel-rejection") {
      native.resolve = async () => { throw new Error("PRIVATE_NATIVE_ERROR"); };
      await click("Keep editing");
      assert.ok(activeDialog()?.textContent?.includes("Your draft has not been cleared"));
      assert.ok(!activeDialog()?.textContent?.includes("PRIVATE_NATIVE_ERROR"));
      assert.ok(dom.container.hasAttribute("inert")); assert.equal(input().value, "INVALID_PRIVATE_DRAFT");
      await resolved(); assert.equal(activeDialog(), undefined); assert.equal(dom.window.document.activeElement, input()); return;
    }
    if (scenario === "unmount") {
      const stale = button("Discard and close app"); await dom.unmount(); stale.click();
      assert.deepEqual(calls, ["hold", "unlisten-intent", "unlisten-resolved"]); assert.deepEqual(unregister, [sessionId]);
      assert.ok(!dom.container.hasAttribute("inert")); return;
    }
    if (scenario === "owner-isolation") {
      await click("Keep editing"); await render({ active: false, child: true });
      assert.deepEqual(registry.getSnapshot().dirty, []);
      await request(2); assert.equal(calls.at(-1), "proceed"); return;
    }
    const retainedDiscard = scenario === "exit-inert" ? button("Discard and close app") : null;
    await click("Keep editing"); assert.equal(activeDialog(), undefined); assert.equal(input().value, "INVALID_PRIVATE_DRAFT");
    assert.ok(!dom.container.hasAttribute("inert")); assert.equal(dom.container.getAttribute("aria-hidden"), null); assert.equal(dom.window.document.activeElement, input());
    if (scenario === "inert-restoration") { assert.ok(preexisting!.hasAttribute("inert")); assert.equal(preexisting!.getAttribute("aria-hidden"), "true"); preexisting!.remove(); }
    if (scenario === "reduced") assert.equal(dom.window.document.querySelector('.desktop-motion-presence[data-motion-phase="exiting"]'), null);
    if (scenario === "exit-inert") {
      const retained = dom.window.document.querySelector<HTMLElement>('.desktop-close-layer .desktop-motion-presence[data-motion-phase="exiting"]');
      assert.ok(retained?.hasAttribute("inert")); assert.equal(retained?.getAttribute("aria-hidden"), "true");
      await act(async () => retainedDiscard!.click()); assert.deepEqual(calls, ["hold", "cancel"]);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      assert.equal(dom.window.document.querySelector('.desktop-close-layer .desktop-motion-presence'), null);
    }
  } finally { await dom.cleanup(); }
}
await run(process.argv[2] ?? "dirty-keep");
console.log("desktop close DOM passed");
