import { useState } from "react";
import type { RuntimeDownload } from "../src/runtime-download.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./runtime-download-progress.css";

type Translator = (source: string, values?: Record<string, string | number>) => string;

const RUNTIME_LABELS: Record<RuntimeDownload["runtime"], string> = {
  aliasmode: "Chromium",
  cloakbrowser: "CloakBrowser",
  firefox: "Firefox",
};

/** One unknown-length transfer makes the combined progress indeterminate. */
export function runtimeDownloadPercent(downloads: readonly RuntimeDownload[]): number | null {
  if (!downloads.length) return null;
  let total = 0, received = 0;
  for (const download of downloads) {
    if (!Number.isSafeInteger(download.totalBytes) || download.totalBytes <= 0
      || !Number.isSafeInteger(download.receivedBytes) || download.receivedBytes < 0) return null;
    total += download.totalBytes;
    received += Math.min(download.receivedBytes, download.totalBytes);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(received)) return null;
  }
  return Math.floor(received * 100 / total);
}

export function areRuntimeDownloadsPaused(downloads: readonly RuntimeDownload[]): boolean {
  return downloads.length > 0 && downloads.every((download) => download.status === "paused");
}

export function runtimeDownloadLabel(downloads: readonly RuntimeDownload[], t: Translator): string {
  const percent = runtimeDownloadPercent(downloads);
  if (areRuntimeDownloadsPaused(downloads)) {
    return percent === null
      ? t("Download paused")
      : t("Download paused · {percent}%", { percent });
  }
  return percent === null ? t("Downloading browser…") : t("Downloading browser… {percent}%", { percent });
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return kb >= 1 ? `${Math.round(kb)} KB` : `${Math.round(bytes)} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSec / 1024;
  return `${Math.max(1, Math.round(kb))} KB/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole}s`;
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function downloadByteTotals(downloads: readonly RuntimeDownload[]): { received: number; total: number | null; bytesPerSec: number } {
  let received = 0;
  let total = 0;
  let knownTotal = downloads.length > 0;
  let bytesPerSec = 0;
  for (const item of downloads) {
    const itemReceived = Number.isSafeInteger(item.receivedBytes) && item.receivedBytes >= 0 ? item.receivedBytes : 0;
    const itemTotal = Number.isSafeInteger(item.totalBytes) && item.totalBytes > 0 ? item.totalBytes : 0;
    received += itemTotal > 0 ? Math.min(itemReceived, itemTotal) : itemReceived;
    if (itemTotal > 0) total += itemTotal;
    else knownTotal = false;
    if (item.status !== "paused" && typeof item.bytesPerSec === "number" && Number.isFinite(item.bytesPerSec) && item.bytesPerSec > 0) {
      bytesPerSec += item.bytesPerSec;
    }
  }
  return {
    received,
    total: knownTotal && total > 0 ? total : null,
    bytesPerSec,
  };
}

export interface RuntimeDownloadProgressViewProps {
  downloads: readonly RuntimeDownload[];
  stale?: boolean;
  pendingAction?: "pause" | "resume" | "cancel" | null;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}

export function RuntimeDownloadProgressView({
  downloads,
  stale = false,
  pendingAction = null,
  onPause,
  onResume,
  onCancel,
}: RuntimeDownloadProgressViewProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const percent = runtimeDownloadPercent(downloads);
  const paused = !stale && areRuntimeDownloadsPaused(downloads);
  const totals = downloadByteTotals(downloads);
  const speedText = !paused && totals.bytesPerSec > 0 ? formatSpeed(totals.bytesPerSec) : "";
  const etaSeconds = !paused && totals.total !== null && totals.bytesPerSec > 0 && totals.total > totals.received
    ? (totals.total - totals.received) / totals.bytesPerSec
    : null;
  const etaText = etaSeconds !== null ? formatEta(etaSeconds) : "";
  const runtimeBadges = [...new Set(downloads.map((d) => RUNTIME_LABELS[d.runtime]))];
  const hasProgressData = !stale && downloads.length > 0 && downloads.every(
    (d) => Number.isSafeInteger(d.receivedBytes) && d.receivedBytes >= 0 && Number.isSafeInteger(d.totalBytes) && d.totalBytes >= 0,
  );
  const byteSummary = totals.total !== null
    ? `${formatByteSize(totals.received)} / ${formatByteSize(totals.total)}`
    : totals.received > 0
      ? formatByteSize(totals.received)
      : "";

  return (
    <section
      className={`runtime-download-dock${paused ? " is-paused" : ""}${stale ? " is-stale" : ""}`}
      aria-label={t("Browser downloads")}
    >
      <div className="runtime-download-dock__rail">
        <div className="runtime-download-dock__status" role="status">
          <span className="runtime-download-dock__indicator" aria-hidden="true" />
          <span className="runtime-download-dock__label">
            {stale ? t("Download status temporarily unavailable") : runtimeDownloadLabel(downloads, t)}
          </span>
          {!stale && runtimeBadges.map((name) => (
            <span key={name} className="runtime-download-dock__badge">{name}</span>
          ))}
        </div>

        {!stale && (
          <div className="runtime-download-dock__metrics">
            {paused ? (
              <span>{t("Paused")}</span>
            ) : speedText ? (
              <span>{speedText}</span>
            ) : null}
            {hasProgressData && byteSummary && (
              <>
                {(paused || speedText) && <span className="runtime-download-dock__sep" aria-hidden="true">·</span>}
                <span>{byteSummary}</span>
              </>
            )}
            {etaText && (
              <>
                <span className="runtime-download-dock__sep" aria-hidden="true">·</span>
                <span>{etaText}</span>
              </>
            )}
          </div>
        )}

        <div className="runtime-download-dock__actions">
          {!stale && (
            <progress
              className="runtime-download-sr-progress"
              max={100}
              value={percent ?? undefined}
              aria-label={t("Browser download progress")}
            />
          )}
          {!stale && (paused ? onResume : onPause) && (
            paused ? (
              <button
                type="button"
                className="runtime-download-btn runtime-download-btn--primary"
                disabled={pendingAction !== null}
                onClick={onResume}
              >
                <AppIcon name="play" className="sm" />
                <span>{t("Resume")}</span>
              </button>
            ) : (
              <button
                type="button"
                className="runtime-download-btn"
                disabled={pendingAction !== null}
                onClick={onPause}
              >
                <AppIcon name="pause" className="sm" />
                <span>{t("Pause")}</span>
              </button>
            )
          )}
          {!stale && onCancel && (
            <button
              type="button"
              className="runtime-download-btn runtime-download-btn--danger"
              disabled={pendingAction !== null}
              onClick={onCancel}
            >
              <AppIcon name="close" className="sm" />
              <span>{t("Cancel")}</span>
            </button>
          )}
          {!stale && downloads.length > 0 && (
            <button
              type="button"
              className="runtime-download-btn runtime-download-btn--ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span>{t(expanded ? "Hide details" : "Details")}</span>
              <AppIcon name={expanded ? "chevronUp" : "chevronDown"} className="sm" />
            </button>
          )}
        </div>

        {!stale && (
          <div className="runtime-download-dock__track" aria-hidden="true">
            <div
              className={`runtime-download-dock__fill${percent === null ? " is-indeterminate" : ""}`}
              style={percent === null ? undefined : { transform: `scaleX(${Math.max(0, Math.min(1, percent / 100))})` }}
            />
          </div>
        )}
      </div>

      {!stale && expanded && (
        <div className="runtime-download-dock__details">
          {downloads.map((item, index) => {
            const itemPaused = item.status === "paused";
            const itemSpeed = !itemPaused && typeof item.bytesPerSec === "number" && item.bytesPerSec > 0
              ? formatSpeed(item.bytesPerSec)
              : "";
            const itemBytes = item.totalBytes > 0
              ? `${formatByteSize(Math.min(item.receivedBytes, item.totalBytes))} / ${formatByteSize(item.totalBytes)}`
              : formatByteSize(item.receivedBytes);
            return (
              <div key={`${item.runtime}-${index}`} className="runtime-download-detail-row">
                <div className="runtime-download-detail-row__info">
                  <span className="runtime-download-detail-row__name">{RUNTIME_LABELS[item.runtime]}</span>
                  <span className="runtime-download-detail-row__state">
                    {t(itemPaused ? "Paused" : "Downloading")}
                  </span>
                </div>
                <div className="runtime-download-detail-row__stats">
                  {itemSpeed && <span>{itemSpeed}</span>}
                  <span>{itemBytes}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
