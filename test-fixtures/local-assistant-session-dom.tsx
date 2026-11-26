import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { createDesktopCloseRegistry, DesktopCloseRegistryProvider } from "../web/desktop-close.tsx";
import { LocalAssistantPage, type AssistantDraftSuggestion, type AssistantTaskSource } from "../web/local-assistant.tsx";
import type { CompiledProposalView } from "../web/local-assistant-api.ts";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });
  const closeRegistry = createDesktopCloseRegistry();
  type Call = { workspace: string; path: string; body: any; signal?: AbortSignal | null };
  const calls: Call[] = [], chats: Array<{ call: Call; response: ReturnType<typeof deferred<Response>> }> = [];
  const models: Array<{ call: Call; response: ReturnType<typeof deferred<Response>> }> = [], cancellations: Array<{ call: Call; response: ReturnType<typeof deferred<Response>> }> = [];
  let holdModels = scenario === "readonly-navigation" || scenario === "workspace-models", holdCancellation = scenario === "cancel-late" || scenario === "workspace-cancel-late";
  let cancellationResult: boolean | "error" = scenario === "cancel-false" || scenario === "navigation-unconfirmed" ? false : scenario === "cancel-error" ? "error" : true;
  let failModels = scenario === "connection-retry", suggestion: AssistantDraftSuggestion | null = null;
  const returned: AssistantTaskSource[] = [], storageWrites: Array<{ key: string; value: string }> = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const catalog = (name = `${coordinator.getSnapshot().workspaceId}-model`) => ({ ok: true, catalog: { provider: "ollama", endpoint: "http://127.0.0.1:11434", checkedAt: "2026-11-10T10:00:00Z", excludedRemoteModels: 0, models: [{ name, sizeBytes: 1024, parameterSize: null, quantization: null }] } });
  const apiReadiness = scenario === "api-service-readiness";
  const apiService = { id: `model_${"a".repeat(32)}`, name: "Synthetic work API", provider: apiReadiness ? "anthropic" : "openai-compatible", endpoint: "https://api.example.com/v1", model: "fixture-api", credentialConfigured: false };
  const serviceCatalog = () => json({ ok: true, catalog: { services: [apiService], defaultId: apiService.id } });
  const reply = (content: string, model: string, provider = "ollama") => json({ ok: true, reply: { provider, model, message: { role: "assistant", content }, createdAt: null, workspaceOverviewIncluded: scenario === "copy-conversation", usage: { promptTokens: 1, completionTokens: 2 }, durationMs: 42 } });
  const fixtureFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return json({ ok: true, language: "en-US" });
    const call: Call = { workspace: coordinator.getSnapshot().workspaceId!, path, body: options?.body === undefined ? null : JSON.parse(String(options.body)), signal: options?.signal }; calls.push(call);
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1"); assert.equal(options?.credentials, "same-origin");
    if ((scenario === "api-service-context" || apiReadiness) && path.endsWith("/services")) return serviceCatalog();
    if (apiReadiness && path.endsWith("/services/test")) {
      assert.equal(call.body.apiKey, "synthetic-first-key");
      assert.equal(call.body.messages, undefined);
      return json({ ok: true, catalog: { models: [{ name: apiService.model, sizeBytes: null, parameterSize: null, quantization: null }], excludedRemoteModels: 0 } });
    }
    if (apiReadiness && path.endsWith("/services/save")) {
      assert.ok(["synthetic-first-key", "synthetic-replacement-key"].includes(call.body.apiKey));
      apiService.credentialConfigured = true;
      return serviceCatalog();
    }
    if (path.endsWith("/models")) {
      if (failModels) return json({ ok: false, error: "Fixture connection unavailable", code: "unavailable", retryable: true }, 503);
      if (holdModels) { const response = deferred<Response>(); models.push({ call, response }); return response.promise; }
      return json(catalog());
    }
    if (path.endsWith("/cancel")) {
      const response = deferred<Response>(); cancellations.push({ call, response });
      if (!holdCancellation) response.resolve(cancellationResult === "error" ? json({ ok: false, error: "PRIVATE_CANCEL_ERROR", code: "unavailable" }, 503) : json({ ok: true, cancelled: cancellationResult }));
      return response.promise;
    }
    assert.ok(path.endsWith("/chat"), `Unexpected assistant route ${path}`);
    const response = deferred<Response>(); chats.push({ call, response });
    // Deliberately ignore abort: the UI must also fence a late parsed response.
    return response.promise;
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fixtureFetch });
  if (scenario === "empty-scroll") Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true, get(this: HTMLElement) { return this.classList.contains("assistant-messages") ? 900 : 0; },
  });
  const originalNow = Date.now;
  for (const storage of [dom.window.localStorage, dom.window.sessionStorage]) {
    const original = storage.setItem.bind(storage);
    Object.defineProperty(storage, "setItem", { configurable: true, value(key: string, value: string) { storageWrites.push({ key, value }); if (key === "aliasmode.shell.language") original(key, value); else throw new Error("Conversation storage is forbidden"); } });
  }
  const render = (active = true) => dom.render(<DesktopCloseRegistryProvider registry={closeRegistry}>
    <WorkspaceOperationsProvider coordinator={coordinator}><I18nProvider>
      <LocalAssistantPage active={active} onOpenModelServices={scenario === "api-service-context" || apiReadiness ? () => {} : undefined} draftSuggestion={suggestion} onDismissDraftSuggestion={id => { if (suggestion?.id === id) suggestion = null; }} onReturnToTask={source => returned.push(source)} />
      <button data-outside>Outside action</button>
    </I18nProvider></WorkspaceOperationsProvider>
  </DesktopCloseRegistryProvider>);
  const visible = (node: HTMLElement) => !node.closest('[hidden], [inert], [aria-hidden="true"]');
  const button = (label: string, scope: HTMLElement = dom.container) => { const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => visible(node) && node.textContent?.trim() === label); assert.ok(value, `Missing ${label}`); return value; };
  const input = () => dom.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const click = (label: string, twice = false) => act(async () => { const node = button(label); node.click(); if (twice) node.click(); });
  const type = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const connect = async () => { if (dom.container.querySelector<HTMLElement>(".assistant-connection")!.hidden) await click("Model settings"); await click("Connect & load models"); };
  const send = async (content: string) => { await type(content); await click("Send message ↑"); };
  const resolveReply = (index: number, content = "Reviewed response") => act(async () => { const chat = chats[index]!; chat.response.resolve(reply(content, chat.call.body.model, chat.call.body.serviceProvider)); });
  const messages = () => [...dom.container.querySelectorAll(".assistant-message-content")].map(node => node.textContent);
  const progress = () => dom.container.querySelector<HTMLElement>(".assistant-task-progress")!;
  const evidence = () => dom.container.querySelector(".assistant-model-evidence")?.textContent;
  try {
    await render(); assert.equal(calls.length, 0);
    if (scenario === "api-service-context") {
      await connect();
      assert.equal(evidence(), "Model list loaded.");
      await send("Local-only conversation before switching services");
      await resolveReply(0, "Old local reply remains visible");
      await type("Unsent draft stays in the composer");
      await click("Model settings");
      await click("API services");
      assert.equal(calls.at(-1)?.path, "/ui/api/settings/assistant/services");
      assert.equal(chats.length, 1, "Opening or applying a saved service must not send the draft");
      await click("Apply to this conversation");
      assert.equal(evidence(), undefined, "Selecting a saved service does not verify its list or reply");
      assert.equal(input().value, "Unsent draft stays in the composer");
      assert.ok(dom.container.textContent?.includes("Send to Synthetic work API"));
      await click("Send message ↑");
      assert.equal(chats.length, 2);
      const { requestId, ...body } = chats[1]!.call.body;
      assert.ok(requestId);
      assert.deepEqual(body, { serviceId: apiService.id, serviceProvider: apiService.provider, serviceEndpoint: apiService.endpoint,
        model: apiService.model, messages: [{ role: "user", content: "Unsent draft stays in the composer" }], includeWorkspaceOverview: false });
      await resolveReply(1, "Synthetic API answer");
      assert.equal(evidence(), "Model replied");
      assert.deepEqual(messages(), ["Local-only conversation before switching services", "Old local reply remains visible", "Unsent draft stays in the composer", "Synthetic API answer"]);
      return;
    }
    if (apiReadiness) {
      const keyInput = () => dom.container.querySelector<HTMLInputElement>('.assistant-api-form input[type="password"]')!;
      const typeKey = (value: string) => act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(keyInput(), value);
        keyInput().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await type("Keep this draft through key repair");
      await click("Model settings"); await click("Use default model");
      assert.equal(evidence(), "API key required for this session");
      assert.equal(dom.window.document.activeElement, keyInput());
      assert.equal(button("Test and load models").disabled, true);
      assert.equal(button("Send message ↑").disabled, true);
      assert.equal(chats.length, 0);
      await typeKey("synthetic-first-key"); await click("Test and load models");
      assert.match(dom.container.querySelector(".assistant-api-form")!.textContent, /Model list loaded/);
      assert.equal(chats.length, 0, "A catalog test must not send the composer draft");
      await click("Save and apply");
      assert.equal(evidence(), "Model list loaded.");
      assert.equal(keyInput().value, "", "The saved key is removed from the input");
      await click("Send message ↑");
      await act(async () => { chats[0]!.response.resolve(json({ ok: false, error: "Fixture rejected the key", code: "auth", retryable: false }, 401)); });
      assert.equal(evidence(), "Model connection needs attention");
      assert.equal(button("Send message ↑").disabled, true);
      assert.equal(input().value, "Keep this draft through key repair");
      await click("Update API key");
      assert.equal(dom.window.document.activeElement, keyInput());
      await typeKey("synthetic-replacement-key"); await click("Save and apply");
      assert.equal(evidence(), undefined, "An updated key invalidates the earlier catalog check");
      assert.equal(chats.length, 1);
      await click("Send message ↑");
      await resolveReply(1, "Synthetic answer after repair");
      assert.equal(evidence(), "Model replied");
      assert.deepEqual(messages(), ["Keep this draft through key repair", "Synthetic answer after repair"]);
      assert.ok(storageWrites.every(write => write.key === "aliasmode.shell.language"));
      return;
    }
    if (scenario === "welcome-preserves-draft") {
      const example = dom.container.querySelector<HTMLButtonElement>(".assistant-examples button")!;
      const original = "  Keep the user's exact work. \n";
      const prompt = "Help me plan a repeatable browser testing workflow. Break it into clear steps and explain which steps can use MCP.";
      await type(original);
      await act(async () => example.click());
      assert.equal(input().value, `${original}\n\n${prompt}`);
      assert.equal(dom.window.document.activeElement, input());
      assert.deepEqual(closeRegistry.getSnapshot().dirty, ["assistant-draft"]);
      const fullDraft = "界".repeat(2730);
      await type(fullDraft); await act(async () => example.click());
      assert.equal(input().value, fullDraft, "The UTF-8 limit must leave existing draft text intact");
      assert.ok(dom.container.querySelector('.assistant-feedback [role="alert"]')?.textContent?.includes("8 KiB"));
      assert.equal(calls.length, 0, "Examples never connect to a model or send a message");
      return;
    }
    if (scenario === "desktop-draft") {
      await type("  PRIVATE_UNSENT_AI_DRAFT  ");
      assert.deepEqual(closeRegistry.getSnapshot().dirty, ["assistant-draft"]);
      assert.ok(!JSON.stringify(closeRegistry.getSnapshot()).includes("PRIVATE_UNSENT_AI_DRAFT"));
      await render(false);
      assert.deepEqual(closeRegistry.getSnapshot().dirty, ["assistant-draft"], "A hidden session still protects its unsent draft");
      await render();
      assert.equal(input().value, "  PRIVATE_UNSENT_AI_DRAFT  ");
      await connect(); await click("Send message ↑");
      assert.deepEqual(closeRegistry.getSnapshot().dirty, []);
      assert.deepEqual(closeRegistry.getSnapshot().busy, [], "A text generation does not block native closure as a write");
      await render(false);
      assert.deepEqual(closeRegistry.getSnapshot().dirty, ["assistant-draft"], "Navigation cancellation restores protection for the draft");
      await act(async () => coordinator.setWorkspace("two", "two"));
      assert.deepEqual(closeRegistry.getSnapshot().dirty, [], "An old workspace's owner does not leak into the new one");
      assert.equal(chats.length, 1);
      return;
    }
    if (scenario === "empty-scroll") {
      const conversation = dom.container.querySelector<HTMLElement>(".assistant-messages")!;
      assert.equal(conversation.scrollTop, 0, "An empty welcome must start at the top, even when its prompts overflow a short viewport");
      await connect(); await send("Restore the draft when leaving this generation.");
      assert.equal(conversation.scrollTop, 900, "Real conversation messages still follow the bottom of their own scroll area");
      await render(false); await render();
      assert.equal(conversation.scrollTop, 0, "Returning after cancellation must not crop the welcome icon and heading");
      assert.equal(input().value, "Restore the draft when leaving this generation.");
      await resolveReply(0, "A late response must stay ignored");
      assert.equal(conversation.scrollTop, 0); assert.deepEqual(messages(), []); return;
    }
    if (scenario === "connection-retry") {
      await type("  Keep this connection draft.  "); await connect();
      assert.ok(dom.container.textContent?.includes("Fixture connection unavailable"));
      await click("Model settings"); assert.ok(dom.container.querySelector(".assistant-connection-recovery"));
      failModels = false; await click("Retry connection", true);
      assert.equal(calls.filter(call => call.path.endsWith("/models")).length, 2); assert.equal(chats.length, 0);
      assert.equal(input().value, "  Keep this connection draft.  "); assert.equal(dom.container.querySelector(".assistant-connection-recovery"), null); return;
    }
    if (scenario === "readonly-navigation") {
      await connect(); assert.equal(models.length, 1); await render(false);
      assert.equal(models[0]!.call.signal?.aborted, false); assert.equal(cancellations.length, 0);
      const outside = dom.container.querySelector<HTMLButtonElement>("[data-outside]")!; outside.focus();
      await act(async () => models[0]!.response.resolve(json(catalog("one-loaded-while-hidden"))));
      assert.equal(dom.window.document.activeElement, outside); await render();
      assert.ok(dom.container.querySelector(".assistant-model-summary")?.textContent?.includes("one-loaded-while-hidden")); assert.equal(calls.length, 1); return;
    }
    if (scenario === "workspace-models") {
      await connect(); const old = models[0]!;
      await act(async () => coordinator.setWorkspace("two", "two")); assert.equal(old.call.signal?.aborted, true); assert.equal(cancellations.length, 0);
      holdModels = false; await connect(); await act(async () => old.response.resolve(json(catalog("STALE_OLD_WORKSPACE_MODEL"))));
      assert.ok(dom.container.querySelector(".assistant-model-summary")?.textContent?.includes("two-model")); assert.ok(!dom.container.textContent?.includes("STALE_OLD_WORKSPACE_MODEL")); return;
    }
    await connect();
    if (scenario === "find-conversation") {
      await send("First completed request uses [ALPHA]+.");
      await resolveReply(0, "The first response provides ordinary context.");
      await send("Second completed request.");
      const longResponse = "Many lines of ordinary response text.\n".repeat(150) + "Last line uses [alpha]+.";
      await resolveReply(1, longResponse);
      await type("PRIVATE_UNSENT_DRAFT");
      const viewport = dom.container.querySelector<HTMLElement>(".assistant-messages")!;
      Object.defineProperties(viewport, { clientHeight: { value: 240 }, scrollHeight: { value: 960 } });
      Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value(this: HTMLElement) {
        const top = this.tagName === "MARK" ? 100 + (this.textContent === "[ALPHA]+" ? 300 : 700) - viewport.scrollTop : 100;
        return new dom.window.DOMRect(0, top, 300, 24);
      } });
      const search = () => dom.container.querySelector<HTMLInputElement>(".assistant-find input");
      const match = () => dom.container.querySelector<HTMLElement>("mark[data-assistant-find-match]");
      const count = () => dom.container.querySelector(".assistant-find-count")?.textContent;
      const query = (value: string) => act(async () => {
        const node = search()!;
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value);
        node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      const key = (value: string, options: { shiftKey?: boolean; isComposing?: boolean } = {}) => act(async () => {
        search()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }));
      });
      const initialRequests = calls.length;
      await click("Find in conversation");
      assert.equal(dom.window.document.activeElement, search());
      await query("[alpha]+");
      assert.equal(count(), "1 of 2 matching messages");
      assert.equal(match()?.textContent, "[ALPHA]+");
      assert.equal(viewport.scrollTop, 288);
      await key("Enter", { isComposing: true });
      await key("Escape", { isComposing: true });
      assert.equal(count(), "1 of 2 matching messages", "IME keys do not navigate or close a search");
      await key("Enter");
      assert.equal(count(), "2 of 2 matching messages");
      assert.equal(match()?.textContent, "[alpha]+");
      assert.equal(match()?.parentElement?.textContent, longResponse, "Highlighting preserves exact visible message text");
      assert.equal(viewport.scrollTop, 688, "The matched text near the bottom of a long reply is scrolled into view");
      assert.equal(dom.window.document.activeElement, search(), "Find navigation leaves typing focus alone");
      await key("Enter", { shiftKey: true });
      assert.equal(count(), "1 of 2 matching messages");
      await click("Next match");
      assert.equal(count(), "2 of 2 matching messages");
      assert.equal(calls.length, initialRequests, "Local search never uses a request");
      assert.equal(input().value, "PRIVATE_UNSENT_DRAFT");
      await send("Pending third request has [ALPHA]+.");
      assert.equal(count(), "2 of 2 matching messages", "The pending request is outside the completed results");
      assert.equal(viewport.scrollTop, 688, "A reader near the tail does not follow a request while finding text");
      assert.equal(cancellations.length, 0, "Finding text does not cancel a running request");
      await resolveReply(2, "Third completed response also has [Alpha]+.");
      assert.equal(count(), "2 of 4 matching messages");
      assert.equal(viewport.scrollTop, 688, "A completed response updates count without moving the search selection");
      await query("no results for this query");
      assert.equal(count(), "No matching messages.");
      assert.equal(match(), null);
      assert.ok(button("Previous match").disabled);
      await key("Escape");
      assert.equal(search(), null);
      assert.equal(dom.window.document.activeElement, button("Find in conversation"));
      await click("Find in conversation");
      await query("[alpha]+");
      await click("New conversation");
      assert.equal(search(), null);
      assert.deepEqual(messages(), []);
      await click("Undo");
      await click("Find in conversation");
      assert.equal(search()?.value, "", "Restoring the old conversation does not restore its search query");
      await query("[alpha]+");
      const staleNext = button("Next match");
      await act(async () => { coordinator.setWorkspace("two", "two"); staleNext.click(); });
      assert.equal(search(), null);
      assert.equal(match(), null);
      assert.deepEqual(messages(), []);
      assert.equal(chats.length, 3);
      return;
    }
    if (scenario === "copy-conversation") {
      const clipboard: string[] = [], writes: Array<ReturnType<typeof deferred<void>>> = [];
      let failClipboard = false;
      Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText(value: string) {
        clipboard.push(value);
        if (failClipboard) return Promise.reject(new Error("PRIVATE_CLIPBOARD_FAILURE"));
        const receipt = deferred<void>(); writes.push(receipt); return receipt.promise;
      } } });
      suggestion = { id: 4, text: "User-visible context", source: { title: "PRIVATE_LOCAL_TASK", description: "PRIVATE_LOCAL_PROFILE", returnKey: "PRIVATE_RETURN_KEY" } };
      await render(); await click("Add to draft");
      const request = "Review this visible request.";
      const response = "First line\n<em>Plain text</em>";
      await send(request);
      assert.ok(!dom.container.querySelector(".assistant-chat-actions")?.textContent?.includes("Copy conversation"));
      await resolveReply(0, response);
      assert.ok(dom.container.textContent?.includes("PRIVATE_LOCAL_TASK"));
      assert.ok(dom.container.textContent?.includes("Anonymous workspace overview included"));
      await type("PRIVATE_UNSENT_DRAFT");
      await click("Copy conversation", true);
      const transcript = `You\n${request}\n\nAssistant\n${response}`;
      assert.deepEqual(clipboard, [transcript], "Only role labels and visible completed message text may enter the clipboard");
      assert.ok(button("Copy conversation").disabled);
      assert.equal(input().value, "PRIVATE_UNSENT_DRAFT");
      await act(async () => writes[0]!.resolve(undefined));
      assert.equal(dom.container.querySelector('.assistant-copy-feedback[role="status"]')?.textContent, "Conversation copied.");
      await send("PRIVATE_WAITING_REQUEST");
      await click("Copy conversation");
      assert.deepEqual(clipboard, [transcript, transcript], "A visible pending request is not part of the completed transcript");
      await act(async () => writes[1]!.resolve(undefined));
      await click("Cancel request");
      failClipboard = true; await click("Copy conversation");
      assert.deepEqual(clipboard, [transcript, transcript, transcript]);
      assert.ok(dom.container.querySelector('.assistant-copy-feedback[role="alert"]')?.textContent?.includes("Could not copy the conversation."));
      assert.ok(!dom.container.textContent?.includes("PRIVATE_CLIPBOARD_FAILURE"));
      assert.equal(input().value, "PRIVATE_WAITING_REQUEST");
      const staleCopy = button("Copy conversation");
      await act(async () => { coordinator.setWorkspace("two", "two"); staleCopy.click(); });
      assert.equal(clipboard.length, 3, "A stale workspace control cannot copy after the active workspace changes");
      assert.deepEqual(messages(), []);
      assert.equal(chats.length, 2, "Copy does not send or replay requests");
      return;
    }
    if (scenario === "proposal-prose") {
      const clipboard: string[] = [];
      Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { async writeText(value: string) { clipboard.push(value); } } });
      const prose = "Review these checks.\n\n```text\nVisible example\n```";
      const proposalFence = '```maobu-proposal\n{"internalId":"HIDDEN_STRUCTURED_PAYLOAD"}\n```';
      const resolveProposal = async (index: number, content: string) => {
        const chat = chats[index]!;
        const action: CompiledProposalView["action"] = { type: "filter_anomalous_profiles", criteria: ["no_proxy"] };
        const proposal: CompiledProposalView = {
          proposalId: `fixture-${index}`, planHash: "a".repeat(64), workspaceId: "one", createdAt: 1, expiresAt: 2,
          title: "Synthetic review card", summary: "Only a review fixture.", actionType: action.type,
          action, risk: "read-only",
          requiresSecondaryConfirm: false, mutatesWorkspace: false, warnings: [], counts: { total: 0, actionable: 0, skipped: 0 }, items: [],
        };
        const envelope = await reply(content, chat.call.body.model).json();
        await act(async () => chat.response.resolve(json({ ...envelope, proposal })));
      };
      await send("Show visible response text");
      await resolveProposal(0, `${prose}\n\n${proposalFence}`);
      assert.deepEqual(messages(), ["Show visible response text", prose]);
      await click("Copy");
      await click("Copy conversation");
      const firstTranscript = `You\nShow visible response text\n\nAssistant\n${prose}`;
      assert.deepEqual(clipboard, [prose, firstTranscript], "A hidden proposal fence must not enter either clipboard action");
      await type("My question");
      await click("Use response as draft");
      assert.equal(input().value, `My question\n\n${prose}`);
      assert.equal(chats.length, 1, "Preparing a visible reply as draft must not send or execute it");

      await send("Show only a review card");
      await resolveProposal(1, proposalFence);
      const cardOnly = dom.container.querySelectorAll<HTMLElement>(".assistant-message.assistant")[1]!;
      assert.ok(cardOnly.querySelector(".proposal-card"), "A card-only response keeps its review UI");
      assert.equal(cardOnly.querySelector(".assistant-message-content"), null);
      assert.ok(![...cardOnly.querySelectorAll("button")].some(node => ["Copy", "Use response as draft"].includes(node.textContent?.trim() ?? "")));
      await click("Copy conversation");
      assert.equal(clipboard.at(-1), `${firstTranscript}\n\nYou\nShow only a review card`);
      assert.equal(chats.length, 2);
      return;
    }
    if (scenario === "reading-focus") {
      const transcript = dom.container.querySelector<HTMLElement>(".assistant-messages")!;
      const clipboard: string[] = [];
      Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { async writeText(value: string) { clipboard.push(value); } } });
      await send("Show a long text response");
      assert.equal(transcript.getAttribute("tabindex"), "0");
      assert.equal(transcript.getAttribute("aria-live"), "off");
      assert.equal(transcript.querySelector('[role="status"]'), null, "The visual waiting message must not create another live region");
      await click("Model settings");
      const settings = button("Model settings");
      await act(async () => settings.focus());
      const answer = "A long response begins here.\n" + "Line of ordinary model text.\n".repeat(150) + "<button>plain code</button>";
      await resolveReply(0, answer);
      assert.ok(dom.window.document.activeElement === settings, "A completed generation must not steal focus from model settings");
      assert.equal(progress().querySelector('[role="status"]')?.textContent, "Response received.");
      assert.equal(transcript.querySelector(".assistant-message.assistant .assistant-message-content")?.textContent, answer);
      assert.equal(transcript.querySelector(".assistant-message-content button"), null, "Model content stays inert text");

      const outside = dom.container.querySelector<HTMLButtonElement>("[data-outside]")!;
      await render(false);
      await act(async () => outside.focus());
      await render();
      assert.ok(dom.window.document.activeElement === outside, "Returning to a workspace with open settings must not steal focus");
      await click("Read latest response");
      const heading = transcript.querySelector<HTMLElement>("[data-assistant-reply-heading]")!;
      assert.ok(dom.window.document.activeElement === heading, "Explicit navigation must land on the reply heading");
      assert.equal(heading.tagName, "H3");
      assert.deepEqual(clipboard, []);
      await click("Copy");
      assert.deepEqual(clipboard, [answer], "Copy keeps the exact text and requires a separate user action");
      assert.equal(chats.length, 1);
      return;
    }
    if (scenario === "workspace-boundary-click") {
      await type("PRIVATE_PREVIOUS_WORKSPACE_DRAFT"); await click("Model settings");
      const staleSend = button("Send message ↑"), staleConnect = button("Connect & load models");
      await act(async () => { coordinator.setWorkspace("two", "two"); staleSend.click(); staleConnect.click(); });
      assert.equal(chats.length, 0, "A same-event stale control must not send the old workspace draft under the new identity");
      assert.equal(calls.filter(call => call.path.endsWith("/models")).length, 1, "Connection ownership must be checked before issuing the request too");
      assert.equal(input().value, ""); return;
    }
    if (scenario === "workspace-cancel-late") {
      await send("PRIVATE_OLD_CANCEL_PROMPT"); await click("Cancel request"); assert.equal(cancellations.length, 1);
      await act(async () => coordinator.setWorkspace("two", "two"));
      await connect(); await send("New workspace generation");
      await act(async () => cancellations[0]!.response.resolve(json({ ok: true, cancelled: false })));
      assert.ok(progress().classList.contains("waiting")); assert.equal(progress().dataset.cancellation, undefined); assert.equal(input().disabled, true);
      await resolveReply(0, "PRIVATE_OLD_CANCEL_RESPONSE"); await resolveReply(1, "New workspace answer");
      assert.deepEqual(messages(), ["New workspace generation", "New workspace answer"]); return;
    }
    if (scenario === "workspace-inflight") {
      await send("PRIVATE_OLD_WORKSPACE_PROMPT"); const old = chats[0]!;
      suggestion = { id: 1, text: "Anonymous old context", source: { title: "PRIVATE_OLD_WORKSPACE_SOURCE", returnKey: "old-target" } };
      await render(); await act(async () => coordinator.setWorkspace("two", "two"));
      assert.equal(old.call.signal?.aborted, true); assert.equal(cancellations.length, 1); assert.equal(cancellations[0]!.call.body.requestId, old.call.body.requestId);
      assert.equal(input().value, ""); assert.deepEqual(messages(), []); assert.equal(dom.container.querySelector(".assistant-suggestion"), null);
      await connect(); await send("Only the new workspace request");
      await resolveReply(0, "PRIVATE_STALE_OLD_RESPONSE");
      assert.ok(progress().classList.contains("waiting")); assert.equal(input().disabled, true); assert.ok(!dom.container.textContent?.includes("PRIVATE_STALE_OLD_RESPONSE"));
      await resolveReply(1, "Only the new workspace answer"); assert.deepEqual(messages(), ["Only the new workspace request", "Only the new workspace answer"]);
      assert.ok(!JSON.stringify(chats[1]!.call.body).includes("PRIVATE_OLD")); return;
    }
    if (scenario === "cancel-late" || scenario === "cancel-false" || scenario === "cancel-error") {
      const raw = "  Original prompt with whitespace. \n"; await send(raw); const old = chats[0]!;
      await click("Cancel request", true); assert.equal(old.call.signal?.aborted, true); assert.equal(cancellations.length, 1); assert.equal(input().value, raw); assert.equal(input().disabled, false);
      if (scenario === "cancel-late") {
        assert.equal(button("Send message ↑").disabled, true); await type("The newer draft must survive.");
        await resolveReply(0, "STALE_CANCELLED_RESPONSE"); assert.deepEqual(messages(), []); assert.equal(input().value, "The newer draft must survive.");
        await act(async () => cancellations[0]!.response.resolve(json({ ok: true, cancelled: true })));
        assert.equal(input().value, "The newer draft must survive."); assert.ok(!dom.container.textContent?.includes("STALE_CANCELLED_RESPONSE"));
      } else {
        assert.equal(progress().dataset.cancellation, "unconfirmed"); assert.ok(progress().textContent?.includes("could not be confirmed"));
        assert.equal(progress().hidden, false, "Unconfirmed cancellation must stay visible outside the guide");
        assert.ok(!dom.container.textContent?.includes("PRIVATE_CANCEL_ERROR"));
        cancellationResult = true; await click("Retry cancellation", true); assert.equal(cancellations.length, 2);
        assert.equal(cancellations[1]!.call.body.requestId, old.call.body.requestId); assert.equal(chats.length, 1);
        await resolveReply(0, "STALE_CANCELLED_RESPONSE"); assert.deepEqual(messages(), []);
        assert.ok(dom.container.textContent?.includes("Request cancelled. Your draft is ready to edit."));
      }
      return;
    }
    if (scenario === "wait-clock") {
      const now = originalNow(); Date.now = () => now;
      await send("A request with measured local waiting time"); assert.ok(progress().textContent?.includes("Leaving this page stops waiting and attempts to cancel"));
      Date.now = () => now + 6000;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
      assert.ok(progress().querySelector(".assistant-waiting-clock")?.textContent?.includes("6s")); assert.equal(progress().querySelector("progress"), null);
      await click("Cancel request"); assert.equal(progress().querySelector(".assistant-waiting-clock"), null); return;
    }
    await send("First completed request"); await resolveReply(0, "First completed answer");
    if (scenario === "model-disappeared") {
      await send("Keep this request for model repair"); await act(async () => chats[1]!.response.resolve(json({ ok: false, error: "Fixture model was removed", code: "model-not-found", retryable: false }, 404)));
      assert.deepEqual(messages(), ["First completed request", "First completed answer"]); assert.equal(input().value, "Keep this request for model repair");
      assert.ok(dom.container.querySelector(".assistant-connection-recovery")); assert.equal(button("Send message ↑").disabled, true);
      await click("Retry connection"); assert.equal(button("Send message ↑").disabled, false); assert.equal(chats.length, 2, "Reconnecting must not resend a draft"); return;
    }
    if (scenario === "workspace-memory") {
      suggestion = { id: 1, text: "Anonymous inspection draft", source: { title: "PRIVATE_OLD_SOURCE", returnKey: "old-key" } };
      await render(); await click("Add to draft"); await type("PRIVATE_OLD_DRAFT"); await render();
      await act(async () => coordinator.setWorkspace("two", "two"));
      assert.equal(input().value, ""); assert.deepEqual(messages(), []); assert.equal(dom.container.querySelector(".assistant-task-source"), null); assert.equal(dom.container.querySelector(".assistant-suggestion"), null);
      assert.ok(!dom.container.textContent?.includes("PRIVATE_OLD_SOURCE")); assert.equal(cancellations.length, 0);
      await type("Workspace two draft"); await act(async () => coordinator.setWorkspace("one", "one")); assert.equal(input().value, ""); assert.deepEqual(messages(), []); return;
    }
    const draft = "  A follow-up draft. \n"; await type(draft); const originalInput = input();
    if (scenario === "navigation-memory" || scenario === "no-storage") {
      const before = calls.length; await render(false); await render();
      assert.equal(input(), originalInput); assert.equal(input().value, draft); assert.deepEqual(messages(), ["First completed request", "First completed answer"]);
      assert.equal(calls.length, before); assert.equal(cancellations.length, 0); return;
    }
    assert.ok(scenario === "navigation-stops" || scenario === "navigation-unconfirmed");
    await click("Send message ↑"); const old = chats[1]!; await render(false);
    assert.equal(old.call.signal?.aborted, true); assert.equal(cancellations.length, 1); assert.equal(cancellations[0]!.call.body.requestId, old.call.body.requestId);
    await resolveReply(1, "STALE_HIDDEN_RESPONSE"); await render();
    assert.equal(input(), originalInput); assert.equal(input().value, draft); assert.deepEqual(messages(), ["First completed request", "First completed answer"]);
    if (scenario === "navigation-unconfirmed") { assert.equal(progress().dataset.cancellation, "unconfirmed"); cancellationResult = true; await click("Retry cancellation"); assert.equal(cancellations.length, 2); }
    assert.ok(dom.container.textContent?.includes("cancelled when you left AI workspace")); assert.ok(!dom.container.textContent?.includes("STALE_HIDDEN_RESPONSE"));
  } finally {
    Date.now = originalNow;
    assert.ok(storageWrites.every(write => write.key === "aliasmode.shell.language"), "No conversation, model endpoint, credential, or draft may be written to browser storage");
    for (const operation of chats) operation.response.resolve(json({ ok: false, error: "Fixture teardown" }, 499));
    for (const operation of models) operation.response.resolve(json(catalog()));
    for (const operation of cancellations) operation.response.resolve(json({ ok: true, cancelled: true }));
    await dom.cleanup();
  }
}
await run(process.argv[2] ?? "navigation-memory"); console.log("local assistant workspace session fixture passed");
