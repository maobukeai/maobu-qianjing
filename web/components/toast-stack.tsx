import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { useEffectiveDesktopMotion } from "../desktop-motion.tsx";
import { useTranslation } from "../i18n.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import "./toast-stack.css";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export type ToastTone = "success" | "info" | "warn" | "error";

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
  createdAt: number;
}

export interface PushToastOptions {
  tone?: ToastTone;
  durationMs?: number;
  id?: string;
}

export interface UseToastStackOptions {
  /** Maximum simultaneous stacked toasts. Defaults to 3. */
  maxVisible?: number;
  /** Default auto-dismiss duration in ms. Defaults to 4500ms. */
  defaultDurationMs?: number;
}

export interface UseToastStackResult {
  toasts: ToastItem[];
  pushToast: (message: string, toneOrOptions?: ToastTone | PushToastOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

export const DEFAULT_MAX_TOASTS = 3;
export const DEFAULT_TOAST_DURATION_MS = 4500;
const TOAST_EXIT_MS = 120;

let nextToastSeq = 1;

function validTone(value: unknown): value is ToastTone {
  return value === "success" || value === "info" || value === "warn" || value === "error";
}

/**
 * Manage a bounded FIFO queue (up to 3 stacked items by default) for transient
 * user feedback toasts with semantic tones (`success | info | warn | error`).
 */
export function useToastStack(options: UseToastStackOptions = {}): UseToastStackResult {
  const maxVisible = Math.max(1, options.maxVisible ?? DEFAULT_MAX_TOASTS);
  const defaultDurationMs = options.defaultDurationMs ?? DEFAULT_TOAST_DURATION_MS;
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => {
      const next = current.filter((item) => item.id !== id);
      return next.length === current.length ? current : next;
    });
  }, []);

  const clearToasts = useCallback(() => {
    setToasts((current) => (current.length === 0 ? current : []));
  }, []);

  const pushToast = useCallback(
    (message: string, toneOrOptions?: ToastTone | PushToastOptions): string => {
      const trimmed = message.trim();
      if (!trimmed) return "";

      const opts: PushToastOptions =
        typeof toneOrOptions === "string"
          ? { tone: toneOrOptions }
          : (toneOrOptions ?? {});
      const tone: ToastTone = validTone(opts.tone) ? opts.tone : "success";
      const durationMs =
        typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs)
          ? Math.max(0, opts.durationMs)
          : defaultDurationMs;
      const id = opts.id?.trim() || `toast-${nextToastSeq++}`;
      const item: ToastItem = {
        id,
        message: trimmed,
        tone,
        durationMs,
        createdAt: Date.now(),
      };

      setToasts((current) => {
        const deduped = current.filter((existing) => existing.id !== id);
        const appended = [...deduped, item];
        return appended.length > maxVisible
          ? appended.slice(appended.length - maxVisible)
          : appended;
      });
      return id;
    },
    [defaultDurationMs, maxVisible],
  );

  return { toasts, pushToast, dismissToast, clearToasts };
}

function ToastGlyph({ tone }: { tone: ToastTone }) {
  if (tone === "warn") return <AppIcon name="warning" className="sm" />;
  if (tone === "error") return <AppIcon name="alert" className="sm" />;
  if (tone === "info") {
    return (
      <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    );
  }
  return <AppIcon name="check" className="sm" />;
}

interface ToastRowProps {
  toast: ToastItem;
  exiting: boolean;
  reduced: boolean;
  onDismiss: (id: string) => void;
}

function ToastRow({ toast, exiting, reduced, onDismiss }: ToastRowProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"entering" | "present" | "exiting">(
    exiting ? "exiting" : reduced ? "present" : "entering",
  );
  const [paused, setPaused] = useState(false);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef<number | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Reset countdown if duration or toast identity changes.
  useEffect(() => {
    remainingRef.current = toast.durationMs;
    startedAtRef.current = null;
  }, [toast.id, toast.durationMs, toast.createdAt]);

  // Enter / exit visual transition phase.
  useIsomorphicLayoutEffect(() => {
    if (exiting) {
      setPhase("exiting");
      return;
    }
    if (reduced) {
      setPhase("present");
      return;
    }
    setPhase("entering");
    rowRef.current?.getBoundingClientRect();
    const frame = window.requestAnimationFrame(() => setPhase("present"));
    return () => window.cancelAnimationFrame(frame);
  }, [exiting, reduced]);

  // Pauseable countdown timer for auto-dismiss.
  useEffect(() => {
    if (exiting || toast.durationMs <= 0) return;
    if (paused) {
      if (startedAtRef.current !== null) {
        const elapsed = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        startedAtRef.current = null;
      }
      return;
    }
    const remaining = remainingRef.current;
    if (remaining <= 0) {
      onDismissRef.current(toast.id);
      return;
    }
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => {
      startedAtRef.current = null;
      remainingRef.current = 0;
      onDismissRef.current(toast.id);
    }, remaining);
    return () => {
      clearTimeout(timer);
      if (startedAtRef.current !== null) {
        const elapsed = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        startedAtRef.current = null;
      }
    };
  }, [exiting, paused, toast.id, toast.durationMs, toast.createdAt]);

  const syncPaused = () => {
    setPaused(hoveredRef.current || focusedRef.current);
  };

  const handleEnter = () => {
    hoveredRef.current = true;
    syncPaused();
  };
  const handleLeave = () => {
    hoveredRef.current = false;
    syncPaused();
  };
  const handleFocus = () => {
    focusedRef.current = true;
    syncPaused();
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focusedRef.current = false;
    syncPaused();
  };

  return (
    <div
      ref={rowRef}
      className={`toast-item notice is-${toast.tone}`}
      role={exiting ? undefined : "status"}
      data-toast-id={toast.id}
      data-toast-tone={toast.tone}
      data-motion-phase={phase}
      data-paused={paused || undefined}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
      onPointerEnter={exiting ? undefined : handleEnter}
      onPointerLeave={exiting ? undefined : handleLeave}
      onMouseEnter={exiting ? undefined : handleEnter}
      onMouseLeave={exiting ? undefined : handleLeave}
      onFocus={exiting ? undefined : handleFocus}
      onBlur={exiting ? undefined : handleBlur}
    >
      <ToastGlyph tone={toast.tone} />
      <span>{toast.message}</span>
      <button
        type="button"
        className="notice-dismiss toast-dismiss"
        aria-label={t("Dismiss")}
        disabled={exiting}
        onClick={() => {
          if (!exiting) onDismiss(toast.id);
        }}
      >
        <AppIcon name="close" className="sm" />
      </button>
    </div>
  );
}

export interface ToastStackProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
  className?: string;
}

interface RenderedToast {
  toast: ToastItem;
  exiting: boolean;
}

/**
 * Stacked micro-feedback toast container (up to 3 items).
 * Preserves `.notice` and `role="status"` semantics, pauses auto-dismiss on
 * hover/focus, and smoothly animates entrances and 120ms exits via GPU transforms.
 */
export function ToastStack({ toasts, onDismiss, className }: ToastStackProps) {
  const { t } = useTranslation();
  const effective = useEffectiveDesktopMotion();
  const reduced = effective === "reduced";
  const [rendered, setRendered] = useState<RenderedToast[]>(() =>
    toasts.map((toast) => ({ toast, exiting: false })),
  );
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) clearTimeout(timer);
      exitTimersRef.current.clear();
    };
  }, []);

  useIsomorphicLayoutEffect(() => {
    const activeById = new Map(toasts.map((item) => [item.id, item]));

    // Cancel exit timers for any toast that re-appeared with the same id.
    for (const id of activeById.keys()) {
      const existingTimer = exitTimersRef.current.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        exitTimersRef.current.delete(id);
      }
    }

    if (reduced) {
      for (const timer of exitTimersRef.current.values()) clearTimeout(timer);
      exitTimersRef.current.clear();
      setRendered(toasts.map((toast) => ({ toast, exiting: false })));
      return;
    }

    setRendered((prev) => {
      const next: RenderedToast[] = [];
      const seen = new Set<string>();

      for (const entry of prev) {
        const live = activeById.get(entry.toast.id);
        if (live) {
          next.push({ toast: live, exiting: false });
          seen.add(live.id);
        } else {
          next.push({ toast: entry.toast, exiting: true });
          seen.add(entry.toast.id);
          if (!exitTimersRef.current.has(entry.toast.id)) {
            const removedId = entry.toast.id;
            const timer = setTimeout(() => {
              exitTimersRef.current.delete(removedId);
              setRendered((curr) => curr.filter((item) => item.toast.id !== removedId || !item.exiting));
            }, TOAST_EXIT_MS);
            exitTimersRef.current.set(removedId, timer);
          }
        }
      }

      for (const item of toasts) {
        if (!seen.has(item.id)) {
          next.push({ toast: item, exiting: false });
        }
      }

      return next;
    });
  }, [toasts, reduced]);

  if (rendered.length === 0) return null;

  return (
    <div
      className={`toast-stack${className ? ` ${className}` : ""}`}
      role="region"
      aria-label={t("Notifications")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {rendered.map(({ toast, exiting }) => (
        <ToastRow
          key={toast.id}
          toast={toast}
          exiting={exiting}
          reduced={reduced}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
