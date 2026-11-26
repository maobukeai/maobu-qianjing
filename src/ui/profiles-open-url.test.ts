import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Launcher } from "../../launcher.ts";
import { ProfileStore } from "../../store.ts";
import { buildNewProfile } from "../../create.ts";
import { handleProfilesUiRoutes } from "./profiles-routes.ts";

function makeReq(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:4010${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:4010",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /ui/api/profiles/:id/open-url", () => {
  let root = "";
  let store: ProfileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "maobu-open-url-"));
    store = new ProfileStore(join(root, "profiles.sqlite"));
  });

  afterEach(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects invalid or unsafe URLs and unknown profile ids", async () => {
    const profile = buildNewProfile({ name: "Main", engine: "chromium" }, (id) => !!store.getProfile(id));
    store.upsertProfile(profile);
    const id = profile.id;
    const launcher = {} as Launcher;

    for (const bad of ["", "javascript:alert(1)", "file:///etc/passwd", "not a url", "https://a.com/\n"]) {
      const res = await handleProfilesUiRoutes(makeReq(`/ui/api/profiles/${id}/open-url`, { url: bad }), `/ui/api/profiles/${id}/open-url`, launcher, store, {});
      expect(res?.status).toBe(400);
    }

    const missing = await handleProfilesUiRoutes(
      makeReq("/ui/api/profiles/missing99/open-url", { url: "https://example.com/" }),
      "/ui/api/profiles/missing99/open-url",
      launcher,
      store,
      {},
    );
    expect(missing?.status).toBe(404);
  });

  test("starts a stopped profile with the requested startup URL", async () => {
    const profile = buildNewProfile({ name: "Cold Env", engine: "chromium" }, (id) => !!store.getProfile(id));
    store.upsertProfile(profile);
    const id = profile.id;
    const startMock = mock(async (_id: string, _urls?: string[]) => ({
      ws: "ws://127.0.0.1:9999/devtools/browser/1",
      port: 9999,
      reattached: false,
    }));
    const navigateMock = mock(async () => {});
    const bringMock = mock(async () => {});
    const launcher = {
      start: startMock,
      navigate: navigateMock,
      bringToFront: bringMock,
    } as unknown as Launcher;

    const res = await handleProfilesUiRoutes(
      makeReq(`/ui/api/profiles/${id}/open-url`, { url: "https://github.com/maobukeai" }),
      `/ui/api/profiles/${id}/open-url`,
      launcher,
      store,
      {},
    );
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; started: boolean; url: string };
    expect(body).toMatchObject({ ok: true, started: true, url: "https://github.com/maobukeai" });
    expect(startMock).toHaveBeenCalledWith(id, ["https://github.com/maobukeai"]);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(bringMock).toHaveBeenCalledWith(id);
  });

  test("opens a new tab via navigate and brings running Chromium profile to front", async () => {
    const profile = buildNewProfile({ name: "Live Chrome", engine: "chromium" }, (id) => !!store.getProfile(id));
    store.upsertProfile(profile);
    const id = profile.id;
    store.recordLaunch({
      profileId: id,
      pid: 12345,
      debugPort: 9333,
      ws: "ws://127.0.0.1:9333/devtools/browser/live",
      startedAt: Date.now(),
      userDataDir: join(root, "ud"),
    });
    const startMock = mock(async () => ({
      ws: "ws://127.0.0.1:9333/devtools/browser/live",
      port: 9333,
      reattached: true,
    }));
    const navigateMock = mock(async () => {});
    const bringMock = mock(async () => {});
    const launcher = {
      start: startMock,
      navigate: navigateMock,
      bringToFront: bringMock,
    } as unknown as Launcher;

    const res = await handleProfilesUiRoutes(
      makeReq(`/ui/api/profiles/${id}/open-url`, { url: "https://example.org/docs" }),
      `/ui/api/profiles/${id}/open-url`,
      launcher,
      store,
      {},
    );
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; started: boolean };
    expect(body).toMatchObject({ ok: true, started: false });
    expect(startMock).toHaveBeenCalledWith(id, []);
    expect(navigateMock).toHaveBeenCalledWith(
      "ws://127.0.0.1:9333/devtools/browser/live",
      ["https://example.org/docs"],
      false,
    );
    expect(bringMock).toHaveBeenCalledWith(id);
  });

  test("skips bringToFront when profile runs on Firefox", async () => {
    const profile = buildNewProfile({ name: "Live Fox", engine: "firefox" }, (id) => !!store.getProfile(id));
    store.upsertProfile(profile);
    const id = profile.id;
    store.recordLaunch({
      profileId: id,
      pid: 12346,
      debugPort: 9444,
      ws: "ws://127.0.0.1:9444/session",
      startedAt: Date.now(),
      userDataDir: join(root, "ud-fox"),
    });
    const navigateMock = mock(async () => {});
    const bringMock = mock(async () => {});
    const launcher = {
      start: mock(async () => ({
        ws: "ws://127.0.0.1:9444/session",
        port: 9444,
        reattached: true,
      })),
      navigate: navigateMock,
      bringToFront: bringMock,
    } as unknown as Launcher;

    const res = await handleProfilesUiRoutes(
      makeReq(`/ui/api/profiles/${id}/open-url`, { url: "https://mozilla.org" }),
      `/ui/api/profiles/${id}/open-url`,
      launcher,
      store,
      {},
    );
    expect(res?.status).toBe(200);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(bringMock).not.toHaveBeenCalled();
  });
});
