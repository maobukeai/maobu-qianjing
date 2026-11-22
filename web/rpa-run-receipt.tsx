import { useEffect, useState } from "react";
import type { ScriptArtifactRecord } from "../contracts/local.ts";
import type { ScriptRun, ScriptRunProfile } from "../scripts.ts";
import { useTranslation } from "./i18n.tsx";
import { fetchScriptArtifactBlob, fetchScriptRuns, stopScriptRunById } from "./rpa-api.ts";
import "./rpa-studio.css";

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function runStatusLabel(
  status: ScriptRun["status"] | ScriptRunProfile["status"],
  t: (key: string, values?: Record<string, string | number>) => string,
  queuePosition?: number,
): string {
  if (status === "queued" && queuePosition) {
    return t("Queued (#{pos})", { pos: queuePosition });
  }
  const labels = {
    queued: "Queued",
    running: "Running",
    stopping: "Stopping",
    finished: "Finished",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  } as const;
  return t(labels[status]);
}

function AuthenticatedArtifactThumb({
  runId,
  profileId,
  artifact,
  onPreview,
}: {
  runId: string;
  profileId: string;
  artifact: ScriptArtifactRecord;
  onPreview: (url: string, artifact: ScriptArtifactRecord) => void;
}) {
  const { t } = useTranslation();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let createdUrl: string | null = null;
    setObjectUrl(null);
    setFailed(false);

    void fetchScriptArtifactBlob(runId, profileId, artifact.fileName, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });

    return () => {
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [runId, profileId, artifact.fileName]);

  const title = artifact.kind === "error" ? t("Error snapshot") : artifact.label;

  return (
    <button
      type="button"
      className={`rpa-artifact-thumb${artifact.kind === "error" ? " error" : ""}`}
      disabled={!objectUrl}
      onClick={() => {
        if (objectUrl) onPreview(objectUrl, artifact);
      }}
      title={title}
    >
      {objectUrl ? (
        <img src={objectUrl} alt={title} />
      ) : (
        <div className="rpa-artifact-thumb-placeholder">
          {failed ? t("Preview unavailable") : t("Loading image…")}
        </div>
      )}
      <div className="rpa-artifact-caption">
        <span>{title}</span>
        <span>{Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB</span>
      </div>
    </button>
  );
}

/** Renders per-profile step timeline and authenticated screenshot gallery for a single ScriptRunProfile. */
export function RpaProfileReceipt({
  runId,
  profile,
}: {
  runId: string;
  profile: ScriptRunProfile;
}) {
  const { t } = useTranslation();
  const [lightbox, setLightbox] = useState<{ url: string; artifact: ScriptArtifactRecord } | null>(null);
  const steps = profile.steps ?? [];
  const screenshots = profile.screenshots ?? [];

  if (steps.length === 0 && screenshots.length === 0) {
    return null;
  }

  return (
    <div className="rpa-receipt-block">
      {steps.length > 0 && (
        <ul className="rpa-receipt-steps" aria-label={t("Execution steps")}>
          {steps.map((step) => (
            <li key={step.index} className={`rpa-receipt-step ${step.status}`}>
              <span className="rpa-receipt-step-title">
                <strong>#{step.index}</strong>
                <span>{step.title}</span>
                {step.error && <small>· {step.error}</small>}
              </span>
              <span className="rpa-receipt-duration">
                {step.status === "running"
                  ? t("Running")
                  : step.status === "failed"
                    ? `${t("Failed")}${step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ""}`
                    : formatDuration(step.durationMs) || t("Succeeded")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {screenshots.length > 0 && (
        <div className="rpa-artifacts-grid" aria-label={t("Captured screenshots")}>
          {screenshots.map((artifact) => (
            <AuthenticatedArtifactThumb
              key={artifact.fileName}
              runId={runId}
              profileId={profile.id}
              artifact={artifact}
              onPreview={(url, item) => setLightbox({ url, artifact: item })}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <div
          className="rpa-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t("Screenshot preview")}
          onClick={() => setLightbox(null)}
        >
          <div className="rpa-lightbox-card" onClick={(event) => event.stopPropagation()}>
            <div className="script-source-header">
              <strong>
                {lightbox.artifact.kind === "error" ? t("Error snapshot") : lightbox.artifact.label} ({lightbox.artifact.fileName})
              </strong>
              <button type="button" className="btn xs ghost" onClick={() => setLightbox(null)}>
                {t("Close")}
              </button>
            </div>
            <img src={lightbox.url} alt={lightbox.artifact.label} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Full Run Queue & Execution Receipts panel (`GET /ui/api/scripts/runs`). */
export function RpaRunsQueuePanel({
  active = true,
  onObservedRun,
}: {
  active?: boolean;
  onObservedRun?: (run: ScriptRun) => void;
}) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const list = await fetchScriptRuns();
      setRuns(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async (quiet: boolean) => {
      if (!alive) return;
      if (!quiet) setLoading(true);
      try {
        const list = await fetchScriptRuns();
        if (!alive) return;
        setRuns(list);
        setError(null);
        const hasPending = list.some((run) => run.status !== "finished");
        if (hasPending) {
          timer = window.setTimeout(() => void tick(true), 1500);
        }
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive && !quiet) setLoading(false);
      }
    };

    void tick(false);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active]);

  const stopRun = async (runId: string) => {
    setStoppingId(runId);
    setError(null);
    try {
      const updated = await stopScriptRunById(runId);
      setRuns((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      onObservedRun?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingId(null);
    }
  };

  return (
    <div className="rpa-runs-list">
      <div className="script-source-header">
        <div>
          <strong>{t("Run queue & execution receipts")}</strong>
        </div>
        <button type="button" className="btn xs ghost" disabled={loading} onClick={() => void loadRuns(false)}>
          {loading ? t("Loading…") : t("Refresh runs")}
        </button>
      </div>

      {error && <div className="modal-err" role="alert">{error}</div>}

      {runs.length === 0 && !loading ? (
        <div className="emptystate scripts-empty">
          <b>{t("No script runs recorded yet.")}</b>
          <p>{t("Run a saved script or built-in template to view step timings and error screenshots here.")}</p>
        </div>
      ) : (
        runs.map((run) => {
          const canStop = run.status === "queued" || run.status === "running";
          const succeeded = run.profiles.filter((p) => p.status === "succeeded").length;
          const failed = run.profiles.filter((p) => p.status === "failed").length;
          return (
            <section key={run.id} className="rpa-run-card" data-run-id={run.id}>
              <header className="rpa-run-card-head">
                <div className="rpa-run-card-title">
                  <strong>{run.scriptName}</strong>
                  <span className="chip">{runStatusLabel(run.status, t, run.queuePosition)}</span>
                  <span className="rpa-receipt-duration">
                    {t("{succeeded} ok · {failed} failed · {total} total", {
                      succeeded,
                      failed,
                      total: run.profiles.length,
                    })}
                    {run.durationMs !== undefined ? ` · ${formatDuration(run.durationMs)}` : ""}
                  </span>
                </div>
                {canStop && (
                  <button
                    type="button"
                    className="btn xs danger"
                    disabled={stoppingId === run.id}
                    onClick={() => void stopRun(run.id)}
                  >
                    {run.status === "queued" ? t("Cancel queued batch") : t("Stop batch")}
                  </button>
                )}
              </header>
              <div className="rpa-run-card-body">
                {run.profiles.map((profile) => (
                  <div key={profile.id} className="rpa-run-profile-box">
                    <div className="rpa-run-profile-head">
                      <span>
                        <strong>{profile.name}</strong>
                      </span>
                      <span className="rpa-receipt-duration">
                        {runStatusLabel(profile.status, t)}
                        {profile.durationMs !== undefined ? ` · ${formatDuration(profile.durationMs)}` : ""}
                      </span>
                    </div>
                    {profile.error && <small className="modal-err">{profile.error}</small>}
                    {profile.warning && <small className="formnote">{profile.warning}</small>}
                    <RpaProfileReceipt runId={run.id} profile={profile} />
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
