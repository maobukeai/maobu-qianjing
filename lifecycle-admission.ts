import type {
  MemoryWatermarkAdmissionPolicy,
  MemoryWatermarkStatus,
} from "./src/metrics/memory-watermark-guard.ts";

export type LifecycleTransitionKind = "stop" | "cleanup" | "start";
export type LifecycleState = "starting" | "stopping" | "uncertain";

const PRIORITY: Record<LifecycleTransitionKind, number> = {
  stop: 3,
  cleanup: 2,
  start: 1,
};

// Host-wide slots for browser lifecycle work. Every admitted operation holds its
// slot for the whole launch or teardown, and a start may legitimately take as long
// as the launcher's CDP ceiling (180s). Four slots left too little headroom for
// automation that opens many profiles: a request merely queued behind a couple of
// slow launches exhausted the 120s wait and was reported as a browser that could
// not start, even though nothing had failed.
const DEFAULT_LIMIT = 8;
const DEFAULT_QUEUE_WAIT_MS = 200_000;

export interface LifecycleAdmissionStats {
  limit: number;
  inFlight: number;
  queued: number;
  byKind: Record<LifecycleTransitionKind, { inFlight: number; queued: number }>;
}

export interface LifecycleAdmissionOptions {
  limit?: number;
  queueWaitMs?: number;
  /** Optional host memory watermark guard that dynamically throttles/pauses `start` only. */
  memoryGuard?: MemoryWatermarkAdmissionPolicy;
  /** Optional clock override for deterministic tests. */
  now?: () => number;
}

export interface LifecycleAdmissionRequest {
  kind: LifecycleTransitionKind;
  profileIds?: Iterable<string>;
  signal?: AbortSignal;
}

export type LifecycleAdmissionErrorReason = "aborted" | "timeout" | "memory_watermark_exceeded";

export interface LifecycleAdmissionErrorDetails {
  memoryLoadPercent?: number;
  availableMemoryBytes?: number;
}

export class LifecycleAdmissionError extends Error {
  readonly memoryLoadPercent?: number;
  readonly availableMemoryBytes?: number;

  constructor(
    message: string,
    readonly reason: LifecycleAdmissionErrorReason,
    details?: LifecycleAdmissionErrorDetails,
  ) {
    super(message);
    this.name = "LifecycleAdmissionError";
    this.memoryLoadPercent = details?.memoryLoadPercent;
    this.availableMemoryBytes = details?.availableMemoryBytes;
  }
}

interface QueuedOperation {
  id: number;
  kind: LifecycleTransitionKind;
  profileIds: string[];
  handler: () => unknown | Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  signal?: AbortSignal;
  criticalSinceMs?: number;
}

/** Host-wide admission for expensive browser lifecycle transitions. */
export class LifecycleAdmissionController {
  readonly limit: number;
  readonly queueWaitMs: number;
  private readonly memoryGuard?: MemoryWatermarkAdmissionPolicy;
  private readonly now: () => number;
  private nextId = 1;
  private queue: QueuedOperation[] = [];
  private running = new Map<number, QueuedOperation>();
  private runningProfiles = new Set<string>();
  private lastStartAdmittedAt = 0;
  private wakeupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LifecycleAdmissionOptions = {}) {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const queueWaitMs = options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("lifecycle admission limit must be a positive integer");
    if (!Number.isInteger(queueWaitMs) || queueWaitMs < 1) throw new RangeError("lifecycle queue wait must be a positive integer");
    this.limit = limit;
    this.queueWaitMs = queueWaitMs;
    this.memoryGuard = options.memoryGuard;
    this.now = options.now ?? (() => Date.now());
  }

  run<T>(request: LifecycleAdmissionRequest, handler: () => T | Promise<T>): Promise<T> {
    if (request.signal?.aborted) {
      return Promise.reject(new LifecycleAdmissionError("lifecycle request was aborted before dispatch", "aborted"));
    }

    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperation = {
        id: this.nextId++,
        kind: request.kind,
        profileIds: [...new Set([...(request.profileIds ?? [])].map(String).filter(Boolean))],
        handler,
        resolve: (value) => resolve(value as T),
        reject,
        signal: request.signal,
      };
      const waitMs = this.queueWaitMs;
      operation.timer = setTimeout(() => {
        this.rejectQueued(
          operation,
          new LifecycleAdmissionError(`lifecycle ${operation.kind} queue wait exceeded ${waitMs}ms before dispatch`, "timeout"),
        );
      }, waitMs);

      if (request.signal) {
        operation.abort = () => {
          this.rejectQueued(
            operation,
            new LifecycleAdmissionError(`lifecycle ${operation.kind} was aborted before dispatch`, "aborted"),
          );
        };
        request.signal.addEventListener("abort", operation.abort, { once: true });
      }

      this.queue.push(operation);
      this.drain();
    });
  }

  stats(): LifecycleAdmissionStats {
    const byKind: LifecycleAdmissionStats["byKind"] = {
      stop: { inFlight: 0, queued: 0 },
      cleanup: { inFlight: 0, queued: 0 },
      start: { inFlight: 0, queued: 0 },
    };
    for (const operation of this.queue) byKind[operation.kind].queued++;
    for (const operation of this.running.values()) byKind[operation.kind].inFlight++;
    return {
      limit: this.limit,
      inFlight: this.running.size,
      queued: this.queue.length,
      byKind,
    };
  }

  lifecycleState(profileId: string): LifecycleState | null {
    let starting = false;
    let stopping = false;
    let uncertain = false;
    const inspect = (operation: QueuedOperation) => {
      if (!operation.profileIds.includes(profileId)) return;
      if (operation.kind === "stop") stopping = true;
      else if (operation.kind === "cleanup") uncertain = true;
      else starting = true;
    };
    for (const operation of this.running.values()) inspect(operation);
    for (const operation of this.queue) inspect(operation);
    if (stopping) return "stopping";
    if (uncertain) return "uncertain";
    return starting ? "starting" : null;
  }

  private rejectQueued(operation: QueuedOperation, error: LifecycleAdmissionError): void {
    const index = this.queue.indexOf(operation);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.clearQueueHooks(operation);
    operation.reject(error);
    this.drain();
  }

  private clearWakeupTimer(): void {
    if (this.wakeupTimer !== undefined) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = undefined;
    }
  }

  private scheduleWakeup(delayMs: number): void {
    this.clearWakeupTimer();
    const clamped = Math.max(1, Math.trunc(delayMs));
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = undefined;
      this.drain();
    }, clamped);
  }

  private evaluateMemoryDecision(baseStartLimit: number): MemoryWatermarkStatus | null {
    if (!this.memoryGuard) return null;
    if (!this.queue.some((op) => op.kind === "start")) return null;
    try {
      return this.memoryGuard.evaluate(baseStartLimit);
    } catch {
      return null;
    }
  }

  private expireCriticalStarts(decision: MemoryWatermarkStatus, nowMs: number): number | null {
    if (!this.memoryGuard || !decision.paused) {
      for (const op of this.queue) {
        if (op.kind === "start") op.criticalSinceMs = undefined;
      }
      return null;
    }
    const timeoutMs = this.memoryGuard.criticalWaitTimeoutMs;
    const expired: QueuedOperation[] = [];
    let earliestRemaining: number | null = null;
    for (const op of this.queue) {
      if (op.kind !== "start") continue;
      if (op.criticalSinceMs === undefined) op.criticalSinceMs = nowMs;
      const elapsed = nowMs - op.criticalSinceMs;
      if (elapsed >= timeoutMs) {
        expired.push(op);
      } else {
        const remaining = timeoutMs - elapsed;
        earliestRemaining = earliestRemaining === null ? remaining : Math.min(earliestRemaining, remaining);
      }
    }
    for (const op of expired) {
      const idx = this.queue.indexOf(op);
      if (idx < 0) continue;
      this.queue.splice(idx, 1);
      this.clearQueueHooks(op);
      const availMb = Math.round(decision.availableBytes / (1024 * 1024));
      op.reject(
        new LifecycleAdmissionError(
          `memory watermark exceeded (${decision.memoryLoadPercent}% used, ${availMb} MiB available)`,
          "memory_watermark_exceeded",
          {
            memoryLoadPercent: decision.memoryLoadPercent,
            availableMemoryBytes: decision.availableBytes,
          },
        ),
      );
    }
    return earliestRemaining;
  }

  private drain(): void {
    this.clearWakeupTimer();
    let pendingWakeupMs: number | null = null;

    while (this.running.size < this.limit) {
      const baseStartLimit = this.limit > 1 ? this.limit - 1 : 1;
      const nowMs = this.now();
      const decision = this.evaluateMemoryDecision(baseStartLimit);
      let criticalRemainingMs: number | null = null;
      if (decision) {
        criticalRemainingMs = this.expireCriticalStarts(decision, nowMs);
      }

      let startLimit = baseStartLimit;
      let startDelayRemainingMs = 0;
      if (decision) {
        if (decision.paused) {
          startLimit = 0;
        } else {
          startLimit = Math.min(baseStartLimit, decision.effectiveStartLimit);
          if (decision.startDelayMs > 0 && this.lastStartAdmittedAt > 0) {
            const elapsed = nowMs - this.lastStartAdmittedAt;
            if (elapsed < decision.startDelayMs) {
              startDelayRemainingMs = decision.startDelayMs - elapsed;
            }
          }
        }
      }

      const index = this.nextEligibleIndex(startLimit, startDelayRemainingMs > 0);
      if (index < 0) {
        const hasQueuedStart = this.queue.some((op) => op.kind === "start");
        if (hasQueuedStart && decision && this.memoryGuard) {
          if (decision.paused) {
            const nextPoll =
              criticalRemainingMs !== null
                ? Math.min(this.memoryGuard.pollIntervalMs, criticalRemainingMs)
                : this.memoryGuard.pollIntervalMs;
            pendingWakeupMs = Math.max(1, nextPoll);
          } else if (startDelayRemainingMs > 0) {
            pendingWakeupMs = startDelayRemainingMs;
          }
        }
        break;
      }

      const [operation] = this.queue.splice(index, 1);
      if (!operation) break;
      this.admit(operation);
    }

    if (pendingWakeupMs !== null && this.queue.some((op) => op.kind === "start")) {
      this.scheduleWakeup(pendingWakeupMs);
    }
  }

  private nextEligibleIndex(startLimit: number, startPaced: boolean): number {
    let best = -1;
    let bestPriority = -1;
    const blockedProfiles = new Set(this.runningProfiles);
    const runningStarts = [...this.running.values()].filter((operation) => operation.kind === "start").length;
    for (let index = 0; index < this.queue.length; index++) {
      const operation = this.queue[index]!;
      const profileEligible = !operation.profileIds.some((id) => blockedProfiles.has(id));
      const laneEligible =
        operation.kind !== "start" || (!startPaced && runningStarts < startLimit);
      for (const id of operation.profileIds) blockedProfiles.add(id);
      const priority = PRIORITY[operation.kind];
      if (profileEligible && laneEligible && priority > bestPriority) {
        best = index;
        bestPriority = priority;
      }
    }
    return best;
  }

  private admit(operation: QueuedOperation): void {
    this.clearQueueHooks(operation);
    if (operation.kind === "start") {
      this.lastStartAdmittedAt = this.now();
    }
    this.running.set(operation.id, operation);
    for (const id of operation.profileIds) this.runningProfiles.add(id);

    void (async () => {
      try {
        operation.resolve(await operation.handler());
      } catch (error) {
        operation.reject(error);
      } finally {
        this.running.delete(operation.id);
        for (const id of operation.profileIds) this.runningProfiles.delete(id);
        this.drain();
      }
    })();
  }

  private clearQueueHooks(operation: QueuedOperation): void {
    if (operation.timer) clearTimeout(operation.timer);
    if (operation.signal && operation.abort) operation.signal.removeEventListener("abort", operation.abort);
    operation.timer = undefined;
    operation.abort = undefined;
    operation.criticalSinceMs = undefined;
  }
}

export function normalizeProfileIds(value: unknown): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

interface ClassifiedLifecycleRequest {
  kind: LifecycleTransitionKind;
  profileIds: string[];
  protocol: "adspower" | "ui";
}

/** Classify lifecycle routes before any standalone or remote handler is invoked. */
export async function classifyLifecycleRequest(req: Request): Promise<ClassifiedLifecycleRequest | null> {
  const url = new URL(req.url);
  if (url.pathname === "/api/v1/browser/start") {
    return { kind: "start", profileIds: normalizeProfileIds(url.searchParams.get("user_id")), protocol: "adspower" };
  }
  if (url.pathname === "/api/v1/browser/stop") {
    return { kind: "stop", profileIds: normalizeProfileIds(url.searchParams.get("user_id")), protocol: "adspower" };
  }
  if (url.pathname === "/api/v2/browser-profile/delete-cache") {
    let profileIds: string[] = [];
    try {
      const body = (await req.clone().json()) as { profile_id?: unknown };
      profileIds = normalizeProfileIds(body?.profile_id);
    } catch {}
    return { kind: "cleanup", profileIds, protocol: "adspower" };
  }
  const ui = url.pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/(open|close|clear-cache|restore-session|hibernate)$/);
  if (!ui || req.method !== "POST") return null;
  let profileId = ui[1]!;
  try {
    profileId = decodeURIComponent(profileId);
  } catch {}
  const action = ui[2]!;
  return {
    // A session restore can open and close a browser, so it queues like a start.
    kind: action === "open" || action === "restore-session"
      ? "start"
      : action === "close" || action === "hibernate" ? "stop" : "cleanup",
    profileIds: normalizeProfileIds(profileId),
    protocol: "ui",
  };
}

/** Queue lifecycle work, preserving each API's response envelope on pre-dispatch rejection. */
export async function dispatchWithLifecycleAdmission(
  req: Request,
  admission: LifecycleAdmissionController,
  dispatch: () => Promise<Response>,
): Promise<Response> {
  const classified = await classifyLifecycleRequest(req);
  if (!classified) return dispatch();
  try {
    return await admission.run(
      { kind: classified.kind, profileIds: classified.profileIds, signal: req.signal },
      dispatch,
    );
  } catch (error) {
    if (!(error instanceof LifecycleAdmissionError)) throw error;
    const message = `${error.message}; request was not dispatched`;
    if (error.reason === "memory_watermark_exceeded") {
      if (classified.protocol === "adspower") {
        return Response.json({
          code: -1,
          msg: message,
          data: {
            code: "memory_watermark_exceeded",
            memoryLoadPercent: error.memoryLoadPercent ?? 0,
            availableMemoryBytes: error.availableMemoryBytes ?? 0,
          },
        });
      }
      return Response.json(
        {
          ok: false,
          code: "memory_watermark_exceeded",
          error: message,
          memoryLoadPercent: error.memoryLoadPercent ?? 0,
          availableMemoryBytes: error.availableMemoryBytes ?? 0,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (classified.protocol === "adspower") {
      return Response.json({ code: -1, msg: message, data: {} });
    }
    return Response.json({ ok: false, error: message }, { status: 503 });
  }
}
