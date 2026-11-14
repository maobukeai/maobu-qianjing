import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement, HTMLElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { ProxiesPage } from "../web/proxies.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  let calls = 0, writes: string[] = [], cancelled = false, copyDone: (() => void) | null = null;
  let signal: AbortSignal | null | undefined;
  const records = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
  const rows = Array.from({ length: 66 }, (_, index) => ({ type: "check", row: {
    key: `PRIVATE_KEY_${index}`, proxy: `http://proxy-${index}.example:8080`, status: index === 65 ? "working" : "failed", reason: index === 0 ? "PRIVATE_RAW_REASON" : "timeout", ip: `203.0.113.${index}`, checkedAt: 1,
    profiles: [{ id: `p${index}`, name: `Environment ${index}`, group: "Sales" }],
  } }));
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    assert.equal(input, "/ui/api/proxies/check"); assert.equal(options?.method, "POST"); calls++; signal = options?.signal;
    assert.deepEqual(JSON.parse(String(options?.body)), { scope: { all: true } });
    if (scenario === "cancel-partial") return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(records([{ type: "summary", selectedProfiles: 3, uniqueProxies: 3, duplicatesSkipped: 0 }, rows[0]]))); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
    return new Response(records([{ type: "summary", selectedProfiles: 66, uniqueProxies: 66, duplicatesSkipped: 0 }, ...rows, { type: "done" }]), { headers: { "Content-Type": "application/x-ndjson" } });
  }, { preconnect: globalThis.fetch.preconnect }) });
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
    writes.push(text);
    if (scenario === "clipboard-fallback") throw new Error("PRIVATE_CLIPBOARD_ERROR");
    if (scenario === "stale-copy") await new Promise<void>(resolve => { copyDone = resolve; });
  } } });
  const visible = <T extends HTMLElement>(selector: string) => [...dom.container.querySelectorAll<T>(selector)].filter(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string) => { const node = visible<HTMLButtonElement>("button").find(item => item.textContent?.trim() === label); assert.ok(node, `Missing ${label}`); return node; };
  const click = (label: string) => act(async () => { button(label).click(); });
  const setSearch = (value: string) => act(async () => { const input = visible<HTMLInputElement>('input[type="search"]')[0]!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), dom.container.textContent ?? "Missing results"); };
  try {
    await dom.render(<I18nProvider><ProxiesPage active groups={[]} onChanged={async () => { throw new Error("Checks must not change settings"); }} /></I18nProvider>);
    assert.equal(calls, 0); await click("Check proxies");
    await waitFor(() => visible("tbody tr").length > 0);
    if (scenario === "cancel-partial") {
      await click("Cancel"); await waitFor(() => cancelled && !dom.container.querySelector(".tools-progress"));
      assert.equal(signal?.aborted, true); assert.equal(visible("tbody tr").length, 1);
      assert.ok(dom.container.querySelector(".proxy-partial-note")?.textContent?.includes("environments without results"));
      await click("Copy all problem results"); assert.ok(writes[0]?.includes("Partial results only")); assert.equal(calls, 1);
      return;
    }
    await waitFor(() => !dom.container.querySelector(".tools-progress"));
    assert.equal(visible("tbody tr").length, 50);
    await setSearch("Environment 64"); assert.equal(visible("tbody tr").length, 1);
    const onlyProblems = visible<HTMLInputElement>('.proxy-choice input[type="checkbox"]')[0]!;
    await act(async () => { onlyProblems.click(); });
    await click("Copy all problem results"); assert.equal(writes.length, 1); assert.equal(calls, 1);
    const text = writes[0]!;
    assert.ok(text.includes("65 problem results · 65 affected environments"));
    assert.ok(text.includes("Environment 0 (p0; Sales)")); assert.ok(text.includes("Environment 64 (p64; Sales)"));
    assert.ok(text.includes("The check run finished."));
    for (const value of ["PRIVATE_", "203.0.113.", "Environment 65", "proxy-65.example"]) assert.ok(!text.includes(value), `Summary must omit ${value}`);
    if (scenario === "clipboard-fallback") {
      const textarea = visible<HTMLTextAreaElement>('.proxy-summary-fallback textarea')[0]; assert.ok(textarea); assert.equal(textarea.readOnly, true); assert.equal(textarea.value, text);
      assert.equal(dom.window.document.activeElement, textarea); assert.equal(textarea.selectionStart, 0); assert.equal(textarea.selectionEnd, text.length);
      assert.ok(!dom.container.textContent?.includes("PRIVATE_CLIPBOARD_ERROR")); await click("Hide summary"); assert.equal(visible(".proxy-summary-fallback").length, 0);
    } else if (scenario === "stale-copy") {
      assert.equal(button("Copying summary…").disabled, true); assert.ok(copyDone);
      await click("Check proxies"); await waitFor(() => !dom.container.querySelector(".tools-progress"));
      await act(async () => { copyDone!(); });
      assert.ok(!dom.container.querySelector(".proxy-summary-help [role=status]"), "A clipboard completion for old results must not acknowledge new results");
      assert.equal(calls, 2);
    } else {
      assert.ok(dom.container.querySelector(".proxy-summary-help [role=status]")?.textContent?.includes("copied without proxy authentication"));
      assert.equal(visible(".proxy-summary-fallback").length, 0);
    }
  } finally { (copyDone as (() => void) | null)?.(); await dom.cleanup(); }
}

await run(process.argv[2] ?? "copy-all-problems");
console.log("proxy recovery interaction fixture passed");
