import {
  DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS,
  type BatchLaunchMemoryGuardSettings,
} from "../../app-settings.ts";
import {
  createNativeProcessMetricsBackend,
  type HostMemoryMetrics,
} from "./process-metrics.ts";

export type MemoryWatermarkLevel = "normal" | "elevated" | "high" | "critical";

export interface MemoryWatermarkStatus {
  level: MemoryWatermarkLevel;
  recommendedConcurrency: number;
  effectiveStartLimit: number;
  startDelayMs: number;
  memoryLoadPercent: number;
  availableBytes: number;
  paused: boolean;
  reason?: string;
}

export interface MemoryWatermarkThresholds {
  elevatedPercent: number;
  highPercent: number;
  criticalPercent: number;
  elevatedAvailableBytes: number;
  highAvailableBytes: number;
  criticalAvailableBytes: number;
}

export interface MemoryWatermarkGuardOptions {
  readHostMemory?: () => HostMemoryMetrics;
  getSettings?: () => BatchLaunchMemoryGuardSettings;
  thresholds?: Partial<MemoryWatermarkThresholds>;
  normalMaxStartConcurrency?: number;
  elevatedMaxStartConcurrency?: number;
  highMaxStartConcurrency?: number;
  elevatedStartDelayMs?: number;
  criticalWaitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Interface consumed by LifecycleAdmissionController without creating circular imports. */
export interface MemoryWatermarkAdmissionPolicy {
  readonly criticalWaitTimeoutMs: number;
  readonly pollIntervalMs: number;
  evaluate(baseStartLimit: number): MemoryWatermarkStatus;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const DEFAULT_WATERMARK_THRESHOLDS: Readonly<MemoryWatermarkThresholds> = Object.freeze({
  elevatedPercent: 75,
  highPercent: 85,
  criticalPercent: 90,
  elevatedAvailableBytes: Math.round(2.5 * GIB),
  highAvailableBytes: Math.round(1.5 * GIB),
  criticalAvailableBytes: 1 * GIB,
});

export function thresholdsFromGuardSettings(
  settings: BatchLaunchMemoryGuardSettings,
): MemoryWatermarkThresholds {
  const elevatedPercent = Math.max(30, Math.min(95, settings.softWatermarkPercent));
  const criticalPercent = Math.max(elevatedPercent + 1, Math.min(99, settings.hardWatermarkPercent));
  const highPercent = Math.max(
    elevatedPercent + 1,
    Math.min(criticalPercent - 1, Math.round(elevatedPercent + (criticalPercent - elevatedPercent) * 0.67)),
  );
  const highAvailableBytes = Math.max(128, settings.minAvailableMb) * MIB;
  const elevatedAvailableBytes = Math.round(highAvailableBytes * (5 / 3));
  const criticalAvailableBytes = Math.round(highAvailableBytes * (2 / 3));
  return {
    elevatedPercent,
    highPercent,
    criticalPercent,
    elevatedAvailableBytes,
    highAvailableBytes,
    criticalAvailableBytes,
  };
}

export class MemoryWatermarkGuard implements MemoryWatermarkAdmissionPolicy {
  private readonly readHostMemoryFn: () => HostMemoryMetrics;
  private readonly getSettingsFn?: () => BatchLaunchMemoryGuardSettings;
  private readonly customThresholds?: Partial<MemoryWatermarkThresholds>;
  private readonly normalMaxStartConcurrency: number;
  private readonly elevatedMaxStartConcurrency: number;
  private readonly highMaxStartConcurrency: number;
  private readonly elevatedStartDelayMs: number;
  readonly criticalWaitTimeoutMs: number;
  readonly pollIntervalMs: number;

  constructor(options: MemoryWatermarkGuardOptions = {}) {
    if (options.readHostMemory) {
      this.readHostMemoryFn = options.readHostMemory;
    } else {
      const backend = createNativeProcessMetricsBackend();
      this.readHostMemoryFn = () => backend.readHostMemory();
    }
    this.getSettingsFn = options.getSettings;
    this.customThresholds = options.thresholds;
    this.normalMaxStartConcurrency = Math.max(1, options.normalMaxStartConcurrency ?? 4);
    this.elevatedMaxStartConcurrency = Math.max(1, options.elevatedMaxStartConcurrency ?? 2);
    this.highMaxStartConcurrency = Math.max(1, options.highMaxStartConcurrency ?? 1);
    this.elevatedStartDelayMs = Math.max(0, options.elevatedStartDelayMs ?? 1_500);
    this.criticalWaitTimeoutMs = Math.max(1, options.criticalWaitTimeoutMs ?? 30_000);
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 500);
  }

  private resolveSettings(): { enabled: boolean; thresholds: MemoryWatermarkThresholds } {
    let settings: BatchLaunchMemoryGuardSettings | null = null;
    if (this.getSettingsFn) {
      try {
        settings = this.getSettingsFn();
      } catch {
        settings = { ...DEFAULT_BATCH_LAUNCH_MEMORY_GUARD_SETTINGS };
      }
    }
    if (settings && !settings.enabled) {
      return { enabled: false, thresholds: { ...DEFAULT_WATERMARK_THRESHOLDS, ...this.customThresholds } };
    }
    const base = settings ? thresholdsFromGuardSettings(settings) : DEFAULT_WATERMARK_THRESHOLDS;
    return {
      enabled: true,
      thresholds: { ...base, ...this.customThresholds },
    };
  }

  evaluate(baseStartLimit = this.normalMaxStartConcurrency, hostMemory?: HostMemoryMetrics): MemoryWatermarkStatus {
    const cap = Math.max(1, Math.trunc(baseStartLimit));
    const mem = hostMemory ?? this.readHostMemoryFn();
    const memoryLoadPercent = Number.isFinite(mem.memoryLoadPercent)
      ? Math.max(0, Math.min(100, mem.memoryLoadPercent))
      : 0;
    const availableBytes = Number.isFinite(mem.availableBytes) && mem.availableBytes >= 0 ? mem.availableBytes : 0;

    const { enabled, thresholds } = this.resolveSettings();
    const normalLimit = Math.min(cap, this.normalMaxStartConcurrency);
    if (!enabled) {
      return {
        level: "normal",
        recommendedConcurrency: normalLimit,
        effectiveStartLimit: normalLimit,
        startDelayMs: 0,
        memoryLoadPercent,
        availableBytes,
        paused: false,
      };
    }

    if (memoryLoadPercent >= thresholds.criticalPercent || availableBytes < thresholds.criticalAvailableBytes) {
      const availMb = Math.round(availableBytes / MIB);
      return {
        level: "critical",
        recommendedConcurrency: 0,
        effectiveStartLimit: 0,
        startDelayMs: 0,
        memoryLoadPercent,
        availableBytes,
        paused: true,
        reason: `Host memory critical (${memoryLoadPercent}% used, ${availMb} MiB available)`,
      };
    }

    if (memoryLoadPercent >= thresholds.highPercent || availableBytes < thresholds.highAvailableBytes) {
      const highLimit = Math.min(cap, this.highMaxStartConcurrency);
      const availMb = Math.round(availableBytes / MIB);
      return {
        level: "high",
        recommendedConcurrency: highLimit,
        effectiveStartLimit: highLimit,
        startDelayMs: 0,
        memoryLoadPercent,
        availableBytes,
        paused: false,
        reason: `Host memory high (${memoryLoadPercent}% used, ${availMb} MiB available); serializing launches`,
      };
    }

    if (memoryLoadPercent >= thresholds.elevatedPercent || availableBytes < thresholds.elevatedAvailableBytes) {
      const elevatedLimit = Math.min(cap, this.elevatedMaxStartConcurrency);
      const availMb = Math.round(availableBytes / MIB);
      return {
        level: "elevated",
        recommendedConcurrency: elevatedLimit,
        effectiveStartLimit: elevatedLimit,
        startDelayMs: this.elevatedStartDelayMs,
        memoryLoadPercent,
        availableBytes,
        paused: false,
        reason: `Host memory elevated (${memoryLoadPercent}% used, ${availMb} MiB available); throttling batch launches`,
      };
    }

    return {
      level: "normal",
      recommendedConcurrency: normalLimit,
      effectiveStartLimit: normalLimit,
      startDelayMs: 0,
      memoryLoadPercent,
      availableBytes,
      paused: false,
    };
  }
}
