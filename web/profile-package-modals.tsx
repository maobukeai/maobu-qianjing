import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import {
  exportProfilePackage,
  importProfilePackage,
  isMqProfileFile,
  previewProfilePackage,
  ProfilePackageImportError,
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
const RECEIPT_PAGE_SIZE = 50;

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
  const activeExport = useRef<symbol | null>(null);
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
    return () => { activeExport.current = null; };
  }, [open]);

  const passwordBytes = useMemo(() => utf8ByteLength(password), [password]);
  const passwordValid = passwordBytes >= MIN_PASSWORD_BYTES && passwordBytes <= MAX_PASSWORD_BYTES;
  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmit = !busy && selectedIds.length > 0 && passwordValid && passwordsMatch;

  async function handleExport() {
    if (!canSubmit || activeExport.current !== null) return;
    const request = Symbol();
    activeExport.current = request;
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
        (next) => { if (activeExport.current === request) setProgress(next); },
      );
      if (activeExport.current !== request) return;
      onExported?.(summary);
      onClose();
    } catch (err) {
      if (activeExport.current === request) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (activeExport.current === request) {
        activeExport.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      closeOnBackdrop={false}
      busy={busy}
      size="md"
      className="profile-package-dialog"
      title={<><span className="modal-title-icon"><AppIcon name="lock" /></span>{t("Export encrypted profile package (.mqprofile)")}</>}
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
              aria-describedby="pkg-export-password-hint"
              aria-invalid={password.length > 0 && !passwordValid || undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className="btn ghost xs"
              disabled={busy}
              aria-controls="pkg-export-password pkg-export-confirm"
              onClick={() => setShowPassword((prev) => !prev)}
            >
              {t(showPassword ? "Hide" : "Show")}
            </button>
          </div>
          <span id="pkg-export-password-hint" className={`pkg-field-hint${password.length > 0 && !passwordValid ? " is-error" : ""}`}>
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
            aria-invalid={confirmPassword.length > 0 && !passwordsMatch || undefined}
            aria-describedby={confirmPassword.length > 0 && !passwordsMatch ? "pkg-export-confirm-hint" : undefined}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && canSubmit) {
                event.preventDefault();
                void handleExport();
              }
            }}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <span id="pkg-export-confirm-hint" className="pkg-field-hint is-error">{t("Passwords do not match.")}</span>
          )}
        </div>

        <fieldset className="pkg-options" disabled={busy}>
          <legend>{t("Include in package")}</legend>
          <label className="pkg-checkbox">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(event) => setIncludeSecrets(event.target.checked)}
            />
            <span>{t("Include credentials & proxy authentication")}</span>
          </label>
          <label className="pkg-checkbox">
            <input
              type="checkbox"
              checked={includeSessions}
              onChange={(event) => setIncludeSessions(event.target.checked)}
            />
            <span>{t("Include saved browser sessions (captures open browsers first)")}</span>
          </label>
        </fieldset>

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
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const receiptHeadingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<"password" | "review" | "retry" | "receipt" | null>(null);
  const activeRequest = useRef<symbol | null>(null);
  const [file, setFile] = useState<File | null>(initialFile);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [preview, setPreview] = useState<ProfilePackagePreview | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<ProfilePackageConflictStrategy>("skip");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [receipt, setReceipt] = useState<ProfilePackageImportResult | null>(null);
  const [receiptLimit, setReceiptLimit] = useState(RECEIPT_PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    setFile(open ? initialFile : null);
    setPassword("");
    setShowPassword(false);
    setPreview(null);
    setPreviewStale(false);
    setSelectedIds(new Set());
    setStrategy("skip");
    setConfirmOverwrite(false);
    setReceipt(null);
    setReceiptLimit(RECEIPT_PAGE_SIZE);
    setBusy(false);
    setError(null);
    setDragActive(false);
    return () => {
      activeRequest.current = null;
      pendingFocus.current = null;
    };
  }, [open, initialFile]);

  const passwordBytes = utf8ByteLength(password);
  const validPassword = passwordBytes >= MIN_PASSWORD_BYTES && passwordBytes <= MAX_PASSWORD_BYTES;
  const closeImport = () => { if (activeRequest.current === null) onClose(); };

  const handleSelectFile = useCallback(
    (next: File | null) => {
      if (!next || activeRequest.current !== null) return;
      if (!isMqProfileFile(next)) {
        setError(t("Choose a .mqprofile encrypted environment package."));
        return;
      }
      setFile(next);
      setPreview(null);
      setPreviewStale(false);
      setReceipt(null);
      setError(null);
      passwordInputRef.current?.focus();
    },
    [t],
  );

  async function handleDecryptPreview() {
    if (!file || !validPassword || activeRequest.current !== null) return;
    const request = Symbol();
    activeRequest.current = request;
    setBusy(true);
    setDragActive(false);
    setError(null);
    try {
      const nextPreview = await previewProfilePackage(file, password);
      if (activeRequest.current !== request) return;
      pendingFocus.current = "review";
      setPreview(nextPreview);
      setPreviewStale(false);
      setSelectedIds(new Set(nextPreview.profiles.filter((item) => !previewStale || selectedIds.has(item.id)).map((item) => item.id)));
      setStrategy(nextPreview.conflictCount > 0 ? (previewStale ? strategy : "clone_new_id") : "skip");
      setConfirmOverwrite(false);
    } catch (err) {
      if (activeRequest.current === request) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  async function handleImportCommit() {
    if (!preview || previewStale || activeRequest.current !== null || selectedIds.size === 0) return;
    if (strategy === "overwrite_closed" && !confirmOverwrite) return;
    const request = Symbol();
    activeRequest.current = request;
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
      if (activeRequest.current !== request) return;
      pendingFocus.current = "receipt";
      setFile(null);
      setPassword("");
      setPreview(null);
      setReceipt(result);
      setReceiptLimit(RECEIPT_PAGE_SIZE);
      onImported?.(result);
    } catch (err) {
      if (activeRequest.current !== request) return;
      if (err instanceof ProfilePackageImportError && (err.code === "invalid_preview" || err.code === "preview_target_changed")) {
        pendingFocus.current = "retry";
        setPreviewStale(true);
        setConfirmOverwrite(false);
        setError(t("This package preview is no longer available. Review it again before importing."));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  const allSelected = !!preview && preview.profiles.length > 0 && selectedIds.size === preview.profiles.length;
  const overwriteBlocked = strategy === "overwrite_closed" && !confirmOverwrite;
  const phase = receipt ? "receipt" : previewStale ? "retry" : preview ? "review" : "password";

  useEffect(() => {
    if (!open || busy || !pendingFocus.current) return;
    const controls = { password: passwordInputRef, review: reviewHeadingRef, retry: retryRef, receipt: receiptHeadingRef };
    controls[pendingFocus.current].current?.focus();
    pendingFocus.current = null;
  }, [busy, open, phase]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedIds.size > 0 && !allSelected;
  }, [allSelected, preview, selectedIds.size]);

  return (
    <ModalDialog
      open={open}
      onClose={closeImport}
      closeOnBackdrop={false}
      busy={busy}
      size={preview ? "lg" : "md"}
      className="profile-package-dialog"
      title={<><span className="modal-title-icon"><AppIcon name="lock" /></span>{t("Import encrypted profile package (.mqprofile)")}</>}
      footer={
        <>
          {error && <p className="pkg-error" role="alert">{error}</p>}
          {preview && !previewStale && strategy === "overwrite_closed" && (
            <label className="pkg-overwrite-confirm">
              <input
                type="checkbox"
                checked={confirmOverwrite}
                disabled={busy}
                aria-describedby="pkg-overwrite-guidance"
                onChange={(event) => setConfirmOverwrite(event.target.checked)}
              />
              <span>{t("I confirm replacing closed environments with the same ID.")}</span>
            </label>
          )}
          {receipt ? (
            <button type="button" className="btn primary" onClick={closeImport} disabled={busy}>
              {t("Done")}
            </button>
          ) : preview ? (
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  if (activeRequest.current !== null) return;
                  pendingFocus.current = "password";
                  setPreview(null);
                  setPreviewStale(false);
                  setError(null);
                }}
              >
                {t("Back")}
              </button>
              <button
                ref={previewStale ? retryRef : undefined}
                type="button"
                className={!previewStale && strategy === "overwrite_closed" ? "btn danger" : "btn primary"}
                disabled={busy || (previewStale ? !file || !validPassword : selectedIds.size === 0 || overwriteBlocked)}
                onClick={() => void (previewStale ? handleDecryptPreview() : handleImportCommit())}
              >
                <AppIcon name={previewStale ? "key" : "fileImport"} className="sm" />
                {previewStale ? t(busy ? "Decrypting…" : "Decrypt & preview")
                  : busy ? t("Importing package…") : t("Import {count} environments", { count: selectedIds.size })}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={closeImport} disabled={busy}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !file || !validPassword}
                onClick={() => void handleDecryptPreview()}
              >
                <AppIcon name="key" className="sm" />
                {busy ? t("Decrypting…") : t("Decrypt & preview")}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="pkg-modal-stack">
        {receipt ? (
          <section className="pkg-receipt" aria-labelledby="pkg-receipt-heading">
            <h4 className="pkg-subheading" ref={receiptHeadingRef} id="pkg-receipt-heading" tabIndex={-1}>{t("Package imported")}</h4>
            <dl className="pkg-summary-grid">
              <div className="pkg-stat">
                <dt>{t("Imported")}</dt>
                <dd>{receipt.importedCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("Cloned")}</dt>
                <dd>{receipt.clonedCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("Overwritten")}</dt>
                <dd>{receipt.overwrittenCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("Skipped")}</dt>
                <dd>{receipt.skippedCount}</dd>
              </div>
            </dl>
            {receipt.items.length > 0 && <ul className="pkg-receipt-list" tabIndex={0}>
              {receipt.items.slice(0, receiptLimit).map((item) => (
                <li key={`${item.sourceId}-${item.targetId ?? "skip"}`}>
                  <span className="pkg-receipt-environment">
                    <strong>{item.name || item.targetId || item.sourceId}</strong>
                    {item.name && <span className="pkg-mono">{item.targetId ?? item.sourceId}</span>}
                  </span>
                  <span className={`pkg-badge is-${item.action}`}>{t(item.action)}</span>
                </li>
              ))}
            </ul>}
            {receipt.items.length > receiptLimit && (
              <button type="button" className="btn ghost xs" onClick={() => {
                if (receipt.items.length <= receiptLimit + RECEIPT_PAGE_SIZE) receiptHeadingRef.current?.focus();
                setReceiptLimit((limit) => limit + RECEIPT_PAGE_SIZE);
              }}>
                {t("Show {count} more results", { count: Math.min(RECEIPT_PAGE_SIZE, receipt.items.length - receiptLimit) })}
              </button>
            )}
          </section>
        ) : preview ? (
          <>
            <dl className="pkg-summary-grid">
              <div className="pkg-stat">
                <dt>{t("Total in package")}</dt>
                <dd>{preview.profileCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("New")}</dt>
                <dd>{preview.newCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("Conflicts")}</dt>
                <dd>{preview.conflictCount}</dd>
              </div>
              <div className="pkg-stat">
                <dt>{t("Saved sessions")}</dt>
                <dd>{preview.sessionCount}</dd>
              </div>
            </dl>

            <div className="pkg-meta-line">
              <span>
                {t("Exported {time}", { time: new Date(preview.exportedAt).toLocaleString(language) })}
              </span>
              <span>
                {t(preview.includeSecrets ? "Contains encrypted credentials" : "Credentials stripped")}
              </span>
            </div>

            <section className="pkg-preview-section" aria-labelledby="pkg-review-heading">
              <h4 id="pkg-review-heading" ref={reviewHeadingRef} className="pkg-subheading" tabIndex={-1}>{t("Environments in package")}</h4>
              <div className="pkg-preview-table-wrap" tabIndex={0} role="region" aria-labelledby="pkg-review-heading">
                <table className="pkg-preview-table" aria-labelledby="pkg-review-heading">
                  <thead>
                    <tr>
                      <th scope="col" className="pkg-col-check">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label={t("Select all package environments")}
                          checked={allSelected}
                          disabled={busy || previewStale}
                          onChange={(event) => setSelectedIds(event.target.checked
                            ? new Set(preview.profiles.map((item) => item.id))
                            : new Set())}
                        />
                      </th>
                      <th scope="col">{t("Name")}</th>
                      <th scope="col" className="pkg-col-status">{t("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.profiles.map((item) => {
                      const checked = selectedIds.has(item.id);
                      const name = item.name || item.id;
                      return (
                        <tr key={item.id}>
                          <td className="pkg-col-check">
                            <input
                              type="checkbox"
                              aria-label={t("Select {profile}", { profile: name })}
                              checked={checked}
                              disabled={busy || previewStale}
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
                          <td className="pkg-environment-cell">
                            <div className="pkg-name-cell">
                              <strong>{name}</strong>
                              {item.hasSession && <span className="pkg-pill">{t("Session")}</span>}
                            </div>
                            {name !== item.id && <span className="pkg-profile-id pkg-mono">{item.id}</span>}
                            <div className="pkg-profile-details">
                              <span><AppIcon name="folder" className="sm" /><span className="sr-only">{t("Group")} </span>{item.group || t("Ungrouped")}</span>
                              <span><AppIcon name="activity" className="sm" /><span className="sr-only">{t("Proxy")} </span>{item.proxyDisplay || t("None")}</span>
                            </div>
                          </td>
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
            </section>

            {preview.conflictCount > 0 && (
              <fieldset className="pkg-strategy-group" disabled={busy || previewStale}>
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
                    <span>{t("Import only new IDs.")}</span>
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
                    <span>{t("Copy matching environments and sessions to new IDs.")}</span>
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
                    <span id="pkg-overwrite-guidance">{t("Replace closed environments with the same ID. Running and trashed environments are skipped.")}</span>
                  </div>
                </label>

              </fieldset>
            )}

          </>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mqprofile"
              hidden
              disabled={busy}
              onChange={(event) => {
                handleSelectFile(event.currentTarget.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              className={`pkg-dropzone${dragActive ? " is-drag" : ""}${file ? " has-file" : ""}`}
              aria-label={t(file ? "Change file" : "Choose or drop files")}
              aria-describedby="pkg-source-details"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                if (activeRequest.current === null) setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragActive(false);
                const dropped = event.dataTransfer.files?.[0] ?? null;
                handleSelectFile(dropped);
              }}
            >
              <span className="modal-title-icon"><AppIcon name="fileImport" /></span>
              {file ? (
                <>
                <span className="pkg-selected-file" id="pkg-source-details">
                  <strong>{file.name}</strong>
                  <span>{file.size < 1024
                    ? `${file.size.toLocaleString(language)} B`
                    : `${Math.round(file.size / 1024).toLocaleString(language)} KiB`}</span>
                </span>
                <span className="pkg-source-change">{t("Change file")}</span>
                </>
              ) : (
                <span className="pkg-empty-file">
                  <strong>{t("Choose or drop files")}</strong>
                  <span className="pkg-format" id="pkg-source-details">.mqprofile</span>
                </span>
              )}
            </button>

            <div className="pkg-field">
              <label className="pkg-field-label" htmlFor="pkg-import-password">
                {t("Package password")}
              </label>
              <div className="pkg-password-row">
                <input
                  ref={passwordInputRef}
                  id="pkg-import-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  disabled={busy}
                  autoComplete="current-password"
                  aria-invalid={password.length > 0 && !validPassword || undefined}
                  aria-describedby={password.length > 0 && !validPassword ? "pkg-import-password-hint" : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && file && validPassword) {
                      event.preventDefault();
                      void handleDecryptPreview();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn ghost xs"
                  disabled={busy}
                  aria-controls="pkg-import-password"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {t(showPassword ? "Hide" : "Show")}
                </button>
              </div>
              {password.length > 0 && !validPassword && (
                <span id="pkg-import-password-hint" className="pkg-field-hint is-error">{t("Password must be 10–1024 UTF-8 bytes ({bytes} bytes).", { bytes: passwordBytes })}</span>
              )}
            </div>
          </>
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
