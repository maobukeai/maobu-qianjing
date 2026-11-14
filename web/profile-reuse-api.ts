import { isSafeProfileId } from "../profile-id.ts";

/** Local display metadata and safe creation settings; never a copied identity. */
export interface ReusableProfileSettings {
  sourceId: string;
  name: string;
  group: string;
  engine: "chromium" | "firefox";
  /** Explicit for Chromium; absent for Firefox. Missing stored runtime means CloakBrowser. */
  chromiumRuntime?: "aliasmode" | "cloakbrowser";
  platformOs: "" | "windows" | "macos" | "linux";
  screen: string;
  platform: string;
}

export class ProfileReuseRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = "ProfileReuseRequestError"; }
}
const FIELDS = ["sourceId", "name", "group", "engine", "chromiumRuntime", "platformOs", "screen", "platform"];
const MESSAGES: Record<string, string> = {
  "invalid-id": "The source environment ID is invalid.",
  "not-found": "The source environment no longer exists.",
  "mobile-profile": "Convert this mobile profile to a desktop environment before reusing its settings.",
  "invalid-settings": "The source has legacy or unsupported settings. Create a new environment with reviewed settings instead.",
  "method-not-allowed": "Source configuration is read-only. Use GET to prepare a new draft.",
};
const INVALID_RESPONSE = "The profile configuration service returned an invalid response.";
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: string[]): boolean { return Object.keys(value).every(key => fields.includes(key)); }
function profile(value: unknown, requestedId: string): value is ReusableProfileSettings {
  if (!object(value) || !exact(value, FIELDS) || value.sourceId !== requestedId || !isSafeProfileId(value.sourceId)
    || typeof value.name !== "string" || value.name.length > 4096 || typeof value.group !== "string" || value.group.length > 4096
    || !["chromium", "firefox"].includes(value.engine as string)
    || !["", "windows", "macos", "linux"].includes(value.platformOs as string)
    || typeof value.screen !== "string" || typeof value.platform !== "string" || value.platform.length > 253) return false;
  if (value.engine === "chromium" ? !["aliasmode", "cloakbrowser"].includes(value.chromiumRuntime as string) : "chromiumRuntime" in value) return false;
  const screen = /^(\d{3,5})x(\d{3,5})$/.exec(value.screen);
  if (!screen || Number(screen[1]) < 320 || Number(screen[1]) > 16_384 || Number(screen[2]) < 200 || Number(screen[2]) > 16_384) return false;
  return value.platform === "" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value.platform);
}

/** Reads a draft source only. Creating a profile remains an explicit separate action. */
export async function fetchReusableProfile(id: string, signal?: AbortSignal): Promise<ReusableProfileSettings> {
  if (!isSafeProfileId(id)) throw new ProfileReuseRequestError(MESSAGES["invalid-id"]!, "invalid-id", 400);
  if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
  let response: Response;
  try {
    response = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/reuse`, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Could not reach the profile configuration service. Try again.");
  }
  let result: unknown;
  try { result = await response.json(); }
  catch (error) { if (signal?.aborted) throw error; throw new Error(INVALID_RESPONSE); }
  if (!object(result)) throw new Error(INVALID_RESPONSE);
  if (!response.ok || result.ok !== true) {
    const code = typeof result.code === "string" && Object.hasOwn(MESSAGES, result.code) ? result.code : response.status === 404 ? "not-found" : "request-failed";
    throw new ProfileReuseRequestError(MESSAGES[code] ?? "The source configuration could not be loaded.", code, response.status);
  }
  if (!exact(result, ["ok", "profile"]) || !profile(result.profile, id)) throw new Error(INVALID_RESPONSE);
  const source = result.profile;
  return { sourceId: source.sourceId, name: source.name, group: source.group, engine: source.engine,
    ...(source.chromiumRuntime ? { chromiumRuntime: source.chromiumRuntime } : {}), platformOs: source.platformOs, screen: source.screen, platform: source.platform };
}
