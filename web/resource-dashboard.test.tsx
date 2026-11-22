import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { DataSaverSettings } from "./data-saver-settings.tsx";
import { I18nProvider } from "./i18n.tsx";
import {
  ProfileResourceChip,
  ResourceDashboardDrawer,
  ResourceTopCapsule,
  type ResourceDashboardActions,
} from "./resource-dashboard.tsx";
import {
  formatCpuPercent,
  formatMemoryBytes,
  hibernateProfile,
  hibernateProfilesBatch,
  normalizeMetricsSnapshot,
  trimAllProfilesMemory,
  trimProfileMemory,
  useResourceMonitor,
  watermarkConcurrency,
  type MetricsSnapshot,
} from "./resource-monitor-api.ts";
import { fetchSettings, resetSharedSettingsCache } from "./settings-api.ts";

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    ts: 1_700_000_000_000,
    host: {
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 3 * 1024 ** 3,
      usedBytes: 13 * 1024 ** 3,
      memoryLoadPercent: 81,
    },
    totals: {
      runningProfiles: 2,
      totalProcesses: 11,
      totalRssBytes: 1_500 * 1024 * 1024,
      totalPrivateBytes: 1_100 * 1024 * 1024,
      totalCpuPercent: 16.5,
    },
    watermark: {
      level: "elevated",
      recommendedConcurrency: 2,
      effectiveStartLimit: 2,
      startDelayMs: 1500,
      memoryLoadPercent: 81,
      availableBytes: 3 * 1024 ** 3,
      paused: false,
    },
    profiles: [
      {
        profileId: "p1",
        name: "Heavy Store",
        engine: "chromium",
        pid: 101,
        processCount: 7,
        rssBytes: 1_150 * 1024 * 1024,
        privateBytes: 900 * 1024 * 1024,
        cpuPercent: 4.2,
        startedAt: 1,
      },
      {
        profileId: "p2",
        name: "CPU Runner",
        engine: "firefox",
        pid: 102,
        processCount: 4,
        rssBytes: 350 * 1024 * 1024,
        privateBytes: 200 * 1024 * 1024,
        cpuPercent: 12.3,
        startedAt: 2,
      },
    ],
    hibernatedProfileIds: ["p3"],
    sampleDurationMs: 2,
    ...overrides,
  };
}

async function createHarness(fetchImpl?: typeof fetch) {
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
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  if (fetchImpl) setGlobal("fetch", fetchImpl);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { createRoot } = await import("react-dom/client");
  const rawContainer = dom.document.createElement("div");
  dom.document.body.appendChild(rawContainer);
  const container = rawContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
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
    resetSharedSettingsCache();
  };
  return { dom, container, root, flush, cleanup };
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("Resource monitoring, dashboard drawer, chips & DataSaverSettings", () => {
  test("formats memory/CPU cleanly and derives bounded watermark concurrency", () => {
    expect(formatMemoryBytes(0)).toBe("0 MB");
    expect(formatMemoryBytes(420 * 1024 * 1024)).toBe("420 MB");
    expect(formatMemoryBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatCpuPercent(12.34)).toBe("12.3%");
    expect(watermarkConcurrency(null)).toBe(4);
    expect(watermarkConcurrency(makeSnapshot())).toBe(2);
    expect(normalizeMetricsSnapshot({ invalid: true })).toBeNull();
  });

  test("useResourceMonitor sends zero requests when idle or eventsStream is off, and streams via fetch+ReadableStream when active", async () => {
    const requested: string[] = [];
    const sample = makeSnapshot();
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      requested.push(path);
      if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      if (path === "/ui/api/metrics/stream") {
        const payload = `event: metrics\ndata: ${JSON.stringify(sample)}\n\n`;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === "/ui/api/metrics/snapshot") {
        return Response.json({ ok: true, snapshot: sample });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    function MonitorHarness({ runningCount, eventsStream, panelOpen }: { runningCount: number; eventsStream: boolean; panelOpen: boolean }) {
      const monitor = useResourceMonitor({ enabled: true, runningCount, eventsStream, panelOpen });
      return (
        <div>
          <ResourceTopCapsule runningCount={runningCount} snapshot={monitor.snapshot} open={panelOpen} onToggle={() => {}} />
          <ProfileResourceChip metrics={monitor.byProfileId.get("p1")} />
          <ProfileResourceChip hibernated={monitor.hibernatedIds.has("p3")} />
        </div>
      );
    }

    // 1. Stopped / zero running -> zero metrics requests
    await act(async () => {
      h.root.render(<I18nProvider><MonitorHarness runningCount={0} eventsStream={true} panelOpen={false} /></I18nProvider>);
    });
    await h.flush();
    expect(requested.filter((p) => p.startsWith("/ui/api/metrics"))).toHaveLength(0);

    // 2. Running > 0, but eventsStream = false and drawer closed -> zero metrics requests (protects legacy fixtures)
    await act(async () => {
      h.root.render(<I18nProvider><MonitorHarness runningCount={2} eventsStream={false} panelOpen={false} /></I18nProvider>);
    });
    await h.flush();
    expect(requested.filter((p) => p.startsWith("/ui/api/metrics"))).toHaveLength(0);

    // 3. Running > 0 and eventsStream = true -> streams via fetch + ReadableStream and renders chips
    await act(async () => {
      h.root.render(<I18nProvider><MonitorHarness runningCount={2} eventsStream={true} panelOpen={false} /></I18nProvider>);
    });
    await h.flush();
    expect(requested).toContain("/ui/api/metrics/stream");
    expect(h.container.querySelector(".resource-top-capsule.wm-elevated")).toBeTruthy();
    expect(h.container.querySelector(".profile-resource-chip.is-heavy")?.textContent).toContain("1.1 GB");
    expect(h.container.querySelector(".profile-resource-chip.is-hibernated")?.textContent).toContain("Hibernated");
  });

  test("ResourceDashboardDrawer ranks by RAM/CPU and invokes Trim, Trim All, Hibernate, and Wake", async () => {
    const h = await createHarness();
    dispose = h.cleanup;
    const called: string[] = [];
    const sample = makeSnapshot();

    const actions: ResourceDashboardActions = {
      trimProfile: async (id) => {
        called.push(`trim:${id}`);
        return { ok: true, results: [], totalFreedBytes: 120 * 1024 * 1024 };
      },
      trimAll: async () => {
        called.push("trim:all");
        return { ok: true, results: [], totalFreedBytes: 240 * 1024 * 1024 };
      },
      hibernate: async (id) => {
        called.push(`hib:${id}`);
        return { ok: true, hibernated: [id], failed: [] };
      },
      hibernateAll: async () => {
        called.push("hib:all");
        return { ok: true, hibernated: ["p1", "p2"], failed: [] };
      },
      wake: async (id) => {
        called.push(`wake:${id}`);
        return { ok: true };
      },
    };

    const monitor = {
      snapshot: sample,
      byProfileId: new Map(sample.profiles.map((p) => [p.profileId, p])),
      hibernatedIds: new Set(sample.hibernatedProfileIds),
      streaming: true,
      unsupported: false,
      refreshNow: async () => { called.push("refresh"); },
    };

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <ResourceDashboardDrawer
            open
            onClose={() => {}}
            profiles={[
              { id: "p1", name: "Heavy Store", engine: "chromium", running: true },
              { id: "p2", name: "CPU Runner", engine: "firefox", running: true },
              { id: "p3", name: "Sleeping Store", engine: "chromium", running: false },
            ]}
            monitor={monitor}
            onRefreshRoster={async () => { called.push("roster"); }}
            actions={actions}
          />
        </I18nProvider>,
      );
    });

    const rows = () => [...h.container.querySelectorAll<HTMLElement>('[role="listitem"] strong')].map((el) => el.textContent);
    expect(rows()).toEqual(["Heavy Store", "CPU Runner"]);

    // Sort by CPU -> CPU Runner rises to first
    const sortCpuBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Sort by CPU",
    )!;
    await act(async () => { sortCpuBtn.click(); });
    expect(rows()).toEqual(["CPU Runner", "Heavy Store"]);

    // Trigger Trim All
    const trimAllBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Trim all memory",
    )!;
    await act(async () => { trimAllBtn.click(); });
    await h.flush();
    expect(called).toContain("trim:all");
    expect(h.container.textContent).toContain("240 MB");

    // Trigger Wake on hibernated p3
    const wakeBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Wake",
    )!;
    await act(async () => { wakeBtn.click(); });
    await h.flush();
    expect(called).toContain("wake:p3");
  });

  test("DataSaverSettings reuses sibling GET /ui/api/settings read without extra request and patches new resource settings", async () => {
    let getCount = 0;
    const patches: unknown[] = [];
    const baseSettings = {
      version: 1,
      updates: { repository: "", channel: "stable", checkOnStartup: false },
      sync: { enabled: false, folder: "", retainSnapshots: 10 },
      network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false },
      signedUpdates: { checkOnStartup: false },
    };

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      if (path === "/ui/api/settings" && (init?.method ?? "GET") === "GET") {
        getCount++;
        return Response.json({ ok: true, settings: baseSettings });
      }
      if (path === "/ui/api/settings" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return Response.json({
          ok: true,
          settings: {
            ...baseSettings,
            network: { ...baseSettings.network, ...body.network },
          },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    // Simulate a sibling card reading settings first -> DataSaverSettings shares it (0 extra GETs!)
    await fetchSettings();
    expect(getCount).toBe(1);

    await act(async () => {
      h.root.render(<I18nProvider><DataSaverSettings /></I18nProvider>);
    });
    await h.flush();
    expect(getCount).toBe(1);

    // Toggle Firefox memory saver & Data saver
    const switches = [...h.container.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
    expect(switches).toHaveLength(3);
    await act(async () => {
      switches[0]!.click(); // firefoxMemorySaver = true
      switches[1]!.click(); // dataSaver.enabled = true (auto enables images + media)
    });

    const saveBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Save resource preferences",
    )!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => { saveBtn.click(); });
    await h.flush();

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      network: {
        firefoxMemorySaver: true,
        dataSaver: { enabled: true, blockImages: true, blockMedia: true, blockFonts: false },
        batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 88, minAvailableMb: 1536 },
      },
    });
  });

  test("trim and hibernate API clients parse canonical w3-backend-resources responses", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === "/ui/api/profiles/p1/trim-memory") {
        return Response.json({
          ok: true,
          result: {
            profileId: "p1",
            engine: "chromium",
            running: true,
            cdpPurged: true,
            workingSetTrimmed: true,
            trimmedProcesses: 5,
            beforeRssBytes: 600 * 1024 ** 2,
            afterRssBytes: 420 * 1024 ** 2,
            reclaimedBytes: 180 * 1024 ** 2,
          },
        });
      }
      if (path === "/ui/api/metrics/trim-all") {
        return Response.json({
          ok: true,
          trimmedProfiles: 2,
          totalBeforeRssBytes: 1100 * 1024 ** 2,
          totalAfterRssBytes: 750 * 1024 ** 2,
          totalReclaimedBytes: 350 * 1024 ** 2,
          results: [
            { profileId: "p1", beforeRssBytes: 600 * 1024 ** 2, afterRssBytes: 420 * 1024 ** 2, reclaimedBytes: 180 * 1024 ** 2 },
            { profileId: "p2", beforeRssBytes: 500 * 1024 ** 2, afterRssBytes: 330 * 1024 ** 2, reclaimedBytes: 170 * 1024 ** 2 },
          ],
        });
      }
      if (path === "/ui/api/profiles/p2/hibernate") {
        return Response.json({
          ok: true,
          profileId: "p2",
          status: "not_running",
          sessionCaptured: false,
          stopped: false,
          hibernated: false,
        });
      }
      if (path === "/ui/api/profiles/hibernate-batch") {
        return Response.json({
          ok: true,
          hibernatedCount: 1,
          skippedCount: 1,
          failedCount: 1,
          results: [
            { profileId: "p1", status: "hibernated", sessionCaptured: true, stopped: true, hibernated: true },
            { profileId: "p2", status: "not_running", sessionCaptured: false, stopped: false, hibernated: false },
            { profileId: "p3", status: "stop_failed", sessionCaptured: true, stopped: false, hibernated: false },
          ],
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    const singleTrim = await trimProfileMemory("p1");
    expect(singleTrim.totalFreedBytes).toBe(180 * 1024 ** 2);
    expect(singleTrim.results).toHaveLength(1);
    expect(singleTrim.results[0]?.freedBytes).toBe(180 * 1024 ** 2);

    const allTrim = await trimAllProfilesMemory();
    expect(allTrim.totalFreedBytes).toBe(350 * 1024 ** 2);
    expect(allTrim.results).toHaveLength(2);
    expect(allTrim.results[1]?.freedBytes).toBe(170 * 1024 ** 2);

    const idleHibernate = await hibernateProfile("p2");
    expect(idleHibernate.hibernated).toEqual([]);

    const batchHibernate = await hibernateProfilesBatch({ all: true });
    expect(batchHibernate.hibernated).toEqual(["p1"]);
    expect(batchHibernate.failed).toEqual([{ profileId: "p3", error: "Hibernate failed" }]);
  });
});
