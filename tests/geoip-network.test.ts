import { test, expect } from "bun:test";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookupExitLocation } from "../geoip.ts";
import { createConnectProxy } from "../test-fixtures/connect-proxy.ts";

const gateway = (port: number) => ({ type: "http" as const, host: "127.0.0.1", port: String(port), user: "", pass: "" });
const endpoints = (base: string) => ({ geojs: `${base}/geojs`, ipApi: `${base}/ip-api`, ipinfo: `${base}/ipinfo` });

test("default location transport pins even loopback checker targets to the selected proxy", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("global fetch must not control routing"); }) as unknown as typeof fetch;
  let directCalls = 0, proxyCalls = 0;
  const direct = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { directCalls++; return Response.json({ timezone: "Europe/Paris", ip: "198.51.100.10" }); } });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxyCalls++; return Response.json({ timezone: "Asia/Tokyo", country_code: "JP", ip: "203.0.113.10" }); } });
  try {
    const options = { endpoints: endpoints(`http://127.0.0.1:${direct.port}`), timeoutMs: 1000, geojsTimeoutMs: 1000 };
    expect(await lookupExitLocation(gateway(upstream.port!), undefined, options)).toEqual({ timezone: "Asia/Tokyo", country: "JP", ip: "203.0.113.10" });
    expect(proxyCalls).toBeGreaterThanOrEqual(1);
    expect(directCalls).toBe(0);
    expect((await lookupExitLocation(null, undefined, options))?.ip).toBe("198.51.100.10");
  } finally { globalThis.fetch = previous; upstream.stop(true); direct.stop(true); }
});

test("failed proxy checkers never fall back to a valid direct location", async () => {
  let directCalls = 0, proxyCalls = 0;
  const direct = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { directCalls++; return Response.json({ timezone: "Europe/Paris", ip: "198.51.100.10" }); } });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxyCalls++; return Response.json({ timezone: "Asia/Tokyo", ip: "203.0.113.10" }, { status: 503 }); } });
  try {
    expect(await lookupExitLocation(gateway(upstream.port!), undefined, { endpoints: endpoints(`http://127.0.0.1:${direct.port}`), timeoutMs: 1000, geojsTimeoutMs: 1000 })).toBeNull();
    expect(proxyCalls).toBe(3);
    expect(directCalls).toBe(0);
  } finally { upstream.stop(true); direct.stop(true); }
});

test("proxy relay remains open until the IPv6 location fallback has completed", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/ipinfo"
    ? Response.json({ timezone: "Europe/Berlin", country: "DE", ip: "2001:db8::10" })
    : new Response("checker unavailable", { status: 503 }) });
  try {
    const location = await lookupExitLocation(gateway(upstream.port!), undefined, { endpoints: endpoints("http://geoip-fixture.invalid"), timeoutMs: 1000, geojsTimeoutMs: 1000 });
    expect(location).toEqual({ timezone: "Europe/Berlin", country: "DE", ip: "2001:db8::10" });
  } finally { upstream.stop(true); }
});

test("geoip default transport validates TLS and confines proxy credentials to the upstream", async () => {
  const certPath = fileURLToPath(new URL("../test-fixtures/egress-tls/cert.pem", import.meta.url));
  const key = readFileSync(new URL("../test-fixtures/egress-tls/key.pem", import.meta.url));
  const cert = readFileSync(certPath);
  const checkerHeaders: Array<Record<string, unknown>> = [];
  const tlsServer = createHttpsServer({ key, cert }, (request, response) => {
    checkerHeaders.push(request.headers);
    response.end('{"timezone":"Europe/Berlin","country_code":"DE","ip":"203.0.113.11"}');
  });
  tlsServer.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const authorizations: string[] = [];
  const upstream = await createConnectProxy({ targetPort: (tlsServer.address() as { port: number }).port,
    onConnect: (request) => authorizations.push(request.headers["proxy-authorization"] ?? "") });
  try {
    const childPath = fileURLToPath(new URL("../test-fixtures/egress-tls/geoip-client.ts", import.meta.url));
    const port = String(upstream.port);
    const untrusted = Bun.spawn([process.execPath, childPath, "https://maobu-egress.test/ip", port], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: "" }, stdout: "pipe", stderr: "pipe",
    });
    expect(JSON.parse(await new Response(untrusted.stdout).text())).toEqual({ location: null });
    expect(await untrusted.exited).toBe(0);
    const trusted = Bun.spawn([process.execPath, childPath, "https://maobu-egress.test/ip", port], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdout: "pipe", stderr: "pipe",
    });
    expect(JSON.parse(await new Response(trusted.stdout).text())).toEqual({ location: { timezone: "Europe/Berlin", country: "DE", ip: "203.0.113.11" } });
    expect(await trusted.exited).toBe(0);
    expect(authorizations.length).toBeGreaterThanOrEqual(4);
    expect(authorizations.every((value) => value === "Basic " + Buffer.from("geo-user:geo-test-password").toString("base64"))).toBe(true);
    expect(checkerHeaders.length).toBeGreaterThanOrEqual(1);
    expect(checkerHeaders.every((headers) => !headers.authorization && !headers["proxy-authorization"] && !headers.cookie)).toBe(true);
  } finally {
    await Promise.all([upstream.close(), new Promise<void>((resolve) => tlsServer.close(() => resolve()))]);
  }
});
