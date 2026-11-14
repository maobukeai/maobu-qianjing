import { expect, test } from "bun:test";
import { createProfileSearchIndex, PROFILE_SEARCH_RENDER_LIMIT, searchProfileIndex, type CommandPaletteProfile } from "./profile-search.ts";

const profile = (id: string, overrides: Partial<CommandPaletteProfile> = {}): CommandPaletteProfile => ({ id, name: id, group: "", tags: [], running: false, ...overrides });
test("environment search matches every word across public name, ID, group and tags with Unicode normalization", () => {
  const source = [profile("one", { name: "Résumé café", group: "Research", tags: ["中文", "Warmup"] }), profile("two", { name: "Other", group: "Research" })];
  const index = createProfileSearchIndex(source);
  expect(searchProfileIndex(index, "RESUME research 中文").items.map(item => item.id)).toEqual(["one"]);
  expect(searchProfileIndex(index, "ｗａｒｍｕｐ").items.map(item => item.id)).toEqual(["one"]);
  expect(searchProfileIndex(index, "two research").items.map(item => item.id)).toEqual(["two"]);
  expect(searchProfileIndex(index, "中文 missing").total).toBe(0);
  expect(source[0]?.name).toBe("Résumé café");
});
test("an empty query ranks favorites then genuine recent launches before a deterministic name tie", () => {
  const index = createProfileSearchIndex([profile("old_favorite", { name: "Zebra", lastOpenAt: 1 }), profile("recent", { lastOpenAt: 900 }), profile("running_old", { running: true, lastOpenAt: 100 }), profile("invalid_future", { name: "Alpha", lastOpenAt: 100_000_000 }), profile("nan", { name: "Bravo", lastOpenAt: NaN })]);
  expect(searchProfileIndex(index, "", { now: 1000, favoriteIds: new Set(["old_favorite"]) }).items.map(item => item.id)).toEqual(["old_favorite", "recent", "running_old", "invalid_future", "nan"]);
});
test("query relevance outranks incidental favorite matches and duplicate IDs cannot create ambiguous actions", () => {
  const index = createProfileSearchIndex([profile("favorite", { name: "Another", tags: ["needle"], lastOpenAt: 100 }), profile("exact", { name: "Needle" }), profile("exact", { name: "Duplicate needle" }), profile("prefix", { name: "Needle extension" })]);
  expect(searchProfileIndex(index, "needle", { favoriteIds: new Set(["favorite"]) }).items.map(item => item.id)).toEqual(["exact", "prefix", "favorite"]);
  expect(searchProfileIndex(index, "duplicate").total).toBe(0);
});
test("the search index keeps an explicit public metadata copy and never retains private extra fields", () => {
  const source = { ...profile("one", { tags: ["original"] }), proxy: "PRIVATE_PROXY", username: "PRIVATE_USERNAME", cookie: "PRIVATE_COOKIE", source: "PRIVATE_SOURCE" };
  const index = createProfileSearchIndex([source]); source.tags.push("later");
  const result = searchProfileIndex(index, "");
  expect(Object.keys(result.items[0]!).sort()).toEqual(["group", "id", "name", "running", "tags"]);
  expect(result.items[0]?.tags).toEqual(["original"]); expect(JSON.stringify(index)).not.toContain("PRIVATE_"); expect(Object.isFrozen(result.items[0])).toBe(true);
});
test("50 results bound rendering without hiding later matches or understating the complete matching count", () => {
  const source = Array.from({ length: 5000 }, (_, index) => profile(`profile_${index}`, { name: `Environment ${index}`, group: index === 4999 ? "Rare target" : "Shared", tags: index === 4100 ? ["tail tag"] : [] }));
  const index = createProfileSearchIndex(source);
  const common = searchProfileIndex(index, "Environment"); expect(common.items).toHaveLength(PROFILE_SEARCH_RENDER_LIMIT); expect(common.total).toBe(5000); expect(common.limited).toBe(true);
  expect(searchProfileIndex(index, "rare target").items[0]?.id).toBe("profile_4999"); expect(searchProfileIndex(index, "tail tag").items[0]?.id).toBe("profile_4100");
  expect(searchProfileIndex(index, "", { limit: 1000 }).items).toHaveLength(50);
});
test("large-list benchmark searches a real 50000-environment index, including IDs beyond any early slice", () => {
  const source = Array.from({ length: 50_000 }, (_, index) => profile(`profile_${index}`, { name: `Project ${index}`, group: `Group ${index % 47}`, tags: [`region_${index % 31}`, `purpose_${index % 13}`], lastOpenAt: index }));
  const buildStart = performance.now(), index = createProfileSearchIndex(source), buildMs = performance.now() - buildStart;
  const queries = ["profile_49999", "region_30 group 46", "Project 31001", "purpose_12", "", "project", "profile_40000", "Group 31 region_2"];
  const searchStart = performance.now();
  const results = queries.map(query => searchProfileIndex(index, query, { now: 50_000, favoriteIds: new Set(["profile_49999"]) }));
  const searchMs = performance.now() - searchStart;
  expect(results[0]?.items[0]?.id).toBe("profile_49999"); expect(results[4]?.items[0]?.id).toBe("profile_49999"); expect(results[5]?.total).toBe(50_000);
  expect(results.every(result => result.items.length <= 50)).toBe(true);
  console.log(`profile search benchmark: rows=50000, build=${buildMs.toFixed(1)}ms, queries=${queries.length}, search=${searchMs.toFixed(1)}ms`);
});
