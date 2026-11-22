/**
 * Dashboard API routes for the independent Proxy Vault (`/ui/api/proxy-vault*`).
 *
 * Security invariants:
 * - Every mutating route passes `rejectUntrustedJsonMutation(req)`.
 * - Every response (JSON, errors, rejections, NDJSON streams) sets `Cache-Control: no-store`.
 * - List/import/bind views are strictly redacted (never emit plaintext credentials,
 *   refresh URLs, or `endpoint_hash`).
 * - Single-item edit plaintext is served only on `GET /ui/api/proxy-vault/:id/edit`.
 */

import type { ProfileStore } from "../../store.ts";
import type { ProxyType } from "../../types.ts";
import { normalizeProxyType } from "../../proxy.ts";
import { WorkspaceBusyError } from "../../workspace-maintenance.ts";
import {
  ProxyRefreshCooldown,
  ProxyRefreshError,
  triggerProxyRefreshUrl,
  type ProxyRefreshOptions,
  type ProxyRefreshResult,
} from "../proxy-vault/proxy-refresh-url.ts";
import {
  checkVaultProxiesBatch,
  checkVaultProxy,
  clampVaultCheckConcurrency,
  type VaultBatchCheckOptions,
  type VaultCheckStreamEvent,
  type VaultProxyCheckOptions,
  type VaultProxyCheckResult,
} from "../proxy-vault/proxy-vault-check.ts";
import {
  isValidProxyVaultId,
  ProxyVaultError,
  ProxyVaultStore,
  type BindMode,
  type ImportDuplicateStrategy,
} from "../proxy-vault/proxy-vault-store.ts";
import { noStoreJson, rejectUntrustedJsonMutation, type UiRuntimeOptions } from "./shared.ts";

export interface ProxyVaultRouteOptions extends UiRuntimeOptions {
  /** Optional overrides for deterministic unit/integration testing. */
  proxyVaultCheckOptions?: Omit<VaultBatchCheckOptions, "vaultStore" | "signal" | "concurrency">;
  proxyVaultRefreshOptions?: Omit<ProxyRefreshOptions, "signal">;
  proxyVaultRefreshCooldown?: ProxyRefreshCooldown;
  proxyVaultRefreshTrigger?: (rawUrl: string, options: ProxyRefreshOptions) => Promise<ProxyRefreshResult>;
}

const storeCooldowns = new WeakMap<ProfileStore, ProxyRefreshCooldown>();

function getCooldown(store: ProfileStore, options: ProxyVaultRouteOptions): ProxyRefreshCooldown {
  if (options.proxyVaultRefreshCooldown) return options.proxyVaultRefreshCooldown;
  let cooldown = storeCooldowns.get(store);
  if (!cooldown) {
    cooldown = new ProxyRefreshCooldown();
    storeCooldowns.set(store, cooldown);
  }
  return cooldown;
}

function rejectMutationNoStore(req: Request): Response | null {
  const rejected = rejectUntrustedJsonMutation(req);
  if (!rejected) return null;
  rejected.headers.set("Cache-Control", "no-store");
  return rejected;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { ok: false, code: "method_not_allowed", error: `Method not allowed. Use ${allow}.` },
    { status: 405, headers: { "Cache-Control": "no-store", Allow: allow } },
  );
}

function decodeVaultId(raw: string): { ok: true; id: string } | { ok: false; response: Response } {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return {
      ok: false,
      response: noStoreJson({ ok: false, code: "invalid_id", error: "Invalid proxy vault ID." }, 400),
    };
  }
  if (!isValidProxyVaultId(id)) {
    return {
      ok: false,
      response: noStoreJson({ ok: false, code: "invalid_id", error: "Invalid proxy vault ID." }, 400),
    };
  }
  return { ok: true, id };
}

async function readJsonObject(req: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw.trim()) {
    if (allowEmpty) return {};
    throw new ProxyVaultError("JSON request body is required.", 400, "invalid_json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProxyVaultError("Invalid JSON request body.", 400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProxyVaultError("JSON request body must be an object.", 400, "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

function parseImportPayload(body: Record<string, unknown>): {
  input: string;
  format?: "auto" | "text" | "csv";
  defaultType?: ProxyType;
  defaultGroup?: string;
  duplicateStrategy?: ImportDuplicateStrategy;
} {
  const rawInput = body.input !== undefined ? body.input : body.text;
  if (typeof rawInput !== "string") {
    throw new ProxyVaultError("Import input must be a string.");
  }
  let format: "auto" | "text" | "csv" | undefined;
  if (body.format !== undefined) {
    if (body.format !== "auto" && body.format !== "text" && body.format !== "csv") {
      throw new ProxyVaultError("format must be auto, text, or csv.");
    }
    format = body.format;
  }
  let defaultType: ProxyType | undefined;
  if (body.defaultType !== undefined && String(body.defaultType).trim() !== "") {
    try {
      defaultType = normalizeProxyType(body.defaultType);
    } catch (error) {
      throw new ProxyVaultError(error instanceof Error ? error.message : "Invalid default proxy type.");
    }
  }
  let defaultGroup: string | undefined;
  if (body.defaultGroup !== undefined) {
    if (typeof body.defaultGroup !== "string") {
      throw new ProxyVaultError("defaultGroup must be a string.");
    }
    defaultGroup = body.defaultGroup;
  }
  const rawStrategy = body.duplicateStrategy !== undefined ? body.duplicateStrategy : body.strategy;
  let duplicateStrategy: ImportDuplicateStrategy | undefined;
  if (rawStrategy !== undefined) {
    if (rawStrategy !== "skip_duplicates" && rawStrategy !== "update_existing") {
      throw new ProxyVaultError("duplicateStrategy must be skip_duplicates or update_existing.");
    }
    duplicateStrategy = rawStrategy;
  }
  return { input: rawInput, format, defaultType, defaultGroup, duplicateStrategy };
}

function errorResponse(error: unknown): Response {
  if (error instanceof WorkspaceBusyError) {
    return noStoreJson({ ok: false, code: "workspace_busy", error: error.message }, 423);
  }
  if (error instanceof ProxyVaultError) {
    return noStoreJson({ ok: false, code: error.code, error: error.message }, error.status);
  }
  if (error instanceof ProxyRefreshError) {
    return noStoreJson(
      {
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.details.retryAfterMs !== undefined ? { retryAfterMs: error.details.retryAfterMs } : {}),
        ...(error.details.httpStatus !== undefined ? { httpStatus: error.details.httpStatus } : {}),
      },
      error.status,
    );
  }
  if (error instanceof SyntaxError) {
    return noStoreJson({ ok: false, code: "invalid_json", error: "Invalid JSON request body." }, 400);
  }
  return noStoreJson({ ok: false, code: "internal_error", error: "Proxy vault operation failed." }, 500);
}

/**
 * Handle all `/ui/api/proxy-vault*` routes. Returns null for unrelated paths
 * so `ui.ts` can mount this handler in one line.
 */
export async function handleProxyVaultRoutes(
  req: Request,
  pathname: string,
  store: ProfileStore,
  options: ProxyVaultRouteOptions = {},
): Promise<Response | null> {
  if (pathname !== "/ui/api/proxy-vault" && !pathname.startsWith("/ui/api/proxy-vault/")) {
    return null;
  }

  if (req.method !== "GET") {
    const rejected = rejectMutationNoStore(req);
    if (rejected) return rejected;
  }

  const vault = new ProxyVaultStore(store);

  try {
    // 1. GET / POST /ui/api/proxy-vault
    if (pathname === "/ui/api/proxy-vault") {
      if (req.method === "GET") {
        const params = new URL(req.url).searchParams;
        const result = vault.list({
          group: params.get("group") ?? undefined,
          q: params.get("q") ?? undefined,
          risk: params.get("risk") ?? undefined,
        });
        return noStoreJson({ ok: true, ...result });
      }
      if (req.method === "POST") {
        const body = await readJsonObject(req);
        const item = vault.create(body);
        return noStoreJson({ ok: true, id: item.id, item });
      }
      return methodNotAllowed("GET, POST");
    }

    // 2. POST /ui/api/proxy-vault/delete (batch delete)
    if (pathname === "/ui/api/proxy-vault/delete") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req);
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
        throw new ProxyVaultError("ids must be an array of proxy vault IDs.");
      }
      const result = vault.deleteMany(body.ids);
      return noStoreJson({ ok: true, ...result });
    }

    // 3. POST /ui/api/proxy-vault/import/preview
    if (pathname === "/ui/api/proxy-vault/import/preview") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req);
      const preview = vault.previewImport(parseImportPayload(body));
      return noStoreJson({ ok: true, ...preview });
    }

    // 4. POST /ui/api/proxy-vault/import/apply
    if (pathname === "/ui/api/proxy-vault/import/apply") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req);
      const applied = vault.applyImport(parseImportPayload(body));
      return noStoreJson({ ok: true, ...applied });
    }

    // 5. POST /ui/api/proxy-vault/check (NDJSON concurrent speed/egress check)
    if (pathname === "/ui/api/proxy-vault/check") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req);
      let ids: string[] | undefined;
      if (body.ids !== undefined) {
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string" || !isValidProxyVaultId(id))) {
          throw new ProxyVaultError("ids must be an array of valid proxy vault IDs.", 400, "invalid_id");
        }
        ids = [...new Set(body.ids)];
      }
      let group: string | undefined;
      if (body.group !== undefined) {
        if (typeof body.group !== "string") throw new ProxyVaultError("group must be a string.");
        group = body.group;
      }
      if (body.all !== undefined && typeof body.all !== "boolean") {
        throw new ProxyVaultError("all must be a boolean.");
      }
      const all = body.all === true;
      let concurrency: number | undefined;
      if (body.concurrency !== undefined) {
        if (typeof body.concurrency !== "number" || !Number.isFinite(body.concurrency) || body.concurrency < 1) {
          throw new ProxyVaultError("concurrency must be a positive number.");
        }
        concurrency = clampVaultCheckConcurrency(body.concurrency);
      }

      const records = vault.selectForCheck({ ids, group, all });
      const releaseMutation = options.workspaceManagement?.acquireMutationLease();
      const abortController = new AbortController();
      const onRequestAbort = () => abortController.abort(req.signal.reason);
      if (req.signal.aborted) abortController.abort(req.signal.reason);
      else req.signal.addEventListener("abort", onRequestAbort, { once: true });

      const encoder = new TextEncoder();
      let clientGone = false;

      let stream: ReadableStream<Uint8Array>;
      try {
        stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: VaultCheckStreamEvent) => {
              if (clientGone || abortController.signal.aborted) return;
              try {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              } catch {
                clientGone = true;
                abortController.abort();
              }
            };
            try {
              await checkVaultProxiesBatch(records, send, {
                ...options.proxyVaultCheckOptions,
                concurrency,
                vaultStore: vault,
                signal: abortController.signal,
              });
            } catch {
              send({ type: "error", error: "Proxy vault check failed." });
            } finally {
              req.signal.removeEventListener("abort", onRequestAbort);
              releaseMutation?.();
              try {
                controller.close();
              } catch {}
            }
          },
          cancel() {
            clientGone = true;
            abortController.abort();
            req.signal.removeEventListener("abort", onRequestAbort);
          },
        });
      } catch (streamError) {
        req.signal.removeEventListener("abort", onRequestAbort);
        releaseMutation?.();
        throw streamError;
      }

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // 6. POST /ui/api/proxy-vault/bind
    if (pathname === "/ui/api/proxy-vault/bind") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req);
      let proxyIds: string[];
      if (Array.isArray(body.proxyIds)) {
        if (body.proxyIds.some((id) => typeof id !== "string")) {
          throw new ProxyVaultError("proxyIds must be an array of strings.");
        }
        proxyIds = body.proxyIds;
      } else if (typeof body.proxyId === "string") {
        proxyIds = [body.proxyId];
      } else {
        throw new ProxyVaultError("proxyIds (or proxyId) is required.");
      }

      if (!Array.isArray(body.profileIds) || body.profileIds.some((id) => typeof id !== "string")) {
        throw new ProxyVaultError("profileIds must be an array of strings.");
      }

      let mode: BindMode | undefined;
      if (body.mode !== undefined) {
        if (body.mode !== "single" && body.mode !== "round_robin") {
          throw new ProxyVaultError("mode must be single or round_robin.");
        }
        mode = body.mode;
      }
      let profilesPerProxy: number | undefined;
      if (body.profilesPerProxy !== undefined) {
        if (typeof body.profilesPerProxy !== "number" || !Number.isInteger(body.profilesPerProxy)) {
          throw new ProxyVaultError("profilesPerProxy must be an integer.");
        }
        profilesPerProxy = body.profilesPerProxy;
      }
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
        throw new ProxyVaultError("dryRun must be a boolean.");
      }

      const result = vault.bindProfiles({
        proxyIds,
        profileIds: body.profileIds,
        mode,
        profilesPerProxy,
        dryRun: body.dryRun === true,
      });
      return noStoreJson({ ok: true, ...result });
    }

    // 7. POST /ui/api/proxy-vault/ingest-from-profiles
    if (pathname === "/ui/api/proxy-vault/ingest-from-profiles") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(req, true);
      let profileIds: string[] | undefined;
      if (body.profileIds !== undefined) {
        if (!Array.isArray(body.profileIds) || body.profileIds.some((id) => typeof id !== "string")) {
          throw new ProxyVaultError("profileIds must be an array of strings.");
        }
        profileIds = body.profileIds;
      }
      if (body.bind !== undefined && typeof body.bind !== "boolean") {
        throw new ProxyVaultError("bind must be a boolean.");
      }
      if (body.defaultGroup !== undefined && typeof body.defaultGroup !== "string") {
        throw new ProxyVaultError("defaultGroup must be a string.");
      }
      const result = vault.ingestFromProfiles({
        profileIds,
        bind: body.bind,
        defaultGroup: body.defaultGroup,
      });
      return noStoreJson({ ok: true, ...result });
    }

    // 8. POST /ui/api/proxy-vault/sync-bound/:id
    const syncMatch = pathname.match(/^\/ui\/api\/proxy-vault\/sync-bound\/([^/]+)$/);
    if (syncMatch) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const decoded = decodeVaultId(syncMatch[1]!);
      if (!decoded.ok) return decoded.response;
      const body = await readJsonObject(req, true);
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
        throw new ProxyVaultError("dryRun must be a boolean.");
      }
      const result = vault.syncBoundProfiles(decoded.id, { dryRun: body.dryRun === true });
      return noStoreJson({ ok: true, ...result });
    }

    // 9. GET /ui/api/proxy-vault/:id/edit
    const editMatch = pathname.match(/^\/ui\/api\/proxy-vault\/([^/]+)\/edit$/);
    if (editMatch) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      const decoded = decodeVaultId(editMatch[1]!);
      if (!decoded.ok) return decoded.response;
      const item = vault.getEditView(decoded.id);
      if (!item) {
        return noStoreJson({ ok: false, code: "not_found", error: "Proxy vault entry not found." }, 404);
      }
      return noStoreJson({ ok: true, item });
    }

    // 10. POST /ui/api/proxy-vault/:id/refresh-ip
    const refreshMatch = pathname.match(/^\/ui\/api\/proxy-vault\/([^/]+)\/refresh-ip$/);
    if (refreshMatch) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      const decoded = decodeVaultId(refreshMatch[1]!);
      if (!decoded.ok) return decoded.response;
      const body = await readJsonObject(req, true);
      if (body.recheck !== undefined && typeof body.recheck !== "boolean") {
        throw new ProxyVaultError("recheck must be a boolean.");
      }
      const recheck = body.recheck === true;

      const record = vault.getInternalRecord(decoded.id);
      if (!record) {
        return noStoreJson({ ok: false, code: "not_found", error: "Proxy vault entry not found." }, 404);
      }
      if (!record.hasRefreshUrl || !record.refreshUrl) {
        return noStoreJson(
          { ok: false, code: "no_refresh_url", error: "No refresh URL is configured for this proxy." },
          400,
        );
      }

      const cooldown = getCooldown(store, options);
      const lease = cooldown.tryAcquire(record.id, record.lastRefreshedAt);
      if (!lease.ok) {
        return Response.json(
          {
            ok: false,
            code: "cooldown_active",
            retryAfterMs: lease.retryAfterMs,
            error: "Please wait before refreshing this proxy IP again.",
          },
          {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": String(Math.ceil(lease.retryAfterMs / 1000)),
            },
          },
        );
      }

      let completedAt: number | undefined;
      try {
        const trigger = options.proxyVaultRefreshTrigger ?? triggerProxyRefreshUrl;
        const refreshResult = await trigger(record.refreshUrl, {
          ...options.proxyVaultRefreshOptions,
          signal: req.signal,
        });
        completedAt = refreshResult.refreshedAt;
        vault.recordRefreshTimestamp(record.id, refreshResult.refreshedAt);

        let checkResult: VaultProxyCheckResult | null = null;
        if (recheck && !req.signal.aborted) {
          const checkOpts: VaultProxyCheckOptions = {
            ...options.proxyVaultCheckOptions,
            signal: req.signal,
          };
          checkResult = await checkVaultProxy(record.proxy, checkOpts);
          vault.recordCheckResult(record.id, {
            status: checkResult.status,
            reason: checkResult.reason,
            latencyMs: checkResult.latencyMs,
            ip: checkResult.ip,
            country: checkResult.country,
            region: checkResult.region,
            city: checkResult.city,
            rotating: checkResult.rotating,
            exitComparison: checkResult.exitComparison,
            checkedAt: checkResult.checkedAt,
          });
        }

        return noStoreJson({
          ok: true,
          proxyId: record.id,
          httpStatus: refreshResult.httpStatus,
          redirects: refreshResult.redirects,
          refreshedAt: refreshResult.refreshedAt,
          rechecked: recheck && checkResult !== null,
          ...(checkResult ? { checkResult } : {}),
          item: vault.getView(record.id),
        });
      } finally {
        lease.release(completedAt ?? Date.now());
      }
    }

    // 11. PATCH / DELETE /ui/api/proxy-vault/:id
    const singleMatch = pathname.match(/^\/ui\/api\/proxy-vault\/([^/]+)$/);
    if (singleMatch) {
      const decoded = decodeVaultId(singleMatch[1]!);
      if (!decoded.ok) return decoded.response;
      if (req.method === "PATCH") {
        const body = await readJsonObject(req);
        const updated = vault.update(decoded.id, body);
        return noStoreJson({ ok: true, ...updated });
      }
      if (req.method === "DELETE") {
        const deleted = vault.delete(decoded.id);
        if (!deleted) {
          return noStoreJson({ ok: false, code: "not_found", error: "Proxy vault entry not found." }, 404);
        }
        return noStoreJson({ ok: true, deleted: true, id: decoded.id });
      }
      return methodNotAllowed("PATCH, DELETE");
    }

    return noStoreJson({ ok: false, code: "not_found", error: "Unknown proxy vault route." }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
