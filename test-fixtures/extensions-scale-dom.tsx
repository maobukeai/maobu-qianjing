import assert from "node:assert/strict";
import { act } from "react";
import type { Element, HTMLInputElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { ExtensionsPage, extensionGroupPreview, type ExtensionsPageProps, type GroupDefaultsSnapshot } from "../web/extensions-page.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run() {
  const dom = await createWebDomHarness();
  const numbered = (index: number) => String(index + 1).padStart(2, "0");
  const extensions = Array.from({ length: 14 }, (_, index) => ({ id: `extension-${numbered(index)}`, name: `Tool ${numbered(index)}` }));
  const profiles = Array.from({ length: 28 }, (_, index) => ({
    id: `profile-${numbered(index)}`, name: `Environment ${numbered(index)}`, group: "Research", engine: "chromium" as const,
    running: index === 25, extensions: ["extension-01"],
  }));
  const reviewed: Array<{ group: string; extensions: string[] }> = [];
  const applied: GroupDefaultsSnapshot[] = [];
  let completeApply!: (succeeded: boolean) => void;
  const applyPending = new Promise<boolean>(resolve => { completeApply = resolve; });
  let props: ExtensionsPageProps = {
    extensions, profiles, selectedGroup: "Research", groupDefaults: [{ name: "Research", extensions: ["extension-01"] }],
    selectedExtensionIds: ["extension-04", "extension-12"], source: "", installing: false, uploading: false, applying: false, error: null,
    onSourceChange() {}, onSelectGroup() {},
    onToggleExtension(id) {
      const selected = new Set(props.selectedExtensionIds);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      props = { ...props, selectedExtensionIds: [...selected] };
    },
    onInstall: async () => false, onUpload: async () => false, onRemove: async () => false,
    onPreviewGroupDefaults: async selection => {
      reviewed.push({ group: selection.group, extensions: [...selection.extensions] });
      const { signature: _signature, ...preview } = extensionGroupPreview(selection.group, selection.extensions, props.groupDefaults, props.profiles);
      return { ...preview, version: 1, unknown: 0, expectedFingerprint: reviewed.length.toString(16).repeat(64) };
    },
    onApplyGroupDefaults: async selection => { applied.push(selection); return applyPending; },
  };
  const render = () => dom.render(<I18nProvider><ExtensionsPage {...props} /></I18nProvider>);
  const body = dom.window.document.body;
  const defaults = () => dom.container.querySelector(".extensions-defaults")!;
  const dialog = () => [...body.querySelectorAll('[role="dialog"]')].find(node => !node.closest('[inert], [aria-hidden="true"]'))!;
  const button = (label: string, within: Element = body) => {
    const found = [...within.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent.trim() === label);
    assert.ok(found, `Missing button ${label}`);
    return found;
  };
  const search = (section: Element) => {
    const input = section.querySelector('input[type="search"]');
    assert.ok(input, "A long list should offer search");
    return input as HTMLInputElement;
  };
  const type = (input: ReturnType<typeof search>, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const click = (label: string, within: Element = body) => act(async () => {
    const element = button(label, within);
    element.focus();
    element.click();
  });
  const choices = () => [...defaults().querySelectorAll(".extensions-default-choice")];
  const reviewRows = () => [...dialog().querySelectorAll(".extensions-change-details li")];

  try {
    await render();
    const defaultSearch = search(defaults());
    assert.equal(choices().length, 14);
    await type(defaultSearch, " tOoL 12 ");
    assert.deepEqual(choices().map(row => row.textContent.trim()), ["Tool 12"]);
    assert.equal((choices()[0]!.querySelector("input") as HTMLInputElement).checked, true);
    assert.match(defaults().textContent, /2 selected/);
    assert.match(defaults().textContent, /1 hidden by search/);
    await type(defaultSearch, "EXTENSION-03");
    assert.deepEqual(choices().map(row => row.textContent.trim()), ["Tool 03"]);
    await act(async () => (choices()[0]!.querySelector("input") as HTMLInputElement).click());
    await render();
    assert.match(defaults().textContent, /3 selected/);
    assert.match(defaults().textContent, /2 hidden by search/);
    await type(defaultSearch, "missing-tool");
    assert.equal(choices().length, 0);
    assert.match(defaults().textContent, /3 hidden by search/);
    assert.equal(button("Review and apply").disabled, false);
    const expectedSelection = { group: "Research", extensions: ["extension-03", "extension-04", "extension-12"] };
    await click("Review and apply");
    assert.deepEqual(reviewed, [expectedSelection]);
    assert.equal(applied.length, 0);

    assert.equal(reviewRows().length, 12);
    assert.equal(reviewRows()[0]!.querySelector("strong")?.textContent, "Environment 01");
    assert.match(dialog().textContent, /28 environments will change/);
    assert.equal(button("Previous page", dialog()).getAttribute("aria-disabled"), "true");
    await click("Next page", dialog());
    assert.equal(reviewRows()[0]!.querySelector("strong")?.textContent, "Environment 13");
    await click("Next page", dialog());
    assert.equal(reviewRows().length, 4);
    assert.equal(reviewRows()[0]!.querySelector("strong")?.textContent, "Environment 25");
    assert.equal(button("Next page", dialog()).getAttribute("aria-disabled"), "true");
    assert.equal(dom.window.document.activeElement, button("Next page", dialog()));

    const reviewSearch = search(dialog());
    await type(reviewSearch, "PROFILE-26");
    assert.deepEqual(reviewRows().map(row => row.querySelector("strong")?.textContent), ["Environment 26"]);
    assert.match(reviewRows()[0]!.textContent, /Running · reopen to apply/);
    assert.match(dialog().textContent, /28 environments will change/);
    await type(reviewSearch, "no environment matches");
    assert.equal(reviewRows().length, 0);
    assert.match(dialog().textContent, /28 environments will change/);
    assert.equal(button("Apply group default", dialog()).disabled, false);

    props = { ...props, profiles: profiles.map(profile => profile.id === "profile-28" ? { ...profile, extensions: ["extension-02"] } : profile) };
    await render();
    assert.equal(button("Apply group default", dialog()).disabled, true);
    assert.match(dialog().textContent, /Assignments changed/);
    await click("Review latest changes", dialog());
    assert.deepEqual(reviewed, [expectedSelection, expectedSelection]);
    assert.equal(search(dialog()).value, "");
    assert.equal(reviewRows().length, 12);
    await type(search(dialog()), "profile-26");
    await click("Apply group default", dialog());
    assert.deepEqual(applied, [{ ...expectedSelection, expectedFingerprint: "2".repeat(64) }]);
    assert.equal(search(dialog()).disabled, true);
    await click("Apply group default", dialog());
    assert.equal(applied.length, 1);
    await act(async () => completeApply(true));
    assert.equal(dialog(), undefined);
  } finally {
    await dom.cleanup();
  }
}

await run();
console.log("extension management fixture passed");
