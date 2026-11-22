import * as React from "react";
import { useEffect, useState } from "react";
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
  description: string;
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
      description: "Set up an isolated browser environment or import an existing batch.",
      optional: false,
      completed: hasProfile,
    },
    {
      id: "configure_proxy",
      title: "Configure or test a proxy",
      description: "Bind a proxy to a profile or add healthy proxies in Proxy Vault.",
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
      description: "Try the system diagnostics box, local app lock, or RPA script templates.",
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
    headers: { Accept: "application/json" },
  });
  const capBody = (await capRes.json().catch(() => null)) as { ok?: boolean; token?: string } | null;
  if (!capRes.ok || !capBody?.ok || typeof capBody.token !== "string") {
    throw new Error("Could not acquire workspace capability.");
  }
  const saveRes = await fetch("/ui/api/workspace/preferences", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Maobu-Workspace-Capability": capBody.token,
    },
    body: JSON.stringify({ key: ONBOARDING_STATE_KEY, value: state }),
  });
  const saveBody = (await saveRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
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
}: OnboardingChecklistProps) {
  const { t } = useTranslation();
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
  const percent = Math.round((completedCount / totalCount) * 100);
  const allCompleted = completedCount === totalCount;
  const firstProfileId = profiles[0]?.id;

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

  if (currentState === "collapsed") {
    return (
      <section
        className="onboarding-banner onboarding-collapsed"
        data-onboarding-checklist="collapsed"
        aria-label={t("Quick-start checklist")}
      >
        <div className="onboarding-head">
          <span className="onboarding-badge">
            <AppIcon name="star" className="sm" />
          </span>
          <strong className="onboarding-title">{t("Quick-start checklist")}</strong>
          <span className="onboarding-progress-pill">
            {t("{completed} / {total} completed", { completed: completedCount, total: totalCount })}
          </span>
          <div className="onboarding-head-actions">
            <button
              type="button"
              className="btn xs ghost"
              onClick={() => updateState("open")}
            >
              <AppIcon name="chevronDown" className="sm" />
              {t("Expand")}
            </button>
            <button
              type="button"
              className="btn xs ghost"
              onClick={() => updateState("dismissed")}
            >
              <AppIcon name="close" className="sm" />
              {t("Dismiss")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="onboarding-banner"
      data-onboarding-checklist="open"
      aria-label={t("Quick-start checklist")}
    >
      <div className="onboarding-head">
        <span className="onboarding-badge">
          <AppIcon name={allCompleted ? "check" : "star"} className="sm" />
        </span>
        <div className="onboarding-title-group">
          <strong className="onboarding-title">
            {allCompleted
              ? t("Workspace ready — all quick-start steps completed")
              : t("Get started in 30 seconds")}
          </strong>
          <span className="onboarding-subtitle">
            {t("No popups, no blockers. Steps check off automatically as you work.")}
          </span>
        </div>
        <span className="onboarding-progress-pill" data-onboarding-progress={`${completedCount}/${totalCount}`}>
          {t("{completed} / {total} completed", { completed: completedCount, total: totalCount })}
        </span>
        <div className="onboarding-head-actions">
          <button
            type="button"
            className="btn xs ghost"
            onClick={() => updateState("collapsed")}
          >
            <AppIcon name="chevronUp" className="sm" />
            {t("Collapse")}
          </button>
          <button
            type="button"
            className="btn xs ghost"
            onClick={() => updateState("dismissed")}
          >
            <AppIcon name="close" className="sm" />
            {t("Dismiss")}
          </button>
        </div>
      </div>

      <div className="onboarding-bar" aria-hidden="true">
        <div className="onboarding-bar-fill" style={{ width: `${percent}%` }} />
      </div>

      <ol className="onboarding-steps">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={`onboarding-step${step.completed ? " done" : ""}`}
            data-onboarding-step={step.id}
            data-completed={step.completed ? "true" : "false"}
          >
            <span className="onboarding-step-marker" aria-hidden="true">
              {step.completed ? <AppIcon name="check" className="sm" /> : index + 1}
            </span>
            <div className="onboarding-step-body">
              <div className="onboarding-step-title-row">
                <strong>{t(step.title)}</strong>
                {step.optional && <span className="onboarding-optional">{t("Optional")}</span>}
              </div>
              <p>{t(step.description)}</p>
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
              {step.id === "launch_profile" && !step.completed && onLaunchFirstProfile && (
                <button
                  type="button"
                  className="btn xs"
                  disabled={!firstProfileId}
                  onClick={() => {
                    if (firstProfileId) onLaunchFirstProfile(firstProfileId);
                  }}
                >
                  <AppIcon name="play" className="sm" />
                  {t("Launch first profile")}
                </button>
              )}
              {step.id === "explore_tools" && !step.completed && (
                <>
                  {onOpenDiagnostics && (
                    <button
                      type="button"
                      className="btn xs ghost"
                      onClick={() => {
                        setLocalExplored(true);
                        onOpenDiagnostics();
                      }}
                    >
                      {t("Diagnostics")}
                    </button>
                  )}
                  {onOpenAppLock && (
                    <button
                      type="button"
                      className="btn xs ghost"
                      onClick={() => {
                        setLocalExplored(true);
                        onOpenAppLock();
                      }}
                    >
                      {t("App lock")}
                    </button>
                  )}
                  {onOpenScripts && (
                    <button
                      type="button"
                      className="btn xs ghost"
                      onClick={() => {
                        setLocalExplored(true);
                        onOpenScripts();
                      }}
                    >
                      {t("Scripts")}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="onboarding-footer">
        <span>{t("You can reopen this checklist anytime in Settings → General.")}</span>
      </div>
    </section>
  );
}
