import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { HTMLElement as DomElement, HTMLButtonElement as DomButton, HTMLInputElement as DomInput } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { WorkspaceActivity, WorkspaceProvider, WorkspaceManagementPage, WorkspaceSwitcher, useWorkspaceCatalog } from "../web/workspace-manager.tsx";
import { useWorkspaceOperations, type WorkspaceOperationCoordinator, type WorkspaceOperationLease } from "../web/workspace-operations.tsx";
import { SignedUpdateCard } from "../web/signed-updates.tsx";
import type { SignedUpdateStatus } from "../web/signed-update-api.ts";
import type { WorkspaceJob } from "../web/workspaces-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const record = (id: string, name: string) => ({ id, name, color: "#8169c8", icon: "laptop" as const, archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
  const catalog = { currentId: "one", activeId: "one", workspaces: [record("one", "Personal"), record("two", "Research")] };
  const requests: string[] = [], native: string[] = [];
  const activation = deferred<Response>(), installation = deferred<void>(), refresh = deferred<Response>(), initialHistory = deferred<Response>(), catalogRead = deferred<Response>();
  const jobStatusRetry = deferred<Response>();
  let job: WorkspaceJob | null = null, terminal = false, holdRefresh = false, manager = true, updater = true, views = 0;
  if (scenario === "restore-receipt-focus") {
    terminal = true;
    job = { id: "completed-restore", kind: "restore", status: "succeeded", phase: "complete", completed: 1, total: 1, result: { workspaceId: "two" } };
  }
  let historyReads = 0, failRefresh = scenario === "terminal-refresh-failure";
  const reconnect = scenario === "job-poll-reconnect", manualRetry = scenario === "job-poll-manual-retry";
  let jobStatusReads = 0;
  let coordinator!: WorkspaceOperationCoordinator, batch: WorkspaceOperationLease | null = null, lastBatch: WorkspaceOperationLease | null = null;
  let acceptActiveId!: (id: string) => void;
  const update: SignedUpdateStatus = { configured: true, status: scenario === "external-install" ? "downloading" : "available", currentVersion: "1", endpoint: null, message: "Inert update fixture", update: { version: "2", currentVersion: "1", notes: "Fixture", publishedAt: null } };
  const overview = () => ({ ok: true, workspaceId: "one", root: "inert-fixture-root", profileCount: 2, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 1000, lastBackupAt: null, backupBusy: !!job && !terminal, scriptRunning: false });
  const currentJob = () => job && { ...job, ...(terminal ? { status: "succeeded", phase: "complete", completed: 1, total: 1 } : {}) };
  const json = (value: unknown) => Response.json(value);
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? "GET"; requests.push(`${method} ${path}`);
    if (path === "/ui/api/shell-language") return json({ ok: true, language: "en-US" });
    if (path === "/ui/api/workspace/capability") return json({ ok: true, token: "a".repeat(64) });
    if (path === "/ui/api/workspaces" && method === "GET") return scenario === "stale-catalog-response" ? catalogRead.promise : json({ ok: true, ...catalog });
    if (path === "/ui/api/workspace/overview") { if (terminal && failRefresh) throw new Error("Fixture overview unavailable"); return holdRefresh && terminal ? refresh.promise : json(overview()); }
    if (path === "/ui/api/workspace/backups" && method === "GET") { historyReads++; if (historyReads === 1 && scenario === "stale-job-history") return initialHistory.promise; if (terminal && failRefresh) throw new Error("Fixture history unavailable"); return json({ ok: true, backups: [{ id: "backup", name: "Fixture backup", createdAt: 1, bytes: 1, profileCount: 2 }], jobs: job ? [currentJob()] : [] }); }
    if (path === "/ui/api/workspaces/two/activate") return activation.promise;
    if ((path === "/ui/api/workspace/backups" || path === "/ui/api/workspace/restore") && method === "POST") {
      job = reconnect || manualRetry
        ? { id: "job", kind: "backup", status: "running", phase: "copying", completed: 1, total: 4 }
        : { id: "job", kind: path.endsWith("restore") ? "restore" : "backup", status: "queued", phase: "queued", completed: 0, total: 1 };
      return json({ ok: true, job });
    }
    if (path === "/ui/api/workspace/jobs/job") {
      jobStatusReads++;
      if ((reconnect || manualRetry) && jobStatusReads === 1) throw new Error("Fixture status unavailable");
      if (manualRetry && jobStatusReads === 2) return jobStatusRetry.promise;
      return json({ ok: true, job: currentJob() });
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ desktop: true, fetch: fakeFetch });
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value(this: DomElement) { return this.closest("[hidden]") ? [] : [{ width: 200, height: 40 }]; } });
  mockIPC(command => { native.push(command); if (command === "signed_update_status") return update; if (command === "signed_update_install") return installation.promise; if (command === "signed_update_check") return update; if (command === "restart_workspace") return; throw new Error(`Unexpected fixture IPC ${command}`); });
  function Probe() {
    coordinator = useWorkspaceOperations().coordinator;
    acceptActiveId = useWorkspaceCatalog().acceptActiveId;
    return <button onClick={() => { lastBatch = coordinator.acquire("profile-batch", "one"); if (lastBatch) batch = lastBatch; }}>Start fixture batch</button>;
  }
  const render = () => dom.render(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><Probe /><WorkspaceSwitcher profileCount={2} runningCount={0} connection onShowRunning={() => {}} onOpenManagement={() => { views++; }} onShowBatchTask={() => { views++; }} />{(reconnect || manualRetry) && <WorkspaceActivity hidden={false} onOpen={() => { views++; }} />}{manager && <WorkspaceManagementPage active request={{ mode: scenario === "same-frame-switch" ? "switch" : "backups", workspaceId: "two", id: 1 }} onBack={() => { views++; }} onShowRunning={() => {}} onShowBatchTask={() => { views++; }} />}{updater && <SignedUpdateCard />}</WorkspaceProvider></I18nProvider>);
  const button = (label: string, scope: DomElement = dom.window.document.body) => { const found = [...scope.querySelectorAll<DomButton>("button")].find(item => !item.closest("[hidden]") && (item.textContent?.trim() === label || item.getAttribute("aria-label") === label)); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (label: string) => act(async () => { button(label).click(); });
  const prepareBackup = async () => {
    await click("Create full backup");
    const dialog = dom.window.document.querySelector<DomElement>('[role="dialog"]')!;
    const confirm = button("Create encrypted backup", dialog);
    const inputs = [...dialog.querySelectorAll<DomInput>('input[type="password"]')];
    assert.equal(inputs.length, 2);
    assert.ok(confirm.disabled);
    const enter = async (input: DomInput, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await enter(inputs[0]!, "fixture password one");
    await enter(inputs[1]!, "fixture password two");
    assert.ok(confirm.disabled);
    await enter(inputs[1]!, "fixture password one");
    assert.equal(confirm.disabled, false);
    return confirm;
  };
  const startBackup = async () => {
    const confirm = await prepareBackup();
    await act(async () => { confirm.click(); });
  };
  const waitFor = async (test: () => boolean, message: string) => { const deadline = Date.now() + 2200; while (!test() && Date.now() < deadline) await dom.flush(); assert.ok(test(), message); };
  try {
    await render(); await dom.flush();
    if (scenario === "batch-blocks-maintenance") {
      await click("Start fixture batch"); assert.ok(batch);
      assert.ok(button("Create full backup").disabled); assert.ok(button("Restore from file").disabled); assert.ok(button("Restore as new").disabled); assert.ok(button("Install verified update").disabled);
      assert.equal(button("Check trusted channel").disabled, false, "Read-only update browsing stays available");
      await click("Open workspace switcher");
      assert.ok(button("ResearchIndependent data and browser profiles").disabled);
      assert.equal(button("Manage workspaces").disabled, false); assert.equal(button("New workspace", dom.window.document.querySelector<DomElement>('[role="menu"]')!).disabled, false);
      await click("View environment task"); assert.equal(views, 1);
      assert.ok(dom.container.textContent?.includes("You can keep browsing and editing workspace details."));
      const tabs = [...dom.container.querySelectorAll<DomButton>('[role="tab"]')]; await act(async () => { tabs[0]!.click(); });
      const name = dom.container.querySelector<DomInput>('input[maxlength="40"]')!; assert.equal(name.disabled, false);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "Unsaved name"); name.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
      assert.equal(button("Save changes").disabled, false);
      await act(async () => { coordinator.setPhase(batch!, "refreshing"); }); assert.ok(button("Install verified update").disabled);
      await act(async () => { coordinator.release(batch!); batch = null; });
      assert.equal(button("Install verified update").disabled, false); assert.equal(name.value, "Unsaved name");
    } else if (scenario === "same-frame-switch") {
      const confirm = button("Switch and restart"), start = button("Start fixture batch"); assert.equal(confirm.disabled, false);
      await act(async () => { confirm.click(); start.click(); });
      assert.equal(lastBatch, null); assert.equal(coordinator.getSnapshot().operation?.kind, "workspace-switch");
      manager = false; await render(); assert.equal(coordinator.acquire("profile-batch"), null, "Unmount cannot release an activation whose response is pending");
      await act(async () => { activation.resolve(json({ ok: false, error: "Fixture refused activation" })); });
      assert.equal(coordinator.getSnapshot().operation, null); assert.equal(coordinator.getSnapshot().blocked, false);
    } else if (scenario === "same-frame-backup") {
      const confirm = await prepareBackup();
      await act(async () => { confirm.click(); button("Start fixture batch").click(); });
      assert.equal(lastBatch, null); assert.equal(requests.filter(item => item === "POST /ui/api/workspace/backups").length, 1);
      assert.equal(coordinator.getSnapshot().workspaceJob?.id, "job"); assert.equal(coordinator.acquire("profile-batch"), null);
    } else if (scenario === "job-refresh" || scenario === "restore-refresh") {
      if (scenario === "restore-refresh") { await click("Restore as new"); await click("Restore as new workspace"); }
      else await startBackup();
      assert.equal(coordinator.getSnapshot().workspaceJob?.phase, "running");
      terminal = true; holdRefresh = true;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
      assert.equal(coordinator.getSnapshot().workspaceJob?.phase, "refreshing");
      await click("Start fixture batch"); assert.equal(lastBatch, null);
      manager = false; await render(); assert.equal(coordinator.acquire("profile-batch"), null);
      await act(async () => { refresh.resolve(json(overview())); });
      await waitFor(() => !coordinator.getSnapshot().workspaceJob, "Final refresh must release the background barrier after unmount");
      assert.equal(coordinator.getSnapshot().blocked, false);
    } else if (scenario === "restore-receipt-focus") {
      const receipt = dom.container.querySelector<DomElement>(".wm-job-succeeded")!;
      assert.equal(receipt.querySelector(".wm-job-result-name")?.textContent, "Research");
      assert.equal(dom.window.document.getElementById(receipt.getAttribute("aria-labelledby")!)?.textContent, "Restore task");
      const view = button("View restored workspace", receipt);
      await act(async () => { view.focus(); view.click(); });
      const title = dom.container.querySelector<DomElement>(".wm-editor-title h2")!;
      assert.equal(title.textContent, "Research");
      assert.equal(dom.window.document.activeElement, title);

      const name = dom.container.querySelector<DomInput>('input[maxlength="40"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "Unsaved recovery name");
        name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        dom.container.querySelector<DomButton>("#wm-tab-backups")!.click();
      });
      await act(async () => { view.focus(); view.click(); });
      await click("Keep editing");
      assert.equal(name.value, "Unsaved recovery name");
      assert.equal(dom.window.document.activeElement, view);
      await act(async () => { view.click(); });
      await click("Discard changes");
      assert.equal(name.value, "Research");
      assert.equal(dom.window.document.activeElement, title);
      assert.equal(coordinator.getSnapshot().workspaceId, "one");
      assert.ok(requests.every(item => item.startsWith("GET ")), "Opening the receipt only navigates to workspace details");
    } else if (scenario === "install-unmount") {
      await act(async () => { button("Install verified update").click(); button("Start fixture batch").click(); });
      assert.equal(lastBatch, null); assert.equal(native.filter(item => item === "signed_update_install").length, 1);
      updater = false; await render(); assert.equal(coordinator.acquire("profile-batch"), null);
      await act(async () => { installation.resolve(); });
      assert.equal(coordinator.getSnapshot().blocked, false, "Native installation keeps its lease until actual settlement, even after card unmount");
    } else if (scenario === "external-install") {
      assert.equal(coordinator.acquire("profile-batch"), null); assert.ok(button("Create full backup").disabled);
      updater = false; await render(); assert.equal(coordinator.acquire("profile-batch"), null, "Navigation cannot clear a native download barrier");
      update.status = "error"; update.update = null;
      updater = true; await render();
      assert.equal(coordinator.getSnapshot().blocked, false);
    } else if (scenario === "terminal-refresh-failure") {
      await startBackup(); terminal = true;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
      assert.ok(dom.container.querySelector(".wm-job-succeeded"), "A verified terminal job must not remain visually running when refresh fails");
      assert.equal(coordinator.getSnapshot().blocked, false, "A failed read must not turn a completed write into an indefinite lock");
      assert.ok(dom.container.querySelector(".wm-history-card .wm-error")); assert.ok(dom.container.querySelector(".wm-backup-main > .wm-error"));
      failRefresh = false;
      await act(async () => { button("Retry", dom.container.querySelector<DomElement>(".wm-history-card")!).click(); button("Retry", dom.container.querySelector<DomElement>(".wm-backup-main > .wm-error")!).click(); });
      assert.equal(dom.container.querySelector(".wm-history-card .wm-error"), null); assert.equal(dom.container.querySelector(".wm-backup-main > .wm-error"), null);
      assert.ok(dom.container.querySelector(".wm-job-succeeded")); assert.equal(button("Create full backup").disabled, false);
    } else if (reconnect || manualRetry) {
      await startBackup();
      await waitFor(() => !!dom.container.querySelector(".wm-job .wm-error"), "Status read failure reaches the task card");
      assert.equal(jobStatusReads, 1);
      assert.equal(coordinator.getSnapshot().workspaceJob?.phase, "running", "An unreadable status cannot unlock the workspace");
      terminal = true;
      if (manualRetry) {
        const retry = button("Retry status check");
        await act(async () => { retry.focus(); });
        await act(async () => { retry.click(); retry.click(); });
        assert.equal(jobStatusReads, 2, "Same-frame retry requests one immediate status check");
        assert.equal(retry.getAttribute("aria-disabled"), "true");
        assert.ok(dom.container.querySelector(".wm-job .wm-error"), "The warning remains while a retry is pending");
        await act(async () => { jobStatusRetry.resolve(json({ ok: true, job: currentJob() })); });
      } else {
        assert.ok(!dom.container.querySelector(".wm-job progress"), "A disconnected status does not present old progress as live");
        assert.match(dom.container.querySelector(".wm-job")?.textContent ?? "", /Task status unavailable\. Retrying automatically…/);
        assert.match(dom.container.querySelector(".wm-activity")?.textContent ?? "", /Task status unavailable\. Retrying automatically…/);
      }
      await waitFor(() => !coordinator.getSnapshot().blocked, "Retry should release the barrier after a confirmed terminal result");
      assert.equal(jobStatusReads, 2);
      assert.ok(dom.container.querySelector(".wm-job-succeeded"));
      if (manualRetry) assert.equal(dom.window.document.activeElement, dom.container.querySelector(".wm-job-succeeded"));
      assert.ok(!dom.container.querySelector(".wm-job .wm-error"));
      assert.equal(requests.filter(item => item === "POST /ui/api/workspace/backups").length, 1);
    } else if (scenario === "job-unmount-recover") {
      await startBackup(); manager = false; await render();
      assert.equal(coordinator.acquire("profile-batch"), null);
      terminal = true; holdRefresh = true; manager = true; await render();
      assert.equal(coordinator.getSnapshot().workspaceJob?.phase, "refreshing", "A remounted page must reconcile an externally completed job before unlocking");
      await act(async () => { refresh.resolve(json(overview())); });
      assert.equal(coordinator.getSnapshot().blocked, false); assert.ok(dom.container.querySelector(".wm-job-succeeded"));
    } else if (scenario === "stale-job-history") {
      await startBackup(); assert.equal(coordinator.getSnapshot().workspaceJob?.id, "job");
      await act(async () => { initialHistory.resolve(json({ ok: true, backups: [], jobs: [{ id: "older", kind: "backup", status: "running", phase: "copying", completed: 0, total: 1 }] })); });
      assert.equal(coordinator.getSnapshot().workspaceJob?.id, "job", "An old history request cannot steal ownership from a newly accepted task");
      terminal = true; await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
      assert.equal(coordinator.getSnapshot().blocked, false); assert.ok(dom.container.querySelector(".wm-job-succeeded"));
    } else if (scenario === "stale-catalog-response") {
      await act(async () => { acceptActiveId("two"); });
      assert.equal(coordinator.getSnapshot().restartPending, true);
      await act(async () => { catalogRead.resolve(json({ ok: true, ...catalog })); });
      assert.equal(coordinator.getSnapshot().restartPending, true, "A catalog request started before activation cannot erase its prepared-restart barrier");
      assert.equal(coordinator.acquire("profile-batch"), null);
      await act(async () => { acceptActiveId("one"); });
      assert.equal(coordinator.getSnapshot().blocked, false);
    } else throw new Error(scenario);
  } finally {
    activation.resolve(json({ ok: false, error: "Fixture teardown" })); installation.resolve(); terminal = true; holdRefresh = false; failRefresh = false; refresh.resolve(json(overview())); initialHistory.resolve(json({ ok: true, backups: [], jobs: [] })); catalogRead.resolve(json({ ok: true, ...catalog })); jobStatusRetry.resolve(json({ ok: true, job: currentJob() }));
    await dom.flush(); await dom.cleanup();
    if (styleDescriptor) Object.defineProperty(globalThis, "getComputedStyle", styleDescriptor); else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
}
await run(process.argv[2] ?? "batch-blocks-maintenance");
console.log("workspace operation fixture passed");
