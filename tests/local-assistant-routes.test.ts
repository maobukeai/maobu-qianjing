import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildNewProfile } from "../src/create.ts";
import { handleFeatureSettingsRequest } from "../src/feature-settings.ts";
import { LocalAssistantService, type LocalAssistantChatInput, type LocalAssistantTransport } from "../src/local-assistant.ts";
import { LocalJsonTransportError, type LocalJsonTransportErrorCode } from "../src/local-json-transport.ts";
import { ProfileStore } from "../src/store.ts";
import { statePaths } from "../src/paths.ts";
import type { RemoteAssistantConnection } from "../src/remote-assistant.ts";

const model = "qwen3:8b";
const input: LocalAssistantChatInput = { model, messages: [{ role: "user", content: "Suggest a browser testing plan." }] };
const tags = { models: [{ name: model, model, size: 1_000_000, details: { parameter_size: "8B", quantization_level: "Q4_K_M" } }] };
const answer = { model, done: true, message: { role: "assistant", content: "Model fixture response: review the workflow before running it." }, created_at: "2026-11-09T05:00:00Z", prompt_eval_count: 20, eval_count: 12 };
const stores: ProfileStore[] = [], restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); for (const store of stores.splice(0)) store.close(); });
function forbiddenStore(): ProfileStore { return new Proxy({}, { get() { throw new Error("Store reads are forbidden for this request"); } }) as ProfileStore; }
function fixture(transport?: LocalAssistantTransport) {
  const calls: Array<{ endpoint: string; options: Parameters<LocalAssistantTransport>[1] }> = [];
  const assistant = new LocalAssistantService({ transport: async (endpoint, options) => { calls.push({ endpoint, options }); return transport ? transport(endpoint, options) : options.path === "/api/tags" ? tags : answer; } });
  return { calls, assistant };
}
function request(kind: "models" | "chat" | "cancel", options: { value?: unknown; raw?: string; headers?: Record<string, string>; omitHeader?: boolean; url?: string; method?: string; signal?: AbortSignal } = {}) {
  const method = options.method ?? "POST";
  return new Request(options.url ?? `http://127.0.0.1:50400/ui/api/settings/assistant/${kind}`, {
    method, signal: options.signal, headers: { "Content-Type": "application/json", ...(!options.omitHeader ? { "X-Maobu-Settings": "1" } : {}), ...options.headers },
    ...(method !== "GET" ? { body: options.raw ?? JSON.stringify(options.value ?? (kind === "chat" ? input : {})) } : {}),
  });
}
async function call(assistant: LocalAssistantService, kind: "models" | "chat" | "cancel", options: Parameters<typeof request>[1] = {}, store: ProfileStore = forbiddenStore()) {
  const response = await handleFeatureSettingsRequest(request(kind, options), store, { assistant });
  if (!response) throw new Error("Expected local assistant route response");
  return { response, data: await response.json() as any };
}

test("saved API connections test and chat explicitly, and remain bound to their workspace and reviewed endpoint", async () => {
  const temp = realpathSync(tmpdir());
  const root = mkdtempSync(join(temp, "maobu-model-routes-"));
  const paths = statePaths(root), other = statePaths(join(root, "other"));
  const modelCalls: RemoteAssistantConnection[] = [], chatCalls: Array<{ connection: RemoteAssistantConnection; messages: LocalAssistantChatInput["messages"]; system: string }> = [];
  const assistant = new LocalAssistantService({ remote: {
    async listModels(connection) { modelCalls.push(connection); return ["fixture/model@one"]; },
    async chat(connection, request) { chatCalls.push({ connection, messages: request.messages, system: request.system }); return { content: "Synthetic API reply", promptTokens: 4, completionTokens: 3 }; },
  } });
  const store = forbiddenStore();
  async function route(path: string, value?: unknown, scope = paths, extraHeaders: Record<string, string> = {}) {
    const headers = { "X-Maobu-Settings": "1", "Content-Type": "application/json", ...extraHeaders };
    const response = await handleFeatureSettingsRequest(new Request(`http://127.0.0.1:50400/ui/api/settings/assistant/${path}`, {
      method: value === undefined ? "GET" : "POST", headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }), store, { paths: scope, assistant });
    if (!response) throw new Error("Expected model service route response");
    const result = await response.json() as any;
    expect(JSON.stringify(result)).not.toContain("fixture-key-for-test");
    return { status: response.status, result };
  }
  try {
    const endpoint = "https://provider.example.com/v1", serviceModel = "fixture/model@one";
    const draft = { name: "Fixture service", endpoint, model: serviceModel, provider: "openai-compatible", apiKey: "fixture-key-for-test" };
    expect((await route("services/save", draft, paths, { Origin: "https://outside.invalid" })).status).toBe(403);
    expect((await route("services")).result.catalog).toEqual({ services: [], defaultId: null });
    const test = await route("services/test", { ...draft, model: "" });
    expect(test).toMatchObject({ status: 200, result: { catalog: { models: [{ name: serviceModel }] } } });
    expect((await route("services")).result.catalog.services).toEqual([]);
    const saved = await route("services/save", draft);
    expect(saved.status).toBe(200);
    const id = saved.result.catalog.services[0].id;
    expect(saved.result.catalog.services[0]).toMatchObject({ endpoint, credentialConfigured: true });
    expect((await route("services/default", { id })).result.catalog.defaultId).toBe(id);
    const selection = { serviceId: id, serviceEndpoint: endpoint, serviceProvider: "openai-compatible", model: serviceModel, messages: input.messages };
    expect((await route("chat", { ...selection, endpoint })).status).toBe(400);
    expect((await route("chat", { ...selection, serviceEndpoint: "https://other.example.com/v1" })).status).toBe(409);
    expect((await route("chat", selection, other)).status).toBe(404);
    expect(chatCalls).toHaveLength(0);
    const answer = await route("chat", selection);
    expect(answer).toMatchObject({ status: 200, result: { reply: { provider: "openai-compatible", model: serviceModel, message: { content: "Synthetic API reply" }, workspaceOverviewIncluded: false } } });
    expect(chatCalls[0]).toMatchObject({ connection: { endpoint, apiKey: draft.apiKey }, messages: input.messages });
    expect(chatCalls[0]?.system).not.toContain("profileCount");
    expect(modelCalls).toHaveLength(1);
    expect((await route("services/remove", { id })).result.catalog).toEqual({ services: [], defaultId: null });
  } finally {
    if (dirname(realpathSync(root)) === temp && basename(root).startsWith("maobu-model-routes-")) rmSync(root, { recursive: true, force: true });
  }
});

describe("local assistant route authorization", () => {
  test("origin and custom-header guards reject requests before transport or workspace reads", async () => {
    const f = fixture();
    for (const kind of ["models", "chat", "cancel"] as const) {
      const blocked: NonNullable<Parameters<typeof request>[1]>[] = [{ omitHeader: true }, { headers: { "X-Maobu-Settings": "wrong" } }, { headers: { Origin: "https://outside.invalid" } }, { headers: { Origin: "null" } }, { headers: { Origin: "http://127.0.0.1:50401" } }, { headers: { "Sec-Fetch-Site": "cross-site" } }, { url: `http://outside.invalid/ui/api/settings/assistant/${kind}` }];
      for (const options of blocked) {
        const result = await call(f.assistant, kind, options); expect(result.response.status).toBe(403); expect(result.data.ok).toBe(false);
      }
    }
    expect(f.calls).toHaveLength(0);
  });
  test("JSON and schema errors remain readable without leaking malformed input", async () => {
    const f = fixture();
    const contentType = await call(f.assistant, "chat", { headers: { "Content-Type": "text/plain" } }); expect(contentType.response.status).toBe(415);
    for (const raw of ['{"private-token":"sensitive-parse-fragment",BROKEN', "[]", "null"]) {
      const result = await call(f.assistant, "chat", { raw }); expect(result.response.status).toBe(400); expect(JSON.stringify(result.data)).not.toContain("sensitive-parse-fragment");
    }
    for (const value of [{ apiKey: "sensitive-api-key" }, { endpoint: 11434 }]) {
      const result = await call(f.assistant, "models", { value }); expect(result.response.status).toBe(400); expect(result.data.code).toBe("invalid-request"); expect(JSON.stringify(result.data)).not.toContain("sensitive-api-key");
    }
    expect(f.calls).toHaveLength(0);
  });
  test("remote or credential-bearing model endpoints never reach a transport", async () => {
    const f = fixture();
    for (const endpoint of ["https://ollama.com", "http://192.168.1.20:11434", "http://localhost:11434/api", "http://user:sensitive-endpoint-password@localhost:11434", "http://localhost:11434?token=sensitive-endpoint-password"]) {
      for (const kind of ["models", "chat"] as const) {
        const result = await call(f.assistant, kind, { value: kind === "chat" ? { ...input, endpoint } : { endpoint } });
        expect(result.response.status).toBe(400); expect(result.data).toMatchObject({ ok: false, code: "invalid-endpoint", retryable: false }); expect(JSON.stringify(result.data)).not.toContain("sensitive-endpoint-password");
      }
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("local assistant route data and privacy", () => {
  test("model and chat routes return the actual service DTO without a local state directory", async () => {
    const f = fixture();
    const models = await call(f.assistant, "models", { value: { endpoint: "http://localhost:11434/" }, headers: { Origin: "http://127.0.0.1:50400" } });
    expect(models.response.status).toBe(200); expect(models.data.catalog).toMatchObject({ provider: "ollama", endpoint: "http://localhost:11434", models: [{ name: model, sizeBytes: 1_000_000, parameterSize: "8B", quantization: "Q4_K_M" }] });
    const chat = await call(f.assistant, "chat"); expect(chat.response.status).toBe(200);
    expect(chat.data.reply).toMatchObject({ provider: "ollama", model, message: answer.message, workspaceOverviewIncluded: false, usage: { promptTokens: 20, completionTokens: 12 } });
    expect(chat.response.headers.get("cache-control")).toBe("no-store"); expect(chat.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(f.calls.map(call => call.options.path)).toEqual(["/api/tags", "/api/tags", "/api/chat"]);
  });
  test("workspace access remains lazy when overview is omitted or explicitly false", async () => {
    const f = fixture();
    for (const value of [input, { ...input, includeWorkspaceOverview: false }]) expect((await call(f.assistant, "chat", { value })).response.status).toBe(200);
    for (const sent of f.calls.filter(call => call.options.path === "/api/chat")) expect(JSON.stringify(sent.options.body)).not.toContain('"profileCount"');
  });
  test("explicit overview sends only anonymous counts and performs no account/session mutation", async () => {
    const store = new ProfileStore(":memory:"); stores.push(store);
    const one = buildNewProfile({ name: "sensitive-profile-name", group: "sensitive-customer-group", username: "sensitive-login-user", password: "sensitive-account-password" }, () => false); one.id = "sensitive-profile-id"; one.twofa = "sensitive-twofa-seed";
    one.proxy = { type: "http", host: "sensitive-proxy-host.invalid", port: "8080", user: "sensitive-proxy-user", pass: "sensitive-proxy-password" };
    one.cookies = [{ name: "auth", value: "sensitive-cookie-value", domain: ".example.com", path: "/" }];
    const two = { ...buildNewProfile({ name: "sensitive-second-name", group: "sensitive-second-group" }, () => false), id: "sensitive-second-id" };
    store.upsertProfiles([one, two]); store.saveSessionBundle(one.id, '{"cookies":[],"origins":[],"private":"sensitive-session-content"}');
    store.recordLaunch({ profileId: one.id, pid: 123, debugPort: 9222, ws: "ws://127.0.0.1:9222/sensitive-private-control-token", startedAt: 1 });
    const before = store.listProfiles(), launch = store.getLaunch(one.id);
    const sessions = spyOn(store, "getSessionBundle").mockImplementation(() => { throw new Error("Do not read saved session bodies"); }); restores.push(() => sessions.mockRestore());
    const writes = spyOn(store, "upsertProfiles").mockImplementation(() => { throw new Error("Do not write profile identities"); }); restores.push(() => writes.mockRestore());
    const f = fixture(); const result = await call(f.assistant, "chat", { value: { ...input, includeWorkspaceOverview: true } }, store);
    expect(result.response.status).toBe(200); expect(result.data.reply.workspaceOverviewIncluded).toBe(true);
    const body = f.calls.find(call => call.options.path === "/api/chat")!.options.body as any;
    const system = body.messages[0].content as string;
    expect(system).toContain('"profileCount":2'); expect(system).toContain('"runningCount":1'); expect(system).toContain('"groupCount":2'); expect(system).toContain('"proxyConfiguredCount":1'); expect(system).toContain("Group 1");
    for (const value of ["sensitive-profile-name", "sensitive-customer-group", "sensitive-login-user", "sensitive-account-password", "sensitive-profile-id", "sensitive-twofa-seed", "sensitive-proxy-host", "sensitive-proxy-user", "sensitive-proxy-password", "sensitive-cookie-value", "sensitive-session-content", "sensitive-private-control-token", "sensitive-second-name", "sensitive-second-group", "sensitive-second-id"]) {
      expect(JSON.stringify(body)).not.toContain(value); expect(JSON.stringify(result.data)).not.toContain(value);
    }
    expect(sessions).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(store.listProfiles()).toEqual(before); expect(store.getLaunch(one.id)).toEqual(launch);
  });
  test("remote model aliases are excluded before any prompt is sent", async () => {
    const f = fixture(async () => ({ models: [{ name: model, remote_model: "remote-alias", remote_host: "https://remote.invalid" }] }));
    const models = await call(f.assistant, "models"); expect(models.data.catalog.models).toEqual([]); expect(models.data.catalog.excludedRemoteModels).toBe(1);
    const chat = await call(f.assistant, "chat"); expect(chat.response.status).toBe(400); expect(chat.data.code).toBe("model-not-local");
    expect(f.calls.every(call => call.options.path === "/api/tags")).toBe(true);
  });
});

describe("local assistant route errors and aborts", () => {
  test("provider failure codes map to their HTTP status without including raw exceptions", async () => {
    const cases: Array<[LocalJsonTransportErrorCode, number | undefined, number, string, boolean]> = [["unavailable", undefined, 503, "unavailable", true], ["timeout", undefined, 504, "timeout", true], ["http_error", 500, 502, "provider-error", true], ["http_error", 404, 404, "model-not-found", false], ["invalid_json", undefined, 502, "invalid-response", false], ["response_too_large", undefined, 502, "invalid-response", false]];
    for (const [transportCode, providerStatus, status, code, retryable] of cases) {
      const f = fixture(async (_endpoint, options) => { if (options.path === "/api/tags") return tags; throw new LocalJsonTransportError(transportCode, providerStatus); });
      const result = await call(f.assistant, "chat"); expect(result.response.status).toBe(status); expect(result.data).toMatchObject({ ok: false, code, retryable });
    }
    const failed = fixture(async () => { throw new Error("sensitive-provider-prompt-fragment"); });
    const result = await call(failed.assistant, "chat"); expect(result.response.status).toBe(503); expect(JSON.stringify(result.data)).not.toContain("sensitive-provider-prompt-fragment");
  });
  test("invalid and incomplete generated responses never become successful assistant replies", async () => {
    for (const payload of [{ ...answer, done: false }, { ...answer, message: { role: "assistant", content: "" } }, { error: "sensitive-model-error-fragment" }]) {
      const f = fixture(async (_endpoint, options) => options.path === "/api/tags" ? tags : payload);
      const result = await call(f.assistant, "chat"); expect(result.response.status).toBe(502); expect(result.data.ok).toBe(false); expect(result.data.reply).toBeUndefined(); expect(JSON.stringify(result.data)).not.toContain("sensitive-model-error-fragment");
    }
  });
  test("the HTTP request AbortSignal cancels an active generation and releases the service", async () => {
    let resolveStarted: (() => void) | undefined, signal: AbortSignal | null = null, hanging = true;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const f = fixture(async (_endpoint, options) => { if (options.path === "/api/tags") return tags; if (!hanging) return answer; signal = options.signal ?? null; resolveStarted!(); return new Promise(() => {}); });
    const controller = new AbortController(); const pending = call(f.assistant, "chat", { signal: controller.signal });
    await started; expect(signal!.aborted).toBe(false); controller.abort();
    const cancelled = await pending; expect(cancelled.response.status).toBe(499); expect(cancelled.data).toMatchObject({ ok: false, code: "cancelled", retryable: false }); expect(signal!.aborted).toBe(true);
    hanging = false; expect((await call(f.assistant, "chat")).response.status).toBe(200);
  });
  test("explicit cancellation is scoped to the owning store, finishes generation and releases the chat lock", async () => {
    let resolveStarted: (() => void) | undefined, signal: AbortSignal | null = null, hanging = true;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const f = fixture(async (_endpoint, options) => { if (options.path === "/api/tags") return tags; if (!hanging) return answer; signal = options.signal ?? null; resolveStarted!(); return new Promise(() => {}); });
    const owner = forbiddenStore(), other = forbiddenStore(), requestId = randomUUID();
    const pending = call(f.assistant, "chat", { value: { ...input, requestId } }, owner); await started;
    const notOwner = await call(f.assistant, "cancel", { value: { requestId } }, other); expect(notOwner.data).toEqual({ ok: true, cancelled: false }); expect(signal!.aborted).toBe(false);
    const forbidden = await call(f.assistant, "cancel", { value: { requestId }, omitHeader: true }, owner); expect(forbidden.response.status).toBe(403); expect(signal!.aborted).toBe(false);
    const cancelled = await call(f.assistant, "cancel", { value: { requestId: requestId.toUpperCase() } }, owner); expect(cancelled.data).toEqual({ ok: true, cancelled: true });
    const original = await pending; expect(original.response.status).toBe(499); expect(original.data.code).toBe("cancelled"); expect(signal!.aborted).toBe(true);
    expect((await call(f.assistant, "cancel", { value: { requestId } }, owner)).data.cancelled).toBe(false);
    hanging = false; const next = await call(f.assistant, "chat", { value: { ...input, requestId } }, owner); expect(next.response.status).toBe(200);
    for (const sent of f.calls.filter(call => call.options.path === "/api/chat")) expect(JSON.stringify(sent.options.body)).not.toContain(requestId);
  });
  test("a duplicate request ID cannot replace or delete another active cancellation controller", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const active = fixture(async (_endpoint, options) => { if (options.path === "/api/tags") return tags; resolveStarted!(); return new Promise(() => {}); });
    const other = fixture(), store = forbiddenStore(), requestId = randomUUID();
    const pending = call(active.assistant, "chat", { value: { ...input, requestId } }, store); await started;
    const duplicate = await call(other.assistant, "chat", { value: { ...input, requestId: requestId.toUpperCase() } }, store);
    expect(duplicate.response.status).toBe(409); expect(duplicate.data).toMatchObject({ ok: false, code: "busy", retryable: true }); expect(other.calls).toHaveLength(0);
    expect((await call(active.assistant, "cancel", { value: { requestId } }, store)).data.cancelled).toBe(true); expect((await pending).data.code).toBe("cancelled");
  });
  test("invalid request IDs and cancellation schemas fail before IO, and failed requests do not reserve IDs", async () => {
    const f = fixture(), store = forbiddenStore();
    for (const requestId of ["", "sensitive-invalid-request-id", 42, null, "../outside"]) {
      for (const kind of ["chat", "cancel"] as const) {
        const value = kind === "chat" ? { ...input, requestId } : { requestId };
        const result = await call(f.assistant, kind, { value }, store); expect(result.response.status).toBe(400); expect(result.data.code).toBe("invalid-request"); expect(JSON.stringify(result.data)).not.toContain("sensitive-invalid-request-id");
      }
    }
    expect((await call(f.assistant, "cancel", { value: { requestId: randomUUID(), endpoint: "http://localhost:11434" } }, store)).response.status).toBe(400);
    expect(f.calls).toHaveLength(0);
    const requestId = randomUUID(); const invalid = await call(f.assistant, "chat", { value: { ...input, messages: [], requestId } }, store); expect(invalid.response.status).toBe(400);
    expect((await call(f.assistant, "chat", { value: { ...input, requestId } }, store)).response.status).toBe(200);
    expect((await call(f.assistant, "cancel", { value: { requestId } }, store)).data.cancelled).toBe(false);
  });
});
