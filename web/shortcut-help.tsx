import { useId, useLayoutEffect, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { hasActiveWorkbenchModal, workbenchShortcutCatalog, type WorkbenchShortcutAction } from "./workbench-shortcuts.ts";
import "./shortcut-help.css";

export interface ShortcutHelpProps {
  open: boolean;
  desktop: boolean;
  mac?: boolean;
  onClose: () => void;
  /** Runs after the close commit and the help's focus trap has been removed. */
  onAction: (action: WorkbenchShortcutAction) => void;
  /** Fallback entry point when a preceding command palette has already gone away. */
  returnFocus?: () => HTMLElement | null;
}

function controls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
}

export function ShortcutHelp({ open, desktop, mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform), onClose, onAction, returnFocus }: ShortcutHelpProps) {
  const { t } = useTranslation();
  const id = useId(), titleId = `${id}-title`, descriptionId = `${id}-description`;
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const returnTarget = useRef(returnFocus); returnTarget.current = returnFocus;
  const executing = useRef(false), mounted = useRef(open);
  if (open) mounted.current = true;
  const shortcuts = workbenchShortcutCatalog({ desktop, mac });

  useLayoutEffect(() => {
    if (!open) return;
    executing.current = false;
    const container = dialog.current;
    if (!container) return;
    const document = container.ownerDocument;
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== "Tab") return;
      const targets = controls(container), first = targets[0], last = targets.at(-1);
      if (!first) { event.preventDefault(); container.focus(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === container || !container.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || active === container || !container.contains(active))) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!executing.current && !container.contains(event.target as Node)) closeButton.current?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus);
      const active = document.activeElement;
      const canRestore = (node: HTMLElement | null): node is HTMLElement => !!node?.isConnected && node !== document.body && node !== document.documentElement && !node.closest('[inert], [hidden], [aria-hidden="true"]');
      const target = canRestore(previous) ? previous : returnTarget.current?.() ?? null;
      // Also ignore our own surface during a complete unmount, before its DOM is removed.
      if (!hasActiveWorkbenchModal(document, container) && canRestore(target)
        && (active === document.body || container.contains(active))) target.focus({ preventScroll: true });
    };
  }, [open]);

  function execute(action: WorkbenchShortcutAction) {
    if (!open || executing.current) return;
    executing.current = true;
    // Commit the close first: the action may immediately focus search or open an editor.
    flushSync(() => close.current());
    onAction(action);
  }

  const content = () => <div className="shortcut-help-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close.current(); }}>
    <div className="shortcut-help" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header className="shortcut-help-header"><div><span className="shortcut-help-eyebrow">{t("Your workbench, a little quicker")}</span><h2 id={titleId}>{t("Keyboard shortcuts")}</h2></div>
        <button type="button" className="shortcut-help-close" ref={closeButton} onClick={onClose} aria-label={t("Close keyboard shortcuts")}><kbd>Esc</kbd><span aria-hidden="true">×</span></button>
      </header>
      <p className="shortcut-help-description" id={descriptionId}>{t("Use a shortcut or choose an action below.")}</p>
      {(["everyday", "navigation"] as const).map(group => {
        const rows = shortcuts.filter(shortcut => shortcut.group === group);
        return rows.length ? <section className="shortcut-help-group" key={group} aria-labelledby={`${id}-${group}`}>
          <h3 id={`${id}-${group}`}>{t(group === "everyday" ? "Everyday actions" : "Move between pages")}</h3>
          <div className="shortcut-help-rows">{rows.map(shortcut => {
            const keys = <span className="shortcut-help-keys" aria-label={shortcut.keys.join(" + ")}>{shortcut.keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}</span>;
            return shortcut.action === "open-shortcut-help"
              ? <div className="shortcut-help-row current" key={shortcut.action}><span>{t(shortcut.label)}<small>{t("You are here")}</small></span>{keys}</div>
              : <button type="button" className="shortcut-help-row" key={shortcut.action} onClick={() => execute(shortcut.action)}><span>{t(shortcut.label)}</span>{keys}</button>;
          })}</div>
        </section> : null;
      })}
      <footer className="shortcut-help-footer"><span className="shortcut-help-platform">{t(desktop ? "Desktop shortcuts" : "Browser shortcuts")}</span><p>{t("Shortcuts pause while you type, compose text or work in a dialog.")}</p></footer>
    </div>
  </div>;
  if (typeof document === "undefined") return open ? content() : null;
  return mounted.current ? createPortal(<MotionPresence present={open}>{content}</MotionPresence>, document.body) : null;
}
