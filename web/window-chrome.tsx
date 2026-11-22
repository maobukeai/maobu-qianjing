import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "./i18n.tsx";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;
const ACTION_ERROR = "Window action could not be completed. Please try again.";
const NO_DRAG_SELECTOR = 'button, a, input, select, textarea, summary, [role="button"], [role="tab"], [contenteditable]:not([contenteditable="false"]), [data-no-drag]';

export type WindowBackdropKind = "mica-alt" | "mica" | "none";
export type WindowThemeChoice = "light" | "dark" | "system";
export type WindowChromeStatus = { maximized: boolean; focused: boolean; busy: boolean; error: string | null };
export type WindowChrome = WindowChromeStatus & {
  enabled: boolean;
  onMouseDown: MouseEventHandler<HTMLElement>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  dismissError: () => void;
};
export type WindowChromeNative = Pick<ReturnType<typeof getCurrentWindow>, "isMaximized" | "isFocused" | "onResized" | "onFocusChanged" | "startDragging" | "minimize" | "toggleMaximize" | "close">;

/** The marker is injected only into the Windows window with native decorations removed. */
export function isWindowChromeEnabled(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const host = candidate as { __MAOBU_FRAMELESS__?: unknown; __TAURI_INTERNALS__?: { invoke?: unknown } };
  return host.__MAOBU_FRAMELESS__ === true && typeof host.__TAURI_INTERNALS__?.invoke === "function";
}

/** Read the Rust-probed native backdrop kind (`window.__MAOBU_BACKDROP__`) with strict allowlist validation. */
export function readWindowBackdrop(candidate?: unknown): WindowBackdropKind {
  const host = candidate !== undefined ? candidate : (typeof window !== "undefined" ? window : undefined);
  if (!host || typeof host !== "object") return "none";
  const value = (host as { __MAOBU_BACKDROP__?: unknown }).__MAOBU_BACKDROP__;
  return value === "mica-alt" || value === "mica" || value === "none" ? value : "none";
}

/** True when the Tauri host explicitly injected `window.__MAOBU_BACKDROP__` and exposes `set_window_theme`. */
export function hasWindowBackdropHost(candidate?: unknown): boolean {
  const host = candidate !== undefined ? candidate : (typeof window !== "undefined" ? window : undefined);
  if (!host || typeof host !== "object") return false;
  const value = (host as { __MAOBU_BACKDROP__?: unknown }).__MAOBU_BACKDROP__;
  return value === "mica-alt" || value === "mica" || value === "none";
}

function isValidWindowTheme(theme: unknown): theme is WindowThemeChoice {
  return theme === "light" || theme === "dark" || theme === "system";
}

/**
 * Synchronize the application theme with Tauri's native window (DWM dark mode & backdrop tint).
 * Silently downgrades outside Tauri or when the host rejects `set_window_theme`.
 */
export async function syncWindowTheme(theme: WindowThemeChoice, candidate?: unknown): Promise<boolean> {
  if (!isValidWindowTheme(theme)) return false;
  const host = candidate !== undefined ? candidate : (typeof window !== "undefined" ? window : undefined);
  if (!host || typeof host !== "object") return false;
  const internals = (host as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return false;
  try {
    await (internals.invoke as (command: string, args: { theme: WindowThemeChoice }) => Promise<unknown>)(
      "set_window_theme",
      { theme },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind Win11 Mica backdrop availability (`window.__MAOBU_BACKDROP__`) to
 * `document.documentElement.dataset.windowBackdrop` and keep native DWM theme in sync.
 */
export function useWindowBackdrop(theme: WindowThemeChoice): WindowBackdropKind {
  const [backdrop] = useState<WindowBackdropKind>(() => readWindowBackdrop());

  useIsomorphicLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.windowBackdrop = backdrop;
    return () => {
      if (root.dataset.windowBackdrop === backdrop) {
        delete root.dataset.windowBackdrop;
      }
    };
  }, [backdrop]);

  useEffect(() => {
    if (!hasWindowBackdropHost()) return;
    void syncWindowTheme(theme);
    if (theme !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const handleChange = () => { void syncWindowTheme("system"); };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  return backdrop;
}

/** A nested icon inherits its interactive ancestor's no-drag boundary. */
export function windowMouseAction(event: { button: number; detail: number; defaultPrevented: boolean; target: EventTarget | null }): "drag" | "maximize" | null {
  if (event.defaultPrevented || event.button !== 0 || event.detail > 2) return null;
  const node = event.target as (EventTarget & { closest?: (selector: string) => Element | null; parentElement?: Element | null }) | null;
  const element = typeof node?.closest === "function" ? node : node?.parentElement;
  if (!element || element.closest?.(NO_DRAG_SELECTOR)) return null;
  return event.detail === 2 ? "maximize" : "drag";
}

/** A small SDK adapter keeps asynchronous listener ownership outside React effects. */
export function createWindowChromeController(native: WindowChromeNative, publish: (state: WindowChromeStatus) => void) {
  let state: WindowChromeStatus = { maximized: false, focused: true, busy: false, error: null };
  let disposed = false, started = false, maximizeRevision = 0, focusRevision = 0;
  const listeners = new Set<() => void>();
  const update = (change: Partial<WindowChromeStatus>) => {
    if (disposed) return;
    state = { ...state, ...change };
    publish(state);
  };
  const failed = () => update({ error: ACTION_ERROR });
  const remove = (unlisten: () => void) => {
    // SDK unlisten is typed void but may return the asynchronous IPC cleanup.
    try { void Promise.resolve(unlisten()).catch(() => {}); }
    catch { /* A disposed native window may already have removed its listeners. */ }
  };
  const listen = (subscribe: () => Promise<() => void>) => {
    try {
      void subscribe().then(unlisten => {
        if (disposed) remove(unlisten);
        else listeners.add(unlisten);
      }).catch(failed);
    } catch { failed(); }
  };
  const readMaximized = async () => {
    const revision = ++maximizeRevision;
    try {
      const maximized = await native.isMaximized();
      if (revision === maximizeRevision) update({ maximized });
    } catch { if (revision === maximizeRevision) failed(); }
  };
  const readFocused = async () => {
    const revision = ++focusRevision;
    try {
      const focused = await native.isFocused();
      if (revision === focusRevision) update({ focused });
    } catch { if (revision === focusRevision) failed(); }
  };
  const run = async (action: () => Promise<void>, refreshMaximized = false): Promise<void> => {
    if (disposed || state.busy) return;
    update({ busy: true, error: null });
    try {
      await action();
      if (refreshMaximized && !disposed) await readMaximized();
    } catch { failed(); }
    finally { update({ busy: false }); }
  };
  return {
    start() {
      if (started || disposed) return;
      started = true;
      // Subscribe before reading, so a focus event wins over an older initial read.
      listen(() => native.onResized(() => { if (!disposed) void readMaximized(); }));
      listen(() => native.onFocusChanged(event => { ++focusRevision; update({ focused: event.payload }); }));
      void readMaximized();
      void readFocused();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unlisten of listeners) remove(unlisten);
      listeners.clear();
    },
    startDragging: () => run(() => native.startDragging()),
    minimize: () => run(() => native.minimize()),
    toggleMaximize: () => run(() => native.toggleMaximize(), true),
    // close emits CloseRequested; destroy would bypass the app's existing close policy.
    close: () => run(() => native.close()),
    dismissError: () => update({ error: null }),
  };
}

type WindowChromeController = ReturnType<typeof createWindowChromeController>;
type WindowAction = "startDragging" | "minimize" | "toggleMaximize" | "close";

export function useWindowChrome(): WindowChrome {
  const [enabled] = useState(() => typeof window !== "undefined" && isWindowChromeEnabled(window));
  const [status, setStatus] = useState<WindowChromeStatus>({ maximized: false, focused: true, busy: false, error: null });
  const controller = useRef<WindowChromeController | null>(null);
  const mounted = useRef(false);
  const ensureController = useCallback(() => {
    if (!controller.current) {
      controller.current = createWindowChromeController(getCurrentWindow(), next => { if (mounted.current) setStatus(next); });
      controller.current.start();
    }
    return controller.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (enabled) {
      try { ensureController(); }
      catch { setStatus(old => ({ ...old, error: ACTION_ERROR })); }
    }
    return () => { mounted.current = false; controller.current?.dispose(); controller.current = null; };
  }, [enabled, ensureController]);
  const action = useCallback(async (name: WindowAction) => {
    if (!enabled || !mounted.current) return;
    try { await ensureController()[name](); }
    catch { if (mounted.current) setStatus(old => ({ ...old, busy: false, error: ACTION_ERROR })); }
  }, [enabled, ensureController]);
  const minimize = useCallback(() => action("minimize"), [action]);
  const toggleMaximize = useCallback(() => action("toggleMaximize"), [action]);
  const close = useCallback(() => action("close"), [action]);
  const dismissError = useCallback(() => { controller.current?.dismissError(); setStatus(old => ({ ...old, error: null })); }, []);
  const onMouseDown = useCallback<MouseEventHandler<HTMLElement>>(event => {
    if (!enabled) return;
    const intent = windowMouseAction(event);
    if (!intent) return;
    event.preventDefault();
    void action(intent === "maximize" ? "toggleMaximize" : "startDragging");
  }, [enabled, action]);
  return { enabled, ...status, onMouseDown, minimize, toggleMaximize, close, dismissError };
}

function WindowGlyph({ kind }: { kind: "minimize" | "maximize" | "restore" | "close" }) {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" focusable="false">
    {kind === "minimize" ? <path d="M1 6.5h10" /> : kind === "maximize" ? <rect x="1.5" y="1.5" width="9" height="9" /> : kind === "restore" ? <><path d="M3.5 1.5h7v7h-2" /><rect x="1.5" y="3.5" width="7" height="7" /></> : <path d="m1.5 1.5 9 9m-9 0 9-9" />}
  </svg>;
}

export function WindowControls({ chrome }: { chrome: WindowChrome }) {
  const { t } = useTranslation();
  if (!chrome.enabled) return null;
  const maximizeLabel = t(chrome.maximized ? "Restore window" : "Maximize window");
  return <div className="window-controls" role="group" aria-label={t("Window controls")} data-no-drag>
    <button type="button" className="window-control" aria-label={t("Minimize window")} title={t("Minimize window")} disabled={chrome.busy} onClick={() => void chrome.minimize()}><WindowGlyph kind="minimize" /></button>
    <button type="button" className="window-control" aria-label={maximizeLabel} title={maximizeLabel} disabled={chrome.busy} onClick={() => void chrome.toggleMaximize()}><WindowGlyph kind={chrome.maximized ? "restore" : "maximize"} /></button>
    <button type="button" className="window-control window-control-close" aria-label={t("Close window")} title={t("Close window")} disabled={chrome.busy} onClick={() => void chrome.close()}><WindowGlyph kind="close" /></button>
  </div>;
}

export function WindowActionError({ chrome }: { chrome: WindowChrome }) {
  const { t } = useTranslation();
  if (!chrome.enabled || !chrome.error) return null;
  return <div className="window-action-error" role="alert" data-no-drag><span>{t("Window action could not be completed. Please try again.")}</span><button type="button" className="window-action-error-dismiss" aria-label={t("Dismiss error")} title={t("Dismiss error")} onClick={chrome.dismissError}><WindowGlyph kind="close" /></button></div>;
}

export function DesktopStartupBar({ chrome, children }: { chrome: WindowChrome; children: ReactNode }) {
  if (!chrome.enabled) return null;
  return <header className="desktop-startup-titlebar" onMouseDown={chrome.onMouseDown}><div className="desktop-startup-brand">{children}</div><WindowControls chrome={chrome} /></header>;
}
