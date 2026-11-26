import { useId, useLayoutEffect, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { hasActiveWorkbenchModal, workbenchShortcutCatalog, type WorkbenchShortcutAction } from "./workbench-shortcuts.ts";
import { AppIcon } from "./ui-primitives.tsx";
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

function scrollShortcutList(body: HTMLDivElement | null, event: KeyboardEvent): boolean {
  if (!body || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  switch (event.key) {
    case "PageDown": body.scrollTop += body.clientHeight; break;
    case "PageUp": body.scrollTop -= body.clientHeight; break;
    case "Home": body.scrollTop = 0; break;
    case "End": body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight); break;
    default: return false;
  }
  return true;
}

export function ShortcutHelp({ open, desktop, mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform), onClose, onAction, returnFocus }: ShortcutHelpProps) {
  const { t } = useTranslation();
  const id = useId(), titleId = `${id}-title`, descriptionId = `${id}-description`;
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
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
      if (scrollShortcutList(body.current, event)) { event.preventDefault(); event.stopPropagation(); return; }
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
      <header className="shortcut-help-header">
        <div><h2 id={titleId}>{t("Keyboard shortcuts")}</h2><p id={descriptionId}>{t("Select an action to run it.")}</p></div>
        <button type="button" className="shortcut-help-close" ref={closeButton} onClick={onClose} aria-label={t("Close keyboard shortcuts")}><AppIcon name="close" className="sm" /></button>
      </header>
      <div className="shortcut-help-body" ref={body}>
        {(["everyday", "navigation"] as const).map(group => {
          const rows = shortcuts.filter(shortcut => shortcut.group === group);
          return rows.length ? <section className="shortcut-help-group" key={group} aria-labelledby={desktop ? `${id}-${group}` : undefined}>
            {desktop && <h3 id={`${id}-${group}`}>{t(group === "everyday" ? "Everyday actions" : "Move between pages")}</h3>}
            <ul className="shortcut-help-rows" role="list">{rows.map(shortcut => {
              const keys = <>
                <span className="shortcut-help-keys" aria-hidden="true">{shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}</span>
                <span className="sr-only">{shortcut.keys.join(" + ")}</span>
              </>;
              return <li key={shortcut.action}>
                {shortcut.action === "open-shortcut-help"
                  ? <div className="shortcut-help-row current" aria-current="true"><span>{t(shortcut.label)}</span>{keys}</div>
                  : <button type="button" className="shortcut-help-row" onClick={() => execute(shortcut.action)}><span>{t(shortcut.label)}</span>{keys}</button>}
              </li>;
            })}</ul>
          </section> : null;
        })}
      </div>
      <footer className="shortcut-help-note">{t("Shortcuts pause in fields and dialogs.")}</footer>
    </div>
  </div>;
  if (typeof document === "undefined") return open ? content() : null;
  return mounted.current ? createPortal(<MotionPresence present={open}>{content}</MotionPresence>, document.body) : null;
}
