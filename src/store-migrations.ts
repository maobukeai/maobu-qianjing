import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isEncryptedSecret, type LocalSecretProtector } from "../dpapi.ts";

export const CURRENT_SCHEMA_VERSION = 4;

function existingColumns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

function addMissingColumns(db: Database, table: string, definitions: readonly string[]): boolean {
  const present = existingColumns(db, table);
  let changed = false;
  for (const def of definitions) {
    const colName = def.trim().split(/\s+/)[0]!;
    if (!present.has(colName)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
      changed = true;
    }
  }
  return changed;
}

function ensureSchemaAndColumns(db: Database): boolean {
  let schemaChanged = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL DEFAULT 'chromium',
      chromium_runtime TEXT NOT NULL DEFAULT '',
      hardware_json TEXT NOT NULL DEFAULT '',
      firefox_config_json TEXT NOT NULL DEFAULT '',
      acc_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      "group" TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      email_password TEXT NOT NULL DEFAULT '',
      twofa TEXT NOT NULL DEFAULT '',
      proxy_json TEXT,
      ua TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '',
      timezone_manual INTEGER NOT NULL DEFAULT 0,
      display_scale REAL NOT NULL DEFAULT 0,
      locale TEXT NOT NULL DEFAULT '',
      screen_width INTEGER NOT NULL DEFAULT 1920,
      screen_height INTEGER NOT NULL DEFAULT 1080,
      fingerprint_seed INTEGER NOT NULL,
      platform_os TEXT NOT NULL DEFAULT '',
      fp_observed_json TEXT NOT NULL DEFAULT '',
      fp_expected_json TEXT NOT NULL DEFAULT '',
      fp_verdict_json TEXT NOT NULL DEFAULT '',
      fp_source_json TEXT NOT NULL DEFAULT '',
      cookies_json TEXT NOT NULL DEFAULT '[]',
      seeded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_open_at INTEGER NOT NULL DEFAULT 0,
      incarnation TEXT NOT NULL DEFAULT ''
    );
  `);

  if (addMissingColumns(db, "profiles", [
    "acc_id TEXT NOT NULL DEFAULT ''",
    "trashed_at INTEGER NOT NULL DEFAULT 0",
    "pending_cookies_json TEXT NOT NULL DEFAULT '[]'",
    "engine TEXT NOT NULL DEFAULT 'chromium'",
    "firefox_config_json TEXT NOT NULL DEFAULT ''",
    "chromium_runtime TEXT NOT NULL DEFAULT ''",
    "hardware_json TEXT NOT NULL DEFAULT ''",
    "timezone_manual INTEGER NOT NULL DEFAULT 0",
    "display_scale REAL NOT NULL DEFAULT 0",
    "timezone TEXT NOT NULL DEFAULT ''",
    "platform TEXT NOT NULL DEFAULT ''",
    "email TEXT NOT NULL DEFAULT ''",
    "email_password TEXT NOT NULL DEFAULT ''",
    "extensions_json TEXT NOT NULL DEFAULT '[]'",
    "tags_json TEXT NOT NULL DEFAULT '[]'",
    "notes TEXT NOT NULL DEFAULT ''",
    "proxy_error TEXT",
    "custom_no TEXT NOT NULL DEFAULT ''",
    "platform_os TEXT NOT NULL DEFAULT ''",
    "locale TEXT NOT NULL DEFAULT ''",
    "fp_observed_json TEXT NOT NULL DEFAULT ''",
    "fp_expected_json TEXT NOT NULL DEFAULT ''",
    "fp_verdict_json TEXT NOT NULL DEFAULT ''",
    "fp_source_json TEXT NOT NULL DEFAULT ''",
    "session_json TEXT NOT NULL DEFAULT ''",
    "session_restore_pending INTEGER NOT NULL DEFAULT 0",
    "created_at INTEGER NOT NULL DEFAULT 0",
    "last_open_at INTEGER NOT NULL DEFAULT 0",
    "incarnation TEXT NOT NULL DEFAULT ''",
  ])) schemaChanged = true;

  db.exec(`
    CREATE TABLE IF NOT EXISTS launches (
      profile_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      debug_port INTEGER NOT NULL,
      ws TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      relay_port INTEGER,
      binary_path TEXT,
      user_data_dir TEXT,
      binary_sha256 TEXT,
      persona_digest TEXT,
      headless INTEGER,
      search_bootstrap_revision INTEGER,
      process_group_id INTEGER,
      root_start_time TEXT,
      engine TEXT,
      firefox_owner_json TEXT,
      owner_binary_path TEXT
    );
  `);

  if (addMissingColumns(db, "launches", [
    "relay_port INTEGER",
    "binary_path TEXT",
    "user_data_dir TEXT",
    "binary_sha256 TEXT",
    "persona_digest TEXT",
    "headless INTEGER",
    "search_bootstrap_revision INTEGER",
    "process_group_id INTEGER",
    "root_start_time TEXT",
    "engine TEXT",
    "firefox_owner_json TEXT",
    "owner_binary_path TEXT",
    "persona_json TEXT",
  ])) schemaChanged = true;

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      name TEXT PRIMARY KEY,
      extension_defaults_json TEXT NOT NULL DEFAULT '[]'
    );
  `);
  if (addMissingColumns(db, "groups", [
    "extension_defaults_json TEXT NOT NULL DEFAULT '[]'",
    "parent_name TEXT",
    "label TEXT",
  ])) schemaChanged = true;

  db.exec(`INSERT OR IGNORE INTO groups (name) SELECT DISTINCT "group" FROM profiles WHERE "group" <> '' AND trashed_at = 0`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_temporary_profiles (
      profile_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      load_dir TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_vault (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      "group" TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      auth_encrypted TEXT NOT NULL DEFAULT '',
      has_auth INTEGER NOT NULL DEFAULT 0,
      endpoint_hash TEXT NOT NULL,
      refresh_url_encrypted TEXT NOT NULL DEFAULT '',
      has_refresh_url INTEGER NOT NULL DEFAULT 0,
      refresh_url_host TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      last_status TEXT NOT NULL DEFAULT 'unchecked',
      last_reason TEXT NOT NULL DEFAULT '',
      last_latency_ms INTEGER,
      last_exit_ip TEXT NOT NULL DEFAULT '',
      last_exit_country TEXT NOT NULL DEFAULT '',
      last_exit_region TEXT NOT NULL DEFAULT '',
      last_exit_city TEXT NOT NULL DEFAULT '',
      last_exit_rotating INTEGER NOT NULL DEFAULT 0,
      last_exit_comparison TEXT NOT NULL DEFAULT '',
      last_checked_at INTEGER NOT NULL DEFAULT 0,
      last_refreshed_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_vault_group ON proxy_vault("group");
    CREATE INDEX IF NOT EXISTS idx_proxy_vault_endpoint_hash ON proxy_vault(endpoint_hash);
    CREATE INDEX IF NOT EXISTS idx_proxy_vault_exit_ip ON proxy_vault(last_exit_ip);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_proxy_bindings (
      profile_id TEXT PRIMARY KEY,
      proxy_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      synced_endpoint_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_proxy_bindings_proxy ON profile_proxy_bindings(proxy_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_resource_policies (
      profile_id TEXT PRIMARY KEY,
      memory_saver_mode TEXT NOT NULL DEFAULT 'inherit',
      data_saver_json TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      summary TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      recovery_kind TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_events_profile_time ON profile_events(profile_id, created_at DESC, id DESC);
  `);

  const missing = db.query<{ id: string }, []>("SELECT id FROM profiles WHERE incarnation = ''").all();
  const fill = db.query("UPDATE profiles SET incarnation = ? WHERE id = ? AND incarnation = ''");
  for (const row of missing) fill.run(randomUUID(), row.id);
  return schemaChanged;
}

interface PlaintextSensitiveRow {
  id: string;
  password: string;
  email_password: string;
  twofa: string;
  proxy_json: string | null;
  cookies_json: string;
  session_json: string;
  pending_cookies_json: string;
}

function migrateToV2EncryptSensitiveColumns(db: Database, protector: LocalSecretProtector): void {
  const rows = db.query<PlaintextSensitiveRow, []>(
    `SELECT id, password, email_password, twofa, proxy_json, cookies_json, session_json, pending_cookies_json FROM profiles`,
  ).all();
  const update = db.query(
    `UPDATE profiles
     SET password = ?, email_password = ?, twofa = ?, proxy_json = ?, cookies_json = ?, session_json = ?, pending_cookies_json = ?
     WHERE id = ?`,
  );
  for (const row of rows) {
    const password = row.password && !isEncryptedSecret(row.password) ? protector.encrypt(row.password) : row.password;
    const emailPassword = row.email_password && !isEncryptedSecret(row.email_password) ? protector.encrypt(row.email_password) : row.email_password;
    const twofa = row.twofa && !isEncryptedSecret(row.twofa) ? protector.encrypt(row.twofa) : row.twofa;
    const proxyJson = row.proxy_json && !isEncryptedSecret(row.proxy_json) ? protector.encrypt(row.proxy_json) : row.proxy_json;
    const cookiesJson = row.cookies_json && !isEncryptedSecret(row.cookies_json) ? protector.encrypt(row.cookies_json) : row.cookies_json;
    const sessionJson = row.session_json && !isEncryptedSecret(row.session_json) ? protector.encrypt(row.session_json) : row.session_json;
    const pendingCookiesJson =
      row.pending_cookies_json && row.pending_cookies_json !== "[]" && !isEncryptedSecret(row.pending_cookies_json)
        ? protector.encrypt(row.pending_cookies_json)
        : row.pending_cookies_json;

    if (
      password !== row.password ||
      emailPassword !== row.email_password ||
      twofa !== row.twofa ||
      proxyJson !== row.proxy_json ||
      cookiesJson !== row.cookies_json ||
      sessionJson !== row.session_json ||
      pendingCookiesJson !== row.pending_cookies_json
    ) {
      update.run(password, emailPassword, twofa, proxyJson, cookiesJson, sessionJson, pendingCookiesJson, row.id);
    }
  }
}

interface PlaintextProxyVaultRow {
  id: string;
  auth_encrypted: string;
  refresh_url_encrypted: string;
}

function migrateEncryptProxyVaultSensitiveColumns(db: Database, protector: LocalSecretProtector): void {
  const rows = db.query<PlaintextProxyVaultRow, []>(
    `SELECT id, auth_encrypted, refresh_url_encrypted
     FROM proxy_vault
     WHERE (auth_encrypted <> '' AND auth_encrypted NOT LIKE 'enc:v1:%')
        OR (refresh_url_encrypted <> '' AND refresh_url_encrypted NOT LIKE 'enc:v1:%')`,
  ).all();
  if (rows.length === 0) return;
  const update = db.query(
    `UPDATE proxy_vault SET auth_encrypted = ?, refresh_url_encrypted = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const authEncrypted =
      row.auth_encrypted && !isEncryptedSecret(row.auth_encrypted)
        ? protector.encrypt(row.auth_encrypted)
        : row.auth_encrypted;
    const refreshUrlEncrypted =
      row.refresh_url_encrypted && !isEncryptedSecret(row.refresh_url_encrypted)
        ? protector.encrypt(row.refresh_url_encrypted)
        : row.refresh_url_encrypted;
    if (authEncrypted !== row.auth_encrypted || refreshUrlEncrypted !== row.refresh_url_encrypted) {
      update.run(authEncrypted, refreshUrlEncrypted, row.id);
    }
  }
}

export function runStoreMigrations(
  db: Database,
  transaction: <A extends unknown[], T>(fn: (...args: A) => T, mode?: "deferred" | "immediate") => (...args: A) => T,
  protector: LocalSecretProtector,
): void {
  db.exec("PRAGMA busy_timeout = 1500;");
  db.exec("PRAGMA journal_mode = WAL;");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;

  transaction(() => {
    ensureSchemaAndColumns(db);
    if (version < 1) {
      db.exec("PRAGMA user_version = 1");
      version = 1;
    }
    if (version < 2) {
      migrateToV2EncryptSensitiveColumns(db, protector);
      db.exec("PRAGMA user_version = 2");
      version = 2;
    }
    // Always idempotently re-encrypt any plaintext proxy_vault secrets (e.g. after portable backup restore).
    migrateEncryptProxyVaultSensitiveColumns(db, protector);
    if (version < 3) {
      db.exec("PRAGMA user_version = 3");
      version = 3;
    }
    if (version < 4) {
      db.exec("PRAGMA user_version = 4");
    }
  })();
}
