import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { buildProfileEditPatch, captureProfileEditSnapshot } from "../web/profile-edit-patch.ts";
import { EditChangesSummary } from "../web/edit-changes-summary.tsx";
import { updateProfile } from "../web/api.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const scenario = process.argv[2] ?? "transport";
const initial = captureProfileEditSnapshot({ form: { name: "Environment", group: "Old group", platform: "x.com", proxy: "proxy.example:8080:person:PRIVATE_PROXY", proxyType: "http", username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", email: "PRIVATE_EMAIL", emailPassword: "PRIVATE_EMAIL_PASSWORD", twofa: "PRIVATE_2FA", resolution: "1920*1080", tags: "warmup, priority", customNo: "001", platformOs: "windows", timezone: "UTC", locale: "en-US", cores: "8", fingerprintSeed: "777" }, extensions: ["wallet"], engine: "chromium", timezoneManual: false });
const concurrentStored: Record<string, unknown> = { ...initial.form, password: "CONCURRENT_PRIVATE_PASSWORD", proxy: "concurrent.example:8080:person:CONCURRENT_PRIVATE_PROXY", tags: ["concurrent tag"] };
const saves: Array<{ set: Record<string, unknown>; response: ReturnType<typeof deferred<Response>> }> = [];
const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
  if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
  assert.equal(input, "/ui/api/profiles/fixture/update"); assert.equal(options?.method, "POST");
  const body = JSON.parse(String(options?.body)); assert.deepEqual(Object.keys(body), ["set"]);
  const response = deferred<Response>(); saves.push({ set: body.set, response }); return response.promise;
}, { preconnect: globalThis.fetch.preconnect }) });

function Editor() {
  const [form, setForm] = useState({ ...initial.form }), [extensions, setExtensions] = useState([...initial.extensions]);
  const [pending, setPending] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState("");
  const result = buildProfileEditPatch(initial, { form, extensions });
  const save = async () => {
    if (!result.summary.hasChanges || pending || saved) return;
    setPending(true); setError("");
    try { const response = await updateProfile("fixture", result.patch); if (response.ok === true) setSaved(true); else setError("Changes could not be saved; the draft remains."); }
    catch { setError("Changes could not be saved; the draft remains."); }
    finally { setPending(false); }
  };
  return <I18nProvider><label>Environment name<input aria-label="Environment name" value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
    <button type="button" onClick={() => setForm(current => ({ ...current, password: "" }))}>Clear password</button>
    <button type="button" onClick={() => { setForm(current => ({ ...current, resolution: "1600x900", proxy: "next.example:8080:person:NEW_PRIVATE_PROXY" })); setExtensions([]); }}>Change browser settings</button>
    <button type="button" onClick={() => setForm(current => ({ ...current, locale: "" }))}>Clear language</button>
    <button type="button" onClick={() => setForm(current => ({ ...current, group: "New group" }))}>Move group</button>
    <EditChangesSummary summary={result.summary} running={scenario === "running-preview"} busy={pending} />
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Saved</p>}
    <button type="button" disabled={pending || saved || !result.summary.hasChanges} onClick={() => void save()}>Save changes</button>
  </I18nProvider>;
}
const button = (label: string) => { const item = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label); assert.ok(item); return item; };
const click = (label: string) => act(async () => { button(label).click(); });
const preview = () => dom.container.querySelector(".edit-changes-summary")!;
const respond = (index: number, ok: boolean) => act(async () => { if (ok) Object.assign(concurrentStored, saves[index]!.set); saves[index]!.response.resolve(Response.json({ ok, ...(ok ? {} : { error: "PRIVATE_SERVER_ERROR" }) }, { status: ok ? 200 : 500 })); });
try {
  await dom.render(<Editor />); assert.equal(button("Save changes").disabled, true); assert.equal(saves.length, 0); assert.ok(preview().textContent?.includes("No changes to save"));
  if (scenario === "noop") { await click("Save changes"); assert.equal(saves.length, 0); }
  else if (scenario === "locale-clear") {
    await click("Clear language"); assert.equal(button("Save changes").disabled, true); assert.ok(preview().textContent?.includes("keeps the saved language")); await click("Save changes"); assert.equal(saves.length, 0);
  } else if (scenario === "running-preview") {
    await click("Change browser settings"); assert.equal(preview().querySelectorAll("li").length, 3); assert.ok(preview().textContent?.includes("The open browser keeps its current settings"));
    assert.ok(preview().textContent?.includes("Proxy settings")); assert.ok(!preview().textContent?.includes("PRIVATE")); assert.ok(!preview().textContent?.includes("next.example")); assert.ok(!preview().textContent?.includes("1600")); assert.equal(saves.length, 0);
  } else if (scenario === "retry-clear") {
    await click("Clear password"); assert.ok(preview().textContent?.includes("Password")); assert.ok(preview().textContent?.includes("Cleared")); await click("Save changes"); assert.deepEqual(saves[0]!.set, { password: "" });
    await respond(0, false); assert.ok(dom.container.querySelector('[role="alert"]')); assert.ok(!dom.container.textContent?.includes("PRIVATE_SERVER_ERROR")); assert.equal(button("Save changes").disabled, false);
    await click("Save changes"); assert.deepEqual(saves[1]!.set, { password: "" }); await respond(1, true); assert.equal(concurrentStored.password, ""); assert.equal(concurrentStored.email, "PRIVATE_EMAIL");
  } else if (scenario === "group-defaults") {
    await click("Move group"); assert.ok(preview().textContent?.includes("extension defaults may apply")); await click("Save changes"); assert.deepEqual(saves[0]!.set, { group: "New group" }); await respond(0, true);
  } else {
    assert.equal(scenario, "transport"); const name = dom.container.querySelector<HTMLInputElement>('input[aria-label="Environment name"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "Renamed only"); name.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    assert.equal(preview().querySelectorAll("li").length, 1); assert.equal(button("Save changes").disabled, false); await click("Save changes"); assert.deepEqual(saves[0]!.set, { name: "Renamed only" });
    await respond(0, true); assert.equal(concurrentStored.password, "CONCURRENT_PRIVATE_PASSWORD"); assert.equal(concurrentStored.proxy, "concurrent.example:8080:person:CONCURRENT_PRIVATE_PROXY"); assert.deepEqual(concurrentStored.tags, ["concurrent tag"]);
  }
  assert.ok(!preview().textContent?.includes("PRIVATE")); console.log("profile edit patch interaction fixture passed");
} finally { for (const save of saves) save.response.resolve(Response.json({ ok: false })); await dom.cleanup(); }
