import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { DESKTOP_MOTION_EVENT, isMotionAllowed } from "../desktop-motion.tsx";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

/** Cap animated rows per group disclosure toggle to protect 120fps frame budgets. */
export const MAX_FLIP_ROWS = 24;
export const FLIP_DURATION_MS = 180;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const ROW_SELECTOR = "tr[data-profile-id], tr.profile-group-row, tr[data-flip-key]";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface PositionSnapshot {
  capturedAt: number;
  relative: boolean;
  positions: Map<string, number>;
}

function rowFlipKey(row: HTMLElement): string | null {
  if (row.dataset.flipKey) return row.dataset.flipKey;
  if (row.dataset.profileId) return `profile:${row.dataset.profileId}`;
  if (row.classList.contains("profile-group-row")) {
    const groupId =
      row.dataset.groupKey ??
      row.dataset.groupName ??
      row.querySelector<HTMLElement>(".profile-group-toggle")?.getAttribute("aria-controls") ??
      row.querySelector<HTMLElement>(".profile-group-name")?.getAttribute("title") ??
      row.querySelector<HTMLElement>(".profile-group-name")?.textContent?.trim();
    if (groupId) return `group:${groupId}`;
  }
  return null;
}

function isRowInViewport(rowRect: DOMRect, containerRect: DOMRect, containerHeight: number): boolean {
  if (containerHeight <= 0) return true;
  const pad = 48;
  return rowRect.bottom >= containerRect.top - pad && rowRect.top <= containerRect.bottom + pad;
}

function captureRows(container: HTMLElement, relative: boolean): Map<string, number> {
  const positions = new Map<string, number>();
  const containerRect = container.getBoundingClientRect();
  const scrollTop = container.scrollTop;
  const rows = container.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  for (const row of rows) {
    const key = rowFlipKey(row);
    if (!key) continue;
    const rect = row.getBoundingClientRect();
    positions.set(key, relative ? rect.top - containerRect.top + scrollTop : rect.top);
  }
  return positions;
}

/**
 * Lightweight FLIP transition for roster group collapse/expand.
 * Animates at most `MAX_FLIP_ROWS` (24) viewport rows via WAAPI `translateY`,
 * never uses a persistent `fill` mode (preserving `position: sticky` containing
 * blocks), and skips completely when reduced motion is active.
 */
export function useFlipGroup(
  containerRef: RefObject<HTMLElement | null>,
  disclosureKey: string,
  motionAllowed = true,
): void {
  const previousKeyRef = useRef<string>(disclosureKey);
  const previousSnapshotRef = useRef<PositionSnapshot | null>(null);
  const preToggleSnapshotRef = useRef<PositionSnapshot | null>(null);
  const activeAnimationsRef = useRef<Set<Animation>>(new Set());

  const cancelActiveAnimations = () => {
    for (const animation of activeAnimationsRef.current) {
      try {
        animation.cancel();
      } catch {
        /* Animation may already be finished or detached. */
      }
    }
    activeAnimationsRef.current.clear();
  };

  // Capture fresh viewport coordinates right before a user activates a group toggle.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !motionAllowed) return;
    const captureBeforeToggle = (event: Event) => {
      if (!isMotionAllowed(motionAllowed)) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".profile-group-toggle")) return;
      preToggleSnapshotRef.current = {
        capturedAt: Date.now(),
        relative: false,
        positions: captureRows(container, false),
      };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") captureBeforeToggle(event);
    };
    container.addEventListener("pointerdown", captureBeforeToggle, true);
    container.addEventListener("keydown", onKeyDown, true);
    return () => {
      container.removeEventListener("pointerdown", captureBeforeToggle, true);
      container.removeEventListener("keydown", onKeyDown, true);
    };
  }, [containerRef, motionAllowed]);

  // Cancel any in-flight FLIP animation immediately if reduced motion turns on.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMotionChange = () => {
      if (!isMotionAllowed(motionAllowed)) cancelActiveAnimations();
    };
    window.addEventListener(DESKTOP_MOTION_EVENT, onMotionChange);
    let media: MediaQueryList | null = null;
    try {
      if (typeof window.matchMedia === "function") {
        media = window.matchMedia(REDUCED_MOTION_QUERY);
        media.addEventListener("change", onMotionChange);
      }
    } catch {
      media = null;
    }
    return () => {
      window.removeEventListener(DESKTOP_MOTION_EVENT, onMotionChange);
      media?.removeEventListener("change", onMotionChange);
      cancelActiveAnimations();
    };
  }, [motionAllowed]);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    const keyChanged = disclosureKey !== previousKeyRef.current;
    previousKeyRef.current = disclosureKey;

    if (!container) {
      previousSnapshotRef.current = null;
      preToggleSnapshotRef.current = null;
      return;
    }

    const canAnimate = isMotionAllowed(motionAllowed);
    if (!canAnimate) {
      cancelActiveAnimations();
      preToggleSnapshotRef.current = null;
      previousSnapshotRef.current = {
        capturedAt: Date.now(),
        relative: true,
        positions: captureRows(container, true),
      };
      return;
    }

    if (!keyChanged) {
      previousSnapshotRef.current = {
        capturedAt: Date.now(),
        relative: true,
        positions: captureRows(container, true),
      };
      return;
    }

    // Clear stale transforms so final measurements reflect true post-toggle geometry.
    cancelActiveAnimations();

    const preToggle = preToggleSnapshotRef.current;
    preToggleSnapshotRef.current = null;
    const before =
      preToggle && Date.now() - preToggle.capturedAt < 500
        ? preToggle
        : previousSnapshotRef.current;

    const containerRect = container.getBoundingClientRect();
    const containerHeight = container.clientHeight;
    const scrollTop = container.scrollTop;
    const nextPositions = new Map<string, number>();
    const rows = container.querySelectorAll<HTMLElement>(ROW_SELECTOR);
    let animatedCount = 0;

    for (const row of rows) {
      const key = rowFlipKey(row);
      if (!key) continue;
      const rect = row.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top + scrollTop;
      nextPositions.set(key, relativeTop);

      if (!before || animatedCount >= MAX_FLIP_ROWS) continue;
      const oldPos = before.positions.get(key);
      if (oldPos === undefined) continue;

      const currentPos = before.relative ? relativeTop : rect.top;
      const deltaY = oldPos - currentPos;
      if (Math.abs(deltaY) < 1 || Math.abs(deltaY) > 2400) continue;
      if (!isRowInViewport(rect, containerRect, containerHeight)) continue;
      if (typeof row.animate !== "function") continue;

      // Never pass `fill` so finished animations leave zero transform and never
      // create a containing block that breaks `position: sticky` action cells.
      const animation = row.animate(
        [{ transform: `translateY(${deltaY}px)` }, { transform: "none" }],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      );
      animation.id = "roster-group-flip";
      activeAnimationsRef.current.add(animation);
      animatedCount++;
      const cleanup = () => {
        activeAnimationsRef.current.delete(animation);
      };
      void animation.finished?.then(cleanup, cleanup);
    }

    previousSnapshotRef.current = {
      capturedAt: Date.now(),
      relative: true,
      positions: nextPositions,
    };
  }, [containerRef, disclosureKey, motionAllowed]);
}
