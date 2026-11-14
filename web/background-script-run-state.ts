import type { ScriptRun } from "../scripts.ts";
import { redactBulkTaskMessage } from "./bulk-profile-task.ts";

export interface BackgroundScriptRunSummary {
  total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; settled: number;
}
export interface BackgroundScriptRunSnapshot {
  readonly run: ScriptRun | null;
  readonly summary: Readonly<BackgroundScriptRunSummary>;
  readonly state: "idle" | "running" | "stopping" | "finished" | "unavailable";
  readonly error: string | null;
  readonly refreshing: boolean;
}
const READ_FAILED = "The script status could not be refreshed. Open the monitor to retry.";
const RUN_MISSING = "This script run is no longer available. Open the monitor to review its status.";
const INVALID_RESULT = "The local service returned incomplete script run status.";
const PROFILE_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
function text(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && value.length <= max && (empty || !!value); }

/** Copy the run view only. Sources, inputs, credentials and log fields never enter shared state. */
export function copyObservedScriptRun(value: unknown): ScriptRun {
  if (!value || typeof value !== "object") throw new Error(INVALID_RESULT);
  const source = value as Record<string, unknown>;
  if (!text(source.id, 256) || !text(source.scriptName, 4096, true) || !["running", "stopping", "finished"].includes(source.status as string)
    || !Array.isArray(source.profiles) || source.profiles.length > 20_000) throw new Error(INVALID_RESULT);
  const ids = new Set<string>();
  const profiles = source.profiles.map(value => {
    if (!value || typeof value !== "object") throw new Error(INVALID_RESULT);
    const profile = value as Record<string, unknown>;
    if (!text(profile.id, 256) || !text(profile.name, 4096, true) || !(PROFILE_STATUSES as readonly unknown[]).includes(profile.status) || ids.has(profile.id)) throw new Error(INVALID_RESULT);
    ids.add(profile.id);
    return Object.freeze({ id: profile.id, name: profile.name, status: profile.status as ScriptRun["profiles"][number]["status"],
      ...(typeof profile.error === "string" ? { error: redactBulkTaskMessage(profile.error) } : {}),
      ...(typeof profile.warning === "string" ? { warning: redactBulkTaskMessage(profile.warning) } : {}) });
  });
  return Object.freeze({ id: source.id, scriptName: source.scriptName, status: source.status as ScriptRun["status"], profiles: Object.freeze(profiles) as unknown as ScriptRun["profiles"] });
}
function summary(run: ScriptRun | null): Readonly<BackgroundScriptRunSummary> {
  const result = { total: run?.profiles.length ?? 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, settled: 0 };
  for (const row of run?.profiles ?? []) result[row.status]++;
  result.settled = result.succeeded + result.failed + result.cancelled;
  return Object.freeze(result);
}

export interface BackgroundScriptRunStoreOptions {
  read: () => Promise<ScriptRun | null>;
  setTimer?: (callback: () => void, delay: number) => number | ReturnType<typeof setTimeout>;
  clearTimer?: (timer: number | ReturnType<typeof setTimeout>) => void;
  interval?: number;
}

/** One session-owned metadata observer. Subscribing alone never discovers a run or reads a script. */
export function createBackgroundScriptRunStore(options: BackgroundScriptRunStoreOptions) {
  // Constructing the passive observer must not need browser timer globals.
  // Resolve them only when an observed, active run actually schedules work.
  const setTimer: NonNullable<BackgroundScriptRunStoreOptions["setTimer"]> = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer: NonNullable<BackgroundScriptRunStoreOptions["clearTimer"]> = options.clearTimer ?? (timer => clearTimeout(timer));
  const interval = options.interval ?? 1000;
  let snapshot: BackgroundScriptRunSnapshot = Object.freeze({ run: null, summary: summary(null), state: "idle", error: null, refreshing: false });
  const listeners = new Set<() => void>();
  let generation = 0, failures = 0, disposed = false;
  let timer: number | ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<ScriptRun | null> | null = null;
  function publish(patch: Partial<BackgroundScriptRunSnapshot>) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) { try { listener(); } catch { /* A view cannot strand the observer. */ } }
  }
  function clearScheduled() { if (timer !== undefined) clearTimer(timer); timer = undefined; }
  function schedule() {
    clearScheduled();
    if (disposed || pending || !listeners.size || !snapshot.run || snapshot.run.status === "finished") return;
    timer = setTimer(() => { timer = undefined; void refresh().catch(() => {}); }, Math.min(interval * 2 ** Math.min(failures, 4), 10_000));
  }
  function accept(run: ScriptRun | null) {
    if (run) { failures = 0; publish({ run, summary: summary(run), state: run.status, error: null }); }
    else if (snapshot.run) { failures++; publish({ state: "unavailable", error: RUN_MISSING }); }
    else publish({ state: "idle", error: null });
  }
  function refresh(): Promise<ScriptRun | null> {
    if (disposed) return Promise.resolve(snapshot.run);
    if (pending) return pending;
    clearScheduled();
    const owner = generation;
    const request = Promise.resolve().then(options.read).then(value => {
      if (disposed || owner !== generation) return snapshot.run;
      const run = value === null ? null : copyObservedScriptRun(value);
      accept(run); return run;
    }).catch(error => {
      if (disposed || owner !== generation) return snapshot.run;
      failures++; publish({ state: snapshot.run ? "unavailable" : "idle", error: READ_FAILED });
      throw error;
    }).finally(() => {
      if (pending === request) { pending = null; if (!disposed) { publish({ refreshing: false }); schedule(); } }
    });
    pending = request;
    publish({ refreshing: true });
    return request;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); schedule(); return () => { listeners.delete(listener); if (!listeners.size) clearScheduled(); }; },
    /** Call only for an explicit user discovery, start result, or stop result. */
    observe(value: ScriptRun | null) {
      if (disposed) return;
      const run = value === null ? null : copyObservedScriptRun(value);
      generation++; clearScheduled(); accept(run); schedule();
    },
    refresh,
    dispose() { disposed = true; generation++; clearScheduled(); listeners.clear(); },
  };
}
