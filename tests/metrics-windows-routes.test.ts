import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettingsStore } from "../src/app-settings.ts";
import { buildNewProfile } from "../src/create.ts";
import { DESKTOP_SESSION_HEADER } from "../src/desktop-runtime.ts";
import { statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import { MemoryWatermarkGuard } from "../src/metrics/memory-watermark-guard.ts";
import { MetricsService } from "../src/metrics/metrics-service.ts";
import {
  ProcessTreeMetricsCollector,
  type ProcessMetricsBackend,
} from "../src/metrics/process-metrics.ts";
import { ResourcePolicyStore } from "../src/metrics/resource-policy-store.ts";
import { UiEventBus } from "../src/ui/events-bus.ts";
import { handleUiRequest } from "../src/ui.ts";
import { serveDashboard } from "../src/web.ts";
import { createSseParser, type UiStreamEvent } from "../web/api.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mockBackend(): ProcessMetricsBackend {
  const rss = new Map<number, number>([
    [6000, 120_000_000],
    [7000, 90_000_000],
  ]);
  return {
    supportsWorkingSetTrim: true,
    cpuCount: () => 4,
    readHostMemory: () => ({
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      memoryLoadPercent: 50,
    }),
    listProcessEdges: () => [
      { pid: 6000, parentPid: 1 },
      { pid: 7000, parentPid: 1 },
    ],
    readProcessStats: (pid) =>
      rss.has(pid)
        ? { pid, rssBytes: rss.get(pid)!, privateBytes: Math.round(rss.get(pid)! * 0.8), cpuTime100ns: 1_000_000n, creationTime100ns: 100n }
        : null,
    emptyWorkingSet: (pid) => {
      if (!rss.has(pid)) return false;
      rss.set(pid, Math.round(rss.get(pid)! * 0.5));
      return true;
    },
  };
}

async function openSse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Accept: "text/event-stream", ...headers }, signal: controller.signal });
  const events: UiStreamEvent[] = [];
  const chunks: string[] = [];
  const waiters: Array<() => void> = [];
  const notify = () => { while (waiters.length) waiters.shift()!(); };
  const decoder = new TextDecoder();
  const parser = createSseParser((ev) => { events.push(ev); notify(); });

  let task = Promise.resolve();
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    task = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            chunks.push(decoder.decode(value, { stream: true }));
            parser.push(value);
            notify();
          }
        }
      } catch {}
      finally {
        try { reader.releaseLock(); } catch {}
        notify();
      }
    })();
  }

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const rem = deadline - Date.now();
      if (rem <= 0) throw new Error(`SSE timeout (events=${JSON.stringify(events)})`);
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(rem, 40));
        waiters.push(() => { clearTimeout(t); res(); });
      });
    }
  };

  return {
    response,
    events,
    rawText: () => chunks.join(""),
    waitFor,
    close: async () => { controller.abort(); await task; },
  };
}

describe("metrics & registered-launches routes", () => {
  test("GET /ui/api/windows/registered-launches returns authoritative launch metadata with zero credentials", async () => {
    const store = new ProfileStore(":memory:");
    const chrome = buildNewProfile({
      name: "Shop Alpha",
      customNo: "42",
      password: "SUPER_SECRET_PASSWORD",
      twofa: "JBSWY3DPEHPK3PXP",
      proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "PROXY_USER", pass: "PROXY_PASS" },
    }, () => false);
    const fox = buildNewProfile({
      name: "Fox Beta",
      engine: "firefox",
      password: "FOX_SECRET_PASSWORD",
    }, (id) => id === chrome.id);
    store.upsertProfiles([chrome, fox]);

    store.recordLaunch({
      profileId: chrome.id,
      engine: "chromium",
      pid: 6000,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/SECRET-UUID",
      binaryPath: "C:\\browsers\\chrome.exe",
      startedAt: 1_700_000_001_000,
    });
    store.recordLaunch({
      profileId: fox.id,
      engine: "firefox",
      pid: 7000,
      debugPort: 9333,
      ws: "http://127.0.0.1:9333",
      binaryPath: "C:\\browsers\\firefox.exe",
      startedAt: 1_700_000_002_000,
      firefoxOwner: {
        endpoint: "http://127.0.0.1:9333",
        token: "OWNER_SECRET_TOKEN",
        generation: "gen-1",
        pid: 7100,
        browserPid: 7000,
      },
    });

    try {
      const res = await handleUiRequest(
        new Request("http://127.0.0.1:50400/ui/api/windows/registered-launches"),
        {} as any,
        store,
      );
      expect(res?.status).toBe(200);
      expect(res?.headers.get("cache-control")).toBe("no-store");
      const raw = await res!.text();
      for (const secret of [
        "SUPER_SECRET_PASSWORD",
        "JBSWY3DPEHPK3PXP",
        "PROXY_USER",
        "PROXY_PASS",
        "FOX_SECRET_PASSWORD",
        "SECRET-UUID",
        "OWNER_SECRET_TOKEN",
      ]) {
        expect(raw).not.toContain(secret);
      }

      const body = JSON.parse(raw);
      expect(body.ok).toBe(true);
      expect(body.launches).toHaveLength(2);
      const byId = new Map(body.launches.map((l: any) => [l.profileId, l]));
      expect(byId.get(chrome.id)).toEqual({
        profileId: chrome.id,
        name: "Shop Alpha",
        displayNo: "42",
        engine: "chromium",
        pid: 6000,
        ownerPid: null,
        binaryPath: "C:\\browsers\\chrome.exe",
        startedAt: 1_700_000_001_000,
        windowLabel: "Shop Alpha · #42",
      });
      expect(byId.get(fox.id)).toMatchObject({
        profileId: fox.id,
        name: "Fox Beta",
        engine: "firefox",
        pid: 7000,
        ownerPid: 7100,
        binaryPath: "C:\\browsers\\firefox.exe",
        startedAt: 1_700_000_002_000,
      });

      // Security checks: POST -> 405, cross-origin -> 403
      const postRes = await handleUiRequest(
        new Request("http://127.0.0.1:50400/ui/api/windows/registered-launches", { method: "POST" }),
        {} as any,
        store,
      );
      expect(postRes?.status).toBe(405);
      const crossRes = await handleUiRequest(
        new Request("http://127.0.0.1:50400/ui/api/windows/registered-launches", {
          headers: { Origin: "https://evil.example" },
        }),
        {} as any,
        store,
      );
      expect(crossRes?.status).toBe(403);
    } finally {
      store.close();
    }
  });

  test("per-profile resource policy CRUD routes work without colliding with GET /ui/api/profiles/:id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maobu-routes-pol-"));
    tempDirs.push(dir);
    const paths = statePaths(dir);
    const store = new ProfileStore(":memory:");
    const policyStore = new ResourcePolicyStore(":memory:");
    const appSettings = new AppSettingsStore(join(dir, "app-settings.json"));
    appSettings.patch({ network: { chromiumMemorySaver: true, dataSaver: { enabled: true, blockImages: true } } });

    const p1 = buildNewProfile({ name: "Policy Profile" }, () => false);
    store.upsertProfile(p1);
    store.recordLaunch({
      profileId: p1.id,
      pid: 6000,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/1",
      startedAt: 1000,
    });

    try {
      // List empty policies (must NOT hit GET /ui/api/profiles/:id!)
      const list0 = await handleUiRequest(
        new Request("http://127.0.0.1/ui/api/profiles/resource-policies"),
        {} as any,
        store,
        { paths, resourcePolicies: policyStore, appSettings },
      );
      expect(list0?.status).toBe(200);
      expect(await list0!.json()).toEqual({ ok: true, policies: [] });

      // PATCH override
      const patched = await handleUiRequest(
        new Request(`http://127.0.0.1/ui/api/profiles/${p1.id}/resource-policy`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memorySaverMode: "off", dataSaver: { mode: "on", blockFonts: true } }),
        }),
        {} as any,
        store,
        { paths, resourcePolicies: policyStore, appSettings },
      );
      expect(patched?.status).toBe(200);
      const patchBody = await patched!.json();
      expect(patchBody).toMatchObject({
        ok: true,
        restartRequired: true,
        policy: {
          profileId: p1.id,
          memorySaverMode: "off",
          dataSaver: { mode: "on", blockFonts: true },
        },
        effective: {
          memorySaver: false,
          dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: true },
        },
      });

      // GET single policy
      const got = await handleUiRequest(
        new Request(`http://127.0.0.1/ui/api/profiles/${p1.id}/resource-policy`),
        {} as any,
        store,
        { paths, resourcePolicies: policyStore, appSettings },
      );
      expect(got?.status).toBe(200);
      expect((await got!.json()).effective.memorySaver).toBe(false);

      // Invalid payload -> 400; missing profile -> 404
      const bad = await handleUiRequest(
        new Request(`http://127.0.0.1/ui/api/profiles/${p1.id}/resource-policy`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memorySaverMode: "nope" }),
        }),
        {} as any,
        store,
        { paths, resourcePolicies: policyStore, appSettings },
      );
      expect(bad?.status).toBe(400);

      const missing = await handleUiRequest(
        new Request("http://127.0.0.1/ui/api/profiles/missing1/resource-policy"),
        {} as any,
        store,
        { paths, resourcePolicies: policyStore, appSettings },
      );
      expect(missing?.status).toBe(404);
    } finally {
      policyStore.close();
      store.close();
    }
  });

  test("serveDashboard streams /ui/api/metrics/stream, bridges metrics.snapshot to /ui/api/events demand-driven, and executes trim/hibernate", async () => {
    const store = new ProfileStore(":memory:");
    const p1 = buildNewProfile({ name: "Live Chrome" }, () => false);
    store.upsertProfile(p1);
    store.recordLaunch({
      profileId: p1.id,
      engine: "chromium",
      pid: 6000,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/1",
      binaryPath: "C:\\chrome.exe",
      startedAt: 1_700_000_000_000,
    });

    const backend = mockBackend();
    const collector = new ProcessTreeMetricsCollector({ backend });
    const captured: string[] = [];
    const launcher = {
      captureLocalSession: async (id: string) => {
        captured.push(id);
        return true;
      },
      stop: async (id: string) => {
        store.clearLaunch(id);
        return true;
      },
      dataDriveFreeBytes: () => 50 * 1024 ** 3,
    } as any;

    const metricsService = new MetricsService({
      store,
      launcher,
      collector,
      watermarkGuard: new MemoryWatermarkGuard({ readHostMemory: () => collector.readHostMemory() }),
      purgeCdpMemory: async () => true,
      intervalMs: 40,
    });
    const eventBus = new UiEventBus({ workspaceId: "ws-metrics", heartbeatIntervalMs: 80, store });
    const session = "c".repeat(64);
    const server = serveDashboard({
      port: 0,
      launcher,
      store,
      dashboardSession: session,
      eventBus,
      metricsService,
      metricsHeartbeatIntervalMs: 60,
      log: () => {},
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const auth = { [DESKTOP_SESSION_HEADER]: session };

    try {
      // Unauthenticated requests are rejected with 401
      expect((await fetch(`${origin}/ui/api/windows/registered-launches`)).status).toBe(401);
      expect((await fetch(`${origin}/ui/api/metrics/snapshot`)).status).toBe(401);
      expect((await fetch(`${origin}/ui/api/metrics/stream`)).status).toBe(401);

      // 0 SSE clients -> metricsService has 0 subscribers (0% idle CPU)
      expect(metricsService.subscriberCount()).toBe(0);

      // 1. Dedicated /ui/api/metrics/stream sends immediate snapshot + periodic metrics + keepalive
      const metricsStream = await openSse(`${origin}/ui/api/metrics/stream`, auth);
      try {
        expect(metricsStream.response.status).toBe(200);
        expect(metricsStream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        await metricsStream.waitFor(() => metricsStream.events.filter((e) => e.type === "metrics").length >= 2);
        await metricsStream.waitFor(() => metricsStream.rawText().includes(": keepalive\n\n"));
        expect(metricsService.subscriberCount()).toBe(1);
        expect((metricsStream.events[0]!.data as any).totals.totalRssBytes).toBe(120_000_000);
      } finally {
        await metricsStream.close();
      }
      await Bun.sleep(40);
      expect(metricsService.subscriberCount()).toBe(0);

      // 2. Wave 2 unified /ui/api/events bridges metrics.snapshot demand-driven
      const eventsStream = await openSse(`${origin}/ui/api/events`, auth);
      try {
        await eventsStream.waitFor(() => eventsStream.events.some((e) => e.type === "metrics.snapshot"));
        expect(metricsService.subscriberCount()).toBe(1);
      } finally {
        await eventsStream.close();
      }
      await Bun.sleep(40);
      expect(metricsService.subscriberCount()).toBe(0);

      // 3. POST trim-memory & trim-all
      const trimRes = await fetch(`${origin}/ui/api/profiles/${p1.id}/trim-memory`, {
        method: "POST",
        headers: auth,
      });
      expect(trimRes.status).toBe(200);
      expect(await trimRes.json()).toMatchObject({
        ok: true,
        result: {
          profileId: p1.id,
          cdpPurged: true,
          workingSetTrimmed: true,
          beforeRssBytes: 120_000_000,
          afterRssBytes: 60_000_000,
          reclaimedBytes: 60_000_000,
        },
      });

      const trimAllRes = await fetch(`${origin}/ui/api/metrics/trim-all`, { method: "POST", headers: auth });
      expect(trimAllRes.status).toBe(200);
      expect((await trimAllRes.json()).trimmedProfiles).toBe(1);

      // 4. POST hibernate captures session then stops & marks hibernated
      const hibRes = await fetch(`${origin}/ui/api/profiles/${p1.id}/hibernate`, {
        method: "POST",
        headers: auth,
      });
      expect(hibRes.status).toBe(200);
      expect(await hibRes.json()).toMatchObject({
        ok: true,
        profileId: p1.id,
        status: "hibernated",
        sessionCaptured: true,
        stopped: true,
        hibernated: true,
      });
      expect(captured).toEqual([p1.id]);

      const snapAfter = await (await fetch(`${origin}/ui/api/metrics/snapshot`, { headers: auth })).json();
      expect(snapAfter.snapshot.hibernatedProfileIds).toEqual([p1.id]);
      expect(snapAfter.snapshot.totals.runningProfiles).toBe(0);

      // 5. POST hibernate-batch validation & all:true
      const badBatch = await fetch(`${origin}/ui/api/profiles/hibernate-batch`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["../bad"] }),
      });
      expect(badBatch.status).toBe(400);

      const allBatch = await fetch(`${origin}/ui/api/profiles/hibernate-batch`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      expect(allBatch.status).toBe(200);
      expect(await allBatch.json()).toMatchObject({ ok: true, hibernatedCount: 0 });
    } finally {
      await server.stopScripts();
      await server.stop(true);
      metricsService.close();
      store.close();
    }
  });
});
