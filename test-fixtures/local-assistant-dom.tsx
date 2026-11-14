import assert from "node:assert/strict";
import { act } from "react";
import { I18nProvider, translate } from "../web/i18n.tsx";
import { buildFingerprintAssistantBrief } from "../web/fingerprint-assistant-brief.ts";
import { LocalAssistantPage, type AssistantDraftSuggestion, type AssistantTaskSource } from "../web/local-assistant.tsx";
import { createWebDomHarness } from "./web-dom.ts";
import type { HTMLInputElement, HTMLDivElement } from "happy-dom";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function run(scenario: string) {
  const calls: Array<{ path: string; body: Record<string, any>; signal?: AbortSignal | null }> = [];
  let pending = deferred<Response>();
  const fetchFixture = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const body = JSON.parse(String(options?.body));
    calls.push({ path, body, signal: options?.signal });
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    if (path.endsWith("/models")) return Response.json({ ok: true, catalog: {
      provider: "ollama", endpoint: "http://127.0.0.1:11434", checkedAt: new Date().toISOString(),
      models: [{ name: "dom-fixture:latest", sizeBytes: 1024, parameterSize: "fixture", quantization: null }], excludedRemoteModels: 1,
    } });
    if (path.endsWith("/cancel")) return Response.json({ ok: true, cancelled: true });
    assert.ok(path.endsWith("/chat"));
    const operation = pending;
    options?.signal?.addEventListener("abort", () => operation.reject(new DOMException("Synthetic cancellation", "AbortError")), { once: true });
    return operation.promise;
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fetchFixture });
  let suggestion: AssistantDraftSuggestion | null = null;
  let returnedToTask = 0;
  const returnedSources: AssistantTaskSource[] = [];
  const dismissed: number[] = [];
  const dismiss = (id: number) => {
    dismissed.push(id);
    if (suggestion?.id === id) suggestion = null;
  };
  const render = (active = true) => dom.render(<I18nProvider><LocalAssistantPage active={active} draftSuggestion={suggestion} onDismissDraftSuggestion={dismiss} onReturnToTask={source => { returnedToTask++; returnedSources.push(source); }} /></I18nProvider>);
  const buttons = () => Array.from(dom.container.querySelectorAll("button"));
  const button = (label: string) => {
    const result = buttons().find(item => item.textContent?.trim() === label);
    assert.ok(result, `Missing button ${label}`); return result;
  };
  const textarea = () => dom.container.querySelector("textarea")!;
  const text = () => dom.container.textContent ?? "";
  const click = async (label: string) => act(async () => { button(label).click(); });
  const typeDraft = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
    textarea().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const connect = async () => {
    if (dom.container.querySelector<HTMLDivElement>(".assistant-connection")!.hidden) await click("Model settings");
    await click("Connect & load models");
  };
  const progress = () => dom.container.querySelector(".assistant-task-progress")!;
  try {
    await render();
    assert.equal(calls.length, 0, "Opening the workspace must not connect");
    assert.equal(dom.container.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked, false);
    assert.equal(button("Send message ↑").disabled, true);
    assert.equal(dom.container.querySelector<HTMLDivElement>(".assistant-connection")!.hidden, true);
    if (scenario === "settings-toggle") {
      await typeDraft("Keep my local draft.");
      await click("Model settings");
      assert.equal(button("Model settings").getAttribute("aria-expanded"), "true");
      assert.equal(dom.container.querySelector<HTMLDivElement>(".assistant-connection")!.hidden, false);
      assert.equal(dom.window.document.activeElement, dom.container.querySelector(".assistant-connection input"));
      assert.equal(calls.length, 0, "Opening model settings must not connect");
      await click("Model settings");
      assert.equal(button("Model settings").getAttribute("aria-expanded"), "false");
      assert.equal(textarea().value, "Keep my local draft.");
      await connect();
      assert.equal(calls.length, 1);
      assert.equal(dom.container.querySelector<HTMLDivElement>(".assistant-connection")!.hidden, true);
      assert.ok(dom.container.querySelector(".assistant-model-summary")?.textContent?.includes("dom-fixture:latest"));
      assert.equal(textarea().value, "Keep my local draft.");
      assert.equal(dom.window.document.activeElement, textarea());
      return;
    }
    if (scenario === "task-context-and-progress") {
      suggestion = { id: 1, text: "An anonymous inspection summary.", source: { title: "PRIVATE_PROFILE_NAME", description: "PRIVATE_CONNECTION_HINT", returnKey: "PRIVATE_PROFILE_ID" } };
      await render();
      assert.equal(dom.container.querySelector(".assistant-task-source"), null, "Previewing an incoming suggestion must not bind the current task");
      assert.ok(dom.container.querySelector(".assistant-suggestion-source")?.textContent?.includes("PRIVATE_PROFILE_NAME"));
      assert.ok(progress().classList.contains("draft"));
      await click("Review source inspection");
      assert.equal(returnedToTask, 1);
      assert.equal(returnedSources[0]!.returnKey, "PRIVATE_PROFILE_ID");
      assert.equal(calls.length, 0);
      await click("Add to draft");
      await render();
      assert.equal(dom.container.querySelector(".assistant-suggestion"), null);
      assert.ok(dom.container.querySelector(".assistant-task-source"), "Task source survives accepting the suggestion");
      await connect();
      await click("Send message ↑");
      assert.ok(progress().classList.contains("waiting"));
      assert.ok(progress().textContent?.includes("Waiting for the local model"));
      assert.equal(calls[1]!.body.messages.at(-1).content, "An anonymous inspection summary.");
      assert.equal(JSON.stringify(calls).includes("PRIVATE_"), false, "Source labels are local display context, never model input");
      // A second draft may arrive while the first model request is pending.
      // Its return target must not replace the visible current task's target.
      suggestion = { id: 2, text: "Another anonymous inspection summary.", source: { title: "PRIVATE_SECOND_PROFILE", returnKey: "PRIVATE_SECOND_ID" } };
      await render();
      assert.ok(dom.container.querySelector(".assistant-task-source")?.textContent?.includes("PRIVATE_PROFILE_NAME"));
      await click("Return to inspection");
      assert.equal(returnedSources.at(-1)!.returnKey, "PRIVATE_PROFILE_ID");
      assert.equal(JSON.stringify(calls).includes("PRIVATE_"), false, "Local return keys never join a model request");
      await act(async () => { pending.resolve(Response.json({ ok: true, reply: {
        provider: "ollama", model: "dom-fixture:latest", message: { role: "assistant", content: "Review the timezone and measure it again." },
        createdAt: null, workspaceOverviewIncluded: false, usage: { promptTokens: 12, completionTokens: 8 }, durationMs: 42,
      } })); });
      assert.ok(progress().classList.contains("complete"));
      assert.ok(dom.container.querySelector(".assistant-task-source")?.textContent?.includes("PRIVATE_PROFILE_NAME"), "A new suggestion must not reattribute the completed answer before acceptance");
      await click("Return to inspection");
      assert.equal(returnedSources.at(-1)!.returnKey, "PRIVATE_PROFILE_ID");
      assert.ok(dom.container.querySelector(".assistant-answer-source")?.textContent?.includes("PRIVATE_PROFILE_NAME"));
      await click("Add to draft"); await render();
      assert.ok(dom.container.querySelector(".assistant-task-source")?.textContent?.includes("PRIVATE_SECOND_PROFILE"));
      await typeDraft("My follow-up question.");
      await click("Use response as draft");
      assert.equal(textarea().value, "My follow-up question.\n\nReview the timezone and measure it again.");
      assert.ok(progress().classList.contains("draft"));
      assert.equal(calls.length, 2, "Reusing a result must not send or execute it");
      await typeDraft("a".repeat(8192));
      await click("Use response as draft");
      assert.equal(textarea().value, "a".repeat(8192));
      assert.ok(text().includes("Adding this text would exceed 8 KiB."));
      await render(false); await render();
      await click("Return to inspection");
      assert.equal(returnedToTask, 4);
      assert.equal(returnedSources.at(-1)!.returnKey, "PRIVATE_SECOND_ID");
      return;
    }
    if (scenario.startsWith("suggestion-")) {
      const brief = buildFingerprintAssistantBrief({ checks: [{ id: "capture_source", status: "unknown", label: "PRIVATE_LABEL", detail: "PRIVATE_SAMPLE" }] },
        (source, values) => translate({ "en-US": {} }, "en-US", source, values));
      const existing = scenario === "suggestion-overflow" ? "猫".repeat(2730) : "  My existing paragraph.\nKeep trailing whitespace. ";
      await typeDraft(existing);
      suggestion = { id: 1, text: brief };
      await render(false);
      assert.equal(dom.container.querySelector<HTMLDivElement>(".assistant-workspace")?.hidden, true);
      await render();
      const card = () => dom.container.querySelector(".assistant-suggestion");
      assert.equal(card()?.getAttribute("aria-label"), "Fingerprint explanation draft");
      const preview = card()?.querySelector("details");
      assert.ok(preview);
      await act(async () => { preview.querySelector("summary")!.click(); });
      assert.equal(preview.open, true);
      assert.equal(preview.querySelector("pre")?.textContent, brief);
      assert.ok(!text().includes("PRIVATE"));
      assert.equal(textarea().value, existing);
      assert.equal(calls.length, 0, "Previewing or reopening a suggestion must not contact the model service");
      if (scenario === "suggestion-overflow") {
        await click("Add to draft");
        assert.ok(card()?.querySelector('[role="alert"]')?.textContent?.includes("exceed 8 KiB"));
        assert.equal(textarea().value, existing);
        assert.equal(card()?.querySelector("pre")?.textContent, brief);
        assert.deepEqual(dismissed, []);
        await render(false); await render();
        assert.equal(textarea().value, existing);
        const exactFit = "a".repeat(8192 - new TextEncoder().encode(brief).length - 2);
        await typeDraft(exactFit);
        await click("Add to draft");
        assert.equal(textarea().value, `${exactFit}\n\n${brief}`);
        assert.equal(new TextEncoder().encode(textarea().value).length, 8192);
        assert.equal(card(), null);
        assert.deepEqual(dismissed, [1]);
        assert.equal(calls.length, 0);
        return;
      }
      if (scenario === "suggestion-dismiss") {
        const dismissButton = button("Dismiss suggestion");
        await act(async () => { dismissButton.click(); dismissButton.click(); });
        assert.deepEqual(dismissed, [1]);
        assert.equal(textarea().value, existing);
        await render(false); await render();
        assert.equal(card(), null);
        suggestion = { id: 2, text: brief };
        await render();
        assert.ok(card());
        assert.equal(card()?.querySelector("details")?.open, false);
        await typeDraft("");
        await click("Add to draft");
        assert.equal(textarea().value, brief);
        assert.deepEqual(dismissed, [1, 2]);
        assert.equal(calls.length, 0);
        return;
      }
      const add = button("Add to draft");
      await act(async () => { add.click(); add.click(); });
      const combined = `${existing}\n\n${brief}`;
      assert.equal(textarea().value, combined);
      assert.deepEqual(dismissed, [1]);
      assert.equal(card(), null);
      assert.equal(dom.window.document.activeElement, textarea());
      await render(false); await render();
      assert.equal(textarea().value, combined);
      assert.equal(card(), null);
      assert.equal(calls.length, 0, "Appending to the draft must not connect or send");
      await connect();
      await click("Send message ↑");
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.body.messages.at(-1).content, combined.trim());
      assert.equal(calls[1]!.body.includeWorkspaceOverview, false);
      suggestion = { id: 2, text: brief };
      await render();
      assert.equal(button("Add to draft").disabled, true);
      await click("Cancel request");
      await dom.flush();
      assert.equal(calls.at(-1)?.body.requestId, calls[1]!.body.requestId);
      assert.equal(textarea().value, combined, "Cancellation must restore the original editable draft, including its whitespace");
      assert.equal(button("Add to draft").disabled, false);
      assert.deepEqual(dismissed, [1]);
      return;
    }
    await connect();
    assert.equal(calls.length, 1);
    assert.ok(text().includes("1 remote models excluded"));
    await click("Understand fingerprint checks↗");
    const originalDraft = textarea().value;
    assert.ok(originalDraft.length > 20);
    if (scenario === "context-and-memory") {
      await act(async () => { dom.container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(); });
    }
    await click("Send message ↑");
    assert.equal(calls.length, 2);
    const operation = calls[1]!;
    assert.equal(operation.body.includeWorkspaceOverview, scenario === "context-and-memory");
    assert.match(operation.body.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(operation.body.messages.at(-1).content, originalDraft);
    assert.equal(textarea().disabled, true);
    assert.ok(progress().classList.contains("waiting"));
    if (scenario === "failure-restores-draft") {
      await act(async () => { pending.resolve(Response.json({ ok: false, error: "Synthetic model unavailable", retryable: true }, { status: 503 })); });
      assert.ok(progress().classList.contains("failed"));
      assert.equal(textarea().value, originalDraft);
      assert.equal(textarea().disabled, false);
      assert.ok(text().includes("Synthetic model unavailable"));
      pending = deferred<Response>();
      await click("Send message ↑");
      assert.ok(progress().classList.contains("waiting"));
      assert.equal(calls.at(-1)!.body.messages.at(-1).content, originalDraft);
      await click("Cancel request"); await dom.flush();
      assert.ok(progress().classList.contains("cancelled"));
      assert.equal(textarea().value, originalDraft);
      return;
    }
    if (scenario === "unmount-cancels") {
      await dom.unmount();
      await dom.flush();
      assert.equal(operation.signal?.aborted, true);
      assert.equal(calls.at(-1)?.path, "/ui/api/settings/assistant/cancel");
      assert.equal(calls.at(-1)?.body.requestId, operation.body.requestId);
      assert.equal(calls.at(-1)?.signal?.aborted, false);
      return;
    }
    if (scenario === "cancel-restores-draft") {
      await click("Cancel request");
      await dom.flush();
      assert.equal(operation.signal?.aborted, true);
      assert.equal(calls.at(-1)?.body.requestId, operation.body.requestId);
      assert.equal(calls.at(-1)?.signal?.aborted, false);
      assert.equal(textarea().value, originalDraft);
      assert.equal(textarea().disabled, false);
      assert.equal(dom.window.document.activeElement, textarea(), "Cancellation must focus the restored editable draft");
      assert.ok(text().includes("Request cancelled. Your draft is ready to edit."));
      assert.ok(progress().classList.contains("cancelled"));
      assert.equal(dom.container.querySelectorAll(".assistant-message").length, 0);
      return;
    }
    await act(async () => { pending.resolve(Response.json({ ok: true, reply: {
      provider: "ollama", model: "dom-fixture:latest", message: { role: "assistant", content: "<script>fixture text is never executed</script>" },
      createdAt: null, workspaceOverviewIncluded: true, usage: { promptTokens: 12, completionTokens: 8 }, durationMs: 42,
    } })); });
    assert.equal(dom.container.querySelectorAll(".assistant-message").length, 2);
    assert.ok(progress().classList.contains("complete"));
    assert.equal(dom.container.querySelector("script"), null);
    assert.ok(text().includes("<script>fixture text is never executed</script>"));
    assert.ok(text().includes("Anonymous workspace overview included"));
    assert.equal(dom.window.document.activeElement, textarea());
    await render(false);
    assert.equal(dom.container.querySelector<HTMLDivElement>(".assistant-workspace")?.hidden, true);
    await render(true);
    assert.equal(dom.container.querySelectorAll(".assistant-message").length, 2);
    assert.equal(calls.length, 2, "Navigating back must not reconnect or resend");
    await click("New conversation");
    assert.equal(dom.container.querySelectorAll(".assistant-message").length, 0);
    await click("Undo");
    assert.equal(dom.container.querySelectorAll(".assistant-message").length, 2);
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "context-and-memory"); console.log("local assistant interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
