import { expect, test } from "bun:test";
import { MAX_PROFILE_TAGS_JSON_BYTES, normalizeProfileTags, profileTagsUpdate, ProfileTagsValidationError } from "../src/profile-tags.ts";

test("tag normalization accepts legacy text and exact arrays, deduplicates and permits explicit clearing", () => {
  expect(normalizeProfileTags(" Warmup, warmup，中文\nCafe\u0301, Café ")).toEqual(["Warmup", "中文", "Café"]);
  expect(normalizeProfileTags([" One, Two ", "one, two", ""])).toEqual(["One, Two"]);
  expect(normalizeProfileTags([])).toEqual([]); expect(normalizeProfileTags("")).toEqual([]);
  expect(profileTagsUpdate([" Tag "])).toEqual({ tags: ["Tag"] });
});

test("tag validation rejects invalid values atomically with fixed messages and bounded JSON size", () => {
  for (const [value, code] of [
    [null, "invalid-type"], [42, "invalid-type"], [["okay", 42], "invalid-type"], [["okay", { secret: "PRIVATE" }], "invalid-type"],
    [["okay", "PRIVATE\u0000"], "invalid-character"], [["\ttrim"], "invalid-character"], [["PRIVATE\u0085"], "invalid-character"], [["PRIVATE\u202e"], "invalid-character"],
    [["x".repeat(41)], "too-long"], [Array.from({ length: 21 }, (_, index) => `tag${index}`), "too-many"],
    [Array.from({ length: 20 }, (_, index) => `${index}${"🐈".repeat(38)}`), "too-large"],
  ] as const) {
    let error: unknown;
    try { normalizeProfileTags(value); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProfileTagsValidationError); expect((error as ProfileTagsValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain("PRIVATE");
  }
  expect(normalizeProfileTags(["🐈".repeat(40)])).toEqual(["🐈".repeat(40)]);
  const encoded = new TextEncoder().encode(JSON.stringify(normalizeProfileTags(Array.from({ length: 20 }, (_, index) => `${index}${"x".repeat(38)}`))));
  expect(encoded.length).toBeLessThanOrEqual(MAX_PROFILE_TAGS_JSON_BYTES);
});
