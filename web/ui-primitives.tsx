import * as React from "react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "./i18n";

/**
 * Stroke-icon set (16px grid, 1.7 stroke) used everywhere a control needs a
 * glyph. Inline so the dashboard ships no icon font or sprite request, and one
 * `.icon` rule in styles.css controls size and color for all of them.
 */
export const ICONS = {
  star: <path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  import: <><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  fileImport: <><path d="M15 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V6z" /><path d="M14 2v4a2 2 0 002 2h3" /><path d="M12 18v-7" /><path d="M9 14l3-3 3 3" /></>,
  export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  collapseRail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14m7-10-3 3 3 3" /></>,
  expandRail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14m5-10 3 3-3 3" /></>,
  sort: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  sortUp: <path d="M7 14l5-5 5 5" />,
  sortDown: <path d="M7 10l5 5 5-5" />,
  profiles: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  folders: <><path d="M8 17a2 2 0 01-2-2V5a2 2 0 012-2h2.88a2 2 0 011.41.59l.71.7A2 2 0 0014.41 5H18a2 2 0 012 2v8a2 2 0 01-2 2z" /><path d="M2 8v11a2 2 0 002 2h14" /></>,
  puzzle: <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />,
  logs: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  play: <path d="M7 4.5l12 7.5-12 7.5z" />,
  power: <><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1011 0" /></>,
  trash: <><path d="M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2" /><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" /></>,
  edit: <><path d="M4 20h4L20 8a2.8 2.8 0 10-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  move: <><path d="M4 20h13a3 3 0 003-3v-6a2 2 0 00-2-2h-7.5a2 2 0 01-1.6-.8L7.6 5.8A2 2 0 006 5H4a2 2 0 00-2 2v11a2 2 0 002 2z" /><path d="M9 14h6M13 11.5l2.5 2.5L13 16.5" /></>,
  raise: <><rect x="8" y="3" width="13" height="13" rx="2" /><path d="M16 16v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2h3" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15.5 12v2.5" /></>,
  fingerprint: <><path d="M7 11a5 5 0 0110 0v2a9 9 0 01-1.5 5" /><path d="M10 11a2 2 0 014 0v2a12 12 0 01-2.5 7" /><path d="M4.5 15a14 14 0 00.5-4 7 7 0 0114 0" /></>,
  cookie: <><circle cx="12" cy="12" r="9" /><circle cx="8.5" cy="10" r="1" /><circle cx="13.5" cy="15" r="1" /><circle cx="16" cy="9" r="1" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  warning: <><path d="M10.3 4.2L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" /><path d="M12 9.5v4M12 17v.3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" /></>,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></>,
  hash: <path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  file: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9.1a2.7 2.7 0 015.3.7c0 1.8-2.7 2.2-2.7 3.7" /><path d="M12 16.8v.3" /></>,
  bot: <><rect x="4" y="7" width="16" height="13" rx="4" /><path d="M12 3v4M1 12v4M23 12v4M8 12h.01M16 12h.01M9 16h6" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function AppIcon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export const Icon = AppIcon;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute("aria-hidden"));
}

export interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  headerExtra?: ReactNode;
  size?: "sm" | "md" | "lg" | "wide";
  role?: "dialog" | "alertdialog";
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  busy?: boolean;
  portal?: boolean;
  className?: string;
  backdropClassName?: string;
  backdropStyle?: React.CSSProperties;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}

const MODAL_SIZE_CLASS: Record<NonNullable<ModalDialogProps["size"]>, string> = {
  sm: "mode-confirm",
  md: "",
  lg: "wide",
  wide: "profile-editor",
};

export function ModalDialog({
  open,
  onClose,
  title,
  children,
  footer,
  headerExtra,
  size = "md",
  role = "dialog",
  closeOnBackdrop = true,
  closeOnEscape = true,
  busy = false,
  portal = false,
  className,
  backdropClassName,
  backdropStyle,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: ModalDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    if (panel) {
      const focusable = getFocusableElements(panel);
      if (focusable[0]) focusable[0].focus();
      else panel.focus();
    }
    return () => {
      const prev = previousFocusRef.current;
      if (prev && prev.isConnected && typeof prev.focus === "function") {
        prev.focus();
      }
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Escape") {
        if (closeOnEscape && !busy) {
          event.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (event.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = getFocusableElements(panel);
        if (focusable.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !panel.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !panel.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeOnEscape, busy]);

  if (!open) return null;

  const sizeCls = MODAL_SIZE_CLASS[size];
  const modalClass = ["modal", sizeCls, className].filter(Boolean).join(" ");
  const backdropClass = ["modal-backdrop", backdropClassName]
    .filter(Boolean)
    .join(" ");
  const resolvedLabelledBy =
    ariaLabelledBy ?? (title !== undefined ? titleId : undefined);

  const content = (
    <div
      className={backdropClass}
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget && closeOnBackdrop && !busy) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={modalClass}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={resolvedLabelledBy}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="modal-head">
            <h3 id={titleId}>{title}</h3>
            {headerExtra}
            <button
              type="button"
              className="btn ghost xs icon-only"
              onClick={onClose}
              disabled={busy}
              aria-label={t("Close")}
            >
              <AppIcon name="close" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }
  return content;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  portal?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  busy = false,
  portal = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descId = useId();
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const preferred =
      tone === "danger" ? cancelBtnRef.current : confirmBtnRef.current;
    preferred?.focus();
    return () => {
      const prev = previousFocusRef.current;
      if (prev && prev.isConnected && typeof prev.focus === "function") {
        prev.focus();
      }
      previousFocusRef.current = null;
    };
  }, [open, tone]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Escape") {
        if (!busy) {
          event.stopPropagation();
          onCancelRef.current();
        }
        return;
      }
      if (event.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = getFocusableElements(panel);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !panel.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !panel.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy]);

  if (!open) return null;

  const dialog = (
    <div
      className="modal-backdrop confirm-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        className="modal mode-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="btn ghost xs icon-only"
            onClick={onCancel}
            disabled={busy}
            aria-label={t("Close")}
          >
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-body" id={descId}>
          {typeof message === "string" ? <p>{message}</p> : message}
        </div>
        <div className="modal-foot">
          <button
            ref={cancelBtnRef}
            type="button"
            className="btn ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel ?? t("Cancel")}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={tone === "danger" ? "btn danger" : "btn primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel ?? t("Confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  if (portal && typeof document !== "undefined") {
    return createPortal(dialog, document.body);
  }
  return dialog;
}

export interface ConfirmRequestOptions {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
}

interface PendingConfirm extends ConfirmRequestOptions {
  resolve: (accepted: boolean) => void;
}

/**
 * Imperative promise-based confirmation hook backed by `<ConfirmDialog />`.
 * Renders an accessible in-app alertdialog instead of native `window.confirm()`.
 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
    };
  }, []);

  const requestConfirm = useCallback(
    (options: ConfirmRequestOptions): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        if (pendingRef.current) {
          pendingRef.current.resolve(false);
        }
        const next: PendingConfirm = { ...options, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    },
    [],
  );

  const settle = useCallback((accepted: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(accepted);
  }, []);

  const confirmDialogNode = pending ? (
    <ConfirmDialog
      open
      title={pending.title}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      tone={pending.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return {
    requestConfirm,
    confirmDialogNode,
    isConfirmOpen: pending !== null,
  };
}

export interface PaginationProps {
  page: number;
  pageCount: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageLabel?: string;
  perPageLabel?: string;
}

export function Pagination({
  page,
  pageCount,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  pageLabel,
  perPageLabel,
}: PaginationProps) {
  const { t } = useTranslation();
  const safePageCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(0, page), safePageCount - 1);

  return (
    <div className="pager">
      <button
        type="button"
        className="btn ghost xs icon-only"
        disabled={safePage <= 0}
        onClick={() => onPageChange(Math.max(0, safePage - 1))}
        aria-label={t("Previous page")}
        title={t("Previous page")}
      >
        <AppIcon name="chevronLeft" />
      </button>
      <span className="pager-label">
        {pageLabel ??
          t("Page {page} / {total}", {
            page: safePage + 1,
            total: safePageCount,
          })}
      </span>
      <button
        type="button"
        className="btn ghost xs icon-only"
        disabled={safePage >= safePageCount - 1}
        onClick={() =>
          onPageChange(Math.min(safePageCount - 1, safePage + 1))
        }
        aria-label={t("Next page")}
        title={t("Next page")}
      >
        <AppIcon name="chevronRight" />
      </button>
      <label className="pager-size">
        <span>{perPageLabel ?? t("Per page")}</span>
        <select
          aria-label={perPageLabel ?? t("Per page")}
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
