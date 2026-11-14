/** These actions describe shell navigation only; editors keep their own keys. */
export type WorkbenchShortcutAction =
  | "toggle-command-palette" | "focus-profile-search" | "open-shortcut-help" | "create-profile"
  | "go-profiles" | "go-proxies" | "go-scripts" | "go-assistant" | "go-extensions";

export interface WorkbenchShortcutContext {
  desktop: boolean;
  editable: boolean;
  modalOpen: boolean;
  /** Allows the palette's existing Ctrl/Cmd+K toggle to close its own dialog. */
  commandPaletteOpen?: boolean;
}
export type WorkbenchKeyEvent = Pick<KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented" | "isComposing">
  & Partial<Pick<KeyboardEvent, "code" | "keyCode">>;

const NAVIGATION: readonly WorkbenchShortcutAction[] = ["go-profiles", "go-proxies", "go-scripts", "go-assistant", "go-extensions"];

/** Side-effect-free matching: the caller prevents default only after accepting an action. */
export function getWorkbenchShortcut(event: WorkbenchKeyEvent, context: WorkbenchShortcutContext): WorkbenchShortcutAction | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return null;
  const primary = event.ctrlKey !== event.metaKey;
  const palette = primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
  if (palette && context.commandPaletteOpen) return "toggle-command-palette";
  if (context.editable || context.modalOpen) return null;
  if (palette) return "toggle-command-palette";
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === "/") return "focus-profile-search";
    if (event.key === "?") return "open-shortcut-help";
  }
  if (!context.desktop) return null;
  if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") return "create-profile";
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    // Option changes event.key on macOS; physical Digit codes keep the displayed chord usable.
    const digit = /^Digit([1-5])$/.exec(event.code ?? "")?.[1] ?? (/^[1-5]$/.test(event.key) ? event.key : undefined);
    if (digit) return NAVIGATION[Number(digit) - 1] ?? null;
  }
  return null;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? target as Element : null;
}
function hidden(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
  }
  return false;
}

/** A closing surface may ignore itself while checking whether another task owns focus. */
export function hasActiveWorkbenchModal(document: Document, ignored?: Element | null): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .modal-backdrop'))
    .some(node => (!ignored || node !== ignored && !node.contains(ignored) && !ignored.contains(node)) && !hidden(node));
}

/** DOM facts are kept separate from matching, and retained visual exits never block shortcuts. */
export function readWorkbenchShortcutContext(target: EventTarget | null, ownerDocument?: Document): Pick<WorkbenchShortcutContext, "editable" | "modalOpen"> {
  const element = asElement(target);
  const editableHost = element?.closest("[contenteditable]");
  const editable = !!element?.closest('input, textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]')
    || !!editableHost && editableHost.getAttribute("contenteditable") !== "false";
  const document = ownerDocument ?? element?.ownerDocument ?? (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
  const modalOpen = !!document && hasActiveWorkbenchModal(document);
  return { editable, modalOpen };
}

export interface WorkbenchShortcutDescription {
  action: WorkbenchShortcutAction;
  label: string;
  keys: readonly string[];
  group: "everyday" | "navigation";
}
/** The guide and matcher share one catalogue; web mode omits desktop-only chords. */
export function workbenchShortcutCatalog({ desktop, mac }: { desktop: boolean; mac: boolean }): readonly WorkbenchShortcutDescription[] {
  const primary = mac ? "⌘" : "Ctrl", alternate = mac ? "⌥" : "Alt";
  return [
    { action: "toggle-command-palette", label: "Command palette", keys: [primary, "K"], group: "everyday" },
    { action: "focus-profile-search", label: "Search environments", keys: ["/"], group: "everyday" },
    { action: "open-shortcut-help", label: "Keyboard shortcuts", keys: ["?"], group: "everyday" },
    ...(desktop ? [
      { action: "create-profile", label: "New environment", keys: [primary, "N"], group: "everyday" },
      ...(["All environments", "Proxies", "Automation scripts", "AI workspace", "Extensions"] as const)
        .map((label, index) => ({ action: NAVIGATION[index]!, label, keys: [alternate, String(index + 1)], group: "navigation" as const })),
    ] : []),
  ] as WorkbenchShortcutDescription[];
}
