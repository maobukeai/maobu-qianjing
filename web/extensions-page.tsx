import * as React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import type { Extension, ExtensionGroupReview, GroupExtensionDefaults, UiProfile } from "./api.ts";
import type { ReviewedExtensionGroupSelection } from "../src/extension-group-revision.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./extensions-page.css";

export type ExtensionProfile = Pick<UiProfile, "id" | "name" | "group" | "running" | "engine"> & { extensions?: string[] };
export interface ExtensionGroupSelection { group: string; extensions: string[]; }
export type GroupDefaultsSnapshot = ReviewedExtensionGroupSelection;
export interface ExtensionsPageProps {
  extensions: Extension[];
  profiles: ExtensionProfile[];
  groupDefaults: GroupExtensionDefaults[];
  selectedGroup: string;
  selectedExtensionIds: string[];
  source: string;
  installing: boolean;
  uploading: boolean;
  applying: boolean;
  error: string | null;
  loading?: boolean;
  dataFresh?: boolean;
  selectedGroupAvailable?: boolean;
  retainedGroupDrafts?: readonly string[];
  draftDirty?: boolean;
  onDiscardGroupDraft?: () => void;
  onReload?: () => Promise<void>;
  onPreviewGroupDefaults?: (selection: ExtensionGroupSelection, signal?: AbortSignal) => Promise<ExtensionGroupReview>;
  onSourceChange: (source: string) => void;
  onSelectGroup: (group: string) => void;
  onToggleExtension: (id: string) => void;
  onInstall: () => Promise<boolean>;
  onUpload: (files: File[]) => Promise<boolean>;
  onApplyGroupDefaults: (selection: GroupDefaultsSnapshot) => Promise<boolean>;
  onRemove: (id: string, name: string) => Promise<boolean>;
  onOpenProfile?: (id: string) => void;
}
const unique = (ids: readonly string[]) => [...new Set(ids)].sort();
export function extensionGroupPreview(group: string, target: readonly string[], defaults: readonly GroupExtensionDefaults[], profiles: readonly ExtensionProfile[]) {
  const selected = unique(target), before = unique(defaults.find(item => item.name === group)?.extensions ?? []);
  const members = profiles.filter(profile => profile.group === group);
  const changes = members.flatMap(profile => {
    if (!profile.extensions) return [];
    const current = unique(profile.extensions), next = profile.engine === "firefox" ? [] : selected;
    const added = next.filter(id => !current.includes(id)), removed = current.filter(id => !next.includes(id));
    return added.length || removed.length ? [{ id: profile.id, name: profile.name || profile.id, added, removed, running: profile.running }] : [];
  });
  return {
    group, extensions: selected, count: members.length,
    defaultAdded: selected.filter(id => !before.includes(id)), defaultRemoved: before.filter(id => !selected.includes(id)), changes,
    unknown: members.filter(profile => !profile.extensions).length,
    signature: JSON.stringify({ group, before, members: members.map(profile => [profile.id, profile.engine, profile.running, profile.extensions ? unique(profile.extensions) : null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }),
  };
}
function removalPreview(id: string, groups: readonly GroupExtensionDefaults[], profiles: readonly ExtensionProfile[]) {
  const assigned = profiles.filter(profile => profile.extensions?.includes(id));
  const defaults = groups.filter(group => group.extensions.includes(id));
  const unknown = profiles.filter(profile => !profile.extensions).map(profile => profile.id).sort();
  return { count: assigned.length, groups: defaults.length, unknown: unknown.length,
    signature: JSON.stringify({ profiles: assigned.map(profile => profile.id).sort(), groups: defaults.map(group => group.name).sort(), unknown }) };
}
type Confirmation = { kind: "group"; preview: ExtensionGroupReview; clientSignature: string; needsReview: boolean; reviewInstanceId: number } | ({ kind: "remove"; extension: Extension } & ReturnType<typeof removalPreview>);

function Glyph({ name }: { name: "puzzle" | "plus" | "search" | "close" | "folder" | "arrow" }) {
  const paths = {
    puzzle: <path d="M8 3h3a3 3 0 1 0 6 0h4v7a3 3 0 1 0 0 6v5h-7a3 3 0 1 0-6 0H3v-7a3 3 0 1 0 0-6V3h5Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9H3Z" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  };
  return <svg className="extensions-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const ASSIGNMENT_PAGE_SIZE = 20;

function ExtensionAssignments({ profiles, groups, unknown, locked, onOpenProfile }: {
  profiles: readonly ExtensionProfile[];
  groups: readonly GroupExtensionDefaults[];
  unknown: boolean;
  locked: boolean;
  onOpenProfile?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(ASSIGNMENT_PAGE_SIZE);
  const list = useRef<HTMLUListElement>(null);
  const firstNewRow = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (firstNewRow.current === null) return;
    const row = list.current?.children.item(firstNewRow.current) as HTMLElement | null | undefined;
    firstNewRow.current = null;
    (row?.querySelector("button") ?? row)?.focus();
  }, [visible]);

  if (!profiles.length && !groups.length) return <span className="extensions-assignment-state">
    {t(unknown ? "No known environment assignments." : "Unassigned")}
  </span>;

  const more = profiles.length - visible;
  return <details className="extensions-assignment-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <AppIcon name="chevronRight" className="sm" />
      <span className="extensions-assignment-counts">
        {profiles.length > 0 && <span>{t("Assigned to {count} environments", { count: profiles.length })}</span>}
        {groups.length > 0 && <span>{t("Default in {count} groups", { count: groups.length })}</span>}
      </span>
    </summary>
    {open && <div className="extensions-assignment-body">
      {groups.length > 0 && <p><strong>{t("Group defaults")}</strong><span>{groups.map(group => group.name).join(" · ")}</span></p>}
      {profiles.length > 0 && <ul ref={list}>{profiles.slice(0, visible).map(profile => <li key={profile.id} tabIndex={onOpenProfile ? undefined : -1}>
        {onOpenProfile ? <button className="extensions-profile-link" type="button" disabled={locked} onClick={() => onOpenProfile(profile.id)}>
          {profile.name || profile.id}<Glyph name="arrow" />
        </button> : <span>{profile.name || profile.id}</span>}
        <small>{profile.group || t("Ungrouped")}</small>
      </li>)}</ul>}
      {more > 0 && <button type="button" className="btn xs ghost extensions-assignments-more" disabled={locked} onClick={() => {
        firstNewRow.current = visible;
        setVisible(visible + ASSIGNMENT_PAGE_SIZE);
      }}>{t("Show {count} more assignments", { count: Math.min(more, ASSIGNMENT_PAGE_SIZE) })}</button>}
    </div>}
  </details>;
}

type GroupDefaultChoice = { id: string; name: string; missing: boolean };

function GroupDefaultChoices({ choices, selectedIds, locked, unavailable, loading, dataUnavailable, onToggle }: {
  choices: readonly GroupDefaultChoice[];
  selectedIds: readonly string[];
  locked: boolean;
  unavailable: boolean;
  loading?: boolean;
  dataUnavailable: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const filtered = query ? choices.filter(choice => `${choice.name} ${choice.id}`.toLocaleLowerCase().includes(query)) : choices;
  const selected = new Set(selectedIds);
  const hiddenSelected = query ? selected.size - filtered.filter(choice => selected.has(choice.id)).length : 0;
  const hasSearch = choices.length > 8 || !!query;

  return <>
    {hasSearch && <div className="extensions-default-search-tools">
      <label className="extensions-search">
        <Glyph name="search" /><span className="sr-only">{t("Search group extensions")}</span>
        <input className="input" type="search" value={search} disabled={locked} placeholder={t("Search name or extension ID")} onChange={event => {
          setSearch(event.target.value);
          if (list.current) list.current.scrollTop = 0;
        }} />
      </label>
      <p className="extensions-default-selection-count" role="status">
        <span>{t("{count} selected", { count: selected.size })}</span>
        {hiddenSelected > 0 && <span>{t("{count} hidden by search", { count: hiddenSelected })}</span>}
      </p>
    </div>}
    <div className="extensions-default-choices" ref={list}>
      {filtered.length ? filtered.map(extension => <label className={`extensions-default-choice${selected.has(extension.id) ? " is-checked" : ""}`} key={extension.id}>
        <input type="checkbox" checked={selected.has(extension.id)} disabled={locked || unavailable} onChange={() => onToggle(extension.id)} />
        <span>{extension.name}{extension.missing && !dataUnavailable && <small>{t("Not installed on this device")}</small>}</span>
      </label>) : (loading || choices.length > 0 || !dataUnavailable) && <p className="extensions-note" role={loading || !!query ? "status" : undefined}>
        {t(loading ? "Loading extensions…" : query && choices.length ? "No group extensions match your search." : "No extensions are installed. Apply an empty selection to clear this default.")}
      </p>}
    </div>
  </>;
}

const REVIEW_PAGE_SIZE = 12;

function GroupReviewChanges({ changes, locked, changeList }: {
  changes: Readonly<ExtensionGroupReview["changes"]>;
  locked: boolean;
  changeList: (ids: readonly string[]) => string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const large = changes.length > REVIEW_PAGE_SIZE;
  const query = large ? search.trim().toLocaleLowerCase() : "";
  const matches = useMemo(() => query ? changes.filter(profile => `${profile.name} ${profile.id}`.toLocaleLowerCase().includes(query)) : changes, [changes, query]);
  const pages = Math.ceil(matches.length / REVIEW_PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pages - 1));
  const start = currentPage * REVIEW_PAGE_SIZE;
  const rows = matches.slice(start, start + REVIEW_PAGE_SIZE);
  const atFirstPage = currentPage === 0;
  const atLastPage = currentPage + 1 >= pages;

  return <details className="extensions-change-details" open>
    <summary>{t("{count} environments will change", { count: changes.length })}</summary>
    {large && <div className="extensions-review-tools">
      <label className="extensions-search">
        <Glyph name="search" /><span className="sr-only">{t("Search affected environments")}</span>
        <input className="input" type="search" value={search} disabled={locked} placeholder={t("Search environment name or ID")} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      </label>
      <div className="extensions-review-navigation">
        <p role="status">{rows.length ? t("Showing {first}–{last} of {count} environments", { first: start + 1, last: start + rows.length, count: matches.length }) : t("No affected environments match your search.")}</p>
        {pages > 1 && <div className="extensions-review-pages" role="group" aria-label={t("Affected environment pages")}>
          <button className="btn xs ghost" type="button" disabled={locked} aria-disabled={atFirstPage || undefined} onClick={() => { if (!atFirstPage) setPage(currentPage - 1); }}>{t("Previous page")}</button>
          <button className="btn xs ghost" type="button" disabled={locked} aria-disabled={atLastPage || undefined} onClick={() => { if (!atLastPage) setPage(currentPage + 1); }}>{t("Next page")}</button>
        </div>}
      </div>
    </div>}
    {rows.length > 0 && <ul>{rows.map(profile => <li key={profile.id}>
      <strong>{profile.name}</strong>{profile.running && <small>{t("Running · reopen to apply")}</small>}
      {profile.added.length > 0 && <p><span>{t("Add")}</span> {changeList(profile.added)}</p>}
      {profile.removed.length > 0 && <p><span>{t("Remove")}</span> {changeList(profile.removed)}</p>}
    </li>)}</ul>}
  </details>;
}

export function ExtensionsPage(props: ExtensionsPageProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("all");
  const [installOpen, setInstallOpen] = useState(false), [installSource, setInstallSource] = useState<"store" | "file">("store");
  const [failedInstallSource, setFailedInstallSource] = useState<typeof installSource | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [operation, setOperation] = useState(false), [operationError, setOperationError] = useState(""), [notice, setNotice] = useState("");
  const [reviewing, setReviewing] = useState(false), [reloading, setReloading] = useState(false);
  const file = useRef<HTMLInputElement>(null), dialog = useRef<HTMLElement>(null), installInput = useRef<HTMLInputElement>(null);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const installButton = useRef<HTMLButtonElement>(null), libraryHeading = useRef<HTMLHeadingElement>(null), wasInstallerOpen = useRef(false);
  const installerRecovery = useRef(false);
  const removeImpact = useRef<HTMLParagraphElement>(null), reviewRemovalFocusPending = useRef(false);
  const inlineRetry = useRef<HTMLButtonElement>(null), returnToLibraryAfterRetry = useRef(false);
  const mounted = useRef(true), operating = useRef(false), busyRef = useRef(false), closeRef = useRef<() => void>(() => {});
  const reviewRequest = useRef<AbortController | null>(null), reviewInstanceId = useRef(0), reloadInFlight = useRef(false), latest = useRef(props);
  const reviewReturnFocus = useRef<HTMLElement | null>(null), reviewCancel = useRef<HTMLButtonElement>(null);
  const reviewFocusPending = useRef(false);
  latest.current = props;
  const titleId = useId(), descriptionId = useId(), installId = useId(), libraryId = useId(), defaultsId = useId();
  const installFeedbackId = useId();
  const writeLocked = operation || props.installing || props.uploading || props.applying;
  const locked = writeLocked || reviewing || reloading;
  const reading = !!props.loading || reloading;
  const dataUnavailable = props.dataFresh === false;
  const controlsLocked = locked || !!confirmation || !!props.loading || dataUnavailable;
  const draftControlsLocked = locked || !!confirmation || !!props.loading;
  const pageError = props.error || (operationError && t(operationError)) || (dataUnavailable && (!props.loading || reloading) ? t("Extension data is out of date. Reload it before making another change. Your draft is kept.") : "");
  const errorInInstaller = installOpen && failedInstallSource === installSource;
  busyRef.current = writeLocked;
  function cancelReview(restoreFocus = false) {
    reviewRequest.current?.abort(); reviewRequest.current = null; setReviewing(false);
    // The trigger is still disabled in the current DOM. Restore only after the
    // cancellation commit enables it, otherwise browsers ignore focus().
    reviewFocusPending.current = restoreFocus;
    if (!restoreFocus) reviewReturnFocus.current = null;
  }
  closeRef.current = () => { if (!busyRef.current) { cancelReview(); setConfirmation(null); setOperationError(""); } };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reviewRequest.current?.abort(); reviewRequest.current = null; }; }, []);
  useLayoutEffect(() => {
    if (!confirmation || !dialog.current) return;
    const node = dialog.current, previous = reviewReturnFocus.current?.isConnected ? reviewReturnFocus.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reviewReturnFocus.current = null;
    const controls = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]')]
      .filter(control => {
        if (control.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        const closed = control.closest("details:not([open])");
        return !closed || closed.querySelector("summary") === control;
      });
    (controls()[0] ?? node).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const list = controls(), first = list[0], last = list[list.length - 1];
      if (!first || !last) { event.preventDefault(); node.focus(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node || !node.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !node.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (document.activeElement === document.body || node.contains(document.activeElement)) {
        (previous?.isConnected ? previous : libraryHeading.current)?.focus({ preventScroll: true });
      }
    };
  }, [!!confirmation]);
  useLayoutEffect(() => {
    if (!reviewing && !confirmation && reviewFocusPending.current) {
      reviewFocusPending.current = false;
      reviewReturnFocus.current?.isConnected && reviewReturnFocus.current.focus({ preventScroll: true });
      reviewReturnFocus.current = null;
    }
    if (reviewing && !confirmation) reviewCancel.current?.focus({ preventScroll: true });
    if (reviewRemovalFocusPending.current) {
      reviewRemovalFocusPending.current = false;
      removeImpact.current?.focus();
    }
    if (confirmation && dialog.current && (document.activeElement === document.body || !dialog.current.contains(document.activeElement))) {
      (dialog.current.querySelector<HTMLElement>('button:not(:disabled)') ?? dialog.current).focus({ preventScroll: true });
    }
  }, [confirmation, reviewing, reloading]);
  useLayoutEffect(() => {
    if (reading || !returnToLibraryAfterRetry.current) return;
    returnToLibraryAfterRetry.current = false;
    if (document.activeElement !== document.body) return;
    (inlineRetry.current ?? libraryHeading.current)?.focus({ preventScroll: true });
  }, [reading]);
  useEffect(() => {
    if (installOpen === wasInstallerOpen.current) return;
    if (installOpen) (installSource === "store" ? installInput.current : archiveButton.current)?.focus();
    else installButton.current?.focus({ preventScroll: true });
    wasInstallerOpen.current = installOpen;
  }, [installOpen, installSource]);
  useLayoutEffect(() => {
    if (!installerRecovery.current || controlsLocked) return;
    installerRecovery.current = false;
    if (!errorInInstaller || document.activeElement !== document.body) return;
    const target = installSource === "store" ? installInput.current : archiveButton.current;
    if (target && !target.closest("[hidden], [inert]")) target.focus();
  }, [controlsLocked, errorInInstaller, installSource]);

  const names = useMemo(() => new Map(props.extensions.map(item => [item.id, item.name])), [props.extensions]);
  const name = (id: string) => names.get(id) || id;
  const unknownAssignments = useMemo(() => props.profiles.some(profile => !profile.extensions), [props.profiles]);
  const assignedProfilesByExtension = useMemo(() => {
    const map = new Map<string, ExtensionProfile[]>();
    for (const profile of props.profiles) {
      if (!profile.extensions) continue;
      for (const extensionId of profile.extensions) {
        const list = map.get(extensionId);
        if (list) list.push(profile);
        else map.set(extensionId, [profile]);
      }
    }
    return map;
  }, [props.profiles]);
  const defaultGroupsByExtension = useMemo(() => {
    const map = new Map<string, GroupExtensionDefaults[]>();
    for (const group of props.groupDefaults) {
      for (const extensionId of group.extensions) {
        const list = map.get(extensionId);
        if (list) list.push(group);
        else map.set(extensionId, [group]);
      }
    }
    return map;
  }, [props.groupDefaults]);
  const assignedCount = (id: string) => assignedProfilesByExtension.get(id)?.length ?? 0;
  const query = search.trim().toLocaleLowerCase();
  const filtered = props.extensions.filter(item => (!query || `${item.name} ${item.id}`.toLocaleLowerCase().includes(query)) && (filter === "all" || (filter === "assigned" ? assignedCount(item.id) > 0 : !unknownAssignments && assignedCount(item.id) === 0)));
  const selectedDefault = props.groupDefaults.find(group => group.name === props.selectedGroup)?.extensions ?? [];
  const unavailableGroups = unique([...(props.retainedGroupDrafts ?? []), ...(props.selectedGroupAvailable === false ? [props.selectedGroup] : [])]).filter(group => group && !props.groupDefaults.some(item => item.name === group));
  const choices = [...props.extensions.map(item => ({ ...item, missing: false })), ...unique([...selectedDefault, ...props.selectedExtensionIds]).filter(id => !names.has(id)).map(id => ({ id, name: id, missing: true }))];
  const currentPreview = extensionGroupPreview(props.selectedGroup, props.selectedExtensionIds, props.groupDefaults, props.profiles);
  const assignedExtensionCount = useMemo(
    () => props.extensions.filter(item => (assignedProfilesByExtension.get(item.id)?.length ?? 0) > 0).length,
    [props.extensions, assignedProfilesByExtension],
  );
  const unassignedExtensionCount = unknownAssignments ? 0 : Math.max(0, props.extensions.length - assignedExtensionCount);
  const configuredGroupCount = useMemo(
    () => props.groupDefaults.filter(group => group.extensions.length > 0).length,
    [props.groupDefaults],
  );
  const chromiumProfileCount = useMemo(
    () => props.profiles.filter(profile => profile.engine !== "firefox").length,
    [props.profiles],
  );
  const kpiReady = !reading || props.extensions.length > 0 || props.groupDefaults.length > 0 || props.profiles.length > 0;
  const extensionToRemove = confirmation?.kind === "remove" ? props.extensions.find(item => item.id === confirmation.extension.id) : undefined;
  const stale = confirmation?.kind === "group"
    ? confirmation.needsReview || extensionGroupPreview(confirmation.preview.group, confirmation.preview.extensions, props.groupDefaults, props.profiles).signature !== confirmation.clientSignature
    : confirmation?.kind === "remove" && (removalPreview(confirmation.extension.id, props.groupDefaults, props.profiles).signature !== confirmation.signature || !extensionToRemove);
  const canReviewRemoval = !!(stale && extensionToRemove);
  const unchanged = !currentPreview.defaultAdded.length && !currentPreview.defaultRemoved.length && !currentPreview.changes.length && !currentPreview.unknown;

  async function perform(task: () => Promise<boolean>, success: () => void, failed?: () => void) {
    if (operating.current || reviewRequest.current || reloadInFlight.current || locked || props.loading || latest.current.dataFresh === false) return;
    operating.current = true; setOperation(true); setOperationError(""); setNotice(""); setFailedInstallSource(null);
    try {
      const succeeded = await task();
      if (!mounted.current) return;
      if (succeeded) success();
      else { setOperationError("The change could not be completed. Your selection is kept; try again."); failed?.(); }
    } catch (error) { if (mounted.current) { setOperationError(error instanceof Error ? error.message : String(error)); failed?.(); } }
    finally { operating.current = false; if (mounted.current) setOperation(false); }
  }
  function recoverInstaller(source: typeof installSource) {
    installerRecovery.current = true;
    setFailedInstallSource(source);
  }
  async function reload() {
    if (!props.onReload || reloadInFlight.current || operating.current || reviewRequest.current || writeLocked || props.loading) return;
    returnToLibraryAfterRetry.current = document.activeElement === inlineRetry.current;
    reloadInFlight.current = true; setReloading(true); setOperationError(""); setFailedInstallSource(null);
    try { await props.onReload(); }
    catch { if (mounted.current) setOperationError("Extension data could not be reloaded. Your selection is kept. Try again."); }
    finally { reloadInFlight.current = false; if (mounted.current) setReloading(false); }
  }
  async function review(selection: ExtensionGroupSelection) {
    if (operating.current || reviewRequest.current || reloadInFlight.current || locked || props.loading || latest.current.dataFresh === false || latest.current.selectedGroupAvailable === false) return;
    setFailedInstallSource(null);
    if (!props.onPreviewGroupDefaults) { setOperationError("The extension preview could not be loaded. Your selection is kept. Try reviewing again."); return; }
    const frozen = { group: selection.group, extensions: unique(selection.extensions) };
    const signature = extensionGroupPreview(frozen.group, frozen.extensions, props.groupDefaults, props.profiles).signature;
    const controller = new AbortController(); reviewRequest.current = controller;
    if (!confirmation) reviewReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let opened = false;
    setReviewing(true); setOperationError(""); setNotice("");
    try {
      const preview = await props.onPreviewGroupDefaults({ group: frozen.group, extensions: [...frozen.extensions] }, controller.signal);
      if (!mounted.current || reviewRequest.current !== controller || controller.signal.aborted) return;
      const current = latest.current;
      if (current.loading || current.dataFresh === false || current.selectedGroupAvailable === false || current.selectedGroup !== frozen.group || JSON.stringify(unique(current.selectedExtensionIds)) !== JSON.stringify(frozen.extensions)) throw new Error("The group selection changed. Review it again before applying.");
      if (!preview || preview.version !== 1 || preview.group !== frozen.group || JSON.stringify(unique(preview.extensions)) !== JSON.stringify(frozen.extensions) || !/^[a-f0-9]{64}$/.test(preview.expectedFingerprint)) throw new Error("The extension preview was incomplete. Review the group again before applying.");
      setConfirmation({ kind: "group", preview, clientSignature: signature, needsReview: false, reviewInstanceId: ++reviewInstanceId.current }); opened = true;
    } catch (error) {
      if (mounted.current && reviewRequest.current === controller && !controller.signal.aborted) setOperationError(error instanceof Error ? error.message : "The extension preview could not be loaded. Your selection is kept. Try reviewing again.");
    } finally {
      if (mounted.current && reviewRequest.current === controller) {
        reviewRequest.current = null; setReviewing(false);
        if (!opened && !confirmation) reviewFocusPending.current = true;
      }
    }
  }
  function reviewRemoval() {
    if (!extensionToRemove || locked || reading || dataUnavailable) return;
    reviewRemovalFocusPending.current = true;
    setOperationError("");
    setConfirmation({ kind: "remove", extension: { ...extensionToRemove }, ...removalPreview(extensionToRemove.id, props.groupDefaults, props.profiles) });
  }
  function confirm() {
    if (!confirmation || stale || props.loading || props.dataFresh === false || reviewRequest.current || reloadInFlight.current) return;
    if (confirmation.kind === "group" && props.selectedGroupAvailable === false) return;
    const request = confirmation;
    void perform(() => request.kind === "group" ? props.onApplyGroupDefaults({ group: request.preview.group, extensions: [...request.preview.extensions], expectedFingerprint: request.preview.expectedFingerprint }) : props.onRemove(request.extension.id, request.extension.name), () => {
      setConfirmation(null);
      setNotice(request.kind === "group" ? "Group defaults applied. Reopen affected browsers to load the new selection." : "Extension removed and unassigned.");
    }, () => { if (request.kind === "group") setConfirmation(current => current === request ? { ...request, needsReview: true } : current); });
  }
  function changeList(ids: readonly string[]) { return ids.length ? ids.map(name).join(" · ") : t("None"); }

  const errorFeedback = pageError && !confirmation && <div className="extensions-feedback is-error extensions-page-error">
    <p id={installFeedbackId} role={reading ? undefined : "alert"}>{pageError}</p>
    {dataUnavailable && props.onReload && <button ref={inlineRetry} className="btn xs" type="button" disabled={locked || reading} onClick={() => void reload()}>{t(reading ? "Loading…" : "Retry")}</button>}
  </div>;

  return <div className="workspace extensions-workspace" aria-busy={!!props.loading || locked}>
    <div className="extensions-heading page-heading">
      <div className="extensions-heading-title">
        <h1>{t("Extensions")}</h1>
        {props.extensions.length > 0 && <span className="extensions-heading-pill">{t("{count} installed", { count: props.extensions.length })}</span>}
      </div>
      <div className="extensions-heading-actions">
        {props.onReload && <button className="btn extensions-refresh" type="button" aria-label={t("Reload extension data")} title={t("Reload extension data")} disabled={locked || !!props.loading || !!confirmation} onClick={() => void reload()}><AppIcon name="refresh" className="sm" /><span>{t(reloading || props.loading ? "Loading…" : "Refresh")}</span></button>}
        <button className={`btn extensions-add-btn${installOpen ? " is-open" : " primary"}`} ref={installButton} type="button" disabled={controlsLocked} aria-expanded={installOpen} aria-controls={installId} onClick={() => setInstallOpen(value => !value)}><Glyph name={installOpen ? "close" : "plus"} />{t(installOpen ? "Close installer" : "Add extension")}</button>
      </div>
    </div>
    <div className="extensions-page-body">
      <div className="extensions-page-inner">
        {(!installOpen || !failedInstallSource) && errorFeedback}
        {reviewing && !confirmation && <div className="extensions-review-progress" role="status" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelReview(true); } }}><span>{t("Reviewing extension changes…")}</span><button ref={reviewCancel} className="btn xs" type="button" onClick={() => cancelReview(true)}>{t("Cancel review")}</button></div>}
        {notice && <p className="extensions-feedback" role="status">{t(notice)}</p>}
        <section className="extensions-installer" id={installId} hidden={!installOpen} aria-label={t("Add extension")}
          onKeyDown={event => {
            if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !writeLocked) {
              event.preventDefault();
              setInstallOpen(false);
            }
          }}>
          <div className="extensions-installer-top">
            <div className="segmented extensions-source" role="group" aria-label={t("Installation source")} data-sliding-group data-sliding-axis="horizontal">
              <button type="button" className={installSource === "store" ? "active" : ""} aria-pressed={installSource === "store"} disabled={controlsLocked}
                onClick={() => setInstallSource("store")}><AppIcon name="puzzle" className="sm" />{t("Chrome Web Store")}</button>
              <button type="button" className={installSource === "file" ? "active" : ""} aria-pressed={installSource === "file"} disabled={controlsLocked}
                onClick={() => setInstallSource("file")}><AppIcon name="fileImport" className="sm" />{t("ZIP/CRX archive")}</button>
            </div>
            <span className="extensions-installer-badge">Chromium</span>
          </div>
          {errorInInstaller && errorFeedback}
          {installSource === "store" ? <form className="extensions-install-form" onSubmit={event => {
            event.preventDefault(); if (controlsLocked || !props.source.trim()) return;
            void perform(props.onInstall, () => { setInstallOpen(false); setNotice("Extension installation completed. Assign it to an environment or group."); }, () => recoverInstaller("store"));
          }}>
            <label className="fld">
              <span>{t("Chrome Web Store URL or extension ID")}</span>
              <input className="input" ref={installInput} aria-label={t("Chrome Web Store URL or extension ID")}
                aria-describedby={errorInInstaller && pageError ? installFeedbackId : undefined}
                value={props.source} disabled={controlsLocked} spellCheck={false} onChange={event => props.onSourceChange(event.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={controlsLocked || !props.source.trim()}>{t(props.installing ? "Installing…" : "Install")}</button>
          </form> : <button className="extensions-file-install" type="button" ref={archiveButton} disabled={controlsLocked}
            aria-describedby={errorInInstaller && pageError ? installFeedbackId : undefined} onClick={() => file.current?.click()}>
            <span className="extensions-file-icon"><AppIcon name="fileImport" /></span>
            <strong>{t(props.uploading ? "Uploading…" : "Choose ZIP/CRX files")}</strong>
          </button>}
          <p className="extensions-note">{t("New extensions stay unassigned until you choose an environment or group.")}</p>
        </section>
        <div className="extensions-kpi-ribbon">
          <div className="extensions-kpi-card">
            <div className="extensions-kpi-top">
              <span>{t("Installed extensions")}</span>
              <span className="extensions-kpi-pill is-accent">{t("Local")}</span>
            </div>
            <div className="extensions-kpi-val">
              <strong>{kpiReady ? props.extensions.length.toLocaleString() : "—"}</strong>
              <span>{kpiReady ? t("{count} installed", { count: props.extensions.length }) : ""}</span>
            </div>
          </div>
          <div className="extensions-kpi-card">
            <div className="extensions-kpi-top">
              <span>{t("Assigned")}</span>
              <span className={`extensions-kpi-pill${assignedExtensionCount > 0 ? " is-success" : ""}`}>{t("Ready")}</span>
            </div>
            <div className="extensions-kpi-val">
              <strong>{kpiReady ? assignedExtensionCount.toLocaleString() : "—"}</strong>
              <span>{kpiReady && !unknownAssignments ? `${t("Unassigned")} ${unassignedExtensionCount.toLocaleString()}` : ""}</span>
            </div>
          </div>
          <div className="extensions-kpi-card">
            <div className="extensions-kpi-top">
              <span>{t("Group defaults")}</span>
              <span className="extensions-kpi-pill">{`${props.groupDefaults.length.toLocaleString()} ${t("Groups")}`}</span>
            </div>
            <div className="extensions-kpi-val">
              <strong>{kpiReady ? configuredGroupCount.toLocaleString() : "—"}</strong>
              <span>{kpiReady ? t("Default in {count} groups", { count: configuredGroupCount }) : ""}</span>
            </div>
          </div>
          <div className="extensions-kpi-card">
            <div className="extensions-kpi-top">
              <span>{t("Environments")}</span>
              <span className="extensions-kpi-pill">Chromium</span>
            </div>
            <div className="extensions-kpi-val">
              <strong>{kpiReady ? chromiumProfileCount.toLocaleString() : "—"}</strong>
              <span>{kpiReady ? t("{count} environments", { count: props.profiles.length }) : ""}</span>
            </div>
          </div>
        </div>
        <div className="extensions-columns">
          <section className="extensions-library" aria-labelledby={libraryId}>
            <header className="extensions-section-heading">
              <h2 id={libraryId} ref={libraryHeading} tabIndex={-1}><Glyph name="puzzle" />{t("Installed extensions")}</h2>
              {props.extensions.length > 0 && <span className="extensions-library-count" title={t("{count} installed", { count: props.extensions.length })}>{props.extensions.length.toLocaleString()}</span>}
            </header>
            {props.extensions.length > 0 && <div className="extensions-library-tools"><label className="extensions-search"><Glyph name="search" /><span className="sr-only">{t("Search extensions")}</span><input className="input" type="search" value={search} placeholder={t("Search name or extension ID")} onChange={event => setSearch(event.target.value)} /></label><select className="select" aria-label={t("Filter extension assignments")} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t("All extensions")}</option><option value="assigned">{t("Assigned")}</option><option value="unassigned" disabled={unknownAssignments}>{t("Unassigned")}</option></select></div>}
            {unknownAssignments && props.extensions.length > 0 && <p className="extensions-note">{t("Some assignment details are unavailable. Counts show known assignments only.")}</p>}
            {!props.extensions.length ? (reading ? <p className="extensions-note" role="status">{t("Loading extensions…")}</p> : !dataUnavailable && <div className="extensions-empty"><span className="extensions-library-icon"><Glyph name="puzzle" /></span><h3>{t("No extensions yet")}</h3></div>) : !filtered.length ? <div className="extensions-empty"><h3>{t("No matching extensions")}</h3><button type="button" className="btn xs" onClick={() => { setSearch(""); setFilter("all"); }}>{t("Clear filters")}</button></div> : <div className="extensions-library-list">{filtered.map(extension => {
              const assigned = assignedProfilesByExtension.get(extension.id) ?? [];
              const defaults = defaultGroupsByExtension.get(extension.id) ?? [];
              return <article className="extensions-library-row" key={extension.id}>
                <span className="extensions-library-icon"><Glyph name="puzzle" /></span>
                <div className="extensions-library-copy">
                  <h3>{extension.name}</h3>
                  <code title={extension.id}>{extension.id}</code>
                  <ExtensionAssignments profiles={assigned} groups={defaults} unknown={unknownAssignments} locked={controlsLocked} onOpenProfile={props.onOpenProfile} />
                </div>
                <button className="btn xs ghost extensions-remove" type="button" disabled={controlsLocked} aria-label={t("Remove {extension}", { extension: extension.name })}
                  onClick={() => { setOperationError(""); setConfirmation({ kind: "remove", extension: { ...extension }, ...removalPreview(extension.id, props.groupDefaults, props.profiles) }); }}>{t("Remove")}</button>
              </article>;
            })}</div>}
            <details className="extensions-help">
              <summary><AppIcon name="help" className="sm" />{t("How extensions are applied")}</summary>
              <p>{t("Choose group defaults here, or edit a single environment's extensions.")} {t("Reopen the profile. The app loads the extension when the browser starts.")}</p>
              <p>{t("Chrome extensions apply only to compatible Chromium environments. Firefox does not use these assignments.")}</p>
            </details>
          </section>
          <aside className="extensions-defaults" aria-labelledby={defaultsId}>
            <header className="extensions-section-heading"><h2 id={defaultsId}><Glyph name="folder" />{t("Group defaults")}</h2></header>
            {!props.groupDefaults.length && !unavailableGroups.length ? (reading || !dataUnavailable) && <p className="extensions-note" role={reading ? "status" : undefined}>{t(reading ? "Loading group defaults…" : "Create an editable group before setting its extension defaults.")}</p> : <>
              <label className="fld"><span>{t("Group")}</span><select className="select" aria-label={t("Extension default group")} value={props.selectedGroup} disabled={draftControlsLocked} onChange={event => props.onSelectGroup(event.target.value)}>
                {unavailableGroups.map(group => <option key={group} value={group}>{t("Unavailable · {group}", { group })}</option>)}
                {props.groupDefaults.map(group => <option key={group.name} value={group.name}>{group.name}</option>)}
              </select></label>
              {props.selectedGroupAvailable === false && <div className="extensions-unavailable-group"><p className="extensions-note" role="status">{t("This group is unavailable. Your draft is kept; choose another group or discard this selection.")}</p></div>}
              <div className="extensions-default-count">{t("{count} environments in this group", { count: currentPreview.count })}</div>
              <GroupDefaultChoices choices={choices} selectedIds={props.selectedExtensionIds} locked={draftControlsLocked} unavailable={props.selectedGroupAvailable === false} loading={reading} dataUnavailable={dataUnavailable} onToggle={props.onToggleExtension} />
              {props.draftDirty && <div className="extensions-draft-state"><span role="status">{t("Unsaved group selection")}</span>{props.onDiscardGroupDraft && <button className="btn xs ghost" type="button" disabled={draftControlsLocked} onClick={props.onDiscardGroupDraft}>{t("Discard unsaved selection")}</button>}</div>}
              {!unchanged && <p className="extensions-note">{t("Applying replaces individual assignments in this group. New and moved environments inherit this selection.")}</p>}
              <button className={`btn${unchanged ? "" : " primary"}`} type="button" disabled={controlsLocked || !props.selectedGroup || props.selectedGroupAvailable === false || unchanged} onClick={() => void review({ group: props.selectedGroup, extensions: [...props.selectedExtensionIds] })}>{t(reviewing ? "Reviewing…" : props.applying ? "Applying…" : "Review and apply")}</button>
              {unchanged && !reading && !dataUnavailable && props.selectedGroupAvailable !== false && <p className="extensions-default-saved">{t("Current assignments match this selection.")}</p>}
            </>}
          </aside>
        </div>
        <input ref={file} type="file" hidden multiple accept=".zip,.crx,application/zip,application/x-chrome-extension" aria-label={t("Extension archive files")} onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = "";
          if (!files.length || controlsLocked) return;
          void perform(() => props.onUpload(files), () => { setInstallOpen(false); setNotice("Extension upload completed. Assign the tools to an environment or group."); }, () => recoverInstaller("file"));
        }} />
      </div>
    </div>
    {typeof document !== "undefined" && createPortal(<MotionPresence present={!!confirmation}>{() => confirmation && (<div className="extensions-confirm-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) closeRef.current(); }}><section className="extensions-confirm" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={locked || !!props.loading} tabIndex={-1}>
      <header>
        <span className={`extensions-confirm-icon${confirmation.kind === "remove" ? " is-danger" : ""}`}>
          <AppIcon name={confirmation.kind === "remove" ? "trash" : "puzzle"} />
        </span>
        <h2 id={titleId}>{t(confirmation.kind === "group" ? "Review group extension changes" : "Remove extension?")}</h2>
        <button className="iconbtn" type="button" aria-label={t("Close")} disabled={writeLocked} onClick={() => closeRef.current()}><Glyph name="close" /></button>
      </header>
      <div className="extensions-confirm-body">{confirmation.kind === "group" ? <>
        <p className="extensions-confirm-lead" id={descriptionId}>{t("Replace extension assignments for {count} environments in {group}.", { count: confirmation.preview.count, group: confirmation.preview.group })}</p>
        <dl className="extensions-confirm-summary">
          {confirmation.preview.defaultAdded.length > 0 && <div className="extensions-summary-add"><dt><AppIcon name="plus" className="sm" />{t("Add to group defaults")}</dt><dd>{changeList(confirmation.preview.defaultAdded)}</dd></div>}
          {confirmation.preview.defaultRemoved.length > 0 && <div className="extensions-summary-remove"><dt><AppIcon name="close" className="sm" />{t("Remove from group defaults")}</dt><dd>{changeList(confirmation.preview.defaultRemoved)}</dd></div>}
          <div><dt><AppIcon name="check" className="sm" />{t("Resulting selection")}</dt><dd>{changeList(confirmation.preview.extensions)}</dd></div>
        </dl>
        {(confirmation.preview.changes.length > 0 || confirmation.preview.unknown > 0) &&
          <p className="extensions-confirm-warning"><AppIcon name="warning" className="sm" /><span>{t("Individual environment assignments are replaced, including custom selections. Firefox assignments stay empty. Reopen running browsers to apply changes.")}</span></p>}
        {confirmation.preview.changes.length > 0 && <GroupReviewChanges key={confirmation.reviewInstanceId} changes={confirmation.preview.changes} locked={locked || !!props.loading} changeList={changeList} />}
        {confirmation.preview.unknown > 0 && <p className="extensions-confirm-warning">{t("Assignment details are unavailable for {count} environments. Applying still replaces their individual selections.", { count: confirmation.preview.unknown })}</p>}
        {!confirmation.preview.changes.length && !confirmation.preview.unknown && <p>{t("Existing environment assignments stay the same; only group defaults may change.")}</p>}
      </> : <>
        <p className="extensions-confirm-lead" id={descriptionId}>{t("Remove {extension} from this device?", { extension: confirmation.extension.name })}</p>
        <p className="extensions-remove-impact" ref={removeImpact} tabIndex={-1}>{t("It will be removed from {count} environment assignments and {groups} group defaults.", { count: confirmation.count, groups: confirmation.groups })}</p>
        {confirmation.unknown > 0 && <p>{t("Additional environment assignments may be affected because some details are unavailable.")}</p>}
        <p className="extensions-confirm-warning is-danger"><AppIcon name="warning" className="sm" /><span>{t("The local extension files will be deleted. Install the extension again to restore it; previous assignments are not restored automatically.")}</span></p>
      </>}
        {stale && !locked && !reading && !dataUnavailable && <p role="alert" className="extensions-feedback is-error">{t(confirmation.kind === "group" && confirmation.needsReview ? "This review needs to be refreshed before applying. Your selection is kept." : confirmation.kind === "remove" && !extensionToRemove ? "This extension is no longer installed." : "Assignments changed. Review the latest changes before continuing.")}</p>}
        {operationError && <p className="extensions-feedback is-error" role="alert">{props.error || t(operationError)}</p>}
        {(dataUnavailable || canReviewRemoval || confirmation.kind === "group" && (stale || operationError || reviewing || props.selectedGroupAvailable === false)) && <div className="extensions-review-recovery">
          {props.dataFresh === false && <p role="status">{t("Extension data is out of date. Reload it before making another change. Your draft is kept.")}</p>}
          <div className="extensions-feedback-actions">{(props.dataFresh === false || props.selectedGroupAvailable === false) && props.onReload && <button type="button" className="btn" disabled={writeLocked || reviewing || reloading || !!props.loading} onClick={() => void reload()}>{t(reloading || props.loading ? "Loading…" : "Reload extension data")}</button>}
            {confirmation.kind === "group" && <button type="button" className="btn" disabled={locked || !!props.loading || props.dataFresh === false || props.selectedGroupAvailable === false} onClick={() => void review({ group: confirmation.preview.group, extensions: [...confirmation.preview.extensions] })}>{t(reviewing ? "Reviewing…" : "Review latest changes")}</button>}
            {canReviewRemoval && <button type="button" className="btn" disabled={locked || reading || dataUnavailable} onClick={reviewRemoval}>{t("Review latest changes")}</button>}
          </div>
        </div>}
      </div>
      <footer><button className="btn" type="button" disabled={writeLocked} onClick={() => closeRef.current()}>{t("Cancel")}</button><button className={`btn ${confirmation.kind === "remove" ? "danger" : "primary"}`} type="button" aria-label={t(confirmation.kind === "remove" ? "Remove extension" : "Apply group default")} disabled={locked || !!stale || !!props.loading || props.dataFresh === false || confirmation.kind === "group" && props.selectedGroupAvailable === false} onClick={confirm}>{t(reviewing ? "Reviewing…" : reloading ? "Loading…" : writeLocked ? confirmation.kind === "remove" ? "Removing…" : "Applying…" : confirmation.kind === "remove" ? "Remove extension" : "Apply group default")}</button></footer>
    </section></div>)}</MotionPresence>, document.body)}
  </div>;
}
