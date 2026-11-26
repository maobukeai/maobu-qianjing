import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installGlobalSelectMenus } from "./global-select-menu.ts";

async function withHappyDom<T>(run: (dom: Window) => Promise<T> | T): Promise<T> {
  const dom = new Window({ url: "http://127.0.0.1/" });
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const expose = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  expose("window", dom);
  expose("document", dom.document);
  expose("Element", dom.Element);
  expose("HTMLElement", dom.HTMLElement);
  expose("Node", dom.Node);
  expose("Event", dom.Event);
  expose("MutationObserver", dom.MutationObserver);

  try {
    return await run(dom);
  } finally {
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [key, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("installGlobalSelectMenus opens rounded listbox with optgroups, updates select.value, and dispatches change", async () => {
  await withHappyDom((dom) => {
    const select = dom.document.createElement("select");
    select.setAttribute("aria-label", "Move to group");
    select.innerHTML = `
      <option value="choose">Move to…</option>
      <optgroup label="Workspace folders">
        <option value="group:us">US Team</option>
        <option value="group:eu" disabled>EU Team</option>
        <option value="group:cn">CN Team</option>
      </optgroup>
    `;
    dom.document.body.appendChild(select as never);

    dom.happyDOM.setViewport({ width: 1280, height: 800 });
    Object.defineProperty(select, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 40, top: 760, right: 200, bottom: 790, width: 160, height: 30 }),
    });

    const changes: string[] = [];
    select.addEventListener("change", () => changes.push(select.value));

    const dispose = installGlobalSelectMenus();

    const md = new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    select.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    expect(select.getAttribute("data-select-open")).toBe("true");

    const popover = dom.document.body.querySelector(".global-select-popover") as unknown as HTMLElement | null;
    expect(popover).toBeTruthy();
    expect(popover!.dataset.placement).toBe("top");
    expect(popover!.querySelector(".global-select-group-label")?.textContent).toBe("Workspace folders");

    const options = Array.from(popover!.querySelectorAll<HTMLButtonElement>(".global-select-option"));
    expect(options.length).toBe(4);
    expect(options[0]!.classList.contains("is-selected")).toBe(true);
    expect(options[2]!.disabled).toBe(true);

    options[3]!.click();
    expect(select.value).toBe("group:cn");
    expect(changes).toEqual(["group:cn"]);
    expect(dom.document.body.querySelector(".global-select-popover")).toBeNull();
    expect(select.hasAttribute("data-select-open")).toBe(false);

    dispose();
  });
});

test("installGlobalSelectMenus handles keyboard navigation, skips disabled options, and isolates Escape", async () => {
  await withHappyDom((dom) => {
    const select = dom.document.createElement("select");
    select.innerHTML = `
      <option value="a">Alpha</option>
      <option value="b" disabled>Beta</option>
      <option value="c">Gamma</option>
    `;
    dom.document.body.appendChild(select as never);
    Object.defineProperty(select, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, top: 40, right: 160, bottom: 72, width: 140, height: 32 }),
    });

    let outerEscapeSeen = false;
    dom.document.body.addEventListener("keydown", (e) => {
      if ((e as unknown as KeyboardEvent).key === "Escape") outerEscapeSeen = true;
    });

    const changes: string[] = [];
    select.addEventListener("change", () => changes.push(select.value));

    const dispose = installGlobalSelectMenus();

    select.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(dom.document.body.querySelector(".global-select-popover")).toBeTruthy();

    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dom.document.body.querySelector(".global-select-popover")).toBeNull();
    expect(outerEscapeSeen).toBe(false);

    select.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(select.value).toBe("c");
    expect(changes).toEqual(["c"]);

    dispose();
  });
});

test("installGlobalSelectMenus skips disabled, multiple, size>1, and data-native-select controls", async () => {
  await withHappyDom((dom) => {
    const disabledSel = dom.document.createElement("select");
    disabledSel.disabled = true;
    const multiSel = dom.document.createElement("select");
    multiSel.multiple = true;
    const listSel = dom.document.createElement("select");
    listSel.setAttribute("size", "4");
    const optOutSel = dom.document.createElement("select");
    optOutSel.dataset.nativeSelect = "true";

    for (const s of [disabledSel, multiSel, listSel, optOutSel]) {
      s.innerHTML = `<option value="1">One</option>`;
      dom.document.body.appendChild(s as never);
    }

    const dispose = installGlobalSelectMenus();

    for (const s of [disabledSel, multiSel, listSel, optOutSel]) {
      const md = new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      s.dispatchEvent(md);
      expect(md.defaultPrevented).toBe(false);
      expect(dom.document.body.querySelector(".global-select-popover")).toBeNull();
    }

    dispose();
  });
});
