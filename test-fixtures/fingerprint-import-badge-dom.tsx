import assert from "node:assert/strict";
import { buildFingerprintImportComparison } from "../src/fingerprint-import-comparison.ts";
import { FingerprintImportBadge } from "../web/fingerprint-import-badge.tsx";
import { I18nProvider, translate } from "../web/i18n.tsx";
import { catalogs } from "../web/locales/registry.ts";
import { createWebDomHarness } from "./web-dom.ts";

async function run(language: string) {
  const requests: string[] = [];
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input)); assert.equal(input, "/ui/api/shell-language", "A historical badge must not fetch or measure fingerprints");
    return Response.json({ language });
  }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
  const dom = await createWebDomHarness({ fetch: fixtureFetch });
  dom.window.localStorage.setItem("aliasmode.shell.language", language);
  const t = (key: string, values?: Record<string, string | number>) => translate(catalogs, language, key, values);
  const legacy = { verdict: "match" as const, differences: [{ field: "PRIVATE_FIELD", expected: "PRIVATE_EXPECTED", observed: "PRIVATE_OBSERVED" }] };
  try {
    for (const [state, label, summary] of [
      ["match", "Stored import match", buildFingerprintImportComparison({ canvas: "PRIVATE" }, { canvas: "PRIVATE", capturedAt: "2026-11-09T10:00:00Z" })],
      ["incomplete", "Import not fully compared", buildFingerprintImportComparison({ canvas: "PRIVATE", audio: "PRIVATE" }, { canvas: "PRIVATE" })],
      ["differences", "Import differences", buildFingerprintImportComparison({ canvas: "PRIVATE_WANT", audio: "PRIVATE" }, { canvas: "PRIVATE_GOT" })],
      ["legacy", "Import comparison", undefined],
    ] as const) {
      await dom.render(<I18nProvider><FingerprintImportBadge p={{ fpImportComparison: summary, fpVerdict: legacy }} /></I18nProvider>);
      const badge = dom.container.querySelector("span")!;
      assert.ok(badge); assert.equal(badge.textContent, t(label)); assert.equal(badge.getAttribute("data-import-comparison"), state);
      assert.ok(badge.title.includes(t("Historical comparison of stored imported expectations and saved measurements. Does not verify the current configuration, current process, or anonymity.")));
      if (state === "incomplete" || state === "differences") assert.ok(badge.title.includes(t("Unmeasured fields: {fields}.", { fields: t("Audio") })));
      if (state === "differences") assert.ok(badge.title.includes(t("Different fields: {fields}.", { fields: t("Canvas") })));
      if (state === "legacy") assert.ok(!badge.title.includes(t("Measured: {time}.", { time: "" })));
      assert.ok(!dom.container.innerHTML.includes("PRIVATE")); assert.ok(!dom.container.innerHTML.includes("verified"));
      assert.ok(!dom.container.innerHTML.includes("identity changed"));
      if (language === "zh-CN") assert.ok(/[\u3400-\u9fff]/.test(badge.textContent ?? ""), "Chinese history labels must be localized");
    }
    await dom.render(<I18nProvider><FingerprintImportBadge p={{ fpImportComparison: null, fpVerdict: legacy }} /></I18nProvider>);
    assert.equal(dom.container.querySelector("span"), null);
    assert.deepEqual(requests, ["/ui/api/shell-language"]);
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "en-US"); console.log("historical import badge fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
