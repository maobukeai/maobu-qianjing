import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "./app-config.ts";
import { handleUiRequest } from "./ui.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
test("retired hosted API paths are rejected without a runtime implementation", async () => {
  for (const path of ["cloud-auth", "cloud-auth/restore", "cloud-auth/signin", "cloud-connector", "cloud-workspace", "cloud-store", "cloud-events", "services", "scripts/library", "scripts/old/publication"]) {
    const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/${path}`), {} as any, {} as any);
    expect(response?.status).toBe(410);
  }
});
test("old hosted configuration reads locally without modifying its original data", async () => {
  const root = mkdtempSync(join(tmpdir(), "maobu-api-"));
  try {
    const path = join(root, "config.json");
    const original = JSON.stringify({ version: 1, mode: "cloud", cloudUrl: "https://retired.example", localAnalytics: true });
    writeFileSync(path, original);
    const appConfig = new AppConfigStore(path);
    const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/app-mode"), {} as any, {} as any, { appConfig });
    const config = await response!.json();
    expect(config).toMatchObject({ mode: "local", localOnly: true, localAnalytics: false, restartRequired: false });
    expect(JSON.stringify(config)).not.toContain("retired.example");
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("the local roster loads directly from the profile store", async () => {
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfiles([buildNewProfile({ name: "Local profile" }, () => false)]);
    const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/profiles"), { reconcileOrphans: async () => {} } as any, store);
    expect(response?.status).toBe(200);
    expect((await response!.json()).profiles[0].name).toBe("Local profile");
  } finally { store.close(); }
});
