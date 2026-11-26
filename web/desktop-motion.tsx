import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "./i18n.tsx";
import "./desktop-motion.css";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export const DESKTOP_MOTION_KEY = "aliasmode.shell.motion";
export const DESKTOP_MOTION_EVENT = "maobu:desktop-motion-change";
export type DesktopMotionPreference = "system" | "reduced" | "full";
export type EffectiveDesktopMotion = "reduced" | "full";
const REDUCED_MEDIA = "(prefers-reduced-motion: reduce)";
const EXIT_MS = 120;

export function validDesktopMotionPreference(value: unknown): value is DesktopMotionPreference {
  return value === "system" || value === "reduced" || value === "full";
}
export function readDesktopMotionPreference(cookieHeader: string, stored: string | null): DesktopMotionPreference {
  const prefix = `${DESKTOP_MOTION_KEY}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      const value = cookie.slice(prefix.length);
      if (validDesktopMotionPreference(value)) return value;
    }
  }
  return validDesktopMotionPreference(stored) ? stored : "system";
}
export function desktopMotionCookie(preference: DesktopMotionPreference): string {
  return `${DESKTOP_MOTION_KEY}=${preference}; Path=/; Max-Age=31536000; SameSite=Strict`;
}
export function resolveDesktopMotion(preference: DesktopMotionPreference, systemReduced: boolean): EffectiveDesktopMotion {
  return systemReduced || preference === "reduced" ? "reduced" : "full";
}
function readPreference(): DesktopMotionPreference {
  let cookies = "", stored: string | null = null;
  try { cookies = document.cookie; } catch { /* Storage can be unavailable. */ }
  try { stored = localStorage.getItem(DESKTOP_MOTION_KEY); } catch { /* Keep the session usable. */ }
  return readDesktopMotionPreference(cookies, stored);
}
function systemReducedMotion(): boolean {
  try { return window.matchMedia(REDUCED_MEDIA).matches; } catch { return false; }
}
export function readEffectiveDesktopMotion(): EffectiveDesktopMotion {
  if (systemReducedMotion()) return "reduced";
  try {
    const applied = document.documentElement.dataset.desktopMotion;
    if (applied === "reduced" || applied === "full") return applied;
  } catch { /* First render also works without a document. */ }
  return resolveDesktopMotion(readPreference(), false);
}

/** Check whether JS-driven animations (WAAPI / FLIP / retargeted indicators) may run. */
export function isMotionAllowed(motionAllowed = true): boolean {
  return motionAllowed && readEffectiveDesktopMotion() === "full";
}

function readEffectiveMotion(): EffectiveDesktopMotion {
  return readEffectiveDesktopMotion();
}

/** Mount once in the shell. The cookie survives the desktop's random HTTP port. */
export function useDesktopMotion() {
  const [preference, setPreferenceState] = useState<DesktopMotionPreference>(readPreference);
  const [systemReduced, setSystemReduced] = useState(systemReducedMotion);
  const effective = resolveDesktopMotion(preference, systemReduced);
  useIsomorphicLayoutEffect(() => {
    const media = window.matchMedia(REDUCED_MEDIA);
    const change = () => setSystemReduced(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.desktopMotion = effective;
    root.dataset.desktopMotionPreference = preference;
    window.dispatchEvent(new Event(DESKTOP_MOTION_EVENT));
  }, [preference, effective]);
  const setPreference = useCallback((choice: DesktopMotionPreference) => {
    if (!validDesktopMotionPreference(choice)) return;
    try { document.cookie = desktopMotionCookie(choice); } catch { /* This session still works. */ }
    try { localStorage.setItem(DESKTOP_MOTION_KEY, choice); } catch { /* The host cookie is a second store. */ }
    setPreferenceState(choice);
  }, []);
  return { preference, effective, systemReduced, setPreference };
}

/** Read the shell's applied mode without mounting another preference owner. */
export function useEffectiveDesktopMotion(): EffectiveDesktopMotion {
  const [effective, setEffective] = useState(readEffectiveMotion);
  useIsomorphicLayoutEffect(() => {
    const media = window.matchMedia(REDUCED_MEDIA);
    const change = () => setEffective(media.matches ? "reduced" : readEffectiveMotion());
    change();
    window.addEventListener(DESKTOP_MOTION_EVENT, change);
    media.addEventListener("change", change);
    return () => { window.removeEventListener(DESKTOP_MOTION_EVENT, change); media.removeEventListener("change", change); };
  }, []);
  return effective;
}

export function DesktopMotionSettings({ value, onChange }: {
  value: DesktopMotionPreference;
  onChange: (preference: DesktopMotionPreference) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const options = [
    { key: "system", label: "Follow system" },
    { key: "reduced", label: "Reduced motion" },
    { key: "full", label: "Full motion" },
  ] as const;
  return (
    <div className="desktop-motion-settings">
      <div className="desktop-motion-copy">
        <span id={`${id}-label`}>{t("Interface motion")}</span>
        <p id={`${id}-note`}>{t("System reduced motion takes priority.")}</p>
      </div>
      <div className="desktop-motion-options" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-note`}>
        {options.map(option => (
          <label key={option.key} className={`desktop-motion-option${value === option.key ? " selected" : ""}`}>
            <input className="sr-only" type="radio" name={`${id}-motion`} value={option.key} checked={value === option.key} onChange={() => onChange(option.key)} />
            <span>{t(option.label)}</span>
          </label>
        ))}
      </div>
      <select className="select settings-compact-choice" aria-labelledby={`${id}-label`} aria-describedby={`${id}-note`} value={value}
        onChange={event => { const next = event.target.value; if (validDesktopMotionPreference(next)) onChange(next); }}>
        {options.map(option => <option key={option.key} value={option.key}>{t(option.label)}</option>)}
      </select>
    </div>
  );
}

export interface MotionPresenceProps {
  present: boolean;
  kind?: "dialog" | "popover" | "panel";
  /** Skip the 120ms exit retention when a surface has no active CSS exit host. */
  immediateExit?: boolean;
  children: ReactNode | (() => ReactNode);
}
/**
 * Keep only the visual exit for 120ms. Parent open-state focus traps and async
 * ownership still close immediately. Exiting content is inert and hidden from
 * assistive technology, and captured events cannot submit retained controls.
 * For portals, mount this component inside the portal, around its surface.
 */
export function MotionPresence({ present, kind = "dialog", immediateExit = false, children }: MotionPresenceProps) {
  const effective = useEffectiveDesktopMotion();
  const [retained, setRetained] = useState(present);
  const [phase, setPhase] = useState<"entering" | "present" | "exiting">(present ? "entering" : "exiting");
  const host = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const content = useRef<ReactNode>(null);
  if (present) content.current = typeof children === "function" ? children() : children;
  useIsomorphicLayoutEffect(() => {
    let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    if (present) {
      const newSurface = !visible.current;
      visible.current = true; setRetained(true);
      if (effective === "reduced" || !newSurface) setPhase("present");
      else {
        setPhase("entering");
        // Resolve the initial transparent pose before the next style change.
        host.current?.firstElementChild?.getBoundingClientRect();
        frame = window.requestAnimationFrame(() => setPhase("present"));
      }
    } else if (visible.current) {
      setPhase("exiting");
      if (effective === "reduced" || immediateExit) { visible.current = false; setRetained(false); content.current = null; }
      else timer = setTimeout(() => { visible.current = false; setRetained(false); content.current = null; }, EXIT_MS);
    }
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); if (timer !== undefined) clearTimeout(timer); };
  }, [present, effective, immediateExit]);
  if (!present && !retained) return null;
  const block = (event: { preventDefault(): void; stopPropagation(): void }) => { if (!present) { event.preventDefault(); event.stopPropagation(); } };
  return <div ref={host} className="desktop-motion-presence" data-motion-kind={kind} data-motion-phase={phase}
    aria-hidden={!present || undefined} inert={!present || undefined}
    onClickCapture={block} onSubmitCapture={block} onPointerDownCapture={block} onKeyDownCapture={block}>{content.current}</div>;
}

/** Animate a replaced panel without keying or remounting its form controls. */
export function usePanelMotion<T extends HTMLElement>(key: string, enabled = true, target?: RefObject<T | null>) {
  const ownRef = useRef<T>(null), previous = useRef(key);
  const ref = target ?? ownRef;
  const effective = useEffectiveDesktopMotion();
  useIsomorphicLayoutEffect(() => {
    const changed = key !== previous.current;
    previous.current = key;
    if (!enabled || !changed || effective === "reduced" || !ref.current?.animate) return;
    const animation = ref.current.animate([{ opacity: .35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.22,.72,.25,1)" });
    animation.id = "desktop-panel-enter";
    // Cancellation is expected on rapid switches or when reduced motion turns
    // on. Observing finished also prevents its AbortError from escaping in hosts.
    void animation.finished?.catch(() => {});
    return () => animation.cancel();
  }, [key, enabled, effective, ref]);
  return ref;
}
