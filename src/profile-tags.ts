/** Shared limits for partial profile edits. No profile/account/connection fields are read here. */
export const MAX_PROFILE_TAGS = 20;
export const MAX_PROFILE_TAG_CHARACTERS = 40;
export const MAX_PROFILE_TAGS_JSON_BYTES = 2048;
export type ProfileTagsValidationCode = "invalid-type" | "invalid-character" | "too-long" | "too-many" | "too-large";
const MESSAGES: Record<ProfileTagsValidationCode, string> = {
  "invalid-type": "Tags must be text or a list of text labels.",
  "invalid-character": "Tags cannot contain control characters or text direction overrides.",
  "too-long": "Each tag must contain at most 40 characters.",
  "too-many": "Use at most 20 tags for one environment.",
  "too-large": "The tag list is too large. Use shorter tags.",
};
export class ProfileTagsValidationError extends Error {
  constructor(readonly code: ProfileTagsValidationCode) { super(MESSAGES[code]); this.name = "ProfileTagsValidationError"; }
}

/** The legacy editor sends comma-separated text; focused editors send exact label arrays. */
export function splitProfileTagInput(value: string): string[] { return value.split(/[,，\r\n]+/); }

/** Reject invalid labels atomically. Never truncate or coerce arbitrary values to strings. */
export function normalizeProfileTags(value: unknown): string[] {
  const source = typeof value === "string" ? splitProfileTagInput(value) : value;
  if (!Array.isArray(source) || source.some(tag => typeof tag !== "string")) throw new ProfileTagsValidationError("invalid-type");
  const tags: string[] = [], seen = new Set<string>();
  for (const raw of source as string[]) {
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new ProfileTagsValidationError("invalid-character");
    const tag = raw.trim().normalize("NFC");
    if (!tag) continue;
    if (Array.from(tag).length > MAX_PROFILE_TAG_CHARACTERS) throw new ProfileTagsValidationError("too-long");
    const identity = tag.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity); tags.push(tag);
    if (tags.length > MAX_PROFILE_TAGS) throw new ProfileTagsValidationError("too-many");
  }
  if (new TextEncoder().encode(JSON.stringify(tags)).length > MAX_PROFILE_TAGS_JSON_BYTES) throw new ProfileTagsValidationError("too-large");
  return tags;
}

/** Explicit partial-update allowlist. Never spread a profile or an EditProfile form. */
export function profileTagsUpdate(tags: unknown): { tags: string[] } { return { tags: normalizeProfileTags(tags) }; }
