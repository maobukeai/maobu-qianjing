import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UiProfile } from "./api.ts";
import { buildPickerCandidates, profileDisplayNumber } from "./default-browser.ts";
import { copyPlainText } from "./features/copy-field.tsx";
import { useTranslation } from "./i18n.tsx";
import { isolateModalSiblings } from "./modal-isolation.ts";
import { AppIcon } from "./ui-primitives.tsx";
import "./default-browser-picker.css";

export interface DefaultBrowserPickerProps {
  open: boolean;
  url: string;
  hostname: string;
  queuedCount: number;
  profiles: readonly UiProfile[];
  favoriteProfileIds: ReadonlySet<string>;
  runningOnly: boolean;
  busy: boolean;
  error: string | null;
  onRunningOnlyChange: (value: boolean) => void;
  onSelect: (profileId: string, rememberDomain: boolean) => void;
  onCancel: () => void;
}

export function DefaultBrowserPicker({
  open,
  url,
  hostname,
  queuedCount,
  profiles,
  favoriteProfileIds,
  runningOnly,
  busy,
  error,
  onRunningOnlyChange,
  onSelect,
  onCancel,
}: DefaultBrowserPickerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [rememberDomain, setRememberDomain] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const candidates = useMemo(
    () => buildPickerCandidates(profiles, favoriteProfileIds, query, runningOnly),
    [profiles, favoriteProfileIds, query, runningOnly],
  );

  const orderedItems = useMemo(() => {
    if (candidates.hasSearchQuery) return candidates.searchMatches;
    return [...candidates.running, ...candidates.favorites, ...candidates.recent];
  }, [candidates]);

  const sections = useMemo(() => {
    if (candidates.hasSearchQuery) {
      return candidates.searchMatches.length
        ? [{ key: "search", label: t("Search results"), items: candidates.searchMatches }]
        : [];
    }
    const list: Array<{ key: string; label: string; items: UiProfile[] }> = [];
    if (candidates.running.length > 0) {
      list.push({ key: "running", label: t("Running environments"), items: candidates.running });
    }
    if (candidates.favorites.length > 0) {
      list.push({ key: "favorites", label: t("Starred environments"), items: candidates.favorites });
    }
    if (candidates.recent.length > 0) {
      list.push({ key: "recent", label: t("Recent environments"), items: candidates.recent });
    }
    return list;
  }, [candidates, t]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRememberDomain(false);
    setActiveIndex(0);
    setCopiedUrl(false);
    const raf = requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open, url]);

  useEffect(() => {
    if (activeIndex >= orderedItems.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, orderedItems.length]);

  useEffect(() => {
    if (!open || !layerRef.current) return;
    return isolateModalSiblings(layerRef.current);
  }, [open]);

  const activeProfile = orderedItems[activeIndex] ?? null;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (!busy) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        if (orderedItems.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % orderedItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        if (orderedItems.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + orderedItems.length) % orderedItems.length);
        return;
      }
      if (event.key === "Enter") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button") || target?.matches('input[type="checkbox"]')) return;
        if (activeProfile && !busy) {
          event.preventDefault();
          onSelect(activeProfile.id, rememberDomain);
        }
        return;
      }
      if (/^[1-9]$/.test(event.key) && !busy) {
        const inSearch = document.activeElement === searchInputRef.current;
        const allowDigit = !inSearch || (!query.trim() && !event.altKey) || event.altKey;
        if (allowDigit && (!event.ctrlKey && !event.metaKey)) {
          const item = orderedItems[Number(event.key) - 1];
          if (item) {
            event.preventDefault();
            onSelect(item.id, rememberDomain);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy, orderedItems, activeProfile, rememberDomain, query, onCancel, onSelect]);

  if (!open || typeof document === "undefined") return null;

  let flatCursor = 0;

  return createPortal(
    <div className="db-picker-layer" ref={layerRef}>
      <div
        className="db-picker-backdrop"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !busy) {
            onCancel();
          }
        }}
      >
        <div
          className="db-picker-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={busy || undefined}
        >
          <header className="db-picker-header">
            <div className="db-picker-title-group">
              <span className="db-picker-badge">
                <AppIcon name="globe" className="sm" />
              </span>
              <div>
                <div className="db-picker-title-row">
                  <h2 id={titleId}>{t("Choose environment for external link")}</h2>
                  {queuedCount > 0 && (
                    <span className="db-picker-queue-pill">
                      {t("+{count} waiting", { count: queuedCount })}
                    </span>
                  )}
                </div>
                <div className="db-picker-url-row">
                  <span className="db-picker-host">{hostname}</span>
                  <code className="db-picker-url" title={url}>
                    {url}
                  </code>
                  <button
                    type="button"
                    className="btn xs ghost db-picker-copy"
                    onClick={() => {
                      void copyPlainText(url).then(() => setCopiedUrl(true)).catch(() => {});
                    }}
                  >
                    <AppIcon name={copiedUrl ? "check" : "copy"} className="sm" />
                    <span>{t(copiedUrl ? "Copied" : "Copy link")}</span>
                  </button>
                </div>
              </div>
            </div>
            <button
              type="button"
              className="iconbtn db-picker-close"
              aria-label={t("Close")}
              disabled={busy}
              onClick={onCancel}
            >
              <AppIcon name="close" className="sm" />
            </button>
          </header>

          <div className="db-picker-controls">
            <div className="searchfield db-picker-search">
              <AppIcon name="search" className="sm" />
              <input
                ref={searchInputRef}
                className="input search"
                value={query}
                disabled={busy}
                placeholder={t("Search environment name, No., group, or tag…")}
                aria-label={t("Search environments")}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="clear"
                  aria-label={t("Clear search")}
                  onClick={() => setQuery("")}
                >
                  <AppIcon name="close" className="sm" />
                </button>
              )}
            </div>
            <button
              type="button"
              className={`btn sm db-picker-running-toggle${runningOnly ? " is-active" : ""}`}
              aria-pressed={runningOnly}
              disabled={busy}
              onClick={() => onRunningOnlyChange(!runningOnly)}
            >
              <span className="db-picker-dot" aria-hidden="true" />
              <span>{t("Running only")}</span>
            </button>
          </div>

          <div className="db-picker-list" role="listbox" aria-label={t("Available environments")}>
            {sections.length === 0 ? (
              <div className="db-picker-empty">
                <p>
                  {query.trim()
                    ? runningOnly
                      ? t("No running environments match this search.")
                      : t("No environments match this search.")
                    : runningOnly
                      ? t("No environments are currently running.")
                      : t("No launchable environments are available.")}
                </p>
                {runningOnly && (
                  <button
                    type="button"
                    className="btn xs"
                    disabled={busy}
                    onClick={() => onRunningOnlyChange(false)}
                  >
                    {t("Show stopped environments too")}
                  </button>
                )}
              </div>
            ) : (
              sections.map((section) => (
                <div className="db-picker-section" key={section.key}>
                  <div className="db-picker-section-title">{section.label}</div>
                  {section.items.map((profile) => {
                    const index = flatCursor++;
                    const selected = index === activeIndex;
                    const no = profileDisplayNumber(profile);
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={busy}
                        className={`db-picker-item${selected ? " is-selected" : ""}${profile.running ? " is-running" : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => onSelect(profile.id, rememberDomain)}
                      >
                        <span className="db-picker-item-status" aria-hidden="true" />
                        <span className="db-picker-item-main">
                          <span className="db-picker-item-name">
                            <strong>{profile.name}</strong>
                            {no && <span className="db-picker-item-no">{no}</span>}
                            {profile.group && (
                              <span className="db-picker-item-tag">{profile.group}</span>
                            )}
                            <span className="db-picker-item-engine">
                              {profile.engine === "firefox" ? "Firefox" : "Chromium"}
                            </span>
                          </span>
                          <span className="db-picker-item-meta">
                            <span>{profile.proxy ? profile.proxy : t("Direct connection")}</span>
                          </span>
                        </span>
                        <span className="db-picker-item-right">
                          <span className="db-picker-item-action">
                            {t(profile.running ? "Open tab" : "Start & open")}
                          </span>
                          {index < 9 && <kbd className="db-picker-kbd">{index + 1}</kbd>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
            {!candidates.hasSearchQuery && candidates.hiddenStoppedCount > 0 && (
              <div className="db-picker-footnote">
                {t("{count} stopped environment(s) hidden. Type in the search box to find any environment.", {
                  count: candidates.hiddenStoppedCount,
                })}
              </div>
            )}
          </div>

          {error && (
            <div className="db-picker-error" role="alert">
              <AppIcon name="alert" className="sm" />
              <span>{t(error)}</span>
            </div>
          )}

          <footer className="db-picker-footer">
            <label className="db-picker-remember">
              <input
                type="checkbox"
                checked={rememberDomain}
                disabled={busy}
                onChange={(event) => setRememberDomain(event.target.checked)}
              />
              <span>{t("Always open {host} in this environment", { host: hostname })}</span>
            </label>
            <div className="db-picker-actions">
              <button type="button" className="btn" disabled={busy} onClick={onCancel}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !activeProfile}
                onClick={() => {
                  if (activeProfile) onSelect(activeProfile.id, rememberDomain);
                }}
              >
                <AppIcon name="play" className="sm" />
                <span>{t(busy ? "Opening…" : "Open in selected")}</span>
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}
