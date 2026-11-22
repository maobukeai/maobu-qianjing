import { readdirSync, readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { dlopen } from "bun:ffi";
import { parseWindowsProcessEntry } from "../launcher/windows-tasks.ts";

export interface HostMemoryMetrics {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  memoryLoadPercent: number;
}

export interface ProcessEdge {
  pid: number;
  parentPid: number;
}

export interface RawProcessStats {
  pid: number;
  rssBytes: number;
  privateBytes: number;
  /** Cumulative kernel + user CPU time in 100-nanosecond ticks (or null if unavailable). */
  cpuTime100ns: bigint | null;
  /** Process creation timestamp in 100ns ticks (or 0n if unavailable), used to guard against PID reuse. */
  creationTime100ns: bigint;
  /** Direct CPU percent when provided by fallback OS tools like macOS ps. */
  directCpuPercent?: number;
}

export interface ProcessTreeSample {
  rootPid: number;
  pids: number[];
  processCount: number;
  rssBytes: number;
  privateBytes: number;
  cpuPercent: number;
}

export interface TrimWorkingSetResult {
  rootPid: number;
  supported: boolean;
  processCount: number;
  trimmedProcesses: number;
  beforeRssBytes: number;
  afterRssBytes: number;
  reclaimedBytes: number;
}

export interface ProcessMetricsBackend {
  readHostMemory(): HostMemoryMetrics;
  listProcessEdges(): ProcessEdge[];
  readProcessStats(pid: number): RawProcessStats | null;
  emptyWorkingSet?(pid: number): boolean;
  supportsWorkingSetTrim?: boolean;
  cpuCount?(): number;
}

export const MAX_PROCESS_TREE_DEPTH = 8;

// 64-bit Win32 struct sizes & constants
const WINDOWS_PROCESS_ENTRY_SIZE = 568; // PROCESSENTRY32W
const WINDOWS_PROCESS_MEMORY_COUNTERS_EX_SIZE = 80; // PROCESS_MEMORY_COUNTERS_EX on x64
const WINDOWS_MEMORY_STATUS_EX_SIZE = 64; // MEMORYSTATUSEX on x64
const WINDOWS_INVALID_HANDLE = 0xFFFF_FFFF_FFFF_FFFFn;
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_SET_QUOTA = 0x0100;

const winEntryBuf = new Uint8Array(WINDOWS_PROCESS_ENTRY_SIZE);
const winMemCountersBuf = new Uint8Array(WINDOWS_PROCESS_MEMORY_COUNTERS_EX_SIZE);
const winMemStatusBuf = new Uint8Array(WINDOWS_MEMORY_STATUS_EX_SIZE);
const winCreationFt = new Uint8Array(8);
const winExitFt = new Uint8Array(8);
const winKernelFt = new Uint8Array(8);
const winUserFt = new Uint8Array(8);

const windowsMetricsApi = process.platform === "win32"
  ? (() => {
      try {
        return dlopen("kernel32.dll", {
          CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
          Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
          Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
          OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
          CloseHandle: { args: ["u64"], returns: "i32" },
          K32GetProcessMemoryInfo: { args: ["u64", "ptr", "u32"], returns: "i32" },
          K32EmptyWorkingSet: { args: ["u64"], returns: "i32" },
          GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
          GlobalMemoryStatusEx: { args: ["ptr"], returns: "i32" },
        }).symbols;
      } catch {
        return null;
      }
    })()
  : null;

/** Decode WorkingSetSize (RSS) and PrivateUsage from a 64-bit PROCESS_MEMORY_COUNTERS_EX buffer. */
export function parseProcessMemoryCountersEx(buf: Uint8Array): { rssBytes: number; privateBytes: number } {
  if (buf.byteLength < WINDOWS_PROCESS_MEMORY_COUNTERS_EX_SIZE) {
    throw new RangeError("PROCESS_MEMORY_COUNTERS_EX buffer must be at least 80 bytes");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rssBytes = Number(view.getBigUint64(16, true));
  const privateBytes = Number(view.getBigUint64(72, true));
  return {
    rssBytes: Number.isFinite(rssBytes) && rssBytes >= 0 ? rssBytes : 0,
    privateBytes: Number.isFinite(privateBytes) && privateBytes >= 0 ? privateBytes : 0,
  };
}

/** Decode host physical memory metrics from a 64-bit MEMORYSTATUSEX buffer. */
export function parseMemoryStatusEx(buf: Uint8Array): HostMemoryMetrics {
  if (buf.byteLength < WINDOWS_MEMORY_STATUS_EX_SIZE) {
    throw new RangeError("MEMORYSTATUSEX buffer must be at least 64 bytes");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const memoryLoadPercent = Math.max(0, Math.min(100, view.getUint32(4, true)));
  const totalBytes = Number(view.getBigUint64(8, true));
  const availableBytes = Number(view.getBigUint64(16, true));
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { totalBytes, availableBytes, usedBytes, memoryLoadPercent };
}

/** Decode a Win32 FILETIME (two little-endian DWORDs) into 100-nanosecond ticks. */
export function parseFiletime100ns(buf: Uint8Array): bigint {
  if (buf.byteLength < 8) throw new RangeError("FILETIME buffer must be at least 8 bytes");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigUint64(0, true);
}

/** Breadth-first descendant lookup bounded by maxDepth with cycle protection. */
export function collectProcessTreePids(
  rootPid: number,
  edges: readonly ProcessEdge[],
  maxDepth = MAX_PROCESS_TREE_DEPTH,
): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const present = new Set<number>();
  const children = new Map<number, number[]>();
  for (const edge of edges) {
    if (!Number.isInteger(edge.pid) || edge.pid <= 0) continue;
    present.add(edge.pid);
    if (edge.parentPid > 0 && edge.parentPid !== edge.pid) {
      let list = children.get(edge.parentPid);
      if (!list) {
        list = [];
        children.set(edge.parentPid, list);
      }
      list.push(edge.pid);
    }
  }
  if (!present.has(rootPid)) return [];

  const visited = new Set<number>([rootPid]);
  const ordered: number[] = [rootPid];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const kids = children.get(current.pid);
    if (!kids) continue;
    for (const childPid of kids) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      ordered.push(childPid);
      queue.push({ pid: childPid, depth: current.depth + 1 });
    }
  }
  return ordered;
}

function fallbackHostMemory(): HostMemoryMetrics {
  const totalBytes = totalmem();
  const availableBytes = freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const memoryLoadPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return { totalBytes, availableBytes, usedBytes, memoryLoadPercent };
}

function createWindowsBackend(): ProcessMetricsBackend {
  return {
    supportsWorkingSetTrim: !!windowsMetricsApi,
    cpuCount: () => Math.max(1, cpus().length),
    readHostMemory(): HostMemoryMetrics {
      if (!windowsMetricsApi) return fallbackHostMemory();
      const view = new DataView(winMemStatusBuf.buffer, winMemStatusBuf.byteOffset, winMemStatusBuf.byteLength);
      winMemStatusBuf.fill(0);
      view.setUint32(0, WINDOWS_MEMORY_STATUS_EX_SIZE, true);
      if (!windowsMetricsApi.GlobalMemoryStatusEx(winMemStatusBuf)) {
        return fallbackHostMemory();
      }
      return parseMemoryStatusEx(winMemStatusBuf);
    },
    listProcessEdges(): ProcessEdge[] {
      if (!windowsMetricsApi) return [];
      const snapshot = windowsMetricsApi.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as bigint;
      if (snapshot === 0n || snapshot === WINDOWS_INVALID_HANDLE) return [];
      const view = new DataView(winEntryBuf.buffer, winEntryBuf.byteOffset, winEntryBuf.byteLength);
      view.setUint32(0, WINDOWS_PROCESS_ENTRY_SIZE, true);
      const edges: ProcessEdge[] = [];
      try {
        for (
          let more = windowsMetricsApi.Process32FirstW(snapshot, winEntryBuf);
          more;
          more = windowsMetricsApi.Process32NextW(snapshot, winEntryBuf)
        ) {
          const parsed = parseWindowsProcessEntry(winEntryBuf);
          if (parsed.pid > 0) {
            edges.push({ pid: parsed.pid, parentPid: parsed.parentPid });
          }
        }
      } finally {
        windowsMetricsApi.CloseHandle(snapshot);
      }
      return edges;
    },
    readProcessStats(pid: number): RawProcessStats | null {
      if (!windowsMetricsApi || !Number.isInteger(pid) || pid <= 0) return null;
      const handle = windowsMetricsApi.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as bigint;
      if (handle === 0n || handle === WINDOWS_INVALID_HANDLE) return null;
      try {
        let rssBytes = 0;
        let privateBytes = 0;
        winMemCountersBuf.fill(0);
        new DataView(winMemCountersBuf.buffer).setUint32(0, WINDOWS_PROCESS_MEMORY_COUNTERS_EX_SIZE, true);
        if (windowsMetricsApi.K32GetProcessMemoryInfo(handle, winMemCountersBuf, WINDOWS_PROCESS_MEMORY_COUNTERS_EX_SIZE)) {
          const parsed = parseProcessMemoryCountersEx(winMemCountersBuf);
          rssBytes = parsed.rssBytes;
          privateBytes = parsed.privateBytes;
        }

        let cpuTime100ns: bigint | null = null;
        let creationTime100ns = 0n;
        winCreationFt.fill(0);
        winExitFt.fill(0);
        winKernelFt.fill(0);
        winUserFt.fill(0);
        if (windowsMetricsApi.GetProcessTimes(handle, winCreationFt, winExitFt, winKernelFt, winUserFt)) {
          creationTime100ns = parseFiletime100ns(winCreationFt);
          cpuTime100ns = parseFiletime100ns(winKernelFt) + parseFiletime100ns(winUserFt);
        }

        return { pid, rssBytes, privateBytes, cpuTime100ns, creationTime100ns };
      } finally {
        windowsMetricsApi.CloseHandle(handle);
      }
    },
    emptyWorkingSet(pid: number): boolean {
      if (!windowsMetricsApi || !Number.isInteger(pid) || pid <= 0) return false;
      const handle = windowsMetricsApi.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA,
        0,
        pid,
      ) as bigint;
      if (handle === 0n || handle === WINDOWS_INVALID_HANDLE) return false;
      try {
        return windowsMetricsApi.K32EmptyWorkingSet(handle) !== 0;
      } finally {
        windowsMetricsApi.CloseHandle(handle);
      }
    },
  };
}

/** Parse /proc/meminfo on Linux. Exported for cross-platform unit tests. */
export function parseLinuxMeminfo(raw: string): HostMemoryMetrics | null {
  let totalKb: number | null = null;
  let availKb: number | null = null;
  let freeKb: number | null = null;
  for (const line of raw.split("\n")) {
    const match = line.match(/^(MemTotal|MemAvailable|MemFree):\s+(\d+)\s+kB/);
    if (!match) continue;
    const kb = Number(match[2]);
    if (match[1] === "MemTotal") totalKb = kb;
    else if (match[1] === "MemAvailable") availKb = kb;
    else if (match[1] === "MemFree") freeKb = kb;
  }
  if (totalKb === null || totalKb <= 0) return null;
  const availableBytes = (availKb ?? freeKb ?? 0) * 1024;
  const totalBytes = totalKb * 1024;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const memoryLoadPercent = Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100)));
  return { totalBytes, availableBytes, usedBytes, memoryLoadPercent };
}

/** Parse /proc/<pid>/stat fields safely (handles process names containing spaces or parentheses). */
export function parseLinuxProcStat(raw: string): {
  pid: number;
  parentPid: number;
  cpuTicks: bigint;
  startTimeTicks: bigint;
} | null {
  const closeParen = raw.lastIndexOf(")");
  const openParen = raw.indexOf("(");
  if (openParen < 0 || closeParen <= openParen) return null;
  const pid = Number(raw.slice(0, openParen).trim());
  const rest = raw.slice(closeParen + 2).trim().split(/\s+/);
  // After ')': index 0=state(3), 1=ppid(4), 11=utime(14), 12=stime(15), 19=starttime(22)
  if (!Number.isInteger(pid) || pid <= 0 || rest.length < 20) return null;
  const parentPid = Number(rest[1]);
  const utime = BigInt(rest[11] ?? "0");
  const stime = BigInt(rest[12] ?? "0");
  const startTimeTicks = BigInt(rest[19] ?? "0");
  if (!Number.isInteger(parentPid) || parentPid < 0) return null;
  return { pid, parentPid, cpuTicks: utime + stime, startTimeTicks };
}

function createLinuxBackend(): ProcessMetricsBackend {
  const pageSize = 4096;
  // Standard Linux USER_HZ is 100 ticks/sec -> 1 tick = 10ms = 100_000 * 100ns
  const tickTo100ns = 100_000n;
  return {
    supportsWorkingSetTrim: false,
    cpuCount: () => Math.max(1, cpus().length),
    readHostMemory(): HostMemoryMetrics {
      try {
        const parsed = parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf8"));
        if (parsed) return parsed;
      } catch {}
      return fallbackHostMemory();
    },
    listProcessEdges(): ProcessEdge[] {
      const edges: ProcessEdge[] = [];
      let entries: string[];
      try {
        entries = readdirSync("/proc");
      } catch {
        return edges;
      }
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = parseLinuxProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
          if (stat) edges.push({ pid: stat.pid, parentPid: stat.parentPid });
        } catch {
          // Process exited between readdir and stat read.
        }
      }
      return edges;
    },
    readProcessStats(pid: number): RawProcessStats | null {
      try {
        const stat = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
        if (!stat) return null;
        const statm = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
        const residentPages = Number(statm[1] ?? 0);
        const sharedPages = Number(statm[2] ?? 0);
        const rssBytes = Math.max(0, residentPages * pageSize);
        const privateBytes = Math.max(0, (residentPages - sharedPages) * pageSize);
        return {
          pid,
          rssBytes,
          privateBytes,
          cpuTime100ns: stat.cpuTicks * tickTo100ns,
          creationTime100ns: stat.startTimeTicks * tickTo100ns,
        };
      } catch {
        return null;
      }
    },
  };
}

interface MacPsEntry {
  pid: number;
  parentPid: number;
  rssBytes: number;
  cpuPercent: number;
}

/** Parse macOS `ps -axo pid=,ppid=,rss=,%cpu=` output. Exported for unit tests. */
export function parseMacPsOutput(raw: string): Map<number, MacPsEntry> {
  const result = new Map<number, MacPsEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    const cpuPercent = Number(parts[3]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) continue;
    result.set(pid, {
      pid,
      parentPid,
      rssBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      cpuPercent: Number.isFinite(cpuPercent) && cpuPercent >= 0 ? cpuPercent : 0,
    });
  }
  return result;
}

function createMacBackend(): ProcessMetricsBackend {
  let cachedMap = new Map<number, MacPsEntry>();
  return {
    supportsWorkingSetTrim: false,
    cpuCount: () => Math.max(1, cpus().length),
    readHostMemory: fallbackHostMemory,
    listProcessEdges(): ProcessEdge[] {
      try {
        const res = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,%cpu="], { stdout: "pipe", stderr: "ignore" });
        if (res.exitCode !== 0) {
          cachedMap = new Map();
          return [];
        }
        cachedMap = parseMacPsOutput(Buffer.from(res.stdout).toString("utf8"));
        return [...cachedMap.values()].map((e) => ({ pid: e.pid, parentPid: e.parentPid }));
      } catch {
        cachedMap = new Map();
        return [];
      }
    },
    readProcessStats(pid: number): RawProcessStats | null {
      const entry = cachedMap.get(pid);
      if (!entry) return null;
      return {
        pid,
        rssBytes: entry.rssBytes,
        privateBytes: entry.rssBytes,
        cpuTime100ns: null,
        creationTime100ns: 0n,
        directCpuPercent: entry.cpuPercent,
      };
    },
  };
}

export function createNativeProcessMetricsBackend(platform: NodeJS.Platform = process.platform): ProcessMetricsBackend {
  if (platform === "win32") return createWindowsBackend();
  if (platform === "linux") return createLinuxBackend();
  if (platform === "darwin") return createMacBackend();
  return {
    supportsWorkingSetTrim: false,
    cpuCount: () => Math.max(1, cpus().length),
    readHostMemory: fallbackHostMemory,
    listProcessEdges: () => [],
    readProcessStats: () => null,
  };
}

interface PreviousCpuSample {
  tsMs: number;
  cpuTime100ns: bigint;
  creationTime100ns: bigint;
}

/**
 * Stateful, low-overhead process-tree metrics collector.
 * Performs a single host process snapshot per cycle and only opens handles for
 * registered browser root PIDs and their descendants.
 */
export class ProcessTreeMetricsCollector {
  private readonly backend: ProcessMetricsBackend;
  private readonly now: () => number;
  private readonly prevCpu = new Map<number, PreviousCpuSample>();

  constructor(options: { backend?: ProcessMetricsBackend; now?: () => number } = {}) {
    this.backend = options.backend ?? createNativeProcessMetricsBackend();
    this.now = options.now ?? (() => Date.now());
  }

  readHostMemory(): HostMemoryMetrics {
    return this.backend.readHostMemory();
  }

  /** Sample host memory + every requested root PID's process tree in one snapshot pass. */
  sampleTrees(rootPids: readonly number[]): {
    host: HostMemoryMetrics;
    trees: Map<number, ProcessTreeSample>;
    durationMs: number;
  } {
    const start = performance.now();
    const nowMs = this.now();
    const host = this.backend.readHostMemory();
    const trees = new Map<number, ProcessTreeSample>();

    const validRoots = [...new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (validRoots.length === 0) {
      this.prevCpu.clear();
      return { host, trees, durationMs: Math.max(0, Number((performance.now() - start).toFixed(2))) };
    }

    const edges = this.backend.listProcessEdges();
    const cpuCount = Math.max(1, this.backend.cpuCount ? this.backend.cpuCount() : cpus().length);
    const seenPids = new Set<number>();

    for (const rootPid of validRoots) {
      const candidatePids = collectProcessTreePids(rootPid, edges, MAX_PROCESS_TREE_DEPTH);
      if (candidatePids.length === 0) {
        trees.set(rootPid, {
          rootPid,
          pids: [],
          processCount: 0,
          rssBytes: 0,
          privateBytes: 0,
          cpuPercent: 0,
        });
        continue;
      }

      const rootStats = this.backend.readProcessStats(rootPid);
      if (!rootStats) {
        trees.set(rootPid, {
          rootPid,
          pids: [],
          processCount: 0,
          rssBytes: 0,
          privateBytes: 0,
          cpuPercent: 0,
        });
        continue;
      }

      const livePids: number[] = [];
      let rssBytes = 0;
      let privateBytes = 0;
      let cpuPercentSum = 0;

      for (const pid of candidatePids) {
        const stats = pid === rootPid ? rootStats : this.backend.readProcessStats(pid);
        if (!stats) continue;
        // Guard against PID reuse: ignore children created before the browser root process.
        if (
          pid !== rootPid &&
          rootStats.creationTime100ns > 0n &&
          stats.creationTime100ns > 0n &&
          stats.creationTime100ns < rootStats.creationTime100ns
        ) {
          continue;
        }
        livePids.push(pid);
        seenPids.add(pid);
        rssBytes += stats.rssBytes;
        privateBytes += stats.privateBytes;

        if (stats.cpuTime100ns !== null) {
          const prev = this.prevCpu.get(pid);
          if (
            prev &&
            prev.creationTime100ns === stats.creationTime100ns &&
            nowMs > prev.tsMs &&
            stats.cpuTime100ns >= prev.cpuTime100ns
          ) {
            const deltaCpuMs = Number(stats.cpuTime100ns - prev.cpuTime100ns) / 10_000;
            const dtMs = nowMs - prev.tsMs;
            cpuPercentSum += (deltaCpuMs / (dtMs * cpuCount)) * 100;
          }
          this.prevCpu.set(pid, {
            tsMs: nowMs,
            cpuTime100ns: stats.cpuTime100ns,
            creationTime100ns: stats.creationTime100ns,
          });
        } else if (typeof stats.directCpuPercent === "number" && Number.isFinite(stats.directCpuPercent)) {
          cpuPercentSum += stats.directCpuPercent / cpuCount;
        }
      }

      trees.set(rootPid, {
        rootPid,
        pids: livePids,
        processCount: livePids.length,
        rssBytes,
        privateBytes,
        cpuPercent: Math.max(0, Math.min(100, Math.round(cpuPercentSum * 10) / 10)),
      });
    }

    // Evict dead/untracked PIDs from CPU delta cache.
    for (const pid of this.prevCpu.keys()) {
      if (!seenPids.has(pid)) this.prevCpu.delete(pid);
    }

    return {
      host,
      trees,
      durationMs: Math.max(0, Number((performance.now() - start).toFixed(2))),
    };
  }

  /** Trim OS working set (Windows K32EmptyWorkingSet) across rootPid and all live descendants. */
  trimProcessTreeWorkingSet(rootPid: number): TrimWorkingSetResult {
    const supported = this.backend.supportsWorkingSetTrim === true && typeof this.backend.emptyWorkingSet === "function";
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return { rootPid, supported, processCount: 0, trimmedProcesses: 0, beforeRssBytes: 0, afterRssBytes: 0, reclaimedBytes: 0 };
    }
    const edges = this.backend.listProcessEdges();
    const candidatePids = collectProcessTreePids(rootPid, edges, MAX_PROCESS_TREE_DEPTH);
    if (candidatePids.length === 0) {
      return { rootPid, supported, processCount: 0, trimmedProcesses: 0, beforeRssBytes: 0, afterRssBytes: 0, reclaimedBytes: 0 };
    }
    const rootStats = this.backend.readProcessStats(rootPid);
    if (!rootStats) {
      return { rootPid, supported, processCount: 0, trimmedProcesses: 0, beforeRssBytes: 0, afterRssBytes: 0, reclaimedBytes: 0 };
    }

    const livePids: number[] = [];
    let beforeRssBytes = 0;
    for (const pid of candidatePids) {
      const stats = pid === rootPid ? rootStats : this.backend.readProcessStats(pid);
      if (!stats) continue;
      if (
        pid !== rootPid &&
        rootStats.creationTime100ns > 0n &&
        stats.creationTime100ns > 0n &&
        stats.creationTime100ns < rootStats.creationTime100ns
      ) {
        continue;
      }
      livePids.push(pid);
      beforeRssBytes += stats.rssBytes;
    }

    let trimmedProcesses = 0;
    if (supported) {
      for (const pid of livePids) {
        try {
          if (this.backend.emptyWorkingSet!(pid)) trimmedProcesses += 1;
        } catch {}
      }
    }

    let afterRssBytes = 0;
    if (trimmedProcesses > 0) {
      for (const pid of livePids) {
        const stats = this.backend.readProcessStats(pid);
        if (stats) afterRssBytes += stats.rssBytes;
      }
    } else {
      afterRssBytes = beforeRssBytes;
    }

    return {
      rootPid,
      supported,
      processCount: livePids.length,
      trimmedProcesses,
      beforeRssBytes,
      afterRssBytes,
      reclaimedBytes: Math.max(0, beforeRssBytes - afterRssBytes),
    };
  }
}
