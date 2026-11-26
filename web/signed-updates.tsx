import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useDesktopCloseDraftReader, useDesktopCloseDraftSnapshot } from "./desktop-close.tsx";
import type { DesktopDraftSnapshot } from "./desktop-close-state.ts";
import { useTranslation } from "./i18n.tsx";
import { checkSignedUpdate, desktopUpdaterAvailable, fetchSignedUpdateStatus, installSignedUpdate, type SignedUpdateProgress, type SignedUpdateStatus } from "./signed-update-api.ts";
import { SignedUpdateDraftDialog, SignedUpdateProgressView } from "./signed-update-draft-dialog.tsx";
import { fetchSettings, patchSettings } from "./settings-api.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage } from "./workspace-operations.tsx";
import { AppIcon } from "./ui-primitives.tsx";

const STARTUP_DELAY_MS = 1_000;
const STATUS_ERROR = "Could not read the desktop update channel.";
const CHECK_ERROR = "Could not check the signed update publisher. Check your connection and try again.";
const PREFERENCE_ERROR = "Could not load the signed update startup preference.";
const PREFERENCE_SAVE_ERROR = "Could not save the signed update startup preference.";
const DRAFT_BUSY = "Wait for ongoing changes to finish before installing.";
const UPDATE_CHANGED = "The update changed. Check the signed publisher again before installing.";

interface StartupSnapshot {
  workspaceId: string | null;
  preference: boolean | null;
  preferenceBusy: boolean;
  preferenceError: string | null;
  checking: boolean;
  status: SignedUpdateStatus | null;
  error: string | null;
  noticeVersion: string | null;
}

interface StartupRun {
  workspaceId: string;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  cancelledBy?: "preference" | "manual";
  preferenceBusy: boolean;
}

export interface SignedUpdateStartupController extends StartupSnapshot {
  dismissNotice(): void;
  retryPreference(): void;
  savePreference(enabled: boolean): Promise<void>;
  beginManualOperation(): void;
}

const idleStartup: StartupSnapshot = { workspaceId: null, preference: null, preferenceBusy: false, preferenceError: null,
  checking: false, status: null, error: null, noticeVersion: null };

/** One preference read and one eligible check per desktop workspace startup. */
export function useSignedUpdateStartup(workspaceId: string | null | undefined): SignedUpdateStartupController {
  const active = useRef<StartupRun | null>(null);
  const [snapshot, setSnapshot] = useState(idleStartup);

  function update(run: StartupRun, patch: Partial<StartupSnapshot>) {
    if (active.current !== run) return;
    setSnapshot(previous => active.current === run && previous.workspaceId === run.workspaceId ? { ...previous, ...patch } : previous);
  }

  async function check(run: StartupRun) {
    if (active.current !== run || run.cancelledBy) return;
    let invoked = false;
    try {
      const current = await fetchSignedUpdateStatus();
      if (active.current !== run || run.cancelledBy || current?.configured !== true || current.status !== "idle") return;
      update(run, { checking: true });
      invoked = true;
      const status = await checkSignedUpdate({ startup: true });
      if (active.current !== run || run.cancelledBy === "manual") return;
      const version = status?.configured === true && status.status === "available" ? status.update?.version : null;
      update(run, { status, noticeVersion: !run.cancelledBy && typeof version === "string" && /^[0-9][0-9A-Za-z.+-]{0,127}$/.test(version) ? version : null });
    } catch {
      if (active.current !== run || run.cancelledBy === "manual" || (!invoked && run.cancelledBy)) return;
      update(run, { error: invoked ? CHECK_ERROR : STATUS_ERROR, noticeVersion: null });
      if (invoked) {
        try {
          const status = await fetchSignedUpdateStatus();
          if (status?.status === "error" && run.cancelledBy !== "manual") update(run, { status, error: null });
        } catch { /* Keep the fixed message if status is also unavailable. */ }
      }
    } finally { if (invoked && active.current === run) update(run, { checking: false }); }
  }

  async function loadPreference(run: StartupRun, schedule: boolean) {
    if (active.current !== run || run.preferenceBusy) return;
    run.preferenceBusy = true;
    update(run, { preferenceBusy: true, preferenceError: null });
    try {
      const enabled = (await fetchSettings(run.controller.signal)).signedUpdates.checkOnStartup;
      if (active.current !== run) return;
      update(run, { preference: enabled });
      if (schedule && enabled && !run.cancelledBy) run.timer = setTimeout(() => { void check(run); }, STARTUP_DELAY_MS);
    } catch { if (active.current === run) update(run, { preferenceError: PREFERENCE_ERROR }); }
    finally { run.preferenceBusy = false; if (active.current === run) update(run, { preferenceBusy: false }); }
  }

  useEffect(() => {
    if (!workspaceId || !desktopUpdaterAvailable()) { setSnapshot(idleStartup); return; }
    const run: StartupRun = { workspaceId, controller: new AbortController(), preferenceBusy: false };
    active.current = run;
    setSnapshot({ ...idleStartup, workspaceId });
    void loadPreference(run, true);
    return () => {
      active.current = null;
      clearTimeout(run.timer);
      run.controller.abort();
    };
  }, [workspaceId]);

  function cancelScheduledCheck(run: StartupRun, reason: "preference" | "manual") {
    if (reason === "manual" || !run.cancelledBy) run.cancelledBy = reason;
    clearTimeout(run.timer);
  }

  async function savePreference(enabled: boolean) {
    const run = active.current;
    if (!run || run.workspaceId !== workspaceId || run.preferenceBusy) return;
    run.preferenceBusy = true;
    cancelScheduledCheck(run, "preference");
    update(run, { preferenceBusy: true, preferenceError: null });
    try {
      const saved = await patchSettings({ signedUpdates: { checkOnStartup: enabled } });
      if (saved.signedUpdates.checkOnStartup !== enabled) throw new Error(PREFERENCE_SAVE_ERROR);
      update(run, { preference: enabled, ...(!enabled ? { noticeVersion: null } : {}) });
    } catch { if (active.current === run) update(run, { preferenceError: PREFERENCE_SAVE_ERROR }); }
    finally { run.preferenceBusy = false; if (active.current === run) update(run, { preferenceBusy: false }); }
  }

  return {
    ...(snapshot.workspaceId === workspaceId ? snapshot : idleStartup), savePreference,
    dismissNotice() { if (active.current?.workspaceId === workspaceId && active.current) update(active.current, { noticeVersion: null }); },
    retryPreference() { if (active.current?.workspaceId === workspaceId && active.current) void loadPreference(active.current, false); },
    beginManualOperation() {
      const run = active.current;
      if (!run || run.workspaceId !== workspaceId) return;
      cancelScheduledCheck(run, "manual");
      update(run, { noticeVersion: null, error: null, status: null });
    },
  };
}

interface InstallConfirmation {
  version: string;
  workspaceId: string | null;
  revision: number;
  dirty: DesktopDraftSnapshot["dirty"];
  changed: boolean;
}

export function SignedUpdateCard({ startup }: { startup?: SignedUpdateStartupController } = {}) {
  const { t } = useTranslation();
  const workspaceOperations = useOptionalWorkspaceOperations();
  const coordinator = workspaceOperations?.coordinator;
  const drafts = useDesktopCloseDraftSnapshot(), readDrafts = useDesktopCloseDraftReader();
  const installationBlock = workspaceOperations?.snapshot.blocked ? workspaceOperationMessage(workspaceOperations.snapshot) : drafts.busy.length ? DRAFT_BUSY : null;
  const [status, setStatus] = useState<SignedUpdateStatus | null>(null), [error, setError] = useState(""), [operation, setOperation] = useState<"check" | "install" | null>(null), [progress, setProgress] = useState<SignedUpdateProgress | null>(null), [installed, setInstalled] = useState(false);
  const [confirmation, setConfirmation] = useState<InstallConfirmation | null>(null);
  const [installDialog, setInstallDialog] = useState(false);
  const installIntent = useRef<InstallConfirmation | null>(null);
  const installButton = useRef<HTMLButtonElement>(null), checkButton = useRef<HTMLButtonElement>(null);
  const cardHeading = useRef<HTMLHeadingElement>(null), errorAlert = useRef<HTMLDivElement>(null);
  const busy = operation !== null;
  const mounted = useRef(true);
  const statusRevision = useRef(0);
  const operationInFlight = useRef(false);
  const statusReadInFlight = useRef(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const seenStartup = useRef<SignedUpdateStatus | null | undefined>(startup?.status);
  const nativeBusy = !!status && ["checking", "downloading", "installing"].includes(status.status);
  const startupChecking = startup?.checking === true;
  const startupError = startup?.error === STATUS_ERROR && status ? null : startup?.error;
  async function loadStatus(reportError: boolean) {
    if (statusReadInFlight.current) return;
    statusReadInFlight.current = true; setStatusLoading(true);
    const revision = ++statusRevision.current;
    try {
      const value = await fetchSignedUpdateStatus();
      if (statusRevision.current === revision) { coordinator?.setNativeUpdateBusy(value.status === "downloading" || value.status === "installing"); if (mounted.current) setStatus(value); }
    } catch { if (reportError && mounted.current && statusRevision.current === revision) setError(STATUS_ERROR); }
    finally { statusReadInFlight.current = false; if (mounted.current) setStatusLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void loadStatus(true);
    return () => { mounted.current = false; statusRevision.current++; };
  }, []);
  useEffect(() => {
    const value = startup?.status;
    if (value === seenStartup.current) return;
    seenStartup.current = value;
    if (!value || operationInFlight.current) return;
    coordinator?.setNativeUpdateBusy(value.status === "downloading" || value.status === "installing");
    statusRevision.current++;
    setStatus(value);
    setError("");
  }, [startup?.status]);
  useEffect(() => {
    if (!nativeBusy || busy || startupChecking) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setInterval(() => { void loadStatus(false); }, 1500);
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else {
        void loadStatus(false);
        start();
      }
    };
    start();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [nativeBusy, busy, startupChecking]);
  async function refreshAfterFailure(failure: unknown) {
    if (!mounted.current) return;
    setError(failure instanceof Error ? failure.message : String(failure));
    setProgress(null);
    // A failed check invalidates native pending data; do not keep an old install
    // action available if the follow-up status read is also unavailable.
    setStatus(previous => previous ? { ...previous, update: null } : previous);
    await loadStatus(false);
  }
  async function check() {
    if (operationInFlight.current || installIntent.current || startupChecking) return;
    operationInFlight.current = true;
    statusRevision.current++;
    startup?.beginManualOperation();
    setOperation("check"); setError(""); setInstalled(false); setProgress(null);
    try { const result = await checkSignedUpdate(); if (mounted.current) setStatus(result); }
    catch (error) { await refreshAfterFailure(error); }
    finally { operationInFlight.current = false; if (mounted.current) setOperation(null); }
  }
  function keepEditing() {
    installIntent.current = null;
    setConfirmation(null);
  }
  function currentInstallBlock(snapshot: DesktopDraftSnapshot) {
    const workspace = coordinator?.getSnapshot();
    return workspace?.blocked ? workspaceOperationMessage(workspace) : snapshot.busy.length ? DRAFT_BUSY : null;
  }
  function workspaceId() { return coordinator?.getSnapshot().workspaceId ?? startup?.workspaceId ?? null; }
  function canRequestInstall() {
    return status?.configured === true && !nativeBusy && !startupChecking && !installed && !operationInFlight.current;
  }
  function requestInstall() {
    const version = status?.update?.version;
    if (!version || !canRequestInstall() || installIntent.current) return;
    const snapshot = readDrafts();
    if (currentInstallBlock(snapshot)) return;
    if (!snapshot.dirty.length) { void install(version); return; }
    const intent = { version, workspaceId: workspaceId(), revision: snapshot.revision, dirty: snapshot.dirty, changed: false };
    installIntent.current = intent;
    setConfirmation(intent);
  }
  function confirmInstall() {
    const intent = installIntent.current;
    if (!intent || intent !== confirmation || !canRequestInstall()) return;
    if (intent.version !== status?.update?.version || intent.workspaceId !== workspaceId()) {
      statusRevision.current++;
      keepEditing();
      setError(UPDATE_CHANGED);
      setStatus(previous => previous ? { ...previous, update: null } : previous);
      return;
    }
    const snapshot = readDrafts();
    if (currentInstallBlock(snapshot)) return;
    if (intent.revision !== snapshot.revision) {
      const reviewed = { ...intent, revision: snapshot.revision, dirty: snapshot.dirty, changed: true };
      installIntent.current = reviewed;
      setConfirmation(reviewed);
      return;
    }
    void install(intent.version);
  }
  async function install(version: string) {
    if (!canRequestInstall() || status?.update?.version !== version) return;
    const lease = coordinator?.acquire("app-restart");
    if (coordinator && !lease) { setError(workspaceOperationMessage(coordinator.getSnapshot())); return; }
    operationInFlight.current = true;
    statusRevision.current++;
    startup?.beginManualOperation();
    keepEditing();
    setOperation("install"); setInstallDialog(true); setError(""); setProgress(null);
    let acceptsProgress = true;
    try {
      await installSignedUpdate(version, event => { if (mounted.current && acceptsProgress) setProgress(event); });
      coordinator?.setNativeUpdateBusy(false);
      if (mounted.current) { setInstalled(true); setStatus(previous => previous ? { ...previous, update: null } : previous); }
    } catch (error) {
      acceptsProgress = false;
      if (mounted.current) setInstallDialog(false);
      await refreshAfterFailure(error);
    } finally {
      acceptsProgress = false;
      if (lease) coordinator?.release(lease);
      operationInFlight.current = false;
      if (mounted.current) { setInstallDialog(false); setOperation(null); }
    }
  }
  function returnFocus() {
    if (installButton.current && !installButton.current.disabled) return installButton.current;
    if (errorAlert.current) return errorAlert.current;
    if (checkButton.current && !checkButton.current.disabled) return checkButton.current;
    return cardHeading.current;
  }
  const statusLabel = !status ? error || startupError ? "Status unavailable" : "Loading…" : installed ? "Restart requested" : operation === "install" || status.status === "downloading" || status.status === "installing" ? "Update in progress" : operation === "check" || startupChecking || status.status === "checking" ? "Checking…" : error || status.status === "error" ? "Check again" : status.update ? "Update available" : !status.configured ? "Installation unavailable" : status.status === "up-to-date" ? "Up to date" : "Ready to check";
  const statusPositive = !error && !startupError && !busy && !nativeBusy && !startupChecking && (installed || status?.status === "up-to-date" || !!status?.update);
  return <section className="feature-card signed-update-card">
    <div className="feature-card-title">
      <div className="feature-card-head-main">
        <div className="feature-card-heading">
          <AppIcon name="import" className="sm" />
          <h3 ref={cardHeading} tabIndex={-1}>{t("Install app updates")}</h3>
        </div>
      </div>
      <span className={`feature-badge ${statusPositive ? "positive" : ""}`}>{t(statusLabel)}</span>
    </div>
    <div className="feature-card-body">
      {(error || startupError) && <div className="feature-alert" role="alert" ref={errorAlert} tabIndex={-1}>{t(error || startupError || "")}{!status && <button className="btn xs" type="button" disabled={statusLoading} aria-busy={statusLoading} onClick={() => { setError(""); void loadStatus(true); }}>{t("Try again")}</button>}</div>}
      {!status && !error && !startupError && <p role="status">{t("Loading…")}</p>}
      {status && <><p>{t(status.message)}</p>{status.currentVersion && <p className="signed-update-current">{t("Current version")} {status.currentVersion}</p>}
        {status.endpoint && <details className="feature-details signed-update-source"><summary>{t("Installation source")}</summary><p>{t("This source is set by the app publisher and is independent of your GitHub announcement repository.")}</p><p className="signed-update-endpoint mono">{status.endpoint}</p></details>}
        {status.update && <div className="signed-update-release"><strong>{status.currentVersion} → {status.update.version}</strong><pre className="release-notes">{status.update.notes || t("No release notes provided.")}</pre><p>{t("Installation saves and closes browser sessions before replacing the app.")}</p></div>}
        <div className="feature-actions"><button className="btn" ref={checkButton} type="button" disabled={busy || nativeBusy || startupChecking || !status.configured || installed} onClick={() => void check()}>{t(operation === "check" || startupChecking ? "Checking…" : "Check trusted channel")}</button>{status.update && <button className="btn primary" ref={installButton} type="button" disabled={busy || nativeBusy || startupChecking || !status.configured || !!installationBlock} onClick={requestInstall}>{t("Install verified update")}</button>}</div>
        {installationBlock && !busy && <p className="feature-inline-note" role="status">{t(installationBlock)}</p>}
      </>}
      {startup && desktopUpdaterAvailable() && <>
        <label className="feature-toggle"><span><strong>{t("Check the trusted channel on startup")}</strong><small>{t("Check once when this workspace starts. Review available versions before choosing to install.")}</small></span>
          <input type="checkbox" role="switch" checked={startup.preference === true}
            disabled={startup.preference === null || startup.preferenceBusy || (!status?.configured && !startup.preference) || !!confirmation || operation === "install"}
            onChange={event => void startup.savePreference(event.target.checked)} /></label>
        {startup.preferenceBusy && <p className="feature-inline-note" role="status">{t(startup.preference === null ? "Loading…" : "Saving…")}</p>}
        {startup.preferenceError && <div className="feature-alert" role="alert">{t(startup.preferenceError)}{startup.preference === null && <button type="button" className="btn xs" disabled={startup.preferenceBusy} onClick={startup.retryPreference}>{t("Try again")}</button>}</div>}
      </>}
      {(operation === "install" || status?.status === "downloading" || status?.status === "installing") && <p className="feature-inline-note" role="status">{t("Keep the app open while the update downloads and installs. Closing and restarting are blocked until it finishes.")}</p>}
      {progress && <SignedUpdateProgressView progress={progress} />}
      {installed && <p className="feature-success" role="status">{t("Update installed. Restart requested.")}</p>}
    </div>
    <SignedUpdateDraftDialog confirmation={confirmation} blocked={installationBlock} installing={installDialog} progress={progress} onKeepEditing={keepEditing} onConfirm={confirmInstall} returnFocus={returnFocus} />
  </section>;
}
