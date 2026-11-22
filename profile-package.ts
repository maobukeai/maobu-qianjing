import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { generateId } from "./create.ts";
import { deriveWorkspacePasswordKey } from "./encrypted-sync.ts";
import { normalizeChromiumRuntime, normalizeProfileEngine } from "./firefox-config.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { recordProfileEvent } from "./profile-timeline.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { normalizeProxySpec, proxyHostPort } from "./proxy.ts";
import { parseCapturedSessionBundle } from "./session.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";
import { ALIASMODE_VERSION } from "./version.ts";

export const PROFILE_PACKAGE_MAGIC = Buffer.from("MAOBU-PROFILE\0v1\n");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const PROFILE_PACKAGE_HEADER_BYTES = PROFILE_PACKAGE_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
export const MAX_PROFILE_PACKAGE_BYTES = 64 * 1024 ** 2;
export const MAX_PROFILE_PACKAGE_PROFILES = 2000;
export const MIN_PACKAGE_PASSWORD_BYTES = 10;
export const MAX_PACKAGE_PASSWORD_BYTES = 1024;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const MAX_ACTIVE_PREVIEWS = 4;

const PROFILE_FIELDS = new Set([
  "id", "engine", "chromiumRuntime", "hardware", "firefox", "accId", "name", "group", "platform",
  "username", "password", "email", "emailPassword", "twofa", "proxy", "proxyError", "extensions",
  "tags", "notes", "customNo", "ua", "timezone", "timezoneManual", "displayScale", "locale",
  "screenWidth", "screenHeight", "fingerprintSeed", "platformOs", "fpObserved", "fpExpected",
  "fpVerdict", "cookies", "seeded",
]);

const PAYLOAD_FIELDS = new Set([
  "version", "kind", "appVersion", "exportedAt", "includeSecrets", "includeSessions", "profiles", "sessions",
]);

export interface ProfilePackagePayload {
  version: 1;
  kind: "mqprofile";
  appVersion: string;
  exportedAt: number;
  includeSecrets: boolean;
  includeSessions: boolean;
  profiles: Profile[];
  sessions: Record<string, string>;
}

export type ProfilePackageConflictReason = "existing_active" | "existing_trashed" | "running";
export type ProfilePackageConflictStrategy = "skip" | "clone_new_id" | "overwrite_closed";

export interface ProfilePackagePreviewItem {
  id: string;
  name: string;
  group: string;
  engine: "chromium" | "firefox";
  platform: string;
  tags: string[];
  hasProxy: boolean;
  proxyDisplay: string | null;
  hasSession: boolean;
  hasNotes: boolean;
  conflict: boolean;
  conflictReason: ProfilePackageConflictReason | null;
}

export interface ProfilePackagePreview {
  previewId: string;
  previewToken: string;
  expiresAt: number;
  sha256: string;
  appVersion: string;
  exportedAt: number;
  includeSecrets: boolean;
  includeSessions: boolean;
  profileCount: number;
  sessionCount: number;
  newCount: number;
  conflictCount: number;
  runningConflictCount: number;
  trashedConflictCount: number;
  profiles: ProfilePackagePreviewItem[];
}

export interface ProfilePackageImportItemResult {
  sourceId: string;
  targetId: string | null;
  name: string;
  action: "imported" | "cloned" | "overwritten" | "skipped";
  reason?: ProfilePackageConflictReason | "engine_mismatch" | "not_selected";
}

export interface ProfilePackageImportResult {
  strategy: ProfilePackageConflictStrategy;
  importedCount: number;
  clonedCount: number;
  overwrittenCount: number;
  skippedCount: number;
  items: ProfilePackageImportItemResult[];
}

export class ProfilePackageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProfilePackageError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validatePackagePassword(password: unknown): asserts password is string {
  if (typeof password !== "string") {
    throw new ProfilePackageError(
      `Package password must be between ${MIN_PACKAGE_PASSWORD_BYTES} and ${MAX_PACKAGE_PASSWORD_BYTES} UTF-8 bytes.`,
      "invalid_password",
      400,
    );
  }
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < MIN_PACKAGE_PASSWORD_BYTES || bytes > MAX_PACKAGE_PASSWORD_BYTES) {
    throw new ProfilePackageError(
      `Package password must be between ${MIN_PACKAGE_PASSWORD_BYTES} and ${MAX_PACKAGE_PASSWORD_BYTES} UTF-8 bytes.`,
      "invalid_password",
      400,
    );
  }
}

function validatePackageSession(bundle: unknown): asserts bundle is string {
  if (typeof bundle !== "string" || Buffer.byteLength(bundle, "utf8") > MAX_PROFILE_PACKAGE_BYTES) {
    throw new ProfilePackageError("Invalid saved session in profile package.", "invalid_session", 400);
  }
  try {
    const parsed: unknown = JSON.parse(bundle);
    if (!isPlainObject(parsed)) throw new Error("invalid");
    parseCapturedSessionBundle(
      JSON.stringify({ ...parsed, origins: parsed.origins === undefined ? [] : parsed.origins }),
    );
  } catch {
    throw new ProfilePackageError("Invalid saved session in profile package.", "invalid_session", 400);
  }
}

function assertPayloadBudget(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 64) {
      throw new ProfilePackageError("Profile package structure is too complex.", "package_too_complex", 400);
    }
    if (typeof entry === "string") bytes += Buffer.byteLength(entry, "utf8");
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null || entry === undefined) bytes += 8;
    else if (typeof entry === "object") {
      if (ancestors.has(entry)) {
        throw new ProfilePackageError("Profile package cannot contain cyclic data.", "invalid_package", 400);
      }
      ancestors.add(entry);
      bytes += 2;
      if (Array.isArray(entry)) {
        for (const item of entry) {
          bytes += 1;
          visit(item, depth + 1);
        }
      } else {
        for (const [key, item] of Object.entries(entry)) {
          bytes += Buffer.byteLength(key, "utf8") + 4;
          visit(item, depth + 1);
        }
      }
      ancestors.delete(entry);
    } else {
      throw new ProfilePackageError("Profile package must contain JSON data.", "invalid_package", 400);
    }
    if (bytes > MAX_PROFILE_PACKAGE_BYTES) {
      throw new ProfilePackageError("Profile package exceeds the 64 MiB size limit.", "package_too_large", 413);
    }
  };
  visit(value, 0);
}

export function validateProfilePackage(value: unknown): ProfilePackagePayload {
  assertPayloadBudget(value);
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    value.kind !== "mqprofile" ||
    Object.keys(value).some((key) => !PAYLOAD_FIELDS.has(key)) ||
    typeof value.appVersion !== "string" ||
    value.appVersion.length > 100 ||
    !Number.isSafeInteger(value.exportedAt) ||
    (value.exportedAt as number) < 0 ||
    typeof value.includeSecrets !== "boolean" ||
    typeof value.includeSessions !== "boolean" ||
    !Array.isArray(value.profiles) ||
    value.profiles.length < 1 ||
    value.profiles.length > MAX_PROFILE_PACKAGE_PROFILES ||
    !isPlainObject(value.sessions)
  ) {
    throw new ProfilePackageError("Invalid encrypted profile package payload.", "invalid_package", 400);
  }

  const ids = new Set<string>();
  const casefoldIds = new Set<string>();
  for (const profile of value.profiles) {
    try {
      assertValidProfile(profile);
    } catch (error) {
      throw new ProfilePackageError(
        error instanceof Error ? error.message : "Invalid profile in package.",
        "invalid_profile",
        400,
      );
    }
    if (Object.keys(profile).some((key) => !PROFILE_FIELDS.has(key))) {
      throw new ProfilePackageError("Unsupported profile fields in profile package.", "unsupported_fields", 400);
    }
    if (profile.proxy) {
      try {
        normalizeProxySpec(profile.proxy);
      } catch (error) {
        throw new ProfilePackageError(
          error instanceof Error ? error.message : "Invalid proxy in profile package.",
          "invalid_proxy",
          400,
        );
      }
    }
    const lower = profile.id.toLowerCase();
    if (ids.has(profile.id) || casefoldIds.has(lower)) {
      throw new ProfilePackageError("Duplicate profile ID in profile package.", "duplicate_profile_id", 400);
    }
    ids.add(profile.id);
    casefoldIds.add(lower);
  }

  for (const [id, bundle] of Object.entries(value.sessions)) {
    if (!ids.has(id)) {
      throw new ProfilePackageError("Saved session has no matching profile in package.", "orphan_session", 400);
    }
    validatePackageSession(bundle);
  }

  return structuredClone(value) as unknown as ProfilePackagePayload;
}

export interface CreateProfilePackageOptions {
  sessions?: ReadonlyMap<string, string> | Record<string, string>;
  includeSecrets?: boolean;
  includeSessions?: boolean;
  now?: number;
  appVersion?: string;
}

export function createProfilePackage(
  profiles: readonly Profile[],
  options: CreateProfilePackageOptions = {},
): ProfilePackagePayload {
  const includeSecrets = options.includeSecrets !== false;
  const includeSessions = options.includeSessions !== false;
  const clonedProfiles = profiles.map((profile) => {
    const copy = structuredClone(profile);
    if (!includeSecrets) {
      copy.password = "";
      copy.emailPassword = "";
      copy.twofa = "";
      if (copy.proxy) {
        copy.proxy = { ...copy.proxy, user: "", pass: "" };
      }
    }
    return copy;
  });

  const sessionMap: Record<string, string> = {};
  if (includeSessions && options.sessions) {
    const entries =
      options.sessions instanceof Map ? Array.from(options.sessions.entries()) : Object.entries(options.sessions);
    const idSet = new Set(clonedProfiles.map((profile) => profile.id));
    for (const [id, bundle] of entries) {
      if (idSet.has(id) && typeof bundle === "string" && bundle.length > 0) {
        sessionMap[id] = bundle;
      }
    }
  }

  return validateProfilePackage({
    version: 1,
    kind: "mqprofile",
    appVersion: options.appVersion ?? ALIASMODE_VERSION,
    exportedAt: options.now ?? Date.now(),
    includeSecrets,
    includeSessions,
    profiles: clonedProfiles,
    sessions: sessionMap,
  });
}

export async function sealProfilePackage(value: ProfilePackagePayload, password: string): Promise<Buffer> {
  validatePackagePassword(password);
  const payload = validateProfilePackage(value);
  const cleartext = Buffer.from(JSON.stringify(payload), "utf8");
  if (cleartext.length > MAX_PROFILE_PACKAGE_BYTES) {
    cleartext.fill(0);
    throw new ProfilePackageError("Profile package exceeds the 64 MiB size limit.", "package_too_large", 413);
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const aad = Buffer.concat([PROFILE_PACKAGE_MAGIC, salt, iv]);
  let key: Buffer | undefined;
  try {
    key = await deriveWorkspacePasswordKey(password, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    return Buffer.concat([aad, cipher.getAuthTag(), encrypted]);
  } finally {
    key?.fill(0);
    cleartext.fill(0);
  }
}

export async function openProfilePackage(data: Uint8Array, password: string): Promise<ProfilePackagePayload> {
  validatePackagePassword(password);
  if (
    !(data instanceof Uint8Array) ||
    data.byteLength < PROFILE_PACKAGE_HEADER_BYTES ||
    data.byteLength > MAX_PROFILE_PACKAGE_BYTES + PROFILE_PACKAGE_HEADER_BYTES
  ) {
    throw new ProfilePackageError(
      "Invalid or oversized encrypted profile package.",
      "invalid_package_size",
      400,
    );
  }
  const bytes = Buffer.from(data);
  if (!bytes.subarray(0, PROFILE_PACKAGE_MAGIC.length).equals(PROFILE_PACKAGE_MAGIC)) {
    throw new ProfilePackageError(
      "Unsupported encrypted profile package format.",
      "unsupported_format",
      400,
    );
  }
  const saltEnd = PROFILE_PACKAGE_MAGIC.length + SALT_BYTES;
  const ivEnd = saltEnd + IV_BYTES;
  const salt = bytes.subarray(PROFILE_PACKAGE_MAGIC.length, saltEnd);
  const iv = bytes.subarray(saltEnd, ivEnd);
  let key: Buffer | undefined;
  let cleartext: Buffer | undefined;
  let parsed: unknown;
  try {
    key = await deriveWorkspacePasswordKey(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(bytes.subarray(0, ivEnd));
    decipher.setAuthTag(bytes.subarray(ivEnd, PROFILE_PACKAGE_HEADER_BYTES));
    cleartext = Buffer.concat([decipher.update(bytes.subarray(PROFILE_PACKAGE_HEADER_BYTES)), decipher.final()]);
    parsed = JSON.parse(cleartext.toString("utf8"));
  } catch {
    throw new ProfilePackageError(
      "Unable to unlock profile package. Check the password and file integrity.",
      "decrypt_failed",
      400,
    );
  } finally {
    key?.fill(0);
    cleartext?.fill(0);
  }
  return validateProfilePackage(parsed);
}

export function buildProfilePackagePreviewItems(
  payload: ProfilePackagePayload,
  store: Pick<ProfileStore, "listProfiles" | "listTrashed" | "listLaunches">,
): {
  profiles: ProfilePackagePreviewItem[];
  newCount: number;
  conflictCount: number;
  runningConflictCount: number;
  trashedConflictCount: number;
} {
  const runningIds = new Set(store.listLaunches().map((launch) => launch.profileId.toLowerCase()));
  const trashedIds = new Set(store.listTrashed().map((item) => item.id.toLowerCase()));
  const activeIds = new Set(store.listProfiles().map((profile) => profile.id.toLowerCase()));

  let runningConflictCount = 0;
  let trashedConflictCount = 0;
  let conflictCount = 0;

  const profiles: ProfilePackagePreviewItem[] = payload.profiles.map((profile) => {
    const lower = profile.id.toLowerCase();
    let conflictReason: ProfilePackageConflictReason | null = null;
    if (runningIds.has(lower)) {
      conflictReason = "running";
      runningConflictCount++;
      conflictCount++;
    } else if (trashedIds.has(lower)) {
      conflictReason = "existing_trashed";
      trashedConflictCount++;
      conflictCount++;
    } else if (activeIds.has(lower)) {
      conflictReason = "existing_active";
      conflictCount++;
    }

    return {
      id: profile.id,
      name: profile.name,
      group: profile.group,
      engine: profile.engine === "firefox" ? "firefox" : "chromium",
      platform: profile.platform ?? "",
      tags: [...(profile.tags ?? [])],
      hasProxy: !!profile.proxy,
      proxyDisplay: profile.proxy ? proxyHostPort(profile.proxy) : null,
      hasSession: Object.hasOwn(payload.sessions, profile.id),
      hasNotes: !!(profile.notes && profile.notes.trim()),
      conflict: conflictReason !== null,
      conflictReason,
    };
  });

  return {
    profiles,
    newCount: profiles.length - conflictCount,
    conflictCount,
    runningConflictCount,
    trashedConflictCount,
  };
}

interface StoredPackagePreview {
  previewId: string;
  workspaceId: string;
  sha256: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  payload: ProfilePackagePayload;
}

export class ProfilePackagePreviewStore {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, StoredPackagePreview>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowFn: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_ACTIVE_PREVIEWS;
    this.nowFn = options.now ?? (() => Date.now());
  }

  private pruneExpired(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  private sign(workspaceId: string, previewId: string, sha256: string): string {
    return createHmac("sha256", this.secret)
      .update(`${workspaceId}\0${previewId}\0${sha256}`)
      .digest("hex");
  }

  create(
    payload: ProfilePackagePayload,
    rawBytes: Uint8Array,
    store: Pick<ProfileStore, "listProfiles" | "listTrashed" | "listLaunches">,
    workspaceId = "default",
  ): ProfilePackagePreview {
    const now = this.nowFn();
    this.pruneExpired(now);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }

    const previewId = `pkg_${randomBytes(16).toString("hex")}`;
    const sha256 = createHash("sha256").update(rawBytes).digest("hex");
    const previewToken = this.sign(workspaceId, previewId, sha256);
    const expiresAt = now + this.ttlMs;

    this.entries.set(previewId, {
      previewId,
      workspaceId,
      sha256,
      token: previewToken,
      createdAt: now,
      expiresAt,
      payload: structuredClone(payload),
    });

    const summary = buildProfilePackagePreviewItems(payload, store);
    return {
      previewId,
      previewToken,
      expiresAt,
      sha256,
      appVersion: payload.appVersion,
      exportedAt: payload.exportedAt,
      includeSecrets: payload.includeSecrets,
      includeSessions: payload.includeSessions,
      profileCount: payload.profiles.length,
      sessionCount: Object.keys(payload.sessions).length,
      ...summary,
    };
  }

  /** Verify and consume a preview entry atomically (one-time use). */
  consume(previewId: unknown, previewToken: unknown, workspaceId = "default"): ProfilePackagePayload {
    const now = this.nowFn();
    this.pruneExpired(now);

    if (
      typeof previewId !== "string" ||
      !/^pkg_[a-f0-9]{32}$/.test(previewId) ||
      typeof previewToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(previewToken)
    ) {
      throw new ProfilePackageError(
        "Package preview token is invalid or expired. Decrypt the package again.",
        "invalid_preview",
        400,
      );
    }

    const entry = this.entries.get(previewId);
    if (!entry || entry.expiresAt <= now || entry.workspaceId !== workspaceId) {
      if (entry && entry.expiresAt <= now) this.entries.delete(previewId);
      throw new ProfilePackageError(
        "Package preview token is invalid or expired. Decrypt the package again.",
        "invalid_preview",
        409,
      );
    }

    const expected = this.sign(workspaceId, previewId, entry.sha256);
    const valid =
      Buffer.byteLength(previewToken) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(previewToken), Buffer.from(expected));

    if (!valid) {
      throw new ProfilePackageError(
        "Package preview token is invalid or expired. Decrypt the package again.",
        "invalid_preview",
        403,
      );
    }

    // One-time use: burn immediately upon verified consumption.
    this.entries.delete(previewId);
    return entry.payload;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    this.pruneExpired(this.nowFn());
    return this.entries.size;
  }
}

export interface ApplyProfilePackageImportOptions {
  strategy: ProfilePackageConflictStrategy;
  selectedIds?: readonly string[];
  cloneNameSuffix?: string;
}

export function isValidConflictStrategy(value: unknown): value is ProfilePackageConflictStrategy {
  return value === "skip" || value === "clone_new_id" || value === "overwrite_closed";
}

export function applyProfilePackageImport(
  store: ProfileStore,
  payload: ProfilePackagePayload,
  options: ApplyProfilePackageImportOptions,
): ProfilePackageImportResult {
  if (!isValidConflictStrategy(options.strategy)) {
    throw new ProfilePackageError(
      "Conflict strategy must be skip, clone_new_id, or overwrite_closed.",
      "invalid_strategy",
      400,
    );
  }

  const cloneSuffix = options.cloneNameSuffix ?? " (导入)";
  let selectedSet: Set<string> | null = null;
  if (options.selectedIds !== undefined) {
    if (!Array.isArray(options.selectedIds) || options.selectedIds.some((id) => !isSafeProfileId(id))) {
      throw new ProfilePackageError("Selected profile IDs are invalid.", "invalid_selected_ids", 400);
    }
    selectedSet = new Set(options.selectedIds);
  }

  const result = store.withTransaction(() => {
    const activeProfiles = store.listProfiles();
    const activeByLower = new Map<string, Profile>(
      activeProfiles.map((profile) => [profile.id.toLowerCase(), profile]),
    );
    const trashedLower = new Set(store.listTrashed().map((item) => item.id.toLowerCase()));
    const runningLower = new Set(store.listLaunches().map((launch) => launch.profileId.toLowerCase()));
    const occupiedLower = new Set<string>([
      ...activeByLower.keys(),
      ...trashedLower,
      ...runningLower,
    ]);

    const items: ProfilePackageImportItemResult[] = [];
    const toUpsert: Profile[] = [];
    const sessionsToRestore = new Map<string, string>();

    let importedCount = 0;
    let clonedCount = 0;
    let overwrittenCount = 0;
    let skippedCount = 0;

    for (const incoming of payload.profiles) {
      if (selectedSet && !selectedSet.has(incoming.id)) {
        skippedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: null,
          name: incoming.name,
          action: "skipped",
          reason: "not_selected",
        });
        continue;
      }

      const lower = incoming.id.toLowerCase();
      const isRunning = runningLower.has(lower);
      const isTrashed = trashedLower.has(lower);
      const existingActive = activeByLower.get(lower);
      const conflictReason: ProfilePackageConflictReason | null = isRunning
        ? "running"
        : isTrashed
          ? "existing_trashed"
          : existingActive
            ? "existing_active"
            : null;

      const incomingSession = Object.hasOwn(payload.sessions, incoming.id)
        ? payload.sessions[incoming.id]
        : undefined;

      if (!conflictReason) {
        const nextProfile: Profile = {
          ...structuredClone(incoming),
          notes: incoming.notes ?? "",
        };
        occupiedLower.add(lower);
        toUpsert.push(nextProfile);
        if (incomingSession !== undefined) sessionsToRestore.set(nextProfile.id, incomingSession);
        importedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: nextProfile.id,
          name: nextProfile.name,
          action: "imported",
        });
        continue;
      }

      if (options.strategy === "skip") {
        skippedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: null,
          name: incoming.name,
          action: "skipped",
          reason: conflictReason,
        });
        continue;
      }

      if (options.strategy === "clone_new_id") {
        const newId = generateId((candidate) => occupiedLower.has(candidate.toLowerCase()));
        occupiedLower.add(newId.toLowerCase());
        const cloned: Profile = {
          ...structuredClone(incoming),
          id: newId,
          name: `${incoming.name}${cloneSuffix}`,
          notes: incoming.notes ?? "",
        };
        toUpsert.push(cloned);
        if (incomingSession !== undefined) sessionsToRestore.set(newId, incomingSession);
        clonedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: newId,
          name: cloned.name,
          action: "cloned",
        });
        continue;
      }

      // strategy === "overwrite_closed": running and trashed profiles are ALWAYS skipped.
      if (isRunning || isTrashed || !existingActive) {
        skippedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: null,
          name: incoming.name,
          action: "skipped",
          reason: isRunning ? "running" : "existing_trashed",
        });
        continue;
      }

      const existingEngine = normalizeProfileEngine(existingActive.engine, existingActive.firefox).engine;
      const incomingEngine = normalizeProfileEngine(incoming.engine, incoming.firefox).engine;
      const existingRuntime = normalizeChromiumRuntime(existingActive.chromiumRuntime, existingEngine);
      const incomingRuntime = normalizeChromiumRuntime(incoming.chromiumRuntime, incomingEngine);

      if (existingEngine !== incomingEngine || existingRuntime !== incomingRuntime) {
        skippedCount++;
        items.push({
          sourceId: incoming.id,
          targetId: null,
          name: incoming.name,
          action: "skipped",
          reason: "engine_mismatch",
        });
        continue;
      }

      const overwritten: Profile = {
        ...structuredClone(incoming),
        id: existingActive.id,
        notes: incoming.notes ?? "",
      };
      toUpsert.push(overwritten);
      if (incomingSession !== undefined) sessionsToRestore.set(overwritten.id, incomingSession);
      overwrittenCount++;
      items.push({
        sourceId: incoming.id,
        targetId: overwritten.id,
        name: overwritten.name,
        action: "overwritten",
      });
    }

    if (toUpsert.length > 0) {
      store.upsertProfiles(toUpsert, sessionsToRestore);
    }

    return {
      strategy: options.strategy,
      importedCount,
      clonedCount,
      overwrittenCount,
      skippedCount,
      items,
    };
  }, "immediate");

  // Record timeline events post-COMMIT (failures never abort the completed import).
  for (const item of result.items) {
    if (!item.targetId) continue;
    recordProfileEvent(store, {
      profileId: item.targetId,
      eventType: "package.imported",
      status: "ok",
      actor: "user",
      summary:
        item.action === "cloned"
          ? `Imported from encrypted package as cloned copy (${item.sourceId}).`
          : item.action === "overwritten"
            ? "Overwritten from encrypted profile package."
            : "Imported from encrypted profile package.",
      detail: {
        action: item.action,
        strategy: options.strategy,
        includeSecrets: payload.includeSecrets,
        includeSessions: payload.includeSessions,
      },
    });
  }

  return result;
}
