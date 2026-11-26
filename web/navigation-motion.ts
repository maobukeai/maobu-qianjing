import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  try {
    if (typeof document !== "undefined" && document.documentElement.dataset.desktopMotion === "reduced") {
      return true;
    }
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false;
  } catch {
    return false;
  }
}

export type SlidingIndicatorAxis = "horizontal" | "vertical";

export interface UseSlidingIndicatorOptions {
  /** Reactive key for the active tab/pill/nav item; triggers measurement on change. */
  activeKey: string | number | null | undefined;
  /** Selector matching the active item inside containerRef. */
  activeSelector?: string;
  /** Selector matching the indicator element inside containerRef when indicatorRef is not attached. */
  indicatorSelector?: string;
  /** Travel axis: "horizontal" for tabs/status pills, "vertical" for sidebar rails. */
  axis?: SlidingIndicatorAxis;
  /** Delay measurement until the host surface is mounted and visible. */
  ready?: boolean;
  /** Disable animated transitions when reduced motion or explicit opt-out is active. */
  motionAllowed?: boolean;
  /** Optional fixed indicator length along the travel axis (centers within the active item). */
  fixedSize?: number;
}

export interface UseSlidingIndicatorResult<
  C extends HTMLElement = HTMLElement,
  I extends HTMLElement = HTMLSpanElement,
> {
  containerRef: RefObject<C | null>;
  indicatorRef: RefObject<I | null>;
  update: () => void;
}

const DEFAULT_ACTIVE_SELECTOR = '[aria-selected="true"], [aria-current="page"], [aria-pressed="true"], .active';
const DEFAULT_INDICATOR_SELECTOR = ".sliding-indicator";

/**
 * GPU-composited sliding indicator for tabs, status filter pills, and navigation rails.
 * Animates exclusively via `transform: translate3d(...) scaleX/Y(...)` with retargetable
 * CSS spring deceleration (`220ms cubic-bezier(0.22, 1, 0.36, 1)`) and zero layout reflow.
 */
export function useSlidingIndicator<
  C extends HTMLElement = HTMLElement,
  I extends HTMLElement = HTMLSpanElement,
>(options: UseSlidingIndicatorOptions): UseSlidingIndicatorResult<C, I> {
  const {
    activeKey,
    activeSelector = DEFAULT_ACTIVE_SELECTOR,
    indicatorSelector = DEFAULT_INDICATOR_SELECTOR,
    axis = "horizontal",
    ready = true,
    motionAllowed = true,
    fixedSize,
  } = options;

  const containerRef = useRef<C>(null);
  const indicatorRef = useRef<I>(null);
  const lastTransformRef = useRef<string | null>(null);

  const place = useCallback((forceInstant = false) => {
    const container = containerRef.current;
    if (!ready || !container) return;
    const indicator = indicatorRef.current ?? container.querySelector<HTMLElement>(indicatorSelector);
    if (!indicator) return;
    const active = container.querySelector<HTMLElement>(activeSelector);
    if (!active) {
      lastTransformRef.current = null;
      container.removeAttribute("data-indicator-visible");
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const appearing = !container.hasAttribute("data-indicator-visible");
    const instant = forceInstant || appearing || !motionAllowed || prefersReducedMotion();

    let transform: string;
    if (axis === "vertical") {
      const top = activeRect.top - containerRect.top + container.scrollTop;
      if (fixedSize !== undefined) {
        const offset = top + (activeRect.height - fixedSize) / 2;
        transform = `translate3d(0, ${offset}px, 0)`;
      } else {
        const base = indicator.offsetHeight || 1;
        const scale = activeRect.height > 0 ? activeRect.height / base : 0;
        indicator.style.transformOrigin = "center top";
        transform = `translate3d(0, ${top}px, 0) scaleY(${scale})`;
      }
    } else {
      const left = activeRect.left - containerRect.left + container.scrollLeft;
      if (fixedSize !== undefined) {
        const offset = left + (activeRect.width - fixedSize) / 2;
        transform = `translate3d(${offset}px, 0, 0)`;
      } else {
        const base = indicator.offsetWidth || 1;
        const scale = activeRect.width > 0 ? activeRect.width / base : 0;
        indicator.style.transformOrigin = "left center";
        transform = `translate3d(${left}px, 0, 0) scaleX(${scale})`;
      }
    }

    // Ignore redundant ResizeObserver callbacks when geometry hasn't moved so an active glide isn't killed.
    if (forceInstant && !appearing && transform === lastTransformRef.current) {
      return;
    }
    lastTransformRef.current = transform;

    if (instant) {
      indicator.style.transition = "none";
    } else {
      indicator.style.removeProperty("transition");
    }
    indicator.style.transform = transform;
    container.setAttribute("data-indicator-visible", "");

    if (instant) {
      // Flush the initial or reduced-motion pose so future retargeting animates from here.
      indicator.getBoundingClientRect();
      if (motionAllowed && !prefersReducedMotion()) {
        indicator.style.removeProperty("transition");
      }
    }
  }, [activeSelector, indicatorSelector, axis, ready, motionAllowed, fixedSize]);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;
    place();
    const onResize = () => place(true);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    resize?.observe(container);
    const active = container.querySelector<HTMLElement>(activeSelector);
    if (active) resize?.observe(active);
    window.addEventListener("resize", onResize);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [activeKey, activeSelector, ready, place]);

  return { containerRef, indicatorRef, update: place };
}

// Match the visible order, including the workspace entry above the navigation.
const VIEW_ORDER = ["workspaces", "profiles", "inspection", "proxies", "scripts", "assistant", "extensions", "trash", "settings"] as const;
export type WorkspaceView = (typeof VIEW_ORDER)[number];

/** Move one rail marker and animate the incoming page without remounting it. */
export function useNavigationMotion(view: WorkspaceView, ready: boolean, motionAllowed = true) {
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const pageAnimation = useRef<Animation | null>(null);

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    if (!ready || !nav) return;
    const rail = nav.closest<HTMLElement>(".sidebar") ?? nav;
    const onKeyDown = (event: KeyboardEvent) => {
      const { key, target } = event;
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Home" && key !== "End")
        || !(target instanceof HTMLElement) || !target.matches("button.navitem")) return;
      const buttons = [...rail.querySelectorAll<HTMLButtonElement>("button.navitem:not(:disabled)")]
        .filter(button => !button.closest("[hidden], [inert], [aria-hidden='true']"));
      const index = buttons.indexOf(target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1
        : (index + (key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    rail.addEventListener("keydown", onKeyDown);
    return () => rail.removeEventListener("keydown", onKeyDown);
  }, [ready]);

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const marker = nav?.querySelector<HTMLElement>(".rail-active-marker");
    if (!ready || !nav || !marker) return;
    const active = nav.querySelector<HTMLElement>('.navitem[aria-current="page"]');
    const place = () => {
      if (!active) { nav.removeAttribute("data-marker-visible"); return; }
      const button = active.getBoundingClientRect();
      const y = button.top - nav.getBoundingClientRect().top + nav.scrollTop + (button.height - 18) / 2;
      const appearing = !nav.hasAttribute("data-marker-visible");
      const instant = appearing || !motionAllowed || prefersReducedMotion();
      // Initial layout, or returning from a utility page, must not sweep from
      // the top of the rail. Subsequent selections use a retargetable transition.
      if (instant) marker.style.transition = "none";
      marker.style.transform = `translateY(${y}px)`;
      nav.setAttribute("data-marker-visible", "");
      if (instant) {
        marker.getBoundingClientRect();
        if (motionAllowed && !prefersReducedMotion()) {
          marker.style.removeProperty("transition");
        }
      }
    };
    place();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    // Group labels and translated text can change row positions independently
    // of the sidebar width. Observe the actual groups as well as the rail.
    resize?.observe(nav);
    for (const group of nav.querySelectorAll(".rail-nav-group")) resize?.observe(group);
    window.addEventListener("resize", place);
    return () => { resize?.disconnect(); window.removeEventListener("resize", place); };
  }, [view, ready, motionAllowed]);

  useIsomorphicLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (!ready || !motionAllowed || view === previous) return;
    const page = contentRef.current?.querySelector<HTMLElement>(":scope > .workspace:not([hidden])");
    const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
    if (!page?.animate || reduced.matches || prefersReducedMotion()) return;
    const direction = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(previous) ? 1 : -1;
    const animation = page.animate([
      { opacity: 0.72, transform: `translateX(${direction * 8}px)` },
      { opacity: 1, transform: "none" },
    ], { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    animation.id = "workspace-page-enter";
    // Rapid navigation intentionally cancels an unfinished animation. Its
    // finished promise rejects on cancellation; that is not a page failure.
    void animation.finished?.catch(() => {});
    pageAnimation.current = animation;
    // No fill mode: completed motion leaves no transformed containing block
    // around page controls or sticky content. Rapid navigation cancels cleanly.
    return () => { animation.cancel(); pageAnimation.current = null; };
  }, [view, ready, motionAllowed]);

  useIsomorphicLayoutEffect(() => {
    const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
    const change = () => { if (reduced.matches) pageAnimation.current?.cancel(); };
    reduced.addEventListener("change", change);
    return () => reduced.removeEventListener("change", change);
  }, []);

  return { navRef, contentRef };
}
