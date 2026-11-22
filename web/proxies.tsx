import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useTranslation } from "./i18n.tsx";
import { proxyExitNote } from "./proxy-check-presentation.ts";
import { proxyProblemSummary } from "./proxy-problem-summary.ts";
import { createProxyAssignmentTask, type ProxyAssignmentAttempt, type ProxyAssignmentReason, type ProxyAssignmentReceipt, type ProxyAssignmentRow, type ProxyAssignmentSnapshot } from "./proxy-assignment-task.ts";
import { LocalProxyAssignmentDraft, localProxyAssignmentEndpoint, type LocalProxyAssignmentIntent, type LocalProxyAssignmentProfile } from "./local-proxy-assignment-draft.tsx";
import { useOptionalWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { folderScope, type FolderInfo } from "../folders.ts";
import { analyzeProxyList, matchingProxyChecks, proxyCheckOverview, proxyRosterSignature, proxyScopeOverview, type ProxyScopeProfile } from "./proxy-workflow.ts";
import type {
  ProxyCheckView,
  ProxyPreview,
  ProxyPreviewInput,
  ProxyProgressEvent,
  ProxyReplacementMode,
  ProxyReplacementView,
  ProxyScope,
  SingleProxyPreviewInput,
} from "../proxy-tools-types.ts";

export class ProxyToolsError extends Error {}

const PAGE_SIZE = 50;
const CHECK_STATUSES = ["working", "failed", "unstable", "unavailable", "missing", "invalid", "unsupported"] as const;
function getCheckLabel(t: (key: string) => string, status: ProxyCheckView["status"]): string {
  const labels: Record<ProxyCheckView["status"], string> = {
    working: t("Reachable"), failed: t("Connection failed"), unstable: t("Unstable"), unavailable: t("Not verified"),
    missing: t("Missing proxy"), invalid: t("Invalid proxy"), unsupported: t("Unsupported"),
  };
  return labels[status];
}
function getReplacementLabel(t: (key: string) => string, status: ProxyAssignmentRow["status"]): string {
  const labels: Record<ProxyAssignmentRow["status"], string> = {
    ready: t("Ready"), updated: t("Updated"), unchanged: t("No change"), missing: t("No match"), skipped: t("Skipped"), failed: t("Failed"),
    applying: t("Applying…"), unknown: t("Outcome unconfirmed"), "not-started": t("Not started"),
  };
  return labels[status];
}
function getReasonLabel(t: (key: string) => string, reason: string): string {
  const reasons: Record<string, string> = {
    authentication_failed: t("Authentication failed"), timeout: t("Timed out"), dns_failed: t("DNS lookup failed"),
    unreachable: t("Cannot connect"), connection_failed: t("Connection failed"), intermittent: t("Intermittent connection"),
    proxy_bypassed: t("Connection bypassed the proxy"), check_unavailable: t("Check service unavailable"),
    same_exit: t("Same exit as the system network"),
    profile_open: t("Close this profile before replacing its proxy"), version_conflict: t("Profile changed; preview again"),
    profile_trashed: t("Profile is in Trash"), invalid_row: t("Invalid input row"), invalid_proxy: t("Invalid proxy"),
    duplicate_selector: t("Duplicate input selector"), duplicate_target: t("Conflicting assignments"),
    no_editable_match: t("No editable profile matched"), ambiguous_username: t("More than one profile matched"),
    unsupported: t("This proxy type cannot be checked"),
    cancelled: t("Not completed"), folder_access_denied: t("Folder access denied"),
  };
  return reasons[reason] || t("Check could not complete");
}

export function proxyScope(all: boolean, groups: string[], ids?: string[]): ProxyScope {
  return { ...(all ? { all: true } : { groups: [...new Set(groups)] }), ...(ids ? { ids: [...new Set(ids)] } : {}) };
}

export function proxyResultPage<T>(rows: T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  return { items: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, pages, total: rows.length };
}

function checkNeedsRetry(row: ProxyCheckView): boolean {
  return row.status === "failed" || row.status === "unstable" || row.status === "unavailable";
}

export function failedProxyProfileIds(rows: ProxyCheckView[]): string[] {
  return [...new Set(rows.filter(checkNeedsRetry).flatMap((row) => row.profiles.map((profile) => profile.id)))];
}

export function mergeProxyCheckResult(rows: ProxyCheckView[], next: ProxyCheckView): ProxyCheckView[] {
  const updatedIds = new Set(next.profiles.map((profile) => profile.id));
  const remaining = rows.flatMap((row) => {
    const profiles = row.profiles.filter((profile) => !updatedIds.has(profile.id));
    return profiles.length ? [{ ...row, profiles }] : [];
  });
  return [...remaining, next];
}

export function retryProxyProfileIds(rows: ProxyReplacementView[]): string[] {
  return [...new Set(rows.filter((row) => row.status === "failed" || row.status === "skipped")
    .flatMap((row) => row.profileId ? [row.profileId] : []))];
}

export function proxyRequest(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`/ui/api/proxies/${path}`, {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

function proxyAssignmentStatus(attempt: ProxyAssignmentAttempt) {
  const query = new URLSearchParams({ operationScope: attempt.operationScope, previewId: attempt.previewId });
  return fetch(`/ui/api/proxies/operations/${encodeURIComponent(attempt.attemptId)}?${query}`, {
    credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
}

const ASSIGNMENT_REASONS: Record<ProxyAssignmentReason, string> = {
  "profile-open": "Close this profile before replacing its proxy", changed: "Profile changed; preview again", "no-match": "No editable profile matched",
  "invalid-input": "Invalid input row", "no-replacement": "No replacement was supplied", "duplicate-target": "Conflicting assignments",
  "write-failed": "Could not save this proxy", "not-started": "The service did not start this row", unconfirmed: "The service could not confirm this row",
};

const ASSIGNMENT_NOTICES: Record<NonNullable<ProxyAssignmentSnapshot["notice"]>, string> = {
  "invalid-preview": "The proxy preview could not be confirmed. Preview the changes again.",
  "workspace-changed": "The workspace changed. Preview these replacements in the current workspace.",
  "workspace-busy": "Wait for the current workspace task before replacing proxies.",
  "retry-unavailable": "The failed rows could not be prepared for retry. Earlier results are still available.",
  "recovery-unavailable": "Could not verify proxy task recovery. Check the local service or update the desktop app before applying.",
  "waiting-for-backend": "Checking with the local service to confirm the replacement results.",
  "status-unavailable": "The local service could not confirm this task. Check its status again when the service is available. You can close the app normally if the result remains unconfirmed.",
  "refresh-unavailable": "The old attempt can no longer write. Refresh the environment list to finish reviewing its unconfirmed results.",
};

function AssignmentTask({ snapshot, headingRef, onStop, onReconcile, onRefresh }: {
  snapshot: ProxyAssignmentSnapshot;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onStop: () => void;
  onReconcile: () => void;
  onRefresh: () => void;
}) {
  const { t, language } = useTranslation();
  const { phase, busy, progress, notice, latest, history } = snapshot;
  if (!busy && !notice && !latest && !history.length) return null;
  const displayedReceipt = latest ?? history.at(-1);
  const confirmed = busy ? undefined : displayedReceipt?.summary;
  const reported = busy ? snapshot.summary : confirmed;
  const checkStatus = phase === "reconciling" || phase === "refreshing" && notice === "refresh-unavailable";
  const title = phase === "applying" ? "Applying proxy replacements…"
    : phase === "reconciling" ? "Confirming proxy replacement results…"
    : phase === "refreshing" ? "Refreshing environments…"
    : phase === "preflighting" ? "Checking proxy task support…"
    : phase === "preparing-retry" ? "Preparing failed rows for review…"
    : !latest && displayedReceipt ? "Most recent completed proxy replacement" : "Proxy replacement results";
  return <section className="tools-panel proxy-task-card" aria-labelledby="proxy-task-title">
    <div className="tools-panel-head">
      <div><h3 id="proxy-task-title" className="proxy-workflow-target" data-proxy-task-title tabIndex={-1} ref={headingRef}>{t(title)}</h3>
        {reported && <p>{t(busy ? "{updated} reported updated · {total} rows in this batch" : "{updated} updated · {total} rows in this batch", { updated: reported.updated.toLocaleString(language), total: reported.total.toLocaleString(language) })}</p>}
      </div>
      {phase === "applying" && !snapshot.receivingStopped && <button type="button" className="btn" onClick={onStop}>{t("Stop receiving")}</button>}
      {checkStatus && <button type="button" className="btn" onClick={onReconcile}>{t(notice === "refresh-unavailable" ? "Refresh environments" : "Check task status")}</button>}
      {!busy && latest?.refreshFailed && <button type="button" className="btn" onClick={onRefresh}>{t("Refresh environments")}</button>}
    </div>
    {(notice || snapshot.receivingStopped && busy || !busy && displayedReceipt?.refreshFailed) && <div className="proxy-task-notes" role="status">
      {notice && <p>{t(ASSIGNMENT_NOTICES[notice])}</p>}
      {snapshot.receivingStopped && busy && <p>{t("Result delivery stopped. The service may still finish work that has started.")}</p>}
      {displayedReceipt?.refreshFailed && !busy && <p>{t("The replacement result is saved. The environment list could not refresh.")}</p>}
    </div>}
    {phase === "applying" && progress && progress.total > 0 && <div className="proxy-task-meter">
      <progress aria-label={t("Proxy operation progress")} value={progress.completed} max={progress.total} />
      <span>{progress.completed.toLocaleString(language)} / {progress.total.toLocaleString(language)}</span>
    </div>}
    {confirmed && <div className="proxy-task-counts">
      <span>{t("{count} need attention", { count: confirmed.failed + confirmed.skipped + confirmed.missing })}</span>
      <span>{t("{count} unconfirmed", { count: confirmed.unknown })}</span>
      <span>{t("{count} not started", { count: confirmed.notStarted })}</span>
    </div>}
    {history.length > 0 && <details className="proxy-task-history"><summary>{t("Replacement history for this session")}</summary>
      <ul>{[...history].reverse().map(entry => <li key={`${entry.batch}:${entry.attempt}`}>
        <span>{t("Batch {batch} · Attempt {attempt}", { batch: entry.batch, attempt: entry.attempt })}</span>
        <time dateTime={new Date(entry.completedAt).toISOString()}>{new Date(entry.completedAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}</time>
        <span>{t("{updated} updated · {total} rows in this batch", { updated: entry.summary.updated, total: entry.summary.total })}</span>
        {entry.summary.unknown > 0 && <span>{t("{count} unconfirmed", { count: entry.summary.unknown })}</span>}
      </li>)}</ul>
    </details>}
  </section>;
}

async function previewResponse(response: Response, t: (key: string) => string): Promise<ProxyPreview> {
  if (!response.ok) {
    if (response.status === 409) throw new ProxyToolsError(t("The preview may have expired, or another replacement is still running. Wait for it to finish, then preview again."));
    if (response.status === 401 || response.status === 403) throw new ProxyToolsError(t("You do not have access to this proxy operation."));
    if (response.status === 404 || response.status === 501 || response.status === 503) throw new ProxyToolsError(t("Bulk proxy tools are not available on this server."));
    throw new ProxyToolsError(t("Could not preview replacements. Check the input format and selected folders."));
  }
  let body: ProxyPreview;
  try { body = await response.json(); } catch { throw new ProxyToolsError(t("The proxy preview returned invalid data.")); }
  if (body?.ok !== true || typeof body.previewId !== "string" || !Array.isArray(body.rows) || !Number.isInteger(body.unusedProxies)) {
    throw new ProxyToolsError(t("The proxy preview returned invalid data."));
  }
  return body;
}

export async function requestProxyPreview(input: ProxyPreviewInput, t: (key: string) => string, signal?: AbortSignal): Promise<ProxyPreview> {
  return previewResponse(await proxyRequest("preview", input, signal), t);
}

export async function readProxyProgress(
  response: Response, onEvent: (event: ProxyProgressEvent) => void, t: (key: string) => string, signal?: AbortSignal,
): Promise<void> {
  if (response.status === 409) throw new ProxyToolsError(t("The preview may have expired, or another replacement is still running. Wait for it to finish, then preview again."));
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw new ProxyToolsError(t("The proxy operation could not start. Check your connection and server version."));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const accept = (line: string) => {
    if (!line.trim()) return;
    let event: ProxyProgressEvent;
    try { event = JSON.parse(line); } catch { throw new ProxyToolsError(t("The proxy operation returned incomplete data.")); }
    if (!event || typeof event !== "object" || done) throw new ProxyToolsError(t("The proxy operation returned invalid data."));
    switch (event.type) {
      case "progress":
        if (!["loading", "checking", "applying"].includes(event.phase) || !Number.isFinite(event.completed) || !Number.isFinite(event.total)) throw new ProxyToolsError(t("Invalid proxy progress."));
        break;
      case "summary":
        if (![event.selectedProfiles, event.uniqueProxies, event.duplicatesSkipped].every(Number.isFinite)) throw new ProxyToolsError(t("Invalid proxy summary."));
        break;
      case "check":
        if (!event.row || !(CHECK_STATUSES as readonly string[]).includes(event.row.status) || !Array.isArray(event.row.profiles)) throw new ProxyToolsError(t("Invalid proxy check result."));
        break;
      case "replacement":
        if (!event.row || !Number.isInteger(event.row.index) || !["ready", "updated", "unchanged", "missing", "skipped", "failed"].includes(event.row.status)) throw new ProxyToolsError(t("Invalid proxy replacement result."));
        break;
      case "done": done = true; break;
      case "error": throw new ProxyToolsError(t("The proxy operation failed. Completed results remain available."));
      default: throw new ProxyToolsError(t("The proxy operation returned invalid data."));
    }
    onEvent(event);
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        accept(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    if (!done) throw new ProxyToolsError(t("The proxy operation was interrupted. Some rows were not completed."));
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  const { t } = useTranslation();
  return <div className="proxy-pager">
    <span>{t("{total} rows", { total: total.toLocaleString() })}</span>
    <button type="button" className="btn" disabled={page === 0} onClick={() => onPage(page - 1)}>{t("Previous")}</button>
    <span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span>
    <button type="button" className="btn" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>{t("Next")}</button>
  </div>;
}

function AffectedProfiles({ profiles, actions }: { profiles: ProxyCheckView["profiles"]; actions?: ReactNode }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const result = proxyResultPage(profiles, page);
  const folders = [...new Set(profiles.map((profile) => profile.group || t("Ungrouped")))];
  return <details className="proxy-affected">
    <summary>{t("{profiles} profiles · {folders} folders", { profiles: profiles.length.toLocaleString(), folders: folders.length })}</summary>
    <div>{folders.join(", ")}</div>
    <ul>{result.items.map((profile) => <li key={profile.id}>{profile.name || profile.id} · {profile.group || t("Ungrouped")}</li>)}</ul>
    {result.pages > 1 && <Pager {...result} onPage={setPage} />}
    {actions}
  </details>;
}

interface ProxyReviewContext {
  scope: ProxyScope;
  signature: string | null;
  localEndpoint?: string;
  fromCheck?: true;
}
interface CheckReplacementDraft { profiles: ProxyCheckView["profiles"]; ids: string[]; input: string; capacity: string; completed?: true }

export function ProxiesPage({ groups, folders = [], profiles, loadingProfiles = false, onChanged, onTaskSnapshotChange, focusTask, onTaskFocused, localAssignmentIntent, onDismissLocalAssignmentIntent, active }: {
  groups: string[];
  folders?: FolderInfo[];
  profiles?: readonly (ProxyScopeProfile & Partial<Pick<LocalProxyAssignmentProfile, "name">>)[];
  loadingProfiles?: boolean;
  onChanged: () => Promise<void>;
  onTaskSnapshotChange?: (snapshot: ProxyAssignmentSnapshot) => void;
  focusTask?: boolean;
  onTaskFocused?: () => void;
  localAssignmentIntent?: LocalProxyAssignmentIntent;
  onDismissLocalAssignmentIntent?: (id: number, options?: { returnToSettings?: boolean }) => void;
  active: boolean;
}) {
  const { t, language } = useTranslation();
  const workspace = useOptionalWorkspaceOperations();
  const localIntent = localAssignmentIntent?.workspaceId === workspace?.snapshot.workspaceId ? localAssignmentIntent : undefined;
  const currentLocalIntent = useRef(localIntent);
  currentLocalIntent.current = localIntent;
  const assignmentContext = useRef({ workspace, onChanged, onTaskSnapshotChange });
  assignmentContext.current = { workspace, onChanged, onTaskSnapshotChange };
  const workspaceLease = useRef<WorkspaceOperationLease | null>(null);
  const [assignmentOwner] = useState(() => createProxyAssignmentTask({
    apply: (attempt, signal) => proxyRequest("apply", attempt, signal),
    retryPreview: (input, signal) => proxyRequest("retry-preview", input, AbortSignal.any([signal, AbortSignal.timeout(15_000)])),
    readStatus: proxyAssignmentStatus,
    closeUnseen: ({ attemptId, operationScope, previewId }) => proxyRequest(`operations/${encodeURIComponent(attemptId)}/reconcile`, { operationScope, previewId }, AbortSignal.timeout(10_000)),
    workspaceId: () => assignmentContext.current.workspace?.coordinator.getSnapshot().workspaceId ?? null,
    acquire: workspaceId => {
      const coordinator = assignmentContext.current.workspace?.coordinator;
      if (!coordinator) return { release() {} };
      const lease = coordinator.acquire("profile-proxies", workspaceId);
      if (!lease) return null;
      workspaceLease.current = lease;
      return {
        refreshing: () => coordinator.setPhase(lease, "refreshing"),
        release: () => { coordinator.release(lease); if (workspaceLease.current === lease) workspaceLease.current = null; },
      };
    },
    refresh: async () => {
      const { workspace, onChanged } = assignmentContext.current;
      const lease = workspaceLease.current;
      const results = await Promise.allSettled([Promise.resolve().then(onChanged), lease ? workspace?.coordinator.refreshWorkspaceViews(lease) : undefined]);
      if (results.some(result => result.status === "rejected")) throw new Error("Could not refresh proxy assignment results");
    },
  }));
  const assignment = useSyncExternalStore(assignmentOwner.subscribe, assignmentOwner.getSnapshot, assignmentOwner.getSnapshot);
  useEffect(() => { assignmentContext.current.onTaskSnapshotChange?.(assignment); }, [assignment]);
  const [all, setAll] = useState(true);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [task, setTask] = useState<"check" | "replace">("check");
  const [manualMode, setMode] = useState<ProxyReplacementMode>("list");
  const [manualInput, setInput] = useState("");
  const [manualCapacity, setPerProxyDraft] = useState("1");
  const [checkReplacement, setCheckReplacement] = useState<CheckReplacementDraft | null>(null);
  const checkReplacementOwner = useRef<CheckReplacementDraft | null>(null);
  const targetedReplacement = task === "replace" ? checkReplacement : null;
  const targetedIds = targetedReplacement?.ids;
  const mode = targetedReplacement ? "list" : manualMode;
  const input = targetedReplacement?.input ?? manualInput;
  const perProxyDraft = targetedReplacement?.capacity ?? manualCapacity;
  const [checks, setChecks] = useState<ProxyCheckView[]>([]);
  const [checksNeedRefresh, setChecksNeedRefresh] = useState(false);
  const [checkSummary, setCheckSummary] = useState<Extract<ProxyProgressEvent, { type: "summary" }> | null>(null);
  const [progress, setProgress] = useState<Extract<ProxyProgressEvent, { type: "progress" }> | null>(null);
  const [localBusy, setBusy] = useState<"preview" | "local-preview" | "check" | "file" | null>(null);
  const busy = assignment.busy ? "apply" : localBusy;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacementPage, setReplacementPage] = useState(0);
  const [checkPage, setCheckPage] = useState(0);
  const [replacementFailures, setReplacementFailures] = useState(false);
  const [checkFailures, setCheckFailures] = useState(false);
  const [checkSearch, setCheckSearch] = useState("");
  const [checkComplete, setCheckComplete] = useState(false);
  const [summaryCopy, setSummaryCopy] = useState<"idle" | "copying" | "copied" | "manual">("idle");
  const [manualSummary, setManualSummary] = useState("");
  const [replacementSearch, setReplacementSearch] = useState("");
  const [review, setReview] = useState<ProxyReviewContext | null>(null);
  const [focusReview, setFocusReview] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const validationId = useId();
  const workflowId = useId();
  const summaryText = useRef<HTMLTextAreaElement>(null);
  const copyRevision = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const scopeHeading = useRef<HTMLHeadingElement>(null), inputHeading = useRef<HTMLHeadingElement>(null);
  const taskHeading = useRef<HTMLHeadingElement>(null), pageHeading = useRef<HTMLHeadingElement>(null);
  const repairHeading = useRef<HTMLHeadingElement>(null), checkHeading = useRef<HTMLHeadingElement>(null);
  const repairSourceId = useRef<string | null>(null);
  const focusRepair = useRef<"draft" | "checks" | null>(null);
  const lastReconciledRepair = useRef<ProxyAssignmentReceipt | null>(null);
  const receipt = checkReplacement && review?.fromCheck && review.scope.ids === checkReplacement.ids
    && assignment.latest?.batch === assignment.batch && assignment.latest.source !== "seal" ? assignment.latest : null;
  const repairCompleted = !!checkReplacement?.completed || !!receipt;
  useDesktopCloseDraft("proxy-replacement-draft", { dirty: !repairCompleted && !!checkReplacement?.input.trim(), busy: false });
  const scope = useMemo(() => targetedIds ? { all: true, ids: targetedIds } : proxyScope(all, selectedGroups), [all, selectedGroups, targetedIds]);
  const overview = useMemo(() => profiles && !loadingProfiles ? proxyScopeOverview(profiles, scope) : null, [profiles, loadingProfiles, scope]);
  const scopeReady = !loadingProfiles && (targetedIds ? overview?.total === targetedIds.length : (all || selectedGroups.length > 0) && (!overview || overview.total > 0));
  const rosterSignature = useMemo(() => profiles ? proxyRosterSignature(profiles, scope) : null, [profiles, scope]);
  const reviewSignature = useMemo(() => profiles && review ? proxyRosterSignature(profiles, review.scope) : null, [profiles, review?.scope]);
  const localRoster = useMemo(() => localIntent ? profiles?.map(({ id, name, group, running }) => ({ id, name: name ?? id, group, running })) : undefined, [localIntent, profiles]);
  const inputAnalysis = useMemo(() => mode === "list" ? analyzeProxyList(input) : null, [mode, input]);
  const perProxy = Number(perProxyDraft);
  const perProxyValid = /^\d+$/.test(perProxyDraft) && Number.isSafeInteger(perProxy) && perProxy >= 1;
  const inputReady = !!input.trim() && (mode !== "list" || !!inputAnalysis?.total && !inputAnalysis.invalidRows.length && perProxyValid);
  const folderNames = [...new Set(groups)];
  const failedChecks = failedProxyProfileIds(checks);
  const reviewBelongsHere = targetedIds ? review?.fromCheck === true && review.scope.ids === targetedIds : !review?.fromCheck;
  const hasPreview = reviewBelongsHere && (assignment.rows.length > 0 || assignment.phase === "review");
  const reviewReady = useMemo(() => new Set(assignment.reviewReadyNumbers), [assignment.reviewReadyNumbers]);
  const replacements = useMemo(() => {
    const outcomes = new Map(assignment.rows.map(row => [row.number, row]));
    const query = replacementSearch.trim().toLocaleLowerCase();
    const rows = assignmentOwner.getDisplayRows().flatMap(row => {
      const outcome = outcomes.get(row.index + 1);
      if (!outcome || replacementFailures && !["failed", "skipped", "missing", "unknown", "not-started"].includes(outcome.status)) return [];
      if (query && ![row.profileId, row.name, row.group, row.previousProxy, row.proxy].some(value => value?.toLocaleLowerCase().includes(query))) return [];
      return [{ ...row, outcome }];
    });
    return proxyResultPage(rows, replacementPage);
  }, [assignment.rows, assignmentOwner, replacementFailures, replacementSearch, replacementPage]);
  const checkResults = proxyResultPage(matchingProxyChecks(checks.filter((row) => !checkFailures || row.status !== "working"), checkSearch), checkPage);
  const checkOverview = proxyCheckOverview(checks);
  const ready = assignment.reviewReady;
  const previewStale = ready > 0 && review?.signature != null && reviewSignature !== review.signature;
  const blocked = workspace?.snapshot.blocked === true && !assignment.busy;
  const reviewScopeReady = reviewBelongsHere && (review?.localEndpoint || repairCompleted ? !loadingProfiles : scopeReady);
  const canRetry = !busy && !blocked && reviewScopeReady && !ready && assignment.summary.retryable > 0;
  const canPrepareReplacement = !busy && !loadingProfiles && !!profiles && !checkReplacement && !localIntent && assignment.phase !== "review";

  useEffect(() => () => { copyRevision.current++; controller.current?.abort(); controller.current = null; }, []);
  useEffect(() => {
    copyRevision.current++; setSummaryCopy("idle"); setManualSummary("");
  }, [checks, checkComplete, busy, language]);
  useEffect(() => {
    if (summaryCopy === "manual") { summaryText.current?.focus(); summaryText.current?.select(); }
  }, [summaryCopy]);
  useLayoutEffect(() => {
    const draft = checkReplacementOwner.current, previous = lastReconciledRepair.current;
    if (!receipt || !checkReplacement || draft?.ids !== checkReplacement.ids
      || previous?.batch === receipt.batch && previous.attempt === receipt.attempt) return;
    lastReconciledRepair.current = receipt;
    if (!draft.completed) keepCheckReplacement({ ...draft, input: "", completed: true });
    const previousAttempts = new Map(previous?.batch === receipt.batch ? previous.rows.map(row => [row.number, row.attempts]) : []);
    const staleRows = new Set(receipt.rows.filter(row => row.attempts > (previousAttempts.get(row.number) ?? 0)
      && (row.status === "updated" || row.status === "missing" || row.status === "unknown" || row.reason === "changed")).map(row => row.number));
    const staleIds = new Set(assignmentOwner.getDisplayRows().filter(row => staleRows.has(row.index + 1)).map(row => row.profileId));
    if (staleIds.size) {
      setChecks(rows => rows.flatMap(row => {
        const remaining = row.profiles.filter(profile => !staleIds.has(profile.id));
        if (remaining.length === row.profiles.length) return [row];
        return remaining.length ? [{ ...row, profiles: remaining }] : [];
      }));
      setChecksNeedRefresh(true);
      setCheckSummary(null);
      setCheckPage(0);
    }
    if (active && task === "replace") setFocusReview(true);
  }, [receipt, checkReplacement, active, task, assignmentOwner]);
  useLayoutEffect(() => {
    if (!active || !focusTask) return;
    onTaskFocused?.();
    if (assignment.phase === "settled" && assignment.latest && assignment.rows.length && review && !busy && !localIntent) {
      const draft = checkReplacementOwner.current;
      if (review.fromCheck && review.scope.ids && !draft) {
        const receiptProfiles = assignmentOwner.getDisplayRows().flatMap(row => row.profileId
          ? [{ id: row.profileId, name: row.name ?? row.profileId, group: row.group ?? "" }] : []);
        if (receiptProfiles.length === review.scope.ids.length) {
          keepCheckReplacement({ profiles: receiptProfiles, ids: review.scope.ids, input: "", capacity: "1", completed: true });
        }
      }
      const currentDraft = checkReplacementOwner.current;
      if (review.fromCheck ? currentDraft?.ids === review.scope.ids : !currentDraft) {
        setTask("replace");
        setFocusReview(true);
        return;
      }
    }
    const target = taskHeading.current ?? pageHeading.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [active, focusTask, onTaskFocused, assignment, assignmentOwner, review, busy, localIntent]);
  useLayoutEffect(() => {
    if (!active || !focusReview || task !== "replace" || !reviewHeading.current) return;
    reviewHeading.current.focus({ preventScroll: true });
    reviewHeading.current.scrollIntoView?.({ block: "nearest" });
    setFocusReview(false);
  }, [active, focusReview, task]);
  useLayoutEffect(() => {
    if (!active || !focusRepair.current) return;
    const toDraft = focusRepair.current === "draft";
    if (toDraft !== (task === "replace")) return;
    const origin = Array.from(checkHeading.current?.closest("section")?.querySelectorAll<HTMLButtonElement>("[data-proxy-repair-source]") ?? [])
      .find(button => button.dataset.proxyRepairSource === repairSourceId.current);
    const target = toDraft ? repairHeading.current : origin?.isConnected && !origin.disabled ? origin : checkHeading.current;
    focusRepair.current = null;
    if (!toDraft) {
      repairSourceId.current = null;
      const details = origin?.closest("details");
      if (details) details.open = true;
    }
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [active, task, targetedIds]);

  const copyProblems = async () => {
    if (!checkOverview.review || summaryCopy === "copying") return;
    const revision = copyRevision.current;
    const text = proxyProblemSummary(checks, { t, complete: checkComplete && busy !== "check", needsRefresh: checksNeedRefresh, statusLabel: status => getCheckLabel(t, status), reasonLabel: reason => getReasonLabel(t, reason) });
    setSummaryCopy("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (copyRevision.current === revision) { setSummaryCopy("copied"); setManualSummary(""); }
    } catch {
      if (copyRevision.current === revision) { setSummaryCopy("manual"); setManualSummary(text); }
    }
  };

  const clearReview = () => {
    assignmentOwner.clearPreview(); setReview(null); setReplacementPage(0); setError(null); setNotice(null);
  };
  const invalidatePreview = () => {
    if (!review?.localEndpoint) clearReview();
  };
  const invalidateScope = () => {
    if (!checkReplacementOwner.current) invalidatePreview();
    setChecks([]); setChecksNeedRefresh(false); setCheckComplete(false); setCheckSummary(null); setCheckPage(0); setProgress(null); setCheckSearch(""); setReplacementSearch("");
  };
  function keepCheckReplacement(next: CheckReplacementDraft | null) {
    checkReplacementOwner.current = next;
    setCheckReplacement(next);
  }
  function prepareCheckReplacement(row: ProxyCheckView) {
    if (!canPrepareReplacement || checkReplacementOwner.current || controller.current || assignmentOwner.isBusy() || row.status === "working") return;
    const candidates = [...new Map(row.profiles.map(profile => [profile.id, profile])).values()];
    if (!candidates.length) return;
    repairSourceId.current = candidates[0]!.id;
    focusRepair.current = "draft";
    keepCheckReplacement({ profiles: candidates, ids: candidates.map(profile => profile.id), input: "", capacity: "1" });
    setTask("replace"); setError(null); setNotice(null);
  }
  function discardCheckReplacement() {
    if (controller.current || assignmentOwner.isBusy() || !checkReplacementOwner.current) return;
    if (review?.fromCheck && assignment.phase === "review") clearReview();
    keepCheckReplacement(null);
    focusRepair.current = "checks";
    setTask("check"); setError(null); setNotice(null);
  }
  function editReplacementInput(value: string) {
    const current = checkReplacementOwner.current;
    if (targetedReplacement) {
      if (current?.ids === targetedReplacement.ids) keepCheckReplacement({ ...current, input: value });
      return;
    }
    setInput(value);
  }
  function editReplacementCapacity(value: string) {
    const current = checkReplacementOwner.current;
    if (targetedReplacement) {
      if (current?.ids === targetedReplacement.ids) keepCheckReplacement({ ...current, capacity: value });
      return;
    }
    setPerProxyDraft(value);
  }
  const changeTask = (next: typeof task) => {
    if (controller.current || assignmentOwner.isBusy()) return;
    setTask(next); setError(null); setNotice(null); setProgress(null);
  };
  const start = (operation: NonNullable<typeof localBusy>) => {
    if (controller.current || assignmentOwner.isBusy()) return null;
    const current = new AbortController();
    controller.current = current;
    setBusy(operation); setError(null); setNotice(null); setProgress(null);
    return current;
  };
  const finish = (current: AbortController) => {
    if (controller.current !== current) return;
    controller.current = null; setBusy(null);
  };
  const failed = (current: AbortController, operation: string, failure: unknown) => {
    if (controller.current !== current) return;
    // Raw fetch errors can include URLs. Only fixed client messages reach the page.
    if (current.signal.aborted) setNotice(t("Stopped receiving results. Completed results remain available; work already started may still finish."));
    else if (failure instanceof ProxyToolsError) setError(failure.message);
    else setError(t("{operation} failed. Check the input, folder access, and connection, then try again.", { operation }));
  };

  const makePreview = async () => {
    if (!scopeReady || !inputReady || repairCompleted || blocked || task !== "replace" || targetedReplacement !== checkReplacementOwner.current) return;
    const current = start("preview");
    if (!current) return;
    clearReview();
    try {
      const next = await requestProxyPreview({ scope, mode, input, ...(mode === "list" ? { profilesPerProxy: perProxy } : {}) }, t, current.signal);
      if (controller.current !== current || current.signal.aborted) return;
      if (targetedIds) {
        const returned = new Set(next.rows.map(row => row.profileId));
        if (next.rows.length !== targetedIds.length || returned.size !== targetedIds.length || targetedIds.some(id => !returned.has(id))) {
          throw new ProxyToolsError(t("The replacement preview did not match these environments. Check the results and preview again."));
        }
      }
      if (!assignmentOwner.adoptPreview(next)) return;
      setReview({ scope, signature: rosterSignature, ...(targetedIds ? { fromCheck: true as const } : {}) }); setReplacementPage(0); setReplacementFailures(false); setReplacementSearch("");
      if (targetedIds) setFocusReview(true);
      setNotice(t("Review these assignments before applying. Open profiles are skipped."));
    } catch (failure) { failed(current, "Preview", failure); }
    finally { finish(current); }
  };

  const makeLocalPreview = async (input: SingleProxyPreviewInput): Promise<boolean> => {
    if (!localIntent || blocked || loadingProfiles || checkReplacementOwner.current) return false;
    const current = start("local-preview");
    if (!current) return false;
    const intent = localIntent;
    const scoped: ProxyScope = { all: true, ids: [...input.scope.ids] };
    const signature = profiles ? proxyRosterSignature(profiles, scoped) : null;
    const endpoint = localProxyAssignmentEndpoint(input.proxy);
    clearReview();
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]);
      const next = await requestProxyPreview(input, t, signal);
      if (controller.current !== current || signal.aborted || currentLocalIntent.current?.requestId !== intent.requestId
        || workspace?.coordinator.getSnapshot().workspaceId !== intent.workspaceId) return false;
      if (next.unusedProxies !== 0 || next.rows.length !== input.scope.ids.length || next.rows.some((row, index) => row?.index !== index
        || row.profileId !== input.scope.ids[index] || row.proxy !== endpoint)) return false;
      if (!assignmentOwner.adoptPreview(next)) return false;
      setReview({ scope: scoped, signature, localEndpoint: endpoint });
      setReplacementPage(0); setReplacementFailures(false); setReplacementSearch("");
      setTask("replace"); setFocusReview(true);
      onDismissLocalAssignmentIntent?.(intent.requestId);
      return true;
    } catch { return false; }
    finally { finish(current); }
  };

  const prepareRetry = async () => {
    if (controller.current || !canRetry) return;
    setError(null); setNotice(null);
    if (!await assignmentOwner.prepareRetry()) return;
    setReview(previous => previous && { ...previous, signature: reviewSignature }); setReplacementPage(0); setReplacementSearch("");
  };

  const apply = () => {
    if (controller.current || assignmentOwner.isBusy() || !ready || previewStale || !reviewScopeReady || blocked) return;
    setError(null); setNotice(null);
    if (!targetedIds) {
      setChecks([]); setChecksNeedRefresh(false); setCheckComplete(false); setCheckSummary(null); setCheckPage(0);
    }
    void assignmentOwner.apply();
  };

  const runChecks = async (retry = false) => {
    if (!scopeReady) return;
    const current = start("check");
    if (!current) return;
    if (!retry) { setChecks([]); setChecksNeedRefresh(false); setCheckComplete(false); setCheckSearch(""); }
    setCheckSummary(null); setCheckPage(0);
    try {
      await readProxyProgress(await proxyRequest("check", {
        scope: proxyScope(all, selectedGroups, retry ? failedChecks : undefined),
      }, current.signal), (event) => {
        if (controller.current !== current) return;
        if (event.type === "progress") setProgress(event);
        if (event.type === "summary") setCheckSummary(event);
        if (event.type === "check") setChecks((rows) => retry ? mergeProxyCheckResult(rows, event.row) : [...rows, event.row]);
      }, t, current.signal);
      if (controller.current === current) {
        if (!retry) setCheckComplete(true);
        setNotice(t("Proxy checks finished. Not verified means a result could not be established."));
      }
    } catch (failure) { setCheckComplete(false); failed(current, "Proxy check", failure); }
    finally { finish(current); }
  };

  const loadFile = async (file: File) => {
    const current = start("file");
    if (!current) return;
    invalidatePreview();
    try {
      const text = await file.text();
      if (controller.current === current && !current.signal.aborted) editReplacementInput(text);
    } catch { if (controller.current === current) setError(t("The selected file could not be read.")); }
    finally { finish(current); }
  };
  const navigateReplacement = (target: RefObject<HTMLHeadingElement | null>) => {
    if (!active || !target.current) return;
    target.current.focus({ preventScroll: true });
    target.current.scrollIntoView?.({ block: "start" });
  };
  const localReview = !!(hasPreview && review?.localEndpoint);
  const workflowOverview = useMemo(() => localReview && review && profiles && !loadingProfiles ? proxyScopeOverview(profiles, review.scope) : overview,
    [localReview, review, profiles, loadingProfiles, overview]);
  const replacementSteps = [
    { key: "scope", label: localReview || targetedReplacement ? "Selected environments" : "Choose folders", target: localReview ? reviewHeading : targetedReplacement ? repairHeading : scopeHeading, controls: `${workflowId}-${localReview ? "review" : "scope"}`, available: true },
    { key: "input", label: "Add replacement proxies", target: inputHeading, controls: `${workflowId}-input`, available: !repairCompleted },
    { key: "review", label: "Review changes", target: reviewHeading, controls: `${workflowId}-review`, available: !!hasPreview },
    { key: "receipt", label: "Proxy replacement results", target: taskHeading, controls: "proxy-task-title", available: !!(assignment.busy || assignment.notice || assignment.latest || assignment.history.length) },
  ];
  const scopeLabel = localReview ? t("Local proxy assignment · {endpoint}", { endpoint: review!.localEndpoint! }) : targetedReplacement ? t("Environments from the check result") : all ? t("All folders") : selectedGroups.map(name => name || t("Ungrouped")).join(", ") || t("Select at least one folder to continue.");
  const tools = <>
    <div className="tools-tabs" aria-label={t("Proxy tools")}>
      <button type="button" className={task === "check" ? "selected" : ""} aria-pressed={task === "check"} disabled={!!busy} onClick={() => changeTask("check")}>{t("Check proxies")} <small>{t("Find connection problems")}</small></button>
      <button type="button" className={task === "replace" ? "selected" : ""} aria-pressed={task === "replace"} disabled={!!busy} onClick={() => changeTask("replace")}>{t("Replace proxies")} <small>{t("Assign new connections")}</small></button>
    </div>
    {checkReplacement && task === "check" && <div className="tools-notice proxy-repair-return"><span>{t(repairCompleted ? "A replacement receipt for {count} environments is open." : "A replacement draft for {count} environments is open.", { count: checkReplacement.ids.length })}</span><button type="button" className="btn xs" disabled={!!busy} onClick={() => { focusRepair.current = "draft"; changeTask("replace"); }}>{t(repairCompleted ? "Return to replacement receipt" : "Return to replacement draft")}</button></div>}
    {targetedReplacement ? <section className="tools-panel proxy-repair-scope">
      <div className="tools-panel-head"><div><h3 id={`${workflowId}-scope`} className="proxy-workflow-target" ref={repairHeading} tabIndex={-1}>{!repairCompleted && <span className="tools-step" aria-hidden="true">1</span>}{t(repairCompleted ? "Environments from the check result" : "Replace proxies for this check result")}</h3><p>{t(repairCompleted ? "The receipt below shows the result for each environment." : "Only the listed environments are included. Running environments will be skipped.")}</p></div><button type="button" className="btn" disabled={!!busy} onClick={discardCheckReplacement}>{t(repairCompleted ? "Back to proxy checks" : "Discard replacement draft")}</button></div>
      <div className="tools-panel-body"><AffectedProfiles profiles={targetedReplacement.profiles} />
        {!repairCompleted && loadingProfiles && <p className="tools-hint" role="status">{t("Loading saved environments before selecting a scope…")}</p>}
        {!repairCompleted && !loadingProfiles && !scopeReady && <p className="tools-alert" role="alert">{t("Some environments from this check are unavailable. Run the check again to prepare a new draft.")}</p>}
      </div>
    </section> : <section className="tools-panel proxy-scope">
      <div className="tools-panel-head"><div><h3 id={`${workflowId}-scope`} className="proxy-workflow-target" ref={scopeHeading} tabIndex={-1}>{task === "replace" && <span className="tools-step" aria-hidden="true">1</span>}{t("Choose folders")}</h3><p>{t("Includes every profile in these folders, across all pages.")}</p></div><span className="tools-folder-tag">{all ? t("All folders") : t("{count} selected", { count: selectedGroups.length })}</span></div>
      {loadingProfiles && <p className="tools-hint proxy-scope-loading" role="status">{t("Loading saved environments before selecting a scope…")}</p>}
      {overview && <div className="proxy-scope-summary" aria-label={t("Selected environments overview")}>
        <div><strong>{overview.total.toLocaleString()}</strong><span>{t("Selected environments")}</span></div>
        <div><strong>{overview.configured.toLocaleString()}</strong><span>{t("With a saved proxy")}</span></div>
        <div><strong>{overview.missing.toLocaleString()}</strong><span>{t("No saved proxy")}</span></div>
        <div><strong>{overview.running.toLocaleString()}</strong><span>{t("Running")}</span></div>
      </div>}
      <div className="proxy-folder-list">
        <label className={`folder-chip${all ? " selected" : selectedGroups.length ? " partial" : ""}`}><input type="checkbox" checked={all} ref={node => { if (node) node.indeterminate = !all && selectedGroups.length > 0; }} disabled={!!busy} onChange={(event) => { setAll(event.target.checked); setSelectedGroups([]); invalidateScope(); }} />{t("All folders")}</label>
        {folderNames.map((name) => {
          const branch = new Set([name, ...folderScope(folders, name)]);
          const checked = all || [...branch].every(group => selectedGroups.includes(group));
          const partial = !all && !checked && [...branch].some(group => selectedGroups.includes(group));
          return <label className={`folder-chip${checked ? " selected" : partial ? " partial" : ""}`} key={name}>
          <input type="checkbox" checked={checked} ref={node => { if (node) node.indeterminate = partial; }} disabled={!!busy} onChange={(event) => {
            const current = all ? folderNames : selectedGroups;
            const next = event.target.checked ? [...new Set([...current, ...branch])] : current.filter((group) => !branch.has(group));
            const complete = folderNames.every(group => next.includes(group));
            setSelectedGroups(complete ? [] : next);
            setAll(complete); invalidateScope();
          }} />{name || t("Ungrouped")}
        </label>; })}
      </div>
      {overview && overview.invalid > 0 && <p className="tools-hint proxy-scope-note">{t("{count} environments have invalid saved proxy settings. Edit their configuration before checking.", { count: overview.invalid })}</p>}
      {overview && overview.running > 0 && <p className="tools-hint proxy-scope-note">{t(task === "check" ? "Running environments are included in connection checks. Browsers remain open." : "{count} running environments will be skipped during replacement. Close them and preview again to include them.", { count: overview.running })}</p>}
      {!scopeReady && !loadingProfiles && <p className="tools-hint">{t(overview?.total === 0 && (all || selectedGroups.length > 0) ? "No saved environments match this selection." : "Select at least one folder to continue.")}</p>}
    </section>}
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    {localBusy && localBusy !== "local-preview" && <div className="tools-progress" role="status">
      <div className="proxy-actions"><strong>{progress ? `${progress.phase === "loading" ? t("Loading profiles") : progress.phase === "checking" ? t("Checking proxies") : t("Applying changes")}: ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}` : t("Preparing…")}</strong>
        <button type="button" className="btn" onClick={() => controller.current?.abort()}>{t("Cancel")}</button></div>
      <progress aria-label={t("Proxy operation progress")} {...(progress && progress.total > 0 ? { value: progress.completed, max: progress.total } : {})} />
      <p className="proxy-operation-note">{t("You can leave this page and return to the results. Cancel requests a stop; work already started may finish. Completed changes remain saved.")}</p>
    </div>}
    {task === "check" ? <>
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3 ref={checkHeading} tabIndex={-1}>{t("Check your connections")}</h3><p>{t("Shared proxies are checked once. No browsers open and no settings change.")}</p></div>
          <button type="button" className="btn primary" disabled={!!busy || !scopeReady} onClick={() => void runChecks()}>{busy === "check" ? t("Checking…") : t("Check proxies")}</button></div>
        {checksNeedRefresh && <p className="tools-hint proxy-partial-note" role="status">{t("Changed or unconfirmed environments were removed from these results. Run a new check to include them again.")}</p>}
        {checkSummary && <div className="tools-stats">
          <div><strong>{checkSummary.selectedProfiles.toLocaleString()}</strong><span>{t("Profiles included")}</span></div>
          <div><strong>{checkSummary.uniqueProxies.toLocaleString()}</strong><span>{t("Unique proxies")}</span></div>
          <div><strong>{checkSummary.duplicatesSkipped.toLocaleString()}</strong><span>{t("Duplicate checks avoided")}</span></div>
          <div><strong>{checks.filter((row) => row.status === "working").length.toLocaleString()}</strong><span>{t("Reachable")}</span></div>
        </div>}
        {checks.length > 0 ? <>
          <div className="proxy-outcome" aria-live="polite"><strong>{t("{completed} environments have results: {reachable} reachable, {review} needing review.", checkOverview)}</strong><span>{t("Reachability does not verify IP reputation, a separate exit, or browser leaks.")}</span></div>
          <div className="tools-result-bar"><h3>{t("Check results")}</h3><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={checkFailures} onChange={(event) => { setCheckFailures(event.target.checked); setCheckPage(0); }} />{t("Only problems")}</label>
            <button type="button" className="btn" disabled={!!busy || !scopeReady || !failedChecks.length} onClick={() => void runChecks(true)}>{t("Retry failed checks")}</button>
            <button type="button" className="btn" disabled={!checkOverview.review || summaryCopy === "copying"} onClick={() => void copyProblems()}>{t(summaryCopy === "copying" ? "Copying summary…" : "Copy all problem results")}</button>
          </div></div>
          <div className="proxy-summary-help"><span>{t("The summary includes all completed problem results across pages and searches. Review environment names before sharing.")}</span>{summaryCopy === "copied" && <strong role="status">{t("Problem summary copied without proxy authentication fields.")}</strong>}</div>
          {summaryCopy === "manual" && <div className="proxy-summary-fallback"><p role="status">{t("Clipboard access is unavailable. The summary is selected below; copy it with your system shortcut.")}</p><label><span>{t("Problem summary for manual copying")}</span><textarea ref={summaryText} rows={7} readOnly value={manualSummary} onFocus={event => event.currentTarget.select()} /></label><button type="button" className="btn xs" onClick={() => { setSummaryCopy("idle"); setManualSummary(""); }}>{t("Hide summary")}</button></div>}
          {!checkComplete && busy !== "check" && <p className="tools-hint proxy-partial-note" role="status">{t("This check was interrupted. Completed results remain available; run Check proxies again to include environments without results.")}</p>}
          <div className="proxy-results-search"><label><span className="sr-only">{t("Search check results")}</span><input className="input" type="search" placeholder={t("Search proxy, exit IP, environment or folder")} value={checkSearch} onChange={event => { setCheckSearch(event.target.value); setCheckPage(0); }} /></label><span>{t("Search covers all completed results.")}</span></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>{t("Proxy address")}</th><th>{t("Connection")}</th><th>{t("Exit IP")}</th><th>{t("Used by")}</th><th>{t("Checked")}</th></tr></thead>
            <tbody>{checkResults.items.map((row) => <tr key={`${row.key}-${row.profiles[0]?.id}`}>
              <td className="tools-mono">{row.proxy || t("No proxy assigned")}</td><td><span className={`tools-status ${row.status}`}>{getCheckLabel(t, row.status)}</span><small>{proxyExitNote(row) ? t(proxyExitNote(row)!) : row.reason ? getReasonLabel(t, row.reason || "") : ""}</small></td>
              <td className="tools-mono">{row.ip || "—"}{row.country && <small>{row.country}</small>}</td><td><AffectedProfiles profiles={row.profiles} actions={row.status !== "working" && row.profiles.length > 0 && canPrepareReplacement && <button type="button" className="btn xs" data-proxy-repair-source={row.profiles[0]!.id} onClick={() => prepareCheckReplacement(row)}>{t("Prepare replacement for these environments")}</button>} /></td>
              <td>{new Date(row.checkedAt).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
            </tr>)}</tbody></table></div>
          {!checkResults.total && <p className="tools-hint tools-result-empty">{t(checkSearch.trim() ? "No results match your search. Try another address, environment or folder." : "No problems found in the completed checks.")}</p>}
          <Pager {...checkResults} onPage={setCheckPage} />
        </> : <div className="tools-empty"><span className="tools-empty-symbol" aria-hidden="true">↗</span><h3>{busy === "check" ? t("Checking selected folders…") : t("Ready when you are")}</h3><p>{t("Choose a scope above to review connection results, missing settings and next steps.")}</p></div>}
      </section>
      <p className="tools-footnote">{t("Supports HTTP and SOCKS5. HTTPS checks are not supported. Not verified means a result could not be confirmed.")}</p>
    </> : <>
      {!repairCompleted && <section className="tools-panel proxy-input-panel">
        <div className="tools-panel-head"><div><h3 id={`${workflowId}-input`} className="proxy-workflow-target" ref={inputHeading} tabIndex={-1}><span className="tools-step" aria-hidden="true">2</span>{t("Add replacement proxies")}</h3><p>{t("Nothing changes until you review and apply the assignments.")}</p></div></div>
        <div className="tools-panel-body">
          {!targetedReplacement && <label className="fld"><span>{t("Assignment method")}</span><select value={mode} disabled={!!busy} onChange={(event) => { setMode(event.target.value as ProxyReplacementMode); invalidatePreview(); }}>
            <option value="list">{t("Paste a proxy list")}</option><option value="profileId">{t("Match specific profile IDs — CSV")}</option><option value="oldProxy">{t("Replace matching old proxies — CSV")}</option>
          </select></label>}
          <p className="tools-hint">{mode === "profileId" ? <>{t("Include a header row:")} <code>profileId,type,host,port,user,pass</code>.</>
            : mode === "oldProxy" ? <>{t("Include a header row:")} <code>oldProxy,newProxy</code>. {t("Each old proxy is replaced wherever it appears in the selected folders.")}</>
            : t("Paste one proxy per line. We match them to profiles in profile-ID order. Each proxy is used for the number of profiles you set below. You will see every assignment next.")}</p>
          <details className="proxy-format-help"><summary>{t("View a format example")}</summary><pre>{mode === "list" ? "proxy.example.com:8080:username:password\nsocks5://username:password@proxy.example.com:1080" : mode === "profileId" ? "profileId,type,host,port,user,pass\nprofile-id,http,proxy.example.com,8080,username,password" : "oldProxy,newProxy\nhttp://old.example.com:8080,socks5://new.example.com:1080"}</pre><p>{t("Examples show the format only. Replace them with your own connections before previewing.")}</p></details>
          {mode === "list" && <label className="fld proxy-per-proxy"><span>{t("Profiles per proxy")}</span><input type="number" aria-label={t("Profiles per proxy")} aria-invalid={!perProxyValid || undefined} aria-describedby={!perProxyValid ? `${validationId}-capacity` : undefined} min={1} step={1} value={perProxyDraft} disabled={!!busy} onChange={(event) => { editReplacementCapacity(event.target.value); invalidatePreview(); }} />{!perProxyValid && <small className="proxy-input-error" id={`${validationId}-capacity`}>{t("Enter a whole number of at least 1.")}</small>}</label>}
          <label className="fld"><span>{mode === "list" ? t("Your new proxy list") : t("Your replacement CSV")}</span><textarea aria-label={t("Replacement input")} aria-describedby={inputAnalysis?.total ? validationId : undefined} aria-invalid={!!inputAnalysis?.invalidRows.length || undefined} rows={5} value={input} disabled={!!busy} spellCheck={false} autoComplete="off" placeholder={mode === "list" ? "proxy.example.com:8080:username:password\nsocks5://username:password@proxy.example.com:1080" : mode === "profileId" ? "profileId,type,host,port,user,pass" : "oldProxy,newProxy"} onChange={(event) => { editReplacementInput(event.target.value); invalidatePreview(); }} /></label>
          {inputAnalysis && inputAnalysis.total > 0 && <div className={`proxy-input-feedback${inputAnalysis.invalidRows.length ? " has-errors" : ""}`} id={validationId}>
            <strong>{t("{valid} of {total} lines have a readable proxy format.", { valid: inputAnalysis.readable, total: inputAnalysis.total })}</strong>
            {inputAnalysis.invalidRows.length > 0 && <p>{t("Check line numbers {rows}. Each line needs a host, port and a supported protocol.", { rows: inputAnalysis.invalidRows.slice(0, 8).join(", ") + (inputAnalysis.invalidRows.length > 8 ? "…" : "") })}</p>}
            {inputAnalysis.repeated > 0 && <p>{t("{count} repeated connections will keep their original positions in the assignment list.", { count: inputAnalysis.repeated })}</p>}
            {inputAnalysis.https > 0 && <p>{t("HTTPS proxies can be assigned, but this check tool does not test them.")}</p>}
            {overview && perProxyValid && !inputAnalysis.invalidRows.length && <p>{t("This list covers up to {capacity} of {selected} selected environments. Review the exact assignments next.", { capacity: Math.min(inputAnalysis.readable * perProxy, overview.total), selected: overview.total })}{inputAnalysis.readable * perProxy < overview.total && <> {t("Environments without a replacement keep their saved proxy.")}</>}</p>}
            <span>{t("This is a local format check. The preview validates assignments; connection checks run only when requested.")}</span>
          </div>}
          <div className="tools-result-bar"><label className="proxy-upload">{t("Or upload a file")}<input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void loadFile(file); }} /></label>
            <button type="button" className="btn primary" disabled={!!busy || blocked || !scopeReady || !inputReady} onClick={() => void makePreview()}>{busy === "preview" ? t("Preparing preview…") : t(review?.localEndpoint && assignment.phase === "review" ? "Replace local review with manual preview" : "Preview changes")}</button></div>
        </div>
      </section>}
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3 id={`${workflowId}-review`} className="proxy-workflow-target" ref={reviewHeading} tabIndex={-1} data-proxy-review-title>{!repairCompleted && <span className="tools-step" aria-hidden="true">3</span>}{t(repairCompleted && assignment.phase !== "review" ? "Proxy replacement receipt" : "Review changes")}</h3><p>{t(repairCompleted && assignment.phase !== "review" ? "Review the confirmed results or preview failed rows again." : "Check the old and new proxy for each profile. Open profiles are skipped.")}</p></div>
          {reviewBelongsHere && assignment.phase === "review" && <div className="proxy-actions">
            {!repairCompleted && <button type="button" className="btn" disabled={!!busy} onClick={() => { clearReview(); setFocusReview(true); }}>{t(review?.localEndpoint ? "Discard local review" : "Discard review")}</button>}
            <button type="button" className="btn primary" disabled={!!busy || blocked || !ready || previewStale || !reviewScopeReady} onClick={apply}>{t("Apply {count} changes", { count: ready.toLocaleString() })}</button>
          </div>}</div>
        {review?.localEndpoint && <p className="tools-hint proxy-workspace-blocked">{t("Local proxy assignment · {endpoint}", { endpoint: review.localEndpoint })}</p>}
        {blocked && workspace && <p className="tools-hint proxy-workspace-blocked" role="status">{t(workspaceOperationMessage(workspace.snapshot))}</p>}
        {hasPreview ? <>
          {previewStale && <div className="proxy-preview-warning" role="status"><strong>{t("Selected environments changed after this preview.")}</strong><span>{t(repairCompleted ? "Return to proxy checks and prepare a fresh replacement." : review?.localEndpoint ? "Return to Network settings and prepare a new local proxy preview before applying." : "Preview again before applying so the assignment list reflects the latest saved connections and running state.")}</span>{!repairCompleted && !review?.localEndpoint && <button className="btn xs" type="button" disabled={!!busy || blocked || !scopeReady || !inputReady} onClick={() => void makePreview()}>{t("Preview changes")}</button>}</div>}
          <div className="tools-stats">
            <div><strong>{ready.toLocaleString()}</strong><span>{t("Ready to apply")}</span></div>
            <div><strong>{assignment.summary.updated.toLocaleString()}</strong><span>{t("Updated")}</span></div>
            <div><strong>{(assignment.summary.skipped + assignment.summary.failed + assignment.summary.missing + assignment.summary.unknown + assignment.summary.notStarted).toLocaleString()}</strong><span>{t("Need attention")}</span></div>
            <div><strong>{assignment.summary.unchanged.toLocaleString()}</strong><span>{t("Unchanged")}</span></div>
          </div>
          <div className="tools-result-bar"><span className="tools-hint">{t("{assignments} assignments · {unused} unused proxies", { assignments: assignment.summary.total.toLocaleString(), unused: assignmentOwner.getUnusedProxies().toLocaleString() })}</span><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={replacementFailures} onChange={(event) => { setReplacementFailures(event.target.checked); setReplacementPage(0); }} />{t("Only problems")}</label>
            <button type="button" className="btn" disabled={!canRetry} onClick={() => void prepareRetry()}>{t("Preview failed rows again")}</button>
          </div></div>
          <div className="proxy-results-search"><label><span className="sr-only">{t("Search replacement results")}</span><input className="input" type="search" placeholder={t("Search current proxy, new proxy, environment or folder")} value={replacementSearch} onChange={event => { setReplacementSearch(event.target.value); setReplacementPage(0); }} /></label><span>{t("Search covers the complete assignment list.")}</span></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>{t("Profile")}</th><th>{t("Folder")}</th><th>{t("Current proxy")}</th><th>{t("New proxy")}</th><th>{t("Status")}</th></tr></thead>
            <tbody>{replacements.items.map((row) => <tr key={row.index}>
              <td><strong>{row.name || row.profileId || t("Input row {index}", { index: row.index + 1 })}</strong><small className="tools-mono">{row.name ? row.profileId : ""}</small></td>
              <td>{row.group === undefined ? "—" : row.group || t("Ungrouped")}</td><td className="tools-mono">{row.previousProxy || "—"}</td><td className="tools-mono">{row.proxy || "—"}</td>
              <td><span className={`tools-status ${row.outcome.status}`}>{getReplacementLabel(t, row.outcome.status)}</span>
                {row.outcome.reason && <small>{t(ASSIGNMENT_REASONS[row.outcome.reason])}</small>}
                {row.outcome.status !== "ready" && reviewReady.has(row.outcome.number) && <small>{t("Ready to retry")}</small>}
              </td>
            </tr>)}</tbody></table></div>
          {!replacements.total && <p className="tools-hint tools-result-empty">{t(replacementSearch.trim() ? "No results match your search. Try another address, environment or folder." : "No replacement rows need attention.")}</p>}
          <Pager {...replacements} onPage={setReplacementPage} />
        </> : <div className="tools-empty compact"><p>{t("Your preview will appear here. Saved sessions and fingerprints stay unchanged.")}</p></div>}
      </section>
    </>}
  </>;

  return <div className="workspace proxy-page proxy-manager" hidden={!active} aria-labelledby="proxy-page-title" aria-busy={!!localBusy}>
    <header className="tools-intro page-heading"><div><h1 id="proxy-page-title" ref={pageHeading} tabIndex={-1}>{t("Proxies")}</h1><p className="page-subtitle">{t("Check saved connections or replace proxies across entire folders.")}</p></div></header>
    {task === "replace" && <nav className="proxy-workflow-navigation" aria-label={t("Replacement workflow")}>
      <div className="proxy-workflow-scope" aria-label={t("Current replacement scope")}>
        <span className="proxy-workflow-scope-label">{t("Current replacement scope")}</span><strong>{scopeLabel}</strong>
        {loadingProfiles ? <span role="status">{t("Loading profiles")}</span> : workflowOverview && <span className="proxy-workflow-count">{t("{count} environments", { count: workflowOverview.total })}<span aria-hidden="true"> · </span>{t("{count} running", { count: workflowOverview.running })}</span>}
      </div>
      <ol>{replacementSteps.map((step, index) => <li key={step.key}><button type="button" data-proxy-workflow-step={step.key} aria-controls={step.available ? step.controls : undefined} disabled={!step.available} onClick={() => navigateReplacement(step.target)}><span aria-hidden="true">{index + 1}</span>{t(step.label)}</button></li>)}</ol>
    </nav>}
    <AssignmentTask snapshot={assignment} headingRef={taskHeading} onStop={() => assignmentOwner.stopReceiving()} onReconcile={() => assignmentOwner.reconcileNow()} onRefresh={() => void assignmentOwner.refreshResult()} />
    {localIntent && checkReplacement && <p className="tools-notice" role="status">{t(repairCompleted ? "Return to proxy checks from the replacement receipt before preparing a local proxy review." : "Finish or discard the replacement draft from check results before preparing a local proxy review.")}</p>}
    {localIntent && <LocalProxyAssignmentDraft key={localIntent.requestId} candidate={localIntent.candidate} active={active} profiles={localRoster}
      loading={loadingProfiles} disabled={!!busy || blocked || !!checkReplacement} hasPreviousReview={assignment.phase === "review"}
      onPreview={makeLocalPreview} onDismiss={() => onDismissLocalAssignmentIntent?.(localIntent.requestId, { returnToSettings: true })} />}
    {tools}
  </div>;
}
