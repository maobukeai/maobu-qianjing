import { afterEach, expect, test } from "bun:test";
import { copyTemplateSettings, deleteProfileTemplate, fetchProfileTemplates, ProfileTemplateRequestError, saveProfileTemplate, type ProfileTemplateCatalog, type ProfileTemplateSettings } from "./profile-templates-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const settings: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "example.com" };
const id = "tpl_" + "a".repeat(32);
function catalog(revision = 3, name = "Desktop QA"): ProfileTemplateCatalog {
  return { version: 1, revision, templates: [{ id, name, settings: { ...settings }, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" }] };
}
function respond(value: unknown, status = 200) { globalThis.fetch = Object.assign(async () => Response.json(value, { status }), { preconnect: originalFetch.preconnect }); }

test("preset requests keep same-origin guards and serialize only the five allowed draft fields", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const replies = [catalog(), catalog(4, "Renamed"), { ...catalog(5), templates: [] }];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init }); return Response.json({ ok: true, catalog: replies.shift() });
  }, { preconnect: originalFetch.preconnect });
  const draft = { ...settings };
  for (const name of ["password", "proxy", "fingerprintSeed", "name", "group"]) Object.defineProperty(draft, name, { enumerable: true, get() { throw new Error("unrelated form field was read"); } });
  expect(copyTemplateSettings(draft)).toEqual(settings);
  await fetchProfileTemplates(); await saveProfileTemplate({ id, name: "Renamed", settings: draft }, 3); await deleteProfileTemplate(id, 4);
  expect(requests.map(item => item.path)).toEqual(["/ui/api/settings/templates", "/ui/api/settings/templates", "/ui/api/settings/templates/delete"]);
  for (const { init } of requests) {
    expect(init?.credentials).toBe("same-origin"); expect(init?.cache).toBe("no-store"); expect(new Headers(init?.headers).get("X-Maobu-Settings")).toBe("1");
  }
  expect(requests[0]?.init?.method).toBe("GET");
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ revision: 3, id, name: "Renamed", settings });
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ revision: 4, id });
});

test("malformed catalogs cannot reach preset controls or expose unsupported fields", async () => {
  const initial = catalog(), entry = initial.templates[0]!;
  for (const value of [null, { ...initial, revision: -1 }, { ...initial, templates: [null] }, { ...initial, templates: [entry, entry] },
    { ...initial, templates: [{ ...entry, settings: { ...settings, password: "forbidden-field" } }] },
    { ...initial, templates: [{ ...entry, settings: { ...settings, engine: "firefox" } }] },
    { ...initial, templates: [{ ...entry, updatedAt: "invalid" }] }]) {
    respond({ ok: true, catalog: value }); await expect(fetchProfileTemplates()).rejects.toThrow("invalid response");
  }
});

test("mutations reject stale success data and preserve typed revision conflicts", async () => {
  respond({ ok: true, catalog: catalog() }); await expect(saveProfileTemplate({ id, name: "Renamed", settings }, 3)).rejects.toThrow("invalid response");
  respond({ ok: true, catalog: catalog(4) }); await expect(deleteProfileTemplate(id, 3)).rejects.toThrow("invalid response");
  respond({ ok: false, code: "revision-conflict", error: "Profile templates changed. Refresh the list before saving again." }, 409);
  try { await saveProfileTemplate({ name: "New preset", settings }, 3); throw new Error("must reject"); }
  catch (error) { expect(error).toBeInstanceOf(ProfileTemplateRequestError); expect(error).toMatchObject({ code: "revision-conflict", status: 409 }); }
});

test("network failures have fixed messages while caller cancellation remains cancellation", async () => {
  globalThis.fetch = Object.assign(async () => { throw new Error("private fixture transport details"); }, { preconnect: originalFetch.preconnect });
  await expect(fetchProfileTemplates()).rejects.toThrow("Could not reach the profile preset service. Try again.");
  const aborted = new AbortController(); aborted.abort();
  globalThis.fetch = Object.assign(async () => { throw new DOMException("cancelled", "AbortError"); }, { preconnect: originalFetch.preconnect });
  await expect(fetchProfileTemplates(aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
});
