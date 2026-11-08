import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as api from "./api.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("removed hosted features have no client implementation or compatibility stubs", () => {
  for (const removed of ["signInCloud", "restoreCloudSession", "fetchCloudAuth", "fetchCloudEvents", "fetchCloudTeam", "cloudWorkspaceAction", "createCloudConnector", "selectAppMode", "fetchServices", "saveServicesHidden", "fetchPublishedScripts", "fetchPublishedScript", "importPublishedScript", "publishScript", "unpublishScript", "checkFingerprint"]) expect(Object.hasOwn(api, removed)).toBe(false);
});
test("the local UI refuses an older cloud-capable runtime", async () => {
  for (const config of [{ version: 1, mode: "cloud", localOnly: false }, { version: 1, mode: "local" }, { version: 1, mode: "unconfigured", localOnly: true }]) {
    globalThis.fetch = (async () => Response.json(config)) as unknown as typeof fetch;
    await expect(api.fetchAppMode()).rejects.toThrow("local-only runtime");
  }
  globalThis.fetch = (async () => Response.json({ version: 1, mode: "local", localOnly: true, localAnalytics: false })) as unknown as typeof fetch;
  expect((await api.fetchAppMode()).mode).toBe("local");
});
test("the shipped browser bundle has no original cloud, promotion, or updater endpoints", async () => {
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./app.tsx", import.meta.url))], target: "browser", minify: true });
  expect(build.success).toBe(true);
  const bundled = (await Promise.all(build.outputs.map(output => output.text()))).join("\n");
  for (const removed of ["https://cloud.aliasmode.com", "https://aliasmode.com/", "https://xreacher.com/", "nobleproxy.com", "/ui/api/cloud-auth", "/ui/api/cloud-connector", "check_for_updates", "update_now"]) expect(bundled.includes(removed)).toBe(false);
  expect(bundled.includes("猫步·千境")).toBe(true);
});
