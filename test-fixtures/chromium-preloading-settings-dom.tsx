import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLSelectElement } from "happy-dom";
import { defaultAppSettings } from "../app-settings.ts";
import { ChromiumPreloadingSettings } from "../web/chromium-preloading-settings.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  let settings: any = { ...defaultAppSettings(), network: { checkLocalProxyBeforeLaunch: true, ...(scenario === "legacy" ? {} : { chromiumPreloading: scenario === "restore" ? "disabled" : "browser-default" }) } };
  const requests: { method: string; body?: any }[] = [];
  let rejectLoad = scenario === "load-retry", resolvePatch: ((value: Response) => void) | null = null;
  const deferred = scenario === "double-submit" || scenario === "unmount";
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ language: "en-US" });
    assert.equal(input, "/ui/api/settings", "The card must not open/stop/probe a browser");
    assert.equal(options?.credentials, "same-origin"); assert.equal(new Headers(options.headers).get("X-Maobu-Settings"), "1");
    const method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : undefined; requests.push({ method, body });
    if (method === "GET") {
      if (rejectLoad) { rejectLoad = false; return Response.json({ ok: false, error: "Inert fixture load failure" }, { status: 503 }); }
      return Response.json({ ok: true, settings });
    }
    assert.equal(method, "PATCH"); assert.deepEqual(Object.keys(body), ["network"]); assert.deepEqual(Object.keys(body.network), ["chromiumPreloading"]);
    assert.equal(body.network.chromiumPreloading, scenario === "restore" ? "browser-default" : "disabled");
    if (scenario === "save-failure") return Response.json({ ok: false, error: "Inert fixture save failure" }, { status: 500 });
    if (scenario !== "unacknowledged") settings = { ...settings, network: { ...settings.network, ...body.network } };
    if (deferred) return await new Promise<Response>(resolve => { resolvePatch = resolve; });
    return Response.json({ ok: true, settings });
  }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch });
  const button = (text: string) => { const found = [...dom.container.querySelectorAll("button")].find(item => item.textContent === text); assert.ok(found, `Missing ${text}`); return found; };
  try {
    await dom.render(<I18nProvider><ChromiumPreloadingSettings /></I18nProvider>); await dom.flush();
    if (scenario === "load-retry") {
      assert.ok(dom.container.textContent?.includes("Page preloading settings could not be loaded. Try again."));
      assert.equal(dom.container.querySelector<HTMLSelectElement>("select")!.disabled, true);
      await act(async () => button("Try again").click()); await dom.flush();
    }
    const select = dom.container.querySelector<HTMLSelectElement>("select")!;
    assert.equal(select.value, scenario === "restore" ? "disabled" : "browser-default"); assert.equal(select.disabled, false);
    assert.ok(dom.container.textContent?.includes("managed Chromium 155")); assert.ok(dom.container.textContent?.includes("Some pages may open more slowly"));
    assert.ok(dom.container.textContent?.includes("Running browsers are left as they are"));
    assert.ok(dom.container.textContent?.includes("preserving later manual changes"));
    assert.ok(select.getAttribute("aria-describedby")); assert.equal(requests.filter(item => item.method === "PATCH").length, 0);
    await act(async () => { select.value = scenario === "restore" ? "browser-default" : "disabled"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); await dom.flush();
    const save = button("Save preloading preference"); assert.equal(save.disabled, false);
    if (deferred) {
      await act(async () => { save.click(); save.click(); }); await dom.flush();
      assert.equal(requests.filter(item => item.method === "PATCH").length, 1); assert.equal(select.disabled, true);
      if (scenario === "unmount") await dom.unmount();
      assert.ok(resolvePatch); await act(async () => { resolvePatch!(Response.json({ ok: true, settings })); }); await dom.flush();
      if (scenario === "unmount") { assert.equal(dom.container.children.length, 0); return; }
    } else { await act(async () => save.click()); await dom.flush(); }
    assert.equal(requests.filter(item => item.method === "PATCH").length, 1);
    assert.equal(settings.network.checkLocalProxyBeforeLaunch, true);
    if (["save-failure", "unacknowledged"].includes(scenario)) {
      assert.ok(dom.container.textContent?.includes("Page preloading settings could not be saved. Reload or try again.")); assert.equal(button("Save preloading preference").disabled, false); assert.equal(select.value, "disabled");
    } else { assert.ok(dom.container.textContent?.includes("Preloading preference saved. It will apply the next time you open a closed profile.")); assert.equal(button("Save preloading preference").disabled, true); }
    const count = requests.length; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(requests.length, count, "No background polling");
  } finally { await dom.cleanup(); }
}
if (import.meta.main) { try { await run(process.argv[2] ?? "save"); console.log("Chromium preloading settings fixture passed"); } catch (error) { console.error(error); process.exitCode = 1; } }
