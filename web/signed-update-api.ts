import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export interface SignedUpdateStatus {
  configured: boolean;
  status: "disabled" | "idle" | "checking" | "available" | "up-to-date" | "downloading" | "installing" | "error";
  currentVersion: string; endpoint: string | null; message: string;
  update: { version: string; currentVersion: string; notes: string; publishedAt: string | null } | null;
}
export interface SignedUpdateProgress {
  phase: "downloading" | "verifying" | "closing" | "installing" | "complete";
  downloadedBytes: number; totalBytes: number | null;
}
export function desktopUpdaterAvailable(): boolean {
  try { return isTauri(); } catch { return false; }
}
export async function fetchSignedUpdateStatus(): Promise<SignedUpdateStatus> {
  if (!desktopUpdaterAvailable()) return {
    configured: false, status: "disabled", currentVersion: "", endpoint: null, update: null,
    message: "Open the desktop app to use the signed update channel.",
  };
  return invoke<SignedUpdateStatus>("signed_update_status");
}
export async function checkSignedUpdate(options: { startup?: boolean } = {}): Promise<SignedUpdateStatus> {
  if (!desktopUpdaterAvailable()) throw new Error("Open the desktop app to use the signed update channel.");
  return invoke<SignedUpdateStatus>("signed_update_check", options.startup ? { startup: true } : undefined);
}
export async function installSignedUpdate(expectedVersion: string, progress: (event: SignedUpdateProgress) => void): Promise<void> {
  if (!desktopUpdaterAvailable()) throw new Error("Open the desktop app to use the signed update channel.");
  const channel = new Channel<SignedUpdateProgress>();
  channel.onmessage = progress;
  await invoke("signed_update_install", { expectedVersion, onProgress: channel });
}
