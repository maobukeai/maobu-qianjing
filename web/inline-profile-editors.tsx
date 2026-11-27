import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  MAX_PROFILE_NOTES_CHARACTERS,
  normalizeProfileNotes,
  ProfileNotesValidationError,
} from "../src/profile-notes.ts";
import { updateProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon, ModalDialog } from "./ui-primitives.tsx";
import "./inline-profile-editors.css";

function isImeComposing(event: KeyboardEvent<HTMLElement>, composingFlag: boolean): boolean {
  return composingFlag || event.nativeEvent.isComposing || event.keyCode === 229;
}

export interface InlineProfileNameEditorProps {
  profileId: string;
  name: string;
  disabled?: boolean;
  badge?: ReactNode;
  /** Single-click action (preserves existing roster behavior: open full edit modal). */
  onOpenEdit?: (id: string) => void;
  /** Persists the renamed string; defaults to POST /ui/api/profiles/:id/update. */
  onSaveName?: (id: string, nextName: string) => Promise<void>;
  onSaved?: (id: string, nextName: string) => void;
  onError?: (message: string) => void;
  /** Optional controlled editing flag (pairs with ProfileRosterTable pinned-row tracking). */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

/**
 * Inline environment name editor:
 * - Single click preserves existing open-edit behavior (with double-click de-confliction).
 * - Double click on `.profile-name-text`, pressing `F2`, or clicking the hover pencil opens inline `<input>`.
 * - Skips IME composition (`isComposing || keyCode === 229`), commits on Enter/blur, cancels on Escape.
 */
export function InlineProfileNameEditor({
  profileId,
  name,
  disabled = false,
  badge,
  onOpenEdit,
  onSaveName,
  onSaved,
  onError,
  editing: controlledEditing,
  onEditingChange,
}: InlineProfileNameEditorProps) {
  const { t } = useTranslation();
  const [internalEditing, setInternalEditing] = useState(false);
  const editing = controlledEditing ?? internalEditing;
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayBtnRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const cancelledRef = useRef(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setEditing = (next: boolean) => {
    if (controlledEditing === undefined) setInternalEditing(next);
    onEditingChange?.(next);
  };

  useEffect(() => {
    if (!editing) {
      setDraft(name);
      setError(null);
    }
  }, [name, editing]);

  useEffect(() => {
    if (!editing) return;
    cancelledRef.current = false;
    composingRef.current = false;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [editing]);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    };
  }, []);

  function startEditing() {
    if (disabled || saving) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    cancelledRef.current = true;
    setDraft(name);
    setError(null);
    setEditing(false);
    queueMicrotask(() => displayBtnRef.current?.focus());
  }

  async function commitEditing() {
    if (cancelledRef.current || saving) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      const msg = t("Environment name cannot be empty.");
      setError(msg);
      onError?.(msg);
      setDraft(name);
      setEditing(false);
      return;
    }
    if (trimmed === name.trim() && draft === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (onSaveName) {
        await onSaveName(profileId, trimmed);
      } else {
        const res = await updateProfile(profileId, { name: trimmed });
        if (res?.ok !== true) throw new Error(res?.error || t("Could not rename environment."));
      }
      setEditing(false);
      onSaved?.(profileId, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("Could not rename environment.");
      setError(msg);
      onError?.(msg);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="inline-rename-wrap">
        <input
          ref={inputRef}
          type="text"
          className={`profile-inline-rename-input${error ? " is-error" : ""}`}
          aria-label={t("Rename {profile}", { profile: name })}
          value={draft}
          disabled={saving}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event, composingRef.current)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void commitEditing();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelEditing();
            }
          }}
          onBlur={() => {
            if (!cancelledRef.current) void commitEditing();
          }}
        />
        {error && (
          <span className="inline-editor-error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-name-display">
      <button
        ref={displayBtnRef}
        type="button"
        className="n profile-name-button"
        disabled={disabled}
        aria-label={t("Edit {profile}", { profile: name })}
        onClick={(event) => {
          if (!onOpenEdit) return;
          // Synthetic clicks (detail === 0) run immediately; pointer single-clicks defer briefly
          // so a double-click on `.profile-name-text` triggers inline rename without flashing the modal.
          if (event.detail === 0) {
            onOpenEdit(profileId);
            return;
          }
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            onOpenEdit(profileId);
          }, 210);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          startEditing();
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event, composingRef.current)) return;
          if (event.key === "F2") {
            event.preventDefault();
            event.stopPropagation();
            startEditing();
          }
        }}
      >
        <span className="profile-name-text">{name}</span>
        {badge}
      </button>
      <button
        type="button"
        className="inline-rename-pencil"
        disabled={disabled}
        aria-label={t("Quick rename {profile}", { profile: name })}
        title={t("Rename (F2)")}
        onClick={(event) => {
          event.stopPropagation();
          startEditing();
        }}
      >
        <AppIcon name="edit" className="xs" />
      </button>
    </span>
  );
}

export interface QuickProfileNotesEditorProps {
  profileId: string;
  profileName?: string;
  notes: string;
  disabled?: boolean;
  /** "inline" opens a small dialog from the roster; "panel" edits inside ProfileDetailsPanel. */
  variant?: "inline" | "panel";
  onSaveNotes?: (id: string, nextNotes: string) => Promise<void>;
  onSaved?: (id: string, nextNotes: string) => void;
  onError?: (message: string) => void;
  /** Optional open-state listener so virtualized rows can pin while editing notes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Quick profile notes display and editor (<= 500 chars / 2048 bytes).
 * Supports `Ctrl+Enter` / `Cmd+Enter` save, `Escape` cancel, and IME composition guard.
 */
export function QuickProfileNotesEditor({
  profileId,
  profileName,
  notes,
  disabled = false,
  variant = "inline",
  onSaveNotes,
  onSaved,
  onError,
  onOpenChange,
}: QuickProfileNotesEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const didNotifyOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      didNotifyOpenRef.current = true;
      onOpenChangeRef.current?.(true);
    } else if (didNotifyOpenRef.current) {
      didNotifyOpenRef.current = false;
      onOpenChangeRef.current?.(false);
    }
  }, [open]);
  useEffect(() => () => {
    if (didNotifyOpenRef.current) {
      didNotifyOpenRef.current = false;
      onOpenChangeRef.current?.(false);
    }
  }, []);
  const [draft, setDraft] = useState(notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const editorId = useId();

  useEffect(() => {
    setOpen(false);
    setDraft(notes);
    setError(null);
  }, [profileId]);

  useEffect(() => {
    if (!open) setDraft(notes);
  }, [notes, open]);

  useEffect(() => {
    if (open && !saving) textareaRef.current?.focus({ preventScroll: true });
  }, [open, saving]);

  const charCount = Array.from(draft.replaceAll("\r\n", "\n")).length;
  const overLimit = charCount > MAX_PROFILE_NOTES_CHARACTERS;

  function cancel() {
    if (saving) return;
    setOpen(false);
    setDraft(notes);
    setError(null);
  }

  async function save() {
    if (saving) return;
    let normalized: string;
    try {
      normalized = normalizeProfileNotes(draft);
    } catch (err) {
      const msg =
        err instanceof ProfileNotesValidationError
          ? t(err.message)
          : t("Notes are invalid.");
      setError(msg);
      onError?.(msg);
      return;
    }

    if (normalized === (notes ?? "").trim()) {
      setOpen(false);
      setError(null);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (onSaveNotes) {
        await onSaveNotes(profileId, normalized);
      } else {
        const res = await updateProfile(profileId, { notes: normalized });
        if (res?.ok !== true) throw new Error(res?.error || t("Could not save notes."));
      }
      setOpen(false);
      onSaved?.(profileId, normalized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("Could not save notes.");
      setError(msg);
      onError?.(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposing(event, composingRef.current)) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void save();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  const editorBody = (
    <div className="quick-notes-editor-body">
      <textarea
        ref={textareaRef}
        id={editorId}
        className="quick-notes-textarea"
        rows={variant === "panel" ? 4 : 3}
        value={draft}
        disabled={saving}
        aria-label={t("Notes for {profile}", { profile: profileName || profileId })}
        aria-describedby={error ? `${editorId}-hint ${editorId}-error` : `${editorId}-hint`}
        aria-invalid={overLimit || undefined}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="quick-notes-footer">
        <span id={`${editorId}-hint`} className={`quick-notes-meta${overLimit ? " is-error" : ""}`}>
          {`${charCount} / ${MAX_PROFILE_NOTES_CHARACTERS}`} · {t("Ctrl+Enter to save")}
        </span>
        <div className="quick-notes-actions">
          <button
            type="button"
            className="btn xs ghost"
            disabled={saving}
            onClick={cancel}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn xs primary"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={saving || overLimit}
            onClick={() => void save()}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        </div>
      </div>
      {error && (
        <p id={`${editorId}-error`} className="inline-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  if (variant === "panel") {
    return (
      <div className="quick-notes-panel">
        {open ? (
          editorBody
        ) : (
          <div className="quick-notes-panel-view">
            {notes ? (
              <p className="quick-notes-text">{notes}</p>
            ) : (
              <p className="quick-notes-empty">{t("No notes yet")}</p>
            )}
            <button
              type="button"
              className="btn xs ghost quick-notes-edit-btn"
              disabled={disabled}
              onClick={() => {
                setDraft(notes);
                setError(null);
                setOpen(true);
              }}
            >
              <AppIcon name="edit" className="xs" />
              {t(notes ? "Edit notes" : "Add notes")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="quick-notes-inline">
      <button
        type="button"
        className={`quick-notes-trigger${notes ? " has-notes" : ""}`}
        disabled={disabled}
        title={notes || t("Add notes")}
        aria-label={t(notes ? "Edit notes" : "Add notes")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(notes);
          setError(null);
          setOpen((prev) => !prev);
        }}
      >
        {notes ? <span className="quick-notes-preview">{notes}</span> : <AppIcon name="file" className="sm" />}
      </button>

      <ModalDialog
        open={open}
        onClose={cancel}
        busy={saving}
        portal
        className="quick-notes-dialog"
        ariaLabelledBy={`${editorId}-title`}
      >
        <h2 className="quick-notes-title" id={`${editorId}-title`}><AppIcon name="file" className="sm" />{t("Quick notes")}</h2>
        {editorBody}
      </ModalDialog>
    </div>
  );
}
