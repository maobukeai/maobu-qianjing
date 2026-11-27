import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RpaRecorderManager,
  type RecorderChildProcess,
  type RecorderProcessFactory,
} from "../rpa-recorder.ts";
import { ScriptLibrary, ScriptSupervisor } from "../scripts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createFakeChild(options: { autoSteps?: unknown[]; holdExit?: boolean } = {}) {
  const lineHandlers: Array<(line: string) => void> = [];
  const stderrHandlers: Array<(text: string) => void> = [];
  const written: string[] = [];
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  let closed = false;

  const emit = (payload: unknown) => {
    const line = JSON.stringify(payload);
    for (const handler of lineHandlers) handler(line);
  };

  const child: RecorderChildProcess = {
    pid: 4242,
    writeLine(line: string) {
      written.push(line);
      const parsed = JSON.parse(line);
      if (parsed.endpoint) {
        queueMicrotask(() => {
          emit({ type: "ready", url: "https://example.test" });
          for (const step of options.autoSteps ?? []) {
            emit({ type: "step", step });
          }
        });
      }
      if (parsed.cmd === "stop" && !options.holdExit && !closed) {
        closed = true;
        queueMicrotask(() => {
          emit({ type: "stopped" });
          resolveExit(0);
        });
      }
    },
    closeStdin() {},
    onLine(handler) {
      lineHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    exited,
    async terminate() {
      if (!closed) {
        closed = true;
        resolveExit(1);
      }
    },
  };

  return { child, emit, written, finish: (code = 0) => { if (!closed) { closed = true; resolveExit(code); } } };
}

function recorderHarness(options: {
  active?: string[];
  firefoxOwner?: any;
  idleTimeoutMs?: number;
  spawn?: RecorderProcessFactory;
  isProfileLockedByScripts?: (id: string) => boolean;
} = {}) {
  const events: string[] = [];
  const launch = (id: string) => options.firefoxOwner
    ? { ws: `firefox://127.0.0.1:9000/${options.firefoxOwner.generation}`, debugPort: 9000, engine: "firefox", firefoxOwner: options.firefoxOwner, headless: false }
    : { ws: `ws://test/${id}`, debugPort: 9000, headless: false };
  const launches = new Map((options.active ?? []).map((id) => [id, launch(id)]));
  const profiles = ["p1", "p2"].map((id) => ({
    id,
    name: `Profile ${id}`,
    group: "default",
    platform: "",
    engine: options.firefoxOwner ? ("firefox" as const) : ("chromium" as const),
  }));
  const spawnCalls: Array<{ endpoint: string; engine: string }> = [];
  const fakeHandles: Array<ReturnType<typeof createFakeChild>> = [];

  const defaultSpawn: RecorderProcessFactory = (opts) => {
    spawnCalls.push({ endpoint: opts.endpoint, engine: opts.engine });
    const handle = createFakeChild();
    fakeHandles.push(handle);
    return handle.child;
  };

  const manager = new RpaRecorderManager({
    store: {
      getProfile: (id: string) => profiles.find((p) => p.id === id),
      getLaunch: (id: string) => launches.get(id) ?? null,
      listAgentTemporary: () => [],
    } as any,
    launcher: {
      certifiedActive: async (id: string) => launches.has(id),
      start: async (id: string, _urls?: string[], openOpts?: { headless?: boolean }) => {
        events.push(`open:${id}:headless=${String(openOpts?.headless)}`);
        const l = launch(id);
        launches.set(id, l);
        return { ws: l.ws, port: 9000 };
      },
      stop: async (id: string) => {
        events.push(`close:${id}`);
        launches.delete(id);
        return true;
      },
    } as any,
    admission: { run: async (_: unknown, work: () => Promise<unknown>) => work() } as any,
    spawn: options.spawn ?? defaultSpawn,
    idleTimeoutMs: options.idleTimeoutMs,
    isProfileLockedByScripts: options.isProfileLockedByScripts,
  });

  return { manager, events, launches, spawnCalls, fakeHandles };
}

test("enforces single workspace recording session, captures sanitized steps, and generates code", async () => {
  const h = recorderHarness();
  const started = await h.manager.start({ profileId: "p1", startupUrl: "https://example.test" });
  expect(started.state).toBe("recording");
  expect(started.profileId).toBe("p1");
  expect(started.ownedByConnection).toBe(true);
  expect(h.events).toEqual(["open:p1:headless=false"]);
  expect(h.manager.isProfileLocked("p1")).toBe(true);

  // Second concurrent recording session in the same workspace must be rejected with 409.
  await expect(h.manager.start({ profileId: "p2" })).rejects.toMatchObject({ status: 409 });

  // Emit normal + sensitive steps (even if raw value were smuggled, manager strips it).
  h.fakeHandles[0]!.emit({
    type: "step",
    step: { kind: "goto", url: "https://example.test/login", timestamp: 100 },
  });
  h.fakeHandles[0]!.emit({
    type: "step",
    step: {
      kind: "fill",
      selector: 'input[type="password"]',
      selectorStrategy: "css",
      credentialRef: "password",
      masked: true,
      value: "LEAKED_PASSWORD_VALUE",
      timestamp: 200,
    },
  });

  const live = h.manager.status();
  expect(live.steps).toHaveLength(2);
  expect(live.steps[1]).toMatchObject({ kind: "fill", credentialRef: "password", masked: true });
  expect(live.steps[1]?.value).toBeUndefined();
  expect(JSON.stringify(live)).not.toContain("LEAKED_PASSWORD_VALUE");

  const stopped = await h.manager.stop({ closeBrowser: true });
  expect(stopped.state).toBe("idle");
  expect(stopped.steps).toHaveLength(2);
  expect(h.events).toEqual(["open:p1:headless=false", "close:p1"]);
  expect(h.manager.isProfileLocked("p1")).toBe(false);

  const generated = h.manager.codegen({ options: { scriptName: "Test Flow" } });
  expect(generated.usesCredentials).toBe(true);
  expect(generated.source).toContain('credentials?.password ?? inputs?.password ?? ""');
  expect(generated.source).not.toContain("LEAKED_PASSWORD_VALUE");
});

test("honors ownedByConnection: existing open browser is never closed; recorder-opened browser close is optional", async () => {
  // Case 1: Pre-existing browser (ownedByConnection === false) MUST stay open even with closeBrowser: true.
  const existing = recorderHarness({ active: ["p1"] });
  const status1 = await existing.manager.start({ profileId: "p1" });
  expect(status1.ownedByConnection).toBe(false);
  await existing.manager.stop({ closeBrowser: true });
  expect(existing.events).toEqual([]);
  expect(existing.launches.has("p1")).toBe(true);

  // Case 2: Recorder-opened browser (ownedByConnection === true) with closeBrowser: false detaches and stays open.
  const keepOpen = recorderHarness();
  const status2 = await keepOpen.manager.start({ profileId: "p1" });
  expect(status2.ownedByConnection).toBe(true);
  await keepOpen.manager.stop({ closeBrowser: false });
  expect(keepOpen.events).toEqual(["open:p1:headless=false"]);
  expect(keepOpen.launches.has("p1")).toBe(true);
});

test("supports Firefox profiles via private Playwright endpoint", async () => {
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json());
      return Response.json({ version: 1, ok: true, result: { endpoint: "ws://127.0.0.1:9444/ff-private" } });
    },
  });
  try {
    const h = recorderHarness({
      firefoxOwner: {
        endpoint: `http://127.0.0.1:${server.port}/`,
        token: "tok",
        pid: 10,
        browserPid: 11,
        generation: "gen-1",
      },
    });
    const status = await h.manager.start({ profileId: "p1" });
    expect(status.engine).toBe("firefox");
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toBe("playwright-endpoint");
    expect(h.spawnCalls).toEqual([{ endpoint: "ws://127.0.0.1:9444/ff-private", engine: "firefox" }]);
    await h.manager.stop({ closeBrowser: true });
  } finally {
    server.stop(true);
  }
});

test("idle timeout automatically stops abandoned recording session and releases browser & lock", async () => {
  const h = recorderHarness({ idleTimeoutMs: 40 });
  await h.manager.start({ profileId: "p1" });
  expect(h.manager.isProfileLocked("p1")).toBe(true);

  // Wait past idle timeout.
  await Bun.sleep(100);
  expect(h.manager.status().state).toBe("idle");
  expect(h.manager.isProfileLocked("p1")).toBe(false);
  expect(h.events).toEqual(["open:p1:headless=false", "close:p1"]);
});

test("recorder lock is mutually exclusive with ScriptSupervisor and drains queued runs when recording stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maobu-rec-lock-"));
  roots.push(dir);
  const launches = new Map<string, any>();
  const profiles = [{ id: "p1", name: "Profile 1", group: "", platform: "", username: "", password: "", twofa: "" }];
  const library = new ScriptLibrary(dir);
  const script = await library.save({
    name: "Echo",
    description: "Test",
    language: "javascript",
    source: "export default async () => {};",
  });
  const ranProfiles: string[] = [];

  const supervisor = new ScriptSupervisor({
    root: dir,
    library,
    execute: async ({ input }) => {
      ranProfiles.push(input.profile.id);
    },
    recorderOptions: {
      spawn: () => createFakeChild().child,
    },
    store: {
      getProfile: (id: string) => profiles.find((p) => p.id === id),
      getLaunch: (id: string) => launches.get(id) ?? null,
      listAgentTemporary: () => [],
    } as any,
    launcher: {
      certifiedActive: async (id: string) => launches.has(id),
      start: async (id: string) => {
        const value = { ws: `ws://test/${id}`, debugPort: 9000, headless: false };
        launches.set(id, value);
        return { ws: value.ws, port: 9000 };
      },
      stop: async (id: string) => {
        launches.delete(id);
        return true;
      },
    } as any,
    admission: { run: async (_: unknown, work: () => Promise<unknown>) => work() } as any,
  });

  await supervisor.recorder.start({ profileId: "p1" });
  // Without queueIfBusy, ScriptSupervisor rejects because p1 is locked by recorder.
  expect(() =>
    supervisor.start({ scriptId: script.id, profileIds: ["p1"], inputs: {}, useCredentials: false }),
  ).toThrow("already running");

  // With queueIfBusy, batch queues and runs automatically once recording stops!
  const queued = supervisor.start({
    scriptId: script.id,
    profileIds: ["p1"],
    inputs: {},
    useCredentials: false,
    queueIfBusy: true,
  });
  expect(queued.status).toBe("queued");
  expect(ranProfiles).toEqual([]);

  await supervisor.recorder.stop({ closeBrowser: true });
  await supervisor.settled(queued.id);
  expect(ranProfiles).toEqual(["p1"]);
  expect(supervisor.status(queued.id)?.status).toBe("finished");
  await supervisor.shutdown();
});
