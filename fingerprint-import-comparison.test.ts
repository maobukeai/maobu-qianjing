import { expect, test } from "bun:test";
import { compareAttestation, VERDICT_FIELDS } from "./fingerprint-attestation.ts";
import { buildFingerprintImportComparison, FINGERPRINT_IMPORT_FIELD_LABELS, fingerprintImportCapturedAt, isFingerprintImportField } from "./fingerprint-import-comparison.ts";
import type { ObservedFingerprint } from "./types.ts";

const all: ObservedFingerprint = {
  canvas: "PRIVATE_CANVAS", audio: "PRIVATE_AUDIO", webglVendor: "PRIVATE_VENDOR", webglRenderer: "PRIVATE_RENDERER",
  hardwareConcurrency: 8, deviceMemory: 4, languages: "en-US,en", screen: "1920*1080", platform: "Win32",
};

test("all nine attestation fields compare with the existing scalar rules without returning raw values", () => {
  expect(Object.keys(FINGERPRINT_IMPORT_FIELD_LABELS)).toEqual([...VERDICT_FIELDS]);
  const observed = { ...all, hardwareConcurrency: "8", ua: "different UA", chrome: "999", webrtc: "other policy", capturedAt: "2026-11-09T10:00:00Z" } as unknown as ObservedFingerprint;
  expect(compareAttestation(all, observed).verdict).toBe("match");
  const summary = buildFingerprintImportComparison(all, observed)!;
  expect(summary).toEqual({ expectedCount: 9, comparedCount: 9, matchedCount: 9, differenceFields: [], missingFields: [], capturedAt: "2026-11-09T10:00:00.000Z" });
  expect(JSON.stringify(summary)).not.toContain("PRIVATE");
});

test("each real difference is a safe field ID and does not include its expected or observed value", () => {
  for (const field of VERDICT_FIELDS.filter(isFingerprintImportField)) {
    const observed = { ...all, [field]: "PRIVATE_CHANGED_VALUE" } as ObservedFingerprint;
    const original = compareAttestation(all, observed);
    expect(original.differences.map(item => item.field)).toEqual([field]);
    const summary = buildFingerprintImportComparison(all, observed)!;
    expect(summary).toEqual({ expectedCount: 9, comparedCount: 9, matchedCount: 8, differenceFields: [field], missingFields: [] });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  }
});

test("missing measurements are separate from actual differences and cannot yield a complete match", () => {
  const summary = buildFingerprintImportComparison({ canvas: "PRIVATE_A", audio: "PRIVATE_B", platform: "Win32", languages: "en-US" },
    { canvas: "PRIVATE_A", audio: "PRIVATE_CHANGED", platform: "", capturedAt: "2026-11-09T18:00:00+08:00" });
  expect(summary).toEqual({ expectedCount: 4, comparedCount: 2, matchedCount: 1, differenceFields: ["audio"], missingFields: ["languages", "platform"], capturedAt: "2026-11-09T10:00:00.000Z" });
});

test("no comparable expected fields never becomes a match even if the legacy comparator says match", () => {
  for (const expected of [undefined, null, {}, { canvas: "", audio: null }, { ua: "PRIVATE_UA", chrome: "155", capturedAt: "2026-11-09T10:00:00Z" }]) {
    expect(buildFingerprintImportComparison(expected as ObservedFingerprint, all)).toBeNull();
  }
  expect(compareAttestation({}, all).verdict).toBe("match");
});

test("missing captures retain expected coverage without inventing comparisons or measurement dates", () => {
  for (const observed of [undefined, null, {}, { canvas: "", audio: null }]) {
    expect(buildFingerprintImportComparison(all, observed as ObservedFingerprint)).toEqual({
      expectedCount: 9, comparedCount: 0, matchedCount: 0, differenceFields: [], missingFields: VERDICT_FIELDS.filter(isFingerprintImportField),
    });
  }
});

test("absent expected fields are skipped and numeric zero keeps the comparator's scalar meaning", () => {
  expect(buildFingerprintImportComparison({ canvas: "", audio: undefined, hardwareConcurrency: 0 }, { hardwareConcurrency: 0, canvas: "PRIVATE" }))
    .toEqual({ expectedCount: 1, comparedCount: 1, matchedCount: 1, differenceFields: [], missingFields: [] });
});

test("malformed legacy fields cannot throw or count as a completed comparison", () => {
  const invalid = [{ toString: 0, valueOf: 0 }, ["fixture"], true, NaN, Infinity, -Infinity];
  for (const value of invalid) {
    const malformed = { canvas: value } as unknown as ObservedFingerprint;
    expect(buildFingerprintImportComparison(malformed, { canvas: "fixture" })).toBeNull();
    expect(buildFingerprintImportComparison({ canvas: "fixture" }, malformed)).toEqual({
      expectedCount: 1, comparedCount: 0, matchedCount: 0, differenceFields: [], missingFields: ["canvas"],
    });
  }
});

test("only valid ISO instants appear in the summary, without calendar rollover or arbitrary text", () => {
  for (const invalid of [undefined, "", "PRIVATE_RAW_DATE", "2026-11-09", "2026-02-29T10:00:00Z", "2026-04-31T10:00:00Z", "2026-11-09T24:00:00Z", "2026-11-09T10:60:00Z", "2026-11-09T10:00:60Z", "2026-11-09T10:00:00+24:00", "2026-11-09T10:00:00Z<script>PRIVATE</script>"]) {
    expect(fingerprintImportCapturedAt(invalid)).toBeUndefined();
    expect(buildFingerprintImportComparison({ canvas: "same" }, { canvas: "same", capturedAt: invalid })?.capturedAt).toBeUndefined();
  }
  expect(fingerprintImportCapturedAt("2024-02-29T10:00:00.12Z")).toBe("2024-02-29T10:00:00.120Z");
});

test("comparison reads only expected fields and the stored sample, without provenance or other IO inputs", () => {
  const deny = () => { throw new Error("A historical summary must not inspect provenance, current configuration or processes"); };
  const expected = { canvas: "same" } as ObservedFingerprint;
  const observed = { canvas: "same" } as ObservedFingerprint;
  for (const input of [expected, observed]) {
    Object.defineProperties(input, {
      fpSource: { get: deny }, captureSource: { get: deny }, configuration: { get: deny }, launch: { get: deny },
      source: { get: deny }, store: { get: deny }, io: { get: deny },
    });
  }
  expect(buildFingerprintImportComparison(Object.freeze(expected), Object.freeze(observed)))
    .toEqual({ expectedCount: 1, comparedCount: 1, matchedCount: 1, differenceFields: [], missingFields: [] });
});
