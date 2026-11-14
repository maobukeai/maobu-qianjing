import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COOKIE_IMPORT_REASONS, createCookieImportTask, postCookieImport, type CookieImportFormat, type CookieImportInput, type CookieImportSnapshot, type CookieImportTarget, type CookieImportTask, type CookieImportTaskOptions } from "./cookie-import-task.ts";
import { useTranslation } from "./i18n.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
import { hasActiveWorkbenchModal } from "./workbench-shortcuts.ts";
import "./cookie-import-task.css";

export function useCookieImportTask(options: CookieImportTaskOptions = {}) {
  const latest = useRef(options); latest.current = options;
  const [task] = useState(() => createCookieImportTask({
    post: (ids, input) => (latest.current.post ?? postCookieImport)(ids, input),
    workspaceId: () => latest.current.workspaceId?.() ?? null,
    acquire: id => latest.current.acquire ? latest.current.acquire(id) : { release() {} },
    onSettled: snapshot => latest.current.onSettled?.(snapshot),
  }));
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  return { task, snapshot };
}

const FORMATS: Record<CookieImportFormat, string> = { single: "Single cookie", json: "JSON export", netscape: "cookies.txt" };
const STATUS = { sending: "Sending", succeeded: "Added", failed: "Not added", unconfirmed: "Needs confirmation" };
export interface CookieImportTaskPanelProps {
  snapshot: CookieImportSnapshot;
  onRetryFailed: () => void;
  onDismiss?: () => void;
  defaultExpanded?: boolean;
}
export function CookieImportTaskPanel({ snapshot, onRetryFailed, onDismiss, defaultExpanded = false }: CookieImportTaskPanelProps) {
  const { t, language } = useTranslation();
  const id = useId(), [expanded, setExpanded] = useState(defaultExpanded), [onlyAttention, setOnlyAttention] = useState(false), [requestedPage, setPage] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null), expandRef = useRef<HTMLButtonElement>(null), focusAfterRetry = useRef(false);
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing", summary = snapshot.summary;
  useEffect(() => { setPage(0); setOnlyAttention(false); }, [snapshot.batchId]);
  useEffect(() => {
    if (busy || !focusAfterRetry.current) return;
    focusAfterRetry.current = false;
    const button = retryRef.current, document = button?.ownerDocument ?? expandRef.current?.ownerDocument;
    if (document && !expandRef.current?.closest('[hidden], [inert], [aria-hidden="true"]') && (document.activeElement === document.body || document.activeElement === button)) {
      (button && !button.disabled ? button : expandRef.current)?.focus({ preventScroll: true });
    }
  }, [busy, snapshot]);
  if (snapshot.phase === "idle" && !snapshot.blockedReason) return null;
  const filtered = snapshot.rows.filter(row => !onlyAttention || row.status === "failed" || row.status === "unconfirmed");
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), page = Math.min(requestedPage, pages - 1);
  const title = snapshot.phase === "sending" ? "Importing cookies…" : snapshot.phase === "refreshing" ? "Refreshing cookie import results…"
    : summary.unconfirmed ? "Cookie import needs confirmation" : summary.failed ? "Cookie import needs review" : "Cookie import completed";
  return <section className={`cookie-import-task${summary.unconfirmed || summary.failed ? " has-attention" : ""}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <header><div><h2 id={`${id}-title`}>{t(title)}</h2><p>{t("{count} environments · {format}", { count: summary.total.toLocaleString(language), format: snapshot.format ? t(FORMATS[snapshot.format]) : t("Cookie import") })}</p></div><div className="cookie-import-controls"><button ref={expandRef} type="button" className="btn xs ghost" aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>{t(expanded ? "Hide cookie import details" : "View cookie import details")}</button>{onDismiss && <button type="button" className="iconbtn" disabled={busy} aria-label={t("Dismiss cookie import result")} onClick={onDismiss}>×</button>}</div></header>
    <div className="cookie-import-summary" role="status" aria-live="polite">
      <span><strong>{summary.succeeded.toLocaleString(language)}</strong>{t("Added")}</span>
      {summary.failed > 0 && <span><strong>{summary.failed.toLocaleString(language)}</strong>{t("Not added")}</span>}
      {summary.unconfirmed > 0 && <span><strong>{summary.unconfirmed.toLocaleString(language)}</strong>{t("Needs confirmation")}</span>}
      {snapshot.phase === "sending" && <span className="cookie-import-working"><i aria-hidden="true" />{t("Waiting for the local service…")}</span>}
      {snapshot.phase === "refreshing" && <span>{t("Refreshing environments…")}</span>}
    </div>
    {snapshot.blockedReason && <p className="cookie-import-alert" role="alert">{t(snapshot.blockedReason)}</p>}
    {busy && <p className="cookie-import-note">{t("Targets, format and cookie input are fixed for this attempt. Hiding this window does not cancel requests already sent.")}</p>}
    {summary.unconfirmed > 0 && <p className="cookie-import-alert" role="alert">{t(COOKIE_IMPORT_REASONS.unconfirmed)}</p>}
    {snapshot.refreshFailed && <p className="cookie-import-alert" role="alert">{t("The cookie request settled, but the environment list could not refresh. Refresh the list before reviewing pending cookies.")}</p>}
    <div id={`${id}-details`} hidden={!expanded} className="cookie-import-details">
      {summary.cookieCount !== null && <p className="cookie-import-note">{t("{count} cookie(s) per successful environment: {now} open browser(s) now, {later} at next start.", { count: summary.cookieCount.toLocaleString(language), now: summary.live.toLocaleString(language), later: summary.nextStart.toLocaleString(language) })}</p>}
      <p className="cookie-import-note">{t("The service reports when cookies apply as totals, without assigning a time to each environment.")}</p>
      <div className="cookie-import-filters"><button type="button" className="btn xs ghost" aria-pressed={!onlyAttention} onClick={() => { setOnlyAttention(false); setPage(0); }}>{t("All environments")}</button><button type="button" className="btn xs ghost" aria-pressed={onlyAttention} onClick={() => { setOnlyAttention(true); setPage(0); }}>{t("Needs review")}</button></div>
      <div className="cookie-import-list" tabIndex={0} aria-label={t("Cookie import environments")}><ul>{filtered.slice(page * 50, (page + 1) * 50).map(row => <li key={row.id} className={`cookie-import-row is-${row.status}`}><div><strong>{row.name ?? t("Environment {number}", { number: row.number })}</strong><span>{t(STATUS[row.status])}</span></div>{row.reason && <p>{t(COOKIE_IMPORT_REASONS[row.reason])}</p>}<small>{t("Attempt {count}", { count: row.attempts })}</small></li>)}</ul>{!filtered.length && <p className="cookie-import-note">{t("No environments need review.")}</p>}</div>
      {pages > 1 && <div className="cookie-import-pager"><button type="button" className="btn xs" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("Previous")}</button><span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span><button type="button" className="btn xs" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t("Next")}</button></div>}
      <p className="cookie-import-privacy">{t("Results contain only safe environment names, counts and fixed reasons. Cookie input is kept privately in memory only while failed items can be retried.")}</p>
    </div>
    {summary.retryable > 0 && <footer><button ref={retryRef} type="button" className="btn xs" disabled={busy} onClick={() => { focusAfterRetry.current = true; onRetryFailed(); }}>{t("Retry {count} failed environments", { count: summary.retryable.toLocaleString(language) })}</button><p>{t("Retry uses the original cookie input and only the failed environments. Successful environments are excluded.")}</p></footer>}
  </section>;
}

export interface CookieImportTaskDialogProps { open?: boolean; task: CookieImportTask; targets: readonly CookieImportTarget[]; onClose: () => void }
/** Keep the task in App, above this dialog: closing the dialog only hides it. */
export function CookieImportTaskDialog({ open = true, task, targets, onClose }: CookieImportTaskDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null), closeRef = useRef(onClose), live = useRef(open), previousOpen = useRef(false), session = useRef(0);
  closeRef.current = onClose; live.current = open;
  if (open && !previousOpen.current) session.current++;
  previousOpen.current = open;
  const sessionId = session.current;
  // Focus ownership follows open immediately; retained exit content owns only its visual appearance.
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current, document = dialog?.ownerDocument, previous = document?.activeElement;
    dialog?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab" || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
      const first = buttons[0], last = buttons.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document?.activeElement === first || document?.activeElement === dialog || !dialog.contains(document?.activeElement ?? null))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document?.activeElement === last || document?.activeElement === dialog || !dialog.contains(document?.activeElement ?? null))) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (dialog && !dialog.contains(event.target as Node)) dialog.focus({ preventScroll: true }); };
    document?.addEventListener("keydown", keydown, true); document?.addEventListener("focusin", focus);
    return () => {
      document?.removeEventListener("keydown", keydown, true); document?.removeEventListener("focusin", focus);
      if (dialog && document && previous instanceof HTMLElement && previous.isConnected && !previous.closest('[hidden], [inert], [aria-hidden="true"]')
        && !hasActiveWorkbenchModal(document, dialog) && (document.activeElement === document.body || dialog.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [open, sessionId]);
  if (typeof document === "undefined") return null;
  return createPortal(<MotionPresence present={open}>{() => <CookieImportTaskDialogSession key={sessionId} task={task} targets={targets} onClose={onClose} dialogRef={dialogRef} live={live} />}</MotionPresence>, document.body);
}

function CookieImportTaskDialogSession({ task, targets, onClose, dialogRef, live }: CookieImportTaskDialogProps & { dialogRef: RefObject<HTMLDivElement | null>; live: RefObject<boolean> }) {
  const { t } = useTranslation(), id = useId();
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  const [initialBatchId] = useState(snapshot.batchId), [resumeExisting] = useState(task.isBusy()), [submitted, setSubmitted] = useState(false), [format, setFormat] = useState<CookieImportFormat>("json");
  const [text, setText] = useState(""), [form, setForm] = useState({ name: "", value: "", domain: targets.length === 1 ? targets[0]?.platform ?? "" : "", path: "/" });
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing", showingResult = resumeExisting || submitted && snapshot.batchId !== initialBatchId;
  useEffect(() => { if (showingResult && live.current) dialogRef.current?.focus({ preventScroll: true }); }, [showingResult]);
  const send = () => {
    if (task.isBusy()) return;
    const input: CookieImportInput = format === "single" ? { format, input: form } : { format, input: { text } };
    const operation = task.submit(targets, input); setSubmitted(true);
    if (task.getSnapshot().batchId !== initialBatchId) { setText(""); setForm({ name: "", value: "", domain: "", path: "/" }); }
    void operation;
  };
  return <div className="modal-backdrop cookie-import-backdrop"><div className="modal cookie-import-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialogRef}>
    <div className="modal-head"><h2 id={`${id}-title`}>{t("Add cookies to {count} environments", { count: showingResult ? snapshot.summary.total : targets.length })}</h2><button type="button" className="modal-close" aria-label={t(busy ? "Hide cookie import window" : "Close")} onClick={onClose}>×</button></div>
    <div className="modal-body">{showingResult ? <CookieImportTaskPanel snapshot={snapshot} defaultExpanded onRetryFailed={() => { void task.retryFailed(); }} /> : <form id={`${id}-form`} onSubmit={event => { event.preventDefault(); send(); }}>
      <p className="cookie-import-note">{t("Open browsers get cookies now. Closed environments keep them for their next start.")}</p>
      {submitted && snapshot.blockedReason && <p className="cookie-import-alert" role="alert">{t(snapshot.blockedReason)}</p>}
      <fieldset className="cookie-import-fields" disabled={busy}><legend>{t("Cookie format")}</legend><div className="cookie-import-format" role="radiogroup" aria-label={t("Cookie format")}>{(["json", "netscape", "single"] as const).map(option => <button key={option} type="button" role="radio" aria-checked={format === option} className="btn" onClick={() => setFormat(option)}>{t(FORMATS[option])}</button>)}</div>
        {format !== "single" ? <label className="fld"><span>{t(format === "json" ? "Paste cookie JSON" : "Paste cookies.txt content")}</span><textarea value={text} rows={7} spellCheck={false} autoComplete="off" onChange={event => setText(event.target.value)} placeholder={format === "json" ? '[{"name":"session","value":"…","domain":"example.com","path":"/"}]' : t("Paste the tab-separated Netscape export here")} /><small className="cookie-import-privacy">{t("Cookie values stay private. They are never included in result messages.")}</small></label> : <><div className="fld-row"><label className="fld grow"><span>{t("Name")}</span><input autoComplete="off" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></label><label className="fld grow"><span>{t("Value")}</span><input type="password" autoComplete="off" value={form.value} onChange={event => setForm(value => ({ ...value, value: event.target.value }))} /></label></div><div className="fld-row"><label className="fld grow"><span>{t("Domain")}</span><input value={form.domain} placeholder="example.com" onChange={event => setForm(value => ({ ...value, domain: event.target.value }))} /></label><label className="fld port"><span>{t("Path")}</span><input value={form.path} onChange={event => setForm(value => ({ ...value, path: event.target.value }))} /></label></div></>}
      </fieldset>
    </form>}</div>
    <div className="modal-foot"><button className="btn ghost" type="button" onClick={onClose}>{t(busy ? "Hide window · import continues" : "Close")}</button>{!showingResult && <button form={`${id}-form`} type="submit" className="btn primary" disabled={busy || (format === "single" ? !form.name || !form.domain.trim() || !form.path.startsWith("/") : !text.trim())}>{t("Import cookies")}</button>}</div>
  </div></div>;
}
