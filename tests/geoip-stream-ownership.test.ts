import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { lookupExitLocation, type FetchLike } from "../geoip.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const proxy = { type: "http" as const, host: "synthetic.invalid", port: "8080", user: "", pass: "" };
async function relayOpen(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

test("default location lookup still returns the preferred answer before a slow sibling", async () => {
  const waiting = deferred();
  let siblingSettled = false, siblingSignal: AbortSignal | null | undefined;
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("geojs")) return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
    siblingSignal = init.signal;
    await waiting.promise; siblingSettled = true;
    return Response.json({ status: "success", timezone: "Asia/Tokyo" });
  };
  try {
    const result = await lookupExitLocation(null, fetch);
    expect(result).toEqual({ timezone: "Europe/Paris", country: "FR" });
    expect(siblingSettled).toBe(false);
    expect(siblingSignal?.aborted).toBe(false);
  } finally { waiting.resolve(); await tick(); }
});

test("settlePending aborts redundant checks and keeps the relay until their cleanup finishes", async () => {
  const waiting = deferred(), aborted = deferred();
  let endpoint = "", settled = false;
  const fetch: FetchLike = async (url, init) => {
    endpoint = (init as RequestInit & { proxy: string }).proxy;
    if (url.includes("geojs")) return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
    await new Promise<void>(resolve => {
      if (init.signal!.aborted) resolve();
      else init.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted.resolve(); await waiting.promise;
    throw new DOMException("Synthetic sibling stopped", "AbortError");
  };
  const location = lookupExitLocation(proxy, fetch, { settlePending: true }).then(result => { settled = true; return result; });
  try {
    await aborted.promise;
    expect(settled).toBe(false);
    expect(await relayOpen(endpoint)).toBe(true);
    waiting.resolve();
    expect(await location).toEqual({ timezone: "Europe/Paris", country: "FR" });
    expect(await relayOpen(endpoint)).toBe(false);
  } finally { waiting.resolve(); await location; }
});

test("settlePending retains the existing per-check abort deadlines when no source answers", async () => {
  let active = 0, aborted = 0, calls = 0;
  const fetch: FetchLike = async (_url, init) => {
    calls++; active++;
    try {
      await new Promise<never>((_resolve, reject) => {
        const stop = () => { aborted++; reject(init.signal!.reason); };
        if (init.signal!.aborted) stop();
        else init.signal!.addEventListener("abort", stop, { once: true });
      });
      return Response.json({});
    } finally { active--; }
  };
  // The production socket transport keeps the loop alive; this fully synthetic
  // pending fetch needs the same for Bun's unreferenced AbortSignal timers.
  const keepAlive = setInterval(() => {}, 5);
  try {
    expect(await lookupExitLocation(null, fetch, { settlePending: true, timeoutMs: 15, geojsTimeoutMs: 10 })).toBeNull();
    expect(calls).toBe(3);
    expect(aborted).toBe(3);
    expect(active).toBe(0);
  } finally { clearInterval(keepAlive); }
});
