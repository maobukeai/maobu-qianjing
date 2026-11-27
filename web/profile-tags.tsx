import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_PROFILE_TAGS, MAX_PROFILE_TAG_CHARACTERS, normalizeProfileTags, ProfileTagsValidationError, splitProfileTagInput } from "../src/profile-tags.ts";
import { useTranslation } from "./i18n.tsx";
import { hasActiveWorkbenchModal } from "./workbench-shortcuts.ts";
import { MotionPresence } from "./desktop-motion.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./profile-tags.css";

export interface ProfileTagsTarget { id: string; name: string; tags: readonly string[] }
export interface ProfileTagsDialogProps {
  target: ProfileTagsTarget | null;
  /** Change this when replacing a target in a different workspace/session. */
  sessionKey?: string;
  /** Resolve true only after the actual tags-only update has been confirmed. */
  onSave: (id: string, tags: string[]) => Promise<boolean>;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((tag, index) => tag === right[index]);
const tagLabel = (tag: string) => tag.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, value => `⟦U+${value.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟧`);

/** A target change unmounts the previous owner; its asynchronous completion cannot close the new editor. */
export function ProfileTagsDialog(props: ProfileTagsDialogProps) {
  const retained = useRef<{ target: ProfileTagsTarget; identity: string; generation: number } | null>(null), wasOpen = useRef(false);
  if (props.target) {
    const identity = JSON.stringify([props.sessionKey ?? "", props.target.id]);
    const current = retained.current;
    retained.current = { target: props.target, identity, generation: !wasOpen.current || current?.identity !== identity ? (current?.generation ?? 0) + 1 : current.generation };
  }
  wasOpen.current = !!props.target;
  if (!retained.current || typeof document === "undefined") return null;
  // Keep only a closed owner for its visual exit; reopening always creates a fresh owner.
  return <ProfileTagsSession key={retained.current.generation} {...props} target={retained.current.target} open={!!props.target} />;
}

function ProfileTagsSession({ target, open, onSave, onClose, returnFocus }: ProfileTagsDialogProps & { target: ProfileTagsTarget; open: boolean }) {
  const { t } = useTranslation();
  // Keep legacy invalid labels visible until the operator explicitly removes or fixes them.
  const [original] = useState(() => [...target.tags]);
  const [tags, setTags] = useState(() => [...target.tags]), [input, setInput] = useState("");
  const [pending, setPending] = useState(false), [failure, setFailure] = useState(false), [notice, setNotice] = useState("");
  const panel = useRef<HTMLDivElement>(null), entry = useRef<HTMLInputElement>(null), chipList = useRef<HTMLUListElement>(null);
  const nextChipFocus = useRef<number | null>(null);
  const mounted = useRef(true), operating = useRef(false), close = useRef(onClose), restore = useRef(returnFocus), active = useRef(open);
  close.current = onClose; restore.current = returnFocus; active.current = open;
  const id = useId(), titleId = `${id}-title`, descriptionId = `${id}-description`, inputId = `${id}-input`, validationId = `${id}-validation`;
  let nextTags: string[] = [], validation = "";
  try { nextTags = normalizeProfileTags([...tags, ...splitProfileTagInput(input)]); }
  catch (error) { validation = error instanceof ProfileTagsValidationError ? error.message : "The tag list could not be validated."; }
  const edited = !same(tags, original) || !!input.trim();
  const changed = edited && !validation && !same(nextTags, original);

  useLayoutEffect(() => {
    if (!open) return;
    mounted.current = true;
    const node = panel.current;
    if (!node) return;
    const document = node.ownerDocument, previous = document.activeElement as HTMLElement | null;
    const controls = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
    entry.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (!operating.current) close.current(); return; }
      if (event.key !== "Tab") return;
      const all = controls(), first = all[0], last = all.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (active === first || active === node || !node.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || active === node || !node.contains(active))) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!node.contains(event.target as Node)) (operating.current ? node : entry.current)?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", key, true); document.addEventListener("focusin", focus);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus);
      const active = document.activeElement;
      const eligible = (item: HTMLElement | null | undefined): item is HTMLElement => !!item?.isConnected && item !== document.body && !item.closest('[hidden], [inert], [aria-hidden="true"]') && !item.matches(":disabled");
      const destination = eligible(previous) ? previous : restore.current?.();
      if (!hasActiveWorkbenchModal(document, node) && eligible(destination) && (active === document.body || node.contains(active))) destination.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => { if (!open) return; if (pending) panel.current?.focus({ preventScroll: true }); else if (failure) entry.current?.focus({ preventScroll: true }); }, [pending, failure, open]);
  useLayoutEffect(() => {
    if (!open || nextChipFocus.current === null) return;
    const next = chipList.current?.querySelectorAll("button")[nextChipFocus.current];
    nextChipFocus.current = null;
    (next ?? entry.current)?.focus();
  }, [open, tags]);

  function add() {
    if (!active.current || operating.current || !input.trim()) return;
    if (validation) { entry.current?.focus(); return; }
    const added = nextTags.length - normalizeProfileTags(tags).length;
    setTags(nextTags); setInput(""); setFailure(false); setNotice(added > 0 ? "Tags added to this draft." : "These tags are already in the list."); entry.current?.focus();
  }
  async function save() {
    if (!active.current || operating.current || validation || !changed) return;
    const payload = [...nextTags];
    operating.current = true; setPending(true); setFailure(false); setNotice(""); setTags(payload); setInput("");
    try {
      const result = await onSave(target.id, [...payload]);
      if (!mounted.current || !active.current) return;
      if (result === true) close.current(); else setFailure(true);
    } catch { if (mounted.current && active.current) setFailure(true); }
    finally { operating.current = false; if (mounted.current && active.current) setPending(false); }
  }
  function cancel() { if (active.current && !operating.current) close.current(); }
  function remove(index: number) {
    if (!active.current || operating.current) return;
    nextChipFocus.current = Math.min(index, tags.length - 2);
    setTags(current => current.filter((_, position) => position !== index));
    setFailure(false);
    setNotice("");
  }
  return createPortal(<MotionPresence present={open}>{() => <div className="profile-tags-backdrop" onPointerDown={event => {
    if (event.currentTarget !== event.target) return;
    if (edited || operating.current) event.preventDefault();
    else cancel();
  }}>
    <div className="profile-tags-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending} tabIndex={-1}>
      <header>
        <div>
          <h2 id={titleId}>{t("Manage tags")}</h2>
          <p id={descriptionId} className="profile-tags-description" title={target.name || target.id}><bdi>{target.name || target.id}</bdi></p>
        </div>
        <button className="iconbtn" type="button" disabled={pending} aria-label={t("Close tag editor")} onClick={cancel}><AppIcon name="close" /></button>
      </header>
      <div className="profile-tags-body">
        <form className="profile-tags-entry" onSubmit={event => { event.preventDefault(); add(); }}>
          <label htmlFor={inputId}>{t("Add tags")}</label>
          <div>
            <input className="input" id={inputId} ref={entry} value={input} disabled={pending} aria-invalid={!!validation || undefined} aria-describedby={`${id}-hint${validation ? ` ${validationId}` : ""}`} placeholder={t("research, priority")} autoComplete="off" onChange={event => { setInput(event.target.value); setFailure(false); setNotice(""); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (["Enter", ",", "，"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); add(); }
            }} />
            <button className="btn" type="submit" disabled={pending || !input.trim()}>{t("Add")}</button>
          </div>
        </form>
        <p className="profile-tags-hint" id={`${id}-hint`}>{t("Enter or comma to add. Up to {length} characters per tag.", { length: MAX_PROFILE_TAG_CHARACTERS })}</p>
        {validation && <p className="profile-tags-error" role="alert" id={validationId}>{t(validation)}</p>}
        {failure && <p className="profile-tags-error" role="alert">{t("Tags could not be saved. Your draft is kept; try saving again.")}</p>}
        {notice && <p className="profile-tags-feedback" role="status">{t(notice)}</p>}
        {pending && <p className="profile-tags-feedback" role="status">{t("Saving tags…")}</p>}
        <div className="profile-tags-list-heading">
          <h3 id={`${id}-list`}>{t("Current tags")}</h3>
          <span>{t("{count} / {limit} tags", { count: tags.length, limit: MAX_PROFILE_TAGS })}</span>
        </div>
        {tags.length ? <ul className="profile-tags-chips" aria-labelledby={`${id}-list`} ref={chipList}>{tags.map((tag, index) => {
          const label = tagLabel(tag) || t("Empty tag");
          return <li key={index}>
            <span>{label}</span>
            <button type="button" disabled={pending} aria-label={t("Remove tag {tag}", { tag: label })} onClick={() => remove(index)}><AppIcon name="close" className="sm" /></button>
          </li>;
        })}</ul> : <p className="profile-tags-empty">{t("No tags yet")}</p>}
      </div>
      <footer><button className="btn ghost" type="button" disabled={pending} onClick={cancel}>{t("Cancel")}</button><button className="btn primary" type="button" disabled={pending || !changed || !!validation} onClick={() => void save()}>{t(pending ? "Saving…" : "Save tags")}</button></footer>
    </div>
  </div>}</MotionPresence>, document.body);
}
