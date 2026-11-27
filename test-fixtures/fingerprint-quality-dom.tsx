import assert from "node:assert/strict";
import { I18nProvider } from "../web/i18n.tsx";
import { FeatureSettingsPanel } from "../web/settings-center.tsx";
import { assessFingerprintQuality } from "../src/fingerprint-quality.ts";
import { createFingerprintSource } from "../src/fingerprint-source.ts";
import type { Profile } from "../src/types.ts";
import type { HTMLInputElement } from "happy-dom";
import { act } from "react";
import { createWebDomHarness } from "./web-dom.ts";

async function run(language: string, allPass = false) {
  const now = Date.parse("2026-11-09T10:00:00Z");
  const profile: Profile = {
    id: "inert_profile", name: "Inert evidence fixture", group: "", accId: "", username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", twofa: "PRIVATE_2FA", proxy: null,
    engine: "chromium", chromiumRuntime: "aliasmode", ua: "", hardware: { cores: 32 }, locale: "en-US-u-ca-gregory", timezone: "UTC", platformOs: "windows", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 777, cookies: [], seeded: false,
    fpObserved: { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/155 PRIVATE_UA", platform: "Win32", uaChPlatform: "Windows", hardwareConcurrency: 32, language: "en-US-x-PRIVATE-device", languages: "en-US-x-PRIVATE-device,en", timezone: "UTC", screen: "1920*1080", canvas: "PRIVATE_CANVAS", audio: "PRIVATE_AUDIO", webglVendor: "PRIVATE_VENDOR", webglRenderer: "PRIVATE_RENDERER", capturedAt: new Date(now).toISOString(), errors: '{"canvas":"PRIVATE_ERROR"}' },
  };
  if (allPass) {
    profile.proxy = { type: "socks5", host: "127.0.0.1", port: "1080", user: "", pass: "" };
    profile.hardware = { cores: 8 }; profile.locale = "en-US";
    profile.fpObserved = { ...profile.fpObserved, hardwareConcurrency: 8, language: "en-US", languages: "en-US,en", errors: undefined };
  }
  const launch = { profileId: profile.id, pid: 123, debugPort: 9222, ws: "ws://inert-fixture", startedAt: now - 1000 };
  const report = { name: profile.name, running: false, ...assessFingerprintQuality(profile, { now, launchState: "current", hostCores: 8, ...(allPass ? { launch, captureSource: createFingerprintSource(profile, launch) } : {}) }) };
  if (allPass) assert.ok(report.checks.every(check => check.status === "pass"));
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  const requests: string[] = [];
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input); requests.push(path); assert.equal(options?.method ?? "GET", "GET");
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language });
    assert.equal(path, "/ui/api/settings/fingerprints");
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    return Response.json({ ok: true, reports: [report] });
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch });
  dom.window.localStorage.setItem("aliasmode.shell.language", language);
  try {
    await dom.render(<I18nProvider><FeatureSettingsPanel tab="fingerprints" /></I18nProvider>);
    const checks = Array.from(dom.container.querySelectorAll(".quality-check"));
    assert.equal(checks.length, report.checks.length);
    const title = language === "zh-CN" ? "实测处理器与配置" : "Measured processors and configuration";
    const processors = checks.find(check => check.querySelector("strong")?.textContent === title);
    assert.ok(processors); assert.ok(processors.querySelector(allPass ? ".quality-mark.pass" : ".quality-mark.fail"));
    assert.deepEqual(Array.from(processors.querySelectorAll("dd")).map(item => item.textContent), allPass ? ["8", "8", "8", "8"] : ["8", "32", "32", "8"]);
    assert.equal(processors.querySelector("dt")?.textContent, language === "zh-CN" ? "按启动策略预期" : "Expected by launch policy");
    const configuredLanguage = checks.find(check => check.querySelector("strong")?.textContent === (language === "zh-CN" ? "语言配置" : "Language configuration"));
    assert.ok(configuredLanguage);
    assert.deepEqual(Array.from(configuredLanguage.querySelectorAll("dd")).map(item => item.textContent), ["en-US"], "A format check must show only the configured language, not a missing observation");
    const measuredLanguage = checks.find(check => check.querySelector("strong")?.textContent === (language === "zh-CN" ? "实测语言与配置" : "Measured language and configuration"));
    assert.ok(measuredLanguage); assert.deepEqual(Array.from(measuredLanguage.querySelectorAll("dd")).map(item => item.textContent), ["en-US", "en-US"]);
    const text = dom.container.textContent ?? "";
    assert.ok(!text.includes("PRIVATE"));
    if (!allPass) {
      assert.ok(text.includes(language === "zh-CN" ? "1 项探测报告了错误。" : "Probes reporting errors: 1."));
      assert.ok(text.includes(language === "zh-CN" ? "此证据省略了语言扩展和变体。" : "Locale extensions and variants are omitted from this evidence."));
    }
    if (language === "en-US") assert.ok(checks.every(check => !/[\u3400-\u9fff]/.test(check.textContent ?? "")));
    const measure = Array.from(dom.container.querySelectorAll("button")).find(item => item.textContent === (language === "zh-CN" ? "测量运行中的浏览器" : "Measure running browser"));
    assert.ok(measure?.disabled, "Displaying evidence must not start a browser or enable measurement without a running browser");
    const filter = dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(filter); assert.equal(filter.checked, false);
    const originalTitles = checks.map(check => check.querySelector("strong")?.textContent);
    const originalSummary = dom.container.querySelector(".quality-overview")?.textContent;
    const originalRequests = requests.length;
    await act(async () => { filter.click(); });
    const attention = report.checks.filter(check => check.status !== "pass");
    const visible = Array.from(dom.container.querySelectorAll(".quality-check"));
    assert.equal(visible.length, attention.length); assert.equal(dom.container.querySelector(".quality-mark.pass"), null);
    assert.ok((dom.container.textContent ?? "").includes(language === "zh-CN" ? `显示 ${attention.length} / ${checks.length} 项检查` : `Showing ${attention.length} of ${checks.length} checks`));
    assert.equal(dom.container.querySelector(".quality-overview")?.textContent, originalSummary);
    assert.equal(requests.length, originalRequests, "Filtering must not re-fetch or measure a browser");
    if (allPass) assert.ok((dom.container.textContent ?? "").includes(language === "zh-CN" ? "此已保存报告中暂无需要关注的项目。" : "No items need attention in this stored report."));
    else { assert.ok(dom.container.querySelector(".quality-mark.warn")); assert.ok(dom.container.querySelector(".quality-mark.unknown")); }
    await act(async () => { filter.click(); });
    assert.deepEqual(Array.from(dom.container.querySelectorAll(".quality-check strong")).map(check => check.textContent), originalTitles, "Clearing the filter must restore all original rows and ordering");
    assert.equal(requests.length, originalRequests);
    assert.deepEqual(requests.sort(), ["/ui/api/settings/fingerprints", "/ui/api/shell-language"].sort());
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "en-US", process.argv[3] === "all-pass"); console.log("localized fingerprint evidence fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
