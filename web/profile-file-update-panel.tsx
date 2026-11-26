import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createProfileFileUpdate, postProfileFileUpdate, PROFILE_FILE_UPDATE_REASONS, type ProfileFileUpdateOptions, type ProfileFileUpdateReceipt, type ProfileFileUpdateSnapshot, type ProfileFileUpdateTask } from "./profile-file-update.ts";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { AppIcon, useDialogKeyboard } from "./ui-primitives.tsx";
import "./profile-file-update.css";

export function useProfileFileUpdate(options: ProfileFileUpdateOptions = {}) {
  const latest = useRef(options); latest.current = options;
  const [task] = useState(() => createProfileFileUpdate({ post: file => (latest.current.post ?? postProfileFileUpdate)(file), workspaceId: () => latest.current.workspaceId?.() ?? null,
    acquire: id => latest.current.acquire ? latest.current.acquire(id) : { release() {} }, onSettled: receipt => latest.current.onSettled?.(receipt), now: () => latest.current.now?.() ?? Date.now() }));
  return { task, snapshot: useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot) };
}
const TITLES: Record<ProfileFileUpdateReceipt["status"], string> = {
  saved: "File update saved", partial: "Some environments saved; file needs review", "no-changes": "No environments saved from this file",
  rejected: "File validation failed · nothing saved", unconfirmed: "File update result unknown",
};
const NOTES: Record<ProfileFileUpdateReceipt["status"], string> = {
  saved: "The saved count is the number of distinct environments reported by the service, including rows that may have repeated the same ID.",
  partial: "Unmatched IDs were not created. Rows without usable IDs were skipped. Review and choose a corrected file for another update.",
  "no-changes": "The service confirmed zero saved environments. Check the id column, unmatched IDs and skipped rows before choosing a corrected file.",
  rejected: "The whole upload was rejected before any profile was saved. Valid-looking rows in this upload were not applied.",
  unconfirmed: "The response did not confirm the outcome. The upload may have saved. Inspect current profiles before selecting and submitting another file. No automatic resend will occur.",
};
function ProfileFileUpdateReceiptDetails({ receipt }: { receipt: ProfileFileUpdateReceipt }) {
  const { t, language } = useTranslation(), [missingPage, setMissingPage] = useState(0), [issuePage, setIssuePage] = useState(0);
  useEffect(() => { setMissingPage(0); setIssuePage(0); }, [receipt.id]);
  const missingPages = Math.max(1, Math.ceil(receipt.notFoundIds.length / 50)), issuePages = Math.max(1, Math.ceil(receipt.issues.length / 50));
  const missing = Math.min(missingPage, missingPages - 1), issue = Math.min(issuePage, issuePages - 1);
  const pager = (page: number, pages: number, choose: (page: number) => void) => pages > 1 && <div className="profile-file-update-pager"><button type="button" className="btn xs" disabled={page === 0} onClick={() => choose(page - 1)}>{t("Previous")}</button><span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span><button type="button" className="btn xs" disabled={page + 1 >= pages} onClick={() => choose(page + 1)}>{t("Next")}</button></div>;
  return <div className="profile-file-update-receipt" data-outcome={receipt.status}>
    <p className="profile-file-update-note" role={receipt.status === "unconfirmed" || receipt.status === "rejected" ? "alert" : undefined}>{t(NOTES[receipt.status])}</p>
    {receipt.updated !== null && <dl className="profile-file-update-counts"><div><dt>{t("Environments saved")}</dt><dd>{receipt.updated.toLocaleString(language)}</dd></div><div><dt>{t("Rows skipped without ID")}</dt><dd>{receipt.skipped?.toLocaleString(language)}</dd></div><div><dt>{t("File rows with no matching environment")}</dt><dd>{receipt.notFoundRows?.toLocaleString(language)}</dd></div><div><dt>{t("Validation items reported")}</dt><dd>{receipt.issues.length.toLocaleString(language)}</dd></div></dl>}
    {receipt.refreshFailed && <p className="profile-file-update-warning" role="alert">{t("The environment or workspace list could not refresh. This does not undo a confirmed save.")}</p>}
    {receipt.notFoundIds.length > 0 && <details className="profile-file-update-items"><summary>{t("View {count} distinct unmatched IDs", { count: receipt.notFoundIds.length })}</summary><p>{t("Repeated missing IDs can account for more than one unmatched file row. No new environments were created for these IDs.")}</p><ul>{receipt.notFoundIds.slice(missing * 50, (missing + 1) * 50).map(id => <li key={id}><code>{id}</code></li>)}</ul>{pager(missing, missingPages, setMissingPage)}</details>}
    {receipt.issues.length > 0 && <details className="profile-file-update-items"><summary>{t("View {count} validation items", { count: receipt.issues.length })}</summary><ul>{receipt.issues.slice(issue * 50, (issue + 1) * 50).map((item, index) => <li key={`${receipt.id}-${issue * 50 + index}`}><div>{item.reason === "file-format" ? <strong>{t("File input")}</strong> : item.id ? <code>{item.id}</code> : <strong>{t("Identifier withheld")}</strong>}{item.reason !== "file-format" && <span>{t("Reported item {number}", { number: issue * 50 + index + 1 })}</span>}</div><p>{t(PROFILE_FILE_UPDATE_REASONS[item.reason])}</p></li>)}</ul>{pager(issue, issuePages, setIssuePage)}</details>}
    {(receipt.status === "saved" || receipt.status === "partial") && <p className="profile-file-update-note">{t("Saved profile data can change while browsers are open. Reopen affected browsers yourself to apply launch-dependent settings.")}</p>}
    <p className="profile-file-update-privacy">{t("Only safe environment IDs, counts and fixed reasons are shown. Original filenames, file rows, account data and raw service errors are excluded.")}</p>
  </div>;
}
export interface ProfileFileUpdatePanelProps { snapshot: ProfileFileUpdateSnapshot; onChooseFile?: () => void; onDismiss?: () => void; onBrowseProfiles?: () => void; defaultExpanded?: boolean; showSelectionError?: boolean }
export function ProfileFileUpdatePanel({ snapshot, onChooseFile, onDismiss, onBrowseProfiles, defaultExpanded = false, showSelectionError = true }: ProfileFileUpdatePanelProps) {
  const { t, language } = useTranslation(), id = useId(), [expanded, setExpanded] = useState(defaultExpanded);
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing";
  if (!busy && !snapshot.latest) return null;
  const current = busy && snapshot.latest?.id !== snapshot.activeAttempt?.id ? null : snapshot.latest;
  const earlier = snapshot.receipts.filter(receipt => receipt.id !== current?.id), input = snapshot.activeAttempt?.input ?? current?.input;
  const hasDetails = !!current || earlier.length > 0;
  const title = snapshot.phase === "sending" ? "Updating profiles from the selected file…" : snapshot.phase === "refreshing" ? "Refreshing lists after the file update…" : current ? TITLES[current.status] : "File update result";
  const resultIcon = busy ? "refresh" : current?.status === "saved" ? "check" : current?.status === "rejected" ? "alert" : "file";
  return <section className={`profile-file-update-panel${current ? ` is-${current.status}` : ""}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <header>
      <span className="profile-file-update-result-icon"><AppIcon name={resultIcon} /></span>
      <div className="profile-file-update-result-heading"><h2 id={`${id}-title`}>{t(title)}</h2>
        {(input || current) && <p>{input?.format.toUpperCase()}{input && current && <span aria-hidden="true"> · </span>}{current && <time dateTime={new Date(current.completedAt).toISOString()}>{new Date(current.completedAt).toLocaleString(language)}</time>}</p>}
      </div>
      <div className="profile-file-update-controls">
        {hasDetails && <button type="button" className="btn xs ghost profile-file-update-toggle" aria-expanded={expanded} aria-controls={`${id}-details`} aria-label={t(expanded ? "Hide file update details" : "View file update details")} onClick={() => setExpanded(value => !value)}>{t("Details")}<AppIcon name={expanded ? "chevronUp" : "chevronDown"} className="sm" /></button>}
        {onDismiss && <button className="iconbtn" type="button" disabled={busy} aria-label={t("Dismiss file update results")} onClick={onDismiss}><AppIcon name="close" className="sm" /></button>}
      </div>
    </header>
    {busy && <p className="profile-file-update-progress" role="status"><i aria-hidden="true" />{t(snapshot.phase === "sending" ? "The file and ID matching are fixed for this upload. Hiding the window does not cancel requests already sent." : "The response is preserved while environment and workspace lists finish refreshing.")}</p>}
    {!expanded && current && <p className="profile-file-update-compact" role="status">{current.updated === null ? t("Outcome not confirmed · no automatic resend") : t("Saved {saved} · Unmatched rows {missing} · Skipped {skipped}", { saved: current.updated, missing: current.notFoundRows ?? 0, skipped: current.skipped ?? 0 })}</p>}
    {showSelectionError && snapshot.blockedReason && <p className="profile-file-update-warning" role="alert">{t(snapshot.blockedReason)}</p>}
    <div id={`${id}-details`} hidden={!expanded}>{current && <ProfileFileUpdateReceiptDetails receipt={current} />}{earlier.length > 0 && <details className="profile-file-update-history"><summary>{t("Earlier file update results ({count})", { count: earlier.length })}</summary><ol>{[...earlier].reverse().map(receipt => <li key={receipt.id}><details><summary>{t(TITLES[receipt.status])}{receipt.updated !== null && ` · ${t("{count} saved", { count: receipt.updated })}`} · <time dateTime={new Date(receipt.completedAt).toISOString()}>{new Date(receipt.completedAt).toLocaleString(language)}</time></summary><ProfileFileUpdateReceiptDetails receipt={receipt} /></details></li>)}</ol></details>}</div>
    {(onChooseFile || onBrowseProfiles) && !busy && <footer>{onBrowseProfiles && <button type="button" className="btn xs" onClick={onBrowseProfiles}>{t("Review current environments")}</button>}{onChooseFile && <button type="button" className="btn xs ghost" onClick={onChooseFile}>{t("Choose corrected or different file")}</button>}{current?.status === "partial" && <p>{t("The service cannot resume only failed rows from the original file. Another submission requires explicitly choosing a file again.")}</p>}</footer>}
  </section>;
}

export interface ProfileFileUpdateDialogProps {
  open: boolean; task: ProfileFileUpdateTask; onClose: () => void; selectedCount?: number;
  onExport?: (format: "csv" | "txt" | "xlsx") => void | Promise<void>;
  onDownloadTemplate?: () => void;
}
/** The file and receipts belong to the task above the dialog, so closing retains both. */
export function ProfileFileUpdateDialog({ open, task, onClose, selectedCount = 0, onExport, onDownloadTemplate }: ProfileFileUpdateDialogProps) {
  const { t, language } = useTranslation();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const drop = useRef<HTMLButtonElement>(null);
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot), [over, setOver] = useState(false);
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing";
  const selected = snapshot.input;
  const canExport = !!onExport && selectedCount > 0;
  useDialogKeyboard(dialog, open, onClose, () => drop.current);
  useEffect(() => { if (!open) setOver(false); }, [open]);
  const choose = () => { if (!task.isBusy()) picker.current?.click(); };
  if (typeof document === "undefined") return null;
  return createPortal(<MotionPresence present={open}>{() => <div className="modal-backdrop profile-file-update-backdrop"><div ref={dialog} tabIndex={-1} className="modal profile-file-update-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-match`}>
    <div className="modal-head"><span className="modal-title-icon"><AppIcon name="fileImport" /></span><h2 id={`${id}-title`}>{t("Update profiles from file")}</h2><button type="button" className="modal-close" aria-label={t(busy ? "Hide file update window" : "Close")} onClick={onClose}><AppIcon name="close" className="sm" /></button></div>
    <div className="modal-body">
      <div className={`profile-file-update-input${over ? " over" : ""}`} data-selected={!!selected || undefined}
        onDragOver={event => { event.preventDefault(); if (!busy) setOver(true); }}
        onDragLeave={event => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
        onDrop={event => {
          event.preventDefault();
          setOver(false);
          const { files, types } = event.dataTransfer;
          if (busy || (!files.length && !types.includes("Files"))) return;
          if (files.length !== 1) task.rejectSelection();
          else task.selectFile(files[0]!);
        }}>
        {selected && <div className="profile-file-update-selection">
          <span className="modal-title-icon"><AppIcon name="file" /></span>
          <div role="status"><strong>{t("Selected private file")}</strong><span>{selected.format.toUpperCase()} · {selected.bytes.toLocaleString(language)} {t("bytes")}</span></div>
        </div>}
        <button ref={drop} type="button" className="profile-file-update-drop" disabled={busy} onClick={choose}>
          {!selected && <span className="modal-title-icon"><AppIcon name="fileImport" /></span>}
          <strong>{t(selected ? "Change file" : "Choose an edited file or drop it here")}</strong>
          {!selected && <span className="profile-file-update-formats">CSV · TXT · XLSX</span>}
        </button>
        {selected && <button type="button" className="iconbtn profile-file-update-remove" aria-label={t("Remove selected file")} title={t("Remove selected file")} disabled={busy} onClick={() => { if (task.clearFile()) drop.current?.focus(); }}><AppIcon name="close" className="sm" /></button>}
      </div>
      <input ref={picker} type="file" accept=".csv,.txt,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={busy} onChange={event => { if (event.target.files?.length === 1) task.selectFile(event.target.files[0]!); else if (event.target.files?.length) task.rejectSelection(); event.target.value = ""; }} />
      {snapshot.blockedReason && <p className="profile-file-update-warning" role="alert"><AppIcon name="alert" className="sm" />{t(snapshot.blockedReason)}</p>}
      <div className="profile-file-update-rules" id={`${id}-match`}>
        <p className="profile-file-update-match"><AppIcon name="file" className="sm" />{t("File IDs control the update. List selections are ignored and unmatched IDs are skipped.")}</p>
        <p className="profile-file-update-impact"><AppIcon name="warning" className="sm" />{t("Empty cells may clear saved values.")}</p>
      </div>
      <details className="profile-file-update-guide">
        <summary>{t("How to prepare the update file")}</summary>
        <ul>
          <li>{t("Export the environments you want to change and keep the original id column.")}</li>
          <li>{t("Delete columns you do not want to change.")}</li>
          <li>{t("Editable columns include name, group, platform, username, password, email, email_password, twofa, proxy, proxytype, resolution, locale and custom_no.")}</li>
          <li>{t("Cookie values, user-agent identity and fingerprint seed are not changed by this file update.")}</li>
          <li>{t("Any invalid update row rejects the whole upload. Missing IDs and rows with no id are reported separately.")}</li>
        </ul>
      </details>
      {(canExport || onDownloadTemplate) && <div className="profile-file-update-export">
        {canExport && <div className="profile-file-update-formats-row" role="group" aria-label={t("Export {count} selected:", { count: selectedCount })}>
          <span aria-hidden="true">{t("Export {count} selected:", { count: selectedCount })}</span>
          {(["csv", "txt", "xlsx"] as const).map(format => <button key={format} className="btn xs ghost" type="button" disabled={busy} onClick={() => { void onExport?.(format); }}>{format.toUpperCase()}</button>)}
        </div>}
        {onDownloadTemplate && <button type="button" className="btn xs ghost" disabled={busy} onClick={onDownloadTemplate}><AppIcon name="import" className="sm" />{t("Download example sheet")}</button>}
      </div>}
      {selected && !snapshot.canSubmit && !busy && <p className="profile-file-update-note">{t("File already submitted. Choose it again to resend.")}</p>}
      <ProfileFileUpdatePanel snapshot={snapshot} showSelectionError={false} />
    </div>
    <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>{t(busy ? "Hide window · update continues" : "Close")}</button><button type="button" className="btn primary" disabled={!snapshot.canSubmit} onClick={() => { void task.submit(); }}>{t(busy ? "Updating…" : "Update profiles")}</button></div>
  </div></div>}</MotionPresence>, document.body);
}
