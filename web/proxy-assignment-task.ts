import { isSafeProfileId } from "../src/profile-id.ts";

type ViewStatus = "ready" | "updated" | "unchanged" | "missing" | "skipped" | "failed";
type Outcome = Exclude<ViewStatus, "ready"> | "not-started";
export type ProxyAssignmentReason = "profile-open" | "changed" | "no-match" | "invalid-input" | "no-replacement" | "duplicate-target" | "write-failed" | "not-started" | "unconfirmed";
export interface ProxyAssignmentRow {
  /** Original preview position only; no environment name, address, credentials or input. */
  readonly number: number;
  readonly status: ViewStatus | "applying" | "unknown" | "not-started";
  readonly reason: ProxyAssignmentReason | null;
  readonly attempts: number;
  readonly retryable: boolean;
}
export interface ProxyAssignmentSummary {
  readonly total: number; readonly ready: number; readonly applying: number;
  readonly updated: number; readonly unchanged: number; readonly failed: number;
  readonly skipped: number; readonly missing: number; readonly unknown: number;
  readonly notStarted: number; readonly retryable: number;
}
export interface ProxyAssignmentReceipt {
  readonly batch: number; readonly attempt: number;
  readonly rows: readonly ProxyAssignmentRow[];
  readonly summary: ProxyAssignmentSummary;
  readonly source: "stream" | "status" | "seal" | "retired";
  readonly completedAt: number;
  readonly refreshFailed: boolean;
}
export interface ProxyAssignmentSnapshot {
  readonly batch: number;
  readonly phase: "idle" | "review" | "preparing-retry" | "preflighting" | "applying" | "reconciling" | "refreshing" | "settled";
  readonly busy: boolean;
  readonly rows: readonly ProxyAssignmentRow[];
  readonly summary: ProxyAssignmentSummary;
  readonly reviewNumbers: readonly number[];
  readonly reviewReadyNumbers: readonly number[];
  readonly reviewReady: number;
  readonly attempt: number;
  readonly progress: Readonly<{ phase: "loading" | "applying"; completed: number; total: number }> | null;
  readonly notice: "invalid-preview" | "workspace-changed" | "workspace-busy" | "retry-unavailable" | "recovery-unavailable" | "waiting-for-backend" | "status-unavailable" | "refresh-unavailable" | null;
  readonly latest: ProxyAssignmentReceipt | null;
  readonly history: readonly ProxyAssignmentReceipt[];
  readonly refreshFailed: boolean;
  readonly receivingStopped: boolean;
}
export interface ProxyAssignmentLease { refreshing?(): void; release(): void }
export interface ProxyAssignmentAttempt { readonly operationScope: string; readonly previewId: string; readonly attemptId: string }
export interface ProxyAssignmentTaskOptions {
  /** Existing apply stream plus the proposed client attempt ID. No private input is resubmitted. */
  apply(attempt: ProxyAssignmentAttempt, signal: AbortSignal): Promise<Response>;
  retryPreview(input: { previewId: string; ids: readonly string[] }, signal: AbortSignal): Promise<Response>;
  /** Required recovery protocol; do not wire this owner to an older server without status/seal support. */
  readStatus(attempt: ProxyAssignmentAttempt): Promise<Response>;
  closeUnseen(attempt: ProxyAssignmentAttempt): Promise<Response>;
  workspaceId?: () => string | null;
  acquire?: (workspaceId: string | null) => ProxyAssignmentLease | null;
  /** Must reject on any required roster/workspace read failure. Awaited before releasing the lease. */
  refresh?: () => Promise<unknown>;
  now?: () => number;
  makeAttemptId?: () => string;
  pollDelayMs?: number;
}

/** Details for the current review table only. These never enter receipts. */
export interface ProxyAssignmentDisplayRow {
  readonly index: number;
  readonly profileId?: string;
  readonly name?: string;
  readonly group?: string;
  readonly previousProxy: string | null;
  readonly proxy: string | null;
}
interface PrivateRow {
  index: number; profileId?: string; proxy: string | null;
  status: ViewStatus; code?: string;
  display: ProxyAssignmentDisplayRow;
}
interface PrivatePreview { id: string; operationScope: string; rows: readonly PrivateRow[]; unusedProxies: number }
interface LedgerRow { original: PrivateRow; display: ProxyAssignmentDisplayRow; status: ProxyAssignmentRow["status"]; reason: ProxyAssignmentReason | null; attempts: number }
interface ActiveAttempt extends ProxyAssignmentAttempt { rows: readonly PrivateRow[]; number: number }
interface OperationReply {
  phase: "running" | "settled" | "sealed" | "retired";
  rows: readonly { index: number; profileId?: string; status: ViewStatus | "not-started"; code?: string }[];
}
const statuses: readonly string[] = ["ready", "updated", "unchanged", "missing", "skipped", "failed"];
const codes: Readonly<Record<string, ProxyAssignmentReason>> = Object.freeze({
  profile_open: "profile-open", version_conflict: "changed", no_editable_match: "no-match",
  invalid_row: "invalid-input", invalid_proxy: "invalid-input", no_replacement: "no-replacement",
  duplicate_target: "duplicate-target", update_failed: "write-failed", cancelled: "not-started",
});
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(value);
const attemptId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const reason = (status: ViewStatus | "not-started", code?: string): ProxyAssignmentReason | null => code ? codes[code] ?? "unconfirmed" : status === "failed" ? "write-failed" : status === "not-started" ? "not-started" : null;
class InvalidProxyAssignment extends Error { constructor(readonly protocol = true) { super("The proxy result could not be confirmed."); } }

function displayProxy(value: string | null): string | null {
  if (!value) return null;
  // The service sends only scheme, host and port. Keep credentials out of the
  // review even if an unexpected response supplies user information.
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "socks5:"].includes(parsed.protocol) || !parsed.hostname) return null;
    const port = parsed.port || (parsed.protocol === "http:" ? "80" : parsed.protocol === "https:" ? "443" : "");
    return port ? `${parsed.protocol}//${parsed.hostname}:${port}` : null;
  } catch { return null; }
}

function viewRow(value: unknown): PrivateRow | null {
  if (!record(value) || !keys(value, ["index", "profileId", "name", "group", "previousProxy", "proxy", "status", "code"])
    || !integer(value.index) || typeof value.status !== "string" || !statuses.includes(value.status)
    || !(value.proxy === null || typeof value.proxy === "string") || !(value.previousProxy === null || typeof value.previousProxy === "string")
    || value.profileId !== undefined && !isSafeProfileId(value.profileId)
    || value.name !== undefined && typeof value.name !== "string" || value.group !== undefined && typeof value.group !== "string"
    || value.code !== undefined && (typeof value.code !== "string" || !Object.hasOwn(codes, value.code))) return null;
  if (["ready", "updated", "unchanged", "failed"].includes(String(value.status)) && !value.profileId) return null;
  const identity = { index: value.index, ...(value.profileId === undefined ? {} : { profileId: value.profileId }) };
  const display = Object.freeze({ ...identity, name: value.name as string | undefined, group: value.group as string | undefined,
    previousProxy: displayProxy(value.previousProxy as string | null), proxy: displayProxy(value.proxy as string | null) });
  return Object.freeze({ ...identity, display, proxy: value.proxy as string | null, status: value.status as ViewStatus, ...(value.code === undefined ? {} : { code: value.code as string }) });
}
function capturePreview(value: unknown): PrivatePreview | null {
  if (!record(value) || !keys(value, ["ok", "previewId", "operationScope", "rows", "unusedProxies"]) || value.ok !== true || !token(value.previewId) || !attemptId(value.operationScope) || !integer(value.unusedProxies) || !Array.isArray(value.rows)) return null;
  const rows: PrivateRow[] = [], indices = new Set<number>(), ids = new Map<string, PrivateRow[]>();
  for (const valueRow of value.rows) {
    const row = viewRow(valueRow);
    if (!row || indices.has(row.index) || row.status === "updated") return null;
    indices.add(row.index); rows.push(row);
    if (row.profileId) { const group = ids.get(row.profileId) ?? []; group.push(row); ids.set(row.profileId, group); }
  }
  // The real backend retains conflicting input rows, each with its own index.
  if ([...ids.values()].some(group => group.length > 1 && group.some(row => row.status !== "skipped" || row.code !== "duplicate_target"))) return null;
  return Object.freeze({ id: value.previewId, operationScope: value.operationScope, rows: Object.freeze(rows), unusedProxies: value.unusedProxies });
}
const sameTarget = (row: Pick<PrivateRow, "index" | "profileId">, expected: Pick<PrivateRow, "index" | "profileId">) => row.index === expected.index && row.profileId === expected.profileId;

/** Validates the real NDJSON contract, including unique row identities and complete EOF coverage. */
export async function readProxyAssignmentStream(response: Response, expected: readonly PrivateRow[], signal: AbortSignal,
  onRow: (row: PrivateRow) => void, onProgress: (progress: NonNullable<ProxyAssignmentSnapshot["progress"]>) => void): Promise<void> {
  if (response.status !== 200 || !response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson")) throw new InvalidProxyAssignment(false);
  const byIndex = new Map(expected.map(row => [row.index, row])), seen = new Set<number>();
  const readyCount = expected.filter(row => row.status === "ready").length;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  let pending = "", done = false, progress: NonNullable<ProxyAssignmentSnapshot["progress"]> | null = null;
  const accept = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new InvalidProxyAssignment(); }
    if (!record(event) || done) throw new InvalidProxyAssignment();
    if (event.type === "replacement" && keys(event, ["type", "row"])) {
      const row = viewRow(event.row), original = row && byIndex.get(row.index);
      if (!row || !original || !sameTarget(row, original) || row.proxy !== original.proxy || row.status === "ready" || seen.has(row.index)) throw new InvalidProxyAssignment();
      seen.add(row.index); onRow(row); return;
    }
    if (event.type === "progress" && keys(event, ["type", "phase", "completed", "total"]) && typeof event.phase === "string" && ["loading", "applying"].includes(event.phase)
      && integer(event.completed) && integer(event.total) && event.completed <= event.total) {
      const next = { phase: event.phase as "loading" | "applying", completed: event.completed, total: event.total };
      if (progress && (progress.phase === "applying" && next.phase === "loading" || progress.phase === next.phase && (progress.total !== next.total || next.completed < progress.completed))) throw new InvalidProxyAssignment();
      if (next.phase === "applying" && next.total !== readyCount) throw new InvalidProxyAssignment();
      progress = next; onProgress(Object.freeze(next)); return;
    }
    if (event.type === "done" && keys(event, ["type"])) { if (seen.size !== expected.length) throw new InvalidProxyAssignment(); done = true; return; }
    if (event.type === "error" && keys(event, ["type", "error"]) && typeof event.error === "string") throw new InvalidProxyAssignment(false);
    throw new InvalidProxyAssignment();
  };
  try {
    if (signal.aborted) throw new InvalidProxyAssignment(false);
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new InvalidProxyAssignment(false);
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) { const line = pending.slice(0, end); pending = pending.slice(end + 1); accept(line); }
    }
    pending += decoder.decode(); if (pending.trim()) accept(pending);
    if (!done) throw new InvalidProxyAssignment(false);
  } finally { signal.removeEventListener("abort", stop); try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

function summary(rows: readonly ProxyAssignmentRow[]): ProxyAssignmentSummary {
  const counts = { total: rows.length, ready: 0, applying: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, missing: 0, unknown: 0, notStarted: 0, retryable: 0 };
  for (const row of rows) { if (row.status === "not-started") counts.notStarted++; else counts[row.status]++; if (row.retryable) counts.retryable++; }
  return Object.freeze(counts);
}

/** Workspace-session owner. Snapshots/history deliberately contain positions and fixed outcomes only. */
export function createProxyAssignmentTask(options: ProxyAssignmentTaskOptions) {
  let batch = 0, attemptNumber = 0, unusedProxies = 0, workspace: string | null = null;
  let phase: ProxyAssignmentSnapshot["phase"] = "idle", busy = false;
  let preview: PrivatePreview | null = null, review: PrivatePreview | null = null, ledger: LedgerRow[] = [];
  let ledgerByIndex = new Map<number, LedgerRow>();
  let active: ActiveAttempt | null = null, observer: AbortController | null = null;
  let receivingStopped = false, refreshFailed = false, notice: ProxyAssignmentSnapshot["notice"] = null;
  let progress: ProxyAssignmentSnapshot["progress"] = null, latest: ProxyAssignmentReceipt | null = null;
  const history: ProxyAssignmentReceipt[] = [], listeners = new Set<() => void>(), now = options.now ?? Date.now;
  let wake: (() => void) | null = null;
  const retryable = (row: LedgerRow) => !!row.original.profileId && ["failed", "skipped"].includes(row.status) && !["duplicate-target", "invalid-input", "no-replacement"].includes(row.reason ?? "");
  const safeRows = () => Object.freeze(ledger.map(row => Object.freeze({ number: row.original.index + 1, status: row.status, reason: row.reason, attempts: row.attempts, retryable: !busy && retryable(row) })));
  const snapshot = (): ProxyAssignmentSnapshot => {
    const rows = safeRows();
    const reviewReadyNumbers = Object.freeze((review?.rows ?? []).filter(row => row.status === "ready").map(row => row.index + 1));
    return Object.freeze({ batch, phase, busy, rows, summary: summary(rows), reviewNumbers: Object.freeze((review?.rows ?? []).map(row => row.index + 1)),
      reviewReadyNumbers, reviewReady: reviewReadyNumbers.length, attempt: attemptNumber,
      progress, notice, latest, history: Object.freeze([...history]), refreshFailed, receivingStopped });
  };
  let published = snapshot();
  function publish() { published = snapshot(); for (const listener of [...listeners]) { try { listener(); } catch {} } return published; }
  function sameWorkspace() { try { return (options.workspaceId?.() ?? null) === workspace; } catch { return false; } }
  function block(reason: NonNullable<ProxyAssignmentSnapshot["notice"]>) { notice = reason; publish(); return false; }
  function acquire() { try { return options.acquire ? options.acquire(workspace) : { release() {} }; } catch { return null; } }
  function update(row: { index: number; status: ViewStatus | "not-started"; code?: string }) {
    const current = ledgerByIndex.get(row.index);
    if (current) { current.status = row.status; current.reason = reason(row.status, row.code); }
  }
  function waitForStatus(delay = options.pollDelayMs ?? 700) {
    return new Promise<void>(resolve => {
      const finish = () => { if (timer !== undefined) clearTimeout(timer); if (wake === finish) wake = null; resolve(); };
      const timer = delay === Infinity ? undefined : setTimeout(finish, delay);
      wake = finish;
    });
  }
  async function finish(lease: ProxyAssignmentLease, source: ProxyAssignmentReceipt["source"]) {
    phase = "refreshing"; lease.refreshing?.(); publish();
    try {
      for (;;) {
        try { await options.refresh?.(); refreshFailed = false; break; }
        catch { refreshFailed = true; if (source !== "retired") break; notice = "refresh-unavailable"; publish(); await waitForStatus(Infinity); }
      }
    }
    finally {
      lease.release(); busy = false; phase = "settled"; active = null; observer = null; notice = null;
      const rows = safeRows();
      latest = Object.freeze({ batch, attempt: attemptNumber, rows, summary: summary(rows), source, completedAt: now(), refreshFailed });
      history.push(latest); if (history.length > 20) history.shift(); publish();
    }
  }
  // The operation DTO is intentionally validated here rather than trusted from a transport adapter.
  async function operationReply(response: Response, current: ActiveAttempt): Promise<OperationReply | "not-found"> {
    const body: unknown = await response.json();
    if (response.status === 404 && record(body) && keys(body, ["ok", "code"]) && body.ok === false && body.code === "operation_not_found") return "not-found";
    if (response.status !== 200 || !response.ok || !record(body) || !keys(body, ["ok", "operation"]) || body.ok !== true || !record(body.operation)) throw new InvalidProxyAssignment();
    const op = body.operation;
    if (!keys(op, ["version", "operationScope", "attemptId", "previewId", "phase", "total", "rows", "startedAt", "finishedAt"]) || op.version !== 1 || op.operationScope !== current.operationScope || op.attemptId !== current.attemptId || op.previewId !== current.previewId
      || typeof op.phase !== "string" || !["running", "settled", "sealed", "retired"].includes(op.phase) || !integer(op.total) || !Array.isArray(op.rows)
      || !(op.startedAt === null || integer(op.startedAt)) || !(op.finishedAt === null || integer(op.finishedAt))) throw new InvalidProxyAssignment();
    if (op.phase === "sealed" || op.phase === "retired") {
      if (op.total !== 0 || op.rows.length || op.startedAt !== null || !integer(op.finishedAt)) throw new InvalidProxyAssignment();
      return { phase: op.phase, rows: [] };
    }
    if (op.total !== current.rows.length || op.rows.length !== current.rows.length || !integer(op.startedAt)
      || op.phase === "running" && op.finishedAt !== null || op.phase === "settled" && (!integer(op.finishedAt) || op.finishedAt < op.startedAt)) throw new InvalidProxyAssignment();
    const expected = new Map(current.rows.map(row => [row.index, row])), seen = new Set<number>();
    const rows: OperationReply["rows"][number][] = [];
    for (const value of op.rows) {
      if (!record(value) || !keys(value, ["index", "profileId", "status", "code"]) || !integer(value.index) || typeof value.status !== "string" || ![...statuses, "not-started"].includes(value.status)
        || value.profileId !== undefined && !isSafeProfileId(value.profileId) || value.code !== undefined && (typeof value.code !== "string" || !Object.hasOwn(codes, value.code))) throw new InvalidProxyAssignment();
      const original = expected.get(value.index);
      if (!original || value.profileId !== original.profileId || seen.has(value.index) || op.phase === "settled" && value.status === "ready") throw new InvalidProxyAssignment();
      seen.add(value.index); rows.push({ index: value.index, ...(value.profileId === undefined ? {} : { profileId: value.profileId as string }), status: value.status as ViewStatus | "not-started", ...(value.code === undefined ? {} : { code: value.code as string }) });
    }
    return { phase: op.phase as "running" | "settled", rows };
  }
  async function reconcile(current: ActiveAttempt, lease: ProxyAssignmentLease) {
    phase = "reconciling"; notice = "waiting-for-backend"; publish();
    for (;;) {
      try {
        const wire = Object.freeze({ operationScope: current.operationScope, previewId: current.previewId, attemptId: current.attemptId });
        let reply = await operationReply(await options.readStatus(wire), current);
        if (reply === "not-found") reply = await operationReply(await options.closeUnseen(wire), current);
        if (reply === "not-found") throw new InvalidProxyAssignment();
        if (reply.phase === "sealed") {
          for (const row of current.rows) update({ index: row.index, status: row.status === "ready" ? "not-started" : row.status });
          await finish(lease, "seal"); return;
        }
        if (reply.phase === "retired") {
          // The service proved that the old attempt can no longer write. It
          // cannot confirm its result after the receipt has been removed.
          for (const row of current.rows) if (row.status === "ready") {
            const entry = ledgerByIndex.get(row.index)!;
            entry.status = "unknown"; entry.reason = "unconfirmed";
          }
          await finish(lease, "retired"); return;
        }
        for (const row of reply.rows) if (row.status !== "ready") update(row);
        notice = "waiting-for-backend"; publish();
        if (reply.phase === "settled") { await finish(lease, "status"); return; }
      } catch { notice = "status-unavailable"; publish(); }
      await waitForStatus(notice === "status-unavailable" ? Infinity : undefined);
    }
  }
  const owner = {
    getSnapshot: () => published,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isBusy: () => busy,
    getDisplayRows: () => ledger.map(row => row.display),
    getUnusedProxies: () => unusedProxies,
    clearPreview() {
      if (busy || (!preview && !notice)) return false;
      preview = review = null; ledger = []; ledgerByIndex = new Map();
      phase = latest ? "settled" : "idle"; notice = null; progress = null; unusedProxies = 0;
      publish(); return true;
    },
    adoptPreview(value: unknown): boolean {
      if (busy) return false;
      const next = capturePreview(value); if (!next || next.rows.some(row => row.index >= next.rows.length)) return block("invalid-preview");
      try { workspace = options.workspaceId?.() ?? null; } catch { return block("workspace-changed"); }
      batch++; attemptNumber = 0; preview = review = next; phase = "review"; notice = null; progress = null; receivingStopped = false; refreshFailed = false;
      unusedProxies = next.unusedProxies;
      ledger = next.rows.map(original => ({ original, display: original.display, status: original.status, reason: reason(original.status, original.code), attempts: 0 }));
      ledgerByIndex = new Map(ledger.map(row => [row.original.index, row]));
      latest = null; publish(); return true;
    },
    async prepareRetry(): Promise<boolean> {
      if (busy || !preview || review?.rows.some(row => row.status === "ready") || !ledger.some(retryable)) return false;
      if (!sameWorkspace()) return block("workspace-changed");
      busy = true;
      const lease = acquire(); if (!lease) { busy = false; return block("workspace-busy"); }
      phase = "preparing-retry"; notice = null; review = null; publish();
      const expected = ledger.filter(retryable).map(row => row.original), ids = [...new Set(expected.flatMap(row => row.profileId ? [row.profileId] : []))];
      const expectedByIndex = new Map(expected.map(row => [row.index, row]));
      const controller = new AbortController();
      try {
        const response = await options.retryPreview({ previewId: preview.id, ids: Object.freeze(ids) }, controller.signal);
        const next = response.status === 200 && response.ok ? capturePreview(await response.json()) : null;
        if (!next || next.id === preview.id || next.operationScope !== preview.operationScope || next.rows.length !== expected.length || next.rows.some(row => { const original = expectedByIndex.get(row.index); return !original || !sameTarget(row, original) || row.proxy !== original.proxy; })) return block("retry-unavailable");
        for (const row of next.rows) ledgerByIndex.get(row.index)!.display = row.display;
        preview = review = next; phase = "review"; notice = null; return true;
      } catch { return block("retry-unavailable"); }
      finally { lease.release(); busy = false; if (phase === "preparing-retry") phase = latest ? "settled" : "review"; publish(); }
    },
    apply(): Promise<ProxyAssignmentSnapshot | null> {
      if (busy || !review?.rows.some(row => row.status === "ready")) return Promise.resolve(null);
      if (!sameWorkspace()) { block("workspace-changed"); return Promise.resolve(null); }
      busy = true;
      const lease = acquire(); if (!lease) { busy = false; block("workspace-busy"); return Promise.resolve(null); }
      let id: string;
      try { id = options.makeAttemptId?.() ?? crypto.randomUUID(); } catch { busy = false; lease.release(); block("invalid-preview"); return Promise.resolve(null); }
      if (!attemptId(id)) { busy = false; lease.release(); block("invalid-preview"); return Promise.resolve(null); }
      const current: ActiveAttempt = Object.freeze({ operationScope: review.operationScope, previewId: review.id, attemptId: id, rows: review.rows, number: attemptNumber + 1 });
      const wire = Object.freeze({ operationScope: current.operationScope, previewId: current.previewId, attemptId: current.attemptId });
      phase = "preflighting"; notice = null; publish();
      return (async () => {
        try {
          // An older server cannot safely reconcile interrupted writes. Check
          // the strict protocol before issuing any new data-changing request.
          if (await operationReply(await options.readStatus(wire), current) !== "not-found") throw new InvalidProxyAssignment();
        } catch {
          lease.release(); busy = false; phase = "review"; block("recovery-unavailable"); return null;
        }
        if (!sameWorkspace()) { lease.release(); busy = false; phase = "review"; block("workspace-changed"); return null; }
        active = current; observer = new AbortController(); const signal = observer.signal;
        attemptNumber = current.number; review = null; phase = "applying"; progress = null; notice = null; receivingStopped = false; refreshFailed = false;
        for (const row of current.rows) { const entry = ledgerByIndex.get(row.index)!; entry.attempts++; if (row.status === "ready") { entry.status = "applying"; entry.reason = null; } }
        publish();
        let abort!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(new InvalidProxyAssignment(false)); signal.addEventListener("abort", abort, { once: true }); });
        try {
          const observing = options.apply(wire, signal).then(response => {
            if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new InvalidProxyAssignment(false); }
            return readProxyAssignmentStream(response, current.rows, signal, row => { if (!signal.aborted) update(row); }, next => {
              if (signal.aborted) return;
              const last = published.progress; progress = next;
              // Bound full-ledger snapshots to useful visible progress steps.
              if (!last || last.phase !== next.phase || next.completed === next.total || next.completed - last.completed >= Math.max(1, Math.ceil(next.total / 100))) publish();
            });
          });
          await Promise.race([observing, interrupted]);
          // EOF closes receipt delivery. The server's operation record is the
          // positive acknowledgement that its real worker finally has ended.
          await reconcile(current, lease);
        } catch (error) {
          // Protocol violations quarantine this attempt. Previously confirmed
          // successes are never in a retry attempt and remain untouched.
          for (const row of current.rows) {
            const entry = ledgerByIndex.get(row.index)!;
            if (error instanceof InvalidProxyAssignment && error.protocol || entry.status === "applying") { entry.status = "unknown"; entry.reason = "unconfirmed"; }
          }
          await reconcile(current, lease);
        } finally { signal.removeEventListener("abort", abort); }
        return published;
      })();
    },
    stopReceiving() { if (phase !== "applying" || !observer) return false; receivingStopped = true; observer.abort(); publish(); return true; },
    reconcileNow() { if (phase !== "reconciling" && phase !== "refreshing") return false; wake?.(); return true; },
    async refreshResult(): Promise<boolean> {
      if (busy || !latest || !refreshFailed) return false;
      if (!sameWorkspace()) return block("workspace-changed");
      busy = true;
      const lease = acquire(); if (!lease) { busy = false; return block("workspace-busy"); }
      phase = "refreshing"; lease.refreshing?.(); publish();
      try { await options.refresh?.(); refreshFailed = false; }
      catch { refreshFailed = true; }
      finally {
        lease.release(); busy = false; phase = "settled";
        latest = Object.freeze({ ...latest, refreshFailed });
        const last = history.findLastIndex(receipt => receipt.batch === latest!.batch && receipt.attempt === latest!.attempt);
        if (last >= 0) history[last] = latest; publish();
      }
      return !refreshFailed;
    },
  };
  return owner;
}
export type ProxyAssignmentTask = ReturnType<typeof createProxyAssignmentTask>;
