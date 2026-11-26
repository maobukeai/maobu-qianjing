import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MotionPresence } from "../desktop-motion.tsx";
import { useTranslation } from "../i18n.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import "./action-dock.css";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export interface ActionDockProps {
  selectedCount: number;
  totalFilteredCount: number;
  allFilteredSelected: boolean;
  selectedOutsideFilter: number;
  selectionScope: string;
  deleting?: boolean;
  busy?: boolean;
  blockedMessage?: string | null;
  onSelectAllFiltered: () => void;
  onClear: () => void;
  onStart: () => void;
  onStop: () => void;
  children?: ReactNode;
  moreOpen?: boolean;
  onMoreOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Floating bottom-centered bulk Action Dock for selected environments.
 * Enters with spring physics via `MotionPresence kind="panel"`, floats above
 * the roster without compressing table height, and preserves `.toolbar.active > button`
 * and `.selcount` contracts for existing keyboard/bulk workflows.
 */
export function ActionDock({
  selectedCount,
  totalFilteredCount,
  allFilteredSelected,
  selectedOutsideFilter,
  selectionScope,
  deleting = false,
  busy = false,
  blockedMessage = null,
  onSelectAllFiltered,
  onClear,
  onStart,
  onStop,
  children,
  moreOpen,
  onMoreOpenChange,
  className,
}: ActionDockProps) {
  const { t } = useTranslation();
  const trayId = useId();
  const [uncontrolledMoreOpen, setUncontrolledMoreOpen] = useState(false);
  const selcountRef = useRef<HTMLSpanElement | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const trayToggle = useRef<HTMLButtonElement>(null);
  const focusTrayOnOpen = useRef(false);
  const present = selectedCount > 0;
  const isControlled = moreOpen !== undefined;
  const expanded = isControlled ? moreOpen : uncontrolledMoreOpen;
  const hasSecondaryActions = children !== undefined && children !== null && children !== false;

  const setExpanded = useCallback((next: boolean) => {
    if (!isControlled) setUncontrolledMoreOpen(next);
    onMoreOpenChange?.(next);
  }, [isControlled, onMoreOpenChange]);

  // Collapse the expanded secondary tray whenever the selection empties.
  useEffect(() => {
    if (!present && expanded) {
      setExpanded(false);
    }
  }, [present, expanded, setExpanded]);

  useIsomorphicLayoutEffect(() => {
    if (!present || !expanded || !focusTrayOnOpen.current) return;
    focusTrayOnOpen.current = false;
    trayRef.current?.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)")?.focus();
  }, [present, expanded]);

  // Keep `.selcount` visually identical during the 120ms exit while immediately
  // clearing the live `.selcount` selector when selection count drops to 0.
  useIsomorphicLayoutEffect(() => {
    const node = selcountRef.current;
    if (!node) return;
    if (present) {
      node.classList.add("selcount");
      node.classList.remove("selcount-exiting");
    } else {
      node.classList.remove("selcount");
      node.classList.add("selcount-exiting");
    }
  }, [present]);

  const actionsDisabled = !present || busy || deleting || !!blockedMessage;
  const startTip = blockedMessage ? t(blockedMessage) : t("Open selected browsers");
  const stopTip = blockedMessage ? t(blockedMessage) : t("Close selected browsers");

  return (
    <MotionPresence present={present} kind="panel">
      {() => (
        <div
          className={`action-dock-layer${className ? ` ${className}` : ""}`}
          role="region"
          aria-label={t("Bulk actions")}
        >
          <div className="action-dock" onKeyDown={(event) => {
            if (!expanded || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing ||
              event.keyCode === 229 || trayRef.current?.querySelector(".exportmenu")) return;
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
            trayToggle.current?.focus();
          }}>
            {hasSecondaryActions && (
              <div ref={trayRef} id={trayId} className="bulk-advanced action-dock-tray" hidden={!expanded}>
                {children}
              </div>
            )}

            {totalFilteredCount > 0 && (
              <div className="action-dock-scope" role="status">
                <button
                  type="button"
                  className="btn xs ghost action-dock-scope-btn"
                  disabled={deleting || allFilteredSelected}
                  onClick={onSelectAllFiltered}
                >
                  {allFilteredSelected
                    ? t("All {scope} selected", { scope: selectionScope })
                    : t("Select all {scope}", { scope: selectionScope })}
                </button>
                <span className="muted">
                  {deleting ? t("Moving selected profiles…") : t("Across all pages")}
                </span>
                {!allFilteredSelected && selectedOutsideFilter > 0 && (
                  <span className="muted">
                    {t("This replaces your selection, excluding {count} outside this view.", {
                      count: selectedOutsideFilter,
                    })}
                  </span>
                )}
              </div>
            )}

            <div className="action-dock-bar toolbar active">
              <span ref={selcountRef} className="selcount">
                <AppIcon name="check" className="sm" />
                {t("{count} selected", { count: selectedCount })}
              </span>
              <button
                type="button"
                className="btn ghost"
                aria-label={t("Clear selection")}
                onClick={onClear}
              >
                {t("Clear selection")}
              </button>
              <button
                type="button"
                className="btn primary tip"
                data-tip={startTip}
                disabled={actionsDisabled}
                onClick={onStart}
              >
                <AppIcon name="play" className="sm" />
                {t("Start")}
              </button>
              <button
                type="button"
                className="btn solid-danger tip"
                data-tip={stopTip}
                disabled={actionsDisabled}
                onClick={onStop}
              >
                <AppIcon name="power" className="sm" />
                {t("Stop")}
              </button>
              {hasSecondaryActions && (
                <button
                  ref={trayToggle}
                  type="button"
                  className="btn ghost bulk-tools-toggle"
                  aria-expanded={expanded}
                  aria-controls={trayId}
                  onClick={(event) => {
                    focusTrayOnOpen.current = !expanded && event.detail === 0;
                    setExpanded(!expanded);
                  }}
                >
                  {t(expanded ? "Fewer actions" : "More actions")}
                  <AppIcon name={expanded ? "chevronUp" : "chevronDown"} className="sm" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </MotionPresence>
  );
}
