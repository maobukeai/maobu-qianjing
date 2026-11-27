import { expect, test } from "bun:test";
import { isFingerprintCheckEvidence, isFingerprintCheckMessage, presentFingerprintCheck, projectFingerprintEvidence, renderFingerprintMessage } from "../src/fingerprint-check-presentation.ts";
import { translate } from "../web/i18n.tsx";
import enUS from "../web/locales/en-US.json";
import zhCN from "../web/locales/zh-CN.json";

test("legacy reports retain their status and canonical English falls back without a second catalog", () => {
  const check = { id: "runtime_config", status: "unknown" as const, label: "Runtime configuration", detail: "The applied configuration is unknown.", recommendation: "Measure the running browser." };
  expect(presentFingerprintCheck(check)).toEqual({ ...check, evidenceRows: [] });
  expect(presentFingerprintCheck(check, source => ({ "Runtime configuration": "运行配置", "The applied configuration is unknown.": "尚未确认生效配置。" } as Record<string, string>)[source] ?? source, "zh-CN")).toMatchObject({ label: "运行配置", detail: "尚未确认生效配置。", status: "unknown" });
});

test("dynamic descriptions translate a stable template and named surfaces before interpolation", () => {
  const dictionary: Record<string, string> = { "Probes reporting errors: {count}.": "报告错误的探测：{count} 项。", "Not measured: {surfaces}.": "尚未测量：{surfaces}。", "Processor count": "处理器数量", Timezone: "时区" };
  const t = (key: string, values?: Record<string, string | number>) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
  expect(renderFingerprintMessage({ kind: "probe-errors", count: 3 }, t)).toBe("报告错误的探测：3 项。");
  const text = renderFingerprintMessage({ kind: "missing-surfaces", surfaces: ["hardwareConcurrency", "timezone"] }, t, "zh-CN");
  expect(text).toContain("处理器数量"); expect(text).toContain("时区"); expect(text).not.toContain("hardwareConcurrency");
  expect(isFingerprintCheckMessage({ kind: "probe-errors", count: "PRIVATE_ERROR" })).toBe(false);
  expect(isFingerprintCheckMessage({ kind: "missing-surfaces", surfaces: ["PRIVATE_ERROR"] })).toBe(false);
});

test("processor evidence distinguishes saved preference, host policy and observation without changing verdicts", () => {
  const evidence = projectFingerprintEvidence({ kind: "processors", expected: 8, actual: 32, saved: 32, hostAvailable: 8 });
  expect(isFingerprintCheckEvidence(evidence)).toBe(true);
  const view = presentFingerprintCheck({ id: "hardware_configuration", label: "Processor configuration", status: "warn", detail: "A saved change is pending.", evidence: evidence! });
  expect(view.status).toBe("warn"); expect(view.evidenceRows.map(row => row.value)).toEqual(["8", "32", "32", "8"]);
  expect(projectFingerprintEvidence({ kind: "processors", expected: 8, actual: "32", saved: 32, hostAvailable: 8 })).toMatchObject({ actual: null });
});

test("locale evidence strips private extensions and marks projections that may hide the differing subtag", () => {
  const evidence = projectFingerprintEvidence({ kind: "locale", expected: "en-US-u-ca-gregory", actual: "en-US-x-PRIVATE-device" });
  expect(evidence).toEqual({ kind: "locale", expected: "en-US", actual: "en-US", detailsOmitted: true });
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE"); expect(isFingerprintCheckEvidence(evidence)).toBe(true);
  expect(isFingerprintCheckEvidence({ kind: "locale", expected: "en-US-x-secret", actual: "en-US" })).toBe(false);
  const view = presentFingerprintCheck({ id: "locale_configuration", label: "Language configuration", status: "fail", detail: "The configured language differs.", evidence: evidence! });
  expect(view.status).toBe("fail"); expect(view.evidenceNote).toContain("extensions and variants");
});

test("a configuration-only language check never claims the observed language is unavailable", () => {
  const evidence = projectFingerprintEvidence({ kind: "locale-config", configured: "en-US-u-ca-gregory" });
  expect(evidence).toEqual({ kind: "locale-config", configured: "en-US", detailsOmitted: true });
  expect(isFingerprintCheckEvidence(evidence)).toBe(true);
  const view = presentFingerprintCheck({ id: "locale_config", label: "Language configuration", status: "pass", detail: "A valid language tag is saved.", evidence: evidence! });
  expect(view.evidenceRows).toEqual([{ label: "Configured language", value: "en-US" }]);
  expect(JSON.stringify(view.evidenceRows)).not.toContain("Observed");
});

test("arbitrary strings, raw samples and private error fields cannot pass the evidence boundary", () => {
  const raw = { kind: "platform", expected: "windows", actual: "linux" };
  Object.defineProperty(raw, "password", { enumerable: true, get() { throw new Error("must not read unrelated private fields"); } });
  expect(projectFingerprintEvidence(raw)).toBe(null);
  expect(projectFingerprintEvidence({ kind: "platform", expected: "Win32 PRIVATE", actual: "https://user:secret@host" })).toEqual({ kind: "platform", expected: null, actual: null });
  expect(projectFingerprintEvidence({ kind: "timezone", expected: "UTC", actual: "https://user:secret@host" })).toEqual({ kind: "timezone", expected: "UTC", actual: null });
  expect(projectFingerprintEvidence({ kind: "screen", expected: { width: 1920, height: 1080 }, actual: { width: 1920, height: 1080, raw: "PRIVATE" } })).toMatchObject({ actual: null });
  expect(isFingerprintCheckEvidence({ kind: "processors", expected: 8, actual: "PRIVATE", saved: 8, hostAvailable: 8 })).toBe(false);
});

test("the bundled Chinese catalog localizes real report text, counts and evidence labels", () => {
  const tables = { "en-US": enUS as Record<string, string>, "zh-CN": zhCN as Record<string, string> };
  const t = (source: string, values?: Record<string, string | number>) => translate(tables, "zh-CN", source, values);
  const check = { id: "hardware_configuration", label: "Measured processors and configuration", status: "warn" as const, detail: "The measured processor count differs from the effective launch policy.", evidence: { kind: "processors" as const, expected: 8, actual: 32, saved: 32, hostAvailable: 8 } };
  const view = presentFingerprintCheck(check, t, "zh-CN");
  expect(view.label).toBe("实测处理器与配置"); expect(view.detail).toContain("实测处理器数量");
  expect(view.evidenceRows[0]).toEqual({ label: "按启动策略预期", value: "8" });
  expect(renderFingerprintMessage({ kind: "probe-errors", count: 2 }, t)).toBe("2 项探测报告了错误。");
  const otherLanguage = (source: string, values?: Record<string, string | number>) => translate(tables, "xx-YY", source, values);
  expect(presentFingerprintCheck(check, otherLanguage).label).toBe("Measured processors and configuration");
});
