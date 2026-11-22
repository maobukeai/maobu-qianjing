import { useDeferredValue, useMemo } from "react";
import { folderScope, folderTree, type FolderInfo } from "../../folders.ts";
import { profileGroupCollapsed, profileGroupSections, type GroupDisclosure, type ProfileGroupSection } from "../../profile-group-state.ts";
import { inProfileScope, type RosterScope } from "../../profile-view-state.ts";
import { ROSTER_DENSITY_ROW_HEIGHT, type RosterDensity } from "../../roster-density-state.ts";
import type { UiProfile } from "../api.ts";

export const PROFILE_PAGE_SIZE = 20;
/** `0` selects all matching environments rendered via virtual scrolling. */
export const PAGE_SIZES = [20, 25, 50, 100, 200, 0];

/**
 * Roster columns. `width` is the single source of truth: each column is laid out
 * at exactly that width and the table's min-width is their sum, so a column can
 * never be squeezed below a readable size — the roster scrolls sideways instead.
 * Only the checkbox column is fixed; everything else can be hidden.
 */
export const COLUMNS = [
  { key: "no", label: "No.", sort: true, width: 52 },
  { key: "name", label: "Name", sort: true, width: 200 },
  { key: "group", label: "Group", sort: true, width: 100 },
  { key: "platform", label: "Platform", sort: true, width: 128 },
  { key: "tags", label: "Tags", sort: false, width: 140 },
  { key: "proxy", label: "Proxy", sort: true, width: 150 },
  { key: "status", label: "Status", sort: false, width: 90 },
  /* The launch action stays visible; the labeled menu holds secondary actions. */
  { key: "action", label: "Action", sort: false, width: 164 },
] as const;

/** Width of the always-present select-all checkbox column. */
export const CHECKBOX_COLUMN_WIDTH = 36;
export type ColumnKey = (typeof COLUMNS)[number]["key"];
export type SortKey = ColumnKey | "status";

export const HIDDEN_COLUMNS_KEY = "aliasmode.roster.hiddenColumns";
export const PAGE_SIZE_KEY = "aliasmode.roster.pageSize";
/** Keep the everyday view focused; optional columns stay in the column picker. */
export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["no", "group", "platform", "tags"];

/** Roster layout preferences are a convenience: a hostile/empty store must not break the view. */
export function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (stored === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
    const raw = JSON.parse(stored);
    const known = new Set(COLUMNS.map((column) => column.key as string));
    return new Set((Array.isArray(raw) ? raw : []).filter((key) => known.has(key)) as ColumnKey[]);
  } catch {
    return new Set(DEFAULT_HIDDEN_COLUMNS);
  }
}

export function readPageSize(): number {
  try {
    const raw = localStorage.getItem(PAGE_SIZE_KEY);
    if (raw === null || raw.trim() === "") return PROFILE_PAGE_SIZE;
    const stored = Number(raw);
    return PAGE_SIZES.includes(stored) ? stored : PROFILE_PAGE_SIZE;
  } catch {
    return PROFILE_PAGE_SIZE;
  }
}

/**
 * The number an operator sees for a profile: their custom NO. when set, else the
 * store serial, else the row's position. Mirrors profileDisplayNo in launcher.ts
 * so the roster, the browser window title and the identity bookmark agree.
 */
export function displayNo(profile: Pick<UiProfile, "customNo" | "serial">, fallbackIndex: number): { value: string; custom: boolean } {
  const custom = (profile.customNo ?? "").trim();
  if (custom) return { value: custom, custom: true };
  if (profile.serial != null) return { value: String(profile.serial), custom: false };
  return { value: String(fallbackIndex + 1), custom: false };
}

export type FlatRosterItem =
  | { kind: "group-header"; key: string; section: ProfileGroupSection<UiProfile>; collapsed: boolean }
  | { kind: "profile"; key: string; profile: UiProfile; sectionName: string; rowIndex: number }
  | { kind: "launch-failure"; key: string; profile: UiProfile; message: string };

const GROUP_HEADER_HEIGHT: Record<RosterDensity, number> = {
  compact: 36,
  standard: 40,
  comfortable: 44,
};
const LAUNCH_FAILURE_ROW_HEIGHT = 68;

export function estimateFlatRosterItemHeight(item: FlatRosterItem, density: RosterDensity): number {
  if (item.kind === "group-header") return GROUP_HEADER_HEIGHT[density];
  if (item.kind === "launch-failure") return LAUNCH_FAILURE_ROW_HEIGHT;
  const base = ROSTER_DENSITY_ROW_HEIGHT[density];
  const extra = (item.profile.tags.length > 0 || item.profile.restartPending || !!item.profile.pendingCookieCount) ? 22 : 0;
  return base + extra;
}

export function buildSearchIndex(
  profiles: readonly Pick<UiProfile, "id" | "name" | "proxy" | "group" | "tags">[],
  numbering: ReadonlyMap<string, { value: string }>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]!;
    const no = (numbering.get(p.id)?.value ?? "").toLowerCase();
    const tags = p.tags && p.tags.length > 0 ? p.tags.join("\0").toLowerCase() : "";
    index.set(
      p.id,
      `${p.id.toLowerCase()}\0${p.name.toLowerCase()}\0${no}\0${(p.proxy ?? "").toLowerCase()}\0${p.group.toLowerCase()}\0${tags}`,
    );
  }
  return index;
}

export type RosterSort = { key: SortKey; dir: 1 | -1 };

export interface RosterPipelineProfile {
  id: string;
  name: string;
  group: string;
  running: boolean;
  proxy?: string | null;
  tags?: string[];
  platform?: string;
  lastOpenAt?: number;
  proxyError?: string;
  restartPending?: boolean;
  mobilePersona?: boolean;
}

export function sortRosterField(
  p: RosterPipelineProfile,
  key: SortKey,
  numbering: ReadonlyMap<string, { value: string }>,
): string | number {
  switch (key) {
    case "no": return Number(numbering.get(p.id)?.value ?? 0);
    case "name": return p.name.toLowerCase();
    case "group": return p.group.toLowerCase();
    case "platform": return (p.platform ?? "").toLowerCase();
    case "proxy": return (p.proxy ?? "").toLowerCase();
    case "status": return p.running ? 0 : 1;
    default: return 0;
  }
}

export function paginateRoster<T>(filtered: readonly T[], pageSize: number, profilePage: number): {
  profilePageCount: number;
  visibleProfilePage: number;
  visibleProfiles: T[];
} {
  if (pageSize === 0) {
    return {
      profilePageCount: 1,
      visibleProfilePage: 0,
      visibleProfiles: filtered as T[],
    };
  }
  const safeSize = pageSize > 0 ? pageSize : PROFILE_PAGE_SIZE;
  const profilePageCount = Math.max(1, Math.ceil(filtered.length / safeSize));
  const visibleProfilePage = Math.min(Math.max(0, profilePage), profilePageCount - 1);
  const visibleProfiles = filtered.slice(visibleProfilePage * safeSize, (visibleProfilePage + 1) * safeSize);
  return { profilePageCount, visibleProfilePage, visibleProfiles };
}

export function computeRosterPipeline<T extends RosterPipelineProfile>(options: {
  profiles: readonly T[];
  numbering: ReadonlyMap<string, { value: string }>;
  searchIndex?: ReadonlyMap<string, string>;
  q: string;
  group: string;
  selectedScope: ReadonlySet<string>;
  profileStatus: "all" | "running" | "stopped";
  sort: RosterSort;
  pageSize: number;
  profilePage: number;
  rosterScope: RosterScope;
  favoriteProfileIds: ReadonlySet<string>;
}): {
  matchingProfiles: T[];
  matchingRunningCount: number;
  filtered: T[];
  profilePageCount: number;
  visibleProfilePage: number;
  visibleProfiles: T[];
} {
  const {
    profiles,
    numbering,
    searchIndex,
    q,
    group,
    selectedScope,
    profileStatus,
    sort,
    pageSize,
    profilePage,
    rosterScope,
    favoriteProfileIds,
  } = options;
  const trimmedQ = q.trim();
  const exactId = trimmedQ ? /^id:(\S+)$/.exec(trimmedQ) : null;
  const needle = trimmedQ && !exactId ? trimmedQ.toLowerCase() : "";

  const matchingProfiles: T[] = [];
  let matchingRunningCount = 0;

  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]!;
    if (!inProfileScope(p, rosterScope, favoriteProfileIds)) continue;
    if (group !== "all" && !selectedScope.has(p.group)) continue;
    if (exactId) {
      if (p.id !== exactId[1]) continue;
    } else if (needle) {
      const indexed = searchIndex?.get(p.id);
      if (indexed !== undefined) {
        if (!indexed.includes(needle)) continue;
      } else {
        const no = numbering.get(p.id)?.value ?? "";
        if (
          !p.id.toLowerCase().includes(needle) &&
          !p.name.toLowerCase().includes(needle) &&
          !no.includes(needle) &&
          !(p.proxy ?? "").toLowerCase().includes(needle) &&
          !p.group.toLowerCase().includes(needle) &&
          !(p.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
        ) continue;
      }
    }
    matchingProfiles.push(p);
    if (p.running) matchingRunningCount++;
  }

  const matched =
    profileStatus === "all"
      ? matchingProfiles.slice()
      : matchingProfiles.filter((profile) => (profileStatus === "running" ? profile.running : !profile.running));

  // Running profiles stay on top regardless of the chosen column: an open
  // browser is the row an operator acts on next.
  matched.sort((a, b) => {
    if (rosterScope === "recent" && a.lastOpenAt !== b.lastOpenAt) return (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0);
    if (a.running !== b.running) return a.running ? -1 : 1;
    const left = sortRosterField(a, sort.key, numbering);
    const right = sortRosterField(b, sort.key, numbering);
    if (left < right) return -sort.dir;
    if (left > right) return sort.dir;
    return a.id.localeCompare(b.id);
  });

  const pagination = paginateRoster(matched, pageSize, profilePage);
  return {
    matchingProfiles,
    matchingRunningCount,
    filtered: matched,
    ...pagination,
  };
}

export function buildFlatRosterItems(
  profileSections: readonly ProfileGroupSection<UiProfile>[],
  groupDisclosure: GroupDisclosure,
  revealGroupMatches: boolean,
  rosterScope: RosterScope,
  launchFailures: ReadonlyMap<string, string> | null,
): FlatRosterItem[] {
  const flat: FlatRosterItem[] = [];
  let rowIndex = 0;
  for (let s = 0; s < profileSections.length; s++) {
    const section = profileSections[s]!;
    const collapsed = profileGroupCollapsed(section, groupDisclosure, revealGroupMatches);
    if (rosterScope !== "recent") {
      flat.push({
        kind: "group-header",
        key: `group:${section.name}`,
        section,
        collapsed,
      });
    }
    if (!collapsed) {
      for (let i = 0; i < section.profiles.length; i++) {
        const profile = section.profiles[i]!;
        flat.push({
          kind: "profile",
          key: `profile:${profile.id}`,
          profile,
          sectionName: section.name,
          rowIndex: rowIndex++,
        });
        const failure = profile.running ? undefined : launchFailures?.get(profile.id);
        if (failure) {
          flat.push({
            kind: "launch-failure",
            key: `failure:${profile.id}`,
            profile,
            message: failure,
          });
        }
      }
    }
  }
  return flat;
}

export interface UseRosterQueryOptions {
  profiles: UiProfile[];
  registeredGroups: string[];
  localFolders: FolderInfo[];
  loaded: boolean;
  q: string;
  group: string;
  profileStatus: "all" | "running" | "stopped";
  sort: RosterSort;
  pageSize: number;
  profilePage: number;
  rosterScope: RosterScope;
  favoriteProfileIds: ReadonlySet<string>;
  groupDisclosure: GroupDisclosure;
  launchFailures: ReadonlyMap<string, string> | null;
}

export function useRosterQuery({
  profiles,
  registeredGroups,
  localFolders,
  loaded,
  q,
  group,
  profileStatus,
  sort,
  pageSize,
  profilePage,
  rosterScope,
  favoriteProfileIds,
  groupDisclosure,
  launchFailures,
}: UseRosterQueryOptions) {
  const deferredQ = useDeferredValue(q);

  const folders = useMemo<FolderInfo[]>(() => {
    const metadata = new Map(localFolders.map((folder) => [folder.name, folder]));
    return [...new Set([...registeredGroups, ...profiles.map((profile) => profile.group).filter(Boolean)])]
      .map((name) => metadata.get(name) ?? { name });
  }, [localFolders, registeredGroups, profiles]);

  const tree = useMemo(() => folderTree(folders), [folders]);
  const folderLabels = useMemo(() => new Map(folders.map((folder) => [folder.name, folder.label ?? folder.name])), [folders]);
  const groups = useMemo(() => ["all", ...tree.map((folder) => folder.name)], [tree]);
  const existingGroups = useMemo(() => groups.slice(1), [groups]);
  const missingRosterGroup = loaded && group !== "all" && group !== "" && !groups.includes(group) ? group : null;
  const hasRosterRefinements = !!q.trim() || group !== "all" || profileStatus !== "all";
  const selectedScope = useMemo(() => (group === "" ? new Set([""]) : folderScope(folders, group)), [folders, group]);
  const breadcrumb = useMemo(() => tree.find((folder) => folder.name === group), [tree, group]);

  /**
   * Every profile's visible "No.", resolved once against the unsorted roster so
   * sorting or paging can never renumber a row underneath the operator.
   */
  const numbering = useMemo(() => {
    const map = new Map<string, { value: string; custom: boolean }>();
    profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));
    return map;
  }, [profiles]);

  /** Precomputed lowercased search strings; rebuilt only when profiles change. */
  const searchIndex = useMemo(() => buildSearchIndex(profiles, numbering), [profiles, numbering]);

  const {
    matchingProfiles,
    matchingRunningCount,
    filtered,
    profilePageCount,
    visibleProfilePage,
    visibleProfiles,
  } = useMemo(
    () =>
      computeRosterPipeline({
        profiles,
        numbering,
        searchIndex,
        q: deferredQ,
        group,
        selectedScope,
        profileStatus,
        sort,
        pageSize,
        profilePage,
        rosterScope,
        favoriteProfileIds,
      }),
    [profiles, numbering, searchIndex, deferredQ, group, selectedScope, profileStatus, sort, pageSize, profilePage, rosterScope, favoriteProfileIds],
  );

  const revealGroupMatches = !!deferredQ.trim() || profileStatus !== "all" || group !== "all" || rosterScope !== "all";

  const profileSections = useMemo(
    () =>
      rosterScope === "recent"
        ? [{ name: "", orderIndex: 0, profiles: visibleProfiles, matches: filtered, running: filtered.filter((profile) => profile.running).length }]
        : profileGroupSections(
            visibleProfiles,
            filtered,
            tree.filter((folder) => group === "all" || selectedScope.has(folder.name)).map((folder) => folder.name),
            visibleProfilePage === 0 && !deferredQ.trim() && profileStatus === "all" && rosterScope === "all",
          ),
    [visibleProfiles, filtered, tree, group, selectedScope, visibleProfilePage, deferredQ, profileStatus, rosterScope],
  );

  const selectableProfiles = useMemo(
    () => profileSections.flatMap((section) => (profileGroupCollapsed(section, groupDisclosure, revealGroupMatches) ? [] : section.profiles)),
    [profileSections, groupDisclosure, revealGroupMatches],
  );

  const rangeVisibleIds = useMemo(() => selectableProfiles.map((profile) => profile.id), [selectableProfiles]);

  const flatItems = useMemo(
    () => buildFlatRosterItems(profileSections, groupDisclosure, revealGroupMatches, rosterScope, launchFailures),
    [profileSections, groupDisclosure, revealGroupMatches, rosterScope, launchFailures],
  );

  const rosterViewCounts = useMemo(() => {
    let favorites = 0;
    let recent = 0;
    let attention = 0;
    for (const profile of profiles) {
      if (favoriteProfileIds.has(profile.id)) favorites += 1;
      if (inProfileScope(profile, "recent", favoriteProfileIds)) recent += 1;
      if (inProfileScope(profile, "attention", favoriteProfileIds)) attention += 1;
    }
    return { all: profiles.length, favorites, recent, attention };
  }, [profiles, favoriteProfileIds]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const byName = new Map(tree.map((folder) => [folder.name, folder]));
    for (const profile of profiles) {
      for (const name of [profile.group, ...(byName.get(profile.group)?.ancestors ?? [])]) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }, [tree, profiles]);

  return {
    deferredQ,
    folders,
    tree,
    folderLabels,
    groups,
    existingGroups,
    missingRosterGroup,
    hasRosterRefinements,
    selectedScope,
    breadcrumb,
    numbering,
    matchingProfiles,
    matchingRunningCount,
    filtered,
    profilePageCount,
    visibleProfilePage,
    visibleProfiles,
    revealGroupMatches,
    profileSections,
    selectableProfiles,
    rangeVisibleIds,
    flatItems,
    rosterViewCounts,
    folderCounts,
  };
}
