import { expect, test } from "bun:test";
import { isRosterDensity, parseRosterDensity, ROSTER_DENSITY_KEY, ROSTER_DENSITY_ROW_HEIGHT } from "./roster-density-state.ts";

test("density stores one explicit workspace value and preserves the existing default", () => {
  expect(ROSTER_DENSITY_KEY).toBe("aliasmode.roster.density");
  expect(ROSTER_DENSITY_ROW_HEIGHT).toEqual({ compact: 44, standard: 48, comfortable: 52 });
  for (const value of ["comfortable", "standard", "compact"] as const) {
    expect(isRosterDensity(value)).toBe(true);
    expect(parseRosterDensity(value)).toBe(value);
  }
  for (const value of [undefined, null, "", "dense", "STANDARD", "COMPACT", " compact", "compact ", '"compact"', 0, true, ["compact"], { density: "compact" }, "__proto__"]) {
    expect(isRosterDensity(value)).toBe(false); expect(parseRosterDensity(value)).toBe("comfortable");
  }
});
