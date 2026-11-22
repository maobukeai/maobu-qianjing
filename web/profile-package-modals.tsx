import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import {
  exportProfilePackage,
  importProfilePackage,
  isMqProfileFile,
  previewProfilePackage,
  type ProfilePackageConflictReason,
  type ProfilePackageConflictStrategy,
  type ProfilePackageExportProgress,
  type ProfilePackageExportSummary,
  type ProfilePackageImportResult,
  type ProfilePackagePreview,
} from "./profile-package-api.ts";
import { AppIcon, ModalDialog } from "./ui-primitives.tsx";
import "./profile-package-modals.css";

const MIN_PASSWORD_BYTES = 10;
const MAX_PASSWORD_BYTES = 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface ProfilePackageExportModalProps {
  open: boolean;
  selectedIds: readonly string[];
  onClose: () => void;
  onExported?: (summary: ProfilePackageExportSummary) => void;
}

/** Modal to export 1..2000 selected environments into a password-encrypted `.mqprofile` package. */
export function ProfilePackageExportModal({
  open,
  selectedIds,
  onClose,
  onExported,
}: ProfilePackageExportModalProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [includeSessions, setIncludeSessions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProfilePackageExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      setIncludeSecrets(true);
      setIncludeSessions(true);
      setBusy(false);
      setProgress(null);
      setError(null);
    }
  }, [open]);

  const passwordBytes = useMemo(() => utf8ByteLength(password), [password]);
  const passwordValid = passwordBytes >= MIN_PASSWORD_BYTES && passwordBytes <= MAX_PASSWORD_BYTES;
  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmit = !busy && selectedIds.length > 0 && passwordValid && passwordsMatch;

  async function handleExport() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setProgress({ completed: 0, total: selectedIds.length });
    try {
      const summary = await exportProfilePackage(
        {
          ids: [...selectedIds],
          password,
          includeSecrets,
          includeSessions,
        },
        (next) => setProgress(next),
      );
      onExported?.(summary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="md"
      title={t("Export encrypted profile package (.mqprofile)")}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canSubmit}
            onClick={() => void handleExport()}
          >
            <AppIcon name="lock" className="sm" />
            {busy ? t("Encrypting package…") : t("Export {count} environments", { count: selectedIds.length })}
          </button>
        </>
      }
    >
      <div className="pkg-modal-stack">
        <p className="pkg-modal-intro">
          {t("Protect {count} selected environment(s) with AES-256-GCM encryption for portable transfer.", {
            count: selectedIds.length,
          })}
        </p>

        <div className="pkg-field">
          <label className="pkg-field-label" htmlFor="pkg-export-password">
            {t("Encryption password")}
          </label>
          <div className="pkg-password-row">
            <input
              id="pkg-export-password"
              type={showPassword ? "text" : "password"}
              value={password}
              disabled={busy}
              autoComplete="new-password"
              placeholder={t("At least 10 characters")}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className="btn ghost xs"
              disabled={busy}
              onClick={() => setShowPassword((prev) => !prev)}
            >
              {t(showPassword ? "Hide" : "Show")}
            </button>
          </div>
          <span className={`pkg-field-hint${password.length > 0 && !passwordValid ? " is-error" : ""}`}>
            {t("Password must be 10–1024 UTF-8 bytes ({bytes} bytes).", { bytes: passwordBytes })}
          </span>
        </div>

        <div className="pkg-field">
          <label className="pkg-field-label" htmlFor="pkg-export-confirm">
            {t("Confirm password")}
          </label>
          <input
            id="pkg-export-confirm"
            type={showPassword ? "text" : "password"}
            value={confirmPassword}
            disabled={busy}
            autoComplete="new-password"
            placeholder={t("Re-enter encryption password")}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSubmit) {
                event.preventDefault();
                void handleExport();
              }
            }}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <span className="pkg-field-hint is-error">{t("Passwords do not match.")}</span>
          )}
        </div>

        <div className="pkg-options">
          <label className="pkg-checkbox">
            <input
              type="checkbox"
              checked={includeSecrets}
              disabled={busy}
              onChange={(event) => setIncludeSecrets(event.target.checked)}
            />
            <span>{t("Include credentials & proxy authentication")}</span>
          </label>
          <label className="pkg-checkbox">
            <input
              type="checkbox"
              checked={includeSessions}
              disabled={busy}
              onChange={(event) => setIncludeSessions(event.target.checked)}
            />
            <span>{t("Include saved browser sessions (captures open browsers first)")}</span>
          </label>
        </div>

        {busy && progress && (
          <div className="pkg-progress" role="status">
            <div className="pkg-progress-bar">
              <div
                className="pkg-progress-fill"
                style={{
                  width: `${progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0}%`,
                }}
              />
            </div>
            <span>
              {t("Preparing environments: {completed} / {total}", {
                completed: progress.completed,
                total: progress.total,
              })}
            </span>
          </div>
        )}

        {error && (
          <p className="pkg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </ModalDialog>
  );
}

export interface ProfilePackageImportModalProps {
  open: boolean;
  initialFile?: File | null;
  onClose: () => void;
  onImported?: (result: ProfilePackageImportResult) => void;
}

function conflictLabel(reason: ProfilePackageConflictReason | null): string {
  switch (reason) {
    case "running":
      return "Running";
    case "existing_trashed":
      return "In Trash";
    case "existing_active":
      return "Existing";
    default:
      return "New";
  }
}

/** Modal to decrypt, preview conflicts, choose strategy, and atomically import a `.mqprofile` package. */
export function ProfilePackageImportModal({
  open,
  initialFile = null,
  onClose,
  onImported,
}: ProfilePackageImportModalProps) {
  const { t, language } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(initialFile);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [preview, setPreview] = useState<ProfilePackagePreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<ProfilePackageConflictStrategy>("skip");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [receipt, setReceipt] = useState<ProfilePackageImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(initialFile ?? null);
      setPassword("");
      setShowPassword(false);
      setPreview(null);
      setSelectedIds(new Set());
      setStrategy("skip");
      setConfirmOverwrite(false);
      setReceipt(null);
      setBusy(false);
      setError(null);
      setDragActive(false);
    }
  }, [open, initialFile]);

  const handleSelectFile = useCallback(
    (next: File | null) => {
      if (!next) return;
      if (!isMqProfileFile(next)) {
        setError(t("Choose a .mqprofile encrypted environment package."));
        return;
      }
      setFile(next);
      setPreview(null);
      setReceipt(null);
      setError(null);
    },
    [t],
  );

  async function handleDecryptPreview() {
    if (!file || busy) return;
    if (utf8ByteLength(password) < MIN_PASSWORD_BYTES) {
      setError(t("Password must be 10–1024 UTF-8 bytes ({bytes} bytes).", { bytes: utf8ByteLength(password) }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextPreview = await previewProfilePackage(file, password);
      setPreview(nextPreview);
      setSelectedIds(new Set(nextPreview.profiles.map((item) => item.id)));
      setStrategy(nextPreview.conflictCount > 0 ? "clone_new_id" : "skip");
      setConfirmOverwrite(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportCommit() {
    if (!preview || busy || selectedIds.size === 0) return;
    if (strategy === "overwrite_closed" && !confirmOverwrite) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importProfilePackage({
        previewId: preview.previewId,
        previewToken: preview.previewToken,
        strategy,
        selectedIds: Array.from(selectedIds),
        ...(strategy === "overwrite_closed" ? { confirmOverwrite: true } : {}),
      });
      setReceipt(result);
      onImported?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = !!preview && preview.profiles.length > 0 && selectedIds.size === preview.profiles.length;
  const overwriteBlocked = strategy === "overwrite_closed" && !confirmOverwrite;

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      busy={busy}
      size={preview ? "lg" : "md"}
      title={t("Import encrypted profile package (.mqprofile)")}
      footer={
        receipt ? (
          <button type="button" className="btn primary" onClick={onClose}>
            {t("Done")}
          </button>
        ) : preview ? (
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
            >
              {t("Back")}
            </button>
            <button
              type="button"
              className={strategy === "overwrite_closed" ? "btn danger" : "btn primary"}
              disabled={busy || selectedIds.size === 0 || overwriteBlocked}
              onClick={() => void handleImportCommit()}
            >
              <AppIcon name="fileImport" className="sm" />
              {busy
                ? t("Importing package…")
                : t("Import {count} environments", { count: selectedIds.size })}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !file || utf8ByteLength(password) < MIN_PASSWORD_BYTES}
              onClick={() => void handleDecryptPreview()}
            >
              <AppIcon name="key" className="sm" />
              {busy ? t("Decrypting…") : t("Decrypt & preview")}
            </button>
          </>
        )
      }
    >
      <div className="pkg-modal-stack">
        {receipt ? (
          <div className="pkg-receipt" role="status">
            <div className="pkg-summary-grid">
              <div className="pkg-stat">
                <span>{t("Imported")}</span>
                <strong>{receipt.importedCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("Cloned")}</span>
                <strong>{receipt.clonedCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("Overwritten")}</span>
                <strong>{receipt.overwrittenCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("Skipped")}</span>
                <strong>{receipt.skippedCount}</strong>
              </div>
            </div>
            <ul className="pkg-receipt-list">
              {receipt.items.slice(0, 50).map((item) => (
                <li key={`${item.sourceId}-${item.targetId ?? "skip"}`}>
                  <span className="pkg-mono">{item.targetId ?? item.sourceId}</span>
                  <span className="pkg-receipt-name">{item.name}</span>
                  <span className={`pkg-badge is-${item.action}`}>{t(item.action)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : preview ? (
          <>
            <div className="pkg-summary-grid">
              <div className="pkg-stat">
                <span>{t("Total in package")}</span>
                <strong>{preview.profileCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("New")}</span>
                <strong>{preview.newCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("Conflicts")}</span>
                <strong>{preview.conflictCount}</strong>
              </div>
              <div className="pkg-stat">
                <span>{t("Saved sessions")}</span>
                <strong>{preview.sessionCount}</strong>
              </div>
            </div>

            <div className="pkg-meta-line">
              <span>
                {t("Exported {time}", { time: new Date(preview.exportedAt).toLocaleString(language) })}
              </span>
              <span>
                {t(preview.includeSecrets ? "Contains encrypted credentials" : "Credentials stripped")}
              </span>
            </div>

            {preview.conflictCount > 0 && (
              <fieldset className="pkg-strategy-group">
                <legend>{t("Conflict resolution strategy")}</legend>
                <label className={`pkg-strategy-option${strategy === "skip" ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="pkg-strategy"
                    value="skip"
                    checked={strategy === "skip"}
                    disabled={busy}
                    onChange={() => {
                      setStrategy("skip");
                      setConfirmOverwrite(false);
                    }}
                  />
                  <div>
                    <strong>{t("Skip conflicts")}</strong>
                    <span>{t("Keep existing environments untouched and import only new IDs.")}</span>
                  </div>
                </label>
                <label className={`pkg-strategy-option${strategy === "clone_new_id" ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="pkg-strategy"
                    value="clone_new_id"
                    checked={strategy === "clone_new_id"}
                    disabled={busy}
                    onChange={() => {
                      setStrategy("clone_new_id");
                      setConfirmOverwrite(false);
                    }}
                  />
                  <div>
                    <strong>{t("Clone with new ID (Recommended)")}</strong>
                    <span>{t("Allocate new IDs and remap sessions so existing environments stay safe.")}</span>
                  </div>
                </label>
                <label className={`pkg-strategy-option is-danger${strategy === "overwrite_closed" ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="pkg-strategy"
                    value="overwrite_closed"
                    checked={strategy === "overwrite_closed"}
                    disabled={busy}
                    onChange={() => setStrategy("overwrite_closed")}
                  />
                  <div>
                    <strong>{t("Overwrite closed profiles")}</strong>
                    <span>{t("Replace matching closed environments. Running and trashed profiles are always skipped.")}</span>
                  </div>
                </label>

                {strategy === "overwrite_closed" && (
                  <label className="pkg-overwrite-confirm">
                    <input
                      type="checkbox"
                      checked={confirmOverwrite}
                      disabled={busy}
                      onChange={(event) => setConfirmOverwrite(event.target.checked)}
                    />
                    <span>
                      {t("I confirm overwriting closed environments with package data (running and trashed environments are still skipped).")}
                    </span>
                  </label>
                )}
              </fieldset>
            )}

            <div className="pkg-preview-table-wrap">
              <table className="pkg-preview-table">
                <thead>
                  <tr>
                    <th className="pkg-col-check">
                      <input
                        type="checkbox"
                        aria-label={t("Select all package environments")}
                        checked={allSelected}
                        disabled={busy}
                        onChange={(event) =>
                          setSelectedIds(
                            event.target.checked
                              ? new Set(preview.profiles.map((item) => item.id))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th>{t("Name")}</th>
                    <th>ID</th>
                    <th>{t("Group")}</th>
                    <th>{t("Proxy")}</th>
                    <th>{t("Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.profiles.map((item) => {
                    const checked = selectedIds.has(item.id);
                    return (
                      <tr key={item.id}>
                        <td className="pkg-col-check">
                          <input
                            type="checkbox"
                            aria-label={t("Select {profile}", { profile: item.name || item.id })}
                            checked={checked}
                            disabled={busy}
                            onChange={(event) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (event.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td>
                          <div className="pkg-name-cell">
                            <span>{item.name || item.id}</span>
                            {item.hasSession && <span className="pkg-pill">{t("Session")}</span>}
                          </div>
                        </td>
                        <td className="pkg-mono">{item.id}</td>
                        <td>{item.group || t("Ungrouped")}</td>
                        <td className="pkg-mono">{item.proxyDisplay || t("None")}</td>
                        <td>
                          <span className={`pkg-badge is-${item.conflictReason ?? "new"}`}>
                            {t(conflictLabel(item.conflictReason))}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div
              className={`pkg-dropzone${dragActive ? " is-drag" : ""}${file ? " has-file" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const dropped = event.dataTransfer.files?.[0] ?? null;
                handleSelectFile(dropped);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".mqprofile"
                hidden
                onChange={(event) => handleSelectFile(event.target.files?.[0] ?? null)}
              />
              <AppIcon name="lock" className="pkg-drop-icon" />
              {file ? (
                <div className="pkg-selected-file">
                  <strong>{file.name}</strong>
                  <span>{`${Math.max(1, Math.round(file.size / 1024))} KiB`}</span>
                </div>
              ) : (
                <p>{t("Drop a .mqprofile file here or browse to select one.")}</p>
              )}
              <button
                type="button"
                className="btn xs"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t(file ? "Change file" : "Choose .mqprofile file")}
              </button>
            </div>

            <div className="pkg-field">
              <label className="pkg-field-label" htmlFor="pkg-import-password">
                {t("Package password")}
              </label>
              <div className="pkg-password-row">
                <input
                  id="pkg-import-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  disabled={busy}
                  autoComplete="current-password"
                  placeholder={t("Enter the password used during export")}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && file && utf8ByteLength(password) >= MIN_PASSWORD_BYTES) {
                      event.preventDefault();
                      void handleDecryptPreview();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn ghost xs"
                  disabled={busy}
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {t(showPassword ? "Hide" : "Show")}
                </button>
              </div>
            </div>
          </>
        )}

        {error && (
          <p className="pkg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </ModalDialog>
  );
}

/** Convenience hook for global `.mqprofile` drag-and-drop detection on the workbench host. */
export function useMqProfileDrop(onPackageFile: (file: File) => void, enabled = true): void {
  const callbackRef = useRef(onPackageFile);
  callbackRef.current = onPackageFile;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onDragOver = (event: DragEvent) => {
      const items = event.dataTransfer?.items;
      if (!items || items.length === 0) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          event.preventDefault();
          return;
        }
      }
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const pkgFile = Array.from(files).find((candidate) => isMqProfileFile(candidate));
      if (!pkgFile) return;
      event.preventDefault();
      callbackRef.current(pkgFile);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled]);
}
