import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLogs } from "../api.ts";
import { useTranslation } from "../i18n.tsx";
import { AppIcon, ModalDialog } from "../ui-primitives.tsx";
import "./log-modal.css";

type LogViewerState =
  | { kind: "loading" | "empty" | "error" }
  | { kind: "ready"; file: string; content: string };

export function useLogViewer(enabled: boolean, workspaceId: string | undefined) {
  const [view, setView] = useState<{ workspaceId: string | undefined; state: LogViewerState } | null>(null);
  const currentScope = useRef({ enabled, workspaceId });
  currentScope.current = { enabled, workspaceId };
  const active = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setView(null);
  }, []);

  useEffect(() => {
    if (!enabled) close();
    else setView(current => current?.workspaceId === workspaceId ? current : null);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [close, enabled, workspaceId]);

  const open = useCallback(() => {
    const scope = currentScope.current;
    if (!scope.enabled || active.current) return;
    const request = new AbortController();
    active.current = request;
    setView({ workspaceId: scope.workspaceId, state: { kind: "loading" } });
    const settle = (state: LogViewerState) => {
      if (active.current !== request) return;
      active.current = null;
      if (currentScope.current.enabled && currentScope.current.workspaceId === scope.workspaceId) {
        setView({ workspaceId: scope.workspaceId, state });
      }
    };
    void fetchLogs(AbortSignal.any([request.signal, AbortSignal.timeout(12_000)])).then(
      snapshot => settle(snapshot ? { kind: "ready", ...snapshot } : { kind: "empty" }),
      () => settle({ kind: "error" }),
    );
  }, []);

  return { state: enabled && view?.workspaceId === workspaceId ? view?.state ?? null : null, open, close };
}

export function LogModal({ state, onReload, onClose }: {
  state: LogViewerState | null;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const loading = state?.kind === "loading";
  const failed = state?.kind === "error";

  return (
    <ModalDialog
      open={state !== null}
      portal
      className="log-viewer"
      backdropClassName="log-viewer-backdrop"
      onClose={onClose}
      title={<><span className="modal-title-icon"><AppIcon name="logs" /></span>{t("Detailed logs")}</>}
      footer={
        <>
          <button className="btn ghost log-viewer-reload" type="button" aria-disabled={loading} onClick={onReload}>
            <AppIcon name="refresh" className="sm" />{t(failed ? "Retry" : "Refresh")}
          </button>
          <button className="btn" type="button" onClick={onClose}>{t("Close")}</button>
        </>
      }
    >
      {state?.kind === "ready" ? (
        <div className="log-viewer-file">
          <div className="log-viewer-filename"><AppIcon name="file" className="sm" /><bdi>{state.file}</bdi></div>
          {state.content.trim() ? (
            <pre className="log-viewer-output" tabIndex={0} role="region" aria-label={t("Log output")}>{state.content}</pre>
          ) : (
            <p className="log-viewer-state">{t("This log is empty.")}</p>
          )}
        </div>
      ) : state && (
        <div className="log-viewer-state" role={failed ? "alert" : "status"}>
          <span className="modal-title-icon"><AppIcon name={failed ? "alert" : loading ? "activity" : "logs"} /></span>
          <span>{t(failed ? "Logs could not be loaded." : loading ? "Loading logs…" : "No logs yet.")}</span>
        </div>
      )}
    </ModalDialog>
  );
}
