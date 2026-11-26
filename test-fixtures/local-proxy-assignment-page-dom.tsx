import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import type { ProxyReplacementView } from "../proxy-tools-types.ts";
import { I18nProvider } from "../web/i18n.tsx";
import type { LocalProxyAssignmentIntent } from "../web/local-proxy-assignment-draft.tsx";
import { ProxiesPage } from "../web/proxies.tsx";
import type { ProxyAssignmentAttempt, ProxyAssignmentSnapshot } from "../web/proxy-assignment-task.ts";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const operationScope = "b5df5791-fc55-45c3-866a-6b2846f3bea3";
const manualPreviewId = "1.8591990b-e708-4d5a-af9b-21961a79dc02";
const localPreviewId = "2.c8a00b04-a28b-4a38-8bd1-b266aa6c3e55";
const endpoint = "socks5://[::1]:1080";

async function run(scenario: string) {
  const coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });
  let profiles = Array.from({ length: 26 }, (_, index) => ({ id: `p${index}`, name: `Environment ${index}`, group: index % 2 ? "Support" : "Sales", proxy: null, running: false }));
  let intent: LocalProxyAssignmentIntent | undefined;
  let applied: ProxyAssignmentAttempt | undefined;
  let refreshed = 0;
  let resultRows: ProxyReplacementView[] = [];
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const snapshots: ProxyAssignmentSnapshot[] = [];
  const dismissed: Array<{ id: number; returnToSettings?: boolean }> = [];
  const manualText = "manual.invalid:8080";

  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://fixture.invalid");
    const method = options?.method ?? "GET", path = url.pathname;
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ method, path, body });
    if (path === "/ui/api/proxies/preview" && method === "POST") {
      if (body.mode === "list") {
        assert.deepEqual(body, { scope: { groups: ["Sales"] }, mode: "list", input: manualText, profilesPerProxy: 1 });
        return Response.json({ ok: true, previewId: manualPreviewId, operationScope, unusedProxies: 0, rows: [
          { index: 0, profileId: "p0", name: "Environment 0", group: "Sales", previousProxy: null, proxy: "http://manual.invalid:8080", status: "ready" },
        ] });
      }
      assert.deepEqual(body, {
        mode: "single", scope: { ids: ["p1", "p24"] }, proxy: { type: "socks5", host: "::1", port: 1080, user: "fixture", pass: "private-pass" }, requiresAuthentication: true,
      });
      resultRows = (body.scope.ids as string[]).map((id, index) => ({
        index, profileId: scenario === "wrong-preview-target" && index === 1 ? "p25" : id, name: profiles.find(profile => profile.id === id)?.name,
        group: profiles.find(profile => profile.id === id)?.group, previousProxy: null, proxy: endpoint, status: "ready",
      }));
      return Response.json({ ok: true, previewId: localPreviewId, operationScope, rows: resultRows, unusedProxies: 0 });
    }
    if (path.startsWith("/ui/api/proxies/operations/") && method === "GET") {
      if (!applied) return Response.json({ ok: false, code: "operation_not_found" }, { status: 404 });
      assert.equal(url.searchParams.get("operationScope"), operationScope);
      assert.equal(url.searchParams.get("previewId"), localPreviewId);
      return Response.json({ ok: true, operation: { version: 1, ...applied, phase: "settled", total: 2, startedAt: 1, finishedAt: 2,
        rows: resultRows.map(({ index, profileId, status }) => ({ index, profileId, status })) } });
    }
    if (path === "/ui/api/proxies/apply" && method === "POST") {
      assert.equal(body.previewId, localPreviewId);
      assert.equal(body.operationScope, operationScope);
      assert.deepEqual(Object.keys(body).sort(), ["attemptId", "operationScope", "previewId"]);
      assert.equal(coordinator.getSnapshot().operation?.kind, "profile-proxies");
      applied = body;
      resultRows = resultRows.map(row => ({ ...row, status: "updated" }));
      const events = [...resultRows.map(row => ({ type: "replacement", row })), { type: "done" }];
      return new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected stage16 fixture call ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });

  const render = () => dom.render(<I18nProvider><WorkspaceOperationsProvider coordinator={coordinator}>
    <ProxiesPage groups={["Sales", "Support"]} active profiles={profiles} onChanged={async () => { refreshed++; }}
      localAssignmentIntent={intent} onDismissLocalAssignmentIntent={(id, options) => { dismissed.push({ id, ...options }); intent = undefined; }}
      onTaskSnapshotChange={snapshot => snapshots.push(snapshot)} />
  </WorkspaceOperationsProvider></I18nProvider>);
  const button = (label: string) => {
    const item = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent?.trim() === label);
    assert.ok(item, `Missing button ${label}`);
    return item;
  };
  const click = (label: string) => act(async () => { button(label).click(); });
  const draft = () => dom.container.querySelector(".local-proxy-assignment")!;
  const manualInput = () => dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Replacement input"]')!;
  const localInput = (type: string) => draft().querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
  const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const select = (name: string) => act(async () => {
    const row = [...draft().querySelectorAll("li")].find(item => item.querySelector("strong")?.textContent === name);
    assert.ok(row, `Missing target ${name}`);
    row.querySelector<HTMLInputElement>("input")!.click();
  });

  try {
    await render();
    await act(async () => { dom.container.querySelector<HTMLButtonElement>('.tools-tabs button[data-proxy-tab="replace"]')!.click(); });
    await act(async () => { dom.container.querySelectorAll<HTMLInputElement>(".folder-chip input")[2]!.click(); });
    await type(manualInput(), manualText);
    await click("Preview changes");
    assert.equal(button("Apply 1 changes").disabled, false);

    intent = { requestId: 42, workspaceId: "one", candidate: { type: "socks5", host: "::1", port: 1080, evidence: "handshake", socks5AuthRequired: true } };
    await render();
    assert.equal(calls.length, 1, "Opening the draft must not replace or check the previous proxy review");
    assert.equal(dom.window.document.activeElement, draft().querySelector("[data-local-proxy-draft-title]"));
    assert.equal(draft().querySelectorAll("li").length, 24);
    assert.equal(draft().querySelectorAll("li input:checked").length, 0);
    assert.equal(button("Preview selected environments").disabled, true);
    assert.equal(button("Apply 1 changes").disabled, false, "The previous review remains available before confirmation");
    let otherTask: ReturnType<typeof coordinator.acquire> = null;
    await act(async () => { otherTask = coordinator.acquire("profile-batch"); });
    assert.ok(otherTask);
    assert.ok(draft().querySelector<HTMLInputElement>("li input")?.disabled);
    assert.equal(button("Cancel").disabled, false, "A draft queued behind another task can still be dismissed");
    await act(async () => { if (otherTask) coordinator.release(otherTask); });

    await type(localInput("search"), "environment 1");
    await select("Environment 1");
    await type(localInput("search"), "");
    const next = [...draft().querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Next")!;
    await act(async () => next.click());
    assert.equal(draft().querySelectorAll("li").length, 2);
    await select("Environment 24");
    assert.match(draft().querySelector(".local-proxy-selection-count")!.textContent!, /2 selected/);
    assert.equal(button("Preview selected environments").disabled, true, "A required SOCKS5 login needs both fields");
    await type(localInput("text"), "fixture");
    await type(localInput("password"), "private-pass");
    assert.equal(draft().textContent?.includes("private-pass"), false);

    await click("Preview selected environments");
    assert.equal(calls.length, 1);
    assert.equal(dom.window.document.activeElement, button("Keep current review"));
    await click("Keep current review");
    assert.equal(dom.window.document.activeElement, button("Preview selected environments"));
    assert.equal(calls.length, 1);
    await click("Preview selected environments");
    await act(async () => { const submit = button("Replace review and preview"); submit.click(); submit.click(); });
    assert.equal(calls.length, 2, "Same-frame clicks cannot create multiple previews");
    assert.equal(manualInput().value, manualText);

    if (scenario === "wrong-preview-target") {
      assert.match(draft().textContent!, /preview could not be prepared/);
      assert.equal(localInput("password").value, "private-pass");
      assert.equal(applied, undefined);
      await click("Cancel");
      assert.deepEqual(dismissed, [{ id: 42, returnToSettings: true }]);
      await render();
      assert.equal(dom.container.querySelector(".local-proxy-assignment"), null);
      assert.equal(manualInput().value, manualText);
      assert.equal(calls.length, 2);
      return;
    }

    assert.deepEqual(dismissed, [{ id: 42 }]);
    await render();
    assert.equal(dom.container.querySelector(".local-proxy-assignment"), null);
    assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-proxy-review-title]"));
    assert.match(dom.container.querySelector("tbody")!.textContent!, /Environment 1/);
    assert.match(dom.container.querySelector("tbody")!.textContent!, /Environment 24/);
    assert.equal(dom.container.querySelector("tbody")!.textContent?.includes("manual.invalid"), false);
    assert.equal(dom.container.querySelectorAll<HTMLInputElement>(".folder-chip input")[2]!.checked, false, "Local selection must not change the manual folder scope");
    await act(async () => { dom.container.querySelectorAll<HTMLInputElement>(".folder-chip input")[1]!.click(); });
    assert.equal(button("Apply 2 changes").disabled, false, "A local review remains valid when manual folder selection is empty");
    profiles = profiles.map(profile => profile.id === "p0" ? { ...profile, running: true } : profile);
    await render();
    assert.equal(button("Apply 2 changes").disabled, false, "An unselected row does not invalidate the local preview");
    profiles = profiles.map(profile => profile.id === "p24" ? { ...profile, running: true } : profile);
    await render();
    assert.equal(button("Apply 2 changes").disabled, true, "A selected row changed after the local preview");
    profiles = profiles.map(profile => profile.id === "p24" ? { ...profile, running: false } : profile);
    await render();
    await click("Apply 2 changes");
    assert.equal(refreshed, 1);
    assert.equal(snapshots.at(-1)?.latest?.summary.updated, 2);
    assert.equal(coordinator.getSnapshot().operation, null);
    assert.equal(manualInput().value, manualText);
    const serialized = JSON.stringify(snapshots);
    for (const value of ["fixture", "private-pass", endpoint, localPreviewId]) assert.ok(!serialized.includes(value));
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "handoff"); console.log("local proxy assignment fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
