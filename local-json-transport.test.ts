import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requestLoopbackJson } from "./local-json-transport.ts";

const tags = { method: "GET", path: "/api/tags" } as const;
const chat = { method: "POST", path: "/api/chat" } as const;
const childPath = fileURLToPath(new URL("./test-fixtures/local-json-client.ts", import.meta.url));

test("local JSON endpoint and route validation rejects external or ambiguous targets before connecting", async () => {
  for (const endpoint of ["http://example.com", "http://127.0.0.2", "http://0.0.0.0", "http://2130706433", "http://127.1", "http://localhost.attacker.test", "http://user:secret@localhost", "http://localhost/path", "http://localhost/?query=x", "http://localhost/#x", "http://localhost:0", "http://localhost:65536", "file:///localhost", "http://localhost\\@example.com"]) {
    await expect(requestLoopbackJson(endpoint, tags)).rejects.toMatchObject({ code: "invalid_endpoint" });
  }
  for (const options of [{ method: "DELETE", path: "/api/tags" }, { method: "GET", path: "/api/chat" }, { method: "POST", path: "/api/chat" }, { ...tags, body: {} }, { ...tags, timeoutMs: 120001 }]) {
    await expect(requestLoopbackJson("http://127.0.0.1:1", options as any)).rejects.toMatchObject({ code: "invalid_request" });
  }
});

test("UTF8 Chinese JSON POST preserves content and byte length on the real loopback socket", async () => {
  const body = { model: "fixture", stream: false, messages: [{ role: "user", content: "你好，猫步🐾" }] };
  const seen: Array<{ method: string; path: string; length: number; header: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const bytes = await request.arrayBuffer();
    seen.push({ method: request.method, path: new URL(request.url).pathname, length: bytes.byteLength, header: request.headers.get("content-length"), body: JSON.parse(new TextDecoder().decode(bytes)) });
    return Response.json({ message: { content: "收到：你好，猫步🐾" } });
  } });
  try {
    expect(await requestLoopbackJson(`http://127.0.0.1:${server.port}`, { ...chat, body })).toEqual({ message: { content: "收到：你好，猫步🐾" } });
    expect(seen[0]).toEqual({ method: "POST", path: "/api/chat", length: Buffer.byteLength(JSON.stringify(body)), header: String(Buffer.byteLength(JSON.stringify(body))), body });
  } finally { server.stop(true); }
});

test("IPv6 loopback is accepted directly and a pre-aborted call never opens a socket", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "::1", port: 0, fetch: () => { calls++; return Response.json({ models: [] }); } });
  try {
    const endpoint = `http://[::1]:${server.port}`;
    expect(await requestLoopbackJson(endpoint, tags)).toEqual({ models: [] });
    const controller = new AbortController(); controller.abort();
    await expect(requestLoopbackJson(endpoint, { ...tags, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});

test("requests ignore HTTP_PROXY, HTTPS_PROXY and replaced global fetch without leaking prompts", async () => {
  let proxyCalls = 0, targetCalls = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxyCalls++; return Response.json({ leaked: true }); } });
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { targetCalls++; return Response.json({ body: await request.json() }); } });
  const options = { ...chat, body: { prompt: "私密测试文本，仅应抵达回环服务" }, timeoutMs: 1000 };
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("global fetch must not be used"); }) as unknown as typeof fetch;
  try {
    const child = Bun.spawn([process.execPath, childPath, `http://localhost:${target.port}`, JSON.stringify(options)], {
      env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, ALL_PROXY: `http://127.0.0.1:${proxy.port}`, http_proxy: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}`, all_proxy: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "", no_proxy: "" }, stdout: "pipe", stderr: "pipe",
    });
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ result: { body: options.body } });
    expect(await child.exited).toBe(0);
    expect(proxyCalls).toBe(0); expect(targetCalls).toBe(1);
    expect(await requestLoopbackJson(`http://127.0.0.1:${target.port}`, options)).toEqual({ body: options.body });
  } finally { globalThis.fetch = previous; target.stop(true); proxy.stop(true); }
});

test("JSON request and response byte limits are enforced without echoing content", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { requests++; await request.text(); return Response.json({ value: "x".repeat(256 * 1024) }); } });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    await expect(requestLoopbackJson(endpoint, { ...chat, body: "猫".repeat(50_000) })).rejects.toMatchObject({ code: "request_too_large" });
    expect(requests).toBe(0);
    await expect(requestLoopbackJson(endpoint, { ...chat, body: "x".repeat(128 * 1024 - 2) })).rejects.toMatchObject({ code: "response_too_large" });
    expect(requests).toBe(1);
    const cyclic: any = {}; cyclic.self = cyclic;
    await expect(requestLoopbackJson(endpoint, { ...chat, body: cyclic })).rejects.toMatchObject({ code: "invalid_request" });
  } finally { server.stop(true); }
});

test("redirects and error statuses never contact another host or echo provider content", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++; return requests === 1 ? new Response(null, { status: 302, headers: { Location: "http://external-never-contacted.invalid/prompt" } })
      : new Response("PRIVATE_PROVIDER_ERROR", { status: 503 });
  } });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    await expect(requestLoopbackJson(endpoint, tags)).rejects.toMatchObject({ code: "redirect_rejected" });
    try { await requestLoopbackJson(endpoint, tags); } catch (error) {
      expect(error).toMatchObject({ code: "http_error", status: 503 });
      expect(String(error)).not.toContain("PRIVATE_PROVIDER_ERROR");
    }
    expect(requests).toBe(2);
  } finally { server.stop(true); }
});

test("timeouts and caller cancellation close silent sockets", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); socket.on("data", () => {}); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  try {
    await expect(requestLoopbackJson(endpoint, { ...tags, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    const timer = setTimeout(() => controller.abort(), 30);
    try { await expect(requestLoopbackJson(endpoint, { ...tags, signal: controller.signal, timeoutMs: 1000 })).rejects.toMatchObject({ code: "cancelled" }); }
    finally { clearTimeout(timer); }
    await Bun.sleep(20);
    expect(sockets.size).toBe(0);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("invalid JSON is reported with a fixed message", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("PRIVATE_INVALID_JSON") });
  try {
    await expect(requestLoopbackJson(`http://127.0.0.1:${server.port}`, tags)).rejects.toMatchObject({ code: "invalid_json", message: "Local AI service returned invalid JSON" });
  } finally { server.stop(true); }
});

test("loopback HTTPS verifies certificate trust and cannot be weakened by TLS environment flags", async () => {
  const certPath = fileURLToPath(new URL("./test-fixtures/local-json-tls/cert.pem", import.meta.url));
  const server = createHttpsServer({ key: readFileSync(new URL("./test-fixtures/local-json-tls/key.pem", import.meta.url)), cert: readFileSync(certPath) }, (_request, response) => response.end('{"models":[]}'));
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `https://localhost:${(server.address() as { port: number }).port}`;
  try {
    await expect(requestLoopbackJson(endpoint, tags)).rejects.toMatchObject({ code: "unavailable" });
    const trusted = Bun.spawn([process.execPath, childPath, endpoint, JSON.stringify(tags)], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(trusted.stdout).text())).toEqual({ result: { models: [] } });
    expect(await trusted.exited).toBe(0);
    const unsafe = Bun.spawn([process.execPath, childPath, endpoint, JSON.stringify(tags)], { env: { ...process.env, NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(unsafe.stdout).text())).toMatchObject({ code: "unavailable" });
    expect(await unsafe.exited).toBe(1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
