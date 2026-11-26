import { afterEach, describe, expect, test } from "bun:test";
import { Window, type HTMLButtonElement as HappyButton } from "happy-dom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ToastStack,
  useToastStack,
  type ToastItem,
  type UseToastStackOptions,
  type UseToastStackResult,
} from "./components/toast-stack.tsx";
import { I18nProvider } from "./i18n.tsx";

interface MountedToastHost {
  dom: Window;
  container: HTMLElement;
  getApi: () => UseToastStackResult;
  restore: () => Promise<void>;
}

function mountToastHost(
  options: UseToastStackOptions = {},
  motionMode: "full" | "reduced" = "full",
): MountedToastHost {
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
  setGlobal("FocusEvent", dom.FocusEvent);
  setGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
  setGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const htmlContainer = container as unknown as HTMLElement;
  const root: Root = createRoot(htmlContainer);

  let latestApi!: UseToastStackResult;
  function Harness() {
    const api = useToastStack(options);
    latestApi = api;
    return <><button type="button" id="toast-origin">Workspace action</button><ToastStack toasts={api.toasts} onDismiss={api.dismissToast} /></>;
  }

  act(() => {
    root.render(
      <I18nProvider>
        <Harness />
      </I18nProvider>,
    );
  });

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

  return { dom, container: htmlContainer, getApi: () => latestApi, restore };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

describe("ToastStack & useToastStack", () => {
  test("SSR has one persistent announcement region and no visual stack before the first notice", () => {
    const empty = renderToStaticMarkup(
      <I18nProvider>
        <ToastStack toasts={[]} onDismiss={() => {}} />
      </I18nProvider>,
    );
    expect(empty).toContain('class="sr-only toast-announcements" role="status"');
    expect(empty).not.toContain('class="toast-stack"');

    const sample: ToastItem[] = [
      { id: "t1", message: "Copied code", tone: "success", durationMs: 4000, createdAt: 1 },
      { id: "t2", message: "Background sync started", tone: "info", durationMs: 4000, createdAt: 2 },
      { id: "t3", message: "Proxy latency high", tone: "warn", durationMs: 4000, createdAt: 3 },
    ];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ToastStack toasts={sample} onDismiss={() => {}} />
      </I18nProvider>,
    );
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("toast-item notice is-success");
    expect(html).toContain("toast-item notice is-info");
    expect(html).toContain("toast-item notice is-warn");
    expect(html).toContain("Copied code");
    expect(html).toContain('aria-label="Dismiss"');
  });

  test("caps stack at 3 visible toasts, evicts oldest, ignores blank text, and supports tone shorthands", () => {
    const mounted = mountToastHost({ defaultDurationMs: 0 }, "reduced");
    cleanup = mounted.restore;
    const announcements = mounted.container.querySelector('.toast-announcements[role="status"]');
    expect(announcements).toBeTruthy();

    act(() => {
      expect(mounted.getApi().pushToast("   ")).toBe("");
      mounted.getApi().pushToast("First notice");
      mounted.getApi().pushToast("Second info", "info");
      mounted.getApi().pushToast("Third warning", "warn");
      mounted.getApi().pushToast("Fourth error", "error");
    });

    const active = mounted.getApi().toasts;
    expect(active).toHaveLength(3);
    expect(active.map((t) => [t.message, t.tone])).toEqual([
      ["Second info", "info"],
      ["Third warning", "warn"],
      ["Fourth error", "error"],
    ]);

    expect(mounted.container.querySelector('.toast-announcements[role="status"]')).toBe(announcements);
    expect(announcements?.children).toHaveLength(3);
    expect(mounted.container.querySelectorAll(".toast-item")).toHaveLength(3);
    const dismiss = mounted.container.querySelector(".toast-dismiss");
    const described = mounted.dom.document.getElementById(dismiss!.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe("Second info");
  });

  test("auto-dismisses after duration and pauses countdown on pointer hover, resuming on leave", async () => {
    const mounted = mountToastHost({ defaultDurationMs: 120 }, "reduced");
    cleanup = mounted.restore;

    act(() => {
      mounted.getApi().pushToast("Copied to clipboard", { tone: "success", durationMs: 120 });
    });

    const toastEl = mounted.container.querySelector<HTMLElement>(".toast-item");
    expect(toastEl).toBeTruthy();

    // Hover immediately (commit pause state first) -> timer pauses past durationMs
    act(() => {
      toastEl!.dispatchEvent(new mounted.dom.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
    });
    expect(toastEl!.dataset.paused).toBe("true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(mounted.getApi().toasts).toHaveLength(1);

    // Leave hover -> resumes remaining countdown and dismisses
    act(() => {
      toastEl!.dispatchEvent(new mounted.dom.MouseEvent("mouseout", { bubbles: true }) as unknown as Event);
    });
    expect(toastEl!.dataset.paused).toBeUndefined();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 190));
    });
    expect(mounted.getApi().toasts).toHaveLength(0);
    expect(mounted.container.querySelector(".toast-item")).toBeNull();
  });

  test("keyboard focus inside a toast pauses auto-dismiss until blur", async () => {
    const mounted = mountToastHost({ defaultDurationMs: 120 }, "reduced");
    cleanup = mounted.restore;

    act(() => {
      mounted.getApi().pushToast("Focus pause test", { tone: "info", durationMs: 120 });
    });

    const toastEl = mounted.container.querySelector<HTMLElement>(".toast-item")!;
    const dismissBtn = toastEl.querySelector<HTMLButtonElement>(".toast-dismiss")!;

    act(() => {
      dismissBtn.focus();
      dismissBtn.dispatchEvent(new mounted.dom.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    });
    expect(toastEl.dataset.paused).toBe("true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(mounted.getApi().toasts).toHaveLength(1);

    act(() => {
      dismissBtn.dispatchEvent(new mounted.dom.FocusEvent("focusout", { bubbles: true, relatedTarget: null }) as unknown as Event);
    });
    expect(toastEl.dataset.paused).toBeUndefined();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 190));
    });
    expect(mounted.getApi().toasts).toHaveLength(0);
  });

  test("backgrounded pages keep notices until their remaining visible time elapses", async () => {
    const mounted = mountToastHost({ defaultDurationMs: 120 }, "reduced");
    cleanup = mounted.restore;
    const setHidden = (hidden: boolean) => act(() => {
      Object.defineProperty(mounted.dom.document, "hidden", { configurable: true, value: hidden });
      mounted.dom.document.dispatchEvent(new mounted.dom.Event("visibilitychange"));
    });
    act(() => { mounted.getApi().pushToast("Completed while away", "success"); });
    setHidden(true);
    expect(mounted.container.querySelector<HTMLElement>(".toast-item")?.dataset.paused).toBe("true");
    await act(async () => { await Bun.sleep(180); });
    expect(mounted.getApi().toasts).toHaveLength(1);

    setHidden(false);
    expect(mounted.container.querySelector<HTMLElement>(".toast-item")?.dataset.paused).toBeUndefined();
    await act(async () => { await Bun.sleep(190); });
    expect(mounted.getApi().toasts).toHaveLength(0);
  });

  test("closing a focused toast transfers focus to a remaining toast and then the original control", () => {
    const mounted = mountToastHost({ defaultDurationMs: 0 }, "reduced");
    cleanup = mounted.restore;
    const doc = mounted.dom.document;
    const origin = doc.querySelector<HappyButton>("#toast-origin")!;
    act(() => {
      mounted.getApi().pushToast("First notice", { id: "one" });
      mounted.getApi().pushToast("Next notice", { id: "two" });
    });
    const first = doc.querySelector<HappyButton>('[data-toast-id="one"] .toast-dismiss')!;
    const next = doc.querySelector<HappyButton>('[data-toast-id="two"] .toast-dismiss')!;
    act(() => { origin.focus(); first.focus(); first.click(); });
    expect(doc.activeElement).toBe(next);
    act(() => { next.click(); });
    expect(doc.activeElement).toBe(origin);
  });

  test("manual dismiss animates 120ms inert exit in full motion and removes immediately in reduced motion", async () => {
    const fullMounted = mountToastHost({ defaultDurationMs: 0 }, "full");
    cleanup = fullMounted.restore;

    act(() => {
      fullMounted.getApi().pushToast("Saved profile", "success");
    });

    const dismissBtn = fullMounted.container.querySelector<HTMLButtonElement>(".toast-dismiss")!;
    act(() => {
      dismissBtn.click();
    });

    // The notice leaves the announceable list before its inert visual exit.
    expect(fullMounted.getApi().toasts).toHaveLength(0);
    expect(fullMounted.container.querySelector('.toast-announcements[role="status"]')?.textContent).toBe("");
    const exiting = fullMounted.container.querySelector<HTMLElement>('[data-motion-phase="exiting"]');
    expect(exiting).toBeTruthy();
    expect(exiting?.getAttribute("aria-hidden")).toBe("true");
    expect(exiting?.hasAttribute("inert")).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 170));
    });
    expect(fullMounted.container.querySelector(".toast-stack")).toBeNull();

    await fullMounted.restore();
    cleanup = null;

    const reducedMounted = mountToastHost({ defaultDurationMs: 0 }, "reduced");
    cleanup = reducedMounted.restore;
    act(() => {
      reducedMounted.getApi().pushToast("Instant exit", "info");
    });
    expect(reducedMounted.container.querySelector<HTMLElement>(".toast-item")?.dataset.motionPhase).toBe("present");
    act(() => {
      reducedMounted.container.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
    });
    expect(reducedMounted.container.querySelector(".toast-stack")).toBeNull();
  });
});
