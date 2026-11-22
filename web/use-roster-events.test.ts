import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createSseParser,
  openUiEventStream,
  setStandaloneSessionToken,
  subscribeUnauthorized,
  UnauthorizedError,
  type ProfileLifecycleEvent,
  type RuntimeDownload,
  type ScriptRun,
  type UiProfile,
  type UiRoster,
  type UiStreamEvent,
} from "./api.ts";
import {
  applyProfileLifecyclePatch,
  computeReconnectDelayMs,
  useRosterEvents,
  type UseRosterEventsResult,
} from "./hooks/use-roster-events.ts";

const realFetch = globalThis.fetch;

interface MountedHarness {
  dom: Window;
  root: Root;
  restore: () => Promise<void>;
}

function mountHarness(element: React.ReactElement): MountedHarness {
  const dom = new Window({ url: "http://127.0.0.1/" });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;
  const prevHtmlElement = globalThis.HTMLElement;
  const prevEvent = globalThis.Event;
  const prevActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);

  act(() => {
    root.render(element);
  });

  const restore = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    const restoreProp = (key: string, val: unknown) => {
      if (val === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: val });
    };
    restoreProp("window", prevWindow);
    restoreProp("document", prevDocument);
    restoreProp("navigator", prevNavigator);
    restoreProp("HTMLElement", prevHtmlElement);
    restoreProp("Event", prevEvent);
    restoreProp("IS_REACT_ACT_ENVIRONMENT", prevActEnv);
  };

  return { dom, root, restore };
}

function makeProfile(id: string, overrides: Partial<UiProfile> = {}): UiProfile {
  return {
    id,
    name: `Profile ${id}`,
    engine: "chromium",
    group: "",
    platform: "",
    tags: [],
    proxy: null,
    timezone: "UTC",
    cookieCount: 0,
    seeded: false,
    screen: "1920x1080",
    has2fa: false,
    running: false,
    ...overrides,
  };
}

function makeControllableSseResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    cancel() {
      closed = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
  return {
    response,
    pushFrame(text: string) {
      if (!closed) controller.enqueue(encoder.encode(text));
    },
    close() {
      if (!closed) {
        closed = true;
        try { controller.close(); } catch {}
      }
    },
    error(err: Error) {
      if (!closed) {
        closed = true;
        try { controller.error(err); } catch {}
      }
    },
    isClosed: () => closed,
  };
}

describe("SSE parser, transport, and useRosterEvents hook", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    setStandaloneSessionToken(null);
    if (cleanup) {
      const fn = cleanup;
      cleanup = null;
      await fn();
    }
  });

  test("createSseParser handles UTF-8 split boundaries, keepalive comments, CRLF splits, and multiline data", () => {
    const events: UiStreamEvent[] = [];
    const parser = createSseParser((ev) => events.push(ev));
    const encoder = new TextEncoder();

    const frame =
      ": keepalive\r\n\r\n" +
      'id: 42\r\nevent: profile.lifecycle\r\ndata: {"profileId":"中文-🚀","running":true}\r\n\r\n' +
      "id: 43\nevent: custom\ndata: line1\ndata: line2\n\n";
    const bytes = encoder.encode(frame);

    // Feed 1 byte at a time to stress-test multi-byte UTF-8 and CRLF chunk boundaries
    for (let i = 0; i < bytes.byteLength; i++) {
      parser.push(bytes.subarray(i, i + 1));
    }
    parser.finish();

    expect(events).toEqual([
      { id: 42, type: "profile.lifecycle", data: { profileId: "中文-🚀", running: true } },
      { id: 43, type: "custom", data: "line1\nline2" },
    ]);
  });

  test("openUiEventStream attaches standalone session header (never query), sends Last-Event-ID, and surfaces 401 UnauthorizedError", async () => {
    const seenUrls: string[] = [];
    const seenHeaders: Array<Headers> = [];
    const token = "f".repeat(64);
    setStandaloneSessionToken(token);

    let mode: "ok" | "401" = "ok";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrls.push(String(input));
      seenHeaders.push(new Headers(init?.headers));
      if (mode === "401") {
        return Response.json({ ok: false, error: "Session expired" }, { status: 401 });
      }
      const sse = makeControllableSseResponse();
      sse.pushFrame('id: 7\nevent: connected\ndata: {"workspaceId":"w1","protocol":1}\n\n');
      sse.close();
      return sse.response;
    }) as unknown as typeof fetch;

    const received: UiStreamEvent[] = [];
    await openUiEventStream({
      lastEventId: 6,
      signal: new AbortController().signal,
      onEvent: (ev) => received.push(ev),
    });

    expect(seenUrls[0]).toBe("/ui/api/events");
    expect(seenUrls[0]).not.toContain("token=");
    expect(seenHeaders[0]!.get("X-Maobu-Session")).toBe(token);
    expect(seenHeaders[0]!.get("Last-Event-ID")).toBe("6");
    expect(seenHeaders[0]!.get("Accept")).toBe("text/event-stream");
    expect(received).toEqual([{ id: 7, type: "connected", data: { workspaceId: "w1", protocol: 1 } }]);

    // 401 notifies unauthorized listeners and throws UnauthorizedError
    mode = "401";
    const authErrors: UnauthorizedError[] = [];
    const unsubAuth = subscribeUnauthorized((err) => authErrors.push(err));
    try {
      let caught: unknown;
      try {
        await openUiEventStream({
          signal: new AbortController().signal,
          onEvent: () => {},
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnauthorizedError);
      expect(authErrors).toHaveLength(1);
    } finally {
      unsubAuth();
    }
  });

  test("computeReconnectDelayMs follows 1s..30s exponential backoff with bounded +/-20% jitter", () => {
    expect(computeReconnectDelayMs(0, 1000, 30_000, 0)).toBe(1000);
    expect(computeReconnectDelayMs(1, 1000, 30_000, 0)).toBe(2000);
    expect(computeReconnectDelayMs(2, 1000, 30_000, 0)).toBe(4000);
    expect(computeReconnectDelayMs(3, 1000, 30_000, 0)).toBe(8000);
    expect(computeReconnectDelayMs(4, 1000, 30_000, 0)).toBe(16_000);
    expect(computeReconnectDelayMs(5, 1000, 30_000, 0)).toBe(30_000);
    expect(computeReconnectDelayMs(6, 1000, 30_000, 0)).toBe(30_000);

    // +/-20% jitter boundaries
    expect(computeReconnectDelayMs(2, 1000, 30_000, 0.2, () => 0)).toBe(3200);
    expect(computeReconnectDelayMs(2, 1000, 30_000, 0.2, () => 1)).toBe(4800);
  });

  test("applyProfileLifecyclePatch updates matching profile in-place and preserves firefox no-debugPort rule", () => {
    const initial: UiRoster = {
      profiles: [makeProfile("c1"), makeProfile("f1", { engine: "firefox" })],
      groups: [],
    };
    const started = applyProfileLifecyclePatch(initial, {
      profileId: "c1",
      running: true,
      startedAt: 123456,
      debugPort: 9222,
    });
    expect(started.matched).toBe(true);
    expect(started.roster.profiles[0]).toMatchObject({
      id: "c1",
      running: true,
      startedAt: 123456,
      debugPort: 9222,
    });

    const firefoxStarted = applyProfileLifecyclePatch(started.roster, {
      profileId: "f1",
      running: true,
      startedAt: 123457,
      debugPort: 9999,
    });
    expect(firefoxStarted.roster.profiles[1]!.running).toBe(true);
    expect(firefoxStarted.roster.profiles[1]!.debugPort).toBeUndefined();

    const stopped = applyProfileLifecyclePatch(firefoxStarted.roster, {
      profileId: "c1",
      running: false,
    });
    expect(stopped.roster.profiles[0]!.running).toBe(false);
    expect(stopped.roster.profiles[0]!.debugPort).toBeUndefined();
    expect(stopped.roster.profiles[0]!.startedAt).toBeUndefined();

    const missing = applyProfileLifecyclePatch(stopped.roster, { profileId: "unknown", running: true });
    expect(missing.matched).toBe(false);
  });

  test("useRosterEvents stays purely on polling when sseEnabled is false (zero /ui/api/events calls)", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ profiles: [makeProfile("p1")], groups: [] });
    }) as unknown as typeof fetch;

    let latest: UseRosterEventsResult | null = null;
    function Harness() {
      const bulkOwnerActiveRef = React.useRef(true);
      latest = useRosterEvents({
        enabled: true,
        sseEnabled: false,
        intervalMs: 40,
        bulkOwnerActiveRef,
        onRoster: () => {},
      });
      return null;
    }

    const mounted = mountHarness(React.createElement(Harness));
    cleanup = mounted.restore;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    expect(latest!.transport).toBe("polling");
    expect(urls.some((u) => u.includes("/ui/api/events"))).toBe(false);
    expect(urls.filter((u) => u === "/ui/api/profiles").length).toBeGreaterThanOrEqual(2);
  });

  test("useRosterEvents consumes SSE events, disables steady polling, patches lifecycle in-place, and falls back + reconnects on drop", async () => {
    let profileFetches = 0;
    let sseConnections = 0;
    const lastEventIdsSent: Array<string | null> = [];
    const activeStreams: Array<ReturnType<typeof makeControllableSseResponse>> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/ui/api/events") {
        sseConnections += 1;
        lastEventIdsSent.push(new Headers(init?.headers).get("Last-Event-ID"));
        const sse = makeControllableSseResponse();
        activeStreams.push(sse);
        return sse.response;
      }
      if (url === "/ui/api/profiles") {
        profileFetches += 1;
        return Response.json({ profiles: [makeProfile("p1")], groups: ["G1"] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    let latest: UseRosterEventsResult | null = null;
    const rosters: UiRoster[] = [];
    const lifecyclePatches: ProfileLifecycleEvent[] = [];
    const downloadBatches: RuntimeDownload[][] = [];
    const scriptRuns: Array<ScriptRun | null> = [];

    function Harness() {
      const bulkOwnerActiveRef = React.useRef(true);
      latest = useRosterEvents({
        enabled: true,
        sseEnabled: true,
        intervalMs: 40,
        fallbackPollIntervalMs: 40,
        steadySafetyRefreshMs: 60_000,
        reconnectBaseDelayMs: 140,
        reconnectMaxDelayMs: 300,
        reconnectJitterRatio: 0,
        bulkOwnerActiveRef,
        onRoster: (roster) => rosters.push(roster),
        onLifecyclePatch: (ev) => lifecyclePatches.push(ev),
        onDownloads: (dls) => downloadBatches.push(dls),
        onScriptRun: (run) => scriptRuns.push(run),
      });
      return null;
    }

    const mounted = mountHarness(React.createElement(Harness));
    cleanup = mounted.restore;

    // Wait for first SSE connection to open
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(sseConnections).toBe(1);
    expect(latest!.transport).toBe("sse");

    // Server sends connected -> triggers initial roster load
    await act(async () => {
      activeStreams[0]!.pushFrame('id: 10\nevent: connected\ndata: {"workspaceId":"w","protocol":1}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(profileFetches).toBe(1);
    expect(rosters).toHaveLength(1);

    // Steady SSE connected: 3s/40ms polling MUST stay silent
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });
    expect(profileFetches).toBe(1);

    // profile.lifecycle for known profile p1 patches optimistically without extra /ui/api/profiles GET
    await act(async () => {
      activeStreams[0]!.pushFrame(
        'id: 11\nevent: profile.lifecycle\ndata: {"profileId":"p1","running":true,"startedAt":999,"debugPort":9222}\n\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(lifecyclePatches).toEqual([{ profileId: "p1", running: true, startedAt: 999, debugPort: 9222 }]);
    expect(profileFetches).toBe(1);
    expect(latest!.lastRosterResult.current?.profiles[0]?.running).toBe(true);

    // profile.lifecycle for unknown profile id still triggers a fallback roster fetch
    await act(async () => {
      activeStreams[0]!.pushFrame(
        'id: 12\nevent: profile.lifecycle\ndata: {"profileId":"brand-new","running":true,"startedAt":1001}\n\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(profileFetches).toBe(2);

    // downloads.updated and script.run dispatch cleanly without polling
    await act(async () => {
      activeStreams[0]!.pushFrame(
        'id: 13\nevent: downloads.updated\ndata: {"downloads":[{"runtime":"firefox","receivedBytes":100,"totalBytes":1000}]}\n\n',
      );
      activeStreams[0]!.pushFrame(
        'id: 14\nevent: script.run\ndata: {"run":{"id":"r1","scriptName":"Demo","status":"running","profiles":[]}}\n\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(downloadBatches).toEqual([[{ runtime: "firefox", receivedBytes: 100, totalBytes: 1000 }]]);
    expect(scriptRuns).toEqual([{ id: "r1", scriptName: "Demo", status: "running", profiles: [] }]);

    // roster.changed triggers serialized fetchProfiles
    await act(async () => {
      activeStreams[0]!.pushFrame('id: 15\nevent: roster.changed\ndata: {"reasons":["rename"],"profileIds":["p1"]}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(profileFetches).toBe(3);

    // Drop SSE connection -> enters reconnecting, activates degraded polling, then reconnects with Last-Event-ID: 15
    const fetchesBeforeDrop = profileFetches;
    await act(async () => {
      activeStreams[0]!.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(latest!.transport).toBe("reconnecting");

    // Allow degraded fallback polling (40ms) to tick while reconnect backoff (140ms) is pending
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 65));
    });
    expect(profileFetches).toBeGreaterThan(fetchesBeforeDrop);

    // Wait for backoff to finish and establish 2nd SSE connection with Last-Event-ID: 15
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
    expect(sseConnections).toBeGreaterThanOrEqual(2);
    expect(lastEventIdsSent[1]).toBe("15");
    expect(latest!.transport).toBe("sse");

    // Reconnected stream sends connected -> single calibration fetch
    const fetchesAtReconnect = profileFetches;
    await act(async () => {
      activeStreams[1]!.pushFrame('id: 15\nevent: connected\ndata: {"workspaceId":"w","protocol":1}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(profileFetches).toBe(fetchesAtReconnect + 1);
  });

  test("useRosterEvents stops reconnecting immediately on HTTP 401", async () => {
    let sseAttempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "/ui/api/events") {
        sseAttempts += 1;
        return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }
      return Response.json({ profiles: [], groups: [] });
    }) as unknown as typeof fetch;

    let latest: UseRosterEventsResult | null = null;
    function Harness() {
      const bulkOwnerActiveRef = React.useRef(true);
      latest = useRosterEvents({
        enabled: true,
        sseEnabled: true,
        intervalMs: 40,
        reconnectBaseDelayMs: 25,
        reconnectJitterRatio: 0,
        bulkOwnerActiveRef,
        onRoster: () => {},
      });
      return null;
    }

    const mounted = mountHarness(React.createElement(Harness));
    cleanup = mounted.restore;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(sseAttempts).toBe(1);
    expect(latest!.transport).toBe("polling");
  });
});
