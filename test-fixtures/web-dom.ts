/** DOM interaction fixtures run in their own Bun process, never in the main test process. */
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

export async function createWebDomHarness(options: { desktop?: boolean; fetch?: typeof fetch } = {}) {
  const window = new Window({ url: "http://127.0.0.1:47865/ui/" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function expose(name: string, value: unknown) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  for (const [name, value] of Object.entries({
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Event: window.Event, MouseEvent: window.MouseEvent, MutationObserver: window.MutationObserver,
    isTauri: options.desktop === true, IS_REACT_ACT_ENVIRONMENT: true,
  })) expose(name, value);
  window.localStorage.setItem("aliasmode.shell.language", "en-US");
  expose("fetch", options.fetch ?? Object.assign(async (input: RequestInfo | URL) => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    throw new Error(`Unexpected fixture request: ${String(input)}`);
  }, { preconnect: originalFetch.preconnect }));
  // Import after exposing the DOM so React's browser capability checks see this window.
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  let root: Root | null = null;
  async function render(node: ReactNode) {
    root ??= createRoot(container as unknown as HTMLElement);
    await act(async () => { root!.render(node); });
  }
  async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function unmount() {
    if (!root) return;
    await act(async () => { root!.unmount(); }); root = null;
  }
  async function cleanup() {
    try { await unmount(); await window.happyDOM.close(); }
    finally {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
  return { window, container, render, flush, unmount, cleanup };
}
