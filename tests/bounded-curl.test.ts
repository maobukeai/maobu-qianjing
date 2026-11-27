import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadBoundedCurl, type BoundedCurlOptions, type CurlDownloadSpawn } from "../bounded-curl.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function partial(): string {
  const directory = mkdtempSync(join(tmpdir(), "maobu-curl-fixture-"));
  directories.push(directory);
  return join(directory, "archive.part");
}

const url = "https://fixture.invalid/archive.zip";
const defaults = { executable: "fixture-curl", maxBytes: 4, timeoutMs: 1_000, resume: true, exactSize: true };
const bytes = (text: string) => Buffer.from(text);

function transfer(chunks: Uint8Array[], options: {
  code?: number;
  neverEnd?: boolean;
  neverExit?: boolean;
  neverFinishCancel?: boolean;
  onKill?: () => void;
  killDelay?: number;
} = {}) {
  const events: string[] = [];
  const commands: string[][] = [];
  let exit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { exit = resolve; });
  let index = 0;
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else if (!options.neverEnd) {
        controller.close();
        if (!options.neverExit) { events.push("exited"); exit(options.code ?? 0); }
      }
    },
    cancel() {
      events.push("cancel");
      if (options.neverFinishCancel) return new Promise<void>(() => {});
    },
  });
  const spawn: CurlDownloadSpawn = command => {
    commands.push(command);
    return { stdout, exited, kill(signal) {
      events.push(signal);
      options.onKill?.();
      setTimeout(() => { events.push("exited"); exit(137); }, options.killDelay ?? 0);
    } };
  };
  return { spawn, stdout, events, commands };
}

function download(path: string, fixture: ReturnType<typeof transfer>, extra: Partial<BoundedCurlOptions> = {}) {
  return downloadBoundedCurl(url, path, { ...defaults, spawn: fixture.spawn, ...extra });
}

test("uses the system curl argument contract and keeps a split HTTP status trailer out of the file", async () => {
  const path = partial();
  const fixture = transfer([bytes("12"), bytes("34"), bytes("2"), bytes("0"), bytes("0")]);
  await download(path, fixture, { timeoutMs: 3_500 });
  expect(readFileSync(path, "utf8")).toBe("1234");
  const command = fixture.commands[0]!;
  expect(command.slice(0, 2)).toEqual(["fixture-curl", "-q"]);
  const value = (option: string) => command[command.indexOf(option) + 1];
  expect(value("--proto")).toBe("=https");
  expect(value("--proto-redir")).toBe("=https");
  expect(value("--max-redirs")).toBe("8");
  expect(value("--connect-timeout")).toBe("30");
  expect(value("--speed-limit")).toBe("1024");
  expect(value("--speed-time")).toBe("60");
  expect(value("--max-time")).toBe("2");
  expect(value("--max-filesize")).toBe("4");
  expect(value("--output")).toBe("-");
  expect(value("--write-out")).toBe("%{http_code}");
  expect(value("--url")).toBe(url);
  expect(command).not.toContain("--retry");
  expect(command).not.toContain("--compressed");
  expect(command).not.toContain("--insecure");
  expect(command).not.toContain("--continue-at");
  expect(fixture.events).toEqual(["exited"]);
  expect(fixture.stdout.locked).toBe(false);
});

test("rejects non-HTTPS or credential-bearing sources before spawning curl", async () => {
  for (const source of ["http://fixture.invalid/a", "file:///fake", "https://secret:password@fixture.invalid/a"]) {
    const fixture = transfer([]);
    await expect(downloadBoundedCurl(source, partial(), { ...defaults, spawn: fixture.spawn })).rejects.toThrow("HTTPS URL without credentials");
    expect(fixture.commands).toEqual([]);
  }
});

test("strictly caps a continuous unknown-length response before writes and waits for the killed child", async () => {
  const path = partial();
  let sizeAtKill = -1;
  const fixture = transfer([bytes("1234567"), bytes("8")], {
    neverEnd: true, neverFinishCancel: true, killDelay: 30,
    onKill: () => { sizeAtKill = statSync(path).size; },
  });
  await expect(download(path, fixture)).rejects.toThrow("exceeded its byte limit");
  expect(sizeAtKill).toBe(4);
  expect(fixture.events).toEqual(["SIGKILL", "cancel", "exited"]);
  expect(existsSync(path)).toBe(false);
  expect(fixture.stdout.locked).toBe(false);
});

test("a parent deadline kills and reaps a child even when its stdout stalls and cancellation never finishes", async () => {
  const path = partial();
  writeFileSync(path, "12");
  const fixture = transfer([bytes("3456")], { neverEnd: true, neverFinishCancel: true, killDelay: 25 });
  await expect(download(path, fixture, { timeoutMs: 50 })).rejects.toThrow("timed out");
  expect(fixture.events).toEqual(["SIGKILL", "cancel", "exited"]);
  expect(fixture.stdout.locked).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("12");
});

test("stdout EOF alone cannot bypass the deadline while curl has not exited", async () => {
  const path = partial();
  const fixture = transfer([bytes("1234200")], { neverExit: true });
  await expect(download(path, fixture, { timeoutMs: 50 })).rejects.toThrow("timed out");
  expect(fixture.events).toEqual(["SIGKILL", "exited"]);
  expect(fixture.stdout.locked).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("preserves a confirmed short prefix and resumes via an explicit stdout offset", async () => {
  const path = partial();
  const first = transfer([bytes("12200")], { code: 18 });
  await expect(download(path, first)).rejects.toThrow("code 18");
  expect(readFileSync(path, "utf8")).toBe("12");
  const second = transfer([bytes("342"), bytes("06")]);
  await download(path, second);
  expect(readFileSync(path, "utf8")).toBe("1234");
  const args = second.commands[0]!;
  expect(args[args.indexOf("--continue-at") + 1]).toBe("2");
  expect(args).not.toContain("--range");
});

test("overlapping attempts at the same resume offset cannot append beyond the archive cap", async () => {
  const path = partial();
  writeFileSync(path, "12");
  const first = transfer([bytes("34206")]);
  const second = transfer([bytes("34206")]);
  await Promise.all([download(path, first), download(path, second)]);
  expect(readFileSync(path, "utf8")).toBe("1234");
  expect(statSync(path).size).toBe(4);
});

test("requires an exact pinned length and never promotes an unconfirmed full part on retry", async () => {
  const path = partial();
  await expect(download(path, transfer([bytes("12200")]))).rejects.toThrow("before its pinned size");
  expect(readFileSync(path, "utf8")).toBe("12");
  await expect(download(path, transfer([bytes("34206")], { code: 18 }))).rejects.toThrow("code 18");
  expect(existsSync(path)).toBe(false);
});

test("rejects invalid 200/416 resume responses and discards stale parts", async () => {
  for (const [body, code] of [["34200", 0], ["416", 0], ["416", 22]] as const) {
    const path = partial();
    writeFileSync(path, "12");
    await expect(download(path, transfer([bytes(body)], { code }))).rejects.toThrow(/HTTP (200|416)/);
    expect(existsSync(path)).toBe(false);
  }
  for (const code of [33, 36, 63]) {
    const path = partial();
    writeFileSync(path, "12");
    await expect(download(path, transfer([bytes("206")], { code }))).rejects.toThrow(`code ${code}`);
    expect(existsSync(path)).toBe(false);
  }
});

test("an ordinary HTTP error preserves an earlier valid prefix", async () => {
  const path = partial();
  writeFileSync(path, "12");
  await expect(download(path, transfer([bytes("503")], { code: 22 }))).rejects.toThrow("HTTP 503");
  expect(readFileSync(path, "utf8")).toBe("12");
});

test("an interrupted curl cannot retain bytes when its body ends with a status-like suffix", async () => {
  for (const body of ["x206", "xy206", "x416", "xy416"]) {
    const path = partial();
    writeFileSync(path, "12");
    await expect(download(path, transfer([bytes(body)], { code: 137 }))).rejects.toThrow(/^curl exited with code 137$/);
    expect(readFileSync(path, "utf8")).toBe("12");
  }
  const fresh = partial();
  await expect(download(fresh, transfer([bytes("xy200")], { code: 137 }))).rejects.toThrow("code 137");
  expect(existsSync(fresh)).toBe(false);
});

test("resets an oversized saved part before a new request and accepts a complete saved part for later hash verification", async () => {
  const path = partial();
  writeFileSync(path, "12345");
  const fresh = transfer([bytes("abcd200")]);
  await download(path, fresh);
  expect(readFileSync(path, "utf8")).toBe("abcd");
  expect(fresh.commands[0]).not.toContain("--continue-at");
  const saved = transfer([]);
  await download(path, saved);
  expect(saved.commands).toEqual([]);
});

test("kills the child and releases the stream when opening the output fails", async () => {
  const fixture = transfer([], { neverEnd: true, killDelay: 15 });
  await expect(download(join(partial(), "missing"), fixture)).rejects.toThrow();
  expect(fixture.events).toEqual(["SIGKILL", "cancel", "exited"]);
  expect(fixture.stdout.locked).toBe(false);
});

test("a real isolated subprocess is reaped after crossing the archive cap", async () => {
  const path = partial();
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">> | undefined;
  try {
    await expect(downloadBoundedCurl(url, path, {
      ...defaults, timeoutMs: 3_000, spawn: () => {
        child = Bun.spawn([process.execPath, "-e", "process.stdout.write('12345678'); setInterval(() => {}, 1000);"],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
        return child;
      },
    })).rejects.toThrow("exceeded its byte limit");
    expect(child!.signalCode).toBe("SIGKILL");
    expect(await child!.exited).toBe(137);
    expect(existsSync(path)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child?.exited;
  }
});
