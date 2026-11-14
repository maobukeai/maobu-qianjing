import { expect, test } from "bun:test";
import { checkSignedUpdate, desktopUpdaterAvailable, fetchSignedUpdateStatus, installSignedUpdate } from "./signed-update-api.ts";

test("a source browser cannot check or install signed native updates", async () => {
  expect(desktopUpdaterAvailable()).toBe(false);
  expect(await fetchSignedUpdateStatus()).toMatchObject({ configured: false, status: "disabled", update: null, endpoint: null });
  await expect(checkSignedUpdate()).rejects.toThrow("desktop app");
  await expect(installSignedUpdate("1.0.0", () => { throw new Error("must not emit progress"); })).rejects.toThrow("desktop app");
});
