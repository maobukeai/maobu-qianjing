import { useSyncExternalStore } from "react";
import { fetchScriptRun } from "./api.ts";
import { createBackgroundScriptRunStore } from "./background-script-run-state.ts";
import { useTranslation } from "./i18n.tsx";
import "./scripts.css";

export const backgroundScriptRuns = createBackgroundScriptRunStore({ read: fetchScriptRun });
export function useBackgroundScriptRun() {
  return useSyncExternalStore(backgroundScriptRuns.subscribe, backgroundScriptRuns.getSnapshot, backgroundScriptRuns.getSnapshot);
}

/** A passive shell entry: no run is fetched or started by mounting this button. */
export function BackgroundScriptRunButton({ onViewRun }: { onViewRun: () => void }) {
  const { t } = useTranslation();
  const snapshot = useBackgroundScriptRun();
  if (!snapshot.run) return null;
  const { run, summary, state } = snapshot;
  const status = t(state === "unavailable" ? "Status unavailable" : state === "stopping" ? "Stopping" : state === "finished" ? "Finished" : "Running");
  return <button type="button" className={`btn xs ghost script-background-trigger${state === "unavailable" || summary.failed ? " has-issue" : ""}`} onClick={onViewRun}
    aria-label={t("View script run: {script}, {status}, {settled} of {total} environments settled", { script: run.scriptName, status, settled: summary.settled, total: summary.total })}
    title={snapshot.error ? t(snapshot.error) : t("{script}: {status}. Open the run monitor.", { script: run.scriptName, status })}>
    <span className={`script-background-dot ${state}`} aria-hidden="true" /><span>{t(state === "unavailable" ? "Script status unavailable" : state === "finished" ? "Script finished" : state === "stopping" ? "Script stopping" : "Script running")}</span><strong>{summary.settled}/{summary.total}</strong>
  </button>;
}
