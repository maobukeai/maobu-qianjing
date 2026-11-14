import { isSafeProfileId } from "../profile-id.ts";

export type CookieImportFormat = "single" | "json" | "netscape";
export interface CookieImportTarget { id: string; name: string; platform?: string }
export type CookieImportInput =
  | { format: "single"; input: { name: string; value: string; domain: string; path: string } }
  | { format: "json" | "netscape"; input: { text: string } };
export type CookieImportReason = "not-open" | "missing" | "write-failed" | "input-rejected" | "request-rejected" | "unconfirmed";
export interface CookieImportRow {
  readonly id: string;
  readonly name: string | null;
  readonly number: number;
  readonly status: "sending" | "succeeded" | "failed" | "unconfirmed";
  readonly attempts: number;
  readonly reason: CookieImportReason | null;
  readonly retryable: boolean;
}
export interface CookieImportSnapshot {
  readonly batchId: number;
  readonly phase: "idle" | "sending" | "refreshing" | "settled";
  readonly format: CookieImportFormat | null;
  readonly rows: readonly CookieImportRow[];
  readonly summary: Readonly<{ total: number; sending: number; succeeded: number; failed: number; unconfirmed: number; retryable: number; live: number; nextStart: number; cookieCount: number | null }>;
  readonly blockedReason: string | null;
  readonly refreshFailed: boolean;
}
export interface CookieImportLease { refreshing?(): void; release(): void }
export interface CookieImportTaskOptions {
  /** Raw HTTP response is necessary: the bulk route's status is part of the contract. */
  post?: (ids: string[], input: Record<string, string>) => Promise<Response>;
  workspaceId?: () => string | null;
  acquire?: (workspaceId: string | null) => CookieImportLease | null;
  onSettled?: (snapshot: CookieImportSnapshot) => void | Promise<void>;
}
export const COOKIE_IMPORT_REASONS: Record<CookieImportReason, string> = {
  "not-open": "The browser was not ready to receive cookies. Check it before retrying.",
  missing: "This environment no longer exists. Review it before retrying.",
  "write-failed": "Cookies could not be added to this environment. Review it before retrying.",
  "input-rejected": "The cookie input was rejected before any environment was changed. Review the input and start a new import.",
  "request-rejected": "The cookie request was rejected before any environment was changed. Review local access before starting a new import.",
  unconfirmed: "The cookie result is unknown. Inspect the browser or pending cookies before starting another import. This request will not be sent again automatically.",
};
const BLOCKED = "A workspace task is in progress. Wait for it to finish before importing cookies.";
const WORKSPACE_CHANGED = "Return to the original workspace before retrying this cookie import.";
const INVALID = "Choose valid environments and complete the cookie input before importing.";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const postCookieImport = (ids: string[], input: Record<string, string>) => fetch("/ui/api/profiles/cookies", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, ...input }),
  redirect: "error", credentials: "same-origin", cache: "no-store",
});

/** Names only: URLs, credentials, control characters and pasted cookie fragments never become feedback. */
function safeName(value: unknown, sensitive: readonly string[] | null): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFC");
  if (!name || Array.from(name).length > 100 || !/^[\p{L}\p{N} _().\-·]+$/u.test(name)
    || /(?:password|authorization|bearer|cookie|secret|token)\s*[=:]/i.test(name)) return null;
  if (!sensitive || sensitive.some(value => name.includes(value))) return null;
  return name;
}
/** Parse private values once per submission, never once per environment. Invalid input withholds names. */
function sensitiveValues(input: Record<string, string>): readonly string[] | null {
  if (input.value !== undefined) return input.value ? [input.value] : [];
  const text = input.text!;
  try {
    const parsed: unknown = JSON.parse(text);
    const cookies = Array.isArray(parsed) ? parsed : record(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : record(parsed) ? [parsed] : null;
    // Safe names have at most 100 code points (200 UTF-16 units). Longer values cannot fit in a name.
    return cookies ? [...new Set(cookies.flatMap(cookie => record(cookie) && typeof cookie.value === "string" && cookie.value && cookie.value.length <= 200 ? [cookie.value] : []))] : null;
  } catch {
    const lines = text.split(/\r?\n/).filter(line => line.trim() && (!line.startsWith("#") || line.startsWith("#HttpOnly_")));
    if (!lines.length || lines.some(line => line.split("\t").length < 6)) return null;
    return [...new Set(lines.map(line => line.split("\t").slice(6).join("\t")).filter(value => value && value.length <= 200))];
  }
}
function captureInput(value: unknown): { format: CookieImportFormat; serialized: string; payload: Record<string, string> } | null {
  if (!record(value) || !record(value.input)) return null;
  const input = value.input;
  if (value.format === "single") {
    if (typeof input.name !== "string" || typeof input.value !== "string" || typeof input.domain !== "string" || typeof input.path !== "string"
      || !input.name || !input.domain.trim() || !input.path.startsWith("/")) return null;
    const payload = { name: input.name, value: input.value, domain: input.domain, path: input.path };
    return { format: "single", serialized: JSON.stringify(payload), payload };
  }
  if ((value.format !== "json" && value.format !== "netscape") || typeof input.text !== "string" || !input.text.trim()) return null;
  const payload = { text: input.text };
  return { format: value.format, serialized: JSON.stringify(payload), payload };
}
type Reply = { kind: "accepted"; cookieCount: number; live: number; nextStart: number; failures: Map<string, CookieImportReason> }
  | { kind: "rejected"; reason: CookieImportReason } | { kind: "unknown" };
/** This route reports aggregate timing and explicit failed IDs; it does not report per-ID timing. */
async function readReply(response: Response, ids: readonly string[], expectedCookieCount: number | null): Promise<Reply> {
  const body: unknown = await response.json();
  if (!record(body)) return { kind: "unknown" };
  if ((response.status === 400 || response.status === 403) && body.ok === false && typeof body.error === "string"
    && Object.keys(body).every(key => key === "ok" || key === "error")) {
    return { kind: "rejected", reason: response.status === 400 ? "input-rejected" : "request-rejected" };
  }
  if (response.status !== 200 || !response.ok || typeof body.ok !== "boolean"
    || !count(body.count) || body.count < 1 || !count(body.live) || !count(body.nextStart) || !Array.isArray(body.errors)
    || Object.keys(body).some(key => !["ok", "count", "live", "nextStart", "errors"].includes(key))
    || (expectedCookieCount !== null && body.count !== expectedCookieCount)) return { kind: "unknown" };
  const submitted = new Set(ids), failures = new Map<string, CookieImportReason>();
  for (const item of body.errors) {
    if (!record(item) || typeof item.id !== "string" || !submitted.has(item.id) || failures.has(item.id)
      || typeof item.error !== "string" || Object.keys(item).some(key => key !== "id" && key !== "error")) return { kind: "unknown" };
    failures.set(item.id, item.error === "profile browser is not open" ? "not-open" : item.error === "no such profile" ? "missing" : "write-failed");
  }
  if (body.live + body.nextStart + failures.size !== ids.length || body.ok !== (failures.size === 0)) return { kind: "unknown" };
  return { kind: "accepted", cookieCount: body.count, live: body.live, nextStart: body.nextStart, failures };
}

/** Session-only task. Private input lives only in the closure and never appears in snapshots, receipts or errors. */
export function createCookieImportTask(options: CookieImportTaskOptions = {}) {
  let batchId = 0, rows: readonly CookieImportRow[] = [], phase: CookieImportSnapshot["phase"] = "idle";
  let format: CookieImportFormat | null = null, blockedReason: string | null = null, refreshFailed = false;
  let serialized: string | null = null, ownerWorkspace: string | null = null, live = 0, nextStart = 0, cookieCount: number | null = null;
  let busy = false, current: Promise<CookieImportSnapshot | null> | null = null;
  const listeners = new Set<() => void>();
  function snapshot(): CookieImportSnapshot {
    const summary = { total: rows.length, sending: 0, succeeded: 0, failed: 0, unconfirmed: 0, retryable: 0, live, nextStart, cookieCount };
    for (const row of rows) { summary[row.status]++; if (row.retryable) summary.retryable++; }
    return Object.freeze({ batchId, phase, format, rows: Object.freeze([...rows]), summary: Object.freeze(summary), blockedReason, refreshFailed });
  }
  let published = snapshot();
  function publish() { published = snapshot(); for (const listener of [...listeners]) { try { listener(); } catch { /* Views cannot interrupt an issued mutation. */ } } return published; }
  function block(message: string) { blockedReason = message; publish(); return Promise.resolve(null); }
  function run(ids: readonly string[], prepare: () => void): Promise<CookieImportSnapshot | null> {
    // Claim ownership before acquisition, subscribers or microtasks can issue another request.
    busy = true;
    let lease: CookieImportLease | null | undefined;
    try { lease = options.acquire?.(ownerWorkspace); }
    catch { busy = false; return block(BLOCKED); }
    if (options.acquire && !lease) { busy = false; return block(BLOCKED); }
    prepare(); phase = "sending"; blockedReason = null; refreshFailed = false;
    const submitted = Object.freeze([...ids]);
    current = Promise.resolve().then(async () => {
      let reply: Reply;
      try { reply = await readReply(await (options.post ?? postCookieImport)([...submitted], JSON.parse(serialized!)), submitted, format === "single" ? 1 : cookieCount); }
      catch { reply = { kind: "unknown" }; }
      const attempted = new Set(submitted);
      if (reply.kind === "accepted") { live += reply.live; nextStart += reply.nextStart; cookieCount = reply.cookieCount; }
      rows = rows.map(row => {
        if (!attempted.has(row.id)) return row;
        const reason = reply.kind === "accepted" ? reply.failures.get(row.id) ?? null : reply.kind === "rejected" ? reply.reason : "unconfirmed";
        return Object.freeze({ ...row, status: reply.kind === "accepted" ? reason ? "failed" : "succeeded" : reply.kind === "rejected" ? "failed" : "unconfirmed",
          reason, retryable: reply.kind === "accepted" && reason !== null });
      });
      if (!rows.some(row => row.retryable)) serialized = null;
      if (options.onSettled) {
        phase = "refreshing"; publish();
        try { lease?.refreshing?.(); await options.onSettled(published); }
        catch { refreshFailed = true; }
      }
      phase = "settled";
      // Release the coordinator only after both the issued POST and any refresh have settled.
      try { lease?.release(); } catch { /* A receipt still has to settle. */ }
      busy = false; current = null;
      return publish();
    });
    publish();
    return current;
  }
  return {
    getSnapshot: () => published,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isBusy: () => busy,
    submit(targets: readonly CookieImportTarget[], input: CookieImportInput): Promise<CookieImportSnapshot | null> {
      if (busy) return Promise.resolve(null);
      let captured: ReturnType<typeof captureInput>, nextRows: readonly CookieImportRow[], workspace: string | null;
      try {
        captured = captureInput(input);
        if (!captured || !Array.isArray(targets) || !targets.length || !targets.every(target => target && isSafeProfileId(target.id))) return block(INVALID);
        const seen = new Set<string>(), sensitive = sensitiveValues(captured.payload);
        nextRows = targets.flatMap(target => { if (seen.has(target.id)) return []; seen.add(target.id); return [Object.freeze({ id: target.id, name: safeName(target.name, sensitive), number: seen.size,
          status: "sending" as const, attempts: 1, reason: null, retryable: false })]; });
        workspace = options.workspaceId?.() ?? null;
      } catch { return block(INVALID); }
      // The old failed batch remains retryable when a workspace lease refuses a new import.
      const previousWorkspace = ownerWorkspace; ownerWorkspace = workspace;
      const operation = run(nextRows.map(row => row.id), () => { batchId++; rows = nextRows; format = captured!.format; serialized = captured!.serialized; live = 0; nextStart = 0; cookieCount = null; });
      if (!busy) ownerWorkspace = previousWorkspace;
      return operation;
    },
    retryFailed(): Promise<CookieImportSnapshot | null> {
      if (busy || !serialized) return Promise.resolve(null);
      const ids = rows.filter(row => row.retryable && row.status === "failed").map(row => row.id);
      if (!ids.length) return Promise.resolve(null);
      try { if ((options.workspaceId?.() ?? null) !== ownerWorkspace) return block(WORKSPACE_CHANGED); }
      catch { return block(WORKSPACE_CHANGED); }
      const retry = new Set(ids);
      return run(ids, () => { rows = rows.map(row => retry.has(row.id) ? Object.freeze({ ...row, status: "sending", attempts: row.attempts + 1, reason: null, retryable: false }) : row); });
    },
    /** Dismissal is deliberately unavailable during writes; hiding a window is a separate UI action. */
    dismiss() {
      if (busy) return false;
      serialized = null; rows = []; phase = "idle"; format = null; blockedReason = null; refreshFailed = false; live = 0; nextStart = 0; cookieCount = null; ownerWorkspace = null;
      publish(); return true;
    },
  };
}
export type CookieImportTask = ReturnType<typeof createCookieImportTask>;
