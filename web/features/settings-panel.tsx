import type { RefObject } from "react";
import { useId, useRef, useState } from "react";
import type { RuntimeDownload, UiProfile } from "../api";
import type { AppLockStatus } from "../app-lock-api.ts";
import { AppLockSettings, type AppLockSettingsProps } from "../app-lock-settings.tsx";
import type { DefaultBrowserRoutingConfig } from "../default-browser.ts";
import { DefaultBrowserSettings } from "../default-browser-settings.tsx";
import { DiagnosticsBox } from "../diagnostics-box.tsx";
import {
  persistOnboardingState,
} from "../onboarding-checklist.tsx";
import type { FingerprintReport } from "../settings-api";
import type { DesktopMotionPreference } from "../desktop-motion";
import { DesktopMotionSettings } from "../desktop-motion.tsx";
import type { InspectionEditField } from "../environment-inspection.tsx";
import { availableLanguages, languageNativeName, useTranslation } from "../i18n";
import { RosterDensityControl, type RosterDensity } from "../roster-density.tsx";
import {
  FeatureSettingsPanel,
  type FeatureSettingsTab,
  type LocalProxyDraftCandidate,
} from "../settings-center.tsx";
import type { useSignedUpdateStartup } from "../signed-updates.tsx";
import type { ThemeChoice } from "../theme";
import { AppIcon, type IconName } from "../ui-primitives";

export interface SettingsTabItem {
  key: FeatureSettingsTab | "account" | "advanced";
  label: string;
}

const SETTINGS_TAB_ICONS: Record<SettingsTabItem["key"], IconName> = {
  account: "sliders",
  network: "globe",
  fingerprints: "shieldCheck",
  models: "cpu",
  integrations: "plug",
  sync: "sync",
  updates: "import",
  advanced: "terminal",
};

const SETTINGS_TAB_GROUPS: Record<SettingsTabItem["key"], string> = {
  account: "Preferences & security",
  network: "Preferences & security",
  fingerprints: "Preferences & security",
  models: "AI & integrations",
  integrations: "AI & integrations",
  sync: "Data & system",
  updates: "Data & system",
  advanced: "Data & system",
};

export function focusSettingsSection(panel: HTMLElement | null, key: SettingsTabItem["key"]) {
  const shell = panel?.closest(".settings-workspace") ?? panel?.parentElement;
  if (!shell || shell.closest("[hidden], [inert]")) return;
  const picker = shell.querySelector<HTMLSelectElement>("[data-settings-section-picker]");
  if (picker?.value === key && picker.getBoundingClientRect().width > 0) {
    picker.focus({ preventScroll: true });
    return;
  }
  shell.querySelector<HTMLButtonElement>(`[data-settings-tab="${key}"][aria-selected="true"]`)?.focus({ preventScroll: true });
}

export interface ThemeOptionItem {
  key: ThemeChoice;
  label: string;
  icon: IconName;
}

export interface SettingsPanelProps {
  visible: boolean;
  workspaceId: string | null | undefined;
  tabs: readonly SettingsTabItem[];
  activeTab: SettingsTabItem["key"];
  onTabChange: (tab: SettingsTabItem["key"]) => void;
  settingsPanelRef: RefObject<HTMLDivElement | null>;
  signedUpdateStartup: ReturnType<typeof useSignedUpdateStartup>;
  onProfilesImported: () => Promise<void>;
  onLocateSnapshotProfile: (id: string) => void;
  onOpenAssistant: () => void;
  onCreateWithLocalProxy: (seed?: LocalProxyDraftCandidate) => void;
  runtimeDownloads: RuntimeDownload[];
  runtimeDownloadsStale: boolean;
  onAssignLocalProxy: (draft: LocalProxyDraftCandidate, trigger: HTMLButtonElement) => void;
  onResumeLocalProxyAssignment?: () => void;
  localProxyAssignmentBlocked: boolean;
  fingerprintRefreshVersion: number;
  onInspectProfile: (id: string) => void;
  onEditProfile: (id: string, field?: InspectionEditField, trigger?: HTMLElement | null) => void;
  onExplainFingerprint: (report: FingerprintReport) => void;
  currentWorkspaceName: string;
  profileCount: number;
  language: string;
  onLanguageChange: (lang: string) => Promise<void>;
  onLanguageError: (message: string) => void;
  themes: readonly ThemeOptionItem[];
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  rosterDensity: RosterDensity;
  onRosterDensityChange: (density: RosterDensity) => Promise<void>;
  viewPreferencesReady: boolean;
  viewPreferencesLoading: boolean;
  viewPreferenceBusy: boolean;
  viewPreferenceReadError: string | null;
  onRetryViewPreferences: () => void;
  motionPreference: DesktopMotionPreference;
  onMotionPreferenceChange: (pref: DesktopMotionPreference) => void;
  onOpenLogs: () => void;
  logDir?: string;
  modeErr: string | null;
  onDone: () => void;
  /** Optional Wave 4 app lock capability flag (when false, omits AppLockSettings to avoid unadvertised fetches). */
  appLockAvailable?: boolean;
  /** Optional Wave 4 app lock state & change hook (self-managed if omitted). */
  appLockStatus?: AppLockStatus | null;
  beginAppLockSettingsChange?: AppLockSettingsProps["beginStatusChange"];
  /** Opens the checklist on the profile page when supplied by the app. */
  onReopenOnboarding?: () => void;
  /** Optional callback when diagnostics finishes running. */
  onDiagnosticsRun?: () => void;
  profiles?: readonly UiProfile[];
  defaultBrowserConfig?: DefaultBrowserRoutingConfig;
  onDefaultBrowserConfigChange?: (next: DefaultBrowserRoutingConfig) => void;
  onTestExternalUrl?: (url: string) => void;
}

export function SettingsPanel({
  visible,
  workspaceId,
  tabs,
  activeTab,
  onTabChange,
  settingsPanelRef,
  signedUpdateStartup,
  onProfilesImported,
  onLocateSnapshotProfile,
  onOpenAssistant,
  onCreateWithLocalProxy,
  runtimeDownloads,
  runtimeDownloadsStale,
  onAssignLocalProxy,
  onResumeLocalProxyAssignment,
  localProxyAssignmentBlocked,
  fingerprintRefreshVersion,
  onInspectProfile,
  onEditProfile,
  onExplainFingerprint,
  currentWorkspaceName,
  profileCount,
  language,
  onLanguageChange,
  onLanguageError,
  themes,
  theme,
  onThemeChange,
  rosterDensity,
  onRosterDensityChange,
  viewPreferencesReady,
  viewPreferencesLoading,
  viewPreferenceBusy,
  viewPreferenceReadError,
  onRetryViewPreferences,
  motionPreference,
  onMotionPreferenceChange,
  onOpenLogs,
  logDir,
  modeErr,
  onDone,
  appLockAvailable = true,
  appLockStatus,
  beginAppLockSettingsChange,
  onReopenOnboarding,
  onDiagnosticsRun,
  profiles,
  defaultBrowserConfig,
  onDefaultBrowserConfigChange,
  onTestExternalUrl,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const themeLabel = useId();
  const [onboardingReopenBusy, setOnboardingReopenBusy] = useState(false);
  const [onboardingReopenNotice, setOnboardingReopenNotice] = useState<string | null>(null);
  const appLockVisible = visible && activeTab === "account" && appLockAvailable;
  const lockWorkspaceId = workspaceId ?? null;
  const appLockVisited = useRef<string | null | undefined>(undefined);
  if (appLockVisible) appLockVisited.current = lockWorkspaceId;

  const handleReopenOnboarding = async () => {
    setOnboardingReopenNotice(null);
    if (onReopenOnboarding) {
      onReopenOnboarding();
      return;
    }
    setOnboardingReopenBusy(true);
    try {
      await persistOnboardingState("open");
      setOnboardingReopenNotice(t("Quick-start checklist reopened on the profiles page."));
    } catch (error) {
      setOnboardingReopenNotice(
        error instanceof Error ? error.message : t("Could not reopen quick-start checklist."),
      );
    } finally {
      setOnboardingReopenBusy(false);
    }
  };

  const activeTabLabel = tabs.find((tab) => tab.key === activeTab)?.label ?? "Settings";

  return (
    <div
      key={`settings-${workspaceId ?? "loading"}`}
      className="workspace settings-workspace"
      hidden={!visible}
      inert={!visible || undefined}
      style={!visible ? { display: "none" } : undefined}
    >
      <div className="page-heading">
        <div className="settings-heading-title">
          <h1>{t("Settings")}</h1>
          <span className="settings-heading-pill is-accent">
            {currentWorkspaceName} · {t("{count} environments", { count: profileCount })}
          </span>
          <span className="settings-heading-pill">{t(activeTabLabel)}</span>
        </div>
        <button className="btn" type="button" onClick={onDone}>
          <AppIcon name="chevronLeft" className="sm" />
          <span>{t("Back to environments")}</span>
        </button>
      </div>
      <div className="settings-section-control">
        <select
          className="select"
          data-settings-section-picker
          aria-label={t("Settings sections")}
          aria-controls="settings-panel"
          value={activeTab}
          onChange={(event) => {
            const next = tabs.find((tab) => tab.key === event.target.value);
            if (next) onTabChange(next.key);
          }}
        >
          {tabs.map((tab) => <option key={tab.key} value={tab.key}>{t(tab.label)}</option>)}
        </select>
      </div>
      <div className="settings-shell-body">
        <aside className="settings-nav-rail">
          <div
            className="tabs settings-nav-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("Settings sections")}
            data-sliding-axis="vertical"
          >
            {tabs.flatMap((tab, index) => {
              const group = SETTINGS_TAB_GROUPS[tab.key];
              const prevGroup = index > 0 ? SETTINGS_TAB_GROUPS[tabs[index - 1]!.key] : null;
              const nodes = [];
              if (group && group !== prevGroup) {
                nodes.push(
                  <span
                    key={`group-${group}`}
                    className="settings-nav-group"
                    aria-hidden="true"
                    role="presentation"
                  >
                    {t(group)}
                  </span>,
                );
              }
              nodes.push(
                <button
                  key={tab.key}
                  id={`settings-tab-${tab.key}`}
                  data-settings-tab={tab.key}
                  type="button"
                  role="tab"
                  aria-controls="settings-panel"
                  aria-selected={activeTab === tab.key}
                  tabIndex={activeTab === tab.key ? 0 : -1}
                  className={`tab${activeTab === tab.key ? " active" : ""}`}
                  onClick={() => onTabChange(tab.key)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? tabs.length - 1
                              : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    const key = tabs[next]!.key;
                    onTabChange(key);
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLButtonElement>(`[data-settings-tab="${key}"]`)
                      ?.focus();
                  }}
                >
                  <AppIcon name={SETTINGS_TAB_ICONS[tab.key]} className="sm" />
                  <span>{t(tab.label)}</span>
                </button>,
              );
              return nodes;
            })}
          </div>
        </aside>
        <div
          ref={settingsPanelRef}
          className="settingspage"
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
        >
        <FeatureSettingsPanel
          sessionKey={workspaceId ?? null}
          tab={
            !visible || activeTab === "account" || activeTab === "advanced"
              ? null
              : (activeTab as FeatureSettingsTab)
          }
          signedUpdateStartup={signedUpdateStartup}
          onProfilesImported={onProfilesImported}
          onLocateSnapshotProfile={onLocateSnapshotProfile}
          onOpenAssistant={onOpenAssistant}
          onCreateWithLocalProxy={onCreateWithLocalProxy}
          runtimeDownloads={runtimeDownloads}
          runtimeDownloadsStale={runtimeDownloadsStale}
          onAssignLocalProxy={onAssignLocalProxy}
          onResumeLocalProxyAssignment={onResumeLocalProxyAssignment}
          localProxyAssignmentBlocked={localProxyAssignmentBlocked}
          fingerprintRefreshVersion={fingerprintRefreshVersion}
          onInspectProfile={onInspectProfile}
          onEditProfile={onEditProfile}
          onExplainFingerprint={onExplainFingerprint}
        />
        {activeTab === "account" && (
          <>
            <section className="settings-context" aria-labelledby="settings-workspace-name">
              <div className="settings-context-icon"><AppIcon name="laptop" className="lg" /></div>
              <div className="settings-context-name">
                <p>{t("Local workspace")}</p>
                <h2 id="settings-workspace-name">{currentWorkspaceName}</h2>
              </div>
              <dl className="settings-context-count">
                <dt>{t("Profiles stored")}</dt>
                <dd>{profileCount}</dd>
              </dl>
            </section>

            <section className="settings-card">
              <header>
                <AppIcon name="sun" className="sm" />
                <h2>{t("Appearance")}</h2>
              </header>
              <div className="card-body">
                <div className="settings-appearance">
                  <label className="fld settings-appearance-row">
                    <span>{t("language.label")}</span>
                    <select
                      className="select"
                      value={language}
                      onChange={(event) => {
                        void onLanguageChange(event.target.value).catch((error) =>
                          onLanguageError(
                            error instanceof Error ? error.message : String(error),
                          ),
                        );
                      }}
                    >
                      {availableLanguages().map((lang) => (
                        <option key={lang} value={lang}>
                          {languageNativeName(lang)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="settings-appearance-row settings-theme">
                    <span id={themeLabel}>{t("Theme")}</span>
                    <div className="settings-theme-options" role="radiogroup" aria-labelledby={themeLabel}>
                      {themes.map((option) => (
                        <label key={option.key}>
                          <input
                            className="sr-only"
                            type="radio"
                            name={`${themeLabel}-theme`}
                            value={option.key}
                            checked={theme === option.key}
                            onChange={() => onThemeChange(option.key)}
                          />
                          <AppIcon name={option.icon} className="sm" />
                          <span>{t(option.label)}</span>
                        </label>
                      ))}
                    </div>
                    <select className="select settings-compact-choice" aria-labelledby={themeLabel} value={theme} onChange={(event) => {
                      const next = themes.find((option) => option.key === event.target.value);
                      if (next) onThemeChange(next.key);
                    }}>
                      {themes.map((option) => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
                    </select>
                  </div>
                  <div className="settings-display-density">
                    <RosterDensityControl
                      variant="settings"
                      value={rosterDensity}
                      onChange={(value) => void onRosterDensityChange(value)}
                      disabled={!viewPreferencesReady}
                      busy={viewPreferenceBusy}
                    />
                    {!viewPreferencesReady && (
                      <p
                        className={viewPreferenceReadError ? "roster-view-error" : "roster-view-note"}
                        role={viewPreferenceReadError ? "alert" : "status"}
                      >
                        {viewPreferenceReadError ? t(viewPreferenceReadError) : t("Loading workspace display preferences…")}
                        {viewPreferenceReadError && (
                          <button
                            type="button"
                            className="btn xs ghost"
                            disabled={viewPreferencesLoading}
                            onClick={onRetryViewPreferences}
                          >
                            {t("Retry display settings")}
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                  <DesktopMotionSettings value={motionPreference} onChange={onMotionPreferenceChange} />
                </div>
              </div>
            </section>
            {defaultBrowserConfig && onDefaultBrowserConfigChange && (
              <DefaultBrowserSettings
                profiles={profiles ?? []}
                config={defaultBrowserConfig}
                onChange={onDefaultBrowserConfigChange}
                onTestExternalUrl={onTestExternalUrl}
              />
            )}
          </>
        )}
        {appLockAvailable && appLockVisited.current === lockWorkspaceId && (
          <div className="feature-settings-section" hidden={!appLockVisible} inert={!appLockVisible || undefined}>
            <AppLockSettings
              active={appLockVisible}
              status={appLockStatus}
              beginStatusChange={beginAppLockSettingsChange}
            />
          </div>
        )}
        {activeTab === "account" && (
          <div className="settings-checklist" data-onboarding-settings-card="true">
            <button
              type="button"
              className="settings-checklist-action"
              disabled={onboardingReopenBusy}
              onClick={() => void handleReopenOnboarding()}
            >
              <AppIcon name="star" className="sm" />
              <span>{t("Reopen quick-start checklist")}</span>
              <AppIcon name="chevronRight" className="sm" />
            </button>
            {onboardingReopenNotice && <p role="status">{onboardingReopenNotice}</p>}
          </div>
        )}
        {activeTab === "advanced" && (
          <>
            <DiagnosticsBox onDiagnosticsRun={onDiagnosticsRun} />
            <section className="settings-card">
              <header>
                <AppIcon name="logs" className="sm" />
                <h2>{t("Logs")}</h2>
              </header>
              <div className="card-body">
                <button
                  type="button"
                  className="btn"
                  onClick={onOpenLogs}
                >
                  <AppIcon name="logs" className="sm" />
                  {t("View detailed logs")}
                </button>
                {logDir && <details className="settings-log-location">
                  <summary>{t("Log folder")}</summary>
                  <p className="settings-log-path"><code>{logDir}</code></p>
                </details>}
              </div>
            </section>
          </>
        )}
        {modeErr && (
          <div className="modal-err" role="alert">
            <AppIcon name="alert" className="sm" />
            {t(modeErr)}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
