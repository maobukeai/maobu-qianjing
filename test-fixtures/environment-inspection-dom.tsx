import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLDetailsElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { EnvironmentInspectionPage } from "../web/environment-inspection.tsx";
import type { UiProfile } from "../web/api.ts";
import type { FingerprintReport } from "../web/settings-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
function profile(id: string, overrides: Partial<UiProfile> = {}): UiProfile {
  return { id, name: `Environment ${id}`, engine: "chromium", group: "", platform: "", tags: [], proxy: "configured", timezone: "UTC", cookieCount: 0, seeded: false, screen: "1920*1080", has2fa: false, running: true, ...overrides };
}
function report(id: string, revision = 1): FingerprintReport {
  return { profileId: id, name: `Environment ${id}`, running: true, status: "review", summary: { pass: 1, warn: 1, fail: 0, unknown: 0 }, checks: [
    { id: "engine_identity", label: "Engine identity", status: "pass", detail: "The saved identity type matches the selected engine." },
    { id: "sample_freshness", label: "Measurement time", status: "warn", detail: `${id} review ${revision}`, recommendation: "Reopen the profile before measuring again." },
  ], ...(revision > 1 ? { measuredAt: "2026-11-09T10:00:00.000Z" } : {}) };
}
function richReport(id: string): FingerprintReport {
  return { profileId: id, name: `Environment ${id}`, running: true, status: "issues", summary: { pass: 99, warn: 3, fail: 2, unknown: 2 }, checks: [
    { id: "identity_seed", label: "Fixed identity seed", status: "pass", detail: "The saved identity seed is stable." },
    { id: "browser_sample", label: "Browser measurement", status: "unknown", detail: "No usable browser fingerprint measurement is available." },
    { id: "screen_config", label: "Screen configuration", status: "fail", detail: "The saved screen is invalid.", recommendation: "Choose a supported screen in the profile editor." },
    { id: "capture_source", label: "Measurement source and current identity", status: "warn", detail: "The sample belongs to an earlier launch." },
    { id: "hardware_configuration", label: "Measured processors and configuration", status: "fail", detail: "The measured processor count differs.", evidence: { kind: "processors", expected: 8, actual: 2, saved: 8, hostAvailable: 16 } },
    { id: "new_custom_probe", label: "New engine observation", status: "warn", detail: "A newer observation needs review." },
    { id: "locale_configuration", label: "Measured language and configuration", status: "warn", detail: "The measured preferred language differs.", evidence: { kind: "locale", expected: "en-US", actual: "zh-CN" } },
    { id: "sample_freshness", label: "Measurement time", status: "unknown", detail: "The capture time is unavailable." },
  ] };
}
async function run(scenario: string) {
  const reads: Array<ReturnType<typeof deferred<Response>>> = [];
  const probes: Array<{ body: any; response: ReturnType<typeof deferred<Response>> }> = [];
  const measurements: Array<ReturnType<typeof deferred<Response>>> = [];
  const paths: string[] = [], edits: string[] = [], explanations: FingerprintReport[] = [];
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    paths.push(path);
    if (path === "/ui/api/settings/fingerprints") { const value = deferred<Response>(); reads.push(value); return value.promise; }
    if (path === "/ui/api/profiles/a" || path === "/ui/api/profiles/b") return Response.json({ ok: true, profile: { id: path.endsWith("/a") ? "a" : "b", proxyType: "socks5", proxy: "proxy.test:1080:PRIVATE_USER:PRIVATE_PASSWORD", username: "PRIVATE_ACCOUNT", password: "PRIVATE_ACCOUNT_PASSWORD" } });
    if (path === "/ui/api/proxy/check") { const response = deferred<Response>(); probes.push({ body: JSON.parse(String(options?.body)), response }); return response.promise; }
    if (path === "/ui/api/settings/fingerprints/a/measure") { const value = deferred<Response>(); measurements.push(value); return value.promise; }
    throw new Error(`Unexpected fixture request: ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });
  let current = profile("a", scenario === "direct" ? { proxy: null } : {}), active = true, version = 0;
  const render = () => dom.render(<I18nProvider><EnvironmentInspectionPage active={active} profile={current} refreshVersion={version} onBack={() => {}} onEditProfile={id => { edits.push(id); }} onExplainFingerprint={value => { explanations.push(value); }} /></I18nProvider>);
  const button = (text: string) => { const value = Array.from(dom.container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === text); assert.ok(value, `Missing button ${text}`); return value; };
  const click = (text: string) => act(async () => { button(text).click(); });
  const read = (index: number, values = [report(current.id)]) => act(async () => { reads[index]!.resolve(Response.json({ ok: true, reports: values })); });
  const replyProxy = (index = 0, ip = "203.0.113.44") => act(async () => { probes[index]!.response.resolve(Response.json({ ok: true, status: "working", attempts: 2, successes: 2, ip, country: "Test country", exitComparison: "same" })); });
  const text = () => dom.container.textContent ?? "";
  const writes: string[] = [], clipboard = deferred<void>();
  const clipboardBefore = Object.getOwnPropertyDescriptor(dom.window.navigator, "clipboard");
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value); if (scenario === "clipboard-unavailable") throw new Error("PRIVATE_CLIPBOARD_FAILURE"); if (scenario === "copy-lifecycle") await clipboard.promise; } } });
  const setSearch = async (value: string) => act(async () => { const input = dom.container.querySelector<HTMLInputElement>('.inspection-search input')!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const chooseSource = async (value: string) => act(async () => { const select = dom.container.querySelector<HTMLSelectElement>('.inspection-source-filter select')!; select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const ids = () => [...dom.container.querySelectorAll(".inspection-check")].map(node => node.getAttribute("data-check-id"));
  try {
    await render(); assert.equal(reads.length, 1); assert.deepEqual(paths, ["/ui/api/settings/fingerprints"]);
    assert.equal(dom.window.document.activeElement?.id, "inspection-page-title");
    const enhanced = ["source-filters", "safe-copy", "clipboard-unavailable", "copy-lifecycle"].includes(scenario);
    let initial = enhanced ? richReport(current.id) : report(current.id);
    if (scenario === "safe-copy") {
      initial = { ...initial, name: "PRIVATE_ACCOUNT_NAME", measuredAt: "2026-11-09T10:00:00.000Z", checks: [...initial.checks, { id: "timezone_measurement", label: "PRIVATE_COOKIE_VALUE", status: "warn", detail: "http://user:PRIVATE_PROXY_PASS@proxy.invalid 203.0.113.44", recommendation: "PRIVATE_COOKIE_VALUE", evidence: { kind: "timezone", expected: "UTC", actual: "Europe/London" } }] };
    }
    if (scenario === "no-measurement-claim") initial = { ...initial, status: "consistent", summary: { pass: 500, warn: 0, fail: 0, unknown: 0 }, measuredAt: "2026-11-09T10:00:00.000Z", checks: [{ id: "identity_seed", label: "Fixed identity seed", status: "pass", detail: "The saved identity seed is stable." }] };
    if (scenario === "overview-time-and-actions") initial = { ...initial, status: "consistent", measuredAt: "2026-11-09T10:00:00.000Z", checks: ["browser_sample", "capture_source", "runtime_config", "sample_coverage", "sample_freshness"].map(id => ({ id, label: id, detail: "Stored historical evidence", status: "pass" })) };
    if (scenario === "overview-browser-action") initial = { ...initial, status: "consistent", checks: [{ id: "identity_seed", label: "Fixed identity seed", status: "pass", detail: "The saved seed is stable." }] };
    await read(0, [initial]);
    if (scenario === "explicit-network") {
      await act(async () => { button("Check saved proxy").click(); button("Check saved proxy").click(); });
      assert.equal(probes.length, 1, "A synchronous second click must not issue a second external check");
      assert.deepEqual(probes[0]!.body, { proxy: { type: "socks5", host: "proxy.test", port: "1080", user: "PRIVATE_USER", pass: "PRIVATE_PASSWORD" } });
      assert.ok(!text().includes("PRIVATE"));
      await replyProxy();
      assert.ok(text().includes("203.0.113.44"));
      assert.ok(text().includes("a separate exit is not confirmed"), "A reachable same-exit proxy must not be promoted to a separate exit");
      await click("Draft AI explanation"); assert.equal(explanations[0]?.profileId, "a"); assert.ok(!JSON.stringify(explanations).includes("PRIVATE"));
      await click("Edit profile configuration"); assert.deepEqual(edits, ["a"]);
      active = false; await render(); active = true; await render(); await read(1);
      assert.ok(text().includes("203.0.113.44"), "Returning from AI must preserve the current route observation");
    } else if (scenario === "direct") {
      assert.equal(button("Check saved proxy").disabled, true);
      await click("Check saved proxy"); assert.equal(probes.length, 0);
      assert.ok(text().includes("A direct connection is not a verified proxy exit"));
      assert.ok(paths.every(path => !path.startsWith("/ui/api/profiles/")), "No credentials should be read for a direct connection");
    } else if (scenario === "stale-selection") {
      await click("Check saved proxy"); assert.equal(probes.length, 1);
      current = profile("b"); await render(); assert.equal(reads.length, 2);
      await replyProxy(0, "203.0.113.99"); await read(1);
      assert.ok(text().includes("Environment b")); assert.ok(!text().includes("203.0.113.99")); assert.ok(!text().includes("a review 1"));
      await click("Draft AI explanation"); assert.equal(explanations[0]?.profileId, "b");
    } else if (scenario === "saved-change") {
      await click("Check saved proxy"); await replyProxy(); assert.ok(text().includes("203.0.113.44"));
      version++; await render();
      assert.ok(!text().includes("203.0.113.44"), "Editing a configuration invalidates the old exit observation immediately");
      assert.ok(!text().includes("a review 1"), "Old report details are cleared before the refreshed read returns");
      assert.equal(button("Draft AI explanation").disabled, true);
      await read(1, [report("a", 2)]); assert.ok(text().includes("a review 2"));
      await click("Check saved proxy"); current = profile("a", { proxy: "changed-route" }); await render();
      await replyProxy(1, "203.0.113.55"); await read(2); assert.ok(!text().includes("203.0.113.55"));
    } else if (scenario === "measurement") {
      const measure = button("Measure running browser"); assert.equal(measure.disabled, false);
      await act(async () => { measure.click(); measure.click(); button("Edit profile configuration").click(); });
      assert.equal(measurements.length, 1); assert.deepEqual(edits, []);
      await act(async () => { measurements[0]!.resolve(Response.json({ ok: true, report: report("a", 2) })); });
      assert.ok(text().includes("a review 2"));
      current = profile("a", { restartPending: true }); await render(); await read(1);
      assert.equal(button("Measure running browser").disabled, true);
      assert.ok(text().includes("older saved configuration"));
      current = profile("a", { engine: "firefox", restartPending: false }); await render(); await read(2);
      assert.equal(button("Measure running browser").disabled, true);
      assert.ok(text().includes("Saved Firefox configuration can still be reviewed"));
    } else if (scenario === "source-filters") {
      const initialPaths = [...paths];
      assert.deepEqual(ids(), ["screen_config", "hardware_configuration", "capture_source", "new_custom_probe", "locale_configuration", "browser_sample", "sample_freshness"], "Issues precede warnings and unknowns, preserving backend order within a priority");
      assert.ok(text().includes("Resolve 2 issues first")); assert.ok(!dom.container.querySelector('.inspection-counts')?.textContent?.includes("99"), "Counts come from the displayed check contract rather than an inconsistent aggregate");
      await chooseSource("measurement"); assert.deepEqual(ids(), ["hardware_configuration", "locale_configuration"]);
      await setSearch("Observed processor count"); assert.deepEqual(ids(), ["hardware_configuration"], "Search includes projected evidence labels");
      const details = dom.container.querySelector<HTMLDetailsElement>('.inspection-check-evidence')!; assert.equal(details.open, false);
      await act(async () => { details.querySelector("summary")!.click(); }); assert.equal(details.open, true); assert.deepEqual([...details.querySelectorAll("dd")].map(node => node.textContent), ["8", "2", "8", "16"]);
      await setSearch("No matching observation"); assert.deepEqual(ids(), []); assert.ok(text().includes("No checks match these filters")); assert.ok(!text().includes("No stored checks need review here"));
      await click("View checks needing review"); assert.equal(dom.window.document.activeElement?.id, "inspection-findings-title"); assert.equal(ids().length, 7);
      const custom = dom.container.querySelector('[data-check-id="new_custom_probe"]')!; assert.equal(custom.getAttribute("data-evidence-source"), "other");
      await chooseSource("configuration"); await click("Review Screen settings"); assert.deepEqual(edits, ["a"]);
      const onlyReview = dom.container.querySelector<HTMLInputElement>('.inspection-filter input')!; await act(async () => { onlyReview.click(); }); assert.deepEqual(ids(), ["screen_config", "identity_seed"]);
      await click("Reset report filters"); assert.equal(ids().length, 7); assert.deepEqual(paths, initialPaths, "Filtering, expanding evidence and editing callbacks issue no automatic network or browser probes");
    } else if (scenario === "safe-copy") {
      await click("Check saved proxy"); await replyProxy(); assert.ok(text().includes("203.0.113.44"), "The explicit observation remains available in the full report");
      await act(async () => { button("Copy safe summary").click(); button("Copy safe summary").click(); });
      assert.equal(writes.length, 1); assert.ok(writes[0]?.includes("Anonymous environment inspection summary")); assert.ok(writes[0]?.includes("Browser sample time: 2026-11-09T10:00:00.000Z"));
      for (const privateValue of ["PRIVATE_ACCOUNT_NAME", "PRIVATE_COOKIE_VALUE", "PRIVATE_PROXY_PASS", "203.0.113.44", "Europe/London", "proxy.invalid", "new_custom_probe"]) assert.ok(!writes[0]?.includes(privateValue), `Safe copy must exclude ${privateValue}`);
      assert.ok(writes[0]?.includes("Saved configuration · Screen configuration · fail")); assert.ok(writes[0]?.includes("Additional unrecognized report categories: 1"));
      const preview = dom.container.querySelector('.inspection-safe-summary pre')!; assert.equal(preview.textContent, writes[0]); assert.ok(text().includes("Safe diagnostic summary copied."));
    } else if (scenario === "clipboard-unavailable") {
      const before = [...paths]; await click("Copy safe summary"); assert.ok(text().includes("Open the safe summary preview")); assert.ok(!text().includes("PRIVATE_CLIPBOARD_FAILURE")); assert.ok(dom.container.querySelector('.inspection-safe-summary pre')?.textContent?.includes("Anonymous environment inspection summary")); assert.deepEqual(paths, before);
    } else if (scenario === "copy-lifecycle") {
      await click("Copy safe summary"); assert.equal(writes.length, 1); current = profile("b"); await render(); await read(1, [richReport("b")]);
      await act(async () => { clipboard.resolve(); }); assert.ok(!text().includes("Safe diagnostic summary copied."), "Completion from an earlier environment cannot label the new report as copied");
      await click("Copy safe summary"); assert.equal(writes.length, 2); assert.ok(text().includes("Safe diagnostic summary copied."));
    } else if (scenario === "no-measurement-claim") {
      assert.ok(text().includes("Measurement missing")); assert.ok(text().includes("More evidence is needed")); assert.ok(text().includes("No usable sample confirmed")); assert.ok(!dom.container.querySelector('.inspection-fingerprint .feature-badge')?.classList.contains("positive"));
      assert.ok(text().includes("No stored checks need review here. Browser measurement and network coverage are listed separately above."));
      assert.ok(!dom.container.querySelector('.inspection-counts')?.textContent?.includes("500")); assert.equal(measurements.length, 0); assert.equal(probes.length, 0);
    } else if (scenario === "overview-time-and-actions") {
      const overview = () => dom.container.querySelector(".inspection-overview")!;
      const evidence = (source: string) => overview().querySelector(`[data-evidence-fact="${source}"]`)!;
      assert.equal(overview().getAttribute("data-inspection-tone"), "unknown", "A consistent fingerprint report must not manufacture an unrequested network check");
      assert.ok(evidence("configuration").querySelector("time")?.getAttribute("datetime"));
      assert.equal(evidence("browser").querySelector("time")?.getAttribute("datetime"), "2026-11-09T10:00:00.000Z");
      assert.equal(evidence("network").querySelector("time"), null);
      const before = [...paths];
      await click("Review network evidence");
      assert.equal(dom.window.document.activeElement?.id, "inspection-route-title");
      assert.deepEqual(paths, before, "The overview's next-step navigation must not run a proxy or browser probe");
      await click("Check saved proxy"); await replyProxy();
      assert.ok(evidence("network").querySelector("time")?.getAttribute("datetime"));
      const sampleTime = evidence("browser").querySelector("time")!.getAttribute("datetime");
      const readTime = evidence("configuration").querySelector("time")!.getAttribute("datetime");
      await click("Refresh review");
      await read(1, [initial]);
      assert.equal(evidence("browser").querySelector("time")!.getAttribute("datetime"), sampleTime, "Refreshing a local report must retain the historical browser capture time");
      assert.ok(Date.parse(evidence("configuration").querySelector("time")!.getAttribute("datetime")!) >= Date.parse(readTime!));
      assert.equal(measurements.length, 0); assert.equal(probes.length, 1);
    } else if (scenario === "overview-browser-action") {
      const before = [...paths];
      await click("Review browser evidence");
      assert.equal(dom.window.document.activeElement?.id, "inspection-fingerprint-title");
      assert.deepEqual(paths, before); assert.equal(probes.length, 0); assert.equal(measurements.length, 0);
      assert.equal(dom.container.querySelector(".inspection-overview")?.getAttribute("data-inspection-tone"), "unknown");
      assert.ok(dom.container.querySelector(".inspection-overview-next")?.textContent?.includes("Collect a new browser measurement"));
    } else if (scenario === "retry-and-close") {
      await click("Check saved proxy");
      await act(async () => { probes[0]!.response.resolve(Response.json({ ok: false, error: "PRIVATE_BACKEND_ERROR" }, { status: 503 })); });
      assert.ok(text().includes("The proxy check is unavailable")); assert.ok(!text().includes("PRIVATE_BACKEND_ERROR"));
      await click("Check saved proxy"); assert.equal(probes.length, 2);
      await dom.unmount(); await replyProxy(1); assert.equal(dom.container.textContent, "");
    } else throw new Error(`Unknown fixture scenario: ${scenario}`);
    assert.ok(paths.every(path => !path.includes("open") && !path.includes("launch")), "Inspection must never start a browser");
  } finally { if (clipboardBefore) Object.defineProperty(dom.window.navigator, "clipboard", clipboardBefore); else Reflect.deleteProperty(dom.window.navigator, "clipboard"); await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "explicit-network"); console.log("environment inspection interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
