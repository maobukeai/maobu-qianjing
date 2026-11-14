import { expect, test } from "bun:test";
import type { ScriptRun } from "../scripts.ts";
import { copyObservedScriptRun, createBackgroundScriptRunStore } from "./background-script-run-state.ts";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function run(id = "run_one", status: ScriptRun["status"] = "running"): ScriptRun { return { id, scriptName: id, status, profiles: [{ id: "one", name: "One", status: status === "finished" ? "succeeded" : "running" }] }; }
function timers() {
  let id = 0; const pending = new Map<number, { callback: () => void; delay: number }>();
  return { pending, setTimer: (callback: () => void, delay: number) => { pending.set(++id, { callback, delay }); return id; }, clearTimer: (timer: number | ReturnType<typeof setTimeout>) => { pending.delete(timer as number); }, fire() { const item = [...pending.entries()][0]; if (!item) throw new Error("No observer timer"); pending.delete(item[0]); item[1].callback(); return item[1].delay; } };
}
async function tick() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test("passive subscriptions make no idle discovery requests and share one observer after a real run", async () => {
  const clock = timers(); let reads = 0;
  const store = createBackgroundScriptRunStore({ ...clock, read: async () => { reads++; return run(); } });
  const first = store.subscribe(() => {}), second = store.subscribe(() => {});
  await tick(); expect(reads).toBe(0); expect(clock.pending.size).toBe(0); expect(store.getSnapshot().state).toBe("idle");
  await store.refresh(); expect(reads).toBe(1); expect(clock.pending.size).toBe(1);
  clock.fire(); await tick(); expect(reads).toBe(2); expect(clock.pending.size).toBe(1);
  first(); expect(clock.pending.size).toBe(1); second(); expect(clock.pending.size).toBe(0); store.dispose();
});
test("explicit views and the background observer share one pending GET, including reentrant subscribers", async () => {
  const response = deferred<ScriptRun | null>(); let reads = 0, reentrant: Promise<ScriptRun | null> | undefined;
  const store = createBackgroundScriptRunStore({ read: () => { reads++; return response.promise; } });
  const unsubscribe = store.subscribe(() => { if (store.getSnapshot().refreshing && !reentrant) reentrant = store.refresh(); });
  const first = store.refresh(), second = store.refresh(); expect(second).toBe(first); expect(reentrant!).toBe(first);
  await tick(); expect(reads).toBe(1); response.resolve(run()); await first;
  expect(store.getSnapshot().run?.id).toBe("run_one"); unsubscribe(); store.dispose();
});
test("an earlier GET cannot replace a newer successful start and its old promise returns current state", async () => {
  const clock = timers(), response = deferred<ScriptRun | null>(); let reads = 0;
  const store = createBackgroundScriptRunStore({ ...clock, read: () => { reads++; return response.promise; } });
  const unsubscribe = store.subscribe(() => {}), pending = store.refresh(); await tick();
  store.observe(run("new_post_run")); expect(clock.pending.size).toBe(0);
  response.resolve(run("old_get_run", "finished")); expect((await pending)?.id).toBe("new_post_run");
  expect(store.getSnapshot().run?.id).toBe("new_post_run"); expect(reads).toBe(1); expect(clock.pending.size).toBe(1); unsubscribe(); store.dispose();
});
test("an obsolete GET failure cannot mark a newer successful start unavailable", async () => {
  const response = deferred<ScriptRun | null>();
  const store = createBackgroundScriptRunStore({ read: () => response.promise });
  const pending = store.refresh(); await tick(); store.observe(run("new_run")); response.reject(new Error("old failure"));
  expect((await pending)?.id).toBe("new_run"); expect(store.getSnapshot()).toMatchObject({ state: "running", error: null }); store.dispose();
});
test("finished status retains the run and accurate totals while stopping automatic polling", async () => {
  const clock = timers(); const store = createBackgroundScriptRunStore({ ...clock, read: async () => run("complete", "finished") });
  const unsubscribe = store.subscribe(() => {}); store.observe(run("complete")); expect(clock.pending.size).toBe(1);
  clock.fire(); await tick(); expect(store.getSnapshot()).toMatchObject({ state: "finished", run: { id: "complete" }, summary: { total: 1, succeeded: 1, settled: 1 } });
  expect(clock.pending.size).toBe(0); unsubscribe(); store.dispose();
});
test("failed or missing status is visibly unconfirmed and never invented as successful completion", async () => {
  const clock = timers(); let missing = false;
  const store = createBackgroundScriptRunStore({ ...clock, read: async () => { if (missing) return null; throw new Error("token=PRIVATE credential detail"); } });
  const unsubscribe = store.subscribe(() => {}); store.observe(run());
  await expect(store.refresh()).rejects.toThrow("PRIVATE");
  expect(store.getSnapshot()).toMatchObject({ state: "unavailable", run: { id: "run_one", status: "running" }, summary: { succeeded: 0 } });
  expect(store.getSnapshot().error).not.toContain("PRIVATE"); expect([...clock.pending.values()][0]?.delay).toBe(2000);
  missing = true; await store.refresh(); expect(store.getSnapshot().state).toBe("unavailable"); expect(store.getSnapshot().error).toContain("no longer available");
  unsubscribe(); store.dispose();
});
test("shared run views have an allowlist, redact error authentication and freeze their copied data", () => {
  const source = { ...run(), source: "PRIVATE_SOURCE", credentials: { password: "PRIVATE_PASSWORD" }, inputs: { secret: "PRIVATE_INPUT" }, log: "PRIVATE_LOG", profiles: [{ ...run().profiles[0], error: "Proxy failure http://user:PRIVATE_TOKEN@proxy.invalid; password=PRIVATE_ERROR", credentials: "PRIVATE_PROFILE_CREDENTIALS" }] };
  const copied = copyObservedScriptRun(source);
  expect(Object.keys(copied).sort()).toEqual(["id", "profiles", "scriptName", "status"]);
  for (const secret of ["PRIVATE_SOURCE", "PRIVATE_PASSWORD", "PRIVATE_INPUT", "PRIVATE_LOG", "PRIVATE_TOKEN", "PRIVATE_ERROR", "PRIVATE_PROFILE_CREDENTIALS"]) expect(JSON.stringify(copied)).not.toContain(secret);
  expect(copied.profiles[0]?.error).toContain("Proxy failure"); expect(Object.isFrozen(copied)).toBe(true); expect(Object.isFrozen(copied.profiles)).toBe(true); expect(Object.isFrozen(copied.profiles[0])).toBe(true);
});
test("incomplete status bodies fail closed instead of producing a fabricated background run", async () => {
  for (const value of [{}, { ...run(), status: "unknown" }, { ...run(), profiles: [{ id: "one", name: "One", status: "unknown" }] }, { ...run(), profiles: [...run().profiles, ...run().profiles] }]) {
    expect(() => copyObservedScriptRun(value)).toThrow("incomplete script run status");
  }
  const store = createBackgroundScriptRunStore({ read: async () => ({}) as ScriptRun });
  await expect(store.refresh()).rejects.toThrow("incomplete script run status"); expect(store.getSnapshot().run).toBeNull(); store.dispose();
});
