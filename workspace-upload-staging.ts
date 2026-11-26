import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const stageName = /^\.upload-v1-([0-9a-f]{32})$/;
const leaseName = "lease.sqlite";
const leaseApplicationId = 0x4d415542;

async function readEntry(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function uploadDirectory(backupDirectory: string, create: boolean): Promise<string | null> {
  const parent = await readEntry(backupDirectory);
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("The backup directory is unsafe");
  const directory = join(backupDirectory, ".uploads");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await readEntry(directory);
  if (!entry) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("The backup upload directory is unsafe");
  return directory;
}

function holdLease(path: string, create: boolean): Database {
  const database = new Database(path, { create, readwrite: true });
  try {
    if (create) database.exec(`PRAGMA application_id = ${leaseApplicationId}`);
    // SQLite's OS lock releases even if the upload or restore process is killed.
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const marker = database.query<{ application_id: number }, []>("PRAGMA application_id").get();
    if (marker?.application_id !== leaseApplicationId) throw new Error("Unrecognized workspace upload lease");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function removeArchive(directory: string, path: string, lease: Database): Promise<void> {
  try {
    const stage = await readEntry(directory);
    if (!stage?.isDirectory() || stage.isSymbolicLink()) return;
    const entry = await readEntry(path);
    if (entry) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return;
      await unlink(path);
    }
  } finally {
    lease.close();
  }
  // Leave any unexpected directory contents in place. Never remove recursively.
  await unlink(join(directory, leaseName)).catch(() => {});
  await rmdir(directory).catch(() => {});
}

export async function stageWorkspaceUpload(backupDirectory: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const uploads = (await uploadDirectory(backupDirectory, true))!;
  const id = randomBytes(16).toString("hex");
  const directory = join(uploads, `.upload-v1-${id}`);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, `upload_${id}.mqbackup`);
  let lease: Database;
  try {
    lease = holdLease(join(directory, leaseName), true);
  } catch (error) {
    await unlink(join(directory, leaseName)).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
  let disposed = false;
  return {
    path,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await removeArchive(directory, path, lease);
    },
  };
}

export async function recoverWorkspaceUploads(backupDirectory: string): Promise<void> {
  const uploads = await uploadDirectory(backupDirectory, false);
  if (!uploads) return;
  for (const entry of await readdir(uploads, { withFileTypes: true })) {
    const id = stageName.exec(entry.name)?.[1];
    if (!id || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(uploads, entry.name);
    const path = join(directory, `upload_${id}.mqbackup`);
    const leasePath = join(directory, leaseName);
    try {
      const stage = await readEntry(directory);
      if (!stage?.isDirectory() || stage.isSymbolicLink()) continue;
      const archive = await readEntry(path);
      const marker = await readEntry(leasePath);
      // The owner creates the payload only after taking the lock. Flat uploads
      // from older versions and directories without a published payload have
      // no proof that it is safe to take ownership.
      if (!archive?.isFile() || archive.isSymbolicLink() || archive.nlink !== 1
        || !marker?.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) continue;
      const lease = holdLease(leasePath, false);
      await removeArchive(directory, path, lease);
    } catch {
      // An active upload, unreadable lock, or failed cleanup must leave the
      // file available to the original owner or a future recovery attempt.
    }
  }
}
