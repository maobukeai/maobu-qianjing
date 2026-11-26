import { invoke, isTauri } from "@tauri-apps/api/core";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
import type {
  ClientDesktopProbeInput,
  DiagnosticCheckId,
  DiagnosticCheckResult,
  DiagnosticStatus,
  SystemDiagnosticReport,
} from "../system-diagnostics.ts";

export type {
  ClientDesktopProbeInput,
  DiagnosticCheckId,
  DiagnosticCheckResult,
  DiagnosticStatus,
  SystemDiagnosticReport,
};

export interface ExportDiagnosticsResult {
  blob: Blob;
  fileName: string;
  sha256: string | null;
  bytes: number;
  format: "zip" | "json";
}

export interface DiagnosticsSnapshot {
  report: SystemDiagnosticReport;
  reportId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Safely invoke the Tauri desktop `system_diagnostic_probe` command when running inside the desktop shell. */
export async function probeDesktopSystemDiagnostics(): Promise<ClientDesktopProbeInput | null> {
  let inDesktop = false;
  try {
    inDesktop = isTauri();
  } catch {
    inDesktop = false;
  }
  if (!inDesktop) return null;
  try {
    const result = await invoke<ClientDesktopProbeInput>("system_diagnostic_probe");
    return isObject(result) ? result : null;
  } catch {
    return null;
  }
}

export async function runDiagnosticsCheck(options: {
  includeMcpProbe?: boolean;
  desktopProbe?: ClientDesktopProbeInput | null;
  signal?: AbortSignal;
} = {}): Promise<DiagnosticsSnapshot> {
  const desktopProbe =
    options.desktopProbe !== undefined ? options.desktopProbe : await probeDesktopSystemDiagnostics();
  const response = await fetch("/ui/api/diagnostics/run", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: withStandaloneAuthHeaders({
      "X-Maobu-Settings": "1",
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify({
      includeMcpProbe: options.includeMcpProbe === true,
      ...(desktopProbe ? { desktopProbe } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, "/ui/api/diagnostics/run", isObject(body) && typeof body.error === "string" ? body.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, body);
  }
  if (!isObject(body)) {
    throw new Error("The local service returned an invalid diagnostics response.");
  }
  if (!response.ok || body.ok !== true || typeof body.reportId !== "string" || !body.reportId
    || !isObject(body.report) || !Array.isArray(body.report.checks)
    || typeof body.report.generatedAt !== "string" || !Number.isFinite(Date.parse(body.report.generatedAt))) {
    throw new Error(typeof body.error === "string" ? body.error : "Diagnostics run failed.");
  }
  return { report: body.report as unknown as SystemDiagnosticReport, reportId: body.reportId };
}

function parseFilenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="([^"]+)"/i.exec(header);
  return match?.[1] ? match[1] : fallback;
}

export async function exportDiagnosticsBundle(options: {
  format?: "zip" | "json";
  reportId?: string;
  includeMcpProbe?: boolean;
  includeLogs?: boolean;
  desktopProbe?: ClientDesktopProbeInput | null;
  signal?: AbortSignal;
} = {}): Promise<ExportDiagnosticsResult> {
  const format = options.format ?? "zip";
  const payload: Record<string, unknown> = { format, includeLogs: options.includeLogs !== false };
  if (options.reportId === undefined) {
    const desktopProbe =
      options.desktopProbe !== undefined ? options.desktopProbe : await probeDesktopSystemDiagnostics();
    payload.includeMcpProbe = options.includeMcpProbe === true;
    if (desktopProbe) payload.desktopProbe = desktopProbe;
  } else {
    payload.reportId = options.reportId;
  }
  const response = await fetch("/ui/api/diagnostics/export", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: withStandaloneAuthHeaders({
      "X-Maobu-Settings": "1",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(payload),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      notifyUnauthorizedResponse(401, "/ui/api/diagnostics/export", isObject(body) && typeof body.error === "string" ? body.error : "");
    } else if (response.status === 423) {
      notifyAppLockedFromResponse(423, body);
    }
    const message = isObject(body) && typeof body.error === "string"
      ? body.error
      : "Diagnostics export failed.";
    throw new Error(message);
  }
  const blob = await response.blob();
  const fallbackName = format === "zip" ? "maobu-diagnostics.zip" : "maobu-diagnostics.json";
  const fileName = parseFilenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
  const sha256 = response.headers.get("X-Diagnostics-SHA256");
  return {
    blob,
    fileName,
    sha256,
    bytes: blob.size,
    format,
  };
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  anchor.referrerPolicy = "no-referrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
