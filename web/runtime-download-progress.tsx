import type { RuntimeDownload } from "../runtime-download.ts";
import { useTranslation } from "./i18n.tsx";

type Translator = (source: string, values?: Record<string, string | number>) => string;

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

export function runtimeDownloadLabel(downloads: readonly RuntimeDownload[], t: Translator): string {
  const percent = runtimeDownloadPercent(downloads);
  return percent === null ? t("Downloading browser…") : t("Downloading browser… {percent}%", { percent });
}

export function RuntimeDownloadProgressView({ downloads }: { downloads: readonly RuntimeDownload[] }) {
  const { t } = useTranslation();
  const percent = runtimeDownloadPercent(downloads);
  return <div className="update-progress" role="status">
    <span>{runtimeDownloadLabel(downloads, t)}</span>
    <progress max={100} value={percent ?? undefined} aria-label={t("Browser download progress")} />
  </div>;
}
