import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLButtonElement, HTMLInputElement, HTMLElement } from "happy-dom";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const profiles = [1, 2].map(index => ({ id: `tag_profile_${index}`, name: `Environment ${index}`, engine: "chromium", chromiumRuntime: "aliasmode", group: "", platform: "", tags: index === 1 ? ["Warmup"] : ["Other"], extensions: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, serial: index, createdAt: 1, lastOpenAt: 0, customNo: "", running: false }));
  const id = profiles[0]!.id, requests: Array<{ path: string; method: string }> = [], unexpected: string[] = [];
  const saves: Array<{ id: string; tags: string[]; response: ReturnType<typeof deferred<Response>> }> = [];
  const reuse = deferred<Response>(); let reuseSignal: AbortSignal | null | undefined;
  let rosterReads = 0;
  const workspace = { id: "default", name: "Inert fixture workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET"; requests.push({ path, method });
    const update = /^\/ui\/api\/profiles\/([^/]+)\/update$/.exec(path);
    if (update && method === "POST") {
      const body = JSON.parse(String(options?.body)); assert.deepEqual(Object.keys(body), ["set"]); assert.deepEqual(Object.keys(body.set), ["tags"]); assert.ok(Array.isArray(body.set.tags));
      const response = deferred<Response>(); saves.push({ id: decodeURIComponent(update[1]!), tags: body.set.tags, response }); return response.promise;
    }
    if (scenario === "late-reuse" && path === `/ui/api/profiles/${id}/reuse` && method === "GET") { reuseSignal = options?.signal; return reuse.promise; }
    if (path === "/ui/api/profiles" && method === "GET") { rosterReads++; return Response.json({ ok: true, profiles, groups: [], folders: [] }); }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return Response.json({ ok: true, preferences: {} });
    const startup: Record<string, unknown> = {
      "/ui/api/shell-language": { ok: true, language: "en-US" },
      "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
      "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-fixture-root" },
      "/ui/api/extensions": { ok: true, extensions: [] },
      "/ui/api/diagnose/latest": { ok: true, report: null },
      "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
      "/ui/api/runtime-downloads": { ok: true, downloads: [] },
      "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
      "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace] },
      "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-fixture-root", profileCount: 2, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
      "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
    };
    if (method === "GET" && Object.hasOwn(startup, path)) return Response.json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unowned networking blocked: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window resource networking is disabled"); } });
  let appRoot: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const root = createRealRoot(...args); appRoot = root; return root; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const button = (label: string, scope: HTMLElement = dom.window.document.body) => { const node = visible<HTMLButtonElement>("button", scope).find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(node, `Missing ${label}`); return node; };
  const dialog = () => visible<HTMLElement>('.profile-tags-dialog[role="dialog"]')[0];
  const row = () => visible<HTMLElement>(`tr[data-profile-id="${id}"]`)[0]!;
  const preview = () => visible<HTMLButtonElement>(".profile-tags-preview", row())[0];
  const click = (node: HTMLButtonElement) => act(async () => { node.click(); });
  const type = (node: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const waitFor = async (condition: () => boolean, message: string) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await dom.flush(); assert.ok(condition(), `${message}; requests=${JSON.stringify(requests)}`); };
  const menuAction = async (label: string) => {
    await click(row().querySelector<HTMLButtonElement>(".profile-menu-trigger")!);
    const menu = visible<HTMLElement>('[role="menu"][aria-label="Actions for Environment 1"]')[0]; assert.ok(menu); await click(button(label, menu));
  };
  const save = async () => { await click(button("Save tags", dialog()!)); await waitFor(() => saves.length > 0, "Saving must send a tags-only update"); };
  const respond = async (index: number, body: Record<string, unknown>, status = 200) => act(async () => {
    const request = saves[index]!; if (body.ok === true) profiles.find(profile => profile.id === request.id)!.tags = [...request.tags];
    request.response.resolve(Response.json(body, { status }));
  });
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible("tr[data-profile-id]").length === 2, "Bootstrap must render the actual roster");
    const initialReads = rosterReads;
    if (scenario === "late-reuse") {
      await menuAction("Create from this configuration"); await waitFor(() => !!reuseSignal, "Reuse must start a source-only read");
    }
    await menuAction("Manage tags"); assert.ok(dialog()); assert.equal(saves.length, 0);
    assert.equal(requests.some(request => /^\/ui\/api\/profiles\/[^/]+$/.test(request.path)), false, "Opening tag management must never fetch secret edit details");
    const entry = () => dialog()!.querySelector<HTMLInputElement>("input")!;
    if (scenario === "late-reuse") {
      assert.equal(reuseSignal?.aborted, true); await type(entry(), "tag draft remains");
      await act(async () => { reuse.resolve(Response.json({ ok: true, profile: { sourceId: id, name: "Environment 1", group: "", engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "" } })); });
      await dom.flush(); assert.ok(dialog()); assert.equal(entry().value, "tag draft remains");
      assert.equal(visible('[role="dialog"][aria-labelledby="create-profile-title"]').length, 0); assert.equal(saves.length, 0); assert.deepEqual(unexpected, []); return;
    }
    if (scenario === "ime-cancel") {
      await type(entry(), "输入中"); await act(async () => { entry().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); });
      assert.equal(entry().value, "输入中"); assert.equal(dialog()!.querySelectorAll(".profile-tags-chips li").length, 1); assert.equal(saves.length, 0);
      await click(button("Cancel", dialog()!)); assert.equal(dialog(), undefined); assert.equal(preview()!.textContent, "Warmup"); assert.equal(rosterReads, initialReads); return;
    }
    await click(button("Remove tag Warmup", dialog()!));
    if (scenario !== "clear") await type(entry(), "research, priority，regional");
    await save(); assert.equal(saves.length, 1); assert.equal(saves[0]!.id, id);
    assert.deepEqual(saves[0]!.tags, scenario === "clear" ? [] : ["research", "priority", "regional"]);
    assert.equal(button("Cancel", dialog()!).disabled, true); assert.equal(preview()!.textContent, "Warmup");
    if (scenario === "failure-retry" || scenario === "missing-ok") {
      await respond(0, scenario === "missing-ok" ? { saved: true } : { ok: false, error: "PRIVATE_SERVER_ERROR" }, scenario === "missing-ok" ? 200 : 500);
      await waitFor(() => !!dialog()?.querySelector('[role="alert"]'), "Only a confirmed API result may close the editor");
      assert.ok(!dialog()!.textContent?.includes("PRIVATE_SERVER_ERROR")); assert.equal(preview()!.textContent, "Warmup"); assert.equal(rosterReads, initialReads); assert.equal(dialog()!.querySelectorAll(".profile-tags-chips li").length, 3);
      await save(); assert.equal(saves.length, 2); assert.deepEqual(saves[1]!.tags, saves[0]!.tags); await respond(1, { ok: true });
    } else await respond(0, { ok: true });
    await waitFor(() => !dialog(), "Confirmed tags and refreshed roster must close the editor"); assert.ok(rosterReads > initialReads);
    if (scenario === "clear") { assert.equal(preview(), undefined); await type(visible<HTMLInputElement>('input[aria-label="Search profiles"]')[0]!, "Warmup"); assert.equal(visible("tr[data-profile-id]").length, 0); }
    else {
      assert.deepEqual([...preview()!.querySelectorAll("span")].map(node => node.textContent), ["research", "priority"]); assert.equal(preview()!.querySelector("small")?.textContent, "+1");
      const search = visible<HTMLInputElement>('input[aria-label="Search profiles"]')[0]!; await type(search, "regional");
      assert.equal(visible("tr[data-profile-id]").length, 1); assert.equal(row().dataset.profileId, id); await type(search, "Warmup"); assert.equal(visible("tr[data-profile-id]").length, 0);
      await click(button("Clear search")); await click(preview()!); assert.ok(dialog(), "The row's visible tag preview must reopen quick management");
    }
    assert.deepEqual(unexpected, []);
  } finally {
    if (appRoot) await act(async () => { appRoot!.unmount(); });
    for (const request of saves) request.response.resolve(Response.json({ ok: false })); reuse.resolve(Response.json({ ok: false })); await dom.cleanup();
  }
}

await run(process.argv[2] ?? "save-and-search");
console.log("actual App tags interaction fixture passed");
