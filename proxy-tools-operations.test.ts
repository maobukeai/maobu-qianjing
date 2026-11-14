import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import type { Launcher } from "./launcher.ts";
import type { ProxyOperationBinding } from "./proxy-operation-state.ts";
import type { ProxyPreview } from "./proxy-tools-types.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { createProxyAssignmentTask } from "./web/proxy-assignment-task.ts";

const fixtures = new Set<ProfileStore>();
afterEach(() => { for (const store of fixtures) store.close(); fixtures.clear(); });
const oldProxy = { type: "https" as const, host: "old.invalid", port: "8080", user: "old-user", pass: "old-private" };

function fixture(ids = ["p1", "p2"]) {
  const store = new ProfileStore(":memory:");
  fixtures.add(store);
  for (const id of ids) {
    store.upsertProfile({ ...buildNewProfile({ name: `Sensitive name ${id}`, group: "synthetic", proxy: oldProxy }, () => false), id });
  }
  const blocked = new Set<string>();
  let cleanup = async () => {};
  const launcher = {
    cacheCleanupSettled: () => cleanup(),
    profileDeletionBlocked: (id: string) => blocked.has(id),
  } as unknown as Launcher;
  const options: UiRuntimeOptions = { timezoneFetch: async () => Response.json({}) };
  const request = async (action: string, body?: unknown, signal?: AbortSignal, headers?: HeadersInit) => (await handleUiRequest(new Request(
    `http://127.0.0.1:55444/ui/api/proxies/${action}`,
    body === undefined ? { headers, signal } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal },
  ), launcher, store, options))!;
  const preview = async () => {
    const response = await request("preview", { scope: { all: true }, mode: "list", input: "https://private-user:private-pass@new.invalid:9000\nhttps://new.invalid:9001" });
    expect(response.status).toBe(200);
    return await response.json() as ProxyPreview & { operationScope: string };
  };
  const status = (value: ProxyOperationBinding) => request(`operations/${value.attemptId}?${new URLSearchParams({ operationScope: value.operationScope, previewId: value.previewId })}`);
  const reconcile = (value: ProxyOperationBinding, headers?: HeadersInit) => request(`operations/${value.attemptId}/reconcile`, { operationScope: value.operationScope, previewId: value.previewId }, undefined, headers);
  return { store, blocked, request, preview, status, reconcile, setCleanup: (next: () => Promise<void>) => { cleanup = next; } };
}

test("pending and repeated tracked applies share one worker and expose a redacted terminal receipt", async () => {
  const f = fixture();
  const { previewId, operationScope } = await f.preview();
  const binding = { previewId, operationScope, attemptId: crypto.randomUUID() };
  const initial = await f.status(binding);
  expect(initial.status).toBe(404);
  expect(await initial.json()).toEqual({ ok: false, code: "operation_not_found" });

  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.setCleanup(() => waiting);
  const writes: string[] = [];
  f.store.onProfileSaved = profile => { writes.push(profile.id); };
  const response = await f.request("apply", binding);
  try {
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const status = await f.status(binding);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const running = await status.json();
    expect(running.operation).toMatchObject({ ...binding, version: 1, phase: "running", total: 2, finishedAt: null });
    expect(await (await f.request("apply", binding)).json()).toEqual(running);
    expect(await (await f.reconcile(binding)).json()).toEqual(running);
    expect((await f.request("apply", { ...binding, ids: ["p1"] })).status).toBe(409);
    expect(writes).toEqual([]);
  } finally { release(); await response.text(); }

  const settled = await (await f.status(binding)).json();
  expect(settled.operation).toMatchObject({ phase: "settled", rows: [
    { index: 0, profileId: "p1", status: "updated" },
    { index: 1, profileId: "p2", status: "updated" },
  ] });
  expect(JSON.stringify(settled)).not.toMatch(/old\.invalid|new\.invalid|private-pass|Sensitive name|synthetic/);
  await f.preview();
  expect(await (await f.request("apply", binding)).json()).toEqual(settled);
  expect(writes).toEqual(["p1", "p2"]);
});

test("reconcile seals a delayed apply without writing and refuses a foreign origin or server scope", async () => {
  const f = fixture(["p1"]);
  const { previewId, operationScope } = await f.preview();
  const binding = { previewId, operationScope, attemptId: crypto.randomUUID() };

  expect((await f.reconcile(binding, { Origin: "https://foreign.invalid" })).status).toBe(403);
  const foreign = await f.reconcile({ ...binding, operationScope: crypto.randomUUID() });
  expect(foreign.status).toBe(404);
  expect((await foreign.json()).code).toBe("operation_scope_mismatch");

  const sealed = await (await f.reconcile(binding)).json();
  expect(sealed.operation).toMatchObject({ ...binding, phase: "sealed", total: 0, rows: [], startedAt: null });
  expect(await (await f.request("apply", binding)).json()).toEqual(sealed);
  expect(f.store.getProfile("p1")?.proxy).toEqual(oldProxy);
});

test("a recreated profile cannot receive a reviewed replacement or a failed-only retry", async () => {
  const f = fixture(["p1"]);
  const { previewId, operationScope } = await f.preview();
  const original = f.store.getProfile("p1")!;
  f.store.deleteProfile(original.id);
  f.store.upsertProfile(original);
  const binding = { previewId, operationScope, attemptId: crypto.randomUUID() };
  await (await f.request("apply", binding)).text();
  const outcome = await (await f.status(binding)).json();
  expect(outcome.operation.rows).toEqual([{ index: 0, profileId: "p1", status: "skipped", code: "version_conflict" }]);
  const retry = await (await f.request("retry-preview", { previewId, ids: ["p1"] })).json();
  expect(retry.rows[0].status).toBe("skipped");
  expect(f.store.getProfile("p1")?.proxy).toEqual(oldProxy);
});

test("an environment recreated during per-row cleanup keeps its original proxy", async () => {
  const f = fixture(["p1"]);
  const { previewId, operationScope } = await f.preview();
  const original = f.store.getProfile("p1")!;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let cleanups = 0;
  f.setCleanup(async () => { if (++cleanups === 2) { entered(); await waiting; } });
  const binding = { previewId, operationScope, attemptId: crypto.randomUUID() };
  const response = await f.request("apply", binding);
  try {
    await ready;
    f.store.deleteProfile(original.id);
    f.store.upsertProfile(original);
  } finally { release(); await response.text(); }

  const result = await (await f.status(binding)).json();
  expect(result.operation.rows).toEqual([{ index: 0, profileId: "p1", status: "skipped", code: "version_conflict" }]);
  expect(f.store.getProfile("p1")?.proxy).toEqual(oldProxy);
});

test("the actual assignment owner reconciles a partial write and keeps the first success across retries", async () => {
  const f = fixture();
  const preview = await f.preview();
  f.blocked.add("p2");
  const writes: string[] = [];
  f.store.onProfileSaved = profile => { writes.push(profile.id); };
  let refreshes = 0, leases = 0;
  const task = createProxyAssignmentTask({
    apply: (attempt, signal) => f.request("apply", attempt, signal),
    retryPreview: (request, signal) => f.request("retry-preview", request, signal),
    readStatus: f.status,
    closeUnseen: f.reconcile,
    refresh: async () => { expect(leases).toBe(1); refreshes++; },
    acquire: () => { expect(leases).toBe(0); leases++; return { release: () => { leases--; } }; },
  });

  expect(task.adoptPreview(preview)).toBe(true);
  expect((await task.apply())?.summary).toMatchObject({ total: 2, updated: 1, skipped: 1, retryable: 1 });
  expect(writes).toEqual(["p1"]);
  f.blocked.clear();
  expect(await task.prepareRetry()).toBe(true);
  expect(task.getSnapshot().summary).toMatchObject({ total: 2, updated: 1 });
  expect((await task.apply())?.summary).toMatchObject({ total: 2, updated: 2, skipped: 0, retryable: 0 });
  expect(writes).toEqual(["p1", "p2"]);
  expect(refreshes).toBe(2);
  expect(leases).toBe(0);
}, 4000);
