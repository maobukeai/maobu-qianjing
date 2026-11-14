import { afterEach, expect, test } from "bun:test";
import { fetchReusableProfile, ProfileReuseRequestError, type ReusableProfileSettings } from "./profile-reuse-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const source: ReusableProfileSettings = { sourceId: "source-qa", name: "Source QA", group: "QA", engine: "chromium", chromiumRuntime: "cloakbrowser", platformOs: "windows", screen: "1920x1080", platform: "example.com" };
function respond(value: unknown, status = 200) { globalThis.fetch = Object.assign(async () => Response.json(value, { status }), { preconnect: originalFetch.preconnect }); }

test("reuse settings are an explicit same-origin read with cancellation and no creation request", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const controller = new AbortController();
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init }); return Response.json({ ok: true, profile: source });
  }, { preconnect: originalFetch.preconnect });
  expect(await fetchReusableProfile(source.sourceId, controller.signal)).toEqual(source);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.path).toBe("/ui/api/profiles/source-qa/reuse");
  expect(requests[0]!.init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal });
  expect(requests[0]!.init?.body).toBeUndefined();
  expect(new Headers(requests[0]!.init?.headers).get("accept")).toBe("application/json");
});

test("reuse settings preserve explicit Chromium runtimes and omit it for Firefox", async () => {
  for (const chromiumRuntime of ["aliasmode", "cloakbrowser"] as const) {
    respond({ ok: true, profile: { ...source, chromiumRuntime } });
    expect((await fetchReusableProfile(source.sourceId)).chromiumRuntime).toBe(chromiumRuntime);
  }
  const { chromiumRuntime: _, ...firefox } = { ...source, engine: "firefox", platformOs: "macos" } as const;
  respond({ ok: true, profile: firefox });
  expect(await fetchReusableProfile(source.sourceId)).toEqual(firefox);
});

test("a wrong source or a response containing identity or credentials cannot enter a creation draft", async () => {
  for (const profile of [null, { ...source, sourceId: "another-source" }, { ...source, password: "PRIVATE_PASSWORD" }, { ...source, proxy: { pass: "PRIVATE_PROXY_PASSWORD" } },
    { ...source, fingerprintSeed: 123 }, { ...source, cookies: [] }, { ...source, extensions: [] }, { ...source, ua: "PRIVATE_UA" }, { ...source, engine: "unsupported" },
    { ...source, engine: "firefox" }, { ...source, chromiumRuntime: undefined }, { ...source, platformOs: "android" }, { ...source, screen: "0x0" },
    { ...source, screen: "1920*1080" }, { ...source, screen: "99999x1080" }, { ...source, platform: "https://private:secret@example.com/" }, { ...source, name: "x".repeat(4097) }]) {
    respond({ ok: true, profile });
    await expect(fetchReusableProfile(source.sourceId)).rejects.toThrow("invalid response");
  }
  respond({ ok: true, profile: source, debug: "PRIVATE_DEBUG" });
  await expect(fetchReusableProfile(source.sourceId)).rejects.toThrow("invalid response");
});

test("unsafe IDs and already cancelled reads never reach the service", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; throw new Error("must not run"); }, { preconnect: originalFetch.preconnect });
  for (const id of ["", "../source", "bad/id", "CON", "_invalid", "a".repeat(129)]) await expect(fetchReusableProfile(id)).rejects.toMatchObject({ code: "invalid-id", status: 400 });
  const controller = new AbortController(); controller.abort();
  await expect(fetchReusableProfile(source.sourceId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
});

test("service failures use fixed messages while preserving actionable missing and unsupported sources", async () => {
  for (const [status, code] of [[404, "not-found"], [409, "mobile-profile"], [409, "invalid-settings"]] as const) {
    respond({ ok: false, code, error: "PRIVATE_SERVER_DETAILS" }, status);
    try { await fetchReusableProfile(source.sourceId); throw new Error("must reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(ProfileReuseRequestError);
      expect(error).toMatchObject({ code, status });
      expect((error as Error).message).not.toContain("PRIVATE_");
    }
  }
  respond({ ok: false, error: "PRIVATE_SERVER_DETAILS" }, 500);
  await expect(fetchReusableProfile(source.sourceId)).rejects.toThrow("The source configuration could not be loaded.");
  globalThis.fetch = Object.assign(async () => { throw new Error("PRIVATE_TRANSPORT_DETAILS"); }, { preconnect: originalFetch.preconnect });
  await expect(fetchReusableProfile(source.sourceId)).rejects.toThrow("Could not reach the profile configuration service. Try again.");
  globalThis.fetch = Object.assign(async () => new Response("<html>PRIVATE_DETAILS</html>"), { preconnect: originalFetch.preconnect });
  await expect(fetchReusableProfile(source.sourceId)).rejects.toThrow("invalid response");
});
