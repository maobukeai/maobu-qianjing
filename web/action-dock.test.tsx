import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionDock, type ActionDockProps } from "./components/action-dock.tsx";
import { I18nProvider } from "./i18n.tsx";

interface MountedDock {
  dom: Window;
  container: HTMLElement;
  rerender: (props: ActionDockProps) => void;
  restore: () => Promise<void>;
}

function makeProps(overrides: Partial<ActionDockProps> = {}): ActionDockProps {
  return {
    selectedCount: 3,
    totalFilteredCount: 25,
    allFilteredSelected: false,
    selectedOutsideFilter: 0,
    selectionScope: "25 environments",
    deleting: false,
    busy: false,
    blockedMessage: null,
    onSelectAllFiltered: () => {},
    onClear: () => {},
    onStart: () => {},
    onStop: () => {},
    ...overrides,
  };
}

function mountDock(initialProps: ActionDockProps, motionMode: "full" | "reduced" = "full"): MountedDock {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  dom.document.documentElement.dataset.desktopMotion = motionMode;
  dom.matchMedia = (() => ({
    matches: motionMode === "reduced",
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof dom.matchMedia;

  const prev = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  setGlobal("window", dom);
  setGlobal("document", dom.document);
  setGlobal("navigator", dom.navigator);
  setGlobal("localStorage", dom.localStorage);
  setGlobal("HTMLElement", dom.HTMLElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
  setGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const htmlContainer = container as unknown as HTMLElement;
  const root: Root = createRoot(htmlContainer);

  const renderTree = (props: ActionDockProps) => {
    act(() => {
      root.render(
        <I18nProvider>
          <ActionDock {...props} />
        </I18nProvider>,
      );
    });
  };
  renderTree(initialProps);

  const restore = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [key, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
  };

  return { dom, container: htmlContainer, rerender: renderTree, restore };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

describe("ActionDock", () => {
  test("SSR renders empty when nothing is selected and exposes required toolbar & selcount hooks when active", () => {
    const empty = renderToStaticMarkup(
      <I18nProvider>
        <ActionDock {...makeProps({ selectedCount: 0 })} />
      </I18nProvider>,
    );
    expect(empty).toBe("");

    const active = renderToStaticMarkup(
      <I18nProvider>
        <ActionDock
          {...makeProps({
            selectedCount: 4,
            selectedOutsideFilter: 2,
            children: <button type="button">Move</button>,
          })}
        />
      </I18nProvider>,
    );
    expect(active).toContain('class="action-dock-bar toolbar active"');
    expect(active).toContain('class="selcount"');
    expect(active).toContain("4 selected");
    expect(active).toContain("Clear selection");
    expect(active).toContain("Start");
    expect(active).toContain("Stop");
    expect(active).toContain("More actions");
    expect(active).toContain("excluding 2 outside this view");
  });

  test("preserves .toolbar.active > button Start/Stop contract, triggers callbacks, and toggles secondary tray", () => {
    const events: string[] = [];
    const mounted = mountDock(
      makeProps({
        selectedCount: 2,
        onSelectAllFiltered: () => events.push("selectAll"),
        onClear: () => events.push("clear"),
        onStart: () => events.push("start"),
        onStop: () => events.push("stop"),
        children: (
          <button type="button" data-secondary onClick={() => events.push("secondary")}>
            Export
          </button>
        ),
      }),
    );
    cleanup = mounted.restore;

    const directButtons = [...mounted.container.querySelectorAll<HTMLButtonElement>(".toolbar.active > button")];
    const startBtn = directButtons.find((btn) => btn.textContent?.trim() === "Start");
    const stopBtn = directButtons.find((btn) => btn.textContent?.trim() === "Stop");
    const clearBtn = directButtons.find((btn) => btn.textContent?.trim() === "Clear selection");
    const moreBtn = directButtons.find((btn) => btn.textContent?.trim() === "More actions");
    expect(startBtn).toBeTruthy();
    expect(stopBtn).toBeTruthy();
    expect(clearBtn).toBeTruthy();
    expect(moreBtn).toBeTruthy();

    const tray = mounted.container.querySelector<HTMLElement>(".bulk-advanced");
    expect(tray?.hidden).toBe(true);

    act(() => {
      startBtn!.click();
      stopBtn!.click();
      clearBtn!.click();
      mounted.container.querySelector<HTMLButtonElement>(".action-dock-scope-btn")!.click();
      moreBtn!.click();
    });
    expect(events).toEqual(["start", "stop", "clear", "selectAll"]);
    expect(tray?.hidden).toBe(false);
    expect(moreBtn?.getAttribute("aria-expanded")).toBe("true");
    expect(moreBtn?.textContent?.trim()).toBe("Fewer actions");

    act(() => {
      mounted.container.querySelector<HTMLButtonElement>("[data-secondary]")!.click();
    });
    expect(events).toEqual(["start", "stop", "clear", "selectAll", "secondary"]);
  });

  test("disables Start/Stop when busy, deleting, or blockedMessage is active", () => {
    const mounted = mountDock(
      makeProps({
        selectedCount: 5,
        blockedMessage: "Workspace backup in progress",
        allFilteredSelected: true,
      }),
    );
    cleanup = mounted.restore;

    const buttons = [...mounted.container.querySelectorAll<HTMLButtonElement>(".toolbar.active > button")];
    const startBtn = buttons.find((btn) => btn.textContent?.trim() === "Start")!;
    const stopBtn = buttons.find((btn) => btn.textContent?.trim() === "Stop")!;
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(true);
    expect(startBtn.dataset.tip).toBe("Workspace backup in progress");
    expect(stopBtn.dataset.tip).toBe("Workspace backup in progress");

    const scopeBtn = mounted.container.querySelector<HTMLButtonElement>(".action-dock-scope-btn")!;
    expect(scopeBtn.disabled).toBe(true);
    expect(scopeBtn.textContent).toContain("All 25 environments selected");
  });

  test("full motion retains exiting dock for 120ms while clearing live .selcount immediately, and reopens cleanly", async () => {
    const base = makeProps({ selectedCount: 3 });
    const mounted = mountDock(base, "full");
    cleanup = mounted.restore;

    expect(mounted.container.querySelector(".selcount")?.textContent).toContain("3 selected");
    const presence = () => mounted.container.querySelector<HTMLElement>(".desktop-motion-presence");
    expect(presence()?.dataset.motionKind).toBe("panel");

    // Deselect -> entering exit phase: inert + hidden, live .selcount gone immediately
    mounted.rerender(makeProps({ selectedCount: 0 }));
    expect(presence()?.dataset.motionPhase).toBe("exiting");
    expect(presence()?.getAttribute("aria-hidden")).toBe("true");
    expect(presence()?.hasAttribute("inert")).toBe(true);
    expect(mounted.container.querySelector(".selcount")).toBeNull();

    // Re-select before 120ms expires -> restores live .selcount without stale timer closing it
    mounted.rerender(makeProps({ selectedCount: 2 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });
    expect(presence()).toBeTruthy();
    expect(presence()?.getAttribute("aria-hidden")).toBeNull();
    expect(mounted.container.querySelector(".selcount")?.textContent).toContain("2 selected");

    // Final deselect -> fully unmounted after 120ms
    mounted.rerender(makeProps({ selectedCount: 0 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });
    expect(presence()).toBeNull();
  });

  test("reduced motion unmounts immediately without 120ms exit delay", () => {
    const mounted = mountDock(makeProps({ selectedCount: 1 }), "reduced");
    cleanup = mounted.restore;

    expect(mounted.container.querySelector<HTMLElement>(".desktop-motion-presence")?.dataset.motionPhase).toBe("present");
    mounted.rerender(makeProps({ selectedCount: 0 }));
    expect(mounted.container.querySelector(".desktop-motion-presence")).toBeNull();
    expect(mounted.container.querySelector(".selcount")).toBeNull();
  });
});
