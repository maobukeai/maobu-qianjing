import { expect, test } from "bun:test";
import { createProfileFileUpdate } from "./profile-file-update.ts";
import { ProfileStore } from "../store.ts";
import { parseExport } from "../parse.ts";
import { handleUiRequest } from "../ui.ts";
import { writeXlsx } from "../xlsx.ts";
import type { Launcher } from "../launcher.ts";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
const file = (text = "id,name,password\nfile_one,Changed,PRIVATE_ACCOUNT_VALUE", name = "C:\\PRIVATE_ACCOUNT_PATH\\PRIVATE_EXPORT.csv") => new File([text], name, { type: "text/csv" });
const success = (updated = 1) => Response.json({ ok: true, updated, skipped: 0, notFound: [], errors: [] });
function store() {
  const result = new ProfileStore(":memory:");
  const base = parseExport('id=file_one\nname=Original\ncookie=[{"name":"session","value":"PRIVATE_COOKIE_VALUE","domain":"example.com","path":"/"}]\nproxytype=http\nresolution=1280*720\n******************').profiles[0]!;
  result.upsertProfile(base); result.upsertProfile({ ...base, id: "file_two", name: "Second original" }); return result;
}
const sendToRoute = (store: ProfileStore, upload: File, options?: Parameters<typeof handleUiRequest>[3]) => {
  const body = new FormData(); body.append("files", upload);
  return handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body }), {} as Launcher, store, options).then(response => { if (!response) throw new Error("Missing route"); return response; });
};

test("file selection and ID matching are frozen, same-frame submits are guarded and another update requires explicit reselection", async () => {
  const response = deferred<Response>(), uploads: File[] = [], task = createProfileFileUpdate({ post: async upload => { uploads.push(upload); return uploads.length === 1 ? response.promise : success(); } });
  const original = file(); expect(task.selectFile(original)).toBe(true); const revision = task.getSnapshot().input?.revision;
  const started = task.submit(); expect(await task.submit()).toBeNull(); expect(task.selectFile(file("id,name\nfile_two,Wrong"))).toBe(false);
  expect(task.clearFile()).toBe(false); expect(task.dismissResults()).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0)); expect(uploads).toHaveLength(1); expect(uploads[0]?.name).toBe("profile-update.csv"); expect(await uploads[0]?.text()).toBe(await original.text());
  expect(task.getSnapshot().activeAttempt?.input).toMatchObject({ revision, format: "csv", matchBy: "file-id", bytes: original.size });
  response.resolve(Response.json({ ok: true, updated: 2, skipped: 1, notFound: ["missing_one", "missing_one"], errors: [] }));
  const result = await started; expect(result?.latest).toMatchObject({ status: "partial", updated: 2, skipped: 1, notFoundRows: 2, notFoundIds: ["missing_one"] });
  expect(result?.canSubmit).toBe(false); expect(await task.submit()).toBeNull(); expect(uploads).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(JSON.stringify(result)).not.toContain("C:");
  expect(task.selectFile(file("id,name\nfile_two,Corrected"))).toBe(true); expect(task.getSnapshot().latest?.status).toBe("partial");
  const second = await task.submit(); expect(second?.receipts.map(receipt => [receipt.status, receipt.updated])).toEqual([["partial", 2], ["saved", 1]]);
  expect(second?.input?.revision).not.toBe(revision); expect(await task.submit()).toBeNull(); expect(uploads).toHaveLength(2);
});

test("only the exact success and atomic-validation contracts are accepted", async () => {
  const bodies: Array<{ body: unknown; status?: number }> = [
    { body: { ok: true, updated: 1, skipped: 0, notFound: [], errors: [] }, status: 500 },
    { body: { ok: true, updated: 1, skipped: 0, notFound: [], errors: [] }, status: 201 },
    { body: { ok: false, updated: 0, skipped: 0, notFound: [], errors: [{ id: "file_one", error: "PRIVATE_ERROR" }] } },
    { body: { ok: false, updated: 1, skipped: 0, notFound: [], errors: [{ id: "file_one", error: "PRIVATE_ERROR" }] }, status: 400 },
    { body: { ok: false, updated: 0, skipped: 0, notFound: [], errors: [] }, status: 400 },
    { body: { ok: true, updated: 1, skipped: 0, notFound: [], errors: [{ id: "file_one", error: "PRIVATE_ERROR" }] } },
    { body: { ok: true, updated: 1, skipped: 0, notFound: ["../PRIVATE_PATH"], errors: [] } },
    { body: { ok: true, updated: 1.5, skipped: 0, notFound: [], errors: [] } },
    { body: { ok: true, updated: 1, skipped: -1, notFound: [], errors: [] } },
    { body: { ok: true, updated: 1, notFound: [], errors: [] } },
    { body: { ok: true, updated: 1, skipped: 0, notFound: [], errors: [], raw: "PRIVATE_ACCOUNT_VALUE" } },
    { body: { ok: false, error: "PRIVATE_ERROR" }, status: 500 }, { body: null },
  ];
  for (const { body, status = 200 } of bodies) {
    let sends = 0; const task = createProfileFileUpdate({ post: async () => { sends++; return Response.json(body, { status }); } }); task.selectFile(file());
    const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "unconfirmed", updated: null, skipped: null, notFoundRows: null, issues: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(await task.submit()).toBeNull(); expect(sends).toBe(1); expect("retry" in task).toBe(false);
  }
});

test("a validation refusal reports zero saved, safe IDs and fixed reasons without retaining raw errors", async () => {
  const task = createProfileFileUpdate({ post: async () => Response.json({ ok: false, updated: 0, skipped: 2, notFound: ["missing_one"], errors: [
    { id: "file_one", error: "invalid resolution: PRIVATE_SCREEN_VALUE" }, { id: "../PRIVATE_PATH", error: "PRIVATE_ACCOUNT_VALUE" },
    { id: "file_two", error: "proxy must be HOST:PORT PRIVATE_PROXY_CREDENTIAL" },
  ] }, { status: 400 }) }); task.selectFile(file());
  const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "rejected", updated: 0, issues: [{ id: "file_one", reason: "screen" }, { id: null, reason: "identifier" }, { id: "file_two", reason: "proxy" }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(result?.canSubmit).toBe(false);
});

test("lost or non-JSON responses stay unknown and never automatically resend the private file", async () => {
  for (const mode of ["lost", "html"]) {
    let sends = 0; const task = createProfileFileUpdate({ post: async () => { sends++; if (mode === "lost") throw new Error("PRIVATE_NETWORK_DETAIL"); return new Response("PRIVATE_ACCOUNT_VALUE", { status: 500 }); } });
    task.selectFile(file()); const result = await task.submit(); expect(result?.latest?.status).toBe("unconfirmed"); expect(task.isBusy()).toBe(false);
    expect(await task.submit()).toBeNull(); expect(sends).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});

test("the upload lease survives view unsubscription and lasts until the complete refresh settles", async () => {
  const response = deferred<Response>(), read = deferred<void>(), reading = deferred<void>(); let released = 0;
  const task = createProfileFileUpdate({ post: () => response.promise, acquire: () => ({ release() { released++; } }), onSettled: async () => { reading.resolve(); await read.promise; } });
  task.selectFile(file()); const unsubscribe = task.subscribe(() => { throw new Error("Inert view failure"); });
  const request = task.submit(); unsubscribe(); expect(released).toBe(0); expect(task.dismissResults()).toBe(false);
  response.resolve(success()); await reading.promise; expect(task.getSnapshot().phase).toBe("refreshing"); expect(task.getSnapshot().latest?.updated).toBe(1); expect(released).toBe(0); expect(await task.submit()).toBeNull();
  read.resolve(); await request; expect(released).toBe(1); expect(task.getSnapshot().latest?.status).toBe("saved");
});

test("a refresh failure never turns a confirmed save into a failed or unknown mutation", async () => {
  let released = 0; const task = createProfileFileUpdate({ post: async () => success(3), acquire: () => ({ release() { released++; } }), onSettled: () => { throw new Error("PRIVATE_REFRESH_DETAIL"); } });
  task.selectFile(file()); const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "saved", updated: 3, refreshFailed: true }); expect(released).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("workspace changes and rejected acquisition send nothing and retain the selected file", async () => {
  let workspace = "original", allow = false, sends = 0; const task = createProfileFileUpdate({ workspaceId: () => workspace, acquire: () => allow ? { release() {} } : null, post: async () => { sends++; return success(); } });
  task.selectFile(file()); const revision = task.getSnapshot().input?.revision;
  workspace = "other"; expect(await task.submit()).toBeNull(); expect(sends).toBe(0); workspace = "original";
  expect(await task.submit()).toBeNull(); expect(task.getSnapshot().canSubmit).toBe(true); expect(task.getSnapshot().input?.revision).toBe(revision);
  allow = true; expect((await task.submit())?.latest?.status).toBe("saved"); expect(sends).toBe(1);
});

test("an invalid replacement clears the earlier selection, and reentrant subscribers cannot start a duplicate request", async () => {
  let sends = 0; const response = deferred<Response>(), task = createProfileFileUpdate({ post: async () => { sends++; return response.promise; } });
  expect(task.selectFile(file())).toBe(true);
  expect(task.selectFile(new File([], "empty.csv"))).toBe(false);
  expect(task.getSnapshot()).toMatchObject({ input: null, canSubmit: false });
  expect(await task.submit()).toBeNull();
  expect(task.selectFile(file())).toBe(true);
  task.rejectSelection();
  expect(task.getSnapshot()).toMatchObject({ input: null, canSubmit: false });
  expect(task.selectFile(file("content", "PRIVATE_ACCOUNT.exe"))).toBe(false);
  expect(sends).toBe(0);
  expect(task.selectFile(file())).toBe(true); const remove = task.subscribe(() => { if (task.getSnapshot().phase === "sending") void task.submit(); });
  const pending = task.submit(); await new Promise(resolve => setTimeout(resolve, 0)); expect(sends).toBe(1); response.resolve(success()); await pending; remove();
  expect(task.clearFile()).toBe(true); expect(task.getSnapshot().latest?.status).toBe("saved"); expect(task.dismissResults()).toBe(true); expect(task.getSnapshot().receipts).toEqual([]);
});

test("actual route validates all rows before saving any environment and emits a safe rejection receipt", async () => {
  const data = store(); let lookups = 0;
  const task = createProfileFileUpdate({ post: upload => sendToRoute(data, upload, { timezoneFetch: async () => { lookups++; throw new Error("Unexpected network"); } }) });
  task.selectFile(file("id,name,proxy,proxytype\nfile_one,Would change,proxy.example:8080:u:PRIVATE_PROXY_CREDENTIAL,http\nfile_two,Invalid,malformed,http"));
  const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "rejected", updated: 0 }); expect(data.getProfile("file_one")?.name).toBe("Original"); expect(data.getProfile("file_two")?.name).toBe("Second original"); expect(lookups).toBe(0);
  expect(JSON.stringify(result)).not.toContain("PRIVATE"); data.close();
});

test("actual partial route counts unique saved environments, repeated missing rows and skipped rows separately", async () => {
  const data = store(), before = data.getProfile("file_one")!; const task = createProfileFileUpdate({ post: upload => sendToRoute(data, upload) });
  task.selectFile(file("id,name,password\nfile_one,First,PRIVATE_ACCOUNT_VALUE\nfile_one,Second,PRIVATE_ACCOUNT_VALUE\nmissing_id,Missing,PRIVATE_ACCOUNT_VALUE\nmissing_id,Missing again,PRIVATE_ACCOUNT_VALUE\n,No ID,PRIVATE_ACCOUNT_VALUE"));
  const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "partial", updated: 1, skipped: 1, notFoundRows: 2, notFoundIds: ["missing_id"] });
  expect(data.getProfile("file_one")?.name).toBe("Second"); expect(data.getProfile("missing_id")).toBeNull(); expect(data.getProfile("file_one")?.cookies).toEqual(before.cookies); expect(data.getProfile("file_one")?.fingerprintSeed).toBe(before.fingerprintSeed);
  expect(JSON.stringify(result)).not.toContain("PRIVATE"); data.close();
});

test("XLSX bytes are preserved and accepted by the actual binary workbook route", async () => {
  const data = store(), bytes = await writeXlsx(["id", "name"], [["file_one", "Spreadsheet change"]]);
  const task = createProfileFileUpdate({ post: upload => sendToRoute(data, upload) });
  task.selectFile(new File([new Uint8Array(bytes)], "PRIVATE_ACCOUNT_WORKBOOK.xlsx")); const result = await task.submit();
  expect(result?.input?.format).toBe("xlsx"); expect(result?.latest).toMatchObject({ status: "saved", updated: 1 }); expect(data.getProfile("file_one")?.name).toBe("Spreadsheet change"); data.close();
});
