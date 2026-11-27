import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { discoverLocalProxies, parseLocalProxyDiscoveryRequest, type LocalProxyHost } from "../network-diagnostics.ts";
import { handleFeatureSettingsRequest } from "../feature-settings.ts";
import type { ProfileStore } from "../store.ts";

async function localServer(onData: (socket: Socket, data: Buffer) => void, host: LocalProxyHost = "127.0.0.1") {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (data) => onData(socket, typeof data === "string" ? Buffer.from(data) : data));
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("discovery refuses non-loopback hosts and unbounded input before connecting", async () => {
  for (const host of [null, "localhost", "127.0.0.2", "192.168.0.1", "example.com", "::ffff:127.0.0.1"]) {
    expect(() => parseLocalProxyDiscoveryRequest({ host, ports: [7890] })).toThrow("loopback");
  }
  for (const ports of [null, [], [0], [65536], [1.5], [NaN], [1080, 1080], ["1080"], Array(1), Array.from({ length: 17 }, (_, i) => i + 1)]) {
    expect(() => parseLocalProxyDiscoveryRequest({ ports })).toThrow("16 unique local ports");
  }
  const listener = await localServer(() => {});
  try {
    for (const timeoutMs of [0, 49, 3001, NaN]) await expect(discoverLocalProxies({ ports: [listener.port], timeoutMs })).rejects.toThrow("timeout");
  } finally { await listener.close(); }
});

test("SOCKS discovery performs method negotiation only and supports split responses", async () => {
  const received: Buffer[] = [];
  const listener = await localServer((socket, data) => {
    received.push(data);
    socket.write(Buffer.from([5]));
    setTimeout(() => socket.write(Buffer.from([0])), 5);
  });
  try {
    const report = await discoverLocalProxies({ ports: [listener.port], timeoutMs: 300 });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ host: "127.0.0.1", port: listener.port, status: "listening", socks5: "available", suggestions: [{ type: "socks5", evidence: "handshake" }] });
    expect(Buffer.concat(received)).toEqual(Buffer.from([5, 2, 0, 2]));
    expect(report.results[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(report.checkedAt)).not.toBeNaN();
  } finally { await listener.close(); }
});

test("the settings route probes only an explicitly supplied IPv6 loopback listener", async () => {
  const received: Buffer[] = [];
  const listener = await localServer((socket, data) => {
    received.push(data);
    if (Buffer.concat(received).length === 4) socket.write(Buffer.from([5, 2]));
  }, "::1");
  try {
    const request = new Request("http://127.0.0.1/ui/api/settings/network/discover", {
      method: "POST", headers: { "X-Maobu-Settings": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ host: "::1", ports: [listener.port] }),
    });
    const response = await handleFeatureSettingsRequest(request, {} as ProfileStore);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, discovery: { host: "::1", results: [{
      host: "::1", port: listener.port, status: "listening", socks5: "authentication_required",
      suggestions: [{ type: "socks5", evidence: "handshake" }],
    }] } });
    expect(Buffer.concat(received)).toEqual(Buffer.from([5, 2, 0, 2]));
  } finally { await listener.close(); }
});

test("protected SOCKS listener remains distinct from unauthenticated availability", async () => {
  const listener = await localServer((socket) => socket.write(Buffer.from([5, 2])));
  try {
    expect((await discoverLocalProxies({ ports: [listener.port], timeoutMs: 300 })).results[0]).toMatchObject({ status: "listening", socks5: "authentication_required" });
  } finally { await listener.close(); }
});

test("unrecognized TCP services are port hints rather than verified proxies", async () => {
  const listener = await localServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  try {
    const result = (await discoverLocalProxies({ ports: [listener.port], timeoutMs: 300 })).results[0]!;
    expect(result.status).toBe("listening");
    expect(result.socks5).toBe("unknown");
    expect(result.suggestions.every((suggestion) => suggestion.evidence === "port_hint")).toBe(true);
  } finally { await listener.close(); }
});

test("a silent accepting port is listening, not a connection timeout or proven proxy", async () => {
  const listener = await localServer(() => {});
  try {
    const result = (await discoverLocalProxies({ ports: [listener.port], timeoutMs: 70 })).results[0]!;
    expect(result.status).toBe("listening");
    expect(result.socks5).toBe("unknown");
  } finally { await listener.close(); }
});

test("closed local port has no proxy suggestions", async () => {
  const listener = await localServer(() => {});
  await listener.close();
  expect((await discoverLocalProxies({ ports: [listener.port], timeoutMs: 300 })).results[0]).toMatchObject({ status: "closed", latencyMs: null, suggestions: [] });
});
