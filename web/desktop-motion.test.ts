import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { resolve } from "node:path";
import * as React from "react";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RosterSkeleton } from "./components/roster-skeleton.tsx";
import { DESKTOP_MOTION_KEY, desktopMotionCookie, isMotionAllowed, readDesktopMotionPreference, resolveDesktopMotion } from "./desktop-motion.tsx";
import { FLIP_DURATION_MS, MAX_FLIP_ROWS, useFlipGroup } from "./hooks/use-flip-group.ts";
import { I18nProvider } from "./i18n.tsx";
import { useSlidingIndicator } from "./navigation-motion.ts";
import { readWindowBackdrop, syncWindowTheme, useWindowBackdrop, type WindowThemeChoice } from "./window-chrome.tsx";

test("desktop motion uses the host cookie across random loopback ports", () => {
  expect(readDesktopMotionPreference(`other=value; ${DESKTOP_MOTION_KEY}=reduced`, "full")).toBe("reduced");
  expect(readDesktopMotionPreference(`${DESKTOP_MOTION_KEY}=full`, "reduced")).toBe("full");
  expect(desktopMotionCookie("reduced")).toBe("aliasmode.shell.motion=reduced; Path=/; Max-Age=31536000; SameSite=Strict");
});
test("unrecognized saved motion values safely fall back to the system", () => {
  expect(readDesktopMotionPreference(`${DESKTOP_MOTION_KEY}=invalid`, "reduced")).toBe("reduced");
  expect(readDesktopMotionPreference("", "invalid")).toBe("system");
  expect(readDesktopMotionPreference("", null)).toBe("system");
});
test("system reduced motion takes priority even when full motion was selected", () => {
  for (const preference of ["system", "reduced", "full"] as const) expect(resolveDesktopMotion(preference, true)).toBe("reduced");
  expect(resolveDesktopMotion("system", false)).toBe("full");
  expect(resolveDesktopMotion("reduced", false)).toBe("reduced");
});
for (const scenario of ["preference", "presence", "reduced-exit", "panel", "storage-blocked"]) {
  test(`desktop motion interaction: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/desktop-motion-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..") });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("desktop motion interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}

async function withHappyDom<T>(
  run: (dom: Window, container: HTMLElement) => Promise<T> | T,
  setup?: (dom: Window) => void,
): Promise<T> {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  setup?.(dom);
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const expose = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  expose("window", dom);
  expose("document", dom.document);
  expose("navigator", dom.navigator);
  expose("localStorage", dom.localStorage);
  expose("HTMLElement", dom.HTMLElement);
  expose("Element", dom.Element);
  expose("Node", dom.Node);
  expose("Event", dom.Event);
  expose("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  try {
    return await run(dom, container as unknown as HTMLElement);
  } finally {
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [key, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("window backdrop reads allowlisted Mica flags and syncWindowTheme degrades silently on failure", async () => {
  expect(readWindowBackdrop({ __MAOBU_BACKDROP__: "mica-alt" })).toBe("mica-alt");
  expect(readWindowBackdrop({ __MAOBU_BACKDROP__: "mica" })).toBe("mica");
  expect(readWindowBackdrop({ __MAOBU_BACKDROP__: "none" })).toBe("none");
  expect(readWindowBackdrop({ __MAOBU_BACKDROP__: "acrylic" })).toBe("none");
  expect(readWindowBackdrop(null)).toBe("none");

  const invoked: Array<{ command: string; args: unknown }> = [];
  const ok = await syncWindowTheme("dark", {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        invoked.push({ command, args });
      },
    },
  });
  expect(ok).toBe(true);
  expect(invoked).toEqual([{ command: "set_window_theme", args: { theme: "dark" } }]);

  // Rejecting Tauri IPC or missing bridge must downgrade silently without throwing.
  expect(
    await syncWindowTheme("light", {
      __TAURI_INTERNALS__: { invoke: async () => { throw new Error("unsupported host"); } },
    }),
  ).toBe(false);
  expect(await syncWindowTheme("system", {})).toBe(false);
});

test("useWindowBackdrop binds dataset.windowBackdrop and syncs Tauri set_window_theme across theme changes", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const schemeListeners = new Set<() => void>();
  await withHappyDom(
    async (dom, container) => {
      let currentBackdrop = "";
      function Probe({ theme }: { theme: WindowThemeChoice }) {
        currentBackdrop = useWindowBackdrop(theme);
        return null;
      }
      const root = createRoot(container);
      act(() => { root.render(createElement(Probe, { theme: "dark" })); });
      await Promise.resolve();
      expect(currentBackdrop).toBe("mica-alt");
      expect(dom.document.documentElement.dataset.windowBackdrop).toBe("mica-alt");
      expect(calls).toEqual([{ command: "set_window_theme", args: { theme: "dark" } }]);

      act(() => { root.render(createElement(Probe, { theme: "system" })); });
      await Promise.resolve();
      expect(calls).toHaveLength(2);
      for (const listener of schemeListeners) listener();
      await Promise.resolve();
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual({ command: "set_window_theme", args: { theme: "system" } });

      act(() => { root.unmount(); });
      expect(dom.document.documentElement.dataset.windowBackdrop).toBeUndefined();
    },
    (dom) => {
      Object.assign(dom, {
        __MAOBU_BACKDROP__: "mica-alt",
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: unknown) => {
            calls.push({ command, args });
          },
        },
      });
      dom.matchMedia = (() => ({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        addEventListener: (_: string, cb: () => void) => schemeListeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => schemeListeners.delete(cb),
      })) as unknown as typeof dom.matchMedia;
    },
  );
});

test("useSlidingIndicator positions via GPU translate3d + scaleX and respects reduced motion", async () => {
  await withHappyDom(async (dom, container) => {
    dom.document.documentElement.dataset.desktopMotion = "full";
    dom.matchMedia = (() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof dom.matchMedia;

    Object.defineProperty(dom.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset.tab === "first") return { left: 20, top: 0, width: 60, height: 32 };
        if (this.dataset.tab === "second") return { left: 100, top: 0, width: 90, height: 32 };
        return { left: 10, top: 0, width: 300, height: 32 };
      },
    });

    function Tabs({ active, allowed = true }: { active: string | null; allowed?: boolean }) {
      const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({
        activeKey: active,
        axis: "horizontal",
        motionAllowed: allowed,
      });
      return createElement(
        "div",
        { ref: containerRef, className: "tabs sliding-indicator-host" },
        createElement("span", { ref: indicatorRef, className: "sliding-indicator" }),
        createElement("button", { "data-tab": "first", className: active === "first" ? "tab active" : "tab" }, "First"),
        createElement("button", { "data-tab": "second", className: active === "second" ? "tab active" : "tab" }, "Second"),
      );
    }

    const root = createRoot(container);
    act(() => { root.render(createElement(Tabs, { active: "first" })); });
    const host = container.querySelector<HTMLElement>(".tabs")!;
    const indicator = container.querySelector<HTMLElement>(".sliding-indicator")!;
    expect(host.hasAttribute("data-indicator-visible")).toBe(true);
    expect(indicator.style.transform).toBe("translate3d(10px, 0, 0) scaleX(60)");
    expect(indicator.style.transition).toBe("");

    act(() => { root.render(createElement(Tabs, { active: "second" })); });
    expect(indicator.style.transform).toBe("translate3d(90px, 0, 0) scaleX(90)");
    expect(indicator.style.transition).toBe("");

    // Switching to reduced motion keeps transition disabled
    act(() => { root.render(createElement(Tabs, { active: "first", allowed: false })); });
    expect(indicator.style.transform).toBe("translate3d(10px, 0, 0) scaleX(60)");
    expect(indicator.style.transition).toBe("none");

    // No active item hides indicator cleanly
    act(() => { root.render(createElement(Tabs, { active: null })); });
    expect(host.hasAttribute("data-indicator-visible")).toBe(false);

    act(() => { root.unmount(); });
  });
});

test("useFlipGroup caps WAAPI FLIP rows at 24, omits sticky-breaking fill, and skips when reduced", async () => {
  await withHappyDom(async (dom, container) => {
    dom.document.documentElement.dataset.desktopMotion = "full";
    dom.matchMedia = (() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof dom.matchMedia;

    let offsetY = 0;
    Object.defineProperty(dom.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset.profileId) {
          const idx = Number(this.dataset.profileId.replace("p", ""));
          return { top: idx * 48 + offsetY, bottom: idx * 48 + offsetY + 48, left: 0, width: 600, height: 48 };
        }
        return { top: 0, bottom: 2000, left: 0, width: 600, height: 0 };
      },
    });

    const animated: Array<{ id: string | undefined; frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    Object.defineProperty(dom.HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
        animated.push({ id: this.dataset.profileId, frames, options });
        return { id: "", finished: Promise.resolve(), cancel() {} };
      },
    });

    const ids = Array.from({ length: 30 }, (_, i) => `p${i + 1}`);
    function Roster({ disclosureKey, allowed }: { disclosureKey: string; allowed: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFlipGroup(ref, disclosureKey, allowed);
      return createElement(
        "div",
        { ref },
        createElement(
          "table",
          null,
          createElement(
            "tbody",
            null,
            ids.map((id) => createElement("tr", { key: id, "data-profile-id": id }, createElement("td", null, id))),
          ),
        ),
      );
    }

    const root = createRoot(container);
    act(() => { root.render(createElement(Roster, { disclosureKey: "open", allowed: true })); });
    expect(animated).toHaveLength(0);

    // Shift all 30 rows upward by 96px -> capped strictly at MAX_FLIP_ROWS (24)
    offsetY = -96;
    act(() => { root.render(createElement(Roster, { disclosureKey: "collapsed", allowed: true })); });
    expect(animated).toHaveLength(MAX_FLIP_ROWS);
    expect(animated[0]!.frames).toEqual([{ transform: "translateY(96px)" }, { transform: "none" }]);
    expect(animated[0]!.options.duration).toBe(FLIP_DURATION_MS);
    expect(animated[0]!.options.fill).toBeUndefined();

    // Reduced motion or motionAllowed=false skips WAAPI entirely
    offsetY = 0;
    act(() => { root.render(createElement(Roster, { disclosureKey: "reopened", allowed: false })); });
    expect(animated).toHaveLength(MAX_FLIP_ROWS);

    dom.document.documentElement.dataset.desktopMotion = "reduced";
    expect(isMotionAllowed(true)).toBe(false);
    offsetY = -48;
    act(() => { root.render(createElement(Roster, { disclosureKey: "reduced-toggle", allowed: true })); });
    expect(animated).toHaveLength(MAX_FLIP_ROWS);

    act(() => { root.unmount(); });
  });
});

test("RosterSkeleton renders column-aligned density rows with accessible Loading environments status", () => {
  const comfortable = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement("table", null, createElement("tbody", null, createElement(RosterSkeleton, { rows: 8, visibleColumnCount: 6, density: "comfortable" }))),
    ),
  );
  expect(comfortable.match(/<tr\b/g)).toHaveLength(8);
  expect(comfortable.match(/<td\b/g)).toHaveLength(48);
  expect(comfortable).toContain('role="status"');
  expect(comfortable).toContain("Loading environments…");
  expect(comfortable).toContain('data-skeleton-density="comfortable"');
  expect(comfortable).toContain("roster-skeleton-bar is-sub");

  const compact = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement("table", null, createElement("tbody", null, createElement(RosterSkeleton, { rows: 4, visibleColumnCount: 5, density: "compact" }))),
    ),
  );
  expect(compact.match(/<tr\b/g)).toHaveLength(4);
  expect(compact.match(/<td\b/g)).toHaveLength(20);
  expect(compact).toContain('data-skeleton-density="compact"');
  expect(compact).not.toContain("roster-skeleton-bar is-sub");
});
