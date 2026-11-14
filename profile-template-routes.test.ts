import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { handleProfileTemplateRequest } from "./profile-template-routes.ts";
import { ProfileTemplateStore, type ProfileTemplateSettings } from "./profile-templates.ts";

const parent = resolve(import.meta.dir, "node_modules/.cache/profile-template-route-tests"), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(parent + sep) || !basename(root).startsWith("routes-")) throw new Error("Unsafe route test cleanup"); rmSync(root, { recursive: true, force: true }); } });
const prefix = "/ui/api/settings/templates";
const settings: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "x.com" };
function fixture() { mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "routes-")); roots.push(root); const path = join(root, "profile-templates.json"), store = new ProfileTemplateStore(path); return { root, path, store }; }
async function call(store: ProfileTemplateStore, method: string, body?: unknown, suffix = "") {
  const response = handleProfileTemplateRequest(prefix + suffix, method, body, store)!;
  expect(response).not.toBeNull(); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return { response, data: await response.json() as any };
}

test("template routes list, save, rename and remove the workspace-local catalog", async () => {
  const f = fixture(); expect((await call(f.store, "GET")).data).toEqual({ ok: true, catalog: { version: 1, revision: 0, templates: [] } });
  const created = await call(f.store, "POST", { revision: 0, name: "Work", settings }); expect(created.response.status).toBe(200); expect(created.data.ok).toBe(true);
  const first = created.data.catalog.templates[0];
  const renamed = await call(f.store, "POST", { revision: 1, id: first.id, name: "Work renamed", settings }); expect(renamed.data.catalog.revision).toBe(2); expect(renamed.data.catalog.templates[0].name).toBe("Work renamed");
  const deleted = await call(f.store, "POST", { revision: 2, id: first.id }, "/delete"); expect(deleted.data.catalog).toEqual({ version: 1, revision: 3, templates: [] });
  expect((await call(f.store, "GET")).data.catalog).toEqual(deleted.data.catalog);
});

test("preview returns only safe differences and never writes a profile or catalog", async () => {
  const f = fixture(), created = f.store.save({ name: "Work", settings }, 0), first = created.templates[0]!, before = readFileSync(f.path);
  const preview = await call(f.store, "POST", { id: first.id, settings: { ...settings, screen: "1440x900" } }, "/preview");
  expect(preview.data).toEqual({ ok: true, preview: { templateId: first.id, freshIdentity: true, changes: [{ field: "screen", before: "1440x900", after: "1920x1080" }] } });
  expect(readFileSync(f.path)).toEqual(before);
});

test("request fields, IDs and revision conflicts are validated before any persistence", async () => {
  const f = fixture(), created = f.store.save({ name: "Work", settings }, 0), id = created.templates[0]!.id, before = readFileSync(f.path);
  const attempts: Array<{ value: unknown; suffix?: string; status: number; code: string }> = [
    { value: null, status: 400, code: "invalid-input" }, { value: [], status: 400, code: "invalid-input" },
    { value: { revision: 1, name: "secret-marker", settings, cookies: [] }, status: 400, code: "invalid-input" },
    { value: { revision: 1, name: "Work 2", settings: { ...settings, password: "secret-marker" } }, status: 400, code: "invalid-input" },
    { value: { revision: 1, name: "Work 2", settings: { ...settings, chromiumRuntime: "cloakbrowser", fingerprintSeed: 42 } }, status: 400, code: "invalid-input" },
    { value: { revision: 1, id: "../secret-marker" }, suffix: "/delete", status: 400, code: "invalid-input" },
    { value: { revision: 0, id }, suffix: "/delete", status: 409, code: "revision-conflict" },
    { value: { revision: 0, id, name: "Work 2", settings }, status: 409, code: "revision-conflict" },
    { value: { revision: "1", name: "Work 2", settings }, status: 400, code: "invalid-input" },
    { value: { id: `tpl_${"f".repeat(32)}`, settings }, suffix: "/preview", status: 404, code: "not-found" },
    { value: { id, settings: { ...settings, proxy: { pass: "secret-marker" } } }, suffix: "/preview", status: 400, code: "invalid-input" },
  ];
  for (const attempt of attempts) {
    const result = await call(f.store, "POST", attempt.value, attempt.suffix); expect(result.response.status).toBe(attempt.status); expect(result.data).toMatchObject({ ok: false, code: attempt.code }); expect(JSON.stringify(result.data)).not.toContain("secret-marker"); expect(readFileSync(f.path)).toEqual(before);
  }
});

test("invalid catalog and unexpected storage failures have fixed messages without raw error content", async () => {
  const f = fixture(); writeFileSync(f.path, '{"password":"secret-marker",BROKEN');
  const damaged = await call(f.store, "GET"); expect(damaged.response.status).toBe(500); expect(damaged.data).toEqual({ ok: false, code: "invalid-catalog", error: "Profile template file is invalid or unsupported." });
  const brokenStore = { read() { throw new Error("C:/private/secret-marker/token"); } } as unknown as ProfileTemplateStore;
  const result = await call(brokenStore, "GET"); expect(result.response.status).toBe(500); expect(result.data).toEqual({ ok: false, code: "storage-error", error: "Profile templates could not be saved. Check the workspace and try again." });
});

test("unknown routes and unsupported methods do not access storage", async () => {
  const forbidden = new Proxy({} as ProfileTemplateStore, { get() { throw new Error("storage must not be read"); } });
  expect(handleProfileTemplateRequest("/ui/api/settings/unrelated", "GET", undefined, forbidden)).toBeNull();
  expect(handleProfileTemplateRequest(prefix + "/unknown", "GET", undefined, forbidden)).toBeNull();
  for (const [method, suffix] of [["DELETE", ""], ["PATCH", ""], ["GET", "/delete"], ["GET", "/preview"]]) {
    const result = await call(forbidden, method!, undefined, suffix); expect(result.response.status).toBe(405); expect(result.data.code).toBe("method-not-allowed");
  }
});
