import { expect, test } from "bun:test";
import { createTrashReader, createTrashSelection, createTrashTask, type TrashPurgeApproval } from "./trash-task.ts";
import { ProfileStore } from "../src/store.ts";
import { parseExport } from "../src/parse.ts";
import { handleTrashRequest } from "../src/trash.ts";
import type { Launcher } from "../src/launcher.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
const json = (body: unknown, status = 200) => Response.json(body, { status });
const restored = (ids: string[]) => json({ ok: true, results: ids.map(id => ({ id, status: "restored" })) });
const profile = (id: string) => ({ id, name: `Environment ${id}`, group: "Folder", trashedAt: 1000, canRestore: true, canPurge: true });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("selection survives filters and hidden scopes, and old results cannot erase a new same-ID intent", () => {
  const selection = createTrashSelection(["one", "two"]), capture = selection.capture();
  expect(selection.visibleSummary(["one"])).toEqual({ total: 2, visible: 1, hidden: 1 });
  selection.set(["three"], true); selection.set(["two"], false); selection.set(["two"], true);
  expect(selection.reconcile(capture, ["one", "two", "unrelated"])).toEqual(["one"]);
  expect(selection.getSnapshot().ids).toEqual(["three", "two"]);
  expect(selection.visibleSummary(["two"])).toEqual({ total: 2, visible: 1, hidden: 1 });
  const folder = selection.capture(["one", "two", "three", "four"]); selection.replace(["two", "four"]);
  expect(selection.reconcile(folder, ["two", "four"])).toEqual([]); expect(selection.getSnapshot().ids).toEqual(["two", "four"]);
});

test("page selection changes only that page, replacement is explicit and captures cannot be mutated", () => {
  const selection = createTrashSelection(["other_page"]);
  selection.set(["one", "two"], true); selection.set(["one"], false); expect(selection.getSnapshot().ids).toEqual(["other_page", "two"]);
  const capture = selection.capture(); expect(Object.isFrozen(capture.entries)).toBe(true); expect(Object.isFrozen(selection.getSnapshot().ids)).toBe(true);
  selection.replace(["two", "three", "three"]); expect(selection.getSnapshot().ids).toEqual(["two", "three"]);
  selection.clear(); expect(selection.getSnapshot().ids).toEqual([]);
  expect(() => selection.set(["../PRIVATE_PATH"], true)).toThrow("Trash selection contains invalid environment IDs.");
});

test("restore freezes unique targets, guards duplicate submits and retries only original failures without losing newer selections", async () => {
  const response = deferred<Response>(), selection = createTrashSelection(["one", "two"]), sends: string[][] = [];
  const task = createTrashTask({ selection, post: async (_action, ids) => { sends.push([...ids]); ids[0] = "tampered"; return sends.length === 1 ? response.promise : restored(["two"]); } });
  const targets = ["one", "two", "one"], first = task.submit("restore", targets); targets.splice(0, targets.length, "other");
  expect(await task.submit("restore", ["other"])).toBeNull(); expect(task.dismiss()).toBe(false);
  selection.set(["three"], true); await tick(); expect(sends).toEqual([["one", "two"]]);
  response.resolve(json({ ok: true, results: [{ id: "two", status: "failed", code: "profile_open" }, { id: "one", status: "restored" }] }));
  const initial = await first; expect(initial?.receipt).toMatchObject({ status: "partial", succeededIds: ["one"], failedIds: ["two"], retryIds: ["two"] });
  expect(selection.getSnapshot().ids).toEqual(["two", "three"]);
  selection.set(["two"], false); selection.set(["two"], true);
  const retry = await task.retryFailed(); expect(sends).toEqual([["one", "two"], ["two"]]); expect(retry?.receipt).toMatchObject({ status: "complete", succeededIds: ["one", "two"] });
  expect(retry?.receipt?.rows.map(row => row.attempts)).toEqual([1, 2]); expect(selection.getSnapshot().ids).toEqual(["three", "two"]); expect(await task.retryFailed()).toBeNull();
});

test("wrong action states, missing or duplicate IDs and incomplete replies cannot manufacture success", async () => {
  const cases: Array<{ body: unknown; status?: number }> = [
    { body: { ok: true, results: [{ id: "one", status: "purged" }, { id: "two", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored" }, { id: "one", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored" }, { id: "other", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "mystery" }, { id: "two", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored", code: "profile_open" }, { id: "two", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "failed", code: { raw: "PRIVATE_COOKIE" } }, { id: "two", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored", private: "PRIVATE_COOKIE" }, { id: "two", status: "restored" }] } },
    { body: { results: [{ id: "one", status: "restored" }, { id: "two", status: "restored" }] } },
    { body: { ok: true, results: [{ id: "one", status: "restored" }, { id: "two", status: "restored" }] }, status: 409 },
    { body: { ok: false, error: "Operation cancelled", results: [{ id: "one", status: "restored" }] }, status: 409 },
    { body: { ok: true, results: [{ id: "one", status: "restored" }, { id: "two", status: "restored" }] }, status: 500 },
  ];
  for (const { body, status = 200 } of cases) {
    let sends = 0; const task = createTrashTask({ post: async () => { sends++; return json(body, status); } });
    const result = await task.submit("restore", ["one", "two"]); expect(result?.receipt).toMatchObject({ status: "unconfirmed", succeededIds: [], failedIds: [], retryIds: [], unconfirmedIds: ["one", "two"] });
    expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});

test("network loss and HTML stay unknown, while unknown failure codes become fixed generic reasons", async () => {
  for (const mode of ["lost", "html"]) {
    const task = createTrashTask({ post: async () => { if (mode === "lost") throw new Error("PRIVATE_PATH_AND_CREDENTIAL"); return new Response("PRIVATE_COOKIE", { status: 500 }); } });
    const result = await task.submit("restore", ["one"]); expect(result?.receipt?.status).toBe("unconfirmed"); expect(await task.retryFailed()).toBeNull(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
  const task = createTrashTask({ post: async () => json({ ok: true, results: [{ id: "one", status: "failed", code: "PRIVATE_RAW_CODE" }, { id: "two", status: "failed", code: "not_in_trash" }] }) });
  const result = await task.submit("restore", ["one", "two"]); expect(result?.receipt?.rows.map(row => row.reason)).toEqual(["unrecognized", "not_in_trash"]); expect(result?.receipt?.retryIds).toEqual(["one"]); expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("purge approval freezes the exact approved IDs and every failed-item retry requests a new product confirmation", async () => {
  const approve = deferred<boolean>(), confirmations: TrashPurgeApproval[] = [], sends: string[][] = []; let nextApproval = false;
  const task = createTrashTask({ confirmPurge: async approval => { confirmations.push(approval); return confirmations.length === 1 ? approve.promise : nextApproval; }, post: async (_action, ids) => {
    sends.push([...ids]); return sends.length === 1 ? json({ ok: true, results: [{ id: "one", status: "purged" }, { id: "two", status: "failed", code: "profile_open" }] }) : json({ ok: true, results: [{ id: "two", status: "purged" }] });
  } });
  const ids = ["one", "two"], first = task.submit("purge", ids); ids.splice(0, ids.length, "different_selection");
  expect(task.getSnapshot().phase).toBe("confirming"); expect(await task.submit("purge", ["other"])).toBeNull(); await tick();
  expect(confirmations[0]).toMatchObject({ ids: ["one", "two"], count: 2 }); expect(Object.isFrozen(confirmations[0]?.ids)).toBe(true); expect(sends).toEqual([]);
  approve.resolve(true); await first; expect(sends).toEqual([["one", "two"]]);
  expect(await task.retryFailed()).toBeNull(); expect(confirmations[1]?.ids).toEqual(["two"]); expect(sends).toHaveLength(1); expect(task.getSnapshot().receipt?.status).toBe("partial");
  nextApproval = true; const retry = await task.retryFailed(); expect(confirmations[2]?.ids).toEqual(["two"]); expect(sends).toEqual([["one", "two"], ["two"]]); expect(retry?.receipt?.status).toBe("complete");
});

test("purge without product approval or after workspace changes sends no write", async () => {
  let sends = 0; const missing = createTrashTask({ post: async () => { sends++; return restored([]); } });
  expect(await missing.submit("purge", ["one"])).toBeNull(); expect(missing.getSnapshot().phase).toBe("idle"); expect(sends).toBe(0);
  const approve = deferred<boolean>(); let workspace = "original", leases = 0;
  const task = createTrashTask({ workspaceId: () => workspace, confirmPurge: () => approve.promise, acquire: () => { leases++; return { release() {} }; }, post: async () => { sends++; return restored([]); } });
  const request = task.submit("purge", ["one"]); await tick(); workspace = "other"; approve.resolve(true); expect(await request).toBeNull(); expect(leases).toBe(0); expect(sends).toBe(0); expect(task.getSnapshot().blockedReason).toContain("original workspace");
});

test("an old purge retry cannot even ask for confirmation in a different workspace", async () => {
  let workspace = "original", approvals = 0, sends = 0;
  const task = createTrashTask({ workspaceId: () => workspace, confirmPurge: () => { approvals++; return true; }, post: async () => { sends++; return json({ ok: true, results: [{ id: "one", status: "failed", code: "profile_open" }] }); } });
  await task.submit("purge", ["one"]); workspace = "other"; expect(await task.retryFailed()).toBeNull(); expect(approvals).toBe(1); expect(sends).toBe(1);
});

test("retry validation runs before confirmation and again after approval without replaying changed entries", async () => {
  const approval = deferred<boolean>(); let valid = true, sends = 0, confirmations = 0;
  const task = createTrashTask({ validateRetry: () => valid, confirmPurge: () => ++confirmations === 1 ? true : approval.promise,
    post: async () => { sends++; return json({ ok: true, results: [{ id: "one", status: "failed", code: "profile_open" }] }); } });
  await task.submit("purge", ["one"]); valid = false; expect(await task.retryFailed()).toBeNull(); expect(confirmations).toBe(1); expect(sends).toBe(1);
  valid = true; const request = task.retryFailed(); await tick(); expect(confirmations).toBe(2); valid = false; approval.resolve(true); expect(await request).toBeNull();
  expect(sends).toBe(1); expect(task.getSnapshot().receipt?.failedIds).toEqual(["one"]); expect(task.getSnapshot().blockedReason).toContain("records changed");
});

test("disposing before dispatch does not start a product confirmation or a write", async () => {
  let approvals = 0, sends = 0;
  const task = createTrashTask({ confirmPurge: () => { approvals++; return true; }, post: async () => { sends++; return restored([]); } });
  const request = task.submit("purge", ["one"]); task.dispose(); expect(await request).toBeNull(); expect(approvals).toBe(0); expect(sends).toBe(0); expect(task.isBusy()).toBe(false);
});

test("failed retry preserves earlier successes when the second response becomes unknown", async () => {
  let sends = 0; const task = createTrashTask({ post: async () => ++sends === 1 ? json({ ok: true, results: [{ id: "one", status: "restored" }, { id: "two", status: "failed", code: "profile_open" }] }) : json({ ok: false, error: "cancelled" }, 409) });
  await task.submit("restore", ["one", "two"]); const result = await task.retryFailed();
  expect(result?.receipt).toMatchObject({ status: "unconfirmed", succeededIds: ["one"], unconfirmedIds: ["two"], retryIds: [] }); expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(2);
});

test("all refreshes settle before lease release and a failed refresh cannot erase a confirmed restore", async () => {
  const roster = deferred<void>(), workspace = deferred<void>(), started = deferred<void>(); let entered = 0, released = 0;
  const task = createTrashTask({ post: async (_action, ids) => restored(ids), acquire: () => ({ release() { released++; } }),
    refreshTrash: async () => { throw new Error("PRIVATE_READ_ERROR"); }, onChanged: async () => { if (++entered === 2) started.resolve(); await roster.promise; },
    refreshWorkspace: async () => { if (++entered === 2) started.resolve(); await workspace.promise; } });
  const request = task.submit("restore", ["one"]); await started.promise; expect(task.getSnapshot().phase).toBe("refreshing"); expect(task.getSnapshot().receipt?.succeededIds).toEqual(["one"]); expect(released).toBe(0);
  roster.resolve(); await tick(); expect(released).toBe(0); workspace.resolve(); const result = await request;
  expect(result?.receipt).toMatchObject({ status: "complete", succeededIds: ["one"], refreshFailed: true }); expect(released).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("disposing an owner never aborts an issued POST or launches new refresh reads", async () => {
  const response = deferred<Response>(); let sent = 0, reads = 0, released = 0;
  const task = createTrashTask({ post: async () => { sent++; return response.promise; }, acquire: () => ({ release() { released++; } }),
    refreshTrash: async () => { reads++; }, onChanged: async () => { reads++; }, refreshWorkspace: async () => { reads++; } });
  const request = task.submit("restore", ["one"]); await tick(); task.dispose(); expect(sent).toBe(1); expect(released).toBe(0); expect(task.dismiss()).toBe(false);
  response.resolve(restored(["one"])); await request; expect(released).toBe(1); expect(reads).toBe(0); expect(task.getSnapshot().receipt?.succeededIds).toEqual(["one"]); expect(await task.submit("restore", ["two"])).toBeNull();
});

test("workspace acquisition blocks writes and old retry scope cannot migrate to another workspace", async () => {
  let allow = false, workspace = "original", sends = 0;
  const task = createTrashTask({ workspaceId: () => workspace, acquire: () => allow ? { release() {} } : null, post: async () => { sends++; return json({ ok: true, results: [{ id: "one", status: "failed", code: "profile_open" }] }); } });
  expect(await task.submit("restore", ["one"])).toBeNull(); expect(sends).toBe(0); allow = true; await task.submit("restore", ["one"]);
  workspace = "other"; expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(1); workspace = "original"; await task.retryFailed(); expect(sends).toBe(2);
});

test("readonly generations abort only stale GETs and cannot overwrite a newer confirmed list", async () => {
  const pending: Array<{ signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
  const reader = createTrashReader({ read: async signal => { const response = deferred<Response>(); pending.push({ signal, response }); return response.promise; } });
  const first = reader.load(); await tick(); const second = reader.load(); await tick(); expect(pending[0]?.signal.aborted).toBe(true);
  pending[1]!.response.resolve(json({ ok: true, profiles: [profile("two")] })); await second; pending[0]!.response.resolve(json({ ok: true, profiles: [profile("one")] })); expect(await first).toBeNull();
  expect(reader.getSnapshot()).toMatchObject({ phase: "ready", loaded: true, stale: false }); expect(reader.getSnapshot().profiles.map(row => row.id)).toEqual(["two"]);
  const third = reader.load(); await tick(); reader.dispose(); expect(pending[2]?.signal.aborted).toBe(true); pending[2]!.response.resolve(json({ ok: true, profiles: [] })); expect(await third).toBeNull(); expect(reader.getSnapshot().profiles.map(row => row.id)).toEqual(["two"]); expect(await reader.load()).toBeNull();
});

test("initial read errors are not a confirmed empty Trash and failed refreshes preserve prior rows without secrets", async () => {
  let reads = 0; const reader = createTrashReader({ read: async () => ++reads === 2 ? json({ ok: true, profiles: [{ ...profile("one"), password: "PRIVATE_PASSWORD", cookies: "PRIVATE_COOKIE", path: "PRIVATE_PATH" }] }) : new Response("PRIVATE_BACKEND_ERROR", { status: 500 }) });
  await reader.load(); expect(reader.getSnapshot()).toMatchObject({ phase: "error", loaded: false, stale: false });
  await reader.load(); expect(reader.getSnapshot()).toMatchObject({ phase: "ready", loaded: true }); expect(JSON.stringify(reader.getSnapshot())).not.toContain("PRIVATE");
  await reader.load(); expect(reader.getSnapshot()).toMatchObject({ phase: "error", loaded: true, stale: true }); expect(reader.getSnapshot().profiles.map(row => row.id)).toEqual(["one"]); expect(JSON.stringify(reader.getSnapshot())).not.toContain("PRIVATE");
});

test("the reader's task refresh adapter rejects failed reads without denying a confirmed restore", async () => {
  const reader = createTrashReader({ read: async () => json({ ok: false, error: "PRIVATE_READ_FAILURE" }, 503) });
  const task = createTrashTask({ post: async (_action, ids) => restored(ids), refreshTrash: reader.refresh });
  const result = await task.submit("restore", ["one"]); expect(result?.receipt).toMatchObject({ status: "complete", succeededIds: ["one"], refreshFailed: true });
  expect(reader.getSnapshot()).toMatchObject({ phase: "error", loaded: false }); expect(JSON.stringify(reader.getSnapshot())).not.toContain("PRIVATE");
});

test("malformed read rows cannot crash the page or turn an invalid response into confirmed empty data", async () => {
  for (const profiles of [[profile("one"), profile("one")], [{ ...profile("one"), id: "../PRIVATE_PATH" }], [{ ...profile("one"), trashedAt: 1e30 }], [{ ...profile("one"), canRestore: "yes" }], [null]]) {
    const reader = createTrashReader({ read: async () => json({ ok: true, profiles }) }); await reader.load(); expect(reader.getSnapshot()).toMatchObject({ phase: "error", loaded: false }); expect(JSON.stringify(reader.getSnapshot())).not.toContain("PRIVATE");
  }
});

function memoryFixture() {
  const store = new ProfileStore(":memory:"), base = parseExport('id=one\nname=Test\ncookie=[{"name":"session","value":"PRIVATE_COOKIE","domain":"example.com","path":"/"}]\nproxytype=http\nresolution=1280*720\n******************').profiles[0]!;
  for (const id of ["one", "two"]) { store.upsertProfile({ ...base, id }); store.saveSessionBundle(id, "PRIVATE_SESSION"); store.trashProfile(id); }
  const blocked = new Set(["two"]), purged: string[] = [];
  const launcher = { cacheCleanupSettled: async () => {}, profileDeletionBlocked: (id: string) => blocked.has(id), removeUserDataDir: (id: string) => { purged.push(id); return true; } } as unknown as Launcher;
  const post = (action: "restore" | "purge", ids: string[]) => handleTrashRequest(new Request(`http://localhost/ui/api/trash/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }), launcher, store, {});
  return { store, blocked, purged, launcher, post };
}
test("the real route restores retained identity and only retries a remaining failed environment", async () => {
  const fixture = memoryFixture(), sends: string[][] = [];
  const task = createTrashTask({ post: (action, ids) => { sends.push([...ids]); return fixture.post(action, ids); } });
  const initial = await task.submit("restore", ["one", "two", "missing"]);
  expect(initial?.receipt).toMatchObject({ status: "partial", succeededIds: ["one"], failedIds: ["two", "missing"], retryIds: ["two"] });
  expect(fixture.store.getProfile("one")?.cookies[0]?.value).toBe("PRIVATE_COOKIE"); expect(fixture.store.getSessionBundle("one")).toBe("PRIVATE_SESSION"); fixture.blocked.clear();
  const retry = await task.retryFailed(); expect(sends).toEqual([["one", "two", "missing"], ["two"]]); expect(retry?.receipt?.succeededIds).toEqual(["one", "two"]); expect(retry?.receipt?.retryIds).toEqual([]); expect(JSON.stringify(retry)).not.toContain("PRIVATE"); fixture.store.close();
});

test("the real purge route is gated by confirmation and tests never delete a real user directory", async () => {
  const fixture = memoryFixture(); let confirmations = 0;
  const task = createTrashTask({ confirmPurge: () => { confirmations++; return true; }, post: fixture.post });
  await task.submit("purge", ["one", "two"]); expect(fixture.purged).toEqual(["one"]); fixture.blocked.clear(); await task.retryFailed();
  expect(confirmations).toBe(2); expect(fixture.purged).toEqual(["one", "two"]); expect(fixture.store.listTrashed()).toEqual([]); fixture.store.close();
});

test("a real HTTP409 can follow partial restoration and must remain unconfirmed without replay", async () => {
  const fixture = memoryFixture(), cancellation = new AbortController(), original = fixture.store.restoreProfile.bind(fixture.store);
  fixture.blocked.clear(); fixture.store.restoreProfile = id => { const restored = original(id); if (id === "one") cancellation.abort(); return restored; };
  let responseStatus = 0; const task = createTrashTask({ post: async (action, ids) => {
    const response = await handleTrashRequest(new Request(`http://localhost/ui/api/trash/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }), signal: cancellation.signal }), fixture.launcher, fixture.store, {}); responseStatus = response.status; return response;
  } });
  const result = await task.submit("restore", ["one", "two"]); expect(responseStatus).toBe(409); expect(fixture.store.getProfile("one")).not.toBeNull(); expect(fixture.store.isTrashed("two")).toBe(true);
  expect(result?.receipt).toMatchObject({ status: "unconfirmed", succeededIds: [], unconfirmedIds: ["one", "two"], retryIds: [] }); expect(await task.retryFailed()).toBeNull(); fixture.store.close();
});
