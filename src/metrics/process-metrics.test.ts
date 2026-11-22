import { describe, expect, test } from "bun:test";
import {
  collectProcessTreePids,
  createNativeProcessMetricsBackend,
  parseFiletime100ns,
  parseLinuxMeminfo,
  parseLinuxProcStat,
  parseMacPsOutput,
  parseMemoryStatusEx,
  parseProcessMemoryCountersEx,
  ProcessTreeMetricsCollector,
  type HostMemoryMetrics,
  type ProcessEdge,
  type ProcessMetricsBackend,
  type RawProcessStats,
} from "./process-metrics.ts";

describe("process-metrics parsers and tree helpers", () => {
  test("parses x64 PROCESS_MEMORY_COUNTERS_EX, MEMORYSTATUSEX, and FILETIME buffers", () => {
    const pmc = new Uint8Array(80);
    const pmcView = new DataView(pmc.buffer);
    pmcView.setUint32(0, 80, true);
    pmcView.setBigUint64(16, 128n * 1024n * 1024n, true);
    pmcView.setBigUint64(72, 96n * 1024n * 1024n, true);
    expect(parseProcessMemoryCountersEx(pmc)).toEqual({
      rssBytes: 128 * 1024 * 1024,
      privateBytes: 96 * 1024 * 1024,
    });

    const ms = new Uint8Array(64);
    const msView = new DataView(ms.buffer);
    msView.setUint32(0, 64, true);
    msView.setUint32(4, 68, true);
    msView.setBigUint64(8, 16n * 1024n ** 3n, true);
    msView.setBigUint64(16, 5n * 1024n ** 3n, true);
    expect(parseMemoryStatusEx(ms)).toEqual({
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 5 * 1024 ** 3,
      usedBytes: 11 * 1024 ** 3,
      memoryLoadPercent: 68,
    });

    const ft = new Uint8Array(8);
    new DataView(ft.buffer).setBigUint64(0, 123_456_789_000n, true);
    expect(parseFiletime100ns(ft)).toBe(123_456_789_000n);
  });

  test("parses Linux /proc/meminfo, /proc/<pid>/stat with parens, and macOS ps output", () => {
    const mem = parseLinuxMeminfo(
      "MemTotal:       16384000 kB\nMemFree:         2000000 kB\nMemAvailable:    4096000 kB\n",
    );
    expect(mem).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 4096000 * 1024,
      usedBytes: (16384000 - 4096000) * 1024,
      memoryLoadPercent: 75,
    });

    const stat = parseLinuxProcStat(
      "4242 (Web Content (1)) S 1000 4242 1000 0 -1 4194304 1 0 0 0 150 50 0 0 20 0 8 0 987654 0 0",
    );
    expect(stat).toEqual({
      pid: 4242,
      parentPid: 1000,
      cpuTicks: 200n,
      startTimeTicks: 987654n,
    });

    const mac = parseMacPsOutput("  100 1 20480 12.5\n  101 100 10240 4.0\n");
    expect(mac.get(100)).toEqual({ pid: 100, parentPid: 1, rssBytes: 20480 * 1024, cpuPercent: 12.5 });
    expect(mac.get(101)).toEqual({ pid: 101, parentPid: 100, rssBytes: 10240 * 1024, cpuPercent: 4.0 });
  });

  test("collectProcessTreePids walks descendants up to maxDepth and guards against cycles", () => {
    const edges: ProcessEdge[] = [
      { pid: 100, parentPid: 1 },
      { pid: 101, parentPid: 100 },
      { pid: 102, parentPid: 100 },
      { pid: 103, parentPid: 101 },
      { pid: 104, parentPid: 103 },
      { pid: 200, parentPid: 1 },
      // Cycle
      { pid: 100, parentPid: 104 },
    ];
    expect(collectProcessTreePids(100, edges, 2)).toEqual([100, 101, 102, 103]);
    expect(collectProcessTreePids(100, edges, 8)).toEqual([100, 101, 102, 103, 104]);
    expect(collectProcessTreePids(999, edges)).toEqual([]);
  });
});

describe("ProcessTreeMetricsCollector", () => {
  test("aggregates RSS/private memory, computes CPU% deltas, ignores PID-reused children, and trims working sets", () => {
    let clockMs = 1_000;
    const host: HostMemoryMetrics = {
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      memoryLoadPercent: 50,
    };
    const edges: ProcessEdge[] = [
      { pid: 1000, parentPid: 1 },
      { pid: 1001, parentPid: 1000 },
      { pid: 1002, parentPid: 1000 }, // reused PID older than root -> must be skipped
    ];
    const stats = new Map<number, RawProcessStats>([
      [1000, { pid: 1000, rssBytes: 100_000_000, privateBytes: 80_000_000, cpuTime100ns: 10_000_000n, creationTime100ns: 500n }],
      [1001, { pid: 1001, rssBytes: 50_000_000, privateBytes: 40_000_000, cpuTime100ns: 5_000_000n, creationTime100ns: 600n }],
      [1002, { pid: 1002, rssBytes: 999_000_000, privateBytes: 999_000_000, cpuTime100ns: 1_000_000n, creationTime100ns: 100n }],
    ]);
    const trimmedPids: number[] = [];
    const backend: ProcessMetricsBackend = {
      supportsWorkingSetTrim: true,
      cpuCount: () => 4,
      readHostMemory: () => host,
      listProcessEdges: () => edges,
      readProcessStats: (pid) => stats.get(pid) ?? null,
      emptyWorkingSet: (pid) => {
        trimmedPids.push(pid);
        const cur = stats.get(pid);
        if (cur) {
          stats.set(pid, { ...cur, rssBytes: Math.round(cur.rssBytes * 0.6) });
        }
        return true;
      },
    };

    const collector = new ProcessTreeMetricsCollector({ backend, now: () => clockMs });

    // Tick 1: baseline CPU = 0, PID 1002 skipped due to earlier creationTime
    const first = collector.sampleTrees([1000]);
    expect(first.host).toEqual(host);
    expect(first.trees.get(1000)).toEqual({
      rootPid: 1000,
      pids: [1000, 1001],
      processCount: 2,
      rssBytes: 150_000_000,
      privateBytes: 120_000_000,
      cpuPercent: 0,
    });

    // Tick 2 (+1000ms): +1000ms total CPU across 4 cores = 25.0%
    clockMs += 1_000;
    stats.set(1000, { ...stats.get(1000)!, cpuTime100ns: 16_000_000n }); // +600ms
    stats.set(1001, { ...stats.get(1001)!, cpuTime100ns: 9_000_000n }); // +400ms
    const second = collector.sampleTrees([1000]);
    expect(second.trees.get(1000)?.cpuPercent).toBe(25);

    // Trim working set skips PID 1002 and reclaims 40% of 150MB = 60MB
    const trim = collector.trimProcessTreeWorkingSet(1000);
    expect(trimmedPids).toEqual([1000, 1001]);
    expect(trim).toEqual({
      rootPid: 1000,
      supported: true,
      processCount: 2,
      trimmedProcesses: 2,
      beforeRssBytes: 150_000_000,
      afterRssBytes: 90_000_000,
      reclaimedBytes: 60_000_000,
    });
  });

  if (process.platform === "win32") {
    test("real Windows bun:ffi backend reads host memory and current Bun process tree in < 50ms", () => {
      const collector = new ProcessTreeMetricsCollector({
        backend: createNativeProcessMetricsBackend("win32"),
      });
      const sampled = collector.sampleTrees([process.pid]);
      expect(sampled.host.totalBytes).toBeGreaterThan(512 * 1024 * 1024);
      expect(sampled.host.availableBytes).toBeGreaterThan(0);
      expect(sampled.host.memoryLoadPercent).toBeGreaterThanOrEqual(0);
      expect(sampled.host.memoryLoadPercent).toBeLessThanOrEqual(100);

      const selfTree = sampled.trees.get(process.pid);
      expect(selfTree).toBeDefined();
      expect(selfTree!.processCount).toBeGreaterThanOrEqual(1);
      expect(selfTree!.rssBytes).toBeGreaterThan(1024 * 1024);
      expect(selfTree!.privateBytes).toBeGreaterThan(0);
      expect(sampled.durationMs).toBeLessThan(50);
    });
  }
});
