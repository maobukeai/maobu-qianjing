import { Database } from "bun:sqlite";
import { assertSafeProfileId } from "../../profile-id.ts";

export type ResourcePolicyMode = "inherit" | "on" | "off";

export interface ProfileDataSaverOverride {
  mode: ResourcePolicyMode;
  blockImages?: boolean;
  blockMedia?: boolean;
  blockFonts?: boolean;
}

export interface ProfileResourcePolicy {
  profileId: string;
  memorySaverMode: ResourcePolicyMode;
  dataSaver: ProfileDataSaverOverride;
  updatedAt: number;
}

export interface ProfileResourcePolicyPatch {
  memorySaverMode?: ResourcePolicyMode;
  dataSaver?: ResourcePolicyMode | ProfileDataSaverOverride | null;
}

export const PROFILE_RESOURCE_POLICIES_DDL = `
  CREATE TABLE IF NOT EXISTS profile_resource_policies (
    profile_id TEXT PRIMARY KEY,
    memory_saver_mode TEXT NOT NULL DEFAULT 'inherit',
    data_saver_json TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`;

const VALID_MODES: readonly ResourcePolicyMode[] = ["inherit", "on", "off"];

export function isResourcePolicyMode(value: unknown): value is ResourcePolicyMode {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

export function defaultProfileResourcePolicy(profileId: string): ProfileResourcePolicy {
  return {
    profileId,
    memorySaverMode: "inherit",
    dataSaver: { mode: "inherit" },
    updatedAt: 0,
  };
}

export function parseProfileDataSaverOverride(value: unknown): ProfileDataSaverOverride {
  if (value === null || value === undefined || value === "" || value === "inherit") {
    return { mode: "inherit" };
  }
  if (value === "off") return { mode: "off" };
  if (value === "on") return { mode: "on" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid data saver policy");
  }
  const raw = value as Record<string, unknown>;
  const allowedKeys = ["mode", "blockImages", "blockMedia", "blockFonts"];
  if (Object.keys(raw).some((key) => !allowedKeys.includes(key))) {
    throw new Error("Unknown data saver policy field");
  }
  if (!isResourcePolicyMode(raw.mode)) {
    throw new Error("dataSaver.mode must be 'inherit', 'on', or 'off'");
  }
  if (raw.mode === "inherit" || raw.mode === "off") {
    return { mode: raw.mode };
  }
  const out: ProfileDataSaverOverride = { mode: "on" };
  for (const key of ["blockImages", "blockMedia", "blockFonts"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") {
        throw new Error(`dataSaver.${key} must be a boolean`);
      }
      out[key] = raw[key];
    }
  }
  return out;
}

function decodeStoredDataSaver(raw: string): ProfileDataSaverOverride {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: "inherit" };
  try {
    return parseProfileDataSaverOverride(JSON.parse(trimmed));
  } catch {
    return { mode: "inherit" };
  }
}

function encodeStoredDataSaver(policy: ProfileDataSaverOverride): string {
  if (policy.mode === "inherit") return "";
  return JSON.stringify(policy);
}

interface PolicyRow {
  profile_id: string;
  memory_saver_mode: string;
  data_saver_json: string;
  updated_at: number;
}

function rowToPolicy(row: PolicyRow): ProfileResourcePolicy {
  return {
    profileId: row.profile_id,
    memorySaverMode: isResourcePolicyMode(row.memory_saver_mode) ? row.memory_saver_mode : "inherit",
    dataSaver: decodeStoredDataSaver(row.data_saver_json),
    updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : 0,
  };
}

/**
 * Per-profile resource policy overrides backed by SQLite table
 * `profile_resource_policies`. Uses idempotent `CREATE TABLE IF NOT EXISTS`
 * matching Schema v3 DDL so it runs cleanly both standalone and after migration.
 */
export class ResourcePolicyStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private closed = false;

  constructor(target: string | Database) {
    if (typeof target === "string") {
      this.db = new Database(target, { create: true });
      this.ownsDb = true;
      this.db.exec("PRAGMA busy_timeout = 1500;");
      if (target && target !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
    } else {
      this.db = target;
      this.ownsDb = false;
    }
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(PROFILE_RESOURCE_POLICIES_DDL);
  }

  get(profileId: string): ProfileResourcePolicy {
    assertSafeProfileId(profileId);
    const row = this.db
      .query<PolicyRow, [string]>(
        `SELECT profile_id, memory_saver_mode, data_saver_json, updated_at
         FROM profile_resource_policies
         WHERE profile_id = ?`,
      )
      .get(profileId);
    return row ? rowToPolicy(row) : defaultProfileResourcePolicy(profileId);
  }

  list(): ProfileResourcePolicy[] {
    const rows = this.db
      .query<PolicyRow, []>(
        `SELECT profile_id, memory_saver_mode, data_saver_json, updated_at
         FROM profile_resource_policies
         ORDER BY updated_at DESC, profile_id ASC`,
      )
      .all();
    return rows.map(rowToPolicy);
  }

  set(profileId: string, patch: unknown, now = Date.now()): ProfileResourcePolicy {
    assertSafeProfileId(profileId);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Resource policy update must be an object");
    }
    const raw = patch as Record<string, unknown>;
    if (Object.keys(raw).some((key) => key !== "memorySaverMode" && key !== "dataSaver")) {
      throw new Error("Unknown resource policy field");
    }
    const current = this.get(profileId);
    const memorySaverMode =
      raw.memorySaverMode === undefined
        ? current.memorySaverMode
        : isResourcePolicyMode(raw.memorySaverMode)
          ? raw.memorySaverMode
          : (() => {
              throw new Error("memorySaverMode must be 'inherit', 'on', or 'off'");
            })();
    const dataSaver =
      raw.dataSaver === undefined
        ? current.dataSaver
        : parseProfileDataSaverOverride(raw.dataSaver);
    const updatedAt = Math.trunc(now);

    if (memorySaverMode === "inherit" && dataSaver.mode === "inherit") {
      this.db.query("DELETE FROM profile_resource_policies WHERE profile_id = ?").run(profileId);
      return { profileId, memorySaverMode: "inherit", dataSaver: { mode: "inherit" }, updatedAt };
    }

    this.db
      .query(
        `INSERT INTO profile_resource_policies (profile_id, memory_saver_mode, data_saver_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(profile_id) DO UPDATE SET
           memory_saver_mode = excluded.memory_saver_mode,
           data_saver_json = excluded.data_saver_json,
           updated_at = excluded.updated_at`,
      )
      .run(profileId, memorySaverMode, encodeStoredDataSaver(dataSaver), updatedAt);

    return { profileId, memorySaverMode, dataSaver, updatedAt };
  }

  delete(profileId: string): boolean {
    assertSafeProfileId(profileId);
    const result = this.db.query("DELETE FROM profile_resource_policies WHERE profile_id = ?").run(profileId);
    return result.changes > 0;
  }

  close(): void {
    if (!this.ownsDb || this.closed) return;
    this.closed = true;
    try {
      this.db.close(true);
    } catch {
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
      this.db.close();
    }
  }
}
