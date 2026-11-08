import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildNewProfile } from "./create.ts";
import { ProfileStore } from "./store.ts";
import { ScriptLibrary } from "./scripts.ts";
import { WorkspaceCatalog } from "./workspaces.ts";
import { WorkspaceBackupService } from "./workspace-backups.ts";
const roots: string[] = [], stores: ProfileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("maobu-backup-test-")) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "maobu-backup-test-")); roots.push(root);
  const catalog = new WorkspaceCatalog(root, root); const store = new ProfileStore(join(root, "profiles.sqlite")); stores.push(store);
  const profile = buildNewProfile({ name: "原环境", group: "客户", username: "local-user", password: "local-secret", screen: "1440x900" }, () => false); profile.id = "profile001"; store.upsertProfile(profile);
  const closed = { ...structuredClone(profile), id: "trashed001", name: "回收站环境" }; store.upsertProfile(closed); store.trashProfile(closed.id);
  mkdirSync(join(root, "profiles", profile.id, "Default"), { recursive: true }); writeFileSync(join(root, "profiles", profile.id, "Default", "Cookies"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(root, "profiles", profile.id, "Local State"), "fixture-browser-state");
  const extension = join(root, "extensions", "ext-1"); mkdirSync(extension, { recursive: true }); writeFileSync(join(extension, "manifest.json"), '{"name":"本地扩展"}'); store.addExtension({ id: "ext-1", name: "本地扩展", loadDir: extension });
  await new ScriptLibrary(root).save({ name: "导入脚本", description: "saved locally", source: "console.log('fixture')", language: "javascript" });
  mkdirSync(join(root, "custom-scripts", "run-old")); writeFileSync(join(root, "custom-scripts", "run-old", "output.log"), "saved run log");
  writeFileSync(join(root, "shell.json"), '{"language":"zh-CN"}'); writeFileSync(join(root, "config.json"), '{"version":1,"mode":"local","localAnalytics":false}');
  let idle = true; const calls: string[] = [];
  const service = new WorkspaceBackupService({ catalog, assertIdle: () => { calls.push("idle"); if (!idle) throw new Error("Workspace is busy"); }, exclusive: async work => { calls.push("lock"); try { return await work(); } finally { calls.push("unlock"); } } });
  return { root, catalog, store, profile, service, calls, setIdle: (value: boolean) => { idle = value; } };
}
async function completed(service: WorkspaceBackupService, id: string) { const result = await service.wait(id); expect(result).toMatchObject({ status: "succeeded" }); return result; }

test("real WAL snapshot and all durable files restore into a new isolated workspace", async () => {
  const f = await fixture();
  const job = f.service.startCreate(); expect(f.service.busy()).toBe(true); expect(() => f.service.startCreate()).toThrow("already running");
  const result = await completed(f.service, job.id); expect(f.calls).toEqual(["lock", "idle", "unlock"]); expect(f.service.busy()).toBe(false);
  const record = f.service.listBackups()[0]!; expect(record.id).toBe(result.backupId!); expect(record.profileCount).toBe(1);
  expect(record.name).toBe(f.catalog.list()[0]!.name);
  const download = f.service.getBackupFile(record.id); expect(download.sha256).toBe(createHash("sha256").update(readFileSync(download.path)).digest("hex"));
  const restored = await completed(f.service, f.service.startRestore({ backupId: record.id, name: "恢复的工作区" }).id);
  const target = f.catalog.pathFor(restored.restoredWorkspaceId!); expect(target).not.toBe(f.root); expect(f.catalog.activeId()).toBe("default");
  const imported = new ProfileStore(join(target, "profiles.sqlite")); stores.push(imported);
  expect(imported.getProfile(f.profile.id)).toEqual(f.store.getProfile(f.profile.id));
  expect(imported.listTrashed().map(item => item.id)).toEqual(["trashed001"]); expect(imported.listLaunches()).toEqual([]);
  expect(imported.getExtension("ext-1")!.loadDir).toBe(join(target, "extensions", "ext-1"));
  expect(readFileSync(join(target, "profiles", f.profile.id, "Default", "Cookies"))).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(readFileSync(join(target, "custom-scripts", "local.json"), "utf8")).toContain("console.log('fixture')");
  expect(readFileSync(join(target, "custom-scripts", "run-old", "output.log"), "utf8")).toBe("saved run log");
  expect(existsSync(join(target, "backups"))).toBe(false); expect(existsSync(join(target, "desktop-workspaces.json"))).toBe(false);
  expect(readFileSync(join(f.root, "profiles", f.profile.id, "Local State"), "utf8")).toBe("fixture-browser-state");
});
test("busy hooks and durable launch records refuse backup without publishing an archive", async () => {
  const f = await fixture(); f.setIdle(false);
  expect((await f.service.wait(f.service.startCreate().id)).status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  f.setIdle(true); f.store.recordLaunch({ profileId: f.profile.id, pid: 123, debugPort: 9222, ws: "ws://fixture", startedAt: 1, engine: "firefox", firefoxOwner: {} as any });
  expect((await f.service.wait(f.service.startCreate().id)).status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  expect(f.store.listLaunches()).toHaveLength(1);
  expect(readdirSync(f.service.directory).some(name => name.startsWith(".create-") || name.endsWith(".partial"))).toBe(false);
});
test("history and imported-file restore preserve running source sessions while create still requires idle", async () => {
  const f = await fixture();
  const backup = await completed(f.service, f.service.startCreate().id);
  const file = f.service.getBackupFile(backup.backupId!); const archive = readFileSync(file.path);
  f.store.recordLaunch({ profileId: f.profile.id, pid: 123, debugPort: 9222, ws: "ws://fixture-running", startedAt: 42, engine: "firefox", firefoxOwner: {} as any });
  const launch = f.store.getLaunch(f.profile.id); const source = f.store.getProfile(f.profile.id);
  f.setIdle(false); f.calls.length = 0;
  const upload = join(f.root, "uploaded-running-restore.mqbackup"); writeFileSync(upload, archive);
  for (const input of [{ backupId: backup.backupId!, name: "运行期间从历史恢复" }, { archivePath: upload, name: "运行期间从文件恢复" }]) {
    const result = await completed(f.service, f.service.startRestore(input).id);
    const target = f.catalog.pathFor(result.restoredWorkspaceId!);
    const restored = new ProfileStore(join(target, "profiles.sqlite")); stores.push(restored);
    expect(restored.getProfile(f.profile.id)).toEqual(source); expect(restored.listLaunches()).toEqual([]);
    expect(f.store.getLaunch(f.profile.id)).toEqual(launch); expect(f.store.getProfile(f.profile.id)).toEqual(source);
    expect(f.catalog.currentId()).toBe("default"); expect(f.catalog.activeId()).toBe("default");
  }
  expect(f.calls).toEqual(["lock", "unlock", "lock", "unlock"]);
  const denied = await f.service.wait(f.service.startCreate().id);
  expect(denied.status).toBe("failed"); expect(denied.error).toContain("busy");
  expect(f.calls.slice(-3)).toEqual(["lock", "idle", "unlock"]);
  expect(f.service.listBackups()).toHaveLength(1); expect(f.catalog.list()).toHaveLength(3);
  expect(f.store.getLaunch(f.profile.id)).toEqual(launch);
  expect(readFileSync(file.path)).toEqual(archive); expect(readFileSync(upload)).toEqual(archive);
});
function mutatedArchive(input: Buffer, change: (manifest: any) => void, trailing = Buffer.alloc(0)): Buffer {
  const raw = gunzipSync(input); const magic = Buffer.from("MAOBU-WORKSPACE-BACKUP\0v1\n");
  const size = raw.readUInt32BE(magic.length); const manifest = JSON.parse(raw.subarray(magic.length + 4, magic.length + 4 + size).toString()); change(manifest);
  const json = Buffer.from(JSON.stringify(manifest)); const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return gzipSync(Buffer.concat([magic, length, json, raw.subarray(magic.length + 4 + size), trailing]));
}
test("untrusted archives reject traversal, duplicates, checksums, truncation and bombs without changing old data", async () => {
  const f = await fixture(); const made = await completed(f.service, f.service.startCreate().id); const goodPath = f.service.getBackupFile(made.backupId!).path;
  const good = readFileSync(goodPath); const initial = f.catalog.list(); const original = f.store.getProfile(f.profile.id);
  const inputs = [
    mutatedArchive(good, manifest => { manifest.files[0].path = "../escape.sqlite"; }),
    mutatedArchive(good, manifest => { manifest.files[0].path = "C:/escape.sqlite"; }),
    mutatedArchive(good, manifest => { manifest.files.push(manifest.files[0]); }),
    mutatedArchive(good, manifest => { manifest.files[0].sha256 = "0".repeat(64); }),
    mutatedArchive(good, manifest => { manifest.files[0].bytes = Number.MAX_SAFE_INTEGER; }),
    mutatedArchive(good, () => {}, Buffer.alloc(100_000)),
    good.subarray(0, good.length - 10), Buffer.from("not an archive"),
  ];
  for (let index = 0; index < inputs.length; index++) {
    const path = join(f.root, `uploaded-${index}.mqbackup`); writeFileSync(path, inputs[index]!);
    const restored = await f.service.wait(f.service.startRestore({ archivePath: path }).id);
    expect(restored.status).toBe("failed"); expect(f.catalog.list()).toEqual(initial); expect(f.store.getProfile(f.profile.id)).toEqual(original);
    expect(readdirSync(join(f.root, "workspaces")).some(name => name.startsWith(".restore-"))).toBe(false);
    expect(readFileSync(goodPath)).toEqual(good);
  }
  expect(existsSync(join(f.root, "escape.sqlite"))).toBe(false);
});
test("linked data cannot be archived and restore cannot reuse an existing workspace name", async () => {
  const f = await fixture(); const made = await completed(f.service, f.service.startCreate().id);
  const before = f.catalog.list(); expect((await f.service.wait(f.service.startRestore({ backupId: made.backupId!, name: before[0]!.name }).id)).status).toBe("failed"); expect(f.catalog.list()).toEqual(before);
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "safe");
  symlinkSync(outside, join(f.root, "profiles", "linked"), process.platform === "win32" ? "junction" : "dir");
  expect((await f.service.wait(f.service.startCreate().id)).status).toBe("failed"); expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
  expect(f.service.listBackups()).toHaveLength(1);
});
test("backup history survives reopening and interrupted jobs become retryable failures", async () => {
  const f = await fixture(); await completed(f.service, f.service.startCreate().id);
  const path = join(f.service.directory, "index.json"); const history = JSON.parse(readFileSync(path, "utf8"));
  history.jobs[0].status = "running"; writeFileSync(path, JSON.stringify(history));
  const jobId = history.jobs[0].id;
  const abandonedCreate = join(f.service.directory, `.create-${jobId}-abandoned`); mkdirSync(abandonedCreate); writeFileSync(join(abandonedCreate, "partial"), "unfinished");
  const parent = join(f.root, "workspaces"); mkdirSync(parent, { recursive: true });
  const abandonedRestore = join(parent, `.restore-${jobId}-abandoned`); mkdirSync(abandonedRestore); writeFileSync(join(abandonedRestore, "partial"), "unfinished");
  const unrelated = join(parent, ".restore-unrelated-operation"); mkdirSync(unrelated); writeFileSync(join(unrelated, "keep"), "do not delete");
  const next = new WorkspaceBackupService({ catalog: f.catalog, assertIdle: () => {}, exclusive: async work => work() });
  expect(next.jobs()[0]).toMatchObject({ status: "failed", phase: "interrupted" }); expect(next.listBackups()).toHaveLength(1);
  expect(existsSync(abandonedCreate)).toBe(false); expect(existsSync(abandonedRestore)).toBe(false); expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("do not delete");
  await completed(next, next.startCreate().id); expect(next.listBackups()).toHaveLength(2);
});

test("a non-default workspace backs up only its own database and browser files", async () => {
  const f = await fixture();
  const entry = f.catalog.create({ name: "独立客户区", color: "#c4905b", icon: "briefcase" });
  const root = f.catalog.pathFor(entry.id); f.catalog.setActive(entry.id);
  const catalog = new WorkspaceCatalog(f.root, root); const store = new ProfileStore(join(root, "profiles.sqlite")); stores.push(store);
  const profile = buildNewProfile({ name: "仅属于客户区", password: "second-workspace-secret" }, () => false); profile.id = "second001"; store.upsertProfile(profile);
  mkdirSync(join(root, "profiles", profile.id), { recursive: true }); writeFileSync(join(root, "profiles", profile.id, "site-data"), "only second workspace");
  const service = new WorkspaceBackupService({ catalog, assertIdle: () => {}, exclusive: async work => work() });
  const backup = await completed(service, service.startCreate().id); const record = service.listBackups()[0]!;
  expect(record.workspaceId).toBe(entry.id); expect(record.path.startsWith(join(root, "backups") + sep)).toBe(true);
  expect(gunzipSync(readFileSync(record.path)).includes(Buffer.from("local-secret"))).toBe(false);
  const result = await completed(service, service.startRestore({ backupId: backup.backupId! }).id);
  const restoredRoot = catalog.pathFor(result.restoredWorkspaceId!); const restored = new ProfileStore(join(restoredRoot, "profiles.sqlite")); stores.push(restored);
  expect(restored.listProfiles().map(item => item.id)).toEqual([profile.id]); expect(restored.getProfile(profile.id)!.password).toBe("second-workspace-secret");
  expect(existsSync(join(restoredRoot, "profiles", f.profile.id))).toBe(false);
  expect(f.store.getProfile(f.profile.id)!.password).toBe("local-secret");
  expect(catalog.activeId()).toBe(entry.id);
});

test("portable extension paths must have actual backed-up data", async () => {
  const f = await fixture();
  const extension = resolve(f.root, "extensions", "ext-1"); expect(extension.startsWith(resolve(f.root) + sep)).toBe(true);
  rmSync(extension, { recursive: true, force: true });
  const result = await f.service.wait(f.service.startCreate().id);
  expect(result.status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  expect(f.store.getExtension("ext-1")!.loadDir).toBe(join(f.root, "extensions", "ext-1"));
});

test("background metadata write failure reports a failed job without rejecting or touching source data", async () => {
  const f = await fixture(); const job = f.service.startCreate();
  const index = join(f.service.directory, "index.json"); unlinkSync(index); mkdirSync(index);
  const result = await f.service.wait(job.id);
  expect(result).toMatchObject({ status: "failed", phase: "history-failed" }); expect(f.service.busy()).toBe(false);
  expect(f.store.getProfile(f.profile.id)!.password).toBe("local-secret"); expect(f.catalog.list()).toHaveLength(1);
});
