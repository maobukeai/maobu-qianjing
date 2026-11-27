import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RosterScope } from "../../src/profile-view-state.ts";
import { useTranslation } from "../i18n.tsx";
import { useSlidingIndicator } from "../navigation-motion.ts";
import { AppIcon, type IconName } from "../ui-primitives.tsx";
import "./roster-navigation.css";

export interface RosterNavigationGroup { name: string; label: string; depth: number; count: number }

const groupIcon = (name: string): IconName => (name === "all" ? "folders" : name === "" ? "inbox" : "folder");

/** A single collection navigator moves into a flyout when the rail is compact. */
export function RosterNavigation({ compact, active, scope, onScope, group, groups, total, ungrouped, onGroup, children }: {
  compact: boolean; active: boolean; scope?: RosterScope; onScope?: (scope: RosterScope) => void;
  group: string; groups: readonly RosterNavigationGroup[];
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
  const compactGroups: RosterNavigationGroup[] = [
    ...(ungrouped > 0 ? [{ name: "", label: t("Ungrouped"), depth: 0, count: ungrouped }] : []),
    ...groups,
  ];
  const groupIndicator = useSlidingIndicator<HTMLElement>({
    activeKey: `${group}:${groups.length}:${compact}:${open}`,
    activeSelector: '.roster-group-link[aria-current="true"]',
    axis: "vertical",
    ready: active && (!compact || open),
    fixedSize: 33,
  });
  const compactIndicator = useSlidingIndicator<HTMLDivElement>({
    activeKey: `${scope ?? "all"}:${group}:${groups.length}:${compact}`,
    activeSelector: '.roster-compact-item[aria-pressed="true"], .roster-compact-item[aria-current="true"]',
    axis: "vertical",
    ready: active && compact,
    fixedSize: 34,
  });
  return <div className={`roster-navigation${compact ? " is-compact" : ""}`} ref={root} hidden={!active}>
    {compact && <button ref={trigger} className="navitem roster-navigation-trigger" type="button" aria-label={t("Environment views")}
      aria-controls={id} aria-expanded={open} title={t("Environment views")} onClick={() => setOpen(value => !value)}><AppIcon name="folders" /></button>}
    {compact && (
      <div className="roster-compact-rail" ref={compactIndicator.containerRef} data-sliding-managed="self" role="group" aria-label={t("Views and groups")}>
        <span className="sliding-indicator roster-compact-pill" ref={compactIndicator.indicatorRef} aria-hidden="true" />
        {onScope && (
          <button
            type="button"
            className="roster-compact-item"
            aria-pressed={scope === "favorites"}
            aria-label={t("Favorites")}
            title={t("Favorites")}
            data-tip={t("Favorites")}
            onClick={() => onScope(scope === "favorites" ? "all" : "favorites")}
          >
            <AppIcon name="star" className="sm" />
          </button>
        )}
        {compactGroups.map(item => {
          const tip = `${item.label} · ${item.count}`;
          return (
            <button
              type="button"
              key={item.name}
              data-sidebar-group={item.name}
              className="roster-compact-item"
              aria-current={group === item.name ? "true" : undefined}
              aria-label={tip}
              title={tip}
              data-tip={tip}
              onClick={() => onGroup(item.name)}
            >
              <AppIcon name={groupIcon(item.name)} className="sm" />
            </button>
          );
        })}
      </div>
    )}
    <div className="roster-navigation-panel" id={id} hidden={compact && !open}>
      {children}
      <nav className="roster-group-navigation" ref={groupIndicator.containerRef} data-sliding-managed="self" aria-label={t("Groups")}>
        <span className="sliding-indicator roster-group-pill" ref={groupIndicator.indicatorRef} aria-hidden="true" />
        <span className="roster-navigation-heading">{t("Groups")}</span>
        {[{ name: "all", label: t("All groups"), depth: 0, count: total }, { name: "", label: t("Ungrouped"), depth: 0, count: ungrouped }, ...groups].map(item => <button type="button" key={item.name}
          data-sidebar-group={item.name}
          className="roster-group-link" aria-current={group === item.name ? "true" : undefined} title={item.label}
          style={{ paddingInlineStart: 10 + item.depth * 12 }} onClick={() => { onGroup(item.name); if (compact) { setOpen(false); trigger.current?.focus(); } }}>
          <AppIcon name={groupIcon(item.name)} className="sm" /><span>{item.label}</span><small>{item.count}</small>
        </button>)}
      </nav>
    </div>
  </div>;
}
