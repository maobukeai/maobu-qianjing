import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { createWindowChromeController, DesktopStartupBar, isWindowChromeEnabled, useWindowChrome, WindowActionError, WindowControls, windowMouseAction, type WindowChrome, type WindowChromeNative, type WindowChromeStatus } from "./window-chrome.tsx";

const noop = () => {};
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function nativeFixture() {
  const calls: string[] = [];
  let maximized = false;
  let resize: Parameters<WindowChromeNative["onResized"]>[0] | undefined;
  let focus: Parameters<WindowChromeNative["onFocusChanged"]>[0] | undefined;
  const native: WindowChromeNative = {
    isMaximized: async () => { calls.push("isMaximized"); return maximized; },
    isFocused: async () => { calls.push("isFocused"); return false; },
    onResized: async handler => { resize = handler; return () => { calls.push("unlistenResize"); }; },
    onFocusChanged: async handler => { focus = handler; return () => { calls.push("unlistenFocus"); }; },
    startDragging: async () => { calls.push("startDragging"); },
    minimize: async () => { calls.push("minimize"); },
    toggleMaximize: async () => { calls.push("toggleMaximize"); maximized = !maximized; },
    close: async () => { calls.push("close"); },
  };
  return { native, calls, setMaximized(value: boolean) { maximized = value; }, resize() { resize?.({ event: "tauri://resize", id: 1, payload: { width: 1280, height: 800 } } as Parameters<NonNullable<typeof resize>>[0]); }, focus(value: boolean) { focus?.({ event: "tauri://focus", id: 2, payload: value }); } };
}
function chromeState(overrides: Partial<WindowChrome> = {}): WindowChrome {
  return { enabled: true, maximized: false, focused: true, busy: false, error: null, onMouseDown: noop, minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, dismissError: noop, ...overrides };
}

test("window chrome requires both the exact native frameless marker and a callable Tauri bridge", () => {
  const invoke = async () => {};
  expect(isWindowChromeEnabled({ __MAOBU_FRAMELESS__: true, __TAURI_INTERNALS__: { invoke } })).toBe(true);
  for (const candidate of [undefined, null, {}, { __MAOBU_FRAMELESS__: true }, { __TAURI_INTERNALS__: { invoke } }, { __MAOBU_FRAMELESS__: "true", __TAURI_INTERNALS__: { invoke } }, { __MAOBU_FRAMELESS__: true, __TAURI_INTERNALS__: { invoke: true } }]) expect(isWindowChromeEnabled(candidate)).toBe(false);
});

test("the SDK adapter reads real state, follows resize and focus events, and uses close rather than destruction", async () => {
  const fixture = nativeFixture(), states: WindowChromeStatus[] = [];
  const controller = createWindowChromeController(fixture.native, state => states.push(state));
  controller.start();
  await settle();
  expect(states.at(-1)?.focused).toBe(false);
  expect(states.at(-1)?.maximized).toBe(false);
  fixture.focus(true);
  expect(states.at(-1)?.focused).toBe(true);
  fixture.setMaximized(true); fixture.resize(); await settle();
  expect(states.at(-1)?.maximized).toBe(true);
  await controller.toggleMaximize();
  expect(states.at(-1)?.maximized).toBe(false);
  await controller.startDragging(); await controller.minimize(); await controller.close();
  expect(fixture.calls.filter(call => ["toggleMaximize", "startDragging", "minimize", "close"].includes(call))).toEqual(["toggleMaximize", "startDragging", "minimize", "close"]);
  expect(states.at(-1)?.busy).toBe(false);
  controller.dispose(); controller.dispose();
  expect(fixture.calls.filter(call => call.startsWith("unlisten"))).toEqual(["unlistenResize", "unlistenFocus"]);
});

test("disposal owns late subscriptions and ignores late state without unhandled async cleanup failures", async () => {
  const fixture = nativeFixture(), states: WindowChromeStatus[] = [], resizeListener = deferred<() => void>(), focusListener = deferred<() => void>(), initial = deferred<boolean>();
  let resizeCleaned = 0, focusCleaned = 0;
  fixture.native.onResized = () => resizeListener.promise;
  fixture.native.onFocusChanged = () => focusListener.promise;
  fixture.native.isMaximized = () => initial.promise;
  const controller = createWindowChromeController(fixture.native, state => states.push(state));
  controller.start(); controller.dispose();
  const count = states.length;
  resizeListener.resolve(() => { resizeCleaned++; });
  focusListener.resolve(async () => { focusCleaned++; throw new Error("native window already closed"); });
  initial.resolve(true);
  await settle();
  expect(resizeCleaned).toBe(1); expect(focusCleaned).toBe(1);
  expect(states).toHaveLength(count);
  await controller.close();
  expect(fixture.calls).not.toContain("close");
});

test("failed window actions expose a retryable error and overlapping actions are ignored", async () => {
  const fixture = nativeFixture(), states: WindowChromeStatus[] = [], pending = deferred<void>();
  let attempts = 0;
  fixture.native.minimize = async () => { attempts++; if (attempts === 1) throw new Error("permission denied"); };
  const controller = createWindowChromeController(fixture.native, state => states.push(state));
  await controller.minimize();
  expect(states.at(-1)?.error).toBe("Window action could not be completed. Please try again.");
  expect(states.at(-1)?.busy).toBe(false);
  controller.dismissError(); expect(states.at(-1)?.error).toBeNull();
  await controller.minimize(); expect(attempts).toBe(2); expect(states.at(-1)?.error).toBeNull();
  fixture.native.close = () => pending.promise;
  const closing = controller.close();
  expect(states.at(-1)?.busy).toBe(true);
  await controller.toggleMaximize();
  expect(fixture.calls).not.toContain("toggleMaximize");
  pending.resolve(); await closing;
  expect(states.at(-1)?.busy).toBe(false);
  controller.dispose();
});

test("dragging is limited to unhandled left-click blank space, including nested interaction boundaries", () => {
  const blank = { closest: () => null } as unknown as EventTarget;
  const event = { button: 0, detail: 1, defaultPrevented: false, target: blank };
  expect(windowMouseAction(event)).toBe("drag");
  expect(windowMouseAction({ ...event, detail: 2 })).toBe("maximize");
  expect(windowMouseAction({ ...event, detail: 3 })).toBeNull();
  expect(windowMouseAction({ ...event, button: 1 })).toBeNull();
  expect(windowMouseAction({ ...event, defaultPrevented: true })).toBeNull();
  expect(windowMouseAction({ ...event, target: null })).toBeNull();
  // These targets stand in for an icon's nearest ancestor; no browser DOM is required.
  for (const boundary of ["button", "a", "input", "select", "textarea", "summary", '[role="button"]', '[role="tab"]', "[contenteditable]", "[data-no-drag]"]) {
    const target = { closest: (selector: string) => selector.split(",").some(part => part.trim().startsWith(boundary)) ? {} : null } as unknown as EventTarget;
    expect(windowMouseAction({ ...event, target })).toBeNull();
    expect(windowMouseAction({ ...event, target, detail: 2 })).toBeNull();
  }
  const textNode = { parentElement: { closest: () => ({}) } } as unknown as EventTarget;
  expect(windowMouseAction({ ...event, target: textNode })).toBeNull();
});

test("ordinary SSR browsers render no pretend titlebar or window controls", () => {
  function Browser() { const chrome = useWindowChrome(); return <><DesktopStartupBar chrome={chrome}>Brand</DesktopStartupBar><WindowControls chrome={chrome} /><WindowActionError chrome={chrome} /></>; }
  expect(renderToStaticMarkup(<I18nProvider><Browser /></I18nProvider>)).toBe("");
  expect(renderToStaticMarkup(<I18nProvider><WindowControls chrome={chromeState({ enabled: false })} /></I18nProvider>)).toBe("");
});

test("window controls announce maximize versus restore and native errors remain dismissible", () => {
  const normal = renderToStaticMarkup(<I18nProvider><WindowControls chrome={chromeState()} /></I18nProvider>);
  const maximized = renderToStaticMarkup(<I18nProvider><WindowControls chrome={chromeState({ maximized: true, busy: true })} /></I18nProvider>);
  expect(normal).toContain('aria-label="Window controls"');
  expect(normal.match(/<button\b/g)).toHaveLength(3);
  expect(normal).toContain('aria-label="Minimize window"');
  expect(normal).toContain('aria-label="Maximize window"');
  expect(normal).toContain('aria-label="Close window"');
  expect(maximized).toContain('aria-label="Restore window"');
  expect(maximized).not.toContain('aria-label="Maximize window"');
  expect(maximized.match(/disabled=""/g)).toHaveLength(3);
  const error = renderToStaticMarkup(<I18nProvider><WindowActionError chrome={chromeState({ error: "private native error" })} /></I18nProvider>);
  expect(error).toContain('role="alert"');
  expect(error).toContain("Window action could not be completed. Please try again.");
  expect(error).toContain('aria-label="Dismiss error"');
  expect(error).not.toContain("private native error");
});
