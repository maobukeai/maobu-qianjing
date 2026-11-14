import { expect, test } from "bun:test";
import { profileCreationRuntime } from "./profile-creation-runtime.ts";

test("creation preserves an explicit legacy runtime and lets Auto reach backend defaults", () => {
  expect(profileCreationRuntime("chromium", "")).toBe("cloakbrowser");
  expect(profileCreationRuntime("chromium", "aliasmode")).toBe("aliasmode");
  expect(profileCreationRuntime("chromium", "auto")).toBeUndefined();
  expect(profileCreationRuntime("chromium", "auto", "aliasmode")).toBe("aliasmode");
  expect(profileCreationRuntime("chromium", "", "aliasmode")).toBe("aliasmode");
});
test("Firefox creation never receives Chromium runtime settings", () => {
  for (const selection of ["", "aliasmode", "auto"] as const) {
    expect(profileCreationRuntime("firefox", selection, "aliasmode")).toBeUndefined();
  }
});
