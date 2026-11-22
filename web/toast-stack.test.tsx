import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
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
    return <ToastStack toasts={api.toasts} onDismiss={api.dismissToast} />;
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
  test("SSR renders empty with no toasts and preserves .notice + role=status across all 4 semantic tones", () => {
    expect(
      renderToStaticMarkup(
        <I18nProvider>
          <ToastStack toasts={[]} onDismiss={() => {}} />
        </I18nProvider>,
      ),
    ).toBe("");

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
    expect(html).toContain('role="status"');
    expect(html).toContain("toast-item notice is-success");
    expect(html).toContain("toast-item notice is-info");
    expect(html).toContain("toast-item notice is-warn");
    expect(html).toContain("Copied code");
    expect(html).toContain('aria-label="Dismiss"');
  });

  test("caps stack at 3 visible toasts, evicts oldest, ignores blank text, and supports tone shorthands", () => {
    const mounted = mountToastHost({ defaultDurationMs: 0 }, "reduced");
    cleanup = mounted.restore;

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

    const statusNodes = mounted.container.querySelectorAll('.notice[role="status"]');
    expect(statusNodes).toHaveLength(3);
  });

  test("auto-dismisses after duration and pauses countdown on pointer hover, resuming on leave", async () => {
    const mounted = mountToastHost({ defaultDurationMs: 120 }, "reduced");
    cleanup = mounted.restore;

    act(() => {
      mounted.getApi().pushToast("Copied to clipboard", { tone: "success", durationMs: 120 });
    });

    const toastEl = mounted.container.querySelector<HTMLElement>('.notice[role="status"]');
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
    expect(mounted.container.querySelector('.notice[role="status"]')).toBeNull();
  });

  test("keyboard focus inside a toast pauses auto-dismiss until blur", async () => {
    const mounted = mountToastHost({ defaultDurationMs: 120 }, "reduced");
    cleanup = mounted.restore;

    act(() => {
      mounted.getApi().pushToast("Focus pause test", { tone: "info", durationMs: 120 });
    });

    const toastEl = mounted.container.querySelector<HTMLElement>('.notice[role="status"]')!;
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

    // Live toast list is empty immediately, exiting DOM is inert & has no role="status"
    expect(fullMounted.getApi().toasts).toHaveLength(0);
    expect(fullMounted.container.querySelector('[role="status"]')).toBeNull();
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
