import { expect, test } from "bun:test";
import { assertExtensionGroupRevision, canonicalExtensionSelection, createExtensionGroupReview, extensionGroupExpectedFingerprint, ExtensionGroupRevisionError, parseExtensionGroupSelection, validExtensionGroupFingerprint, type ExtensionGroupRevisionCode, type ExtensionGroupRevisionState } from "./extension-group-revision.ts";

const baseline = (): ExtensionGroupRevisionState => ({ scope: "synthetic-workspace-generation", group: "Research", exists: true, defaults: ["a"], members: [
  { id: "one", incarnation: "PRIVATE_INCARNATION_ONE", engine: "chromium", extensions: ["a", "c"], name: "Custom selection", running: true },
  { id: "two", incarnation: "PRIVATE_INCARNATION_TWO", engine: "chromium", extensions: [], name: "Empty selection", running: false },
  { id: "three", incarnation: "PRIVATE_INCARNATION_THREE", engine: "firefox", extensions: [], name: "Firefox", running: false },
] });
function refusal(action: () => unknown, code: ExtensionGroupRevisionCode, status: number) {
  try { action(); throw new Error("Expected review refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ExtensionGroupRevisionError); expect((error as ExtensionGroupRevisionError).code).toBe(code); expect((error as ExtensionGroupRevisionError).status).toBe(status); }
}

test("review accurately presents custom replacements and Firefox's empty result, without exposing private source fields", () => {
  const state = baseline(); Object.assign(state.members[0]!, { password: "PRIVATE_PASSWORD", proxy: { pass: "PRIVATE_PROXY_PASS" }, cookies: ["PRIVATE_COOKIE"] });
  const before = JSON.stringify(state), review = createExtensionGroupReview(state, ["b"]);
  expect(review).toEqual({ version: 1, group: "Research", extensions: ["b"], expectedFingerprint: extensionGroupExpectedFingerprint(state, ["b"]), count: 3, defaultAdded: ["b"], defaultRemoved: ["a"], unknown: 0, changes: [
    { id: "one", name: "Custom selection", running: true, added: ["b"], removed: ["a", "c"] },
    { id: "two", name: "Empty selection", running: false, added: ["b"], removed: [] },
  ] });
  expect(JSON.stringify(state)).toBe(before);
  for (const secret of ["PRIVATE_INCARNATION", "PRIVATE_PASSWORD", "PRIVATE_PROXY_PASS", "PRIVATE_COOKIE", "synthetic-workspace-generation"]) expect(JSON.stringify(review)).not.toContain(secret);
});

test("canonical set ordering and duplicate IDs do not create false conflicts or mutate caller arrays", () => {
  const state = baseline(), expected = extensionGroupExpectedFingerprint(state, ["b", "a"]);
  const reordered = { ...state, defaults: ["a", "a"], members: [...state.members].reverse().map(member => ({ ...member, extensions: [...member.extensions].reverse() })) };
  expect(extensionGroupExpectedFingerprint(reordered, [" a ", "b", "b"])).toBe(expected);
  assertExtensionGroupRevision(expected, reordered, ["b", "a"]);
  expect(canonicalExtensionSelection([" b ", "a", "b"])).toEqual(["a", "b"]);
});

test("name/running presentation changes do not invalidate an assignment-safe review", () => {
  const state = baseline(), renamed = { ...state, members: state.members.map(member => ({ ...member, name: "New label", running: !member.running })) };
  expect(extensionGroupExpectedFingerprint(state, ["b"])).toBe(extensionGroupExpectedFingerprint(renamed, ["b"]));
});

test("CAS binds target, group, defaults, membership, engine and same-id incarnation", () => {
  const state = baseline(), expected = extensionGroupExpectedFingerprint(state, ["b"]);
  const changed: ExtensionGroupRevisionState[] = [
    { ...state, scope: "another-workspace-or-server-generation" }, { ...state, group: "Other" }, { ...state, exists: false }, { ...state, defaults: ["c"] },
    { ...state, members: state.members.slice(1) },
    { ...state, members: [...state.members, { id: "new_member", incarnation: "new-incarnation", engine: "chromium", extensions: ["c"], name: "New member", running: false }] },
    { ...state, members: state.members.map(member => member.id === "one" ? { ...member, incarnation: "recreated-same-id" } : member) },
    { ...state, members: state.members.map(member => member.id === "one" ? { ...member, extensions: ["new-custom-selection"] } : member) },
    { ...state, members: state.members.map(member => member.id === "two" ? { ...member, engine: "firefox" } : member) },
  ];
  for (const current of changed) refusal(() => assertExtensionGroupRevision(expected, current, ["b"]), "preview-conflict", 409);
  refusal(() => assertExtensionGroupRevision(expected, state, ["c"]), "preview-conflict", 409);
});

test("unknown incarnation, duplicate member IDs, unsupported engines or incomplete assignments cannot be reviewed as safe", () => {
  const state = baseline();
  for (const change of [{ incarnation: "" }, { engine: "unknown" }, { extensions: undefined }, { extensions: [null] }, { id: "../unsafe" }]) {
    const bad = { ...state, members: [{ ...state.members[0]!, ...change }] } as ExtensionGroupRevisionState;
    refusal(() => createExtensionGroupReview(bad, ["a"]), "state-unavailable", 503);
  }
  refusal(() => createExtensionGroupReview({ ...state, members: [state.members[0]!, state.members[0]!] }, []), "state-unavailable", 503);
});

test("a missing group can be reviewed neither as an empty group nor implicitly recreated", () => {
  refusal(() => createExtensionGroupReview({ ...baseline(), exists: false, members: [], defaults: [] }, ["b"]), "group-missing", 404);
});

test("empty target is a valid explicit clear and portable missing extension IDs remain reviewable", () => {
  const cleared = createExtensionGroupReview(baseline(), []);
  expect(cleared.extensions).toEqual([]); expect(cleared.defaultRemoved).toEqual(["a"]);
  expect(cleared.changes).toEqual([{ id: "one", name: "Custom selection", running: true, added: [], removed: ["a", "c"] }]);
  expect(createExtensionGroupReview(baseline(), ["missing-on-this-device"]).extensions).toEqual(["missing-on-this-device"]);
});

test("malformed selection/fingerprint is rejected with fixed text, never request contents", () => {
  expect(parseExtensionGroupSelection({ group: " Research ", extensions: ["a", " b ", "a"] })).toEqual({ group: "Research", extensions: ["a", "b"] });
  for (const value of [null, [], {}, { group: "", extensions: [] }, { group: "Research", extensions: "PRIVATE_INPUT" }, { group: "Research", extensions: [2] }, { group: "Research", extensions: ["bad\nPRIVATE_INPUT"] }]) refusal(() => parseExtensionGroupSelection(value), "invalid-selection", 400);
  for (const expected of [null, undefined, "", "PRIVATE_INPUT", "a".repeat(63), "A".repeat(64), 2]) refusal(() => assertExtensionGroupRevision(expected, baseline(), []), "invalid-fingerprint", 400);
  expect(validExtensionGroupFingerprint(extensionGroupExpectedFingerprint(baseline(), []))).toBe(true);
  expect(new ExtensionGroupRevisionError("invalid-selection").message).not.toContain("PRIVATE_INPUT");
});

test("returned target/change arrays are detached from caller state", () => {
  const state = baseline(), target = ["b"], review = createExtensionGroupReview(state, target);
  target.push("c"); review.extensions.push("d"); review.changes[0]!.removed.push("e");
  expect(state.members[0]!.extensions).toEqual(["a", "c"]); expect(state.defaults).toEqual(["a"]);
});
