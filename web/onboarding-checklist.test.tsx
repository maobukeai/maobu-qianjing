import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import {
  deriveOnboardingSteps,
  ONBOARDING_STATE_KEY,
  OnboardingChecklist,
  type OnboardingChecklistState,
} from "./onboarding-checklist.tsx";

async function createHarness(fetchImpl: typeof fetch) {
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
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("fetch", fetchImpl);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { createRoot } = await import("react-dom/client");
  const rawContainer = dom.document.createElement("div");
  dom.document.body.appendChild(rawContainer);
  const container = rawContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 15));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else Reflect.deleteProperty(globalThis, k);
    }
  };
  return { dom, container, root, flush, cleanup };
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("OnboardingChecklist", () => {
  test("deriveOnboardingSteps computes real completion status from profile, proxy, launch, and tools state", () => {
    const empty = deriveOnboardingSteps({ profiles: [] });
    expect(empty.map((s) => s.completed)).toEqual([false, false, false, false]);

    const partial = deriveOnboardingSteps({
      profiles: [{ id: "p1", proxy: null, running: false, lastOpenAt: 0 }],
      proxyVaultCount: 2,
    });
    expect(partial.map((s) => s.completed)).toEqual([true, true, false, false]);

    const allDone = deriveOnboardingSteps({
      profiles: [{ id: "p1", proxy: "127.0.0.1:7890", running: false, lastOpenAt: 1_700_000_000 }],
      appLockEnabled: true,
    });
    expect(allDone.map((s) => s.completed)).toEqual([true, true, true, true]);
  });

  test("renders zero-modal 4-step checklist, persists collapse/dismiss to aliasmode.onboarding.state, and hides when dismissed", async () => {
    const savedPrefs: Array<{ key: string; value: string }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/ui/api/shell-language") return Response.json({ language: "en-US" });
      if (url.pathname === "/ui/api/workspace/capability") {
        return Response.json({ ok: true, token: "a".repeat(64) });
      }
      if (url.pathname === "/ui/api/workspace/preferences" && init?.method === "POST") {
        savedPrefs.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    let createdClicked = 0;
    let launchedId: string | null = null;
    await act(async () => {
      h.root.render(
        <I18nProvider>
          <OnboardingChecklist
            profiles={[{ id: "prof_1", proxy: "proxy.example:8080", running: false, lastOpenAt: 0 }]}
            autoPersist={true}
            onCreateProfile={() => { createdClicked++; }}
            onLaunchFirstProfile={(id) => { launchedId = id; }}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.querySelector("[data-onboarding-checklist='open']")).not.toBeNull();
    expect(h.container.querySelector("[data-onboarding-progress='2/4']")).not.toBeNull();
    expect(h.container.querySelector("[data-onboarding-step='create_profile']")?.getAttribute("data-completed")).toBe("true");
    expect(h.container.querySelector("[data-onboarding-step='configure_proxy']")?.getAttribute("data-completed")).toBe("true");
    expect(h.container.querySelector("[data-onboarding-step='launch_profile']")?.getAttribute("data-completed")).toBe("false");
    expect(createdClicked).toBe(0);

    // Click launch first profile CTA
    const launchBtn = Array.from(h.container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Launch first profile"),
    )!;
    await act(async () => {
      launchBtn.click();
    });
    expect<string | null>(launchedId).toBe("prof_1");

    // Collapse checklist -> switches to collapsed banner and persists "collapsed"
    const collapseBtn = h.container.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')!;
    const steps = h.container.querySelector(".onboarding-steps");
    expect(collapseBtn.getAttribute("aria-controls")).toBe(steps?.id ?? null);
    await act(async () => {
      collapseBtn.click();
    });
    await h.flush();

    expect(h.container.querySelector("[data-onboarding-checklist='collapsed']")).not.toBeNull();
    expect(steps?.hasAttribute("hidden")).toBe(true);
    expect(savedPrefs.at(-1)).toEqual({ key: ONBOARDING_STATE_KEY, value: "collapsed" });

    // Dismiss checklist -> disappears and persists "dismissed"
    const dismissBtn = h.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    await act(async () => {
      dismissBtn.click();
    });
    await h.flush();

    expect(h.container.querySelector("[data-onboarding-checklist]")).toBeNull();
    expect(savedPrefs.at(-1)).toEqual({ key: ONBOARDING_STATE_KEY, value: "dismissed" });
  });

  test("controlled state mode emits state transitions to parent handler", async () => {
    const transitions: OnboardingChecklistState[] = [];
    const fakeFetch = (async () => Response.json({ language: "en-US" })) as unknown as typeof fetch;
    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <OnboardingChecklist
            profiles={[]}
            state="open"
            onLaunchFirstProfile={() => {}}
            onStateChange={(next) => {
              transitions.push(next);
            }}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    const launchStep = h.container.querySelector('[data-onboarding-step="launch_profile"]');
    expect(launchStep?.textContent).toContain("Create or import an environment first.");
    expect(launchStep?.querySelector("button")).toBeNull();
    const collapseBtn = h.container.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')!;
    await act(async () => {
      collapseBtn.click();
    });
    expect(transitions).toEqual(["collapsed"]);
  });
});
