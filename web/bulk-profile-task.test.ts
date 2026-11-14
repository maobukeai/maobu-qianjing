import { expect, test } from "bun:test";
import { createBulkProfileTask, redactBulkTaskMessage, type BulkProfileTaskSnapshot } from "./bulk-profile-task.ts";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function tick() { for (let count = 0; count < 5; count++) await Promise.resolve(); }

test("batch dispatch is bounded at four, deduplicates targets, and preserves immutable snapshots", async () => {
  const calls: string[] = [], pending = new Map<string, ReturnType<typeof deferred>>();
  let active = 0, peak = 0;
  const task = createBulkProfileTask({ action: "open", concurrency: 99,
    targets: [...Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: `Environment ${index}`, ...(index === 7 ? { skipReason: "Already running" } : {}) })), { id: "0", name: "duplicate" }],
    run: id => {
      calls.push(id); active++; peak = Math.max(peak, active);
      const operation = deferred(); pending.set(id, operation);
      return operation.promise.finally(() => { active--; });
    } });
  const initial = task.getSnapshot();
  expect(task.getSnapshot()).toBe(initial);
  expect(initial.summary).toMatchObject({ total: 8, pending: 7, skipped: 1 });
  expect(Object.isFrozen(initial.rows[0])).toBe(true);
  const running = task.start();
  expect(task.start()).toBe(running);
  await tick(); expect(calls).toEqual(["0", "1", "2", "3"]); expect(peak).toBe(4);
  expect(initial.rows[0]!.status).toBe("pending");
  pending.get("0")!.resolve({ ok: true }); await tick(); expect(calls).toEqual(["0", "1", "2", "3", "4"]);
  for (const id of ["1", "2", "3"]) pending.get(id)!.resolve({ ok: true });
  await tick();
  for (const id of ["4", "5", "6"]) pending.get(id)!.resolve({ ok: true });
  const result = await running;
  expect(peak).toBe(4); expect(active).toBe(0);
  expect(result.phase).toBe("complete"); expect(result.summary).toMatchObject({ total: 8, succeeded: 7, skipped: 1, settled: 8 });
  expect(result.rows[7]).toMatchObject({ status: "skipped", cause: "ineligible", attempts: 0 });
  await task.start(); expect(calls).toHaveLength(7);
});

test("only ok true succeeds; returned errors, thrown errors and incomplete bodies remain individual failures", async () => {
  const task = createBulkProfileTask({ action: "close", targets: ["ok", "warning", "error", "missing", "throw", "primitive"].map(id => ({ id, name: id })),
    run: async id => {
      if (id === "ok") return { ok: true };
      if (id === "warning") return { ok: true, warning: "Browser returned a warning" };
      if (id === "error") return { ok: false, error: "Browser teardown unconfirmed" };
      if (id === "missing") return {};
      if (id === "primitive") return true;
      throw new Error("Cannot connect to http://operator:PRIVATE_TOKEN@proxy.example:8080; password=PRIVATE_PASSWORD");
    } });
  const result = await task.start();
  expect(result.summary).toMatchObject({ succeeded: 2, failed: 4, settled: 6 });
  expect(result.rows.find(row => row.id === "warning")).toMatchObject({ status: "succeeded", warning: "Browser returned a warning", attempts: 1 });
  expect(result.rows.find(row => row.id === "error")?.error).toBe("Browser teardown unconfirmed");
  expect(result.rows.find(row => row.id === "missing")?.error).toBe("The local service returned an incomplete action result.");
  expect(result.rows.find(row => row.id === "throw")?.error).toContain("[redacted]");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN"); expect(JSON.stringify(result)).not.toContain("PRIVATE_PASSWORD");
});

test("stop only skips requests not dispatched, then retry runs failed IDs without repeating success or stopped IDs", async () => {
  const calls: string[] = [], first = deferred(), second = deferred();
  const task = createBulkProfileTask({ action: "open", concurrency: 2, targets: Array.from({ length: 6 }, (_, index) => ({ id: String(index), name: String(index) })),
    run: id => { calls.push(id); return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : Promise.resolve({ ok: true }); } });
  const running = task.start(); await tick();
  expect(task.retryFailed()).toBeNull();
  task.stopPending(); const stopped = task.getSnapshot();
  expect(stopped.phase).toBe("stopping"); expect(stopped.summary).toMatchObject({ pending: 0, running: 2, skipped: 4, succeeded: 0 });
  expect(stopped.rows.slice(2).every(row => row.cause === "stopped" && row.attempts === 0)).toBe(true);
  task.stopPending(); expect(task.getSnapshot()).toBe(stopped);
  first.resolve({ ok: true }); second.resolve({ ok: false, error: "Temporary start failure" });
  const result = await running;
  expect(result.summary).toMatchObject({ succeeded: 1, failed: 1, skipped: 4 }); expect(calls).toEqual(["0", "1"]);
  const retry = task.retryFailed(); expect(retry).not.toBeNull();
  const retried = await retry!;
  expect(calls).toEqual(["0", "1", "1"]);
  expect(retried.summary).toMatchObject({ succeeded: 2, failed: 0, skipped: 4 });
  expect(retried.rows[1]!.attempts).toBe(2); expect(retried.rows[0]!.attempts).toBe(1);
  expect(retried.rows.slice(2).every(row => row.cause === "stopped" && row.attempts === 0)).toBe(true);
  expect(task.retryFailed()).toBeNull();
});

test("stopping before start sends nothing and cannot silently restart skipped work", async () => {
  let calls = 0;
  const task = createBulkProfileTask({ action: "close", targets: [{ id: "one", name: "One" }], run: async () => { calls++; return { ok: true }; } });
  task.stopPending();
  expect(task.getSnapshot().phase).toBe("complete");
  expect(task.getSnapshot().rows[0]).toMatchObject({ status: "skipped", cause: "stopped", attempts: 0 });
  await task.start(); expect(calls).toBe(0);
});

test("subscriber errors do not strand a batch, and repeated starts from a subscriber share one active promise", async () => {
  let calls = 0, observed: Promise<BulkProfileTaskSnapshot> | null = null;
  const task = createBulkProfileTask({ action: "open", targets: [{ id: "one", name: "One" }], run: async () => { calls++; return { ok: true }; } });
  task.subscribe(() => { throw new Error("Synthetic view failure"); });
  const unsubscribe = task.subscribe(() => { if (task.getSnapshot().phase === "running") observed = task.start(); });
  const started = task.start();
  expect(observed as unknown).toBe(started);
  const result = await started; unsubscribe();
  expect(result.phase).toBe("complete"); expect(calls).toBe(1);
});

test("a retry started by a completion subscriber cannot change the first promise's terminal result", async () => {
  let calls = 0, retry: Promise<BulkProfileTaskSnapshot> | null = null;
  const task = createBulkProfileTask({ action: "open", targets: [{ id: "one", name: "One" }], run: async () => ++calls === 1 ? { ok: false, error: "Try again" } : { ok: true } });
  task.subscribe(() => { if (!retry && task.getSnapshot().phase === "complete" && task.getSnapshot().summary.failed) retry = task.retryFailed(); });
  const first = await task.start();
  expect(first.phase).toBe("complete"); expect(first.summary.failed).toBe(1);
  await retry!;
  expect(task.getSnapshot().summary.failed).toBe(0); expect(calls).toBe(2);
});

test("credential redaction covers URL authority and legacy proxy forms without erasing the failure reason", () => {
  expect(redactBulkTaskMessage("Timeout at socks5://user:secret@proxy.example:1080; token=private")).toBe("Timeout at socks5://[redacted]@proxy.example:1080; token=[redacted]");
  expect(redactBulkTaskMessage("Failed proxy.example:8080:user:secret")).toBe("Failed proxy.example:8080:[redacted]");
  expect(redactBulkTaskMessage("x".repeat(1300))).toHaveLength(1201);
});

test("authentication schemes redact the complete Basic and Bearer credentials, including quoted header keys", () => {
  expect(redactBulkTaskMessage("Request refused: Authorization: Basic dXNlcjpzZWNyZXQ=; reason=407")).toBe("Request refused: Authorization=[redacted]; reason=407");
  expect(redactBulkTaskMessage("Proxy-Authorization: Bearer PRIVATE_JWT then refused")).toBe("Proxy-Authorization=[redacted] then refused");
  const json = redactBulkTaskMessage('{"Authorization":"Bearer PRIVATE_JSON_TOKEN","password":"PRIVATE_JSON_PASSWORD"}');
  expect(json).not.toContain("PRIVATE_JSON_TOKEN"); expect(json).not.toContain("PRIVATE_JSON_PASSWORD");
});
