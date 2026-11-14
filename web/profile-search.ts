import type { UiProfile } from "./api.ts";

export type CommandPaletteProfile = Pick<UiProfile, "id" | "name" | "group" | "tags" | "running" | "lastOpenAt">;
export const PROFILE_SEARCH_RENDER_LIMIT = 50;
interface ProfileSearchEntry {
  readonly profile: CommandPaletteProfile;
  readonly name: string;
  readonly id: string;
  readonly search: string;
}
export type ProfileSearchIndex = readonly ProfileSearchEntry[];
export interface ProfileSearchResult { readonly items: readonly CommandPaletteProfile[]; readonly total: number; readonly limited: boolean }
function normalize(value: string): string {
  const folded = /[^\x00-\x7f]/.test(value) ? value.normalize("NFKD").replace(/\p{M}/gu, "") : value;
  return folded.toLowerCase().replace(/\s+/g, " ").trim();
}

/** One public-metadata index per roster revision. Caller objects and private extra fields are not retained. */
export function createProfileSearchIndex(profiles: readonly CommandPaletteProfile[]): ProfileSearchIndex {
  const seen = new Set<string>(), entries: ProfileSearchEntry[] = [];
  for (const source of profiles) {
    if (typeof source.id !== "string" || !source.id || seen.has(source.id)) continue;
    seen.add(source.id);
    const tags = Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const profile = Object.freeze({ id: source.id, name: typeof source.name === "string" ? source.name : "", group: typeof source.group === "string" ? source.group : "", tags: Object.freeze([...tags]) as unknown as string[], running: source.running === true,
      ...(typeof source.lastOpenAt === "number" && Number.isFinite(source.lastOpenAt) ? { lastOpenAt: source.lastOpenAt } : {}) });
    const name = normalize(profile.name), id = normalize(profile.id);
    entries.push(Object.freeze({ profile, name, id, search: `${name}\0${id}\0${normalize(profile.group)}\0${tags.map(normalize).join("\0")}` }));
  }
  return Object.freeze(entries);
}

/** Scan the complete index while keeping only the best visible results, never a truncated source pool. */
export function searchProfileIndex(index: ProfileSearchIndex, query: string, options: { favoriteIds?: ReadonlySet<string>; limit?: number; now?: number } = {}): ProfileSearchResult {
  const search = normalize(query).slice(0, 500), terms = search.split(" ").filter(Boolean), now = options.now ?? Date.now();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(PROFILE_SEARCH_RENDER_LIMIT, Math.floor(options.limit!))) : PROFILE_SEARCH_RENDER_LIMIT;
  type Match = { entry: ProfileSearchEntry; score: number; favorite: boolean; recent: number };
  const matches: Match[] = []; let total = 0;
  const compare = (left: Match, right: Match): number => {
    if (terms.length && left.score !== right.score) return right.score - left.score;
    if (!terms.length) {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      if (left.recent !== right.recent) return right.recent - left.recent;
    }
    return left.entry.name < right.entry.name ? -1 : left.entry.name > right.entry.name ? 1 : left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0;
  };
  for (const entry of index) {
    if (!terms.every(term => entry.search.includes(term))) continue;
    total++;
    const opened = entry.profile.lastOpenAt ?? 0;
    const candidate: Match = { entry, favorite: options.favoriteIds?.has(entry.profile.id) ?? false, recent: opened > 0 && opened <= now + 60_000 ? opened : 0,
      score: !terms.length ? 0 : (entry.name === search || entry.id === search ? 10_000 : entry.name.startsWith(search) || entry.id.startsWith(search) ? 5000 : 0)
        + terms.reduce((score, term) => score + (entry.name.startsWith(term) ? 100 : entry.name.includes(term) ? 80 : entry.id.includes(term) ? 60 : 1), 0) };
    if (matches.length === limit && compare(candidate, matches[matches.length - 1]!) >= 0) continue;
    let low = 0, high = matches.length;
    while (low < high) { const middle = (low + high) >>> 1; if (compare(candidate, matches[middle]!) < 0) high = middle; else low = middle + 1; }
    matches.splice(low, 0, candidate); if (matches.length > limit) matches.pop();
  }
  return { items: matches.map(match => match.entry.profile), total, limited: total > matches.length };
}
