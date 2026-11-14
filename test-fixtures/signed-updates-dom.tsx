import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { createDesktopCloseRegistry, DesktopCloseHost, DesktopCloseRegistryProvider } from "../web/desktop-close.tsx";
import type { DesktopCloseIntent, DesktopCloseNative } from "../web/desktop-close-state.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { SignedUpdateCard } from "../web/signed-updates.tsx";
import type { SignedUpdateProgress, SignedUpdateStatus } from "../web/signed-update-api.ts";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const available: SignedUpdateStatus = {
  configured: true, status: "available", currentVersion: "1.0.0", endpoint: "https://publisher.invalid/latest.json",
  message: "An inert fixture update is available.", update: { version: "1.2.3", currentVersion: "1.0.0", notes: "Fixture only", publishedAt: null },
};

async function run(scenario: string) {
  const dom = await createWebDomHarness({ desktop: true });
  let current = { ...available }, reads = 0, installCalls = 0, checkCalls = 0, failStatus = false;
  const installation = deferred<void>(), checking = deferred<SignedUpdateStatus>(), statusRecovery = deferred<SignedUpdateStatus>();
  const registry = createDesktopCloseRegistry();
  const coordinator = createWorkspaceOperationCoordinator({ currentId: "workspace", activeId: "workspace" });
  const hasDraft = ["draft-cancel", "draft-recheck", "scope-changed", "native-overlay"].includes(scenario);
  const editor = hasDraft ? registry.register("profile-edit", { dirty: true, busy: false }) : null;
  const sessionId = "a".repeat(64), requestId = "b".repeat(64);
  let nativeIntent!: (intent: DesktopCloseIntent) => void;
  const native: DesktopCloseNative = {
    async register() { return { sessionId }; },
    async unregister() {},
    async listenIntent(callback) { nativeIntent = callback; return () => {}; },
    async listenResolved() { return () => {}; },
    async resolve(_intent, decision) { return decision === "hold" ? "holding" : decision === "cancel" ? "cancelled" : "continuing"; },
  };
  let progress!: (event: SignedUpdateProgress) => void;
  mockIPC((command, payload) => {
    if (command === "signed_update_status") {
      reads++;
      if (failStatus) throw new Error("follow-up status unavailable");
      if (scenario === "draft-recheck" && reads > 1) return statusRecovery.promise;
      return current;
    }
    if (command === "signed_update_install") {
      const args = payload as Record<string, unknown>;
      installCalls++; assert.equal(args.expectedVersion, "1.2.3");
      progress = (args.onProgress as Channel<SignedUpdateProgress>).onmessage;
      return installation.promise;
    }
    if (command === "signed_update_check") { checkCalls++; return checking.promise; }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const text = () => dom.container.textContent ?? "";
  const buttons = () => Array.from(dom.container.querySelectorAll("button"));
  const button = (label: string) => {
    const found = buttons().find(item => item.textContent === label); assert.ok(found, `Missing button ${label}`); return found;
  };
  const activeDialog = (layer = "signed-update-dialog-layer") => [...dom.window.document.querySelectorAll(`.${layer} [aria-modal="true"]`)]
    .find(node => !node.closest('[inert], [aria-hidden="true"]'));
  const dialogButton = (label: string, layer?: string) => {
    const control = [...(activeDialog(layer)?.querySelectorAll("button") ?? [])].find(item => item.textContent === label);
    assert.ok(control, `Missing dialog button ${label}`);
    return control;
  };
  const render = () => dom.render(<I18nProvider><DesktopCloseRegistryProvider registry={registry}>
    <WorkspaceOperationsProvider coordinator={coordinator}>
      {hasDraft && <input aria-label="Fixture draft" defaultValue="local draft contents" />}
      <SignedUpdateCard />
      {scenario === "native-overlay" && <DesktopCloseHost registry={registry} native={native} />}
    </WorkspaceOperationsProvider>
  </DesktopCloseRegistryProvider></I18nProvider>);
  try {
    await render();
    assert.equal(reads, 1); assert.equal(installCalls, 0); assert.equal(checkCalls, 0);
    if (scenario === "draft-cancel") {
      await act(async () => { button("Check trusted channel").click(); checking.resolve(available); });
      assert.equal(checkCalls, 1);
      const trigger = button("Install verified update");
      trigger.focus();
      await act(async () => { trigger.click(); trigger.click(); });
      assert.equal(installCalls, 0);
      assert.equal(activeDialog()?.getAttribute("role"), "alertdialog");
      assert.ok(activeDialog()?.textContent?.includes("Edit profile"));
      assert.ok(activeDialog()?.textContent?.includes("1.2.3"));
      assert.ok(!activeDialog()?.textContent?.includes("local draft contents"));
      assert.equal(dom.container.hasAttribute("inert"), true);
      assert.equal(dom.window.document.activeElement, dialogButton("Keep editing"));
      await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true })); });
      assert.equal(dom.window.document.activeElement, dialogButton("Discard drafts and install"));
      await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
      assert.equal(dom.window.document.activeElement, trigger);
      assert.equal(activeDialog(), undefined);
      assert.equal(dom.container.hasAttribute("inert"), false);
      assert.equal(dom.container.querySelector("input")?.value, "local draft contents");
      assert.deepEqual(registry.getSnapshot().dirty, ["profile-edit"]);
      assert.equal(installCalls, 0);
      await act(async () => { trigger.click(); });
      const discard = dialogButton("Discard drafts and install");
      await act(async () => { editor!.update({ dirty: false, busy: false }); discard.click(); });
      assert.equal(installCalls, 0);
      assert.ok(dialogButton("Install verified update"));
      assert.ok(!activeDialog()?.querySelector("ul"));
      await act(async () => { dialogButton("Keep editing").click(); });
      return;
    }
    if (scenario === "draft-recheck") {
      await act(async () => { editor!.update({ dirty: true, busy: true }); button("Install verified update").click(); });
      assert.equal(installCalls, 0);
      assert.equal(activeDialog(), undefined);
      assert.ok(button("Install verified update").disabled);
      await act(async () => { editor!.update({ dirty: true, busy: false }); });
      await act(async () => { button("Install verified update").click(); });
      const discard = dialogButton("Discard drafts and install");
      let save: ReturnType<typeof coordinator.acquire> = null;
      await act(async () => { save = coordinator.acquire("profile-batch"); discard.click(); });
      assert.ok(save);
      assert.equal(installCalls, 0);
      assert.ok(discard.disabled);
      await act(async () => { if (save) coordinator.release(save); });
      await act(async () => {
        registry.register("assistant-draft", { dirty: true, busy: false });
        discard.click(); discard.click();
      });
      assert.equal(installCalls, 0);
      assert.ok(activeDialog()?.textContent?.includes("AI message draft"));
      assert.ok(activeDialog()?.textContent?.includes("Drafts changed since this prompt opened"));
      await act(async () => { discard.click(); discard.click(); });
      assert.equal(installCalls, 1);
      assert.equal(coordinator.getSnapshot().operation?.kind, "app-restart");
      assert.equal(activeDialog()?.getAttribute("role"), "dialog");
      assert.ok(activeDialog()?.textContent?.includes("Preparing update installation"));
      assert.equal(activeDialog()?.querySelector("progress"), null);
      assert.equal(dom.container.hasAttribute("inert"), true);
      await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
      assert.ok(activeDialog());
      await act(async () => { progress({ phase: "downloading", downloadedBytes: 37, totalBytes: null }); });
      assert.ok(activeDialog()?.querySelector("progress"));
      assert.equal(activeDialog()?.querySelector("progress")?.getAttribute("value"), null);
      await act(async () => { progress({ phase: "downloading", downloadedBytes: 37, totalBytes: 100 }); });
      assert.equal(activeDialog()?.querySelector("progress")?.getAttribute("value"), "37");
      assert.deepEqual(registry.getSnapshot().dirty, ["profile-edit", "assistant-draft"]);
      await act(async () => { installation.reject(new Error("original installer failure")); });
      assert.equal(activeDialog(), undefined);
      assert.equal(dom.container.hasAttribute("inert"), false);
      assert.equal(dom.container.contains(dom.window.document.activeElement), true);
      assert.ok(text().includes("original installer failure"));
      assert.equal(dom.container.querySelector("input")?.value, "local draft contents");
      await act(async () => { statusRecovery.resolve({ ...available, status: "error", update: null }); });
      assert.equal(coordinator.getSnapshot().blocked, false);
      assert.equal(button("Check trusted channel").disabled, false);
      return;
    }
    if (scenario === "scope-changed") {
      await act(async () => { button("Install verified update").click(); });
      const discard = dialogButton("Discard drafts and install");
      await act(async () => { coordinator.setWorkspace("another-workspace", "another-workspace"); discard.click(); });
      assert.equal(installCalls, 0);
      assert.equal(activeDialog(), undefined);
      assert.ok(text().includes("Check the signed publisher again before installing"));
      assert.equal(buttons().some(item => item.textContent === "Install verified update"), false);
      assert.equal(button("Check trusted channel").disabled, false);
      assert.deepEqual(registry.getSnapshot().dirty, ["profile-edit"]);
      return;
    }
    if (scenario === "native-overlay") {
      const trigger = button("Install verified update");
      trigger.focus();
      await act(async () => { trigger.click(); });
      const signedKeep = dialogButton("Keep editing");
      const signedDiscard = dialogButton("Discard drafts and install");
      await act(async () => { nativeIntent({ sessionId, requestId, deliveryId: 1 }); });
      assert.equal(activeDialog(), undefined);
      assert.ok(activeDialog("desktop-close-layer"));
      assert.equal(dom.window.document.activeElement, dialogButton("Keep editing", "desktop-close-layer"));
      await act(async () => { signedDiscard.click(); });
      assert.equal(installCalls, 0);
      await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
      assert.equal(activeDialog("desktop-close-layer"), undefined);
      assert.equal(dom.container.hasAttribute("inert"), true);
      assert.equal(dom.window.document.activeElement, signedKeep);
      await act(async () => { signedKeep.click(); });
      assert.equal(dom.container.hasAttribute("inert"), false);
      assert.equal(dom.window.document.activeElement, trigger);
      assert.equal(installCalls, 0);
      return;
    }
    if (scenario === "navigation-busy") {
      await act(async () => { button("Install verified update").click(); });
      assert.ok(button("Check trusted channel").disabled); assert.ok(button("Install verified update").disabled);
      await dom.unmount();
      current = { ...available, status: "downloading", message: "Native download continues after navigation." };
      await render();
      assert.ok(text().includes(current.message));
      assert.ok(text().includes("Closing and restarting are blocked"));
      assert.ok(button("Check trusted channel").disabled); assert.ok(button("Install verified update").disabled);
      current = { ...available, status: "error", update: null, message: "Native fixture download failed." };
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1650)); });
      assert.ok(text().includes(current.message)); assert.equal(button("Check trusted channel").disabled, false);
      assert.equal(buttons().some(item => item.textContent === "Install verified update"), false);
      assert.equal(installCalls, 1);
      await act(async () => { installation.reject(new Error(current.message)); });
      return;
    }
    if (scenario === "check-failure") {
      await act(async () => { button("Check trusted channel").click(); });
      assert.ok(button("Checking…").disabled); assert.ok(button("Install verified update").disabled);
      current = { ...available, status: "error", update: null, message: "Native fixture check failed." };
      await act(async () => { checking.reject(new Error("original check failure")); });
      assert.ok(text().includes("original check failure")); assert.ok(text().includes(current.message));
      assert.equal(buttons().some(item => item.textContent === "Install verified update"), false);
      assert.equal(button("Check trusted channel").disabled, false); assert.equal(checkCalls, 1);
      return;
    }
    await act(async () => { button("Install verified update").click(); });
    assert.equal(activeDialog()?.getAttribute("role"), "dialog");
    assert.ok(button("Check trusted channel").disabled); assert.ok(button("Install verified update").disabled);
    assert.ok(text().includes("Closing and restarting are blocked"));
    await act(async () => { progress({ phase: "downloading", downloadedBytes: 37, totalBytes: 100 }); });
    assert.equal(dom.container.querySelector("progress")?.getAttribute("value"), "37");
    current = { ...available, status: "error", update: null, message: "Native fixture signature failure." };
    failStatus = scenario === "refresh-failure";
    await act(async () => { installation.reject(new Error("original installer failure")); });
    assert.equal(activeDialog(), undefined);
    assert.equal(dom.container.querySelector("progress"), null);
    assert.equal(dom.container.querySelector(".signed-update-progress"), null);
    assert.ok(text().includes("original installer failure")); assert.equal(text().includes("follow-up status unavailable"), false);
    assert.equal(button("Check trusted channel").disabled, false);
    assert.equal(buttons().some(item => item.textContent === "Install verified update"), false);
    assert.equal(dom.container.querySelector(".signed-update-release"), null);
    if (!failStatus) {
      assert.ok(text().includes(current.message));
    }
    assert.ok(reads >= 2); assert.equal(installCalls, 1);
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "download-failure"); console.log("signed update interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
