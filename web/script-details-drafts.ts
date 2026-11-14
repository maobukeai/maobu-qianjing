import type { ScriptRecord } from "../contracts/local.ts";

type ScriptDetails = Pick<ScriptRecord, "name" | "description">;
type DetailsField = keyof ScriptDetails;
type SavedScriptDetails = Readonly<Pick<ScriptRecord, "id" | "name" | "description" | "revision">>;

export interface ScriptDetailsDraft {
  readonly baseline: SavedScriptDetails;
  readonly changes: Readonly<Partial<ScriptDetails>>;
}

const fields = ["name", "description"] as const;
function sameField(field: DetailsField, left: string, right: string): boolean {
  // The library trims the title before writing and keeps descriptions verbatim.
  return field === "name" ? left.trim() === right.trim() : left === right;
}

function differences(saved: SavedScriptDetails, changes: Readonly<Partial<ScriptDetails>>): Partial<ScriptDetails> {
  const remaining: Partial<ScriptDetails> = {};
  for (const field of fields) {
    const value = changes[field];
    if (value !== undefined && !sameField(field, value, saved[field])) remaining[field] = value;
  }
  return remaining;
}

function baseline(record: SavedScriptDetails): SavedScriptDetails {
  const { id, name, description, revision } = record;
  return Object.freeze({ id, name, description, revision });
}

function draftFrom(saved: SavedScriptDetails, changes: Partial<ScriptDetails>): ScriptDetailsDraft {
  return Object.freeze({ baseline: saved, changes: Object.freeze(changes) });
}

/** One mounted Scripts session owns metadata only. Source, credentials and run inputs stay out. */
export function createScriptDetailsDrafts() {
  const drafts = new Map<string, ScriptDetailsDraft>();
  const discarded = new Map<string, ScriptDetailsDraft>();

  function keep(id: string, base: SavedScriptDetails, changes: Partial<ScriptDetails>): ScriptDetailsDraft | undefined {
    if (Object.keys(changes).length === 0) {
      drafts.delete(id);
      return;
    }
    const next = draftFrom(base, changes);
    drafts.set(id, next);
    return next;
  }

  function observe(saved: SavedScriptDetails): ScriptDetailsDraft | undefined {
    const previous = drafts.get(saved.id);
    if (!previous) return;
    const remaining = differences(saved, previous.changes);
    if (fields.every(field => remaining[field] === previous.changes[field])) return previous;
    return keep(saved.id, previous.baseline, remaining);
  }

  return {
    get: (id: string) => drafts.get(id),
    count: () => drafts.size,
    ids: () => [...drafts.keys()],
    canUndo: (id: string) => discarded.has(id),
    observe,
    edit(saved: SavedScriptDetails, field: DetailsField, value: string) {
      const previous = drafts.get(saved.id);
      discarded.delete(saved.id);
      return keep(saved.id, previous?.baseline ?? baseline(saved), differences(saved, { ...previous?.changes, [field]: value }));
    },
    discard(id: string) {
      const previous = drafts.get(id);
      if (!previous) return false;
      discarded.set(id, previous);
      drafts.delete(id);
      return true;
    },
    undo(saved: SavedScriptDetails) {
      const previous = discarded.get(saved.id);
      if (!previous || drafts.has(saved.id)) return;
      discarded.delete(saved.id);
      return keep(saved.id, previous.baseline, differences(saved, previous.changes));
    },
    forget(id: string) {
      drafts.delete(id);
      discarded.delete(id);
    },
    /** Only an explicit review can advance a conflicting draft to a new revision. */
    rebase(saved: SavedScriptDetails, reviewed: ScriptDetailsDraft) {
      if (drafts.get(saved.id) !== reviewed || saved.revision < reviewed.baseline.revision) return false;
      keep(saved.id, baseline(saved), differences(saved, reviewed.changes));
      return true;
    },
    acknowledgeSave(saved: SavedScriptDetails, sent: ScriptDetailsDraft) {
      if (saved.id !== sent.baseline.id || !Number.isSafeInteger(saved.revision) || saved.revision <= sent.baseline.revision
          || fields.some(field => typeof saved[field] !== "string" || !sameField(field, saved[field], sent.changes[field] ?? sent.baseline[field]))) return false;
      if (drafts.get(saved.id) === sent) {
        drafts.delete(saved.id);
        discarded.delete(saved.id);
      } else {
        // A late reply must not clear edits made since the request was captured.
        observe(saved);
      }
      return true;
    },
    acknowledgeSourceReplacement(before: SavedScriptDetails, after: SavedScriptDetails) {
      const previous = drafts.get(after.id);
      if (previous && before.id === after.id && previous.baseline.revision === before.revision && after.revision > before.revision
          && fields.every(field => sameField(field, before[field], after[field]))) {
        keep(after.id, baseline(after), differences(after, previous.changes));
      } else {
        observe(after);
      }
    },
  };
}

export function scriptDetailsWithDraft<T extends SavedScriptDetails>(saved: T, draft: ScriptDetailsDraft | undefined): T {
  return draft ? { ...saved, ...draft.changes } : saved;
}
