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
const POPOVER_MARGIN = 8;

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
  ).filter((element) => element.tabIndex >= 0 && !element.closest('[inert], [hidden], [aria-hidden="true"]'));
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
  const notesId = `${generatedId}-notes`;

  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const primaryActionButtonRef = useRef<HTMLButtonElement>(null);
  const signedErrorRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const retryHadFocus = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 56, left: 16 });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);

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
  const [signedReadFailed, setSignedReadFailed] = useState(false);
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
  const settingsReadController = useRef<AbortController | null>(null);

  const signedBusy = signedOperation !== null;
  const nativeBusy = !!signedStatus && ["checking", "downloading", "installing"].includes(signedStatus.status);
  const startupChecking = signedUpdateStartup?.checking === true;
  const startupError = signedUpdateStartup?.error === STATUS_ERROR && signedStatus ? null : signedUpdateStartup?.error;
  const retrySignedStatus = signedReadFailed || startupError === STATUS_ERROR;
  const retryRead = retrySignedStatus || !!settingsError;
  const settingsReady = settings !== null && !settingsError && !settingsLoading;
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
        if (mounted.current) {
          setSignedStatus(value);
          setSignedReadFailed(false);
        }
      }
    } catch {
      if (reportError && mounted.current && statusRevision.current === revision) setSignedReadFailed(true);
    } finally {
      statusReadInFlight.current = false;
      if (mounted.current) setSignedLoading(false);
    }
  }

  async function loadSettingsAndGithub(signal?: AbortSignal) {
    const revision = ++settingsRevision.current;
    setSettingsLoading(true);
    setGithubError(null);
    const [settingsOutcome, historyOutcome] = await Promise.allSettled([
      fetchSettings(signal),
      fetchLastUpdate(),
    ]);
    if (!mounted.current || settingsRevision.current !== revision || signal?.aborted) return;
    if (settingsOutcome.status === "fulfilled") {
      setSettings(settingsOutcome.value);
      setSettingsError(null);
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
    settingsReadController.current = controller;
    void loadSignedStatus(true);
    void loadSettingsAndGithub(controller.signal);
    return () => {
      controller.abort();
      settingsReadController.current = null;
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
    setSignedReadFailed(false);
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
      const viewportWidth = window.innerWidth;
      const popoverWidth = panelRef.current?.offsetWidth || Math.min(464, viewportWidth - 2 * POPOVER_MARGIN);
      if (rect && (rect.width > 0 || rect.height > 0)) {
        const top = Math.max(8, Math.round(rect.bottom + 8));
        const left = Math.max(POPOVER_MARGIN, Math.min(Math.round(rect.left), viewportWidth - popoverWidth - POPOVER_MARGIN));
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
      if (modalPaused || event.defaultPrevented) return;
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalPaused || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
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
          last.focus();
        } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
          event.preventDefault();
          first.focus();
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
    if (!signedStatus?.configured || operationInFlight.current || installIntent.current || startupChecking) return;
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
    return signedStatus?.configured === true && !retrySignedStatus && !signedLoading && !nativeBusy && !startupChecking && !installed && !operationInFlight.current;
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
    if (primaryActionButtonRef.current && !primaryActionButtonRef.current.disabled) return primaryActionButtonRef.current;
    if (signedErrorRef.current) return signedErrorRef.current;
    return closeButtonRef.current;
  }

  useLayoutEffect(() => {
    if (retryRead && open) return;
    const shouldRestore = retryHadFocus.current;
    retryHadFocus.current = false;
    if (open && shouldRestore && document.activeElement === document.body) returnDialogFocus()?.focus();
  }, [open, retryRead]);

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
    if (!settings || !settingsReady || githubBusy) return;
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
    if (!settings || !settingsReady || githubBusy) return;
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

  async function handleUnifiedCheck() {
    const tasks: Array<Promise<unknown>> = [];
    if (signedStatus?.configured && !retrySignedStatus && !signedLoading) tasks.push(handleCheckSigned());
    if (settingsReady && !githubBusy) tasks.push(handleGithubCheck());
    await Promise.allSettled(tasks);
  }

  const displayVersion = appVersion || signedStatus?.currentVersion || "";
  const matchingGithubResult =
    settings && githubResult && githubResult.repository === settings.updates.repository && githubResult.channel === settings.updates.channel
      ? githubResult
      : null;

  const signedChannelConfigured = desktopMode && signedStatus?.configured === true;
  const signedStartupChecked =
    signedUpdateStartup && desktopMode
      ? signedUpdateStartup.preference === true
      : settings?.signedUpdates.checkOnStartup ?? false;
  const githubStartupChecked = settings?.updates.checkOnStartup ?? false;
  const canToggleSigned = desktopMode && (signedChannelConfigured || signedStartupChecked);

  const autoCheckChecked = signedChannelConfigured ? signedStartupChecked || githubStartupChecked : githubStartupChecked;
  const signedControlBusy = Boolean(
    signedUpdateStartup?.preferenceBusy ||
      signedPreferenceBusy ||
      confirmation ||
      signedOperation === "install" ||
      (signedChannelConfigured && signedUpdateStartup && signedUpdateStartup.preference === null),
  );
  const autoCheckDisabled = !settingsReady || githubBusy || (canToggleSigned && signedControlBusy);

  async function handleAutoCheckStartupToggle(enabled: boolean) {
    if (autoCheckDisabled || !settings) return;
    if (canToggleSigned) {
      if (signedUpdateStartup && desktopMode) {
        await signedUpdateStartup.savePreference(enabled);
      } else {
        setSignedPreferenceBusy(true);
        try {
          const savedSigned = await patchSettings({ signedUpdates: { checkOnStartup: enabled } });
          if (mounted.current) setSettings(savedSigned);
        } catch (error) {
          if (mounted.current) setSignedError(error instanceof Error ? error.message : String(error));
        } finally {
          if (mounted.current) setSignedPreferenceBusy(false);
        }
      }
    }

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

  const effectiveRepoLabel = settings?.updates.repository.trim() || DEFAULT_GITHUB_REPOSITORY;

  const isChecking = signedOperation === "check" || startupChecking || signedStatus?.status === "checking" || githubChecking;
  const isInstalling = signedOperation === "install" || signedStatus?.status === "downloading" || signedStatus?.status === "installing";
  const hasSignedUpdate = Boolean(signedStatus?.configured && signedStatus.update && !installed);
  const hasGithubUpdate = Boolean(matchingGithubResult?.status === "available" && matchingGithubResult.latest);
  const canCheckSigned = signedStatus?.configured === true && !retrySignedStatus && !signedLoading;
  const canCheckGithub = settingsReady && !githubBusy;

  let badgeLabel = "Ready to check";
  let badgeTone: "neutral" | "positive" | "accent" = "neutral";
  if (installed) {
    badgeLabel = "Restart requested";
    badgeTone = "positive";
  } else if (isInstalling) {
    badgeLabel = "Update in progress";
    badgeTone = "accent";
  } else if (isChecking) {
    badgeLabel = "Checking…";
  } else if (retrySignedStatus && hasSignedUpdate) {
    badgeLabel = "Status unavailable";
  } else if (hasSignedUpdate || hasGithubUpdate) {
    badgeLabel = hasSignedUpdate ? "Update available" : "New GitHub release";
    badgeTone = "accent";
  } else if (signedStatus?.status === "up-to-date" || matchingGithubResult?.status === "up-to-date") {
    badgeLabel = "Up to date";
    badgeTone = "positive";
  } else if (signedStatus && !signedStatus.configured) {
    badgeLabel = "Local build";
  }

  let capsuleTitle = t("Check for a newer version");
  if (installed) {
    capsuleTitle = t("Update installed. Restart requested.");
  } else if (isInstalling) {
    capsuleTitle = t("Installing signed update…");
  } else if (retrySignedStatus && hasSignedUpdate) {
    capsuleTitle = t("Check again");
  } else if (hasSignedUpdate && signedStatus?.update) {
    capsuleTitle = `${t("Update available")}: ${signedStatus.currentVersion || displayVersion} → ${signedStatus.update.version}`;
  } else if (hasGithubUpdate && matchingGithubResult?.latest) {
    capsuleTitle = `${t("New GitHub release")}: ${matchingGithubResult.currentVersion} → ${matchingGithubResult.latest.version}`;
  } else if (signedStatus?.status === "up-to-date" || matchingGithubResult?.status === "up-to-date") {
    capsuleTitle = displayVersion
      ? t("v{version} is up to date", { version: displayVersion })
      : t("You are running the latest version");
  } else if (signedStatus && !signedStatus.configured) {
    capsuleTitle = t("Community local build");
  } else if (signedError || startupError) {
    capsuleTitle = t("Check again");
  }

  let capsuleDetail = t("Signed desktop channel + GitHub Releases.");
  if (isInstalling) {
    capsuleDetail = t("Keep the app open until installation finishes.");
  } else if (retrySignedStatus && hasSignedUpdate) {
    capsuleDetail = "";
  } else if (hasSignedUpdate) {
    capsuleDetail = t("Saves and closes open browser sessions before restarting.");
  } else if (hasGithubUpdate && matchingGithubResult?.latest) {
    capsuleDetail = t("View release notes below or download from GitHub.");
  } else if (signedStatus && !signedStatus.configured && matchingGithubResult?.status === "up-to-date") {
    capsuleDetail = t("Synced with GitHub Releases · auto-install off.");
  } else if (signedStatus && !signedStatus.configured) {
    capsuleDetail = t("Tracks GitHub Releases · signed auto-install off.");
  } else if (signedStatus?.configured && signedStatus.message) {
    capsuleDetail = t(signedStatus.message);
  }

  const releaseNotesText =
    signedStatus?.update?.notes ||
    matchingGithubResult?.latest?.notes ||
    (signedStatus?.configured && signedStatus.status === "up-to-date"
      ? t("No newer release notes on the signed channel.")
      : t("Check for updates to load the latest release notes."));

  const combinedError = (retrySignedStatus ? STATUS_ERROR : null) || settingsError || signedError || startupError || githubError || matchingGithubResult?.error || null;
  const showNotesLink = matchingGithubResult?.latest?.url ?? null;

  function retryReadingStatus() {
    if (signedLoading || settingsLoading) return;
    retryHadFocus.current = document.activeElement === retryButtonRef.current;
    if (retrySignedStatus) void loadSignedStatus(true);
    if (settingsError) void loadSettingsAndGithub(settingsReadController.current?.signal);
  }

  function closeFromButton() {
    onClose();
    if (anchorRef.current?.isConnected) anchorRef.current.focus({ preventScroll: true });
  }

  return (
    <MotionPresence present={open} kind="popover" exitMs={140}>
      {() => (
        <section
          ref={panelRef}
          id={resolvedDialogId}
          className="about-popover"
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          style={{ top: position.top, left: position.left, maxHeight: `min(680px, calc(100dvh - ${position.top + POPOVER_MARGIN}px))` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="about-popover-body">
            {/* 顶部横向双栏：左栏品牌/版本/致谢，右栏更新状态与操作 */}
            <div className="about-popover-grid">
              <aside className="about-brand-col">
                <div className="about-brand-top">
                  <div className="about-brand-identity">
                    <div className="about-brand-icon-box" aria-hidden="true">
                      <img className="about-brand-mark" src={maobuMarkUrl} width={22} height={22} alt="" />
                    </div>
                    <div className="about-brand-copy">
                      <h2 id={headingId}>猫步·千境</h2>
                      <span className="about-edition-badge">{t("Local edition")}</span>
                    </div>
                  </div>
                  <div className="about-version-row">
                    <span className="about-version-value mono" title={displayVersion || undefined}>
                      {displayVersion ? `v${displayVersion}` : "—"}
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

                <div
                  className="about-credits-compact"
                  aria-label={t("Open-source credits")}
                  title={t("Open-source credits")}
                >
                  <span>Xreacher (AliasMode) · 猫步·千境</span>
                  <a className="about-github-pill" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
                    <span>GitHub</span>
                    <span className="about-arrow-diagonal" aria-hidden="true">↗</span>
                  </a>
                </div>
              </aside>

              <div className="about-update-capsule">
                <div className="about-capsule-top">
                  <span className={`about-status-badge is-${badgeTone}${isChecking ? " is-checking" : ""}`} role="status">
                    {isChecking && <span className="about-badge-spinner" aria-hidden="true" />}
                    {!isChecking && (hasSignedUpdate || hasGithubUpdate || badgeTone === "positive") && (
                      <span className="about-badge-dot" aria-hidden="true" />
                    )}
                    <span>{t(badgeLabel)}</span>
                  </span>
                  <div className="about-capsule-top-right">
                    <select
                      className="select about-channel-select"
                      aria-label={t("Release channel")}
                      value={settings?.updates.channel ?? "stable"}
                      disabled={!settingsReady || githubBusy || isInstalling}
                      onChange={(event) => void handleChannelChange(event.target.value as "stable" | "beta")}
                    >
                      <option value="stable">{t("Stable releases")}</option>
                      <option value="beta">{t("Include prereleases")}</option>
                    </select>
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
                  </div>
                </div>

                <div className="about-capsule-copy">
                  <div className="about-update-title">{capsuleTitle}</div>
                  {capsuleDetail && <p className="about-update-subtitle">{capsuleDetail}</p>}
                </div>

                {progress && <SignedUpdateProgressView progress={progress} />}
                {installationBlock && hasSignedUpdate && (
                  <p className="about-note" role="status">{t(installationBlock)}</p>
                )}

                {combinedError && (
                  <div className="about-alert" ref={signedErrorRef} tabIndex={-1}>
                    <span role="alert">{t(combinedError)}</span>
                    {retryRead && (
                      <button
                        ref={retryButtonRef}
                        type="button"
                        className="btn xs"
                        aria-disabled={signedLoading || settingsLoading}
                        onClick={retryReadingStatus}
                      >
                        {t("Try again")}
                      </button>
                    )}
                  </div>
                )}

                <div className="about-capsule-actions">
                  {hasSignedUpdate && !retrySignedStatus ? (
                    <button
                      ref={primaryActionButtonRef}
                      type="button"
                      className="btn sm primary about-primary-cta"
                      disabled={signedBusy || signedLoading || nativeBusy || startupChecking || !!installationBlock}
                      onClick={requestInstall}
                    >
                      {t("Install verified update")}
                    </button>
                  ) : (
                    <button
                      ref={primaryActionButtonRef}
                      type="button"
                      className="btn sm primary about-primary-cta"
                      disabled={isChecking || isInstalling || (!canCheckSigned && !canCheckGithub)}
                      onClick={() => void handleUnifiedCheck()}
                    >
                      {t(isChecking ? "Checking…" : "Check for updates")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn sm about-notes-toggle${notesExpanded ? " is-open" : ""}`}
                    aria-expanded={notesExpanded}
                    aria-controls={notesId}
                    onClick={() => setNotesExpanded((previous) => !previous)}
                  >
                    <span>{t(notesExpanded ? "Hide release notes" : "Release notes")}</span>
                    <svg className="about-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* 底部超薄单行条：统一自动更新开关 + 更新设置快捷入口 */}
            <div className="about-bottom-bar">
              <label
                className={`about-switch-row${autoCheckDisabled ? " is-disabled" : ""}`}
                title={signedChannelConfigured ? t("Signed desktop channel + GitHub Releases.") : effectiveRepoLabel}
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoCheckChecked}
                  disabled={autoCheckDisabled}
                  onChange={(event) => void handleAutoCheckStartupToggle(event.target.checked)}
                />
                <span>{t("Auto-check on startup")}</span>
              </label>

              <button
                type="button"
                className="btn xs ghost about-settings-shortcut"
                onClick={() => {
                  onClose();
                  onOpenUpdateSettings();
                }}
              >
                <span>{t("Update settings")}</span>
                <span className="about-arrow-nudge" aria-hidden="true">→</span>
              </button>
            </div>

            {signedUpdateStartup?.preferenceError && (
              <div className="about-pref-error-wrap">
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
              </div>
            )}

            <div
              id={notesId}
              className={`about-notes-accordion${notesExpanded ? " is-open" : ""}`}
              data-open={notesExpanded ? "true" : "false"}
              aria-hidden={!notesExpanded}
            >
              <div className="about-notes-accordion-inner">
                <div className="about-notes-drawer">
                  <pre className="release-notes" tabIndex={notesExpanded ? 0 : -1} role="region" aria-label={t("Release notes")}>{releaseNotesText}</pre>
                  {showNotesLink && (
                    <a
                      className="about-link"
                      href={showNotesLink}
                      target="_blank"
                      rel="noreferrer"
                      tabIndex={notesExpanded ? undefined : -1}
                    >
                      {t("View release on GitHub")} ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

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
