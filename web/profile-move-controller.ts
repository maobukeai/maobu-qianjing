import { isSafeProfileId } from "../src/profile-id.ts";

export interface ProfileMoveAttempt { readonly id: number; readonly ids: readonly string[]; readonly group: string; readonly workspaceId: string | null; }
export interface ProfileMoveResult {
  readonly attempt: ProfileMoveAttempt;
  readonly status: "confirmed" | "partial" | "failed" | "unconfirmed";
  readonly reportedMoved: number | null;
  /** Confirmed at the destination by a fresh read; may include an already-present member. */
  readonly confirmedIds: readonly string[];
  readonly unresolvedIds: readonly string[];
  readonly missingIds: readonly string[];
  readonly retryIds: readonly string[];
  readonly message: string | null;
}
export interface ProfileMoveState {
  readonly phase: "idle" | "moving" | "checking" | "settled";
  readonly attempt: ProfileMoveAttempt | null;
  readonly result: ProfileMoveResult | null;
  readonly blockedReason: string | null;
}
export interface ProfileMoveRoster { profiles: readonly { id: string; group: string }[]; }
export interface ProfileMoveLease { refreshing(): void; release(): void; }
export interface ProfileMoveControllerOptions {
  readRoster: () => Promise<ProfileMoveRoster>;
  move?: (ids: string[], group: string) => Promise<Response>;
  workspaceId?: () => string | null;
  acquire?: (workspaceId: string | null) => ProfileMoveLease | null;
  blockedReason?: (workspaceId: string | null) => string;
}
const EMPTY: ProfileMoveState = Object.freeze({ phase: "idle", attempt: null, result: null, blockedReason: null });
const REJECTED = "The move was rejected. Your environments and destination are kept; try again.";
const UNKNOWN = "The move response could not be confirmed. Check the result before sending another move.";
const READ_FAILED = "The move was reported, but the environment list could not refresh. Check the result.";
const copy = (ids: readonly string[]) => Object.freeze([...ids]);
const defaultMove = (ids: string[], group: string) => fetch("/ui/api/profiles/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, group }) });

/** One session-only operation. It retains IDs and the destination, never account/session data. */
export function createProfileMoveController(options: ProfileMoveControllerOptions) {
  let state = EMPTY, sequence = 0, busy = false, active = true;
  const listeners = new Set<() => void>();
  function publish(next: ProfileMoveState) { state = Object.freeze(next); for (const listener of [...listeners]) listener(); }
  function block(message: string) { publish({ ...state, blockedReason: message }); return null; }
  function result(attempt: ProfileMoveAttempt, status: ProfileMoveResult["status"], reportedMoved: number | null, confirmed: readonly string[], unresolved: readonly string[], missing: readonly string[], retry: readonly string[], message: string | null): ProfileMoveResult {
    return Object.freeze({ attempt, status, reportedMoved, confirmedIds: copy(confirmed), unresolvedIds: copy(unresolved), missingIds: copy(missing), retryIds: copy(retry), message });
  }
  function settle(value: ProfileMoveResult) { if (active) publish({ phase: "settled", attempt: value.attempt, result: value, blockedReason: null }); return active ? value : null; }
  function attempt(ids: readonly string[], group: string, workspaceId: string | null): ProfileMoveAttempt { return Object.freeze({ id: ++sequence, ids: copy(ids), group, workspaceId }); }
  async function verify(request: ProfileMoveAttempt, reportedMoved: number | null) {
    try {
      const roster = await options.readRoster();
      if (!active) return null;
      const records = new Map<string, string>();
      if (!roster || !Array.isArray(roster.profiles)) throw new Error("Invalid roster");
      for (const row of roster.profiles) {
        if (!row || typeof row.id !== "string" || typeof row.group !== "string" || records.has(row.id)) throw new Error("Invalid roster");
        records.set(row.id, row.group);
      }
      const confirmed = request.ids.filter(id => records.get(id) === request.group), confirmedSet = new Set(confirmed);
      const unresolved = request.ids.filter(id => !confirmedSet.has(id));
      const missing = unresolved.filter(id => !records.has(id)), retry = unresolved.filter(id => records.has(id));
      const message = missing.length ? "Some selected environments are no longer listed. Their selection is kept for review." : retry.length ? "Some environments are not in the destination group. Review the result before retrying." : null;
      return settle(result(request, unresolved.length ? "partial" : "confirmed", reportedMoved, confirmed, unresolved, missing, retry, message));
    } catch { return settle(result(request, "unconfirmed", reportedMoved, [], request.ids, [], [], reportedMoved === null ? UNKNOWN : READ_FAILED)); }
  }
  async function run(request: ProfileMoveAttempt, checking = false, reportedMoved: number | null = null): Promise<ProfileMoveResult | null> {
    if (busy || !active) return null;
    busy = true;
    let lease: ProfileMoveLease | null | undefined;
    try { lease = options.acquire?.(request.workspaceId); }
    catch { busy = false; return block("A workspace task is in progress. Wait for it to finish before moving environments."); }
    if (options.acquire && !lease) { busy = false; return block(options.blockedReason?.(request.workspaceId) ?? "A workspace task is in progress. Wait for it to finish before moving environments."); }
    publish({ phase: checking ? "checking" : "moving", attempt: request, result: null, blockedReason: null });
    try {
      if (!checking) {
        let response: Response, body: unknown;
        try { response = await (options.move ?? defaultMove)([...request.ids], request.group); body = await response.json(); }
        catch { return settle(result(request, "unconfirmed", null, [], request.ids, [], [], UNKNOWN)); }
        if (!active) return null;
        const reply = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
        if (reply?.ok === false) return settle(result(request, "failed", null, [], request.ids, [], request.ids, REJECTED));
        if (!response.ok || reply?.ok !== true || !Number.isSafeInteger(reply.moved) || (reply.moved as number) < 0 || (reply.moved as number) > request.ids.length || reply.group !== request.group) return settle(result(request, "unconfirmed", null, [], request.ids, [], [], UNKNOWN));
        reportedMoved = reply.moved as number;
        publish({ phase: "checking", attempt: request, result: null, blockedReason: null });
      }
      if (!active) return null;
      lease?.refreshing();
      return await verify(request, reportedMoved);
    } finally { lease?.release(); busy = false; }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setActive(value: boolean) { active = value; if (value && !busy && state.attempt && (state.phase === "moving" || state.phase === "checking")) settle(result(state.attempt, "unconfirmed", null, [], state.attempt.ids, [], [], UNKNOWN)); },
    isBusy: () => busy,
    submit(input: { ids: readonly string[]; group: string }): Promise<ProfileMoveResult | null> {
      if (busy || !active) return Promise.resolve(null);
      if (!Array.isArray(input.ids) || !input.ids.length) return Promise.resolve(block("Choose at least one environment to move."));
      if (!input.ids.every(isSafeProfileId) || typeof input.group !== "string") return Promise.resolve(block("The selected environments could not be validated. Refresh and select them again."));
      return run(attempt([...new Set(input.ids)], input.group.trim(), options.workspaceId?.() ?? null));
    },
    retry(): Promise<ProfileMoveResult | null> {
      const previous = state.result;
      if (busy || !active || !previous?.retryIds.length) return Promise.resolve(null);
      return run(attempt(previous.retryIds, previous.attempt.group, previous.attempt.workspaceId));
    },
    recheck(): Promise<ProfileMoveResult | null> {
      const previous = state.result;
      if (busy || !active || !previous || previous.status === "confirmed") return Promise.resolve(null);
      return run(previous.attempt, true, previous.reportedMoved);
    },
    dismiss() { if (!busy && active) publish(EMPTY); },
  };
}
export type ProfileMoveController = ReturnType<typeof createProfileMoveController>;
