import type { ScriptArtifactRecord, ScriptStepRecord } from "../contracts/local.ts";
import type { ScriptRun, ScriptRunProfile } from "../scripts.ts";
import { redactBulkTaskMessage } from "./bulk-profile-task.ts";

export interface BackgroundScriptRunSummary {
  total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; settled: number;
}
export interface BackgroundScriptRunSnapshot {
  readonly run: ScriptRun | null;
  readonly summary: Readonly<BackgroundScriptRunSummary>;
  readonly state: "idle" | "queued" | "running" | "stopping" | "finished" | "unavailable";
  readonly error: string | null;
  readonly refreshing: boolean;
}
const READ_FAILED = "The script status could not be refreshed. Open the monitor to retry.";
const RUN_MISSING = "This script run is no longer available. Open the monitor to review its status.";
const INVALID_RESULT = "The local service returned incomplete script run status.";
const RUN_STATUSES = ["queued", "running", "stopping", "finished"] as const;
const PROFILE_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const STEP_STATUSES = ["running", "succeeded", "failed"] as const;
const SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(?:jpg|png)$/;

function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || !!value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function copySteps(raw: unknown): ScriptStepRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ScriptStepRecord[] = [];
  for (const item of raw.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(obj.index) || Number(obj.index) < 1
      || !text(obj.title, 256, true)
      || !(STEP_STATUSES as readonly unknown[]).includes(obj.status)
      || !finiteNumber(obj.startedAt)
    ) {
      continue;
    }
    out.push(Object.freeze({
      index: Number(obj.index),
      title: obj.title,
      status: obj.status as ScriptStepRecord["status"],
      startedAt: obj.startedAt,
      ...(finiteNumber(obj.finishedAt) ? { finishedAt: obj.finishedAt } : {}),
      ...(finiteNumber(obj.durationMs) ? { durationMs: obj.durationMs } : {}),
      ...(typeof obj.error === "string" && obj.error ? { error: redactBulkTaskMessage(obj.error) } : {}),
    }));
  }
  return out.length > 0 ? (Object.freeze(out) as unknown as ScriptStepRecord[]) : undefined;
}

function copyScreenshots(raw: unknown): ScriptArtifactRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ScriptArtifactRecord[] = [];
  for (const item of raw.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.fileName !== "string" || !SAFE_ARTIFACT_NAME_RE.test(obj.fileName)
      || !text(obj.label, 128, true)
      || (obj.mimeType !== "image/jpeg" && obj.mimeType !== "image/png")
      || !finiteNumber(obj.sizeBytes)
      || !finiteNumber(obj.capturedAt)
      || (obj.kind !== "manual" && obj.kind !== "error")
    ) {
      continue;
    }
    out.push(Object.freeze({
      fileName: obj.fileName,
      label: obj.label,
      mimeType: obj.mimeType,
      sizeBytes: obj.sizeBytes,
      capturedAt: obj.capturedAt,
      kind: obj.kind,
    }));
  }
  return out.length > 0 ? (Object.freeze(out) as unknown as ScriptArtifactRecord[]) : undefined;
}

/** Copy the run view only. Sources, inputs, credentials and log fields never enter shared state. */
export function copyObservedScriptRun(value: unknown): ScriptRun {
  if (!value || typeof value !== "object") throw new Error(INVALID_RESULT);
  const source = value as Record<string, unknown>;
  if (
    !text(source.id, 256)
    || !text(source.scriptName, 4096, true)
    || !(RUN_STATUSES as readonly unknown[]).includes(source.status)
    || !Array.isArray(source.profiles)
    || source.profiles.length > 20_000
  ) {
    throw new Error(INVALID_RESULT);
  }
  const ids = new Set<string>();
  const profiles = source.profiles.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error(INVALID_RESULT);
    const profile = entry as Record<string, unknown>;
    if (
      !text(profile.id, 256)
      || !text(profile.name, 4096, true)
      || !(PROFILE_STATUSES as readonly unknown[]).includes(profile.status)
      || ids.has(profile.id)
    ) {
      throw new Error(INVALID_RESULT);
    }
    ids.add(profile.id);
    const steps = copySteps(profile.steps);
    const screenshots = copyScreenshots(profile.screenshots);
    return Object.freeze({
      id: profile.id,
      name: profile.name,
      status: profile.status as ScriptRunProfile["status"],
      ...(typeof profile.error === "string" ? { error: redactBulkTaskMessage(profile.error) } : {}),
      ...(typeof profile.warning === "string" ? { warning: redactBulkTaskMessage(profile.warning) } : {}),
      ...(finiteNumber(profile.startedAt) ? { startedAt: profile.startedAt } : {}),
      ...(finiteNumber(profile.finishedAt) ? { finishedAt: profile.finishedAt } : {}),
      ...(finiteNumber(profile.durationMs) ? { durationMs: profile.durationMs } : {}),
      ...(steps ? { steps } : {}),
      ...(screenshots ? { screenshots } : {}),
    });
  });
  return Object.freeze({
    id: source.id,
    scriptName: source.scriptName,
    status: source.status as ScriptRun["status"],
    ...(finiteNumber(source.createdAt) ? { createdAt: source.createdAt } : {}),
    ...(finiteNumber(source.startedAt) ? { startedAt: source.startedAt } : {}),
    ...(finiteNumber(source.finishedAt) ? { finishedAt: source.finishedAt } : {}),
    ...(finiteNumber(source.durationMs) ? { durationMs: source.durationMs } : {}),
    ...(Number.isSafeInteger(source.queuePosition) && Number(source.queuePosition) > 0
      ? { queuePosition: Number(source.queuePosition) }
      : {}),
    profiles: Object.freeze(profiles) as unknown as ScriptRun["profiles"],
  });
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
  const setTimer: NonNullable<BackgroundScriptRunStoreOptions["setTimer"]> =
    options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer: NonNullable<BackgroundScriptRunStoreOptions["clearTimer"]> =
    options.clearTimer ?? ((timer) => clearTimeout(timer));
  const interval = options.interval ?? 1000;
  let snapshot: BackgroundScriptRunSnapshot = Object.freeze({
    run: null,
    summary: summary(null),
    state: "idle",
    error: null,
    refreshing: false,
  });
  const listeners = new Set<() => void>();
  let generation = 0, failures = 0, disposed = false;
  let timer: number | ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<ScriptRun | null> | null = null;
  function publish(patch: Partial<BackgroundScriptRunSnapshot>) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A view cannot strand the observer. */
      }
    }
  }
  function clearScheduled() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }
  function schedule() {
    clearScheduled();
    if (disposed || pending || !listeners.size || !snapshot.run || snapshot.run.status === "finished") return;
    timer = setTimer(() => {
      timer = undefined;
      void refresh().catch(() => {});
    }, Math.min(interval * 2 ** Math.min(failures, 4), 10_000));
  }
  function accept(run: ScriptRun | null) {
    if (run) {
      failures = 0;
      publish({ run, summary: summary(run), state: run.status, error: null });
    } else if (snapshot.run) {
      failures++;
      publish({ state: "unavailable", error: RUN_MISSING });
    } else {
      publish({ state: "idle", error: null });
    }
  }
  function refresh(): Promise<ScriptRun | null> {
    if (disposed) return Promise.resolve(snapshot.run);
    if (pending) return pending;
    clearScheduled();
    const owner = generation;
    const request = Promise.resolve().then(options.read).then((value) => {
      if (disposed || owner !== generation) return snapshot.run;
      const run = value === null ? null : copyObservedScriptRun(value);
      accept(run);
      return run;
    }).catch((error) => {
      if (disposed || owner !== generation) return snapshot.run;
      failures++;
      publish({ state: snapshot.run ? "unavailable" : "idle", error: READ_FAILED });
      throw error;
    }).finally(() => {
      if (pending === request) {
        pending = null;
        if (!disposed) {
          publish({ refreshing: false });
          schedule();
        }
      }
    });
    pending = request;
    publish({ refreshing: true });
    return request;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearScheduled();
      };
    },
    /** Call only for an explicit user discovery, start result, or stop result. */
    observe(value: ScriptRun | null) {
      if (disposed) return;
      const run = value === null ? null : copyObservedScriptRun(value);
      generation++;
      clearScheduled();
      accept(run);
      schedule();
    },
    refresh,
    dispose() {
      disposed = true;
      generation++;
      clearScheduled();
      listeners.clear();
    },
  };
}
