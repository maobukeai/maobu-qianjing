import { rmSync, statSync } from "node:fs";
import { open, truncate } from "node:fs/promises";
import { writeDownloadChunk } from "./runtime-download.ts";

export const CURL_ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const EXIT_CLEANUP_MS = 5_000;
const HTTP_STATUS_BYTES = 3;
const RESUMABLE_EXIT_CODES = new Set([0, 18, 28, 55, 56]);

export type CurlDownloadSpawn = (command: string[]) => {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
};

export interface BoundedCurlOptions {
  executable: string;
  maxBytes: number;
  timeoutMs: number;
  /** Continue an earlier archive prefix. */
  resume?: boolean;
  /** Require the complete archive to match maxBytes exactly. */
  exactSize?: boolean;
  spawn?: CurlDownloadSpawn;
}

/** A caller must stop retrying when a child or output could not be cleaned up. */
export class CurlCleanupError extends Error {}

function defaultSpawn(command: string[]) {
  return Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
}

function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

async function waitForExit(exited: Promise<number>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited.catch(() => {}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CurlCleanupError("curl did not exit after cancellation")), EXIT_CLEANUP_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * One HTTPS attempt using the system curl and its certificate store. The parent
 * writes the archive so old curl builds cannot overrun the limit on chunked data.
 */
export async function downloadBoundedCurl(url: string, output: string, options: BoundedCurlOptions): Promise<void> {
  const source = new URL(url);
  if (source.protocol !== "https:" || source.username || source.password) {
    throw new Error("curl downloads require an HTTPS URL without credentials");
  }
  const { maxBytes, timeoutMs } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("invalid curl archive byte limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError("invalid curl download timeout");
  let have = options.resume ? statSync(output, { throwIfNoEntry: false })?.size ?? 0 : 0;
  if (have > maxBytes || (have === maxBytes && !options.exactSize)) {
    rmSync(output, { force: true });
    have = 0;
  }
  // The installer's SHA-256 check still verifies a complete saved archive.
  if (options.exactSize && have === maxBytes) return;

  // Give curl a little time to report a normal timeout and its final status
  // before the parent deadline has to terminate it.
  const seconds = Math.max(1, Math.floor((timeoutMs - 1_000) / 1_000));
  const child = (options.spawn ?? defaultSpawn)([
    options.executable, "-q", "--fail", "--location", "--silent", "--show-error", "--globoff", "--no-buffer",
    "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "8",
    "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60", "--max-time", String(seconds),
    "--max-filesize", String(maxBytes), ...(have > 0 ? ["--continue-at", String(have)] : []),
    "--output", "-", "--write-out", "%{http_code}", "--url", source.href,
  ]);
  let processExited = false;
  const exited = child.exited.finally(() => { processExited = true; });
  void exited.catch(() => {});
  let stopping = false;
  const stop = () => {
    if (processExited || stopping) return;
    stopping = true;
    try { child.kill("SIGKILL"); } catch { /* Confirm exit below. */ }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("curl download timed out"));
    stop();
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let written = have;
  let complete = false;
  let preserve = false;
  let discard = false;
  let unexpectedExit = false;
  try {
    reader = child.stdout.getReader();
    const outputFile = file = await open(output, have > 0 ? "r+" : "w");
    // Use a bounded position even if another installer has the same part open.
    const writer = { write: (bytes: Uint8Array) => outputFile.write(bytes, 0, bytes.byteLength, written) };
    let tail = Buffer.alloc(0);
    while (true) {
      const { done, value } = await beforeAbort(reader.read(), controller.signal);
      if (done) break;
      // curl prints a three-byte HTTP status after its body, including on a
      // transfer error. Holding only that tail works on older system versions.
      const data = tail.length ? Buffer.concat([tail, value]) : value;
      const length = Math.max(0, data.byteLength - HTTP_STATUS_BYTES);
      if (length > maxBytes - written) {
        discard = true;
        throw new Error("curl download exceeded its byte limit");
      }
      tail = Buffer.from(data.subarray(length));
      if (length > 0) await writeDownloadChunk(writer, data.subarray(0, length), count => {
        written += count;
        controller.signal.throwIfAborted();
      });
    }
    const code = await beforeAbort(exited, controller.signal);
    // An interrupted process can end before printing its status trailer.
    unexpectedExit = !RESUMABLE_EXIT_CODES.has(code);
    const statusText = tail.toString("utf8");
    // Exit 22 is curl's HTTP error, so it can report a genuine 416 as well.
    const status = (!unexpectedExit || code === 22) && /^\d{3}$/.test(statusText) ? Number(statusText) : null;
    const expectedStatus = have > 0 ? 206 : 200;
    // curl can exit successfully after HTTP 416, or accept a 200 with a
    // Content-Range on a resume. Neither confirms the existing prefix.
    discard = code === 33 || code === 36 || code === 63 || (have > 0 && status === 416);
    preserve = !unexpectedExit && status === expectedStatus && !discard;
    if (code !== 0) throw new Error(`curl exited with code ${code}${status ? ` (HTTP ${status})` : ""}`);
    if (!preserve) {
      discard = true;
      throw new Error(status ? `curl answered HTTP ${status}; expected ${expectedStatus}` : "curl did not report a final HTTP status");
    }
    if (written === have) {
      discard = true;
      throw new Error("curl returned no archive data");
    }
    if (options.exactSize && written !== maxBytes) throw new Error("curl archive ended before its pinned size");
    complete = true;
  } finally {
    clearTimeout(timer);
    if (!complete) {
      stop();
      // A stream cancellation promise cannot delay the process exit check.
      try { void (reader ? reader.cancel() : child.stdout.cancel()).catch(() => {}); } catch {}
    }
    let cleanupError: unknown;
    try { reader?.releaseLock(); } catch (error) { cleanupError = error; }
    try { if (!processExited) await waitForExit(exited); } catch (error) { cleanupError ??= error; }
    // A full byte count without a successful transfer must not become a cached
    // success. Only retain new bytes after curl confirms the response status.
    if (!complete && (written === maxBytes && !unexpectedExit || (have === 0 && !preserve && file))) discard = true;
    try {
      await file?.close();
      if (discard) rmSync(output, { force: true });
      // Roll back an unconfirmed response after releasing the output handle.
      else if (file && !complete && !preserve) await truncate(output, have);
    } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw new CurlCleanupError("curl download cleanup failed", { cause: cleanupError });
  }
}
