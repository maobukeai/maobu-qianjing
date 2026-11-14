import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLButtonElement, HTMLFormElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { RosterViews, type RosterViewsProps } from "../web/roster-views.tsx";
import { MAX_SAVED_VIEWS, type ProfileViewFilters, type RosterScope, type SavedProfileView } from "../profile-view-state.ts";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function baseFilters(): ProfileViewFilters { return { scope: "all", query: "", group: "all", status: "all", sort: { key: "no", dir: 1 }, hiddenColumns: ["tags", "platform"], pageSize: 20 }; }
function view(index: number, name: string, filters = baseFilters()): SavedProfileView { return { id: `view_${index.toString(16).padStart(32, "0")}`, name, filters }; }

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const saved: SavedProfileView[] = [], removed: string[] = [], applied: SavedProfileView[] = [], scopes: RosterScope[] = [];
  let retries = 0, saving = deferred<boolean>(), removing = deferred<boolean>();
  const serverView = view(1, "Research running", { ...baseFilters(), scope: "favorites", query: "research", group: "Research", status: "running", sort: { key: "name", dir: -1 }, pageSize: 50 });
  let props: RosterViewsProps = {
    current: baseFilters(), views: [serverView], counts: { all: 20, favorites: 3, recent: 5, attention: 2 }, ready: true, busy: false,
    onRetry: () => { retries++; }, onScope: scope => { scopes.push(scope); }, onApply: selected => { applied.push(selected); },
    onSave: async selected => { saved.push(selected); return saving.promise; }, onRemove: async id => { removed.push(id); return removing.promise; },
  };
  const render = () => dom.render(<I18nProvider><RosterViews {...props} /></I18nProvider>);
  const button = (label: string) => {
    const found = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(found, `Missing button ${label}`); return found;
  };
  const click = async (label: string) => act(async () => { const target = button(label); target.focus(); target.click(); });
  const input = () => { const node = dom.container.querySelector<HTMLInputElement>(".roster-view-editor input"); assert.ok(node, "Missing saved-view name editor"); return node; };
  const form = () => { const node = dom.container.querySelector<HTMLFormElement>(".roster-view-editor"); assert.ok(node, "Missing saved-view form"); return node; };
  const select = () => dom.container.querySelector<HTMLSelectElement>('select[aria-label="Environment view"]')!;
  const type = async (value: string) => act(async () => {
    const target = input(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const submit = async () => act(async () => { form().dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  const choose = async (value: string) => act(async () => { const target = select(); target.value = value; target.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const openSave = async (name: string) => { await click("Save current view"); assert.equal(dom.window.document.activeElement, input()); await type(name); };
  const settleSave = async (success: boolean, updateServer = success) => {
    if (success && updateServer) { const newest = saved.at(-1)!; props = { ...props, views: [...props.views.filter(item => item.id !== newest.id), newest] }; await render(); }
    await act(async () => { saving.resolve(success); });
  };
  const settleRemove = async (success: boolean) => {
    if (success) { props = { ...props, views: props.views.filter(item => !removed.includes(item.id)) }; await render(); }
    await act(async () => { removing.resolve(success); });
  };
  const removeFirst = async () => { await click("Manage saved views"); await click(`Remove saved view ${serverView.name}`); assert.deepEqual(removed, [serverView.id]); await settleRemove(true); };
  try {
    if (scenario === "save-snapshot") {
      props = { ...props, current: { ...baseFilters(), scope: "attention", query: "review café", group: "Overseas", status: "stopped", sort: { key: "proxy", dir: -1 }, hiddenColumns: ["tags", "platform"], pageSize: 100 } };
    }
    if (scenario === "loading-guard") props = { ...props, ready: false, views: [] };
    if (scenario === "view-limit") props = { ...props, views: Array.from({ length: MAX_SAVED_VIEWS }, (_, index) => view(index + 1, `View ${index + 1}`)) };
    await render();
    if (scenario === "save-snapshot") {
      const expected = structuredClone(props.current);
      await openSave("  Night research  "); await submit();
      assert.equal(saved.length, 1); assert.equal(saved[0]!.name, "Night research"); assert.match(saved[0]!.id, /^view_[a-f0-9]{32}$/);
      assert.deepEqual(saved[0]!.filters, expected);
      props.current.query = "changed after submission"; props.current.sort.dir = 1; props.current.hiddenColumns.push("proxy");
      await render(); assert.deepEqual(saved[0]!.filters, expected, "Pending saved data must not mutate with the live filters");
      assert.equal(input().value, "  Night research  "); assert.equal(input().disabled, true);
      await settleSave(true);
      assert.equal(dom.container.querySelector(".roster-view-editor"), null);
      assert.ok(dom.container.querySelector('[role="status"]')?.textContent?.includes("View saved"));
      assert.equal(dom.window.document.activeElement, button("Save current view"), "Async completion must restore focus after re-enabling the button");
      assert.equal(applied.length + scopes.length + removed.length, 0, "Saving a view must not apply, move or delete environments");
    } else if (scenario === "failure-retry") {
      await openSave("Keep my draft"); await submit(); await settleSave(false);
      assert.equal(input().value, "Keep my draft"); assert.equal(input().disabled, false);
      assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("try again")); assert.equal(props.views.length, 1);
      saving = deferred<boolean>(); await submit(); assert.equal(saved.length, 2); assert.equal(saved[1]!.name, "Keep my draft");
      await settleSave(true); assert.equal(props.views.length, 2);
    } else if (scenario === "apply-view") {
      assert.equal(select().value, "all"); const originalSelect = select();
      await choose(`saved:${serverView.id}`); assert.deepEqual(applied, [serverView]); assert.equal(saved.length + removed.length, 0);
      props = { ...props, current: structuredClone(serverView.filters) }; props.current.hiddenColumns.reverse(); await render();
      assert.equal(select(), originalSelect); assert.equal(select().value, `saved:${serverView.id}`, "An applied saved view remains selected even when equivalent columns are reordered");
      await click("Manage saved views"); await click(serverView.name); assert.equal(applied.length, 2);
      await choose("attention"); assert.deepEqual(scopes, ["attention"]);
    } else if (scenario === "delete-undo" || scenario === "undo-retry") {
      const original = structuredClone(serverView), filters = structuredClone(props.current);
      await removeFirst(); assert.equal(props.views.length, 0); assert.ok(button("Undo"));
      assert.equal(dom.window.document.activeElement, button("Save current view"), "Removing the final saved view must focus an enabled fallback control");
      await click("Undo"); assert.deepEqual(saved[0], original, "Undo must restore the exact saved ID and filter snapshot");
      if (scenario === "undo-retry") {
        await settleSave(false); assert.ok(button("Undo")); assert.equal(button("Undo").disabled, false);
        assert.ok(dom.container.querySelector('[role="alert"]')); saving = deferred<boolean>(); await click("Undo"); assert.equal(saved.length, 2); assert.deepEqual(saved[1], original);
      }
      await settleSave(true); assert.deepEqual(props.views, [original]); assert.deepEqual(props.current, filters);
      assert.equal(applied.length + scopes.length, 0); assert.equal([...dom.container.querySelectorAll("button")].some(item => item.textContent?.trim() === "Undo"), false);
    } else if (scenario === "duplicate-submit") {
      await openSave("Only one request");
      await act(async () => { for (let i = 0; i < 3; i++) form().dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
      assert.equal(saved.length, 1); assert.equal(select().disabled, true); assert.equal(input().disabled, true);
      await submit(); assert.equal(saved.length, 1);
      await settleSave(false); saving = deferred<boolean>(); await submit(); assert.equal(saved.length, 2, "A failed operation can be retried after the first promise settles"); await settleSave(true);
    } else if (scenario === "loading-guard") {
      assert.equal(select().disabled, true); assert.equal(button("Save current view").disabled, true); assert.ok(dom.container.textContent?.includes("Loading this workspace's views"));
      await click("Save current view"); assert.equal(dom.container.querySelector("form"), null); assert.equal(saved.length, 0);
      await click("Reload views"); assert.equal(retries, 1);
      props = { ...props, ready: true, views: [serverView], current: structuredClone(serverView.filters) }; await render();
      assert.equal(select().value, `saved:${serverView.id}`); assert.equal(saved.length + applied.length + scopes.length + removed.length, 0, "Hydration must never write defaults over server values");
      await openSave("Arrived from server"); props = { ...props, ready: false, busy: true }; await render();
      await submit(); assert.equal(saved.length, 0); assert.equal(input().value, "Arrived from server");
      props = { ...props, ready: true, busy: false, views: [...props.views, view(2, "Arrived from server")] }; await render();
      await submit(); assert.equal(saved.length, 0); assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("already uses this name"));
      assert.equal(props.views[1]!.name, "Arrived from server");
    } else if (scenario === "name-validation") {
      props = { ...props, views: [serverView, view(2, "Café")] }; await render(); await openSave("   ");
      await submit(); assert.equal(saved.length, 0); assert.ok(dom.container.querySelector('[role="alert"]'));
      for (const invalid of ["  RESEARCH RUNNING  ", "Cafe\u0301", "x".repeat(41), "name\u0001with-control"]) {
        await type(invalid); await submit(); assert.equal(saved.length, 0, `Invalid or duplicate name reached persistence: ${JSON.stringify(invalid)}`); assert.ok(dom.container.querySelector('[role="alert"]'));
      }
      const emoji = "🐾".repeat(40); await type(emoji); await submit();
      assert.equal(saved.length, 1); assert.equal(saved[0]!.name, emoji, "Forty Unicode codepoints must be accepted without truncating surrogate pairs"); await settleSave(true);
    } else if (scenario === "view-limit") {
      assert.equal(button("Save current view").disabled, true); assert.equal(select().disabled, false); await click("Save current view"); assert.equal(dom.container.querySelector("form"), null);
      await click("Manage saved views"); await click("Remove saved view View 1"); await settleRemove(true);
      assert.equal(props.views.length, MAX_SAVED_VIEWS - 1); assert.equal(button("Save current view").disabled, false);
    } else if (scenario === "unmount-pending") {
      await openSave("Pending metadata"); await submit(); assert.equal(saved.length, 1);
      await dom.render(<I18nProvider><p>Another workspace page</p></I18nProvider>);
      await act(async () => { saving.resolve(true); });
      assert.equal(dom.container.textContent, "Another workspace page"); assert.equal(dom.container.querySelector("button"), null);
      assert.equal(applied.length + scopes.length + removed.length, 0);
    } else throw new Error(`Unknown scenario: ${scenario}`);
  } finally { await dom.cleanup(); }
}
if (import.meta.main) {
  try { await run(process.argv[2] ?? "save-snapshot"); console.log("roster views interaction fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
