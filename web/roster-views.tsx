import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MAX_SAVED_VIEWS, sameProfileView, type ProfileViewFilters, type RosterScope, type SavedProfileView } from "../profile-view-state.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
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
function dismissOnEscape(event: KeyboardEvent, close: () => void) {
  if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

/** Saved views contain filters and table layout, never copied environments. */
export function RosterViews(props: RosterViewsProps) {
  const { t } = useTranslation();
  const id = useId();
  const [panel, setPanel] = useState<"editor" | "manager" | null>(null), [name, setName] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removed, setRemoved] = useState<SavedProfileView | null>(null), [pending, setPending] = useState(false);
  const entry = useRef<HTMLInputElement>(null), saveButton = useRef<HTMLButtonElement>(null), manageButton = useRef<HTMLButtonElement>(null);
  const firstView = useRef<HTMLButtonElement>(null);
  const operation = useRef(false), mounted = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null), viewSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (panel === "editor") entry.current?.focus();
    if (panel === "manager") firstView.current?.focus();
  }, [panel]);
  const locked = pending || props.busy || !props.ready;
  useEffect(() => {
    if (locked || !returnFocus.current) return;
    const target = [returnFocus.current, saveButton.current, manageButton.current, viewSelect.current].find(node => node?.isConnected && !node.matches(":disabled"));
    returnFocus.current = null;
    target?.focus({ preventScroll: true });
  }, [locked, panel]);
  const match = props.views.find(view => sameProfileView(view.filters, props.current));
  const defaultFilters = !props.current.query && props.current.group === "all" && props.current.status === "all" && !(props.current.tags?.length);
  const selected = match ? `saved:${match.id}` : defaultFilters ? props.current.scope : "custom";
  function closePanel(trigger: HTMLButtonElement | null) {
    if (operation.current) return;
    returnFocus.current = trigger;
    setPanel(null);
    setError("");
  }
  function togglePanel(next: "editor" | "manager") {
    setPanel(current => current === next ? null : next);
    setError("");
  }
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
    const nextFilters: ProfileViewFilters = {
      scope: props.current.scope,
      query: props.current.query,
      group: props.current.group,
      status: props.current.status,
      ...(props.current.tags?.length ? { tags: [...props.current.tags], tagMode: props.current.tagMode ?? "any" } : {}),
      sort: { ...props.current.sort },
      hiddenColumns: [...props.current.hiddenColumns],
      pageSize: props.current.pageSize,
    };
    const view: SavedProfileView = { id: `view_${crypto.randomUUID().replaceAll("-", "")}`, name: normalized, filters: nextFilters };
    void run(() => props.onSave(view), () => {
      setPanel(null);
      setName("");
      setRemoved(null);
      setNotice("View saved.");
      returnFocus.current = saveButton.current;
    });
  }
  function remove(view: SavedProfileView) {
    void run(() => props.onRemove(view.id), () => {
      if (props.views.length === 1) setPanel(null);
      setRemoved(view);
      setNotice("View removed.");
      returnFocus.current = manageButton.current;
    });
  }

  const editing = panel === "editor", managing = panel === "manager";
  const manageLabel = t("Manage saved views");
  return <section className="roster-views" aria-label={t("Environment views")} aria-busy={locked}>
    <div className="roster-view-bar">
      <label className="roster-view-select">
        <span>{t("View")}</span>
        <select className="select" ref={viewSelect} aria-label={t("Environment view")} value={selected} disabled={locked} onChange={event => {
          setError("");
          setNotice("");
          const value = event.target.value;
          if (value.startsWith("saved:")) {
            const view = props.views.find(item => `saved:${item.id}` === value);
            if (view) props.onApply(view);
          } else if (["all", "favorites", "recent", "attention"].includes(value)) props.onScope(value as RosterScope);
        }}>
          <optgroup label={t("Quick views")}>
            <option value="all">{t("All environments")} · {props.counts.all}</option>
            <option value="favorites">{t("Favorites")} · {props.counts.favorites}</option>
            <option value="recent">{t("Launched in the last 7 days")} · {props.counts.recent}</option>
            <option value="attention">{t("Needs attention")} · {props.counts.attention}</option>
          </optgroup>
          {props.views.length > 0 && <optgroup label={t("Saved in this workspace")}>
            {props.views.map(view => <option key={view.id} value={`saved:${view.id}`}>{view.name}</option>)}
          </optgroup>}
          {selected === "custom" && <option value="custom" disabled>{t("Current filters")}</option>}
        </select>
      </label>
      <div className="roster-view-actions">
        <button ref={saveButton} type="button" className="btn xs ghost" disabled={locked || props.views.length >= MAX_SAVED_VIEWS}
          aria-label={t("Save current view")} aria-expanded={editing} aria-controls={editing ? `${id}-editor` : undefined} onClick={() => togglePanel("editor")}>
          <AppIcon name="plus" className="sm" />{t("Save")}
        </button>
        <button ref={manageButton} type="button" className="iconbtn tip" disabled={locked || !props.views.length}
          aria-label={manageLabel} data-tip={manageLabel} aria-expanded={managing}
          aria-controls={managing ? `${id}-manager` : undefined} onClick={() => togglePanel("manager")}>
          <AppIcon name="settings" className="sm" />
        </button>
        {!props.ready && <button className="btn xs ghost" type="button" disabled={props.loading} onClick={props.onRetry}>{t("Reload views")}</button>}
      </div>
    </div>
    {!props.ready && <p className={props.readError ? "roster-view-error" : "roster-view-note"} role={props.readError ? "alert" : "status"}>{props.readError ? t(props.readError) : t("Loading this workspace's views…")}</p>}
    {props.current.scope === "recent" && <p className="roster-view-note">{t("Most recent launch first.")}</p>}
    {props.current.scope === "attention" && <p className="roster-view-note">{t("Invalid proxies, changes pending restart, or imported mobile profiles.")}</p>}
    {editing && <form className="roster-view-editor" id={`${id}-editor`} onSubmit={event => { event.preventDefault(); save(); }}
      onKeyDown={event => dismissOnEscape(event, () => closePanel(saveButton.current))}>
      <label className="fld">
        <span>{t("View name")}</span>
        <input className="input" ref={entry} maxLength={80} value={name} disabled={locked}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} onChange={event => { setName(event.target.value); setError(""); }} />
      </label>
      <p className="roster-view-editor-hint" id={`${id}-hint`}>{t("Saves filters, sorting and table layout.")}</p>
      {error && <p className="roster-view-error" id={`${id}-error`} role="alert">{t(error)}</p>}
      <div className="roster-view-editor-actions">
        <button className="btn xs primary" type="submit" disabled={locked}>{t(pending ? "Saving…" : "Save view")}</button>
        <button className="btn xs ghost" type="button" disabled={locked} onClick={() => closePanel(saveButton.current)}>{t("Cancel")}</button>
      </div>
    </form>}
    {managing && <section className="roster-view-manager" id={`${id}-manager`} aria-labelledby={`${id}-manager-title`}
      onKeyDown={event => dismissOnEscape(event, () => closePanel(manageButton.current))}>
      <header>
        <h3 id={`${id}-manager-title`}>{t("Saved views")}</h3>
        <button className="iconbtn" type="button" aria-label={t("Close")} disabled={pending} onClick={() => closePanel(manageButton.current)}>
          <AppIcon name="close" className="sm" />
        </button>
      </header>
      {props.views.length > 0 ? <ul className="roster-view-list">
        {props.views.map((view, index) => {
          const current = selected === `saved:${view.id}`;
          return <li key={view.id} className={current ? "is-current" : undefined}>
            <button className="roster-view-name" type="button" ref={index === 0 ? firstView : undefined}
              disabled={locked} aria-current={current || undefined} onClick={() => props.onApply(view)}>
              <AppIcon name={current ? "check" : "columns"} className="sm" /><bdi>{view.name}</bdi>
            </button>
            <button className="btn xs ghost roster-view-remove" type="button" disabled={locked}
              aria-label={t("Remove saved view {view}", { view: view.name })} onClick={() => remove(view)}>{t("Remove")}</button>
          </li>;
        })}
      </ul> : <p className="roster-view-note">{t("No saved views in this workspace")}</p>}
    </section>}
    {!editing && error && <p className="roster-view-error" role="alert">{t(error)}</p>}
    {(notice || removed) && <div className="roster-view-feedback">
      <p role="status">{t(notice || "View removed.")}</p>
      {removed && <button className="btn xs ghost" type="button" disabled={locked} onClick={() => void run(() => props.onSave(removed), () => { setRemoved(null); setNotice("Saved view restored."); returnFocus.current = manageButton.current; })}>{t("Undo")}</button>}
    </div>}
  </section>;
}
