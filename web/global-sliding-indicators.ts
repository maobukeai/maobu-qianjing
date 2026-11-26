import { useEffect } from "react";
import { DESKTOP_MOTION_EVENT, isMotionAllowed } from "./desktop-motion.tsx";

const GROUP_SELECTOR = [
  '[role="tablist"]',
  '[role="radiogroup"]',
  '[role="group"]',
  ".segmented",
  ".seg",
  ".profile-status-tabs",
  ".wm-theme-options",
  ".roster-view-bar",
  ".cookie-import-filters",
  ".wm-catalog-list",
  ".wm-icon-choices",
  ".model-services-list",
  "[data-sliding-group]",
].join(", ");

const EXCLUDED_CONTAINER_SELECTOR = ".wm-color-choices, .tag-filter-options, .wsync-switches";
const ITEM_SELECTOR = ':scope > button, :scope > [role="tab"], :scope > [role="radio"], :scope > label';
const PILL_CLASS = "global-sliding-pill";

interface IndicatorRecord {
  key: string;
  initialized: boolean;
}

function isHiddenElement(el: HTMLElement): boolean {
  return el.hidden || el.closest("[hidden], [inert], [aria-hidden='true']") !== null;
}

function detectAxis(items: HTMLElement[], scaleX = 1, scaleY = 1): "horizontal" | "vertical" {
  if (items.length < 2) return "horizontal";
  const a = items[0]!.getBoundingClientRect();
  const b = items[1]!.getBoundingClientRect();
  return Math.abs(b.top - a.top) / scaleY > Math.abs(b.left - a.left) / scaleX ? "vertical" : "horizontal";
}

function isItemActive(el: HTMLElement): boolean {
  if (
    el.getAttribute("aria-selected") === "true" ||
    el.getAttribute("aria-pressed") === "true" ||
    el.getAttribute("aria-checked") === "true" ||
    el.getAttribute("aria-current") === "page" ||
    el.getAttribute("aria-current") === "true" ||
    el.getAttribute("aria-current") === "location" ||
    el.classList.contains("active") ||
    el.classList.contains("selected")
  ) {
    return true;
  }
  if (el.tagName === "LABEL") {
    const radio = el.querySelector<HTMLInputElement>('input[type="radio"]');
    if (radio?.checked) return true;
  }
  return false;
}

function ensurePill(container: HTMLElement): HTMLSpanElement {
  for (const child of Array.from(container.children)) {
    if (child instanceof HTMLElement && child.tagName === "SPAN" && child.classList.contains(PILL_CLASS)) {
      return child as HTMLSpanElement;
    }
  }
  const pill = container.ownerDocument.createElement("span");
  pill.className = PILL_CLASS;
  pill.setAttribute("aria-hidden", "true");
  container.appendChild(pill);
  return pill;
}

/**
 * Automatically equips all current and future tablists, radiogroups, segmented pills,
 * native radio `<label>` groups, and `[data-sliding-group]` containers with a GPU-composited sliding pill.
 */
export function installGlobalSlidingIndicators(root?: HTMLElement | Document): () => void {
  if (typeof document === "undefined") return () => {};
  const targetRoot = root ?? document.body ?? document.documentElement;
  if (!targetRoot) return () => {};

  const state = new WeakMap<HTMLElement, IndicatorRecord>();
  const observedContainers = new Set<HTMLElement>();
  let scheduled = false;
  let disposed = false;

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        if (disposed) return;
        for (const entry of entries) {
          if (entry.target instanceof HTMLElement) {
            syncContainer(entry.target, true);
          }
        }
      })
    : null;

  function clearContainer(container: HTMLElement) {
    container.removeAttribute("data-global-sliding-visible");
    const prev = state.get(container);
    if (prev) prev.key = "";
  }

  function syncContainer(container: HTMLElement, fromResize = false) {
    if (disposed) return;
    if (
      container.matches(EXCLUDED_CONTAINER_SELECTOR) ||
      container.closest('[data-sliding-managed="self"], [data-sliding-disabled]') !== null ||
      isHiddenElement(container)
    ) {
      clearContainer(container);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0 || containerRect.height <= 0) {
      clearContainer(container);
      return;
    }

    const scaleX = container.offsetWidth > 0 && containerRect.width > 0 ? containerRect.width / container.offsetWidth : 1;
    const scaleY = container.offsetHeight > 0 && containerRect.height > 0 ? containerRect.height / container.offsetHeight : 1;

    const items = Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
      (item) => !item.hidden && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0,
    );
    if (items.length < 2) {
      clearContainer(container);
      return;
    }

    const activeItems = items.filter(isItemActive);
    // Single-selection safety: skip multi-select toggle groups so they never get a single pill.
    if (activeItems.length !== 1) {
      clearContainer(container);
      return;
    }

    const active = activeItems[0]!;
    const activeRect = active.getBoundingClientRect();
    if (activeRect.width <= 0 || activeRect.height <= 0) {
      clearContainer(container);
      return;
    }

    const axis = container.dataset.slidingAxis === "vertical" || container.dataset.slidingAxis === "horizontal"
      ? container.dataset.slidingAxis
      : detectAxis(items, scaleX, scaleY);

    const left = Math.round(((activeRect.left - containerRect.left) / scaleX - container.clientLeft + container.scrollLeft) * 100) / 100;
    const top = Math.round(((activeRect.top - containerRect.top) / scaleY - container.clientTop + container.scrollTop) * 100) / 100;
    const width = Math.round((activeRect.width / scaleX) * 100) / 100;
    const height = Math.round((activeRect.height / scaleY) * 100) / 100;
    const radius = typeof getComputedStyle === "function" ? getComputedStyle(active).borderRadius || "6px" : "6px";
    const key = `${left}|${top}|${width}|${height}|${axis}|${radius}`;

    const record = state.get(container) ?? { key: "", initialized: false };
    if (record.key === key && container.hasAttribute("data-global-sliding-visible")) {
      return;
    }

    const pill = ensurePill(container);
    if (!observedContainers.has(container)) {
      observedContainers.add(container);
      resizeObserver?.observe(container);
    }

    container.dataset.globalSliding = "active";
    container.dataset.globalSlidingAxis = axis;

    const motionAllowed = isMotionAllowed(true);
    const instant = !record.initialized || fromResize || !motionAllowed;

    if (instant) {
      pill.style.transition = "none";
    } else {
      pill.style.removeProperty("transition");
    }

    pill.style.width = `${width}px`;
    pill.style.height = `${height}px`;
    pill.style.borderRadius = radius;
    pill.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    container.setAttribute("data-global-sliding-visible", "true");

    record.key = key;
    record.initialized = true;
    state.set(container, record);

    if (instant) {
      // Commit initial pose immediately so the very next selection glides smoothly.
      pill.getBoundingClientRect();
      if (motionAllowed) {
        pill.style.removeProperty("transition");
      }
    }
  }

  function syncAll(fromResize = false) {
    if (disposed) return;
    if (targetRoot instanceof HTMLElement && targetRoot.matches(GROUP_SELECTOR)) {
      syncContainer(targetRoot, fromResize);
    }
    const containers = targetRoot.querySelectorAll<HTMLElement>(GROUP_SELECTOR);
    for (const container of containers) {
      syncContainer(container, fromResize);
    }
  }

  function scheduleSync() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      syncAll(false);
    });
  }

  const mutationObserver = typeof MutationObserver === "function"
    ? new MutationObserver((mutations) => {
        if (disposed) return;
        for (const mutation of mutations) {
          const target = mutation.target;
          if (target instanceof HTMLElement && target.classList.contains(PILL_CLASS)) {
            continue;
          }
          if (
            mutation.type === "attributes" &&
            mutation.attributeName?.startsWith("data-global-sliding")
          ) {
            continue;
          }
          if (mutation.type === "childList") {
            const addedOnlyPill =
              mutation.addedNodes.length > 0 &&
              Array.from(mutation.addedNodes).every(
                (n) => n instanceof HTMLElement && n.classList.contains(PILL_CLASS),
              );
            if (addedOnlyPill) continue;
          }
          scheduleSync();
          return;
        }
      })
    : null;

  syncAll(false);

  mutationObserver?.observe(targetRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected", "aria-pressed", "aria-checked", "aria-current", "class", "hidden"],
  });

  const onInteraction = () => scheduleSync();
  const onResize = () => syncAll(true);
  const onMotionChange = () => syncAll(!isMotionAllowed(true));
  targetRoot.addEventListener("change", onInteraction, true);
  targetRoot.addEventListener("click", onInteraction, true);
  window.addEventListener("resize", onResize);
  window.addEventListener(DESKTOP_MOTION_EVENT, onMotionChange);

  const reducedMedia = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  reducedMedia?.addEventListener("change", onMotionChange);

  return () => {
    disposed = true;
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    observedContainers.clear();
    targetRoot.removeEventListener("change", onInteraction, true);
    targetRoot.removeEventListener("click", onInteraction, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener(DESKTOP_MOTION_EVENT, onMotionChange);
    reducedMedia?.removeEventListener("change", onMotionChange);
  };
}

/** Mount once at the application root to enable global sliding indicators everywhere. */
export function useGlobalSlidingIndicators() {
  useEffect(() => installGlobalSlidingIndicators(), []);
}
