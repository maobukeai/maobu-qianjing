import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MotionPresence } from "./desktop-motion.tsx";
import { useDesktopCloseDraftReader, useDesktopCloseDraftSnapshot } from "./desktop-close.tsx";
import type { DesktopDraftSnapshot } from "./desktop-close-state.ts";
import { copyPlainText } from "./features/copy-field.tsx";
import { useTranslation } from "./i18n.tsx";
import maobuMarkUrl from "./maobu-mark.png";
import {
  fetchLastUpdate,
  fetchSettings,
  checkForUpdate,
  patchSettings,
  type ResolvedAppSettings,
  type UpdateResult,
} from "./settings-api.ts";
import {
  checkSignedUpdate,
  desktopUpdaterAvailable,
  fetchSignedUpdateStatus,
  installSignedUpdate,
  type SignedUpdateProgress,
  type SignedUpdateStatus,
} from "./signed-update-api.ts";
import { SignedUpdateDraftDialog, SignedUpdateProgressView } from "./signed-update-draft-dialog.tsx";
import type { SignedUpdateStartupController } from "./signed-updates.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import { useOptionalWorkspaceOperations, workspaceOperationMessage } from "./workspace-operations.tsx";

export const DEFAULT_GITHUB_REPOSITORY = "maobukeai/maobu-qianjing";
const GITHUB_REPO_URL = "https://github.com/maobukeai/maobu-qianjing";
const STATUS_ERROR = "Could not read the desktop update channel.";
const DRAFT_BUSY = "Wait for ongoing changes to finish before installing.";
const UPDATE_CHANGED = "The update changed. Check the signed publisher again before installing.";

interface InstallConfirmation {
  version: string;
  workspaceId: string | null;
  revision: number;
  dirty: DesktopDraftSnapshot["dirty"];
  changed: boolean;
}

export interface AboutPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  appVersion: string;
  signedUpdateStartup?: SignedUpdateStartupController;
  onOpenUpdateSettings: () => void;
  onGithubUpdateResult?: (result: UpdateResult | null) => void;
  dialogId?: string;
}

function focusableControls(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    ),
  ).filter((element) => !element.closest('[inert], [hidden], [aria-hidden="true"]'));
}

export function AboutPopover({
  open,
  onClose,
  anchorRef,
  appVersion,
  signedUpdateStartup,
  onOpenUpdateSettings,
  onGithubUpdateResult,
  dialogId,
}: AboutPopoverProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const resolvedDialogId = dialogId ?? `${generatedId}-dialog`;
  const headingId = `${generatedId}-title`;

  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const checkSignedButtonRef = useRef<HTMLButtonElement>(null);
  const installSignedButtonRef = useRef<HTMLButtonElement>(null);
  const signedErrorRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 64, left: 16 });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Signed channel state
  const workspaceOperations = useOptionalWorkspaceOperations();
  const coordinator = workspaceOperations?.coordinator;
  const drafts = useDesktopCloseDraftSnapshot();
  const readDrafts = useDesktopCloseDraftReader();
  const installationBlock = workspaceOperations?.snapshot.blocked
    ? workspaceOperationMessage(workspaceOperations.snapshot)
    : drafts.busy.length
      ? DRAFT_BUSY
      : null;

  const [signedStatus, setSignedStatus] = useState<SignedUpdateStatus | null>(null);
  const [signedLoading, setSignedLoading] = useState(false);
  const [signedError, setSignedError] = useState("");
  const [signedOperation, setSignedOperation] = useState<"check" | "install" | null>(null);
  const [progress, setProgress] = useState<SignedUpdateProgress | null>(null);
  const [installed, setInstalled] = useState(false);
  const [confirmation, setConfirmation] = useState<InstallConfirmation | null>(null);
  const [installDialog, setInstallDialog] = useState(false);
  const installIntent = useRef<InstallConfirmation | null>(null);
  const mounted = useRef(true);
  const statusRevision = useRef(0);
  const operationInFlight = useRef(false);
  const statusReadInFlight = useRef(false);
  const seenStartupStatus = useRef<SignedUpdateStatus | null | undefined>(signedUpdateStartup?.status);

  // GitHub & app settings state
  const [settings, setSettings] = useState<ResolvedAppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [githubResult, setGithubResult] = useState<UpdateResult | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubChecking, setGithubChecking] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [signedPreferenceBusy, setSignedPreferenceBusy] = useState(false);
  const settingsRevision = useRef(0);

  const signedBusy = signedOperation !== null;
  const nativeBusy = !!signedStatus && ["checking", "downloading", "installing"].includes(signedStatus.status);
  const startupChecking = signedUpdateStartup?.checking === true;
  const startupError = signedUpdateStartup?.error === STATUS_ERROR && signedStatus ? null : signedUpdateStartup?.error;
  const modalPaused = !!confirmation || installDialog;
  const desktopMode = desktopUpdaterAvailable();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      statusRevision.current++;
      settingsRevision.current++;
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function loadSignedStatus(reportError: boolean) {
    if (statusReadInFlight.current) return;
    statusReadInFlight.current = true;
    setSignedLoading(true);
    const revision = ++statusRevision.current;
    try {
      const value = await fetchSignedUpdateStatus();
      if (statusRevision.current === revision) {
        coordinator?.setNativeUpdateBusy(value.status === "downloading" || value.status === "installing");
        if (mounted.current) setSignedStatus(value);
      }
    } catch {
      if (reportError && mounted.current && statusRevision.current === revision) setSignedError(STATUS_ERROR);
    } finally {
      statusReadInFlight.current = false;
      if (mounted.current) setSignedLoading(false);
    }
  }

  async function loadSettingsAndGithub(signal?: AbortSignal) {
    const revision = ++settingsRevision.current;
    setSettingsLoading(true);
    setSettingsError(null);
    setGithubError(null);
    const [settingsOutcome, historyOutcome] = await Promise.allSettled([
      fetchSettings(signal),
      fetchLastUpdate(),
    ]);
    if (!mounted.current || settingsRevision.current !== revision || signal?.aborted) return;
    if (settingsOutcome.status === "fulfilled") {
      setSettings(settingsOutcome.value);
    } else {
      setSettingsError(settingsOutcome.reason instanceof Error ? settingsOutcome.reason.message : String(settingsOutcome.reason));
    }
    if (historyOutcome.status === "fulfilled") {
      setGithubResult(historyOutcome.value);
      onGithubUpdateResult?.(historyOutcome.value);
    }
    setSettingsLoading(false);
  }

  useEffect(() => {
    if (!open) {
      setCopied(false);
      setCopyError(null);
      return;
    }
    const controller = new AbortController();
    void loadSignedStatus(true);
    void loadSettingsAndGithub(controller.signal);
    return () => {
      controller.abort();
      settingsRevision.current++;
    };
  }, [open]);

  useEffect(() => {
    const value = signedUpdateStartup?.status;
    if (value === seenStartupStatus.current) return;
    seenStartupStatus.current = value;
    if (!value || operationInFlight.current) return;
    coordinator?.setNativeUpdateBusy(value.status === "downloading" || value.status === "installing");
    statusRevision.current++;
    setSignedStatus(value);
    setSignedError("");
  }, [signedUpdateStartup?.status]);

  useEffect(() => {
    if (!open || !nativeBusy || signedBusy || startupChecking) return;
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
      timer = setInterval(() => {
        void loadSignedStatus(false);
      }, 1500);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void loadSignedStatus(false);
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open, nativeBusy, signedBusy, startupChecking]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
      const popoverWidth = Math.min(416, Math.max(260, viewportWidth - 24));
      if (rect && (rect.width > 0 || rect.height > 0)) {
        const top = Math.max(8, Math.round(rect.bottom + 8));
        const left = Math.max(12, Math.min(Math.round(rect.left), Math.max(12, viewportWidth - popoverWidth - 12)));
        setPosition((previous) => (previous.top === top && previous.left === left ? previous : { top, left }));
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const closeAndRestoreFocus = () => {
      onCloseRef.current();
      if (anchorRef.current?.isConnected) anchorRef.current.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (modalPaused) return;
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalPaused) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (event.key === "Tab" && panelRef.current) {
        const controls = focusableControls(panelRef.current);
        if (!controls.length) {
          event.preventDefault();
          panelRef.current.focus({ preventScroll: true });
          return;
        }
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === panelRef.current || !panelRef.current.contains(active))) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, modalPaused, anchorRef]);

  useLayoutEffect(() => {
    if (!open || modalPaused) return;
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [open]);

  async function refreshAfterSignedFailure(failure: unknown) {
    if (!mounted.current) return;
    setSignedError(failure instanceof Error ? failure.message : String(failure));
    setProgress(null);
    setSignedStatus((previous) => (previous ? { ...previous, update: null } : previous));
    await loadSignedStatus(false);
  }

  async function handleCheckSigned() {
    if (operationInFlight.current || installIntent.current || startupChecking) return;
    operationInFlight.current = true;
    statusRevision.current++;
    signedUpdateStartup?.beginManualOperation();
    setSignedOperation("check");
    setSignedError("");
    setInstalled(false);
    setProgress(null);
    try {
      const result = await checkSignedUpdate();
      if (mounted.current) setSignedStatus(result);
    } catch (error) {
      await refreshAfterSignedFailure(error);
    } finally {
      operationInFlight.current = false;
      if (mounted.current) setSignedOperation(null);
    }
  }

  function keepEditing() {
    installIntent.current = null;
    setConfirmation(null);
  }

  function currentInstallBlock(snapshot: DesktopDraftSnapshot) {
    const workspace = coordinator?.getSnapshot();
    return workspace?.blocked ? workspaceOperationMessage(workspace) : snapshot.busy.length ? DRAFT_BUSY : null;
  }

  function currentWorkspaceId() {
    return coordinator?.getSnapshot().workspaceId ?? signedUpdateStartup?.workspaceId ?? null;
  }

  function canRequestInstall() {
    return signedStatus?.configured === true && !nativeBusy && !startupChecking && !installed && !operationInFlight.current;
  }

  function requestInstall() {
    const version = signedStatus?.update?.version;
    if (!version || !canRequestInstall() || installIntent.current) return;
    const snapshot = readDrafts();
    if (currentInstallBlock(snapshot)) return;
    if (!snapshot.dirty.length) {
      void performInstall(version);
      return;
    }
    const intent: InstallConfirmation = {
      version,
      workspaceId: currentWorkspaceId(),
      revision: snapshot.revision,
      dirty: snapshot.dirty,
      changed: false,
    };
    installIntent.current = intent;
    setConfirmation(intent);
  }

  function confirmInstall() {
    const intent = installIntent.current;
    if (!intent || intent !== confirmation || !canRequestInstall()) return;
    if (intent.version !== signedStatus?.update?.version || intent.workspaceId !== currentWorkspaceId()) {
      statusRevision.current++;
      keepEditing();
      setSignedError(UPDATE_CHANGED);
      setSignedStatus((previous) => (previous ? { ...previous, update: null } : previous));
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
    void performInstall(intent.version);
  }

  async function performInstall(version: string) {
    if (!canRequestInstall() || signedStatus?.update?.version !== version) return;
    const lease = coordinator?.acquire("app-restart");
    if (coordinator && !lease) {
      setSignedError(workspaceOperationMessage(coordinator.getSnapshot()));
      return;
    }
    operationInFlight.current = true;
    statusRevision.current++;
    signedUpdateStartup?.beginManualOperation();
    keepEditing();
    setSignedOperation("install");
    setInstallDialog(true);
    setSignedError("");
    setProgress(null);
    let acceptsProgress = true;
    try {
      await installSignedUpdate(version, (event) => {
        if (mounted.current && acceptsProgress) setProgress(event);
      });
      coordinator?.setNativeUpdateBusy(false);
      if (mounted.current) {
        setInstalled(true);
        setSignedStatus((previous) => (previous ? { ...previous, update: null } : previous));
      }
    } catch (error) {
      acceptsProgress = false;
      if (mounted.current) setInstallDialog(false);
      await refreshAfterSignedFailure(error);
    } finally {
      acceptsProgress = false;
      if (lease) coordinator?.release(lease);
      operationInFlight.current = false;
      if (mounted.current) {
        setInstallDialog(false);
        setSignedOperation(null);
      }
    }
  }

  function returnDialogFocus() {
    if (installSignedButtonRef.current && !installSignedButtonRef.current.disabled) return installSignedButtonRef.current;
    if (signedErrorRef.current) return signedErrorRef.current;
    if (checkSignedButtonRef.current && !checkSignedButtonRef.current.disabled) return checkSignedButtonRef.current;
    return closeButtonRef.current;
  }

  async function handleCopyVersion(versionText: string) {
    if (!versionText) return;
    try {
      await copyPlainText(versionText);
      if (!mounted.current) return;
      setCopyError(null);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 1500);
    } catch (error) {
      if (!mounted.current) return;
      setCopied(false);
      setCopyError(error instanceof Error ? error.message : t("Could not copy to clipboard."));
    }
  }

  async function handleChannelChange(channel: "stable" | "beta") {
    if (!settings || githubBusy) return;
    setGithubBusy(true);
    setGithubError(null);
    try {
      const saved = await patchSettings({ updates: { channel } });
      if (!mounted.current) return;
      setSettings(saved);
    } catch (error) {
      if (mounted.current) setGithubError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setGithubBusy(false);
    }
  }

  async function handleGithubCheck() {
    if (!settings || githubBusy) return;
    setGithubBusy(true);
    setGithubChecking(true);
    setGithubError(null);
    try {
      let currentSettings = settings;
      if (!currentSettings.updates.repository.trim()) {
        currentSettings = await patchSettings({ updates: { repository: DEFAULT_GITHUB_REPOSITORY } });
        if (!mounted.current) return;
        setSettings(currentSettings);
      }
      const nextResult = await checkForUpdate();
      if (!mounted.current) return;
      setGithubResult(nextResult);
      onGithubUpdateResult?.(nextResult);
    } catch (error) {
      if (mounted.current) setGithubError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) {
        setGithubChecking(false);
        setGithubBusy(false);
      }
    }
  }

  async function handleGithubStartupToggle(enabled: boolean) {
    if (!settings || githubBusy) return;
    setGithubBusy(true);
    setGithubError(null);
    try {
      const patch = enabled && !settings.updates.repository.trim()
        ? { updates: { checkOnStartup: true, repository: DEFAULT_GITHUB_REPOSITORY } }
        : { updates: { checkOnStartup: enabled } };
      const saved = await patchSettings(patch);
      if (mounted.current) setSettings(saved);
    } catch (error) {
      if (mounted.current) setGithubError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setGithubBusy(false);
    }
  }

  async function handleSignedStartupToggle(enabled: boolean) {
    if (signedUpdateStartup && desktopMode) {
      await signedUpdateStartup.savePreference(enabled);
      return;
    }
    if (!settings || signedPreferenceBusy) return;
    setSignedPreferenceBusy(true);
    try {
      const saved = await patchSettings({ signedUpdates: { checkOnStartup: enabled } });
      if (mounted.current) setSettings(saved);
    } catch (error) {
      if (mounted.current) setSignedError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setSignedPreferenceBusy(false);
    }
  }

  const displayVersion = appVersion || signedStatus?.currentVersion || "";
  const signedStatusLabel = !signedStatus
    ? signedError || startupError
      ? "Status unavailable"
      : "Loading…"
    : installed
      ? "Restart requested"
      : signedOperation === "install" || signedStatus.status === "downloading" || signedStatus.status === "installing"
        ? "Update in progress"
        : signedOperation === "check" || startupChecking || signedStatus.status === "checking"
          ? "Checking…"
          : !signedStatus.configured
            ? "Not enabled"
            : signedError || startupError || signedStatus.status === "error"
              ? "Check again"
              : signedStatus.update
                ? "Update available"
                : signedStatus.status === "up-to-date"
                  ? "Up to date"
                  : "Ready to check";

  const signedStatusPositive =
    !signedError &&
    !startupError &&
    !signedBusy &&
    !nativeBusy &&
    !startupChecking &&
    (installed || signedStatus?.status === "up-to-date" || !!signedStatus?.update);

  const matchingGithubResult =
    settings && githubResult && githubResult.repository === settings.updates.repository && githubResult.channel === settings.updates.channel
      ? githubResult
      : null;

  const githubStatusLabels: Record<UpdateResult["status"], string> = {
    "not-configured": "Choose a release repository",
    "up-to-date": "No newer GitHub release",
    available: "New GitHub release found",
    error: "Could not read GitHub releases",
  };

  const signedStartupChecked =
    signedUpdateStartup && desktopMode
      ? signedUpdateStartup.preference === true
      : settings?.signedUpdates.checkOnStartup ?? false;

  const signedStartupDisabled =
    signedUpdateStartup && desktopMode
      ? signedUpdateStartup.preference === null ||
        signedUpdateStartup.preferenceBusy ||
        (!signedStatus?.configured && !signedUpdateStartup.preference) ||
        !!confirmation ||
        signedOperation === "install"
      : !desktopMode || !settings || signedPreferenceBusy || (!signedStatus?.configured && !settings?.signedUpdates.checkOnStartup);

  const effectiveRepoLabel = settings?.updates.repository.trim() || "";

  function closeFromButton() {
    onClose();
    if (anchorRef.current?.isConnected) anchorRef.current.focus({ preventScroll: true });
  }

  return (
    <MotionPresence present={open} kind="popover">
      {() => (
        <section
          ref={panelRef}
          id={resolvedDialogId}
          className="about-popover"
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          style={{ top: position.top, left: position.left }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="about-popover-head">
            <div className="about-brand-identity">
              <img className="about-brand-mark" src={maobuMarkUrl} width={36} height={36} alt="" aria-hidden="true" />
              <div className="about-brand-copy">
                <div className="about-brand-title-row">
                  <h2 id={headingId}>猫步·千境</h2>
                  <span className="about-edition-badge">{t("Local edition")}</span>
                </div>
                <div className="about-version-row">
                  <span className="about-version-value mono" title={displayVersion || undefined}>
                    {displayVersion || "—"}
                  </span>
                  <button
                    type="button"
                    className={`btn xs about-copy-btn${copied ? " is-copied" : ""}`}
                    disabled={!displayVersion}
                    aria-label={copied ? t("Copied ✓") : t("Copy version")}
                    onClick={() => void handleCopyVersion(displayVersion)}
                  >
                    {t(copied ? "Copied ✓" : "Copy")}
                  </button>
                </div>
                {copyError && <p className="about-inline-error" role="alert">{copyError}</p>}
              </div>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="iconbtn about-close"
              aria-label={t("Close")}
              title={t("Close")}
              onClick={closeFromButton}
            >
              <AppIcon name="close" className="sm" />
            </button>
          </header>

          <div className="about-popover-body">
            <section className="about-section" aria-label={t("App updates")}>
              <div className="about-section-head">
                <h3>{t("App updates")}</h3>
                <button
                  type="button"
                  className="btn xs ghost about-settings-shortcut"
                  onClick={() => {
                    onClose();
                    onOpenUpdateSettings();
                  }}
                >
                  {t("Open full update settings")}
                </button>
              </div>

              <div className="about-update-card">
                <div className="about-card-row">
                  <strong>{t("Signed update channel")}</strong>
                  <span className={`about-status-badge${signedStatusPositive ? " is-positive" : ""}`}>
                    {t(signedStatusLabel)}
                  </span>
                </div>

                {(signedError || startupError) && (
                  <div className="about-alert" role="alert" ref={signedErrorRef} tabIndex={-1}>
                    <span>{t(signedError || startupError || "")}</span>
                    {!signedStatus && (
                      <button
                        type="button"
                        className="btn xs"
                        disabled={signedLoading}
                        onClick={() => {
                          setSignedError("");
                          void loadSignedStatus(true);
                        }}
                      >
                        {t("Try again")}
                      </button>
                    )}
                  </div>
                )}

                {!signedStatus && !signedError && !startupError && (
                  <p className="about-muted" role="status">{t("Loading…")}</p>
                )}

                {signedStatus && !signedStatus.configured && (
                  <p className="about-note">
                    {t("Signed auto-install channel is not enabled in this build. You can still check GitHub Releases below.")}
                  </p>
                )}

                {signedStatus?.configured && (
                  <>
                    {signedStatus.update ? (
                      <div className="about-release-box">
                        <div className="about-release-version">
                          <strong>{(signedStatus.currentVersion || displayVersion) + " → " + signedStatus.update.version}</strong>
                        </div>
                        {signedStatus.update.notes && (
                          <details className="about-release-notes">
                            <summary>{t("Release notes")}</summary>
                            <pre className="release-notes">{signedStatus.update.notes}</pre>
                          </details>
                        )}
                        <p className="about-muted">{t("Installation saves and closes browser sessions before replacing the app.")}</p>
                      </div>
                    ) : signedStatus.status === "up-to-date" ? (
                      <p className="about-muted">{t("You are on the latest signed release.")}</p>
                    ) : (
                      <p className="about-muted">{t(signedStatus.message)}</p>
                    )}

                    <div className="about-actions">
                      <button
                        ref={checkSignedButtonRef}
                        type="button"
                        className="btn sm"
                        disabled={signedBusy || nativeBusy || startupChecking || !signedStatus.configured || installed}
                        onClick={() => void handleCheckSigned()}
                      >
                        {t(signedOperation === "check" || startupChecking ? "Checking…" : "Check trusted channel")}
                      </button>
                      {signedStatus.update && (
                        <button
                          ref={installSignedButtonRef}
                          type="button"
                          className="btn sm primary"
                          disabled={signedBusy || nativeBusy || startupChecking || !signedStatus.configured || !!installationBlock}
                          onClick={requestInstall}
                        >
                          {t("Install verified update")}
                        </button>
                      )}
                    </div>
                    {installationBlock && !signedBusy && (
                      <p className="about-note" role="status">{t(installationBlock)}</p>
                    )}
                  </>
                )}

                {(signedOperation === "install" || signedStatus?.status === "downloading" || signedStatus?.status === "installing") && (
                  <p className="about-note" role="status">
                    {t("Keep the app open while the update downloads and installs. Closing and restarting are blocked until it finishes.")}
                  </p>
                )}
                {progress && <SignedUpdateProgressView progress={progress} />}
                {installed && <p className="about-success" role="status">{t("Update installed. Restart requested.")}</p>}

                <label className="about-switch">
                  <span>{t("Check signed updates on startup")}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={signedStartupChecked}
                    disabled={signedStartupDisabled}
                    onChange={(event) => void handleSignedStartupToggle(event.target.checked)}
                  />
                </label>
                {signedUpdateStartup?.preferenceError && (
                  <div className="about-alert" role="alert">
                    <span>{t(signedUpdateStartup.preferenceError)}</span>
                    {signedUpdateStartup.preference === null && (
                      <button
                        type="button"
                        className="btn xs"
                        disabled={signedUpdateStartup.preferenceBusy}
                        onClick={signedUpdateStartup.retryPreference}
                      >
                        {t("Try again")}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="about-update-card">
                <div className="about-card-row">
                  <strong>GitHub Releases</strong>
                  <select
                    className="select about-channel-select"
                    aria-label={t("Release channel")}
                    value={settings?.updates.channel ?? "stable"}
                    disabled={!settings || githubBusy || settingsLoading}
                    onChange={(event) => void handleChannelChange(event.target.value as "stable" | "beta")}
                  >
                    <option value="stable">{t("Stable releases")}</option>
                    <option value="beta">{t("Include prereleases")}</option>
                  </select>
                </div>

                <div className="about-github-actions">
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={!settings || githubBusy || settingsLoading}
                    onClick={() => void handleGithubCheck()}
                  >
                    {t(githubChecking ? "Checking…" : "Check for updates")}
                  </button>
                  <span className="about-repo-hint mono">
                    {effectiveRepoLabel || t("Default repository: {repo}", { repo: DEFAULT_GITHUB_REPOSITORY })}
                  </span>
                </div>

                {(settingsError || githubError) && (
                  <div className="about-alert" role="alert">
                    <span>{t(settingsError || githubError || "")}</span>
                  </div>
                )}

                {matchingGithubResult && (
                  <div className="about-github-result" aria-live="polite">
                    <div className="about-card-row">
                      <span
                        className={`about-status-badge${
                          matchingGithubResult.status === "available" || matchingGithubResult.status === "up-to-date"
                            ? " is-positive"
                            : ""
                        }`}
                      >
                        {t(githubStatusLabels[matchingGithubResult.status])}
                      </span>
                      <span className="about-version-compare mono">
                        {matchingGithubResult.currentVersion}
                        {matchingGithubResult.latest ? ` → ${matchingGithubResult.latest.version}` : ""}
                      </span>
                    </div>
                    {matchingGithubResult.error && (
                      <p className="about-inline-error" role="alert">{t(matchingGithubResult.error)}</p>
                    )}
                    {matchingGithubResult.latest && (
                      <div className="about-release-box">
                        <details className="about-release-notes">
                          <summary>{t("Release notes")}</summary>
                          <pre className="release-notes">
                            {matchingGithubResult.latest.notes || t("No release notes provided.")}
                          </pre>
                        </details>
                        <a
                          className="about-link"
                          href={matchingGithubResult.latest.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("View release on GitHub")} ↗
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <label className="about-switch">
                  <span>{t("Check GitHub Releases on startup")}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings?.updates.checkOnStartup ?? false}
                    disabled={!settings || githubBusy || settingsLoading}
                    onChange={(event) => void handleGithubStartupToggle(event.target.checked)}
                  />
                </label>
              </div>
            </section>

            <section className="about-section about-intro">
              <h3>{t("Local-first isolated browser workbench")}</h3>
              <ul className="about-feature-list">
                <li>{t("On-demand Chromium 155, Firefox 156, and CloakBrowser engines.")}</li>
                <li>{t("Encrypted .mqsync and .mqbackup snapshots stay under your control.")}</li>
                <li>{t("Built-in local AI and MCP workbench with zero cloud dependency.")}</li>
              </ul>
            </section>
          </div>

          <footer className="about-popover-foot">
            <span>{t("Original author Xreacher (AliasMode) · 猫步·千境 contributors")}</span>
            <a className="about-link" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              GitHub · maobukeai/maobu-qianjing ↗
            </a>
          </footer>

          <SignedUpdateDraftDialog
            confirmation={confirmation}
            blocked={installationBlock}
            installing={installDialog}
            progress={progress}
            onKeepEditing={keepEditing}
            onConfirm={confirmInstall}
            returnFocus={returnDialogFocus}
          />
        </section>
      )}
    </MotionPresence>
  );
}
