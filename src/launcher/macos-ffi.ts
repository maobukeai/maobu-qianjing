import { dlopen } from "bun:ffi";
import { intelMacGraphicsVendor, type MacGraphicsVendor } from "../../firefox-config.ts";
import { readSnapshotChildBounded, type HostProcessRecord, type HostProcessSnapshot } from "./snapshot-utils.ts";

export const DARWIN_PROCESS_SCAN_TIMEOUT_MS = 10_000;

interface DarwinFirefoxKernelRecord {
  executablePath: string;
  argv: string[];
}

export type DarwinFirefoxKernelQuery = (pid: number) => DarwinFirefoxKernelRecord | null;

const DARWIN_PROC_PIDPATH_SIZE = 4096;
const DARWIN_PROCARGS2_NAME = new TextEncoder().encode("kern.procargs2\0");
const DARWIN_TEXT_DECODER = new TextDecoder();

const darwinLibproc = process.platform === "darwin" ? (() => {
  try {
    return dlopen("/usr/lib/libproc.dylib", {
      proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
    });
  } catch {
    return null;
  }
})() : null;

const darwinLibSystem = process.platform === "darwin" ? (() => {
  try {
    return dlopen("/usr/lib/libSystem.B.dylib", {
      sysctlnametomib: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
      sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
    });
  } catch {
    return null;
  }
})() : null;

export async function readMacGraphicsVendor(): Promise<MacGraphicsVendor | undefined> {
  try {
    const child = Bun.spawn(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    return intelMacGraphicsVendor(await new Response(child.stdout).text());
  } catch {
    return undefined;
  }
}

/** Read only argc argv entries; KERN_PROCARGS2 appends environment data after them. */
export function parseDarwinKernelArgv(bytes: Uint8Array): string[] | null {
  if (bytes.byteLength < 5) return null;
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (!Number.isSafeInteger(argc) || argc < 1 || argc > bytes.byteLength - 4) return null;
  let cursor = 4;
  while (cursor < bytes.byteLength && bytes[cursor] !== 0) cursor++;
  if (cursor >= bytes.byteLength) return null;
  while (cursor < bytes.byteLength && bytes[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let index = 0; index < argc; index++) {
    const start = cursor;
    while (cursor < bytes.byteLength && bytes[cursor] !== 0) cursor++;
    if (start === cursor || cursor >= bytes.byteLength) return null;
    argv.push(DARWIN_TEXT_DECODER.decode(bytes.subarray(start, cursor)));
    cursor++;
  }
  return argv;
}

function readDarwinKernelArgv(pid: number): string[] | null {
  if (!darwinLibSystem || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const mib = new Int32Array(3);
    const mibLength = new BigUint64Array([BigInt(mib.length - 1)]);
    if (darwinLibSystem.symbols.sysctlnametomib(DARWIN_PROCARGS2_NAME, mib, mibLength) !== 0
      || mibLength[0] !== 2n) return null;
    mib[2] = pid;
    const requiredLength = new BigUint64Array(1);
    if (darwinLibSystem.symbols.sysctl(mib, 3, null, requiredLength, null, 0n) !== 0) return null;
    const required = requiredLength[0] ?? 0n;
    if (required < 5n || required > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const bytes = new Uint8Array(Number(required));
    const receivedLength = new BigUint64Array([required]);
    if (darwinLibSystem.symbols.sysctl(mib, 3, bytes, receivedLength, null, 0n) !== 0) return null;
    const received = receivedLength[0] ?? 0n;
    if (received < 5n || received > BigInt(bytes.byteLength)) return null;
    return parseDarwinKernelArgv(bytes.subarray(0, Number(received)));
  } catch {
    return null;
  }
}

export function parseDarwinKernelExecutablePath(path: Uint8Array, length: number): string | null {
  if (!Number.isSafeInteger(length) || length <= 0 || length >= path.byteLength || path[length] !== 0) return null;
  return DARWIN_TEXT_DECODER.decode(path.subarray(0, length));
}

function readDarwinFirefoxKernelRecord(pid: number): DarwinFirefoxKernelRecord | null {
  if (!darwinLibproc || !darwinLibSystem || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const path = new Uint8Array(DARWIN_PROC_PIDPATH_SIZE);
    const length = darwinLibproc.symbols.proc_pidpath(pid, path, path.byteLength);
    if (!Number.isSafeInteger(length) || length <= 1 || length >= path.byteLength) return null;
    const executablePath = parseDarwinKernelExecutablePath(path, length);
    if (!executablePath) return null;
    const argv = readDarwinKernelArgv(pid);
    if (!argv) return null;
    return { executablePath, argv };
  } catch {
    return null;
  }
}

function isDarwinFirefoxCandidate(commandLine: string): boolean {
  return commandLine.includes("-profile") || commandLine.includes("--aliasmode-firefox-owner=");
}

/** Keep ps as a PID candidate list only; executable and argv come from kernel APIs. */
export function parseDarwinFirefoxPsSnapshot(
  raw: string,
  query: DarwinFirefoxKernelQuery,
): HostProcessSnapshot {
  const records: HostProcessRecord[] = [];
  let incomplete = false;
  for (const line of raw.split("\n")) {
    const match = line.trimStart().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const commandLine = match[3] ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isDarwinFirefoxCandidate(commandLine)) continue;
    let record: DarwinFirefoxKernelRecord | null = null;
    try { record = query(pid); } catch {}
    if (!record) {
      incomplete = true;
      continue;
    }
    records.push({
      pid,
      ...(Number.isSafeInteger(parentPid) && parentPid >= 0 ? { parentPid } : {}),
      executablePath: record.executablePath,
      argv: record.argv,
    });
  }
  return { records, incomplete };
}

export async function readDarwinFirefoxProcessSnapshot(): Promise<HostProcessSnapshot | null> {
  try {
    const child = Bun.spawn(["ps", "-axww", "-o", "pid=", "-o", "ppid=", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
    const result = await readSnapshotChildBounded(
      child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
      DARWIN_PROCESS_SCAN_TIMEOUT_MS,
    );
    if (!result || result.exitCode !== 0) return null;
    return parseDarwinFirefoxPsSnapshot(result.raw, readDarwinFirefoxKernelRecord);
  } catch {
    return null;
  }
}

/** Parse the stable `pid= args=` shape emitted by macOS ps. */
export function parseDarwinPsSnapshot(raw: string): HostProcessSnapshot {
  const records: HostProcessRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimStart();
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const commandLine = match[2] ?? "";
    // This is exact for the common no-space case. matchOwnedBrowserPids also
    // validates commandLine against the full expected executable path, which
    // safely recovers app bundle paths such as `/Applications/Cloak Browser…`.
    const executablePath = commandLine.split(/\s+/, 1)[0] || null;
    records.push({ pid, executablePath, executablePathExact: false, commandLine });
  }
  return { records, incomplete: false };
}

export function commandLineStartsWithExecutable(commandLine: string, executablePath: string): boolean {
  const line = commandLine.trimStart();
  return line === executablePath
    || line.startsWith(`${executablePath} `)
    || line === `"${executablePath}"`
    || line.startsWith(`"${executablePath}" `);
}
