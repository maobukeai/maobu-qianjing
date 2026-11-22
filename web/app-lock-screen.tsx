import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  AppLockApiError,
  unlockAppLock,
  type AppLockStatus,
} from "./app-lock-api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./app-lock.css";

export interface AppLockScreenProps {
  status: AppLockStatus;
  onUnlocked: (nextStatus: AppLockStatus) => void;
  onRefreshStatus?: () => Promise<AppLockStatus | null> | void;
}

function remainingSeconds(cooldownUntil: number): number {
  const diff = cooldownUntil - Date.now();
  return diff > 0 ? Math.ceil(diff / 1000) : 0;
}

export function AppLockScreen({ status, onUnlocked, onRefreshStatus }: AppLockScreenProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(status.cooldownUntil);
  const [cooldownSec, setCooldownSec] = useState(() => remainingSeconds(status.cooldownUntil));
  const [failedAttempts, setFailedAttempts] = useState(status.failedAttempts);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCooldownUntil(status.cooldownUntil);
    setCooldownSec(remainingSeconds(status.cooldownUntil));
    setFailedAttempts(status.failedAttempts);
  }, [status.cooldownUntil, status.failedAttempts]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) {
      setCooldownSec(0);
      return;
    }
    setCooldownSec(remainingSeconds(cooldownUntil));
    const timer = setInterval(() => {
      const left = remainingSeconds(cooldownUntil);
      setCooldownSec(left);
      if (left <= 0) {
        clearInterval(timer);
        void onRefreshStatus?.();
      }
    }, 500);
    return () => clearInterval(timer);
  }, [cooldownUntil, onRefreshStatus]);

  useEffect(() => {
    if (!status.corrupt && cooldownSec === 0) {
      inputRef.current?.focus();
    }
  }, [status.corrupt, cooldownSec]);

  if (!status.locked) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || status.corrupt || cooldownSec > 0) return;
    if (!password) {
      setError(t("Enter your master password to unlock."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await unlockAppLock(password);
      setPassword("");
      onUnlocked(next);
    } catch (err) {
      setPassword("");
      if (err instanceof AppLockApiError) {
        if (typeof err.failedAttempts === "number") setFailedAttempts(err.failedAttempts);
        if (typeof err.cooldownUntil === "number" && err.cooldownUntil > Date.now()) {
          setCooldownUntil(err.cooldownUntil);
          setCooldownSec(remainingSeconds(err.cooldownUntil));
        }
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t("Could not unlock application."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="app-lock-backdrop"
      data-app-lock-screen="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
    >
      <div className="app-lock-card">
        <div className="app-lock-badge">
          <AppIcon name="lock" className="lg" />
        </div>
        <h1 id="app-lock-title" className="app-lock-title">
          {t("Application locked")}
        </h1>
        <p className="app-lock-subtitle">
          {t("Enter your local master password to resume profile management.")}
        </p>

        {status.corrupt ? (
          <div className="app-lock-alert danger" role="alert">
            <AppIcon name="alert" className="sm" />
            <span>
              {t(
                "App lock configuration is damaged. Close the app and delete app-lock.json in your local data directory to reset.",
              )}
            </span>
          </div>
        ) : (
          <form className="app-lock-form" onSubmit={submit}>
            <label className="app-lock-field">
              <span>{t("Master password")}</span>
              <div className="app-lock-input-row">
                <input
                  ref={inputRef}
                  type={showPassword ? "text" : "password"}
                  className="input"
                  autoComplete="current-password"
                  value={password}
                  disabled={busy || cooldownSec > 0}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("Enter master password")}
                  aria-label={t("Master password")}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowPassword((value) => !value)}
                  disabled={busy}
                >
                  {showPassword ? t("Hide") : t("Show")}
                </button>
              </div>
            </label>

            {cooldownSec > 0 && (
              <div className="app-lock-alert warn" role="alert" data-app-lock-cooldown="true">
                <AppIcon name="warning" className="sm" />
                <span>
                  {t("Too many failed attempts. Try again in {seconds}s.", { seconds: cooldownSec })}
                </span>
              </div>
            )}

            {error && cooldownSec === 0 && (
              <div className="app-lock-alert danger" role="alert">
                <AppIcon name="alert" className="sm" />
                <span>
                  {error}
                  {failedAttempts > 0
                    ? ` (${t("{count} failed attempts", { count: failedAttempts })})`
                    : ""}
                </span>
              </div>
            )}

            <button
              type="submit"
              className="btn primary app-lock-submit"
              disabled={busy || cooldownSec > 0}
            >
              <AppIcon name="lock" className="sm" />
              {busy ? t("Verifying…") : t("Unlock")}
            </button>
          </form>
        )}

        <div className="app-lock-boundary">
          <p>
            {t(
              "Running browser windows stay open to protect active web sessions, while dashboard actions, 2FA, and edits remain blocked.",
            )}
          </p>
        </div>

        <div className="app-lock-recovery">
          <button
            type="button"
            className="app-lock-recovery-toggle"
            aria-expanded={recoveryOpen}
            onClick={() => setRecoveryOpen((open) => !open)}
          >
            <span>{t("Forgot master password?")}</span>
            <AppIcon name={recoveryOpen ? "chevronUp" : "chevronDown"} className="sm" />
          </button>
          {recoveryOpen && (
            <div className="app-lock-recovery-body">
              <p>
                {t(
                  "App lock is a local interactive privacy lock and does not replace Windows DPAPI + AES-256-GCM storage encryption.",
                )}
              </p>
              <p>
                {t(
                  "To reset on this machine: close the application, delete app-lock.json in your local data directory under your OS account, and reopen. Your profiles remain intact.",
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
