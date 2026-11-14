import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const groups = ["A", "B", "C"];
  const profiles = Array.from({ length: 26 }, (_, offset) => {
    const index = offset + 1, group = groups[Math.floor(offset / 10)]!;
    return { id: `range_${index}`, name: `${group} Environment ${String(index).padStart(2, "0")}`, engine: "chromium", chromiumRuntime: "aliasmode", group, platform: "", tags: [], extensions: [], proxy: null,
      timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false };
  });
  const preferences: Record<string, string> = { "aliasmode.roster.pageSize": "20", "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groups].map(name => [name, false])) };
  const workspace = { id: "default", name: "Range selection fixture", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const unexpected: string[] = [], mutations: string[] = [];
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    if (path === "/ui/api/profiles" && method === "GET") return Response.json({ ok: true, profiles, groups, folders: groups.map(name => ({ name })) });
    if (path === "/ui/api/workspace/preferences") {
      if (method === "GET") return Response.json({ ok: true, preferences });
      if (method === "POST") { const body = JSON.parse(String(options?.body)); preferences[body.key] = body.value; return Response.json({ ok: true }); }
    }
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-range-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-range-fixture", profileCount: profiles.length, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    if (method !== "GET") mutations.push(`${method} ${path}`);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected range fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const created = createRealRoot(...args); root = created; return created; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.container): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const rows = () => visible<HTMLElement>("tr[data-profile-id]");
  const ids = () => rows().map(row => row.dataset.profileId!);
  const checkbox = (id: string) => { const input = rows().find(row => row.dataset.profileId === id)?.querySelector<HTMLInputElement>('td.chk input[type="checkbox"]'); assert.ok(input, `Missing checkbox ${id}`); return input; };
  const checked = () => rows().filter(row => row.querySelector<HTMLInputElement>('td.chk input')?.checked).map(row => row.dataset.profileId!);
  const assertChecked = (expected: string[]) => assert.deepEqual([...checked()].sort(), [...expected].sort());
  const count = () => Number(dom.container.querySelector(".selcount")?.textContent?.match(/\d+/)?.[0] ?? 0);
  const button = (label: string, scope: HTMLElement = dom.container) => { const found = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(found, `Missing ${label}`); return found; };
  const click = async (node: HTMLButtonElement | HTMLInputElement, shiftKey = false) => act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey, detail: 1 })); });
  const select = async (node: HTMLSelectElement, value: string) => act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const search = async (value: string) => act(async () => { const node = dom.container.querySelector<HTMLInputElement>(".heading-search input")!; assert.ok(node); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, why: string) => { const until = Date.now() + 2500; while (!condition() && Date.now() < until) await dom.flush(); assert.ok(condition(), `${why}; checked=${JSON.stringify(checked())}; tail=${dom.container.textContent?.slice(-900)}`); };
  const space = async (node: HTMLInputElement, shiftKey = false) => act(async () => {
    node.focus();
    const down = new dom.window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true, shiftKey });
    const up = new dom.window.KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true, shiftKey });
    node.dispatchEvent(down); node.dispatchEvent(up);
    // happy-dom does not synthesize checkbox keyboard activation. Supply the browser's
    // default click only when the actual App has not consumed the key itself. detail=0
    // and no modifier exercise the fallback for browsers that omit click.shiftKey.
    if (!down.defaultPrevented && !up.defaultPrevented) node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  });
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => rows().length === 20 && dom.container.querySelector<HTMLSelectElement>('select[aria-label="Environment view"]')?.disabled === false, "Actual App should load the first page and its disclosure preferences");
    const initial = ids(), a = initial.filter(id => profiles.find(profile => profile.id === id)?.group === "A"), b = initial.filter(id => profiles.find(profile => profile.id === id)?.group === "B");
    assert.equal(a.length, 10); assert.equal(b.length, 10);

    if (scenario === "pointer-span") {
      await click(checkbox(b[1]!)); await click(checkbox(b[5]!), true);
      assertChecked(b.slice(1, 6)); assert.equal(count(), 5);
      await click(checkbox(b[3]!), true); assertChecked(b.slice(4, 6));
    } else if (scenario === "clear-span-preserves-others") {
      await click(checkbox(a[0]!)); await click(checkbox(b[0]!)); await click(checkbox(b[4]!), true);
      assertChecked([a[0]!, ...b.slice(0, 5)]);
      await click(checkbox(b[4]!), true); assertChecked([a[0]!]); assert.equal(count(), 1);
    } else if (scenario === "keyboard") {
      await space(checkbox(b[1]!)); await space(checkbox(b[4]!), true);
      assertChecked(b.slice(1, 5)); assert.equal(dom.window.document.activeElement, checkbox(b[4]!));
      await space(checkbox(b[2]!)); assertChecked([b[1]!, b[3]!, b[4]!]);
      await space(checkbox(b[4]!), true); assertChecked([b[1]!]);
    } else if (scenario === "filter-preserves-hidden") {
      await click(checkbox(a[0]!)); await click(checkbox(b[0]!));
      await search("B"); await waitFor(() => rows().length === 10, "Search should hide group A");
      await click(checkbox(b[4]!), true); assertChecked([b[0]!, b[4]!]); assert.equal(count(), 3, "The filtered-out selected row must survive");
      await search(""); assertChecked([a[0]!, b[0]!, b[4]!]);
    } else if (scenario === "filter-return-reset") {
      await click(checkbox(a[0]!)); await search("no matching environment"); await waitFor(() => rows().length === 0, "Search should leave the anchored view");
      await search(""); await waitFor(() => rows().length === 20, "Clearing search should return to the same visible rows");
      await click(checkbox(a[5]!), true); assertChecked([a[0]!, a[5]!]);
    } else if (scenario === "sort-reset") {
      const originalAnchor = a[a.length - 1]!; await click(checkbox(originalAnchor));
      const sort = dom.container.querySelector<HTMLButtonElement>("th.col-name button")!; assert.ok(sort); await click(sort); await click(sort);
      const reordered = ids().filter(id => profiles.find(profile => profile.id === id)?.group === "A"); assert.notDeepEqual(reordered, a);
      const target = reordered[reordered.length - 1]!; assert.notEqual(target, originalAnchor); await click(checkbox(target), true); assertChecked([originalAnchor, target]);
    } else if (scenario === "collapse-reset") {
      await click(checkbox(b[0]!)); await click(button("Collapse A")); await waitFor(() => rows().length === 10, "Collapsed rows should leave the visible selection order");
      await click(checkbox(b[4]!), true); assertChecked([b[0]!, b[4]!]);
      await click(button("Expand A")); assertChecked([b[0]!, b[4]!]);
    } else if (scenario === "page-reset") {
      await click(checkbox(initial[0]!)); await click(button("Next page")); await waitFor(() => rows().length === 6, "Second page should show only its own rows");
      const second = ids(); await click(checkbox(second[4]!), true); assertChecked([second[4]!]); assert.equal(count(), 2);
      await click(button("Previous page")); await waitFor(() => rows().length === 20, "Previous page should restore its rows");
      await click(checkbox(initial[5]!), true); assertChecked([initial[0]!, initial[5]!]); assert.equal(count(), 3);
    } else if (scenario === "explicit-clear-reset") {
      await click(checkbox(a[0]!)); await click(button("Clear selection")); assert.equal(count(), 0);
      await click(checkbox(a[5]!), true); assertChecked([a[5]!]);
    } else if (scenario === "group-selection-reset") {
      await click(checkbox(a[0]!)); const groupCheck = visible<HTMLInputElement>(".profile-group-check").find(node => node.getAttribute("aria-label")?.endsWith("in A")); assert.ok(groupCheck);
      await click(groupCheck); assertChecked(a);
      await click(checkbox(b[4]!), true); assertChecked([...a, b[4]!]);
    } else if (scenario === "repeat-explicit-event") {
      await click(checkbox(b[0]!));
      const repeat = async (checkedValue: boolean) => act(async () => {
        const node = checkbox(b[4]!);
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "checked")!.set!.call(node, checkedValue);
        // A plain Event bypasses happy-dom's mouse default toggle. Both deliveries
        // carry the same explicit checked intent, as a replayed change would.
        const event = new dom.window.Event("click", { bubbles: true }); Object.assign(event, { shiftKey: true, detail: 1 });
        node.dispatchEvent(event); node.dispatchEvent(event);
        node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await repeat(true); assertChecked(b.slice(0, 5));
      await repeat(false); assertChecked([]); assert.equal(count(), 0);
    } else throw new Error(`Unknown range scenario ${scenario}`);
    assert.deepEqual(unexpected, []); assert.deepEqual(mutations, [], "Changing selection must never mutate profile data or launch a browser");
  } finally {
    if (root) await act(async () => { root!.unmount(); }); await dom.cleanup();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}

try { await run(process.argv[2] ?? "pointer-span"); console.log("actual App range selection fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
