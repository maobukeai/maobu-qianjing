import { useRef, useState } from "react";
import { clearPendingCookies, fetchPendingCookies, uploadExports, type UiProfile } from "../api.ts";
import { MotionPresence } from "../desktop-motion.tsx";
import { useTranslation } from "../i18n.tsx";
import { createImportReceipt, ImportReceiptError, type ImportReceipt } from "../import-receipt-data.ts";
import { AppIcon } from "../ui-primitives.tsx";
import { workspaceOperationMessage, type WorkspaceOperationCoordinator } from "../workspace-operations.tsx";
import {
  countPastedRecords,
  CSV_TEMPLATE,
  downloadText,
  GroupPicker,
  KNOWN_PLATFORMS,
  TXT_EXAMPLE,
  useProfileEditorFocus,
} from "./profile-form-helpers.tsx";

const Icon = AppIcon;

export interface PendingCookiesViewState {
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
  // One source at a time: two full-height inputs stacked made it ambiguous which
  // one the Import button would actually read.
  const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
  const bulkEditorRef = useProfileEditorFocus(showBulk, false);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;

  const [pendingView, setPendingView] = useState<PendingCookiesViewState | null>(null);

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
      setImportReceiptExpanded(receipt.issues.length > 0);
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
    if (importInFlight.current || (!bulkFiles.length && !bulkText.trim())) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const uploads = [...bulkFiles];
      if (bulkText.trim()) uploads.push(new File([bulkText], "pasted-adspower.txt", { type: "text/plain" }));
      if (!uploads.length) throw new Error("no rows found in the file(s)");
      if (await importProfiles(uploads, { group: bulkGroup.trim(), platform: bulkPlatform }, setBulkErr)) closeBulk();
    } catch {
      if (bulkOwnerActiveRef.current) setBulkErr(t("The import could not be confirmed. Refresh environments before trying again."));
    } finally {
      if (bulkOwnerActiveRef.current) setBulkBusy(false);
    }
  };

  const dismissImportReceipt = () => {
    if (!importReceiptRefreshing) {
      setImportReceipt(null);
      setImportReceiptExpanded(false);
    }
  };

  const showImportReceipt = () => {
    onOpenProfilesView();
    setImportReceiptExpanded(true);
    requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>(".import-receipt-controls button") ?? document.getElementById("profiles-page-title"))?.focus());
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

  const closePendingCookies = () => {
    setPendingView((current) => (current?.busy ? current : null));
  };

  const removePendingCookies = async () => {
    if (!pendingView) return;
    setPendingView({ ...pendingView, busy: true, error: null });
    try {
      const result = await clearPendingCookies(pendingView.profile.id);
      if (!result.ok) throw new Error(result.error || t("Cookies could not be removed."));
      setPendingView(null);
      await onLoadRoster().catch(() => {});
      onFlash(t("Pending cookies removed."));
    } catch (error) {
      setPendingView((view) => view && { ...view, busy: false, error: error instanceof Error ? error.message : t("Cookies could not be removed.") });
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
    setBulkSource,
    bulkEditorRef,
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
  const { t } = useTranslation();
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
    setBulkSource,
    bulkEditorRef,
    bulkFileRef,
    pastedRecordCount,
    closeBulk,
    submitBulk,
    pendingView,
    closePendingCookies,
    removePendingCookies,
  } = controller;

  return (
    <>
      {pendingView && (
        <div className="modal-backdrop" onClick={closePendingCookies}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pending-cookie-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head" id="pending-cookie-title">
              <Icon name="cookie" />{t("Cookies at next start")}<span className="mono muted">{pendingView.profile.name}</span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={pendingView.busy} onClick={closePendingCookies}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {pendingView.error && <div className="modal-err"><Icon name="alert" className="sm" />{pendingView.error}</div>}
              <p className="hint">{t("The browser sets these cookies the next time it starts, before the first page opens.")}</p>
              {pendingView.cookies === null ? (
                <p className="muted">{t("Loading…")}</p>
              ) : (
                <ul className="pending-cookies">
                  {pendingView.cookies.map((cookie, index) => (
                    <li key={index}><span className="mono">{cookie.domain}</span><span className="mono muted">{cookie.name}</span></li>
                  ))}
                </ul>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" disabled={pendingView.busy} onClick={closePendingCookies}>{t("Close")}</button>
              <button className="btn danger" type="button" disabled={pendingView.busy || !pendingView.cookies?.length} onClick={() => void removePendingCookies()}>
                <Icon name="trash" className="sm" />{t("Remove pending cookies")}
              </button>
            </div>
          </div>
        </div>
      )}

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
              <fieldset className="import-draft-fields" disabled={bulkBusy} aria-busy={bulkBusy}>
                <legend className="sr-only">{t("Import draft")}</legend>
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

                {bulkSource === "file" ? (
                  <>
                    <div
                      className={`bulkdrop${bulkOver ? " over" : ""}`}
                      role="button"
                      tabIndex={bulkBusy ? -1 : 0}
                      aria-disabled={bulkBusy}
                      onKeyDown={(e) => { if (importInFlight.current) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bulkFileRef.current?.click(); } }}
                      onClick={() => { if (!importInFlight.current) bulkFileRef.current?.click(); }}
                      onDragOver={(e) => { e.preventDefault(); if (importInFlight.current) return; if (!bulkOver) setBulkOver(true); }}
                      onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                      onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (!importInFlight.current && e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
                    >
                      <Icon name="fileImport" />
                      <b>{t("Drag & drop files, or click to choose")}</b>
                      <div className="sub">{t("Readable TXT, CSV, JSON, or XLSX exports from AdsPower, GoLogin, Multilogin, Dolphin Anty, HideMyAcc, Incogniton, Donut, and similar browsers")}</div>
                    </div>
                    {bulkFiles.length > 0 && (
                      <div className="filelist">
                        {bulkFiles.map((file) => (
                          <span className="filechip" key={file.name}>
                            <Icon name="file" className="sm" />
                            <span className="fname">{file.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${file.name}`}
                              onClick={() => { if (!importInFlight.current) setBulkFiles((files) => files.filter((candidate) => candidate !== file)); }}
                            >
                              <Icon name="close" className="sm" />
                            </button>
                          </span>
                        ))}
                        <button type="button" className="btn xs ghost" onClick={() => { if (!importInFlight.current) setBulkFiles([]); }}>{t("Clear all")}</button>
                      </div>
                    )}
                  </>
                ) : (
                  <label className="fld">
                    <span>{t("AdsPower TXT records")}</span>
                    <textarea
                      rows={9}
                      value={bulkText}
                      placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                      onChange={(event) => { if (!importInFlight.current) setBulkText(event.target.value); }}
                    />
                    <small>
                      {pastedRecordCount === null
                        ? t("Paste one or more key=value records, separated by a line of asterisks.")
                        : pastedRecordCount === 1
                          ? t("1 record detected — each one starts with its own id= line.")
                          : t("{count} records detected — each one starts with its own id= line.", { count: pastedRecordCount })}
                    </small>
                  </label>
                )}

                <input
                  ref={bulkFileRef}
                  type="file"
                  multiple
                  accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  style={{ display: "none" }}
                  onChange={(e) => { if (!importInFlight.current && e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}
                />

                <div className="fld-row">
                  <label className="fld grow">
                    <span>{t("Assign to group")}</span>
                    <GroupPicker value={bulkGroup} onChange={(value) => { if (!importInFlight.current) setBulkGroup(value); }} groups={existingGroups} emptyLabel="Keep source groups" allowCreate />
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
                <details className="import-transfer-details">
                  <summary>{t("Import rules and transferable data")}</summary>
                  <p className="formnote">{t("Readable exports can transfer account fields, proxy settings, cookies and supported portable settings. Records with an existing ID update that environment; data missing from the export cannot be reconstructed.")}</p>
                  <p className="formnote">{t("Explicit seed, timezone and platform_os values can update supported identity settings. Browser version, operating system and hardware still affect the resulting fingerprint. Historical fp_* measurements are review evidence, not browser configuration.")}</p>
                </details>
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
        </div>
      )}</MotionPresence>
    </>
  );
}
