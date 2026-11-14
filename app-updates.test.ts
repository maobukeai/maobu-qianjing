import { describe, expect, test } from "bun:test";
import { AppUpdateService, compareAppVersions } from "./app-updates.ts";
const settings = { repository: "maobu/browser", channel: "stable" as const, checkOnStartup: false };
function released(tag: string, extra: Record<string, unknown> = {}) { return { tag_name: tag, name: `Release ${tag}`, draft: false, prerelease: false, body: "Changes", published_at: "2026-11-08T12:00:00Z", assets: [], ...extra }; }
function service(payload: unknown, options: Record<string, unknown> = {}) { return new AppUpdateService({ fetch: (async () => Response.json(payload)) as unknown as typeof fetch, currentVersion: "1.0.0", ...options }); }

describe("GitHub release update checks", () => {
  test("SemVer precedence includes prerelease order and ignores build metadata", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"];
    for (let index = 0; index < order.length - 1; index++) { expect(compareAppVersions(order[index]!, order[index + 1]!)).toBe(-1); expect(compareAppVersions(order[index + 1]!, order[index]!)).toBe(1); }
    expect(compareAppVersions("v1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(compareAppVersions("1.0.0-beta.99999999999999999999", "1.0.0-beta.9999999999999999999")).toBe(1);
    expect(compareAppVersions("0.1.0", "0.1.0-local.1")).toBe(1);
    for (const invalid of ["1.2", "01.0.0", "1.0.0-beta.01", "1.0.0-", "1.0.0+", "1.0.0.0", "wat"]) expect(() => compareAppVersions(invalid, "1.0.0")).toThrow();
  });
  test("unconfigured source is an offline result", async () => {
    let calls = 0; const updater = service([], { fetch: async () => { calls++; throw new Error("unexpected network"); } });
    expect((await updater.check({ ...settings, repository: "" })).status).toBe("not-configured"); expect(calls).toBe(0);
  });
  test("stable channel selects the highest stable semantic release and never downgrades", async () => {
    const updater = service([released("v1.1.0"), released("v3.0.0", { draft: true }), released("v2.0.0-beta.1", { prerelease: true }), released("v2.1.0-alpha.1"), released("nightly"), released("v1.2.0")]);
    const result = await updater.check(settings); expect(result.status).toBe("available"); expect(result.latest?.version).toBe("1.2.0");
    expect((await service([released("0.9.0")]).check(settings)).status).toBe("up-to-date");
    expect((await service([released("1.0.0+other")]).check(settings)).status).toBe("up-to-date");
  });
  test("beta channel includes stable and prerelease versions with real precedence", async () => {
    const updater = service([released("v1.0.0"), released("v2.0.0-beta.1", { prerelease: true })]);
    expect((await updater.check({ ...settings, channel: "beta" })).latest?.version).toBe("2.0.0-beta.1");
    expect((await service([released("v2.0.0-beta.1"), released("v2.0.0")]).check({ ...settings, channel: "beta" })).latest?.version).toBe("2.0.0");
  });
  test("only GitHub API is contacted and response URLs cannot redirect downloads elsewhere", async () => {
    const digest = "a".repeat(64); let call: { url: string; options: RequestInit } | null = null;
    const updater = service([], { fetch: async (url: string, options: RequestInit) => { call = { url, options }; return Response.json([released("v1.1.0", { html_url: "https://evil.example", assets: [
      { name: "maobu.exe", size: 2048, state: "uploaded", browser_download_url: "https://github.com/maobu/browser/releases/download/v1.1.0/maobu.exe", digest: `sha256:${digest}` },
      { name: "malicious.exe", size: 2048, state: "uploaded", browser_download_url: "https://evil.example/malicious.exe" },
      { name: "../escape.exe", size: 0, state: "uploaded", browser_download_url: "https://github.com/maobu/browser/releases/download/v1.1.0/escape.exe" },
    ] })]); } });
    const result = await updater.check(settings);
    expect(call!.url).toBe("https://api.github.com/repos/maobu/browser/releases?per_page=100"); expect(call!.options.redirect).toBe("error");
    expect(result.latest?.url).toBe("https://github.com/maobu/browser/releases/tag/v1.1.0"); expect(result.latest?.assets).toHaveLength(1); expect(result.latest?.assets[0]?.sha256).toBe(digest);
  });
  test("cache, force refresh and repository changes are isolated and callers cannot mutate stored results", async () => {
    let calls = 0, now = 1000;
    const updater = service([], { now: () => now, cacheMs: 100, fetch: async () => { calls++; return Response.json([released("1.1.0")]); } });
    const first = await updater.check(settings); first.latest!.version = "999.0.0";
    expect((await updater.check(settings)).cached).toBe(true); expect((await updater.check(settings)).latest?.version).toBe("1.1.0"); expect(calls).toBe(1);
    await updater.check(settings, { force: true }); expect(calls).toBe(2);
    now += 101; await updater.check(settings); expect(calls).toBe(3);
    await updater.check({ ...settings, repository: "other/browser" }); expect(calls).toBe(4);
  });
  test("concurrent checks share one network request", async () => {
    let calls = 0; const updater = service([], { fetch: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json([released("1.1.0")]); } });
    const results = await Promise.all([updater.check(settings), updater.check(settings), updater.check(settings, { force: true })]);
    expect(calls).toBe(1); expect(results.every(result => result.status === "available")).toBe(true);
  });
  test("rate limits and network failures stay actionable and do not reveal thrown details", async () => {
    const limited = service([], { fetch: async () => new Response("", { status: 403, headers: { "x-ratelimit-reset": "2000" } }) });
    expect(await limited.check(settings)).toMatchObject({ status: "error", rateLimitResetAt: 2_000_000 });
    const failed = service([], { fetch: async () => { throw new Error("secret internal detail"); } });
    expect(JSON.stringify(await failed.check(settings))).not.toContain("secret internal detail");
    expect((await service([], { fetch: async () => new Response("", { status: 404 }) }).check(settings)).error).toContain("not found");
  });
  test("timeouts abort requests and malformed or oversized release payloads are rejected", async () => {
    const delayed = service([], { timeoutMs: 5, fetch: async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("abort")))) });
    expect((await delayed.check(settings)).error).toContain("timed out");
    for (const payload of [{}, [], [released("nonsense")]]) expect((await service(payload).check(settings)).status).toBe("error");
    expect((await service([], { fetch: async () => new Response("[]", { headers: { "content-length": "99999999" } }) }).check(settings)).status).toBe("error");
    expect((await service([], { fetch: async () => new Response("no json") }).check(settings)).error).toContain("invalid release data");
  });
});
