import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { HTMLButtonElement as HappyButton, HTMLElement as HappyElement } from "happy-dom";
import { Window } from "happy-dom";
import { createWebDomHarness } from "../test-fixtures/web-dom.ts";
import { I18nProvider } from "./i18n.tsx";
import {
  WorkbenchContextMenu,
  clampContextMenuPosition,
  shouldAllowNativeContextMenu,
  type WorkbenchContextMenuState,
} from "./workbench-context-menu.tsx";

describe("shouldAllowNativeContextMenu", () => {
  test("allows native menu for Shift+Right-Click, editable inputs, and selected text", () => {
    const dom = new Window({ url: "http://127.0.0.1/" });
    const textInput = dom.document.createElement("input");
    textInput.type = "text";
    const searchInput = dom.document.createElement("input");
    searchInput.type = "search";
    const passwordInput = dom.document.createElement("input");
    passwordInput.type = "password";
    const checkbox = dom.document.createElement("input");
    checkbox.type = "checkbox";
    const radio = dom.document.createElement("input");
    radio.type = "radio";
    const textarea = dom.document.createElement("textarea");
    const editable = dom.document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const editableChild = dom.document.createElement("span");
    editable.appendChild(editableChild);
    const plainEditable = dom.document.createElement("div");
    plainEditable.setAttribute("contenteditable", "");
    const button = dom.document.createElement("button");
    const cell = dom.document.createElement("td");

    expect(shouldAllowNativeContextMenu(cell as unknown as EventTarget, true, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(textInput as unknown as EventTarget, false, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(searchInput as unknown as EventTarget, false, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(passwordInput as unknown as EventTarget, false, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(textarea as unknown as EventTarget, false, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(editableChild as unknown as EventTarget, false, "")).toBe(true);
    expect(shouldAllowNativeContextMenu(plainEditable as unknown as EventTarget, false, "")).toBe(true);

    expect(shouldAllowNativeContextMenu(checkbox as unknown as EventTarget, false, "")).toBe(false);
    expect(shouldAllowNativeContextMenu(radio as unknown as EventTarget, false, "")).toBe(false);
    expect(shouldAllowNativeContextMenu(button as unknown as EventTarget, false, "")).toBe(false);
    expect(shouldAllowNativeContextMenu(cell as unknown as EventTarget, false, "")).toBe(false);
    expect(shouldAllowNativeContextMenu(cell as unknown as EventTarget, false, "   ")).toBe(false);
    expect(shouldAllowNativeContextMenu(cell as unknown as EventTarget, false, "selected text")).toBe(true);
  });
});

describe("clampContextMenuPosition", () => {
  test("keeps in-bounds coordinates, flips on right/bottom overflow, and clamps tiny viewports", () => {
    expect(
      clampContextMenuPosition({ x: 120, y: 140 }, { width: 220, height: 180 }, { width: 1280, height: 800 }),
    ).toEqual({ left: 120, top: 140 });

    expect(
      clampContextMenuPosition({ x: 1180, y: 140 }, { width: 220, height: 180 }, { width: 1280, height: 800 }),
    ).toEqual({ left: 960, top: 140 });

    expect(
      clampContextMenuPosition({ x: 120, y: 740 }, { width: 220, height: 180 }, { width: 1280, height: 800 }),
    ).toEqual({ left: 120, top: 560 });

    expect(
      clampContextMenuPosition({ x: 50, y: 60 }, { width: 240, height: 220 }, { width: 200, height: 180 }),
    ).toEqual({ left: 8, top: 8 });
  });
});

describe("WorkbenchContextMenu interactions", () => {
  test("opens menu, invokes items, switches inline density, supports keyboard navigation, and closes on Escape or outside pointerdown", async () => {
    const dom = await createWebDomHarness();
    const events: string[] = [];
    let openMenu!: (next: WorkbenchContextMenuState | null) => void;

    function Harness() {
      const [density, setDensity] = useState<"comfortable" | "standard" | "compact">("comfortable");
      const [menu, setMenu] = useState<WorkbenchContextMenuState | null>({
        x: 100,
        y: 120,
        header: "Environments",
        items: [
          {
            kind: "item",
            id: "new-env",
            label: "New Profile",
            tone: "primary",
            onSelect: () => events.push("new"),
          },
          {
            kind: "item",
            id: "disabled-env",
            label: "Delete environment",
            tone: "danger",
            disabled: true,
            onSelect: () => events.push("disabled"),
          },
          { kind: "separator", id: "sep-1" },
          {
            kind: "density",
            id: "density-row",
            label: "Density",
            value: density,
            options: [
              { value: "comfortable", label: "Comfortable" },
              { value: "standard", label: "Standard" },
              { value: "compact", label: "Compact" },
            ],
            onSelect: (next) => {
              events.push(`density:${next}`);
              setDensity(next);
            },
          },
        ],
      });
      openMenu = setMenu;
      return (
        <I18nProvider>
          <div className="host">
            <WorkbenchContextMenu state={menu} onClose={() => setMenu(null)} />
          </div>
        </I18nProvider>
      );
    }

    try {
      dom.window.happyDOM.setViewport({ width: 1280, height: 800 });
      await dom.render(<Harness />);

      const menuEl = () => dom.window.document.querySelector<HappyElement>('.workbench-context-menu[role="menu"]');
      expect(menuEl()).toBeTruthy();
      expect(menuEl()?.querySelector(".wcm-header")?.textContent).toBe("Environments");

      // Disabled item must not invoke callback or close menu
      const disabledBtn = [...menuEl()!.querySelectorAll<HappyButton>('[role="menuitem"]')].find((b) =>
        b.textContent?.includes("Delete environment"),
      )!;
      expect(disabledBtn.disabled).toBe(true);
      await act(async () => {
        disabledBtn.click();
      });
      expect(events).toEqual([]);
      expect(menuEl()).toBeTruthy();

      // Keyboard navigation skips disabled item and moves from Start to Density radios and Home/End
      const firstEnabled = menuEl()!.querySelector<HappyButton>('[role="menuitem"]:not(:disabled)')!;
      await act(async () => {
        menuEl()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as never);
      });
      expect(dom.window.document.activeElement).toBe(firstEnabled as never);

      await act(async () => {
        menuEl()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }) as never);
      });
      const compactRadio = [...menuEl()!.querySelectorAll<HappyButton>('[role="menuitemradio"]')].find((b) =>
        b.textContent?.includes("Compact"),
      )!;
      expect(dom.window.document.activeElement).toBe(compactRadio as never);

      await act(async () => {
        menuEl()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }) as never);
      });
      expect(dom.window.document.activeElement).toBe(firstEnabled as never);

      // Clicking density pill invokes onSelect and closes menu
      await act(async () => {
        compactRadio.click();
      });
      expect(events).toEqual(["density:compact"]);
      expect(menuEl()).toBeNull();

      // Reopen and test item invocation
      await act(async () => {
        openMenu({
          x: 60,
          y: 80,
          header: "#1 · Alpha",
          items: [
            { kind: "item", id: "start", label: "Start", tone: "primary", onSelect: () => events.push("start") },
          ],
        });
      });
      expect(menuEl()).toBeTruthy();
      const startBtn = menuEl()!.querySelector<HappyButton>('[role="menuitem"]')!;
      await act(async () => {
        startBtn.click();
      });
      expect(events).toEqual(["density:compact", "start"]);
      expect(menuEl()).toBeNull();

      // Reopen and test Escape closes
      await act(async () => {
        openMenu({
          x: 60,
          y: 80,
          items: [{ kind: "item", id: "refresh", label: "Refresh", onSelect: () => events.push("refresh") }],
        });
      });
      expect(menuEl()).toBeTruthy();
      await act(async () => {
        menuEl()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
      });
      expect(menuEl()).toBeNull();

      // Reopen and test outside pointerdown closes
      await act(async () => {
        openMenu({
          x: 60,
          y: 80,
          items: [{ kind: "item", id: "refresh", label: "Refresh", onSelect: () => events.push("refresh") }],
        });
      });
      expect(menuEl()).toBeTruthy();
      await act(async () => {
        dom.window.document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }) as never);
      });
      expect(menuEl()).toBeNull();
    } finally {
      await dom.cleanup();
    }
  });
});
