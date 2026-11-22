import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { ProfileStore } from "../../store.ts";
import {
  checkVaultProxiesBatch,
  checkVaultProxy,
  clampVaultCheckConcurrency,
  medianLatencyMs,
  type VaultCheckStreamEvent,
} from "./proxy-vault-check.ts";
import { ProxyVaultStore } from "./proxy-vault-store.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function startEgressOrigin(payload: Record<string, unknown>, delayMs = 0): Promise<{ port: number; url: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const send = () => {
          if (!socket.destroyed) {
            socket.end(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
          }
        };
        if (delayMs > 0) setTimeout(send, delayMs);
        else send();
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      resolve({ port, url: `http://127.0.0.1:${port}/json` });
    });
  });
}

function handleHttpProxySocket(
  client: Socket,
  options: { requiredAuth?: string; targetPort: number },
): void {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    client.off("data", onData);
    const head = buf.subarray(0, end).toString("latin1");
    const lines = head.split("\r\n");
    const authLine = lines.find((line) => /^proxy-authorization:/i.test(line));
    const providedAuth = authLine ? authLine.slice(authLine.indexOf(":") + 1).trim() : "";
    if (options.requiredAuth && providedAuth !== options.requiredAuth) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = createConnection({ host: "127.0.0.1", port: options.targetPort }, () => {
      upstream.write("GET /json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
  client.on("data", onData);
  client.on("error", () => {});
}

function startHttpUpstreamProxy(options: {
  user?: string;
  pass?: string;
  targetPort: number;
  tls?: { key: Buffer; cert: Buffer };
}): Promise<{ port: number }> {
  const requiredAuth = options.user
    ? "Basic " + Buffer.from(`${options.user}:${options.pass ?? ""}`).toString("base64")
    : undefined;
  return new Promise((resolve, reject) => {
    let server: Server | TlsServer;
    if (options.tls) {
      server = createTlsServer(options.tls, (socket) =>
        handleHttpProxySocket(socket, { requiredAuth, targetPort: options.targetPort }),
      );
    } else {
      server = createServer((socket) =>
        handleHttpProxySocket(socket, { requiredAuth, targetPort: options.targetPort }),
      );
    }
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      resolve({ port });
    });
  });
}

function startSocks5UpstreamProxy(options: {
  user: string;
  pass: string;
  targetPort: number;
}): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      let stage: "greeting" | "auth" | "connect" | "pipe" = "greeting";
      let buf = Buffer.alloc(0);
      let upstream: Socket | null = null;
      client.on("error", () => upstream?.destroy());
      client.on("close", () => upstream?.destroy());
      client.on("data", (rawChunk) => {
        const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
        if (stage === "pipe") {
          upstream?.write(chunk);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        if (stage === "greeting" && buf.length >= 3) {
          const nMethods = buf[1]!;
          if (buf.length < 2 + nMethods) return;
          const methods = buf.subarray(2, 2 + nMethods);
          buf = buf.subarray(2 + nMethods);
          if (!methods.includes(2)) {
            client.end(Buffer.from([5, 0xff]));
            return;
          }
          client.write(Buffer.from([5, 2]));
          stage = "auth";
        }
        if (stage === "auth" && buf.length >= 2) {
          const ulen = buf[1]!;
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen]!;
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString("utf8");
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
          buf = buf.subarray(3 + ulen + plen);
          if (user !== options.user || pass !== options.pass) {
            client.end(Buffer.from([1, 1]));
            return;
          }
          client.write(Buffer.from([1, 0]));
          stage = "connect";
        }
        if (stage === "connect" && buf.length >= 5) {
          const atyp = buf[3]!;
          let reqLen = 0;
          if (atyp === 3) {
            const dlen = buf[4]!;
            reqLen = 5 + dlen + 2;
          } else if (atyp === 1) {
            reqLen = 4 + 4 + 2;
          } else {
            client.destroy();
            return;
          }
          if (buf.length < reqLen) return;
          const rest = buf.subarray(reqLen);
          buf = Buffer.alloc(0);
          stage = "pipe";
          upstream = createConnection({ host: "127.0.0.1", port: options.targetPort }, () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (rest.length > 0) upstream!.write(rest);
          });
          upstream.on("data", (d) => client.write(d));
          upstream.on("close", () => client.destroy());
          upstream.on("error", () => client.destroy());
        }
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      resolve({ port });
    });
  });
}

describe("proxy-vault-check", () => {
  test("medianLatencyMs & clampVaultCheckConcurrency calculate exact bounds", () => {
    expect(medianLatencyMs([])).toBeNull();
    expect(medianLatencyMs([120])).toBe(120);
    expect(medianLatencyMs([300, 100, 140])).toBe(140);
    expect(medianLatencyMs([100, 200, 300, 400])).toBe(250);
    expect(clampVaultCheckConcurrency(undefined)).toBe(4);
    expect(clampVaultCheckConcurrency(0)).toBe(1);
    expect(clampVaultCheckConcurrency(6)).toBe(6);
    expect(clampVaultCheckConcurrency(99)).toBe(8);
  });

  test("checks HTTP, HTTPS, and SOCKS5 upstreams through proxy-relay and ignores system proxy env vars", async () => {
    const prevEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
    };
    // Poison system proxy env vars to prove egress-transport never consults them.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1";
    cleanups.push(() => {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const origin = await startEgressOrigin({
      ip: "203.0.113.42",
      country: "US",
      region: "California",
      city: "San Jose",
    });

    const httpProxy = await startHttpUpstreamProxy({ user: "u1", pass: "p1", targetPort: origin.port });
    const key = readFileSync(new URL("../../test-fixtures/egress-tls/key.pem", import.meta.url));
    const cert = readFileSync(new URL("../../test-fixtures/egress-tls/cert.pem", import.meta.url));
    const httpsProxy = await startHttpUpstreamProxy({
      user: "u2",
      pass: "p2",
      targetPort: origin.port,
      tls: { key, cert },
    });
    const socksProxy = await startSocks5UpstreamProxy({ user: "u3", pass: "p3", targetPort: origin.port });

    const directBaseline = { ip: "198.51.100.1" };

    // 1. HTTP upstream through real proxy-relay + egress-transport
    const httpRes = await checkVaultProxy(
      { type: "http", host: "127.0.0.1", port: String(httpProxy.port), user: "u1", pass: "p1" },
      {
        endpoints: [origin.url],
        direct: directBaseline,
        attempts: 3,
      },
    );
    expect(httpRes.status).toBe("working");
    expect(httpRes.ip).toBe("203.0.113.42");
    expect(httpRes.country).toBe("US");
    expect(httpRes.exitComparison).toBe("different");
    expect(httpRes.latencyMs).toBeNumber();
    expect(httpRes.latencyMs!).toBeGreaterThanOrEqual(0);

    // Deterministic median RTT calculation across 3 concurrent attempts:
    // All 3 start at t=1000, then complete at t=1080, 1045, 1020 -> RTTs [80, 45, 20] -> median 45ms.
    const clockTicks = [1000, 1000, 1000, 1080, 1045, 1020];
    let clockIdx = 0;
    const rttRes = await checkVaultProxy(
      { type: "http", host: "127.0.0.1", port: String(httpProxy.port), user: "u1", pass: "p1" },
      {
        endpoints: [origin.url],
        direct: directBaseline,
        attempts: 3,
        relayFactory: async () => ({ port: 44441, close: () => {} }),
        fetchEgress: async (_endpoint, opts) => {
          expect(opts.relayPort).toBe(44441);
          return new Response(JSON.stringify({ ip: "203.0.113.42" }), { status: 200 });
        },
        nowMs: () => clockTicks[clockIdx++] ?? 2000,
      },
    );
    expect(rttRes.status).toBe("working");
    expect(rttRes.latencyMs).toBe(45);

    // Wrong credentials -> authentication_failed, NEVER falls back to direct
    const badAuthRes = await checkVaultProxy(
      { type: "http", host: "127.0.0.1", port: String(httpProxy.port), user: "u1", pass: "wrong" },
      { endpoints: [origin.url], direct: directBaseline, attempts: 2 },
    );
    expect(badAuthRes.status).toBe("failed");
    expect(badAuthRes.reason).toBe("authentication_failed");
    expect(badAuthRes.latencyMs).toBeNull();

    // 2. HTTPS upstream proxy
    const httpsRes = await checkVaultProxy(
      { type: "https", host: "127.0.0.1", port: String(httpsProxy.port), user: "u2", pass: "p2" },
      {
        endpoints: [origin.url],
        direct: directBaseline,
        attempts: 2,
        relayOptions: { tls: { rejectUnauthorized: false } },
      },
    );
    expect(httpsRes.status).toBe("working");
    expect(httpsRes.ip).toBe("203.0.113.42");
    expect(httpsRes.latencyMs).toBeNumber();

    // 3. SOCKS5 upstream proxy
    const socksRes = await checkVaultProxy(
      { type: "socks5", host: "127.0.0.1", port: String(socksProxy.port), user: "u3", pass: "p3" },
      { endpoints: [origin.url], direct: directBaseline, attempts: 2 },
    );
    expect(socksRes.status).toBe("working");
    expect(socksRes.ip).toBe("203.0.113.42");
    expect(socksRes.latencyMs).toBeNumber();
  });

  test("never falls back to direct egress when proxy is unreachable", async () => {
    const origin = await startEgressOrigin({ ip: "198.51.100.99" });
    // Grab an unused closed port
    const temp = createServer();
    await new Promise<void>((r) => temp.listen(0, "127.0.0.1", r));
    const deadPort = (temp.address() as { port: number }).port;
    await new Promise<void>((r) => temp.close(() => r()));

    const res = await checkVaultProxy(
      { type: "http", host: "127.0.0.1", port: String(deadPort), user: "", pass: "" },
      { endpoints: [origin.url], direct: { ip: "198.51.100.99" }, attempts: 2, timeoutMs: 2000 },
    );
    expect(res.status).toBe("failed");
    expect(res.ip).toBeUndefined();
    expect(res.latencyMs).toBeNull();
  });

  test("batch check fetches direct egress once, detects same_exit, persists results, and honors AbortSignal", async () => {
    const store = new ProfileStore(":memory:");
    cleanups.push(() => store.close());
    const vault = new ProxyVaultStore(store);

    const originSame = await startEgressOrigin({ ip: "198.51.100.1", country: "JP" });
    const originDiff = await startEgressOrigin({ ip: "203.0.113.77", country: "DE" });
    const proxySame = await startHttpUpstreamProxy({ targetPort: originSame.port });
    const proxyDiff = await startHttpUpstreamProxy({ targetPort: originDiff.port });

    const item1 = vault.create({ name: "SameExit", type: "http", host: "127.0.0.1", port: proxySame.port });
    const item2 = vault.create({ name: "DiffExit", type: "http", host: "127.0.0.1", port: proxyDiff.port });

    let directCalls = 0;
    const events: VaultCheckStreamEvent[] = [];
    const records = vault.selectForCheck({ all: true });

    await checkVaultProxiesBatch(
      records,
      (ev) => events.push(ev),
      {
        vaultStore: vault,
        concurrency: 2,
        attempts: 2,
        endpoints: [originSame.url], // proxySame -> originSame, proxyDiff ignores path and routes to originDiff
        fetchDirect: async () => {
          directCalls++;
          return { ip: "198.51.100.1" };
        },
      },
    );

    expect(directCalls).toBe(1);
    expect(events[0]).toEqual({ type: "start", total: 2, concurrency: 2 });
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", total: 2, completed: 2, working: 2, cancelled: false });

    const view1 = vault.getView(item1.id)!;
    expect(view1.lastStatus).toBe("working");
    expect(view1.lastReason).toBe("same_exit");
    expect(view1.lastExitComparison).toBe("same");
    expect(view1.riskLevel).toBe("high");
    expect(view1.risks.some((r) => r.code === "same_host_exit")).toBe(true);

    const view2 = vault.getView(item2.id)!;
    expect(view2.lastStatus).toBe("working");
    expect(view2.lastExitIp).toBe("203.0.113.77");
    expect(view2.lastExitCountry).toBe("DE");
    expect(view2.lastExitComparison).toBe("different");
    expect(view2.lastLatencyMs).toBeNumber();

    // Pre-aborted signal terminates immediately without running workers
    const aborted = new AbortController();
    aborted.abort();
    const cancelEvents: VaultCheckStreamEvent[] = [];
    await checkVaultProxiesBatch(records, (ev) => cancelEvents.push(ev), { signal: aborted.signal });
    expect(cancelEvents.at(-1)).toMatchObject({ type: "done", completed: 0, cancelled: true });
  });
});
