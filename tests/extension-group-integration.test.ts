import { afterEach, expect, test } from "bun:test";
import { ProfileStore } from "../src/store.ts";
import { handleUiRequest } from "../src/ui.ts";
import type { Profile } from "../src/types.ts";
import { ExtensionGroupRevisionError } from "../src/extension-group-revision.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new ProfileStore(":memory:"); stores.push(store);
  const base: Profile = { id: "one", accId: "", name: "Synthetic one", group: "Research", platform: "", engine: "chromium", chromiumRuntime: "aliasmode", username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", twofa: "PRIVATE_2FA", proxy: null, ua: "", timezone: "UTC", locale: "en-US", platformOs: "windows", screenWidth: 1600, screenHeight: 900, displayScale: 1, fingerprintSeed: 482731, hardware: { cores: 4 }, cookies: [], seeded: false, extensions: ["a"] };
  store.upsertProfile(base); store.upsertProfile({ ...base, id: "two", name: "Synthetic two" }); store.upsertProfile({ ...base, id: "outside", group: "Other", extensions: ["keep"] });
  store.setGroupExtensionDefaults("Research", ["a"]);
  return { store, base };
}
const request = (path: string, body: unknown, origin?: string) => new Request(`http://127.0.0.1:50400/ui/api/groups/extensions${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
const route = (store: ProfileStore, path: string, body: unknown, origin?: string) => handleUiRequest(request(path, body, origin), {} as any, store);
const state = (store: ProfileStore) => ({ defaults: store.listGroupExtensionDefaults(), profiles: store.listProfiles() });

test("read-only review exposes only safe DTO fields and checked Apply writes exactly the reviewed selection", async () => {
  const { store } = fixture(), before = state(store), privateIncarnation = store.getProfileIncarnation("one")!;
  const response = (await route(store, "/preview", { group: "Research", extensions: ["b"] }))!;
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { preview } = await response.json(); expect(preview.count).toBe(2); expect(preview.expectedFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.changes.map((item: any) => item.id)).toEqual(["one", "two"]); expect(state(store)).toEqual(before);
  for (const secret of [privateIncarnation, "PRIVATE_USER", "PRIVATE_PASSWORD", "PRIVATE_2FA", "proxy", "cookies"]) expect(JSON.stringify(preview)).not.toContain(secret);
  const applied = (await route(store, "", { group: preview.group, extensions: preview.extensions, expectedFingerprint: preview.expectedFingerprint }))!;
  expect(applied.status).toBe(200); expect(await applied.json()).toEqual({ ok: true, updatedCount: 2 });
  expect(store.getGroupExtensionDefaults("Research")).toEqual(["b"]); expect(store.getProfile("one")!.extensions).toEqual(["b"]); expect(store.getProfile("outside")!.extensions).toEqual(["keep"]);
});

test("the revision is read/compared in the same Store transaction as the member/default writes", () => {
  const { store } = fixture(), inside: boolean[] = [];
  const original = (store as any).extensionGroupRevisionState.bind(store);
  (store as any).extensionGroupRevisionState = (group: string) => { inside.push((store as any).db.inTransaction); return original(group); };
  const review = store.previewGroupExtensionDefaults("Research", ["b"]);
  const saved = store.upsertProfile.bind(store);
  store.upsertProfile = profile => { inside.push((store as any).db.inTransaction); saved(profile); };
  expect(store.setGroupExtensionDefaults("Research", ["b"], review.expectedFingerprint)).toBe(2);
  expect(inside).toEqual([true, true, true, true]);
});

test("a concurrent custom assignment returns 409 and does not partially modify defaults or another member", async () => {
  const { store } = fixture(), preview = store.previewGroupExtensionDefaults("Research", ["c"]);
  store.upsertProfile({ ...store.getProfile("one")!, extensions: ["b"] }); const before = state(store);
  const response = (await route(store, "", { group: "Research", extensions: ["c"], expectedFingerprint: preview.expectedFingerprint }))!;
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ ok: false, code: "preview-conflict" }); expect(state(store)).toEqual(before);
});

for (const change of ["join", "leave", "delete", "recreate", "defaults", "group-delete", "target"] as const) {
  test(`review conflict protects ${change}`, async () => {
    const { store, base } = fixture(), preview = store.previewGroupExtensionDefaults("Research", ["c"]);
    if (change === "join") store.upsertProfile({ ...base, id: "joined", extensions: ["custom"] });
    if (change === "leave") store.upsertProfile({ ...store.getProfile("one")!, group: "Other" });
    if (change === "delete" || change === "recreate") store.deleteProfile("one");
    if (change === "recreate") store.upsertProfile({ ...base });
    if (change === "defaults") store.setGroupExtensionDefaults("Research", ["new-default"]);
    if (change === "group-delete") store.deleteGroup("Research");
    const before = state(store);
    const response = (await route(store, "", { group: "Research", extensions: change === "target" ? ["different-target"] : ["c"], expectedFingerprint: preview.expectedFingerprint }))!;
    expect(response.status).toBe(409); expect(state(store)).toEqual(before);
    if (change === "group-delete") expect(store.listGroups()).not.toContain("Research");
  });
}

test("a review cannot be carried to a different workspace Store even if its public assignments match", async () => {
  const first = fixture().store, second = fixture().store;
  // Deliberately copy private incarnations too, as a full workspace backup can do.
  for (const profile of first.listProfiles()) (second as any).db.query("UPDATE profiles SET incarnation=? WHERE id=?").run(first.getProfileIncarnation(profile.id), profile.id);
  const review = first.previewGroupExtensionDefaults("Research", ["b"]), before = state(second);
  const response = (await route(second, "", { group: "Research", extensions: ["b"], expectedFingerprint: review.expectedFingerprint }))!;
  expect(response.status).toBe(409); expect(state(second)).toEqual(before);
});

test("checked transaction rolls back defaults and prior members if a later member write fails", async () => {
  const { store } = fixture(), preview = store.previewGroupExtensionDefaults("Research", ["b"]), before = state(store);
  const original = store.upsertProfile.bind(store);
  store.upsertProfile = profile => { if (profile.id === "two") throw new Error("PRIVATE_DATABASE_CAUSE"); original(profile); };
  const response = (await route(store, "", { group: "Research", extensions: ["b"], expectedFingerprint: preview.expectedFingerprint }))!;
  expect(response.status).toBe(500); expect(await response.text()).not.toContain("PRIVATE_DATABASE_CAUSE"); expect(state(store)).toEqual(before);
});

test("checked no-ops use set semantics without rewriting user order or inflating the changed count", () => {
  const { store } = fixture(); store.setGroupExtensionDefaults("Research", ["b", "a"]);
  const before = state(store), preview = store.previewGroupExtensionDefaults("Research", ["a", "b"]);
  expect(preview.changes).toEqual([]); expect(preview.defaultAdded).toEqual([]); expect(preview.defaultRemoved).toEqual([]);
  expect(store.setGroupExtensionDefaults("Research", ["a", "b"], preview.expectedFingerprint)).toBe(0); expect(state(store)).toEqual(before);
});

test("new review accepts explicit empty/portable target; legacy clients retain their existing unconditional contract", async () => {
  const { store } = fixture();
  const legacy = (await route(store, "", { group: "Research", extensions: ["b", "a", "b"] }))!;
  expect(legacy.status).toBe(200); expect(store.getProfile("one")!.extensions).toEqual(["b", "a"]);
  const empty = store.previewGroupExtensionDefaults("Research", []); expect(store.setGroupExtensionDefaults("Research", [], empty.expectedFingerprint)).toBe(2);
  expect(store.getProfile("one")!.extensions).toEqual([]);
  const portable = store.previewGroupExtensionDefaults("Research", ["missing-on-this-device"]); expect(portable.extensions).toEqual(["missing-on-this-device"]);
});

test("corrupt persisted assignments/defaults cannot be reviewed as an empty, safe selection", async () => {
  for (const [table, value] of [["profile", "{broken"], ["profile", "null"], ["profile", '[2]'], ["defaults", "{broken"], ["defaults", "null"]]) {
    const { store } = fixture();
    if (table === "profile") (store as any).db.query("UPDATE profiles SET extensions_json=? WHERE id='one'").run(value);
    else (store as any).db.query("UPDATE groups SET extension_defaults_json=? WHERE name='Research'").run(value);
    const before = table === "profile" ? (store as any).db.query("SELECT extensions_json AS value FROM profiles WHERE id='one'").get().value : (store as any).db.query("SELECT extension_defaults_json AS value FROM groups WHERE name='Research'").get().value;
    const response = (await route(store, "/preview", { group: "Research", extensions: [] }))!;
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, code: "state-unavailable" });
    expect(table === "profile" ? (store as any).db.query("SELECT extensions_json AS value FROM profiles WHERE id='one'").get().value : (store as any).db.query("SELECT extension_defaults_json AS value FROM groups WHERE name='Research'").get().value).toBe(before);
  }
});

test("preview and checked Apply reject malformed/cross-origin requests without creating groups or leaking input", async () => {
  const { store } = fixture(), before = state(store);
  for (const body of [null, [], {}, { group: "Research", extensions: ["PRIVATE\nINPUT"] }]) {
    const response = (await route(store, "/preview", body))!; expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE");
  }
  for (const expectedFingerprint of [null, "PRIVATE_INPUT", 2]) {
    const response = (await route(store, "", { group: "Research", extensions: ["b"], expectedFingerprint }))!; expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE_INPUT");
  }
  expect((await route(store, "/preview", { group: "missing", extensions: [] }))!.status).toBe(404);
  expect((await route(store, "/preview", { group: "Research", extensions: [] }, "https://outside.invalid"))!.status).toBe(403);
  expect(state(store)).toEqual(before);
  try { store.setGroupExtensionDefaults("Research", [], "bad"); throw new Error("Expected refusal"); } catch (error) { expect(error).toBeInstanceOf(ExtensionGroupRevisionError); }
});
