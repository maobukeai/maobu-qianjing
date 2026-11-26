import type { Launcher } from "../../launcher.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "../../profile-id.ts";
import {
  createProfilePackage,
  isValidConflictStrategy,
  MAX_PROFILE_PACKAGE_BYTES,
  MAX_PROFILE_PACKAGE_PROFILES,
  openProfilePackage,
  PROFILE_PACKAGE_HEADER_BYTES,
  ProfilePackageError,
  ProfilePackagePreviewStore,
  sealProfilePackage,
  validatePackagePassword,
} from "../../profile-package.ts";
import { recordProfileEvent } from "../../profile-timeline.ts";
import type { ProfileStore } from "../../store.ts";
import type { Profile } from "../../types.ts";
import { WorkspaceBusyError } from "../../workspace-maintenance.ts";
import {
  msg,
  noStoreJson,
  rejectCrossOriginMutation,
  rejectUntrustedJsonMutation,
  type UiRuntimeOptions,
} from "./shared.ts";

const storePreviewRegistries = new WeakMap<ProfileStore, ProfilePackagePreviewStore>();

function getPreviewStore(store: ProfileStore, options: UiRuntimeOptions): ProfilePackagePreviewStore {
  if (options.packagePreviewStore) return options.packagePreviewStore;
  let existing = storePreviewRegistries.get(store);
  if (!existing) {
    existing = new ProfilePackagePreviewStore();
    storePreviewRegistries.set(store, existing);
  }
  return existing;
}

function rejectMutationNoStore(req: Request, requireJson: boolean): Response | null {
  const rejected = requireJson ? rejectUntrustedJsonMutation(req) : rejectCrossOriginMutation(req);
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

function exportFileName(now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `maobu-profiles-${stamp}.mqprofile`;
}

/**
 * Encrypted `.mqprofile` package export, conflict preview, and atomic import routes.
 * Wire into `ui.ts` before `handleProfilesUiRoutes`.
 */
export async function handleProfilePackageRoutes(
  req: Request,
  pathname: string,
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions = {},
): Promise<Response | null> {
  if (pathname === "/ui/api/profiles/package/export") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const rejected = rejectMutationNoStore(req, true);
    if (rejected) return rejected;

    let body: {
      ids?: unknown;
      password?: unknown;
      includeSecrets?: unknown;
      includeSessions?: unknown;
      stream?: unknown;
    };
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON object body is required.");
      }
      body = parsed as typeof body;
    } catch (error) {
      return noStoreJson({ ok: false, code: "invalid_json", error: msg(error) }, 400);
    }

    const rawIds = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const ids = [...new Set(rawIds)];
    if (ids.length === 0) {
      return noStoreJson({ ok: false, code: "empty_selection", error: "Select at least one environment to export." }, 400);
    }
    if (ids.length > MAX_PROFILE_PACKAGE_PROFILES) {
      return noStoreJson(
        {
          ok: false,
          code: "too_many_profiles",
          error: `At most ${MAX_PROFILE_PACKAGE_PROFILES} environments can be exported in a single package.`,
        },
        400,
      );
    }
    if (ids.some((id) => !isSafeProfileId(id))) {
      return noStoreJson({ ok: false, code: "invalid_profile_id", error: PROFILE_ID_ERROR }, 400);
    }

    let password: string;
    try {
      validatePackagePassword(body.password);
      password = body.password;
    } catch (error) {
      return noStoreJson(
        { ok: false, code: error instanceof ProfilePackageError ? error.code : "invalid_password", error: msg(error) },
        400,
      );
    }

    const includeSecrets = body.includeSecrets !== false;
    const includeSessions = body.includeSessions !== false;

    const collectAndSeal = async (
      onProgress: (completed: number) => void,
      aborted: () => boolean,
    ): Promise<{ bytes: Buffer; profileCount: number; exportedIds: string[] }> => {
      const profiles: Profile[] = [];
      const sessions = new Map<string, string>();
      let processed = 0;

      for (const id of ids) {
        if (aborted()) break;
        const existing = store.getProfile(id);
        if (existing) {
          if (includeSessions && store.getLaunch(id) && typeof launcher?.captureLocalSession === "function") {
            await launcher.captureLocalSession(id).catch(() => false);
          }
          const latest = store.getProfile(id);
          if (latest) {
            profiles.push(latest);
            if (includeSessions) {
              const bundle = store.getSessionBundle(id);
              if (bundle) sessions.set(id, bundle);
            }
          }
        }
        onProgress(++processed);
      }

      if (profiles.length === 0) {
        throw new ProfilePackageError("None of the selected environments are available to export.", "not_found", 404);
      }

      const payload = createProfilePackage(profiles, {
        sessions,
        includeSecrets,
        includeSessions,
      });
      const bytes = await sealProfilePackage(payload, password);
      return { bytes, profileCount: profiles.length, exportedIds: profiles.map((p) => p.id) };
    };

    const recordExportEvents = (exportedIds: string[]) => {
      for (const id of exportedIds) {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "package.exported",
          status: "ok",
          actor: "user",
          summary: "Exported to encrypted .mqprofile package.",
          detail: { includeSecrets, includeSessions, batchSize: exportedIds.length },
        });
      }
      options.emitEvent?.("task.updated", {
        kind: "profile-package-export",
        profileCount: exportedIds.length,
      });
    };

    if (body.stream !== true) {
      try {
        const { bytes, exportedIds } = await collectAndSeal(() => {}, () => false);
        recordExportEvents(exportedIds);
        return new Response(new Uint8Array(bytes), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${exportFileName()}"`,
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        const status = error instanceof ProfilePackageError ? error.status : 500;
        const code = error instanceof ProfilePackageError ? error.code : "export_failed";
        return noStoreJson({ ok: false, code, error: msg(error) }, status);
      }
    }

    let releaseLease: (() => void) | null = null;
    try {
      releaseLease = options.workspaceManagement?.acquireMutationLease() ?? null;
    } catch (error) {
      if (error instanceof WorkspaceBusyError) {
        return noStoreJson({ ok: false, code: "workspace_busy", error: error.message }, 423);
      }
      return noStoreJson({ ok: false, code: "export_failed", error: msg(error) }, 500);
    }

    let clientGone = false;
    req.signal.addEventListener("abort", () => {
      clientGone = true;
    });
    const encoder = new TextEncoder();
    const fileName = exportFileName();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (record: unknown) => {
          if (clientGone) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
          } catch {
            clientGone = true;
          }
        };
        try {
          send({ type: "progress", completed: 0, total: ids.length });
          const { bytes, profileCount, exportedIds } = await collectAndSeal(
            (completed) => send({ type: "progress", completed, total: ids.length }),
            () => clientGone,
          );
          if (clientGone) return;
          recordExportEvents(exportedIds);
          send({
            type: "file",
            fileName,
            mime: "application/octet-stream",
            profileCount,
            bytes: bytes.byteLength,
            data: bytes.toString("base64"),
          });
        } catch (error) {
          send({
            type: "error",
            code: error instanceof ProfilePackageError ? error.code : "export_failed",
            error: msg(error),
          });
        } finally {
          releaseLease?.();
          try {
            controller.close();
          } catch {}
        }
      },
      cancel() {
        clientGone = true;
        releaseLease?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (pathname === "/ui/api/profiles/package/preview") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const rejected = rejectMutationNoStore(req, false);
    if (rejected) return rejected;

    let file: File | null = null;
    let password: unknown;
    try {
      const form = await req.formData();
      password = form.get("password");
      const explicitFile = form.get("file");
      if (explicitFile instanceof File) {
        file = explicitFile;
      } else {
        for (const [, value] of form) {
          if (value instanceof File) {
            file = value;
            break;
          }
        }
      }
    } catch {
      return noStoreJson({ ok: false, code: "invalid_multipart", error: "Upload a .mqprofile file with a password." }, 400);
    }

    if (!file) {
      return noStoreJson({ ok: false, code: "missing_file", error: "Choose a .mqprofile package file." }, 400);
    }
    if (file.size > MAX_PROFILE_PACKAGE_BYTES + PROFILE_PACKAGE_HEADER_BYTES) {
      return noStoreJson({ ok: false, code: "package_too_large", error: "Profile package exceeds the 64 MiB size limit." }, 413);
    }

    try {
      validatePackagePassword(password);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const payload = await openProfilePackage(bytes, password);
      const workspaceId = options.workspaceManagement?.currentId() ?? "default";
      const preview = getPreviewStore(store, options).create(payload, bytes, store, workspaceId);
      return noStoreJson({ ok: true, preview });
    } catch (error) {
      const status = error instanceof ProfilePackageError ? error.status : 400;
      const code = error instanceof ProfilePackageError ? error.code : "preview_failed";
      return noStoreJson({ ok: false, code, error: msg(error) }, status);
    }
  }

  if (pathname === "/ui/api/profiles/package/import") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const rejected = rejectMutationNoStore(req, true);
    if (rejected) return rejected;

    let body: {
      previewId?: unknown;
      previewToken?: unknown;
      strategy?: unknown;
      selectedIds?: unknown;
      confirmOverwrite?: unknown;
    };
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON object body is required.");
      }
      body = parsed as typeof body;
    } catch (error) {
      return noStoreJson({ ok: false, code: "invalid_json", error: msg(error) }, 400);
    }

    if (!isValidConflictStrategy(body.strategy)) {
      return noStoreJson(
        { ok: false, code: "invalid_strategy", error: "Strategy must be skip, clone_new_id, or overwrite_closed." },
        400,
      );
    }
    if (body.strategy === "overwrite_closed" && body.confirmOverwrite === false) {
      return noStoreJson(
        { ok: false, code: "overwrite_confirmation_required", error: "Confirm overwriting closed environments before importing." },
        400,
      );
    }
    let selectedIds: string[] | undefined;
    if (body.selectedIds !== undefined) {
      if (!Array.isArray(body.selectedIds) || body.selectedIds.some((id) => typeof id !== "string" || !isSafeProfileId(id))) {
        return noStoreJson({ ok: false, code: "invalid_selected_ids", error: PROFILE_ID_ERROR }, 400);
      }
      selectedIds = [...new Set(body.selectedIds)];
    }

    try {
      const workspaceId = options.workspaceManagement?.currentId() ?? "default";
      const result = getPreviewStore(store, options).importReviewed(store, body.previewId, body.previewToken, workspaceId, {
        strategy: body.strategy,
        selectedIds,
      });
      const createdProfiles = result.items
        .map((item) => (item.targetId ? store.getProfile(item.targetId) : null))
        .filter((profile): profile is Profile => profile !== null);
      if (createdProfiles.length > 0) {
        launcher.prefetchFirefoxFontPacks?.(createdProfiles);
      }
      options.emitEvent?.("task.updated", {
        kind: "profile-package-import",
        importedCount: result.importedCount,
        clonedCount: result.clonedCount,
        overwrittenCount: result.overwrittenCount,
        skippedCount: result.skippedCount,
      });
      return noStoreJson({ ok: true, result });
    } catch (error) {
      const status = error instanceof ProfilePackageError ? error.status : 500;
      const code = error instanceof ProfilePackageError ? error.code : "import_failed";
      return noStoreJson({ ok: false, code, error: msg(error) }, status);
    }
  }

  return null;
}
