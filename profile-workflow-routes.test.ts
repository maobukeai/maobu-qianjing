import { afterEach, describe, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { createProfilePackage, openProfilePackage, ProfilePackagePreviewStore, sealProfilePackage, type ProfilePackagePreview } from "./profile-package.ts";
import { listProfileEvents } from "./profile-timeline.ts";
import { handleProfilePackageRoutes } from "./src/ui/profile-package-routes.ts";
import { handleProfileTimelineRoutes } from "./src/ui/profile-timeline-routes.ts";
import { handleProfilesUiRoutes } from "./src/ui/profiles-routes.ts";
import { ProfileStore } from "./store.ts";

const stores: ProfileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
});

function memStore(): ProfileStore {
  const store = new ProfileStore(":memory:");
  stores.push(store);
  return store;
}

function makeProfile(id: string, name: string) {
  const p = buildNewProfile(
    {
      name,
      group: "TeamA",
      username: "acct_user",
      password: "PRIVATE_ACCOUNT_PASSWORD",
      twofa: "JBSWY3DPEHPK3PXP",
      proxy: { type: "socks5", host: "proxy.example.test", port: "1080", user: "PRIVATE_PX_USER", pass: "PRIVATE_PX_PASS" },
    },
    () => false,
  );
  p.id = id;
  p.notes = "Initial note";
  return p;
}

const SAMPLE_SESSION = JSON.stringify({
  cookies: [{ name: "sid", value: "PRIVATE_SESSION_COOKIE", domain: ".example.test", path: "/" }],
  origins: [],
  tabs: ["https://example.test/"],
});

describe("Wave 4 workflow UX API routes", () => {
  test("package overwrite can only replace the unchanged closed environments reviewed by the user", async () => {
    const store = memStore();
    const late = makeProfile("review_late", "Late original");
    const running = makeProfile("review_running", "Running original");
    const edited = makeProfile("review_edited", "Edited original");
    const stableNew = makeProfile("review_new", "New import");
    const incoming = [late, running, edited].map(profile => ({ ...profile, name: profile.name + " in package" }));
    store.upsertProfiles([running, edited]);
    store.recordLaunch({ profileId: running.id, pid: 12345, debugPort: 9222, ws: "", startedAt: Date.now() });
    const password = "synthetic-review-password";
    const bytes = await sealProfilePackage(createProfilePackage([...incoming, stableNew]), password);
    const options = { packagePreviewStore: new ProfilePackagePreviewStore() };
    const launcher = {} as Parameters<typeof handleProfilePackageRoutes>[2];
    const request = (operation: string, init: RequestInit) => {
      const path = `/ui/api/profiles/package/${operation}`;
      return handleProfilePackageRoutes(new Request(`http://127.0.0.1${path}`, { method: "POST", ...init }), path, launcher, store, options);
    };
    const review = async (): Promise<ProfilePackagePreview> => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(bytes)], "fixture.mqprofile"));
      form.append("password", password);
      const response = await request("preview", { body: form });
      expect(response?.status).toBe(200);
      return (await response!.json()).preview;
    };
    const commit = (preview: ProfilePackagePreview, selectedIds: string[]) => request("import", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        previewId: preview.previewId, previewToken: preview.previewToken,
        strategy: "overwrite_closed", confirmOverwrite: true, selectedIds,
      }),
    });
    const expectStale = async (preview: ProfilePackagePreview, selected: string, originalName: string) => {
      const response = await commit(preview, [stableNew.id, selected]);
      expect(response?.status).toBe(409);
      expect((await response!.json()).code).toBe("preview_target_changed");
      expect(store.getProfile(selected)?.name).toBe(originalName);
      expect(store.getProfile(stableNew.id)).toBeNull();
    };

    const first = await review();
    expect(first.profiles.find(profile => profile.id === late.id)?.conflictReason).toBeNull();
    store.upsertProfile(late);
    await expectStale(first, late.id, late.name);

    const second = await review();
    expect(second.profiles.find(profile => profile.id === running.id)?.conflictReason).toBe("running");
    store.clearLaunch(running.id);
    await expectStale(second, running.id, running.name);

    const third = await review();
    store.upsertProfile({ ...edited, notes: "Saved after package review" });
    await expectStale(third, edited.id, edited.name);
    expect(store.getProfile(edited.id)?.notes).toBe("Saved after package review");

    const fourth = await review();
    store.upsertProfile({ ...late, notes: "Unselected changes do not affect this import" });
    const response = await commit(fourth, [stableNew.id, edited.id]);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.result).toMatchObject({ importedCount: 1, overwrittenCount: 1, skippedCount: 2 });
    expect(store.getProfile(edited.id)?.name).toBe(edited.name + " in package");
    expect(store.getProfile(late.id)?.notes).toBe("Unselected changes do not affect this import");
  });

  test("encrypted package export captures live sessions, previews conflicts without secrets, and imports atomically", async () => {
    const store = memStore();
    const p1 = makeProfile("wf_001", "Alpha");
    const p2 = makeProfile("wf_002", "Beta");
    store.upsertProfiles([p1, p2]);
    store.recordLaunch({
      profileId: "wf_001",
      pid: 12345,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/live",
      startedAt: Date.now(),
    });

    const captured: string[] = [];
    const launcher = {
      async captureLocalSession(id: string) {
        captured.push(id);
        store.saveSessionBundle(id, SAMPLE_SESSION);
        return true;
      },
      prefetchFirefoxFontPacks() {},
    } as any;

    const previewStore = new ProfilePackagePreviewStore();
    const password = "strong-export-password-2026";

    // Export via NDJSON stream.
    const exportRes = await handleProfilePackageRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/package/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["wf_001", "wf_002"], password, includeSecrets: true, includeSessions: true, stream: true }),
      }),
      "/ui/api/profiles/package/export",
      launcher,
      store,
      { packagePreviewStore: previewStore },
    );
    expect(exportRes).not.toBeNull();
    expect(exportRes!.status).toBe(200);
    expect(exportRes!.headers.get("cache-control")).toBe("no-store");
    expect(captured).toEqual(["wf_001"]);

    const lines = (await exportRes!.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const fileRecord = lines.find((item) => item.type === "file");
    expect(fileRecord).toBeDefined();
    expect(fileRecord.profileCount).toBe(2);
    const bytes = Buffer.from(fileRecord.data, "base64");
    const opened = await openProfilePackage(bytes, password);
    expect(opened.profiles).toHaveLength(2);
    expect(opened.sessions.wf_001).toBe(SAMPLE_SESSION);

    // Preview via multipart/form-data against same store (wf_001 is running, wf_002 is existing_active).
    const form = new FormData();
    form.append("file", new File([bytes], "bundle.mqprofile", { type: "application/octet-stream" }));
    form.append("password", password);
    const previewRes = await handleProfilePackageRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/package/preview", { method: "POST", body: form }),
      "/ui/api/profiles/package/preview",
      launcher,
      store,
      { packagePreviewStore: previewStore },
    );
    expect(previewRes!.status).toBe(200);
    const previewText = await previewRes!.text();
    expect(previewText).not.toContain("PRIVATE_");
    const { preview } = JSON.parse(previewText);
    expect(preview.conflictCount).toBe(2);
    expect(preview.runningConflictCount).toBe(1);

    // Import with clone_new_id.
    const importRes = await handleProfilePackageRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/package/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId: preview.previewId,
          previewToken: preview.previewToken,
          strategy: "clone_new_id",
        }),
      }),
      "/ui/api/profiles/package/import",
      launcher,
      store,
      { packagePreviewStore: previewStore },
    );
    expect(importRes!.status).toBe(200);
    const imported = await importRes!.json();
    expect(imported.result.clonedCount).toBe(2);
    expect(store.listProfiles()).toHaveLength(4);

    // Replaying consumed preview token fails.
    const replayRes = await handleProfilePackageRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/package/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId: preview.previewId,
          previewToken: preview.previewToken,
          strategy: "skip",
        }),
      }),
      "/ui/api/profiles/package/import",
      launcher,
      store,
      { packagePreviewStore: previewStore },
    );
    expect(replayRes!.status).toBe(409);
  });

  test("notes update validates bounds and records redacted timeline events; check-proxy uses stored proxy without exposing credentials", async () => {
    const store = memStore();
    const p1 = makeProfile("tl_route_1", "Inspector");
    store.upsertProfile(p1);

    const launcher = {
      async reconcileOrphans() {},
      async start() {
        throw new Error("Proxy 407 authentication failed via socks5://PRIVATE_PX_USER:PRIVATE_PX_PASS@proxy.example.test:1080");
      },
    } as any;

    // 1. Update notes via /update.
    const updOk = await handleProfilesUiRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set: { notes: "Updated\r\nnote text" } }),
      }),
      "/ui/api/profiles/tl_route_1/update",
      launcher,
      store,
      {},
    );
    expect(updOk!.status).toBe(200);
    expect(store.getProfile("tl_route_1")?.notes).toBe("Updated\nnote text");

    // Invalid BiDi note returns 400.
    const updBad = await handleProfilesUiRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set: { notes: "bad\u202enote" } }),
      }),
      "/ui/api/profiles/tl_route_1/update",
      launcher,
      store,
      {},
    );
    expect(updBad!.status).toBe(400);

    // 2. Launch failure records redacted launch.failed event with proxy recoveryKind.
    const openFail = await handleProfilesUiRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/open", { method: "POST" }),
      "/ui/api/profiles/tl_route_1/open",
      launcher,
      store,
      {},
    );
    expect(openFail!.status).toBe(500);

    // 3. Server-side POST /ui/api/profiles/:id/check-proxy reads stored proxy credentials internally and returns redacted result.
    let checkedProxy: any = null;
    const checkRes = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      "/ui/api/profiles/tl_route_1/check-proxy",
      store,
      {
        proxyCheck: async (proxy) => {
          checkedProxy = proxy;
          return {
            status: "working",
            attempts: 3,
            successes: 3,
            ip: "198.51.100.77",
            country: "JP",
            city: "Tokyo",
            exitComparison: "different",
          };
        },
      },
    );
    expect(checkRes!.status).toBe(200);
    expect(checkRes!.headers.get("cache-control")).toBe("no-store");
    expect(checkedProxy).toMatchObject({ host: "proxy.example.test", user: "PRIVATE_PX_USER", pass: "PRIVATE_PX_PASS" });
    const checkText = await checkRes!.text();
    expect(checkText).not.toContain("PRIVATE_");
    expect(JSON.parse(checkText)).toMatchObject({ ok: true, status: "working", ip: "198.51.100.77", country: "JP" });

    // 4. GET /ui/api/profiles/:id/timeline returns all redacted events.
    const tlRes = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/timeline?limit=10", { method: "GET" }),
      "/ui/api/profiles/tl_route_1/timeline",
      store,
      {},
    );
    expect(tlRes!.status).toBe(200);
    const tlText = await tlRes!.text();
    expect(tlText).not.toContain("PRIVATE_");
    expect(tlText).not.toContain("Updated\nnote text");
    const tlBody = JSON.parse(tlText);
    expect(tlBody.events.map((e: any) => e.eventType)).toEqual([
      "proxy.checked",
      "launch.failed",
      "notes.updated",
    ]);
    expect(tlBody.events[1].recoveryKind).toBe("proxy");

    // 5. DELETE /ui/api/profiles/:id/timeline clears timeline.
    const clearRes = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/tl_route_1/timeline", { method: "DELETE" }),
      "/ui/api/profiles/tl_route_1/timeline",
      store,
      {},
    );
    expect(clearRes!.status).toBe(200);
    expect(await clearRes!.json()).toMatchObject({ ok: true, removed: 3 });
    expect(listProfileEvents(store, "tl_route_1").events).toEqual([]);
  });

  test("rejects cross-origin mutations and non-JSON check-proxy requests", async () => {
    const store = memStore();
    store.upsertProfile(makeProfile("sec_1", "Security"));

    const crossOrigin = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/sec_1/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: "{}",
      }),
      "/ui/api/profiles/sec_1/check-proxy",
      store,
      {},
    );
    expect(crossOrigin!.status).toBe(403);

    const nonJson = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/sec_1/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
      "/ui/api/profiles/sec_1/check-proxy",
      store,
      {},
    );
    expect(nonJson!.status).toBe(415);

    const badType = await handleProfileTimelineRoutes(
      new Request("http://127.0.0.1/ui/api/profiles/sec_1/timeline?type=not_a_real_event", { method: "GET" }),
      "/ui/api/profiles/sec_1/timeline",
      store,
      {},
    );
    expect(badType!.status).toBe(400);
  });
});
