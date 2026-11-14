import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { I18nProvider } from "./i18n.tsx";
import { CommandPalette, filterCommands, isCommandPaletteShortcut, isShortcutTargetAllowed, nextCommandIndex, type CommandPaletteCommand } from "./command-palette.tsx";

const noop = () => {};
const commands: CommandPaletteCommand[] = [
  { id: "settings", label: "Settings", description: "Network and proxy configuration", keywords: ["preferences", "connection"], run: noop },
  { id: "new", label: "New profile", description: "Create an isolated browser", keywords: "add environment", shortcut: "Ctrl+N", run: noop },
  { id: "refresh", label: "Refresh profiles", description: "Refresh the local list", run: noop },
  { id: "export", label: "Export profiles", disabled: true, run: noop },
];

describe("command search and keyboard selection", () => {
  test("matches all words across label, description and aliases without modifying caller data", () => {
    expect(filterCommands(commands, "proxy connection").map(command => command.id)).toEqual(["settings"]);
    expect(filterCommands(commands, "add browser").map(command => command.id)).toEqual(["new"]);
    expect(filterCommands(commands, "missing proxy")).toEqual([]);
    expect(filterCommands(commands, "  ")).toEqual(commands);
    expect(commands.map(command => command.id)).toEqual(["settings", "new", "refresh", "export"]);
  });

  test("searches translated labels and descriptions while retaining original command callbacks", () => {
    const dictionary: Record<string, string> = { Settings: "设置", "Network and proxy configuration": "网络与代理配置" };
    const result = filterCommands(commands, "代理", value => dictionary[value] ?? value);
    expect(result).toEqual([commands[0]!]);
    expect(result[0]?.run).toBe(commands[0]!.run);
    expect(filterCommands(commands, "Settings", value => dictionary[value] ?? value)[0]?.id).toBe("settings");
  });

  test("normalizes case, full-width text and diacritics, and ranks labels above incidental matches", () => {
    const rows = [
      { id: "note", label: "Other action", description: "Open the résumé", run: noop },
      { id: "resume", label: "Résumé", run: noop },
      { id: "profiles", label: "PROFILE", run: noop },
    ];
    expect(filterCommands(rows, "RESUME").map(command => command.id)).toEqual(["resume", "note"]);
    expect(filterCommands(rows, "ｐｒｏｆｉｌｅ").map(command => command.id)).toEqual(["profiles"]);
  });

  test("keeps disabled results discoverable and avoids ambiguous duplicate command IDs", () => {
    expect(filterCommands(commands, "export")[0]?.disabled).toBe(true);
    const duplicate = { ...commands[0]!, label: "Another settings action" };
    expect(filterCommands([...commands, duplicate], "").filter(command => command.id === "settings")).toEqual([commands[0]!]);
  });

  test("wraps around enabled commands and handles unavailable or removed selections", () => {
    const rows = [{ disabled: true }, {}, { disabled: true }, {}];
    expect(nextCommandIndex(rows, -1, "ArrowDown")).toBe(1);
    expect(nextCommandIndex(rows, -1, "ArrowUp")).toBe(3);
    expect(nextCommandIndex(rows, 1, "ArrowDown")).toBe(3);
    expect(nextCommandIndex(rows, 3, "ArrowDown")).toBe(1);
    expect(nextCommandIndex(rows, 1, "ArrowUp")).toBe(3);
    expect(nextCommandIndex(rows, 50, "Home")).toBe(1);
    expect(nextCommandIndex(rows, 50, "End")).toBe(3);
    expect(nextCommandIndex([{ disabled: true }], -1, "ArrowDown")).toBe(-1);
    expect(nextCommandIndex([], -1, "End")).toBe(-1);
  });

  test("recognizes only an unhandled, non-repeated Ctrl/Cmd+K outside composition", () => {
    const event = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, isComposing: false };
    expect(isCommandPaletteShortcut(event)).toBe(true);
    expect(isCommandPaletteShortcut({ ...event, ctrlKey: false, metaKey: true, key: "K" })).toBe(true);
    for (const patch of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { repeat: true }, { defaultPrevented: true }, { isComposing: true }, { key: "n" }]) {
      expect(isCommandPaletteShortcut({ ...event, ...patch })).toBe(false);
    }
  });

  test("does not steal shortcuts from an editable ancestor or a visible modal", () => {
    const editable = { closest: () => ({}), ownerDocument: undefined } as unknown as EventTarget;
    expect(isShortcutTargetAllowed(editable)).toBe(false);
    const visibleModal = { closest: () => null, getClientRects: () => [{ width: 500, height: 300 }] };
    const hiddenModal = { closest: () => ({}), getClientRects: () => [{ width: 500, height: 300 }] };
    const hiddenByCSS = { closest: () => null, getClientRects: () => [] };
    const documentWith = (elements: unknown[]) => ({ querySelectorAll: () => elements }) as unknown as Document;
    expect(isShortcutTargetAllowed(null, documentWith([visibleModal]))).toBe(false);
    expect(isShortcutTargetAllowed(null, documentWith([hiddenModal, hiddenByCSS]))).toBe(true);
    expect(isShortcutTargetAllowed(null, documentWith([]))).toBe(true);
  });
});

type ElementView = { tag: string; attrs: Record<string, string> };
async function elementsIn(html: string): Promise<ElementView[]> {
  const elements: ElementView[] = [];
  await new HTMLRewriter().on("*", { element(element) { elements.push({ tag: element.tagName, attrs: Object.fromEntries(element.attributes) }); } }).transform(new Response(html)).text();
  return elements;
}

describe("command dialog accessibility", () => {
  test("connects the named dialog, combobox, listbox and enabled active option", async () => {
    let invoked = 0;
    const rows = commands.map(command => ({ ...command, run: () => { invoked++; } }));
    rows[0]!.disabled = true;
    const html = renderToStaticMarkup(<I18nProvider><CommandPalette commands={rows} open onClose={noop} /></I18nProvider>);
    const elements = await elementsIn(html);
    const dialog = elements.find(element => element.attrs.role === "dialog")!;
    const input = elements.find(element => element.attrs.role === "combobox")!;
    const list = elements.find(element => element.attrs.role === "listbox")!;
    const options = elements.filter(element => element.attrs.role === "option");
    expect(dialog.attrs["aria-modal"]).toBe("true");
    expect(elements.some(element => element.tag === "h2" && element.attrs.id === dialog.attrs["aria-labelledby"])).toBe(true);
    expect(elements.some(element => element.attrs.id === dialog.attrs["aria-describedby"])).toBe(true);
    expect(input.attrs["aria-controls"]).toBe(list.attrs.id);
    const selected = options.filter(element => element.attrs["aria-selected"] === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.attrs.id).toBe(input.attrs["aria-activedescendant"]);
    expect(selected[0]?.attrs["aria-disabled"]).toBeUndefined();
    expect(options[0]?.attrs["aria-disabled"]).toBe("true");
    expect(invoked).toBe(0);
  });

  test("an empty or fully disabled menu never points at an unavailable option", async () => {
    for (const rows of [[], commands.map(command => ({ ...command, disabled: true }))]) {
      const html = renderToStaticMarkup(<I18nProvider><CommandPalette commands={rows} open onClose={noop} /></I18nProvider>);
      const elements = await elementsIn(html);
      expect(elements.find(element => element.attrs.role === "combobox")?.attrs["aria-activedescendant"]).toBeUndefined();
      expect(elements.some(element => element.attrs["aria-selected"] === "true")).toBe(false);
      if (!rows.length) expect(elements.some(element => element.attrs.role === "status")).toBe(true);
    }
  });

  test("closed palettes render no hidden dialog and multiple instances use unique accessible IDs", async () => {
    expect(renderToStaticMarkup(<I18nProvider><CommandPalette commands={commands} open={false} onClose={noop} /></I18nProvider>)).toBe("");
    const html = renderToStaticMarkup(<I18nProvider><CommandPalette commands={commands} open onClose={noop} /><CommandPalette commands={commands} open onClose={noop} /></I18nProvider>);
    const ids = (await elementsIn(html)).flatMap(element => element.attrs.id ? [element.attrs.id] : []);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

for (const scenario of ["palette-exit", "palette-reopen-keyboard", "palette-execute-focus", "palette-reduced"]) {
  test(`command palette motion: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/menu-motion-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("menu motion interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
