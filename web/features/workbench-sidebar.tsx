import type { ReactNode, Ref } from "react";
import { useTranslation } from "../i18n.tsx";
import { AppIcon, type IconName } from "../ui-primitives.tsx";

export type WorkbenchView = "profiles" | "inspection" | "proxies" | "scripts" | "assistant" | "extensions" | "trash" | "settings" | "workspaces";
interface NavigationItem { view: WorkbenchView; label: string; icon: IconName; count?: number }

/** The shell renders navigation; domain actions and task ownership stay with App. */
export function WorkbenchSidebar({ compact, collapsed, forced, view, profileCount, extensionCount, loaded, onToggle, onNavigate, onProfiles, onExtensions, onSettings, navigationRef, switcher, children, device, error }: {
  compact: boolean; collapsed: boolean; forced: boolean; view: WorkbenchView;
  profileCount: number; extensionCount: number; loaded: boolean;
  onToggle: () => void; onNavigate: (view: WorkbenchView) => void;
  onProfiles: () => void; onExtensions: () => void; onSettings: () => void;
  navigationRef?: Ref<HTMLElement>; switcher: ReactNode; children?: ReactNode; device: ReactNode; error?: string | null;
}) {
  const { t } = useTranslation();
  const renderItem = (item: NavigationItem) => {
    const active = view === item.view || item.view === "profiles" && view === "inspection";
    return <button key={item.view} type="button" className={`navitem${active ? " active" : ""}`} aria-current={active ? "page" : undefined}
      aria-label={t(item.label)} data-tip={t(item.label)} title={t(item.label)}
      onClick={() => item.view === "profiles" ? onProfiles() : item.view === "extensions" ? onExtensions() : item.view === "settings" ? onSettings() : onNavigate(item.view)}>
      <AppIcon name={item.icon} /><span className="navlabel">{t(item.label)}</span>
      {!!item.count && <span className="cnt" aria-hidden="true">{item.count}</span>}
    </button>;
  };
  return <aside className={`sidebar${compact ? " collapsed" : ""}`} aria-label={t("Workspace navigation")}>
    <div className="rail-heading"><span className="rail-section-label" aria-hidden="true">{t("Workspaces")}</span>
      {!forced && <button type="button" className="rail-toggle" aria-label={t(collapsed ? "Expand sidebar" : "Collapse sidebar")}
        data-tip={t(collapsed ? "Expand sidebar" : "Collapse sidebar")} title={t(collapsed ? "Expand sidebar" : "Collapse sidebar")}
        aria-controls="workspace-navigation" aria-expanded={!collapsed} onClick={onToggle}><AppIcon name={collapsed ? "expandRail" : "collapseRail"} /></button>}
    </div>
    {switcher}
    <nav id="workspace-navigation" className="sidenav" ref={navigationRef} aria-label={t("Workspace navigation")}>
      <span className="rail-active-marker" aria-hidden="true" />
      <div className="rail-nav-group" role="group" aria-label={t("Workspace")}>
        {renderItem({ view: "profiles", label: "All profiles", icon: "profiles", count: loaded ? profileCount : 0 })}
        {renderItem({ view: "proxies", label: "Proxies", icon: "activity" })}
      </div>
      <div className="rail-nav-group rail-nav-tools" role="group" aria-label={t("Tools")}>
        <span className="rail-section-label" aria-hidden="true">{t("Tools")}</span>
        {renderItem({ view: "scripts", label: "Scripts", icon: "file" })}
        {renderItem({ view: "assistant", label: "AI workspace", icon: "bot" })}
        {renderItem({ view: "extensions", label: "Manage extensions", icon: "puzzle", count: extensionCount })}
      </div>
    </nav>
    {children}
    <div className="sidefoot"><div className="rail-utilities" role="group" aria-label={t("Management")}>
      {renderItem({ view: "trash", label: "Trash", icon: "trash" })}
      {renderItem({ view: "settings", label: "Settings", icon: "settings" })}
    </div>{device}</div>
    {error && <div className="mode-error" role="alert">{error}</div>}
  </aside>;
}
