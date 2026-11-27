import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFingerprintImportComparison, type FingerprintImportComparison } from "../src/fingerprint-import-comparison.ts";
import { FingerprintImportBadge } from "./fingerprint-import-badge.tsx";
import { I18nProvider } from "./i18n.tsx";

type BadgeProfile = Parameters<typeof FingerprintImportBadge>[0]["p"];
function render(p: BadgeProfile, language = "en-US") {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => language } });
  try { return renderToStaticMarkup(<I18nProvider><FingerprintImportBadge p={p} /></I18nProvider>); }
  finally { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); }
}

test("a full stored match is explicitly historical and does not trust a conflicting raw verdict", () => {
  const html = render({ fpImportComparison: buildFingerprintImportComparison({ canvas: "PRIVATE" }, { canvas: "PRIVATE", capturedAt: "2026-11-09T10:00:00Z" }),
    fpVerdict: { verdict: "mismatch", differences: [{ field: "PRIVATE_FIELD", expected: "PRIVATE_EXPECTED", observed: "PRIVATE_OBSERVED" }] } });
  expect(html).toContain("Stored import match");
  expect(html).toContain("Compared 1 of 1 imported fields; 1 matched.");
  expect(html).toContain("Measured: 2026-11-09T10:00:00.000Z.");
  expect(html).toContain("Does not verify the current configuration, current process, or anonymity.");
  expect(html).not.toContain("PRIVATE"); expect(html).not.toContain("verified"); expect(html).not.toContain("identity changed");
});

test("real differences and unmeasured fields remain separate and show only translated field names", () => {
  const html = render({ fpImportComparison: buildFingerprintImportComparison({ canvas: "PRIVATE_WANT", audio: "PRIVATE_AUDIO", platform: "Win32" }, { canvas: "PRIVATE_GOT", platform: "Win32" }) });
  expect(html).toContain("Import differences"); expect(html).toContain("Compared 2 of 3 imported fields; 1 matched.");
  expect(html).toContain("Different fields: Canvas."); expect(html).toContain("Unmeasured fields: Audio.");
  expect(html).not.toContain("PRIVATE"); expect(html).not.toContain("identity changed");
});

test("an absent capture is incomplete rather than a match and does not invent a measured time", () => {
  const html = render({ fpImportComparison: buildFingerprintImportComparison({ canvas: "PRIVATE" }, undefined) });
  expect(html).toContain("Import not fully compared"); expect(html).toContain("Compared 0 of 1 imported fields; 0 matched.");
  expect(html).toContain("Unmeasured fields: Canvas."); expect(html).not.toContain("Measured:");
  expect(html).not.toContain("Stored import match"); expect(html).not.toContain('class="fpbadge ok"');
});

test("legacy DTOs retain a neutral historical badge without raw verdicts, guessed counts or old timestamps", () => {
  for (const verdict of ["match", "mismatch"] as const) {
    const html = render({ fpVerdict: { verdict, differences: [{ field: "<script>PRIVATE</script>", expected: "PRIVATE_EXPECTED", observed: "PRIVATE_OBSERVED" }] }, fpCapturedAt: "PRIVATE_DATE" } as BadgeProfile);
    expect(html).toContain("Import comparison"); expect(html).toContain("Detailed comparison is unavailable for this older record.");
    expect(html).not.toContain("PRIVATE"); expect(html).not.toContain("Compared "); expect(html).not.toContain("verified");
    expect(html).not.toContain("identity changed"); expect(html).not.toContain('class="fpbadge ok"');
  }
});

test("no verdict or an explicit absence of comparable imported fields has no badge", () => {
  expect(render({})).toBe("");
  expect(render({ fpVerdict: null })).toBe("");
  expect(render({ fpImportComparison: null, fpVerdict: { verdict: "match", differences: [] } })).toBe("");
});

test("malformed summary fields and counts cannot produce a match or reflect attacker strings", () => {
  for (const summary of [
    { expectedCount: 0, comparedCount: 0, matchedCount: 0, differenceFields: [], missingFields: [] },
    { expectedCount: 1, comparedCount: 1, matchedCount: 1, differenceFields: ["PRIVATE_FIELD"], missingFields: [] },
    { expectedCount: 2, comparedCount: 2, matchedCount: 0, differenceFields: ["canvas", "canvas"], missingFields: [] },
    { expectedCount: 1, comparedCount: 1, matchedCount: 9, differenceFields: [], missingFields: [] },
    { expectedCount: 2, comparedCount: 1, matchedCount: 0, differenceFields: ["canvas"], missingFields: ["canvas"] },
  ]) {
    const html = render({ fpImportComparison: summary as FingerprintImportComparison });
    expect(html).toContain("Import comparison"); expect(html).not.toContain("Stored import match"); expect(html).not.toContain("PRIVATE");
  }
});

test("a malformed or non-ISO measurement date from a DTO is omitted independently of safe counts", () => {
  const summary = buildFingerprintImportComparison({ canvas: "same" }, { canvas: "same" })!;
  for (const capturedAt of ["PRIVATE_RAW", "2026-02-30T10:00:00Z", "2026-11-09", "2026-11-09T10:00:00Z<script>PRIVATE</script>"]) {
    const html = render({ fpImportComparison: { ...summary, capturedAt } });
    expect(html).toContain("Stored import match"); expect(html).not.toContain("Measured:"); expect(html).not.toContain("PRIVATE");
  }
});

for (const language of ["en-US", "zh-CN"]) {
  test(`historical import badge: ${language} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/fingerprint-import-badge-dom.tsx"), language], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("historical import badge fixture passed");
  }, 15_000);
}
