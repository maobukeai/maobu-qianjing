import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import type { AppSettings } from "../app-settings.ts";
import { getBrowserRuntimeInventory } from "../runtime-inventory.ts";
import { I18nProvider } from "../web/i18n.tsx";
import zhCN from "../web/locales/zh-CN.json";
import { FeatureSettingsPanel, type FeatureSettingsTab } from "../web/settings-center.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function defaults(repository = "saved/repo", enabled = false): AppSettings {
  return { version: 1, updates: { repository, channel: "stable", checkOnStartup: false }, sync: { enabled, folder: enabled ? "/inert-fixture-sync" : "", retainSnapshots: 10 }, network: { checkLocalProxyBeforeLaunch: false } };
}
function update(repository: string, version: string) {
  return { ok: true, update: { status: "up-to-date", currentVersion: version, repository, channel: "stable", checkedAt: 100, cached: true } };
}
async function run(scenario: string) {
  const language = scenario.endsWith("-zh") ? "zh-CN" : "en-US";
  const t = (source: string) => language === "zh-CN" ? (zhCN as Record<string, string>)[source] ?? source : source;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const failure = (error: string) => json({ ok: false, error }, 503);
  type Request = { path: string; method: string; body?: any };
  const requests: Request[] = [];
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  const count = (key: string) => requests.filter(request => `${request.method} ${request.path}` === key).length;
  const settingsKey = "GET /ui/api/settings", historyKey = "GET /ui/api/settings/updates", patchKey = "PATCH /ui/api/settings", filesKey = "GET /ui/api/settings/sync/files", checkKey = "POST /ui/api/settings/updates";
  routes.set(settingsKey, () => json({ ok: true, settings: defaults() }));
  routes.set(historyKey, () => json({ ok: true, update: null }));
  routes.set("GET /ui/api/settings/runtimes", () => json({ ok: true, inventory: getBrowserRuntimeInventory({
    runtimeRoot: "/inert-cache", platform: "win32", arch: "x64", chromiumDefault: "aliasmode-chromium", cloakSource: "managed", firefoxSource: "managed",
  }) }));
  routes.set(filesKey, () => json({ ok: true, files: [] }));
  routes.set("GET /ui/api/settings/fingerprints", () => json({ ok: true, reports: [] }));
  function hold(key: string) {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    routes.set(key, () => { const response = deferred<Response>(); pending.push(response); return response.promise; });
    return pending;
  }
  const settings = scenario.endsWith("settings") || scenario.endsWith("navigation") && !scenario.includes("save") ? hold(settingsKey) : null;
  const histories = scenario === "updates-history" || scenario === "updates-navigation" || scenario === "updates-history-save-race" ? hold(historyKey) : null;
  const patches = scenario.includes("save-navigation") ? hold(patchKey) : null;
  const checks = scenario === "updates-history-save-race" ? hold(checkKey) : null;
  const discoveryKey = "POST /ui/api/settings/network/discover";
  const verifyKey = "POST /ui/api/proxy/check";
  const scans = scenario === "network-custom" ? hold(discoveryKey) : null;
  if (scans) routes.set(verifyKey, () => json({ ok: true, status: "working", ip: "203.0.113.11", attempts: 3, successes: 3 }));
  if (scenario === "updates-history-save-race") routes.set(patchKey, request => json({ ok: true, settings: { ...defaults(), updates: request.body.updates } }));
  if (scenario === "sync-save-navigation") routes.set(settingsKey, () => json({ ok: true, settings: defaults("saved/repo", true) }));
  if (scenario.startsWith("network-names")) routes.set("POST /ui/api/settings/network/discover", () => json({ ok: true, discovery: {
    checkedAt: "2026-11-09T00:00:00Z", host: "127.0.0.1", results: [7890, 1080].map(port => ({ host: "127.0.0.1", port, latencyMs: 5, status: "listening", socks5: "available", suggestions: [{ type: "http", evidence: "port_hint" }, { type: "socks5", evidence: "handshake" }] })),
  } }));
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET";
    if (path === "/ui/api/shell-language") return json({ ok: true, language });
    const request = { path, method, ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) };
    requests.push(request);
    if (path !== "/ui/api/proxy/check") {
      assert.equal(options?.credentials, "same-origin");
      assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    }
    const route = routes.get(`${method} ${path}`); assert.ok(route, `Blocked non-fixture request: ${method} ${path}`);
    return route(request);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch });
  dom.window.localStorage.setItem("aliasmode.shell.language", language);
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { throw new Error("Window networking is disabled in this fixture"); } });
  const render = (tab: FeatureSettingsTab) => dom.render(<I18nProvider><FeatureSettingsPanel key={tab} tab={tab} /></I18nProvider>);
  const button = (source: string) => { const value = Array.from(dom.container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === t(source)); assert.ok(value, `Missing ${source}: ${dom.container.textContent}`); return value; };
  const field = (source: string) => {
    const label = Array.from(dom.container.querySelectorAll("label")).find(item => item.querySelector("span")?.textContent === t(source));
    const input = label?.querySelector<HTMLInputElement>("input"); assert.ok(input, `Missing labelled field: ${source}`); return input;
  };
  const type = async (source: string, value: string) => act(async () => {
    const input = field(source); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const respond = (pending: Array<ReturnType<typeof deferred<Response>>>, index: number, value: Response) => act(async () => { assert.ok(pending[index]); pending[index]!.resolve(value); });
  const clickTwice = (value: HTMLButtonElement) => act(async () => { value.click(); value.click(); });
  try {
    if (scenario === "updates-history") {
      await render("updates");
      assert.equal(field("Release repository").value, "saved/repo"); assert.equal(field("Release repository").disabled, false, "Cached history must not block editing release settings");
      await respond(histories!, 0, failure("Inert saved status failure"));
      assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("Inert saved status failure"));
      await type("Release repository", "draft/one");
      const retry = button("Reload last check"); retry.focus(); await clickTwice(retry);
      assert.equal(histories!.length, 2, "Repeated retry events must share one pending GET");
      assert.equal(retry.disabled, true); assert.equal(retry.getAttribute("aria-busy"), "true");
      assert.equal(count(settingsKey), 1, "Retrying history must not refetch settings");
      await type("Release repository", "draft/two");
      await respond(histories!, 1, json(update("saved/repo", "0.9.0")));
      assert.equal(field("Release repository").value, "draft/two"); assert.equal(dom.container.querySelector(".update-result"), null, "A late saved check must not reinstate a result invalidated by editing");
      await act(async () => { button("Reload last check").click(); });
      await respond(histories!, 2, json(update("draft/two", "1.1.0")));
      assert.equal(field("Release repository").value, "draft/two"); assert.ok(dom.container.querySelector(".update-result")?.textContent?.includes("1.1.0"));
      assert.equal(count(settingsKey), 1); assert.ok(requests.every(request => request.method === "GET"));
    } else if (scenario.endsWith("settings")) {
      const tab = scenario.startsWith("updates") ? "updates" : "sync";
      await render(tab); await respond(settings!, 0, failure("Inert initial settings failure"));
      const retry = button("Retry settings"); assert.equal(retry.disabled, false); retry.focus();
      await clickTwice(retry); assert.equal(settings!.length, 2); assert.equal(retry.disabled, true); assert.equal(retry.getAttribute("aria-busy"), "true");
      await act(async () => { retry.click(); }); assert.equal(settings!.length, 2);
      await respond(settings!, 1, failure("Inert retry settings failure"));
      assert.equal(button("Retry settings").disabled, false); assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("Inert retry settings failure"));
      await act(async () => { button("Retry settings").click(); }); await respond(settings!, 2, json({ ok: true, settings: defaults() }));
      assert.equal(field(tab === "updates" ? "Release repository" : "Sync folder").disabled, false);
      assert.equal(dom.container.querySelector('[role="alert"]'), null); assert.equal(count(settingsKey), 3);
      if (tab === "updates") assert.equal(count(historyKey), 1, "Retrying settings must not repeat the independent history request");
      else assert.equal(count(filesKey), 0, "Disabled sync must not read snapshot files");
      assert.ok(requests.every(request => request.method === "GET"));
    } else if (scenario === "updates-navigation") {
      await render("updates"); await render("fingerprints"); await render("updates");
      assert.equal(settings!.length, 2); assert.equal(histories!.length, 2);
      await respond(settings!, 1, json({ ok: true, settings: defaults("new/repo") })); await respond(histories!, 1, json(update("new/repo", "2.0.0")));
      await respond(settings!, 0, json({ ok: true, settings: defaults("old/repo") })); await respond(histories!, 0, failure("Inert old history error"));
      assert.equal(field("Release repository").value, "new/repo"); assert.ok(dom.container.querySelector(".update-result")?.textContent?.includes("2.0.0"));
      assert.ok(!dom.container.textContent?.includes("Inert old history error"));
    } else if (scenario === "sync-navigation") {
      await render("sync"); await render("fingerprints"); await render("sync");
      await respond(settings!, 1, json({ ok: true, settings: defaults() }));
      await respond(settings!, 0, json({ ok: true, settings: defaults("old/repo", true) }));
      assert.equal(field("Sync folder").value, ""); assert.equal(count(filesKey), 0, "An unmounted settings request must not continue into reading another folder's files");
      assert.equal(button("Save settings").disabled, false);
    } else if (scenario.endsWith("save-navigation")) {
      const tab = scenario.startsWith("updates") ? "updates" : "sync";
      await render(tab); if (tab === "sync") await type("Sync folder", "/inert-next-folder");
      const filesBefore = count(filesKey); await clickTwice(button(tab === "updates" ? "Save & check for updates" : "Save settings"));
      assert.equal(patches!.length, 1, "A save must take a synchronous operation lock");
      await render("fingerprints"); await respond(patches!, 0, json({ ok: true, settings: defaults("saved/repo", tab === "sync") }));
      assert.equal(count(checkKey), 0, "A completed save from an unmounted panel must not start another update request");
      assert.equal(count(filesKey), filesBefore, "An unmounted sync save must not continue into a file refresh");
      assert.equal(dom.container.querySelector("h2")?.textContent, "Fingerprint quality"); assert.ok(!dom.container.textContent?.includes("Saved"));
    } else if (scenario === "updates-history-save-race") {
      await render("updates"); await clickTwice(button("Save & check for updates"));
      assert.equal(count(patchKey), 1); assert.equal(checks!.length, 1);
      await respond(checks!, 0, json(update("saved/repo", "2.0.0")));
      await respond(histories!, 0, json(update("saved/repo", "0.9.0")));
      assert.ok(dom.container.querySelector(".update-result")?.textContent?.includes("2.0.0")); assert.ok(!dom.container.querySelector(".update-result")?.textContent?.includes("0.9.0"), "Old history must not overwrite a newer explicit update check");
    } else if (scans) {
      await render("network");
      const host = dom.container.querySelector<HTMLSelectElement>("form select");
      assert.ok(host); assert.equal(host.value, "127.0.0.1"); assert.equal(count(discoveryKey), 0);
      const ports = "Custom ports (optional)", discover = "Discover local proxies";
      assert.equal(dom.window.document.getElementById(field(ports).getAttribute("aria-labelledby") ?? "")?.textContent, ports);
      assert.match(dom.window.document.getElementById(field(ports).getAttribute("aria-describedby") ?? "")?.textContent ?? "", /Leave blank to use common ports/);
      for (const invalid of ["11555,11555", "80,00080", "11555,", "11555,,11556", "0", "65536", "1e3", "0xFF", "1-3", "11555 11556", Array.from({ length: 17 }, (_, index) => index + 1).join(",")]) {
        await type(ports, invalid);
        await act(async () => { button(discover).click(); });
        assert.equal(count(discoveryKey), 0);
        assert.equal(field(ports).value, invalid);
        assert.equal(field(ports).getAttribute("aria-invalid"), "true");
        assert.match(dom.container.querySelector('[role="alert"]')?.textContent ?? "", /1–16 unique ports/);
      }
      await act(async () => {
        host.value = "::1";
        host.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await type(ports, "11555， 11556");
      assert.equal(field(ports).getAttribute("aria-invalid"), null);
      await clickTwice(button(discover));
      assert.equal(count(discoveryKey), 1); assert.equal(scans.length, 1);
      assert.deepEqual(requests.find(request => request.path.endsWith("/discover"))?.body, { host: "::1", ports: [11555, 11556] });
      assert.equal(host.disabled, true); assert.equal(field(ports).disabled, true);
      await respond(scans, 0, json({ ok: true, discovery: {
        host: "::1", checkedAt: "2026-11-09T00:00:00Z", results: [
          { host: "::1", port: 11555, status: "listening", socks5: "available", latencyMs: 0, suggestions: [{ type: "socks5", evidence: "handshake" }] },
          { host: "::1", port: 11556, status: "closed", socks5: "unknown", latencyMs: null, suggestions: [] },
        ],
      } }));
      assert.equal(host.disabled, false); assert.equal(field(ports).disabled, false);
      assert.equal(dom.container.querySelector(".local-proxy-address strong")?.textContent, "[::1]:11555");
      assert.match(dom.container.querySelector(".port-list")?.textContent ?? "", /\[::1\]:11556/);
      const copied: string[] = [];
      Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
      const copy = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Copy SOCKS5 proxy for [::1]:11555"]');
      const verify = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Verify SOCKS5 exit for [::1]:11555"]');
      assert.ok(copy); assert.ok(verify);
      await act(async () => { copy.click(); });
      assert.deepEqual(copied, ["socks5://[::1]:11555"]);
      assert.equal(count(verifyKey), 0);
      await act(async () => { verify.click(); });
      assert.equal(count(verifyKey), 1);
      assert.deepEqual(requests.find(request => request.path.endsWith("/proxy/check"))?.body, { proxy: { type: "socks5", host: "::1", port: "11555", user: "", pass: "" } });
      assert.match(dom.container.querySelector(".feature-check-result")?.textContent ?? "", /203\.0\.113\.11/);
      await type(ports, "");
      assert.equal(dom.container.querySelector(".local-proxy-result"), null); assert.equal(count(discoveryKey), 1);
      await act(async () => { button(discover).click(); });
      assert.equal(count(discoveryKey), 2);
      assert.deepEqual(requests.filter(request => request.path.endsWith("/discover"))[1]?.body, { host: "::1" });
      await respond(scans, 1, failure("Inert second discovery failure"));
      assert.equal(button(discover).disabled, false);
    } else if (scenario.startsWith("network-names")) {
      await render("network"); await act(async () => { button("Discover local proxies").click(); });
      const named = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button[aria-label]'));
      assert.equal(named.length, 8); assert.equal(new Set(named.map(item => item.getAttribute("aria-label"))).size, 8);
      for (const port of [7890, 1080]) for (const protocol of ["HTTP", "SOCKS5"]) {
        const endpoint = `127.0.0.1:${port}`;
        const copy = t("Copy {protocol} proxy for {endpoint}").replace("{protocol}", protocol).replace("{endpoint}", endpoint);
        const verify = t("Verify {protocol} exit for {endpoint}").replace("{protocol}", protocol).replace("{endpoint}", endpoint);
        assert.ok(named.some(item => item.getAttribute("aria-label") === copy && item.textContent === t(protocol === "HTTP" ? "Copy HTTP" : "Copy SOCKS5")));
        assert.ok(named.some(item => item.getAttribute("aria-label") === verify && item.textContent?.includes(t("Verify exit"))));
      }
      assert.equal(requests.filter(request => request.method !== "GET").length, 1, "Inspecting button names must not run an exit check or write settings");
    } else throw new Error(`Unknown fixture scenario: ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "updates-history"); console.log("settings recovery interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
