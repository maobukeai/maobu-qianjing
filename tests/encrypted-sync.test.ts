import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildNewProfile } from "../create.ts";
import { createSyncSnapshot, listSyncSnapshots, openSyncSnapshot, previewSyncSnapshot, readSyncSnapshot, sealSyncSnapshot, validateSyncSnapshot, writeSyncSnapshot } from "../encrypted-sync.ts";

const roots: string[] = [];
const fixtureParent = resolve(import.meta.dir, "..", "node_modules", ".cache", "sync-tests");
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(fixtureParent + sep)) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  mkdirSync(fixtureParent, { recursive: true }); const root = mkdtempSync(join(fixtureParent, "case-")); roots.push(root);
  const profile = buildNewProfile({ name: "Personal", username: "alice", password: "account-password", group: "Research" }, () => false); profile.id = "profile001";
  const session = JSON.stringify({ cookies: [{ name: "auth", value: "cookie-secret", domain: ".example.com", path: "/" }], origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "local-storage-secret" }] }], tabs: ["https://example.com/"] });
  const snapshot = createSyncSnapshot([profile], new Map([[profile.id, session]]), 1794160000000);
  return { root, folder: join(root, "transport"), profile, session, snapshot };
}
const password = "correct-horse-battery-staple";

describe("portable encrypted profile snapshots", () => {
  test("AES-GCM round trip preserves profile identity and saved session without cleartext secrets", async () => {
    const f = fixture(); const bytes = await sealSyncSnapshot(f.snapshot, password);
    for (const secret of ["alice", "account-password", "cookie-secret", "local-storage-secret", password, "Research"]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(await openSyncSnapshot(bytes, password)).toEqual(f.snapshot);
    const again = await sealSyncSnapshot(f.snapshot, password); expect(bytes.equals(again)).toBe(false);
  });
  test("wrong passwords and every authenticated field fail before returning plaintext", async () => {
    const f = fixture(), bytes = await sealSyncSnapshot(f.snapshot, password);
    await expect(openSyncSnapshot(bytes, "wrong-password-1")).rejects.toThrow("password and file integrity");
    for (const offset of [15, 30, 43, bytes.length - 1]) { const changed = Buffer.from(bytes); changed[offset] = changed[offset]! ^ 1; await expect(openSyncSnapshot(changed, password)).rejects.toThrow(); }
    await expect(openSyncSnapshot(bytes.subarray(0, 10), password)).rejects.toThrow("Invalid");
    await expect(openSyncSnapshot(bytes.subarray(0, bytes.length - 1), password)).rejects.toThrow("integrity");
  });
  test("profile, session, and identifier validation rejects unsafe or mismatched data", () => {
    const f = fixture();
    for (const snapshot of [
      { ...f.snapshot, version: 2 },
      { ...f.snapshot, profiles: [{ ...f.profile, id: "../escape" }] },
      { ...f.snapshot, profiles: [{ ...f.profile, firefoxOwner: { token: "private" } }] },
      { ...f.snapshot, profiles: [f.profile, { ...f.profile, id: "PROFILE001" }] },
      { ...f.snapshot, sessions: { unknown: f.session } },
      { ...f.snapshot, sessions: { [f.profile.id]: "{bad" } },
      { ...f.snapshot, sessions: { [f.profile.id]: '{"cookies":[],"origins":[{"origin":"file:///C:/private","localStorage":[]}]}' } },
      { ...f.snapshot, profiles: [{ ...f.profile, proxy: { type: "http", host: "evil/path", port: "80", user: "", pass: "" } }] },
    ]) expect(() => validateSyncSnapshot(snapshot)).toThrow();
  });
  test("legacy cookie-only saved sessions are preserved without silently normalizing away fields", async () => {
    const f = fixture(), legacy = '{"cookies":[],"tabs":["https://example.com/"]}';
    const snapshot = createSyncSnapshot([f.profile], { [f.profile.id]: legacy });
    expect((await openSyncSnapshot(await sealSyncSnapshot(snapshot, password), password)).sessions[f.profile.id]).toBe(legacy);
  });
  test("short passwords and excessive retention fail before creating any transport files", async () => {
    const f = fixture();
    await expect(writeSyncSnapshot(f.folder, f.snapshot, "short")).rejects.toThrow("10 characters");
    await expect(writeSyncSnapshot(f.folder, f.snapshot, password, { retainSnapshots: 0 })).rejects.toThrow("retention");
    expect(existsSync(f.folder)).toBe(false);
    await expect(sealSyncSnapshot(f.snapshot, "x".repeat(1025))).rejects.toThrow("1024");
  });
  test("atomic folder writes expose hashes, survive restart, and never leave a partial file", async () => {
    const f = fixture(); const file = await writeSyncSnapshot(f.folder, f.snapshot, password);
    expect(file.fileName).toMatch(/^maobu-sync-\d{13}-[a-f0-9]{16}\.mqsync$/);
    expect(file.sha256).toBe(createHash("sha256").update(readFileSync(join(f.folder, file.fileName))).digest("hex"));
    expect(listSyncSnapshots(f.folder)[0]).toMatchObject({ fileName: file.fileName, bytes: file.bytes });
    expect(await readSyncSnapshot(f.folder, file.fileName, password)).toEqual(f.snapshot);
    expect(readdirSync(f.folder).some(name => name.endsWith(".partial"))).toBe(false);
  });
  test("retention removes only generated snapshots and preserves unrelated user files", async () => {
    const f = fixture(); mkdirSync(f.folder); writeFileSync(join(f.folder, "personal.txt"), "keep me");
    writeFileSync(join(f.folder, "maobu-sync-1000000000000-aaaaaaaaaaaaaaaa.mqsync"), "invalid short file");
    for (let count = 0; count < 3; count++) await writeSyncSnapshot(f.folder, f.snapshot, password, { retainSnapshots: 2 });
    expect(listSyncSnapshots(f.folder)).toHaveLength(2); expect(readFileSync(join(f.folder, "personal.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(f.folder, "maobu-sync-1000000000000-aaaaaaaaaaaaaaaa.mqsync"), "utf8")).toBe("invalid short file");
  });
  test("concurrent writes retain readable newest snapshots with unique names", async () => {
    const f = fixture(); const results = await Promise.all(Array.from({ length: 4 }, () => writeSyncSnapshot(f.folder, f.snapshot, password, { retainSnapshots: 2 })));
    expect(new Set(results.map(item => item.fileName)).size).toBe(4);
    const retained = listSyncSnapshots(f.folder); expect(retained).toHaveLength(2);
    for (const item of retained) expect(await readSyncSnapshot(f.folder, item.fileName, password)).toEqual(f.snapshot);
    expect(readdirSync(f.folder).some(name => name.endsWith(".partial"))).toBe(false);
  });
  test("retention preserves newer history from a computer with a different clock", async () => {
    const f = fixture(); const old = await writeSyncSnapshot(f.folder, f.snapshot, password);
    const futureName = "maobu-sync-9999999999999-aaaaaaaaaaaaaaaa.mqsync";
    renameSync(join(f.folder, old.fileName), join(f.folder, futureName));
    const current = await writeSyncSnapshot(f.folder, f.snapshot, password, { retainSnapshots: 1 });
    expect(existsSync(join(f.folder, futureName))).toBe(true); expect(existsSync(join(f.folder, current.fileName))).toBe(true);
    expect(await readSyncSnapshot(f.folder, futureName, password)).toEqual(f.snapshot);
  });
  test("memory and structural budgets reject oversized, cyclic, and deeply nested snapshots", () => {
    const f = fixture();
    expect(() => validateSyncSnapshot({ ...f.snapshot, profiles: [{ ...f.profile, password: "x".repeat(64 * 1024 ** 2) }] })).toThrow("64 MiB");
    const cyclic: Record<string, unknown> = { ...f.snapshot }; cyclic.loop = cyclic;
    expect(() => validateSyncSnapshot(cyclic)).toThrow("cyclic");
    let nested: unknown = {}; for (let index = 0; index < 66; index++) nested = { nested };
    expect(() => validateSyncSnapshot({ ...f.snapshot, nested })).toThrow("complex");
  });
  test("reads cannot escape the configured folder and absent folders list without being created", async () => {
    const f = fixture(); expect(listSyncSnapshots(f.folder)).toEqual([]); expect(existsSync(f.folder)).toBe(false);
    await writeSyncSnapshot(f.folder, f.snapshot, password);
    for (const name of ["../secret.mqsync", "C:\\secret.mqsync", "other.txt", "maobu-sync-1000000000000-aaaaaaaaaaaaaaaa.mqsync/../x"]) await expect(readSyncSnapshot(f.folder, name, password)).rejects.toThrow();
    await expect(writeSyncSnapshot("relative", f.snapshot, password)).rejects.toThrow("absolute");
  });
  test("file reads reject oversized files, directories, and incomplete transport writes", async () => {
    const f = fixture(); mkdirSync(f.folder);
    const oversized = "maobu-sync-1000000000000-aaaaaaaaaaaaaaaa.mqsync", directory = "maobu-sync-1000000000001-bbbbbbbbbbbbbbbb.mqsync", partial = "maobu-sync-1000000000002-cccccccccccccccc.mqsync";
    writeFileSync(join(f.folder, oversized), "x"); truncateSync(join(f.folder, oversized), 65 * 1024 ** 2); mkdirSync(join(f.folder, directory)); writeFileSync(join(f.folder, partial), "not complete");
    expect(listSyncSnapshots(f.folder)).toEqual([]);
    for (const name of [oversized, directory, partial]) await expect(readSyncSnapshot(f.folder, name, password)).rejects.toThrow("Invalid");
  });
  test("import preview detects case-insensitive conflicts and exposes no credential or session values", () => {
    const f = fixture(); const before = structuredClone(f.snapshot); const preview = previewSyncSnapshot(f.snapshot, ["PROFILE001"]);
    expect(preview).toMatchObject({ profileCount: 1, sessionCount: 1, newCount: 0, conflictCount: 1 });
    for (const secret of ["alice", "account-password", "cookie-secret", "local-storage-secret"]) expect(JSON.stringify(preview)).not.toContain(secret);
    expect(f.snapshot).toEqual(before); expect(previewSyncSnapshot(f.snapshot, []).newCount).toBe(1);
  });
  test("encrypted sync snapshots allow and preserve profile notes without cleartext exposure", async () => {
    const f = fixture();
    const withNotes = { ...f.profile, notes: "Sensitive operator memo\nKeep isolated" };
    const snapshot = createSyncSnapshot([withNotes], new Map([[withNotes.id, f.session]]), 1794160000000);
    const bytes = await sealSyncSnapshot(snapshot, password);
    expect(bytes.includes(Buffer.from("Sensitive operator memo"))).toBe(false);
    const opened = await openSyncSnapshot(bytes, password);
    expect(opened.profiles[0]?.notes).toBe("Sensitive operator memo\nKeep isolated");
  });
});
