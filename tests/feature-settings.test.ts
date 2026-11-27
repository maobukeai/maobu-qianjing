import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { AppSettingsStore } from "../src/app-settings.ts";
import { buildNewProfile } from "../src/create.ts";
import { handleFeatureSettingsRequest } from "../src/feature-settings.ts";
import { statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import type { Profile } from "../src/types.ts";
import { COMMON_LOCAL_PROXY_PORTS, type LocalProxyDiscoveryOptions } from "../src/network-diagnostics.ts";

const roots: string[] = [], stores: ProfileStore[] = [];
const parent = resolve(import.meta.dir, "..", "node_modules", ".cache", "feature-settings-tests");
const password = "snapshot-passphrase-for-tests";
const session = JSON.stringify({ cookies: [{ name: "auth", value: "private-cookie-value", domain: ".example.com", path: "/" }], origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "private-storage-value" }] }] });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(parent + sep)) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "case-")); roots.push(root);
  const paths = statePaths(root), store = new ProfileStore(paths.database); stores.push(store);
  const preferences = new AppSettingsStore(join(root, "app-settings.json"));
  return { root, paths, store, preferences };
}
type Fixture = ReturnType<typeof fixture>;
function profile(id: string, name = id): Profile { return { ...buildNewProfile({ name, username: "private-user", password: "private-account-password", group: "Research" }, () => false), id }; }
function request(path = "", options: { method?: string; value?: unknown; raw?: string; headers?: Record<string, string>; url?: string; omitHeader?: boolean } = {}) {
  const method = options.method ?? "GET";
  return new Request(options.url ?? `http://127.0.0.1:50400/ui/api/settings${path}`, {
    method,
    headers: { ...(!options.omitHeader ? { "X-Maobu-Settings": "1" } : {}), ...(method !== "GET" ? { "Content-Type": "application/json" } : {}), ...options.headers },
    ...(method !== "GET" ? { body: options.raw ?? JSON.stringify(options.value ?? {}) } : {}),
  });
}
async function call(f: Fixture, path = "", options: Parameters<typeof request>[1] = {}) {
  const response = await handleFeatureSettingsRequest(request(path, options), f.store, { paths: f.paths });
  if (!response) throw new Error("Expected settings response");
  return { response, data: await response.json() as any };
}
function configure(f: Fixture, folder = join(f.root, "transport")) { f.preferences.patch({ sync: { enabled: true, folder } }); return folder; }
async function exported(source: Fixture, profiles = [profile("new001")]) {
  source.store.upsertProfiles(profiles); source.store.saveSessionBundle(profiles[0]!.id, session);
  const folder = configure(source); const created = await call(source, "/sync/create", { method: "POST", value: { password } });
  expect(created.response.status).toBe(200); return { folder, fileName: created.data.file.fileName as string };
}

describe("settings route boundaries", () => {
  test("network discovery checks literal targets before invoking the probe", async () => {
    const calls: LocalProxyDiscoveryOptions[] = [];
    const discoverLocalProxies = async (input: LocalProxyDiscoveryOptions = {}) => {
      calls.push(input);
      return { host: input.host ?? "127.0.0.1", checkedAt: "2026-11-09T00:00:00Z", results: [] };
    };
    const discover = (value: unknown, requestOptions: Parameters<typeof request>[1] = {}) => handleFeatureSettingsRequest(
      request("/network/discover", { method: "POST", value, ...requestOptions }), {} as ProfileStore, { discoverLocalProxies },
    );
    expect((await discover({}))?.status).toBe(200);
    expect((await discover({ host: "::1", ports: [11555, 65535] }))?.status).toBe(200);
    expect(calls).toEqual([{ host: "127.0.0.1", ports: [...COMMON_LOCAL_PROXY_PORTS] }, { host: "::1", ports: [11555, 65535] }]);
    for (const invalid of [
      { host: null }, { ports: null }, { host: "[::1]", ports: [11555] }, { host: "localhost" }, { ports: [] },
      { ports: [11555, 11555] }, { ports: [11555, "11556"] }, { ports: [11555, null] }, { ports: [11555, 65536] },
      { ports: Array.from({ length: 17 }, (_, index) => 11555 + index) }, { ports: [11555], timeoutMs: 80 },
    ]) expect((await discover(invalid))?.status).toBe(400);
    expect((await discover(undefined, { raw: "null" }))?.status).toBe(400);
    expect((await discover({}, { method: "GET" }))?.status).toBe(405);
    expect((await discover({}, { omitHeader: true }))?.status).toBe(403);
    expect((await discover({}, { headers: { origin: "https://outside.invalid" } }))?.status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  test("changing the release channel or repository invalidates an earlier check", async () => {
    const f = fixture();
    const checked = await call(f, "/updates", { method: "POST" });
    expect(checked.data.update.status).toBe("not-configured");
    expect((await call(f, "/updates")).data.update.repository).toBe("");
    await call(f, "", { method: "PATCH", value: { updates: { repository: "maobukeai/maobu-qianjing" } } });
    expect((await call(f, "/updates")).data.update).toBe(null);
    await call(f, "", { method: "PATCH", value: { updates: { repository: "", channel: "beta" } } });
    await call(f, "/updates", { method: "POST" });
    expect((await call(f, "/updates")).data.update.channel).toBe("beta");
    await call(f, "", { method: "PATCH", value: { updates: { channel: "stable" } } });
    expect((await call(f, "/updates")).data.update).toBe(null);
  });
  test("unrelated paths fall through and local headers are required before touching the store", async () => {
    expect(await handleFeatureSettingsRequest(new Request("http://127.0.0.1/other"), {} as ProfileStore)).toBe(null);
    for (const req of [request("", { omitHeader: true }), request("", { headers: { "X-Maobu-Settings": "wrong" } }), request("", { url: "http://evil.example/ui/api/settings" }), request("", { headers: { origin: "https://evil.example" } }), request("", { headers: { origin: "null" } }), request("", { headers: { "Sec-Fetch-Site": "cross-site" } })]) {
      const response = await handleFeatureSettingsRequest(req, {} as ProfileStore);
      expect(response?.status).toBe(403);
    }
  });
  test("same-origin requests work, reject unsupported methods and require JSON mutations", async () => {
    const f = fixture(); expect((await call(f, "", { headers: { origin: "http://127.0.0.1:50400" } })).response.status).toBe(200);
    expect((await call(f, "", { method: "DELETE" })).response.status).toBe(405);
    expect((await call(f, "", { method: "PATCH", headers: { "Content-Type": "text/plain" } })).response.status).toBe(415);
    for (const raw of ["[]", "null", "true", "1", '{"password":"private-malformed-secret",BROKEN']) {
      const result = await call(f, "", { method: "PATCH", raw }); expect(result.response.status).toBe(400); expect(JSON.stringify(result.data)).not.toContain("private-malformed-secret");
    }
    expect((await call(f)).response.headers.get("cache-control")).toBe("no-store");
  });
  test("body limits stop oversized streams before buffering the entire request", async () => {
    const f = fixture(); let chunks = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (chunks++ < 10) controller.enqueue(new Uint8Array(64 * 1024)); else controller.close(); }, cancel() { cancelled = true; } });
    const req = new Request("http://127.0.0.1:50400/ui/api/settings", { method: "PATCH", headers: { "X-Maobu-Settings": "1", "Content-Type": "application/json" }, body: stream });
    const response = await handleFeatureSettingsRequest(req, f.store, { paths: f.paths });
    expect(response?.status).toBe(400); expect(cancelled).toBe(true); expect(chunks).toBeLessThan(10);
    expect((await call(f, "", { method: "PATCH", headers: { "Content-Length": "99999999" } })).response.status).toBe(400);
  });
  test("preferences persist independently while unknown settings and secrets are rejected", async () => {
    const f = fixture(); expect((await call(f)).data.settings.updates.repository).toBe("");
    expect((await call(f, "", { method: "PATCH", value: { updates: { repository: "maobu/browser", channel: "beta" } } })).response.status).toBe(200);
    expect(new AppSettingsStore(f.preferences.path).read().updates).toMatchObject({ repository: "maobu/browser", channel: "beta" });
    const before = readFileSync(f.preferences.path, "utf8");
    const invalid = await call(f, "", { method: "PATCH", value: { updates: { token: "private-api-token" } } });
    expect(invalid.response.status).toBe(400); expect(JSON.stringify(invalid.data)).not.toContain("private-api-token"); expect(readFileSync(f.preferences.path, "utf8")).toBe(before);
    expect((await handleFeatureSettingsRequest(request(), f.store))?.status).toBe(503);
  });
  test("unconfigured updates return an offline result and source changes do not use retired services", async () => {
    const f = fixture(); const checked = await call(f, "/updates", { method: "POST" });
    expect(checked.data.update.status).toBe("not-configured"); expect((await call(f, "/updates")).data.update.status).toBe("not-configured");
    expect((await call(f, "/unknown")).response.status).toBe(404);
  });
  test("offline diagnostic lists do not disclose credentials or portable sessions", async () => {
    const f = fixture(); f.store.upsertProfile(profile("inspect001")); f.store.saveSessionBundle("inspect001", session);
    const fingerprints = await call(f, "/fingerprints"); expect(fingerprints.response.status).toBe(200); expect(fingerprints.data.reports).toHaveLength(1);
    const integration = await call(f, "/integrations"); expect(integration.response.status).toBe(200); expect(integration.data.integration.transport).toBe("stdio");
    for (const data of [fingerprints.data, integration.data]) for (const secret of ["private-user", "private-account-password", "private-cookie-value", "private-storage-value"]) expect(JSON.stringify(data)).not.toContain(secret);
  });
});

describe("manual encrypted sync API", () => {
  test("a folder must be explicitly enabled and failed creation never writes a file", async () => {
    const f = fixture(); expect((await call(f, "/sync/files")).response.status).toBe(409);
    const folder = configure(f); const failed = await call(f, "/sync/create", { method: "POST", value: { password: "short" } });
    expect(failed.response.status).toBe(400); expect(existsSync(folder)).toBe(false);
    const good = await call(f, "/sync/create", { method: "POST", value: { password } }); expect(good.response.status).toBe(200);
  });
  test("create, list, and decrypted preview reveal only summaries and never retain the password", async () => {
    const f = fixture(); const { folder, fileName } = await exported(f);
    const listed = await call(f, "/sync/files"); expect(listed.data.files).toHaveLength(1); expect(listed.data.files[0].fileName).toBe(fileName);
    const preview = await call(f, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.response.status).toBe(200); expect(preview.data.preview).toMatchObject({ profileCount: 1, sessionCount: 1, newCount: 0, conflictCount: 1 });
    expect(preview.data.previewHash).toMatch(/^[a-f0-9]{64}$/);
    for (const text of [JSON.stringify(preview.data), JSON.stringify(listed.data), readFileSync(f.preferences.path, "utf8"), readFileSync(join(folder, fileName)).toString("utf8")]) {
      for (const secret of [password, "private-user", "private-account-password", "private-cookie-value", "private-storage-value"]) expect(text).not.toContain(secret);
    }
    expect(readdirSync(folder).some(name => name.endsWith(".partial"))).toBe(false);
  });
  test("imports skip existing, case-conflicting, trashed and durable running IDs and preserve saved sessions", async () => {
    const source = fixture(), target = fixture();
    const profiles = [profile("new001"), profile("exists001", "incoming name"), profile("trash001"), profile("running001"), profile("UPPER001")];
    const { folder, fileName } = await exported(source, profiles); configure(target, folder);
    target.store.upsertProfiles([profile("exists001", "keep existing"), profile("trash001", "keep trash"), profile("upper001", "keep case")]); target.store.trashProfile("trash001");
    target.store.recordLaunch({ profileId: "running001", pid: 123, debugPort: 1, ws: "ws://local", startedAt: 1 });
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.data.preview).toMatchObject({ newCount: 1, conflictCount: 4 });
    const imported = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: preview.data.previewHash } });
    expect(imported.response.status).toBe(200); expect(imported.data).toMatchObject({ imported: 1, skipped: 4 });
    expect(target.store.getProfile("exists001")?.name).toBe("keep existing"); expect(target.store.isTrashed("trash001")).toBe(true); expect(target.store.getProfile("running001")).toBe(null); expect(target.store.getProfile("UPPER001")).toBe(null);
    expect(target.store.getProfile("new001")?.fingerprintSeed).toBe(source.store.getProfile("new001")!.fingerprintSeed); expect(target.store.getPendingSessionBundle("new001")).toBe(session);
    expect(target.store.getLaunch("running001")?.pid).toBe(123);
  });
  test("wrong passwords, a missing preview, or changed hashes leave destination data untouched", async () => {
    const source = fixture(), target = fixture(); const { folder, fileName } = await exported(source); configure(target, folder);
    for (const value of [{ fileName, password: "incorrect-password", previewHash: "a".repeat(64) }, { fileName, password, previewHash: "a".repeat(64) }, { fileName, password }]) {
      const result = await call(target, "/sync/import", { method: "POST", value }); expect([400, 409]).toContain(result.response.status); expect(target.store.count()).toBe(0);
      expect(JSON.stringify(result.data)).not.toContain("incorrect-password"); expect(JSON.stringify(result.data)).not.toContain(password);
    }
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    const result = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: preview.data.previewHash } }); expect(result.response.status).toBe(200); expect(target.store.count()).toBe(1);
  });
  test("the preview binds an exact filename and target workspace even for identical encrypted bytes", async () => {
    const source = fixture(), target = fixture(), otherWorkspace = fixture();
    const { folder, fileName } = await exported(source);
    configure(target, folder); configure(otherWorkspace, folder);
    const copy = "maobu-sync-1700000000000-0000000000000000.mqsync";
    copyFileSync(join(folder, fileName), join(folder, copy));
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.response.status).toBe(200);
    const previewHash = preview.data.previewHash;

    for (const [destination, chosenName] of [[target, copy], [otherWorkspace, fileName]] as const) {
      const rejected = await call(destination, "/sync/import", { method: "POST", value: { fileName: chosenName, password, previewHash } });
      expect(rejected.response.status).toBe(409);
      expect(rejected.data).toEqual({ ok: false, error: "Preview this snapshot again before importing" });
      expect(destination.store.count()).toBe(0);
    }

    const copiedPreview = await call(target, "/sync/preview", { method: "POST", value: { fileName: copy, password } });
    expect(copiedPreview.data.preview).toEqual(preview.data.preview);
    expect(copiedPreview.data.previewHash).not.toBe(previewHash);
    const receipt = await call(target, "/sync/import", { method: "POST", value: { fileName: copy, password, previewHash: copiedPreview.data.previewHash } });
    expect(receipt.response.status).toBe(200);
    expect(receipt.data).toEqual({ ok: true, imported: 1, skipped: 0 });
    expect(target.store.getPendingSessionBundle("new001")).toBe(session);
  });
  test("swapping blocked IDs with unchanged counts requires review and writes no partial batch", async () => {
    const source = fixture(), target = fixture();
    const { folder, fileName } = await exported(source, [profile("released001"), profile("blocked001"), profile("alwaysnew001")]);
    configure(target, folder);
    target.store.upsertProfile(profile("RELEASED001", "Original case-insensitive conflict"));
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.data.preview).toMatchObject({ newCount: 2, conflictCount: 1 });
    expect(preview.data.preview.profiles.find((row: { id: string }) => row.id === "released001")?.conflict).toBe(true);

    target.store.deleteProfile("RELEASED001");
    target.store.upsertProfile(profile("BLOCKED001", "New case-insensitive conflict"));
    const rejected = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: preview.data.previewHash } });
    expect(rejected.response.status).toBe(409);
    expect(rejected.data.error).toBe("Preview this snapshot again before importing");
    expect(target.store.listProfiles().map(row => row.id)).toEqual(["BLOCKED001"]);
    expect(target.store.getPendingSessionBundle("released001")).toBeNull();

    const renewed = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(renewed.data.preview).toMatchObject({ newCount: 2, conflictCount: 1 });
    expect(renewed.data.previewHash).not.toBe(preview.data.previewHash);
    const imported = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: renewed.data.previewHash } });
    expect(imported.response.status).toBe(200);
    expect(imported.data).toEqual({ ok: true, imported: 2, skipped: 1 });
    expect(target.store.getProfile("BLOCKED001")?.name).toBe("New case-insensitive conflict");
    expect(target.store.getPendingSessionBundle("released001")).toBe(session);
  });
  test.each(["Trash", "launch"] as const)("a removed %s conflict invalidates the preview before any insert", async sourceOfConflict => {
    const source = fixture(), target = fixture();
    const { folder, fileName } = await exported(source, [profile("held001"), profile("available001")]);
    configure(target, folder);
    if (sourceOfConflict === "Trash") {
      target.store.upsertProfile(profile("held001"));
      target.store.trashProfile("held001");
    } else {
      target.store.recordLaunch({ profileId: "held001", pid: 123, debugPort: 1, ws: "ws://local", startedAt: 1 });
    }
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.data.preview).toMatchObject({ newCount: 1, conflictCount: 1 });
    if (sourceOfConflict === "Trash") target.store.deleteProfile("held001");
    else target.store.clearLaunch("held001");
    const rejected = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: preview.data.previewHash } });
    expect(rejected.response.status).toBe(409);
    expect(rejected.data.error).toBe("Preview this snapshot again before importing");
    expect(target.store.count()).toBe(0);
  });
  test("unrelated workspace changes and equivalent conflict statuses keep the import review valid", async () => {
    const source = fixture(), target = fixture();
    const { folder, fileName } = await exported(source, [profile("incoming001"), profile("held001")]);
    configure(target, folder);
    target.store.upsertProfile(profile("held001", "Preserved target"));
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    expect(preview.data.preview).toMatchObject({ newCount: 1, conflictCount: 1 });

    target.store.upsertProfile(profile("unrelated001", "User's workspace edit"));
    target.store.recordLaunch({ profileId: "unrelated002", pid: 123, debugPort: 1, ws: "ws://local", startedAt: 1 });
    target.store.trashProfile("held001");
    const imported = await call(target, "/sync/import", { method: "POST", value: { fileName, password, previewHash: preview.data.previewHash } });
    expect(imported.response.status).toBe(200);
    expect(imported.data).toEqual({ ok: true, imported: 1, skipped: 1 });
    expect(target.store.isTrashed("held001")).toBe(true);
    expect(target.store.getProfile("unrelated001")?.name).toBe("User's workspace edit");
    expect(target.store.getPendingSessionBundle("incoming001")).toBe(session);
  });
  test("a SQLite writer prevents a partial restore and the same review can retry after it releases", async () => {
    const source = fixture(), target = fixture();
    const { folder, fileName } = await exported(source);
    configure(target, folder);
    target.store.upsertProfile(profile("unrelated001", "Before concurrent edit"));
    const preview = await call(target, "/sync/preview", { method: "POST", value: { fileName, password } });
    const value = { fileName, password, previewHash: preview.data.previewHash };

    const writer = new Database(target.paths.database);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.query("UPDATE profiles SET name = ? WHERE id = ?").run("After concurrent edit", "unrelated001");
      const busy = await call(target, "/sync/import", { method: "POST", value });
      expect(busy.response.status).toBe(409);
      expect(busy.data).toEqual({ ok: false, error: "Workspace data is busy. Try importing again in a moment." });
      expect(target.store.getProfile("new001")).toBeNull();
      writer.exec("COMMIT");
    } finally { writer.close(); }

    const retried = await call(target, "/sync/import", { method: "POST", value });
    expect(retried.response.status).toBe(200);
    expect(retried.data).toEqual({ ok: true, imported: 1, skipped: 0 });
    expect(target.store.getProfile("unrelated001")?.name).toBe("After concurrent edit");
    expect(target.store.getPendingSessionBundle("new001")).toBe(session);
  });
  test("mutations validate argument schemas and do not echo unknown values", async () => {
    const f = fixture(); const { fileName } = await exported(f);
    for (const [path, value] of [
      ["/sync/create", { password, token: "private-extra-secret" }],
      ["/sync/preview", { password, fileName, token: "private-extra-secret" }],
      ["/sync/import", { password, fileName, previewHash: "a".repeat(64), token: "private-extra-secret" }],
      ["/sync/preview", { password, fileName: "../private-extra-secret" }],
      ["/sync/create", { password: 12345678901234 }],
    ] as const) {
      const result = await call(f, path, { method: "POST", value }); expect(result.response.status).toBe(400); expect(JSON.stringify(result.data)).not.toContain("private-extra-secret");
    }
  });
  test("overlapping snapshot operations return a conflict and release the lock on completion", async () => {
    const f = fixture(); configure(f); f.store.upsertProfile(profile("new001"));
    const first = call(f, "/sync/create", { method: "POST", value: { password } });
    const second = await call(f, "/sync/create", { method: "POST", value: { password } });
    expect(second.response.status).toBe(409); expect((await first).response.status).toBe(200);
    expect((await call(f, "/sync/create", { method: "POST", value: { password } })).response.status).toBe(200);
  });
});
