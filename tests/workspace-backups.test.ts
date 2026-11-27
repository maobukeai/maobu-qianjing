import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { ProxyVaultStore } from "../src/proxy-vault/proxy-vault-store.ts";
import { ENCRYPTED_VALUE_PREFIX } from "../dpapi.ts";
import { ScriptLibrary } from "../scripts.ts";
import { WorkspaceCatalog } from "../workspaces.ts";
import { WorkspaceBackupService } from "../workspace-backups.ts";
import { AppSettingsStore, defaultAppSettings } from "../app-settings.ts";
import { ASSISTANT_MODEL_SERVICES_FILE, AssistantModelServices } from "../assistant-model-services.ts";
import { PROFILE_TEMPLATES_FILE, PROFILE_TEMPLATE_LIMITS, ProfileTemplateStore, type ProfileTemplateSettings } from "../profile-templates.ts";
const roots: string[] = [], stores: ProfileStore[] = [];
const fixtureParent = resolve(import.meta.dir, "..", "node_modules", ".cache", "workspace-backup-tests");
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(fixtureParent + sep) || !basename(root).startsWith("maobu-backup-test-")) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); }
});
async function fixture() {
  mkdirSync(fixtureParent, { recursive: true }); const root = mkdtempSync(join(fixtureParent, "maobu-backup-test-")); roots.push(root);
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
  const job = f.service.startCreate(undefined, { allowUnencrypted: true }); expect(f.service.busy()).toBe(true); expect(() => f.service.startCreate(undefined, { allowUnencrypted: true })).toThrow("already running");
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
test("full backups preserve preferences and require renewed sync and both startup opt-ins on restore", async () => {
  const f = await fixture();
  const settings = new AppSettingsStore(join(f.root, "app-settings.json"));
  const saved = settings.patch({ updates: { repository: "maobu/browser", channel: "beta", checkOnStartup: true }, sync: { enabled: true, folder: join(f.root, "transport"), retainSnapshots: 17 }, network: { checkLocalProxyBeforeLaunch: true }, signedUpdates: { checkOnStartup: true } });
  const source = readFileSync(settings.path, "utf8");
  const created = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const archivePath = f.service.getBackupFile(created.backupId!).path, archive = readFileSync(archivePath);
  expect(gunzipSync(archive).includes(Buffer.from(source))).toBe(true);
  const restored = await completed(f.service, f.service.startRestore({ backupId: created.backupId! }).id);
  const root = f.catalog.pathFor(restored.restoredWorkspaceId!);
  expect(new AppSettingsStore(join(root, "app-settings.json")).read()).toEqual({ ...saved, updates: { ...saved.updates, checkOnStartup: false }, sync: { ...saved.sync, enabled: false }, signedUpdates: { checkOnStartup: false } });
  expect(new AppSettingsStore(join(root, "app-settings.json")).read().network).toEqual({ checkLocalProxyBeforeLaunch: true, chromiumPreloading: "browser-default", chromiumMemorySaver: false });
  expect(readFileSync(settings.path, "utf8")).toBe(source); expect(readFileSync(archivePath)).toEqual(archive);
  expect(existsSync(saved.sync.folder)).toBe(false);
});

test("encrypted archives authenticate all frames and restore only model metadata without retaining passwords", async () => {
  const f = await fixture();
  const models = new AssistantModelServices(f.root);
  const key = "synthetic-provider-key-not-for-backup";
  const { services } = models.save({ name: "Backup example", provider: "openai-compatible", endpoint: "https://example.test/v1", model: "fixture-model", apiKey: key });
  const id = services[0]!.id;
  models.setDefault({ id });
  const metadata = models.backupMetadata();
  const browserPath = join(f.root, "profiles", f.profile.id, "Default", "Cookies");
  const browserData = randomBytes(600 * 1024); writeFileSync(browserPath, browserData);
  const password = "示例备份口令🔒1234567";
  const created = await completed(f.service, f.service.startCreate(password).id);
  expect(f.service.listBackups()[0]!.encrypted).toBe(true);
  const archive = f.service.getBackupFile(created.backupId!);
  const encrypted = readFileSync(archive.path);
  expect(encrypted.length).toBeGreaterThan(512 * 1024);
  expect(encrypted.includes(Buffer.from("fixture-model"))).toBe(false);
  expect(encrypted.includes(Buffer.from("local-secret"))).toBe(false);
  expect(createHash("sha256").update(encrypted).digest("hex")).toBe(archive.sha256);
  expect(JSON.stringify(f.service.jobs())).not.toContain(password);
  expect(readFileSync(join(f.service.directory, "index.json"), "utf8")).not.toContain(password);
  const original = f.catalog.list();
  const missing = await f.service.wait(f.service.startRestore({ backupId: created.backupId! }).id);
  expect(missing.error).toBe("Enter the password for this encrypted backup.");
  const wrong = await f.service.wait(f.service.startRestore({ backupId: created.backupId!, password: "wrong fixture password" }).id);
  expect(wrong.error).toBe("The backup password is incorrect or the encrypted backup is damaged.");
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  for (const contents of [tampered, encrypted.subarray(0, -20), Buffer.concat([encrypted, Buffer.from("trailing")])]) {
    const path = join(f.root, "modified.mqbackup"); writeFileSync(path, contents);
    expect(await f.service.wait(f.service.startRestore({ archivePath: path, password }).id)).toMatchObject({ status: "failed", error: "The backup password is incorrect or the encrypted backup is damaged." });
    expect(f.catalog.list()).toEqual(original);
    expect(readdirSync(join(f.root, "workspaces")).some(name => name.startsWith(".restore-"))).toBe(false);
  }
  const restored = await completed(f.service, f.service.startRestore({ backupId: created.backupId!, password }).id);
  const target = f.catalog.pathFor(restored.restoredWorkspaceId!);
  const recovered = new AssistantModelServices(target);
  expect(recovered.backupMetadata()).toEqual(metadata);
  expect(recovered.list().services[0]!.credentialConfigured).toBe(false);
  expect(readFileSync(join(target, ASSISTANT_MODEL_SERVICES_FILE), "utf8")).not.toContain(key);
  expect(readFileSync(join(target, "profiles", f.profile.id, "Default", "Cookies"))).toEqual(browserData);
  expect(models.list().services[0]!.credentialConfigured).toBe(true);
});

test("model catalogs with secret or unknown fields cannot enter a backup", async () => {
  const f = await fixture();
  const path = join(f.root, ASSISTANT_MODEL_SERVICES_FILE);
  writeFileSync(path, JSON.stringify({ version: 1, services: [], defaultId: null, apiKey: "secret fixture" }));
  const created = await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  expect(created).toMatchObject({ status: "failed", error: "Backup model services are invalid or unsupported." });
  expect(f.service.listBackups()).toEqual([]);
});

test("restoring settings preserves Windows and POSIX locations as disabled preferences", async () => {
  const f = await fixture();
  for (const [index, folder] of ["C:\\Users\\old-computer\\OneDrive\\Maobu", "/home/old-computer/sync"].entries()) {
    const settings = { ...defaultAppSettings(), sync: { enabled: true, folder, retainSnapshots: 8 } };
    writeFileSync(join(f.root, "app-settings.json"), JSON.stringify(settings));
    const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
    const job = await completed(f.service, f.service.startRestore({ backupId: made.backupId!, name: `跨设备恢复${index}` }).id);
    const restored = new AppSettingsStore(join(f.catalog.pathFor(job.restoredWorkspaceId!), "app-settings.json")).read();
    expect(restored.sync).toEqual({ enabled: false, folder, retainSnapshots: 8 });
    expect(JSON.parse(readFileSync(join(f.root, "app-settings.json"), "utf8")).sync.enabled).toBe(true);
  }
});

test("full backups capture strict template settings and restore them without carrying profile secrets", async () => {
  const f = await fixture();
  const templates = new ProfileTemplateStore(join(f.root, PROFILE_TEMPLATES_FILE));
  const settings: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1440x900", platform: "x.com" };
  const catalog = templates.save({ name: "Reusable desktop", settings }, 0), source = readFileSync(templates.path, "utf8");
  const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const restored = await completed(f.service, f.service.startRestore({ backupId: made.backupId! }).id);
  const recovered = new ProfileTemplateStore(join(f.catalog.pathFor(restored.restoredWorkspaceId!), PROFILE_TEMPLATES_FILE)).read();
  expect(recovered).toEqual(catalog); expect(readFileSync(templates.path, "utf8")).toBe(source);
  expect(JSON.stringify(recovered)).not.toContain("local-secret"); expect(JSON.stringify(recovered)).not.toContain("local-user");
  expect(Object.keys(recovered.templates[0]!.settings).sort()).toEqual(["chromiumRuntime", "engine", "platform", "platformOs", "screen"]);
});

test("invalid source template catalogs cannot be published into a full backup", async () => {
  const f = await fixture(), path = join(f.root, PROFILE_TEMPLATES_FILE);
  for (const contents of ['{"password":"private-template-content",BROKEN', JSON.stringify({ version: 2, revision: 0, templates: [] }), JSON.stringify({ version: 1, revision: 0, templates: [], password: "private-template-content" }), "x".repeat(PROFILE_TEMPLATE_LIMITS.fileBytes + 1)]) {
    writeFileSync(path, contents);
    const result = await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id);
    expect(result.status).toBe("failed"); expect(result.error).toBe("Profile template file is invalid or unsupported."); expect(result.error).not.toContain("private-template-content");
    expect(f.service.listBackups()).toEqual([]); expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readdirSync(f.service.directory).some(name => name.startsWith(".create-") || name.endsWith(".partial"))).toBe(false);
  }
});

test("older backups without app preferences restore with safe defaults", async () => {
  const f = await fixture(); const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const result = await completed(f.service, f.service.startRestore({ backupId: made.backupId! }).id);
  const path = join(f.catalog.pathFor(result.restoredWorkspaceId!), "app-settings.json");
  expect(existsSync(path)).toBe(false); expect(new AppSettingsStore(path).read()).toEqual(defaultAppSettings());
  expect(new ProfileTemplateStore(join(f.catalog.pathFor(result.restoredWorkspaceId!), PROFILE_TEMPLATES_FILE)).read()).toEqual({ version: 1, revision: 0, templates: [] });
});

const invalidAppSettings = [
  '{"password":"private-settings-content",BROKEN',
  JSON.stringify({ ...defaultAppSettings(), version: 2 }),
  JSON.stringify({ ...defaultAppSettings(), unknown: "private-settings-content" }),
  "x".repeat(65 * 1024),
];

test("invalid source application settings never publish an unrestorable backup", async () => {
  const f = await fixture();
  const settings = new AppSettingsStore(join(f.root, "app-settings.json"));
  settings.patch({ network: { checkLocalProxyBeforeLaunch: true } });
  const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const priorBackup = f.service.getBackupFile(made.backupId!);
  const priorBytes = readFileSync(priorBackup.path);

  for (const value of invalidAppSettings) {
    writeFileSync(settings.path, value);
    const job = await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id);
    expect(job).toMatchObject({ status: "failed", error: "Backup application settings are invalid or unsupported" });
    expect(f.service.listBackups().map(backup => backup.id)).toEqual([made.backupId!]);
    expect(readFileSync(priorBackup.path)).toEqual(priorBytes);
    expect(readFileSync(settings.path, "utf8")).toBe(value);
    expect(readdirSync(f.service.directory).some(name => name.startsWith(".create-") || name.endsWith(".partial"))).toBe(false);
  }

  const restored = await completed(f.service, f.service.startRestore({ backupId: made.backupId! }).id);
  expect(new AppSettingsStore(join(f.catalog.pathFor(restored.restoredWorkspaceId!), "app-settings.json")).read().network?.checkLocalProxyBeforeLaunch).toBe(true);
});

test("invalid archived settings do not publish a restored workspace or expose file content", async () => {
  const f = await fixture();
  const settings = new AppSettingsStore(join(f.root, "app-settings.json"));
  settings.write(defaultAppSettings());
  const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const archive = readFileSync(f.service.getBackupFile(made.backupId!).path);
  const original = f.store.getProfile(f.profile.id), workspaces = f.catalog.list(), source = readFileSync(settings.path);
  const upload = join(f.root, "invalid-settings.mqbackup");

  for (const value of invalidAppSettings) {
    writeFileSync(upload, archiveWithFile(archive, "app-settings.json", Buffer.from(value)));
    const restored = await f.service.wait(f.service.startRestore({ archivePath: upload }).id);
    expect(restored).toMatchObject({ status: "failed", error: "Backup application settings are invalid or unsupported" });
    expect(f.catalog.list()).toEqual(workspaces);
    expect(f.store.getProfile(f.profile.id)).toEqual(original);
    expect(readFileSync(settings.path)).toEqual(source);
    expect(readdirSync(join(f.root, "workspaces")).some(name => name.startsWith(".restore-"))).toBe(false);
  }
});

test("busy hooks and durable launch records refuse backup without publishing an archive", async () => {
  const f = await fixture(); f.setIdle(false);
  expect((await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id)).status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  f.setIdle(true); f.store.recordLaunch({ profileId: f.profile.id, pid: 123, debugPort: 9222, ws: "ws://fixture", startedAt: 1, engine: "firefox", firefoxOwner: {} as any });
  expect((await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id)).status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  expect(f.store.listLaunches()).toHaveLength(1);
  expect(readdirSync(f.service.directory).some(name => name.startsWith(".create-") || name.endsWith(".partial"))).toBe(false);
});
test("history and imported-file restore preserve running source sessions while create still requires idle", async () => {
  const f = await fixture();
  const backup = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
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
  const denied = await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id);
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
/** Recalculate the checksum too, so restore reaches the optional catalog's schema boundary. */
function archiveWithFile(input: Buffer, entryPath: string, content: Buffer): Buffer {
  const raw = gunzipSync(input), magic = Buffer.from("MAOBU-WORKSPACE-BACKUP\0v1\n"), size = raw.readUInt32BE(magic.length);
  const manifest = JSON.parse(raw.subarray(magic.length + 4, magic.length + 4 + size).toString());
  let offset = magic.length + 4 + size, found = false; const payloads: Buffer[] = [];
  for (const file of manifest.files) {
    const bytes = raw.subarray(offset, offset + file.bytes); offset += file.bytes;
    if (file.path === entryPath) {
      file.bytes = content.length; file.sha256 = createHash("sha256").update(content).digest("hex"); payloads.push(content); found = true;
    } else payloads.push(bytes);
  }
  if (!found || offset !== raw.length) throw new Error("Invalid test archive");
  const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return gzipSync(Buffer.concat([magic, length, json, ...payloads]));
}
test("untrusted backup templates reject secrets, malformed JSON, future versions and oversized catalogs before publication", async () => {
  const f = await fixture(), templates = new ProfileTemplateStore(join(f.root, PROFILE_TEMPLATES_FILE));
  const catalog = templates.save({ name: "Safe defaults", settings: { engine: "chromium", chromiumRuntime: "", platformOs: "", screen: "", platform: "" } }, 0);
  const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id), good = readFileSync(f.service.getBackupFile(made.backupId!).path);
  const before = f.catalog.list(), original = f.store.getProfile(f.profile.id), source = readFileSync(templates.path);
  const contents = [
    '{"password":"private-template-content",BROKEN', JSON.stringify({ ...catalog, version: 2 }),
    JSON.stringify({ ...catalog, templates: [{ ...catalog.templates[0], settings: { ...catalog.templates[0]!.settings, proxy: { pass: "private-template-content" } } }] }),
    JSON.stringify({ ...catalog, templates: [{ ...catalog.templates[0], fingerprintSeed: 123 }] }),
    "x".repeat(PROFILE_TEMPLATE_LIMITS.fileBytes + 1),
  ];
  for (const [index, content] of contents.entries()) {
    const path = join(f.root, `invalid-templates-${index}.mqbackup`); writeFileSync(path, archiveWithFile(good, PROFILE_TEMPLATES_FILE, Buffer.from(content)));
    const result = await f.service.wait(f.service.startRestore({ archivePath: path }).id);
    expect(result.status).toBe("failed"); expect(result.error).toBe("Backup profile templates are invalid or unsupported"); expect(result.error).not.toContain("private-template-content");
    expect(f.catalog.list()).toEqual(before); expect(f.catalog.activeId()).toBe("default"); expect(f.store.getProfile(f.profile.id)).toEqual(original); expect(readFileSync(templates.path)).toEqual(source);
    expect(readdirSync(join(f.root, "workspaces")).some(name => name.startsWith(".restore-"))).toBe(false);
  }
});
test("restoration validates model metadata before publishing an imported archive", async () => {
  const f = await fixture(), models = new AssistantModelServices(f.root);
  models.save({ name: "Portable model", provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "local-fixture" });
  const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const source = readFileSync(f.service.getBackupFile(made.backupId!).path), metadata = models.backupMetadata();
  const corrupted = { ...metadata, services: [{ ...metadata.services[0], apiKey: "private test content" }] };
  const path = join(f.root, "invalid-model-catalog.mqbackup");
  writeFileSync(path, archiveWithFile(source, ASSISTANT_MODEL_SERVICES_FILE, Buffer.from(JSON.stringify(corrupted))));
  const before = f.catalog.list();
  const job = await f.service.wait(f.service.startRestore({ archivePath: path }).id);
  expect(job).toMatchObject({ status: "failed", error: "Backup model services are invalid or unsupported." });
  expect(f.catalog.list()).toEqual(before);
  expect(models.backupMetadata()).toEqual(metadata);
});
test("untrusted archives reject traversal, duplicates, checksums, truncation and bombs without changing old data", async () => {
  const f = await fixture(); const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id); const goodPath = f.service.getBackupFile(made.backupId!).path;
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
  const f = await fixture(); const made = await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const before = f.catalog.list(); expect((await f.service.wait(f.service.startRestore({ backupId: made.backupId!, name: before[0]!.name }).id)).status).toBe("failed"); expect(f.catalog.list()).toEqual(before);
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "safe");
  symlinkSync(outside, join(f.root, "profiles", "linked"), process.platform === "win32" ? "junction" : "dir");
  expect((await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id)).status).toBe("failed"); expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
  expect(f.service.listBackups()).toHaveLength(1);
});
test("backup history survives reopening and interrupted jobs become retryable failures", async () => {
  const f = await fixture(); await completed(f.service, f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  const path = join(f.service.directory, "index.json"); const history = JSON.parse(readFileSync(path, "utf8"));
  history.jobs[0].status = "running"; writeFileSync(path, JSON.stringify(history));
  const jobId = history.jobs[0].id;
  const abandonedCreate = join(f.service.directory, `.create-${jobId}-abandoned`); mkdirSync(abandonedCreate); writeFileSync(join(abandonedCreate, "partial"), "unfinished");
  const partial = join(f.service.directory, `.create-${jobId}.partial`); writeFileSync(partial, "unfinished archive bytes");
  const parent = join(f.root, "workspaces"); mkdirSync(parent, { recursive: true });
  const abandonedRestore = join(parent, `.restore-${jobId}-abandoned`); mkdirSync(abandonedRestore); writeFileSync(join(abandonedRestore, "partial"), "unfinished");
  const unrelated = join(parent, ".restore-unrelated-operation"); mkdirSync(unrelated); writeFileSync(join(unrelated, "keep"), "do not delete");
  const next = new WorkspaceBackupService({ catalog: f.catalog, assertIdle: () => {}, exclusive: async work => work() });
  expect(next.jobs()[0]).toMatchObject({ status: "failed", phase: "interrupted" }); expect(next.listBackups()).toHaveLength(1);
  expect(existsSync(abandonedCreate)).toBe(false); expect(existsSync(abandonedRestore)).toBe(false); expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("do not delete");
  expect(existsSync(partial)).toBe(false);
  await completed(next, next.startCreate(undefined, { allowUnencrypted: true }).id); expect(next.listBackups()).toHaveLength(2);
});

test("a non-default workspace backs up only its own database and browser files", async () => {
  const f = await fixture();
  const entry = f.catalog.create({ name: "独立客户区", color: "#c4905b", icon: "briefcase" });
  const root = f.catalog.pathFor(entry.id); f.catalog.setActive(entry.id);
  const catalog = new WorkspaceCatalog(f.root, root); const store = new ProfileStore(join(root, "profiles.sqlite")); stores.push(store);
  const profile = buildNewProfile({ name: "仅属于客户区", password: "second-workspace-secret" }, () => false); profile.id = "second001"; store.upsertProfile(profile);
  mkdirSync(join(root, "profiles", profile.id), { recursive: true }); writeFileSync(join(root, "profiles", profile.id, "site-data"), "only second workspace");
  const service = new WorkspaceBackupService({ catalog, assertIdle: () => {}, exclusive: async work => work() });
  const backup = await completed(service, service.startCreate(undefined, { allowUnencrypted: true }).id); const record = service.listBackups()[0]!;
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
  const result = await f.service.wait(f.service.startCreate(undefined, { allowUnencrypted: true }).id);
  expect(result.status).toBe("failed"); expect(f.service.listBackups()).toEqual([]);
  expect(f.store.getExtension("ext-1")!.loadDir).toBe(join(f.root, "extensions", "ext-1"));
});

test("background metadata write failure reports a failed job without rejecting or touching source data", async () => {
  const f = await fixture(); const job = f.service.startCreate(undefined, { allowUnencrypted: true });
  const index = join(f.service.directory, "index.json"); unlinkSync(index); mkdirSync(index);
  const result = await f.service.wait(job.id);
  expect(result).toMatchObject({ status: "failed", phase: "history-failed" }); expect(f.service.busy()).toBe(false);
  expect(f.store.getProfile(f.profile.id)!.password).toBe("local-secret"); expect(f.catalog.list()).toHaveLength(1);
});

test("omitting backup password fails unless allowUnencrypted is explicitly true", async () => {
  const f = await fixture();
  expect(() => f.service.startCreate()).toThrow("Backup password is required");
  expect(() => f.service.startCreate(undefined, { allowUnencrypted: false })).toThrow("Backup password is required");
});

test("password-encrypted backups restore portably across different local protection keys", async () => {
  const previousKey = process.env.MAOBU_DATA_KEY;
  process.env.MAOBU_DATA_KEY = "11".repeat(32);
  try {
    const f = await fixture();
    const withSecrets = {
      ...f.profile,
      twofa: "JBSWY3DPEHPK3PXP",
      proxy: { type: "http" as const, host: "203.0.113.10", port: "8080", user: "proxy-u", pass: "proxy-p" },
      cookies: [{ name: "sid", value: "cookie-secret", domain: ".example.com", path: "/" }],
    };
    f.store.upsertProfile(withSecrets);
    f.store.saveSessionBundle(f.profile.id, '{"cookies":[{"name":"sess"}]}');
    f.store.addPendingCookies(f.profile.id, [{ name: "pending", value: "p-secret", domain: ".example.com", path: "/" }]);

    const sourceVault = new ProxyVaultStore(f.store);
    const vaultEntry = sourceVault.create({
      name: "Portable Vault Proxy",
      group: "US",
      type: "socks5",
      host: "203.0.113.20",
      port: 1080,
      user: "vault-user",
      pass: "vault-pass-secret",
      refreshUrl: "https://rotate.provider.example/v1/ip?token=VAULT_REFRESH_TOKEN",
      notes: "portable test",
    });

    const backupPassword = "portable-backup-passphrase";
    const created = await completed(f.service, f.service.startCreate(backupPassword).id);

    // Simulate restoring on another machine / user account with a different local protection key.
    process.env.MAOBU_DATA_KEY = "22".repeat(32);
    const restored = await completed(
      f.service,
      f.service.startRestore({ backupId: created.backupId!, password: backupPassword, name: "跨机恢复工作区" }).id,
    );
    const target = f.catalog.pathFor(restored.restoredWorkspaceId!);
    const imported = new ProfileStore(join(target, "profiles.sqlite"));
    stores.push(imported);

    const loaded = imported.getProfile(f.profile.id)!;
    expect(loaded.password).toBe("local-secret");
    expect(loaded.twofa).toBe("JBSWY3DPEHPK3PXP");
    expect(loaded.proxy?.pass).toBe("proxy-p");
    expect(loaded.cookies[0]?.value).toBe("cookie-secret");
    expect(imported.getSessionBundle(f.profile.id)).toBe('{"cookies":[{"name":"sess"}]}');
    expect(imported.getPendingCookies(f.profile.id)[0]?.value).toBe("p-secret");

    // Proxy Vault secrets must restore portably and be re-encrypted under Key B.
    const restoredVault = new ProxyVaultStore(imported);
    const restoredEdit = restoredVault.getEditView(vaultEntry.id)!;
    expect(restoredEdit.user).toBe("vault-user");
    expect(restoredEdit.pass).toBe("vault-pass-secret");
    expect(restoredEdit.refreshUrl).toBe("https://rotate.provider.example/v1/ip?token=VAULT_REFRESH_TOKEN");
    const rawReencrypted = imported
      .rawDatabase()
      .query<{ auth_encrypted: string; refresh_url_encrypted: string }, [string]>(
        "SELECT auth_encrypted, refresh_url_encrypted FROM proxy_vault WHERE id = ?",
      )
      .get(vaultEntry.id)!;
    expect(rawReencrypted.auth_encrypted.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true);
    expect(rawReencrypted.refresh_url_encrypted.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true);

    // Re-opening with the original machine key must NOT decrypt the target DB (it was re-encrypted under key B).
    process.env.MAOBU_DATA_KEY = "11".repeat(32);
    const wrongKeyStore = new ProfileStore(join(target, "profiles.sqlite"));
    stores.push(wrongKeyStore);
    const wrongLoaded = wrongKeyStore.getProfile(f.profile.id)!;
    expect(wrongLoaded.password).toBe("");
    expect(wrongLoaded.twofa).toBe("");
    expect(wrongLoaded.proxy).toBeNull();
    expect(wrongLoaded.cookies).toEqual([]);
    expect(wrongKeyStore.getSessionBundle(f.profile.id)).toBeNull();
    expect(wrongKeyStore.getPendingCookies(f.profile.id)).toEqual([]);
    const wrongVaultEdit = new ProxyVaultStore(wrongKeyStore).getEditView(vaultEntry.id)!;
    expect(wrongVaultEdit.user).toBe("");
    expect(wrongVaultEdit.pass).toBe("");
    expect(wrongVaultEdit.refreshUrl).toBe("");
  } finally {
    if (previousKey === undefined) delete process.env.MAOBU_DATA_KEY;
    else process.env.MAOBU_DATA_KEY = previousKey;
  }
});
