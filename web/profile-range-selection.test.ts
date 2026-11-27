import { expect, test } from "bun:test";
import { profileGroupCollapsed, profileGroupSections } from "../src/profile-group-state.ts";
import { changeProfileRangeSelection, reconcileProfileSelectionAnchor, type ProfileRangeSelectionInput } from "./profile-range-selection.ts";

function change(overrides: Partial<ProfileRangeSelectionInput> = {}) {
  return changeProfileRangeSelection({ selected: new Set(), visibleIds: ["a", "b", "c", "d"], viewKey: "workspace-a/page-1", anchor: null, id: "b", checked: true, ...overrides });
}

test("a checkbox selects only its row and leaves unrelated selections intact", () => {
  const selected = new Set(["outside-filter", "on-another-page"]);
  const result = change({ selected });
  expect([...result.selected]).toEqual(["outside-filter", "on-another-page", "b"]);
  expect([...selected]).toEqual(["outside-filter", "on-another-page"]);
  expect(result.anchor?.id).toBe("b");
  expect(result.affectedIds).toEqual(["b"]);
  expect(result.range).toBe(false);
});

test("Shift extends the anchor in either direction and preserves selected rows outside the span", () => {
  const first = change({ selected: new Set(["a", "hidden"]), id: "b" });
  const forward = change({ ...first, id: "d", shiftKey: true });
  expect([...forward.selected]).toEqual(["a", "hidden", "b", "c", "d"]);
  expect(forward.affectedIds).toEqual(["b", "c", "d"]);
  expect(forward.anchor).toBe(first.anchor);
  const backward = change({ ...first, id: "a", shiftKey: true });
  expect(backward.affectedIds).toEqual(["a", "b"]);
  expect([...backward.selected]).toEqual(["a", "hidden", "b"]);
});

test("shortening a Shift span does not erase a previous selection", () => {
  const first = change({ id: "a" });
  const throughD = change({ ...first, id: "d", shiftKey: true });
  const throughB = change({ ...throughD, id: "b", shiftKey: true });
  expect([...throughB.selected]).toEqual(["a", "b", "c", "d"]);
  expect(throughB.selected).toBe(throughD.selected);
});

test("explicit unchecked events clear only the requested range, without toggling other choices", () => {
  const first = change({ selected: new Set(["a", "b", "c", "d", "elsewhere"]), id: "b" });
  const cleared = change({ ...first, id: "d", checked: false, shiftKey: true });
  expect([...cleared.selected]).toEqual(["a", "elsewhere"]);
  const replay = change({ ...cleared, id: "d", checked: false, shiftKey: true });
  expect(replay.selected).toBe(cleared.selected);
  expect(replay.anchor).toBe(first.anchor);
});

test("replaying the same checked event preserves identity as well as selection", () => {
  const first = change();
  const replay = change({ ...first });
  expect(replay.selected).toBe(first.selected);
  const range = change({ ...first, id: "d", shiftKey: true });
  expect(change({ ...range, id: "d", shiftKey: true }).selected).toBe(range.selected);
});

test("a manual single-row cancellation becomes the next anchor", () => {
  const first = change({ id: "a" });
  const all = change({ ...first, id: "d", shiftKey: true });
  const cancelled = change({ ...all, id: "c", checked: false });
  expect(cancelled.anchor?.id).toBe("c");
  expect([...cancelled.selected]).toEqual(["a", "b", "d"]);
  const next = change({ ...cancelled, id: "d", checked: false, shiftKey: true });
  expect(next.affectedIds).toEqual(["c", "d"]);
  expect([...next.selected]).toEqual(["a", "b"]);
});

test("keyboard Space and Shift+Space use the same explicit checked contract as pointer events", () => {
  // Native checkbox activation supplies checked; Shift comes from its key gesture.
  const space = change({ id: "b", checked: true, shiftKey: false });
  const shiftSpace = change({ ...space, id: "d", checked: true, shiftKey: true });
  expect(shiftSpace.affectedIds).toEqual(["b", "c", "d"]);
  const shiftSpaceOff = change({ ...shiftSpace, id: "d", checked: false, shiftKey: true });
  expect(shiftSpaceOff.selected.size).toBe(0);
});

test("workspace, page, filter and sort changes invalidate an otherwise visible anchor", () => {
  const first = change({ id: "a" });
  for (const viewKey of ["workspace-b/page-1", "workspace-a/page-2", "workspace-a/page-1/search", "workspace-a/page-1/sort"]) {
    const result = change({ ...first, viewKey, id: "d", shiftKey: true });
    expect(result.range).toBe(false);
    expect([...result.selected]).toEqual(["a", "d"]);
    expect(result.anchor?.id).toBe("d");
  }
});

test("leaving and returning to the same view does not resurrect its old anchor", () => {
  const first = change({ id: "a" });
  const left = reconcileProfileSelectionAnchor(first.anchor, "workspace-a/page-2", ["e", "f"]);
  const returned = reconcileProfileSelectionAnchor(left, "workspace-a/page-1", ["a", "b", "c", "d"]);
  const result = change({ selected: first.selected, anchor: returned, id: "d", shiftKey: true });
  expect(result.range).toBe(false);
  expect([...result.selected]).toEqual(["a", "d"]);
});

test("reordering or collapsing rows invalidates the anchor even when its row remains", () => {
  const first = change({ id: "a" });
  for (const visibleIds of [["d", "c", "b", "a"], ["a", "c", "d"], ["a", "b", "c", "d", "new"]]) {
    const result = change({ ...first, visibleIds, id: "d", shiftKey: true });
    expect(result.range).toBe(false);
    expect(result.affectedIds).toEqual(["d"]);
  }
});

test("an event queued by a now-hidden row cannot select it or affect the current page", () => {
  const first = change({ id: "a" });
  const result = change({ ...first, visibleIds: ["b", "c", "d"], id: "a", shiftKey: true });
  expect(result.selected).toBe(first.selected);
  expect(result.affectedIds).toEqual([]);
  expect(result.anchor).toBeNull();
});

test("grouped pages use their rendered order and exclude collapsed and off-page rows", () => {
  const profile = (id: string, group: string) => ({ id, group, running: false });
  const page = [profile("a2", "A"), profile("b1", "B"), profile("a1", "A"), profile("c1", "C")];
  const sections = profileGroupSections(page, [...page, profile("off-page", "A")], ["B", "A", "C"]);
  const visibleIds = sections.flatMap(section => profileGroupCollapsed(section, new Map(), false) ? [] : section.profiles.map(row => row.id));
  expect(visibleIds).toEqual(["b1", "a2", "a1"]);
  const first = change({ visibleIds, id: "b1", selected: new Set(["already-hidden"]) });
  const result = change({ ...first, visibleIds, id: "a1", shiftKey: true });
  expect(result.affectedIds).toEqual(["b1", "a2", "a1"]);
  expect([...result.selected]).toEqual(["already-hidden", "b1", "a2", "a1"]);
});

test("the anchor owns a snapshot and duplicate visible IDs cannot expand its selection", () => {
  const visibleIds = ["a", "b", "b", "c"];
  const first = change({ visibleIds, id: "a" });
  visibleIds[0] = "unrelated";
  expect(first.anchor?.visibleIds).toEqual(["a", "b", "c"]);
  const range = change({ ...first, visibleIds: ["a", "b", "b", "c"], id: "c", shiftKey: true });
  expect(range.affectedIds).toEqual(["a", "b", "c"]);
  expect([...range.selected]).toEqual(["a", "b", "c"]);
});
