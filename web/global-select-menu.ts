import { useEffect } from "react";

const POPOVER_CLASS = "global-select-popover";
const GROUP_LABEL_CLASS = "global-select-group-label";
const OPTION_CLASS = "global-select-option";
const EMPTY_CLASS = "global-select-empty";

const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

interface SelectOptionEntry {
  kind: "option";
  option: HTMLOptionElement;
  label: string;
  disabled: boolean;
  selected: boolean;
  indexInMenu: number;
}

interface SelectGroupEntry {
  kind: "group";
  label: string;
}

type MenuEntry = SelectOptionEntry | SelectGroupEntry;

function isEligibleSelect(el: EventTarget | null): el is HTMLSelectElement {
  if (!el || typeof el !== "object" || (el as Node).nodeType !== 1 || (el as Element).tagName !== "SELECT") return false;
  const select = el as HTMLSelectElement;
  if (select.disabled || select.multiple) return false;
  if (select.dataset.nativeSelect === "true") return false;
  const sizeAttr = select.getAttribute("size");
  if (sizeAttr !== null && Number(sizeAttr) > 1) return false;
  return true;
}

function collectEntries(select: HTMLSelectElement): { entries: MenuEntry[]; options: SelectOptionEntry[] } {
  const entries: MenuEntry[] = [];
  const options: SelectOptionEntry[] = [];

  const pushOption = (opt: HTMLOptionElement) => {
    if (opt.hidden) return;
    const entry: SelectOptionEntry = {
      kind: "option",
      option: opt,
      label: (opt.label || opt.textContent || "").trim(),
      disabled: opt.disabled || Boolean(opt.closest("optgroup")?.disabled),
      selected: opt.selected,
      indexInMenu: options.length,
    };
    options.push(entry);
    entries.push(entry);
  };

  for (const child of Array.from(select.children)) {
    if (child.tagName === "OPTGROUP") {
      const group = child as HTMLOptGroupElement;
      if (group.hidden) continue;
      const visibleChildren = Array.from(group.children).filter(
        (c): c is HTMLOptionElement => c.tagName === "OPTION" && !(c as HTMLOptionElement).hidden,
      );
      if (visibleChildren.length === 0) continue;
      if (group.label) {
        entries.push({ kind: "group", label: group.label });
      }
      for (const opt of visibleChildren) {
        pushOption(opt);
      }
    } else if (child.tagName === "OPTION") {
      pushOption(child as HTMLOptionElement);
    }
  }

  return { entries, options };
}

function setNativeSelectValue(select: HTMLSelectElement, nextValue: string): void {
  const win = select.ownerDocument.defaultView;
  const proto = win?.HTMLSelectElement?.prototype ?? (typeof HTMLSelectElement !== "undefined" ? HTMLSelectElement.prototype : null);
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
  if (descriptor?.set) {
    descriptor.set.call(select, nextValue);
  } else {
    select.value = nextValue;
  }
  const EventCtor = win?.Event ?? Event;
  select.dispatchEvent(new EventCtor("input", { bubbles: true }));
  select.dispatchEvent(new EventCtor("change", { bubbles: true }));
}

/**
 * Globally upgrades every single-select `<select>` element in the document (current and future)
 * with a unified, theme-adaptive floating menu UI while preserving native DOM & React contracts.
 */
export function installGlobalSelectMenus(root?: HTMLElement | Document): () => void {
  if (typeof document === "undefined") return () => {};
  const doc = root ? (root.nodeType === 9 ? (root as Document) : root.ownerDocument ?? document) : document;
  const targetRoot = root ?? doc.body ?? doc.documentElement;
  if (!targetRoot) return () => {};
  const win = doc.defaultView ?? window;

  let activeSelect: HTMLSelectElement | null = null;
  let activeMenu: HTMLDivElement | null = null;
  let activeOptions: SelectOptionEntry[] = [];
  let activeButtonEls: HTMLButtonElement[] = [];
  let highlightedIndex = -1;
  let openObserver: MutationObserver | null = null;
  let typeaheadBuffer = "";
  let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTypeahead() {
    typeaheadBuffer = "";
    if (typeaheadTimer !== null) {
      clearTimeout(typeaheadTimer);
      typeaheadTimer = null;
    }
  }

  function closeMenu(restoreFocus = false) {
    clearTypeahead();
    openObserver?.disconnect();
    openObserver = null;
    const prevSelect = activeSelect;
    if (prevSelect) {
      prevSelect.removeAttribute("data-select-open");
      prevSelect.removeAttribute("aria-expanded");
    }
    if (activeMenu) {
      activeMenu.remove();
    }
    activeSelect = null;
    activeMenu = null;
    activeOptions = [];
    activeButtonEls = [];
    highlightedIndex = -1;
    if (restoreFocus && prevSelect?.isConnected) {
      try {
        prevSelect.focus({ preventScroll: true });
      } catch {
        prevSelect.focus();
      }
    }
  }

  function setHighlight(nextIdx: number, scrollIntoView = true) {
    if (nextIdx < 0 || nextIdx >= activeButtonEls.length) return;
    highlightedIndex = nextIdx;
    for (let i = 0; i < activeButtonEls.length; i++) {
      const btn = activeButtonEls[i]!;
      const isHi = i === nextIdx;
      btn.classList.toggle("is-highlighted", isHi);
      if (isHi && scrollIntoView && typeof btn.scrollIntoView === "function") {
        btn.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function moveHighlight(delta: 1 | -1) {
    if (activeOptions.length === 0) return;
    const len = activeOptions.length;
    let idx = highlightedIndex;
    for (let step = 0; step < len; step++) {
      idx = idx < 0 ? (delta > 0 ? 0 : len - 1) : (idx + delta + len) % len;
      if (!activeOptions[idx]!.disabled) {
        setHighlight(idx);
        return;
      }
    }
  }

  function jumpEdge(toEnd: boolean) {
    if (activeOptions.length === 0) return;
    const start = toEnd ? activeOptions.length - 1 : 0;
    const step = toEnd ? -1 : 1;
    for (let i = start; i >= 0 && i < activeOptions.length; i += step) {
      if (!activeOptions[i]!.disabled) {
        setHighlight(i);
        return;
      }
    }
  }

  function commitOption(entry: SelectOptionEntry) {
    const select = activeSelect;
    if (!select || entry.disabled) return;
    const changed = select.value !== entry.option.value;
    closeMenu(true);
    if (changed) {
      setNativeSelectValue(select, entry.option.value);
    }
  }

  function positionMenu(select: HTMLSelectElement, menu: HTMLDivElement) {
    const rect = select.getBoundingClientRect();
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1280;
    const vh = win.innerHeight || doc.documentElement.clientHeight || 800;

    const minWidth = Math.max(Math.round(rect.width), 148);
    const maxWidth = Math.max(160, Math.min(380, vw - 16));
    menu.style.minWidth = `${Math.min(minWidth, maxWidth)}px`;
    menu.style.maxWidth = `${maxWidth}px`;

    const measured = menu.getBoundingClientRect();
    const estHeight = Math.min(measured.height || 240, 280);
    const spaceBelow = vh - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const placeTop = spaceBelow < Math.min(estHeight, 210) && spaceAbove > spaceBelow;

    menu.dataset.placement = placeTop ? "top" : "bottom";
    const maxH = Math.max(110, Math.min(280, (placeTop ? spaceAbove : spaceBelow) - 2));
    menu.style.maxHeight = `${Math.round(maxH)}px`;

    const finalHeight = Math.min(menu.getBoundingClientRect().height || estHeight, maxH);
    const rawTop = placeTop ? rect.top - finalHeight - 6 : rect.bottom + 6;
    const clampedTop = Math.max(8, Math.min(vh - finalHeight - 8, rawTop));

    const menuWidth = Math.max(minWidth, Math.round(menu.getBoundingClientRect().width));
    const clampedLeft = Math.max(8, Math.min(vw - Math.min(menuWidth, maxWidth) - 8, rect.left));

    menu.style.top = `${Math.round(clampedTop)}px`;
    menu.style.left = `${Math.round(clampedLeft)}px`;
  }

  function openMenu(select: HTMLSelectElement) {
    closeMenu(false);

    const { entries, options } = collectEntries(select);
    const menu = doc.createElement("div");
    menu.className = POPOVER_CLASS;
    menu.setAttribute("role", "listbox");
    const label = select.getAttribute("aria-label") || select.title || "";
    if (label) menu.setAttribute("aria-label", label);

    const buttons: HTMLButtonElement[] = [];

    if (entries.length === 0) {
      const empty = doc.createElement("div");
      empty.className = EMPTY_CLASS;
      empty.textContent = "—";
      menu.appendChild(empty);
    } else {
      for (const entry of entries) {
        if (entry.kind === "group") {
          const heading = doc.createElement("div");
          heading.className = GROUP_LABEL_CLASS;
          heading.setAttribute("role", "presentation");
          heading.textContent = entry.label;
          menu.appendChild(heading);
          continue;
        }
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = OPTION_CLASS;
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", entry.selected ? "true" : "false");
        btn.tabIndex = -1;
        if (entry.selected) btn.classList.add("is-selected");
        if (entry.disabled) {
          btn.disabled = true;
          btn.classList.add("is-disabled");
          btn.setAttribute("aria-disabled", "true");
        }

        const textSpan = doc.createElement("span");
        textSpan.className = "global-select-option-label";
        textSpan.textContent = entry.label;
        btn.appendChild(textSpan);

        if (entry.selected) {
          const checkWrap = doc.createElement("span");
          checkWrap.className = "global-select-option-check";
          checkWrap.innerHTML = CHECK_SVG;
          btn.appendChild(checkWrap);
        }

        btn.addEventListener("mouseenter", () => {
          if (!entry.disabled) setHighlight(entry.indexInMenu, false);
        });
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          commitOption(entry);
        });

        buttons.push(btn);
        menu.appendChild(btn);
      }
    }

    menu.addEventListener("mousedown", (e) => {
      // Keep focus on `<select>` so modal focus traps / blur listeners stay calm.
      e.preventDefault();
      e.stopPropagation();
    });

    const host = select.closest("dialog") ?? doc.body ?? doc.documentElement;
    menu.style.visibility = "hidden";
    host.appendChild(menu);

    positionMenu(select, menu);
    menu.style.removeProperty("visibility");

    activeSelect = select;
    activeMenu = menu;
    activeOptions = options;
    activeButtonEls = buttons;

    select.setAttribute("data-select-open", "true");
    select.setAttribute("aria-expanded", "true");

    const selectedIdx = options.findIndex((o) => o.selected && !o.disabled);
    const firstEnabled = options.findIndex((o) => !o.disabled);
    const initialIdx = selectedIdx >= 0 ? selectedIdx : firstEnabled;
    if (initialIdx >= 0) {
      setHighlight(initialIdx, true);
    }

    if (typeof MutationObserver === "function") {
      openObserver = new MutationObserver(() => {
        if (!activeSelect || !activeSelect.isConnected || activeSelect.disabled) {
          closeMenu(false);
        }
      });
      openObserver.observe(doc.body ?? doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
    }
  }

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (activeMenu && target && typeof target === "object" && "nodeType" in target && activeMenu.contains(target as Node)) return;

    if (isEligibleSelect(target)) {
      event.preventDefault();
      if (activeSelect === target) {
        closeMenu(false);
      } else {
        try {
          target.focus({ preventScroll: true });
        } catch {
          target.focus();
        }
        openMenu(target);
      }
      return;
    }

    if (activeMenu) {
      closeMenu(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (activeMenu && activeSelect) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key === "Tab") {
        closeMenu(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        moveHighlight(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveHighlight(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        jumpEdge(false);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        jumpEdge(true);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        const entry = highlightedIndex >= 0 ? activeOptions[highlightedIndex] : undefined;
        if (entry && !entry.disabled) {
          commitOption(entry);
        } else {
          closeMenu(true);
        }
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeaheadBuffer += event.key.toLowerCase();
        if (typeaheadTimer !== null) clearTimeout(typeaheadTimer);
        typeaheadTimer = setTimeout(clearTypeahead, 500);
        const matchIdx = activeOptions.findIndex(
          (o) => !o.disabled && o.label.toLowerCase().startsWith(typeaheadBuffer),
        );
        if (matchIdx >= 0) setHighlight(matchIdx, true);
        return;
      }
      return;
    }

    if (!isEligibleSelect(event.target)) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.target);
    }
  }

  function onScroll(event: Event) {
    if (!activeMenu) return;
    const target = event.target;
    if (target && typeof target === "object" && "nodeType" in target && activeMenu.contains(target as Node)) return;
    closeMenu(false);
  }

  function onResize() {
    if (activeMenu) closeMenu(false);
  }

  targetRoot.addEventListener("mousedown", onMouseDown as EventListener, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", onScroll, true);
  win.addEventListener("resize", onResize);
  win.addEventListener("blur", onResize);

  return () => {
    closeMenu(false);
    targetRoot.removeEventListener("mousedown", onMouseDown as EventListener, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("resize", onResize);
    win.removeEventListener("blur", onResize);
  };
}

export function useGlobalSelectMenus(): void {
  useEffect(() => installGlobalSelectMenus(), []);
}
