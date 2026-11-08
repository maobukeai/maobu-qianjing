import { type CSSProperties, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { availableLanguages, languageNativeName, useTranslation } from "./i18n.tsx";
import type { RuntimeDownload } from "./api.ts";
import type { ThemeChoice } from "./theme.ts";
import { WORKSPACE_COLORS, WORKSPACE_ICONS, activateWorkspace, archiveWorkspace, cancelActivation, createWorkspace, downloadWorkspaceBackup, fetchWorkspaceBackups, fetchWorkspaceJob, fetchWorkspaceOverview, fetchWorkspaces, openWorkspaceLocation, restartWorkspace, restoreWorkspace, startWorkspaceBackup, updateWorkspace, workspaceDesktopAvailable, workspaceHistoryJob, workspaceJobActive, workspaceJobPercent, type WorkspaceBackups, type WorkspaceCatalog, type WorkspaceIcon, type WorkspaceJob, type WorkspaceMetadata, type WorkspaceOverview, type WorkspaceRecord } from "./workspaces-api.ts";
import "./workspace-manager.css";

export interface WorkspaceSwitcherProps {
  variant?: "sidebar" | "context";
  profileCount: number; runningCount: number; connection: boolean;
  onShowRunning: () => void;
  onOpenManagement?: (intent: WorkspacePageIntent) => void;
  managementActive?: boolean;
  onSettings?: (section?: "general" | "advanced") => void;
  renderIcon?: (name: string, className?: string) => ReactNode;
}
export type WorkspacePageIntent = { mode: "manage" | "create" | "switch" | "backups"; workspaceId?: string };
export type WorkspacePageRequest = WorkspacePageIntent & { id: number };
interface WorkspaceActivityState { job: WorkspaceJob | null; dirty: boolean; }
interface WorkspaceManagementPageProps { active: boolean; request: WorkspacePageRequest; onBack: () => void; onShowRunning: () => void; renderIcon?: WorkspaceSwitcherProps["renderIcon"]; }
export interface DevicePanelProps {
  variant?: "sidebar" | "header" | "rail";
  runningCount: number; downloads: RuntimeDownload[]; connection: boolean; connectionLoading?: boolean; version: string;
  theme: ThemeChoice; chooseTheme: (theme: ThemeChoice) => void;
  language: string; setLanguage: (language: string) => void | Promise<void>;
  onShowRunning: () => void; onSettings: (section?: "general" | "advanced") => void;
  onViewLogs: () => void; onRetryConnection?: () => void | Promise<void>;
  renderIcon?: WorkspaceSwitcherProps["renderIcon"];
}

const ICON_LABELS: Record<WorkspaceIcon, string> = { laptop: "Laptop", folder: "Folder", briefcase: "Briefcase", globe: "Globe", star: "Star", layers: "Layers" };
const COLOR_LABELS: Record<string, string> = { "#8169c8": "Purple", "#628ac7": "Blue", "#638f77": "Green", "#c4905b": "Amber", "#b87594": "Rose", "#7c7d8e": "Slate" };
interface WorkspaceContextValue { catalog: WorkspaceCatalog | null; currentWorkspace: WorkspaceRecord | undefined; currentName: string; loading: boolean; error: string | null; refresh: (signal?: AbortSignal) => Promise<WorkspaceCatalog | null>; acceptRecord: (workspace: WorkspaceRecord) => void; acceptActiveId: (id: string) => void; activity: WorkspaceActivityState; setActivity: (activity: WorkspaceActivityState) => void; }
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function WorkspaceProvider({ children, initialCatalog }: { children: ReactNode; initialCatalog?: WorkspaceCatalog }) {
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(initialCatalog ?? null), [loading, setLoading] = useState(!initialCatalog), [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<WorkspaceActivityState>({ job: null, dirty: false });
  const refresh = useCallback(async (signal?: AbortSignal) => { setLoading(true); try { const next = await fetchWorkspaces(signal); if (!signal?.aborted) { setCatalog(next); setError(null); } return next; } catch (e) { if (!signal?.aborted) setError(errorMessage(e)); return null; } finally { if (!signal?.aborted) setLoading(false); } }, []);
  const acceptRecord = useCallback((workspace: WorkspaceRecord) => setCatalog(old => old ? { ...old, workspaces: old.workspaces.some(item => item.id === workspace.id) ? old.workspaces.map(item => item.id === workspace.id ? workspace : item) : [...old.workspaces, workspace] } : old), []);
  const acceptActiveId = useCallback((id: string) => setCatalog(old => old ? { ...old, activeId: id } : old), []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const currentWorkspace = catalog?.workspaces.find(workspace => workspace.id === catalog.currentId);
  return <WorkspaceContext.Provider value={{ catalog, currentWorkspace, currentName: currentWorkspace?.name ?? "", loading, error, refresh, acceptRecord, acceptActiveId, activity, setActivity }}>{children}</WorkspaceContext.Provider>;
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
  useEffect(() => {
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
function usePopover(open: boolean, trigger: { current: HTMLElement | null }, panel: { current: HTMLElement | null }, close: () => void, above = false, onTriggerHidden?: () => void) {
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const closeRef = useRef(close), hiddenRef = useRef(onTriggerHidden); closeRef.current = close; hiddenRef.current = onTriggerHidden;
  const place = () => {
    if (!open || !trigger.current || !panel.current) return;
    if (!trigger.current.getClientRects().length || getComputedStyle(trigger.current).visibility === "hidden") { hiddenRef.current?.(); closeRef.current(); return; }
    const a = trigger.current.getBoundingClientRect(), width = panel.current.offsetWidth, height = panel.current.offsetHeight;
    const top = above && a.top > height + 10 ? a.top - height - 8 : a.bottom + height + 8 <= window.innerHeight ? a.bottom + 8 : Math.max(8, window.innerHeight - height - 8);
    const next = { top, left: Math.max(8, Math.min(a.left, window.innerWidth - width - 8)) };
    setPosition(old => old.top === next.top && old.left === next.left ? old : next);
  };
  useLayoutEffect(place);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); trigger.current?.focus({ preventScroll: true }); closeRef.current(); } };
    const change = (event: Event) => { if (!panel.current?.contains(event.target as Node)) place(); };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", key); window.addEventListener("resize", change); window.addEventListener("scroll", change, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); window.removeEventListener("resize", change); window.removeEventListener("scroll", change, true); };
  }, [open]);
  return position;
}
function WorkspaceBadge({ workspace, render }: { workspace?: WorkspaceRecord | WorkspaceMetadata; render?: WorkspaceSwitcherProps["renderIcon"] }) { return <span className="wm-workspace-badge" style={{ "--workspace-color": workspace?.color ?? WORKSPACE_COLORS[0] } as CSSProperties}><Icon name={workspace?.icon ?? "laptop"} render={render} /></span>; }

/** Backups always use the running workspace, independently of the metadata editor. */
export function WorkspaceBackupIntro({ renderIcon }: { renderIcon?: WorkspaceSwitcherProps["renderIcon"] }) {
  const { t } = useTranslation(), { currentWorkspace } = useWorkspaceCatalog();
  return <div className="wm-backup-intro"><h2>{t("Full workspace backups")}</h2><div className="wm-backup-source"><WorkspaceBadge workspace={currentWorkspace} render={renderIcon} /><span>{t("Current backup workspace: {name}", { name: currentWorkspace?.name ?? t("Loading workspace…") })}</span></div><p>{t("Includes browser data, login sessions, groups, scripts, extensions, and Trash. Downloadable browser engines are excluded.")}</p><p className="wm-small wm-backup-security">{t("Backups contain login and account data and are not password-encrypted. Keep backup files safe.")}</p><p className="wm-small">{t("System protection may require you to sign in again after restoring on another computer.")}</p></div>;
}

type Confirmation = { kind: "discard"; action: () => void } | { kind: "activate"; target: WorkspaceRecord; overview: WorkspaceOverview | null } | { kind: "restore"; source: File | { backupId: string }; name: string };
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const { catalog, currentWorkspace: current, loading, error, refresh, activity } = useWorkspaceCatalog();
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const position = usePopover(menuOpen, trigger, menu, () => setMenuOpen(false));
  const pending = !!catalog && catalog.currentId !== catalog.activeId;
  const busy = pending || !!activity.job && workspaceJobActive(activity.job);
  const render = props.renderIcon;
  const context = props.variant === "context", menuId = useId();
  const note = pending ? "Restart required" : activity.job && workspaceJobActive(activity.job) ? "Workspace task in progress" : activity.dirty ? "Unsaved changes" : null;
  function open(intent: WorkspacePageIntent) { setMenuOpen(false); trigger.current?.focus({ preventScroll: true }); props.onOpenManagement?.(intent); }
  useEffect(() => { if (menuOpen) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }, [menuOpen]);
  return <div className={context ? "wm-context-switcher" : "wm-sidebar-switcher"}>
    {context && <span className="wm-context-label">{t("Workspaces")}</span>}
    <button type="button" className={`${context ? "wm-workspace-trigger is-context" : "sidebar-workspace wm-workspace-trigger"}${props.managementActive ? " is-current-page" : ""}`} ref={trigger} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} title={current?.name ?? t("Workspaces")} aria-label={t("Open workspace switcher")} onClick={() => setMenuOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setMenuOpen(true); } }}>
      <WorkspaceBadge workspace={current} render={render} /><span className="wm-trigger-copy"><strong>{current?.name ?? t(loading ? "Loading workspace…" : "Workspace unavailable")}</strong>{(!context || note) && <small>{t(note ?? "Independent local workspace")}</small>}</span><Icon name="chevronDown" render={render} />
    </button>
    {context && props.onOpenManagement && <button type="button" className={`wm-context-manage${props.managementActive ? " is-current-page" : ""}`} aria-current={props.managementActive ? "page" : undefined} onClick={() => open({ mode: "manage" })}>{t("Manage workspaces")}</button>}
    {menuOpen && createPortal(<div className="wm-switcher-popover" id={menuId} ref={menu} role="menu" aria-label={t("Workspaces")} style={position} onKeyDown={event => { if (event.key === "Tab") { trigger.current?.focus({ preventScroll: true }); setMenuOpen(false); return; } if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return; event.preventDefault(); const items = controls(menu.current!); const index = items.indexOf(document.activeElement as HTMLElement); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }}>
      <div className="wm-popover-heading">{t("Workspaces")}</div>
      {loading && !catalog && <p className="wm-small" role="status">{t("Loading workspaces…")}</p>}
      {error && <div className="wm-error" role="alert"><span>{t(error)}</span><button type="button" onClick={() => void refresh()}>{t("Retry")}</button></div>}
      {catalog?.workspaces.filter(w => !w.archived).map(w => <button type="button" key={w.id} className="wm-switcher-item" role="menuitemradio" aria-checked={w.id === catalog.currentId} disabled={busy && w.id !== catalog.currentId} onClick={() => open({ mode: w.id === catalog.currentId ? "manage" : "switch", workspaceId: w.id })}><WorkspaceBadge workspace={w} render={render} /><span>{w.name}<small>{t(w.id === catalog.currentId ? "Current workspace" : "Independent data and browser profiles")}</small></span>{w.id === catalog.currentId && <Icon name="check" render={render} />}</button>)}
      {catalog && catalog.workspaces.filter(w => !w.archived).length === 0 && <p className="wm-small">{t("No active workspaces.")}</p>}
      <div className="wm-popover-foot"><button type="button" role="menuitem" disabled={busy} onClick={() => open({ mode: "create" })}><Icon name="plus" render={render} />{t("New workspace")}</button><button type="button" role="menuitem" onClick={() => open({ mode: "manage" })}><Icon name="settings" render={render} />{t("Manage workspaces")}</button></div>
    </div>, document.body)}
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
  const { catalog, currentWorkspace: current, loading, error: catalogError, refresh: refreshCatalog, acceptRecord, acceptActiveId, setActivity } = useWorkspaceCatalog();
  const [tab, setTab] = useState<"workspaces" | "backups">("workspaces"), [showArchived, setShowArchived] = useState(false), [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(current?.id ?? null), [draft, setDraft] = useState<WorkspaceMetadata>(current ? { name: current.name, color: current.color, icon: current.icon } : { name: "", color: WORKSPACE_COLORS[0], icon: "laptop" });
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null), [overviewError, setOverviewError] = useState<string | null>(null), [history, setHistory] = useState<WorkspaceBackups>({ backups: [], jobs: [] }), [historyError, setHistoryError] = useState<string | null>(null), [historyLoading, setHistoryLoading] = useState(false);
  const [operation, setOperation] = useState(""), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null), [closeRunning, setCloseRunning] = useState(false);
  const [job, setJob] = useState<WorkspaceJob | null>(null), [pollError, setPollError] = useState<string | null>(null), [pollVersion, setPollVersion] = useState(0), [retrySource, setRetrySource] = useState<File | { backupId: string } | "backup" | null>(null), [retrySourceJobId, setRetrySourceJobId] = useState<string | null>(null), [pendingRestart, setPendingRestart] = useState<{ expected: string; target: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null), confirmPanel = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), handledRequest = useRef<number | null>(null), initialized = useRef(!!current), focusName = useRef(false);
  const editing = catalog?.workspaces.find(w => w.id === editingId);
  const original: WorkspaceMetadata = editing ? { name: editing.name, color: editing.color, icon: editing.icon } : { name: "", color: WORKSPACE_COLORS[0], icon: "laptop" };
  const dirty = draft.name !== original.name || draft.color !== original.color || draft.icon !== original.icon;
  const activeJob = !!job && workspaceJobActive(job), pending = pendingRestart ?? (catalog && catalog.currentId !== catalog.activeId ? { expected: catalog.currentId, target: catalog.activeId } : null);
  const maintenance = activeJob || !!overview?.backupBusy || !!pending;
  const retryJobSource = job?.kind === "backup" ? "backup" : retrySourceJobId === job?.id && retrySource !== "backup" ? retrySource : null;
  useEffect(() => { setActivity({ job, dirty }); }, [job, dirty, setActivity]);
  useEffect(() => { setPendingRestart(catalog && catalog.currentId !== catalog.activeId ? { expected: catalog.currentId, target: catalog.activeId } : null); }, [catalog?.currentId, catalog?.activeId]);
  async function refreshOverview(signal?: AbortSignal) { try { const next = await fetchWorkspaceOverview(signal); if (!signal?.aborted) { setOverview(next); setOverviewError(null); } return next; } catch (e) { if (!signal?.aborted) setOverviewError(errorMessage(e)); return null; } }
  async function refreshHistory(signal?: AbortSignal) { setHistoryLoading(true); try { const next = await fetchWorkspaceBackups(signal); if (!signal?.aborted) { setHistory(next); setHistoryError(null); setJob(existing => workspaceHistoryJob(next.jobs, existing)); } } catch (e) { if (!signal?.aborted) setHistoryError(errorMessage(e)); } finally { if (!signal?.aborted) setHistoryLoading(false); } }
  // Keep this page mounted while navigating: drafts and background job polling survive.
  useEffect(() => { const controller = new AbortController(); void refreshOverview(controller.signal); void refreshHistory(controller.signal); return () => controller.abort(); }, [props.active]);
  useEffect(() => { if (props.active) heading.current?.focus({ preventScroll: true }); }, [props.active]);
  useEffect(() => {
    if (!props.active || !catalog || operation || handledRequest.current === props.request.id) return;
    handledRequest.current = props.request.id;
    const target = catalog.workspaces.find(w => w.id === props.request.workspaceId);
    const action = () => {
      if (props.request.mode === "create") { selectEditor(null); setTab("workspaces"); nameInput.current?.focus({ preventScroll: true }); }
      else if (props.request.mode === "backups") setTab("backups");
      else if (props.request.mode === "switch" && target) { selectEditor(target); setTab("workspaces"); if (!maintenance) void prepareActivation(target); }
      else if (target && target.id !== editingId || !initialized.current) { selectEditor(target ?? current ?? null); setTab("workspaces"); }
      initialized.current = true;
    };
    const replacesDraft = props.request.mode === "create" || props.request.mode === "switch" || !!target && target.id !== editingId;
    if (dirty && replacesDraft) discardThen(action); else action();
  }, [props.active, props.request.id, catalog?.currentId, operation]);
  useEffect(() => {
    if (!job || !workspaceJobActive(job)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await fetchWorkspaceJob(job.id, controller.signal); if (controller.signal.aborted) return; setJob(next); setPollError(null); if (workspaceJobActive(next)) timer = setTimeout(poll, 1200); else await Promise.all([refreshCatalog(), refreshOverview(), refreshHistory()]); } catch (e) { if (!controller.signal.aborted) setPollError(errorMessage(e)); } };
    timer = setTimeout(poll, 800); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, pollVersion]);
  function selectEditor(workspace: WorkspaceRecord | null) { if (!workspace) focusName.current = true; setEditingId(workspace?.id ?? null); setDraft(workspace ? { name: workspace.name, color: workspace.color, icon: workspace.icon } : { name: "", color: WORKSPACE_COLORS[0], icon: "laptop" }); setError(null); setNotice(null); }
  function discardThen(action: () => void) { if (dirty) setConfirmation({ kind: "discard", action }); else action(); }
  useLayoutEffect(() => { if (props.active && tab === "workspaces" && focusName.current && nameInput.current) { focusName.current = false; nameInput.current.focus({ preventScroll: true }); } });
  function newWorkspace() { discardThen(() => { selectEditor(null); setTab("workspaces"); nameInput.current?.focus({ preventScroll: true }); }); }
  function changeTab(next: "workspaces" | "backups") { setTab(next); }
  useDialogFocus(confirmPanel, props.active && !!confirmation, () => { if (!operation) { setConfirmation(null); setCloseRunning(false); } });
  async function perform(name: string, action: () => Promise<void>) { if (operation) return; setOperation(name); setError(null); setNotice(null); try { await action(); } catch (e) { setError(errorMessage(e)); if (name === "activate" || name === "cancel") { await refreshCatalog(); if (name === "activate") { const fresh = await refreshOverview(); setConfirmation(old => old?.kind === "activate" ? { ...old, overview: fresh } : old); } } if (name === "job") await Promise.all([refreshOverview(), refreshHistory()]); } finally { setOperation(""); } }
  async function saveMetadata() { if (!draft.name.trim()) return; await perform("save", async () => { const value = { ...draft, name: draft.name.trim() }; const saved = editingId ? await updateWorkspace(editingId, value) : await createWorkspace(value); acceptRecord(saved); selectEditor(saved); const next = await refreshCatalog(); setNotice("Workspace saved."); if (!next) setError("Workspace saved, but the workspace list could not refresh."); }); }
  async function prepareActivation(target: WorkspaceRecord) { setError(null); setCloseRunning(false); setConfirmation({ kind: "activate", target, overview: null }); const fresh = await refreshOverview(); setConfirmation(old => old?.kind === "activate" && old.target.id === target.id ? { ...old, overview: fresh } : old); }
  async function askActivate(target: WorkspaceRecord) { if (dirty) discardThen(() => void prepareActivation(target)); else await prepareActivation(target); }
  async function commitActivation() {
    if (confirmation?.kind !== "activate" || !catalog || !confirmation.overview) return;
    const target = confirmation.target, expected = catalog.currentId;
    await perform("activate", async () => { if (!workspaceDesktopAvailable()) throw new Error("Open this action in the desktop app."); await activateWorkspace(target.id, closeRunning); acceptActiveId(target.id); setPendingRestart({ expected, target: target.id }); await refreshCatalog(); try { await restartWorkspace(expected, target.id); } catch (failure) { try { await cancelActivation(); acceptActiveId(expected); setPendingRestart(null); await refreshCatalog(); } catch { throw new Error("Restart and rollback failed. Retry the desktop restart."); } throw failure; } setConfirmation(null); setNotice("Restart requested. Waiting for the desktop app…"); });
  }
  async function beginJob(source: File | { backupId: string } | "backup") { await perform("job", async () => { setPollError(null); setRetrySource(source); setRetrySourceJobId(null); const next = source === "backup" ? await startWorkspaceBackup() : await restoreWorkspace(source); setRetrySourceJobId(next.id); setJob(next); setConfirmation(null); if (!workspaceJobActive(next)) await Promise.all([refreshCatalog(), refreshOverview(), refreshHistory()]); }); }
  async function location(kind: "data" | "backups") { await perform("location", () => openWorkspaceLocation(kind)); }
  const restoredWorkspace = job?.status === "succeeded" && job.kind === "restore" ? catalog?.workspaces.find(w => w.id === job.result?.workspaceId) : undefined;
  const render = props.renderIcon;
  const visibleWorkspaces = catalog?.workspaces.filter(w => (showArchived || !w.archived) && w.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <>
    <section className="workspace wm-page" hidden={!props.active} aria-labelledby="wm-page-title">
      <div className="wm-page-inner">
        <header className="page-heading wm-page-heading"><div><h1 id="wm-page-title" ref={heading} tabIndex={-1}>{t("Workspace management")}</h1><p>{t("A dedicated space for every project.")}</p></div><div className="page-actions"><button type="button" className="btn ghost" onClick={props.onBack}><Icon name="back" render={render} />{t("Back to environments")}</button><button type="button" className="btn primary" disabled={!!operation || maintenance} onClick={newWorkspace}><Icon name="plus" render={render} />{t("New workspace")}</button></div></header>
        <div className="wm-current-summary"><div className="wm-current-identity"><WorkspaceBadge workspace={current} render={render} /><div><small>{t("Current workspace")}</small><strong>{current?.name ?? t("Loading workspace…")}</strong></div><span className="wm-status-pill">{t("Local workspace")}</span></div><div className="wm-summary-metrics"><div><strong>{overview?.profileCount ?? "—"}</strong><span>{t("Environments")}</span></div><button type="button" disabled={!overview} onClick={props.onShowRunning}><strong>{overview?.runningCount ?? "—"}</strong><span><i className="wm-running-dot" />{t("Running environments")}</span></button><div><strong>{bytes(overview?.bytes ?? null)}</strong><span>{t("Workspace storage")}</span></div><div><strong>{historyError || historyLoading && !history.backups.length ? "—" : history.backups.length}</strong><span>{t("Backup history")}</span></div></div></div>
        <nav className="wm-page-tabs" role="tablist" aria-label={t("Workspace sections")} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? "workspaces" : event.key === "End" ? "backups" : tab === "workspaces" ? "backups" : "workspaces"; changeTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#wm-tab-${next}`)?.focus(); }}><button id="wm-tab-workspaces" type="button" role="tab" aria-selected={tab === "workspaces"} aria-controls="wm-panel-workspaces" tabIndex={tab === "workspaces" ? 0 : -1} onClick={() => changeTab("workspaces")}><Icon name="layers" render={render} />{t("Workspaces")}<span>{catalog?.workspaces.filter(w => !w.archived).length ?? 0}</span></button><button id="wm-tab-backups" type="button" role="tab" aria-selected={tab === "backups"} aria-controls="wm-panel-backups" tabIndex={tab === "backups" ? 0 : -1} onClick={() => changeTab("backups")}><Icon name="archive" render={render} />{t("Backup and restore")}</button>{dirty && <span className="wm-draft-indicator">{t("Unsaved changes")}</span>}</nav>
        <div className="wm-page-body">
          {error && !confirmation && <div className="wm-error" role="alert">{t(error)}</div>}{notice && <div className="wm-success" role="status"><Icon name="check" render={render} />{t(notice)}</div>}
          {pending && <div className="wm-callout wm-pending"><Icon name="refresh" render={render} /><div><strong>{current?.name} → {catalog?.workspaces.find(w => w.id === pending.target)?.name ?? t("Workspace unavailable")}</strong><p>{t("A workspace switch is prepared. Restart to finish switching.")}</p></div><button type="button" className="btn" disabled={!!operation || !workspaceDesktopAvailable()} onClick={() => void perform("restart", async () => { await restartWorkspace(pending.expected, pending.target); setNotice("Restart requested. Waiting for the desktop app…"); })}>{t("Retry restart")}</button><button type="button" className="btn ghost" disabled={!!operation} onClick={() => void perform("cancel", async () => { await cancelActivation(); if (catalog) acceptActiveId(catalog.currentId); setPendingRestart(null); setError(null); await refreshCatalog(); setNotice("Workspace switch cancelled."); })}>{t("Cancel workspace switch")}</button>{!workspaceDesktopAvailable() && <small>{t("Switching workspaces requires the desktop app.")}</small>}</div>}
          {maintenance && !pending && tab === "workspaces" && <div className="wm-callout"><Icon name="archive" render={render} /><span>{t("Wait for the workspace backup or restore task to finish before making changes.")}</span><button type="button" className="btn ghost xs" onClick={() => changeTab("backups")}>{t("View task")}</button></div>}
          <div id="wm-panel-workspaces" role="tabpanel" aria-labelledby="wm-tab-workspaces" hidden={tab !== "workspaces"} className="wm-workspaces-layout">
            <aside className="wm-catalog wm-card"><div className="wm-card-heading"><h2>{t("Your workspaces")}</h2><span className="wm-count">{visibleWorkspaces.length}</span></div><label className="wm-search"><Icon name="search" render={render} /><input type="search" aria-label={t("Search workspaces")} placeholder={t("Search workspaces")} value={search} onChange={event => setSearch(event.target.value)} /></label><label className="wm-check wm-archive-filter"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t("Show archived")}</label>
              {catalogError && <div className="wm-error" role="alert">{t(catalogError)}<button type="button" onClick={() => void refreshCatalog()}>{t("Retry")}</button></div>}{loading && !catalog && <p className="wm-small" role="status">{t("Loading workspaces…")}</p>}
              <div className="wm-catalog-list">{visibleWorkspaces.map(w => <button type="button" className={`wm-catalog-item${editingId === w.id ? " active" : ""}`} key={w.id} aria-pressed={editingId === w.id} disabled={!!operation} onClick={() => discardThen(() => selectEditor(w))}><WorkspaceBadge workspace={w} render={render} /><span><strong>{w.name}</strong><small>{t(w.archived ? "Archived" : w.id === catalog?.currentId ? "Current workspace" : "Local workspace")}</small></span>{w.id === catalog?.currentId && <span className="wm-current-dot" aria-hidden="true" />}</button>)}</div>
              {!loading && !catalogError && !visibleWorkspaces.length && <div className="wm-empty wm-search-empty"><Icon name="search" render={render} /><strong>{t("No matching workspaces.")}</strong><p>{t("Try another name, or show archived workspaces.")}</p><button type="button" className="btn ghost xs" onClick={() => { setSearch(""); setShowArchived(true); }}>{t("Reset filters")}</button></div>}
              <div className="wm-catalog-foot"><Icon name="drive" render={render} /><span>{t("Workspace data stays on this computer.")}</span></div>
            </aside>
            <div className="wm-editor">
              <section className="wm-card wm-identity-card"><form onSubmit={event => { event.preventDefault(); void saveMetadata(); }}><div className="wm-editor-title"><WorkspaceBadge workspace={draft} render={render} /><div><h2>{editing ? draft.name.trim() || editing.name : t("Create a workspace")}</h2><p>{t(editing ? "Workspace details" : "Choose a name and a visual identity for this workspace.")}</p></div>{editing && <span className="wm-status-pill">{t(editing.archived ? "Archived" : editing.id === catalog?.currentId ? "Current workspace" : "Local workspace")}</span>}</div>
                <label className="fld"><span>{t("Workspace name")}</span><input ref={nameInput} value={draft.name} maxLength={40} disabled={!!operation} required placeholder={t("For example: Client A or Personal projects")} onChange={event => setDraft(old => ({ ...old, name: event.target.value }))} /></label>
                <div className="wm-identity-options"><fieldset className="wm-choice-field"><legend>{t("Workspace icon")}</legend><div className="wm-icon-choices">{WORKSPACE_ICONS.map(icon => <button type="button" key={icon} disabled={!!operation} aria-pressed={draft.icon === icon} aria-label={t(ICON_LABELS[icon])} onClick={() => setDraft(old => ({ ...old, icon }))}><Icon name={icon} render={render} /></button>)}</div></fieldset><fieldset className="wm-choice-field"><legend>{t("Workspace color")}</legend><div className="wm-color-choices">{WORKSPACE_COLORS.map(color => <button type="button" key={color} style={{ backgroundColor: color }} disabled={!!operation} aria-pressed={draft.color === color} aria-label={t(COLOR_LABELS[color] ?? "Purple")} onClick={() => setDraft(old => ({ ...old, color }))}>{draft.color === color && <Icon name="check" render={render} />}</button>)}</div></fieldset></div>
                <div className="wm-form-actions"><span className="wm-save-hint">{t(dirty ? "Your draft is kept when you leave this page." : "Each workspace has separate environments, groups, scripts, and extensions.")}</span>{dirty && <button type="button" className="btn ghost" disabled={!!operation} onClick={() => selectEditor(editing ?? null)}>{t("Reset changes")}</button>}<button type="submit" className="btn primary" disabled={!!operation || maintenance || !draft.name.trim() || (!!editing && !dirty)}>{t(operation === "save" ? "Saving…" : editing ? "Save changes" : "Create workspace")}</button></div>
              </form></section>
              {editing && <><section className="wm-card wm-data-card"><div className="wm-card-heading"><h2>{t(editing.id === catalog?.currentId ? "Current workspace data" : "Independent local workspace")}</h2>{editing.id !== catalog?.currentId && !editing.archived && <button type="button" className="btn" disabled={!!operation || maintenance} onClick={() => void askActivate(editing)}><Icon name="open" render={render} />{t("Switch to this workspace")}</button>}</div>
                <div className="wm-record-meta"><span><small>{t("Created")}</small><strong>{date(editing.createdAt)}</strong></span><span><small>{t("Last opened")}</small><strong>{date(editing.lastOpenedAt)}</strong></span></div>
                {editing.id === catalog?.currentId ? <>{overviewError && <div className="wm-error" role="alert">{t(overviewError)}<button type="button" onClick={() => void refreshOverview()}>{t("Retry")}</button></div>}{!overview && !overviewError && <p className="wm-small" role="status">{t("Calculating storage…")}</p>}{overview && <><div className="wm-storage-row"><div><span>{t("In Trash")}</span><strong>{overview.trashCount}</strong></div><div><span>{t("Disk space available")}</span><strong>{bytes(overview.freeBytes)}</strong></div></div><div className="wm-folder-row"><div><Icon name="folder" render={render} /><span className="wm-path" title={overview.root}>{overview.root}</span></div><button type="button" className="btn xs" onClick={() => void location("data")} disabled={!!operation}>{t("Open data folder")}<Icon name="open" render={render} /></button></div></>}</> : <p className="wm-card-description">{t("Each workspace has separate environments, groups, scripts, and extensions.")}</p>}
              </section><section className="wm-card wm-archive-control"><div><h3>{t(editing.archived ? "Unarchive workspace" : "Archive workspace")}</h3><p>{t(editing.id === "default" ? "The initial workspace preserves existing data and cannot be archived." : editing.id === catalog?.currentId ? "Switch to another workspace before archiving this one." : "Archiving keeps all workspace data. You can unarchive it later.")}</p></div><button type="button" className="btn" disabled={!!operation || maintenance || editing.id === "default" || editing.id === catalog?.currentId || editing.id === catalog?.activeId} onClick={() => discardThen(() => void perform("archive", async () => { await archiveWorkspace(editing.id, !editing.archived); const confirmed = { ...editing, archived: !editing.archived }; acceptRecord(confirmed); selectEditor(confirmed); await refreshCatalog(); setNotice(editing.archived ? "Workspace unarchived." : "Workspace archived."); }))}><Icon name="archive" render={render} />{t(editing.archived ? "Unarchive workspace" : "Archive workspace")}</button></section></>}
            </div>
          </div>
          <div id="wm-panel-backups" role="tabpanel" aria-labelledby="wm-tab-backups" hidden={tab !== "backups"} className="wm-backup-layout">
            <div className="wm-backup-main"><div className="wm-backup-action-grid"><section className="wm-card wm-backup-action"><span className="wm-action-icon"><Icon name="download" render={render} /></span><h2>{t("Backup your workspace")}</h2><p>{t("Create a verified copy of your current workspace.")}</p><button type="button" className="btn primary" disabled={!!operation || maintenance || !overview || overview.runningCount > 0 || overview.scriptRunning} onClick={() => void beginJob("backup")}>{t("Create full backup")}</button></section><section className="wm-card wm-backup-action"><span className="wm-action-icon is-restore"><Icon name="upload" render={render} /></span><h2>{t("Restore a workspace")}</h2><p>{t("Import a backup into a new, independent workspace.")}</p><button type="button" className="btn" disabled={!!operation || maintenance} onClick={() => { setError(null); fileInput.current?.click(); }}>{t("Restore from file")}</button><input ref={fileInput} type="file" accept=".mqbackup,application/octet-stream" hidden onChange={event => { const file = event.target.files?.[0]; if (file) { setError(null); setConfirmation({ kind: "restore", source: file, name: file.name }); } event.target.value = ""; }} /></section></div>
              {overviewError && <div className="wm-error">{t(overviewError)}<button type="button" onClick={() => void refreshOverview()}>{t("Retry")}</button></div>}{overview && (overview.runningCount > 0 || overview.scriptRunning) && <div className="wm-callout"><Icon name="alert" render={render} /><span>{t("Stop running browsers and scripts before creating a full backup.")}</span><button type="button" className="btn ghost xs" onClick={props.onShowRunning}>{t("View running environments")}</button></div>}
              {job && <section className={`wm-job wm-job-${job.status}`} aria-live="polite"><div className="wm-job-heading"><strong>{t(job.kind === "backup" ? "Backup task" : "Restore task")}</strong><span>{t(job.status === "succeeded" ? "Completed" : job.status === "failed" ? "Failed" : job.status === "queued" ? "Waiting to start" : "In progress")}</span></div>{workspaceJobActive(job) && <><p>{t(PHASE_LABELS[job.phase] ?? "In progress")}</p>{workspaceJobPercent(job) === null ? <progress max={100} aria-label={t("Workspace task progress")} /> : <progress max={100} value={workspaceJobPercent(job)!} aria-label={t("Workspace task progress")} />}<small>{workspaceJobPercent(job) === null ? t("Preparing…") : `${workspaceJobPercent(job)}%`}</small></>}{job.status === "failed" && <><p>{t(job.error ?? "Workspace request failed.")}</p>{retryJobSource && <button type="button" className="btn" disabled={!!operation} onClick={() => void beginJob(retryJobSource)}>{t("Retry task")}</button>}{!retryJobSource && <p>{t("Choose the backup file again to retry restoration.")}</p>}</>}{job.status === "succeeded" && <p>{t(job.kind === "restore" ? "Restored as a new workspace. Your current workspace was not changed." : "Backup created and verified.")}</p>}{restoredWorkspace && <button type="button" className="btn" onClick={() => discardThen(() => { selectEditor(restoredWorkspace); setTab("workspaces"); })}>{t("View restored workspace")}</button>}{pollError && <div className="wm-error">{t(pollError)}<button type="button" onClick={() => { setPollError(null); setPollVersion(value => value + 1); }}>{t("Retry status check")}</button></div>}</section>}
              <section className="wm-card wm-history-card"><div className="wm-history-heading"><div><h2>{t("Backup history")}</h2><span className="wm-count">{history.backups.length}</span></div><button type="button" className="btn ghost xs" disabled={historyLoading} onClick={() => void refreshHistory()}><Icon name="refresh" render={render} />{t("Refresh")}</button></div>{historyError && <div className="wm-error" role="alert">{t(historyError)}<button type="button" onClick={() => void refreshHistory()}>{t("Retry")}</button></div>}{historyLoading && !history.backups.length && <p className="wm-small" role="status">{t("Loading backup history…")}</p>}{!historyLoading && !historyError && !history.backups.length && <div className="wm-empty"><span className="wm-empty-tile"><Icon name="archive" render={render} /></span><strong>{t("No backups yet")}</strong><p>{t("Create a full backup to keep a recoverable copy of this workspace.")}</p></div>}
                <div className="wm-backup-history">{history.backups.map(backup => <article className="wm-backup-row" key={backup.id}><span className="wm-backup-file-icon"><Icon name="archive" render={render} /></span><div><strong>{backup.name}</strong><small>{date(backup.createdAt)} · {bytes(backup.bytes)} · {t("{count} environments", { count: backup.profileCount })}</small></div><div className="wm-backup-row-actions"><button type="button" className="btn xs" disabled={!!operation} onClick={() => void perform("download", async () => { const result = await downloadWorkspaceBackup(backup.id); setNotice(result === "saved" ? "Backup saved." : result === "cancelled" ? "Save cancelled." : "Download requested."); })}><Icon name="download" render={render} />{t("Download")}</button><button type="button" className="btn xs" disabled={!!operation || maintenance} onClick={() => { setError(null); setConfirmation({ kind: "restore", source: { backupId: backup.id }, name: backup.name }); }}>{t("Restore as new")}</button></div></article>)}</div>
              </section>
            </div><aside className="wm-card wm-backup-guide"><WorkspaceBackupIntro renderIcon={render} /><button type="button" className="btn ghost" disabled={!!operation} onClick={() => void location("backups")}><Icon name="folder" render={render} />{t("Open backup folder")}<Icon name="open" render={render} /></button></aside>
          </div>
        </div>
      </div>
    </section>
    {props.active && confirmation && createPortal(<div className="wm-confirm-backdrop"><section className="wm-confirm" ref={confirmPanel} role="dialog" aria-modal="true" aria-labelledby="wm-confirm-title" tabIndex={-1}><h2 id="wm-confirm-title">{t(confirmation.kind === "discard" ? "Discard unsaved changes?" : confirmation.kind === "restore" ? "Restore as a new workspace?" : "Switch workspace?")}</h2>
      {confirmation.kind === "discard" ? <p>{t("Your workspace changes have not been saved.")}</p> : confirmation.kind === "restore" ? <><p className="wm-confirm-filename">{confirmation.name}</p><p>{t("This creates a separate workspace. Your current workspace and its data stay intact.")}</p><p className="wm-small">{t("System protection may require you to sign in again after restoring on another computer.")}</p></> : <><p>{t("Switch to {name} and restart the desktop app.", { name: confirmation.target.name })}</p>{!confirmation.overview && !overviewError && <p role="status">{t("Checking running environments…")}</p>}{overviewError && <div className="wm-error">{t(overviewError)}<button type="button" onClick={() => void askActivate(confirmation.target)}>{t("Retry")}</button></div>}{confirmation.overview && <><p>{t("{count} browser(s) are running in the current workspace.", { count: confirmation.overview.runningCount })}</p>{confirmation.overview.scriptRunning && <p>{t("One or more scripts are running.")}</p>}{(confirmation.overview.runningCount > 0 || confirmation.overview.scriptRunning) && <label className="wm-check wm-switch-consent"><input type="checkbox" checked={closeRunning} onChange={event => setCloseRunning(event.target.checked)} />{t("Close running browsers and stop scripts before switching.")}</label>}{confirmation.overview.backupBusy && <p className="wm-warning">{t("Wait for the workspace backup or restore task to finish before switching.")}</p>}</>}{!workspaceDesktopAvailable() && <p className="wm-warning">{t("Switching workspaces requires the desktop app.")}</p>}</>}
      {error && <div className="wm-error" role="alert">{t(error)}</div>}<div className="wm-confirm-actions"><button type="button" className="btn" disabled={!!operation} onClick={() => { setConfirmation(null); setCloseRunning(false); }}>{t(confirmation.kind === "discard" ? "Keep editing" : "Cancel")}</button><button type="button" className="btn primary" disabled={!!operation || (confirmation.kind === "activate" && (!workspaceDesktopAvailable() || !confirmation.overview || confirmation.overview.backupBusy || ((confirmation.overview.runningCount > 0 || confirmation.overview.scriptRunning) && !closeRunning)))} onClick={() => { if (confirmation.kind === "discard") { const action = confirmation.action; setDraft(original); setConfirmation(null); action(); } else if (confirmation.kind === "restore") void beginJob(confirmation.source); else void commitActivation(); }}>{t(operation ? "Working…" : confirmation.kind === "discard" ? "Discard changes" : confirmation.kind === "restore" ? "Restore as new workspace" : "Switch and restart")}</button></div>
    </section></div>, document.body)}
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
  function focusVisibleDeviceEntry() {
    const active = document.activeElement;
    if (active !== document.body && active !== trigger.current && !panel.current?.contains(active)) return;
    const visible = [...document.querySelectorAll<HTMLButtonElement>(".wm-device-trigger")].find(entry => entry !== trigger.current && entry.getClientRects().length > 0 && getComputedStyle(entry).visibility !== "hidden");
    visible?.focus({ preventScroll: true });
  }
  const position = usePopover(open, trigger, panel, () => setOpen(false), true, focusVisibleDeviceEntry);
  useEffect(() => { const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== panelId) setOpen(false); }; window.addEventListener("maobu:device-panel-open", otherOpened); return () => window.removeEventListener("maobu:device-panel-open", otherOpened); }, [panelId]);
  useDialogFocus(panel, open, () => setOpen(false)); const render = props.renderIcon;
  function togglePanel() { const next = !open; if (next) window.dispatchEvent(new CustomEvent("maobu:device-panel-open", { detail: panelId })); setOpen(next); }
  async function action(run: () => void | Promise<void>) { setBusy(true); setError(null); try { await run(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  function navigate(run: () => void) { trigger.current?.focus({ preventScroll: true }); setOpen(false); run(); }
  return <><button type="button" className={`wm-device-trigger is-${variant}${variant === "sidebar" ? " sidebar-identity" : ""}`} ref={trigger} title={variant === "sidebar" ? currentName || t("This device") : `${t("This device")} · ${t(connectionText)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-describedby={statusId} aria-label={t("Open device panel")} onClick={togglePanel}><span className={variant === "sidebar" ? "sidebar-avatar" : "wm-device-icon"}><Icon name="laptop" render={render} /></span>{variant === "sidebar" ? <span className="wm-trigger-copy"><strong>{currentName || t("This device")}</strong><small id={statusId}>{t(connectionText)}</small></span> : <><span className="wm-device-label">{t("This device")}</span><span className="wm-sr-only" id={statusId}>{t(connectionText)}</span></>}<span className={connectionClass} aria-hidden="true" /></button>
    {open && createPortal(<section className="wm-device-popover" id={panelId} ref={panel} role="dialog" aria-labelledby={headingId} tabIndex={-1} style={position}><header><div><h2 id={headingId}>{t("This device")}</h2><small>{t("Local runtime and quick preferences")}</small></div><button type="button" className="iconbtn" aria-label={t("Close device panel")} onClick={() => setOpen(false)}><Icon name="close" render={render} /></button></header>{error && <div className="wm-error" role="alert">{t(error)}</div>}
      <div className="wm-device-status" role="status" aria-live="polite" aria-busy={connecting}><span className={connectionClass} /><span>{t(connectionText)}</span>{props.onRetryConnection && !props.connection && !connecting && <button type="button" className="btn xs" disabled={busy} onClick={() => void action(props.onRetryConnection!)}>{t("Retry")}</button>}</div>
      <button type="button" className="wm-running-link" disabled={connecting} onClick={() => navigate(props.onShowRunning)}><span>{t(connecting || props.connection ? "Running environments" : "Last known running environments")}</span><strong>{connecting ? "—" : props.runningCount}</strong><Icon name="open" render={render} /></button>
      <div className="wm-device-section"><h3>{t("Browser downloads")}</h3>{connecting ? <p className="wm-small" role="status">{t("Checking download status…")}</p> : !props.connection ? <p className="wm-small">{t("Download status unavailable while the service is disconnected.")}</p> : props.downloads.length === 0 ? <p className="wm-small">{t("No active download tasks.")}</p> : props.downloads.map((download, index) => { const percent = download.totalBytes > 0 ? Math.min(100, Math.max(0, Math.floor(download.receivedBytes / download.totalBytes * 100))) : null; return <div className="wm-download" key={`${download.runtime}-${index}`}><div><span>{download.runtime === "firefox" ? "Firefox" : download.runtime === "cloakbrowser" ? "CloakBrowser" : "Chromium"}</span><small>{bytes(download.receivedBytes)} / {bytes(download.totalBytes || null)}</small></div>{percent === null ? <progress max={100} aria-label={t("Browser download progress")} /> : <progress max={100} value={percent} aria-label={t("Browser download progress")} />}</div>; })}</div>
      <div className="wm-device-section"><h3>{t("Quick preferences")}</h3><div className="wm-theme-options" role="group" aria-label={t("Theme")}>{(["light", "dark", "system"] as const).map(theme => <button type="button" key={theme} aria-pressed={props.theme === theme} disabled={busy} onClick={() => props.chooseTheme(theme)}><Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "laptop"} render={render} />{t(theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System")}</button>)}</div><label className="wm-device-language"><span>{t("language.label")}</span><select className="select" value={props.language} disabled={busy} onChange={event => void action(() => props.setLanguage(event.target.value))}>{availableLanguages().map(code => <option key={code} value={code}>{languageNativeName(code)}</option>)}</select></label></div>
      <div className="wm-device-actions"><button type="button" className="btn ghost" onClick={() => navigate(props.onViewLogs)}><Icon name="logs" render={render} />{t("View logs")}</button><button type="button" className="btn ghost" onClick={() => navigate(() => props.onSettings("general"))}><Icon name="settings" render={render} />{t("All settings")}</button></div><footer><span>{t("Version")}</span><span>{props.version || t("Unavailable")}</span></footer>
    </section>, document.body)}
  </>;
}
export function WorkspaceControls(props: WorkspaceSwitcherProps & DevicePanelProps) { return <><WorkspaceSwitcher {...props} /><DevicePanel {...props} /></>; }
