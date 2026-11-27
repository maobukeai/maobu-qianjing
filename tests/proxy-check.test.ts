import { expect, test } from "bun:test";
import {
  checkProxy,
  classifyProxyAttempts,
  type ProxyCheckAttempt,
} from "../src/proxy-check.ts";
import { EgressResponseError } from "../src/egress-transport.ts";

const direct = { ip: "198.51.100.10" };
const exit = (ip: string) => ({ info: { ip, country: "NL" } }) satisfies ProxyCheckAttempt;
const failed = (reason: ProxyCheckAttempt["reason"] = "connection_failed") => ({ info: null, reason }) satisfies ProxyCheckAttempt;

test("proxy check classifies stable and rotating successful exits as working", () => {
  expect(classifyProxyAttempts([
    exit("203.0.113.10"),
    exit("203.0.113.10"),
    exit("203.0.113.10"),
  ], direct)).toEqual({
    status: "working",
    attempts: 3,
    successes: 3,
    ip: "203.0.113.10",
    country: "NL",
    rotating: false,
    exitComparison: "different",
  });

  expect(classifyProxyAttempts([
    exit("203.0.113.10"),
    exit("203.0.113.11"),
    exit("203.0.113.12"),
  ], direct)).toMatchObject({ status: "working", successes: 3, rotating: true });
});

test("proxy check calls only mixed connectivity unstable", () => {
  expect(classifyProxyAttempts([
    exit("203.0.113.10"),
    failed("timeout"),
    exit("203.0.113.11"),
  ], direct)).toMatchObject({
    status: "unstable",
    attempts: 3,
    successes: 2,
    reason: "intermittent",
  });
});

test("checker service failures stay neutral and never make a proven proxy unstable", () => {
  const unavailable = { info: null, reason: "check_unavailable" } as ProxyCheckAttempt;
  expect(classifyProxyAttempts([unavailable, unavailable, unavailable], direct)).toEqual({
    status: "unavailable",
    attempts: 3,
    successes: 0,
    reason: "check_unavailable",
    exitComparison: "unknown",
  });
  expect(classifyProxyAttempts([
    exit("203.0.113.10"),
    unavailable,
    unavailable,
  ], direct)).toMatchObject({ status: "working", successes: 1, ip: "203.0.113.10" });
});

test("objective proxy failures stay failed when direct egress is unavailable", () => {
  for (const reason of ["authentication_failed", "dns_failed", "unreachable"] as const) {
    expect(classifyProxyAttempts([
      failed(reason),
      failed(reason),
      failed(reason),
    ], null)).toMatchObject({ status: "failed", reason });
  }
});

test("proxy check treats checker HTTP errors as unavailable, not a bad proxy", async () => {
  const result = await checkProxy({
    type: "http",
    host: "proxy.example",
    port: "8080",
    user: "",
    pass: "",
  }, {
    endpoints: ["https://egress.test/ip"],
    relayFactory: async () => ({ port: 43000, close() {} }),
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) =>
      (init as RequestInit & { proxy?: string } | undefined)?.proxy
        ? new Response("rate limited", { status: 429 })
        : Response.json({ ip: direct.ip })) as typeof fetch,
  });

  expect(result).toEqual({
    status: "unavailable",
    attempts: 3,
    successes: 0,
    reason: "check_unavailable",
    exitComparison: "unknown",
  });
});

test("proxy check preserves HTTP 407 as an authentication failure", async () => {
  const result = await checkProxy({
    type: "http",
    host: "proxy.example",
    port: "8080",
    user: "proxy-user",
    pass: "wrong-password",
  }, {
    endpoints: ["http://egress.test/ip"],
    relayFactory: async () => ({ port: 44000, close() {} }),
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init as RequestInit & { proxy?: string } | undefined)?.proxy) {
        return new Response("proxy authentication required", { status: 407 });
      }
      throw new Error("direct egress is unavailable");
    }) as typeof fetch,
  });

  expect(result).toMatchObject({
    status: "failed",
    successes: 0,
    reason: "authentication_failed",
  });
});

test("proxy check distinguishes connection failure, shared exits, and unavailable check services", () => {
  expect(classifyProxyAttempts([
    failed("authentication_failed"),
    failed("authentication_failed"),
    failed("authentication_failed"),
  ], direct)).toMatchObject({ status: "failed", reason: "authentication_failed" });

  expect(classifyProxyAttempts([
    exit(direct.ip),
    exit(direct.ip),
    exit(direct.ip),
  ], direct)).toMatchObject({ status: "working", reason: "same_exit", exitComparison: "same", ip: direct.ip });

  expect(classifyProxyAttempts([
    failed(),
    failed(),
    failed(),
  ], null)).toEqual({
    status: "unavailable",
    attempts: 3,
    successes: 0,
    reason: "check_unavailable",
    exitComparison: "unknown",
  });
});

test("proxy check uses a fresh relay for every attempt and always closes it", async () => {
  const upstreams: unknown[] = [];
  const proxyUrls: string[] = [];
  let closed = 0;
  let nextPort = 41000;

  const result = await checkProxy({
    type: "socks5",
    host: "proxy.example",
    port: "1080",
    user: "proxy-user",
    pass: "proxy-password",
  }, {
    endpoints: ["https://egress.test/ip"],
    relayFactory: async (upstream) => {
      upstreams.push(upstream);
      return { port: nextPort++, close: () => { closed++; } };
    },
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const proxy = (init as RequestInit & { proxy?: string } | undefined)?.proxy;
      if (proxy) {
        proxyUrls.push(proxy);
        return Response.json({ ip: "203.0.113.20", country: "US" });
      }
      return Response.json({ ip: direct.ip });
    }) as typeof fetch,
  });

  expect(result).toMatchObject({ status: "working", successes: 3, ip: "203.0.113.20" });
  expect(upstreams).toHaveLength(3);
  expect(upstreams[0]).toEqual({
    type: "socks5",
    host: "proxy.example",
    port: 1080,
    user: "proxy-user",
    pass: "proxy-password",
  });
  expect(new Set(proxyUrls)).toEqual(new Set([
    "http://127.0.0.1:41000",
    "http://127.0.0.1:41001",
    "http://127.0.0.1:41002",
  ]));
  expect(closed).toBe(3);
});

test("proxy check uses an explicit transport through a real loopback relay", async () => {
  const requests: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push(request.url);
      return Response.json({ ip: "203.0.113.30", country: "DE" });
    },
  });
  try {
    await expect(checkProxy({
      type: "http",
      host: "127.0.0.1",
      port: String(upstream.port),
      user: "",
      pass: "",
    }, {
      // Bun >=1.3.9 applies NO_PROXY to explicit proxy options too. A loopback
      // target would intentionally bypass the relay on ordinary dev machines.
      // The reserved .invalid target cannot resolve or produce an exit directly;
      // the local upstream fixture must receive all three proxied requests.
      endpoints: ["http://maobu-egress-check.invalid/ip"],
      direct,
      timeoutMs: 2_000,
    })).resolves.toMatchObject({
      status: "working",
      attempts: 3,
      successes: 3,
      ip: "203.0.113.30",
      country: "DE",
    });
    expect(requests).toHaveLength(3);
    expect(requests.every((url) => url.includes("maobu-egress-check.invalid"))).toBe(true);
  } finally {
    upstream.stop(true);
  }
});

test("production proxy check keeps even loopback targets on the explicit relay", async () => {
  let proxiedRequests = 0;
  const egress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: direct.ip }) });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxiedRequests++; return Response.json({ ip: "203.0.113.40" }); } });
  try {
    const result = await checkProxy({ type: "http", host: "127.0.0.1", port: String(upstream.port), user: "", pass: "" }, {
      endpoints: [`http://127.0.0.1:${egress.port}/ip`], timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: "working", attempts: 3, successes: 3, ip: "203.0.113.40" });
    expect(proxiedRequests).toBe(3);
  } finally { upstream.stop(true); egress.stop(true); }
});

test("invalid checker framing stays unavailable rather than an invented proxy failure", async () => {
  const result = await checkProxy({ type: "http", host: "proxy.example", port: "8080", user: "", pass: "" }, {
    endpoints: ["https://fixture.test/ip"], direct,
    relayFactory: async () => ({ port: 41000, close() {} }),
    fetchFn: (async () => { throw new EgressResponseError("Invalid response framing"); }) as unknown as typeof fetch,
  });
  expect(result).toMatchObject({ status: "unavailable", reason: "check_unavailable", successes: 0 });
});

test("equivalent IPv6 spellings compare as a shared exit without inventing path evidence", () => {
  expect(classifyProxyAttempts([exit("2001:db8:0:0:0:0:0:1")], { ip: "2001:db8::1" })).toMatchObject({ status: "working", reason: "same_exit", exitComparison: "same" });
});

test("reachable desktop proxies sharing the system VPN exit remain working with an isolation warning", async () => {
  let proxied = 0;
  const egress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: direct.ip }) });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxied++; return Response.json({ ip: direct.ip }); } });
  try {
    const result = await checkProxy({ type: "http", host: "127.0.0.1", port: String(upstream.port), user: "", pass: "" }, { endpoints: [`http://127.0.0.1:${egress.port}/ip`], timeoutMs: 1000 });
    expect(proxied).toBe(3);
    expect(result).toMatchObject({ status: "working", reason: "same_exit", exitComparison: "same", ip: direct.ip, successes: 3 });
  } finally { upstream.stop(true); egress.stop(true); }
});

test("a missing baseline proves only connectivity and mixed failures remain unstable", () => {
  expect(classifyProxyAttempts([exit("203.0.113.10")], null)).toMatchObject({ status: "working", exitComparison: "unknown" });
  expect(classifyProxyAttempts([exit(direct.ip), failed("timeout")], direct)).toMatchObject({ status: "unstable", reason: "intermittent", exitComparison: "same" });
});

test("default checker ignores global fetch replacement and always uses the explicit relay", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: direct.ip }) });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: "203.0.113.51" }) });
  globalThis.fetch = (async () => { calls++; throw new Error("global fetch must not control routing"); }) as unknown as typeof fetch;
  try {
    const result = await checkProxy({ type: "http", host: "127.0.0.1", port: String(upstream.port), user: "", pass: "" }, {
      endpoints: [`http://127.0.0.1:${server.port}/ip`], timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: "working", ip: "203.0.113.51" });
    expect(calls).toBe(0);
  } finally { globalThis.fetch = previous; upstream.stop(true); server.stop(true); }
});

test("proxy check returns fixed safe failure reasons", async () => {
  const result = await checkProxy({
    type: "http",
    host: "proxy.example",
    port: "8080",
    user: "proxy-user",
    pass: "private-password",
  }, {
    endpoints: ["https://egress.test/ip"],
    relayFactory: async (_upstream, options) => {
      options?.log?.("upstream refused CONNECT egress.test:443: HTTP/1.1 407 Proxy Authentication Required");
      return { port: 42000, close() {} };
    },
    fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init as RequestInit & { proxy?: string } | undefined)?.proxy) throw new Error("connection closed");
      return Response.json({ ip: direct.ip });
    }) as typeof fetch,
  });

  expect(result).toMatchObject({ status: "failed", reason: "authentication_failed" });
  expect(JSON.stringify(result)).not.toContain("private-password");
  expect(JSON.stringify(result)).not.toContain("proxy.example");
});

test("proxy check rejects blank and unsupported proxy input before network activity", async () => {
  await expect(checkProxy({ host: "", port: "" })).rejects.toThrow("proxy is required");
  await expect(checkProxy({ type: "https", host: "proxy.example", port: "8443" })).rejects.toThrow(
    "use http or socks5",
  );
});
