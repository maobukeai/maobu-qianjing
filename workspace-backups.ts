import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { isSafeProfileId } from "./profile-id.ts";
import { createLocalSecretProtector, isEncryptedSecret } from "./dpapi.ts";
import { ALIASMODE_VERSION } from "./version.ts";
import { parseAppSettings } from "./app-settings.ts";
import { ASSISTANT_MODEL_SERVICES_FILE, ASSISTANT_MODEL_SERVICES_FILE_LIMIT, AssistantModelServices } from "./assistant-model-services.ts";
import { deriveWorkspacePasswordKey } from "./encrypted-sync.ts";
import { PROFILE_TEMPLATES_FILE, PROFILE_TEMPLATE_LIMITS, ProfileTemplateStore } from "./profile-templates.ts";
import { WorkspaceCatalog, WORKSPACE_COLORS, WORKSPACE_ICONS, assertNoWorkspaceLinks, plainDirectory, workspaceEntryExists, writeWorkspaceJson } from "./workspaces.ts";

const MAGIC = Buffer.from("MAOBU-WORKSPACE-BACKUP\0v1\n");
const ENCRYPTED_MAGIC = Buffer.from("MAOBU-ENCRYPTED-BACKUP\0v1\n");
const SALT_BYTES = 16, NONCE_PREFIX_BYTES = 8, AUTH_TAG_BYTES = 16, FRAME_BYTES = 256 * 1024;
const BACKUP_ID = /^bak_[0-9a-f]{32}$/;
const JOB_ID = /^job_[0-9a-f]{32}$/;
const ROOT_FILES = new Set(["profiles.sqlite", "config.json", "app-settings.json", PROFILE_TEMPLATES_FILE, ASSISTANT_MODEL_SERVICES_FILE, "shell.json", "workspace.json", "workspace-settings.json"]);
const ROOT_DIRECTORIES = new Set(["profiles", "extensions", "custom-scripts"]);
export interface BackupLimits { maxArchiveBytes: number; maxUnpackedBytes: number; maxFileBytes: number; maxFiles: number; maxManifestBytes: number }
const DEFAULT_LIMITS: BackupLimits = { maxArchiveBytes: 64 * 1024 ** 3, maxUnpackedBytes: 128 * 1024 ** 3, maxFileBytes: 64 * 1024 ** 3, maxFiles: 500_000, maxManifestBytes: 64 * 1024 ** 2 };
export interface BackupRecord { id: string; name: string; createdAt: number; bytes: number; profileCount: number; path: string; sha256: string; workspaceId: string; workspaceName: string; encrypted?: boolean }
export interface BackupJob {
  id: string; type: "create" | "restore"; status: "queued" | "running" | "succeeded" | "failed";
  phase: string; completedBytes: number; totalBytes: number; completedFiles: number; totalFiles: number;
  createdAt: number; updatedAt: number; finishedAt?: number; error?: string; backupId?: string; restoredWorkspaceId?: string;
}
export interface WorkspaceBackupOptions {
  catalog: WorkspaceCatalog;
  assertIdle: () => void | Promise<void>;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  limits?: Partial<BackupLimits>;
}
interface ArchiveFile { path: string; bytes: number; sha256: string }
interface Manifest {
  version: 1; appVersion: string; createdAt: number; workspace: { name: string; color: string; icon: string };
  profileCount: number; directories: string[]; files: ArchiveFile[];
}
function safePath(path: unknown, directory = false): asserts path is string {
  if (typeof path !== "string" || !path || Buffer.byteLength(path) > 4096 || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith("/")) throw new Error("Unsafe backup entry path");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe backup entry name");
  if (parts.length > 128 || (parts.length === 1 ? directory ? !ROOT_DIRECTORIES.has(parts[0]!) : !ROOT_FILES.has(path) : !ROOT_DIRECTORIES.has(parts[0]!))) throw new Error("Backup entry is outside the data allowlist");
}
function fileInside(root: string, path: string): string {
  const target = resolve(root, ...path.split("/"));
  if (!target.startsWith(resolve(root) + sep)) throw new Error("Backup entry escaped its root");
  return target;
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Delete only a generated, unlinked child of its explicitly named staging parent. */
function removeStaging(parent: string, path: string, prefix: string): void {
  const target = resolve(path);
  if (dirname(target) !== resolve(parent) || !basename(target).startsWith(prefix)) throw new Error("Unsafe workspace staging cleanup path");
  if (!workspaceEntryExists(target)) return;
  assertNoWorkspaceLinks(target);
  rmSync(target, { recursive: true, force: true });
}
function table(db: Database, name: string): boolean { return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function inspectDatabase(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (integrity?.integrity_check !== "ok" || !table(db, "profiles")) throw new Error("Backup database integrity check failed");
    if (db.query("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') OR upper(sql) LIKE '%CREATE VIRTUAL TABLE%' LIMIT 1").get()) throw new Error("Unsupported executable database schema in backup");
    if (table(db, "launches") && (db.query("SELECT count(*) AS n FROM launches").get() as { n: number }).n) throw new Error("Close all workspace browsers before creating or restoring a backup");
    for (const row of db.query("SELECT id FROM profiles").iterate() as Iterable<{ id: unknown }>) if (!isSafeProfileId(row.id)) throw new Error("Backup database contains an unsafe profile ID");
    const columns = db.query("PRAGMA table_info(profiles)").all() as { name: string }[];
    return (db.query(`SELECT count(*) AS n FROM profiles${columns.some(column => column.name === "trashed_at") ? " WHERE trashed_at=0" : ""}`).get() as { n: number }).n;
  } finally { db.close(); }
}
function rewriteExtensions(database: string, sourceRoot: string, destinationRoot?: string): void {
  const db = new Database(database);
  try {
    if (table(db, "launches")) db.exec("DELETE FROM launches");
    if (!table(db, "extensions")) return;
    const rows = db.query("SELECT id, load_dir AS path FROM extensions").all() as { id: string; path: string }[];
    for (const row of rows) {
      let portable: string;
      if (destinationRoot) {
        portable = row.path;
        safePath(portable, true);
        if (!portable.startsWith("extensions/")) throw new Error("Invalid extension path in backup database");
      } else {
        const suffix = relative(join(sourceRoot, "extensions"), resolve(row.path));
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Extension data is outside this workspace");
        portable = "extensions/" + suffix.split(sep).join("/");
        safePath(portable, true);
      }
      plainDirectory(fileInside(sourceRoot, portable));
      db.query("UPDATE extensions SET load_dir=? WHERE id=?").run(destinationRoot ? fileInside(destinationRoot, portable) : portable, row.id);
    }
  } finally { db.close(); }
}
function decryptSnapshotForPortableBackup(snapshotPath: string): void {
  const db = new Database(snapshotPath);
  try {
    const columns = ["password", "email_password", "twofa", "proxy_json", "cookies_json", "session_json", "pending_cookies_json"] as const;
    const rows = db.query<Record<string, string | null>, []>(
      `SELECT id, ${columns.join(", ")} FROM profiles`,
    ).all();
    const hasEncrypted = rows.some((row) => columns.some((col) => isEncryptedSecret(row[col])));
    if (!hasEncrypted) return;
    const protector = createLocalSecretProtector();
    const update = db.query(
      `UPDATE profiles SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    );
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const next = columns.map((col) => {
          const val = row[col] ?? null;
          return typeof val === "string" && isEncryptedSecret(val) ? protector.decrypt(val) : val;
        });
        update.run(...next, row.id ?? "");
      }
      db.exec("PRAGMA user_version = 1");
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function sufficientSpace(path: string, bytes: number): void {
  const stats = statfsSync(path);
  if (stats.bavail * stats.bsize < bytes + 100 * 1024 ** 2) throw new Error("Not enough free space for a complete workspace backup or restore");
}
/** Keep recovered preferences and leave automatic network actions off until reviewed. */
function prepareRestoredAppSettings(root: string): void {
  const path = join(root, "app-settings.json");
  if (!workspaceEntryExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Backup application settings are invalid or unsupported");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.sync || typeof raw.sync !== "object" || Array.isArray(raw.sync) || typeof raw.sync.enabled !== "boolean") throw new Error("invalid");
    // Disable before host-dependent path validation, preserving a Windows path
    // when restoring on macOS/Linux (and vice versa) without making it active.
    const settings = parseAppSettings({ ...raw, sync: { ...raw.sync, enabled: false } });
    settings.updates.checkOnStartup = false;
    settings.signedUpdates = { checkOnStartup: false };
    writeWorkspaceJson(path, settings);
  } catch { throw new Error("Backup application settings are invalid or unsupported"); }
}
/** Only the strict, non-secret template format can enter a restored workspace. */
function prepareRestoredProfileTemplates(root: string): void {
  const path = join(root, PROFILE_TEMPLATES_FILE);
  if (!workspaceEntryExists(path)) return;
  try { writeWorkspaceJson(path, new ProfileTemplateStore(path).read()); }
  catch { throw new Error("Backup profile templates are invalid or unsupported"); }
}
function backupModelServices(root: string, destination: string): boolean {
  if (!workspaceEntryExists(join(root, ASSISTANT_MODEL_SERVICES_FILE))) return false;
  try { writeWorkspaceJson(destination, new AssistantModelServices(root).backupMetadata()); }
  catch { throw new Error("Backup model services are invalid or unsupported."); }
  return true;
}
function validateManifest(value: unknown, limits: BackupLimits): Manifest {
  const manifest = value as Manifest;
  if (!manifest || manifest.version !== 1 || typeof manifest.appVersion !== "string" || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0
    || !manifest.workspace || typeof manifest.workspace.name !== "string" || !manifest.workspace.name.trim() || Array.from(manifest.workspace.name).length > 40
    || !(WORKSPACE_COLORS as readonly string[]).includes(manifest.workspace.color) || !(WORKSPACE_ICONS as readonly string[]).includes(manifest.workspace.icon)
    || !Number.isSafeInteger(manifest.profileCount) || manifest.profileCount < 0 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)
    || manifest.files.length + manifest.directories.length > limits.maxFiles) throw new Error("Invalid workspace backup manifest");
  const entries = new Set<string>(), files = new Set<string>();
  let total = 0;
  for (const directory of manifest.directories) {
    safePath(directory, true);
    const key = directory.normalize("NFC").toLowerCase();
    if (entries.has(key)) throw new Error("Duplicate backup entry");
    entries.add(key);
  }
  for (const file of manifest.files) {
    safePath(file?.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (entries.has(key)) throw new Error("Duplicate backup entry");
    entries.add(key); files.add(key);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.maxFileBytes || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("Invalid backup file metadata");
    if (file.path === PROFILE_TEMPLATES_FILE && file.bytes > PROFILE_TEMPLATE_LIMITS.fileBytes) throw new Error("Backup profile templates are invalid or unsupported");
    if (file.path === ASSISTANT_MODEL_SERVICES_FILE && file.bytes > ASSISTANT_MODEL_SERVICES_FILE_LIMIT) throw new Error("Backup model services are invalid or unsupported.");
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > limits.maxUnpackedBytes) throw new Error("Backup exceeds the unpacked size limit");
  }
  if (!files.has("profiles.sqlite")) throw new Error("Backup database is missing");
  for (const entry of [...manifest.directories, ...manifest.files.map(file => file.path)]) {
    const parts = entry.split("/"); parts.pop();
    while (parts.length) { if (files.has(parts.join("/").normalize("NFC").toLowerCase())) throw new Error("A backup file is used as a directory"); parts.pop(); }
  }
  return manifest;
}
class ArchiveReader {
  private iterator: AsyncIterator<Buffer>; private chunk = Buffer.alloc(0); private offset = 0; private total = 0;
  constructor(stream: AsyncIterable<Buffer>, private maximum: number) { this.iterator = stream[Symbol.asyncIterator](); }
  async read(count: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let length = 0;
    while (length < count) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next(); if (next.done) break;
        this.chunk = Buffer.from(next.value); this.offset = 0; this.total += this.chunk.length;
        if (this.total > this.maximum) throw new Error("Backup exceeds the decompression limit");
      }
      const end = Math.min(this.chunk.length, this.offset + count - length);
      chunks.push(this.chunk.subarray(this.offset, end)); length += end - this.offset; this.offset = end;
    }
    return Buffer.concat(chunks, length);
  }
  async exact(count: number): Promise<Buffer> { const bytes = await this.read(count); if (bytes.length !== count) throw new Error("Truncated workspace backup"); return bytes; }
}

export function validateBackupPassword(password: unknown): string | undefined {
  if (password === undefined) return;
  if (typeof password !== "string" || Array.from(password).length < 10 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Backup password must contain at least 10 characters and at most 1024 UTF-8 bytes.");
  }
  return password;
}

function frameNonce(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  return nonce;
}

/** Each GCM frame authenticates its length, position and archive header before being decoded. */
function encryptArchive(password: string, limit: number) {
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    const salt = randomBytes(SALT_BYTES), prefix = randomBytes(NONCE_PREFIX_BYTES);
    const header = Buffer.concat([ENCRYPTED_MAGIC, salt, prefix]);
    const key = await deriveWorkspacePasswordKey(password, salt);
    const reader = new ArchiveReader(source, limit);
    try {
      yield header;
      for (let index = 0; ; index++) {
        const clear = await reader.read(FRAME_BYTES), size = Buffer.alloc(4);
        size.writeUInt32BE(clear.length);
        const cipher = createCipheriv("aes-256-gcm", key, frameNonce(prefix, index), { authTagLength: AUTH_TAG_BYTES });
        cipher.setAAD(Buffer.concat([header, size]));
        yield Buffer.concat([size, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
        // An authenticated empty frame commits the end of the stream.
        if (!clear.length) return;
      }
    } finally { key.fill(0); }
  };
}

async function* compressedArchive(source: AsyncIterable<Buffer>, password: string | undefined, limit: number): AsyncGenerator<Buffer> {
  const reader = new ArchiveReader(source, limit);
  const magic = await reader.read(ENCRYPTED_MAGIC.length);
  if (!magic.equals(ENCRYPTED_MAGIC)) {
    yield magic;
    for (let bytes = await reader.read(FRAME_BYTES); bytes.length; bytes = await reader.read(FRAME_BYTES)) yield bytes;
    return;
  }
  if (password === undefined) throw new Error("Enter the password for this encrypted backup.");
  const damaged = "The backup password is incorrect or the encrypted backup is damaged.";
  const suffix = await reader.read(SALT_BYTES + NONCE_PREFIX_BYTES);
  if (suffix.length !== SALT_BYTES + NONCE_PREFIX_BYTES) throw new Error(damaged);
  const salt = suffix.subarray(0, SALT_BYTES), prefix = suffix.subarray(SALT_BYTES);
  const header = Buffer.concat([magic, salt, prefix]);
  const key = await deriveWorkspacePasswordKey(password, salt);
  try {
    let finalDataFrame = false;
    for (let index = 0; ; index++) {
      const size = await reader.read(4);
      if (size.length !== 4) throw new Error(damaged);
      const bytes = size.readUInt32BE();
      if (bytes > FRAME_BYTES || finalDataFrame && bytes !== 0) throw new Error(damaged);
      const frame = await reader.read(bytes + AUTH_TAG_BYTES);
      if (frame.length !== bytes + AUTH_TAG_BYTES) throw new Error(damaged);
      const decipher = createDecipheriv("aes-256-gcm", key, frameNonce(prefix, index), { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(Buffer.concat([header, size]));
      decipher.setAuthTag(frame.subarray(bytes));
      let clear: Buffer;
      try { clear = Buffer.concat([decipher.update(frame.subarray(0, bytes)), decipher.final()]); }
      catch { throw new Error(damaged); }
      if (bytes === 0) {
        if ((await reader.read(1)).length) throw new Error(damaged);
        return;
      }
      finalDataFrame = bytes < FRAME_BYTES;
      yield clear;
    }
  } finally { key.fill(0); }
}

export class WorkspaceBackupService {
  readonly directory: string;
  private readonly limits: BackupLimits;
  private readonly historyPath: string;
  private records: BackupRecord[] = [];
  private history: BackupJob[] = [];
  private pending = new Map<string, Promise<BackupJob>>();
  private active: string | null = null;
  private lastProgressSave = 0;
  constructor(private readonly options: WorkspaceBackupOptions) {
    options.catalog.currentId(); plainDirectory(options.catalog.currentRoot);
    this.directory = join(options.catalog.currentRoot, "backups"); plainDirectory(this.directory, true);
    this.historyPath = join(this.directory, "index.json");
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid backup limits");
    if (workspaceEntryExists(this.historyPath)) {
      const stat = lstatSync(this.historyPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 ** 2) throw new Error("Invalid backup history");
      const saved = JSON.parse(readFileSync(this.historyPath, "utf8"));
      if (saved?.version !== 1 || !Array.isArray(saved.backups) || !Array.isArray(saved.jobs)) throw new Error("Invalid backup history");
      this.records = saved.backups.map((record: BackupRecord) => {
        if (!BACKUP_ID.test(record.id) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.profileCount) || record.profileCount < 0 || typeof record.name !== "string" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || record.encrypted !== undefined && typeof record.encrypted !== "boolean") throw new Error("Invalid backup history record");
        return { ...record, path: this.archivePath(record.id) };
      });
      const interrupted: string[] = [];
      this.history = saved.jobs.map((job: BackupJob) => {
        if (!JOB_ID.test(job.id) || !["queued", "running", "succeeded", "failed"].includes(job.status)) throw new Error("Invalid backup job history");
        if (["queued", "running"].includes(job.status)) interrupted.push(job.id);
        return ["queued", "running"].includes(job.status) ? { ...job, status: "failed" as const, phase: "interrupted", error: "The app stopped before this operation finished. Retry the operation; existing workspaces were preserved.", updatedAt: Date.now(), finishedAt: Date.now() } : job;
      }).slice(-100);
      for (const id of interrupted) {
        for (const name of readdirSync(this.directory)) if (name.startsWith(`.create-${id}-`)) removeStaging(this.directory, join(this.directory, name), `.create-${id}-`);
        const partial = this.partialArchivePath(id);
        if (workspaceEntryExists(partial)) {
          const entry = lstatSync(partial);
          if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1) rmSync(partial);
        }
        const parent = join(options.catalog.home, "workspaces");
        if (workspaceEntryExists(parent)) { plainDirectory(parent); for (const name of readdirSync(parent)) if (name.startsWith(`.restore-${id}-`)) removeStaging(parent, join(parent, name), `.restore-${id}-`); }
      }
      this.persist();
    }
  }
  private archivePath(id: string): string { if (!BACKUP_ID.test(id)) throw new Error("Invalid backup ID"); return join(this.directory, `${id}.mqbackup`); }
  private partialArchivePath(id: string): string { if (!JOB_ID.test(id)) throw new Error("Invalid backup job ID"); return join(this.directory, `.create-${id}.partial`); }
  private persist(): void { plainDirectory(this.directory); writeWorkspaceJson(this.historyPath, { version: 1, backups: this.records.map(({ path, ...record }) => record), jobs: this.history }); }
  busy(): boolean { return this.active !== null; }
  jobs(): BackupJob[] { return structuredClone(this.history); }
  getJob(id: string): BackupJob | undefined { return structuredClone(this.history.find(job => job.id === id)); }
  listBackups(): BackupRecord[] { return structuredClone(this.records); }
  getBackupFile(id: string): { path: string; fileName: string; size: number; bytes: number; sha256: string } {
    const record = this.records.find(item => item.id === id); if (!record) throw new Error("Backup not found");
    plainDirectory(this.directory); const path = this.archivePath(id); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== record.bytes) throw new Error("Backup file is missing or changed");
    return { path, fileName: `${id}.mqbackup`, size: stat.size, bytes: stat.size, sha256: record.sha256 };
  }
  wait(id: string): Promise<BackupJob> { const pending = this.pending.get(id); const job = this.getJob(id); if (!job) return Promise.reject(new Error("Backup job not found")); return pending ?? Promise.resolve(job); }
  private progress(job: BackupJob, patch: Partial<BackupJob>): void {
    Object.assign(job, patch, { updatedAt: Date.now() });
    if (Date.now() - this.lastProgressSave > 150 || patch.phase) { this.lastProgressSave = Date.now(); this.persist(); }
  }
  private launch(type: BackupJob["type"], operation: (job: BackupJob) => Promise<void>): BackupJob {
    if (this.busy()) throw new Error("A workspace backup or restore is already running");
    const now = Date.now(); const job: BackupJob = { id: `job_${randomUUID().replaceAll("-", "")}`, type, status: "queued", phase: "queued", createdAt: now, updatedAt: now, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
    this.history.push(job); this.history = this.history.slice(-100); this.active = job.id;
    try { this.persist(); } catch (error) { this.active = null; this.history = this.history.filter(item => item !== job); throw error; }
    const pending = Promise.resolve().then(() => this.options.exclusive(async () => {
      // Only creation snapshots live data. Restore reads a closed archive into a
      // fresh root, so existing browsers may keep running behind the same barrier.
      if (type === "create") await this.options.assertIdle();
      this.progress(job, { status: "running", phase: "preparing" });
      await operation(job);
      Object.assign(job, { status: "succeeded", phase: "complete", updatedAt: Date.now(), finishedAt: Date.now() });
    })).catch(error => { Object.assign(job, { status: "failed", phase: "failed", error: error instanceof Error ? error.message : "Workspace operation failed", updatedAt: Date.now(), finishedAt: Date.now() }); }).then(() => {
      try { this.persist(); }
      catch { Object.assign(job, { status: "failed", phase: "history-failed", error: "Operation history could not be saved. Existing workspace data and any completed backup were preserved.", updatedAt: Date.now(), finishedAt: Date.now() }); }
      finally { this.active = null; this.pending.delete(job.id); }
      return structuredClone(job);
    });
    this.pending.set(job.id, pending);
    return structuredClone(job);
  }
  startCreate(passwordInput?: unknown, options: { allowUnencrypted?: boolean } = {}): BackupJob {
    const password = validateBackupPassword(passwordInput);
    if (password === undefined && options.allowUnencrypted !== true) {
      throw new Error("Backup password is required unless unencrypted backup is explicitly allowed.");
    }
    return this.launch("create", job => this.createArchive(job, password));
  }
  startRestore(input: { backupId?: string; archivePath?: string; name?: string; password?: unknown }): BackupJob {
    if (!!input.backupId === !!input.archivePath) throw new Error("Choose exactly one backup source");
    const password = validateBackupPassword(input.password);
    const file = input.backupId ? this.getBackupFile(input.backupId) : { path: resolve(input.archivePath!), sha256: undefined };
    return this.launch("restore", job => this.restoreArchive(job, file.path, input.name, file.sha256, password));
  }
  private async createArchive(job: BackupJob, password?: string): Promise<void> {
    const root = this.options.catalog.currentRoot;
    const workspace = this.options.catalog.list().find(item => item.id === this.options.catalog.currentId())!;
    const staging = mkdtempSync(join(this.directory, `.create-${job.id}-`));
    const id = `bak_${randomUUID().replaceAll("-", "")}`;
    const partial = this.partialArchivePath(job.id);
    try {
      const source = join(root, "profiles.sqlite");
      const sourceStat = lstatSync(source); if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error("Workspace database is missing or linked");
      this.progress(job, { phase: "snapshot" });
      inspectDatabase(source);
      const db = new Database(source, { readonly: true });
      const snapshot = join(staging, "profiles.sqlite");
      try { db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`); } finally { db.close(); }
      if (password !== undefined) decryptSnapshotForPortableBackup(snapshot);
      rewriteExtensions(snapshot, root);
      const profileCount = inspectDatabase(snapshot);
      const directories: string[] = [], sources = new Map<string, string>([["profiles.sqlite", snapshot]]);
      if (workspaceEntryExists(join(root, PROFILE_TEMPLATES_FILE))) {
        // Capture validated settings once. A later template edit cannot change this archive's copy.
        const templates = new ProfileTemplateStore(join(root, PROFILE_TEMPLATES_FILE)).read();
        const snapshot = join(staging, PROFILE_TEMPLATES_FILE); writeWorkspaceJson(snapshot, templates);
        sources.set(PROFILE_TEMPLATES_FILE, snapshot);
      }
      const modelSnapshot = join(staging, ASSISTANT_MODEL_SERVICES_FILE);
      if (backupModelServices(root, modelSnapshot)) sources.set(ASSISTANT_MODEL_SERVICES_FILE, modelSnapshot);
      const walk = async (physical: string, path: string): Promise<void> => {
        const stat = await lstat(physical);
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("Linked or special workspace files cannot be backed up");
        safePath(path, stat.isDirectory());
        if (stat.isDirectory()) { directories.push(path); for (const name of await readdir(physical)) await walk(join(physical, name), `${path}/${name}`); }
        else sources.set(path, physical);
        if (sources.size + directories.length > this.limits.maxFiles) throw new Error("Workspace has too many backup entries");
      };
      for (const name of ROOT_DIRECTORIES) if (workspaceEntryExists(join(root, name))) await walk(join(root, name), name);
      for (const name of ROOT_FILES) if (!sources.has(name) && workspaceEntryExists(join(root, name))) await walk(join(root, name), name);
      const files: ArchiveFile[] = [];
      this.progress(job, { phase: "hashing", totalFiles: sources.size });
      for (const [path, physical] of sources) {
        const stat = await lstat(physical);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.maxFileBytes) throw new Error("Workspace file exceeds backup limits");
        files.push({ path, bytes: stat.size, sha256: await hashFile(physical) });
        this.progress(job, { completedFiles: files.length });
      }
      const manifest: Manifest = { version: 1, appVersion: ALIASMODE_VERSION, createdAt: Date.now(), workspace: { name: workspace.name, color: workspace.color, icon: workspace.icon }, profileCount, directories, files };
      validateManifest(manifest, this.limits);
      const json = Buffer.from(JSON.stringify(manifest)); if (json.length > this.limits.maxManifestBytes) throw new Error("Backup manifest exceeds the size limit");
      const size = files.reduce((total, file) => total + file.bytes, 0);
      sufficientSpace(this.directory, size + sourceStat.size);
      this.progress(job, { phase: "compressing", totalBytes: size, completedBytes: 0, completedFiles: 0 });
      const service = this;
      async function* contents() {
        yield MAGIC; const length = Buffer.alloc(4); length.writeUInt32BE(json.length); yield length; yield json;
        let bytes = 0, completed = 0;
        for (const file of files) {
          const physical = sources.get(file.path)!; const stat = await lstat(physical);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) throw new Error("Workspace changed while backing up");
          const hash = createHash("sha256"); let count = 0;
          for await (const chunk of createReadStream(physical)) { count += chunk.length; bytes += chunk.length; hash.update(chunk); service.progress(job, { completedBytes: bytes }); yield chunk; }
          if (count !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("Workspace changed while backing up");
          service.progress(job, { completedFiles: ++completed });
        }
      }
      const hash = createHash("sha256"); let compressed = 0;
      const measure = new Transform({ transform: (chunk, _encoding, callback) => {
        compressed += chunk.length; if (compressed > this.limits.maxArchiveBytes) { callback(new Error("Backup exceeds the compressed size limit")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      const archive = createWriteStream(partial, { flags: "wx", mode: 0o600 });
      if (password === undefined) await pipeline(Readable.from(contents()), createGzip(), measure, archive);
      else await pipeline(Readable.from(contents()), createGzip(), encryptArchive(password, this.limits.maxArchiveBytes), measure, archive);
      const completedArchive = await open(partial, "r+");
      try { await completedArchive.sync(); } finally { await completedArchive.close(); }
      const path = this.archivePath(id); renameSync(partial, path);
      const record: BackupRecord = { id, name: workspace.name, createdAt: manifest.createdAt, bytes: compressed, profileCount, path, sha256: hash.digest("hex"), workspaceId: workspace.id, workspaceName: workspace.name, ...(password === undefined ? {} : { encrypted: true }) };
      this.records.push(record); job.backupId = id;
    } finally { if (workspaceEntryExists(partial)) { if (lstatSync(partial).isSymbolicLink()) throw new Error("Linked backup output cannot be removed"); rmSync(partial); } removeStaging(this.directory, staging, `.create-${job.id}-`); }
  }
  private async restoreArchive(job: BackupJob, archive: string, requestedName?: string, expectedHash?: string, password?: string): Promise<void> {
    const stat = await lstat(archive);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > this.limits.maxArchiveBytes) throw new Error("Invalid or oversized backup file");
    this.progress(job, { phase: "validating" });
    if (expectedHash && await hashFile(archive) !== expectedHash) throw new Error("Backup archive checksum does not match its history record");
    const parent = join(this.options.catalog.home, "workspaces"); plainDirectory(parent, true);
    const staging = mkdtempSync(join(parent, `.restore-${job.id}-`));
    const source = createReadStream(archive), decoded = createGunzip();
    const transfer = pipeline(source, input => compressedArchive(input, password, this.limits.maxArchiveBytes), decoded);
    void transfer.catch(() => {});
    try {
      const reader = new ArchiveReader(decoded, this.limits.maxUnpackedBytes + this.limits.maxManifestBytes + MAGIC.length + 4);
      if (!(await reader.exact(MAGIC.length)).equals(MAGIC)) throw new Error("Not a workspace backup");
      const length = (await reader.exact(4)).readUInt32BE();
      if (!length || length > this.limits.maxManifestBytes) throw new Error("Backup manifest exceeds the size limit");
      const manifest = validateManifest(JSON.parse((await reader.exact(length)).toString("utf8")), this.limits);
      const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0); sufficientSpace(parent, total);
      this.progress(job, { phase: "restoring", totalBytes: total, totalFiles: manifest.files.length });
      for (const directory of manifest.directories) await mkdir(fileInside(staging, directory), { recursive: true });
      let bytes = 0, completed = 0;
      for (const file of manifest.files) {
        const path = fileInside(staging, file.path); await mkdir(dirname(path), { recursive: true });
        const output = await open(path, "wx", 0o600); const hash = createHash("sha256"); let remaining = file.bytes;
        try {
          while (remaining) {
            const chunk = await reader.exact(Math.min(64 * 1024, remaining)); hash.update(chunk);
            let offset = 0; while (offset < chunk.length) { const written = (await output.write(chunk, offset)).bytesWritten; if (!written) throw new Error("Backup restore write could not make progress"); offset += written; }
            remaining -= chunk.length; bytes += chunk.length; this.progress(job, { completedBytes: bytes });
          }
          await output.sync();
        } finally { await output.close(); }
        if (hash.digest("hex") !== file.sha256) throw new Error("Backup file checksum mismatch");
        this.progress(job, { completedFiles: ++completed });
      }
      if ((await reader.read(1)).length) throw new Error("Unexpected trailing backup data");
      await transfer;
      const database = join(staging, "profiles.sqlite");
      if (inspectDatabase(database) !== manifest.profileCount) throw new Error("Backup profile count does not match its manifest");
      prepareRestoredAppSettings(staging);
      prepareRestoredProfileTemplates(staging);
      backupModelServices(staging, join(staging, ASSISTANT_MODEL_SERVICES_FILE));
      const id = `ws_${randomUUID().replaceAll("-", "")}`; const destination = join(parent, id);
      rewriteExtensions(database, staging, destination); inspectDatabase(database); assertNoWorkspaceLinks(staging);
      let name = requestedName;
      if (name === undefined) {
        const base = Array.from(manifest.workspace.name).slice(0, 32).join(""); name = `${base}（恢复）`;
        let counter = 2; const names = new Set(this.options.catalog.list().map(item => item.name.toLowerCase()));
        while (names.has(name.toLowerCase())) name = `${base}（恢复${counter++}）`;
      }
      this.progress(job, { phase: "publishing" });
      const restored = this.options.catalog.publishRestored({ name, color: manifest.workspace.color, icon: manifest.workspace.icon }, staging, id);
      job.restoredWorkspaceId = restored.id;
    } finally {
      source.destroy(); decoded.destroy();
      await transfer.catch(() => {});
      removeStaging(parent, staging, `.restore-${job.id}-`);
    }
  }
}
