import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./profile-editor-layout.css";

export interface ProfileEditorSectionLink {
  /** Stable within this editor, e.g. basic, proxy, account, fingerprint, extensions. */
  id: string;
  label: ReactNode;
}

export interface ProfileEditorLayoutProps {
  label: string;
  sections: readonly ProfileEditorSectionLink[];
  children: ReactNode;
  /** Disable navigation until asynchronous detail fields are mounted. Never moves focus on load. */
  ready?: boolean;
  /** Reset the current section when the parent starts another editing session. */
  sessionKey?: string | number | null;
  scrollBehavior?: ScrollBehavior;
  className?: string;
}

interface SectionContextValue {
  sectionId: (id: string) => string;
  label: (id: string) => ReactNode;
}
const SectionContext = createContext<SectionContextValue | null>(null);

function openAncestorDetails(target: HTMLElement) {
  for (let node = target.parentElement; node; node = node.parentElement) {
    if (node.tagName === "DETAILS") (node as HTMLDetailsElement).open = true;
  }
}

/** For validation/inspection links owned by the parent. Opens disclosures before focusing. */
export function revealProfileEditorTarget(target: HTMLElement | null | undefined, behavior: ScrollBehavior = "auto"): boolean {
  if (!target?.isConnected) return false;
  openAncestorDetails(target);
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ behavior, block: "nearest", inline: "nearest" });
  return target.ownerDocument.activeElement === target;
}

function scrollContainer(root: HTMLElement): HTMLElement | null {
  const view = root.ownerDocument.defaultView;
  for (let node = root.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(view?.getComputedStyle(node).overflowY ?? "")) return node;
  }
  return null;
}

/**
 * A navigation index over one continuous form, not tabs: no section is hidden or
 * unmounted. Field values, validation, drafts, submit and close stay with the parent.
 * Place this inside the existing scrollable modal body; keep the footer outside it.
 */
export function ProfileEditorLayout({ label, sections, children, ready = true, sessionKey, scrollBehavior = "auto", className = "" }: ProfileEditorLayoutProps) {
  const instanceId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(sections[0]?.id ?? "");
  const invalidQueued = useRef(false);
  const focusedSectionIntent = useRef<string | null>(null);
  const sectionIds = JSON.stringify(sections.map(section => section.id));
  const sectionId = (id: string) => `${instanceId}-section-${encodeURIComponent(id)}`;
  const activeId = sections.some(section => section.id === active) ? active : sections[0]?.id;

  useLayoutEffect(() => {
    setActive(sections[0]?.id ?? "");
    invalidQueued.current = false;
    focusedSectionIntent.current = null;
  }, [sessionKey]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !ready) return;
    const container = scrollContainer(root);
    const eventTarget = container ?? root.ownerDocument.defaultView;
    let frame: number | undefined;
    const view = root.ownerDocument.defaultView;
    const updateFromScroll = () => {
      frame = undefined;
      // scrollIntoView can stop at the bottom before the requested heading
      // reaches the top. Keep an explicit navigation/field focus authoritative
      // until the user chooses to scroll, including already queued frames.
      if (focusedSectionIntent.current && sections.some(section => section.id === focusedSectionIntent.current)) return;
      const top = container?.getBoundingClientRect().top ?? 0;
      const candidates = [...root.querySelectorAll<HTMLElement>("[data-profile-editor-section]")]
        .filter(node => sections.some(section => section.id === node.dataset.profileEditorSection));
      const meaningful = candidates.filter(node => node.getBoundingClientRect().height > 0);
      if (!meaningful.length) return;
      let current = meaningful[0]!;
      for (const node of meaningful) {
        if (node.getBoundingClientRect().top > top + 32) break;
        current = node;
      }
      // A short final section cannot always reach the top of the scrollport.
      if (container && container.clientHeight > 0 && container.scrollHeight > container.clientHeight
        && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) current = meaningful.at(-1)!;
      setActive(current.dataset.profileEditorSection ?? "");
    };
    const onScroll = () => {
      if (frame !== undefined || !view) return;
      frame = view.requestAnimationFrame(updateFromScroll);
    };
    const onManualScroll = () => { focusedSectionIntent.current = null; };
    const onScrollbarPointer = (event: Event) => {
      // Scrollbar presses target the scrollport itself, rather than a field or
      // navigation control inside it. A drag must restore ordinary scrollspy.
      if (event.target === container || !container && (event.target === root.ownerDocument.body || event.target === root.ownerDocument.documentElement)) onManualScroll();
    };
    const onScrollKey = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.defaultPrevented || key.isComposing || key.altKey || key.metaKey
        || !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key.key)) return;
      const target = key.target as HTMLElement | null;
      // These keys edit values/carets or operate a widget instead of scrolling
      // the editor. A button's Space activates it and is not a scroll request.
      if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]')
        || key.key === " " && target?.closest?.('button, a[href], summary, [role="button"], [role="checkbox"], [role="radio"]')) return;
      onManualScroll();
    };
    eventTarget?.addEventListener("scroll", onScroll, { passive: true });
    eventTarget?.addEventListener("wheel", onManualScroll, { passive: true });
    eventTarget?.addEventListener("touchmove", onManualScroll, { passive: true });
    eventTarget?.addEventListener("pointerdown", onScrollbarPointer, { capture: true, passive: true });
    eventTarget?.addEventListener("keydown", onScrollKey);
    return () => {
      eventTarget?.removeEventListener("scroll", onScroll);
      eventTarget?.removeEventListener("wheel", onManualScroll);
      eventTarget?.removeEventListener("touchmove", onManualScroll);
      eventTarget?.removeEventListener("pointerdown", onScrollbarPointer, true);
      eventTarget?.removeEventListener("keydown", onScrollKey);
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
    };
  }, [ready, sectionIds, sessionKey]);

  const markTarget = (target: HTMLElement) => {
    const section = target.closest<HTMLElement>("[data-profile-editor-section]");
    if (section && rootRef.current?.contains(section)) {
      focusedSectionIntent.current = section.dataset.profileEditorSection ?? null;
      setActive(section.dataset.profileEditorSection ?? "");
    }
  };
  const navigate = (id: string) => {
    if (!ready) return;
    const section = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-profile-editor-section]") ?? [])]
      .find(node => node.dataset.profileEditorSection === id);
    if (!section) return;
    const heading = section.querySelector<HTMLElement>(".profile-editor-section-title");
    focusedSectionIntent.current = id;
    setActive(id);
    heading?.focus({ preventScroll: true });
    section.scrollIntoView?.({ behavior: scrollBehavior, block: "start", inline: "nearest" });
  };

  return <SectionContext.Provider value={{ sectionId, label: id => sections.find(section => section.id === id)?.label }}>
    <div className={`profile-editor-layout${className ? ` ${className}` : ""}`} ref={rootRef} aria-busy={!ready || undefined}
      onFocusCapture={event => markTarget(event.target)}
      onInvalidCapture={event => {
        const target = event.target as HTMLElement;
        openAncestorDetails(target);
        // reportValidity can emit one invalid event per field; preserve its first
        // problem rather than moving focus through every invalid input in a turn.
        if (invalidQueued.current) return;
        invalidQueued.current = true;
        queueMicrotask(() => {
          invalidQueued.current = false;
          if (!rootRef.current?.contains(target)) return;
          markTarget(target);
          revealProfileEditorTarget(target);
        });
      }}>
      <div className="profile-editor-layout-grid">
        <nav className="profile-editor-section-nav" aria-label={label}>
          {sections.map((section, index) => <button key={section.id} type="button" className="profile-editor-section-link"
            disabled={!ready} aria-current={activeId === section.id ? "location" : undefined} aria-controls={sectionId(section.id)}
            onClick={() => navigate(section.id)}>
            <span className="profile-editor-section-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <span>{section.label}</span>
          </button>)}
        </nav>
        <div className="profile-editor-sections">{children}</div>
      </div>
    </div>
  </SectionContext.Provider>;
}

export interface ProfileEditorSectionProps {
  sectionId: string;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ProfileEditorSection({ sectionId: id, title, description, children, className = "" }: ProfileEditorSectionProps) {
  const context = useContext(SectionContext);
  const fallbackId = useId();
  const domId = context?.sectionId(id) ?? `${fallbackId}-section`;
  return <section id={domId} data-profile-editor-section={id} className={`profile-editor-section${className ? ` ${className}` : ""}`} aria-labelledby={`${domId}-title`}>
    <header className="profile-editor-section-heading">
      <h3 id={`${domId}-title`} className="profile-editor-section-title" tabIndex={-1}>{title ?? context?.label(id)}</h3>
      {description && <p className="profile-editor-section-description">{description}</p>}
    </header>
    <div className="profile-editor-section-fields">{children}</div>
  </section>;
}
