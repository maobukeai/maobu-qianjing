import { expect, test } from "bun:test";
import { inProfileScope, parseFavoriteProfiles, parseSavedProfileViews, serializeFavoriteProfiles, serializeSavedProfileViews, sameProfileView, type SavedProfileView } from "./profile-view-state.ts";

const saved: SavedProfileView = { id: `view_${"a".repeat(32)}`, name: "Overseas · running", filters: { scope: "favorites", query: "Research", group: "海外业务", status: "running", sort: { key: "name", dir: -1 }, hiddenColumns: ["no", "tags"], pageSize: 50 } };
test("a saved view round-trips its actual filter and table layout without copying profile data", () => {
  expect(parseSavedProfileViews(serializeSavedProfileViews([saved]))).toEqual([saved]);
  expect(sameProfileView(saved.filters, { ...saved.filters, hiddenColumns: ["tags", "no"] })).toBe(true);
  expect(sameProfileView(saved.filters, { ...saved.filters, query: "Other" })).toBe(false);
});
test("malformed or oversized metadata is rejected as a whole instead of silently dropping views", () => {
  for (const value of ["not-json", "{}", JSON.stringify([saved, saved]), JSON.stringify([{ ...saved, name: " Untrimmed " }]), JSON.stringify([{ ...saved, filters: { ...saved.filters, proxyPassword: "secret" } }]), JSON.stringify([{ ...saved, filters: { ...saved.filters, scope: { toString: "broken" } } }])]) expect(parseSavedProfileViews(value)).toBeNull();
  expect(() => serializeSavedProfileViews(Array.from({ length: 13 }, (_, index) => ({ ...saved, id: `view_${index.toString(16).padStart(32, "0")}`, name: `View ${index}` })))).toThrow();
});
test("favorite IDs retain missing profiles for restore but reject duplicates and capacity overflow", () => {
  const ids = ["live_profile", "temporarily_trashed"];
  expect(parseFavoriteProfiles(serializeFavoriteProfiles(ids))).toEqual(ids);
  expect(parseFavoriteProfiles('["same","same"]')).toBeNull();
  expect(parseFavoriteProfiles('["line\\nbreak"]')).toBeNull();
  expect(() => serializeFavoriteProfiles(Array.from({ length: 101 }, (_, index) => `p${index}`))).toThrow();
});
test("recent launches use real timestamps and do not count never-opened or implausibly future profiles", () => {
  const now = 1_800_000_000_000, favorites = new Set<string>();
  expect(inProfileScope({ id: "recent", lastOpenAt: now - 60_000 }, "recent", favorites, now)).toBe(true);
  for (const lastOpenAt of [undefined, 0, Number.NaN, now - 8 * 86_400_000, now + 86_400_000]) expect(inProfileScope({ id: "old", lastOpenAt }, "recent", favorites, now)).toBe(false);
});
test("attention is actionable configuration state, not an invented fingerprint or reputation score", () => {
  const favorites = new Set(["favorite"]);
  expect(inProfileScope({ id: "favorite" }, "favorites", favorites)).toBe(true);
  expect(inProfileScope({ id: "other" }, "favorites", favorites)).toBe(false);
  expect(inProfileScope({ id: "plain" }, "attention", favorites)).toBe(false);
  for (const value of [{ proxyError: "Invalid address" }, { restartPending: true }, { mobilePersona: true }]) expect(inProfileScope({ id: "needs-work", ...value }, "attention", favorites)).toBe(true);
});
