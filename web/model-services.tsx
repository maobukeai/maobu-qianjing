import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ASSISTANT_SERVICE_LABELS as providers, readAssistantServices, removeAssistantService, requiresAssistantServiceKey, saveAssistantService, setDefaultAssistantService, testAssistantService,
  type AssistantServiceDraft, type AssistantServiceProvider, type AssistantServiceView, type AssistantServicesCatalog } from "./assistant-services-api.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useTranslation } from "./i18n.tsx";
import { AssistantRequestError } from "./local-assistant-api.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage } from "./workspace-operations.tsx";
import "./model-services.css";

const sampleEndpoints: Record<AssistantServiceProvider, string> = {
  "ollama": "http://127.0.0.1:11434", "openai-compatible": "https://api.example.com/v1", "anthropic": "https://api.anthropic.com/v1", "gemini": "https://generativelanguage.googleapis.com/v1beta",
};
const newDraft = (): AssistantServiceDraft => ({ name: "", provider: "openai-compatible", endpoint: "", model: "" });
const draftFor = ({ id, name, provider, endpoint, model }: AssistantServiceView): AssistantServiceDraft => ({ id, name, provider, endpoint, model });
function requestDraft(draft: AssistantServiceDraft): AssistantServiceDraft {
  return { ...draft, apiKey: draft.apiKey === "" ? "" : draft.apiKey?.trim() || undefined };
}
type TaskKind = "read" | "test" | "save" | "default" | "remove";

function ServiceIcon({ local = false }: { local?: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {local ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> : <path d="M6 18h12a4 4 0 1 0-.9-7.9A5.5 5.5 0 0 0 6.7 9.6 4.2 4.2 0 0 0 6 18Z" />}
  </svg>;
}

interface ModelServicesPanelProps {
  active: boolean;
  workspaceId: string | null;
  onCatalogChanged?: (catalog: AssistantServicesCatalog) => void;
}

/** This owner survives tab switches. A new workspace always gets a clean form. */
export function ModelServicesPanel({ workspaceId, ...props }: ModelServicesPanelProps) {
  return <ModelServicesSession key={workspaceId} workspaceId={workspaceId} {...props} />;
}

function ModelServicesSession({ active, workspaceId, onCatalogChanged }: ModelServicesPanelProps) {
  const { t } = useTranslation(), workspace = useOptionalWorkspaceOperations();
  const [catalog, setCatalog] = useState<AssistantServicesCatalog | null>(null);
  const [draft, setDraft] = useState<AssistantServiceDraft | null>(null);
  const [pending, setPending] = useState<TaskKind | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lifecycle = useRef<{ mounted: boolean; task: AbortController | null }>({ mounted: true, task: null });
  const activeRef = useRef(active), catalogListener = useRef(onCatalogChanged);
  activeRef.current = active;
  catalogListener.current = onCatalogChanged;
  const nameInput = useRef<HTMLInputElement>(null), focusName = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null), removeButton = useRef<HTMLButtonElement>(null), cancelRemoveButton = useRef<HTMLButtonElement>(null);
  const focusAfterRemoval = useRef<"add" | "remove" | null>(null);
  const headingId = useId(), listId = useId(), keyHint = useId(), testHint = useId();

  const saved = catalog?.services.find(service => service.id === draft?.id);
  const defaultService = catalog?.services.find(service => service.id === catalog.defaultId);
  const local = draft?.provider === "ollama";
  const sameTarget = !!saved && !!draft && saved.provider === draft.provider && saved.endpoint === draft.endpoint.trim();
  const hasKey = draft?.apiKey === undefined ? sameTarget && saved?.credentialConfigured : !!draft.apiKey.trim();
  const needsKey = !!draft && requiresAssistantServiceKey(draft.provider) && !hasKey;
  const dirty = !!draft && (draft.apiKey !== undefined || (saved
    ? saved.name !== draft.name || !sameTarget || saved.model !== draft.model
    : draft.name !== "" || draft.endpoint !== "" || draft.model !== "" || draft.provider !== "openai-compatible"));
  const workspaceBlocked = workspace?.snapshot.blocked === true;
  const workspaceReady = !!workspaceId && (!workspace || workspace.snapshot.workspaceId === workspaceId);
  const locked = pending !== null || workspaceBlocked || readFailed;
  const canSave = !!draft?.name.trim() && !!draft.endpoint.trim() && !!draft.model.trim() && (!saved || dirty);
  useDesktopCloseDraft("assistant-service-draft", { dirty, busy: pending === "save" || pending === "default" || pending === "remove" });

  function ownsWorkspace() {
    return lifecycle.current.mounted && !!workspaceId && (!workspace || workspace.coordinator.getSnapshot().workspaceId === workspaceId);
  }

  async function run<T>(kind: TaskKind, task: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, failure: string) {
    if (!activeRef.current || !ownsWorkspace() || lifecycle.current.task || (kind !== "read" && workspace?.coordinator.getSnapshot().blocked)) return;
    const controller = new AbortController();
    lifecycle.current.task = controller;
    setPending(kind); setError(""); setNotice("");
    try {
      const value = await task(controller.signal);
      if (ownsWorkspace() && lifecycle.current.task === controller) accept(value);
    } catch (problem) {
      if (ownsWorkspace() && lifecycle.current.task === controller) {
        if (kind === "read") setReadFailed(true);
        setError(problem instanceof AssistantRequestError ? problem.message : failure);
      }
    } finally {
      if (lifecycle.current.task === controller) {
        lifecycle.current.task = null;
        if (ownsWorkspace()) setPending(null);
      }
    }
  }

  function publish(next: AssistantServicesCatalog) {
    setCatalog(next);
    catalogListener.current?.(next);
  }

  function installSelection(next: AssistantServicesCatalog, id: string | null = next.defaultId) {
    const service = next.services.find(item => item.id === id) ?? next.services[0];
    setDraft(service ? draftFor(service) : null);
    setModels(null); setConfirmRemove(false);
  }

  function load() {
    void run("read", readAssistantServices, next => {
      setReadFailed(false);
      publish(next); installSelection(next, draft?.id ?? next.defaultId);
    }, "Model services could not be loaded. Try again.");
  }

  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.task?.abort(); lifecycle.current.task = null;
    };
  }, []);
  useEffect(() => { if (active && workspaceReady && !dirty) load(); }, [active, workspaceReady]);
  useLayoutEffect(() => {
    if (!active || !focusName.current || !nameInput.current) return;
    focusName.current = false;
    nameInput.current.focus({ preventScroll: true });
  }, [active, draft?.id, draft === null]);
  useLayoutEffect(() => {
    if (!active) return;
    if (confirmRemove) cancelRemoveButton.current?.focus({ preventScroll: true });
    else if (focusAfterRemoval.current) {
      (focusAfterRemoval.current === "remove" ? removeButton.current ?? addButton.current : addButton.current)?.focus({ preventScroll: true });
      focusAfterRemoval.current = null;
    }
  }, [active, confirmRemove]);

  function change(values: Partial<AssistantServiceDraft>, invalidateTest = false) {
    if (!draft || lifecycle.current.task || !activeRef.current || !ownsWorkspace()) return;
    setDraft({ ...draft, ...values });
    if (invalidateTest) setModels(null);
    setError(""); setNotice(""); setConfirmRemove(false);
  }

  function choose(service?: AssistantServiceView) {
    if (!activeRef.current || !ownsWorkspace() || locked || (service && service.id === draft?.id)) return;
    if (dirty) { setError("Save or discard your changes before choosing another model service."); return; }
    focusName.current = !service;
    setDraft(service ? draftFor(service) : newDraft());
    setModels(null); setError(""); setNotice(""); setConfirmRemove(false);
    if (!service) nameInput.current?.focus({ preventScroll: true });
  }

  function discard() {
    if (locked || !catalog || !activeRef.current || !ownsWorkspace()) return;
    installSelection(catalog, saved?.id ?? catalog.defaultId);
    setError(""); setNotice("");
  }

  function testConnection() {
    if (!draft?.endpoint.trim() || needsKey) return;
    setModels(null); setConfirmRemove(false);
    void run("test", signal => testAssistantService(requestDraft({ ...draft, model: "" }), signal), result => {
      setModels([...new Set(result.models.map(model => model.name))]);
    }, "The model service could not be tested. Check the connection details and try again.");
  }

  function save() {
    if (!draft || !canSave || !catalog) return;
    const existing = new Set(catalog.services.map(service => service.id));
    void run("save", signal => saveAssistantService(requestDraft(draft), signal), next => {
      const added = next.services.filter(service => !existing.has(service.id));
      const id = draft.id ?? (added.length === 1 ? added[0]!.id : added.find(service => service.name === draft.name.trim() && service.provider === draft.provider && service.model === draft.model.trim())?.id) ?? next.defaultId;
      publish(next); installSelection(next, id);
      setNotice("Model service saved.");
    }, "The model service could not be saved. Try again.");
  }

  function setDefault(id: string | null) {
    if (dirty || !saved) return;
    void run("default", signal => setDefaultAssistantService(id, signal), next => {
      publish(next);
      setNotice(id ? "Default model service updated." : "Default model service cleared.");
    }, "The default model service could not be changed. Try again.");
  }

  function remove() {
    if (!saved || dirty || !confirmRemove) return;
    void run("remove", signal => removeAssistantService(saved.id, signal), next => {
      focusAfterRemoval.current = "add";
      publish(next); installSelection(next);
      setNotice("Model service removed.");
    }, "The model service could not be removed. Try again.");
  }

  function cancelRemoval() {
    focusAfterRemoval.current = "remove";
    setConfirmRemove(false);
  }

  return <section className="feature-panel model-services" aria-labelledby={headingId} hidden={!active}>
    <header className="model-services-header">
      <div><h2 id={headingId}>{t("Model services")}</h2><p>{defaultService ? t("Default model: {service} / {model}", { service: defaultService.name, model: defaultService.model }) : t("No default model service selected")}</p></div>
      <div className="model-services-actions">{notice && <p className="feature-success model-services-notice" role="status">{t(notice)}</p>}<button ref={addButton} className="btn primary" type="button" disabled={!catalog || locked} onClick={() => choose()}>{t("Add model service")}</button></div>
    </header>
    {workspaceBlocked && workspace && <p className="feature-inline-note" role="status">{t(workspaceOperationMessage(workspace.snapshot))}</p>}
    {error && <div className="feature-alert" role="alert"><p>{t(error)}</p>{readFailed && catalog && <button className="btn xs" type="button" disabled={pending !== null} onClick={load}>{t("Try again")}</button>}</div>}
    {!catalog ? <div className="feature-card model-services-placeholder">
      {error ? <button className="btn" type="button" disabled={pending !== null} onClick={load}>{t("Try again")}</button>
        : <p role="status">{workspaceReady ? t("Loading model services…") : t("Load the workspace before managing model services.")}</p>}
    </div> : <div className="model-services-grid" aria-busy={pending !== null}>
      <nav className="model-services-list" aria-labelledby={listId}>
        <h3 id={listId}>{t("Saved connections")}</h3>
        {catalog.services.length === 0 && <p className="model-services-empty">{t("No saved connections yet")}</p>}
        {catalog.services.map(service => <button type="button" key={service.id} className="model-services-list-item" aria-pressed={saved?.id === service.id} disabled={locked} onClick={() => choose(service)}>
          <span className="model-services-icon"><ServiceIcon local={service.provider === "ollama"} /></span>
          <span className="model-services-item-text"><strong>{service.name}</strong><small>{t(providers[service.provider])}</small>{requiresAssistantServiceKey(service.provider) && !service.credentialConfigured && <small className="model-services-key-required">{t("API key required for this session")}</small>}</span>
          {catalog.defaultId === service.id && <span className="model-services-default">{t("Default")}</span>}
        </button>)}
      </nav>
      {draft ? <div className="model-services-detail">
        <div className="model-services-detail-head"><h3>{saved?.name ?? t("New model service")}</h3>{dirty && <span className="feature-badge">{t("Unsaved changes")}</span>}</div>
        <div className="model-services-fields">
          <label className="fld"><span>{t("Service protocol")}</span><select value={draft.provider} disabled={locked} onChange={event => {
            const provider = event.currentTarget.value as AssistantServiceProvider;
            if (provider === draft.provider || !Object.hasOwn(providers, provider)) return;
            change({ provider, endpoint: provider === "ollama" ? sampleEndpoints.ollama : "", model: "", apiKey: undefined }, true);
          }}>{Object.entries(providers).map(([provider, label]) => <option key={provider} value={provider}>{t(label)}</option>)}</select></label>
          <label className="fld"><span>{t("Connection name")}</span><input ref={nameInput} value={draft.name} maxLength={80} disabled={locked} onChange={event => change({ name: event.currentTarget.value })} /></label>
          <label className="fld model-services-span"><span>{t(local ? "Local service address" : "API base URL")}</span><input type="url" className="model-services-mono" value={draft.endpoint} placeholder={sampleEndpoints[draft.provider]} maxLength={512} spellCheck={false} disabled={locked} onChange={event => change({ endpoint: event.currentTarget.value, apiKey: undefined }, true)} /></label>
          {!local && <div className="model-services-span model-services-secret">
            <label className="fld"><span>{t("API key")}</span><input type="password" value={draft.apiKey ?? ""} autoComplete="new-password" spellCheck={false} maxLength={2048} disabled={locked} aria-describedby={keyHint} placeholder={sameTarget && saved?.credentialConfigured && draft.apiKey !== "" ? t("Session key configured") : undefined} onChange={event => change({ apiKey: event.currentTarget.value || undefined }, true)} /></label>
            <div className="model-services-secret-note"><p id={keyHint} className={needsKey ? "model-services-key-required" : undefined}>{t(draft.apiKey === "" ? "Saving will clear the key for this session." : needsKey ? "API key required for this session" : "API keys are kept for this app session. Enter the key again after restarting.")}</p>
              {sameTarget && saved?.credentialConfigured && <button type="button" className="btn xs ghost" disabled={locked} onClick={() => change({ apiKey: draft.apiKey === "" ? undefined : "" }, true)}>{t(draft.apiKey === "" ? "Keep session key" : "Clear session key")}</button>}</div>
          </div>}
        </div>
        <div className="model-services-actions"><button type="button" className="btn" disabled={locked || needsKey || !draft.endpoint.trim()} aria-describedby={testHint} onClick={testConnection}>{t(pending === "test" ? "Testing connection…" : "Test and load models")}</button><span id={testHint}>{t("Testing sends no chat messages.")}</span></div>
        {models !== null && <p className="feature-success model-services-notice" role="status">{t(models.length ? "Model list loaded." : "The service returned no models. You can enter a model ID manually.")}</p>}
        <div className="model-services-model">
          <div className="model-services-fields">
            {models !== null && models.length > 0 && <label className="fld"><span>{t("Discovered models")}</span><select value={models.includes(draft.model) ? draft.model : ""} disabled={locked} onChange={event => { if (event.currentTarget.value) change({ model: event.currentTarget.value }); }}><option value="">{t("Choose a model")}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
            <label className={`fld${models?.length ? "" : " model-services-span"}`}><span>{t("Model ID")}</span><input className="model-services-mono" value={draft.model} maxLength={200} spellCheck={false} placeholder={t("Enter a model ID")} disabled={locked} onChange={event => change({ model: event.currentTarget.value })} /></label>
          </div>
          {saved && <button type="button" className="btn xs" disabled={locked || dirty} onClick={() => setDefault(defaultService?.id === saved.id ? null : saved.id)}>{t(defaultService?.id === saved.id ? "Clear default model service" : "Set as default model service")}</button>}
        </div>
        {!local && <p className="model-services-destination">{t("When selected in AI Workspace, this service receives the conversation you send.")}</p>}
        <div className="model-services-footer">
          {saved && <button ref={removeButton} type="button" className="btn ghost danger" disabled={locked || dirty || confirmRemove} onClick={() => setConfirmRemove(true)}>{t("Remove model service")}</button>}
          <div className="model-services-actions">
            {(dirty || !saved) && <button className="btn ghost" type="button" disabled={locked} onClick={discard}>{t(dirty ? "Discard changes" : "Cancel")}</button>}
            <button className="btn primary" type="button" disabled={locked || !canSave} onClick={save}>{t(pending === "save" ? "Saving…" : "Save connection")}</button>
          </div>
        </div>
        {confirmRemove && saved && <div className="model-services-remove" role="group" aria-label={t("Confirm removal")} onKeyDown={event => {
          if (event.key === "Escape" && !locked) { event.stopPropagation(); cancelRemoval(); }
        }}><p>{t("Remove the model service {service}?", { service: saved.name })}</p><div className="model-services-actions"><button ref={cancelRemoveButton} type="button" className="btn" disabled={locked} onClick={cancelRemoval}>{t("Cancel")}</button><button type="button" className="btn solid-danger" disabled={locked} onClick={remove}>{t(pending === "remove" ? "Removing…" : "Remove connection")}</button></div></div>}
      </div> : <div className="model-services-detail model-services-placeholder"><h3>{t("Add your first model service")}</h3><p>{t("Connect to local Ollama or save an API service for the AI workspace.")}</p></div>}
    </div>}
  </section>;
}
