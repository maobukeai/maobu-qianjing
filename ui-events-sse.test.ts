import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile } from "./create.ts";
import { downloadBoundedCurl } from "./bounded-curl.ts";
import { DESKTOP_SESSION_HEADER } from "./desktop-runtime.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { downloadResumable, notifyRuntimeDownloadProgress, runtimeDownloads, subscribeRuntimeDownloads, trackRuntimeDownload, type RuntimeDownload } from "./runtime-download.ts";
import { ScriptLibrary, ScriptSupervisor, type ScriptRun } from "./scripts.ts";
import { rejectUntrustedLocalRequest } from "./server.ts";
import { ProfileStore, type StoreMutationEvent } from "./store.ts";
import { UiEventBus } from "./src/ui/events-bus.ts";
import { handleUiRequest } from "./ui.ts";
import { serveDashboard, STANDALONE_SESSION_HEADER } from "./web.ts";
import { createSseParser, type UiStreamEvent } from "./web/api.ts";

function rawHttpRequest(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      const headerBlock = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headerBlock}\r\n`);
    });
    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("rawHttpRequest timed out"));
    }, 3000);
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      const status = Number(raw.match(/^HTTP\/1\.[01] (\d+)/)?.[1] ?? 0);
      const sep = raw.indexOf("\r\n\r\n");
      resolve({ status, body: sep === -1 ? "" : raw.slice(sep + 4) });
    });
  });
}

async function openSseReader(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  const events: UiStreamEvent[] = [];
  const rawChunks: string[] = [];
  const waiters: Array<() => void> = [];
  const notify = () => {
    while (waiters.length > 0) waiters.shift()!();
  };
  const decoder = new TextDecoder();
  const parser = createSseParser((event) => {
    events.push(event);
    notify();
  });
  let streamEnded = false;
  let readerTask: Promise<void> = Promise.resolve();
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    readerTask = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            rawChunks.push(decoder.decode(value, { stream: true }));
            parser.push(value);
            notify();
          }
        }
        parser.finish();
      } catch {
        // Expected on abort/close.
      } finally {
        streamEnded = true;
        try { reader.releaseLock(); } catch {}
        notify();
      }
    })();
  } else {
    streamEnded = true;
  }

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for SSE condition (events=${JSON.stringify(events)})`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  const close = async () => {
    controller.abort();
    await readerTask;
  };

  return {
    response,
    events,
    rawText: () => rawChunks.join(""),
    isEnded: () => streamEnded,
    waitFor,
    close,
  };
}

test("UiEventBus coalesces rapid roster mutations within 50ms and folds >64 IDs into full:true", async () => {
  const bus = new UiEventBus({ coalesceWindowMs: 40 });
  const received: UiStreamEvent[] = [];
  const parser = createSseParser((ev) => received.push(ev));
  const unsub = bus.subscribe({
    send: (bytes) => parser.push(bytes),
    close: () => {},
  });

  try {
    for (let i = 0; i < 10; i++) {
      bus.emitRosterChanged("upsertProfile", [`p-${i}`]);
    }
    bus.emitRosterChanged("rename", ["p-0"]);
    expect(received).toHaveLength(0);

    await Bun.sleep(70);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("roster.changed");
    expect(received[0]!.data).toEqual({
      reasons: ["upsertProfile", "rename"],
      profileIds: Array.from({ length: 10 }, (_, i) => `p-${i}`),
    });

    // > 64 IDs collapse to { full: true } without listing individual profileIds
    const manyIds = Array.from({ length: 70 }, (_, i) => `bulk-${i}`);
    bus.emitRosterChanged("setGroup", manyIds);
    await Bun.sleep(70);
    expect(received).toHaveLength(2);
    expect(received[1]!.data).toEqual({
      reasons: ["setGroup"],
      full: true,
    });
  } finally {
    unsub();
    bus.closeAll();
  }
});

test("UiEventBus ring buffer replays missed events and signals overflow/restart resync", () => {
  const bus = new UiEventBus({ historyCapacity: 256, coalesceWindowMs: 0 });
  try {
    for (let i = 1; i <= 5; i++) {
      bus.emitProfileLifecycle({ profileId: `p-${i}`, running: true, startedAt: i * 100 });
    }
    expect(bus.headId()).toBe(5);
    const partial = bus.replaySince(2);
    expect(partial.overflow).toBe(false);
    expect(partial.events.map((ev) => ev.id)).toEqual([3, 4, 5]);

    // Client ahead of server head (e.g. server restarted) triggers resync
    expect(bus.replaySince(999)).toEqual({ events: [], overflow: true });

    // Overflow past 256 entries
    for (let i = 6; i <= 270; i++) {
      bus.emitProfileLifecycle({ profileId: `p-${i}`, running: false });
    }
    expect(bus.headId()).toBe(270);
    expect(bus.replaySince(1)).toEqual({ events: [], overflow: true });

    // Boundary inside ring buffer (oldest retained id = 270 - 256 + 1 = 15, so Last-Event-ID = 14 replays 15..270)
    const exactBoundary = bus.replaySince(14);
    expect(exactBoundary.overflow).toBe(false);
    expect(exactBoundary.events).toHaveLength(256);
    expect(exactBoundary.events[0]!.id).toBe(15);
    expect(exactBoundary.events.at(-1)!.id).toBe(270);
  } finally {
    bus.closeAll();
  }
});

test("UiEventBus enforces MAX_SSE_CLIENTS by evicting oldest client and drops throwing slow consumers", () => {
  const bus = new UiEventBus({ maxClients: 8, coalesceWindowMs: 0 });
  const closedIndices: number[] = [];
  const delivered: number[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      bus.subscribe({
        send: () => delivered.push(i),
        close: () => closedIndices.push(i),
      });
    }
    expect(bus.clientCount()).toBe(8);

    // 9th subscriber evicts subscriber 0
    bus.subscribe({
      send: () => delivered.push(8),
      close: () => closedIndices.push(8),
    });
    expect(bus.clientCount()).toBe(8);
    expect(closedIndices).toEqual([0]);

    // A failing subscriber is immediately evicted without blocking healthy subscribers
    let badClosed = false;
    bus.subscribe({
      send: () => {
        throw new Error("backpressure failure");
      },
      close: () => {
        badClosed = true;
      },
    });
    expect(closedIndices).toEqual([0, 1]);

    bus.emitProfileLifecycle({ profileId: "p1", running: true });
    expect(badClosed).toBe(true);
    expect(bus.clientCount()).toBe(7);
    expect(delivered).toContain(8);
  } finally {
    bus.closeAll();
  }
});

test("UiEventBus runs conditional orphan reconciliation only when clients > 0 AND launches > 0", async () => {
  const store = new ProfileStore(":memory:");
  let reconcileCalls = 0;
  let clearOnCall = 0;
  const launcher = {
    reconcileOrphans: async () => {
      reconcileCalls += 1;
      if (clearOnCall > 0 && reconcileCalls >= clearOnCall) {
        store.clearLaunch("p1");
      }
      return { cleared: clearOnCall > 0 && reconcileCalls >= clearOnCall ? 1 : 0 };
    },
  };
  const bus = new UiEventBus({
    launcher,
    store,
    orphanReconcileIntervalMs: 30,
    coalesceWindowMs: 0,
  });
  store.onMutation = (ev) => bus.handleStoreMutation(ev);

  try {
    const p1 = buildNewProfile({ name: "Orphan test" }, () => false);
    p1.id = "p1";
    store.upsertProfile(p1);
    store.recordLaunch({
      profileId: "p1",
      pid: 12345,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/1",
      startedAt: Date.now(),
    });

    // 0 SSE clients, 1 running launch -> 0 reconcile calls
    await Bun.sleep(80);
    expect(reconcileCalls).toBe(0);

    // Connect 1 client while 1 running launch -> reconciles until launch is cleared
    clearOnCall = 1;
    const unsub = bus.subscribe({ send: () => {}, close: () => {} });
    await Bun.sleep(100);
    expect(reconcileCalls).toBe(1);
    expect(store.listLaunches()).toHaveLength(0);

    // Now 0 running launches, 1 client -> reconciler stops (0 further calls)
    const afterClear = reconcileCalls;
    await Bun.sleep(90);
    expect(reconcileCalls).toBe(afterClear);

    // Record another launch while client connected, then disconnect immediately -> stops before firing
    clearOnCall = 0;
    store.recordLaunch({
      profileId: "p1",
      pid: 12346,
      debugPort: 9223,
      ws: "ws://127.0.0.1:9223/devtools/browser/2",
      startedAt: Date.now(),
    });
    unsub();
    await Bun.sleep(90);
    expect(reconcileCalls).toBe(afterClear);
  } finally {
    bus.closeAll();
    store.close();
  }
});

test("ProfileStore emits mutations only after commit and covers profile, group, cookie, and launch lifecycle", () => {
  const store = new ProfileStore(":memory:");
  const events: StoreMutationEvent[] = [];
  store.onMutation = (ev) => events.push(ev);

  try {
    const p1 = buildNewProfile({ name: "Alpha" }, () => false);
    store.upsertProfile(p1);
    store.rename(p1.id, "Alpha 2");
    store.createGroup("Team A");
    store.setGroup([p1.id], "Team A");
    store.addPendingCookies(p1.id, [
      { name: "sid", value: "secret", domain: "example.com", path: "/", expires: 0, secure: true, sameSite: "Lax" },
    ]);
    store.clearPendingCookies(p1.id, store.getPendingCookies(p1.id));
    store.setTimezone(p1.id, "UTC");
    store.setHardware(p1.id, { cores: 8 });
    store.setGroupExtensionDefaults("Team A", ["ext-1"]);
    store.renameGroup("Team A", "Team B");
    store.createGroup("Root");
    store.moveGroup("Team B", "Root");
    store.deleteGroup("Root/Team B");
    store.trashProfile(p1.id);
    store.restoreProfile(p1.id);
    store.recordLaunch({
      profileId: p1.id,
      pid: 4444,
      debugPort: 9333,
      ws: "ws://127.0.0.1:9333/devtools/browser/a",
      startedAt: 1_700_000_000_000,
    });
    store.clearLaunch(p1.id);
    store.deleteProfile(p1.id);

    const reasons = events.filter((e) => e.kind === "roster").map((e) => e.reason);
    expect(reasons).toContain("upsertProfile");
    expect(reasons).toContain("rename");
    expect(reasons).toContain("createGroup");
    expect(reasons).toContain("addPendingCookies");
    expect(reasons).toContain("clearPendingCookies");
    expect(reasons).toContain("setTimezone");
    expect(reasons).toContain("setHardware");
    expect(reasons).toContain("setGroupExtensionDefaults");
    expect(reasons).toContain("renameGroup");
    expect(reasons).toContain("moveGroup");
    expect(reasons).toContain("deleteGroup");
    expect(reasons).toContain("trashProfile");
    expect(reasons).toContain("restoreProfile");
    expect(reasons).toContain("deleteProfile");

    const lifecycle = events.filter((e) => e.kind === "lifecycle");
    expect(lifecycle).toEqual([
      { kind: "lifecycle", profileId: p1.id, running: true, startedAt: 1_700_000_000_000, debugPort: 9333 },
      { kind: "lifecycle", profileId: p1.id, running: false },
    ]);

    // Rollback inside transaction must emit zero events
    const beforeRollback = events.length;
    const valid = buildNewProfile({ name: "Valid" }, () => false);
    const bad = buildNewProfile({ name: "Bad" }, () => false);
    bad.id = "../escape";
    expect(() => store.upsertProfiles([valid, bad])).toThrow();
    expect(events.length).toBe(beforeRollback);
  } finally {
    store.close();
  }
});

test("subscribeRuntimeDownloads notifies start/finish immediately and throttles chunk updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maobu-dl-sse-"));
  const partial = join(dir, "runtime.bin.part");
  const snapshots: RuntimeDownload[][] = [];
  const unsub = subscribeRuntimeDownloads((list) => snapshots.push(list));
  try {
    const chunk = new Uint8Array(64).fill(65);
    const total = chunk.byteLength * 4;
    await trackRuntimeDownload("firefox", partial, total, async () => {
      await downloadResumable("https://example.test/runtime.bin", partial, total, {
        attempts: 1,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (let i = 0; i < 4; i++) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { status: 200, headers: { "content-length": String(total) } },
          ),
      });
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]).toEqual([{ runtime: "firefox", receivedBytes: 0, totalBytes: total }]);
    expect(snapshots.at(-1)).toEqual([]);
    // 4 synchronous chunks within <250ms must not fire 4 separate unthrottled progress notifications
    expect(snapshots.length).toBeLessThanOrEqual(4);
  } finally {
    unsub();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadBoundedCurl emits live intermediate progress snapshots during slow transfers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maobu-curl-sse-"));
  const partial = join(dir, "chromium.zip.part");
  const snapshots: RuntimeDownload[][] = [];
  const unsub = subscribeRuntimeDownloads((list) => snapshots.push(list));
  try {
    await trackRuntimeDownload("aliasmode", partial, 8, async () => {
      await downloadBoundedCurl("https://example.test/chromium.zip", partial, {
        executable: "fixture-curl",
        maxBytes: 8,
        timeoutMs: 5_000,
        exactSize: true,
        spawn: () => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("1234"));
              await Bun.sleep(280);
              controller.enqueue(encoder.encode("5678200"));
              controller.close();
            },
          });
          return { stdout: stream, exited: Promise.resolve(0), kill() {} };
        },
      });
    });

    const intermediate = snapshots.flat().filter((item) => item.receivedBytes > 0 && item.receivedBytes < 8);
    expect(intermediate.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]).toEqual([{ runtime: "aliasmode", receivedBytes: 0, totalBytes: 8 }]);
    expect(snapshots.at(-1)).toEqual([]);
  } finally {
    unsub();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifyRuntimeDownloadProgress reports in-memory bytes immediately even before disk metadata catches up", async () => {
  const missingOnDisk = join(tmpdir(), `maobu-mem-only-${Date.now()}.part`);
  await trackRuntimeDownload("cloakbrowser", missingOnDisk, 1000, async () => {
    notifyRuntimeDownloadProgress(missingOnDisk, 420);
    expect(runtimeDownloads()).toEqual([{ runtime: "cloakbrowser", receivedBytes: 420, totalBytes: 1000 }]);
    notifyRuntimeDownloadProgress(missingOnDisk, 0);
    expect(runtimeDownloads()).toEqual([{ runtime: "cloakbrowser", receivedBytes: 0, totalBytes: 1000 }]);
  });
  expect(runtimeDownloads()).toEqual([]);
});

test("ScriptSupervisor emits redacted onRunChanged transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "maobu-script-sse-"));
  const store = new ProfileStore(":memory:");
  const p = buildNewProfile({ name: "Script target", password: "super-secret-password" }, () => false);
  store.upsertProfile(p);
  const library = new ScriptLibrary(root);
  const saved = await library.save({
    name: "Check page",
    description: "test",
    language: "javascript",
    source: "export default async function () {}",
  });
  const updates: ScriptRun[] = [];
  const launcher = {
    certifiedActive: async () => false,
    start: async (id: string) => {
      const ws = `ws://127.0.0.1:9444/devtools/browser/${id}`;
      store.recordLaunch({
        profileId: id,
        pid: 9999,
        debugPort: 9444,
        ws,
        startedAt: Date.now(),
      });
      return { ws, port: 9444 };
    },
    stop: async (id: string) => {
      store.clearLaunch(id);
      return true;
    },
  };
  const supervisor = new ScriptSupervisor({
    root,
    library,
    launcher: launcher as any,
    store,
    admission: new LifecycleAdmissionController(),
    execute: async () => {},
    onRunChanged: (run) => updates.push(run),
  });
  try {
    const started = supervisor.start({
      scriptId: saved.id,
      profileIds: [p.id],
      inputs: {},
      useCredentials: true,
    });
    await supervisor.settled(started.id);
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates[0]!.status).toBe("running");
    expect(updates.at(-1)!.status).toBe("finished");
    expect(updates.at(-1)!.profiles[0]!.status).toBe("succeeded");
    expect(JSON.stringify(updates)).not.toContain("super-secret-password");
  } finally {
    await supervisor.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real loopback SSE endpoint enforces auth/origin/method, streams mutations <150ms, sends keepalive, and supports Last-Event-ID", async () => {
  const store = new ProfileStore(":memory:");
  const session = "a".repeat(64);
  const eventBus = new UiEventBus({
    workspaceId: "ws-sse-test",
    heartbeatIntervalMs: 80,
    coalesceWindowMs: 20,
    historyCapacity: 4,
    store,
  });
  const server = serveDashboard({
    port: 0,
    launcher: { dataDriveFreeBytes: () => 50 * 1024 ** 3 } as any,
    store,
    dashboardSession: session,
    eventBus,
    log: () => {},
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const authHeaders = { [DESKTOP_SESSION_HEADER]: session };

  try {
    // 1. /ui/api/app-mode advertises eventsStream: true
    const modeRes = await fetch(`${origin}/ui/api/app-mode`, { headers: authHeaders });
    expect(modeRes.status).toBe(200);
    expect(await modeRes.json()).toMatchObject({ mode: "local", localOnly: true, eventsStream: true });

    // 2. Security checks: non-loopback client -> 403; missing session -> 401; wrong host -> 403; cross-origin -> 403; cross-site -> 403; POST -> 405
    const nonLoopback = rejectUntrustedLocalRequest(new Request(`${origin}/ui/api/events`, { headers: authHeaders }), {
      port: server.port,
      requireHost: true,
      clientAddress: "203.0.113.9",
    });
    expect(nonLoopback?.status).toBe(403);
    expect((await fetch(`${origin}/ui/api/events`)).status).toBe(401);
    expect((await fetch(`${origin}/ui/api/events?token=${session}`)).status).toBe(401);
    expect((await rawHttpRequest(server.port!, "/ui/api/events", "evil.example", authHeaders)).status).toBe(403);
    expect(
      (await fetch(`${origin}/ui/api/events`, { headers: { ...authHeaders, Origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (await fetch(`${origin}/ui/api/events`, { headers: { ...authHeaders, "Sec-Fetch-Site": "cross-site" } })).status,
    ).toBe(403);
    const postRes = await fetch(`${origin}/ui/api/events`, { method: "POST", headers: authHeaders });
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("allow")).toBe("GET");

    // 3. Connect authenticated SSE stream and verify headers + connected frame + keepalive
    const stream = await openSseReader(`${origin}/ui/api/events`, authHeaders);
    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(stream.response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
      expect(stream.response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(stream.response.headers.get("x-frame-options")).toBe("DENY");

      await stream.waitFor(() => stream.events.some((ev) => ev.type === "connected"));
      expect(stream.events[0]).toEqual({
        id: 0,
        type: "connected",
        data: { workspaceId: "ws-sse-test", protocol: 1 },
      });

      // Wait for keepalive comment frame
      await stream.waitFor(() => stream.rawText().includes(": keepalive\n\n"), 500);

      // 4. Create profile via API -> roster.changed delivered within <150ms without leaking secrets
      const t0 = performance.now();
      const createRes = await fetch(`${origin}/ui/api/profiles`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          name: "SSE Profile",
          password: "top-secret-password",
          twofa: "JBSWY3DPEHPK3PXP",
        }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { id: string };
      await stream.waitFor(() => stream.events.some((ev) => ev.type === "roster.changed"));
      const rosterLatency = performance.now() - t0;
      expect(rosterLatency).toBeLessThan(150);
      expect(stream.rawText()).not.toContain("top-secret-password");
      expect(stream.rawText()).not.toContain("JBSWY3DPEHPK3PXP");

      // 5. Launch & stop profile -> profile.lifecycle delivered within <150ms
      const t1 = performance.now();
      store.recordLaunch({
        profileId: created.id,
        pid: 7777,
        debugPort: 9555,
        ws: "ws://127.0.0.1:9555/devtools/browser/live",
        startedAt: 1_700_000_001_000,
      });
      await stream.waitFor(() =>
        stream.events.some((ev) => ev.type === "profile.lifecycle" && (ev.data as { running?: boolean }).running === true),
      );
      expect(performance.now() - t1).toBeLessThan(150);

      const t2 = performance.now();
      store.clearLaunch(created.id);
      await stream.waitFor(() =>
        stream.events.some((ev) => ev.type === "profile.lifecycle" && (ev.data as { running?: boolean }).running === false),
      );
      expect(performance.now() - t2).toBeLessThan(150);
    } finally {
      await stream.close();
    }

    // 6. Last-Event-ID replay (within capacity=4) and overflow resync
    const headBefore = eventBus.headId();
    eventBus.emitProfileLifecycle({ profileId: "replay-1", running: true });
    eventBus.emitProfileLifecycle({ profileId: "replay-2", running: false });
    const replayed = await openSseReader(`${origin}/ui/api/events`, {
      ...authHeaders,
      "Last-Event-ID": String(headBefore),
    });
    try {
      await replayed.waitFor(() => replayed.events.length >= 3);
      expect(replayed.events.slice(1).map((ev) => (ev.data as { profileId: string }).profileId)).toEqual([
        "replay-1",
        "replay-2",
      ]);
    } finally {
      await replayed.close();
    }

    // Overflow ring buffer (capacity=4) -> reconnect with Last-Event-ID: 1 receives resync: true
    for (let i = 0; i < 6; i++) {
      eventBus.emitProfileLifecycle({ profileId: `overflow-${i}`, running: false });
    }
    const overflowed = await openSseReader(`${origin}/ui/api/events`, {
      ...authHeaders,
      "Last-Event-ID": "1",
    });
    try {
      await overflowed.waitFor(() =>
        overflowed.events.some((ev) => ev.type === "roster.changed" && (ev.data as { resync?: boolean }).resync === true),
      );
    } finally {
      await overflowed.close();
    }

    // 7. Standalone accessToken also requires header/cookie (never URL query)
    const token = "b".repeat(64);
    const standalone = serveDashboard({ port: 0, launcher: {} as any, store, accessToken: token, log: () => {} });
    try {
      const sOrigin = `http://127.0.0.1:${standalone.port}`;
      expect((await fetch(`${sOrigin}/ui/api/events?token=${token}`)).status).toBe(401);
      const okStream = await openSseReader(`${sOrigin}/ui/api/events`, { [STANDALONE_SESSION_HEADER]: token });
      try {
        expect(okStream.response.status).toBe(200);
        await okStream.waitFor(() => okStream.events.some((ev) => ev.type === "connected"));
      } finally {
        await okStream.close();
      }
    } finally {
      await standalone.stop(true);
    }
  } finally {
    await server.stopScripts();
    await server.stop(true);
    store.close();
    expect(eventBus.isClosed()).toBe(true);
    expect(eventBus.clientCount()).toBe(0);
  }
});

test("handleUiRequest returns 503 for /ui/api/events when no event bus is attached and omits eventsStream in app-mode", async () => {
  const store = new ProfileStore(":memory:");
  try {
    const mode = await handleUiRequest(new Request("http://127.0.0.1/ui/api/app-mode"), {} as any, store);
    expect(mode?.status).toBe(200);
    const modeBody = await mode!.json();
    expect(Object.hasOwn(modeBody, "eventsStream")).toBe(false);

    const eventsRes = await handleUiRequest(new Request("http://127.0.0.1/ui/api/events"), {} as any, store);
    expect(eventsRes?.status).toBe(503);
  } finally {
    store.close();
  }
});
