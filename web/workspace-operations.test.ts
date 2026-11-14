import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createWorkspaceOperationCoordinator, workspaceOperationMessage } from "./workspace-operations.tsx";

function deferred() { let done!: () => void; const promise = new Promise<void>(yes => { done = yes; }); return { promise, done }; }
const ready = () => createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });

describe("workspace operation ownership", () => {
  test("excludes conflicting actions synchronously in either direction", () => {
    for (const kind of ["workspace-switch", "workspace-backup", "workspace-restore", "app-restart"] as const) {
      const store = ready(), batch = store.acquire("profile-batch")!;
      expect(store.acquire(kind)).toBeNull();
      expect(store.release(batch)).toBe(true);
      const maintenance = store.acquire(kind)!;
      expect(store.acquire("profile-batch")).toBeNull();
      expect(store.release(maintenance)).toBe(true);
      expect(store.acquire("profile-batch")).not.toBeNull();
    }
  });
  test("holds ownership while refreshing and ignores a stale completion", () => {
    const store = ready(), first = store.acquire("profile-batch")!;
    store.setPhase(first, "refreshing");
    expect(workspaceOperationMessage(store.getSnapshot())).toContain("Refreshing the environment list");
    expect(store.acquire("workspace-switch")).toBeNull();
    store.release(first);
    const second = store.acquire("profile-batch")!;
    expect(store.release(first)).toBe(false);
    store.setPhase(first, "refreshing");
    expect(store.getSnapshot().operation?.phase).toBe("running");
    expect(store.canContinueBatch(second)).toBe(true);
  });
  test("refuses queued batch dispatch after a workspace change or external maintenance", () => {
    const store = ready(), batch = store.acquire("profile-batch")!;
    expect(store.canContinueBatch(batch, "one")).toBe(true);
    store.setWorkspace("two", "two");
    expect(store.canContinueBatch(batch, "one")).toBe(false);
    store.setWorkspace("one", "one");
    store.observeWorkspaceJob({ id: "external", kind: "backup" });
    expect(store.canContinueBatch(batch)).toBe(false);
    expect(store.acquire("workspace-switch")).toBeNull();
  });
  test("prepared switches block batches and installation while permitting their own restart", () => {
    const store = ready();
    store.setWorkspace("one", "two");
    expect(store.acquire("profile-batch")).toBeNull();
    expect(store.acquire("app-restart")).toBeNull();
    const restart = store.acquire("app-restart", "one", { allowPreparedRestart: true })!;
    expect(restart).not.toBeNull();
    store.release(restart);
    store.setWorkspace("one", "one");
    expect(store.acquire("profile-batch")).not.toBeNull();
  });
  test("transfers accepted background work into a barrier without an unlocked gap", async () => {
    const store = ready(), lease = store.acquire("workspace-restore")!, refresh = deferred();
    store.observeWorkspaceJob({ id: "restore", kind: "restore" }); store.release(lease);
    expect(store.acquire("profile-batch")).toBeNull();
    const finishing = store.finishWorkspaceJob("restore", () => refresh.promise);
    expect(store.getSnapshot().workspaceJob?.phase).toBe("refreshing");
    expect(store.acquire("profile-batch")).toBeNull();
    refresh.done(); await finishing;
    expect(store.acquire("profile-batch")).not.toBeNull();
  });
  test("a failed refresh releases only its own terminal job, preserving a newer external task", async () => {
    const store = ready(), refresh = deferred();
    store.observeWorkspaceJob({ id: "old", kind: "backup" });
    const finishing = store.finishWorkspaceJob("old", async () => { await refresh.promise; throw new Error("read unavailable"); });
    store.observeWorkspaceJob({ id: "new", kind: "restore" });
    refresh.done(); await expect(finishing).rejects.toThrow("read unavailable");
    expect(store.getSnapshot().workspaceJob?.id).toBe("new");
    expect(store.acquire("profile-batch")).toBeNull();
  });
  test("native installation is a separate barrier and read-only status checks do not own a lease", () => {
    const store = ready();
    store.setNativeUpdateBusy(true);
    expect(store.acquire("profile-batch")).toBeNull();
    expect(store.acquire("workspace-switch")).toBeNull();
    store.setNativeUpdateBusy(false);
    expect(store.acquire("profile-batch")).not.toBeNull();
  });
  test("awaits all workspace views before batch ownership can finish and unregisters departed pages", async () => {
    const store = ready(), gate = deferred(); let calls = 0;
    const unregister = store.registerWorkspaceRefresh(async () => { calls++; await gate.promise; });
    const lease = store.acquire("profile-batch")!; store.setPhase(lease, "refreshing");
    const pending = store.refreshWorkspaceViews(lease);
    await Promise.resolve(); expect(calls).toBe(1); expect(store.acquire("workspace-backup")).toBeNull();
    unregister(); gate.done(); await pending;
    store.release(lease); const next = store.acquire("profile-batch")!;
    await store.refreshWorkspaceViews(next); expect(calls).toBe(1);
  });
  test("does not invent a workspace before the catalog loads", () => {
    const store = createWorkspaceOperationCoordinator();
    expect(store.acquire("profile-batch", "unknown")).toBeNull();
    store.setWorkspace("one", "one");
    expect(store.acquire("profile-batch", "two")).toBeNull();
    expect(store.acquire("profile-batch", "one")).not.toBeNull();
  });
});

for (const scenario of ["batch-blocks-maintenance", "same-frame-switch", "same-frame-backup", "job-refresh", "restore-refresh", "install-unmount", "external-install", "terminal-refresh-failure", "job-unmount-recover", "stale-job-history", "stale-catalog-response"]) {
  test(`workspace operation components: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/workspace-operations-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("workspace operation fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
