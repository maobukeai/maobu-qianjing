import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import {
  isAppLockedResponse,
  useAppLockController,
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

  test("late polls and activity responses preserve confirmed lock and unlock transitions", async () => {
    const unlocked = makeStatus({ configured: true, enabled: true });
    const locked = { ...unlocked, locked: true };
    const payload = (status: AppLockStatus) => Response.json({ ok: true, status });
    const pendingReads: Array<(response: Response) => void> = [];
    const pendingActivity: Array<(response: Response) => void> = [];
    let statusRequests = 0, lockRequests = 0;
    const h = await createHarness((async (input: RequestInfo | URL) => {
      switch (String(input)) {
        case "/ui/api/app-lock/status":
          if (statusRequests++ === 0) return payload(unlocked);
          return new Promise<Response>(resolve => pendingReads.push(resolve));
        case "/ui/api/app-lock/activity":
          return new Promise<Response>(resolve => pendingActivity.push(resolve));
        case "/ui/api/app-lock/lock":
          lockRequests++;
          return payload(locked);
        default:
          throw new Error("Unexpected application lock request");
      }
    }) as typeof fetch);
    dispose = h.cleanup;
    let controller!: ReturnType<typeof useAppLockController>;
    function LockState() {
      controller = useAppLockController({ idlePollMs: 60_000 });
      return <output>{controller.status?.locked ? "locked" : "unlocked"}</output>;
    }
    await act(async () => { h.root.render(<LockState />); });
    expect(controller.status?.locked).toBe(false);
    await act(async () => {
      void controller.refresh();
      h.dom.dispatchEvent(new h.dom.Event("pointerdown"));
    });
    expect(pendingReads).toHaveLength(1);
    expect(pendingActivity).toHaveLength(1);

    await act(async () => { await Promise.all([controller.lockNow(), controller.lockNow()]); });
    expect(lockRequests).toBe(1);
    expect(h.container.textContent).toBe("locked");
    await act(async () => { pendingActivity[0]!(payload(unlocked)); });
    expect(h.container.textContent).toBe("locked");
    await act(async () => { pendingReads[0]!(payload(unlocked)); });
    expect(h.container.textContent).toBe("locked");

    await act(async () => { void controller.refresh(); });
    await act(async () => {
      controller.setStatus(unlocked);
      void controller.refresh();
    });
    expect(pendingReads).toHaveLength(3);
    await act(async () => { pendingReads[1]!(payload(locked)); });
    expect(h.container.textContent).toBe("unlocked");
    expect(controller.loading).toBe(true);
    await act(async () => { pendingReads[2]!(payload(unlocked)); });
    expect(controller.loading).toBe(false);
  });

  test("an activity reply cannot overwrite a lock observed by the status read", async () => {
    const unlocked = makeStatus({ configured: true, enabled: true });
    let replyToActivity!: (response: Response) => void;
    let reads = 0;
    const h = await createHarness((async (input: RequestInfo | URL) => {
      if (String(input) === "/ui/api/app-lock/status") {
        return Response.json({ ok: true, status: { ...unlocked, locked: reads++ > 0 } });
      }
      expect(String(input)).toBe("/ui/api/app-lock/activity");
      return new Promise<Response>(resolve => { replyToActivity = resolve; });
    }) as typeof fetch);
    dispose = h.cleanup;
    let controller!: ReturnType<typeof useAppLockController>;
    function LockState() {
      controller = useAppLockController({ idlePollMs: 60_000 });
      return <output>{controller.status?.locked ? "locked" : "unlocked"}</output>;
    }
    await act(async () => { h.root.render(<LockState />); });
    await act(async () => { h.dom.dispatchEvent(new h.dom.Event("pointerdown")); });
    expect(replyToActivity).toBeDefined();
    await act(async () => { await controller.refresh(); });
    expect(h.container.textContent).toBe("locked");
    await act(async () => { replyToActivity(Response.json({ ok: true, status: unlocked })); });
    expect(h.container.textContent).toBe("locked");
  });

  test("a late settings receipt preserves a confirmed lock and starts a fresh status check", async () => {
    const unlocked = makeStatus({ configured: true, enabled: true });
    const locked = { ...unlocked, locked: true };
    const payload = (status: AppLockStatus) => Response.json({ ok: true, status });
    const pendingReads: Array<(response: Response) => void> = [];
    let replyToSettings!: (response: Response) => void;
    let reads = 0;
    const h = await createHarness((async (input: RequestInfo | URL) => {
      switch (String(input)) {
        case "/ui/api/shell-language":
          return Response.json({ ok: true, language: "en-US" });
        case "/ui/api/app-lock/status":
          if (reads++ === 0) return payload(unlocked);
          return new Promise<Response>(resolve => pendingReads.push(resolve));
        case "/ui/api/app-lock/configure":
          return new Promise<Response>(resolve => { replyToSettings = resolve; });
        case "/ui/api/app-lock/lock":
          return payload(locked);
        case "/ui/api/app-lock/activity":
          return payload(unlocked);
        default:
          throw new Error("Unexpected application lock request");
      }
    }) as typeof fetch);
    dispose = h.cleanup;
    let controller!: ReturnType<typeof useAppLockController>;
    function ConnectedSettings() {
      controller = useAppLockController({ idlePollMs: 60_000 });
      return <I18nProvider><AppLockSettings
        status={controller.status}
        onStatusChange={controller.setStatus}
        beginStatusChange={controller.beginSettingsStatusChange}
      /></I18nProvider>;
    }
    await act(async () => { h.root.render(<ConnectedSettings />); });
    const form = h.container.querySelector("form")!;
    const password = form.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    await act(async () => {
      setInputValue(password, "synthetic app lock password", h.dom);
    });
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(replyToSettings).toBeDefined();
    await act(async () => { await controller.lockNow(); });
    expect(controller.status?.locked).toBe(true);
    await act(async () => { void controller.refresh(); });

    await act(async () => { replyToSettings(payload({ ...unlocked, idleTimeoutMinutes: 5 })); });
    expect(controller.status?.locked).toBe(true);
    expect(controller.status?.idleTimeoutMinutes).toBe(15);
    expect(pendingReads).toHaveLength(2);
    await act(async () => { pendingReads[0]!(payload({ ...locked, idleTimeoutMinutes: 5 })); });
    expect(controller.loading).toBe(true);
    expect(controller.status?.idleTimeoutMinutes).toBe(15);
    await act(async () => { pendingReads[1]!(payload({ ...locked, idleTimeoutMinutes: 30 })); });
    expect(controller.loading).toBe(false);
    expect(controller.status?.locked).toBe(true);
    expect(controller.status?.idleTimeoutMinutes).toBe(30);
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

    const dialog = h.container.querySelector<HTMLElement>("[data-app-lock-screen='true']")!;
    const boundary = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(boundary?.textContent).toMatch(/browsers? keep running.*stay locked/i);
    const input = h.container.querySelector<HTMLInputElement>("input[type='password']")!;
    expect(document.activeElement).toBe(input);
    expect(input.labels?.[0]?.textContent).toBe("Master password");
    const visibility = h.container.querySelector<HTMLButtonElement>(".app-lock-visibility")!;
    expect(visibility.getAttribute("aria-controls")).toBe(input.id);
    await act(async () => visibility.click());
    expect(input.type).toBe("text");
    await act(async () => visibility.click());
    expect(input.type).toBe("password");

    // Expand forgot-password recovery guidance -> mentions DPAPI and app-lock.json
    const recoveryBtn = h.container.querySelector<HTMLButtonElement>(".app-lock-recovery-toggle")!;
    expect(recoveryBtn.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      recoveryBtn.click();
      recoveryBtn.focus();
    });
    await h.flush();
    expect(recoveryBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(recoveryBtn.getAttribute("aria-controls")!)).not.toBeNull();
    expect(h.container.textContent).toContain("DPAPI");
    expect(h.container.textContent).toContain("app-lock.json");
    recoveryBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(recoveryBtn);

    // Submit wrong password -> shows error
    const form = h.container.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      setInputValue(input, "bad-pass", h.dom);
    });
    await act(async () => {
      form.dispatchEvent(new h.dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await h.flush();
    expect(h.container.textContent).toContain("Incorrect master password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.getAttribute("role")).toBe("alert");

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

    const disclosure = h.container.querySelector<HTMLDetailsElement>("details")!;
    expect(disclosure.querySelector("summary")?.textContent).toBe("Recovery and storage");
    expect(disclosure.open).toBe(false);
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
    const lockBtn = Array.from(h.container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Lock now"),
    )!;
    expect(lockBtn.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+L");
    await act(async () => {
      lockBtn.click();
    });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/app-lock/lock")).toBe(true);
    expect(changes.at(-1)?.locked).toBe(true);
  });

  test("AppLockSettings offers a retry and keeps setup hidden until it knows the lock status", async () => {
    const reads: Array<(response: Response) => void> = [];
    const h = await createHarness((async (input: RequestInfo | URL) => {
      if (String(input) === "/ui/api/shell-language") return Response.json({ language: "en-US" });
      expect(String(input)).toBe("/ui/api/app-lock/status");
      return await new Promise<Response>(resolve => reads.push(resolve));
    }) as typeof fetch);
    dispose = h.cleanup;

    await act(async () => {
      h.root.render(<I18nProvider><AppLockSettings /></I18nProvider>);
    });
    expect(reads).toHaveLength(1);
    expect(!!h.container.querySelector("form")).toBe(false);
    await act(async () => { reads[0]!(Response.json({ ok: false }, { status: 503 })); });
    expect(h.container.querySelector(".chip")?.textContent).toBe("Unavailable");
    expect(!!h.container.querySelector("form")).toBe(false);

    const retry = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); retry!.click(); });
    expect(reads).toHaveLength(2);
    expect(retry!.disabled).toBe(true);
    await act(async () => { reads[1]!(Response.json({ ok: true, status: makeStatus() })); });
    expect(h.container.querySelector(".chip")?.textContent).toBe("Disabled");
    expect(h.container.querySelector("form button")?.textContent).toContain("Enable app lock");
  });

  test("AppLockSettings keeps idle and startup drafts across status heartbeats", async () => {
    const h = await createHarness((async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/ui/api/shell-language");
      return Response.json({ language: "en-US" });
    }) as typeof fetch);
    dispose = h.cleanup;
    const saved = makeStatus({ enabled: true, configured: true, lastActivityAt: 1 });
    const render = (status: AppLockStatus | null) => act(async () => {
      h.root.render(<I18nProvider><AppLockSettings status={status} /></I18nProvider>);
    });
    await render(null);
    expect(!!h.container.querySelector("form")).toBe(false);
    await render(saved);
    const idle = h.container.querySelector<HTMLSelectElement>("select")!;
    const startup = h.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(idle.value).toBe("15");
    expect(startup.checked).toBe(true);
    await act(async () => {
      idle.value = "30";
      idle.dispatchEvent(new h.dom.Event("change", { bubbles: true }) as unknown as Event);
      startup.click();
    });
    await render({ ...saved, lastActivityAt: 2 });
    expect(idle.value).toBe("30");
    expect(startup.checked).toBe(false);
  });
});
