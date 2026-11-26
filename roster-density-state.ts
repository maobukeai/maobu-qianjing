/** A workspace preference, separate from a saved view's filters and columns. */
export const ROSTER_DENSITY_KEY = "aliasmode.roster.density";
export type RosterDensity = "compact" | "standard" | "comfortable";
export const ROSTER_DENSITY_ROW_HEIGHT: Record<RosterDensity, number> = {
  compact: 36,
  standard: 44,
  comfortable: 48,
};

export function isRosterDensity(value: unknown): value is RosterDensity {
  return value === "compact" || value === "standard" || value === "comfortable";
}
/** The stored value is a plain string; older workspaces keep the existing layout. */
export function parseRosterDensity(value: unknown): RosterDensity {
  return isRosterDensity(value) ? value : "comfortable";
}
