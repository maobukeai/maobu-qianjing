import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppLockedError,
  clearProfileCache,
  fetchProfiles,
  openUiEventStream,
  setStandaloneSessionToken,
  subscribeAppLocked,
  subscribeUnauthorized,
  withStandaloneAuthHeaders,
} from "./api.ts";
import {
  fetchProfileResourcePolicy,
  openMetricsStream,
  updateProfileResourcePolicy,
} from "./resource-monitor-api.ts";
import { fetchSettings, resetSharedSettingsCache } from "./settings-api.ts";
import { clearWorkspaceCapability, fetchWorkspaces } from "./workspaces-api.ts";
import { postTrashTask } from "./trash-task.ts";
import { appVersion } from "../src/ui/shared.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { handleUiRequest } from "../ui.ts";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import type { Launcher } from "../launcher.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  setStandaloneSessionToken(null);
  clearWorkspaceCapability();
  resetSharedSettingsCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Frontend-backend compatibility contracts", () => {
  test("withStandaloneAuthHeaders leaves null-token headers untouched and attaches X-Maobu-Session when set", () => {
    const raw = { Accept: "application/json" };
    setStandaloneSessionToken(null);
    expect(withStandaloneAuthHeaders(raw)).toBe(raw);
    expect(withStandaloneAuthHeaders(undefined)).toBeUndefined();

    const token = "a".repeat(64);
    setStandaloneSessionToken(token);
    const merged = new Headers(withStandaloneAuthHeaders(raw));
    expect(merged.get("X-Maobu-Session")).toBe(token);
    expect(merged.get("Accept")).toBe("application/json");

    const explicitAuth = new Headers(withStandaloneAuthHeaders({ Authorization: `Bearer ${"b".repeat(64)}` }));
    expect(explicitAuth.has("X-Maobu-Session")).toBe(false);
  });

  test("settings, workspaces, and trash requests propagate standalone session token and handle 401/423 globally", async () => {
    const token = "c".repeat(64);
    setStandaloneSessionToken(token);
    const seenSessions: string[] = [];
    let lockedCount = 0;
    let unauthCount = 0;
    const unsubLock = subscribeAppLocked(() => { lockedCount++; });
    const unsubAuth = subscribeUnauthorized(() => { unauthCount++; });

    try {
      globalThis.fetch = (async (_input, init) => {
        seenSessions.push(new Headers(init?.headers).get("X-Maobu-Session") ?? "");
        return Response.json(
          { ok: false, code: "app_locked", locked: true, error: "Application is locked." },
          { status: 423 },
        );
      }) as typeof fetch;

      await expect(fetchSettings()).rejects.toThrow("Application is locked.");
      await expect(fetchWorkspaces()).rejects.toThrow("Workspace request failed.");
      await expect(fetchProfiles()).rejects.toThrow("Application is locked.");
      await postTrashTask("restore", ["p1"]);

      expect(seenSessions).toEqual([token, token, token, token]);
      expect(lockedCount).toBe(3);

      setStandaloneSessionToken(token);
      globalThis.fetch = (() =>
        Promise.resolve(Response.json({ ok: false, error: "Session expired" }, { status: 401 }))) as unknown as typeof fetch;
      await expect(fetchSettings()).rejects.toThrow("Session expired");
      expect(unauthCount).toBe(1);

      setStandaloneSessionToken(token);
      globalThis.fetch = (() =>
        Promise.resolve(Response.json({ ok: false, code: "app_locked", error: "Locked" }, { status: 423 }))) as unknown as typeof fetch;
      await expect(
        openMetricsStream({ signal: AbortSignal.timeout(1000), onSnapshot: () => {} }),
      ).rejects.toBeInstanceOf(AppLockedError);
      await expect(
        openUiEventStream({ signal: AbortSignal.timeout(1000), onEvent: () => {} }),
      ).rejects.toBeInstanceOf(AppLockedError);
      expect(lockedCount).toBe(5);
    } finally {
      unsubLock();
      unsubAuth();
    }
  });

  test("resource policy GET/PATCH and profile clear-cache clients match real backend route contracts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maobu-fb-contract-"));
    tempDirs.push(dir);
    const store = new ProfileStore(join(dir, "profiles.sqlite"));
    const profile = buildNewProfile({ engine: "chromium", name: "Contract Profile" }, (id) => !!store.getProfile(id));
    profile.id = "contract01";
    store.upsertProfile(profile);

    let clearedId = "";
    const launcher = {
      clearCache: async (id: string) => {
        clearedId = id;
        return { cleared: true };
      },
    } as unknown as Launcher;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const req = new Request(path.startsWith("http") ? path : `http://127.0.0.1${path}`, init);
      return (await handleUiRequest(req, launcher, store, {})) ?? new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const initial = await fetchProfileResourcePolicy(profile.id);
      expect(initial.supported).toBe(true);
      expect(initial.policy?.memorySaverMode).toBe("inherit");
      expect(initial.effective?.memorySaver).toBe(false);

      const updated = await updateProfileResourcePolicy(profile.id, {
        memorySaverMode: "on",
        dataSaver: { mode: "on", blockImages: true, blockMedia: false, blockFonts: true },
      });
      expect(updated.policy.memorySaverMode).toBe("on");
      expect(updated.policy.dataSaver).toEqual({
        mode: "on",
        blockImages: true,
        blockMedia: false,
        blockFonts: true,
      });
      expect(updated.effective).toEqual({
        memorySaver: true,
        dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: true },
      });

      const cacheResult = await clearProfileCache(profile.id);
      expect(clearedId).toBe(profile.id);
      expect(cacheResult).toEqual({ ok: true, cleared: true });
    } finally {
      store.close();
    }
  });

  test("appVersion falls back to ALIASMODE_VERSION rather than 'dev' when VERSION.txt is absent", async () => {
    expect(await appVersion()).toBe(ALIASMODE_VERSION);
  });
});
