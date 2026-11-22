import * as React from "react";
import { useState } from "react";
import {
  exportDiagnosticsBundle,
  runDiagnosticsCheck,
  triggerBlobDownload,
  type DiagnosticCheckResult,
  type DiagnosticStatus,
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
  const { t } = useTranslation();
  const [report, setReport] = useState<SystemDiagnosticReport | null>(null);
  const [includeMcpProbe, setIncludeMcpProbe] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<"zip" | "json" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>({});

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setExportNotice(null);
    try {
      const next = await runDiagnosticsCheck({ includeMcpProbe });
      setReport(next);
      onDiagnosticsRun?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Diagnostics run failed."));
    } finally {
      setRunning(false);
    }
  };

  const handleExport = async (format: "zip" | "json") => {
    setExporting(format);
    setError(null);
    setExportNotice(null);
    try {
      const result = await exportDiagnosticsBundle({
        format,
        includeMcpProbe,
        includeLogs,
      });
      triggerBlobDownload(result.blob, result.fileName);
      setExportNotice(
        t("Exported {fileName} ({kb} KB).", {
          fileName: result.fileName,
          kb: Math.max(1, Math.round(result.bytes / 1024)),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Diagnostics export failed."));
    } finally {
      setExporting(null);
    }
  };

  const toggleCheck = (id: string) => {
    setExpandedChecks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="settings-card diagnostics-box" data-diagnostics-box="true">
      <header>
        <AppIcon name="activity" className="sm" />
        <h2>{t("One-click system diagnostics")}</h2>
        {report && (
          <span className={`chip diag-status-${report.overallStatus}`}>
            {statusBadgeLabel(report.overallStatus, t)}
          </span>
        )}
      </header>
      <div className="card-body">
        <p className="diag-subtitle">
          {t(
            "Verify WebView2 & OS, loopback ports, SQLite integrity, browser kernel SHA-256 hashes, disk space, and MCP readiness.",
          )}
        </p>

        <div className="diag-privacy-banner">
          <AppIcon name="lock" className="sm" />
          <span>
            {t(
              "Strict redaction: exports never include profile records, passwords, cookies, proxy credentials, public IPs, CDP URLs, or local usernames.",
            )}
          </span>
        </div>

        <div className="diag-controls">
          <button
            type="button"
            className="btn primary"
            disabled={running || exporting !== null}
            onClick={() => void handleRun()}
          >
            <AppIcon name="refresh" className="sm" />
            {running ? t("Running 6 checks…") : t("Run diagnostics")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={running || exporting !== null}
            onClick={() => void handleExport("zip")}
          >
            <AppIcon name="export" className="sm" />
            {exporting === "zip" ? t("Exporting ZIP…") : t("Export redacted ZIP")}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={running || exporting !== null}
            onClick={() => void handleExport("json")}
          >
            {exporting === "json" ? t("Exporting JSON…") : t("Export redacted JSON")}
          </button>
        </div>

        <div className="diag-options">
          <label className="diag-option">
            <input
              type="checkbox"
              checked={includeMcpProbe}
              disabled={running || exporting !== null}
              onChange={(event) => setIncludeMcpProbe(event.target.checked)}
            />
            <span>{t("Include read-only MCP handshake (up to 8s)")}</span>
          </label>
          <label className="diag-option">
            <input
              type="checkbox"
              checked={includeLogs}
              disabled={running || exporting !== null}
              onChange={(event) => setIncludeLogs(event.target.checked)}
            />
            <span>{t("Include redacted sidecar & panic log tails in ZIP (<= 2 MiB)")}</span>
          </label>
        </div>

        {error && (
          <div className="diag-alert fail" role="alert">
            <AppIcon name="alert" className="sm" />
            <span>{error}</span>
          </div>
        )}
        {exportNotice && (
          <div className="diag-alert pass" role="status">
            <AppIcon name="check" className="sm" />
            <span>{exportNotice}</span>
          </div>
        )}

        {report && (
          <>
            <div className="diag-summary-bar" data-diag-summary="true">
              <span>{t("Passed: {count}", { count: report.summary.pass })}</span>
              <span>{t("Warnings: {count}", { count: report.summary.warn })}</span>
              <span>{t("Failed: {count}", { count: report.summary.fail })}</span>
              <span>{t("Skipped: {count}", { count: report.summary.skipped })}</span>
              <span className="diag-version-meta">v{report.appVersion}</span>
            </div>

            <ul className="diag-check-list" role="list">
              {report.checks.map((check: DiagnosticCheckResult) => {
                const expanded = !!expandedChecks[check.id];
                return (
                  <li
                    key={check.id}
                    className={`diag-check-item diag-item-${check.status}`}
                    data-diag-check={check.id}
                  >
                    <div className="diag-check-head">
                      <span className={`diag-pill diag-status-${check.status}`}>
                        {statusBadgeLabel(check.status, t)}
                      </span>
                      <div className="diag-check-copy">
                        <strong>{t(check.title)}</strong>
                        <p>{check.summary}</p>
                      </div>
                      <span className="diag-duration">{check.durationMs}ms</span>
                      <button
                        type="button"
                        className="btn xs ghost"
                        aria-expanded={expanded}
                        onClick={() => toggleCheck(check.id)}
                      >
                        {expanded ? t("Hide details") : t("Details")}
                      </button>
                    </div>
                    {check.recommendations && check.recommendations.length > 0 && (
                      <ul className="diag-recs">
                        {check.recommendations.map((rec, idx) => (
                          <li key={idx}>{rec}</li>
                        ))}
                      </ul>
                    )}
                    {expanded && (
                      <pre className="diag-detail-pre">
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
                onClick={() => setPreviewOpen((open) => !open)}
              >
                <span>{t("Preview redacted JSON before export")}</span>
                <AppIcon name={previewOpen ? "chevronUp" : "chevronDown"} className="sm" />
              </button>
              {previewOpen && (
                <pre className="diag-preview-pre" data-diag-json-preview="true">
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
