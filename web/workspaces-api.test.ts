import { afterEach, expect, test } from "bun:test";
import { activateWorkspace, cancelActivation, clearWorkspaceCapability, downloadWorkspaceBackup, fetchWorkspaceBackups, fetchWorkspaceJob, fetchWorkspacePreferences, fetchWorkspaces, restoreWorkspace, restartWorkspace, saveWorkspacePreference, startWorkspaceBackup, workspaceBackupDownloadUrl, workspaceHistoryJob, workspaceJobPercent, type WorkspaceJob } from "./workspaces-api.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearWorkspaceCapability(); });
const workspace = { id: "workspace-one", name: "Research", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 2, lastOpenedAt: 0 };
const job: WorkspaceJob = { id: "job-one", kind: "restore", status: "queued", phase: "queued", completed: 0, total: 0 };

test("workspace requests acquire one capability and attach it to every subsequent request", async () => {
  const requests: Array<[string, RequestInit | undefined]> = [];
  globalThis.fetch = (async (input, init) => { const path = String(input); requests.push([path, init]); return Response.json(path.endsWith("/capability") ? { ok: true, token: "capability-one" } : path.endsWith("/backups") ? { ok: true, backups: [], jobs: [] } : { ok: true, currentId: workspace.id, activeId: workspace.id, workspaces: [workspace] }); }) as typeof fetch;
  await Promise.all([fetchWorkspaces(), fetchWorkspaceBackups()]);
  expect(requests.filter(([path]) => path.endsWith("/capability"))).toHaveLength(1);
  for (const [path, init] of requests.filter(([path]) => !path.endsWith("/capability"))) {
    expect(new Headers(init?.headers).get("X-Maobu-Workspace-Capability")).toBe("capability-one");
    expect(init?.cache).toBe("no-store");
    expect(path.startsWith("/ui/api/")).toBe(true);
  }
});

test("a stale capability is refreshed once while a second rejection remains an error", async () => {
  let tokens = 0, attempts = 0;
  globalThis.fetch = (async (input) => String(input).endsWith("/capability") ? Response.json({ ok: true, token: `token-${++tokens}` }) : (++attempts === 1 ? Response.json({ ok: false, error: "stale" }, { status: 401 }) : Response.json({ ok: true, currentId: workspace.id, activeId: workspace.id, workspaces: [workspace] }))) as typeof fetch;
  expect((await fetchWorkspaces()).currentId).toBe(workspace.id);
  expect(tokens).toBe(2); expect(attempts).toBe(2);
  clearWorkspaceCapability(); tokens = 0; attempts = 0;
  globalThis.fetch = (async (input) => String(input).endsWith("/capability") ? Response.json({ ok: true, token: `token-${++tokens}` }) : (attempts++, Response.json({ ok: false, error: "denied" }, { status: 401 }))) as typeof fetch;
  await expect(fetchWorkspaces()).rejects.toThrow("denied");
  expect(attempts).toBe(2);
});

test("large-file restore sends the File body directly without multipart or base64 copies", async () => {
  const file = new File(["archive-content"], "example.backup");
  let request: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => { if (String(input).endsWith("/capability")) return Response.json({ ok: true, token: "token" }); request = init; return Response.json({ ok: true, job }); }) as typeof fetch;
  expect((await restoreWorkspace(file)).kind).toBe("restore");
  expect(request?.body).toBe(file);
  expect(new Headers(request?.headers).get("Content-Type")).toBe("application/octet-stream");
  expect(new Headers(request?.headers).get("X-Maobu-Workspace-Capability")).toBe("token");
});

test("history restoration identifies a backup and never sends an overwrite target", async () => {
  let body: unknown;
  globalThis.fetch = (async (input, init) => { if (String(input).endsWith("/capability")) return Response.json({ ok: true, token: "token" }); body = JSON.parse(String(init?.body)); return Response.json({ ok: true, job }); }) as typeof fetch;
  await restoreWorkspace({ backupId: "backup-one" });
  expect(body).toEqual({ backupId: "backup-one" });
});

test("activation uses explicit close-running consent and exposes rollback", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => { const path = String(input); if (path.endsWith("/capability")) return Response.json({ ok: true, token: "token" }); requests.push({ path, body: JSON.parse(String(init?.body)) }); return Response.json({ ok: true, restartRequired: true }); }) as typeof fetch;
  await activateWorkspace("target/one", false); await cancelActivation();
  expect(requests).toEqual([{ path: "/ui/api/workspaces/target%2Fone/activate", body: { closeRunning: false } }, { path: "/ui/api/workspaces/activation/cancel", body: {} }]);
});

test("native restart is pinned to expected and target workspaces and export waits for a real native result", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), calls: Array<[string, unknown]> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (name: string, args: unknown) => { calls.push([name, args]); return name === "export_workspace_backup" ? { path: "chosen.backup" } : undefined; } } } });
  try {
    await restartWorkspace("current", "target");
    expect(await downloadWorkspaceBackup("backup-one")).toBe("saved");
    expect(calls).toEqual([["restart_workspace", { expectedWorkspaceId: "current", targetWorkspaceId: "target" }], ["export_workspace_backup", { backupId: "backup-one" }]]);
  } finally { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
});

test("workspace job progress distinguishes unknown totals from completion and bounds received bytes", () => {
  expect(workspaceJobPercent(job)).toBeNull();
  expect(workspaceJobPercent({ ...job, completed: 125, total: 100 })).toBe(100);
  expect(workspaceJobPercent({ ...job, completed: 20, total: 80 })).toBe(25);
  expect(workspaceBackupDownloadUrl("backup/one", "a&b")).toBe("/ui/api/workspace/backups/backup%2Fone/download?capability=a%26b");
});

test("a status read cannot confirm a different workspace task", async () => {
  globalThis.fetch = (async input => String(input).endsWith("/capability")
    ? Response.json({ ok: true, token: "token" })
    : Response.json({ ok: true, job })) as typeof fetch;
  expect(await fetchWorkspaceJob(job.id)).toEqual(job);
  await expect(fetchWorkspaceJob("different-job")).rejects.toThrow("Workspace response was incomplete.");
});

test("workspace display preferences use the same capability and accept only supported keys", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/capability")) return Response.json({ ok: true, token: "preferences-token" });
    expect(new Headers(init?.headers).get("X-Maobu-Workspace-Capability")).toBe("preferences-token");
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
    return Response.json({ ok: true, preferences: { "aliasmode.roster.pageSize": "50", "aliasmode.shell.sidebarCollapsed": "1", "arbitrary.path": "ignored" } });
  }) as typeof fetch;
  expect(await fetchWorkspacePreferences()).toEqual({ "aliasmode.roster.pageSize": "50", "aliasmode.shell.sidebarCollapsed": "1" });
  await saveWorkspacePreference("aliasmode.roster.pageSize", "100");
  await expect(saveWorkspacePreference("arbitrary.path", "value")).rejects.toThrow("Unsupported workspace preference.");
  expect(writes).toEqual([{ key: "aliasmode.roster.pageSize", value: "100" }]);
});

test("native save cancellation never reports a saved backup", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => ({ saved: false }) } } });
  try { expect(await downloadWorkspaceBackup("backup-one")).toBe("cancelled"); }
  finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});

test("preference writes stay ordered after a failure and activation and backup flush pending writes", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void, releaseThird!: () => void, beganFirst!: () => void, beganThird!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const thirdGate = new Promise<void>(resolve => { releaseThird = resolve; });
  const firstStarted = new Promise<void>(resolve => { beganFirst = resolve; });
  const thirdStarted = new Promise<void>(resolve => { beganThird = resolve; });
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/capability")) return Response.json({ ok: true, token: "token" });
    if (path.endsWith("/preferences")) {
      const body = JSON.parse(String(init?.body)); order.push(`preference-${body.value}`);
      if (body.value === "[]") { beganFirst(); await firstGate; return Response.json({ ok: false, error: "preference failed" }, { status: 500 }); }
      if (body.value === "100") { beganThird(); await thirdGate; }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/activate")) { order.push("activate"); return Response.json({ ok: true, restartRequired: true }); }
    order.push("backup"); return Response.json({ ok: true, job: { ...job, kind: "backup" } });
  }) as typeof fetch;
  const first = saveWorkspacePreference("aliasmode.roster.hiddenColumns", "[]").catch(error => error as Error);
  const second = saveWorkspacePreference("aliasmode.roster.pageSize", "50");
  const switching = activateWorkspace("target", false);
  await firstStarted;
  try { expect(order).toEqual(["preference-[]"]); } finally { releaseFirst(); }
  expect(await first).toBeInstanceOf(Error); await second; await switching;
  expect(order).toEqual(["preference-[]", "preference-50", "activate"]);
  const third = saveWorkspacePreference("aliasmode.roster.pageSize", "100");
  const backup = startWorkspaceBackup(); await thirdStarted;
  try { expect(order.at(-1)).toBe("preference-100"); expect(order).not.toContain("backup"); } finally { releaseThird(); }
  await third; await backup; expect(order.at(-1)).toBe("backup");
});

test("malformed workspace responses fail rather than inventing an empty catalog", async () => {
  globalThis.fetch = (async (input) => String(input).endsWith("/capability") ? Response.json({ ok: true, token: "token" }) : Response.json({ ok: true, currentId: workspace.id, activeId: workspace.id, workspaces: [{ ...workspace, updatedAt: -1 }] })) as typeof fetch;
  await expect(fetchWorkspaces()).rejects.toThrow("Workspace response was incomplete.");
});

test("oldest-first persisted history restores the latest interrupted backup after restart, with active jobs taking priority", async () => {
  const older: WorkspaceJob = { ...job, id: "older-success", kind: "backup", status: "succeeded", phase: "complete", completed: 100, total: 100 };
  const interrupted: WorkspaceJob = { ...job, id: "latest-interrupted", kind: "backup", status: "failed", phase: "interrupted", completed: 35, total: 100, error: "Interrupted by app restart" };
  globalThis.fetch = (async input => String(input).endsWith("/capability") ? Response.json({ ok: true, token: "token" }) : Response.json({ ok: true, backups: [], jobs: [older, interrupted] })) as typeof fetch;
  const persisted = await fetchWorkspaceBackups();
  const restored = workspaceHistoryJob(persisted.jobs);
  expect(restored).toEqual(interrupted);
  expect(restored?.kind).toBe("backup"); // Backup retries need no vanished File or in-memory restore source.
  expect(workspaceHistoryJob(persisted.jobs, older)).toEqual(interrupted);
  const active: WorkspaceJob = { ...job, id: "active-backup", kind: "backup", status: "running", phase: "compressing" };
  expect(workspaceHistoryJob([older, active, interrupted])).toBe(active);
  expect(workspaceHistoryJob(persisted.jobs, active)).toBe(active); // An older history response cannot hide a newly started task.
  const newlyStarted: WorkspaceJob = { ...active, id: "new-local-backup", status: "queued" };
  expect(workspaceHistoryJob([older, active], newlyStarted)).toBe(newlyStarted); // That stale response can still describe the previous task as active.
});
