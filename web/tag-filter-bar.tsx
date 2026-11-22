import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MAX_PROFILE_TAGS } from "../profile-tags.ts";
import {
  aggregateProfileTagCounts,
  matchesTagFilter,
  type AggregatedTagCount,
  type TagFilterMode,
} from "../profile-view-state.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./tag-filter-bar.css";

export { aggregateProfileTagCounts, matchesTagFilter, type AggregatedTagCount, type TagFilterMode };

export interface TagFilterBarProps {
  profiles: readonly { tags?: readonly string[] }[];
  selectedTags: readonly string[];
  tagMode: TagFilterMode;
  onChangeTags: (tags: string[]) => void;
  onChangeTagMode: (mode: TagFilterMode) => void;
  disabled?: boolean;
  className?: string;
}

function tagKey(tag: string): string {
  return tag.trim().normalize("NFC").toLowerCase();
}

/**
 * Independent multi-tag filter bar with live tag count aggregation, internal search,
 * removable active tag chips, and OR ("any") / AND ("all") match mode toggle.
 */
export function TagFilterBar({
  profiles,
  selectedTags,
  tagMode,
  onChangeTags,
  onChangeTagMode,
  disabled = false,
  className,
}: TagFilterBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();

  const aggregated = useMemo(() => aggregateProfileTagCounts(profiles), [profiles]);
  const selectedKeySet = useMemo(() => new Set(selectedTags.map(tagKey)), [selectedTags]);

  // Include currently selected tags even if no visible profile currently carries them.
  const allOptions = useMemo(() => {
    const map = new Map<string, AggregatedTagCount>();
    for (const item of aggregated) map.set(item.key, item);
    for (const raw of selectedTags) {
      const label = raw.trim().normalize("NFC");
      if (!label) continue;
      const key = label.toLowerCase();
      if (!map.has(key)) map.set(key, { tag: label, key, count: 0 });
    }
    return Array.from(map.values());
  }, [aggregated, selectedTags]);

  const filteredOptions = useMemo(() => {
    const q = search.trim().normalize("NFC").toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((item) => item.key.includes(q));
  }, [allOptions, search]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  function toggleTag(label: string) {
    if (disabled) return;
    const key = tagKey(label);
    if (selectedKeySet.has(key)) {
      onChangeTags(selectedTags.filter((item) => tagKey(item) !== key));
      return;
    }
    if (selectedTags.length >= MAX_PROFILE_TAGS) return;
    onChangeTags([...selectedTags, label.trim().normalize("NFC")]);
  }

  function removeTag(label: string) {
    if (disabled) return;
    const key = tagKey(label);
    onChangeTags(selectedTags.filter((item) => tagKey(item) !== key));
  }

  function clearAll() {
    if (disabled || selectedTags.length === 0) return;
    onChangeTags([]);
  }

  const atLimit = selectedTags.length >= MAX_PROFILE_TAGS;

  return (
    <div ref={rootRef} className={["tag-filter-bar", className].filter(Boolean).join(" ")}>
      <div className="tag-filter-picker">
        <button
          type="button"
          className={`btn xs ghost tag-filter-trigger${open ? " is-open" : ""}${selectedTags.length > 0 ? " has-selection" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={disabled}
          onClick={() => {
            setOpen((prev) => {
              const next = !prev;
              if (!next) setSearch("");
              return next;
            });
          }}
        >
          <AppIcon name="filter" className="sm" />
          <span>{t("Tags")}</span>
          {selectedTags.length > 0 && <span className="tag-filter-count">{selectedTags.length}</span>}
          <AppIcon name={open ? "chevronUp" : "chevronDown"} className="sm" />
        </button>

        {open && (
          <div id={menuId} className="tag-filter-popover" role="region" aria-label={t("Filter by tags")}>
            <div className="tag-filter-search-wrap">
              <AppIcon name="search" className="sm" />
              <input
                ref={searchRef}
                type="search"
                className="tag-filter-search"
                value={search}
                placeholder={t("Search tags…")}
                aria-label={t("Search tags")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            {atLimit && (
              <p className="tag-filter-limit" role="status">
                {t("At most {max} tag filters can be active at once.", { max: MAX_PROFILE_TAGS })}
              </p>
            )}

            <div className="tag-filter-options" role="listbox" aria-multiselectable="true">
              {allOptions.length === 0 ? (
                <p className="tag-filter-empty">{t("No tags yet")}</p>
              ) : filteredOptions.length === 0 ? (
                <p className="tag-filter-empty">{t("No matching tags")}</p>
              ) : (
                filteredOptions.map((item) => {
                  const selected = selectedKeySet.has(item.key);
                  const optionDisabled = disabled || (!selected && atLimit);
                  return (
                    <label
                      key={item.key}
                      className={`tag-filter-option${selected ? " is-selected" : ""}${optionDisabled ? " is-disabled" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={optionDisabled}
                        onChange={() => toggleTag(item.tag)}
                      />
                      <span className="tag-filter-option-name">{item.tag}</span>
                      <span className="tag-filter-option-count">{item.count}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {selectedTags.length > 0 && (
        <>
          <div className="tag-filter-mode" role="group" aria-label={t("Tag match mode")}>
            <button
              type="button"
              className={`tag-filter-mode-btn${tagMode === "any" ? " is-active" : ""}`}
              aria-pressed={tagMode === "any"}
              disabled={disabled}
              onClick={() => onChangeTagMode("any")}
            >
              {t("Match any (OR)")}
            </button>
            <button
              type="button"
              className={`tag-filter-mode-btn${tagMode === "all" ? " is-active" : ""}`}
              aria-pressed={tagMode === "all"}
              disabled={disabled}
              onClick={() => onChangeTagMode("all")}
            >
              {t("Match all (AND)")}
            </button>
          </div>

          <div className="tag-filter-chips" aria-label={t("Active tag filters")}>
            {selectedTags.map((tag) => (
              <span key={tagKey(tag)} className="tag-filter-chip">
                <span>{tag}</span>
                <button
                  type="button"
                  className="tag-filter-chip-remove"
                  disabled={disabled}
                  aria-label={t("Remove tag filter {tag}", { tag })}
                  onClick={() => removeTag(tag)}
                >
                  <AppIcon name="close" className="xs" />
                </button>
              </span>
            ))}
          </div>

          <button
            type="button"
            className="btn xs ghost tag-filter-clear"
            disabled={disabled}
            onClick={clearAll}
          >
            {t("Clear")}
          </button>
        </>
      )}
    </div>
  );
}
