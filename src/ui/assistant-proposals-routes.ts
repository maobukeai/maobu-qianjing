/**
 * Dashboard API routes for controlled AI Copilot action proposals (`/ui/api/assistant/proposals/*`).
 *
 * Security invariants:
 * - Loopback hostname + same-origin + `X-Maobu-Settings: 1` required on all routes.
 * - Mutating POST routes enforce `rejectUntrustedJsonMutation(req)` and bounded JSON body parsing.
 * - Workspace-mutating executions hold `workspaceManagement.acquireMutationLease()` until settled.
 * - Every response (JSON, errors, rejections, NDJSON streams) sets `Cache-Control: no-store`
 *   and `X-Content-Type-Options: nosniff`.
 */

import {
  AssistantProposalError,
  getDefaultProposalRegistry,
  isValidProposalId,
  PLAN_HASH_PATTERN,
  resolveProposalWorkspaceId,
  type AssistantProposalRegistry,
  type AssistantProxyVaultLookup,
  type ProposalExecuteInput,
  type ProposalStreamEvent,
} from "../assistant-proposals.ts";
import type { Launcher } from "../launcher.ts";
import type { ProfileStore } from "../store.ts";
import { WorkspaceBusyError } from "../workspace-maintenance.ts";
import { rejectUntrustedJsonMutation, type UiRuntimeOptions } from "./shared.ts";

export interface AssistantProposalRouteOptions extends UiRuntimeOptions {
  launcher?: Pick<Launcher, "start" | "stop" | "captureLocalSession">;
  proxyVault?: AssistantProxyVaultLookup;
  proposalRegistry?: AssistantProposalRegistry;
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse(
    { ok: false, code: "method_not_allowed", error: `Method not allowed. Use ${allow}.` },
    405,
    { Allow: allow },
  );
}

function guardLocalOriginAndHeader(req: Request): Response | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return jsonResponse({ ok: false, code: "forbidden", error: "Only same-origin local requests are allowed." }, 403);
  }
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    (origin && origin !== url.origin) ||
    (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
  ) {
    return jsonResponse({ ok: false, code: "forbidden", error: "Only same-origin local requests are allowed." }, 403);
  }
  if (req.headers.get("X-Maobu-Settings") !== "1") {
    return jsonResponse({ ok: false, code: "forbidden", error: "Local settings request header is required." }, 403);
  }
  return null;
}

function guardJsonPost(req: Request): Response | null {
  const localRejected = guardLocalOriginAndHeader(req);
  if (localRejected) return localRejected;
  const mutationRejected = rejectUntrustedJsonMutation(req);
  if (mutationRejected) {
    mutationRejected.headers.set("Cache-Control", "no-store");
    mutationRejected.headers.set("X-Content-Type-Options", "nosniff");
    return mutationRejected;
  }
  return null;
}

async function readBoundedJsonObject(req: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AssistantProposalError("invalid_action_schema", "Proposal request body exceeds size limit.", 413);
  }
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new AssistantProposalError("invalid_action_schema", "Proposal request body exceeds size limit.", 413);
        }
        chunks.push(next.value);
      }
    }
  } finally {
    reader?.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    if (allowEmpty) return {};
    throw new AssistantProposalError("invalid_action_schema", "JSON request body is required.", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AssistantProposalError("invalid_action_schema", "Invalid JSON request body.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AssistantProposalError("invalid_action_schema", "JSON request body must be an object.", 400);
  }
  return parsed as Record<string, unknown>;
}

function decodeProposalId(raw: string): { ok: true; id: string } | { ok: false; response: Response } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return {
      ok: false,
      response: jsonResponse({ ok: false, code: "invalid_proposal_id", error: "Invalid proposal ID." }, 400),
    };
  }
  if (!isValidProposalId(decoded)) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, code: "invalid_proposal_id", error: "Invalid proposal ID." }, 400),
    };
  }
  return { ok: true, id: decoded };
}

function parseExecuteBody(body: Record<string, unknown>): ProposalExecuteInput {
  const allowed = new Set(["planHash", "selectedProfileIds", "confirmHighRisk"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new AssistantProposalError("invalid_action_schema", `Unexpected field "${key}" in execute request.`, 400);
    }
  }
  if (typeof body.planHash !== "string" || !PLAN_HASH_PATTERN.test(body.planHash)) {
    throw new AssistantProposalError("plan_hash_mismatch", "A valid 64-character planHash is required.", 400);
  }
  let selectedProfileIds: string[] | undefined;
  if (body.selectedProfileIds !== undefined) {
    if (!Array.isArray(body.selectedProfileIds) || body.selectedProfileIds.some((id) => typeof id !== "string")) {
      throw new AssistantProposalError("invalid_selection", "selectedProfileIds must be an array of strings.", 400);
    }
    selectedProfileIds = body.selectedProfileIds;
  }
  if (body.confirmHighRisk !== undefined && typeof body.confirmHighRisk !== "boolean") {
    throw new AssistantProposalError("invalid_action_schema", "confirmHighRisk must be a boolean.", 400);
  }
  return {
    planHash: body.planHash,
    ...(selectedProfileIds !== undefined ? { selectedProfileIds } : {}),
    ...(body.confirmHighRisk !== undefined ? { confirmHighRisk: body.confirmHighRisk } : {}),
  };
}

function mapErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceBusyError) {
    return jsonResponse({ ok: false, code: "workspace_busy", error: error.message }, 423);
  }
  if (error instanceof AssistantProposalError) {
    return jsonResponse({ ok: false, code: error.code, error: error.message }, error.httpStatus);
  }
  return jsonResponse({ ok: false, code: "internal_error", error: "Assistant proposal request failed." }, 500);
}

/**
 * Handle `/ui/api/assistant/proposals/*` routes.
 * Returns `null` for unrelated paths so `ui.ts` can mount this handler cleanly.
 */
export async function handleAssistantProposalRoutes(
  req: Request,
  pathname: string,
  store: ProfileStore,
  options: AssistantProposalRouteOptions = {},
): Promise<Response | null> {
  if (pathname !== "/ui/api/assistant/proposals" && !pathname.startsWith("/ui/api/assistant/proposals/")) {
    return null;
  }

  const registry: AssistantProposalRegistry = options.proposalRegistry ?? getDefaultProposalRegistry();
  const workspaceId = resolveProposalWorkspaceId(store, options);

  try {
    // 1. POST /ui/api/assistant/proposals/:proposalId/execute
    const executeMatch = pathname.match(/^\/ui\/api\/assistant\/proposals\/([^/]+)\/execute$/);
    if (executeMatch) {
      if (req.method !== "POST") {
        const localRejected = guardLocalOriginAndHeader(req);
        if (localRejected) return localRejected;
        return methodNotAllowed("POST");
      }
      const rejected = guardJsonPost(req);
      if (rejected) return rejected;

      const decoded = decodeProposalId(executeMatch[1]!);
      if (!decoded.ok) return decoded.response;

      const body = await readBoundedJsonObject(req);
      const executeInput = parseExecuteBody(body);

      const peek = registry.getSnapshot(decoded.id, workspaceId);
      let releaseMutation: (() => void) | undefined;
      if (peek && peek.proposal.mutatesWorkspace && !peek.expired && peek.execution.status !== "running") {
        releaseMutation = options.workspaceManagement?.acquireMutationLease();
      }

      let prepared: ReturnType<AssistantProposalRegistry["prepareExecution"]>;
      try {
        prepared = registry.prepareExecution(decoded.id, workspaceId, executeInput);
      } catch (error) {
        releaseMutation?.();
        throw error;
      }

      const emitEvent =
        options.emitEvent ??
        (options.events ? (_type: string, payload: Record<string, unknown>) => options.events!.emitTaskUpdated(payload) : undefined);

      const encoder = new TextEncoder();
      let clientGone = false;

      let stream: ReadableStream<Uint8Array>;
      try {
        stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: ProposalStreamEvent) => {
              if (clientGone) return;
              try {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              } catch {
                clientGone = true;
              }
            };

            // Keep execution running independently of stream disconnect so in-flight browser
            // teardown/session saves settle safely and GET /:proposalId can reconnect for receipts.
            void prepared
              .start(
                {
                  store,
                  launcher: options.launcher,
                  proxyVault: options.proxyVault,
                  emitEvent,
                },
                send,
              )
              .catch(() => {
                send({
                  type: "error",
                  proposalId: decoded.id,
                  code: "execution_error",
                  error: "Proposal execution failed.",
                });
              })
              .finally(() => {
                releaseMutation?.();
                if (!clientGone) {
                  try {
                    controller.close();
                  } catch {
                    // Stream already closed by client.
                  }
                }
              });
          },
          cancel() {
            clientGone = true;
          },
        });
      } catch (streamError) {
        releaseMutation?.();
        throw streamError;
      }

      return new Response(stream, {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // 2. POST /ui/api/assistant/proposals/:proposalId/abort
    const abortMatch = pathname.match(/^\/ui\/api\/assistant\/proposals\/([^/]+)\/abort$/);
    if (abortMatch) {
      if (req.method !== "POST") {
        const localRejected = guardLocalOriginAndHeader(req);
        if (localRejected) return localRejected;
        return methodNotAllowed("POST");
      }
      const rejected = guardJsonPost(req);
      if (rejected) return rejected;

      const decoded = decodeProposalId(abortMatch[1]!);
      if (!decoded.ok) return decoded.response;

      const body = await readBoundedJsonObject(req, true);
      if (Object.keys(body).length > 0) {
        throw new AssistantProposalError("invalid_action_schema", "Abort request does not accept extra fields.", 400);
      }

      const result = registry.abort(decoded.id, workspaceId);
      if (!result.found) {
        return jsonResponse({ ok: false, code: "proposal_not_found", error: "Action proposal not found." }, 404);
      }
      return jsonResponse({
        ok: true,
        proposalId: decoded.id,
        aborted: result.aborted,
        status: result.snapshot.status,
        snapshot: result.snapshot,
      });
    }

    // 3. GET /ui/api/assistant/proposals/:proposalId
    const statusMatch = pathname.match(/^\/ui\/api\/assistant\/proposals\/([^/]+)$/);
    if (statusMatch) {
      const localRejected = guardLocalOriginAndHeader(req);
      if (localRejected) return localRejected;
      if (req.method !== "GET") return methodNotAllowed("GET");

      const decoded = decodeProposalId(statusMatch[1]!);
      if (!decoded.ok) return decoded.response;

      const snapshot = registry.getSnapshot(decoded.id, workspaceId);
      if (!snapshot) {
        return jsonResponse({ ok: false, code: "proposal_not_found", error: "Action proposal not found." }, 404);
      }
      return jsonResponse({
        ok: true,
        proposal: snapshot.proposal,
        execution: snapshot.execution,
        expired: snapshot.expired,
      });
    }

    const localRejected = guardLocalOriginAndHeader(req);
    if (localRejected) return localRejected;
    return jsonResponse({ ok: false, code: "not_found", error: "Unknown assistant proposal route." }, 404);
  } catch (error) {
    return mapErrorResponse(error);
  }
}
