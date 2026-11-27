import { syncFirefoxTimezone } from "./firefox-config.ts";
import { attachTimezones } from "./geoip.ts";
import { buildProxyPreview, buildSingleProxyPreview, checkProfileProxies, replacementState, selectProxyProfiles, ProxyToolsError, type PlannedProxyReplacement, type ProxyInventoryProfile } from "./proxy-bulk.ts";
import { proxyHostPort, proxyIdentityKey } from "./proxy.ts";
import { SingleProxyPreviewInputError, validateSingleProxyPreviewInput } from "./proxy-single-preview.ts";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { UiRuntimeOptions } from "./ui.ts";
import type { ProxyPreview, ProxyTextPreviewInput, ProxyProgressEvent, ProxyScope } from "./proxy-tools-types.ts";
import { WorkspaceBusyError } from "./workspace-maintenance.ts";
import { ProxyOperationState, ProxyOperationStateError, PROXY_OPERATION_CODES, type ProxyOperationBinding, type ProxyOperationOwner, type ProxyOperationRow } from "./proxy-operation-state.ts";

type Preview = {
  id: string;
  scope: ProxyScope;
  /** Exact target reads for the typed local connection path. */
  singleTargetIds?: string[];
  rows: PlannedProxyReplacement[];
  unusedProxies: number;
  incarnations: ReadonlyMap<string, string | null>;
};
const states = new WeakMap<ProfileStore, { preview?: Preview; applying: boolean; operations: ProxyOperationState }>();

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function previewView(preview: Preview, operationScope: string): ProxyPreview {
  return { ok: true, previewId: preview.id, operationScope, rows: preview.rows.map((r) => r.view), unusedProxies: preview.unusedProxies };
}

/** A receipt deliberately excludes even redacted proxy addresses and display names. */
function operationRow(row: PlannedProxyReplacement["view"]): ProxyOperationRow {
  return { index: row.index, ...(row.profileId === undefined ? {} : { profileId: row.profileId }), status: row.status,
    ...(PROXY_OPERATION_CODES.includes(row.code as typeof PROXY_OPERATION_CODES[number]) ? { code: row.code as typeof PROXY_OPERATION_CODES[number] } : {}) };
}

function safeError(error: unknown): string {
  if (error instanceof ProxyToolsError) return error.message;
  return "Proxy operation failed. Refresh and try again.";
}

export async function handleProxyToolsRequest(
  req: Request, launcher: Launcher, store: ProfileStore, options: UiRuntimeOptions,
): Promise<Response> {
  const state = states.get(store) ?? { applying: false, operations: new ProxyOperationState() };
  states.set(store, state);
  const current = () => !req.signal.aborted;
  const assertCurrent = () => { if (!current()) throw new ProxyToolsError("Operation cancelled", 409); };
  let releaseMutation: (() => void) | undefined;
  let workerStarted = false;
  let ownsApplyState = false;
  let operationOwner: ProxyOperationOwner | undefined;
  try {
    assertCurrent();
    const url = new URL(req.url);
    const operationPath = /^\/ui\/api\/proxies\/operations\/([^/]+)(\/reconcile)?$/.exec(url.pathname);
    if (operationPath) {
      const reconcile = !!operationPath[2];
      if (req.method !== (reconcile ? "POST" : "GET")) return response({ ok: false, error: reconcile ? "POST is required" : "GET is required" }, 405);
      const body = reconcile ? await req.json() : null;
      if (reconcile && (!body || typeof body !== "object" || Array.isArray(body))) throw new ProxyOperationStateError("operation_invalid");
      const binding: ProxyOperationBinding = { attemptId: operationPath[1]!, operationScope: reconcile ? body.operationScope : url.searchParams.get("operationScope"), previewId: reconcile ? body.previewId : url.searchParams.get("previewId") };
      assertCurrent();
      if (!reconcile) {
        const operation = state.operations.get(binding);
        return operation ? response({ ok: true, operation }) : response({ ok: false, code: "operation_not_found" }, 404);
      }
      const result = state.operations.reconcile(binding);
      // No await between fencing the nonce and retiring its sensitive plan.
      if (result.invalidatedPreviewId === state.preview?.id) state.preview = undefined;
      return result.operation ? response({ ok: true, operation: result.operation }) : response({ ok: false, code: "operation_not_found" }, 404);
    }
    const action = url.pathname.split("/").pop();
    // The dispatch lease ends when this handler returns Response; a streamed
    // apply needs a separate owner until its actual worker has settled.
    if (action === "apply") releaseMutation = options.workspaceManagement?.acquireMutationLease();
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProxyToolsError("Invalid request");
    const inventory = async (incarnations?: Map<string, string | null>, targetIds?: readonly string[]): Promise<ProxyInventoryProfile[]> => {
      assertCurrent();
      const profiles = targetIds ? [] : store.listProfiles();
      if (targetIds) for (const id of targetIds) {
        const profile = store.getProfile(id);
        if (profile) profiles.push(profile);
      }
      // Bind identity to the same read as the values shown in the preview.
      // Cleanup may yield while an environment is removed and recreated.
      if (incarnations) for (const profile of profiles) incarnations.set(profile.id, store.getProfileIncarnation(profile.id));
      // A failed cleanup must not abandon another already-started cleanup while
      // the streamed worker gives up its writer lease.
      const cleanups = await Promise.allSettled(profiles.map(async (p) => launcher.cacheCleanupSettled(p.id)));
      const failed = cleanups.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      return profiles.map((p) => ({
        id: p.id, name: p.name, group: p.group, proxy: p.proxy, proxyError: p.proxyError,
        permission: "edit", running: launcher.profileDeletionBlocked(p.id),
      }));
    };
    const getPreview = (): Preview => {
      const preview = state.preview;
      if (!preview || preview.id !== body.previewId) throw new ProxyToolsError("Preview expired. Preview the replacements again.", 409);
      return preview;
    };
    // A repeated attempt is a receipt read, including while the original worker
    // is running or after its preview has been replaced. Never start another writer.
    const trackedApply = action === "apply" && (body.attemptId !== undefined || body.operationScope !== undefined);
    const binding: ProxyOperationBinding | undefined = trackedApply ? { operationScope: body.operationScope, attemptId: body.attemptId, previewId: body.previewId } : undefined;
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== "string"))) throw new ProxyToolsError("Invalid profile selection");
    if (binding) {
      const previous = state.operations.get(binding);
      if (previous) {
        const selectedIds = body.ids ? new Set<string>(body.ids) : null;
        const admission = state.operations.claim({ ...binding, rows: previous.rows, selectedIndices: previous.rows.filter(row => !selectedIds || row.profileId && selectedIds.has(row.profileId)).map(row => row.index) });
        return response({ ok: true, operation: admission.operation });
      }
    }
    if (state.applying && action !== "check") throw new ProxyToolsError("Replacement is still running", 409);
    if (action === "preview") {
      const single = body.mode === "single" ? validateSingleProxyPreviewInput(body) : null;
      const incarnations = new Map<string, string | null>();
      const profiles = await inventory(incarnations, single?.ids);
      const built = single ? buildSingleProxyPreview(profiles, single) : buildProxyPreview(profiles, body as ProxyTextPreviewInput);
      const scope = single ? { all: true, ids: single.ids } : structuredClone(body.scope);
      assertCurrent();
      if (state.applying) throw new ProxyToolsError("Replacement is still running", 409);
      state.preview = { id: state.operations.issuePreview(), scope, singleTargetIds: single?.ids, incarnations, ...built };
      return response(previewView(state.preview, state.operations.operationScope));
    }
    if (action === "retry-preview") {
      const previous = getPreview();
      if (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== "string")) throw new ProxyToolsError("Select failed profiles to retry");
      const ids = new Set<string>(body.ids);
      const candidates = previous.rows.filter(row => row.view.profileId && ids.has(row.view.profileId) && ["skipped", "failed"].includes(row.view.status));
      const singleTargetIds = previous.singleTargetIds ? candidates.map(row => row.view.profileId!) : undefined;
      const incarnations = new Map<string, string | null>();
      const fresh = new Map(selectProxyProfiles(await inventory(incarnations, singleTargetIds), previous.scope).map((p) => [p.id, p]));
      const rows = candidates.map((row) => {
        const profile = fresh.get(row.view.profileId!);
        if (!row.next || row.view.code === "duplicate_target") return { ...row, view: { ...row.view } };
        const originalIdentity = previous.incarnations.get(row.view.profileId!);
        if (profile && (!originalIdentity || originalIdentity !== incarnations.get(profile.id))) {
          return { ...row, view: { ...row.view, status: "skipped" as const, code: "version_conflict" } };
        }
        return { ...row, originalKey: proxyIdentityKey(profile?.proxy ?? null),
          view: { ...row.view, name: profile?.name ?? row.view.name, group: profile?.group ?? row.view.group,
            previousProxy: profile?.proxy ? `${profile.proxy.type}://${proxyHostPort(profile.proxy)}` : null,
            code: undefined, ...replacementState(profile, row.next) } };
      });
      assertCurrent();
      if (state.applying) throw new ProxyToolsError("Replacement is still running", 409);
      if (state.preview !== previous) throw new ProxyToolsError("Preview expired. Preview the replacements again.", 409);
      state.preview = { ...previous, id: state.operations.issuePreview(), singleTargetIds, rows };
      return response(previewView(state.preview, state.operations.operationScope));
    }
    if (action !== "check" && action !== "apply") throw new ProxyToolsError("Unknown proxy operation", 404);
    const preview = action === "apply" ? getPreview() : undefined;
    if (preview && binding) {
      const selectedIds = body.ids ? new Set<string>(body.ids) : null;
      const admission = state.operations.claim({ ...binding, rows: preview.rows.map(row => operationRow(row.view)), selectedIndices: preview.rows.filter(row => !selectedIds || row.view.profileId && selectedIds.has(row.view.profileId)).map(row => row.view.index) });
      if (admission.kind !== "started") return response({ ok: true, operation: admission.operation });
      operationOwner = admission.owner;
    }
    const encoder = new TextEncoder();
    if (preview) { state.applying = true; ownsApplyState = true; }
    let clientGone = false;
    const cancelled = () => clientGone || !current();
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        workerStarted = true;
        const send = (event: ProxyProgressEvent) => {
          if (clientGone || !current()) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { clientGone = true; }
        };
        try {
          send({ type: "progress", phase: "loading", completed: 0, total: 1 });
          const profiles = await inventory(undefined, preview?.singleTargetIds);
          send({ type: "progress", phase: "loading", completed: 1, total: 1 });
          if (action === "check") {
            await checkProfileProxies(selectProxyProfiles(profiles, body.scope), send, cancelled,
              options.proxyCheck ? { check: options.proxyCheck, direct: async () => null } : undefined);
          } else if (preview) {
            const selectedIds = body.ids ? new Set<string>(body.ids) : null;
            for (const row of preview.rows) {
              if (row.view.status !== "ready" && (!selectedIds || selectedIds.has(row.view.profileId!))) send({ type: "replacement", row: row.view });
            }
            const rows = preview.rows.filter((r) => r.view.status === "ready" && r.next && (!selectedIds || selectedIds.has(r.view.profileId!)));
            const byId = new Map(selectProxyProfiles(profiles, preview.scope).map((p) => [p.id, p]));
            let completed = 0;
            send({ type: "progress", phase: "applying", completed, total: rows.length });
            // Bound timezone lookups and writes per batch without limiting the profile count.
            for (let offset = 0; offset < rows.length && !cancelled(); offset += 16) {
              const batch = rows.slice(offset, offset + 16);
              const ready: PlannedProxyReplacement[] = [];
              for (const row of batch) {
                const profile = byId.get(row.view.profileId!);
                const status = replacementState(profile, row.next!);
                if (!profile || profile.group !== row.view.group || profile.permission !== "edit") {
                  Object.assign(row.view, { status: "skipped", code: "no_editable_match" });
                } else if (proxyIdentityKey(profile.proxy) !== row.originalKey || !preview.incarnations.get(profile.id) || store.getProfileIncarnation(profile.id) !== preview.incarnations.get(profile.id)) {
                  Object.assign(row.view, { status: "skipped", code: "version_conflict" });
                } else if (status.status !== "ready") Object.assign(row.view, { code: undefined, ...status });
                else ready.push(row);
              }
              {
                for (const row of ready) {
                  if (cancelled()) break;
                  const id = row.view.profileId!;
                  try {
                    let profile = store.getProfile(id);
                    if (!profile || proxyIdentityKey(profile.proxy) !== row.originalKey || profile.group !== row.view.group || store.getProfileIncarnation(id) !== preview.incarnations.get(id)) {
                      Object.assign(row.view, { status: "skipped", code: "version_conflict" }); continue;
                    }
                    await launcher.cacheCleanupSettled(id);
                    if (!current()) break;
                    if (launcher.profileDeletionBlocked(id)) { Object.assign(row.view, { status: "skipped", code: "profile_open" }); continue; }
                    const changed = { ...profile, proxy: row.next!, timezone: "" };
                    await attachTimezones([changed], options.timezoneFetch, false, { settlePending: true }).catch(() => {});
                    if (!current()) break;
                    profile = store.getProfile(id);
                    if (!profile || proxyIdentityKey(profile.proxy) !== row.originalKey || profile.group !== row.view.group || store.getProfileIncarnation(id) !== preview.incarnations.get(id)) {
                      Object.assign(row.view, { status: "skipped", code: "version_conflict" }); continue;
                    }
                    if (launcher.profileDeletionBlocked(id)) { Object.assign(row.view, { status: "skipped", code: "profile_open" }); continue; }
                    profile.proxy = row.next!; delete profile.proxyError;
                    // A failed lookup keeps the saved timezone.
                    if (changed.timezone) { profile.timezone = changed.timezone; syncFirefoxTimezone(profile); }
                    store.upsertProfile(profile);
                    Object.assign(row.view, { status: "updated", code: undefined });
                  } catch { Object.assign(row.view, { status: "failed", code: "update_failed" }); }
                }
              }
              for (const row of batch) {
                if (row.view.status === "ready") continue;
                if (operationOwner) state.operations.record(operationOwner, operationRow(row.view));
                send({ type: "replacement", row: row.view });
                send({ type: "progress", phase: "applying", completed: ++completed, total: rows.length });
              }
            }
          }
          if (!cancelled()) send({ type: "done" });
        } catch (error) { send({ type: "error", error: safeError(error) }); }
        finally {
          try {
            if (operationOwner && preview) {
              for (const row of preview.rows) if (row.view.status !== "ready") state.operations.record(operationOwner, operationRow(row.view));
              state.operations.finish(operationOwner);
            }
          } finally {
            if (preview) state.applying = false;
            try { controller.close(); } catch {}
            finally { releaseMutation?.(); }
          }
        }
      },
      cancel() { clientGone = true; },
    }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (error) {
    if (error instanceof WorkspaceBusyError) return response({ ok: false, code: "workspace_busy", error: "Workspace maintenance is in progress. Try again after it finishes." }, 423);
    if (error instanceof ProxyOperationStateError) return response({ ok: false, code: error.code, error: error.message }, error.status);
    if (error instanceof SingleProxyPreviewInputError) return response({ ok: false, error: error.message }, 400);
    return response({ ok: false, error: safeError(error) }, error instanceof ProxyToolsError ? error.status : error instanceof SyntaxError ? 400 : 500);
  } finally {
    // Invalid input/token and pre-stream failures never transfer ownership.
    if (!workerStarted) {
      if (ownsApplyState) state.applying = false;
      try { if (operationOwner) state.operations.finish(operationOwner); }
      finally { releaseMutation?.(); }
    }
  }
}
