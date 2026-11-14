/** A range belongs to one rendered page, including its ordering and disclosure. */
export interface ProfileSelectionAnchor {
  readonly id: string;
  readonly viewKey: string;
  readonly visibleIds: readonly string[];
}

export interface ProfileRangeSelectionInput {
  readonly selected: Set<string>;
  /** Only the rows whose checkboxes are currently visible, in rendered order. */
  readonly visibleIds: readonly string[];
  /** Include workspace, page, filters and sort. Reconcile on every view change. */
  readonly viewKey: string;
  readonly anchor: ProfileSelectionAnchor | null;
  readonly id: string;
  /** The native checkbox's desired value; never infer it by toggling the Set. */
  readonly checked: boolean;
  /** May come from a pointer click or a native Shift+Space activation. */
  readonly shiftKey?: boolean;
}

export interface ProfileRangeSelectionResult {
  readonly selected: Set<string>;
  readonly anchor: ProfileSelectionAnchor | null;
  readonly affectedIds: readonly string[];
  readonly range: boolean;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Call on view changes as well as activation, so leaving and returning resets a range. */
export function reconcileProfileSelectionAnchor(
  anchor: ProfileSelectionAnchor | null,
  viewKey: string,
  visibleIds: readonly string[],
): ProfileSelectionAnchor | null {
  if (!anchor || anchor.viewKey !== viewKey) return null;
  const ids = uniqueIds(visibleIds);
  return ids.length === anchor.visibleIds.length
    && ids.every((id, index) => id === anchor.visibleIds[index])
    && ids.includes(anchor.id) ? anchor : null;
}

/**
 * Apply an explicit checkbox value to one row or the anchored visible span.
 * Existing selections outside that span are preserved, including other pages.
 * Replaying a native event is harmless because this does not toggle selection.
 */
export function changeProfileRangeSelection(input: ProfileRangeSelectionInput): ProfileRangeSelectionResult {
  const ids = uniqueIds(input.visibleIds);
  const anchor = reconcileProfileSelectionAnchor(input.anchor, input.viewKey, ids);
  const index = ids.indexOf(input.id);
  // A queued event from a row removed by filtering or a refresh must do nothing.
  if (index < 0) return { selected: input.selected, anchor, affectedIds: [], range: false };

  const range = !!input.shiftKey && anchor !== null;
  const anchorIndex = range ? ids.indexOf(anchor.id) : index;
  const affectedIds = ids.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1);
  let selected = input.selected;
  for (const id of affectedIds) {
    if (selected.has(id) === input.checked) continue;
    if (selected === input.selected) selected = new Set(input.selected);
    if (input.checked) selected.add(id);
    else selected.delete(id);
  }

  return {
    selected,
    anchor: range ? anchor : { id: input.id, viewKey: input.viewKey, visibleIds: ids },
    affectedIds,
    range,
  };
}
