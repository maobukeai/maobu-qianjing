export interface ExtensionDefaultsGroup { name: string; extensions: readonly string[] }
export interface ExtensionDefaultDraft {
  readonly group: string;
  readonly baseline: readonly string[];
  readonly extensions: readonly string[];
  readonly dirty: boolean;
  readonly available: boolean;
}
export interface ExtensionDefaultDraftSnapshot {
  readonly workspaceId: string | null;
  readonly groups: readonly ExtensionDefaultsGroup[];
  readonly selectedGroup: string | null;
  readonly selected: ExtensionDefaultDraft | null;
  readonly drafts: readonly ExtensionDefaultDraft[];
  readonly dirtyCount: number;
}
const ids = (values: readonly string[]) => Object.freeze([...new Set(values)].sort());
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
const draft = (group: string, baseline: readonly string[], extensions: readonly string[], available: boolean): ExtensionDefaultDraft =>
  Object.freeze({ group, baseline, extensions, dirty: !same(baseline, extensions), available });

/** Session-only drafts. A registry refresh never substitutes for a user's discard. */
export function createExtensionDefaultDrafts(initialWorkspaceId: string | null = null) {
  let workspaceId = initialWorkspaceId, groups: readonly ExtensionDefaultsGroup[] = Object.freeze([]), selectedGroup: string | null = null;
  const drafts = new Map<string, ExtensionDefaultDraft>(), listeners = new Set<() => void>();
  const snapshot = (): ExtensionDefaultDraftSnapshot => Object.freeze({ workspaceId, groups, selectedGroup,
    selected: selectedGroup === null ? null : drafts.get(selectedGroup) ?? null,
    drafts: Object.freeze([...drafts.values()]), dirtyCount: [...drafts.values()].filter(value => value.dirty).length });
  let state = snapshot();
  function publish() { state = snapshot(); for (const listener of [...listeners]) listener(); }
  function accepts(expected: string | null) { return expected !== null && workspaceId === expected; }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setWorkspace(next: string | null) {
      if (next === workspaceId) return;
      workspaceId = next; groups = Object.freeze([]); selectedGroup = null; drafts.clear(); publish();
    },
    receive(expected: string | null, next: readonly ExtensionDefaultsGroup[]) {
      if (!accepts(expected)) return false;
      groups = Object.freeze(next.map(value => Object.freeze({ name: value.name, extensions: ids(value.extensions) })));
      const available = new Set(groups.map(value => value.name));
      for (const group of groups) {
        const previous = drafts.get(group.name);
        drafts.set(group.name, draft(group.name, group.extensions, previous?.dirty ? previous.extensions : group.extensions, true));
      }
      for (const [name, previous] of drafts) if (!available.has(name)) {
        if (previous.dirty) drafts.set(name, draft(name, previous.baseline, previous.extensions, false));
        else drafts.delete(name);
      }
      if (selectedGroup === null || !drafts.has(selectedGroup)) selectedGroup = groups[0]?.name ?? drafts.keys().next().value ?? null;
      publish(); return true;
    },
    select(group: string) { if (!drafts.has(group) || selectedGroup === group) return; selectedGroup = group; publish(); },
    toggle(id: string) {
      if (selectedGroup === null) return;
      const current = drafts.get(selectedGroup); if (!current?.available) return;
      const next = ids(current.extensions.includes(id) ? current.extensions.filter(value => value !== id) : [...current.extensions, id]);
      drafts.set(selectedGroup, draft(selectedGroup, current.baseline, next, true)); publish();
    },
    discard(group = selectedGroup) {
      if (group === null) return;
      const current = drafts.get(group); if (!current) return;
      if (current.available) drafts.set(group, draft(group, current.baseline, current.baseline, true));
      else { drafts.delete(group); if (selectedGroup === group) selectedGroup = groups[0]?.name ?? drafts.keys().next().value ?? null; }
      publish();
    },
    acknowledge(expected: string | null, group: string, saved: readonly string[]) {
      if (!accepts(expected)) return false;
      const baseline = ids(saved), current = drafts.get(group);
      if (!current) return false;
      drafts.set(group, draft(group, baseline, current.extensions, current.available));
      groups = Object.freeze(groups.map(value => value.name === group ? Object.freeze({ name: group, extensions: baseline }) : value));
      publish(); return true;
    },
    removeConfirmed(expected: string | null, id: string) {
      if (!accepts(expected)) return false;
      groups = Object.freeze(groups.map(value => Object.freeze({ name: value.name, extensions: ids(value.extensions.filter(value => value !== id)) })));
      for (const [name, current] of drafts) drafts.set(name, draft(name, ids(current.baseline.filter(value => value !== id)), ids(current.extensions.filter(value => value !== id)), current.available));
      publish(); return true;
    },
  };
}
