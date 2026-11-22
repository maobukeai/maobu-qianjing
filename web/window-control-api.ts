/** Typed Tauri IPC bridge for Win32 multi-window layout, safe window synchronizer, and native memory trim. */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hasWindowBackdropHost } from "./window-chrome.tsx";

export interface RectPx {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MonitorInfo {
  id: string;
  name: string;
  isPrimary: boolean;
  bounds: RectPx;
  workArea: RectPx;
  dpi: number;
  scalePercent: number;
}

export interface ManagedWindowInfo {
  profileId: string;
  name: string;
  displayNo: string;
  engine: "chromium" | "firefox" | string;
  pid: number;
  windowPid: number;
  hwndHex: string;
  title: string;
  className: string;
  rect: RectPx;
  clientRect: RectPx;
  isMinimized: boolean;
  isMaximized: boolean;
  isTopmost: boolean;
  monitorId: string;
  dpi: number;
  windowCount: number;
}

export type WindowArrangeMode = "grid" | "custom_grid" | "cascade" | "master_detail" | "gather";
export type WindowGatherAction = "minimize" | "restore" | "stack_center";

export interface ArrangeRequest {
  mode: WindowArrangeMode;
  profileIds?: string[];
  monitor?: "primary" | "active" | "all" | string;
  cols?: number;
  rows?: number;
  gapPx?: number;
  paddingPx?: number;
  cascadeOffsetPx?: number;
  masterProfileId?: string;
  masterRatio?: number;
  gatherAction?: WindowGatherAction;
  restoreMinimized?: boolean;
}

export interface ArrangedWindowEntry {
  profileId: string;
  hwndHex: string;
  monitorId: string;
  rect: RectPx;
}

export interface ArrangeResult {
  ok: boolean;
  mode: WindowArrangeMode | string;
  arranged: ArrangedWindowEntry[];
  skipped: string[];
}

export type WindowActionKind =
  | "focus"
  | "minimize"
  | "restore"
  | "topmost"
  | "untopmost"
  | "close_notice";

export interface WindowActionRequest {
  action: WindowActionKind;
  profileIds: string[];
}

export interface WindowActionResult {
  ok: boolean;
  action: WindowActionKind | string;
  affected: string[];
  missing: string[];
  failed: Array<{ profileId: string; reason: string }>;
}

export interface SyncStartConfig {
  masterProfileId: string;
  slaveProfileIds: string[];
  syncMouseClick?: boolean;
  syncMouseMove?: boolean;
  syncScroll?: boolean;
  syncKeyboard?: boolean;
  jitterMinMs?: number;
  jitterMaxMs?: number;
  clickPosJitterPx?: number;
}

export type TextInjectMode = "per_line_ordered" | "per_profile_map" | "template";

export interface TextInjectRequest {
  mode: TextInjectMode;
  targetProfileIds?: string[];
  includeMaster?: boolean;
  lines?: string[];
  profileTexts?: Record<string, string>;
  template?: string;
  charDelayMinMs?: number;
  charDelayMaxMs?: number;
  pressEnter?: boolean;
}

export interface TextInjectResult {
  ok: boolean;
  jobId: string;
  queuedProfiles: string[];
  skippedProfiles: string[];
}

export interface SyncStatusSnapshot {
  supported: boolean;
  active: boolean;
  paused: boolean;
  pausedByUser: boolean;
  pausedByFocus: boolean;
  masterProfileId: string | null;
  slaveProfileIds: string[];
  droppedSlaveProfileIds: string[];
  syncMouseClick: boolean;
  syncMouseMove: boolean;
  syncScroll: boolean;
  syncKeyboard: boolean;
  jitterMinMs: number;
  jitterMaxMs: number;
  clickPosJitterPx: number;
  emergencyHotkey: string;
  activeInjectionJobs: number;
  forwardedEvents: number;
  lastStopReason: string | null;
  updatedAtMs: number;
}

export interface NativeTrimMemoryResult {
  profileId: string;
  ok: boolean;
  processCount: number;
  trimmedCount: number;
  beforeRssBytes: number;
  afterRssBytes: number;
  freedBytes: number;
  error: string | null;
}

export const IDLE_SYNC_STATUS: SyncStatusSnapshot = {
  supported: false,
  active: false,
  paused: false,
  pausedByUser: false,
  pausedByFocus: false,
  masterProfileId: null,
  slaveProfileIds: [],
  droppedSlaveProfileIds: [],
  syncMouseClick: true,
  syncMouseMove: false,
  syncScroll: true,
  syncKeyboard: true,
  jitterMinMs: 15,
  jitterMaxMs: 85,
  clickPosJitterPx: 2,
  emergencyHotkey: "Ctrl+Shift+F12",
  activeInjectionJobs: 0,
  forwardedEvents: 0,
  lastStopReason: null,
  updatedAtMs: 0,
};

type TauriInternalsLike = {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback?: unknown;
};

function getTauriInternals(candidate?: unknown): TauriInternalsLike | null {
  const host = candidate !== undefined ? candidate : typeof window !== "undefined" ? window : undefined;
  if (!host || typeof host !== "object") return null;
  const internals = (host as { __TAURI_INTERNALS__?: TauriInternalsLike }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return null;
  return internals;
}

/** True when running inside a Tauri desktop host exposing `invoke`. */
export function isWindowControlDesktopAvailable(candidate?: unknown): boolean {
  return getTauriInternals(candidate) !== null;
}

/**
 * True when passive background Tauri event subscription is safe (avoids invoking
 * `plugin:event|listen` inside minimal DOM test fixtures that only stub `{ invoke }`).
 */
export function hasNativeSyncEventHost(candidate?: unknown): boolean {
  const internals = getTauriInternals(candidate);
  if (!internals) return false;
  return hasWindowBackdropHost(candidate) || typeof internals.transformCallback === "function";
}

export class WindowControlError extends Error {
  readonly unsupported: boolean;
  constructor(message: string, unsupported = false) {
    super(message);
    this.name = "WindowControlError";
    this.unsupported = unsupported;
  }
}

async function invokeWindowControl<T>(
  command: string,
  args?: Record<string, unknown>,
  candidate?: unknown,
): Promise<T> {
  const internals = getTauriInternals(candidate);
  if (!internals?.invoke) {
    throw new WindowControlError("Window controls require the Windows desktop app.", true);
  }
  try {
    return (await internals.invoke(command, args)) as T;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const unsupported = raw.includes("unsupported_platform") || raw.includes("not supported");
    const cleaned = raw.replace(/^unsupported_platform:\s*/i, "").trim();
    throw new WindowControlError(
      cleaned || (unsupported
        ? "Multi-window layout and synchronizer are only supported on Windows."
        : "Window command failed."),
      unsupported,
    );
  }
}

export function normalizeSyncStatus(raw: unknown): SyncStatusSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...IDLE_SYNC_STATUS };
  }
  const r = raw as Record<string, unknown>;
  const strList = (val: unknown): string[] =>
    Array.isArray(val) ? val.filter((item): item is string => typeof item === "string") : [];
  const num = (val: unknown, fallback: number): number =>
    typeof val === "number" && Number.isFinite(val) ? val : fallback;
  return {
    supported: r.supported === true,
    active: r.active === true,
    paused: r.paused === true,
    pausedByUser: r.pausedByUser === true,
    pausedByFocus: r.pausedByFocus === true,
    masterProfileId: typeof r.masterProfileId === "string" && r.masterProfileId ? r.masterProfileId : null,
    slaveProfileIds: strList(r.slaveProfileIds),
    droppedSlaveProfileIds: strList(r.droppedSlaveProfileIds),
    syncMouseClick: r.syncMouseClick !== false,
    syncMouseMove: r.syncMouseMove === true,
    syncScroll: r.syncScroll !== false,
    syncKeyboard: r.syncKeyboard !== false,
    jitterMinMs: num(r.jitterMinMs, 15),
    jitterMaxMs: num(r.jitterMaxMs, 85),
    clickPosJitterPx: num(r.clickPosJitterPx, 2),
    emergencyHotkey:
      typeof r.emergencyHotkey === "string" && r.emergencyHotkey.trim()
        ? r.emergencyHotkey
        : "Ctrl+Shift+F12",
    activeInjectionJobs: num(r.activeInjectionJobs, 0),
    forwardedEvents: num(r.forwardedEvents, 0),
    lastStopReason: typeof r.lastStopReason === "string" && r.lastStopReason ? r.lastStopReason : null,
    updatedAtMs: num(r.updatedAtMs, 0),
  };
}

export function rectDimensions(rect: RectPx): { width: number; height: number } {
  return {
    width: Math.max(0, Math.round(rect.right - rect.left)),
    height: Math.max(0, Math.round(rect.bottom - rect.top)),
  };
}

/** Preview safe text template variables (`{{index}}`, `{{name}}`, `{{customNo}}`) without touching secrets. */
export function renderSafeTextTemplate(
  template: string,
  target: { name: string; customNo?: string; displayNo?: string },
  oneBasedIndex: number,
): string {
  const custom = (target.customNo ?? target.displayNo ?? "").trim();
  return template
    .replaceAll("{{index}}", String(oneBasedIndex))
    .replaceAll("{{name}}", target.name)
    .replaceAll("{{customNo}}", custom);
}

export async function listMonitors(candidate?: unknown): Promise<MonitorInfo[]> {
  const result = await invokeWindowControl<unknown>("window_list_monitors", undefined, candidate);
  return Array.isArray(result) ? (result as MonitorInfo[]) : [];
}

export async function listManagedWindows(candidate?: unknown): Promise<ManagedWindowInfo[]> {
  const result = await invokeWindowControl<unknown>("window_list_managed", undefined, candidate);
  return Array.isArray(result) ? (result as ManagedWindowInfo[]) : [];
}

export async function arrangeWindows(
  req: ArrangeRequest,
  candidate?: unknown,
): Promise<ArrangeResult> {
  return invokeWindowControl<ArrangeResult>("window_arrange", { req }, candidate);
}

export async function runWindowAction(
  req: WindowActionRequest,
  candidate?: unknown,
): Promise<WindowActionResult> {
  return invokeWindowControl<WindowActionResult>("window_action", { req }, candidate);
}

export async function startWindowSync(
  config: SyncStartConfig,
  candidate?: unknown,
): Promise<SyncStatusSnapshot> {
  const res = await invokeWindowControl<unknown>("sync_start", { config }, candidate);
  return normalizeSyncStatus(res);
}

export async function stopWindowSync(candidate?: unknown): Promise<SyncStatusSnapshot> {
  const res = await invokeWindowControl<unknown>("sync_stop", undefined, candidate);
  return normalizeSyncStatus(res);
}

export async function pauseWindowSync(
  paused: boolean,
  candidate?: unknown,
): Promise<SyncStatusSnapshot> {
  const res = await invokeWindowControl<unknown>("sync_pause", { paused }, candidate);
  return normalizeSyncStatus(res);
}

export async function updateSyncSlaves(
  profileIds: string[],
  candidate?: unknown,
): Promise<SyncStatusSnapshot> {
  const res = await invokeWindowControl<unknown>("sync_update_slaves", { profileIds }, candidate);
  return normalizeSyncStatus(res);
}

export async function injectSyncTexts(
  req: TextInjectRequest,
  candidate?: unknown,
): Promise<TextInjectResult> {
  return invokeWindowControl<TextInjectResult>("sync_inject_texts", { req }, candidate);
}

export async function fetchSyncStatus(candidate?: unknown): Promise<SyncStatusSnapshot> {
  const res = await invokeWindowControl<unknown>("sync_status", undefined, candidate);
  return normalizeSyncStatus(res);
}

export async function trimProcessMemoryNative(
  profileIds: string[],
  candidate?: unknown,
): Promise<NativeTrimMemoryResult[]> {
  const res = await invokeWindowControl<unknown>(
    "system_trim_process_memory",
    { profileIds },
    candidate,
  );
  return Array.isArray(res) ? (res as NativeTrimMemoryResult[]) : [];
}

export type SyncStateListener = (state: SyncStatusSnapshot) => void;
export type SyncEventSubscriber = (listener: SyncStateListener) => Promise<() => void>;

/** Subscribe to Tauri's `maobu-sync-state` event emitted to the `main` window. */
export async function subscribeNativeSyncState(
  listener: SyncStateListener,
  candidate?: unknown,
): Promise<() => void> {
  if (!hasNativeSyncEventHost(candidate)) return () => {};
  try {
    const unlisten = await getCurrentWindow().listen("maobu-sync-state", (event) => {
      listener(normalizeSyncStatus(event.payload));
    });
    return () => {
      try {
        void Promise.resolve(unlisten()).catch(() => {});
      } catch {
        // Ignore cleanup failures after window teardown.
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * React hook subscribing to live `maobu-sync-state` updates on the desktop host.
 * Completely silent in browsers or non-native DOM test fixtures.
 */
export function useWindowSyncState(
  enabled: boolean,
  subscriber: SyncEventSubscriber = subscribeNativeSyncState,
): {
  syncState: SyncStatusSnapshot;
  setSyncState: (next: SyncStatusSnapshot) => void;
} {
  const [syncState, setSyncState] = useState<SyncStatusSnapshot>(() => ({
    ...IDLE_SYNC_STATUS,
    supported: isWindowControlDesktopAvailable(),
  }));

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void subscriber((next) => {
      if (alive) setSyncState(next);
    })
      .then((cleanup) => {
        if (!alive) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [enabled, subscriber]);

  return { syncState, setSyncState };
}
