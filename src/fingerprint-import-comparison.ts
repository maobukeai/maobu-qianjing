/** Small historical import comparison. No current configuration, provenance or process checks. */
import { comparableAttestationScalar, VERDICT_FIELDS } from "./fingerprint-attestation.ts";
import type { ObservedFingerprint } from "./types.ts";

export const FINGERPRINT_IMPORT_FIELD_LABELS = {
  canvas: "Canvas", audio: "Audio", webglVendor: "WebGL vendor", webglRenderer: "WebGL renderer",
  hardwareConcurrency: "Processor count", deviceMemory: "Device memory", languages: "Languages",
  screen: "Screen", platform: "System platform",
} as const;
export type FingerprintImportField = keyof typeof FINGERPRINT_IMPORT_FIELD_LABELS;

export interface FingerprintImportComparison {
  expectedCount: number;
  comparedCount: number;
  matchedCount: number;
  differenceFields: FingerprintImportField[];
  missingFields: FingerprintImportField[];
  /** A validated measurement instant, normalized to UTC. Never an imported display string. */
  capturedAt?: string;
}

export function isFingerprintImportField(value: unknown): value is FingerprintImportField {
  return typeof value === "string" && Object.hasOwn(FINGERPRINT_IMPORT_FIELD_LABELS, value);
}

/** Reject permissive Date.parse inputs and calendar rollover before exposing a date. */
export function fingerprintImportCapturedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 35) return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return undefined;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

/** Compare only the nine legacy attestation fields, with missing samples kept separate from differences. */
export function buildFingerprintImportComparison(
  expected: ObservedFingerprint | null | undefined,
  observed: ObservedFingerprint | null | undefined,
): FingerprintImportComparison | null {
  if (!expected) return null;
  const missingFields: FingerprintImportField[] = [], differenceFields: FingerprintImportField[] = [];
  let expectedCount = 0, comparedCount = 0;
  for (const field of VERDICT_FIELDS) {
    if (!isFingerprintImportField(field)) continue;
    const want = expected[field];
    if (!comparableAttestationScalar(want)) continue;
    expectedCount++;
    const got = observed?.[field];
    if (!comparableAttestationScalar(got)) {
      missingFields.push(field);
      continue;
    }
    comparedCount++;
    // Preserve the attestation's numeric/string equality for validated scalars.
    if (String(got) !== String(want)) differenceFields.push(field);
  }
  if (!expectedCount) return null;
  const capturedAt = fingerprintImportCapturedAt(observed?.capturedAt);
  return { expectedCount, comparedCount, matchedCount: comparedCount - differenceFields.length,
    differenceFields, missingFields, ...(capturedAt ? { capturedAt } : {}) };
}
