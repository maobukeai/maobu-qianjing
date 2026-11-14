import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { buildNewProfile } from "./create.ts";
import type { Launcher } from "./launcher.ts";
import { statePaths } from "./paths.ts";
import { PROFILE_TEMPLATES_FILE, ProfileTemplateStore, type ProfileTemplateSettings } from "./profile-templates.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

const parent = resolve(import.meta.dir, "node_modules/.cache/profile-template-integration-tests"), roots: string[] = [], stores: ProfileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(parent + sep) || !basename(root).startsWith("integration-")) throw new Error("Unsafe template integration fixture cleanup"); rmSync(root, { recursive: true, force: true }); }
});
const prefix = "/ui/api/settings/templates", origin = "http://127.0.0.1:50400";
const settings: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1440x900", platform: "x.com" };
const forbiddenLauncher = new Proxy({} as Launcher, { get() { throw new Error("Templates must not access a browser launcher"); } });
function fixture() {
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "integration-")); roots.push(root);
  const paths = statePaths(join(root, "workspace")), store = new ProfileStore(":memory:"); stores.push(store);
  return { root, paths, store, path: join(paths.root, PROFILE_TEMPLATES_FILE) };
}
type Fixture = ReturnType<typeof fixture>;
interface Options { method?: string; value?: unknown; raw?: string; headers?: Record<string, string>; omitHeader?: boolean; url?: string }
function request(suffix = "", options: Options = {}): Request {
  const method = options.method ?? "GET";
  return new Request(options.url ?? origin + prefix + suffix, { method,
    headers: { ...(!options.omitHeader ? { "X-Maobu-Settings": "1" } : {}), ...(method === "GET" ? {} : { "Content-Type": "application/json" }), ...options.headers },
    ...(method === "GET" ? {} : { body: options.raw ?? JSON.stringify(options.value ?? {}) }),
  });
}
async function response(req: Request, f: Fixture, paths = f.paths) {
  const result = await handleUiRequest(req, forbiddenLauncher, f.store, { paths });
  if (!result) throw new Error("Template request fell through");
  expect(result.headers.get("cache-control")).toBe("no-store"); expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  return { response: result, data: await result.json() as any };
}
async function call(f: Fixture, suffix = "", options: Options = {}) { return response(request(suffix, options), f); }

test("constructing and listing empty templates is read-only even when the workspace directory is absent", async () => {
  const f = fixture(), templates = new ProfileTemplateStore(f.path);
  expect(existsSync(f.paths.root)).toBe(false); expect(templates.read()).toEqual({ version: 1, revision: 0, templates: [] });
  const result = await call(f, "", { headers: { Origin: origin } });
  expect(result.response.status).toBe(200); expect(result.data).toEqual({ ok: true, catalog: { version: 1, revision: 0, templates: [] } });
  expect(existsSync(f.paths.root)).toBe(false); expect(readdirSync(f.root)).toEqual([]); expect(f.store.count()).toBe(0);
});

test("real UI routing rejects untrusted origins and missing settings headers before file or profile access", async () => {
  const f = fixture();
  const forbiddenStore = new Proxy({} as ProfileStore, { get() { throw new Error("Templates must not inspect profiles"); } });
  const attempts: Options[] = [
    { omitHeader: true }, { headers: { "X-Maobu-Settings": "0" } }, { headers: { Origin: "https://outside.invalid" } },
    { headers: { Origin: "null" } }, { headers: { Origin: "http://127.0.0.1:50401" } }, { headers: { "Sec-Fetch-Site": "cross-site" } },
    { url: "http://outside.invalid" + prefix },
  ];
  for (const suffix of ["", "/delete", "/preview"]) for (const options of attempts) {
    const result = await handleUiRequest(request(suffix, { method: "POST", value: { revision: 0, name: "private-request-secret", settings }, ...options }), forbiddenLauncher, forbiddenStore, { paths: f.paths });
    expect(result?.status).toBe(403); expect(await result!.text()).not.toContain("private-request-secret");
  }
  expect(existsSync(f.paths.root)).toBe(false); expect(readdirSync(f.root)).toEqual([]);
});

test("UI template route requires JSON, rejects unsupported methods and hides malformed request fragments", async () => {
  const f = fixture();
  expect((await call(f, "", { method: "POST", headers: { "Content-Type": "text/plain" } })).response.status).toBe(415);
  expect((await call(f, "", { method: "DELETE" })).response.status).toBe(405);
  expect((await call(f, "", { method: "PATCH" })).response.status).toBe(405);
  expect((await call(f, "/delete")).response.status).toBe(405);
  for (const raw of ["null", "[]", "true", '{"password":"private-request-secret",BROKEN']) {
    const result = await call(f, "", { method: "POST", raw }); expect(result.response.status).toBe(400); expect(JSON.stringify(result.data)).not.toContain("private-request-secret");
  }
  expect(existsSync(f.path)).toBe(false); expect(f.store.count()).toBe(0);
});

test("oversized declared and streamed template requests stop before creating a settings file", async () => {
  const f = fixture();
  const declared = await call(f, "", { method: "POST", headers: { "Content-Length": "999999999" }, value: { revision: 0, name: "A", settings } });
  expect(declared.response.status).toBe(400); expect(declared.data.error).toBe("Settings request is too large");
  let chunks = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (chunks++ < 10) controller.enqueue(new Uint8Array(64 * 1024)); else controller.close(); }, cancel() { cancelled = true; } });
  const req = new Request(origin + prefix, { method: "POST", headers: { "X-Maobu-Settings": "1", "Content-Type": "application/json" }, body: stream });
  const streamed = await response(req, f);
  expect(streamed.response.status).toBe(400); expect(streamed.data.error).toBe("Settings request is too large"); expect(cancelled).toBe(true); expect(chunks).toBeLessThan(10);
  expect(existsSync(f.paths.root)).toBe(false);
});

test("actual UI chain persists CRUD and safe preview without reading or changing profiles", async () => {
  const f = fixture(), profile = buildNewProfile({ name: "private-profile-name", username: "private-user", password: "private-password", group: "private-group" }, () => false);
  f.store.upsertProfile(profile); const bundle = JSON.stringify({ cookies: [{ name: "auth", value: "private-cookie", domain: ".x.com", path: "/" }], origins: [] }); f.store.saveSessionBundle(profile.id, bundle);
  const original = f.store.getProfile(profile.id);
  const created = await call(f, "", { method: "POST", value: { revision: 0, name: "Reusable desktop", settings } });
  expect(created.response.status).toBe(200); const entry = created.data.catalog.templates[0];
  expect(created.data.catalog.revision).toBe(1); expect(existsSync(f.path)).toBe(true);
  const preview = await call(f, "/preview", { method: "POST", value: { id: entry.id, settings: { ...settings, screen: "1920x1080" } } });
  expect(preview.data.preview).toEqual({ templateId: entry.id, freshIdentity: true, changes: [{ field: "screen", before: "1920x1080", after: "1440x900" }] });
  const renamed = await call(f, "", { method: "POST", value: { revision: 1, id: entry.id, name: "New label", settings } }); expect(renamed.data.catalog.revision).toBe(2);
  expect((await call(f)).data.catalog).toEqual(new ProfileTemplateStore(f.path).read());
  for (const secret of [profile.id, "private-profile-name", "private-user", "private-password", "private-group", "private-cookie"]) for (const text of [JSON.stringify(created.data), JSON.stringify(preview.data), readFileSync(f.path, "utf8")]) expect(text).not.toContain(secret);
  const deleted = await call(f, "/delete", { method: "POST", value: { revision: 2, id: entry.id } }); expect(deleted.data.catalog).toEqual({ version: 1, revision: 3, templates: [] });
  expect(f.store.getProfile(profile.id)).toEqual(original); expect(f.store.getSessionBundle(profile.id)).toBe(bundle); expect(f.store.count()).toBe(1);
});

test("catalogs and template IDs are isolated by the server's active workspace path", async () => {
  const first = fixture(), second = fixture();
  const a = await call(first, "", { method: "POST", value: { revision: 0, name: "Same visible name", settings } });
  expect((await call(second)).data.catalog.templates).toEqual([]); expect(existsSync(second.path)).toBe(false);
  const b = await call(second, "", { method: "POST", value: { revision: 0, name: "Same visible name", settings: { ...settings, platform: "reddit.com" } } });
  const firstBefore = readFileSync(first.path), secondBefore = readFileSync(second.path);
  expect(a.data.catalog.templates[0].id).not.toBe(b.data.catalog.templates[0].id);
  for (const suffix of ["/delete", "/preview"]) {
    const result = await call(second, suffix, { method: "POST", value: suffix === "/delete" ? { revision: 1, id: a.data.catalog.templates[0].id } : { id: a.data.catalog.templates[0].id, settings } });
    expect(result.response.status).toBe(404); expect(result.data.code).toBe("not-found");
  }
  const override = await call(first, "", { method: "POST", value: { revision: 1, name: "Override", settings, workspaceRoot: second.paths.root } }); expect(override.response.status).toBe(400);
  expect(readFileSync(first.path)).toEqual(firstBefore); expect(readFileSync(second.path)).toEqual(secondBefore);
});

test("stale revisions and illegal secret or identity fields cannot change the catalog through UI routes", async () => {
  const f = fixture(), created = await call(f, "", { method: "POST", value: { revision: 0, name: "A", settings } }), id = created.data.catalog.templates[0].id;
  const before = readFileSync(f.path);
  const stale = await call(f, "", { method: "POST", value: { revision: 0, id, name: "Changed", settings } }); expect(stale.response.status).toBe(409); expect(stale.data.code).toBe("revision-conflict");
  for (const field of ["proxy", "password", "cookies", "sessionBundle", "fingerprintSeed", "ua", "id", "firefox"]) {
    const result = await call(f, "", { method: "POST", value: { revision: 1, id, name: "Changed", settings: { ...settings, [field]: "private-request-secret" } } });
    expect(result.response.status).toBe(400); expect(result.data.code).toBe("invalid-input"); expect(JSON.stringify(result.data)).not.toContain("private-request-secret");
  }
  const traversal = await call(f, "/delete", { method: "POST", value: { revision: 1, id: "../../private-request-secret" } }); expect(traversal.response.status).toBe(400);
  expect(readFileSync(f.path)).toEqual(before); expect(f.store.count()).toBe(0);
});

test("damaged optional catalog is readable as an error and never reveals its contents or path", async () => {
  const f = fixture(); mkdirSync(f.paths.root); writeFileSync(f.path, '{"password":"private-request-secret",BROKEN');
  const before = readFileSync(f.path), result = await call(f);
  expect(result.response.status).toBe(500); expect(result.data).toEqual({ ok: false, code: "invalid-catalog", error: "Profile template file is invalid or unsupported." });
  expect(JSON.stringify(result.data)).not.toContain(f.paths.root); expect(JSON.stringify(result.data)).not.toContain("private-request-secret"); expect(readFileSync(f.path)).toEqual(before);
});

test("templates require an explicit server state root and unknown operations remain read-only", async () => {
  const f = fixture(), absent = await handleUiRequest(request(), forbiddenLauncher, f.store);
  expect(absent?.status).toBe(503); expect((await absent!.json()).error).toBe("A local state directory is required");
  expect((await call(f, "/unknown")).response.status).toBe(404); expect(existsSync(f.paths.root)).toBe(false);
});
