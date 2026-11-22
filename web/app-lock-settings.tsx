import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AppLockApiError,
  configureAppLock,
  fetchAppLockStatus,
  lockAppNow,
  setupAppLock,
  type AppLockStatus,
} from "./app-lock-api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./app-lock.css";

const IDLE_TIMEOUT_OPTIONS = [0, 5, 15, 30, 60] as const;

export interface AppLockSettingsProps {
  status?: AppLockStatus | null;
  onStatusChange?: (status: AppLockStatus) => void;
}

export function AppLockSettings({ status: externalStatus, onStatusChange }: AppLockSettingsProps) {
  const { t } = useTranslation();
  const [internalStatus, setInternalStatus] = useState<AppLockStatus | null>(externalStatus ?? null);
  const [loading, setLoading] = useState(externalStatus === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Setup fields
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [idleMinutes, setIdleMinutes] = useState(15);
  const [lockOnStartup, setLockOnStartup] = useState(true);

  // Configure / Disable fields
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  const status = externalStatus ?? internalStatus;

  const applyStatus = useCallback(
    (next: AppLockStatus) => {
      setInternalStatus(next);
      setIdleMinutes(next.idleTimeoutMinutes);
      setLockOnStartup(next.lockOnStartup);
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  useEffect(() => {
    if (externalStatus !== undefined) {
      setInternalStatus(externalStatus);
      if (externalStatus) {
        setIdleMinutes(externalStatus.idleTimeoutMinutes);
        setLockOnStartup(externalStatus.lockOnStartup);
      }
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchAppLockStatus()
      .then((next) => {
        if (cancelled) return;
        setInternalStatus(next);
        setIdleMinutes(next.idleTimeoutMinutes);
        setLockOnStartup(next.lockOnStartup);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("Could not load app lock status."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [externalStatus, t]);

  const handleSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (Array.from(setupPassword).length < 6 || Array.from(setupPassword).length > 128) {
      setError(t("Master password must be 6–128 characters."));
      return;
    }
    if (setupPassword !== setupConfirm) {
      setError(t("Passwords do not match."));
      return;
    }
    setBusy(true);
    try {
      const next = await setupAppLock({
        password: setupPassword,
        idleTimeoutMinutes: idleMinutes,
        lockOnStartup,
      });
      setSetupPassword("");
      setSetupConfirm("");
      applyStatus(next);
      setNotice(t("Local app master password lock enabled."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not enable app lock."));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!currentPassword) {
      setError(t("Enter your current master password to apply changes."));
      return;
    }
    if (newPassword) {
      if (Array.from(newPassword).length < 6 || Array.from(newPassword).length > 128) {
        setError(t("Master password must be 6–128 characters."));
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        setError(t("Passwords do not match."));
        return;
      }
    }
    setBusy(true);
    try {
      const next = await configureAppLock({
        currentPassword,
        idleTimeoutMinutes: idleMinutes,
        lockOnStartup,
        ...(newPassword ? { newPassword } : {}),
      });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      applyStatus(next);
      setNotice(t("App lock settings updated."));
    } catch (err) {
      setError(err instanceof AppLockApiError ? err.message : t("Could not update app lock settings."));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setError(null);
    setNotice(null);
    if (!currentPassword) {
      setError(t("Enter your current master password to disable app lock."));
      return;
    }
    setBusy(true);
    try {
      const next = await configureAppLock({
        currentPassword,
        enabled: false,
      });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      applyStatus(next);
      setNotice(t("Local app master password lock disabled."));
    } catch (err) {
      setError(err instanceof AppLockApiError ? err.message : t("Could not disable app lock."));
    } finally {
      setBusy(false);
    }
  };

  const handleLockNow = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await lockAppNow();
      applyStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not lock application."));
    } finally {
      setBusy(false);
    }
  };

  const formatIdleOption = (minutes: number) =>
    minutes === 0
      ? t("Never (manual & startup only)")
      : t("After {minutes} minutes of inactivity", { minutes });

  return (
    <section className="settings-card app-lock-settings" data-app-lock-settings="true">
      <header>
        <AppIcon name="lock" className="sm" />
        <h2>{t("App master password lock")}</h2>
        <span className={`chip ${status?.enabled ? "app-lock-chip-on" : ""}`}>
          {loading ? t("Loading…") : status?.enabled ? t("Enabled") : t("Disabled")}
        </span>
      </header>
      <div className="card-body">
        <p className="app-lock-desc">
          {t(
            "Protect this workstation with an optional local master password (Ctrl+Shift+L to lock anytime, plus idle auto-lock).",
          )}
        </p>

        <div className="app-lock-info-box">
          <strong>{t("Privacy lock & DPAPI boundary")}</strong>
          <p>
            {t(
              "App lock is an interactive privacy screen stored globally in app-lock.json (never included in single-workspace backups). It complements—rather than replaces—Windows DPAPI + AES-256-GCM storage encryption. Locking never kills already running browser windows.",
            )}
          </p>
          <p className="app-lock-reset-note">
            {t(
              "Local recovery: if you forget this password, close the app and delete app-lock.json in your local data directory under your OS account; your profile data stays intact.",
            )}
          </p>
        </div>

        {error && (
          <div className="app-lock-alert danger" role="alert">
            <AppIcon name="alert" className="sm" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="app-lock-alert success" role="status">
            <AppIcon name="check" className="sm" />
            <span>{notice}</span>
          </div>
        )}

        {!loading && !status?.enabled && (
          <form className="app-lock-settings-form" onSubmit={handleSetup}>
            <div className="app-lock-grid">
              <label className="fld">
                <span>{t("Master password (6–128 characters)")}</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={setupPassword}
                  disabled={busy}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  placeholder={t("Enter new master password")}
                />
              </label>
              <label className="fld">
                <span>{t("Confirm master password")}</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={setupConfirm}
                  disabled={busy}
                  onChange={(e) => setSetupConfirm(e.target.value)}
                  placeholder={t("Re-enter master password")}
                />
              </label>
            </div>

            <div className="app-lock-grid">
              <label className="fld">
                <span>{t("Idle auto-lock")}</span>
                <select
                  className="select"
                  value={idleMinutes}
                  disabled={busy}
                  onChange={(e) => setIdleMinutes(Number(e.target.value))}
                >
                  {IDLE_TIMEOUT_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {formatIdleOption(minutes)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="app-lock-checkbox">
                <input
                  type="checkbox"
                  checked={lockOnStartup}
                  disabled={busy}
                  onChange={(e) => setLockOnStartup(e.target.checked)}
                />
                <span>{t("Require password on app startup")}</span>
              </label>
            </div>

            <div className="app-lock-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                <AppIcon name="lock" className="sm" />
                {busy ? t("Saving…") : t("Enable app lock")}
              </button>
            </div>
          </form>
        )}

        {!loading && status?.enabled && (
          <form className="app-lock-settings-form" onSubmit={handleUpdate}>
            <div className="app-lock-quickbar">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void handleLockNow()}
              >
                <AppIcon name="lock" className="sm" />
                {t("Lock now (Ctrl+Shift+L)")}
              </button>
            </div>

            <label className="fld">
              <span>{t("Current master password (required for changes)")}</span>
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                value={currentPassword}
                disabled={busy}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t("Enter current master password")}
              />
            </label>

            <div className="app-lock-grid">
              <label className="fld">
                <span>{t("New master password (optional)")}</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={newPassword}
                  disabled={busy}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t("Leave blank to keep current password")}
                />
              </label>
              <label className="fld">
                <span>{t("Confirm new password")}</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={newPasswordConfirm}
                  disabled={busy}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  placeholder={t("Re-enter new password")}
                />
              </label>
            </div>

            <div className="app-lock-grid">
              <label className="fld">
                <span>{t("Idle auto-lock")}</span>
                <select
                  className="select"
                  value={idleMinutes}
                  disabled={busy}
                  onChange={(e) => setIdleMinutes(Number(e.target.value))}
                >
                  {IDLE_TIMEOUT_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {formatIdleOption(minutes)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="app-lock-checkbox">
                <input
                  type="checkbox"
                  checked={lockOnStartup}
                  disabled={busy}
                  onChange={(e) => setLockOnStartup(e.target.checked)}
                />
                <span>{t("Require password on app startup")}</span>
              </label>
            </div>

            <div className="app-lock-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? t("Saving…") : t("Save lock settings")}
              </button>
              <button
                type="button"
                className="btn ghost danger-text"
                disabled={busy}
                onClick={() => void handleDisable()}
              >
                {t("Disable app lock")}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
