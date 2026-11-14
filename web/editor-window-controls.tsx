import { useId, useLayoutEffect, useRef, useState } from "react";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { WindowControls, type WindowChrome } from "./window-chrome.tsx";
import "./editor-window-controls.css";

export function EditorWindowControls({ chrome, disabled = false }: { chrome: WindowChrome; disabled?: boolean }) {
  const { t } = useTranslation();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const open = useRef(false);
  const consumedEscape = useRef(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    if (chrome.enabled && !disabled) return;
    open.current = false;
    consumedEscape.current = false;
    setExpanded(false);
  }, [chrome.enabled, disabled]);

  if (!chrome.enabled) return null;

  function closePanel(restoreFocus: boolean) {
    open.current = false;
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function interactive() {
    const button = trigger.current;
    return !!button && !button.disabled && !button.closest('[hidden], [inert], [aria-hidden="true"]');
  }

  async function invoke(action: () => Promise<void>) {
    if (!open.current || chrome.busy || !interactive()) return;
    // Native close can open another confirmation. Keep its return focus on a
    // control that remains mounted when this disclosure has closed.
    closePanel(true);
    await action();
  }

  const panelChrome = {
    ...chrome,
    minimize: () => invoke(chrome.minimize),
    toggleMaximize: () => invoke(chrome.toggleMaximize),
    close: () => invoke(chrome.close),
  };
  const label = t("Window controls");
  return <div className="editor-window-controls" data-no-drag
    onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      consumedEscape.current = false;
      if (open.current) closePanel(false);
    }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (!interactive() || (!open.current && !consumedEscape.current)) return;
      event.preventDefault();
      event.stopPropagation();
      consumedEscape.current = true;
      if (open.current) closePanel(true);
    }}
    onKeyUp={event => { if (event.key === "Escape") consumedEscape.current = false; }}>
    <button ref={trigger} type="button" className="editor-window-controls-trigger" aria-label={label} title={label}
      aria-expanded={expanded && !disabled} aria-controls={panelId} disabled={disabled}
      onClick={() => {
        if (!interactive()) return;
        if (open.current) closePanel(false);
        else {
          open.current = true;
          setExpanded(true);
        }
      }}>
      <span className="editor-window-controls-icon" aria-hidden="true" />
      <span className="editor-window-controls-label">{label}</span>
    </button>
    <div id={panelId} className="editor-window-controls-target">
      <MotionPresence present={expanded && !disabled} kind="popover">
        <div className="editor-window-controls-panel"><WindowControls chrome={panelChrome} /></div>
      </MotionPresence>
    </div>
  </div>;
}
