import type { AssistantModel } from "../local-assistant.ts";
import type { AssistantServiceProvider, AssistantServiceView, AssistantServicesCatalog } from "../assistant-model-services.ts";
import { AssistantRequestError } from "./local-assistant-api.ts";

export type { AssistantServiceProvider, AssistantServiceView, AssistantServicesCatalog };
export interface AssistantServiceDraft {
  id?: string;
  name: string;
  provider: AssistantServiceProvider;
  endpoint: string;
  model: string;
  apiKey?: string;
}

export const ASSISTANT_SERVICE_LABELS: Record<AssistantServiceProvider, string> = {
  ollama: "Local Ollama", "openai-compatible": "OpenAI compatible", anthropic: "Anthropic API", gemini: "Gemini API",
};

export function requiresAssistantServiceKey(provider: AssistantServiceProvider): boolean {
  return provider === "anthropic" || provider === "gemini";
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new Error("The model service returned an invalid response."); }
function serviceId(value: unknown): value is string {
  return typeof value === "string" && /^model_[a-f0-9]{32}$/.test(value);
}

async function request(path: string, data?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`/ui/api/settings/assistant/services${path}`, {
    method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { "Content-Type": "application/json", "X-Maobu-Settings": "1", Accept: "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result: unknown = await response.json().catch(() => invalid());
  if (!record(result)) return invalid();
  if (!response.ok || result.ok !== true) throw new AssistantRequestError(
    typeof result.error === "string" ? result.error : "The model service request failed.",
    typeof result.code === "string" ? result.code : "request_failed", result.retryable === true,
  );
  return result;
}

function readCatalog(result: Record<string, unknown>): AssistantServicesCatalog {
  const value = result.catalog;
  if (!record(value) || !Array.isArray(value.services) || value.services.length > 100) return invalid();
  const services = value.services.map((item): AssistantServiceView => {
    if (!record(item) || !serviceId(item.id) || typeof item.name !== "string" || !item.name.trim()
      || typeof item.provider !== "string" || !Object.hasOwn(ASSISTANT_SERVICE_LABELS, item.provider)
      || typeof item.endpoint !== "string" || !item.endpoint.trim() || typeof item.model !== "string" || !item.model.trim()
      || typeof item.credentialConfigured !== "boolean") return invalid();
    return { id: item.id, name: item.name, provider: item.provider as AssistantServiceProvider, endpoint: item.endpoint, model: item.model, credentialConfigured: item.credentialConfigured };
  });
  if (new Set(services.map(item => item.id)).size !== services.length || value.defaultId !== null && !services.some(item => item.id === value.defaultId)) return invalid();
  return { services, defaultId: value.defaultId as string | null };
}

export async function readAssistantServices(signal?: AbortSignal) { return readCatalog(await request("", undefined, signal)); }
export async function saveAssistantService(input: AssistantServiceDraft, signal?: AbortSignal) { return readCatalog(await request("/save", input, signal)); }
export async function removeAssistantService(id: string, signal?: AbortSignal) { return readCatalog(await request("/remove", { id }, signal)); }
export async function setDefaultAssistantService(id: string | null, signal?: AbortSignal) { return readCatalog(await request("/default", { id }, signal)); }

export async function testAssistantService(input: AssistantServiceDraft, signal?: AbortSignal): Promise<{ models: AssistantModel[]; excludedRemoteModels: number }> {
  const { catalog } = await request("/test", input, signal);
  if (!record(catalog) || !Array.isArray(catalog.models) || catalog.models.length > 256
    || typeof catalog.excludedRemoteModels !== "number" || !Number.isInteger(catalog.excludedRemoteModels) || catalog.excludedRemoteModels < 0) return invalid();
  const models = catalog.models.map((item): AssistantModel => {
    if (!record(item) || typeof item.name !== "string" || !item.name.trim()
      || item.sizeBytes !== null && (typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0)
      || item.parameterSize !== null && typeof item.parameterSize !== "string" || item.quantization !== null && typeof item.quantization !== "string") return invalid();
    return { name: item.name, sizeBytes: item.sizeBytes, parameterSize: item.parameterSize, quantization: item.quantization };
  });
  return { models, excludedRemoteModels: catalog.excludedRemoteModels };
}
