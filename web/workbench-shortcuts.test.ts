import { expect, test } from "bun:test";
import { getWorkbenchShortcut, workbenchShortcutCatalog, type WorkbenchKeyEvent, type WorkbenchShortcutContext } from "./workbench-shortcuts.ts";

const context: WorkbenchShortcutContext = { desktop: true, editable: false, modalOpen: false };
const key = (value: string, overrides: Partial<WorkbenchKeyEvent> = {}): WorkbenchKeyEvent => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...overrides });

test("workbench maps plain search/help and the existing Ctrl/Cmd K toggle", () => {
  expect(getWorkbenchShortcut(key("/"), context)).toBe("focus-profile-search");
  expect(getWorkbenchShortcut(key("/", { shiftKey: true }), context)).toBe("focus-profile-search");
  expect(getWorkbenchShortcut(key("?", { shiftKey: true }), context)).toBe("open-shortcut-help");
  for (const primary of [{ ctrlKey: true }, { metaKey: true }]) {
    expect(getWorkbenchShortcut(key("k", primary), context)).toBe("toggle-command-palette");
    expect(getWorkbenchShortcut(key("N", primary), context)).toBe("create-profile");
  }
});
test("desktop navigation uses Alt 1–5 and macOS Option physical digit keys", () => {
  const actions = ["go-profiles", "go-proxies", "go-scripts", "go-assistant", "go-extensions"] as const;
  actions.forEach((action, index) => {
    expect(getWorkbenchShortcut(key(String(index + 1), { altKey: true }), context)).toBe(action);
    expect(getWorkbenchShortcut(key("¡", { altKey: true, code: `Digit${index + 1}` }), context)).toBe(action);
  });
  expect(getWorkbenchShortcut(key("6", { altKey: true, code: "Digit6" }), context)).toBeNull();
});
test("a browser keeps native new-window and Alt navigation while retaining shell search/help", () => {
  const browser = { ...context, desktop: false };
  expect(getWorkbenchShortcut(key("n", { ctrlKey: true }), browser)).toBeNull();
  expect(getWorkbenchShortcut(key("n", { metaKey: true }), browser)).toBeNull();
  for (let digit = 1; digit <= 5; digit++) expect(getWorkbenchShortcut(key(String(digit), { altKey: true }), browser)).toBeNull();
  expect(getWorkbenchShortcut(key("/"), browser)).toBe("focus-profile-search");
  expect(getWorkbenchShortcut(key("?"), browser)).toBe("open-shortcut-help");
});
test("all global actions yield to typing, active modal tasks, handled/repeated keys and IME", () => {
  const shortcuts = [key("/"), key("?"), key("k", { ctrlKey: true }), key("n", { metaKey: true }), key("3", { altKey: true })];
  for (const event of shortcuts) {
    expect(getWorkbenchShortcut(event, { ...context, editable: true })).toBeNull();
    expect(getWorkbenchShortcut(event, { ...context, modalOpen: true })).toBeNull();
    for (const blocked of [{ repeat: true }, { defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) expect(getWorkbenchShortcut({ ...event, ...blocked }, context)).toBeNull();
  }
});
test("only the palette toggle may close its own dialog while its search field has focus", () => {
  const palette = { ...context, editable: true, modalOpen: true, commandPaletteOpen: true };
  expect(getWorkbenchShortcut(key("k", { metaKey: true }), palette)).toBe("toggle-command-palette");
  for (const event of [key("?"), key("/"), key("n", { ctrlKey: true }), key("1", { altKey: true })]) expect(getWorkbenchShortcut(event, palette)).toBeNull();
  expect(getWorkbenchShortcut(key("k", { ctrlKey: true, isComposing: true }), palette)).toBeNull();
});
test("shell matching leaves AI send, native window keys, AltGr and modified shortcuts alone", () => {
  for (const event of [key("Enter", { metaKey: true }), key("w", { ctrlKey: true }), key("F4", { altKey: true }), key("k", { ctrlKey: true, shiftKey: true }), key("n", { ctrlKey: true, altKey: true }), key("1", { altKey: true, ctrlKey: true }), key("?", { metaKey: true }), key("/", { ctrlKey: true }), key("k", { ctrlKey: true, metaKey: true })]) expect(getWorkbenchShortcut(Object.freeze(event), context)).toBeNull();
});
test("the guide lists only matching implemented keys for each host and platform", () => {
  expect(workbenchShortcutCatalog({ desktop: false, mac: false }).map(item => item.action)).toEqual(["toggle-command-palette", "focus-profile-search", "open-shortcut-help"]);
  for (const mac of [true, false]) {
    const rows = workbenchShortcutCatalog({ desktop: true, mac });
    expect(new Set(rows.map(row => row.action)).size).toBe(9);
    for (const row of rows) {
      const last = row.keys.at(-1)!;
      const modifier = row.keys[0];
      const event = key(last, { metaKey: modifier === "⌘", ctrlKey: modifier === "Ctrl", altKey: modifier === "Alt" || modifier === "⌥" });
      expect(getWorkbenchShortcut(event, context)).toBe(row.action);
    }
  }
});
