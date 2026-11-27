import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppLockService } from "../app-lock.ts";
import { handleAppLockRoutes } from "../src/ui/app-lock-routes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "maobu-app-lock-routes-"));
  cleanups.push(() => {
    const resolved = resolve(home);
    const tmp = resolve(tmpdir());
    if (!resolved.startsWith(`${tmp}\\maobu-app-lock-routes-`) && !resolved.startsWith(`${tmp}/maobu-app-lock-routes-`)) {
      throw new Error("Unexpected fixture directory");
    }
    rmSync(home, { recursive: true, force: true });
  });
  let clock = 1_700_000_000_000;
  const appLock = new AppLockService({ home, now: () => clock });
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const reqHeaders = new Headers(headers);
    if (method !== "GET") {
      if (!reqHeaders.has("X-Maobu-Settings")) reqHeaders.set("X-Maobu-Settings", "1");
      if (!reqHeaders.has("Content-Type")) reqHeaders.set("Content-Type", "application/json");
    }
    const req = new Request(`http://127.0.0.1:50401${path}`, {
      method,
      headers: reqHeaders,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return handleAppLockRoutes(req, new URL(req.url).pathname, { appLock });
  };
  return {
    appLock,
    call,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("handleAppLockRoutes", () => {
  test("ignores unrelated paths and returns 503 when service is missing", async () => {
    const ignored = await handleAppLockRoutes(new Request("http://127.0.0.1:50401/ui/api/profiles"), "/ui/api/profiles", {});
    expect(ignored).toBeNull();
    const unavailable = await handleAppLockRoutes(
      new Request("http://127.0.0.1:50401/ui/api/app-lock/status"),
      "/ui/api/app-lock/status",
      {},
    );
    expect(unavailable?.status).toBe(503);
  });

  test("enforces same-origin, loopback, X-Maobu-Settings header, and JSON content type", async () => {
    const f = fixture();
    const crossOrigin = await handleAppLockRoutes(
      new Request("http://127.0.0.1:50401/ui/api/app-lock/setup", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "X-Maobu-Settings": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: "secret-password" }),
      }),
      "/ui/api/app-lock/setup",
      { appLock: f.appLock },
    );
    expect(crossOrigin?.status).toBe(403);

    const missingHeader = await handleAppLockRoutes(
      new Request("http://127.0.0.1:50401/ui/api/app-lock/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-password" }),
      }),
      "/ui/api/app-lock/setup",
      { appLock: f.appLock },
    );
    expect(missingHeader?.status).toBe(403);

    const wrongType = await handleAppLockRoutes(
      new Request("http://127.0.0.1:50401/ui/api/app-lock/setup", {
        method: "POST",
        headers: { "X-Maobu-Settings": "1", "Content-Type": "text/plain" },
        body: "{}",
      }),
      "/ui/api/app-lock/setup",
      { appLock: f.appLock },
    );
    expect(wrongType?.status).toBe(415);
  });

  test("supports full setup -> lock -> 423 gate -> unlock -> configure -> disable lifecycle", async () => {
    const f = fixture();

    const initial = await f.call("/ui/api/app-lock/status");
    expect(initial?.status).toBe(200);
    expect((await initial!.json()).status.enabled).toBe(false);

    const setup = await f.call("/ui/api/app-lock/setup", "POST", {
      password: "master-password-1",
      idleTimeoutMinutes: 5,
      lockOnStartup: true,
    });
    expect(setup?.status).toBe(200);
    expect((await setup!.json()).status).toMatchObject({ enabled: true, locked: false, idleTimeoutMinutes: 5 });

    // Lock manually
    const locked = await f.call("/ui/api/app-lock/lock", "POST", {});
    expect(locked?.status).toBe(200);
    expect((await locked!.json()).status.locked).toBe(true);

    // Configure & activity must return 423 while locked
    const blockedConfigure = await f.call("/ui/api/app-lock/configure", "POST", {
      currentPassword: "master-password-1",
      enabled: false,
    });
    expect(blockedConfigure?.status).toBe(423);
    expect((await blockedConfigure!.json()).code).toBe("app_locked");

    const blockedActivity = await f.call("/ui/api/app-lock/activity", "POST", {});
    expect(blockedActivity?.status).toBe(423);

    // Wrong password returns 401
    const badUnlock = await f.call("/ui/api/app-lock/unlock", "POST", { password: "wrong" });
    expect(badUnlock?.status).toBe(401);
    expect((await badUnlock!.json()).code).toBe("wrong_password");

    // Right password unlocks
    const goodUnlock = await f.call("/ui/api/app-lock/unlock", "POST", { password: "master-password-1" });
    expect(goodUnlock?.status).toBe(200);
    expect((await goodUnlock!.json()).status.locked).toBe(false);

    // Activity heartbeat extends timeout
    f.advance(4 * 60_000);
    const heartbeat = await f.call("/ui/api/app-lock/activity", "POST", {});
    expect(heartbeat?.status).toBe(200);

    // Idle timeout triggers 423 on next activity ping
    f.advance(6 * 60_000);
    const overdue = await f.call("/ui/api/app-lock/activity", "POST", {});
    expect(overdue?.status).toBe(423);

    // Unlock and disable
    expect((await f.call("/ui/api/app-lock/unlock", "POST", { password: "master-password-1" }))?.status).toBe(200);
    const disabled = await f.call("/ui/api/app-lock/configure", "POST", {
      currentPassword: "master-password-1",
      enabled: false,
    });
    expect(disabled?.status).toBe(200);
    expect((await disabled!.json()).status).toMatchObject({ enabled: false, configured: false, locked: false });
  });
});
