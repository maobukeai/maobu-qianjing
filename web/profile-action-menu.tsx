import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Keep the roster compact while allowing the menu to escape its scrolling table. */
export function ProfileActionMenu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = () => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
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
  useLayoutEffect(() => { if (open) place(); });
  useLayoutEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onChange = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
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
      onClick={() => { place(); setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); place(); setOpen(true); }
        if (event.key === "Escape") setOpen(false);
      }}
    >{icon}</button>
    {open && createPortal(<div
      ref={menu}
      id={id}
      className="popover profile-actions-menu"
      role="menu"
      aria-label={label}
      style={{ position: "fixed", ...position }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button:not(:disabled)')) {
          trigger.current?.focus({ preventScroll: true });
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return;
        }
        if (event.key === "Tab") { setOpen(false); trigger.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >{children}</div>, document.body)}
  </>;
}
