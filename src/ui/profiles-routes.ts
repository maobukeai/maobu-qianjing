import { createHash } from "node:crypto";
import { BrowserLaunchError, defaultSetCookies, type Launcher } from "../../launcher.ts";
import type { ProfileStore } from "../../store.ts";
import type { CookieRecord, Profile } from "../../types.ts";
import { importInbox, importBuffers, ProfileImportError } from "../../inbox.ts";
import { buildNewProfile, type NewProfileInput } from "../../create.ts";
import { attachTimezones, lookupExitLocation } from "../../geoip.ts";
import { localeForCountry, localeForTimezone } from "../../profile-locale.ts";
import {
  parseUpdateFile,
  rowsToUpdates,
  serializeCsv,
  serializeAdsTxt,
  serializeXlsxRows,
  decodeText,
  parseCookieText,
  cookiesForEngine,
  type ProfileExport,
} from "../../parse.ts";
import { writeXlsx, readXlsx } from "../../xlsx.ts";
import { generateTotp } from "../../totp.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "../../profile-id.ts";
import { ProfileNotesValidationError } from "../../profile-notes.ts";
import { ProfileTagsValidationError } from "../../profile-tags.ts";
import { inferLaunchFailureRecoveryKind, recordProfileEvent } from "../../profile-timeline.ts";
import { convertMobilePersonaToDesktop, isMobileUserAgent } from "../../fingerprint.ts";
import { syncFirefoxTimezone } from "../../firefox-config.ts";
import {
  applyEdits,
  importOverridesFromForm,
  listUiProfiles,
  msg,
  noStoreJson,
  openResponse,
  profileEditView,
  profileEngine,
  rejectCrossOriginMutation,
  rejectUntrustedJsonMutation,
  restartRequired,
  reusableProfileView,
  safeDecodeIdParam,
  singleCookie,
  type UiRuntimeOptions,
} from "./shared.ts";

/** Profile CRUD, import/export, cookies, timezone, 2FA, and launch action UI routes. */
export async function handleProfilesUiRoutes(
  req: Request,
  pathname: string,
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions,
): Promise<Response | null> {
  if (pathname === "/ui/api/profiles" && req.method === "GET") {
    try {
      await launcher.reconcileOrphans();
      const requestedTag = req.headers.get("If-None-Match");
      const tags = options.rosterTags;
      const revision = tags ? store.readRevision() : null;
      const previous = tags?.get(store);
      const serialize = () => JSON.stringify({
        profiles: listUiProfiles(store),
        groups: store.listGroups(),
        folders: store.listFolders(),
      });
      let body: string | null = null;
      let etag: string;
      if (revision !== null && previous?.revision === revision && requestedTag === previous.etag) {
        etag = previous.etag;
      } else {
        // Build a consistent SQLite snapshot. An external commit during this
        // read invalidates reuse even if the response still represents the old snapshot.
        body = revision === null ? serialize() : store.withTransaction(serialize);
        etag = `"sha256-${createHash("sha256").update(body).digest("hex")}"`;
        if (revision !== null && store.readRevision() === revision) tags?.set(store, { revision, etag });
        else tags?.delete(store);
      }
      const headers = {
        "Cache-Control": "no-store",
        ETag: etag,
        "Content-Type": "application/json; charset=utf-8",
      };
      if (requestedTag === etag) return new Response(null, { status: 304, headers });
      return new Response(body, { headers });
    } catch (error) {
      return noStoreJson({ ok: false, error: `profile roster failed: ${msg(error)}` }, 500);
    }
  }

  if (pathname === "/ui/api/profiles" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const input = (await req.json()) as NewProfileInput;
      const profile = buildNewProfile(input, (id) => !!store.getProfile(id));
      store.applyGroupExtensionDefaults(profile, null, false);
      if (profile.proxy) {
        await attachTimezones([profile], options.timezoneFetch, true).catch(() => {});
        syncFirefoxTimezone(profile);
      }
      store.upsertProfile(profile);
      recordProfileEvent(store, {
        profileId: profile.id,
        eventType: "profile.created",
        status: "ok",
        actor: "user",
        summary: "Created environment.",
        detail: { engine: profileEngine(profile), hasProxy: !!profile.proxy },
      });
      launcher.prefetchFirefoxFontPacks?.([profile]);
      return Response.json({ ok: true, id: profile.id });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/profiles/move" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { ids?: unknown; group?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const group = typeof body.group === "string" ? body.group.trim() : "";
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
      if (ids.some((id) => !isSafeProfileId(id))) {
        return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      }
      const moved = store.setGroup(ids, group);
      if (moved > 0) {
        for (const id of ids) {
          if (!store.getProfile(id)) continue;
          recordProfileEvent(store, {
            profileId: id,
            eventType: "group.changed",
            status: "ok",
            actor: "user",
            summary: group ? `Moved to group "${group}".` : "Removed from group.",
            detail: { group },
          });
        }
      }
      return Response.json({ ok: true, moved, group });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/profiles/delete" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
      if (ids.some((id) => !isSafeProfileId(id))) {
        return Response.json({ ok: false, error: PROFILE_ID_ERROR, deleted: 0 }, { status: 400 });
      }
      const existing = ids.filter((id) => store.getProfile(id));
      await Promise.all(existing.map((id) => launcher.cacheCleanupSettled(id)));
      const locked = existing.filter((id) => launcher.profileDeletionBlocked(id));
      if (locked.length > 0) {
        return Response.json(
          { ok: false, error: "close open profiles before deleting them", deleted: 0, locked },
          { status: 409 },
        );
      }
      let deleted = 0;
      for (const id of existing) {
        if (store.trashProfile(id)) {
          deleted++;
          recordProfileEvent(store, {
            profileId: id,
            eventType: "profile.trashed",
            status: "info",
            actor: "user",
            summary: "Moved environment to Trash.",
          });
        }
      }
      return Response.json({ ok: true, deleted, locked: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import" && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    try {
      const r = await importInbox(store, options.paths?.inbox);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import/upload" && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    try {
      const form = await req.formData();
      const uploads: { name: string; bytes: Uint8Array }[] = [];
      const override = importOverridesFromForm(form);
      for (const [, value] of form) {
        if (value instanceof File) uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
      if (uploads.length === 0) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      const imported = await importBuffers(store, uploads, console.log, override, options.timezoneFetch);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...imported });
    } catch (error) {
      const status = error instanceof ProfileImportError ? error.status : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/export" && req.method === "POST") {
    return Response.json({ ok: false, error: "export is not available" }, { status: 404 });
  }

  if (pathname === "/ui/api/profiles/export" && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    let body: { ids?: unknown; format?: unknown; stream?: unknown };
    try {
      body = (await req.json()) as { ids?: unknown; format?: unknown; stream?: unknown };
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) return Response.json({ ok: false, error: "select at least one profile to export" }, { status: 400 });
    if (ids.some((id) => !isSafeProfileId(id))) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    if (body.format !== "txt" && body.format !== "xlsx" && body.format !== "csv") {
      return Response.json({ ok: false, error: "format must be csv, txt, or xlsx" }, { status: 400 });
    }
    const format = body.format;
    const full = format !== "csv";
    try {
      const collectProfiles = async (
        onProgress: (completed: number) => void,
        aborted: () => boolean,
      ): Promise<ProfileExport[]> => {
        const profiles: ProfileExport[] = [];
        let processed = 0;
        for (const id of ids) {
          if (aborted()) return profiles;
          const fresh = full && await launcher.captureLocalSession(id);
          const profile = store.getProfile(id);
          if (profile) {
            const sessionBundle = full ? store.getSessionBundle(id) ?? undefined : undefined;
            profiles.push({
              ...profile,
              sessionBundle,
              sessionSource: fresh ? "live" : sessionBundle ? "saved" : "stored-cookies",
            });
          }
          onProgress(++processed);
        }
        return profiles;
      };
      const buildExportFile = async (profiles: ProfileExport[]): Promise<{ mime: string; bytes: Uint8Array }> => {
        if (format === "xlsx") {
          const { headers, rows } = serializeXlsxRows(profiles);
          return {
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bytes: await writeXlsx(headers, rows),
          };
        }
        const text = format === "txt" ? serializeAdsTxt(profiles) : serializeCsv(profiles);
        return {
          mime: `${format === "txt" ? "text/plain" : "text/csv"}; charset=utf-8`,
          bytes: new TextEncoder().encode(text),
        };
      };
      if (body.stream !== true) {
        const { mime, bytes } = await buildExportFile(await collectProfiles(() => {}, () => false));
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "content-type": mime,
            "content-disposition": `attachment; filename=aliasmode-export.${format}`,
            "cache-control": "no-store",
          },
        });
      }
      let clientGone = false;
      req.signal.addEventListener("abort", () => { clientGone = true; });
      const encoder = new TextEncoder();
      const records = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (record: unknown) => {
            if (clientGone) return;
            try {
              controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
            } catch {
              clientGone = true;
            }
          };
          try {
            send({ type: "progress", completed: 0, total: ids.length });
            const profiles = await collectProfiles(
              (completed) => send({ type: "progress", completed, total: ids.length }),
              () => clientGone,
            );
            if (clientGone) return;
            const { mime, bytes } = await buildExportFile(profiles);
            send({ type: "file", mime, data: Buffer.from(bytes).toString("base64") });
          } catch (error) {
            send({ type: "error", error: msg(error) });
          } finally {
            try { controller.close(); } catch {}
          }
        },
        cancel() { clientGone = true; },
      });
      return new Response(records, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/profiles/update-file" && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    const summaries: ReturnType<typeof parseUpdateFile>[] = [];
    try {
      const form = await req.formData();
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const bytes = new Uint8Array(await value.arrayBuffer());
        const isWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;
        summaries.push(isWorkbook ? rowsToUpdates(await readXlsx(bytes)) : parseUpdateFile(decodeText(bytes)));
      }
      if (!summaries.length) throw new Error("No update file");
    } catch {
      return Response.json(
        { ok: false, updated: 0, skipped: 0, notFound: [], errors: [{ id: "", error: "update file could not be parsed" }] },
        { status: 400 },
      );
    }
    try {
      let skipped = 0;
      const notFound: string[] = [];
      const errors: Array<{ id: string; error: string }> = [];
      const pending = new Map<string, Profile>();
      const proxyChanged = new Set<string>();
      const applied: Array<{ id: string; set: Record<string, string> }> = [];
      for (const summary of summaries) {
        skipped += summary.skipped;
        for (const u of summary.updates) {
          if (!isSafeProfileId(u.id)) {
            errors.push({ id: u.id, error: PROFILE_ID_ERROR });
            continue;
          }
          const p = pending.get(u.id) ?? store.getProfile(u.id);
          if (!p) {
            notFound.push(u.id);
            continue;
          }
          try {
            const previousGroup = p.group;
            if (applyEdits(p, u.set)) proxyChanged.add(u.id);
            store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in u.set);
            pending.set(u.id, p);
            applied.push(u);
          } catch (error) {
            errors.push({ id: u.id, error: msg(error) });
          }
        }
      }
      if (errors.length) {
        return Response.json({ ok: false, updated: 0, skipped, notFound, errors }, { status: 400 });
      }
      const located = [...proxyChanged]
        .map((id) => pending.get(id))
        .filter((profile): profile is Profile => !!profile?.proxy && !profile.timezoneManual)
        .map((profile) => ({ ...profile, timezone: "" }));
      if (located.length > 0) {
        await attachTimezones(located, options.timezoneFetch).catch(() => {});
        pending.clear();
        for (const { id, set } of applied) {
          const p = pending.get(id) ?? store.getProfile(id);
          if (!p) continue;
          const previousGroup = p.group;
          applyEdits(p, set);
          store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
          pending.set(id, p);
        }
        for (const { id, timezone } of located) {
          const p = pending.get(id);
          if (p && timezone) {
            p.timezone = timezone;
            syncFirefoxTimezone(p);
          }
        }
      }
      store.upsertProfiles([...pending.values()]);
      return Response.json({ ok: true, updated: pending.size, skipped, notFound, errors: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/profiles/extensions" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = (await req.json()) as { ids?: unknown; extensionId?: unknown; op?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const extId = String(body.extensionId ?? "").trim();
      const add = body.op !== "remove";
      if (!ids.length || !extId) return Response.json({ ok: false, error: "ids and extensionId required" }, { status: 400 });
      if (ids.some((id) => !isSafeProfileId(id))) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      const firefoxIds = ids.filter((id) => profileEngine(store.getProfile(id)) === "firefox");
      if (firefoxIds.length > 0) {
        return Response.json({ ok: false, error: "Chrome extensions are unavailable for Firefox profiles" }, { status: 400 });
      }
      if (add && !store.getExtension(extId)) return Response.json({ ok: false, error: "unknown extension" }, { status: 404 });
      return Response.json({ ok: true, updated: store.assignExtension(ids, extId, add) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  const timezoneRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/timezone$/);
  if (timezoneRoute && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    const decoded = safeDecodeIdParam(timezoneRoute[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    try {
      const profile = store.getProfile(id);
      if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (profile.proxyError) {
        return Response.json({ ok: false, error: "Fix or remove the invalid proxy before setting the timezone." }, { status: 400 });
      }
      const location = await lookupExitLocation(profile.proxy, options.timezoneFetch);
      if (!location) {
        return Response.json({ ok: false, error: "Could not determine the connection timezone. The saved timezone is unchanged." }, { status: 502 });
      }
      const current = store.getProfile(id);
      if (!current || current.proxyError || JSON.stringify(current.proxy) !== JSON.stringify(profile.proxy)) {
        return Response.json({ ok: false, error: "Profile connection changed. Reopen Edit and try again." }, { status: 409 });
      }
      current.timezone = location.timezone;
      delete current.timezoneManual;
      current.locale = localeForCountry(location.country) ?? localeForTimezone(location.timezone);
      syncFirefoxTimezone(current);
      store.upsertProfile(current);
      return Response.json({ ok: true, timezone: current.timezone, locale: current.locale, ...restartRequired(store, id) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  const cookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/cookies$/);
  if ((cookieRoute || pathname === "/ui/api/profiles/cookies") && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: "invalid cookie request" }, { status: 400 });
    }
    let ids: string[];
    if (cookieRoute) {
      const decoded = safeDecodeIdParam(cookieRoute[1]!);
      if (!decoded.ok) return decoded.response;
      ids = [decoded.id];
    } else {
      ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    }
    if (!ids.length) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
    if (!ids.every(isSafeProfileId)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    let cookies: CookieRecord[];
    if (typeof body.text === "string") {
      try {
        cookies = parseCookieText(body.text);
      } catch (error) {
        return Response.json({ ok: false, error: msg(error) }, { status: 400 });
      }
    } else {
      const cookie = singleCookie(body);
      if (typeof cookie === "string") return Response.json({ ok: false, error: cookie }, { status: 400 });
      cookies = [cookie];
    }
    const setCookies = options.setCookies ?? defaultSetCookies;
    let live = 0, nextStart = 0;
    const errors: Array<{ id: string; error: string; status: number }> = [];
    for (const id of ids) {
      try {
        const launch = store.getLaunch(id);
        if (launch) {
          if (!await launcher.certifiedActive(id).catch(() => false) || !store.getLaunch(id)?.ws) {
            errors.push({ id, error: "profile browser is not open", status: 409 });
            continue;
          }
          const engine = launch.engine === "firefox" || profileEngine(store.getProfile(id)) === "firefox" ? "firefox" : "chromium";
          try {
            await setCookies(store.getLaunch(id)!.ws, cookiesForEngine(cookies, engine));
          } catch {
            errors.push({ id, error: "cookie could not be added", status: 500 });
            continue;
          }
          live++;
          recordProfileEvent(store, {
            profileId: id,
            eventType: "cookies.updated",
            status: "ok",
            actor: "user",
            summary: `Applied ${cookies.length} cookie(s) to running browser.`,
            detail: { count: cookies.length, applied: "now" },
          });
        } else {
          if (!store.getProfile(id)) {
            errors.push({ id, error: "no such profile", status: 404 });
            continue;
          }
          store.addPendingCookies(id, cookies);
          nextStart++;
          recordProfileEvent(store, {
            profileId: id,
            eventType: "cookies.updated",
            status: "ok",
            actor: "user",
            summary: `Queued ${cookies.length} cookie(s) for next launch.`,
            detail: { count: cookies.length, applied: "next-start" },
          });
        }
      } catch (error) {
        errors.push({ id, error: msg(error), status: 500 });
      }
    }
    if (cookieRoute) {
      const error = errors[0];
      if (error) return Response.json({ ok: false, error: error.error }, { status: error.status });
      return Response.json(live
        ? { ok: true, applied: "now", count: cookies.length }
        : { ok: true, applied: "next-start", count: cookies.length });
    }
    return Response.json({
      ok: errors.length === 0,
      count: cookies.length,
      live,
      nextStart,
      errors: errors.map(({ id, error }) => ({ id, error })),
    });
  }

  const pendingCookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/pending-cookies(\/clear)?$/);
  if (pendingCookieRoute && (pendingCookieRoute[2] ? req.method === "POST" : req.method === "GET")) {
    if (req.method === "POST") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    const decoded = safeDecodeIdParam(pendingCookieRoute[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    if (!store.getProfile(id)) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    const pending = store.getPendingCookies(id);
    if (pendingCookieRoute[2]) {
      store.clearPendingCookies(id, pending);
      return Response.json({ ok: true, removed: pending.length });
    }
    return noStoreJson({ ok: true, cookies: pending.map(({ domain, name }) => ({ domain, name })) });
  }

  const raise = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/raise$/);
  if (raise && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    const decoded = safeDecodeIdParam(raise[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    try {
      if (profileEngine(store.getProfile(id)) === "firefox") {
        return Response.json({ ok: false, error: "bringing a Firefox profile to the front is unavailable" }, { status: 400 });
      }
      await launcher.bringToFront(id);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  const totp = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/totp$/);
  if (totp && req.method === "GET") {
    const decoded = safeDecodeIdParam(totp[1]!);
    if (!decoded.ok) return decoded.response;
    const p = store.getProfile(decoded.id);
    if (!p) return noStoreJson({ ok: false, error: "no such profile" }, 404);
    const r = generateTotp(p.twofa ?? "");
    if (!r) return noStoreJson({ ok: true, code: null });
    return noStoreJson({ ok: true, code: r.code, secondsRemaining: r.secondsRemaining, period: r.period });
  }

  const reuse = pathname.match(/^\/ui\/api\/profiles\/([^/]*)\/reuse$/);
  if (reuse) {
    if (req.method !== "GET") {
      return Response.json(
        { ok: false, code: "method-not-allowed", error: "Source configuration is read-only. Use GET to prepare a new draft." },
        { status: 405, headers: { "Cache-Control": "no-store", Allow: "GET" } },
      );
    }
    let id: string;
    try {
      id = decodeURIComponent(reuse[1]!);
    } catch {
      return noStoreJson({ ok: false, code: "invalid-id", error: "The source environment ID is invalid." }, 400);
    }
    if (!isSafeProfileId(id)) {
      return noStoreJson({ ok: false, code: "invalid-id", error: "The source environment ID is invalid." }, 400);
    }
    const source = store.getProfile(id);
    if (!source) return noStoreJson({ ok: false, code: "not-found", error: "The source environment no longer exists." }, 404);
    if (isMobileUserAgent(source.ua)) {
      return noStoreJson({
        ok: false,
        code: "mobile-profile",
        error: "Convert this mobile profile to a desktop environment before reusing its settings.",
      }, 409);
    }
    const profile = reusableProfileView(source);
    if (!profile) {
      return noStoreJson({
        ok: false,
        code: "invalid-settings",
        error: "The source has legacy or unsupported settings. Create a new environment with reviewed settings instead.",
      }, 409);
    }
    return noStoreJson({ ok: true, profile });
  }

  const single = pathname.match(/^\/ui\/api\/profiles\/([^/]+)$/);
  if (single && req.method === "GET") {
    const decoded = safeDecodeIdParam(single[1]!);
    if (!decoded.ok) return decoded.response;
    const p = store.getProfile(decoded.id);
    if (!p) return noStoreJson({ ok: false, error: "no such profile" }, 404);
    return noStoreJson({ ok: true, profile: profileEditView(p) });
  }

  const upd = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/update$/);
  if (upd && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    const decoded = safeDecodeIdParam(upd[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    try {
      const body = (await req.json()) as { set?: unknown };
      const set = body.set && typeof body.set === "object" ? (body.set as Record<string, unknown>) : {};
      let p = store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      let previousGroup = p.group;
      const proxyChanged = applyEdits(p, set);

      if (proxyChanged && p.proxy && !("timezone" in set) && !p.timezoneManual) {
        const location = await lookupExitLocation(p.proxy, options.timezoneFetch);
        p = store.getProfile(id);
        if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
        previousGroup = p.group;
        applyEdits(p, set);
        if (location) {
          p.timezone = location.timezone;
          syncFirefoxTimezone(p);
        }
      }
      store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
      store.upsertProfile(p);
      if ("timezone" in set) store.setTimezone(id, p.timezone);
      if ("cores" in set) store.setHardware(id, p.hardware);
      const KNOWN_EDIT_FIELDS = new Set([
        "name", "group", "platform", "username", "password", "email", "emailPassword", "twofa",
        "resolution", "platformOs", "locale", "timezone", "fingerprintSeed", "cores",
        "proxy", "proxyType", "extensions", "tags", "notes", "customNo",
      ]);
      const fields = Object.keys(set).filter((key) => KNOWN_EDIT_FIELDS.has(key));
      if (proxyChanged) {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "proxy.updated",
          status: "ok",
          actor: "user",
          summary: p.proxy ? "Updated saved proxy settings." : "Cleared saved proxy.",
          detail: { fields, hasProxy: !!p.proxy },
        });
      } else if (fields.length === 1 && fields[0] === "notes") {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "notes.updated",
          status: "ok",
          actor: "user",
          summary: p.notes ? "Updated environment notes." : "Cleared environment notes.",
          detail: { fields: ["notes"], hasNotes: !!p.notes },
        });
      } else if (fields.length === 1 && fields[0] === "tags") {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "tags.updated",
          status: "ok",
          actor: "user",
          summary: `Updated tags (${p.tags?.length ?? 0}).`,
          detail: { fields: ["tags"], tagCount: p.tags?.length ?? 0 },
        });
      } else if (fields.length === 1 && fields[0] === "group") {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "group.changed",
          status: "ok",
          actor: "user",
          summary: p.group ? `Moved to group "${p.group}".` : "Removed from group.",
          detail: { fields: ["group"], group: p.group },
        });
      } else if (fields.length > 0) {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "config.updated",
          status: "ok",
          actor: "user",
          summary: `Updated configuration fields: ${fields.join(", ")}.`,
          detail: { fields },
        });
      }
      return Response.json({ ok: true, ...(restartRequired(store, id)) });
    } catch (e) {
      const badInput = e instanceof ProfileTagsValidationError || e instanceof ProfileNotesValidationError;
      return Response.json({ ok: false, error: msg(e) }, { status: badInput ? 400 : 500 });
    }
  }

  const convertMobile = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/convert-mobile$/);
  if (convertMobile && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    const decoded = safeDecodeIdParam(convertMobile[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    try {
      const p = store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (!isMobileUserAgent(p.ua)) return Response.json({ ok: true, changed: false });
      if (store.getLaunch(id)) {
        return Response.json({ ok: false, error: "profile is currently open; close it before converting its device persona" }, { status: 409 });
      }
      const conversion = convertMobilePersonaToDesktop(p);
      store.upsertProfile(conversion.profile);
      return Response.json({
        ok: true,
        changed: true,
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}x${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      });
    } catch (e) {
      const error = msg(e);
      const status = /currently open|in use/i.test(error) ? 409 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  }

  const action = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/(open|close|clear-cache)$/);
  if (action && req.method === "POST") {
    const rejected = rejectCrossOriginMutation(req);
    if (rejected) return rejected;
    const decoded = safeDecodeIdParam(action[1]!);
    if (!decoded.ok) return decoded.response;
    const id = decoded.id;
    const profile = store.getProfile(id);
    if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    try {
      if (action[2] === "open") {
        const r = await launcher.start(id);
        const warning = "warning" in r && typeof (r as { warning?: unknown }).warning === "string"
          ? (r as { warning: string }).warning
          : undefined;
        recordProfileEvent(store, {
          profileId: id,
          eventType: "launch.started",
          status: warning ? "warn" : "ok",
          actor: "user",
          summary: warning ? `Launched browser with warning: ${warning}` : "Launched browser environment.",
          detail: { engine: profileEngine(profile) },
          ...(warning ? { recoveryKind: "logs" as const } : {}),
        });
        return openResponse(profile, r);
      }
      if (action[2] === "close") {
        const launch = store.getLaunch(id);
        await launcher.captureLocalSession(id);
        const stopped = await launcher.stop(id, launch ?? undefined);
        if (stopped) {
          recordProfileEvent(store, {
            profileId: id,
            eventType: "launch.stopped",
            status: "ok",
            actor: "user",
            summary: "Closed browser environment.",
            detail: { engine: profileEngine(profile) },
          });
          return Response.json({ ok: true });
        }
        recordProfileEvent(store, {
          profileId: id,
          eventType: "launch.stop_failed",
          status: "failed",
          actor: "user",
          summary: "Browser teardown could not be confirmed.",
          recoveryKind: "logs",
        });
        return Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
      }
      const r = await launcher.clearCache(id);
      recordProfileEvent(store, {
        profileId: id,
        eventType: "cache.cleared",
        status: "ok",
        actor: "user",
        summary: "Cleared local browser cache.",
      });
      return Response.json({ ok: true, cleared: r.cleared });
    } catch (e) {
      const errorMessage = e instanceof BrowserLaunchError && e.guidance ? e.guidance : msg(e);
      if (action[2] === "open") {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "launch.failed",
          status: "failed",
          actor: "user",
          summary: `Launch failed: ${errorMessage}`,
          recoveryKind: inferLaunchFailureRecoveryKind(errorMessage),
        });
      } else if (action[2] === "close") {
        recordProfileEvent(store, {
          profileId: id,
          eventType: "launch.stop_failed",
          status: "failed",
          actor: "user",
          summary: `Stop failed: ${errorMessage}`,
          recoveryKind: "logs",
        });
      }
      return Response.json(
        { ok: false, error: errorMessage },
        { status: 500 },
      );
    }
  }

  return null;
}
