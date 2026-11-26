import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import {
  commandLineStartsWithExecutable,
  DARWIN_PROCESS_SCAN_TIMEOUT_MS,
  parseDarwinPsSnapshot,
} from "./macos-ffi.ts";
import {
  createFailureBackoffReader,
  createInFlightSnapshotReader,
  IS_WINDOWS,
  normalizedExecutablePath,
  readSnapshotChildBounded,
  sleep,
  windowsCommandHasExactArg,
  type HostProcessRecord,
  type HostProcessSnapshot,
} from "./snapshot-utils.ts";
import {
  readWindowsProcessImageNames,
  readWindowsProcessSnapshotNative,
  readWindowsProcessSnapshotWmi,
  type SpawnFn,
} from "./windows-tasks.ts";

export const FAILED_PROCESS_SCAN_BACKOFF_MS = 60_000;

export interface BrowserProcessIdentity {
  profileId: string;
  debugPort: number;
  userDataDir: string;
  binaryPath: string;
}

/** Exact process scan: null means the OS scan itself was inconclusive. */
export type OwnedBrowserProcessFinder = (identity: BrowserProcessIdentity) => Promise<number[] | null>;

/** Signal-0 process liveness without sending a terminating signal. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves the process exists; we merely lack permission to
    // signal it. Every other failure (notably ESRCH) means it is gone.
    return (err as { code?: string })?.code === "EPERM";
  }
}

/** Parse PPID, process group and start time from Linux /proc/<pid>/stat. */
export function parseLinuxProcStat(raw: string): Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime"> | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(parentPid) || !Number.isInteger(processGroupId) || !/^\d+$/.test(startTime ?? "")) return null;
  return { parentPid, processGroupId, startTime };
}

/** Exact root-anchored Linux ancestry, deepest children first and root last. */
export function collectLinuxProcessTree(
  rootPid: number,
  snapshot: HostProcessSnapshot,
): Array<{ pid: number; startTime: string; depth: number }> | null {
  if (snapshot.incomplete) return null;
  const byPid = new Map<number, HostProcessRecord>();
  for (const record of snapshot.records) {
    if (byPid.has(record.pid)) return null;
    byPid.set(record.pid, record);
  }
  const root = byPid.get(rootPid);
  if (!root?.startTime || root.parentPid === undefined) return null;
  const members = new Map<number, { pid: number; startTime: string; depth: number }>();
  members.set(rootPid, { pid: rootPid, startTime: root.startTime, depth: 0 });
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of snapshot.records) {
      if (members.has(record.pid) || !record.startTime || record.parentPid === undefined) continue;
      const parent = members.get(record.parentPid);
      if (!parent) continue;
      members.set(record.pid, { pid: record.pid, startTime: record.startTime, depth: parent.depth + 1 });
      changed = true;
    }
  }
  return [...members.values()].sort((a, b) => b.depth - a.depth || b.pid - a.pid);
}

function readLinuxProcOwnership(pid: number): Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime"> {
  const ownership = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (!ownership) throw new Error(`invalid /proc/${pid}/stat`);
  return ownership;
}

export function readLinuxProcessRecord(pid: number): HostProcessRecord | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return { pid, executablePath: null, ...readLinuxProcOwnership(pid) };
  } catch {
    return null;
  }
}

export async function readHostProcessSnapshot(): Promise<HostProcessSnapshot | null> {
  if (IS_WINDOWS) {
    try {
      return readWindowsProcessSnapshotNative();
    } catch (error) {
      console.log(`[aliasmode] Windows native process scan failed (${String(error)}); using WMI`);
    }
    return await readWindowsProcessSnapshotWmi();
  }

  if (process.platform === "linux") {
    try {
      const records: HostProcessRecord[] = [];
      let scanIncomplete = false;
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        let before: Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime">;
        try {
          before = readLinuxProcOwnership(pid);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        let argv: string[];
        try {
          argv = readFileSync(`/proc/${entry}/cmdline`)
            .toString("utf8")
            .split("\0")
            .filter(Boolean);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        let executablePath: string | null = null;
        try {
          executablePath = readlinkSync(`/proc/${entry}/exe`);
        } catch {}
        let after: Pick<HostProcessRecord, "parentPid" | "processGroupId" | "startTime">;
        try {
          after = readLinuxProcOwnership(pid);
        } catch (err) {
          if ((err as { code?: string })?.code !== "ENOENT") scanIncomplete = true;
          continue;
        }
        if (before.startTime !== after.startTime) {
          scanIncomplete = true;
          continue;
        }
        const flattenedCommandLine = argv.length === 1 && /\s--/.test(argv[0]!);
        records.push({
          pid,
          executablePath,
          ...(flattenedCommandLine ? { commandLine: argv[0] } : { argv }),
          ...after,
        });
      }
      return { records, incomplete: scanIncomplete };
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const child = Bun.spawn(["ps", "-axww", "-o", "pid=", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
      const result = await readSnapshotChildBounded(
        child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
        DARWIN_PROCESS_SCAN_TIMEOUT_MS,
      );
      if (!result || result.exitCode !== 0) return null;
      return parseDarwinPsSnapshot(result.raw);
    } catch {
      return null;
    }
  }

  return null;
}

export const readSharedHostProcessSnapshot = createFailureBackoffReader(
  readHostProcessSnapshot,
  (snapshot) => snapshot === null,
  FAILED_PROCESS_SCAN_BACKOFF_MS,
);
const readSharedWindowsProcessImageNames = createInFlightSnapshotReader(readWindowsProcessImageNames);

export async function findOwnedBrowserPids(identity: BrowserProcessIdentity): Promise<number[] | null> {
  const snapshot = await readSharedHostProcessSnapshot();
  if (!snapshot) {
    if (IS_WINDOWS) {
      const names = await readSharedWindowsProcessImageNames();
      if (names) {
        const candidates = new Set([
          "chrome.exe",
          "sunbrowser.exe",
          basename(identity.binaryPath).toLowerCase(),
        ]);
        if (![...candidates].some((name) => names.has(name))) return [];
      }
    }
    return null;
  }

  return matchOwnedBrowserPids(identity, snapshot);
}

/** Pure exact-identity classifier, exported for deterministic lifecycle tests. */
export function matchOwnedBrowserPids(
  identity: BrowserProcessIdentity,
  snapshot: HostProcessSnapshot,
): number[] | null {
  const portArg = `--remote-debugging-port=${identity.debugPort}`;
  const dataArg = `--user-data-dir=${identity.userDataDir}`;
  const expectedBinary = normalizedExecutablePath(identity.binaryPath);
  const matches: number[] = [];
  let ambiguousIdentity = snapshot.incomplete;

  for (const record of snapshot.records) {
    const hasIdentityArgs = record.argv
      ? record.argv.includes(portArg) && record.argv.includes(dataArg)
      : windowsCommandHasExactArg(record.commandLine ?? "", portArg)
        && windowsCommandHasExactArg(record.commandLine ?? "", dataArg);
    if (!hasIdentityArgs) continue;
    const flattenedExecutableMatches = record.executablePathExact === false
      && !record.argv
      && !!record.commandLine
      && commandLineStartsWithExecutable(record.commandLine, identity.binaryPath);
    if (!record.executablePath && !flattenedExecutableMatches) {
      ambiguousIdentity = true;
      continue;
    }
    if (flattenedExecutableMatches
      || (record.executablePath && normalizedExecutablePath(record.executablePath) === expectedBinary)) {
      matches.push(record.pid);
    } else {
      ambiguousIdentity = true;
    }
  }

  return ambiguousIdentity && matches.length === 0 ? null : matches;
}

export async function findProfileDirHolderPids(userDataDir: string): Promise<number[] | null> {
  const snapshot = await readSharedHostProcessSnapshot();
  if (!snapshot) return null;
  return matchProfileDirHolderPids(userDataDir, snapshot);
}

/** Pure dir-holder classifier, exported for deterministic lifecycle tests. */
export function matchProfileDirHolderPids(
  userDataDir: string,
  snapshot: HostProcessSnapshot,
): number[] | null {
  const dataArg = `--user-data-dir=${userDataDir}`;
  const holders: number[] = [];
  for (const record of snapshot.records) {
    const holdsDir = record.argv
      ? record.argv.includes(dataArg)
      : windowsCommandHasExactArg(record.commandLine ?? "", dataArg);
    if (holdsDir) holders.push(record.pid);
  }
  return snapshot.incomplete && holders.length === 0 ? null : holders;
}

export async function signalUnixTarget(target: number): Promise<void> {
  try {
    process.kill(target, "SIGKILL");
  } catch (err) {
    if ((err as { code?: string })?.code !== "ESRCH") throw err;
  }
}

/** Cross-platform best-effort kill by pid. Used for cross-process orphans. */
export async function killByPid(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (IS_WINDOWS) {
    try {
      const proc = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    } catch {}
    return;
  }
  await signalUnixTarget(pid);
}

export async function killProcessGroup(processGroupId: number): Promise<void> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return;
  await signalUnixTarget(-processGroupId);
}

export const defaultSpawn: SpawnFn = (binary, args, env) => {
  const detached = process.platform === "linux";
  const proc = Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "ignore", detached, ...(env ? { env: { ...process.env, ...env } } : {}) });
  const root = detached ? readLinuxProcessRecord(proc.pid) : null;
  const ownsGroup = root?.processGroupId === proc.pid;
  return {
    pid: proc.pid,
    kill: () => proc.kill(),
    ...(ownsGroup ? { processGroupId: proc.pid, rootStartTime: root.startTime } : {}),
  };
};

/**
 * Graceful browser shutdown over CDP: connect to the browser-level ws endpoint,
 * send Browser.close, then poll the debug port until it stops answering.
 */
export async function defaultBrowserClose(ws: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const port = Number(ws.match(/^wss?:\/\/[^/]*:(\d+)\//)?.[1]);
  if (!Number.isFinite(port)) return false;

  await new Promise<void>((resolveDone) => {
    let sock: WebSocket | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock?.close(); } catch {}
      resolveDone();
    };
    const t = setTimeout(done, Math.min(2000, timeoutMs));
    try { sock = new WebSocket(ws); } catch { return done(); }
    sock.addEventListener("open", () => {
      try { sock!.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {}
    });
    sock.addEventListener("message", done);
    sock.addEventListener("close", done);
    sock.addEventListener("error", done);
  });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
      await res.text().catch(() => {});
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        await sleep(60);
        continue;
      }
      return true;
    }
    await sleep(60);
  }
  return false;
}

/**
 * Bring an already-running Chrome/CloakBrowser window back into view via raw CDP
 * (same mechanism used by Launcher.focus).
 */
export function raiseWindow(browserWsUrl: string): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let nextId = 1;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    const done = (err?: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolveDone();
    };
    const timer = setTimeout(() => done(new Error("bringToFront: CDP timed out")), 5000);
    ws.onerror = () => done(new Error("bringToFront: websocket error"));
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (msg && msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "CDP error")); else res(msg.result);
      }
    };
    ws.onopen = async () => {
      try {
        const { targetInfos } = await send("Target.getTargets");
        const page = (targetInfos as any[]).find((t) => t.type === "page") ?? (targetInfos as any[])[0];
        if (!page) throw new Error("no window to raise");
        const win = await send("Browser.getWindowForTarget", { targetId: page.targetId });
        const windowId = win?.windowId;
        if (windowId == null) throw new Error("no window to raise");
        if (win?.bounds?.windowState && win.bounds.windowState !== "normal") {
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        }
        if (process.platform === "linux") {
          const b = (await send("Browser.getWindowForTarget", { targetId: page.targetId }))?.bounds;
          if (b && typeof b.width === "number" && typeof b.height === "number") {
            const shrink = Math.max(240, b.height - 90);
            await send("Browser.setWindowBounds", { windowId, bounds: { width: b.width, height: shrink } });
            await sleep(200);
            await send("Browser.setWindowBounds", { windowId, bounds: { width: b.width, height: b.height } });
          }
        } else {
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
          await sleep(120);
          await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        }
        await send("Target.activateTarget", { targetId: page.targetId });
        done();
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    };
  });
}
