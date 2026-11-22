import type { Launcher } from "../../launcher.ts";
import type { ProfileStore, StoreMutationEvent } from "../../store.ts";
import type { RuntimeDownload } from "../../runtime-download.ts";
import type { ScriptRun } from "../../scripts.ts";

export type UiEventType =
  | "connected"
  | "roster.changed"
  | "profile.lifecycle"
  | "downloads.updated"
  | "script.run"
  | "task.updated"
  | "metrics.snapshot";

export interface UiEventEnvelope<T = unknown> {
  id: number;
  type: UiEventType;
  ts: number;
  workspaceId?: string;
  payload: T;
}

export interface RosterChangedPayload {
  reasons: string[];
  profileIds?: string[];
  full?: boolean;
  resync?: boolean;
}

export interface ProfileLifecyclePayload {
  profileId: string;
  running: boolean;
  startedAt?: number;
  debugPort?: number;
}

export interface DownloadsUpdatedPayload {
  downloads: RuntimeDownload[];
}

export interface ScriptRunPayload {
  run: ScriptRun | null;
}

export interface UiEventSubscriber {
  send(chunk: Uint8Array): void;
  close(): void;
}

export interface UiEventBusOptions {
  workspaceId?: string;
  maxClients?: number;
  historyCapacity?: number;
  coalesceWindowMs?: number;
  maxCoalescedProfileIds?: number;
  heartbeatIntervalMs?: number;
  orphanReconcileIntervalMs?: number;
  launcher?: Pick<Launcher, "reconcileOrphans">;
  store?: Pick<ProfileStore, "listLaunches">;
  log?: (msg: string) => void;
}

export const MAX_SSE_CLIENTS = 8;
export const SSE_HISTORY_CAPACITY = 256;
export const SSE_COALESCE_WINDOW_MS = 50;
export const SSE_MAX_COALESCED_PROFILE_IDS = 64;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_ORPHAN_RECONCILE_INTERVAL_MS = 4_000;

const encoder = new TextEncoder();
export const SSE_KEEPALIVE_BYTES = encoder.encode(": keepalive\n\n");

export function formatSseEvent(envelope: Pick<UiEventEnvelope, "id" | "type" | "payload">): string {
  return `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope.payload)}\n\n`;
}

export function encodeSseEvent(envelope: Pick<UiEventEnvelope, "id" | "type" | "payload">): Uint8Array {
  return encoder.encode(formatSseEvent(envelope));
}

export class UiEventBus {
  readonly workspaceId?: string;
  readonly maxClients: number;
  readonly historyCapacity: number;
  readonly coalesceWindowMs: number;
  readonly maxCoalescedProfileIds: number;
  readonly heartbeatIntervalMs: number;
  readonly orphanReconcileIntervalMs: number;

  private readonly launcher?: Pick<Launcher, "reconcileOrphans">;
  private readonly store?: Pick<ProfileStore, "listLaunches">;
  private readonly log: (msg: string) => void;

  private readonly subscribers = new Set<UiEventSubscriber>();
  private readonly ring: Array<UiEventEnvelope | undefined>;
  private ringWriteIndex = 0;
  private ringCount = 0;
  private lastId = 0;
  private closed = false;

  private pendingReasons = new Set<string>();
  private pendingProfileIds = new Set<string>();
  private pendingFull = false;
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private coalesceDeadlineAt = 0;

  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  private orphanInFlight = false;

  constructor(options: UiEventBusOptions = {}) {
    this.workspaceId = options.workspaceId;
    this.maxClients = Math.max(1, options.maxClients ?? MAX_SSE_CLIENTS);
    this.historyCapacity = Math.max(1, options.historyCapacity ?? SSE_HISTORY_CAPACITY);
    this.coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? SSE_COALESCE_WINDOW_MS);
    this.maxCoalescedProfileIds = Math.max(1, options.maxCoalescedProfileIds ?? SSE_MAX_COALESCED_PROFILE_IDS);
    this.heartbeatIntervalMs = Math.max(25, options.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS);
    this.orphanReconcileIntervalMs = Math.max(25, options.orphanReconcileIntervalMs ?? SSE_ORPHAN_RECONCILE_INTERVAL_MS);
    this.launcher = options.launcher;
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.ring = new Array<UiEventEnvelope | undefined>(this.historyCapacity);
  }

  headId(): number {
    return this.lastId;
  }

  clientCount(): number {
    return this.subscribers.size;
  }

  isClosed(): boolean {
    return this.closed;
  }

  subscribe(subscriber: UiEventSubscriber): () => void {
    if (this.closed) {
      try {
        subscriber.close();
      } catch {}
      return () => {};
    }
    while (this.subscribers.size >= this.maxClients) {
      const oldest = this.subscribers.values().next().value as UiEventSubscriber | undefined;
      if (!oldest) break;
      this.dropSubscriber(oldest);
    }
    this.subscribers.add(subscriber);
    this.syncOrphanReconciler();
    return () => {
      if (this.subscribers.delete(subscriber)) {
        this.syncOrphanReconciler();
      }
    };
  }

  replaySince(lastEventId: number): { events: UiEventEnvelope[]; overflow: boolean } {
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
      return { events: [], overflow: true };
    }
    if (this.lastId === 0) {
      return { events: [], overflow: lastEventId > 0 };
    }
    if (lastEventId === this.lastId) {
      return { events: [], overflow: false };
    }
    if (lastEventId > this.lastId) {
      // Server restarted (monotonic id reset) or client holds a stale sequence.
      return { events: [], overflow: true };
    }
    if (this.ringCount === 0) {
      return { events: [], overflow: true };
    }
    const oldestIndex = (this.ringWriteIndex - this.ringCount + this.historyCapacity) % this.historyCapacity;
    const oldest = this.ring[oldestIndex];
    if (!oldest || lastEventId < oldest.id - 1) {
      return { events: [], overflow: true };
    }
    const events: UiEventEnvelope[] = [];
    for (let i = 0; i < this.ringCount; i++) {
      const entry = this.ring[(oldestIndex + i) % this.historyCapacity];
      if (entry && entry.id > lastEventId) {
        events.push(entry);
      }
    }
    return { events, overflow: false };
  }

  emit<T>(type: Exclude<UiEventType, "connected">, payload: T): UiEventEnvelope<T> {
    const envelope: UiEventEnvelope<T> = {
      id: ++this.lastId,
      type,
      ts: Date.now(),
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      payload,
    };
    if (this.closed) return envelope;
    this.recordHistory(envelope);
    this.broadcast(envelope);
    return envelope;
  }

  emitRosterChanged(reason: string, profileIds?: readonly string[]): void {
    if (this.closed) return;
    this.pendingReasons.add(reason);
    if (!this.pendingFull) {
      if (!profileIds || profileIds.length === 0) {
        this.pendingFull = true;
        this.pendingProfileIds.clear();
      } else {
        for (const id of profileIds) {
          this.pendingProfileIds.add(id);
          if (this.pendingProfileIds.size > this.maxCoalescedProfileIds) {
            this.pendingFull = true;
            this.pendingProfileIds.clear();
            break;
          }
        }
      }
    }
    if (this.coalesceWindowMs === 0) {
      this.flushRosterChanged();
      return;
    }
    const now = Date.now();
    if (this.coalesceDeadlineAt === 0) {
      this.coalesceDeadlineAt = now + Math.max(this.coalesceWindowMs * 2, 100);
    }
    const remaining = Math.max(0, Math.min(this.coalesceWindowMs, this.coalesceDeadlineAt - now));
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
    }
    this.coalesceTimer = setTimeout(() => {
      this.flushRosterChanged();
    }, remaining);
  }

  flushRosterChanged(): UiEventEnvelope<RosterChangedPayload> | null {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.coalesceDeadlineAt = 0;
    if (this.closed || this.pendingReasons.size === 0) {
      this.pendingReasons.clear();
      this.pendingProfileIds.clear();
      this.pendingFull = false;
      return null;
    }
    const payload: RosterChangedPayload = {
      reasons: [...this.pendingReasons],
      ...(this.pendingFull
        ? { full: true }
        : this.pendingProfileIds.size > 0
          ? { profileIds: [...this.pendingProfileIds] }
          : {}),
    };
    this.pendingReasons.clear();
    this.pendingProfileIds.clear();
    this.pendingFull = false;
    return this.emit("roster.changed", payload);
  }

  emitProfileLifecycle(payload: ProfileLifecyclePayload): UiEventEnvelope<ProfileLifecyclePayload> {
    const envelope = this.emit("profile.lifecycle", payload);
    this.syncOrphanReconciler();
    return envelope;
  }

  emitDownloadsUpdated(downloads: RuntimeDownload[]): UiEventEnvelope<DownloadsUpdatedPayload> {
    return this.emit("downloads.updated", { downloads });
  }

  emitScriptRun(run: ScriptRun | null): UiEventEnvelope<ScriptRunPayload> {
    return this.emit("script.run", { run });
  }

  emitTaskUpdated(payload: Record<string, unknown>): UiEventEnvelope<Record<string, unknown>> {
    return this.emit("task.updated", payload);
  }

  emitMetricsSnapshot(payload: Record<string, unknown>): UiEventEnvelope<Record<string, unknown>> {
    return this.emit("metrics.snapshot", payload);
  }

  handleStoreMutation(event: StoreMutationEvent): void {
    if (this.closed) return;
    if (event.kind === "lifecycle") {
      this.emitProfileLifecycle({
        profileId: event.profileId,
        running: event.running,
        ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
        ...(event.debugPort !== undefined ? { debugPort: event.debugPort } : {}),
      });
      return;
    }
    this.emitRosterChanged(event.reason, event.profileIds);
  }

  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.coalesceDeadlineAt = 0;
    this.pendingReasons.clear();
    this.pendingProfileIds.clear();
    this.pendingFull = false;
    this.stopOrphanReconciler();
    const active = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of active) {
      try {
        subscriber.close();
      } catch {}
    }
  }

  private recordHistory(envelope: UiEventEnvelope): void {
    this.ring[this.ringWriteIndex] = envelope;
    this.ringWriteIndex = (this.ringWriteIndex + 1) % this.historyCapacity;
    if (this.ringCount < this.historyCapacity) {
      this.ringCount += 1;
    }
  }

  private broadcast(envelope: UiEventEnvelope): void {
    if (this.subscribers.size === 0) return;
    const frame = encodeSseEvent(envelope);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.send(frame);
      } catch {
        this.dropSubscriber(subscriber);
      }
    }
  }

  private dropSubscriber(subscriber: UiEventSubscriber): void {
    this.subscribers.delete(subscriber);
    try {
      subscriber.close();
    } catch {}
    this.syncOrphanReconciler();
  }

  private hasRunningLaunches(): boolean {
    if (!this.store || typeof this.store.listLaunches !== "function") return false;
    try {
      return this.store.listLaunches().length > 0;
    } catch (error) {
      this.log(`events orphan check failed to read launches: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private shouldReconcileOrphans(): boolean {
    return (
      !this.closed &&
      this.subscribers.size > 0 &&
      typeof this.launcher?.reconcileOrphans === "function" &&
      this.hasRunningLaunches()
    );
  }

  private stopOrphanReconciler(): void {
    if (this.orphanTimer !== undefined) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = undefined;
    }
  }

  private syncOrphanReconciler(): void {
    if (!this.shouldReconcileOrphans()) {
      this.stopOrphanReconciler();
      return;
    }
    if (this.orphanTimer !== undefined || this.orphanInFlight) return;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = undefined;
      void this.runOrphanReconcileOnce();
    }, this.orphanReconcileIntervalMs);
  }

  private async runOrphanReconcileOnce(): Promise<void> {
    if (this.orphanInFlight || !this.shouldReconcileOrphans()) return;
    this.orphanInFlight = true;
    try {
      await this.launcher!.reconcileOrphans();
    } catch (error) {
      this.log(`events orphan reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.orphanInFlight = false;
      this.syncOrphanReconciler();
    }
  }
}
