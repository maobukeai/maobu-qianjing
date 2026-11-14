import { useLayoutEffect, useRef } from "react";

// Match the visible order, including the workspace entry above the navigation.
const VIEW_ORDER = ["workspaces", "profiles", "inspection", "proxies", "scripts", "assistant", "extensions", "trash", "settings"] as const;
export type WorkspaceView = (typeof VIEW_ORDER)[number];

/** Move one rail marker and animate the incoming page without remounting it. */
export function useNavigationMotion(view: WorkspaceView, ready: boolean, motionAllowed = true) {
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const pageAnimation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    const nav = navRef.current;
    const marker = nav?.querySelector<HTMLElement>(".rail-active-marker");
    if (!ready || !nav || !marker) return;
    const active = nav.querySelector<HTMLElement>('.navitem[aria-current="page"]');
    const place = () => {
      if (!active) { nav.removeAttribute("data-marker-visible"); return; }
      const button = active.getBoundingClientRect();
      const y = button.top - nav.getBoundingClientRect().top + nav.scrollTop + (button.height - 18) / 2;
      const appearing = !nav.hasAttribute("data-marker-visible");
      // Initial layout, or returning from a utility page, must not sweep from
      // the top of the rail. Subsequent selections use a retargetable transition.
      if (appearing) marker.style.transition = "none";
      marker.style.transform = `translateY(${y}px)`;
      nav.setAttribute("data-marker-visible", "");
      if (appearing) {
        marker.getBoundingClientRect();
        marker.style.removeProperty("transition");
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
  }, [view, ready]);

  useLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (!ready || !motionAllowed || view === previous) return;
    const page = contentRef.current?.querySelector<HTMLElement>(":scope > .workspace:not([hidden])");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!page?.animate || reduced.matches) return;
    const direction = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(previous) ? 1 : -1;
    const animation = page.animate([
      { opacity: 0.72, transform: `translateX(${direction * 8}px)` },
      { opacity: 1, transform: "none" },
    ], { duration: 180, easing: "cubic-bezier(.22,.72,.25,1)" });
    animation.id = "workspace-page-enter";
    // Rapid navigation intentionally cancels an unfinished animation. Its
    // finished promise rejects on cancellation; that is not a page failure.
    void animation.finished?.catch(() => {});
    pageAnimation.current = animation;
    // No fill mode: completed motion leaves no transformed containing block
    // around page controls or sticky content. Rapid navigation cancels cleanly.
    return () => { animation.cancel(); pageAnimation.current = null; };
  }, [view, ready, motionAllowed]);

  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => { if (reduced.matches) pageAnimation.current?.cancel(); };
    reduced.addEventListener("change", change);
    return () => reduced.removeEventListener("change", change);
  }, []);

  return { navRef, contentRef };
}
