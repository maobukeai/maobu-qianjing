import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  AppLockApiError,
  configureAppLock,
  fetchAppLockStatus,
  lockAppNow,
  setupAppLock,
  type AppLockStatus,
} from "./app-lock-api.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./app-lock.css";

const IDLE_TIMEOUT_OPTIONS = [0, 5, 15, 30, 60] as const;

export interface AppLockSettingsProps {
  active?: boolean;
  status?: AppLockStatus | null;
  onStatusChange?: (status: AppLockStatus) => void;
  beginStatusChange?: () => (status: AppLockStatus) => boolean;
}

export function AppLockSettings({ active = true, status: externalStatus, onStatusChange, beginStatusChange }: AppLockSettingsProps) {
  const { t } = useTranslation();
  const [internalStatus, setInternalStatus] = useState<AppLockStatus | null>(externalStatus ?? null);
  const [loading, setLoading] = useState(externalStatus === undefined);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Setup fields
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [idleMinutes, setIdleMinutes] = useState(externalStatus?.idleTimeoutMinutes ?? 15);
  const [lockOnStartup, setLockOnStartup] = useState(externalStatus?.lockOnStartup ?? true);

  // Configure / Disable fields
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  const standalone = externalStatus === undefined;
  const status = standalone ? internalStatus : externalStatus;
  const savedIdleMinutes = status?.idleTimeoutMinutes;
  const savedLockOnStartup = status?.lockOnStartup;
  const optionsEdited = !!status && (idleMinutes !== savedIdleMinutes || lockOnStartup !== savedLockOnStartup);
  const keepCredentials = active && !!status && !status.locked;
  const passwordEdited = Boolean(status?.enabled ? currentPassword || newPassword || newPasswordConfirm : setupPassword || setupConfirm);
  useDesktopCloseDraft("app-lock-settings", { dirty: optionsEdited || (keepCredentials && passwordEdited), busy });

  useLayoutEffect(() => {
    if (keepCredentials) return;
    setSetupPassword("");
    setSetupConfirm("");
    setCurrentPassword("");
    setNewPassword("");
    setNewPasswordConfirm("");
  }, [keepCredentials]);

  useEffect(() => {
    if (savedIdleMinutes !== undefined) setIdleMinutes(savedIdleMinutes);
    if (savedLockOnStartup !== undefined) setLockOnStartup(savedLockOnStartup);
  }, [savedIdleMinutes, savedLockOnStartup]);

  const applyStatus = useCallback(
    (next: AppLockStatus, acceptStatus?: (status: AppLockStatus) => boolean) => {
      if (acceptStatus && !acceptStatus(next)) return;
      setInternalStatus(next);
      setIdleMinutes(next.idleTimeoutMinutes);
      setLockOnStartup(next.lockOnStartup);
      if (!acceptStatus) onStatusChange?.(next);
    },
    [onStatusChange],
  );

  useEffect(() => {
    if (!standalone) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchAppLockStatus(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setInternalStatus(next);
        setError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load app lock status.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [standalone, statusAttempt]);

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
      const acceptStatus = beginStatusChange?.();
      const next = await setupAppLock({
        password: setupPassword,
        idleTimeoutMinutes: idleMinutes,
        lockOnStartup,
      });
      setSetupPassword("");
      setSetupConfirm("");
      applyStatus(next, acceptStatus);
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
      const acceptStatus = beginStatusChange?.();
      const next = await configureAppLock({
        currentPassword,
        idleTimeoutMinutes: idleMinutes,
        lockOnStartup,
        ...(newPassword ? { newPassword } : {}),
      });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      applyStatus(next, acceptStatus);
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
      const acceptStatus = beginStatusChange?.();
      const next = await configureAppLock({
        currentPassword,
        enabled: false,
      });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      applyStatus(next, acceptStatus);
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
      const acceptStatus = beginStatusChange?.();
      const next = await lockAppNow();
      applyStatus(next, acceptStatus);
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

  const idleField = (
    <label className="fld app-lock-idle-fld">
      <span>{t("Idle auto-lock")}</span>
      <select
        className="select"
        value={idleMinutes}
        disabled={busy}
        onChange={(event) => setIdleMinutes(Number(event.target.value))}
      >
        {IDLE_TIMEOUT_OPTIONS.map(minutes => (
          <option key={minutes} value={minutes}>{formatIdleOption(minutes)}</option>
        ))}
      </select>
    </label>
  );

  const startupCheckbox = (
    <label className="app-lock-checkbox">
      <input
        type="checkbox"
        checked={lockOnStartup}
        disabled={busy}
        onChange={(event) => setLockOnStartup(event.target.checked)}
      />
      <span>{t("Lock on startup")}</span>
    </label>
  );

  const lockOptions = (
    <div className="app-lock-grid app-lock-options">
      {idleField}
      {startupCheckbox}
    </div>
  );

  return (
    <section className="settings-card app-lock-settings" data-app-lock-settings="true">
      <header>
        <AppIcon name="lock" className="sm" />
        <h2>{t("App lock")}</h2>
        <span className={`chip ${status?.enabled ? "app-lock-chip-on" : ""}`}>
          {t(loading ? "Loading…" : !status ? "Unavailable" : status.enabled ? "Enabled" : "Disabled")}
        </span>
      </header>
      <div className="card-body">
        {error && !loading && (
          <div className="app-lock-alert danger" role="alert">
            <AppIcon name="alert" className="sm" />
            <span>{t(error)}</span>
          </div>
        )}
        {standalone && !status && error && (
          <div className="app-lock-actions">
            <button type="button" className="btn" disabled={loading} aria-busy={loading} onClick={() => setStatusAttempt(attempt => attempt + 1)}>
              {t("Try again")}
            </button>
          </div>
        )}
        {notice && (
          <div className="app-lock-alert success" role="status">
            <AppIcon name="check" className="sm" />
            <span>{notice}</span>
          </div>
        )}

        {!loading && status?.enabled === false && (
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
                />
              </label>
            </div>

            <div className="app-lock-options app-lock-setup-bar">
              {idleField}
              {startupCheckbox}
              <div className="app-lock-actions app-lock-setup-actions">
                <button type="submit" className="btn primary" disabled={busy}>
                  <AppIcon name="lock" className="sm" />
                  {busy ? t("Saving…") : t("Enable app lock")}
                </button>
              </div>
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
                aria-keyshortcuts="Control+Shift+L"
                onClick={() => void handleLockNow()}
              >
                <AppIcon name="lock" className="sm" />
                {t("Lock now")}
              </button>
              <kbd aria-hidden="true">Ctrl+Shift+L</kbd>
            </div>

            {lockOptions}

            <label className="fld">
              <span>{t("Current master password (required for changes)")}</span>
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                value={currentPassword}
                disabled={busy}
                onChange={(e) => setCurrentPassword(e.target.value)}
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
                />
              </label>
            </div>

            <div className="app-lock-actions app-lock-configured-actions">
              <button
                type="button"
                className="btn ghost app-lock-disable"
                disabled={busy}
                onClick={() => void handleDisable()}
              >
                {t("Disable app lock")}
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? t("Saving…") : t("Save lock settings")}
              </button>
            </div>
          </form>
        )}

        <details className="app-lock-info-box">
          <summary>
            <span>{t("Recovery and storage")}</span>
            <AppIcon name="chevronDown" className="sm" />
          </summary>
          <p>
            {t(
              "To reset on this machine: close the application, delete app-lock.json in your local data directory under your OS account, and reopen. Your profiles remain intact.",
            )}
          </p>
          <p>
            {t(
              "App lock is an interactive privacy screen stored globally in app-lock.json (never included in single-workspace backups). It complements—rather than replaces—Windows DPAPI + AES-256-GCM storage encryption. Locking never kills already running browser windows.",
            )}
          </p>
        </details>
      </div>
    </section>
  );
}
