import type { ProfileTemplate, ProfileTemplateCatalog, ProfileTemplateInput, ProfileTemplateSettings } from "../src/profile-templates.ts";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
export type { ProfileTemplate, ProfileTemplateCatalog, ProfileTemplateInput, ProfileTemplateSettings };

const FIELDS = ["engine", "chromiumRuntime", "platformOs", "screen", "platform"] as const;
export class ProfileTemplateRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = "ProfileTemplateRequestError"; }
}
/** Never spread or enumerate a parent form: its other fields may contain credentials. */
export function copyTemplateSettings(value: ProfileTemplateSettings): ProfileTemplateSettings {
  return { engine: value.engine, chromiumRuntime: value.chromiumRuntime, platformOs: value.platformOs, screen: value.screen, platform: value.platform };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function date(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function settings(value: unknown): value is ProfileTemplateSettings {
  if (!object(value) || !exact(value, FIELDS) || !["chromium", "firefox"].includes(value.engine as string)
    || !["", "aliasmode", "cloakbrowser"].includes(value.chromiumRuntime as string) || value.engine === "firefox" && value.chromiumRuntime !== ""
    || !["", "windows", "macos", "linux"].includes(value.platformOs as string)
    || typeof value.screen !== "string" || value.screen.length > 40 || typeof value.platform !== "string" || value.platform.length > 253) return false;
  if (value.screen) {
    const screen = /^(\d{1,5})x(\d{1,5})$/.exec(value.screen);
    if (!screen || Number(screen[1]) < 320 || Number(screen[2]) < 200 || Number(screen[1]) > 16_384 || Number(screen[2]) > 16_384) return false;
  }
  return !value.platform || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.platform)
    && !value.platform.endsWith(".local") && !value.platform.endsWith(".localhost");
}
function catalog(value: unknown): value is ProfileTemplateCatalog {
  if (!object(value) || !exact(value, ["version", "revision", "templates"]) || value.version !== 1 || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0 || (value.revision as number) >= Number.MAX_SAFE_INTEGER || !Array.isArray(value.templates) || value.templates.length > 100) return false;
  const ids = new Set<string>(), names = new Set<string>();
  return value.templates.every(item => {
    if (!object(item) || !exact(item, ["id", "name", "settings", "createdAt", "updatedAt"])
      || typeof item.id !== "string" || !/^tpl_[a-f0-9]{32}$/.test(item.id) || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim() || item.name !== item.name.trim().normalize("NFC")
      || Array.from(item.name).length > 80 || new TextEncoder().encode(item.name).length > 256 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(item.name)
      || names.has(item.name.toLowerCase()) || !settings(item.settings) || !date(item.createdAt) || !date(item.updatedAt) || item.updatedAt < item.createdAt) return false;
    ids.add(item.id); names.add(item.name.toLowerCase()); return true;
  });
}
async function request(path: string, method: "GET" | "POST", value?: unknown, signal?: AbortSignal): Promise<ProfileTemplateCatalog> {
  const fullPath = `/ui/api/settings/templates${path}`;
  let response: Response;
  try {
    response = await fetch(fullPath, {
      method, credentials: "same-origin", cache: "no-store", signal,
      headers: withStandaloneAuthHeaders({ "X-Maobu-Settings": "1", Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }),
      ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Could not reach the profile preset service. Try again.");
  }
  const result: unknown = await response.json().catch(() => {
    notifyUnauthorizedResponse(response.status, fullPath);
    throw new Error("The profile preset service returned an invalid response.");
  });
  if (!object(result)) {
    notifyUnauthorizedResponse(response.status, fullPath);
    throw new Error("The profile preset service returned an invalid response.");
  }
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, fullPath, typeof result.error === "string" ? result.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, result);
  }
  if (!response.ok || result.ok !== true) throw new ProfileTemplateRequestError(typeof result.error === "string" ? result.error : "Profile preset request failed.", typeof result.code === "string" ? result.code : "request-failed", response.status);
  if (!catalog(result.catalog)) throw new Error("The profile preset service returned an invalid response.");
  return result.catalog;
}
export function fetchProfileTemplates(signal?: AbortSignal): Promise<ProfileTemplateCatalog> { return request("", "GET", undefined, signal); }
export async function saveProfileTemplate(input: ProfileTemplateInput, revision: number, signal?: AbortSignal): Promise<ProfileTemplateCatalog> {
  const value = { revision, ...(input.id === undefined ? {} : { id: input.id }), name: input.name, settings: copyTemplateSettings(input.settings) };
  const next = await request("", "POST", value, signal);
  const saved = next.templates.find(item => input.id ? item.id === input.id : item.name === input.name.normalize("NFC").trim());
  if (next.revision !== revision + 1 || !saved || saved.name !== input.name.normalize("NFC").trim()) throw new Error("The profile preset service returned an invalid response.");
  return next;
}
export async function deleteProfileTemplate(id: string, revision: number, signal?: AbortSignal): Promise<ProfileTemplateCatalog> {
  const next = await request("/delete", "POST", { revision, id }, signal);
  if (next.revision !== revision + 1 || next.templates.some(item => item.id === id)) throw new Error("The profile preset service returned an invalid response.");
  return next;
}
