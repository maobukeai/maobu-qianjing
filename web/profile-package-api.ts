/** Typed client for encrypted `.mqprofile` package export, preview, and import endpoints. */
import type {
  ProfilePackageConflictStrategy,
  ProfilePackageImportResult,
  ProfilePackagePreview,
} from "../profile-package.ts";
import { getStandaloneSessionToken, notifyAppLockedFromResponse, notifyUnauthorizedResponse } from "./api.ts";

export type {
  ProfilePackageConflictReason,
  ProfilePackageConflictStrategy,
  ProfilePackageImportItemResult,
  ProfilePackageImportResult,
  ProfilePackagePreview,
  ProfilePackagePreviewItem,
} from "../profile-package.ts";

export interface ProfilePackageExportInput {
  ids: string[];
  password: string;
  includeSecrets?: boolean;
  includeSessions?: boolean;
}

export interface ProfilePackageExportProgress {
  completed: number;
  total: number;
}

export interface ProfilePackageExportSummary {
  fileName: string;
  bytes: number;
  profileCount: number;
}

export interface ProfilePackageImportInput {
  previewId: string;
  previewToken: string;
  strategy: ProfilePackageConflictStrategy;
  selectedIds?: string[];
  confirmOverwrite?: boolean;
}

export class ProfilePackageImportError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ProfilePackageImportError";
  }
}

export function isMqProfileFile(file: Pick<File, "name">): boolean {
  return typeof file.name === "string" && file.name.trim().toLowerCase().endsWith(".mqprofile");
}

function packageFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getStandaloneSessionToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("X-Maobu-Session") && !headers.has("Authorization")) {
    headers.set("X-Maobu-Session", token);
  }
  return fetch(path, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers,
  });
}

async function readJsonResponse(response: Response, path: string): Promise<any> {
  const text = await response.text();
  let parsed: any;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    notifyUnauthorizedResponse(response.status, path);
    throw new Error(`API ${path} returned non-JSON (${response.status}).`);
  }
  if (response.status === 401) {
    notifyUnauthorizedResponse(401, path, typeof parsed?.error === "string" ? parsed.error : "");
  } else if (response.status === 423) {
    notifyAppLockedFromResponse(423, parsed);
  }
  return parsed;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Export selected environments into an encrypted `.mqprofile` package and download it.
 * Uses NDJSON progress streaming so open browsers can capture sessions transparently.
 */
export async function exportProfilePackage(
  input: ProfilePackageExportInput,
  onProgress?: (progress: ProfilePackageExportProgress) => void,
): Promise<ProfilePackageExportSummary> {
  const path = "/ui/api/profiles/package/export";
  const response = await packageFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: input.ids,
      password: input.password,
      includeSecrets: input.includeSecrets !== false,
      includeSessions: input.includeSessions !== false,
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await readJsonResponse(response, path);
    throw new Error(typeof body?.error === "string" ? body.error : "Encrypted package export failed.");
  }

  let fileBlob: Blob | undefined;
  let fileName = "maobu-profiles.mqprofile";
  let profileCount = input.ids.length;
  let byteCount = 0;

  if (response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) {
            const record = JSON.parse(line);
            if (record.type === "error") {
              throw new Error(typeof record.error === "string" ? record.error : "Encrypted package export failed.");
            }
            if (record.type === "progress") {
              onProgress?.({ completed: Number(record.completed) || 0, total: Number(record.total) || input.ids.length });
            }
            if (record.type === "file" && typeof record.data === "string") {
              const raw = Uint8Array.from(atob(record.data), (char) => char.charCodeAt(0));
              fileBlob = new Blob([raw], { type: record.mime || "application/octet-stream" });
              if (typeof record.fileName === "string" && record.fileName.endsWith(".mqprofile")) {
                fileName = record.fileName;
              }
              profileCount = Number(record.profileCount) || input.ids.length;
              byteCount = raw.byteLength;
            }
          }
          newline = pending.indexOf("\n");
        }
      }
      if (!fileBlob || pending.trim()) {
        throw new Error("Export interrupted before the encrypted package finished.");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    fileBlob = await response.blob();
    byteCount = fileBlob.size;
  }

  triggerBlobDownload(fileBlob, fileName);
  return { fileName, bytes: byteCount, profileCount };
}

/** Upload and decrypt a `.mqprofile` package to receive a redacted conflict preview. */
export async function previewProfilePackage(file: File, password: string): Promise<ProfilePackagePreview> {
  const path = "/ui/api/profiles/package/preview";
  const form = new FormData();
  form.append("file", file);
  form.append("password", password);
  const response = await packageFetch(path, { method: "POST", body: form });
  const body = await readJsonResponse(response, path);
  if (!response.ok || body?.ok !== true || !body.preview) {
    throw new Error(typeof body?.error === "string" ? body.error : "Unable to decrypt profile package.");
  }
  return body.preview as ProfilePackagePreview;
}

/** Commit an already-previewed `.mqprofile` package atomically using the chosen conflict strategy. */
export async function importProfilePackage(
  input: ProfilePackageImportInput,
): Promise<ProfilePackageImportResult> {
  const path = "/ui/api/profiles/package/import";
  const response = await packageFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readJsonResponse(response, path);
  if (!response.ok || body?.ok !== true || !body.result) {
    throw new ProfilePackageImportError(
      typeof body?.error === "string" ? body.error : "Unable to import profile package.",
      typeof body?.code === "string" ? body.code : undefined,
    );
  }
  return body.result as ProfilePackageImportResult;
}
