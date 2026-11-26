import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelRuntimeDownload,
  downloadResumable,
  pauseRuntimeDownload,
  resumeRuntimeDownload,
  RuntimeDownloadCancelledError,
  runtimeDownloads,
  trackRuntimeDownload,
  writeDownloadChunk,
  type ResumableDownloadDeps,
} from "./runtime-download.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function partialFile(): string {
  const root = mkdtempSync(join(tmpdir(), "maobu-runtime-download-"));
  roots.push(root);
  return join(root, "download.part");
}

const bytes = (...values: number[]) => new Uint8Array(values);
const defaults = { attempts: 1, stallMs: 1_000, sleep: async () => {} };

function source(chunks: Uint8Array[], options: { neverEnd?: boolean; neverFinishCancel?: boolean } = {}) {
  let index = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else if (!options.neverEnd) controller.close();
    },
    cancel() {
      cancellations++;
      if (options.neverFinishCancel) return new Promise<void>(() => {});
    },
  });
  return { stream, get cancellations() { return cancellations; } };
}

function transport(response: Response) {
  let signal: AbortSignal | undefined;
  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
    signal = init.signal ?? undefined;
    return response;
  };
  return { fetch, get signal() { return signal; } };
}

test("saves exact bytes and reports the bytes actually written", async () => {
  const partial = partialFile();
  const body = source([bytes(1, 2), bytes(3, 4)]);
  const response = new Response(body.stream, { headers: { "content-length": "4" } });
  const request = transport(response);
  const progress: number[] = [];

  await downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, fetch: request.fetch }, (count) => progress.push(count));

  expect([...readFileSync(partial)]).toEqual([1, 2, 3, 4]);
  expect(progress).toEqual([0, 2, 4]);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
});

test("rejects an oversized chunk before writing it and cancels an endless response", async () => {
  const partial = partialFile();
  const body = source([bytes(1, 2), bytes(3, 4, 5)], { neverEnd: true });
  const response = new Response(body.stream);
  const request = transport(response);
  const progress: number[] = [];

  await expect(downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, fetch: request.fetch }, (count) => progress.push(count)))
    .rejects.toThrow("exceeds its pinned size");

  expect(progress).toEqual([0, 2]);
  expect(existsSync(partial)).toBe(false);
  expect(body.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
});

test("an oversized response is discarded before retrying from byte zero", async () => {
  const partial = partialFile();
  const ranges: Array<string | null> = [];
  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
    ranges.push(new Headers(init.headers).get("range"));
    return new Response(ranges.length === 1 ? bytes(1, 2, 3) : bytes(1, 2));
  };

  await downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, attempts: 2, fetch });

  expect(ranges).toEqual([null, null]);
  expect([...readFileSync(partial)]).toEqual([1, 2]);
});

test("times out a body that ignores abort and does not await its unfinished cancellation", async () => {
  const partial = partialFile();
  const body = source([bytes(1, 2)], { neverEnd: true, neverFinishCancel: true });
  const response = new Response(body.stream);
  const request = transport(response);

  await expect(downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, stallMs: 20, fetch: request.fetch }))
    .rejects.toThrow("download stalled");

  expect(statSync(partial).size).toBe(2);
  expect(body.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
  // The attempt has closed its file handle before it rejects.
  rmSync(partial);
}, 1_000);

test("requires the response to finish even after receiving the pinned byte count", async () => {
  const partial = partialFile();
  const bodies: ReturnType<typeof source>[] = [];
  const responses: Response[] = [];
  const ranges: Array<string | null> = [];
  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
    const body = source([bytes(1, 2)], { neverEnd: true });
    const response = new Response(body.stream);
    bodies.push(body);
    responses.push(response);
    ranges.push(new Headers(init.headers).get("range"));
    return response;
  };

  await expect(downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, attempts: 2, stallMs: 20, fetch }))
    .rejects.toThrow("download stalled");

  expect(ranges).toEqual([null, null]);
  expect(existsSync(partial)).toBe(false);
  expect(bodies.map((body) => body.cancellations)).toEqual([1, 1]);
  expect(responses.every((response) => !response.body!.locked)).toBe(true);
}, 1_000);

test("times out a transport that ignores abort and cancels a response arriving later", async () => {
  const partial = partialFile();
  const body = source([], { neverEnd: true });
  const response = new Response(body.stream);
  let answer!: (response: Response) => void;
  const fetch = () => new Promise<Response>((resolve) => { answer = resolve; });

  await expect(downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, stallMs: 20, fetch }))
    .rejects.toThrow("download stalled");
  answer(response);
  await Promise.resolve();

  expect(body.cancellations).toBe(1);
  expect(existsSync(partial)).toBe(false);
}, 1_000);

test("cancels an unread HTTP error body and keeps an existing valid prefix", async () => {
  const partial = partialFile();
  writeFileSync(partial, bytes(1));
  const body = source([], { neverEnd: true });
  const response = new Response(body.stream, { status: 503 });
  const request = transport(response);

  await expect(downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, fetch: request.fetch }))
    .rejects.toThrow("HTTP 503");

  expect([...readFileSync(partial)]).toEqual([1]);
  expect(body.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
});

test("cancels the body and closes the file when a progress listener throws", async () => {
  const partial = partialFile();
  const body = source([bytes(1)], { neverEnd: true });
  const response = new Response(body.stream);
  const request = transport(response);

  await expect(downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, fetch: request.fetch }, (count) => {
    if (count > 0) throw new Error("listener failed");
  })).rejects.toThrow("listener failed");

  expect(body.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
  expect([...readFileSync(partial)]).toEqual([1]);
  rmSync(partial);
});

test("cancels the body and releases its reader if the output file cannot be opened", async () => {
  const partial = join(partialFile(), "missing", "download.part");
  const body = source([], { neverEnd: true });
  const response = new Response(body.stream);
  const request = transport(response);

  await expect(downloadResumable("https://fixture.test/file", partial, 2, { ...defaults, fetch: request.fetch }))
    .rejects.toThrow();

  expect(body.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(request.signal!.aborted).toBe(true);
});

test("retries a cleanly truncated response from its actual saved length", async () => {
  const partial = partialFile();
  const ranges: Array<string | null> = [];
  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
    const range = new Headers(init.headers).get("range");
    ranges.push(range);
    return range === null ? new Response(bytes(1, 2))
      : new Response(bytes(3, 4), { status: 206, headers: { "content-range": "bytes 2-3/4", "content-length": "2" } });
  };

  await downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, attempts: 2, fetch });

  expect(ranges).toEqual([null, "bytes=2-"]);
  expect([...readFileSync(partial)]).toEqual([1, 2, 3, 4]);
});

test("rejects malformed or mismatched resume ranges and restarts with a fresh request", async () => {
  const invalid = [
    "bytes 2-garbage", "bytes 1-3/4", "bytes 2-2/4", "bytes 2-4/4", "bytes 2-3/5",
    "bytes 2-3/*", "bytes 2-3/4 extra", "bytes 9007199254740992-9007199254740993/9007199254740994",
  ];
  for (const range of invalid) {
    const partial = partialFile();
    writeFileSync(partial, bytes(1, 2));
    const body = source([bytes(3, 4)], { neverEnd: true });
    const response = new Response(body.stream, { status: 206, headers: { "content-range": range } });
    const requested: Array<string | null> = [];
    const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
      requested.push(new Headers(init.headers).get("range"));
      return requested.length === 1 ? response : new Response(bytes(1, 2, 3, 4));
    };

    await downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, attempts: 2, fetch });

    expect(requested).toEqual(["bytes=2-", null]);
    expect(body.cancellations).toBe(1);
    expect(response.body!.locked).toBe(false);
    expect([...readFileSync(partial)]).toEqual([1, 2, 3, 4]);
  }
});

test("rejects an incorrect Content-Length before opening or writing the output", async () => {
  for (const length of ["3", "5", "4x", "9007199254740992"]) {
    const partial = partialFile();
    const body = source([bytes(1, 2, 3, 4)], { neverEnd: true });
    const response = new Response(body.stream, { headers: { "content-length": length } });

    await expect(downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, fetch: transport(response).fetch }))
      .rejects.toThrow("Content-Length does not match");

    expect(existsSync(partial)).toBe(false);
    expect(body.cancellations).toBe(1);
    expect(response.body!.locked).toBe(false);
  }
});

test("bounds decoded content independently of an encoded Content-Length", async () => {
  const partial = partialFile();
  const response = new Response(bytes(1, 2, 3, 4), { headers: { "content-length": "2", "content-encoding": "gzip" } });

  await downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, fetch: transport(response).fetch });

  expect([...readFileSync(partial)]).toEqual([1, 2, 3, 4]);
});

test("writes every byte after repeated short writes and reports actual increments", async () => {
  const saved: number[] = [];
  const progress: number[] = [];
  const offers: number[][] = [];
  const writer = {
    async write(chunk: Uint8Array) {
      offers.push([...chunk]);
      const count = Math.min(2, chunk.byteLength);
      saved.push(...chunk.subarray(0, count));
      return { bytesWritten: count };
    },
  };

  await writeDownloadChunk(writer, bytes(1, 2, 3, 4, 5), (count) => progress.push(count));

  expect(saved).toEqual([1, 2, 3, 4, 5]);
  expect(offers).toEqual([[1, 2, 3, 4, 5], [3, 4, 5], [5]]);
  expect(progress).toEqual([2, 2, 1]);
});

test("rejects zero or invalid write progress without looping or reporting unsaved bytes", async () => {
  for (const bytesWritten of [0, -1, 3, 0.5, Number.NaN]) {
    let calls = 0;
    const progress: number[] = [];
    const writer = { async write() { calls++; return { bytesWritten }; } };

    await expect(writeDownloadChunk(writer, bytes(1, 2), (count) => progress.push(count)))
      .rejects.toThrow("file write made no valid progress");

    expect(calls).toBe(1);
    expect(progress).toEqual([]);
  }
});

test("propagates a filesystem error after a successful short write", async () => {
  let calls = 0;
  const progress: number[] = [];
  const writer = {
    async write() {
      if (calls++ === 0) return { bytesWritten: 1 };
      throw new Error("disk full");
    },
  };

  await expect(writeDownloadChunk(writer, bytes(1, 2), (count) => progress.push(count))).rejects.toThrow("disk full");

  expect(calls).toBe(2);
  expect(progress).toEqual([1]);
});

test("pauses an active download, preserves partial bytes, and resumes via Range", async () => {
  const partial = partialFile();
  const ranges: Array<string | null> = [];
  let releasePausedRead!: () => void;
  const pausedReadBlocked = new Promise<void>((resolve) => { releasePausedRead = resolve; });

  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async (_url, init) => {
    const range = new Headers(init.headers).get("range");
    ranges.push(range);
    if (range === null) {
      let sentFirst = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentFirst) {
            sentFirst = true;
            controller.enqueue(bytes(1, 2));
            return;
          }
          await pausedReadBlocked;
        },
        cancel() { releasePausedRead(); },
      });
      return new Response(stream, { headers: { "content-length": "4" } });
    }
    return new Response(bytes(3, 4), {
      status: 206,
      headers: { "content-length": "2", "content-range": "bytes 2-3/4" },
    });
  };

  let pausedObserved = false;
  const run = trackRuntimeDownload("firefox", partial, 4, () =>
    downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, attempts: 1, fetch }, (written) => {
      if (written === 2 && !pausedObserved) {
        pausedObserved = true;
        queueMicrotask(() => {
          expect(pauseRuntimeDownload("firefox")).toBe(1);
          const active = runtimeDownloads();
          expect(active[0]?.status).toBe("paused");
          expect(active[0]?.bytesPerSec).toBe(0);
          expect(statSync(partial).size).toBe(2);
          setTimeout(() => {
            expect(resumeRuntimeDownload("firefox")).toBe(1);
          }, 15);
        });
      }
    }),
  );

  await run;
  expect(ranges).toEqual([null, "bytes=2-"]);
  expect([...readFileSync(partial)]).toEqual([1, 2, 3, 4]);
  expect(runtimeDownloads()).toEqual([]);
});

test("cancelling a paused download removes partial bytes and rejects cleanly", async () => {
  const partial = partialFile();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes(9, 8));
      return new Promise<void>(() => {});
    },
  });
  const fetch: NonNullable<ResumableDownloadDeps["fetch"]> = async () =>
    new Response(stream, { headers: { "content-length": "4" } });

  let triggered = false;
  const run = trackRuntimeDownload("aliasmode", partial, 4, () =>
    downloadResumable("https://fixture.test/file", partial, 4, { ...defaults, fetch }, (written) => {
      if (written === 2 && !triggered) {
        triggered = true;
        queueMicrotask(() => {
          expect(pauseRuntimeDownload("aliasmode")).toBe(1);
          expect(runtimeDownloads()).toHaveLength(1);
          expect(cancelRuntimeDownload("aliasmode")).toBe(1);
          expect(runtimeDownloads()).toEqual([]);
        });
      }
    }),
  );

  await expect(run).rejects.toBeInstanceOf(RuntimeDownloadCancelledError);
  expect(existsSync(partial)).toBe(false);
  expect(runtimeDownloads()).toEqual([]);
});
