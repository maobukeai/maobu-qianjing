/** Shared limits and validation for profile notes. Pure module: never reads credentials or connections. */
export const MAX_PROFILE_NOTES_CHARACTERS = 500;
export const MAX_PROFILE_NOTES_BYTES = 2048;

export type ProfileNotesValidationCode =
  | "invalid-type"
  | "invalid-character"
  | "too-long"
  | "too-large";

const MESSAGES: Record<ProfileNotesValidationCode, string> = {
  "invalid-type": "Notes must be plain text.",
  "invalid-character": "Notes cannot contain control characters or text direction overrides.",
  "too-long": `Notes must contain at most ${MAX_PROFILE_NOTES_CHARACTERS} characters.`,
  "too-large": `Notes exceed the ${MAX_PROFILE_NOTES_BYTES}-byte size limit.`,
};

/** Reject C0/C1 control characters (except LF `\n`) and Unicode BiDi override/isolate characters. */
const FORBIDDEN_NOTES_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export class ProfileNotesValidationError extends Error {
  constructor(readonly code: ProfileNotesValidationCode) {
    super(MESSAGES[code]);
    this.name = "ProfileNotesValidationError";
  }
}

/**
 * Validate and normalize profile notes atomically.
 * - Normalizes `\r\n` line endings to `\n` and applies NFC normalization.
 * - Trims outer whitespace so whitespace-only notes collapse cleanly to `""`.
 * - Rejects control characters (including bare `\r` and `\t`) and BiDi overrides.
 * - Enforces <= 500 Unicode characters and <= 2048 UTF-8 bytes without silent truncation.
 */
export function normalizeProfileNotes(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProfileNotesValidationError("invalid-type");
  }
  const unified = value.replaceAll("\r\n", "\n");
  if (FORBIDDEN_NOTES_CHARS.test(unified)) {
    throw new ProfileNotesValidationError("invalid-character");
  }
  const normalized = unified.normalize("NFC").trim();
  if (!normalized) return "";
  if (Array.from(normalized).length > MAX_PROFILE_NOTES_CHARACTERS) {
    throw new ProfileNotesValidationError("too-long");
  }
  if (new TextEncoder().encode(normalized).length > MAX_PROFILE_NOTES_BYTES) {
    throw new ProfileNotesValidationError("too-large");
  }
  return normalized;
}

export function isValidProfileNotes(value: unknown): boolean {
  try {
    normalizeProfileNotes(value);
    return true;
  } catch {
    return false;
  }
}

/** Explicit partial-update allowlist for quick notes edits. */
export function profileNotesUpdate(notes: unknown): { notes: string } {
  return { notes: normalizeProfileNotes(notes) };
}
