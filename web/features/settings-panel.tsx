import type { RefObject } from "react";
import { fetchLogs, type RuntimeDownload } from "../api";
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
  updateTabRef: RefObject<HTMLButtonElement | null>;
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
  logErr: string | null;
  onLogErr: (err: string | null) => void;
  onLogView: (view: { file: string; content: string } | null) => void;
  logDir?: string;
  modeErr: string | null;
  onDone: () => void;
}

export function SettingsPanel({
  visible,
  workspaceId,
  tabs,
  activeTab,
  onTabChange,
  updateTabRef,
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
  logErr,
  onLogErr,
  onLogView,
  logDir,
  modeErr,
  onDone,
}: SettingsPanelProps) {
  const { t } = useTranslation();

  return (
    <div
      key={`settings-${workspaceId ?? "loading"}`}
      className="workspace settings-workspace"
      hidden={!visible}
      inert={!visible || undefined}
      style={!visible ? { display: "none" } : undefined}
    >
      <div className="page-heading">
        <div>
          <h1>{t("Settings")}</h1>
          <p className="page-subtitle">
            {t("Make this workspace feel like yours.")}
          </p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label={t("Settings sections")}>
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            ref={tab.key === "updates" ? updateTabRef : undefined}
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
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
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
            {t(tab.label)}
          </button>
        ))}
      </div>
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
            <h2 className="sect-title">{t("Local workspace")}</h2>
            <div className="identity-card">
              <span className="identity-avatar">
                <AppIcon name="user" className="lg" />
              </span>
              <span className="identity-lines">
                <b>{currentWorkspaceName}</b>
                <span>
                  {t("No account · profile data stays on this computer")}
                </span>
              </span>
              <span className="chip">{t("Local")}</span>
            </div>
            <section className="settings-card">
              <header>
                <AppIcon name="user" className="sm" />
                <h2>{t("Local data")}</h2>
              </header>
              <div className="card-body">
                <div className="settings-row">
                  <span>{t("Mode")}</span>
                  <strong>{t("Local · no account")}</strong>
                </div>
                <div className="settings-row">
                  <span>{t("Profiles stored")}</span>
                  <strong>{profileCount}</strong>
                </div>
              </div>
            </section>

            <section className="settings-card">
              <header>
                <AppIcon name="sun" className="sm" />
                <h2>{t("Appearance")}</h2>
              </header>
              <div className="card-body">
                <p>{t("System follows your operating system setting.")}</p>
                <label className="fld">
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
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={t("Theme")}
                >
                  {themes.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={theme === option.key}
                      className={theme === option.key ? "active" : ""}
                      onClick={() => onThemeChange(option.key)}
                    >
                      <AppIcon name={option.icon} className="sm" />
                      {t(option.label)}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}

        {activeTab === "account" && (
          <section className="settings-card">
            <div className="card-body">
              <RosterDensityControl
                variant="settings"
                value={rosterDensity}
                onChange={(value) => void onRosterDensityChange(value)}
                disabled={!viewPreferencesReady}
                busy={viewPreferenceBusy}
              />
              {!viewPreferencesReady && (
                <p
                  className={
                    viewPreferenceReadError
                      ? "roster-view-error"
                      : "roster-view-note"
                  }
                  role={viewPreferenceReadError ? "alert" : "status"}
                >
                  {viewPreferenceReadError
                    ? t(viewPreferenceReadError)
                    : t("Loading workspace display preferences…")}
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
          </section>
        )}
        {activeTab === "account" && (
          <DesktopMotionSettings
            value={motionPreference}
            onChange={onMotionPreferenceChange}
          />
        )}
        {activeTab === "advanced" && (
          <>
            <h2 className="sect-title">{t("Diagnostics")}</h2>
            <section className="settings-card">
              <header>
                <AppIcon name="logs" className="sm" />
                <h2>{t("Logs")}</h2>
              </header>
              <div className="card-body">
                <p>
                  {t(
                    "The detailed log records launches, proxy setup and browser lifecycle for this installation.",
                  )}
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onLogErr(null);
                    fetchLogs()
                      .then(onLogView)
                      .catch((e) =>
                        onLogErr(e instanceof Error ? e.message : String(e)),
                      );
                  }}
                >
                  <AppIcon name="logs" className="sm" />
                  {t("View detailed logs")}
                </button>
                {logErr && (
                  <p className="cardnote">
                    {t("Logs")}: {t(logErr)}
                  </p>
                )}
                {logDir && (
                  <p className="cardnote">
                    {t("File")}: {logDir}
                  </p>
                )}
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
      <footer className="pagefoot">
        <span className="spacer" />
        <button className="btn primary" type="button" onClick={onDone}>
          {t("Done")}
        </button>
      </footer>
    </div>
  );
}
