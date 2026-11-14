import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { assertValidProfile } from "./profile-validation.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { parseCapturedSessionBundle } from "./session.ts";
import type { Profile } from "./types.ts";
import { ALIASMODE_VERSION } from "./version.ts";
import { plainDirectory, workspaceEntryExists } from "./workspaces.ts";

const MAGIC = Buffer.from("MAOBU-SYNC\0v1\n");
const SALT_BYTES = 16, IV_BYTES = 12, TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
export const MAX_SYNC_SNAPSHOT_BYTES = 64 * 1024 ** 2;
const MAX_PROFILES = 10_000;
const FILE_NAME = /^maobu-sync-(\d{13})-[a-f0-9]{16}\.mqsync$/;
const PROFILE_FIELDS = new Set([
  "id", "engine", "chromiumRuntime", "hardware", "firefox", "accId", "name", "group", "platform", "username", "password", "email", "emailPassword",
  "twofa", "proxy", "proxyError", "extensions", "tags", "customNo", "ua", "timezone", "timezoneManual", "displayScale", "locale", "screenWidth", "screenHeight",
  "fingerprintSeed", "platformOs", "fpObserved", "fpExpected", "fpVerdict", "cookies", "seeded",
]);
export interface SyncSnapshot {
  version: 1; appVersion: string; createdAt: number;
  profiles: Profile[];
  /** The latest saved portable sessions; never a raw browser-directory copy. */
  sessions: Record<string, string>;
}
export interface SyncFileRecord { fileName: string; bytes: number; createdAt: number; modifiedAt: number; sha256?: string }
export interface SyncPreview {
  profileCount: number; sessionCount: number; newCount: number; conflictCount: number;
  profiles: { id: string; name: string; group: string; conflict: boolean; hasSession: boolean }[];
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || Array.from(password).length < 10 || Buffer.byteLength(password, "utf8") > 1024) throw new Error("Sync password must contain at least 10 characters and at most 1024 UTF-8 bytes");
}
export function deriveWorkspacePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  // Fixed parameters cannot be raised by an untrusted snapshot header.
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key)));
}
function validateSession(bundle: unknown): asserts bundle is string {
  if (typeof bundle !== "string" || Buffer.byteLength(bundle, "utf8") > MAX_SYNC_SNAPSHOT_BYTES) throw new Error("Invalid saved session in sync snapshot");
  try {
    const parsed: unknown = JSON.parse(bundle);
    if (!record(parsed)) throw new Error("invalid");
    // Older cookie-only checkpoints omit origins. Validate that legacy shape
    // without modifying or dropping the original stored session string.
    parseCapturedSessionBundle(JSON.stringify({ ...parsed, origins: parsed.origins === undefined ? [] : parsed.origins }));
  } catch { throw new Error("Invalid saved session in sync snapshot"); }
}
/** Bound JSON-shaped inputs before expensive validation and cloning. */
function assertSnapshotBudget(value: unknown): void {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 64) throw new Error("Sync snapshot is too complex");
    if (typeof entry === "string") bytes += Buffer.byteLength(entry, "utf8");
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null || entry === undefined) bytes += 8;
    else if (typeof entry === "object") {
      if (ancestors.has(entry)) throw new Error("Sync snapshot cannot contain cyclic data");
      ancestors.add(entry); bytes += 2;
      if (Array.isArray(entry)) for (const item of entry) { bytes += 1; visit(item, depth + 1); }
      else for (const [key, item] of Object.entries(entry)) { bytes += Buffer.byteLength(key, "utf8") + 4; visit(item, depth + 1); }
      ancestors.delete(entry);
    } else throw new Error("Sync snapshot must contain JSON data");
    if (bytes > MAX_SYNC_SNAPSHOT_BYTES) throw new Error("Sync snapshot exceeds the 64 MiB size limit");
  };
  visit(value, 0);
}
export function validateSyncSnapshot(value: unknown): SyncSnapshot {
  assertSnapshotBudget(value);
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !["version", "appVersion", "createdAt", "profiles", "sessions"].includes(key))
    || typeof value.appVersion !== "string" || value.appVersion.length > 100 || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES || !record(value.sessions)) throw new Error("Invalid sync snapshot");
  const ids = new Set<string>(), casefoldIds = new Set<string>();
  for (const profile of value.profiles) {
    assertValidProfile(profile);
    if (Object.keys(profile).some(key => !PROFILE_FIELDS.has(key))) throw new Error("Unsupported profile fields in sync snapshot");
    if (profile.proxy) normalizeProxySpec(profile.proxy);
    if (ids.has(profile.id) || casefoldIds.has(profile.id.toLowerCase())) throw new Error("Duplicate profile ID in sync snapshot");
    ids.add(profile.id); casefoldIds.add(profile.id.toLowerCase());
  }
  for (const [id, bundle] of Object.entries(value.sessions)) {
    if (!ids.has(id)) throw new Error("Saved session has no matching profile in sync snapshot");
    validateSession(bundle);
  }
  return structuredClone(value) as unknown as SyncSnapshot;
}

export function createSyncSnapshot(profiles: readonly Profile[], sessions: ReadonlyMap<string, string> | Record<string, string> = {}, now = Date.now()): SyncSnapshot {
  const sessionEntries = sessions instanceof Map ? Array.from(sessions.entries()) : Object.entries(sessions);
  return validateSyncSnapshot({ version: 1, appVersion: ALIASMODE_VERSION, createdAt: now, profiles, sessions: Object.fromEntries(sessionEntries) });
}
export async function sealSyncSnapshot(value: SyncSnapshot, password: string): Promise<Buffer> {
  validPassword(password);
  const snapshot = validateSyncSnapshot(value);
  const cleartext = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (cleartext.length > MAX_SYNC_SNAPSHOT_BYTES) { cleartext.fill(0); throw new Error("Sync snapshot exceeds the 64 MiB size limit"); }
  const salt = randomBytes(SALT_BYTES), iv = randomBytes(IV_BYTES);
  const aad = Buffer.concat([MAGIC, salt, iv]);
  let key: Buffer | undefined;
  try {
    key = await deriveWorkspacePasswordKey(password, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES }); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    return Buffer.concat([aad, cipher.getAuthTag(), encrypted]);
  } finally { key?.fill(0); cleartext.fill(0); }
}
export async function openSyncSnapshot(data: Uint8Array, password: string): Promise<SyncSnapshot> {
  validPassword(password);
  if (!(data instanceof Uint8Array) || data.byteLength < HEADER_BYTES || data.byteLength > MAX_SYNC_SNAPSHOT_BYTES + HEADER_BYTES) throw new Error("Invalid or oversized encrypted sync snapshot");
  const bytes = Buffer.from(data);
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported encrypted sync snapshot format");
  const saltEnd = MAGIC.length + SALT_BYTES, ivEnd = saltEnd + IV_BYTES;
  const salt = bytes.subarray(MAGIC.length, saltEnd), iv = bytes.subarray(saltEnd, ivEnd);
  let key: Buffer | undefined, cleartext: Buffer | undefined;
  try {
    key = await deriveWorkspacePasswordKey(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(bytes.subarray(0, ivEnd)); decipher.setAuthTag(bytes.subarray(ivEnd, HEADER_BYTES));
    // Return no plaintext until final() has authenticated the complete message.
    cleartext = Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES)), decipher.final()]);
    return validateSyncSnapshot(JSON.parse(cleartext.toString("utf8")));
  } catch { throw new Error("Unable to unlock sync snapshot. Check the password and file integrity."); }
  finally { key?.fill(0); cleartext?.fill(0); }
}
function syncFolder(folder: string, create = false): string {
  if (typeof folder !== "string" || !isAbsolute(folder) || /[\x00-\x1f\x7f]/.test(folder)) throw new Error("Sync folder must be an absolute path");
  const root = resolve(folder); plainDirectory(root, create); return root;
}
function snapshotPath(folder: string, fileName: string): string {
  if (typeof fileName !== "string" || !FILE_NAME.test(fileName) || basename(fileName) !== fileName) throw new Error("Invalid sync snapshot filename");
  return join(folder, fileName);
}
export function listSyncSnapshots(folder: string): SyncFileRecord[] {
  if (!workspaceEntryExists(folder)) { if (!isAbsolute(folder)) throw new Error("Sync folder must be an absolute path"); return []; }
  const root = syncFolder(folder);
  const records: SyncFileRecord[] = [];
  for (const fileName of readdirSync(root)) {
    const match = FILE_NAME.exec(fileName); if (!match) continue;
    const stat = lstatSync(snapshotPath(root, fileName));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SYNC_SNAPSHOT_BYTES + HEADER_BYTES || stat.size < HEADER_BYTES) continue;
    records.push({ fileName, bytes: stat.size, createdAt: Number(match[1]), modifiedAt: Math.trunc(stat.mtimeMs) });
  }
  return records.sort((a, b) => b.createdAt - a.createdAt || b.fileName.localeCompare(a.fileName));
}
/** Write immutable encrypted snapshots, so sync clients never merge a live SQLite database. */
export async function writeSyncSnapshot(folder: string, snapshot: SyncSnapshot, password: string, options: { retainSnapshots?: number } = {}): Promise<SyncFileRecord> {
  const retain = options.retainSnapshots ?? 10;
  if (!Number.isInteger(retain) || retain < 1 || retain > 100) throw new Error("Snapshot retention must be from 1 to 100");
  const bytes = await sealSyncSnapshot(snapshot, password);
  const root = syncFolder(folder, true);
  const createdAt = Date.now();
  const fileName = `maobu-sync-${createdAt}-${randomBytes(8).toString("hex")}.mqsync`;
  const destination = snapshotPath(root, fileName), temporary = `${destination}.partial`;
  let published = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination); published = true;
    // Retention applies only to this format's own regular snapshot files.
    // A filesystem error pruning history never makes a successfully saved file look lost.
    try {
      // Every writer sorts the same complete history before applying retention.
      // Filtering out its own file *before* slicing could let two writers each
      // delete the other's newest file. Keep this write even under clock skew.
      const older = listSyncSnapshots(root).slice(retain).filter(item => item.fileName !== fileName);
      for (const old of older) {
        const path = snapshotPath(root, old.fileName);
        try { const stat = lstatSync(path); if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path); } catch { /* Keep existing history when another sync client is using it. */ }
      }
    } catch { /* A transport client may temporarily lock directory enumeration. */ }
    const stat = lstatSync(destination);
    return { fileName, bytes: bytes.length, createdAt, modifiedAt: Math.trunc(stat.mtimeMs), sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { if (!published && workspaceEntryExists(temporary)) unlinkSync(temporary); }
}
export async function readSyncSnapshot(folder: string, fileName: string, password: string): Promise<SyncSnapshot> {
  const root = syncFolder(folder), path = snapshotPath(root, fileName), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SYNC_SNAPSHOT_BYTES + HEADER_BYTES || stat.size < HEADER_BYTES) throw new Error("Invalid or linked sync snapshot file");
  const fd = openSync(path, "r");
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("Sync snapshot changed while opening it");
    bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) throw new Error("Sync snapshot changed while reading it");
      read += count;
    }
    // A transport client may replace or append to a snapshot while it is read.
    // Never turn that race into an unbounded readFile allocation.
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error("Sync snapshot changed while reading it");
  } finally { closeSync(fd); }
  return openSyncSnapshot(bytes, password);
}
/** Safe preview contains no cookies, passwords, proxy credentials, or session values. */
export function previewSyncSnapshot(value: SyncSnapshot, existingIds: Iterable<string>): SyncPreview {
  const snapshot = validateSyncSnapshot(value), existing = new Set(Array.from(existingIds, id => id.toLowerCase()));
  const profiles = snapshot.profiles.map(profile => ({ id: profile.id, name: profile.name, group: profile.group, conflict: existing.has(profile.id.toLowerCase()), hasSession: Object.hasOwn(snapshot.sessions, profile.id) }));
  const conflictCount = profiles.filter(profile => profile.conflict).length;
  return { profileCount: profiles.length, sessionCount: Object.keys(snapshot.sessions).length, newCount: profiles.length - conflictCount, conflictCount, profiles };
}
