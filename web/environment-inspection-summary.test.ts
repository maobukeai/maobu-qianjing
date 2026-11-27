import { expect, test } from "bun:test";
import { buildInspectionDiagnosticSummary, inspectionEvidenceSource, inspectionMeasurementCoverage, inspectionOverview } from "./environment-inspection.tsx";
import type { FingerprintReport } from "./settings-api.ts";
import { assessFingerprintQuality } from "../src/fingerprint-quality.ts";
import { parseExport } from "../src/parse.ts";

const report = (checks: FingerprintReport["checks"], measuredAt?: string): FingerprintReport => ({ profileId: "PRIVATE_ENVIRONMENT_ID", name: "PRIVATE_ACCOUNT_NAME", status: "consistent", summary: { pass: 999, warn: 999, fail: 999, unknown: 999 }, checks, ...(measuredAt ? { measuredAt } : {}) });
const check = (id: string, status: FingerprintReport["checks"][number]["status"] = "pass") => ({ id, status, label: "PRIVATE_COOKIE_VALUE", detail: "203.0.113.44 http://user:PRIVATE_PROXY_CREDENTIAL@proxy.invalid", recommendation: "PRIVATE_RAW_GUIDANCE" });

test("the diagnostic copy uses only fixed known vocabulary, counted statuses and canonical dates", () => {
  const value = report([check("identity_seed"), check("screen_config", "warn"), check("screen_config", "fail"), check("PRIVATE_UNKNOWN_ID", "warn"), check("timezone_measurement", "unknown")], "2026-11-09T10:00:00Z");
  const summary = buildInspectionDiagnosticSummary(value, { reviewedAt: 1794218400000, proxyStatus: "working" });
  expect(summary).toContain("Recognized checks: 3 · Passed 1 · Warnings 0 · Issues 1 · Unknown 1");
  expect(summary).toContain("Browser sample time: 2026-11-09T10:00:00.000Z"); expect(summary).toContain("Explicit proxy check: Proxy reachable");
  expect(summary).toContain("Additional unrecognized report categories: 1");
  for (const secret of ["PRIVATE", "203.0.113.44", "proxy.invalid", "999"]) expect(summary).not.toContain(secret);
  expect(summary.indexOf("Screen configuration · fail")).toBeLessThan(summary.indexOf("Fixed identity seed · pass"));
});

test("a timestamp or a consistent aggregate cannot manufacture measurement coverage", () => {
  expect(inspectionMeasurementCoverage(report([check("identity_seed")], "2026-11-09T10:00:00Z"))).toEqual({ sampleAvailable: false, timestampAvailable: true, linkedCurrentSample: false });
  expect(inspectionMeasurementCoverage(report([check("browser_sample")], "PRIVATE_TIME"))).toEqual({ sampleAvailable: true, timestampAvailable: false, linkedCurrentSample: false });
  const linked = ["browser_sample", "capture_source", "runtime_config", "sample_coverage", "sample_freshness"].map(id => check(id));
  expect(inspectionMeasurementCoverage(report(linked, "2026-11-09T10:00:00Z")).linkedCurrentSample).toBe(true);
  expect(inspectionMeasurementCoverage(report([...linked, check("capture_source", "warn")], "2026-11-09T10:00:00Z")).linkedCurrentSample).toBe(false);
  expect(buildInspectionDiagnosticSummary(report([check("identity_seed")], "PRIVATE_TIME"))).toContain("No usable browser sample is confirmed.");
  expect(buildInspectionDiagnosticSummary(report([check("browser_sample")], "PRIVATE_TIME"))).not.toContain("PRIVATE_TIME");
});

test("source classification follows real backend report categories and does not infer measurement from a pass", () => {
  const profile = parseExport("id=inspection_source\nname=Test\ncookie=[]\nproxytype=http\nresolution=1280*720\n******************").profiles[0]!;
  const actual = assessFingerprintQuality(profile, { launchState: "unknown", hostCores: 8 });
  expect(actual.checks.every(check => inspectionEvidenceSource(check.id) !== "other")).toBe(true);
  expect(inspectionEvidenceSource("identity_seed")).toBe("configuration"); expect(inspectionEvidenceSource("proxy_config")).toBe("route");
  expect(inspectionEvidenceSource("runtime_config")).toBe("provenance"); expect(inspectionEvidenceSource("hardware_configuration")).toBe("measurement");
  expect(inspectionEvidenceSource("new_browser_probe")).toBe("other"); expect(inspectionEvidenceSource("__proto__")).toBe("other");
  expect(actual.checks.some(check => check.id === "browser_sample" && check.status === "unknown")).toBe(true);
});

test("clipboard projection rejects unrecognized statuses and never echoes unparseable dates", () => {
  const unknownStatus = { ...check("screen_config"), status: "PRIVATE_BAD_STATUS" } as unknown as FingerprintReport["checks"][number];
  const summary = buildInspectionDiagnosticSummary(report([unknownStatus, check("locale_config", "unknown")], "PRIVATE_DATE"), { reviewedAt: Number.NaN, proxyStatus: "PRIVATE_IP" as "working", configurationChanged: true });
  expect(summary).toContain("Recognized checks: 1"); expect(summary).toContain("Explicit proxy check: Not checked"); expect(summary).toContain("Configuration changed during this inspection"); expect(summary).not.toContain("PRIVATE");
});

test("the inspection conclusion requires sample evidence and never promotes unknowns or aggregate pass counts", () => {
  const onlyConfiguration = report([check("identity_seed")], "2026-11-09T10:00:00Z");
  expect(inspectionOverview(onlyConfiguration)).toMatchObject({ headline: "More evidence is needed", tone: "unknown", next: "browser", counts: { pass: 1, warn: 0, fail: 0, unknown: 0 } });
  const linked = ["browser_sample", "capture_source", "runtime_config", "sample_coverage", "sample_freshness"].map(id => check(id));
  const measured = report(linked, "2026-11-09T10:00:00Z");
  expect(inspectionOverview(measured)).toMatchObject({ tone: "consistent", headline: "Stored checks have no reported issues" });
  expect(inspectionOverview(report([...linked, check("screen_measurement", "unknown")], measured.measuredAt))).toMatchObject({ tone: "unknown", next: "findings" });
  expect(inspectionOverview(measured, { configurationChanged: true })).toMatchObject({ tone: "unknown", next: "browser" });
  expect(inspectionOverview(null)).toMatchObject({ headline: "Saved review unavailable", tone: "unknown", next: "review" });
});

test("network observations stay independent of fingerprint counts and drive the next step only with their own evidence", () => {
  const linked = ["browser_sample", "capture_source", "runtime_config", "sample_coverage", "sample_freshness"].map(id => check(id));
  const measured = report(linked, "2026-11-09T10:00:00Z");
  expect(inspectionOverview(measured, { proxyConfigured: true })).toMatchObject({ tone: "unknown", next: "network" });
  expect(inspectionOverview(measured, { proxyConfigured: true, proxyStatus: "failed" })).toMatchObject({ headline: "Review the network connection first", tone: "issue", next: "network", counts: { pass: 5, fail: 0 } });
  expect(inspectionOverview(measured, { proxyConfigured: true, proxyStatus: "unavailable" })).toMatchObject({ tone: "unknown", next: "network" });
  expect(inspectionOverview(measured, { proxyConfigured: true, proxyStatus: "working" })).toMatchObject({ headline: "Stored checks have no reported issues", counts: { pass: 5, fail: 0 } });
  expect(inspectionOverview(report([...linked, check("screen_config", "fail")], measured.measuredAt), { proxyStatus: "working" })).toMatchObject({ tone: "issue", next: "findings", counts: { pass: 5, fail: 1 } });
});
