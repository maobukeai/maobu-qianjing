import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../i18n.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import "./roster-navigation.css";

export interface RosterNavigationGroup { name: string; label: string; depth: number; count: number }

/** A single collection navigator moves into a flyout when the rail is compact. */
export function RosterNavigation({ compact, active, group, groups, total, ungrouped, onGroup, children }: {
  compact: boolean; active: boolean; group: string; groups: readonly RosterNavigationGroup[];
  total: number; ungrouped: number; onGroup: (group: string) => void; children: ReactNode;
}) {
  const { t } = useTranslation(), id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!active || !compact) setOpen(false); }, [active, compact]);
  useEffect(() => {
    if (!open || !compact) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape" || !root.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); };
  }, [open, compact]);
  return <div className={`roster-navigation${compact ? " is-compact" : ""}`} ref={root} hidden={!active}>
    {compact && <button ref={trigger} className="navitem roster-navigation-trigger" type="button" aria-label={t("Environment views")}
      aria-controls={id} aria-expanded={open} title={t("Environment views")} onClick={() => setOpen(value => !value)}><AppIcon name="folders" /></button>}
    <div className="roster-navigation-panel" id={id} hidden={compact && !open}>
      {children}
      <nav className="roster-group-navigation" aria-label={t("Groups")}>
        <span className="roster-navigation-heading">{t("Groups")}</span>
        {[{ name: "all", label: t("All groups"), depth: 0, count: total }, { name: "", label: t("Ungrouped"), depth: 0, count: ungrouped }, ...groups].map(item => <button type="button" key={item.name}
          className="roster-group-link" aria-current={group === item.name ? "true" : undefined} title={item.label}
          style={{ paddingInlineStart: 10 + item.depth * 12 }} onClick={() => { onGroup(item.name); if (compact) { setOpen(false); trigger.current?.focus(); } }}>
          <AppIcon name="folder" className="sm" /><span>{item.label}</span><small>{item.count}</small>
        </button>)}
      </nav>
    </div>
  </div>;
}
