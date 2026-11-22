import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import {
  hasNativeSyncEventHost,
  IDLE_SYNC_STATUS,
  normalizeSyncStatus,
  renderSafeTextTemplate,
  useWindowSyncState,
  type ManagedWindowInfo,
  type MonitorInfo,
  type SyncStatusSnapshot,
} from "./window-control-api.ts";
import {
  SyncEmergencyBar,
  WindowSyncPanel,
  type WindowControlBackend,
} from "./window-sync-panel.tsx";

async function createDom() {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  dom.document.documentElement.dataset.desktopMotion = "reduced";
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
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("HTMLTextAreaElement", dom.HTMLTextAreaElement);
  setGlobal("HTMLSelectElement", dom.HTMLSelectElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { createRoot } = await import("react-dom/client");
  const rawContainer = dom.document.createElement("div");
  dom.document.body.appendChild(rawContainer);
  const container = rawContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  };
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 15));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else Reflect.deleteProperty(globalThis, k);
    }
  };
  return { dom, container, root, flush, cleanup };
}

const SAMPLE_MONITORS: MonitorInfo[] = [
  {
    id: "mon_1",
    name: "Display 1",
    isPrimary: true,
    bounds: { left: 0, top: 0, right: 2560, bottom: 1440 },
    workArea: { left: 0, top: 0, right: 2560, bottom: 1400 },
    dpi: 120,
    scalePercent: 125,
  },
  {
    id: "mon_2",
    name: "Display 2",
    isPrimary: false,
    bounds: { left: 2560, top: 0, right: 4480, bottom: 1080 },
    workArea: { left: 2560, top: 0, right: 4480, bottom: 1040 },
    dpi: 96,
    scalePercent: 100,
  },
];

const SAMPLE_WINDOWS: ManagedWindowInfo[] = [
  {
    profileId: "p1",
    name: "Alpha Shop",
    displayNo: "101",
    engine: "chromium",
    pid: 1001,
    windowPid: 1001,
    hwndHex: "0x10010",
    title: "#101 Alpha Shop",
    className: "Chrome_WidgetWin_1",
    rect: { left: 0, top: 0, right: 800, bottom: 600 },
    clientRect: { left: 0, top: 0, right: 784, bottom: 560 },
    isMinimized: false,
    isMaximized: false,
    isTopmost: false,
    monitorId: "mon_1",
    dpi: 120,
    windowCount: 1,
  },
  {
    profileId: "p2",
    name: "Beta Shop",
    displayNo: "102",
    engine: "firefox",
    pid: 1002,
    windowPid: 1002,
    hwndHex: "0x10020",
    title: "#102 Beta Shop",
    className: "MozillaWindowClass",
    rect: { left: 800, top: 0, right: 1600, bottom: 600 },
    clientRect: { left: 0, top: 0, right: 784, bottom: 560 },
    isMinimized: false,
    isMaximized: false,
    isTopmost: false,
    monitorId: "mon_1",
    dpi: 120,
    windowCount: 1,
  },
];

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("Window layout & safe synchronizer UI", () => {
  test("renderSafeTextTemplate substitutes only safe placeholders and hasNativeSyncEventHost ignores bare invoke stubs", () => {
    expect(renderSafeTextTemplate("Row {{index}} - {{name}} (#{{customNo}})", { name: "Alpha", customNo: "42" }, 3))
      .toBe("Row 3 - Alpha (#42)");
    expect(hasNativeSyncEventHost({ __TAURI_INTERNALS__: { invoke: async () => {} } })).toBe(false);
    expect(hasNativeSyncEventHost({ __MAOBU_BACKDROP__: "mica", __TAURI_INTERNALS__: { invoke: async () => {} } })).toBe(true);
    expect(hasNativeSyncEventHost({ __TAURI_INTERNALS__: { invoke: async () => {}, transformCallback: () => 1 } })).toBe(true);
    expect(normalizeSyncStatus(null)).toEqual(IDLE_SYNC_STATUS);
  });

  test("degrades gracefully in non-desktop browser environments without throwing", async () => {
    const h = await createDom();
    dispose = h.cleanup;
    const unavailableBackend: WindowControlBackend = {
      isAvailable: () => false,
      listMonitors: async () => { throw new Error("should not call"); },
      listManagedWindows: async () => { throw new Error("should not call"); },
      arrangeWindows: async () => ({ arranged: [], skipped: [] }),
      runWindowAction: async () => ({ affected: [], missing: [] }),
      fetchSyncStatus: async () => IDLE_SYNC_STATUS,
      startWindowSync: async () => IDLE_SYNC_STATUS,
      stopWindowSync: async () => IDLE_SYNC_STATUS,
      pauseWindowSync: async () => IDLE_SYNC_STATUS,
      updateSyncSlaves: async () => IDLE_SYNC_STATUS,
      injectSyncTexts: async () => ({ queuedProfiles: [], skippedProfiles: [] }),
    };

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <WindowSyncPanel
            open
            onClose={() => {}}
            profiles={[]}
            syncState={IDLE_SYNC_STATUS}
            onSyncStateChange={() => {}}
            backend={unavailableBackend}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.querySelector("[data-window-sync-unavailable]")).toBeTruthy();
    expect(h.container.textContent).toContain("Desktop app required");
    const smartGridBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Smart grid"),
    )!;
    expect(smartGridBtn.disabled).toBe(true);
  });

  test("SyncEmergencyBar hides when inactive and exposes Pause + Ctrl+Shift+F12 emergency stop when active", async () => {
    const h = await createDom();
    dispose = h.cleanup;
    const events: string[] = [];

    const activeState: SyncStatusSnapshot = {
      ...IDLE_SYNC_STATUS,
      supported: true,
      active: true,
      masterProfileId: "p1",
      slaveProfileIds: ["p2", "p3"],
      emergencyHotkey: "Ctrl+Shift+F12",
    };

    let pushEvent!: (next: SyncStatusSnapshot) => void;
    function Harness() {
      const { syncState } = useWindowSyncState(true, async (listener) => {
        pushEvent = listener;
        return () => {};
      });
      return (
        <SyncEmergencyBar
          state={syncState}
          profiles={[{ id: "p1", name: "Alpha Shop" }]}
          onOpenPanel={() => events.push("open")}
          onPauseToggle={(paused) => events.push(`pause:${paused}`)}
          onEmergencyStop={() => events.push("stop")}
        />
      );
    }

    await act(async () => {
      h.root.render(<I18nProvider><Harness /></I18nProvider>);
    });
    await h.flush();
    expect(h.container.querySelector("[data-sync-emergency-bar]")).toBeNull();

    await act(async () => { pushEvent(activeState); });
    const bar = h.container.querySelector<HTMLElement>("[data-sync-emergency-bar]")!;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain("Alpha Shop → 2 slaves");
    expect(bar.textContent).toContain("Ctrl+Shift+F12");

    await act(async () => {
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Pause")!.click();
      bar.querySelector<HTMLButtonElement>(".sync-emergency-stop-btn")!.click();
    });
    expect(events).toEqual(["pause:true", "stop"]);
  });

  test("arranges windows, starts/stops sync with jitter, and dispatches differentiated text injection", async () => {
    const h = await createDom();
    dispose = h.cleanup;
    const calls: Array<{ name: string; arg?: unknown }> = [];
    let currentStatus: SyncStatusSnapshot = { ...IDLE_SYNC_STATUS, supported: true };

    const mockBackend: WindowControlBackend = {
      isAvailable: () => true,
      listMonitors: async () => SAMPLE_MONITORS,
      listManagedWindows: async () => SAMPLE_WINDOWS,
      arrangeWindows: async (req) => {
        calls.push({ name: "arrange", arg: req });
        return { arranged: [{}, {}], skipped: [] };
      },
      runWindowAction: async (req) => {
        calls.push({ name: "action", arg: req });
        return { affected: req.profileIds, missing: [] };
      },
      fetchSyncStatus: async () => currentStatus,
      startWindowSync: async (config) => {
        calls.push({ name: "sync_start", arg: config });
        currentStatus = {
          ...currentStatus,
          active: true,
          masterProfileId: config.masterProfileId,
          slaveProfileIds: config.slaveProfileIds,
        };
        return currentStatus;
      },
      stopWindowSync: async () => {
        calls.push({ name: "sync_stop" });
        currentStatus = { ...currentStatus, active: false, masterProfileId: null, slaveProfileIds: [] };
        return currentStatus;
      },
      pauseWindowSync: async (paused) => {
        calls.push({ name: "sync_pause", arg: paused });
        currentStatus = { ...currentStatus, paused, pausedByUser: paused };
        return currentStatus;
      },
      updateSyncSlaves: async (ids) => {
        calls.push({ name: "sync_update_slaves", arg: ids });
        currentStatus = { ...currentStatus, slaveProfileIds: ids };
        return currentStatus;
      },
      injectSyncTexts: async (req) => {
        calls.push({ name: "inject", arg: req });
        return { queuedProfiles: req.targetProfileIds ?? [], skippedProfiles: [] };
      },
    };

    function StatefulHarness() {
      const [status, setStatus] = React.useState<SyncStatusSnapshot>(currentStatus);
      return (
        <WindowSyncPanel
          open
          onClose={() => {}}
          profiles={[
            { id: "p1", name: "Alpha Shop", running: true, customNo: "101" },
            { id: "p2", name: "Beta Shop", running: true, customNo: "102" },
          ]}
          syncState={status}
          onSyncStateChange={setStatus}
          backend={mockBackend}
        />
      );
    }

    await act(async () => {
      h.root.render(<I18nProvider><StatefulHarness /></I18nProvider>);
    });
    await h.flush();

    expect(h.container.textContent).toContain("Display 1");
    expect(h.container.textContent).toContain("2 managed browser windows");

    // Trigger Smart grid
    const gridBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Smart grid"),
    )!;
    await act(async () => { gridBtn.click(); });
    await h.flush();
    expect(calls.some((c) => c.name === "arrange" && (c.arg as { mode: string }).mode === "grid")).toBe(true);

    // Select slave window (Beta Shop) and start sync
    const slaveCheckbox = h.container.querySelector<HTMLInputElement>(".wsync-slave-item input[type='checkbox']")!;
    await act(async () => { slaveCheckbox.click(); });

    const startSyncBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Start sync"),
    )!;
    await act(async () => { startSyncBtn.click(); });
    await h.flush();
    expect(calls.some((c) => c.name === "sync_start")).toBe(true);
    const startArg = calls.find((c) => c.name === "sync_start")!.arg as Record<string, unknown>;
    expect(startArg.masterProfileId).toBe("p1");
    expect(startArg.slaveProfileIds).toEqual(["p2"]);
    expect(startArg.jitterMinMs).toBe(15);
    expect(startArg.jitterMaxMs).toBe(85);

    // Switch text injection to Safe template mode & inject
    const templateTab = [...h.container.querySelectorAll<HTMLButtonElement>(".wsync-mode-tabs button")].find(
      (b) => b.textContent?.trim() === "Safe template",
    )!;
    await act(async () => { templateTab.click(); });
    expect(h.container.querySelector(".wsync-preview-list")?.textContent).toContain("Account-1 (Alpha Shop)");

    const injectBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Inject text to 2 windows"),
    )!;
    await act(async () => { injectBtn.click(); });
    await h.flush();
    expect(calls.some((c) => c.name === "inject" && (c.arg as { mode: string }).mode === "template")).toBe(true);

    // Emergency stop
    const stopBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Emergency stop"),
    )!;
    await act(async () => { stopBtn.click(); });
    await h.flush();
    expect(calls.some((c) => c.name === "sync_stop")).toBe(true);
  });
});
