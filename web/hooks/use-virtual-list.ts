import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export const DEFAULT_VIRTUAL_THRESHOLD = 60;
export const DEFAULT_VIRTUAL_OVERSCAN = 8;
export const DEFAULT_FALLBACK_VIEWPORT_HEIGHT = 800;

export type VirtualScrollAlign = "nearest" | "start" | "center" | "end";

export type VirtualBlock =
  | { type: "spacer"; key: string; height: number }
  | { type: "item"; index: number; key: string };

export interface UseVirtualListOptions<T> {
  items: readonly T[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Sticky content above the list occupies space even when the container is scrolled. */
  stickyHeaderRef?: React.RefObject<HTMLElement | null>;
  getKey: (item: T) => string;
  estimateHeight: (item: T) => number;
  /** Render all rows directly with zero spacers when item count <= threshold. Default: 60. */
  threshold?: number;
  /** Extra rows mounted before and after the visible viewport. Default: 8. */
  overscan?: number;
  /** Viewport height fallback when clientHeight === 0 (e.g. headless DOM tests). Default: 800. */
  fallbackViewportHeight?: number;
  /** Item keys kept mounted even when outside the current scroll slice. */
  pinnedKeys?: ReadonlySet<string>;
  /** Changing this key clears measured heights while keeping the top visible row anchored. */
  resetKey?: string | number;
}

export interface UseVirtualListResult {
  virtualized: boolean;
  totalHeight: number;
  viewportHeight: number;
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
  renderedIndices: number[];
  blocks: VirtualBlock[];
  offsets: Float64Array;
  measureRow: (key: string) => (node: HTMLElement | null) => void;
  scrollToIndex: (index: number, align?: VirtualScrollAlign) => void;
  onScroll: () => void;
}

/** Binary search the first item index whose bottom edge exceeds `offset`. */
export function findOffsetIndex(offsets: Float64Array, count: number, offset: number): number {
  if (count <= 0 || offset <= 0) return 0;
  if (offset >= offsets[count]!) return count - 1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1]! <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

function computeVisibleSlice(
  offsets: Float64Array,
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { startIndex: number; endIndex: number } {
  if (count <= 0) return { startIndex: 0, endIndex: 0 };
  const totalHeight = offsets[count]!;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const clampedTop = Math.max(0, Math.min(scrollTop, maxScroll));
  const rawStart = findOffsetIndex(offsets, count, clampedTop);
  const bottom = clampedTop + viewportHeight;
  let rawEnd = count;
  if (bottom < totalHeight) {
    const endIdx = findOffsetIndex(offsets, count, bottom);
    rawEnd = offsets[endIdx]! >= bottom ? endIdx : Math.min(count, endIdx + 1);
  }
  return {
    startIndex: Math.max(0, rawStart - overscan),
    endIndex: Math.min(count, rawEnd + overscan),
  };
}

/**
 * Zero-dependency virtual list engine backed by a Float64Array prefix-sum table,
 * shared ResizeObserver dynamic measurement with upward scroll-jump compensation,
 * threshold passthrough (<= 60 items direct render), and pinned keep-alive slots.
 */
export function useVirtualList<T>({
  items,
  scrollContainerRef,
  stickyHeaderRef,
  getKey,
  estimateHeight,
  threshold = DEFAULT_VIRTUAL_THRESHOLD,
  overscan = DEFAULT_VIRTUAL_OVERSCAN,
  fallbackViewportHeight = DEFAULT_FALLBACK_VIEWPORT_HEIGHT,
  pinnedKeys,
  resetKey,
}: UseVirtualListOptions<T>): UseVirtualListResult {
  const count = items.length;
  const virtualized = count > threshold;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(fallbackViewportHeight);
  const [measureVersion, setMeasureVersion] = useState(0);

  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(fallbackViewportHeight);
  const measuredHeightsRef = useRef(new Map<string, number>());
  const nodeToKeyRef = useRef(new WeakMap<Element, string>());
  const keyToNodeRef = useRef(new Map<string, Element>());
  const refCallbackCacheRef = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const prevResetKeyRef = useRef(resetKey);
  const pendingAnchorRef = useRef<{ key: string; subOffset: number } | null>(null);
  const prevOffsetsRef = useRef<Float64Array | null>(null);
  const prevKeysRef = useRef<string[] | null>(null);
  const lastRangeRef = useRef({ start: 0, end: count });

  // Precompute keys and O(1) key -> index lookup whenever `items` changes.
  const { keys, keyToIndex, estimates } = useMemo(() => {
    const nextKeys = new Array<string>(count);
    const nextMap = new Map<string, number>();
    const nextEstimates = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const item = items[i]!;
      const key = getKey(item);
      nextKeys[i] = key;
      nextMap.set(key, i);
      const est = estimateHeight(item);
      nextEstimates[i] = Number.isFinite(est) && est > 0 ? est : 48;
    }
    return { keys: nextKeys, keyToIndex: nextMap, estimates: nextEstimates };
  }, [items, count, getKey, estimateHeight]);

  // If density / resetKey changed, snapshot the top-anchored item before clearing measured heights.
  if (prevResetKeyRef.current !== resetKey) {
    if (
      virtualized &&
      prevOffsetsRef.current &&
      prevKeysRef.current &&
      prevKeysRef.current.length > 0 &&
      scrollTopRef.current > 0
    ) {
      const anchorIdx = findOffsetIndex(prevOffsetsRef.current, prevKeysRef.current.length, scrollTopRef.current);
      const anchorKey = prevKeysRef.current[anchorIdx];
      if (anchorKey !== undefined) {
        pendingAnchorRef.current = {
          key: anchorKey,
          subOffset: Math.max(0, scrollTopRef.current - prevOffsetsRef.current[anchorIdx]!),
        };
      }
    }
    measuredHeightsRef.current.clear();
    prevResetKeyRef.current = resetKey;
  }

  // Prune stale measured heights only when the cache grows meaningfully larger than the dataset.
  useEffect(() => {
    const measured = measuredHeightsRef.current;
    if (measured.size > Math.max(256, count * 2)) {
      for (const key of measured.keys()) {
        if (!keyToIndex.has(key)) measured.delete(key);
      }
    }
  }, [keyToIndex, count]);

  // Build prefix-sum offset table (Float64Array of length count + 1).
  const offsets = useMemo(() => {
    const table = new Float64Array(count + 1);
    const measured = measuredHeightsRef.current;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      table[i] = sum;
      const height = measured.get(keys[i]!) ?? estimates[i]!;
      sum += height > 0 ? height : 48;
    }
    table[count] = sum;
    return table;
  }, [count, keys, estimates, measureVersion, resetKey]);

  const totalHeight = offsets[count] ?? 0;

  prevOffsetsRef.current = offsets;
  prevKeysRef.current = keys;

  const latestRef = useRef({
    offsets,
    keyToIndex,
    estimates,
    count,
    virtualized,
    overscan,
  });
  latestRef.current = { offsets, keyToIndex, estimates, count, virtualized, overscan };

  const readViewportHeight = useCallback((container: HTMLElement) => {
    if (container.clientHeight <= 0) return fallbackViewportHeight;
    return Math.max(1, container.clientHeight - (stickyHeaderRef?.current?.offsetHeight ?? 0));
  }, [fallbackViewportHeight, stickyHeaderRef]);

  // Keep viewport height synced with the scroll container.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const syncViewport = () => {
      const next = readViewportHeight(el);
      if (next !== viewportHeightRef.current) {
        viewportHeightRef.current = next;
        setViewportHeight(next);
      }
    };
    syncViewport();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(el);
    const header = stickyHeaderRef?.current;
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [scrollContainerRef, stickyHeaderRef, readViewportHeight]);

  // Restore scroll anchor after density / resetKey recalculates offsets.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const el = scrollContainerRef.current;
    if (!el || !virtualized) return;
    const nextIdx = keyToIndex.get(anchor.key);
    if (nextIdx === undefined) return;
    const rowHeight = Math.max(1, offsets[nextIdx + 1]! - offsets[nextIdx]!);
    const nextTop = Math.max(0, offsets[nextIdx]! + Math.min(anchor.subOffset, Math.max(0, rowHeight - 1)));
    el.scrollTop = nextTop;
    scrollTopRef.current = nextTop;
    setScrollTop(nextTop);
  }, [offsets, keyToIndex, virtualized, scrollContainerRef]);

  // Shared ResizeObserver for dynamic row height measurement + scroll-jump compensation.
  useEffect(() => {
    if (!virtualized || typeof ResizeObserver === "undefined") {
      rowObserverRef.current?.disconnect();
      rowObserverRef.current = null;
      return;
    }
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      let scrollDelta = 0;
      const scrollEl = scrollContainerRef.current;
      const currentScrollTop = scrollEl ? scrollEl.scrollTop : scrollTopRef.current;
      const { offsets: curOffsets, keyToIndex: curKeyToIndex, estimates: curEstimates } = latestRef.current;
      const measured = measuredHeightsRef.current;

      for (const entry of entries) {
        const key = nodeToKeyRef.current.get(entry.target);
        if (!key) continue;
        const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
        const height = borderBox?.blockSize || entry.contentRect?.height || 0;
        if (!Number.isFinite(height) || height <= 0) continue;
        const idx = curKeyToIndex.get(key);
        if (idx === undefined) continue;
        const prev = measured.get(key) ?? curEstimates[idx]!;
        const delta = height - prev;
        if (Math.abs(delta) <= 0.5) continue;
        measured.set(key, height);
        changed = true;
        if (curOffsets[idx]! < currentScrollTop) {
          scrollDelta += delta;
        }
      }

      if (changed) {
        if (scrollDelta !== 0 && scrollEl && currentScrollTop > 0) {
          const adjusted = Math.max(0, currentScrollTop + scrollDelta);
          scrollEl.scrollTop = adjusted;
          scrollTopRef.current = adjusted;
          setScrollTop(adjusted);
        }
        setMeasureVersion((version) => version + 1);
      }
    });
    rowObserverRef.current = observer;
    for (const node of keyToNodeRef.current.values()) {
      observer.observe(node);
    }
    return () => {
      observer.disconnect();
      if (rowObserverRef.current === observer) rowObserverRef.current = null;
    };
  }, [virtualized, scrollContainerRef]);

  const measureRow = useCallback((key: string): ((node: HTMLElement | null) => void) => {
    const cache = refCallbackCacheRef.current;
    let callback = cache.get(key);
    if (!callback) {
      callback = (node: HTMLElement | null) => {
        const prevNode = keyToNodeRef.current.get(key);
        if (prevNode && prevNode !== node) {
          rowObserverRef.current?.unobserve(prevNode);
          keyToNodeRef.current.delete(key);
        }
        if (node) {
          nodeToKeyRef.current.set(node, key);
          keyToNodeRef.current.set(key, node);
          if (latestRef.current.virtualized) {
            rowObserverRef.current?.observe(node);
          }
        } else {
          cache.delete(key);
        }
      };
      cache.set(key, callback);
    }
    return callback;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nextTop = Math.max(0, el.scrollTop);
    scrollTopRef.current = nextTop;
    const current = latestRef.current;
    if (!current.virtualized) return;
    const vp = readViewportHeight(el);
    if (vp !== viewportHeightRef.current) {
      viewportHeightRef.current = vp;
      setViewportHeight(vp);
    }
    const nextSlice = computeVisibleSlice(current.offsets, current.count, nextTop, vp, current.overscan);
    if (
      nextSlice.startIndex !== lastRangeRef.current.start ||
      nextSlice.endIndex !== lastRangeRef.current.end ||
      nextTop === 0
    ) {
      setScrollTop(nextTop);
    }
  }, [scrollContainerRef, readViewportHeight]);

  const scrollToIndex = useCallback(
    (index: number, align: VirtualScrollAlign = "nearest") => {
      const current = latestRef.current;
      if (current.count <= 0) return;
      const clamped = Math.max(0, Math.min(current.count - 1, index));
      const el = scrollContainerRef.current;
      const vp = el ? readViewportHeight(el) : viewportHeightRef.current;
      const itemTop = current.offsets[clamped]!;
      const itemBottom = current.offsets[clamped + 1]!;
      const curTop = el ? el.scrollTop : scrollTopRef.current;
      let targetTop = curTop;

      if (align === "start") {
        targetTop = itemTop;
      } else if (align === "end") {
        targetTop = Math.max(0, itemBottom - vp);
      } else if (align === "center") {
        targetTop = Math.max(0, itemTop - (vp - (itemBottom - itemTop)) / 2);
      } else {
        if (itemTop < curTop) targetTop = itemTop;
        else if (itemBottom > curTop + vp) targetTop = Math.max(0, itemBottom - vp);
      }

      const maxScroll = Math.max(0, (current.offsets[current.count] ?? 0) - vp);
      targetTop = Math.max(0, Math.min(targetTop, maxScroll));
      if (el) el.scrollTop = targetTop;
      scrollTopRef.current = targetTop;
      setScrollTop(targetTop);
    },
    [scrollContainerRef, readViewportHeight],
  );

  // Compute visible slice + pinned keep-alive blocks.
  const { startIndex, endIndex, topSpacer, bottomSpacer, renderedIndices, blocks } = useMemo(() => {
    if (!virtualized) {
      const indices = new Array<number>(count);
      const directBlocks = new Array<VirtualBlock>(count);
      for (let i = 0; i < count; i++) {
        indices[i] = i;
        directBlocks[i] = { type: "item", index: i, key: keys[i]! };
      }
      return {
        startIndex: 0,
        endIndex: count,
        topSpacer: 0,
        bottomSpacer: 0,
        renderedIndices: indices,
        blocks: directBlocks,
      };
    }

    const slice = computeVisibleSlice(offsets, count, scrollTop, viewportHeight, overscan);
    const pinnedBefore: number[] = [];
    const pinnedAfter: number[] = [];
    if (pinnedKeys && pinnedKeys.size > 0) {
      for (const pinnedKey of pinnedKeys) {
        const idx = keyToIndex.get(pinnedKey);
        if (idx === undefined) continue;
        if (idx < slice.startIndex) pinnedBefore.push(idx);
        else if (idx >= slice.endIndex) pinnedAfter.push(idx);
      }
      if (pinnedBefore.length > 1) pinnedBefore.sort((a, b) => a - b);
      if (pinnedAfter.length > 1) pinnedAfter.sort((a, b) => a - b);
    }

    const nextBlocks: VirtualBlock[] = [];
    const nextIndices: number[] = [];
    let cursor = 0;

    for (const idx of pinnedBefore) {
      if (idx > cursor) {
        const h = offsets[idx]! - offsets[cursor]!;
        if (h > 0) nextBlocks.push({ type: "spacer", key: `spacer-before-${idx}`, height: h });
      }
      nextBlocks.push({ type: "item", index: idx, key: keys[idx]! });
      nextIndices.push(idx);
      cursor = idx + 1;
    }

    if (slice.startIndex > cursor) {
      const h = offsets[slice.startIndex]! - offsets[cursor]!;
      if (h > 0) nextBlocks.push({ type: "spacer", key: "spacer-top", height: h });
    }

    for (let i = slice.startIndex; i < slice.endIndex; i++) {
      nextBlocks.push({ type: "item", index: i, key: keys[i]! });
      nextIndices.push(i);
    }
    cursor = slice.endIndex;

    for (const idx of pinnedAfter) {
      if (idx > cursor) {
        const h = offsets[idx]! - offsets[cursor]!;
        if (h > 0) nextBlocks.push({ type: "spacer", key: `spacer-after-${idx}`, height: h });
      }
      nextBlocks.push({ type: "item", index: idx, key: keys[idx]! });
      nextIndices.push(idx);
      cursor = idx + 1;
    }

    if (count > cursor) {
      const h = totalHeight - offsets[cursor]!;
      if (h > 0) nextBlocks.push({ type: "spacer", key: "spacer-bottom", height: h });
    }

    return {
      startIndex: slice.startIndex,
      endIndex: slice.endIndex,
      topSpacer: offsets[slice.startIndex] ?? 0,
      bottomSpacer: Math.max(0, totalHeight - (offsets[slice.endIndex] ?? 0)),
      renderedIndices: nextIndices,
      blocks: nextBlocks,
    };
  }, [virtualized, count, keys, offsets, totalHeight, scrollTop, viewportHeight, overscan, pinnedKeys, keyToIndex]);

  lastRangeRef.current = { start: startIndex, end: endIndex };

  return {
    virtualized,
    totalHeight,
    viewportHeight,
    startIndex,
    endIndex,
    topSpacer,
    bottomSpacer,
    renderedIndices,
    blocks,
    offsets,
    measureRow,
    scrollToIndex,
    onScroll,
  };
}
