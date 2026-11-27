import { describe, expect, test } from "bun:test";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { MemoryWatermarkGuard } from "./memory-watermark-guard.ts";
import {
  MetricsService,
  purgeChromiumJavaScriptMemory,
  type MetricsSnapshot,
} from "./metrics-service.ts";
import {
  ProcessTreeMetricsCollector,
  type ProcessMetricsBackend,
  type RawProcessStats,
} from "./process-metrics.ts";

function makeFakeBackend(opts: {
  memoryLoadPercent?: number;
  availableBytes?: number;
  procs: Record<number, { parentPid: number; rssBytes: number; privateBytes: number }>;
  onSample?: () => void;
}) {
  const stats = new Map<number, RawProcessStats>(
    Object.entries(opts.procs).map(([pidStr, p]) => {
      const pid = Number(pidStr);
      return [
        pid,
        {
          pid,
          rssBytes: p.rssBytes,
          privateBytes: p.privateBytes,
          cpuTime100ns: 1_000_000n,
          creationTime100ns: 100n,
        },
      ];
    }),
  );
  const edges = Object.entries(opts.procs).map(([pidStr, p]) => ({
    pid: Number(pidStr),
    parentPid: p.parentPid,
  }));
  const trimmed: number[] = [];
  const backend: ProcessMetricsBackend = {
    supportsWorkingSetTrim: true,
    cpuCount: () => 4,
    readHostMemory: () => {
      opts.onSample?.();
      const totalBytes = 16 * 1024 ** 3;
      const availableBytes = opts.availableBytes ?? 8 * 1024 ** 3;
      return {
        totalBytes,
        availableBytes,
        usedBytes: totalBytes - availableBytes,
        memoryLoadPercent: opts.memoryLoadPercent ?? 50,
      };
    },
    listProcessEdges: () => edges,
    readProcessStats: (pid) => stats.get(pid) ?? null,
    emptyWorkingSet: (pid) => {
      trimmed.push(pid);
      const s = stats.get(pid);
      if (s) stats.set(pid, { ...s, rssBytes: Math.round(s.rssBytes * 0.5) });
      return true;
    },
  };
  return { backend, trimmed, stats };
}

describe("MetricsService", () => {
  test("stops timer immediately at 0 subscribers (0% idle CPU) and samples only while subscribed", async () => {
    let sampleCalls = 0;
    const { backend } = makeFakeBackend({
      procs: { 2000: { parentPid: 1, rssBytes: 100_000_000, privateBytes: 80_000_000 } },
      onSample: () => { sampleCalls += 1; },
    });
    const store = new ProfileStore(":memory:");
    const p1 = buildNewProfile({ name: "Worker 1" }, () => false);
    store.upsertProfile(p1);
    store.recordLaunch({
      profileId: p1.id,
      pid: 2000,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/1",
      startedAt: 1_700_000_000_000,
    });

    const collector = new ProcessTreeMetricsCollector({ backend });
    const service = new MetricsService({
      store,
      collector,
      watermarkGuard: new MemoryWatermarkGuard({ readHostMemory: () => collector.readHostMemory() }),
      intervalMs: 30,
    });

    try {
      // 0 subscribers -> 0 ticks
      await Bun.sleep(90);
      expect(sampleCalls).toBe(0);
      expect(service.subscriberCount()).toBe(0);

      // 1 subscriber -> receives periodic snapshots
      const received: MetricsSnapshot[] = [];
      const unsub = service.subscribe((snap) => received.push(snap));
      expect(service.subscriberCount()).toBe(1);
      await Bun.sleep(100);
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received[0]!.totals.runningProfiles).toBe(1);
      expect(received[0]!.totals.totalRssBytes).toBe(100_000_000);

      // Unsubscribe -> timer stops completely
      unsub();
      expect(service.subscriberCount()).toBe(0);
      const countAtUnsub = sampleCalls;
      await Bun.sleep(100);
      expect(sampleCalls).toBe(countAtUnsub);
    } finally {
      service.close();
      store.close();
    }
  });

  test("trimProfileMemory and trimAllMemory invoke CDP purge for Chromium only + working set trim for both engines", async () => {
    const store = new ProfileStore(":memory:");
    const chrome = buildNewProfile({ name: "Chrome A", password: "secret-password" }, () => false);
    const fox = buildNewProfile({ name: "Fox B", engine: "firefox" }, (id) => id === chrome.id);
    store.upsertProfiles([chrome, fox]);
    store.recordLaunch({
      profileId: chrome.id,
      engine: "chromium",
      pid: 3000,
      debugPort: 9300,
      ws: "ws://127.0.0.1:9300/devtools/browser/c1",
      startedAt: 1000,
    });
    store.recordLaunch({
      profileId: fox.id,
      engine: "firefox",
      pid: 4000,
      debugPort: 9400,
      ws: "http://127.0.0.1:9400",
      startedAt: 2000,
    });

    const { backend, trimmed } = makeFakeBackend({
      procs: {
        3000: { parentPid: 1, rssBytes: 200_000_000, privateBytes: 150_000_000 },
        3001: { parentPid: 3000, rssBytes: 100_000_000, privateBytes: 80_000_000 },
        4000: { parentPid: 1, rssBytes: 160_000_000, privateBytes: 120_000_000 },
      },
    });
    const purgedProfiles: string[] = [];
    const collector = new ProcessTreeMetricsCollector({ backend });
    const service = new MetricsService({
      store,
      collector,
      purgeCdpMemory: async (launch) => {
        purgedProfiles.push(launch.profileId);
        return true;
      },
    });

    try {
      const snap = service.snapshot();
      // Sorted by RSS descending: Chrome (300MB) before Fox (160MB), zero secrets leaked
      expect(snap.profiles.map((p) => p.profileId)).toEqual([chrome.id, fox.id]);
      expect(JSON.stringify(snap)).not.toContain("secret-password");

      const all = await service.trimAllMemory();
      expect(purgedProfiles).toEqual([chrome.id]);
      expect(trimmed.sort((a, b) => a - b)).toEqual([3000, 3001, 4000]);
      expect(all.trimmedProfiles).toBe(2);
      expect(all.totalBeforeRssBytes).toBe(460_000_000);
      expect(all.totalAfterRssBytes).toBe(230_000_000);
      expect(all.totalReclaimedBytes).toBe(230_000_000);
    } finally {
      service.close();
      store.close();
    }
  });

  test("purgeChromiumJavaScriptMemory attaches to page targets and invokes Memory.forciblyPurgeJavaScriptMemory", async () => {
    const receivedMethods: Array<{ method: string; sessionId?: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("not ws", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          receivedMethods.push({ method: msg.method, sessionId: msg.sessionId });
          if (msg.method === "Target.getTargets") {
            ws.send(JSON.stringify({ id: msg.id, result: { targetInfos: [{ targetId: "page-1", type: "page" }] } }));
          } else if (msg.method === "Target.attachToTarget") {
            ws.send(JSON.stringify({ id: msg.id, result: { sessionId: "sess-1" } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        },
      },
    });
    try {
      const ok = await purgeChromiumJavaScriptMemory({
        engine: "chromium",
        ws: `ws://127.0.0.1:${server.port}/devtools/browser/test`,
      });
      expect(ok).toBe(true);
      expect(receivedMethods).toContainEqual({ method: "Memory.forciblyPurgeJavaScriptMemory", sessionId: "sess-1" });

      // Refuses non-loopback endpoints
      expect(await purgeChromiumJavaScriptMemory({ engine: "chromium", ws: "ws://example.com:9222/devtools/browser/x" })).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("hibernateProfile captures session before stopping, tracks hibernated state, and clears on reopen", async () => {
    const store = new ProfileStore(":memory:");
    const p1 = buildNewProfile({ name: "Hibernate Me" }, () => false);
    const p2 = buildNewProfile({ name: "Already Stopped" }, (id) => id === p1.id);
    store.upsertProfiles([p1, p2]);
    store.recordLaunch({
      profileId: p1.id,
      pid: 5000,
      debugPort: 9500,
      ws: "ws://127.0.0.1:9500/devtools/browser/1",
      startedAt: 1000,
    });

    const callOrder: string[] = [];
    const launcher = {
      captureLocalSession: async (id: string) => {
        callOrder.push(`capture:${id}`);
        return true;
      },
      stop: async (id: string) => {
        callOrder.push(`stop:${id}`);
        store.clearLaunch(id);
        return true;
      },
    };
    const { backend } = makeFakeBackend({ procs: {} });
    const service = new MetricsService({
      store,
      launcher,
      collector: new ProcessTreeMetricsCollector({ backend }),
      now: () => 1_700_000_005_000,
    });

    try {
      const batch = await service.hibernateBatch([p1.id, p2.id, "missing-id"]);
      expect(callOrder).toEqual([`capture:${p1.id}`, `stop:${p1.id}`]);
      expect(batch.hibernatedCount).toBe(1);
      expect(batch.skippedCount).toBe(2);
      expect(batch.failedCount).toBe(0);
      expect(service.isHibernated(p1.id)).toBe(true);
      expect(service.snapshot().hibernatedProfileIds).toEqual([p1.id]);

      // Reopening clears the hibernated mark automatically
      store.recordLaunch({
        profileId: p1.id,
        pid: 5001,
        debugPort: 9501,
        ws: "ws://127.0.0.1:9501/devtools/browser/2",
        startedAt: 2000,
      });
      expect(service.snapshot().hibernatedProfileIds).toEqual([]);
      expect(service.isHibernated(p1.id)).toBe(false);
    } finally {
      service.close();
      store.close();
    }
  });
});
