import { useEffect, useId, useRef, useState } from "react";
import type { BulkProfileTaskRow, BulkProfileTaskSnapshot } from "./bulk-profile-task.ts";
import { useTranslation } from "./i18n.tsx";
import "./bulk-profile-task-panel.css";

export interface BulkProfileTaskPanelProps {
  snapshot: BulkProfileTaskSnapshot;
  expanded: boolean;
  refreshing?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onStopPending: () => void;
  onRetryFailed: () => void;
  onDismiss: () => void;
}
const PAGE_SIZE = 50;
const ACTION_LABELS = { open: "Batch start", close: "Batch close", restart: "Batch restart" };
const STATUS_LABELS = { pending: "Queued", running: "In progress", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped" };

function rowMatches(row: BulkProfileTaskRow, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${row.name} ${row.id}`.toLocaleLowerCase().includes(needle);
}

/** Controlled, session-only task view. Closing the panel never stops browser requests. */
export function BulkProfileTaskPanel({ snapshot, expanded, refreshing = false, onExpandedChange, onStopPending, onRetryFailed, onDismiss }: BulkProfileTaskPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | "failed" | "skipped">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const contentId = useId(), titleId = useId();
  const expandButton = useRef<HTMLButtonElement>(null), focusAfterStop = useRef(false);
  const { summary } = snapshot;
  const active = snapshot.phase === "running" || snapshot.phase === "stopping";
  const complete = snapshot.phase === "complete";
  const canStop = summary.pending > 0 && !complete && snapshot.phase !== "stopping";
  useEffect(() => {
    if (!focusAfterStop.current || canStop) return;
    focusAfterStop.current = false;
    if (!expandButton.current?.closest("[hidden]")) expandButton.current?.focus({ preventScroll: true });
  }, [canStop]);
  useEffect(() => { setFilter("all"); setSearch(""); setPage(0); }, [snapshot.id]);
  const rows = snapshot.rows.filter(row => (filter === "all" || row.status === filter) && rowMatches(row, search));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visiblePage = Math.max(0, Math.min(page, pages - 1));
  const visible = rows.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const phaseText = snapshot.phase === "stopping"
    ? t("Dispatch stopped. Waiting for {count} requests already sent to finish.", { count: summary.running })
    : snapshot.phase === "running" ? t("{count} requests are in progress. Up to four run at a time.", { count: summary.running })
    : snapshot.phase === "idle" ? t("The selected task is waiting to start.")
    : t("Task finished: {succeeded} succeeded, {failed} failed, {skipped} skipped.", { succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped });
  const reason = (row: BulkProfileTaskRow) => row.cause === "stopped"
    ? t("Stopped before dispatch. No request was sent for this environment.")
    : row.skipReason ? t(row.skipReason) : null;

  const outcome = !complete ? "active" : summary.failed ? "failed" : summary.skipped ? "partial" : "succeeded";
  return <section className={`bulk-profile-task-panel${expanded ? " is-expanded" : ""}`} data-outcome={outcome} aria-labelledby={titleId}>
    <header className="bulk-task-heading">
      <div className="bulk-task-title"><span className={`bulk-task-indicator ${snapshot.phase}${complete && summary.failed ? " has-failures" : complete && summary.skipped ? " has-skipped" : ""}`} aria-hidden="true" /><h2 id={titleId}>{t(ACTION_LABELS[snapshot.action])}</h2><span className="bulk-task-total">{t("{settled} / {total} items settled", { settled: summary.settled, total: summary.total })}</span></div>
      <div className="bulk-task-controls">
        {canStop && <button className="btn xs" type="button" onClick={() => { focusAfterStop.current = true; onStopPending(); }}>{t("Stop queued items")}</button>}
        <button className="btn xs ghost" type="button" disabled={refreshing || !complete || !summary.failed} onClick={onRetryFailed}>{t("Retry {count} failed items", { count: summary.failed })}</button>
        <button className="btn xs ghost bulk-task-expand" ref={expandButton} type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => onExpandedChange(!expanded)}>{t(expanded ? "Collapse task details" : "Show task details")}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg></button>
        <button className="iconbtn bulk-task-dismiss" type="button" aria-label={t("Dismiss batch task")} title={t(complete ? "Dismiss batch task" : "Wait for requests to finish before dismissing this task.")} disabled={!complete || refreshing} onClick={onDismiss}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M5 15 15 5" /></svg></button>
      </div>
    </header>
    <div className="bulk-task-progress"><progress max={Math.max(1, summary.total)} value={summary.settled} aria-label={t("Batch task progress")} aria-valuetext={t("{settled} / {total} items settled", { settled: summary.settled, total: summary.total })} /><p role="status">{phaseText}</p></div>
    {refreshing && <p className="bulk-task-note" role="status">{t("Refreshing environment status before retry…")}</p>}
    <div className="bulk-task-details" id={contentId} hidden={!expanded}>
      <div className="bulk-task-summary" aria-label={t("Batch task totals")}><span>{t("Running {count}", { count: summary.running })}</span><span>{t("Succeeded {count}", { count: summary.succeeded })}</span><span className={summary.failed ? "has-failures" : ""}>{t("Failed {count}", { count: summary.failed })}</span><span>{t("Skipped {count}", { count: summary.skipped })}</span></div>
      {active && <p className="bulk-task-note">{t("Stopping queued items does not undo requests already sent. You can collapse this panel or change pages while they finish.")}</p>}
      {!active && summary.failed > 0 && <p className="bulk-task-note">{t("Retry runs failed items only. Successful and skipped items are not sent again.")}</p>}
      <div className="bulk-task-result-tools"><div className="bulk-task-filters" role="group" aria-label={t("Filter batch task results")}>{(["all", "failed", "skipped"] as const).map(value => <button className="btn xs ghost" type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }}>{t(value === "all" ? "All task items" : value === "failed" ? "Failed items" : "Skipped items")}</button>)}</div><label className="bulk-task-search"><span className="sr-only">{t("Search batch task environments")}</span><input className="input" type="search" value={search} placeholder={t("Search environment name or ID")} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label></div>
      <div className="bulk-task-rows" tabIndex={0} aria-label={t("Batch task item results")}>
        {visible.length ? <ul>{visible.map(row => <li key={row.id} className={`bulk-task-row ${row.status}`}><div className="bulk-task-row-heading"><div><strong>{row.name || row.id}</strong><code>{row.id}</code></div><span className={`bulk-task-status ${row.status}`}>{t(STATUS_LABELS[row.status])}</span></div><div className="bulk-task-row-detail">{row.attempts > 0 && <small>{t("Attempt {count}", { count: row.attempts })}</small>}{row.error && <p className="bulk-task-error">{t(row.error)}</p>}{row.warning && <p className="bulk-task-warning">{t(row.warning)}</p>}{reason(row) && <p>{reason(row)}</p>}</div></li>)}</ul> : <p className="bulk-task-empty">{t(search.trim() ? "No task items match this environment name or ID." : filter === "failed" ? "No failed items in the current results." : filter === "skipped" ? "No skipped items in the current results." : "This task has no environment items.")}</p>}
      </div>
      {pages > 1 && <div className="bulk-task-pager"><span>{t("{count} matching task items", { count: rows.length })}</span><button type="button" className="btn xs ghost" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>{t("Previous")}</button><span>{t("Page {page} / {pages}", { page: visiblePage + 1, pages })}</span><button type="button" className="btn xs ghost" disabled={visiblePage + 1 >= pages} onClick={() => setPage(visiblePage + 1)}>{t("Next")}</button></div>}
    </div>
  </section>;
}
