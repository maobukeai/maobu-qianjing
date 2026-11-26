import { afterEach, describe, expect, test } from "bun:test";
import {
  Window,
  type HTMLButtonElement as HappyButtonElement,
  type HTMLInputElement as HappyInputElement,
  type HTMLTextAreaElement as HappyTextAreaElement,
} from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import { InlineProfileNameEditor, QuickProfileNotesEditor } from "./inline-profile-editors.tsx";
import {
  aggregateProfileTagCounts,
  matchesTagFilter,
  TagFilterBar,
  type TagFilterMode,
} from "./tag-filter-bar.tsx";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function createDomHarness() {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  // When another test file imports react-dom/client before a DOM exists, React caches
  // isInputEventSupported=false and falls back to the legacy IE8 attachEvent/detachEvent
  // focusin/focusout tracker. Provide safe no-ops on this test Window's HTMLElement prototype.
  const elemProto = dom.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof elemProto.attachEvent !== "function") elemProto.attachEvent = () => {};
  if (typeof elemProto.detachEvent !== "function") elemProto.detachEvent = () => {};
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const originalFetch = globalThis.fetch;
  setGlobal("window", dom);
  setGlobal("document", dom.document);
  setGlobal("navigator", dom.navigator);
  setGlobal("localStorage", dom.localStorage);
  setGlobal("HTMLElement", dom.HTMLElement);
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("HTMLTextAreaElement", dom.HTMLTextAreaElement);
  setGlobal("HTMLSelectElement", dom.HTMLSelectElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("KeyboardEvent", dom.KeyboardEvent);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal(
    "fetch",
    Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input) === "/ui/api/shell-language") {
          return Response.json({ ok: true, language: "en-US" });
        }
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root: Root | null = createRoot(container as unknown as HTMLElement);

  const cleanup = async () => {
    try {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
        root = null;
      }
      await dom.happyDOM.close();
    } finally {
      for (const [key, desc] of prev) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  cleanups.push(cleanup);

  return {
    dom,
    container,
    async render(node: React.ReactNode) {
      await act(async () => {
        root!.render(node);
      });
    },
  };
}

describe("TagFilterBar and inline profile editors", () => {
  test("aggregates tag counts NFC case-insensitively and supports OR/AND filtering", () => {
    const profiles = [
      { tags: ["VIP", "Cafe\u0301"] },
      { tags: ["vip", "US"] },
      { tags: ["Café", "US", "us"] },
      { tags: [] },
    ];
    const aggregated = aggregateProfileTagCounts(profiles);
    expect(aggregated.map((item) => [item.key, item.count])).toEqual([
      ["café", 2],
      ["us", 2],
      ["vip", 2],
    ]);

    expect(matchesTagFilter(profiles[0]!.tags, ["vip", "us"], "any")).toBe(true);
    expect(matchesTagFilter(profiles[0]!.tags, ["vip", "us"], "all")).toBe(false);
    expect(matchesTagFilter(profiles[1]!.tags, ["VIP", "US"], "all")).toBe(true);
    expect(matchesTagFilter(profiles[0]!.tags, ["café"], "all")).toBe(true);
    expect(matchesTagFilter(profiles[3]!.tags, ["vip"], "any")).toBe(false);
    expect(matchesTagFilter(profiles[3]!.tags, [], "all")).toBe(true);
  });

  test("TagFilterBar opens popover, searches tags, selects chips, switches OR/AND, and clears", async () => {
    const h = await createDomHarness();
    const profiles = [
      { tags: ["VIP", "US"] },
      { tags: ["VIP", "EU"] },
      { tags: ["Trial"] },
    ];
    let selectedTags: string[] = [];
    const modeHistory: TagFilterMode[] = [];
    let tagMode: TagFilterMode = "any";

    const rerender = () =>
      h.render(
        <I18nProvider>
          <TagFilterBar
            profiles={profiles}
            selectedTags={selectedTags}
            tagMode={tagMode}
            onChangeTags={(next) => {
              selectedTags = next;
            }}
            onChangeTagMode={(next) => {
              tagMode = next;
              modeHistory.push(next);
            }}
          />
        </I18nProvider>,
      );

    await rerender();
    const trigger = h.container.querySelector<HappyButtonElement>(".tag-filter-trigger")!;
    expect(trigger).toBeTruthy();

    await act(async () => {
      trigger.click();
    });
    expect(h.container.querySelector(".tag-filter-popover")).toBeTruthy();

    const searchInput = h.container.querySelector<HappyInputElement>(".tag-filter-search")!;
    await act(async () => {
      searchInput.focus();
      Object.getOwnPropertyDescriptor(h.dom.HTMLInputElement.prototype, "value")!.set!.call(searchInput, "vi");
      searchInput.dispatchEvent(new h.dom.Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new h.dom.Event("change", { bubbles: true }));
      searchInput.dispatchEvent(new h.dom.KeyboardEvent("keyup", { bubbles: true }));
    });
    const visibleOptions = h.container.querySelectorAll(".tag-filter-option");
    expect(visibleOptions.length).toBe(1);
    expect(visibleOptions[0]!.textContent).toContain("VIP");
    expect(visibleOptions[0]!.textContent).toContain("2");

    // Toggle VIP checkbox
    const checkbox = visibleOptions[0]!.querySelector<HappyInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      checkbox.click();
    });
    expect(selectedTags).toEqual(["VIP"]);

    // Rerender with active selection and verify chips + OR/AND + Clear
    selectedTags = ["VIP", "US"];
    await rerender();
    expect(h.container.querySelectorAll(".tag-filter-chip").length).toBe(2);

    const andBtn = Array.from(h.container.querySelectorAll<HappyButtonElement>(".tag-filter-mode-btn")).find(
      (btn) => btn.textContent?.includes("AND"),
    )!;
    await act(async () => {
      andBtn.click();
    });
    expect(modeHistory).toEqual(["all"]);

    const clearBtn = h.container.querySelector<HappyButtonElement>(".tag-filter-clear")!;
    await act(async () => {
      clearBtn.click();
    });
    expect(selectedTags).toEqual([]);
  });

  test("a large tag catalog opens lazily, bounds the mounted options, and keeps later results selectable", async () => {
    const h = await createDomHarness();
    let tagReads = 0;
    const profiles = Array.from({ length: 651 }, (_, index) => ({
      get tags() { tagReads++; return [`Tag ${String(index).padStart(4, "0")}`]; },
    }));
    let selectedTags: string[] = ["Absent"];
    const rerender = () => h.render(
      <I18nProvider>
        <TagFilterBar profiles={profiles} selectedTags={selectedTags} tagMode="any"
          onChangeTags={next => { selectedTags = next; }} onChangeTagMode={() => {}} />
      </I18nProvider>,
    );

    await rerender();
    const readsBeforeOpen = tagReads;
    const trigger = h.container.querySelector<HappyButtonElement>(".tag-filter-trigger")!;
    await act(async () => { trigger.click(); });
    const options = () => h.container.querySelectorAll(".tag-filter-option");
    console.log(`tag picker benchmark: distinct=${profiles.length}, readsWhileClosed=${readsBeforeOpen}, mounted=${options().length}`);
    expect(readsBeforeOpen).toBe(0);
    expect(options().length).toBe(50);
    expect(options()[0]?.textContent).toContain("Tag 0000");
    expect(h.container.querySelector(".tag-filter-pagination [role='status']")?.textContent).toBe("1–50 of 652");
    const next = h.container.querySelector<HappyButtonElement>('.tag-filter-pagination [aria-label="Next page"]')!;
    await act(async () => { next.click(); });
    expect(options()[0]?.textContent).toContain("Tag 0050");
    expect(h.container.querySelector(".tag-filter-pagination [role='status']")?.textContent).toBe("51–100 of 652");

    const input = h.container.querySelector<HappyInputElement>(".tag-filter-search")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(h.dom.HTMLInputElement.prototype, "value")!.set!.call(input, "tag 0650");
      input.dispatchEvent(new h.dom.Event("input", { bubbles: true }));
      input.dispatchEvent(new h.dom.Event("change", { bubbles: true }));
      input.dispatchEvent(new h.dom.KeyboardEvent("keyup", { bubbles: true }));
    });
    expect(options().length).toBe(1);
    expect(options()[0]?.textContent).toContain("Tag 0650");
    const option = options()[0]!.querySelector<HappyInputElement>('input[type="checkbox"]')!;
    await act(async () => { option.focus(); option.click(); });
    expect(selectedTags).toEqual(["Absent", "Tag 0650"]);
    await rerender();
    expect(h.container.querySelectorAll(".tag-filter-chip").length).toBe(2);
    await act(async () => { option.dispatchEvent(new h.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(h.container.querySelector(".tag-filter-popover")).toBeNull();
    expect(h.dom.document.activeElement).toBe(trigger);
  });

  test("InlineProfileNameEditor activates on double-click / F2 and skips IME composition Enter", async () => {
    const h = await createDomHarness();
    const saved: Array<{ id: string; name: string }> = [];

    await h.render(
      <I18nProvider>
        <InlineProfileNameEditor
          profileId="env_ime"
          name="Original Name"
          onSaveName={async (id, nextName) => {
            saved.push({ id, name: nextName });
          }}
        />
      </I18nProvider>,
    );

    const btn = h.container.querySelector<HappyButtonElement>(".profile-name-button")!;
    await act(async () => {
      btn.dispatchEvent(new h.dom.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });

    const input = h.container.querySelector<HappyInputElement>(".profile-inline-rename-input")!;
    expect(input).toBeTruthy();

    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(h.dom.HTMLInputElement.prototype, "value")!.set!.call(input, "中文名称");
      input.dispatchEvent(new h.dom.Event("input", { bubbles: true }));
      input.dispatchEvent(new h.dom.Event("change", { bubbles: true }));
      input.dispatchEvent(new h.dom.KeyboardEvent("keyup", { bubbles: true }));
    });

    // Non-composing Enter commits cleanly!
    await act(async () => {
      input.dispatchEvent(new h.dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(saved).toEqual([{ id: "env_ime", name: "中文名称" }]);

    // Re-activate via double-click and verify IME Enter (keyCode === 229) MUST NOT commit!
    const reopenedBtn = h.container.querySelector<HappyButtonElement>(".profile-name-button")!;
    await act(async () => {
      reopenedBtn.dispatchEvent(new h.dom.MouseEvent("dblclick", { bubbles: true }));
    });
    const input2 = h.container.querySelector<HappyInputElement>(".profile-inline-rename-input")!;
    expect(input2).toBeTruthy();

    const imeEnter = new h.dom.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true });
    Object.defineProperty(imeEnter, "keyCode", { value: 229 });
    await act(async () => {
      input2.dispatchEvent(imeEnter);
    });
    expect(saved).toEqual([{ id: "env_ime", name: "中文名称" }]);
    expect(h.container.querySelector(".profile-inline-rename-input")).toBeTruthy();
  });

  test("QuickProfileNotesEditor opens a viewport dialog, restores focus and saves on Ctrl+Enter", async () => {
    const h = await createDomHarness();
    const saved: Array<{ id: string; notes: string }> = [];
    const openChanges: boolean[] = [];

    await h.render(
      <I18nProvider>
        <QuickProfileNotesEditor
          profileId="env_note"
          notes=""
          variant="inline"
          onOpenChange={open => openChanges.push(open)}
          onSaveNotes={async (id, nextNotes) => {
            saved.push({ id, notes: nextNotes });
          }}
        />
      </I18nProvider>,
    );

    const trigger = h.container.querySelector<HappyButtonElement>(".quick-notes-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("Add notes");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const findTextarea = () => h.dom.document.querySelector<HappyTextAreaElement>('.quick-notes-dialog[role="dialog"] textarea')!;
    const firstTextarea = findTextarea();
    expect(h.container.contains(firstTextarea)).toBe(false);
    expect(h.dom.document.activeElement).toBe(firstTextarea);
    expect(openChanges).toEqual([true]);

    await act(async () => {
      firstTextarea.dispatchEvent(new h.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(findTextarea()).toBeNull();
    expect(h.dom.document.activeElement).toBe(trigger);
    expect(openChanges).toEqual([true, false]);
    expect(saved).toEqual([]);

    await act(async () => trigger.click());
    const textarea = findTextarea();
    expect(h.dom.document.activeElement).toBe(textarea);

    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(h.dom.HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Account warmup\r\nDay 3",
      );
      textarea.dispatchEvent(new h.dom.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new h.dom.Event("change", { bubbles: true }));
      textarea.dispatchEvent(new h.dom.KeyboardEvent("keyup", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new h.dom.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });

    expect(saved).toEqual([{ id: "env_note", notes: "Account warmup\nDay 3" }]);
    expect(findTextarea()).toBeNull();
    expect(h.dom.document.activeElement).toBe(trigger);
    expect(openChanges).toEqual([true, false, true, false]);
  });
});
