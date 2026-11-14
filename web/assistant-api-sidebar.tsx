import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useConfirmDialog } from "./ui-primitives.tsx";
import { AssistantRequestError } from "./local-assistant-api.ts";
import { ASSISTANT_SERVICE_LABELS, readAssistantServices, requiresAssistantServiceKey, saveAssistantService, testAssistantService, type AssistantServiceDraft, type AssistantServicesCatalog, type AssistantServiceView } from "./assistant-services-api.ts";

const EMPTY_CATALOG: AssistantServicesCatalog = { services: [], defaultId: null };
const blank = (): AssistantServiceDraft => ({ name: "", provider: "openai-compatible", endpoint: "", model: "" });
const editable = ({ id, name, provider, endpoint, model }: AssistantServiceView): AssistantServiceDraft => ({ id, name, provider, endpoint, model });
const exampleEndpoint: Record<AssistantServiceDraft["provider"], string> = {
  "openai-compatible": "https://api.example.com/v1", anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta", ollama: "http://127.0.0.1:11434",
};
const same = (left: AssistantServiceDraft, right: AssistantServiceDraft) => left.id === right.id && left.name === right.name
  && left.provider === right.provider && left.endpoint === right.endpoint && left.model === right.model && left.apiKey === right.apiKey;

export function AssistantApiSidebar({ active, disabled, keyEditRequest, onApply }: {
  active: boolean;
  disabled: boolean;
  keyEditRequest: { id: string } | null;
  onApply: (service: AssistantServiceView, listLoaded: boolean) => void;
}) {
  const { t } = useTranslation();
  const { requestConfirm, confirmDialogNode } = useConfirmDialog();
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [draft, setDraft] = useState(blank);
  const baseline = useRef<AssistantServiceDraft>(blank());
  const current = useRef(draft);
  current.current = draft;
  const initialized = useRef(false);
  const live = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const detailsId = useId(), keyHintId = useId();
  const keyInput = useRef<HTMLInputElement>(null), focusKey = useRef(false);
  const dirty = !same(draft, baseline.current);
  useDesktopCloseDraft("assistant-service-draft", { dirty, busy });

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; operation.current?.abort(); };
  }, []);

  function select(next: AssistantServiceDraft) {
    baseline.current = next;
    current.current = next;
    setDraft(next);
    focusKey.current = false;
    setEditing(false);
    setModels(null); setError("");
  }

  function editKey() {
    focusKey.current = true;
    setEditing(true);
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setReadFailed(false);
    void readAssistantServices(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      const selected = current.current.id;
      const changed = !same(current.current, baseline.current);
      const requested = result.services.find(item => item.id === keyEditRequest?.id && item.provider !== "ollama");
      if (requested && (!changed || selected === requested.id)) {
        initialized.current = true;
        if (!changed && (selected !== requested.id || !same(editable(requested), baseline.current))) select(editable(requested));
        editKey();
        return;
      }
      if (requested && changed) setError("Save or discard your changes before choosing another model service.");
      if (changed) return;
      if (!initialized.current) {
        initialized.current = true;
        const preferred = result.services.find(item => item.id === result.defaultId && item.provider !== "ollama")
          ?? result.services.find(item => item.provider !== "ollama");
        if (preferred) select(editable(preferred));
      } else if (selected) {
        const refreshed = result.services.find(item => item.id === selected && item.provider !== "ollama");
        if (refreshed && !same(editable(refreshed), baseline.current)) select(editable(refreshed));
        else if (!refreshed) select(blank());
      }
    }).catch(() => { if (!controller.signal.aborted) setReadFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, keyEditRequest, readAttempt]);

  const blocked = disabled || busy || loading;
  useLayoutEffect(() => {
    if (!active || blocked || !editing || !focusKey.current || !keyInput.current) return;
    focusKey.current = false;
    keyInput.current.focus();
  }, [active, blocked, editing, draft.id]);

  const saved = catalog.services.find(item => item.id === draft.id);
  const savedKeyAvailable = saved?.provider === draft.provider && saved.endpoint === draft.endpoint.trim() && saved.credentialConfigured;
  const needsKey = requiresAssistantServiceKey(draft.provider) && !savedKeyAvailable && !draft.apiKey?.trim();

  function update(value: Partial<AssistantServiceDraft>) {
    setDraft(previous => ({ ...previous, ...value }));
    setError("");
  }

  async function run(action: "test" | "apply") {
    if (!active || blocked || operation.current || !draft.endpoint.trim() || action === "test" && needsKey) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError("");
    const owns = () => live.current && operation.current === controller && !controller.signal.aborted;
    const request = { ...draft, apiKey: draft.apiKey?.trim() || undefined };
    try {
      if (action === "test") {
        setModels(null);
        const result = await testAssistantService(request, controller.signal);
        if (!owns()) return;
        const names = result.models.map(item => item.name);
        setModels(names);
        if (!draft.model && names.length) update({ model: names[0] });
        return;
      }
      if (saved && !dirty) { onApply(saved, !!models?.length); return; }
      if (!draft.name.trim() || !draft.model.trim()) return;
      const result = await saveAssistantService(request, controller.signal);
      if (!owns()) return;
      const chosen = result.services.find(item => draft.id ? item.id === draft.id : item.name === draft.name.trim());
      setCatalog(result);
      if (!chosen) { setError("The saved model service could not be selected."); return; }
      select(editable(chosen));
      onApply(chosen, !!models?.length);
    } catch (failure) {
      if (owns()) setError(failure instanceof AssistantRequestError ? failure.message : "The model service request failed.");
    } finally {
      if (operation.current === controller) { operation.current = null; if (live.current) setBusy(false); }
    }
  }

  return <div className="assistant-api-form" hidden={!active}>
    <label className="fld"><span>{t("Saved API service")}</span><select value={draft.id ?? ""} disabled={blocked} onChange={event => {
      const targetId = event.target.value;
      void (async () => {
        if (dirty) {
          const confirmed = await requestConfirm({
            title: t("Unsaved changes"),
            message: t("Discard unsaved model service changes?"),
            confirmLabel: t("Discard changes"),
            cancelLabel: t("Cancel"),
            tone: "danger",
          });
          if (!confirmed) return;
        }
        const service = catalog.services.find(item => item.id === targetId);
        select(service ? editable(service) : blank());
      })();
    }}>
      <option value="">{t("New API service")}</option>
      {catalog.services.filter(item => item.provider !== "ollama").map(item => <option key={item.id} value={item.id}>{item.name}{catalog.defaultId === item.id ? ` · ${t("Default")}` : ""}</option>)}
    </select></label>
    {loading && <p className="assistant-note" role="status">{t("Loading model services…")}</p>}
    {readFailed && <div className="assistant-api-message" role="alert"><span>{t("Could not load model services.")}</span><button className="btn xs" type="button" onClick={() => setReadAttempt(value => value + 1)}>{t("Retry")}</button></div>}
    {draft.id && <div className="assistant-api-edit-toggle"><span>{t(ASSISTANT_SERVICE_LABELS[draft.provider])}</span><button className="btn xs ghost" type="button" aria-controls={detailsId} aria-expanded={editing} disabled={blocked} onClick={() => {
      if (!editing && needsKey) editKey();
      else setEditing(value => !value);
    }}>{t(editing ? "Hide connection details" : needsKey ? "Update API key" : "Edit connection")}</button></div>}
    {needsKey && <p id={keyHintId} className="assistant-key-note">{t("API key required for this session")}</p>}
    <div className="assistant-api-edit" id={detailsId} hidden={!!draft.id && !editing}>
      <label className="fld"><span>{t("Connection name")}</span><input value={draft.name} maxLength={80} disabled={blocked} onChange={event => update({ name: event.target.value })} /></label>
      <label className="fld"><span>{t("Service protocol")}</span><select value={draft.provider} disabled={blocked} onChange={event => {
        setModels(null); update({ provider: event.target.value as AssistantServiceDraft["provider"], apiKey: undefined, endpoint: "", model: "" });
      }}>{(["openai-compatible", "anthropic", "gemini"] as const).map(provider => <option key={provider} value={provider}>{t(ASSISTANT_SERVICE_LABELS[provider])}</option>)}</select></label>
      <label className="fld"><span>{t("API base URL")}</span><input value={draft.endpoint} maxLength={512} autoComplete="off" spellCheck={false} placeholder={exampleEndpoint[draft.provider]} disabled={blocked} onChange={event => { setModels(null); update({ endpoint: event.target.value, apiKey: undefined }); }} /></label>
      <label className="fld"><span>{t("API key")}</span><input ref={keyInput} value={draft.apiKey ?? ""} type="password" autoComplete="new-password" maxLength={2048} spellCheck={false} placeholder={savedKeyAvailable ? t("Available for this app session") : undefined} aria-describedby={needsKey ? keyHintId : undefined} disabled={blocked} onChange={event => { setModels(null); update({ apiKey: event.target.value || undefined }); }} /></label>
      <p className="assistant-note">{t("API keys are kept for this app session. Enter the key again after restarting.")}</p>
      <button className="btn" type="button" disabled={blocked || needsKey || !draft.endpoint.trim()} onClick={() => void run("test")}>{t("Test and load models")}</button>
    </div>
    {!!models?.length && <label className="fld"><span>{t("Available models")}</span><select value={models.includes(draft.model) ? draft.model : ""} disabled={blocked} onChange={event => update({ model: event.target.value })}><option value="">{t("Choose a model")}</option>{models.map(name => <option key={name}>{name}</option>)}</select></label>}
    <label className="fld"><span>{t("Model ID")}</span><input value={draft.model} maxLength={200} spellCheck={false} disabled={blocked} onChange={event => update({ model: event.target.value })} /></label>
    {error && <p className="feature-alert assistant-connection-error" role="alert">{t(error)}</p>}
    {models !== null && <p className="assistant-note" role="status">{t(models.length ? "Model list loaded." : "No models were listed. Enter a model ID.")}</p>}
    <p className="assistant-note">{t("Messages will be sent to the selected API service. Switching services starts a new request context.")}</p>
    <button className="btn primary" type="button" disabled={blocked || !draft.name.trim() || !draft.endpoint.trim() || !draft.model.trim()} onClick={() => void run("apply")}>{t(dirty || !draft.id ? "Save and apply" : "Apply to this conversation")}</button>
    {confirmDialogNode}
  </div>;
}
