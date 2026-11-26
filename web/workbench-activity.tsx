import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { MotionPresence } from "./desktop-motion.tsx";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./workbench-activity.css";

export interface WorkbenchActivityItem {
  id: string;
  title: string;
  description?: string;
  state: "running" | "attention" | "complete";
  progress?: { done: number; total: number };
  onView: () => void;
}
export interface WorkbenchActivityProps { items: readonly WorkbenchActivityItem[]; }
const ORDER = { running: 0, attention: 1, complete: 2 } as const;
const STATE_LABEL = { running: "Running", attention: "Needs attention", complete: "Complete" } as const;
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function visible(node: HTMLElement): boolean {
  if (!node.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const view = node.ownerDocument.defaultView;
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

/** A view of existing task owners. This component never starts, polls or dismisses a task. */
export function WorkbenchActivity({ items }: WorkbenchActivityProps) {
  const { t, language } = useTranslation(), id = useId(), titleId = `${id}-title`, summaryId = `${id}-summary`;
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 480 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const latestItems = useRef(items), openRef = useRef(false), ownsFocus = useRef(false);
  const fallback = useRef<HTMLElement | null>(null), focusedItem = useRef<{ id: string; index: number } | null>(null);
  const ordered = [...items].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const present = open && items.length > 0;
  latestItems.current = items; openRef.current = present;
  const running = items.filter(item => item.state === "running").length;
  const attention = items.filter(item => item.state === "attention").length;
  const complete = items.length - running - attention;
  const hasSummary = items.length > 1;

  function rememberFallback() {
    const entry = trigger.current;
    if (!entry) return;
    const all = [...entry.ownerDocument.querySelectorAll<HTMLElement>(FOCUSABLE)], index = all.indexOf(entry);
    fallback.current = [...all.slice(index + 1), ...all.slice(0, index).reverse()]
      .find(node => !panel.current?.contains(node) && visible(node)) ?? null;
  }
  function close(restore = false) {
    openRef.current = false; setOpen(false); focusedItem.current = null;
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }
  function toggle() {
    if (openRef.current) close(true);
    else if (latestItems.current.length) { rememberFallback(); openRef.current = true; setOpen(true); }
  }
  function viewTask(taskId: string) {
    if (!openRef.current) return;
    const item = latestItems.current.find(candidate => candidate.id === taskId);
    if (!item) return;
    // A destination can immediately focus another surface. Remove our listeners first.
    flushSync(() => close(true));
    item.onView();
  }
  function viewButtons() { return [...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-activity-view]") ?? [])]; }

  useLayoutEffect(() => {
    if (!present || !panel.current || !trigger.current) return;
    const node = panel.current, entry = trigger.current, document = entry.ownerDocument, view = document.defaultView!;
    function place() {
      const anchor = entry.getBoundingClientRect(), margin = view.innerWidth <= 700 ? 8 : 12;
      const width = Math.min(360, Math.max(0, view.innerWidth - margin * 2));
      const roomBelow = view.innerHeight - anchor.bottom - margin - 8, roomAbove = anchor.top - margin - 8;
      const above = roomBelow < 200 && roomAbove > roomBelow;
      const maxHeight = Math.max(80, Math.min(480, above ? roomAbove : roomBelow));
      const height = Math.min(node.scrollHeight || 480, maxHeight);
      const next = { top: Math.max(margin, above ? anchor.top - height - 8 : anchor.bottom + 8), left: Math.max(margin, Math.min(anchor.right - width, view.innerWidth - width - margin)), maxHeight };
      setPosition(old => old.top === next.top && old.left === next.left && old.maxHeight === next.maxHeight ? old : next);
    }
    rememberFallback(); place();
    (viewButtons()[0] ?? node.querySelector<HTMLButtonElement>("button") ?? node).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(node.contains(document.activeElement) || entry === document.activeElement);
    };
    const outside = (event: PointerEvent) => { if (!node.contains(event.target as Node) && !entry.contains(event.target as Node)) close(); };
    const focus = (event: FocusEvent) => {
      if (!node.contains(event.target as Node) && !entry.contains(event.target as Node)) { ownsFocus.current = false; close(); }
    };
    const resize = () => place();
    document.addEventListener("keydown", key, true); document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focus);
    view.addEventListener("resize", resize); view.addEventListener("scroll", resize, true);
    return () => {
      document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focus);
      view.removeEventListener("resize", resize); view.removeEventListener("scroll", resize, true);
      if (openRef.current && node.contains(document.activeElement) && fallback.current && visible(fallback.current)) fallback.current.focus({ preventScroll: true });
    };
  }, [present]);

  useLayoutEffect(() => {
    const document = trigger.current?.ownerDocument ?? panel.current?.ownerDocument ?? fallback.current?.ownerDocument;
    if (!items.length) {
      openRef.current = false; if (open) setOpen(false);
      if (ownsFocus.current && document && (document.activeElement === document.body || panel.current?.contains(document.activeElement))) {
        if (fallback.current && visible(fallback.current)) fallback.current.focus({ preventScroll: true });
      }
      ownsFocus.current = false; focusedItem.current = null; return;
    }
    const previous = focusedItem.current;
    if (!present || !previous || items.some(item => item.id === previous.id)) return;
    if (document?.activeElement === document?.body || panel.current?.contains(document?.activeElement ?? null)) {
      const buttons = viewButtons(); (buttons[Math.min(previous.index, buttons.length - 1)] ?? panel.current?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    }
  }, [items, present]);

  return <>
    {items.length > 0 && <button type="button" className="workbench-activity-trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={present} aria-controls={present ? id : undefined} aria-label={t("Background activity, {count} tasks", { count: items.length })} title={t("Background activity")} onClick={toggle} onFocus={() => { ownsFocus.current = true; rememberFallback(); }} onBlur={event => { if (event.relatedTarget && !panel.current?.contains(event.relatedTarget as Node)) ownsFocus.current = false; }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); if (!openRef.current) toggle(); else viewButtons()[0]?.focus(); } }}>
      <AppIcon name="activity" />
      <span className="workbench-activity-copy">{t("Activity")}</span>
      <span className="workbench-activity-count">{items.length.toLocaleString(language)}</span>
      {running > 0 && <span className="workbench-activity-running" aria-hidden="true" />}
    </button>}
    {typeof document !== "undefined" && createPortal(<MotionPresence present={present} kind="popover">{() => <section className="workbench-activity-popover" id={id} ref={panel} role="dialog" aria-labelledby={titleId} aria-describedby={hasSummary ? summaryId : undefined} tabIndex={-1} style={position} onFocusCapture={event => {
      ownsFocus.current = true;
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-activity-view]");
      focusedItem.current = target ? { id: target.dataset.activityView!, index: viewButtons().indexOf(target) } : null;
    }} onKeyDown={event => {
      if (!event.target || !(event.target as HTMLElement).closest("[data-activity-view]") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const buttons = viewButtons(), index = buttons.indexOf(event.target as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <header>
        <h2 id={titleId}>{t("Background activity")}</h2>
        <button type="button" className="iconbtn" aria-label={t("Close activity")} onClick={() => close(true)}><AppIcon name="close" className="sm" /></button>
      </header>
      {hasSummary && <div className="workbench-activity-summary" id={summaryId}>
        {running > 0 && <span data-state="running">{t("{count} running", { count: running.toLocaleString(language) })}</span>}
        {attention > 0 && <span data-state="attention">{t("{count} need attention", { count: attention.toLocaleString(language) })}</span>}
        {complete > 0 && <span>{t("{count} complete", { count: complete.toLocaleString(language) })}</span>}
      </div>}
      <ul className="workbench-activity-list">{ordered.map(item => {
        const progress = item.progress && Number.isFinite(item.progress.done) && Number.isFinite(item.progress.total) && item.progress.done >= 0 && item.progress.total > 0 ? item.progress : null;
        return <li key={item.id} className={`workbench-activity-item is-${item.state}`}>
          <div className="workbench-activity-item-main">
            <h3>{item.title}</h3>
            <div className="workbench-activity-meta">
              <span className="workbench-activity-state">{t(STATE_LABEL[item.state])}</span>
              {item.description && <span className="workbench-activity-description">{item.description}</span>}
            </div>
            {progress && <div className="workbench-activity-progress">
              <progress max={progress.total} value={Math.min(progress.done, progress.total)} aria-label={t("Progress for {task}", { task: item.title })} />
              <small>{t("{done} of {total}", { done: progress.done.toLocaleString(language), total: progress.total.toLocaleString(language) })}</small>
            </div>}
          </div>
          <button type="button" className="iconbtn workbench-activity-view" data-activity-view={item.id} aria-label={t("View {task}", { task: item.title })} onClick={() => viewTask(item.id)}>
            <AppIcon name="chevronRight" className="sm" />
          </button>
        </li>;
      })}</ul>
    </section>}</MotionPresence>, document.body)}
  </>;
}
