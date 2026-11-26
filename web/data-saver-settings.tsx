import { useEffect, useRef, useState } from "react";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import {
  DEFAULT_BATCH_LAUNCH_MEMORY_GUARD,
  DEFAULT_DATA_SAVER_SETTINGS,
  fetchSettings,
  fetchSettingsShared,
  patchSettings,
  resolveResourceNetworkDefaults,
  type BatchLaunchMemoryGuardConfig,
  type DataSaverSettingsConfig,
  type ResolvedAppSettings,
} from "./settings-api.ts";

interface ResourcePrefsDraft {
  firefoxMemorySaver: boolean;
  dataSaver: DataSaverSettingsConfig;
  batchLaunchMemoryGuard: BatchLaunchMemoryGuardConfig;
}

const DEFAULT_DRAFT: ResourcePrefsDraft = {
  firefoxMemorySaver: false,
  dataSaver: { ...DEFAULT_DATA_SAVER_SETTINGS },
  batchLaunchMemoryGuard: { ...DEFAULT_BATCH_LAUNCH_MEMORY_GUARD },
};

function sameDraft(left: ResourcePrefsDraft, right: ResourcePrefsDraft): boolean {
  return (
    left.firefoxMemorySaver === right.firefoxMemorySaver &&
    left.dataSaver.enabled === right.dataSaver.enabled &&
    left.dataSaver.blockImages === right.dataSaver.blockImages &&
    left.dataSaver.blockMedia === right.dataSaver.blockMedia &&
    left.dataSaver.blockFonts === right.dataSaver.blockFonts &&
    left.batchLaunchMemoryGuard.enabled === right.batchLaunchMemoryGuard.enabled &&
    left.batchLaunchMemoryGuard.softWatermarkPercent === right.batchLaunchMemoryGuard.softWatermarkPercent &&
    left.batchLaunchMemoryGuard.hardWatermarkPercent === right.batchLaunchMemoryGuard.hardWatermarkPercent &&
    left.batchLaunchMemoryGuard.minAvailableMb === right.batchLaunchMemoryGuard.minAvailableMb
  );
}

/**
 * Firefox memory saver, bandwidth data-saver, and batch-launch memory watermark controls.
 * Shares the parent NetworkPanel's initial `GET /ui/api/settings` read via `fetchSettingsShared`.
 */
export function DataSaverSettings({ initialSettings }: { initialSettings?: ResolvedAppSettings }) {
  const { t } = useTranslation();
  const lifecycle = useRef({ active: true, busy: false, generation: 0 });
  const [saved, setSaved] = useState<ResourcePrefsDraft | null>(() =>
    initialSettings ? resolveResourceNetworkDefaults(initialSettings.network) : null,
  );
  const [draft, setDraft] = useState<ResourcePrefsDraft>(() =>
    initialSettings ? resolveResourceNetworkDefaults(initialSettings.network) : DEFAULT_DRAFT,
  );
  const [busy, setBusy] = useState(!initialSettings);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const dirty = saved !== null && !sameDraft(saved, draft);
  useDesktopCloseDraft("network-settings", { dirty, busy: busy && dirty });

  const load = async (forceFresh = false) => {
    const state = lifecycle.current;
    if (!state.active || state.busy) return;
    state.busy = true;
    const generation = state.generation;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = forceFresh ? await fetchSettings() : await fetchSettingsShared();
      if (state.active && generation === state.generation) {
        const next = resolveResourceNetworkDefaults(result.network);
        setSaved(next);
        setDraft(next);
      }
    } catch {
      if (state.active && generation === state.generation) {
        setError("Resource and data saver settings could not be loaded. Try again.");
      }
    } finally {
      if (state.active && generation === state.generation) {
        state.busy = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    lifecycle.current.active = true;
    if (!initialSettings) void load(false);
    return () => {
      lifecycle.current.active = false;
      lifecycle.current.generation++;
      lifecycle.current.busy = false;
    };
  }, [initialSettings]);

  const validateGuard = (guard: BatchLaunchMemoryGuardConfig): string | null => {
    if (!Number.isInteger(guard.softWatermarkPercent) || guard.softWatermarkPercent < 30 || guard.softWatermarkPercent > 95) {
      return "Soft memory watermark must be a whole number from 30% to 95%.";
    }
    if (
      !Number.isInteger(guard.hardWatermarkPercent) ||
      guard.hardWatermarkPercent < 40 ||
      guard.hardWatermarkPercent > 99 ||
      guard.hardWatermarkPercent <= guard.softWatermarkPercent
    ) {
      return "Hard memory watermark must be higher than the soft watermark and between 40% and 99%.";
    }
    if (!Number.isInteger(guard.minAvailableMb) || guard.minAvailableMb < 128 || guard.minAvailableMb > 65536) {
      return "Minimum free memory must be between 128 MB and 65536 MB.";
    }
    return null;
  };

  const save = async () => {
    const state = lifecycle.current;
    if (!state.active || state.busy || saved === null || !dirty) return;
    const validationError = validateGuard(draft.batchLaunchMemoryGuard);
    if (validationError) {
      setError(validationError);
      return;
    }
    state.busy = true;
    const generation = state.generation;
    const desired = draft;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await patchSettings({
        network: {
          firefoxMemorySaver: desired.firefoxMemorySaver,
          dataSaver: desired.dataSaver,
          batchLaunchMemoryGuard: desired.batchLaunchMemoryGuard,
        },
      });
      if (state.active && generation === state.generation) {
        const persisted = resolveResourceNetworkDefaults(result.network);
        setSaved(persisted);
        setDraft(persisted);
        setNotice("Resource and data saver preferences saved. Browser launch options apply at next start.");
      }
    } catch (failure) {
      if (state.active && generation === state.generation) {
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : "Resource and data saver settings could not be saved. Try again.",
        );
      }
    } finally {
      if (state.active && generation === state.generation) {
        state.busy = false;
        setBusy(false);
      }
    }
  };

  const disabled = busy || saved === null;

  return (
    <section className="feature-card" aria-label={t("Resource & data saver")}>
      <div className="feature-card-title">
        <div className="feature-card-head-main">
          <div className="feature-card-heading">
            <AppIcon name="activity" className="sm" />
            <h3>{t("Resource & data saver")}</h3>
          </div>
          <p>{t("Reduce browser RAM usage, proxy bandwidth traffic, and memory spikes during batch launches.")}</p>
        </div>
        {saved === null ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void load(true)}>
            {t(busy ? "Loading…" : "Try again")}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={busy || !dirty}
            aria-busy={busy}
            onClick={() => void save()}
          >
            {t(busy ? "Saving…" : "Save resource preferences")}
          </button>
        )}
      </div>
      <div className="feature-card-body">
        <label className="feature-toggle">
          <span>
            <strong>{t("Firefox memory saver")}</strong>
            <small>{t("Limit Firefox content processes and unload background tabs under memory pressure. Applies on next launch.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.firefoxMemorySaver}
            disabled={disabled}
            onChange={(e) => {
              setDraft((cur) => ({ ...cur, firefoxMemorySaver: e.target.checked }));
              setNotice("");
              setError("");
            }}
          />
        </label>

        <label className="feature-toggle">
          <span>
            <strong>{t("Bandwidth data saver mode")}</strong>
            <small>{t("Reduce residential/metered proxy traffic by skipping heavy static assets on fresh launches.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.dataSaver.enabled}
            disabled={disabled}
            onChange={(e) => {
              const on = e.target.checked;
              setDraft((cur) => ({
                ...cur,
                dataSaver: {
                  ...cur.dataSaver,
                  enabled: on,
                  ...(on && !cur.dataSaver.blockImages && !cur.dataSaver.blockMedia && !cur.dataSaver.blockFonts
                    ? { blockImages: true, blockMedia: true }
                    : {}),
                },
              }));
              setNotice("");
              setError("");
            }}
          />
        </label>

        {draft.dataSaver.enabled && (
          <div className="feature-grid">
            <label className="fld" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={draft.dataSaver.blockImages}
                disabled={disabled}
                onChange={(e) => {
                  setDraft((cur) => ({ ...cur, dataSaver: { ...cur.dataSaver, blockImages: e.target.checked } }));
                  setNotice("");
                }}
              />
              <span>{t("Block images")}</span>
            </label>
            <label className="fld" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={draft.dataSaver.blockMedia}
                disabled={disabled}
                onChange={(e) => {
                  setDraft((cur) => ({ ...cur, dataSaver: { ...cur.dataSaver, blockMedia: e.target.checked } }));
                  setNotice("");
                }}
              />
              <span>{t("Block media autoplay & preload")}</span>
            </label>
            <label className="fld" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={draft.dataSaver.blockFonts}
                disabled={disabled}
                onChange={(e) => {
                  setDraft((cur) => ({ ...cur, dataSaver: { ...cur.dataSaver, blockFonts: e.target.checked } }));
                  setNotice("");
                }}
              />
              <span>{t("Block remote web fonts")}</span>
            </label>
          </div>
        )}

        <p className="feature-inline-note">
          {t("Off by default. Blocking images, media, or remote fonts saves metered proxy traffic without MITM extensions, but may alter media/font detection signals on strict websites.")}
        </p>

        <label className="feature-toggle">
          <span>
            <strong>{t("Batch launch memory watermark guard")}</strong>
            <small>{t("Automatically throttle or pause concurrent browser starts when host RAM crosses safe thresholds. Stop and cleanup actions are never throttled.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.batchLaunchMemoryGuard.enabled}
            disabled={disabled}
            onChange={(e) => {
              setDraft((cur) => ({
                ...cur,
                batchLaunchMemoryGuard: { ...cur.batchLaunchMemoryGuard, enabled: e.target.checked },
              }));
              setNotice("");
              setError("");
            }}
          />
        </label>

        {draft.batchLaunchMemoryGuard.enabled && (
          <div className="feature-grid">
            <label className="fld">
              <span>{t("Soft watermark (%)")}</span>
              <input
                type="number"
                min={30}
                max={95}
                step={1}
                value={draft.batchLaunchMemoryGuard.softWatermarkPercent}
                disabled={disabled}
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10);
                  setDraft((cur) => ({
                    ...cur,
                    batchLaunchMemoryGuard: {
                      ...cur.batchLaunchMemoryGuard,
                      softWatermarkPercent: Number.isFinite(value) ? value : 75,
                    },
                  }));
                  setNotice("");
                  setError("");
                }}
              />
            </label>
            <label className="fld">
              <span>{t("Hard watermark (%)")}</span>
              <input
                type="number"
                min={40}
                max={99}
                step={1}
                value={draft.batchLaunchMemoryGuard.hardWatermarkPercent}
                disabled={disabled}
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10);
                  setDraft((cur) => ({
                    ...cur,
                    batchLaunchMemoryGuard: {
                      ...cur.batchLaunchMemoryGuard,
                      hardWatermarkPercent: Number.isFinite(value) ? value : 88,
                    },
                  }));
                  setNotice("");
                  setError("");
                }}
              />
            </label>
            <label className="fld">
              <span>{t("Minimum free memory (MB)")}</span>
              <input
                type="number"
                min={128}
                max={65536}
                step={128}
                value={draft.batchLaunchMemoryGuard.minAvailableMb}
                disabled={disabled}
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10);
                  setDraft((cur) => ({
                    ...cur,
                    batchLaunchMemoryGuard: {
                      ...cur.batchLaunchMemoryGuard,
                      minAvailableMb: Number.isFinite(value) ? value : 1536,
                    },
                  }));
                  setNotice("");
                  setError("");
                }}
              />
            </label>
          </div>
        )}

        {error && <p className="feature-alert" role="alert">{t(error)}</p>}
        {notice && <p className="feature-success" role="status">{t(notice)}</p>}
      </div>
    </section>
  );
}
