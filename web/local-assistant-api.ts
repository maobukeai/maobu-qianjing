import type { LocalAssistantChatInput, LocalAssistantChatResult, LocalModelCatalog } from "../local-assistant.ts";
export type { LocalAssistantChatInput, LocalAssistantChatResult, LocalModelCatalog };
export type SavedAssistantChatInput = Omit<LocalAssistantChatInput, "endpoint"> & {
  serviceId: string; serviceProvider: LocalAssistantChatResult["provider"]; serviceEndpoint: string;
};

export class AssistantRequestError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) { super(message); }
}
async function request<T>(path: string, value: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/ui/api/settings/assistant/${path}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-Maobu-Settings": "1", Accept: "application/json" }, body: JSON.stringify(value),
  });
  const result = await response.json().catch(() => { throw new Error("The local assistant returned an invalid response."); });
  if (!response.ok || result?.ok !== true) throw new AssistantRequestError(typeof result?.error === "string" ? result.error : "The local assistant request failed.", typeof result?.code === "string" ? result.code : "request_failed", result?.retryable === true);
  return result as T;
}
export async function fetchLocalModels(endpoint: string, signal?: AbortSignal): Promise<LocalModelCatalog> {
  const result = await request<{ catalog: LocalModelCatalog }>("models", { endpoint }, signal);
  if (!result.catalog || result.catalog.provider !== "ollama" || !Array.isArray(result.catalog.models)
      || result.catalog.models.some(model => !model || typeof model.name !== "string" || !model.name.trim() || model.sizeBytes !== null && (typeof model.sizeBytes !== "number" || !Number.isFinite(model.sizeBytes) || model.sizeBytes < 0)
        || model.parameterSize !== null && typeof model.parameterSize !== "string" || model.quantization !== null && typeof model.quantization !== "string")
      || typeof result.catalog.endpoint !== "string" || !Number.isInteger(result.catalog.excludedRemoteModels) || result.catalog.excludedRemoteModels < 0) throw new Error("The local assistant returned an invalid response.");
  return result.catalog;
}
export async function sendLocalAssistant(input: LocalAssistantChatInput | SavedAssistantChatInput, signal?: AbortSignal, requestId?: string): Promise<LocalAssistantChatResult> {
  const result = await request<{ reply: LocalAssistantChatResult }>("chat", { ...input, ...(requestId ? { requestId } : {}) }, signal);
  const provider = "serviceProvider" in input ? input.serviceProvider : "ollama";
  if (!result.reply || result.reply.provider !== provider || typeof result.reply.model !== "string" || !result.reply.model.trim()
      || result.reply.message?.role !== "assistant" || typeof result.reply.message.content !== "string" || !result.reply.message.content.trim() || typeof result.reply.durationMs !== "number" || !Number.isFinite(result.reply.durationMs) || result.reply.durationMs < 0
      || typeof result.reply.workspaceOverviewIncluded !== "boolean") throw new Error("The local assistant returned an invalid response.");
  return result.reply;
}
export async function cancelLocalAssistant(requestId: string): Promise<boolean> {
  const result = await request<{ cancelled: boolean }>("cancel", { requestId }, AbortSignal.timeout(5000));
  if (typeof result.cancelled !== "boolean") throw new Error("The local assistant returned an invalid response.");
  return result.cancelled;
}
