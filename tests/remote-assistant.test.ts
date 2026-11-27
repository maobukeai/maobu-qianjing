import { describe, expect, test } from "bun:test";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RemoteAssistantService, isRemoteAssistantModelId, normalizeRemoteAssistantEndpoint, type RemoteAssistantConnection } from "../src/remote-assistant.ts";

const gateway: RemoteAssistantConnection = { provider: "openai-compatible", endpoint: "https://gateway.example.test/api/v1", apiKey: "fixture-only-secret" };
const chat = { model: "fixture-model", system: "Operator-reviewed drafts only.", messages: [{ role: "user" as const, content: "你好，猫步🐾" }] };
const expectedReply = { content: "模拟回复", promptTokens: 5, completionTokens: 4 };

describe("model service address policy", () => {
  test("accepts explicit loopback and public HTTPS base paths, rejects hidden routing and private IPs", () => {
    expect(normalizeRemoteAssistantEndpoint("  https://Gateway.Example.Test:443/api/v1/  ")).toBe("https://gateway.example.test/api/v1");
    expect(normalizeRemoteAssistantEndpoint("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(normalizeRemoteAssistantEndpoint("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeRemoteAssistantEndpoint("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
    expect(normalizeRemoteAssistantEndpoint("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(normalizeRemoteAssistantEndpoint("http://127.0.0.1:11435/v1")).toBe("http://127.0.0.1:11435/v1");
    expect(normalizeRemoteAssistantEndpoint("http://127.0.0.1:3000/v1")).toBe("http://127.0.0.1:3000/v1");
    expect(normalizeRemoteAssistantEndpoint("http://127.0.0.1:5000/v1")).toBe("http://127.0.0.1:5000/v1");
    expect(normalizeRemoteAssistantEndpoint("http://127.0.0.1:49152/v1")).toBe("http://127.0.0.1:49152/v1");
    expect(normalizeRemoteAssistantEndpoint("http://[::1]:1234/")).toBe("http://[::1]:1234");
    expect(normalizeRemoteAssistantEndpoint("http://localhost:9001/v1", { allowedLoopbackPorts: [9001] })).toBe("http://localhost:9001/v1");
    expect(normalizeRemoteAssistantEndpoint("http://localhost:80/v1", { allowedLoopbackPorts: [80] })).toBe("http://localhost/v1");
    expect(normalizeRemoteAssistantEndpoint("https://[2606:4700::1111]/v1")).toBe("https://[2606:4700::1111]/v1");
    for (const endpoint of ["http://example.test", "ftp://example.test", "http://127.1", "http://2130706433", "https://127.0.0.2", "https://local",
      "https://foo.localhost", "https://foo.home.arpa", "https://foo.internal", "https://10.0.0.1", "https://100.64.0.1", "https://169.254.169.254",
      "https://192.168.1.1", "https://198.18.0.1", "https://[fc00::1]", "https://[fe80::1]", "https://[::ffff:10.0.0.1]", "https://[2002:a00:1::]",
      "https://user:secret@gateway.example.test/v1", "https://example.test/v1?key=abc", "https://example.test/v1#", "https://example.test/a/../b",
      "https://example.test/%2e%2e/v1", "https://example.test//v1", "https://example.test:0", "https://example.test:65536", "https://example.test\n/v1",
      "https://localhost\\@example.test",
      "http://localhost/v1", "https://localhost/v1", "http://[::1]:22/v1", "http://localhost:50400/v1", "http://127.0.0.1:9222/v1", "http://127.0.0.1:9333/v1", "http://127.0.0.1:9999/v1"]) {
      expect(() => normalizeRemoteAssistantEndpoint(endpoint)).toThrow("Use HTTPS");
    }
    expect(() => normalizeRemoteAssistantEndpoint("http://127.0.0.1:1234/v1", { allowedLoopbackPorts: [9001] })).toThrow("Use HTTPS");
    expect(() => normalizeRemoteAssistantEndpoint("http://127.0.0.1:50400/v1", { allowedLoopbackPorts: [50400] })).toThrow("Use HTTPS");
    expect(() => normalizeRemoteAssistantEndpoint("http://127.0.0.1:9222/v1", { allowedLoopbackPorts: [9222] })).toThrow("Use HTTPS");
    expect(() => normalizeRemoteAssistantEndpoint("http://127.0.0.1:9333/v1", { allowedLoopbackPorts: [9333] })).toThrow("Use HTTPS");
    const previousDashboardPort = process.env.MAOBU_DASHBOARD_PORT;
    process.env.MAOBU_DASHBOARD_PORT = "51234";
    try {
      expect(() => normalizeRemoteAssistantEndpoint("http://127.0.0.1:51234/v1")).toThrow("Use HTTPS");
    } finally {
      if (previousDashboardPort === undefined) delete process.env.MAOBU_DASHBOARD_PORT;
      else process.env.MAOBU_DASHBOARD_PORT = previousDashboardPort;
    }
  });

  test("service blocks SSRF to privileged, Maobu, CDP, or disallowed loopback ports before transport", async () => {
    let calls = 0;
    const service = new RemoteAssistantService({ transport: async () => { calls++; return Response.json({ data: [] }); } });
    await expect(service.listModels({ ...gateway, endpoint: "http://127.0.0.1:50400/v1" })).rejects.toMatchObject({ code: "invalid-endpoint" });
    await expect(service.chat({ ...gateway, endpoint: "http://localhost:9222/v1" }, chat)).rejects.toMatchObject({ code: "invalid-endpoint" });
    await expect(service.chat({ ...gateway, endpoint: "http://[::1]:22/v1" }, chat)).rejects.toMatchObject({ code: "invalid-endpoint" });
    const restricted = new RemoteAssistantService({ allowedLoopbackPorts: [11434], transport: async () => { calls++; return Response.json({ data: [] }); } });
    await expect(restricted.chat({ ...gateway, endpoint: "http://localhost:6379/v1" }, chat)).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(calls).toBe(0);
  });

  test("rejects private or mixed DNS results without sending an HTTP request", async () => {
    const names: string[] = [];
    const service = new RemoteAssistantService({ resolveAddresses: async host => { names.push(host); return ["93.184.216.34", "::ffff:127.0.0.1"]; } });
    await expect(service.listModels(gateway)).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(names).toEqual(["gateway.example.test"]);
  });

  test("model IDs are provider-aware, bounded and safe in Gemini paths", () => {
    expect(isRemoteAssistantModelId("provider/fixture:free", "openai-compatible")).toBe(true);
    expect(isRemoteAssistantModelId("models/fixture-2", "gemini")).toBe(true);
    for (const invalid of ["fixture/other", "models/..", "models/x:y", "models/x?foo", "models/%20", "models/x#fragment", "models/x/next"]) {
      expect(isRemoteAssistantModelId(invalid, "gemini")).toBe(false);
    }
  });
});

describe("model service protocols", () => {
  test("OpenAI-compatible service uses a real loopback socket and preserves UTF-8 and catalog credential boundaries", async () => {
    const requests: Array<{ method: string; path: string; auth: string | null; text: string; bytes: string | null }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path, auth: request.headers.get("authorization"), text: await request.text(), bytes: request.headers.get("content-length") });
      return path.endsWith("/models") ? Response.json({ data: [{ id: "fixture-b" }, { id: "fixture-a" }, { id: "fixture-b" }, { id: gateway.apiKey }, { id: "x\r\nbad" }] })
        : Response.json({ choices: [{ message: { content: expectedReply.content } }], usage: { prompt_tokens: 5, completion_tokens: 4 } });
    } });
    try {
      const service = new RemoteAssistantService({ allowedLoopbackPorts: [server.port!], resolveAddresses: async () => { throw new Error("Loopback must never use DNS"); } });
      const connection = { ...gateway, endpoint: `http://localhost:${server.port}/v1` };
      expect(await service.listModels(connection)).toEqual(["fixture-a", "fixture-b"]);
      expect(await service.chat(connection, chat)).toEqual(expectedReply);
      expect(requests[0]).toEqual({ method: "GET", path: "/v1/models", auth: `Bearer ${gateway.apiKey}`, text: "", bytes: null });
      expect(requests[1]).toMatchObject({ method: "POST", path: "/v1/chat/completions", auth: `Bearer ${gateway.apiKey}` });
      expect(requests[1]!.bytes).toBe(String(Buffer.byteLength(requests[1]!.text)));
      expect(JSON.parse(requests[1]!.text)).toEqual({ model: chat.model, stream: false, max_tokens: 2048, messages: [{ role: "system", content: chat.system }, ...chat.messages] });
      expect(await service.listModels({ ...connection, apiKey: "" })).toEqual(["fixture-a", "fixture-b", gateway.apiKey]);
      expect(requests[2]!.auth).toBeNull();
    } finally { server.stop(true); }
  });

  test("official OpenAI payload caps output, disables storage, and supports no ambient key", async () => {
    const service = new RemoteAssistantService({ transport: async request => {
      expect(request.url.href).toBe("https://api.openai.com/v1/chat/completions");
      expect(request.headers).toEqual({});
      expect(JSON.parse(request.body!.toString())).toEqual({ model: chat.model, stream: false, store: false, max_completion_tokens: 2048, messages: [{ role: "system", content: chat.system }, ...chat.messages] });
      return Response.json({ choices: [{ message: { content: expectedReply.content } }], usage: { prompt_tokens: 5, completion_tokens: 4 } });
    } });
    expect(await service.chat({ ...gateway, endpoint: "https://api.openai.com/v1", apiKey: "" }, chat)).toEqual(expectedReply);
  });

  test("Anthropic pagination, version and Messages structure preserve only assistant text", async () => {
    const paths: string[] = [];
    const service = new RemoteAssistantService({ transport: async request => {
      expect(request.headers).toEqual({ "x-api-key": gateway.apiKey, "anthropic-version": "2026-10-21" });
      const path = request.url.pathname;
      paths.push(path);
      if (path.endsWith("/models")) {
        expect(request.method).toBe("GET"); expect(request.body).toBeUndefined();
        return request.url.searchParams.has("after_id") ? Response.json({ data: [{ id: "claude-b" }], has_more: false })
          : Response.json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" });
      }
      expect(JSON.parse(request.body!.toString())).toEqual({ model: chat.model, messages: chat.messages, system: chat.system, max_tokens: 2048, stream: false });
      return Response.json({ content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "ignored", name: "ignored" }, { type: "text", text: expectedReply.content }], usage: { input_tokens: 5, output_tokens: 4 } });
    } });
    const connection = { ...gateway, provider: "anthropic" as const, endpoint: "https://api.anthropic.com/v1" };
    expect(await service.listModels(connection)).toEqual(["claude-a", "claude-b"]);
    expect(await service.chat(connection, chat)).toEqual(expectedReply);
    expect(paths).toEqual(["/v1/models", "/v1/models", "/v1/messages"]);
    await expect(service.listModels({ ...connection, apiKey: "" })).rejects.toMatchObject({ code: "auth" });
  });

  test("Gemini lists only text generation models and maps chat roles and usage without query keys", async () => {
    const service = new RemoteAssistantService({ transport: async request => {
      expect(request.headers).toEqual({ "x-goog-api-key": gateway.apiKey });
      expect(request.url.href).not.toContain(gateway.apiKey);
      if (request.method === "GET") return Response.json({ models: [
        { name: "models/fixture-text", supportedGenerationMethods: ["generateContent"] },
        { name: "models/fixture-embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/invalid/extra", supportedGenerationMethods: ["generateContent"] },
      ] });
      expect(request.url.pathname).toBe("/v1beta/models/fixture-text:generateContent");
      expect(JSON.parse(request.body!.toString())).toEqual({ systemInstruction: { parts: [{ text: chat.system }] }, generationConfig: { maxOutputTokens: 2048, candidateCount: 1 }, contents: [
        { role: "model", parts: [{ text: "历史回复" }] }, { role: "user", parts: [{ text: chat.messages[0]!.content }] },
      ] });
      return Response.json({ candidates: [{ content: { parts: [{ text: "private", thought: true }, { text: expectedReply.content }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } });
    } });
    const connection = { ...gateway, provider: "gemini" as const, endpoint: "https://generativelanguage.googleapis.com/v1beta" };
    expect(await service.listModels(connection)).toEqual(["fixture-text"]);
    expect(await service.chat(connection, { ...chat, model: "models/fixture-text", messages: [{ role: "assistant", content: "历史回复" }, ...chat.messages] })).toEqual(expectedReply);
    await expect(service.chat(connection, { ...chat, model: "models/../private" })).rejects.toMatchObject({ code: "invalid-request" });
  });
});

describe("model service errors and network limits", () => {
  test("maps auth, list absence, model absence, rate limits and errors without provider details", async () => {
    for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "model-list-unavailable"], [405, "model-list-unavailable"], [429, "rate-limited"], [500, "provider-error"], [503, "unavailable"]] as const) {
      const service = new RemoteAssistantService({ transport: async () => new Response(`private provider response ${gateway.apiKey}`, { status }) });
      try { await service.listModels(gateway); throw new Error("Expected a provider error"); } catch (error) {
        expect(error).toMatchObject({ code }); expect(String(error)).not.toContain(gateway.apiKey);
      }
    }
    const service = new RemoteAssistantService({ transport: async () => new Response("private", { status: 404 }) });
    await expect(service.chat(gateway, chat)).rejects.toMatchObject({ code: "model-not-found" });
  });

  test("never follows real socket redirects, caps response bodies, and redacts echoed keys", async () => {
    let hits = 0;
    const redirected = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({ data: [] }); } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/redirect")) return Response.redirect(`http://127.0.0.1:${redirected.port}/v1/models`, 307);
      if (path.startsWith("/oversized")) return Response.json({ text: "x".repeat(256 * 1024) });
      return Response.json({ choices: [{ message: { content: `repeated ${gateway.apiKey}` } }] });
    } });
    try {
      const service = new RemoteAssistantService({ allowedLoopbackPorts: [server.port!, redirected.port!] });
      const endpoint = `http://127.0.0.1:${server.port}`;
      await expect(service.chat({ ...gateway, endpoint: `${endpoint}/redirect` }, chat)).rejects.toMatchObject({ code: "redirect-rejected" });
      expect(hits).toBe(0);
      await expect(service.chat({ ...gateway, endpoint: `${endpoint}/oversized` }, chat)).rejects.toMatchObject({ code: "invalid-response" });
      expect(await service.chat({ ...gateway, endpoint }, chat)).toEqual({ content: "repeated [redacted]", promptTokens: null, completionTokens: null });
    } finally { server.stop(true); redirected.stop(true); }
  });

  test("abort and timeout cover DNS and transport and block oversized or malformed inputs", async () => {
    let calls = 0;
    const service = new RemoteAssistantService({ modelsTimeoutMs: 25, transport: async () => { calls++; return new Promise<Response>(() => {}); } });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(service.listModels(gateway, cancelled.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
    await expect(service.listModels(gateway)).rejects.toMatchObject({ code: "timeout" });
    const dns = new RemoteAssistantService({ modelsTimeoutMs: 25, resolveAddresses: async () => new Promise<string[]>(() => {}) });
    await expect(dns.listModels(gateway)).rejects.toMatchObject({ code: "timeout" });
    await expect(service.chat(gateway, { ...chat, messages: [{ role: "user", content: "猫".repeat(8192) }] })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(service.listModels({ ...gateway, apiKey: "synthetic\r\nX-Injected: value" })).rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toBe(1);
  });

  test("trusted TLS sends the configured Host and credentials after certificate verification", async () => {
    let requests = 0;
    let host: string | undefined;
    let authorization: string | undefined;
    const cert = fileURLToPath(new URL("../test-fixtures/local-json-tls/cert.pem", import.meta.url));
    const server = createHttpsServer({ key: readFileSync(new URL("../test-fixtures/local-json-tls/key.pem", import.meta.url)),
      cert: readFileSync(cert) }, (req, res) => { requests++; host = req.headers.host; authorization = req.headers.authorization; res.end('{"data":[{"id":"tls-fixture"}]}'); });
    server.on("tlsClientError", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const connection = { ...gateway, endpoint: `https://localhost:${port}/v1` };
      await expect(new RemoteAssistantService({ allowedLoopbackPorts: [port] }).listModels(connection)).rejects.toMatchObject({ code: "unavailable" });
      expect(requests).toBe(0);
      const module = new URL("../src/remote-assistant.ts", import.meta.url).href;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e",
        `import { RemoteAssistantService } from ${JSON.stringify(module)};
        console.log(JSON.stringify(await new RemoteAssistantService({ allowedLoopbackPorts: [${port}] }).listModels(${JSON.stringify(connection)})));`], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      expect(await child.exited).toBe(0);
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual(["tls-fixture"]);
      expect(requests).toBe(1);
      expect(host).toBe(`localhost:${port}`);
      expect(authorization).toBe(`Bearer ${gateway.apiKey}`);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
