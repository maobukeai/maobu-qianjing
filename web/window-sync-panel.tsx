import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { AppIcon as Icon } from "./ui-primitives.tsx";
import {
  arrangeWindows,
  fetchSyncStatus,
  injectSyncTexts,
  isWindowControlDesktopAvailable,
  listManagedWindows,
  listMonitors,
  pauseWindowSync,
  rectDimensions,
  renderSafeTextTemplate,
  runWindowAction,
  startWindowSync,
  stopWindowSync,
  updateSyncSlaves,
  WindowControlError,
  type ArrangeRequest,
  type ManagedWindowInfo,
  type MonitorInfo,
  type SyncStartConfig,
  type SyncStatusSnapshot,
  type TextInjectMode,
  type TextInjectRequest,
  type WindowActionRequest,
} from "./window-control-api.ts";
import "./window-sync.css";

export interface SyncEmergencyBarProps {
  state: SyncStatusSnapshot;
  profiles?: readonly { id: string; name: string }[];
  onOpenPanel: () => void;
  onPauseToggle: (paused: boolean) => void;
  onEmergencyStop: () => void;
}

/** Persistent compact emergency stop pill shown whenever window sync is active. */
export function SyncEmergencyBar({
  state,
  profiles = [],
  onOpenPanel,
  onPauseToggle,
  onEmergencyStop,
}: SyncEmergencyBarProps) {
  const { t } = useTranslation();
  if (!state.active) return null;

  const masterName =
    profiles.find((p) => p.id === state.masterProfileId)?.name ??
    state.masterProfileId ??
    t("Master window");
  const isPaused = state.paused || state.pausedByUser || state.pausedByFocus;
  const statusLabel = state.pausedByUser
    ? t("Sync paused")
    : state.pausedByFocus
      ? t("Paused (master unfocused)")
      : t("Syncing");

  return (
    <div
      className={`sync-emergency-bar${isPaused ? " is-paused" : ""}`}
      role="region"
      aria-label={t("Window synchronizer status")}
      data-sync-emergency-bar
    >
      <span
        className={`sync-status-dot${isPaused ? " is-paused" : " is-live"}`}
        aria-hidden="true"
      />
      <span className="sync-emergency-meta">
        <span>{statusLabel}</span>
        <span className="sync-emergency-sub">
          {t("{master} → {count} slaves", {
            master: masterName,
            count: state.slaveProfileIds.length,
          })}
        </span>
      </span>
      <span className="sync-emergency-actions">
        <button
          type="button"
          className="btn xs ghost"
          onClick={() => onPauseToggle(!state.pausedByUser)}
        >
          {state.pausedByUser ? t("Resume") : t("Pause")}
        </button>
        <button type="button" className="btn xs ghost" onClick={onOpenPanel}>
          {t("Controls")}
        </button>
        <button
          type="button"
          className="sync-emergency-stop-btn"
          onClick={onEmergencyStop}
        >
          {t("Emergency stop")}
          <kbd>{state.emergencyHotkey || "Ctrl+Shift+F12"}</kbd>
        </button>
      </span>
    </div>
  );
}

export interface WindowControlBackend {
  isAvailable: () => boolean;
  listMonitors: () => Promise<MonitorInfo[]>;
  listManagedWindows: () => Promise<ManagedWindowInfo[]>;
  arrangeWindows: (req: ArrangeRequest) => Promise<{ arranged: unknown[]; skipped: string[] }>;
  runWindowAction: (req: WindowActionRequest) => Promise<{ affected: string[]; missing: string[] }>;
  fetchSyncStatus: () => Promise<SyncStatusSnapshot>;
  startWindowSync: (config: SyncStartConfig) => Promise<SyncStatusSnapshot>;
  stopWindowSync: () => Promise<SyncStatusSnapshot>;
  pauseWindowSync: (paused: boolean) => Promise<SyncStatusSnapshot>;
  updateSyncSlaves: (profileIds: string[]) => Promise<SyncStatusSnapshot>;
  injectSyncTexts: (req: TextInjectRequest) => Promise<{ queuedProfiles: string[]; skippedProfiles: string[] }>;
}

const DEFAULT_BACKEND: WindowControlBackend = {
  isAvailable: () => isWindowControlDesktopAvailable(),
  listMonitors: () => listMonitors(),
  listManagedWindows: () => listManagedWindows(),
  arrangeWindows: (req) => arrangeWindows(req),
  runWindowAction: (req) => runWindowAction(req),
  fetchSyncStatus: () => fetchSyncStatus(),
  startWindowSync: (config) => startWindowSync(config),
  stopWindowSync: () => stopWindowSync(),
  pauseWindowSync: (paused) => pauseWindowSync(paused),
  updateSyncSlaves: (profileIds) => updateSyncSlaves(profileIds),
  injectSyncTexts: (req) => injectSyncTexts(req),
};

export interface WindowSyncPanelProps {
  open: boolean;
  onClose: () => void;
  profiles: readonly { id: string; name: string; running: boolean; customNo?: string }[];
  syncState: SyncStatusSnapshot;
  onSyncStateChange: (next: SyncStatusSnapshot) => void;
  onFlash?: (message: string) => void;
  backend?: WindowControlBackend;
}

export function WindowSyncPanel({
  open,
  onClose,
  profiles,
  syncState,
  onSyncStateChange,
  onFlash,
  backend = DEFAULT_BACKEND,
}: WindowSyncPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<ManagedWindowInfo[]>([]);
  const [desktopSupported, setDesktopSupported] = useState<boolean>(() => backend.isAvailable());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Layout options
  const [monitorTarget, setMonitorTarget] = useState<string>("primary");
  const [customCols, setCustomCols] = useState("2");
  const [customRows, setCustomRows] = useState("2");
  const [gapPx, setGapPx] = useState("8");
  const [paddingPx, setPaddingPx] = useState("8");

  // Syncer configuration
  const [masterId, setMasterId] = useState<string>("");
  const [slaveIds, setSlaveIds] = useState<Set<string>>(new Set());
  const [syncMouseClick, setSyncMouseClick] = useState(true);
  const [syncMouseMove, setSyncMouseMove] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const [syncKeyboard, setSyncKeyboard] = useState(true);
  const [jitterMinMs, setJitterMinMs] = useState("15");
  const [jitterMaxMs, setJitterMaxMs] = useState("85");
  const [clickPosJitterPx, setClickPosJitterPx] = useState("2");

  // Differentiated text injection
  const [injectMode, setInjectMode] = useState<TextInjectMode>("per_line_ordered");
  const [injectLines, setInjectLines] = useState("");
  const [injectMap, setInjectMap] = useState<Record<string, string>>({});
  const [injectTemplate, setInjectTemplate] = useState("Account-{{index}} ({{name}})");
  const [injectIncludeMaster, setInjectIncludeMaster] = useState(true);
  const [injectPressEnter, setInjectPressEnter] = useState(false);
  const [charDelayMin, setCharDelayMin] = useState("20");
  const [charDelayMax, setCharDelayMax] = useState("60");

  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const refreshDesktopState = useCallback(async () => {
    if (!backend.isAvailable()) {
      setDesktopSupported(false);
      setMonitors([]);
      setWindows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [monList, winList, status] = await Promise.all([
        backend.listMonitors(),
        backend.listManagedWindows(),
        backend.fetchSyncStatus(),
      ]);
      setDesktopSupported(status.supported !== false);
      setMonitors(monList);
      setWindows(winList);
      onSyncStateChange(status);
      if (status.active && status.masterProfileId) {
        setMasterId(status.masterProfileId);
        setSlaveIds(new Set(status.slaveProfileIds));
      } else if (winList.length > 0) {
        setMasterId((current) =>
          current && winList.some((w) => w.profileId === current)
            ? current
            : winList[0]!.profileId,
        );
      }
    } catch (failure) {
      if (failure instanceof WindowControlError && failure.unsupported) {
        setDesktopSupported(false);
      } else {
        setError(failure instanceof Error ? failure.message : t("Could not read managed browser windows."));
      }
    } finally {
      setLoading(false);
    }
  }, [backend, onSyncStateChange, t]);

  useEffect(() => {
    if (!open) return;
    void refreshDesktopState();
  }, [open, refreshDesktopState]);

  // Keep slave list clean whenever master changes
  useEffect(() => {
    if (!masterId) return;
    setSlaveIds((prev) => {
      if (!prev.has(masterId)) return prev;
      const next = new Set(prev);
      next.delete(masterId);
      return next;
    });
  }, [masterId]);

  const runningCandidates = useMemo(() => {
    if (windows.length > 0) {
      return windows.map((w) => ({
        profileId: w.profileId,
        name: w.name || profiles.find((p) => p.id === w.profileId)?.name || w.profileId,
        displayNo: w.displayNo,
        customNo: profiles.find((p) => p.id === w.profileId)?.customNo,
        engine: w.engine,
        isTopmost: w.isTopmost,
        isMinimized: w.isMinimized,
      }));
    }
    return profiles
      .filter((p) => p.running)
      .map((p) => ({
        profileId: p.id,
        name: p.name,
        displayNo: p.customNo || "",
        customNo: p.customNo,
        engine: "browser",
        isTopmost: false,
        isMinimized: false,
      }));
  }, [windows, profiles]);

  const slaveCandidates = useMemo(
    () => runningCandidates.filter((item) => item.profileId !== masterId),
    [runningCandidates, masterId],
  );

  const injectionTargets = useMemo(() => {
    const ids: string[] = [];
    if (injectIncludeMaster && masterId) ids.push(masterId);
    for (const candidate of slaveCandidates) {
      if (slaveIds.has(candidate.profileId)) ids.push(candidate.profileId);
    }
    if (ids.length === 0) {
      return runningCandidates;
    }
    return ids
      .map((id) => runningCandidates.find((c) => c.profileId === id))
      .filter((item): item is NonNullable<typeof item> => !!item);
  }, [injectIncludeMaster, masterId, slaveCandidates, slaveIds, runningCandidates]);

  const executeArrange = async (req: ArrangeRequest, feedbackLabel: string) => {
    if (busy || !desktopSupported) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await backend.arrangeWindows(req);
      const msg = t("{action}: arranged {arranged} windows ({skipped} skipped).", {
        action: t(feedbackLabel),
        arranged: result.arranged.length,
        skipped: result.skipped.length,
      });
      setNotice(msg);
      onFlash?.(msg);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not arrange windows."));
    } finally {
      setBusy(false);
    }
  };

  const executeAction = async (action: WindowActionRequest["action"], label: string) => {
    if (busy || !desktopSupported) return;
    const ids = runningCandidates.map((item) => item.profileId);
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await backend.runWindowAction({ action, profileIds: ids });
      const msg = t("{action}: applied to {count} windows.", {
        action: t(label),
        count: result.affected.length,
      });
      setNotice(msg);
      onFlash?.(msg);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Window action failed."));
    } finally {
      setBusy(false);
    }
  };

  const handleStartSync = async () => {
    if (busy || !desktopSupported || !masterId || slaveIds.size === 0) return;
    const minJitter = Math.max(0, Math.min(500, Number.parseInt(jitterMinMs, 10) || 0));
    const maxJitter = Math.max(minJitter, Math.min(1000, Number.parseInt(jitterMaxMs, 10) || minJitter));
    const posJitter = Math.max(0, Math.min(4, Number.parseInt(clickPosJitterPx, 10) || 0));
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await backend.startWindowSync({
        masterProfileId: masterId,
        slaveProfileIds: [...slaveIds],
        syncMouseClick,
        syncMouseMove,
        syncScroll,
        syncKeyboard,
        jitterMinMs: minJitter,
        jitterMaxMs: maxJitter,
        clickPosJitterPx: posJitter,
      });
      onSyncStateChange(next);
      setNotice(t("Window synchronizer started. Press {hotkey} anytime to stop immediately.", { hotkey: next.emergencyHotkey }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not start window synchronizer."));
    } finally {
      setBusy(false);
    }
  };

  const handleStopSync = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await backend.stopWindowSync();
      onSyncStateChange(next);
      setNotice(t("Window synchronizer stopped."));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not stop window synchronizer."));
    } finally {
      setBusy(false);
    }
  };

  const handlePauseSync = async (paused: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await backend.pauseWindowSync(paused);
      onSyncStateChange(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not update sync pause state."));
    } finally {
      setBusy(false);
    }
  };

  const toggleSlave = (id: string) => {
    setSlaveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (syncState.active && next.size > 0) {
        void backend.updateSyncSlaves([...next]).then(onSyncStateChange).catch(() => {});
      }
      return next;
    });
  };

  const handleInjectTexts = async () => {
    if (busy || !desktopSupported || injectionTargets.length === 0) return;
    const minDelay = Math.max(0, Math.min(500, Number.parseInt(charDelayMin, 10) || 20));
    const maxDelay = Math.max(minDelay, Math.min(1000, Number.parseInt(charDelayMax, 10) || 60));
    const targetIds = injectionTargets.map((item) => item.profileId);

    const req: TextInjectRequest = {
      mode: injectMode,
      targetProfileIds: targetIds,
      includeMaster: injectIncludeMaster,
      charDelayMinMs: minDelay,
      charDelayMaxMs: maxDelay,
      pressEnter: injectPressEnter,
    };
    if (injectMode === "per_line_ordered") {
      req.lines = injectLines.split(/\r?\n/).filter((line) => line.length > 0);
      if (!req.lines.length) {
        setError(t("Enter at least one line of text to inject."));
        return;
      }
    } else if (injectMode === "per_profile_map") {
      const map: Record<string, string> = {};
      for (const id of targetIds) {
        if ((injectMap[id] ?? "").length > 0) map[id] = injectMap[id]!;
      }
      if (!Object.keys(map).length) {
        setError(t("Enter text for at least one target window."));
        return;
      }
      req.profileTexts = map;
    } else {
      if (!injectTemplate.trim()) {
        setError(t("Enter a template before injecting."));
        return;
      }
      req.template = injectTemplate;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await backend.injectSyncTexts(req);
      setNotice(
        t("Queued differentiated text injection for {queued} windows ({skipped} skipped).", {
          queued: result.queuedProfiles.length,
          skipped: result.skippedProfiles.length,
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not inject text to windows."));
    } finally {
      setBusy(false);
    }
  };

  const clampNum = (raw: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  return (
    <MotionPresence present={open} kind="panel">
      <div
        className="wsync-drawer-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
      >
        <div
          className="wsync-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-window-sync-panel
          onClick={(event) => event.stopPropagation()}
        >
          <header className="wsync-drawer-head">
            <div>
              <h2 id={titleId}>{t("Window layout & synchronizer")}</h2>
              <p>
                {t("{count} managed browser windows", { count: runningCandidates.length })}
              </p>
            </div>
            <div className="wsync-actions-row">
              <button
                type="button"
                className="btn xs ghost"
                disabled={loading || !desktopSupported}
                aria-label={t("Refresh managed windows")}
                onClick={() => void refreshDesktopState()}
              >
                <Icon name="refresh" className="sm" />
              </button>
              <button
                ref={closeBtnRef}
                type="button"
                className="iconbtn"
                aria-label={t("Close")}
                onClick={onClose}
              >
                <Icon name="close" className="sm" />
              </button>
            </div>
          </header>

          <div className="wsync-drawer-body">
            {!desktopSupported && (
              <div className="wsync-degraded-box" role="status" data-window-sync-unavailable>
                <strong>{t("Desktop app required")}</strong>
                <p style={{ margin: "4px 0 0" }}>
                  {t("Native Win32 window tiling, multi-monitor arrangement, and safe input synchronization are only available in the Windows desktop application.")}
                </p>
              </div>
            )}

            {error && <div className="tools-alert" role="alert">{error}</div>}
            {notice && <div className="tools-notice" role="status">{notice}</div>}

            {/* Section 1: Multi-window layout */}
            <section className="wsync-section" aria-label={t("Multi-window layout")}>
              <div className="wsync-section-head">
                <h3>{t("Multi-window layout")}</h3>
                <span>{t("Zero-flicker DWM shadow compensation")}</span>
              </div>

              <label className="fld">
                <span>{t("Target monitor")}</span>
                <select
                  aria-label={t("Target monitor")}
                  value={monitorTarget}
                  disabled={!desktopSupported || busy}
                  onChange={(e) => setMonitorTarget(e.target.value)}
                >
                  <option value="primary">{t("Primary monitor")}</option>
                  <option value="active">{t("Active monitor")}</option>
                  <option value="all">{t("Span all monitors")}</option>
                  {monitors.map((mon) => {
                    const dim = rectDimensions(mon.workArea);
                    return (
                      <option key={mon.id} value={mon.id}>
                        {mon.name} ({dim.width}×{dim.height} · {mon.scalePercent}%)
                        {mon.isPrimary ? ` · ${t("Primary")}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>

              <div className="wsync-preset-grid">
                <button
                  type="button"
                  className="wsync-preset-btn"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange(
                      {
                        mode: "grid",
                        monitor: monitorTarget,
                        gapPx: clampNum(gapPx, 0, 32, 8),
                        paddingPx: clampNum(paddingPx, 0, 64, 8),
                        restoreMinimized: true,
                      },
                      "Smart grid",
                    )
                  }
                >
                  <span>{t("Smart grid")}</span>
                  <small>{t("Auto-fit rows & columns to monitor aspect")}</small>
                </button>
                <button
                  type="button"
                  className="wsync-preset-btn"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange(
                      {
                        mode: "custom_grid",
                        monitor: monitorTarget,
                        cols: clampNum(customCols, 1, 12, 2),
                        rows: clampNum(customRows, 1, 12, 2),
                        gapPx: clampNum(gapPx, 0, 32, 8),
                        paddingPx: clampNum(paddingPx, 0, 64, 8),
                        restoreMinimized: true,
                      },
                      "Custom grid",
                    )
                  }
                >
                  <span>{t("Custom grid ({cols}×{rows})", { cols: customCols || "2", rows: customRows || "2" })}</span>
                  <small>{t("Apply custom columns, rows & gap")}</small>
                </button>
                <button
                  type="button"
                  className="wsync-preset-btn"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange(
                      { mode: "cascade", monitor: monitorTarget, cascadeOffsetPx: 32, restoreMinimized: true },
                      "Cascade",
                    )
                  }
                >
                  <span>{t("Cascade")}</span>
                  <small>{t("Diagonal offset stack (32px step)")}</small>
                </button>
                <button
                  type="button"
                  className="wsync-preset-btn"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange(
                      {
                        mode: "master_detail",
                        monitor: monitorTarget,
                        masterProfileId: masterId || runningCandidates[0]?.profileId,
                        gapPx: clampNum(gapPx, 0, 32, 8),
                        paddingPx: clampNum(paddingPx, 0, 64, 8),
                        restoreMinimized: true,
                      },
                      "Master + slaves split",
                    )
                  }
                >
                  <span>{t("Master + slaves split")}</span>
                  <small>{t("Large master window + tiled slave grid")}</small>
                </button>
              </div>

              <div className="wsync-form-row cols-4">
                <label className="fld">
                  <span>{t("Cols")}</span>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={customCols}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setCustomCols(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Rows")}</span>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={customRows}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setCustomRows(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Gap (px)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={32}
                    value={gapPx}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setGapPx(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Padding (px)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={64}
                    value={paddingPx}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setPaddingPx(e.target.value)}
                  />
                </label>
              </div>

              <div className="wsync-actions-row">
                <button
                  type="button"
                  className="btn xs"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange({ mode: "gather", monitor: monitorTarget, gatherAction: "restore" }, "Restore all")
                  }
                >
                  {t("Restore all")}
                </button>
                <button
                  type="button"
                  className="btn xs"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange({ mode: "gather", monitor: monitorTarget, gatherAction: "minimize" }, "Minimize all")
                  }
                >
                  {t("Minimize all")}
                </button>
                <button
                  type="button"
                  className="btn xs"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() =>
                    void executeArrange({ mode: "gather", monitor: monitorTarget, gatherAction: "stack_center" }, "Stack center")
                  }
                >
                  {t("Stack center")}
                </button>
                <button
                  type="button"
                  className="btn xs"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() => void executeAction("topmost", "Pin on top")}
                >
                  {t("Pin on top")}
                </button>
                <button
                  type="button"
                  className="btn xs ghost"
                  disabled={!desktopSupported || busy || runningCandidates.length === 0}
                  onClick={() => void executeAction("untopmost", "Unpin")}
                >
                  {t("Unpin")}
                </button>
              </div>
            </section>

            {/* Section 2: Safe Window Synchronizer */}
            <section className="wsync-section" aria-label={t("Safe window synchronizer")}>
              <div className="wsync-section-head">
                <h3>{t("Safe window synchronizer")}</h3>
                <span>
                  {syncState.active
                    ? t("Active · {count} events forwarded", { count: syncState.forwardedEvents })
                    : t("Idle")}
                </span>
              </div>

              <label className="fld">
                <span>{t("Master window")}</span>
                <select
                  aria-label={t("Master window")}
                  value={masterId}
                  disabled={!desktopSupported || busy || syncState.active || runningCandidates.length === 0}
                  onChange={(e) => setMasterId(e.target.value)}
                >
                  {runningCandidates.length === 0 ? (
                    <option value="">{t("Start at least 2 environments first")}</option>
                  ) : (
                    runningCandidates.map((win) => (
                      <option key={win.profileId} value={win.profileId}>
                        {win.displayNo ? `#${win.displayNo} · ` : ""}
                        {win.name} ({win.engine})
                      </option>
                    ))
                  )}
                </select>
              </label>

              <div>
                <div className="wsync-section-head" style={{ marginBottom: "6px" }}>
                  <span>{t("Slave windows ({count} selected)", { count: slaveIds.size })}</span>
                  <div className="wsync-actions-row">
                    <button
                      type="button"
                      className="btn xs ghost"
                      disabled={!desktopSupported || slaveCandidates.length === 0}
                      onClick={() => {
                        const all = new Set(slaveCandidates.map((c) => c.profileId));
                        setSlaveIds(all);
                        if (syncState.active && all.size > 0) {
                          void backend.updateSyncSlaves([...all]).then(onSyncStateChange).catch(() => {});
                        }
                      }}
                    >
                      {t("Select all")}
                    </button>
                    <button
                      type="button"
                      className="btn xs ghost"
                      disabled={!desktopSupported || slaveIds.size === 0 || syncState.active}
                      onClick={() => setSlaveIds(new Set())}
                    >
                      {t("Clear")}
                    </button>
                  </div>
                </div>
                <div className="wsync-slave-list">
                  {slaveCandidates.length === 0 ? (
                    <p className="tools-hint" style={{ padding: "10px 12px" }}>
                      {t("No other running browser windows available as slaves.")}
                    </p>
                  ) : (
                    slaveCandidates.map((win) => (
                      <label key={win.profileId} className="wsync-slave-item">
                        <input
                          type="checkbox"
                          checked={slaveIds.has(win.profileId)}
                          disabled={!desktopSupported}
                          onChange={() => toggleSlave(win.profileId)}
                        />
                        <span>{win.name}</span>
                        <small>{win.engine}</small>
                      </label>
                    ))
                  )}
                </div>
              </div>

              <div className="wsync-switches" role="group" aria-label={t("Synchronized input channels")}>
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={syncMouseClick}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setSyncMouseClick(e.target.checked)}
                  />
                  {t("Mouse clicks")}
                </label>
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={syncMouseMove}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setSyncMouseMove(e.target.checked)}
                  />
                  {t("Mouse movement")}
                </label>
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={syncScroll}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setSyncScroll(e.target.checked)}
                  />
                  {t("Scroll wheel")}
                </label>
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={syncKeyboard}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setSyncKeyboard(e.target.checked)}
                  />
                  {t("Keyboard")}
                </label>
              </div>

              <div className="wsync-form-row cols-4">
                <label className="fld">
                  <span>{t("Jitter min (ms)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    value={jitterMinMs}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setJitterMinMs(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Jitter max (ms)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={jitterMaxMs}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setJitterMaxMs(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Click offset (px)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={4}
                    value={clickPosJitterPx}
                    disabled={!desktopSupported || syncState.active}
                    onChange={(e) => setClickPosJitterPx(e.target.value)}
                  />
                </label>
                <div className="fld">
                  <span>{t("Emergency hotkey")}</span>
                  <input type="text" readOnly value={syncState.emergencyHotkey || "Ctrl+Shift+F12"} />
                </div>
              </div>

              <p className="wsync-safety-note">
                {t("Foreground-gated: events only forward while the master browser is focused. Switching to another app pauses sync automatically. System shortcuts (Alt+Tab, Alt+F4, Win) are never forwarded. Press Ctrl+Shift+F12 or double-tap Esc to stop immediately.")}
              </p>

              <div className="wsync-actions-row">
                {!syncState.active ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!desktopSupported || busy || !masterId || slaveIds.size === 0}
                    onClick={() => void handleStartSync()}
                  >
                    <Icon name="play" className="sm" />
                    {t("Start sync")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void handlePauseSync(!syncState.pausedByUser)}
                    >
                      {syncState.pausedByUser ? t("Resume sync") : t("Pause sync")}
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      onClick={() => void handleStopSync()}
                    >
                      <Icon name="power" className="sm" />
                      {t("Emergency stop")}
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* Section 3: Differentiated Text Injection */}
            <section className="wsync-section" aria-label={t("Differentiated text injection")}>
              <div className="wsync-section-head">
                <h3>{t("Differentiated text injection")}</h3>
                <span>{t("Clipboard-free WM_CHAR typing")}</span>
              </div>

              <div className="wsync-mode-tabs" role="group" aria-label={t("Text injection mode")}>
                {(
                  [
                    { key: "per_line_ordered", label: "One line per window" },
                    { key: "per_profile_map", label: "Per-environment" },
                    { key: "template", label: "Safe template" },
                  ] as const
                ).map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    aria-pressed={injectMode === mode.key}
                    disabled={!desktopSupported}
                    onClick={() => setInjectMode(mode.key)}
                  >
                    {t(mode.label)}
                  </button>
                ))}
              </div>

              {injectMode === "per_line_ordered" && (
                <label className="fld">
                  <span>{t("Lines to distribute (1 line → 1 window)")}</span>
                  <textarea
                    rows={4}
                    value={injectLines}
                    disabled={!desktopSupported || busy}
                    placeholder={"Line for window 1\nLine for window 2"}
                    onChange={(e) => setInjectLines(e.target.value)}
                  />
                </label>
              )}

              {injectMode === "per_profile_map" && (
                <div className="wsync-slave-list" style={{ padding: "8px" }}>
                  {injectionTargets.length === 0 ? (
                    <p className="tools-hint">{t("No running target windows selected.")}</p>
                  ) : (
                    injectionTargets.map((win) => (
                      <label key={win.profileId} className="fld" style={{ marginBottom: "8px" }}>
                        <span>{win.name}</span>
                        <input
                          type="text"
                          value={injectMap[win.profileId] ?? ""}
                          disabled={!desktopSupported || busy}
                          placeholder={t("Text for {profile}", { profile: win.name })}
                          onChange={(e) =>
                            setInjectMap((prev) => ({ ...prev, [win.profileId]: e.target.value }))
                          }
                        />
                      </label>
                    ))
                  )}
                </div>
              )}

              {injectMode === "template" && (
                <>
                  <label className="fld">
                    <span>{t("Template (supports {{index}}, {{name}}, {{customNo}})")}</span>
                    <input
                      type="text"
                      value={injectTemplate}
                      disabled={!desktopSupported || busy}
                      onChange={(e) => setInjectTemplate(e.target.value)}
                    />
                  </label>
                  {injectionTargets.length > 0 && (
                    <ul className="wsync-preview-list" aria-label={t("Template preview")}>
                      {injectionTargets.slice(0, 6).map((win, idx) => (
                        <li key={win.profileId}>
                          <span>{win.name}</span>
                          <code>{renderSafeTextTemplate(injectTemplate, win, idx + 1)}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              <div className="wsync-form-row">
                <label className="fld">
                  <span>{t("Char delay min (ms)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    value={charDelayMin}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setCharDelayMin(e.target.value)}
                  />
                </label>
                <label className="fld">
                  <span>{t("Char delay max (ms)")}</span>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={charDelayMax}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setCharDelayMax(e.target.value)}
                  />
                </label>
              </div>

              <div className="wsync-switches">
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={injectIncludeMaster}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setInjectIncludeMaster(e.target.checked)}
                  />
                  {t("Include master window")}
                </label>
                <label className="wsync-switch-item">
                  <input
                    type="checkbox"
                    checked={injectPressEnter}
                    disabled={!desktopSupported || busy}
                    onChange={(e) => setInjectPressEnter(e.target.checked)}
                  />
                  {t("Press Enter after typing")}
                </label>
              </div>

              <p className="wsync-safety-note">
                {t("Typed character-by-character without using the system clipboard. Saved passwords and 2FA secrets are never injected automatically.")}
              </p>

              <div className="wsync-actions-row">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!desktopSupported || busy || injectionTargets.length === 0}
                  onClick={() => void handleInjectTexts()}
                >
                  {t("Inject text to {count} windows", { count: injectionTargets.length })}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </MotionPresence>
  );
}
