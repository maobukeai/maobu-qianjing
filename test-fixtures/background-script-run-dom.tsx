import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLSelectElement, HTMLElement } from "happy-dom";
import type { ScriptRun } from "../src/scripts.ts";
import type { UiProfile } from "../web/api.ts";
import { BackgroundScriptRunButton, backgroundScriptRuns } from "../web/background-script-run.tsx";
import { ScriptRunPanel } from "../web/scripts.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const requests: string[] = [], unexpected: string[] = [];
  const starts: Array<ReturnType<typeof deferred<Response>>> = [], heldReads: Array<ReturnType<typeof deferred<Response>>> = [];
  let holdStatus = false, serverRun: ScriptRun | null = null;
  const script = { id: "script_fixture", name: "Fixture script", description: "Summary only", language: "javascript", revision: 1, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
  const makeRun = (id: string, status: ScriptRun["status"] = "running"): ScriptRun => ({ id, scriptName: id, status, profiles: [{ id: "profile_fixture", name: "Fixture environment", status: status === "finished" ? "succeeded" : "running" }] });
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push(`${method} ${path}`);
    if (path === "/ui/api/shell-language" && method === "GET") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/scripts" && method === "GET") return Response.json({ ok: true, scripts: [script] });
    if (path === "/ui/api/scripts/run") {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-capability");
      if (method === "GET") {
        if (holdStatus) { const response = deferred<Response>(); heldReads.push(response); return response.promise; }
        return Response.json({ ok: true, run: serverRun });
      }
      if (method === "POST") { const response = deferred<Response>(); starts.push(response); return response.promise; }
    }
    if (path.startsWith("/ui/api/scripts/log?") && method === "GET") return Response.json({ ok: true, text: "MONITOR_ONLY_LOG", nextOffset: 16 });
    unexpected.push(`${method} ${path}`); throw new Error(`Non-fixture request blocked: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string) => { assert.equal(command, "script_capability"); return "fixture-capability"; } } });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking disabled"); } });
  const profiles = [{ id: "profile_fixture", name: "Fixture environment", engine: "chromium", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, running: false }] as UiProfile[];
  function Surface() {
    const [open, setOpen] = useState(false), [otherPage, setOtherPage] = useState(false);
    return <><header><BackgroundScriptRunButton onViewRun={() => setOpen(true)} /><button type="button" data-open onClick={() => setOpen(true)}>Open run monitor</button><button type="button" data-refresh onClick={() => { void backgroundScriptRuns.refresh().catch(() => {}); }}>Explicit status read</button><button type="button" data-page onClick={() => setOtherPage(value => !value)}>Change page</button></header><main>{otherPage ? "Other workspace page" : "Environment list"}</main><ScriptRunPanel open={open} selectedProfiles={profiles} onClose={() => setOpen(false)} /></>;
  }
  const active = <T extends HTMLElement>(selector: string): T | null => [...dom.container.querySelectorAll<T>(selector)].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const monitor = () => active<HTMLElement>(".script-run-modal");
  const background = () => active<HTMLButtonElement>(".script-background-trigger");
  const button = (label: string, scope: HTMLElement = dom.container) => { const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[inert], [aria-hidden="true"]') && node.textContent?.trim() === label); assert.ok(value, `Missing ${label}`); return value; };
  const click = async (node: HTMLButtonElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const waitFor = async (condition: () => boolean, description: string) => { const until = Date.now() + 3500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${description}; requests=${JSON.stringify(requests)}; text=${dom.container.textContent?.slice(-1500)}`); };
  const open = async () => { await click(button("Open run monitor")); await waitFor(() => !!monitor() && monitor()?.querySelector('.modal-body')?.getAttribute("aria-busy") === "false", "The explicit monitor must finish reading metadata"); };
  const start = async () => {
    const select = monitor()!.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = script.id; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await click(button("Run script", monitor()!)); await waitFor(() => starts.length === 1, "Starting must require the user's explicit action");
  };
  const reads = () => requests.filter(request => request === "GET /ui/api/scripts/run").length;
  const logs = () => requests.filter(request => request.startsWith("GET /ui/api/scripts/log?")).length;
  try {
    await dom.render(<I18nProvider><Surface /></I18nProvider>);
    assert.equal(background(), null);
    if (scenario === "idle-no-probe") {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); });
      assert.equal(reads(), 0); assert.equal(logs(), 0); assert.equal(starts.length, 0);
      assert.ok(requests.every(request => request === "GET /ui/api/shell-language")); return;
    }
    if (scenario === "background-complete") {
      await open(); await start();
      serverRun = makeRun("Observed background run");
      const extraFields = { ...serverRun, source: "PRIVATE_SOURCE", log: "PRIVATE_LOG", credentials: { password: "PRIVATE_PASSWORD" }, inputs: { token: "PRIVATE_INPUT" } };
      await act(async () => { starts[0]!.resolve(Response.json({ ok: true, run: extraFields })); });
      await waitFor(() => !!background()?.textContent.includes("Script running"), "A real successful start must create a passive shell entry");
      assert.ok(!JSON.stringify(backgroundScriptRuns.getSnapshot()).includes("PRIVATE_"));
      await click(button("Close monitor", monitor()!)); assert.equal(monitor(), null);
      await click(button("Change page")); assert.equal(dom.container.querySelector("main")?.textContent, "Other workspace page");
      const readsBefore = reads(), logsBefore = logs();
      serverRun = makeRun("Observed background run", "finished");
      await waitFor(() => !!background()?.textContent.includes("Script finished"), "The shell must observe completion while the monitor is closed on another page");
      assert.equal(reads(), readsBefore + 1, "One shared background observer must own the completion read"); assert.equal(logs(), logsBefore, "The background entry must never read log contents");
      assert.ok(background()?.textContent.includes("1/1")); assert.ok(!dom.container.querySelector("header")?.textContent.includes("MONITOR_ONLY_LOG"));
      const finishedReads = reads(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); }); assert.equal(reads(), finishedReads, "Finished runs stop automatic polling but keep the entry");
      await click(background()!); await waitFor(() => !!monitor()?.textContent.includes("Observed background run · Finished"), "One click must reopen the completed run monitor");
      assert.equal(starts.length, 1); return;
    }
    if (scenario === "dedup-and-late") {
      holdStatus = true; await click(button("Explicit status read"), true);
      await waitFor(() => heldReads.length === 1, "Concurrent explicit views must share one actual API request"); assert.equal(reads(), 1);
      serverRun = makeRun("Old finished run", "finished"); holdStatus = false;
      await act(async () => { heldReads[0]!.resolve(Response.json({ ok: true, run: serverRun })); });
      await open(); await start();
      holdStatus = true; await click(button("Explicit status read"), true); await waitFor(() => heldReads.length === 2, "A pending pre-start metadata read must be shared");
      serverRun = makeRun("New authoritative run");
      await act(async () => { starts[0]!.resolve(Response.json({ ok: true, run: serverRun })); });
      assert.equal(backgroundScriptRuns.getSnapshot().run?.id, "New authoritative run");
      holdStatus = false; await act(async () => { heldReads[1]!.resolve(Response.json({ ok: true, run: makeRun("Old late finished response", "finished") })); });
      assert.equal(backgroundScriptRuns.getSnapshot().run?.id, "New authoritative run"); assert.ok(background()?.textContent.includes("Script running")); assert.ok(!monitor()?.textContent.includes("Old late finished response"));
      assert.equal(starts.length, 1); return;
    }
    throw new Error(`Unknown background fixture: ${scenario}`);
  } finally {
    try { await dom.cleanup(); } finally { backgroundScriptRuns.dispose(); assert.deepEqual(unexpected, []); assert.ok(!requests.some(request => request.includes("/scripts/stop")), "The observer must never stop a script"); }
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "idle-no-probe"); console.log("background script run interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
