import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  APP_LOCK_CONFIG_FILE,
  APP_LOCK_SCRYPT_PARAMS,
  APP_LOCK_STATE_FILE,
  AppLockError,
  AppLockService,
  checkAppLockGate,
  cooldownMsForFailureCount,
  isPathAllowedWhileLocked,
  lockedResponse,
} from "./app-lock.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "maobu-app-lock-"));
  cleanups.push(() => {
    const resolved = resolve(home);
    const tmp = resolve(tmpdir());
    if (!resolved.startsWith(`${tmp}\\maobu-app-lock-`) && !resolved.startsWith(`${tmp}/maobu-app-lock-`)) {
      throw new Error("Unexpected fixture directory");
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

describe("AppLockService", () => {
  test("cooldown curve enforces 0 / 30s / 2m / 5m / 15m thresholds", () => {
    expect(cooldownMsForFailureCount(0)).toBe(0);
    expect(cooldownMsForFailureCount(1)).toBe(0);
    expect(cooldownMsForFailureCount(4)).toBe(0);
    expect(cooldownMsForFailureCount(5)).toBe(30_000);
    expect(cooldownMsForFailureCount(6)).toBe(120_000);
    expect(cooldownMsForFailureCount(7)).toBe(300_000);
    expect(cooldownMsForFailureCount(8)).toBe(900_000);
    expect(cooldownMsForFailureCount(12)).toBe(900_000);
  });

  test("setup stores salted scrypt HMAC verifier without plaintext and locks on restart", async () => {
    const home = makeTempHome();
    let clock = 1_700_000_000_000;
    const events: Array<{ type: string; reason: unknown }> = [];
    const service = new AppLockService({
      home,
      now: () => clock,
      emitEvent: (type, payload) => events.push({ type, reason: payload.reason }),
    });

    expect(service.status()).toMatchObject({
      configured: false,
      enabled: false,
      locked: false,
      corrupt: false,
    });

    // Reject weak/oversized passwords
    await expect(service.setup({ password: "12345" })).rejects.toThrow(AppLockError);
    await expect(service.setup({ password: "a".repeat(129) })).rejects.toThrow(AppLockError);
    await expect(service.setup({ password: "bad\0pass" })).rejects.toThrow(AppLockError);

    const secret = "Maobu!Lock#2026";
    const status = await service.setup({ password: secret, idleTimeoutMinutes: 10, lockOnStartup: true });
    expect(status).toMatchObject({
      configured: true,
      enabled: true,
      locked: false,
      idleTimeoutMinutes: 10,
      lockOnStartup: true,
      failedAttempts: 0,
      cooldownUntil: 0,
    });
    expect(events.map((e) => e.reason)).toEqual(["setup"]);

    const rawConfigText = readFileSync(join(home, APP_LOCK_CONFIG_FILE), "utf8");
    expect(rawConfigText).not.toContain(secret);
    const parsedConfig = JSON.parse(rawConfigText);
    expect(parsedConfig).toMatchObject({
      version: 1,
      enabled: true,
      kdf: "scrypt",
      kdfParams: {
        N: APP_LOCK_SCRYPT_PARAMS.N,
        r: APP_LOCK_SCRYPT_PARAMS.r,
        p: APP_LOCK_SCRYPT_PARAMS.p,
        dkLen: APP_LOCK_SCRYPT_PARAMS.dkLen,
      },
      idleTimeoutMinutes: 10,
      lockOnStartup: true,
    });
    expect(parsedConfig.saltHex).toMatch(/^[a-f0-9]{32}$/);
    expect(parsedConfig.verifierHex).toMatch(/^[a-f0-9]{64}$/);

    // Fresh instance simulates app restart -> must start locked when lockOnStartup=true
    const restarted = new AppLockService({ home, now: () => clock });
    expect(restarted.isLocked()).toBe(true);
    expect(restarted.status().locked).toBe(true);

    // Unlock succeeds with right password
    const unlocked = await restarted.unlock(secret);
    expect(unlocked.locked).toBe(false);
    expect(unlocked.failedAttempts).toBe(0);
  });

  test("persistent brute-force cooldown survives restarts and resets after valid unlock", async () => {
    const home = makeTempHome();
    let clock = 1_700_000_000_000;
    const service = new AppLockService({ home, now: () => clock });
    await service.setup({ password: "correct-horse-battery", idleTimeoutMinutes: 0, lockOnStartup: true });
    service.lock();

    // 4 wrong attempts: 401 without cooldown
    for (let i = 1; i <= 4; i++) {
      let caught: AppLockError | null = null;
      try {
        await service.unlock("wrong-password");
      } catch (error) {
        caught = error as AppLockError;
      }
      expect(caught).toBeInstanceOf(AppLockError);
      expect(caught!.code).toBe("wrong_password");
      expect(caught!.httpStatus).toBe(401);
      expect(caught!.failedAttempts).toBe(i);
      expect(caught!.retryAfterMs).toBe(0);
    }

    // 5th wrong attempt triggers 30s cooldown
    let fifth: AppLockError | null = null;
    try {
      await service.unlock("wrong-password");
    } catch (error) {
      fifth = error as AppLockError;
    }
    expect(fifth!.code).toBe("app_lock_cooldown");
    expect(fifth!.httpStatus).toBe(429);
    expect(fifth!.failedAttempts).toBe(5);
    expect(fifth!.retryAfterMs).toBe(30_000);

    // State file must exist on disk and persist across restarts
    const persistedState = JSON.parse(readFileSync(join(home, APP_LOCK_STATE_FILE), "utf8"));
    expect(persistedState.failedAttempts).toBe(5);
    expect(persistedState.cooldownUntil).toBe(clock + 30_000);

    const restarted = new AppLockService({ home, now: () => clock });
    // Even with the right password during active cooldown, unlock is blocked with 429
    let duringCooldown: AppLockError | null = null;
    try {
      await restarted.unlock("correct-horse-battery");
    } catch (error) {
      duringCooldown = error as AppLockError;
    }
    expect(duringCooldown!.code).toBe("app_lock_cooldown");
    expect(duringCooldown!.httpStatus).toBe(429);

    // Advance past 30s -> 6th failure triggers 2m cooldown
    clock += 30_001;
    let sixth: AppLockError | null = null;
    try {
      await restarted.unlock("still-wrong");
    } catch (error) {
      sixth = error as AppLockError;
    }
    expect(sixth!.failedAttempts).toBe(6);
    expect(sixth!.retryAfterMs).toBe(120_000);

    // Advance past 2m -> 7th failure triggers 5m cooldown
    clock += 120_001;
    let seventh: AppLockError | null = null;
    try {
      await restarted.unlock("still-wrong");
    } catch (error) {
      seventh = error as AppLockError;
    }
    expect(seventh!.failedAttempts).toBe(7);
    expect(seventh!.retryAfterMs).toBe(300_000);

    // Advance past 5m -> 8th failure triggers 15m cooldown
    clock += 300_001;
    let eighth: AppLockError | null = null;
    try {
      await restarted.unlock("still-wrong");
    } catch (error) {
      eighth = error as AppLockError;
    }
    expect(eighth!.failedAttempts).toBe(8);
    expect(eighth!.retryAfterMs).toBe(900_000);

    // Advance past 15m -> right password unlocks and resets persistent state
    clock += 900_001;
    const unlocked = await restarted.unlock("correct-horse-battery");
    expect(unlocked.locked).toBe(false);
    expect(unlocked.failedAttempts).toBe(0);
    expect(unlocked.cooldownUntil).toBe(0);
    const cleared = JSON.parse(readFileSync(join(home, APP_LOCK_STATE_FILE), "utf8"));
    expect(cleared.failedAttempts).toBe(0);
    expect(cleared.cooldownUntil).toBe(0);
  });

  test("idle auto-lock evaluates elapsed time and overdue touchActivity locks rather than extending", async () => {
    const home = makeTempHome();
    let clock = 1_700_000_000_000;
    const reasons: string[] = [];
    const service = new AppLockService({
      home,
      now: () => clock,
      emitEvent: (_type, payload) => reasons.push(String(payload.reason)),
    });
    await service.setup({ password: "idle-lock-secret", idleTimeoutMinutes: 5, lockOnStartup: true });

    // Activity before timeout resets timer
    clock += 4 * 60_000;
    expect(service.touchActivity()).toBe(true);
    expect(service.isLocked()).toBe(false);

    // Another 4 minutes -> still within 5m of last activity
    clock += 4 * 60_000;
    expect(service.isLocked()).toBe(false);

    // Advance 2 more minutes (total 6m since last activity) -> overdue touchActivity must lock!
    clock += 2 * 60_000;
    expect(service.touchActivity()).toBe(false);
    expect(service.isLocked()).toBe(true);
    expect(reasons).toContain("idle_timeout");
  });

  test("configure verifies currentPassword, rotates password, and disables lock cleanly", async () => {
    const home = makeTempHome();
    const service = new AppLockService({ home });
    await service.setup({ password: "first-password", idleTimeoutMinutes: 15, lockOnStartup: true });

    await expect(
      service.configure({ currentPassword: "wrong-password", idleTimeoutMinutes: 30 }),
    ).rejects.toThrow(AppLockError);

    const rotated = await service.configure({
      currentPassword: "first-password",
      newPassword: "second-password",
      idleTimeoutMinutes: 30,
      lockOnStartup: false,
    });
    expect(rotated.idleTimeoutMinutes).toBe(30);
    expect(rotated.lockOnStartup).toBe(false);

    // lockOnStartup: false means restart starts unlocked
    const restarted = new AppLockService({ home });
    expect(restarted.isLocked()).toBe(false);
    restarted.lock();
    expect(restarted.isLocked()).toBe(true);
    await expect(restarted.unlock("first-password")).rejects.toThrow(AppLockError);
    await restarted.unlock("second-password");
    expect(restarted.isLocked()).toBe(false);

    // Disable removes app-lock.json
    const disabled = await restarted.configure({ currentPassword: "second-password", enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.configured).toBe(false);
    expect(disabled.locked).toBe(false);
  });

  test("corrupt app-lock.json fails closed so tampering cannot bypass lock", () => {
    const home = makeTempHome();
    writeFileSync(join(home, APP_LOCK_CONFIG_FILE), "{ not-valid-json");
    const service = new AppLockService({ home });
    const status = service.status();
    expect(status.corrupt).toBe(true);
    expect(status.locked).toBe(true);
    expect(status.enabled).toBe(true);
  });

  test("isPathAllowedWhileLocked, lockedResponse, and checkAppLockGate enforce 423 Locked strictly", async () => {
    expect(isPathAllowedWhileLocked("GET", "/")).toBe(true);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/health")).toBe(true);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/app-mode")).toBe(true);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/shell-language")).toBe(true);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/app-lock/status")).toBe(true);
    expect(isPathAllowedWhileLocked("POST", "/ui/api/app-lock/unlock")).toBe(true);

    // Disallowed paths while locked
    expect(isPathAllowedWhileLocked("POST", "/ui/api/shell-language")).toBe(false);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/profiles")).toBe(false);
    expect(isPathAllowedWhileLocked("POST", "/ui/api/profiles/create")).toBe(false);
    expect(isPathAllowedWhileLocked("GET", "/card")).toBe(false);
    expect(isPathAllowedWhileLocked("GET", "/api/agent/v1/connect")).toBe(false);
    expect(isPathAllowedWhileLocked("GET", "/ui/api/events")).toBe(false);
    expect(isPathAllowedWhileLocked("GET", "/api/v1/browser/start")).toBe(false);
    expect(isPathAllowedWhileLocked("POST", "/ui/api/app-lock/configure")).toBe(false);

    const res423 = lockedResponse({ failedAttempts: 2, cooldownUntil: 0, retryAfterMs: 0 });
    expect(res423.status).toBe(423);
    expect(res423.headers.get("cache-control")).toBe("no-store");
    expect(await res423.json()).toMatchObject({
      ok: false,
      code: "app_locked",
      locked: true,
      failedAttempts: 2,
    });

    const home = makeTempHome();
    let clock = 1_700_000_000_000;
    const service = new AppLockService({ home, now: () => clock });
    await service.setup({ password: "gate-password", idleTimeoutMinutes: 5, lockOnStartup: true });
    service.lock();

    expect(checkAppLockGate(service, new Request("http://127.0.0.1:50401/ui/api/health"))).toBeNull();
    expect(
      checkAppLockGate(
        service,
        new Request("http://127.0.0.1:50401/ui/api/app-lock/unlock", { method: "POST" }),
      ),
    ).toBeNull();

    const blockedProfiles = checkAppLockGate(service, new Request("http://127.0.0.1:50401/ui/api/profiles"));
    expect(blockedProfiles?.status).toBe(423);
    const blockedCard = checkAppLockGate(service, new Request("http://127.0.0.1:50401/card?id=p1"));
    expect(blockedCard?.status).toBe(423);
    const blockedWs = checkAppLockGate(service, new Request("http://127.0.0.1:50401/api/agent/v1/connect"));
    expect(blockedWs?.status).toBe(423);

    await service.unlock("gate-password");
    // Passive GET polling does NOT reset idle timer
    clock += 4 * 60_000;
    expect(checkAppLockGate(service, new Request("http://127.0.0.1:50401/ui/api/profiles"))).toBeNull();
    clock += 2 * 60_000; // Total 6m since unlock -> auto-locked!
    const blockedAfterIdle = checkAppLockGate(service, new Request("http://127.0.0.1:50401/ui/api/profiles"));
    expect(blockedAfterIdle?.status).toBe(423);
  });
});
