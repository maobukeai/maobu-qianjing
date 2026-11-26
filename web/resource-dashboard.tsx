import { useId, useMemo, useRef, useState } from "react";
import { openProfile, type UiProfile } from "./api.ts";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import {
  formatCpuPercent,
  formatMemoryBytes,
  hibernateProfile,
  hibernateProfilesBatch,
  trimAllProfilesMemory,
  trimProfileMemory,
  type MetricsSnapshot,
  type ProfileResourceMetric,
  type ResourceMonitorState,
  type WatermarkLevel,
} from "./resource-monitor-api.ts";
import { AppIcon as Icon, useDialogKeyboard } from "./ui-primitives.tsx";
import "./resource-dashboard.css";

const WATERMARK_LABELS: Record<WatermarkLevel, string> = {
  normal: "Normal",
  elevated: "Elevated",
  high: "High load",
  critical: "Critical",
};

export interface ResourceTopCapsuleProps {
  runningCount: number;
  snapshot: MetricsSnapshot | null;
  open: boolean;
  onToggle: () => void;
}

/** Compact topbar capsule displaying live running count and browser memory usage. */
export function ResourceTopCapsule({
  runningCount,
  snapshot,
  open,
  onToggle,
}: ResourceTopCapsuleProps) {
  const { t } = useTranslation();
  const level = snapshot?.watermark.level ?? "normal";
  const totalRss = snapshot?.totals.totalRssBytes ?? 0;
  const hostPct = snapshot?.host.memoryLoadPercent;
  const label =
    snapshot && runningCount > 0
      ? t("Resource monitor: {running} running, {memory} browser RAM", {
          running: runningCount,
          memory: formatMemoryBytes(totalRss),
        })
      : t("Resource monitor");

  return (
    <button
      type="button"
      className={`resource-top-capsule wm-${level}`}
      data-no-drag
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className={`resource-capsule-dot${runningCount > 0 ? " is-active" : ""}`} aria-hidden="true" />
      <span>{t("{count} live", { count: runningCount })}</span>
      {snapshot && (
        <>
          <span className="resource-capsule-sep" aria-hidden="true">·</span>
          <span className="resource-capsule-mem">
            {totalRss > 0 ? formatMemoryBytes(totalRss) : `${Math.round(hostPct ?? 0)}% RAM`}
          </span>
        </>
      )}
      <span className={`resource-capsule-sparks${runningCount > 0 ? " is-active" : ""}`} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
    </button>
  );
}

/** Lightweight inline memory/CPU chip for ProfileRosterRow's reserved `resourceChips` slot. */
export function ProfileResourceChip({
  metrics,
  hibernated = false,
}: {
  metrics?: ProfileResourceMetric;
  hibernated?: boolean;
}) {
  const { t } = useTranslation();
  if (hibernated && !metrics) {
    return (
      <span className="profile-resource-chip is-hibernated" title={t("Session saved and browser hibernated")}>
        {t("Hibernated")}
      </span>
    );
  }
  if (!metrics) return null;
  const heavy = metrics.rssBytes >= 1024 * 1024 * 1024;
  return (
    <span
      className={`profile-resource-chip${heavy ? " is-heavy" : ""}`}
      title={t("{rss} RAM · {cpu} CPU · {procs} processes", {
        rss: formatMemoryBytes(metrics.rssBytes),
        cpu: formatCpuPercent(metrics.cpuPercent),
        procs: metrics.processCount,
      })}
    >
      {formatMemoryBytes(metrics.rssBytes)}
      {metrics.cpuPercent >= 0.5 ? ` · ${formatCpuPercent(metrics.cpuPercent)}` : ""}
    </span>
  );
}

export interface ResourceDashboardActions {
  trimProfile: (id: string) => ReturnType<typeof trimProfileMemory>;
  trimAll: () => ReturnType<typeof trimAllProfilesMemory>;
  hibernate: (id: string) => ReturnType<typeof hibernateProfile>;
  hibernateAll: () => ReturnType<typeof hibernateProfilesBatch>;
  wake: (id: string) => Promise<unknown>;
}

const DEFAULT_ACTIONS: ResourceDashboardActions = {
  trimProfile: (id) => trimProfileMemory(id),
  trimAll: () => trimAllProfilesMemory(),
  hibernate: (id) => hibernateProfile(id),
  hibernateAll: () => hibernateProfilesBatch({ all: true }),
  wake: (id) => openProfile(id),
};

export interface ResourceDashboardDrawerProps {
  open: boolean;
  onClose: () => void;
  profiles: readonly Pick<UiProfile, "id" | "name" | "engine" | "running">[];
  monitor: ResourceMonitorState;
  onRefreshRoster: () => Promise<void>;
  onFlash?: (message: string) => void;
  actions?: ResourceDashboardActions;
}

export function ResourceDashboardDrawer({
  open,
  onClose,
  profiles,
  monitor,
  onRefreshRoster,
  onFlash,
  actions = DEFAULT_ACTIONS,
}: ResourceDashboardDrawerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [sortBy, setSortBy] = useState<"rss" | "cpu">("rss");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDialogKeyboard(drawerRef, open, onClose, () => closeRef.current);

  const snapshot = monitor.snapshot;
  const profileNames = useMemo(
    () => new Map(profiles.map((p) => [p.id, p])),
    [profiles],
  );

  const ranked = useMemo(() => {
    const list = [...(snapshot?.profiles ?? [])];
    list.sort((a, b) =>
      sortBy === "cpu"
        ? b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes
        : b.rssBytes - a.rssBytes || b.cpuPercent - a.cpuPercent,
    );
    return list;
  }, [snapshot?.profiles, sortBy]);

  const hibernatedList = useMemo(
    () =>
      (snapshot?.hibernatedProfileIds ?? []).map((id) => ({
        id,
        name: profileNames.get(id)?.name ?? id,
      })),
    [snapshot?.hibernatedProfileIds, profileNames],
  );

  const handleTrimOne = async (id: string, name: string) => {
    if (busyKey) return;
    setBusyKey(`trim:${id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await actions.trimProfile(id);
      const msg = t("Trimmed memory for {profile} (freed {freed}).", {
        profile: name,
        freed: formatMemoryBytes(result.totalFreedBytes),
      });
      setNotice(msg);
      onFlash?.(msg);
      await monitor.refreshNow();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not trim browser memory."));
    } finally {
      setBusyKey(null);
    }
  };

  const handleTrimAll = async () => {
    if (busyKey) return;
    setBusyKey("trim:all");
    setError(null);
    setNotice(null);
    try {
      const result = await actions.trimAll();
      const msg = t("Trimmed memory across running browsers (freed {freed}).", {
        freed: formatMemoryBytes(result.totalFreedBytes),
      });
      setNotice(msg);
      onFlash?.(msg);
      await monitor.refreshNow();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not trim browser memory."));
    } finally {
      setBusyKey(null);
    }
  };

  const handleHibernateOne = async (id: string, name: string) => {
    if (busyKey) return;
    setBusyKey(`hib:${id}`);
    setError(null);
    setNotice(null);
    try {
      await actions.hibernate(id);
      const msg = t("Saved session and hibernated {profile}.", { profile: name });
      setNotice(msg);
      onFlash?.(msg);
      await Promise.all([onRefreshRoster(), monitor.refreshNow()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not hibernate environment."));
    } finally {
      setBusyKey(null);
    }
  };

  const handleHibernateAll = async () => {
    if (busyKey) return;
    setBusyKey("hib:all");
    setError(null);
    setNotice(null);
    try {
      const res = await actions.hibernateAll();
      const msg = t("Hibernated {count} running environments with saved sessions.", {
        count: res.hibernated.length,
      });
      setNotice(msg);
      onFlash?.(msg);
      await Promise.all([onRefreshRoster(), monitor.refreshNow()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not hibernate environments."));
    } finally {
      setBusyKey(null);
    }
  };

  const handleWake = async (id: string, name: string) => {
    if (busyKey) return;
    setBusyKey(`wake:${id}`);
    setError(null);
    setNotice(null);
    try {
      await actions.wake(id);
      const msg = t("Waking hibernated environment {profile}.", { profile: name });
      setNotice(msg);
      onFlash?.(msg);
      await Promise.all([onRefreshRoster(), monitor.refreshNow()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not wake environment."));
    } finally {
      setBusyKey(null);
    }
  };

  const loadRatio = snapshot
    ? Math.max(0, Math.min(1, snapshot.host.memoryLoadPercent / 100))
    : 0;
  const wmLevel = snapshot?.watermark.level ?? "normal";

  return (
    <MotionPresence present={open} kind="panel">
      <div
        className="resdash-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget && !busyKey) onClose();
        }}
      >
        <div
          ref={drawerRef}
          className="resdash-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-resource-dashboard
          onClick={(event) => event.stopPropagation()}
        >
          <header className="resdash-head">
            <div>
              <h2 id={titleId}>{t("Real-time resource monitor")}</h2>
              <p role="status" className="resdash-connection" data-live={monitor.streaming || undefined}>
                {monitor.streaming
                  ? t("Live telemetry active (pauses when window is hidden)")
                  : monitor.reconnecting
                    ? t("Resource monitoring interrupted. Reconnecting…")
                    : monitor.unsupported
                      ? t("Live metrics endpoint unavailable on this server")
                      : t("Snapshot telemetry")}
              </p>
            </div>
            <div className="resdash-actions">
              <button
                type="button"
                className="btn xs ghost"
                disabled={!!busyKey}
                aria-label={t("Refresh resource metrics")}
                onClick={() => void monitor.refreshNow()}
              >
                <Icon name="refresh" className="sm" />
              </button>
              <button ref={closeRef} type="button" className="iconbtn" aria-label={t("Close")} onClick={onClose}>
                <Icon name="close" className="sm" />
              </button>
            </div>
          </header>

          <div className="resdash-body">
            {error && <div className="tools-alert" role="alert">{error}</div>}
            {notice && <div className="tools-notice" role="status">{notice}</div>}

            {monitor.unsupported && !snapshot ? (
              <div className="tools-empty compact">
                <p>{t("Process resource telemetry is not enabled on this local service version.")}</p>
              </div>
            ) : !snapshot ? !monitor.reconnecting && (
              <div className="tools-empty compact">
                <p role="status">{t("Collecting host and browser process metrics…")}</p>
              </div>
            ) : (
              <>
                <section className="resdash-host-card" aria-label={t("Host memory status")}>
                  <div className="resdash-host-row">
                    <div>
                      <strong>{Math.round(snapshot.host.memoryLoadPercent)}%</strong>{" "}
                      <span className="muted">
                        {t("{used} / {total} RAM ({free} free)", {
                          used: formatMemoryBytes(snapshot.host.usedBytes),
                          total: formatMemoryBytes(snapshot.host.totalBytes),
                          free: formatMemoryBytes(snapshot.host.availableBytes),
                        })}
                      </span>
                    </div>
                    <span className={`resdash-wm-badge wm-${wmLevel}`}>
                      {t(WATERMARK_LABELS[wmLevel])} ·{" "}
                      {t("Max {count} concurrent starts", {
                        count: snapshot.watermark.recommendedConcurrency,
                      })}
                    </span>
                  </div>
                  <div className="resdash-meter-track" aria-hidden="true">
                    <div
                      className={`resdash-meter-fill wm-${wmLevel}`}
                      style={{ transform: `scaleX(${loadRatio})` }}
                    />
                  </div>
                  <div className="resdash-stats-row">
                    <div>
                      <span>{t("Browser RSS total")}</span>
                      <strong>{formatMemoryBytes(snapshot.totals.totalRssBytes)}</strong>
                    </div>
                    <div>
                      <span>{t("Browser CPU total")}</span>
                      <strong>{formatCpuPercent(snapshot.totals.totalCpuPercent)}</strong>
                    </div>
                    <div>
                      <span>{t("Running / processes")}</span>
                      <strong>
                        {snapshot.totals.runningProfiles} / {snapshot.totals.totalProcesses}
                      </strong>
                    </div>
                  </div>
                </section>

                <div className="resdash-toolbar">
                  <div className="resdash-sort-group" role="group" aria-label={t("Sort resource list")}>
                    <button
                      type="button"
                      aria-pressed={sortBy === "rss"}
                      onClick={() => setSortBy("rss")}
                    >
                      {t("Sort by RAM")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortBy === "cpu"}
                      onClick={() => setSortBy("cpu")}
                    >
                      {t("Sort by CPU")}
                    </button>
                  </div>
                  <div className="resdash-actions">
                    <button
                      type="button"
                      className="btn xs"
                      disabled={!!busyKey || ranked.length === 0}
                      onClick={() => void handleTrimAll()}
                    >
                      {busyKey === "trim:all" ? t("Trimming…") : t("Trim all memory")}
                    </button>
                    <button
                      type="button"
                      className="btn xs"
                      disabled={!!busyKey || ranked.length === 0}
                      onClick={() => void handleHibernateAll()}
                    >
                      {busyKey === "hib:all" ? t("Hibernating…") : t("Hibernate all")}
                    </button>
                  </div>
                </div>

                {ranked.length === 0 ? (
                  <div className="tools-empty compact">
                    <p>{t("No browser environments are currently running.")}</p>
                  </div>
                ) : (
                  <div className="resdash-list" role="list" aria-label={t("Running browser resource usage")}>
                    {ranked.map((item) => {
                      const label = profileNames.get(item.profileId)?.name || item.name || item.profileId;
                      return (
                        <div key={item.profileId} className="resdash-row" role="listitem">
                          <div className="resdash-row-name">
                            <strong title={label}>{label}</strong>
                            <small>
                              {item.engine} · {t("{count} processes", { count: item.processCount })}
                            </small>
                          </div>
                          <div className="resdash-row-metrics">
                            <span>{formatMemoryBytes(item.rssBytes)}</span>
                            <span className="muted">{formatCpuPercent(item.cpuPercent)}</span>
                          </div>
                          <div className="resdash-row-actions">
                            <button
                              type="button"
                              className="btn xs"
                              disabled={!!busyKey}
                              onClick={() => void handleTrimOne(item.profileId, label)}
                            >
                              {busyKey === `trim:${item.profileId}` ? t("Trimming…") : t("Trim")}
                            </button>
                            <button
                              type="button"
                              className="btn xs ghost"
                              disabled={!!busyKey}
                              onClick={() => void handleHibernateOne(item.profileId, label)}
                            >
                              {busyKey === `hib:${item.profileId}` ? t("Saving…") : t("Hibernate")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {hibernatedList.length > 0 && (
                  <section className="resdash-sleeping" aria-label={t("Hibernated environments")}>
                    <div className="resdash-section-head">
                      <h3>{t("Hibernated environments")}</h3>
                      <span>{t("{count} ready to wake", { count: hibernatedList.length })}</span>
                    </div>
                    <div className="resdash-list">
                      {hibernatedList.map((item) => (
                        <div key={item.id} className="resdash-row">
                          <div className="resdash-row-name">
                            <strong>{item.name}</strong>
                            <small>{t("Session saved · 0 MB active")}</small>
                          </div>
                          <span className="profile-resource-chip is-hibernated">{t("Hibernated")}</span>
                          <div className="resdash-row-actions">
                            <button
                              type="button"
                              className="btn xs primary"
                              disabled={!!busyKey}
                              onClick={() => void handleWake(item.id, item.name)}
                            >
                              {busyKey === `wake:${item.id}` ? t("Waking…") : t("Wake")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </MotionPresence>
  );
}
