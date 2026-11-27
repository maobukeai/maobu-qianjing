/** Explicit, bounded text-model requests. Conversations stay in the UI session. */
import { requestLoopbackJson } from "./local-json-transport.ts";
import { isRemoteAssistantModelId, RemoteAssistantError, RemoteAssistantService, type RemoteAssistantConnection, type RemoteModelProvider } from "./remote-assistant.ts";
import { buildProposalModeSystemPrompt, safeActionCatalog, type AssistantActionCatalog } from "./assistant-proposals.ts";
import type { Profile } from "./types.ts";

export const DEFAULT_ASSISTANT_ENDPOINT = "http://127.0.0.1:11434";
export const LOCAL_ASSISTANT_LIMITS = Object.freeze({ messages: 24, messageBytes: 8 * 1024, totalMessageBytes: 48 * 1024, answerBytes: 64 * 1024, models: 256, overviewGroups: 24, overviewProfiles: 100_000, modelsTimeoutMs: 5_000, chatTimeoutMs: 120_000 });
export type LocalAssistantErrorCode = "invalid-request" | "invalid-endpoint" | "unavailable" | "timeout" | "cancelled" | "model-not-found" | "model-not-local" | "provider-error" | "invalid-response" | "busy" | "context-unavailable";
const ERRORS: Record<LocalAssistantErrorCode, { message: string; httpStatus: number; retryable: boolean }> = {
  "invalid-request": { message: "The assistant request is invalid or exceeds the message limits.", httpStatus: 400, retryable: false },
  "invalid-endpoint": { message: "Use an HTTP or HTTPS root address on 127.0.0.1, localhost, or [::1] with a valid local port.", httpStatus: 400, retryable: false },
  unavailable: { message: "The local Ollama service is unavailable. Start Ollama and check its local address.", httpStatus: 503, retryable: true },
  timeout: { message: "The local model request timed out. Try a smaller model or a shorter conversation.", httpStatus: 504, retryable: true },
  cancelled: { message: "The local assistant request was cancelled.", httpStatus: 499, retryable: false },
  "model-not-found": { message: "The selected model is not installed in this local Ollama service. Refresh the model list.", httpStatus: 404, retryable: false },
  "model-not-local": { message: "This model uses a remote service. Select a downloaded local model instead.", httpStatus: 400, retryable: false },
  "provider-error": { message: "Ollama could not complete this request. Check the local model and try again.", httpStatus: 502, retryable: true },
  "invalid-response": { message: "The local model returned an invalid, incomplete, or oversized response.", httpStatus: 502, retryable: false },
  busy: { message: "Another local assistant response is in progress. Wait or cancel it before sending another message.", httpStatus: 409, retryable: true },
  "context-unavailable": { message: "A safe workspace overview is unavailable. Retry without including the workspace overview.", httpStatus: 400, retryable: false },
};
export class LocalAssistantError extends Error {
  readonly code: LocalAssistantErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(code: LocalAssistantErrorCode) {
    super(ERRORS[code].message); this.name = "LocalAssistantError"; this.code = code;
    this.httpStatus = ERRORS[code].httpStatus; this.retryable = ERRORS[code].retryable;
  }
}
export interface AssistantMessage { role: "user" | "assistant"; content: string }
export interface LocalAssistantChatInput { endpoint?: string; model: string; messages: AssistantMessage[]; includeWorkspaceOverview?: boolean; proposalMode?: boolean }
export interface AssistantModel { name: string; sizeBytes: number | null; parameterSize: string | null; quantization: string | null }
export interface AssistantModelList { provider: "ollama"; endpoint: string; checkedAt: string; models: AssistantModel[]; excludedRemoteModels: number }
export type LocalModelCatalog = AssistantModelList;
export interface WorkspaceOverview {
  profileCount: number; runningCount: number; groupCount: number; unassignedGroupCount: number;
  proxyConfiguredCount: number; engines: { chromium: number; firefox: number };
  groups: { label: string; profileCount: number }[]; otherGroupProfileCount: number;
}
export interface LocalAssistantChatResult {
  provider: "ollama" | RemoteModelProvider; model: string; message: { role: "assistant"; content: string }; createdAt: string | null;
  workspaceOverviewIncluded: boolean; usage: { promptTokens: number | null; completionTokens: number | null }; durationMs: number;
}
export type LocalAssistantTransport = typeof requestLoopbackJson;
export interface LocalAssistantServiceOptions { transport?: LocalAssistantTransport; remote?: Pick<RemoteAssistantService, "listModels" | "chat">; now?: () => number; chatTimeoutMs?: number; modelsTimeoutMs?: number }
interface Operation { signal: AbortSignal; finish(): void; error(): LocalAssistantError }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fail(code: LocalAssistantErrorCode): never { throw new LocalAssistantError(code); }

export function normalizeAssistantEndpoint(value: unknown = DEFAULT_ASSISTANT_ENDPOINT): string {
  if (typeof value !== "string" || value.length > 256) return fail("invalid-endpoint");
  const match = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?\/?$/i.exec(value.trim());
  if (!match) return fail("invalid-endpoint");
  const port = match[3] === undefined ? 11434 : Number(match[3]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return fail("invalid-endpoint");
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}:${port}`;
}
function modelName(value: unknown, code: LocalAssistantErrorCode = "invalid-request"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) || value.includes("//") || value.includes("..")) return fail(code);
  return value;
}
function cloudName(value: string): boolean { return /(?:^|[-:])cloud$/i.test(value); }
function remoteMetadata(value: Record<string, unknown>): boolean {
  for (const key of ["remote_host", "remote_model"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") return fail("invalid-response");
    if (typeof value[key] === "string" && value[key].trim()) return true;
  }
  return false;
}
function validateInput(value: unknown, provider?: RemoteModelProvider): Required<LocalAssistantChatInput> {
  if (!isRecord(value) || Object.keys(value).some(key => !["endpoint", "model", "messages", "includeWorkspaceOverview", "proposalMode"].includes(key))) return fail("invalid-request");
  if (provider && (value.endpoint !== undefined || !isRemoteAssistantModelId(value.model, provider))) return fail("invalid-request");
  const endpoint = normalizeAssistantEndpoint(value.endpoint), model = provider ? value.model as string : modelName(value.model);
  if (!provider && cloudName(model)) return fail("model-not-local");
  if (value.includeWorkspaceOverview !== undefined && typeof value.includeWorkspaceOverview !== "boolean") return fail("invalid-request");
  if (value.proposalMode !== undefined && typeof value.proposalMode !== "boolean") return fail("invalid-request");
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > LOCAL_ASSISTANT_LIMITS.messages) return fail("invalid-request");
  let bytes = 0;
  const messages: AssistantMessage[] = value.messages.map(message => {
    if (!isRecord(message) || Object.keys(message).some(key => !["role", "content"].includes(key)) || !["user", "assistant"].includes(message.role as string) || typeof message.content !== "string" || !message.content.trim()) return fail("invalid-request");
    const length = Buffer.byteLength(message.content, "utf8"); bytes += length;
    if (length > LOCAL_ASSISTANT_LIMITS.messageBytes || bytes > LOCAL_ASSISTANT_LIMITS.totalMessageBytes) return fail("invalid-request");
    return { role: message.role as AssistantMessage["role"], content: message.content };
  });
  if (messages[messages.length - 1]!.role !== "user") return fail("invalid-request");
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") > 96 * 1024) return fail("invalid-request");
  return { endpoint, model, messages, includeWorkspaceOverview: value.includeWorkspaceOverview === true, proposalMode: value.proposalMode === true };
}
function count(value: unknown, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
/** Only these fields are read; account/session/fingerprint/control records are never serialized. */
export function buildWorkspaceOverview(profiles: readonly Profile[], runningIds: Iterable<string> = []): WorkspaceOverview {
  if (!Array.isArray(profiles) || profiles.length > LOCAL_ASSISTANT_LIMITS.overviewProfiles) return fail("context-unavailable");
  const groups = new Map<string, number>(), ids = new Set<string>();
  let chromium = 0, firefox = 0, proxyConfiguredCount = 0, unassignedGroupCount = 0;
  for (const profile of profiles) {
    ids.add(profile.id);
    if (profile.engine === "firefox") firefox++; else chromium++;
    if (profile.proxy) proxyConfiguredCount++;
    if (typeof profile.group === "string" && profile.group.trim()) groups.set(profile.group, (groups.get(profile.group) ?? 0) + 1); else unassignedGroupCount++;
  }
  const running = new Set<string>(); let seen = 0;
  for (const id of runningIds) { if (++seen > LOCAL_ASSISTANT_LIMITS.overviewProfiles) return fail("context-unavailable"); if (ids.has(id)) running.add(id); }
  const ordered = Array.from(groups.values()).sort((a, b) => b - a);
  return {
    profileCount: profiles.length, runningCount: running.size, groupCount: groups.size, unassignedGroupCount, proxyConfiguredCount,
    engines: { chromium, firefox },
    groups: ordered.slice(0, LOCAL_ASSISTANT_LIMITS.overviewGroups).map((profileCount, index) => ({ label: `Group ${index + 1}`, profileCount })),
    otherGroupProfileCount: ordered.slice(LOCAL_ASSISTANT_LIMITS.overviewGroups).reduce((sum, size) => sum + size, 0),
  };
}
/** Reconstruct a numbers-only projection even if an integration passes extra private fields. */
function safeOverview(value: unknown): WorkspaceOverview {
  if (!isRecord(value) || !count(value.profileCount, LOCAL_ASSISTANT_LIMITS.overviewProfiles)) return fail("context-unavailable");
  const total = value.profileCount;
  if (![value.runningCount, value.unassignedGroupCount, value.proxyConfiguredCount, value.otherGroupProfileCount, value.groupCount].every(part => count(part, total)) || !isRecord(value.engines)
    || !count(value.engines.chromium, total) || !count(value.engines.firefox, total) || value.engines.chromium + value.engines.firefox !== total
    || !Array.isArray(value.groups) || value.groups.length > LOCAL_ASSISTANT_LIMITS.overviewGroups || value.groups.length > (value.groupCount as number)) return fail("context-unavailable");
  const groups = value.groups.map((group, index) => {
    if (!isRecord(group) || !count(group.profileCount, total) || group.profileCount === 0) return fail("context-unavailable");
    return { label: `Group ${index + 1}`, profileCount: group.profileCount };
  });
  if (groups.reduce((sum, group) => sum + group.profileCount, 0) + (value.otherGroupProfileCount as number) + (value.unassignedGroupCount as number) !== total) return fail("context-unavailable");
  const hiddenGroups = (value.groupCount as number) - groups.length;
  if (groups.length !== Math.min(value.groupCount as number, LOCAL_ASSISTANT_LIMITS.overviewGroups) || (value.groupCount as number) > total - (value.unassignedGroupCount as number)
    || (value.otherGroupProfileCount as number) < hiddenGroups || hiddenGroups === 0 && value.otherGroupProfileCount !== 0) return fail("context-unavailable");
  return { profileCount: total, runningCount: value.runningCount as number, groupCount: value.groupCount as number, unassignedGroupCount: value.unassignedGroupCount as number, proxyConfiguredCount: value.proxyConfiguredCount as number,
    engines: { chromium: value.engines.chromium, firefox: value.engines.firefox }, groups, otherGroupProfileCount: value.otherGroupProfileCount as number };
}

function operation(timeoutMs: number, parent?: AbortSignal): Operation {
  if (parent?.aborted) return fail("cancelled");
  const controller = new AbortController(); let timedOut = false;
  const cancel = () => controller.abort();
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, error: () => new LocalAssistantError(timedOut ? "timeout" : "cancelled"), finish() { clearTimeout(timer); parent?.removeEventListener("abort", cancel); } };
}
async function abortable<T>(promise: Promise<T>, active: Operation): Promise<T> {
  if (active.signal.aborted) { void promise.catch(() => {}); throw active.error(); }
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => { onAbort = () => reject(active.error()); active.signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([promise, cancellation]); }
  finally { if (onAbort) active.signal.removeEventListener("abort", onAbort); }
}
async function remoteReply<T>(call: () => Promise<T>, active: Operation): Promise<T> {
  try { return await abortable(call(), active); }
  catch (error) {
    if (error instanceof RemoteAssistantError || error instanceof LocalAssistantError) throw error;
    throw new RemoteAssistantError("unavailable");
  }
}
function mapTransportError(error: unknown, active: Operation, path: "/api/tags" | "/api/chat"): LocalAssistantError {
  if (active.signal.aborted) return active.error();
  if (error instanceof LocalAssistantError) return error;
  const code = isRecord(error) ? error.code : null;
  const status = isRecord(error) ? error.status : null;
  if (code === "timeout") return new LocalAssistantError("timeout");
  if (code === "cancelled") return new LocalAssistantError("cancelled");
  if (code === "invalid_endpoint") return new LocalAssistantError("invalid-endpoint");
  if (["invalid_json", "response_too_large"].includes(code as string)) return new LocalAssistantError("invalid-response");
  if (["invalid_request", "request_too_large"].includes(code as string)) return new LocalAssistantError("invalid-request");
  if (code === "http_error") return new LocalAssistantError(status === 404 ? path === "/api/chat" ? "model-not-found" : "unavailable" : "provider-error");
  return new LocalAssistantError("unavailable");
}
function modelsFrom(payload: unknown): { models: AssistantModel[]; excludedRemoteModels: number; remoteNames: Set<string> } {
  if (!isRecord(payload) || !Array.isArray(payload.models) || payload.models.length > LOCAL_ASSISTANT_LIMITS.models || Object.hasOwn(payload, "error")) return fail("invalid-response");
  const found = new Map<string, AssistantModel>(), remoteNames = new Set<string>();
  for (const entry of payload.models) {
    if (!isRecord(entry)) return fail("invalid-response");
    const name = modelName(entry.name ?? entry.model, "invalid-response");
    if (remoteMetadata(entry) || cloudName(name) || typeof entry.model === "string" && cloudName(entry.model)) { remoteNames.add(name); continue; }
    const details = isRecord(entry.details) ? entry.details : {};
    found.set(name, { name, sizeBytes: count(entry.size, Number.MAX_SAFE_INTEGER) ? entry.size : null,
      parameterSize: typeof details.parameter_size === "string" && /^[\dA-Za-z .-]{1,32}$/.test(details.parameter_size) ? details.parameter_size : null,
      quantization: typeof details.quantization_level === "string" && /^[A-Za-z0-9_+.-]{1,40}$/.test(details.quantization_level) ? details.quantization_level : null });
  }
  for (const name of remoteNames) found.delete(name);
  return { models: Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name)), excludedRemoteModels: remoteNames.size, remoteNames };
}
const SYSTEM_MESSAGE = "You are the local assistant for Maobu Qianjing, a browser profile manager. Help with questions, plans, troubleshooting and draft scripts. You cannot open, modify, delete or run browser profiles, scripts or tools. Never claim an action was performed. Generated code is a draft for the operator to review. Do not ask for or invent account passwords, cookies, 2FA secrets, proxy credentials or private browser control addresses. Clearly separate suggestions from verified results.";

export class LocalAssistantService {
  private readonly transport: LocalAssistantTransport;
  private readonly remote: Pick<RemoteAssistantService, "listModels" | "chat">;
  private readonly now: () => number;
  private readonly modelsTimeoutMs: number;
  private readonly chatTimeoutMs: number;
  private chatBusy = false;
  constructor(options: LocalAssistantServiceOptions = {}) {
    this.transport = options.transport ?? requestLoopbackJson; this.now = options.now ?? Date.now;
    this.remote = options.remote ?? new RemoteAssistantService();
    this.modelsTimeoutMs = options.modelsTimeoutMs ?? LOCAL_ASSISTANT_LIMITS.modelsTimeoutMs;
    this.chatTimeoutMs = options.chatTimeoutMs ?? LOCAL_ASSISTANT_LIMITS.chatTimeoutMs;
    if (!Number.isInteger(this.modelsTimeoutMs) || this.modelsTimeoutMs < 1 || this.modelsTimeoutMs > LOCAL_ASSISTANT_LIMITS.modelsTimeoutMs || !Number.isInteger(this.chatTimeoutMs) || this.chatTimeoutMs < 1 || this.chatTimeoutMs > LOCAL_ASSISTANT_LIMITS.chatTimeoutMs) return fail("invalid-request");
  }
  private async request(endpoint: string, method: "GET" | "POST", path: "/api/tags" | "/api/chat", active: Operation, body?: unknown): Promise<unknown> {
    if (active.signal.aborted) throw active.error();
    try {
      const payload = await abortable(this.transport(endpoint, { method, path, body, signal: active.signal, timeoutMs: path === "/api/tags" ? this.modelsTimeoutMs : this.chatTimeoutMs }), active);
      if (active.signal.aborted) throw active.error();
      return payload;
    } catch (error) { throw mapTransportError(error, active, path); }
  }
  async listModels(input: { endpoint?: string; signal?: AbortSignal } = {}): Promise<AssistantModelList> {
    const endpoint = normalizeAssistantEndpoint(input.endpoint), active = operation(this.modelsTimeoutMs, input.signal);
    try {
      const { models, excludedRemoteModels } = modelsFrom(await this.request(endpoint, "GET", "/api/tags", active));
      return { provider: "ollama", endpoint, checkedAt: new Date(this.now()).toISOString(), models, excludedRemoteModels };
    } finally { active.finish(); }
  }
  async listRemoteModels(connection: RemoteAssistantConnection, signal?: AbortSignal): Promise<{ models: AssistantModel[]; excludedRemoteModels: number }> {
    const active = operation(this.modelsTimeoutMs, signal);
    try {
      const names = await remoteReply(() => this.remote.listModels(connection, active.signal), active);
      return { models: names.map(name => ({ name, sizeBytes: null, parameterSize: null, quantization: null })), excludedRemoteModels: 0 };
    } finally { active.finish(); }
  }
  async chat(input: LocalAssistantChatInput, options: { signal?: AbortSignal; workspaceOverview?: () => WorkspaceOverview; actionCatalog?: () => AssistantActionCatalog; connection?: RemoteAssistantConnection } = {}): Promise<LocalAssistantChatResult> {
    const connection = options.connection;
    const validated = validateInput(input, connection?.provider);
    if (this.chatBusy) return fail("busy");
    const active = operation(this.chatTimeoutMs, options.signal), started = this.now(); this.chatBusy = true;
    try {
      if (!connection) {
        const local = modelsFrom(await this.request(validated.endpoint, "GET", "/api/tags", active));
        if (local.remoteNames.has(validated.model)) return fail("model-not-local");
        if (!local.models.some(model => model.name === validated.model)) return fail("model-not-found");
      }
      let system = SYSTEM_MESSAGE;
      if (validated.includeWorkspaceOverview) {
        if (typeof options.workspaceOverview !== "function") return fail("context-unavailable");
        let overview: WorkspaceOverview;
        try { overview = safeOverview(options.workspaceOverview()); } catch { return fail("context-unavailable"); }
        system += `\nThe operator explicitly included this anonymous counts-only workspace summary. Group labels are anonymous, not real names. It does not describe page contents or account state:\n${JSON.stringify(overview)}`;
      }
      if (validated.proposalMode) {
        if (typeof options.actionCatalog !== "function") return fail("context-unavailable");
        let catalog: AssistantActionCatalog;
        try { catalog = safeActionCatalog(options.actionCatalog()); } catch { return fail("context-unavailable"); }
        // Keep the full system prompt strictly under RemoteAssistantService's 16 KiB cap.
        const remainingBytes = Math.max(1024, 15_800 - Buffer.byteLength(system, "utf8"));
        system += buildProposalModeSystemPrompt(catalog, remainingBytes);
      }
      if (connection) {
        const reply = await remoteReply(() => this.remote.chat(connection, { model: validated.model, messages: validated.messages, system, signal: active.signal }), active);
        if (typeof reply?.content !== "string" || !reply.content.trim() || Buffer.byteLength(reply.content) > LOCAL_ASSISTANT_LIMITS.answerBytes) return fail("invalid-response");
        return { provider: connection.provider, model: validated.model, message: { role: "assistant", content: reply.content }, createdAt: null,
          workspaceOverviewIncluded: validated.includeWorkspaceOverview, usage: { promptTokens: reply.promptTokens, completionTokens: reply.completionTokens }, durationMs: Math.max(0, this.now() - started) };
      }
      const payload = await this.request(validated.endpoint, "POST", "/api/chat", active, {
        model: validated.model, messages: [{ role: "system", content: system }, ...validated.messages], stream: false, think: false,
        keep_alive: "1m", options: { num_predict: 2048, num_ctx: 8192, temperature: 0.3 },
      });
      if (!isRecord(payload)) return fail("invalid-response");
      if (remoteMetadata(payload) || typeof payload.model === "string" && cloudName(payload.model)) return fail("model-not-local");
      if (Object.hasOwn(payload, "error")) return fail("provider-error");
      if (payload.done !== true || !isRecord(payload.message) || payload.message.role !== "assistant" || typeof payload.message.content !== "string" || !payload.message.content.trim() || Buffer.byteLength(payload.message.content) > LOCAL_ASSISTANT_LIMITS.answerBytes || Array.isArray(payload.message.tool_calls) && payload.message.tool_calls.length) return fail("invalid-response");
      const model = payload.model === undefined ? validated.model : modelName(payload.model, "invalid-response");
      return { provider: "ollama", model, message: { role: "assistant", content: payload.message.content }, createdAt: typeof payload.created_at === "string" && payload.created_at.length <= 64 && Number.isFinite(Date.parse(payload.created_at)) ? payload.created_at : null,
        workspaceOverviewIncluded: validated.includeWorkspaceOverview, usage: { promptTokens: count(payload.prompt_eval_count, 1_000_000_000) ? payload.prompt_eval_count : null, completionTokens: count(payload.eval_count, 1_000_000_000) ? payload.eval_count : null }, durationMs: Math.max(0, this.now() - started) };
    } finally { this.chatBusy = false; active.finish(); }
  }
}
