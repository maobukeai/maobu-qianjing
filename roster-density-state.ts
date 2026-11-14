/** A workspace preference, separate from a saved view's filters and columns. */
export const ROSTER_DENSITY_KEY = "aliasmode.roster.density";
export type RosterDensity = "comfortable" | "compact";

export function isRosterDensity(value: unknown): value is RosterDensity {
  return value === "comfortable" || value === "compact";
}
/** The stored value is a plain string; older workspaces keep the existing layout. */
export function parseRosterDensity(value: unknown): RosterDensity {
  return isRosterDensity(value) ? value : "comfortable";
}
