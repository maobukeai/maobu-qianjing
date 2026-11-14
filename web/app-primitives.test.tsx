import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiProfile } from "./api.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { useProfileMetrics } from "./hooks/use-profile-selection.ts";
import { useRosterPolling } from "./hooks/use-roster-polling.ts";
import { I18nProvider } from "./i18n.tsx";
import { ConfirmDialog, ModalDialog, Pagination, useConfirmDialog } from "./ui-primitives.tsx";

const realFetch = globalThis.fetch;

interface InstalledDom {
  dom: Window;
  container: HTMLElement;
  root: Root;
  restore: () => Promise<void>;
}

function mountWithDom(element: React.ReactElement): InstalledDom {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;
  const prevLocalStorage = globalThis.localStorage;
  const prevHtmlElement = globalThis.HTMLElement;
  const prevEvent = globalThis.Event;
  const prevCustomEvent = globalThis.CustomEvent;
  const prevKeyboardEvent = globalThis.KeyboardEvent;
  const prevActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.navigator });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.localStorage });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.Event });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.CustomEvent });
  Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, value: dom.KeyboardEvent });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const htmlContainer = container as unknown as HTMLElement;
  const root = createRoot(htmlContainer);

  act(() => {
    root.render(<I18nProvider>{element}</I18nProvider>);
  });

  const restore = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await dom.happyDOM.waitUntilComplete();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await dom.close();
    const restoreProp = (key: string, val: unknown) => {
      if (val === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: val });
    };
    restoreProp("window", prevWindow);
    restoreProp("document", prevDocument);
    restoreProp("navigator", prevNavigator);
    restoreProp("localStorage", prevLocalStorage);
    restoreProp("HTMLElement", prevHtmlElement);
    restoreProp("Event", prevEvent);
    restoreProp("CustomEvent", prevCustomEvent);
    restoreProp("KeyboardEvent", prevKeyboardEvent);
    restoreProp("IS_REACT_ACT_ENVIRONMENT", prevActEnv);
  };

  return { dom, container: htmlContainer, root, restore };
}

let activeCleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (activeCleanup) {
    await activeCleanup();
    activeCleanup = null;
  }
  globalThis.fetch = realFetch;
});

describe("shared UI primitives & hooks", () => {
  test("ErrorBoundary catches render failures and recovers after Try again", () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    let shouldThrow = true;

    function Bomb() {
      if (shouldThrow) throw new Error("boom in panel");
      return <div data-testid="recovered">Healthy view</div>;
    }

    try {
      const mounted = mountWithDom(
        <ErrorBoundary scope="Profiles">
          <Bomb />
        </ErrorBoundary>,
      );
      activeCleanup = mounted.restore;

      const alert = mounted.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Profiles ran into an unexpected error");
      expect(alert?.textContent).toContain("boom in panel");

      shouldThrow = false;
      const retryBtn = [...mounted.container.querySelectorAll("button")].find(
        (btn) => btn.textContent === "Try again",
      );
      expect(retryBtn).toBeTruthy();
      act(() => {
        retryBtn!.click();
      });

      expect(mounted.container.querySelector('[data-testid="recovered"]')?.textContent).toBe("Healthy view");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("ModalDialog, ConfirmDialog, and useConfirmDialog resolve choices and use confirm-dialog-backdrop without inline z-index", async () => {
    let resolved: boolean[] = [];

    function Harness() {
      const { requestConfirm, confirmDialogNode } = useConfirmDialog();
      return (
        <div>
          <ModalDialog open onClose={() => {}} title="Test Modal">
            <button
              type="button"
              data-testid="trigger-confirm"
              onClick={() => {
                void requestConfirm({
                  title: "Delete profile",
                  message: "Move this profile to Trash?",
                  confirmLabel: "Move to Trash",
                  tone: "danger",
                }).then((accepted) => resolved.push(accepted));
              }}
            >
              Trigger
            </button>
          </ModalDialog>
          {confirmDialogNode}
        </div>
      );
    }

    const mounted = mountWithDom(<Harness />);
    activeCleanup = mounted.restore;

    expect(mounted.container.querySelector('[role="dialog"]')).toBeTruthy();

    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="trigger-confirm"]');
    act(() => {
      trigger!.click();
    });

    const backdrop = mounted.container.querySelector<HTMLElement>(".confirm-dialog-backdrop");
    expect(backdrop).toBeTruthy();
    expect(backdrop!.style.zIndex).toBe("");

    const alertDialog = mounted.container.querySelector('[role="alertdialog"]');
    expect(alertDialog?.textContent).toContain("Move this profile to Trash?");

    const confirmBtn = [...alertDialog!.querySelectorAll("button")].find(
      (btn) => btn.textContent === "Move to Trash",
    );
    act(() => {
      confirmBtn!.click();
    });
    await Promise.resolve();
    expect(resolved).toEqual([true]);

    // Re-open and cancel via Escape
    act(() => {
      trigger!.click();
    });
    expect(mounted.container.querySelector('[role="alertdialog"]')).toBeTruthy();
    act(() => {
      mounted.dom.document.dispatchEvent(
        new mounted.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Parameters<typeof mounted.dom.document.dispatchEvent>[0],
      );
    });
    await Promise.resolve();
    expect(resolved).toEqual([true, false]);
  });

  test("Pagination notifies page and page-size changes cleanly", () => {
    const pageChanges: number[] = [];
    const sizeChanges: number[] = [];

    const mounted = mountWithDom(
      <Pagination
        page={1}
        pageCount={4}
        pageSize={20}
        pageSizeOptions={[20, 50, 100]}
        onPageChange={(next) => pageChanges.push(next)}
        onPageSizeChange={(size) => sizeChanges.push(size)}
      />,
    );
    activeCleanup = mounted.restore;

    const prev = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]');
    const next = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
    const select = mounted.container.querySelector<HTMLSelectElement>("select");
    expect(prev?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);

    act(() => {
      prev!.click();
      next!.click();
    });
    expect(pageChanges).toEqual([0, 2]);

    act(() => {
      select!.value = "50";
      select!.dispatchEvent(new mounted.dom.Event("change", { bubbles: true }) as unknown as Event);
    });
    expect(sizeChanges).toEqual([50]);
  });

  test("useProfileMetrics computes O(1) lookup map and selection counts in one pass", () => {
    const profiles: UiProfile[] = [
      { id: "p1", name: "One", engine: "chromium", running: true, mobilePersona: false, group: "", platform: "", tags: [], proxy: "", pendingCookieCount: 0 } as unknown as UiProfile,
      { id: "p2", name: "Two", engine: "firefox", running: false, mobilePersona: true, group: "", platform: "", tags: [], proxy: "", pendingCookieCount: 2 } as unknown as UiProfile,
      { id: "p3", name: "Three", engine: "chromium", running: false, mobilePersona: false, group: "", platform: "", tags: [], proxy: "", pendingCookieCount: 0 } as unknown as UiProfile,
    ];
    let latest: ReturnType<typeof useProfileMetrics> | null = null;

    function Probe({ selected }: { selected: ReadonlySet<string> }) {
      latest = useProfileMetrics(profiles, selected);
      return null;
    }

    const mounted = mountWithDom(<Probe selected={new Set(["p1", "p2"])} />);
    activeCleanup = mounted.restore;

    expect(latest!.profilesById.get("p2")?.name).toBe("Two");
    expect(latest!.runningCount).toBe(1);
    expect(latest!.selectedMobileCount).toBe(1);
    expect(latest!.selectedProfilesSupportChromeExtensions).toBe(false);
    expect(latest!.selectedPendingCount).toBe(1);
    expect(latest!.selectedReadyCount).toBe(1);

    act(() => {
      mounted.root.render(
        <I18nProvider>
          <Probe selected={new Set(["p1", "p3"])} />
        </I18nProvider>,
      );
    });
    expect(latest!.selectedProfilesSupportChromeExtensions).toBe(true);
    expect(latest!.selectedMobileCount).toBe(0);
  });

  test("useRosterPolling pauses while document.hidden, recovers on retryConnection, and re-surfaces fresh outages", async () => {
    let failMode = true;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (failMode) {
        return Response.json({ ok: false, error: "Server offline" }, { status: 503 });
      }
      return Response.json({ profiles: [], groups: ["all"] });
    }) as unknown as typeof fetch;

    let pollingState: ReturnType<typeof useRosterPolling> | null = null;
    function PollingHarness() {
      const bulkOwnerActiveRef = React.useRef(true);
      pollingState = useRosterPolling({
        enabled: true,
        intervalMs: 40,
        maxBackoffMs: 160,
        bulkOwnerActiveRef,
        onRoster: () => {},
      });
      return null;
    }

    const mounted = mountWithDom(<PollingHarness />);
    activeCleanup = mounted.restore;

    // Trigger initial load failure and dismiss banner
    await act(async () => {
      await pollingState!.load();
    });
    expect(pollingState!.connErr).toContain("Server offline");
    expect(pollingState!.connectionAlertDismissed).toBe(false);

    act(() => {
      pollingState!.dismissConnectionAlert();
    });
    expect(pollingState!.connectionAlertDismissed).toBe(true);

    // Hide tab and verify polling stays paused
    Object.defineProperty(mounted.dom.document, "hidden", { configurable: true, get: () => true });
    act(() => {
      mounted.dom.document.dispatchEvent(new mounted.dom.Event("visibilitychange") as unknown as Parameters<typeof mounted.dom.document.dispatchEvent>[0]);
    });
    const hiddenBaseline = fetches;
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(fetches).toBe(hiddenBaseline);

    // Recover server and return visibility -> retry clears error & alert dismissal
    failMode = false;
    Object.defineProperty(mounted.dom.document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      await pollingState!.retryConnection();
    });
    expect(pollingState!.connErr).toBeNull();
    expect(pollingState!.connectionAlertDismissed).toBe(false);

    // Fresh outage re-surfaces banner automatically
    failMode = true;
    await act(async () => {
      await pollingState!.load();
    });
    expect(pollingState!.connErr).toContain("Server offline");
    expect(pollingState!.connectionAlertDismissed).toBe(false);
  });
});
