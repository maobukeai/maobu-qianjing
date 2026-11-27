import { isSafeProfileId } from "../src/profile-id.ts";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
import type { TrashProfileView } from "../src/proxy-tools-types.ts";

export type TrashAction = "restore" | "purge";
export type TrashFailureReason = "not_in_trash" | "permission_denied" | "profile_open" | "operation_failed" | "cancelled" | "unrecognized";
export const TRASH_FAILURE_REASONS: Record<TrashFailureReason, string> = {
  not_in_trash: "This environment is no longer in Trash. Check its current location before taking another action.",
  permission_denied: "This environment cannot be changed with the current access. Review access before trying again.",
  profile_open: "This environment is open or still being cleaned up. Close it and wait for cleanup before trying again.",
  operation_failed: "This item could not be completed. Review its saved data and local storage before trying again.",
  cancelled: "The service reported that this item was not completed. Review it before starting another attempt.",
  unrecognized: "The service reported a failure without a recognized reason. Review the environment before trying again.",
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const copy = (ids: readonly string[]) => Object.freeze([...ids]);
function validIds(value: readonly string[]): string[] | null { return Array.isArray(value) && value.every(isSafeProfileId) ? [...new Set(value)] : null; }

export interface TrashSelectionCapture { readonly revision: number; readonly entries: readonly Readonly<{ id: string; intent: number | null }>[] }
export interface TrashSelectionSnapshot { readonly revision: number; readonly ids: readonly string[] }
/** Selection is independent of filters. Per-ID intent prevents an old result from clearing a new same-ID selection. */
export function createTrashSelection(initial: readonly string[] = []) {
  const starting = validIds(initial); if (!starting) throw new TypeError("Trash selection contains invalid environment IDs.");
  let revision = 0; const selected = new Set(starting), intents = new Map(starting.map(id => [id, 0]));
  const listeners = new Set<() => void>();
  let published: TrashSelectionSnapshot = Object.freeze({ revision, ids: copy([...selected]) });
  function publish() { published = Object.freeze({ revision, ids: copy([...selected]) }); for (const listener of [...listeners]) { try { listener(); } catch {} } return published; }
  function edit(ids: readonly string[], checked: boolean, replace = false) {
    const unique = validIds(ids); if (!unique) throw new TypeError("Trash selection contains invalid environment IDs.");
    revision++;
    if (replace) { for (const id of selected) intents.set(id, revision); selected.clear(); }
    for (const id of unique) { intents.set(id, revision); if (checked) selected.add(id); else selected.delete(id); }
    return publish();
  }
  return {
    getSnapshot: () => published,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(ids: readonly string[], checked: boolean) { return edit(ids, checked); },
    replace(ids: readonly string[]) { return edit(ids, true, true); },
    clear() { return edit([...selected], false); },
    capture(ids: readonly string[] = [...selected]): TrashSelectionCapture {
      const unique = validIds(ids); if (!unique) throw new TypeError("Trash selection contains invalid environment IDs.");
      return Object.freeze({ revision, entries: Object.freeze(unique.map(id => Object.freeze({ id, intent: selected.has(id) ? intents.get(id)! : null }))) });
    },
    reconcile(capture: TrashSelectionCapture, confirmedIds: readonly string[]) {
      const confirmed = new Set(confirmedIds), removed: string[] = [];
      for (const { id, intent } of capture.entries) {
        if (intent !== null && confirmed.has(id) && selected.has(id) && intents.get(id) === intent) { selected.delete(id); removed.push(id); }
      }
      if (removed.length) { revision++; for (const id of removed) intents.set(id, revision); publish(); }
      return copy(removed);
    },
    visibleSummary(visibleIds: readonly string[]) {
      const visible = new Set(visibleIds); const shown = [...selected].filter(id => visible.has(id)).length;
      return Object.freeze({ total: selected.size, visible: shown, hidden: selected.size - shown });
    },
  };
}
export type TrashSelection = ReturnType<typeof createTrashSelection>;

export interface TrashReadSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly profiles: readonly TrashProfileView[];
  readonly loaded: boolean;
  readonly stale: boolean;
  readonly loadedAt: number | null;
  readonly error: "The Trash list could not be loaded. Retry before treating this list as current." | null;
}
function projectProfiles(value: unknown): readonly TrashProfileView[] {
  if (!Array.isArray(value)) throw new Error("Invalid Trash list");
  const seen = new Set<string>();
  return Object.freeze(value.map(item => {
    if (!object(item) || !isSafeProfileId(item.id) || seen.has(item.id) || typeof item.name !== "string" || typeof item.group !== "string"
      || typeof item.trashedAt !== "number" || item.trashedAt <= 0 || !Number.isFinite(new Date(item.trashedAt).getTime())
      || typeof item.canRestore !== "boolean" || typeof item.canPurge !== "boolean"
      || (item.version !== undefined && (!Number.isSafeInteger(item.version) || Number(item.version) < 0))) throw new Error("Invalid Trash list");
    seen.add(item.id);
    return Object.freeze({ id: item.id, name: item.name, group: item.group, trashedAt: item.trashedAt, canRestore: item.canRestore, canPurge: item.canPurge,
      ...(item.version !== undefined ? { version: item.version as number } : {}) });
  }));
}
/** Only readonly GET ownership is aborted or replaced; mutation requests have a separate owner. */
export function createTrashReader(options: { read?: (signal: AbortSignal) => Promise<Response>; now?: () => number } = {}) {
  let state: TrashReadSnapshot = Object.freeze({ phase: "idle", profiles: Object.freeze([]), loaded: false, stale: false, loadedAt: null, error: null });
  let generation = 0, current: AbortController | null = null, active = true, disposed = false;
  const listeners = new Set<() => void>();
  function publish(next: TrashReadSnapshot) { state = Object.freeze(next); for (const listener of [...listeners]) { try { listener(); } catch {} } return state; }
  function stop() { generation++; current?.abort(); current = null; if (state.phase === "loading") publish({ ...state, phase: state.loaded ? "ready" : "idle" }); }
  const reader = {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setActive(value: boolean) { if (disposed) return; active = value; if (!value) stop(); },
    load(): Promise<TrashReadSnapshot | null> {
      if (!active || disposed) return Promise.resolve(null);
      current?.abort(); const controller = new AbortController(), own = ++generation; current = controller;
      const owns = () => !disposed && active && current === controller && generation === own && !controller.signal.aborted;
      publish({ ...state, phase: "loading", stale: state.loaded, error: null });
      return Promise.resolve().then(async () => {
        try {
          if (!owns()) return null;
          const response = await (options.read ?? (signal => fetch("/ui/api/trash", { signal, credentials: "same-origin", cache: "no-store", redirect: "error", headers: withStandaloneAuthHeaders() })))(controller.signal);
          const body: unknown = await response.json();
          if (response.status === 401) {
            notifyUnauthorizedResponse(401, "/ui/api/trash", object(body) && typeof body.error === "string" ? body.error : "");
          } else if (response.status === 423) {
            notifyAppLockedFromResponse(423, body);
          }
          if (!owns()) return null;
          if (response.status !== 200 || !response.ok || !object(body) || body.ok !== true) throw new Error("Invalid Trash list");
          const profiles = projectProfiles(body.profiles);
          return publish({ phase: "ready", profiles, loaded: true, stale: false, loadedAt: (options.now ?? Date.now)(), error: null });
        } catch { return owns() ? publish({ ...state, phase: "error", stale: state.loaded, error: "The Trash list could not be loaded. Retry before treating this list as current." }) : null; }
        finally { if (current === controller) current = null; }
      });
    },
    /** Mutation refreshes must reject an unread list, while ordinary UI load() retains its inspectable error state. */
    async refresh(): Promise<TrashReadSnapshot> { const result = await reader.load(); if (!result || result.phase !== "ready") throw new Error("Trash refresh could not be confirmed."); return result; },
    dispose() { disposed = true; active = false; stop(); listeners.clear(); },
  };
  return reader;
}
export type TrashReader = ReturnType<typeof createTrashReader>;

export interface TrashTaskLease { refreshing?(): void; release(): void }
export interface TrashPurgeApproval { readonly action: "purge"; readonly ids: readonly string[]; readonly count: number; readonly workspaceId: string | null }
export interface TrashTaskRow {
  readonly id: string;
  readonly status: "pending" | "restored" | "purged" | "failed" | "unconfirmed";
  readonly reason: TrashFailureReason | null;
  readonly attempts: number;
}
export interface TrashTaskAttempt { readonly id: number; readonly operationId: number; readonly action: TrashAction; readonly ids: readonly string[]; readonly workspaceId: string | null }
export interface TrashTaskReceipt {
  readonly operationId: number;
  readonly action: TrashAction;
  readonly status: "complete" | "partial" | "failed" | "unconfirmed";
  readonly rows: readonly TrashTaskRow[];
  readonly succeededIds: readonly string[];
  readonly failedIds: readonly string[];
  readonly unconfirmedIds: readonly string[];
  readonly retryIds: readonly string[];
  readonly completedAt: number;
  readonly refreshFailed: boolean;
}
export interface TrashTaskSnapshot {
  readonly phase: "idle" | "confirming" | "sending" | "refreshing" | "settled";
  readonly attempt: TrashTaskAttempt | null;
  readonly receipt: TrashTaskReceipt | null;
  readonly history: readonly TrashTaskReceipt[];
  readonly blockedReason: string | null;
}
export interface TrashTaskOptions {
  post?: (action: TrashAction, ids: string[]) => Promise<Response>;
  /** Must show the product's explicit irreversible-deletion confirmation for these exact IDs. No callback means no purge. */
  confirmPurge?: (approval: TrashPurgeApproval) => boolean | Promise<boolean>;
  /** UI checks original Trash entry versions against a freshly read list. This is not a backend CAS guarantee. */
  validateRetry?: (attempt: Readonly<{ action: TrashAction; ids: readonly string[]; workspaceId: string | null }>) => boolean;
  workspaceId?: () => string | null;
  acquire?: (workspaceId: string | null) => TrashTaskLease | null;
  selection?: TrashSelection;
  refreshTrash?: () => Promise<unknown>;
  onChanged?: () => Promise<unknown>;
  refreshWorkspace?: () => Promise<unknown>;
  now?: () => number;
}
export const postTrashTask = (action: TrashAction, ids: string[]) => fetch(`/ui/api/trash/${action}`, { method: "POST", headers: withStandaloneAuthHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ ids }), redirect: "error", credentials: "same-origin", cache: "no-store" });
const REASONS = new Set<TrashFailureReason>(["not_in_trash", "permission_denied", "profile_open", "operation_failed", "cancelled"]);
const INVALID = "Choose valid environments in Trash before starting this operation.";
const BLOCKED = "A workspace task is in progress. Wait for it to finish before changing Trash.";
const WORKSPACE = "Return to the original workspace before continuing this Trash operation.";
const CONFIRM = "Permanent deletion requires the product confirmation for the selected environments.";
const CHANGED = "Some original Trash records changed or are no longer listed. Refresh and select them again before starting a new operation.";
type ValidRow = { id: string; status: "restored" | "purged" | "failed"; reason: TrashFailureReason | null };
async function readMutation(response: Response, action: TrashAction, ids: readonly string[]): Promise<ValidRow[] | null> {
  // The real route's 409 has no confirmed per-ID result and may follow partial writes.
  // Supplying results alongside that HTTP error does not turn it into the HTTP200 contract.
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, `/ui/api/trash/${action}`);
    return null;
  }
  if (response.status === 423) {
    const lockedBody = await response.json().catch(() => null);
    notifyAppLockedFromResponse(423, lockedBody);
    return null;
  }
  if (response.status !== 200 || !response.ok) return null;
  const body: unknown = await response.json();
  if (!object(body) || body.ok !== true || !Array.isArray(body.results) || body.results.length !== ids.length || Object.keys(body).some(key => key !== "ok" && key !== "results")) return null;
  const expected = action === "restore" ? "restored" : "purged", requested = new Set(ids), rows = new Map<string, ValidRow>();
  for (const row of body.results) {
    if (!object(row) || typeof row.id !== "string" || !requested.has(row.id) || rows.has(row.id) || (row.status !== expected && row.status !== "failed")
      || Object.keys(row).some(key => !["id", "status", "code"].includes(key)) || (row.code !== undefined && typeof row.code !== "string")
      || (row.status === expected && row.code !== undefined)) return null;
    rows.set(row.id, { id: row.id, status: row.status === "failed" ? "failed" : expected, reason: row.status === "failed" ? typeof row.code === "string" && REASONS.has(row.code as TrashFailureReason) ? row.code as TrashFailureReason : "unrecognized" : null });
  }
  return ids.map(id => rows.get(id)!);
}

/** Session-only safe task ownership. Only explicit failed IDs can be retried; unknown outcomes never replay. */
export function createTrashTask(options: TrashTaskOptions = {}) {
  let state: TrashTaskSnapshot = Object.freeze({ phase: "idle", attempt: null, receipt: null, history: Object.freeze([]), blockedReason: null });
  let busy = false, disposed = false, sequence = 0, operationId = 0, workspaceId: string | null = null;
  let action: TrashAction = "restore", rows: readonly TrashTaskRow[] = [], selection: TrashSelectionCapture | null = null;
  const listeners = new Set<() => void>(), now = options.now ?? Date.now;
  function publish(next: TrashTaskSnapshot) { state = Object.freeze(next); for (const listener of [...listeners]) { try { listener(); } catch {} } return state; }
  function block(message: string) { publish({ ...state, blockedReason: message }); return null; }
  function receipt(refreshFailed = false): TrashTaskReceipt {
    const succeeded = rows.filter(row => row.status === "restored" || row.status === "purged").map(row => row.id), failed = rows.filter(row => row.status === "failed").map(row => row.id), unknown = rows.filter(row => row.status === "unconfirmed").map(row => row.id);
    return Object.freeze({ operationId, action, status: unknown.length ? "unconfirmed" : failed.length ? succeeded.length ? "partial" : "failed" : "complete", rows: Object.freeze([...rows]),
      succeededIds: copy(succeeded), failedIds: copy(failed), unconfirmedIds: copy(unknown), retryIds: copy(rows.filter(row => row.status === "failed" && row.reason !== "not_in_trash").map(row => row.id)), completedAt: now(), refreshFailed });
  }
  function run(nextAction: TrashAction, ids: readonly string[], expectedWorkspace: string | null, retry: boolean): Promise<TrashTaskSnapshot | null> {
    if (busy || disposed) return Promise.resolve(null);
    busy = true;
    try { if ((options.workspaceId?.() ?? null) !== expectedWorkspace) { busy = false; return Promise.resolve(block(WORKSPACE)); } }
    catch { busy = false; return Promise.resolve(block(WORKSPACE)); }
    const frozen = copy(ids), ownAttempt = Object.freeze({ id: ++sequence, operationId: retry ? operationId : operationId + 1, action: nextAction, ids: frozen, workspaceId: expectedWorkspace });
    const retryCheck = Object.freeze({ action: nextAction, ids: frozen, workspaceId: expectedWorkspace });
    const retryValid = () => { try { return !retry || !options.validateRetry || options.validateRetry(retryCheck) === true; } catch { return false; } };
    if (!retryValid()) { busy = false; return Promise.resolve(block(CHANGED)); }
    let capturedSelection: TrashSelectionCapture | null;
    try { capturedSelection = retry ? selection : options.selection?.capture(frozen) ?? null; }
    catch { busy = false; return Promise.resolve(block(INVALID)); }
    const previous = state;
    // Install the async operation before publishing, so even reentrant subscribers cannot duplicate it.
    const work = Promise.resolve().then(async () => {
      if (disposed) { busy = false; publish(previous); return null; }
      if (nextAction === "purge") {
        if (!options.confirmPurge) { busy = false; publish(previous); return block(CONFIRM); }
        let approved = false;
        try { approved = await options.confirmPurge(Object.freeze({ action: "purge", ids: frozen, count: frozen.length, workspaceId: expectedWorkspace })) === true; }
        catch { busy = false; publish(previous); return block(CONFIRM); }
        if (!approved || disposed) { busy = false; publish(previous); return null; }
      }
      if (disposed) { busy = false; return null; }
      if (!retryValid()) { busy = false; publish(previous); return block(CHANGED); }
      let currentWorkspace: string | null;
      try { currentWorkspace = options.workspaceId?.() ?? null; } catch { busy = false; publish(previous); return block(WORKSPACE); }
      if (currentWorkspace !== expectedWorkspace) { busy = false; publish(previous); return block(WORKSPACE); }
      let lease: TrashTaskLease | null | undefined;
      try { lease = options.acquire?.(expectedWorkspace); }
      catch { busy = false; publish(previous); return block(BLOCKED); }
      if (options.acquire && !lease) { busy = false; publish(previous); return block(BLOCKED); }
      const history = !retry && previous.receipt ? Object.freeze([...previous.history, previous.receipt]) : previous.history;
      if (!retry) { operationId++; action = nextAction; workspaceId = expectedWorkspace; selection = capturedSelection; rows = Object.freeze(frozen.map(id => Object.freeze({ id, status: "pending" as const, reason: null, attempts: 1 }))); }
      else { const attempting = new Set(frozen); rows = Object.freeze(rows.map(row => attempting.has(row.id) ? Object.freeze({ ...row, status: "pending", reason: null, attempts: row.attempts + 1 }) : row)); }
      publish({ phase: "sending", attempt: ownAttempt, receipt: retry ? previous.receipt : null, history, blockedReason: null });
      let result: ValidRow[] | null = null;
      try { result = await readMutation(await (options.post ?? postTrashTask)(nextAction, [...frozen]), nextAction, frozen); } catch {}
      const attempted = new Set(frozen), results = new Map(result?.map(row => [row.id, row]));
      rows = Object.freeze(rows.map(row => { if (!attempted.has(row.id)) return row; const answer = results.get(row.id); return Object.freeze({ ...row, status: answer?.status ?? "unconfirmed", reason: answer?.reason ?? null }); }));
      let settled = receipt();
      if (selection && options.selection) options.selection.reconcile(selection, settled.succeededIds);
      const refreshers = [options.refreshTrash, options.onChanged, options.refreshWorkspace].filter((callback): callback is () => Promise<unknown> => !!callback);
      if (!disposed && refreshers.length) {
        publish({ phase: "refreshing", attempt: ownAttempt, receipt: settled, history, blockedReason: null });
        let phaseFailed = false; try { lease?.refreshing?.(); } catch { phaseFailed = true; }
        const refreshed = await Promise.allSettled(refreshers.map(callback => Promise.resolve().then(() => disposed ? undefined : callback())));
        if (phaseFailed || refreshed.some(item => item.status === "rejected")) settled = Object.freeze({ ...settled, refreshFailed: true });
      }
      try { lease?.release(); } catch {}
      busy = false;
      return publish({ phase: "settled", attempt: ownAttempt, receipt: settled, history, blockedReason: null });
    });
    if (nextAction === "purge") publish({ ...previous, phase: "confirming", blockedReason: null });
    return work;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isBusy: () => busy,
    submit(nextAction: TrashAction, ids: readonly string[]): Promise<TrashTaskSnapshot | null> {
      if (busy || disposed) return Promise.resolve(null);
      const unique = validIds(ids); if ((nextAction !== "restore" && nextAction !== "purge") || !unique?.length) return Promise.resolve(block(INVALID));
      let workspace: string | null; try { workspace = options.workspaceId?.() ?? null; } catch { return Promise.resolve(block(WORKSPACE)); }
      return run(nextAction, unique, workspace, false);
    },
    retryFailed(): Promise<TrashTaskSnapshot | null> {
      if (busy || disposed || !state.receipt?.retryIds.length) return Promise.resolve(null);
      return run(action, state.receipt.retryIds, workspaceId, true);
    },
    dismiss() { if (busy) return false; rows = []; selection = null; publish({ phase: "idle", attempt: null, receipt: null, history: Object.freeze([]), blockedReason: null }); return true; },
    /** Stops only future refresh dispatch. A POST already issued keeps its lease until it actually settles. */
    dispose() { disposed = true; listeners.clear(); },
  };
}
export type TrashTask = ReturnType<typeof createTrashTask>;
