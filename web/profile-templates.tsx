import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { copyTemplateSettings, deleteProfileTemplate, fetchProfileTemplates, ProfileTemplateRequestError, saveProfileTemplate, type ProfileTemplateCatalog, type ProfileTemplateSettings } from "./profile-templates-api.ts";
import "./profile-templates.css";

export interface ProfileTemplatesProps {
  draft: ProfileTemplateSettings;
  onApply: (settings: ProfileTemplateSettings) => void;
  disabled?: boolean;
}
const FIELDS = ["engine", "chromiumRuntime", "platformOs", "screen", "platform"] as const;
const LABELS = { engine: "Browser", chromiumRuntime: "Browser runtime", platformOs: "Operating system", screen: "Screen resolution", platform: "Platform" };
function failure(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function ProfileTemplates({ draft, onApply, disabled = false }: ProfileTemplatesProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false), [catalog, setCatalog] = useState<ProfileTemplateCatalog | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState(""), [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "rename"; id: string } | null>(null), [name, setName] = useState("");
  const mounted = useRef(true), attempted = useRef(false), operating = useRef(false), controller = useRef<AbortController | null>(null), nameInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null), renameButton = useRef<HTMLButtonElement>(null), previousEditor = useRef<"create" | "rename" | null>(null);
  const locked = disabled || busy || loading;
  const selected = catalog?.templates.find(item => item.id === selectedId);
  const changes = selected ? FIELDS.filter(field => draft[field] !== selected.settings[field]) : [];
  const deleted = catalog?.templates.find(item => item.id === pendingDelete);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (expanded && !attempted.current && !disabled) void load(); }, [expanded, disabled]);
  useEffect(() => {
    if (editor) { previousEditor.current = editor.mode; nameInput.current?.focus(); }
    else if (previousEditor.current) { (previousEditor.current === "create" ? saveButton.current : renameButton.current)?.focus(); previousEditor.current = null; }
  }, [editor]);
  function accept(next: ProfileTemplateCatalog) {
    setCatalog(next);
    setSelectedId(previous => next.templates.some(item => item.id === previous) ? previous : "");
    setPendingDelete(previous => next.templates.some(item => item.id === previous) ? previous : null);
  }
  async function load() {
    if (operating.current || disabled) return;
    operating.current = true; attempted.current = true; setLoading(true); setError(""); setNotice("");
    const active = new AbortController(); controller.current = active;
    try { const next = await fetchProfileTemplates(active.signal); if (mounted.current) accept(next); }
    catch (error) { if (mounted.current) setError(failure(error)); }
    finally { operating.current = false; if (mounted.current) setLoading(false); if (controller.current === active) controller.current = null; }
  }
  async function mutate(operation: (revision: number, signal: AbortSignal) => Promise<ProfileTemplateCatalog>, success: (next: ProfileTemplateCatalog) => void) {
    if (!catalog || operating.current || disabled) return;
    operating.current = true; setBusy(true); setError(""); setNotice("");
    const active = new AbortController(); controller.current = active;
    try {
      const next = await operation(catalog.revision, active.signal);
      if (mounted.current) { accept(next); success(next); }
    } catch (error) {
      if (!mounted.current) return;
      setError(failure(error));
      if (error instanceof ProfileTemplateRequestError && ["revision-conflict", "not-found"].includes(error.code)) {
        try {
          const next = await fetchProfileTemplates(active.signal);
          if (mounted.current) { accept(next); setNotice("The preset list was refreshed. Review it before trying again."); }
        } catch { /* Keep the original operation error and the user's input. */ }
      }
    } finally { operating.current = false; if (mounted.current) setBusy(false); if (controller.current === active) controller.current = null; }
  }
  function save() {
    if (!editor || !name.trim()) return;
    const existing = editor.mode === "rename" ? catalog?.templates.find(item => item.id === editor.id) : undefined;
    if (editor.mode === "rename" && !existing) { setError("The selected profile template no longer exists."); return; }
    const input = { ...(existing ? { id: existing.id } : {}), name: name.trim().normalize("NFC"), settings: copyTemplateSettings(existing?.settings ?? draft) };
    void mutate((revision, signal) => saveProfileTemplate(input, revision, signal), next => {
      setSelectedId(existing?.id ?? next.templates.find(item => item.name === input.name)?.id ?? "");
      setEditor(null); setName(""); setNotice(existing ? "Preset renamed." : "Preset saved.");
    });
  }
  function value(field: typeof FIELDS[number], input: string, engine: ProfileTemplateSettings["engine"]): string {
    if (field === "chromiumRuntime" && engine === "firefox") return t("Not applicable to Firefox");
    if (!input) return t(field === "platform" ? "None" : "Automatic");
    if (field === "engine") return input === "firefox" ? "Firefox" : "Chromium";
    if (field === "chromiumRuntime") return input === "aliasmode" ? "Chromium 155" : "CloakBrowser 146";
    if (field === "platformOs") return ({ windows: "Windows", macos: "macOS", linux: "Linux" } as Record<string, string>)[input] ?? input;
    return input;
  }
  return <details className="profile-templates" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} onKeyDown={event => {
    if (event.key === "Escape" && (editor || pendingDelete)) { event.preventDefault(); event.stopPropagation(); if (!busy) { setEditor(null); setPendingDelete(null); setName(""); } }
  }}>
    <summary><span>{t("Profile presets")}</span><span className="profile-template-count">{catalog ? t("{count} presets", { count: catalog.templates.length }) : t("Optional")}</span></summary>
    {expanded && <div className="profile-template-body">
      <p className="profile-template-note">{t("Apply only browser, runtime, operating system, screen and platform. Other draft fields stay as entered.")}</p>
      {error && <p className="profile-template-error" role="alert">{t(error)}</p>}
      {notice && <p className="profile-template-notice" role="status">{t(notice)}</p>}
      {loading && <p className="profile-template-note" role="status">{t("Loading presets…")}</p>}
      {!catalog && !loading && <button className="btn xs" type="button" disabled={disabled || busy} onClick={() => void load()}>{t("Try again")}</button>}
      {catalog && <>
        <div className="profile-template-picker"><label className="fld grow"><span>{t("Preset")}</span><select value={selectedId} disabled={locked || !!editor || !!pendingDelete || !catalog.templates.length} onChange={event => { setSelectedId(event.target.value); setNotice(""); setError(""); }}><option value="">{t("Choose a preset")}</option>{catalog.templates.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="btn xs ghost" type="button" disabled={locked || !!editor || !!pendingDelete} onClick={() => void load()}>{t("Refresh presets")}</button></div>
        {!catalog.templates.length && <p className="profile-template-note">{t("No presets yet. Save the current settings to reuse them later.")}</p>}
        {selected && <div className="profile-template-preview" role="region" aria-label={t("Preset changes")}>
          {changes.length ? <table><caption>{t("Review changes before applying")}</caption><thead><tr><th scope="col">{t("Setting")}</th><th scope="col">{t("Current draft")}</th><th scope="col">{t("Preset")}</th></tr></thead><tbody>{changes.map(field => <tr key={field}><th scope="row">{t(LABELS[field])}</th><td>{value(field, draft[field], draft.engine)}</td><td>{value(field, selected.settings[field], selected.settings.engine)}</td></tr>)}</tbody></table> : <p className="profile-template-note">{t("This preset already matches the current settings.")}</p>}
          <div className="profile-template-actions"><button className="btn xs accent" type="button" disabled={locked || !!editor || !!pendingDelete || !changes.length} onClick={() => {
            try { onApply(copyTemplateSettings(selected.settings)); setNotice("Preset applied to this draft. Create the profile when you are ready."); setError(""); }
            catch (error) { setError(failure(error)); }
          }}>{t("Apply preset")}</button><button ref={renameButton} className="btn xs ghost" type="button" disabled={locked || !!editor || !!pendingDelete} onClick={() => { setEditor({ mode: "rename", id: selected.id }); setName(selected.name); setError(""); setNotice(""); }}>{t("Rename preset")}</button><button className="btn xs ghost danger" type="button" disabled={locked || !!editor || !!pendingDelete} onClick={() => { setPendingDelete(selected.id); setError(""); setNotice(""); }}>{t("Delete preset")}</button></div>
        </div>}
        {deleted && <div className="profile-template-delete" role="status"><p>{t("The preset has not been deleted. Undo or confirm to remove it.")} <strong>{deleted.name}</strong></p><div className="profile-template-actions"><button className="btn xs" type="button" disabled={locked} onClick={() => setPendingDelete(null)}>{t("Undo")}</button><button className="btn xs danger" type="button" disabled={locked} aria-busy={busy} onClick={() => void mutate((revision, signal) => deleteProfileTemplate(deleted.id, revision, signal), () => { setPendingDelete(null); setSelectedId(""); setNotice("Preset deleted."); })}>{t("Confirm deletion")}</button></div></div>}
        {!editor && <button ref={saveButton} className="btn xs ghost profile-template-save" type="button" disabled={locked || !!pendingDelete || catalog.templates.length >= 100} onClick={() => { setEditor({ mode: "create" }); setName(""); setError(""); setNotice(""); }}>{t("Save current settings as preset")}</button>}
        {editor && <div className="profile-template-editor"><label className="fld grow"><span>{t("Preset name")}</span><input ref={nameInput} value={name} maxLength={80} autoComplete="off" disabled={locked} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); save(); } }} /></label><div className="profile-template-actions"><button className="btn xs accent" type="button" disabled={locked || !name.trim()} aria-busy={busy} onClick={save}>{t(editor.mode === "rename" ? "Save preset name" : "Save preset")}</button><button className="btn xs ghost" type="button" disabled={locked} onClick={() => { setEditor(null); setName(""); }}>{t("Cancel")}</button></div></div>}
      </>}
    </div>}
  </details>;
}
