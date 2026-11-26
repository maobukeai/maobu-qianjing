import assert from "node:assert/strict";
import { act } from "react";
import { I18nProvider } from "../web/i18n.tsx";
import { ProxiesPage } from "../web/proxies.tsx";
import type { ProxyScopeProfile } from "../web/proxy-workflow.ts";
import { createWebDomHarness } from "./web-dom.ts";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";

async function run(scenario: string) {
  const calls: Array<{ path: string; body: any; signal?: AbortSignal | null }> = [];
  let previewCount = 0, changed = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let profiles: ProxyScopeProfile[] = [
    { id: "p1", group: "Sales", running: false, proxy: "old.example:8080" },
    { id: "p2", group: "Sales", running: true, proxy: null },
    { id: "p3", group: "Support", running: false, proxy: "invalid.example:8080", proxyError: "invalid" },
  ];
  const records = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const operationScope = "38f91eb9-c2fb-4d32-9d25-e51db5ca0681";
  const repairOutcomes = [
    { index: 0, profileId: "p1", status: "updated" },
    { index: 1, profileId: "p2", status: "skipped", code: "profile_open" },
  ];
  let appliedRepair: { attemptId: string; previewId: string; operationScope: string } | null = null;
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://fixture.invalid"), path = url.pathname;
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (scenario === "targeted-receipt" && path.startsWith("/ui/api/proxies/operations/")) {
      assert.equal(url.searchParams.get("operationScope"), operationScope);
      assert.equal(url.searchParams.get("previewId"), "targeted-preview-1");
      if (!appliedRepair) return Response.json({ ok: false, code: "operation_not_found" }, { status: 404 });
      assert.equal(path.split("/").at(-1), appliedRepair.attemptId);
      return Response.json({ ok: true, operation: { ...appliedRepair, version: 1, phase: "settled", total: 2, rows: repairOutcomes, startedAt: 1, finishedAt: 2 } });
    }
    const body = JSON.parse(String(options?.body));
    calls.push({ path, body, signal: options?.signal });
    assert.equal(options?.method, "POST");
    if (path === "/ui/api/proxies/preview") {
      previewCount++;
      if (scenario === "targeted-replacement" || scenario === "targeted-receipt") {
        const second = scenario === "targeted-replacement" && previewCount === 1 ? "p3" : "p2";
        return Response.json({ ok: true, previewId: `targeted-preview-${previewCount}`, operationScope, unusedProxies: 0, rows: [
          { index: 0, profileId: "p1", name: "Environment One", group: "Sales", previousProxy: "http://old.example:8080", proxy: "http://new.example:8080", status: "ready" },
          { index: 1, profileId: second, name: "Second target", group: "Sales", previousProxy: null, proxy: "http://new.example:8080", status: "skipped", code: "profile_open" },
        ] });
      }
      return Response.json({ ok: true, previewId: `preview-${previewCount}`, operationScope: "38f91eb9-c2fb-4d32-9d25-e51db5ca0681", unusedProxies: 0, rows: [
        { index: 0, profileId: "p1", name: "Environment One", group: "Sales", previousProxy: "http://old.example:8080", proxy: "http://new.example:8080", status: previewCount > 1 ? "skipped" : "ready", ...(previewCount > 1 ? { code: "profile_open" } : {}) },
      ] });
    }
    if (path === "/ui/api/proxies/check") {
      if (scenario === "targeted-replacement" || scenario === "targeted-receipt") {
        return new Response(records([
          { type: "summary", selectedProfiles: 3, uniqueProxies: 2, duplicatesSkipped: 1 },
          { type: "check", row: { key: "failure", proxy: "old.example:8080", status: "failed", checkedAt: 1, profiles: [{ id: "p1", name: "Environment One", group: "Sales" }, { id: "p2", name: "Environment Two", group: "Sales" }] } },
          { type: "check", row: { key: "invalid", proxy: "invalid.example:8080", status: "invalid", checkedAt: 1, profiles: [{ id: "p3", name: "Unrelated", group: "Support" }] } },
          { type: "done" },
        ]), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (scenario === "operation-context") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(records([{ type: "summary", selectedProfiles: 1, uniqueProxies: 1, duplicatesSkipped: 0 }, { type: "progress", phase: "checking", completed: 0, total: 1 }])));
      } }), { headers: { "Content-Type": "application/x-ndjson" } });
      const rows = Array.from({ length: 65 }, (_, index) => ({ type: "check", row: {
        key: String(index), proxy: `proxy-${index}.example:8080`, ip: `192.0.2.${index}`, status: index === 64 ? "failed" : "working", checkedAt: Date.now(), profiles: [{ id: `row-${index}`, name: `Environment ${index}`, group: "Sales" }],
      } }));
      return new Response(records([{ type: "summary", selectedProfiles: 65, uniqueProxies: 65, duplicatesSkipped: 0 }, ...rows, { type: "done" }]), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (scenario === "targeted-receipt" && path === "/ui/api/proxies/apply") {
      assert.equal(appliedRepair, null);
      assert.deepEqual(Object.keys(body).sort(), ["attemptId", "operationScope", "previewId"]);
      assert.equal(body.previewId, "targeted-preview-1");
      assert.equal(body.operationScope, operationScope);
      appliedRepair = body;
      return new Response(records([...repairOutcomes.map(row => ({ type: "replacement", row })), { type: "done" }]), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected owned fixture path: ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });
  let loadingProfiles = scenario === "loading-scope";
  let taskFocusHandled = 0;
  const acknowledgeTaskFocus = () => { taskFocusHandled++; };
  const render = (active = true, focusTask = false) => dom.render(<I18nProvider><ProxiesPage groups={["Sales", "Support"]} folders={scenario === "folder-hierarchy" ? [{ name: "Sales" }, { name: "Support", parentName: "Sales" }] : []} profiles={profiles} loadingProfiles={loadingProfiles} active={active} focusTask={focusTask} onTaskFocused={acknowledgeTaskFocus} onChanged={async () => { changed++; }} /></I18nProvider>);
  const button = (label: string) => {
    const result = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);
    assert.ok(result, `Missing button ${label}`); return result;
  };
  const tab = (kind: "check" | "replace") => {
    const result = dom.container.querySelector<HTMLButtonElement>(`.tools-tabs button[data-proxy-tab="${kind}"]`);
    assert.ok(result, `Missing tool ${kind}`); return result;
  };
  const click = (label: string) => act(async () => { button(label).click(); });
  const input = () => dom.container.querySelector("textarea")!;
  const setValue = (element: any, value: string) => act(async () => {
    const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await render();
    assert.equal(calls.length, 0, "Opening a proxy workspace must not start checks");
    if (scenario === "workflow-navigation") {
      assert.equal(dom.container.querySelector('.proxy-workflow-navigation'), null, "Replacement steps belong to the replacement workflow only");
      await act(async () => tab("replace").click());
      const navigation = dom.container.querySelector('.proxy-workflow-navigation')!;
      const step = (key: string) => navigation.querySelector<HTMLButtonElement>(`[data-proxy-workflow-step="${key}"]`)!;
      assert.equal(navigation.querySelectorAll('button').length, 4);
      assert.equal(step("review").disabled, true, "A review destination requires an actual preview");
      assert.equal(step("receipt").disabled, true, "A receipt destination requires an actual operation result");
      assert.ok(navigation.querySelector('.proxy-workflow-count')?.textContent?.includes("3 environments"));
      const draft = "new.example:8080:fixture:PRIVATE_NAVIGATION_SECRET";
      await setValue(input(), draft);
      await act(async () => step("input").click());
      assert.equal(dom.window.document.activeElement?.id, step("input").getAttribute('aria-controls'));
      assert.equal(input().value, draft);
      await act(async () => step("scope").click());
      assert.equal(dom.window.document.activeElement?.id, step("scope").getAttribute('aria-controls'));
      assert.equal(calls.length, 0, "Step navigation must never preview, check or apply proxies");
      await click("Preview changes");
      assert.equal(step("review").disabled, false);
      await act(async () => step("review").click());
      assert.equal(dom.window.document.activeElement?.id, step("review").getAttribute('aria-controls'));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.path, "/ui/api/proxies/preview");
      assert.ok(!navigation.textContent?.includes("PRIVATE_NAVIGATION_SECRET"), "The persistent summary must not repeat proxy credentials");
      await click("Discard review");
      assert.equal(step("review").disabled, true);
      assert.equal(step("receipt").disabled, true);
      assert.equal(input().value, draft, "Discarding review must leave the input owner intact");
      await render(false); await render();
      assert.equal(input().value, draft);
      assert.equal(calls.length, 1, "Returning to the page does not issue another request");
      return;
    }
    if (scenario === "loading-scope") {
      assert.equal(button("Check proxies").disabled, true);
      assert.equal(dom.container.querySelector(".proxy-scope-summary"), null);
      assert.ok(dom.container.querySelector(".proxy-scope-loading")?.textContent?.includes("Loading saved environments"));
      assert.ok(!dom.container.textContent?.includes("No saved environments match"));
      loadingProfiles = false; await render();
      assert.equal(button("Check proxies").disabled, false);
      assert.equal(calls.length, 0);
      return;
    }
    const overview = dom.container.querySelector(".proxy-scope-summary")!;
    assert.deepEqual([...overview.querySelectorAll("strong")].map(item => item.textContent), ["3", "1", "1", "1"]);
    if (scenario === "targeted-receipt") {
      await click("Check proxies");
      const source = dom.container.querySelector<HTMLButtonElement>('[data-proxy-repair-source="p1"]');
      assert.ok(source);
      await act(async () => source.click());
      await setValue(input(), "new.example:8080:fixture-user:fixture-pass");
      await setValue(dom.container.querySelector('input[aria-label="Profiles per proxy"]')!, "2");
      await click("Preview changes");
      await click("Apply 1 changes");
      await act(async () => { await Promise.resolve(); });
      const heading = dom.container.querySelector("[data-proxy-review-title]");
      assert.equal(heading?.textContent, "Proxy replacement receipt");
      assert.equal(dom.window.document.activeElement, heading);
      assert.equal(dom.container.querySelector(".proxy-input-panel"), null);
      assert.equal(button("Preview failed rows again").disabled, false);
      assert.equal(changed, 1);
      await act(async () => tab("check").click());
      assert.ok(button("Return to replacement receipt"));
      await click("Return to replacement receipt");
      await click("Back to proxy checks");
      assert.ok(dom.container.textContent?.includes("Changed or unconfirmed environments were removed"));
      assert.equal(dom.container.querySelector('[data-proxy-repair-source="p1"]'), null);
      assert.ok(dom.container.querySelector('[data-proxy-repair-source="p2"]'), "A skipped environment still has a usable check result");
      assert.ok(dom.container.querySelector('[data-proxy-repair-source="p3"]'), "An unrelated problem remains available for repair");
      assert.equal(calls.filter(call => call.path === "/ui/api/proxies/check").length, 1, "Applying a replacement must not start another check");
      const beforeReopening = calls.length;
      await render(true, true);
      const reopened = dom.container.querySelector("[data-proxy-review-title]");
      assert.equal(reopened?.textContent, "Proxy replacement receipt");
      assert.equal(dom.window.document.activeElement, reopened);
      assert.equal(taskFocusHandled, 1);
      assert.equal(dom.container.querySelector(".proxy-input-panel"), null);
      assert.equal(calls.length, beforeReopening, "A task link must reopen only its redacted current receipt");
      await render();
      await click("Back to proxy checks");
      await click("Check proxies");
      assert.ok(!dom.container.textContent?.includes("Changed or unconfirmed environments were removed"));
      assert.equal(calls.filter(call => call.path === "/ui/api/proxies/apply").length, 1);
      return;
    }
    if (scenario === "targeted-replacement") {
      await act(async () => tab("replace").click());
      await setValue(input(), "manual.example:9090");
      await act(async () => tab("check").click());
      await click("Check proxies");
      const repairSource = () => dom.container.querySelector<HTMLButtonElement>('[data-proxy-repair-source="p1"]');
      assert.ok(repairSource());
      await act(async () => repairSource()!.click());
      assert.equal(calls.length, 1, "Choosing a result must not start a preview or write");
      assert.equal(input().value, "", "A targeted repair must have its own empty input");
      const repairScope = dom.container.querySelector(".proxy-repair-scope");
      assert.ok(repairScope?.textContent?.includes("Environment One"));
      assert.ok(repairScope?.textContent?.includes("Environment Two"));
      assert.ok(!repairScope?.textContent?.includes("Unrelated"));
      assert.equal(dom.window.document.activeElement, repairScope?.querySelector("h3"));
      assert.equal(button("Preview changes").disabled, true);
      await setValue(input(), "new.example:8080");
      await setValue(dom.container.querySelector('input[aria-label="Profiles per proxy"]')!, "2");
      await click("Preview changes");
      assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("did not match these environments"));
      assert.equal([...dom.container.querySelectorAll("button")].some(node => /^Apply \d+ changes$/.test(node.textContent?.trim() ?? "")), false);
      assert.deepEqual(calls[1]?.body, { scope: { all: true, ids: ["p1", "p2"] }, mode: "list", input: "new.example:8080", profilesPerProxy: 2 });
      await click("Preview changes");
      assert.equal(button("Apply 1 changes").disabled, false);
      assert.ok(dom.container.querySelector("tbody")?.textContent?.includes("Second target"));
      await act(async () => tab("check").click());
      await click("Return to replacement draft");
      assert.equal(input().value, "new.example:8080");
      assert.equal(previewCount, 2);
      profiles = profiles.filter(profile => profile.id !== "p2");
      await render();
      assert.equal(button("Apply 1 changes").disabled, true);
      assert.ok(repairScope?.textContent?.includes("Some environments from this check are unavailable"));
      await click("Discard replacement draft");
      assert.equal(dom.window.document.activeElement, repairSource());
      await act(async () => tab("replace").click());
      assert.equal(input().value, "manual.example:9090");
      assert.equal(calls.filter(call => call.path.endsWith("/apply")).length, 0);
      assert.equal(changed, 0);
      return;
    }
    if (scenario === "folder-hierarchy") {
      const choices = [...dom.container.querySelectorAll<HTMLInputElement>(".folder-chip input")];
      assert.equal(choices.length, 3);
      await act(async () => { choices[2]!.click(); });
      assert.equal(choices[1]!.checked, false, "A partly selected folder must not look fully selected");
      assert.equal(choices[1]!.indeterminate, true);
      assert.equal(choices[0]!.indeterminate, true);
      assert.equal(dom.container.querySelector(".proxy-scope-summary strong")?.textContent, "2");
      await act(async () => { choices[1]!.click(); });
      assert.equal(choices[1]!.indeterminate, false); assert.equal(choices[1]!.checked, true);
      assert.equal(choices[2]!.checked, true);
      assert.equal(choices[0]!.checked, true);
      assert.equal(calls.length, 0);
      return;
    }
    if (scenario === "input-validation" || scenario === "stale-preview") {
      await act(async () => { tab("replace").click(); });
      if (scenario === "input-validation") {
        await setValue(input(), "new.example:8080:user:PRIVATE_FIXTURE_SECRET\ninvalid-line");
        assert.equal(input().getAttribute("aria-invalid"), "true");
        assert.equal(button("Preview changes").disabled, true);
        assert.ok(dom.container.querySelector(".proxy-input-feedback")?.textContent?.includes("line numbers 2"));
        assert.ok(!dom.container.querySelector(".proxy-input-feedback")?.textContent?.includes("PRIVATE_FIXTURE_SECRET"));
        await setValue(input(), "new.example:8080:user:PRIVATE_FIXTURE_SECRET");
        const perProxy = dom.container.querySelector<HTMLInputElement>('input[aria-label="Profiles per proxy"]')!;
        await setValue(perProxy, ""); assert.equal(perProxy.value, "", "The number field must be editable without forcing 1 into an empty draft");
        assert.equal(button("Preview changes").disabled, true);
        await setValue(perProxy, "2"); assert.equal(button("Preview changes").disabled, false);
        await click("Preview changes");
        assert.equal(previewCount, 1); assert.equal(calls[0]!.body.profilesPerProxy, 2);
        assert.ok(!dom.container.querySelector(".proxy-table")?.textContent?.includes("PRIVATE_FIXTURE_SECRET"));
        return;
      }
      await setValue(input(), "new.example:8080"); await click("Preview changes");
      assert.equal(button("Apply 1 changes").disabled, false);
      profiles = profiles.map(profile => profile.id === "p1" ? { ...profile, running: true } : profile);
      await render();
      assert.equal(button("Apply 1 changes").disabled, true);
      assert.ok(dom.container.querySelector(".proxy-preview-warning")?.textContent?.includes("Selected environments changed"));
      await act(async () => { button("Apply 1 changes").click(); });
      assert.equal(calls.length, 1, "An outdated preview must not submit");
      await act(async () => { dom.container.querySelector<HTMLButtonElement>(".proxy-preview-warning button")!.click(); });
      assert.equal(previewCount, 2);
      assert.equal(button("Apply 0 changes").disabled, true);
      assert.equal(dom.container.querySelector(".proxy-preview-warning"), null);
      assert.equal(changed, 0);
      return;
    }
    await click("Check proxies");
    if (scenario === "operation-context") {
      assert.equal(tab("replace").disabled, true);
      assert.ok(dom.container.querySelector(".tools-progress")?.textContent?.includes("leave this page"));
      await render(false);
      assert.equal(calls[0]!.signal?.aborted, false, "Leaving the global page must not silently cancel the owned operation");
      assert.ok(stream);
      await act(async () => {
        stream!.enqueue(new TextEncoder().encode(records([{ type: "check", row: { key: "failed", proxy: "proxy.example:8080", status: "failed", checkedAt: Date.now(), profiles: [{ id: "p1", name: "Environment One", group: "Sales" }] } }, { type: "done" }])));
        stream!.close();
      });
      await dom.flush(); await render();
      assert.equal(tab("replace").disabled, false);
      assert.ok(dom.container.querySelector(".proxy-outcome")?.textContent?.includes("1 environments have results: 0 reachable, 1 needing review"));
      assert.equal(button("Retry failed checks").disabled, false);
      assert.equal(calls.length, 1);
    } else if (scenario === "result-search") {
      await dom.flush(); assert.equal(dom.container.querySelectorAll("tbody tr").length, 50);
      const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await setValue(search, "Environment 64");
      assert.equal(dom.container.querySelectorAll("tbody tr").length, 1);
      assert.ok(dom.container.querySelector("tbody")?.textContent?.includes("Environment 64"));
      await setValue(search, "does-not-match");
      assert.equal(dom.container.querySelectorAll("tbody tr").length, 0);
      assert.ok(dom.container.querySelector(".tools-result-empty")?.textContent?.includes("No results match"));
      assert.equal(calls.length, 1, "Result searches are local and do not run more network checks");
    } else throw new Error(`Unknown fixture scenario: ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "input-validation"); console.log("proxy usability interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
