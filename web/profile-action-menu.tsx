import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";

function enabledMenuButtons(menu: HTMLDivElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

/** Keep the roster compact while allowing the menu to escape its scrolling table. */
export function ProfileActionMenu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const openRef = useRef(false), mountedPortal = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const placedAnchor = useRef<DOMRect | null>(null);
  const openAtLastItem = useRef(false);
  const focusedItem = useRef<{ button: HTMLButtonElement; index: number } | null>(null);
  const id = useId();
  const show = (next: boolean) => { openRef.current = next; setOpen(next); };
  if (open) mountedPortal.current = true;

  const place = () => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    placedAnchor.current = anchor;
    const width = menu.current?.offsetWidth || 216;
    const height = menu.current?.offsetHeight || 200;
    const below = window.innerHeight - anchor.bottom;
    const next = {
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: below >= height + 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6),
    };
    setPosition((current) => current.left === next.left && current.top === next.top ? current : next);
  };

  // Polling can reorder running rows while a menu stays open. Keep the portal
  // attached to its own row without moving keyboard focus on every refresh.
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!open || !panel) return;
    place();
    const previous = focusedItem.current;
    const active = panel.ownerDocument.activeElement;
    if (!previous || (active !== panel.ownerDocument.body && active !== previous.button)) return;
    if (panel.contains(previous.button) && !previous.button.disabled) return;
    const items = enabledMenuButtons(panel);
    (items[Math.min(previous.index, items.length - 1)] ?? panel).focus();
  }, [open, label, children]);
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!open || !panel) return;
    const items = enabledMenuButtons(panel);
    (items.at(openAtLastItem.current ? -1 : 0) ?? panel).focus();
    return () => { focusedItem.current = null; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) show(false);
    };
    const onChange = (event: Event) => {
      if (event.type === "scroll") {
        if (event.target instanceof Node && menu.current?.contains(event.target)) return;
        // Focusing a row can scroll it into view before the browser sends its
        // scroll event. Keep the menu open if it was placed at that position.
        const anchor = trigger.current?.getBoundingClientRect();
        const placed = placedAnchor.current;
        if (anchor && placed && anchor.top === placed.top && anchor.right === placed.right && anchor.bottom === placed.bottom) return;
      }
      // Return keyboard focus before the visual exit becomes inert.
      if (menu.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      show(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [open]);

  return <>
    <button
      ref={trigger}
      type="button"
      className="iconbtn profile-menu-trigger"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => { openAtLastItem.current = false; place(); show(!openRef.current); }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          openAtLastItem.current = event.key === "ArrowUp";
          if (openRef.current) {
            const panel = menu.current;
            (enabledMenuButtons(panel).at(openAtLastItem.current ? -1 : 0) ?? panel)?.focus();
          } else {
            place();
            show(true);
          }
        }
        if (event.key === "Escape") show(false);
      }}
    >{icon}</button>
    {mountedPortal.current && typeof document !== "undefined" && createPortal(<MotionPresence present={open} kind="popover">{() => <div
      ref={menu}
      id={id}
      className="popover profile-actions-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ position: "fixed", ...position }}
      onFocusCapture={(event) => {
        const items = enabledMenuButtons(event.currentTarget);
        const button = event.target.closest<HTMLButtonElement>("button");
        const index = button ? items.indexOf(button) : -1;
        focusedItem.current = index < 0 ? null : { button: items[index]!, index };
      }}
      onClickCapture={(event) => {
        // A first item may close this menu before React commits its inert exit.
        // Do not let a queued second click execute a second child action.
        if (!openRef.current) { event.preventDefault(); event.stopPropagation(); }
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button:not(:disabled)')) {
          const active = event.currentTarget.ownerDocument.activeElement;
          if (active === event.currentTarget.ownerDocument.body || event.currentTarget.contains(active)) {
            trigger.current?.focus({ preventScroll: true });
          }
          show(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); show(false); trigger.current?.focus({ preventScroll: true }); return;
        }
        if (event.key === "Tab") { show(false); trigger.current?.focus({ preventScroll: true }); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = enabledMenuButtons(menu.current);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
          : current > 0 ? current - 1 : items.length - 1;
        items[next]?.focus();
      }}
    >{children}</div>}</MotionPresence>, document.body)}
  </>;
}
