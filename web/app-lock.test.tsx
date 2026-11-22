import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import {
  isAppLockedResponse,
  type AppLockStatus,
} from "./app-lock-api.ts";
import { AppLockScreen } from "./app-lock-screen.tsx";
import { AppLockSettings } from "./app-lock-settings.tsx";

function makeStatus(overrides: Partial<AppLockStatus> = {}): AppLockStatus {
  return {
    configured: false,
    enabled: false,
    locked: false,
    lockOnStartup: true,
    idleTimeoutMinutes: 15,
    failedAttempts: 0,
    cooldownUntil: 0,
    retryAfterMs: 0,
    lastActivityAt: Date.now(),
    updatedAt: null,
    corrupt: false,
    ...overrides,
  };
}

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
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("HTMLSelectElement", dom.HTMLSelectElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("KeyboardEvent", dom.KeyboardEvent);
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

function setInputValue(input: HTMLInputElement, value: string, dom: Window): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("AppLock UI", () => {
  test("isAppLockedResponse recognizes HTTP 423 app_locked payloads", () => {
    expect(isAppLockedResponse(423, { ok: false, code: "app_locked" })).toBe(true);
    expect(isAppLockedResponse(423, { ok: false, code: "workspace_busy" })).toBe(false);
    expect(isAppLockedResponse(401, { ok: false, code: "app_locked" })).toBe(false);
  });

  test("AppLockScreen unlocks with valid password, shows cooldown on 429, and discloses DPAPI/recovery boundary", async () => {
    let attempts = 0;
    const unlockedCalls: AppLockStatus[] = [];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/ui/api/shell-language") return Response.json({ language: "en-US" });
      if (url.pathname === "/ui/api/app-lock/unlock") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        attempts++;
        if (body.password === "wrong-trigger-cooldown") {
          return Response.json(
            {
              ok: false,
              code: "app_lock_cooldown",
              error: "Too many failed attempts.",
              failedAttempts: 5,
              cooldownUntil: Date.now() + 30_000,
              retryAfterMs: 30_000,
            },
            { status: 429 },
          );
        }
        if (body.password === "correct-pass") {
          return Response.json({
            ok: true,
            status: makeStatus({ configured: true, enabled: true, locked: false }),
          });
        }
        return Response.json(
          { ok: false, code: "wrong_password", error: "Incorrect master password.", failedAttempts: attempts },
          { status: 401 },
        );
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <AppLockScreen
            status={makeStatus({ configured: true, enabled: true, locked: true })}
            onUnlocked={(next) => unlockedCalls.push(next)}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.querySelector("[data-app-lock-screen='true']")).not.toBeNull();
    expect(h.container.textContent).toContain("Running browser windows stay open");

    // Expand forgot-password recovery guidance -> mentions DPAPI and app-lock.json
    const recoveryBtn = h.container.querySelector<HTMLButtonElement>(".app-lock-recovery-toggle")!;
    await act(async () => {
      recoveryBtn.click();
    });
    await h.flush();
    expect(h.container.textContent).toContain("DPAPI");
    expect(h.container.textContent).toContain("app-lock.json");

    // Submit wrong password -> shows error
    const input = h.container.querySelector<HTMLInputElement>("input[type='password']")!;
    const form = h.container.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      setInputValue(input, "bad-pass", h.dom);
    });
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await h.flush();
    expect(h.container.textContent).toContain("Incorrect master password");

    // Submit correct password -> invokes onUnlocked
    await act(async () => {
      setInputValue(input, "correct-pass", h.dom);
    });
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await h.flush();
    expect(unlockedCalls).toHaveLength(1);
    expect(unlockedCalls[0]?.locked).toBe(false);

    // Trigger 429 cooldown state -> renders cooldown banner and disables submit
    await act(async () => {
      setInputValue(input, "wrong-trigger-cooldown", h.dom);
    });
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await h.flush();
    expect(h.container.querySelector("[data-app-lock-cooldown='true']")).not.toBeNull();
  });

  test("AppLockSettings sets up master password and supports locking immediately", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/ui/api/shell-language") return Response.json({ language: "en-US" });
      if (url.pathname === "/ui/api/app-lock/status") {
        return Response.json({ ok: true, status: makeStatus() });
      }
      if (url.pathname === "/ui/api/app-lock/setup") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path: url.pathname, body });
        return Response.json({
          ok: true,
          status: makeStatus({
            configured: true,
            enabled: true,
            locked: false,
            idleTimeoutMinutes: body.idleTimeoutMinutes,
            lockOnStartup: body.lockOnStartup,
          }),
        });
      }
      if (url.pathname === "/ui/api/app-lock/lock") {
        requests.push({ path: url.pathname });
        return Response.json({
          ok: true,
          status: makeStatus({ configured: true, enabled: true, locked: true }),
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    const changes: AppLockStatus[] = [];
    await act(async () => {
      h.root.render(
        <I18nProvider>
          <AppLockSettings onStatusChange={(next) => changes.push(next)} />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.textContent).toContain("Privacy lock & DPAPI boundary");
    const inputs = Array.from(h.container.querySelectorAll<HTMLInputElement>("input[type='password']"));
    expect(inputs).toHaveLength(2);
    await act(async () => {
      setInputValue(inputs[0]!, "MySecretPass123", h.dom);
      setInputValue(inputs[1]!, "MySecretPass123", h.dom);
    });
    const form = h.container.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await h.flush();

    expect(requests.some((r) => r.path === "/ui/api/app-lock/setup")).toBe(true);
    expect(changes.at(-1)?.enabled).toBe(true);
    expect(h.container.textContent).toContain("Lock now (Ctrl+Shift+L)");

    const lockBtn = Array.from(h.container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Lock now"),
    )!;
    await act(async () => {
      lockBtn.click();
    });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/app-lock/lock")).toBe(true);
    expect(changes.at(-1)?.locked).toBe(true);
  });
});
