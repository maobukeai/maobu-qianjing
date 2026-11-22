import { useEffect, useState } from "react";
import type { RpaRecordedStep, RpaRecorderStatus, ScriptRecord } from "../contracts/local.ts";
import { createScript, fetchProfiles, type UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import {
  fetchRpaRecorderStatus,
  generateRpaCode,
  startRpaRecorder,
  stopRpaRecorder,
} from "./rpa-api.ts";
import "./rpa-studio.css";

const EMPTY_RECORDER: RpaRecorderStatus = {
  state: "idle",
  sessionId: null,
  profileId: null,
  profileName: null,
  engine: null,
  ownedByConnection: false,
  startedAt: null,
  lastActivityAt: null,
  steps: [],
  error: null,
};

export function RpaRecorderPanel({
  active = true,
  onSavedScript,
}: {
  active?: boolean;
  onSavedScript: (record: ScriptRecord) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RpaRecorderStatus>(EMPTY_RECORDER);
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [startupUrl, setStartupUrl] = useState("");
  const [closeBrowserOnStop, setCloseBrowserOnStop] = useState(false);
  const [editableSteps, setEditableSteps] = useState<RpaRecordedStep[]>([]);
  const [parameterizeInputs, setParameterizeInputs] = useState(false);
  const [humanDelay, setHumanDelay] = useState(true);
  const [scriptName, setScriptName] = useState("Recorded workflow");
  const [generatedSource, setGeneratedSource] = useState("");
  const [suggestedInputs, setSuggestedInputs] = useState<Record<string, unknown>>({});
  const [usesCredentials, setUsesCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isRecording = status.state === "recording" || status.state === "starting";

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void Promise.all([
      fetchRpaRecorderStatus().catch(() => EMPTY_RECORDER),
      fetchProfiles().catch(() => ({ profiles: [] as UiProfile[], groups: [] as string[] })),
    ]).then(([recStatus, roster]) => {
      if (!alive) return;
      setStatus(recStatus);
      setEditableSteps(recStatus.steps);
      setProfiles(roster.profiles);
      if (recStatus.profileId) {
        setProfileId(recStatus.profileId);
      } else if (roster.profiles[0]) {
        setProfileId((current) => current || roster.profiles[0]!.id);
      }
    });
    return () => {
      alive = false;
    };
  }, [active]);

  useEffect(() => {
    if (!active || !isRecording) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void fetchRpaRecorderStatus()
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          setEditableSteps(next.steps);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, isRecording]);

  async function handleStart() {
    if (!profileId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await startRpaRecorder({
        profileId,
        ...(startupUrl.trim() ? { startupUrl: startupUrl.trim() } : {}),
      });
      setStatus(next);
      setEditableSteps(next.steps);
      setCloseBrowserOnStop(false);
      setNotice(t("Recording started. Interact with the opened browser window; sensitive password and 2FA fields are masked automatically."));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await stopRpaRecorder({ closeBrowser: status.ownedByConnection && closeBrowserOnStop });
      setStatus(next);
      setEditableSteps(next.steps);
      setNotice(t("Recording stopped. Review steps and generate editable code."));
      if (next.steps.length > 0) {
        const result = await generateRpaCode({
          steps: next.steps,
          options: { scriptName, parameterizeInputs, humanDelay },
        });
        setGeneratedSource(result.source);
        setSuggestedInputs(result.suggestedInputs);
        setUsesCredentials(result.usesCredentials);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await generateRpaCode({
        steps: editableSteps,
        options: { scriptName, parameterizeInputs, humanDelay },
      });
      setGeneratedSource(result.source);
      setSuggestedInputs(result.suggestedInputs);
      setUsesCredentials(result.usesCredentials);
      setNotice(t("Generated deterministic ESM script ({count} steps).", { count: result.stepCount }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveScript() {
    if (!generatedSource.trim() || !scriptName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await createScript({
        name: scriptName.trim(),
        description: t("Recorded in Visual Recorder ({count} steps)", { count: editableSteps.length }),
        language: "javascript",
        source: generatedSource,
      });
      setNotice(t("Recorded script saved to My Scripts."));
      onSavedScript(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function removeStep(id: string) {
    setEditableSteps((prev) =>
      prev.filter((step) => step.id !== id).map((step, idx) => ({ ...step, index: idx + 1 })),
    );
  }

  return (
    <div className="rpa-recorder-layout">
      <section className="settings-card rpa-recorder-card">
        <header>
          <h3>{t("Visual action recorder")}</h3>
          <span className={`rpa-recorder-status-pill${isRecording ? " recording" : ""}`} role="status">
            <span className="rpa-rec-dot" aria-hidden="true" />
            {isRecording
              ? t("Recording ({count} steps)", { count: editableSteps.length })
              : status.state === "error"
                ? t("Recorder error")
                : t("Idle")}
          </span>
        </header>

        <div className="card-body">
          {error && <div className="modal-err" role="alert">{error}</div>}
          {!error && status.error && <div className="modal-err" role="alert">{status.error}</div>}
          {notice && <p className="script-notice" role="status">{notice}</p>}

          <div className="rpa-recorder-controls">
            <label className="rpa-schema-field">
              <span>{t("Target profile")}</span>
              <select
                className="select"
                value={profileId}
                disabled={busy || isRecording}
                onChange={(event) => setProfileId(event.target.value)}
              >
                <option value="">{t("Choose a profile…")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.engine === "firefox" ? "Firefox" : "Chromium"})
                  </option>
                ))}
              </select>
            </label>
            <label className="rpa-schema-field">
              <span>{t("Startup URL (optional)")}</span>
              <input
                className="input"
                type="url"
                placeholder="https://example.com"
                value={startupUrl}
                disabled={busy || isRecording}
                onChange={(event) => setStartupUrl(event.target.value)}
              />
            </label>
          </div>

          <div className="script-actions">
            {!isRecording ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy || !profileId}
                onClick={() => void handleStart()}
              >
                {t("Start recording")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn solid-danger"
                  disabled={busy}
                  onClick={() => void handleStop()}
                >
                  {t("Stop recording")}
                </button>
                {status.ownedByConnection ? (
                  <label className="rpa-schema-checkbox">
                    <input
                      type="checkbox"
                      checked={closeBrowserOnStop}
                      disabled={busy}
                      onChange={(event) => setCloseBrowserOnStop(event.target.checked)}
                    />
                    <span>{t("Close browser opened by recorder")}</span>
                  </label>
                ) : (
                  <span className="formnote">{t("Existing browser stays open when recording stops.")}</span>
                )}
              </>
            )}
          </div>

          <div className="rpa-safety-banner" role="note">
            {t("Credential protection active: password, one-time-code (2FA), and payment inputs are never stored in plain text.")}
          </div>

          <div className="script-source-header">
            <strong>{t("Captured steps")} ({editableSteps.length})</strong>
            {editableSteps.length > 0 && !isRecording && (
              <button
                type="button"
                className="btn xs ghost"
                onClick={() => setEditableSteps([])}
              >
                {t("Clear steps")}
              </button>
            )}
          </div>

          {editableSteps.length === 0 ? (
            <p className="formnote">
              {isRecording
                ? t("Waiting for clicks, typing, navigation, or key presses in the browser…")
                : t("Start recording on a profile to capture browser actions with stable selectors.")}
            </p>
          ) : (
            <div className="rpa-steps-list" aria-label={t("Recorded action steps")}>
              {editableSteps.map((step) => (
                <div key={step.id} className={`rpa-step-row${step.masked ? " masked" : ""}`}>
                  <div className="rpa-step-main">
                    <div className="rpa-step-head">
                      <span className="rpa-step-index">#{step.index}</span>
                      <span className="rpa-action-tag">{step.kind}</span>
                      {step.selectorStrategy && <span className="rpa-strategy-tag">{step.selectorStrategy}</span>}
                      {step.credentialRef && (
                        <span className="rpa-mask-tag">
                          {step.credentialRef === "twofa"
                            ? t("Masked 2FA (credentials.twofa)")
                            : t("Masked password (credentials.password)")}
                        </span>
                      )}
                    </div>
                    <div className="rpa-step-selector">
                      {step.kind === "goto"
                        ? step.url
                        : step.selectorStrategy === "role" && step.role
                          ? `role=${step.role}${step.accessibleName ? ` "${step.accessibleName}"` : ""}`
                          : step.selector || step.label}
                    </div>
                    {step.kind === "fill" && !step.masked && step.value !== undefined && (
                      <div className="rpa-step-value">{t("Value")}: {step.value}</div>
                    )}
                    {step.kind === "select" && step.value !== undefined && (
                      <div className="rpa-step-value">{t("Selected option")}: {step.value}</div>
                    )}
                    {step.kind === "press" && step.key && (
                      <div className="rpa-step-value">{t("Key")}: {step.key}</div>
                    )}
                  </div>
                  {!isRecording && (
                    <button
                      type="button"
                      className="btn xs ghost"
                      aria-label={t("Remove step {index}", { index: step.index })}
                      onClick={() => removeStep(step.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="settings-card rpa-recorder-card">
        <header>
          <h3>{t("Generated script code")}</h3>
          <div className="page-actions">
            <button
              type="button"
              className="btn xs"
              disabled={busy || editableSteps.length === 0}
              onClick={() => void handleGenerateCode()}
            >
              {t("Generate code")}
            </button>
            <button
              type="button"
              className="btn xs primary"
              disabled={busy || !generatedSource.trim() || !scriptName.trim()}
              onClick={() => void handleSaveScript()}
            >
              {t("Save to my scripts")}
            </button>
          </div>
        </header>

        <div className="card-body">
          <label className="rpa-schema-field">
            <span>{t("Script title")}</span>
            <input
              className="input"
              value={scriptName}
              disabled={busy}
              onChange={(event) => setScriptName(event.target.value)}
            />
          </label>

          <div className="rpa-recorder-controls">
            <label className="rpa-schema-checkbox">
              <input
                type="checkbox"
                checked={parameterizeInputs}
                disabled={busy}
                onChange={(event) => setParameterizeInputs(event.target.checked)}
              />
              <span>{t("Parameterize inputs")}</span>
            </label>
            <label className="rpa-schema-checkbox">
              <input
                type="checkbox"
                checked={humanDelay}
                disabled={busy}
                onChange={(event) => setHumanDelay(event.target.checked)}
              />
              <span>{t("Human-like random delay")}</span>
            </label>
          </div>

          {usesCredentials && (
            <p className="formnote">
              {t("This script references saved profile credentials (password / 2FA). Enable 'Use saved profile login details' when running.")}
            </p>
          )}

          <label className="fld">
            <span>{t("Editable ESM source")}</span>
            <textarea
              className="script-source-editor"
              value={generatedSource}
              placeholder={t("Click Generate code after capturing actions to preview and edit Playwright JavaScript.")}
              onChange={(event) => setGeneratedSource(event.target.value)}
            />
          </label>

          {Object.keys(suggestedInputs).length > 0 && (
            <label className="fld">
              <span>{t("Suggested JSON inputs")}</span>
              <pre className="script-source">{JSON.stringify(suggestedInputs, null, 2)}</pre>
            </label>
          )}
        </div>
      </section>
    </div>
  );
}
