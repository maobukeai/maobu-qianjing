import type { Launcher } from "../launcher.ts";
import type { ProfileStore } from "../store.ts";
import type { LaunchInfo } from "../types.ts";
import {
  MemoryWatermarkGuard,
  type MemoryWatermarkStatus,
} from "./memory-watermark-guard.ts";
import {
  ProcessTreeMetricsCollector,
  type HostMemoryMetrics,
} from "./process-metrics.ts";

export interface ProfileProcessMetrics {
  profileId: string;
  name: string;
  engine: "chromium" | "firefox";
  pid: number;
  processCount: number;
  rssBytes: number;
  privateBytes: number;
  cpuPercent: number;
  startedAt: number;
}

export interface MetricsSnapshot {
  ts: number;
  host: HostMemoryMetrics;
  totals: {
    runningProfiles: number;
    totalProcesses: number;
    totalRssBytes: number;
    totalPrivateBytes: number;
    totalCpuPercent: number;
  };
  watermark: MemoryWatermarkStatus;
  profiles: ProfileProcessMetrics[];
  hibernatedProfileIds: string[];
  sampleDurationMs: number;
}

export interface TrimProfileMemoryResult {
  profileId: string;
  engine: "chromium" | "firefox";
  running: boolean;
  cdpPurged: boolean;
  workingSetTrimmed: boolean;
  trimmedProcesses: number;
  beforeRssBytes: number;
  afterRssBytes: number;
  reclaimedBytes: number;
}

export interface TrimAllMemoryResult {
  trimmedProfiles: number;
  totalBeforeRssBytes: number;
  totalAfterRssBytes: number;
  totalReclaimedBytes: number;
  results: TrimProfileMemoryResult[];
}

export interface HibernateProfileResult {
  profileId: string;
  status: "hibernated" | "not_running" | "not_found" | "stop_failed";
  sessionCaptured: boolean;
  stopped: boolean;
  hibernated: boolean;
  hibernatedAt?: number;
}

export interface HibernateBatchResult {
  hibernatedCount: number;
  skippedCount: number;
  failedCount: number;
  results: HibernateProfileResult[];
}

export type MetricsSnapshotListener = (snapshot: MetricsSnapshot) => void;

export interface MetricsServiceOptions {
  store?: Partial<Pick<ProfileStore, "listLaunches" | "getProfile" | "getLaunch">>;
  launcher?: Partial<Pick<Launcher, "captureLocalSession" | "stop">>;
  collector?: ProcessTreeMetricsCollector;
  watermarkGuard?: MemoryWatermarkGuard;
  purgeCdpMemory?: (launch: LaunchInfo) => Promise<boolean>;
  intervalMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export const DEFAULT_METRICS_INTERVAL_MS = 2_500;
const CDP_PURGE_TIMEOUT_MS = 2_000;
const BATCH_ACTION_CONCURRENCY = 4;

function isLoopbackWsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort CDP Memory.forciblyPurgeJavaScriptMemory over a single loopback WebSocket
 * to Chromium's browser DevTools endpoint, purging all open page targets.
 */
export async function purgeChromiumJavaScriptMemory(
  launch: Pick<LaunchInfo, "ws" | "engine">,
  timeoutMs = CDP_PURGE_TIMEOUT_MS,
): Promise<boolean> {
  if (launch.engine === "firefox" || !launch.ws || !isLoopbackWsUrl(launch.ws)) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let sock: WebSocket | undefined;
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { res: (value: any) => void; rej: (err: Error) => void }>();

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) {
        entry.rej(new Error("CDP purge closed"));
      }
      pending.clear();
      try {
        sock?.close();
      } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), Math.max(50, timeoutMs));

    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
      new Promise((res, rej) => {
        if (settled || !sock) {
          rej(new Error("CDP socket unavailable"));
          return;
        }
        const id = nextId++;
        pending.set(id, { res, rej });
        try {
          sock.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        } catch (err) {
          pending.delete(id);
          rej(err instanceof Error ? err : new Error(String(err)));
        }
      });

    try {
      sock = new WebSocket(launch.ws);
    } catch {
      finish(false);
      return;
    }

    sock.addEventListener("error", () => finish(false));
    sock.addEventListener("close", () => finish(false));
    sock.addEventListener("message", (event) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (msg && typeof msg.id === "number" && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) entry.rej(new Error(msg.error.message || "CDP error"));
        else entry.res(msg.result);
      }
    });

    sock.addEventListener("open", () => {
      void (async () => {
        let purgedAny = false;
        try {
          const targetsRes = await send("Target.getTargets").catch(() => null);
          const targetInfos = Array.isArray(targetsRes?.targetInfos) ? targetsRes.targetInfos : [];
          const pages = targetInfos.filter((t: any) => t && t.type === "page" && typeof t.targetId === "string");
          for (const page of pages.slice(0, 32)) {
            if (settled) break;
            try {
              const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
              const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
              if (!sessionId) continue;
              try {
                await send("Memory.forciblyPurgeJavaScriptMemory", {}, sessionId);
                purgedAny = true;
              } finally {
                await send("Target.detachFromTarget", { sessionId }).catch(() => {});
              }
            } catch {
              // Ignore individual target failures; keep purging remaining tabs.
            }
          }
          if (!purgedAny) {
            await send("Memory.forciblyPurgeJavaScriptMemory")
              .then(() => {
                purgedAny = true;
              })
              .catch(() => {});
          }
        } catch {
          // Best-effort purge.
        }
        finish(purgedAny);
      })();
    });
  });
}

async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runNext = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]!);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/**
 * Demand-driven real-time process resource monitor, memory trimmer, and hibernation coordinator.
 * Runs ZERO background timers (0% CPU) when subscriberCount === 0.
 */
export class MetricsService {
  readonly intervalMs: number;
  readonly collector: ProcessTreeMetricsCollector;
  readonly watermarkGuard: MemoryWatermarkGuard;

  private readonly store?: Partial<Pick<ProfileStore, "listLaunches" | "getProfile" | "getLaunch">>;
  private readonly launcher?: Partial<Pick<Launcher, "captureLocalSession" | "stop">>;
  private readonly purgeCdpMemoryFn: (launch: LaunchInfo) => Promise<boolean>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private readonly subscribers = new Set<MetricsSnapshotListener>();
  private readonly hibernated = new Map<string, { hibernatedAt: number; sessionCaptured: boolean }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastSnapshot: MetricsSnapshot | null = null;

  constructor(options: MetricsServiceOptions = {}) {
    this.store = options.store;
    this.launcher = options.launcher;
    this.collector = options.collector ?? new ProcessTreeMetricsCollector({ now: options.now });
    this.watermarkGuard = options.watermarkGuard ?? new MemoryWatermarkGuard({
      readHostMemory: () => this.collector.readHostMemory(),
    });
    this.purgeCdpMemoryFn = options.purgeCdpMemory ?? ((launch) => purgeChromiumJavaScriptMemory(launch));
    this.intervalMs = Math.max(25, options.intervalMs ?? DEFAULT_METRICS_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  isClosed(): boolean {
    return this.closed;
  }

  latestSnapshot(): MetricsSnapshot | null {
    return this.lastSnapshot;
  }

  subscribe(listener: MetricsSnapshotListener): () => void {
    if (this.closed) return () => {};
    this.subscribers.add(listener);
    this.syncTimer();
    return () => {
      if (this.subscribers.delete(listener)) {
        this.syncTimer();
      }
    };
  }

  clearHibernated(profileId: string): void {
    this.hibernated.delete(profileId);
  }

  isHibernated(profileId: string): boolean {
    return this.hibernated.has(profileId);
  }

  listHibernatedProfileIds(): string[] {
    const running = new Set(this.safeListLaunches().map((l) => l.profileId));
    const ids: string[] = [];
    for (const id of [...this.hibernated.keys()]) {
      if (running.has(id)) {
        this.hibernated.delete(id);
        continue;
      }
      if (typeof this.store?.getProfile === "function") {
        try {
          if (!this.store.getProfile(id)) {
            this.hibernated.delete(id);
            continue;
          }
        } catch {}
      }
      ids.push(id);
    }
    return ids;
  }

  snapshot(): MetricsSnapshot {
    const ts = this.now();
    const launches = this.safeListLaunches();
    for (const launch of launches) {
      this.hibernated.delete(launch.profileId);
    }

    const rootPids = launches.map((l) => l.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
    const sampled = this.collector.sampleTrees(rootPids);
    const watermark = this.watermarkGuard.evaluate(4, sampled.host);

    const profiles: ProfileProcessMetrics[] = [];
    let totalProcesses = 0;
    let totalRssBytes = 0;
    let totalPrivateBytes = 0;
    let totalCpuPercent = 0;

    for (const launch of launches) {
      const storedProfile = this.safeGetProfile(launch.profileId);
      const engine: "chromium" | "firefox" =
        launch.engine === "firefox" || storedProfile?.engine === "firefox" ? "firefox" : "chromium";
      const tree = sampled.trees.get(launch.pid);
      const processCount = tree?.processCount ?? 0;
      const rssBytes = tree?.rssBytes ?? 0;
      const privateBytes = tree?.privateBytes ?? 0;
      const cpuPercent = tree?.cpuPercent ?? 0;
      totalProcesses += processCount;
      totalRssBytes += rssBytes;
      totalPrivateBytes += privateBytes;
      totalCpuPercent += cpuPercent;
      profiles.push({
        profileId: launch.profileId,
        name: storedProfile?.name ?? launch.profileId,
        engine,
        pid: launch.pid,
        processCount,
        rssBytes,
        privateBytes,
        cpuPercent,
        startedAt: launch.startedAt,
      });
    }

    profiles.sort((a, b) => b.rssBytes - a.rssBytes || a.profileId.localeCompare(b.profileId));

    const snap: MetricsSnapshot = {
      ts,
      host: sampled.host,
      totals: {
        runningProfiles: launches.length,
        totalProcesses,
        totalRssBytes,
        totalPrivateBytes,
        totalCpuPercent: Math.max(0, Math.min(100, Math.round(totalCpuPercent * 10) / 10)),
      },
      watermark,
      profiles,
      hibernatedProfileIds: this.listHibernatedProfileIds(),
      sampleDurationMs: sampled.durationMs,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  async trimProfileMemory(profileId: string): Promise<TrimProfileMemoryResult> {
    const launch = this.safeGetLaunch(profileId);
    const storedProfile = this.safeGetProfile(profileId);
    const engine: "chromium" | "firefox" =
      launch?.engine === "firefox" || storedProfile?.engine === "firefox" ? "firefox" : "chromium";

    if (!launch) {
      return {
        profileId,
        engine,
        running: false,
        cdpPurged: false,
        workingSetTrimmed: false,
        trimmedProcesses: 0,
        beforeRssBytes: 0,
        afterRssBytes: 0,
        reclaimedBytes: 0,
      };
    }

    const beforeSample = launch.pid > 0 ? this.collector.sampleTrees([launch.pid]).trees.get(launch.pid) : undefined;
    const beforeRssBytes = beforeSample?.rssBytes ?? 0;

    let cdpPurged = false;
    if (engine === "chromium") {
      try {
        cdpPurged = await this.purgeCdpMemoryFn(launch);
      } catch (error) {
        this.log(`trim memory CDP purge failed for ${profileId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const wsTrim = this.collector.trimProcessTreeWorkingSet(launch.pid);
    const finalBefore = Math.max(beforeRssBytes, wsTrim.beforeRssBytes);
    const afterRssBytes =
      wsTrim.trimmedProcesses > 0
        ? wsTrim.afterRssBytes
        : launch.pid > 0
          ? (this.collector.sampleTrees([launch.pid]).trees.get(launch.pid)?.rssBytes ?? wsTrim.afterRssBytes)
          : 0;

    return {
      profileId,
      engine,
      running: true,
      cdpPurged,
      workingSetTrimmed: wsTrim.trimmedProcesses > 0,
      trimmedProcesses: wsTrim.trimmedProcesses,
      beforeRssBytes: finalBefore,
      afterRssBytes,
      reclaimedBytes: Math.max(0, finalBefore - afterRssBytes),
    };
  }

  async trimAllMemory(): Promise<TrimAllMemoryResult> {
    const launches = this.safeListLaunches();
    const results = await runBounded(launches, BATCH_ACTION_CONCURRENCY, (launch) =>
      this.trimProfileMemory(launch.profileId),
    );
    let totalBeforeRssBytes = 0;
    let totalAfterRssBytes = 0;
    let totalReclaimedBytes = 0;
    let trimmedProfiles = 0;
    for (const r of results) {
      if (r.running) trimmedProfiles += 1;
      totalBeforeRssBytes += r.beforeRssBytes;
      totalAfterRssBytes += r.afterRssBytes;
      totalReclaimedBytes += r.reclaimedBytes;
    }
    return {
      trimmedProfiles,
      totalBeforeRssBytes,
      totalAfterRssBytes,
      totalReclaimedBytes,
      results,
    };
  }

  async hibernateProfile(profileId: string): Promise<HibernateProfileResult> {
    const profile = this.safeGetProfile(profileId);
    if (!profile) {
      return {
        profileId,
        status: "not_found",
        sessionCaptured: false,
        stopped: false,
        hibernated: false,
      };
    }
    const launch = this.safeGetLaunch(profileId);
    if (!launch) {
      return {
        profileId,
        status: "not_running",
        sessionCaptured: false,
        stopped: false,
        hibernated: this.hibernated.has(profileId),
      };
    }

    let sessionCaptured = false;
    if (typeof this.launcher?.captureLocalSession === "function") {
      try {
        sessionCaptured = await this.launcher.captureLocalSession(profileId);
      } catch (error) {
        this.log(`hibernate session capture failed for ${profileId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let stopped = false;
    if (typeof this.launcher?.stop === "function") {
      try {
        stopped = await this.launcher.stop(profileId, launch);
      } catch (error) {
        this.log(`hibernate stop failed for ${profileId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!stopped) {
      return {
        profileId,
        status: "stop_failed",
        sessionCaptured,
        stopped: false,
        hibernated: false,
      };
    }

    const hibernatedAt = this.now();
    this.hibernated.set(profileId, { hibernatedAt, sessionCaptured });
    return {
      profileId,
      status: "hibernated",
      sessionCaptured,
      stopped: true,
      hibernated: true,
      hibernatedAt,
    };
  }

  async hibernateBatch(profileIds: readonly string[]): Promise<HibernateBatchResult> {
    const uniqueIds = [...new Set(profileIds)];
    const results = await runBounded(uniqueIds, BATCH_ACTION_CONCURRENCY, (id) => this.hibernateProfile(id));
    let hibernatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    for (const r of results) {
      if (r.status === "hibernated") hibernatedCount += 1;
      else if (r.status === "not_running" || r.status === "not_found") skippedCount += 1;
      else failedCount += 1;
    }
    return { hibernatedCount, skippedCount, failedCount, results };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.subscribers.clear();
  }

  private safeListLaunches(): LaunchInfo[] {
    if (!this.store || typeof this.store.listLaunches !== "function") return [];
    try {
      return this.store.listLaunches();
    } catch (error) {
      this.log(`metrics listLaunches failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private safeGetLaunch(profileId: string): LaunchInfo | null {
    if (!this.store || typeof this.store.getLaunch !== "function") return null;
    try {
      return this.store.getLaunch(profileId);
    } catch {
      return null;
    }
  }

  private safeGetProfile(profileId: string) {
    if (!this.store || typeof this.store.getProfile !== "function") return null;
    try {
      return this.store.getProfile(profileId);
    } catch {
      return null;
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private syncTimer(): void {
    if (this.closed || this.subscribers.size === 0) {
      this.stopTimer();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.intervalMs);
  }

  private tick(): void {
    if (this.closed || this.subscribers.size === 0) return;
    let snap: MetricsSnapshot;
    try {
      snap = this.snapshot();
    } catch (error) {
      this.log(`metrics sampling tick failed: ${error instanceof Error ? error.message : String(error)}`);
      this.syncTimer();
      return;
    }
    for (const listener of [...this.subscribers]) {
      try {
        listener(snap);
      } catch (error) {
        this.log(`metrics subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.syncTimer();
  }
}
