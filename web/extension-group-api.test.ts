import { afterEach, expect, test } from "bun:test";
import { fetchExtensions, fetchGroupExtensionDefaults, previewGroupExtensionDefaults, setGroupExtensionDefaults } from "./api.ts";
import type { ExtensionGroupReview } from "../src/extension-group-revision.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const review = (): ExtensionGroupReview => ({ version: 1, group: "Research", extensions: ["b"], expectedFingerprint: "a".repeat(64), count: 1, defaultAdded: ["b"], defaultRemoved: ["a"], changes: [{ id: "one", name: "Synthetic one", added: ["b"], removed: ["a"], running: false }], unknown: 0 });
const response = (body: unknown, status = 200) => { globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch; };

test("review is one same-origin no-store read POST, forwards cancellation and Apply forwards its exact fingerprint", async () => {
  const calls: { path: string; init?: RequestInit }[] = [], controller = new AbortController();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return String(input).endsWith("/preview") ? Response.json({ ok: true, preview: review() }) : Response.json({ ok: true, updatedCount: 1 });
  }) as unknown as typeof fetch;
  const result = await previewGroupExtensionDefaults("Research", ["b"], controller.signal);
  expect(calls).toHaveLength(1); expect(calls[0]!.path).toBe("/ui/api/groups/extensions/preview"); expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ group: "Research", extensions: ["b"] });
  expect(await setGroupExtensionDefaults(result.group, result.extensions, result.expectedFingerprint)).toEqual({ ok: true, updatedCount: 1 });
  expect(calls).toHaveLength(2); expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ group: "Research", extensions: ["b"], expectedFingerprint: "a".repeat(64) });
});

test("failed, wrong-group/target or incomplete reviews cannot become actionable previews", async () => {
  const base = review();
  for (const preview of [null, {}, { ...base, version: 2 }, { ...base, expectedFingerprint: undefined }, { ...base, group: "Other" }, { ...base, extensions: ["different"] }, { ...base, unknown: 1 }, { ...base, count: 0 }, { ...base, defaultAdded: ["not-selected"] }, { ...base, defaultRemoved: ["b"] }, { ...base, changes: [{ ...base.changes[0], running: undefined }] }, { ...base, changes: [base.changes[0], base.changes[0]] }, { ...base, password: "PRIVATE_RAW_FIELD" }, { ...base, changes: [{ ...base.changes[0], incarnation: "PRIVATE_INCARNATION" }] }]) {
    response({ ok: true, preview }); await expect(previewGroupExtensionDefaults("Research", ["b"])).rejects.toThrow("incomplete");
  }
  response({ ok: false, error: "Review unavailable" }, 503); await expect(previewGroupExtensionDefaults("Research", ["b"])).rejects.toThrow("Review unavailable");
  response({ ok: false, error: "False 200" }); await expect(previewGroupExtensionDefaults("Research", ["b"])).rejects.toThrow("False 200");
  response({ ok: true, preview: base }, 500); await expect(previewGroupExtensionDefaults("Research", ["b"])).rejects.toThrow("could not be loaded");
});

test("registry/default reads reject malformed nested records instead of marking stale data fresh", async () => {
  for (const extensions of [[{ id: "", name: "Bad" }], [{ id: "a" }], [{ id: "bad\nvalue", name: "Bad" }], [null], "bad"]) {
    response({ ok: true, extensions }); await expect(fetchExtensions()).rejects.toThrow("unavailable");
  }
  for (const groups of [[{}], [{ name: "Research", extensions: null }], [{ name: "Research", extensions: [2] }], [null], "bad"]) {
    response({ ok: true, groups }); await expect(fetchGroupExtensionDefaults()).rejects.toThrow("unavailable");
  }
  response({ ok: false, groups: [] }); await expect(fetchGroupExtensionDefaults()).rejects.toThrow("unavailable");
  response({ ok: true, groups: [{ name: "Research", extensions: ["missing-on-this-device"] }] }); expect(await fetchGroupExtensionDefaults()).toEqual([{ name: "Research", extensions: ["missing-on-this-device"] }]);
});

test("only explicit successful Apply counts are confirmed; conflict remains a refusal and does not trigger another request", async () => {
  for (const body of [{}, { ok: true }, { ok: true, updatedCount: -1 }, { ok: true, updatedCount: "1" }]) {
    response(body); await expect(setGroupExtensionDefaults("Research", ["b"], "a".repeat(64))).rejects.toThrow("not confirmed");
  }
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ ok: false, code: "preview-conflict", error: "Review again" }, { status: 409 }); }) as unknown as typeof fetch;
  expect(await setGroupExtensionDefaults("Research", ["b"], "a".repeat(64))).toEqual({ ok: false, code: "preview-conflict", error: "Review again" }); expect(calls).toBe(1);
});
