import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export interface HostProcessRecord {
  pid: number;
  processName?: string;
  executablePath: string | null;
  /** Linux and Darwin-Firefox process ownership fields. */
  parentPid?: number;
  processGroupId?: number;
  startTime?: string;
  /** False only when executablePath was heuristically split from flattened argv. */
  executablePathExact?: boolean;
  commandLine?: string;
  argv?: string[];
}

export interface HostProcessSnapshot {
  records: HostProcessRecord[];
  incomplete: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizedExecutablePath(path: string, windows = IS_WINDOWS): string {
  let normalized = path.trim().replace(/^"|"$/g, "");
  // Linux marks the /proc/<pid>/exe symlink this way when the on-disk binary
  // was atomically replaced. The running process still belongs to the exact
  // launch path and must remain manageable instead of looking foreign/dead.
  if (!windows) normalized = normalized.replace(/ \(deleted\)$/, "");
  try { normalized = realpathSync(normalized); } catch { normalized = resolve(normalized); }
  return windows ? normalized.replace(/\//g, "\\").toLowerCase() : normalized;
}

export function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match one complete argv item in a Windows command-line string. */
export function windowsCommandHasExactArg(commandLine: string, arg: string): boolean {
  return new RegExp(`(?:^|[\\s"])${regexpEscape(arg)}(?=$|[\\s"])`, "i").test(commandLine);
}

/** Share only a currently-running snapshot read; settled results are never cached. */
export function createInFlightSnapshotReader<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const current = Promise.resolve().then(read);
    inFlight = current;
    const clear = () => { if (inFlight === current) inFlight = null; };
    current.then(clear, clear);
    return current;
  };
}

/**
 * Share live reads and briefly reuse only failed results so a sick process
 * service cannot be hammered by every dashboard poll. Successful snapshots
 * are never cached because a browser may start immediately afterward.
 */
export function createFailureBackoffReader<T>(
  read: () => Promise<T>,
  failed: (value: T) => boolean,
  backoffMs: number,
  nowMs: () => number = Date.now,
): () => Promise<T> {
  let lastFailure: { value: T; retryAt: number } | null = null;
  const sharedRead = createInFlightSnapshotReader(async () => {
    const value = await read();
    lastFailure = failed(value)
      ? { value, retryAt: nowMs() + Math.max(1, backoffMs) }
      : null;
    return value;
  });
  return () => {
    if (lastFailure && nowMs() < lastFailure.retryAt) {
      return Promise.resolve(lastFailure.value);
    }
    return sharedRead();
  };
}

/** Read a spawned snapshot helper with a hard timeout that kills the helper. */
export function readSnapshotChildBounded(
  child: { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
  timeoutMs: number,
): Promise<{ raw: string; exitCode: number } | null> {
  return new Promise((resolveDone) => {
    let settled = false;
    const finish = (result: { raw: string; exitCode: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, Math.max(1, timeoutMs));
    void Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]).then(
      ([raw, exitCode]) => finish({ raw, exitCode }),
      () => finish(null),
    );
  });
}
