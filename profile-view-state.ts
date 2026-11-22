import { isSafeProfileId } from "./profile-id.ts";

export const FAVORITE_PROFILES_KEY = "aliasmode.roster.favorites";
export const SAVED_PROFILE_VIEWS_KEY = "aliasmode.roster.savedViews";
export const MAX_FAVORITES = 100;
export const MAX_SAVED_VIEWS = 12;
export const RECENT_LAUNCH_DAYS = 7;
const MAX_JSON_LENGTH = 4096;
const COLUMNS = ["no", "name", "group", "platform", "tags", "proxy", "status", "action"] as const;
export type RosterScope = "all" | "favorites" | "recent" | "attention";
export interface ProfileViewFilters {
  scope: RosterScope;
  query: string;
  group: string;
  status: "all" | "running" | "stopped";
  sort: { key: typeof COLUMNS[number]; dir: 1 | -1 };
  hiddenColumns: Array<typeof COLUMNS[number]>;
  pageSize: number;
}
export interface SavedProfileView { id: string; name: string; filters: ProfileViewFilters }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number, empty = true): value is string { return typeof value === "string" && value.length <= max && (empty || !!value) && !/[\x00-\x1f\x7f]/.test(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function parsed(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_JSON_LENGTH) return null;
  try { return JSON.parse(value); } catch { return null; }
}
export function parseFavoriteProfiles(value: unknown): string[] | null {
  const list = parsed(value);
  if (!Array.isArray(list) || list.length > MAX_FAVORITES || !list.every(isSafeProfileId) || new Set(list).size !== list.length) return null;
  return [...list];
}
export function validProfileViewFilters(value: unknown): value is ProfileViewFilters {
  if (!object(value) || !keys(value, ["scope", "query", "group", "status", "sort", "hiddenColumns", "pageSize"])) return false;
  return typeof value.scope === "string" && ["all", "favorites", "recent", "attention"].includes(value.scope) && text(value.query, 256) && text(value.group, 256)
    && typeof value.status === "string" && ["all", "running", "stopped"].includes(value.status) && object(value.sort) && keys(value.sort, ["key", "dir"])
    && COLUMNS.includes(value.sort.key as any) && (value.sort.dir === 1 || value.sort.dir === -1)
    && Array.isArray(value.hiddenColumns) && value.hiddenColumns.length <= COLUMNS.length
    && value.hiddenColumns.every(key => COLUMNS.includes(key)) && new Set(value.hiddenColumns).size === value.hiddenColumns.length
    && [20, 25, 50, 100, 200, 0].includes(value.pageSize as number);
}
export function parseSavedProfileViews(value: unknown): SavedProfileView[] | null {
  const list = parsed(value);
  if (!Array.isArray(list) || list.length > MAX_SAVED_VIEWS) return null;
  const ids = new Set<string>(), names = new Set<string>();
  for (const item of list) {
    if (!object(item) || !keys(item, ["id", "name", "filters"]) || typeof item.id !== "string" || !/^view_[a-f0-9]{32}$/.test(item.id)
      || !text(item.name, 80, false) || Array.from(item.name).length > 40 || item.name !== item.name.trim().normalize("NFC") || ids.has(item.id)
      || names.has(item.name.toLowerCase()) || !validProfileViewFilters(item.filters)) return null;
    ids.add(item.id); names.add(item.name.toLowerCase());
  }
  return list as SavedProfileView[];
}
export function serializeFavoriteProfiles(ids: readonly string[]): string {
  const value = JSON.stringify(ids);
  if (!parseFavoriteProfiles(value)) throw new Error("Your favorites list is full. Remove a favorite before adding another.");
  return value;
}
export function serializeSavedProfileViews(views: readonly SavedProfileView[]): string {
  const value = JSON.stringify(views);
  if (!parseSavedProfileViews(value)) throw new Error("This view could not be saved. Use a unique name, shorter filters, or remove an unused view.");
  return value;
}
export function sameProfileView(a: ProfileViewFilters, b: ProfileViewFilters): boolean {
  return a.scope === b.scope && a.query === b.query && a.group === b.group && a.status === b.status
    && a.sort.key === b.sort.key && a.sort.dir === b.sort.dir && a.pageSize === b.pageSize
    && a.hiddenColumns.length === b.hiddenColumns.length && a.hiddenColumns.every(column => b.hiddenColumns.includes(column));
}
export interface ScopeProfile { id: string; lastOpenAt?: number; proxyError?: string; restartPending?: boolean; mobilePersona?: boolean }
export function profileNeedsAttention(profile: ScopeProfile): boolean { return !!(profile.proxyError || profile.restartPending || profile.mobilePersona); }
export function inProfileScope(profile: ScopeProfile, scope: RosterScope, favorites: ReadonlySet<string>, now = Date.now()): boolean {
  if (scope === "favorites") return favorites.has(profile.id);
  if (scope === "attention") return profileNeedsAttention(profile);
  if (scope === "recent") return typeof profile.lastOpenAt === "number" && Number.isFinite(profile.lastOpenAt)
    && profile.lastOpenAt > now - RECENT_LAUNCH_DAYS * 86_400_000 && profile.lastOpenAt <= now + 60_000;
  return true;
}
