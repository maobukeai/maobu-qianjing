import assert from "node:assert/strict";
import { act, useLayoutEffect, useRef, useState } from "react";
import type { HTMLElement as DomElement, HTMLInputElement as DomInput, HTMLButtonElement as DomButton } from "happy-dom";
import { CommandPalette, type CommandPaletteCommand, type CommandPaletteProfile } from "../web/command-palette.tsx";
import { useDesktopMotion } from "../web/desktop-motion.tsx";
import { hasActiveWorkbenchModal } from "../web/workbench-shortcuts.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const requests: string[] = [], unexpected: string[] = [];
  const fakeFetch = Object.assign(async (input: RequestInfo | URL): Promise<Response> => {
    requests.push(String(input)); if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    unexpected.push(String(input)); throw new Error(`Profile locator must not read details or launch browsers: ${String(input)}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking disabled"); } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value(this: DomElement) { return this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [{ x: 0, y: 0, width: 600, height: 32, top: 0, left: 0, right: 600, bottom: 32 }]; } });
  const now = Date.now(), size = scenario === "cap-count" ? 5000 : scenario === "public-search" ? 1600 : 3;
  const profiles: CommandPaletteProfile[] = Array.from({ length: size }, (_, index) => ({ id: `environment_${index}`, name: `Environment ${index}`, group: `Group ${index % 5}`, tags: [`tag_${index % 7}`], running: index % 2 === 0, lastOpenAt: now - (size - index) * 1000 }));
  if (scenario === "public-search") Object.assign(profiles[1599]!, { name: "Résumé café target", group: "Rare group", tags: ["Needle", "中文"] });
  const favorites = new Set([profiles[0]!.id]);
  const commands: CommandPaletteCommand[] = [{ id: "sample", label: "Sample command", description: "Original mode action", run: () => { commandCalls++; } }];
  let commandCalls = 0, closes = 0; const located: string[] = [];
  function Surface() {
    useDesktopMotion();
    const [open, setOpen] = useState(false), [current, setCurrent] = useState(profiles), [selected, setSelected] = useState(""), [nextDialog, setNextDialog] = useState(false);
    const row = useRef<HTMLButtonElement>(null), editor = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => { if (nextDialog) editor.current?.focus(); else if (selected) row.current?.focus(); }, [selected, nextDialog]);
    return <><button type="button" data-open onClick={() => setOpen(true)}>Open palette</button><button type="button" data-target ref={row}>Located row {selected}</button><button type="button" data-remove onClick={() => setCurrent([])}>Remove all environments</button>
      <CommandPalette commands={commands} open={open} onClose={() => { closes++; setOpen(false); }} {...(scenario === "legacy" ? {} : { profiles: current, favoriteIds: favorites, onLocateProfile: (id: string) => {
        assert.equal(hasActiveWorkbenchModal(dom.window.document as unknown as Document), false, "Location must be handed off after the palette close commit");
        located.push(id); if (scenario === "locate-new-dialog") setNextDialog(true); else setSelected(id);
      } })} />
      {nextDialog && <div role="dialog" aria-label="Next task"><input ref={editor} data-editor aria-label="Next task input" /></div>}
    </>;
  }
  const raw = () => dom.window.document.querySelector<DomElement>('[data-command-palette="true"]');
  const palette = () => { const node = raw(); return node && !node.closest('[inert], [aria-hidden="true"]') ? node : null; };
  const input = () => palette()!.querySelector<DomInput>('input[role="combobox"]')!;
  const options = () => [...palette()!.querySelectorAll<DomElement>('[role="option"]')];
  const selectedOption = () => palette()!.querySelector<DomElement>('[role="option"][aria-selected="true"]');
  const trigger = () => dom.container.querySelector<DomButton>("[data-open]")!;
  const tab = (mode: "profiles" | "commands") => [...palette()!.querySelectorAll<DomButton>('[role="tab"]')].find(node => node.textContent === (mode === "profiles" ? "Environments" : "Commands"))!;
  const click = async (node: DomElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const open = async () => { trigger().focus(); await click(trigger()); assert.ok(palette()); };
  const type = async (value: string) => act(async () => { const target = input(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(target, value); target.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const key = async (value: string, overrides: Record<string, boolean | number> = {}, target: DomElement = input()) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...overrides })); });
  try {
    await dom.render(<I18nProvider><Surface /></I18nProvider>); await open();
    assert.equal(input().getAttribute("aria-label"), "Search commands");
    if (scenario === "legacy") { assert.equal(palette()!.querySelector('[role="tablist"]'), null); await key("Enter"); assert.equal(commandCalls, 1); assert.equal(located.length, 0); return; }
    assert.equal(tab("commands").getAttribute("aria-selected"), "true"); assert.equal(tab("profiles").getAttribute("aria-selected"), "false");
    if (scenario === "mode-default") {
      await type("Environment 1"); await click(tab("profiles")); assert.equal(input().value, "Environment 1"); assert.equal(options().length, 1);
      assert.equal(input().getAttribute("aria-label"), "Search environments"); assert.equal(dom.window.document.getElementById(input().getAttribute("aria-controls")!)?.getAttribute("role"), "listbox");
      await key("Escape"); assert.equal(palette(), null); await open(); assert.equal(input().getAttribute("aria-label"), "Search commands"); assert.equal(input().value, ""); return;
    }
    if (scenario === "tabs-focus") {
      tab("commands").focus(); await key("ArrowRight", {}, tab("commands")); assert.equal(tab("profiles").getAttribute("aria-selected"), "true"); assert.ok(dom.window.document.activeElement === tab("profiles"));
      assert.equal(palette()!.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), tab("profiles").id);
      await key("Tab", { shiftKey: true }, tab("profiles")); assert.ok(dom.window.document.activeElement === palette()!.querySelector('[aria-label="Close command palette"]'), "Shift+Tab from the first active tab must wrap to the last control");
      await key("Tab", {}, dom.window.document.activeElement as DomElement); assert.ok(dom.window.document.activeElement === tab("profiles"));
      await key("Home", {}, tab("profiles")); assert.equal(tab("commands").getAttribute("aria-selected"), "true"); assert.ok(dom.window.document.activeElement === tab("commands")); return;
    }
    await click(tab("profiles")); assert.equal(options()[0]?.dataset.profileId, profiles[0]!.id, "Favorites must lead an empty environment query");
    if (scenario === "public-search") {
      assert.ok(options()[0]?.querySelector('[aria-label="Favorite"]'));
      await type("RESUME rare needle 中文"); assert.equal(options().length, 1); assert.equal(options()[0]?.dataset.profileId, "environment_1599");
      assert.ok(options()[0]?.textContent.includes("Rare group")); assert.ok(options()[0]?.textContent.includes("Needle"));
      await key("Enter"); assert.deepEqual(located, ["environment_1599"]); assert.equal(commandCalls, 0); return;
    }
    if (scenario === "cap-count") {
      assert.equal(options().length, 50); assert.ok(palette()!.textContent.includes("5000 environments")); assert.ok(palette()!.textContent.includes("Showing 50 of 5000 matches."));
      await type("environment_4999"); assert.equal(options().length, 1); assert.equal(options()[0]?.dataset.profileId, "environment_4999"); assert.ok(!palette()!.textContent.includes("Showing 50")); return;
    }
    if (scenario === "empty-live") {
      await type("unmatched"); assert.equal(options().length, 0); assert.ok(palette()!.textContent.includes("No matching environments")); assert.equal(input().hasAttribute("aria-activedescendant"), false);
      await key("Enter"); assert.ok(palette()); assert.equal(located.length, 0);
      await click(dom.container.querySelector<DomButton>("[data-remove]")!); assert.ok(palette()!.textContent.includes("No environments available")); assert.equal(options().length, 0); assert.equal(input().hasAttribute("aria-activedescendant"), false); return;
    }
    if (scenario === "keyboard-ime" || scenario === "locate-new-dialog") {
      await key("ArrowDown"); assert.equal(selectedOption()?.dataset.profileId, profiles[2]!.id);
      await key("Home"); assert.equal(selectedOption()?.dataset.profileId, profiles[0]!.id);
      await key("ArrowDown", { repeat: true }); assert.equal(selectedOption()?.dataset.profileId, profiles[2]!.id, "Holding an arrow key must retain ordinary result navigation");
      await key("End"); assert.equal(selectedOption()?.dataset.profileId, profiles[1]!.id);
      assert.equal(input().getAttribute("aria-activedescendant"), selectedOption()?.id);
      await key("Enter", { isComposing: true }); await key("Enter", { keyCode: 229 }); await key("Enter", { repeat: true }); assert.deepEqual(located, []);
      await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })); }); await key("Enter"); assert.deepEqual(located, []);
      await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true })); });
      const source = input(); await act(async () => { source.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); source.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
      assert.deepEqual(located, [profiles[1]!.id]); assert.equal(closes, 1); assert.equal(commandCalls, 0); assert.equal(palette(), null);
      assert.ok(raw()?.closest('[inert][aria-hidden="true"]'), "The profile mode exit must retain only its inert visual snapshot");
      if (scenario === "locate-new-dialog") assert.ok(dom.window.document.activeElement === dom.container.querySelector("[data-editor]"), "Closing the palette must not pull focus from the next task");
      else assert.ok(dom.window.document.activeElement === dom.container.querySelector("[data-target]"), "The removed focus trap must let the roster own focus");
      await act(async () => { source.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }); assert.equal(located.length, 1); return;
    }
    throw new Error(`Unknown profile palette scenario: ${scenario}`);
  } finally {
    try { await dom.cleanup(); } finally { assert.deepEqual(unexpected, []); assert.ok(requests.every(path => path === "/ui/api/shell-language"), "Locating profiles must be entirely local to public roster metadata"); }
  }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "mode-default"); console.log("command profile search interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
