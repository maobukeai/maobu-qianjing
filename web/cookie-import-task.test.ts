import { expect, test } from "bun:test";
import { createCookieImportTask, type CookieImportInput, type CookieImportSnapshot } from "./cookie-import-task.ts";
import { ProfileStore } from "../src/store.ts";
import { parseExport } from "../src/parse.ts";
import { handleUiRequest } from "../src/ui.ts";
import type { Launcher } from "../src/launcher.ts";

const targets = [{ id: "one", name: "First environment" }, { id: "two", name: "Second environment" }];
const input = (): CookieImportInput => ({ format: "json", input: { text: '[{"name":"session","value":"PRIVATE_COOKIE_VALUE_742","domain":"example.com","path":"/"}]' } });
const complete = (total: number) => Response.json({ ok: true, count: 1, live: 0, nextStart: total, errors: [] });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }

test("cookie tasks freeze targets, format and private input, reject duplicate clicks and retry only failed IDs", async () => {
  const first = deferred<Response>(), sends: Array<{ ids: string[]; payload: Record<string, string> }> = [];
  const task = createCookieImportTask({ post: async (ids, payload) => { sends.push({ ids: [...ids], payload: { ...payload } }); ids[0] = "tampered"; payload.text = "tampered"; return sends.length === 1 ? first.promise : complete(1); } });
  const selected = targets.map(row => ({ ...row })), payload = input();
  const started = task.submit(selected, payload); selected.splice(0, 2, { id: "other", name: "Changed selection" });
  payload.input = { text: "changed-cookie" }; payload.format = "netscape";
  expect(await task.submit([{ id: "other", name: "Other" }], input())).toBeNull();
  expect(task.dismiss()).toBe(false); expect(await task.retryFailed()).toBeNull();
  await Promise.resolve(); expect(sends).toHaveLength(1);
  first.resolve(Response.json({ ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "two", error: "cookie could not be added" }] }));
  const initial = await started; expect(initial?.format).toBe("json"); expect(initial?.rows.map(row => row.id)).toEqual(["one", "two"]);
  expect(initial?.summary).toMatchObject({ succeeded: 1, failed: 1, retryable: 1, live: 1 });
  const retried = await task.retryFailed(); expect(sends.map(send => send.ids)).toEqual([["one", "two"], ["two"]]); expect(sends[1]?.payload).toEqual(sends[0]?.payload);
  expect(retried?.summary).toMatchObject({ succeeded: 2, failed: 0, retryable: 0, live: 1, nextStart: 1 });
  expect(retried?.rows.map(row => row.attempts)).toEqual([1, 2]); expect(await task.retryFailed()).toBeNull();
  expect(JSON.stringify(task.getSnapshot())).not.toContain("PRIVATE_COOKIE_VALUE_742");
});

test("malformed and ambiguous bulk replies never invent successes or permit automatic resend", async () => {
  const badReplies: Array<{ body: unknown; status?: number }> = [
    { body: { ok: true, count: 1, live: 2, nextStart: 0, errors: [] }, status: 500 },
    { body: { ok: true, count: 1, live: 1, nextStart: 0, errors: [] } },
    { body: { ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "other", error: "no such profile" }] } },
    { body: { ok: false, count: 1, live: 0, nextStart: 0, errors: [{ id: "two", error: "x" }, { id: "two", error: "x" }] } },
    { body: { ok: false, count: 1, live: 1, nextStart: 1, errors: [] } },
    { body: { ok: true, count: 0, live: 2, nextStart: 0, errors: [] } },
    { body: { ok: true, count: 1.5, live: 2, nextStart: 0, errors: [] } },
    { body: { ok: true, count: 1, live: -1, nextStart: 3, errors: [] } },
    { body: { ok: true, count: 1, live: 2, nextStart: 0 } },
    { body: { ok: false, error: "PRIVATE_COOKIE_VALUE_742" } },
    { body: { ok: true, count: 1, live: 2, nextStart: 0, errors: [], secret: "PRIVATE_COOKIE_VALUE_742" } },
    { body: null },
  ];
  for (const { body, status = 200 } of badReplies) {
    let sends = 0; const task = createCookieImportTask({ post: async () => { sends++; return Response.json(body, { status }); } });
    const result = await task.submit(targets, input()); expect(result?.summary).toMatchObject({ succeeded: 0, unconfirmed: 2, retryable: 0 });
    expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
  }
});

test("network loss and HTML responses settle unknown without reflecting raw values", async () => {
  for (const mode of ["lost", "html"]) {
    const task = createCookieImportTask({ post: async () => { if (mode === "lost") throw new Error("PRIVATE_COOKIE_VALUE_742"); return new Response("PRIVATE_COOKIE_VALUE_742", { status: 500 }); } });
    const result = await task.submit(targets, input()); expect(result?.summary.unconfirmed).toBe(2); expect(task.isBusy()).toBe(false); expect(await task.retryFailed()).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
  }
});

test("single-cookie replies must report exactly one cookie, and retry counts must match the frozen import", async () => {
  const single = createCookieImportTask({ post: async () => Response.json({ ok: true, count: 2, live: 0, nextStart: 2, errors: [] }) });
  expect((await single.submit(targets, { format: "single", input: { name: "session", value: "private", domain: "example.com", path: "/" } }))?.summary.unconfirmed).toBe(2);
  let sends = 0; const task = createCookieImportTask({ post: async () => ++sends === 1 ? Response.json({ ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "two", error: "x" }] }) : Response.json({ ok: true, count: 2, live: 0, nextStart: 1, errors: [] }) });
  await task.submit(targets, input()); const retried = await task.retryFailed(); expect(retried?.summary).toMatchObject({ succeeded: 1, unconfirmed: 1, retryable: 0, cookieCount: 1 });
});

test("invalid local input and reentrant subscribers cannot dispatch an additional request", async () => {
  let sends = 0; const response = deferred<Response>(), task = createCookieImportTask({ post: async () => { sends++; return response.promise; } });
  expect(await task.submit([{ id: "../invalid", name: "Invalid" }], input())).toBeNull();
  expect(await task.submit(targets, { format: "single", input: { name: "", value: "private", domain: "example.com", path: "/" } })).toBeNull(); expect(sends).toBe(0);
  const unsubscribe = task.subscribe(() => { if (task.getSnapshot().phase === "sending") void task.submit(targets, input()); });
  const pending = task.submit(targets, input()); await Promise.resolve(); expect(sends).toBe(1); response.resolve(complete(2)); await pending; unsubscribe(); expect(sends).toBe(1);
});

test("explicit pre-write validation refusals retain only fixed reasons and need a new import", async () => {
  for (const status of [400, 403]) {
    const task = createCookieImportTask({ post: async () => Response.json({ ok: false, error: "PRIVATE_COOKIE_VALUE_742" }, { status }) });
    const result = await task.submit(targets, input()); expect(result?.summary).toMatchObject({ failed: 2, unconfirmed: 0, retryable: 0 });
    expect(result?.rows[0]?.reason).toBe(status === 400 ? "input-rejected" : "request-rejected"); expect(await task.retryFailed()).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
  }
});

test("a failed retry with an unknown response preserves prior successes and cannot resend the uncertain IDs", async () => {
  let sends = 0; const task = createCookieImportTask({ post: async () => ++sends === 1 ? Response.json({ ok: false, count: 1, live: 1, nextStart: 0, errors: [{ id: "two", error: "PRIVATE_COOKIE_VALUE_742" }] }) : complete(2) });
  await task.submit(targets, input()); const result = await task.retryFailed();
  expect(result?.rows.map(row => row.status)).toEqual(["succeeded", "unconfirmed"]); expect(result?.summary).toMatchObject({ live: 1, succeeded: 1, unconfirmed: 1, retryable: 0 });
  expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(2); expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
});

test("workspace ownership is frozen across retries, rejected acquisition preserves an earlier failed batch", async () => {
  let workspace = "original", allow = true, sends = 0;
  const task = createCookieImportTask({ workspaceId: () => workspace, acquire: () => allow ? { release() {} } : null,
    post: async ids => { sends++; return Response.json({ ok: false, count: 1, live: 0, nextStart: 0, errors: ids.map(id => ({ id, error: "no such profile" })) }); } });
  await task.submit(targets, input()); workspace = "different";
  expect(await task.retryFailed()).toBeNull(); expect(sends).toBe(1);
  allow = false; expect(await task.submit([{ id: "new_one", name: "New" }], input())).toBeNull();
  expect(task.getSnapshot().rows.map(row => row.id)).toEqual(["one", "two"]);
  workspace = "original"; allow = true; await task.retryFailed(); expect(sends).toBe(2);
});

test("a hidden or unsubscribed view cannot cancel writes or release their workspace lease early", async () => {
  const post = deferred<Response>(), refreshing = deferred<void>(), refreshStarted = deferred<void>(); let released = 0;
  const task = createCookieImportTask({ post: () => post.promise, acquire: () => ({ release() { released++; } }),
    onSettled: async () => { refreshStarted.resolve(); await refreshing.promise; } });
  const unsubscribe = task.subscribe(() => { throw new Error("View failed"); });
  const request = task.submit(targets, input()); unsubscribe(); expect(task.dismiss()).toBe(false); expect(released).toBe(0);
  post.resolve(complete(2)); await refreshStarted.promise; expect(task.getSnapshot().phase).toBe("refreshing"); expect(released).toBe(0); expect(task.dismiss()).toBe(false);
  refreshing.resolve(); const result = await request; expect(released).toBe(1); expect(result?.summary.succeeded).toBe(2); expect(task.dismiss()).toBe(true);
});

test("a failed refresh keeps confirmed writes and snapshots cannot be mutated", async () => {
  let released = 0; const task = createCookieImportTask({ post: async () => complete(2), acquire: () => ({ release() { released++; } }), onSettled: () => { throw new Error("PRIVATE_COOKIE_VALUE_742"); } });
  const result = await task.submit(targets, input()); expect(result?.refreshFailed).toBe(true); expect(result?.summary.succeeded).toBe(2); expect(released).toBe(1); expect(task.isBusy()).toBe(false);
  expect(() => { (result!.rows as unknown as CookieImportSnapshot["rows"] & { push: (row: unknown) => void }).push({}); }).toThrow();
  expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
});

test("feedback withholds suspicious names and never stores raw backend errors", async () => {
  const task = createCookieImportTask({ post: async ids => Response.json({ ok: false, count: 1, live: 0, nextStart: 0, errors: ids.map(id => ({ id, error: "PRIVATE_COOKIE_VALUE_742" })) }) });
  const result = await task.submit([{ id: "one", name: "https://user:pass@example.com" }, { id: "two", name: "My PRIVATE_COOKIE_VALUE_742 environment" }], input());
  expect(result?.rows.map(row => row.name)).toEqual([null, null]); expect(result?.rows.map(row => row.reason)).toEqual(["write-failed", "write-failed"]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_COOKIE_VALUE_742");
});

test("actual cookie bulk route matches aggregate acceptance and retry sends only its explicit failures", async () => {
  const store = new ProfileStore(":memory:");
  const base = parseExport("id=cookie_open\nname=Open\ncookie=[]\nproxytype=http\nresolution=1280*720\n******************").profiles[0]!;
  for (const id of ["cookie_open", "cookie_closed", "cookie_failed"]) store.upsertProfile({ ...base, id, name: id });
  for (const id of ["cookie_open", "cookie_failed"]) store.recordLaunch({ profileId: id, pid: 1, debugPort: 9412, ws: `ws://${id}`, startedAt: 1 });
  let firstAttempt = true; const writes: string[] = [], batches: string[][] = [];
  const task = createCookieImportTask({ post: async (ids, payload) => {
    batches.push([...ids]);
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/cookies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, ...payload }) }),
      { certifiedActive: async () => true } as unknown as Launcher, store, { setCookies: async ws => { writes.push(ws); if (firstAttempt && ws === "ws://cookie_failed") throw new Error("PRIVATE_COOKIE_VALUE_742"); } });
    if (!response) throw new Error("Cookie route missing"); return response;
  } });
  const initial = await task.submit(["cookie_open", "cookie_closed", "cookie_failed"].map(id => ({ id, name: id })), input());
  expect(initial?.summary).toMatchObject({ succeeded: 2, failed: 1, live: 1, nextStart: 1, cookieCount: 1 });
  expect(store.getPendingCookies("cookie_closed")).toHaveLength(1); firstAttempt = false;
  const retry = await task.retryFailed(); expect(batches).toEqual([["cookie_open", "cookie_closed", "cookie_failed"], ["cookie_failed"]]);
  expect(writes).toEqual(["ws://cookie_open", "ws://cookie_failed", "ws://cookie_failed"]); expect(retry?.summary).toMatchObject({ succeeded: 3, failed: 0, live: 2, nextStart: 1 });
  expect(JSON.stringify(retry)).not.toContain("PRIVATE_COOKIE_VALUE_742"); store.close();
});
