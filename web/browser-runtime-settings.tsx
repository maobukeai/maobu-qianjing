import { useEffect, useId, useRef, useState } from "react";
import type { RuntimeCacheState, RuntimeInventoryId, RuntimeInventorySource } from "../runtime-inventory.ts";
import type { RuntimeDownload } from "../runtime-download.ts";
import { useTranslation } from "./i18n.tsx";
import { runtimeDownloadPercent } from "./runtime-download-progress.tsx";
import { fetchBrowserRuntimeInventory, inspectBrowserRuntimeCache, type BrowserRuntimeInventory } from "./settings-api.ts";
import { AppIcon } from "./ui-primitives.tsx";
import "./browser-runtime-settings.css";

const runtimeLabels: Record<RuntimeInventoryId, string> = {
  "aliasmode-chromium": "AliasMode Chromium",
  cloakbrowser: "CloakBrowser",
  "aliasmode-firefox": "AliasMode Firefox",
};
const runtimeFamilies: Record<RuntimeInventoryId, RuntimeDownload["runtime"]> = {
  "aliasmode-chromium": "aliasmode",
  cloakbrowser: "cloakbrowser",
  "aliasmode-firefox": "firefox",
};
const runtimeIds = Object.keys(runtimeLabels) as RuntimeInventoryId[];
const sourceLabels: Record<RuntimeInventorySource, string> = {
  managed: "Managed cache",
  configured: "Configured executable",
  bundled: "Bundled executable",
  unconfigured: "Runtime not configured",
};
const cacheLabels: Record<Exclude<RuntimeCacheState, "not-applicable">, string> = {
  "not-checked": "Cache not checked",
  missing: "Not cached",
  "present-unverified": "Files found · unverified",
  incomplete: "Cache incomplete",
  unreadable: "Cache unavailable",
};
const platformLabels: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const sizeUnits = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

function formatSize(bytes: number, language: string): string {
  const unit = Math.min(sizeUnits.length - 1, Math.floor(Math.log10(Math.max(1, bytes)) / 3));
  return new Intl.NumberFormat(language, { style: "unit", unit: sizeUnits[unit], maximumFractionDigits: unit ? 1 : 0 })
    .format(bytes / 1000 ** unit);
}

function BrowserRuntimeTransfer({ download, index, multiple, familyTitle, statusTitle }: {
  download: RuntimeDownload;
  index: number;
  multiple: boolean;
  familyTitle: string;
  statusTitle: string;
}) {
  const { t, language } = useTranslation();
  const transferTitle = useId();
  const received = Number.isSafeInteger(download.receivedBytes) && download.receivedBytes >= 0
    ? formatSize(download.receivedBytes, language) : null;
  const percent = download.receivedBytes <= download.totalBytes ? runtimeDownloadPercent([download]) : null;
  const amount = received === null ? t("Downloaded size unavailable")
    : percent === null ? t("Downloaded {received} · Total size unknown", { received })
    : t("{received} of {total}", { received, total: formatSize(download.totalBytes, language) });
  const progressLabel = percent === null ? null : new Intl.NumberFormat(language, { style: "percent" }).format(percent / 100);

  return (
    <li className="browser-runtime-transfer">
      <div className="browser-runtime-transfer-label">
        {multiple && <span id={transferTitle}>{t("Transfer {number}", { number: index + 1 })}</span>}
        <span>{amount}</span>
        {progressLabel && <strong aria-hidden="true">{progressLabel}</strong>}
      </div>
      <progress
        max={100}
        value={percent ?? undefined}
        aria-labelledby={multiple ? `${familyTitle} ${statusTitle} ${transferTitle}` : `${familyTitle} ${statusTitle}`}
        aria-valuetext={progressLabel ? `${progressLabel} · ${amount}` : amount}
      />
    </li>
  );
}

function BrowserRuntimeCard({ id, inventory, downloads }: {
  id: RuntimeInventoryId;
  inventory: BrowserRuntimeInventory | null;
  downloads: readonly RuntimeDownload[];
}) {
  const { t } = useTranslation();
  const title = useId();
  const statusTitle = useId();
  const runtime = inventory?.runtimes.find(row => row.id === id);
  const transfers = downloads.filter(download => download?.runtime === runtimeFamilies[id]);
  if (!runtime && !transfers.length) return null;

  return (
    <li className="browser-runtime-card" data-browser-runtime={id}>
      <div className="browser-runtime-card-meta">
        <div>
          <h4 id={title}>{t(runtimeLabels[id])}</h4>
          {runtime && <p>{t("Pinned version")} <code>{runtime.pinnedVersion}</code></p>}
        </div>
        {runtime && <div className="browser-runtime-badges">
          {id === inventory?.defaultRuntime && <span className="feature-badge">{t("Default when engine is unspecified")}</span>}
          {id === inventory?.chromiumDefault && id !== inventory.defaultRuntime && <span className="feature-badge">{t("Chromium default")}</span>}
          <span className="feature-badge">{t(sourceLabels[runtime.source])}</span>
          {runtime.cache !== "not-applicable" && <span className="feature-badge">{t(cacheLabels[runtime.cache])}</span>}
          {(runtime.source === "configured" || runtime.source === "bundled") && <span className="feature-badge">{t("Executable version not measured")}</span>}
          {!runtime.hostSupported && <span className="feature-badge runtime-host-warning">{t("No pinned build for this host")}</span>}
        </div>}
      </div>
      {transfers.length > 0 && <div className="browser-runtime-downloads">
        <p id={statusTitle}>{t("Downloading browser…")}</p>
        <ul>
          {transfers.map((download, index) => (
            <BrowserRuntimeTransfer
              key={index}
              download={download}
              index={index}
              multiple={transfers.length > 1}
              familyTitle={title}
              statusTitle={statusTitle}
            />
          ))}
        </ul>
      </div>}
    </li>
  );
}

export function BrowserRuntimeSettings({ downloads = [], downloadStatusUnavailable = false }: {
  downloads?: readonly RuntimeDownload[];
  downloadStatusUnavailable?: boolean;
} = {}) {
  const { t } = useTranslation();
  const heading = useId();
  const active = useRef<AbortController | null>(null);
  const [inventory, setInventory] = useState<BrowserRuntimeInventory | null>(null);
  const [busy, setBusy] = useState<"catalog" | "cache" | null>("catalog");
  const [error, setError] = useState("");
  const activeDownloads = downloadStatusUnavailable ? [] : downloads;

  async function load(kind: "catalog" | "cache") {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(kind);
    setError("");
    try {
      const request = kind === "catalog" ? fetchBrowserRuntimeInventory : inspectBrowserRuntimeCache;
      const result = await request(controller.signal);
      if (active.current === controller) setInventory(result);
    } catch {
      if (active.current === controller) setError(kind === "catalog" ? "Could not load browser runtimes. Try again." : "Could not refresh the browser cache. Try again.");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(null);
      }
    }
  }

  useEffect(() => {
    void load("catalog");
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, []);

  return <section className="feature-card browser-runtime-settings" aria-labelledby={heading}>
    <div className="feature-card-title">
      <div className="feature-card-head-main">
        <div className="feature-card-heading">
          <AppIcon name="window" className="sm" />
          <h3 id={heading} tabIndex={-1} data-browser-runtime-settings-heading>{t("Browser runtimes")}</h3>
        </div>
        {inventory && <p className="browser-runtime-host">{platformLabels[inventory.host.platform] ?? inventory.host.platform} {inventory.host.arch}</p>}
      </div>
      <button type="button" className="btn" disabled={!!busy} aria-busy={!!busy} onClick={() => void load(inventory ? "cache" : "catalog")}>
        {t(busy === "catalog" ? "Loading…" : busy === "cache" ? "Checking cache…" : inventory ? "Refresh local cache" : "Try again")}
      </button>
    </div>
    <div className="feature-card-body">
      {error && <p className="feature-alert" role="alert">{t(error)}</p>}
      {downloadStatusUnavailable && <p className="feature-inline-note" role="status">{t("Download status temporarily unavailable")}</p>}
      {(inventory || activeDownloads.some(download => Object.values(runtimeFamilies).includes(download?.runtime))) && (
        <ul className="browser-runtime-cards">
          {runtimeIds.map(id => <BrowserRuntimeCard key={id} id={id} inventory={inventory} downloads={activeDownloads} />)}
        </ul>
      )}
      {inventory?.checked && <p className="browser-runtime-check-note" role="status">{t("Showing the last local cache check.")}</p>}
      <details className="feature-details browser-runtime-help">
        <summary>{t("Cache and integrity checks")}</summary>
        <p>{t("Refresh checks fixed local cache locations. Browser startup verifies executable integrity separately.")}</p>
      </details>
    </div>
  </section>;
}
