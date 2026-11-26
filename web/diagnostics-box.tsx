import * as React from "react";
import { useId, useRef, useState } from "react";
import {
  exportDiagnosticsBundle,
  runDiagnosticsCheck,
  triggerBlobDownload,
  type DiagnosticCheckResult,
  type DiagnosticStatus,
  type DiagnosticsSnapshot,
  type SystemDiagnosticReport,
} from "./diagnostics-api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./diagnostics-box.css";

export interface DiagnosticsBoxProps {
  /** Optional callback notified after a diagnostic run completes (e.g. onboarding checklist). */
  onDiagnosticsRun?: (report: SystemDiagnosticReport) => void;
}

function statusBadgeLabel(status: DiagnosticStatus, t: (key: string) => string): string {
  switch (status) {
    case "pass":
      return t("Passed");
    case "warn":
      return t("Warning");
    case "fail":
      return t("Failed");
    case "skipped":
      return t("Skipped");
  }
}

export function DiagnosticsBox({ onDiagnosticsRun }: DiagnosticsBoxProps) {
  const { t, language } = useTranslation();
  const id = useId();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const report = snapshot?.report;
  const [includeMcpProbe, setIncludeMcpProbe] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<"zip" | "json" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>({});
  const operation = useRef(false);
  const busy = running || exporting !== null;

  const handleRun = async () => {
    if (operation.current) return;
    operation.current = true;
    setRunning(true);
    setError(null);
    setExportNotice(null);
    try {
      const next = await runDiagnosticsCheck({ includeMcpProbe });
      setSnapshot(next);
      onDiagnosticsRun?.(next.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnostics run failed.");
    } finally {
      operation.current = false;
      setRunning(false);
    }
  };

  const handleExport = async (format: "zip" | "json") => {
    if (operation.current) return;
    operation.current = true;
    setExporting(format);
    setError(null);
    setExportNotice(null);
    try {
      const result = await exportDiagnosticsBundle({
        format,
        includeMcpProbe,
        includeLogs,
        reportId: snapshot?.reportId,
      });
      triggerBlobDownload(result.blob, result.fileName);
      setExportNotice(
        t("Exported {fileName} ({kb} KB).", {
          fileName: result.fileName,
          kb: Math.max(1, Math.round(result.bytes / 1024)),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnostics export failed.");
    } finally {
      operation.current = false;
      setExporting(null);
    }
  };

  const toggleCheck = (id: string) => {
    setExpandedChecks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="settings-card diagnostics-box" aria-labelledby={`${id}-heading`} data-diagnostics-box="true">
      <header>
        <AppIcon name="terminal" className="sm" />
        <h2 id={`${id}-heading`}>{t("One-click system diagnostics")}</h2>
        {report && (
          <span className={`chip diag-status-${report.overallStatus}`}>
            {statusBadgeLabel(report.overallStatus, t)}
          </span>
        )}
      </header>
      <div className="card-body">
        <div className="diag-controls diag-run-controls">
          <button
            type="button"
            className="btn primary"
            aria-disabled={busy || undefined}
            onClick={() => void handleRun()}
          >
            <AppIcon name="refresh" className="sm" />
            {running ? t("Running 6 checks…") : t("Run diagnostics")}
          </button>
          <label className="diag-option">
            <input
              type="checkbox"
              checked={includeMcpProbe}
              disabled={busy}
              onChange={(event) => setIncludeMcpProbe(event.target.checked)}
            />
            <span>{t("Include read-only MCP handshake (up to 8s)")}</span>
          </label>
        </div>

        <div className="sr-only" role="status">
          {running ? t("Running 6 checks…")
            : exporting ? t(exporting === "zip" ? "Exporting ZIP…" : "Exporting JSON…")
            : report && !error && !exportNotice ? t("Diagnostics complete.") : ""}
        </div>

        {error && (
          <div className="diag-alert fail" role="alert">
            <AppIcon name="alert" className="sm" />
            <span>{t(error)}</span>
          </div>
        )}
        {exportNotice && (
          <div className="diag-alert pass" role="status">
            <AppIcon name="check" className="sm" />
            <span>{exportNotice}</span>
          </div>
        )}

        {report && <div className="diag-summary-bar" data-diag-summary="true">
          <div className="diag-summary-counts">
            <span>{t("Passed: {count}", { count: report.summary.pass })}</span>
            <span className={report.summary.warn ? "diag-count-warn" : undefined}>{t("Warnings: {count}", { count: report.summary.warn })}</span>
            <span className={report.summary.fail ? "diag-count-fail" : undefined}>{t("Failed: {count}", { count: report.summary.fail })}</span>
            <span>{t("Skipped: {count}", { count: report.summary.skipped })}</span>
          </div>
          <div className="diag-summary-meta">
            <time dateTime={report.generatedAt}>
              {t("Last checked {time}", {
                time: new Date(report.generatedAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "medium" }),
              })}
            </time>
            <span className="diag-version-meta">v{report.appVersion}</span>
          </div>
        </div>}

        <div className="diag-export-area">
          <fieldset className="diag-export">
            <legend><AppIcon name="lock" className="sm" />{t("Redacted export")}</legend>
            <div className="diag-controls">
              <button type="button" className="btn" aria-label={t("Export redacted ZIP")} aria-disabled={busy || undefined} onClick={() => void handleExport("zip")}>
                <AppIcon name="import" className="sm" />
                {exporting === "zip" ? t("Exporting ZIP…") : "ZIP"}
              </button>
              <button type="button" className="btn" aria-label={t("Export redacted JSON")} aria-disabled={busy || undefined} onClick={() => void handleExport("json")}>
                <AppIcon name="import" className="sm" />
                {exporting === "json" ? t("Exporting JSON…") : "JSON"}
              </button>
            </div>
            <label className="diag-option">
              <input type="checkbox" checked={includeLogs} disabled={busy} onChange={(event) => setIncludeLogs(event.target.checked)} />
              <span>{t("Include redacted sidecar & panic log tails in ZIP (<= 2 MiB)")}</span>
            </label>
          </fieldset>
          <details className="diag-scope">
            <summary>{t("Checks and export privacy")}</summary>
            <p>{t("Verify WebView2 & OS, loopback ports, SQLite integrity, browser kernel SHA-256 hashes, disk space, and MCP readiness.")}</p>
            <p>{t("Strict redaction: exports never include profile records, passwords, cookies, proxy credentials, public IPs, CDP URLs, or local usernames.")}</p>
          </details>
        </div>

        {report && (
          <>
            <ul className="diag-check-list" role="list">
              {report.checks.map((check: DiagnosticCheckResult) => {
                const expanded = !!expandedChecks[check.id];
                const detailId = `${id}-${check.id}-details`;
                return (
                  <li
                    key={check.id}
                    className={`diag-check-item diag-item-${check.status}`}
                    data-diag-check={check.id}
                  >
                    <div className="diag-check-head">
                      <div className="diag-check-copy">
                        <strong>{t(check.title)}</strong>
                        <p>{check.summary}</p>
                      </div>
                      <div className="diag-check-meta">
                        <span className={`diag-pill diag-status-${check.status}`}>{statusBadgeLabel(check.status, t)}</span>
                        <span className="diag-duration">{check.durationMs} ms</span>
                        <button
                          type="button"
                          className="btn xs ghost"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailId : undefined}
                          onClick={() => toggleCheck(check.id)}
                        >
                          {expanded ? t("Hide details") : t("Details")}
                        </button>
                      </div>
                    </div>
                    {check.recommendations && check.recommendations.length > 0 && (
                      <ul className="diag-recs">
                        {check.recommendations.map((rec, idx) => (
                          <li key={idx}>{rec}</li>
                        ))}
                      </ul>
                    )}
                    {expanded && (
                      <pre id={detailId} className="diag-detail-pre" tabIndex={0} role="region" aria-label={t(check.title)}>
                        {JSON.stringify(check.details, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="diag-preview-box">
              <button
                type="button"
                className="diag-preview-toggle"
                aria-expanded={previewOpen}
                aria-controls={previewOpen ? `${id}-preview` : undefined}
                onClick={() => setPreviewOpen((open) => !open)}
              >
                <span>{t("Preview redacted JSON before export")}</span>
                <AppIcon name={previewOpen ? "chevronUp" : "chevronDown"} className="sm" />
              </button>
              {previewOpen && (
                <pre id={`${id}-preview`} className="diag-preview-pre" tabIndex={0} role="region" aria-label={t("Preview redacted JSON before export")} data-diag-json-preview="true">
                  {JSON.stringify(report, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
