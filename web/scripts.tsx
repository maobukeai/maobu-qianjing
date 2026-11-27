import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./scripts.css";
import "./rpa-studio.css";
import type {
  ScriptInput,
  ScriptLanguage,
  ScriptRecord,
  ScriptSummary,
} from "../contracts/local.ts";
import type { ScriptRun } from "../src/scripts.ts";
import type { PythonRuntimeStatus } from "../src/python-runtime.ts";
import type { UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
import { AppIcon, useConfirmDialog } from "./ui-primitives.tsx";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { hasActiveWorkbenchModal } from "./workbench-shortcuts.ts";
import { backgroundScriptRuns, useBackgroundScriptRun } from "./background-script-run.tsx";
import { createScriptDetailsDrafts, scriptDetailsWithDraft } from "./script-details-drafts.ts";
import { RpaRecorderPanel } from "./rpa-recorder-panel.tsx";
import { RpaProfileReceipt, RpaRunsQueuePanel } from "./rpa-run-receipt.tsx";
import { RpaTemplatesPanel } from "./rpa-templates-panel.tsx";
import { startQueuedScriptRun } from "./rpa-api.ts";
import {
  createScript,
  deleteScript,
  downloadPythonRuntime,
  fetchPythonRuntime,
  fetchScript,
  fetchScripts,
  fetchScriptLog,
  scriptsDesktopAvailable,
  startScriptRun,
  stopScriptRun,
  updateScript,
} from "./api.ts";

function languageFor(file: File): ScriptLanguage | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "javascript";
  if (name.endsWith(".py")) return "python";
  return null;
}

function fileTitle(file: File): string {
  return file.name.replace(/\.(?:mjs|js|py)$/i, "") || file.name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function languageName(language: ScriptLanguage): string {
  return language === "python" ? "Python" : "JavaScript";
}

function scriptStatusLabel(
  status: ScriptRun["status"] | ScriptRun["profiles"][number]["status"],
  t: (key: string) => string,
): string {
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

function formatDurationMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The Python runtime status while `active`; polls while it downloads. */
function usePythonRuntime(active: boolean): [PythonRuntimeStatus | null, () => void] {
  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: number | undefined;
    const poll = () => {
      void fetchPythonRuntime().then((next) => {
        if (!live) return;
        setStatus(next);
        if (next?.state === "downloading") timer = window.setTimeout(poll, 1000);
      }).catch((error) => {
        console.warn("Failed to fetch Python runtime status:", error);
      });
    };
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [active, round]);
  const download = () => {
    void downloadPythonRuntime().then(() => setRound((value) => value + 1)).catch((error) => {
      console.warn("Failed to start Python runtime download:", error);
    });
  };
  return [active ? status : null, download];
}

function PythonRuntimeNote({ status, onDownload }: { status: PythonRuntimeStatus | null; onDownload: () => void }) {
  const { t } = useTranslation();
  if (!status || status.state === "ready") return null;
  const size = `${Math.round(status.totalBytes / 1e6)} MB`;
  if (status.state === "downloading") {
    const percent = Math.floor(status.receivedBytes * 100 / status.totalBytes);
    return <p className="formnote" role="status">{percent >= 100
      ? t("Installing the Python runtime for Python scripts…")
      : t("Downloading the Python runtime for Python scripts: {percent}% of {size}.", { percent: String(percent), size })}</p>;
  }
  if (status.state === "failed") {
    return <div className="modal-err" role="alert">{t("The Python runtime for Python scripts could not be downloaded: {error}. Check your internet connection.", { error: status.error ?? "" })} <button className="btn" type="button" onClick={onDownload}>{t("Try again")}</button></div>;
  }
  return <p className="formnote">{t("Python scripts need the Python runtime ({size}). It downloads once, before the first Python script runs.", { size })} <button className="btn" type="button" onClick={onDownload}>{t("Download now")}</button></p>;
}

const SCRIPT_RELOAD_REQUIRED = new Set([
  "Script changed; reload before saving",
  "Script changed; reload before deleting",
  "Script not found",
]);
const SCRIPT_RECORD_UNCONFIRMED = "The script response could not be confirmed. Reload the saved script and review your draft.";

function validScriptRecord(record: ScriptRecord | null | undefined): record is ScriptRecord {
  return !!record && typeof record.id === "string" && record.id.length > 0
    && Number.isSafeInteger(record.revision) && record.revision > 0
    && typeof record.name === "string" && typeof record.description === "string"
    && typeof record.source === "string" && typeof record.createdAt === "string" && typeof record.updatedAt === "string"
    && (record.language === "javascript" || record.language === "python");
}

function confirmsScriptWrite(record: ScriptRecord, input: ScriptInput, before?: ScriptRecord): boolean {
  return validScriptRecord(record) && record.revision === (before?.revision ?? 0) + 1
    && (!before || record.id === before.id && record.createdAt === before.createdAt)
    && record.name === input.name.trim() && record.description === input.description
    && record.language === input.language && record.source === input.source;
}

type RpaStudioTab = "scripts" | "templates" | "recorder" | "runs";

interface SourceDraftEntry {
  baselineRevision: number;
  source: string;
}

export function ScriptsPage({ onViewRun, active = true }: { onViewRun: () => void; active?: boolean }) {
  const { t } = useTranslation();
  const { requestConfirm, confirmDialogNode } = useConfirmDialog();
  const [studioTab, setStudioTab] = useState<RpaStudioTab>("scripts");
  const [langFilter, setLangFilter] = useState<"all" | ScriptLanguage>("all");
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [script, setScript] = useState<ScriptRecord | null>(null);
  const [drafts] = useState(createScriptDetailsDrafts);
  const [sourceDrafts, setSourceDrafts] = useState<ReadonlyMap<string, SourceDraftEntry>>(() => new Map());
  const [editingSource, setEditingSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutation, setMutation] = useState<"import" | "save" | "save-source" | "replace" | "delete" | null>(null);
  const [notice, setNotice] = useState("");
  const [, setDraftVersion] = useState(0);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [reloadRequired, setReloadRequired] = useState<ReadonlySet<string>>(() => new Set());
  const runSnapshot = useBackgroundScriptRun();
  const currentRun = runSnapshot.run;
  const importRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const savedRecord = useRef<ScriptRecord | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const initiallyLoaded = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const draft = script ? drafts.get(script.id) : undefined;
  const dirty = !!draft;
  const staleDraft = !!draft && draft.baseline.revision !== script?.revision;
  const sourceDraft = script ? sourceDrafts.get(script.id) : undefined;
  const sourceDirty = !!sourceDraft && !!savedRecord.current && sourceDraft.source !== savedRecord.current.source;
  const staleSourceDraft = !!sourceDraft && !!script && sourceDraft.baselineRevision !== script.revision;
  const activeSourceValue = sourceDraft ? sourceDraft.source : (script?.source ?? "");
  const needsReload = !!script && reloadRequired.has(script.id);
  const undo = !!script && drafts.canUndo(script.id);
  const missingDrafts = drafts.ids().flatMap(id => {
    const missingDraft = drafts.get(id);
    return missingDraft && !scripts.some(item => item.id === id) ? [missingDraft] : [];
  });
  const desktop = scriptsDesktopAvailable();
  useDesktopCloseDraft("script-details", {
    active: desktop,
    dirty: drafts.count() > 0 || sourceDrafts.size > 0,
    busy: mutation !== null,
  });
  const [python, downloadPython] = usePythonRuntime(active && desktop && scripts.some(item => item.language === "python"));

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!active || !desktop || initiallyLoaded.current) return;
    initiallyLoaded.current = true;
    void refreshList();
    void backgroundScriptRuns.refresh().catch((error) => {
      console.warn("Failed to refresh background script runs:", error);
    });
  }, [active, desktop]);

  function beginOperation(nextMutation: typeof mutation = null): boolean {
    if (operation.current || !visible.current) return false;
    operation.current = true;
    setBusy(true);
    setMutation(nextMutation);
    setError(null);
    setNotice("");
    return true;
  }

  function endOperation() {
    operation.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setMutation(null);
  }

  function requireReload(id: string) {
    setReloadRequired(current => new Set([...current, id]));
  }

  function resolveReload(id: string) {
    setReloadRequired(current => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function clearSourceDraft(id: string) {
    setSourceDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function reportError(nextError: unknown, id?: string) {
    if (!mounted.current) return;
    const message = errorText(nextError);
    if (id && (SCRIPT_RELOAD_REQUIRED.has(message) || message === SCRIPT_RECORD_UNCONFIRMED)) requireReload(id);
    setError(t(message));
  }

  async function reload() {
    const list = await fetchScripts();
    if (!mounted.current) return list;
    setScripts(list);
    const selected = savedRecord.current;
    if (selected) {
      const summary = list.find(item => item.id === selected.id);
      if (!summary) {
        savedRecord.current = null;
        setScript(null);
        setEditingSource(false);
        clearSourceDraft(selected.id);
        resolveReload(selected.id);
      } else if (summary.revision !== selected.revision) {
        requireReload(selected.id);
      }
    }
    return list;
  }

  async function readScript(id: string) {
    const record = await fetchScript(id);
    if (!mounted.current) return;
    const previous = savedRecord.current;
    if (!validScriptRecord(record) || record.id !== id || previous?.id === id && previous.revision > record.revision) {
      throw new Error(SCRIPT_RECORD_UNCONFIRMED);
    }
    acceptRecord(record, true);
  }

  async function refreshList() {
    if (!beginOperation()) return;
    const selected = savedRecord.current;
    try {
      const list = await reload();
      if (mounted.current && visible.current && selected && list.some(item => item.id === selected.id)) await readScript(selected.id);
    } catch (nextError) {
      reportError(nextError, selected?.id);
    } finally {
      endOperation();
    }
  }

  async function select(id: string) {
    if (!beginOperation()) return;
    try {
      setEditingSource(false);
      await readScript(id);
    } catch (nextError) {
      reportError(nextError, id);
    } finally {
      endOperation();
    }
  }

  function acceptRecord(record: ScriptRecord, restore: boolean) {
    savedRecord.current = record;
    resolveReload(record.id);
    const activeDraft = drafts.observe(record);
    setScript(scriptDetailsWithDraft(record, activeDraft));
    setRestoredDraft(restore && !!activeDraft);
    setSourceDrafts((prev) => {
      const existing = prev.get(record.id);
      if (!existing) return prev;
      if (existing.source === record.source) {
        const next = new Map(prev);
        next.delete(record.id);
        return next;
      }
      return prev;
    });
  }

  function editDetails(key: "name" | "description", value: string) {
    const saved = savedRecord.current;
    if (!script || !saved || operation.current) return;
    drafts.edit(saved, key, value);
    setScript({ ...script, [key]: value });
    setRestoredDraft(false);
    setNotice("");
  }

  function editSource(nextSource: string) {
    const saved = savedRecord.current;
    if (!script || !saved || operation.current) return;
    setNotice("");
    setSourceDrafts((prev) => {
      const next = new Map(prev);
      if (nextSource === saved.source) {
        next.delete(saved.id);
      } else {
        const existing = prev.get(saved.id);
        next.set(saved.id, {
          baselineRevision: existing?.baselineRevision ?? saved.revision,
          source: nextSource,
        });
      }
      return next;
    });
  }

  function discardSourceDraft() {
    const saved = savedRecord.current;
    if (!saved || operation.current) return;
    clearSourceDraft(saved.id);
    setNotice("Source changes discarded.");
  }

  function rebaseSourceDraft() {
    const saved = savedRecord.current;
    const current = saved ? sourceDrafts.get(saved.id) : undefined;
    if (!saved || !current || needsReload || operation.current) return;
    setSourceDrafts((prev) => {
      const next = new Map(prev);
      next.set(saved.id, { baselineRevision: saved.revision, source: current.source });
      return next;
    });
  }

  function discardDraft() {
    const saved = savedRecord.current;
    if (!saved || operation.current || !drafts.discard(saved.id)) return;
    setScript(saved);
    setRestoredDraft(false);
    setNotice("Draft discarded. You can undo this.");
  }

  function undoDiscard() {
    const saved = savedRecord.current;
    if (!saved || operation.current || !drafts.canUndo(saved.id)) return;
    const restored = drafts.undo(saved);
    setScript(scriptDetailsWithDraft(saved, restored));
    setRestoredDraft(!!restored);
    setNotice(restored ? "Draft restored." : "");
  }

  function reviewDraft() {
    const saved = savedRecord.current;
    if (!saved || !draft || needsReload || operation.current || !drafts.rebase(saved, draft)) return;
    acceptRecord(saved, false);
  }

  async function refreshAfterSave() {
    setMutation(null);
    if (!visible.current) return;
    try {
      await reload();
    } catch {
      if (mounted.current) setError(t("Your change was saved, but the script list could not refresh. Refresh the list to continue."));
    }
  }

  function updateSummary(record: ScriptRecord) {
    const { source: _source, ...summary } = record;
    setScripts(list => [...list.filter(item => item.id !== record.id), summary]);
  }

  async function importFile(file: File) {
    const language = languageFor(file);
    if (!language) { setError(t("Choose a .js, .mjs, or .py file.")); return; }
    if (!beginOperation("import")) return;
    try {
      const input = { name: fileTitle(file), description: "", language, source: await file.text() };
      if (!mounted.current) return;
      const created = await createScript(input);
      if (!mounted.current) return;
      if (!confirmsScriptWrite(created, input)) throw new Error(SCRIPT_RECORD_UNCONFIRMED);
      updateSummary(created);
      acceptRecord(created, false);
      setNotice("Script imported.");
      await refreshAfterSave();
    } catch (nextError) {
      reportError(nextError);
    } finally {
      endOperation();
    }
  }

  async function replaceFile(file: File) {
    const saved = savedRecord.current;
    if (!saved || needsReload) return;
    const language = languageFor(file);
    if (!language) { setError(t("Choose a .js, .mjs, or .py file.")); return; }
    if (!beginOperation("replace")) return;
    try {
      const input = { ...saved, language, source: await file.text() };
      if (!mounted.current) return;
      const updated = await updateScript(saved.id, input);
      if (!mounted.current) return;
      if (!confirmsScriptWrite(updated, input, saved)) throw new Error(SCRIPT_RECORD_UNCONFIRMED);
      drafts.acknowledgeSourceReplacement(saved, updated);
      clearSourceDraft(saved.id);
      updateSummary(updated);
      acceptRecord(updated, true);
      setNotice(drafts.get(saved.id) ? "Script file replaced. Your detail draft is still unsaved." : "Script file replaced.");
      await refreshAfterSave();
    } catch (nextError) {
      reportError(nextError, saved.id);
    } finally {
      endOperation();
    }
  }

  async function saveDetails() {
    const saved = savedRecord.current;
    if (!saved || !draft || draft.baseline.id !== saved.id || draft.baseline.revision !== saved.revision || needsReload || !beginOperation("save")) return;
    try {
      const input = scriptDetailsWithDraft(saved, draft);
      const updated = await updateScript(saved.id, input);
      if (!mounted.current) return;
      if (!confirmsScriptWrite(updated, input, saved) || !drafts.acknowledgeSave(updated, draft)) throw new Error(SCRIPT_RECORD_UNCONFIRMED);
      updateSummary(updated);
      acceptRecord(updated, false);
      setNotice("Script details saved.");
      await refreshAfterSave();
    } catch (nextError) {
      reportError(nextError, saved.id);
    } finally {
      endOperation();
    }
  }

  async function saveSource() {
    const saved = savedRecord.current;
    const currentDraft = saved ? sourceDrafts.get(saved.id) : undefined;
    if (
      !saved
      || !currentDraft
      || !currentDraft.source.trim()
      || currentDraft.baselineRevision !== saved.revision
      || needsReload
      || !beginOperation("save-source")
    ) {
      return;
    }
    try {
      const input = { ...saved, source: currentDraft.source };
      const updated = await updateScript(saved.id, input);
      if (!mounted.current) return;
      if (!confirmsScriptWrite(updated, input, saved)) throw new Error(SCRIPT_RECORD_UNCONFIRMED);
      drafts.acknowledgeSourceReplacement(saved, updated);
      clearSourceDraft(saved.id);
      updateSummary(updated);
      acceptRecord(updated, true);
      setNotice("Script source saved.");
      await refreshAfterSave();
    } catch (nextError) {
      reportError(nextError, saved.id);
    } finally {
      endOperation();
    }
  }

  async function remove() {
    const saved = savedRecord.current;
    if (!saved || operation.current || !visible.current || needsReload) return;
    const confirmed = await requestConfirm({
      title: t("Delete script"),
      message: t("Delete {name}?", { name: saved.name }),
      confirmLabel: t("Delete"),
      cancelLabel: t("Cancel"),
      tone: "danger",
    });
    if (!confirmed || !visible.current || operation.current || savedRecord.current?.id !== saved.id || needsReload) return;
    if (!beginOperation("delete")) return;
    try {
      await deleteScript(saved.id, saved.revision);
      if (!mounted.current) return;
      drafts.forget(saved.id);
      clearSourceDraft(saved.id);
      setEditingSource(false);
      savedRecord.current = null;
      setScript(null);
      setScripts(list => list.filter(item => item.id !== saved.id));
      setNotice("Script deleted.");
      await refreshAfterSave();
    } catch (nextError) {
      reportError(nextError, saved.id);
    } finally {
      endOperation();
    }
  }

  function handleCreatedExternalScript(created: ScriptRecord) {
    updateSummary(created);
    acceptRecord(created, false);
    setEditingSource(false);
    setStudioTab("scripts");
  }

  const visibility = { hidden: !active, inert: !active || undefined, style: !active ? { display: "none" } : undefined };
  if (!desktop) {
    return <div className="workspace scripts-page" {...visibility}>
      <header className="scripts-head page-heading"><h1>{t("Scripts")}</h1></header>
      <div className="emptystate scripts-empty"><span className="scripts-empty-symbol"><AppIcon name="file" /></span><b>{t("Scripts require the desktop app.")}</b></div>
    </div>;
  }
  const showScriptList = scripts.length > 0 || missingDrafts.length > 0;
  const jsCount = scripts.filter((item) => item.language === "javascript").length;
  const pyCount = scripts.filter((item) => item.language === "python").length;
  const filteredScripts = langFilter === "all" ? scripts : scripts.filter((item) => item.language === langFilter);
  const unsavedDraftCount = new Set([...drafts.ids(), ...sourceDrafts.keys()]).size;
  const sourceLineCount = Math.max(1, activeSourceValue.split(/\r?\n/).length);

  return (
    <div className="workspace scripts-page" {...visibility} aria-busy={busy} aria-labelledby="scripts-page-title">
      <header className="scripts-head page-heading">
        <div className="scripts-header-left">
          <h1 id="scripts-page-title">{t("Scripts")}</h1>
          <nav className="rpa-studio-tabs" role="group" aria-label={t("RPA Studio sections")} data-sliding-group>
            <button
              type="button"
              className={`rpa-studio-tab${studioTab === "scripts" ? " active" : ""}`}
              aria-pressed={studioTab === "scripts"}
              onClick={() => setStudioTab("scripts")}
            >
              {t("Saved scripts")}
              <span className="rpa-studio-tab-badge">{scripts.length}</span>
            </button>
            <button
              type="button"
              className={`rpa-studio-tab${studioTab === "templates" ? " active" : ""}`}
              aria-pressed={studioTab === "templates"}
              onClick={() => setStudioTab("templates")}
            >
              {t("Templates")}
            </button>
            <button
              type="button"
              className={`rpa-studio-tab${studioTab === "recorder" ? " active" : ""}`}
              aria-pressed={studioTab === "recorder"}
              onClick={() => setStudioTab("recorder")}
            >
              {t("Visual recorder")}
            </button>
            <button
              type="button"
              className={`rpa-studio-tab${studioTab === "runs" ? " active" : ""}`}
              aria-pressed={studioTab === "runs"}
              onClick={() => setStudioTab("runs")}
            >
              {t("Runs & receipts")}
            </button>
          </nav>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" disabled={busy} onClick={() => void refreshList()}><AppIcon name="refresh" className="sm" />{t("Refresh scripts")}</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => importRef.current?.click()}><AppIcon name="fileImport" className="sm" />{t("Import script")}</button>
        </div>
      </header>

      <div className="scripts-kpi-ribbon">
        <div>
          <div className="scripts-kpi-head">
            <span>{t("Saved scripts")}</span>
            <small>{jsCount} JS · {pyCount} PY</small>
          </div>
          <div className="scripts-kpi-val">
            <strong>{scripts.length.toLocaleString()}</strong>
          </div>
        </div>
        <div>
          <div className="scripts-kpi-head">
            <span>Python</span>
            <small className={python?.state === "ready" ? "tone-good" : ""}>
              {python?.state === "ready" ? t("Ready") : python?.state === "downloading" ? "…" : t("Idle")}
            </small>
          </div>
          <div className="scripts-kpi-val">
            <strong className={python?.state === "ready" ? "tone-good" : ""}>{pyCount.toLocaleString()}</strong>
          </div>
        </div>
        <div>
          <div className="scripts-kpi-head">
            <span>{t("Unsaved drafts")}</span>
          </div>
          <div className="scripts-kpi-val">
            <strong className={unsavedDraftCount > 0 ? "tone-warn" : ""}>{unsavedDraftCount.toLocaleString()}</strong>
          </div>
        </div>
        <div>
          <div className="scripts-kpi-head">
            <span>{t("Runs & receipts")}</span>
            {currentRun && <small>{currentRun.scriptName}</small>}
          </div>
          <div className="scripts-kpi-val">
            <strong className={currentRun?.status === "running" ? "tone-accent" : ""}>
              {currentRun
                ? (runSnapshot.state === "unavailable" ? t("Idle") : scriptStatusLabel(currentRun.status, t))
                : t("Idle")}
            </strong>
          </div>
        </div>
      </div>

      {error && <div className="modal-err" role="alert">{error}</div>}
      {notice && <p className="script-notice" role="status">{t(notice)}{undo && <button className="btn xs ghost" type="button" disabled={busy} onClick={undoDiscard}>{t("Undo discard")}</button>}</p>}
      {currentRun && <button className="scripts-run-note" type="button" onClick={onViewRun}>{t("{scriptName}: {status}. View run", { scriptName: currentRun.scriptName, status: runSnapshot.state === "unavailable" ? t("Status unavailable") : scriptStatusLabel(currentRun.status, t) })}</button>}
      <PythonRuntimeNote status={python} onDownload={downloadPython} />

      {studioTab === "templates" && (
        <RpaTemplatesPanel
          active={active && studioTab === "templates"}
          onScriptCopied={handleCreatedExternalScript}
          onRunStarted={(run) => {
            backgroundScriptRuns.observe(run);
            setStudioTab("runs");
          }}
        />
      )}

      {studioTab === "recorder" && (
        <RpaRecorderPanel
          active={active && studioTab === "recorder"}
          onSavedScript={handleCreatedExternalScript}
        />
      )}

      {studioTab === "runs" && (
        <RpaRunsQueuePanel
          active={active && studioTab === "runs"}
          onObservedRun={(run) => backgroundScriptRuns.observe(run)}
        />
      )}

      {studioTab === "scripts" && (
        <div className={`scripts-layout${showScriptList ? "" : " is-empty"}`}>
          {showScriptList && <aside className="scripts-list" aria-label={t("Saved scripts")}>
            {scripts.length > 0 && (
              <div className="scripts-lang-filter" role="group" aria-label={t("Saved scripts")} data-sliding-disabled>
                {(
                  [
                    { key: "all", label: t("All"), count: scripts.length },
                    { key: "javascript", label: "JS", count: jsCount },
                    { key: "python", label: "Python", count: pyCount },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`scripts-lang-chip${langFilter === opt.key ? " active" : ""}`}
                    aria-pressed={langFilter === opt.key}
                    onClick={() => setLangFilter(opt.key)}
                  >
                    {opt.label} <span>{opt.count}</span>
                  </button>
                ))}
              </div>
            )}
            <div
              className="scripts-list-body"
              data-sliding-group
              data-sliding-axis="vertical"
              data-sliding-accent-bar="true"
            >{filteredScripts.map((item) => (
              <button className={`script-row${script?.id === item.id ? " active" : ""}`} type="button" key={item.id} data-script-id={item.id} disabled={busy} aria-pressed={script?.id === item.id} onClick={() => void select(item.id)}>
                <div className="script-row-top">
                  <b>{item.name}{(drafts.get(item.id) || sourceDrafts.has(item.id)) && <em className="script-draft-badge">{t("Unsaved")}</em>}</b>
                  <span className="rpa-lang-pill" data-lang={item.language}>{item.language === "python" ? "PY" : "JS"}</span>
                </div>
                <span>{languageName(item.language)} · Rev {item.revision}</span>
                {item.description && <small>{item.description}</small>}
              </button>
            ))}</div>
            {missingDrafts.length > 0 && (
              <div className="script-missing-drafts">
                <h4>{t("Unavailable script drafts")}</h4>
                {missingDrafts.map(missing => {
                  const details = scriptDetailsWithDraft(missing.baseline, missing);
                  return (
                    <details key={details.id}>
                      <summary>{details.name}</summary>
                      {details.description && <p>{details.description}</p>}
                      <button className="btn xs ghost" type="button" disabled={busy} onClick={() => {
                        drafts.forget(details.id);
                        setDraftVersion(value => value + 1);
                      }}>{t("Discard draft")}</button>
                    </details>
                  );
                })}
              </div>
            )}
          </aside>}
          {script ? (
            <section className="script-detail">
              {needsReload && (
                <div className="script-draft-note has-conflict">
                  <p role="status">{t("Reload the saved script before making another change.")}</p>
                  <button className="btn xs" type="button" disabled={busy} onClick={() => void refreshList()}>{t("Reload saved script")}</button>
                </div>
              )}
              {dirty && (
                <div className={`script-draft-note${staleDraft ? " has-conflict" : ""}`}>
                  <div role="status">
                    <strong>{t(restoredDraft ? "Unsaved draft restored." : "Your changes are not saved yet.")}</strong>
                    <p>{t(staleDraft ? "The saved script changed since this draft began. Review the latest source before saving." : "You can switch scripts or pages. This draft stays in memory until you close or reload the app.")}</p>
                  </div>
                  <button className="btn xs ghost" type="button" disabled={busy} onClick={discardDraft}>{t("Discard draft")}</button>
                </div>
              )}
              {staleDraft && !needsReload && savedRecord.current && (
                <section className="script-draft-review" aria-labelledby="script-draft-review-title">
                  <h3 id="script-draft-review-title">{t("Latest saved details")}</h3>
                  <dl>
                    <dt>{t("Title")}</dt><dd>{savedRecord.current.name}</dd>
                    <dt>{t("Description")}</dt><dd>{savedRecord.current.description || "—"}</dd>
                  </dl>
                  <button className="btn xs" type="button" disabled={busy} onClick={reviewDraft}>{t("Keep my edits on this version")}</button>
                </section>
              )}
              {!dirty && undo && !notice && <p className="script-notice" role="status">{t("A discarded draft is available for this script.")} <button className="btn xs ghost" type="button" disabled={busy} onClick={undoDiscard}>{t("Restore draft")}</button></p>}

              <div className="script-meta-card">
                <div className="script-meta-grid">
                  <label className="fld"><span>{t("Title")}</span><input className="input" value={script.name} disabled={busy} onChange={(event) => editDetails("name", event.target.value)} /></label>
                  <label className="fld"><span>{t("Description")}</span><input className="input" value={script.description} disabled={busy} onChange={(event) => editDetails("description", event.target.value)} /></label>
                  <div className="script-actions">
                    <button className="btn primary" type="button" disabled={busy || !dirty || staleDraft || needsReload || !script.name.trim()} onClick={() => void saveDetails()}>{mutation === "save" ? t("Saving…") : t("Save details")}</button>
                    <button className="btn" type="button" disabled={busy || needsReload} onClick={() => replaceRef.current?.click()}>{t("Replace file")}</button>
                    <button className="btn danger" type="button" disabled={busy || needsReload} onClick={() => void remove()}>{t("Delete")}</button>
                  </div>
                </div>
              </div>

              {staleSourceDraft && !needsReload && (
                <div className="script-draft-note has-conflict">
                  <div role="status">
                    <strong>{t("Source revision conflict detected.")}</strong>
                    <p>{t("This script was updated to revision {rev} while you edited the source.", { rev: script.revision })}</p>
                  </div>
                  <button className="btn xs" type="button" disabled={busy} onClick={rebaseSourceDraft}>
                    {t("Keep my source edits on this version")}
                  </button>
                </div>
              )}

              <div className="fld script-code-card">
                <div className="script-source-header">
                  <div className="script-code-title-group">
                    <h2>{script.name}</h2>
                    {(dirty || sourceDirty) && <span className="script-draft-badge">{t("Unsaved")}</span>}
                    <span className="chip">{languageName(script.language)}</span>
                    <span className="script-rev-pill">{t("Rev {rev}", { rev: script.revision })}</span>
                    <span className="script-line-count">{t("{lines} lines", { lines: sourceLineCount })}</span>
                  </div>
                  <div className="script-source-meta">
                    {editingSource ? (
                      <>
                        <button
                          type="button"
                          className="btn xs primary"
                          disabled={busy || !sourceDirty || staleSourceDraft || needsReload || !activeSourceValue.trim()}
                          onClick={() => void saveSource()}
                        >
                          {mutation === "save-source" ? t("Saving…") : t("Save source")}
                        </button>
                        {sourceDirty && (
                          <button type="button" className="btn xs ghost" disabled={busy} onClick={discardSourceDraft}>
                            {t("Discard source edits")}
                          </button>
                        )}
                        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => setEditingSource(false)}>
                          {t("Preview source")}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn xs" disabled={busy} onClick={() => setEditingSource(true)}>
                        {sourceDirty ? t("Continue editing source") : t("Edit source")}
                      </button>
                    )}
                  </div>
                </div>
                {editingSource ? (
                  <textarea
                    className="script-source-editor"
                    aria-label={t("Script source editor")}
                    value={activeSourceValue}
                    disabled={busy}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === "Tab") {
                        event.preventDefault();
                        const target = event.currentTarget;
                        const start = target.selectionStart;
                        const end = target.selectionEnd;
                        const next = `${activeSourceValue.slice(0, start)}  ${activeSourceValue.slice(end)}`;
                        editSource(next);
                        requestAnimationFrame(() => {
                          target.selectionStart = target.selectionEnd = start + 2;
                        });
                      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                        event.preventDefault();
                        void saveSource();
                      }
                    }}
                    onChange={(event) => editSource(event.target.value)}
                  />
                ) : (
                  <div className="script-code-view">
                    <div className="script-code-gutter" aria-hidden="true">
                      {Array.from({ length: sourceLineCount }, (_, idx) => idx + 1).join("\n")}
                    </div>
                    <pre className="script-source">{script.source}</pre>
                  </div>
                )}
              </div>
            </section>
          ) : <div className="emptystate scripts-empty">
            <span className="scripts-empty-symbol"><AppIcon name="file" /></span>
            <b>{t(busy ? "Loading…" : scripts.length ? "Select a script" : "No scripts yet.")}</b>
            {!busy && !scripts.length && <p>{t("Import a .js, .mjs, or .py file to begin.")}</p>}
          </div>}
        </div>
      )}

      <input ref={importRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
      <input ref={replaceRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void replaceFile(file); event.target.value = ""; }} />
      {confirmDialogNode}
    </div>
  );
}

export function ScriptRunPanel({ open, selectedProfiles, onClose }: {
  open: boolean;
  selectedProfiles: UiProfile[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [useCredentials, setUseCredentials] = useState(false);
  const [concurrency, setConcurrency] = useState("10");
  const runSnapshot = useBackgroundScriptRun(), run = runSnapshot.run;
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [monitorLoading, setMonitorLoading] = useState(false), [monitorError, setMonitorError] = useState<string | null>(null), [loadAttempt, setLoadAttempt] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null), close = useRef(onClose);
  close.current = onClose;
  const mounted = useRef(true), commandInFlight = useRef(false);
  const offset = useRef(0);
  const desktop = scriptsDesktopAvailable();
  const runActive = run?.status === "running" || run?.status === "stopping" || run?.status === "queued";
  const [python, downloadPython] = usePythonRuntime(open && desktop && scripts.find((script) => script.id === scriptId)?.language === "python");

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const container = dialog.current, document = container.ownerDocument;
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus({ preventScroll: true });
    const focusable = () => [...container.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(node => !node.closest('[inert], [hidden], [aria-hidden="true"]'));
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== "Tab") return;
      const targets = focusable(), first = targets[0], last = targets.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); container.focus(); return; }
      if (event.shiftKey && (active === first || active === container || !container.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || active === container || !container.contains(active))) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!container.contains(event.target as Node)) closeButton.current?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", key, true); document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus);
      if (!hasActiveWorkbenchModal(document, container) && previous?.isConnected && !previous.closest('[inert], [hidden], [aria-hidden="true"]')
        && (document.activeElement === document.body || container.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !desktop) { setMonitorLoading(false); return; }
    let active = true;
    setMonitorLoading(true); setMonitorError(null);
    void Promise.all([fetchScripts(), backgroundScriptRuns.refresh()]).then(([nextScripts]) => {
      if (!active) return;
      setScripts(nextScripts);
    }).catch((nextError) => { if (active) setMonitorError(errorText(nextError)); })
      .finally(() => { if (active) setMonitorLoading(false); });
    return () => { active = false; };
  }, [open, desktop, loadAttempt]);

  useEffect(() => {
    if (!open || !run) return;
    let active = true;
    let timer: number | undefined;
    offset.current = 0;
    setLog("");
    const poll = async () => {
      try {
        const before = offset.current;
        const nextLog = await fetchScriptLog(run.id, before);
        if (!active) return;
        setMonitorError(null);
        if (nextLog.text) setLog((current) => current + nextLog.text);
        offset.current = nextLog.nextOffset;
        const latest = backgroundScriptRuns.getSnapshot().run;
        const stillRunning = latest?.id === run.id && latest.status !== "finished";
        if (stillRunning || nextLog.nextOffset !== before) timer = window.setTimeout(() => { void poll(); }, 1000);
      } catch (nextError) {
        if (!active) return;
        setMonitorError(errorText(nextError));
        timer = window.setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, run?.id]);

  const parseRunInput = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(inputs); }
    catch { setError(t("Inputs must be valid JSON.")); return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setError(t("Inputs must be a JSON object.")); return null; }
    if (!scriptId || selectedProfiles.length === 0) return null;
    const parallel = Number(concurrency);
    if (!Number.isSafeInteger(parallel) || parallel < 1) { setError(t("Parallel browsers must be a positive whole number.")); return null; }
    return { parsed: parsed as Record<string, unknown>, parallel };
  };

  const start = async () => {
    if (!open || commandInFlight.current || runActive || monitorLoading || runSnapshot.error) return;
    const validated = parseRunInput();
    if (!validated) return;
    commandInFlight.current = true; setBusy(true);
    setError(null);
    setQueueNotice(null);
    try {
      offset.current = 0;
      setLog("");
      const nextRun = await startScriptRun({ scriptId, profileIds: selectedProfiles.map((profile) => profile.id), inputs: validated.parsed, useCredentials, concurrency: validated.parallel });
      backgroundScriptRuns.observe(nextRun);
    } catch (nextError) { if (mounted.current) setError(errorText(nextError)); }
    finally { commandInFlight.current = false; if (mounted.current) setBusy(false); }
  };

  const queueBatch = async () => {
    if (!open || commandInFlight.current || monitorLoading || runSnapshot.error) return;
    const validated = parseRunInput();
    if (!validated) return;
    commandInFlight.current = true; setBusy(true);
    setError(null);
    setQueueNotice(null);
    try {
      const queued = await startQueuedScriptRun({
        scriptId,
        profileIds: selectedProfiles.map((profile) => profile.id),
        inputs: validated.parsed,
        useCredentials,
        concurrency: validated.parallel,
        queueIfBusy: true,
      });
      if (mounted.current) {
        setQueueNotice(
          queued.status === "queued"
            ? t("Queued as batch #{pos}.", { pos: queued.queuePosition ?? 1 })
            : t("Batch started immediately."),
        );
      }
    } catch (nextError) { if (mounted.current) setError(errorText(nextError)); }
    finally { commandInFlight.current = false; if (mounted.current) setBusy(false); }
  };

  const stop = async () => {
    if (commandInFlight.current || !runActive || run?.status === "stopping") return;
    commandInFlight.current = true; setBusy(true);
    setError(null);
    try { backgroundScriptRuns.observe(await stopScriptRun()); }
    catch (nextError) { if (mounted.current) setError(errorText(nextError)); }
    finally { commandInFlight.current = false; if (mounted.current) setBusy(false); }
  };

  return <MotionPresence present={open}>{() => (
    <div className="modal-backdrop script-run-backdrop">
      <div
        ref={dialog}
        tabIndex={-1}
        className="modal script-run-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-run-title"
        aria-describedby={desktop ? "script-run-close-note" : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head" id="script-run-title">{t("Run script")}<button ref={closeButton} type="button" className="modal-close" aria-label={t("Close run monitor")} onClick={onClose}>×</button></div>
        <div className="modal-body" aria-busy={busy || monitorLoading}>
          {!desktop ? <div className="modal-err">{t("Scripts require the desktop app.")}</div> : <>
            <p className="formnote">{t("Scripts run locally with your computer permissions.")}</p>
            {monitorLoading && <p className="script-monitor-loading" role="status">{t("Loading the latest run status…")}</p>}
            {monitorError && <div className="modal-err" role="alert">{monitorError} <button className="btn xs" type="button" disabled={monitorLoading} onClick={() => setLoadAttempt(value => value + 1)}>{t("Reload monitor")}</button></div>}
            {!monitorError && runSnapshot.error && <div className="modal-err" role="alert">{t(runSnapshot.error)} <button className="btn xs" type="button" disabled={monitorLoading} onClick={() => setLoadAttempt(value => value + 1)}>{t("Reload monitor")}</button></div>}
            {error && <div className="modal-err" role="alert">{error}</div>}
            {queueNotice && <p className="script-notice" role="status">{queueNotice}</p>}
            <PythonRuntimeNote status={python} onDownload={downloadPython} />
            <label className="fld"><span>{t("Script")}</span><select className="select" value={scriptId} onChange={(event) => setScriptId(event.target.value)} disabled={busy || runActive || monitorLoading}><option value="">{t("Choose a script…")}</option>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select></label>
            <label className="fld"><span>{t("JSON inputs")}</span><textarea className="input script-inputs" value={inputs} onChange={(event) => setInputs(event.target.value)} disabled={busy || runActive || monitorLoading} /></label>
            <label className="script-credentials"><input type="checkbox" checked={useCredentials} onChange={(event) => setUseCredentials(event.target.checked)} disabled={busy || runActive || monitorLoading} />{t("Use saved profile login details")}</label>
            <label className="fld"><span>{t("Parallel browsers")}</span><input className="input" type="number" min={1} step={1} value={concurrency} onChange={(event) => setConcurrency(event.target.value)} disabled={busy || runActive || monitorLoading} /></label>
            <p className="formnote">{t("{n} selected profiles. Run up to this many at a time; the rest wait for a free slot. Browser startup may be staggered. Parallel runs share the log below.", { n: String(selectedProfiles.length) })}</p>
            {run && <div className="script-progress" role="status" aria-live="polite"><b>{run.scriptName} · {runSnapshot.state === "unavailable" ? t("Status unavailable") : scriptStatusLabel(run.status, t)}{run.durationMs !== undefined ? ` · ${formatDurationMs(run.durationMs)}` : ""}</b>{run.profiles.map((profile) => <div key={profile.id} className={`script-profile ${profile.status}`}><span>{profile.name}</span><span>{scriptStatusLabel(profile.status, t)}{profile.durationMs !== undefined ? ` · ${formatDurationMs(profile.durationMs)}` : ""}</span>{profile.error && <small>{profile.error}</small>}{profile.warning && <small className="warning">{profile.warning}</small>}<RpaProfileReceipt runId={run.id} profile={profile} /></div>)}</div>}
            {run && <pre className="script-log" aria-label={t("Script log")}>{log || t("Waiting for log output…")}</pre>}
          </>}
          {desktop && <p className="script-monitor-close-note" id="script-run-close-note">{t("Closing this monitor keeps your inputs and does not stop a run. Use Stop run to request a stop.")}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" type="button" onClick={onClose}>{t(desktop ? "Close monitor" : "Close")}</button>
          {desktop && runActive && scriptId && selectedProfiles.length > 0 && (
            <button className="btn" type="button" disabled={busy || monitorLoading || !!monitorError || !!runSnapshot.error} onClick={() => void queueBatch()}>
              {t("Queue next batch")}
            </button>
          )}
          {desktop && !runActive && <button className="btn primary" type="button" disabled={busy || monitorLoading || !!monitorError || !!runSnapshot.error || !scriptId || selectedProfiles.length === 0} onClick={() => void start()}>{busy ? t("Starting…") : t("Run script")}</button>}
          {desktop && runActive && <button className="btn solid-danger" type="button" disabled={busy || run?.status === "stopping"} onClick={() => void stop()}>{run?.status === "stopping" ? t("Stopping…") : busy ? t("Stopping…") : t("Stop run")}</button>}
        </div>
      </div>
    </div>
  )}</MotionPresence>;
}
