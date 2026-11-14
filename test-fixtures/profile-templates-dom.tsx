import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { ProfileTemplates } from "../web/profile-templates.tsx";
import type { ProfileTemplateCatalog, ProfileTemplateSettings } from "../web/profile-templates-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

const id = "tpl_" + "a".repeat(32), newId = "tpl_" + "b".repeat(32);
const target: ProfileTemplateSettings = { engine: "firefox", chromiumRuntime: "", platformOs: "linux", screen: "1440x900", platform: "example.com" };
const fields = ["chromiumRuntime", "engine", "platform", "platformOs", "screen"];
async function run(scenario: string) {
  let catalog: ProfileTemplateCatalog = { version: 1, revision: 7, templates: [{ id, name: "Firefox QA", settings: { ...target }, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" }] };
  const calls: Array<{ method: string; path: string; body?: Record<string, any> }> = [], applied: ProfileTemplateSettings[] = [];
  let failLoad = scenario === "load-retry", conflict = scenario === "revision-conflict", outerEscapes = 0;
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const path = String(input), method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ method, path, body }); assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    assert.ok(path === "/ui/api/settings/templates" || path === "/ui/api/settings/templates/delete", "must not call profile creation, seed, preview or control APIs");
    if (method === "GET") {
      if (failLoad) { failLoad = false; return Response.json({ ok: false, code: "storage-error", error: "Inert preset loading failure" }, { status: 500 }); }
      return Response.json({ ok: true, catalog });
    }
    if (conflict) {
      conflict = false; catalog = { ...catalog, revision: 8, templates: [{ ...catalog.templates[0]!, settings: { ...target, screen: "1600x1000" } }] };
      return Response.json({ ok: false, code: "revision-conflict", error: "Profile templates changed. Refresh the list before saving again." }, { status: 409 });
    }
    assert.equal(body.revision, catalog.revision);
    if (path.endsWith("/delete")) {
      assert.deepEqual(Object.keys(body).sort(), ["id", "revision"]);
      catalog = { ...catalog, revision: catalog.revision + 1, templates: catalog.templates.filter(item => item.id !== body.id) };
    } else {
      assert.deepEqual(Object.keys(body.settings).sort(), fields);
      const existing = catalog.templates.find(item => item.id === body.id);
      if (body.id) assert.deepEqual(body.settings, existing!.settings, "renaming must preserve the stored settings, including refreshed concurrent changes");
      const item = { id: body.id ?? newId, name: body.name, settings: body.settings, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:01.000Z" };
      catalog = { ...catalog, revision: catalog.revision + 1, templates: existing ? catalog.templates.map(entry => entry.id === item.id ? item : entry) : [...catalog.templates, item] };
    }
    return Response.json({ ok: true, catalog });
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  const draft: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "x.com" };
  for (const name of ["password", "proxy", "fingerprintSeed", "name", "group"]) Object.defineProperty(draft, name, { enumerable: true, get() { throw new Error("a private parent form field was read"); } });
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [current, setCurrent] = useState(draft);
    return <I18nProvider><ProfileTemplates draft={current} disabled={disabled} onApply={settings => {
      assert.deepEqual(Object.keys(settings).sort(), fields);
      if (scenario === "apply-rejected") throw new Error("This template uses a browser runtime that is unavailable on this computer.");
      applied.push(settings); setCurrent(settings);
    }} /></I18nProvider>;
  }
  const text = () => dom.container.textContent ?? "";
  const buttons = () => Array.from(dom.container.querySelectorAll("button"));
  const button = (label: string) => { const found = buttons().find(item => item.textContent?.trim() === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (label: string) => act(async () => { const item = button(label); assert.equal(item.disabled, false); item.click(); });
  const select = async () => act(async () => { const item = dom.container.querySelector<HTMLSelectElement>("select")!; item.value = id; item.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const typeName = async (name: string) => act(async () => {
    const input = dom.container.querySelector<HTMLInputElement>(".profile-template-editor input")!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await dom.render(<Harness />);
    dom.window.document.addEventListener("keydown", event => { if (event instanceof dom.window.KeyboardEvent && event.key === "Escape") outerEscapes++; });
    assert.equal(calls.length, 0); assert.equal(dom.container.querySelector("details")?.open, false);
    await act(async () => { dom.container.querySelector("summary")!.click(); }); await dom.flush();
    assert.equal(calls.length, 1);
    if (scenario === "load-retry") {
      assert.ok(text().includes("Inert preset loading failure")); await click("Try again");
      assert.equal(calls.length, 2); assert.ok(text().includes("Choose a preset")); return;
    }
    if (scenario === "save-and-escape") {
      await click("Save current settings as preset");
      const input = dom.container.querySelector<HTMLInputElement>(".profile-template-editor input")!;
      assert.equal(dom.window.document.activeElement, input);
      await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      assert.equal(dom.container.querySelector(".profile-template-editor"), null); assert.equal(outerEscapes, 0);
      assert.equal(dom.window.document.activeElement, button("Save current settings as preset"));
      await click("Save current settings as preset"); await typeName("My desktop"); await click("Save preset");
      assert.equal(calls.filter(item => item.method === "POST").length, 1); assert.deepEqual(catalog.templates.at(-1)?.settings, { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "x.com" });
      assert.ok(text().includes("Preset saved.")); assert.equal(applied.length, 0); return;
    }
    await select();
    assert.equal(applied.length, 0); assert.equal(calls.length, 1);
    assert.equal(dom.container.querySelectorAll("tbody tr").length, 5);
    if (scenario === "apply" || scenario === "apply-rejected") {
      await click("Apply preset");
      if (scenario === "apply-rejected") {
        assert.ok(text().includes("This template uses a browser runtime that is unavailable on this computer."));
        assert.equal(text().includes("Preset applied to this draft."), false); assert.equal(applied.length, 0);
      } else { assert.deepEqual(applied, [target]); assert.ok(text().includes("This preset already matches")); }
      assert.equal(calls.length, 1); return;
    }
    if (scenario === "disabled") {
      await dom.render(<Harness disabled />);
      assert.ok(button("Apply preset").disabled); assert.ok(button("Save current settings as preset").disabled);
      assert.ok(button("Rename preset").disabled); assert.ok(button("Delete preset").disabled);
      await act(async () => { button("Apply preset").click(); button("Delete preset").click(); });
      assert.equal(calls.length, 1); assert.equal(applied.length, 0); return;
    }
    if (scenario === "staged-delete") {
      await click("Delete preset"); assert.equal(calls.length, 1);
      assert.ok(dom.container.querySelector(`option[value="${id}"]`));
      await click("Undo"); assert.equal(calls.length, 1);
      await click("Delete preset"); await click("Confirm deletion");
      assert.equal(calls.filter(item => item.path.endsWith("/delete")).length, 1);
      assert.equal(dom.container.querySelector(`option[value="${id}"]`), null); assert.ok(text().includes("Preset deleted.")); return;
    }
    assert.equal(scenario, "revision-conflict");
    await click("Rename preset"); await typeName("Renamed by operator"); await click("Save preset name");
    assert.equal(calls.filter(item => item.method === "POST").length, 1, "conflicts must never auto-resubmit");
    assert.equal(dom.container.querySelector<HTMLInputElement>(".profile-template-editor input")?.value, "Renamed by operator");
    assert.ok(text().includes("Profile templates changed.")); assert.ok(text().includes("The preset list was refreshed."));
    await click("Save preset name"); assert.equal(catalog.templates[0]?.name, "Renamed by operator");
    assert.equal(catalog.templates[0]?.settings.screen, "1600x1000"); assert.equal(applied.length, 0);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "apply"); console.log("profile preset interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
