import { useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "./i18n.tsx";
import { parseRosterDensity, type RosterDensity } from "../src/roster-density-state.ts";
import "./roster-density.css";
export { ROSTER_DENSITY_KEY, ROSTER_DENSITY_ROW_HEIGHT, isRosterDensity, parseRosterDensity, type RosterDensity } from "../src/roster-density-state.ts";

export interface RosterDensityControlProps {
  value: RosterDensity;
  onChange: (value: RosterDensity) => void;
  variant?: "toolbar" | "settings";
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}
const options = ["comfortable", "standard", "compact"] as const;
const OPTION_META: Record<RosterDensity, { label: string; path: string }> = {
  comfortable: { label: "Comfortable", path: "M4 4h12M4 10h12M4 16h12" },
  standard: { label: "Standard", path: "M4 5h12M4 10h12M4 15h12" },
  compact: { label: "Compact", path: "M4 6h12M4 10h12M4 14h12" },
};

/** Controlled by the workspace preference owner; this control never writes global storage. */
export function RosterDensityControl({ value, onChange, variant = "toolbar", disabled = false, busy = false, className = "" }: RosterDensityControlProps) {
  const { t } = useTranslation(), descriptionId = useId();
  const label = t("Environment list density");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = parseRosterDensity(value), locked = disabled || busy;
  function choose(next: RosterDensity) { if (!locked && next !== selected) onChange(next); }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
    event.preventDefault();
    if (locked) return;
    const next = key === "Home" ? 0 : key === "End" ? options.length - 1 : (index + (key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
    buttons.current[next]?.focus({ preventScroll: true });
    choose(options[next]!);
  }
  return <div className={`roster-density-control is-${variant}${className ? ` ${className}` : ""}`}>
    <div className="roster-density-copy"><span>{variant === "settings" ? label : t("Density")}</span>{variant === "settings" && <small id={descriptionId}>{t("Adjusts row spacing for this workspace.")}</small>}</div>
    <div className="roster-density-options" role="radiogroup" aria-label={label} aria-describedby={variant === "settings" ? descriptionId : undefined} aria-busy={busy || undefined}>
      {options.map((option, index) => <button key={option} ref={node => { buttons.current[index] = node; }} type="button" role="radio" aria-checked={selected === option} aria-disabled={locked || undefined} disabled={disabled} tabIndex={selected === option ? 0 : -1}
        onClick={() => choose(option)} onKeyDown={event => navigate(event, index)}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d={OPTION_META[option].path} /></svg><span>{t(OPTION_META[option].label)}</span>
      </button>)}
    </div>
    {variant === "settings" && <select className="select settings-compact-choice roster-density-select" aria-label={label}
      aria-describedby={descriptionId} aria-busy={busy || undefined} aria-disabled={locked || undefined} disabled={disabled} value={selected}
      onChange={event => choose(parseRosterDensity(event.target.value))}>
      {options.map(option => <option key={option} value={option}>{t(OPTION_META[option].label)}</option>)}
    </select>}
  </div>;
}
