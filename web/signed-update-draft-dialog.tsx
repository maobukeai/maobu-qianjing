import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DESKTOP_DRAFT_LABELS, type DesktopDraftLabel } from "./desktop-close-state.ts";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { isolateModalSiblings } from "./modal-isolation.ts";
import type { SignedUpdateProgress } from "./signed-update-api.ts";
import { hasActiveWorkbenchModal } from "./workbench-shortcuts.ts";
import "./signed-update-draft-dialog.css";

const PROGRESS_PHASES = {
  downloading: "Downloading signed update…",
  verifying: "Verifying publisher signature…",
  closing: "Saving and closing browser sessions…",
  installing: "Installing update…",
  complete: "Update installed",
} as const;

export function SignedUpdateProgressView({ progress }: { progress: SignedUpdateProgress }) {
  const { t } = useTranslation();
  const phase = PROGRESS_PHASES[progress.phase];
  const percent = progress.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : null;
  return <div className="signed-update-progress" role="status" aria-live="polite">
    <span>{t(phase)}{percent !== null && progress.phase === "downloading" ? ` ${percent}%` : ""}</span>
    {progress.phase === "downloading" && <progress aria-label={t("Update download progress")} max={100} {...(percent !== null ? { value: percent } : {})} />}
  </div>;
}

interface SignedUpdateDraftDialogProps {
  confirmation: { version: string; dirty: readonly DesktopDraftLabel[]; changed: boolean } | null;
  blocked: string | null;
  installing: boolean;
  progress: SignedUpdateProgress | null;
  onKeepEditing: () => void;
  onConfirm: () => void;
  returnFocus: () => HTMLElement | null;
}

function usable(node: HTMLElement | null): node is HTMLElement {
  return !!node?.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]') && !node.matches(":disabled");
}

export function SignedUpdateDraftDialog(props: SignedUpdateDraftDialogProps) {
  const { t } = useTranslation();
  const { confirmation, blocked, installing, progress, onKeepEditing, onConfirm } = props;
  const latest = useRef(props);
  latest.current = props;
  const layer = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), keepEditing = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = !!confirmation || installing;
  const hasDrafts = !!confirmation?.dirty.length;
  const title = installing ? "Installing verified update" : hasDrafts ? "Install with unsaved changes?" : "Install verified update";
  const description = installing
    ? t("Keep the app open while the update downloads and installs. Closing and restarting are blocked until it finishes.")
    : t(hasDrafts
      ? "Installing version {version} restarts the app. Unsaved drafts will be lost if the app restarts."
      : "Installing version {version} restarts the app.", { version: confirmation?.version ?? "" });

  useLayoutEffect(() => {
    if (!open || !layer.current || !panel.current) return;
    const node = panel.current, ownerDocument = node.ownerDocument, ownerWindow = ownerDocument.defaultView;
    const release = isolateModalSiblings(layer.current, child => child.classList.contains("desktop-close-layer"));
    const fallback = () => latest.current.installing ? node : keepEditing.current ?? node;
    const onKey = (event: KeyboardEvent) => {
      if (!usable(node) || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!latest.current.installing) latest.current.onKeepEditing();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault(); event.stopImmediatePropagation();
      const controls = [...node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = controls.indexOf(ownerDocument.activeElement as HTMLButtonElement);
      const next = current < 0 ? (event.shiftKey ? controls.at(-1) : controls[0]) : controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
      (next ?? node).focus({ preventScroll: true });
    };
    const onFocus = (event: FocusEvent) => {
      if (usable(node) && !node.contains(event.target as Node)) fallback().focus({ preventScroll: true });
    };
    ownerWindow?.addEventListener("keydown", onKey, true);
    ownerDocument.addEventListener("focusin", onFocus);
    return () => {
      ownerWindow?.removeEventListener("keydown", onKey, true);
      ownerDocument.removeEventListener("focusin", onFocus);
      release();
      const target = latest.current.returnFocus();
      if (usable(target) && !hasActiveWorkbenchModal(ownerDocument, node)) target.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !usable(panel.current)) return;
    (installing ? panel.current : keepEditing.current ?? panel.current).focus({ preventScroll: true });
  }, [open, installing]);

  if (typeof document === "undefined") return null;
  return createPortal(<div ref={layer} className="signed-update-dialog-layer"><MotionPresence present={open}>{() => (
    <div className="signed-update-dialog-backdrop" onPointerDown={event => event.stopPropagation()}>
      <div className="signed-update-dialog" ref={panel} role={installing ? "dialog" : "alertdialog"} aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}>
        <h2 id={`${id}-title`}>{t(title)}</h2>
        <p id={`${id}-description`}>{description}</p>
        {installing ? (
          progress ? <SignedUpdateProgressView progress={progress} /> : <p className="signed-update-progress" role="status">{t("Preparing update installation…")}</p>
        ) : <>
          {hasDrafts && <ul aria-label={t("Unsaved drafts")}>{confirmation?.dirty.map(label => <li key={label}>{t(DESKTOP_DRAFT_LABELS[label])}</li>)}</ul>}
          {confirmation?.changed && <p className="signed-update-dialog-note" role="status">{t("Drafts changed since this prompt opened. Review them before continuing.")}</p>}
          {blocked && <p className="signed-update-dialog-note" role="status">{t(blocked)}</p>}
          <div className="signed-update-dialog-actions">
            <button type="button" className="btn primary" ref={keepEditing} onClick={() => { if (usable(panel.current)) onKeepEditing(); }}>{t("Keep editing")}</button>
            <button type="button" className={`btn${hasDrafts ? " signed-update-discard" : ""}`} disabled={!!blocked} onClick={() => { if (usable(panel.current)) onConfirm(); }}>{t(hasDrafts ? "Discard drafts and install" : "Install verified update")}</button>
          </div>
        </>}
      </div>
    </div>
  )}</MotionPresence></div>, document.body);
}
