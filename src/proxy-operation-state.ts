/** Bounded, process-local receipt/fence state. Never stores proxy values, credentials, names or browser state. */
import { isSafeProfileId } from "./profile-id.ts";

export const PROXY_OPERATION_CODES = ["profile_open", "version_conflict", "no_editable_match", "invalid_row", "invalid_proxy", "no_replacement", "duplicate_target", "update_failed", "cancelled"] as const;
export type ProxyOperationCode = typeof PROXY_OPERATION_CODES[number];
export type ProxyOperationPhase = "running" | "settled" | "sealed" | "retired";
export type ProxyOperationRowStatus = "ready" | "updated" | "unchanged" | "missing" | "skipped" | "failed" | "not-started";
export interface ProxyOperationRow { index: number; profileId?: string; status: ProxyOperationRowStatus; code?: ProxyOperationCode }
export interface ProxyOperationSnapshot {
  version: 1;
  operationScope: string;
  attemptId: string;
  previewId: string;
  phase: ProxyOperationPhase;
  total: number;
  rows: ProxyOperationRow[];
  startedAt: number | null;
  finishedAt: number | null;
}
export interface ProxyOperationBinding { operationScope: string; attemptId: string; previewId: string }
export interface ProxyOperationClaim extends ProxyOperationBinding { rows: readonly ProxyOperationRow[]; selectedIndices?: readonly number[] }
const ownerBrand = Symbol("proxy-operation-owner");
export interface ProxyOperationOwner { readonly attemptId: string; readonly [ownerBrand]: symbol }
export type ProxyOperationAdmission = { kind: "started"; operation: ProxyOperationSnapshot; owner: ProxyOperationOwner } | { kind: "existing"; operation: ProxyOperationSnapshot };
export interface ProxyOperationReconciliation { operation: ProxyOperationSnapshot | null; invalidatedPreviewId: string | null }
export type ProxyOperationErrorCode = "operation_invalid" | "operation_scope_mismatch" | "operation_binding_mismatch" | "operation_capacity" | "operation_running" | "operation_preview_expired" | "operation_state_conflict";
const failures = {
  operation_invalid: [400, "The proxy operation request is invalid. Review the task before trying again."],
  operation_scope_mismatch: [404, "The proxy task belongs to another server session. Its outcome is unconfirmed; do not repeat the apply request."],
  operation_binding_mismatch: [409, "This proxy attempt belongs to a different reviewed selection. Its outcome was not changed."],
  operation_capacity: [503, "Proxy task tracking is full. Confirm the current task before starting another apply request."],
  operation_running: [409, "A proxy replacement is still running. Check its status before starting another task."],
  operation_preview_expired: [409, "Preview expired. Preview the replacements again."],
  operation_state_conflict: [409, "The proxy task result could not be recorded safely. Keep its outcome unconfirmed and reload the task."],
} as const;
export class ProxyOperationStateError extends Error {
  override readonly name = "ProxyOperationStateError";
  readonly status: number;
  constructor(readonly code: ProxyOperationErrorCode) { super(failures[code][1]); this.status = failures[code][0]; }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function isProxyOperationUuid(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
function previewSequence(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^([1-9a-z][0-9a-z]*)\.([a-f0-9-]+)$/.exec(value);
  if (!match || !isProxyOperationUuid(match[2])) return null;
  const sequence = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence.toString(36) === match[1] ? sequence : null;
}
export function isProxyOperationPreviewId(value: unknown): value is string { return previewSequence(value) !== null; }
const statuses: readonly string[] = ["ready", "updated", "unchanged", "missing", "skipped", "failed", "not-started"];
function safeRow(value: ProxyOperationRow): ProxyOperationRow {
  if (!value || !Number.isSafeInteger(value.index) || value.index < 0 || !statuses.includes(value.status)
    || value.profileId !== undefined && !isSafeProfileId(value.profileId)
    || ["ready", "updated", "unchanged", "failed", "not-started"].includes(value.status) && !value.profileId) throw new ProxyOperationStateError("operation_invalid");
  return { index: value.index, ...(value.profileId === undefined ? {} : { profileId: value.profileId }), status: value.status,
    ...(PROXY_OPERATION_CODES.includes(value.code as ProxyOperationCode) ? { code: value.code } : {}) };
}
interface Entry extends ProxyOperationBinding {
  phase: "running" | "settled" | "sealed";
  rows: Map<number, ProxyOperationRow>;
  selectedIndices: number[];
  startedAt: number | null;
  finishedAt: number | null;
  owner?: ProxyOperationOwner;
}

export class ProxyOperationState {
  readonly operationScope = crypto.randomUUID();
  private previewCounter = 0;
  private activePreviewId: string | null = null;
  private entries = new Map<string, Entry>();
  private rowCount = 0;
  private lastNow = 0;
  private readonly clock: () => number;
  private readonly maxRecords: number;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  constructor(options: { now?: () => number; maxRecords?: number; maxRows?: number; retentionMs?: number } = {}) {
    this.clock = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 128; this.maxRows = options.maxRows ?? 100_000; this.retentionMs = options.retentionMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 2 || this.maxRecords > 4096 || !Number.isSafeInteger(this.maxRows) || this.maxRows < 1 || this.maxRows > 1_000_000 || !Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1000 || this.retentionMs > 7 * 86400_000) throw new ProxyOperationStateError("operation_invalid");
  }
  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new ProxyOperationStateError("operation_invalid");
    return this.lastNow = Math.max(this.lastNow, value);
  }
  /** Scope + monotonic sequence makes a retired nonce impossible to issue again, without a growing ID history. */
  issuePreview(): string {
    if (this.previewCounter === Number.MAX_SAFE_INTEGER) throw new ProxyOperationStateError("operation_capacity");
    this.activePreviewId = `${(++this.previewCounter).toString(36)}.${crypto.randomUUID()}`;
    this.prune(); return this.activePreviewId;
  }
  currentPreviewId(): string | null { return this.activePreviewId; }
  retirePreview(previewId: string): void { if (this.activePreviewId === previewId) this.activePreviewId = null; }
  private binding(input: ProxyOperationBinding) {
    if (!input || !isProxyOperationUuid(input.operationScope) || !isProxyOperationUuid(input.attemptId) || !isProxyOperationPreviewId(input.previewId)) throw new ProxyOperationStateError("operation_invalid");
    if (input.operationScope !== this.operationScope) throw new ProxyOperationStateError("operation_scope_mismatch");
  }
  private remove(entry: Entry) { this.entries.delete(entry.attemptId); this.rowCount -= entry.rows.size; }
  private prune() {
    const now = this.now();
    for (const entry of this.entries.values()) if (entry.phase !== "running" && entry.previewId !== this.activePreviewId && entry.finishedAt !== null && now - entry.finishedAt >= this.retentionMs) this.remove(entry);
  }
  private room(rows: number): boolean {
    this.prune();
    const fits = () => this.entries.size < this.maxRecords && this.rowCount + rows <= this.maxRows;
    if (fits()) return true;
    for (const entry of [...this.entries.values()].sort((a, b) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity))) {
      if (entry.phase === "running" || entry.previewId === this.activePreviewId) continue;
      this.remove(entry); if (fits()) return true;
    }
    return false;
  }
  private view(entry: Entry): ProxyOperationSnapshot {
    return { version: 1, operationScope: this.operationScope, attemptId: entry.attemptId, previewId: entry.previewId, phase: entry.phase,
      total: entry.rows.size, rows: [...entry.rows.values()].sort((a, b) => a.index - b.index).map(row => ({ ...row })), startedAt: entry.startedAt, finishedAt: entry.finishedAt };
  }
  /** Not found is absence of evidence, never proof that the apply did not run. */
  get(input: ProxyOperationBinding): ProxyOperationSnapshot | null {
    this.binding(input); this.prune(); const entry = this.entries.get(input.attemptId);
    if (!entry) return null;
    if (entry.previewId !== input.previewId) throw new ProxyOperationStateError("operation_binding_mismatch");
    return this.view(entry);
  }
  claim(input: ProxyOperationClaim): ProxyOperationAdmission {
    this.binding(input); this.prune();
    const previous = this.entries.get(input.attemptId);
    if (previous?.previewId !== undefined && previous.previewId !== input.previewId) throw new ProxyOperationStateError("operation_binding_mismatch");
    if (previous?.phase === "sealed") return { kind: "existing", operation: this.view(previous) };
    if (!Array.isArray(input.rows) || input.rows.length > this.maxRows) throw new ProxyOperationStateError("operation_capacity");
    const rows = input.rows.map(safeRow).sort((a, b) => a.index - b.index);
    const indices = new Set(rows.map(row => row.index));
    if (indices.size !== rows.length) throw new ProxyOperationStateError("operation_invalid");
    if (input.selectedIndices !== undefined && !Array.isArray(input.selectedIndices)) throw new ProxyOperationStateError("operation_invalid");
    const selected = input.selectedIndices === undefined ? [...indices] : [...new Set(input.selectedIndices)].sort((a, b) => a - b);
    if (selected.some(index => !indices.has(index))) throw new ProxyOperationStateError("operation_invalid");
    if (previous) {
      const identities = (values: readonly ProxyOperationRow[]) => values.map(row => [row.index, row.profileId ?? null]);
      if (JSON.stringify(identities(rows)) !== JSON.stringify(identities([...previous.rows.values()].sort((a, b) => a.index - b.index))) || JSON.stringify(selected) !== JSON.stringify(previous.selectedIndices)) throw new ProxyOperationStateError("operation_binding_mismatch");
      return { kind: "existing", operation: this.view(previous) };
    }
    if (input.previewId !== this.activePreviewId) throw new ProxyOperationStateError("operation_preview_expired");
    if ([...this.entries.values()].some(entry => entry.phase === "running")) throw new ProxyOperationStateError("operation_running");
    if (!this.room(rows.length)) throw new ProxyOperationStateError("operation_capacity");
    const owner = Object.freeze({ attemptId: input.attemptId, [ownerBrand]: Symbol() });
    const entry: Entry = { operationScope: this.operationScope, attemptId: input.attemptId, previewId: input.previewId, phase: "running", rows: new Map(rows.map(row => [row.index, row])), selectedIndices: selected, startedAt: this.now(), finishedAt: null, owner };
    this.entries.set(entry.attemptId, entry); this.rowCount += entry.rows.size;
    return { kind: "started", operation: this.view(entry), owner };
  }
  record(owner: ProxyOperationOwner, outcome: ProxyOperationRow): boolean {
    const entry = this.entries.get(owner.attemptId);
    if (!entry || entry.owner !== owner || entry.phase !== "running") return false;
    const row = safeRow(outcome), previous = entry.rows.get(row.index);
    if (!previous || previous.profileId !== row.profileId || row.status === "ready") throw new ProxyOperationStateError("operation_state_conflict");
    if (previous.status !== "ready" && JSON.stringify(previous) !== JSON.stringify(row)) throw new ProxyOperationStateError("operation_state_conflict");
    entry.rows.set(row.index, row); return true;
  }
  /** Caller must invoke only in the actual worker's finally, after all writes/awaits have ended. */
  finish(owner: ProxyOperationOwner): ProxyOperationSnapshot | null {
    const entry = this.entries.get(owner.attemptId);
    if (!entry || entry.owner !== owner) return null;
    if (entry.phase === "settled") return this.view(entry);
    if (entry.phase !== "running") return null;
    for (const [index, row] of entry.rows) if (row.status === "ready") entry.rows.set(index, { index, ...(row.profileId ? { profileId: row.profileId } : {}), status: "not-started" });
    entry.phase = "settled"; entry.finishedAt = this.now(); return this.view(entry);
  }
  reconcile(input: ProxyOperationBinding): ProxyOperationReconciliation {
    const existing = this.get(input);
    if (existing) return { operation: existing, invalidatedPreviewId: null };
    if (input.previewId !== this.activePreviewId) {
      const sequence = previewSequence(input.previewId)!;
      // A future/unissued token has no fence proof. A retired issued sequence can
      // never be issued again in this scope, and a running attempt was never evicted.
      return { operation: sequence > this.previewCounter ? null : { version: 1, ...input, phase: "retired", total: 0, rows: [], startedAt: null, finishedAt: this.now() }, invalidatedPreviewId: null };
    }
    let invalidatedPreviewId: string | null = null;
    if (!this.room(0)) {
      invalidatedPreviewId = this.activePreviewId; this.activePreviewId = null;
      if (!this.room(0)) throw new ProxyOperationStateError("operation_capacity");
    }
    const entry: Entry = { operationScope: this.operationScope, attemptId: input.attemptId, previewId: input.previewId, phase: "sealed", rows: new Map(), selectedIndices: [], startedAt: null, finishedAt: this.now() };
    this.entries.set(entry.attemptId, entry);
    return { operation: this.view(entry), invalidatedPreviewId };
  }
}
