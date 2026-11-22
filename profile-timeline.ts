import type { ProfileStore } from "./store.ts";
import { isSafeProfileId } from "./profile-id.ts";

export const MAX_PROFILE_EVENTS = 200;
export const MAX_TIMELINE_SUMMARY_CHARS = 240;
export const MAX_TIMELINE_DETAIL_BYTES = 2048;
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 100;

export const PROFILE_EVENT_TYPES = [
  "profile.created",
  "profile.trashed",
  "profile.restored",
  "launch.started",
  "launch.stopped",
  "launch.restarted",
  "launch.failed",
  "launch.stop_failed",
  "proxy.updated",
  "proxy.checked",
  "proxy.vault_bound",
  "config.updated",
  "group.changed",
  "tags.updated",
  "notes.updated",
  "cookies.updated",
  "session.captured",
  "cache.cleared",
  "package.exported",
  "package.imported",
  "rpa.run",
  "ai.proposal_applied",
] as const;

export type ProfileEventType = (typeof PROFILE_EVENT_TYPES)[number];

export const PROFILE_EVENT_STATUSES = ["ok", "failed", "warn", "info"] as const;
export type ProfileEventStatus = (typeof PROFILE_EVENT_STATUSES)[number];

export const PROFILE_EVENT_ACTORS = ["user", "ai_proposal", "rpa", "mcp", "system"] as const;
export type ProfileEventActor = (typeof PROFILE_EVENT_ACTORS)[number];

export const PROFILE_RECOVERY_KINDS = ["", "proxy", "network", "logs", "retry_start", "runtime"] as const;
export type ProfileRecoveryKind = (typeof PROFILE_RECOVERY_KINDS)[number];

const EVENT_TYPE_SET = new Set<string>(PROFILE_EVENT_TYPES);
const STATUS_SET = new Set<string>(PROFILE_EVENT_STATUSES);
const ACTOR_SET = new Set<string>(PROFILE_EVENT_ACTORS);
const RECOVERY_SET = new Set<string>(PROFILE_RECOVERY_KINDS);

export interface ProfileTimelineEvent {
  id: number;
  profileId: string;
  eventType: ProfileEventType;
  status: ProfileEventStatus;
  actor: ProfileEventActor;
  summary: string;
  detail: Record<string, unknown>;
  recoveryKind: ProfileRecoveryKind;
  createdAt: number;
}

export interface RecordProfileEventInput {
  profileId: string;
  eventType: ProfileEventType;
  status: ProfileEventStatus;
  actor?: ProfileEventActor;
  summary: string;
  detail?: Record<string, unknown>;
  recoveryKind?: ProfileRecoveryKind;
  createdAt?: number;
}

export interface ListProfileEventsOptions {
  limit?: number;
  beforeId?: number;
  type?: string;
}

export interface ListProfileEventsResult {
  events: ProfileTimelineEvent[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export function isKnownProfileEventType(value: unknown): value is ProfileEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/** Sensitive key patterns dropped recursively from structured event metadata. */
const SENSITIVE_DETAIL_KEY_RE =
  /(?:^|[_-])(?:pass(?:word|wd)?|secret|token|cookie|cookies|session|twofa|totp|auth(?:orization)?|cred(?:ential)?s?|api[_-]?key|ws|websocket|cdp|refresh[_-]?url|firefox[_-]?owner|email[_-]?password|proxy[_-]?(?:user|pass)|private[_-]?key|bearer|user(?:name)?|authorization)(?:$|[_-])/i;

/** Patterns scrubbed from free-text summaries and string values inside event details. */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // WebSocket / CDP / Playwright endpoints
  [/\bwss?:\/\/[^\s"'<>]+/gi, "[REDACTED_WS]"],
  // Credential-bearing URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/gi, "$1[REDACTED]@"],
  // Bare proxy auth user:pass@host
  [/\b([^\s/:@]{1,128}):([^\s/:@]{1,128})@(?=[a-z0-9.\-[\]:]+)/gi, "[REDACTED]@"],
  // Authorization headers (Bearer / Basic)
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [REDACTED]"],
  // Encrypted at-rest tokens
  [/\b(?:enc:v1:[A-Za-z0-9+/=_-]+|DPAPI:[A-Za-z0-9+/=_-]+)/g, "[REDACTED]"],
  // Key-value secret assignments
  [
    /\b(password|passwd|pass|token|secret|twofa|totp|cookie|api[_-]?key|authorization|session)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    "$1$2[REDACTED]",
  ],
];

const CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** Scrub secrets, credentials, CDP URLs, and control characters from timeline text. */
export function redactTimelineText(value: string, maxChars = MAX_TIMELINE_SUMMARY_CHARS): string {
  let text = value.replace(CONTROL_AND_BIDI_RE, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  const chars = Array.from(text);
  if (chars.length > maxChars) {
    return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
  }
  return text;
}

function sanitizeDetailValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactTimelineText(value, 160);
  if (depth >= 3 || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value.slice(0, 32)) {
        const sanitized = sanitizeDetailValue(item, depth + 1, seen);
        if (sanitized !== undefined) out.push(sanitized);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= 24) break;
      if (!key || key.length > 64 || CONTROL_AND_BIDI_RE.test(key)) continue;
      if (SENSITIVE_DETAIL_KEY_RE.test(key)) continue;
      const sanitized = sanitizeDetailValue(entry, depth + 1, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
        count++;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeTimelineDetail(detail?: Record<string, unknown>): {
  detail: Record<string, unknown>;
  json: string;
} {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return { detail: {}, json: "{}" };
  }
  const sanitized = sanitizeDetailValue(detail, 0, new Set<object>()) as Record<string, unknown>;
  let json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_TIMELINE_DETAIL_BYTES) {
    return { detail: sanitized, json };
  }
  // Drop fields iteratively until under budget; never overflow the 2048-byte cap.
  const trimmed: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(sanitized)) {
    const candidate = { ...trimmed, [key]: val, truncated: true };
    const nextJson = JSON.stringify(candidate);
    if (Buffer.byteLength(nextJson, "utf8") > MAX_TIMELINE_DETAIL_BYTES) break;
    trimmed[key] = val;
  }
  trimmed.truncated = true;
  json = JSON.stringify(trimmed);
  if (Buffer.byteLength(json, "utf8") > MAX_TIMELINE_DETAIL_BYTES) {
    return { detail: { truncated: true }, json: '{"truncated":true}' };
  }
  return { detail: trimmed, json };
}

/** Infer an actionable recovery affordance for a browser launch failure message. */
export function inferLaunchFailureRecoveryKind(errorMessage: string): ProfileRecoveryKind {
  if (/proxy|407|socks|relay|tunnel/i.test(errorMessage)) return "proxy";
  if (/timeout|timed out|dns|enotfound|econnrefused|unreachable|network/i.test(errorMessage)) return "network";
  if (/kernel|binary|runtime|executable|download|firefox|chromium|not installed|missing/i.test(errorMessage)) return "runtime";
  return "retry_start";
}

/**
 * Centralized redacting event writer for a profile's operation timeline.
 * Enforces the event type whitelist, strips sensitive values, lazily retains
 * the latest 200 events per profile, and NEVER throws to callers.
 */
export function recordProfileEvent(
  store: Pick<ProfileStore, "rawDatabase" | "withTransaction">,
  input: RecordProfileEventInput,
): ProfileTimelineEvent | null {
  try {
    if (!store || typeof store.rawDatabase !== "function" || typeof store.withTransaction !== "function") return null;
    if (!isSafeProfileId(input.profileId)) return null;
    if (!EVENT_TYPE_SET.has(input.eventType)) return null;
    const status: ProfileEventStatus = STATUS_SET.has(input.status) ? input.status : "info";
    const actor: ProfileEventActor = input.actor && ACTOR_SET.has(input.actor) ? input.actor : "user";
    const recoveryKind: ProfileRecoveryKind =
      input.recoveryKind && RECOVERY_SET.has(input.recoveryKind) ? input.recoveryKind : "";
    const summary = redactTimelineText(String(input.summary ?? ""), MAX_TIMELINE_SUMMARY_CHARS) || input.eventType;
    const { detail, json } = sanitizeTimelineDetail(input.detail);
    const createdAt =
      typeof input.createdAt === "number" && Number.isSafeInteger(input.createdAt) && input.createdAt > 0
        ? input.createdAt
        : Date.now();

    const id = store.withTransaction(() => {
      const db = store.rawDatabase();
      const inserted = db
        .query(
          `INSERT INTO profile_events
             (profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.profileId, input.eventType, status, actor, summary, json, recoveryKind, createdAt);

      // Lazy retention: keep only the latest 200 events for this profile.
      db.query(
        `DELETE FROM profile_events
         WHERE profile_id = ?
           AND id NOT IN (
             SELECT id FROM profile_events
             WHERE profile_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`,
      ).run(input.profileId, input.profileId, MAX_PROFILE_EVENTS);

      return Number(inserted.lastInsertRowid);
    });

    return {
      id,
      profileId: input.profileId,
      eventType: input.eventType,
      status,
      actor,
      summary,
      detail,
      recoveryKind,
      createdAt,
    };
  } catch {
    // Timeline recording is observational and must never block primary operations.
    return null;
  }
}

interface RawProfileEventRow {
  id: number;
  profile_id: string;
  event_type: string;
  status: string;
  actor: string;
  summary: string;
  detail_json: string;
  recovery_kind: string;
  created_at: number;
}

function rowToTimelineEvent(row: RawProfileEventRow): ProfileTimelineEvent {
  let parsedDetail: Record<string, unknown> = {};
  if (typeof row.detail_json === "string" && row.detail_json) {
    try {
      const parsed = JSON.parse(row.detail_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedDetail = parsed as Record<string, unknown>;
      }
    } catch {
      parsedDetail = {};
    }
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    eventType: EVENT_TYPE_SET.has(row.event_type) ? (row.event_type as ProfileEventType) : "config.updated",
    status: STATUS_SET.has(row.status) ? (row.status as ProfileEventStatus) : "info",
    actor: ACTOR_SET.has(row.actor) ? (row.actor as ProfileEventActor) : "system",
    summary: row.summary,
    detail: parsedDetail,
    recoveryKind: RECOVERY_SET.has(row.recovery_kind) ? (row.recovery_kind as ProfileRecoveryKind) : "",
    createdAt: row.created_at,
  };
}

export function listProfileEvents(
  store: Pick<ProfileStore, "rawDatabase">,
  profileId: string,
  options: ListProfileEventsOptions = {},
): ListProfileEventsResult {
  if (!isSafeProfileId(profileId)) {
    return { events: [], hasMore: false, nextBeforeId: null };
  }
  const rawLimit = options.limit ?? DEFAULT_TIMELINE_LIMIT;
  const limit = Number.isInteger(rawLimit)
    ? Math.min(Math.max(1, rawLimit), MAX_TIMELINE_LIMIT)
    : DEFAULT_TIMELINE_LIMIT;

  const typeFilter = options.type?.trim() || undefined;
  if (typeFilter && !EVENT_TYPE_SET.has(typeFilter)) {
    return { events: [], hasMore: false, nextBeforeId: null };
  }

  const db = store.rawDatabase();
  const fetchCount = limit + 1;
  let rows: RawProfileEventRow[];

  if (options.beforeId !== undefined && Number.isSafeInteger(options.beforeId) && options.beforeId > 0) {
    const cursor = db
      .query<{ created_at: number; id: number }, [string, number]>(
        `SELECT created_at, id FROM profile_events WHERE profile_id = ? AND id = ?`,
      )
      .get(profileId, options.beforeId);

    if (cursor) {
      if (typeFilter) {
        rows = db
          .query<RawProfileEventRow, [string, string, number, number, number, number]>(
            `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
             FROM profile_events
             WHERE profile_id = ? AND event_type = ?
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(profileId, typeFilter, cursor.created_at, cursor.created_at, cursor.id, fetchCount);
      } else {
        rows = db
          .query<RawProfileEventRow, [string, number, number, number, number]>(
            `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
             FROM profile_events
             WHERE profile_id = ?
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(profileId, cursor.created_at, cursor.created_at, cursor.id, fetchCount);
      }
    } else if (typeFilter) {
      rows = db
        .query<RawProfileEventRow, [string, string, number, number]>(
          `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
           FROM profile_events
           WHERE profile_id = ? AND event_type = ? AND id < ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(profileId, typeFilter, options.beforeId, fetchCount);
    } else {
      rows = db
        .query<RawProfileEventRow, [string, number, number]>(
          `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
           FROM profile_events
           WHERE profile_id = ? AND id < ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(profileId, options.beforeId, fetchCount);
    }
  } else if (typeFilter) {
    rows = db
      .query<RawProfileEventRow, [string, string, number]>(
        `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
         FROM profile_events
         WHERE profile_id = ? AND event_type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(profileId, typeFilter, fetchCount);
  } else {
    rows = db
      .query<RawProfileEventRow, [string, number]>(
        `SELECT id, profile_id, event_type, status, actor, summary, detail_json, recovery_kind, created_at
         FROM profile_events
         WHERE profile_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(profileId, fetchCount);
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map(rowToTimelineEvent);
  const nextBeforeId = hasMore && events.length > 0 ? events[events.length - 1]!.id : null;
  return { events, hasMore, nextBeforeId };
}

export function clearProfileEvents(store: Pick<ProfileStore, "rawDatabase">, profileId: string): number {
  if (!isSafeProfileId(profileId)) return 0;
  const res = store.rawDatabase().query(`DELETE FROM profile_events WHERE profile_id = ?`).run(profileId);
  return Number(res.changes);
}
