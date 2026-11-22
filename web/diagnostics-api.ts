import { invoke, isTauri } from "@tauri-apps/api/core";
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
} = {}): Promise<SystemDiagnosticReport> {
  const desktopProbe =
    options.desktopProbe !== undefined ? options.desktopProbe : await probeDesktopSystemDiagnostics();
  const response = await fetch("/ui/api/diagnostics/run", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "X-Maobu-Settings": "1",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      includeMcpProbe: options.includeMcpProbe === true,
      ...(desktopProbe ? { desktopProbe } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!isObject(body)) {
    throw new Error("The local service returned an invalid diagnostics response.");
  }
  if (!response.ok || body.ok !== true || !isObject(body.report) || !Array.isArray(body.report.checks)) {
    throw new Error(typeof body.error === "string" ? body.error : "Diagnostics run failed.");
  }
  return body.report as unknown as SystemDiagnosticReport;
}

function parseFilenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="([^"]+)"/i.exec(header);
  return match?.[1] ? match[1] : fallback;
}

export async function exportDiagnosticsBundle(options: {
  format?: "zip" | "json";
  includeMcpProbe?: boolean;
  includeLogs?: boolean;
  desktopProbe?: ClientDesktopProbeInput | null;
  signal?: AbortSignal;
} = {}): Promise<ExportDiagnosticsResult> {
  const format = options.format ?? "zip";
  const desktopProbe =
    options.desktopProbe !== undefined ? options.desktopProbe : await probeDesktopSystemDiagnostics();
  const response = await fetch("/ui/api/diagnostics/export", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "X-Maobu-Settings": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      format,
      includeMcpProbe: options.includeMcpProbe === true,
      includeLogs: options.includeLogs !== false,
      ...(desktopProbe ? { desktopProbe } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
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
