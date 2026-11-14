/** Text-only model APIs over explicitly configured, directly dialled connections. */
import { lookup } from "node:dns/promises";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import { EgressResponseError, openTcp, readHttp } from "./egress-transport.ts";
import { canonicalIp } from "./ip.ts";

export type RemoteModelProvider = "openai-compatible" | "anthropic" | "gemini";
export interface RemoteAssistantConnection { provider: RemoteModelProvider; endpoint: string; apiKey: string }
type Message = { role: "user" | "assistant"; content: string };
interface RemoteChatInput { model: string; messages: Message[]; system: string; signal?: AbortSignal }
interface RemoteChatResult { content: string; promptTokens: number | null; completionTokens: number | null }

const errors = {
  "invalid-endpoint": [400, false, "Use HTTPS for public model services, or HTTP or HTTPS for an explicit loopback address."],
  "invalid-request": [400, false, "The model service request is invalid or exceeds the message limits."],
  auth: [401, false, "The model service rejected the API key. Check the key and its permissions."],
  "rate-limited": [429, true, "The model service is rate limited. Wait and try again."],
  unavailable: [503, true, "Could not connect to the model service. Check the address and your network."],
  timeout: [504, true, "The model service request timed out. Try again."],
  cancelled: [499, false, "The model service request was cancelled."],
  "provider-error": [502, true, "The model service could not complete the request."],
  "invalid-response": [502, false, "The model service returned an invalid, incomplete, or oversized response."],
  "model-list-unavailable": [404, false, "This service does not provide a model list. Enter a model ID manually."],
  "model-not-found": [404, false, "The model service could not find the selected model. Check its model ID."],
  "redirect-rejected": [502, false, "The model service redirected the request. Use its final API address."],
} as const;
export type RemoteAssistantErrorCode = keyof typeof errors;
export class RemoteAssistantError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(readonly code: RemoteAssistantErrorCode) {
    const [status, retryable, message] = errors[code];
    super(message);
    this.name = "RemoteAssistantError";
    this.httpStatus = status;
    this.retryable = retryable;
  }
}

const MAX_MODELS = 256;
const MAX_CATALOG_PAGES = 3;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const GEMINI_MODEL_ID = /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BASE_URL = /^(https?):\/\/(\[[\da-f:.]+\]|[a-z\d-]+(?:\.[a-z\d-]+)*)(?::([1-9]\d{0,4}))?((?:\/[a-z\d._~-]+)*\/?)$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (code: RemoteAssistantErrorCode): never => { throw new RemoteAssistantError(code); };
const tokenCount = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;

export function isRemoteAssistantModelId(value: unknown, provider?: RemoteModelProvider): value is string {
  return typeof value === "string" && value.length <= 200 && !value.includes("//") && !value.includes("..")
    && (provider === "gemini" ? GEMINI_MODEL_ID : MODEL_ID).test(value);
}

/** Reject non-routable, private and transition ranges before dialing the numeric address. */
function publicAddress(value: string): string | null {
  const normalized = canonicalIp(value);
  if (!normalized) return null;
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return null;
    return normalized;
  }
  const [high, next] = normalized.split(":");
  const prefix = Number.parseInt(high!, 16), second = Number.parseInt(next || "0", 16);
  if (!(prefix >= 0x2000 && prefix < 0x4000) || prefix === 0x2002 || prefix === 0x3fff
    || (prefix === 0x2001 && (second <= 0x01ff || second === 0x0db8))) return null;
  return normalized;
}

export const DEFAULT_LOCAL_LLM_PORTS = Object.freeze([1234, 8000, 8080, 11434, 11435] as const);

export interface NormalizeRemoteAssistantEndpointOptions {
  allowedLoopbackPorts?: Iterable<number>;
}

function explicitLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isBlockedInternalLoopbackPort(port: number): boolean {
  // Never permit self-loopback to Maobu dashboard or CDP debug ports.
  if (port === 50400 || (port >= 9222 && port <= 9999)) return true;
  const envPort = Number(process.env.MAOBU_DASHBOARD_PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 && port === envPort) return true;
  return false;
}

function allowedLoopbackPort(url: URL, allowedLoopbackPorts?: Iterable<number>): boolean {
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (isBlockedInternalLoopbackPort(port)) return false;
  if (allowedLoopbackPorts !== undefined) {
    const allowed = new Set<number>();
    for (const candidate of allowedLoopbackPorts) {
      if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) allowed.add(candidate);
    }
    return allowed.has(port);
  }
  // Block privileged ports (< 1024) by default while allowing custom/ephemeral local LLM ports.
  return port >= 1024;
}

function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ""); }

export function normalizeRemoteAssistantEndpoint(value: unknown, options?: NormalizeRemoteAssistantEndpointOptions): string {
  if (typeof value !== "string" || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return fail("invalid-endpoint");
  const source = value.trim(), match = BASE_URL.exec(source);
  if (!match || match[4]!.split("/").some(segment => segment === "." || segment === "..")) return fail("invalid-endpoint");
  let url: URL;
  try { url = new URL(source); } catch { return fail("invalid-endpoint"); }
  const host = hostname(url);
  const literal = isIP(host);
  // Require an explicit loopback spelling. WHATWG URL also accepts numeric shorthand.
  if (literal === 4 && match[2] !== host) return fail("invalid-endpoint");
  if (explicitLoopback(host)) {
    if (!allowedLoopbackPort(url, options?.allowedLoopbackPorts)) return fail("invalid-endpoint");
  } else {
    if (url.protocol !== "https:" || (literal ? !publicAddress(host)
      : !host.includes(".") || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)
        || host.length > 253 || host.split(".").some(label => label.length > 63 || label.startsWith("-") || label.endsWith("-")))) return fail("invalid-endpoint");
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

interface ProviderRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Buffer;
  responseBytes: number;
}
type ProviderTransport = (request: ProviderRequest, signal: AbortSignal) => Promise<Response>;
type ResolveAddresses = (host: string) => Promise<readonly string[]>;
export interface RemoteAssistantServiceOptions {
  transport?: ProviderTransport;
  resolveAddresses?: ResolveAddresses;
  modelsTimeoutMs?: number;
  chatTimeoutMs?: number;
  allowedLoopbackPorts?: Iterable<number>;
}

function awaitAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

async function dialAddress(host: string, resolveAddresses: ResolveAddresses, signal: AbortSignal): Promise<string> {
  if (explicitLoopback(host)) return host === "localhost" ? "127.0.0.1" : host;
  const resolved = isIP(host) ? [host] : await awaitAbort(resolveAddresses(host), signal);
  if (!resolved.length || resolved.length > 32) return fail("unavailable");
  const addresses = resolved.map(publicAddress);
  if (addresses.some(address => !address)) return fail("invalid-endpoint");
  return addresses.find(address => address && isIP(address) === 4) ?? addresses[0]!;
}

function secureSocket(socket: Socket, host: string, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, host, servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate) });
    const abort = () => { secure.destroy(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    secure.on("error", error => { cleanup(); reject(error); });
    secure.once("close", () => { cleanup(); reject(new Error("Model service TLS connection closed")); });
    secure.once("secureConnect", () => { cleanup(); resolve(secure); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

async function directRequest(request: ProviderRequest, signal: AbortSignal, resolveAddresses: ResolveAddresses): Promise<Response> {
  const { url, method, headers, body, responseBytes } = request;
  const host = hostname(url);
  const address = await dialAddress(host, resolveAddresses, signal);
  signal.throwIfAborted();
  const socket = await openTcp(address, Number(url.port || (url.protocol === "https:" ? 443 : 80)), signal);
  let active = socket;
  try {
    if (url.protocol === "https:") active = await secureSocket(socket, host, signal);
    const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, "Accept: application/json", "Accept-Encoding: identity", "Connection: close"];
    for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
    if (body) lines.push("Content-Type: application/json", `Content-Length: ${body.length}`);
    const head = Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1");
    return await readHttp(active, body ? Buffer.concat([head, body]) : head, signal, false,
      { maxBodyBytes: responseBytes, maxWireBytes: responseBytes + 1024 * 1024 });
  } finally { active.destroy(); socket.destroy(); }
}

function validatedConnection(connection: RemoteAssistantConnection, allowedLoopbackPorts?: Iterable<number>): RemoteAssistantConnection {
  if (!connection || !["openai-compatible", "anthropic", "gemini"].includes(connection.provider)) return fail("invalid-request");
  const endpoint = normalizeRemoteAssistantEndpoint(connection.endpoint, { allowedLoopbackPorts });
  if (typeof connection.apiKey !== "string" || !/^[\x21-\x7e]{0,2048}$/.test(connection.apiKey)) return fail("invalid-request");
  if (!connection.apiKey && connection.provider !== "openai-compatible") return fail("auth");
  return { provider: connection.provider, endpoint, apiKey: connection.apiKey };
}

function credentials(connection: RemoteAssistantConnection): Record<string, string> {
  switch (connection.provider) {
    case "openai-compatible": return connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {};
    case "anthropic": return { "x-api-key": connection.apiKey, "anthropic-version": "2026-10-21" };
    case "gemini": return { "x-goog-api-key": connection.apiKey };
  }
}

function statusError(status: number, list: boolean): never {
  if (status >= 300 && status < 400) return fail("redirect-rejected");
  if (status === 401 || status === 403) return fail("auth");
  if (status === 429) return fail("rate-limited");
  if (status === 408 || status === 504) return fail("timeout");
  if (list && [404, 405, 501].includes(status)) return fail("model-list-unavailable");
  if (status === 404) return fail("model-not-found");
  if (status === 503) return fail("unavailable");
  return fail("provider-error");
}

function validatedMessages(input: RemoteChatInput, provider: RemoteModelProvider): Message[] {
  if (!input || !isRemoteAssistantModelId(input.model, provider) || typeof input.system !== "string" || Buffer.byteLength(input.system) > 16 * 1024
    || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 24 || input.messages.at(-1)?.role !== "user") return fail("invalid-request");
  let bytes = 0;
  return input.messages.map(message => {
    if (!record(message) || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || !message.content.trim()) return fail("invalid-request");
    const size = Buffer.byteLength(message.content);
    bytes += size;
    if (size > 8 * 1024 || bytes > 48 * 1024) return fail("invalid-request");
    return { role: message.role, content: message.content };
  });
}

function textParts(value: unknown, accept: (part: Record<string, unknown>) => boolean): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap(part => record(part) && accept(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function answer(payload: unknown, connection: RemoteAssistantConnection): RemoteChatResult {
  if (!record(payload) || Object.hasOwn(payload, "error")) return fail("invalid-response");
  let content: string, prompt: unknown, completion: unknown;
  if (connection.provider === "anthropic") {
    const usage = record(payload.usage) ? payload.usage : {};
    content = textParts(payload.content, part => part.type === "text");
    prompt = usage.input_tokens; completion = usage.output_tokens;
  } else if (connection.provider === "gemini") {
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts = record(candidate) && record(candidate.content) ? candidate.content.parts : null;
    const usage = record(payload.usageMetadata) ? payload.usageMetadata : {};
    content = textParts(parts, part => part.thought !== true);
    prompt = usage.promptTokenCount; completion = usage.candidatesTokenCount;
  } else {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const parts = record(choice) && record(choice.message) ? choice.message.content : null;
    const usage = record(payload.usage) ? payload.usage : {};
    content = typeof parts === "string" ? parts : textParts(parts, part => part.type === "text");
    prompt = usage.prompt_tokens; completion = usage.completion_tokens;
  }
  if (!content.trim() || Buffer.byteLength(content) > MAX_ANSWER_BYTES) return fail("invalid-response");
  // An untrusted compatible service can echo its own request headers in a response.
  if (connection.apiKey) content = content.replaceAll(connection.apiKey, "[redacted]");
  if (Buffer.byteLength(content) > MAX_ANSWER_BYTES) return fail("invalid-response");
  return { content, promptTokens: tokenCount(prompt), completionTokens: tokenCount(completion) };
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map(item => item.address);
}

export class RemoteAssistantService {
  private readonly transport: ProviderTransport;
  private readonly modelsTimeoutMs: number;
  private readonly chatTimeoutMs: number;
  private readonly allowedLoopbackPorts?: readonly number[];

  constructor(options: RemoteAssistantServiceOptions = {}) {
    const resolveAddresses = options.resolveAddresses ?? defaultResolve;
    this.transport = options.transport ?? ((request, signal) => directRequest(request, signal, resolveAddresses));
    this.modelsTimeoutMs = options.modelsTimeoutMs ?? 10_000;
    this.chatTimeoutMs = options.chatTimeoutMs ?? 120_000;
    this.allowedLoopbackPorts = options.allowedLoopbackPorts ? [...options.allowedLoopbackPorts] : undefined;
    if (![this.modelsTimeoutMs, this.chatTimeoutMs].every(timeout => Number.isInteger(timeout) && timeout >= 1 && timeout <= 120_000)) fail("invalid-request");
  }

  private async call(connection: RemoteAssistantConnection, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    const list = body === undefined;
    const bytes = list ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    if (bytes && bytes.length > MAX_REQUEST_BYTES) return fail("invalid-request");
    signal.throwIfAborted();
    const responseBytes = list ? MAX_CATALOG_BYTES : MAX_REPLY_BYTES;
    const reply = await awaitAbort(this.transport({ url: new URL(connection.endpoint + path), method: list ? "GET" : "POST", headers: credentials(connection), body: bytes, responseBytes }, signal), signal);
    signal.throwIfAborted();
    if (!reply.ok) return statusError(reply.status, list);
    const encoding = reply.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") return fail("invalid-response");
    let payload: unknown;
    try {
      const data = await awaitAbort(reply.arrayBuffer(), signal);
      if (data.byteLength > responseBytes) return fail("invalid-response");
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch { return fail("invalid-response"); }
    if (!record(payload) || Object.hasOwn(payload, "error")) return fail("invalid-response");
    return payload;
  }

  private async run<T>(timeoutMs: number, parent: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (parent?.aborted) return fail("cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    parent?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await task(controller.signal);
    } catch (error) {
      if (parent?.aborted) return fail("cancelled");
      if (timedOut) return fail("timeout");
      if (error instanceof RemoteAssistantError) throw error;
      return fail(error instanceof EgressResponseError ? "invalid-response" : "unavailable");
    } finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }

  async listModels(input: RemoteAssistantConnection, signal?: AbortSignal): Promise<string[]> {
    const connection = validatedConnection(input, this.allowedLoopbackPorts);
    return this.run(this.modelsTimeoutMs, signal, async active => {
      const found = new Set<string>(), cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_CATALOG_PAGES && found.size < MAX_MODELS; page++) {
        const { provider } = connection;
        const query = new URLSearchParams();
        if (provider === "anthropic") query.set("limit", "100");
        if (provider === "gemini") query.set("pageSize", "100");
        if (cursor) query.set(provider === "anthropic" ? "after_id" : "pageToken", cursor);
        const response = await this.call(connection, `/models${query.size ? `?${query}` : ""}`, active);
        const models = provider === "gemini" ? response.models : response.data;
        if (!Array.isArray(models)) return fail("invalid-response");
        for (const model of models) {
          if (found.size >= MAX_MODELS) break;
          if (!record(model)) continue;
          if (provider === "gemini" && (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent"))) continue;
          const id = provider === "gemini" ? model.name : model.id;
          if (isRemoteAssistantModelId(id, provider) && !(connection.apiKey && id.includes(connection.apiKey))) found.add(provider === "gemini" ? id.replace(/^models\//, "") : id);
        }
        const next: unknown = provider === "gemini" ? response.nextPageToken : provider === "anthropic" && response.has_more === true ? response.last_id : null;
        if (typeof next !== "string" || !/^[\x21-\x7e]{1,512}$/.test(next) || cursors.has(next)
          || (connection.apiKey && next.includes(connection.apiKey))) break;
        cursors.add(next); cursor = next;
      }
      return [...found].sort((left, right) => left.localeCompare(right));
    });
  }

  async chat(connectionInput: RemoteAssistantConnection, input: RemoteChatInput): Promise<RemoteChatResult> {
    const connection = validatedConnection(connectionInput, this.allowedLoopbackPorts);
    const messages = validatedMessages(input, connection.provider);
    const { model, system } = input;
    let path: string, body: unknown;
    if (connection.provider === "anthropic") {
      path = "/messages";
      body = { model, messages, system, max_tokens: MAX_OUTPUT_TOKENS, stream: false };
    } else if (connection.provider === "gemini") {
      if (model.includes(connection.apiKey)) return fail("invalid-request");
      path = `/models/${model.replace(/^models\//, "")}:generateContent`;
      body = { systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, candidateCount: 1 },
        contents: messages.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })) };
    } else {
      path = "/chat/completions";
      const officialOpenAI = new URL(connection.endpoint).hostname === "api.openai.com";
      body = { model, messages: [{ role: "system", content: system }, ...messages], stream: false,
        ...(officialOpenAI ? { max_completion_tokens: MAX_OUTPUT_TOKENS, store: false } : { max_tokens: MAX_OUTPUT_TOKENS }) };
    }
    return this.run(this.chatTimeoutMs, input.signal, async signal => answer(await this.call(connection, path, signal, body), connection));
  }
}
