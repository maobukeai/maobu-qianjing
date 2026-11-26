import type { LocalAssistantChatInput, LocalAssistantChatResult, LocalModelCatalog } from "../local-assistant.ts";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
import type {
  AnomalyCriterion,
  CompiledProposalItemView,
  CompiledProposalView,
  ProposalExecutionItemReceipt,
  ProposalExecutionSnapshot,
  ProposalRiskLevel,
  ProposalStreamEvent,
} from "../assistant-proposals.ts";

export type {
  AnomalyCriterion,
  CompiledProposalItemView,
  CompiledProposalView,
  LocalAssistantChatInput,
  LocalAssistantChatResult,
  LocalModelCatalog,
  ProposalExecutionItemReceipt,
  ProposalExecutionSnapshot,
  ProposalRiskLevel,
  ProposalStreamEvent,
};

export type SavedAssistantChatInput = Omit<LocalAssistantChatInput, "endpoint"> & {
  serviceId: string;
  serviceProvider: LocalAssistantChatResult["provider"];
  serviceEndpoint: string;
};

export type LocalAssistantChatReply = LocalAssistantChatResult & {
  proposal?: CompiledProposalView | null;
  proposalParseError?: string;
};

export class AssistantRequestError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message);
  }
}

const VALID_RISKS = new Set<string>(["read-only", "low", "medium", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidCompiledProposal(value: unknown): value is CompiledProposalView {
  if (!isRecord(value)) return false;
  return (
    typeof value.proposalId === "string" &&
    value.proposalId.length > 0 &&
    typeof value.planHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.planHash) &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.actionType === "string" &&
    typeof value.risk === "string" &&
    VALID_RISKS.has(value.risk) &&
    typeof value.requiresSecondaryConfirm === "boolean" &&
    typeof value.mutatesWorkspace === "boolean" &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.items) &&
    isRecord(value.counts)
  );
}

function isValidExecutionSnapshot(value: unknown): value is ProposalExecutionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.proposalId === "string" &&
    typeof value.planHash === "string" &&
    typeof value.status === "string" &&
    typeof value.total === "number" &&
    typeof value.completed === "number" &&
    Array.isArray(value.items)
  );
}

/** Browser-safe strip of a fenced `maobu-proposal` block from assistant prose. */
export function stripProposalFence(content: string): string {
  return content
    .replace(/(?:^|\r?\n)[ \t]*```[ \t]*maobu-proposal[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/g, "\n")
    .trim();
}

async function request<T>(path: string, value: unknown, signal?: AbortSignal): Promise<T> {
  const fullPath = `/ui/api/settings/assistant/${path}`;
  const response = await fetch(fullPath, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: withStandaloneAuthHeaders({ "Content-Type": "application/json", "X-Maobu-Settings": "1", Accept: "application/json" }),
    body: JSON.stringify(value),
  });
  const result = await response.json().catch(() => {
    notifyUnauthorizedResponse(response.status, fullPath);
    throw new Error("The local assistant returned an invalid response.");
  });
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, fullPath, typeof result?.error === "string" ? result.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, result);
  }
  if (!response.ok || result?.ok !== true) {
    throw new AssistantRequestError(
      typeof result?.error === "string" ? result.error : "The local assistant request failed.",
      typeof result?.code === "string" ? result.code : "request_failed",
      result?.retryable === true,
    );
  }
  return result as T;
}

export async function fetchLocalModels(endpoint: string, signal?: AbortSignal): Promise<LocalModelCatalog> {
  const result = await request<{ catalog: LocalModelCatalog }>("models", { endpoint }, signal);
  if (
    !result.catalog ||
    result.catalog.provider !== "ollama" ||
    !Array.isArray(result.catalog.models) ||
    result.catalog.models.some(
      (model) =>
        !model ||
        typeof model.name !== "string" ||
        !model.name.trim() ||
        (model.sizeBytes !== null && (typeof model.sizeBytes !== "number" || !Number.isFinite(model.sizeBytes) || model.sizeBytes < 0)) ||
        (model.parameterSize !== null && typeof model.parameterSize !== "string") ||
        (model.quantization !== null && typeof model.quantization !== "string"),
    ) ||
    typeof result.catalog.endpoint !== "string" ||
    !Number.isInteger(result.catalog.excludedRemoteModels) ||
    result.catalog.excludedRemoteModels < 0
  ) {
    throw new Error("The local assistant returned an invalid response.");
  }
  return result.catalog;
}

export async function sendLocalAssistant(
  input: LocalAssistantChatInput | SavedAssistantChatInput,
  signal?: AbortSignal,
  requestId?: string,
): Promise<LocalAssistantChatReply> {
  const result = await request<{
    reply: LocalAssistantChatResult;
    proposal?: CompiledProposalView | null;
    proposalParseError?: string;
  }>("chat", { ...input, ...(requestId ? { requestId } : {}) }, signal);
  const provider = "serviceProvider" in input ? input.serviceProvider : "ollama";
  if (
    !result.reply ||
    result.reply.provider !== provider ||
    typeof result.reply.model !== "string" ||
    !result.reply.model.trim() ||
    result.reply.message?.role !== "assistant" ||
    typeof result.reply.message.content !== "string" ||
    !result.reply.message.content.trim() ||
    typeof result.reply.durationMs !== "number" ||
    !Number.isFinite(result.reply.durationMs) ||
    result.reply.durationMs < 0 ||
    typeof result.reply.workspaceOverviewIncluded !== "boolean"
  ) {
    throw new Error("The local assistant returned an invalid response.");
  }

  let proposal: CompiledProposalView | null | undefined = undefined;
  if (result.proposal !== undefined) {
    if (result.proposal !== null && !isValidCompiledProposal(result.proposal)) {
      throw new Error("The local assistant returned an invalid response.");
    }
    proposal = result.proposal;
  }
  let proposalParseError: string | undefined = undefined;
  if (result.proposalParseError !== undefined) {
    if (typeof result.proposalParseError !== "string") {
      throw new Error("The local assistant returned an invalid response.");
    }
    proposalParseError = result.proposalParseError;
  }

  if (proposal === undefined && proposalParseError === undefined) {
    return result.reply;
  }
  return {
    ...result.reply,
    ...(proposal !== undefined ? { proposal } : {}),
    ...(proposalParseError !== undefined ? { proposalParseError } : {}),
  };
}

export async function cancelLocalAssistant(requestId: string): Promise<boolean> {
  const result = await request<{ cancelled: boolean }>("cancel", { requestId }, AbortSignal.timeout(5000));
  if (typeof result.cancelled !== "boolean") throw new Error("The local assistant returned an invalid response.");
  return result.cancelled;
}

export async function executeAssistantProposal(
  proposalId: string,
  input: { planHash: string; selectedProfileIds?: string[]; confirmHighRisk?: boolean },
  onEvent: (event: ProposalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ProposalExecutionSnapshot | null> {
  const execPath = `/ui/api/assistant/proposals/${encodeURIComponent(proposalId)}/execute`;
  const response = await fetch(execPath, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: withStandaloneAuthHeaders({
      "Content-Type": "application/json",
      "X-Maobu-Settings": "1",
      Accept: "application/x-ndjson, application/json",
    }),
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const failed = await response.json().catch(() => null);
    if (response.status === 401) {
      notifyUnauthorizedResponse(401, execPath, typeof failed?.error === "string" ? failed.error : "");
    } else if (response.status === 423) {
      notifyAppLockedFromResponse(423, failed);
    }
    throw new AssistantRequestError(
      typeof failed?.error === "string" ? failed.error : "Proposal execution failed.",
      typeof failed?.code === "string" ? failed.code : "proposal_execute_failed",
      response.status === 409 || response.status === 423 || response.status >= 500,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Proposal execution stream is unavailable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let terminalSnapshot: ProposalExecutionSnapshot | null = null;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Proposal execution stream returned invalid JSON.");
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      throw new Error("Proposal execution stream returned an invalid event.");
    }
    const event = parsed as unknown as ProposalStreamEvent;
    onEvent(event);
    if ((event.type === "summary" || event.type === "aborted") && isValidExecutionSnapshot(event.snapshot)) {
      terminalSnapshot = event.snapshot;
    }
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return terminalSnapshot;
}

export async function abortAssistantProposal(
  proposalId: string,
): Promise<{ aborted: boolean; status: string; snapshot: ProposalExecutionSnapshot }> {
  const abortPath = `/ui/api/assistant/proposals/${encodeURIComponent(proposalId)}/abort`;
  const response = await fetch(abortPath, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: withStandaloneAuthHeaders({
      "Content-Type": "application/json",
      "X-Maobu-Settings": "1",
      Accept: "application/json",
    }),
    body: "{}",
  });
  const result = await response.json().catch(() => {
    notifyUnauthorizedResponse(response.status, abortPath);
    throw new Error("Proposal abort returned an invalid response.");
  });
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, abortPath, typeof result?.error === "string" ? result.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, result);
  }
  if (!response.ok || result?.ok !== true || typeof result.aborted !== "boolean" || !isValidExecutionSnapshot(result.snapshot)) {
    throw new AssistantRequestError(
      typeof result?.error === "string" ? result.error : "Could not stop proposal execution.",
      typeof result?.code === "string" ? result.code : "proposal_abort_failed",
      response.status >= 500,
    );
  }
  return {
    aborted: result.aborted,
    status: typeof result.status === "string" ? result.status : result.snapshot.status,
    snapshot: result.snapshot,
  };
}

export async function fetchAssistantProposalSnapshot(
  proposalId: string,
  signal?: AbortSignal,
): Promise<{ proposal: CompiledProposalView; execution: ProposalExecutionSnapshot; expired: boolean }> {
  const snapPath = `/ui/api/assistant/proposals/${encodeURIComponent(proposalId)}`;
  const response = await fetch(snapPath, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: withStandaloneAuthHeaders({
      "X-Maobu-Settings": "1",
      Accept: "application/json",
    }),
  });
  const result = await response.json().catch(() => {
    notifyUnauthorizedResponse(response.status, snapPath);
    throw new Error("Proposal status returned an invalid response.");
  });
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, snapPath, typeof result?.error === "string" ? result.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, result);
  }
  if (
    !response.ok ||
    result?.ok !== true ||
    !isValidCompiledProposal(result.proposal) ||
    !isValidExecutionSnapshot(result.execution) ||
    typeof result.expired !== "boolean"
  ) {
    throw new AssistantRequestError(
      typeof result?.error === "string" ? result.error : "Could not load proposal status.",
      typeof result?.code === "string" ? result.code : "proposal_status_failed",
      response.status >= 500,
    );
  }
  return {
    proposal: result.proposal,
    execution: result.execution,
    expired: result.expired,
  };
}
