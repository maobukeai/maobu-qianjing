import { join, resolve } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { windowsSystemTool } from "../browser-install.ts";
import {
  IS_WINDOWS,
  readSnapshotChildBounded,
  sleep,
  type HostProcessRecord,
  type HostProcessSnapshot,
} from "./snapshot-utils.ts";

export interface SpawnedProcess {
  pid: number;
  kill(): void;
  /** Linux-only dedicated process-group ownership captured at spawn. */
  processGroupId?: number;
  rootStartTime?: string;
  /**
   * Resolves with a human-readable reason once the spawner can PROVE the browser
   * never started (e.g. the Windows session helper exited nonzero because nobody is
   * logged in), or null when the spawn looks healthy / cannot be judged.
   */
  spawnFailed?: Promise<string | null>;
}

export type SpawnFn = (binary: string, args: string[], env?: Record<string, string>) => SpawnedProcess;

export const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 60_000;
export const WINDOWS_TASKLIST_TIMEOUT_MS = 10_000;
export const SESSION_PID_RECOVERY_TIMEOUT_MS = 30_000;

/**
 * Parse image names from tasklist /FO CSV /NH output. Localized status text
 * has no quoted CSV first field and is ignored.
 */
export function parseTasklistImageNames(raw: string): Set<string> {
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim().match(/^"([^"]+)"/)?.[1];
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

// 64-bit PROCESSENTRY32W: th32ProcessID at 8, th32ParentProcessID at 32, szExeFile[260] at 44.
const WINDOWS_PROCESS_ENTRY_SIZE = 568;
const WINDOWS_INVALID_HANDLE = 0xFFFF_FFFF_FFFF_FFFFn;
const WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WINDOWS_PROCESS_COMMAND_LINE_INFORMATION = 60;
// UNICODE_STRING header plus the longest possible command line (65534 bytes).
const windowsCommandLineBuffer = new Uint8Array(16 + 65_536);
const windowsImagePathBuffer = new Uint16Array(32_768);
const windowsImagePathLength = new Uint32Array(1);
const windowsProcessApi = process.platform === "win32" ? (() => {
  try {
    return {
      kernel32: dlopen("kernel32.dll", {
        CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
        Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
        Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
        OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
        QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
      }).symbols,
      ntdll: dlopen("ntdll.dll", {
        NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
      }).symbols,
    };
  } catch {
    return null;
  }
})() : null;

/** Read pid, parent pid and image name from one 64-bit PROCESSENTRY32W. */
export function parseWindowsProcessEntry(entry: Uint8Array): { pid: number; parentPid: number; processName: string } {
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  const name = Buffer.from(entry.buffer, entry.byteOffset + 44, 520).toString("utf16le");
  const end = name.indexOf("\0");
  return {
    pid: view.getUint32(8, true),
    parentPid: view.getUint32(32, true),
    processName: end < 0 ? name : name.slice(0, end),
  };
}

/**
 * Decode the UNICODE_STRING that ProcessCommandLineInformation writes at the
 * start of `buffer`. Like WMI, stop at the first NUL that some processes write.
 */
export function decodeWindowsCommandLine(buffer: Uint8Array, bufferAddress: number): string | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const length = view.getUint16(0, true);
  if (length === 0) return "";
  const offset = Number(view.getBigUint64(8, true)) - bufferAddress;
  if (!Number.isSafeInteger(offset) || offset < 16 || offset + length > buffer.byteLength) return null;
  const text = Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString("utf16le");
  const end = text.indexOf("\0");
  return end < 0 ? text : text.slice(0, end);
}

/**
 * Native Windows process snapshot with the WMI scan's fields. A process that
 * cannot be opened keeps a null path and an empty command line, as in WMI.
 * Throws only when the snapshot itself fails. No IPC, so it cannot hang like WMI.
 */
export function readWindowsProcessSnapshotNative(): HostProcessSnapshot {
  if (!windowsProcessApi) throw new Error("Windows process API is unavailable");
  const { kernel32, ntdll } = windowsProcessApi;
  const snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0) as bigint; // TH32CS_SNAPPROCESS
  if (snapshot === 0n || snapshot === WINDOWS_INVALID_HANDLE) throw new Error("CreateToolhelp32Snapshot failed");
  const entry = new Uint8Array(WINDOWS_PROCESS_ENTRY_SIZE);
  new DataView(entry.buffer).setUint32(0, WINDOWS_PROCESS_ENTRY_SIZE, true);
  const records: HostProcessRecord[] = [];
  try {
    for (let more = kernel32.Process32FirstW(snapshot, entry); more; more = kernel32.Process32NextW(snapshot, entry)) {
      const { pid, parentPid, processName } = parseWindowsProcessEntry(entry);
      if (pid <= 0) continue;
      let executablePath: string | null = null;
      let commandLine = "";
      const handle = kernel32.OpenProcess(WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as bigint;
      if (handle !== 0n) {
        try {
          windowsImagePathLength[0] = windowsImagePathBuffer.length;
          if (kernel32.QueryFullProcessImageNameW(handle, 0, windowsImagePathBuffer, windowsImagePathLength)) {
            executablePath = Buffer.from(windowsImagePathBuffer.buffer, 0, windowsImagePathLength[0]! * 2).toString("utf16le") || null;
          }
          const status = ntdll.NtQueryInformationProcess(
            handle, WINDOWS_PROCESS_COMMAND_LINE_INFORMATION,
            windowsCommandLineBuffer, windowsCommandLineBuffer.byteLength, null,
          );
          if (status === 0) commandLine = decodeWindowsCommandLine(windowsCommandLineBuffer, ptr(windowsCommandLineBuffer)) ?? "";
        } finally {
          kernel32.CloseHandle(handle);
        }
      }
      records.push({ pid, parentPid, processName: processName || undefined, executablePath, commandLine });
    }
  } finally {
    kernel32.CloseHandle(snapshot);
  }
  if (records.length === 0) throw new Error("Windows process snapshot was empty");
  return { records, incomplete: false };
}

/** WMI fallback for the native scan, bounded by WINDOWS_PROCESS_SCAN_TIMEOUT_MS. */
export async function readWindowsProcessSnapshotWmi(): Promise<HostProcessSnapshot | null> {
  try {
    const script = [
      "Get-CimInstance -Query 'SELECT ProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process' -OperationTimeoutSec 50 -ErrorAction Stop",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    // The full path also works when PATH has no PowerShell folder.
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = Bun.spawn(
      [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
      { stdout: "pipe", stderr: "ignore" },
    );
    const result = await readSnapshotChildBounded(
      child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
      WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
    );
    if (!result || result.exitCode !== 0) {
      // A failed scan stops every saved profile with browser_launch/profile_directory. The log shows why.
      console.log(`[aliasmode] Windows process scan failed: ${result ? `exit code ${result.exitCode}` : "timed out"}`);
      return null;
    }
    const parsed = result.raw.trim() ? JSON.parse(result.raw) : [];
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const records: HostProcessRecord[] = [];
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      records.push({
        pid,
        processName: typeof row?.Name === "string" && row.Name ? row.Name : undefined,
        executablePath: typeof row?.ExecutablePath === "string" && row.ExecutablePath ? row.ExecutablePath : null,
        commandLine: typeof row?.CommandLine === "string" ? row.CommandLine : "",
      });
    }
    return { records, incomplete: false };
  } catch (error) {
    console.log(`[aliasmode] Windows process scan failed: ${(error as { code?: string })?.code ?? String(error)}`);
    return null;
  }
}

export async function readWindowsProcessImageNames(): Promise<Set<string> | null> {
  if (!IS_WINDOWS) return null;
  try {
    const child = Bun.spawn(
      [windowsSystemTool("tasklist.exe"), "/FO", "CSV", "/NH"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const result = await readSnapshotChildBounded(
      child as unknown as { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown },
      WINDOWS_TASKLIST_TIMEOUT_MS,
    );
    if (!result || result.exitCode !== 0) return null;
    return parseTasklistImageNames(result.raw);
  } catch {
    return null;
  }
}

export function shouldLaunchViaWindowsSession(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const modern = (env.ALIASMODE_SESSION_LAUNCH ?? "").trim().toLowerCase();
  const legacy = (env.ALIASMODE_LAUNCH_IN_SESSION ?? "").trim().toLowerCase();
  if ([modern, legacy].some((v) => ["0", "false", "no", "off"].includes(v))) return false;
  if ([modern, legacy].some((v) => ["1", "true", "yes", "on"].includes(v))) return true;
  return (env.SESSIONNAME ?? "").trim().toLowerCase() === "services";
}

/**
 * Quote a single argument for a Windows command line the way CreateProcess's
 * argv parser expects (the same rules CommandLineToArgvW uses).
 */
export function quoteWindowsCommandArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
    } else if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + ch;
      slashes = 0;
    } else {
      out += "\\".repeat(slashes) + ch;
      slashes = 0;
    }
  }
  out += "\\".repeat(slashes * 2) + '"';
  return out;
}

// Path to the PowerShell session-launch helper (repo-relative from src/launcher/).
const SESSION_HELPER = resolve(import.meta.dir, "..", "..", "packaging", "launch-in-session.ps1");

/**
 * Windows-only spawn that launches the browser ON THE INTERACTIVE USER'S DESKTOP,
 * so windows are VISIBLE even when aliasmode runs as a service (Session 0).
 */
export function sessionLaunchSpawn(
  binary: string,
  args: string[],
  log: (msg: string) => void = () => {},
): SpawnedProcess {
  const cmdline = [binary, ...args].map(quoteWindowsCommandArg).join(" ");
  const portArg = args.find((a) => a.startsWith("--remote-debugging-port="));
  const port = portArg ? portArg.slice("--remote-debugging-port=".length) : "0";
  let reportSpawnResult: (reason: string | null) => void = () => {};
  const spawnFailed = new Promise<string | null>((resolveDone) => { reportSpawnResult = resolveDone; });
  const proc: SpawnedProcess = {
    pid: 0,
    kill: () => { if (proc.pid > 0) { try { Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]); } catch {} } },
    spawnFailed,
  };
  try {
    const child = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SESSION_HELPER, "-CommandLine", cmdline, "-Port", port],
      { stdout: "pipe", stderr: "pipe" },
    );
    (async () => {
      try {
        const result = await Promise.race([
          Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]).then(([out, err, exitCode]) => ({ out, err, exitCode })),
          sleep(SESSION_PID_RECOVERY_TIMEOUT_MS).then(() => null),
        ]);
        if (!result) {
          try { child.kill(); } catch {}
          reportSpawnResult(null);
          return;
        }
        const { out, err, exitCode } = result;
        for (const line of err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          log(`session-launch: ${line}`);
        }
        const found = parseInt(out.trim().split(/\s+/).filter(Boolean).pop() || "0", 10);
        if (found > 0) proc.pid = found;
        if (exitCode !== 0) {
          const detail = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
          reportSpawnResult(
            `interactive session launch helper exited ${exitCode}${detail ? `: ${detail}` : ""}`,
          );
          return;
        }
        reportSpawnResult(null);
      } catch {
        reportSpawnResult(null);
      }
    })();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`session-launch: could not run ${SESSION_HELPER}: ${detail}`);
    reportSpawnResult(`could not run the interactive session launch helper: ${detail}`);
  }
  return proc;
}

/** True when browsers should be launched onto the interactive desktop (service + opt-in). */
export const SESSION_LAUNCH = shouldLaunchViaWindowsSession();
