export type BulkProfileAction = "open" | "close" | "restart";
export type BulkProfileTaskStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type BulkProfileTaskPhase = "idle" | "running" | "stopping" | "complete";
export interface BulkProfileTarget { id: string; name: string; skipReason?: string }
export interface BulkProfileTaskRow {
  readonly id: string;
  readonly name: string;
  readonly status: BulkProfileTaskStatus;
  readonly attempts: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly warning?: string;
  readonly cause?: "ineligible" | "stopped";
  readonly skipReason?: string;
}
export interface BulkProfileTaskSummary {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly settled: number;
}
export interface BulkProfileTaskSnapshot {
  readonly id: string;
  readonly action: BulkProfileAction;
  readonly phase: BulkProfileTaskPhase;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly stopped: boolean;
  /** Effective bounded concurrency for the latest dispatch cycle (1–4). */
  readonly effectiveConcurrency: number;
  /** True when `getConcurrency()` lowered active concurrency below the configured maximum. */
  readonly throttled: boolean;
  readonly rows: readonly BulkProfileTaskRow[];
  readonly summary: BulkProfileTaskSummary;
}
export interface BulkProfileTaskOptions {
  action: BulkProfileAction;
  targets: readonly BulkProfileTarget[];
  run: (id: string) => Promise<unknown>;
  /** Clamped to 1–4; starting many browsers must not exhaust the desktop. */
  concurrency?: number;
  /** Optional dynamic concurrency provider (e.g. host memory watermark guard). */
  getConcurrency?: () => number;
  now?: () => number;
  sanitizeMessage?: (message: string) => string;
}
export interface BulkProfileTask {
  getSnapshot: () => BulkProfileTaskSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Idempotent while active. A completed task cannot be started again. */
  start: () => Promise<BulkProfileTaskSnapshot>;
  /** No cancellation claim is made for API requests already dispatched. */
  stopPending: () => void;
  /** Returns null while any request is in flight, or when nothing failed. */
  retryFailed: () => Promise<BulkProfileTaskSnapshot> | null;
}

let nextTaskId = 1;
const INCOMPLETE_RESULT = "The local service returned an incomplete action result.";
const ACTION_FAILED = "The environment action failed without an explanation.";

/** Keep common authentication forms out of in-memory UI messages too. No storage/logging occurs here. */
export function redactBulkTaskMessage(message: string): string {
  const result = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/((?:\[[^\]]+\]|[a-z0-9._-]+):\d{1,5}):[^:\s;,]+:[^\s;,]+/gi, "$1:[redacted]")
    .replace(/(["']?\b(?:proxy-authorization|authorization|token)\b["']?)\s*[:=]\s*["']?(?:basic|bearer)\s+[^"'\s,;]+["']?/gi, "$1=[redacted]")
    .replace(/(["']?\b(?:password|passwd|proxy-authorization|authorization|token|secret)\b["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]");
  return result.length > 1200 ? `${result.slice(0, 1200)}…` : result;
}

/** Session-only batch state. Only an explicit {ok:true} is a successful action. */
export function createBulkProfileTask(options: BulkProfileTaskOptions): BulkProfileTask {
  const now = options.now ?? Date.now;
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.min(4, Math.floor(options.concurrency!))) : 4;
  const id = `bulk-profile-${now()}-${nextTaskId++}`;
  const seen = new Set<string>();
  let rows: BulkProfileTaskRow[] = options.targets.flatMap(target => {
    if (typeof target.id !== "string" || !target.id.trim()) throw new TypeError("Every bulk task target needs a non-empty environment ID.");
    if (seen.has(target.id)) return [];
    seen.add(target.id);
    return [Object.freeze({ id: target.id, name: target.name || target.id, status: target.skipReason ? "skipped" as const : "pending" as const, attempts: 0,
      ...(target.skipReason ? { cause: "ineligible" as const, skipReason: target.skipReason } : {}) })];
  });
  let phase: BulkProfileTaskPhase = "idle", stopped = false;
  let startedAt: number | undefined, finishedAt: number | undefined;
  let current: Promise<BulkProfileTaskSnapshot> | null = null;
  let effectiveConcurrency = concurrency;
  const listeners = new Set<() => void>();
  const readConcurrencyLimit = (): number => {
    if (!options.getConcurrency) return concurrency;
    try {
      const value = options.getConcurrency();
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(1, Math.min(concurrency, Math.floor(value)));
      }
    } catch {
      // Keep the safe configured upper bound if telemetry callback throws.
    }
    return concurrency;
  };
  const message = (value: unknown, fallback: string): string => {
    const raw = typeof value === "string" && value.trim() ? value : fallback;
    try {
      const cleaned = redactBulkTaskMessage(raw);
      const result = options.sanitizeMessage ? options.sanitizeMessage(cleaned) : cleaned;
      return typeof result === "string" && result.trim() ? redactBulkTaskMessage(result) : fallback;
    } catch { return fallback; }
  };
  const snapshot = (): BulkProfileTaskSnapshot => {
    const counts = { total: rows.length, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, settled: 0 };
    for (const row of rows) counts[row.status]++;
    counts.settled = counts.succeeded + counts.failed + counts.skipped;
    return Object.freeze({
      id, action: options.action, phase, startedAt, finishedAt, stopped,
      effectiveConcurrency, throttled: effectiveConcurrency < concurrency,
      rows: Object.freeze([...rows]), summary: Object.freeze(counts),
    });
  };
  let published = snapshot();
  const publish = () => {
    const next = snapshot();
    published = next;
    for (const listener of [...listeners]) {
      // A failed view subscriber must not strand browser operations in flight.
      try { listener(); } catch { }
    }
    return next;
  };
  const settleRow = (index: number, update: Partial<BulkProfileTaskRow>) => {
    rows[index] = Object.freeze({ ...rows[index]!, ...update });
    publish();
  };
  const dispatchAll = (): Promise<void> => new Promise<void>(resolve => {
    let inFlight = 0;
    let finished = false;
    const maybeComplete = () => {
      if (finished) return;
      if (inFlight === 0 && (stopped || !rows.some(row => row.status === "pending"))) {
        finished = true;
        resolve();
      }
    };
    const pump = () => {
      let limitChanged = false;
      while (!stopped) {
        const limit = readConcurrencyLimit();
        if (limit !== effectiveConcurrency) {
          effectiveConcurrency = limit;
          limitChanged = true;
        }
        if (inFlight >= limit) break;
        const index = rows.findIndex(row => row.status === "pending");
        if (index < 0) break;
        const row = rows[index]!;
        inFlight++;
        limitChanged = false;
        settleRow(index, { status: "running", attempts: row.attempts + 1, startedAt: now(), finishedAt: undefined, error: undefined, warning: undefined, cause: undefined, skipReason: undefined });
        void Promise.resolve().then(() => options.run(row.id)).then(
          result => {
            if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean") {
              settleRow(index, { status: "failed", error: message(undefined, INCOMPLETE_RESULT), finishedAt: now() });
            } else if (!result.ok) {
              settleRow(index, { status: "failed", error: message("error" in result ? result.error : undefined, ACTION_FAILED), finishedAt: now() });
            } else {
              const warning = "warning" in result && typeof result.warning === "string" && result.warning.trim() ? message(result.warning, "") : undefined;
              settleRow(index, { status: "succeeded", warning, finishedAt: now() });
            }
          },
          error => {
            const detail = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
            settleRow(index, { status: "failed", error: message(detail, ACTION_FAILED), finishedAt: now() });
          },
        ).finally(() => {
          inFlight--;
          pump();
          maybeComplete();
        });
      }
      if (limitChanged) publish();
      maybeComplete();
    };
    pump();
  });
  const run = (): Promise<BulkProfileTaskSnapshot> => {
    if (current) return current;
    phase = "running"; stopped = false; finishedAt = undefined; startedAt ??= now();
    effectiveConcurrency = readConcurrencyLimit();
    // Defer dispatch until the stable active promise is installed, including
    // for callers that immediately react to the first subscriber notification.
    current = Promise.resolve().then(async () => {
      await dispatchAll();
      phase = "complete"; finishedAt = now(); current = null;
      return publish();
    });
    publish();
    return current;
  };
  return {
    getSnapshot: () => published,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (current) return current;
      if (phase === "complete") return Promise.resolve(published);
      return run();
    },
    stopPending() {
      if (phase === "complete" || stopped) return;
      stopped = true;
      rows = rows.map(row => row.status === "pending" ? Object.freeze({ ...row, status: "skipped", cause: "stopped", skipReason: undefined, finishedAt: now() }) : row);
      if (current) phase = "stopping";
      else { phase = "complete"; finishedAt = now(); }
      publish();
    },
    retryFailed() {
      if (current || !rows.some(row => row.status === "failed")) return null;
      rows = rows.map(row => row.status === "failed" ? Object.freeze({ ...row, status: "pending", error: undefined, warning: undefined, startedAt: undefined, finishedAt: undefined }) : row);
      return run();
    },
  };
}
