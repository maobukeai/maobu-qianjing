/** Reusable new-profile settings. Templates never contain a copied browser identity or secrets. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultProfileEngine, type NewProfileInput } from "./create.ts";
import { parseStrictResolution } from "./parse.ts";
import type { ProfileEngine } from "./types.ts";
import { plainDirectory, workspaceEntryExists, writeWorkspaceJson } from "./workspaces.ts";

export const PROFILE_TEMPLATES_FILE = "profile-templates.json";
export const PROFILE_TEMPLATE_LIMITS = Object.freeze({ templates: 100, fileBytes: 128 * 1024, nameCharacters: 80, nameBytes: 256 });
export type ProfileTemplateRuntime = "" | "aliasmode" | "cloakbrowser";
export type ProfileTemplatePlatformOs = "" | "windows" | "macos" | "linux";
export interface ProfileTemplateSettings {
  engine: ProfileEngine;
  /** Empty follows buildNewProfile's runtime default; explicit values pin that runtime. */
  chromiumRuntime: ProfileTemplateRuntime;
  /** Empty follows the host OS policy used when a fresh profile is created. */
  platformOs: ProfileTemplatePlatformOs;
  /** Empty keeps the new-profile automatic screen policy, rather than copying an identity. */
  screen: string;
  /** A platform domain, never a URL, account name, or browser control address. */
  platform: string;
}
export interface ProfileTemplate { id: string; name: string; settings: ProfileTemplateSettings; createdAt: string; updatedAt: string }
export interface ProfileTemplateCatalog { version: 1; revision: number; templates: ProfileTemplate[] }
export interface ProfileTemplateInput { id?: string; name: string; settings: ProfileTemplateSettings }
export type ProfileTemplateField = keyof ProfileTemplateSettings;
export interface ProfileTemplatePreview {
  templateId: string;
  changes: Array<{ field: ProfileTemplateField; before: string; after: string }>;
  /** Creating from these settings still goes through buildNewProfile's fresh identity generation. */
  freshIdentity: true;
}
export type ProfileTemplateErrorCode = "invalid-input" | "invalid-catalog" | "revision-conflict" | "not-found" | "catalog-full" | "duplicate-name" | "storage-error";
const ERRORS: Record<ProfileTemplateErrorCode, { message: string; status: number }> = {
  "invalid-input": { message: "Profile template input is invalid or contains unsupported fields.", status: 400 },
  "invalid-catalog": { message: "Profile template file is invalid or unsupported.", status: 500 },
  "revision-conflict": { message: "Profile templates changed. Refresh the list before saving again.", status: 409 },
  "not-found": { message: "The selected profile template no longer exists.", status: 404 },
  "catalog-full": { message: "The profile template limit has been reached. Remove a template before adding another.", status: 409 },
  "duplicate-name": { message: "A profile template with this name already exists.", status: 409 },
  "storage-error": { message: "Profile templates could not be saved. Check the workspace and try again.", status: 500 },
};
export class ProfileTemplateError extends Error {
  readonly code: ProfileTemplateErrorCode;
  readonly status: number;
  constructor(code: ProfileTemplateErrorCode) { super(ERRORS[code].message); this.name = "ProfileTemplateError"; this.code = code; this.status = ERRORS[code].status; }
}
function fail(code: ProfileTemplateErrorCode = "invalid-input"): never { throw new ProfileTemplateError(code); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) return fail(); return value as number; }
export function isProfileTemplateId(value: unknown): value is string { return typeof value === "string" && /^tpl_[0-9a-f]{32}$/.test(value); }
function name(value: unknown): string {
  if (typeof value !== "string") return fail();
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Array.from(normalized).length > PROFILE_TEMPLATE_LIMITS.nameCharacters || Buffer.byteLength(normalized) > PROFILE_TEMPLATE_LIMITS.nameBytes || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(normalized)) return fail();
  return normalized;
}
const FIELDS = ["engine", "chromiumRuntime", "platformOs", "screen", "platform"] as const;
/** Strict persistence/transport boundary; extra fields are rejected rather than stored. */
export function parseProfileTemplateSettings(value: unknown): ProfileTemplateSettings {
  const input = object(value); keys(input, FIELDS);
  if (!["chromium", "firefox"].includes(input.engine as string)
    || !["", "aliasmode", "cloakbrowser"].includes(input.chromiumRuntime as string)
    || !["", "windows", "macos", "linux"].includes(input.platformOs as string)
    || typeof input.screen !== "string" || input.screen.length > 40 || typeof input.platform !== "string" || input.platform.length > 253) return fail();
  if (input.engine === "firefox" && input.chromiumRuntime !== "") return fail();
  let screen = input.screen.trim();
  if (screen) {
    try { const resolution = parseStrictResolution(screen); screen = `${resolution.width}x${resolution.height}`; } catch { return fail(); }
  }
  const platform = input.platform.trim().toLowerCase();
  if (platform && (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(platform) || platform.endsWith(".localhost") || platform.endsWith(".local"))) return fail();
  return { engine: input.engine as ProfileEngine, chromiumRuntime: input.chromiumRuntime as ProfileTemplateRuntime, platformOs: input.platformOs as ProfileTemplatePlatformOs, screen, platform };
}
/** Only read these five fields from a draft. In particular, never enumerate or read its secrets. */
export function captureProfileTemplateSettings(input: NewProfileInput): ProfileTemplateSettings {
  object(input);
  const engine = input.engine ?? (input.chromiumRuntime ? "chromium" : defaultProfileEngine());
  return parseProfileTemplateSettings({ engine, chromiumRuntime: input.chromiumRuntime ?? "", platformOs: input.platformOs ?? "", screen: input.screen ?? "", platform: input.platform ?? "" });
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return fail();
  const time = Date.parse(value); if (!Number.isFinite(time) || time < 0 || new Date(time).toISOString() !== value) return fail();
  return value;
}
function parseTemplate(value: unknown): ProfileTemplate {
  const raw = object(value); keys(raw, ["id", "name", "settings", "createdAt", "updatedAt"]);
  if (!isProfileTemplateId(raw.id)) return fail();
  const createdAt = timestamp(raw.createdAt), updatedAt = timestamp(raw.updatedAt);
  if (updatedAt < createdAt) return fail();
  return { id: raw.id, name: name(raw.name), settings: parseProfileTemplateSettings(raw.settings), createdAt, updatedAt };
}
export function emptyProfileTemplateCatalog(): ProfileTemplateCatalog { return { version: 1, revision: 0, templates: [] }; }
/** Also used by workspace restore to reject malicious or future catalog formats before publishing. */
export function parseProfileTemplateCatalog(value: unknown): ProfileTemplateCatalog {
  try {
    const raw = object(value); keys(raw, ["version", "revision", "templates"]);
    if (raw.version !== 1 || !Array.isArray(raw.templates) || raw.templates.length > PROFILE_TEMPLATE_LIMITS.templates) return fail();
    const templates = raw.templates.map(parseTemplate), ids = new Set<string>(), names = new Set<string>();
    for (const template of templates) {
      const key = template.name.toLowerCase();
      if (ids.has(template.id) || names.has(key)) return fail();
      ids.add(template.id); names.add(key);
    }
    return { version: 1, revision: revision(raw.revision), templates };
  } catch { return fail("invalid-catalog"); }
}
export function previewProfileTemplate(template: ProfileTemplate, current: ProfileTemplateSettings): ProfileTemplatePreview {
  const target = parseTemplate(template), before = parseProfileTemplateSettings(current);
  return { templateId: target.id, changes: FIELDS.filter(field => before[field] !== target.settings[field]).map(field => ({ field, before: before[field], after: target.settings[field] })), freshIdentity: true };
}
/** Changes creation defaults only. The caller retains its draft and must explicitly create a new profile. */
export function applyProfileTemplate(input: NewProfileInput, template: ProfileTemplate): NewProfileInput {
  const { settings } = parseTemplate(template);
  return { ...input, ...settings, chromiumRuntime: settings.chromiumRuntime || undefined, platformOs: settings.platformOs || undefined };
}

export class ProfileTemplateStore {
  readonly path: string;
  constructor(path: string, private readonly now: () => number = Date.now) { this.path = resolve(path); }
  read(): ProfileTemplateCatalog {
    let fd: number | undefined;
    try {
      const parent = dirname(this.path);
      if (!workspaceEntryExists(parent)) return emptyProfileTemplateCatalog();
      plainDirectory(parent);
      if (!workspaceEntryExists(this.path)) return emptyProfileTemplateCatalog();
      const named = lstatSync(this.path);
      if (!named.isFile() || named.isSymbolicLink() || named.size > PROFILE_TEMPLATE_LIMITS.fileBytes) return fail("invalid-catalog");
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > PROFILE_TEMPLATE_LIMITS.fileBytes) return fail("invalid-catalog");
      const bytes = Buffer.alloc(PROFILE_TEMPLATE_LIMITS.fileBytes + 1); let length = 0;
      while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
      if (length > PROFILE_TEMPLATE_LIMITS.fileBytes) return fail("invalid-catalog");
      return parseProfileTemplateCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
    } catch { return fail("invalid-catalog"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private change(expectedRevision: unknown, operation: (current: ProfileTemplateCatalog) => void): ProfileTemplateCatalog {
    const expected = revision(expectedRevision), catalog = this.read();
    if (catalog.revision !== expected) return fail("revision-conflict");
    operation(catalog); catalog.revision++;
    const validated = parseProfileTemplateCatalog(catalog);
    if (Buffer.byteLength(JSON.stringify(validated, null, 2) + "\n") > PROFILE_TEMPLATE_LIMITS.fileBytes) return fail("catalog-full");
    try {
      mkdirSync(dirname(this.path), { recursive: true }); plainDirectory(dirname(this.path));
      // writeWorkspaceJson flushes a unique sibling, then uses Windows' bounded atomic rename helper.
      writeWorkspaceJson(this.path, validated);
    } catch { return fail("storage-error"); }
    return validated;
  }
  save(value: ProfileTemplateInput, expectedRevision: number): ProfileTemplateCatalog {
    const raw = object(value); keys(raw, ["id", "name", "settings"]);
    if (raw.id !== undefined && !isProfileTemplateId(raw.id)) return fail();
    const displayName = name(raw.name), settings = parseProfileTemplateSettings(raw.settings);
    return this.change(expectedRevision, catalog => {
      const existing = raw.id === undefined ? undefined : catalog.templates.find(template => template.id === raw.id);
      if (raw.id !== undefined && !existing) return fail("not-found");
      if (catalog.templates.some(template => template.id !== raw.id && template.name.toLowerCase() === displayName.toLowerCase())) return fail("duplicate-name");
      if (!existing && catalog.templates.length >= PROFILE_TEMPLATE_LIMITS.templates) return fail("catalog-full");
      let now: string;
      try { now = timestamp(new Date(this.now()).toISOString()); } catch { return fail("storage-error"); }
      // A clock adjustment must not make an otherwise valid existing template unreadable.
      if (existing && now < existing.updatedAt) now = existing.updatedAt;
      const template = { id: existing?.id ?? `tpl_${randomUUID().replaceAll("-", "")}`, name: displayName, settings, createdAt: existing?.createdAt ?? now, updatedAt: now };
      if (existing) catalog.templates[catalog.templates.indexOf(existing)] = template; else catalog.templates.push(template);
    });
  }
  rename(id: string, displayName: string, expectedRevision: number): ProfileTemplateCatalog {
    if (!isProfileTemplateId(id)) return fail();
    const current = this.read(), template = current.templates.find(item => item.id === id);
    if (!template) return fail("not-found");
    return this.save({ id, name: displayName, settings: template.settings }, expectedRevision);
  }
  remove(id: string, expectedRevision: number): ProfileTemplateCatalog {
    if (!isProfileTemplateId(id)) return fail();
    return this.change(expectedRevision, catalog => {
      const index = catalog.templates.findIndex(template => template.id === id);
      if (index < 0) return fail("not-found");
      catalog.templates.splice(index, 1);
    });
  }
}
