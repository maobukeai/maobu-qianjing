import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IMPORT_RECEIPT_REASONS, type ImportReceipt } from "./import-receipt-data.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./import-receipt.css";

export interface ImportReceiptPanelProps {
  receipt: ImportReceipt;
  expanded: boolean;
  refreshing?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onBrowseAll: () => void;
  onViewAttention: () => void;
  onDismiss: () => void;
}
const PAGE_SIZE = 50;

/** A session-only result, with workspace-wide follow-up actions rather than invented imported-ID filters. */
export function ImportReceiptPanel({ receipt, expanded, refreshing = false, onExpandedChange, onBrowseAll, onViewAttention, onDismiss }: ImportReceiptPanelProps) {
  const { t, language } = useTranslation();
  const id = useId(), titleId = `${id}-title`, contentId = `${id}-details`;
  const [requestedPage, setPage] = useState(0);
  const reviewList = useRef<HTMLDivElement>(null);
  const focusPage = useRef(false);
  useEffect(() => { setPage(0); }, [receipt.id]);
  const pages = Math.max(1, Math.ceil(receipt.issues.length / PAGE_SIZE)), page = Math.min(requestedPage, pages - 1);
  const issues = receipt.issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const hasNotes = receipt.issues.length > 0 || receipt.skipped > 0 || receipt.cookiesStripped > 0;
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    reviewList.current?.focus();
  }, [page]);
  const goToPage = (next: number) => {
    focusPage.current = true;
    setPage(next);
  };
  const totals = (compact: boolean) => <div className="import-receipt-totals" aria-label={t("Import result counts")}>{[
    { count: receipt.skipped, label: "Records skipped" }, { count: receipt.cookiesStripped, label: "Manager cookies omitted" }, { count: receipt.issues.length, label: "Reported items to review" },
  ].filter(item => !compact || item.count > 0).map(item => <span key={item.label}><strong>{item.count.toLocaleString(language)}</strong>{t(item.label)}</span>)}</div>;
  return <section className={`import-receipt${hasNotes ? " has-notes" : ""}${expanded ? " is-expanded" : ""}`} aria-labelledby={titleId} aria-busy={refreshing}>
    <header className="import-receipt-heading">
      <div>
        <h2 id={titleId}>{t("{count} environment records imported or updated", { count: receipt.profiles.toLocaleString(language) })}</h2>
        <p>{t("From {count} files", { count: receipt.files.toLocaleString(language) })}<span aria-hidden="true"> · </span><time dateTime={new Date(receipt.completedAt).toISOString()}>{new Date(receipt.completedAt).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></p>
      </div>
      <div className="import-receipt-controls">
        <button className={`btn xs ${!expanded && receipt.issues.length ? "accent" : "ghost"}`} type="button" aria-expanded={expanded} aria-controls={contentId} aria-label={t(expanded ? "Hide import details" : "View import details")} onClick={() => onExpandedChange(!expanded)}>
          <AppIcon name={expanded ? "chevronUp" : "chevronDown"} className="sm" />{t("Details")}
        </button>
        <button className="iconbtn" type="button" disabled={refreshing} aria-label={t("Dismiss import result")} onClick={onDismiss}><AppIcon name="close" className="sm" /></button>
      </div>
    </header>
    {!expanded && hasNotes && totals(true)}
    {refreshing && <p className="import-receipt-feedback" role="status">{t("Refreshing environments after import…")}</p>}
    <div className="import-receipt-details" id={contentId} hidden={!expanded}>{expanded && <>
      {totals(false)}
      {receipt.proxyRepairReports > 0 && <p className="import-receipt-warning"><AppIcon name="alert" className="sm" />{t("{count} reported items were flagged for proxy repair. Review the saved configuration before starting affected environments.", { count: receipt.proxyRepairReports })}</p>}
      {issues.length ? <>
        <div className="import-receipt-list" key={page} ref={reviewList} tabIndex={0} role="region" aria-label={t("Reported import items")}>
          <ul>{issues.map((issue, index) => <li key={`${receipt.id}-${page * PAGE_SIZE + index}`}>
            <div className="import-receipt-item-meta"><strong>{issue.file || t("File name withheld")}</strong><code>{issue.id || t("Record identifier unavailable")}</code><span className={`import-receipt-item-kind${issue.proxyRepairReported ? " is-proxy" : ""}`}>{t(issue.proxyRepairReported ? "Proxy repair reported" : "Source record review")}</span></div>
            <p>{t(IMPORT_RECEIPT_REASONS[issue.reason])}</p>
          </li>)}</ul>
        </div>
        {pages > 1 && <div className="import-receipt-pager">
          <button className="btn xs" type="button" disabled={page === 0} onClick={() => goToPage(page - 1)}>{t("Previous")}</button>
          <span aria-live="polite">{t("Page {page} / {pages}", { page: page + 1, pages })}</span>
          <button className="btn xs" type="button" disabled={page + 1 >= pages} onClick={() => goToPage(page + 1)}>{t("Next")}</button>
        </div>}
      </> : <p className="import-receipt-note">{t("No individual review items were reported.")}</p>}
      <details className="import-receipt-explanation">
        <summary>{t("About this import result")}</summary>
        <p className="import-receipt-note">{t("The count includes new and updated environments. Review items alone do not show which records were imported.")}</p>
        {receipt.skipped > 0 && <p className="import-receipt-note">{t("Skipped records were not included in the imported record count. Some skipped records have no individual details.")}</p>}
        {receipt.cookiesStripped > 0 && <p className="import-receipt-note">{t("Browser-manager cookies were omitted from imported sessions.")}</p>}
        <p className="import-receipt-privacy">{t("Only file names, record identifiers, counts and fixed review reasons are shown. Original import data and error text are not retained in this receipt.")}</p>
        <p className="import-receipt-privacy">{t("This result is available in this session until dismissed or replaced by another import.")}</p>
      </details>
    </>}</div>
    <footer><div className="import-receipt-actions"><button className="btn xs" type="button" disabled={refreshing} onClick={onBrowseAll}>{t("Browse all environments")}</button><button className="btn xs ghost" type="button" disabled={refreshing} onClick={onViewAttention}>{t("View environments needing attention")}</button></div><p className="import-receipt-scope">{t("Attention covers the whole workspace, including earlier imports.")}</p></footer>
  </section>;
}
