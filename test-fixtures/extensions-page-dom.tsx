import assert from "node:assert/strict";
import { act } from "react";
import { I18nProvider } from "../web/i18n.tsx";
import { ExtensionsPage, extensionGroupPreview, type ExtensionsPageProps, type GroupDefaultsSnapshot } from "../web/extensions-page.tsx";
import { createWebDomHarness } from "./web-dom.ts";
import type { ExtensionGroupReview } from "../extension-group-revision.ts";
import type { Document, HTMLElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const applied: GroupDefaultsSnapshot[] = [], removed: Array<[string, string]> = [];
  const previews: { group: string; extensions: string[]; signal?: AbortSignal }[] = [];
  const previewRequests: ReturnType<typeof deferred<ExtensionGroupReview>>[] = [];
  const reloadPending = deferred<void>(); let reloads = 0, discards = 0; const selectedGroups: string[] = [];
  let previewNumber = 0;
  let pending = deferred<boolean>();
  let props: ExtensionsPageProps = {
    extensions: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Gamma" }, { id: "d", name: "Delta" }],
    profiles: [
      { id: "one", name: "Custom selection", group: "Research", engine: "chromium", running: true, extensions: ["a", "c"] },
      { id: "two", name: "Empty selection", group: "Research", engine: "chromium", running: false, extensions: [] },
      { id: "three", name: "Firefox", group: "Research", engine: "firefox", running: false, extensions: [] },
      { id: "four", name: "Other project", group: "Other", engine: "chromium", running: false, extensions: ["b"] },
    ],
    groupDefaults: [{ name: "Research", extensions: ["a"] }, { name: "Other", extensions: ["b"] }],
    selectedGroup: "Research", selectedExtensionIds: ["b"], source: "", installing: false, uploading: false, applying: false, error: null,
    onSourceChange: value => { props = { ...props, source: value }; }, onSelectGroup: group => { selectedGroups.push(group); }, onToggleExtension: () => {},
    onInstall: async () => true, onUpload: async () => true,
    onApplyGroupDefaults: async selection => { applied.push(selection); return pending.promise; },
    onRemove: async (id, name) => { removed.push([id, name]); return pending.promise; },
    onPreviewGroupDefaults: async (selection, signal) => {
      previews.push({ group: selection.group, extensions: [...selection.extensions], signal });
      const { signature: _signature, unknown: _unknown, ...preview } = extensionGroupPreview(selection.group, selection.extensions, props.groupDefaults, props.profiles);
      const reply: ExtensionGroupReview = { ...preview, version: 1, unknown: 0, expectedFingerprint: (++previewNumber).toString(16).padStart(64, "0") };
      if (scenario === "server-preview") reply.changes[0]!.name = "Latest server name";
      if (scenario === "preview-pending" || scenario === "preview-unmount" || scenario === "preview-selection-changed") { const request = deferred<ExtensionGroupReview>(); previewRequests.push(request); return request.promise; }
      if (scenario === "preview-failure") throw new Error("Inert server review unavailable");
      return reply;
    },
    onReload: async () => { reloads++; await reloadPending.promise; props = { ...props, dataFresh: true }; },
    onDiscardGroupDraft: () => { discards++; },
  };
  const render = () => dom.render(<I18nProvider><ExtensionsPage {...props} /></I18nProvider>);
  const button = (label: string, within: Document | HTMLElement = dom.window.document) => {
    const result = [...within.querySelectorAll("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(result, `Missing button ${label}`); return result;
  };
  const click = async (label: string, within?: Document | HTMLElement) => act(async () => { const item = button(label, within); item.focus(); item.click(); });
  const dialog = () => [...dom.window.document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]')) ?? null;
  const key = (value: string, shiftKey = false) => act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
  try {
    await render();
    if (scenario === "loading-guard") {
      const loadedProps = props;
      props = { ...props, loading: true, extensions: [], groupDefaults: [] };
      await render();
      assert.equal(dom.container.querySelector(".extensions-workspace")?.getAttribute("aria-busy"), "true");
      assert.ok(dom.container.textContent?.includes("Loading extensions…"));
      assert.ok(dom.container.textContent?.includes("Loading group defaults…"));
      assert.ok(!dom.container.textContent?.includes("No extensions yet"));
      assert.ok(!dom.container.textContent?.includes("Create an editable group"));
      assert.equal(button("Add extension").disabled, true);
      props = { ...loadedProps, loading: true };
      await render();
      assert.equal(dom.container.querySelectorAll(".extensions-library-row").length, 4, "Existing data stays visible during refresh");
      assert.equal(button("Remove Alpha").disabled, true);
      assert.equal(button("Review and apply").disabled, true);
      await click("Remove Alpha"); assert.equal(dialog(), null);
      props = { ...loadedProps, loading: false };
      await render(); await click("Review and apply");
      props = { ...props, loading: true };
      await render();
      assert.equal(button("Apply group default", dialog()!).disabled, true);
      assert.equal(button("Cancel", dialog()!).disabled, false, "A refresh must not trap the user in a confirmation");
      await click("Apply group default", dialog()!); assert.equal(applied.length, 0);
      await click("Cancel", dialog()!); assert.equal(dialog(), null);
    } else if (scenario === "library-search") {
      const rows = () => [...dom.container.querySelectorAll(".extensions-library-row")];
      assert.equal(rows().length, 4);
      const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Beta");
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(rows().length, 1); assert.equal(rows()[0]!.querySelector("h3")?.textContent, "Beta");
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "");
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const filter = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter extension assignments"]')!;
        filter.value = "unassigned"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      assert.equal(rows().length, 1); assert.equal(rows()[0]!.querySelector("h3")?.textContent, "Delta");
      assert.equal(dom.container.querySelector(".extensions-installer")?.hasAttribute("hidden"), true);
      await click("Add extension");
      assert.equal(dom.container.querySelector(".extensions-installer")?.hasAttribute("hidden"), false);
      assert.equal(button("Install").disabled, true);
      assert.equal(dom.container.querySelector(".pagefoot"), null);
      assert.equal(applied.length + removed.length, 0);
    } else if (scenario === "group-preview") {
      assert.equal(dom.container.querySelector('.extensions-defaults input[type="search"]'), null);
      const preview = extensionGroupPreview("Research", ["b"], props.groupDefaults, props.profiles);
      assert.equal(preview.count, 3);
      assert.deepEqual(preview.defaultAdded, ["b"]); assert.deepEqual(preview.defaultRemoved, ["a"]);
      assert.deepEqual(preview.changes.map(item => ({ id: item.id, added: item.added, removed: item.removed })), [{ id: "one", added: ["b"], removed: ["a", "c"] }, { id: "two", added: ["b"], removed: [] }]);
      await click("Review and apply");
      assert.equal(applied.length, 0, "Opening a preview must not apply changes");
      assert.ok(dialog()?.textContent?.includes("3 environments in Research"));
      assert.ok(dialog()?.textContent?.includes("Custom selection"));
      assert.ok(dialog()?.textContent?.includes("Gamma"));
      assert.ok(dialog()?.textContent?.includes("2 environments will change"));
      assert.equal(dialog()?.querySelector('input[type="search"]'), null);
      assert.equal(dom.window.document.activeElement, button("Close", dialog()!));
      await key("Tab", true);
      assert.equal(dom.window.document.activeElement, button("Apply group default", dialog()!), "Shift+Tab should stay inside the dialog");
      await key("Escape");
      assert.equal(dialog(), null); assert.equal(dom.window.document.activeElement, button("Review and apply"));
      await click("Review and apply");
      await click("Apply group default", dialog()!);
      assert.deepEqual(applied, [{ group: "Research", extensions: ["b"], expectedFingerprint: "2".padStart(64, "0") }]);
      await key("Escape"); assert.ok(dialog(), "Pending operations cannot be dismissed");
      await click("Apply group default", dialog()!);
      assert.equal(applied.length, 1, "Repeated confirmation must not submit twice");
      await act(async () => { pending.resolve(true); });
      assert.equal(dialog(), null);
      assert.ok(dom.container.querySelector('[role="status"]')?.textContent?.includes("Reopen affected browsers"));
    } else if (scenario === "stale-preview") {
      await click("Review and apply");
      props = { ...props, profiles: props.profiles.map(profile => profile.id === "two" ? { ...profile, extensions: ["c"] } : profile) };
      await render();
      assert.ok(dialog()?.querySelector('[role="alert"]')?.textContent?.includes("Assignments changed"));
      assert.equal(button("Apply group default", dialog()!).disabled, true);
      await click("Apply group default", dialog()!); assert.equal(applied.length, 0);
      await click("Cancel", dialog()!); await click("Review and apply");
      assert.equal(button("Apply group default", dialog()!).disabled, false);
      assert.ok(dialog()?.textContent?.includes("Gamma"));
      await click("Apply group default", dialog()!);
      await act(async () => { pending.resolve(false); });
      assert.ok(dialog()); assert.ok(dialog()?.textContent?.includes("This review needs to be refreshed before applying"));
      pending = deferred<boolean>();
      assert.equal(button("Apply group default", dialog()!).disabled, true, "A failed apply requires an explicit new review");
      await click("Review latest changes", dialog()!);
      await click("Apply group default", dialog()!); await act(async () => { pending.resolve(true); });
      assert.equal(applied.length, 2); assert.equal(dialog(), null);
    } else if (scenario === "preview-failure" || scenario === "preview-missing") {
      if (scenario === "preview-missing") { props = { ...props, onPreviewGroupDefaults: undefined }; await render(); }
      await click("Review and apply"); await dom.flush();
      assert.equal(dialog(), null); assert.equal(applied.length, 0); assert.ok(dom.container.querySelector('[role="alert"]'));
      assert.deepEqual(props.selectedExtensionIds, ["b"]);
    } else if (scenario === "server-preview") {
      await click("Review and apply"); assert.ok(dialog()?.textContent?.includes("Latest server name")); assert.equal(applied.length, 0); assert.equal(previews.length, 1);
      await click("Apply group default", dialog()!); assert.equal(applied[0]!.expectedFingerprint, "1".padStart(64, "0"));
      await act(async () => { pending.resolve(true); });
    } else if (scenario === "preview-pending" || scenario === "preview-unmount" || scenario === "preview-selection-changed") {
      const reply = (fingerprint: string): ExtensionGroupReview => { const { signature: _s, unknown: _u, ...preview } = extensionGroupPreview("Research", ["b"], props.groupDefaults, props.profiles); return { ...preview, version: 1, unknown: 0, expectedFingerprint: fingerprint.repeat(64) }; };
      await act(async () => { const trigger = button("Review and apply"); trigger.focus(); trigger.click(); trigger.click(); }); await dom.flush();
      assert.equal(previews.length, 1); assert.equal(applied.length, 0); assert.equal(dialog(), null);
      if (scenario === "preview-unmount") {
        await dom.unmount(); assert.equal(previews[0]!.signal?.aborted, true); await act(async () => previewRequests[0]!.resolve(reply("1"))); await dom.flush(); assert.equal(applied.length, 0); assert.equal(dom.container.children.length, 0);
      } else if (scenario === "preview-selection-changed") {
        props = { ...props, selectedExtensionIds: ["c"] }; await render(); await act(async () => previewRequests[0]!.resolve(reply("1"))); await dom.flush();
        assert.equal(dialog(), null); assert.ok(dom.container.textContent?.includes("The group selection changed")); assert.equal(applied.length, 0); assert.deepEqual(props.selectedExtensionIds, ["c"]);
      } else {
        const cancel = button("Cancel review"); assert.equal(dom.window.document.activeElement === cancel, true, "The pending review cancel control receives focus");
        await act(async () => { cancel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
        assert.equal(previews[0]!.signal?.aborted, true); assert.equal(dom.window.document.activeElement === button("Review and apply"), true, "Cancellation restores the enabled review trigger");
        await click("Review and apply"); assert.equal(previews.length, 2);
        await act(async () => previewRequests[0]!.resolve(reply("1"))); await dom.flush(); assert.equal(dialog(), null, "A cancelled response cannot adopt the reopened review");
        await act(async () => previewRequests[1]!.resolve(reply("2"))); await dom.flush(); assert.ok(dialog());
        await click("Apply group default", dialog()!); assert.equal(applied[0]!.expectedFingerprint, "2".repeat(64)); await act(async () => pending.resolve(true));
      }
    } else if (scenario === "stale-data" || scenario === "unavailable-group") {
      props = { ...props, dataFresh: false, draftDirty: true, ...(scenario === "unavailable-group" ? { selectedGroupAvailable: false, groupDefaults: [{ name: "Other", extensions: ["b"] }] } : {}) }; await render();
      assert.equal(button("Review and apply").disabled, true); assert.equal(button("Remove Alpha").disabled, true); assert.equal(button("Add extension").disabled, true);
      const group = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Extension default group"]')!; assert.equal(group.disabled, false); assert.equal(button("Discard unsaved selection").disabled, false);
      if (scenario === "unavailable-group") { assert.equal(group.value, "Research"); assert.ok(group.textContent?.includes("Unavailable · Research")); assert.ok(dom.container.textContent?.includes("This group is unavailable")); }
      await click("Discard unsaved selection"); assert.equal(discards, 1);
      await act(async () => { group.value = "Other"; group.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); assert.deepEqual(selectedGroups, ["Other"]);
      await click("Reload extension data"); assert.equal(reloads, 1); assert.equal(previews.length, 0); assert.equal(applied.length, 0);
      await act(async () => reloadPending.resolve()); await render(); await dom.flush();
      if (scenario === "unavailable-group") { props = { ...props, groupDefaults: [], dataFresh: false }; await render(); assert.ok(dom.container.querySelector('select[aria-label="Extension default group"]')); assert.equal(button("Discard unsaved selection").disabled, false); }
      else assert.equal(button("Review and apply").disabled, false);
    } else if (scenario === "confirm-recovery") {
      await click("Review and apply"); await click("Apply group default", dialog()!);
      props = { ...props, dataFresh: false }; await render(); await act(async () => pending.resolve(false)); await dom.flush();
      assert.ok(dialog()); assert.equal(button("Cancel", dialog()!).disabled, false); assert.equal(button("Reload extension data", dialog()!).disabled, false); assert.equal(button("Review latest changes", dialog()!).disabled, true);
      await click("Reload extension data", dialog()!); assert.equal(reloads, 1); assert.equal(applied.length, 1);
      await act(async () => reloadPending.resolve()); await render(); await dom.flush(); assert.equal(button("Apply group default", dialog()!).disabled, true);
      await click("Review latest changes", dialog()!); assert.equal(previews.length, 2); assert.equal(applied.length, 1); assert.equal(button("Apply group default", dialog()!).disabled, false);
      pending = deferred<boolean>(); await click("Apply group default", dialog()!); assert.equal(applied.length, 2); assert.notEqual(applied[0]!.expectedFingerprint, applied[1]!.expectedFingerprint);
      await act(async () => pending.resolve(true)); assert.equal(dialog(), null);
    } else if (scenario === "remove-stale") {
      await click("Remove Alpha");
      props = { ...props, profiles: [...props.profiles, { id: "five", name: "New assignment", group: "Other", engine: "chromium", running: false, extensions: ["a"] }] };
      await render();
      assert.equal(button("Remove extension", dialog()!).disabled, true);
      assert.ok(dialog()?.querySelector('[role="alert"]')?.textContent?.includes("Assignments changed"));
      await click("Remove extension", dialog()!); assert.equal(removed.length, 0);
      await click("Cancel", dialog()!); await click("Remove Alpha");
      assert.ok(dialog()?.textContent?.includes("2 environment assignments"));
      assert.equal(button("Remove extension", dialog()!).disabled, false);
    } else if (scenario === "remove-retry") {
      await click("Remove Alpha"); assert.equal(removed.length, 0);
      assert.ok(dialog()?.textContent?.includes("1 environment assignments and 1 group defaults"));
      assert.ok(dialog()?.textContent?.includes("files will be deleted"));
      await click("Remove extension", dialog()!);
      await act(async () => { pending.resolve(false); });
      assert.ok(dialog()); assert.deepEqual(removed, [["a", "Alpha"]]);
      pending = deferred<boolean>();
      await click("Remove extension", dialog()!); await click("Remove extension", dialog()!);
      assert.equal(removed.length, 2);
      await act(async () => { pending.resolve(true); }); assert.equal(dialog(), null);
      assert.ok(dom.container.querySelector('[role="status"]')?.textContent?.includes("removed and unassigned"));
    } else throw new Error(`Unknown scenario ${scenario}`);
    console.log("extension management fixture passed");
  } finally { await dom.cleanup(); }
}
await run(process.argv[2] ?? "library-search");
