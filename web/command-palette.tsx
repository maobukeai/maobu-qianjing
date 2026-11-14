import * as React from "react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "./i18n.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
import { hasActiveWorkbenchModal } from "./workbench-shortcuts.ts";
import type { ProfileViewFilters, SavedProfileView } from "../profile-view-state.ts";
import { createProfileSearchIndex, searchProfileIndex, type CommandPaletteProfile } from "./profile-search.ts";
export type { CommandPaletteProfile } from "./profile-search.ts";
import "./command-palette.css";

export interface CommandPaletteCommand {
  id: string;
  label: string;
  description?: string;
  keywords?: string[] | string;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Search source and translated labels together, keeping caller order for equal matches. */
export function filterCommands<T extends Pick<CommandPaletteCommand, "id" | "label" | "description" | "keywords">>(commands: readonly T[], query: string, translate: (value: string) => string = value => value): T[] {
  const search = normalize(query).slice(0, 500);
  const terms = search.split(" ").filter(Boolean);
  const seen = new Set<string>();
  const matches: Array<{ command: T; index: number; score: number }> = [];
  commands.forEach((command, index) => {
    if (!command.id || seen.has(command.id)) return;
    seen.add(command.id);
    if (!terms.length) { matches.push({ command, index, score: 0 }); return; }
    const labels = [normalize(command.label), normalize(translate(command.label))];
    const keywords = Array.isArray(command.keywords) ? command.keywords.join(" ") : command.keywords ?? "";
    const haystack = `${labels.join(" ")} ${normalize(command.description ?? "")} ${normalize(translate(command.description ?? ""))} ${normalize(keywords)}`;
    if (!terms.every(term => haystack.includes(term))) return;
    const score = (labels.some(label => label === search) ? 10_000 : labels.some(label => label.startsWith(search)) ? 5_000 : 0)
      + terms.reduce((total, term) => total + (labels.some(label => label.startsWith(term)) ? 100 : labels.some(label => label.includes(term)) ? 20 : 1), 0);
    matches.push({ command, index, score });
  });
  return matches.sort((a, b) => b.score - a.score || a.index - b.index).map(match => match.command);
}

export type CommandNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";
/** Disabled commands stay visible but never receive keyboard selection. */
export function nextCommandIndex(commands: readonly Pick<CommandPaletteCommand, "disabled">[], current: number, key: CommandNavigationKey): number {
  const enabled = commands.flatMap((command, index) => command.disabled ? [] : [index]);
  if (!enabled.length) return -1;
  if (key === "Home") return enabled[0]!;
  if (key === "End") return enabled[enabled.length - 1]!;
  const position = enabled.indexOf(current);
  if (position < 0) return key === "ArrowUp" ? enabled[enabled.length - 1]! : enabled[0]!;
  return enabled[(position + (key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]!;
}

function rendered(element: Element): boolean {
  return !element.closest('[hidden], [aria-hidden="true"], [inert]') && element.getClientRects().length > 0;
}

/** Check this before the root handles Ctrl/Cmd+K; typing and existing modal tasks take priority. */
export function isShortcutTargetAllowed(target: EventTarget | null, ownerDocument?: Document): boolean {
  const element = target && typeof (target as Element).closest === "function" ? target as Element : null;
  if (element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]')) return false;
  const document = ownerDocument ?? element?.ownerDocument ?? (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
  if (!document) return true;
  return !Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .modal-backdrop')).some(rendered);
}

export function isCommandPaletteShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented" | "isComposing">): boolean {
  return event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    && !event.repeat && !event.defaultPrevented && !event.isComposing;
}

export interface CommandPaletteProps {
  commands: readonly CommandPaletteCommand[];
  open: boolean;
  onClose: () => void;
  profiles?: readonly CommandPaletteProfile[];
  favoriteIds?: ReadonlySet<string>;
  /** Called after the palette closes; locate in the roster without opening a browser. */
  onLocateProfile?: (id: string) => void;
  savedViews?: readonly CommandPaletteSavedView[];
  savedViewsState?: "loading" | "unavailable" | "ready";
  savedViewsLocked?: boolean;
  onApplySavedView?: (id: string) => void;
}

export type CommandPaletteSavedView = Pick<SavedProfileView, "id" | "name"> & Pick<ProfileViewFilters, "group" | "scope" | "status">;

const PALETTE_MODES = {
  commands: { tab: "Commands", title: "Quick commands", count: "{count} commands", search: "Search commands", placeholder: "Search actions, pages and tools…", clear: "Clear command search", list: "Available commands", choose: "Choose a command", action: "Run command", help: "Search commands. Use the arrow keys to choose, Enter to run and Escape to close." },
  profiles: { tab: "Environments", title: "Find an environment", count: "{count} environments", search: "Search environments", placeholder: "Search a name, ID, group or tag…", clear: "Clear environment search", list: "Matching environments", choose: "Choose an environment", action: "Locate in list", help: "Search environments by name, ID, group or tag. Use arrows to choose, Enter to locate in the list and Escape to close." },
  views: { tab: "Saved views", title: "Saved views", count: "{count} saved views", search: "Search saved views", placeholder: "Search a view name or group…", clear: "Clear saved view search", list: "Matching saved views", choose: "Choose a saved view", action: "Apply view", help: "Search saved views by name or group. Use the arrow keys to choose, Enter to apply and Escape to close." },
} as const;
type PaletteMode = keyof typeof PALETTE_MODES;
const SAVED_VIEW_SCOPES: Record<CommandPaletteSavedView["scope"], string> = { all: "All environments", favorites: "Favorites", recent: "Launched in the last 7 days", attention: "Needs attention" };

export function CommandPalette({ commands, open, onClose, profiles, favoriteIds, onLocateProfile, savedViews, savedViewsState = "ready", savedViewsLocked = false, onApplySavedView }: CommandPaletteProps) {
  const { t } = useTranslation();
  const id = useId();
  const listId = `${id}-commands`, titleId = `${id}-title`, descriptionId = `${id}-description`;
  const panelId = `${id}-panel`;
  const tabId = (mode: PaletteMode) => `${id}-${mode}-tab`;
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose); closing.current = onClose;
  const composing = useRef(false);
  const executing = useRef(false);
  const mountedPortal = useRef(open);
  if (open) mountedPortal.current = true;
  const [query, setQuery] = useState(""), [activeId, setActiveId] = useState<string | null>(null), [error, setError] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("commands");
  const availableModes: PaletteMode[] = ["commands"];
  if (profiles !== undefined && onLocateProfile) availableModes.push("profiles");
  if (savedViews !== undefined && onApplySavedView) availableModes.push("views");
  const currentMode = availableModes.includes(mode) ? mode : "commands";
  const hasTabs = availableModes.length > 1, labels = PALETTE_MODES[currentMode];
  const filtered = useMemo(() => currentMode === "commands" ? filterCommands(commands, query, t) : [], [commands, currentMode, query, t]);
  const profileIndex = useMemo(() => open && currentMode === "profiles" ? createProfileSearchIndex(profiles ?? []) : [], [profiles, open, currentMode]);
  const profileMatches = useMemo(() => currentMode === "profiles" ? searchProfileIndex(profileIndex, query, { favoriteIds }) : { items: [], total: 0, limited: false }, [profileIndex, query, favoriteIds, currentMode]);
  const viewMatches = useMemo(() => {
    if (currentMode !== "views" || savedViewsState !== "ready") return [];
    return filterCommands((savedViews ?? []).map(view => ({ id: view.id, label: view.name, disabled: savedViewsLocked,
      description: [view.group === "all" ? t("All groups") : view.group || t("Ungrouped"), t(SAVED_VIEW_SCOPES[view.scope]), view.status === "all" ? "" : t(view.status === "running" ? "Running" : "Stopped")].filter(Boolean).join(" · "),
    })), query);
  }, [currentMode, savedViews, savedViewsState, savedViewsLocked, query, t]);
  const actionOptions = currentMode === "views" ? viewMatches : filtered;
  const navigation = currentMode === "profiles" ? profileMatches.items.map(profile => ({ id: profile.id, disabled: false })) : actionOptions;
  const resultCount = currentMode === "profiles" ? profileMatches.total : actionOptions.length;
  const empty = currentMode === "profiles"
    ? { title: profiles?.length ? "No matching environments" : "No environments available", help: "Try a name, ID, group or tag, or switch to Commands." }
    : currentMode === "views"
      ? savedViewsState === "loading" ? { title: "Loading this workspace's views…" }
        : savedViewsState === "unavailable" ? { title: "Saved views are unavailable", help: "Reload views from the environment list." }
        : savedViews?.length ? { title: "No matching saved views", help: "Try another view name or group." }
        : { title: "No saved views in this workspace", help: "Save a view from the environment list to find it here." }
      : { title: "No matching commands", help: "Try another search or clear the text." };
  let activeIndex = navigation.findIndex(item => item.id === activeId && !item.disabled);
  if (activeIndex < 0) activeIndex = nextCommandIndex(navigation, -1, "ArrowDown");
  const active = navigation[activeIndex];
  const activeOptionId = active ? `${listId}-${currentMode}-${activeIndex}` : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    setMode("commands"); setQuery(""); setActiveId(null); setError(false); composing.current = false; executing.current = false;
    const container = dialog.current;
    if (!container) return;
    const document = container.ownerDocument;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus({ preventScroll: true });
    const focusInside = (event: FocusEvent) => {
      if (!executing.current && !container.contains(event.target as Node)) input.current?.focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composing.current) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closing.current(); return; }
      if (event.key !== "Tab") return;
      const targets = Array.from(container.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')).filter(element => element.tabIndex >= 0 && rendered(element));
      const first = targets[0], last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); container.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusInside);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusInside);
      const focused = document.activeElement;
      const otherModal = hasActiveWorkbenchModal(document, container);
      // A command may have opened a new dialog or moved focus deliberately.
      if (!otherModal && previous?.isConnected && !previous.closest('[inert], [aria-hidden="true"], [hidden]') && (focused === document.body || container.contains(focused))) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open && activeOptionId) dialog.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeOptionId, active?.id, query, currentMode]);

  function execute(command: CommandPaletteCommand | undefined) {
    if (!open || executing.current || !command || command.disabled) return;
    executing.current = true;
    try { command.run(); closing.current(); } catch { executing.current = false; setError(true); input.current?.focus(); }
  }
  function locate(profile: CommandPaletteProfile | undefined) {
    if (!open || executing.current || !profile || !onLocateProfile) return;
    executing.current = true;
    flushSync(() => closing.current());
    onLocateProfile(profile.id);
  }
  function applyView(view: typeof viewMatches[number] | undefined) {
    if (!open || executing.current || !view || view.disabled || savedViewsLocked || savedViewsState !== "ready" || !onApplySavedView) return;
    executing.current = true;
    flushSync(() => closing.current());
    onApplySavedView(view.id);
  }
  function chooseMode(next: PaletteMode, focusSearch = true) {
    if (composing.current) return;
    setMode(next); setActiveId(null); setError(false);
    if (focusSearch) input.current?.focus({ preventScroll: true });
  }

  const content = () => <div className="command-palette-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) closing.current(); }}>
    <div className="command-palette" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} data-command-palette="true">
      <div className="command-palette-top"><h2 id={titleId}>{t(labels.title)}</h2>{(currentMode !== "views" || savedViewsState === "ready") && <span>{t(labels.count, { count: resultCount })}</span>}</div>
      {hasTabs && <div className="command-palette-tabs" role="tablist" aria-label={t("Quick access mode")} onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = availableModes.indexOf(currentMode), count = availableModes.length;
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
        const next = availableModes[nextIndex]!;
        chooseMode(next, false); dialog.current?.ownerDocument.getElementById(tabId(next))?.focus();
      }}>{availableModes.map(tab => <button key={tab} id={tabId(tab)} type="button" role="tab" aria-selected={currentMode === tab} aria-controls={panelId} tabIndex={currentMode === tab ? 0 : -1} onClick={() => chooseMode(tab)}>{t(PALETTE_MODES[tab].tab)}</button>)}</div>}
      <p id={descriptionId} className="command-palette-sr-only">{t(labels.help)}</p>
      <div className="command-palette-panel" id={hasTabs ? panelId : undefined} role={hasTabs ? "tabpanel" : undefined} aria-labelledby={hasTabs ? tabId(currentMode) : undefined}>
      <div className="command-palette-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" strokeLinecap="round" /></svg><input
        ref={input} type="search" role="combobox" aria-label={t(labels.search)} aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeOptionId}
        autoComplete="off" spellCheck={false} maxLength={500} placeholder={t(labels.placeholder)} value={query}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => { setQuery(event.target.value); setActiveId(null); setError(false); }}
        onKeyDown={event => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (event.key === "Enter") { if (event.repeat) return; event.preventDefault(); if (currentMode === "profiles") locate(profileMatches.items[activeIndex]); else if (currentMode === "views") applyView(viewMatches[activeIndex]); else execute(filtered[activeIndex]); return; }
          // Home/End remain text-editing keys while the search contains text.
          if ((event.key === "Home" || event.key === "End") && query) return;
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = nextCommandIndex(navigation, activeIndex, event.key as CommandNavigationKey);
          setActiveId(navigation[next]?.id ?? null);
        }}
      />{query && <button className="command-palette-clear" type="button" aria-label={t(labels.clear)} onClick={() => { setQuery(""); setActiveId(null); input.current?.focus(); }}>×</button>}<button className="command-palette-close" type="button" aria-label={t("Close command palette")} onClick={onClose}><kbd>Esc</kbd></button></div>
      {error && <p className="command-palette-error" role="alert">{t("Command could not be completed. Please try again.")}</p>}
      {currentMode === "profiles" && <p className="command-palette-profile-note">{t(query.trim() ? "Enter takes you to the selected environment in your list." : "Favorites first, then most recently launched. Enter locates an environment in your list.")}</p>}
      <div className="command-palette-list" id={listId} role="listbox" aria-label={t(labels.list)}>
        {currentMode === "commands" ? filtered.map((command, index) => <div key={command.id} id={`${listId}-commands-${index}`} role="option" aria-selected={index === activeIndex} aria-disabled={command.disabled || undefined}
          className={`command-palette-option${index === activeIndex ? " selected" : ""}${command.disabled ? " disabled" : ""}`}
          onPointerMove={() => { if (!command.disabled) setActiveId(command.id); }} onPointerDown={event => event.preventDefault()} onClick={() => execute(command)}>
          <span className="command-palette-option-icon" aria-hidden="true">›</span><span className="command-palette-option-copy"><strong>{t(command.label)}</strong>{command.description && <span>{t(command.description)}</span>}</span>
          {command.disabled ? <span className="command-palette-unavailable">{t("Unavailable")}</span> : command.shortcut && <kbd>{command.shortcut}</kbd>}
        </div>) : currentMode === "views" ? viewMatches.map((view, index) => <div key={view.id} id={`${listId}-views-${index}`} role="option" aria-selected={index === activeIndex} aria-disabled={view.disabled || undefined} data-saved-view-id={view.id}
          className={`command-palette-option${index === activeIndex ? " selected" : ""}${view.disabled ? " disabled" : ""}`}
          onPointerMove={() => { if (!view.disabled) setActiveId(view.id); }} onPointerDown={event => event.preventDefault()} onClick={() => applyView(view)}>
          <span className="command-palette-option-icon" aria-hidden="true">›</span><span className="command-palette-option-copy"><strong>{view.label}</strong><span>{view.description}</span></span>
          {view.disabled && <span className="command-palette-unavailable">{t("Unavailable")}</span>}
        </div>) : profileMatches.items.map((profile, index) => <div key={profile.id} id={`${listId}-profiles-${index}`} role="option" aria-selected={index === activeIndex} data-profile-id={profile.id}
          className={`command-palette-option command-palette-profile${index === activeIndex ? " selected" : ""}`} onPointerMove={() => setActiveId(profile.id)} onPointerDown={event => event.preventDefault()} onClick={() => locate(profile)}>
          <span className={`command-palette-profile-dot${profile.running ? " running" : ""}`} aria-hidden="true" />
          <span className="command-palette-option-copy"><strong>{profile.name || profile.id}{favoriteIds?.has(profile.id) && <span className="command-palette-profile-favorite" role="img" aria-label={t("Favorite")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></svg></span>}</strong><span className="command-palette-profile-meta"><span title={profile.group}>{profile.group || t("Ungrouped")}</span><code title={profile.id}>{profile.id}</code></span>{profile.tags.length > 0 && <span className="command-palette-profile-tags" title={profile.tags.join(" · ")}>{profile.tags.slice(0, 3).join(" · ")}{profile.tags.length > 3 ? ` +${profile.tags.length - 3}` : ""}</span>}</span>
          <span className="command-palette-profile-status">{t(profile.running ? "Running" : "Stopped")}</span>
        </div>)}
      </div>
      {currentMode === "profiles" && profileMatches.limited && <p className="command-palette-profile-limit" role="status">{t("Showing {shown} of {total} matches. Refine your search to locate a specific environment.", { shown: profileMatches.items.length, total: profileMatches.total })}</p>}
      {!navigation.length && <div className="command-palette-empty" role="status"><strong>{t(empty.title)}</strong>{empty.help && <p>{t(empty.help)}</p>}</div>}
      </div>
      <div className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd>{t(labels.choose)}</span><span><kbd>↵</kbd>{t(labels.action)}</span><span><kbd>Esc</kbd>{t("Close")}</span></div>
    </div>
  </div>;
  if (typeof document === "undefined") return open ? content() : null;
  return mountedPortal.current ? createPortal(<MotionPresence present={open}>{content}</MotionPresence>, document.body) : null;
}
