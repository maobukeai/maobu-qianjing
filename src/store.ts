/**
 * SQLite-backed profile + runtime store for the CloakBrowser manager.
 *
 * Two concerns live here:
 *   - `profiles`: the imported identity for each AdsPower profile id. The
 *     identity columns (proxy, ua, screen, fingerprint_seed) are written once
 *     at import and read verbatim on launch.
 *   - `launches`: which profiles are currently running (pid, debug port, ws).
 *     Used for active() checks and for orphan cleanup on startup.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createLocalSecretProtector, type LocalProtectionOptions, type LocalSecretProtector } from "./dpapi.ts";
import { runStoreMigrations } from "./store-migrations.ts";
import { folderTree } from "./folders.ts";
import type {
  CookieRecord,
  FingerprintVerdict,
  LaunchInfo,
  LaunchPersona,
  ObservedFingerprint,
  Profile,
  ProfileEngine,
  ProxySpec,
} from "./types.ts";
import { completeProfileFingerprint, normalizeChromiumRuntime, normalizeProfileEngine } from "./firefox-config.ts";
import { normalizeProfileHardware } from "./fingerprint.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import { normalizeProfileNotes } from "./profile-notes.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { mergeCookies } from "./parse.ts";
import { fingerprintLaunchDigest, parseFingerprintSource, type FingerprintCaptureSource } from "./fingerprint-source.ts";
import { assertExtensionGroupRevision, canonicalExtensionSelection, createExtensionGroupReview, ExtensionGroupRevisionError, parseExtensionGroupSelection, type ExtensionGroupReview, type ExtensionGroupRevisionState } from "./extension-group-revision.ts";

export interface ProfileStoreOptions {
  /** Overrides for at-rest sensitive column encryption (key, keyPath, inMemory). */
  protection?: LocalProtectionOptions;
}

export type StoreMutationEvent =
  | { kind: "roster"; reason: string; profileIds?: string[] }
  | { kind: "lifecycle"; profileId: string; running: boolean; startedAt?: number; debugPort?: number };

export class ProfileStore {
  private db: Database;
  private readonly protector: LocalSecretProtector;
  private readonly extensionGroupReviewScope = randomUUID();
  private pendingMutations: StoreMutationEvent[] | null = null;
  /** Called after each profile save, so the app can start the downloads that profile needs. */
  onProfileSaved?: (profile: Profile) => void;
  /** Called after committed store mutations so live UI streams can broadcast changes. */
  onMutation?: (event: StoreMutationEvent) => void;

  constructor(path = "profiles.sqlite", options: ProfileStoreOptions = {}) {
    this.db = new Database(path, { create: true });
    const inMemory = options.protection?.inMemory ?? (!path || path === ":memory:");
    this.protector = createLocalSecretProtector({ ...options.protection, inMemory });
    runStoreMigrations(this.db, this.transaction.bind(this), this.protector);
    this.completeClosedFingerprints();
  }

  private completeClosedFingerprints(profileId?: string): void {
    this.transaction(() => {
      const rows = this.db.query<any, [string | null]>(
        `SELECT * FROM profiles WHERE (?1 IS NULL OR id = ?1)
         AND id NOT IN (SELECT profile_id FROM launches)
         AND (locale = '' OR engine = 'firefox')`,
      ).all(profileId ?? null);
      const update = this.db.query("UPDATE profiles SET locale = ?, firefox_config_json = ?, ua = ? WHERE id = ?");
      for (const row of rows) {
        // Corrupt identities must still fail when read, not prevent the whole store from opening.
        let profile: Profile;
        try { profile = completeProfileFingerprint(rowToProfile(row, this.protector)); } catch { continue; }
        const firefox = profile.firefox ? JSON.stringify(profile.firefox) : "";
        // A Firefox engine update also changes the version in the user agent.
        if (profile.locale !== row.locale || firefox !== row.firefox_config_json || profile.ua !== row.ua) {
          update.run(profile.locale!, firefox, profile.ua, profile.id);
        }
      }
    })();
  }

  close(): void {
    try {
      this.db.close(true);
    } catch {
      // bun:sqlite's db.query() LRU cache evicts older prepared statements without
      // finalizing them until GC runs, keeping Windows file locks held on close().
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
      this.db.close();
    }
  }

  /**
   * Use this in place of bun:sqlite's db.transaction(). That API prepares
   * statements that close() never finalizes, so the database file stays open
   * after close() and Windows refuses to delete or rename it. Nested calls
   * become savepoints, as they do there.
   */
  private dispatchMutation(event: StoreMutationEvent): void {
    if (!this.onMutation) return;
    try {
      this.onMutation(event);
    } catch (error) {
      console.error("[store] onMutation listener failed:", error);
    }
  }

  private notifyMutation(event: StoreMutationEvent): void {
    if (this.db.inTransaction && this.pendingMutations !== null) {
      this.pendingMutations.push(event);
      return;
    }
    this.dispatchMutation(event);
  }

  /** Raw SQLite connection for co-located store modules sharing profiles.sqlite. */
  rawDatabase(): Database {
    return this.db;
  }

  /** Opaque version for reads of the main DB, valid only on this connection. */
  readRevision(): string | null {
    if (this.db.inTransaction) return null;
    // total_changes() tracks writes on this connection; data_version tracks
    // commits elsewhere. Include schema_version for same-connection DDL.
    return this.db.query<{ revision: string }, []>(`
      SELECT total_changes() || '/' || (SELECT data_version FROM pragma_data_version)
        || '/' || (SELECT schema_version FROM pragma_schema_version) AS revision
    `).get()!.revision;
  }

  /** Local at-rest secret protector shared with companion tables in profiles.sqlite. */
  secretProtector(): LocalSecretProtector {
    return this.protector;
  }

  /** Execute `fn` inside a store transaction, preserving nested savepoints and post-COMMIT mutation dispatch. */
  withTransaction<T>(fn: () => T, mode: "deferred" | "immediate" = "deferred"): T {
    return this.transaction(fn, mode)();
  }

  /** Emit a roster mutation event (queued until top-level COMMIT when inside a transaction). */
  emitRosterMutation(reason: string, profileIds?: string[]): void {
    this.notifyMutation({
      kind: "roster",
      reason,
      ...(profileIds && profileIds.length > 0 ? { profileIds } : {}),
    });
  }

  private transaction<A extends unknown[], T>(fn: (...args: A) => T, mode: "deferred" | "immediate" = "deferred"): (...args: A) => T {
    return (...args) => {
      const nested = this.db.inTransaction;
      if (!nested) this.pendingMutations = [];
      this.db.exec(nested ? "SAVEPOINT store_tx" : mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = fn(...args);
        this.db.exec(nested ? "RELEASE store_tx" : "COMMIT");
        if (!nested) {
          const queued = this.pendingMutations;
          this.pendingMutations = null;
          if (queued) {
            for (const event of queued) this.dispatchMutation(event);
          }
        }
        return result;
      } catch (error) {
        if (!nested) this.pendingMutations = null;
        // SQLite has already ended the transaction after some errors.
        if (this.db.inTransaction) this.db.exec(nested ? "ROLLBACK TO store_tx; RELEASE store_tx" : "ROLLBACK");
        throw error;
      }
    };
  }

  /** Insert or replace a profile's identity. Preserves the existing seeded flag. */
  upsertProfile(p: Profile): void {
    // Defense in depth for direct local API callers that bypass the import
    // parser. Invalid full-profile JSON must never reach persistent identity.
    assertValidProfile(p);
    const saved = this.transaction(() => {
      const existing = this.db
        .query<{ seeded: number; trashed_at: number; engine: unknown; chromium_runtime: unknown; hardware_json: string; locale: string; proxy_json: string | null; notes: string }, [string]>("SELECT seeded, trashed_at, engine, chromium_runtime, hardware_json, locale, proxy_json, notes FROM profiles WHERE id = ?")
        .get(p.id);
      let nextProfile = p;
      if (!nextProfile.locale && existing?.locale) nextProfile = { ...nextProfile, locale: existing.locale };
      if (nextProfile.notes === undefined && existing?.notes) nextProfile = { ...nextProfile, notes: existing.notes };
      // The runtime is fixed at creation. An edit or re-import that omits it keeps it.
      const storedRuntime = existing ? normalizeChromiumRuntime(existing.chromium_runtime, storedProfileEngine(existing.engine)) : undefined;
      if (!nextProfile.chromiumRuntime && storedRuntime) nextProfile = { ...nextProfile, chromiumRuntime: storedRuntime };
      // An edit or re-import that omits stored hardware keeps it. setHardware clears it.
      const storedHardware = existing?.hardware_json || "";
      if (!nextProfile.hardware && storedHardware) nextProfile = { ...nextProfile, hardware: JSON.parse(storedHardware) };
      if (!this.getLaunch(nextProfile.id)) nextProfile = completeProfileFingerprint(nextProfile);
      const browser = normalizeProfileEngine(nextProfile.engine, nextProfile.firefox);
      if (nextProfile.proxy && nextProfile.proxyError) throw new Error("profile cannot contain both a valid proxy and a proxy quarantine error");
      const proxy = nextProfile.proxyError ? null : normalizeProxySpec(nextProfile.proxy);
      const proxyError = nextProfile.proxyError?.trim() ?? "";
      if (existing?.trashed_at) throw new Error("Profile is in Trash; restore it before importing or editing it");
      if (existing && storedProfileEngine(existing.engine) !== browser.engine) {
        throw new Error("profile engine cannot change in place");
      }
      const chromiumRuntime = normalizeChromiumRuntime(nextProfile.chromiumRuntime, browser.engine);
      if (existing && storedRuntime !== chromiumRuntime) {
        throw new Error("profile Chromium runtime cannot change in place");
      }
      const hardware = normalizeProfileHardware(nextProfile.hardware);
      const hardwareJson = hardware ? JSON.stringify(hardware) : "";
      const seeded = existing ? existing.seeded : nextProfile.seeded ? 1 : 0;
      const nextProxyJson = proxy ? JSON.stringify(proxy) : null;
      let existingProxyJson: string | null = null;
      if (existing?.proxy_json) {
        try {
          existingProxyJson = this.protector.decrypt(existing.proxy_json);
        } catch {
          existingProxyJson = existing.proxy_json;
        }
      }
      const proxySame = existing ? (existingProxyJson === nextProxyJson ? 1 : 0) : 0;
      this.db
        .query(
          `INSERT INTO profiles
             (id, engine, chromium_runtime, hardware_json, firefox_config_json, acc_id, name, "group", platform, username, password, email, email_password, twofa, proxy_json, proxy_error, extensions_json, tags_json, notes, custom_no, ua, timezone, timezone_manual, locale,
              screen_width, screen_height, fingerprint_seed, platform_os, fp_observed_json, fp_expected_json, fp_verdict_json, cookies_json, seeded, created_at, incarnation)
           -- fp_verdict_json is literal '': a verdict is a COMPUTED fact, written
           -- only by saveObservedFingerprint from a real measurement. If a caller
           -- could supply one, an import could hand itself a "verified" badge and
           -- the badge would mean nothing.
           VALUES ($id,$engine,$chromiumRuntime,$hardware,$firefox,$acc,$name,$group,$platform,$user,$pass,$email,$emailPass,$twofa,$proxy,$proxyError,$ext,$tags,$notes,$customNo,$ua,$tz,$tzManual,$locale,$w,$h,$seed,$platformOs,$fpObserved,$fpExpected,'',$cookies,$seeded,$created,$incarnation)
           ON CONFLICT(id) DO UPDATE SET
             engine=$engine, firefox_config_json=$firefox, hardware_json=$hardware, timezone_manual=$tzManual,
             acc_id=$acc, name=$name, "group"=$group, platform=$platform, username=$user, password=$pass,
             email=$email, email_password=$emailPass, twofa=$twofa,
             -- An unrelated edit to a quarantined profile must preserve the raw
             -- legacy proxy for operator recovery. A valid replacement or an
             -- explicit clear removes the quarantine and writes the new value.
             proxy_json = CASE WHEN $proxyError <> '' THEN proxy_json ELSE $proxy END,
             proxy_error = CASE WHEN $proxyError <> '' THEN $proxyError ELSE NULL END,
             extensions_json=$ext, tags_json=$tags, notes=$notes, custom_no=$customNo, ua=$ua,
             -- Timezone on re-import:
             --   * new lookup resolved one ($tz<>'')       -> use it
             --   * else proxy UNCHANGED                     -> keep stored value
             --     (a transient ip-api failure must not erase a still-valid tz)
             --   * else proxy changed/removed + no new tz   -> clear it
             --     (keeping it would emit --fingerprint-timezone for a proxy the
             --      profile no longer uses — a worse mismatch than the default).
             timezone = CASE
               WHEN $tz <> '' THEN $tz
               WHEN $proxyError <> '' THEN timezone
               WHEN $proxySame = 1 THEN timezone
               ELSE ''
             END,
             screen_width=$w, screen_height=$h, locale=$locale,
             fingerprint_seed=$seed, platform_os=$platformOs,
             -- An ordinary profile edit carries no capture. Preserving the stored
             -- one keeps a rename from erasing a measurement that is still true.
             fp_observed_json = CASE WHEN $fpObserved <> '' THEN $fpObserved ELSE fp_observed_json END,
             fp_source_json = CASE WHEN $fpObserved <> '' AND $fpObserved IS NOT fp_observed_json THEN '' ELSE fp_source_json END,
             fp_expected_json = CASE WHEN $fpExpected <> '' THEN $fpExpected ELSE fp_expected_json END,
             -- A CHANGED expectation invalidates the verdict: one computed
             -- against the previous expectation must never be read as if it
             -- applied to this one. An unrelated edit (a rename, a group move)
             -- re-sends the same expectation and keeps its verdict. As everywhere
             -- in this clause, the bare column is the OLD row value.
             fp_verdict_json  = CASE
               WHEN $fpExpected <> '' AND $fpExpected IS NOT fp_expected_json THEN ''
               ELSE fp_verdict_json
             END,
             cookies_json=$cookies`,
        )
        .run({
          $id: nextProfile.id,
          $engine: browser.engine,
          $chromiumRuntime: chromiumRuntime ?? "",
          $hardware: hardwareJson,
          $firefox: browser.firefox ? JSON.stringify(browser.firefox) : "",
          $acc: nextProfile.accId,
          $name: nextProfile.name,
          $group: nextProfile.group,
          $platform: nextProfile.platform ?? "",
          $user: nextProfile.username,
          $pass: nextProfile.password ? this.protector.encrypt(nextProfile.password) : "",
          $email: nextProfile.email ?? "",
          $emailPass: nextProfile.emailPassword ? this.protector.encrypt(nextProfile.emailPassword) : "",
          $twofa: nextProfile.twofa ? this.protector.encrypt(nextProfile.twofa) : "",
          $proxy: nextProxyJson ? this.protector.encrypt(nextProxyJson) : null,
          $proxySame: proxySame,
          $proxyError: proxyError || null,
          $ext: JSON.stringify(nextProfile.extensions ?? []),
          $tags: JSON.stringify(nextProfile.tags ?? []),
          $notes: nextProfile.notes !== undefined ? normalizeProfileNotes(nextProfile.notes) : "",
          $customNo: nextProfile.customNo ?? "",
          $ua: nextProfile.ua,
          $tz: nextProfile.timezone ?? "",
          $tzManual: nextProfile.timezoneManual ? 1 : 0,
          $locale: nextProfile.locale ?? "",
          $w: nextProfile.screenWidth,
          $h: nextProfile.screenHeight,
          $seed: nextProfile.fingerprintSeed,
          $platformOs: nextProfile.platformOs ?? "",
          $fpObserved: nextProfile.fpObserved ? JSON.stringify(nextProfile.fpObserved) : "",
          $fpExpected: nextProfile.fpExpected ? JSON.stringify(nextProfile.fpExpected) : "",
          $cookies: this.protector.encrypt(JSON.stringify(nextProfile.cookies)),
          $seeded: seeded,
          // Set on INSERT; preserved on re-import (the ON CONFLICT clause never
          // updates created_at). New profiles get a real timestamp; rows imported
          // before this column stay 0 (creation time was never recorded then).
          $created: Date.now(),
          // ON CONFLICT deliberately leaves the original incarnation unchanged.
          $incarnation: randomUUID(),
        });
      // Manual proxy changes detach stale proxy-vault bindings in the same transaction.
      if (existing && !proxySame && !proxyError) {
        this.db.query(`DELETE FROM profile_proxy_bindings WHERE profile_id = ?`).run(nextProfile.id);
      }
      // An edit or re-import that omits the display scale keeps the stored value.
      if (nextProfile.displayScale !== undefined) this.setDisplayScale(nextProfile.id, nextProfile.displayScale);
      if (nextProfile.group) this.registerGroup(nextProfile.group);
      this.notifyMutation({ kind: "roster", reason: "upsertProfile", profileIds: [nextProfile.id] });
      return nextProfile;
    })();
    this.onProfileSaved?.(saved);
  }

  /** Pins the display scale a Chromium 155 profile's pages draw at. */
  setDisplayScale(id: string, scale: number): void {
    this.db.query("UPDATE profiles SET display_scale = ? WHERE id = ?").run(scale, id);
  }

  /** Explicit edits and authoritative restores may clear stored hardware; the engine then chooses. */
  setHardware(id: string, hardware: Profile["hardware"]): void {
    const res = this.db.query("UPDATE profiles SET hardware_json = ? WHERE id = ?").run(hardware ? JSON.stringify(hardware) : "", id);
    if (Number(res.changes) > 0) this.notifyMutation({ kind: "roster", reason: "setHardware", profileIds: [id] });
  }

  /** Explicit edits and authoritative restores may clear a saved timezone. */
  setTimezone(id: string, timezone: string): void {
    const res = this.db.query("UPDATE profiles SET timezone = ? WHERE id = ?").run(timezone, id);
    if (Number(res.changes) > 0) this.notifyMutation({ kind: "roster", reason: "setTimezone", profileIds: [id] });
  }

  /** Apply a prevalidated profile batch atomically (all rows or none). */
  upsertProfiles(profiles: Profile[], sessions: ReadonlyMap<string, string> = new Map()): void {
    const apply = this.transaction((items: Profile[]) => {
      for (const profile of items) {
        this.upsertProfile(profile);
        const bundle = sessions.get(profile.id);
        if (bundle !== undefined) {
          this.saveSessionBundle(profile.id, bundle);
          this.db.query(`UPDATE profiles SET session_restore_pending = 1 WHERE id = ?`).run(profile.id);
        }
      }
    });
    apply(profiles);
  }

  /** Profiles in Trash and launch records also reserve their case-insensitive IDs. */
  listSyncConflictIds(): Set<string> {
    const rows = this.db.query<{ id: string }, []>("SELECT id FROM profiles UNION ALL SELECT profile_id FROM launches").all();
    return new Set(rows.map(row => row.id.toLowerCase()));
  }

  /** Check the reviewed additions and write the batch under the same SQLite write lock. */
  importSyncProfiles(profiles: readonly Profile[], sessions: ReadonlyMap<string, string>, matchesPreview: (newIds: readonly string[]) => boolean): number | null {
    return this.transaction(() => {
      const occupied = this.listSyncConflictIds();
      const additions = profiles.filter(profile => !occupied.has(profile.id.toLowerCase()));
      if (!matchesPreview(additions.map(profile => profile.id))) return null;
      if (additions.length) this.upsertProfiles(additions, sessions);
      return additions.length;
    }, "immediate")();
  }

  getSessionBundle(id: string): string | null {
    const raw = this.db.query<{ session_json: string }, [string]>(
      `SELECT session_json FROM profiles WHERE id = ?`,
    ).get(id)?.session_json;
    return decryptOptionalSecret(raw, this.protector);
  }

  getPendingSessionBundle(id: string): string | null {
    const raw = this.db.query<{ session_json: string }, [string]>(
      `SELECT session_json FROM profiles WHERE id = ? AND session_restore_pending = 1`,
    ).get(id)?.session_json;
    return decryptOptionalSecret(raw, this.protector);
  }

  /** Capturing live state must never arm an import restore. */
  saveSessionBundle(id: string, bundle: string): void {
    const stored = bundle ? this.protector.encrypt(bundle) : "";
    this.db.query(`UPDATE profiles SET session_json = ? WHERE id = ?`).run(stored, id);
  }

  markSessionRestored(id: string, bundle: string): void {
    this.transaction(() => {
      const row = this.db.query<{ session_json: string }, [string]>(
        `SELECT session_json FROM profiles WHERE id = ? AND session_restore_pending = 1`,
      ).get(id);
      if (!row?.session_json) return;
      if (decryptOptionalSecret(row.session_json, this.protector) === bundle) {
        this.db.query(`UPDATE profiles SET session_restore_pending = 0 WHERE id = ?`).run(id);
      }
    })();
  }

  getProfile(id: string): Profile | null {
    const row = this.db
      .query<any, [string]>(`SELECT * FROM profiles WHERE id = ? AND trashed_at = 0`)
      .get(id);
    return row ? rowToProfile(row, this.protector) : null;
  }

  /** Private persistence identity for async work; never part of profile exports. */
  getProfileIncarnation(id: string): string | null {
    return this.db.query<{ incarnation: string }, [string]>(
      "SELECT incarnation FROM profiles WHERE id = ? AND trashed_at = 0",
    ).get(id)?.incarnation || null;
  }

  listProfiles(): Profile[] {
    return this.db.query<any, []>(`SELECT * FROM profiles WHERE trashed_at = 0 ORDER BY id`).all().map((row) => rowToProfile(row, this.protector));
  }

  count(): number {
    return this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM profiles WHERE trashed_at = 0`).get()!.n;
  }

  isTrashed(id: string): boolean {
    return !!this.db.query(`SELECT 1 FROM profiles WHERE id = ? AND trashed_at > 0`).get(id);
  }

  listTrashed(): Array<{ id: string; name: string; group: string; trashedAt: number }> {
    return this.db.query<{ id: string; name: string; group: string; trashedAt: number }, []>(
      `SELECT id, name, "group", trashed_at AS trashedAt FROM profiles WHERE trashed_at > 0 ORDER BY trashed_at DESC, id`,
    ).all();
  }

  trashProfile(id: string): boolean {
    return this.transaction(() => {
      const changed = this.db.query(`UPDATE profiles SET trashed_at = ? WHERE id = ? AND trashed_at = 0`).run(Date.now(), id);
      if (changed.changes) {
        this.clearAgentTemporary(id);
        this.db.query(`DELETE FROM profile_proxy_bindings WHERE profile_id = ?`).run(id);
        this.notifyMutation({ kind: "roster", reason: "trashProfile", profileIds: [id] });
      }
      return changed.changes > 0;
    })();
  }

  restoreProfile(id: string): boolean {
    return this.transaction(() => {
      const row = this.db.query<{ group: string }, [string]>(
        `SELECT "group" FROM profiles WHERE id = ? AND trashed_at > 0`,
      ).get(id);
      if (!row) return false;
      this.db.query(`UPDATE profiles SET trashed_at = 0 WHERE id = ?`).run(id);
      this.registerGroup(row.group);
      this.notifyMutation({ kind: "roster", reason: "restoreProfile", profileIds: [id] });
      return true;
    })();
  }

  /** Cookies the next launch sets. A cookie with the same name, domain, path and partition replaces the older one. */
  addPendingCookies(id: string, cookies: CookieRecord[]): number {
    return this.transaction(() => {
      const row = this.db.query<{ pending_cookies_json: string }, [string]>(
        `SELECT pending_cookies_json FROM profiles WHERE id = ? AND trashed_at = 0`,
      ).get(id);
      if (!row) throw new Error(`Unknown profile: ${id}`);
      const existingRaw = decryptField(row.pending_cookies_json, this.protector, "[]");
      const merged = mergeCookies(safeParse<CookieRecord[]>(existingRaw, []), cookies);
      const stored = merged.length > 0 ? this.protector.encrypt(JSON.stringify(merged)) : "[]";
      this.db.query(`UPDATE profiles SET pending_cookies_json = ? WHERE id = ?`).run(stored, id);
      this.notifyMutation({ kind: "roster", reason: "addPendingCookies", profileIds: [id] });
      return merged.length;
    })();
  }

  getPendingCookies(id: string): CookieRecord[] {
    const row = this.db.query<{ pending_cookies_json: string }, [string]>(
      `SELECT pending_cookies_json FROM profiles WHERE id = ?`,
    ).get(id);
    if (!row) return [];
    const decrypted = decryptField(row.pending_cookies_json, this.protector, "[]");
    return safeParse<CookieRecord[]>(decrypted, []);
  }

  /** Remove the pending cookies a launch set. Cookies added during that launch stay pending. */
  clearPendingCookies(id: string, applied: CookieRecord[]): void {
    this.transaction(() => {
      const done = new Set(applied.map((cookie) => JSON.stringify(cookie)));
      const left = this.getPendingCookies(id).filter((cookie) => !done.has(JSON.stringify(cookie)));
      const stored = left.length > 0 ? this.protector.encrypt(JSON.stringify(left)) : "[]";
      this.db.query(`UPDATE profiles SET pending_cookies_json = ? WHERE id = ?`).run(stored, id);
      this.notifyMutation({ kind: "roster", reason: "clearPendingCookies", profileIds: [id] });
    })();
  }

  /** Pending cookie count per profile with any. */
  pendingCookieCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const rows = this.db.query<{ id: string; pending_cookies_json: string }, []>(
      `SELECT id, pending_cookies_json FROM profiles WHERE pending_cookies_json <> '[]' AND pending_cookies_json <> ''`,
    ).all();
    for (const row of rows) {
      const decrypted = decryptField(row.pending_cookies_json, this.protector, "[]");
      const cookies = safeParse<CookieRecord[]>(decrypted, []);
      if (cookies.length > 0) counts.set(row.id, cookies.length);
    }
    return counts;
  }

  markSeeded(id: string): void {
    this.db.query(`UPDATE profiles SET seeded = 1 WHERE id = ?`).run(id);
  }

  /**
   * Record a capture and, when there was something to check it against, the
   * verdict. Deliberately narrow: this is the launch path's only write, and it
   * must not be able to touch identity, credentials or the expectation.
   */
  saveObservedFingerprint(profileId: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null): void;
  saveObservedFingerprint(profileId: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null, expectedIncarnation: string): boolean;
  saveObservedFingerprint(profileId: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null, expectedIncarnation: string | undefined, source: FingerprintCaptureSource | undefined): boolean;
  saveObservedFingerprint(
    profileId: string,
    observed: ObservedFingerprint,
    verdict: FingerprintVerdict | null,
    expectedIncarnation?: string,
    source?: FingerprintCaptureSource,
  ): void | boolean {
    const provenance = source === undefined ? null : parseFingerprintSource(source);
    if (source !== undefined && !provenance) throw new Error("Invalid fingerprint measurement source");
    const save = () => {
      if (provenance?.launchDigest) {
        const launch = this.getLaunch(profileId);
        if (!launch || fingerprintLaunchDigest(launch) !== provenance.launchDigest) return false;
      }
      const result = this.db
        .query(`UPDATE profiles SET fp_observed_json = ?1, fp_verdict_json = ?2, fp_source_json = ?5 WHERE id = ?3
          AND (?4 IS NULL OR (incarnation = ?4 AND trashed_at = 0))`)
        .run(JSON.stringify(observed), verdict ? JSON.stringify(verdict) : "", profileId, expectedIncarnation ?? null, provenance ? JSON.stringify(provenance) : "");
      return Number(result.changes) > 0;
    };
    const changed = provenance ? this.transaction(save)() : save();
    if (changed) this.notifyMutation({ kind: "roster", reason: "saveObservedFingerprint", profileIds: [profileId] });
    if (expectedIncarnation !== undefined || arguments.length >= 5) return changed;
  }

  /** Local capture metadata is deliberately absent from Profile and portable exports. */
  getFingerprintSource(profileId: string): FingerprintCaptureSource | null {
    const row = this.db.query<{ source: string }, [string]>("SELECT fp_source_json AS source FROM profiles WHERE id = ? AND trashed_at = 0").get(profileId);
    return row?.source ? parseFingerprintSource(safeParse(row.source, null)) : null;
  }

  /** Delete a profile and its launch/binding/policy/timeline rows. Returns true if a row was removed. */
  deleteProfile(id: string): boolean {
    return this.transaction(() => {
      this.db.query(`DELETE FROM launches WHERE profile_id = ?`).run(id);
      this.db.query(`DELETE FROM agent_temporary_profiles WHERE profile_id = ?`).run(id);
      this.db.query(`DELETE FROM profile_proxy_bindings WHERE profile_id = ?`).run(id);
      this.db.query(`DELETE FROM profile_resource_policies WHERE profile_id = ?`).run(id);
      this.db.query(`DELETE FROM profile_events WHERE profile_id = ?`).run(id);
      const res = this.db.query(`DELETE FROM profiles WHERE id = ?`).run(id);
      const deleted = Number(res.changes) > 0;
      if (deleted) this.notifyMutation({ kind: "roster", reason: "deleteProfile", profileIds: [id] });
      return deleted;
    })();
  }

  markAgentTemporary(profileId: string): void {
    assertSafeProfileId(profileId);
    this.db.query(
      `INSERT INTO agent_temporary_profiles (profile_id, created_at) VALUES (?, ?)
       ON CONFLICT(profile_id) DO NOTHING`,
    ).run(profileId, Date.now());
  }

  clearAgentTemporary(profileId: string): void {
    this.db.query(`DELETE FROM agent_temporary_profiles WHERE profile_id = ?`).run(profileId);
  }

  listAgentTemporary(): string[] {
    return this.db
      .query<{ profile_id: string }, []>(`SELECT profile_id FROM agent_temporary_profiles ORDER BY created_at, profile_id`)
      .all()
      .map((row) => row.profile_id);
  }

  /**
   * Reassign profiles to a group and materialize that group's extension defaults.
   * Unknown ids and profiles already in the destination are ignored.
   */
  setGroup(ids: string[], group: string): number {
    if (ids.length === 0) return 0;
    const destination = group.trim();
    const move = this.transaction((profileIds: string[]) => {
      if (destination) this.registerGroup(destination);
      let changed = 0;
      for (const id of profileIds) {
        const profile = this.getProfile(id);
        if (!profile || profile.group === destination) continue;
        const previousGroup = profile.group;
        profile.group = destination;
        this.applyGroupExtensionDefaults(profile, previousGroup, false);
        this.upsertProfile(profile);
        changed++;
      }
      return changed;
    });
    return move(ids);
  }

  /** Register a group so it persists (and stays listed) with zero profiles. */
  registerGroup(name: string): void {
    const n = name.trim();
    if (!n) return;
    const res = this.db.query(`INSERT OR IGNORE INTO groups (name) VALUES (?)`).run(n);
    if (Number(res.changes) > 0) this.notifyMutation({ kind: "roster", reason: "registerGroup" });
  }

  listFolders(): Array<{ name: string; parentName: string | null; label: string }> {
    return this.db.query<{ name: string; parentName: string | null; label: string }, []>(
      `SELECT name, parent_name AS parentName, COALESCE(label, name) AS label FROM groups ORDER BY name`,
    ).all();
  }

  createGroup(label: string, parentName: string | null = null): { name: string; parentName: string | null; label: string } {
    const value = label.trim();
    if (!value) throw new Error("group name required");
    return this.transaction(() => {
      const folders = this.listFolders();
      if (parentName !== null && !folders.some((folder) => folder.name === parentName)) throw new Error("parent folder not found");
      const name = parentName === null ? value : `${parentName}/${value}`;
      const existing = folders.find((folder) => folder.name === name);
      if (existing && (existing.parentName !== parentName || existing.label !== value)) throw new Error("folder already exists");
      if (!existing) {
        this.db.query(`INSERT INTO groups (name, parent_name, label) VALUES (?, ?, ?)`).run(name, parentName, value);
        this.notifyMutation({ kind: "roster", reason: "createGroup" });
      }
      return { name, parentName, label: value };
    })();
  }

  private rewriteGroup(from: string, label: string, parentName?: string | null): { moved: number; name: string } {
    return this.transaction(() => {
      const folders = this.listFolders();
      const branch = folderTree(folders).filter((folder) => folder.name === from || folder.ancestors.includes(from));
      const root = branch[0];
      if (!root) throw new Error("folder not found");
      const parent = parentName === undefined ? root.parentName : parentName;
      if (!label.trim()) throw new Error("group name required");
      if (parent !== null && (!folders.some((folder) => folder.name === parent) || branch.some((folder) => folder.name === parent))) {
        throw new Error("invalid parent folder");
      }
      const names = new Map<string, string>();
      for (const folder of branch) {
        const nextParent = folder === root ? parent : names.get(folder.parentName!)!;
        const nextLabel = folder === root ? label.trim() : folder.label;
        names.set(folder.name, nextParent === null ? nextLabel : `${nextParent}/${nextLabel}`);
      }
      const targets = new Set(names.values());
      if (targets.size !== names.size || folders.some((folder) => !names.has(folder.name) && targets.has(folder.name))) throw new Error("folder already exists");
      let moved = 0;
      const temporary = new Map(branch.map((folder) => [folder.name, `folder-move-${crypto.randomUUID()}`]));
      for (const folder of branch) {
        const temp = temporary.get(folder.name)!;
        this.db.query(`UPDATE groups SET name = ? WHERE name = ?`).run(temp, folder.name);
        this.db.query(`UPDATE groups SET parent_name = ? WHERE parent_name = ?`).run(temp, folder.name);
        moved += this.db.query(`UPDATE profiles SET "group" = ? WHERE "group" = ?`).run(temp, folder.name).changes;
      }
      for (const folder of branch) {
        const name = names.get(folder.name)!;
        const temp = temporary.get(folder.name)!;
        this.db.query(`UPDATE groups SET name = ?, parent_name = ?, label = ? WHERE name = ?`)
          .run(name, folder === root ? parent : names.get(folder.parentName!)!, folder === root ? label.trim() : folder.label, temp);
        this.db.query(`UPDATE groups SET parent_name = ? WHERE parent_name = ?`).run(name, temp);
        this.db.query(`UPDATE profiles SET "group" = ? WHERE "group" = ?`).run(name, temp);
      }
      this.notifyMutation({ kind: "roster", reason: parentName === undefined ? "renameGroup" : "moveGroup" });
      return { moved, name: names.get(from)! };
    })();
  }

  moveGroup(name: string, parentName: string | null): { name: string; parentName: string | null; label: string } {
    const folder = this.listFolders().find((item) => item.name === name);
    if (!folder) throw new Error("folder not found");
    const result = this.rewriteGroup(name, folder.label, parentName);
    return { name: result.name, parentName, label: folder.label };
  }

  getGroupExtensionDefaults(name: string): string[] {
    const n = name.trim();
    if (!n) return [];
    const row = this.db
      .query<{ extensions: string }, [string]>(
        `SELECT extension_defaults_json AS extensions FROM groups WHERE name = ?`,
      )
      .get(n);
    return normalizeExtensionIds(safeParse<string[]>(row?.extensions, []));
  }

  listGroupExtensionDefaults(): Array<{ name: string; extensions: string[] }> {
    return this.listGroups().map((name) => ({
      name,
      extensions: this.getGroupExtensionDefaults(name),
    }));
  }

  private extensionGroupRevisionState(group: string): ExtensionGroupRevisionState {
    try {
      // Review needs no credentials/cookies and no per-member lookup. Read only
      // its group in one narrow query; malformed stored JSON must remain unknown.
      const defaults = this.db.query<{ extensions: string }, [string]>("SELECT extension_defaults_json AS extensions FROM groups WHERE name=?").get(group);
      const members = this.db.query<{ id: string; name: string; engine: unknown; extensions: string; incarnation: string; running: number }, [string]>(
        `SELECT p.id,p.name,p.engine,p.extensions_json AS extensions,p.incarnation,
          EXISTS(SELECT 1 FROM launches l WHERE l.profile_id=p.id) AS running
          FROM profiles p WHERE p."group"=? AND p.trashed_at=0 ORDER BY p.id`,
      ).all(group);
      return {
        scope: this.extensionGroupReviewScope, group, exists: defaults !== null || members.length > 0,
        defaults: defaults ? JSON.parse(defaults.extensions) : [],
        members: members.map(member => ({ id: member.id, incarnation: member.incarnation, engine: storedProfileEngine(member.engine), extensions: JSON.parse(member.extensions), name: member.name, running: member.running === 1 })),
      };
    } catch { throw new ExtensionGroupRevisionError("state-unavailable"); }
  }

  /** A complete, redacted review, measured in one database transaction. Never writes assignments. */
  previewGroupExtensionDefaults(name: string, extensionIds: string[]): ExtensionGroupReview {
    const selection = parseExtensionGroupSelection({ group: name, extensions: extensionIds });
    return this.transaction(() => createExtensionGroupReview(this.extensionGroupRevisionState(selection.group), selection.extensions))();
  }

  /** Replace defaults and member assignments; a reviewed caller checks its snapshot in this SAME transaction. */
  setGroupExtensionDefaults(name: string, extensionIds: string[], expectedFingerprint?: unknown): number {
    const group = name.trim();
    if (!group) throw new Error("group name required");
    const reviewed = expectedFingerprint !== undefined;
    const defaultExtensions = reviewed ? parseExtensionGroupSelection({ group, extensions: extensionIds }).extensions : normalizeExtensionIds(extensionIds);
    const apply = this.transaction(() => {
      // Must precede registerGroup and every write: a deleted/moved/recreated member
      // or an external assignment edit cannot be silently adopted by an old review.
      if (reviewed) assertExtensionGroupRevision(expectedFingerprint, this.extensionGroupRevisionState(group), defaultExtensions);
      this.registerGroup(group);
      if (!reviewed || !sameStrings(canonicalExtensionSelection(this.getGroupExtensionDefaults(group)), defaultExtensions)) {
        this.db.query(`UPDATE groups SET extension_defaults_json = ? WHERE name = ?`)
          .run(JSON.stringify(defaultExtensions), group);
        this.notifyMutation({ kind: "roster", reason: "setGroupExtensionDefaults" });
      }
      let changed = 0;
      for (const profile of this.listProfiles()) {
        if (profile.group !== group) continue;
        const extensions = profile.engine === "firefox" ? [] : defaultExtensions;
        if (sameStrings(reviewed ? canonicalExtensionSelection(profile.extensions ?? []) : profile.extensions ?? [], extensions)) continue;
        profile.extensions = [...extensions];
        this.upsertProfile(profile);
        changed++;
      }
      return changed;
    });
    return apply();
  }

  /** Apply a named destination's default unless assignments were explicitly supplied. */
  applyGroupExtensionDefaults(profile: Profile, previousGroup: string | null, extensionsExplicit: boolean): void {
    if (profile.engine === "firefox") {
      profile.extensions = [];
      return;
    }
    const destination = profile.group.trim();
    if (extensionsExplicit || !destination || previousGroup?.trim() === destination) return;
    profile.extensions = this.getGroupExtensionDefaults(destination);
  }

  /**
   * Rename a group: move every member profile from `from` to `to`, and migrate
   * its defaults. Existing flat leaf groups retain their legacy merge behavior.
   */
  renameGroup(from: string, to: string): number {
    const source = from.trim(), destination = to.trim();
    if (!source || !destination || source === destination) return 0;
    const folders = this.listFolders();
    const sourceFolder = folders.find((folder) => folder.name === source);
    if (!sourceFolder) return 0;
    const destinationFolder = folders.find((folder) => folder.name === destination);
    if (!destinationFolder || sourceFolder.parentName !== null || destinationFolder.parentName !== null ||
        folders.some((folder) => folder.parentName === source || folder.parentName === destination)) {
      return this.rewriteGroup(source, destination).moved;
    }
    const rename = this.transaction(() => {
      const destinationExists = !!this.db
        .query<{ found: number }, [string]>(`SELECT 1 AS found FROM groups WHERE name = ?`)
        .get(destination);
      if (!destinationExists) {
        this.db.query(`INSERT INTO groups (name, extension_defaults_json) VALUES (?, ?)`)
          .run(destination, JSON.stringify(this.getGroupExtensionDefaults(source)));
      }
      const res = this.db.query(`UPDATE profiles SET "group" = ? WHERE "group" = ? AND trashed_at = 0`)
        .run(destination, source);
      this.db.query(`DELETE FROM groups WHERE name = ?`).run(source);
      this.notifyMutation({ kind: "roster", reason: "renameGroup" });
      return Number(res.changes);
    });
    return rename();
  }

  /**
   * Delete a group. Members aren't deleted — they're moved to "ungrouped" (empty
   * group), matching AdsPower. Materialized extension assignments are preserved.
   */
  deleteGroup(name: string): number {
    const n = name.trim();
    const remove = this.transaction(() => {
      if (this.db.query(`SELECT 1 FROM groups WHERE parent_name = ?`).get(n)) throw new Error("Move or delete subfolders first.");
      const res = this.db.query(`UPDATE profiles SET "group" = '' WHERE "group" = ? AND trashed_at = 0`).run(n);
      const removedGroup = this.db.query(`DELETE FROM groups WHERE name = ?`).run(n);
      if (Number(res.changes) > 0 || Number(removedGroup.changes) > 0) {
        this.notifyMutation({ kind: "roster", reason: "deleteGroup" });
      }
      return Number(res.changes);
    });
    return remove();
  }

  /** Distinct group names: the registry unioned with any labels live on profiles. */
  listGroups(): string[] {
    return this.db
      .query<{ name: string }, []>(
        `SELECT name FROM groups WHERE name <> ''
         UNION SELECT DISTINCT "group" FROM profiles WHERE "group" <> '' AND trashed_at = 0
         ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
  }

  /** Set a profile's display name (AdsPower user/update). No-op for unknown ids. */
  rename(id: string, name: string): void {
    const res = this.db.query(`UPDATE profiles SET name = ? WHERE id = ? AND trashed_at = 0`).run(name, id);
    if (Number(res.changes) > 0) this.notifyMutation({ kind: "roster", reason: "rename", profileIds: [id] });
  }

  // --- Extensions ----------------------------------------------------------

  /** Register (or replace) an uploaded extension. */
  addExtension(ext: { id: string; name: string; loadDir: string }): void {
    this.db
      .query(
        `INSERT INTO extensions (id, name, load_dir, created_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, load_dir=excluded.load_dir`,
      )
      .run(ext.id, ext.name, ext.loadDir, Date.now());
    this.notifyMutation({ kind: "roster", reason: "addExtension" });
  }

  listExtensions(): Array<{ id: string; name: string; loadDir: string }> {
    return this.db
      .query<{ id: string; name: string; loadDir: string }, []>(
        `SELECT id, name, load_dir AS loadDir FROM extensions ORDER BY name COLLATE NOCASE`,
      )
      .all();
  }

  getExtension(id: string): { id: string; name: string; loadDir: string } | null {
    return (
      this.db
        .query<{ id: string; name: string; loadDir: string }, [string]>(
          `SELECT id, name, load_dir AS loadDir FROM extensions WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  deleteExtension(id: string): void {
    const res = this.db.query(`DELETE FROM extensions WHERE id = ?`).run(id);
    if (Number(res.changes) > 0) this.notifyMutation({ kind: "roster", reason: "deleteExtension" });
  }

  /** Remove an extension id from every profile and group default that contains it. */
  unassignExtension(id: string): void {
    const unassign = this.transaction(() => {
      for (const group of this.listGroupExtensionDefaults()) {
        if (!group.extensions.includes(id)) continue;
        this.db.query(`UPDATE groups SET extension_defaults_json = ? WHERE name = ?`)
          .run(JSON.stringify(group.extensions.filter((item) => item !== id)), group.name);
      }
      for (const profile of this.listProfiles()) {
        if (!profile.extensions?.includes(id)) continue;
        profile.extensions = profile.extensions.filter((item) => item !== id);
        this.upsertProfile(profile);
      }
    });
    unassign();
  }

  /**
   * Add or remove one extension id across many profiles (bulk assign). The
   * assignment list is treated as a set (no duplicates). Unknown profile ids are
   * skipped. Returns how many profiles changed.
   */
  assignExtension(ids: string[], extId: string, add: boolean): number {
    let changed = 0;
    for (const id of ids) {
      const p = this.getProfile(id);
      if (!p) continue;
      const set = new Set(p.extensions ?? []);
      const had = set.has(extId);
      if (add) set.add(extId);
      else set.delete(extId);
      if (set.size === (p.extensions?.length ?? 0) && had === add) continue; // no change
      p.extensions = [...set];
      this.upsertProfile(p);
      changed++;
    }
    return changed;
  }

  /**
   * Rows for the AdsPower-compatible /api/v1/user/list + group/list facade.
   * `serial` is the SQLite rowid (stable — upsert uses ON CONFLICT DO UPDATE,
   * not REPLACE), standing in for AdsPower's serial_number. Timestamps are ms.
   */
  listUserRecords(): Array<{
    id: string;
    name: string;
    group: string;
    createdAt: number;
    lastOpenAt: number;
    serial: number;
    fpVerdict: string;
    fpCapturedAt: string;
  }> {
    return this.db
      .query<any, []>(
        `SELECT id, name, "group" AS grp, created_at AS c, last_open_at AS l, rowid AS s,
                fp_verdict_json AS fpv, fp_observed_json AS fpo
           FROM profiles WHERE trashed_at = 0 ORDER BY rowid`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name ?? "",
        group: r.grp ?? "",
        createdAt: r.c ?? 0,
        lastOpenAt: r.l ?? 0,
        serial: r.s,
        fpVerdict: safeParse<{ verdict?: string }>(r.fpv, {}).verdict ?? "",
        fpCapturedAt: safeParse<{ capturedAt?: string }>(r.fpo, {}).capturedAt ?? "",
      }));
  }

  /** This profile's serial (SQLite rowid) — AdsPower's serial_number stand-in. Null if unknown. */
  getSerial(profileId: string): number | null {
    const row = this.db
      .query<{ s: number }, [string]>(`SELECT rowid AS s FROM profiles WHERE id = ?`)
      .get(profileId);
    return row ? row.s : null;
  }

  /**
   * Per-profile bookkeeping the roster shows but that does not live on Profile:
   * the serial (rowid) plus creation/last-open timestamps. One query for a whole
   * roster render rather than a lookup per row.
   */
  listProfileMeta(): Map<string, { serial: number; createdAt: number; lastOpenAt: number }> {
    return new Map(
      this.db
        .query<{ id: string; s: number; c: number; l: number }, []>(
          `SELECT id, rowid AS s, created_at AS c, last_open_at AS l FROM profiles WHERE trashed_at = 0`,
        )
        .all()
        .map((row) => [row.id, { serial: row.s, createdAt: row.c ?? 0, lastOpenAt: row.l ?? 0 }] as const),
    );
  }

  recordLaunch(info: LaunchInfo): void {
    const firefox = info as LaunchInfo & {
      engine?: "chromium" | "firefox";
      firefoxOwner?: unknown;
      ownerBinaryPath?: string;
    };
    this.db
      .query(
        `INSERT INTO launches
           (profile_id, pid, debug_port, ws, started_at, relay_port,
            binary_path, user_data_dir, binary_sha256, persona_digest, headless,
            search_bootstrap_revision, process_group_id, root_start_time,
            engine, firefox_owner_json, owner_binary_path, persona_json)
         VALUES ($id,$pid,$port,$ws,$at,$relay,$binary,$data,$binary_sha,$persona,$headless,$search_bootstrap,$pgid,$root_start,
                 $engine,$firefox_owner,$owner_binary,$persona_json)
         ON CONFLICT(profile_id) DO UPDATE SET
           pid=$pid, debug_port=$port, ws=$ws, started_at=$at, relay_port=$relay,
           binary_path=$binary, user_data_dir=$data,
           binary_sha256=$binary_sha, persona_digest=$persona, headless=$headless,
           search_bootstrap_revision=$search_bootstrap,
           process_group_id=$pgid, root_start_time=$root_start,
           engine=$engine, firefox_owner_json=$firefox_owner, owner_binary_path=$owner_binary,
           persona_json=$persona_json`,
      )
      .run({
        $id: info.profileId,
        $pid: info.pid,
        $port: info.debugPort,
        $ws: info.ws,
        $at: info.startedAt,
        $relay: info.relayPort ?? null,
        $binary: info.binaryPath ?? null,
        $data: info.userDataDir ?? null,
        $binary_sha: info.binarySha256 ?? null,
        $persona: info.personaDigest ?? null,
        $headless: info.headless === undefined ? null : Number(info.headless),
        $search_bootstrap: info.searchBootstrapRevision ?? null,
        $pgid: info.processGroupId ?? null,
        $root_start: info.rootStartTime ?? null,
        $engine: firefox.engine ?? null,
        $firefox_owner: firefox.firefoxOwner === undefined ? null : JSON.stringify(firefox.firefoxOwner),
        $owner_binary: firefox.ownerBinaryPath ?? null,
        $persona_json: info.persona ? JSON.stringify(info.persona) : null,
      });
    // Mirror the launch time onto the profile so the AdsPower user/list facade
    // can report last_open_time (the launches row is deleted on stop).
    this.db.query(`UPDATE profiles SET last_open_at = ? WHERE id = ?`).run(info.startedAt, info.profileId);
    this.notifyMutation({
      kind: "lifecycle",
      profileId: info.profileId,
      running: true,
      startedAt: info.startedAt,
      ...(firefox.engine === "firefox" ? {} : { debugPort: info.debugPort }),
    });
  }

  /** Record the launch identity of a launch made before it was stored. */
  setLaunchPersona(profileId: string, startedAt: number, persona: LaunchPersona): void {
    this.db.query(`UPDATE launches SET persona_json = ? WHERE profile_id = ? AND started_at = ? AND persona_json IS NULL`)
      .run(JSON.stringify(persona), profileId, startedAt);
  }

  getLaunch(profileId: string): LaunchInfo | null {
    const row = this.db
      .query<any, [string]>(`SELECT * FROM launches WHERE profile_id = ?`)
      .get(profileId);
    return row ? rowToLaunch(row) : null;
  }

  listLaunches(): LaunchInfo[] {
    return this.db.query<any, []>(`SELECT * FROM launches`).all().map(rowToLaunch);
  }

  clearLaunch(profileId: string): void {
    this.transaction(() => {
      const res = this.db.query(`DELETE FROM launches WHERE profile_id = ?`).run(profileId);
      this.completeClosedFingerprints(profileId);
      if (Number(res.changes) > 0) {
        this.notifyMutation({ kind: "lifecycle", profileId, running: false });
      }
    })();
  }
}

function normalizeExtensionIds(ids: string[]): string[] {
  return [...new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))];
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Parse a JSON column defensively so one corrupt row can't break list/diagnose. */
function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Spread-friendly optional JSON column: absent (not `undefined`) when the
 * column is blank, so a profile that has never been probed does not carry
 * three explicit `undefined` keys into every comparison and serialization.
 */
function optionalJson<T>(key: string, raw: unknown): Record<string, T> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    return { [key]: JSON.parse(raw) as T };
  } catch {
    return {};
  }
}

function decryptField(raw: unknown, protector?: LocalSecretProtector, fallback?: string): unknown {
  if (!protector || typeof raw !== "string" || !raw) return raw;
  try {
    return protector.decrypt(raw);
  } catch {
    return fallback ?? raw;
  }
}

function decryptOptionalSecret(raw: unknown, protector?: LocalSecretProtector): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (!protector) return raw;
  try {
    return protector.decrypt(raw);
  } catch {
    return null;
  }
}

function rowToProfile(row: any, protector?: LocalSecretProtector): Profile {
  const browser = normalizeProfileEngine(row.engine, readStoredFirefoxConfig(row.firefox_config_json));
  const decryptedProxy = decryptField(row.proxy_json, protector);
  const stored = readStoredProxy(decryptedProxy, row.proxy_error);
  const password = decryptField(row.password, protector, "");
  const emailPassword = decryptField(row.email_password, protector, "");
  const twofa = decryptField(row.twofa, protector, "");
  const cookiesRaw = decryptField(row.cookies_json, protector, "[]");
  return {
    id: row.id,
    engine: browser.engine,
    ...(row.chromium_runtime ? { chromiumRuntime: normalizeChromiumRuntime(row.chromium_runtime, browser.engine) } : {}),
    ...(row.hardware_json ? { hardware: normalizeProfileHardware(JSON.parse(row.hardware_json)) } : {}),
    ...(browser.firefox ? { firefox: browser.firefox } : {}),
    accId: row.acc_id ?? "",
    name: row.name ?? "",
    group: row.group ?? "",
    platform: row.platform ?? "",
    username: row.username ?? "",
    password: typeof password === "string" ? password : "",
    email: row.email ?? "",
    emailPassword: typeof emailPassword === "string" ? emailPassword : "",
    twofa: typeof twofa === "string" ? twofa : "",
    proxy: stored.proxy,
    ...(stored.error ? { proxyError: stored.error } : {}),
    extensions: safeParse<string[]>(row.extensions_json, []),
    tags: safeParse<string[]>(row.tags_json, []),
    notes: typeof row.notes === "string" ? row.notes : "",
    customNo: typeof row.custom_no === "string" ? row.custom_no : "",
    ua: row.ua ?? "",
    timezone: row.timezone ?? "",
    ...(row.timezone_manual ? { timezoneManual: true } : {}),
    ...(row.display_scale >= 1 ? { displayScale: row.display_scale } : {}),
    ...(row.locale ? { locale: row.locale } : {}),
    screenWidth: row.screen_width ?? 1920,
    screenHeight: row.screen_height ?? 1080,
    fingerprintSeed: row.fingerprint_seed,
    platformOs: row.platform_os ?? "",
    ...optionalJson<ObservedFingerprint>("fpObserved", row.fp_observed_json),
    ...optionalJson<ObservedFingerprint>("fpExpected", row.fp_expected_json),
    ...optionalJson<FingerprintVerdict>("fpVerdict", row.fp_verdict_json),
    cookies: safeParse<CookieRecord[]>(cookiesRaw, []),
    seeded: Boolean(row.seeded),
  };
}

function readStoredFirefoxConfig(raw: unknown): unknown {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("invalid stored Firefox config encoding");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid stored Firefox config JSON");
  }
}

function storedProfileEngine(value: unknown): ProfileEngine {
  if (value == null || value === "") return "chromium";
  if (value === "chromium" || value === "firefox") return value;
  throw new Error("unsupported stored profile engine");
}

function readStoredProxy(raw: unknown, quarantined: unknown): { proxy: ProxySpec | null; error?: string } {
  const priorError = typeof quarantined === "string" ? quarantined.trim() : "";
  if (priorError) return { proxy: null, error: priorError };
  if (raw == null || raw === "") return { proxy: null };
  if (typeof raw !== "string") return { proxy: null, error: "invalid stored proxy encoding" };
  let parsed: ProxySpec | null;
  try {
    parsed = JSON.parse(raw) as ProxySpec | null;
  } catch {
    return { proxy: null, error: "invalid stored proxy JSON" };
  }
  try {
    return { proxy: normalizeProxySpec(parsed) };
  } catch (error) {
    return { proxy: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function rowToLaunch(row: any): LaunchInfo {
  const engine = readStoredLaunchEngine(row.engine);
  const firefoxOwner = readStoredFirefoxOwner(row.firefox_owner_json);
  return {
    profileId: row.profile_id,
    pid: row.pid,
    debugPort: row.debug_port,
    ws: row.ws,
    startedAt: row.started_at,
    relayPort: row.relay_port ?? undefined,
    binaryPath: row.binary_path ?? undefined,
    userDataDir: row.user_data_dir ?? undefined,
    binarySha256: row.binary_sha256 ?? undefined,
    personaDigest: row.persona_digest ?? undefined,
    headless: row.headless == null ? undefined : Boolean(row.headless),
    searchBootstrapRevision: row.search_bootstrap_revision ?? undefined,
    processGroupId: row.process_group_id ?? undefined,
    rootStartTime: row.root_start_time ?? undefined,
    ...(engine ? { engine } : {}),
    ...(firefoxOwner === undefined ? {} : { firefoxOwner }),
    ...(row.owner_binary_path ? { ownerBinaryPath: row.owner_binary_path } : {}),
    ...(row.persona_json ? { persona: JSON.parse(row.persona_json) } : {}),
  } as LaunchInfo;
}

function readStoredLaunchEngine(value: unknown): "chromium" | "firefox" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "chromium" || value === "firefox") return value;
  throw new Error("unsupported stored launch engine");
}

function readStoredFirefoxOwner(raw: unknown): unknown {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("invalid stored Firefox owner encoding");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid stored Firefox owner JSON");
  }
}
