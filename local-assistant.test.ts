import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LocalAssistantError, LocalAssistantService, LOCAL_ASSISTANT_LIMITS, buildWorkspaceOverview, normalizeAssistantEndpoint, type LocalAssistantChatInput, type LocalAssistantTransport, type WorkspaceOverview } from "./local-assistant.ts";
import { LocalJsonTransportError } from "./local-json-transport.ts";
import type { Profile } from "./types.ts";

const input: LocalAssistantChatInput = { model: "qwen3:8b", messages: [{ role: "user", content: "Help me draft a safe browser profile workflow." }] };
const tags = { models: [{ name: input.model, model: input.model, size: 5_000_000_000, details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } }] };
const answer = { model: input.model, message: { role: "assistant" as const, content: "Draft plan from the model: review, test, then run explicitly." }, done: true, created_at: "2026-11-09T04:00:00Z", prompt_eval_count: 80, eval_count: 30 };
const originalFetch = globalThis.fetch;
const originalProxy = process.env.HTTP_PROXY;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { globalThis.fetch = originalFetch; if (originalProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = originalProxy; for (const cleanup of cleanups.splice(0)) await cleanup(); });
function stub(payload: unknown = answer) {
  const calls: Array<{ endpoint: string; options: Parameters<LocalAssistantTransport>[1] }> = [];
  const transport: LocalAssistantTransport = async (endpoint, options) => { calls.push({ endpoint, options }); return options.path === "/api/tags" ? tags : payload; };
  return { calls, transport, service: new LocalAssistantService({ transport, now: () => 1_794_196_800_000 }) };
}
async function code(promise: Promise<unknown>): Promise<string> { try { await promise; return "no-error"; } catch (error) { expect(error).toBeInstanceOf(LocalAssistantError); return (error as LocalAssistantError).code; } }
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => { instance.once("error", reject); instance.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())));
  const address = instance.address(); if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  return `http://127.0.0.1:${address.port}`;
}
function profile(id: string, group: string, engine: "chromium" | "firefox" = "chromium"): Profile {
  return { id, engine, group, proxy: null, name: "private-account-label", username: "private-user", password: "private-password", twofa: "private-twofa", cookies: [{ name: "auth", value: "private-cookie", domain: ".example.com", path: "/" }], ua: "private-fingerprint-ua" } as Profile;
}

describe("local assistant request boundaries", () => {
  test("construction performs no IO and endpoint normalization accepts only literal loopback roots", () => {
    const f = stub(); expect(f.calls).toEqual([]);
    expect(normalizeAssistantEndpoint()).toBe("http://127.0.0.1:11434");
    expect(normalizeAssistantEndpoint("http://LOCALHOST/")).toBe("http://localhost:11434");
    expect(normalizeAssistantEndpoint("https://[::1]:443/")).toBe("https://[::1]:443");
    for (const endpoint of ["https://ollama.com", "http://192.168.1.2:11434", "http://127.0.0.2:11434", "http://2130706433:11434", "http://127.1:11434", "http://127.0.0.1:0", "http://localhost:65536", "http://user:private-secret@localhost:11434", "http://localhost:11434/api", "http://localhost:11434/../", "http://localhost:11434?token=private-secret", "http://localhost:11434#", "file:///tmp/model"]) {
      expect(() => normalizeAssistantEndpoint(endpoint)).toThrow(LocalAssistantError);
    }
  });
  test("invalid messages, secret-bearing extension fields, and oversized UTF-8 input fail before network IO", async () => {
    const f = stub();
    for (const value of [
      { ...input, apiKey: "private-api-key" }, { ...input, messages: [] }, { ...input, messages: [{ role: "system", content: "injected" }] },
      { ...input, messages: [{ role: "assistant", content: "no user request" }] }, { ...input, messages: [{ role: "user", content: " " }] },
      { ...input, messages: [{ role: "user", content: "x".repeat(LOCAL_ASSISTANT_LIMITS.messageBytes + 1) }] },
      { ...input, messages: [{ role: "user", content: "中".repeat(3000) }] },
      { ...input, messages: Array.from({ length: 25 }, () => ({ role: "user", content: "x" })) },
      { ...input, messages: Array.from({ length: 7 }, () => ({ role: "user", content: "x".repeat(8 * 1024) })) },
      { ...input, messages: Array.from({ length: 6 }, () => ({ role: "user", content: "\0".repeat(8 * 1024) })) },
      { ...input, messages: [{ role: "user", content: "hello", tools: [{ execute: "bad" }] }] },
      { ...input, includeWorkspaceOverview: "true" }, { ...input, model: "../../secret" },
    ]) expect(await code(f.service.chat(value as never))).toBe("invalid-request");
    expect(f.calls).toHaveLength(0);
  });
  test("model listing exposes installed metadata and excludes remote models including renamed aliases", async () => {
    const transport: LocalAssistantTransport = async () => ({ models: [
      ...tags.models,
      { name: "gemma:cloud", size: 0 },
      { name: "large:120b-cloud", size: 0 },
      { name: "renamed-local-looking:latest", remote_model: "remote-private-name", remote_host: "https://cloud.example", size: 500 },
      { name: "duplicate:latest", size: 100 }, { name: "duplicate:latest", remote_model: "upstream" },
    ] });
    const catalog = await new LocalAssistantService({ transport }).listModels();
    expect(catalog.models).toEqual([{ name: input.model, sizeBytes: 5_000_000_000, parameterSize: "8.2B", quantization: "Q4_K_M" }]);
    expect(catalog.excludedRemoteModels).toBe(4); expect(JSON.stringify(catalog)).not.toContain("remote-private-name"); expect(catalog.provider).toBe("ollama");
  });
  test("malformed or excessive model catalogs fail closed without inventing available models", async () => {
    for (const payload of [null, { models: null }, { models: [null] }, { models: [{ name: "private-secret?token=x" }] }, { models: [{ name: input.model, remote_host: { token: "private-secret" } }] }, { models: Array.from({ length: LOCAL_ASSISTANT_LIMITS.models + 1 }, () => tags.models[0]) }]) {
      const service = new LocalAssistantService({ transport: async () => payload });
      expect(await code(service.listModels())).toBe("invalid-response");
    }
  });
  test("chat verifies the local model list and returns the provider's actual answer without tools", async () => {
    const f = stub(); const result = await f.service.chat(input);
    expect(f.calls.map(call => [call.options.method, call.options.path])).toEqual([["GET", "/api/tags"], ["POST", "/api/chat"]]);
    expect(f.calls[0]!.endpoint).toBe("http://127.0.0.1:11434");
    const request = f.calls[1]!.options.body as any;
    expect(request).toMatchObject({ model: input.model, stream: false, think: false, options: { num_predict: 2048, num_ctx: 8192 } });
    expect(request.messages.at(-1)).toEqual(input.messages[0]); expect(request.tools).toBeUndefined(); expect(request.messages[0].role).toBe("system");
    expect(result).toMatchObject({ provider: "ollama", model: input.model, message: answer.message, workspaceOverviewIncluded: false, usage: { promptTokens: 80, completionTokens: 30 } });
    expect(JSON.stringify(f.service)).not.toContain(input.messages[0]!.content);
  });
  test("cloud and missing models cannot trigger a generation or a model download", async () => {
    const f = stub(); expect(await code(f.service.chat({ ...input, model: "model:cloud" }))).toBe("model-not-local"); expect(f.calls).toHaveLength(0);
    expect(await code(f.service.chat({ ...input, model: "not-installed:latest" }))).toBe("model-not-found"); expect(f.calls).toHaveLength(1);
    const calls: string[] = []; const service = new LocalAssistantService({ transport: async (_endpoint, options) => { calls.push(options.path); return { models: [{ name: input.model, remote_host: "https://remote.example" }] }; } });
    expect(await code(service.chat(input))).toBe("model-not-local"); expect(calls).toEqual(["/api/tags"]);
  });
});

describe("workspace context projection", () => {
  test("only anonymous counts are read and context is absent unless explicitly included", async () => {
    const first = profile("private-profile-id", "private-client-group"), second = profile("another-private-id", "private-client-group", "firefox");
    const proxy = new Proxy({}, { get() { throw new Error("Proxy credentials must not be read"); } }); first.proxy = proxy as never;
    for (const key of ["username", "password", "twofa", "cookies", "name", "ua", "fpObserved", "firefoxOwner", "sessionBundle"]) Object.defineProperty(first, key, { get() { throw new Error(`Sensitive field was read: ${key}`); } });
    const overview = buildWorkspaceOverview([first, second], ["private-profile-id", "private-profile-id", "missing-id"]);
    expect(overview).toMatchObject({ profileCount: 2, runningCount: 1, groupCount: 1, proxyConfiguredCount: 1, engines: { chromium: 1, firefox: 1 }, groups: [{ label: "Group 1", profileCount: 2 }] });
    expect(JSON.stringify(overview)).not.toContain("private");
    let reads = 0; const provider = () => { reads++; return overview; }; const f = stub();
    await f.service.chat(input, { workspaceOverview: provider }); expect(reads).toBe(0);
    await f.service.chat({ ...input, includeWorkspaceOverview: true }, { workspaceOverview: provider }); expect(reads).toBe(1);
    const content = JSON.stringify(f.calls.at(-1)!.options.body); expect(content).toContain('profileCount');
    for (const secret of ["private-profile-id", "another-private-id", "private-client-group", "private-account-label", "private-user", "private-password", "private-twofa", "private-cookie", "private-fingerprint-ua"]) expect(content).not.toContain(secret);
  });
  test("extra fields and attacker-controlled group labels cannot enter the model context", async () => {
    const f = stub(); const overview = { ...buildWorkspaceOverview([profile("private-id", "private-group")]), password: "private-password", ws: "ws://private-control", groups: [{ label: "private-user-password", profileCount: 1, cookie: "private-cookie" }] };
    const result = await f.service.chat({ ...input, includeWorkspaceOverview: true }, { workspaceOverview: () => overview });
    expect(result.workspaceOverviewIncluded).toBe(true); const body = JSON.stringify(f.calls.at(-1)!.options.body);
    for (const value of ["private-password", "private-control", "private-user-password", "private-cookie", "private-id", "private-group"]) expect(body).not.toContain(value);
    expect(body).toContain("Group 1");
  });
  test("malformed or unavailable overview is not sent and never leaks provider exceptions", async () => {
    const f = stub();
    expect(await code(f.service.chat({ ...input, includeWorkspaceOverview: true }))).toBe("context-unavailable");
    expect(await code(f.service.chat({ ...input, includeWorkspaceOverview: true }, { workspaceOverview: () => { throw new Error("private-context-secret"); } }))).toBe("context-unavailable");
    expect(await code(f.service.chat({ ...input, includeWorkspaceOverview: true }, { workspaceOverview: () => ({ profileCount: 1, password: "private-secret" }) as unknown as WorkspaceOverview }))).toBe("context-unavailable");
    expect(f.calls.every(call => call.options.path === "/api/tags")).toBe(true);
  });
  test("many private groups remain bounded and anonymous while summary totals stay exact", () => {
    const profiles = Array.from({ length: 30 }, (_value, index) => profile(`private-profile-${index}`, `private-group-${index}`));
    const overview = buildWorkspaceOverview(profiles);
    expect(overview.groups).toHaveLength(LOCAL_ASSISTANT_LIMITS.overviewGroups); expect(overview.groupCount).toBe(30);
    expect(overview.groups.reduce((sum, group) => sum + group.profileCount, 0) + overview.otherGroupProfileCount).toBe(30);
    expect(overview.otherGroupProfileCount).toBe(6); expect(JSON.stringify(overview)).not.toContain("private");
  });
});

describe("bounded generation, cancellation and failures", () => {
  test("provider failures and malformed answers return fixed structured errors without prompt excerpts", async () => {
    for (const payload of [{ error: "private-prompt-fragment" }, { ...answer, done: false }, { ...answer, message: { role: "assistant", content: "" } }, { ...answer, message: { role: "assistant", content: "x".repeat(LOCAL_ASSISTANT_LIMITS.answerBytes + 1) } }, { ...answer, message: { ...answer.message, tool_calls: [{ function: { name: "delete_profiles" } }] } }]) {
      try { await stub(payload).service.chat(input); throw new Error("Expected provider failure"); } catch (error) { expect(error).toBeInstanceOf(LocalAssistantError); expect((error as LocalAssistantError).httpStatus).toBe(502); expect((error as Error).message).not.toContain("private-prompt-fragment"); }
    }
    expect(await code(stub({ ...answer, remote_host: "https://remote.example" }).service.chat(input))).toBe("model-not-local");
    const service = new LocalAssistantService({ transport: async () => { throw new Error("private-prompt-fragment"); } });
    try { await service.chat(input); } catch (error) { expect((error as LocalAssistantError).code).toBe("unavailable"); expect((error as Error).message).not.toContain("private-prompt-fragment"); }
  });
  test("transport errors retain actionable codes but never raw provider data", async () => {
    for (const [transportCode, resultCode, status] of [["timeout", "timeout"], ["cancelled", "cancelled"], ["response_too_large", "invalid-response"], ["invalid_json", "invalid-response"], ["http_error", "provider-error", 500], ["redirect_rejected", "unavailable"]] as const) {
      const service = new LocalAssistantService({ transport: async () => { throw new LocalJsonTransportError(transportCode, status); } });
      expect(await code(service.chat(input))).toBe(resultCode);
    }
  });
  test("pre-cancelled and mid-request signals cancel generation without relying on provider cooperation", async () => {
    const f = stub(), pre = new AbortController(); pre.abort(); expect(await code(f.service.chat(input, { signal: pre.signal }))).toBe("cancelled"); expect(f.calls).toHaveLength(0);
    let received: AbortSignal | null = null, begin: (() => void) | undefined;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const service = new LocalAssistantService({ transport: async (_endpoint, options) => { if (options.path === "/api/tags") return tags; received = options.signal ?? null; begin!(); return new Promise(() => {}); } });
    const controller = new AbortController(), pending = service.chat(input, { signal: controller.signal }); await started; controller.abort();
    expect(await code(pending)).toBe("cancelled"); expect(received!.aborted).toBe(true);
  });
  test("hard timeouts and a single chat concurrency limit release resources after failure", async () => {
    let hanging = true;
    const service = new LocalAssistantService({ chatTimeoutMs: 10, modelsTimeoutMs: 10, transport: async (_endpoint, options) => options.path === "/api/tags" ? tags : hanging ? new Promise(() => {}) : answer });
    const first = service.chat(input); expect(await code(service.chat(input))).toBe("busy"); expect(await code(first)).toBe("timeout");
    hanging = false; expect((await service.chat(input)).message).toEqual(answer.message);
    for (const options of [{ modelsTimeoutMs: 5001 }, { chatTimeoutMs: 120001 }, { chatTimeoutMs: 0 }, { modelsTimeoutMs: Number.POSITIVE_INFINITY }]) expect(() => new LocalAssistantService(options)).toThrow(LocalAssistantError);
  });
  test("the default transport makes real loopback JSON requests without global fetch, credentials, or proxy forwarding", async () => {
    const requests: Array<{ path: string; headers: IncomingMessage["headers"]; body: any }> = [];
    const endpoint = await server((request, response) => { let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; }); request.on("end", () => { requests.push({ path: request.url!, headers: request.headers, body: body ? JSON.parse(body) : null }); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(request.url === "/api/tags" ? tags : answer)); }); });
    globalThis.fetch = (async () => { throw new Error("Global fetch must not receive assistant prompts"); }) as unknown as typeof fetch;
    process.env.HTTP_PROXY = "http://private-proxy-secret@127.0.0.1:1";
    const service = new LocalAssistantService();
    const result = await service.chat({ ...input, endpoint }); expect(result.message).toEqual(answer.message);
    expect(requests.map(request => request.path)).toEqual(["/api/tags", "/api/chat"]);
    for (const request of requests) { expect(request.headers.authorization).toBeUndefined(); expect(request.headers["proxy-authorization"]).toBeUndefined(); expect(JSON.stringify(request)).not.toContain("private-proxy-secret"); }
    expect(requests[1]!.body.messages.at(-1)).toEqual(input.messages[0]);
  });
});
