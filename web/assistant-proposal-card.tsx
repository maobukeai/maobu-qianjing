import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import {
  abortAssistantProposal,
  executeAssistantProposal,
  fetchAssistantProposalSnapshot,
  type AnomalyCriterion,
  type CompiledProposalView,
  type ProposalExecutionItemReceipt,
  type ProposalExecutionSnapshot,
  type ProposalRiskLevel,
} from "./local-assistant-api.ts";
import "./assistant-proposal-card.css";

export interface AssistantProposalCardProps {
  proposal: CompiledProposalView;
  initialExecution?: ProposalExecutionSnapshot | null;
  disabled?: boolean;
  onLocateProfiles?: (profileIds: string[], criteria?: AnomalyCriterion[]) => void;
  onExecuted?: (snapshot: ProposalExecutionSnapshot) => void;
}

const RISK_LABEL: Record<ProposalRiskLevel, string> = {
  "read-only": "Read-only",
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

const ACTION_LABEL: Record<CompiledProposalView["actionType"], string> = {
  filter_anomalous_profiles: "Filter anomalies",
  batch_move_group: "Move group",
  batch_update_tags: "Update tags",
  batch_replace_failed_proxies: "Replace proxies (Vault)",
  batch_launch_profiles: "Batch launch",
  batch_stop_profiles: "Batch stop",
  generate_fingerprint_summary: "Fingerprint summary",
};

const ITEM_STATUS_LABEL: Record<ProposalExecutionItemReceipt["status"], string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  skipped: "Skipped",
  failed: "Failed",
  aborted: "Aborted",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AssistantProposalCard({
  proposal,
  initialExecution = null,
  disabled = false,
  onLocateProfiles,
  onExecuted,
}: AssistantProposalCardProps) {
  const { t } = useTranslation();
  const executableIds = useMemo(
    () => proposal.items.filter((item) => item.executable).map((item) => item.profileId),
    [proposal],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    proposal.items.filter((item) => item.defaultSelected).map((item) => item.profileId),
  );
  const [highRiskConfirmed, setHighRiskConfirmed] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [execution, setExecution] = useState<ProposalExecutionSnapshot | null>(initialExecution);
  const [aborting, setAborting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const streamAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamAbort.current?.abort();
      streamAbort.current = null;
    };
  }, []);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const receiptByProfileId = useMemo(() => {
    const map = new Map<string, ProposalExecutionItemReceipt>();
    for (const item of execution?.items ?? []) {
      map.set(item.profileId, item);
    }
    return map;
  }, [execution]);

  const phase = discarded ? "discarded" : execution?.status ?? "compiled";
  const isRunning = phase === "running";
  const isFinished = phase === "completed" || phase === "aborted" || phase === "failed";
  const isIdle = phase === "compiled";

  const retryableIds = useMemo(() => {
    if (!execution || isRunning) return [];
    return execution.items
      .filter((item) => item.status === "failed" || item.status === "aborted")
      .map((item) => item.profileId);
  }, [execution, isRunning]);

  const locatableIds = useMemo(() => {
    if (execution?.filterResult?.profileIds.length) {
      return execution.filterResult.profileIds;
    }
    if (execution) {
      const succeeded = execution.items.filter((item) => item.status === "succeeded").map((item) => item.profileId);
      if (succeeded.length > 0) return succeeded;
    }
    return selectedIds;
  }, [execution, selectedIds]);

  function toggleProfile(profileId: string) {
    if (!isIdle || disabled) return;
    setSelectedIds((current) =>
      current.includes(profileId) ? current.filter((id) => id !== profileId) : [...current, profileId],
    );
  }

  function selectAllExecutable() {
    if (!isIdle || disabled) return;
    setSelectedIds(executableIds);
  }

  function clearSelection() {
    if (!isIdle || disabled) return;
    setSelectedIds([]);
  }

  async function reconnectStatus() {
    if (!mounted.current) return;
    setReconnecting(true);
    setError("");
    try {
      const snapshot = await fetchAssistantProposalSnapshot(proposal.proposalId);
      if (!mounted.current) return;
      setExecution(snapshot.execution);
      setStreamDisconnected(false);
      if (snapshot.execution.status !== "running") {
        onExecuted?.(snapshot.execution);
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setReconnecting(false);
    }
  }

  async function runExecution(targetProfileIds: string[]) {
    if (disabled || isRunning || targetProfileIds.length === 0) return;
    if (proposal.requiresSecondaryConfirm && !highRiskConfirmed) return;

    setError("");
    setAborting(false);
    setStreamDisconnected(false);

    const controller = new AbortController();
    streamAbort.current = controller;

    const optimistic: ProposalExecutionSnapshot = {
      proposalId: proposal.proposalId,
      planHash: proposal.planHash,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      selectedProfileIds: targetProfileIds,
      total: targetProfileIds.length,
      completed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      aborted: 0,
      items: targetProfileIds.map((id) => {
        const meta = proposal.items.find((item) => item.profileId === id);
        return {
          profileId: id,
          profileName: meta?.profileName ?? id,
          status: "pending",
          beforeSummary: meta?.beforeSummary,
          afterSummary: meta?.afterSummary,
        };
      }),
    };
    setExecution(optimistic);

    try {
      const finalSnapshot = await executeAssistantProposal(
        proposal.proposalId,
        {
          planHash: proposal.planHash,
          selectedProfileIds: targetProfileIds,
          ...(proposal.requiresSecondaryConfirm ? { confirmHighRisk: true } : {}),
        },
        (event) => {
          if (!mounted.current) return;
          if (event.type === "start") {
            setExecution((current) =>
              current
                ? {
                    ...current,
                    status: "running",
                    startedAt: event.startedAt,
                    total: event.total,
                  }
                : current,
            );
          } else if (event.type === "item") {
            setExecution((current) => {
              if (!current) return current;
              const nextItems = [...current.items];
              nextItems[event.index] = event.item;
              let succeeded = 0;
              let skipped = 0;
              let failed = 0;
              let aborted = 0;
              for (const row of nextItems) {
                if (row.status === "succeeded") succeeded++;
                else if (row.status === "skipped") skipped++;
                else if (row.status === "failed") failed++;
                else if (row.status === "aborted") aborted++;
              }
              return {
                ...current,
                completed: event.completed,
                total: event.total,
                succeeded,
                skipped,
                failed,
                aborted,
                items: nextItems,
              };
            });
          } else if (event.type === "summary" || event.type === "aborted") {
            setExecution(event.snapshot);
            onExecuted?.(event.snapshot);
          } else if (event.type === "error") {
            setError(event.error);
          }
        },
        controller.signal,
      );

      if (!mounted.current) return;
      if (finalSnapshot) {
        setExecution(finalSnapshot);
      } else {
        // Stream ended without terminal summary/aborted frame; reconnect to server snapshot.
        setStreamDisconnected(true);
        await reconnectStatus();
      }
    } catch (err) {
      if (!mounted.current) return;
      setError(errorText(err));
      setStreamDisconnected(true);
      try {
        const recovered = await fetchAssistantProposalSnapshot(proposal.proposalId);
        if (mounted.current) {
          setExecution(recovered.execution);
          if (recovered.execution.status !== "running") {
            setStreamDisconnected(false);
          }
        }
      } catch {
        // Keep the stream error visible and expose manual Reconnect status button.
        setExecution((current) => (current?.status === "running" ? { ...current, status: "failed" } : current));
      }
    } finally {
      if (streamAbort.current === controller) {
        streamAbort.current = null;
      }
      if (mounted.current) {
        setAborting(false);
      }
    }
  }

  async function handleEmergencyStop() {
    if (!isRunning || aborting) return;
    setAborting(true);
    setError("");
    try {
      const result = await abortAssistantProposal(proposal.proposalId);
      if (mounted.current) {
        setExecution(result.snapshot);
      }
    } catch (err) {
      if (mounted.current) {
        setError(errorText(err));
        setAborting(false);
      }
    }
  }

  if (discarded) {
    return (
      <section
        className="proposal-card"
        data-phase="discarded"
        data-proposal-id={proposal.proposalId}
        aria-label={t("Action proposal")}
      >
        <span>{t("Action proposal discarded.")}</span>
      </section>
    );
  }

  const progressTotal = execution?.total ?? 0;
  const progressCompleted = execution?.completed ?? 0;
  const progressRatio = progressTotal > 0 ? Math.min(1, Math.max(0, progressCompleted / progressTotal)) : 0;
  const canConfirm =
    isIdle &&
    !disabled &&
    selectedIds.length > 0 &&
    (!proposal.requiresSecondaryConfirm || highRiskConfirmed);

  return (
    <section
      className="proposal-card"
      data-risk={proposal.risk}
      data-phase={phase}
      data-proposal-id={proposal.proposalId}
      aria-label={t("Action proposal")}
    >
      <header className="proposal-card-header">
        <div className="proposal-card-heading">
          <div className="proposal-card-eyebrow">
            <span className="proposal-risk-badge" data-risk={proposal.risk}>
              {t(RISK_LABEL[proposal.risk])}
            </span>
            <span className="proposal-action-chip">{t(ACTION_LABEL[proposal.actionType])}</span>
            {phase !== "compiled" && (
              <span className="proposal-phase-badge" data-phase={phase}>
                {t(
                  phase === "running"
                    ? "Running"
                    : phase === "completed"
                      ? "Completed"
                      : phase === "aborted"
                        ? "Emergency stopped"
                        : "Failed",
                )}
              </span>
            )}
          </div>
          <h4 className="proposal-card-title">{proposal.title}</h4>
          {proposal.summary && proposal.summary !== proposal.title && (
            <p className="proposal-card-summary">{proposal.summary}</p>
          )}
        </div>
      </header>

      {proposal.warnings.length > 0 && (
        <div className="proposal-warnings" role="status">
          {proposal.warnings.map((warning) => (
            <p key={warning.code} className="proposal-warning-item" data-warning-code={warning.code}>
              {warning.message}
            </p>
          ))}
        </div>
      )}

      <div className="proposal-scope-bar">
        <div className="proposal-scope-stats">
          <span>
            {t("Targets: {count}", { count: proposal.counts.total })}
          </span>
          <span>
            <strong>{t("Selected: {count}", { count: selectedIds.length })}</strong>
          </span>
          <span>
            {t("Actionable: {count}", { count: proposal.counts.actionable })}
          </span>
          {proposal.counts.skipped > 0 && (
            <span>{t("Skipped: {count}", { count: proposal.counts.skipped })}</span>
          )}
        </div>
        {isIdle && executableIds.length > 1 && (
          <div className="proposal-scope-actions">
            <button
              type="button"
              className="btn xs ghost"
              disabled={disabled || selectedIds.length === executableIds.length}
              onClick={selectAllExecutable}
            >
              {t("Select all")}
            </button>
            <button
              type="button"
              className="btn xs ghost"
              disabled={disabled || selectedIds.length === 0}
              onClick={clearSelection}
            >
              {t("Clear selection")}
            </button>
          </div>
        )}
      </div>

      {execution && progressTotal > 0 && (
        <div className="proposal-progress" role="status" aria-live="polite">
          <div className="proposal-progress-row">
            <span>
              {isRunning
                ? t("Executing {completed} of {total}…", { completed: progressCompleted, total: progressTotal })
                : phase === "aborted"
                  ? t("Stopped after {completed} of {total}", { completed: progressCompleted, total: progressTotal })
                  : t("Finished {completed} of {total}", { completed: progressCompleted, total: progressTotal })}
            </span>
            <span>{Math.round(progressRatio * 100)}%</span>
          </div>
          <div className="proposal-progress-track" aria-hidden="true">
            <div
              className="proposal-progress-fill"
              data-tone={phase}
              style={{ transform: `scaleX(${progressRatio})` }}
            />
          </div>
        </div>
      )}

      <div className="proposal-table-wrap">
        <table className="proposal-table">
          <thead>
            <tr>
              <th className="proposal-col-check">
                <span className="sr-only">{t("Select")}</span>
              </th>
              <th>{t("Profile")}</th>
              <th>{t("Planned change")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {proposal.items.map((item) => {
              const checked = selectedSet.has(item.profileId);
              const receipt = receiptByProfileId.get(item.profileId);
              return (
                <tr key={item.profileId} data-executable={item.executable ? "true" : "false"}>
                  <td className="proposal-col-check">
                    <input
                      type="checkbox"
                      aria-label={t("Select {name}", { name: item.profileName || item.profileId })}
                      checked={checked}
                      disabled={!isIdle || !item.executable || disabled}
                      onChange={() => toggleProfile(item.profileId)}
                    />
                  </td>
                  <td className="proposal-profile-cell">
                    <strong>{item.profileName || item.profileId}</strong>
                    <code>{item.profileId}</code>
                  </td>
                  <td>
                    <div className="proposal-diff">
                      <span className="proposal-diff-before">{item.beforeSummary}</span>
                      <span className="proposal-diff-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="proposal-diff-after">{item.afterSummary}</span>
                    </div>
                    {!item.executable && item.skipDetail && (
                      <div className="proposal-skip-detail">{item.skipDetail}</div>
                    )}
                    {receipt?.detail && (
                      <div className="proposal-skip-detail">{receipt.detail}</div>
                    )}
                  </td>
                  <td>
                    {receipt ? (
                      <span className="proposal-item-status" data-status={receipt.status}>
                        {t(ITEM_STATUS_LABEL[receipt.status])}
                      </span>
                    ) : item.executable ? (
                      <span className="proposal-item-status" data-status="pending">
                        {t("Ready")}
                      </span>
                    ) : (
                      <span className="proposal-item-status" data-status="skipped">
                        {t("Skipped")}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {execution?.fingerprintSummary && (
        <div className="proposal-fp-summary" aria-label={t("Fingerprint summary")}>
          <div className="proposal-fp-grid">
            <div className="proposal-fp-stat" data-tone="good">
              <strong>{execution.fingerprintSummary.consistent}</strong>
              <span>{t("Consistent")}</span>
            </div>
            <div className="proposal-fp-stat" data-tone="warn">
              <strong>{execution.fingerprintSummary.review}</strong>
              <span>{t("Needs review")}</span>
            </div>
            <div className="proposal-fp-stat" data-tone="danger">
              <strong>{execution.fingerprintSummary.issues}</strong>
              <span>{t("Issues")}</span>
            </div>
            <div className="proposal-fp-stat">
              <strong>{execution.fingerprintSummary.unmeasured}</strong>
              <span>{t("Unmeasured")}</span>
            </div>
          </div>
          {execution.fingerprintSummary.topChecks.length > 0 && (
            <ul className="proposal-fp-checks">
              {execution.fingerprintSummary.topChecks.map((check) => (
                <li key={check.id}>
                  {check.label}: {t("{fail} failed, {warn} warnings", { fail: check.failCount, warn: check.warnCount })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isIdle && proposal.requiresSecondaryConfirm && executableIds.length > 0 && (
        <div className="proposal-secondary-confirm">
          <label>
            <input
              type="checkbox"
              checked={highRiskConfirmed}
              disabled={disabled}
              onChange={(event) => setHighRiskConfirmed(event.target.checked)}
            />
            <span>
              {t("High-risk confirmation: I reviewed the target profiles and confirm replacing their proxies from Proxy Vault.")}
            </span>
          </label>
        </div>
      )}

      {error && (
        <p className="proposal-error" role="alert">
          {error}
        </p>
      )}

      <footer className="proposal-footer">
        <div className="proposal-receipt-counts">
          {execution ? (
            <>
              <span>{t("Succeeded: {count}", { count: execution.succeeded })}</span>
              <span>{t("Skipped: {count}", { count: execution.skipped })}</span>
              {execution.failed > 0 && <span>{t("Failed: {count}", { count: execution.failed })}</span>}
              {execution.aborted > 0 && <span>{t("Aborted: {count}", { count: execution.aborted })}</span>}
            </>
          ) : (
            <span>{t("Review targets before executing. Nothing runs automatically.")}</span>
          )}
        </div>

        <div className="proposal-footer-actions">
          {isIdle && (
            <>
              <button
                type="button"
                className="btn xs ghost"
                disabled={disabled}
                onClick={() => setDiscarded(true)}
              >
                {t("Discard")}
              </button>
              <button
                type="button"
                className="btn xs primary"
                disabled={!canConfirm}
                onClick={() => void runExecution(selectedIds)}
              >
                {t("Confirm & execute ({count})", { count: selectedIds.length })}
              </button>
            </>
          )}

          {isRunning && (
            <>
              {streamDisconnected && (
                <button
                  type="button"
                  className="btn xs"
                  disabled={reconnecting}
                  onClick={() => void reconnectStatus()}
                >
                  {t("Reconnect status")}
                </button>
              )}
              <button
                type="button"
                className="btn xs solid-danger"
                disabled={aborting}
                onClick={() => void handleEmergencyStop()}
              >
                {t(aborting ? "Stopping…" : "Emergency stop")}
              </button>
            </>
          )}

          {isFinished && (
            <>
              {streamDisconnected && (
                <button
                  type="button"
                  className="btn xs"
                  disabled={reconnecting}
                  onClick={() => void reconnectStatus()}
                >
                  {t("Reconnect status")}
                </button>
              )}
              {onLocateProfiles && locatableIds.length > 0 && (
                <button
                  type="button"
                  className="btn xs"
                  onClick={() =>
                    onLocateProfiles(
                      locatableIds,
                      proposal.action.type === "filter_anomalous_profiles" ? proposal.action.criteria : undefined,
                    )
                  }
                >
                  {t("Locate in profile list")}
                </button>
              )}
              {retryableIds.length > 0 && (
                <button
                  type="button"
                  className="btn xs primary"
                  disabled={disabled || (proposal.requiresSecondaryConfirm && !highRiskConfirmed)}
                  onClick={() => void runExecution(retryableIds)}
                >
                  {t("Retry failed ({count})", { count: retryableIds.length })}
                </button>
              )}
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
