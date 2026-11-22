import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./proxies.css";
import "./workbench-layout.css";
import maobuMarkUrl from "./maobu-mark.png";
import { folderScope, type FolderInfo } from "../folders.ts";
import { GROUP_DISCLOSURE_KEY, readGroupDisclosure, serializeGroupDisclosure, toggleProfileSelection } from "../profile-group-state.ts";
import { profileTagsUpdate } from "../profile-tags.ts";
import { FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY, parseFavoriteProfiles, parseSavedProfileViews, serializeFavoriteProfiles, serializeSavedProfileViews, type RosterScope, type SavedProfileView } from "../profile-view-state.ts";
import { AboutPopover } from "./about-popover.tsx";
import { assignExtensionBulk, closeProfile, convertMobileProfile, createGroup, deleteGroup, deleteProfiles, exportProfiles, fetchAppMode, fetchDiagnose, fetchDiskSpace, fetchExtensions, fetchGroupExtensionDefaults, fetchHealth, fetchLogs, fetchRuntimeDownloads, fetchTotp, installWebStoreExtension, isUnauthorizedError, moveGroup, openProfile, previewGroupExtensionDefaults, removeExtension, renameGroup, restartProfile, setGroupExtensionDefaults, setStandaloneSessionToken, subscribeUnauthorized, updateProfile, uploadExtensions, type AppModeConfig, type DiagnoseReport, type DiskSpace, type ExportFormat, type ExportProgress, type Extension, type GroupExtensionDefaults, type RuntimeDownload, type UiProfile } from "./api.ts";
import { backgroundScriptRuns, useBackgroundScriptRun } from "./background-script-run.tsx";
import { BulkProfileTaskPanel } from "./bulk-profile-task-panel.tsx";
import { createBulkProfileTask, type BulkProfileAction, type BulkProfileTask, type BulkProfileTaskSnapshot } from "./bulk-profile-task.ts";
import { CommandPalette, type CommandPaletteCommand } from "./command-palette.tsx";
import { ActionDock } from "./components/action-dock.tsx";
import { ToastStack, useToastStack, type ToastTone } from "./components/toast-stack.tsx";
import { CookieImportTaskDialog, CookieImportTaskPanel, useCookieImportTask } from "./cookie-import-task-panel.tsx";
import { DesktopCloseHost, DesktopCloseRegistryProvider, useDesktopCloseDraft, useDesktopCloseRegistry } from "./desktop-close.tsx";
import { useDesktopMotion, usePanelMotion } from "./desktop-motion.tsx";
import { EnvironmentInspectionPage } from "./environment-inspection.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import { createExtensionDefaultDrafts } from "./extension-default-drafts.ts";
import { ExtensionsPage, type GroupDefaultsSnapshot } from "./extensions-page.tsx";
import { installExternalLinkHandler } from "./external-links.ts";
import { copyPlainText } from "./features/copy-field.tsx";
import { LogModal } from "./features/log-modal.tsx";
import { MoveFolderModal } from "./features/move-folder-modal.tsx";
import { ProfileCreateModal, ReuseRequestBanner, useProfileCreateModal, useSyncReuseCanOpen } from "./features/profile-create-modal.tsx";
import { ProfileDetailsPanel } from "./features/profile-details.tsx";
import { ProfileEditModal, useProfileEditModal } from "./features/profile-edit-modal.tsx";
import { downloadText, profileDownloads, UPDATE_TEMPLATE_CSV } from "./features/profile-form-helpers.tsx";
import { ProfileImportModal, useProfileImportModal } from "./features/profile-import-modal.tsx";
import type { ProfileRosterRowHandlers } from "./features/profile-roster-row.tsx";
import { ProfileRosterTable } from "./features/profile-roster-table.tsx";
import { RosterNavigation } from "./features/roster-navigation.tsx";
import { SettingsPanel } from "./features/settings-panel.tsx";
import { WorkbenchSidebar } from "./features/workbench-sidebar.tsx";
import { buildFingerprintAssistantBrief } from "./fingerprint-assistant-brief.ts";
import { useProfileMetrics } from "./hooks/use-profile-selection.ts";
import { applyProfileLifecyclePatch, useRosterEvents } from "./hooks/use-roster-events.ts";
import { CHECKBOX_COLUMN_WIDTH, COLUMNS, HIDDEN_COLUMNS_KEY, PAGE_SIZE_KEY, PAGE_SIZES, readHiddenColumns, readPageSize, useRosterQuery, type ColumnKey, type SortKey } from "./hooks/use-roster-query.ts";
import { I18nProvider, useTranslation } from "./i18n.tsx";
import { ImportReceiptPanel } from "./import-receipt.tsx";
import { LocalAssistantPage, type AssistantDraftSuggestion } from "./local-assistant.tsx";
import type { LocalProxyAssignmentIntent } from "./local-proxy-assignment-draft.tsx";
import { useNavigationMotion } from "./navigation-motion.ts";
import { ProfileFileUpdateDialog, ProfileFileUpdatePanel, useProfileFileUpdate } from "./profile-file-update-panel.tsx";
import { ProfileMoveFeedback, useProfileMove, type ProfileMoveResult } from "./profile-move.tsx";
import { changeProfileRangeSelection, reconcileProfileSelectionAnchor, type ProfileSelectionAnchor } from "./profile-range-selection.ts";
import { ProfileTagsDialog, type ProfileTagsTarget } from "./profile-tags.tsx";
import { ProxiesPage, type ProxyPageTask } from "./proxies.tsx";
import { ProfileResourceChip, ResourceDashboardDrawer, ResourceTopCapsule } from "./resource-dashboard.tsx";
import { formatMemoryBytes, hibernateProfile as hibernateProfileApi, trimProfileMemory as trimProfileMemoryApi, useResourceMonitor, watermarkConcurrency } from "./resource-monitor-api.ts";
import { pauseWindowSync, stopWindowSync, useWindowSyncState } from "./window-control-api.ts";
import { SyncEmergencyBar, WindowSyncPanel } from "./window-sync-panel.tsx";
import type { ProxyAssignmentSnapshot } from "./proxy-assignment-task.ts";
import { ROSTER_DENSITY_KEY, RosterDensityControl, parseRosterDensity, type RosterDensity } from "./roster-density.tsx";
import { RosterViews } from "./roster-views.tsx";
import { RuntimeDownloadProgressView, runtimeDownloadLabel } from "./runtime-download-progress.tsx";
import { ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
import type { FingerprintReport } from "./settings-api.ts";
import type { LocalProxyDraftCandidate } from "./settings-center.tsx";
import { ShortcutHelp } from "./shortcut-help.tsx";
import { useSignedUpdateStartup } from "./signed-updates.tsx";
import { readThemeChoice, THEME_KEY, themeCookie, type ThemeChoice } from "./theme.ts";
import { TrashPage } from "./trash.tsx";
import type { TrashTaskSnapshot } from "./trash-task.ts";
import { AppIcon, useConfirmDialog } from "./ui-primitives.tsx";
import { DesktopStartupBar, useWindowBackdrop, useWindowChrome, WindowActionError, WindowControls } from "./window-chrome.tsx";
import { WorkbenchActivity, type WorkbenchActivityItem } from "./workbench-activity.tsx";
import { getWorkbenchShortcut, readWorkbenchShortcutContext, type WorkbenchShortcutAction } from "./workbench-shortcuts.ts";
import { DevicePanel, useWorkspaceCatalog, WorkspaceActivity, WorkspaceManagementPage, WorkspaceProvider, WorkspaceSwitcher, type WorkspacePageIntent, type WorkspacePageRequest } from "./workspace-manager.tsx";
import { useWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { fetchWorkspacePreferences, saveWorkspacePreference } from "./workspaces-api.ts";

const emptyBulkSnapshot = (): BulkProfileTaskSnapshot | null => null;
const noBulkSubscription = (_listener: () => void) => () => {};
/** Run async tasks with bounded concurrency (so "Open 50" isn't 50 at once). */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0; const worker = async () => { while (i < items.length) await fn(items[i++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
const REFRESH_MS = 3000;
const PAGE_TITLES: Record<"profiles" | "inspection" | "scripts" | "settings" | "extensions" | "proxies" | "trash" | "workspaces" | "assistant", string> = {
  profiles: "Profiles", inspection: "Environment inspection", scripts: "Scripts", settings: "Settings",
  extensions: "Extensions", proxies: "Proxies", trash: "Trash", workspaces: "Workspace management", assistant: "AI workspace",
};
const SETTINGS_TABS = [
  { key: "account", label: "General" }, { key: "network", label: "Network & proxies" }, { key: "fingerprints", label: "Fingerprint quality" },
  { key: "models", label: "Model services" }, { key: "integrations", label: "AI & MCP" }, { key: "sync", label: "Sync & portability" },
  { key: "updates", label: "App updates" }, { key: "advanced", label: "Advanced" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];
const THEMES = [{ key: "system", label: "System", icon: "laptop" }, { key: "light", label: "Light", icon: "sun" }, { key: "dark", label: "Dark", icon: "moon" }] as const;
function readTheme(): ThemeChoice {
  let cookies = "", stored: string | null = null;
  try { cookies = document.cookie; } catch {} try { stored = localStorage.getItem(THEME_KEY); } catch {}
  return readThemeChoice(cookies, stored);
}
const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";
const RAIL_MEDIA = "(max-width: 760px)";
function readRailForced(): boolean { try { return window.matchMedia(RAIL_MEDIA).matches; } catch { return false; } }
function readSidebarCollapsed(): boolean { try { const stored = localStorage.getItem(SIDEBAR_KEY); return stored === "0" ? false : stored === "1" ? true : false; } catch { return true; } }
let preferenceRevision = 0;
function readFavorites(): string[] { try { return parseFavoriteProfiles(localStorage.getItem(FAVORITE_PROFILES_KEY)) ?? []; } catch { return []; } }
function readSavedViews(): SavedProfileView[] { try { return parseSavedProfileViews(localStorage.getItem(SAVED_PROFILE_VIEWS_KEY)) ?? []; } catch { return []; } }
function readRosterDensity(): RosterDensity { try { return parseRosterDensity(localStorage.getItem(ROSTER_DENSITY_KEY)); } catch { return "comfortable"; } }
function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / disabled storage */ }
  if ([HIDDEN_COLUMNS_KEY, PAGE_SIZE_KEY, SIDEBAR_KEY, GROUP_DISCLOSURE_KEY].includes(key)) {
    preferenceRevision++; void saveWorkspacePreference(key, value).catch((error) => window.dispatchEvent(new CustomEvent("workspace-preference-error", { detail: error instanceof Error ? error.message : String(error) })));
  }
}
const Icon = AppIcon;
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null), onClose = useRef(close); onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose.current(); }, onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return ref;
}
function MaobuMark({ className }: { className?: string }) { return <img className={className ? `maobu-mark ${className}` : "maobu-mark"} src={maobuMarkUrl} width={32} height={32} alt="" aria-hidden="true" />; }
type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
function desktopInvoke(): DesktopInvoke | undefined { return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined; }

function App() {
  const motion = useDesktopMotion(), { t, language, setLanguage } = useTranslation();
  useEffect(() => { if (typeof document !== "undefined") document.documentElement.lang = language; }, [language]);
  const { requestConfirm, confirmDialogNode, isConfirmOpen } = useConfirmDialog(), windowChrome = useWindowChrome();
  const { currentName: savedWorkspaceName, catalog, error: workspaceCatalogError, refresh: refreshWorkspaceCatalog } = useWorkspaceCatalog();
  const { coordinator: workspaceCoordinator, snapshot: workspaceOperationState } = useWorkspaceOperations();
  const signedUpdateStartup = useSignedUpdateStartup(catalog?.currentId), currentName = savedWorkspaceName || t("Local workspace");
  useEffect(() => { document.title = `${currentName} · 猫步·千境`; }, [currentName]);

  const [profiles, setProfiles] = useState<UiProfile[]>([]), [registeredGroups, setRegisteredGroups] = useState<string[]>([]), [localFolders, setLocalFolders] = useState<FolderInfo[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set()), [folderMenu, setFolderMenu] = useState<string | null>(null), [folderMenuPosition, setFolderMenuPosition] = useState({ left: 0, top: 0 });
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null), [movingFolder, setMovingFolder] = useState<string | null>(null), [folderParent, setFolderParent] = useState(""), [folderMoveBusy, setFolderMoveBusy] = useState(false), [folderMoveErr, setFolderMoveErr] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<AppModeConfig | null>(null), [appModeErr, setAppModeErr] = useState<string | null>(null), [authRequired, setAuthRequired] = useState(false), [authTokenInput, setAuthTokenInput] = useState(""), [authTokenErr, setAuthTokenErr] = useState<string | null>(null);
  const [runtimeDownloads, setRuntimeDownloads] = useState<RuntimeDownload[]>([]), [runtimeDownloadsStale, setRuntimeDownloadsStale] = useState(false);
  const runtimeTransfersObserved = useRef(false), initialDownloadsFetched = useRef(false);
  const bulkOwnerActive = useRef(true);
  const { loaded, connErr, connectionAlertDismissed, dismissConnectionAlert, retryConnection, refreshing, setRefreshing, load, readFreshRoster, lastRosterResult, transport } = useRosterEvents({
    enabled: !!appMode, sseEnabled: appMode?.eventsStream === true, intervalMs: REFRESH_MS, bulkOwnerActiveRef: bulkOwnerActive,
    onRoster: (roster) => { setProfiles(roster.profiles); setRegisteredGroups(roster.groups); setLocalFolders(roster.folders ?? []); },
    onLifecyclePatch: (ev) => {
      setProfiles((current) => {
        const patched = applyProfileLifecyclePatch({ profiles: current, groups: [], folders: [] }, ev);
        return patched.matched ? patched.roster.profiles : current;
      });
    },
    onDownloads: (downloads) => {
      initialDownloadsFetched.current = true;
      runtimeTransfersObserved.current = downloads.length > 0;
      setRuntimeDownloads(downloads);
      setRuntimeDownloadsStale(false);
    },
    onScriptRun: (run) => {
      try { backgroundScriptRuns.observe(run); } catch { /* Ignore malformed stream frames; explicit reads still validate. */ }
    },
  });
  const effectiveConnErr = appModeErr ?? connErr, [modeErr] = useState<string | null>(null);
  const [view, setView] = useState<"profiles" | "inspection" | "scripts" | "settings" | "extensions" | "proxies" | "trash" | "workspaces" | "assistant">("profiles");
  const [detailsTarget, setDetailsTarget] = useState<{ id: string; workspaceId: string | null } | null>(null);
  const detailsHeading = useRef<HTMLHeadingElement>(null), detailsTrigger = useRef<HTMLButtonElement | null>(null), focusDetailsOnOpen = useRef(false), settingsVisited = useRef(false);
  if (view === "settings") settingsVisited.current = true;
  const currentWorkspaceId = catalog?.currentId ?? null, detailsProfile = detailsTarget?.workspaceId === currentWorkspaceId ? profiles.find((profile) => profile.id === detailsTarget.id) ?? null : null;
  useLayoutEffect(() => { if (!detailsProfile || view !== "profiles" || !focusDetailsOnOpen.current) return; focusDetailsOnOpen.current = false; detailsHeading.current?.focus({ preventScroll: true }); }, [detailsProfile?.id, view]);
  useEffect(() => { setDetailsTarget(null); detailsTrigger.current = null; focusDetailsOnOpen.current = false; }, [currentWorkspaceId]);
  const closeDetails = () => { setDetailsTarget(null); const target = detailsTrigger.current; if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true }); else document.getElementById("profiles-page-title")?.focus({ preventScroll: true }); detailsTrigger.current = null; };
  const scriptsVisit = useRef({ workspaceId: currentWorkspaceId, visited: false });
  if (scriptsVisit.current.workspaceId !== currentWorkspaceId) scriptsVisit.current = { workspaceId: currentWorkspaceId, visited: false };
  if (view === "scripts") scriptsVisit.current.visited = true;

  const [trashTaskState, setTrashTaskState] = useState<{ workspaceId: string | null; snapshot: TrashTaskSnapshot } | null>(null), trashTaskSnapshot = trashTaskState?.workspaceId === currentWorkspaceId ? trashTaskState.snapshot : null;
  const [proxyTaskState, setProxyTaskState] = useState<{ workspaceId: string | null; snapshot: ProxyAssignmentSnapshot } | null>(null), proxyTaskSnapshot = proxyTaskState?.workspaceId === currentWorkspaceId ? proxyTaskState.snapshot : null;
  const publishProxyTask = useCallback((snapshot: ProxyAssignmentSnapshot) => setProxyTaskState({ workspaceId: currentWorkspaceId, snapshot }), [currentWorkspaceId]);
  const [proxyTaskFocusRequest, setProxyTaskFocusRequest] = useState<{ workspaceId: string } | null>(null);
  const completeProxyTaskFocus = useCallback(() => { setProxyTaskFocusRequest((request) => (request === proxyTaskFocusRequest ? null : request)); }, [proxyTaskFocusRequest]);
  useLayoutEffect(() => { if (proxyTaskFocusRequest && (view !== "proxies" || proxyTaskFocusRequest.workspaceId !== currentWorkspaceId)) completeProxyTaskFocus(); }, [view, currentWorkspaceId, proxyTaskFocusRequest, completeProxyTaskFocus]);

  const [localProxyIntent, setLocalProxyIntent] = useState<LocalProxyAssignmentIntent | null>(null), localProxySequence = useRef(0), localProxyTrigger = useRef<HTMLButtonElement | null>(null), returnToLocalProxy = useRef(false);
  const activeLocalProxyIntent = localProxyIntent?.workspaceId === currentWorkspaceId ? localProxyIntent : undefined;
  useLayoutEffect(() => { setLocalProxyIntent((previous) => (previous?.workspaceId === currentWorkspaceId ? previous : null)); localProxyTrigger.current = null; returnToLocalProxy.current = false; }, [currentWorkspaceId]);
  const navigationMotion = useNavigationMotion(view, !!appMode, motion.effective === "full");
  const [inspectionId, setInspectionId] = useState<string | null>(null), [workspacePageRequest, setWorkspacePageRequest] = useState<WorkspacePageRequest>({ mode: "manage", id: 0 });
  const [scriptRunOpen, setScriptRunOpen] = useState(false), [scriptRunProfiles, setScriptRunProfiles] = useState<UiProfile[]>([]), [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  useLayoutEffect(() => {
    if (view !== "settings" || settingsTab !== "network" || !returnToLocalProxy.current) return;
    returnToLocalProxy.current = false; const target = localProxyTrigger.current; localProxyTrigger.current = null;
    if (target?.isConnected && !target.disabled) target.focus(); else document.getElementById("settings-tab-network")?.focus();
  }, [view, settingsTab]);
  const startLocalProxyAssignment = (candidate: LocalProxyDraftCandidate, trigger: HTMLButtonElement) => {
    if (!currentWorkspaceId || workspaceCoordinator.getSnapshot().blocked || localProxyTrigger.current) return;
    localProxyTrigger.current = trigger; setLocalProxyIntent({ workspaceId: currentWorkspaceId, requestId: ++localProxySequence.current, candidate }); setView("proxies");
  };
  const dismissLocalProxyAssignment = (requestId: number, options?: { returnToSettings?: boolean }) => {
    if (activeLocalProxyIntent?.requestId !== requestId) return;
    setLocalProxyIntent(null); if (options?.returnToSettings) { returnToLocalProxy.current = true; setSettingsTab("network"); setView("settings"); } else localProxyTrigger.current = null;
  };
  const [fingerprintRefreshVersion, setFingerprintRefreshVersion] = useState(0), [assistantDraftSuggestion, setAssistantDraftSuggestion] = useState<AssistantDraftSuggestion | null>(null);
  const assistantDraftSequence = useRef(0), settingsPanelRef = useRef<HTMLDivElement>(null);
  usePanelMotion(settingsTab, view === "settings", settingsPanelRef);
  const updateTabRef = useRef<HTMLButtonElement>(null), focusUpdateTabOnOpen = useRef(false), focusRuntimePanelOnOpen = useRef(false);
  useLayoutEffect(() => { if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0; }, [settingsTab]);
  useLayoutEffect(() => { if (view !== "settings" || settingsTab !== "updates" || !focusUpdateTabOnOpen.current) return; focusUpdateTabOnOpen.current = false; updateTabRef.current?.focus({ preventScroll: true }); }, [view, settingsTab]);
  useLayoutEffect(() => { if (view !== "settings" || settingsTab !== "updates" || !focusRuntimePanelOnOpen.current) return; focusRuntimePanelOnOpen.current = false; focusRuntimePanel(); }, [view, settingsTab]);
  function focusRuntimePanel() { const target = settingsPanelRef.current?.querySelector<HTMLElement>("[data-browser-runtime-settings-heading]"); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start", behavior: "instant" }); }
  function viewRuntimeDownloads() { if (view === "settings" && settingsTab === "updates") { focusRuntimePanel(); return; } focusRuntimePanelOnOpen.current = true; setSettingsTab("updates"); setView("settings"); }
  function viewSignedUpdate() {
    signedUpdateStartup.dismissNotice();
    if (view === "settings" && settingsTab === "updates") { if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0; updateTabRef.current?.focus({ preventScroll: true }); }
    else { focusUpdateTabOnOpen.current = true; setSettingsTab("updates"); setView("settings"); }
  }
  const [commandOpen, setCommandOpen] = useState(false), [shortcutHelpOpen, setShortcutHelpOpen] = useState(false), shortcutAction = useRef<(action: WorkbenchShortcutAction) => void>(() => {});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { const action = getWorkbenchShortcut(event, { ...readWorkbenchShortcutContext(event.target), desktop: !!desktopInvoke(), commandPaletteOpen: commandOpen }); if (!action) return; event.preventDefault(); shortcutAction.current(action); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [commandOpen]);

  const [appVersion, setAppVersion] = useState(""), [aboutOpen, setAboutOpen] = useState(false), [githubUpdateAvailable, setGithubUpdateAvailable] = useState(false), aboutTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setGithubUpdateAvailable(false); }, [currentWorkspaceId]);
  const hasUpdateNotice = Boolean(signedUpdateStartup.noticeVersion || githubUpdateAvailable);
  const [logDir, setLogDir] = useState<string | undefined>(undefined), [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null), [diskWarningDismissed, setDiskWarningDismissed] = useState(false);
  const [logView, setLogView] = useState<{ file: string; content: string } | null>(null), [logErr, setLogErr] = useState<string | null>(null), [diag, setDiag] = useState<DiagnoseReport | null>(null), [showDiag, setShowDiag] = useState(false);
  const [q, setQ] = useState(""), [profileStatus, setProfileStatus] = useState<"all" | "running" | "stopped">("all"), [group, setGroup] = useState("all"), [profilePage, setProfilePage] = useState(0), [pageSize, setPageSize] = useState(readPageSize);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "no", dir: 1 });
  const [hiddenCols, setHiddenCols] = useState<Set<ColumnKey>>(readHiddenColumns), [rosterScope, setRosterScope] = useState<RosterScope>("all");
  const [favoriteProfiles, setFavoriteProfiles] = useState<string[]>(readFavorites), [savedProfileViews, setSavedProfileViews] = useState<SavedProfileView[]>(readSavedViews), [rosterDensity, setRosterDensity] = useState<RosterDensity>(readRosterDensity);
  const [viewPreferencesWorkspaceId, setViewPreferencesWorkspaceId] = useState<string | null>(null), viewPreferencesReady = currentWorkspaceId !== null && viewPreferencesWorkspaceId === currentWorkspaceId;
  const [viewPreferencesLoading, setViewPreferencesLoading] = useState(true), [viewPreferenceReadError, setViewPreferenceReadError] = useState<string | null>(null), [viewPreferenceBusy, setViewPreferenceBusy] = useState(false), [preferenceLoadAttempt, setPreferenceLoadAttempt] = useState(0), viewPreferenceWrite = useRef(false);
  const favoriteProfileIds = useMemo(() => new Set(favoriteProfiles), [favoriteProfiles]);
  const paletteSavedViews = useMemo(() => (viewPreferencesReady ? savedProfileViews.map(({ id, name, filters }) => ({ id, name, group: filters.group, scope: filters.scope, status: filters.status })) : []), [savedProfileViews, viewPreferencesReady]);
  const [colsOpen, setColsOpen] = useState(false), [groupDisclosure, setGroupDisclosure] = useState(() => readGroupDisclosure(null)), [groupManagerOpen, setGroupManagerOpen] = useState(false), [bulkToolsOpen, setBulkToolsOpen] = useState(false), [groupsOpen, setGroupsOpen] = useState(true);
  const groupDisclosureKey = useMemo(() => serializeGroupDisclosure(groupDisclosure), [groupDisclosure]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed), sidebarChoice = useRef<{ workspaceId: string | null } | null>(null), [railForced, setRailForced] = useState(readRailForced), sidebarIsCompact = sidebarCollapsed || railForced;
  const [tableScrolled, setTableScrolled] = useState(false), [theme, setTheme] = useState<ThemeChoice>(readTheme), [manualBusy, setBusy] = useState<Record<string, boolean>>({});
  const profileMove = useProfileMove({ readRoster: () => readFreshRoster() }), moveUiInFlight = useRef(false), moveDraftRevision = useRef(0);
  const [bulkTask, setBulkTask] = useState<BulkProfileTask | null>(null), bulkTaskRef = useRef<BulkProfileTask | null>(null), bulkBatchBusy = useRef(false);
  const bulkTaskLease = useRef<WorkspaceOperationLease | null>(null), bulkTaskWorkspace = useRef<string | null>(null), [bulkTaskExpanded, setBulkTaskExpanded] = useState(false), [bulkTaskRefreshing, setBulkTaskRefreshing] = useState(false);
  const bulkTaskSnapshot = useSyncExternalStore(bulkTask?.subscribe ?? noBulkSubscription, bulkTask?.getSnapshot ?? emptyBulkSnapshot, emptyBulkSnapshot), bulkTaskActive = !!bulkTaskSnapshot && bulkTaskSnapshot.phase !== "complete";
  const scriptBackground = useBackgroundScriptRun();
  const cookieImportLease = useRef<WorkspaceOperationLease | null>(null);
  const cookieImport = useCookieImportTask({
    workspaceId: () => catalog?.currentId ?? null,
    acquire: (workspaceId) => {
      const lease = workspaceCoordinator.acquire("profile-cookies", workspaceId); if (!lease) return null;
      cookieImportLease.current = lease;
      return { refreshing: () => workspaceCoordinator.setPhase(lease, "refreshing"), release: () => { workspaceCoordinator.release(lease); if (cookieImportLease.current === lease) cookieImportLease.current = null; } };
    },
    onSettled: async () => {
      if (!bulkOwnerActive.current) return;
      const lease = cookieImportLease.current, results = await Promise.allSettled([readFreshRoster(), lease ? workspaceCoordinator.refreshWorkspaceViews(lease) : Promise.resolve()]);
      const failure = results.find((result) => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    },
  });
  const cookieImportBusy = cookieImport.snapshot.phase === "sending" || cookieImport.snapshot.phase === "refreshing";
  const fileUpdateLease = useRef<WorkspaceOperationLease | null>(null), fileUpdatePanelRef = useRef<HTMLDivElement>(null);
  const fileUpdate = useProfileFileUpdate({
    workspaceId: () => catalog?.currentId ?? null,
    acquire: (workspaceId) => {
      const lease = workspaceCoordinator.acquire("profile-file-update", workspaceId); if (!lease) return null;
      fileUpdateLease.current = lease;
      return { refreshing: () => workspaceCoordinator.setPhase(lease, "refreshing"), release: () => { workspaceCoordinator.release(lease); if (fileUpdateLease.current === lease) fileUpdateLease.current = null; } };
    },
    onSettled: async () => {
      if (!bulkOwnerActive.current) return;
      const lease = fileUpdateLease.current, results = await Promise.allSettled([readFreshRoster(), lease ? workspaceCoordinator.refreshWorkspaceViews(lease) : Promise.resolve()]);
      const failure = results.find((result) => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    },
  });
  const fileUpdateBusy = fileUpdate.snapshot.phase === "sending" || fileUpdate.snapshot.phase === "refreshing";
  const latestProfiles = useRef(profiles); latestProfiles.current = profiles;
  const busy = useMemo(() => {
    const next = { ...manualBusy };
    for (const row of bulkTaskSnapshot?.rows ?? []) if (row.status === "pending" || row.status === "running") next[row.id] = true;
    if (profileMove.busy) for (const id of profileMove.state.attempt?.ids ?? []) next[id] = true;
    if (cookieImportBusy) for (const row of cookieImport.snapshot.rows) next[row.id] = true;
    if (fileUpdateBusy) for (const profile of profiles) next[profile.id] = true;
    return next;
  }, [manualBusy, bulkTaskSnapshot, profileMove.busy, profileMove.state.attempt, cookieImportBusy, cookieImport.snapshot, fileUpdateBusy, profiles]);
  useEffect(() => { bulkOwnerActive.current = true; return () => { bulkOwnerActive.current = false; bulkTaskRef.current?.stopPending(); }; }, []);

  const [actionErr, setActionErr] = useState<string | null>(null);
  const [launchFailureState, setLaunchFailureState] = useState<{ workspaceId: string | null; byId: ReadonlyMap<string, string> }>(() => ({ workspaceId: currentWorkspaceId, byId: new Map() }));
  const launchFailures = launchFailureState.workspaceId === currentWorkspaceId ? launchFailureState.byId : null, manualActions = useRef(new Set<string>());
  useEffect(() => {
    setLaunchFailureState((previous) => {
      if (previous.workspaceId !== currentWorkspaceId) return { workspaceId: currentWorkspaceId, byId: new Map() };
      if (!previous.byId.size) return previous;
      const stopped = new Set(profiles.filter((profile) => !profile.running).map((profile) => profile.id));
      const byId = new Map([...previous.byId].filter(([id]) => stopped.has(id)));
      return byId.size === previous.byId.size ? previous : { ...previous, byId };
    });
  }, [currentWorkspaceId, profiles]);

  useEffect(() => {
    if (!currentWorkspaceId) return;
    let alive = true; const revision = preferenceRevision;
    const ownsWorkspace = () => alive && workspaceCoordinator.getSnapshot().workspaceId === currentWorkspaceId;
    if (sidebarChoice.current?.workspaceId === null) sidebarChoice.current.workspaceId = currentWorkspaceId;
    setViewPreferencesWorkspaceId(null); setViewPreferencesLoading(true); setViewPreferenceReadError(null);
    void fetchWorkspacePreferences().then((preferences) => {
      if (!ownsWorkspace()) return;
      const favorites = parseFavoriteProfiles(preferences[FAVORITE_PROFILES_KEY] ?? "[]") ?? [], views = parseSavedProfileViews(preferences[SAVED_PROFILE_VIEWS_KEY] ?? "[]") ?? [], density = parseRosterDensity(preferences[ROSTER_DENSITY_KEY]);
      setRosterDensity(density); setFavoriteProfiles(favorites); setSavedProfileViews(views); setViewPreferencesWorkspaceId(currentWorkspaceId);
      for (const [key, value] of [[FAVORITE_PROFILES_KEY, JSON.stringify(favorites)], [SAVED_PROFILE_VIEWS_KEY, JSON.stringify(views)], [ROSTER_DENSITY_KEY, density]]) try { localStorage.setItem(key!, value!); } catch {}
      if (preferenceRevision !== revision) return;
      const preserveSidebarChoice = sidebarChoice.current?.workspaceId === currentWorkspaceId;
      for (const [key, value] of Object.entries(preferences)) { if (key === SIDEBAR_KEY && preserveSidebarChoice) continue; try { localStorage.setItem(key, value); } catch {} }
      if (preferences[HIDDEN_COLUMNS_KEY] !== undefined) {
        try { const keys: unknown = JSON.parse(preferences[HIDDEN_COLUMNS_KEY]!), known = new Set(COLUMNS.map((column) => column.key as string)); if (Array.isArray(keys)) setHiddenCols(new Set(keys.filter((key) => known.has(key)) as ColumnKey[])); } catch {}
      }
      const rawPageSize = preferences[PAGE_SIZE_KEY];
      if (rawPageSize !== undefined && rawPageSize.trim() !== "" && PAGE_SIZES.includes(Number(rawPageSize))) setPageSize(Number(rawPageSize));
      if (!preserveSidebarChoice && preferences[SIDEBAR_KEY] !== undefined) setSidebarCollapsed(preferences[SIDEBAR_KEY] === "1");
      setGroupDisclosure(readGroupDisclosure(preferences[GROUP_DISCLOSURE_KEY]));
    }).catch((error) => { if (ownsWorkspace()) setViewPreferenceReadError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (ownsWorkspace()) setViewPreferencesLoading(false); });
    return () => { alive = false; };
  }, [currentWorkspaceId, preferenceLoadAttempt, workspaceCoordinator]);

  useEffect(() => {
    const failed = (event: Event) => setActionErr(String((event as CustomEvent).detail));
    window.addEventListener("workspace-preference-error", failed); window.addEventListener("external-link-error", failed);
    return () => { window.removeEventListener("workspace-preference-error", failed); window.removeEventListener("external-link-error", failed); };
  }, []);

  const writeViewPreference = async (key: string, value: string): Promise<boolean> => {
    if (!viewPreferencesReady || viewPreferenceWrite.current || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return false;
    viewPreferenceWrite.current = true; setViewPreferenceBusy(true); setActionErr(null); preferenceRevision++;
    try {
      await saveWorkspacePreference(key, value);
      if (workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return false;
      try { localStorage.setItem(key, value); } catch {}
      return true;
    } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); return false; }
    finally { viewPreferenceWrite.current = false; setViewPreferenceBusy(false); }
  };
  const toggleFavorite = async (id: string) => {
    try { const next = favoriteProfiles.includes(id) ? favoriteProfiles.filter((value) => value !== id) : [...favoriteProfiles, id]; if (await writeViewPreference(FAVORITE_PROFILES_KEY, serializeFavoriteProfiles(next))) setFavoriteProfiles(next); }
    catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); }
  };
  const chooseRosterDensity = async (density: RosterDensity) => { if (density !== rosterDensity && await writeViewPreference(ROSTER_DENSITY_KEY, density)) setRosterDensity(density); };
  const saveProfileView = async (savedView: SavedProfileView): Promise<boolean> => { const next = [...savedProfileViews, savedView]; if (!await writeViewPreference(SAVED_PROFILE_VIEWS_KEY, serializeSavedProfileViews(next))) return false; setSavedProfileViews(next); return true; };
  const removeProfileView = async (id: string): Promise<boolean> => { const next = savedProfileViews.filter((savedView) => savedView.id !== id); if (!await writeViewPreference(SAVED_PROFILE_VIEWS_KEY, serializeSavedProfileViews(next))) return false; setSavedProfileViews(next); return true; };
  const chooseRosterScope = (scope: RosterScope) => { setRosterScope(scope); setQ(""); setGroup("all"); setProfileStatus("all"); setProfilePage(0); };
  const applyProfileView = (saved: SavedProfileView) => {
    const filters = saved.filters;
    setRosterScope(filters.scope); setQ(filters.query); setGroup(filters.group); setProfileStatus(filters.status);
    setSort(filters.sort); setHiddenCols(new Set(filters.hiddenColumns)); setPageSize(filters.pageSize); setProfilePage(0);
    writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify(filters.hiddenColumns)); writeSetting(PAGE_SIZE_KEY, String(filters.pageSize));
  };

  const { toasts, pushToast, dismissToast } = useToastStack();
  // ---- Transient feedback toast stack ----
  const flash = useCallback((m: string, tone: ToastTone = "success") => { pushToast(m, tone); }, [pushToast]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const latestSelection = useRef(selected); latestSelection.current = selected;
  const rangeSelectionAnchor = useRef<ProfileSelectionAnchor | null>(null), rangeKeyboardActivation = useRef<{ id: string; shiftKey: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false), deleteInFlight = useRef(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null), [newMode, setNewMode] = useState(false), [newGroup, setNewGroup] = useState(""), [dragging, setDragging] = useState(false);
  const [cookieTargets, setCookieTargets] = useState<UiProfile[] | null>(null), lastCookieTargets = useRef<UiProfile[]>([]);
  if (cookieTargets) lastCookieTargets.current = cookieTargets;
  const cookieTaskPanelRef = useRef<HTMLDivElement>(null), moveTaskPanelRef = useRef<HTMLDivElement>(null);
  const [tagsTarget, setTagsTarget] = useState<ProfileTagsTarget | null>(null), tagsReturnFocus = useRef<HTMLElement | null>(null);
  const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null), editorScroll: ScrollBehavior = motion.effective === "full" ? "smooth" : "instant";

  const [extensions, setExtensions] = useState<Extension[]>([]);
  const extensionWorkspaceId = catalog?.currentId ?? null, extensionWorkspace = useRef(extensionWorkspaceId); extensionWorkspace.current = extensionWorkspaceId;
  const [extensionDrafts] = useState(() => createExtensionDefaultDrafts(extensionWorkspaceId));
  const extensionDraftState = useSyncExternalStore(extensionDrafts.subscribe, extensionDrafts.getSnapshot, extensionDrafts.getSnapshot);
  const groupExtensionDefaults = useMemo<GroupExtensionDefaults[]>(() => extensionDraftState.groups.map((g) => ({ name: g.name, extensions: [...g.extensions] })), [extensionDraftState.groups]);
  const groupDefaultName = extensionDraftState.selectedGroup ?? "", groupDefaultExts = useMemo(() => [...(extensionDraftState.selected?.extensions ?? [])], [extensionDraftState.selected?.extensions]);
  const [extDataFresh, setExtDataFresh] = useState(false), extensionFresh = useRef(false);
  const markExtensionFresh = (fresh: boolean) => { extensionFresh.current = fresh; setExtDataFresh(fresh); };
  const [groupDefaultBusy, setGroupDefaultBusy] = useState(false), [extSource, setExtSource] = useState(""), [extInstallBusy, setExtInstallBusy] = useState(false), [extBusy, setExtBusy] = useState(false), [extErr, setExtErr] = useState<string | null>(null), [extLoading, setExtLoading] = useState(false), [extensionPageRefresh, setExtensionPageRefresh] = useState(0);
  const extensionReadVersion = useRef(0), extensionMutation = useRef(false);
  useLayoutEffect(() => { extensionReadVersion.current++; markExtensionFresh(false); extensionDrafts.setWorkspace(extensionWorkspaceId); setExtensions([]); setExtSource(""); }, [extensionWorkspaceId]);
  const [bulkExt, setBulkExt] = useState(""), [showUpdate, setShowUpdate] = useState(false), [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null), [renameVal, setRenameVal] = useState(""), [addingGroup, setAddingGroup] = useState(false), [sidebarGroupName, setSidebarGroupName] = useState("");
  const { profilesById, runningCount, selectedMobileCount, selectedProfilesSupportChromeExtensions } = useProfileMetrics(profiles, selected);
  const [resourceDrawerOpen, setResourceDrawerOpen] = useState(false), [windowSyncOpen, setWindowSyncOpen] = useState(false);
  const [proxyTabRequest, setProxyTabRequest] = useState<{ task: ProxyPageTask; seq: number } | null>(null);
  const resourceMonitor = useResourceMonitor({ enabled: !!appMode, runningCount, panelOpen: resourceDrawerOpen, eventsStream: appMode?.eventsStream === true });
  const latestMetricsRef = useRef(resourceMonitor.snapshot); latestMetricsRef.current = resourceMonitor.snapshot;
  const { syncState, setSyncState } = useWindowSyncState(!!appMode);
  const renderResourceChips = useCallback((profile: UiProfile) => {
    const metrics = profile.running ? resourceMonitor.byProfileId.get(profile.id) : undefined;
    const hibernated = !profile.running && resourceMonitor.hibernatedIds.has(profile.id);
    return metrics || hibernated ? <ProfileResourceChip metrics={metrics} hibernated={hibernated} /> : null;
  }, [resourceMonitor.byProfileId, resourceMonitor.hibernatedIds]);

  const saveGroupDisclosure = (next: Map<string, boolean>) => { const value = serializeGroupDisclosure(next); setGroupDisclosure(readGroupDisclosure(value)); writeSetting(GROUP_DISCLOSURE_KEY, value); };
  const toggleProfileGroup = (name: string, collapsed: boolean) => { const next = new Map(groupDisclosure); next.delete(name); next.set(name, !collapsed); saveGroupDisclosure(next); };
  const refreshImportedProfiles = async () => { await readFreshRoster(); };
  const editSessionOpenRef = useRef<() => boolean>(() => false), cancelReuseReadRef = useRef<() => void>(() => {});
  const createModal = useProfileCreateModal({
    appMode, group, profiles, editorScroll, isEditSessionOpen: () => editSessionOpenRef.current(),
    onCreated: async (createdGroup) => { const next = new Map(groupDisclosure); next.set(createdGroup, false); saveGroupDisclosure(next); await load(); }, t,
  });
  const editModal = useProfileEditModal({
    busy, profilesById, extensions, editorScroll, requestConfirm, onLoadRoster: load,
    onRefreshQualityAfterEdit: () => {
      if (view === "settings" && settingsTab === "fingerprints") editModal.setReturnFocusElement(document.getElementById("settings-tab-fingerprints"));
      if (view === "inspection") editModal.setReturnFocusElement(document.getElementById("inspection-page-title"));
      setFingerprintRefreshVersion((version) => version + 1);
    },
    onFlash: flash, onActionError: setActionErr, onCancelReuseRead: () => cancelReuseReadRef.current(), t,
  });
  editSessionOpenRef.current = editModal.isEditSessionOpen; cancelReuseReadRef.current = createModal.cancelReuseRead;
  const importModal = useProfileImportModal({
    workspaceId: catalog?.currentId, workspaceCoordinator, bulkOwnerActiveRef: bulkOwnerActive,
    onLoadRoster: load, onRefreshImportedProfiles: refreshImportedProfiles, onActionError: setActionErr, onFlash: flash, onOpenProfilesView: () => setView("profiles"), t,
  });
  const reuseCanOpen = view === "profiles" && !createModal.showCreate && !editModal.editId && !importModal.showBulk && !showUpdate && !cookieTargets && !importModal.pendingView
    && !movingFolder && !logView && !logErr && !scriptRunOpen && !commandOpen && !shortcutHelpOpen && !tagsTarget && !showDiag && !resourceDrawerOpen && !windowSyncOpen;
  useSyncReuseCanOpen(createModal, reuseCanOpen);

  useWindowBackdrop(theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply(); if (theme !== "system") return;
    media.addEventListener("change", apply); return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => { const media = window.matchMedia(RAIL_MEDIA), apply = () => setRailForced(media.matches); media.addEventListener("change", apply); return () => media.removeEventListener("change", apply); }, []);

  const escapeHandlerRef = useRef<() => void>(() => {});
  escapeHandlerRef.current = () => {
    if (isConfirmOpen) return;
    if (windowSyncOpen) { setWindowSyncOpen(false); return; }
    if (resourceDrawerOpen) { setResourceDrawerOpen(false); return; }
    if (movingFolder) { if (!folderMoveBusy) setMovingFolder(null); return; }
    if (logView || logErr) { setLogView(null); setLogErr(null); return; }
    if (showUpdate) { setShowUpdate(false); return; }
    if (importModal.showBulk) { importModal.closeBulk(); return; }
    if (importModal.pendingView) { importModal.closePendingCookies(); return; }
    if (cookieTargets) { closeCookie(); return; }
    if (editModal.editId) { editModal.closeEdit(); return; }
    if (createModal.showCreate) createModal.closeCreate();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return; escapeHandlerRef.current(); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, []);

  const openSettings = () => setView("settings");
  const openExtensions = () => { setExtErr(null); setExtLoading(true); if (view === "extensions") setExtensionPageRefresh((value) => value + 1); else setView("extensions"); };
  const openInspection = (id: string) => { if (editModal.isEditSessionOpen()) return; setInspectionId(id); setView("inspection"); };
  const backFromInspection = () => {
    setView("profiles");
    requestAnimationFrame(() => { const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find((item) => item.dataset.profileId === inspectionId); (row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? document.getElementById("profiles-page-title"))?.focus({ preventScroll: true }); });
  };
  const openWorkspaceManagement = (intent: WorkspacePageIntent) => { setWorkspacePageRequest((current) => ({ ...intent, id: current.id + 1 })); setView("workspaces"); };
  const showRunningProfiles = () => { setRosterScope("all"); setQ(""); setGroup("all"); setSelected(new Set()); setProfilePage(0); setProfileStatus("running"); setView("profiles"); };

  const loadAppMode = useCallback(() => {
    fetchAppMode().then((config) => { setAuthRequired(false); setAuthTokenErr(null); setAppModeErr(null); setAppMode({ ...config, mode: "local", localAnalytics: false }); })
      .catch((error) => { if (isUnauthorizedError(error)) setAuthRequired(true); setAppModeErr(error instanceof Error ? error.message : String(error)); });
  }, []);
  useEffect(() => { loadAppMode(); }, [loadAppMode]);
  useEffect(() => subscribeUnauthorized(() => { setAuthRequired(true); }), []);
  useEffect(() => { const invoke = desktopInvoke(); if (!appMode || !invoke) return; void invoke("agent_runtime_ready", { readiness: "local" }).catch(() => undefined); }, [appMode]);
  useEffect(() => {
    if (!appMode) return; load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch((error) => console.warn("[health]", error));
    fetchDiagnose().then(setDiag).catch((error) => console.warn("[diagnose]", error));
  }, [appMode]);
  useEffect(() => {
    if (!appMode || !extensionWorkspaceId) return;
    const generation = ++extensionReadVersion.current;
    void fetchExtensions().then((items) => { if (generation === extensionReadVersion.current && extensionWorkspace.current === extensionWorkspaceId) setExtensions(items); }).catch((error) => console.warn("[extensions]", error));
  }, [appMode, extensionWorkspaceId]);
  useEffect(() => {
    if (view !== "extensions" || !appMode || !extensionWorkspaceId) return;
    let alive = true; const generation = ++extensionReadVersion.current;
    setExtLoading(true); markExtensionFresh(false);
    void Promise.allSettled([fetchExtensions(), fetchGroupExtensionDefaults(), readFreshRoster()]).then((results) => {
      if (!alive || generation !== extensionReadVersion.current || extensionWorkspace.current !== extensionWorkspaceId) return;
      if (results[0].status === "fulfilled") setExtensions(results[0].value);
      if (results[1].status === "fulfilled") extensionDrafts.receive(extensionWorkspaceId, results[1].value);
      const failed = results.find((result) => result.status === "rejected");
      markExtensionFresh(!failed); setExtErr(failed ? t("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes.") : null);
    }).finally(() => { if (alive && generation === extensionReadVersion.current) setExtLoading(false); });
    return () => { alive = false; if (generation === extensionReadVersion.current) extensionReadVersion.current++; setExtLoading(false); };
  }, [view, appMode, extensionPageRefresh, extensionWorkspaceId]);
  useEffect(() => {
    let live = true, lastCheckedAt = 0;
    const runCheck = () => { lastCheckedAt = Date.now(); void fetchDiskSpace().then((next) => { if (live) setDiskSpace(next); }).catch((error) => console.warn("[disk-space]", error)); };
    const check = () => { if (typeof document !== "undefined" && document.hidden) return; runCheck(); };
    const onVisibility = () => { if (typeof document !== "undefined" && !document.hidden && Date.now() - lastCheckedAt >= 60_000) runCheck(); };
    check(); const timer = setInterval(check, 60_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => { live = false; clearInterval(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  const anyBusy = Object.values(busy).some(Boolean);
  useEffect(() => {
    if (transport === "sse" && initialDownloadsFetched.current) return;
    let live = true, timer: number | undefined, failures = 0;
    const poll = () => {
      void fetchRuntimeDownloads().then((next) => {
        if (!live) return;
        initialDownloadsFetched.current = true;
        failures = 0; runtimeTransfersObserved.current = next.length > 0; setRuntimeDownloads(next); setRuntimeDownloadsStale(false);
        if (transport !== "sse" && (next.length > 0 || anyBusy)) timer = window.setTimeout(poll, 1000);
      }).catch(() => {
        if (!live) return;
        setRuntimeDownloadsStale(true); failures++;
        if (transport !== "sse" && (anyBusy || runtimeTransfersObserved.current || failures === 1)) timer = window.setTimeout(poll, 1000 * 2 ** Math.min(3, failures - 1));
      });
    };
    poll(); return () => { live = false; window.clearTimeout(timer); };
  }, [anyBusy, profiles.length, transport]);

  const {
    deferredQ, folders, tree, folderLabels, groups, existingGroups, missingRosterGroup, hasRosterRefinements,
    breadcrumb, numbering, matchingProfiles, matchingRunningCount, filtered, profilePageCount, visibleProfilePage,
    revealGroupMatches, selectableProfiles, rangeVisibleIds, flatItems, rosterViewCounts, folderCounts,
  } = useRosterQuery({ profiles, registeredGroups, localFolders, loaded, q, group, profileStatus, sort, pageSize, profilePage, rosterScope, favoriteProfileIds, groupDisclosure, launchFailures });
  const clearRosterRefinements = () => { setQ(""); setGroup("all"); setProfileStatus("all"); setProfilePage(0); };
  const selectFolder = (name: string) => { setGroup(name); setView("profiles"); }, folderLabel = (name: string) => folderLabels.get(name) ?? name, countFor = (g: string) => folderCounts.get(g) ?? 0;
  const previousProfileFilters = useRef({ q, group, pageSize, profileStatus });
  useEffect(() => {
    const previous = previousProfileFilters.current;
    const filtersChanged = previous.q !== q || previous.group !== group || previous.pageSize !== pageSize || previous.profileStatus !== profileStatus;
    previousProfileFilters.current = { q, group, pageSize, profileStatus };
    const nextPage = filtersChanged ? 0 : visibleProfilePage; if (profilePage !== nextPage) setProfilePage(nextPage);
  }, [q, group, pageSize, profileStatus, profilePage, visibleProfilePage]);

  const rangeViewKey = JSON.stringify([catalog?.currentId ?? "", view, rosterScope, deferredQ, group, profileStatus, sort.key, sort.dir, visibleProfilePage, pageSize]);
  rangeSelectionAnchor.current = reconcileProfileSelectionAnchor(rangeSelectionAnchor.current, rangeViewKey, rangeVisibleIds);
  const folderMenuRef = useDismiss<HTMLSpanElement>(folderMenu !== null, () => setFolderMenu(null)), colsRef = useDismiss<HTMLDivElement>(colsOpen, () => setColsOpen(false));
  const groupManagerRef = useDismiss<HTMLDivElement>(groupManagerOpen, () => { setGroupManagerOpen(false); setFolderMenu(null); }), exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false));
  useEffect(() => { if (selected.size === 0) setBulkToolsOpen(false); }, [selected.size]);

  const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
  const toggleColumn = (key: ColumnKey) => setHiddenCols((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify([...next])); return next; });
  const applyPageSize = (size: number) => { setPageSize(size); writeSetting(PAGE_SIZE_KEY, String(size)); };
  const chooseTheme = (choice: ThemeChoice) => { setTheme(choice); writeSetting(THEME_KEY, choice); try { document.cookie = themeCookie(choice); } catch {} };
  const toggleSidebar = () => { sidebarChoice.current = { workspaceId: workspaceCoordinator.getSnapshot().workspaceId }; setSidebarCollapsed((collapsed) => { writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1"); return !collapsed; }); };
  const toggleSort = (key: SortKey) => setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const refreshRoster = async () => { setRefreshing(true); try { await Promise.all([load(), Promise.resolve()]); } finally { setRefreshing(false); } };

  const changeProfileSelection = (id: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const keyboard = rangeKeyboardActivation.current; rangeKeyboardActivation.current = null;
    const result = changeProfileRangeSelection({
      selected: latestSelection.current, visibleIds: rangeVisibleIds, viewKey: rangeViewKey, anchor: rangeSelectionAnchor.current,
      id, checked: event.currentTarget.checked, shiftKey: !!(event.nativeEvent as MouseEvent).shiftKey || (keyboard?.id === id && keyboard.shiftKey),
    });
    rangeSelectionAnchor.current = result.anchor; latestSelection.current = result.selected; setSelected(result.selected);
  };
  const allVisibleSelected = selectableProfiles.length > 0 && selectableProfiles.every((p) => selected.has(p.id));
  const selectedFilteredCount = filtered.filter((p) => selected.has(p.id)).length, selectedOutsideFilter = selected.size - selectedFilteredCount, allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length && selectedOutsideFilter === 0;
  const selectionKind = q.trim() ? t("matching profiles") : t("profiles"), selectionScope = group === "all" ? t("{count} {kind}", { count: filtered.length.toLocaleString(), kind: selectionKind }) : t("{count} {kind} in “{group}”", { count: filtered.length.toLocaleString(), kind: selectionKind, group });
  const selectAllFiltered = () => setSelected(new Set(filtered.map((p) => p.id)));
  const toggleAll = () => setSelected((s) => { const n = new Set(s); if (allVisibleSelected) selectableProfiles.forEach((p) => n.delete(p.id)); else selectableProfiles.forEach((p) => n.add(p.id)); return n; });

  const completeMove = (result: ProfileMoveResult | null, selection: Set<string>, draftRevision: number) => {
    if (!result || !bulkOwnerActive.current || !result.confirmedIds.length) return;
    const unchangedSelection = latestSelection.current === selection, confirmed = new Set(result.confirmedIds);
    setSelected((current) => (current === selection ? new Set([...current].filter((id) => !confirmed.has(id))) : current));
    if (unchangedSelection && !result.unresolvedIds.length && moveDraftRevision.current === draftRevision && (newMode ? newGroup.trim() : moveTarget) === result.attempt.group) { moveDraftRevision.current++; setNewMode(false); setNewGroup(""); setMoveTarget(null); }
  };
  const runMoveAction = async (action: () => Promise<ProfileMoveResult | null>) => {
    if (moveUiInFlight.current || profileMove.busy) return;
    const selection = latestSelection.current, revision = moveDraftRevision.current;
    moveUiInFlight.current = true; setActionErr(null);
    try { completeMove(await action(), selection, revision); }
    catch { if (bulkOwnerActive.current) setActionErr(t("The move could not be confirmed. Check the result before trying again.")); }
    finally { moveUiInFlight.current = false; }
  };
  const moveSelected = () => { const ids = [...selected], destination = newMode ? newGroup.trim() : moveTarget; if (ids.length && destination !== null && (!newMode || !!destination)) void runMoveAction(() => profileMove.submit({ ids, group: destination })); };
  const deleteSelected = async () => {
    const ids = [...selected]; if (ids.length === 0 || deleteInFlight.current) return;
    const confirmed = await requestConfirm({ title: t("Move to Trash"), message: t("Move all {count} selected environments to Trash? This includes every selected page. You can restore them with their saved data.", { count: ids.length.toLocaleString() }), confirmLabel: t("Move to Trash"), cancelLabel: t("Cancel"), tone: "danger" });
    if (!confirmed || deleteInFlight.current) return;
    deleteInFlight.current = true; setDeleting(true); setActionErr(null);
    try {
      const r = await deleteProfiles(ids); if (r.ok === false) { setActionErr(r.error || t("Delete failed")); return; }
      const problems = [r.locked?.length && t("{count} in use, not deleted", { count: r.locked.length }), r.failed?.length && t("{count} failed", { count: r.failed.length })].filter(Boolean);
      if (problems.length) setActionErr(t("{problems}. These profiles remain selected.", { problems: problems.join("; ") }));
      setSelected(new Set([...(r.locked ?? []), ...(r.failed ?? [])])); flash(t("{count} profiles moved to Trash", { count: r.deleted.toLocaleString() })); await load();
    } catch (e) { setActionErr(String(e)); } finally { deleteInFlight.current = false; setDeleting(false); }
  };

  const setLaunchFailure = (id: string, message: string | null) => setLaunchFailureState((previous) => {
    const current = previous.workspaceId === currentWorkspaceId ? previous.byId : null; if (message === null && !current?.has(id)) return previous;
    const byId = new Map(current); if (message === null) byId.delete(id); else byId.set(id, message); return { workspaceId: currentWorkspaceId, byId };
  });
  const act = async (id: string, fn: (id: string) => Promise<any>) => {
    if (busy[id] || manualActions.current.has(id)) return;
    const starting = fn === openProfile || fn === restartProfile, workspaceId = workspaceCoordinator.getSnapshot().workspaceId;
    const ownsResult = () => bulkOwnerActive.current && workspaceCoordinator.getSnapshot().workspaceId === workspaceId;
    const recordFailure = (message: string) => { if (starting && lastRosterResult.current?.profiles.some((profile) => profile.id === id && !profile.running)) setLaunchFailure(id, message); else setActionErr(message); };
    manualActions.current.add(id); setActionErr(null); setBusy((current) => ({ ...current, [id]: true }));
    try {
      const result = await fn(id); if (!ownsResult()) return; await load(); if (!ownsResult()) return;
      if (result?.ok === false) recordFailure(typeof result.error === "string" && result.error ? result.error : "action failed");
      else { if (starting) setLaunchFailure(id, null); if (typeof result?.warning === "string" && result.warning) setActionErr(result.warning); }
    } catch (error) { if (ownsResult()) await load().catch(() => {}); if (ownsResult()) recordFailure(error instanceof Error ? error.message : String(error)); }
    finally { manualActions.current.delete(id); if (bulkOwnerActive.current) setBusy((current) => { const next = { ...current }; delete next[id]; return next; }); }
  };
  const openLabel = (profile: UiProfile) => {
    if (!busy[profile.id]) return t(launchFailures?.has(profile.id) ? "Retry" : "Start");
    const waiting = profileDownloads(profile, runtimeDownloadsStale ? [] : runtimeDownloads);
    return waiting.length > 0 ? runtimeDownloadLabel(waiting, t) : t("Opening…");
  };
  const openCookie = (targets: UiProfile[]) => { setCookieTargets([...targets]); }, closeCookie = () => { setCookieTargets(null); };
  const showCookieImportTask = () => { setView("profiles"); requestAnimationFrame(() => { cookieTaskPanelRef.current?.focus({ preventScroll: true }); cookieTaskPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }); };
  const explainFingerprint = (report: FingerprintReport) => {
    if (editModal.isEditSessionOpen()) return;
    setAssistantDraftSuggestion({ id: ++assistantDraftSequence.current, text: buildFingerprintAssistantBrief(report, t), source: { title: t("Inspection for {profile}", { profile: report.name || t("Unnamed profile") }), description: t("Review the selected fingerprint findings, then return to the report to verify your changes."), returnKey: report.profileId } });
    setView("assistant");
  };

  // ---- Extensions manager (Store URL / upload / delete) ----
  const refreshExtensionState = async () => {
    const workspaceId = extensionWorkspace.current, generation = ++extensionReadVersion.current;
    setExtLoading(true); markExtensionFresh(false);
    const registry = await Promise.allSettled([fetchExtensions(), fetchGroupExtensionDefaults(), readFreshRoster()]);
    if (generation !== extensionReadVersion.current || workspaceId !== extensionWorkspace.current || !bulkOwnerActive.current) return false;
    if (registry[0]?.status === "fulfilled") setExtensions(registry[0].value as Extension[]);
    if (registry[1]?.status === "fulfilled") extensionDrafts.receive(workspaceId, registry[1].value as GroupExtensionDefaults[]);
    setExtLoading(false);
    const fresh = registry.every((result) => result.status === "fulfilled"); markExtensionFresh(fresh);
    setExtErr(fresh ? null : t("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes."));
    return fresh;
  };
  const toggleGroupDefaultExt = (id: string) => extensionDrafts.toggle(id);
  const applyGroupExtensionDefault = async (snapshot: GroupDefaultsSnapshot): Promise<boolean> => {
    if (!snapshot.group || !/^[a-f0-9]{64}$/.test(snapshot.expectedFingerprint ?? "") || !extensionFresh.current || extensionMutation.current) return false;
    const workspaceId = extensionWorkspace.current;
    extensionMutation.current = true; setGroupDefaultBusy(true); setExtErr(null); markExtensionFresh(false);
    try {
      const result = await setGroupExtensionDefaults(snapshot.group, snapshot.extensions, snapshot.expectedFingerprint);
      if (!bulkOwnerActive.current || workspaceId !== extensionWorkspace.current) return result.ok === true;
      if (result.ok !== true || !Number.isSafeInteger(result.updatedCount) || result.updatedCount < 0) { setExtErr(result.error || t("Could not apply extension defaults.")); return false; }
      extensionDrafts.acknowledge(workspaceId, snapshot.group, snapshot.extensions);
      setProfiles((current) => current.map((profile) => (profile.group === snapshot.group ? { ...profile, extensions: profile.engine === "firefox" ? [] : [...snapshot.extensions] } : profile)));
      if (!await refreshExtensionState()) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t("Updated extension defaults for {group} on {count} environments. Reopen browsers to apply.", { group: snapshot.group, count: result.updatedCount }));
      return true;
    } catch (error) { setExtErr(error instanceof Error ? error.message : String(error)); return false; }
    finally { extensionMutation.current = false; setGroupDefaultBusy(false); }
  };
  const doInstallWebStoreExtension = async (): Promise<boolean> => {
    const source = extSource.trim(); if (!source) { setExtErr(t("Paste a Chrome Web Store URL or extension ID")); return false; }
    if (extensionMutation.current) return false;
    extensionMutation.current = true; setExtInstallBusy(true); setExtErr(null);
    try {
      const r = await installWebStoreExtension(source);
      if (r.ok !== true) { setExtErr(r.error || t("Could not install extension.")); return false; }
      setExtSource("");
      if (r.installed?.id && r.installed?.name) setExtensions((current) => [...current.filter((item) => item.id !== r.installed.id), r.installed]);
      if (!await refreshExtensionState()) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t(r.alreadyInstalled ? "{extension} is already installed." : "Installed {extension}. Assign it to an environment to use it.", { extension: r.installed?.name ?? t("Extension") }));
      return true;
    } catch (error) { setExtErr(error instanceof Error ? error.message : String(error)); return false; }
    finally { extensionMutation.current = false; setExtInstallBusy(false); }
  };
  const doUploadExtensions = async (files: FileList | File[]): Promise<boolean> => {
    const list = Array.from(files); if (!list.length || extensionMutation.current) return false;
    extensionMutation.current = true; setExtBusy(true); setExtErr(null);
    let installed = 0; const failed: string[] = [];
    try {
      for (const file of list) {
        try {
          const r = await uploadExtensions([file]); if (r.ok !== true) throw new Error(r.error || t("Could not upload extension."));
          installed++; if (Array.isArray(r.installed)) setExtensions((current) => [...current.filter((item) => !r.installed.some((added: Extension) => added.id === item.id)), ...r.installed]);
        } catch (error) { failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const refreshed = await refreshExtensionState();
      if (failed.length) setExtErr(t("Installed {installed} files; {failed} failed. Retry only the failed files: {details}", { installed, failed: failed.length, details: failed.join("; ") }));
      else if (!refreshed) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      if (installed) flash(t("Installed {count} extension files. Assign them to environments to use them.", { count: installed }));
      return failed.length === 0;
    } finally { extensionMutation.current = false; setExtBusy(false); }
  };
  const doRemoveExtension = async (id: string, name: string): Promise<boolean> => {
    if (extensionMutation.current) return false;
    const workspaceId = extensionWorkspace.current;
    extensionMutation.current = true; setExtBusy(true); setExtErr(null); markExtensionFresh(false);
    try {
      const r = await removeExtension(id);
      if (!bulkOwnerActive.current || workspaceId !== extensionWorkspace.current) return r.ok === true;
      if (r.ok !== true) { setExtErr(r.error || t("Could not remove extension.")); return false; }
      setExtensions((current) => current.filter((item) => item.id !== id));
      extensionDrafts.removeConfirmed(workspaceId, id); editModal.removeExtensionFromDraft(id);
      setProfiles((current) => current.map((profile) => (profile.extensions ? { ...profile, extensions: profile.extensions.filter((item) => item !== id) } : profile)));
      if (!await refreshExtensionState()) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t("Removed {extension} and its environment assignments.", { extension: name }));
      return true;
    } catch (error) { setExtErr(error instanceof Error ? error.message : String(error)); return false; }
    finally { extensionMutation.current = false; setExtBusy(false); }
  };
  const bulkAssignExt = async (op: "add" | "remove") => {
    const ids = [...selected]; if (!ids.length || !bulkExt) return;
    setActionErr(null);
    try {
      const r = await assignExtensionBulk(ids, bulkExt, op);
      if (r.ok === false) { setActionErr(r.error || t("Extension assignment failed")); return; }
      await load(); const name = extensions.find((x) => x.id === bulkExt)?.name ?? t("extension");
      flash(t(op === "add" ? "Added “{name}” to {count} profile(s)" : "Removed “{name}” from {count} profile(s)", { name, count: r.updated }));
    } catch (e) { setActionErr(String(e)); }
  };

  // ---- 2FA quick-copy (row authenticator button) ----
  const copy2fa = async (id: string) => {
    setActionErr(null);
    try {
      const r = await fetchTotp(id); if (!r.code) { setActionErr(t("No 2FA secret on this profile")); return; }
      try { await copyPlainText(r.code); } catch (copyError) { setActionErr(copyError instanceof Error ? copyError.message : t("Could not copy to clipboard.")); return; }
      setTwoFaFlash({ id, code: r.code }); setTimeout(() => setTwoFaFlash((f) => (f && f.id === id ? null : f)), 4000);
    } catch (e) { setActionErr(String(e)); }
  };

  // ---- Bulk launch / stop / restart ----
  const finishBulkTask = async (task: BulkProfileTask, pending: Promise<BulkProfileTaskSnapshot>, lease: WorkspaceOperationLease) => {
    try {
      const result = await pending;
      if (!bulkOwnerActive.current || bulkTaskRef.current !== task) return;
      if (result.summary.failed) setBulkTaskExpanded(true);
      setBulkTaskRefreshing(true); workspaceCoordinator.setPhase(lease, "refreshing");
      await Promise.all([load(), workspaceCoordinator.refreshWorkspaceViews(lease)]);
    } catch (error) { if (bulkOwnerActive.current && bulkTaskRef.current === task) setActionErr(error instanceof Error ? error.message : String(error)); }
    finally {
      workspaceCoordinator.release(lease); if (bulkTaskLease.current === lease) bulkTaskLease.current = null;
      if (bulkOwnerActive.current && bulkTaskRef.current === task) { bulkBatchBusy.current = false; setBulkTaskRefreshing(false); }
    }
  };
  const bulkRun = (action: BulkProfileAction) => {
    if (!selected.size) return;
    if (bulkBatchBusy.current || (bulkTaskRef.current && bulkTaskRef.current.getSnapshot().phase !== "complete")) {
      setBulkTaskExpanded(true); setActionErr(t("A batch task is already running. Review it before starting another.")); return;
    }
    const targets = [...selected].map((id) => {
      const profile = profiles.find((item) => item.id === id);
      const skipReason = !profile ? "This environment is no longer in the current list."
        : manualBusy[id] ? "Another action is already using this environment."
        : action === "open" && profile.mobilePersona ? "Convert the imported mobile identity before starting this environment."
        : action === "open" && profile.running ? "This environment is already running."
        : action !== "open" && !profile.running ? "This environment is already stopped." : undefined;
      return { id, name: profile?.name || id, skipReason };
    });
    const task = createBulkProfileTask({ action, targets, concurrency: 4, run: async id => {
      if (!workspaceCoordinator.canContinueBatch(bulkTaskLease.current, bulkTaskWorkspace.current)) {
        bulkTaskRef.current?.stopPending(); return { ok: false, error: "The workspace changed while this task was waiting. No request was sent." };
      }
      const profile = latestProfiles.current.find((item) => item.id === id);
      if (!profile) return { ok: false, error: "This environment is no longer in the current list." };
      if (action === "open" && profile.running) return { ok: true, warning: "Already running; no extra start request was sent." };
      if (action === "close" && !profile.running) return { ok: true, warning: "Already stopped; no extra close request was sent." };
      if (action === "restart" && !profile.running) return { ok: false, error: "The environment stopped before the restart. Start it explicitly if needed." };
      return (action === "open" ? openProfile : action === "close" ? closeProfile : restartProfile)(id);
    }, ...(action === "open" ? { getConcurrency: () => watermarkConcurrency(latestMetricsRef.current) } : {}) });
    const lease = workspaceCoordinator.acquire("profile-batch", catalog?.currentId);
    if (!lease) { setActionErr(t(workspaceOperationMessage(workspaceCoordinator.getSnapshot()))); return; }
    bulkTaskLease.current = lease; bulkTaskWorkspace.current = lease.workspaceId;
    bulkTaskRef.current = task; bulkBatchBusy.current = true; setBulkTask(task); setBulkTaskExpanded(false); setBulkTaskRefreshing(false); setActionErr(null);
    void finishBulkTask(task, task.start(), lease);
  };
  const openSelected = () => bulkRun("open");
  const closeSelected = () => bulkRun("close");
  const retryBulkFailures = () => {
    if (bulkBatchBusy.current) return;
    const task = bulkTaskRef.current;
    if (!task || task.getSnapshot().phase !== "complete" || !task.getSnapshot().summary.failed) return;
    const lease = workspaceCoordinator.acquire("profile-batch", bulkTaskWorkspace.current);
    if (!lease) { setActionErr(t(workspaceOperationMessage(workspaceCoordinator.getSnapshot()))); return; }
    bulkTaskLease.current = lease; const pending = task.retryFailed();
    if (pending) { bulkBatchBusy.current = true; setBulkTaskExpanded(true); void finishBulkTask(task, pending, lease); }
    else { workspaceCoordinator.release(lease); bulkTaskLease.current = null; }
  };
  const dismissBulkTask = () => {
    if (bulkBatchBusy.current || bulkTaskRef.current?.getSnapshot().phase !== "complete") return;
    bulkTaskRef.current = null; bulkTaskWorkspace.current = null; setBulkTask(null); setBulkTaskRefreshing(false);
  };
  const showBulkTask = () => { setView("profiles"); setBulkTaskExpanded(true); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".bulk-task-expand")?.focus()); };

  const convertSelectedMobile = async () => {
    const ids = [...selected].filter((id) => profilesById.get(id)?.mobilePersona); if (!ids.length) return;
    const confirmed = await requestConfirm({
      title: t("Convert mobile personas"),
      message: `${t("Convert {count} selected mobile persona(s) to stable desktop personas?", { count: ids.length })}\n\n${t("Account data, sessions, proxies, timezones and fingerprint seeds are preserved. Android keeps the Windows desktop family used by earlier versions of the app; iPhone/iPad keeps macOS. A website may request device verification on first launch.")}`,
      confirmLabel: t("Convert"), cancelLabel: t("Cancel"),
    });
    if (!confirmed) return;
    setActionErr(null); setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const failed: string[] = [];
    await runPool(ids, 4, async (id) => {
      try { const r = await convertMobileProfile(id); if (!r.ok) failed.push(`${id}: ${r.error || t("Conversion failed")}`); }
      catch (e) { failed.push(`${id}: ${String(e)}`); }
    });
    await load().catch((error) => console.warn("[convertSelectedMobile:reload]", error));
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (failed.length) setActionErr(t("{succeeded} converted; {failed} failed — {details}", { succeeded: ids.length - failed.length, failed: failed.length, details: failed.join("; ") }));
    else flash(t("Converted {count} mobile persona(s) to stable desktop personas", { count: ids.length }));
  };

  // ---- Export selected → file ----
  const exportSelected = async (format: ExportFormat) => {
    setExportOpen(false); if (!selected.size || exportProgress) return;
    const ids = [...selected]; setActionErr(null); setExportProgress({ completed: 0, total: ids.length });
    try { await exportProfiles(ids, format, (progress) => setExportProgress(progress)); flash(`Exported ${ids.length} profile${ids.length === 1 ? "" : "s"} as ${format.toUpperCase()}`); }
    catch (e) { setActionErr(String(e)); } finally { setExportProgress(null); }
  };

  // ---- File-based bulk update ----
  const openUpdate = () => { setShowUpdate(true); };
  const showFileUpdateResult = () => { setView("profiles"); requestAnimationFrame(() => { fileUpdatePanelRef.current?.focus({ preventScroll: true }); fileUpdatePanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }); };

  // ---- Group create / rename / move / delete ----
  const createSidebarGroup = async () => {
    const name = sidebarGroupName.trim(); if (!name) return;
    if (name === "all") { setActionErr("This name is reserved."); return; }
    setActionErr(null);
    try {
      const result = await createGroup(name, newFolderParent);
      if (result.ok === false) { setActionErr(result.error || "create failed"); return; }
      await Promise.all([load(), Promise.resolve()]); selectFolder(result.folder?.name ?? name);
      setCollapsedFolders((current) => new Set([...current].filter((folder) => folder !== newFolderParent)));
      setSidebarGroupName(""); setAddingGroup(false);
    } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); }
  };
  const startRename = (g: string) => { setRenaming(g); setRenameVal(folderLabel(g)); };
  const remapSelectedFolder = (from: string, to: string) => {
    if (folderScope(folders, from).has(group)) selectFolder(to + group.slice(from.length));
    const next = new Map(groupDisclosure); let changed = false;
    for (const [name, collapsed] of groupDisclosure) if (name === from || name.startsWith(from + "/")) { next.delete(name); next.set(to + name.slice(from.length), collapsed); changed = true; }
    if (changed) saveGroupDisclosure(next);
  };
  const commitFolderMove = async () => {
    if (!movingFolder) return;
    setFolderMoveBusy(true); setFolderMoveErr(null);
    try {
      const result = await moveGroup(movingFolder, folderParent);
      if (result.ok === false) throw new Error(result.error || "Move failed");
      remapSelectedFolder(movingFolder, result.folder.name); setMovingFolder(null); await Promise.all([load(), Promise.resolve()]);
    } catch (error) { setFolderMoveErr(error instanceof Error ? error.message : String(error)); }
    finally { setFolderMoveBusy(false); }
  };
  const commitRename = async () => {
    const from = renaming, to = renameVal.trim(); setRenaming(null);
    if (!from || !to || to === folderLabel(from)) return;
    setActionErr(null);
    try {
      const r = await renameGroup(from, to);
      if (r.ok === false) setActionErr(r.error || "rename failed");
      else { remapSelectedFolder(from, r.folder?.name ?? to); await Promise.all([load(), Promise.resolve()]); }
    } catch (e) { setActionErr(String(e)); }
  };
  const removeGroup = async (g: string) => {
    const n = countFor(g), prompt = n ? t("Delete group “{group}”? Its {count} profile(s) move to Ungrouped (not deleted).", { group: g, count: n }) : t("Delete group “{group}”?", { group: g });
    const confirmed = await requestConfirm({ title: t("Delete group"), message: prompt, confirmLabel: t("Delete"), cancelLabel: t("Cancel"), tone: "danger" });
    if (!confirmed) return;
    setActionErr(null);
    try {
      const r = await deleteGroup(g);
      if (r.ok === false) setActionErr(r.error || t("Delete failed"));
      else { if (group === g) setGroup("all"); await Promise.all([load(), Promise.resolve()]); }
    } catch (e) { setActionErr(e instanceof Error ? e.message : String(e)); }
  };

  useDesktopCloseDraft("extension-install", { dirty: !!extSource.trim(), busy: extInstallBusy || extBusy });
  useDesktopCloseDraft("extension-defaults", { dirty: extensionDraftState.dirtyCount > 0, busy: groupDefaultBusy });
  const proxyReceiptUnavailable = workspaceOperationState.operation?.kind === "profile-proxies" && (proxyTaskSnapshot?.notice === "status-unavailable" || proxyTaskSnapshot?.notice === "refresh-unavailable");
  useDesktopCloseDraft("workspace-task", { dirty: false, busy: (!!workspaceOperationState.operation && !proxyReceiptUnavailable) || !!workspaceOperationState.workspaceJob || workspaceOperationState.nativeUpdateBusy });

  const rowHandlersRef = useRef<ProfileRosterRowHandlers | null>(null);
  const stableRowHandlers = useMemo<ProfileRosterRowHandlers>(() => ({
    openDetails: (...args) => rowHandlersRef.current!.openDetails(...args), openEdit: (...args) => rowHandlersRef.current!.openEdit(...args),
    openPendingCookies: (...args) => rowHandlersRef.current!.openPendingCookies(...args), openCookie: (...args) => rowHandlersRef.current!.openCookie(...args),
    act: (...args) => rowHandlersRef.current!.act(...args), openInspection: (...args) => rowHandlersRef.current!.openInspection(...args),
    reuseProfileConfiguration: (...args) => rowHandlersRef.current!.reuseProfileConfiguration(...args), openProfileTags: (...args) => rowHandlersRef.current!.openProfileTags(...args),
    copy2fa: (...args) => rowHandlersRef.current!.copy2fa(...args), toggleFavorite: (...args) => rowHandlersRef.current!.toggleFavorite(...args),
    changeProfileSelection: (...args) => rowHandlersRef.current!.changeProfileSelection(...args), setLaunchFailure: (...args) => rowHandlersRef.current!.setLaunchFailure(...args),
    openNetworkSettings: () => rowHandlersRef.current!.openNetworkSettings(), openLogs: () => rowHandlersRef.current!.openLogs(),
    trimMemory: (id) => rowHandlersRef.current!.trimMemory!(id), hibernateProfile: (id) => rowHandlersRef.current!.hibernateProfile!(id),
  }), []);

  const submitStandaloneAuthToken = (event: React.FormEvent) => {
    event.preventDefault();
    if (!setStandaloneSessionToken(authTokenInput)) { setAuthTokenErr(t("Paste the session token or tokenized dashboard URL printed by the CLI.")); return; }
    setAuthTokenInput(""); setAuthTokenErr(null); setAuthRequired(false); setAppModeErr(null);
    if (!appMode) loadAppMode(); else void retryConnection();
  };

  if (!appMode)
    return <div className={`desktop-loading-shell${windowChrome.enabled ? " desktop-frameless" : ""}`}><DesktopStartupBar chrome={windowChrome}><MaobuMark />猫步·千境</DesktopStartupBar><WindowActionError chrome={windowChrome} /><main className="onboarding"><section className="onboarding-card"><h1>猫步·千境</h1><p>{effectiveConnErr ?? t("Loading your configuration…")}</p>{authRequired && (<form className="auth-token-form" onSubmit={submitStandaloneAuthToken}><label className="sr-only" htmlFor="standalone-auth-token">{t("Session token")}</label><input id="standalone-auth-token" className="input" type="password" autoComplete="off" value={authTokenInput} onChange={(event) => setAuthTokenInput(event.target.value)} placeholder={t("Paste token or /?token=… URL")} /><button type="submit" className="btn primary">{t("Unlock dashboard")}</button>{authTokenErr && <p className="field-error" role="alert">{authTokenErr}</p>}</form>)}{effectiveConnErr && <button className="btn" onClick={() => (authRequired ? loadAppMode() : window.location.reload())}>{t("Try again")}</button>}</section></main></div>;

  const diagWhen = diag ? new Date(diag.generatedAt).toLocaleTimeString() : null, shownColumns = COLUMNS.filter((column) => columnVisible(column.key)), visibleColumnCount = 1 + shownColumns.length;
  const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);

  const groupNavigation = (
    <div className="sidesection group-management">
      <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}><span className={`chev${groupsOpen ? " open" : ""}`}><Icon name="chevronRight" className="sm" /></span><span>{t("Groups")}</span><span className="grow" /><span className="cnt">{existingGroups.length}</span></button>
      {groupsOpen && <>
        <div className="folders">
          {existingGroups.length === 0 && <div className="folders-empty">{t("No groups yet")}</div>}
          {tree.filter((folder) => !folder.ancestors.some((name) => collapsedFolders.has(name))).map(({ name: g, label, depth }) => (
            <div key={g} style={{ paddingLeft: 10 + depth * 16 }} className={`folder${view === "profiles" && group === g ? " active" : ""}`} onClick={() => { if (renaming !== g) selectFolder(g); }}>
              {renaming === g ? (<input className="renameinput" autoFocus value={renameVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }} onBlur={commitRename} />) : (<>
                {folders.some((folder) => folder.parentName === g) ? <button className="folder-toggle" type="button" aria-label={t("Expand or collapse {folder}", { folder: g })} aria-expanded={!collapsedFolders.has(g)} onClick={(event) => { event.stopPropagation(); setCollapsedFolders((current) => { const next = new Set(current); if (next.has(g)) next.delete(g); else next.add(g); return next; }); }}><Icon name={collapsedFolders.has(g) ? "chevronRight" : "chevronDown"} className="sm" /></button> : <Icon name="folder" className="sm" />}
                <button className="fname folder-select" title={g} onClick={() => selectFolder(g)}>{label ?? g}</button>
                <span className="gactions menuwrap" ref={folderMenu === g ? folderMenuRef : undefined} onClick={(event) => event.stopPropagation()}>
                  <button type="button" title={t("Folder actions")} aria-label={t("Actions for {folder}", { folder: g })} aria-expanded={folderMenu === g} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFolderMenuPosition({ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 230)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)) }); setFolderMenu(folderMenu === g ? null : g); }}><Icon name="more" className="sm" /></button>
                  {folderMenu === g && <span className="popover folder-menu" style={folderMenuPosition} onClick={() => setFolderMenu(null)}>
                    <button className="pop-item" onClick={() => { setNewFolderParent(g); setSidebarGroupName(""); setAddingGroup(true); }}><Icon name="plus" className="sm" />{t("New subfolder")}</button>
                    <button className="pop-item" onClick={() => startRename(g)}><Icon name="edit" className="sm" />{t("Rename")}</button>
                    <button className="pop-item" onClick={() => { setMovingFolder(g); setFolderParent(folders.find((folder) => folder.name === g)?.parentName ?? ""); setFolderMoveErr(null); }}><Icon name="move" className="sm" />{t("Move to…")}</button>
                    <button className="pop-item danger" disabled={folders.some((folder) => folder.parentName === g)} onClick={() => void removeGroup(g)}><Icon name="trash" className="sm" />{t("Delete")}</button>
                  </span>}
                </span><span className="cnt">{countFor(g)}</span>
              </>)}
            </div>
          ))}
        </div>
        {addingGroup ? (<div className="newgroup" title={newFolderParent ?? undefined}>
          {newFolderParent && <small>{t("In {folder}", { folder: folderLabel(newFolderParent) })}</small>}
          <input autoFocus aria-label={t("New group name")} value={sidebarGroupName} onChange={(event) => setSidebarGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createSidebarGroup(); else if (event.key === "Escape") { setAddingGroup(false); setSidebarGroupName(""); } }} />
          <button type="button" title={t("Create")} onClick={() => void createSidebarGroup()}><Icon name="check" className="sm" /></button>
          <button type="button" title={t("Cancel")} onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}><Icon name="close" className="sm" /></button>
        </div>) : (<button className="newgroup" type="button" onClick={() => { setNewFolderParent(null); setAddingGroup(true); }}><Icon name="plus" className="sm" />{t("New group")}</button>)}
      </>}
    </div>
  );

  const focusProfileSearch = () => { setView("profiles"); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".heading-search input")?.focus()); };
  const openSettingsFromPalette = (tab: SettingsTab) => {
    setSettingsTab(tab); setView("settings");
    requestAnimationFrame(() => { const target = document.getElementById(`settings-tab-${tab}`); if (target?.getAttribute("aria-selected") === "true" && !target.closest("[hidden], [inert]") && !readWorkbenchShortcutContext(document.activeElement).modalOpen) target.focus({ preventScroll: true }); });
  };
  const locateProfile = (id: string) => {
    chooseRosterScope("all"); setGroup("all"); setProfileStatus("all"); setQ(`id:${id}`); setProfilePage(0); setView("profiles");
    requestAnimationFrame(() => { const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find((item) => item.dataset.profileId === id); (row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? document.getElementById("profiles-page-title"))?.focus({ preventScroll: true }); });
  };
  const activateSavedViewFromPalette = (id: string) => {
    if (!viewPreferencesReady || viewPreferenceWrite.current || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return;
    const saved = savedProfileViews.find((item) => item.id === id); if (!saved) return;
    applyProfileView(saved); setView("profiles");
    requestAnimationFrame(() => { if (workspaceCoordinator.getSnapshot().workspaceId === currentWorkspaceId && !readWorkbenchShortcutContext(document.activeElement).modalOpen) document.getElementById("profiles-page-title")?.focus({ preventScroll: true }); });
  };
  const openProfileTags = (profile: UiProfile) => {
    if (busy[profile.id]) return;
    const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find((item) => item.dataset.profileId === profile.id);
    tagsReturnFocus.current = row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? null; setTagsTarget({ id: profile.id, name: profile.name, tags: [...profile.tags] });
  };
  const saveProfileTags = async (id: string, tags: string[]): Promise<boolean> => { const result = await updateProfile(id, profileTagsUpdate(tags)); if (result?.ok !== true || !bulkOwnerActive.current) return false; await load(); return true; };
  const openCreateInGroup = (groupName: string) => { if (!createModal.beginCreate(undefined, undefined, undefined, groupName)) return; const next = new Map(groupDisclosure); next.set(groupName, false); saveGroupDisclosure(next); };
  shortcutAction.current = (action) => {
    if (action === "toggle-command-palette") setCommandOpen((open) => !open);
    else if (action === "focus-profile-search") focusProfileSearch();
    else if (action === "open-shortcut-help") setShortcutHelpOpen(true);
    else if (action === "create-profile") createModal.openCreate();
    else if (action === "go-profiles") { chooseRosterScope("all"); selectFolder("all"); }
    else if (action === "go-proxies") setView("proxies");
    else if (action === "go-scripts") setView("scripts");
    else if (action === "go-assistant") setView("assistant");
    else if (action === "go-extensions") openExtensions();
  };
  const showMoveTask = () => { setView("profiles"); requestAnimationFrame(() => { moveTaskPanelRef.current?.focus({ preventScroll: true }); moveTaskPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }); };
  const showTrashTask = () => { setView("trash"); requestAnimationFrame(() => { const target = document.querySelector<HTMLElement>(".trash-task-panel h3") ?? document.getElementById("trash-page-title"); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest", behavior: "auto" }); }); };
  const showProxyTask = () => { if (!currentWorkspaceId || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return; setProxyTaskFocusRequest({ workspaceId: currentWorkspaceId }); setView("proxies"); };

  rowHandlersRef.current = {
    openDetails: (id, trigger) => {
      detailsTrigger.current = trigger; focusDetailsOnOpen.current = true; setDetailsTarget({ id, workspaceId: currentWorkspaceId });
      if (detailsProfile?.id === id) { detailsHeading.current?.focus({ preventScroll: true }); focusDetailsOnOpen.current = false; }
    },
    openEdit: editModal.openEdit, openPendingCookies: importModal.openPendingCookies, openCookie, act, openInspection,
    reuseProfileConfiguration: createModal.reuseProfileConfiguration, openProfileTags, copy2fa, toggleFavorite,
    changeProfileSelection, setLaunchFailure, openNetworkSettings: () => { setSettingsTab("network"); openSettings(); },
    openLogs: () => { setLogErr(null); void fetchLogs().then(setLogView).catch((error) => setLogErr(error instanceof Error ? error.message : String(error))); },
    trimMemory: async (id) => {
      try {
        const res = await trimProfileMemoryApi(id);
        flash(t("Trimmed memory (freed {freed}).", { freed: formatMemoryBytes(res.totalFreedBytes) }));
        await resourceMonitor.refreshNow();
      } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); }
    },
    hibernateProfile: async (id) => {
      try {
        await hibernateProfileApi(id);
        flash(t("Saved session and hibernated environment."));
        await Promise.all([load(), resourceMonitor.refreshNow()]);
      } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); }
    },
  };

  const activityItems: WorkbenchActivityItem[] = [];
  if (runtimeDownloads.length > 0) activityItems.push({ id: "browser-downloads", title: t("Browser downloads"), description: runtimeDownloadsStale ? t("Download status temporarily unavailable") : runtimeDownloadLabel(runtimeDownloads, t), state: runtimeDownloadsStale ? "attention" : "running", onView: viewRuntimeDownloads });
  if (scriptBackground.run) activityItems.push({ id: "script", title: t("Script run"), description: scriptBackground.run.scriptName, state: scriptBackground.state === "unavailable" ? "attention" : scriptBackground.state !== "finished" ? "running" : scriptBackground.summary.failed ? "attention" : "complete", progress: { done: scriptBackground.summary.settled, total: scriptBackground.summary.total }, onView: () => setScriptRunOpen(true) });
  if (bulkTaskSnapshot) activityItems.push({ id: "batch", title: t("Batch task"), state: bulkTaskActive || bulkTaskRefreshing ? "running" : bulkTaskSnapshot.summary.failed ? "attention" : "complete", progress: { done: bulkTaskSnapshot.summary.settled, total: bulkTaskSnapshot.summary.total }, onView: showBulkTask });
  if (importModal.importBusy || importModal.importReceipt) activityItems.push({ id: "import", title: t("Import profiles"), state: importModal.importBusy || importModal.importReceiptRefreshing ? "running" : importModal.importReceipt && (importModal.importReceipt.skipped || importModal.importReceipt.issues.length) ? "attention" : "complete", onView: importModal.showImportReceipt });
  if (cookieImport.snapshot.phase !== "idle") activityItems.push({ id: "cookies", title: t("Cookie import"), state: cookieImportBusy ? "running" : cookieImport.snapshot.summary.failed || cookieImport.snapshot.summary.unconfirmed || cookieImport.snapshot.refreshFailed ? "attention" : "complete", progress: { done: cookieImport.snapshot.summary.succeeded + cookieImport.snapshot.summary.failed + cookieImport.snapshot.summary.unconfirmed, total: cookieImport.snapshot.summary.total }, onView: showCookieImportTask });
  if (fileUpdateBusy || fileUpdate.snapshot.latest) activityItems.push({ id: "file-update", title: t("Update profiles from file"), state: fileUpdateBusy ? "running" : fileUpdate.snapshot.latest?.status === "saved" && !fileUpdate.snapshot.latest.refreshFailed ? "complete" : "attention", onView: showFileUpdateResult });
  if (profileMove.state.attempt || profileMove.state.blockedReason) activityItems.push({ id: "move", title: t("Move environments"), state: profileMove.busy ? "running" : profileMove.state.result?.status === "confirmed" ? "complete" : "attention", onView: showMoveTask });
  if (trashTaskSnapshot && (trashTaskSnapshot.phase !== "idle" || trashTaskSnapshot.blockedReason)) activityItems.push({ id: "trash", title: t("Trash operation"), state: ["confirming", "sending", "refreshing"].includes(trashTaskSnapshot.phase) ? "running" : trashTaskSnapshot.receipt?.status === "complete" && !trashTaskSnapshot.receipt.refreshFailed && !trashTaskSnapshot.blockedReason ? "complete" : "attention", onView: showTrashTask });
  const proxyReceipt = proxyTaskSnapshot?.latest ?? proxyTaskSnapshot?.history.at(-1);
  if (proxyTaskSnapshot && (proxyTaskSnapshot.busy || proxyTaskSnapshot.notice || proxyReceipt)) {
    const { phase, busy: proxyBusy, notice: proxyNotice } = proxyTaskSnapshot, summary = proxyReceipt?.summary;
    const receiptNeedsAttention = !!proxyReceipt?.refreshFailed || !!(summary && (summary.failed || summary.skipped || summary.missing || summary.unknown || summary.notStarted));
    const state = (phase === "reconciling" || proxyNotice === "refresh-unavailable") ? "attention" : proxyBusy ? "running" : proxyNotice || receiptNeedsAttention ? "attention" : "complete";
    activityItems.push({ id: "proxies", title: t("Proxy assignment"), state, onView: showProxyTask });
  }

  const paletteCommands: CommandPaletteCommand[] = [
    { id: "profiles", label: "Profiles", keywords: ["环境", "列表", "roster"], run: () => setView("profiles") },
    { id: "new-profile", label: "New Profile", keywords: ["创建", "新建", "create"], run: createModal.openCreate },
    { id: "import", label: "Import profiles", keywords: ["导入", "adspower", "csv", "xlsx"], run: importModal.openBulk },
    { id: "search", label: "Search profiles", keywords: ["搜索", "查找", "find"], run: focusProfileSearch },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: ["快捷键", "键盘", "帮助", "keyboard", "help"], run: () => setShortcutHelpOpen(true) },
    { id: "refresh", label: "Refresh profiles", keywords: ["刷新", "reload"], disabled: refreshing, run: () => { void refreshRoster(); } },
    { id: "proxies", label: "Proxies", keywords: ["网络", "代理", "proxy"], run: () => setView("proxies") },
    { id: "proxy-vault", label: "Proxy vault", keywords: ["代理库", "资产库", "vault", "proxy"], run: () => { setProxyTabRequest((prev) => ({ task: "vault", seq: (prev?.seq ?? 0) + 1 })); setView("proxies"); } },
    { id: "window-sync", label: "Window layout & synchronizer", keywords: ["窗口", "排布", "平铺", "同步器", "群控", "sync", "grid"], run: () => setWindowSyncOpen(true) },
    { id: "resource-monitor", label: "Real-time resource monitor", keywords: ["资源", "内存", "监控", "休眠", "ram", "cpu", "metrics"], run: () => setResourceDrawerOpen(true) },
    { id: "scripts", label: "Scripts", keywords: ["脚本", "自动化", "automation"], run: () => setView("scripts") },
    { id: "assistant", label: "AI workspace", keywords: ["AI", "助手", "模型", "智能体", "聊天", "Ollama"], run: () => setView("assistant") },
    { id: "extensions", label: "Manage extensions", keywords: ["扩展", "插件", "extension"], run: openExtensions },
    { id: "workspaces", label: "Workspace management", keywords: ["工作区", "备份", "backup"], run: () => openWorkspaceManagement({ mode: "manage" }) },
    { id: "trash", label: "Trash", keywords: ["回收站", "恢复", "restore"], run: () => setView("trash") },
    ...SETTINGS_TABS.map((tab) => ({ id: `settings-${tab.key}`, label: tab.key === "account" ? "Settings" : tab.label, keywords: ["设置", "settings"], run: () => openSettingsFromPalette(tab.key) })),
  ];

  return (
    <>
      {confirmDialogNode}
      <CommandPalette commands={paletteCommands} profiles={profiles} favoriteIds={favoriteProfileIds} onLocateProfile={locateProfile}
        savedViews={paletteSavedViews} savedViewsState={viewPreferencesReady ? "ready" : viewPreferenceReadError || workspaceCatalogError ? "unavailable" : "loading"}
        savedViewsLocked={viewPreferenceBusy} onApplySavedView={activateSavedViewFromPalette} open={commandOpen} onClose={() => setCommandOpen(false)} />
      <ShortcutHelp open={shortcutHelpOpen} desktop={!!desktopInvoke()} onClose={() => setShortcutHelpOpen(false)} onAction={(action) => shortcutAction.current(action)} returnFocus={() => document.querySelector<HTMLButtonElement>(".shortcut-help-trigger") ?? document.querySelector<HTMLButtonElement>(".command-palette-trigger")} />
      <ProfileTagsDialog target={tagsTarget} sessionKey={catalog?.currentId} onSave={saveProfileTags} onClose={() => setTagsTarget(null)} returnFocus={() => (tagsReturnFocus.current?.isConnected ? tagsReturnFocus.current : document.getElementById("profiles-page-title"))} />
      <WindowActionError chrome={windowChrome} />
      <SyncEmergencyBar state={syncState} profiles={profiles} onOpenPanel={() => setWindowSyncOpen(true)} onPauseToggle={(paused) => { void pauseWindowSync(paused).then(setSyncState).catch((error) => setActionErr(error instanceof Error ? error.message : String(error))); }} onEmergencyStop={() => { void stopWindowSync().then(setSyncState).catch((error) => setActionErr(error instanceof Error ? error.message : String(error))); }} />
      <div data-roster-density={rosterDensity} className={`app airy-workbench folded-workbench${windowChrome.enabled ? " desktop-frameless" : ""}${windowChrome.enabled && !windowChrome.focused ? " is-window-unfocused" : ""}`}
        onDragOver={(e) => { if (!Array.from(e.dataTransfer.types).includes("Files") || e.defaultPrevented || readWorkbenchShortcutContext(e.target).modalOpen) return; e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { const handled = e.defaultPrevented || readWorkbenchShortcutContext(e.target).modalOpen; e.preventDefault(); setDragging(false); if (!handled && e.dataTransfer.files?.length) void importModal.doUpload(e.dataTransfer.files); }}>
        {dragging && <div className="dropzone"><Icon name="fileImport" /><span>{t("Drop TXT, CSV, JSON, or XLSX profile exports to import")}</span></div>}

        <WorkbenchSidebar compact={sidebarIsCompact} collapsed={sidebarCollapsed} forced={railForced} view={view} profileCount={profiles.length} extensionCount={extensions.length} loaded={loaded} onToggle={toggleSidebar} onNavigate={setView} onProfiles={() => { chooseRosterScope("all"); selectFolder("all"); }} onExtensions={openExtensions} onSettings={openSettings} navigationRef={navigationMotion.navRef} error={modeErr}
          switcher={<WorkspaceSwitcher variant="rail" compact={sidebarIsCompact} profileCount={profiles.length} runningCount={runningCount} connection={loaded && !connErr} onShowRunning={showRunningProfiles} onOpenManagement={openWorkspaceManagement} onShowBatchTask={showBulkTask} managementActive={view === "workspaces"} />}
          device={<DevicePanel variant="rail" runningCount={runningCount} downloads={runtimeDownloads} downloadStatusUnavailable={runtimeDownloadsStale} connection={loaded && !connErr} connectionLoading={!loaded} version={appVersion ?? ""} theme={theme} chooseTheme={chooseTheme} language={language} setLanguage={setLanguage} onShowRunning={showRunningProfiles} onSettings={(section) => { setSettingsTab(section === "advanced" ? "advanced" : "account"); setView("settings"); }} onViewLogs={() => { setLogErr(null); fetchLogs().then(setLogView).catch((error) => setLogErr(error instanceof Error ? error.message : String(error))); }} onRetryConnection={refreshRoster} />}>
          <RosterNavigation compact={sidebarIsCompact} active={view === "profiles"} group={group} total={profiles.length} ungrouped={countFor("")} groups={tree.map((folder) => ({ name: folder.name, label: folder.label ?? folderLabel(folder.name), depth: folder.depth, count: countFor(folder.name) }))} onGroup={selectFolder}>
            <RosterViews current={{ scope: rosterScope, query: q, group, status: profileStatus, sort, hiddenColumns: [...hiddenCols], pageSize }} views={viewPreferencesReady ? savedProfileViews : []} counts={rosterViewCounts} ready={viewPreferencesReady} loading={!workspaceCatalogError && viewPreferencesLoading} readError={viewPreferenceReadError || workspaceCatalogError} busy={viewPreferenceBusy} onRetry={() => { if (workspaceCatalogError) void refreshWorkspaceCatalog(); else setPreferenceLoadAttempt((value) => value + 1); }} onScope={chooseRosterScope} onApply={applyProfileView} onSave={saveProfileView} onRemove={removeProfileView} />
          </RosterNavigation>
        </WorkbenchSidebar>

        <div className="main">
          <header className="workspace-header" onMouseDown={windowChrome.onMouseDown}>
            <button ref={aboutTriggerRef} type="button" className={`desktop-brand${aboutOpen ? " is-open" : ""}`} data-no-drag aria-haspopup="dialog" aria-expanded={aboutOpen} aria-controls={aboutOpen ? "about-popover-dialog" : undefined} aria-label={hasUpdateNotice ? `${t("About {app}", { app: "猫步·千境" })} · ${t("Update available")}` : t("About {app}", { app: "猫步·千境" })} title={t("About {app}", { app: "猫步·千境" })} onClick={() => setAboutOpen((open) => !open)}>
              <MaobuMark /><strong>猫步·千境</strong>
              {sidebarIsCompact && savedWorkspaceName && <span className="desktop-workspace-name" title={savedWorkspaceName}>{savedWorkspaceName}</span>}
              {appVersion && <span className="appversion" title={appVersion}>{appVersion}</span>}
              {hasUpdateNotice && <span className="desktop-brand-dot" data-update-available="true" aria-hidden="true" />}
            </button>
            <div className="topbar-actions">
              <ResourceTopCapsule runningCount={runningCount} snapshot={resourceMonitor.snapshot} open={resourceDrawerOpen} onToggle={() => setResourceDrawerOpen((open) => !open)} />
              <button type="button" className="iconbtn tip wsync-topbar-trigger" data-tip={t("Window layout & synchronizer")} aria-label={t("Window layout & synchronizer")} aria-haspopup="dialog" aria-expanded={windowSyncOpen} onClick={() => setWindowSyncOpen((open) => !open)}><Icon name="window" />{syncState.active && <span className="wsync-topbar-dot" aria-hidden="true" />}</button>
              <WorkbenchActivity items={activityItems} />
              <button type="button" className="command-palette-trigger" aria-label={t("Command palette")} title={t("Command palette")} aria-haspopup="dialog" aria-expanded={commandOpen} onClick={() => setCommandOpen(true)}><Icon name="search" className="sm" /><span>{t("Command palette")}</span><kbd>{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘ K" : "Ctrl K"}</kbd></button>
              <button type="button" className="iconbtn tip shortcut-help-trigger" data-tip={`${t("Keyboard shortcuts")} · ?`} aria-label={t("Keyboard shortcuts")} aria-haspopup="dialog" aria-expanded={shortcutHelpOpen} onClick={() => setShortcutHelpOpen(true)}><Icon name="help" /></button>
              <button type="button" className="iconbtn tip topbar-settings" data-tip={t("Settings")} aria-label={t("Settings")} onClick={openSettings}><Icon name="settings" /></button>
              <WindowControls chrome={windowChrome} />
            </div>
          </header>
          <AboutPopover open={aboutOpen} onClose={() => setAboutOpen(false)} anchorRef={aboutTriggerRef} appVersion={appVersion} signedUpdateStartup={signedUpdateStartup} dialogId="about-popover-dialog"
            onOpenUpdateSettings={() => { setAboutOpen(false); if (view === "settings" && settingsTab === "updates") { if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0; updateTabRef.current?.focus({ preventScroll: true }); } else { focusUpdateTabOnOpen.current = true; setSettingsTab("updates"); setView("settings"); } }}
            onGithubUpdateResult={(result) => setGithubUpdateAvailable(result?.status === "available")} />

          <div className="workspace-content" ref={navigationMotion.contentRef} role="main" aria-label={t(PAGE_TITLES[view])}>
            <ErrorBoundary scope={t(PAGE_TITLES[view])} resetKeys={[view, currentWorkspaceId]}>
              <WorkspaceActivity hidden={view === "workspaces"} onOpen={() => openWorkspaceManagement({ mode: "backups" })} />
              {signedUpdateStartup.noticeVersion && <div className="update-banner signed-update-notice"><Icon name="refresh" className="sm" /><span role="status">{t("Signed desktop update {version} is available.", { version: signedUpdateStartup.noticeVersion })}</span><button className="btn xs" type="button" onClick={viewSignedUpdate}>{t("View update")}</button><button className="update-result-dismiss" type="button" aria-label={t("Dismiss")} onClick={signedUpdateStartup.dismissNotice}><Icon name="close" className="sm" /></button></div>}
              {(actionErr ?? (!connectionAlertDismissed ? effectiveConnErr : null)) && (
                <div className="error" role="alert">
                  <Icon name="alert" /><span>{t(actionErr ?? effectiveConnErr ?? "")}</span>
                  {authRequired && <form className="auth-token-form inline" onSubmit={submitStandaloneAuthToken}><label className="sr-only" htmlFor="standalone-banner-auth-token">{t("Session token")}</label><input id="standalone-banner-auth-token" className="input" type="password" autoComplete="off" value={authTokenInput} onChange={(event) => setAuthTokenInput(event.target.value)} placeholder={t("Paste token or /?token=… URL")} /><button type="submit" className="btn xs primary">{t("Unlock dashboard")}</button>{authTokenErr && <span className="field-error">{authTokenErr}</span>}</form>}
                  {!actionErr && effectiveConnErr && <button type="button" className="btn xs ghost" disabled={refreshing} onClick={() => void retryConnection()}>{t("Retry")}</button>}
                  <button className="dismiss" aria-label={t("Dismiss error")} onClick={() => { setActionErr(null); if (effectiveConnErr) dismissConnectionAlert(); }}><Icon name="close" className="sm" /></button>
                </div>
              )}
              <ToastStack toasts={toasts} onDismiss={dismissToast} />
              {exportProgress && (<div className="notice" role="status"><Icon name="export" className="sm" />{exportProgress.completed >= exportProgress.total ? t("Building export file…") : t("Preparing export: {completed} / {total} profiles", { completed: exportProgress.completed.toLocaleString(), total: exportProgress.total.toLocaleString() })}</div>)}
              {diskSpace?.low && diskSpace.freeBytes !== null && !diskWarningDismissed && (
                <div className="update-banner update-result warning" role="alert">
                  <Icon name="warning" />
                  <div className="update-copy"><strong>{t("Low disk space: {free} GB free on the drive that holds your profiles.", { free: (diskSpace.freeBytes / 1024 ** 3).toFixed(1) })}</strong><span>{t("When the disk is almost full, browsers delete saved site data, which can log profiles out. Free up space on this drive.")}</span></div>
                  <button className="update-result-dismiss" type="button" aria-label={t("Dismiss disk space warning")} onClick={() => setDiskWarningDismissed(true)}><Icon name="close" className="sm" /></button>
                </div>
              )}

              <ProxiesPage key={`proxies-${currentWorkspaceId ?? "loading"}`} active={view === "proxies"} groups={["", ...groups.slice(1)]} folders={folders} profiles={profiles} loadingProfiles={!loaded} onChanged={refreshImportedProfiles} onTaskSnapshotChange={publishProxyTask} focusTask={view === "proxies" && proxyTaskFocusRequest !== null && proxyTaskFocusRequest.workspaceId === currentWorkspaceId} onTaskFocused={completeProxyTaskFocus} localAssignmentIntent={activeLocalProxyIntent} onDismissLocalAssignmentIntent={dismissLocalProxyAssignment} requestedTask={proxyTabRequest} />
              <LocalAssistantPage active={view === "assistant"} onOpenMcp={() => { setSettingsTab("integrations"); setView("settings"); }} onOpenModelServices={() => openSettingsFromPalette("models")} draftSuggestion={assistantDraftSuggestion} onDismissDraftSuggestion={(id) => setAssistantDraftSuggestion((current) => (current?.id === id ? null : current))} onReturnToTask={(source) => { if (source.returnKey) { setInspectionId(source.returnKey); setView("inspection"); } }} />
              <EnvironmentInspectionPage active={view === "inspection"} profile={inspectionId ? profilesById.get(inspectionId) ?? null : null} refreshVersion={fingerprintRefreshVersion} onBack={backFromInspection} onEditProfile={(id, field, trigger) => { if (!editModal.isEditSessionOpen()) editModal.openEdit(id, field, trigger); }} onExplainFingerprint={explainFingerprint} />
              <TrashPage key={`trash-${currentWorkspaceId ?? "loading"}`} active={view === "trash"} onChanged={refreshImportedProfiles} folderTree={folders} onTaskSnapshotChange={(snapshot) => setTrashTaskState({ workspaceId: currentWorkspaceId, snapshot })} />
              <WorkspaceManagementPage key="local-workspaces" active={view === "workspaces"} request={workspacePageRequest} onBack={() => setView("profiles")} onShowRunning={showRunningProfiles} onShowBatchTask={showBulkTask} />

              {view === "profiles" ? (
                <div className="workspace profiles-workspace">
                  <ReuseRequestBanner request={createModal.reuseRequest} onRetry={(id, name) => void createModal.reuseProfileConfiguration(id, name)} onCancel={createModal.cancelReuseRead} />
                  <div className="page-heading">
                    <div className="profile-heading-copy"><h1 id="profiles-page-title" tabIndex={-1}>{t("Environments")}</h1><span className="profile-total">{t("{count} environments", { count: profiles.length })}</span></div>
                    <div className="page-actions">
                      <button className="btn" title={t("Import profiles from AdsPower, GoLogin, Multilogin, Donut, and other readable exports")} onClick={importModal.openBulk}><Icon name="fileImport" className="sm" />{t("Import profiles")}</button>
                      <button className="btn primary" onClick={createModal.openCreate}><Icon name="plus" className="sm" />{t("New Profile")}</button>
                    </div>
                  </div>
                  {!!breadcrumb?.ancestors.length && <nav className="folder-breadcrumb" aria-label={t("Folder path")}><button className="btn ghost xs" onClick={() => selectFolder("all")}>{t("All profiles")}</button>{breadcrumb.ancestors.map((name) => <span key={name}> / <button className="btn ghost xs" onClick={() => selectFolder(name)}>{folderLabel(name)}</button></span>)}<span aria-current="location"> / {folderLabel(group)}</span></nav>}
                  <div className="profile-filter-row">
                    <div className="searchfield heading-search"><Icon name="search" className="sm" /><input className="input search" placeholder={t("Search name, No., tag or proxy…")} aria-label={t("Search profiles")} value={q} onChange={(e) => setQ(e.target.value)} />{q && <button type="button" className="clear" aria-label={t("Clear search")} onClick={() => setQ("")}><Icon name="close" className="sm" /></button>}</div>
                    <select className="select group-filter" aria-label={t("Group filter")} hidden={!sidebarIsCompact} value={group} onChange={(event) => selectFolder(event.target.value)}>
                      <option value="all">{t("All groups")} · {profiles.length}</option>
                      <option value="">{t("Ungrouped")} · {countFor("")}</option>
                      {missingRosterGroup && <option value={missingRosterGroup}>{t("Unavailable · {group}", { group: missingRosterGroup })}</option>}
                      {tree.map((folder) => <option key={folder.name} value={folder.name}>{[...folder.ancestors, folder.name].map(folderLabel).join(" / ")} · {countFor(folder.name)}</option>)}
                    </select>
                    <div className="profile-status-filter"><div className="profile-status-tabs" role="group" aria-label={t("Filter by status")}>
                      <button type="button" className={profileStatus === "all" ? "active" : ""} aria-pressed={profileStatus === "all"} onClick={() => setProfileStatus("all")}>{t("All environments")}<span>{matchingProfiles.length}</span></button>
                      <button type="button" className={profileStatus === "running" ? "active" : ""} aria-pressed={profileStatus === "running"} onClick={() => setProfileStatus("running")}>{t("Running")}<span>{matchingRunningCount}</span></button>
                      <button type="button" className={profileStatus === "stopped" ? "active" : ""} aria-pressed={profileStatus === "stopped"} onClick={() => setProfileStatus("stopped")}>{t("Stopped")}<span>{matchingProfiles.length - matchingRunningCount}</span></button>
                    </div></div>
                    <div className="profile-view-tools">
                      <div className="headactions">
                        <button type="button" className="iconbtn tip" data-tip={t("Refresh")} aria-label={t("Refresh profiles")} disabled={refreshing} onClick={() => void refreshRoster()}><Icon name="refresh" /></button>
                        <div className="menuwrap" ref={colsRef}>
                          <button type="button" className={`iconbtn tip${colsOpen ? " on" : ""}`} data-tip={t("Display settings")} aria-label={t("Choose visible columns")} aria-expanded={colsOpen} onClick={() => setColsOpen((o) => !o)}><Icon name="columns" /></button>
                          {colsOpen && (<div className="popover below-right">
                            <div className="pop-head">{t("Display settings")}</div>
                            <RosterDensityControl value={rosterDensity} onChange={(value) => void chooseRosterDensity(value)} disabled={!viewPreferencesReady} busy={viewPreferenceBusy} />
                            <div className="pop-head">{t("Visible columns")}</div>
                            {COLUMNS.map((column) => (<label className="pop-item" key={column.key}><input type="checkbox" checked={columnVisible(column.key)} onChange={() => toggleColumn(column.key)} />{t(column.label)}</label>))}
                          </div>)}
                        </div>
                      </div>
                      <div className="profile-group-manager menuwrap" ref={groupManagerRef}>
                        <button type="button" className={`iconbtn tip${groupManagerOpen ? " on" : ""}`} aria-label={t("Manage groups")} data-tip={t("Manage groups")} aria-expanded={groupManagerOpen} onClick={() => setGroupManagerOpen((open) => !open)}><Icon name="folders" /></button>
                        {groupManagerOpen && <div className="popover group-manager-panel"><div className="pop-head">{t("Manage groups")}</div>{groupNavigation}</div>}
                      </div>
                    </div>
                  </div>

                  {runtimeDownloads.length > 0 && (runtimeDownloadsStale ? <div className="update-progress" role="status">{t("Download status temporarily unavailable")}</div> : <RuntimeDownloadProgressView downloads={runtimeDownloads} />)}
                  {importModal.importBusy && <div className="import-task-indicator" role="status"><Icon name="refresh" className="sm" /><span>{t("Importing environments…")}</span></div>}
                  {importModal.importReceipt && <ImportReceiptPanel receipt={importModal.importReceipt} expanded={importModal.importReceiptExpanded} refreshing={importModal.importReceiptRefreshing} onExpandedChange={importModal.setImportReceiptExpanded} onBrowseAll={() => { setSelected(new Set()); chooseRosterScope("all"); selectFolder("all"); }} onViewAttention={() => { setSelected(new Set()); chooseRosterScope("attention"); selectFolder("all"); }} onDismiss={importModal.dismissImportReceipt} />}
                  {!cookieTargets && cookieImport.snapshot.phase !== "idle" && <div ref={cookieTaskPanelRef} tabIndex={-1} className="cookie-import-result-anchor"><CookieImportTaskPanel snapshot={cookieImport.snapshot} onRetryFailed={() => { void cookieImport.task.retryFailed(); }} onDismiss={() => { cookieImport.task.dismiss(); }} /></div>}
                  {!showUpdate && (fileUpdateBusy || fileUpdate.snapshot.latest) && <div ref={fileUpdatePanelRef} tabIndex={-1} className="profile-file-update-result-anchor"><ProfileFileUpdatePanel snapshot={fileUpdate.snapshot} onChooseFile={openUpdate} onBrowseProfiles={() => { setSelected(new Set()); chooseRosterScope("all"); selectFolder("all"); }} onDismiss={() => { fileUpdate.task.dismissResults(); }} /></div>}
                  <div ref={moveTaskPanelRef} tabIndex={-1} className="profile-move-result-anchor"><ProfileMoveFeedback state={profileMove.state} onRetry={() => void runMoveAction(profileMove.retry)} onRecheck={() => void runMoveAction(profileMove.recheck)} onDismiss={profileMove.dismiss} /></div>
                  {bulkTaskSnapshot && bulkTaskActive && bulkTaskSnapshot.action === "open" && (bulkTaskSnapshot.throttled || (resourceMonitor.snapshot && resourceMonitor.snapshot.watermark.level !== "normal")) && (
                    <div className={`bulk-watermark-notice${resourceMonitor.snapshot?.watermark.level === "critical" ? " is-critical" : ""}`} role="status">
                      <span>{t("Memory watermark guard active: batch start concurrency throttled to {limit} ({load}% RAM).", { limit: bulkTaskSnapshot.effectiveConcurrency, load: Math.round(resourceMonitor.snapshot?.host.memoryLoadPercent ?? 0) })}</span>
                      <button type="button" className="btn xs ghost" onClick={() => setResourceDrawerOpen(true)}>{t("View resources")}</button>
                    </div>
                  )}
                  {bulkTaskSnapshot && <BulkProfileTaskPanel snapshot={bulkTaskSnapshot} expanded={bulkTaskExpanded} refreshing={bulkTaskRefreshing} onExpandedChange={setBulkTaskExpanded} onStopPending={() => bulkTaskRef.current?.stopPending()} onRetryFailed={retryBulkFailures} onDismiss={dismissBulkTask} />}

                  <ProfileRosterTable loaded={loaded} profilesCount={profiles.length} filteredCount={filtered.length} flatItems={flatItems} selectableProfilesCount={selectableProfiles.length} numbering={numbering} rosterScope={rosterScope} rosterDensity={rosterDensity} missingRosterGroup={missingRosterGroup} hasRosterRefinements={hasRosterRefinements} revealGroupMatches={revealGroupMatches} sort={sort} hiddenCols={hiddenCols} shownColumns={shownColumns} visibleColumnCount={visibleColumnCount} tableMinWidth={tableMinWidth} tableScrolled={tableScrolled} onTableScrolledChange={setTableScrolled} selected={selected} allVisibleSelected={allVisibleSelected} busy={busy} favoriteProfileIds={favoriteProfileIds} reuseLoadingId={createModal.reuseRequest?.status === "loading" ? createModal.reuseRequest.id : null} twoFaFlashId={twoFaFlash?.id ?? null} viewPreferencesReady={viewPreferencesReady} viewPreferenceBusy={viewPreferenceBusy} language={language} rangeKeyboardActivation={rangeKeyboardActivation} profilePageCount={profilePageCount} visibleProfilePage={visibleProfilePage} pageSize={pageSize} onPageChange={setProfilePage} onPageSizeChange={applyPageSize} runningCount={runningCount} diag={diag} diagWhen={diagWhen} showDiag={showDiag} onToggleDiag={() => setShowDiag((s) => !s)} hasDetails={!!detailsProfile} detailsPanel={<ProfileDetailsPanel profile={detailsProfile} headingRef={detailsHeading} onClose={closeDetails} onEdit={(id) => editModal.openEdit(id, undefined, detailsTrigger.current ?? undefined)} onInspect={openInspection} />} groupDisclosureKey={groupDisclosureKey} motionAllowed={motion.effective === "full"} renderResourceChips={renderResourceChips} folderLabel={folderLabel} openLabel={openLabel} onToggleSort={toggleSort} onToggleAll={() => { rangeSelectionAnchor.current = null; toggleAll(); }} onToggleProfileGroup={toggleProfileGroup} onToggleGroupSelection={(matches) => { rangeSelectionAnchor.current = null; setSelected((current) => toggleProfileSelection(current, matches)); }} onCreateInGroup={openCreateInGroup} onManageGroup={(name) => { selectFolder(name); setGroupManagerOpen(true); }} onNewSubfolder={(name) => { setNewFolderParent(name || null); setSidebarGroupName(""); setAddingGroup(true); setGroupManagerOpen(true); }} onOpenCreate={createModal.openCreate} onOpenBulk={importModal.openBulk} onSelectAllGroups={() => setGroup("all")} onChooseRosterScope={chooseRosterScope} onClearRosterRefinements={clearRosterRefinements} rowHandlers={stableRowHandlers} t={t} />

                  <ActionDock
                    selectedCount={selected.size}
                    totalFilteredCount={filtered.length}
                    allFilteredSelected={allFilteredSelected}
                    selectedOutsideFilter={selectedOutsideFilter}
                    selectionScope={selectionScope}
                    deleting={deleting}
                    busy={bulkTaskActive || bulkTaskRefreshing}
                    blockedMessage={workspaceOperationState.blocked ? workspaceOperationMessage(workspaceOperationState) : null}
                    onSelectAllFiltered={() => { rangeSelectionAnchor.current = null; selectAllFiltered(); }}
                    onClear={() => { rangeSelectionAnchor.current = null; setSelected(new Set()); }}
                    onStart={openSelected}
                    onStop={closeSelected}
                    moreOpen={bulkToolsOpen}
                    onMoreOpenChange={setBulkToolsOpen}
                  >
                    <button className="btn" type="button" onClick={() => { setScriptRunProfiles(profiles.filter((profile) => selected.has(profile.id))); setScriptRunOpen(true); }}><Icon name="play" className="sm" />{t("Run script")}</button>
                    <button className="btn tip" type="button" data-tip={t("Open browsers get the cookies now; closed profiles at their next start")} onClick={() => openCookie(profiles.filter((profile) => selected.has(profile.id)))}><Icon name="cookie" className="sm" />{t("Add cookies")}</button>
                    <span className="vsep" />
                    {selectedMobileCount > 0 && <button className="btn warn" onClick={convertSelectedMobile}><Icon name="laptop" className="sm" />{t("Convert mobile ({count})", { count: selectedMobileCount })}</button>}
                    <div className="menuwrap" ref={exportRef}>
                      <button className="btn tip" data-tip={t("Export selected profiles")} disabled={!selected.size || !!exportProgress} onClick={() => setExportOpen((o) => !o)}><Icon name="export" className="sm" />{t("Export")}<Icon name="chevronDown" className="sm" /></button>
                      {exportOpen && selected.size > 0 && !exportProgress && (
                        <div className="exportmenu popover below-left" onMouseLeave={() => setExportOpen(false)}>
                          <button className="pop-item" onClick={() => exportSelected("csv")}><Icon name="file" className="sm" />{t("Export as CSV (credentials)")}</button>
                          <button className="pop-item" onClick={() => exportSelected("txt")}><Icon name="file" className="sm" />{t("Export as .txt (full profile)")}</button>
                          <button className="pop-item" onClick={() => exportSelected("xlsx")}><Icon name="file" className="sm" />{t("Export as Excel (full profile)")}</button>
                        </div>
                      )}
                    </div>
                    <button className="btn tip" data-tip={t("Export → edit → re-upload")} disabled={!selected.size || !!exportProgress} onClick={openUpdate} title={t("Export → edit → re-upload to change credentials in bulk")}><Icon name="edit" className="sm" />{t("Edit from file")}</button>
                    <span className="vsep" />
                    <div className="movewrap">
                      {newMode ? (<input className="input" autoFocus placeholder={t("new group name")} value={newGroup} disabled={profileMove.busy} onChange={(e) => { if (moveUiInFlight.current) return; moveDraftRevision.current++; setNewGroup(e.target.value); }} />) : (
                        <select className="select move-group" aria-label={t("Move to group")} title={moveTarget === null ? t("Choose destination group") : moveTarget || t("Ungrouped")} disabled={!selected.size || profileMove.busy} value={moveTarget === null ? "choose" : `group:${moveTarget}`} onChange={(e) => { if (moveUiInFlight.current) return; moveDraftRevision.current++; if (e.target.value === "new") setNewMode(true); else if (e.target.value.startsWith("group:")) setMoveTarget(e.target.value.slice(6)); else setMoveTarget(null); }}>
                          <option value="choose">{t("Move to…")}</option><option value="group:">{t("Ungrouped")}</option>{existingGroups.map((g) => <option key={g} value={`group:${g}`}>{g}</option>)}<option value="new">{t("+ new group…")}</option>
                        </select>
                      )}
                      {newMode && <button className="btn ghost" disabled={profileMove.busy} onClick={() => { if (moveUiInFlight.current) return; moveDraftRevision.current++; setNewMode(false); setNewGroup(""); }}>{t("cancel")}</button>}
                      <button className="btn accent" disabled={!selected.size || profileMove.busy || workspaceOperationState.blocked || (newMode ? !newGroup.trim() : moveTarget === null)} onClick={moveSelected}><Icon name="move" className="sm" />{t(profileMove.busy ? "Moving…" : "Move")}</button>
                    </div>
                    {extensions.length > 0 && selectedProfilesSupportChromeExtensions && (<>
                      <span className="vsep" />
                      <div className="extctl">
                        <span className="extctl-lbl"><Icon name="puzzle" className="sm" />{t("Extension")}</span>
                        <select className="select extctl-sel" aria-label={t("Extension for bulk assignment")} disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}><option value="">{t("choose…")}</option>{extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                        <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>{t("Add")}</button>
                        <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>{t("Remove")}</button>
                      </div>
                    </>)}
                    <span className="spacer" />
                    <button className="btn danger tip" data-tip={t("Move selected profiles to Trash")} disabled={!selected.size || deleting} onClick={deleteSelected}><Icon name="trash" className="sm" />{deleting ? t("Processing…") : t("Move {count} to Trash", { count: selected.size.toLocaleString() })}</button>
                  </ActionDock>
                </div>
              ) : view === "extensions" ? (
                <ExtensionsPage extensions={extensions} profiles={profiles} groupDefaults={groupExtensionDefaults} selectedGroup={groupDefaultName} selectedExtensionIds={groupDefaultExts} source={extSource} loading={extLoading} installing={extInstallBusy} uploading={extBusy} applying={groupDefaultBusy} error={extErr} dataFresh={extDataFresh} selectedGroupAvailable={extensionDraftState.selected?.available !== false} draftDirty={!!extensionDraftState.selected?.dirty} onDiscardGroupDraft={() => extensionDrafts.discard()} retainedGroupDrafts={extensionDraftState.drafts.filter((draft) => !draft.available && draft.dirty).map((draft) => draft.group)} onReload={async () => { if (!await refreshExtensionState()) throw new Error("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes."); }} onPreviewGroupDefaults={(selection, signal) => previewGroupExtensionDefaults(selection.group, selection.extensions, signal)} onSourceChange={setExtSource} onSelectGroup={(name) => extensionDrafts.select(name)} onToggleExtension={toggleGroupDefaultExt} onInstall={doInstallWebStoreExtension} onUpload={doUploadExtensions} onApplyGroupDefaults={applyGroupExtensionDefault} onRemove={doRemoveExtension} onOpenProfile={(id) => { if (!editModal.isEditSessionOpen()) editModal.openEdit(id); }} />
              ) : null}

              {scriptsVisit.current.visited && <ScriptsPage key={currentWorkspaceId} active={view === "scripts"} onViewRun={() => setScriptRunOpen(true)} />}
              {settingsVisited.current && (
                <SettingsPanel visible={view === "settings"} workspaceId={catalog?.currentId} tabs={SETTINGS_TABS} activeTab={settingsTab} onTabChange={setSettingsTab} updateTabRef={updateTabRef} settingsPanelRef={settingsPanelRef} signedUpdateStartup={signedUpdateStartup} onProfilesImported={refreshImportedProfiles} onLocateSnapshotProfile={locateProfile} onOpenAssistant={() => setView("assistant")} onCreateWithLocalProxy={createModal.beginCreate} runtimeDownloads={runtimeDownloads} runtimeDownloadsStale={runtimeDownloadsStale} onAssignLocalProxy={startLocalProxyAssignment} onResumeLocalProxyAssignment={activeLocalProxyIntent ? () => setView("proxies") : undefined} localProxyAssignmentBlocked={workspaceOperationState.blocked} fingerprintRefreshVersion={fingerprintRefreshVersion} onInspectProfile={openInspection} onEditProfile={(id) => { if (!editModal.isEditSessionOpen()) editModal.openEdit(id); }} onExplainFingerprint={explainFingerprint} currentWorkspaceName={currentName} profileCount={profiles.length} language={language} onLanguageChange={setLanguage} onLanguageError={setActionErr} themes={THEMES} theme={theme} onThemeChange={chooseTheme} rosterDensity={rosterDensity} onRosterDensityChange={chooseRosterDensity} viewPreferencesReady={viewPreferencesReady} viewPreferencesLoading={viewPreferencesLoading} viewPreferenceBusy={viewPreferenceBusy} viewPreferenceReadError={viewPreferenceReadError} onRetryViewPreferences={() => setPreferenceLoadAttempt((value) => value + 1)} motionPreference={motion.preference} onMotionPreferenceChange={motion.setPreference} logErr={logErr} onLogErr={setLogErr} onLogView={setLogView} logDir={logDir} modeErr={modeErr} onDone={() => setView("profiles")} />
              )}
            </ErrorBoundary>
          </div>
          <footer className="workspace-footer"><span><Icon name="laptop" className="sm" />{t("Data stays on this device")}</span><span>猫步·千境{appVersion ? ` · ${appVersion}` : ""}</span></footer>
        </div>

        <LogModal logView={logView} logErr={logErr} onClose={() => { setLogView(null); setLogErr(null); }} />
        <CookieImportTaskDialog task={cookieImport.task} open={!!cookieTargets} targets={cookieTargets ?? lastCookieTargets.current} onClose={closeCookie} />
        <MoveFolderModal movingFolder={movingFolder} folderParent={folderParent} folderMoveBusy={folderMoveBusy} folderMoveErr={folderMoveErr} tree={tree} onParentChange={setFolderParent} onClose={() => { if (!folderMoveBusy) setMovingFolder(null); }} onCommit={() => void commitFolderMove()} />
        <ProfileCreateModal controller={createModal} appMode={appMode} existingGroups={existingGroups} windowChrome={windowChrome} editorScroll={editorScroll} />
        <ProfileEditModal controller={editModal} existingGroups={existingGroups} windowChrome={windowChrome} editorScroll={editorScroll} onFlash={flash} />
        <ProfileImportModal controller={importModal} existingGroups={existingGroups} />
        <ProfileFileUpdateDialog open={showUpdate} task={fileUpdate.task} onClose={() => setShowUpdate(false)} selectedCount={selected.size} onExport={exportSelected} onDownloadTemplate={() => downloadText("maobu-qianjing-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")} />
        <ScriptRunPanel open={scriptRunOpen} selectedProfiles={scriptRunProfiles} onClose={() => setScriptRunOpen(false)} />
        <ResourceDashboardDrawer open={resourceDrawerOpen} onClose={() => setResourceDrawerOpen(false)} profiles={profiles} monitor={resourceMonitor} onRefreshRoster={load} onFlash={flash} />
        <WindowSyncPanel open={windowSyncOpen} onClose={() => setWindowSyncOpen(false)} profiles={profiles} syncState={syncState} onSyncStateChange={setSyncState} onFlash={flash} />
      </div>
    </>
  );
}

function DesktopCloseShell() {
  const registry = useDesktopCloseRegistry();
  return <DesktopCloseRegistryProvider registry={registry}><DesktopCloseHost registry={registry} returnFocus={() => document.querySelector<HTMLButtonElement>(".command-palette-trigger")} /><App /></DesktopCloseRegistryProvider>;
}

const rootElement = document.getElementById("root")!;
installExternalLinkHandler(rootElement);
const root = createRoot(rootElement);
root.render(<I18nProvider><ErrorBoundary scope="Application"><WorkspaceProvider><DesktopCloseShell /></WorkspaceProvider></ErrorBoundary></I18nProvider>);
