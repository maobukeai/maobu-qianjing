import { expect, test } from "bun:test";
import { isRosterDensity, parseRosterDensity, ROSTER_DENSITY_KEY } from "./roster-density-state.ts";

test("density stores one explicit workspace value and preserves the existing default", () => {
  expect(ROSTER_DENSITY_KEY).toBe("aliasmode.roster.density");
  for (const value of ["comfortable", "compact"] as const) { expect(isRosterDensity(value)).toBe(true); expect(parseRosterDensity(value)).toBe(value); }
  for (const value of [undefined, null, "", "dense", "COMPACT", " compact", "compact ", '"compact"', 0, true, ["compact"], { density: "compact" }, "__proto__"]) {
    expect(isRosterDensity(value)).toBe(false); expect(parseRosterDensity(value)).toBe("comfortable");
  }
});
