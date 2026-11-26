import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COOKIE_IMPORT_REASONS, createCookieImportTask, postCookieImport, type CookieImportFormat, type CookieImportInput, type CookieImportSnapshot, type CookieImportTarget, type CookieImportTask, type CookieImportTaskOptions } from "./cookie-import-task.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon, useDialogKeyboard } from "./ui-primitives.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
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

const FORMATS = { json: "JSON export", netscape: "cookies.txt", single: "Single cookie" } satisfies Record<CookieImportFormat, string>;
const STATUS = { sending: "Sending", succeeded: "Added", failed: "Not added", unconfirmed: "Needs confirmation" };

function rejectedAttempt(snapshot: CookieImportSnapshot) {
  const reason = snapshot.rows[0]?.reason;
  return (reason === "input-rejected" || reason === "request-rejected") && snapshot.rows.every(row => row.reason === reason) ? reason : null;
}

export interface CookieImportTaskPanelProps {
  snapshot: CookieImportSnapshot;
  onRetryFailed: () => void;
  onDismiss?: () => void;
  defaultExpanded?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}
export function CookieImportTaskPanel({ snapshot, onRetryFailed, onDismiss, defaultExpanded = false, headingRef }: CookieImportTaskPanelProps) {
  const { t, language } = useTranslation();
  const id = useId(), [expanded, setExpanded] = useState(defaultExpanded), [onlyAttention, setOnlyAttention] = useState(false), [requestedPage, setPage] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null), expandRef = useRef<HTMLButtonElement>(null), focusAfterRetry = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing", summary = snapshot.summary;
  const rejection = rejectedAttempt(snapshot);
  const hasAttention = summary.failed > 0 || summary.unconfirmed > 0 || snapshot.refreshFailed;
  useEffect(() => { setPage(0); setOnlyAttention(false); }, [snapshot.batchId]);
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [requestedPage, onlyAttention, snapshot.batchId]);
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
  return <section className={`cookie-import-task${hasAttention ? " has-attention" : ""}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <header>
      <div className="cookie-import-title">
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{t(title)}</h2>
        <p>{t("{count} environments · {format}", { count: summary.total.toLocaleString(language), format: snapshot.format ? t(FORMATS[snapshot.format]) : t("Cookie import") })}</p>
      </div>
      <div className="cookie-import-controls">
        <button ref={expandRef} type="button" className="btn xs ghost" aria-label={t(expanded ? "Hide cookie import details" : "View cookie import details")} aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}><AppIcon name={expanded ? "chevronUp" : "chevronDown"} className="sm" />{t("Details")}</button>
        {onDismiss && <button type="button" className="iconbtn" disabled={busy} aria-label={t("Dismiss cookie import result")} onClick={onDismiss}><AppIcon name="close" className="sm" /></button>}
      </div>
    </header>
    <div className="cookie-import-summary" role="status" aria-live="polite">
      <span><strong>{summary.succeeded.toLocaleString(language)}</strong>{t("Added")}</span>
      {summary.failed > 0 && <span><strong>{summary.failed.toLocaleString(language)}</strong>{t("Not added")}</span>}
      {summary.unconfirmed > 0 && <span><strong>{summary.unconfirmed.toLocaleString(language)}</strong>{t("Needs confirmation")}</span>}
      {snapshot.phase === "sending" && <span className="cookie-import-working"><i aria-hidden="true" />{t("Waiting for the local service…")}</span>}
      {snapshot.phase === "refreshing" && <span>{t("Refreshing environments…")}</span>}
    </div>
    {snapshot.blockedReason && <p className="cookie-import-alert" role="alert">{t(snapshot.blockedReason)}</p>}
    {rejection && <p className="cookie-import-alert" role="alert">{t(COOKIE_IMPORT_REASONS[rejection])}</p>}
    {summary.unconfirmed > 0 && <p className="cookie-import-alert" role="alert">{t(COOKIE_IMPORT_REASONS.unconfirmed)}</p>}
    {snapshot.refreshFailed && <p className="cookie-import-alert" role="alert">{t("The cookie request settled, but the environment list could not refresh. Refresh the list before reviewing pending cookies.")}</p>}
    <div id={`${id}-details`} hidden={!expanded} className="cookie-import-details">{expanded && <>
      {summary.cookieCount !== null && <p className="cookie-import-note">{t("{count} cookie(s) per successful environment: {now} open browser(s) now, {later} at next start.", { count: summary.cookieCount.toLocaleString(language), now: summary.live.toLocaleString(language), later: summary.nextStart.toLocaleString(language) })}</p>}
      {(summary.failed > 0 || summary.unconfirmed > 0 || onlyAttention) && <div className="cookie-import-filters"><button type="button" className="btn xs ghost" aria-pressed={!onlyAttention} onClick={() => { setOnlyAttention(false); setPage(0); }}>{t("All environments")}</button><button type="button" className="btn xs ghost" aria-pressed={onlyAttention} onClick={() => { setOnlyAttention(true); setPage(0); }}>{t("Needs review")}</button></div>}
      {filtered.length > 0 ? <div ref={listRef} className="cookie-import-list" tabIndex={0} role="region" aria-label={t("Cookie import environments")}><ul>{filtered.slice(page * 50, (page + 1) * 50).map(row => <li key={row.id} className={`cookie-import-row is-${row.status}`}><div><strong>{row.name ?? t("Environment {number}", { number: row.number })}</strong><span>{t(STATUS[row.status])}</span></div>{row.reason && row.reason !== rejection && row.reason !== "unconfirmed" && <p>{t(COOKIE_IMPORT_REASONS[row.reason])}</p>}{row.attempts > 1 && <small>{t("Attempt {count}", { count: row.attempts })}</small>}</li>)}</ul></div> : <p className="cookie-import-note">{t("No environments need review.")}</p>}
      {pages > 1 && <div className="cookie-import-pager"><button type="button" className="btn xs" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("Previous")}</button><span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span><button type="button" className="btn xs" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t("Next")}</button></div>}
    </>}</div>
    {summary.retryable > 0 && <footer><button ref={retryRef} type="button" className="btn xs" disabled={busy} onClick={() => { focusAfterRetry.current = true; onRetryFailed(); }}>{t("Retry {count} failed environments", { count: summary.retryable.toLocaleString(language) })}</button><p>{t("Retry uses the original cookie input and only the failed environments. Successful environments are excluded.")}</p></footer>}
  </section>;
}

export interface CookieImportTaskDialogProps { open?: boolean; task: CookieImportTask; targets: readonly CookieImportTarget[]; onClose: () => void }
/** Keep the task in App, above this dialog: closing the dialog only hides it. */
export function CookieImportTaskDialog({ open = true, task, targets, onClose }: CookieImportTaskDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null), formatRef = useRef<HTMLInputElement>(null), resultRef = useRef<HTMLHeadingElement>(null);
  const live = useRef(open), previousOpen = useRef(false), session = useRef(0);
  live.current = open;
  if (open && !previousOpen.current) session.current++;
  previousOpen.current = open;
  const sessionId = session.current;
  useDialogKeyboard(dialogRef, open, onClose, () => formatRef.current ?? resultRef.current);
  if (typeof document === "undefined") return null;
  return createPortal(<MotionPresence present={open}>{() => <CookieImportTaskDialogSession key={sessionId} task={task} targets={targets} onClose={onClose} dialogRef={dialogRef} formatRef={formatRef} resultRef={resultRef} live={live} />}</MotionPresence>, document.body);
}

interface CookieImportSessionProps extends CookieImportTaskDialogProps {
  dialogRef: RefObject<HTMLDivElement | null>;
  formatRef: RefObject<HTMLInputElement | null>;
  resultRef: RefObject<HTMLHeadingElement | null>;
  live: RefObject<boolean>;
}

function CookieImportTaskDialogSession({ task, targets, onClose, dialogRef, formatRef, resultRef, live }: CookieImportSessionProps) {
  const { t, language } = useTranslation(), id = useId();
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  const [showingResult, setShowingResult] = useState(task.isBusy);
  const [submitted, setSubmitted] = useState(false), [format, setFormat] = useState<CookieImportFormat>("json");
  const [drafts, setDrafts] = useState({ json: "", netscape: "" });
  const emptyForm = { name: "", value: "", domain: targets.length === 1 ? targets[0]?.platform ?? "" : "", path: "/" };
  const [form, setForm] = useState(emptyForm);
  const submittedBatch = useRef<number | null>(null);
  const busy = snapshot.phase === "sending" || snapshot.phase === "refreshing";
  const text = format === "single" ? "" : drafts[format];
  const canSubmit = format === "single" ? !!form.name.trim() && !!form.domain.trim() && form.path.startsWith("/") : !!text.trim();
  const canStartAgain = showingResult && !busy && submittedBatch.current === snapshot.batchId && rejectedAttempt(snapshot) === "input-rejected";
  useEffect(() => {
    if (submittedBatch.current !== null && live.current) (showingResult ? resultRef.current : formatRef.current)?.focus({ preventScroll: true });
  }, [showingResult, formatRef, live, resultRef]);
  const send = () => {
    if (task.isBusy() || !canSubmit) return;
    const input: CookieImportInput = format === "single" ? { format, input: form } : { format, input: { text } };
    const before = task.getSnapshot().batchId;
    const operation = task.submit(targets, input);
    setSubmitted(true);
    const after = task.getSnapshot().batchId;
    if (after !== before) {
      submittedBatch.current = after;
      setDrafts({ json: "", netscape: "" });
      setForm(emptyForm);
      setShowingResult(true);
    }
    void operation;
  };
  return <div className="modal-backdrop cookie-import-backdrop"><div className="modal cookie-import-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialogRef}>
    <div className="modal-head">
      <span className="modal-title-icon"><AppIcon name="cookie" /></span>
      <h2 id={`${id}-title`}>{t("Import cookies")}</h2>
      <button type="button" className="modal-close" aria-label={t(busy ? "Hide cookie import window" : "Close")} onClick={onClose}><AppIcon name="close" className="sm" /></button>
    </div>
    <div className="modal-body">
      {showingResult ? <CookieImportTaskPanel snapshot={snapshot} headingRef={resultRef} onRetryFailed={() => { void task.retryFailed(); }} /> : <form id={`${id}-form`} onSubmit={event => { event.preventDefault(); send(); }}>
        <p className="cookie-import-target"><strong>{t("Target environments ({count} selected)", { count: targets.length.toLocaleString(language) })}</strong></p>
        {submitted && snapshot.blockedReason && <p className="cookie-import-alert" role="alert">{t(snapshot.blockedReason)}</p>}
        <fieldset className="cookie-import-fields" disabled={busy}>
          <legend>{t("Cookie format")}</legend>
          <div className="cookie-import-format">
            {(["json", "netscape", "single"] as const).map(option => <label key={option}>
              <input ref={format === option ? formatRef : undefined} type="radio" name={`${id}-format`} value={option} checked={format === option} onChange={() => setFormat(option)} />
              <span>{t(FORMATS[option])}</span>
            </label>)}
          </div>
          {format === "single" ? <div className="cookie-import-single">
            <label className="fld"><span>{t("Name")}</span><input autoComplete="off" spellCheck={false} value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></label>
            <label className="fld"><span>{t("Value")}</span><input type="password" autoComplete="off" value={form.value} onChange={event => setForm(value => ({ ...value, value: event.target.value }))} /></label>
            <label className="fld"><span>{t("Domain")}</span><input autoComplete="off" spellCheck={false} value={form.domain} placeholder="example.com" onChange={event => setForm(value => ({ ...value, domain: event.target.value }))} /></label>
            <label className="fld"><span>{t("Path")}</span><input autoComplete="off" spellCheck={false} value={form.path} onChange={event => setForm(value => ({ ...value, path: event.target.value }))} /></label>
          </div> : <label className="fld">
            <span>{t(format === "json" ? "Paste cookie JSON" : "Paste cookies.txt content")}</span>
            <textarea key={format} value={text} rows={6} spellCheck={false} autoComplete="off" onChange={event => setDrafts(value => ({ ...value, [format]: event.target.value }))} placeholder={format === "json" ? '[{"name":"session","value":"…","domain":"example.com","path":"/"}]' : t("Paste the tab-separated Netscape export here")} />
          </label>}
        </fieldset>
        <div className="cookie-import-form-notes">
          <p className="cookie-import-timing"><AppIcon name="alert" className="sm" />{t("Open browsers get cookies now. Closed environments keep them for their next start.")}</p>
          <p>{t("Cookie values stay private. They are never included in result messages.")}</p>
        </div>
      </form>}
    </div>
    <div className="modal-foot">
      <button className="btn ghost" type="button" onClick={onClose}>{t(busy ? "Hide window · import continues" : "Close")}</button>
      {!showingResult && <button form={`${id}-form`} type="submit" className="btn primary" disabled={busy || !canSubmit}>{t("Import cookies")}</button>}
      {canStartAgain && <button type="button" className="btn primary" onClick={() => { setSubmitted(false); setShowingResult(false); }}>{t("New import")}</button>}
    </div>
  </div></div>;
}
