import * as React from "react";
import { useEffect, useId, useState } from "react";
import { notifyAppLockedFromResponse, notifyUnauthorizedResponse, withStandaloneAuthHeaders } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./onboarding-checklist.css";

export const ONBOARDING_STATE_KEY = "aliasmode.onboarding.state";
export type OnboardingChecklistState = "open" | "collapsed" | "dismissed";

export function isOnboardingChecklistState(value: unknown): value is OnboardingChecklistState {
  return value === "open" || value === "collapsed" || value === "dismissed";
}

export function parseOnboardingState(
  value: unknown,
  fallback: OnboardingChecklistState = "open",
): OnboardingChecklistState {
  return isOnboardingChecklistState(value) ? value : fallback;
}

/** Minimal profile slice needed to derive real onboarding completion status. */
export interface OnboardingProfileSnapshot {
  id: string;
  proxy?: string | null;
  running?: boolean;
  lastOpenAt?: number;
}

export interface OnboardingStepItem {
  id: "create_profile" | "configure_proxy" | "launch_profile" | "explore_tools";
  title: string;
  description?: string;
  optional: boolean;
  completed: boolean;
}

export interface OnboardingProgressInput {
  profiles: readonly OnboardingProfileSnapshot[];
  proxyVaultCount?: number;
  appLockEnabled?: boolean;
  diagnosticsRun?: boolean;
  scriptCount?: number;
  toolsExplored?: boolean;
}

export function deriveOnboardingSteps(input: OnboardingProgressInput): OnboardingStepItem[] {
  const hasProfile = input.profiles.length > 0;
  const hasProxy =
    input.profiles.some((profile) => typeof profile.proxy === "string" && profile.proxy.trim().length > 0)
    || (input.proxyVaultCount ?? 0) > 0;
  const hasLaunched = input.profiles.some(
    (profile) => profile.running === true || (typeof profile.lastOpenAt === "number" && profile.lastOpenAt > 0),
  );
  const explored =
    input.toolsExplored === true
    || input.appLockEnabled === true
    || input.diagnosticsRun === true
    || (input.scriptCount ?? 0) > 0;

  return [
    {
      id: "create_profile",
      title: "Create or import your first profile",
      optional: false,
      completed: hasProfile,
    },
    {
      id: "configure_proxy",
      title: "Configure or test a proxy",
      optional: true,
      completed: hasProxy,
    },
    {
      id: "launch_profile",
      title: "Launch your first browser profile",
      description: "Open a profile to download the pinned engine on demand and verify startup.",
      optional: false,
      completed: hasLaunched,
    },
    {
      id: "explore_tools",
      title: "Explore security & productivity tools",
      optional: true,
      completed: explored,
    },
  ];
}

/**
 * Persists `aliasmode.onboarding.state` directly via `/ui/api/workspace/preferences`.
 * Hosts that already manage workspace preferences can pass `onStateChange` instead.
 */
export async function persistOnboardingState(state: OnboardingChecklistState): Promise<void> {
  const capRes = await fetch("/ui/api/workspace/capability", {
    credentials: "same-origin",
    cache: "no-store",
    headers: withStandaloneAuthHeaders({ Accept: "application/json" }),
  });
  const capBody = (await capRes.json().catch(() => null)) as { ok?: boolean; token?: string; error?: string; code?: string } | null;
  if (capRes.status === 401) {
    notifyUnauthorizedResponse(401, "/ui/api/workspace/capability", capBody?.error ?? "");
  } else if (capRes.status === 423) {
    notifyAppLockedFromResponse(423, capBody);
  }
  if (!capRes.ok || !capBody?.ok || typeof capBody.token !== "string") {
    throw new Error("Could not acquire workspace capability.");
  }
  const saveRes = await fetch("/ui/api/workspace/preferences", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: withStandaloneAuthHeaders({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Maobu-Workspace-Capability": capBody.token,
    }),
    body: JSON.stringify({ key: ONBOARDING_STATE_KEY, value: state }),
  });
  const saveBody = (await saveRes.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string } | null;
  if (saveRes.status === 401) {
    notifyUnauthorizedResponse(401, "/ui/api/workspace/preferences", saveBody?.error ?? "");
  } else if (saveRes.status === 423) {
    notifyAppLockedFromResponse(423, saveBody);
  }
  if (!saveRes.ok || !saveBody?.ok) {
    throw new Error(saveBody?.error ?? "Could not save onboarding state.");
  }
}

export interface OnboardingChecklistProps extends OnboardingProgressInput {
  /** Controlled state ("open" | "collapsed" | "dismissed"). Defaults to internal "open". */
  state?: OnboardingChecklistState;
  /** Controlled change handler. If omitted, updates internal state and optionally persists via workspace API. */
  onStateChange?: (next: OnboardingChecklistState) => void | Promise<void>;
  /** When uncontrolled, also persist changes to `/ui/api/workspace/preferences`. Default false unless enabled. */
  autoPersist?: boolean;
  onCreateProfile?: () => void;
  onImportProfiles?: () => void;
  onOpenProxies?: () => void;
  onLaunchFirstProfile?: (profileId: string) => void;
  onOpenDiagnostics?: () => void;
  onOpenAppLock?: () => void;
  onOpenScripts?: () => void;
  onVisitTool?: () => void;
}

export function OnboardingChecklist({
  profiles,
  proxyVaultCount,
  appLockEnabled,
  diagnosticsRun,
  scriptCount,
  toolsExplored,
  state: controlledState,
  onStateChange,
  autoPersist = false,
  onCreateProfile,
  onImportProfiles,
  onOpenProxies,
  onLaunchFirstProfile,
  onOpenDiagnostics,
  onOpenAppLock,
  onOpenScripts,
  onVisitTool,
}: OnboardingChecklistProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const stepsId = useId();
  const [internalState, setInternalState] = useState<OnboardingChecklistState>(controlledState ?? "open");
  const [localExplored, setLocalExplored] = useState(false);

  useEffect(() => {
    if (controlledState !== undefined) {
      setInternalState(controlledState);
    }
  }, [controlledState]);

  const currentState = controlledState ?? internalState;
  if (currentState === "dismissed") return null;

  const steps = deriveOnboardingSteps({
    profiles,
    proxyVaultCount,
    appLockEnabled,
    diagnosticsRun,
    scriptCount,
    toolsExplored: toolsExplored || localExplored,
  });
  const completedCount = steps.filter((step) => step.completed).length;
  const totalCount = steps.length;
  const allCompleted = completedCount === totalCount;
  const progressPercent = Math.round((completedCount / totalCount) * 100);
  const nextStep = steps.find((step) => !step.completed && !step.optional) ?? steps.find((step) => !step.completed) ?? null;
  const nextStepNumber = nextStep ? steps.indexOf(nextStep) + 1 : totalCount;
  const collapsed = currentState === "collapsed";
  const firstProfileId = profiles[0]?.id;
  const toggleLabel = t(collapsed ? "Expand" : "Collapse");
  const tools = [
    { label: "Diagnostics", open: onOpenDiagnostics },
    { label: "App lock", open: onOpenAppLock },
    { label: "Scripts", open: onOpenScripts },
  ];

  const updateState = (next: OnboardingChecklistState) => {
    if (controlledState === undefined) {
      setInternalState(next);
    }
    if (onStateChange) {
      void onStateChange(next);
    } else if (autoPersist) {
      void persistOnboardingState(next).catch(() => {
        // Non-blocking UI preference write.
      });
    }
  };

  const renderStepActions = (stepId: OnboardingStepItem["id"], completed: boolean, variant: "focus" | "cell") => {
    if (completed) {
      return variant === "cell" ? <span className="onboarding-step-done-label">{t("Completed")}</span> : null;
    }
    const primaryClass = variant === "focus" ? "btn sm primary" : "btn xs soft";
    const secondaryClass = variant === "focus" ? "btn sm" : "btn xs";
    if (stepId === "create_profile") {
      return (
        <>
          {onCreateProfile && (
            <button type="button" className={variant === "focus" ? primaryClass : "btn xs primary"} onClick={onCreateProfile}>
              {t("New profile")}
            </button>
          )}
          {onImportProfiles && (
            <button type="button" className={variant === "focus" ? secondaryClass : "btn xs ghost"} onClick={onImportProfiles}>
              {t("Import")}
            </button>
          )}
        </>
      );
    }
    if (stepId === "configure_proxy" && onOpenProxies) {
      return (
        <button type="button" className={variant === "focus" ? primaryClass : secondaryClass} onClick={onOpenProxies}>
          {t("Open proxies")}
        </button>
      );
    }
    if (stepId === "launch_profile" && onLaunchFirstProfile && firstProfileId) {
      return (
        <button
          type="button"
          className={primaryClass}
          onClick={() => onLaunchFirstProfile(firstProfileId)}
        >
          <AppIcon name="play" className="sm" />
          {t("Launch first profile")}
        </button>
      );
    }
    if (stepId === "explore_tools") {
      return tools.map(({ label, open }) => open && (
        <button
          key={label}
          type="button"
          className={secondaryClass}
          onClick={() => {
            if (onVisitTool) onVisitTool();
            else setLocalExplored(true);
            open();
          }}
        >
          {t(label)}
        </button>
      ));
    }
    return null;
  };

  const focusDescription = (step: OnboardingStepItem): string => {
    if (step.id === "create_profile") {
      return "Create your first isolated profile or import existing ones from a file.";
    }
    if (step.id === "configure_proxy") {
      return "Bind and test a dedicated exit IP, or skip this optional step.";
    }
    if (step.id === "launch_profile") {
      return firstProfileId
        ? step.description ?? "Open a profile to download the pinned engine on demand and verify startup."
        : "Create or import an environment first.";
    }
    return "Try built-in diagnostics, app lock protection, or automation scripts.";
  };

  return (
    <section
      className={`onboarding-banner${collapsed ? " onboarding-collapsed" : ""}`}
      data-onboarding-checklist={currentState}
      aria-labelledby={titleId}
    >
      <div
        className="onboarding-head"
        onClick={(event) => {
          const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
          if (target?.closest("button")) return;
          updateState(collapsed ? "open" : "collapsed");
        }}
      >
        <div className="onboarding-summary">
          <span className={`onboarding-badge${allCompleted ? " done" : ""}`} aria-hidden="true">
            <AppIcon name={allCompleted ? "check" : "star"} className="sm" />
          </span>
          <div className="onboarding-summary-labels">
            <h2 id={titleId} className="onboarding-title" tabIndex={-1}>{t("Quick-start checklist")}</h2>
            <span
              className={`onboarding-progress-pill${allCompleted ? " done" : ""}`}
              role="status"
              data-onboarding-progress={`${completedCount}/${totalCount}`}
            >
              <span className="onboarding-progress-bar" aria-hidden="true">
                <span style={{ width: `${progressPercent}%` }} />
              </span>
              <span>{t("{completed} / {total} completed", { completed: completedCount, total: totalCount })}</span>
            </span>
          </div>
        </div>
        <div className="onboarding-head-actions">
          <button
            type="button"
            className="btn xs ghost"
            aria-expanded={!collapsed}
            aria-controls={stepsId}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => updateState(collapsed ? "open" : "collapsed")}
          >
            <AppIcon name="chevronUp" className="sm onboarding-chevron" />
          </button>
          <button
            type="button"
            className="btn xs ghost"
            aria-label={t("Dismiss")}
            title={t("You can reopen this checklist anytime in Settings → General.")}
            onClick={() => updateState("dismissed")}
          >
            <AppIcon name="close" className="sm" />
          </button>
        </div>
      </div>

      <div
        className="onboarding-collapse-wrap"
        aria-hidden={collapsed || undefined}
        inert={collapsed || undefined}
      >
        <div className="onboarding-collapse-inner">
          <div className="onboarding-split">
            <div className={`onboarding-focus${allCompleted ? " is-all-done" : ""}`}>
              {nextStep ? (
                <>
                  <div className="onboarding-focus-copy">
                    <span className="onboarding-focus-eyebrow">
                      {t("Recommended next · Step {step} / {total}", { step: nextStepNumber, total: totalCount })}
                    </span>
                    <h3 className="onboarding-focus-title">{t(nextStep.title)}</h3>
                    <p className="onboarding-focus-desc">{t(focusDescription(nextStep))}</p>
                  </div>
                  <div className="onboarding-focus-actions">
                    {renderStepActions(nextStep.id, false, "focus")}
                  </div>
                </>
              ) : (
                <>
                  <div className="onboarding-focus-copy">
                    <span className="onboarding-focus-eyebrow">{t("Setup complete")}</span>
                    <h3 className="onboarding-focus-title">{t("All core steps are ready")}</h3>
                    <p className="onboarding-focus-desc">
                      {t("You can collapse or dismiss this checklist anytime, and reopen it in Settings → General.")}
                    </p>
                  </div>
                  <div className="onboarding-focus-actions">
                    <button type="button" className="btn sm" onClick={() => updateState("collapsed")}>
                      {t("Collapse")}
                    </button>
                  </div>
                </>
              )}
            </div>

            <ol id={stepsId} className="onboarding-steps" hidden={collapsed}>
              {steps.map((step, index) => {
                const isNext = nextStep?.id === step.id;
                return (
                  <li
                    key={step.id}
                    className={`onboarding-step${step.completed ? " done" : ""}${isNext ? " is-next" : ""}`}
                    data-onboarding-step={step.id}
                    data-completed={step.completed ? "true" : "false"}
                  >
                    <span className="onboarding-step-marker" aria-hidden="true">
                      {step.completed ? <AppIcon name="check" className="sm" /> : index + 1}
                    </span>
                    <div className="onboarding-step-body">
                      <div className="onboarding-step-title-row">
                        <strong>{t(step.title)}</strong>
                        {step.completed && <span className="sr-only">{t("Completed")}</span>}
                        {step.optional && !step.completed && <span className="onboarding-optional">{t("Optional")}</span>}
                      </div>
                      {step.id === "launch_profile" && !step.completed && !firstProfileId && (
                        <p>{t("Create or import an environment first.")}</p>
                      )}
                    </div>
                    <div className="onboarding-step-actions">
                      {renderStepActions(step.id, step.completed, "cell")}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
