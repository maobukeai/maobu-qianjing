import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { plainDirectory, workspaceEntryExists, writeWorkspaceJson } from "./workspaces.ts";

export const APP_LOCK_CONFIG_FILE = "app-lock.json";
export const APP_LOCK_STATE_FILE = "app-lock-state.json";

export const APP_LOCK_MIN_PASSWORD_CHARS = 6;
export const APP_LOCK_MAX_PASSWORD_CHARS = 128;
export const APP_LOCK_MAX_PASSWORD_BYTES = 512;
export const APP_LOCK_MAX_IDLE_MINUTES = 24 * 60;

export const APP_LOCK_SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  dkLen: 32,
  maxmem: 64 * 1024 * 1024,
});

const APP_LOCK_SALT_BYTES = 16;
const APP_LOCK_VERIFIER_DOMAIN = "maobu-app-lock:v1:verifier";
const MAX_LOCK_FILE_BYTES = 16 * 1024;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export type AppLockErrorCode =
  | "invalid_password"
  | "wrong_password"
  | "app_lock_cooldown"
  | "already_configured"
  | "not_configured"
  | "not_enabled"
  | "invalid_config"
  | "corrupt_config";

export class AppLockError extends Error {
  override readonly name = "AppLockError";
  readonly code: AppLockErrorCode;
  readonly httpStatus: number;
  readonly failedAttempts?: number;
  readonly cooldownUntil?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: AppLockErrorCode,
    message: string,
    httpStatus: number,
    details?: { failedAttempts?: number; cooldownUntil?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.failedAttempts = details?.failedAttempts;
    this.cooldownUntil = details?.cooldownUntil;
    this.retryAfterMs = details?.retryAfterMs;
  }
}

export interface AppLockConfigRecord {
  version: 1;
  enabled: boolean;
  kdf: "scrypt";
  kdfParams: { N: 32768; r: 8; p: 1; dkLen: 32 };
  saltHex: string;
  verifierHex: string;
  idleTimeoutMinutes: number;
  lockOnStartup: boolean;
  updatedAt: number;
}

export interface AppLockFailureState {
  version: 1;
  failedAttempts: number;
  cooldownUntil: number;
  lastFailedAt: number;
}

export interface AppLockStatus {
  configured: boolean;
  enabled: boolean;
  locked: boolean;
  lockOnStartup: boolean;
  idleTimeoutMinutes: number;
  failedAttempts: number;
  cooldownUntil: number;
  retryAfterMs: number;
  lastActivityAt: number;
  updatedAt: number | null;
  corrupt: boolean;
}

export interface AppLockSetupInput {
  password: string;
  idleTimeoutMinutes?: number;
  lockOnStartup?: boolean;
}

export interface AppLockConfigureInput {
  currentPassword: string;
  enabled?: boolean;
  newPassword?: string;
  idleTimeoutMinutes?: number;
  lockOnStartup?: boolean;
}

export interface AppLockServiceOptions {
  /** Global application home directory (`<workspaceHome>`), never a single workspace backup root. */
  home: string;
  /** Injectable wall clock for deterministic unit tests. */
  now?: () => number;
  /** Optional SSE / event bus callback when lock state or configuration changes. */
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Persistent brute-force cooldown curve:
 * - Attempts 1–4: 0 ms
 * - Attempt 5: 30 seconds
 * - Attempt 6: 2 minutes
 * - Attempt 7: 5 minutes
 * - Attempt 8+: 15 minutes
 */
export function cooldownMsForFailureCount(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 30_000;
  if (failedAttempts === 6) return 2 * 60_000;
  if (failedAttempts === 7) return 5 * 60_000;
  return 15 * 60_000;
}

export function validateAppLockPassword(password: unknown): string {
  if (typeof password !== "string") {
    throw new AppLockError(
      "invalid_password",
      "Master password must be a string between 6 and 128 characters.",
      400,
    );
  }
  if (password.includes("\0")) {
    throw new AppLockError(
      "invalid_password",
      "Master password cannot contain null characters.",
      400,
    );
  }
  const chars = Array.from(password).length;
  const bytes = Buffer.byteLength(password, "utf8");
  if (chars < APP_LOCK_MIN_PASSWORD_CHARS || chars > APP_LOCK_MAX_PASSWORD_CHARS || bytes > APP_LOCK_MAX_PASSWORD_BYTES) {
    throw new AppLockError(
      "invalid_password",
      `Master password must be ${APP_LOCK_MIN_PASSWORD_CHARS}–${APP_LOCK_MAX_PASSWORD_CHARS} characters (at most ${APP_LOCK_MAX_PASSWORD_BYTES} UTF-8 bytes).`,
      400,
    );
  }
  return password;
}

export function normalizeIdleTimeoutMinutes(value: unknown, fallback = 15): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > APP_LOCK_MAX_IDLE_MINUTES) {
    throw new AppLockError(
      "invalid_config",
      `Idle auto-lock timeout must be an integer between 0 and ${APP_LOCK_MAX_IDLE_MINUTES} minutes.`,
      400,
    );
  }
  return value;
}

async function deriveAppLockVerifier(password: string, salt: Buffer): Promise<Buffer> {
  const derived = await new Promise<Buffer>((resolveKey, rejectKey) => {
    scrypt(
      password,
      salt,
      APP_LOCK_SCRYPT_PARAMS.dkLen,
      {
        N: APP_LOCK_SCRYPT_PARAMS.N,
        r: APP_LOCK_SCRYPT_PARAMS.r,
        p: APP_LOCK_SCRYPT_PARAMS.p,
        maxmem: APP_LOCK_SCRYPT_PARAMS.maxmem,
      },
      (error, key) => (error ? rejectKey(error) : resolveKey(key)),
    );
  });
  try {
    return createHmac("sha256", derived).update(APP_LOCK_VERIFIER_DOMAIN).digest();
  } finally {
    derived.fill(0);
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPlainJsonFile(path: string): unknown | null {
  if (!workspaceEntryExists(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_FILE_BYTES) {
    throw new Error("App lock file is invalid or linked");
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function parseConfigRecord(raw: unknown): AppLockConfigRecord {
  if (!isObjectRecord(raw)) throw new Error("App lock configuration must be a JSON object");
  if (raw.version !== 1 || typeof raw.enabled !== "boolean" || raw.kdf !== "scrypt") {
    throw new Error("Unsupported app lock configuration version or KDF");
  }
  if (!isObjectRecord(raw.kdfParams)) throw new Error("Missing KDF parameters");
  if (
    raw.kdfParams.N !== APP_LOCK_SCRYPT_PARAMS.N
    || raw.kdfParams.r !== APP_LOCK_SCRYPT_PARAMS.r
    || raw.kdfParams.p !== APP_LOCK_SCRYPT_PARAMS.p
    || raw.kdfParams.dkLen !== APP_LOCK_SCRYPT_PARAMS.dkLen
  ) {
    throw new Error("Unsupported KDF parameters in app lock configuration");
  }
  if (typeof raw.saltHex !== "string" || !/^[a-f0-9]{32}$/.test(raw.saltHex)) {
    throw new Error("Invalid salt in app lock configuration");
  }
  if (typeof raw.verifierHex !== "string" || !/^[a-f0-9]{64}$/.test(raw.verifierHex)) {
    throw new Error("Invalid verifier in app lock configuration");
  }
  const idleTimeoutMinutes = normalizeIdleTimeoutMinutes(raw.idleTimeoutMinutes, 15);
  if (typeof raw.lockOnStartup !== "boolean") {
    throw new Error("Invalid lockOnStartup flag");
  }
  if (typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) {
    throw new Error("Invalid updatedAt timestamp");
  }
  return {
    version: 1,
    enabled: raw.enabled,
    kdf: "scrypt",
    kdfParams: { N: 32768, r: 8, p: 1, dkLen: 32 },
    saltHex: raw.saltHex,
    verifierHex: raw.verifierHex,
    idleTimeoutMinutes,
    lockOnStartup: raw.lockOnStartup,
    updatedAt: raw.updatedAt,
  };
}

function defaultFailureState(): AppLockFailureState {
  return { version: 1, failedAttempts: 0, cooldownUntil: 0, lastFailedAt: 0 };
}

function parseFailureState(raw: unknown): AppLockFailureState {
  if (!isObjectRecord(raw) || raw.version !== 1) return defaultFailureState();
  const failedAttempts =
    typeof raw.failedAttempts === "number" && Number.isSafeInteger(raw.failedAttempts) && raw.failedAttempts >= 0
      ? raw.failedAttempts
      : 0;
  const cooldownUntil =
    typeof raw.cooldownUntil === "number" && Number.isSafeInteger(raw.cooldownUntil) && raw.cooldownUntil >= 0
      ? raw.cooldownUntil
      : 0;
  const lastFailedAt =
    typeof raw.lastFailedAt === "number" && Number.isSafeInteger(raw.lastFailedAt) && raw.lastFailedAt >= 0
      ? raw.lastFailedAt
      : 0;
  return { version: 1, failedAttempts, cooldownUntil, lastFailedAt };
}

/**
 * Exact HTTP route allowlist while the application is locked.
 * Every other route (including `/ui/api/profiles`, `/card`, `/api/agent/v1/connect`,
 * `/ui/api/events`, and `/api/v1|v2/*`) must be blocked with HTTP 423 Locked.
 */
export function isPathAllowedWhileLocked(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET") {
    return (
      pathname === "/"
      || pathname === "/ui/api/health"
      || pathname === "/ui/api/app-mode"
      || pathname === "/ui/api/shell-language"
      || pathname === "/ui/api/app-lock/status"
    );
  }
  if (normalizedMethod === "POST") {
    return pathname === "/ui/api/app-lock/unlock";
  }
  return false;
}

/** Standard HTTP 423 Locked JSON response returned when an endpoint is blocked by App Lock. */
export function lockedResponse(
  status?: Partial<Pick<AppLockStatus, "failedAttempts" | "cooldownUntil" | "retryAfterMs">>,
): Response {
  return Response.json(
    {
      ok: false,
      code: "app_locked",
      locked: true,
      error: "Application is locked. Unlock with your master password to continue.",
      ...(typeof status?.failedAttempts === "number" ? { failedAttempts: status.failedAttempts } : {}),
      ...(typeof status?.cooldownUntil === "number" ? { cooldownUntil: status.cooldownUntil } : {}),
      ...(typeof status?.retryAfterMs === "number" ? { retryAfterMs: status.retryAfterMs } : {}),
    },
    { status: 423, headers: NO_STORE_HEADERS },
  );
}

/**
 * Single-line middleware gate for `web.ts`.
 * Evaluates idle auto-lock first; blocks disallowed paths with 423 Locked;
 * updates backend `lastActivityAt` on non-polling interactive mutations while unlocked.
 */
export function checkAppLockGate(appLock: AppLockService | undefined, req: Request): Response | null {
  if (!appLock) return null;
  const pathname = new URL(req.url).pathname;
  appLock.evaluateLockState();
  if (appLock.isLocked()) {
    if (isPathAllowedWhileLocked(req.method, pathname)) return null;
    const current = appLock.status();
    return lockedResponse({
      failedAttempts: current.failedAttempts,
      cooldownUntil: current.cooldownUntil,
      retryAfterMs: current.retryAfterMs,
    });
  }
  const method = req.method.toUpperCase();
  if (
    method !== "GET"
    && method !== "HEAD"
    && method !== "OPTIONS"
    && pathname !== "/ui/api/app-lock/lock"
  ) {
    appLock.touchActivity();
  }
  return null;
}

export class AppLockService {
  readonly home: string;
  readonly configPath: string;
  readonly statePath: string;
  private readonly now: () => number;
  private readonly emitEvent?: (type: string, payload: Record<string, unknown>) => void;
  private config: AppLockConfigRecord | null = null;
  private failureState: AppLockFailureState = defaultFailureState();
  private locked = false;
  private corrupt = false;
  private lastActivityAt: number;
  private pendingVerify: Promise<unknown> = Promise.resolve();

  constructor(options: AppLockServiceOptions) {
    this.home = resolve(options.home);
    plainDirectory(this.home, true);
    this.configPath = join(this.home, APP_LOCK_CONFIG_FILE);
    this.statePath = join(this.home, APP_LOCK_STATE_FILE);
    this.now = options.now ?? (() => Date.now());
    this.emitEvent = options.emitEvent;
    this.lastActivityAt = this.now();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    this.corrupt = false;
    this.config = null;
    this.locked = false;

    try {
      const rawState = readPlainJsonFile(this.statePath);
      this.failureState = rawState === null ? defaultFailureState() : parseFailureState(rawState);
    } catch {
      this.failureState = defaultFailureState();
    }

    if (!workspaceEntryExists(this.configPath)) {
      return;
    }

    try {
      const rawConfig = readPlainJsonFile(this.configPath);
      if (rawConfig === null) return;
      this.config = parseConfigRecord(rawConfig);
      this.locked = this.config.enabled && this.config.lockOnStartup;
    } catch {
      // Fail closed if app-lock.json exists on disk but is corrupt or tampered.
      this.config = null;
      this.corrupt = true;
      this.locked = true;
    }
  }

  private persistFailureState(): void {
    plainDirectory(this.home, true);
    writeWorkspaceJson(this.statePath, this.failureState);
  }

  private persistConfig(record: AppLockConfigRecord): void {
    plainDirectory(this.home, true);
    writeWorkspaceJson(this.configPath, record);
    this.config = record;
    this.corrupt = false;
  }

  private removeConfig(): void {
    if (workspaceEntryExists(this.configPath)) {
      const stat = lstatSync(this.configPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("Linked app lock configuration cannot be removed");
      }
      rmSync(this.configPath, { force: true });
    }
    this.config = null;
    this.corrupt = false;
  }

  private resetFailureState(): void {
    this.failureState = defaultFailureState();
    this.persistFailureState();
  }

  private notifyChanged(reason: string): void {
    if (!this.emitEvent) return;
    try {
      this.emitEvent("app_lock_changed", {
        reason,
        status: this.status(),
      });
    } catch {
      // Event delivery must never interfere with lock transitions.
    }
  }

  /** Serialize password verification attempts so concurrent requests cannot bypass cooldown counts. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pendingVerify.then(work, work);
    this.pendingVerify = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Re-evaluate idle auto-lock timeout using the current wall clock. Returns true if currently locked. */
  evaluateLockState(): boolean {
    if (this.corrupt) {
      this.locked = true;
      return true;
    }
    if (!this.config?.enabled) {
      this.locked = false;
      return false;
    }
    if (this.locked) return true;
    const timeoutMinutes = this.config.idleTimeoutMinutes;
    if (timeoutMinutes > 0) {
      const elapsedMs = this.now() - this.lastActivityAt;
      if (elapsedMs >= timeoutMinutes * 60_000) {
        this.locked = true;
        this.notifyChanged("idle_timeout");
      }
    }
    return this.locked;
  }

  isLocked(): boolean {
    return this.evaluateLockState();
  }

  /** Update lastActivityAt if unlocked; returns false if already locked (e.g. overdue idle timeout). */
  touchActivity(): boolean {
    if (this.evaluateLockState()) return false;
    this.lastActivityAt = this.now();
    return true;
  }

  status(): AppLockStatus {
    this.evaluateLockState();
    const currentNow = this.now();
    const cooldownUntil = this.failureState.cooldownUntil > currentNow ? this.failureState.cooldownUntil : 0;
    const retryAfterMs = cooldownUntil > 0 ? cooldownUntil - currentNow : 0;
    return {
      configured: this.corrupt || this.config !== null,
      enabled: this.corrupt ? true : this.config?.enabled === true,
      locked: this.locked,
      lockOnStartup: this.config?.lockOnStartup ?? true,
      idleTimeoutMinutes: this.config?.idleTimeoutMinutes ?? 15,
      failedAttempts: this.failureState.failedAttempts,
      cooldownUntil,
      retryAfterMs,
      lastActivityAt: this.lastActivityAt,
      updatedAt: this.config?.updatedAt ?? null,
      corrupt: this.corrupt,
    };
  }

  async setup(input: AppLockSetupInput): Promise<AppLockStatus> {
    return this.enqueue(async () => {
      if (this.corrupt) {
        throw new AppLockError(
          "corrupt_config",
          "App lock configuration is damaged. Close the app and delete app-lock.json in your data directory to reset.",
          409,
        );
      }
      if (this.config?.enabled) {
        throw new AppLockError(
          "already_configured",
          "App lock is already enabled. Verify your current master password to change settings.",
          409,
        );
      }
      const password = validateAppLockPassword(input.password);
      const idleTimeoutMinutes = normalizeIdleTimeoutMinutes(input.idleTimeoutMinutes, 15);
      const lockOnStartup = input.lockOnStartup === undefined ? true : Boolean(input.lockOnStartup);
      const salt = randomBytes(APP_LOCK_SALT_BYTES);
      const verifier = await deriveAppLockVerifier(password, salt);
      try {
        const record: AppLockConfigRecord = {
          version: 1,
          enabled: true,
          kdf: "scrypt",
          kdfParams: { N: 32768, r: 8, p: 1, dkLen: 32 },
          saltHex: salt.toString("hex"),
          verifierHex: verifier.toString("hex"),
          idleTimeoutMinutes,
          lockOnStartup,
          updatedAt: this.now(),
        };
        this.persistConfig(record);
        this.resetFailureState();
        this.locked = false;
        this.lastActivityAt = this.now();
        this.notifyChanged("setup");
        return this.status();
      } finally {
        verifier.fill(0);
      }
    });
  }

  private async verifyPasswordOrThrow(password: unknown): Promise<void> {
    if (this.corrupt) {
      throw new AppLockError(
        "corrupt_config",
        "App lock configuration is damaged. Close the app and delete app-lock.json in your data directory to reset.",
        409,
      );
    }
    if (!this.config || !this.config.enabled) {
      throw new AppLockError("not_enabled", "App lock is not enabled.", 409);
    }

    const currentNow = this.now();
    if (this.failureState.cooldownUntil > currentNow) {
      const retryAfterMs = this.failureState.cooldownUntil - currentNow;
      throw new AppLockError(
        "app_lock_cooldown",
        `Too many failed attempts. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        429,
        {
          failedAttempts: this.failureState.failedAttempts,
          cooldownUntil: this.failureState.cooldownUntil,
          retryAfterMs,
        },
      );
    }

    if (typeof password !== "string" || password.length === 0 || Buffer.byteLength(password, "utf8") > APP_LOCK_MAX_PASSWORD_BYTES) {
      this.recordFailureAndThrow();
    }

    const salt = Buffer.from(this.config.saltHex, "hex");
    const stored = Buffer.from(this.config.verifierHex, "hex");
    const computed = await deriveAppLockVerifier(password, salt);
    let matches = false;
    try {
      matches = computed.length === stored.length && timingSafeEqual(computed, stored);
    } finally {
      computed.fill(0);
    }

    if (!matches) {
      this.recordFailureAndThrow();
    }

    if (this.failureState.failedAttempts > 0 || this.failureState.cooldownUntil > 0) {
      this.resetFailureState();
    }
  }

  private recordFailureAndThrow(): never {
    const currentNow = this.now();
    const failedAttempts = this.failureState.failedAttempts + 1;
    const cooldownMs = cooldownMsForFailureCount(failedAttempts);
    const cooldownUntil = cooldownMs > 0 ? currentNow + cooldownMs : 0;
    this.failureState = {
      version: 1,
      failedAttempts,
      cooldownUntil,
      lastFailedAt: currentNow,
    };
    this.persistFailureState();
    if (cooldownMs > 0) {
      throw new AppLockError(
        "app_lock_cooldown",
        `Incorrect master password. Too many failed attempts; try again in ${Math.ceil(cooldownMs / 1000)} seconds.`,
        429,
        {
          failedAttempts,
          cooldownUntil,
          retryAfterMs: cooldownMs,
        },
      );
    }
    throw new AppLockError(
      "wrong_password",
      "Incorrect master password.",
      401,
      {
        failedAttempts,
        cooldownUntil: 0,
        retryAfterMs: 0,
      },
    );
  }

  async unlock(password: unknown): Promise<AppLockStatus> {
    return this.enqueue(async () => {
      await this.verifyPasswordOrThrow(password);
      this.locked = false;
      this.lastActivityAt = this.now();
      this.notifyChanged("unlock");
      return this.status();
    });
  }

  lock(): AppLockStatus {
    if (this.corrupt) {
      this.locked = true;
      return this.status();
    }
    if (!this.config?.enabled) {
      throw new AppLockError("not_enabled", "Enable app lock before locking the application.", 409);
    }
    if (!this.locked) {
      this.locked = true;
      this.notifyChanged("manual_lock");
    }
    return this.status();
  }

  async configure(input: AppLockConfigureInput): Promise<AppLockStatus> {
    return this.enqueue(async () => {
      if (this.corrupt) {
        throw new AppLockError(
          "corrupt_config",
          "App lock configuration is damaged. Close the app and delete app-lock.json in your data directory to reset.",
          409,
        );
      }
      if (!this.config || !this.config.enabled) {
        throw new AppLockError("not_configured", "App lock is not enabled yet.", 409);
      }
      await this.verifyPasswordOrThrow(input.currentPassword);

      if (input.enabled === false) {
        this.removeConfig();
        this.resetFailureState();
        this.locked = false;
        this.lastActivityAt = this.now();
        this.notifyChanged("disabled");
        return this.status();
      }

      const idleTimeoutMinutes = normalizeIdleTimeoutMinutes(
        input.idleTimeoutMinutes,
        this.config.idleTimeoutMinutes,
      );
      const lockOnStartup =
        input.lockOnStartup === undefined ? this.config.lockOnStartup : Boolean(input.lockOnStartup);

      let saltHex = this.config.saltHex;
      let verifierHex = this.config.verifierHex;
      if (input.newPassword !== undefined) {
        const nextPassword = validateAppLockPassword(input.newPassword);
        const salt = randomBytes(APP_LOCK_SALT_BYTES);
        const verifier = await deriveAppLockVerifier(nextPassword, salt);
        try {
          saltHex = salt.toString("hex");
          verifierHex = verifier.toString("hex");
        } finally {
          verifier.fill(0);
        }
      }

      const updated: AppLockConfigRecord = {
        version: 1,
        enabled: true,
        kdf: "scrypt",
        kdfParams: { N: 32768, r: 8, p: 1, dkLen: 32 },
        saltHex,
        verifierHex,
        idleTimeoutMinutes,
        lockOnStartup,
        updatedAt: this.now(),
      };
      this.persistConfig(updated);
      this.lastActivityAt = this.now();
      this.notifyChanged("configured");
      return this.status();
    });
  }
}
