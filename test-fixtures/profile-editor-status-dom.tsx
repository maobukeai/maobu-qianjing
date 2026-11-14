import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { ProfileEditorStatus, type ProfileEditorStatusProps } from "../web/profile-editor-status.tsx";
import { useDesktopMotion } from "../web/desktop-motion.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  dom.window.matchMedia = (() => ({ matches: scenario === "reduced", addEventListener() {}, removeEventListener() {} })) as any;
  let reviews = 0, problems = 0, saves = 0, cancels = 0;
  const base: ProfileEditorStatusProps = { kind: "edit", editChangeCount: 0, hasValidationError: false, hasSaveError: false, onReview() { reviews++; dom.container.querySelector<HTMLElement>("[data-review]")?.focus(); }, onLocateProblem() { problems++; dom.container.querySelector<HTMLElement>("[data-error]")?.focus(); } };
  function Shell({ props }: { props: ProfileEditorStatusProps }) {
    useDesktopMotion();
    return <section><input aria-label="Existing draft" defaultValue="PRIVATE_DRAFT" /><div data-review tabIndex={-1}>Real editor review destination</div><div data-error tabIndex={-1}>Real editor error destination</div>
      <footer className="modal-foot profile-editor-status-footer" style={{ display: "flex", gap: 8 }}><ProfileEditorStatus {...props} /><button className="btn" type="button" onClick={() => cancels++}>Cancel</button><button className="btn" type="button" onClick={() => saves++}>Save</button></footer></section>;
  }
  const render = (props: ProfileEditorStatusProps = base) => dom.render(<I18nProvider><Shell props={props} /></I18nProvider>);
  const status = () => dom.container.querySelector<HTMLElement>(".profile-editor-status")!;
  const input = () => dom.container.querySelector<HTMLInputElement>("input")!;
  const button = (text: string) => { const value = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text); assert.ok(value, `Missing ${text}`); return value; };
  const activate = (text: string) => act(async () => { const node = button(text); node.focus(); node.click(); });
  try {
    await render(); const original = input(); original.focus();
    assert.ok(status().textContent?.includes("No changes to save")); assert.equal(status().querySelector("button"), null);
    if (scenario === "create-change") {
      const props = { kind: "create", createSummary: { browserLabel: "Firefox", hasProxy: false, manualFingerprint: false }, hasValidationError: false, hasSaveError: false, onLocateProblem: base.onLocateProblem } satisfies ProfileEditorStatusProps;
      await render(props); assert.ok(status().textContent?.includes("Firefox")); assert.ok(status().textContent?.includes("No profile proxy"));
      await render({ ...props, createSummary: { browserLabel: "CloakBrowser", hasProxy: true, manualFingerprint: true } });
      assert.ok(status().textContent?.includes("CloakBrowser")); assert.ok(status().textContent?.includes("Profile proxy configured")); assert.ok(status().textContent?.includes("Custom fingerprint settings"));
      assert.equal(dom.window.document.activeElement, original); assert.equal(original.value, "PRIVATE_DRAFT"); return;
    }
    await render({ ...base, editChangeCount: 3 }); assert.ok(status().textContent?.includes("3 fields changed"));
    assert.equal(status().querySelector('[aria-live="polite"]')?.textContent, "", "Ordinary edit count changes should not repeatedly announce while typing");
    assert.equal(dom.window.document.activeElement, original);
    if (scenario === "error-focus" || scenario === "save-error") {
      await render({ ...base, editChangeCount: scenario === "error-focus" ? 0 : 3, hasValidationError: scenario === "error-focus", hasSaveError: scenario === "save-error" });
      assert.equal(dom.window.document.activeElement, original, "Error rendering must not steal input focus");
      assert.ok(!status().textContent?.includes("No changes to save"));
      assert.ok(status().querySelector('[aria-live="polite"]')?.textContent?.includes(scenario === "save-error" ? "Save needs attention" : "Some changes need attention"));
      const described = button("View problem").getAttribute("aria-describedby"); assert.ok(described); assert.ok(dom.window.document.getElementById(described!));
      await activate("View problem"); assert.equal(problems, 1); assert.equal(reviews, 0); assert.equal(saves, 0); assert.equal(original.value, "PRIVATE_DRAFT");
      assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-error]")); return;
    }
    await activate("Review changes"); assert.equal(reviews, 1); assert.equal(saves, 0); assert.equal(cancels, 0);
    assert.equal(button("Review changes").type, "button"); assert.equal(dom.window.document.activeElement, dom.container.querySelector("[data-review]"));
    if (scenario === "buttons") { await activate("Cancel"); await activate("Save"); assert.equal(cancels, 1); assert.equal(saves, 1); assert.equal(reviews, 1); }
    if (scenario === "reduced") { assert.equal(dom.window.document.documentElement.dataset.desktopMotion, "reduced"); assert.equal(status().querySelector('[role="progressbar"], [aria-busy="true"]'), null); }
    assert.ok(!status().outerHTML.includes("PRIVATE_DRAFT")); assert.equal(input(), original);
  } finally { await dom.cleanup(); }
}
await run(process.argv[2] ?? "edit-review"); console.log("profile editor status DOM passed");
