import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { ModelServicesPanel } from "../web/model-services.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import type { AssistantServiceDraft, AssistantServicesCatalog, AssistantServiceView } from "../web/assistant-services-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

const route = "/ui/api/settings/assistant/services";
const remoteId = "model_" + "a".repeat(32), localId = "model_" + "b".repeat(32), newId = "model_" + "c".repeat(32);
const remote: AssistantServiceView = { id: remoteId, name: "Fixture API", provider: "openai-compatible", endpoint: "https://api.example.com/v1", model: "model-1", credentialConfigured: true };
const local: AssistantServiceView = { id: localId, name: "Fixture local", provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "fixture:local", credentialConfigured: false };
const requiresKey: AssistantServiceView = { ...remote, id: "model_" + "d".repeat(32), name: "Fixture Anthropic", provider: "anthropic", credentialConfigured: false };
const probe = () => Response.json({ ok: true, catalog: { models: [{ name: "model-2", sizeBytes: null, parameterSize: null, quantization: null }], excludedRemoteModels: 0 } });

async function run(scenario: string) {
  let catalog: AssistantServicesCatalog = { services: [remote, local, requiresKey], defaultId: null };
  let failRead = scenario === "retry-and-workspace-switch";
  let finishProbe: ((response: Response) => void) | null = null;
  const calls: Array<{ path: string; body?: AssistantServiceDraft; signal?: AbortSignal | null }> = [];
  const published: AssistantServicesCatalog[] = [];
  const fetchFixture = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const path = String(input);
    assert.ok(path === route || path.startsWith(`${route}/`), "model settings only call the same-origin model service API");
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    const value = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, body: value, signal: options?.signal });
    if (path === route) {
      assert.equal(options?.method, "GET");
      if (failRead) {
        failRead = false;
        return Response.json({ ok: false, code: "unavailable", error: "Fixture read error" }, { status: 503 });
      }
    } else {
      assert.equal(options?.method, "POST");
      if (path.endsWith("/test")) {
        if (scenario === "retry-and-workspace-switch") return new Promise<Response>(resolve => { finishProbe = resolve; });
        assert.equal(value.apiKey, "synthetic-key");
        assert.equal(value.messages, undefined);
        return probe();
      }
      if (path.endsWith("/default")) catalog = { ...catalog, defaultId: value.id };
      else if (path.endsWith("/remove")) catalog = { ...catalog, services: catalog.services.filter(service => service.id !== value.id) };
      else if (path.endsWith("/save")) {
        const existing = catalog.services.find(service => service.id === value.id);
        const service = { id: value.id ?? newId, name: value.name, provider: value.provider, endpoint: value.endpoint, model: value.model,
          credentialConfigured: value.apiKey === undefined ? existing?.credentialConfigured ?? false : !!value.apiKey } as AssistantServiceView;
        catalog = { ...catalog, services: existing ? catalog.services.map(item => item.id === service.id ? service : item) : [...catalog.services, service] };
      } else throw new Error("Unexpected fixture operation");
    }
    return Response.json({ ok: true, catalog });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fetchFixture });
  const render = (active: boolean, workspaceId = "workspace-a") => dom.render(<I18nProvider><ModelServicesPanel active={active} workspaceId={workspaceId} onCatalogChanged={next => published.push(next)} /></I18nProvider>);
  const button = (name: string) => {
    const element = Array.from(dom.container.querySelectorAll("button")).find(item => item.textContent?.trim() === name);
    assert.ok(element, `Missing button ${name}`);
    return element;
  };
  const click = async (name: string) => act(async () => { const element = button(name); assert.ok(!element.disabled); element.click(); });
  const selectService = async (name: string) => act(async () => {
    const element = Array.from(dom.container.querySelectorAll<HTMLButtonElement>(".model-services-list-item")).find(item => item.querySelector("strong")?.textContent === name);
    assert.ok(element); element.click();
  });
  const field = (name: string) => {
    const label = Array.from(dom.container.querySelectorAll("label.fld")).find(item => item.querySelector("span")?.textContent === name);
    const input = label?.querySelector<HTMLInputElement>("input");
    assert.ok(input, `Missing input ${name}`);
    return input;
  };
  const type = async (name: string, value: string) => act(async () => {
    const input = field(name);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  try {
    await render(false);
    assert.equal(calls.length, 0);
    await render(true);
    assert.equal(calls.length, 1);
    if (scenario === "retry-and-workspace-switch") {
      assert.match(dom.container.textContent, /Fixture read error/);
      await click("Try again");
      assert.equal(calls.length, 2);
      await click("Test and load models");
      const testCall = calls.at(-1)!;
      assert.ok(!Object.hasOwn(testCall.body!, "apiKey"), "an unchanged configured credential is never read back into the form");
      catalog = { services: [local], defaultId: local.id };
      await render(true, "workspace-b");
      assert.equal(testCall.signal?.aborted, true);
      assert.equal(field("Connection name").value, local.name);
      await act(async () => { finishProbe!(probe()); });
      assert.doesNotMatch(dom.container.textContent, /model-2|Model list loaded/);
      assert.equal(dom.container.querySelector('input[type="password"]'), null);
      return;
    }

    assert.equal(field("API key").value, "");
    assert.match(dom.container.querySelector(".model-services-list")!.textContent, /API key required for this session/);
    await selectService(requiresKey.name);
    assert.equal(button("Test and load models").disabled, true);
    await selectService(local.name);
    assert.equal(dom.container.querySelector('input[type="password"]'), null);
    await selectService(remote.name);
    await type("API key", " synthetic-key ");
    await render(false); await render(true);
    assert.equal(calls.length, 1, "changing tabs neither refetches nor discards an in-progress connection form");
    assert.equal(field("API key").value, " synthetic-key ");
    await selectService(local.name);
    assert.match(dom.container.textContent, /Save or discard your changes/);
    await click("Test and load models");
    assert.match(dom.container.textContent, /Model list loaded/);
    const modelSelect = dom.container.querySelector<HTMLSelectElement>(".model-services-model select")!;
    await act(async () => { modelSelect.value = "model-2"; modelSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(field("Model ID").value, "model-2");
    await click("Save connection");
    assert.equal(field("API key").value, "");
    assert.equal(catalog.defaultId, null, "saving a connection does not pick a default");
    catalog = { ...catalog, services: catalog.services.map(service => service.id === local.id ? { ...service, name: "Changed in the sidebar" } : service) };
    await render(false); await render(true);
    assert.equal(calls.at(-1)?.path, route);
    assert.equal(field("Connection name").value, remote.name);
    assert.match(dom.container.textContent, /Changed in the sidebar/);
    await click("Set as default model service");
    assert.equal(catalog.defaultId, remoteId);
    await click("Clear default model service");
    assert.equal(catalog.defaultId, null);
    await click("Clear session key");
    assert.match(dom.container.textContent, /Saving will clear/);
    await click("Save connection");
    assert.equal(calls.at(-1)?.body?.apiKey, "");
    assert.equal(catalog.services.find(service => service.id === remoteId)?.credentialConfigured, false);
    await click("Remove model service");
    assert.ok(catalog.services.some(service => service.id === remoteId));
    assert.equal(dom.window.document.activeElement, button("Cancel"));
    await click("Cancel");
    assert.equal(dom.window.document.activeElement, button("Remove model service"));
    await click("Remove model service");
    await click("Remove connection");
    assert.ok(!catalog.services.some(service => service.id === remoteId));
    assert.equal(dom.window.document.activeElement, button("Add model service"));
    await click("Add model service");
    assert.equal(dom.window.document.activeElement, field("Connection name"));
    await type("Connection name", "Manual API");
    await type("API base URL", "https://api.example.com/v1");
    await type("Model ID", "manual-model");
    await click("Save connection");
    assert.equal(catalog.services.find(service => service.id === newId)?.model, "manual-model");
    assert.ok(!JSON.stringify(published).includes("synthetic-key"));
    assert.ok(!dom.container.textContent.includes("synthetic-key"));
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "manage-services"); console.log("model services interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
