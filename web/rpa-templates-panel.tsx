import { useEffect, useState } from "react";
import type { RpaTemplate, RpaTemplateField, ScriptRecord } from "../contracts/local.ts";
import type { ScriptRun } from "../scripts.ts";
import { createScript, fetchProfiles, type UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { fetchRpaTemplates, startQueuedScriptRun } from "./rpa-api.ts";
import "./rpa-studio.css";

function serializeList(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "")).join("\n");
  if (typeof value === "string") return value;
  return "";
}

function parseList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function RpaTemplatesPanel({
  active = true,
  onScriptCopied,
  onRunStarted,
}: {
  active?: boolean;
  onScriptCopied: (record: ScriptRecord) => void;
  onRunStarted: (run: ScriptRun) => void;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<RpaTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("{}");
  const [useCredentials, setUseCredentials] = useState(false);
  const [queueIfBusy, setQueueIfBusy] = useState(true);
  const [concurrency, setConcurrency] = useState("4");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = templates.find((item) => item.id === selectedId) ?? templates[0] ?? null;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      fetchRpaTemplates(),
      fetchProfiles().catch(() => ({ profiles: [] as UiProfile[], groups: [] as string[] })),
    ])
      .then(([list, roster]) => {
        if (!alive) return;
        setTemplates(list);
        setProfiles(roster.profiles);
        if (list[0]) {
          setSelectedId((current) => current || list[0]!.id);
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [active]);

  useEffect(() => {
    if (!selected) return;
    const defaults = structuredClone(selected.defaultInputs);
    setFormValues(defaults);
    setJsonText(JSON.stringify(defaults, null, 2));
    setUseCredentials(selected.useCredentialsDefault);
    setJsonMode(false);
    setError(null);
    setNotice(null);
  }, [selected?.id]);

  function updateField(field: RpaTemplateField, value: unknown) {
    setFormValues((prev) => {
      const next = { ...prev, [field.key]: value };
      setJsonText(JSON.stringify(next, null, 2));
      return next;
    });
  }

  function toggleJsonMode() {
    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError(t("Inputs must be a JSON object."));
          return;
        }
        setFormValues(parsed as Record<string, unknown>);
        setError(null);
        setJsonMode(false);
      } catch {
        setError(t("Inputs must be valid JSON."));
      }
    } else {
      setJsonText(JSON.stringify(formValues, null, 2));
      setError(null);
      setJsonMode(true);
    }
  }

  function toggleProfile(id: string) {
    setSelectedProfileIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function resolveInputs(): Record<string, unknown> | null {
    if (!jsonMode) return formValues;
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError(t("Inputs must be a JSON object."));
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError(t("Inputs must be valid JSON."));
      return null;
    }
  }

  async function handleCopy() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createScript({
        name: selected.name,
        description: selected.description,
        language: selected.language,
        source: selected.source,
      });
      setNotice(t("Template copied to My Scripts."));
      onScriptCopied(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow() {
    if (!selected || busy) return;
    if (selectedProfileIds.length === 0) {
      setError(t("Select at least one profile to run this template."));
      return;
    }
    const inputs = resolveInputs();
    if (!inputs) return;
    const parallel = Number(concurrency);
    if (!Number.isSafeInteger(parallel) || parallel < 1) {
      setError(t("Parallel browsers must be a positive whole number."));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await startQueuedScriptRun({
        scriptId: `template:${selected.id}`,
        profileIds: selectedProfileIds,
        inputs,
        useCredentials,
        concurrency: parallel,
        queueIfBusy,
      });
      setNotice(run.status === "queued" ? t("Template batch added to the queue.") : t("Template run started."));
      onRunStarted(run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading && templates.length === 0) {
    return (
      <div className="emptystate scripts-empty">
        <b>{t("Loading built-in templates…")}</b>
      </div>
    );
  }

  return (
    <div className="rpa-templates-grid">
      <aside className="rpa-templates-list" aria-label={t("Built-in RPA templates")}>
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`rpa-template-card${selected?.id === template.id ? " active" : ""}`}
            data-template-id={template.id}
            onClick={() => setSelectedId(template.id)}
          >
            <div className="rpa-template-card-head">
              <strong>{t(template.name)}</strong>
              <span className="rpa-strategy-tag">{template.language === "javascript" ? "JS" : "PY"}</span>
            </div>
            <p>{t(template.description)}</p>
          </button>
        ))}
      </aside>

      {selected && (
        <section className="settings-card rpa-template-detail">
          <header>
            <div>
              <h3>{t(selected.name)}</h3>
            </div>
            <div className="page-actions">
              <button type="button" className="btn xs ghost" onClick={toggleJsonMode}>
                {jsonMode ? t("Switch to form view") : t("Edit raw JSON")}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void handleCopy()}>
                {t("Copy to my scripts")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || selectedProfileIds.length === 0}
                onClick={() => void handleRunNow()}
              >
                {t("Run template")}
              </button>
            </div>
          </header>

          <div className="card-body">
            {error && <div className="modal-err" role="alert">{error}</div>}
            {notice && <p className="script-notice" role="status">{notice}</p>}
            {selected.safetyNote && (
              <div className="rpa-safety-banner" role="note">
                {t(selected.safetyNote)}
              </div>
            )}

            {jsonMode ? (
              <label className="fld">
                <span>{t("JSON inputs")}</span>
                <textarea
                  className="input script-source-editor"
                  value={jsonText}
                  onChange={(event) => setJsonText(event.target.value)}
                  disabled={busy}
                />
              </label>
            ) : (
              <div className="rpa-schema-form">
                {selected.inputSchema.map((field) => {
                  const value = formValues[field.key];
                  const isWide = field.type === "url-list" || field.type === "string-list" || field.type === "url";
                  if (field.type === "boolean") {
                    return (
                      <div key={field.key} className="rpa-schema-field full">
                        <label className="rpa-schema-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            disabled={busy}
                            onChange={(event) => updateField(field, event.target.checked)}
                          />
                          <span>{t(field.label)}</span>
                        </label>
                        <small>{t(field.description)}</small>
                      </div>
                    );
                  }
                  if (field.type === "url-list" || field.type === "string-list") {
                    return (
                      <label key={field.key} className="rpa-schema-field full">
                        <span>{t(field.label)}</span>
                        <textarea
                          className="input"
                          rows={3}
                          placeholder={field.placeholder}
                          value={serializeList(value)}
                          disabled={busy}
                          onChange={(event) => updateField(field, parseList(event.target.value))}
                        />
                        <small>{t(field.description)}</small>
                      </label>
                    );
                  }
                  if (field.type === "number") {
                    return (
                      <label key={field.key} className="rpa-schema-field">
                        <span>{t(field.label)}</span>
                        <input
                          className="input"
                          type="number"
                          min={field.min}
                          max={field.max}
                          step={field.step ?? 1}
                          value={value === undefined ? "" : String(value)}
                          disabled={busy}
                          onChange={(event) => updateField(field, Number(event.target.value))}
                        />
                        <small>{t(field.description)}</small>
                      </label>
                    );
                  }
                  if (field.type === "select") {
                    return (
                      <label key={field.key} className="rpa-schema-field">
                        <span>{t(field.label)}</span>
                        <select
                          className="select"
                          value={String(value ?? "")}
                          disabled={busy}
                          onChange={(event) => updateField(field, event.target.value)}
                        >
                          {(field.options ?? []).map((opt) => (
                            <option key={opt.value} value={opt.value}>{t(opt.label)}</option>
                          ))}
                        </select>
                        <small>{t(field.description)}</small>
                      </label>
                    );
                  }
                  return (
                    <label key={field.key} className={`rpa-schema-field${isWide ? " full" : ""}`}>
                      <span>{t(field.label)}</span>
                      <input
                        className="input"
                        type={field.type === "url" ? "url" : "text"}
                        placeholder={field.placeholder}
                        value={String(value ?? "")}
                        disabled={busy}
                        onChange={(event) => updateField(field, event.target.value)}
                      />
                      <small>{t(field.description)}</small>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="rpa-profile-picker">
              <div className="rpa-mode-switch">
                <span>
                  <strong>{t("Target profiles")}</strong> ({selectedProfileIds.length}/{profiles.length})
                </span>
                <div className="page-actions">
                  <button
                    type="button"
                    className="btn xs ghost"
                    disabled={profiles.length === 0}
                    onClick={() => setSelectedProfileIds(profiles.map((p) => p.id))}
                  >
                    {t("Select all")}
                  </button>
                  <button
                    type="button"
                    className="btn xs ghost"
                    disabled={selectedProfileIds.length === 0}
                    onClick={() => setSelectedProfileIds([])}
                  >
                    {t("Clear selection")}
                  </button>
                </div>
              </div>
              {profiles.length === 0 ? (
                <p className="formnote">{t("Create a browser profile first to run templates directly.")}</p>
              ) : (
                <div className="rpa-profile-picker-list">
                  {profiles.map((profile) => {
                    const checked = selectedProfileIds.includes(profile.id);
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        className={`rpa-profile-chip${checked ? " selected" : ""}`}
                        aria-pressed={checked}
                        onClick={() => toggleProfile(profile.id)}
                      >
                        <span>{profile.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="rpa-recorder-controls">
                <label className="rpa-schema-checkbox">
                  <input
                    type="checkbox"
                    checked={useCredentials}
                    disabled={busy}
                    onChange={(event) => setUseCredentials(event.target.checked)}
                  />
                  <span>{t("Use saved profile login details")}</span>
                </label>
                <label className="rpa-schema-checkbox">
                  <input
                    type="checkbox"
                    checked={queueIfBusy}
                    disabled={busy}
                    onChange={(event) => setQueueIfBusy(event.target.checked)}
                  />
                  <span>{t("Queue batch if profiles are busy")}</span>
                </label>
                <label className="rpa-schema-field">
                  <span>{t("Parallel browsers")}</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={concurrency}
                    disabled={busy}
                    onChange={(event) => setConcurrency(event.target.value)}
                  />
                </label>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
