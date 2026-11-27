import { expect, test } from "bun:test";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createRawServer, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EgressResponseError, fetchEgressEndpoint } from "../egress-transport.ts";
import { startProxyRelay } from "../proxy-relay.ts";
import { createConnectProxy } from "../test-fixtures/connect-proxy.ts";

async function rawEndpoint(parts: string[]) {
  const sockets = new Set<Socket>();
  const server = createRawServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      let index = 0;
      const write = () => {
        if (socket.destroyed) return;
        if (index === parts.length) { socket.end(); return; }
        socket.write(parts[index++]!); setTimeout(write, 2);
      };
      write();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/ip`, close: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("raw decoder accepts split headers, chunk extensions, trailers and close-framed bodies", async () => {
  const json = '{"ip":"203.0.113.10"}';
  for (const parts of [
    ["HTTP/1.1 200 OK\r\nTransfer-Enc", "oding: chunked\r\n\r\n", "5;part=one\r\n", json.slice(0, 5), "\r\n", (json.length - 5).toString(16) + "\r\n", json.slice(5), "\r\n0\r\nX-Check: done\r\n\r\n"],
    ["HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n", json],
    [`HTTP/1.1 200 OK\r\nContent-Length: ${json.length}\r\n\r\n`, json.slice(0, 8), json.slice(8)],
  ]) {
    const fixture = await rawEndpoint(parts);
    try { expect(await (await fetchEgressEndpoint(fixture.url, { timeoutMs: 1000 })).json()).toEqual({ ip: "203.0.113.10" }); }
    finally { await fixture.close(); }
  }
});

test("raw decoder rejects ambiguous, oversized and incomplete framing as checker failures", async () => {
  for (const response of [
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\nx\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxBAD\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nBad Trailer\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nshort",
    "HTTP/1.1 200 OK\r\nBad Header\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nX-Control: bad\u0001value\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nX-Large: " + "x".repeat(33 * 1024) + "\r\n\r\nx",
    "HTTP/2.0 200 OK\r\n\r\nx",
  ]) {
    const fixture = await rawEndpoint([response]);
    try { await expect(fetchEgressEndpoint(fixture.url, { timeoutMs: 1000 })).rejects.toBeInstanceOf(EgressResponseError); }
    finally { await fixture.close(); }
  }
});

test("explicit relay and direct routes ignore NO_PROXY without changing global environment", async () => {
  const before = [process.env.NO_PROXY, process.env.no_proxy, process.env.HTTP_PROXY, process.env.HTTPS_PROXY];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: "198.51.100.7" }) });
  let proxyRequests = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxyRequests++; return Response.json({ ip: "203.0.113.7" }); } });
  const relay = await startProxyRelay({ type: "http", host: "127.0.0.1", port: upstream.port!, user: "", pass: "" });
  try {
    const endpoint = `http://127.0.0.1:${target.port}/ip`;
    expect(await (await fetchEgressEndpoint(endpoint)).json()).toEqual({ ip: "198.51.100.7" });
    expect(await (await fetchEgressEndpoint(endpoint, { relayPort: relay.port })).json()).toEqual({ ip: "203.0.113.7" });
    expect(proxyRequests).toBe(1);
    expect([process.env.NO_PROXY, process.env.no_proxy, process.env.HTTP_PROXY, process.env.HTTPS_PROXY]).toEqual(before);
  } finally { relay.close(); upstream.stop(true); target.stop(true); }
});

test("redirects keep the explicit relay route and cannot silently fall back to direct", async () => {
  const targets: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    targets.push(request.url);
    return request.url.includes("/first") ? new Response(null, { status: 302, headers: { Location: "http://second-egress.invalid/final" } })
      : Response.json({ ip: "203.0.113.8" });
  } });
  try {
    const response = await fetchEgressEndpoint("http://first-egress.invalid/first", { relayPort: upstream.port });
    expect(await response.json()).toEqual({ ip: "203.0.113.8" });
    expect(targets).toHaveLength(2);
    expect(targets[0]).toContain("first-egress.invalid");
    expect(targets[1]).toContain("second-egress.invalid");
  } finally { upstream.stop(true); }
});

test("invalid redirect locations are checker response errors with credential-free messages", async () => {
  for (const location of ["file:///tmp/ip", "http://user:private-password@egress.invalid/ip", "http://[invalid"]) {
    const fixture = await rawEndpoint([`HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: ${location}\r\n\r\n`]);
    try {
      await expect(fetchEgressEndpoint(fixture.url, { timeoutMs: 1000 })).rejects.toBeInstanceOf(EgressResponseError);
      try { await fetchEgressEndpoint(fixture.url, { timeoutMs: 1000 }); } catch (error) {
        expect(String(error)).not.toContain("private-password");
      }
    } finally { await fixture.close(); }
  }
});

test("transport bounds body size, redirect count and cancellation", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/large") return new Response("x".repeat(65 * 1024));
    if (path === "/loop") return new Response(null, { status: 302, headers: { Location: "/loop" } });
    return new Promise<Response>(() => {});
  } });
  try {
    await expect(fetchEgressEndpoint(`http://127.0.0.1:${server.port}/large`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow("too large");
    await expect(fetchEgressEndpoint(`http://127.0.0.1:${server.port}/loop`, { timeoutMs: 1000 })).rejects.toBeInstanceOf(EgressResponseError);
    await expect(fetchEgressEndpoint(`http://127.0.0.1:${server.port}/hang`, { timeoutMs: 50 })).rejects.toThrow();
    await expect(fetchEgressEndpoint("file:///invalid")).rejects.toThrow("HTTP or HTTPS");
    await expect(fetchEgressEndpoint("https://user:secret@example.com/ip")).rejects.toThrow("credentials");
    await expect(fetchEgressEndpoint("https://example.com", { relayPort: 0 })).rejects.toThrow("relay port");
  } finally { server.stop(true); }
});

test("caller cancellation also stops a silent connection without waiting for the hard deadline", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("operator cancelled")), 40);
  try {
    await expect(fetchEgressEndpoint(`http://127.0.0.1:${server.port}/hang`, { signal: controller.signal, timeoutMs: 2000 })).rejects.toThrow("operator cancelled");
  } finally { clearTimeout(timer); server.stop(true); }
});

test("HTTPS uses CONNECT and returns proxy authentication status without fallback", async () => {
  let authority = "";
  const upstream = await createConnectProxy({ status: 407, onConnect: (request) => { authority = request.authority; } });
  try {
    const response = await fetchEgressEndpoint("https://egress-never-resolved.invalid/ip", { relayPort: upstream.port });
    expect(response.status).toBe(407);
    expect(authority).toBe("egress-never-resolved.invalid:443");
  } finally { await upstream.close(); }
});

test("HTTPS tunnel verifies the destination certificate while proxy resolves the hostname", async () => {
  const certPath = fileURLToPath(new URL("../test-fixtures/egress-tls/cert.pem", import.meta.url));
  const key = readFileSync(new URL("../test-fixtures/egress-tls/key.pem", import.meta.url));
  const cert = readFileSync(certPath);
  const tlsServer = createHttpsServer({ key, cert }, (request, response) => {
    if (request.url === "/downgrade") { response.writeHead(302, { Location: "http://downgrade-egress.invalid/ip" }); response.end(); }
    else response.end('{"ip":"203.0.113.9"}');
  });
  tlsServer.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const authorities: string[] = [];
  const upstream = await createConnectProxy({ targetPort: (tlsServer.address() as { port: number }).port,
    onConnect: (request) => authorities.push(request.authority) });
  try {
    const relayPort = upstream.port;
    // A self-signed peer is rejected in the normal production trust context.
    await expect(fetchEgressEndpoint("https://maobu-egress.test/ip", { relayPort, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../test-fixtures/egress-tls/client.ts", import.meta.url)), "https://maobu-egress.test/ip", String(relayPort)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ status: 200, body: '{"ip":"203.0.113.9"}' });
    expect(authorities.every((authority) => authority === "maobu-egress.test:443")).toBe(true);
    const unsafeEnvironment = Bun.spawn([process.execPath, fileURLToPath(new URL("../test-fixtures/egress-tls/client.ts", import.meta.url)), "https://maobu-egress.test/ip", String(relayPort)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdout: "pipe", stderr: "pipe",
    });
    const unsafeOutput = await new Response(unsafeEnvironment.stdout).text();
    expect(await unsafeEnvironment.exited).toBe(1);
    expect(JSON.parse(unsafeOutput).failed).toBe(true);
    const downgrade = Bun.spawn([process.execPath, fileURLToPath(new URL("../test-fixtures/egress-tls/client.ts", import.meta.url)), "https://maobu-egress.test/downgrade", String(relayPort)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdout: "pipe", stderr: "pipe",
    });
    const downgradeOutput = await new Response(downgrade.stdout).text();
    expect(await downgrade.exited).toBe(1);
    expect(JSON.parse(downgradeOutput)).toMatchObject({ failed: true, name: "EgressResponseError" });
    // Trusting the CA never disables hostname verification.
    const mismatch = Bun.spawn([process.execPath, fileURLToPath(new URL("../test-fixtures/egress-tls/client.ts", import.meta.url)), "https://wrong-egress.test/ip", String(relayPort)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdout: "pipe", stderr: "pipe",
    });
    const failed = await new Response(mismatch.stdout).text();
    expect(await mismatch.exited).toBe(1);
    expect(JSON.parse(failed).failed).toBe(true);
  } finally {
    await Promise.all([upstream.close(), new Promise<void>((resolve) => tlsServer.close(() => resolve()))]);
  }
});
