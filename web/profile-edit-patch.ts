import { normalizeProfileTags, ProfileTagsValidationError } from "../src/profile-tags.ts";

export const PROFILE_EDIT_FORM_FIELDS = ["name", "group", "platform", "proxy", "proxyType", "username", "password", "email", "emailPassword", "twofa", "resolution", "tags", "customNo", "platformOs", "timezone", "locale", "cores", "fingerprintSeed"] as const;
export type ProfileEditFormField = typeof PROFILE_EDIT_FORM_FIELDS[number];
export type ProfileEditForm = Readonly<Record<ProfileEditFormField, string>>;
export type ProfileEditPatch = Partial<Record<Exclude<ProfileEditFormField, "tags">, string> & { tags: string[]; extensions: string[] }>;
export interface ProfileEditSnapshot {
  readonly form: ProfileEditForm;
  readonly extensions: readonly string[];
  readonly engine: "chromium" | "firefox";
  readonly timezoneManual: boolean;
  readonly proxyQuarantined: boolean;
}
export type ProfileEditChangeField = Exclude<ProfileEditFormField, "proxyType"> | "extensions";
export interface ProfileEditChange { readonly field: ProfileEditChangeField; readonly label: string; readonly effect: "stored" | "next-start"; readonly clearing: boolean }
export interface ProfileEditNotice { readonly field: "locale"; readonly code: "locale-clear-unsupported"; readonly message: string }
/** This object is safe for a preview component. It never contains a submitted or saved value. */
export interface ProfileEditSummary {
  readonly count: number;
  readonly changes: readonly ProfileEditChange[];
  readonly notices: readonly ProfileEditNotice[];
  readonly hasChanges: boolean;
  readonly nextStartCount: number;
  readonly proxyChanged: boolean;
  readonly fingerprintChanged: boolean;
  readonly extensionsChanged: boolean;
  readonly requiresFingerprintConfirmation: boolean;
  readonly groupDefaultsMayApply: boolean;
}
const LABELS: Record<ProfileEditChangeField, string> = { name: "Name", group: "Group", platform: "Platform", proxy: "Proxy settings", username: "Username", password: "Password", email: "Email", emailPassword: "Email password", twofa: "2FA secret", resolution: "Screen", tags: "Tags", customNo: "Custom NO.", platformOs: "Operating system", timezone: "Timezone", locale: "Language", cores: "CPU", fingerprintSeed: "Fingerprint seed", extensions: "Extensions" };
const FINGERPRINT = new Set<ProfileEditFormField>(["resolution", "platformOs", "timezone", "locale", "cores", "fingerprintSeed"]);
export class ProfileEditPatchError extends Error {
  constructor(readonly field: ProfileEditFormField | null, message: string) { super(message); this.name = "ProfileEditPatchError"; }
}
const INCOMPLETE = "Profile details are incomplete. Reload this editor before saving.";
function copyForm(value: Readonly<Record<string, unknown>>): ProfileEditForm {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProfileEditPatchError(null, INCOMPLETE);
  const result = {} as Record<ProfileEditFormField, string>;
  for (const field of PROFILE_EDIT_FORM_FIELDS) {
    let item: unknown; try { item = value[field]; } catch { throw new ProfileEditPatchError(null, INCOMPLETE); }
    if (typeof item !== "string") throw new ProfileEditPatchError(null, INCOMPLETE); result[field] = item;
  }
  return Object.freeze(result);
}
function extensionIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id)) throw new ProfileEditPatchError(null, INCOMPLETE);
  return [...new Set(value)];
}

/** Store one validated editor-session baseline in memory only. Never log or persist this snapshot. */
export function captureProfileEditSnapshot(input: { form: Readonly<Record<string, unknown>>; extensions: readonly string[]; engine: "chromium" | "firefox"; timezoneManual?: boolean; proxyQuarantined?: boolean }): ProfileEditSnapshot {
  if (input.engine !== "chromium" && input.engine !== "firefox") throw new ProfileEditPatchError(null, INCOMPLETE);
  return Object.freeze({ form: copyForm(input.form), extensions: Object.freeze(extensionIds(input.extensions)), engine: input.engine, timezoneManual: input.timezoneManual === true, proxyQuarantined: input.proxyQuarantined === true });
}
function invalid(field: ProfileEditFormField, message: string): never { throw new ProfileEditPatchError(field, message); }
function normalize(field: ProfileEditFormField, raw: string): string | string[] {
  const value = raw.trim();
  if (field === "tags") {
    try { return normalizeProfileTags(raw); } catch (error) { return invalid(field, error instanceof ProfileTagsValidationError ? error.message : "The tag list could not be validated."); }
  }
  if (field === "resolution") {
    if (!value) return invalid(field, "Enter screen dimensions; this editor cannot clear the saved screen size.");
    const match = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(value), width = Number(match?.[1]), height = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 200 || width > 16384 || height > 16384) return invalid(field, "Screen dimensions must be between 320×200 and 16384×16384.");
    return `${width}x${height}`;
  }
  if (field === "platformOs") {
    const platform = value.toLowerCase(); if (!["", "windows", "macos", "linux"].includes(platform)) return invalid(field, "Choose automatic, Windows, macOS or Linux for the operating system."); return platform;
  }
  if (field === "timezone") {
    if (!value) return "";
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return invalid(field, "Enter a supported timezone, or leave it blank for automatic settings.");
    try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { return invalid(field, "Enter a supported timezone, or leave it blank for automatic settings."); } return value;
  }
  if (field === "locale") {
    if (!value) return "";
    try { return Intl.getCanonicalLocales(value)[0] || ""; } catch { return invalid(field, "Enter a supported language tag such as en-US."); }
  }
  if (field === "cores") {
    if (!value) return ""; const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > 256) return invalid(field, "CPU count must be a whole number from 1 to 256, or blank for automatic settings."); return String(number);
  }
  if (field === "fingerprintSeed") {
    const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > 4294967295) return invalid(field, "Fingerprint seed must be a whole number from 1 to 4294967295."); return String(number);
  }
  if (field === "customNo") {
    if (value && (!/^\d+$/.test(value) || value.length > 12)) return invalid(field, "Custom NO. must contain at most 12 digits, or be blank."); return value;
  }
  // The server stores these text fields verbatim, including credential whitespace.
  return raw;
}
const same = (left: string | string[], right: string | string[]) => Array.isArray(left) && Array.isArray(right) ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right;
function unchangedAfterNormalization(field: ProfileEditFormField, original: string, next: string | string[]): boolean {
  try { return same(normalize(field, original), next); } catch { return false; }
}
function protocol(value: string): string {
  const type = value.trim().toLowerCase() || "http"; if (type === "socks") return "socks5";
  if (!["http", "https", "socks5"].includes(type)) return invalid("proxyType", "Choose HTTP, HTTPS or SOCKS5 for the proxy protocol."); return type;
}

/** Only changed allowlisted fields are submitted. The patch may contain credentials; pass only summary to React. */
export function buildProfileEditPatch(initial: ProfileEditSnapshot, draft: { form: Readonly<Record<string, unknown>>; extensions: readonly string[]; clearQuarantinedProxy?: boolean }): { patch: ProfileEditPatch; summary: ProfileEditSummary } {
  const original = copyForm(initial.form), current = copyForm(draft.form), nextExtensions = extensionIds(draft.extensions), previousExtensions = extensionIds(initial.extensions);
  const patch: ProfileEditPatch = {}, changes: ProfileEditChange[] = [], notices: ProfileEditNotice[] = [];
  const add = (field: ProfileEditChangeField, clearing: boolean) => changes.push(Object.freeze({ field, label: LABELS[field], effect: FINGERPRINT.has(field as ProfileEditFormField) || field === "proxy" || field === "extensions" ? "next-start" as const : "stored" as const, clearing }));
  for (const field of PROFILE_EDIT_FORM_FIELDS) {
    if (field === "proxy" || field === "proxyType" || current[field] === original[field]) continue;
    const normalized = normalize(field, current[field]);
    if (unchangedAfterNormalization(field, original[field], normalized)) continue;
    if (field === "locale" && normalized === "") {
      notices.push(Object.freeze({ field: "locale", code: "locale-clear-unsupported", message: "A blank language field keeps the saved language on this server. No language change will be submitted." })); continue;
    }
    if (field === "platformOs" && initial.engine === "firefox") return invalid(field, "Firefox operating system cannot be changed in this editor.");
    if (field === "tags") patch.tags = normalized as string[]; else patch[field] = normalized as string;
    add(field, normalized === "" || Array.isArray(normalized) && normalized.length === 0);
  }
  const nextProxy = current.proxy.trim(), oldProxy = original.proxy.trim();
  const clearQuarantine = initial.proxyQuarantined && draft.clearQuarantinedProxy === true && !nextProxy;
  let proxyChanged = nextProxy !== oldProxy || clearQuarantine;
  if (nextProxy && current.proxyType !== original.proxyType) {
    let previousType: string | null = null; try { previousType = protocol(original.proxyType); } catch { }
    proxyChanged ||= protocol(current.proxyType) !== previousType;
  }
  if (proxyChanged) { patch.proxy = nextProxy; patch.proxyType = protocol(current.proxyType); add("proxy", !nextProxy); }
  const oldSet = new Set(previousExtensions), nextSet = new Set(nextExtensions);
  const extensionsChanged = initial.engine === "chromium" && (oldSet.size !== nextSet.size || [...nextSet].some(id => !oldSet.has(id)));
  if (extensionsChanged) { patch.extensions = nextExtensions; add("extensions", nextExtensions.length === 0); }
  const fingerprintChanged = changes.some(change => FINGERPRINT.has(change.field as ProfileEditFormField));
  const groupDefaultsMayApply = initial.engine === "chromium" && !extensionsChanged && "group" in patch && !!current.group.trim() && current.group.trim() !== original.group.trim();
  return { patch, summary: Object.freeze({ count: changes.length, changes: Object.freeze(changes), notices: Object.freeze(notices), hasChanges: changes.length > 0,
    nextStartCount: changes.filter(change => change.effect === "next-start").length, proxyChanged, fingerprintChanged, extensionsChanged, requiresFingerprintConfirmation: fingerprintChanged, groupDefaultsMayApply }) };
}
