import { type CSSProperties, type FocusEvent, type KeyboardEvent, type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RosterScope } from "../../profile-view-state.ts";
import { ROSTER_DENSITY_ROW_HEIGHT, type RosterDensity } from "../../roster-density-state.ts";
import type { DiagnoseReport, UiProfile } from "../api.ts";
import { RosterSkeleton } from "../components/roster-skeleton.tsx";
import { useEffectiveDesktopMotion } from "../desktop-motion.tsx";
import { useFlipGroup } from "../hooks/use-flip-group.ts";
import {
  CHECKBOX_COLUMN_WIDTH,
  COLUMNS,
  estimateFlatRosterItemHeight,
  PAGE_SIZES,
  type ColumnKey,
  type FlatRosterItem,
  type RosterSort,
  type SortKey,
} from "../hooks/use-roster-query.ts";
import { DEFAULT_FALLBACK_VIEWPORT_HEIGHT, DEFAULT_VIRTUAL_THRESHOLD, useVirtualList } from "../hooks/use-virtual-list.ts";
import { ProfileActionMenu } from "../profile-action-menu.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import { StatusDot } from "./profile-form-helpers.tsx";
import { ProfileLaunchFailureRow, ProfileRosterRow, type ProfileRosterRowHandlers } from "./profile-roster-row.tsx";

const Icon = AppIcon;

export interface ProfileRosterTableProps {
  loaded: boolean;
  profilesCount: number;
  filteredCount: number;
  flatItems: readonly FlatRosterItem[];
  selectableProfilesCount: number;
  numbering: ReadonlyMap<string, { value: string; custom: boolean }>;
  rosterScope: RosterScope;
  rosterDensity: RosterDensity;
  missingRosterGroup: string | null;
  hasRosterRefinements: boolean;
  revealGroupMatches: boolean;
  sort: RosterSort;
  hiddenCols: ReadonlySet<ColumnKey>;
  shownColumns: readonly (typeof COLUMNS)[number][];
  visibleColumnCount: number;
  tableMinWidth: number;
  tableScrolled: boolean;
  onTableScrolledChange: (scrolled: boolean) => void;
  selected: ReadonlySet<string>;
  allVisibleSelected: boolean;
  busy: Readonly<Record<string, boolean>>;
  favoriteProfileIds: ReadonlySet<string>;
  reuseLoadingId: string | null;
  twoFaFlashId: string | null;
  viewPreferencesReady: boolean;
  viewPreferenceBusy: boolean;
  language: string;
  rangeKeyboardActivation: MutableRefObject<{ id: string; shiftKey: boolean } | null>;
  profilePageCount: number;
  visibleProfilePage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  runningCount: number;
  diag: DiagnoseReport | null;
  diagWhen: string | null;
  showDiag: boolean;
  onToggleDiag: () => void;
  hasDetails: boolean;
  detailsPanel?: ReactNode;
  loadingContent?: ReactNode;
  folderLabel: (name: string) => string;
  openLabel: (profile: UiProfile) => string;
  onToggleSort: (key: SortKey) => void;
  onToggleAll: () => void;
  onToggleProfileGroup: (name: string, collapsed: boolean) => void;
  onToggleGroupSelection: (matches: readonly UiProfile[]) => void;
  onCreateInGroup: (groupName: string) => void;
  onManageGroup: (groupName: string) => void;
  onNewSubfolder: (groupName: string) => void;
  onOpenCreate: () => void;
  onOpenBulk: () => void;
  onSelectAllGroups: () => void;
  onChooseRosterScope: (scope: RosterScope) => void;
  onClearRosterRefinements: () => void;
  rowHandlers: ProfileRosterRowHandlers;
  t: (source: string, values?: Record<string, string | number>) => string;
  /** Optional Wave 3 resource chip renderer per row. */
  renderResourceChips?: (profile: UiProfile) => ReactNode;
  /** Optional Wave 4 inline rename state/callbacks. */
  inlineRenameId?: string | null;
  inlineRenameDraft?: string;
  onStartInlineRename?: (id: string) => void;
  onChangeInlineRename?: (value: string) => void;
  onCommitInlineRename?: (id: string) => void;
  onCancelInlineRename?: () => void;
  /** Optional Wave 4 inline name & quick notes editors (auto-pinned while editing). */
  onSaveInlineName?: (id: string, nextName: string) => Promise<void>;
  onInlineNameSaved?: (id: string, nextName: string) => void;
  onSaveQuickNotes?: (id: string, nextNotes: string) => Promise<void>;
  onQuickNotesSaved?: (id: string, nextNotes: string) => void;
  onInlineEditorError?: (message: string) => void;
  /** Extra pinned flat keys kept alive in the virtual window. */
  pinnedKeys?: ReadonlySet<string>;
  /** Override virtual threshold (defaults to 60). */
  virtualThreshold?: number;
  /** Override fallback viewport height when clientHeight === 0 (defaults to 800). */
  fallbackViewportHeight?: number;
  /** Serialized group disclosure signature driving FLIP collapse/expand transitions. */
  groupDisclosureKey?: string;
  /** Whether motion animations (including group FLIP) are permitted under desktop-motion settings. */
  motionAllowed?: boolean;
  /** Optional ref to expose the table body for FLIP group animations (Author C integration). */
  tbodyRef?: React.RefObject<HTMLTableSectionElement | null>;
}

const getFlatItemKey = (item: FlatRosterItem) => item.key;

export function ProfileRosterTable({
  loaded,
  profilesCount,
  filteredCount,
  flatItems,
  selectableProfilesCount,
  numbering,
  rosterScope,
  rosterDensity,
  missingRosterGroup,
  hasRosterRefinements,
  revealGroupMatches,
  sort,
  hiddenCols,
  shownColumns,
  visibleColumnCount,
  tableMinWidth,
  tableScrolled,
  onTableScrolledChange,
  selected,
  allVisibleSelected,
  busy,
  favoriteProfileIds,
  reuseLoadingId,
  twoFaFlashId,
  viewPreferencesReady,
  viewPreferenceBusy,
  language,
  rangeKeyboardActivation,
  profilePageCount,
  visibleProfilePage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  runningCount,
  diag,
  diagWhen,
  showDiag,
  onToggleDiag,
  hasDetails,
  detailsPanel,
  loadingContent,
  folderLabel,
  openLabel,
  onToggleSort,
  onToggleAll,
  onToggleProfileGroup,
  onToggleGroupSelection,
  onCreateInGroup,
  onManageGroup,
  onNewSubfolder,
  onOpenCreate,
  onOpenBulk,
  onSelectAllGroups,
  onChooseRosterScope,
  onClearRosterRefinements,
  rowHandlers,
  t,
  renderResourceChips,
  inlineRenameId = null,
  inlineRenameDraft,
  onStartInlineRename,
  onChangeInlineRename,
  onCommitInlineRename,
  onCancelInlineRename,
  onSaveInlineName,
  onInlineNameSaved,
  onSaveQuickNotes,
  onQuickNotesSaved,
  onInlineEditorError,
  pinnedKeys: externalPinnedKeys,
  virtualThreshold = DEFAULT_VIRTUAL_THRESHOLD,
  fallbackViewportHeight = DEFAULT_FALLBACK_VIEWPORT_HEIGHT,
  groupDisclosureKey,
  motionAllowed,
  tbodyRef,
}: ProfileRosterTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const effectiveDesktopMotion = useEffectiveDesktopMotion();
  const flipMotionAllowed = motionAllowed ?? (effectiveDesktopMotion === "full");
  const resolvedDisclosureKey = useMemo(
    () =>
      groupDisclosureKey ??
      flatItems
        .filter((item): item is Extract<FlatRosterItem, { kind: "group-header" }> => item.kind === "group-header")
        .map((item) => `${item.section.name}:${item.collapsed ? "1" : "0"}`)
        .join("|"),
    [groupDisclosureKey, flatItems],
  );
  useFlipGroup(scrollContainerRef, resolvedDisclosureKey, flipMotionAllowed);
  const [focusedFlatKey, setFocusedFlatKey] = useState<string | null>(null);
  const [inlineEditingCounts, setInlineEditingCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const updateInlineEditingPin = useCallback((id: string, active: boolean) => {
    const key = `profile:${id}`;
    setInlineEditingCounts((current) => {
      const prev = current.get(key) ?? 0;
      const nextCount = active ? prev + 1 : Math.max(0, prev - 1);
      if (nextCount === prev) return current;
      const next = new Map(current);
      if (nextCount === 0) next.delete(key);
      else next.set(key, nextCount);
      return next;
    });
  }, []);
  const prevInlineRenameIdRef = useRef(inlineRenameId);
  if (prevInlineRenameIdRef.current !== inlineRenameId) {
    prevInlineRenameIdRef.current = inlineRenameId;
    if (!inlineRenameId && focusedFlatKey) {
      setFocusedFlatKey(null);
    }
  }

  useEffect(() => () => {
    if (focusFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(focusFrameRef.current);
    }
  }, []);

  const mergedPinnedKeys = useMemo<ReadonlySet<string> | undefined>(() => {
    const renameKey = inlineRenameId ? `profile:${inlineRenameId}` : null;
    if (!focusedFlatKey && !renameKey && inlineEditingCounts.size === 0 && (!externalPinnedKeys || externalPinnedKeys.size === 0)) return undefined;
    const set = new Set<string>(externalPinnedKeys);
    if (focusedFlatKey) set.add(focusedFlatKey);
    if (renameKey) set.add(renameKey);
    for (const key of inlineEditingCounts.keys()) set.add(key);
    return set;
  }, [focusedFlatKey, inlineRenameId, inlineEditingCounts, externalPinnedKeys]);

  const estimateItemHeight = useCallback(
    (item: FlatRosterItem) => estimateFlatRosterItemHeight(item, rosterDensity),
    [rosterDensity],
  );

  const virtual = useVirtualList({
    items: flatItems,
    scrollContainerRef,
    getKey: getFlatItemKey,
    estimateHeight: estimateItemHeight,
    threshold: virtualThreshold,
    fallbackViewportHeight,
    pinnedKeys: mergedPinnedKeys,
    resetKey: rosterDensity,
  });

  const { navigableIndices, keyToFlatIndex } = useMemo(() => {
    const nav: number[] = [];
    const lookup = new Map<string, number>();
    for (let i = 0; i < flatItems.length; i++) {
      const item = flatItems[i]!;
      lookup.set(item.key, i);
      if (item.kind === "profile" || item.kind === "group-header") {
        nav.push(i);
      }
    }
    return { navigableIndices: nav, keyToFlatIndex: lookup };
  }, [flatItems]);

  const handleFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.classList.contains("profile-inline-rename-input") || target.classList.contains("quick-notes-textarea")) return;
    const row = target.closest<HTMLTableRowElement>("tbody.profile-roster-body > tr[data-flat-key]");
    const key = row?.dataset.flatKey ?? null;
    if (key) setFocusedFlatKey((current) => (current === key ? current : key));
  }, []);

  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next && (event.currentTarget.contains(next) || next.closest(".profile-actions-menu"))) return;
    setFocusedFlatKey(null);
  }, []);

  const handleTableKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End" && key !== "PageDown" && key !== "PageUp") return;
      const target = event.target as HTMLElement | null;
      if (!target || target.isContentEditable) return;
      if (target.closest('[role="menu"], [role="dialog"]')) return;
      if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox") return;

      const row = target.closest<HTMLTableRowElement>("tbody.profile-roster-body > tr[data-flat-key]");
      const currentKey = row?.dataset.flatKey;
      if (!currentKey) return;
      const currentFlatIndex = keyToFlatIndex.get(currentKey);
      if (currentFlatIndex === undefined) return;
      const pos = navigableIndices.indexOf(currentFlatIndex);
      if (pos < 0 || navigableIndices.length === 0) return;

      event.preventDefault();
      const pageStep = Math.max(1, Math.floor(virtual.viewportHeight / ROSTER_DENSITY_ROW_HEIGHT[rosterDensity]));
      let nextPos = pos;
      if (key === "ArrowDown") nextPos = Math.min(navigableIndices.length - 1, pos + 1);
      else if (key === "ArrowUp") nextPos = Math.max(0, pos - 1);
      else if (key === "Home") nextPos = 0;
      else if (key === "End") nextPos = navigableIndices.length - 1;
      else if (key === "PageDown") nextPos = Math.min(navigableIndices.length - 1, pos + pageStep);
      else if (key === "PageUp") nextPos = Math.max(0, pos - pageStep);
      if (nextPos === pos) return;

      const affinity: "checkbox" | "name" | "any" = target.matches('td.chk input[type="checkbox"], .profile-group-check')
        ? "checkbox"
        : target.matches(".profile-name-button, .profile-group-toggle")
          ? "name"
          : "any";

      const nextFlatIndex = navigableIndices[nextPos]!;
      const nextItem = flatItems[nextFlatIndex]!;
      setFocusedFlatKey(nextItem.key);
      virtual.scrollToIndex(nextFlatIndex, "nearest");

      if (focusFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(focusFrameRef.current);
      }
      const focusTargetRow = () => {
        focusFrameRef.current = null;
        const container = scrollContainerRef.current;
        if (!container) return;
        const rows = container.querySelectorAll<HTMLTableRowElement>("tbody.profile-roster-body > tr[data-flat-key]");
        let targetRow: HTMLTableRowElement | null = null;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i]!.dataset.flatKey === nextItem.key) {
            targetRow = rows[i]!;
            break;
          }
        }
        if (!targetRow) return;
        let control: HTMLElement | null = null;
        if (affinity === "checkbox") {
          control = targetRow.querySelector<HTMLElement>('td.chk input[type="checkbox"]:not(:disabled), .profile-group-check:not(:disabled)');
        } else if (affinity === "name") {
          control = targetRow.querySelector<HTMLElement>(".profile-name-button:not(:disabled), .profile-group-toggle:not(:disabled)");
        }
        if (!control) {
          control = targetRow.querySelector<HTMLElement>(
            'td.chk input[type="checkbox"]:not(:disabled), .profile-name-button:not(:disabled), .profile-group-toggle:not(:disabled), button:not(:disabled)',
          );
        }
        control?.focus({ preventScroll: true });
      };
      if (typeof requestAnimationFrame === "function") {
        focusFrameRef.current = requestAnimationFrame(focusTargetRow);
      } else {
        focusTargetRow();
      }
    },
    [flatItems, keyToFlatIndex, navigableIndices, rosterDensity, virtual],
  );

  const columnHead = (column: (typeof COLUMNS)[number]) => {
    const label = t(column.label);
    // Every column declares its width, so a wide window's extra space spreads
    // proportionally across all of them — an even layout, no dead gap.
    const style = { width: column.width } as CSSProperties;
    if (!column.sort) return <th key={column.key} className={`col-${column.key}`} style={style}>{label}</th>;
    const key = column.key as SortKey;
    return (
      <th key={column.key} className={`col-${column.key} sortable${sort.key === key ? " sorted" : ""}`} style={style} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="th-inner" onClick={() => onToggleSort(key)}>
          {label}
          <Icon className="sortglyph sm" name={sort.key === key ? (sort.dir === 1 ? "sortUp" : "sortDown") : "sort"} />
        </button>
      </th>
    );
  };

  return (
    <>
      <div className={`profile-browser${hasDetails ? " has-details" : ""}`}>
        <div
          ref={scrollContainerRef}
          className={`tablewrap${tableScrolled ? " scrolled" : ""}`}
          data-virtualized={virtual.virtualized ? "true" : "false"}
          onScroll={(event) => {
            onTableScrolledChange(event.currentTarget.scrollLeft > 0);
            virtual.onScroll();
          }}
          onKeyDown={handleTableKeyDown}
          onFocusCapture={handleFocusCapture}
          onBlurCapture={handleBlurCapture}
        >
          <span id="profile-range-selection-hint" className="sr-only">
            {t("Hold Shift while changing a checkbox to select or clear a visible range on this page. Shift+Space also works.")}
          </span>
          <table className="profile-table" aria-busy={!loaded} aria-rowcount={flatItems.length} style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr>
                <th className="chk" style={{ width: CHECKBOX_COLUMN_WIDTH }} title={t("Shift-click to select a range")}>
                  <input
                    type="checkbox"
                    aria-label={t("Select all visible profiles")}
                    checked={allVisibleSelected}
                    disabled={!selectableProfilesCount}
                    onChange={onToggleAll}
                  />
                </th>
                {shownColumns.map(columnHead)}
              </tr>
            </thead>
            <tbody ref={tbodyRef} id="profile-roster-body" className="profile-roster-body">
              {!loaded && (
                loadingContent ?? (
                  <RosterSkeleton rows={8} visibleColumnCount={visibleColumnCount} density={rosterDensity} />
                )
              )}
              {virtual.blocks.map((block) => {
                if (block.type === "spacer") {
                  return (
                    <tr key={block.key} className="virtual-spacer" aria-hidden="true">
                      <td colSpan={visibleColumnCount} style={{ height: block.height }} />
                    </tr>
                  );
                }
                const item = flatItems[block.index]!;
                const ariaRowIndex = block.index + 1;
                if (item.kind === "group-header") {
                  const { section, collapsed } = item;
                  const groupName = section.name ? folderLabel(section.name) : t("Ungrouped");
                  const selectedInGroup = section.matches.filter((profile) => selected.has(profile.id)).length;
                  return (
                    <tr
                      key={item.key}
                      ref={virtual.measureRow(item.key)}
                      data-flat-key={item.key}
                      data-group-name={section.name}
                      aria-rowindex={ariaRowIndex}
                      className="profile-group-row"
                    >
                      <td colSpan={visibleColumnCount}>
                        <div className="profile-group-heading">
                          <input
                            className="profile-group-check"
                            type="checkbox"
                            aria-label={t("Select all {count} profiles in {group}", { count: section.matches.length, group: groupName })}
                            disabled={!section.matches.length}
                            checked={section.matches.length > 0 && selectedInGroup === section.matches.length}
                            ref={(element) => {
                              if (element) element.indeterminate = selectedInGroup > 0 && selectedInGroup < section.matches.length;
                            }}
                            onChange={() => onToggleGroupSelection(section.matches)}
                          />
                          <button
                            type="button"
                            className="profile-group-toggle"
                            aria-expanded={!collapsed}
                            aria-controls="profile-roster-body"
                            aria-label={t(collapsed ? "Expand {group}" : "Collapse {group}", { group: groupName })}
                            disabled={revealGroupMatches}
                            onClick={() => onToggleProfileGroup(section.name, collapsed)}
                          >
                            <Icon name={collapsed ? "chevronRight" : "chevronDown"} className="sm" />
                            <span className="profile-group-name" title={section.name}>{groupName}</span>
                            <span className="profile-group-count">{t("{count} environments", { count: section.matches.length })}</span>
                            <span className="profile-group-running">{t("{count} running", { count: section.running })}</span>
                            {section.profiles.length < section.matches.length && (
                              <span className="profile-group-page-hint">{t("{count} on this page", { count: section.profiles.length })}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="iconbtn tip profile-group-create"
                            data-tip={t("New Profile")}
                            aria-label={t("New profile in {group}", { group: groupName })}
                            onClick={() => onCreateInGroup(section.name)}
                          >
                            <Icon name="plus" className="sm" />
                          </button>
                          <ProfileActionMenu label={t("Actions for {folder}", { folder: groupName })} icon={<Icon name="more" className="sm" />}>
                            <button role="menuitem" className="pop-item" onClick={() => onManageGroup(section.name)}><Icon name="folders" className="sm" />{t("Manage groups")}</button>
                            <button role="menuitem" className="pop-item" onClick={() => onNewSubfolder(section.name)}><Icon name="plus" className="sm" />{t("New subfolder")}</button>
                          </ProfileActionMenu>
                        </div>
                      </td>
                    </tr>
                  );
                }
                if (item.kind === "launch-failure") {
                  return (
                    <ProfileLaunchFailureRow
                      key={item.key}
                      rowRef={virtual.measureRow(item.key)}
                      flatKey={item.key}
                      ariaRowIndex={ariaRowIndex}
                      p={item.profile}
                      message={item.message}
                      visibleColumnCount={visibleColumnCount}
                      isBusy={!!busy[item.profile.id]}
                      handlers={rowHandlers}
                      t={t}
                    />
                  );
                }
                const p = item.profile;
                // The numbering memo covers every roster profile, so this
                // lookup cannot miss; a silent fallback here would renumber
                // rows wrongly if that invariant ever broke.
                const no = numbering.get(p.id)!;
                const nextItem = flatItems[block.index + 1];
                const launchFailure = nextItem?.kind === "launch-failure" && nextItem.profile.id === p.id ? nextItem.message : undefined;
                return (
                  <ProfileRosterRow
                    key={item.key}
                    rowRef={virtual.measureRow(item.key)}
                    flatKey={item.key}
                    ariaRowIndex={ariaRowIndex}
                    p={p}
                    no={no}
                    isSelected={selected.has(p.id)}
                    isBusy={!!busy[p.id]}
                    isFavorite={favoriteProfileIds.has(p.id)}
                    isReuseLoading={reuseLoadingId === p.id}
                    twoFaFlashed={twoFaFlashId === p.id}
                    startLabel={openLabel(p)}
                    launchFailure={launchFailure}
                    rosterScope={rosterScope}
                    language={language}
                    hiddenCols={hiddenCols}
                    viewPreferencesReady={viewPreferencesReady}
                    viewPreferenceBusy={viewPreferenceBusy}
                    rangeKeyboardActivation={rangeKeyboardActivation}
                    handlers={rowHandlers}
                    t={t}
                    resourceChips={renderResourceChips?.(p)}
                    editingName={inlineRenameId === p.id}
                    inlineRenameDraft={inlineRenameId === p.id ? inlineRenameDraft : undefined}
                    onStartInlineRename={onStartInlineRename}
                    onChangeInlineRename={onChangeInlineRename}
                    onCommitInlineRename={onCommitInlineRename}
                    onCancelInlineRename={onCancelInlineRename}
                    onSaveInlineName={onSaveInlineName}
                    onInlineNameSaved={onInlineNameSaved}
                    onInlineNameEditingChange={updateInlineEditingPin}
                    onSaveQuickNotes={onSaveQuickNotes}
                    onQuickNotesSaved={onQuickNotesSaved}
                    onQuickNotesOpenChange={updateInlineEditingPin}
                    onInlineEditorError={onInlineEditorError}
                  />
                );
              })}
              {loaded && filteredCount === 0 && (
                <tr>
                  <td colSpan={visibleColumnCount} className="empty">
                    <div className="emptystate">
                      <span className="glyph"><Icon name={rosterScope === "attention" && !hasRosterRefinements ? "check" : "profiles"} /></span>
                      {profilesCount === 0 ? (
                        <>
                          <b>{t("No profiles yet")}</b>
                          <p>{t("Create a profile or import a readable export from another browser.")}</p>
                          <p>{t("When you start an environment for the first time, the app downloads its browser engine if needed.")}</p>
                          <div className="empty-actions">
                            <button className="btn primary" onClick={onOpenCreate}><Icon name="plus" className="sm" />{t("New Profile")}</button>
                            <button className="btn" onClick={onOpenBulk}><Icon name="fileImport" className="sm" />{t("Import profiles")}</button>
                          </div>
                        </>
                      ) : missingRosterGroup ? (
                        <>
                          <b>{t("This group is unavailable")}</b>
                          <p>{t("The group “{group}” may have been renamed or removed. Your saved view is kept.", { group: missingRosterGroup })}</p>
                          <button className="btn" onClick={onSelectAllGroups}>{t("Search all groups")}</button>
                        </>
                      ) : !hasRosterRefinements && rosterScope !== "all" ? (
                        <>
                          <b>{t(rosterScope === "favorites" ? "Your favorites start here" : rosterScope === "recent" ? "No recent launches yet" : "Nothing needs attention")}</b>
                          <p>{t(rosterScope === "favorites" ? "Use the star beside an environment name to keep it close at hand." : rosterScope === "recent" ? "Environments launched on this computer in the last seven days appear here." : "No environments currently have invalid proxy settings, changes awaiting restart or imported mobile configurations.")}</p>
                          <button className="btn" onClick={() => onChooseRosterScope("all")}>{t("Browse all environments")}</button>
                        </>
                      ) : (
                        <>
                          <b>{t("No matches")}</b>
                          <p>{t("No profiles match the current filters.")}</p>
                          <div className="empty-actions">
                            <button className="btn" onClick={onClearRosterRefinements}>{t("Clear filters")}</button>
                            {rosterScope !== "all" && <button className="btn ghost" onClick={() => onChooseRosterScope("all")}>{t("Browse all environments")}</button>}
                          </div>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {detailsPanel}
      </div>
      {showDiag && diag && (
        <div className="diagpanel">
          <div className="when">{t("Last diagnose: {when}", { when: diagWhen ?? "" })}</div>
          {diag.analysis.verdicts.map((v, i) => <div className="v" key={i}>{v}</div>)}
        </div>
      )}
      <footer className="statusbar">
        <span className="stat"><b>{profilesCount}</b> {t("profiles")}</span>
        <span className="stat"><StatusDot running={runningCount > 0} /><b>{runningCount}</b> {t("running")}</span>
        {diag && (
          <span className="diag" onClick={onToggleDiag}>
            {t("Diagnose · last {when}", { when: diagWhen ?? "" })}
            <Icon name={showDiag ? "chevronDown" : "chevronRight"} className="sm" />
          </span>
        )}
        <span className="pager">
          <button
            type="button"
            className="iconbtn"
            aria-label={t("Previous page")}
            disabled={visibleProfilePage === 0}
            onClick={() => onPageChange(visibleProfilePage - 1)}
          >
            <Icon name="chevronLeft" className="sm" />
          </button>
          <span className="page-of">
            {pageSize === 0 ? (
              t("All {count}", { count: filteredCount.toLocaleString() })
            ) : (
              <>{t("Page")} <b>{visibleProfilePage + 1}</b> / {profilePageCount}</>
            )}
          </span>
          <button
            type="button"
            className="iconbtn"
            aria-label={t("Next page")}
            disabled={visibleProfilePage + 1 >= profilePageCount}
            onClick={() => onPageChange(visibleProfilePage + 1)}
          >
            <Icon name="chevronRight" className="sm" />
          </button>
          <select className="select" aria-label={t("Rows per page")} value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size === 0 ? t("All (virtual scroll)") : t("{size} / page", { size })}
              </option>
            ))}
          </select>
        </span>
      </footer>
    </>
  );
}
