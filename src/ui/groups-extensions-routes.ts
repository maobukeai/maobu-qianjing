import type { ProfileStore } from "../../store.ts";
import { ExtensionGroupRevisionError, parseExtensionGroupSelection } from "../../extension-group-revision.ts";
import {
  installExtension,
  installWebStoreExtension,
  parseWebStoreExtensionId,
  removeExtensionFiles,
} from "../../extensions.ts";
import { msg, rejectCrossOriginMutation, rejectUntrustedJsonMutation, type UiRuntimeOptions } from "./shared.ts";

/** Group CRUD, group extension defaults, and Chrome extension registry UI routes. */
export async function handleGroupsAndExtensionsUiRoutes(
  req: Request,
  pathname: string,
  store: ProfileStore,
  options: UiRuntimeOptions,
): Promise<Response | null> {
  if (pathname === "/ui/api/groups/create" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { name?: unknown; parentName?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      if (name === "all") return Response.json({ ok: false, error: "group name is reserved" }, { status: 400 });
      const folder = store.createGroup(name, typeof body.parentName === "string" ? body.parentName : null);
      return Response.json({ ok: true, name: folder.name, folder });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/groups/rename" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { from?: unknown; to?: unknown };
      const from = String(body.from ?? "").trim(), to = String(body.to ?? "").trim();
      if (!from || !to) return Response.json({ ok: false, error: "from and to group names required" }, { status: 400 });
      const source = store.listFolders().find((folder) => folder.name === from);
      const moved = store.renameGroup(from, to);
      const name = source?.parentName ? `${source.parentName}/${to}` : to;
      return Response.json({ ok: true, moved, folder: store.listFolders().find((folder) => folder.name === name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/groups/move" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = await req.json() as { name?: unknown; parentName?: unknown };
      if (typeof body.name !== "string" || (body.parentName !== null && typeof body.parentName !== "string")) {
        return Response.json({ ok: false, error: "name and parentName are required" }, { status: 400 });
      }
      return Response.json({ ok: true, folder: store.moveGroup(body.name, body.parentName) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }
  if (pathname === "/ui/api/groups/delete" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { name?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      return Response.json({ ok: true, ungrouped: store.deleteGroup(name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/groups/extensions/preview" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const selection = parseExtensionGroupSelection(await req.json());
      return Response.json(
        { ok: true, preview: store.previewGroupExtensionDefaults(selection.group, selection.extensions) },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      const failure = error instanceof ExtensionGroupRevisionError
        ? error
        : new ExtensionGroupRevisionError(error instanceof SyntaxError ? "invalid-selection" : "state-unavailable");
      return Response.json(
        { ok: false, code: failure.code, error: failure.message },
        { status: failure.status, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  if (pathname === "/ui/api/groups/extensions" && (req.method === "GET" || req.method === "POST")) {
    let reviewedRequest = false;
    try {
      if (req.method === "GET") {
        return Response.json({ ok: true, groups: store.listGroupExtensionDefaults() });
      }
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
      const body = (await req.json()) as { group?: unknown; extensions?: unknown; expectedFingerprint?: unknown };
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExtensionGroupRevisionError("invalid-selection");
      if (Object.prototype.hasOwnProperty.call(body, "expectedFingerprint")) {
        reviewedRequest = true;
        const selection = parseExtensionGroupSelection(body);
        if (body.expectedFingerprint === undefined) throw new ExtensionGroupRevisionError("invalid-fingerprint");
        return Response.json(
          { ok: true, updatedCount: store.setGroupExtensionDefaults(selection.group, selection.extensions, body.expectedFingerprint) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const group = String(body.group ?? "").trim();
      const extensions = Array.isArray(body.extensions) ? body.extensions.map(String) : null;
      if (!group || !extensions) {
        return Response.json({ ok: false, error: "group and extensions are required" }, { status: 400 });
      }
      return Response.json({ ok: true, updatedCount: store.setGroupExtensionDefaults(group, extensions) });
    } catch (error) {
      if (error instanceof ExtensionGroupRevisionError) {
        return Response.json(
          { ok: false, code: error.code, error: error.message },
          { status: error.status, headers: { "Cache-Control": "no-store" } },
        );
      }
      if (reviewedRequest) {
        return Response.json(
          { ok: false, code: "apply-failed", error: "Extension defaults could not be applied. Reload this page before trying again." },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/extensions" && req.method === "GET") {
    return Response.json({ ok: true, extensions: store.listExtensions().map((e) => ({ id: e.id, name: e.name })) });
  }
  if (pathname === "/ui/api/extensions/web-store" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    let source: string;
    let id: string;
    try {
      const body = (await req.json()) as { source?: unknown };
      source = String(body.source ?? "").trim();
      id = parseWebStoreExtensionId(source);
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const existing = store.getExtension(id);
    if (existing) {
      return Response.json({ ok: true, installed: { id: existing.id, name: existing.name }, alreadyInstalled: true });
    }
    try {
      const installed = await installWebStoreExtension(source, options.paths?.extensions, options.extensionFetch);
      try {
        store.addExtension({ id, name: installed.name, loadDir: installed.loadDir });
      } catch (error) {
        removeExtensionFiles(id, options.paths?.extensions);
        throw error;
      }
      return Response.json({ ok: true, installed: { id, name: installed.name }, alreadyInstalled: false });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/extensions/upload" && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    try {
      const form = await req.formData();
      const installed: Array<{ id: string; name: string }> = [];
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const id = "ext" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const bytes = new Uint8Array(await value.arrayBuffer());
        const fallback = value.name.replace(/\.(zip|crx)$/i, "");
        const { loadDir, name } = await installExtension(bytes, id, fallback, options.paths?.extensions);
        store.addExtension({ id, name, loadDir });
        installed.push({ id, name });
      }
      if (!installed.length) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      return Response.json({ ok: true, installed });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }
  if (pathname === "/ui/api/extensions/delete" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { id?: unknown };
      const id = String(body.id ?? "").trim();
      if (!id) return Response.json({ ok: false, error: "extension id required" }, { status: 400 });
      const liveIds = store.listProfiles()
        .filter((profile) => profile.extensions?.includes(id) && store.getLaunch(profile.id))
        .map((profile) => profile.id);
      if (liveIds.length > 0) {
        return Response.json(
          { ok: false, error: `extension is assigned to open profile(s) ${liveIds.join(", ")}; close them before deleting it` },
          { status: 409 },
        );
      }
      store.unassignExtension(id);
      store.deleteExtension(id);
      removeExtensionFiles(id, options.paths?.extensions);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }
  return null;
}
