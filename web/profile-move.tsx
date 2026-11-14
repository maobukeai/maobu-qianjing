import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createProfileMoveController, type ProfileMoveControllerOptions, type ProfileMoveState } from "./profile-move-controller.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage } from "./workspace-operations.tsx";
import { useTranslation } from "./i18n.tsx";
import "./profile-move.css";
export { createProfileMoveController, type ProfileMoveAttempt, type ProfileMoveController, type ProfileMoveResult, type ProfileMoveRoster, type ProfileMoveState } from "./profile-move-controller.ts";

export function useProfileMove({ readRoster }: Pick<ProfileMoveControllerOptions, "readRoster">) {
  const operations = useOptionalWorkspaceOperations(), latest = useRef({ readRoster, coordinator: operations?.coordinator });
  latest.current = { readRoster, coordinator: operations?.coordinator };
  const [controller] = useState(() => createProfileMoveController({
    readRoster: () => latest.current.readRoster(),
    workspaceId: () => latest.current.coordinator?.getSnapshot().workspaceId ?? null,
    acquire: workspaceId => {
      const coordinator = latest.current.coordinator;
      if (!coordinator) return { refreshing() {}, release() {} };
      const lease = coordinator.acquire("profile-move", workspaceId);
      return lease ? { refreshing: () => coordinator.setPhase(lease, "refreshing"), release: () => { coordinator.release(lease); } } : null;
    },
    blockedReason: workspaceId => {
      const snapshot = latest.current.coordinator?.getSnapshot();
      return workspaceId && snapshot?.workspaceId !== workspaceId ? "Return to the original workspace before checking or retrying this move." : snapshot ? workspaceOperationMessage(snapshot) : "A workspace task is in progress. Wait for it to finish before moving environments.";
    },
  }));
  useEffect(() => { controller.setActive(true); return () => controller.setActive(false); }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { state, busy: state.phase === "moving" || state.phase === "checking", submit: controller.submit, retry: controller.retry, recheck: controller.recheck, dismiss: controller.dismiss };
}

export interface ProfileMoveFeedbackProps { state: ProfileMoveState; onRetry: () => void; onRecheck: () => void; onDismiss: () => void; }
export function ProfileMoveFeedback({ state, onRetry, onRecheck, onDismiss }: ProfileMoveFeedbackProps) {
  const { t, language } = useTranslation(), id = useId();
  const [requestedPage, setPage] = useState(0);
  const retryButton = useRef<HTMLButtonElement>(null), checkButton = useRef<HTMLButtonElement>(null), dismissButton = useRef<HTMLButtonElement>(null);
  const focusAfterAction = useRef<{ kind: "retry" | "check"; origin: HTMLButtonElement } | null>(null);
  useEffect(() => { setPage(0); }, [state.attempt?.id]);
  useEffect(() => {
    if (state.phase !== "settled" || !focusAfterAction.current) return;
    const action = focusAfterAction.current; focusAfterAction.current = null;
    const document = action.origin.ownerDocument;
    if (document.activeElement !== document.body && document.activeElement !== action.origin) return;
    const first = action.kind === "retry" ? retryButton.current : checkButton.current;
    [first, checkButton.current, retryButton.current, dismissButton.current].find(button => button?.isConnected && !button.disabled)?.focus({ preventScroll: true });
  }, [state.phase, state.result, state.blockedReason]);
  if (!state.attempt && !state.blockedReason) return null;
  const pending = state.phase === "moving" || state.phase === "checking", result = state.result;
  const pages = Math.max(1, Math.ceil((result?.unresolvedIds.length ?? 0) / 50)), page = Math.min(requestedPage, pages - 1), missing = new Set(result?.missingIds);
  const group = state.attempt?.group || t("Ungrouped");
  const title = state.blockedReason ? "Move unavailable" : state.phase === "moving" ? "Moving environments…" : state.phase === "checking" ? "Checking the move result…" : result?.status === "confirmed" ? "Destination confirmed" : result?.status === "partial" ? "Move result needs review" : result?.status === "failed" ? "Move not completed" : "Move needs confirmation";
  return <section className={`profile-move-feedback${result?.status ? ` is-${result.status}` : ""}`} aria-labelledby={`${id}-title`} aria-busy={pending}>
    <div className="profile-move-heading"><div><h2 id={`${id}-title`}>{t(title)}</h2>{state.attempt && <p>{t("{count} selected environments → {group}", { count: state.attempt.ids.length.toLocaleString(language), group })}</p>}</div><button ref={dismissButton} className="iconbtn" type="button" disabled={pending} aria-label={t("Dismiss move result")} onClick={onDismiss}>×</button></div>
    {pending && <p className="profile-move-progress" role="status">{t(state.phase === "moving" ? "The selected environments and destination are fixed for this attempt." : "Waiting for the current environment list before clearing any selection.")}</p>}
    {state.blockedReason && <p className="profile-move-error" role="alert">{t(state.blockedReason)}</p>}
    {result && <><div className="profile-move-counts" role="status">{result.status !== "confirmed" && result.reportedMoved !== null && <span>{t("Server reported {count} group changes", { count: result.reportedMoved.toLocaleString(language) })}</span>}<span>{t("{count} confirmed in the destination", { count: result.confirmedIds.length.toLocaleString(language) })}</span>{result.unresolvedIds.length > 0 && <span>{t("{count} need review", { count: result.unresolvedIds.length.toLocaleString(language) })}</span>}</div>
      {result.message && <p className={`profile-move-note${result.status === "failed" || result.status === "unconfirmed" ? " is-error" : ""}`} role={result.status === "failed" || result.status === "unconfirmed" ? "alert" : "status"}>{t(result.message)}</p>}
      {result.status === "confirmed" ? <details className="profile-move-confirmation"><summary>{t("Move details")}</summary>{result.reportedMoved !== null && <p className="profile-move-note">{t("Server reported {count} group changes", { count: result.reportedMoved.toLocaleString(language) })}</p>}<p className="profile-move-note">{t("Confirmation includes environments already in this group. Moving groups can also apply the destination's extension defaults.")}</p></details> : result.confirmedIds.length > 0 && <p className="profile-move-note">{t("Confirmation includes environments already in this group. Moving groups can also apply the destination's extension defaults.")}</p>}
      {result.unresolvedIds.length > 0 && <details className="profile-move-details"><summary>{t("View environments needing review")}</summary><ul>{result.unresolvedIds.slice(page * 50, (page + 1) * 50).map(profileId => <li key={profileId}><code>{profileId}</code>{missing.has(profileId) && <span>{t("No longer listed")}</span>}</li>)}</ul>{pages > 1 && <div className="profile-move-actions"><button type="button" className="btn xs" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t("Previous")}</button><span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span><button type="button" className="btn xs" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{t("Next")}</button></div>}</details>}
      {(result.status !== "confirmed" || result.retryIds.length > 0) && <div className="profile-move-actions">{result.status !== "confirmed" && <button ref={checkButton} className="btn xs" type="button" disabled={pending} onClick={event => { focusAfterAction.current = { kind: "check", origin: event.currentTarget }; onRecheck(); }}>{t("Check result without moving again")}</button>}{result.retryIds.length > 0 && <button ref={retryButton} className="btn xs" type="button" disabled={pending} onClick={event => { focusAfterAction.current = { kind: "retry", origin: event.currentTarget }; onRetry(); }}>{t("Retry {count} unconfirmed destinations", { count: result.retryIds.length.toLocaleString(language) })}</button>}</div>}
    </>}
  </section>;
}
