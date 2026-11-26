import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProfileEventActor,
  ProfileEventType,
  ProfileRecoveryKind,
  ProfileTimelineEvent,
} from "../profile-timeline.ts";
import { getStandaloneSessionToken, notifyAppLockedFromResponse, notifyUnauthorizedResponse, type ProxyCheckResult } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon, ConfirmDialog } from "./ui-primitives.tsx";
import "./profile-timeline.css";

export type { ProfileTimelineEvent };

export interface ProfileTimelinePage {
  profileId: string;
  events: ProfileTimelineEvent[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export interface ProfileProxyCheckResponse extends ProxyCheckResult {
  checkedAt: number;
}

function timelineFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getStandaloneSessionToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("X-Maobu-Session") && !headers.has("Authorization")) {
    headers.set("X-Maobu-Session", token);
  }
  return fetch(path, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    cache: "no-store",
    headers,
  });
}

async function readJson(response: Response, path: string): Promise<any> {
  const text = await response.text();
  let parsed: any;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    notifyUnauthorizedResponse(response.status, path);
    throw new Error(`API ${path} returned non-JSON (${response.status}).`);
  }
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, typeof parsed?.error === "string" ? parsed.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, parsed);
  }
  return parsed;
}

export async function fetchProfileTimeline(
  profileId: string,
  options: { limit?: number; beforeId?: number; type?: ProfileEventType | ""; signal?: AbortSignal } = {},
): Promise<ProfileTimelinePage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.beforeId !== undefined) params.set("beforeId", String(options.beforeId));
  if (options.type) params.set("type", options.type);
  const query = params.toString();
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/timeline${query ? `?${query}` : ""}`;
  const response = await timelineFetch(path, { method: "GET", signal: options.signal });
  const body = await readJson(response, path);
  if (!response.ok || body?.ok !== true || (body.profileId !== undefined && body.profileId !== profileId)
    || typeof body.hasMore !== "boolean" || !Array.isArray(body.events)
    || !body.events.every((event: unknown) => isTimelineEvent(event, profileId))
    || (body.hasMore && (body.events.length === 0 || !Number.isSafeInteger(body.nextBeforeId) || body.nextBeforeId <= 0
      || (options.beforeId !== undefined && body.nextBeforeId >= options.beforeId)))) {
    throw new Error("Unable to load activity timeline.");
  }
  return {
    profileId,
    events: body.events as ProfileTimelineEvent[],
    hasMore: body.hasMore === true,
    nextBeforeId: typeof body.nextBeforeId === "number" ? body.nextBeforeId : null,
  };
}

function isTimelineEvent(value: unknown, profileId: string): value is ProfileTimelineEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ProfileTimelineEvent>;
  return event.profileId === profileId && typeof event.id === "number" && Number.isSafeInteger(event.id) && event.id > 0
    && typeof event.createdAt === "number" && Number.isFinite(new Date(event.createdAt).getTime())
    && typeof event.summary === "string" && !!event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
    && typeof event.eventType === "string" && typeof event.actor === "string" && typeof event.status === "string"
    && typeof event.recoveryKind === "string";
}

export async function clearProfileTimeline(profileId: string): Promise<{ removed: number }> {
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/timeline`;
  const response = await timelineFetch(path, { method: "DELETE" });
  const body = await readJson(response, path);
  if (!response.ok || body?.ok !== true) {
    throw new Error(typeof body?.error === "string" ? body.error : "Unable to clear activity timeline.");
  }
  return { removed: Number(body.removed) || 0 };
}

/**
 * Check a profile's saved proxy directly on the server without fetching plaintext proxy credentials.
 */
export async function checkProfileSavedProxy(profileId: string): Promise<ProfileProxyCheckResponse> {
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/check-proxy`;
  const response = await timelineFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await readJson(response, path);
  if (!response.ok || body?.ok !== true) {
    throw new Error(typeof body?.error === "string" ? body.error : "Proxy check failed.");
  }
  return {
    status: body.status,
    attempts: Number(body.attempts) || 1,
    successes: Number(body.successes) || 0,
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(typeof body.ip === "string" ? { ip: body.ip } : {}),
    ...(typeof body.country === "string" ? { country: body.country } : {}),
    ...(typeof body.region === "string" ? { region: body.region } : {}),
    ...(typeof body.city === "string" ? { city: body.city } : {}),
    ...(typeof body.rotating === "boolean" ? { rotating: body.rotating } : {}),
    ...(typeof body.exitComparison === "string" ? { exitComparison: body.exitComparison } : {}),
    checkedAt: typeof body.checkedAt === "number" ? body.checkedAt : Date.now(),
  };
}

const EVENT_TYPE_LABELS: Record<ProfileEventType, string> = {
  "profile.created": "Created",
  "profile.trashed": "Moved to Trash",
  "profile.restored": "Restored",
  "launch.started": "Browser started",
  "launch.stopped": "Browser stopped",
  "launch.restarted": "Browser restarted",
  "launch.failed": "Launch failed",
  "launch.stop_failed": "Stop failed",
  "proxy.updated": "Proxy updated",
  "proxy.checked": "Proxy checked",
  "proxy.vault_bound": "Proxy vault bound",
  "config.updated": "Config updated",
  "group.changed": "Group changed",
  "tags.updated": "Tags updated",
  "notes.updated": "Notes updated",
  "cookies.updated": "Cookies updated",
  "session.captured": "Session saved",
  "cache.cleared": "Cache cleared",
  "package.exported": "Package exported",
  "package.imported": "Package imported",
  "rpa.run": "Script run",
  "ai.proposal_applied": "AI action applied",
};

const ACTOR_LABELS: Record<ProfileEventActor, string> = {
  user: "User",
  ai_proposal: "AI",
  rpa: "RPA",
  mcp: "MCP",
  system: "System",
};

const PROXY_STATUS_LABELS: Record<ProxyCheckResult["status"], string> = {
  working: "Proxy reachable",
  unstable: "Mixed reachability",
  failed: "Connection failed",
  unavailable: "Check unavailable",
};

const FILTER_OPTIONS: Array<{ value: "" | ProfileEventType; label: string }> = [
  { value: "", label: "All activity" },
  { value: "launch.started", label: "Browser started" },
  { value: "launch.failed", label: "Launch failed" },
  { value: "proxy.checked", label: "Proxy checked" },
  { value: "proxy.updated", label: "Proxy updated" },
  { value: "config.updated", label: "Config updated" },
  { value: "notes.updated", label: "Notes updated" },
  { value: "package.imported", label: "Package imported" },
  { value: "rpa.run", label: "Script run" },
  { value: "ai.proposal_applied", label: "AI action applied" },
];

export interface ProfileTimelineProps {
  profileId: string;
  hasProxy?: boolean;
  running?: boolean;
  compact?: boolean;
  onCheckProxyComplete?: (result: ProfileProxyCheckResponse) => void;
  onOpenLogs?: () => void;
  onRetryLaunch?: (profileId: string) => void | Promise<void>;
  onEditProxy?: (profileId: string) => void;
}

function safeDetailPills(detail: Record<string, unknown>): string[] {
  const pills: string[] = [];
  if (Array.isArray(detail.fields) && detail.fields.length > 0) {
    pills.push(detail.fields.map(String).join(", "));
  }
  if (typeof detail.ip === "string" && detail.ip) {
    pills.push(detail.ip);
  }
  if (typeof detail.country === "string" && detail.country) {
    pills.push(detail.country);
  }
  if (typeof detail.reason === "string" && detail.reason) {
    pills.push(detail.reason);
  }
  if (typeof detail.group === "string" && detail.group) {
    pills.push(detail.group);
  }
  return pills;
}

/**
 * Per-environment activity timeline with cursor pagination, type filter, clear action,
 * credential-free server-side proxy check, and contextual failure recovery actions.
 */
export function ProfileTimeline({
  profileId,
  hasProxy = false,
  running = false,
  compact = false,
  onCheckProxyComplete,
  onOpenLogs,
  onRetryLaunch,
  onEditProxy,
}: ProfileTimelineProps) {
  const { t, language } = useTranslation();
  const [events, setEvents] = useState<ProfileTimelineEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<"" | ProfileEventType>("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [checkingProxy, setCheckingProxy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedRead, setFailedRead] = useState<{ beforeId?: number } | null>(null);
  const [proxyResult, setProxyResult] = useState<ProfileProxyCheckResponse | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);

  const activeProfileRef = useRef<string | null>(profileId);
  const activeRead = useRef<AbortController | null>(null);
  const scope = useRef({ profileId, typeFilter, compact });
  scope.current = { profileId, typeFilter, compact };
  const refreshButton = useRef<HTMLButtonElement>(null);
  const retryReadButton = useRef<HTMLButtonElement>(null);
  const loadMoreButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);

  const cancelRead = useCallback(() => {
    activeRead.current?.abort();
    activeRead.current = null;
  }, []);

  const loadPage = useCallback(
    async (beforeId?: number) => {
      const target = scope.current;
      if (activeProfileRef.current !== target.profileId) return;
      cancelRead();
      const request = new AbortController();
      activeRead.current = request;
      const ownsRead = () => activeRead.current === request && scope.current.profileId === target.profileId
        && scope.current.typeFilter === target.typeFilter && scope.current.compact === target.compact;
      setLoading(beforeId === undefined);
      setLoadingMore(beforeId !== undefined);
      try {
        const page = await fetchProfileTimeline(target.profileId, {
          limit: target.compact ? 25 : 50,
          beforeId,
          type: target.typeFilter,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        });
        if (!ownsRead()) return;
        const document = refreshButton.current?.ownerDocument;
        const restoreFocus = beforeId === undefined
          ? document?.activeElement === retryReadButton.current
          : !page.hasMore && document?.activeElement === loadMoreButton.current;
        setEvents((previous) => {
          if (beforeId === undefined) return page.events;
          const known = new Set(previous.map(event => event.id));
          return [...previous, ...page.events.filter(event => !known.has(event.id))];
        });
        setHasMore(page.hasMore);
        setNextBeforeId(page.nextBeforeId);
        setFailedRead(null);
        if (restoreFocus) document?.defaultView?.requestAnimationFrame(() => {
          if (activeProfileRef.current === target.profileId && document.activeElement === document.body) {
            const firstAdded = beforeId === undefined ? null : page.events[0];
            (firstAdded ? list.current?.querySelector<HTMLElement>(`[data-event-id="${firstAdded.id}"]`) : refreshButton.current)?.focus();
          }
        });
      } catch {
        if (ownsRead()) setFailedRead({ beforeId });
      } finally {
        if (ownsRead()) {
          activeRead.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cancelRead],
  );

  useEffect(() => {
    activeProfileRef.current = profileId;
    setProxyResult(null);
    setProxyError(null);
    setConfirmClear(false);
    setCheckingProxy(false);
    setRetrying(false);
    setClearing(false);
    setError(null);
    return () => { activeProfileRef.current = null; };
  }, [profileId]);

  useEffect(() => {
    setEvents([]);
    setHasMore(false);
    setNextBeforeId(null);
    setFailedRead(null);
    void loadPage();
    return cancelRead;
  }, [profileId, typeFilter, compact, loadPage, cancelRead]);

  async function handleCheckProxy() {
    if (!hasProxy || checkingProxy || clearing) return;
    const targetId = profileId;
    setCheckingProxy(true);
    setProxyError(null);
    try {
      const result = await checkProfileSavedProxy(targetId);
      if (activeProfileRef.current !== targetId) return;
      setProxyResult(result);
      onCheckProxyComplete?.(result);
      await loadPage();
    } catch (err) {
      if (activeProfileRef.current !== targetId) return;
      setProxyError(err instanceof Error ? err.message : t("Proxy check failed."));
      await loadPage();
    } finally {
      if (activeProfileRef.current === targetId) {
        setCheckingProxy(false);
      }
    }
  }

  async function handleClear() {
    if (clearing || checkingProxy || retrying) return;
    const targetId = profileId;
    cancelRead();
    setLoading(false);
    setLoadingMore(false);
    setClearing(true);
    setError(null);
    try {
      await clearProfileTimeline(targetId);
      if (activeProfileRef.current !== targetId) return;
      setEvents([]);
      setHasMore(false);
      setNextBeforeId(null);
      setFailedRead(null);
      setConfirmClear(false);
      const refresh = refreshButton.current;
      const document = refresh?.ownerDocument;
      document?.defaultView?.requestAnimationFrame(() => {
        if (activeProfileRef.current === targetId && document.activeElement === document.body) refresh?.focus();
      });
    } catch {
      if (activeProfileRef.current !== targetId) return;
      setError(t("Unable to clear activity timeline."));
      setConfirmClear(false);
    } finally {
      if (activeProfileRef.current === targetId) {
        setClearing(false);
      }
    }
  }

  async function handleRetryLaunch() {
    if (!onRetryLaunch || retrying || running || clearing) return;
    const targetId = profileId;
    setRetrying(true);
    try {
      await onRetryLaunch(targetId);
      if (activeProfileRef.current === targetId) await loadPage();
    } catch {
      if (activeProfileRef.current === targetId) setError(t("Could not retry the environment."));
    } finally {
      if (activeProfileRef.current === targetId) setRetrying(false);
    }
  }

  function formatTime(date: Date): string {
    return date.toLocaleString(language, {
      ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  function renderRecoveryActions(event: ProfileTimelineEvent) {
    const kind: ProfileRecoveryKind = event.recoveryKind;
    if (!kind && event.status !== "failed") return null;

    const showProxyCheck = (kind === "proxy" || kind === "network") && hasProxy;
    const showEditProxy = kind === "proxy" && !!onEditProxy;
    const showLogs = (kind === "logs" || kind === "network" || kind === "runtime" || kind === "retry_start" || event.status === "failed") && !!onOpenLogs;
    const showRetry = (kind === "retry_start" || kind === "runtime" || event.eventType === "launch.failed") && !!onRetryLaunch && !running;

    if (!showProxyCheck && !showEditProxy && !showLogs && !showRetry) return null;

    return (
      <div className="timeline-recovery-actions">
        {showProxyCheck && (
          <button
            type="button"
            className="btn xs"
            aria-disabled={checkingProxy || clearing}
            onClick={() => void handleCheckProxy()}
          >
            {checkingProxy ? t("Checking proxy…") : t("Check proxy")}
          </button>
        )}
        {showEditProxy && (
          <button
            type="button"
            className="btn xs ghost"
            onClick={() => onEditProxy!(profileId)}
          >
            {t("Edit proxy")}
          </button>
        )}
        {showRetry && (
          <button
            type="button"
            className="btn xs"
            aria-disabled={retrying || clearing}
            onClick={() => void handleRetryLaunch()}
          >
            {retrying ? t("Starting…") : t("Retry launch")}
          </button>
        )}
        {showLogs && (
          <button
            type="button"
            className="btn xs ghost"
            onClick={() => onOpenLogs!()}
          >
            {t("View logs")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`profile-timeline${compact ? " is-compact" : ""}`} data-profile-timeline={profileId}>
      <div className="timeline-toolbar">
        <select
          className="timeline-filter-select"
          aria-label={t("Filter activity by type")}
          value={typeFilter}
          disabled={clearing}
          onChange={(event) => setTypeFilter(event.target.value as "" | ProfileEventType)}
        >
          {FILTER_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>

        <div className="timeline-toolbar-actions">
          {hasProxy && <button
            type="button"
            className="btn xs"
            aria-disabled={checkingProxy || clearing}
            aria-busy={checkingProxy}
            title={t("Check saved proxy on server")}
            onClick={() => void handleCheckProxy()}
          >
            <AppIcon name="activity" className="xs" />
            {checkingProxy ? t("Checking proxy…") : t("Check proxy")}
          </button>}

          <button
            type="button"
            ref={refreshButton}
            className="btn xs ghost"
            aria-disabled={loading || loadingMore || clearing}
            aria-label={t("Refresh timeline")}
            title={t("Refresh timeline")}
            onClick={() => { if (!activeRead.current && !clearing) void loadPage(); }}
          >
            <AppIcon name="refresh" className="xs" />
          </button>

          {events.length > 0 && <button type="button" className="btn xs ghost" disabled={clearing || checkingProxy || retrying}
            aria-label={t("Clear timeline")} title={t("Clear timeline")} onClick={() => setConfirmClear(true)}>
            <AppIcon name="trash" className="xs" />
          </button>}
        </div>
      </div>

      {proxyResult && (
        <div className={`timeline-proxy-banner is-${proxyResult.status}`} role="status">
          <strong>{t(PROXY_STATUS_LABELS[proxyResult.status])}</strong>
          <span>
            {[
              proxyResult.ip,
              [proxyResult.country, proxyResult.region, proxyResult.city].filter(Boolean).join(" · "),
              proxyResult.reason ? t(proxyResult.reason) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      )}

      {proxyError && (
        <p className="timeline-error" role="alert">
          {proxyError}
        </p>
      )}

      {error && (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}

      {failedRead && failedRead.beforeId === undefined && <div className="timeline-error timeline-error-action">
        <span role="alert">{t("Unable to load activity timeline.")}</span>
        <button type="button" className="btn xs" ref={retryReadButton} aria-disabled={loading || loadingMore || clearing}
          onClick={() => { if (!activeRead.current && !clearing) void loadPage(failedRead.beforeId); }}>{t("Retry")}</button>
      </div>}

      {loading && events.length === 0 && !failedRead ? (
        <p className="timeline-state" role="status">{t("Loading activity timeline…")}</p>
      ) : events.length === 0 ? (
        !failedRead && <p className="timeline-state">{t(typeFilter ? "No matching activity." : "No activity recorded for this environment yet.")}</p>
      ) : (
        <ol className="timeline-list" ref={list}>
          {events.map((event) => {
            const pills = safeDetailPills(event.detail);
            const occurred = new Date(event.createdAt);
            return (
              <li
                key={event.id}
                className={`timeline-item is-${event.status}`}
                tabIndex={-1}
                data-event-id={event.id}
                data-event-type={event.eventType}
              >
                <span className="timeline-dot" aria-hidden="true" />
                <div className="timeline-item-body">
                  <div className="timeline-item-head">
                    <span className="timeline-type-badge">
                      {t(EVENT_TYPE_LABELS[event.eventType] ?? event.eventType)}
                    </span>
                    <span className="timeline-actor-badge">
                      {t(ACTOR_LABELS[event.actor] ?? event.actor)}
                    </span>
                    <time
                      className="timeline-time"
                      dateTime={occurred.toISOString()}
                      title={occurred.toLocaleString(language)}
                    >
                      {formatTime(occurred)}
                    </time>
                  </div>
                  <p className="timeline-summary">{event.summary}</p>
                  {pills.length > 0 && (
                    <div className="timeline-pills">
                      {pills.map((pill, idx) => (
                        <span key={`${pill}-${idx}`}>{pill}</span>
                      ))}
                    </div>
                  )}
                  {renderRecoveryActions(event)}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {failedRead?.beforeId !== undefined && <p className="timeline-error" role="alert">{t("Unable to load older activity.")}</p>}
      {hasMore && nextBeforeId !== null && (
        <button
          type="button"
          ref={loadMoreButton}
          className="btn xs ghost timeline-load-more"
          aria-disabled={loading || loadingMore || clearing}
          onClick={() => { if (!activeRead.current && !clearing) void loadPage(nextBeforeId); }}
        >
          {loadingMore ? t("Loading…") : t(failedRead?.beforeId !== undefined ? "Retry loading older activity" : "Load older activity")}
        </button>
      )}
      <ConfirmDialog
        open={confirmClear}
        title={t("Clear activity timeline?")}
        message={t("This removes all activity for this environment, including entries outside the current filter.")}
        confirmLabel={t(clearing ? "Clearing…" : "Confirm clear")}
        tone="danger"
        busy={clearing}
        portal
        onConfirm={() => void handleClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
