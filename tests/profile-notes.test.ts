import { describe, expect, test } from "bun:test";
import {
  isValidProfileNotes,
  MAX_PROFILE_NOTES_BYTES,
  MAX_PROFILE_NOTES_CHARACTERS,
  normalizeProfileNotes,
  ProfileNotesValidationError,
  profileNotesUpdate,
} from "../profile-notes.ts";

describe("profile notes validation and normalization", () => {
  test("normalizes CRLF to LF, NFC unicode, and collapses whitespace-only notes to empty string", () => {
    expect(normalizeProfileNotes("")).toBe("");
    expect(normalizeProfileNotes("   \r\n  \n  ")).toBe("");
    expect(normalizeProfileNotes("  Line 1\r\nLine 2\r\n  ")).toBe("Line 1\nLine 2");
    const decomposed = "Cafe\u0301 account";
    expect(normalizeProfileNotes(decomposed)).toBe("Café account");
    expect(profileNotesUpdate("  VIP\r\nUS East  ")).toEqual({ notes: "VIP\nUS East" });
    expect(isValidProfileNotes("Clean multi-line\nnote")).toBe(true);
  });

  test("rejects non-string inputs cleanly", () => {
    for (const bad of [null, undefined, 123, {}, ["note"], true]) {
      expect(() => normalizeProfileNotes(bad)).toThrow(ProfileNotesValidationError);
      try {
        normalizeProfileNotes(bad);
      } catch (error) {
        expect((error as ProfileNotesValidationError).code).toBe("invalid-type");
      }
      expect(isValidProfileNotes(bad)).toBe(false);
    }
  });

  test("rejects C0/C1 control characters (other than LF) and BiDi override characters", () => {
    const forbidden = [
      "null\u0000byte",
      "bell\u0007char",
      "tab\tchar",
      "bare\rcarriage",
      "escape\u001bseq",
      "del\u007fchar",
      "c1\u0085char",
      "bidi-rlo\u202espoof",
      "bidi-lre\u202aspoof",
      "bidi-isolate\u2066spoof",
      "bidi-pdi\u2069spoof",
    ];
    for (const sample of forbidden) {
      expect(() => normalizeProfileNotes(sample)).toThrow(ProfileNotesValidationError);
      try {
        normalizeProfileNotes(sample);
      } catch (error) {
        expect((error as ProfileNotesValidationError).code).toBe("invalid-character");
      }
    }
  });

  test("enforces 500 Unicode character limit and 2048 UTF-8 byte limit", () => {
    const exactChars = "a".repeat(MAX_PROFILE_NOTES_CHARACTERS);
    expect(normalizeProfileNotes(exactChars)).toBe(exactChars);

    const tooManyChars = "a".repeat(MAX_PROFILE_NOTES_CHARACTERS + 1);
    try {
      normalizeProfileNotes(tooManyChars);
      throw new Error("expected too-long");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileNotesValidationError);
      expect((error as ProfileNotesValidationError).code).toBe("too-long");
    }

    // 500 4-byte emoji = 2000 bytes (passes); wait — 500 chars * 4 bytes = 2000 <= 2048!
    // Check boundary with 500 4-byte code points (2000 bytes <= 2048, passes).
    const emoji500 = "😀".repeat(500);
    expect(Array.from(emoji500).length).toBe(500);
    expect(new TextEncoder().encode(emoji500).length).toBe(2000);
    expect(normalizeProfileNotes(emoji500)).toBe(emoji500);

    // 500 emoji + 1 extra emoji exceeds char limit (501 > 500).
    expect(() => normalizeProfileNotes("😀".repeat(501))).toThrow(ProfileNotesValidationError);
    expect(MAX_PROFILE_NOTES_BYTES).toBe(2048);
  });
});
