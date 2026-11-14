import { expect, test } from "bun:test";
import type { PresentableFingerprintCheck } from "../fingerprint-check-presentation.ts";
import { buildFingerprintAssistantBrief } from "./fingerprint-assistant-brief.ts";
import { translate } from "./i18n.tsx";
import zhCN from "./locales/zh-CN.json";

const tables = { "en-US": {}, "zh-CN": zhCN as Record<string, string> };
const english = (source: string, values?: Record<string, string | number>) => translate(tables, "en-US", source, values);
const chinese = (source: string, values?: Record<string, string | number>) => translate(tables, "zh-CN", source, values);
const check = (id: string, status: PresentableFingerprintCheck["status"]): PresentableFingerprintCheck => ({
  id, status, label: "PRIVATE_LABEL", detail: "PRIVATE_DETAIL", recommendation: "PRIVATE_RECOMMENDATION",
});

test("the brief reads only allowlisted IDs and statuses and computes its own counts", () => {
  const neverRead = () => { throw new Error("Private report fields must not be read"); };
  const hardware = check("hardware_configuration", "fail");
  Object.defineProperties(hardware, {
    label: { get: neverRead }, detail: { get: neverRead }, recommendation: { get: neverRead },
    evidence: { get: neverRead }, detailMessage: { get: neverRead },
  });
  const report = { checks: [hardware, check("proxy_config", "unknown"), check("identity_seed", "pass"),
    check("PRIVATE_UNKNOWN_ID", "fail"), check("constructor", "fail"), check("screen_config", "__proto__" as never)] };
  for (const field of ["name", "profileId", "summary", "measuredAt", "running"]) Object.defineProperty(report, field, { get: neverRead });
  const brief = buildFingerprintAssistantBrief(report, english);
  expect(brief).toContain("Passed 1 · Review 0 · Issues 1 · Unknown 1");
  expect(brief).toContain("Measured processors and configuration · fail");
  expect(brief).toContain("Network route configuration · unknown");
  expect(brief).not.toContain("PRIVATE");
  expect(brief).not.toContain("constructor");
  expect(brief).toContain("Leave current process state and anonymity unconfirmed.");
});

test("the brief shows at most twelve non-passing findings and puts issues before unknowns", () => {
  const unknown = ["identity_seed", "screen_config", "timezone_config", "locale_config", "desktop_persona", "engine_identity", "proxy_config",
    "runtime_config", "browser_sample", "capture_source", "sample_coverage", "measured_persona", "sample_freshness"];
  const brief = buildFingerprintAssistantBrief({ checks: [
    ...unknown.map(id => check(id, "unknown")), check("import_attestation", "fail"), check("sample_errors", "warn"), check("identity_seed", "unknown"),
  ] }, english);
  const lines = brief.split("\n").filter(line => line.startsWith("- "));
  expect(lines).toHaveLength(12);
  expect(lines.slice(0, 2)).toEqual(["- Imported identity check · fail", "- Measurement completeness · warn"]);
  expect(brief).toContain("Passed 0 · Review 1 · Issues 1 · Unknown 13");
  expect(brief).toContain("Additional checks needing attention · 3");
});

test("the brief translates fixed labels and distinguishes unavailable checks from a passed summary", () => {
  const brief = buildFingerprintAssistantBrief({ checks: [check("timezone_measurement", "warn")] }, chinese);
  expect(brief).toContain("实测时区与配置 · 建议检查");
  expect(brief).not.toContain("PRIVATE");
  expect(new TextEncoder().encode(brief).length).toBeLessThan(8192);
  expect(buildFingerprintAssistantBrief({ checks: [check("unrecognized", "pass")] }, english)).toContain("No recognized checks are available in this summary.");
});
