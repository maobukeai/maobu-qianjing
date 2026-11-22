import { createHash } from "node:crypto";
import type { Launcher } from "../../launcher.ts";
import type { ProfileStore } from "../../store.ts";
import {
  createDiagnosticZip,
  runSystemDiagnostics,
  type ClientDesktopProbeInput,
  type SystemDiagnosticsOptions,
} from "../../system-diagnostics.ts";
import { noStoreJson, rejectUntrustedJsonMutation, type UiRuntimeOptions } from "./shared.ts";

const DIAGNOSTICS_PREFIX = "/ui/api/diagnostics";
const MAX_JSON_BYTES = 32 * 1024;

export interface DiagnosticsRouteOptions extends UiRuntimeOptions {
  workspaceHome?: string;
  automationPort?: number;
  probeTcpPort?: SystemDiagnosticsOptions["probeTcpPort"];
  getIntegration?: SystemDiagnosticsOptions["getIntegration"];
  probeMcp?: SystemDiagnosticsOptions["probeMcp"];
  resolvePlaywright?: SystemDiagnosticsOptions["resolvePlaywright"];
  now?: () => Date;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function guardDiagnosticsRequest(req: Request): Response | null {
  const url = new URL(req.url);
  if (!isLoopbackHost(url.hostname)) {
    return noStoreJson({ ok: false, error: "Only same-origin local requests are allowed" }, 403);
  }
  if (req.headers.get("X-Maobu-Settings") !== "1") {
    return noStoreJson({ ok: false, error: "Local settings request header is required" }, 403);
  }
  if (req.method !== "POST") {
    return noStoreJson({ ok: false, error: "Method not allowed" }, 405);
  }
  const rejected = rejectUntrustedJsonMutation(req);
  if (rejected) {
    rejected.headers.set("Cache-Control", "no-store");
    return rejected;
  }
  return null;
}

async function readDiagnosticsBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw Object.assign(new Error("Diagnostics request is too large"), { status: 413 });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw Object.assign(new Error("Diagnostics request is too large"), { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON diagnostics request"), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function parseDesktopProbe(value: unknown): ClientDesktopProbeInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Invalid desktop probe metadata"), { status: 400 });
  }
  return value as ClientDesktopProbeInput;
}

/**
 * UI API routes for the one-click system diagnostics box:
 * - `POST /ui/api/diagnostics/run`
 * - `POST /ui/api/diagnostics/export` (`format: "zip" | "json"`)
 */
export async function handleDiagnosticsRoutes(
  req: Request,
  pathname: string,
  launcher: Launcher,
  store: ProfileStore,
  options: DiagnosticsRouteOptions,
): Promise<Response | null> {
  if (pathname !== DIAGNOSTICS_PREFIX && !pathname.startsWith(`${DIAGNOSTICS_PREFIX}/`)) {
    return null;
  }
  if (pathname !== `${DIAGNOSTICS_PREFIX}/run` && pathname !== `${DIAGNOSTICS_PREFIX}/export`) {
    return noStoreJson({ ok: false, error: "Unknown diagnostics operation" }, 404);
  }

  const denied = guardDiagnosticsRequest(req);
  if (denied) return denied;

  try {
    const body = await readDiagnosticsBody(req);
    const reqUrl = new URL(req.url);
    const parsedPort = reqUrl.port ? Number(reqUrl.port) : null;
    const includeMcpProbe = body.includeMcpProbe === true;
    const desktopProbe = parseDesktopProbe(body.desktopProbe);
    const now = options.now ?? (() => new Date());

    const diagnosticOptions: SystemDiagnosticsOptions = {
      store,
      launcher,
      paths: options.paths,
      workspaceHome: options.workspaceHome ?? options.workspaceManagement?.options.home,
      runtimeInventory: options.runtimeInventory,
      desktopAvailable: !!options.health,
      dashboardPort: parsedPort && Number.isInteger(parsedPort) ? parsedPort : null,
      automationPort: options.automationPort,
      includeMcpProbe,
      desktopProbe,
      probeTcpPort: options.probeTcpPort,
      getIntegration: options.getIntegration,
      probeMcp: options.probeMcp,
      resolvePlaywright: options.resolvePlaywright,
      now,
    };

    if (pathname === `${DIAGNOSTICS_PREFIX}/run`) {
      const allowed = new Set(["includeMcpProbe", "desktopProbe"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        return noStoreJson({ ok: false, error: "Unexpected fields in diagnostics run request" }, 400);
      }
      const report = await runSystemDiagnostics(diagnosticOptions);
      return noStoreJson({ ok: true, report });
    }

    const allowed = new Set(["format", "includeMcpProbe", "includeLogs", "desktopProbe"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return noStoreJson({ ok: false, error: "Unexpected fields in diagnostics export request" }, 400);
    }
    const format = body.format === undefined ? "zip" : body.format;
    if (format !== "zip" && format !== "json") {
      return noStoreJson({ ok: false, error: "Diagnostics export format must be zip or json" }, 400);
    }

    const stamp = formatFileTimestamp(now());
    if (format === "json") {
      const report = await runSystemDiagnostics(diagnosticOptions);
      const jsonText = `${JSON.stringify(report, null, 2)}\n`;
      const sha256 = createHash("sha256").update(jsonText, "utf8").digest("hex");
      const fileName = `maobu-diagnostics-${stamp}.json`;
      return new Response(jsonText, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Length": String(Buffer.byteLength(jsonText, "utf8")),
          "X-Diagnostics-SHA256": sha256,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const bundle = await createDiagnosticZip({
      ...diagnosticOptions,
      includeLogs: body.includeLogs !== false,
    });
    const fileName = `maobu-diagnostics-${stamp}.zip`;
    return new Response(Buffer.from(bundle.zipBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(bundle.zipBytes.byteLength),
        "X-Diagnostics-SHA256": bundle.sha256,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 400;
    const message = error instanceof Error ? error.message : "Diagnostics request failed";
    return noStoreJson({ ok: false, error: message }, status);
  }
}
