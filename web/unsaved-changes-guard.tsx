import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import "./unsaved-changes-guard.css";

export interface UnsavedChangesGuardOptions {
  /** A fixed UI label, such as "New profile". Never pass a form value here. */
  label: string;
  /** Used only when the element that requested closing is no longer available. */
  returnFocus?: () => HTMLElement | null;
}
export interface UnsavedCloseRequest {
  dirty: boolean;
  /** Synchronous editor cleanup; this guard never saves or receives form data. */
  onDiscard: () => void;
}
export type UnsavedCloseResult = "closed" | "confirmation" | "ignored" | "failed";
type Phase = "idle" | "pending" | "acting" | "failed";
interface CloseIntent {
  label: string;
  action: (() => void) | null;
  origin: HTMLElement | null;
  fallback?: () => HTMLElement | null;
  generation: number;
}
const CLOSE_ERROR = "The editor could not be closed. Continue editing and try again.";

function restoreEditorFocus(intent: CloseIntent) {
  const usable = (node: HTMLElement | null | undefined): node is HTMLElement => !!node?.isConnected
    && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement
    && !node.closest('[hidden], [inert], [aria-hidden="true"]') && !node.matches(":disabled");
  let target = intent.origin;
  if (!usable(target)) {
    try { target = intent.fallback?.() ?? null; } catch { target = null; }
  }
  if (usable(target)) target.focus({ preventScroll: true });
}

/** Call requestClose from a user event; call reset before replacing an editor session. */
export function useUnsavedChangesGuard(options: UnsavedChangesGuardOptions) {
  const optionsRef = useRef(options); optionsRef.current = options;
  const mounted = useRef(true), generation = useRef(0), phase = useRef<Phase>("idle");
  const intent = useRef<CloseIntent | null>(null), synchronousAction = useRef(false), escaped = useRef(false);
  const [view, setView] = useState({ open: false, label: options.label, failed: false });

  useLayoutEffect(() => {
    mounted.current = true;
    // Holding Escape after choosing to keep editing must not send repeat keys
    // through to the underlying editor's own close handler.
    const repeatEscape = (event: KeyboardEvent) => {
      if (escaped.current && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const releaseEscape = (event: KeyboardEvent) => { if (event.key === "Escape") escaped.current = false; };
    const blur = () => { escaped.current = false; };
    window.addEventListener("keydown", repeatEscape, true); window.addEventListener("keyup", releaseEscape, true); window.addEventListener("blur", blur);
    return () => {
      mounted.current = false; generation.current++; intent.current = null; phase.current = "idle";
      window.removeEventListener("keydown", repeatEscape, true); window.removeEventListener("keyup", releaseEscape, true); window.removeEventListener("blur", blur);
    };
  }, []);

  const execute = useCallback((frozen: CloseIntent): UnsavedCloseResult => {
    if (!mounted.current || frozen.generation !== generation.current || !frozen.action) return "ignored";
    const action = frozen.action;
    phase.current = "acting"; synchronousAction.current = true; intent.current = null;
    // Remove the confirmation's trap and make its visual exit inert before the
    // editor callback can close a surface or move focus elsewhere.
    flushSync(() => setView(previous => ({ ...previous, open: false, failed: false })));
    if (!mounted.current || frozen.generation !== generation.current) return "ignored";
    try {
      action();
      if (mounted.current && frozen.generation === generation.current) phase.current = "idle";
      return "closed";
    } catch {
      if (mounted.current && frozen.generation === generation.current) {
        intent.current = { ...frozen, action: null }; phase.current = "failed";
        setView({ open: true, label: frozen.label, failed: true });
      }
      return "failed";
    } finally {
      // Block two calls in the same synchronous event, while allowing a future
      // clean close without requiring a reset after every successful request.
      queueMicrotask(() => { if (mounted.current && frozen.generation === generation.current) synchronousAction.current = false; });
    }
  }, []);

  const requestClose = useCallback(({ dirty, onDiscard }: UnsavedCloseRequest): UnsavedCloseResult => {
    if (!mounted.current || phase.current !== "idle" || synchronousAction.current) return "ignored";
    const current = optionsRef.current;
    const active = typeof document === "undefined" ? null : document.activeElement;
    const frozen: CloseIntent = { label: current.label, action: onDiscard, origin: active instanceof HTMLElement ? active : null, fallback: current.returnFocus, generation: generation.current };
    if (!dirty) return execute(frozen);
    intent.current = frozen; phase.current = "pending";
    setView({ open: true, label: frozen.label, failed: false });
    return "confirmation";
  }, [execute]);

  const keepEditing = useCallback((fromEscape = false) => {
    const frozen = intent.current;
    if (!mounted.current || !frozen || phase.current !== "pending" && phase.current !== "failed") return;
    if (fromEscape) escaped.current = true;
    intent.current = null; phase.current = "idle";
    flushSync(() => setView(previous => ({ ...previous, open: false, failed: false })));
    if (mounted.current && frozen.generation === generation.current) restoreEditorFocus(frozen);
  }, []);
  const discard = useCallback(() => {
    const frozen = intent.current;
    if (phase.current === "pending" && frozen) execute(frozen);
  }, [execute]);
  const reset = useCallback(() => {
    generation.current++; intent.current = null; phase.current = "idle"; synchronousAction.current = false; escaped.current = false;
    if (mounted.current) setView(previous => ({ ...previous, open: false, failed: false }));
  }, []);

  return {
    requestClose, reset, pending: view.open,
    dialog: <UnsavedChangesDialog open={view.open} label={view.label} failed={view.failed} onKeepEditing={keepEditing} onDiscard={discard} />,
  };
}

function UnsavedChangesDialog({ open, label, failed, onKeepEditing, onDiscard }: {
  open: boolean; label: string; failed: boolean; onKeepEditing: (fromEscape?: boolean) => void; onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const id = useId(), panel = useRef<HTMLDivElement>(null), keep = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const node = panel.current, document = node.ownerDocument;
    keep.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault(); onKeepEditing(true); return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault(); event.stopImmediatePropagation();
      const controls = [...node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = controls.indexOf(document.activeElement as HTMLButtonElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus({ preventScroll: true });
    };
    const focus = (event: FocusEvent) => { if (!node.contains(event.target as Node)) keep.current?.focus({ preventScroll: true }); };
    window.addEventListener("keydown", key, true); document.addEventListener("focusin", focus);
    return () => { window.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus); };
  }, [open, failed, onKeepEditing]);
  if (typeof document === "undefined") return null;
  return createPortal(<MotionPresence present={open}>{() => <div className="unsaved-changes-guard-backdrop" onPointerDown={event => event.stopPropagation()}>
    <div className="unsaved-changes-guard" ref={panel} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description${failed ? ` ${id}-error` : ""}`}>
      <span className="unsaved-changes-guard-context">{t(label)}</span>
      <h2 id={`${id}-title`}>{t("Discard unsaved changes?")}</h2>
      <p id={`${id}-description`}>{t("Your changes have not been saved. You can keep editing or discard them.")}</p>
      {failed && <p className="unsaved-changes-guard-error" id={`${id}-error`} role="alert">{t(CLOSE_ERROR)}</p>}
      <div className="unsaved-changes-guard-actions"><button type="button" className="btn primary" ref={keep} onClick={() => onKeepEditing()}>{t("Keep editing")}</button>
        {!failed && <button type="button" className="btn unsaved-changes-guard-discard" onClick={onDiscard}>{t("Discard changes")}</button>}</div>
    </div>
  </div>}</MotionPresence>, document.body);
}
