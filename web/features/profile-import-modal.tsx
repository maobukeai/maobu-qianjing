import { useEffect, useId, useRef, useState } from "react";
import { clearPendingCookies, fetchPendingCookies, uploadExports, type UiProfile } from "../api.ts";
import { MotionPresence } from "../desktop-motion.tsx";
import { useTranslation } from "../i18n.tsx";
import { createImportReceipt, ImportReceiptError, type ImportReceipt } from "../import-receipt-data.ts";
import { AppIcon, ModalDialog, useDialogKeyboard } from "../ui-primitives.tsx";
import { workspaceOperationMessage, type WorkspaceOperationCoordinator } from "../workspace-operations.tsx";
import {
  countPastedRecords,
  CSV_TEMPLATE,
  downloadText,
  GroupPicker,
  KNOWN_PLATFORMS,
  TXT_EXAMPLE,
} from "./profile-form-helpers.tsx";
import "./profile-import-modal.css";

const Icon = AppIcon;

export interface PendingCookiesViewState {
  workspaceId: string | undefined;
  profile: UiProfile;
  cookies: Array<{ domain: string; name: string }> | null;
  error: string | null;
  busy: boolean;
}

export interface UseProfileImportModalOptions {
  workspaceId: string | undefined;
  workspaceCoordinator: WorkspaceOperationCoordinator;
  bulkOwnerActiveRef: React.MutableRefObject<boolean>;
  onLoadRoster: () => Promise<unknown>;
  onRefreshImportedProfiles: () => Promise<void>;
  onActionError: (message: string | null) => void;
  onFlash: (message: string) => void;
  onOpenProfilesView: () => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}

export function useProfileImportModal({
  workspaceId,
  workspaceCoordinator,
  bulkOwnerActiveRef,
  onLoadRoster,
  onRefreshImportedProfiles,
  onActionError,
  onFlash,
  onOpenProfilesView,
  t,
}: UseProfileImportModalOptions) {
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
  // Both drafts survive source switches, but an import reads only the active one.
  const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;
  const hasStagedInput = bulkSource === "file" ? bulkFiles.length > 0 : pastedRecordCount !== null;

  const [pendingCookieView, setPendingCookieView] = useState<PendingCookiesViewState | null>(null);
  const pendingView = pendingCookieView?.workspaceId === workspaceId ? pendingCookieView : null;
  const pendingCookieRead = useRef<AbortController | null>(null);
  const pendingCookieRemoval = useRef(false);

  useEffect(() => {
    setPendingCookieView(current => current?.workspaceId === workspaceId ? current : null);
    return () => {
      pendingCookieRead.current?.abort();
      pendingCookieRead.current = null;
    };
  }, [workspaceId]);

  const importProfiles = async (
    files: File[],
    assign: { group?: string; platform?: string } | undefined,
    reportError: (message: string | null) => void,
  ): Promise<boolean> => {
    if (!files.length) return false;
    if (importInFlight.current) {
      reportError(t("An import is already in progress. Wait for its result before importing again."));
      return false;
    }
    const lease = workspaceCoordinator.acquire("profile-import", workspaceId);
    if (!lease) {
      reportError(t(workspaceOperationMessage(workspaceCoordinator.getSnapshot())));
      return false;
    }
    importInFlight.current = true;
    setImportBusy(true);
    reportError(null);
    try {
      const response = await uploadExports(files, assign);
      const receipt = createImportReceipt(response);
      if (!bulkOwnerActiveRef.current) return false;
      setImportReceipt(receipt);
      setImportReceiptExpanded(false);
      setImportReceiptRefreshing(true);
      workspaceCoordinator.setPhase(lease, "refreshing");
      const refreshed = await Promise.allSettled([onRefreshImportedProfiles(), workspaceCoordinator.refreshWorkspaceViews(lease)]);
      if (bulkOwnerActiveRef.current && refreshed.some((result) => result.status === "rejected")) {
        onActionError(t("Import completed, but the environment list could not refresh. Refresh the list to see the saved result."));
      }
      return true;
    } catch (error) {
      if (bulkOwnerActiveRef.current) {
        reportError(t(error instanceof ImportReceiptError ? error.message : "The import could not be confirmed. Refresh environments before trying again."));
        if (error instanceof ImportReceiptError && error.kind === "invalid") await onLoadRoster().catch(() => {});
      }
      return false;
    } finally {
      workspaceCoordinator.release(lease);
      importInFlight.current = false;
      if (bulkOwnerActiveRef.current) {
        setImportBusy(false);
        setImportReceiptRefreshing(false);
      }
    }
  };

  const doUpload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    await importProfiles(list, undefined, onActionError);
  };

  const openBulk = () => {
    if (importInFlight.current) {
      onActionError(t("An import is already in progress. Wait for its result before importing again."));
      return;
    }
    setBulkFiles([]);
    setBulkText("");
    setBulkGroup("");
    setBulkPlatform("");
    setBulkErr(null);
    setBulkOver(false);
    setBulkSource("file");
    setShowBulk(true);
  };

  const selectBulkSource = (source: typeof bulkSource) => {
    if (importInFlight.current) return;
    setBulkSource(source);
    setBulkOver(false);
  };

  const closeBulk = () => {
    if (importInFlight.current) return;
    setShowBulk(false);
    setBulkFiles([]);
    setBulkText("");
    setBulkErr(null);
  };

  const submitBulk = async () => {
    if (!showBulk || importInFlight.current || !hasStagedInput) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const uploads = bulkSource === "file"
        ? bulkFiles
        : [new File([bulkText], "pasted-adspower.txt", { type: "text/plain" })];
      if (await importProfiles(uploads, { group: bulkGroup.trim(), platform: bulkPlatform }, setBulkErr)) closeBulk();
    } catch {
      if (bulkOwnerActiveRef.current) setBulkErr(t("The import could not be confirmed. Refresh environments before trying again."));
    } finally {
      if (bulkOwnerActiveRef.current) setBulkBusy(false);
    }
  };

  const dismissImportReceipt = () => {
    if (!importReceiptRefreshing) {
      const focused = document.activeElement?.closest(".import-receipt");
      setImportReceipt(null);
      setImportReceiptExpanded(false);
      if (focused) requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.getElementById("profiles-page-title")?.focus();
      });
    }
  };

  const showImportReceipt = () => {
    onOpenProfilesView();
    setImportReceiptExpanded(true);
    requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>(".import-receipt-controls button") ?? document.getElementById("profiles-page-title"))?.focus());
  };

  const openPendingCookies = async (profile: UiProfile) => {
    if (pendingCookieRemoval.current) return;
    pendingCookieRead.current?.abort();
    const request = new AbortController();
    const loading = { workspaceId, profile, cookies: null, error: null, busy: false };
    pendingCookieRead.current = request;
    setPendingCookieView(loading);
    let cookies: PendingCookiesViewState["cookies"] = null;
    try {
      const result = await fetchPendingCookies(profile.id, request.signal);
      if (result.ok === true && Array.isArray(result.cookies)
        && result.cookies.every(cookie => cookie && typeof cookie.domain === "string" && typeof cookie.name === "string")) {
        cookies = result.cookies.map(({ domain, name }) => ({ domain, name }));
      }
    } catch { /* An unreadable response does not establish the contents of the queue. */ }
    if (pendingCookieRead.current !== request || request.signal.aborted || !bulkOwnerActiveRef.current) return;
    pendingCookieRead.current = null;
    setPendingCookieView(current => current === loading
      ? { ...loading, cookies, error: cookies === null ? t("Cookies could not be loaded.") : null }
      : current);
  };

  const closePendingCookies = () => {
    if (pendingCookieRemoval.current) return;
    pendingCookieRead.current?.abort();
    pendingCookieRead.current = null;
    setPendingCookieView(null);
  };

  const retryPendingCookies = () => {
    if (pendingView?.error && !pendingCookieRead.current) void openPendingCookies(pendingView.profile);
  };

  const removePendingCookies = async () => {
    if (!pendingView?.cookies?.length || pendingView.busy || pendingCookieRead.current || pendingCookieRemoval.current) return;
    const removing = { ...pendingView, busy: true };
    pendingCookieRemoval.current = true;
    setPendingCookieView(removing);
    let error = t("Cookie removal could not be confirmed. Check the current list before trying again.");
    try {
      const result = await clearPendingCookies(pendingView.profile.id);
      if (!bulkOwnerActiveRef.current) return;
      if (result.ok === true && typeof result.removed === "number" && Number.isSafeInteger(result.removed) && result.removed >= 0) {
        setPendingCookieView(current => current === removing ? null : current);
        void onLoadRoster().catch(() => {});
        onFlash(t(result.removed > 0 ? "Pending cookies removed." : "No cookies are queued for the next start."));
        return;
      }
      if (result.ok === false) error = t("Cookies could not be removed.");
    } catch { /* The removal may already have happened. The next action only reads the queue. */ }
    finally {
      pendingCookieRemoval.current = false;
    }
    if (bulkOwnerActiveRef.current) {
      setPendingCookieView(current => current === removing ? { ...removing, busy: false, cookies: null, error } : current);
    }
  };

  return {
    showBulk,
    bulkFiles,
    setBulkFiles,
    bulkText,
    setBulkText,
    bulkGroup,
    setBulkGroup,
    bulkPlatform,
    setBulkPlatform,
    bulkBusy,
    importInFlight,
    importBusy,
    importReceipt,
    importReceiptExpanded,
    setImportReceiptExpanded,
    importReceiptRefreshing,
    bulkErr,
    bulkOver,
    setBulkOver,
    bulkSource,
    selectBulkSource,
    hasStagedInput,
    bulkFileRef,
    pastedRecordCount,
    doUpload,
    openBulk,
    closeBulk,
    submitBulk,
    dismissImportReceipt,
    showImportReceipt,
    pendingView,
    openPendingCookies,
    closePendingCookies,
    retryPendingCookies,
    removePendingCookies,
  };
}

export type ProfileImportController = ReturnType<typeof useProfileImportModal>;

export function ProfileImportModal({
  controller,
  existingGroups,
}: {
  controller: ProfileImportController;
  existingGroups: string[];
}) {
  const { t, language } = useTranslation();
  const bulkEditorRef = useRef<HTMLDivElement>(null);
  const dropButtonRef = useRef<HTMLButtonElement>(null);
  const bulkTitleId = useId();
  const {
    showBulk,
    bulkFiles,
    setBulkFiles,
    bulkText,
    setBulkText,
    bulkGroup,
    setBulkGroup,
    bulkPlatform,
    setBulkPlatform,
    bulkBusy,
    importInFlight,
    bulkErr,
    bulkOver,
    setBulkOver,
    bulkSource,
    selectBulkSource,
    hasStagedInput,
    bulkFileRef,
    pastedRecordCount,
    closeBulk,
    submitBulk,
    pendingView,
    closePendingCookies,
    retryPendingCookies,
    removePendingCookies,
  } = controller;
  useDialogKeyboard(bulkEditorRef, showBulk, bulkBusy ? null : closeBulk, () => dropButtonRef.current);

  return (
    <>
      {pendingView && (
        <ModalDialog
          open
          className="pending-cookie-dialog"
          backdropClassName="profile-import-backdrop"
          busy={pendingView.busy}
          onClose={closePendingCookies}
          title={<span className="pending-cookie-heading"><span className="modal-title-icon"><Icon name="cookie" /></span>{t("Cookies at next start")}</span>}
          footer={
            <>
              <button className="btn ghost" type="button" disabled={pendingView.busy} onClick={closePendingCookies}>{t("Close")}</button>
              {pendingView.error ? <button className="btn" type="button" onClick={retryPendingCookies}>{t("Retry")}</button> :
                <button className="btn danger" type="button" disabled={pendingView.busy || !pendingView.cookies?.length} onClick={() => void removePendingCookies()}>
                  <Icon name="trash" className="sm" />{t("Remove pending cookies")}
                </button>}
            </>
          }
        >
          <div className="pending-cookie-profile">
            <Icon name="profiles" className="sm" />
            <bdi>{pendingView.profile.name}</bdi>
          </div>
          {pendingView.error ? (
            <p className="modal-err" role="alert"><Icon name="alert" className="sm" />{pendingView.error}</p>
          ) : pendingView.cookies === null ? (
            <p className="pending-cookie-status" role="status">{t("Loading…")}</p>
          ) : pendingView.cookies.length === 0 ? (
            <p className="pending-cookie-status" role="status"><Icon name="cookie" />{t("No cookies are queued for the next start.")}</p>
          ) : (
            <div className="pending-cookie-list">
              <table aria-busy={pendingView.busy}>
                <thead><tr><th scope="col">{t("Domain")}</th><th scope="col">{t("Cookie name")}</th></tr></thead>
                <tbody>
                  {pendingView.cookies.map((cookie, index) => (
                    <tr key={index}><td><bdi>{cookie.domain}</bdi></td><td><bdi>{cookie.name}</bdi></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ModalDialog>
      )}

      <MotionPresence present={showBulk}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop profile-import-backdrop">
          <div className="modal profile-import-dialog" ref={bulkEditorRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={bulkTitleId} aria-busy={bulkBusy}>
            <div className="modal-head">
              <span className="modal-title-icon"><Icon name="fileImport" /></span>
              <h2 id={bulkTitleId}>{t("Import profiles")}</h2>
              <span className={`profile-import-step-pill${hasStagedInput ? " is-ready" : ""}`} aria-hidden="true">
                {hasStagedInput ? "2 / 2" : "1 / 2"}
              </span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={bulkBusy} onClick={closeBulk}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err" role="alert"><Icon name="alert" className="sm" />{bulkErr}</div>}
              {bulkBusy && <span className="sr-only" role="status">{t("Importing…")}</span>}
              <fieldset className="import-draft-fields" disabled={bulkBusy} aria-busy={bulkBusy}>
                <legend className="sr-only">{t("Import draft")}</legend>
                <div className="segmented profile-import-sources" role="group" aria-label={t("Import source")}>
                  <button type="button" aria-pressed={bulkSource === "file"} className={bulkSource === "file" ? "active" : ""} onClick={() => selectBulkSource("file")}>
                    <Icon name="fileImport" className="sm" />{t("From file")}
                  </button>
                  <button type="button" aria-pressed={bulkSource === "paste"} className={bulkSource === "paste" ? "active" : ""} onClick={() => selectBulkSource("paste")}>
                    <Icon name="copy" className="sm" />{t("Paste text")}
                  </button>
                </div>

                {bulkSource === "file" ? (
                  <>
                    <button
                      ref={dropButtonRef}
                      type="button"
                      className={`bulkdrop${bulkFiles.length ? " is-staged" : ""}${bulkOver ? " over" : ""}`}
                      disabled={bulkBusy}
                      onClick={() => { if (!importInFlight.current) bulkFileRef.current?.click(); }}
                      onDragOver={(e) => { e.preventDefault(); if (importInFlight.current) return; if (!bulkOver) setBulkOver(true); }}
                      onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                      onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (!importInFlight.current && e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
                    >
                      <span className="bulkdrop-icon"><Icon name="fileImport" /></span>
                      <strong>{t(bulkFiles.length ? "Replace files" : "Choose or drop files")}</strong>
                      {bulkFiles.length === 0 && <span className="bulkdrop-formats">TXT · CSV · JSON · XLSX</span>}
                    </button>
                    {bulkFiles.length > 0 && (
                      <div className="profile-import-queue">
                        <div className="profile-import-queue-head">
                          <span role="status">{t(bulkFiles.length === 1 ? "1 file selected" : "{count} files selected", { count: bulkFiles.length.toLocaleString(language) })}</span>
                          {bulkFiles.length > 1 && <button type="button" className="btn xs ghost" onClick={() => {
                            if (importInFlight.current) return;
                            setBulkFiles([]);
                            dropButtonRef.current?.focus();
                          }}>{t("Clear all")}</button>}
                        </div>
                        <ul className="filelist">
                          {bulkFiles.map((file, index) => (
                            <li className="profile-import-file" key={`${file.name}:${file.lastModified}:${index}`}>
                              <Icon name="file" className="sm" />
                              <span className="fname" title={file.name}>{file.name}</span>
                              <button
                                type="button"
                                aria-label={t("Remove file {name}", { name: file.name })}
                                onClick={() => {
                                  if (importInFlight.current) return;
                                  setBulkFiles((files) => files.filter((_, position) => position !== index));
                                  dropButtonRef.current?.focus();
                                }}
                              >
                                <Icon name="close" className="sm" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <label className="fld profile-import-paste">
                    <span>{t("AdsPower TXT records")}</span>
                    <textarea
                      rows={6}
                      value={bulkText}
                      placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                      onChange={(event) => { if (!importInFlight.current) setBulkText(event.target.value); }}
                    />
                    <small>
                      {pastedRecordCount === null
                        ? t("Separate records with a line of asterisks.")
                        : pastedRecordCount === 1
                          ? t("1 record detected")
                          : t("{count} records detected", { count: pastedRecordCount })}
                    </small>
                  </label>
                )}

                <input
                  ref={bulkFileRef}
                  type="file"
                  multiple
                  accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (showBulk && bulkSource === "file" && !importInFlight.current && e.target.files?.length) setBulkFiles(Array.from(e.target.files));
                    e.target.value = "";
                  }}
                />

                <div className="profile-import-assignments">
                  <label className="fld grow">
                    <span>{t("Group")}</span>
                    <GroupPicker value={bulkGroup} onChange={(value) => { if (!importInFlight.current) setBulkGroup(value); }} groups={existingGroups} emptyLabel="Keep source groups" allowCreate />
                  </label>
                  <label className="fld grow">
                    <span>{t("Platform")}</span>
                    <select value={bulkPlatform} onChange={(e) => { if (!importInFlight.current) setBulkPlatform(e.target.value); }}>
                      {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.value ? platform.label : t("Keep source platforms")}</option>)}
                    </select>
                  </label>
                </div>
                {(bulkGroup.trim() || bulkPlatform) && <p className="profile-import-note">{t("Overrides apply to every imported record.")}</p>}
                <div className="profile-import-rules">
                  <p className="profile-import-impact"><Icon name="alert" className="sm" /><span>{t("Matching IDs update existing environments. Missing fields keep their saved values.")}</span></p>
                  <div className="profile-import-help">
                    <details className="import-transfer-details">
                      <summary><Icon name="chevronRight" className="sm" />{t("Import rules and transferable data")}</summary>
                      <ul>
                        <li>{t("Use readable exports from AdsPower, GoLogin, Multilogin, Dolphin Anty, HideMyAcc, Incogniton, Donut and similar browsers. Encrypted or proprietary archives are unsupported.")}</li>
                        <li>{t("Included accounts, proxies, cookies, and supported settings can transfer.")}</li>
                        <li>{t("Saved seed, timezone, and OS values can apply. Browser and hardware still affect fingerprint results; historical fp_* values are for review.")}</li>
                      </ul>
                    </details>
                    <div className="profile-import-templates">
                      <button type="button" className="tlink" onClick={() => downloadText("maobu-qianjing-template.csv", CSV_TEMPLATE, "text/csv")}>
                        <Icon name="import" className="sm" />{t("CSV template")}
                      </button>
                      <button type="button" className="tlink" onClick={() => downloadText("maobu-qianjing-example.txt", TXT_EXAMPLE, "text/plain")}>
                        <Icon name="import" className="sm" />{t(".txt example")}
                      </button>
                    </div>
                  </div>
                </div>
              </fieldset>
            </div>
            <div className="modal-foot profile-import-footer">
              <button type="button" className="btn ghost" disabled={bulkBusy} onClick={closeBulk}>{t("Cancel")}</button>
              <button type="button" className="btn primary" disabled={bulkBusy || !hasStagedInput} onClick={submitBulk}>
                {bulkBusy ? t("Importing…") : t("Import profiles")}
              </button>
            </div>
          </div>
        </div>
      )}</MotionPresence>
    </>
  );
}
