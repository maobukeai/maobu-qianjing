import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProfileEventActor,
  ProfileEventType,
  ProfileRecoveryKind,
  ProfileTimelineEvent,
} from "../profile-timeline.ts";
import { getStandaloneSessionToken, type ProxyCheckResult } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
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
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`API ${path} returned non-JSON (${response.status}).`);
  }
}

export async function fetchProfileTimeline(
  profileId: string,
  options: { limit?: number; beforeId?: number; type?: ProfileEventType | "" } = {},
): Promise<ProfileTimelinePage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.beforeId !== undefined) params.set("beforeId", String(options.beforeId));
  if (options.type) params.set("type", options.type);
  const query = params.toString();
  const path = `/ui/api/profiles/${encodeURIComponent(profileId)}/timeline${query ? `?${query}` : ""}`;
  const response = await timelineFetch(path, { method: "GET" });
  const body = await readJson(response, path);
  if (!response.ok || body?.ok !== true || !Array.isArray(body.events)) {
    throw new Error(typeof body?.error === "string" ? body.error : "Unable to load activity timeline.");
  }
  return {
    profileId: String(body.profileId ?? profileId),
    events: body.events as ProfileTimelineEvent[],
    hasMore: body.hasMore === true,
    nextBeforeId: typeof body.nextBeforeId === "number" ? body.nextBeforeId : null,
  };
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
  const [proxyResult, setProxyResult] = useState<ProfileProxyCheckResponse | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);

  const generationRef = useRef(0);
  const activeProfileRef = useRef(profileId);
  activeProfileRef.current = profileId;

  const loadPage = useCallback(
    async (options: { append?: boolean; beforeId?: number; filter?: "" | ProfileEventType } = {}) => {
      const targetId = profileId;
      const filter = options.filter ?? typeFilter;
      const generation = ++generationRef.current;
      if (options.append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await fetchProfileTimeline(targetId, {
          limit: compact ? 25 : 50,
          beforeId: options.beforeId,
          type: filter,
        });
        if (generationRef.current !== generation || activeProfileRef.current !== targetId) return;
        setEvents((prev) => (options.append ? [...prev, ...page.events] : page.events));
        setHasMore(page.hasMore);
        setNextBeforeId(page.nextBeforeId);
      } catch (err) {
        if (generationRef.current !== generation || activeProfileRef.current !== targetId) return;
        setError(err instanceof Error ? err.message : t("Unable to load activity timeline."));
      } finally {
        if (generationRef.current === generation && activeProfileRef.current === targetId) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [profileId, typeFilter, compact, t],
  );

  useEffect(() => {
    setEvents([]);
    setHasMore(false);
    setNextBeforeId(null);
    setProxyResult(null);
    setProxyError(null);
    setConfirmClear(false);
    setError(null);
    void loadPage({ append: false, filter: typeFilter });
    return () => {
      generationRef.current++;
    };
  }, [profileId, typeFilter, loadPage]);

  async function handleCheckProxy() {
    if (!hasProxy || checkingProxy) return;
    const targetId = profileId;
    setCheckingProxy(true);
    setProxyError(null);
    try {
      const result = await checkProfileSavedProxy(targetId);
      if (activeProfileRef.current !== targetId) return;
      setProxyResult(result);
      onCheckProxyComplete?.(result);
      await loadPage({ append: false });
    } catch (err) {
      if (activeProfileRef.current !== targetId) return;
      setProxyError(err instanceof Error ? err.message : t("Proxy check failed."));
      await loadPage({ append: false });
    } finally {
      if (activeProfileRef.current === targetId) {
        setCheckingProxy(false);
      }
    }
  }

  async function handleClear() {
    if (clearing) return;
    const targetId = profileId;
    setClearing(true);
    setError(null);
    try {
      await clearProfileTimeline(targetId);
      if (activeProfileRef.current !== targetId) return;
      setEvents([]);
      setHasMore(false);
      setNextBeforeId(null);
      setConfirmClear(false);
    } catch (err) {
      if (activeProfileRef.current !== targetId) return;
      setError(err instanceof Error ? err.message : t("Unable to clear activity timeline."));
    } finally {
      if (activeProfileRef.current === targetId) {
        setClearing(false);
      }
    }
  }

  async function handleRetryLaunch() {
    if (!onRetryLaunch || retrying || running) return;
    setRetrying(true);
    try {
      await onRetryLaunch(profileId);
      await loadPage({ append: false });
    } finally {
      setRetrying(false);
    }
  }

  function formatTime(ts: number): string {
    const date = new Date(ts);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : "";
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
            disabled={checkingProxy}
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
            disabled={retrying}
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
          onChange={(event) => setTypeFilter(event.target.value as "" | ProfileEventType)}
        >
          {FILTER_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>

        <div className="timeline-toolbar-actions">
          <button
            type="button"
            className="btn xs"
            disabled={!hasProxy || checkingProxy}
            aria-busy={checkingProxy}
            title={hasProxy ? t("Check saved proxy on server") : t("No profile proxy")}
            onClick={() => void handleCheckProxy()}
          >
            <AppIcon name="activity" className="xs" />
            {checkingProxy ? t("Checking proxy…") : t("Check proxy")}
          </button>

          <button
            type="button"
            className="btn xs ghost"
            disabled={loading}
            aria-label={t("Refresh timeline")}
            onClick={() => void loadPage({ append: false })}
          >
            <AppIcon name="refresh" className="xs" />
          </button>

          {events.length > 0 &&
            (confirmClear ? (
              <span className="timeline-clear-confirm">
                <button
                  type="button"
                  className="btn xs danger"
                  disabled={clearing}
                  onClick={() => void handleClear()}
                >
                  {clearing ? t("Clearing…") : t("Confirm clear")}
                </button>
                <button
                  type="button"
                  className="btn xs ghost"
                  disabled={clearing}
                  onClick={() => setConfirmClear(false)}
                >
                  {t("Cancel")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn xs ghost"
                disabled={clearing}
                aria-label={t("Clear timeline")}
                onClick={() => setConfirmClear(true)}
              >
                <AppIcon name="trash" className="xs" />
              </button>
            ))}
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

      {loading ? (
        <p className="timeline-state">{t("Loading activity timeline…")}</p>
      ) : events.length === 0 ? (
        <p className="timeline-state">{t("No activity recorded for this environment yet.")}</p>
      ) : (
        <ol className="timeline-list">
          {events.map((event) => {
            const pills = safeDetailPills(event.detail);
            return (
              <li
                key={event.id}
                className={`timeline-item is-${event.status}`}
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
                      dateTime={new Date(event.createdAt).toISOString()}
                    >
                      {formatTime(event.createdAt)}
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

      {hasMore && nextBeforeId !== null && (
        <button
          type="button"
          className="btn xs ghost timeline-load-more"
          disabled={loadingMore}
          onClick={() => void loadPage({ append: true, beforeId: nextBeforeId })}
        >
          {loadingMore ? t("Loading…") : t("Load older activity")}
        </button>
      )}
    </div>
  );
}
