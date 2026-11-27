import { expect, test } from "bun:test";
import { WorkspaceBusyError, WorkspaceMaintenance, workspaceRequestMutates } from "../src/workspace-maintenance.ts";

test("maintenance waits for admitted changes and blocks new writers until release", async () => {
  const gate = new WorkspaceMaintenance();
  let finish!: () => void;
  const write = gate.mutation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const acquired = gate.acquire("backup");
  expect(gate.busy()).toBe(true);
  expect(() => gate.assertWritable()).toThrow(WorkspaceBusyError);
  await expect(gate.mutation(async () => "new write")).rejects.toThrow(WorkspaceBusyError);
  finish(); await write;
  const release = await acquired;
  expect(gate.busy()).toBe(true);
  release(); release();
  expect(await gate.mutation(async () => 42)).toBe(42);
});

test("failed maintenance and drain timeout release the barrier", async () => {
  const gate = new WorkspaceMaintenance();
  await expect(gate.exclusive(async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(gate.busy()).toBe(false);
  let finish!: () => void;
  const write = gate.mutation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await expect(gate.acquire("restore", 5)).rejects.toThrow("Existing workspace changes");
  expect(gate.busy()).toBe(false);
  finish(); await write;
});

test("legacy GET lifecycle requests are guarded while dashboard reads remain available", () => {
  expect(workspaceRequestMutates(new Request("http://127.0.0.1/api/v1/browser/start?user_id=x"))).toBe(true);
  expect(workspaceRequestMutates(new Request("http://127.0.0.1/ui/api/profiles", { method: "POST" }))).toBe(true);
  expect(workspaceRequestMutates(new Request("http://127.0.0.1/ui/api/profiles"))).toBe(false);
  expect(workspaceRequestMutates(new Request("http://127.0.0.1/"))).toBe(false);
});

test("owned cleanup waits for a snapshot but remains available during a restart", async () => {
  const gate = new WorkspaceMaintenance();
  const release = await gate.acquire("backup");
  let cleaned = false;
  const cleanup = gate.cleanup(async () => { cleaned = true; });
  await Promise.resolve(); expect(cleaned).toBe(false);
  release(); await cleanup; expect(cleaned).toBe(true);
  const restarting = await gate.acquire("switch");
  expect(await gate.cleanup(async () => "closed")).toBe("closed");
  restarting();
});

test("explicit streaming writer outlives its response wrapper and releases exactly once", async () => {
  const gate = new WorkspaceMaintenance();
  let finishStream!: () => void;
  expect(await gate.mutation(async () => {
    finishStream = gate.acquireMutationLease();
    return "response headers";
  })).toBe("response headers");
  let ready = false;
  const acquired = gate.acquire("backup").then(release => { ready = true; return release; });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(() => gate.acquireMutationLease()).toThrow(WorkspaceBusyError);
  finishStream(); finishStream();
  const release = await acquired;
  expect(ready).toBe(true);
  release();
  const next = gate.acquireMutationLease();
  let nextReady = false;
  const nextAcquire = gate.acquire("restore").then(release => { nextReady = true; return release; });
  await Promise.resolve(); expect(nextReady).toBe(false);
  next(); (await nextAcquire)();
});
