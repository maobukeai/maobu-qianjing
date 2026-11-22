import { describe, expect, test } from "bun:test";
import {
  classifyLifecycleRequest,
  dispatchWithLifecycleAdmission,
  LifecycleAdmissionController,
  LifecycleAdmissionError,
} from "../../lifecycle-admission.ts";
import { MemoryWatermarkGuard } from "./memory-watermark-guard.ts";
import type { HostMemoryMetrics } from "./process-metrics.ts";

const GIB = 1024 ** 3;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function hostMem(loadPercent: number, availGib: number): HostMemoryMetrics {
  const totalBytes = 16 * GIB;
  const availableBytes = Math.round(availGib * GIB);
  return {
    totalBytes,
    availableBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes),
    memoryLoadPercent: loadPercent,
  };
}

describe("MemoryWatermarkGuard", () => {
  test("classifies normal, elevated, high, and critical by load percent and available memory", () => {
    let mem = hostMem(55, 6);
    const guard = new MemoryWatermarkGuard({ readHostMemory: () => mem });

    expect(guard.evaluate(7)).toMatchObject({
      level: "normal",
      effectiveStartLimit: 4,
      recommendedConcurrency: 4,
      startDelayMs: 0,
      paused: false,
    });

    mem = hostMem(78, 4);
    expect(guard.evaluate(7)).toMatchObject({
      level: "elevated",
      effectiveStartLimit: 2,
      recommendedConcurrency: 2,
      startDelayMs: 1500,
      paused: false,
    });

    mem = hostMem(50, 2.0); // < 2.5GB triggers elevated
    expect(guard.evaluate(7).level).toBe("elevated");

    mem = hostMem(86, 3);
    expect(guard.evaluate(7)).toMatchObject({
      level: "high",
      effectiveStartLimit: 1,
      recommendedConcurrency: 1,
      paused: false,
    });

    mem = hostMem(50, 1.2); // < 1.5GB triggers high
    expect(guard.evaluate(7).level).toBe("high");

    mem = hostMem(92, 3);
    expect(guard.evaluate(7)).toMatchObject({
      level: "critical",
      effectiveStartLimit: 0,
      recommendedConcurrency: 0,
      paused: true,
    });

    mem = hostMem(60, 0.8); // < 1GB triggers critical
    expect(guard.evaluate(7).level).toBe("critical");
  });

  test("respects BatchLaunchMemoryGuardSettings enabled toggle and custom thresholds", () => {
    let mem = hostMem(95, 0.5);
    let enabled = false;
    const guard = new MemoryWatermarkGuard({
      readHostMemory: () => mem,
      getSettings: () => ({
        enabled,
        softWatermarkPercent: 70,
        hardWatermarkPercent: 85,
        minAvailableMb: 2048,
      }),
    });

    expect(guard.evaluate(7)).toMatchObject({ level: "normal", effectiveStartLimit: 4, paused: false });

    enabled = true;
    mem = hostMem(85, 4);
    expect(guard.evaluate(7).level).toBe("critical");

    mem = hostMem(72, 4);
    expect(guard.evaluate(7).level).toBe("elevated");
  });
});

describe("LifecycleAdmissionController with MemoryWatermarkGuard", () => {
  test("elevated level caps concurrent starts at 2 and enforces launch pacing", async () => {
    const guard = new MemoryWatermarkGuard({
      readHostMemory: () => hostMem(80, 4),
      elevatedStartDelayMs: 40,
    });
    const admission = new LifecycleAdmissionController({ limit: 8, queueWaitMs: 5_000, memoryGuard: guard });
    const startTimes: number[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const runs = gates.map((gate, i) =>
      admission.run({ kind: "start", profileIds: [`p${i}`] }, async () => {
        startTimes.push(Date.now());
        await gate.promise;
      }),
    );

    await tick();
    // First start admitted immediately, second paced by elevatedStartDelayMs
    expect(startTimes).toHaveLength(1);
    await Bun.sleep(60);
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(25);
    // Third remains queued because elevated limit is 2
    await Bun.sleep(60);
    expect(startTimes).toHaveLength(2);

    gates[0]!.resolve();
    await Bun.sleep(60);
    expect(startTimes).toHaveLength(3);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(runs);
  });

  test("high level serializes starts to concurrency 1", async () => {
    const guard = new MemoryWatermarkGuard({ readHostMemory: () => hostMem(87, 3) });
    const admission = new LifecycleAdmissionController({ limit: 8, queueWaitMs: 2_000, memoryGuard: guard });
    let active = 0;
    let peak = 0;
    await Promise.all(
      ["a", "b", "c", "d"].map((id) =>
        admission.run({ kind: "start", profileIds: [id] }, async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(10);
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  test("critical level pauses starts without ever throttling stop/cleanup and resumes on recovery", async () => {
    let mem = hostMem(94, 0.7);
    const guard = new MemoryWatermarkGuard({
      readHostMemory: () => mem,
      criticalWaitTimeoutMs: 500,
      pollIntervalMs: 20,
    });
    const admission = new LifecycleAdmissionController({ limit: 8, queueWaitMs: 2_000, memoryGuard: guard });

    let startDispatched = false;
    const startTask = admission.run({ kind: "start", profileIds: ["s1"] }, async () => {
      startDispatched = true;
    });
    await tick();
    expect(startDispatched).toBe(false);

    // Stop and cleanup MUST dispatch immediately even under critical watermark
    let stopDispatched = false;
    let cleanupDispatched = false;
    await admission.run({ kind: "stop", profileIds: ["t1"] }, async () => {
      stopDispatched = true;
    });
    await admission.run({ kind: "cleanup", profileIds: ["c1"] }, async () => {
      cleanupDispatched = true;
    });
    expect(stopDispatched).toBe(true);
    expect(cleanupDispatched).toBe(true);
    expect(startDispatched).toBe(false);

    // Memory recovers -> queued start automatically resumes
    mem = hostMem(60, 6);
    await startTask;
    expect(startDispatched).toBe(true);
  });

  test("critical timeout rejects with memory_watermark_exceeded and HTTP 503 payload", async () => {
    const mem = hostMem(93, 0.6);
    const guard = new MemoryWatermarkGuard({
      readHostMemory: () => mem,
      criticalWaitTimeoutMs: 45,
      pollIntervalMs: 15,
    });
    const admission = new LifecycleAdmissionController({ limit: 8, queueWaitMs: 2_000, memoryGuard: guard });

    let err: unknown;
    try {
      await admission.run({ kind: "start", profileIds: ["s-timeout"] }, () => "never");
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(LifecycleAdmissionError);
    expect((err as LifecycleAdmissionError).reason).toBe("memory_watermark_exceeded");
    expect((err as LifecycleAdmissionError).memoryLoadPercent).toBe(93);
    expect((err as LifecycleAdmissionError).availableMemoryBytes).toBe(mem.availableBytes);

    // HTTP UI route returns 503 with exact contract
    let dispatched = false;
    const uiRes = await dispatchWithLifecycleAdmission(
      new Request("http://127.0.0.1/ui/api/profiles/p1/open", { method: "POST" }),
      admission,
      async () => {
        dispatched = true;
        return Response.json({ ok: true });
      },
    );
    expect(dispatched).toBe(false);
    expect(uiRes.status).toBe(503);
    expect(await uiRes.json()).toMatchObject({
      ok: false,
      code: "memory_watermark_exceeded",
      memoryLoadPercent: 93,
      availableMemoryBytes: mem.availableBytes,
    });

    // AdsPower route preserves HTTP 200 envelope with error code
    const adsRes = await dispatchWithLifecycleAdmission(
      new Request("http://127.0.0.1/api/v1/browser/start?user_id=p1"),
      admission,
      async () => Response.json({ code: 0 }),
    );
    expect(adsRes.status).toBe(200);
    expect(await adsRes.json()).toMatchObject({
      code: -1,
      data: {
        code: "memory_watermark_exceeded",
        memoryLoadPercent: 93,
        availableMemoryBytes: mem.availableBytes,
      },
    });
  });

  test("classifyLifecycleRequest classifies hibernate as stop so critical memory never blocks it", async () => {
    const classified = await classifyLifecycleRequest(
      new Request("http://127.0.0.1/ui/api/profiles/p1/hibernate", { method: "POST" }),
    );
    expect(classified).toEqual({ kind: "stop", profileIds: ["p1"], protocol: "ui" });
  });
});
