import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import {
  isBlockedIp,
  ProxyRefreshCooldown,
  ProxyRefreshError,
  REFRESH_URL_MAX_BODY_BYTES,
  triggerProxyRefreshUrl,
  validateRefreshUrlSyntax,
  type RefreshDnsLookup,
  type RefreshTcpConnector,
} from "./proxy-refresh-url.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function connectLoopback(port: number): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function startTestHttpServer(
  handler: (req: Request) => Response | Promise<Response>,
  tls?: { key: Buffer; cert: Buffer },
): { port: number; requests: Array<{ target: string; host: string | null; cookie: string | null }> } {
  const requests: Array<{ target: string; host: string | null; cookie: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(tls ? { tls } : {}),
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        target: `${url.pathname}${url.search}`,
        host: req.headers.get("host"),
        cookie: req.headers.get("cookie"),
      });
      return handler(req);
    },
  });
  cleanups.push(() => {
    server.stop(true);
  });
  return { port: server.port!, requests };
}

describe("validateRefreshUrlSyntax & isBlockedIp", () => {
  test("accepts valid public http/https refresh URLs and strips fragment", () => {
    const res = validateRefreshUrlSyntax("https://api.residential-provider.example/v1/rotate?key=secret#frag");
    expect(res.host).toBe("api.residential-provider.example");
    expect(res.displayHost).toBe("api.residential-provider.example");
    expect(res.port).toBe(443);
    expect(res.url.hash).toBe("");
  });

  test("rejects disallowed schemes, credentials, local domains, single-label hosts, and oversized URLs", () => {
    const secret = "TOP_SECRET_API_KEY_12345";
    const badUrls = [
      `file:///etc/passwd?k=${secret}`,
      `ftp://api.example.com/rotate?k=${secret}`,
      `https://user:pass@api.example.com/rotate?k=${secret}`,
      `https://@api.example.com/rotate?k=${secret}`,
      `http://localhost/rotate?k=${secret}`,
      `http://metadata/computeMetadata/v1?k=${secret}`,
      `https://sub.localhost/rotate?k=${secret}`,
      `https://gateway.local/rotate?k=${secret}`,
      `https://service.internal/rotate?k=${secret}`,
      `http://0x7f000001/rotate?k=${secret}`,
      `http://2130706433/rotate?k=${secret}`,
      `http://169.254.169.254/latest/meta-data/?k=${secret}`,
      `https://api.example.com/${"a".repeat(2040)}?k=${secret}`,
    ];

    for (const url of badUrls) {
      let caught: unknown;
      try {
        validateRefreshUrlSyntax(url);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProxyRefreshError);
      expect((caught as Error).message).not.toContain(secret);
      expect((caught as Error).message).not.toContain("api.example.com/");
    }
  });

  test("blocks all private, loopback, link-local, CGNAT, multicast, reserved, and IPv4-mapped IPv6 ranges", () => {
    const blocked = [
      "0.0.0.0",
      "0.12.34.56",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.0.0.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.19.255.254",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "febf::ffff",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.5",
      "::ffff:7f00:1",
      "::ffff:0:127.0.0.1",
      "::ffff:0:169.254.169.254",
      "::ffff:0:10.0.0.1",
      "64:ff9b::127.0.0.1",
      "2002:7f00:0001::1",
      "not-an-ip",
    ];
    for (const ip of blocked) {
      expect(isBlockedIp(ip)).toBe(true);
    }

    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.0.1.1",
      "198.17.255.255",
      "198.20.0.1",
      "203.0.113.10",
      "2606:4700:4700::1111",
      "::ffff:93.184.216.34",
      "::ffff:0:93.184.216.34",
    ];
    for (const ip of allowed) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});

describe("triggerProxyRefreshUrl SSRF & pinning behavior", () => {
  test("pins resolved public IP directly to TCP connector and sends Host header without Cookie", async () => {
    const server = startTestHttpServer(() =>
      new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const connectedTargets: Array<{ ip: string; port: number; family: 4 | 6 }> = [];
    const lookupCalls: string[] = [];
    const lookupFn: RefreshDnsLookup = async (host) => {
      lookupCalls.push(host);
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const connectTcp: RefreshTcpConnector = async (ip, port, family) => {
      connectedTargets.push({ ip, port, family });
      return connectLoopback(server.port);
    };

    const result = await triggerProxyRefreshUrl("http://rotate.provider.example/change?token=SECRET_XYZ", {
      lookupFn,
      connectTcp,
    });

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.redirects).toBe(0);
    expect(lookupCalls).toEqual(["rotate.provider.example"]);
    expect(connectedTargets).toEqual([{ ip: "93.184.216.34", port: 80, family: 4 }]);
    expect(server.requests[0]).toEqual({
      target: "/change?token=SECRET_XYZ",
      host: "rotate.provider.example",
      cookie: null,
    });
  });

  test("rejects DNS rebinding response containing any private IP alongside a public IP", async () => {
    let dialed = false;
    const lookupFn: RefreshDnsLookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const connectTcp: RefreshTcpConnector = async () => {
      dialed = true;
      throw new Error("should not dial");
    };

    const secret = "REBIND_SECRET_TOKEN_777";
    let caught: unknown;
    try {
      await triggerProxyRefreshUrl(`http://rebind.provider.example/api?secret=${secret}`, {
        lookupFn,
        connectTcp,
      });
    } catch (err) {
      caught = err;
    }
    expect(dialed).toBe(false);
    expect(caught).toBeInstanceOf(ProxyRefreshError);
    expect((caught as ProxyRefreshError).code).toBe("ssrf_blocked");
    expect((caught as Error).message).not.toContain(secret);
  });

  test("follows up to 2 redirects with per-hop validation, blocks 3rd hop and private redirect target", async () => {
    const server = startTestHttpServer((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/hop1") {
        return new Response(null, { status: 302, headers: { Location: "http://hop2.provider.example/hop2" } });
      }
      if (path === "/hop2") {
        return new Response(null, { status: 301, headers: { Location: "http://hop3.provider.example/final" } });
      }
      if (path === "/to-private") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      if (path === "/loop") {
        return new Response(null, { status: 302, headers: { Location: "http://hop.provider.example/loop" } });
      }
      return new Response("ok", { status: 200 });
    });

    const lookupFn: RefreshDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const connectTcp: RefreshTcpConnector = async () => connectLoopback(server.port);

    // Exactly 2 redirects succeeds
    const okRes = await triggerProxyRefreshUrl("http://hop1.provider.example/hop1", { lookupFn, connectTcp });
    expect(okRes.redirects).toBe(2);
    expect(okRes.httpStatus).toBe(200);

    // Redirect to private IP blocked without echoing token
    const pvtErr = await triggerProxyRefreshUrl("http://hop1.provider.example/to-private?tok=SECRET_PVT", {
      lookupFn,
      connectTcp,
    }).catch((err) => err);
    expect(pvtErr).toBeInstanceOf(ProxyRefreshError);
    expect((pvtErr as ProxyRefreshError).code).toBe("ssrf_blocked");
    expect((pvtErr as Error).message).not.toContain("SECRET_PVT");

    // More than 2 redirects blocked
    const loopErr = await triggerProxyRefreshUrl("http://hop.provider.example/loop?tok=SECRET_LOOP", {
      lookupFn,
      connectTcp,
    }).catch((err) => err);
    expect(loopErr).toBeInstanceOf(ProxyRefreshError);
    expect((loopErr as ProxyRefreshError).code).toBe("too_many_redirects");
    expect((loopErr as Error).message).not.toContain("SECRET_LOOP");
  });

  test("enforces 16 KiB response body limit and timeout without echoing refresh URL", async () => {
    const exactBody = "x".repeat(REFRESH_URL_MAX_BODY_BYTES);
    const oversizedBody = "x".repeat(REFRESH_URL_MAX_BODY_BYTES + 1);
    const server = startTestHttpServer((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/exact") return new Response(exactBody, { status: 200 });
      if (path === "/oversized") return new Response(oversizedBody, { status: 200 });
      return new Promise<Response>(() => {});
    });

    const lookupFn: RefreshDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const connectTcp: RefreshTcpConnector = async () => connectLoopback(server.port);

    const exact = await triggerProxyRefreshUrl("http://size.provider.example/exact", { lookupFn, connectTcp });
    expect(exact.httpStatus).toBe(200);

    const secret = "SIZE_SECRET_TOKEN_888";
    const errLarge = await triggerProxyRefreshUrl(`http://size.provider.example/oversized?key=${secret}`, {
      lookupFn,
      connectTcp,
    }).catch((err) => err);
    expect(errLarge).toBeInstanceOf(ProxyRefreshError);
    expect((errLarge as ProxyRefreshError).code).toBe("response_too_large");
    expect((errLarge as Error).message).not.toContain(secret);

    const errTimeout = await triggerProxyRefreshUrl(`http://slow.provider.example/hang?key=${secret}`, {
      lookupFn,
      connectTcp,
      timeoutMs: 80,
    }).catch((err) => err);
    expect(errTimeout).toBeInstanceOf(ProxyRefreshError);
    expect((errTimeout as ProxyRefreshError).code).toBe("timeout");
    expect((errTimeout as Error).message).not.toContain(secret);
  });

  test("TLS IP pinning verifies SNI/certificate and blocks HTTPS->HTTP redirect downgrade", async () => {
    const key = readFileSync(new URL("../../test-fixtures/egress-tls/key.pem", import.meta.url));
    const cert = readFileSync(new URL("../../test-fixtures/egress-tls/cert.pem", import.meta.url));
    const tlsServer = startTestHttpServer(
      (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/downgrade") {
          return new Response(null, { status: 302, headers: { Location: "http://maobu-egress.test/final" } });
        }
        return new Response('{"rotated":true}', { status: 200, headers: { "Content-Type": "application/json" } });
      },
      { key, cert },
    );

    const lookupFn: RefreshDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const connectTcp: RefreshTcpConnector = async (ip) => {
      expect(ip).toBe("93.184.216.34");
      return connectLoopback(tlsServer.port);
    };

    const okRes = await triggerProxyRefreshUrl("https://maobu-egress.test/rotate?token=TLS_SECRET", {
      lookupFn,
      connectTcp,
      tlsOptions: { ca: cert },
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.httpStatus).toBe(200);

    // Wrong hostname must fail TLS verification even with trusted CA
    const wrongHostErr = await triggerProxyRefreshUrl("https://wrong-host.example/rotate?token=TLS_SECRET", {
      lookupFn,
      connectTcp,
      tlsOptions: { ca: cert },
    }).catch((err) => err);
    expect(wrongHostErr).toBeInstanceOf(ProxyRefreshError);
    expect((wrongHostErr as ProxyRefreshError).code).toBe("request_failed");
    expect((wrongHostErr as Error).message).not.toContain("TLS_SECRET");

    // HTTPS -> HTTP redirect downgrade must be blocked
    const downgradeErr = await triggerProxyRefreshUrl("https://maobu-egress.test/downgrade?token=TLS_SECRET", {
      lookupFn,
      connectTcp,
      tlsOptions: { ca: cert },
    }).catch((err) => err);
    expect(downgradeErr).toBeInstanceOf(ProxyRefreshError);
    expect((downgradeErr as ProxyRefreshError).code).toBe("https_downgrade");
    expect((downgradeErr as Error).message).not.toContain("TLS_SECRET");
  });

  test("classifies TCP connect-phase and TLS handshake-phase timeouts as 504 timeout and caller aborts as 499 aborted", async () => {
    const lookupFn: RefreshDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const secret = "HANDSHAKE_SECRET_999";

    // 1. TCP connect hangs until timeout -> 504 timeout (not 499 aborted)
    const connectTimeoutErr = await triggerProxyRefreshUrl(
      `http://connect-slow.provider.example/rotate?token=${secret}`,
      {
        lookupFn,
        timeoutMs: 60,
        connectTcp: (_ip, _port, _family, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new ProxyRefreshError("aborted during connect", "aborted", 499)),
            );
          }),
      },
    ).catch((err) => err);
    expect(connectTimeoutErr).toBeInstanceOf(ProxyRefreshError);
    expect((connectTimeoutErr as ProxyRefreshError).code).toBe("timeout");
    expect((connectTimeoutErr as ProxyRefreshError).status).toBe(504);
    expect((connectTimeoutErr as Error).message).not.toContain(secret);

    // 2. TCP connects immediately to a silent peer that never replies to TLS ClientHello -> 504 timeout
    const silentTcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    cleanups.push(() => {
      silentTcp.stop(true);
    });

    const tlsTimeoutErr = await triggerProxyRefreshUrl(
      `https://maobu-egress.test/rotate?token=${secret}`,
      {
        lookupFn,
        timeoutMs: 80,
        connectTcp: async () => connectLoopback(silentTcp.port),
      },
    ).catch((err) => err);
    expect(tlsTimeoutErr).toBeInstanceOf(ProxyRefreshError);
    expect((tlsTimeoutErr as ProxyRefreshError).code).toBe("timeout");
    expect((tlsTimeoutErr as ProxyRefreshError).status).toBe(504);
    expect((tlsTimeoutErr as Error).message).not.toContain(secret);

    // 3. External caller abort during TLS handshake -> 499 aborted (not 504 timeout)
    const external = new AbortController();
    setTimeout(() => external.abort(), 40);
    const tlsAbortErr = await triggerProxyRefreshUrl(
      `https://maobu-egress.test/rotate?token=${secret}`,
      {
        lookupFn,
        timeoutMs: 5_000,
        signal: external.signal,
        connectTcp: async () => connectLoopback(silentTcp.port),
      },
    ).catch((err) => err);
    expect(tlsAbortErr).toBeInstanceOf(ProxyRefreshError);
    expect((tlsAbortErr as ProxyRefreshError).code).toBe("aborted");
    expect((tlsAbortErr as ProxyRefreshError).status).toBe(499);
    expect((tlsAbortErr as Error).message).not.toContain(secret);
  });

  test("ProxyRefreshCooldown enforces per-proxy 5s cooldown and in-flight exclusivity", () => {
    const cooldown = new ProxyRefreshCooldown(5_000);
    const first = cooldown.tryAcquire("pxv_0000000000000001", 0, 10_000);
    expect(first.ok).toBe(true);

    // Concurrent in-flight request blocked
    const concurrent = cooldown.tryAcquire("pxv_0000000000000001", 0, 10_100);
    expect(concurrent.ok).toBe(false);

    // Other proxy is independent
    const other = cooldown.tryAcquire("pxv_0000000000000002", 0, 10_100);
    expect(other.ok).toBe(true);
    if (other.ok) other.release(10_200);

    if (first.ok) first.release(10_500);

    // Within 5s of completion -> blocked with remaining retryAfterMs
    const tooSoon = cooldown.tryAcquire("pxv_0000000000000001", 10_500, 12_500);
    expect(tooSoon).toEqual({ ok: false, retryAfterMs: 3_000 });

    // After 5s -> allowed
    const allowed = cooldown.tryAcquire("pxv_0000000000000001", 10_500, 15_500);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) allowed.release(15_600);
  });
});
