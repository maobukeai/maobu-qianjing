import assert from "node:assert/strict";
import { fetchProfiles } from "../web/api.ts";
import { createProfileSearchIndex } from "../web/profile-search.ts";
import { rosterBenchmarkData } from "./roster-benchmark-data.ts";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function run(scenario: string) {
  const realFetch = globalThis.fetch, previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let origin = "http://127.0.0.1:47001", textReads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { get origin() { return origin; } } } });
  const requests: Array<{ tag: string | null; origin: string }> = [];
  let handler: (init: RequestInit | undefined) => Promise<Response>;
  const response = (id: string, tag?: string, status = 200) => Response.json({ profiles: [{ id, name: id, engine: "firefox", debugPort: 9000, group: "A", tags: ["one"], futureMetadata: { enabled: true } }], groups: ["A"], folders: [{ name: "A", futureMetadata: { value: 1 } }] }, { status, headers: tag ? { ETag: tag } : {} });
  const unchanged = (tag?: string) => {
    const result = new Response(null, { status: 304, headers: tag ? { ETag: tag } : {} });
    Object.defineProperty(result, "text", { configurable: true, value: async () => { textReads++; throw new Error("304 body must never be parsed"); } }); return result;
  };
  globalThis.fetch = Object.assign(async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, "/ui/api/profiles"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    requests.push({ tag: new Headers(init?.headers).get("If-None-Match"), origin }); return handler(init);
  }, { preconnect: realFetch.preconnect });
  try {
    if (scenario === "references") {
      handler = async () => response("one", '"first"'); const first = await fetchProfiles();
      assert.equal(requests[0]?.tag, null); assert.equal(first.profiles[0]?.engine, "firefox"); assert.ok(!("debugPort" in first.profiles[0]!));
      handler = async () => unchanged('"first"'); const second = await fetchProfiles();
      assert.equal(requests[1]?.tag, '"first"'); assert.ok(second === first); assert.ok(second.profiles === first.profiles); assert.ok(second.groups === first.groups); assert.ok(second.folders === first.folders); assert.equal(textReads, 0); return;
    }
    if (scenario === "invalid-304") {
      handler = async () => unchanged('"missing-cache"'); await assert.rejects(fetchProfiles(), /matching in-memory snapshot/); assert.equal(requests.length, 1, "An invalid 304 must not loop or fabricate an empty roster");
      handler = async () => response("valid", '"valid"'); const valid = await fetchProfiles();
      for (const tag of [undefined, '"other"']) { handler = async () => unchanged(tag); await assert.rejects(fetchProfiles(), /matching in-memory snapshot/); }
      handler = async () => unchanged('"valid"'); assert.ok(await fetchProfiles() === valid); assert.equal(textReads, 0); return;
    }
    if (scenario === "legacy-clears-tag") {
      handler = async () => response("tagged", '"old"'); const first = await fetchProfiles();
      handler = async () => response("legacy"); const legacy = await fetchProfiles(); assert.equal(requests.at(-1)?.tag, '"old"'); assert.ok(legacy !== first);
      handler = async () => response("legacy-again"); await fetchProfiles(); assert.equal(requests.at(-1)?.tag, null);
      handler = async () => response("weak", 'W/"weak"'); await fetchProfiles(); handler = async () => response("weak-next"); await fetchProfiles(); assert.equal(requests.at(-1)?.tag, null); return;
    }
    if (scenario === "failure-preserves") {
      handler = async () => response("valid", '"valid"'); const valid = await fetchProfiles();
      handler = async () => Response.json({ error: "Inert server failure", profiles: [] }, { status: 500, headers: { ETag: '"bad"' } }); await assert.rejects(fetchProfiles(), /Inert server failure/);
      handler = async () => unchanged('"valid"'); assert.ok(await fetchProfiles() === valid); assert.equal(requests.at(-1)?.tag, '"valid"');
      handler = async () => Response.json({ noProfiles: [] }, { headers: { ETag: '"malformed"' } }); await assert.rejects(fetchProfiles(), /no profile roster/);
      handler = async () => new Response("null", { headers: { ETag: '"null-body"' } }); await assert.rejects(fetchProfiles(), /no profile roster/);
      handler = async () => unchanged('"valid"'); assert.ok(await fetchProfiles() === valid); return;
    }
    if (scenario === "origin-isolation") {
      handler = async () => response("origin-a", '"a"'); const first = await fetchProfiles();
      const late = deferred<Response>(); handler = () => late.promise; const oldOrigin = fetchProfiles();
      origin = "http://127.0.0.1:47002"; handler = async () => response("origin-b", '"b"'); const current = await fetchProfiles(); assert.equal(requests.at(-1)?.tag, null);
      late.resolve(response("old-origin-late", '"old-late"')); const lateResult = await oldOrigin; assert.notEqual(lateResult.profiles[0]?.id, current.profiles[0]?.id);
      handler = async () => unchanged('"b"'); assert.ok(await fetchProfiles() === current); assert.equal(requests.at(-1)?.tag, '"b"');
      origin = "http://127.0.0.1:47001"; handler = async () => response("origin-a-new", '"a-new"'); const back = await fetchProfiles(); assert.equal(requests.at(-1)?.tag, null); assert.ok(back !== first); return;
    }
    if (["late-200", "late-304", "late-failure", "parse-race"].includes(scenario)) {
      handler = async () => response("base", '"base"'); await fetchProfiles();
      const olderResponse = deferred<Response>(), olderText = deferred<string>();
      handler = async () => {
        if (scenario !== "parse-race") return olderResponse.promise;
        const result = response("old-body", '"old"'); Object.defineProperty(result, "text", { value: () => olderText.promise }); return result;
      };
      const older = fetchProfiles(); await Promise.resolve();
      handler = async () => response("new-current", '"new"'); const current = await fetchProfiles();
      if (scenario === "late-200") olderResponse.resolve(response("stale", '"stale"'));
      else if (scenario === "late-304") olderResponse.resolve(unchanged('"base"'));
      else if (scenario === "late-failure") olderResponse.reject(new Error("Obsolete network failure"));
      else olderText.resolve('{"profiles":[{"id":"old-parsed"}],"groups":[]}');
      assert.ok(await older === current, "An older completion must return the newest same-origin committed snapshot");
      handler = async () => unchanged('"new"'); assert.ok(await fetchProfiles() === current); assert.equal(requests.at(-1)?.tag, '"new"'); return;
    }
    if (scenario === "benchmark") {
      for (const count of [10_000, 50_000]) {
        const body = rosterBenchmarkData(count), serialized = JSON.stringify(body), tag = `"bench-${count}"`;
        // Build the server representation once, outside client timing. Production client never serializes it.
        handler = async () => new Response(serialized, { headers: { ETag: tag, "Content-Type": "application/json" } });
        let start = performance.now(); const initial = await fetchProfiles(), initialMs = performance.now() - start;
        start = performance.now(); const full = await fetchProfiles(), fullMs = performance.now() - start; assert.ok(full !== initial);
        start = performance.now(); createProfileSearchIndex(full.profiles); const indexMs = performance.now() - start;
        handler = async () => unchanged(tag); start = performance.now(); const same = await fetchProfiles(), conditionalMs = performance.now() - start;
        assert.ok(same === full); assert.ok(same.profiles === full.profiles); assert.equal(textReads, 0);
        console.log(`roster conditional client benchmark: rows=${count}, fields=${Object.keys(body.profiles[0]!).length}, jsonBytes=${new TextEncoder().encode(serialized).length}, initial200=${initialMs.toFixed(1)}ms, repeat200=${fullMs.toFixed(1)}ms, finderIndex=${indexMs.toFixed(1)}ms, conditional304=${conditionalMs.toFixed(3)}ms, sameReference=${same === full}, bodyReads304=${textReads}`);
      }
      return;
    }
    throw new Error(`Unknown ETag client fixture: ${scenario}`);
  } finally { globalThis.fetch = realFetch; if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "references"); console.log("profile roster conditional client fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
