import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement } from "happy-dom";
import type { ExtensionGroupReview, GroupExtensionDefaults, UiProfile } from "../web/api.ts";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const profile = (id: string, group: string, extensions: string[]): UiProfile => ({ id, name: `Synthetic ${id}`, engine: "chromium", chromiumRuntime: "aliasmode", group, platform: "", tags: [], extensions, proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1600x900", has2fa: false, serial: id.endsWith("one") ? 1 : 2, createdAt: 1, lastOpenAt: 0, customNo: "", running: false, mobilePersona: false });
  const groupNames = ["missing-group-draft", "all-missing-drafts"].includes(scenario) ? ["Research", "Other"] : ["Team One", "Team Two"];
  let profiles = [profile("extension_one", groupNames[0]!, ["alpha"]), profile("extension_two", groupNames[1]!, ["gamma"])];
  let registry = [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }];
  let defaults: GroupExtensionDefaults[] = [{ name: groupNames[0]!, extensions: ["alpha"] }, { name: groupNames[1]!, extensions: ["gamma"] }];
  let failDefaults = false, failRoster = false;
  const requests: Array<{ path: string; method: string; body?: any }> = [], unexpected: string[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const count = (path: string, method = "GET") => requests.filter(request => request.path === path && request.method === method).length;
  const mutationCount = () => requests.filter(request => request.method !== "GET" && request.path !== "/ui/api/workspace/preferences").length;
  const workspace = { id: "default", name: "Extension fixture", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const startup: Record<string, unknown> = {
    "/ui/api/shell-language": { ok: true, language: "en-US" },
    "/ui/api/app-mode": { ok: true, localOnly: true, version: 1, mode: "local", localAnalytics: false, defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" },
    "/ui/api/health": { ok: true, version: "0.1.0-fixture", root: "inert-extension-fixture" },
    "/ui/api/diagnose/latest": { ok: true, report: null },
    "/ui/api/disk-space": { ok: true, freeBytes: 50 * 1024 ** 3, low: false },
    "/ui/api/runtime-downloads": { ok: true, downloads: [] },
    "/ui/api/workspace/capability": { ok: true, token: "c".repeat(64) },
    "/ui/api/workspaces": { ok: true, currentId: "default", activeId: "default", workspaces: [workspace] },
    "/ui/api/workspace/overview": { ok: true, workspaceId: "default", root: "inert-extension-fixture", profileCount: 2, trashCount: 0, runningCount: 0, bytes: 0, freeBytes: 50 * 1024 ** 3, lastBackupAt: null, backupBusy: false, scriptRunning: false },
    "/ui/api/workspace/backups": { ok: true, backups: [], jobs: [] },
  };
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    const body = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
    requests.push({ path, method, body });
    if (path === "/ui/api/profiles" && method === "GET") return failRoster ? json({ ok: false, error: "Synthetic roster unavailable" }, 503) : json({ ok: true, profiles, groups: groupNames, folders: groupNames.map(name => ({ name })) });
    if (path === "/ui/api/extensions" && method === "GET") return json({ ok: true, extensions: registry });
    if (path === "/ui/api/groups/extensions" && method === "GET") return failDefaults ? json({ ok: false, error: "Synthetic defaults unavailable" }, 503) : json({ ok: true, groups: defaults });
    if (path === "/ui/api/groups/extensions/preview" && method === "POST") {
      const extensions = [...new Set(body.extensions as string[])].sort(), baseline = defaults.find(group => group.name === body.group)?.extensions ?? [];
      const members = profiles.filter(profile => profile.group === body.group);
      const changes = members.flatMap(profile => {
        const added = extensions.filter(id => !profile.extensions!.includes(id)), removed = profile.extensions!.filter(id => !extensions.includes(id));
        return added.length || removed.length ? [{ id: profile.id, name: profile.name, added, removed, running: profile.running }] : [];
      });
      const preview: ExtensionGroupReview = { version: 1, group: body.group, extensions, expectedFingerprint: count(path, method).toString(16).padStart(64, "0"), count: members.length, defaultAdded: extensions.filter(id => !baseline.includes(id)), defaultRemoved: baseline.filter(id => !extensions.includes(id)), changes, unknown: 0 };
      return json({ ok: true, preview: scenario === "invalid-preview" ? { ...preview, unexpected: "Synthetic invalid DTO" } : preview });
    }
    if (path === "/ui/api/groups/extensions" && method === "POST") {
      assert.match(body.expectedFingerprint, /^[a-f0-9]{64}$/);
      if (scenario === "conflict-409") return json({ ok: false, code: "preview-conflict", error: "Extension assignments changed after this review. Review the latest changes before applying. Your selection is kept." }, 409);
      defaults = defaults.map(group => group.name === body.group ? { ...group, extensions: [...body.extensions] } : group);
      profiles = profiles.map(profile => profile.group === body.group ? { ...profile, extensions: [...body.extensions] } : profile);
      return json({ ok: true, updatedCount: profiles.filter(profile => profile.group === body.group).length });
    }
    if (path === "/ui/api/extensions/delete" && method === "POST") {
      assert.ok(registry.some(extension => extension.id === body.id), "Only a currently installed synthetic extension can be removed");
      registry = registry.filter(extension => extension.id !== body.id);
      defaults = defaults.map(group => ({ ...group, extensions: group.extensions.filter(id => id !== body.id) }));
      profiles = profiles.map(profile => ({ ...profile, extensions: profile.extensions!.filter(id => id !== body.id) }));
      failDefaults = scenario === "defaults-refresh-failure";
      failRoster = scenario === "roster-refresh-failure";
      return json({ ok: true });
    }
    if (path === "/ui/api/workspace/preferences" && ["GET", "POST"].includes(method)) return json({ ok: true, preferences: { "aliasmode.roster.groupDisclosure": JSON.stringify(["", ...groupNames].map(name => [name, false])) } });
    if (method === "GET" && Object.hasOwn(startup, path)) return json(startup[path]);
    unexpected.push(`${method} ${path}`); throw new Error(`Unexpected actual App extension route: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch }); dom.container.id = "root";
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: () => { unexpected.push("window.fetch"); throw new Error("Window networking is disabled"); } });
  let root: Root | null = null;
  const client = await import("react-dom/client"), createRealRoot = client.createRoot;
  mock.module("react-dom/client", () => ({ ...client, createRoot(...args: Parameters<typeof createRealRoot>) { const created = createRealRoot(...args); root = created; return created; } }));
  const visible = <T extends HTMLElement>(selector: string, scope: HTMLElement = dom.window.document.body): T[] => [...scope.querySelectorAll<T>(selector)].filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]'));
  const findButton = (label: string, scope: HTMLElement = dom.window.document.body) => visible<HTMLButtonElement>("button", scope).find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  const button = (label: string, scope?: HTMLElement) => { const result = findButton(label, scope); assert.ok(result, `Missing button ${label}`); return result; };
  const click = async (target: HTMLElement, twice = false) => act(async () => { target.click(); if (twice) target.click(); });
  const choices = () => visible<HTMLElement>(".extensions-default-choice");
  const choice = (name: string) => choices().find(label => label.querySelector("span")?.textContent === name)?.querySelector<HTMLInputElement>("input");
  const selected = () => choices().filter(label => label.querySelector<HTMLInputElement>("input")!.checked).map(label => label.querySelector("span")!.textContent!).sort();
  const dialog = () => visible<HTMLElement>('[role="dialog"]')[0];
  const waitFor = async (condition: () => boolean, why: string) => {
    const until = Date.now() + 3500;
    while (!condition() && Date.now() < until) await dom.flush();
    assert.ok(condition(), `${why}; requests=${JSON.stringify(requests.map(({ path, method }) => ({ path, method })))}; tail=${dom.window.document.body.textContent?.slice(-1400)}`);
  };
  const chooseGroup = async (name: string) => act(async () => {
    const select = visible<HTMLSelectElement>('select[aria-label="Extension default group"]')[0]; assert.ok(select); assert.ok(!select.disabled);
    const option = [...select.options].find(option => option.value === name);
    assert.ok(option, `Group ${name} must be a real visible option`); assert.ok(!option.disabled, `Group ${name} must be user-selectable`);
    select.value = name; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const requireSelection = (names: string[], why: string) => assert.deepEqual(selected(), [...names].sort(), why);
  const remove = async (name: string) => {
    await click(button(`Remove ${name}`));
    assert.ok(dialog()?.textContent?.includes(`Remove ${name} from this device?`), "Deletion keeps the product's explicit confirmation");
    assert.equal(count("/ui/api/extensions/delete", "POST"), 0, "Opening the confirmation is read only");
    await click(button("Remove extension", dialog()!), true);
    await waitFor(() => !dialog() && visible(".extensions-library-row").length === 2, "Confirmed removal should retain the actual page and finish its read refresh");
    assert.equal(count("/ui/api/extensions/delete", "POST"), 1, "Same-frame confirm clicks must submit once");
  };
  const reload = async () => {
    const before = requests.length, writes = mutationCount();
    failDefaults = false; failRoster = false;
    await click(button("Reload extension data"), true);
    await waitFor(() => !button("Review and apply").disabled && visible<HTMLElement>(".extensions-workspace")[0]?.getAttribute("aria-busy") === "false", "A successful read-only Reload should unlock review and preserve the draft");
    assert.equal(mutationCount(), writes, "Reload must not retry a delete, preview, or group apply");
    const reads = requests.slice(before);
    assert.ok(reads.every(request => request.method === "GET"), "Reload sends reads only");
    for (const path of ["/ui/api/extensions", "/ui/api/groups/extensions", "/ui/api/profiles"]) assert.equal(reads.filter(request => request.path === path).length, 1, `Same-frame Reload shares one ${path} read`);
  };
  try {
    await act(async () => { await import("../web/app.tsx"); });
    await waitFor(() => visible("tr[data-profile-id]").length === 2, "Real App should load the inert profile roster");
    await click(button("Manage extensions"));
    await waitFor(() => visible(".extensions-library-row").length === 3 && choices().length === 3 && visible<HTMLElement>(".extensions-workspace")[0]?.getAttribute("aria-busy") === "false", "Real App extension page should load complete registry, group defaults, and roster");
    requireSelection(["Alpha"], "Initial group selection uses its saved defaults");
    assert.ok(choice("Beta")); await click(choice("Beta")!);
    requireSelection(["Alpha", "Beta"], "Create a real unsaved group draft");
    assert.ok(visible(".extensions-draft-state").length);

    if (scenario === "missing-group-draft") {
      const before = requests.length, writes = mutationCount();
      defaults = defaults.filter(group => group.name !== "Research");
      groupNames.splice(groupNames.indexOf("Research"), 1);
      profiles = profiles.map(profile => profile.group === "Research" ? { ...profile, group: "Other" } : profile);
      await click(button("Reload extension data"), true);
      await waitFor(() => visible<HTMLElement>(".extensions-workspace")[0]?.getAttribute("aria-busy") === "false" && !!visible<HTMLElement>(".extensions-unavailable-group")[0], "Read-only Reload should discover the externally removed group and retain its dirty draft");
      const groupSelect = () => visible<HTMLSelectElement>('select[aria-label="Extension default group"]')[0]!;
      assert.equal(groupSelect().value, "Research");
      const missing = [...groupSelect().options].find(option => option.value === "Research");
      assert.ok(missing); assert.ok(missing.textContent?.includes("Unavailable")); assert.ok(!missing.disabled);
      requireSelection(["Alpha", "Beta"], "The missing group's unsaved selection remains intact");
      assert.ok(visible<HTMLElement>(".extensions-unavailable-group")[0]?.textContent?.includes("Your draft is kept"));
      assert.ok(button("Review and apply").disabled, "A missing group cannot be applied");
      assert.ok(!groupSelect().disabled); assert.ok(!button("Discard unsaved selection").disabled); assert.ok(!button("Reload extension data").disabled);
      const reads = requests.slice(before);
      assert.ok(reads.every(request => request.method === "GET"));
      for (const path of ["/ui/api/extensions", "/ui/api/groups/extensions", "/ui/api/profiles"]) assert.equal(reads.filter(request => request.path === path).length, 1);
      await chooseGroup("Other"); requireSelection(["Gamma"], "An available group's saved default remains usable");
      assert.ok([...groupSelect().options].some(option => option.value === "Research" && !option.disabled && option.textContent?.includes("Unavailable")), "The retained missing draft can be reached again after switching groups");
      await chooseGroup("Research"); requireSelection(["Alpha", "Beta"], "Returning to the unavailable draft preserves the original intent");
      assert.ok(button("Review and apply").disabled);
      await click(button("Discard unsaved selection"));
      assert.equal(groupSelect().value, "Other"); requireSelection(["Gamma"], "Discarding the missing draft safely returns to an available group");
      assert.ok(![...groupSelect().options].some(option => option.value === "Research"));
      assert.equal(visible(".extensions-draft-state").length, 0);
      assert.equal(mutationCount(), writes, "Missing-group recovery must not automatically apply, delete, or even preview");
    } else if (scenario === "all-missing-drafts") {
      await chooseGroup("Other"); await click(choice("Beta")!);
      requireSelection(["Beta", "Gamma"], "The second group also has a distinct unsaved draft");
      await chooseGroup("Research"); requireSelection(["Alpha", "Beta"], "Both groups preserve their independent targets");
      const writes = mutationCount(), before = requests.length;
      defaults = []; groupNames.splice(0); profiles = profiles.map(profile => ({ ...profile, group: "" }));
      await click(button("Reload extension data"), true);
      const groupSelect = () => visible<HTMLSelectElement>('select[aria-label="Extension default group"]')[0];
      await waitFor(() => visible<HTMLElement>(".extensions-workspace")[0]?.getAttribute("aria-busy") === "false" && groupSelect()?.options.length === 2 && !!visible(".extensions-unavailable-group").length, "All missing groups should remain as reachable dirty draft options");
      assert.deepEqual([...groupSelect()!.options].map(option => option.value).sort(), ["Other", "Research"]);
      assert.ok([...groupSelect()!.options].every(option => !option.disabled && option.textContent?.includes("Unavailable")));
      assert.ok(requests.slice(before).every(request => request.method === "GET"));
      await chooseGroup("Other"); requireSelection(["Beta", "Gamma"], "The second unavailable draft remains reachable");
      await chooseGroup("Research"); requireSelection(["Alpha", "Beta"], "The first unavailable draft remains reachable");
      await click(button("Discard unsaved selection"));
      assert.equal(groupSelect()?.value, "Other", "Discard selects the remaining missing draft when no available groups remain");
      requireSelection(["Beta", "Gamma"], "Discarding the first missing group does not erase the other draft");
      assert.ok(visible(".extensions-draft-state").length === 1);
      assert.ok(button("Review and apply").disabled);
      assert.ok(!button("Discard unsaved selection").disabled);
      await click(button("Discard unsaved selection"));
      assert.equal(!!groupSelect(), false, "After the final explicit discard no retained group option remains");
      assert.equal(visible(".extensions-draft-state").length, 0, "The extension session has no unsaved draft label left for the native close guard");
      assert.equal(visible(".extensions-unavailable-group").length, 0);
      assert.ok(visible<HTMLElement>(".extensions-defaults")[0]?.textContent?.includes("Create an editable group"));
      assert.ok(!button("Reload extension data").disabled);
      assert.equal(mutationCount(), writes, "Clearing missing drafts performs no automatic writes or server review");
    } else if (scenario === "cross-group-discard") {
      await chooseGroup("Team Two"); requireSelection(["Gamma"], "Another group starts with its own defaults");
      await click(choice("Alpha")!); requireSelection(["Alpha", "Gamma"], "The second group gets an independent draft");
      await chooseGroup("Team One"); requireSelection(["Alpha", "Beta"], "Switching back preserves the first draft");
      await chooseGroup("Team Two"); requireSelection(["Alpha", "Gamma"], "Switching again preserves the second draft");
      await click(button("Discard unsaved selection")); requireSelection(["Gamma"], "Discard resets only the selected group's draft");
      assert.equal(visible(".extensions-draft-state").length, 0);
      await chooseGroup("Team One"); requireSelection(["Alpha", "Beta"], "Discarding the other group leaves the first draft intact");
      await click(button("Discard unsaved selection")); requireSelection(["Alpha"], "Explicit discard returns to the last saved first-group defaults");
      assert.equal(mutationCount(), 0);
    } else if (scenario === "conflict-409" || scenario === "invalid-preview") {
      await click(button("Review and apply"), true);
      await waitFor(() => scenario === "invalid-preview" ? visible('[role="alert"]').some(node => node.textContent?.includes("preview was incomplete")) : !!dialog(), "Review must use the server DTO before opening Apply");
      assert.equal(count("/ui/api/groups/extensions/preview", "POST"), 1);
      assert.equal(count("/ui/api/groups/extensions", "POST"), 0);
      requireSelection(["Alpha", "Beta"], "Read-only review does not change the draft");
      if (scenario === "invalid-preview") {
        assert.equal(!!dialog(), false, "An invalid review never opens a confirmation");
        assert.ok(!button("Review and apply").disabled);
      } else {
        await click(button("Apply group default", dialog()!), true);
        await waitFor(() => !!dialog()?.textContent?.includes("changed after this review"), "409 must be an explicit stale review rather than assumed success");
        assert.equal(count("/ui/api/groups/extensions", "POST"), 1);
        assert.ok(button("Apply group default", dialog()!).disabled);
        const post = requests.find(request => request.path === "/ui/api/groups/extensions" && request.method === "POST")!;
        assert.deepEqual(post.body.extensions, ["alpha", "beta"]); assert.match(post.body.expectedFingerprint, /^[a-f0-9]{64}$/);
        requireSelection(["Alpha", "Beta"], "409 retains the user's unsaved draft");
        const writes = count("/ui/api/groups/extensions", "POST");
        await click(button("Reload extension data", dialog()!), true);
        await waitFor(() => !findButton("Reload extension data", dialog()) && !button("Review latest changes", dialog()!).disabled, "409 recovery first performs read-only reload");
        assert.equal(count("/ui/api/groups/extensions", "POST"), writes, "Reload must not replay the rejected write");
        assert.ok(button("Apply group default", dialog()!).disabled, "A new explicit review remains required after Reload");
        await click(button("Review latest changes", dialog()!), true);
        await waitFor(() => !button("Apply group default", dialog()!).disabled, "Explicit fresh review may unlock a later user Apply");
        assert.equal(count("/ui/api/groups/extensions/preview", "POST"), 2);
        assert.equal(count("/ui/api/groups/extensions", "POST"), writes, "Fresh review itself also cannot replay the write");
        await click(button("Cancel", dialog()!)); await waitFor(() => !dialog(), "Cancel should close the retained review");
        requireSelection(["Alpha", "Beta"], "Closing the review preserves the draft");
      }
    } else {
      await remove(scenario === "remove-unrelated" ? "Gamma" : "Alpha");
      const expected = scenario === "remove-unrelated" ? ["Alpha", "Beta"] : ["Beta"];
      requireSelection(expected, "A confirmed deletion prunes only that ID from the existing draft");
      assert.ok(visible(".extensions-draft-state").length, "The remaining unsaved intent stays visible");
      if (scenario === "defaults-refresh-failure" || scenario === "roster-refresh-failure") {
        assert.equal(!!choice("Alpha"), false, "The confirmed deleted ID cannot revive after another refresh source fails");
        assert.ok(button("Review and apply").disabled, "Any failed required read marks extension data stale");
        assert.ok(!button("Reload extension data").disabled, "An explicit read-only recovery is available");
        assert.ok(visible('[role="alert"]').some(node => node.textContent?.includes("saved")), "Saved deletion and failed refresh remain distinct");
        await reload(); requireSelection(["Beta"], "Successful Reload preserves Beta instead of replacing it with new empty defaults");
        assert.equal(!!choice("Alpha"), false);
        assert.equal(count("/ui/api/extensions/delete", "POST"), 1);
      } else assert.ok(!button("Review and apply").disabled, "A complete refresh keeps the unsaved draft reviewable");
      assert.equal(count("/ui/api/groups/extensions", "POST"), 0, "Deletion recovery must not apply the unsaved draft");
      assert.equal(count("/ui/api/groups/extensions/preview", "POST"), 0);
    }
    assert.deepEqual(unexpected, []);
  } finally {
    if (root) await act(async () => { root!.unmount(); root = null; });
    await dom.cleanup(); mock.restore();
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}

try { await run(process.argv[2] ?? "remove-unrelated"); console.log("actual App extensions fixture passed"); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
