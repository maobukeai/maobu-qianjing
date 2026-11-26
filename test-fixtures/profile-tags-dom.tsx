import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLElement } from "happy-dom";
import { profileTagsUpdate } from "../profile-tags.ts";
import { ProfileTagsDialog, type ProfileTagsTarget } from "../web/profile-tags.tsx";
import { updateProfile } from "../web/api.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const requests: Array<{ id: string; body: { set: { tags: string[] } }; response: ReturnType<typeof deferred<Response>> }> = [];
  const dom = await createWebDomHarness({ fetch: Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    const match = /^\/ui\/api\/profiles\/([^/]+)\/update$/.exec(String(input));
    assert.ok(match, "Tag editing must never fetch the full edit profile, account fields, proxy fields or other endpoints");
    assert.equal(options?.method, "POST"); const body = JSON.parse(String(options?.body));
    assert.deepEqual(Object.keys(body), ["set"]); assert.deepEqual(Object.keys(body.set), ["tags"]); assert.ok(Array.isArray(body.set.tags));
    const response = deferred<Response>(); requests.push({ id: decodeURIComponent(match[1]!), body, response }); return response.promise;
  }, { preconnect: globalThis.fetch.preconnect }) });
  dom.window.document.documentElement.dataset.desktopMotion = scenario === "reduced-motion" ? "reduced" : "full";
  const initialTags = scenario === "limits" ? Array.from({ length: 20 }, (_, index) => `tag${index}`) : scenario === "legacy-repair" ? ["normal", "x".repeat(41), "bad\u0085legacy"] : scenario === "remove-focus" ? ["Warmup", "priority", "review"] : scenario === "clear" ? ["Warmup", "priority"] : ["Warmup"];
  const original: ProfileTagsTarget = { id: "tags_environment", name: "Original environment", tags: initialTags };
  // Keep these non-enumerable: React's development prop-diff logger enumerates props itself.
  for (const key of ["password", "proxy", "username", "emailPassword", "twofa", "fingerprintSeed"]) Object.defineProperty(original, key, { enumerable: false, get() { throw new Error("Private profile fields must never be read by tag management"); } });
  let closed = 0, outerEscape = 0;
  function Harness({ target = original, sessionKey = "workspace-a" }: { target?: ProfileTagsTarget; sessionKey?: string }) {
    const [open, setOpen] = useState(false);
    return <I18nProvider><button type="button" id="tag-trigger" onClick={() => setOpen(true)}>Manage environment tags</button><button type="button" id="outside">Outside action</button><ProfileTagsDialog target={open ? target : null} sessionKey={sessionKey} returnFocus={() => dom.container.querySelector("#tag-trigger") as unknown as globalThis.HTMLElement} onClose={() => { closed++; setOpen(false); }} onSave={async (id, tags) => {
      const result = await updateProfile(id, profileTagsUpdate(tags)); return result.ok === true;
    }} /></I18nProvider>;
  }
  const dialog = () => [...dom.window.document.querySelectorAll<HTMLElement>('.profile-tags-dialog[role="dialog"]')].find(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dialog()!) => { const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(node, `Missing ${label}`); return node; };
  const input = () => dialog()!.querySelector<HTMLInputElement>("input")!;
  const chips = () => [...dialog()!.querySelectorAll<HTMLElement>(".profile-tags-chips > li > span")].map(item => item.textContent);
  const click = (label: string) => act(async () => { button(label).click(); });
  const type = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const key = (value: string, options: { shiftKey?: boolean; isComposing?: boolean } = {}) => act(async () => { (dom.window.document.activeElement ?? input()).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })); });
  const waitFor = async (condition: () => boolean) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), dom.window.document.body.textContent ?? "No dialog"); };
  const respond = async (index: number, ok = true) => act(async () => { requests[index]!.response.resolve(Response.json({ ok, ...(ok ? {} : { error: "PRIVATE_SERVER_ERROR" }) }, { status: ok ? 200 : 500 })); });
  const open = () => act(async () => { dom.container.querySelector<HTMLButtonElement>("#tag-trigger")!.click(); });
  try {
    await dom.render(<Harness />); assert.equal(requests.length, 0); assert.equal(dialog(), undefined); await open();
    assert.ok(dialog()); assert.equal(dialog()!.getAttribute("aria-modal"), "true"); assert.equal(dom.window.document.activeElement, input()); assert.equal(button("Save tags").disabled, true);
    dom.window.document.addEventListener("keydown", event => { if (event instanceof dom.window.KeyboardEvent && event.key === "Escape") outerEscape++; });
    if (scenario.startsWith("motion-") || scenario === "reduced-motion") {
      await type("unsaved label");
      const oldSave = button("Save tags"), oldEntry = input(), oldForm = dialog()!.querySelector("form")!;
      await click("Cancel"); assert.equal(dialog(), undefined); assert.equal(dom.window.document.activeElement?.id, "tag-trigger");
      const exiting = dom.window.document.querySelector<HTMLElement>('.desktop-motion-presence[data-motion-phase="exiting"]');
      if (scenario === "reduced-motion") { assert.equal(exiting, null); assert.equal(dom.window.document.querySelector(".profile-tags-dialog"), null); return; }
      assert.ok(exiting?.hasAttribute("inert")); assert.equal(exiting?.getAttribute("aria-hidden"), "true");
      await act(async () => {
        oldSave.click(); oldEntry.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        oldForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        dom.container.querySelector<HTMLButtonElement>("#outside")!.focus();
      });
      assert.equal(requests.length, 0, "Retained exit controls must never write tags"); assert.equal(closed, 1);
      assert.equal(dom.window.document.activeElement?.id, "outside", "The closed dialog's focus trap must be released immediately");
      if (scenario === "motion-reopen") {
        const next = { id: "next_environment", name: "Reopened environment", tags: ["New target"] };
        await dom.render(<Harness target={next} sessionKey="workspace-b" />); await open();
        assert.deepEqual(chips(), ["New target"]); assert.equal(input().value, "");
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
        assert.ok(dialog()?.textContent?.includes("Reopened environment")); assert.equal(dom.window.document.querySelectorAll(".profile-tags-dialog").length, 1); assert.equal(requests.length, 0);
      } else await waitFor(() => !dom.window.document.querySelector(".profile-tags-dialog"));
      return;
    }
    if (scenario === "cancel") {
      await type("draft"); await key("Enter"); assert.deepEqual(chips(), ["Warmup", "draft"]); await click("Cancel"); assert.equal(dialog(), undefined); assert.equal(requests.length, 0);
      assert.equal(dom.window.document.activeElement?.id, "tag-trigger"); await open(); assert.deepEqual(chips(), ["Warmup"]); await key("Escape"); assert.equal(dialog(), undefined); assert.equal(outerEscape, 0); assert.equal(requests.length, 0); return;
    }
    if (scenario === "keyboard") {
      const close = button("Close tag editor"), cancel = button("Cancel");
      await act(async () => { close.focus(); }); await key("Tab", { shiftKey: true }); assert.equal(dom.window.document.activeElement, cancel);
      await key("Tab"); assert.equal(dom.window.document.activeElement, close);
      await act(async () => { dom.container.querySelector<HTMLButtonElement>("#outside")!.focus(); }); assert.equal(dom.window.document.activeElement, input());
      await type("输入中"); await key("Enter", { isComposing: true }); assert.deepEqual(chips(), ["Warmup"]); assert.equal(input().value, "输入中");
      await key("，"); assert.deepEqual(chips(), ["Warmup", "输入中"]); assert.equal(requests.length, 0); return;
    }
    if (scenario === "limits") {
      assert.equal(chips().length, 20); await type("extra"); assert.ok(dialog()!.querySelector('[role="alert"]')?.textContent?.includes("at most 20")); assert.equal(button("Save tags").disabled, true); await click("Add"); assert.equal(input().value, "extra");
      await click("Remove tag tag0"); assert.equal(button("Save tags").disabled, false);
      await type("🐈".repeat(41)); assert.ok(dialog()!.querySelector('[role="alert"]')?.textContent?.includes("40 characters")); await click("Add"); assert.equal(chips().length, 19);
      await type("🐈".repeat(40)); assert.equal(dialog()!.querySelector('[role="alert"]'), null); await click("Add"); assert.equal(chips().length, 20);
      await click("Save tags"); assert.equal(requests.length, 1); assert.equal(requests[0]!.body.set.tags.at(-1), "🐈".repeat(40)); await respond(0); await waitFor(() => !dialog()); return;
    }
    if (scenario === "legacy-repair") {
      assert.deepEqual(chips(), ["normal", "x".repeat(41), "bad⟦U+0085⟧legacy"]); assert.ok(dialog()!.querySelector('[role="alert"]'));
      await click(`Remove tag ${"x".repeat(41)}`); assert.ok(dialog()!.querySelector('[role="alert"]')); await click("Remove tag bad⟦U+0085⟧legacy");
      assert.equal(dialog()!.querySelector('[role="alert"]'), null); await click("Save tags"); assert.deepEqual(requests[0]!.body, { set: { tags: ["normal"] } }); await respond(0); await waitFor(() => !dialog()); return;
    }
    if (scenario === "remove-focus") {
      await click("Remove tag priority");
      assert.deepEqual(chips(), ["Warmup", "review"]);
      assert.equal(dom.window.document.activeElement, button("Remove tag review"));
      await click("Remove tag review");
      assert.equal(dom.window.document.activeElement, button("Remove tag Warmup"));
      await click("Remove tag Warmup");
      assert.deepEqual(chips(), []);
      assert.equal(dom.window.document.activeElement, input());
      assert.equal(requests.length, 0);
      return;
    }
    if (scenario === "clear") {
      await click("Remove tag Warmup"); await click("Remove tag priority"); assert.deepEqual(chips(), []); await click("Save tags"); assert.deepEqual(requests[0]!.body, { set: { tags: [] } }); await respond(0); await waitFor(() => !dialog()); return;
    }
    await type("research, priority，warmup"); await key("Enter"); assert.deepEqual(chips(), ["Warmup", "research", "priority"]);
    await type("RESEARCH"); await key(","); assert.deepEqual(chips(), ["Warmup", "research", "priority"]); assert.ok(dialog()!.textContent?.includes("already in the list"));
    await click("Remove tag Warmup"); await type("final");
    await act(async () => { const save = button("Save tags"); save.click(); save.click(); });
    await waitFor(() => requests.length === 1); assert.deepEqual(requests[0]!.body, { set: { tags: ["research", "priority", "final"] } });
    assert.equal(dialog()!.getAttribute("aria-busy"), "true"); assert.equal(button("Cancel").disabled, true); assert.equal(button("Close tag editor").disabled, true);
    await key("Escape"); assert.equal(outerEscape, 0); assert.ok(dialog()); assert.equal(closed, 0);
    if (scenario.startsWith("stale-")) {
      const next: ProfileTagsTarget = { id: scenario === "stale-session" ? original.id : "next_environment", name: "Next environment", tags: ["Next label"] };
      await dom.render(<Harness target={next} sessionKey="workspace-b" />); assert.deepEqual(chips(), ["Next label"]); assert.equal(input().value, "");
      await type("new draft"); await respond(0, scenario !== "stale-failure"); await dom.flush();
      assert.ok(dialog()?.textContent?.includes("Next environment")); assert.equal(input().value, "new draft"); assert.equal(dialog()!.getAttribute("aria-busy"), "false"); assert.equal(dialog()!.querySelector('[role="alert"]'), null); assert.equal(closed, 0);
      await click("Save tags"); assert.equal(requests.length, 2); assert.equal(requests[1]!.id, next.id); assert.deepEqual(requests[1]!.body.set.tags, ["Next label", "new draft"]); await respond(1); await waitFor(() => !dialog());
    } else if (scenario === "failure-retry") {
      await respond(0, false); await waitFor(() => !!dialog()!.querySelector('[role="alert"]'));
      assert.ok(dialog()!.textContent?.includes("Your draft is kept")); assert.ok(!dialog()!.textContent?.includes("PRIVATE_SERVER_ERROR")); assert.deepEqual(chips(), ["research", "priority", "final"]); assert.equal(button("Save tags").disabled, false);
      await click("Save tags"); assert.equal(requests.length, 2); assert.deepEqual(requests[1]!.body, requests[0]!.body); await respond(1); await waitFor(() => !dialog());
    } else { assert.equal(scenario, "add-and-save"); await respond(0); await waitFor(() => !dialog()); }
    assert.equal(closed, 1); assert.equal(dom.window.document.activeElement?.id, "tag-trigger");
  } finally { for (const request of requests) request.response.resolve(Response.json({ ok: false })); await dom.cleanup(); }
}

await run(process.argv[2] ?? "add-and-save");
console.log("profile tags interaction fixture passed");
