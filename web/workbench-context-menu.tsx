import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RosterDensity } from "../roster-density-state.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon, type IconName } from "./ui-primitives.tsx";
import "./workbench-context-menu.css";

export type ContextMenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: IconName;
      shortcut?: string;
      tone?: "default" | "primary" | "danger";
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
    }
  | {
      kind: "separator";
      id: string;
    }
  | {
      kind: "density";
      id: string;
      label: string;
      value: RosterDensity;
      disabled?: boolean;
      options: ReadonlyArray<{ value: RosterDensity; label: string }>;
      onSelect: (next: RosterDensity) => void;
    };

export interface WorkbenchContextMenuState {
  x: number;
  y: number;
  header?: string;
  items: readonly ContextMenuEntry[];
}

const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
  "hidden",
]);

function resolveTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  if (typeof (target as Element).closest === "function") return target as Element;
  const parent = (target as { parentElement?: Element | null }).parentElement;
  return parent && typeof parent.closest === "function" ? parent : null;
}

/**
 * Keep OS/browser native context menu when holding Shift (developer inspection),
 * inside editable text inputs, or when the user has selected text to copy.
 */
export function shouldAllowNativeContextMenu(
  target: EventTarget | null,
  shiftKey: boolean,
  selectionText?: string,
): boolean {
  if (shiftKey) return true;
  const el = resolveTargetElement(target);
  if (el) {
    if (
      el.closest(
        'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
      )
    ) {
      return true;
    }
    const input = el.closest("input");
    if (input) {
      const type = (input.getAttribute("type") ?? "text").trim().toLowerCase();
      if (!NON_TEXT_INPUT_TYPES.has(type)) return true;
    }
  }
  const activeSelection =
    selectionText !== undefined
      ? selectionText
      : typeof window !== "undefined"
        ? (window.getSelection()?.toString() ?? "")
        : "";
  return activeSelection.trim().length > 0;
}

export function clampContextMenuPosition(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const rawLeft =
    point.x + size.width + margin > viewport.width ? point.x - size.width : point.x;
  const rawTop =
    point.y + size.height + margin > viewport.height ? point.y - size.height : point.y;
  return {
    left: Math.max(margin, Math.min(rawLeft, maxLeft)),
    top: Math.max(margin, Math.min(rawTop, maxTop)),
  };
}

function enabledMenuItems(menu: HTMLDivElement | null): HTMLButtonElement[] {
  return Array.from(
    menu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ) ?? [],
  );
}

export function WorkbenchContextMenu({
  state,
  onClose,
}: {
  state: WorkbenchContextMenuState | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [position, setPosition] = useState(() =>
    state ? { left: state.x, top: state.y } : { left: 0, top: 0 },
  );

  useLayoutEffect(() => {
    const panel = menuRef.current;
    if (!state || !panel) return;
    const width = panel.offsetWidth || 240;
    const height = panel.offsetHeight || 220;
    const next = clampContextMenuPosition(
      { x: state.x, y: state.y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition((prev) =>
      prev.left === next.left && prev.top === next.top ? prev : next,
    );
  }, [state]);

  useLayoutEffect(() => {
    if (!state) return;
    menuRef.current?.focus({ preventScroll: true });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const dismissOnScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const dismissAlways = () => onCloseRef.current();

    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismissAlways);
    window.addEventListener("blur", dismissAlways);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismissAlways);
      window.removeEventListener("blur", dismissAlways);
    };
  }, [state]);

  if (!state || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className="popover workbench-context-menu"
      role="menu"
      aria-label={t("Context menu")}
      tabIndex={-1}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCloseRef.current();
          return;
        }
        if (event.key === "Tab") {
          onCloseRef.current();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = enabledMenuItems(menuRef.current);
        if (!items.length) return;
        const doc = menuRef.current?.ownerDocument ?? document;
        const current = items.indexOf(doc.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (current + 1) % items.length
                : current > 0
                  ? current - 1
                  : items.length - 1;
        items[next]?.focus({ preventScroll: true });
      }}
    >
      {state.header && (
        <div className="wcm-header" title={state.header}>
          {state.header}
        </div>
      )}
      {state.items.map((entry) => {
        if (entry.kind === "separator") {
          return <div key={entry.id} className="pop-sep wcm-sep" role="separator" />;
        }
        if (entry.kind === "density") {
          return (
            <div key={entry.id} className="wcm-density-row" role="group" aria-label={entry.label}>
              <span className="wcm-density-label">{entry.label}</span>
              <div className="wcm-density-pills">
                {entry.options.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.value === opt.value}
                    className={`wcm-density-pill${entry.value === opt.value ? " is-active" : ""}`}
                    disabled={entry.disabled}
                    onClick={() => {
                      if (entry.disabled) return;
                      entry.onSelect(opt.value);
                      onCloseRef.current();
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={`pop-item wcm-item${entry.tone === "danger" ? " danger" : entry.tone === "primary" ? " primary" : ""}`}
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => {
              if (entry.disabled) return;
              onCloseRef.current();
              entry.onSelect();
            }}
          >
            {entry.icon && <AppIcon name={entry.icon} className="sm" />}
            <span className="wcm-label">{entry.label}</span>
            {entry.shortcut && <kbd className="wcm-shortcut">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
