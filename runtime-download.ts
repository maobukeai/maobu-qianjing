/**
 * Resumable download of one pinned file, for the runtimes the app downloads on first
 * use. A broken download resumes with a Range request, also in a later app run. It
 * retries with backoff and retries a download that stalls. Python and Firefox
 * font packs share this bounded download loop.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

export interface ResumableDownloadDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Download attempts; a partial download resumes on the next. */
  attempts?: number;
  /** A download that receives nothing for this long is retried. */
  stallMs?: number;
}

/** A 206 must describe precisely the remaining bytes of this pinned file. */
function matchesRange(response: Response, have: number, size: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (!match) return false;
  const [start, end, total] = match.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger)
    && start === have && end === size - 1 && total === size;
}

/** @internal Complete a chunk even when the filesystem accepts only a prefix. */
export async function writeDownloadChunk(
  writer: { write(bytes: Uint8Array): Promise<{ bytesWritten: number }> },
  chunk: Uint8Array,
  progress: (bytes: number) => void = () => {},
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk.subarray(offset));
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
      throw new Error("download file write made no valid progress");
    }
    offset += bytesWritten;
    progress(bytesWritten);
  }
}

/** Also bound injected transports whose response stream does not observe abort. */
export function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); reject(signal.reason); };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation closes pending reads synchronously; a source's cleanup promise
  // must not keep a failed download waiting forever.
  try { void body?.cancel().catch(() => {}); } catch {}
}

async function receive(
  url: string,
  partial: string,
  have: number,
  size: number,
  deps: ResumableDownloadDeps,
  progress: (bytes: number) => void,
): Promise<void> {
  const controller = new AbortController();
  const stallMs = deps.stallMs ?? 60_000;
  const stalled = () => controller.abort(new Error("download stalled"));
  let timer = setTimeout(stalled, stallMs);
  const alive = () => { clearTimeout(timer); timer = setTimeout(stalled, stallMs); };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  let discard = false;
  let failed = false;
  let written = have;
  try {
    const request = (deps.fetch ?? fetch)(url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: controller.signal,
    }).then((answer) => {
      // A transport may resolve after its deadline, after this attempt's finally.
      if (controller.signal.aborted) {
        cancelBody(answer.body);
        throw controller.signal.reason;
      }
      return answer;
    });
    response = await beforeAbort(request, controller.signal);
    const resume = have > 0 && response.status === 206 && matchesRange(response, have, size);
    if (!resume && response.status !== 200) {
      // The saved part no longer lines up with what the server sends: start over.
      discard = response.status === 206 || response.status === 416;
      throw new Error(`download answered HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("download returned no data");
    const expected = size - (resume ? have : 0);
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    // Fetch can decompress an encoded response, whose Content-Length then counts
    // encoded bytes. The actual decoded bytes are always bounded below.
    if (length !== null && (!encoding || encoding.toLowerCase() === "identity")
      && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) !== expected)) {
      throw new Error("download Content-Length does not match its pinned size");
    }
    reader = response.body.getReader();
    file = await open(partial, resume ? "a" : "w");
    written = resume ? have : 0;
    while (true) {
      const { done, value } = await beforeAbort(reader.read(), controller.signal);
      if (done) {
        if (written !== size) throw new Error("download ended early");
        complete = true;
        break;
      }
      if (value.byteLength > size - written) {
        discard = true;
        throw new Error("download exceeds its pinned size");
      }
      if (value.byteLength > 0) alive();
      await writeDownloadChunk(file, value, (bytes) => {
        written += bytes;
        controller.signal.throwIfAborted();
        progress(written);
      });
    }
  } catch (error) {
    failed = true;
    // A full byte count without EOF must not turn into success at the start of
    // the next attempt. A shorter saved prefix can still safely resume.
    if (file && written === size) discard = true;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      if (!complete) { try { void reader.cancel().catch(() => {}); } catch {} }
      try { reader.releaseLock(); } catch {}
    } else {
      cancelBody(response?.body ?? null);
    }
    try {
      await file?.close();
    } catch (error) {
      if (!failed) throw error;
    } finally {
      if (discard) rmSync(partial, { force: true });
    }
  }
}

/**
 * Download `url` to `partial` until it holds `size` bytes, resuming what an earlier
 * attempt or app run saved. `progress` receives the bytes saved so far.
 */
export async function downloadResumable(
  url: string,
  partial: string,
  size: number,
  deps: ResumableDownloadDeps = {},
  progress: (bytes: number) => void = () => {},
): Promise<void> {
  const attempts = deps.attempts ?? 5;
  let lastError: unknown = new Error("download did not run");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have = existsSync(partial) ? statSync(partial).size : 0;
    if (have > size) {
      rmSync(partial, { force: true });
      have = 0;
    }
    progress(have);
    if (have === size) return;
    try {
      await receive(url, partial, have, size, deps, progress);
      const received = statSync(partial).size;
      if (received === size) return;
      if (received > size) rmSync(partial, { force: true });
      throw new Error("download ended early");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await (deps.sleep ?? Bun.sleep)(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** A browser runtime download in progress, as the dashboard shows it. */
export interface RuntimeDownload {
  /** Browser family waiting for an engine or font-pack download. */
  runtime: "aliasmode" | "cloakbrowser" | "firefox";
  receivedBytes: number;
  totalBytes: number;
}

const activeDownloads = new Map<string, Omit<RuntimeDownload, "receivedBytes">>();

/**
 * Report the download into `partial` as in progress until `download` settles. Its
 * progress is the size of `partial`, so this only observes the download.
 */
export async function trackRuntimeDownload<T>(
  runtime: RuntimeDownload["runtime"],
  partial: string,
  totalBytes: number,
  download: () => Promise<T>,
): Promise<T> {
  activeDownloads.set(partial, { runtime, totalBytes });
  try {
    return await download();
  } finally {
    activeDownloads.delete(partial);
  }
}

/** The browser runtime downloads in progress now. */
export function runtimeDownloads(): RuntimeDownload[] {
  return [...activeDownloads].map(([partial, { runtime, totalBytes }]) => {
    const size = statSync(partial, { throwIfNoEntry: false })?.size ?? 0;
    return { runtime, receivedBytes: totalBytes > 0 ? Math.min(size, totalBytes) : size, totalBytes };
  });
}
