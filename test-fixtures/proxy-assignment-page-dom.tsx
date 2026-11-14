import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLTextAreaElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { ProxiesPage } from "../web/proxies.tsx";
import type { ProxyAssignmentAttempt, ProxyAssignmentSnapshot } from "../web/proxy-assignment-task.ts";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const operationScope = "38f91eb9-c2fb-4d32-9d25-e51db5ca0681";
const initialPreviewId = "1.534f60cd-836f-45c5-b183-5ea8b22cf377";
const retryPreviewId = "2.31db81e1-126e-4aaf-974d-d2caab769ed6";
const proxy = "http://fixture:PRIVATE_PROXY_SECRET@new.invalid:8080";
const rows = [
  { index: 0, profileId: "p1", name: "Environment One", group: "Sales", previousProxy: "http://old.invalid:8080", proxy, status: "ready" },
  { index: 1, profileId: "p2", name: "Environment Two", group: "Sales", previousProxy: "http://old.invalid:8080", proxy, status: "ready" },
];
const firstResults = [{ ...rows[0]!, status: "updated" }, { ...rows[1]!, status: "failed", code: "update_failed" }];
const retryResults = [{ ...rows[1]!, status: "updated" }];
const coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });

async function run(scenario: string) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const applied = new Map<string, ProxyAssignmentAttempt>();
  const snapshots: ProxyAssignmentSnapshot[] = [];
  let statusAvailable = false, refreshFails = true, refreshes = 0, viewRefreshes = 0, receiptDeliveryStopped = false;
  const unregister = coordinator.registerWorkspaceRefresh(async () => {
    assert.equal(coordinator.getSnapshot().operation?.phase, "refreshing");
    viewRefreshes++;
  });

  function complete(attempt: ProxyAssignmentAttempt) {
    const results = attempt.previewId === retryPreviewId ? retryResults : firstResults;
    return Response.json({ ok: true, operation: {
      version: 1, ...attempt, phase: "settled", total: results.length, startedAt: 1, finishedAt: 2,
      rows: results.map(result => ({ index: result.index, profileId: result.profileId, status: result.status, ...(result.status === "failed" ? { code: "update_failed" } : {}) })),
    } });
  }

  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://fixture.invalid"), path = url.pathname, method = options?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, method, body });
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    if (path === "/ui/api/proxies/preview" && method === "POST") return Response.json({ ok: true, previewId: initialPreviewId, operationScope, rows, unusedProxies: 0 });
    if (path === "/ui/api/proxies/retry-preview" && method === "POST") {
      assert.deepEqual(body, { previewId: initialPreviewId, ids: ["p2"] });
      return Response.json({ ok: true, previewId: retryPreviewId, operationScope, rows: [rows[1]], unusedProxies: 0 });
    }
    if (path.startsWith("/ui/api/proxies/operations/") && method === "GET") {
      assert.equal(url.searchParams.get("operationScope"), operationScope);
      const attempt = applied.get(path.split("/").at(-1)!);
      if (!attempt) return scenario === "unsupported-service" ? Response.json({ ok: false }, { status: 501 }) : Response.json({ ok: false, code: "operation_not_found" }, { status: 404 });
      assert.equal(url.searchParams.get("previewId"), attempt.previewId);
      assert.equal(coordinator.getSnapshot().operation?.kind, "profile-proxies");
      return statusAvailable ? complete(attempt) : Response.json({ ok: false, code: "operation_scope_mismatch" }, { status: 404 });
    }
    if (path === "/ui/api/proxies/apply" && method === "POST") {
      const attempt = body as ProxyAssignmentAttempt;
      assert.deepEqual(Object.keys(attempt).sort(), ["attemptId", "operationScope", "previewId"]);
      assert.equal(attempt.operationScope, operationScope);
      assert.ok(!applied.has(attempt.attemptId));
      applied.set(attempt.attemptId, attempt);
      const results = attempt.previewId === retryPreviewId ? retryResults : firstResults;
      if (scenario === "stop-receiving" && attempt.previewId === initialPreviewId) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const events = [{ type: "replacement", row: results[0] }, { type: "progress", phase: "applying", completed: 1, total: 2 }];
          controller.enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event)).join("\n") + "\n"));
        },
        cancel() { receiptDeliveryStopped = true; },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
      const events = [...results.map(row => ({ type: "replacement", row })), { type: "done" }];
      return new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected proxy assignment fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect }) });

  const onChanged = async () => {
    assert.equal(coordinator.getSnapshot().operation?.phase, "refreshing");
    assert.equal(coordinator.acquire("workspace-switch"), null);
    refreshes++;
    if (refreshFails) throw new Error("Inert roster read failed");
  };
  const render = (active = true) => dom.render(<I18nProvider><WorkspaceOperationsProvider coordinator={coordinator}>
    <ProxiesPage groups={["Sales"]} active={active} onChanged={onChanged} onTaskSnapshotChange={snapshot => snapshots.push(snapshot)} />
  </WorkspaceOperationsProvider></I18nProvider>);
  const button = (label: string) => {
    const control = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);
    assert.ok(control, `Missing button ${label}`);
    return control;
  };
  const click = (label: string) => act(async () => { button(label).click(); });
  const field = () => dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Replacement input"]')!;
  const enter = (value: string) => act(async () => {
    const input = field();
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const receipt = () => dom.container.querySelector(".proxy-task-card")?.textContent ?? "";
  const reviewRows = () => [...dom.container.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");

  try {
    await render();
    await act(async () => { dom.container.querySelectorAll<HTMLButtonElement>(".tools-tabs button")[1]!.click(); });
    await enter("new.invalid:8080:fixture:PRIVATE_PROXY_SECRET");
    await click("Preview changes");
    assert.equal(reviewRows().length, 2);
    assert.ok(reviewRows().every(row => row.includes("new.invalid:8080") && !row.includes("PRIVATE_PROXY_SECRET")));
    await act(async () => { const apply = button("Apply 2 changes"); apply.click(); apply.click(); });
    await dom.flush();

    if (scenario === "unsupported-service") {
      assert.equal(applied.size, 0);
      assert.deepEqual(calls.map(call => call.method), ["POST", "GET"]);
      assert.match(receipt(), /Could not verify proxy task recovery/);
      assert.equal(coordinator.getSnapshot().operation, null);
      assert.equal(refreshes, 0);
      return;
    }

    assert.equal(applied.size, 1);
    if (scenario === "stop-receiving") {
      await click("Stop receiving");
      assert.equal(receiptDeliveryStopped, true);
      assert.match(receipt(), /may still finish work that has started/);
      assert.equal(coordinator.acquire("workspace-switch"), null);
    }
    assert.match(receipt(), /could not confirm this task/);
    assert.match(receipt(), /1 reported updated · 2 rows/);
    assert.equal(coordinator.getSnapshot().operation?.kind, "profile-proxies");
    assert.equal(refreshes, 0, "A completed NDJSON response alone is insufficient to release ownership");
    await render(false);
    assert.ok(dom.container.querySelector(".proxy-manager[hidden]"));
    assert.equal(coordinator.acquire("workspace-backup"), null);
    assert.equal(calls.filter(call => call.method === "GET").length, 2);
    await render();
    statusAvailable = true;
    await click("Check task status");
    assert.equal(coordinator.getSnapshot().operation, null);
    assert.match(receipt(), /1 updated · 2 rows/);
    assert.match(receipt(), /environment list could not refresh/);
    assert.equal(refreshes, 1);
    assert.equal(viewRefreshes, 1);

    refreshFails = false;
    await click("Refresh environments");
    assert.equal(applied.size, 1, "Refreshing a completed result must never apply the replacements again");
    assert.equal(refreshes, 2);
    assert.equal(viewRefreshes, 2);
    await click("Preview failed rows again");
    assert.equal(applied.size, 1, "Preparing a retry must not modify profiles before review");
    assert.ok(reviewRows()[0]!.includes("Environment One") && reviewRows()[0]!.includes("Updated"));
    assert.ok(reviewRows()[1]!.includes("Environment Two") && reviewRows()[1]!.includes("Ready to retry"));
    assert.match(receipt(), /1 updated · 2 rows/);
    await click("Apply 1 changes");
    assert.equal(applied.size, 2);
    assert.match(receipt(), /2 updated · 2 rows/);
    assert.equal(coordinator.getSnapshot().operation, null);

    await enter("different.invalid:8080");
    assert.equal(reviewRows().length, 0, "Editing inputs invalidates the old review");
    assert.equal(dom.container.querySelectorAll(".proxy-task-history li").length, 2);
    assert.match(receipt(), /2 updated · 2 rows/);
    const serialized = JSON.stringify(snapshots);
    for (const value of ["PRIVATE_PROXY_SECRET", "new.invalid", "Environment One", operationScope, initialPreviewId, retryPreviewId, ...applied.keys()]) assert.ok(!serialized.includes(value));
  } finally { unregister(); await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "receipt-retry"); console.log("proxy assignment interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
