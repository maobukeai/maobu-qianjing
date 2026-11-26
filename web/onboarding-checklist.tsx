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

  return (
    <section
      className={`onboarding-banner${collapsed ? " onboarding-collapsed" : ""}`}
      data-onboarding-checklist={currentState}
      aria-labelledby={titleId}
    >
      <div className="onboarding-head">
        <div className="onboarding-summary">
          <span className="onboarding-badge" aria-hidden="true">
            <AppIcon name={allCompleted ? "check" : "star"} className="sm" />
          </span>
          <div className="onboarding-summary-labels">
            <h2 id={titleId} className="onboarding-title" tabIndex={-1}>{t("Quick-start checklist")}</h2>
            <span className="onboarding-progress-pill" role="status" data-onboarding-progress={`${completedCount}/${totalCount}`}>
              {t("{completed} / {total} completed", { completed: completedCount, total: totalCount })}
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
            <AppIcon name={collapsed ? "chevronDown" : "chevronUp"} className="sm" />
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

      <ol id={stepsId} className="onboarding-steps" hidden={collapsed}>
          {!collapsed && steps.map((step) => (
            <li
              key={step.id}
              className={`onboarding-step${step.completed ? " done" : ""}`}
              data-onboarding-step={step.id}
              data-completed={step.completed ? "true" : "false"}
            >
              <span className="onboarding-step-marker" aria-hidden="true">
                {step.completed && <AppIcon name="check" className="sm" />}
              </span>
              <div className="onboarding-step-body">
                <div className="onboarding-step-title-row">
                  <strong>{t(step.title)}</strong>
                  {step.completed && <span className="sr-only">{t("Completed")}</span>}
                  {step.optional && !step.completed && <span className="onboarding-optional">{t("Optional")}</span>}
                </div>
                {!step.completed && step.description && <p>{t(step.id === "launch_profile" && !firstProfileId ? "Create or import an environment first." : step.description)}</p>}
              </div>
              <div className="onboarding-step-actions">
                {step.id === "create_profile" && !step.completed && (
                  <>
                    {onCreateProfile && (
                      <button type="button" className="btn xs primary" onClick={onCreateProfile}>
                        {t("New profile")}
                      </button>
                    )}
                    {onImportProfiles && (
                      <button type="button" className="btn xs ghost" onClick={onImportProfiles}>
                        {t("Import")}
                      </button>
                    )}
                  </>
                )}
                {step.id === "configure_proxy" && !step.completed && onOpenProxies && (
                  <button type="button" className="btn xs" onClick={onOpenProxies}>
                    {t("Open proxies")}
                  </button>
                )}
                {step.id === "launch_profile" && !step.completed && onLaunchFirstProfile && firstProfileId && (
                  <button
                    type="button"
                    className="btn xs"
                    onClick={() => onLaunchFirstProfile(firstProfileId)}
                  >
                    <AppIcon name="play" className="sm" />
                    {t("Launch first profile")}
                  </button>
                )}
                {step.id === "explore_tools" && !step.completed && tools.map(({ label, open }) => open && (
                  <button
                    key={label}
                    type="button"
                    className="btn xs"
                    onClick={() => {
                      if (onVisitTool) onVisitTool();
                      else setLocalExplored(true);
                      open();
                    }}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </li>
          ))}
      </ol>
    </section>
  );
}
