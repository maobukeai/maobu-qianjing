import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import zhCN from "../web/locales/zh-CN.json";
import { FeatureSettingsPanel } from "../web/settings-center.tsx";
import type { FingerprintReport } from "../web/settings-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
function report(profileId: string, revision: number): FingerprintReport {
  return { profileId, name: `Inert ${profileId}`, running: true, status: "review", summary: { pass: 1, warn: 1, fail: 0, unknown: 0 }, checks: [
    { id: "engine_identity", label: "Engine identity", status: "pass", detail: "The saved identity type matches the selected engine." },
    { id: "sample_freshness", label: "Measurement time", status: "warn", detail: `${profileId} revision ${revision}` },
  ] };
}
async function run(scenario: string) {
  const language = scenario.endsWith("-zh") ? "zh-CN" : "en-US";
  const t = (source: string) => language === "zh-CN" ? (zhCN as Record<string, string>)[source] ?? source : source;
  const reads: Array<ReturnType<typeof deferred<Response>>> = [], measurements: Array<{ path: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const requests: Array<{ path: string; method: string }> = [], edits: string[] = [];
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language });
    requests.push({ path, method });
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    if (path === "/ui/api/settings/fingerprints" && method === "GET") { const response = deferred<Response>(); reads.push(response); return response.promise; }
    if (path === "/ui/api/settings/fingerprints/profile_b/measure" && method === "POST") { const response = deferred<Response>(); measurements.push({ path, response }); return response.promise; }
    throw new Error(`Blocked unexpected fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });
  dom.window.localStorage.setItem("aliasmode.shell.language", language);
  const onEditProfile = (id: string) => { edits.push(id); };
  const render = (version = 0) => dom.render(<I18nProvider><FeatureSettingsPanel tab="fingerprints" onEditProfile={onEditProfile} fingerprintRefreshVersion={version} /></I18nProvider>);
  const button = (source: string) => { const value = Array.from(dom.container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === t(source)); assert.ok(value, `Missing ${source}`); return value; };
  const select = () => { const value = dom.container.querySelector<HTMLSelectElement>("select"); assert.ok(value); return value; };
  const filter = () => { const value = dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(value); return value; };
  const choose = (id: string) => act(async () => { const value = select(); value.value = id; value.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const reply = (index: number, reports: FingerprintReport[]) => act(async () => { assert.ok(reads[index]); reads[index]!.resolve(Response.json({ ok: true, reports })); });
  const loaded = async () => { await reply(0, [report("profile_a", 1), report("profile_b", 1)]); assert.equal(select().value, "profile_a", "The first successful load must fix the default selection"); await choose("profile_b"); await act(async () => { filter().click(); }); };
  const assertSelection = (id: string, revision: number) => {
    assert.equal(select().value, id); assert.equal(filter().checked, true);
    assert.equal(dom.container.querySelector(".quality-mark.pass"), null); assert.equal(dom.container.querySelectorAll(".quality-check").length, 1);
    assert.ok(dom.container.textContent?.includes(`${id} revision ${revision}`));
  };
  try {
    await render(); assert.equal(reads.length, 1); await loaded();
    if (scenario.startsWith("edit-refresh")) {
      const edit = button("Edit profile configuration");
      assert.equal(edit.getAttribute("aria-label"), t("Edit {profile}").replace("{profile}", "Inert profile_b"));
      await act(async () => { edit.click(); }); assert.deepEqual(edits, ["profile_b"]); assert.equal(reads.length, 1); assert.equal(measurements.length, 0);
      // Rerendering without a saved configuration change models closing the
      // parent editor without saving: it must not trigger any additional read.
      await render(0); assert.equal(reads.length, 1); assertSelection("profile_b", 1);
      await render(1); assert.equal(reads.length, 2); assert.equal(button("Edit profile configuration").disabled, true); assert.equal(select().disabled, true);
      await reply(1, [report("profile_a", 2), report("profile_b", 2)]); assertSelection("profile_b", 2);
      assert.equal(button("Edit profile configuration"), edit, "A refreshed review must retain its action node for focus restoration");
      await act(async () => { edit.click(); }); assert.deepEqual(edits, ["profile_b", "profile_b"]);
      await render(1); assert.equal(reads.length, 2, "The same version must not repeatedly fetch reports");
    } else if (scenario.startsWith("old-read")) {
      const review = button("Run review"); await act(async () => { review.click(); review.click(); }); assert.equal(reads.length, 2, "A queued double click must share the current review");
      await render(1); assert.equal(reads.length, 3, "A saved version must start a newer GET while the earlier GET is still pending");
      await reply(2, [report("profile_a", 3), report("profile_b", 3)]); assertSelection("profile_b", 3);
      if (scenario === "old-read-error") await act(async () => { reads[1]!.resolve(Response.json({ ok: false, error: "Inert outdated review error" }, { status: 503 })); });
      else await reply(1, [report("profile_a", 0)]);
      assertSelection("profile_b", 3); assert.equal(dom.container.querySelector('[role="alert"]'), null); assert.equal(button("Edit profile configuration").disabled, false);
    } else if (scenario === "removed-selected") {
      await render(1); await reply(1, [report("profile_a", 2)]);
      assert.equal(select().value, "profile_b"); assert.equal(select().selectedOptions[0]?.textContent, t("Selected profile unavailable"));
      assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes(t("The selected profile is no longer available. Refresh the review or choose another profile.")));
      assert.equal(button("Edit profile configuration").disabled, true); await act(async () => { button("Edit profile configuration").click(); }); assert.deepEqual(edits, []);
      assert.equal(dom.container.querySelectorAll(".quality-check").length, 0, "The removed selection must not silently show the first profile's report");
      await choose("profile_a"); assertSelection("profile_a", 2); assert.equal(dom.container.querySelector('[role="alert"]'), null);
      await act(async () => { button("Edit profile configuration").click(); }); assert.deepEqual(edits, ["profile_a"]); assert.equal(reads.length, 2, "Choosing a remaining profile must not refetch the catalog");
    } else if (scenario === "all-removed") {
      await render(1); await reply(1, []);
      assert.equal(select().value, "profile_b"); assert.equal(button("Edit profile configuration").disabled, true); assert.equal(button("Run review").disabled, false);
      await act(async () => { button("Run review").click(); }); await reply(2, [report("profile_a", 2), report("profile_b", 2)]);
      assertSelection("profile_b", 2); await act(async () => { button("Edit profile configuration").click(); }); assert.deepEqual(edits, ["profile_b"]);
    } else if (scenario === "measurement") {
      const measure = button("Measure running browser"), edit = button("Edit profile configuration"), review = button("Run review");
      await act(async () => { measure.click(); measure.click(); edit.click(); review.click(); });
      assert.equal(measurements.length, 1); assert.equal(reads.length, 1); assert.deepEqual(edits, []);
      assert.equal(edit.disabled, true); assert.equal(select().disabled, true);
      await act(async () => { measurements[0]!.response.resolve(Response.json({ ok: true, report: report("profile_b", 2) })); });
      assertSelection("profile_b", 2); assert.equal(edit.disabled, false); await act(async () => { edit.click(); }); assert.deepEqual(edits, ["profile_b"]);
    } else if (scenario === "unmount") {
      await act(async () => { button("Run review").click(); });
      await dom.render(<I18nProvider><p>Inert other panel</p></I18nProvider>); await render(0); assert.equal(reads.length, 3);
      await reply(2, [report("profile_a", 3)]);
      await act(async () => { reads[1]!.resolve(Response.json({ ok: false, error: "Inert unmounted request error" }, { status: 503 })); });
      assert.equal(select().value, "profile_a"); assert.equal(filter().checked, false); assert.equal(dom.container.querySelector('[role="alert"]'), null);
    } else throw new Error(`Unknown fixture scenario: ${scenario}`);
    assert.ok(requests.every(request => request.path === "/ui/api/settings/fingerprints" && request.method === "GET" || scenario === "measurement" && request.path.endsWith("/profile_b/measure") && request.method === "POST"), "The component must only read offline reports or execute the explicitly requested synthetic measurement");
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "edit-refresh-en"); console.log("fingerprint action interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
