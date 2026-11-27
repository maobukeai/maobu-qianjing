import { expect, test } from "bun:test";
import { isGroupDisclosureValue, profileGroupCollapsed, profileGroupSections, readGroupDisclosure, serializeGroupDisclosure, toggleProfileSelection } from "../profile-group-state.ts";

const profiles = Array.from({ length: 45 }, (_, index) => ({ id: `p-${index}`, group: index < 25 ? "Parent / A" : "B", running: index % 4 === 0 }));

test("group headers retain whole-filter counts while rows stay inside their page", () => {
  const sections = profileGroupSections(profiles.slice(20, 40), profiles, ["Parent / A", "B", "Empty"], false);
  expect(sections.map(section => [section.name, section.profiles.length, section.matches.length])).toEqual([["Parent / A", 5, 25], ["B", 15, 20]]);
  expect(sections.flatMap(section => section.profiles).map(profile => profile.id)).toEqual(profiles.slice(20, 40).map(profile => profile.id));
  expect(new Set(sections.flatMap(section => section.profiles).map(profile => profile.id)).size).toBe(20);
  expect(profileGroupSections(profiles.slice(0, 20), profiles, ["Parent / A", "B", "Empty"], true).map(section => section.name)).toEqual(["Parent / A", "Empty"]);
});

test("search and status scopes always reveal matching rows without changing the saved collapse choice", () => {
  const disclosure = new Map([["B", true]]);
  const section = { name: "B", orderIndex: 1 };
  expect(profileGroupCollapsed(section, disclosure, false)).toBe(true);
  expect(profileGroupCollapsed(section, disclosure, true)).toBe(false);
  expect(disclosure.get("B")).toBe(true);
  expect(profileGroupCollapsed({ name: "Other", orderIndex: 2 }, new Map(), false)).toBe(true);
  expect(profileGroupCollapsed({ name: "Other", orderIndex: 2 }, new Map([["Other", false]]), false)).toBe(false);
});

test("visible-row selection excludes folded rows; whole-group selection includes later pages", () => {
  const sections = profileGroupSections(profiles.slice(20, 40), profiles, ["Parent / A", "B"]);
  const disclosure = new Map([["B", true]]);
  const visible = sections.flatMap(section => profileGroupCollapsed(section, disclosure, false) ? [] : section.profiles);
  const selected = toggleProfileSelection(new Set(["unrelated"]), visible);
  expect([...selected]).toEqual(["unrelated", ...profiles.slice(20, 25).map(profile => profile.id)]);
  const groupSelection = toggleProfileSelection(selected, sections[1]!.matches);
  expect(groupSelection.size).toBe(26);
  expect(groupSelection.has("p-44")).toBe(true);
  expect([...toggleProfileSelection(groupSelection, sections[1]!.matches)]).toEqual([...selected]);
});

test("group display preferences reject malformed stores and round-trip unusual group names safely", () => {
  for (const raw of [null, "{}", '[["A",1]]', '[["A",true],["A",false]]', "not JSON"]) expect(isGroupDisclosureValue(raw)).toBe(false);
  const preferences = new Map([["__proto__", true], ["", false], ["组名 / 二级", false]]);
  expect([...readGroupDisclosure(serializeGroupDisclosure(preferences))]).toEqual([...preferences]);
  expect([...readGroupDisclosure("broken")]).toEqual([]);
  const many = new Map(Array.from({ length: 150 }, (_, index) => [`${index}-${"长".repeat(100)}`, index % 2 === 0]));
  const serialized = serializeGroupDisclosure(many);
  expect(serialized.length).toBeLessThanOrEqual(4096);
  expect(isGroupDisclosureValue(serialized)).toBe(true);
  expect([...readGroupDisclosure(serialized).keys()].at(-1)).toBe([...many.keys()].at(-1));
});
