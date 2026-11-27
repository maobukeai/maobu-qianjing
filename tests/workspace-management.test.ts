import { dirname as __repoDirname } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import { ensureStateDirectories, statePaths } from "../paths.ts";
import { ONBOARDING_STATE_KEY, WorkspaceManagement } from "../workspace-management.ts";
import { recoverWorkspaceUploads } from "../workspace-upload-staging.ts";
import type { Launcher } from "../launcher.ts";
import { ROSTER_DENSITY_KEY } from "../roster-density-state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "maobu-workspace-api-"));
  cleanups.push(() => { if (!resolve(home).startsWith(resolve(tmpdir()) + "\\maobu-workspace-api-") && !resolve(home).startsWith(resolve(tmpdir()) + "/maobu-workspace-api-")) throw new Error("Unexpected fixture path"); rmSync(home, { recursive: true, force: true }); });
  const paths = statePaths(home); ensureStateDirectories(paths);
  const store = new ProfileStore(paths.database); cleanups.push(() => store.close());
  const profile = buildNewProfile({ name: "Original environment", engine: "chromium", chromiumRuntime: "aliasmode", group: "Original group" }, () => false);
  store.upsertProfile(profile);
  mkdirSync(join(paths.profiles, profile.id), { recursive: true });
  writeFileSync(join(paths.profiles, profile.id, "saved-session.bin"), "fixture login storage");
  let guard = () => {};
  const stopped: string[] = [];
  const transitions = new Set<string>();
  const launcher = {
    setWorkspaceMaintenanceGuard: (next: () => void) => { guard = next; },
    profileDeletionBlocked: (id: string) => transitions.has(id) || !!store.getLaunch(id),
    dataDriveFreeBytes: () => 100 * 1024 ** 3,
    stop: async (id: string) => { stopped.push(id); store.clearLaunch(id); return true; },
    cacheCleanupSettled: async () => {},
  } as unknown as Launcher;
  const nonce = "c".repeat(64);
  const manager = new WorkspaceManagement({ home, paths, store, launcher, agentNonce: nonce });
  let token = "";
  const request = async (path: string, method = "GET", body?: unknown, headers: HeadersInit = {}) => {
    const h = new Headers(headers);
    if (token && !h.has("authorization")) h.set("X-Maobu-Workspace-Capability", token);
    if (body !== undefined && !(body instanceof Blob)) h.set("content-type", "application/json");
    const response = await manager.handle(new Request("http://127.0.0.1:12345/ui/api" + path, { method, headers: h, ...(body !== undefined ? { body: body instanceof Blob ? body : JSON.stringify(body) } : {}) }));
    if (!response) throw new Error("Workspace route fell through");
    return response;
  };
  return { home, paths, store, profile, manager, nonce, stopped, transitions, request, guard: () => guard(), authorize: async () => { token = (await (await request("/workspace/capability", "GET", undefined, { Authorization: `Bearer ${nonce}` })).json()).token; return token; } };
}

test("workspace metadata and backup attachments require a same-origin capability", async () => {
  const f = fixture();
  expect((await f.request("/workspace/capability")).status).toBe(401);
  expect((await f.request("/workspaces")).status).toBe(401);
  await f.authorize();
  expect((await f.request("/workspaces")).status).toBe(200);
  expect((await f.request("/workspaces", "GET", undefined, { Origin: "https://untrusted.example" })).status).toBe(403);
  expect((await f.request("/workspace/capability", "GET", undefined, { "Sec-Fetch-Site": "cross-site", Authorization: `Bearer ${f.nonce}` })).status).toBe(403);
  expect((await f.manager.handle(new Request("http://attacker.example:12345/ui/api/workspace/capability", { headers: { Origin: "http://attacker.example:12345" } })))!.status).toBe(403);
  expect((await f.manager.handle(new Request("http://127.0.0.1:12345/ui/api/workspaces", { headers: { "X-Maobu-Workspace-Capability": "z".repeat(64) } })))!.status).toBe(401);
  expect((await f.request("/workspaces", "GET", undefined, { Authorization: `Bearer ${f.nonce}` })).status).toBe(200);
});

test("create, rename, archive and unarchive preserve the original environment data", async () => {
  const f = fixture(); await f.authorize();
  const created = await f.request("/workspaces", "POST", { name: "Client A", icon: "briefcase", color: "#628ac7" });
  expect(created.status).toBe(201);
  const id = (await created.json()).workspace.id;
  expect((await f.request(`/workspaces/${id}`, "PATCH", { name: "Client A operations" })).status).toBe(200);
  expect((await f.request(`/workspaces/${id}/archive`, "POST", { archived: true })).status).toBe(200);
  expect((await f.request(`/workspaces/${id}/activate`, "POST", {})).status).toBe(404);
  expect((await f.request(`/workspaces/${id}/archive`, "POST", { archived: false })).status).toBe(200);
  expect((await f.request("/workspaces/default/archive", "POST", { archived: true })).status).toBe(400);
  expect((await f.request("/workspaces", "POST", { name: "Client A operations" })).status).toBe(400);
  expect(f.store.count()).toBe(1);
  expect(readFileSync(join(f.paths.profiles, f.profile.id, "saved-session.bin"), "utf8")).toBe("fixture login storage");
});

test("activation freezes old-workspace writes and cancellation restores the old active context", async () => {
  const f = fixture(); await f.authorize();
  const id = (await (await f.request("/workspaces", "POST", { name: "Client B" })).json()).workspace.id;
  expect((await f.request(`/workspaces/${id}/activate`, "POST", {})).status).toBe(200);
  expect(f.manager.catalog.activeId()).toBe(id);
  expect(f.manager.currentId()).toBe("default");
  expect(() => f.guard()).toThrow("maintenance");
  const response = await f.manager.dispatch(new Request("http://127.0.0.1:12345/api/v1/browser/start?user_id=x"), async () => new Response("unexpected write"));
  expect(response.status).toBe(423);
  expect((await f.request("/workspaces", "POST", { name: "Cannot create while switching" })).status).toBe(423);
  expect((await f.request("/workspace/backups", "POST", {})).status).toBe(423);
  expect((await f.request("/workspace/restore", "POST", { backupId: "bak_" + "a".repeat(32) })).status).toBe(423);
  expect(f.manager.backups.jobs()).toHaveLength(0);
  expect((await f.request("/workspaces/activation/cancel", "POST", {})).status).toBe(200);
  expect(f.manager.catalog.activeId()).toBe("default");
  expect(() => f.guard()).not.toThrow();
  expect(f.store.count()).toBe(1);
});

test("switching refuses running data and can explicitly close sessions before restart", async () => {
  const f = fixture(); await f.authorize();
  const id = (await (await f.request("/workspaces", "POST", { name: "Next project" })).json()).workspace.id;
  f.store.recordLaunch({ profileId: f.profile.id, engine: "chromium", pid: 0, debugPort: 0, ws: "ws://127.0.0.1:0/fixture", startedAt: Date.now(), persona: f.profile });
  expect((await f.request(`/workspaces/${id}/activate`, "POST", { closeRunning: false })).status).toBe(423);
  expect(f.manager.catalog.activeId()).toBe("default");
  expect((await f.request(`/workspaces/${id}/activate`, "POST", { closeRunning: true })).status).toBe(200);
  expect(f.stopped).toEqual([f.profile.id]);
  expect(f.store.listLaunches()).toHaveLength(0);
  expect(f.manager.catalog.activeId()).toBe(id);
  await f.request("/workspaces/activation/cancel", "POST", {});
});

test("real backup jobs download verified bytes and restore a new independent workspace", async () => {
  const f = fixture(); await f.authorize();
  expect((await f.request("/workspace/backups", "POST", {})).status).toBe(400);
  const started = await f.request("/workspace/backups", "POST", { allowUnencrypted: true });
  expect(started.status).toBe(202);
  const initial = (await started.json()).job;
  expect(initial.kind).toBe("backup");
  const completed = await f.manager.backups.wait(initial.id);
  expect(completed.status).toBe("succeeded");
  const status = await (await f.request(`/workspace/jobs/${initial.id}`)).json();
  expect(status.job.completed).toBeGreaterThan(0);
  const listing = await (await f.request("/workspace/backups")).json();
  expect(listing.backups).toHaveLength(1);
  expect(listing.backups[0].path).toBeUndefined();
  const backupId = listing.backups[0].id;
  const download = await f.request(`/workspace/backups/${backupId}/download`, "GET", undefined, { Authorization: `Bearer ${f.nonce}` });
  const bytes = new Uint8Array(await download.arrayBuffer());
  expect(download.headers.get("X-Backup-SHA256")).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(Number(download.headers.get("Content-Length"))).toBe(bytes.byteLength);
  const restored = await (await f.request("/workspace/restore", "POST", { backupId })).json();
  expect(restored.job.kind).toBe("restore");
  const done = await f.manager.backups.wait(restored.job.id);
  expect(done.status).toBe("succeeded");
  const next = f.manager.catalog.pathFor(done.restoredWorkspaceId!);
  const restoredStore = new ProfileStore(join(next, "profiles.sqlite"));
  try { expect(restoredStore.count()).toBe(1); expect(restoredStore.listGroups()).toContain("Original group"); } finally { restoredStore.close(); }
  expect(readFileSync(join(next, "profiles", f.profile.id, "saved-session.bin"), "utf8")).toBe("fixture login storage");
  expect(f.store.count()).toBe(1);
  expect(f.manager.currentId()).toBe("default");
  expect(f.manager.catalog.activeId()).toBe("default");
});

test("a raw streamed upload restores a new workspace and a damaged file never publishes one", async () => {
  const f = fixture(); await f.authorize();
  const backup = f.manager.backups.startCreate(undefined, { allowUnencrypted: true }); await f.manager.backups.wait(backup.id);
  const file = f.manager.backups.getBackupFile(f.manager.backups.listBackups()[0]!.id);
  const uploads = join(f.home, "backups", ".uploads");
  const archives = () => [...new Bun.Glob("**/*.mqbackup").scanSync({ cwd: uploads, dot: true })];
  const release = f.manager.acquireMutationLease();
  let uploaded: { job: { id: string } };
  try {
    uploaded = await (await f.request("/workspace/restore", "POST", Bun.file(file.path), { "Content-Type": "application/octet-stream" })).json();
    const staged = archives();
    expect(staged).toHaveLength(1);
    // The queued restore still owns the staged archive after the HTTP response.
    await recoverWorkspaceUploads(f.manager.backups.directory);
    expect(archives()).toEqual(staged);
  } finally { release(); }
  expect((await f.manager.backups.wait(uploaded.job.id)).status).toBe("succeeded");
  await f.manager.settled();
  expect(readdirSync(uploads)).toEqual([]);
  const before = f.manager.catalog.list().length;
  const invalid = await (await f.request("/workspace/restore", "POST", new Blob(["not a backup"]), { "Content-Type": "application/octet-stream" })).json();
  expect((await f.manager.backups.wait(invalid.job.id)).status).toBe("failed");
  await f.manager.settled();
  expect(readdirSync(uploads)).toEqual([]);
  expect(f.manager.catalog.list()).toHaveLength(before);
  expect(f.store.count()).toBe(1);
  expect((await f.request("/workspace/overview")).status).toBe(200);
});

test("password-encrypted exports restore through both authorized routes without echoing the password", async () => {
  const f = fixture(); await f.authorize();
  const password = "示例备份口令🔒1234567";
  const create = await f.request("/workspace/backups", "POST", { password });
  expect(create.status).toBe(202);
  const created = await f.manager.backups.wait((await create.json()).job.id);
  expect(created.status).toBe("succeeded");
  const backupId = created.backupId!;
  const history = await (await f.request("/workspace/backups")).text();
  expect(history).not.toContain(password);
  expect(JSON.parse(history).backups[0]).toMatchObject({ id: backupId, encrypted: true });
  const restored = await f.request("/workspace/restore", "POST", { backupId, password });
  expect(restored.status).toBe(202);
  expect((await f.manager.backups.wait((await restored.json()).job.id)).status).toBe("succeeded");
  const downloaded = await f.request(`/workspace/backups/${backupId}/download`);
  expect(downloaded.status).toBe(200);
  const blob = await downloaded.blob();
  const uploaded = await f.request("/workspace/restore", "POST", blob, { "Content-Type": "application/octet-stream", "X-Maobu-Backup-Password": encodeURIComponent(password) });
  expect(uploaded.status).toBe(202);
  expect((await f.manager.backups.wait((await uploaded.json()).job.id)).status).toBe("succeeded");
  await f.manager.settled();
  expect(f.manager.catalog.list()).toHaveLength(3);
  expect(f.manager.currentId()).toBe("default");
  const invalid = await f.request("/workspace/restore", "POST", blob, { "Content-Type": "application/octet-stream", "X-Maobu-Backup-Password": "%invalid" });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("%invalid");
});

test("display preferences persist atomically and remain isolated per workspace", async () => {
  const f = fixture(); await f.authorize();
  await Promise.all([
    f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.pageSize", value: "50" }),
    f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.hiddenColumns", value: '["tags"]' }),
    f.request("/workspace/preferences", "POST", { key: "aliasmode.shell.sidebarCollapsed", value: "1" }),
    f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.groupDisclosure", value: '[["Private project",true]]' }),
  ]);
  const preferences = (await (await f.request("/workspace/preferences")).json()).preferences;
  expect(preferences).toEqual({ "aliasmode.roster.pageSize": "50", "aliasmode.roster.hiddenColumns": '["tags"]', "aliasmode.shell.sidebarCollapsed": "1", "aliasmode.roster.groupDisclosure": '[["Private project",true]]' });
  for (const value of ['{}', '[["A",1]]', '[["A",true],["A",false]]']) expect((await f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.groupDisclosure", value })).status).toBe(400);
  expect((await f.request("/workspace/preferences", "POST", { key: "unexpected.path", value: "../../" })).status).toBe(400);
  const next = f.manager.catalog.create({ name: "Separate preferences" });
  const paths = statePaths(f.manager.catalog.pathFor(next.id)); ensureStateDirectories(paths);
  const store = new ProfileStore(paths.database); cleanups.push(() => store.close());
  const other = new WorkspaceManagement({ home: f.home, paths, store, launcher: f.manager.options.launcher, agentNonce: f.nonce });
  const cap = (await (await other.handle(new Request("http://127.0.0.1/ui/api/workspace/capability", { headers: { Authorization: `Bearer ${f.nonce}` } })))!.json()).token;
  const response = await other.handle(new Request("http://127.0.0.1/ui/api/workspace/preferences", { headers: { "X-Maobu-Workspace-Capability": cap } }));
  expect((await response!.json()).preferences).toEqual({});
  expect(JSON.parse(readFileSync(join(f.home, "workspace-settings.json"), "utf8")).values).toEqual(preferences);
});

test("workspace favorites and saved views persist validated metadata without crossing workspaces", async () => {
  const f = fixture(); await f.authorize();
  const favorites = '["profile_one","profile_two"]';
  const views = JSON.stringify([{ id: "view_" + "c".repeat(32), name: "Running favorites", filters: { scope: "favorites", query: "", group: "all", status: "running", sort: { key: "name", dir: 1 }, hiddenColumns: ["tags"], pageSize: 25 } }]);
  expect((await f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.favorites", value: favorites })).status).toBe(200);
  expect((await f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.savedViews", value: views })).status).toBe(200);
  const restored = (await (await f.request("/workspace/preferences")).json()).preferences;
  expect(restored["aliasmode.roster.favorites"]).toBe(favorites);
  expect(JSON.parse(restored["aliasmode.roster.savedViews"])).toEqual(JSON.parse(views));
  for (const [key, value] of [["aliasmode.roster.favorites", '["same","same"]'], ["aliasmode.roster.savedViews", '[{"id":"broken","name":"Malformed","filters":{}}]']]) {
    expect((await f.request("/workspace/preferences", "POST", { key, value })).status).toBe(400);
  }
  expect((await (await f.request("/workspace/preferences")).json()).preferences).toEqual(restored);
});

test("density survives a new management instance and invalid values never replace its last saved value", async () => {
  const f = fixture(); await f.authorize();
  expect((await (await f.request("/workspace/preferences")).json()).preferences[ROSTER_DENSITY_KEY]).toBeUndefined();
  expect((await f.request("/workspace/preferences", "POST", { key: ROSTER_DENSITY_KEY, value: "compact" })).status).toBe(200);
  expect((await f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.pageSize", value: "50" })).status).toBe(200);
  const before = (await (await f.request("/workspace/preferences")).json()).preferences;
  expect(before[ROSTER_DENSITY_KEY]).toBe("compact");
  for (const value of [undefined, null, true, 1, {}, ["compact"], "", "dense", "COMPACT", " compact", "compact ", '"compact"', "compact".repeat(1000)]) {
    const response = await f.request("/workspace/preferences", "POST", { key: ROSTER_DENSITY_KEY, value });
    expect(response.status).toBe(400); expect((await response.json()).ok).toBe(false);
  }
  expect((await (await f.request("/workspace/preferences")).json()).preferences).toEqual(before);
  expect(JSON.parse(readFileSync(join(f.paths.root, "workspace-settings.json"), "utf8")).values).toEqual(before);
  const reopened = new WorkspaceManagement({ home: f.home, paths: f.paths, store: f.store, launcher: f.manager.options.launcher, agentNonce: f.nonce });
  const cap = (await (await reopened.handle(new Request("http://127.0.0.1/ui/api/workspace/capability", { headers: { Authorization: `Bearer ${f.nonce}` } })))!.json()).token;
  const reloaded = await reopened.handle(new Request("http://127.0.0.1/ui/api/workspace/preferences", { headers: { "X-Maobu-Workspace-Capability": cap } }));
  expect((await reloaded!.json()).preferences).toEqual(before);
  expect((await f.request("/workspace/preferences", "POST", { key: ROSTER_DENSITY_KEY, value: "standard" })).status).toBe(200);
  expect((await (await f.request("/workspace/preferences")).json()).preferences[ROSTER_DENSITY_KEY]).toBe("standard");
  expect((await f.request("/workspace/preferences", "POST", { key: "aliasmode.roster.pageSize", value: "0" })).status).toBe(200);
  expect((await (await f.request("/workspace/preferences")).json()).preferences["aliasmode.roster.pageSize"]).toBe("0");
  expect((await f.request("/workspace/preferences", "POST", { key: ROSTER_DENSITY_KEY, value: "comfortable" })).status).toBe(200);
  expect((await (await f.request("/workspace/preferences")).json()).preferences[ROSTER_DENSITY_KEY]).toBe("comfortable");
  expect(f.store.count()).toBe(1); expect(readFileSync(join(f.paths.profiles, f.profile.id, "saved-session.bin"), "utf8")).toBe("fixture login storage");
});

test("different workspaces independently keep compact and comfortable density preferences", async () => {
  const f = fixture(); await f.authorize();
  expect((await f.request("/workspace/preferences", "POST", { key: ROSTER_DENSITY_KEY, value: "compact" })).status).toBe(200);
  const next = f.manager.catalog.create({ name: "Independent density" });
  const paths = statePaths(f.manager.catalog.pathFor(next.id)); ensureStateDirectories(paths); f.manager.catalog.setActive(next.id);
  const store = new ProfileStore(paths.database); cleanups.push(() => store.close());
  const other = new WorkspaceManagement({ home: f.home, paths, store, launcher: f.manager.options.launcher, agentNonce: f.nonce });
  const cap = (await (await other.handle(new Request("http://127.0.0.1/ui/api/workspace/capability", { headers: { Authorization: `Bearer ${f.nonce}` } })))!.json()).token;
  const request = async (method = "GET", body?: unknown) => other.handle(new Request("http://127.0.0.1/ui/api/workspace/preferences", { method, headers: { "X-Maobu-Workspace-Capability": cap, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  expect((await (await request())!.json()).preferences[ROSTER_DENSITY_KEY]).toBeUndefined();
  expect((await request("POST", { key: ROSTER_DENSITY_KEY, value: "comfortable" }))!.status).toBe(200);
  expect((await (await request())!.json()).preferences[ROSTER_DENSITY_KEY]).toBe("comfortable");
  expect((await (await f.request("/workspace/preferences")).json()).preferences[ROSTER_DENSITY_KEY]).toBe("compact");
  expect(JSON.parse(readFileSync(join(paths.root, "workspace-settings.json"), "utf8")).values[ROSTER_DENSITY_KEY]).toBe("comfortable");
  expect(JSON.parse(readFileSync(join(f.paths.root, "workspace-settings.json"), "utf8")).values[ROSTER_DENSITY_KEY]).toBe("compact");
  expect(f.store.count()).toBe(1); expect(store.count()).toBe(0);
});

test("an in-progress upload blocks switching and is awaited on shutdown", async () => {
  const f = fixture(); const token = await f.authorize();
  const next = f.manager.catalog.create({ name: "Do not switch yet" });
  let upload!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { upload = controller; controller.enqueue(new Uint8Array([1, 2, 3])); } });
  const pending = f.manager.handle(new Request("http://127.0.0.1:12345/ui/api/workspace/restore", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Maobu-Workspace-Capability": token }, body: stream }));
  expect((await f.manager.overview()).uploading).toBe(true);
  expect((await f.request(`/workspaces/${next.id}/activate`, "POST", {})).status).toBe(423);
  expect((await f.request("/workspace/backups", "POST", {})).status).toBe(423);
  let settled = false; const closing = f.manager.settled().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  upload.error(new Error("Cancelled fixture upload"));
  expect((await pending)!.status).toBe(400);
  await closing;
  expect(f.manager.catalog.activeId()).toBe("default");
  expect(readdirSync(join(f.home, "backups", ".uploads"))).toEqual([]);
});

test("startup recovers a terminated process's staged upload without touching a live upload or a legacy file", async () => {
  const f = fixture();
  const uploads = join(f.home, "backups", ".uploads");
  const script = `
    import { join } from "node:path";
    import { statSync } from "node:fs";
    import { WorkspaceManagement } from "./workspace-management.ts";
    import { ProfileStore } from "./store.ts";
    import { statePaths } from "./paths.ts";
    const home = ${JSON.stringify(f.home)};
    const nonce = ${JSON.stringify(f.nonce)};
    const uploads = join(home, "backups", ".uploads");
    const paths = statePaths(home);
    const store = new ProfileStore(paths.database);
    const manager = new WorkspaceManagement({ home, paths, store, launcher: {}, agentNonce: nonce });
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } });
    const upload = manager.handle(new Request("http://127.0.0.1/ui/api/workspace/restore", {
      method: "POST", headers: { "Content-Type": "application/octet-stream", Authorization: "Bearer " + nonce }, body
    }));
    const files = new Bun.Glob("**/*.mqbackup");
    let staged;
    for (let attempt = 0; attempt < 250 && !staged; attempt++) {
      try {
        staged = [...files.scanSync({ cwd: uploads, dot: true })].find(path => statSync(join(uploads, path)).size === 3);
      } catch {}
      if (!staged) await Bun.sleep(20);
    }
    if (!staged) throw new Error("The child never staged its upload");
    process.stdout.write(JSON.stringify(staged) + "\\n");
    const keepAlive = setInterval(() => {}, 1000);
    await upload;
    clearInterval(keepAlive);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: __repoDirname(import.meta.dir),
    stdout: "pipe",
    stderr: "inherit",
    signal: AbortSignal.timeout(8_000),
  });
  const reader = child.stdout.getReader();
  try {
    const decoder = new TextDecoder();
    let message = "";
    while (!message.endsWith("\n")) {
      const chunk = await reader.read();
      if (chunk.done || message.length > 4_096) throw new Error("The child upload did not reach staging");
      message += decoder.decode(chunk.value, { stream: true });
    }
    const staged = join(uploads, JSON.parse(message));
    const legacy = join(uploads, "upload_" + "f".repeat(32) + ".mqbackup");
    writeFileSync(legacy, "legacy workspace upload");
    const unrelatedId = "a".repeat(32);
    const unrelatedStage = join(uploads, `.upload-v1-${unrelatedId}`);
    mkdirSync(unrelatedStage);
    const unrelatedArchive = join(unrelatedStage, `upload_${unrelatedId}.mqbackup`);
    writeFileSync(unrelatedArchive, "unidentified workspace upload");
    writeFileSync(join(unrelatedStage, "lease.sqlite"), "");

    await new WorkspaceManagement(f.manager.options).settled();
    expect([...readFileSync(staged)]).toEqual([1, 2, 3]);
    expect(readFileSync(legacy, "utf8")).toBe("legacy workspace upload");

    child.kill(9);
    await child.exited;
    await Promise.all([
      new WorkspaceManagement(f.manager.options).settled(),
      recoverWorkspaceUploads(f.manager.backups.directory),
    ]);
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(legacy, "utf8")).toBe("legacy workspace upload");
    expect(readFileSync(unrelatedArchive, "utf8")).toBe("unidentified workspace upload");
    expect(f.store.count()).toBe(1);
  } finally {
    reader.releaseLock();
    if (child.exitCode === null) child.kill(9);
    await child.exited;
  }
}, 10_000);

test("a delayed JSON restore cannot take over a raw upload started while its body was arriving", async () => {
  const f = fixture(); const token = await f.authorize();
  let jsonBody!: ReadableStreamDefaultController<Uint8Array>;
  const delayed = new ReadableStream<Uint8Array>({ start(controller) { jsonBody = controller; } });
  const request = f.manager.handle(new Request("http://127.0.0.1/ui/api/workspace/restore", { method: "POST", headers: { "Content-Type": "application/json", "X-Maobu-Workspace-Capability": token }, body: delayed }));
  let upload!: ReadableStreamDefaultController<Uint8Array>;
  const raw = f.manager.handle(new Request("http://127.0.0.1/ui/api/workspace/restore", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Maobu-Workspace-Capability": token }, body: new ReadableStream<Uint8Array>({ start(controller) { upload = controller; controller.enqueue(new Uint8Array([0])); } }) }));
  expect((await f.manager.overview()).uploading).toBe(true);
  jsonBody.enqueue(new TextEncoder().encode(JSON.stringify({ backupId: "bak_" + "a".repeat(32) }))); jsonBody.close();
  expect((await request)!.status).toBe(423);
  upload.error(new Error("End test")); await raw;
  expect(f.manager.backups.jobs()).toHaveLength(0);
});

test("onboarding checklist preference persists valid states and rejects invalid values", async () => {
  const f = fixture(); await f.authorize();
  for (const state of ["open", "collapsed", "dismissed"] as const) {
    expect((await f.request("/workspace/preferences", "POST", { key: ONBOARDING_STATE_KEY, value: state })).status).toBe(200);
    expect((await (await f.request("/workspace/preferences")).json()).preferences[ONBOARDING_STATE_KEY]).toBe(state);
  }
  for (const invalid of ["", "hidden", "OPEN", "dismiss", null, 1, {}, ["open"]]) {
    expect((await f.request("/workspace/preferences", "POST", { key: ONBOARDING_STATE_KEY, value: invalid })).status).toBe(400);
  }
  expect((await (await f.request("/workspace/preferences")).json()).preferences[ONBOARDING_STATE_KEY]).toBe("dismissed");
});

test("custom workspace icons validate image magic bytes, enforce 2 MB limit, and serve with nosniff", async () => {
  const f = fixture(); const token = await f.authorize();
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const uploadRes = await f.manager.handle(new Request("http://127.0.0.1/ui/api/workspace/icons", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-Maobu-Workspace-Capability": token },
    body: pngBytes,
  }));
  expect(uploadRes?.status).toBe(201);
  const uploaded = await uploadRes!.json();
  expect(uploaded.ok).toBe(true);
  expect(uploaded.icon).toMatch(/^custom:[0-9a-f]{32}\.png$/);

  const filename = uploaded.icon.slice("custom:".length);
  const getRes = await f.manager.handle(new Request(`http://127.0.0.1/ui/api/workspace/icons/${filename}`, {
    method: "GET",
    headers: { "X-Maobu-Workspace-Capability": token },
  }));
  expect(getRes?.status).toBe(200);
  expect(getRes?.headers.get("Content-Type")).toBe("image/png");
  expect(getRes?.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await getRes!.arrayBuffer())).toEqual(pngBytes);

  const badRes = await f.manager.handle(new Request("http://127.0.0.1/ui/api/workspace/icons", {
    method: "POST",
    headers: { "Content-Type": "image/svg+xml", "X-Maobu-Workspace-Capability": token },
    body: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
  }));
  expect(badRes?.status).toBe(400);

  const bigRes = await f.manager.handle(new Request("http://127.0.0.1/ui/api/workspace/icons", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-Maobu-Workspace-Capability": token },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  }));
  expect(bigRes?.status).toBe(413);
});
