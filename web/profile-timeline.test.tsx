import { afterEach, describe, expect, test } from "bun:test";
import { Window, type HTMLButtonElement as HappyButtonElement } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ProfileTimelineEvent } from "../profile-timeline.ts";
import { I18nProvider } from "./i18n.tsx";
import { ProfileTimeline } from "./profile-timeline.tsx";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function createDomHarness(fetchImpl: typeof fetch) {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  setGlobal("window", dom);
  setGlobal("document", dom.document);
  setGlobal("navigator", dom.navigator);
  setGlobal("localStorage", dom.localStorage);
  setGlobal("HTMLElement", dom.HTMLElement);
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("HTMLSelectElement", dom.HTMLSelectElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("KeyboardEvent", dom.KeyboardEvent);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", fetchImpl);

  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root: Root | null = createRoot(container as unknown as HTMLElement);

  const cleanup = async () => {
    try {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
        root = null;
      }
      await dom.happyDOM.close();
    } finally {
      for (const [key, desc] of prev) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  cleanups.push(cleanup);

  return {
    dom,
    container,
    async render(node: React.ReactNode) {
      await act(async () => {
        root!.render(node);
      });
    },
    async flush() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

describe("ProfileTimeline component", () => {
  test("loads timeline, runs credential-free check-proxy, triggers recovery actions, paginates, and clears", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    let events: ProfileTimelineEvent[] = [
      {
        id: 20,
        profileId: "env_tl",
        eventType: "launch.failed",
        status: "failed",
        actor: "user",
        summary: "Launch failed: proxy connection refused.",
        detail: { reason: "unreachable" },
        recoveryKind: "proxy",
        createdAt: 1_795_000_200_000,
      },
      {
        id: 19,
        profileId: "env_tl",
        eventType: "config.updated",
        status: "ok",
        actor: "user",
        summary: "Updated configuration fields: proxy, tags.",
        detail: { fields: ["proxy", "tags"] },
        recoveryKind: "",
        createdAt: 1_795_000_100_000,
      },
    ];
    const olderEvents: ProfileTimelineEvent[] = [
      {
        id: 10,
        profileId: "env_tl",
        eventType: "profile.created",
        status: "ok",
        actor: "user",
        summary: "Created environment.",
        detail: {},
        recoveryKind: "",
        createdAt: 1_795_000_000_000,
      },
    ];

    const originalFetch = globalThis.fetch;
    const h = await createDomHarness(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const path = String(input);
          const method = init?.method ?? "GET";
          if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
          requests.push({ path, method });

          if (path.startsWith("/ui/api/profiles/env_tl/timeline") && method === "GET") {
            const url = new URL(path, "http://127.0.0.1");
            if (url.searchParams.get("beforeId") === "19") {
              return Response.json({
                ok: true,
                profileId: "env_tl",
                events: olderEvents,
                hasMore: false,
                nextBeforeId: null,
              });
            }
            return Response.json({
              ok: true,
              profileId: "env_tl",
              events,
              hasMore: events.length > 0,
              nextBeforeId: events.length > 0 ? 19 : null,
            });
          }

          if (path === "/ui/api/profiles/env_tl/check-proxy" && method === "POST") {
            events = [
              {
                id: 21,
                profileId: "env_tl",
                eventType: "proxy.checked",
                status: "ok",
                actor: "user",
                summary: "Proxy reachable (203.0.113.8, JP).",
                detail: { status: "working", ip: "203.0.113.8", country: "JP" },
                recoveryKind: "",
                createdAt: 1_795_000_300_000,
              },
              ...events,
            ];
            return Response.json({
              ok: true,
              checkedAt: 1_795_000_300_000,
              status: "working",
              attempts: 3,
              successes: 3,
              ip: "203.0.113.8",
              country: "JP",
              exitComparison: "different",
            });
          }

          if (path === "/ui/api/profiles/env_tl/timeline" && method === "DELETE") {
            events = [];
            return Response.json({ ok: true, profileId: "env_tl", removed: 3 });
          }

          throw new Error(`Unexpected timeline test request: ${method} ${path}`);
        },
        { preconnect: originalFetch.preconnect },
      ),
    );

    let logsOpened = 0;
    const editedProxies: string[] = [];
    const retried: string[] = [];

    await h.render(
      <I18nProvider>
        <ProfileTimeline
          profileId="env_tl"
          hasProxy
          running={false}
          onOpenLogs={() => {
            logsOpened++;
          }}
          onEditProxy={(id) => {
            editedProxies.push(id);
          }}
          onRetryLaunch={(id) => {
            retried.push(id);
          }}
        />
      </I18nProvider>,
    );
    await h.flush();

    expect(h.container.textContent).toContain("Launch failed: proxy connection refused.");
    expect(h.container.textContent).toContain("proxy, tags");

    // Contextual recovery buttons on failed proxy launch item.
    const recovery = h.container.querySelector(".timeline-recovery-actions")!;
    expect(recovery).toBeTruthy();
    const editProxyBtn = Array.from(recovery.querySelectorAll<HappyButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Edit proxy",
    )!;
    const viewLogsBtn = Array.from(recovery.querySelectorAll<HappyButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "View logs",
    )!;
    const retryBtn = Array.from(recovery.querySelectorAll<HappyButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Retry launch",
    )!;

    await act(async () => {
      editProxyBtn.click();
      viewLogsBtn.click();
      retryBtn.click();
    });
    await h.flush();
    expect(editedProxies).toEqual(["env_tl"]);
    expect(logsOpened).toBe(1);
    expect(retried).toEqual(["env_tl"]);

    // One-click proxy check uses server-side POST /check-proxy without reading profile edit credentials.
    const freshCheckProxyBtn = Array.from(
      h.container.querySelectorAll<HappyButtonElement>(".timeline-recovery-actions button"),
    ).find((b) => b.textContent?.trim() === "Check proxy")!;
    expect(freshCheckProxyBtn).toBeTruthy();
    await act(async () => {
      freshCheckProxyBtn.click();
    });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/profiles/env_tl/check-proxy" && r.method === "POST")).toBe(true);
    expect(requests.some((r) => r.path === "/ui/api/profiles/env_tl" && r.method === "GET")).toBe(false);
    expect(h.container.textContent).toContain("Proxy reachable");
    expect(h.container.textContent).toContain("203.0.113.8");

    // Load older activity via cursor pagination.
    const loadMoreBtn = h.container.querySelector<HappyButtonElement>(".timeline-load-more")!;
    await act(async () => {
      loadMoreBtn.click();
    });
    await h.flush();
    expect(h.container.textContent).toContain("Created environment.");

    // Clear timeline via two-step confirm.
    const clearTrigger = h.container.querySelector<HappyButtonElement>('button[aria-label="Clear timeline"]')!;
    await act(async () => {
      clearTrigger.click();
    });
    const confirmClear = Array.from(h.dom.document.querySelectorAll<HappyButtonElement>('[role="alertdialog"] button')).find(
      (b) => b.textContent?.trim() === "Confirm clear",
    )!;
    await act(async () => {
      confirmClear.click();
    });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/profiles/env_tl/timeline" && r.method === "DELETE")).toBe(true);
    expect(h.container.textContent).toContain("No activity recorded for this environment yet.");
  });

  test("a malformed timeline leaves a retryable error instead of reporting no activity", async () => {
    let requests = 0;
    const h = await createDomHarness(Object.assign(async (input: RequestInfo | URL) => {
      if (String(input) === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      requests++;
      return Response.json({ ok: true, profileId: "env_bad", events: requests === 1 ? [{
        id: 4, profileId: "env_bad", eventType: "profile.created", status: "ok", actor: "user",
        summary: "Example record", detail: null, recoveryKind: "", createdAt: 1_795_000_200_000,
      }] : [], hasMore: false, nextBeforeId: null });
    }, { preconnect: globalThis.fetch.preconnect }));
    await h.render(<I18nProvider><ProfileTimeline profileId="env_bad" /></I18nProvider>);
    await h.flush();
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("Unable to load activity timeline.");
    expect(h.container.textContent).not.toContain("No activity recorded");
    const retry = h.container.querySelector<HappyButtonElement>(".timeline-error-action button")!;
    await act(async () => { retry.click(); });
    await h.flush();
    expect(requests).toBe(2);
    expect(h.container.textContent).toContain("No activity recorded for this environment yet.");
  });
});
