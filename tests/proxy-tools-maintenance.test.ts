import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import { ensureStateDirectories, statePaths } from "../paths.ts";
import { WorkspaceManagement } from "../workspace-management.ts";
import { handleUiRequest, type UiRuntimeOptions } from "../ui.ts";
import type { Launcher } from "../launcher.ts";
import type { ProxyPreview, ProxyProgressEvent } from "../proxy-tools-types.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(ids = ["p1"]) {
  const home = mkdtempSync(join(tmpdir(), "maobu-proxy-stream-"));
  const paths = statePaths(home); ensureStateDirectories(paths);
  const store = new ProfileStore(":memory:");
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const barrierReleases: Array<() => void> = [];
  let cleanupWork = async (_id: string) => {};
  const launcher = {
    cacheCleanupSettled: (id: string) => cleanupWork(id),
    profileDeletionBlocked: () => false,
    setWorkspaceMaintenanceGuard: () => {},
  } as unknown as Launcher;
  const manager = new WorkspaceManagement({ home, paths, store, launcher });
  for (const id of ids) store.upsertProfile({ ...buildNewProfile({ name: `Synthetic ${id}`, group: "audit", proxy: { type: "https", host: "old.invalid", port: "8080", user: "", pass: "" } }, () => false), id });
  const options: UiRuntimeOptions = { workspaceManagement: manager, timezoneFetch: async () => Response.json({}) };
  const request = async (action: string, body: unknown, extra: { raw?: boolean; signal?: AbortSignal; dispatch?: boolean } = {}) => {
    const init = body === undefined ? { signal: extra.signal } : { method: "POST", headers: { "Content-Type": "application/json" }, body: extra.raw ? String(body) : JSON.stringify(body), signal: extra.signal };
    const req = new Request(`http://127.0.0.1:12345/ui/api/proxies/${action}`, init);
    const run = async () => (await handleUiRequest(req, launcher, store, options))!;
    return extra.dispatch === false ? run() : manager.dispatch(req, run);
  };
  const preview = async (input = ids.map((_, index) => `https://new.invalid:${9000 + index}`).join("\n")) => (await (await request("preview", { scope: { all: true }, mode: "list", input })).json()) as ProxyPreview;
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const maintenance = (reason: string) => {
    let acquired = false;
    const promise = manager.maintenance.acquire(reason, 1000).then(release => { acquired = true; barrierReleases.push(release); return release; });
    return { promise, acquired: () => acquired };
  };
  cleanups.push(async () => {
    for (const gate of gates) gate.resolve();
    await manager.settled();
    for (const release of barrierReleases) release();
    store.close();
    const absolute = resolve(home), root = resolve(tmpdir());
    if (!absolute.startsWith(root + "\\maobu-proxy-stream-") && !absolute.startsWith(root + "/maobu-proxy-stream-")) throw new Error("Unexpected fixture path");
    rmSync(absolute, { recursive: true, force: true });
  });
  return { store, manager, options, request, preview, hold, maintenance, setCleanup: (next: typeof cleanupWork) => { cleanupWork = next; } };
}
const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line)) as ProxyProgressEvent[];

for (const reason of ["backup", "restore", "switch"]) {
  test(`streamed apply returns live progress while ${reason} waits for the real writer`, async () => {
    const f = fixture();
    const preview = await f.preview();
    const waiting = f.hold(), entered = deferred();
    f.setCleanup(async () => { entered.resolve(); await waiting.promise; });
    const response = await f.request("apply", { previewId: preview.previewId });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    await entered.promise;
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ type: "progress", phase: "loading", completed: 0, total: 1 });
    const barrier = f.maintenance(reason);
    let shutdownReady = false;
    const settled = f.manager.settled().then(() => { shutdownReady = true; });
    await tick();
    expect(barrier.acquired()).toBe(false);
    expect(shutdownReady).toBe(false);
    expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
    const rejected = await f.request("apply", { previewId: preview.previewId });
    expect(rejected.status).toBe(423);
    expect((await rejected.json()).code).toBe("workspace_busy");
    waiting.resolve();
    let tail = "";
    for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
    expect(tail).toContain('"status":"updated"');
    expect(tail).toContain('"type":"done"');
    const release = await barrier.promise;
    await settled;
    expect(f.store.getProfile("p1")!.proxy!.host).toBe("new.invalid");
    expect(f.manager.maintenance.busy()).toBe(true);
    release();
    expect(f.manager.maintenance.busy()).toBe(false);
  });
}

test("reader cancellation does not release a writer still awaiting inventory cleanup", async () => {
  const f = fixture();
  const preview = await f.preview();
  const waiting = f.hold(), entered = deferred();
  f.setCleanup(async () => { entered.resolve(); await waiting.promise; });
  const response = await f.request("apply", { previewId: preview.previewId });
  await entered.promise;
  await response.body!.cancel();
  const barrier = f.maintenance("backup");
  let shutdownReady = false;
  const settled = f.manager.settled().then(() => { shutdownReady = true; });
  await tick();
  expect(barrier.acquired()).toBe(false);
  expect(shutdownReady).toBe(false);
  waiting.resolve();
  (await barrier.promise)(); await settled;
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
  expect((await f.request("preview", { scope: { all: true }, mode: "list", input: "https://next.invalid:9001" })).status).toBe(200);
});

test("request abort retains the writer until an already-started row cleanup settles", async () => {
  const f = fixture();
  const preview = await f.preview();
  const waiting = f.hold(), entered = deferred();
  let calls = 0;
  f.setCleanup(async () => { if (++calls === 2) { entered.resolve(); await waiting.promise; } });
  const controller = new AbortController();
  const response = await f.request("apply", { previewId: preview.previewId }, { signal: controller.signal });
  const result = events(response);
  await entered.promise;
  controller.abort();
  const barrier = f.maintenance("switch");
  await tick(); expect(barrier.acquired()).toBe(false);
  waiting.resolve();
  await result; (await barrier.promise)();
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
});

test("cleanup failure waits for every other started inventory cleanup before releasing", async () => {
  const f = fixture(["p1", "p2"]);
  const preview = await f.preview();
  const waiting = f.hold(), entered = deferred();
  f.setCleanup(async id => {
    if (id === "p1") throw new Error("synthetic private failure must not reach receipt");
    entered.resolve(); await waiting.promise;
  });
  const response = await f.request("apply", { previewId: preview.previewId });
  await entered.promise;
  const barrier = f.maintenance("restore");
  await tick(); expect(barrier.acquired()).toBe(false);
  waiting.resolve();
  const output = await events(response); (await barrier.promise)();
  expect(output.some(event => event.type === "error")).toBe(true);
  expect(JSON.stringify(output)).not.toContain("private");
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
  expect(f.store.getProfile("p2")!.proxy!.host).toBe("old.invalid");
});

test("bad input and preview tokens release inner leases before a worker exists", async () => {
  const f = fixture();
  const preview = await f.preview();
  for (const request of [
    () => f.request("apply", "{", { raw: true }),
    () => f.request("apply", { previewId: "expired" }),
    () => f.request("apply", { previewId: preview.previewId, ids: [null] }),
  ]) {
    const response = await request();
    expect([400, 409]).toContain(response.status);
    await f.manager.settled();
    const barrier = f.maintenance("backup"); (await barrier.promise)();
  }
  expect((await events(await f.request("apply", { previewId: preview.previewId }))).at(-1)).toEqual({ type: "done" });
});

test("direct proxy handler preserves fixed 423 admission when maintenance is already busy", async () => {
  const f = fixture();
  const preview = await f.preview();
  const release = await f.manager.maintenance.acquire("backup");
  try {
    const response = await f.request("apply", { previewId: preview.previewId }, { dispatch: false });
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ ok: false, code: "workspace_busy", error: "Workspace maintenance is in progress. Try again after it finishes." });
  } finally { release(); }
  await f.manager.settled();
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
});

test("failure to construct a stream releases admission and does not leave apply busy", async () => {
  const f = fixture();
  const preview = await f.preview();
  const Stream = globalThis.ReadableStream;
  let response!: Response;
  try {
    globalThis.ReadableStream = class { constructor() { throw new Error("synthetic stream construction failure"); } } as unknown as typeof ReadableStream;
    response = await f.request("apply", { previewId: preview.previewId });
  } finally { globalThis.ReadableStream = Stream; }
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe("Proxy operation failed. Refresh and try again.");
  await f.manager.settled();
  const barrier = f.maintenance("backup"); (await barrier.promise)();
  expect((await events(await f.request("apply", { previewId: preview.previewId }))).at(-1)).toEqual({ type: "done" });
});

test("failure to construct Response after starting the worker still owns its actual write", async () => {
  const f = fixture();
  const preview = await f.preview();
  const waiting = f.hold(), entered = deferred();
  f.setCleanup(async () => { entered.resolve(); await waiting.promise; });
  const Original = globalThis.Response;
  let response!: Response;
  try {
    globalThis.Response = class extends Original {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (body instanceof ReadableStream) throw new Error("synthetic Response construction failure");
        super(body, init);
      }
    } as typeof Response;
    response = await f.request("apply", { previewId: preview.previewId });
  } finally { globalThis.Response = Original; }
  expect(response.status).toBe(500);
  await entered.promise;
  const barrier = f.maintenance("backup");
  await tick(); expect(barrier.acquired()).toBe(false);
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
  waiting.resolve(); await f.manager.settled(); (await barrier.promise)();
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("new.invalid");
});

test("a concurrent bad apply cannot clear the first worker state or leak another lease", async () => {
  const f = fixture();
  const preview = await f.preview();
  const waiting = f.hold(), entered = deferred();
  f.setCleanup(async () => { entered.resolve(); await waiting.promise; });
  const response = await f.request("apply", { previewId: preview.previewId });
  await entered.promise;
  expect((await f.request("apply", { previewId: preview.previewId })).status).toBe(409);
  expect((await f.request("retry-preview", { previewId: preview.previewId, ids: ["p1"] })).status).toBe(409);
  const barrier = f.maintenance("backup");
  await tick(); expect(barrier.acquired()).toBe(false);
  waiting.resolve();
  await events(response); (await barrier.promise)();
  await f.manager.settled();
});

test("write failures retain the fixed outcome and release the real worker lease", async () => {
  const f = fixture();
  const preview = await f.preview();
  const save = f.store.upsertProfile.bind(f.store);
  f.store.upsertProfile = profile => {
    if (profile.proxy?.host === "new.invalid") throw new Error("synthetic private database error");
    return save(profile);
  };
  const output = await events(await f.request("apply", { previewId: preview.previewId }));
  expect(output).toContainEqual(expect.objectContaining({ type: "replacement", row: expect.objectContaining({ status: "failed", code: "update_failed" }) }));
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(JSON.stringify(output)).not.toContain("private");
  await f.manager.settled();
  const barrier = f.maintenance("restore"); (await barrier.promise)();
});

test("preferred timezone result keeps the writer until redundant lookup abort cleanup settles", async () => {
  const f = fixture();
  const preview = await f.preview("http://new.invalid:9000");
  const waiting = f.hold(), aborted = deferred();
  let checks = 0;
  f.options.timezoneFetch = async (url, init) => {
    checks++;
    if (url.includes("geojs")) return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
    expect(init.signal).toBeDefined();
    await new Promise<void>(resolve => {
      if (init.signal!.aborted) resolve();
      else init.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted.resolve(); await waiting.promise;
    throw new DOMException("Synthetic request aborted", "AbortError");
  };
  const response = await f.request("apply", { previewId: preview.previewId });
  const result = events(response);
  await aborted.promise;
  const barrier = f.maintenance("backup");
  await tick();
  expect(barrier.acquired()).toBe(false);
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
  waiting.resolve();
  const output = await result; (await barrier.promise)();
  expect(checks).toBe(2);
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("new.invalid");
  expect(f.store.getProfile("p1")!.timezone).toBe("Europe/Paris");
});

test("cancelling receipt delivery during a lookup does not pretend its eventual write was cancelled", async () => {
  const f = fixture();
  const preview = await f.preview("http://new.invalid:9000");
  const waiting = f.hold(), entered = deferred();
  f.options.timezoneFetch = async url => {
    if (!url.includes("geojs")) return Response.json({});
    entered.resolve(); await waiting.promise;
    return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
  };
  const response = await f.request("apply", { previewId: preview.previewId });
  await entered.promise;
  await response.body!.cancel();
  const barrier = f.maintenance("backup");
  await tick();
  expect(barrier.acquired()).toBe(false);
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("old.invalid");
  waiting.resolve();
  await f.manager.settled(); (await barrier.promise)();
  expect(f.store.getProfile("p1")!.proxy!.host).toBe("new.invalid");
  expect(f.store.getProfile("p1")!.timezone).toBe("Europe/Paris");
});

for (const cancellation of ["response-reader", "request"] as const) {
  test(`tracked ${cancellation} cancellation reports the outcome after the real writer releases`, async () => {
    const f = fixture(["p1", "p2"]);
    const { operationScope, previewId } = await f.preview("http://new.invalid:9000\nhttp://new.invalid:9001");
    expect(operationScope).toBeDefined();
    const attemptId = crypto.randomUUID();
    const statusPath = `operations/${attemptId}?${new URLSearchParams({ operationScope: operationScope!, previewId })}`;
    const waiting = f.hold(), entered = deferred();
    f.options.timezoneFetch = async url => {
      if (!url.includes("geojs")) return Response.json({});
      entered.resolve();
      await waiting.promise;
      return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
    };
    const controller = new AbortController();
    const response = await f.request("apply", { operationScope, previewId, attemptId }, { signal: controller.signal });
    await entered.promise;
    if (cancellation === "response-reader") await response.body!.cancel();
    else controller.abort();
    const barrier = f.maintenance("backup");
    await tick();
    expect(barrier.acquired()).toBe(false);
    expect((await (await f.request(statusPath, undefined)).json()).operation.phase).toBe("running");
    waiting.resolve();
    await f.manager.settled();
    const release = await barrier.promise;
    try {
      const receipt = (await (await f.request(statusPath, undefined)).json()).operation;
      const wrote = cancellation === "response-reader";
      expect(receipt).toMatchObject({ phase: "settled", rows: [
        { index: 0, profileId: "p1", status: wrote ? "updated" : "not-started" },
        { index: 1, profileId: "p2", status: "not-started" },
      ] });
      expect(f.store.getProfile("p1")!.proxy!.host).toBe(wrote ? "new.invalid" : "old.invalid");
      expect(f.store.getProfile("p2")!.proxy!.host).toBe("old.invalid");
    } finally { release(); }
  });
}
