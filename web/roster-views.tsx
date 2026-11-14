import { useEffect, useRef, useState } from "react";
import { MAX_SAVED_VIEWS, sameProfileView, type ProfileViewFilters, type RosterScope, type SavedProfileView } from "../profile-view-state.ts";
import { useTranslation } from "./i18n.tsx";
import "./roster-views.css";

export interface RosterViewsProps {
  current: ProfileViewFilters;
  views: SavedProfileView[];
  counts: Record<RosterScope, number>;
  ready: boolean;
  loading?: boolean;
  readError?: string | null;
  busy: boolean;
  onRetry: () => void;
  onScope: (scope: RosterScope) => void;
  onApply: (view: SavedProfileView) => void;
  onSave: (view: SavedProfileView) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
}
function Glyph({ kind }: { kind: "save" | "manage" | "close" }) {
  return <svg className="icon sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "save" ? <path d="M12 5v14M5 12h14" /> : kind === "manage" ? <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></> : <path d="m6 6 12 12M6 18 18 6" />}
  </svg>;
}

/** Saved views contain filters and table layout, never copied environments. */
export function RosterViews(props: RosterViewsProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false), [managing, setManaging] = useState(false), [name, setName] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removed, setRemoved] = useState<SavedProfileView | null>(null), [pending, setPending] = useState(false);
  const entry = useRef<HTMLInputElement>(null), saveButton = useRef<HTMLButtonElement>(null), manageButton = useRef<HTMLButtonElement>(null);
  const operation = useRef(false), mounted = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null), viewSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (editing) entry.current?.focus(); }, [editing]);
  const locked = pending || props.busy || !props.ready;
  useEffect(() => {
    if (locked || !returnFocus.current) return;
    const target = [returnFocus.current, saveButton.current, manageButton.current, viewSelect.current].find(node => node?.isConnected && !node.matches(":disabled"));
    returnFocus.current = null;
    target?.focus({ preventScroll: true });
  }, [locked, editing, managing]);
  const match = props.views.find(view => sameProfileView(view.filters, props.current));
  const defaultFilters = !props.current.query && props.current.group === "all" && props.current.status === "all";
  const selected = match ? `saved:${match.id}` : defaultFilters ? props.current.scope : "custom";
  function closeEditor() { if (operation.current) return; setEditing(false); setError(""); saveButton.current?.focus(); }
  async function run(task: () => Promise<boolean>, success: () => void) {
    if (locked || operation.current) return;
    operation.current = true; setPending(true); setError(""); setNotice("");
    try {
      if (await task()) { if (mounted.current) success(); }
      else if (mounted.current) setError("The view change could not be saved. Your changes are kept; try again.");
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { operation.current = false; if (mounted.current) setPending(false); }
  }
  function save() {
    const normalized = name.trim().normalize("NFC");
    if (!normalized) { setError("Give this view a name."); entry.current?.focus(); return; }
    if (Array.from(normalized).length > 40 || /[\x00-\x1f\x7f]/.test(normalized)) { setError("View names must contain 1–40 characters."); entry.current?.focus(); return; }
    if (props.views.some(view => view.name.toLowerCase() === normalized.toLowerCase())) { setError("A saved view already uses this name."); entry.current?.focus(); return; }
    const view: SavedProfileView = { id: `view_${crypto.randomUUID().replaceAll("-", "")}`, name: normalized, filters: { ...props.current, sort: { ...props.current.sort }, hiddenColumns: [...props.current.hiddenColumns] } };
    void run(() => props.onSave(view), () => { setEditing(false); setName(""); setRemoved(null); setNotice("View saved in this workspace."); returnFocus.current = saveButton.current; });
  }
  return <section className="roster-views" aria-label={t("Environment views")} aria-busy={locked}>
    <div className="roster-view-bar"><label className="roster-view-select"><span>{t("View")}</span><select className="select" ref={viewSelect} aria-label={t("Environment view")} value={selected} disabled={locked} onChange={event => {
      setError(""); setNotice("");
      const value = event.target.value;
      if (value.startsWith("saved:")) { const view = props.views.find(item => `saved:${item.id}` === value); if (view) props.onApply(view); }
      else if (["all", "favorites", "recent", "attention"].includes(value)) props.onScope(value as RosterScope);
    }}><optgroup label={t("Quick views")}><option value="all">{t("All environments")} · {props.counts.all}</option><option value="favorites">{t("Favorites")} · {props.counts.favorites}</option><option value="recent">{t("Launched in the last 7 days")} · {props.counts.recent}</option><option value="attention">{t("Needs attention")} · {props.counts.attention}</option></optgroup>{props.views.length > 0 && <optgroup label={t("Saved in this workspace")}>{props.views.map(view => <option key={view.id} value={`saved:${view.id}`}>{view.name}</option>)}</optgroup>}{selected === "custom" && <option value="custom" disabled>{t("Current filters")}</option>}</select></label>
      <div className="roster-view-actions"><button ref={saveButton} type="button" className="btn xs ghost" disabled={locked || props.views.length >= MAX_SAVED_VIEWS} aria-expanded={editing} onClick={() => { setEditing(value => !value); setManaging(false); setError(""); }}><Glyph kind="save" />{t("Save current view")}</button><button ref={manageButton} type="button" className="iconbtn tip" disabled={locked || !props.views.length} aria-label={t("Manage saved views")} data-tip={t("Manage saved views")} aria-expanded={managing} onClick={() => { setManaging(value => !value); setEditing(false); setError(""); }}><Glyph kind="manage" /></button>{!props.ready && <button className="btn xs ghost" type="button" disabled={props.loading} onClick={props.onRetry}>{t("Reload views")}</button>}</div>
    </div>
    {!props.ready && <p className={props.readError ? "roster-view-error" : "roster-view-note"} role={props.readError ? "alert" : "status"}>{props.readError ? t(props.readError) : t("Loading this workspace's views…")}</p>}
    {props.current.scope === "recent" && <p className="roster-view-note">{t("Sorted by the most recent launch on this computer. Group and status filters still apply.")}</p>}
    {props.current.scope === "attention" && <p className="roster-view-note">{t("Includes invalid proxy settings, changes awaiting restart and imported mobile profiles.")}</p>}
    {editing && <form className="roster-view-editor" onSubmit={event => { event.preventDefault(); save(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(); } }}><div><label className="fld"><span>{t("View name")}</span><input className="input" ref={entry} maxLength={80} value={name} disabled={locked} placeholder={t("For example: Overseas · running")} onChange={event => setName(event.target.value)} /></label><p>{t("Saves the search, group, status, quick view, columns and sorting. Environments stay where they are.")}</p></div><button className="btn xs primary" type="submit" disabled={locked}>{t(pending ? "Saving…" : "Save view")}</button><button className="btn xs ghost" type="button" disabled={locked} onClick={closeEditor}>{t("Cancel")}</button></form>}
    {managing && <div className="roster-view-manager"><header><strong>{t("Saved views")}</strong><button className="iconbtn" type="button" aria-label={t("Close")} onClick={() => { setManaging(false); manageButton.current?.focus(); }}><Glyph kind="close" /></button></header>{props.views.map(view => <div key={view.id}><button type="button" className="roster-view-name" disabled={locked} onClick={() => props.onApply(view)}>{view.name}</button><button type="button" className="btn xs ghost" disabled={locked} aria-label={t("Remove saved view {view}", { view: view.name })} onClick={() => void run(() => props.onRemove(view.id), () => { setRemoved(view); setNotice("Saved view removed. You can undo this."); returnFocus.current = manageButton.current; })}>{t("Remove")}</button></div>)}</div>}
    {error && <p className="roster-view-error" role="alert">{t(error)}</p>}
    {(notice || removed) && <p className="roster-view-note" role="status">{t(notice || "Saved view removed. You can undo this.")} {removed && <button className="btn xs ghost" type="button" disabled={locked} onClick={() => void run(() => props.onSave(removed), () => { setRemoved(null); setNotice("Saved view restored."); returnFocus.current = manageButton.current; })}>{t("Undo")}</button>}</p>}
  </section>;
}
