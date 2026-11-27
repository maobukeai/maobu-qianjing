import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  beforeAbort,
  cancelBody,
  isRuntimeDownloadCancelled,
  notifyRuntimeDownloadProgress,
  registerRuntimeDownloadAbort,
  RuntimeDownloadCancelledError,
  RuntimeDownloadPausedError,
  trackRuntimeDownload,
  updateRuntimeDownloadTotal,
  waitWhileRuntimeDownloadPaused,
  writeDownloadChunk,
} from "./runtime-download.ts";
import { browserEnvText, sha256File, windowsSystemTool } from "./browser-install.ts";

export interface FirefoxRuntimeBuild {
  platform: NodeJS.Platform;
  arch: string;
  executablePath: string;
  archiveSha256: string;
  executableSha256: string;
}

export const FIREFOX_RUNTIME_VERSION = "156.0.1-beta.36";
export function firefoxInstallDirectoryPrefix(platform: NodeJS.Platform, arch: string): string {
  return `firefox-${platform}-${arch}-`;
}
const FIREFOX_RUNTIME_RELEASE = `aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-r14`;
const FIREFOX_RELEASE_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FIREFOX_RUNTIME_RELEASE}`;
// The releases have archive hashes, but no pinned byte counts.
const FIREFOX_ARCHIVE_LIMIT = 1024 ** 3;
const FIREFOX_DOWNLOAD_TIMEOUT_MS = 180_000;
const FIREFOX_REDIRECT_LIMIT = 8;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "linux", arch: "x64", executablePath: "aliasmode",
    archiveSha256: "33c976a7015a468f647e4cdd71c064e5a6e58c75d960ad74d48de755b4212f4b",
    executableSha256: "fba911c6baa1e73d19187bf5242faf42d33c22d5204ec761cb913f8818816bb7",
  },
  {
    platform: "darwin", arch: "arm64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "64b56f0c6a8aa0a9e4ec2ffe058060131dfd385692747a717fabea6c4d2424bc",
    executableSha256: "2ae46440c758f1dfc74c2be6f5fd95f9bc85f60cab6ae8afbc2e4c4762ff3c05",
  },
  {
    platform: "darwin", arch: "x64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "ce4cca8228ab48fb711166be8933b6cb118dfa5660f87eed16a3334d64a9c42f",
    executableSha256: "6dddcdbb8c93f1b9bc3f57276c1846f11df5b3cd7a63869489db393e6a402edf",
  },
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "23d2531f5a72dbfde049319259bcee55407a2ba7afc570398446da5c1f20cfcb",
    executableSha256: "1a031ad448359f65b299634dd6fd0027c556f4c7807c2e0fb17f48a76fba7337",
  },
];

export function firefoxBuildForHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  builds = FIREFOX_RUNTIME_BUILDS,
): FirefoxRuntimeBuild {
  const build = builds.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!build) {
    const host = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
    throw new Error(`No approved Firefox archive is available for ${host} ${arch}`);
  }
  return build;
}

export function firefoxReleaseArchiveUrl(build: FirefoxRuntimeBuild): string {
  const name = build.platform === "linux" && build.arch === "x64"
    ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-lin.x86_64.zip`
    : build.platform === "darwin" && build.arch === "arm64"
      ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-mac.arm64.zip`
      : build.platform === "darwin" && build.arch === "x64"
        ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-mac.x86_64.zip`
        : build.platform === "win32" && build.arch === "x64"
          ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-win.x86_64.zip`
          : "";
  if (!name) throw new Error(`No approved Firefox release archive is available for ${build.platform} ${build.arch}`);
  return `${FIREFOX_RELEASE_BASE}/${name}`;
}

interface FirefoxDownloadDependencies {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  archiveLimitBytes?: number;
  downloadTimeoutMs?: number;
}

async function fetchFirefoxRelease(
  url: string,
  fetcher: NonNullable<FirefoxDownloadDependencies["fetch"]>,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  let target = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new Error("approved Firefox release download requires HTTPS without URL credentials");
    }
    signal.throwIfAborted();
    const request = fetcher(target.href, headers ? { redirect: "manual", signal, headers } : { redirect: "manual", signal }).then(response => {
      if (signal.aborted) {
        cancelBody(response.body);
        throw signal.reason;
      }
      return response;
    });
    const response = await beforeAbort(request, signal);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    cancelBody(response.body);
    if (redirects >= FIREFOX_REDIRECT_LIMIT) throw new Error("approved Firefox release download exceeded its redirect limit");
    const location = response.headers.get("location");
    if (!location) throw new Error("approved Firefox release redirect has no location");
    try { target = new URL(location, target); }
    catch { throw new Error("approved Firefox release redirect has an invalid location"); }
  }
}

/** Only a plain response's Content-Length describes the bytes fetch exposes. */
function firefoxContentLength(response: Response, maxBytes: number): number | undefined {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const header = response.headers.get("content-length");
  if (header === null || (encoding && encoding !== "identity")) return undefined;
  const length = Number(header);
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(length)) {
    throw new Error("approved Firefox release returned an invalid Content-Length");
  }
  if (length > maxBytes) throw new Error("approved Firefox release exceeded its archive byte limit");
  if (length === 0) throw new Error("approved Firefox release download returned no archive data");
  return length;
}

function firefoxContentRange(response: Response, have: number, maxBytes: number): { start: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger)) return undefined;
  if (start !== have || end < start || total <= end || total > maxBytes) return undefined;
  return { start, total };
}

async function downloadFirefoxArchive(
  build: FirefoxRuntimeBuild,
  cwd: string,
  dependencies: FirefoxDownloadDependencies,
): Promise<{ archive: string; cleanup: () => void }> {
  const maxBytes = dependencies.archiveLimitBytes ?? FIREFOX_ARCHIVE_LIMIT;
  const timeoutMs = dependencies.downloadTimeoutMs ?? FIREFOX_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("invalid Firefox archive byte limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError("invalid Firefox download timeout");
  const url = firefoxReleaseArchiveUrl(build);
  const directory = mkdtempSync(join(cwd, ".aliasmode-firefox-download-"));
  const archive = join(directory, url.split("/").at(-1)!);
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    let deadline = performance.now() + timeoutMs;
    await trackRuntimeDownload("firefox", archive, 0, async () => {
      let written = 0;
      let length: number | undefined;
      while (true) {
        if (isRuntimeDownloadCancelled(archive)) throw new RuntimeDownloadCancelledError();
        const pauseStart = performance.now();
        await waitWhileRuntimeDownloadPaused(archive);
        deadline += Math.max(0, performance.now() - pauseStart);
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1) throw new Error("approved Firefox release download timed out");

        const controller = new AbortController();
        const expire = () => controller.abort(new Error("approved Firefox release download timed out"));
        const timer = setTimeout(expire, remaining);
        const checkDeadline = () => {
          if (performance.now() >= deadline) expire();
          controller.signal.throwIfAborted();
        };
        const unregisterAbort = registerRuntimeDownloadAbort(archive, (reason) => {
          clearTimeout(timer);
          controller.abort(reason);
        });
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let file: Awaited<ReturnType<typeof open>> | undefined;
        let complete = false;
        try {
          const resuming = written > 0;
          response = await fetchFirefoxRelease(
            url,
            dependencies.fetch ?? fetch,
            controller.signal,
            resuming ? { range: `bytes=${written}-` } : undefined,
          );
          checkDeadline();
          const resumed = resuming && response.status === 206;
          if (resumed) {
            const range = firefoxContentRange(response, written, maxBytes);
            if (!range) throw new Error("approved Firefox release download returned invalid Content-Range");
            length = range.total;
            updateRuntimeDownloadTotal(archive, length);
          } else {
            if (response.status !== 200) throw new Error(`approved Firefox release download failed (HTTP ${response.status})`);
            written = 0;
            length = firefoxContentLength(response, maxBytes);
            updateRuntimeDownloadTotal(archive, length ?? 0);
          }
          const body = response.body;
          if (!body) throw new Error("approved Firefox release download returned no archive data");
          const streamReader = reader = body.getReader();
          const output = file = await open(archive, resumed ? "a" : (!existsSync(archive) ? "wx" : "w"));
          while (true) {
            checkDeadline();
            const { done, value } = await beforeAbort(streamReader.read(), controller.signal);
            checkDeadline();
            if (done) break;
            if (value.byteLength > maxBytes - written) {
              throw new Error("approved Firefox release exceeded its archive byte limit");
            }
            if (length !== undefined && value.byteLength > length - written) {
              throw new Error("approved Firefox release exceeded Content-Length");
            }
            await writeDownloadChunk(output, value, count => {
              written += count;
              notifyRuntimeDownloadProgress(archive, written);
              checkDeadline();
            });
          }
          if (written === 0) throw new Error("approved Firefox release download returned no archive data");
          if (length !== undefined && written !== length) throw new Error("approved Firefox release ended before Content-Length");
          complete = true;
          return;
        } catch (error) {
          if (error instanceof RuntimeDownloadCancelledError) throw error;
          if (error instanceof RuntimeDownloadPausedError) {
            const pauseWaitAt = performance.now();
            await waitWhileRuntimeDownloadPaused(archive);
            deadline += Math.max(0, performance.now() - pauseWaitAt);
            continue;
          }
          throw error;
        } finally {
          unregisterAbort();
          clearTimeout(timer);
          if (!complete) {
            controller.abort();
            if (reader) {
              try { void reader.cancel().catch(() => {}); } catch {}
            } else {
              cancelBody(response?.body ?? null);
            }
          }
          try { reader?.releaseLock(); }
          finally { await file?.close(); }
        }
      }
    });
    return { archive, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function extractFirefoxArchive(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "darwin" ? ["ditto", "-x", "-k", archive, destination]
    : platform === "win32" ? [windowsSystemTool("tar.exe"), "-xf", archive, "-C", destination]
      : ["unzip", "-q", archive, "-d", destination];
  if (!(platform === "win32" ? existsSync(command[0]!) : Bun.which(command[0]!))) throw new Error(`Firefox setup requires ${command[0]}`);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Firefox archive extraction failed");
}

export async function installFirefox(
  options: { archive?: string; cwd?: string; platform?: NodeJS.Platform; arch?: string; writeEnv?: boolean },
  dependencies: FirefoxDownloadDependencies & {
    builds?: readonly FirefoxRuntimeBuild[];
    extract?: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<{ path: string; sha256: string }> {
  const platform = options.platform ?? process.platform;
  const build = firefoxBuildForHost(platform, options.arch ?? process.arch, dependencies.builds);
  const cwd = resolve(options.cwd ?? process.cwd());
  const downloaded = options.archive
    ? undefined
    : await downloadFirefoxArchive(build, cwd, dependencies);
  const archive = options.archive ? resolve(options.archive) : downloaded!.archive;
  try {
    if (await sha256File(archive) !== build.archiveSha256) {
      throw new Error("Firefox archive does not match the approved host build SHA-256");
    }
    const cache = join(cwd, "browser");
    mkdirSync(cache, { recursive: true });
    // A new directory leaves any previously installed, running browser untouched.
    const root = mkdtempSync(join(cache, firefoxInstallDirectoryPrefix(platform, build.arch)));
    try {
      await (dependencies.extract ?? extractFirefoxArchive)(archive, root, platform);
      const path = join(root, build.executablePath);
      const sha256 = await sha256File(path);
      if (sha256 !== build.executableSha256) throw new Error("Firefox executable does not match its approved SHA-256");
      if (platform !== "win32") accessSync(path, constants.X_OK);
      if (options.writeEnv !== false) {
        const envPath = join(cwd, ".env");
        const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const newline = current.includes("\r\n") || platform === "win32" ? "\r\n" : "\n";
        writeFileSync(envPath, browserEnvText(current, path, sha256, newline, "ALIASMODE_FIREFOX"), "utf8");
      }
      return { path, sha256 };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  } finally {
    downloaded?.cleanup();
  }
}
