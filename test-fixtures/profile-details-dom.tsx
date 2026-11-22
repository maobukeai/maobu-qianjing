import assert from "node:assert/strict";
import { act, createRef } from "react";
import type { HTMLElement, HTMLButtonElement } from "happy-dom";
import type { UiProfile } from "../web/api.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { ProfileDetailsPanel } from "../web/features/profile-details.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const dom = await createWebDomHarness();
const headingRef = createRef<HTMLHeadingElement>();
const base: UiProfile = { id: "profile-a", name: "First profile", engine: "firefox", group: "QA", platform: "", tags: [], proxy: "[::1]:1080", timezone: "Asia/Shanghai", cookieCount: 2, seeded: true, screen: "1280x720", has2fa: false, running: false, customNo: "42" };
const edited: string[] = [], inspected: string[] = [];
let closed = 0;
async function render(profile: UiProfile | null = base) {
  await dom.render(<I18nProvider><button type="button" data-roster-action>Existing row action</button><ProfileDetailsPanel profile={profile} headingRef={headingRef} id="profile-details" onEdit={id => edited.push(id)} onInspect={id => inspected.push(id)} onClose={() => closed++} /></I18nProvider>);
}
function button(text: string) { const found = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text); assert.ok(found, `Missing ${text}`); return found; }
try {
  await render();
  const panel = dom.container.querySelector<HTMLElement>('aside[role="complementary"]')!;
  assert.ok(panel); assert.equal(panel.id, "profile-details");
  assert.equal(dom.window.document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent, "First profile");
  assert.ok(panel.textContent?.includes("[::1]:1080")); assert.ok(panel.textContent?.includes("Firefox")); assert.ok(panel.textContent?.includes("42"));
  assert.ok(!panel.hasAttribute("aria-modal"));
  const rowAction = dom.container.querySelector<HTMLElement>("[data-roster-action]")!;
  rowAction.focus();
  assert.equal(dom.window.document.activeElement, rowAction, "Opening details must not trap or steal focus");
  await render({ ...base, id: "profile-b", name: "Second profile", engine: "chromium", chromiumRuntime: "aliasmode", proxy: null, running: true, restartPending: true, pendingCookieCount: 4 });
  assert.equal(dom.window.document.activeElement, rowAction, "Refreshing a profile must not steal table focus");
  assert.ok(panel.textContent?.includes("Second profile")); assert.ok(panel.textContent?.includes("No profile proxy"));
  assert.ok(panel.textContent?.includes("4 cookie(s) at next start"));
  await act(async () => { button("Edit profile").click(); button("Inspect network & fingerprint").click(); });
  assert.deepEqual(edited, ["profile-b"]); assert.deepEqual(inspected, ["profile-b"]);
  const outsideEscape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { rowAction.dispatchEvent(outsideEscape); });
  assert.equal(closed, 0, "Escape elsewhere must remain available to the table");
  headingRef.current?.focus();
  assert.equal(dom.window.document.activeElement, headingRef.current, "Parent can explicitly focus the detail heading");
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { headingRef.current?.dispatchEvent(escape as unknown as KeyboardEvent); });
  assert.equal(closed, 1); assert.ok(escape.defaultPrevented);
  await act(async () => { panel.querySelector<HTMLButtonElement>('button[aria-label="Close environment details"]')!.click(); });
  assert.equal(closed, 2);
  await render(null); assert.equal(dom.container.querySelector("aside"), null);
} finally { await dom.cleanup(); }
console.log("profile details DOM passed");
