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

/** Group only this page's rows; counts and group selection retain the full filter scope. */
export function profileGroupSections<T extends GroupProfile>(page: readonly T[], matches: readonly T[], groupOrder: readonly string[], includeEmpty = false): ProfileGroupSection<T>[] {
  const order = [...new Set([...groupOrder, ...matches.map(profile => profile.group), ...page.map(profile => profile.group)])];
  const pageGroups = new Map<string, T[]>(), matchGroups = new Map<string, T[]>();
  for (const profile of page) { const rows = pageGroups.get(profile.group) ?? []; rows.push(profile); pageGroups.set(profile.group, rows); }
  for (const profile of matches) { const rows = matchGroups.get(profile.group) ?? []; rows.push(profile); matchGroups.set(profile.group, rows); }
  return order.flatMap((name, orderIndex) => {
    const profiles = pageGroups.get(name) ?? [], groupMatches = matchGroups.get(name) ?? [];
    if (!profiles.length && !(includeEmpty && !groupMatches.length)) return [];
    return [{ name, orderIndex, profiles, matches: groupMatches, running: groupMatches.filter(profile => profile.running).length }];
  });
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
