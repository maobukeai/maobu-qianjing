import { type CSSProperties, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import { useDesktopCloseDraft, useDesktopCloseDraftReader, useDesktopCloseDraftSnapshot } from "./desktop-close.tsx";
import { DESKTOP_DRAFT_LABELS, type DesktopDraftLabel } from "./desktop-close-state.ts";
import { availableLanguages, languageNativeName, useTranslation } from "./i18n.tsx";
import type { RuntimeDownload } from "./api.ts";
import type { ThemeChoice } from "./theme.ts";
import { WORKSPACE_COLORS, WORKSPACE_ICONS, activateWorkspace, archiveWorkspace, cancelActivation, createWorkspace, downloadWorkspaceBackup, fetchWorkspaceBackups, fetchWorkspaceJob, fetchWorkspaceOverview, fetchWorkspaces, openWorkspaceLocation, restartWorkspace, restoreWorkspace, startWorkspaceBackup, updateWorkspace, workspaceDesktopAvailable, workspaceHistoryJob, workspaceJobActive, workspaceJobPercent, type WorkspaceBackups, type WorkspaceCatalog, type WorkspaceIcon, type WorkspaceJob, type WorkspaceMetadata, type WorkspaceOverview, type WorkspaceRecord } from "./workspaces-api.ts";
import { changedWorkspaceFields, createWorkspaceMetadataDraft, followWorkspaceMetadata, reviewWorkspaceMetadata, workspaceMetadata, workspaceMetadataPatch } from "./workspace-metadata-draft.ts";
import "./workspace-manager.css";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider, useWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationKind } from "./workspace-operations.tsx";
export { useWorkspaceOperations, workspaceOperationMessage } from "./workspace-operations.tsx";

export interface WorkspaceSwitcherProps {
  variant?: "sidebar" | "context" | "rail";
  compact?: boolean;
  profileCount: number; runningCount: number; connection: boolean;
  onShowRunning: () => void;
  onOpenManagement?: (intent: WorkspacePageIntent) => void;
  onShowBatchTask?: () => void;
  managementActive?: boolean;
  onSettings?: (section?: "general" | "advanced") => void;
  renderIcon?: (name: string, className?: string) => ReactNode;
}
export type WorkspacePageIntent = { mode: "manage" | "create" | "switch" | "backups"; workspaceId?: string };
export type WorkspacePageRequest = WorkspacePageIntent & { id: number };
interface WorkspaceActivityState { job: WorkspaceJob | null; dirty: boolean; }
interface WorkspaceManagementPageProps { active: boolean; request: WorkspacePageRequest; onBack: () => void; onShowRunning: () => void; onShowBatchTask?: () => void; renderIcon?: WorkspaceSwitcherProps["renderIcon"]; }
export interface DevicePanelProps {
  variant?: "sidebar" | "header" | "rail";
  runningCount: number; downloads: RuntimeDownload[]; downloadStatusUnavailable?: boolean; connection: boolean; connectionLoading?: boolean; version: string;
  theme: ThemeChoice; chooseTheme: (theme: ThemeChoice) => void;
  language: string; setLanguage: (language: string) => void | Promise<void>;
  onShowRunning: () => void; onSettings: (section?: "general" | "advanced") => void;
  onViewLogs: () => void; onRetryConnection?: () => void | Promise<void>;
  renderIcon?: WorkspaceSwitcherProps["renderIcon"];
}

const ICON_LABELS: Record<WorkspaceIcon, string> = { laptop: "Laptop", folder: "Folder", briefcase: "Briefcase", globe: "Globe", star: "Star", layers: "Layers" };
const COLOR_LABELS: Record<string, string> = { "#8169c8": "Purple", "#628ac7": "Blue", "#638f77": "Green", "#c4905b": "Amber", "#b87594": "Rose", "#7c7d8e": "Slate" };
const METADATA_LABELS: Record<keyof WorkspaceMetadata, string> = { name: "Workspace name", color: "Workspace color", icon: "Workspace icon" };
interface WorkspaceContextValue { catalog: WorkspaceCatalog | null; currentWorkspace: WorkspaceRecord | undefined; currentName: string; loading: boolean; error: string | null; refresh: (signal?: AbortSignal) => Promise<WorkspaceCatalog | null>; acceptRecord: (workspace: WorkspaceRecord) => void; acceptActiveId: (id: string) => void; activity: WorkspaceActivityState; setActivity: (activity: WorkspaceActivityState) => void; }
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function WorkspaceProvider({ children, initialCatalog }: { children: ReactNode; initialCatalog?: WorkspaceCatalog }) {
  const [coordinator] = useState(() => createWorkspaceOperationCoordinator(initialCatalog));
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(initialCatalog ?? null), [loading, setLoading] = useState(!initialCatalog), [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<WorkspaceActivityState>({ job: null, dirty: false });
  const catalogRef = useRef(catalog);
  const catalogRevision = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => { const revision = ++catalogRevision.current; setLoading(true); try { const next = await fetchWorkspaces(signal); if (!signal?.aborted && revision === catalogRevision.current) { catalogRef.current = next; coordinator.setWorkspace(next.currentId, next.activeId); setCatalog(next); setError(null); } return next; } catch (e) { if (!signal?.aborted && revision === catalogRevision.current) setError(errorMessage(e)); return null; } finally { if (!signal?.aborted && revision === catalogRevision.current) setLoading(false); } }, [coordinator]);
  const acceptRecord = useCallback((workspace: WorkspaceRecord) => { const old = catalogRef.current; if (old) { catalogRevision.current++; setLoading(false); const next = { ...old, workspaces: old.workspaces.some(item => item.id === workspace.id) ? old.workspaces.map(item => item.id === workspace.id ? workspace : item) : [...old.workspaces, workspace] }; catalogRef.current = next; setCatalog(next); } }, []);
  const acceptActiveId = useCallback((id: string) => { const current = catalogRef.current; if (current) { catalogRevision.current++; setLoading(false); const next = { ...current, activeId: id }; catalogRef.current = next; coordinator.setWorkspace(next.currentId, id); setCatalog(next); } }, [coordinator]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const currentWorkspace = catalog?.workspaces.find(workspace => workspace.id === catalog.currentId);
  return <WorkspaceOperationsProvider coordinator={coordinator}><WorkspaceContext.Provider value={{ catalog, currentWorkspace, currentName: currentWorkspace?.name ?? "", loading, error, refresh, acceptRecord, acceptActiveId, activity, setActivity }}>{children}</WorkspaceContext.Provider></WorkspaceOperationsProvider>;
}
export function useWorkspaceCatalog(): WorkspaceContextValue { const value = useContext(WorkspaceContext); if (!value) throw new Error("WorkspaceProvider is required."); return value; }
const PHASE_LABELS: Record<string, string> = { queued: "Waiting to start", scanning: "Scanning workspace", checking: "Checking workspace", preparing: "Preparing workspace task", snapshot: "Taking a database snapshot", hashing: "Verifying files", compressing: "Compressing backup", copying: "Copying workspace data", archiving: "Creating archive", packing: "Creating archive", verifying: "Verifying backup", validating: "Validating backup", extracting: "Extracting backup", restoring: "Restoring workspace files", publishing: "Publishing restored workspace", finalizing: "Finishing", complete: "Completed", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };
function Icon({ name, render }: { name: string; render?: WorkspaceSwitcherProps["renderIcon"] }) {
  if (render) { const value = render(name, "wm-icon"); if (value) return <>{value}</>; }
  const paths: Record<string, ReactNode> = {
    laptop: <><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M2 20h20" /></>, folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9H3Z" />,
    briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3" /></>, globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
    star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9Z" />, layers: <><path d="m12 3 10 5-10 5L2 8Z" /><path d="m2 12 10 5 10-5M2 16l10 5 10-5" /></>,
    back: <path d="m12 5-7 7 7 7M5 12h15" />, search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />, close: <path d="m6 6 12 12M6 18 18 6" />, check: <path d="m5 12 4 4L19 6" />, chevronDown: <path d="m6 9 6 6 6-6" />,
    refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>, archive: <><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v14h14V7M10 11h4" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></>, upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 17v4h16v-4" /></>, open: <><path d="M14 3h7v7m0-7L10 14" /><path d="M10 3H3v18h18v-7" /></>,
    logs: <><path d="M14 2H4v20h16V8Z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>, settings: <><path d="M3 7h11m4 0h3M3 17h5m4 0h9" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>, sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M21 13A9 9 0 1111 3a7 7 0 0010 10Z" />, drive: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 13h18m-4 3h1m-4 0h1" /></>, alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></>,
  };
  return <svg className="wm-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.laptop}</svg>;
}
function bytes(value: number | null): string { if (value === null) return "—"; if (!value) return "0 B"; const units = ["B", "KB", "MB", "GB", "TB"]; const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`; }
function date(value: number): string { return value ? new Date(value).toLocaleString() : "—"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Workspace request failed."; }
function controls(node: HTMLElement): HTMLElement[] { return [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length > 0); }
function useDialogFocus(ref: { current: HTMLElement | null }, open: boolean, close: () => void, paused = false) {
  const closeRef = useRef(close), pauseRef = useRef(paused); closeRef.current = close; pauseRef.current = paused;
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const node = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (controls(node)[0] ?? node).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (pauseRef.current) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const list = controls(node), first = list[0], last = list[list.length - 1], active = document.activeElement;
      if (!first || !last) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (active === first || active === node || !node.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !node.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected && (document.activeElement === document.body || node.contains(document.activeElement))) previous.focus({ preventScroll: true }); };
  }, [open]);
}
type PopoverPlacement = "top" | "bottom" | "bottom-end" | "right" | "left";
type PopoverPosition = { top: number; left: number; maxWidth?: number; placement: PopoverPlacement };
function usePopover(
  open: boolean,
  trigger: { current: HTMLElement | null },
  panel: { current: HTMLElement | null },
  close: () => void,
  preferred: "bottom" | "bottom-end" | "top" | "right" = "bottom",
  onTriggerHidden?: () => void,
) {
  const [position, setPosition] = useState<PopoverPosition>({ top: 0, left: 0, placement: preferred });
  const closeRef = useRef(close), hiddenRef = useRef(onTriggerHidden);
  closeRef.current = close;
  hiddenRef.current = onTriggerHidden;
  const place = () => {
    if (!open || !trigger.current || !panel.current) return;
    if (!trigger.current.getClientRects().length || getComputedStyle(trigger.current).visibility === "hidden") {
      hiddenRef.current?.();
      closeRef.current();
      return;
    }
    const anchor = trigger.current.getBoundingClientRect();
    const width = panel.current.offsetWidth, height = panel.current.offsetHeight;
    const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
    const margin = 8, gap = 8;
    const bottomLimit = Math.max(margin, viewportHeight - height - margin);
    const openAbove = preferred === "top" && anchor.top > height + 10;
    const alignedLeft = preferred === "bottom-end" ? anchor.right - width : anchor.left;
    let next: PopoverPosition = {
      top: openAbove ? anchor.top - height - gap : Math.min(anchor.bottom + gap, bottomLimit),
      left: Math.max(margin, Math.min(alignedLeft, viewportWidth - width - margin)),
      placement: openAbove ? "top" : preferred === "bottom-end" ? "bottom-end" : "bottom",
    };
    if (preferred === "right") {
      const roomRight = viewportWidth - anchor.right - gap - margin;
      const roomLeft = anchor.left - gap - margin;
      const alignedTop = Math.max(margin, Math.min(anchor.top, bottomLimit));
      if (roomRight >= 180) next = { top: alignedTop, left: anchor.right + gap, maxWidth: roomRight, placement: "right" };
      else if (roomLeft >= 180) next = { top: alignedTop, left: anchor.left - gap - Math.min(width, roomLeft), maxWidth: roomLeft, placement: "left" };
    }
    setPosition(old => (
      old.top === next.top && old.left === next.left && old.maxWidth === next.maxWidth && old.placement === next.placement
        ? old
        : next
    ));
  };
  useLayoutEffect(place, [open, preferred]);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        trigger.current?.focus({ preventScroll: true });
        closeRef.current();
      }
    };
    const change = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) place();
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (trigger.current) resize?.observe(trigger.current);
    if (panel.current) resize?.observe(panel.current);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", change);
    window.addEventListener("scroll", change, true);
    return () => {
      resize?.disconnect();
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", change);
      window.removeEventListener("scroll", change, true);
    };
  }, [open, preferred]);
  const { placement, ...style } = position;
  return { placement, style };
}
function WorkspaceBadge({ workspace, icon, render }: { workspace?: WorkspaceRecord | WorkspaceMetadata; icon?: WorkspaceIcon; render?: WorkspaceSwitcherProps["renderIcon"] }) { return <span className="wm-workspace-badge" style={{ "--workspace-color": workspace?.color ?? WORKSPACE_COLORS[0] } as CSSProperties}><Icon name={icon ?? workspace?.icon ?? "laptop"} render={render} /></span>; }

/** Backups always use the running workspace, independently of the metadata editor. */
export function WorkspaceBackupIntro({ renderIcon }: { renderIcon?: WorkspaceSwitcherProps["renderIcon"] }) {
  const { t } = useTranslation(), { currentWorkspace } = useWorkspaceCatalog();
  return <div className="wm-backup-intro"><h2>{t("Full workspace backups")}</h2><div className="wm-backup-source"><WorkspaceBadge workspace={currentWorkspace} render={renderIcon} /><span>{t("Current backup workspace: {name}", { name: currentWorkspace?.name ?? t("Loading workspace…") })}</span></div><p>{t("Includes browser data, login sessions, groups, scripts, extensions, and Trash. Downloadable browser engines are excluded.")}</p><p className="wm-small wm-backup-security">{t("New backups are encrypted with a password. Older backups may be unencrypted.")}</p><p className="wm-small">{t("System protection may require you to sign in again after restoring on another computer.")}</p></div>;
}

type PreparedWorkspaceSwitch = { expected: string; target: string };
type BackupConfirmation = { kind: "backup" } | { kind: "restore"; source: File | { backupId: string }; name: string; encrypted?: boolean };
type Confirmation =
  | { kind: "discard"; action: () => void }
  | { kind: "activate"; expected: string; target: WorkspaceRecord; overview: WorkspaceOverview | null }
  | { kind: "restart"; pending: PreparedWorkspaceSwitch }
  | BackupConfirmation;
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const { snapshot } = useWorkspaceOperations();
  const { catalog, currentWorkspace: current, loading, error, refresh, activity } = useWorkspaceCatalog();
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const context = props.variant === "context", rail = props.variant === "rail";
  const menuId = useId(), noteId = useId();
  const { placement, style } = usePopover(menuOpen, trigger, menu, () => setMenuOpen(false), rail ? "right" : "bottom");
  const pending = !!catalog && catalog.currentId !== catalog.activeId;
  const batchActive = snapshot.operation?.kind === "profile-batch", importActive = snapshot.operation?.kind === "profile-import", moveActive = snapshot.operation?.kind === "profile-move", cookieActive = snapshot.operation?.kind === "profile-cookies", fileUpdateActive = snapshot.operation?.kind === "profile-file-update", trashActive = snapshot.operation?.kind === "profile-trash", proxyActive = snapshot.operation?.kind === "profile-proxies", profileTaskActive = batchActive || importActive || moveActive || cookieActive || fileUpdateActive || trashActive || proxyActive;
  const busy = snapshot.blocked || pending || !!activity.job && workspaceJobActive(activity.job);
  const render = props.renderIcon;
  const note = cookieActive ? "Cookie import in progress" : moveActive ? "Environment move in progress" : importActive ? "Environment import in progress" : batchActive ? "Environment batch task in progress" : pending ? "Restart required" : snapshot.workspaceJob || activity.job && workspaceJobActive(activity.job) ? "Workspace task in progress" : activity.dirty ? "Unsaved changes" : null;
  const name = current?.name ?? t(loading ? "Loading workspace…" : "Workspace unavailable");
  const actionName = rail ? t("Switch workspace: {name}", { name }) : t("Open workspace switcher");
  const triggerClass = context ? "wm-workspace-trigger is-context" : rail ? "wm-workspace-trigger is-rail" : "sidebar-workspace wm-workspace-trigger";
  function open(intent: WorkspacePageIntent) { setMenuOpen(false); trigger.current?.focus({ preventScroll: true }); props.onOpenManagement?.(intent); }
  useEffect(() => {
    if (!menuOpen || !menu.current) return;
    const checked = rail ? menu.current.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') : null;
    (checked ?? menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
  }, [menuOpen, rail]);
  return <div className={context ? "wm-context-switcher" : rail ? "wm-rail-switcher" : "wm-sidebar-switcher"} data-compact={rail && props.compact ? "true" : undefined}>
    {context && <span className="wm-context-label">{t("Workspaces")}</span>}
    <button type="button" className={`${triggerClass}${props.managementActive ? " is-current-page" : ""}`} ref={trigger} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} aria-describedby={rail && note ? noteId : undefined} title={rail ? actionName : current?.name ?? t("Workspaces")} aria-label={actionName} onClick={() => setMenuOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setMenuOpen(true); } }}>
      <WorkspaceBadge workspace={current} icon={rail ? "folder" : undefined} render={render} /><span className="wm-trigger-copy"><strong>{name}</strong>{(!context || note) && <small>{t(note ?? (rail ? "Switch workspace" : "Independent local workspace"))}</small>}</span><Icon name="chevronDown" render={render} />
    </button>
    {rail && note && <span className="wm-sr-only" id={noteId}>{t(note)}</span>}
    {context && props.onOpenManagement && <button type="button" className={`wm-context-manage${props.managementActive ? " is-current-page" : ""}`} aria-current={props.managementActive ? "page" : undefined} onClick={() => open({ mode: "manage" })}>{t("Manage workspaces")}</button>}
    {typeof document !== "undefined" && createPortal(
      <MotionPresence present={menuOpen} kind="popover">
        <div
          className={`wm-switcher-popover${rail ? " is-rail" : ""}`}
          data-placement={rail ? placement : undefined}
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={t("Workspaces")}
          style={style}
          onKeyDown={event => {
            if (event.key === "Tab") {
              trigger.current?.focus({ preventScroll: true });
              setMenuOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = controls(menu.current!);
            const index = items.indexOf(document.activeElement as HTMLElement);
            const targetIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[targetIndex]?.focus();
          }}
        >
          <div className="wm-popover-heading">{t("Workspaces")}</div>
          {rail && note && <p className="wm-small">{t(note)}</p>}
          {profileTaskActive && (
            <div className="wm-batch-note" role="status">
              <p>{t(workspaceOperationMessage(snapshot))}</p>
              {batchActive && props.onShowBatchTask && (
                <button
                  type="button"
                  className="btn ghost xs"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onShowBatchTask?.();
                  }}
                >
                  {t("View environment task")}
                </button>
              )}
            </div>
          )}
          {loading && !catalog && <p className="wm-small" role="status">{t("Loading workspaces…")}</p>}
          {error && (
            <div className="wm-error" role="alert">
              <span>{t(error)}</span>
              <button type="button" onClick={() => void refresh()}>{t("Retry")}</button>
            </div>
          )}
          {catalog?.workspaces.filter(w => !w.archived).map(w => (
            <button
              type="button"
              key={w.id}
              className="wm-switcher-item"
              role="menuitemradio"
              aria-checked={w.id === catalog.currentId}
              disabled={busy && w.id !== catalog.currentId}
              onClick={() => open({ mode: w.id === catalog.currentId ? "manage" : "switch", workspaceId: w.id })}
            >
              <WorkspaceBadge workspace={w} render={render} />
              <span>
                {w.name}
                <small>{t(w.id === catalog.currentId ? "Current workspace" : "Independent data and browser profiles")}</small>
              </span>
              {w.id === catalog.currentId && <Icon name="check" render={render} />}
            </button>
          ))}
          {catalog && catalog.workspaces.filter(w => !w.archived).length === 0 && (
            <p className="wm-small">{t("No active workspaces.")}</p>
          )}
          <div className="wm-popover-foot">
            <button type="button" role="menuitem" disabled={busy && !profileTaskActive} onClick={() => open({ mode: "create" })}>
              <Icon name="plus" render={render} />{t("New workspace")}
            </button>
            <button type="button" role="menuitem" onClick={() => open({ mode: "manage" })}>
              <Icon name="settings" render={render} />{t("Manage workspaces")}
            </button>
          </div>
        </div>
      </MotionPresence>,
      document.body,
    )}
  </div>;
}

export function WorkspaceActivity({ hidden, onOpen }: { hidden: boolean; onOpen: () => void }) {
  const { t } = useTranslation(); const { catalog, activity } = useWorkspaceCatalog();
  const pending = !!catalog && catalog.currentId !== catalog.activeId;
  const job = activity.job;
  if (hidden || !pending && (!job || job.status === "succeeded")) return null;
  return <div className={`wm-activity${job?.status === "failed" && !pending ? " is-failed" : ""}`} role="status">
    <Icon name={pending ? "refresh" : job?.status === "failed" ? "alert" : "archive"} />
    <div><strong>{t(pending ? "Restart required" : job?.kind === "backup" ? "Backup task" : "Restore task")}</strong><span>{t(pending ? "A workspace switch is prepared. Restart to finish switching." : job?.status === "failed" ? "Failed" : PHASE_LABELS[job?.phase ?? ""] ?? "In progress")}{job && workspaceJobActive(job) && workspaceJobPercent(job) !== null ? ` · ${workspaceJobPercent(job)}%` : ""}</span></div>
    <button type="button" className="btn ghost xs" onClick={onOpen}>{t("View task")}<Icon name="open" /></button>
  </div>;
}

export function WorkspaceManagementPage(props: WorkspaceManagementPageProps) {
  const { t } = useTranslation();
  const { coordinator, snapshot } = useWorkspaceOperations();
  const desktopDrafts = useDesktopCloseDraftSnapshot();
  const readDesktopDrafts = useDesktopCloseDraftReader();
  const { catalog, currentWorkspace: current, loading, error: catalogError, refresh: refreshCatalog, acceptRecord, acceptActiveId, setActivity } = useWorkspaceCatalog();
  const [tab, setTab] = useState<"workspaces" | "backups">("workspaces"), [showArchived, setShowArchived] = useState(false), [search, setSearch] = useState("");
  const [editor, setEditor] = useState(() => createWorkspaceMetadataDraft(current ?? null));
  const [metadataWrite, setMetadataWrite] = useState(false);
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null), [overviewError, setOverviewError] = useState<string | null>(null), [history, setHistory] = useState<WorkspaceBackups>({ backups: [], jobs: [] }), [historyError, setHistoryError] = useState<string | null>(null), [historyLoading, setHistoryLoading] = useState(false);
  const [operation, setOperation] = useState(""), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null), [closeRunning, setCloseRunning] = useState(false);
  const [backupPassword, setBackupPassword] = useState(""), [repeatedPassword, setRepeatedPassword] = useState("");
  const [job, setJobState] = useState<WorkspaceJob | null>(null), [pollError, setPollError] = useState<string | null>(null), [pollVersion, setPollVersion] = useState(0), [retrySource, setRetrySource] = useState<BackupConfirmation | null>(null), [retrySourceJobId, setRetrySourceJobId] = useState<string | null>(null), [pendingRestart, setPendingRestart] = useState<PreparedWorkspaceSwitch | null>(null);
  const latestJob = useRef<WorkspaceJob | null>(null);
  const overviewRevision = useRef(0), historyRevision = useRef(0);
  function setJob(next: WorkspaceJob | null) { latestJob.current = next; setJobState(next); }
  const heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null), confirmPanel = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), handledRequest = useRef<number | null>(null), initialized = useRef(!!current), focusName = useRef(false);
  const operationInFlight = useRef(false);
  const { id: editingId, base, draft } = editor;
  const editing = catalog?.workspaces.find(w => w.id === editingId);
  const dirty = changedWorkspaceFields(base, draft).length > 0;
  const missingEditor = editingId !== null && !!catalog && !editing;
  const latestMetadata = editing ? workspaceMetadata(editing) : null;
  const metadataReview = dirty && latestMetadata ? reviewWorkspaceMetadata(base, draft, latestMetadata) : null;
  const needsReview = !!metadataReview?.changedFields.length;
  const restartDraftLabels = new Set<DesktopDraftLabel>(desktopDrafts.dirty);
  if (dirty) restartDraftLabels.add("workspace-metadata");
  const activeJob = !!job && workspaceJobActive(job), pending = pendingRestart ?? (catalog && catalog.currentId !== catalog.activeId ? { expected: catalog.currentId, target: catalog.activeId } : null);
  const maintenance = activeJob || !!overview?.backupBusy || !!pending;
  const batchActive = snapshot.operation?.kind === "profile-batch", importActive = snapshot.operation?.kind === "profile-import", moveActive = snapshot.operation?.kind === "profile-move", cookieActive = snapshot.operation?.kind === "profile-cookies", fileUpdateActive = snapshot.operation?.kind === "profile-file-update", trashActive = snapshot.operation?.kind === "profile-trash", proxyActive = snapshot.operation?.kind === "profile-proxies", profileTaskActive = batchActive || importActive || moveActive || cookieActive || fileUpdateActive || trashActive || proxyActive, transitionBlocked = snapshot.blocked;
  const restartBlocked = !!snapshot.operation || !!snapshot.workspaceJob || snapshot.nativeUpdateBusy || !snapshot.workspaceId;
  const retryJobSource: BackupConfirmation | null = job?.kind === "backup" ? { kind: "backup" } : retrySourceJobId === job?.id ? retrySource : null;
  useDesktopCloseDraft("workspace-metadata", { dirty, busy: metadataWrite });
  useLayoutEffect(() => { if (editing && !dirty) setEditor(previous => followWorkspaceMetadata(previous, editing)); }, [editing, dirty]);
  useEffect(() => { setActivity({ job, dirty }); }, [job, dirty, setActivity]);
  useEffect(() => { setPendingRestart(catalog && catalog.currentId !== catalog.activeId ? { expected: catalog.currentId, target: catalog.activeId } : null); }, [catalog?.currentId, catalog?.activeId]);
  async function refreshOverview(signal?: AbortSignal) { const revision = ++overviewRevision.current; try { const next = await fetchWorkspaceOverview(signal); if (!signal?.aborted && revision === overviewRevision.current) { setOverview(next); setOverviewError(null); } return next; } catch (e) { if (!signal?.aborted && revision === overviewRevision.current) setOverviewError(errorMessage(e)); return null; } }
  async function refreshHistory(signal?: AbortSignal) { const revision = ++historyRevision.current; setHistoryLoading(true); try { const next = await fetchWorkspaceBackups(signal); if (!signal?.aborted && revision === historyRevision.current) { const resolved = workspaceHistoryJob(next.jobs, latestJob.current); if (resolved && workspaceJobActive(resolved)) coordinator.observeWorkspaceJob(resolved); else { const tracked = coordinator.getSnapshot().workspaceJob; if (tracked?.phase === "running" && resolved?.id === tracked.id) await coordinator.finishWorkspaceJob(tracked.id, () => Promise.all([refreshCatalog(), refreshOverview()])); } if (!signal?.aborted && revision === historyRevision.current) { setHistory(next); setHistoryError(null); setJob(resolved); } } } catch (e) { if (!signal?.aborted && revision === historyRevision.current) setHistoryError(errorMessage(e)); } finally { if (!signal?.aborted && revision === historyRevision.current) setHistoryLoading(false); } }
  useEffect(() => coordinator.registerWorkspaceRefresh(() => Promise.all([refreshOverview(), refreshHistory()])), [coordinator]);
  // Keep this page mounted while navigating: drafts and background job polling survive.
  useEffect(() => { const controller = new AbortController(); void refreshOverview(controller.signal); void refreshHistory(controller.signal); return () => controller.abort(); }, [props.active]);
  useEffect(() => { if (props.active) heading.current?.focus({ preventScroll: true }); }, [props.active]);
  useEffect(() => {
    if (!props.active || !catalog || operation || handledRequest.current === props.request.id) return;
    handledRequest.current = props.request.id;
    const target = catalog.workspaces.find(w => w.id === props.request.workspaceId);
    if (props.request.mode === "switch") {
      if (!initialized.current && !dirty && current) selectEditor(current);
      initialized.current = true;
      if (target) void prepareActivation(target);
      else setError("Workspace unavailable");
      return;
    }
    const action = () => {
      if (props.request.mode === "create") { selectEditor(null); setTab("workspaces"); }
      else if (props.request.mode === "backups") setTab("backups");
      else if (target && target.id !== editingId || !initialized.current && !dirty) { selectEditor(target ?? current ?? null); setTab("workspaces"); }
      initialized.current = true;
    };
    const replacesDraft = props.request.mode === "create" || props.request.mode === "manage" && !!target && target.id !== editingId;
    if (dirty && replacesDraft) discardThen(action); else action();
  }, [props.active, props.request.id, catalog, operation]);
  useEffect(() => {
    if (!job || !workspaceJobActive(job)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    coordinator.observeWorkspaceJob(job);
    const poll = async () => { try { const next = await fetchWorkspaceJob(job.id, controller.signal); if (controller.signal.aborted) return; setPollError(null); if (workspaceJobActive(next)) { setJob(next); timer = setTimeout(poll, 1200); } else { try { await coordinator.finishWorkspaceJob(next.id, () => Promise.all([refreshCatalog(), refreshOverview(), refreshHistory()])); } finally { setJob(next); } } } catch (e) { if (!controller.signal.aborted) setPollError(errorMessage(e)); } };
    timer = setTimeout(poll, 800); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, pollVersion]);
  function selectEditor(workspace: WorkspaceRecord | null) {
    if (!workspace) focusName.current = true;
    setEditor(createWorkspaceMetadataDraft(workspace));
    setError(null);
    setNotice(null);
  }
  function changeDraft(patch: Partial<WorkspaceMetadata>) {
    setEditor(previous => ({ ...previous, draft: { ...previous.draft, ...patch } }));
  }
  function reviewMetadata(keepEdits: boolean) {
    if (!latestMetadata || !metadataReview || operationInFlight.current) return;
    setEditor({ id: editingId, base: latestMetadata, draft: keepEdits ? metadataReview.rebased : latestMetadata });
    setError(null);
    setNotice(null);
    focusName.current = true;
  }
  function discardThen(action: () => void) { if (dirty) setConfirmation({ kind: "discard", action }); else action(); }
  useLayoutEffect(() => {
    if (props.active && tab === "workspaces" && focusName.current && nameInput.current) {
      focusName.current = false;
      nameInput.current.focus({ preventScroll: true });
    }
  }, [props.active, tab, editor]);
  function newWorkspace() { discardThen(() => { selectEditor(null); setTab("workspaces"); }); }
  function changeTab(next: "workspaces" | "backups") { setTab(next); }
  function clearBackupPassword() { setBackupPassword(""); setRepeatedPassword(""); }
  function showBackupConfirmation(next: BackupConfirmation) {
    clearBackupPassword(); setError(null); setConfirmation(next);
  }
  function closeConfirmation() {
    if (operationInFlight.current) return;
    clearBackupPassword();
    setConfirmation(null);
    setCloseRunning(false);
  }
  useDialogFocus(confirmPanel, props.active && !!confirmation, closeConfirmation);
  useEffect(() => { if (!props.active) clearBackupPassword(); }, [props.active]);
  async function perform(name: string, action: () => Promise<void>, kind?: WorkspaceOperationKind) {
    if (operationInFlight.current) return;
    const guarded = kind ?? (name === "activate" ? "workspace-switch" : name === "restart" ? "app-restart" : null);
    const lease = guarded
      ? coordinator.acquire(guarded, undefined, name === "restart" ? { allowPreparedRestart: true } : undefined)
      : null;
    if (guarded && !lease) {
      setError(workspaceOperationMessage(coordinator.getSnapshot()));
      return;
    }
    operationInFlight.current = true;
    setOperation(name);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      if (lease) coordinator.setPhase(lease, "refreshing");
      if (name === "activate" || name === "cancel") {
        await refreshCatalog();
        if (name === "activate") {
          const fresh = await refreshOverview();
          setConfirmation(old => (old?.kind === "activate" ? { ...old, overview: fresh } : old));
        }
      }
      if (name === "job") await Promise.all([refreshOverview(), refreshHistory()]);
    } finally {
      if (lease) coordinator.release(lease);
      operationInFlight.current = false;
      setOperation("");
    }
  }
  async function saveMetadata() {
    if (operationInFlight.current || maintenance || missingEditor || needsReview || !draft.name.trim() || editingId && !dirty) return;
    const value = { ...draft, name: draft.name.trim() };
    const patch = workspaceMetadataPatch(base, value);
    if (editing && !Object.keys(patch).length) { selectEditor(editing); return; }
    await perform("save", async () => {
      setMetadataWrite(true);
      try {
        const saved = editingId ? await updateWorkspace(editingId, patch) : await createWorkspace(value);
        acceptRecord(saved);
        selectEditor(saved);
      } finally { setMetadataWrite(false); }
      const next = await refreshCatalog();
      setNotice("Workspace saved.");
      if (!next) setError("Workspace saved, but the workspace list could not refresh.");
    });
  }
  async function archiveRecord(workspace: WorkspaceRecord) {
    await perform("archive", async () => {
      setMetadataWrite(true);
      try {
        const archived = await archiveWorkspace(workspace.id, !workspace.archived);
        acceptRecord(archived);
        selectEditor(archived);
      } finally { setMetadataWrite(false); }
      await refreshCatalog();
      setNotice(workspace.archived ? "Workspace unarchived." : "Workspace archived.");
    });
  }
  async function prepareActivation(target: WorkspaceRecord) {
    const expected = catalog?.currentId, currentSnapshot = coordinator.getSnapshot();
    if (!expected || operationInFlight.current || target.id === expected || target.archived) return;
    if (currentSnapshot.blocked) { setError(workspaceOperationMessage(currentSnapshot)); return; }
    setError(null);
    setOverviewError(null);
    setCloseRunning(false);
    const intent = { kind: "activate", expected, target, overview: null } as const;
    setConfirmation(intent);
    const fresh = await refreshOverview();
    setConfirmation(old => old === intent ? { ...intent, overview: fresh } : old);
  }
  async function commitActivation() {
    if (confirmation?.kind !== "activate" || !catalog || !confirmation.overview || !restartDraftsReviewed()) return;
    const { expected, overview: activationOverview } = confirmation;
    const target = catalog.workspaces.find(workspace => workspace.id === confirmation.target.id);
    if (expected !== catalog.currentId || activationOverview.workspaceId !== expected || !target || target.archived) { setError("Workspace unavailable"); return; }
    if (activationOverview.backupBusy || ((activationOverview.runningCount > 0 || activationOverview.scriptRunning) && !closeRunning)) return;
    await perform("activate", async () => {
      if (!workspaceDesktopAvailable()) throw new Error("Open this action in the desktop app.");
      await activateWorkspace(target.id, closeRunning);
      acceptActiveId(target.id);
      setPendingRestart({ expected, target: target.id });
      await refreshCatalog();
      try {
        await restartWorkspace(expected, target.id);
      } catch (failure) {
        try {
          await cancelActivation();
          acceptActiveId(expected);
          setPendingRestart(null);
          await refreshCatalog();
        } catch {
          throw new Error("Restart and rollback failed. Retry the desktop restart.");
        }
        throw failure;
      }
      setConfirmation(null);
      setNotice("Restart requested. Waiting for the desktop app…");
    });
  }
  function restartDraftsReviewed() {
    const latest = readDesktopDrafts();
    return latest.busy.length === 0 && latest.revision === desktopDrafts.revision;
  }
  async function retryRestart() {
    if (confirmation?.kind !== "restart" || !pending || !restartDraftsReviewed()) return;
    const expectedSwitch = confirmation.pending;
    if (pending.expected !== expectedSwitch.expected || pending.target !== expectedSwitch.target) { setError("Workspace unavailable"); return; }
    await perform("restart", async () => {
      await restartWorkspace(expectedSwitch.expected, expectedSwitch.target);
      setConfirmation(null);
      setNotice("Restart requested. Waiting for the desktop app…");
    });
  }
  async function beginJob(source: BackupConfirmation) {
    const password = backupPassword || undefined;
    await perform("job", async () => {
      setPollError(null); setRetrySource(source); setRetrySourceJobId(null);
      const next = source.kind === "backup" ? await startWorkspaceBackup(password) : await restoreWorkspace(source.source, password);
      coordinator.observeWorkspaceJob(next); setRetrySourceJobId(next.id); setJob(next); clearBackupPassword(); setConfirmation(null);
      if (!workspaceJobActive(next)) await coordinator.finishWorkspaceJob(next.id, () => Promise.all([refreshCatalog(), refreshOverview(), refreshHistory()]));
    }, source.kind === "backup" ? "workspace-backup" : "workspace-restore");
  }
  function confirmAction() {
    if (!confirmation || confirmationDisabled || operationInFlight.current) return;
    if (confirmation.kind === "activate") void commitActivation();
    else if (confirmation.kind === "restart") void retryRestart();
    else if (confirmation.kind === "backup" || confirmation.kind === "restore") void beginJob(confirmation);
    else {
      setEditor(createWorkspaceMetadataDraft(editing ?? null));
      closeConfirmation();
      confirmation.action();
    }
  }
  async function location(kind: "data" | "backups") { await perform("location", () => openWorkspaceLocation(kind)); }
  const restoredWorkspace = job?.status === "succeeded" && job.kind === "restore" ? catalog?.workspaces.find(w => w.id === job.result?.workspaceId) : undefined;
  const render = props.renderIcon;
  const restartReview = confirmation?.kind === "activate" || confirmation?.kind === "restart";
  const restartingTarget = confirmation?.kind === "restart" ? catalog?.workspaces.find(workspace => workspace.id === confirmation.pending.target) : null;
  const restartDraftBusy = restartReview && desktopDrafts.busy.length > 0;
  const activationNeedsConsent = confirmation?.kind === "activate" && !!(confirmation.overview && (confirmation.overview.runningCount > 0 || confirmation.overview.scriptRunning));
  const passwordValid = Array.from(backupPassword).length >= 10 && new TextEncoder().encode(backupPassword).length <= 1024;
  const passwordMismatch = !!repeatedPassword && repeatedPassword !== backupPassword;
  const restorePasswordRequired = confirmation?.kind === "restore" && confirmation.encrypted === true;
  const backupBlocked = !!operation || maintenance || transitionBlocked || !overview || overview.runningCount > 0 || overview.scriptRunning;
  const confirmationDisabled = !!operation || restartDraftBusy
    || confirmation?.kind === "backup" && (backupBlocked || !passwordValid || repeatedPassword !== backupPassword)
    || confirmation?.kind === "restore" && (maintenance || transitionBlocked || (restorePasswordRequired || !!backupPassword) && !passwordValid)
    || confirmation?.kind === "activate" && (transitionBlocked || !workspaceDesktopAvailable() || !confirmation.overview || confirmation.overview.backupBusy || activationNeedsConsent && !closeRunning)
    || confirmation?.kind === "restart" && (restartBlocked || !workspaceDesktopAvailable() || !pending || pending.expected !== confirmation.pending.expected || pending.target !== confirmation.pending.target);
  const savingDisabled = !!operation || maintenance || missingEditor || needsReview || !draft.name.trim() || editingId !== null && !dirty;
  const visibleWorkspaces = catalog?.workspaces.filter(w => (showArchived || !w.archived) && w.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <>
    <section className="workspace wm-page" hidden={!props.active} aria-labelledby="wm-page-title">
      <div className="wm-page-inner">
        <header className="page-heading wm-page-heading"><div><h1 id="wm-page-title" ref={heading} tabIndex={-1}>{t("Workspace management")}</h1><p>{t("A dedicated space for every project.")}</p></div><div className="page-actions"><button type="button" className="btn ghost" onClick={props.onBack}><Icon name="back" render={render} />{t("Back to environments")}</button><button type="button" className="btn primary" disabled={!!operation || maintenance} onClick={newWorkspace}><Icon name="plus" render={render} />{t("New workspace")}</button></div></header>
        <div className="wm-current-summary"><div className="wm-current-identity"><WorkspaceBadge workspace={current} render={render} /><div><small>{t("Current workspace")}</small><strong>{current?.name ?? t("Loading workspace…")}</strong></div><span className="wm-status-pill">{t("Local workspace")}</span></div><div className="wm-summary-metrics"><div><strong>{overview?.profileCount ?? "—"}</strong><span>{t("Environments")}</span></div><button type="button" disabled={!overview} onClick={props.onShowRunning}><strong>{overview?.runningCount ?? "—"}</strong><span><i className="wm-running-dot" />{t("Running environments")}</span></button><div><strong>{bytes(overview?.bytes ?? null)}</strong><span>{t("Workspace storage")}</span></div><div><strong>{historyError || historyLoading && !history.backups.length ? "—" : history.backups.length}</strong><span>{t("Backup history")}</span></div></div></div>
        <nav className="wm-page-tabs" role="tablist" aria-label={t("Workspace sections")} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? "workspaces" : event.key === "End" ? "backups" : tab === "workspaces" ? "backups" : "workspaces"; changeTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#wm-tab-${next}`)?.focus(); }}><button id="wm-tab-workspaces" type="button" role="tab" aria-selected={tab === "workspaces"} aria-controls="wm-panel-workspaces" tabIndex={tab === "workspaces" ? 0 : -1} onClick={() => changeTab("workspaces")}><Icon name="layers" render={render} />{t("Workspaces")}<span>{catalog?.workspaces.filter(w => !w.archived).length ?? 0}</span></button><button id="wm-tab-backups" type="button" role="tab" aria-selected={tab === "backups"} aria-controls="wm-panel-backups" tabIndex={tab === "backups" ? 0 : -1} onClick={() => changeTab("backups")}><Icon name="archive" render={render} />{t("Backup and restore")}</button>{dirty && <span className="wm-draft-indicator">{t("Unsaved changes")}</span>}</nav>
        <div className="wm-page-body">
          {error && !confirmation && <div className="wm-error" role="alert">{t(error)}</div>}{notice && <div className="wm-success" role="status"><Icon name="check" render={render} />{t(notice)}</div>}
          {(profileTaskActive || snapshot.nativeUpdateBusy) && <div className="wm-callout wm-batch-callout" role="status"><Icon name="layers" render={render} /><div><strong>{t(proxyActive ? "Proxy assignment in progress" : trashActive ? "Recycle bin operation in progress" : fileUpdateActive ? "File update in progress" : cookieActive ? "Cookie import in progress" : moveActive ? "Environment move in progress" : importActive ? "Environment import in progress" : batchActive ? "Environment batch task in progress" : "App update in progress")}</strong><p>{t(workspaceOperationMessage(snapshot))}</p><small>{t("You can keep browsing and editing workspace details.")}</small></div>{batchActive && props.onShowBatchTask && <button type="button" className="btn ghost xs" onClick={props.onShowBatchTask}>{t("View environment task")}</button>}</div>}
          {pending && <div className="wm-callout wm-pending"><Icon name="refresh" render={render} /><div><strong>{current?.name} → {catalog?.workspaces.find(w => w.id === pending.target)?.name ?? t("Workspace unavailable")}</strong><p>{t("A workspace switch is prepared. Restart to finish switching.")}</p></div><button type="button" className="btn" disabled={!!operation || restartBlocked || !workspaceDesktopAvailable()} onClick={() => { setError(null); setConfirmation({ kind: "restart", pending }); }}>{t("Retry restart")}</button><button type="button" className="btn ghost" disabled={!!operation} onClick={() => void perform("cancel", async () => { await cancelActivation(); if (catalog) acceptActiveId(catalog.currentId); setPendingRestart(null); setError(null); await refreshCatalog(); setNotice("Workspace switch cancelled."); })}>{t("Cancel workspace switch")}</button>{!workspaceDesktopAvailable() && <small>{t("Switching workspaces requires the desktop app.")}</small>}</div>}
          {maintenance && !pending && tab === "workspaces" && <div className="wm-callout"><Icon name="archive" render={render} /><span>{t("Wait for the workspace backup or restore task to finish before making changes.")}</span><button type="button" className="btn ghost xs" onClick={() => changeTab("backups")}>{t("View task")}</button></div>}
          <div id="wm-panel-workspaces" role="tabpanel" aria-labelledby="wm-tab-workspaces" hidden={tab !== "workspaces"} className="wm-workspaces-layout">
            <aside className="wm-catalog wm-card"><div className="wm-card-heading"><h2>{t("Your workspaces")}</h2><span className="wm-count">{visibleWorkspaces.length}</span></div><label className="wm-search"><Icon name="search" render={render} /><input type="search" aria-label={t("Search workspaces")} placeholder={t("Search workspaces")} value={search} onChange={event => setSearch(event.target.value)} /></label><label className="wm-check wm-archive-filter"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t("Show archived")}</label>
              {catalogError && <div className="wm-error" role="alert">{t(catalogError)}<button type="button" onClick={() => void refreshCatalog()}>{t("Retry")}</button></div>}{loading && !catalog && <p className="wm-small" role="status">{t("Loading workspaces…")}</p>}
              <div className="wm-catalog-list">{visibleWorkspaces.map(w => <button type="button" className={`wm-catalog-item${editingId === w.id ? " active" : ""}`} key={w.id} aria-pressed={editingId === w.id} disabled={!!operation} onClick={() => discardThen(() => selectEditor(w))}><WorkspaceBadge workspace={w} render={render} /><span><strong>{w.name}</strong><small>{t(w.archived ? "Archived" : w.id === catalog?.currentId ? "Current workspace" : "Local workspace")}</small></span>{w.id === catalog?.currentId && <span className="wm-current-dot" aria-hidden="true" />}</button>)}</div>
              {!loading && !catalogError && !visibleWorkspaces.length && <div className="wm-empty wm-search-empty"><Icon name="search" render={render} /><strong>{t("No matching workspaces.")}</strong><p>{t("Try another name, or show archived workspaces.")}</p><button type="button" className="btn ghost xs" onClick={() => { setSearch(""); setShowArchived(true); }}>{t("Reset filters")}</button></div>}
              <div className="wm-catalog-foot"><Icon name="drive" render={render} /><span>{t("Workspace data stays on this computer.")}</span></div>
            </aside>
            <div className="wm-editor">
              <section className="wm-card wm-identity-card"><form onSubmit={event => { event.preventDefault(); void saveMetadata(); }}><div className="wm-editor-title"><WorkspaceBadge workspace={draft} render={render} /><div><h2>{editingId ? draft.name.trim() || base.name : t("Create a workspace")}</h2><p>{t(editingId ? "Workspace details" : "Choose a name and a visual identity for this workspace.")}</p></div>{editing && <span className="wm-status-pill">{t(editing.archived ? "Archived" : editing.id === catalog?.currentId ? "Current workspace" : "Local workspace")}</span>}</div>
                <label className="fld"><span>{t("Workspace name")}</span><input ref={nameInput} value={draft.name} maxLength={40} disabled={!!operation} required placeholder={t("For example: Client A or Personal projects")} onChange={event => changeDraft({ name: event.target.value })} /></label>
                <div className="wm-identity-options"><fieldset className="wm-choice-field"><legend>{t("Workspace icon")}</legend><div className="wm-icon-choices">{WORKSPACE_ICONS.map(icon => <button type="button" key={icon} disabled={!!operation} aria-pressed={draft.icon === icon} aria-label={t(ICON_LABELS[icon])} onClick={() => changeDraft({ icon })}><Icon name={icon} render={render} /></button>)}</div></fieldset><fieldset className="wm-choice-field"><legend>{t("Workspace color")}</legend><div className="wm-color-choices">{WORKSPACE_COLORS.map(color => <button type="button" key={color} style={{ backgroundColor: color }} disabled={!!operation} aria-pressed={draft.color === color} aria-label={t(COLOR_LABELS[color] ?? "Purple")} onClick={() => changeDraft({ color })}>{draft.color === color && <Icon name="check" render={render} />}</button>)}</div></fieldset></div>
                {missingEditor && <div className="wm-warning" role="status">{t("The workspace is unavailable. Choose another workspace to continue.")}</div>}
                {metadataReview && latestMetadata && needsReview && <section className="wm-metadata-review" aria-labelledby="wm-metadata-review-title">
                  <div role="status"><h3 id="wm-metadata-review-title">{t("Workspace details changed")}</h3><p>{t("Review the saved details before saving your draft.")}</p></div>
                  <dl>{metadataReview.changedFields.map(field => <div key={field}>
                    <dt>{t(METADATA_LABELS[field])}</dt>
                    <dd>{field === "name" ? latestMetadata.name : field === "icon" ? t(ICON_LABELS[latestMetadata.icon]) : t(COLOR_LABELS[latestMetadata.color] ?? "Purple")}</dd>
                    {metadataReview.conflicts.includes(field) && <dd className="wm-metadata-conflict">{t("This field also changed in your draft.")}</dd>}
                  </div>)}</dl>
                  <div className="wm-metadata-review-actions"><button type="button" className="btn ghost" disabled={!!operation} onClick={() => reviewMetadata(false)}>{t("Use saved details")}</button><button type="button" className="btn" disabled={!!operation} onClick={() => reviewMetadata(true)}>{t("Keep my edits")}</button></div>
                </section>}
                <div className="wm-form-actions"><span className="wm-save-hint">{t(dirty ? "Your draft is kept when you leave this page." : "Each workspace has separate environments, groups, scripts, and extensions.")}</span>{dirty && !needsReview && !missingEditor && <button type="button" className="btn ghost" disabled={!!operation} onClick={() => { selectEditor(editing ?? null); focusName.current = true; }}>{t("Reset changes")}</button>}<button type="submit" className="btn primary" disabled={savingDisabled}>{t(operation === "save" ? "Saving…" : editingId ? "Save changes" : "Create workspace")}</button></div>
              </form></section>
              {editing && <><section className="wm-card wm-data-card"><div className="wm-card-heading"><h2>{t(editing.id === catalog?.currentId ? "Current workspace data" : "Independent local workspace")}</h2>{editing.id !== catalog?.currentId && !editing.archived && <button type="button" className="btn" disabled={!!operation || maintenance || transitionBlocked} onClick={() => void prepareActivation(editing)}><Icon name="open" render={render} />{t("Switch to this workspace")}</button>}</div>
                <div className="wm-record-meta"><span><small>{t("Created")}</small><strong>{date(editing.createdAt)}</strong></span><span><small>{t("Last opened")}</small><strong>{date(editing.lastOpenedAt)}</strong></span></div>
                {editing.id === catalog?.currentId ? <>{overviewError && <div className="wm-error" role="alert">{t(overviewError)}<button type="button" onClick={() => void refreshOverview()}>{t("Retry")}</button></div>}{!overview && !overviewError && <p className="wm-small" role="status">{t("Calculating storage…")}</p>}{overview && <><div className="wm-storage-row"><div><span>{t("In Trash")}</span><strong>{overview.trashCount}</strong></div><div><span>{t("Disk space available")}</span><strong>{bytes(overview.freeBytes)}</strong></div></div><div className="wm-folder-row"><div><Icon name="folder" render={render} /><span className="wm-path" title={overview.root}>{overview.root}</span></div><button type="button" className="btn xs" onClick={() => void location("data")} disabled={!!operation}>{t("Open data folder")}<Icon name="open" render={render} /></button></div></>}</> : <p className="wm-card-description">{t("Each workspace has separate environments, groups, scripts, and extensions.")}</p>}
              </section><section className="wm-card wm-archive-control"><div><h3>{t(editing.archived ? "Unarchive workspace" : "Archive workspace")}</h3><p>{t(editing.id === "default" ? "The initial workspace preserves existing data and cannot be archived." : editing.id === catalog?.currentId ? "Switch to another workspace before archiving this one." : "Archiving keeps all workspace data. You can unarchive it later.")}</p></div><button type="button" className="btn" disabled={!!operation || maintenance || editing.id === "default" || editing.id === catalog?.currentId || editing.id === catalog?.activeId} onClick={() => discardThen(() => void archiveRecord(editing))}><Icon name="archive" render={render} />{t(editing.archived ? "Unarchive workspace" : "Archive workspace")}</button></section></>}
            </div>
          </div>
          <div id="wm-panel-backups" role="tabpanel" aria-labelledby="wm-tab-backups" hidden={tab !== "backups"} className="wm-backup-layout">
            <div className="wm-backup-main"><div className="wm-backup-action-grid">
              <section className="wm-card wm-backup-action"><span className="wm-action-icon"><Icon name="download" render={render} /></span><h2>{t("Backup your workspace")}</h2><p>{t("Create an encrypted copy of your current workspace.")}</p><button type="button" className="btn primary" disabled={backupBlocked} onClick={() => showBackupConfirmation({ kind: "backup" })}>{t("Create full backup")}</button></section>
              <section className="wm-card wm-backup-action"><span className="wm-action-icon is-restore"><Icon name="upload" render={render} /></span><h2>{t("Restore a workspace")}</h2><p>{t("Import a backup into a new, independent workspace.")}</p><button type="button" className="btn" disabled={!!operation || maintenance || transitionBlocked} onClick={() => { setError(null); fileInput.current?.click(); }}>{t("Restore from file")}</button><input ref={fileInput} type="file" accept=".mqbackup,application/octet-stream" hidden onChange={event => { const file = event.target.files?.[0]; if (file) showBackupConfirmation({ kind: "restore", source: file, name: file.name }); event.target.value = ""; }} /></section>
            </div>
              {overviewError && <div className="wm-error">{t(overviewError)}<button type="button" onClick={() => void refreshOverview()}>{t("Retry")}</button></div>}{overview && (overview.runningCount > 0 || overview.scriptRunning) && <div className="wm-callout"><Icon name="alert" render={render} /><span>{t("Stop running browsers and scripts before creating a full backup.")}</span><button type="button" className="btn ghost xs" onClick={props.onShowRunning}>{t("View running environments")}</button></div>}
              {job && <section className={`wm-job wm-job-${job.status}`} aria-live="polite"><div className="wm-job-heading"><strong>{t(job.kind === "backup" ? "Backup task" : "Restore task")}</strong><span>{t(job.status === "succeeded" ? "Completed" : job.status === "failed" ? "Failed" : job.status === "queued" ? "Waiting to start" : "In progress")}</span></div>{workspaceJobActive(job) && <><p>{t(PHASE_LABELS[job.phase] ?? "In progress")}</p>{workspaceJobPercent(job) === null ? <progress max={100} aria-label={t("Workspace task progress")} /> : <progress max={100} value={workspaceJobPercent(job)!} aria-label={t("Workspace task progress")} />}<small>{workspaceJobPercent(job) === null ? t("Preparing…") : `${workspaceJobPercent(job)}%`}</small></>}{job.status === "failed" && <><p>{t(job.error ?? "Workspace request failed.")}</p>{retryJobSource && <button type="button" className="btn" disabled={!!operation || transitionBlocked} onClick={() => showBackupConfirmation(retryJobSource)}>{t("Retry task")}</button>}{!retryJobSource && <p>{t("Choose the backup file again to retry restoration.")}</p>}</>}{job.status === "succeeded" && <p>{t(job.kind === "restore" ? "Restored as a new workspace. Your current workspace was not changed." : "Backup created and verified.")}</p>}{restoredWorkspace && <button type="button" className="btn" onClick={() => discardThen(() => { selectEditor(restoredWorkspace); setTab("workspaces"); })}>{t("View restored workspace")}</button>}{pollError && <div className="wm-error">{t(pollError)}<button type="button" onClick={() => { setPollError(null); setPollVersion(value => value + 1); }}>{t("Retry status check")}</button></div>}</section>}
              <section className="wm-card wm-history-card"><div className="wm-history-heading"><div><h2>{t("Backup history")}</h2><span className="wm-count">{history.backups.length}</span></div><button type="button" className="btn ghost xs" disabled={historyLoading} onClick={() => void refreshHistory()}><Icon name="refresh" render={render} />{t("Refresh")}</button></div>{historyError && <div className="wm-error" role="alert">{t(historyError)}<button type="button" onClick={() => void refreshHistory()}>{t("Retry")}</button></div>}{historyLoading && !history.backups.length && <p className="wm-small" role="status">{t("Loading backup history…")}</p>}{!historyLoading && !historyError && !history.backups.length && <div className="wm-empty"><span className="wm-empty-tile"><Icon name="archive" render={render} /></span><strong>{t("No backups yet")}</strong><p>{t("Create a full backup to keep a recoverable copy of this workspace.")}</p></div>}
                <div className="wm-backup-history">{history.backups.map(backup => <article className="wm-backup-row" key={backup.id}><span className="wm-backup-file-icon"><Icon name="archive" render={render} /></span><div><strong>{backup.name}</strong><small>{date(backup.createdAt)} · {bytes(backup.bytes)} · {t("{count} environments", { count: backup.profileCount })} · {t(backup.encrypted ? "Encrypted backup" : "Unencrypted backup")}</small></div><div className="wm-backup-row-actions"><button type="button" className="btn xs" disabled={!!operation} onClick={() => void perform("download", async () => { const result = await downloadWorkspaceBackup(backup.id); setNotice(result === "saved" ? "Backup saved." : result === "cancelled" ? "Save cancelled." : "Download requested."); })}><Icon name="download" render={render} />{t("Download")}</button><button type="button" className="btn xs" disabled={!!operation || maintenance || transitionBlocked} onClick={() => showBackupConfirmation({ kind: "restore", source: { backupId: backup.id }, name: backup.name, encrypted: backup.encrypted === true })}>{t("Restore as new")}</button></div></article>)}</div>
              </section>
            </div><aside className="wm-card wm-backup-guide"><WorkspaceBackupIntro renderIcon={render} /><button type="button" className="btn ghost" disabled={!!operation} onClick={() => void location("backups")}><Icon name="folder" render={render} />{t("Open backup folder")}<Icon name="open" render={render} /></button></aside>
          </div>
        </div>
      </div>
    </section>
    {typeof document !== "undefined" && createPortal(<MotionPresence present={props.active && !!confirmation}>{() => confirmation && <div className="wm-confirm-backdrop">
      <section className="wm-confirm" ref={confirmPanel} role="dialog" aria-modal="true" aria-labelledby="wm-confirm-title" tabIndex={-1}>
        <h2 id="wm-confirm-title">{t(confirmation.kind === "backup" ? "Create encrypted backup" : confirmation.kind === "discard" ? "Discard unsaved changes?" : confirmation.kind === "restore" ? "Restore as a new workspace?" : confirmation.kind === "restart" ? "Restart the desktop app?" : "Switch workspace?")}</h2>
        {confirmation.kind === "discard" && <p>{t("Your workspace changes have not been saved.")}</p>}
        {confirmation.kind === "restore" && <><p className="wm-confirm-filename">{confirmation.name}</p><p>{t("This creates a separate workspace. Your current workspace and its data stay intact.")}</p><p className="wm-small">{t("System protection may require you to sign in again after restoring on another computer.")}</p></>}
        {confirmation.kind === "restore" && confirmation.encrypted === false && <p className="wm-small wm-backup-security">{t("Backups contain login and account data and are not password-encrypted. Keep backup files safe.")}</p>}
        {(confirmation.kind === "backup" || confirmation.kind === "restore" && confirmation.encrypted !== false) && <div className="wm-backup-password" onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); confirmAction(); } }}>
          <label className="fld"><span>{t("Backup password")}</span><input type="password" autoComplete={confirmation.kind === "backup" ? "new-password" : "off"} maxLength={1024} value={backupPassword} onChange={event => setBackupPassword(event.target.value)} aria-describedby="wm-backup-password-hint" disabled={!!operation} /></label>
          {confirmation.kind === "backup" && <label className="fld"><span>{t("Confirm backup password")}</span><input type="password" autoComplete="new-password" maxLength={1024} value={repeatedPassword} onChange={event => setRepeatedPassword(event.target.value)} aria-invalid={passwordMismatch || undefined} disabled={!!operation} /></label>}
          <p id="wm-backup-password-hint" className="wm-small">{t(backupPassword && !passwordValid ? "Backup password must contain at least 10 characters and at most 1024 UTF-8 bytes." : confirmation.kind === "backup" ? "Use at least 10 characters. Keep your password somewhere safe." : restorePasswordRequired ? "Enter the password for this encrypted backup." : "Enter the password if this backup is encrypted.")}</p>
          {passwordMismatch && <p className="wm-small" role="status">{t("Backup passwords do not match.")}</p>}
        </div>}
        {confirmation.kind === "restart" && <p>{t("Restart to finish switching to {name}.", { name: restartingTarget?.name ?? t("Workspace unavailable") })}</p>}
        {confirmation.kind === "activate" && <>
          <p>{t("Switch to {name} and restart the desktop app.", { name: confirmation.target.name })}</p>
          {!confirmation.overview && !overviewError && <p role="status">{t("Checking running environments…")}</p>}
          {overviewError && <div className="wm-error">{t(overviewError)}<button type="button" onClick={() => void prepareActivation(confirmation.target)}>{t("Retry")}</button></div>}
          {confirmation.overview && <>
            <p>{t("{count} browser(s) are running in the current workspace.", { count: confirmation.overview.runningCount })}</p>
            {confirmation.overview.scriptRunning && <p>{t("One or more scripts are running.")}</p>}
            {activationNeedsConsent && <label className="wm-check wm-switch-consent"><input type="checkbox" checked={closeRunning} onChange={event => setCloseRunning(event.target.checked)} />{t("Close running browsers and stop scripts before switching.")}</label>}
            {confirmation.overview.backupBusy && <p className="wm-warning">{t("Wait for the workspace backup or restore task to finish before switching.")}</p>}
          </>}
          {!workspaceDesktopAvailable() && <p className="wm-warning">{t("Switching workspaces requires the desktop app.")}</p>}
        </>}
        {restartReview && restartDraftLabels.size > 0 && <div className="wm-restart-drafts wm-warning" role="status">
          <p>{t("Restarting the app clears these unsaved drafts.")}</p>
          <ul>{[...restartDraftLabels].map(label => <li key={label}>{t(DESKTOP_DRAFT_LABELS[label])}</li>)}</ul>
        </div>}
        {restartDraftBusy && !operation && <p className="wm-warning" role="status">{t("Wait for the current changes to finish before restarting.")}</p>}
        {profileTaskActive && confirmation.kind !== "discard" && <p className="wm-warning" role="status">{t(workspaceOperationMessage(snapshot))}</p>}
        {error && <div className="wm-error" role="alert">{t(error)}</div>}
        <div className="wm-confirm-actions">
          <button type="button" className="btn" disabled={!!operation} onClick={closeConfirmation}>{t(confirmation.kind === "discard" ? "Keep editing" : "Cancel")}</button>
          <button type="button" className="btn primary" disabled={confirmationDisabled} onClick={confirmAction}>{t(operation ? "Working…" : confirmation.kind === "backup" ? "Create encrypted backup" : confirmation.kind === "discard" ? "Discard changes" : confirmation.kind === "restore" ? "Restore as new workspace" : confirmation.kind === "restart" ? "Restart desktop app" : "Switch and restart")}</button>
        </div>
      </section>
    </div>}</MotionPresence>, document.body)}
  </>;
}

export function DevicePanel(props: DevicePanelProps) {
  const { t } = useTranslation(); const [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const { currentName } = useWorkspaceCatalog();
  const connecting = props.connectionLoading === true;
  const connectionText = connecting ? "Connecting to the local service…" : props.connection ? "Local service connected" : "Connection interrupted";
  const connectionClass = `wm-connection-dot${connecting ? " connecting" : props.connection ? " connected" : ""}`;
  const variant = props.variant ?? "sidebar", panelId = useId(), statusId = useId(), headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const openRef = useRef(open), actionInFlight = useRef(false); openRef.current = open;
  function focusVisibleDeviceEntry() {
    const active = document.activeElement;
    if (active !== document.body && active !== trigger.current && !panel.current?.contains(active)) return;
    const visible = [...document.querySelectorAll<HTMLButtonElement>(".wm-device-trigger")].find(entry => entry !== trigger.current && entry.getClientRects().length > 0 && getComputedStyle(entry).visibility !== "hidden");
    visible?.focus({ preventScroll: true });
  }
  const { style: position } = usePopover(
    open,
    trigger,
    panel,
    () => setOpen(false),
    variant === "rail" ? "right" : variant === "header" ? "bottom-end" : "top",
    focusVisibleDeviceEntry,
  );
  useEffect(() => { const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== panelId) setOpen(false); }; window.addEventListener("maobu:device-panel-open", otherOpened); return () => window.removeEventListener("maobu:device-panel-open", otherOpened); }, [panelId]);
  useDialogFocus(panel, open, () => setOpen(false)); const render = props.renderIcon;
  function togglePanel() { const next = !open; if (next) window.dispatchEvent(new CustomEvent("maobu:device-panel-open", { detail: panelId })); setOpen(next); }
  async function action(run: () => void | Promise<void>) { if (!openRef.current || actionInFlight.current) return; actionInFlight.current = true; setBusy(true); setError(null); try { await run(); } catch (e) { setError(errorMessage(e)); } finally { actionInFlight.current = false; setBusy(false); } }
  function navigate(run: () => void) { if (!openRef.current) return; trigger.current?.focus({ preventScroll: true }); setOpen(false); run(); }
  return <><button type="button" className={`wm-device-trigger is-${variant}${variant === "sidebar" ? " sidebar-identity" : ""}`} ref={trigger} title={variant === "sidebar" ? currentName || t("This device") : `${t("This device")} · ${t(connectionText)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-describedby={statusId} aria-label={t("Open device panel")} onClick={togglePanel}><span className={variant === "sidebar" ? "sidebar-avatar" : "wm-device-icon"}><Icon name="laptop" render={render} /></span>{variant === "sidebar" ? <span className="wm-trigger-copy"><strong>{currentName || t("This device")}</strong><small id={statusId}>{t(connectionText)}</small></span> : <><span className="wm-device-label">{t("This device")}</span><span className="wm-sr-only" id={statusId}>{t(connectionText)}</span></>}<span className={connectionClass} aria-hidden="true" /></button>
    {typeof document !== "undefined" && createPortal(<MotionPresence present={open} kind="popover"><section className={`wm-device-popover${variant === "rail" ? " is-rail" : ""}`} id={panelId} ref={panel} role="dialog" aria-labelledby={headingId} tabIndex={-1} style={position}><header><div><h2 id={headingId}>{t("This device")}</h2><small>{t("Local runtime and quick preferences")}</small></div><button type="button" className="iconbtn" aria-label={t("Close device panel")} onClick={() => setOpen(false)}><Icon name="close" render={render} /></button></header>{error && <div className="wm-error" role="alert">{t(error)}</div>}
      <div className="wm-device-status" role="status" aria-live="polite" aria-busy={connecting}><span className={connectionClass} /><span>{t(connectionText)}</span>{props.onRetryConnection && !props.connection && !connecting && <button type="button" className="btn xs" disabled={busy} onClick={() => void action(props.onRetryConnection!)}>{t("Retry")}</button>}</div>
      <button type="button" className="wm-running-link" disabled={connecting} onClick={() => navigate(props.onShowRunning)}><span>{t(connecting || props.connection ? "Running environments" : "Last known running environments")}</span><strong>{connecting ? "—" : props.runningCount}</strong><Icon name="open" render={render} /></button>
      <div className="wm-device-section"><h3>{t("Browser downloads")}</h3>
        {connecting ? <p className="wm-small" role="status">{t("Checking download status…")}</p>
          : !props.connection ? <p className="wm-small">{t("Download status unavailable while the service is disconnected.")}</p>
          : props.downloadStatusUnavailable ? <p className="wm-small" role="status">{t("Download status temporarily unavailable")}</p>
          : props.downloads.length === 0 ? <p className="wm-small">{t("No active download tasks.")}</p>
          : props.downloads.map((download, index) => {
            const percent = download.totalBytes > 0 ? Math.min(100, Math.max(0, Math.floor(download.receivedBytes / download.totalBytes * 100))) : undefined;
            return <div className="wm-download" key={`${download.runtime}-${index}`}><div><span>{download.runtime === "firefox" ? "Firefox" : download.runtime === "cloakbrowser" ? "CloakBrowser" : "Chromium"}</span><small>{bytes(download.receivedBytes)} / {bytes(download.totalBytes || null)}</small></div><progress max={100} value={percent} aria-label={t("Browser download progress")} /></div>;
          })}
      </div>
      <div className="wm-device-section"><h3>{t("Quick preferences")}</h3><div className="wm-theme-options" role="group" aria-label={t("Theme")}>{(["light", "dark", "system"] as const).map(theme => <button type="button" key={theme} aria-pressed={props.theme === theme} disabled={busy} onClick={() => props.chooseTheme(theme)}><Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "laptop"} render={render} />{t(theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System")}</button>)}</div><label className="wm-device-language"><span>{t("language.label")}</span><select className="select" value={props.language} disabled={busy} onChange={event => void action(() => props.setLanguage(event.target.value))}>{availableLanguages().map(code => <option key={code} value={code}>{languageNativeName(code)}</option>)}</select></label></div>
      <div className="wm-device-actions"><button type="button" className="btn ghost" onClick={() => navigate(props.onViewLogs)}><Icon name="logs" render={render} />{t("View logs")}</button><button type="button" className="btn ghost" onClick={() => navigate(() => props.onSettings("general"))}><Icon name="settings" render={render} />{t("All settings")}</button></div><footer><span>{t("Version")}</span><span>{props.version || t("Unavailable")}</span></footer>
    </section></MotionPresence>, document.body)}
  </>;
}
export function WorkspaceControls(props: WorkspaceSwitcherProps & DevicePanelProps) { return <><WorkspaceSwitcher {...props} /><DevicePanel {...props} /></>; }
