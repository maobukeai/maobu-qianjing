import * as React from "react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./proxies.css";
import maobuMarkUrl from "./maobu-mark.png";
import { ProxiesPage } from "./proxies.tsx";
import type { ProxyAssignmentSnapshot } from "./proxy-assignment-task.ts";
import type { LocalProxyAssignmentIntent } from "./local-proxy-assignment-draft.tsx";
import { useNavigationMotion } from "./navigation-motion.ts";
import { EnvironmentInspectionPage, type InspectionEditField } from "./environment-inspection.tsx";
import { ExtensionsPage, type GroupDefaultsSnapshot } from "./extensions-page.tsx";
import { createExtensionDefaultDrafts } from "./extension-default-drafts.ts";
import { previewGroupExtensionDefaults } from "./api.ts";
import { DesktopCloseHost, DesktopCloseRegistryProvider, useDesktopCloseDraft, useDesktopCloseRegistry } from "./desktop-close.tsx";
import { RosterViews } from "./roster-views.tsx";
import { RosterDensityControl, ROSTER_DENSITY_KEY, parseRosterDensity, type RosterDensity } from "./roster-density.tsx";
import { ProfileTagsDialog, type ProfileTagsTarget } from "./profile-tags.tsx";
import { profileTagsUpdate } from "../profile-tags.ts";
import { createImportReceipt, ImportReceiptError, type ImportReceipt } from "./import-receipt-data.ts";
import { ImportReceiptPanel } from "./import-receipt.tsx";
import { useBackgroundScriptRun } from "./background-script-run.tsx";
import { WorkbenchActivity, type WorkbenchActivityItem } from "./workbench-activity.tsx";
import { useProfileFileUpdate, ProfileFileUpdateDialog, ProfileFileUpdatePanel } from "./profile-file-update-panel.tsx";
import { useProfileMove, ProfileMoveFeedback, type ProfileMoveResult } from "./profile-move.tsx";
import { captureProfileEditSnapshot, buildProfileEditPatch, ProfileEditPatchError, PROFILE_EDIT_FORM_FIELDS, type ProfileEditSnapshot, type ProfileEditSummary } from "./profile-edit-patch.ts";
import { EditChangesSummary } from "./edit-changes-summary.tsx";
import { ProfileEditorStatus, type ProfileEditorBrowserLabel } from "./profile-editor-status.tsx";
import { EditorWindowControls } from "./editor-window-controls.tsx";
import { useUnsavedChangesGuard } from "./unsaved-changes-guard.tsx";
import { useCookieImportTask, CookieImportTaskDialog, CookieImportTaskPanel } from "./cookie-import-task-panel.tsx";
import { changeProfileRangeSelection, reconcileProfileSelectionAnchor, type ProfileSelectionAnchor } from "./profile-range-selection.ts";
import { createBulkProfileTask, type BulkProfileTask, type BulkProfileAction, type BulkProfileTaskSnapshot } from "./bulk-profile-task.ts";
import { BulkProfileTaskPanel } from "./bulk-profile-task-panel.tsx";
import { useDesktopMotion, MotionPresence, usePanelMotion } from "./desktop-motion.tsx";
import { FAVORITE_PROFILES_KEY, SAVED_PROFILE_VIEWS_KEY, parseFavoriteProfiles, parseSavedProfileViews, serializeFavoriteProfiles, serializeSavedProfileViews, inProfileScope, type ProfileViewFilters, type RosterScope, type SavedProfileView } from "../profile-view-state.ts";
import { type FeatureSettingsTab, type LocalProxyDraftCandidate } from "./settings-center.tsx";
import { useSignedUpdateStartup } from "./signed-updates.tsx";
import { FingerprintImportBadge } from "./fingerprint-import-badge.tsx";
import { RuntimeDownloadProgressView, runtimeDownloadLabel } from "./runtime-download-progress.tsx";
import { CommandPalette, type CommandPaletteCommand } from "./command-palette.tsx";
import { ShortcutHelp } from "./shortcut-help.tsx";
import { getWorkbenchShortcut, readWorkbenchShortcutContext, type WorkbenchShortcutAction } from "./workbench-shortcuts.ts";
import { LocalAssistantPage, type AssistantDraftSuggestion } from "./local-assistant.tsx";
import { buildFingerprintAssistantBrief } from "./fingerprint-assistant-brief.ts";
import type { FingerprintReport } from "./settings-api.ts";
import { proxyExitNote } from "./proxy-check-presentation.ts";
import { ProfileTemplates } from "./profile-templates.tsx";
import { profileCreationRuntime, type FormChromiumRuntime } from "./profile-creation-runtime.ts";
import { fetchReusableProfile, type ReusableProfileSettings } from "./profile-reuse-api.ts";
import { installExternalLinkHandler } from "./external-links.ts";
import { TrashPage } from "./trash.tsx";
import type { TrashTaskSnapshot } from "./trash-task.ts";
import { parsePastedProxy } from "./proxy-input.ts";
import { ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
import { I18nProvider, useTranslation } from "./i18n.tsx";
import { ErrorBoundary } from "./error-boundary.tsx";
import { AppIcon, type IconName, useConfirmDialog } from "./ui-primitives.tsx";
import { useRosterPolling } from "./hooks/use-roster-polling.ts";
import { useProfileMetrics } from "./hooks/use-profile-selection.ts";
import { copyPlainText, CopyField } from "./features/copy-field.tsx";
import { LogModal } from "./features/log-modal.tsx";
import { MoveFolderModal } from "./features/move-folder-modal.tsx";
import { SettingsPanel } from "./features/settings-panel.tsx";
import { localeTimezoneMismatch } from "../profile-locale.ts";
import { folderTree, folderScope, type FolderInfo } from "../folders.ts";
import { GROUP_DISCLOSURE_KEY, profileGroupCollapsed, profileGroupSections, readGroupDisclosure, serializeGroupDisclosure, toggleProfileSelection } from "../profile-group-state.ts";
import { THEME_KEY, readThemeChoice, themeCookie, type ThemeChoice } from "./theme.ts";
import { ProfileActionMenu } from "./profile-action-menu.tsx";
import { WorkspaceProvider, WorkspaceSwitcher, WorkspaceManagementPage, WorkspaceActivity, DevicePanel, useWorkspaceCatalog, type WorkspacePageIntent, type WorkspacePageRequest } from "./workspace-manager.tsx";
import { useWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { fetchWorkspacePreferences, saveWorkspacePreference } from "./workspaces-api.ts";
import { DesktopStartupBar, WindowActionError, WindowControls, useWindowChrome } from "./window-chrome.tsx";
import { AboutPopover } from "./about-popover.tsx";
import { type UiProfile, type DiagnoseReport, type EditProfile, type Extension, type GroupExtensionDefaults, type AppModeConfig, fetchAppMode, fetchRuntimeDownloads, type RuntimeDownload, fetchProfiles, fetchHealth, fetchDiskSpace, type DiskSpace, fetchLogs, fetchDiagnose, checkProxy, ProxyCheckError, type ProxyCheckInput, type ProxyCheckResult, fetchPendingCookies, clearPendingCookies, openProfile, closeProfile, restartProfile, raiseProfile, fetchExtensions, installWebStoreExtension, uploadExtensions, removeExtension, assignExtensionBulk, fetchGroupExtensionDefaults, setGroupExtensionDefaults, uploadExports, moveProfiles, deleteProfiles, createProfile, fetchProfileEdit, updateProfile, refreshProfileTimezone, convertMobileProfile, exportProfiles, type ExportFormat, type ExportProgress, createGroup, renameGroup, moveGroup, deleteGroup, fetchTotp, isUnauthorizedError, setStandaloneSessionToken, subscribeUnauthorized } from "./api.ts";
const emptyBulkSnapshot = (): BulkProfileTaskSnapshot | null => null;
const noBulkSubscription = (_listener: () => void) => () => {};
/** Run async tasks with bounded concurrency (so "Open 50" isn't 50 at once). */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const worker = async () => { while (i < items.length) await fn(items[i++]!); };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
const CSV_TEMPLATE =
  "name,group,platform,proxy,username,password,email,emailpassword,twofa\n" +
  "alice_warmup,Warmup,x.com,1.2.3.4:8080:proxyuser:proxypass,alice_user,SuperSecret1,alice@example.com,MailboxSecret1,JBSWY3DPEHPK3PXP\n" +
  "bob_eu,EU,telegram.org,,bob_user,SuperSecret2,bob@example.com,MailboxSecret2,\n" +
  "carol_noproxy,Warmup,,,carol_user,SuperSecret3,carol@example.com,MailboxSecret3,KRSXG5CTMVRXEZLU\n";
const TXT_EXAMPLE =
  "id=k1example01\ngroup=Warmup\nplatform=x.com\nname=alice_warmup\nusername=alice@example.com\n" +
  "password=SuperSecret1\nemail=mailbox@example.com\nemailpassword=MailboxSecret1\nfakey=JBSWY3DPEHPK3PXP\ncookie=[]\nproxytype=http\n" +
  "proxy=1.2.3.4:8080:proxyuser:proxypass\nua=\nresolution=1920*1080\n******************\n";
// Example sheet for the Update-from-file flow. The FIRST column (id) is what
// matches each row to an existing profile — keep it. Edit the other columns;
// delete any column you don't want to change.
const UPDATE_TEMPLATE_CSV =
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution,custom_no\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080,123456\n";
/**
 * How many profiles a pasted AdsPower export would create. Every record starts
 * with its own `id=` line, so counting those is exact rather than a guess at
 * blocks — and it gives the operator a number to sanity-check before importing.
 */
function countPastedRecords(text: string): number {
  return (text.match(/^id=/gm) ?? []).length;
}
function sameExtensionSelection(left: string[], right: string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}
function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const REFRESH_MS = 3000;
const PROFILE_PAGE_SIZE = 20;
const PAGE_SIZES = [20, 25, 50, 100, 200];
const PAGE_TITLES: Record<"profiles" | "inspection" | "scripts" | "settings" | "extensions" | "proxies" | "trash" | "workspaces" | "assistant", string> = {
    profiles: "Profiles",
    inspection: "Environment inspection",
    scripts: "Scripts",
    settings: "Settings",
    extensions: "Extensions",
    proxies: "Proxies",
    trash: "Trash",
    workspaces: "Workspace management",
    assistant: "AI workspace",
};
const SETTINGS_TABS = [{ key: "account", label: "General" }, { key: "network", label: "Network & proxies" }, { key: "fingerprints", label: "Fingerprint quality" }, { key: "models", label: "Model services" }, { key: "integrations", label: "AI & MCP" }, { key: "sync", label: "Sync & portability" }, { key: "updates", label: "App updates" }, { key: "advanced", label: "Advanced" }] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];
/** Mirrors MAX_CUSTOM_NO_LENGTH in parse.ts — the server rejects anything longer. */
const MAX_CUSTOM_NO = 12;
/**
 * Roster columns. `width` is the single source of truth: each column is laid out
 * at exactly that width and the table's min-width is their sum, so a column can
 * never be squeezed below a readable size — the roster scrolls sideways instead.
 * Only the checkbox column is fixed; everything else can be hidden.
 */
const COLUMNS = [
  { key: "no", label: "No.", sort: true, width: 52 },
  { key: "name", label: "Name", sort: true, width: 200 },
  { key: "group", label: "Group", sort: true, width: 100 },
  { key: "platform", label: "Platform", sort: true, width: 128 },
  { key: "tags", label: "Tags", sort: false, width: 140 },
  { key: "proxy", label: "Proxy", sort: true, width: 150 },
  { key: "status", label: "Status", sort: false, width: 90 },
  /* The launch action stays visible; the labeled menu holds secondary actions. */
  { key: "action", label: "Action", sort: false, width: 132 },
] as const;
/** Width of the always-present select-all checkbox column. */
const CHECKBOX_COLUMN_WIDTH = 36;
type ColumnKey = (typeof COLUMNS)[number]["key"];
type SortKey = ColumnKey | "status";
const THEMES = [
  { key: "system", label: "System", icon: "laptop" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
] as const;
function readTheme(): ThemeChoice {
  let cookies = "";
  let stored: string | null = null;
  try { cookies = document.cookie; } catch {}
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  return readThemeChoice(cookies, stored);
}
const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";
/**
 * Below this width the sidebar always renders as the icon rail. Hiding it
 * entirely (the old breakpoint behavior) left a small window with no
 * navigation at all — this is a desktop app and the user sizes it freely.
 */
const RAIL_MEDIA = "(max-width: 760px)";
function readRailForced(): boolean {
  try { return window.matchMedia(RAIL_MEDIA).matches; } catch { return false; }
}
const HIDDEN_COLUMNS_KEY = "aliasmode.roster.hiddenColumns";
const PAGE_SIZE_KEY = "aliasmode.roster.pageSize";
/** Keep the everyday view focused; optional columns stay in the column picker. */
const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["no", "group", "platform", "tags"];
/** Roster layout preferences are a convenience: a hostile/empty store must not break the view. */
function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (stored === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
    const raw = JSON.parse(stored);
    const known = new Set(COLUMNS.map((column) => column.key as string));
    return new Set((Array.isArray(raw) ? raw : []).filter((key) => known.has(key)) as ColumnKey[]);
  } catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }
}
function readSidebarCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
    return typeof window !== "undefined" ? window.innerWidth < 1200 : true;
  } catch { return true; }
}
function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(stored) ? stored : PROFILE_PAGE_SIZE;
  } catch { return PROFILE_PAGE_SIZE; }
}
let preferenceRevision = 0;
function readFavorites(): string[] { try { return parseFavoriteProfiles(localStorage.getItem(FAVORITE_PROFILES_KEY)) ?? []; } catch { return []; } }
function readSavedViews(): SavedProfileView[] { try { return parseSavedProfileViews(localStorage.getItem(SAVED_PROFILE_VIEWS_KEY)) ?? []; } catch { return []; } }
function readRosterDensity(): RosterDensity { try { return parseRosterDensity(localStorage.getItem(ROSTER_DENSITY_KEY)); } catch { return "comfortable"; } }
function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / disabled storage */ }
  if ([HIDDEN_COLUMNS_KEY, PAGE_SIZE_KEY, SIDEBAR_KEY, GROUP_DISCLOSURE_KEY].includes(key)) {
    preferenceRevision++;
    void saveWorkspacePreference(key, value).catch((error) => window.dispatchEvent(new CustomEvent("workspace-preference-error", { detail: error instanceof Error ? error.message : String(error) })));
  }
}
const Icon = AppIcon;
/**
 * Close a popover on outside click or Escape. The returned ref goes on the
 * wrapper holding BOTH the trigger and the panel, so clicking the trigger again
 * toggles it instead of closing and immediately reopening.
 */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
    const ref = useRef<T>(null);
    const onClose = useRef(close);
    onClose.current = close;
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose.current();
    };
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    }, [open]);
    return ref;
}
/** The shared app mark keeps the approved brand colours in either theme. */
function MaobuMark({ className }: {
    className?: string;
}) {
    return <img className={className ? `maobu-mark ${className}` : "maobu-mark"} src={maobuMarkUrl} width={32} height={32} alt="" aria-hidden="true" />;
}
/**
 * The number an operator sees for a profile: their custom NO. when set, else the
 * store serial, else the row's position. Mirrors profileDisplayNo in launcher.ts
 * so the roster, the browser window title and the identity bookmark agree.
 */
function displayNo(profile: UiProfile, fallbackIndex: number): { value: string; custom: boolean } {
  const custom = (profile.customNo ?? "").trim();
  if (custom) return { value: custom, custom: true };
  if (profile.serial != null) return { value: String(profile.serial), custom: false };
  return { value: String(fallbackIndex + 1), custom: false };
}
function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "running" : "stopped"} />;
}

/** Keep keyboard navigation inside an editor and return to its entry point. */
function useProfileEditorFocus(open: boolean, ready = true, returnFocus?: { current: HTMLElement | null }, fieldOnOpen?: { current: InspectionEditField | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const editor = ref.current;
    if (!editor) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...editor.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
      .filter(element => !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) { event.preventDefault(); editor.focus(); return; }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === editor || !editor.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !editor.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    editor.focus();
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const target = returnFocus?.current?.isConnected ? returnFocus.current : previous;
      if (returnFocus) returnFocus.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocus]);
  useEffect(() => {
    const editor = ref.current;
    if (!open || !ready || !editor) return;
    if (fieldOnOpen?.current) {
      const field = fieldOnOpen.current;
      fieldOnOpen.current = null;
      if (document.activeElement !== editor && editor.contains(document.activeElement)) return;
      const target = editor.querySelector<HTMLElement>(`[data-profile-field="${field}"]:not(:disabled)`);
      if (target) { focusEditorTarget(target, "instant"); return; }
    }
    editor.querySelector<HTMLInputElement>('.modal-body input:not(:disabled):not([readonly])')?.focus({ preventScroll: true });
  }, [open, ready, fieldOnOpen]);
  return ref;
}

/**
 * Real brand marks for the platforms a profile can target. A letter in a colored
 * box reads as a placeholder; the actual logo is what makes a row scannable at a
 * glance. Paths are the official single-color marks on a 24x24 grid, filled (not
 * stroked) — see .brandmark in styles.css. Tile colors live in CSS as .pm-*.
 */
const PLATFORM_MARKS: Record<string, { key: string; path: string }> = {
  "x.com": {
    key: "x",
    path: "M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932ZM17.61 20.644h2.04L6.486 3.24H4.298Z",
  },
  "telegram.org": {
    key: "telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
  "instagram.com": {
    key: "instagram",
    path: "M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.13 5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z",
  },
  "facebook.com": {
    key: "facebook",
    path: "M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z",
  },
  "tiktok.com": {
    key: "tiktok",
    path: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z",
  },
  "linkedin.com": {
    key: "linkedin",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  "reddit.com": {
    key: "reddit",
    path: "M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0Zm6.07 6.53a1.4 1.4 0 0 1 1.4 1.4 1.4 1.4 0 0 1-.83 1.28c.02.15.03.3.03.45 0 2.87-3.44 5.2-7.67 5.2s-7.67-2.33-7.67-5.2c0-.16.01-.31.03-.46a1.4 1.4 0 1 1 1.58-2.28 7.6 7.6 0 0 1 4.1-1.31l.78-3.66a.34.34 0 0 1 .4-.26l2.6.55a1 1 0 1 1-.14.67l-2.24-.48-.7 3.3c1.5.06 2.9.5 4.05 1.2a1.4 1.4 0 0 1 1.28-.8ZM8.1 10.42a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm7.8 0a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm-7.6 4.9a.34.34 0 0 0-.24.58c.98.98 2.53 1.46 3.94 1.46s2.96-.48 3.94-1.46a.34.34 0 0 0-.48-.48c-.78.78-2.1 1.18-3.46 1.18s-2.68-.4-3.46-1.18a.34.34 0 0 0-.24-.1Z",
  },
  "youtube.com": {
    key: "youtube",
    path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  },
  "threads.com": {
    key: "threads",
    path: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z",
  },
  "pinterest.com": {
    key: "pinterest",
    path: "M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z",
  },
  "snapchat.com": {
    key: "snapchat",
    path: "M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z",
  },
  "discord.com": {
    key: "discord",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  },
  "twitch.tv": {
    key: "twitch",
    path: "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z",
  },
  "gmail.com": {
    key: "gmail",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  "amazon.com": {
    key: "amazon",
    path: "M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.14c.138-.06.234-.1.293-.13.226-.088.39-.046.525.13.12.174.09.336-.12.48-.256.19-.6.41-1.006.654-1.244.743-2.64 1.316-4.185 1.726a17.617 17.617 0 01-10.951-.577 17.88 17.88 0 01-5.43-3.35c-.1-.074-.151-.15-.151-.22 0-.047.021-.09.051-.13zm6.565-6.218c0-1.005.247-1.863.743-2.577.495-.71 1.17-1.25 2.04-1.615.796-.335 1.756-.575 2.912-.72.39-.046 1.033-.103 1.92-.174v-.37c0-.93-.105-1.558-.3-1.875-.302-.43-.78-.65-1.44-.65h-.182c-.48.046-.896.196-1.246.46-.35.27-.575.63-.675 1.096-.06.3-.206.465-.435.51l-2.52-.315c-.248-.06-.372-.18-.372-.39 0-.046.007-.09.022-.15.247-1.29.855-2.25 1.82-2.88.976-.616 2.1-.975 3.39-1.05h.54c1.65 0 2.957.434 3.888 1.29.135.15.27.3.405.48.12.165.224.314.283.45.075.134.15.33.195.57.06.254.105.42.135.51.03.104.062.3.076.615.01.313.02.493.02.553v5.28c0 .376.06.72.165 1.036.105.313.21.54.315.674l.51.674c.09.136.136.256.136.36 0 .12-.06.226-.18.314-1.2 1.05-1.86 1.62-1.963 1.71-.165.135-.375.15-.63.045a6.062 6.062 0 01-.526-.496l-.31-.347a9.391 9.391 0 01-.317-.42l-.3-.435c-.81.886-1.603 1.44-2.4 1.665-.494.15-1.093.227-1.83.227-1.11 0-2.04-.343-2.76-1.034-.72-.69-1.08-1.665-1.08-2.94l-.05-.076zm3.753-.438c0 .566.14 1.02.425 1.364.285.34.675.512 1.155.512.045 0 .106-.007.195-.02.09-.016.134-.023.166-.023.614-.16 1.08-.553 1.424-1.178.165-.28.285-.58.36-.91.09-.32.12-.59.135-.8.015-.195.015-.54.015-1.005v-.54c-.84 0-1.484.06-1.92.18-1.275.36-1.92 1.17-1.92 2.43l-.035-.02zm9.162 7.027c.03-.06.075-.11.132-.17.362-.243.714-.41 1.05-.5a8.094 8.094 0 011.612-.24c.14-.012.28 0 .41.03.65.06 1.05.168 1.172.33.063.09.099.228.099.39v.15c0 .51-.149 1.11-.424 1.8-.278.69-.664 1.248-1.156 1.68-.073.06-.14.09-.197.09-.03 0-.06 0-.09-.012-.09-.044-.107-.12-.064-.24.54-1.26.806-2.143.806-2.64 0-.15-.03-.27-.087-.344-.145-.166-.55-.257-1.224-.257-.243 0-.533.016-.87.046-.363.045-.7.09-1 .135-.09 0-.148-.014-.18-.044-.03-.03-.036-.047-.02-.077 0-.017.006-.03.02-.063v-.06z",
  },
  "ebay.com": {
    key: "ebay",
    path: "M6.056 12.132v-4.92h1.2v3.026c.59-.703 1.402-.906 2.202-.906 1.34 0 2.828.904 2.828 2.855 0 .233-.015.457-.06.668.24-.953 1.274-1.305 2.896-1.344.51-.018 1.095-.018 1.56-.018v-.135c0-.885-.556-1.244-1.53-1.244-.72 0-1.245.3-1.305.81h-1.275c.136-1.29 1.5-1.62 2.686-1.62 1.064 0 1.995.27 2.415 1.02l-.436-.84h1.41l2.055 4.125 2.055-4.126H24l-3.72 7.305h-1.346l1.07-2.04-2.33-4.38c.13.255.2.555.2.93v2.46c0 .346.01.69.04 1.005H16.8a6.543 6.543 0 01-.046-.765c-.603.734-1.32.96-2.32.96-1.48 0-2.272-.78-2.272-1.695 0-.15.015-.284.037-.405-.3 1.246-1.36 2.086-2.767 2.086-.87 0-1.694-.315-2.2-.93 0 .24-.015.494-.04.734h-1.18c.02-.39.04-.855.04-1.245v-1.05h-4.83c.065 1.095.818 1.74 1.853 1.74.718 0 1.355-.3 1.568-.93h1.24c-.24 1.29-1.61 1.725-2.79 1.725C.95 15.009 0 13.822 0 12.232c0-1.754.982-2.91 3.116-2.91 1.688 0 2.93.886 2.94 2.806v.005zm9.137.183c-1.095.034-1.77.233-1.77.95 0 .465.36.97 1.305.97 1.26 0 1.935-.69 1.935-1.814v-.13c-.45 0-.99.006-1.484.022h.012zm-6.06 1.875c1.11 0 1.876-.806 1.876-2.02s-.768-2.02-1.893-2.02c-1.11 0-1.89.806-1.89 2.02s.765 2.02 1.875 2.02h.03zm-4.35-2.514c-.044-1.125-.854-1.546-1.725-1.546-.944 0-1.694.474-1.815 1.546z",
  },
  "etsy.com": {
    key: "etsy",
    path: "M8.559 2.445c0-.325.033-.52.59-.52h7.465c1.3 0 2.02 1.11 2.54 3.193l.42 1.666h1.27c.23-4.728.43-6.784.43-6.784s-3.196.36-5.09.36H6.635L1.521.196v1.37l1.725.326c1.21.24 1.5.496 1.6 1.606 0 0 .11 3.27.11 8.64 0 5.385-.09 8.61-.09 8.61 0 .973-.39 1.333-1.59 1.573l-1.722.33V24l5.13-.165h8.55c1.935 0 6.39.165 6.39.165.105-1.17.75-6.48.855-7.064h-1.2l-1.284 2.91c-1.005 2.28-2.476 2.445-4.11 2.445h-4.906c-1.63 0-2.415-.64-2.415-2.05V12.8s3.62 0 4.79.096c.912.064 1.463.325 1.76 1.598l.39 1.695h1.41l-.09-4.278.192-4.305h-1.391l-.45 1.89c-.283 1.244-.48 1.47-1.754 1.6-1.666.17-4.815.14-4.815.14V2.45h-.05z",
  },
};
const KNOWN_PLATFORMS: { value: string; label: string }[] = [
  { value: "", label: "(none)" },
  { value: "x.com", label: "Twitter / X" },
  { value: "instagram.com", label: "Instagram" },
  { value: "facebook.com", label: "Facebook" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "linkedin.com", label: "LinkedIn" },
  { value: "reddit.com", label: "Reddit" },
  { value: "telegram.org", label: "Telegram" },
  { value: "youtube.com", label: "YouTube" },
  { value: "threads.com", label: "Threads" },
  { value: "pinterest.com", label: "Pinterest" },
  { value: "snapchat.com", label: "Snapchat" },
  { value: "discord.com", label: "Discord" },
  { value: "twitch.tv", label: "Twitch" },
  { value: "gmail.com", label: "Gmail" },
  { value: "amazon.com", label: "Amazon" },
  { value: "ebay.com", label: "eBay" },
  { value: "etsy.com", label: "Etsy" },
];
function PlatformPill({ platform }: {
    platform: string;
}) {
    if (!platform) return <span className="muted">—</span>;
    const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
    const mark = PLATFORM_MARKS[platform];
    return (<span className="platform-pill" title={platform}>
      <span className={`glyph pm-${mark?.key ?? "other"}`}>
        {mark
          ? <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={mark.path} /></svg>
          : platform.slice(0, 1).toUpperCase()}
      </span>
      {known?.label ?? platform}
    </span>);
}
/**
 * Group selector used in every dialog: a styled <select> of existing groups
 * plus "➕ New group…", which flips to an inline text field so you can create a
 * group on the fly. Consistent with the other modal selects (no native datalist).
 */
interface EditorFieldFeedback { field: string; invalid: boolean; describedBy: string }
function editorFieldAttributes(feedback?: EditorFieldFeedback) {
  return { "data-profile-field": feedback?.field, "aria-invalid": feedback?.invalid || undefined, "aria-describedby": feedback?.invalid ? feedback.describedBy : undefined };
}
function focusEditorTarget(target: HTMLElement | null | undefined, behavior: ScrollBehavior) {
  if (!target) return;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === "DETAILS") (ancestor as HTMLDetailsElement).open = true;
  target.focus({ preventScroll: true }); target.scrollIntoView({ behavior, block: "nearest" });
}
function GroupPicker({ value, onChange, groups, allowCreate = true, emptyLabel = "(ungrouped)" }: {
    value: string;
    onChange: (v: string) => void;
    groups: string[];
    allowCreate?: boolean;
    emptyLabel?: string;
}) {
    const { t } = useTranslation();
    const [creating, setCreating] = useState(false);
    if (creating) {
        return (<div className="grouppick">
        <input autoFocus placeholder={t("new group name")} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip={t("Pick an existing group")} title={t("Pick an existing group")} onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>);
    }
    return (<select value={groups.includes(value) ? value : ""} onChange={(e) => {
        if (e.target.value === "__new__") { setCreating(true); onChange(""); }
        else onChange(e.target.value);
      }}>
      <option value="">{t(emptyLabel)}</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
      {allowCreate && <option value="__new__">{t("➕ New group…")}</option>}
    </select>);
}
function PlatformPicker({ value, onChange }: {
    value: string;
    onChange: (v: string) => void;
}) {
    const { t } = useTranslation();
    const known = KNOWN_PLATFORMS.some((p) => p.value === value);
    const [creating, setCreating] = useState(false);
    if (creating || (!!value && !known)) {
        return (<div className="grouppick">
        <input autoFocus placeholder={t("new platform (e.g. linkedin.com)")} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip={t("Pick a known platform")} title={t("Pick a known platform")} onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>);
    }
    return (<select value={value} onChange={(e) => {
        if (e.target.value === "__new__") { setCreating(true); onChange(""); }
        else onChange(e.target.value);
      }}>
      {KNOWN_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.value ? p.label : t(p.label)}</option>)}
      <option value="__new__">{t("➕ New platform…")}</option>
    </select>);
}
const AUTOMATIC_FINGERPRINT_FIELDS = [
  ["User agent", "Automatic"],
  ["Browser version", "Automatic · latest installed"],
  ["GPU", "Automatic"],
  ["CPU", "Automatic"],
  ["RAM", "Automatic"],
  ["Fingerprint seed", "Automatic · unique and stable"],
  ["Timezone", "Stored · set from the proxy automatically"],
  ["Canvas / WebGL / audio", "Automatic"],
  ["WebRTC", "Automatic · proxy-aware"],
] as const;
// A template literal, so the translation key holds the same line breaks as the source.
const FINGERPRINT_EDIT_WARNING = `These settings work together. Changing them can create an inconsistent fingerprint, make your browser easier to detect, or trigger account verification. We recommend automatic settings. Custom changes are your responsibility.

Save fingerprint changes?`;
const CLOAKBROWSER_NOTE = "CloakBrowser profiles on one computer can be linked to each other. Use Chromium or Firefox for separate identities.";
function browserLabel(engine: "chromium" | "firefox", chromiumRuntime?: string): ProfileEditorBrowserLabel {
  if (engine === "firefox") return "Firefox";
  return chromiumRuntime ? "Chromium" : "CloakBrowser";
}
function validEditDetail(value: unknown, id: string): value is EditProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return profile.id === id && (profile.engine === "chromium" || profile.engine === "firefox")
    && ["name", "group", "platform", "proxyType", "proxy", "username", "password", "email", "emailPassword", "twofa", "resolution", "tags", "timezone", "platformOs"].every(key => typeof profile[key] === "string")
    && ["chromiumRuntime", "proxyError", "customNo", "locale", "cores", "fingerprintSeed"].every(key => profile[key] === undefined || typeof profile[key] === "string")
    && Array.isArray(profile.extensions) && profile.extensions.every(extension => typeof extension === "string");
}
function FingerprintSettings({ engine, chromiumRuntime, screen, onScreenChange, platformOs, onPlatformOsChange, timezone, onTimezoneChange, locale, onLocaleChange, cores, onCoresChange, seed, onSeedChange, disabled = false, allowAutomaticScreen = true, onUndo, hardware, feedback, }: {
    engine: "chromium" | "firefox";
    chromiumRuntime?: string;
    screen: string;
    onScreenChange: (value: string) => void;
    platformOs: string;
    onPlatformOsChange?: (value: string) => void;
    timezone?: string;
    onTimezoneChange?: (value: string) => void;
    locale?: string;
    onLocaleChange?: (value: string) => void;
    cores?: string;
    onCoresChange?: (value: string) => void;
    seed?: string;
    onSeedChange?: (value: string) => void;
    disabled?: boolean;
    allowAutomaticScreen?: boolean;
    onUndo?: () => void;
    feedback?: (field: string) => EditorFieldFeedback;
    hardware?: {
        gpu?: string;
        cores?: number;
    };
}) {
    const { t } = useTranslation();
    return (<details className="fingerprint-settings">
      <summary>
        <span>{t("Fingerprint settings")}</span>
        <span className="automatic-badge">{onTimezoneChange ? t("Advanced") : t("Automatic")}</span>
      </summary>
      <div className="fingerprint-grid">
        <label className="fld">
          <span>{t("Browser")}</span>
          <input value={browserLabel(engine, chromiumRuntime)} readOnly tabIndex={-1} className="ro" />
        </label>
        <label className="fld">
          <span>{t("Screen")}</span>
          <input {...editorFieldAttributes(feedback?.("resolution"))} value={screen} disabled={disabled} placeholder={allowAutomaticScreen ? t("Automatic · e.g. 1920x1080") : t("Required · e.g. 1920x1080")} onChange={(event) => onScreenChange(event.target.value)} />
        </label>
        <label className="fld">
          <span>{t("Operating system")}</span>
          {onPlatformOsChange ? (<select {...editorFieldAttributes(feedback?.("platformOs"))} value={platformOs} disabled={disabled} onChange={(event) => onPlatformOsChange(event.target.value)}>
              <option value="">{t("Automatic — match this computer")}</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>) : (<input value={{ windows: "Windows", macos: "macOS", linux: "Linux" }[platformOs] ?? "Automatic"} readOnly tabIndex={-1} className="ro" />)}
        </label>
        {onTimezoneChange && (<label className="fld">
            <span>{t("Timezone")}</span>
            <input {...editorFieldAttributes(feedback?.("timezone"))} value={timezone ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. Europe/Paris")} onChange={(event) => onTimezoneChange(event.target.value)} />
          </label>)}
        {onLocaleChange && (<label className="fld">
            <span>{t("Language")}</span>
            <input {...editorFieldAttributes(feedback?.("locale"))} value={locale ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. en-US")} onChange={(event) => onLocaleChange(event.target.value)} />
          </label>)}
        {onCoresChange && (<label className="fld">
            <span>{t("CPU")}</span>
            <input {...editorFieldAttributes(feedback?.("cores"))} value={cores ?? ""} disabled={disabled} inputMode="numeric" placeholder={hardware?.cores ? t("Automatic · {n} cores", { n: hardware.cores }) : t("Automatic · e.g. 8")} onChange={(event) => onCoresChange(event.target.value)} />
          </label>)}
        {onSeedChange && (<label className="fld">
            <span>{t("Fingerprint seed")}</span>
            <input {...editorFieldAttributes(feedback?.("fingerprintSeed"))} value={seed ?? ""} disabled={disabled} inputMode="numeric" onChange={(event) => onSeedChange(event.target.value)} />
          </label>)}
        {AUTOMATIC_FINGERPRINT_FIELDS.filter(([label]) => !((label === "Timezone" && onTimezoneChange) || (label === "CPU" && onCoresChange) || (label === "Fingerprint seed" && onSeedChange))).map(([label, value]) => {
            // A stored value is the same on every computer that opens the profile.
            const stored = label === "GPU" ? hardware?.gpu : label === "CPU" && hardware?.cores ? `${hardware.cores} cores` : undefined;
            return (<label className="fld" key={label}>
              <span>{t(label)}</span>
              <input value={stored ? `Stored · ${stored}` : t(value)} title={stored} readOnly tabIndex={-1} className="ro" />
            </label>);
        })}
        <div className="hint">{t("We recommend keeping every setting automatic. Custom values can make the browser look inconsistent, easier to detect, and can trigger account checks.")}</div>
        <div className="hint">{onTimezoneChange
          ? `${t("Leave timezone or CPU blank for automatic settings. Screen size and fingerprint seed need explicit values; a blank language keeps the saved language. A timezone you type stays when the proxy changes.")}${chromiumRuntime && cores ? ` ${t("Chromium shows at most the processor count of the computer it runs on.")}` : ""}`
          : engine === "firefox"
            ? t("Firefox uses its native profile. CDP, PDF, and Chrome extensions are unavailable.")
            : t("The browser keeps the locked values coordinated. Screen and operating system are the only fingerprint settings you can override.")}</div>
        {onUndo && <button type="button" className="btn ghost" disabled={disabled} onClick={onUndo}>{t("Undo fingerprint edits")}</button>}
      </div>
    </details>);
}
type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
function desktopInvoke(): DesktopInvoke | undefined {
  return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined;
}
/** The browser downloads that opening this profile waits for. */
function profileDownloads(profile: UiProfile, downloads: RuntimeDownload[]): RuntimeDownload[] {
  const runtime = profile.engine === "firefox" ? "firefox" : profile.chromiumRuntime ?? "cloakbrowser";
  return downloads.filter((download) => download.runtime === runtime);
}
function launchRecovery(message: string) {
  // Older sidecars send the public launcher guidance without a separate reason code.
  if (/^(?:Firefox|Chromium|CloakBrowser|The fonts for this profile's operating system) could not be downloaded\b/.test(message)) return "download";
  if (/^(?:Saved proxy settings are invalid|The configured local (?:proxy|SOCKS5 port)|Authenticated HTTPS proxies are unsupported)/.test(message)) return "proxy";
  if (/^(?:Local proxy startup|Page preloading) settings could not be read\b/.test(message)) return "network";
  return "logs";
}
const BLANK_FORM = {
  name: "", engine: "chromium" as "chromium" | "firefox", chromiumRuntime: "" as FormChromiumRuntime, group: "", platform: "", proxyType: "http", host: "", port: "", user: "", pass: "",
  screen: "", platformOs: "", customNo: "", username: "", password: "", email: "", emailPassword: "", twofa: "",
};

type ProxyCheckUiState = {
  checking: boolean;
  result: ProxyCheckResult | null;
  error: "invalid" | "unavailable" | null;
};
const EMPTY_PROXY_CHECK: ProxyCheckUiState = { checking: false, result: null, error: null };
function proxyFailureMessage(t: (s: string) => string, reason: ProxyCheckResult["reason"]): string {
  if (reason === "authentication_failed") return t("Proxy authentication failed.");
  if (reason === "timeout") return t("Proxy connection timed out.");
  if (reason === "dns_failed") return t("Proxy host could not be resolved.");
  if (reason === "unreachable") return t("Proxy server is unreachable.");
  if (reason === "proxy_bypassed") return t("Traffic did not use this proxy.");
  return t("Proxy connection failed.");
}
function ProxyCheckFeedback({ hasProxy, state }: {
    hasProxy: boolean;
    state: ProxyCheckUiState;
}) {
    const { t } = useTranslation();
    if (!hasProxy)
        return null;
    if (state.error) {
        const invalid = state.error === "invalid";
        return (<>
        <div className={`proxy-check-result ${invalid ? "failed" : "unavailable"}`} role="status">
          <Icon name={invalid ? "alert" : "activity"} className="sm" />
          <span>{invalid
            ? t("Proxy details are invalid. Check them and try again.")
            : t("Proxy check is unavailable. Try again later.")}</span>
        </div>
      </>);
    }
    const result = state.result;
    // A profile that already has a proxy keeps the offer, so it also shows in Edit profile.
    if (!result)
        return null;
    const location = [result.city, result.region, result.country].filter(Boolean).join(", ");
    const exit = [result.ip ? t("Exit IP: {ip}", { ip: result.ip }) : "", location].filter(Boolean).join(" · ");
    const comparison = proxyExitNote(result);
    if (result.status === "working") {
        return (<>
        <div className="proxy-check-result working" role="status">
          <Icon name="check" className="sm" />
          <span><strong>{t("Proxy is working.")}</strong>{exit && <> {exit}.</>}{result.rotating && <> {t("Rotating exit IPs detected.")}</>}{comparison && <> {t(comparison)}</>}</span>
        </div>
      </>);
    }
    if (result.status === "unstable") {
        return (<>
        <div className="proxy-check-result unstable" role="status">
          <Icon name="warning" className="sm" />
          <span><strong>{t("Proxy checks were mixed.")}</strong> {t("{successes} of {attempts} succeeded.", { successes: result.successes, attempts: result.attempts })}{comparison && <> {t(comparison)}</>}</span>
        </div>
      </>);
    }
    if (result.status === "failed") {
        return (<>
        <div className="proxy-check-result failed" role="status">
          <Icon name="alert" className="sm" />
          <span>{proxyFailureMessage(t, result.reason)}</span>
        </div>
      </>);
    }
    return (<>
      <div className="proxy-check-result unavailable" role="status">
        <Icon name="activity" className="sm" />
        <span>{t("Proxy check is unavailable. Try again later.")}</span>
      </div>
    </>);
}
interface ProfileRosterRowHandlers {
    openEdit: (id: string, field?: InspectionEditField, trigger?: HTMLButtonElement) => void;
    openPendingCookies: (profile: UiProfile) => Promise<void>;
    openCookie: (targets: UiProfile[]) => void;
    act: (id: string, fn: (id: string) => Promise<any>) => Promise<void>;
    openInspection: (id: string) => void;
    reuseProfileConfiguration: (id: string, name: string) => Promise<void>;
    openProfileTags: (profile: UiProfile) => void;
    copy2fa: (id: string) => Promise<void>;
    toggleFavorite: (id: string) => Promise<void>;
    changeProfileSelection: (id: string, event: React.ChangeEvent<HTMLInputElement>) => void;
    setLaunchFailure: (id: string, message: string | null) => void;
    openNetworkSettings: () => void;
    openLogs: () => void;
}
interface ProfileRosterRowProps {
    p: UiProfile;
    no: { value: string; custom: boolean };
    isSelected: boolean;
    isBusy: boolean;
    isFavorite: boolean;
    isReuseLoading: boolean;
    twoFaFlashed: boolean;
    startLabel: string;
    launchFailure: string | undefined;
    rosterScope: RosterScope;
    language: string;
    hiddenCols: ReadonlySet<ColumnKey>;
    visibleColumnCount: number;
    viewPreferencesReady: boolean;
    viewPreferenceBusy: boolean;
    rangeKeyboardActivation: React.MutableRefObject<{ id: string; shiftKey: boolean } | null>;
    handlers: ProfileRosterRowHandlers;
    t: (source: string, values?: Record<string, string | number>) => string;
}
const ProfileRosterRow = React.memo(function ProfileRosterRow({
    p,
    no,
    isSelected,
    isBusy,
    isFavorite,
    isReuseLoading,
    twoFaFlashed,
    startLabel,
    launchFailure,
    rosterScope,
    language,
    hiddenCols,
    visibleColumnCount,
    viewPreferencesReady,
    viewPreferenceBusy,
    rangeKeyboardActivation,
    handlers,
    t,
}: ProfileRosterRowProps) {
    const {
        openEdit,
        openPendingCookies,
        openCookie,
        act,
        openInspection,
        reuseProfileConfiguration,
        openProfileTags,
        copy2fa,
        toggleFavorite,
        changeProfileSelection,
        setLaunchFailure,
        openNetworkSettings,
        openLogs,
    } = handlers;
    const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
    const openLabel = (_profile: UiProfile) => startLabel;
    // live through the local cache. Only rows locked by ANOTHER
    // session stay read-only — that writer owns the profile.
    const canEditRow = true;
    const recovery = launchFailure ? launchRecovery(launchFailure) : null;
    const failureId = launchFailure ? `profile-launch-failure-${p.id}` : undefined;
    return (<React.Fragment><tr data-profile-id={p.id} className={`${p.running ? "running" : ""}${isSelected ? " selected" : ""}`}>
      <td className="chk">
        <input type="checkbox" aria-label={t("Select {profile}", { profile: p.name })} aria-describedby="profile-range-selection-hint" title={t("Shift-click to select a range")} checked={isSelected}
          onPointerDown={() => { rangeKeyboardActivation.current = null; }}
          onKeyDown={event => { rangeKeyboardActivation.current = event.key === " " ? { id: p.id, shiftKey: event.shiftKey } : null; }}
          onBlur={() => { rangeKeyboardActivation.current = null; }}
          onChange={event => changeProfileSelection(p.id, event)} />
      </td>
      {columnVisible("no") && (<td className="col-no">
          <span className={`no-text${no.custom ? " custom" : ""}`} title={`${no.custom ? t("Custom NO.") : t("Serial")} ${no.value}`}>{no.value}</span>
        </td>)}
      {columnVisible("name") && (<td className="col-name" title={`${p.name}\n${p.id}`}>
          <span className="name-cell">
            <span className="profile-name-line"><button type="button" className={`profile-favorite${isFavorite ? " is-favorite" : ""}`} aria-pressed={isFavorite} aria-label={t(isFavorite ? "Remove {profile} from favorites" : "Add {profile} to favorites", { profile: p.name })} title={t(isFavorite ? "Remove from favorites" : "Add to favorites")} disabled={!viewPreferencesReady || viewPreferenceBusy} onClick={() => void toggleFavorite(p.id)}><Icon name="star" /></button>
            <button type="button" className="n profile-name-button" disabled={isBusy} aria-label={t("Edit {profile}", { profile: p.name })} onClick={() => openEdit(p.id)}><span className="profile-name-text">{p.name}</span><FingerprintImportBadge p={p} /></button></span>
            <span className="sub">
              <span className="profile-serial" title={p.id}>#{no.value}</span>
              {rosterScope === "recent" && <span>{p.group || t("Ungrouped")}</span>}
              {rosterScope === "recent" && !!p.lastOpenAt && <time dateTime={new Date(p.lastOpenAt).toISOString()} title={new Date(p.lastOpenAt).toLocaleString(language)}>{t("Last launch · {time}", { time: new Date(p.lastOpenAt).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</time>}
              <span title={p.engine === "firefox" ? "Native Firefox profile · no CDP, PDF, or Chrome extensions" : `${browserLabel(p.engine, p.chromiumRuntime)} · CDP, PDF, and Chrome extensions`}>
                {browserLabel(p.engine, p.chromiumRuntime)}
              </span>

            </span>
            {p.tags.length > 0 && <button type="button" className="profile-tags-preview" aria-label={t("Manage tags for {profile}", { profile: p.name })} disabled={isBusy} onClick={() => openProfileTags(p)}>{p.tags.slice(0, 2).map((tag) => <span key={tag} title={tag}>{tag}</span>)}{p.tags.length > 2 && <small>+{p.tags.length - 2}</small>}</button>}
            {(p.restartPending || !!p.pendingCookieCount) && (<span className="status">
                {p.restartPending && (<button
                    type="button"
                    className="status-chip warn tip"
                    data-tip={t("Saved proxy or fingerprint changes apply when this browser restarts. Click to restart it now.")}
                    aria-label={t("Restart {profile} so the saved changes apply", { profile: p.name })}
                    disabled={isBusy}
                    onClick={() => act(p.id, restartProfile)}
                  ><Icon name="refresh" className="sm" />{t("Applies at next start")}</button>)}
                {!!p.pendingCookieCount && (<button
                    type="button"
                    className="status-chip tip"
                    data-tip={t("The browser sets these cookies the next time it starts. Click to see or remove them.")}
                    onClick={() => void openPendingCookies(p)}
                  ><Icon name="cookie" className="sm" />{t("{count} cookie(s) at next start", { count: String(p.pendingCookieCount) })}</button>)}
              </span>)}
          </span>
        </td>)}
      {columnVisible("group") && (<td className="col-group" title={p.group}>
          {p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}
        </td>)}
      {columnVisible("platform") && <td className="col-platform"><PlatformPill platform={p.platform} /></td>}
      {columnVisible("tags") && (<td className="col-tags" title={p.tags?.length ? p.tags.join(", ") : "No tags"}>
          {p.tags?.length ? p.tags.map((tag) => <span key={tag} className="chip">{tag}</span>) : <span className="muted">—</span>}
        </td>)}
      {columnVisible("proxy") && (<td className="col-proxy" title={p.proxyError || p.proxy || "no proxy"}>
          {p.proxyError
            ? <span className="proxy-cell bad"><Icon name="warning" className="sm" />{t("Invalid proxy — edit to fix")}</span>
            : p.proxy
              ? <span className="proxy-cell">{p.proxy}</span>
              : <span className="muted">—</span>}
        </td>)}
      {columnVisible("status") && <td className="col-status"><span className={`profile-status${p.running ? " running" : ""}`}><StatusDot running={p.running} />{p.running ? t("Running") : t("Stopped")}</span></td>}
      {columnVisible("action") && (<td className="col-action"><span className="rowactions">
        {p.running ? <button className="btn sm row-stop" aria-label={t("Stop {profile}", { profile: p.name })} disabled={isBusy} onClick={() => act(p.id, closeProfile)}><Icon name="power" className="sm" />{t("Stop")}</button>
          : p.mobilePersona ? <button className="btn sm warn" disabled={isBusy} title={t("Convert this mobile persona to a desktop device")} onClick={() => openEdit(p.id)}><Icon name="laptop" className="sm" />{t("Convert")}</button>
          : <button className="btn sm primary row-start"
              aria-label={t(recovery === "download" ? "Retry download for {profile}" : recovery ? "Retry starting {profile}" : "Start {profile}", { profile: p.name })}
              aria-describedby={failureId} disabled={isBusy} onClick={() => void act(p.id, openProfile)}><Icon name={recovery ? "refresh" : "play"} className="sm" />{openLabel(p)}</button>}
        <ProfileActionMenu label={t("Actions for {profile}", { profile: p.name })} icon={<Icon name="more" className="sm" />}>
          <button role="menuitem" className="pop-item" onClick={() => openInspection(p.id)}><Icon name="activity" className="sm" />{t("Inspect network & fingerprint")}</button>
          {canEditRow && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => openEdit(p.id)}><Icon name="edit" className="sm" />{t("Edit profile")}</button>}
          {canEditRow && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => openProfileTags(p)}><Icon name="hash" className="sm" />{t("Manage tags")}</button>}
          <button role="menuitem" className="pop-item" disabled={isReuseLoading} onClick={() => void reuseProfileConfiguration(p.id, p.name)}><Icon name="copy" className="sm" />{t("Create from this configuration")}</button>
          {canEditRow && <button role="menuitem" className="pop-item" onClick={() => openCookie([p])}><Icon name="cookie" className="sm" />{t("Add cookies")}</button>}
          {p.has2fa && <button role="menuitem" className="pop-item" onClick={() => copy2fa(p.id)}><Icon name={twoFaFlashed ? "check" : "key"} className="sm" />{twoFaFlashed ? t("Copied") : t("Copy current 2FA code")}</button>}
          {p.running && p.engine === "chromium" && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => act(p.id, raiseProfile)}><Icon name="raise" className="sm" />{t("Bring to front")}</button>}
        </ProfileActionMenu>
      </span></td>)}
    </tr>
    {launchFailure && <tr className="profile-launch-feedback"><td colSpan={visibleColumnCount}>
      <div className="profile-launch-notice">
        <Icon name="warning" className="sm" />
        <div className="profile-launch-detail">
          <p id={failureId} role="alert"><strong>{t(recovery === "download" ? "Browser download failed" : "Browser start failed")}</strong> {t(launchFailure)}</p>
          {recovery === "proxy" && <button type="button" className="btn xs ghost" disabled={isBusy} onClick={event => openEdit(p.id, "proxy", event.currentTarget)}>{t("Review proxy settings")}</button>}
          {recovery === "network" && <button type="button" className="btn xs ghost" onClick={openNetworkSettings}>{t("Network & proxies")}</button>}
          {recovery === "logs" && <button type="button" className="btn xs ghost" onClick={openLogs}>{t("View logs")}</button>}
        </div>
        <button type="button" className="iconbtn profile-launch-dismiss" aria-label={t("Dismiss start failure for {profile}", { profile: p.name })} onClick={event => {
          event.currentTarget.closest("tr")?.previousElementSibling?.querySelector<HTMLButtonElement>(".row-start")?.focus({ preventScroll: true });
          setLaunchFailure(p.id, null);
        }}><Icon name="close" className="sm" /></button>
      </div>
    </td></tr>}
    </React.Fragment>);
});
function App() {
    const motion = useDesktopMotion();
    const { t, language, setLanguage } = useTranslation();
    useEffect(() => {
      if (typeof document !== "undefined") {
        document.documentElement.lang = language;
      }
    }, [language]);
    const { requestConfirm, confirmDialogNode, isConfirmOpen } = useConfirmDialog();
    const windowChrome = useWindowChrome();
    const { currentName: savedWorkspaceName, catalog, error: workspaceCatalogError } = useWorkspaceCatalog();
    const { coordinator: workspaceCoordinator, snapshot: workspaceOperationState } = useWorkspaceOperations();
    const signedUpdateStartup = useSignedUpdateStartup(catalog?.currentId);
    const currentName = savedWorkspaceName || t("Local workspace");
    useEffect(() => { document.title = `${currentName} · 猫步·千境`; }, [currentName]);
    const [profiles, setProfiles] = useState<UiProfile[]>([]);
    const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);
    const [localFolders, setLocalFolders] = useState<FolderInfo[]>([]);
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
    const [folderMenu, setFolderMenu] = useState<string | null>(null);
    const [folderMenuPosition, setFolderMenuPosition] = useState({ left: 0, top: 0 });
    const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
    const [movingFolder, setMovingFolder] = useState<string | null>(null);
    const [folderParent, setFolderParent] = useState("");
    const [folderMoveBusy, setFolderMoveBusy] = useState(false);
    const [folderMoveErr, setFolderMoveErr] = useState<string | null>(null);

    const [appMode, setAppMode] = useState<AppModeConfig | null>(null);
    const [appModeErr, setAppModeErr] = useState<string | null>(null);
    const [authRequired, setAuthRequired] = useState(false);
    const [authTokenInput, setAuthTokenInput] = useState("");
    const [authTokenErr, setAuthTokenErr] = useState<string | null>(null);
    const bulkOwnerActive = useRef(true);
    const {
      loaded,
      connErr,
      connectionAlertDismissed,
      dismissConnectionAlert,
      retryConnection,
      refreshing,
      setRefreshing,
      load,
      readFreshRoster,
      lastRosterResult,
    } = useRosterPolling({
      enabled: !!appMode,
      intervalMs: REFRESH_MS,
      bulkOwnerActiveRef: bulkOwnerActive,
      onRoster: (roster) => {
        setProfiles(roster.profiles);
        setRegisteredGroups(roster.groups);
        setLocalFolders(roster.folders ?? []);
      },
    });
    const effectiveConnErr = appModeErr ?? connErr;

    const [modeErr, setModeErr] = useState<string | null>(null);
    // Management sections share the main content area. Focused profile forms
    // keep their own centred editor while the underlying roster stays mounted.
    const [view, setView] = useState<"profiles" | "inspection" | "scripts" | "settings" | "extensions" | "proxies" | "trash" | "workspaces" | "assistant">("profiles");
    const settingsVisited = useRef(false);
    if (view === "settings") settingsVisited.current = true;
    const currentWorkspaceId = catalog?.currentId ?? null;
    const scriptsVisit = useRef({ workspaceId: currentWorkspaceId, visited: false });
    if (scriptsVisit.current.workspaceId !== currentWorkspaceId) scriptsVisit.current = { workspaceId: currentWorkspaceId, visited: false };
    if (view === "scripts") scriptsVisit.current.visited = true;
    const [trashTaskState, setTrashTaskState] = useState<{ workspaceId: string | null; snapshot: TrashTaskSnapshot } | null>(null);
    const trashTaskSnapshot = trashTaskState?.workspaceId === currentWorkspaceId ? trashTaskState.snapshot : null;
    const [proxyTaskState, setProxyTaskState] = useState<{ workspaceId: string | null; snapshot: ProxyAssignmentSnapshot } | null>(null);
    const proxyTaskSnapshot = proxyTaskState?.workspaceId === currentWorkspaceId ? proxyTaskState.snapshot : null;
    const publishProxyTask = useCallback((snapshot: ProxyAssignmentSnapshot) => setProxyTaskState({ workspaceId: currentWorkspaceId, snapshot }), [currentWorkspaceId]);
    const [proxyTaskFocusRequest, setProxyTaskFocusRequest] = useState<{ workspaceId: string } | null>(null);
    const completeProxyTaskFocus = useCallback(() => {
      setProxyTaskFocusRequest(request => request === proxyTaskFocusRequest ? null : request);
    }, [proxyTaskFocusRequest]);
    useLayoutEffect(() => {
      if (proxyTaskFocusRequest && (view !== "proxies" || proxyTaskFocusRequest.workspaceId !== currentWorkspaceId)) completeProxyTaskFocus();
    }, [view, currentWorkspaceId, proxyTaskFocusRequest, completeProxyTaskFocus]);
    const [localProxyIntent, setLocalProxyIntent] = useState<LocalProxyAssignmentIntent | null>(null);
    const localProxySequence = useRef(0);
    const localProxyTrigger = useRef<HTMLButtonElement | null>(null);
    const returnToLocalProxy = useRef(false);
    const activeLocalProxyIntent = localProxyIntent?.workspaceId === currentWorkspaceId ? localProxyIntent : undefined;
    useLayoutEffect(() => {
      setLocalProxyIntent(previous => previous?.workspaceId === currentWorkspaceId ? previous : null);
      localProxyTrigger.current = null;
      returnToLocalProxy.current = false;
    }, [currentWorkspaceId]);
    const navigationMotion = useNavigationMotion(view, !!appMode, motion.effective === "full");
    const [inspectionId, setInspectionId] = useState<string | null>(null);
    const [workspacePageRequest, setWorkspacePageRequest] = useState<WorkspacePageRequest>({ mode: "manage", id: 0 });
    const [scriptRunOpen, setScriptRunOpen] = useState(false);
    const [scriptRunProfiles, setScriptRunProfiles] = useState<UiProfile[]>([]);
    const [showCreate, setShowCreate] = useState(false);
    const [createReuseSource, setCreateReuseSource] = useState<ReusableProfileSettings | null>(null);
    const [reuseRequest, setReuseRequest] = useState<{ id: string; name: string; status: "loading" | "failed"; error?: string } | null>(null);
    const reuseGeneration = useRef(0);
    const reuseRead = useRef<{ id: string; generation: number; controller: AbortController } | null>(null);
    const reuseCanOpenRef = useRef(false);
    const [createProxyOpen, setCreateProxyOpen] = useState(false);
    const [createProxySource, setCreateProxySource] = useState<LocalProxyDraftCandidate | null>(null);
    const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
    useLayoutEffect(() => {
      if (view !== "settings" || settingsTab !== "network" || !returnToLocalProxy.current) return;
      returnToLocalProxy.current = false;
      const target = localProxyTrigger.current;
      localProxyTrigger.current = null;
      if (target?.isConnected && !target.disabled) target.focus();
      else document.getElementById("settings-tab-network")?.focus();
    }, [view, settingsTab]);
    const startLocalProxyAssignment = (candidate: LocalProxyDraftCandidate, trigger: HTMLButtonElement) => {
      if (!currentWorkspaceId || workspaceCoordinator.getSnapshot().blocked || localProxyTrigger.current) return;
      localProxyTrigger.current = trigger;
      setLocalProxyIntent({ workspaceId: currentWorkspaceId, requestId: ++localProxySequence.current, candidate });
      setView("proxies");
    };
    const dismissLocalProxyAssignment = (requestId: number, options?: { returnToSettings?: boolean }) => {
      if (activeLocalProxyIntent?.requestId !== requestId) return;
      setLocalProxyIntent(null);
      if (options?.returnToSettings) {
        returnToLocalProxy.current = true;
        setSettingsTab("network");
        setView("settings");
      } else localProxyTrigger.current = null;
    };
    const [fingerprintRefreshVersion, setFingerprintRefreshVersion] = useState(0);
    const [assistantDraftSuggestion, setAssistantDraftSuggestion] = useState<AssistantDraftSuggestion | null>(null);
    const assistantDraftSequence = useRef(0);
    const settingsPanelRef = useRef<HTMLDivElement>(null);
    usePanelMotion(settingsTab, view === "settings", settingsPanelRef);
    const updateTabRef = useRef<HTMLButtonElement>(null);
    const focusUpdateTabOnOpen = useRef(false);
    const focusRuntimePanelOnOpen = useRef(false);
    useLayoutEffect(() => { if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0; }, [settingsTab]);
    useLayoutEffect(() => {
      if (view !== "settings" || settingsTab !== "updates" || !focusUpdateTabOnOpen.current) return;
      focusUpdateTabOnOpen.current = false;
      updateTabRef.current?.focus({ preventScroll: true });
    }, [view, settingsTab]);
    useLayoutEffect(() => {
      if (view !== "settings" || settingsTab !== "updates" || !focusRuntimePanelOnOpen.current) return;
      focusRuntimePanelOnOpen.current = false;
      focusRuntimePanel();
    }, [view, settingsTab]);
    function focusRuntimePanel() {
      const target = settingsPanelRef.current?.querySelector<HTMLElement>("[data-browser-runtime-settings-heading]");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: "instant" });
    }
    function viewRuntimeDownloads() {
      if (view === "settings" && settingsTab === "updates") { focusRuntimePanel(); return; }
      focusRuntimePanelOnOpen.current = true;
      setSettingsTab("updates");
      setView("settings");
    }
    function viewSignedUpdate() {
      signedUpdateStartup.dismissNotice();
      if (view === "settings" && settingsTab === "updates") {
        if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0;
        updateTabRef.current?.focus({ preventScroll: true });
      } else {
        focusUpdateTabOnOpen.current = true;
        setSettingsTab("updates");
        setView("settings");
      }
    }
    const [commandOpen, setCommandOpen] = useState(false);
    const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
    const shortcutAction = useRef<(action: WorkbenchShortcutAction) => void>(() => {});
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        const action = getWorkbenchShortcut(event, { ...readWorkbenchShortcutContext(event.target), desktop: !!desktopInvoke(), commandPaletteOpen: commandOpen });
        if (!action) return;
        event.preventDefault(); shortcutAction.current(action);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [commandOpen]);

    const [appVersion, setAppVersion] = useState("");
    const [aboutOpen, setAboutOpen] = useState(false);
    const [githubUpdateAvailable, setGithubUpdateAvailable] = useState(false);
    const aboutTriggerRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { setGithubUpdateAvailable(false); }, [currentWorkspaceId]);
    const hasUpdateNotice = Boolean(signedUpdateStartup.noticeVersion || githubUpdateAvailable);

    const [logDir, setLogDir] = useState<string | undefined>(undefined);
    const [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null);
    const [diskWarningDismissed, setDiskWarningDismissed] = useState(false);
    const [logView, setLogView] = useState<{ file: string; content: string } | null>(null);
    const [logErr, setLogErr] = useState<string | null>(null);
    const [diag, setDiag] = useState<DiagnoseReport | null>(null);
    const [showDiag, setShowDiag] = useState(false);
    const [q, setQ] = useState("");
    const [profileStatus, setProfileStatus] = useState<"all" | "running" | "stopped">("all");
    const [group, setGroup] = useState("all");
    const [profilePage, setProfilePage] = useState(0);
    const [pageSize, setPageSize] = useState(readPageSize);
    const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "no", dir: 1 });
    const [hiddenCols, setHiddenCols] = useState<Set<ColumnKey>>(readHiddenColumns);
    const [rosterScope, setRosterScope] = useState<RosterScope>("all");
    const [favoriteProfiles, setFavoriteProfiles] = useState<string[]>(readFavorites);
    const [savedProfileViews, setSavedProfileViews] = useState<SavedProfileView[]>(readSavedViews);
    const [rosterDensity, setRosterDensity] = useState<RosterDensity>(readRosterDensity);
    const [viewPreferencesWorkspaceId, setViewPreferencesWorkspaceId] = useState<string | null>(null);
    const viewPreferencesReady = currentWorkspaceId !== null && viewPreferencesWorkspaceId === currentWorkspaceId;
    const [viewPreferencesLoading, setViewPreferencesLoading] = useState(true);
    const [viewPreferenceReadError, setViewPreferenceReadError] = useState<string | null>(null);
    const [viewPreferenceBusy, setViewPreferenceBusy] = useState(false);
    const [preferenceLoadAttempt, setPreferenceLoadAttempt] = useState(0);
    const viewPreferenceWrite = useRef(false);
    const favoriteProfileIds = useMemo(() => new Set(favoriteProfiles), [favoriteProfiles]);
    const paletteSavedViews = useMemo(() => viewPreferencesReady ? savedProfileViews.map(({ id, name, filters }) => ({ id, name, group: filters.group, scope: filters.scope, status: filters.status })) : [], [savedProfileViews, viewPreferencesReady]);
    const [colsOpen, setColsOpen] = useState(false);
    const [groupDisclosure, setGroupDisclosure] = useState(() => readGroupDisclosure(null));
    const [groupManagerOpen, setGroupManagerOpen] = useState(false);
    const [bulkToolsOpen, setBulkToolsOpen] = useState(false);

    const [groupsOpen, setGroupsOpen] = useState(true);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
    const sidebarChoice = useRef<{ workspaceId: string | null } | null>(null);
    const [railForced, setRailForced] = useState(readRailForced);
    const sidebarIsCompact = sidebarCollapsed || railForced;
    const [tableScrolled, setTableScrolled] = useState(false);
    const [theme, setTheme] = useState<ThemeChoice>(readTheme);
    const [manualBusy, setBusy] = useState<Record<string, boolean>>({});
    const profileMove = useProfileMove({ readRoster: () => readFreshRoster() });
    const moveUiInFlight = useRef(false), moveDraftRevision = useRef(0);
    const [bulkTask, setBulkTask] = useState<BulkProfileTask | null>(null);
    const bulkTaskRef = useRef<BulkProfileTask | null>(null), bulkBatchBusy = useRef(false);
    const bulkTaskLease = useRef<WorkspaceOperationLease | null>(null), bulkTaskWorkspace = useRef<string | null>(null);
    const [bulkTaskExpanded, setBulkTaskExpanded] = useState(false), [bulkTaskRefreshing, setBulkTaskRefreshing] = useState(false);
    const bulkTaskSnapshot = useSyncExternalStore(bulkTask?.subscribe ?? noBulkSubscription, bulkTask?.getSnapshot ?? emptyBulkSnapshot, emptyBulkSnapshot);
    const bulkTaskActive = !!bulkTaskSnapshot && bulkTaskSnapshot.phase !== "complete";
    const scriptBackground = useBackgroundScriptRun();
    const cookieImportLease = useRef<WorkspaceOperationLease | null>(null);
    const cookieImport = useCookieImportTask({
      workspaceId: () => catalog?.currentId ?? null,
      acquire: workspaceId => {
        const lease = workspaceCoordinator.acquire("profile-cookies", workspaceId);
        if (!lease) return null;
        cookieImportLease.current = lease;
        return { refreshing: () => workspaceCoordinator.setPhase(lease, "refreshing"), release: () => {
          workspaceCoordinator.release(lease); if (cookieImportLease.current === lease) cookieImportLease.current = null;
        } };
      },
      onSettled: async () => {
        if (!bulkOwnerActive.current) return;
        const lease = cookieImportLease.current;
        const results = await Promise.allSettled([readFreshRoster(), lease ? workspaceCoordinator.refreshWorkspaceViews(lease) : Promise.resolve()]);
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
    });
    const cookieImportBusy = cookieImport.snapshot.phase === "sending" || cookieImport.snapshot.phase === "refreshing";
    const fileUpdateLease = useRef<WorkspaceOperationLease | null>(null);
    const fileUpdatePanelRef = useRef<HTMLDivElement>(null);
    const fileUpdate = useProfileFileUpdate({
      workspaceId: () => catalog?.currentId ?? null,
      acquire: workspaceId => {
        const lease = workspaceCoordinator.acquire("profile-file-update", workspaceId);
        if (!lease) return null;
        fileUpdateLease.current = lease;
        return { refreshing: () => workspaceCoordinator.setPhase(lease, "refreshing"), release: () => {
          workspaceCoordinator.release(lease); if (fileUpdateLease.current === lease) fileUpdateLease.current = null;
        } };
      },
      onSettled: async () => {
        if (!bulkOwnerActive.current) return;
        const lease = fileUpdateLease.current;
        const results = await Promise.allSettled([readFreshRoster(), lease ? workspaceCoordinator.refreshWorkspaceViews(lease) : Promise.resolve()]);
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
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
    const [runtimeDownloads, setRuntimeDownloads] = useState<RuntimeDownload[]>([]);
    const [runtimeDownloadsStale, setRuntimeDownloadsStale] = useState(false);
    const runtimeTransfersObserved = useRef(false);
    // Roster refreshes report connectivity separately from operation failures.
    const [actionErr, setActionErr] = useState<string | null>(null);
    const [launchFailureState, setLaunchFailureState] = useState<{ workspaceId: string | null; byId: ReadonlyMap<string, string> }>(() => ({ workspaceId: currentWorkspaceId, byId: new Map() }));
    const launchFailures = launchFailureState.workspaceId === currentWorkspaceId ? launchFailureState.byId : null;
    const manualActions = useRef(new Set<string>());
    useEffect(() => {
      setLaunchFailureState(previous => {
        if (previous.workspaceId !== currentWorkspaceId) return { workspaceId: currentWorkspaceId, byId: new Map() };
        if (!previous.byId.size) return previous;
        const stopped = new Set(profiles.filter(profile => !profile.running).map(profile => profile.id));
        const byId = new Map([...previous.byId].filter(([id]) => stopped.has(id)));
        return byId.size === previous.byId.size ? previous : { ...previous, byId };
      });
    }, [currentWorkspaceId, profiles]);
    useEffect(() => {
      if (!currentWorkspaceId) return;
      let alive = true;
      const revision = preferenceRevision;
      const ownsWorkspace = () => alive && workspaceCoordinator.getSnapshot().workspaceId === currentWorkspaceId;
      if (sidebarChoice.current?.workspaceId === null) sidebarChoice.current.workspaceId = currentWorkspaceId;
      setViewPreferencesWorkspaceId(null);
      setViewPreferencesLoading(true); setViewPreferenceReadError(null);
      void fetchWorkspacePreferences().then((preferences) => {
        if (!ownsWorkspace()) return;
        // Roster metadata cannot be edited until it has loaded. Restore it even
        // when a separate sidebar/layout action changed the general revision.
        const favorites = parseFavoriteProfiles(preferences[FAVORITE_PROFILES_KEY] ?? "[]") ?? [];
        const views = parseSavedProfileViews(preferences[SAVED_PROFILE_VIEWS_KEY] ?? "[]") ?? [];
        const density = parseRosterDensity(preferences[ROSTER_DENSITY_KEY]);
        setRosterDensity(density);
        setFavoriteProfiles(favorites); setSavedProfileViews(views); setViewPreferencesWorkspaceId(currentWorkspaceId);
        for (const [key, value] of [[FAVORITE_PROFILES_KEY, JSON.stringify(favorites)], [SAVED_PROFILE_VIEWS_KEY, JSON.stringify(views)], [ROSTER_DENSITY_KEY, density]]) try { localStorage.setItem(key!, value!); } catch { }
        if (preferenceRevision !== revision) return;
        // The rail is already interactive while the first catalog request is pending.
        const preserveSidebarChoice = sidebarChoice.current?.workspaceId === currentWorkspaceId;
        for (const [key, value] of Object.entries(preferences)) {
          if (key === SIDEBAR_KEY && preserveSidebarChoice) continue;
          try { localStorage.setItem(key, value); } catch { }
        }
        if (preferences[HIDDEN_COLUMNS_KEY] !== undefined) {
          try {
            const keys: unknown = JSON.parse(preferences[HIDDEN_COLUMNS_KEY]!);
            const known = new Set(COLUMNS.map((column) => column.key as string));
            if (Array.isArray(keys)) setHiddenCols(new Set(keys.filter((key) => known.has(key)) as ColumnKey[]));
          } catch { /* A damaged column preference must not strand valid saved views. */ }
        }
        if (preferences[PAGE_SIZE_KEY] !== undefined && PAGE_SIZES.includes(Number(preferences[PAGE_SIZE_KEY]))) setPageSize(Number(preferences[PAGE_SIZE_KEY]));
        if (!preserveSidebarChoice && preferences[SIDEBAR_KEY] !== undefined) setSidebarCollapsed(preferences[SIDEBAR_KEY] === "1");
        setGroupDisclosure(readGroupDisclosure(preferences[GROUP_DISCLOSURE_KEY]));
      }).catch((error) => { if (ownsWorkspace()) setViewPreferenceReadError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (ownsWorkspace()) setViewPreferencesLoading(false); });
      return () => { alive = false; };
    }, [currentWorkspaceId, preferenceLoadAttempt, workspaceCoordinator]);
    useEffect(() => {
      const failed = (event: Event) => setActionErr(String((event as CustomEvent).detail));
      window.addEventListener("workspace-preference-error", failed);
      window.addEventListener("external-link-error", failed);
      return () => { window.removeEventListener("workspace-preference-error", failed); window.removeEventListener("external-link-error", failed); };
    }, []);
    const writeViewPreference = async (key: string, value: string): Promise<boolean> => {
      if (!viewPreferencesReady || viewPreferenceWrite.current || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return false;
      viewPreferenceWrite.current = true; setViewPreferenceBusy(true); setActionErr(null); preferenceRevision++;
      try {
        await saveWorkspacePreference(key, value);
        if (workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return false;
        try { localStorage.setItem(key, value); } catch { /* Server storage remains authoritative. */ }
        return true;
      } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); return false; }
      finally { viewPreferenceWrite.current = false; setViewPreferenceBusy(false); }
    };
    const toggleFavorite = async (id: string) => {
      try {
        const next = favoriteProfiles.includes(id) ? favoriteProfiles.filter(value => value !== id) : [...favoriteProfiles, id];
        if (await writeViewPreference(FAVORITE_PROFILES_KEY, serializeFavoriteProfiles(next))) setFavoriteProfiles(next);
      } catch (error) { setActionErr(error instanceof Error ? error.message : String(error)); }
    };
    const chooseRosterDensity = async (density: RosterDensity) => { if (density !== rosterDensity && await writeViewPreference(ROSTER_DENSITY_KEY, density)) setRosterDensity(density); };
    const saveProfileView = async (view: SavedProfileView): Promise<boolean> => {
      const next = [...savedProfileViews, view];
      const value = serializeSavedProfileViews(next);
      if (!await writeViewPreference(SAVED_PROFILE_VIEWS_KEY, value)) return false;
      setSavedProfileViews(next); return true;
    };
    const removeProfileView = async (id: string): Promise<boolean> => {
      const next = savedProfileViews.filter(view => view.id !== id);
      if (!await writeViewPreference(SAVED_PROFILE_VIEWS_KEY, serializeSavedProfileViews(next))) return false;
      setSavedProfileViews(next); return true;
    };
    const chooseRosterScope = (scope: RosterScope) => {
      setRosterScope(scope); setQ(""); setGroup("all"); setProfileStatus("all"); setProfilePage(0);
    };
    const applyProfileView = (saved: SavedProfileView) => {
      const filters = saved.filters;
      setRosterScope(filters.scope); setQ(filters.query); setGroup(filters.group); setProfileStatus(filters.status);
      setSort(filters.sort); setHiddenCols(new Set(filters.hiddenColumns)); setPageSize(filters.pageSize); setProfilePage(0);
      writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify(filters.hiddenColumns)); writeSetting(PAGE_SIZE_KEY, String(filters.pageSize));
    };
    const [notice, setNotice] = useState<string | null>(null); // transient success banner
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearNoticeTimer = () => { if (noticeTimer.current !== null) clearTimeout(noticeTimer.current); noticeTimer.current = null; };
    useEffect(() => () => clearNoticeTimer(), []);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const latestSelection = useRef(selected); latestSelection.current = selected;
    const rangeSelectionAnchor = useRef<ProfileSelectionAnchor | null>(null);
    const rangeKeyboardActivation = useRef<{ id: string; shiftKey: boolean } | null>(null);
    const [deleting, setDeleting] = useState(false);
    const deleteInFlight = useRef(false);
    const editTotpSecsRef = useRef<number | null>(null);
    // Active profile export: null when idle, otherwise how far the server-side
    // collection has progressed ({completed: total} = file being built).
    const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
    const [moveTarget, setMoveTarget] = useState<string | null>(null);
    const [newMode, setNewMode] = useState(false);
    const [newGroup, setNewGroup] = useState("");
    const [dragging, setDragging] = useState(false);
    const [creating, setCreating] = useState(false);
    const createInFlight = useRef(false);
    const [createErr, setCreateErr] = useState<string | null>(null);
    const [form, setForm] = useState(BLANK_FORM);
    const initialCreateForm = useRef<typeof BLANK_FORM>(BLANK_FORM);
    const createRuntimeInput = profileCreationRuntime(form.engine, form.chromiumRuntime, appMode?.chromiumRuntime);
    const createRuntimeLabel = createRuntimeInput ?? appMode?.defaultChromiumRuntime;
    const createFingerprintRuntime = createRuntimeLabel === "cloakbrowser" ? "" : createRuntimeLabel;
    const [createProxyCheck, setCreateProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
    const createProxyCheckGeneration = useRef(0);
    const [cookieTargets, setCookieTargets] = useState<UiProfile[] | null>(null);
    const lastCookieTargets = useRef<UiProfile[]>([]);
    if (cookieTargets) lastCookieTargets.current = cookieTargets;
    const cookieTaskPanelRef = useRef<HTMLDivElement>(null);
    const moveTaskPanelRef = useRef<HTMLDivElement>(null);
    const [pendingView, setPendingView] = useState<{ profile: UiProfile; cookies: Array<{ domain: string; name: string }> | null; error: string | null; busy: boolean } | null>(null);
    const [proxyPaste, setProxyPaste] = useState("");
    const [proxyPasteOk, setProxyPasteOk] = useState<string | null>(null);
    const [proxyPasteInvalid, setProxyPasteInvalid] = useState(false);
    // Edit modal + bulk export/update + group rename
    const [editId, setEditId] = useState<string | null>(null);
    const [tagsTarget, setTagsTarget] = useState<ProfileTagsTarget | null>(null);
    const tagsReturnFocus = useRef<HTMLElement | null>(null);

    const [editForm, setEditForm] = useState<Record<string, string>>({});
    const [editSnapshot, setEditSnapshot] = useState<ProfileEditSnapshot | null>(null);
    const [editClearQuarantinedProxy, setEditClearQuarantinedProxy] = useState(false);
    const [editInitialFingerprint, setEditInitialFingerprint] = useState<Record<string, string>>({});
    const [editInitialProxy, setEditInitialProxy] = useState({ proxy: "", proxyType: "http" });

    const [editProxyCheck, setEditProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
    const editProxyCheckGeneration = useRef(0);
    const [editErr, setEditErr] = useState<string | null>(null);
    const [editSaving, setEditSaving] = useState(false);
    const [editLoading, setEditLoading] = useState(false);
    const editSessionSequence = useRef(0);
    const editSessionRef = useRef<{ id: string; generation: number; loading: boolean; ready: boolean } | null>(null);
    const editSaveInFlight = useRef(false);
    const [editLoadedGeneration, setEditLoadedGeneration] = useState<number | null>(null);
    const editReady = editLoadedGeneration !== null && editSessionRef.current?.generation === editLoadedGeneration && editSessionRef.current.ready;
    useEffect(() => () => { editSessionRef.current = null; editSaveInFlight.current = false; }, []);
    const createReturnFocus = useRef<HTMLElement | null>(null);
    const createEditorRef = useProfileEditorFocus(showCreate, true, createReturnFocus);
    const editReturnFocus = useRef<HTMLElement | null>(null);
    const editFieldOnOpen = useRef<InspectionEditField | null>(null);
    const editEditorRef = useProfileEditorFocus(!!editId, editReady, editReturnFocus, editFieldOnOpen);
    const createCloseGuard = useUnsavedChangesGuard({ label: "New Profile", returnFocus: () => createEditorRef.current });
    const editCloseGuard = useUnsavedChangesGuard({ label: "Edit profile", returnFocus: () => editEditorRef.current });

    // Null until the profile detail loads, so a failed load never names a browser.
    const [editEngine, setEditEngine] = useState<"chromium" | "firefox" | null>(null);
    const [editChromiumRuntime, setEditChromiumRuntime] = useState("");
    const [editHardware, setEditHardware] = useState<{ gpu?: string; cores?: number } | undefined>();
    const [timezoneBusy, setTimezoneBusy] = useState(false);
    const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
    const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
    const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null);
    const [editExts, setEditExts] = useState<string[]>([]);
    const [editInitialExts, setEditInitialExts] = useState<string[]>([]);
    const editReview = useMemo<{ summary: ProfileEditSummary | null; error: string | null; field: string | null }>(() => {
      if (!editReady || !editSnapshot) return { summary: null, error: null, field: null };
      try { return { summary: buildProfileEditPatch(editSnapshot, { form: editForm, extensions: editExts, clearQuarantinedProxy: editClearQuarantinedProxy }).summary, error: null, field: null }; }
      catch (error) { return { summary: null, error: error instanceof ProfileEditPatchError ? error.message : "Edited fields could not be validated. Reload this editor before saving.", field: error instanceof ProfileEditPatchError ? error.field : null }; }
    }, [editReady, editSnapshot, editForm, editExts, editClearQuarantinedProxy]);
    const editFieldFeedback = (field: string): EditorFieldFeedback => ({ field, invalid: editReview.field === field, describedBy: "profile-edit-validation-error" });
    const editorScroll: ScrollBehavior = motion.effective === "full" ? "smooth" : "instant";
    const locateEditProblem = () => {
      const editor = editEditorRef.current;
      if (!editor) return;
      const invalidField = editor.querySelector<HTMLElement>('[data-profile-field][aria-invalid="true"]');
      focusEditorTarget(invalidField ?? editor.querySelector<HTMLElement>("#profile-edit-validation-error, .profile-edit-save-error"), editorScroll);
    };

    // Local extension registry + Extensions page
    const [extensions, setExtensions] = useState<Extension[]>([]);
    const extensionWorkspaceId = catalog?.currentId ?? null;
    const extensionWorkspace = useRef(extensionWorkspaceId); extensionWorkspace.current = extensionWorkspaceId;
    const [extensionDrafts] = useState(() => createExtensionDefaultDrafts(extensionWorkspaceId));
    const extensionDraftState = useSyncExternalStore(extensionDrafts.subscribe, extensionDrafts.getSnapshot, extensionDrafts.getSnapshot);
    const groupExtensionDefaults = useMemo<GroupExtensionDefaults[]>(() => extensionDraftState.groups.map(group => ({ name: group.name, extensions: [...group.extensions] })), [extensionDraftState.groups]);
    const groupDefaultName = extensionDraftState.selectedGroup ?? "";
    const groupDefaultExts = useMemo(() => [...(extensionDraftState.selected?.extensions ?? [])], [extensionDraftState.selected?.extensions]);
    const [extDataFresh, setExtDataFresh] = useState(false);
    const extensionFresh = useRef(false);
    const markExtensionFresh = (fresh: boolean) => { extensionFresh.current = fresh; setExtDataFresh(fresh); };
    const [groupDefaultBusy, setGroupDefaultBusy] = useState(false);
    const [extSource, setExtSource] = useState("");
    const [extInstallBusy, setExtInstallBusy] = useState(false);
    const [extBusy, setExtBusy] = useState(false);
    const [extErr, setExtErr] = useState<string | null>(null);
    const [extLoading, setExtLoading] = useState(false);
    const [extensionPageRefresh, setExtensionPageRefresh] = useState(0);
    const extensionReadVersion = useRef(0);
    const extensionMutation = useRef(false);
    useLayoutEffect(() => {
      extensionReadVersion.current++;
      markExtensionFresh(false); extensionDrafts.setWorkspace(extensionWorkspaceId); setExtensions([]); setExtSource("");
    }, [extensionWorkspaceId]);
    const [bulkExt, setBulkExt] = useState(""); // extension chosen for bulk assign
    // Update-from-file modal (export → edit → re-upload, matched by id)
    const [showUpdate, setShowUpdate] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameVal, setRenameVal] = useState("");
    const [addingGroup, setAddingGroup] = useState(false);
    const [sidebarGroupName, setSidebarGroupName] = useState("");
    // Bulk add accounts from provider files or pasted AdsPower text.
    const [showBulk, setShowBulk] = useState(false);
    const [bulkFiles, setBulkFiles] = useState<File[]>([]);
    const [bulkText, setBulkText] = useState("");
    const [bulkGroup, setBulkGroup] = useState("");
    const [bulkPlatform, setBulkPlatform] = useState("");
    const [bulkBusy, setBulkBusy] = useState(false);
    const importInFlight = useRef(false);
    const [importBusy, setImportBusy] = useState(false);
    const [importReceipt, setImportReceipt] = useState<ImportReceipt | null>(null);
    const [importReceiptExpanded, setImportReceiptExpanded] = useState(false);
    const [importReceiptRefreshing, setImportReceiptRefreshing] = useState(false);
    const [bulkErr, setBulkErr] = useState<string | null>(null);
    const [bulkOver, setBulkOver] = useState(false);
    // One source at a time: two full-height inputs stacked made it ambiguous which
    // one the Import button would actually read.
    const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
    const bulkEditorRef = useProfileEditorFocus(showBulk, false);

    const bulkFileRef = useRef<HTMLInputElement>(null);
    const reuseCanOpen = view === "profiles" && !showCreate && !editId && !showBulk && !showUpdate && !cookieTargets && !pendingView
      && !movingFolder && !logView && !logErr && !scriptRunOpen && !commandOpen && !shortcutHelpOpen && !tagsTarget && !showDiag;
    reuseCanOpenRef.current = reuseCanOpen;
    useLayoutEffect(() => { if (!reuseCanOpen) cancelReuseRead(); }, [reuseCanOpen]);
    useEffect(() => () => { reuseGeneration.current++; reuseRead.current?.controller.abort(); reuseRead.current = null; }, []);
    // The app resolves "system" itself and stamps the result on <html>, so the
    // stylesheet carries exactly one dark palette instead of a duplicated media query.
    useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    // Only follow the OS while the operator has actually asked us to.
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
    useEffect(() => {
    const media = window.matchMedia(RAIL_MEDIA);
    const apply = () => setRailForced(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
    // Escape closes whatever dialog is open, topmost first — standard desktop
    // behavior the mouse-only close buttons don't cover.
    const escapeHandlerRef = useRef<() => void>(() => {});
    escapeHandlerRef.current = () => {
      if (isConfirmOpen) return;
      if (movingFolder) { if (!folderMoveBusy) setMovingFolder(null); return; }
      if (logView || logErr) { setLogView(null); setLogErr(null); return; }
      if (showUpdate) { setShowUpdate(false); return; }
      if (showBulk) { closeBulk(); return; }
      if (pendingView) { if (!pendingView.busy) setPendingView(null); return; }
      if (cookieTargets) { closeCookie(); return; }
      if (editId) { closeEdit(); return; }
      if (showCreate) closeCreate();
    };
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
            escapeHandlerRef.current();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
    const refreshImportedProfiles = async () => { await readFreshRoster(); };
    const openSettings = () => setView("settings");
    const openExtensions = () => { setExtErr(null); setExtLoading(true); if (view === "extensions") setExtensionPageRefresh(value => value + 1); else setView("extensions"); };
    const openInspection = (id: string) => {
      if (editSessionRef.current) return;
      setInspectionId(id);
      setView("inspection");
    };
    const backFromInspection = () => {
      setView("profiles");
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find(item => item.dataset.profileId === inspectionId);
        const target = row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? document.getElementById("profiles-page-title");
        target?.focus({ preventScroll: true });
      });
    };
    const openWorkspaceManagement = (intent: WorkspacePageIntent) => {
      setWorkspacePageRequest((current) => ({ ...intent, id: current.id + 1 }));
      setView("workspaces");
    };
    const showRunningProfiles = () => {
      setRosterScope("all");
      setQ("");
      setGroup("all");
      setSelected(new Set());
      setProfilePage(0);
      setProfileStatus("running");
      setView("profiles");
    };
    const loadAppMode = useCallback(() => {
        fetchAppMode().then((config) => {
            setAuthRequired(false);
            setAuthTokenErr(null);
            setAppModeErr(null);
            setAppMode({ ...config, mode: "local", localAnalytics: false });
        }).catch((error) => {
            if (isUnauthorizedError(error)) setAuthRequired(true);
            setAppModeErr(error instanceof Error ? error.message : String(error));
        });
    }, []);
    useEffect(() => {
        loadAppMode();
    }, [loadAppMode]);
    useEffect(() => subscribeUnauthorized(() => {
        setAuthRequired(true);
    }), []);
    useEffect(() => {
        const invoke = desktopInvoke();
        if (!appMode || !invoke)
            return;
        void invoke("agent_runtime_ready", { readiness: "local" }).catch(() => undefined);
    }, [appMode]);
    useEffect(() => {
    if (!appMode) return;
    load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch((error) => console.warn("[health]", error));
    fetchDiagnose().then(setDiag).catch((error) => console.warn("[diagnose]", error));
  }, [appMode]);
    useEffect(() => {
      if (!appMode || !extensionWorkspaceId) return;
      const generation = ++extensionReadVersion.current;
      void fetchExtensions().then(items => { if (generation === extensionReadVersion.current && extensionWorkspace.current === extensionWorkspaceId) setExtensions(items); }).catch((error) => console.warn("[extensions]", error));
    }, [appMode, extensionWorkspaceId]);
    useEffect(() => {
    if (view !== "extensions" || !appMode || !extensionWorkspaceId) return;
    let alive = true;
    const generation = ++extensionReadVersion.current;
    setExtLoading(true); markExtensionFresh(false);
    void Promise.allSettled([fetchExtensions(), fetchGroupExtensionDefaults(), readFreshRoster()]).then(results => {
      if (!alive || generation !== extensionReadVersion.current || extensionWorkspace.current !== extensionWorkspaceId) return;
      if (results[0].status === "fulfilled") setExtensions(results[0].value);
      if (results[1].status === "fulfilled") extensionDrafts.receive(extensionWorkspaceId, results[1].value);
      const failed = results.find(result => result.status === "rejected");
      markExtensionFresh(!failed);
      setExtErr(failed ? t("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes.") : null);
    }).finally(() => { if (alive && generation === extensionReadVersion.current) setExtLoading(false); });
    return () => { alive = false; if (generation === extensionReadVersion.current) extensionReadVersion.current++; setExtLoading(false); };
  }, [view, appMode, extensionPageRefresh, extensionWorkspaceId]);
    // Both browsers delete saved site data when the profiles drive is almost full.
    useEffect(() => {
        let live = true;
        let lastCheckedAt = 0;
        const runCheck = () => {
          lastCheckedAt = Date.now();
          void fetchDiskSpace().then((next) => { if (live) setDiskSpace(next); }).catch((error) => console.warn("[disk-space]", error));
        };
        const check = () => {
          if (typeof document !== "undefined" && document.hidden) return;
          runCheck();
        };
        const onVisibility = () => {
          if (typeof document !== "undefined" && !document.hidden && Date.now() - lastCheckedAt >= 60_000) {
            runCheck();
          }
        };
        check();
        const timer = setInterval(check, 60_000);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
        return () => {
          live = false;
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        };
    }, []);
    // Browser runtime downloads: read once when the profile count changes (a new profile
    // starts its download), then every second while one runs or a row is busy opening.
    const anyBusy = Object.values(busy).some(Boolean);
    useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let failures = 0;
    const poll = () => {
      void fetchRuntimeDownloads().then((next) => {
        if (!live) return;
        failures = 0;
        runtimeTransfersObserved.current = next.length > 0;
        setRuntimeDownloads(next);
        setRuntimeDownloadsStale(false);
        if (next.length > 0 || anyBusy) timer = window.setTimeout(poll, 1000);
      }).catch(() => {
        if (!live) return;
        setRuntimeDownloadsStale(true);
        failures++;
        if (anyBusy || runtimeTransfersObserved.current || failures === 1) {
          timer = window.setTimeout(poll, 1000 * 2 ** Math.min(3, failures - 1));
        }
      });
    };
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [anyBusy, profiles.length]);
    // Live 2FA code in the Edit modal: fetch the current TOTP, count it down
    // locally, and refetch when the window rolls over.
    useEffect(() => {
        const session = editSessionRef.current;
        if (!editId || !editReady || !session?.ready) { editTotpSecsRef.current = null; setEditTotp(null); return; }
        let alive = true;
        const tick = async () => {
      try {
        const r = await fetchTotp(editId);
        if (alive && editSessionRef.current === session) {
          if (r.code) {
            const secs = r.secondsRemaining ?? 30;
            editTotpSecsRef.current = secs;
            setEditTotp({ code: r.code, secs });
          } else {
            editTotpSecsRef.current = null;
            setEditTotp(null);
          }
        }
      } catch { if (alive && editSessionRef.current === session) { editTotpSecsRef.current = null; setEditTotp(null); } }
    };
        void tick();
        const timer = setInterval(() => {
      if (!alive || editSessionRef.current !== session) return;
      const secs = editTotpSecsRef.current;
      if (secs === null) return;
      if (secs <= 1) {
        editTotpSecsRef.current = null;
        void tick();
        return;
      }
      const nextSecs = secs - 1;
      editTotpSecsRef.current = nextSecs;
      setEditTotp((prev) => (prev ? { ...prev, secs: nextSecs } : prev));
    }, 1000);
        return () => { alive = false; editTotpSecsRef.current = null; clearInterval(timer); };
    }, [editId, editLoadedGeneration]);
    const folders = useMemo<FolderInfo[]>(() => {
        const metadata = new Map(localFolders.map((folder) => [folder.name, folder]));
        return [...new Set([...registeredGroups, ...profiles.map((profile) => profile.group).filter(Boolean)])]
      .map((name) => metadata.get(name) ?? { name });
    }, [localFolders, registeredGroups, profiles]);
    const tree = useMemo(() => folderTree(folders), [folders]);
    const folderLabels = useMemo(() => new Map(folders.map(folder => [folder.name, folder.label ?? folder.name])), [folders]);
    const groups = useMemo(() => ["all", ...tree.map((folder) => folder.name)], [tree]);
    const missingRosterGroup = loaded && group !== "all" && group !== "" && !groups.includes(group) ? group : null;
    const hasRosterRefinements = !!q.trim() || group !== "all" || profileStatus !== "all";
    const clearRosterRefinements = () => { setQ(""); setGroup("all"); setProfileStatus("all"); setProfilePage(0); };
    const selectedScope = useMemo(() => group === "" ? new Set([""]) : folderScope(folders, group), [folders, group]);

    const breadcrumb = tree.find((folder) => folder.name === group);
    const selectFolder = (name: string) => { setGroup(name); setView("profiles"); };
    const folderLabel = (name: string) => folderLabels.get(name) ?? name;
    /**
     * Every profile's visible "No.", resolved once against the unsorted roster so
     * sorting or paging can never renumber a row underneath the operator.
     */
    const numbering = useMemo(() => {
    const map = new Map<string, { value: string; custom: boolean }>();
    profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));
    return map;
  }, [profiles]);
    const sortField = (p: UiProfile, key: SortKey): string | number => {
    switch (key) {
      case "no": return Number(numbering.get(p.id)?.value ?? 0);
      case "name": return p.name.toLowerCase();
      case "group": return p.group.toLowerCase();
      case "platform": return p.platform.toLowerCase();
      case "proxy": return (p.proxy ?? "").toLowerCase();
      case "status": return p.running ? 0 : 1;
      default: return 0;
    }
  };
    const matchingProfiles = useMemo(() => {
        return profiles.filter((p) => {
            if (!inProfileScope(p, rosterScope, favoriteProfileIds)) return false;
            if (group !== "all" && !selectedScope.has(p.group))
                return false;
            if (q.trim()) {
        const exactId = /^id:(\S+)$/.exec(q.trim());
        if (exactId) return p.id === exactId[1];
        const needle = q.trim().toLowerCase();
        const no = numbering.get(p.id)?.value ?? "";
        if (
          !p.id.toLowerCase().includes(needle) &&
          !p.name.toLowerCase().includes(needle) &&
          !no.includes(needle) &&
          !(p.proxy ?? "").toLowerCase().includes(needle) &&
          !p.group.toLowerCase().includes(needle) &&
          !(p.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
        ) return false;
      }
            return true;
        });
    }, [profiles, group, selectedScope, q, numbering, rosterScope, favoriteProfileIds]);
    const matchingRunningCount = matchingProfiles.filter((profile) => profile.running).length;
    const filtered = useMemo(() => {
        const matched = matchingProfiles.filter((profile) => profileStatus === "all" || (profileStatus === "running" ? profile.running : !profile.running));
        // Running profiles stay on top regardless of the chosen column: an open
        // browser is the row an operator acts on next.
        return matched.sort((a, b) => {
      if (rosterScope === "recent" && a.lastOpenAt !== b.lastOpenAt) return (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0);
      if (a.running !== b.running) return a.running ? -1 : 1;
      const left = sortField(a, sort.key);
      const right = sortField(b, sort.key);
      if (left < right) return -sort.dir;
      if (left > right) return sort.dir;
      return a.id.localeCompare(b.id);
    });
    }, [matchingProfiles, profileStatus, sort, numbering, rosterScope]);
    const profilePageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const visibleProfilePage = Math.min(profilePage, profilePageCount - 1);
    const visibleProfiles = filtered.slice(visibleProfilePage * pageSize, (visibleProfilePage + 1) * pageSize);
    const previousProfileFilters = useRef({ q, group, pageSize, profileStatus });
    const revealGroupMatches = !!q.trim() || profileStatus !== "all" || group !== "all" || rosterScope !== "all";
    const profileSections = useMemo(() => rosterScope === "recent" ? [{ name: "", orderIndex: 0, profiles: visibleProfiles, matches: filtered, running: filtered.filter(profile => profile.running).length }] : profileGroupSections(
      visibleProfiles,
      filtered,
      tree.filter(folder => group === "all" || selectedScope.has(folder.name)).map(folder => folder.name),
      visibleProfilePage === 0 && !q.trim() && profileStatus === "all" && rosterScope === "all",
    ), [visibleProfiles, filtered, tree, group, selectedScope, visibleProfilePage, q, profileStatus, rosterScope]);
    const selectableProfiles = profileSections.flatMap(section => profileGroupCollapsed(section, groupDisclosure, revealGroupMatches) ? [] : section.profiles);
    const rangeVisibleIds = selectableProfiles.map(profile => profile.id);
    const rangeViewKey = JSON.stringify([catalog?.currentId ?? "", view, rosterScope, q, group, profileStatus, sort.key, sort.dir, visibleProfilePage, pageSize]);
    rangeSelectionAnchor.current = reconcileProfileSelectionAnchor(rangeSelectionAnchor.current, rangeViewKey, rangeVisibleIds);
    const saveGroupDisclosure = (next: Map<string, boolean>) => {
      const value = serializeGroupDisclosure(next);
      setGroupDisclosure(readGroupDisclosure(value));
      writeSetting(GROUP_DISCLOSURE_KEY, value);
    };
    const toggleProfileGroup = (name: string, collapsed: boolean) => {
      const next = new Map(groupDisclosure);
      next.delete(name);
      next.set(name, !collapsed);
      saveGroupDisclosure(next);
    };
    const createHasProxy = !!(form.host.trim() || form.port.trim() || form.user.trim() || form.pass);
    const createProxyIssue = proxyPaste.trim() ? { field: "proxyPaste", message: proxyPasteInvalid ? "This proxy could not be filled in. Check the format and try again." : "Use Autofill to apply the pasted proxy, or clear it before creating this environment." }
      : createHasProxy && !form.host.trim() ? { field: "host", message: "Enter the proxy host, or clear the proxy fields to create without a profile proxy." } : null;
    const createProxyFeedback = (field: string): EditorFieldFeedback => ({ field, invalid: createProxyIssue?.field === field, describedBy: "profile-create-validation-error" });
    const locateCreateProblem = () => {
      const editor = createEditorRef.current;
      if (!editor) return;
      if (createProxyIssue) setCreateProxyOpen(true);
      const invalidField = editor.querySelector<HTMLElement>('[data-profile-field][aria-invalid="true"]');
      focusEditorTarget(invalidField ?? editor.querySelector<HTMLElement>(".profile-create-error"), editorScroll);
    };
    const createProxyHost = form.host.trim();
    const createProxyEndpoint = form.port ? `${createProxyHost.includes(":") && !createProxyHost.startsWith("[") ? `[${createProxyHost}]` : createProxyHost}:${form.port}` : createProxyHost;
    const editHasProxy = !!(editForm.proxy ?? "").trim();
    const editProxyChanged = (editForm.proxy ?? "") !== editInitialProxy.proxy ||
    (editHasProxy && editForm.proxyType !== editInitialProxy.proxyType) || editClearQuarantinedProxy;
    const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;
    const folderMenuRef = useDismiss<HTMLSpanElement>(folderMenu !== null, () => setFolderMenu(null));
    const colsRef = useDismiss<HTMLDivElement>(colsOpen, () => setColsOpen(false));
    const groupManagerRef = useDismiss<HTMLDivElement>(groupManagerOpen, () => { setGroupManagerOpen(false); setFolderMenu(null); });
    useEffect(() => { if (selected.size === 0) setBulkToolsOpen(false); }, [selected.size]);

    const exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false));
    const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
    const toggleColumn = (key: ColumnKey) =>
    setHiddenCols((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify([...next]));
      return next;
    });
    const applyPageSize = (size: number) => { setPageSize(size); writeSetting(PAGE_SIZE_KEY, String(size)); };
    const chooseTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    writeSetting(THEME_KEY, choice);
    try { document.cookie = themeCookie(choice); } catch {}
  };

    const toggleSidebar = () => {
      sidebarChoice.current = { workspaceId: workspaceCoordinator.getSnapshot().workspaceId };
      setSidebarCollapsed((collapsed) => {
        writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1");
        return !collapsed;
      });
    };
    const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
    const refreshRoster = async () => {
        setRefreshing(true);
        try {
            await Promise.all([load(), Promise.resolve()]);
        }
        finally {
            setRefreshing(false);
        }
    };
    const profileMetrics = useProfileMetrics(profiles, selected);
    const profilesById = profileMetrics.profilesById;
    const editProfileRow = editId ? profilesById.get(editId) : undefined;
    const editSerial = editProfileRow?.serial ?? null;
    const editRunning = editProfileRow?.running === true;
    useEffect(() => {
    const previous = previousProfileFilters.current;
    const filtersChanged = previous.q !== q || previous.group !== group || previous.pageSize !== pageSize || previous.profileStatus !== profileStatus;
    previousProfileFilters.current = { q, group, pageSize, profileStatus };
    // A changed filter always starts on page one. Roster changes alone clamp a
    // deleted last page; two separate effects can otherwise overwrite the reset.
    const nextPage = filtersChanged ? 0 : visibleProfilePage;
    if (profilePage !== nextPage) setProfilePage(nextPage);
  }, [q, group, pageSize, profileStatus, profilePage, visibleProfilePage]);
    const runningCount = profileMetrics.runningCount;
    const selectedMobileCount = profileMetrics.selectedMobileCount;
    const existingGroups = groups.slice(1); // drop the "all" pseudo-group

    const selectedProfilesSupportChromeExtensions = profileMetrics.selectedProfilesSupportChromeExtensions;
    const rosterViewCounts = useMemo(() => {
      let favorites = 0;
      let recent = 0;
      let attention = 0;
      for (const profile of profiles) {
        if (favoriteProfileIds.has(profile.id)) favorites += 1;
        if (inProfileScope(profile, "recent", favoriteProfileIds)) recent += 1;
        if (inProfileScope(profile, "attention", favoriteProfileIds)) attention += 1;
      }
      return { all: profiles.length, favorites, recent, attention };
    }, [profiles, favoriteProfileIds]);
    const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const byName = new Map(tree.map((folder) => [folder.name, folder]));
    for (const profile of profiles) {
      for (const name of [profile.group, ...(byName.get(profile.group)?.ancestors ?? [])]) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [tree, profiles]);
    const countFor = (g: string) => folderCounts.get(g) ?? 0;
    const installedExtensionIds = new Set(extensions.map((item) => item.id));
    const editExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...editInitialExts, ...editExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];
    const changeProfileSelection = (id: string, event: React.ChangeEvent<HTMLInputElement>) => {
      const keyboard = rangeKeyboardActivation.current;
      rangeKeyboardActivation.current = null;
      const result = changeProfileRangeSelection({ selected: latestSelection.current, visibleIds: rangeVisibleIds,
        viewKey: rangeViewKey, anchor: rangeSelectionAnchor.current, id, checked: event.currentTarget.checked,
        shiftKey: !!(event.nativeEvent as MouseEvent).shiftKey || keyboard?.id === id && keyboard.shiftKey });
      rangeSelectionAnchor.current = result.anchor;
      latestSelection.current = result.selected;
      setSelected(result.selected);
    };
    const allVisibleSelected = selectableProfiles.length > 0 && selectableProfiles.every((p) => selected.has(p.id));
    const selectedFilteredCount = filtered.filter((p) => selected.has(p.id)).length;
    const selectedOutsideFilter = selected.size - selectedFilteredCount;
    const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length && selectedOutsideFilter === 0;
    const selectionKind = q.trim() ? t("matching profiles") : t("profiles");
    const selectionScope = group === "all"
      ? t("{count} {kind}", { count: filtered.length.toLocaleString(), kind: selectionKind })
      : t("{count} {kind} in “{group}”", { count: filtered.length.toLocaleString(), kind: selectionKind, group });
    const selectAllFiltered = () => setSelected(new Set(filtered.map((p) => p.id)));
    const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) selectableProfiles.forEach((p) => n.delete(p.id));
      else selectableProfiles.forEach((p) => n.add(p.id));
      return n;
    });
    const completeMove = (result: ProfileMoveResult | null, selection: Set<string>, draftRevision: number) => {
      if (!result || !bulkOwnerActive.current || !result.confirmedIds.length) return;
      const unchangedSelection = latestSelection.current === selection;
      const confirmed = new Set(result.confirmedIds);
      setSelected(current => current === selection ? new Set([...current].filter(id => !confirmed.has(id))) : current);
      if (unchangedSelection && !result.unresolvedIds.length && moveDraftRevision.current === draftRevision && (newMode ? newGroup.trim() : moveTarget) === result.attempt.group) {
        moveDraftRevision.current++; setNewMode(false); setNewGroup(""); setMoveTarget(null);
      }
    };
    const runMoveAction = async (action: () => Promise<ProfileMoveResult | null>) => {
      if (moveUiInFlight.current || profileMove.busy) return;
      const selection = latestSelection.current, revision = moveDraftRevision.current;
      moveUiInFlight.current = true; setActionErr(null);
      try { completeMove(await action(), selection, revision); }
      catch { if (bulkOwnerActive.current) setActionErr(t("The move could not be confirmed. Check the result before trying again.")); }
      finally { moveUiInFlight.current = false; }
    };
    const moveSelected = () => {
      const ids = [...selected], destination = newMode ? newGroup.trim() : moveTarget;
      if (ids.length && destination !== null && (!newMode || !!destination)) void runMoveAction(() => profileMove.submit({ ids, group: destination }));
    };
    const deleteSelected = async () => {
        const ids = [...selected];
        if (ids.length === 0 || deleteInFlight.current) return;
        const confirmed = await requestConfirm({
          title: t("Move to Trash"),
          message: t("Move all {count} selected environments to Trash? This includes every selected page. You can restore them with their saved data.", { count: ids.length.toLocaleString() }),
          confirmLabel: t("Move to Trash"),
          cancelLabel: t("Cancel"),
          tone: "danger",
        });
        if (!confirmed || deleteInFlight.current) return;
        deleteInFlight.current = true;
        setDeleting(true);
        setActionErr(null);
        try {
            const r = await deleteProfiles(ids);
            if (r.ok === false) {
        setActionErr(r.error || t("Delete failed"));
        return;
      }
            const problems = [
        r.locked?.length && t("{count} in use, not deleted", { count: r.locked.length }),
        r.failed?.length && t("{count} failed", { count: r.failed.length }),
      ].filter(Boolean);
            if (problems.length) setActionErr(t("{problems}. These profiles remain selected.", { problems: problems.join("; ") }));
            setSelected(new Set([...(r.locked ?? []), ...(r.failed ?? [])]));
            flash(t("{count} profiles moved to Trash", { count: r.deleted.toLocaleString() }));
            await load();
        }
        catch (e) {
            setActionErr(String(e));
        }
        finally {
            deleteInFlight.current = false;
            setDeleting(false);
        }
    };
    const setLaunchFailure = (id: string, message: string | null) => {
      setLaunchFailureState(previous => {
        const current = previous.workspaceId === currentWorkspaceId ? previous.byId : null;
        if (message === null && !current?.has(id)) return previous;
        const byId = new Map(current);
        if (message === null) byId.delete(id);
        else byId.set(id, message);
        return { workspaceId: currentWorkspaceId, byId };
      });
    };
    const act = async (id: string, fn: (id: string) => Promise<any>) => {
      if (busy[id] || manualActions.current.has(id)) return;
      const starting = fn === openProfile || fn === restartProfile;
      const workspaceId = workspaceCoordinator.getSnapshot().workspaceId;
      const ownsResult = () => bulkOwnerActive.current && workspaceCoordinator.getSnapshot().workspaceId === workspaceId;
      const recordFailure = (message: string) => {
        if (starting && lastRosterResult.current?.profiles.some(profile => profile.id === id && !profile.running)) setLaunchFailure(id, message);
        else setActionErr(message);
      };
      manualActions.current.add(id);
      setActionErr(null);
      setBusy(current => ({ ...current, [id]: true }));
      try {
        const result = await fn(id);
        if (!ownsResult()) return;
        await load();
        if (!ownsResult()) return;
        if (result?.ok === false) recordFailure(typeof result.error === "string" && result.error ? result.error : "action failed");
        else {
          if (starting) setLaunchFailure(id, null);
          if (typeof result?.warning === "string" && result.warning) setActionErr(result.warning);
        }
      } catch (error) {
        if (ownsResult()) await load().catch(() => {});
        if (ownsResult()) recordFailure(error instanceof Error ? error.message : String(error));
      } finally {
        manualActions.current.delete(id);
        if (bulkOwnerActive.current) setBusy(current => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    };
    /** While a profile opens, its Open button shows the browser download it waits for. */
    const openLabel = (profile: UiProfile) => {
    if (!busy[profile.id]) return t(launchFailures?.has(profile.id) ? "Retry" : "Start");
    const waiting = profileDownloads(profile, runtimeDownloadsStale ? [] : runtimeDownloads);
    return waiting.length > 0
      ? runtimeDownloadLabel(waiting, t)
      : t("Opening…");
  };

    const openCookie = (targets: UiProfile[]) => { setCookieTargets([...targets]); };
    const closeCookie = () => { setCookieTargets(null); };
    const showCookieImportTask = () => {
      setView("profiles");
      requestAnimationFrame(() => { cookieTaskPanelRef.current?.focus({ preventScroll: true }); cookieTaskPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); });
    };
    const openPendingCookies = async (profile: UiProfile) => {
    setPendingView({ profile, cookies: null, error: null, busy: false });
    try {
      const result = await fetchPendingCookies(profile.id);
      setPendingView((view) => view && { ...view, cookies: result.cookies ?? [], error: result.ok ? null : result.error ?? t("Cookies could not be loaded.") });
    } catch (error) {
      setPendingView((view) => view && { ...view, cookies: [], error: error instanceof Error ? error.message : t("Cookies could not be loaded.") });
    }
  };
    const removePendingCookies = async () => {
    if (!pendingView) return;
    setPendingView({ ...pendingView, busy: true, error: null });
    try {
      const result = await clearPendingCookies(pendingView.profile.id);
      if (!result.ok) throw new Error(result.error || t("Cookies could not be removed."));
      setPendingView(null);
      await load().catch(() => {});
      flash(t("Pending cookies removed."));
    } catch (error) {
      setPendingView((view) => view && { ...view, busy: false, error: error instanceof Error ? error.message : t("Cookies could not be removed.") });
    }
  };
    const importProfiles = async (files: File[], assign: { group?: string; platform?: string } | undefined, reportError: (message: string | null) => void): Promise<boolean> => {
      if (!files.length) return false;
      if (importInFlight.current) { reportError(t("An import is already in progress. Wait for its result before importing again.")); return false; }
      const lease = workspaceCoordinator.acquire("profile-import", catalog?.currentId);
      if (!lease) { reportError(t(workspaceOperationMessage(workspaceCoordinator.getSnapshot()))); return false; }
      importInFlight.current = true; setImportBusy(true); reportError(null);
      try {
        const response = await uploadExports(files, assign);
        const receipt = createImportReceipt(response);
        if (!bulkOwnerActive.current) return false;
        setImportReceipt(receipt); setImportReceiptExpanded(receipt.issues.length > 0); setImportReceiptRefreshing(true);
        workspaceCoordinator.setPhase(lease, "refreshing");
        const refreshed = await Promise.allSettled([refreshImportedProfiles(), workspaceCoordinator.refreshWorkspaceViews(lease)]);
        if (bulkOwnerActive.current && refreshed.some(result => result.status === "rejected")) setActionErr(t("Import completed, but the environment list could not refresh. Refresh the list to see the saved result."));
        return true;
      } catch (error) {
        if (bulkOwnerActive.current) {
          reportError(t(error instanceof ImportReceiptError ? error.message : "The import could not be confirmed. Refresh environments before trying again."));
          if (error instanceof ImportReceiptError && error.kind === "invalid") await load().catch(() => {});
        }
        return false;
      } finally {
        workspaceCoordinator.release(lease); importInFlight.current = false;
        if (bulkOwnerActive.current) { setImportBusy(false); setImportReceiptRefreshing(false); }
      }
    };
    const doUpload = async (files: FileList | File[]) => { await importProfiles(Array.from(files), undefined, setActionErr); };
    // ---- Bulk add accounts from provider export files or AdsPower text ----
    const openBulk = () => {
        if (importInFlight.current) { setActionErr(t("An import is already in progress. Wait for its result before importing again.")); return; }
        setBulkFiles([]);
        setBulkText("");
        setBulkGroup("");
        setBulkPlatform("");
        setBulkErr(null);
        setBulkSource("file");
        setShowBulk(true);
    };
    const closeBulk = () => {
    if (importInFlight.current) return;
    setShowBulk(false);
    setBulkFiles([]);
    setBulkText("");
    setBulkErr(null);
  };
    const submitBulk = async () => {
        if (importInFlight.current || (!bulkFiles.length && !bulkText.trim()))
            return;
        setBulkBusy(true);
        setBulkErr(null);
        try {
            const uploads = [...bulkFiles];
            if (bulkText.trim()) uploads.push(new File([bulkText], "pasted-adspower.txt", { type: "text/plain" }));
            if (!uploads.length) throw new Error("no rows found in the file(s)");
            if (await importProfiles(uploads, { group: bulkGroup.trim(), platform: bulkPlatform }, setBulkErr)) closeBulk();
        }
        catch (e) {
            if (bulkOwnerActive.current) setBulkErr(t("The import could not be confirmed. Refresh environments before trying again."));
        }
        finally {
            if (bulkOwnerActive.current) setBulkBusy(false);
        }
    };
    const resetCreateProxyCheck = () => {
    createProxyCheckGeneration.current++;
    setCreateProxyCheck(EMPTY_PROXY_CHECK);
  };
    const setF = (k: keyof typeof BLANK_FORM, v: string) => {
    if (createInFlight.current) return;
    if (k === "proxyType" || k === "host" || k === "port" || k === "user" || k === "pass") {
      resetCreateProxyCheck();
    }
    if (k === "proxyType" || k === "host" || k === "port") setCreateProxySource(null);
    setForm((f) => ({ ...f, [k]: v }));
  };
    // Open prefilled with the folder you're browsing; close always resets so a
    // cancelled draft never leaks into the next open.
    function cancelReuseRead() {
      reuseGeneration.current++;
      reuseRead.current?.controller.abort();
      reuseRead.current = null;
      setReuseRequest(null);
    }
    const beginCreate = (proxy?: LocalProxyDraftCandidate, trigger?: HTMLButtonElement, reuse?: ReusableProfileSettings) => {
        if (showCreate || createInFlight.current || editSessionRef.current) return false;
        createCloseGuard.reset();
        cancelReuseRead();
        createReturnFocus.current = trigger ?? null;
        resetCreateProxyCheck();
        const draft: typeof BLANK_FORM = { ...BLANK_FORM, engine: appMode?.defaultEngine ?? "chromium", chromiumRuntime: appMode?.defaultChromiumRuntime ?? "", group: group !== "all" ? group : "" };
        if (reuse) Object.assign(draft, { name: t("{name} copy", { name: reuse.name || reuse.sourceId }), group: reuse.group, engine: reuse.engine,
          chromiumRuntime: reuse.engine === "chromium" && reuse.chromiumRuntime === "aliasmode" ? "aliasmode" : "",
          platformOs: reuse.platformOs, screen: reuse.screen, platform: reuse.platform });
        else if (proxy) Object.assign(draft, { proxyType: proxy.type, host: proxy.host, port: String(proxy.port) });
        initialCreateForm.current = draft;
        setForm(draft);
        setCreateReuseSource(reuse ?? null);
        setCreateProxySource(reuse ? null : proxy ?? null);
        setProxyPaste("");
        setProxyPasteOk(null);
        setProxyPasteInvalid(false);
        setCreateErr(null);
        // A first profile needs no proxy, so the section starts closed until profiles use one.
        setCreateProxyOpen(reuse ? false : !!proxy || profiles.some((profile) => !!profile.proxy));
        setShowCreate(true);
        return true;
    };
    const reuseProfileConfiguration = async (id: string, name: string) => {
      if (!reuseCanOpenRef.current || createInFlight.current || editSessionRef.current || reuseRead.current?.id === id) return;
      cancelReuseRead();
      const request = { id, generation: ++reuseGeneration.current, controller: new AbortController() };
      reuseRead.current = request;
      setReuseRequest({ id, name, status: "loading" });
      const owns = () => reuseRead.current === request && request.generation === reuseGeneration.current && !request.controller.signal.aborted;
      try {
        const source = await fetchReusableProfile(id, request.controller.signal);
        if (!owns() || !reuseCanOpenRef.current || createInFlight.current || editSessionRef.current) return;
        const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find(item => item.dataset.profileId === id);
        const trigger = row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? document.querySelector<HTMLButtonElement>(".profiles-workspace .page-actions .btn.primary") ?? undefined;
        beginCreate(undefined, trigger, source);
      } catch (error) {
        if (owns() && reuseCanOpenRef.current) setReuseRequest({ id, name, status: "failed", error: error instanceof Error ? error.message : "The source configuration could not be loaded." });
      } finally {
        if (owns()) { reuseRead.current = null; setReuseRequest(current => current?.status === "loading" ? null : current); }
      }
    };
    const openCreate = () => beginCreate();
    const finishCloseCreate = () => {
    if (createInFlight.current) return;
    cancelReuseRead();
    resetCreateProxyCheck();
    setShowCreate(false);
    setCreateProxySource(null);
    setCreateReuseSource(null);
    setForm(BLANK_FORM);
    setProxyPaste("");
    setProxyPasteOk(null);
    setProxyPasteInvalid(false);
    setCreateErr(null);
  };
    const closeCreate = () => {
      if (createInFlight.current || !showCreate) return;
      const dirty = (Object.keys(BLANK_FORM) as Array<keyof typeof BLANK_FORM>).some(key => form[key] !== initialCreateForm.current[key]) || !!proxyPaste;
      createCloseGuard.requestClose({ dirty, onDiscard: finishCloseCreate });
    };
    const applyProxyPaste = (raw: string) => {
    if (!raw.trim()) return;
    try {
      const parsed = parsePastedProxy(raw, form.proxyType === "socks5" ? "socks5" : "http");
      resetCreateProxyCheck();
      setCreateProxySource(null);
      setForm((current) => ({
        ...current,
        proxyType: parsed.type,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        pass: parsed.pass,
      }));
      setProxyPaste("");
      setProxyPasteInvalid(false);
      setProxyPasteOk(`✓ ${parsed.type.toUpperCase()} proxy fields filled`);
      setCreateErr(null);
    } catch {
      setProxyPasteOk(null);
      setProxyPaste(raw);
      setProxyPasteInvalid(true);
    }
  };
    const checkCreateProxy = async () => {
    const generation = ++createProxyCheckGeneration.current;
    if (form.proxyType === "https") {
      setCreateProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setCreateProxyCheck({ checking: true, result: null, error: null });
    const proxy: ProxyCheckInput = {
      type: form.proxyType,
      host: form.host,
      port: form.port,
      user: form.user,
      pass: form.pass,
    };
    try {
      const result = await checkProxy(proxy);
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
    const submitCreate = async () => {
        if (createInFlight.current || createProxyIssue) return;
        createInFlight.current = true;
        setCreating(true);
        setCreateErr(null);
        try {
            const r = await createProfile({
                name: form.name,
                engine: form.engine,
                ...(createRuntimeInput ? { chromiumRuntime: createRuntimeInput } : {}),
                group: form.group,
                platform: form.platform,
                screen: form.screen,
                ...(form.platformOs ? { platformOs: form.platformOs } : {}),
                ...({ customNo: form.customNo }),
                username: form.username,
                password: form.password,
                email: form.email,
                emailPassword: form.emailPassword,
                twofa: form.twofa,
                proxy: form.host.trim() ? { type: form.proxyType, host: form.host, port: form.port, user: form.user, pass: form.pass } : null,
            });
            if (r.ok) {
        const next = new Map(groupDisclosure);
        next.set(form.group, false);
        saveGroupDisclosure(next);
        await load();
        createInFlight.current = false;
        finishCloseCreate();
      } else {
        setCreateErr(r.error || "create failed"); // shown inside the modal
      }
        }
        catch (e) {
            setCreateErr(String(e));
        }
        finally {
            createInFlight.current = false;
            setCreating(false);
        }
    };
    // ---- Edit one profile (full detail) ----
    const resetEditProxyCheck = () => {
    editProxyCheckGeneration.current++;
    setEditProxyCheck(EMPTY_PROXY_CHECK);
  };
    const setEF = (k: string, v: string) => {
    if (editSaveInFlight.current || !editSessionRef.current?.ready) return;
    if (k === "proxy" || k === "proxyType") {
      resetEditProxyCheck();
      setTimezoneBusy(false);
    }
    setEditForm((f) => ({ ...f, [k]: v }));
  };
    // A retry and a reopened copy of the same profile each receive a new token.
    const loadEditedProfile = async (id: string) => {
    if (editSaveInFlight.current || editSessionRef.current?.loading) return;
    const session = { id, generation: ++editSessionSequence.current, loading: true, ready: false };
    editSessionRef.current = session;
    setEditLoadedGeneration(null);
    setEditErr(null);
    setEditLoading(true);
      try {
        const p: EditProfile = await fetchProfileEdit(id);
        if (editSessionRef.current !== session) return;
        if (!validEditDetail(p, id)) throw new Error("The local service returned incomplete profile details. Retry before editing.");
        const loadedForm = {
          name: p.name, group: p.group, platform: p.platform,
          proxyType: p.proxyType || "http", proxy: p.proxy,
          proxyError: p.proxyError ?? "",
          username: p.username, password: p.password,
          email: p.email, emailPassword: p.emailPassword, twofa: p.twofa,
          resolution: p.resolution, tags: p.tags,
          customNo: p.customNo ?? "",
          platformOs: p.platformOs ?? "",
          timezone: p.timezone,
          locale: p.locale ?? "",
          cores: p.cores ?? "",
          fingerprintSeed: p.fingerprintSeed ?? "",
        };
        setEditForm(loadedForm);
        setEditSnapshot(captureProfileEditSnapshot({ form: loadedForm, extensions: p.extensions ?? [], engine: p.engine === "firefox" ? "firefox" : "chromium", timezoneManual: !!p.timezoneManual, proxyQuarantined: !!p.proxyError }));
        setEditClearQuarantinedProxy(false);
        setEditInitialProxy({ proxy: p.proxy, proxyType: p.proxyType || "http" });
        setEditInitialFingerprint({
          resolution: p.resolution, platformOs: p.platformOs ?? "", timezone: p.timezone ?? "",
          locale: p.locale ?? "", cores: p.cores ?? "", fingerprintSeed: p.fingerprintSeed ?? "",
        });
        setEditEngine(p.engine === "firefox" ? "firefox" : "chromium");
        setEditChromiumRuntime(p.chromiumRuntime ?? "");
        setEditHardware(p.hardware);
        setEditExts(p.extensions ?? []);
        setEditInitialExts(p.extensions ?? []);
        setEditMobile(p.desktopConversion ?? null);
        session.ready = true;
        setEditLoadedGeneration(session.generation);
      } catch (e) {
        if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (editSessionRef.current === session) { session.loading = false; setEditLoading(false); }
      }
  };
    const refreshQualityAfterEdit = () => {
    // The report's edit button can be disabled while its new evidence loads.
    if (view === "settings" && settingsTab === "fingerprints") editReturnFocus.current = document.getElementById("settings-tab-fingerprints");
    if (view === "inspection") editReturnFocus.current = document.getElementById("inspection-page-title");
    setFingerprintRefreshVersion(version => version + 1);
  };
    const explainFingerprint = (report: FingerprintReport) => {
    if (editSessionRef.current) return;
    const text = buildFingerprintAssistantBrief(report, t);
    setAssistantDraftSuggestion({ id: ++assistantDraftSequence.current, text, source: {
      title: t("Inspection for {profile}", { profile: report.name || t("Unnamed profile") }),
      description: t("Review the selected fingerprint findings, then return to the report to verify your changes."),
      returnKey: report.profileId,
    } });
    setView("assistant");
  };
    // The dialog opens immediately, but can save only validated details from this session.
    const openEdit = (id: string, field?: InspectionEditField, trigger?: HTMLButtonElement) => {
    if (busy[id]) { setActionErr(t("Wait for the current environment action to finish before editing it.")); return; }
    if (editSaveInFlight.current) return;
    cancelReuseRead();
    editReturnFocus.current = trigger ?? null;
    editFieldOnOpen.current = field ?? null;
    editCloseGuard.reset();
    resetEditProxyCheck();
    setActionErr(null);
    editSessionRef.current = null;
    setEditLoadedGeneration(null);
    setEditId(id);
    setEditForm({});
    setEditSnapshot(null); setEditClearQuarantinedProxy(false);
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditMobile(null);
    setEditTotp(null);
    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    void loadEditedProfile(id);
  };
    const finishCloseEdit = () => {
    if (editSaveInFlight.current) return;
    editFieldOnOpen.current = null;
    resetEditProxyCheck();
    editSessionRef.current = null;
    setEditLoadedGeneration(null);
    setEditId(null);

    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditForm({});
    setEditSnapshot(null); setEditClearQuarantinedProxy(false);
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditErr(null);
    setEditMobile(null);
    setEditTotp(null);
  };
    const closeEdit = () => {
      if (editSaveInFlight.current || !editSessionRef.current) return;
      const dirty = !!editSnapshot && (PROFILE_EDIT_FORM_FIELDS.some(field => editForm[field] !== editSnapshot.form[field])
        || !sameExtensionSelection(editExts, [...editSnapshot.extensions]) || editClearQuarantinedProxy);
      editCloseGuard.requestClose({ dirty, onDiscard: finishCloseEdit });
    };
    const checkEditedProxy = async () => {
    if (!editSessionRef.current?.ready || editSaveInFlight.current) return;
    const generation = ++editProxyCheckGeneration.current;
    const value = editForm.proxy ?? "";
    if (editForm.proxyType === "https" || /^\s*https:\/\//i.test(value)) {
      setEditProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setEditProxyCheck({ checking: true, result: null, error: null });
    let proxy: ProxyCheckInput;
    try {
      proxy = parsePastedProxy(value, editForm.proxyType === "socks5" ? "socks5" : "http");
    } catch {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result: null, error: "invalid" });
      }
      return;
    }
    try {
      const result = await checkProxy(proxy);
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
    const refreshEditedTimezone = async () => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready || editSaveInFlight.current || editProxyChanged || timezoneBusy || editForm.proxyError) return;
    const confirmed = await requestConfirm({
      title: t("Confirm fingerprint change"),
      message: t(FINGERPRINT_EDIT_WARNING),
      confirmLabel: t("Continue"),
      cancelLabel: t("Cancel"),
    });
    if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current || timezoneBusy) return;
    const id = editId;
    const generation = editProxyCheckGeneration.current;
    editSaveInFlight.current = true;
    setTimezoneBusy(true);
    setEditErr(null);
    try {
      const { timezone, locale } = await refreshProfileTimezone(id);
      if (editSessionRef.current !== session || generation !== editProxyCheckGeneration.current) return;
      setEditForm((form) => ({ ...form, timezone, locale }));
      setEditInitialFingerprint((initial) => ({ ...initial, timezone, locale }));
      setEditSnapshot(initial => initial ? captureProfileEditSnapshot({ ...initial, form: { ...initial.form, timezone, locale }, timezoneManual: false }) : null);
      refreshQualityAfterEdit();
      await load();
    } catch (error) {
      if (editSessionRef.current === session && generation === editProxyCheckGeneration.current) setEditErr(error instanceof Error ? error.message : String(error));
    } finally {
      if (editSessionRef.current === session) { editSaveInFlight.current = false; setTimezoneBusy(false); }
    }
  };
    const saveEdit = async () => {
        const session = editSessionRef.current;
        if (!editId || !editReady || !session?.ready || session.id !== editId || editSaveInFlight.current || timezoneBusy) return;
        if (!editSnapshot) return;
        let changes: ReturnType<typeof buildProfileEditPatch>;
        try { changes = buildProfileEditPatch(editSnapshot, { form: editForm, extensions: editExts, clearQuarantinedProxy: editClearQuarantinedProxy }); }
        catch (error) { setEditErr(error instanceof ProfileEditPatchError ? error.message : "Edited fields could not be validated. Reload this editor before saving."); return; }
        if (!changes.summary.hasChanges) return;
        if (changes.summary.requiresFingerprintConfirmation) {
          const confirmed = await requestConfirm({
            title: t("Confirm fingerprint change"),
            message: t(FINGERPRINT_EDIT_WARNING),
            confirmLabel: t("Save fingerprint changes"),
            cancelLabel: t("Cancel"),
          });
          if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current || timezoneBusy) return;
        }
        editSaveInFlight.current = true;
        setEditSaving(true);
        setEditErr(null);
        try {
            const r = await updateProfile(session.id, changes.patch);
            if (editSessionRef.current !== session) return;
            if (r?.ok === true) {
        refreshQualityAfterEdit();
        await load();
        if (editSessionRef.current !== session) return;
        editSaveInFlight.current = false;
        finishCloseEdit();
        if (r.restartRequired) flash(t("Saved. The open browser keeps its current proxy and fingerprint until it restarts."));
      }
            else if (r.status === 409) {
                setEditErr(r.error || "Profile changed; reopen Edit before saving");
            }
            else
                setEditErr(r.error || "save failed");
        }
        catch (e) {
            if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (editSessionRef.current === session) { editSaveInFlight.current = false; setEditSaving(false); }
        }
    };
    const convertEditedMobile = async () => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready || !editMobile || editSaveInFlight.current) return;
    const platform = editMobile.platform === "macos" ? "macOS" : "Windows";
    const screenNote = editMobile.screenChanged
      ? t("Its mobile-sized screen will become {resolution}.", { resolution: editMobile.resolution })
      : t("Its existing desktop-sized screen will be kept.");
    const confirmed = await requestConfirm({
      title: t("Convert to desktop persona"),
      message: `${t("Convert this imported mobile persona to a stable {platform} desktop persona?", { platform })}\n\n${t("Cookies, login/session, credentials, proxy, timezone, fingerprint seed, tags and extensions are preserved.")} ${screenNote}\n\n${t("The website may treat the first launch as a new desktop device and request verification. Other unsaved edits in this dialog are not included.")}`,
      confirmLabel: t("Convert"),
      cancelLabel: t("Cancel"),
    });
    if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current) return;
    editSaveInFlight.current = true;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await convertMobileProfile(session.id);
      if (editSessionRef.current !== session) return;
      if (!r.ok) { setEditErr(r.error || t("Conversion failed")); return; }
      refreshQualityAfterEdit();
      await load();
      if (editSessionRef.current !== session) return;
      editSaveInFlight.current = false;
      finishCloseEdit();
      flash(t("Converted profile to a stable {platform} desktop persona", { platform }));
    } catch (e) {
      if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (editSessionRef.current === session) { editSaveInFlight.current = false; setEditSaving(false); }
    }
  };
    // ---- Extensions manager (Store URL / upload / delete) ----
    const refreshExtensionState = async (assignmentsChanged = false) => {
    const workspaceId = extensionWorkspace.current;
    const generation = ++extensionReadVersion.current;
    setExtLoading(true); markExtensionFresh(false);
    const registry = await Promise.allSettled([fetchExtensions(), fetchGroupExtensionDefaults(), readFreshRoster()]);
    if (generation !== extensionReadVersion.current || workspaceId !== extensionWorkspace.current || !bulkOwnerActive.current) return false;
    if (registry[0]?.status === "fulfilled") setExtensions(registry[0].value as Extension[]);
    if (registry[1]?.status === "fulfilled") extensionDrafts.receive(workspaceId, registry[1].value as GroupExtensionDefaults[]);
    setExtLoading(false);
    const fresh = registry.every(result => result.status === "fulfilled"); markExtensionFresh(fresh);
    setExtErr(fresh ? null : t("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes."));
    return fresh;
  };
    const toggleGroupDefaultExt = (id: string) => extensionDrafts.toggle(id);
    const applyGroupExtensionDefault = async (snapshot: GroupDefaultsSnapshot): Promise<boolean> => {
    if (!snapshot.group || !/^[a-f0-9]{64}$/.test(snapshot.expectedFingerprint ?? "") || !extensionFresh.current || extensionMutation.current) return false;
    const workspaceId = extensionWorkspace.current;
    extensionMutation.current = true; setGroupDefaultBusy(true); setExtErr(null);
    markExtensionFresh(false);
    try {
      const result = await setGroupExtensionDefaults(snapshot.group, snapshot.extensions, snapshot.expectedFingerprint);
      if (!bulkOwnerActive.current || workspaceId !== extensionWorkspace.current) return result.ok === true;
      if (result.ok !== true || !Number.isSafeInteger(result.updatedCount) || result.updatedCount < 0) { setExtErr(result.error || t("Could not apply extension defaults.")); return false; }
      extensionDrafts.acknowledge(workspaceId, snapshot.group, snapshot.extensions);
      setProfiles(current => current.map(profile => profile.group === snapshot.group ? { ...profile, extensions: profile.engine === "firefox" ? [] : [...snapshot.extensions] } : profile));
      const refreshed = await refreshExtensionState(true);
      if (!refreshed) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t("Updated extension defaults for {group} on {count} environments. Reopen browsers to apply.", { group: snapshot.group, count: result.updatedCount }));
      return true;
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error)); return false;
    } finally { extensionMutation.current = false; setGroupDefaultBusy(false); }
  };
    const doInstallWebStoreExtension = async (): Promise<boolean> => {
    const source = extSource.trim();
    if (!source) { setExtErr(t("Paste a Chrome Web Store URL or extension ID")); return false; }
    if (extensionMutation.current) return false;
    extensionMutation.current = true; setExtInstallBusy(true); setExtErr(null);
    try {
      const r = await installWebStoreExtension(source);
      if (r.ok !== true) { setExtErr(r.error || t("Could not install extension.")); return false; }
      setExtSource("");
      if (r.installed?.id && r.installed?.name) setExtensions(current => [...current.filter(item => item.id !== r.installed.id), r.installed]);
      if (!await refreshExtensionState()) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t(r.alreadyInstalled ? "{extension} is already installed." : "Installed {extension}. Assign it to an environment to use it.", { extension: r.installed?.name ?? t("Extension") }));
      return true;
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error)); return false;
    } finally { extensionMutation.current = false; setExtInstallBusy(false); }
  };
    const doUploadExtensions = async (files: FileList | File[]): Promise<boolean> => {
    const list = Array.from(files);
    if (!list.length || extensionMutation.current) return false;
    extensionMutation.current = true; setExtBusy(true); setExtErr(null);
    let installed = 0;
    const failed: string[] = [];
    try {
      // One archive per request gives a truthful partial result if a later file
      // is invalid. Retrying must not silently reinstall successful archives.
      for (const file of list) {
        try {
          const r = await uploadExtensions([file]);
          if (r.ok !== true) throw new Error(r.error || t("Could not upload extension."));
          installed++;
          if (Array.isArray(r.installed)) setExtensions(current => [...current.filter(item => !r.installed.some((added: Extension) => added.id === item.id)), ...r.installed]);
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
    extensionMutation.current = true; setExtBusy(true); setExtErr(null);
    markExtensionFresh(false);
    try {
      const r = await removeExtension(id);
      if (!bulkOwnerActive.current || workspaceId !== extensionWorkspace.current) return r.ok === true;
      if (r.ok !== true) { setExtErr(r.error || t("Could not remove extension.")); return false; }
      setExtensions(current => current.filter(item => item.id !== id));
      extensionDrafts.removeConfirmed(workspaceId, id);
      setEditExts(current => current.filter(item => item !== id));
      setProfiles(current => current.map(profile => profile.extensions ? { ...profile, extensions: profile.extensions.filter(item => item !== id) } : profile));
      if (!await refreshExtensionState(true)) setExtErr(t("The change was saved, but the latest extension data could not be loaded. Reopen this page before making another change."));
      flash(t("Removed {extension} and its environment assignments.", { extension: name }));
      return true;
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error)); return false;
    } finally { extensionMutation.current = false; setExtBusy(false); }
  };
    const toggleEditExt = (id: string) =>
    setEditExts((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
    const bulkAssignExt = async (op: "add" | "remove") => {
    const ids = [...selected];
    if (!ids.length || !bulkExt) return;
    setActionErr(null);
    try {
      const r = await assignExtensionBulk(ids, bulkExt, op);
      if (r.ok === false) { setActionErr(r.error || t("Extension assignment failed")); return; }
      await load();
      const name = extensions.find((x) => x.id === bulkExt)?.name ?? t("extension");
      flash(t(op === "add" ? "Added “{name}” to {count} profile(s)" : "Removed “{name}” from {count} profile(s)", { name, count: r.updated }));
    } catch (e) {
      setActionErr(String(e));
    }
  };
    // ---- 2FA quick-copy (row authenticator button) ----
    const copy2fa = async (id: string) => {
    setActionErr(null);
    try {
      const r = await fetchTotp(id);
      if (!r.code) { setActionErr(t("No 2FA secret on this profile")); return; }
      try {
        await copyPlainText(r.code);
      } catch (copyError) {
        setActionErr(copyError instanceof Error ? copyError.message : t("Could not copy to clipboard."));
        return;
      }
      setTwoFaFlash({ id, code: r.code });
      setTimeout(() => setTwoFaFlash((f) => (f && f.id === id ? null : f)), 4000);
    } catch (e) {
      setActionErr(String(e));
    }
  };
    // A task remains observable after leaving the roster. Only queued items
    // can be stopped; requests already sent settle with their actual results.
    const finishBulkTask = async (task: BulkProfileTask, pending: Promise<BulkProfileTaskSnapshot>, lease: WorkspaceOperationLease) => {
      try {
        const result = await pending;
        if (!bulkOwnerActive.current || bulkTaskRef.current !== task) return;
        if (result.summary.failed) setBulkTaskExpanded(true);
        setBulkTaskRefreshing(true);
        workspaceCoordinator.setPhase(lease, "refreshing");
        await Promise.all([load(), workspaceCoordinator.refreshWorkspaceViews(lease)]);
      } catch (error) {
        if (bulkOwnerActive.current && bulkTaskRef.current === task) setActionErr(error instanceof Error ? error.message : String(error));
      } finally {
        workspaceCoordinator.release(lease);
        if (bulkTaskLease.current === lease) bulkTaskLease.current = null;
        if (bulkOwnerActive.current && bulkTaskRef.current === task) { bulkBatchBusy.current = false; setBulkTaskRefreshing(false); }
      }
    };
    const bulkRun = (action: BulkProfileAction) => {
      if (!selected.size) return;
      if (bulkBatchBusy.current || bulkTaskRef.current && bulkTaskRef.current.getSnapshot().phase !== "complete") {
        setBulkTaskExpanded(true); setActionErr(t("A batch task is already running. Review it before starting another.")); return;
      }
      const targets = [...selected].map(id => {
        const profile = profiles.find(item => item.id === id);
        const skipReason = !profile ? "This environment is no longer in the current list."
          : manualBusy[id] ? "Another action is already using this environment."
          : action === "open" && profile.mobilePersona ? "Convert the imported mobile identity before starting this environment."
          : action === "open" && profile.running ? "This environment is already running."
          : action !== "open" && !profile.running ? "This environment is already stopped." : undefined;
        return { id, name: profile?.name || id, skipReason };
      });
      const task = createBulkProfileTask({ action, targets, concurrency: 4, run: async id => {
        if (!workspaceCoordinator.canContinueBatch(bulkTaskLease.current, bulkTaskWorkspace.current)) {
          bulkTaskRef.current?.stopPending();
          return { ok: false, error: "The workspace changed while this task was waiting. No request was sent." };
        }
        const profile = latestProfiles.current.find(item => item.id === id);
        if (!profile) return { ok: false, error: "This environment is no longer in the current list." };
        if (action === "open" && profile.running) return { ok: true, warning: "Already running; no extra start request was sent." };
        if (action === "close" && !profile.running) return { ok: true, warning: "Already stopped; no extra close request was sent." };
        if (action === "restart" && !profile.running) return { ok: false, error: "The environment stopped before the restart. Start it explicitly if needed." };
        return (action === "open" ? openProfile : action === "close" ? closeProfile : restartProfile)(id);
      } });
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
      bulkTaskLease.current = lease;
      const pending = task.retryFailed();
      if (pending) { bulkBatchBusy.current = true; setBulkTaskExpanded(true); void finishBulkTask(task, pending, lease); }
      else { workspaceCoordinator.release(lease); bulkTaskLease.current = null; }
    };
    const dismissBulkTask = () => {
      if (bulkBatchBusy.current || bulkTaskRef.current?.getSnapshot().phase !== "complete") return;
      bulkTaskRef.current = null; bulkTaskWorkspace.current = null; setBulkTask(null); setBulkTaskRefreshing(false);
    };
    const showBulkTask = () => { setView("profiles"); setBulkTaskExpanded(true); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".bulk-task-expand")?.focus()); };
    const showImportReceipt = () => { setView("profiles"); setImportReceiptExpanded(true); requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>(".import-receipt-controls button") ?? document.getElementById("profiles-page-title"))?.focus()); };
    const convertSelectedMobile = async () => {
    const ids = [...selected].filter((id) => profilesById.get(id)?.mobilePersona);
    if (!ids.length) return;
    const confirmed = await requestConfirm({
      title: t("Convert mobile personas"),
      message: `${t("Convert {count} selected mobile persona(s) to stable desktop personas?", { count: ids.length })}\n\n${t("Account data, sessions, proxies, timezones and fingerprint seeds are preserved. Android keeps the Windows desktop family used by earlier versions of the app; iPhone/iPad keeps macOS. A website may request device verification on first launch.")}`,
      confirmLabel: t("Convert"),
      cancelLabel: t("Cancel"),
    });
    if (!confirmed) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const failed: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await convertMobileProfile(id);
        if (!r.ok) failed.push(`${id}: ${r.error || t("Conversion failed")}`);
      } catch (e) {
        failed.push(`${id}: ${String(e)}`);
      }
    });
    await load().catch((error) => console.warn("[convertSelectedMobile:reload]", error));
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (failed.length) setActionErr(t("{succeeded} converted; {failed} failed — {details}", { succeeded: ids.length - failed.length, failed: failed.length, details: failed.join("; ") }));
    else flash(t("Converted {count} mobile persona(s) to stable desktop personas", { count: ids.length }));
  };
    // ---- Export selected → file ----
    const exportSelected = async (format: ExportFormat) => {
    setExportOpen(false);
    if (!selected.size || exportProgress) return;
    const ids = [...selected];
    setActionErr(null);
    setExportProgress({ completed: 0, total: ids.length });
    try {
      await exportProfiles(ids, format, (progress) => setExportProgress(progress));
      flash(`Exported ${ids.length} profile${ids.length === 1 ? "" : "s"} as ${format.toUpperCase()}`);
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setExportProgress(null);
    }
  };
    // ---- Transient success banner ----
    const expireNotice = () => { clearNoticeTimer(); if (document.querySelector(".notice:focus-within, .notice:hover")) return; noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNotice(null); }, 5000); };
    const flash = (m: string) => { clearNoticeTimer(); setNotice(m); expireNotice(); };
    // ---- File-based bulk update (export → edit → re-upload, matched by id) ----
    const openUpdate = () => { setShowUpdate(true); };
    const showFileUpdateResult = () => {
      setView("profiles");
      requestAnimationFrame(() => { fileUpdatePanelRef.current?.focus({ preventScroll: true }); fileUpdatePanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); });
    };
    // ---- Group create / rename / delete ----
    const createSidebarGroup = async () => {
        const name = sidebarGroupName.trim();
        if (!name) return;
        if (name === "all") {
      setActionErr("This name is reserved.");
      return;
    }
        setActionErr(null);
        try {
            const result = await createGroup(name, newFolderParent);
            if (result.ok === false) {
        setActionErr(result.error || "create failed");
        return;
      }
            await Promise.all([load(), Promise.resolve()]);
            selectFolder(result.folder?.name ?? name);
            setCollapsedFolders((current) => new Set([...current].filter((folder) => folder !== newFolderParent)));
            setSidebarGroupName("");
            setAddingGroup(false);
        }
        catch (error) {
            setActionErr(error instanceof Error ? error.message : String(error));
        }
    };
    const startRename = (g: string) => { setRenaming(g); setRenameVal(folderLabel(g)); };
    const remapSelectedFolder = (from: string, to: string) => {
    if (folderScope(folders, from).has(group)) selectFolder(to + group.slice(from.length));
    const next = new Map(groupDisclosure);
    let changed = false;
    for (const [name, collapsed] of groupDisclosure) if (name === from || name.startsWith(from + "/")) {
      next.delete(name); next.set(to + name.slice(from.length), collapsed); changed = true;
    }
    if (changed) saveGroupDisclosure(next);
  };
    const commitFolderMove = async () => {
        if (!movingFolder) return;
        setFolderMoveBusy(true);
        setFolderMoveErr(null);
        try {
            const result = await moveGroup(movingFolder, folderParent);
            if (result.ok === false) throw new Error(result.error || "Move failed");
            remapSelectedFolder(movingFolder, result.folder.name);
            setMovingFolder(null);
            await Promise.all([load(), Promise.resolve()]);
        }
        catch (error) {
            setFolderMoveErr(error instanceof Error ? error.message : String(error));
        }
        finally {
            setFolderMoveBusy(false);
        }
    };
    const commitRename = async () => {
        const from = renaming, to = renameVal.trim();
        setRenaming(null);
        if (!from || !to || to === folderLabel(from)) return;
        setActionErr(null);
        try {
            const r = await renameGroup(from, to);
            if (r.ok === false)
                setActionErr(r.error || "rename failed");
            else {
                remapSelectedFolder(from, r.folder?.name ?? to);
                await Promise.all([load(), Promise.resolve()]);
            }
        }
        catch (e) {
            setActionErr(String(e));
        }
    };
    const removeGroup = async (g: string) => {
        const n = countFor(g);
        const prompt = n
          ? t("Delete group “{group}”? Its {count} profile(s) move to Ungrouped (not deleted).", { group: g, count: n })
          : t("Delete group “{group}”?", { group: g });
        const confirmed = await requestConfirm({
          title: t("Delete group"),
          message: prompt,
          confirmLabel: t("Delete"),
          cancelLabel: t("Cancel"),
          tone: "danger",
        });
        if (!confirmed) return;
        setActionErr(null);
        try {
            const r = await deleteGroup(g);
            if (r.ok === false)
                setActionErr(r.error || t("Delete failed"));
            else {
                if (group === g) setGroup("all");
                await Promise.all([load(), Promise.resolve()]);
            }
        }
        catch (e) {
            setActionErr(e instanceof Error ? e.message : String(e));
        }
    };
    useDesktopCloseDraft("profile-create", { dirty: showCreate && ((Object.keys(BLANK_FORM) as Array<keyof typeof BLANK_FORM>).some(key => form[key] !== initialCreateForm.current[key]) || !!proxyPaste), busy: creating });
    useDesktopCloseDraft("profile-edit", { dirty: !!editId && !!editSnapshot && (PROFILE_EDIT_FORM_FIELDS.some(field => editForm[field] !== editSnapshot.form[field]) || !sameExtensionSelection(editExts, [...editSnapshot.extensions]) || editClearQuarantinedProxy), busy: editSaving || timezoneBusy });
    useDesktopCloseDraft("extension-install", { dirty: !!extSource.trim(), busy: extInstallBusy || extBusy });
    useDesktopCloseDraft("extension-defaults", { dirty: extensionDraftState.dirtyCount > 0, busy: groupDefaultBusy });
    // When receipt lookup stalls, graceful shutdown still waits for admitted backend writers.
    const proxyReceiptUnavailable = workspaceOperationState.operation?.kind === "profile-proxies"
      && (proxyTaskSnapshot?.notice === "status-unavailable" || proxyTaskSnapshot?.notice === "refresh-unavailable");
    useDesktopCloseDraft("workspace-task", { dirty: false, busy: (!!workspaceOperationState.operation && !proxyReceiptUnavailable) || !!workspaceOperationState.workspaceJob || workspaceOperationState.nativeUpdateBusy });
    const rowHandlersRef = useRef<ProfileRosterRowHandlers | null>(null);
    const stableRowHandlers = useMemo<ProfileRosterRowHandlers>(() => ({
        openEdit: (...args) => rowHandlersRef.current!.openEdit(...args),
        openPendingCookies: (...args) => rowHandlersRef.current!.openPendingCookies(...args),
        openCookie: (...args) => rowHandlersRef.current!.openCookie(...args),
        act: (...args) => rowHandlersRef.current!.act(...args),
        openInspection: (...args) => rowHandlersRef.current!.openInspection(...args),
        reuseProfileConfiguration: (...args) => rowHandlersRef.current!.reuseProfileConfiguration(...args),
        openProfileTags: (...args) => rowHandlersRef.current!.openProfileTags(...args),
        copy2fa: (...args) => rowHandlersRef.current!.copy2fa(...args),
        toggleFavorite: (...args) => rowHandlersRef.current!.toggleFavorite(...args),
        changeProfileSelection: (...args) => rowHandlersRef.current!.changeProfileSelection(...args),
        setLaunchFailure: (...args) => rowHandlersRef.current!.setLaunchFailure(...args),
        openNetworkSettings: () => rowHandlersRef.current!.openNetworkSettings(),
        openLogs: () => rowHandlersRef.current!.openLogs(),
    }), []);
    const submitStandaloneAuthToken = (event: React.FormEvent) => {
        event.preventDefault();
        const applied = setStandaloneSessionToken(authTokenInput);
        if (!applied) {
            setAuthTokenErr(t("Paste the session token or tokenized dashboard URL printed by the CLI."));
            return;
        }
        setAuthTokenInput("");
        setAuthTokenErr(null);
        setAuthRequired(false);
        setAppModeErr(null);
        if (!appMode) loadAppMode();
        else void retryConnection();
    };
    if (!appMode)
        return <div className={`desktop-loading-shell${windowChrome.enabled ? " desktop-frameless" : ""}`}><DesktopStartupBar chrome={windowChrome}><MaobuMark />猫步·千境</DesktopStartupBar><WindowActionError chrome={windowChrome} /><main className="onboarding"><section className="onboarding-card"><h1>猫步·千境</h1><p>{effectiveConnErr ?? t("Loading your configuration…")}</p>{authRequired && (<form className="auth-token-form" onSubmit={submitStandaloneAuthToken}><label className="sr-only" htmlFor="standalone-auth-token">{t("Session token")}</label><input id="standalone-auth-token" className="input" type="password" autoComplete="off" value={authTokenInput} onChange={event => setAuthTokenInput(event.target.value)} placeholder={t("Paste token or /?token=… URL")} /><button type="submit" className="btn primary">{t("Unlock dashboard")}</button>{authTokenErr && <p className="field-error" role="alert">{authTokenErr}</p>}</form>)}{effectiveConnErr && <button className="btn" onClick={() => authRequired ? loadAppMode() : window.location.reload()}>{t("Try again")}</button>}</section></main></div>;
    const diagWhen = diag ? new Date(diag.generatedAt).toLocaleTimeString() : null;
    const shownColumns = COLUMNS.filter((column) => columnVisible(column.key));
    const visibleColumnCount = 1 + shownColumns.length;
    // Sum of what is actually on screen: below this the wrapper scrolls rather
    // than letting the browser crush Name down to "mia.h…".
    const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);
    const groupNavigation = (<div className="sidesection group-management">
          <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}>
            <span className={`chev${groupsOpen ? " open" : ""}`}><Icon name="chevronRight" className="sm" /></span>
            <span>{t("Groups")}</span>
            <span className="grow" />
            <span className="cnt">{existingGroups.length}</span>
          </button>
          {groupsOpen && <>
            <div className="folders">
            {existingGroups.length === 0 && <div className="folders-empty">{t("No groups yet")}</div>}
            {tree.filter((folder) => !folder.ancestors.some((name) => collapsedFolders.has(name))).map(({ name: g, label, depth }) => (<div key={g} style={{ paddingLeft: 10 + depth * 16 }} className={`folder${view === "profiles" && group === g ? " active" : ""}`} onClick={() => { if (renaming !== g) selectFolder(g); }}>
                {renaming === g ? (<input className="renameinput" autoFocus value={renameVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }} onBlur={commitRename}/>) : (<>
                    {folders.some((folder) => folder.parentName === g) ? <button className="folder-toggle" type="button" aria-label={t("Expand or collapse {folder}", { folder: g })} aria-expanded={!collapsedFolders.has(g)} onClick={(event) => {
                            event.stopPropagation();
                            setCollapsedFolders((current) => { const next = new Set(current); if (next.has(g)) next.delete(g); else next.add(g); return next; });
                        }}><Icon name={collapsedFolders.has(g) ? "chevronRight" : "chevronDown"} className="sm" /></button> : <Icon name="folder" className="sm" />}
                    <button className="fname folder-select" title={g} onClick={() => selectFolder(g)}>{label ?? g}</button>
                    {(<span className="gactions menuwrap" ref={folderMenu === g ? folderMenuRef : undefined} onClick={(event) => event.stopPropagation()}>
                        <button type="button" title={t("Folder actions")} aria-label={t("Actions for {folder}", { folder: g })} aria-expanded={folderMenu === g} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFolderMenuPosition({ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 230)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)) }); setFolderMenu(folderMenu === g ? null : g); }}><Icon name="more" className="sm" /></button>
                        {folderMenu === g && <span className="popover folder-menu" style={folderMenuPosition} onClick={() => setFolderMenu(null)}>
                          {<>
                            <button className="pop-item" onClick={() => { setNewFolderParent(g); setSidebarGroupName(""); setAddingGroup(true); }}><Icon name="plus" className="sm" />{t("New subfolder")}</button>
                            <button className="pop-item" onClick={() => startRename(g)}><Icon name="edit" className="sm" />{t("Rename")}</button>
                          </>}
                          {<>
                            <button className="pop-item" onClick={() => { setMovingFolder(g); setFolderParent(folders.find((folder) => folder.name === g)?.parentName ?? ""); setFolderMoveErr(null); }}><Icon name="move" className="sm" />{t("Move to…")}</button>
                            <button className="pop-item danger" disabled={folders.some((folder) => folder.parentName === g)} onClick={() => void removeGroup(g)}><Icon name="trash" className="sm" />{t("Delete")}</button>
                          </>}

                        </span>}
                      </span>)}
                    <span className="cnt">{countFor(g)}</span>
                  </>)}
              </div>))}
            </div>
            {addingGroup ? (<div className="newgroup" title={newFolderParent ?? undefined}>
                {newFolderParent && <small>{t("In {folder}", { folder: folderLabel(newFolderParent) })}</small>}
                <input autoFocus aria-label={t("New group name")} value={sidebarGroupName} onChange={(event) => setSidebarGroupName(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") void createSidebarGroup();
                    else if (event.key === "Escape") { setAddingGroup(false); setSidebarGroupName(""); }
                  }}/>
                <button type="button" title={t("Create")} onClick={() => void createSidebarGroup()}><Icon name="check" className="sm" /></button>
                <button type="button" title={t("Cancel")} onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}><Icon name="close" className="sm" /></button>
              </div>) : (<button className="newgroup" type="button" onClick={() => { setNewFolderParent(null); setAddingGroup(true); }}>
                <Icon name="plus" className="sm" />{t("New group")}
              </button>)}
          </>}
        </div>);
    const columnHead = (column: (typeof COLUMNS)[number]) => {
        const label = t(column.label);
        // Every column declares its width, so a wide window's extra space spreads
        // proportionally across all of them — an even layout, no dead gap.
        const style = { width: column.width } as CSSProperties;
        if (!column.sort) return <th key={column.key} className={`col-${column.key}`} style={style}>{label}</th>;
        const key = column.key as SortKey;
        return (<th key={column.key} className={`col-${column.key} sortable${sort.key === key ? " sorted" : ""}`} style={style} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="th-inner" onClick={() => toggleSort(key)}>
          {label}
          <Icon className="sortglyph sm" name={sort.key === key ? (sort.dir === 1 ? "sortUp" : "sortDown") : "sort"} />
        </button>
      </th>);
    };
    const focusProfileSearch = () => { setView("profiles"); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".heading-search input")?.focus()); };
    const openSettingsFromPalette = (tab: SettingsTab) => {
      setSettingsTab(tab);
      setView("settings");
      requestAnimationFrame(() => {
        const target = document.getElementById(`settings-tab-${tab}`);
        if (target?.getAttribute("aria-selected") === "true" && !target.closest("[hidden], [inert]")
          && !readWorkbenchShortcutContext(document.activeElement).modalOpen) target.focus({ preventScroll: true });
      });
    };
    const locateProfile = (id: string) => {
      chooseRosterScope("all"); setGroup("all"); setProfileStatus("all"); setQ(`id:${id}`); setProfilePage(0); setView("profiles");
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find(item => item.dataset.profileId === id);
        (row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? document.getElementById("profiles-page-title"))?.focus({ preventScroll: true });
      });
    };
    const activateSavedViewFromPalette = (id: string) => {
      if (!viewPreferencesReady || viewPreferenceWrite.current || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return;
      const saved = savedProfileViews.find(view => view.id === id);
      if (!saved) return;
      applyProfileView(saved);
      setView("profiles");
      requestAnimationFrame(() => {
        if (workspaceCoordinator.getSnapshot().workspaceId === currentWorkspaceId && !readWorkbenchShortcutContext(document.activeElement).modalOpen) {
          document.getElementById("profiles-page-title")?.focus({ preventScroll: true });
        }
      });
    };
    const openProfileTags = (profile: UiProfile) => {
      if (busy[profile.id]) return;
      const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find(item => item.dataset.profileId === profile.id);
      tagsReturnFocus.current = row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ?? null;
      setTagsTarget({ id: profile.id, name: profile.name, tags: [...profile.tags] });
    };
    const saveProfileTags = async (id: string, tags: string[]): Promise<boolean> => {
      const result = await updateProfile(id, profileTagsUpdate(tags));
      if (result?.ok !== true) return false;
      if (!bulkOwnerActive.current) return false;
      await load();
      return true;
    };
    shortcutAction.current = action => {
      switch (action) {
        case "toggle-command-palette": setCommandOpen(open => !open); break;
        case "focus-profile-search": focusProfileSearch(); break;
        case "open-shortcut-help": setShortcutHelpOpen(true); break;
        case "create-profile": openCreate(); break;
        case "go-profiles": chooseRosterScope("all"); selectFolder("all"); break;
        case "go-proxies": setView("proxies"); break;
        case "go-scripts": setView("scripts"); break;
        case "go-assistant": setView("assistant"); break;
        case "go-extensions": openExtensions(); break;
      }
    };
    const showMoveTask = () => {
      setView("profiles");
      requestAnimationFrame(() => { moveTaskPanelRef.current?.focus({ preventScroll: true }); moveTaskPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); });
    };
    const showTrashTask = () => {
      setView("trash");
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(".trash-task-panel h3") ?? document.getElementById("trash-page-title");
        target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
    };
    const showProxyTask = () => {
      if (!currentWorkspaceId || workspaceCoordinator.getSnapshot().workspaceId !== currentWorkspaceId) return;
      setProxyTaskFocusRequest({ workspaceId: currentWorkspaceId });
      setView("proxies");
    };
    const activityItems: WorkbenchActivityItem[] = [];
    if (runtimeDownloads.length > 0) activityItems.push({ id: "browser-downloads", title: t("Browser downloads"),
      description: runtimeDownloadsStale ? t("Download status temporarily unavailable") : runtimeDownloadLabel(runtimeDownloads, t),
      state: runtimeDownloadsStale ? "attention" : "running", onView: viewRuntimeDownloads });
    if (scriptBackground.run) activityItems.push({ id: "script", title: t("Script run"), description: scriptBackground.run.scriptName,
      state: scriptBackground.state === "unavailable" ? "attention" : scriptBackground.state !== "finished" ? "running" : scriptBackground.summary.failed ? "attention" : "complete",
      progress: { done: scriptBackground.summary.settled, total: scriptBackground.summary.total }, onView: () => setScriptRunOpen(true) });
    if (bulkTaskSnapshot) activityItems.push({ id: "batch", title: t("Batch task"),
      state: bulkTaskActive || bulkTaskRefreshing ? "running" : bulkTaskSnapshot.summary.failed ? "attention" : "complete",
      progress: { done: bulkTaskSnapshot.summary.settled, total: bulkTaskSnapshot.summary.total }, onView: showBulkTask });
    rowHandlersRef.current = {
        openEdit,
        openPendingCookies,
        openCookie,
        act,
        openInspection,
        reuseProfileConfiguration,
        openProfileTags,
        copy2fa,
        toggleFavorite,
        changeProfileSelection,
        setLaunchFailure,
        openNetworkSettings: () => { setSettingsTab("network"); openSettings(); },
        openLogs: () => {
            setLogErr(null);
            void fetchLogs().then(setLogView).catch(error => setLogErr(error instanceof Error ? error.message : String(error)));
        },
    };
    if (importBusy || importReceipt) activityItems.push({ id: "import", title: t("Import profiles"),
      state: importBusy || importReceiptRefreshing ? "running" : importReceipt && (importReceipt.skipped || importReceipt.issues.length) ? "attention" : "complete", onView: showImportReceipt });
    if (cookieImport.snapshot.phase !== "idle") activityItems.push({ id: "cookies", title: t("Cookie import"),
      state: cookieImportBusy ? "running" : cookieImport.snapshot.summary.failed || cookieImport.snapshot.summary.unconfirmed || cookieImport.snapshot.refreshFailed ? "attention" : "complete",
      progress: { done: cookieImport.snapshot.summary.succeeded + cookieImport.snapshot.summary.failed + cookieImport.snapshot.summary.unconfirmed, total: cookieImport.snapshot.summary.total }, onView: showCookieImportTask });
    if (fileUpdateBusy || fileUpdate.snapshot.latest) activityItems.push({ id: "file-update", title: t("Update profiles from file"),
      state: fileUpdateBusy ? "running" : fileUpdate.snapshot.latest?.status === "saved" && !fileUpdate.snapshot.latest.refreshFailed ? "complete" : "attention", onView: showFileUpdateResult });
    if (profileMove.state.attempt || profileMove.state.blockedReason) activityItems.push({ id: "move", title: t("Move environments"),
      state: profileMove.busy ? "running" : profileMove.state.result?.status === "confirmed" ? "complete" : "attention", onView: showMoveTask });
    if (trashTaskSnapshot && (trashTaskSnapshot.phase !== "idle" || trashTaskSnapshot.blockedReason)) activityItems.push({ id: "trash", title: t("Trash operation"),
      state: ["confirming", "sending", "refreshing"].includes(trashTaskSnapshot.phase) ? "running" : trashTaskSnapshot.receipt?.status === "complete" && !trashTaskSnapshot.receipt.refreshFailed && !trashTaskSnapshot.blockedReason ? "complete" : "attention", onView: showTrashTask });
    const proxyReceipt = proxyTaskSnapshot?.latest ?? proxyTaskSnapshot?.history.at(-1);
    if (proxyTaskSnapshot && (proxyTaskSnapshot.busy || proxyTaskSnapshot.notice || proxyReceipt)) {
      const { phase, busy, notice } = proxyTaskSnapshot;
      const summary = proxyReceipt?.summary;
      const receiptNeedsAttention = !!proxyReceipt?.refreshFailed || !!(summary && (summary.failed || summary.skipped || summary.missing || summary.unknown || summary.notStarted));
      const waitingForRecovery = phase === "reconciling" || notice === "refresh-unavailable";
      const state = waitingForRecovery ? "attention" : busy ? "running" : notice || receiptNeedsAttention ? "attention" : "complete";
      activityItems.push({ id: "proxies", title: t("Proxy assignment"), state, onView: showProxyTask });
    }
    const paletteCommands: CommandPaletteCommand[] = [
      { id: "profiles", label: "Profiles", keywords: ["环境", "列表", "roster"], run: () => setView("profiles") },
      { id: "new-profile", label: "New Profile", keywords: ["创建", "新建", "create"], run: openCreate },
      { id: "import", label: "Import profiles", keywords: ["导入", "adspower", "csv", "xlsx"], run: openBulk },
      { id: "search", label: "Search profiles", keywords: ["搜索", "查找", "find"], run: focusProfileSearch },
      { id: "shortcuts", label: "Keyboard shortcuts", keywords: ["快捷键", "键盘", "帮助", "keyboard", "help"], run: () => setShortcutHelpOpen(true) },
      { id: "refresh", label: "Refresh profiles", keywords: ["刷新", "reload"], disabled: refreshing, run: () => { void refreshRoster(); } },
      { id: "proxies", label: "Proxies", keywords: ["网络", "代理", "proxy"], run: () => setView("proxies") },
      { id: "scripts", label: "Scripts", keywords: ["脚本", "自动化", "automation"], run: () => setView("scripts") },
      { id: "assistant", label: "AI workspace", keywords: ["AI", "助手", "模型", "智能体", "聊天", "Ollama"], run: () => setView("assistant") },
      { id: "extensions", label: "Manage extensions", keywords: ["扩展", "插件", "extension"], run: openExtensions },
      { id: "workspaces", label: "Workspace management", keywords: ["工作区", "备份", "backup"], run: () => openWorkspaceManagement({ mode: "manage" }) },
      { id: "trash", label: "Trash", keywords: ["回收站", "恢复", "restore"], run: () => setView("trash") },
      ...SETTINGS_TABS.map(tab => ({ id: `settings-${tab.key}`, label: tab.key === "account" ? "Settings" : tab.label, keywords: ["设置", "settings"], run: () => openSettingsFromPalette(tab.key) })),
    ];
    return (<>
    {confirmDialogNode}
    <CommandPalette commands={paletteCommands} profiles={profiles} favoriteIds={favoriteProfileIds} onLocateProfile={locateProfile}
      savedViews={paletteSavedViews} savedViewsState={viewPreferencesReady ? "ready" : viewPreferenceReadError || workspaceCatalogError ? "unavailable" : "loading"}
      savedViewsLocked={viewPreferenceBusy} onApplySavedView={activateSavedViewFromPalette} open={commandOpen} onClose={() => setCommandOpen(false)} />
    <ShortcutHelp open={shortcutHelpOpen} desktop={!!desktopInvoke()} onClose={() => setShortcutHelpOpen(false)} onAction={action => shortcutAction.current(action)} returnFocus={() => document.querySelector<HTMLButtonElement>(".shortcut-help-trigger") ?? document.querySelector<HTMLButtonElement>(".command-palette-trigger")} />
    <ProfileTagsDialog target={tagsTarget} sessionKey={catalog?.currentId} onSave={saveProfileTags} onClose={() => setTagsTarget(null)} returnFocus={() => tagsReturnFocus.current?.isConnected ? tagsReturnFocus.current : document.getElementById("profiles-page-title")} />
    <WindowActionError chrome={windowChrome} />
    {createCloseGuard.dialog}{editCloseGuard.dialog}
    <div data-roster-density={rosterDensity} className={`app airy-workbench folded-workbench${windowChrome.enabled ? " desktop-frameless" : ""}${windowChrome.enabled && !windowChrome.focused ? " is-window-unfocused" : ""}`} onDragOver={(e) => { if (!Array.from(e.dataTransfer.types).includes("Files") || e.defaultPrevented || readWorkbenchShortcutContext(e.target).modalOpen) return; e.preventDefault(); if (!dragging) setDragging(true); }} onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragging(false); }} onDrop={(e) => {
            const handled = e.defaultPrevented || readWorkbenchShortcutContext(e.target).modalOpen;
            e.preventDefault();
            setDragging(false);
            if (handled) return;
            if (e.dataTransfer.files?.length) doUpload(e.dataTransfer.files);
        }}>
      {dragging && (<div className="dropzone">
          <Icon name="fileImport" />
          <span>{t("Drop TXT, CSV, JSON, or XLSX profile exports to import")}</span>
        </div>)}

      <aside className={`sidebar${sidebarIsCompact ? " collapsed" : ""}`}>
        <div className="rail-heading">
          <span className="rail-section-label" aria-hidden="true">{t("Workspaces")}</span>
          {!railForced && <button type="button" className="rail-toggle" data-tip={sidebarCollapsed ? t("Expand sidebar") : t("Collapse sidebar")} aria-label={sidebarCollapsed ? t("Expand sidebar") : t("Collapse sidebar")} title={sidebarCollapsed ? t("Expand sidebar") : t("Collapse sidebar")} aria-controls="workspace-navigation" aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}>
            <Icon name={sidebarCollapsed ? "expandRail" : "collapseRail"} />
          </button>}
        </div>
        <WorkspaceSwitcher
          variant="rail"
          compact={sidebarIsCompact}
          profileCount={profiles.length}
          runningCount={runningCount}
          connection={loaded && !connErr}
          onShowRunning={showRunningProfiles}
          onOpenManagement={openWorkspaceManagement}
          onShowBatchTask={showBulkTask}
          managementActive={view === "workspaces"}
        />
        <nav id="workspace-navigation" className="sidenav" ref={navigationMotion.navRef} aria-label={t("Workspace navigation")}>
          <span className="rail-active-marker" aria-hidden="true" />
          <div className="rail-nav-group" role="group" aria-label={t("Workspace")}>
            <button type="button" className={`navitem${view === "profiles" || view === "inspection" ? " active" : ""}`} aria-current={view === "profiles" || view === "inspection" ? "page" : undefined} aria-label={t("All profiles")} data-tip={t("All profiles")} title={t("All profiles")} onClick={() => { chooseRosterScope("all"); selectFolder("all"); }}>
              <Icon name="profiles" /><span className="navlabel">{t("All profiles")}</span>
              {loaded && profiles.length > 0 && <span className="cnt" aria-hidden="true">{profiles.length}</span>}
            </button>
            <button type="button" className={`navitem${view === "proxies" ? " active" : ""}`} aria-current={view === "proxies" ? "page" : undefined} aria-label={t("Proxies")} data-tip={t("Proxies")} title={t("Proxies")} onClick={() => setView("proxies")}>
              <Icon name="activity" /><span className="navlabel">{t("Proxies")}</span>
            </button>
          </div>
          <div className="rail-nav-group rail-nav-tools" role="group" aria-label={t("Tools")}>
            <span className="rail-section-label" aria-hidden="true">{t("Tools")}</span>
            <button type="button" className={`navitem${view === "scripts" ? " active" : ""}`} aria-current={view === "scripts" ? "page" : undefined} aria-label={t("Scripts")} data-tip={t("Scripts")} title={t("Scripts")} onClick={() => setView("scripts")}>
              <Icon name="file" /><span className="navlabel">{t("Scripts")}</span>
            </button>
            <button type="button" className={`navitem${view === "assistant" ? " active" : ""}`} aria-current={view === "assistant" ? "page" : undefined} aria-label={t("AI workspace")} data-tip={t("AI workspace")} title={t("AI workspace")} onClick={() => setView("assistant")}>
              <Icon name="bot" /><span className="navlabel">{t("AI workspace")}</span>
            </button>
            <button type="button" className={`navitem${view === "extensions" ? " active" : ""}`} aria-current={view === "extensions" ? "page" : undefined} aria-label={t("Manage extensions")} data-tip={t("Manage extensions")} title={t("Manage extensions")} onClick={openExtensions}>
              <Icon name="puzzle" /><span className="navlabel">{t("Manage extensions")}</span>
              {extensions.length > 0 && <span className="cnt" aria-hidden="true">{extensions.length}</span>}
            </button>
          </div>
        </nav>
        <div className="sidefoot">
          <div className="rail-utilities" role="group" aria-label={t("Management")}>
            <button type="button" className={`navitem${view === "trash" ? " active" : ""}`} aria-current={view === "trash" ? "page" : undefined} aria-label={t("Trash")} data-tip={t("Trash")} title={t("Trash")} onClick={() => setView("trash")}>
              <Icon name="trash" /><span className="navlabel">{t("Trash")}</span>
            </button>
            <button type="button" className={`navitem${view === "settings" ? " active" : ""}`} aria-current={view === "settings" ? "page" : undefined} aria-label={t("Settings")} data-tip={t("Settings")} title={t("Settings")} onClick={openSettings}>
              <Icon name="settings" /><span className="navlabel">{t("Settings")}</span>
            </button>
          </div>
          <DevicePanel variant="rail" runningCount={runningCount} downloads={runtimeDownloads} downloadStatusUnavailable={runtimeDownloadsStale} connection={loaded && !connErr} connectionLoading={!loaded} version={appVersion ?? ""} theme={theme} chooseTheme={chooseTheme} language={language} setLanguage={setLanguage} onShowRunning={showRunningProfiles} onSettings={(section) => { setSettingsTab(section === "advanced" ? "advanced" : "account"); setView("settings"); }} onViewLogs={() => { setLogErr(null); fetchLogs().then(setLogView).catch((error) => setLogErr(error instanceof Error ? error.message : String(error))); }} onRetryConnection={refreshRoster} />
        </div>
        {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
      </aside>

      <div className="main">
      <header className="workspace-header" onMouseDown={windowChrome.onMouseDown}>
        <button
          ref={aboutTriggerRef}
          type="button"
          className={`desktop-brand${aboutOpen ? " is-open" : ""}`}
          data-no-drag
          aria-haspopup="dialog"
          aria-expanded={aboutOpen}
          aria-controls={aboutOpen ? "about-popover-dialog" : undefined}
          aria-label={hasUpdateNotice ? `${t("About {app}", { app: "猫步·千境" })} · ${t("Update available")}` : t("About {app}", { app: "猫步·千境" })}
          title={t("About {app}", { app: "猫步·千境" })}
          onClick={() => setAboutOpen((open) => !open)}
        >
          <MaobuMark />
          <strong>猫步·千境</strong>
          {sidebarIsCompact && savedWorkspaceName && <span className="desktop-workspace-name" title={savedWorkspaceName}>{savedWorkspaceName}</span>}
          {appVersion && <span className="appversion" title={appVersion}>{appVersion}</span>}
          {hasUpdateNotice && <span className="desktop-brand-dot" data-update-available="true" aria-hidden="true" />}
        </button>
        <div className="topbar-actions">
          <WorkbenchActivity items={activityItems} />
          <button type="button" className="command-palette-trigger" aria-label={t("Command palette")} title={t("Command palette")} aria-haspopup="dialog" aria-expanded={commandOpen} onClick={() => setCommandOpen(true)}><Icon name="search" className="sm" /><span>{t("Command palette")}</span><kbd>{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘ K" : "Ctrl K"}</kbd></button>
          <button type="button" className="iconbtn tip shortcut-help-trigger" data-tip={`${t("Keyboard shortcuts")} · ?`} aria-label={t("Keyboard shortcuts")} aria-haspopup="dialog" aria-expanded={shortcutHelpOpen} onClick={() => setShortcutHelpOpen(true)}><Icon name="help" /></button>
          <button type="button" className="iconbtn tip topbar-settings" data-tip={t("Settings")} aria-label={t("Settings")} onClick={openSettings}><Icon name="settings" /></button>
          <WindowControls chrome={windowChrome} />
        </div>
      </header>
      <AboutPopover
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        anchorRef={aboutTriggerRef}
        appVersion={appVersion}
        signedUpdateStartup={signedUpdateStartup}
        dialogId="about-popover-dialog"
        onOpenUpdateSettings={() => {
          setAboutOpen(false);
          if (view === "settings" && settingsTab === "updates") {
            if (settingsPanelRef.current) settingsPanelRef.current.scrollTop = 0;
            updateTabRef.current?.focus({ preventScroll: true });
          } else {
            focusUpdateTabOnOpen.current = true;
            setSettingsTab("updates");
            setView("settings");
          }
        }}
        onGithubUpdateResult={(result) => setGithubUpdateAvailable(result?.status === "available")}
      />
      <div className="workspace-content" ref={navigationMotion.contentRef} role="main" aria-label={t(PAGE_TITLES[view])}>
      <ErrorBoundary scope={t(PAGE_TITLES[view])} resetKeys={[view, currentWorkspaceId]}>
      <WorkspaceActivity hidden={view === "workspaces"} onOpen={() => openWorkspaceManagement({ mode: "backups" })} />
      {signedUpdateStartup.noticeVersion && <div className="update-banner signed-update-notice">
        <Icon name="refresh" className="sm" />
        <span role="status">{t("Signed desktop update {version} is available.", { version: signedUpdateStartup.noticeVersion })}</span>
        <button className="btn xs" type="button" onClick={viewSignedUpdate}>{t("View update")}</button>
        <button className="update-result-dismiss" type="button" aria-label={t("Dismiss")} onClick={signedUpdateStartup.dismissNotice}><Icon name="close" className="sm" /></button>
      </div>}
      {(actionErr ?? (!connectionAlertDismissed ? effectiveConnErr : null)) && (<div className="error" role="alert">
          <Icon name="alert" />
          <span>{t(actionErr ?? effectiveConnErr ?? "")}</span>
          {authRequired && (
            <form className="auth-token-form inline" onSubmit={submitStandaloneAuthToken}>
              <label className="sr-only" htmlFor="standalone-banner-auth-token">{t("Session token")}</label>
              <input id="standalone-banner-auth-token" className="input" type="password" autoComplete="off" value={authTokenInput} onChange={event => setAuthTokenInput(event.target.value)} placeholder={t("Paste token or /?token=… URL")} />
              <button type="submit" className="btn xs primary">{t("Unlock dashboard")}</button>
              {authTokenErr && <span className="field-error">{authTokenErr}</span>}
            </form>
          )}
          {!actionErr && effectiveConnErr && (
            <button type="button" className="btn xs ghost" disabled={refreshing} onClick={() => void retryConnection()}>{t("Retry")}</button>
          )}
          <button className="dismiss" aria-label={t("Dismiss error")} onClick={() => { setActionErr(null); if (effectiveConnErr) dismissConnectionAlert(); }}><Icon name="close" className="sm" /></button>
        </div>)}
      <MotionPresence present={!!notice} kind="panel">{() => <div className="notice" role="status" onPointerEnter={clearNoticeTimer} onPointerLeave={expireNotice}
        onFocusCapture={clearNoticeTimer} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) expireNotice(); }}>
        <Icon name="check" className="sm" /><span>{notice}</span><button type="button" className="notice-dismiss" aria-label={t("Dismiss")} onClick={() => { clearNoticeTimer(); setNotice(null); }}><Icon name="close" className="sm" /></button>
      </div>}</MotionPresence>
      {exportProgress && (<div className="notice" role="status"><Icon name="export" className="sm" />{exportProgress.completed >= exportProgress.total ? t("Building export file…") : t("Preparing export: {completed} / {total} profiles", { completed: exportProgress.completed.toLocaleString(), total: exportProgress.total.toLocaleString() })}</div>)}
      {diskSpace?.low && diskSpace.freeBytes !== null && !diskWarningDismissed && (<div className="update-banner update-result warning" role="alert">
          <Icon name="warning" />
          <div className="update-copy"><strong>{t("Low disk space: {free} GB free on the drive that holds your profiles.", { free: (diskSpace.freeBytes / 1024 ** 3).toFixed(1) })}</strong><span>{t("When the disk is almost full, browsers delete saved site data, which can log profiles out. Free up space on this drive.")}</span></div>
          <button className="update-result-dismiss" type="button" aria-label={t("Dismiss disk space warning")} onClick={() => setDiskWarningDismissed(true)}><Icon name="close" className="sm" /></button>
        </div>)}
      <ProxiesPage key={`proxies-${currentWorkspaceId ?? "loading"}`} active={view === "proxies"} groups={["", ...groups.slice(1)]} folders={folders} profiles={profiles} loadingProfiles={!loaded} onChanged={refreshImportedProfiles}
        onTaskSnapshotChange={publishProxyTask} focusTask={view === "proxies" && proxyTaskFocusRequest !== null && proxyTaskFocusRequest.workspaceId === currentWorkspaceId}
        onTaskFocused={completeProxyTaskFocus} localAssignmentIntent={activeLocalProxyIntent} onDismissLocalAssignmentIntent={dismissLocalProxyAssignment} />
      <LocalAssistantPage active={view === "assistant"} onOpenMcp={() => { setSettingsTab("integrations"); setView("settings"); }} onOpenModelServices={() => openSettingsFromPalette("models")}
        draftSuggestion={assistantDraftSuggestion} onDismissDraftSuggestion={id => setAssistantDraftSuggestion(current => current?.id === id ? null : current)}
        onReturnToTask={source => { if (source.returnKey) { setInspectionId(source.returnKey); setView("inspection"); } }} />
      <EnvironmentInspectionPage active={view === "inspection"} profile={inspectionId ? profilesById.get(inspectionId) ?? null : null}
        refreshVersion={fingerprintRefreshVersion} onBack={backFromInspection} onEditProfile={(id, field, trigger) => { if (!editSessionRef.current) openEdit(id, field, trigger); }} onExplainFingerprint={explainFingerprint} />
      <TrashPage key={`trash-${currentWorkspaceId ?? "loading"}`} active={view === "trash"} onChanged={refreshImportedProfiles} folderTree={folders}
        onTaskSnapshotChange={snapshot => setTrashTaskState({ workspaceId: currentWorkspaceId, snapshot })}/>
      <WorkspaceManagementPage key="local-workspaces" active={view === "workspaces"} request={workspacePageRequest} onBack={() => setView("profiles")} onShowRunning={showRunningProfiles} onShowBatchTask={showBulkTask} />
      {view === "profiles" ? (<div className="workspace profiles-workspace">
        {reuseRequest && <div className={`update-banner update-result${reuseRequest.status === "failed" ? " warning" : ""}`} role={reuseRequest.status === "failed" ? "alert" : "status"} aria-busy={reuseRequest.status === "loading"}>
          <Icon name={reuseRequest.status === "loading" ? "copy" : "alert"} className="sm" />
          <span>{reuseRequest.status === "loading" ? t("Preparing a new draft from {profile}…", { profile: reuseRequest.name || reuseRequest.id }) : t(reuseRequest.error || "The source configuration could not be loaded.")}</span>
          {reuseRequest.status === "failed" && <button type="button" className="btn xs" onClick={() => void reuseProfileConfiguration(reuseRequest.id, reuseRequest.name)}>{t("Retry")}</button>}
          <button type="button" className="btn xs ghost" onClick={cancelReuseRead}>{t(reuseRequest.status === "loading" ? "Cancel" : "Dismiss")}</button>
        </div>}
        <div className="page-heading">
          <div className="profile-heading-copy"><h1 id="profiles-page-title" tabIndex={-1}>{t("Environments")}</h1><span className="profile-total">{t("{count} environments", { count: profiles.length })}</span></div>
          <div className="searchfield heading-search"><Icon name="search" className="sm" /><input className="input search" placeholder={t("Search name, No., tag or proxy…")} aria-label={t("Search profiles")} value={q} onChange={(e) => setQ(e.target.value)} />{q && <button type="button" className="clear" aria-label={t("Clear search")} onClick={() => setQ("")}><Icon name="close" className="sm" /></button>}</div>
          <div className="page-actions">
          <button className="btn" title={t("Import profiles from AdsPower, GoLogin, Multilogin, Donut, and other readable exports")} onClick={openBulk}><Icon name="fileImport" className="sm" />{t("Import profiles")}</button>
          <button className="btn primary" onClick={openCreate}><Icon name="plus" className="sm" />{t("New Profile")}</button>
        </div>
        </div>
        <RosterViews current={{ scope: rosterScope, query: q, group, status: profileStatus, sort, hiddenColumns: [...hiddenCols], pageSize }}
          views={viewPreferencesReady ? savedProfileViews : []} counts={rosterViewCounts}
          ready={viewPreferencesReady} loading={viewPreferencesLoading} readError={viewPreferenceReadError} busy={viewPreferenceBusy} onRetry={() => setPreferenceLoadAttempt(value => value + 1)}
          onScope={chooseRosterScope} onApply={applyProfileView} onSave={saveProfileView} onRemove={removeProfileView} />
        {!!breadcrumb?.ancestors.length && <nav className="folder-breadcrumb" aria-label={t("Folder path")}><button className="btn ghost xs" onClick={() => selectFolder("all")}>{t("All profiles")}</button>{breadcrumb.ancestors.map(name => <span key={name}> / <button className="btn ghost xs" onClick={() => selectFolder(name)}>{folderLabel(name)}</button></span>)}<span aria-current="location"> / {folderLabel(group)}</span></nav>}
        <div className="profile-filter-row">
          <select className="select group-filter" aria-label={t("Group filter")} value={group} onChange={event => selectFolder(event.target.value)}>
            <option value="all">{t("All groups")} · {profiles.length}</option>
            <option value="">{t("Ungrouped")} · {countFor("")}</option>
            {missingRosterGroup && <option value={missingRosterGroup}>{t("Unavailable · {group}", { group: missingRosterGroup })}</option>}
            {tree.map(folder => <option key={folder.name} value={folder.name}>{[...folder.ancestors, folder.name].map(folderLabel).join(" / ")} · {countFor(folder.name)}</option>)}
          </select>
          <div className="profile-status-filter"><div className="profile-status-tabs" role="group" aria-label={t("Filter by status")}>
          <button type="button" className={profileStatus === "all" ? "active" : ""} aria-pressed={profileStatus === "all"} onClick={() => setProfileStatus("all")}>{t("All environments")}<span>{matchingProfiles.length}</span></button>
          <button type="button" className={profileStatus === "running" ? "active" : ""} aria-pressed={profileStatus === "running"} onClick={() => setProfileStatus("running")}>{t("Running")}<span>{matchingRunningCount}</span></button>
          <button type="button" className={profileStatus === "stopped" ? "active" : ""} aria-pressed={profileStatus === "stopped"} onClick={() => setProfileStatus("stopped")}>{t("Stopped")}<span>{matchingProfiles.length - matchingRunningCount}</span></button>
        </div></div>
          <div className="profile-view-tools">
            <div className="headactions">
          <RosterDensityControl value={rosterDensity} onChange={value => void chooseRosterDensity(value)} disabled={!viewPreferencesReady} busy={viewPreferenceBusy} />
          <button
            type="button"
            className="iconbtn tip"
            data-tip={t("Refresh")}
            aria-label={t("Refresh profiles")}
            disabled={refreshing}
            onClick={() => void refreshRoster()}
          ><Icon name="refresh" /></button>
          <div className="menuwrap" ref={colsRef}>
            <button
              type="button"
              className={`iconbtn tip${colsOpen ? " on" : ""}`}
              data-tip={t("Columns")}
              aria-label={t("Choose visible columns")}
              onClick={() => setColsOpen((o) => !o)}
            ><Icon name="columns" /></button>
            {colsOpen && (<div className="popover below-right">
                <div className="pop-head">{t("Visible columns")}</div>
                {COLUMNS.map((column) => (<label className="pop-item" key={column.key}>
                    <input type="checkbox" checked={columnVisible(column.key)} onChange={() => toggleColumn(column.key)} />
                    {t(column.label)}
                  </label>))}
              </div>)}
          </div>
          </div>
            <div className="profile-group-manager menuwrap" ref={groupManagerRef}>
              <button type="button" className={`iconbtn tip${groupManagerOpen ? " on" : ""}`} aria-label={t("Manage groups")} data-tip={t("Manage groups")} aria-expanded={groupManagerOpen} onClick={() => setGroupManagerOpen(open => !open)}><Icon name="folders" /></button>
              {groupManagerOpen && <div className="popover group-manager-panel"><div className="pop-head">{t("Manage groups")}</div>{groupNavigation}</div>}
            </div>
          </div>
        </div>
        {runtimeDownloads.length > 0 && (runtimeDownloadsStale ? <div className="update-progress" role="status">{t("Download status temporarily unavailable")}</div> : <RuntimeDownloadProgressView downloads={runtimeDownloads} />)}
        {importBusy && <div className="import-task-indicator" role="status"><Icon name="refresh" className="sm" /><span>{t("Importing environments…")}</span></div>}
        {importReceipt && <ImportReceiptPanel receipt={importReceipt} expanded={importReceiptExpanded} refreshing={importReceiptRefreshing} onExpandedChange={setImportReceiptExpanded} onBrowseAll={() => { setSelected(new Set()); chooseRosterScope("all"); selectFolder("all"); }} onViewAttention={() => { setSelected(new Set()); chooseRosterScope("attention"); selectFolder("all"); }} onDismiss={() => { if (!importReceiptRefreshing) { setImportReceipt(null); setImportReceiptExpanded(false); } }} />}
        {!cookieTargets && cookieImport.snapshot.phase !== "idle" && <div ref={cookieTaskPanelRef} tabIndex={-1} className="cookie-import-result-anchor"><CookieImportTaskPanel snapshot={cookieImport.snapshot} onRetryFailed={() => { void cookieImport.task.retryFailed(); }} onDismiss={() => { cookieImport.task.dismiss(); }} /></div>}
        {!showUpdate && (fileUpdateBusy || fileUpdate.snapshot.latest) && <div ref={fileUpdatePanelRef} tabIndex={-1} className="profile-file-update-result-anchor"><ProfileFileUpdatePanel snapshot={fileUpdate.snapshot} onChooseFile={openUpdate} onBrowseProfiles={() => { setSelected(new Set()); chooseRosterScope("all"); selectFolder("all"); }} onDismiss={() => { fileUpdate.task.dismissResults(); }} /></div>}
        <div ref={moveTaskPanelRef} tabIndex={-1} className="profile-move-result-anchor"><ProfileMoveFeedback state={profileMove.state} onRetry={() => void runMoveAction(profileMove.retry)} onRecheck={() => void runMoveAction(profileMove.recheck)} onDismiss={profileMove.dismiss} /></div>
        {bulkTaskSnapshot && <BulkProfileTaskPanel snapshot={bulkTaskSnapshot} expanded={bulkTaskExpanded} refreshing={bulkTaskRefreshing} onExpandedChange={setBulkTaskExpanded} onStopPending={() => bulkTaskRef.current?.stopPending()} onRetryFailed={retryBulkFailures} onDismiss={dismissBulkTask} />}


        {filtered.length > 0 && selected.size > 0 && (<div className="toolbar" role="status">
            <button type="button" className="btn" disabled={deleting || allFilteredSelected} onClick={() => { rangeSelectionAnchor.current = null; selectAllFiltered(); }}>
              {allFilteredSelected ? t("All {scope} selected", { scope: selectionScope }) : t("Select all {scope}", { scope: selectionScope })}
            </button>
            <span className="muted">{deleting ? t("Moving selected profiles…") : t("Across all pages")}</span>
            {!allFilteredSelected && selectedOutsideFilter > 0 && <span className="muted">{t("This replaces your selection, excluding {count} outside this view.", { count: selectedOutsideFilter })}</span>}
          </div>)}

        {/* Copy sits inside the field rather than beside it: a separate bordered
          button per credential turned the dialog into a grid of grey boxes. */}
        {selected.size > 0 && (<div className="toolbar active">
          <span className="selcount">
            <Icon name="check" className="sm" />
            {t("{count} selected", { count: selected.size })}
          </span>
          <button type="button" className="btn ghost" aria-label={t("Clear selection")} onClick={() => { rangeSelectionAnchor.current = null; setSelected(new Set()); }}>{t("Clear selection")}</button>
          <button className="btn primary tip" data-tip={t(workspaceOperationState.blocked ? workspaceOperationMessage(workspaceOperationState) : "Open selected browsers")} disabled={!selected.size || bulkTaskActive || bulkTaskRefreshing || workspaceOperationState.blocked} onClick={openSelected}>
            <Icon name="play" className="sm" />{t("Start")}
          </button>
          <button className="btn solid-danger tip" data-tip={t(workspaceOperationState.blocked ? workspaceOperationMessage(workspaceOperationState) : "Close selected browsers")} disabled={!selected.size || bulkTaskActive || bulkTaskRefreshing || workspaceOperationState.blocked} onClick={closeSelected}>
            <Icon name="power" className="sm" />{t("Stop")}
          </button>
          <button type="button" className="btn ghost bulk-tools-toggle" aria-expanded={bulkToolsOpen} onClick={() => setBulkToolsOpen(open => !open)}>{t(bulkToolsOpen ? "Fewer actions" : "More actions")}<Icon name={bulkToolsOpen ? "chevronUp" : "chevronDown"} className="sm" /></button>
          <div className="bulk-advanced" hidden={!bulkToolsOpen}>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setScriptRunProfiles(profiles.filter((profile) => selected.has(profile.id)));
              setScriptRunOpen(true);
            }}
          ><Icon name="play" className="sm" />{t("Run script")}</button>
          <button
            className="btn tip"
            type="button"
            data-tip={t("Open browsers get the cookies now; closed profiles at their next start")}
            onClick={() => openCookie(profiles.filter((profile) => selected.has(profile.id)))}
          ><Icon name="cookie" className="sm" />{t("Add cookies")}</button>
          <span className="vsep" />
          {selectedMobileCount > 0 && (<button className="btn warn" onClick={convertSelectedMobile}>
              <Icon name="laptop" className="sm" />{t("Convert mobile ({count})", { count: selectedMobileCount })}
            </button>)}
          <div className="menuwrap" ref={exportRef}>
            <button className="btn tip" data-tip={t("Export selected profiles")} disabled={!selected.size || !!exportProgress} onClick={() => setExportOpen((o) => !o)}>
              <Icon name="export" className="sm" />{t("Export")}<Icon name="chevronDown" className="sm" />
            </button>
            {exportOpen && selected.size > 0 && !exportProgress && (<div className="exportmenu popover below-left" onMouseLeave={() => setExportOpen(false)}>
                <button className="pop-item" onClick={() => exportSelected("csv")}><Icon name="file" className="sm" />{t("Export as CSV (credentials)")}</button>
                <button className="pop-item" onClick={() => exportSelected("txt")}><Icon name="file" className="sm" />{t("Export as .txt (full profile)")}</button>
                <button className="pop-item" onClick={() => exportSelected("xlsx")}><Icon name="file" className="sm" />{t("Export as Excel (full profile)")}</button>
              </div>)}
          </div>
          <button className="btn tip" data-tip={t("Export → edit → re-upload")} disabled={!selected.size || !!exportProgress} onClick={openUpdate} title={t("Export → edit → re-upload to change credentials in bulk")}>
            <Icon name="edit" className="sm" />{t("Edit from file")}
          </button>
          <span className="vsep" />
          <div className="movewrap">
            {newMode ? (<input className="input" autoFocus placeholder={t("new group name")} value={newGroup} disabled={profileMove.busy} onChange={(e) => { if (moveUiInFlight.current) return; moveDraftRevision.current++; setNewGroup(e.target.value); }} />) : (<select className="select move-group" aria-label={t("Move to group")} title={moveTarget === null ? t("Choose destination group") : moveTarget || t("Ungrouped")} disabled={!selected.size || profileMove.busy} value={moveTarget === null ? "choose" : `group:${moveTarget}`} onChange={(e) => { if (moveUiInFlight.current) return; moveDraftRevision.current++; if (e.target.value === "new") setNewMode(true); else if (e.target.value.startsWith("group:")) setMoveTarget(e.target.value.slice(6)); else setMoveTarget(null); }}>
                <option value="choose">{t("Move to…")}</option>
                <option value="group:">{t("Ungrouped")}</option>
                {existingGroups.map((g) => (<option key={g} value={`group:${g}`}>{g}</option>))}
                <option value="new">{t("+ new group…")}</option>
              </select>)}
            {newMode && (<button className="btn ghost" disabled={profileMove.busy} onClick={() => { if (moveUiInFlight.current) return; moveDraftRevision.current++; setNewMode(false); setNewGroup(""); }}>{t("cancel")}</button>)}
            <button className="btn accent" disabled={!selected.size || profileMove.busy || workspaceOperationState.blocked || (newMode ? !newGroup.trim() : moveTarget === null)} onClick={moveSelected}>
              <Icon name="move" className="sm" />{t(profileMove.busy ? "Moving…" : "Move")}
            </button>
          </div>
          {extensions.length > 0 && selectedProfilesSupportChromeExtensions && (<>
              <span className="vsep" />
              <div className="extctl">
                <span className="extctl-lbl"><Icon name="puzzle" className="sm" />{t("Extension")}</span>
                <select className="select extctl-sel" aria-label={t("Extension for bulk assignment")} disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}>
                  <option value="">{t("choose…")}</option>
                  {extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>{t("Add")}</button>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>{t("Remove")}</button>
              </div>
            </>)}
          <span className="spacer" />
          {(<button className="btn danger tip" data-tip={t("Move selected profiles to Trash")} disabled={!selected.size || deleting} onClick={deleteSelected}>
              <Icon name="trash" className="sm" />{deleting ? t("Processing…") : t("Move {count} to Trash", { count: selected.size.toLocaleString() })}
            </button>)}
          </div>
        </div>)}

        <div className={`tablewrap${tableScrolled ? " scrolled" : ""}`} onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}>
          <span id="profile-range-selection-hint" className="sr-only">{t("Hold Shift while changing a checkbox to select or clear a visible range on this page. Shift+Space also works.")}</span>
          <table className="profile-table" aria-busy={!loaded} style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr>
                <th className="chk" style={{ width: CHECKBOX_COLUMN_WIDTH }} title={t("Shift-click to select a range")}>
                  <input type="checkbox" aria-label={t("Select all visible profiles")} checked={allVisibleSelected} disabled={!selectableProfiles.length} onChange={() => { rangeSelectionAnchor.current = null; toggleAll(); }} />
                </th>
                {shownColumns.map(columnHead)}
              </tr>
            </thead>
            <tbody>
              {!loaded && <tr><td colSpan={visibleColumnCount} className="empty"><div className="emptystate" role="status">{t("Loading environments…")}</div></td></tr>}
</tbody>
            {profileSections.map(section => {
              const collapsed = profileGroupCollapsed(section, groupDisclosure, revealGroupMatches);
              const groupName = section.name ? folderLabel(section.name) : t("Ungrouped");
              const selectedInGroup = section.matches.filter(profile => selected.has(profile.id)).length;
              const groupPanelId = `profile-group-${section.orderIndex}`;
              return <React.Fragment key={section.name}>{rosterScope !== "recent" && <tbody className="profile-group-header">
                <tr className="profile-group-row"><td colSpan={visibleColumnCount}><div className="profile-group-heading">
                  <input className="profile-group-check" type="checkbox" aria-label={t("Select all {count} profiles in {group}", { count: section.matches.length, group: groupName })} disabled={!section.matches.length} checked={section.matches.length > 0 && selectedInGroup === section.matches.length} ref={element => { if (element) element.indeterminate = selectedInGroup > 0 && selectedInGroup < section.matches.length; }} onChange={() => { rangeSelectionAnchor.current = null; setSelected(current => toggleProfileSelection(current, section.matches)); }} />
                  <button type="button" className="profile-group-toggle" aria-expanded={!collapsed} aria-controls={groupPanelId} aria-label={t(collapsed ? "Expand {group}" : "Collapse {group}", { group: groupName })} disabled={revealGroupMatches} onClick={() => toggleProfileGroup(section.name, collapsed)}><Icon name={collapsed ? "chevronRight" : "chevronDown"} className="sm" /><span className="profile-group-name" title={section.name}>{groupName}</span><span className="profile-group-count">{t("{count} environments", { count: section.matches.length })}</span><span className="profile-group-running">{t("{count} running", { count: section.running })}</span>{section.profiles.length < section.matches.length && <span className="profile-group-page-hint">{t("{count} on this page", { count: section.profiles.length })}</span>}</button>
                  <button type="button" className="iconbtn tip profile-group-create" data-tip={t("New Profile")} aria-label={t("New profile in {group}", { group: groupName })} onClick={() => { if (!openCreate()) return; setForm(form => ({ ...form, group: section.name })); const next = new Map(groupDisclosure); next.set(section.name, false); saveGroupDisclosure(next); }}><Icon name="plus" className="sm" /></button>
                  <ProfileActionMenu label={t("Actions for {folder}", { folder: groupName })} icon={<Icon name="more" className="sm" />}>
                    <button role="menuitem" className="pop-item" onClick={() => { selectFolder(section.name); setGroupManagerOpen(true); }}><Icon name="folders" className="sm" />{t("Manage groups")}</button>
                    <button role="menuitem" className="pop-item" onClick={() => { setNewFolderParent(section.name || null); setSidebarGroupName(""); setAddingGroup(true); setGroupManagerOpen(true); }}><Icon name="plus" className="sm" />{t("New subfolder")}</button>
                  </ProfileActionMenu>
                </div></td></tr>
              </tbody>}<tbody className="profile-group-body" id={groupPanelId} hidden={collapsed}>
              {!collapsed && section.profiles.map((p) => {
                // The numbering memo covers every roster profile, so this
                // lookup cannot miss; a silent fallback here would renumber
                // rows wrongly if that invariant ever broke.
                const no = numbering.get(p.id)!;
                const launchFailure = p.running ? undefined : launchFailures?.get(p.id);
                return (<ProfileRosterRow
                  key={p.id}
                  p={p}
                  no={no}
                  isSelected={selected.has(p.id)}
                  isBusy={!!busy[p.id]}
                  isFavorite={favoriteProfileIds.has(p.id)}
                  isReuseLoading={reuseRequest?.id === p.id && reuseRequest.status === "loading"}
                  twoFaFlashed={twoFaFlash?.id === p.id}
                  startLabel={openLabel(p)}
                  launchFailure={launchFailure}
                  rosterScope={rosterScope}
                  language={language}
                  hiddenCols={hiddenCols}
                  visibleColumnCount={visibleColumnCount}
                  viewPreferencesReady={viewPreferencesReady}
                  viewPreferenceBusy={viewPreferenceBusy}
                  rangeKeyboardActivation={rangeKeyboardActivation}
                  handlers={stableRowHandlers}
                  t={t}
                />);
            })}
              </tbody></React.Fragment>;
            })}
            <tbody>
              {loaded && filtered.length === 0 && (<tr>
                  <td colSpan={visibleColumnCount} className="empty">
                    <div className="emptystate">
                      <span className="glyph"><Icon name={rosterScope === "attention" && !hasRosterRefinements ? "check" : "profiles"} /></span>
                      {profiles.length === 0 ? (<>
                          <b>{t("No profiles yet")}</b>
                          <p>{t("Create a profile or import a readable export from another browser.")}</p>
                          <p>{t("When you start an environment for the first time, the app downloads its browser engine if needed.")}</p>
                          <div className="empty-actions">
                            <button className="btn primary" onClick={openCreate}><Icon name="plus" className="sm" />{t("New Profile")}</button>
                            <button className="btn" onClick={openBulk}><Icon name="fileImport" className="sm" />{t("Import profiles")}</button>
                          </div>
                        </>) : missingRosterGroup ? (<>
                          <b>{t("This group is unavailable")}</b>
                          <p>{t("The group “{group}” may have been renamed or removed. Your saved view is kept.", { group: missingRosterGroup })}</p>
                          <button className="btn" onClick={() => setGroup("all")}>{t("Search all groups")}</button>
                        </>) : !hasRosterRefinements && rosterScope !== "all" ? (<>
                          <b>{t(rosterScope === "favorites" ? "Your favorites start here" : rosterScope === "recent" ? "No recent launches yet" : "Nothing needs attention")}</b>
                          <p>{t(rosterScope === "favorites" ? "Use the star beside an environment name to keep it close at hand." : rosterScope === "recent" ? "Environments launched on this computer in the last seven days appear here." : "No environments currently have invalid proxy settings, changes awaiting restart or imported mobile configurations.")}</p>
                          <button className="btn" onClick={() => chooseRosterScope("all")}>{t("Browse all environments")}</button>
                        </>) : (<>
                          <b>{t("No matches")}</b>
                          <p>{t("No profiles match the current filters.")}</p>
                          <div className="empty-actions"><button className="btn" onClick={clearRosterRefinements}>{t("Clear filters")}</button>{rosterScope !== "all" && <button className="btn ghost" onClick={() => chooseRosterScope("all")}>{t("Browse all environments")}</button>}</div>
                        </>)}
                    </div>
                  </td>
                </tr>)}
</tbody>
          </table>
        </div>

        {showDiag && diag && (<div className="diagpanel">
            <div className="when">{t("Last diagnose: {when}", { when: diagWhen ?? "" })}</div>
            {diag.analysis.verdicts.map((v, i) => (<div className="v" key={i}>{v}</div>))}
          </div>)}

        <footer className="statusbar">
          <span className="stat"><b>{profiles.length}</b> {t("profiles")}</span>
          <span className="stat"><StatusDot running={runningCount > 0} /><b>{runningCount}</b> {t("running")}</span>
          {diag && (<span className="diag" onClick={() => setShowDiag((s) => !s)}>
              {t("Diagnose · last {when}", { when: diagWhen ?? "" })}
              <Icon name={showDiag ? "chevronDown" : "chevronRight"} className="sm" />
            </span>)}
          <span className="pager">
            <button
              type="button"
              className="iconbtn"
              aria-label={t("Previous page")}
              disabled={visibleProfilePage === 0}
              onClick={() => setProfilePage(visibleProfilePage - 1)}
            ><Icon name="chevronLeft" className="sm" /></button>
            <span className="page-of">{t("Page")} <b>{visibleProfilePage + 1}</b> / {profilePageCount}</span>
            <button
              type="button"
              className="iconbtn"
              aria-label={t("Next page")}
              disabled={visibleProfilePage + 1 >= profilePageCount}
              onClick={() => setProfilePage(visibleProfilePage + 1)}
            ><Icon name="chevronRight" className="sm" /></button>
            <select className="select" aria-label={t("Rows per page")} value={pageSize} onChange={(e) => applyPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{t("{size} / page", { size })}</option>)}
            </select>
          </span>
        </footer>
      </div>) : view === "extensions" ? (<ExtensionsPage
        extensions={extensions} profiles={profiles} groupDefaults={groupExtensionDefaults}
        selectedGroup={groupDefaultName} selectedExtensionIds={groupDefaultExts}
        source={extSource} loading={extLoading} installing={extInstallBusy} uploading={extBusy} applying={groupDefaultBusy} error={extErr}
        dataFresh={extDataFresh} selectedGroupAvailable={extensionDraftState.selected?.available !== false} draftDirty={!!extensionDraftState.selected?.dirty} onDiscardGroupDraft={() => extensionDrafts.discard()}
        retainedGroupDrafts={extensionDraftState.drafts.filter(draft => !draft.available && draft.dirty).map(draft => draft.group)}
        onReload={async () => { if (!await refreshExtensionState(true)) throw new Error("The latest extension data could not be loaded. Your draft is kept. Reload before applying changes."); }}
        onPreviewGroupDefaults={(selection, signal) => previewGroupExtensionDefaults(selection.group, selection.extensions, signal)}
        onSourceChange={setExtSource} onSelectGroup={name => extensionDrafts.select(name)}
        onToggleExtension={toggleGroupDefaultExt} onInstall={doInstallWebStoreExtension} onUpload={doUploadExtensions}
        onApplyGroupDefaults={applyGroupExtensionDefault} onRemove={doRemoveExtension}
        onOpenProfile={id => { if (!editSessionRef.current) openEdit(id); }}
      />) : null}
      {scriptsVisit.current.visited && <ScriptsPage key={currentWorkspaceId} active={view === "scripts"} onViewRun={() => setScriptRunOpen(true)} />}
      {settingsVisited.current && (
        <SettingsPanel
          visible={view === "settings"}
          workspaceId={catalog?.currentId}
          tabs={SETTINGS_TABS}
          activeTab={settingsTab}
          onTabChange={setSettingsTab}
          updateTabRef={updateTabRef}
          settingsPanelRef={settingsPanelRef}
          signedUpdateStartup={signedUpdateStartup}
          onProfilesImported={refreshImportedProfiles}
          onLocateSnapshotProfile={locateProfile}
          onOpenAssistant={() => setView("assistant")}
          onCreateWithLocalProxy={beginCreate}
          runtimeDownloads={runtimeDownloads}
          runtimeDownloadsStale={runtimeDownloadsStale}
          onAssignLocalProxy={startLocalProxyAssignment}
          onResumeLocalProxyAssignment={activeLocalProxyIntent ? () => setView("proxies") : undefined}
          localProxyAssignmentBlocked={workspaceOperationState.blocked}
          fingerprintRefreshVersion={fingerprintRefreshVersion}
          onInspectProfile={openInspection}
          onEditProfile={id => { if (!editSessionRef.current) openEdit(id); }}
          onExplainFingerprint={explainFingerprint}
          currentWorkspaceName={currentName}
          profileCount={profiles.length}
          language={language}
          onLanguageChange={setLanguage}
          onLanguageError={setActionErr}
          themes={THEMES}
          theme={theme}
          onThemeChange={chooseTheme}
          rosterDensity={rosterDensity}
          onRosterDensityChange={chooseRosterDensity}
          viewPreferencesReady={viewPreferencesReady}
          viewPreferencesLoading={viewPreferencesLoading}
          viewPreferenceBusy={viewPreferenceBusy}
          viewPreferenceReadError={viewPreferenceReadError}
          onRetryViewPreferences={() => setPreferenceLoadAttempt(value => value + 1)}
          motionPreference={motion.preference}
          onMotionPreferenceChange={motion.setPreference}
          logErr={logErr}
          onLogErr={setLogErr}
          onLogView={setLogView}
          logDir={logDir}
          modeErr={modeErr}
          onDone={() => setView("profiles")}
        />
      )}
      </ErrorBoundary>
      </div>
      <footer className="workspace-footer"><span><Icon name="laptop" className="sm" />{t("Data stays on this device")}</span><span>猫步·千境{appVersion ? ` · ${appVersion}` : ""}</span></footer>
      </div>

      <LogModal
        logView={logView}
        logErr={logErr}
        onClose={() => { setLogView(null); setLogErr(null); }}
      />

      {pendingView && (<div className="modal-backdrop" onClick={() => { if (!pendingView.busy) setPendingView(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pending-cookie-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head" id="pending-cookie-title">
              <Icon name="cookie" />{t("Cookies at next start")}<span className="mono muted">{pendingView.profile.name}</span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={pendingView.busy} onClick={() => setPendingView(null)}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {pendingView.error && <div className="modal-err"><Icon name="alert" className="sm" />{pendingView.error}</div>}
              <p className="hint">{t("The browser sets these cookies the next time it starts, before the first page opens.")}</p>
              {pendingView.cookies === null
                ? <p className="muted">{t("Loading…")}</p>
                : <ul className="pending-cookies">{pendingView.cookies.map((cookie, index) => (
                  <li key={index}><span className="mono">{cookie.domain}</span><span className="mono muted">{cookie.name}</span></li>
                ))}</ul>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" disabled={pendingView.busy} onClick={() => setPendingView(null)}>{t("Close")}</button>
              <button className="btn danger" type="button" disabled={pendingView.busy || !pendingView.cookies?.length} onClick={() => void removePendingCookies()}>
                <Icon name="trash" className="sm" />{t("Remove pending cookies")}
              </button>
            </div>
          </div>
        </div>)}

      <CookieImportTaskDialog task={cookieImport.task} open={!!cookieTargets} targets={cookieTargets ?? lastCookieTargets.current} onClose={closeCookie} />

      <MoveFolderModal
        movingFolder={movingFolder}
        folderParent={folderParent}
        folderMoveBusy={folderMoveBusy}
        folderMoveErr={folderMoveErr}
        tree={tree}
        onParentChange={setFolderParent}
        onClose={() => { if (!folderMoveBusy) setMovingFolder(null); }}
        onCommit={() => void commitFolderMove()}
      />

      <MotionPresence present={showCreate}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop profile-editor-backdrop">
          <div ref={createEditorRef} inert={createCloseGuard.pending || undefined} aria-hidden={createCloseGuard.pending || undefined} tabIndex={-1} className="modal profile-editor" role="dialog" aria-modal="true" aria-labelledby="create-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="plus" /><span id="create-profile-title">{t("New profile")}</span>
              <EditorWindowControls chrome={windowChrome} disabled={creating} />
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={creating} onClick={closeCreate}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body" aria-busy={creating}>
              <fieldset className="profile-create-fields" disabled={creating}>
              {createErr && <div className="modal-err profile-create-error" role="alert" tabIndex={-1}><Icon name="alert" className="sm" />{t(createErr)}</div>}
              {createReuseSource && <div className={`update-banner update-result${createReuseSource.engine === "chromium" && form.engine === "chromium" && appMode?.chromiumRuntime && createReuseSource.chromiumRuntime !== appMode.chromiumRuntime ? " warning" : ""}`} role="note" aria-label={t("Reused configuration")}>
                <Icon name="copy" className="sm" /><div className="update-copy"><strong>{t("Configuration from {profile}", { profile: createReuseSource.name || createReuseSource.sourceId })}</strong>
                  <span>{t("Only setup was reused. Account details, proxy settings, cookies and the original fingerprint identity were not copied.")}</span>
                  <span>{t("Review this draft before creating. The new environment follows normal identity generation and starts without the source session.")}</span>
                  {createReuseSource.engine === "chromium" && form.engine === "chromium" && appMode?.chromiumRuntime && createReuseSource.chromiumRuntime !== appMode.chromiumRuntime && <span>{t("This computer requires {runtime}. The source uses {source}; the new environment will use {runtime}.", { runtime: "AliasMode Chromium", source: "CloakBrowser" })}</span>}
                </div>
              </div>}
              <ProfileTemplates disabled={creating} draft={{
                engine: form.engine,
                chromiumRuntime: profileCreationRuntime(form.engine, form.chromiumRuntime) ?? "",
                platformOs: form.platformOs as "" | "windows" | "macos" | "linux", screen: form.screen, platform: form.platform,
              }} onApply={settings => {
                if (settings.engine === "chromium" && appMode?.chromiumRuntime && settings.chromiumRuntime && settings.chromiumRuntime !== appMode.chromiumRuntime)
                  throw new Error("This template uses a browser runtime that is unavailable on this computer.");
                setForm(previous => ({ ...previous, engine: settings.engine,
                  chromiumRuntime: settings.engine === "firefox" || settings.chromiumRuntime === "cloakbrowser" ? "" : settings.chromiumRuntime || "auto",
                  platformOs: settings.platformOs, screen: settings.screen, platform: settings.platform,
                }));
                setCreateErr(null);
              }} />
              <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Name")}</span>
                  <input value={form.name} placeholder={t("auto if blank")} onChange={(e) => setF("name", e.target.value)} />
                </label>
                {(<label className="fld no">
                    <span>{t("Custom NO.")}</span>
                    <input
                      value={form.customNo}
                      inputMode="numeric"
                      maxLength={MAX_CUSTOM_NO}
                      placeholder="auto"
                      onChange={(e) => setF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                    />
                  </label>)}
              </div>
              <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Folder")}</span>
                  <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={existingGroups} allowCreate/>
                </label>
                <label className="fld grow">
                  <span>{t("Platform")}</span>
                  <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
                </label>
              </div>
              <div className="browser-options" role="radiogroup" aria-label={t("Browser")}>
                {([
                {
                    engine: "chromium", label: "Chrome",
                    path: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
                },
                {
                    engine: "firefox", label: "Firefox",
                    path: "M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z",
                },
            ] as const).map(({ engine, label, path }) => {
                // The help text names the engine that this computer and this form create.
                const selectedRuntime = profileCreationRuntime("chromium", form.chromiumRuntime, appMode?.chromiumRuntime) ?? appMode?.defaultChromiumRuntime;
                const runtime = browserLabel(engine, selectedRuntime === "cloakbrowser" ? "" : selectedRuntime);
                return (<div className="browser-option" key={engine}>
                    <label className="browser-card">
                      <input type="radio" name="browser-engine" value={engine} checked={form.engine === engine} onChange={() => setF("engine", engine)} />
                      <svg className="browser-logo" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
                      <span>{label}</span>
                    </label>
                    <button type="button" className="browser-info tip" data-tip={runtime} aria-label={`${label}: ${runtime}`}><Icon name="help" className="sm" /></button>
                  </div>);
            })}
              </div>
              {form.engine === "chromium" && !appMode?.chromiumRuntime && (<label className="fld">
                  <span>{t("Chrome version")}</span>
                  <select value={form.chromiumRuntime} onChange={(e) => setF("chromiumRuntime", e.target.value as FormChromiumRuntime)}>
                    <option value="auto">{t("Device default")}</option>
                    {appMode?.defaultChromiumRuntime
                      ? <><option value="aliasmode">{t("Chromium 155 (default)")}</option><option value="">{t("CloakBrowser 146")}</option></>
                      : <><option value="">{t("CloakBrowser 146 (default)")}</option><option value="aliasmode">{t("Chromium 155")}</option></>}
                  </select>
                  <small>{form.chromiumRuntime === "auto" ? t("Uses this computer's default browser runtime.") : !form.chromiumRuntime
                    ? t(CLOAKBROWSER_NOTE)
                    : t("Downloads once (about 190 MB) on each computer that opens it.")}</small>
                </label>)}
              <details className="fingerprint-settings" open={createProxyOpen} onToggle={(event) => setCreateProxyOpen(event.currentTarget.open)}>
                <summary>
                  <span>{t("Proxy")}</span>
                  <span className="automatic-badge">{createHasProxy ? createProxyEndpoint : t("Optional")}</span>
                </summary>
                <div className="proxy-settings">
                  {createProxySource && <p className="formnote local-proxy-draft-note" role="status">{t(createProxySource.socks5AuthRequired
                    ? "SOCKS5 requires authentication. Enter credentials and verify the exit."
                    : createProxySource.evidence === "handshake" ? "SOCKS5 handshake detected. Verify the exit before relying on it."
                    : "A local listener was found. Check the protocol and exit before relying on it.")}</p>}
                  <div className="proxy-paste-row">
                    <label className="fld grow">
                      <span>{t("Paste proxy to autofill")} <span className="muted">{t("(select type first · host:port:username:password)")}</span></span>
                      <input {...editorFieldAttributes(createProxyFeedback("proxyPaste"))} type="password" autoComplete="off" value={proxyPaste} placeholder={t("Paste here — credentials stay hidden")} onChange={(e) => { setProxyPaste(e.target.value); setProxyPasteOk(null); setProxyPasteInvalid(false); }} onPaste={(e) => {
                          const pasted = e.clipboardData.getData("text");
                          if (pasted) { e.preventDefault(); applyProxyPaste(pasted); }
                        }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyProxyPaste(proxyPaste); } }}/>
                    </label>
                    <button type="button" className="btn accent" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>{t("Autofill")}</button>
                  </div>
                  {proxyPasteOk && <div className="proxy-paste-ok"><Icon name="check" className="sm" />{proxyPasteOk}</div>}
                  <div className="fld-row">
                    <label className="fld type">
                      <span>{t("Proxy type")}</span>
                      <select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="https">https</option>
                        <option value="socks5">socks5</option>
                      </select>
                    </label>
                    <label className="fld grow">
                      <span>{t("Host")}</span>
                      <input {...editorFieldAttributes(createProxyFeedback("host"))} value={form.host} placeholder={t("blank = no proxy")} onChange={(e) => setF("host", e.target.value)} />
                    </label>
                    <label className="fld port">
                      <span>{t("Port")}</span>
                      <input value={form.port} inputMode="numeric" placeholder="8080" onChange={(e) => setF("port", e.target.value)} />
                    </label>
                  </div>
                  <div className="fld-row">
                    <label className="fld grow"><span>{t("Proxy user")}</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                    <label className="fld grow"><span>{t("Proxy pass")}</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
                  </div>
                  {createProxyIssue && <p id="profile-create-validation-error" className="modal-err">{t(createProxyIssue.message)}</p>}
                  <div className="proxy-check-actions">
                    <button type="button" className="btn proxy-check-btn" disabled={createProxyCheck.checking || !form.host.trim()} aria-busy={createProxyCheck.checking} onClick={checkCreateProxy}>
                      <Icon name="activity" className="sm" />
                      {createProxyCheck.checking ? t("Checking…") : t("Check proxy")}
                    </button>
                  </div>
                </div>
              </details>
              <ProxyCheckFeedback hasProxy={createHasProxy} state={createProxyCheck} />
              <FingerprintSettings engine={form.engine} chromiumRuntime={createFingerprintRuntime} screen={form.screen} onScreenChange={(value) => setF("screen", value)} platformOs={form.platformOs} onPlatformOsChange={(value) => setF("platformOs", value)}/>
              </fieldset>
            </div>
            <div className="modal-foot profile-editor-status-footer">
              <ProfileEditorStatus kind="create" createSummary={{ browserLabel: browserLabel(form.engine, createFingerprintRuntime), hasProxy: !!form.host.trim(), manualFingerprint: !!(form.screen.trim() || form.platformOs) }}
                hasValidationError={!!createProxyIssue} hasSaveError={!!createErr} onLocateProblem={locateCreateProblem} />
              <button className="btn ghost" disabled={creating} onClick={closeCreate}>{t("Cancel")}</button>
              <button className="btn primary" disabled={creating || !!createProxyIssue} onClick={submitCreate}>{creating ? t("Creating…") : t("Create profile")}</button>
            </div>
          </div>
        </div>)}</MotionPresence>

      <MotionPresence present={!!editId}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop profile-editor-backdrop">
          <div ref={editEditorRef} inert={editCloseGuard.pending || undefined} aria-hidden={editCloseGuard.pending || undefined} tabIndex={-1} className="modal profile-editor" role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="edit" /><span id="edit-profile-title">{t("Edit profile")}</span><span className="mono muted">{editId}</span>
              <EditorWindowControls chrome={windowChrome} disabled={editSaving || timezoneBusy} />
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={editSaving || timezoneBusy} onClick={closeEdit}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {editErr && <div className="modal-err profile-edit-save-error" role="alert" tabIndex={-1}><Icon name="alert" className="sm" />{t(editErr)}</div>}
              {!editReady ? (<><p className="hint" role="status">{t(editLoading ? "Loading profile…" : "Load this profile successfully before saving changes.")}</p><div><button type="button" className="btn" disabled={editLoading} aria-busy={editLoading} onClick={() => { if (editId) void loadEditedProfile(editId); }}>{t("Retry loading profile")}</button></div></>) : (<fieldset className="profile-create-fields profile-edit-fields" disabled={editSaving || timezoneBusy} aria-busy={editSaving || timezoneBusy}>
                  {editForm.proxyError && <div className="modal-err proxy-quarantine-note"><Icon name="alert" className="sm" /><span>{t("This saved proxy needs repair.")} <small>{editForm.proxyError}</small></span><button type="button" className="btn xs ghost" disabled={editSaving || timezoneBusy} onClick={() => { if (editSaveInFlight.current) return; resetEditProxyCheck(); setEditClearQuarantinedProxy(true); setEditForm(current => ({ ...current, proxy: "", proxyError: "" })); }}>{t("Remove invalid proxy")}</button></div>}{editClearQuarantinedProxy && <p className="hint">{t("The invalid proxy will be removed when you save. This environment will then use a direct connection.")}</p>}
                  {editRunning && (<p className="hint" role="status">
                      {t("This browser is open. Changes save now. Proxy and fingerprint changes apply at the next start.")}
                    </p>)}
                  {editMobile && (<div className="persona-warning">
                      <strong><Icon name="warning" className="sm" />{t("Imported mobile persona cannot open safely")}</strong>
                      <span>
                        {t("Earlier versions of the app opened it as a desktop browser anyway: Android became Windows; iPhone/iPad became macOS. That looked usable, but it was not coherent mobile emulation.")}
                      </span>
                      <span>
                        Convert it once to {editMobile.platform === "macos" ? "macOS" : "Windows"} desktop. Cookies, login/session, proxy, timezone, credentials and fingerprint seed stay intact
                        {editMobile.screenChanged ? `; the mobile-sized screen becomes ${editMobile.resolution}` : t("; the existing desktop-sized screen stays intact")}.
                      </span>
                      <button className="btn persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                        {editSaving ? t("Converting…") : `Convert to ${editMobile.platform === "macos" ? "macOS" : "Windows"} desktop`}
                      </button>
                    </div>)}
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>{t("Name")}</span>
                      <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
                    </label>
                    {(<label className="fld no">
                        <span>{t("Custom NO.")}</span>
                        <input
                          {...editorFieldAttributes(editFieldFeedback("customNo"))}
                          value={editForm.customNo ?? ""}
                          inputMode="numeric"
                          maxLength={MAX_CUSTOM_NO}
                          placeholder={editSerial != null ? String(editSerial) : "auto"}
                          onChange={(e) => setEF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                        />
                        <small>{t("Digits only · blank uses the serial")}</small>
                      </label>)}
                  </div>
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>{t("Folder")}</span>
                      <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={existingGroups} allowCreate/>
                    </label>
                    <label className="fld grow">
                      <span>{t("Platform")}</span>
                      <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
                    </label>
                  </div>

                  <label className="fld">
                    <span>{t("Browser")}</span>
                    <input value={editEngine ? browserLabel(editEngine, editChromiumRuntime) : ""} readOnly className="ro" />
                    {editEngine && <small>{editEngine === "firefox"
                      ? t("Native Firefox profile · no CDP, PDF, or Chrome extensions.")
                      : t("CDP, PDF, and Chrome extensions are available.")}</small>}
                    {editEngine === "chromium" && !editChromiumRuntime && <small>{t(CLOAKBROWSER_NOTE)}</small>}
                  </label>
                  <label className="fld">
                    <span>{t("Tags")} <span className="muted">{t("(comma-separated)")}</span></span>
                    <input {...editorFieldAttributes(editFieldFeedback("tags"))} value={editForm.tags ?? ""} placeholder="warmup, us, priority" onChange={(e) => setEF("tags", e.target.value)} />
                  </label>
                  <div className="fld-row">
                    <label className="fld type">
                      <span>{t("Proxy type")}</span>
                      <select {...editorFieldAttributes(editFieldFeedback("proxyType"))} value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="https">https</option>
                        <option value="socks5">socks5</option>
                      </select>
                    </label>
                    <label className="fld grow">
                      <span>{t("Proxy")}</span>
                      <input {...editorFieldAttributes(editFieldFeedback("proxy"))} value={editForm.proxy ?? ""} placeholder="host:port:username:password" onChange={(e) => setEF("proxy", e.target.value)} />
                      <small>{t("Leave blank to launch on a direct connection.")}</small>
                    </label>
                  </div>
                  <div className="proxy-check-actions">
                    <button type="button" className="btn proxy-check-btn" disabled={editProxyCheck.checking || timezoneBusy || !editHasProxy} aria-busy={editProxyCheck.checking} onClick={checkEditedProxy}>
                      <Icon name="activity" className="sm" />
                      {editProxyCheck.checking ? t("Checking…") : t("Check proxy")}
                    </button>
                  </div>
                  <ProxyCheckFeedback hasProxy={editHasProxy} state={editProxyCheck} />
                  {(<>
                      <div className="proxy-check-actions">
                        <button type="button" className="btn proxy-check-btn" disabled={timezoneBusy || editSaving || editProxyChanged || !!editForm.proxyError } onClick={refreshEditedTimezone}>
                          <Icon name="activity" className="sm" />
                          {timezoneBusy ? t("Looking up timezone and language…") : editHasProxy ? t("Set timezone and language from proxy") : t("Use current connection timezone and language")}
                        </button>
                      </div>
                      <p className="hint">{editProxyChanged
                        ? t("Save proxy changes before setting the timezone.")
                        : t("This action saves the timezone immediately. It applies the next time this profile opens.")}</p>
                    </>)}
                  {editForm.locale && localeTimezoneMismatch(editForm.locale, editForm.timezone ?? "") && (<p className="hint">{t("This language does not match the timezone's country. Use “Set timezone and language from proxy” to match them.")}</p>)}
                  <div className="fld-row">
                    <CopyField label={t("Username")} value={editForm.username ?? ""} onChange={(value) => setEF("username", value)} />
                    <CopyField label={t("Password")} value={editForm.password ?? ""} onChange={(value) => setEF("password", value)} />
                  </div>
                  <div className="fld-row">
                    <CopyField label={t("Email")} value={editForm.email ?? ""} onChange={(value) => setEF("email", value)} />
                    <CopyField label={t("Email password")} value={editForm.emailPassword ?? ""} onChange={(value) => setEF("emailPassword", value)} />
                  </div>
                  <CopyField label={t("2FA secret")} value={editForm.twofa ?? ""} onChange={(value) => setEF("twofa", value)} />
                  {editTotp && (<div className="authrow">
                      <span className="authlabel">{t("Authenticator")}</span>
                      <span className="authcode">{editTotp.code.slice(0, 3)} {editTotp.code.slice(3)}</span>
                      <span className="authsecs" title={t("seconds until it refreshes")}>{editTotp.secs}s</span>
                      <button className="btn xs" type="button" onClick={() => {
                        void copyPlainText(editTotp.code)
                          .then(() => flash(t("Copied")))
                          .catch((err) => setEditErr(err instanceof Error ? err.message : t("Could not copy to clipboard.")));
                      }}>
                        <Icon name="copy" className="sm" />{t("Copy")}
                      </button>
                    </div>)}
                  {editEngine && <FingerprintSettings
                    allowAutomaticScreen={false}
                    feedback={editFieldFeedback}
                    engine={editEngine} chromiumRuntime={editChromiumRuntime} screen={editForm.resolution ?? ""} onScreenChange={(value) => setEF("resolution", value)}
                    platformOs={editForm.platformOs ?? ""} onPlatformOsChange={editEngine === "chromium" ? (value) => setEF("platformOs", value) : undefined}
                    timezone={editForm.timezone ?? ""} onTimezoneChange={(value) => setEF("timezone", value)}
                    locale={editForm.locale ?? ""} onLocaleChange={(value) => setEF("locale", value)}
                    cores={editForm.cores ?? ""} onCoresChange={(value) => setEF("cores", value)}
                    seed={editForm.fingerprintSeed ?? ""} onSeedChange={(value) => setEF("fingerprintSeed", value)}
                    disabled={editSaving || timezoneBusy}
                    onUndo={() => setEditForm((form) => ({ ...form, ...editInitialFingerprint }))}
                    hardware={editHardware}
                  />}
                  {editEngine === "chromium" && editExtensionChoices.length > 0 && (<div className="fld">
                      <span>{t("Extensions")}</span>
                      <div className="extassign">
                        {editExtensionChoices.map((x) => (<label key={x.id} className="extchk">
                            <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                            <span>{x.name}{x.missing && <span className="muted">{t(" · Not installed on this device")}</span>}</span>
                          </label>))}
                      </div>
                    </div>)}
                  <p className="formnote">
                    {t("Cookies and locked fingerprint values are preserved. Only editable fields change.")}
                    {editEngine === "chromium" && t(" Extensions load when the browser opens.")}
                  </p>
                </fieldset>)}
              {editReady && editReview.error && <div id="profile-edit-validation-error" className="modal-err" role="alert" tabIndex={-1}>{t(editReview.error)}</div>}
              {editReady && editReview.summary && <div className="editor-summary-anchor" tabIndex={-1}><EditChangesSummary summary={editReview.summary} running={editRunning} busy={editSaving} /></div>}
            </div>
            <div className="modal-foot profile-editor-status-footer">
              {editReady && <ProfileEditorStatus kind="edit" editChangeCount={editReview.summary?.count ?? 0} hasValidationError={!!editReview.error} hasSaveError={!!editErr}
                onReview={() => focusEditorTarget(editEditorRef.current?.querySelector<HTMLElement>(".editor-summary-anchor"), editorScroll)} onLocateProblem={locateEditProblem} />}
              <button className="btn ghost" disabled={editSaving || timezoneBusy} onClick={closeEdit}>{t("Cancel")}</button>
              <button className="btn primary" disabled={!editReady || !editReview.summary?.hasChanges || !!editReview.error || editSaving || editLoading || timezoneBusy} onClick={saveEdit}>{editSaving ? t("Saving…") : t("Save changes")}</button>
            </div>
          </div>
        </div>)}</MotionPresence>

      <MotionPresence present={showBulk}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" ref={bulkEditorRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("Import profiles")} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="fileImport" />{t("Import profiles")}
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={bulkBusy} onClick={closeBulk}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err" role="alert"><Icon name="alert" className="sm" />{bulkErr}</div>}
              {bulkBusy && <p className="hint" role="status">{t("Importing the selected records. Wait for the result before changing this draft.")}</p>}
              <fieldset className="import-draft-fields" disabled={bulkBusy} aria-busy={bulkBusy}><legend className="sr-only">{t("Import draft")}</legend>
              <ol className="steps">
                <li>{t("Export profiles from your previous browser as TXT, CSV, JSON, or XLSX.")}</li>
                <li>{t("Add the files below and choose a destination group.")}</li>
                <li>{t("Click Import profiles. Only data included in the export can transfer.")}</li>
              </ol>
              <p className="hint">{t("Encrypted or proprietary profile archives cannot be imported. Use a readable export instead.")}</p>

              <div className="segmented" role="tablist" aria-label={t("Import source")}>
                <button type="button" role="tab" aria-selected={bulkSource === "file"} className={bulkSource === "file" ? "active" : ""} onClick={() => { if (importInFlight.current) return; setBulkSource("file"); setBulkText(""); }}>
                  <Icon name="fileImport" className="sm" />{t("From file")}
                </button>
                <button type="button" role="tab" aria-selected={bulkSource === "paste"} className={bulkSource === "paste" ? "active" : ""} onClick={() => { if (importInFlight.current) return; setBulkSource("paste"); setBulkFiles([]); }}>
                  <Icon name="copy" className="sm" />{t("Paste text")}
                </button>
              </div>

              {bulkSource === "file" ? (<>
                  <div className={`bulkdrop${bulkOver ? " over" : ""}`} role="button" tabIndex={bulkBusy ? -1 : 0} aria-disabled={bulkBusy} onKeyDown={(e) => { if (importInFlight.current) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bulkFileRef.current?.click(); } }} onClick={() => { if (!importInFlight.current) bulkFileRef.current?.click(); }} onDragOver={(e) => { e.preventDefault(); if (importInFlight.current) return; if (!bulkOver) setBulkOver(true); }} onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }} onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (!importInFlight.current && e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}>
                    <Icon name="fileImport" />
                    <b>{t("Drag & drop files, or click to choose")}</b>
                    <div className="sub">{t("Readable TXT, CSV, JSON, or XLSX exports from AdsPower, GoLogin, Multilogin, Dolphin Anty, HideMyAcc, Incogniton, Donut, and similar browsers")}</div>
                  </div>
                  {bulkFiles.length > 0 && (<div className="filelist">
                      {bulkFiles.map((file) => (<span className="filechip" key={file.name}>
                          <Icon name="file" className="sm" />
                          <span className="fname">{file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => { if (!importInFlight.current) setBulkFiles((files) => files.filter((candidate) => candidate !== file)); }}
                          ><Icon name="close" className="sm" /></button>
                        </span>))}
                      <button type="button" className="btn xs ghost" onClick={() => { if (!importInFlight.current) setBulkFiles([]); }}>{t("Clear all")}</button>
                    </div>)}
                </>) : (<label className="fld">
                  <span>{t("AdsPower TXT records")}</span>
                  <textarea
                    rows={9}
                    value={bulkText}
                    placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                    onChange={(event) => { if (!importInFlight.current) setBulkText(event.target.value); }}
                  />
                  <small>{pastedRecordCount === null
                    ? t("Paste one or more key=value records, separated by a line of asterisks.")
                    : pastedRecordCount === 1
                      ? t("1 record detected — each one starts with its own id= line.")
                      : t("{count} records detected — each one starts with its own id= line.", { count: pastedRecordCount })}</small>
                </label>)}

              <input ref={bulkFileRef} type="file" multiple accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: "none" }} onChange={(e) => { if (!importInFlight.current && e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}/>

              <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Assign to group")}</span>
                  <GroupPicker value={bulkGroup} onChange={value => { if (!importInFlight.current) setBulkGroup(value); }} groups={existingGroups} emptyLabel="Keep source groups" allowCreate/>
                </label>
                <label className="fld grow">
                  <span>{t("Platform")}</span>
                  <select value={bulkPlatform} onChange={(e) => { if (!importInFlight.current) setBulkPlatform(e.target.value); }}>
                    {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.value ? platform.label : t("Keep source platforms")}</option>)}
                  </select>
                </label>
              </div>
              <p className="formnote">
                {t("Keep source values to preserve each record's group and platform. Choosing a specific value applies it to every imported record. Fields absent from a same-ID update keep their saved values.")}
              </p>
              <details className="import-transfer-details"><summary>{t("Import rules and transferable data")}</summary><p className="formnote">{t("Readable exports can transfer account fields, proxy settings, cookies and supported portable settings. Records with an existing ID update that environment; data missing from the export cannot be reconstructed.")}</p><p className="formnote">{t("Explicit seed, timezone and platform_os values can update supported identity settings. Browser version, operating system and hardware still affect the resulting fingerprint. Historical fp_* measurements are review evidence, not browser configuration.")}</p></details>
              </fieldset>
            </div>
            <div className="modal-foot">
              <button className="tlink" onClick={() => downloadText("maobu-qianjing-template.csv", CSV_TEMPLATE, "text/csv")}>
                <Icon name="export" className="sm" />{t("CSV template")}
              </button>
              <button className="tlink" onClick={() => downloadText("maobu-qianjing-example.txt", TXT_EXAMPLE, "text/plain")}>
                <Icon name="export" className="sm" />{t(".txt example")}
              </button>
              <span className="spacer" />
              <button className="btn ghost" disabled={bulkBusy} onClick={closeBulk}>{t("Cancel")}</button>
              <button className="btn primary" disabled={bulkBusy || (!bulkFiles.length && !bulkText.trim())} onClick={submitBulk}>
                <Icon name="fileImport" className="sm" />{bulkBusy ? t("Importing…") : t("Import profiles")}
              </button>
            </div>
          </div>
        </div>)}</MotionPresence>

      <ProfileFileUpdateDialog open={showUpdate} task={fileUpdate.task} onClose={() => setShowUpdate(false)} selectedCount={selected.size} onExport={exportSelected} onDownloadTemplate={() => downloadText("maobu-qianjing-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")} />
      <ScriptRunPanel
        open={scriptRunOpen}
        selectedProfiles={scriptRunProfiles}
        onClose={() => setScriptRunOpen(false)}
      />
    </div>
    </>);
}
function DesktopCloseShell() {
  const registry = useDesktopCloseRegistry();
  return <DesktopCloseRegistryProvider registry={registry}><DesktopCloseHost registry={registry} returnFocus={() => document.querySelector<HTMLButtonElement>(".command-palette-trigger")} /><App /></DesktopCloseRegistryProvider>;
}
const rootElement = document.getElementById("root")!;
installExternalLinkHandler(rootElement);
const root = createRoot(rootElement);
root.render(<I18nProvider>
    <ErrorBoundary scope="Application">
      <WorkspaceProvider><DesktopCloseShell /></WorkspaceProvider>
    </ErrorBoundary>
  </I18nProvider>);
