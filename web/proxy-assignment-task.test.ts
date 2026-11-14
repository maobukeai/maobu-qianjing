import { expect, test } from "bun:test";
import { createProxyAssignmentTask, type ProxyAssignmentAttempt, type ProxyAssignmentSnapshot, type ProxyAssignmentTaskOptions } from "./proxy-assignment-task.ts";

const scope = "00000000-0000-4000-8000-000000000001";
const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const notFound = () => json({ ok: false, code: "operation_not_found" }, 404);
const row = (index: number, status = "ready", code?: string) => ({ index, profileId: `profile_${index}`, name: `Private environment ${index}`, group: "Private group", previousProxy: "http://old.invalid:8080", proxy: `http://new.invalid:${9000 + index}`, status, ...(code ? { code } : {}) });
type Row = ReturnType<typeof row>;
const preview = (rows: Row[], sequence = 1) => ({ ok: true, previewId: `${sequence}-${id(sequence + 10)}`, operationScope: scope, rows, unusedProxies: 0 });
const stream = (events: unknown[]) => new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
const savedRows = new WeakMap<Response, Row[]>();
const results = (rows: Row[]) => { const response = stream([...rows.map(row => ({ type: "replacement", row })), { type: "done" }]); savedRows.set(response, structuredClone(rows)); return response; };
const terminalRows = (rows: readonly Row[]) => rows.map(row => row.status === "ready" ? { ...row, status: "updated" } : { ...row });
const operation = (wire: ProxyAssignmentAttempt, phase: "running" | "settled" | "sealed" | "retired", rows: readonly Row[] = []) => ({
  ok: true, operation: { version: 1, ...wire, phase, total: ["sealed", "retired"].includes(phase) ? 0 : rows.length,
    rows: ["sealed", "retired"].includes(phase) ? [] : rows.map(({ index, profileId, status, code }) => ({ index, profileId, status, ...(code ? { code } : {}) })),
    startedAt: ["sealed", "retired"].includes(phase) ? null : 100, finishedAt: phase === "running" ? null : 200,
  },
});
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitFor(condition: () => boolean) { const end = Date.now() + 1500; while (!condition() && Date.now() < end) await tick(); expect(condition()).toBe(true); }

function fixture(initialRows = [row(0), row(1)]) {
  const initial = preview(initialRows), known = new Map([[initial.previewId, structuredClone(initialRows)]]);
  const applyCalls: ProxyAssignmentAttempt[] = [], statusCalls: ProxyAssignmentAttempt[] = [], seals: ProxyAssignmentAttempt[] = [], retries: Array<{ previewId: string; ids: readonly string[] }> = [];
  const sent = new Set<string>(); let workspace = "one", acquired = 0, released = 0, refreshing = 0, refreshes = 0, sequence = 100;
  const completed = new Map<string, Row[]>();
  let apply = async (wire: ProxyAssignmentAttempt) => results(terminalRows(known.get(wire.previewId)!));
  let status = async (wire: ProxyAssignmentAttempt) => json(operation(wire, "settled", completed.get(wire.attemptId) ?? terminalRows(known.get(wire.previewId)!)));
  let seal = async (wire: ProxyAssignmentAttempt) => json(operation(wire, "sealed"));
  let retry = async (request: { previewId: string; ids: readonly string[] }) => {
    const rows = known.get(request.previewId)!.filter(row => request.ids.includes(row.profileId)).map(row => ({ ...row, status: "ready", code: undefined }));
    const next = preview(rows, known.size + 1); known.set(next.previewId, rows); return json(next);
  };
  const options: ProxyAssignmentTaskOptions = {
    apply: async wire => { expect(Object.keys(wire).sort()).toEqual(["attemptId", "operationScope", "previewId"]); applyCalls.push(wire); sent.add(wire.attemptId); const response = await apply(wire); const saved = savedRows.get(response); if (saved) completed.set(wire.attemptId, saved); return response; },
    retryPreview: async request => { retries.push(request); return retry(request); },
    readStatus: async wire => { expect(Object.keys(wire).sort()).toEqual(["attemptId", "operationScope", "previewId"]); statusCalls.push(wire); return sent.has(wire.attemptId) ? status(wire) : notFound(); },
    closeUnseen: async wire => { expect(Object.keys(wire).sort()).toEqual(["attemptId", "operationScope", "previewId"]); seals.push(wire); return seal(wire); },
    workspaceId: () => workspace,
    acquire: () => { acquired++; let done = false; return { refreshing: () => { refreshing++; }, release: () => { if (!done) { done = true; released++; } } }; },
    refresh: async () => { refreshes++; }, makeAttemptId: () => id(sequence++), now: () => 300, pollDelayMs: 10_000,
  };
  const owner = createProxyAssignmentTask(options); expect(owner.adoptPreview(initial)).toBe(true);
  return { owner, initial, options, known, applyCalls, statusCalls, seals, retries,
    counts: () => ({ acquired, released, refreshing, refreshes }), setWorkspace: (next: string) => { workspace = next; },
    setApply: (next: typeof apply) => { apply = next; }, setStatus: (next: typeof status) => { status = next; }, setSeal: (next: typeof seal) => { seal = next; }, setRetry: (next: typeof retry) => { retry = next; },
  };
}

test("failed-only preview and retry preserve the original success, total and immutable receipt", async () => {
  const f = fixture();
  f.setApply(async () => results([row(0, "updated"), row(1, "failed", "update_failed")]));
  await f.owner.apply();
  const first = f.owner.getSnapshot().latest!;
  expect(first.summary).toMatchObject({ total: 2, updated: 1, failed: 1 });
  expect(await f.owner.prepareRetry()).toBe(true);
  expect(f.retries[0]!.ids).toEqual(["profile_1"]);
  expect(f.owner.getSnapshot()).toMatchObject({ summary: { total: 2, updated: 1, failed: 1 }, reviewNumbers: [2], latest: first });
  f.setApply(async () => results([row(1, "updated")]));
  await f.owner.apply();
  expect(f.owner.getSnapshot().summary).toMatchObject({ total: 2, updated: 2, failed: 0 });
  expect(f.owner.getSnapshot().rows.map(row => row.attempts)).toEqual([1, 2]);
  expect(f.owner.getSnapshot().history).toHaveLength(2);
  expect(first.summary).toMatchObject({ total: 2, updated: 1, failed: 1 });
  expect(Object.isFrozen(first.rows[0])).toBe(true);
  expect(f.applyCalls).toHaveLength(2);
});

test("same-frame apply guard includes the read-only protocol preflight", async () => {
  const f = fixture(), gate = deferred<Response>();
  const readStatus = f.options.readStatus;
  f.options.readStatus = async () => gate.promise;
  const pending = f.owner.apply();
  expect(await f.owner.apply()).toBeNull(); expect(f.owner.getSnapshot().phase).toBe("preflighting");
  expect(f.applyCalls).toHaveLength(0); expect(f.counts().acquired).toBe(1);
  gate.resolve(notFound()); f.options.readStatus = readStatus; await pending;
  expect(f.applyCalls).toHaveLength(1); expect(f.counts().released).toBe(1);
});

test("an older server or unavailable recovery protocol cannot trigger a blind apply", async () => {
  const f = fixture();
  f.options.readStatus = async () => json({ ok: false, error: "Old server" }, 404);
  expect(await f.owner.apply()).toBeNull();
  expect(f.applyCalls).toHaveLength(0);
  expect(f.owner.getSnapshot()).toMatchObject({ busy: false, phase: "review", notice: "recovery-unavailable", reviewNumbers: [1, 2] });
  expect(f.counts().released).toBe(1);
});

test("an already-used attempt ID is not sent again", async () => {
  const f = fixture();
  f.options.readStatus = async wire => json(operation(wire, "settled", [row(0, "updated"), row(1, "updated")]));
  expect(await f.owner.apply()).toBeNull(); expect(f.applyCalls).toHaveLength(0); expect(f.counts().released).toBe(1);
});

test("same-frame retry preview guard keeps the existing receipt intact", async () => {
  const f = fixture(); f.setApply(async () => results([row(0, "updated"), row(1, "failed", "update_failed")])); await f.owner.apply();
  const gate = deferred<Response>(); f.setRetry(async () => gate.promise);
  const pending = f.owner.prepareRetry(); expect(await f.owner.prepareRetry()).toBe(false);
  expect(f.retries).toHaveLength(1); expect(f.owner.getSnapshot().summary.updated).toBe(1);
  gate.resolve(json(preview([row(1)], 2))); expect(await pending).toBe(true);
  expect(f.owner.getSnapshot().summary.total).toBe(2); expect(f.counts().released).toBe(2);
});

for (const [name, events] of [
  ["missing coverage", [{ type: "replacement", row: row(0, "updated") }, { type: "done" }]],
  ["duplicate index", [{ type: "replacement", row: row(0, "updated") }, { type: "replacement", row: row(0, "updated") }, { type: "replacement", row: row(1, "updated") }, { type: "done" }]],
  ["wrong profile identity", [{ type: "replacement", row: { ...row(0, "updated"), profileId: "other_profile" } }, { type: "done" }]],
  ["unreviewed index", [{ type: "replacement", row: row(99, "updated") }, { type: "done" }]],
  ["changed assignment", [{ type: "replacement", row: { ...row(0, "updated"), proxy: "http://changed.invalid:9000" } }, { type: "done" }]],
  ["event after done", [{ type: "replacement", row: row(0, "updated") }, { type: "replacement", row: row(1, "updated") }, { type: "done" }, { type: "progress", phase: "applying", completed: 2, total: 2 }]],
  ["negative progress", [{ type: "progress", phase: "applying", completed: -1, total: 2 }]],
  ["array enum", [{ type: "replacement", row: { ...row(0, "updated"), status: ["updated"] } }]],
] as const) {
  test(`strict stream ${name} reconciles without replay or releasing the writer early`, async () => {
    const f = fixture(), gate = deferred<Response>();
    f.setApply(async () => stream([...events])); f.setStatus(async () => gate.promise);
    const pending = f.owner.apply();
    try {
      await waitFor(() => f.owner.getSnapshot().phase === "reconciling" && f.statusCalls.length >= 2);
      expect(f.counts().released).toBe(0); expect(f.owner.getSnapshot().summary.unknown).toBe(2);
      expect(f.owner.getSnapshot().latest).toBeNull(); expect(f.applyCalls).toHaveLength(1);
    } finally { gate.resolve(json(operation(f.applyCalls[0]!, "settled", [row(0, "updated"), row(1, "updated")]))); await pending; }
    expect(f.owner.getSnapshot().latest?.source).toBe("status"); expect(f.owner.getSnapshot().summary.updated).toBe(2);
    expect(f.applyCalls).toHaveLength(1); expect(f.counts().released).toBe(1);
  });
}

test("unknown delivery seals an unseen request instead of retrying the write", async () => {
  const f = fixture(); f.setApply(async () => { throw new Error("PRIVATE_PROXY_CREDENTIALS"); }); f.setStatus(async () => notFound());
  await f.owner.apply();
  expect(f.applyCalls).toHaveLength(1); expect(f.seals).toHaveLength(1);
  expect(f.owner.getSnapshot().summary).toMatchObject({ total: 2, notStarted: 2, updated: 0 });
  expect(f.owner.getSnapshot().latest?.source).toBe("seal");
  expect(JSON.stringify(f.owner.getSnapshot())).not.toContain("PRIVATE_PROXY_CREDENTIALS");
});

test("running status retains ownership through all strict refresh work after the worker ends", async () => {
  const f = fixture(), refresh = deferred(); let terminal = false;
  f.setApply(async () => { throw new Error("Connection lost"); });
  f.setStatus(async wire => json(operation(wire, terminal ? "settled" : "running", terminal ? [row(0, "updated"), row(1, "updated")] : [row(0), row(1)])));
  f.options.refresh = async () => refresh.promise;
  const pending = f.owner.apply();
  try {
    await waitFor(() => f.owner.getSnapshot().phase === "reconciling" && f.statusCalls.length >= 2);
    expect(f.counts().released).toBe(0); expect(f.owner.isBusy()).toBe(true);
    terminal = true; f.owner.reconcileNow();
    await waitFor(() => f.owner.getSnapshot().phase === "refreshing");
    expect(f.counts().released).toBe(0); expect(f.owner.getSnapshot().summary.updated).toBe(2);
  } finally { terminal = true; f.owner.reconcileNow(); refresh.resolve(); await pending; }
  expect(f.counts().released).toBe(1); expect(f.applyCalls).toHaveLength(1);
});

test("stopping receipt delivery or unsubscribing the view cannot cancel the task owner", async () => {
  const f = fixture(); let terminal = false, cancelled = false;
  f.setApply(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "replacement", row: row(0, "updated") }) + "\n" + JSON.stringify({ type: "progress", phase: "applying", completed: 1, total: 2 }) + "\n"));
  }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/x-ndjson" } }));
  f.setStatus(async wire => json(operation(wire, terminal ? "settled" : "running", [row(0, "updated"), row(1, terminal ? "updated" : "ready")])));
  let publications = 0; const unsubscribe = f.owner.subscribe(() => { publications++; });
  const pending = f.owner.apply();
  try {
    await waitFor(() => f.owner.getSnapshot().progress?.completed === 1);
    expect(f.owner.stopReceiving()).toBe(true); unsubscribe();
    await waitFor(() => f.owner.getSnapshot().phase === "reconciling" && f.statusCalls.length >= 2);
    expect(cancelled).toBe(true); expect(f.counts().released).toBe(0);
    expect(f.owner.getSnapshot().summary.updated).toBe(1); expect(f.owner.getSnapshot().receivingStopped).toBe(true);
  } finally { unsubscribe(); terminal = true; f.owner.reconcileNow(); await pending; }
  expect(publications).toBeGreaterThan(0); expect(f.owner.getSnapshot().summary.updated).toBe(2); expect(f.applyCalls).toHaveLength(1);
});

test("retired is a terminal fence with unknown outcomes and waits for successful strict reread", async () => {
  const f = fixture(); let canRefresh = false, refreshes = 0;
  f.setApply(async () => { throw new Error("Connection lost"); }); f.setStatus(async wire => json(operation(wire, "retired")));
  f.options.refresh = async () => { refreshes++; if (!canRefresh) throw new Error("Inert roster read failed"); };
  const pending = f.owner.apply();
  try {
    await waitFor(() => f.owner.getSnapshot().notice === "refresh-unavailable");
    expect(f.owner.getSnapshot().summary).toMatchObject({ total: 2, unknown: 2, notStarted: 0, retryable: 0 });
    expect(f.counts().released).toBe(0); expect(f.owner.isBusy()).toBe(true);
  } finally { canRefresh = true; f.owner.reconcileNow(); await pending; }
  expect(refreshes).toBe(2); expect(f.statusCalls).toHaveLength(2);
  expect(f.owner.getSnapshot().latest).toMatchObject({ source: "retired", refreshFailed: false }); expect(f.counts().released).toBe(1);
});

test("a service-scope mismatch never proves terminal and never automatically seals or replays", async () => {
  const f = fixture(); let validScope = false;
  f.setApply(async () => { throw new Error("Connection lost"); });
  f.setStatus(async wire => validScope ? json(operation(wire, "settled", [row(0, "updated"), row(1, "updated")])) : json({ ok: false, code: "operation_scope_mismatch" }, 404));
  const pending = f.owner.apply();
  try {
    await waitFor(() => f.owner.getSnapshot().notice === "status-unavailable"); expect(f.counts().released).toBe(0); expect(f.seals).toHaveLength(0);
  } finally { validScope = true; f.owner.reconcileNow(); await pending; }
  expect(f.applyCalls).toHaveLength(1);
});

test("a malformed status cannot replace a confirmed first-attempt success", async () => {
  const f = fixture(); f.setApply(async () => results([row(0, "updated"), row(1, "failed", "update_failed")])); await f.owner.apply(); await f.owner.prepareRetry();
  let valid = false; f.setApply(async () => { throw new Error("Connection lost"); });
  f.setStatus(async wire => valid ? json(operation(wire, "settled", [row(1, "updated")])) : json(operation(wire, "settled", [row(0, "updated")])));
  const pending = f.owner.apply();
  try {
    await waitFor(() => f.owner.getSnapshot().notice === "status-unavailable"); expect(f.owner.getSnapshot().summary).toMatchObject({ total: 2, updated: 1, unknown: 1 });
    expect(f.counts().released).toBe(2);
  } finally { valid = true; f.owner.reconcileNow(); await pending; }
  expect(f.owner.getSnapshot().summary.updated).toBe(2); expect(f.applyCalls).toHaveLength(2);
});

for (const [name, changed] of [
  ["different ID", { ...row(1), profileId: "hijacked_profile" }],
  ["different index", { ...row(1), index: 0 }],
  ["different target", { ...row(1), proxy: "http://hijacked.invalid:9001" }],
] as const) {
  test(`retry preview rejects ${name} while preserving the original aggregate`, async () => {
    const f = fixture(); f.setApply(async () => results([row(0, "updated"), row(1, "failed", "update_failed")])); await f.owner.apply();
    f.setRetry(async () => json(preview([{ ...changed }], 2)));
    expect(await f.owner.prepareRetry()).toBe(false);
    expect(f.owner.getSnapshot()).toMatchObject({ summary: { total: 2, updated: 1, failed: 1 }, notice: "retry-unavailable", reviewNumbers: [] });
    expect(f.applyCalls).toHaveLength(1);
  });
}

test("the original workspace is required for retry and busy maintenance blocks before any post", async () => {
  const f = fixture(); f.setApply(async () => results([row(0, "updated"), row(1, "failed", "update_failed")])); await f.owner.apply();
  f.setWorkspace("two"); expect(await f.owner.prepareRetry()).toBe(false); expect(f.retries).toHaveLength(0);
  expect(f.owner.getSnapshot().notice).toBe("workspace-changed");
  f.setWorkspace("one"); await f.owner.prepareRetry(); f.options.acquire = () => null;
  expect(await f.owner.apply()).toBeNull(); expect(f.applyCalls).toHaveLength(1); expect(f.owner.getSnapshot().notice).toBe("workspace-busy");
});

test("known saves remain confirmed when refresh fails and read-only refresh never repeats writes", async () => {
  const f = fixture(); let fail = true;
  f.options.refresh = async () => { if (fail) throw new Error("Inert read failure"); };
  await f.owner.apply();
  expect(f.owner.getSnapshot()).toMatchObject({ summary: { updated: 2 }, refreshFailed: true, busy: false });
  fail = false;
  expect(await f.owner.refreshResult()).toBe(true);
  expect(f.owner.getSnapshot().history).toHaveLength(1); expect(f.owner.getSnapshot().refreshFailed).toBe(false); expect(f.applyCalls).toHaveLength(1);
});

test("private metadata and tokens never enter snapshots, history or transport extras", async () => {
  const privateRows = [row(0), row(1)].map(row => ({ ...row, name: "PRIVATE_PROXY_PASSWORD", group: "PRIVATE_PROXY_USERNAME", proxy: row.proxy.replace("http://", "http://PRIVATE_PROXY_USERNAME:PRIVATE_PROXY_PASSWORD@") }));
  const f = fixture(privateRows), captured: ProxyAssignmentSnapshot[] = [];
  f.owner.subscribe(() => { captured.push(f.owner.getSnapshot()); });
  f.initial.rows[0]!.profileId = "mutated_after_review"; f.initial.rows[0]!.proxy = "http://mutated.invalid:9000";
  await f.owner.apply();
  const safe = JSON.stringify(captured);
  for (const secret of ["PRIVATE_PROXY_PASSWORD", "PRIVATE_PROXY_USERNAME", "new.invalid", "old.invalid", "profile_0", "profile_1", scope, f.initial.previewId, f.applyCalls[0]!.attemptId]) expect(safe).not.toContain(secret);
  expect(f.owner.getSnapshot().summary.updated).toBe(2);
});

test("throwing attempt ID factories and view subscribers cannot leak a lease or repeat a write", async () => {
  const f = fixture(); f.options.makeAttemptId = () => { throw new Error("PRIVATE error"); };
  expect(await f.owner.apply()).toBeNull(); expect(f.counts()).toMatchObject({ acquired: 1, released: 1 }); expect(f.applyCalls).toHaveLength(0);
  f.options.makeAttemptId = () => id(500); f.owner.subscribe(() => { throw new Error("Inert subscriber error"); });
  await f.owner.apply(); expect(f.applyCalls).toHaveLength(1); expect(f.counts()).toMatchObject({ acquired: 2, released: 2 });
});

test("5000 real progress rows use bounded aggregate publications and preserve every original outcome", async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => row(index)), f = fixture(rows);
  let publications = 0; const completed: number[] = [];
  f.owner.subscribe(() => { publications++; const p = f.owner.getSnapshot().progress; if (p?.phase === "applying") completed.push(p.completed); });
  f.setApply(async () => stream([
    { type: "progress", phase: "loading", completed: 0, total: 1 }, { type: "progress", phase: "loading", completed: 1, total: 1 },
    { type: "progress", phase: "applying", completed: 0, total: rows.length },
    ...rows.flatMap(row => [{ type: "replacement", row: { ...row, status: "updated" } }, { type: "progress", phase: "applying", completed: row.index + 1, total: rows.length }]), { type: "done" },
  ]));
  await f.owner.apply();
  expect(publications).toBeLessThan(120); expect(completed.at(-1)).toBe(5000);
  expect(completed.every((count, index) => index === 0 || count >= completed[index - 1]!)).toBe(true);
  expect(f.owner.getSnapshot().summary).toMatchObject({ total: 5000, updated: 5000, unknown: 0 });
  expect(f.owner.getSnapshot().rows.every((row, index) => row.number === index + 1 && row.attempts === 1)).toBe(true);
}, 10_000);
