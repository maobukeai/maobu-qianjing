export const GROUP_DISCLOSURE_KEY = "aliasmode.roster.groupDisclosure";
const MAX_ENTRIES = 96;
const MAX_JSON_LENGTH = 4096;

export type GroupDisclosure = Map<string, boolean>;
export type GroupProfile = { id: string; group: string; running: boolean };
export type ProfileGroupSection<T extends GroupProfile> = {
  name: string;
  orderIndex: number;
  profiles: T[];
  matches: T[];
  running: number;
};
type ProfileGroupMatch<T extends GroupProfile> = Pick<ProfileGroupSection<T>, "matches" | "orderIndex" | "running">;

function parseDisclosure(value: unknown): GroupDisclosure | null {
  if (typeof value !== "string" || value.length > MAX_JSON_LENGTH) return null;
  try {
    const entries: unknown = JSON.parse(value);
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return null;
    const result = new Map<string, boolean>();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 256 || typeof entry[1] !== "boolean" || result.has(entry[0])) return null;
      result.set(entry[0], entry[1]);
    }
    return result;
  } catch { return null; }
}

export function isGroupDisclosureValue(value: unknown): boolean {
  return parseDisclosure(value) !== null;
}

export function readGroupDisclosure(value: unknown): GroupDisclosure {
  return parseDisclosure(value) ?? new Map();
}

/** Retain the most recently changed preferences within the workspace storage limit. */
export function serializeGroupDisclosure(value: GroupDisclosure): string {
  const entries = [...value].filter(([name, collapsed]) => typeof name === "string" && name.length <= 256 && typeof collapsed === "boolean").slice(-MAX_ENTRIES);
  while (JSON.stringify(entries).length > MAX_JSON_LENGTH) entries.shift();
  return JSON.stringify(entries);
}

/** Index the full filtered set once so counts and group selection survive page changes. */
export function indexProfileGroups<T extends GroupProfile>(matches: readonly T[], groupOrder: readonly string[]): Map<string, ProfileGroupMatch<T>> {
  const index = new Map<string, ProfileGroupMatch<T>>();
  for (const name of groupOrder) {
    if (!index.has(name)) index.set(name, { orderIndex: index.size, matches: [], running: 0 });
  }
  for (const profile of matches) {
    let group = index.get(profile.group);
    if (!group) {
      group = { orderIndex: index.size, matches: [], running: 0 };
      index.set(profile.group, group);
    }
    group.matches.push(profile);
    if (profile.running) group.running++;
  }
  return index;
}

export function pageProfileGroupSections<T extends GroupProfile>(page: readonly T[], index: ReadonlyMap<string, ProfileGroupMatch<T>>, includeEmpty = false): ProfileGroupSection<T>[] {
  const sections = new Map<string, ProfileGroupSection<T>>();
  let nextOrderIndex = index.size;
  for (const profile of page) {
    let section = sections.get(profile.group);
    if (!section) {
      const group = index.get(profile.group) ?? { orderIndex: nextOrderIndex++, matches: [], running: 0 };
      section = { name: profile.group, profiles: [], ...group };
      sections.set(profile.group, section);
    }
    section.profiles.push(profile);
  }
  if (includeEmpty) {
    for (const [name, group] of index) {
      if (!sections.has(name) && !group.matches.length) sections.set(name, { name, profiles: [], ...group });
    }
  }
  return [...sections.values()].sort((left, right) => left.orderIndex - right.orderIndex);
}

export function profileGroupSections<T extends GroupProfile>(page: readonly T[], matches: readonly T[], groupOrder: readonly string[], includeEmpty = false): ProfileGroupSection<T>[] {
  return pageProfileGroupSections(page, indexProfileGroups(matches, groupOrder), includeEmpty);
}

export function profileGroupCollapsed(section: Pick<ProfileGroupSection<GroupProfile>, "name" | "orderIndex">, disclosure: GroupDisclosure, revealMatches: boolean): boolean {
  if (revealMatches) return false;
  return disclosure.get(section.name) ?? section.orderIndex >= 2;
}

/** Preserve unrelated selections when selecting or clearing one group/page. */
export function toggleProfileSelection<T extends { id: string }>(selected: ReadonlySet<string>, profiles: readonly T[]): Set<string> {
  const next = new Set(selected);
  const remove = profiles.length > 0 && profiles.every(profile => selected.has(profile.id));
  for (const profile of profiles) remove ? next.delete(profile.id) : next.add(profile.id);
  return next;
}
