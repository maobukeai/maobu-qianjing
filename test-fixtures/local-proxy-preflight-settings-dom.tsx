import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLInputElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { LocalProxyPreflightSettings } from "../web/local-proxy-preflight-settings.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  let settings: Record<string, any> = { version: 1, updates: { repository: "maobu/browser", channel: "stable", checkOnStartup: false }, sync: { enabled: false, folder: "/private-do-not-save", retainSnapshots: 10 }, ...(scenario === "legacy" ? {} : { network: { checkLocalProxyBeforeLaunch: false } }) };
  let rejectLoad = scenario === "load-retry"; const requests: Array<{ method: string; body?: unknown }> = [];
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ language: "en-US" });
    assert.equal(input, "/ui/api/settings"); assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    const method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : undefined; requests.push({ method, body });
    if (method === "GET") {
      if (rejectLoad) { rejectLoad = false; return Response.json({ ok: false, error: "Inert network load failure" }, { status: 503 }); }
      return Response.json({ ok: true, settings });
    }
    assert.equal(method, "PATCH"); assert.deepEqual(body, { network: { checkLocalProxyBeforeLaunch: true } });
    assert.equal(JSON.stringify(body).includes("private-do-not-save"), false);
    if (scenario === "save-failure") return Response.json({ ok: false, error: "Inert network save failure" }, { status: 500 });
    settings = { ...settings, network: body.network }; return Response.json({ ok: true, settings });
  }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch });
  const button = (text: string) => { const found = [...dom.container.querySelectorAll("button")].find(item => item.textContent?.trim() === text); assert.ok(found, `Missing button: ${text}`); return found; };
  try {
    await dom.render(<I18nProvider><LocalProxyPreflightSettings /></I18nProvider>); await dom.flush();
    if (scenario === "load-retry") {
      assert.ok(dom.container.textContent?.includes("Inert network load failure"));
      await act(async () => button("Try again").click()); await dom.flush();
    }
    const checkbox = dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false); assert.equal(requests.filter(item => item.method === "PATCH").length, 0);
    assert.ok(dom.container.textContent?.includes("Credentials and exit connectivity are not verified"));
    await act(async () => checkbox.click()); await dom.flush();
    assert.equal(checkbox.checked, true);
    await act(async () => { const save = button("Save network preference"); save.click(); if (scenario === "same-frame-save") save.click(); }); await dom.flush();
    assert.equal(requests.filter(item => item.method === "PATCH").length, 1);
    if (scenario === "save-failure") { assert.ok(dom.container.textContent?.includes("Inert network save failure")); assert.equal(button("Save network preference").disabled, false); assert.equal(checkbox.checked, true); }
    else { assert.ok(dom.container.textContent?.includes("Network startup preference saved.")); assert.equal(button("Save network preference").disabled, true); }
  } finally { await dom.cleanup(); }
}
if (import.meta.main) { try { await run(process.argv[2] ?? "save"); console.log("local proxy startup preference fixture passed"); } catch (error) { console.error(error); process.exitCode = 1; } }
