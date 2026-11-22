/** Typed client for local RPA Studio routes (`/ui/api/scripts/*`). */
import type {
  RpaCodegenOptions,
  RpaCodegenResult,
  RpaRecordedStep,
  RpaRecorderStatus,
  RpaTemplate,
} from "../contracts/local.ts";
import type { ScriptRun } from "../scripts.ts";
import { getStandaloneSessionToken } from "./api.ts";

type ScriptInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

async function resolveScriptCapability(): Promise<string> {
  const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: ScriptInvoke } }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    throw new Error("Scripts require the desktop app.");
  }
  const capability = await invoke("script_capability");
  if (typeof capability !== "string" || !capability) {
    throw new Error("Scripts are unavailable in this desktop app.");
  }
  return capability;
}

async function rpaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const capability = await resolveScriptCapability();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${capability}`);
  const standalone = getStandaloneSessionToken();
  if (standalone && !headers.has("X-Maobu-Session")) {
    headers.set("X-Maobu-Session", standalone);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, {
    ...init,
    credentials: init.credentials ?? "same-origin",
    cache: "no-store",
    redirect: "error",
    headers,
  });
}

async function rpaJson(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await rpaFetch(path, init);
  let body: unknown;
  try {
    const text = await response.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`RPA Studio API ${path} returned non-JSON (${response.status}).`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("RPA Studio returned invalid data.");
  }
  const record = body as Record<string, unknown>;
  if (!response.ok || record.ok !== true) {
    throw new Error(typeof record.error === "string" && record.error ? record.error : "RPA Studio request failed");
  }
  return record;
}

export async function fetchRpaTemplates(): Promise<RpaTemplate[]> {
  const body = await rpaJson("/ui/api/scripts/templates");
  if (!Array.isArray(body.templates)) {
    throw new Error("RPA templates returned invalid data");
  }
  return body.templates as RpaTemplate[];
}

export async function fetchScriptRuns(): Promise<ScriptRun[]> {
  const body = await rpaJson("/ui/api/scripts/runs");
  if (!Array.isArray(body.runs)) {
    throw new Error("Script runs returned invalid data");
  }
  return body.runs as ScriptRun[];
}

export async function startQueuedScriptRun(input: {
  scriptId: string;
  profileIds: string[];
  inputs: Record<string, unknown>;
  useCredentials: boolean;
  concurrency?: number;
  queueIfBusy?: boolean;
}): Promise<ScriptRun> {
  const body = await rpaJson("/ui/api/scripts/run", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.run as ScriptRun;
}

export async function stopScriptRunById(runId: string): Promise<ScriptRun> {
  const body = await rpaJson(`/ui/api/scripts/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    body: "{}",
  });
  return body.run as ScriptRun;
}

/**
 * Fetches a run screenshot artifact with Bearer auth headers and returns a Blob
 * for rendering via `URL.createObjectURL` (strictly compatible with `img-src 'self' data: blob:`).
 */
export async function fetchScriptArtifactBlob(
  runId: string,
  profileId: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const path = `/ui/api/scripts/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(profileId)}/${encodeURIComponent(fileName)}`;
  const response = await rpaFetch(path, {
    method: "GET",
    headers: { Accept: "image/jpeg, image/png" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Artifact request failed (${response.status})`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("image/jpeg") && !contentType.startsWith("image/png")) {
    throw new Error("Unexpected artifact content type");
  }
  return await response.blob();
}

export async function fetchRpaRecorderStatus(): Promise<RpaRecorderStatus> {
  const body = await rpaJson("/ui/api/scripts/recorder/status");
  if (!body.recorder || typeof body.recorder !== "object") {
    throw new Error("Recorder status returned invalid data");
  }
  return body.recorder as RpaRecorderStatus;
}

export async function startRpaRecorder(input: {
  profileId: string;
  startupUrl?: string;
}): Promise<RpaRecorderStatus> {
  const body = await rpaJson("/ui/api/scripts/recorder/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.recorder as RpaRecorderStatus;
}

export async function stopRpaRecorder(input: { closeBrowser?: boolean } = {}): Promise<RpaRecorderStatus> {
  const body = await rpaJson("/ui/api/scripts/recorder/stop", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.recorder as RpaRecorderStatus;
}

export async function generateRpaCode(input: {
  steps?: RpaRecordedStep[];
  options?: RpaCodegenOptions;
}): Promise<RpaCodegenResult> {
  const body = await rpaJson("/ui/api/scripts/recorder/codegen", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return {
    language: "javascript",
    source: String(body.source ?? ""),
    suggestedInputs: (body.suggestedInputs && typeof body.suggestedInputs === "object"
      ? body.suggestedInputs
      : {}) as Record<string, unknown>,
    usesCredentials: body.usesCredentials === true,
    stepCount: Number(body.stepCount ?? 0),
  };
}
