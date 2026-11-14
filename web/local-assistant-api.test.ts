import { afterEach, describe, expect, test } from "bun:test";
import { AssistantRequestError, cancelLocalAssistant, fetchLocalModels, sendLocalAssistant, type LocalAssistantChatInput, type LocalAssistantChatResult, type LocalModelCatalog } from "./local-assistant-api.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const endpoint = "http://127.0.0.1:11434";
const catalog: LocalModelCatalog = { provider: "ollama", endpoint, checkedAt: "2026-11-09T05:00:00Z", excludedRemoteModels: 0, models: [{ name: "qwen3:8b", sizeBytes: 1_000_000, parameterSize: "8B", quantization: "Q4_K_M" }] };
const input: LocalAssistantChatInput = { endpoint, model: "qwen3:8b", messages: [{ role: "user", content: "Draft a testing plan." }], includeWorkspaceOverview: false };
const reply: LocalAssistantChatResult = { provider: "ollama", model: input.model, message: { role: "assistant", content: "A model-generated draft for review." }, createdAt: "2026-11-09T05:00:00Z", workspaceOverviewIncluded: false, usage: { promptTokens: 20, completionTokens: 12 }, durationMs: 1000 };
function respond(value: unknown, status = 200) { globalThis.fetch = (async () => Response.json(value, { status })) as unknown as typeof fetch; }

describe("local assistant browser client", () => {
  test("models and chat use explicit same-origin JSON requests with the settings header and signal", async () => {
    const calls: Array<{ path: unknown; options?: RequestInit }> = [], controller = new AbortController();
    globalThis.fetch = (async (path: unknown, options?: RequestInit) => { calls.push({ path, options }); return Response.json(String(path).endsWith("/models") ? { ok: true, catalog } : { ok: true, reply }); }) as unknown as typeof fetch;
    expect(await fetchLocalModels(endpoint, controller.signal)).toEqual(catalog); expect(await sendLocalAssistant(input, controller.signal)).toEqual(reply);
    expect(calls.map(call => call.path)).toEqual(["/ui/api/settings/assistant/models", "/ui/api/settings/assistant/chat"]);
    for (const call of calls) {
      expect(call.options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const headers = new Headers(call.options!.headers); expect(headers.get("X-Maobu-Settings")).toBe("1"); expect(headers.get("Content-Type")).toBe("application/json"); expect(headers.get("Accept")).toBe("application/json"); expect(headers.get("Authorization")).toBe(null);
    }
    expect(JSON.parse(String(calls[0]!.options!.body))).toEqual({ endpoint }); expect(JSON.parse(String(calls[1]!.options!.body))).toEqual(input);
  });
  test("null and damaged catalog entries return a fixed error before rendering model controls", async () => {
    for (const broken of [null, { ...catalog, models: [null] }, { ...catalog, models: [{}] }, { ...catalog, models: [{ ...catalog.models[0], name: "" }] }, { ...catalog, models: [{ ...catalog.models[0], sizeBytes: -1 }] }, { ...catalog, excludedRemoteModels: -1 }]) {
      respond({ ok: true, catalog: broken }); await expect(fetchLocalModels(endpoint)).rejects.toThrow("The local assistant returned an invalid response.");
    }
  });
  test("missing, incomplete or empty replies produce an explainable fixed error", async () => {
    for (const broken of [null, {}, { ...reply, model: "" }, { ...reply, message: null }, { ...reply, message: { role: "assistant", content: " \n" } }, { ...reply, message: { role: "tool", content: "unexpected tool response" } }, { ...reply, durationMs: -1 }, { ...reply, workspaceOverviewIncluded: "true" }]) {
      respond({ ok: true, reply: broken }); await expect(sendLocalAssistant(input)).rejects.toThrow("The local assistant returned an invalid response.");
    }
  });
  test("structured backend errors retain their code and retry advice", async () => {
    respond({ ok: false, error: "The local Ollama service is unavailable. Start Ollama and check its local address.", code: "unavailable", retryable: true }, 503);
    try { await sendLocalAssistant(input); throw new Error("Expected assistant failure"); } catch (error) {
      expect(error).toBeInstanceOf(AssistantRequestError); expect(error).toMatchObject({ code: "unavailable", retryable: true }); expect((error as Error).message).toContain("Start Ollama");
    }
    respond({ ok: false }, 500); await expect(fetchLocalModels(endpoint)).rejects.toThrow("The local assistant request failed.");
  });
  test("malformed response bodies do not expose body fragments", async () => {
    globalThis.fetch = (async () => new Response("sensitive-invalid-json-fragment", { status: 502 })) as unknown as typeof fetch;
    await expect(sendLocalAssistant(input)).rejects.toThrow("The local assistant returned an invalid response.");
    for (const envelope of [null, [], 3, "bad"]) { respond(envelope); await expect(fetchLocalModels(endpoint)).rejects.toThrow("The local assistant request failed."); }
  });
  test("caller cancellation reaches fetch and remains distinguishable from model failures", async () => {
    let received: AbortSignal | null | undefined;
    globalThis.fetch = ((_path: unknown, options?: RequestInit) => { received = options?.signal; return new Promise((_resolve, reject) => received?.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true })); }) as unknown as typeof fetch;
    const controller = new AbortController(), pending = sendLocalAssistant(input, controller.signal); expect(received).toBe(controller.signal); controller.abort();
    try { await pending; throw new Error("Expected cancellation"); } catch (error) { expect((error as Error).name).toBe("AbortError"); expect(error).not.toBeInstanceOf(AssistantRequestError); }
  });
  test("explicit cancellation uses its own live bounded signal after the generation signal is aborted", async () => {
    const calls: Array<{ path: unknown; options?: RequestInit }> = [], controller = new AbortController();
    const requestId = "ca56b200-72d8-42b8-9958-628e0e32e849";
    globalThis.fetch = (async (path: unknown, options?: RequestInit) => { calls.push({ path, options }); return Response.json(String(path).endsWith("/cancel") ? { ok: true, cancelled: true } : { ok: true, reply }); }) as unknown as typeof fetch;
    await sendLocalAssistant(input, controller.signal, requestId); controller.abort(); expect(await cancelLocalAssistant(requestId)).toBe(true);
    expect(JSON.parse(String(calls[0]!.options!.body))).toEqual({ ...input, requestId });
    const cancel = calls[1]!; expect(cancel.path).toBe("/ui/api/settings/assistant/cancel"); expect(JSON.parse(String(cancel.options!.body))).toEqual({ requestId });
    expect(cancel.options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(cancel.options!.signal).toBeInstanceOf(AbortSignal); expect(cancel.options!.signal).not.toBe(controller.signal); expect(cancel.options!.signal!.aborted).toBe(false);
    const headers = new Headers(cancel.options!.headers); expect(headers.get("X-Maobu-Settings")).toBe("1"); expect(headers.get("Content-Type")).toBe("application/json");
  });
  test("explicit cancellation validates its acknowledgement before reporting success", async () => {
    const requestId = "ca56b200-72d8-42b8-9958-628e0e32e849";
    for (const cancelled of [true, false]) { respond({ ok: true, cancelled }); expect(await cancelLocalAssistant(requestId)).toBe(cancelled); }
    for (const acknowledgement of [{ ok: true }, { ok: true, cancelled: "yes" }, { ok: true, cancelled: null }]) {
      respond(acknowledgement); await expect(cancelLocalAssistant(requestId)).rejects.toThrow("The local assistant returned an invalid response.");
    }
  });
});
