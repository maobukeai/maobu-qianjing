import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLDetailsElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const create = scenario.startsWith("create-"), id = "guard_fixture";
  const detail = { id, name: "Saved fixture", engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", proxyType: "http", proxy: "", proxyError: "", username: "inert-user", password: "inert-saved-password", email: "", emailPassword: "", twofa: "", resolution: "1920*1080", platformOs: "windows", extensions: [] as string[], tags: "", customNo: "", timezone: "UTC", timezoneManual: false, locale: "en-US", cores: "8", fingerprintSeed: "777", cookieCount: 0, seeded: true, mobilePersona: false };
  const profiles = [{ id, name: detail.name, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: [], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: 1, createdAt: 1, lastOpenAt: 0, customNo: "", running: false }];
  const writes: Array<{ path: string; body: any; response: ReturnType<typeof deferred<Response>> }> = [], unexpected: string[] = [];
  let nativeConfirmations = 0;
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    if (method === "POST" && (path === "/ui/api/profiles" || path === `/ui/api/profiles/${id}/update`)) { const response = deferred<Response>(); writes.push({ path, body: JSON.parse(String(options?.body)), response }); return response.promise; }
    if (method === "GET" && path === `/ui/api/profiles/${id}`) return Response.json({ ok: true, profile: detail });
    if (method === "GET" && path === `/ui/api/profiles/${id}/totp`) return Response.json({ ok: true, code: null });
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return Response.json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/profiles": { ok: true, profiles, groups: [], folders: [] },
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-guard-fixture" },
      "/ui/api/extensions": { ok: true, extensions: [] }, "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false }, "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/settings/templates": { ok: true, catalog: { version: 1, revision: 0, templates: [] } },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [{ id: "default", name: "Guard fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-guard-fixture", profileCount: 1, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App guard fixture request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window), confirm: () => { nativeConfirmations++; return true; } })) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => { nativeConfirmations++; return true; } });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const value = createRealRoot(...args); root = value; return value; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  // The protected editor itself becomes inert while its confirmation is open.
  // Only an inert ancestor denotes the separate MotionPresence visual exit.
  const editor = () => [...dom.container.querySelectorAll<HTMLElement>(`[role="dialog"][aria-labelledby="${create ? "create" : "edit"}-profile-title"]`)].find(node => !node.parentElement?.closest('[inert], [aria-hidden="true"]'));
  const confirmation = () => visible<HTMLElement>('[role="alertdialog"]')[0];
  const button = (text: string, scope: HTMLElement = dom.window.document.body) => { const found = visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === text || node.getAttribute("aria-label") === text); assert.ok(found, `Missing ${text}`); return found; };
  const field = (label: string) => { const input = [...editor()!.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent?.trim() === label)?.querySelector<HTMLInputElement>("input"); assert.ok(input, `Missing ${label}`); return input; };
  const type = (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const click = (node: HTMLButtonElement, twice = false) => act(async () => { node.click(); if (twice) node.click(); });
  const key = (target: HTMLElement, isComposing = false) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing })); });
  const releaseEscape = () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  const waitFor = async (test: () => boolean, why: string) => { const deadline = Date.now() + 2500; while (!test() && Date.now() < deadline) await dom.flush(); assert.ok(test(), `${why}; unexpected=${JSON.stringify(unexpected)}`); };
  const open = async () => {
    await click(create ? button("New Profile", dom.container) : dom.container.querySelector<HTMLButtonElement>(".profile-name-button")!);
    await waitFor(() => !!editor()?.querySelector("input"), "The actual editor must load its real form");
  };
  const attempt = async (method: string) => {
    const origin = method === "escape" ? field("Name") : button(method === "x" ? "Close" : "Cancel", editor()!);
    origin.focus(); if (method === "escape") await key(origin); else await click(origin as HTMLButtonElement);
    return origin;
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible(".profile-name-button").length === 1, "The actual App must bootstrap"); await open();
    if (scenario.endsWith("clean")) {
      await attempt("escape"); assert.equal(editor(), undefined); assert.equal(confirmation(), undefined); assert.equal(writes.length, 0); return;
    }
    if (scenario.endsWith("ime")) {
      const name = field("Name"); await type(name, "Composition draft"); name.focus();
      await key(name, true); assert.ok(editor()); assert.equal(confirmation(), undefined, "IME Escape must cancel composition without requesting editor closure");
      await attempt("x"); assert.ok(confirmation()); await key(button("Keep editing", confirmation()!), true);
      assert.ok(confirmation(), "IME Escape inside confirmation must not discard or dismiss it");
      await key(button("Keep editing", confirmation()!)); releaseEscape();
      assert.equal(confirmation(), undefined); assert.ok(editor()); assert.equal(field("Name").value, "Composition draft"); assert.equal(writes.length, 0); return;
    }
    if (scenario.endsWith("save")) {
      await type(field("Name"), "Confirmed saved draft"); await click(button(create ? "Create profile" : "Save changes", editor()!), true);
      assert.equal(writes.length, 1); assert.equal(confirmation(), undefined);
      await key(editor()!); assert.ok(editor()); assert.equal(confirmation(), undefined, "An in-flight save must not request discarding");
      await act(async () => { if (!create) detail.name = "Confirmed saved draft"; writes[0]!.response.resolve(Response.json(create ? { ok: true, id: "created_fixture" } : { ok: true })); });
      await waitFor(() => !editor(), "A confirmed save must close without a second dirty prompt"); assert.equal(confirmation(), undefined); assert.equal(writes.length, 1);
      await open(); await attempt("escape"); assert.equal(editor(), undefined); assert.equal(confirmation(), undefined, "The next untouched session must not inherit an old close intent"); return;
    }
    const original = editor(), name = field("Name"), before = name.value;
    if (scenario.endsWith("invalid")) {
      const input = field(create ? "Host" : "Screen");
      const detailNode = input.closest("details") as HTMLDetailsElement | null; if (detailNode && !detailNode.open) await act(async () => detailNode.querySelector("summary")!.click());
      await type(input, create ? "invalid host with spaces" : "PRIVATE_INVALID_SCREEN");
      await attempt("cancel"); assert.ok(confirmation(), "Invalid inputs still need protection even when validation cannot build a change summary");
      assert.ok(!confirmation()!.outerHTML.includes("PRIVATE_INVALID_SCREEN")); await click(button("Keep editing", confirmation()!));
      assert.equal(editor(), original); assert.equal(input.value, create ? "invalid host with spaces" : "PRIVATE_INVALID_SCREEN"); assert.equal(name.value, before); assert.equal(writes.length, 0); return;
    }
    await type(name, "UNSAVED_PRIVATE_DRAFT");
    const password = editor()!.querySelector<HTMLInputElement>('input[aria-label="Password"]'); if (password) await type(password, "PRIVATE_GUARD_PASSWORD");
    const origin = await attempt(scenario.split("-").at(-1)!);
    assert.equal(editor(), original); assert.equal(name.value, "UNSAVED_PRIVATE_DRAFT"); assert.ok(confirmation());
    assert.ok(!confirmation()!.outerHTML.includes("UNSAVED_PRIVATE_DRAFT")); assert.ok(!confirmation()!.outerHTML.includes("PRIVATE_GUARD_PASSWORD"));
    if (scenario.endsWith("escape")) { await key(button("Keep editing", confirmation()!)); releaseEscape(); }
    else await click(button("Keep editing", confirmation()!));
    assert.equal(confirmation(), undefined); assert.equal(editor(), original); assert.equal(name.value, "UNSAVED_PRIVATE_DRAFT");
    assert.equal(dom.window.document.activeElement, origin, "Continuing must immediately restore the original editor control");
    await attempt("cancel"); await click(button("Discard changes", confirmation()!), true);
    assert.equal(editor(), undefined); assert.equal(confirmation(), undefined); assert.equal(writes.length, 0, "Discard must not save or write the draft");
    await open(); assert.ok(editor()); assert.equal(field("Name").value, before, "A fresh session must not inherit discarded values even if exit motion reuses its DOM surface");
    await attempt("escape"); assert.equal(editor(), undefined); assert.equal(confirmation(), undefined);
    assert.deepEqual(unexpected, []); assert.equal(nativeConfirmations, 0, "The actual close flow must use the custom guard, never window.confirm");
  } finally {
    for (const write of writes) write.response.resolve(Response.json({ ok: false, error: "Fixture teardown" }, { status: 503 }));
    if (root) await act(async () => root!.unmount()); await dom.cleanup();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
await run(process.argv[2] ?? "create-x"); console.log("actual App unsaved changes fixture passed");
