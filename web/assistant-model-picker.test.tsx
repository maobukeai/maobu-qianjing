import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createWebDomHarness } from "../test-fixtures/web-dom.ts";
import { I18nProvider } from "./i18n.tsx";
import { LocalAssistantPage } from "./local-assistant.tsx";

describe("AI Workbench inline composer model picker & persistence memory", () => {
  test("restores the remembered default model on startup when autoLoadDefaultModel is true", async () => {
    const geminiService = {
      id: "model_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Google",
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "models/gemini-3.5-flash-lite",
      credentialConfigured: true,
    };
    const fetchMock = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        if (url === "/ui/api/settings/assistant/services") {
          return Response.json({
            ok: true,
            catalog: { services: [geminiService], defaultId: geminiService.id },
          });
        }
        return Response.json({ ok: false, error: "unexpected" }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const dom = await createWebDomHarness({ fetch: fetchMock });
    try {
      await dom.render(
        <I18nProvider>
          <LocalAssistantPage active autoLoadDefaultModel onOpenModelServices={() => {}} />
        </I18nProvider>,
      );
      await dom.flush();
      await dom.flush();

      const trigger = dom.container.querySelector(".assistant-model-picker-trigger");
      expect(trigger?.textContent).toContain("gemini-3.5-flash-lite");
      expect(dom.container.querySelector(".assistant-connection")?.hasAttribute("hidden")).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });

  test("opens upward grouped menu, switches service, and persists choice via /services/default", async () => {
    const svc1 = {
      id: "model_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Google",
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "models/gemini-3.5-flash-lite",
      credentialConfigured: true,
    };
    const svc2 = {
      id: "model_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "Work Relay",
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      credentialConfigured: true,
    };
    let savedDefaultId = svc1.id;
    const defaultPosts: Array<{ id: string | null }> = [];

    const fetchMock = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        if (url === "/ui/api/settings/assistant/services") {
          return Response.json({
            ok: true,
            catalog: { services: [svc1, svc2], defaultId: savedDefaultId },
          });
        }
        if (url === "/ui/api/settings/assistant/services/default" && init?.method === "POST") {
          const payload = JSON.parse(String(init.body ?? "{}")) as { id: string | null };
          defaultPosts.push(payload);
          savedDefaultId = payload.id ?? "";
          return Response.json({
            ok: true,
            catalog: { services: [svc1, svc2], defaultId: savedDefaultId },
          });
        }
        return Response.json({ ok: false, error: "unexpected" }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const dom = await createWebDomHarness({ fetch: fetchMock });
    try {
      await dom.render(
        <I18nProvider>
          <LocalAssistantPage active autoLoadDefaultModel onOpenModelServices={() => {}} />
        </I18nProvider>,
      );
      await dom.flush();
      await dom.flush();

      const trigger = dom.container.querySelector(".assistant-model-picker-trigger") as unknown as HTMLButtonElement;
      expect(trigger?.textContent).toContain("gemini-3.5-flash-lite");

      await act(async () => {
        trigger.click();
      });
      await dom.flush();
      await dom.flush();

      const options = [...dom.container.querySelectorAll(".assistant-model-option")] as unknown as HTMLButtonElement[];
      const relayOption = options.find((btn) => btn.textContent?.includes("gpt-4o-mini"));
      expect(relayOption).toBeDefined();

      await act(async () => {
        relayOption!.click();
      });
      await dom.flush();
      await dom.flush();

      expect(trigger.textContent).toContain("gpt-4o-mini");
      expect(defaultPosts).toEqual([{ id: svc2.id }]);
      expect(dom.container.querySelector(".assistant-model-popover")).toBeNull();
    } finally {
      await dom.cleanup();
    }
  });
});
