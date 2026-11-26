import { createContext, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { isolateModalSiblings } from "./modal-isolation.ts";
import { AppIcon } from "./ui-primitives.tsx";
import { createDesktopCloseBridge, createDesktopCloseRegistry, DESKTOP_DRAFT_LABELS, EMPTY_DESKTOP_CLOSE_VIEW, EMPTY_DESKTOP_DRAFT_SNAPSHOT, type DesktopCloseNative, type DesktopCloseRegistry, type DesktopCloseView, type DesktopDraftFlags, type DesktopDraftLabel } from "./desktop-close-state.ts";
import "./desktop-close.css";

export { createDesktopCloseRegistry } from "./desktop-close-state.ts";
export type { DesktopCloseRegistry, DesktopDraftLabel } from "./desktop-close-state.ts";
const RegistryContext = createContext<DesktopCloseRegistry | null>(null);
const getEmptyDraftSnapshot = () => EMPTY_DESKTOP_DRAFT_SNAPSHOT;
const subscribeToEmptyDraftSnapshot = () => () => {};
export function useDesktopCloseRegistry() { return useState(createDesktopCloseRegistry)[0]; }
export function DesktopCloseRegistryProvider({ registry, children }: { registry: DesktopCloseRegistry; children: ReactNode }) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}
export function useDesktopCloseDraftSnapshot() {
  const registry = useContext(RegistryContext);
  return useSyncExternalStore(registry?.subscribe ?? subscribeToEmptyDraftSnapshot, registry?.getSnapshot ?? getEmptyDraftSnapshot, getEmptyDraftSnapshot);
}
export function useDesktopCloseDraftReader() {
  return useContext(RegistryContext)?.getSnapshot ?? getEmptyDraftSnapshot;
}
/** Optional outside the desktop host, so standalone feature pages remain usable. */
export function useDesktopCloseDraft(label: DesktopDraftLabel, flags: DesktopDraftFlags, explicitRegistry?: DesktopCloseRegistry) {
  const context = useContext(RegistryContext), registry = explicitRegistry ?? context;
  const lease = useRef<ReturnType<DesktopCloseRegistry["register"]> | null>(null);
  const latest = useRef(flags); latest.current = flags;
  useLayoutEffect(() => {
    if (!registry) return;
    const owned = registry.register(label, latest.current); lease.current = owned;
    return () => { if (lease.current === owned) lease.current = null; owned.dispose(); };
  }, [registry, label]);
  useLayoutEffect(() => { lease.current?.update(flags); }, [registry, label, flags.dirty, flags.busy, flags.active]);
}

export function createNativeDesktopCloseAdapter(): DesktopCloseNative | null {
  if (typeof window === "undefined" || typeof (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke !== "function") return null;
  return {
    // Missing/corrupt native metadata is a rejected subscription, not a render
    // crash or a reason to silently disable draft protection.
    listenIntent: async callback => getCurrentWindow().listen("maobu-desktop-close-intent", event => callback(event.payload as Parameters<typeof callback>[0])),
    listenResolved: async callback => getCurrentWindow().listen("maobu-desktop-close-resolved", event => callback(event.payload as Parameters<typeof callback>[0])),
    register: () => invoke("desktop_close_register"),
    unregister: sessionId => invoke("desktop_close_unregister", { sessionId }),
    resolve: (intent, decision) => invoke("desktop_close_resolve", { ...intent, decision }),
  };
}

const CLOSE_ERROR = "Could not confirm closing. Your drafts are kept.";
const CONNECTION_ERROR = "Draft protection could not connect to the desktop. Closing the window will offer a native recovery warning.";
function usable(node: HTMLElement | null | undefined): node is HTMLElement {
  return !!node?.isConnected && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement
    && !node.closest('[inert], [hidden], [aria-hidden="true"]') && !node.matches(":disabled");
}

function focusClosePanel(panel: HTMLDivElement | null, preferred: HTMLButtonElement | null) {
  (usable(preferred) ? preferred : panel)?.focus({ preventScroll: true });
}

function scrollDraftList(body: HTMLDivElement | null, event: KeyboardEvent): boolean {
  if (!body || body.scrollHeight <= body.clientHeight || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  switch (event.key) {
    case "PageDown": body.scrollTop += body.clientHeight; break;
    case "PageUp": body.scrollTop -= body.clientHeight; break;
    case "Home": body.scrollTop = 0; break;
    case "End": body.scrollTop = body.scrollHeight - body.clientHeight; break;
    default: return false;
  }
  return true;
}

/** Mount once for the whole App lifetime, including its loading/error shell. */
export function DesktopCloseHost({ registry, native: suppliedNative, returnFocus, onPendingChange }: {
  registry: DesktopCloseRegistry;
  native?: DesktopCloseNative | null;
  returnFocus?: () => HTMLElement | null;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [native] = useState(() => suppliedNative === undefined ? createNativeDesktopCloseAdapter() : suppliedNative);
  const [view, setView] = useState<DesktopCloseView>(EMPTY_DESKTOP_CLOSE_VIEW);
  const viewRef = useRef(view); viewRef.current = view;
  const bridge = useRef<ReturnType<typeof createDesktopCloseBridge> | null>(null);
  const origin = useRef<HTMLElement | null>(null), restoreRequested = useRef(false), escaped = useRef(false);
  const fallback = useRef(returnFocus); fallback.current = returnFocus;
  const pendingCallback = useRef(onPendingChange); pendingCallback.current = onPendingChange;
  const layer = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), keep = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId(), open = view.phase !== "idle";

  // Install before later page-level modal traps. Only the current top-level
  // close surface handles these keys, including while an editor guard is open.
  useLayoutEffect(() => {
    if (!native) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escaped.current) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (viewRef.current.phase === "idle") return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault(); escaped.current = true;
        if (viewRef.current.phase !== "waiting" && !viewRef.current.sending) void bridge.current?.keepEditing();
      } else if (event.key === "Tab") {
        event.preventDefault(); event.stopImmediatePropagation();
        const controls = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (event.shiftKey ? controls.at(-1) : controls[0])
          : controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
        (next ?? panel.current)?.focus({ preventScroll: true });
      } else if (scrollDraftList(body.current, event)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    const release = (event: KeyboardEvent) => { if (event.key === "Escape") escaped.current = false; };
    const blur = () => { escaped.current = false; };
    const focus = (event: FocusEvent) => {
      if (viewRef.current.phase === "idle") return;
      event.stopImmediatePropagation();
      if (!panel.current?.contains(event.target as Node)) focusClosePanel(panel.current, keep.current);
    };
    window.addEventListener("keydown", key, true); window.addEventListener("keyup", release, true); window.addEventListener("blur", blur); window.addEventListener("focusin", focus, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", release, true); window.removeEventListener("blur", blur); window.removeEventListener("focusin", focus, true); };
  }, [native]);

  useLayoutEffect(() => {
    if (!native) return;
    let mounted = true;
    const owner = createDesktopCloseBridge(native, registry, next => { if (mounted) setView(next); }, {
      capture() { origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; restoreRequested.current = false; },
      restore() { restoreRequested.current = true; },
    });
    bridge.current = owner; owner.start();
    return () => { mounted = false; if (bridge.current === owner) bridge.current = null; owner.dispose(); };
  }, [native, registry]);

  useLayoutEffect(() => {
    pendingCallback.current?.(open);
    if (!open || !layer.current) {
      if (restoreRequested.current) {
        restoreRequested.current = false;
        let target = origin.current;
        if (!usable(target)) { try { target = fallback.current?.() ?? null; } catch { target = null; } }
        if (usable(target)) target.focus({ preventScroll: true });
      }
      return;
    }
    const release = isolateModalSiblings(layer.current);
    return () => {
      release();
      pendingCallback.current?.(false);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    focusClosePanel(panel.current, keep.current);
  }, [open, view.phase, view.revision]);
  if (!native || typeof document === "undefined") return null;
  const busy = !!view.busy.length, waiting = view.phase === "waiting", failed = view.phase === "error";
  const title = waiting ? "Waiting for the desktop to close" : failed ? "Close request needs attention" : busy ? "A change is still in progress"
    : view.dirty.length ? "Close with unsaved changes?" : "Close app?";
  const description = waiting ? null : view.sending ? "Working…" : failed ? CLOSE_ERROR : busy ? "Wait for the current change to finish." : null;
  const labels = [...new Set([...view.busy, ...view.dirty])];
  const pendingDecision = waiting || view.sending;
  return <>
    {view.connectionError && <div className="desktop-close-connection-error" role="alert">{t(CONNECTION_ERROR)}</div>}
    {createPortal(<div className="desktop-close-layer" ref={layer}><MotionPresence present={open}>{() => <div className="desktop-close-backdrop" onPointerDown={event => event.stopPropagation()}>
      <div className="desktop-close-dialog" ref={panel} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined} aria-busy={pendingDecision || undefined} tabIndex={-1}>
        <header className="desktop-close-heading">
          <span className={`desktop-close-icon${pendingDecision ? " is-pending" : ""}`}>
            <AppIcon name={pendingDecision ? "activity" : failed ? "alert" : "warning"} />
          </span>
          <div>
            <h2 id={`${id}-title`}>{t(title)}</h2>
            {description && <p id={`${id}-description`}>{t(description)}</p>}
          </div>
        </header>
        {!!labels.length && <div className="desktop-close-body" ref={body}>
          <ul className="desktop-close-labels" role="list" aria-label={busy ? undefined : t("Unsaved drafts")}>
            {labels.map(label => <li key={label}><AppIcon name="file" className="sm" />{t(DESKTOP_DRAFT_LABELS[label])}</li>)}
          </ul>
        </div>}
        {!waiting && <footer className="desktop-close-actions">
          <button className="btn primary" type="button" ref={keep} disabled={view.sending} onClick={() => void bridge.current?.keepEditing()}>{t("Keep editing")}</button>
          {!busy && !failed && <button className={`btn${view.dirty.length ? " desktop-close-discard" : ""}`} type="button" disabled={view.sending}
            onClick={() => void bridge.current?.discardAndClose()}>{t(view.dirty.length ? "Discard and close app" : "Close app")}</button>}
        </footer>}
      </div>
    </div>}</MotionPresence></div>, document.body)}
  </>;
}
