import { expect, test } from "bun:test";
import { createExtensionDefaultDrafts } from "./extension-default-drafts.ts";

function fixture() { const store = createExtensionDefaultDrafts("one"); store.receive("one", [{ name: "Research", extensions: ["alpha"] }, { name: "Other", extensions: [] }]); return store; }
test("refresh preserves unsaved choices and updates only clean drafts", () => {
  const store = fixture(); store.toggle("beta");
  store.receive("one", [{ name: "Research", extensions: ["alpha"] }, { name: "Other", extensions: ["gamma"] }]);
  expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta"]); expect(store.getSnapshot().selected?.dirty).toBe(true);
  store.select("Other"); expect(store.getSnapshot().selected?.extensions).toEqual(["gamma"]); expect(store.getSnapshot().selected?.dirty).toBe(false);
  store.select("Research"); expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta"]);
});
test("an external default change keeps the dirty target until an explicit discard", () => {
  const store = fixture(); store.toggle("beta"); store.receive("one", [{ name: "Research", extensions: ["gamma"] }]);
  expect(store.getSnapshot().selected?.baseline).toEqual(["gamma"]); expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta"]);
  store.discard(); expect(store.getSnapshot().selected?.extensions).toEqual(["gamma"]); expect(store.getSnapshot().dirtyCount).toBe(0);
});
test("confirmed deletion removes exactly that ID and preserves unrelated draft choices", () => {
  const store = fixture(); store.toggle("beta"); store.select("Other"); store.toggle("alpha"); store.toggle("gamma");
  store.removeConfirmed("one", "alpha");
  expect(store.getSnapshot().selected?.extensions).toEqual(["gamma"]); store.select("Research");
  expect(store.getSnapshot().selected?.baseline).toEqual([]); expect(store.getSnapshot().selected?.extensions).toEqual(["beta"]); expect(store.getSnapshot().dirtyCount).toBe(2);
});
test("registry absence alone never removes a cross-device missing extension reference", () => {
  const store = fixture(); store.toggle("not-installed-here");
  store.receive("one", [{ name: "Research", extensions: ["alpha"] }]);
  expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "not-installed-here"]);
});
test("a removed group keeps its dirty draft disabled until explicitly discarded", () => {
  const store = fixture(); store.toggle("beta"); store.receive("one", [{ name: "Other", extensions: [] }]);
  expect(store.getSnapshot().selected?.available).toBe(false); expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta"]);
  store.toggle("gamma"); expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta"]);
  store.discard(); expect(store.getSnapshot().selectedGroup).toBe("Other"); expect(store.getSnapshot().dirtyCount).toBe(0);
});
test("a confirmed save acknowledges its frozen target without replacing later user intent", () => {
  const store = fixture(); store.toggle("beta"); const saved = [...store.getSnapshot().selected!.extensions]; store.toggle("gamma");
  store.acknowledge("one", "Research", saved);
  expect(store.getSnapshot().selected?.baseline).toEqual(["alpha", "beta"]); expect(store.getSnapshot().selected?.extensions).toEqual(["alpha", "beta", "gamma"]); expect(store.getSnapshot().selected?.dirty).toBe(true);
});
test("removing the clean selected group reveals another retained dirty group", () => {
  const store = fixture(); store.select("Other"); store.toggle("gamma"); store.select("Research"); store.receive("one", []);
  expect(store.getSnapshot().selectedGroup).toBe("Other"); expect(store.getSnapshot().selected?.extensions).toEqual(["gamma"]); expect(store.getSnapshot().selected?.available).toBe(false);
});
test("all removed dirty groups stay reachable and can be discarded one at a time", () => {
  const store = fixture(); store.toggle("beta"); store.select("Other"); store.toggle("gamma");
  store.receive("one", []); expect(store.getSnapshot().dirtyCount).toBe(2); expect(store.getSnapshot().selected?.available).toBe(false);
  store.discard(); expect(store.getSnapshot().selectedGroup).toBe("Research"); expect(store.getSnapshot().selected?.available).toBe(false); expect(store.getSnapshot().dirtyCount).toBe(1);
  store.discard(); expect(store.getSnapshot().selected).toBeNull(); expect(store.getSnapshot().dirtyCount).toBe(0);
});
test("matching confirmed save clears dirty and later clean refresh adopts remote state", () => {
  const store = fixture(); store.toggle("beta"); store.acknowledge("one", "Research", ["beta", "alpha", "beta"]);
  expect(store.getSnapshot().dirtyCount).toBe(0); store.receive("one", [{ name: "Research", extensions: ["gamma"] }]); expect(store.getSnapshot().selected?.extensions).toEqual(["gamma"]);
});
test("workspace replacement clears memory and ignores old reads, deletion and save callbacks", () => {
  const store = fixture(); store.toggle("beta"); store.setWorkspace("two");
  expect(store.receive("one", [{ name: "Research", extensions: ["secret-old-id"] }])).toBe(false);
  expect(store.removeConfirmed("one", "alpha")).toBe(false); expect(store.acknowledge("one", "Research", ["alpha"])).toBe(false);
  expect(store.getSnapshot()).toMatchObject({ workspaceId: "two", groups: [], selectedGroup: null, selected: null, dirtyCount: 0 });
  store.receive("two", [{ name: "New", extensions: [] }]); expect(store.getSnapshot().selectedGroup).toBe("New");
});
test("public snapshots copy and freeze inputs and use set semantics", () => {
  const store = createExtensionDefaultDrafts("one"), incoming = [{ name: "Group", extensions: ["beta", "alpha", "alpha"] }];
  store.receive("one", incoming); incoming[0]!.extensions.push("later"); const current = store.getSnapshot();
  expect(current.selected?.extensions).toEqual(["alpha", "beta"]); expect(Object.isFrozen(current)).toBe(true); expect(Object.isFrozen(current.selected?.extensions)).toBe(true); expect(Object.isFrozen(current.groups[0])).toBe(true);
});
