import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { handleUiRequest, listUiProfiles } from "./ui.ts";
import { serveDashboard } from "./web.ts";
import { rosterBenchmarkData } from "./test-fixtures/roster-benchmark-data.ts";
import type { UiRosterTags } from "./src/ui/shared.ts";

function fixture() {
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ name: "Conditional fixture", group: "A", username: "PRIVATE_USERNAME", password: "PRIVATE_PASSWORD" }, () => false);
  store.upsertProfile(profile);
  let reconciliations = 0, fail = false;
  const launcher = { reconcileOrphans: async () => { reconciliations++; if (fail) throw new Error("inert reconciliation failure"); } } as any;
  return { store, profile, launcher, get reconciliations() { return reconciliations; }, fail: () => { fail = true; } };
}
const request = (etag?: string) => new Request("http://localhost/ui/api/profiles", { headers: etag ? { "If-None-Match": etag } : {} });

test("roster ETag is a strong hash of exact redacted JSON and 304 still reconciles live state with no-store", async () => {
  const state = fixture();
  try {
    const first = (await handleUiRequest(request(), state.launcher, state.store))!, text = await first.text(), etag = first.headers.get("etag")!;
    expect(first.status).toBe(200); expect(first.headers.get("content-type")).toContain("application/json"); expect(first.headers.get("cache-control")).toBe("no-store");
    expect(etag).toBe(`"sha256-${createHash("sha256").update(text).digest("hex")}"`); expect(text).not.toContain("PRIVATE_");
    const unchanged = (await handleUiRequest(request(etag), state.launcher, state.store))!;
    expect(unchanged.status).toBe(304); expect(unchanged.body).toBeNull(); expect(await unchanged.text()).toBe(""); expect(unchanged.headers.get("etag")).toBe(etag); expect(unchanged.headers.get("cache-control")).toBe("no-store"); expect(state.reconciliations).toBe(2);
    for (const unsupported of [`W/${etag}`, `${etag}, "other"`, "*"]) expect((await handleUiRequest(request(unsupported), state.launcher, state.store))!.status).toBe(200);
  } finally { state.store.close(); }
});
test("conditional roster requests reflect launch changes and never hide reconciliation errors", async () => {
  const state = fixture();
  try {
    const first = (await handleUiRequest(request(), state.launcher, state.store))!, firstTag = first.headers.get("etag")!;
    state.store.recordLaunch({ profileId: state.profile.id, pid: 1, debugPort: 9000, ws: "ws://inert", startedAt: 123 });
    const running = (await handleUiRequest(request(firstTag), state.launcher, state.store))!;
    expect(running.status).toBe(200); expect(running.headers.get("etag")).not.toBe(firstTag); expect((await running.json()).profiles[0].running).toBe(true);
    const runningTag = running.headers.get("etag")!; state.store.clearLaunch(state.profile.id);
    const stopped = (await handleUiRequest(request(runningTag), state.launcher, state.store))!;
    expect(stopped.status).toBe(200); expect((await stopped.json()).profiles[0].running).toBe(false);
    state.fail(); const failed = (await handleUiRequest(request(stopped.headers.get("etag")!), state.launcher, state.store))!;
    expect(failed.status).toBe(500); expect(failed.headers.get("etag")).toBeNull(); expect(failed.headers.get("cache-control")).toBe("no-store"); expect((await failed.json()).error).toContain("inert reconciliation failure");
  } finally { state.store.close(); }
});
test("all serialized fields affect the roster ETag, including nested tags/extensions, additions/deletions and unknown folder metadata", async () => {
  const state = fixture(), originalFolders = state.store.listFolders;
  let future: Record<string, unknown> = { enabled: true };
  state.store.listFolders = () => [{ name: "A", parentName: null, label: "A", futureMetadata: future }];
  let tag: string | undefined;
  const changed = async () => { const result = (await handleUiRequest(request(tag), state.launcher, state.store))!; expect(result.status).toBe(200); const next = result.headers.get("etag")!; if (tag) expect(next).not.toBe(tag); tag = next; return result.json(); };
  try {
    await changed();
    state.store.upsertProfile({ ...state.store.getProfile(state.profile.id)!, tags: ["new tag"], extensions: ["new extension"] }); const nested = await changed(); expect(nested.profiles[0]).toMatchObject({ tags: ["new tag"], extensions: ["new extension"] });
    const added = { ...state.store.getProfile(state.profile.id)!, id: "etag_added", name: "Added" }; state.store.upsertProfile(added); expect((await changed()).profiles).toHaveLength(2);
    state.store.deleteProfile(added.id); expect((await changed()).profiles).toHaveLength(1);
    future = { enabled: false, unknownNested: { values: [1, 2] } }; expect((await changed()).folders[0].futureMetadata).toEqual(future);
    future = {}; expect((await changed()).folders[0].futureMetadata).toEqual({});
  } finally { state.store.listFolders = originalFolders; state.store.close(); }
});
test("a matching conditional tag cannot bypass the dashboard's existing source boundary", async () => {
  const state = fixture(), server = serveDashboard({ port: 0, launcher: state.launcher, store: state.store, log() {} });
  const origin = `http://127.0.0.1:${server.port}`;
  const list = spyOn(state.store, "listProfiles");
  try {
    const first = await fetch(`${origin}/ui/api/profiles`), tag = first.headers.get("etag")!; expect(first.status).toBe(200);
    const foreignSources: Array<Record<string, string>> = [{ Origin: "https://foreign.invalid" }, { Referer: "https://foreign.invalid/" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const extra of foreignSources) {
      const blocked = await fetch(`${origin}/ui/api/profiles`, { headers: { "If-None-Match": tag, ...extra } }); expect(blocked.status).toBe(403);
    }
    expect(state.reconciliations).toBe(1);
    const normal = await fetch(`${origin}/ui/api/profiles`, { headers: { "If-None-Match": tag, Referer: `${origin}/ui/` } }); expect(normal.status).toBe(304); expect(state.reconciliations).toBe(2);
    expect(list).toHaveBeenCalledTimes(1);
  } finally { list.mockRestore(); await server.stop(true); state.store.close(); }
});

test("conditional reuse is invalidated by raw writes and does not cache a failed reconciliation", async () => {
  const state = fixture();
  const rosterTags: UiRosterTags = new WeakMap();
  const get = (etag?: string) => handleUiRequest(request(etag), state.launcher, state.store, { rosterTags });
  const list = spyOn(state.store, "listProfiles");
  try {
    const first = (await get())!;
    const originalTag = first.headers.get("etag")!;
    expect((await get(originalTag))!.status).toBe(304);
    expect(list).toHaveBeenCalledTimes(1);

    state.store.rawDatabase().query("UPDATE profiles SET name = ? WHERE id = ?").run("Changed directly", state.profile.id);
    const changed = (await get(originalTag))!;
    expect(changed.status).toBe(200);
    expect((await changed.json()).profiles[0].name).toBe("Changed directly");
    expect(list).toHaveBeenCalledTimes(2);

    const newTag = changed.headers.get("etag")!;
    expect((await get(newTag))!.status).toBe(304);
    state.fail();
    expect((await get(newTag))!.status).toBe(500);
    expect(state.reconciliations).toBe(5);
    expect(list).toHaveBeenCalledTimes(2);
  } finally { list.mockRestore(); state.store.close(); }
});

test("another connection invalidates the tag, including a commit during roster serialization", async () => {
  const home = mkdtempSync(join(tmpdir(), "maobu-roster-revision-"));
  const path = join(home, "profiles.sqlite");
  const store = new ProfileStore(path, { protection: { inMemory: true } });
  const writer = new Database(path);
  const profile = buildNewProfile({ name: "Before external commit", group: "A" }, () => false);
  const launcher = { reconcileOrphans: async () => {} } as any;
  const rosterTags: UiRosterTags = new WeakMap();
  const get = (etag?: string) => handleUiRequest(request(etag), launcher, store, { rosterTags });
  const update = writer.query("UPDATE profiles SET name = ? WHERE id = ?");
  const originalFolders = store.listFolders.bind(store);
  let injected = false;
  store.listFolders = () => {
    if (!injected) {
      injected = true;
      update.run("During serialization", profile.id);
    }
    return originalFolders();
  };
  try {
    store.upsertProfile(profile);
    const first = (await get())!;
    expect((await first.json()).profiles[0].name).toBe("Before external commit");
    expect(rosterTags.has(store)).toBe(false);

    const changed = (await get(first.headers.get("etag")!))!;
    expect(changed.status).toBe(200);
    expect((await changed.json()).profiles[0].name).toBe("During serialization");
    const latestTag = changed.headers.get("etag")!;
    expect((await get(latestTag))!.status).toBe(304);
    update.run("After serialization", profile.id);

    const after = (await get(latestTag))!;
    expect(after.status).toBe(200);
    expect((await after.json()).profiles[0].name).toBe("After serialization");
  } finally {
    writer.close(true);
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

for (const count of [10_000, 50_000]) {
  test(`conditional roster server benchmark: ${count} profiles with and without revision reuse`, async () => {
    const data = rosterBenchmarkData(count), base = buildNewProfile({ name: "Inert benchmark" }, () => false);
    const profiles = data.profiles.map((profile, index) => ({ ...base, ...profile, proxy: { type: "http" as const, host: `proxy${index % 500}.invalid`, port: 8080 }, cookies: base.cookies }));
    const metadata = new Map(data.profiles.map(profile => [profile.id, { serial: profile.serial!, createdAt: profile.createdAt!, lastOpenAt: profile.lastOpenAt! }]));
    const launches = profiles.filter((_, index) => index % 7 === 0).map((profile, index) => ({ profileId: profile.id, pid: index + 1, debugPort: 10_000 + index, ws: "ws://inert", startedAt: 1_710_000_000_000 + index }));
    let reconciliations = 0, lists = 0;
    const launcher = { reconcileOrphans: async () => { reconciliations++; } } as any;
    const store = { listProfiles: () => { lists++; return profiles; }, listLaunches: () => launches, listProfileMeta: () => metadata, pendingCookieCounts: () => new Map(), listGroups: () => data.groups, listFolders: () => data.folders } as any;
    let start = performance.now(); const first = (await handleUiRequest(request(), launcher, store))!, firstMs = performance.now() - start;
    const text = await first.text(), tag = first.headers.get("etag")!;
    start = performance.now(); const unchanged = (await handleUiRequest(request(tag), launcher, store))!, unchangedMs = performance.now() - start;
    expect(first.status).toBe(200); expect(unchanged.status).toBe(304); expect(unchanged.body).toBeNull(); expect(reconciliations).toBe(2); expect(lists).toBe(2);
    const fields = Object.keys(listUiProfiles({ ...store, listProfiles: () => profiles.slice(0, 1) } as any)[0]!).length;
    const withCache = Object.assign(new ProfileStore(":memory:"), store);
    const rosterTags: UiRosterTags = new WeakMap();
    try {
      const seeded = (await handleUiRequest(request(), launcher, withCache, { rosterTags }))!;
      const seededTag = seeded.headers.get("etag")!;
      expect(seededTag).toBe(tag);
      const mapped = lists;
      start = performance.now();
      const cached = (await handleUiRequest(request(seededTag), launcher, withCache, { rosterTags }))!;
      const cachedMs = performance.now() - start;
      expect(cached.status).toBe(304);
      expect(lists).toBe(mapped);
      console.log(`roster conditional server benchmark: rows=${count}, mappedFields=${fields}, jsonBytes=${Buffer.byteLength(text)}, first200=${firstMs.toFixed(1)}ms, uncached304=${unchangedMs.toFixed(1)}ms, unchanged304=${cachedMs.toFixed(1)}ms, cachedFullMappings=${lists - mapped}`);
    } finally { withCache.close(); }
  });
}
