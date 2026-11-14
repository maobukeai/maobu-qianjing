import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProfileMoveController } from "./profile-move-controller.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => Response.json(body, { status });

test("a move owns an immutable, deduplicated request and excludes same-frame duplicates", async () => {
  const post = deferred<Response>(), reads = deferred<{ profiles: { id: string; group: string }[] }>(); let sends = 0;
  const controller = createProfileMoveController({ move: async () => { sends++; return post.promise; }, readRoster: () => reads.promise });
  const ids = ["one", "one", "two"], first = controller.submit({ ids, group: " Destination " }); ids.splice(0, ids.length, "new_selection");
  expect(controller.getSnapshot().attempt?.ids).toEqual(["one", "two"]); expect(controller.getSnapshot().attempt?.group).toBe("Destination");
  expect(await controller.submit({ ids: ["other"], group: "Elsewhere" })).toBeNull(); expect(sends).toBe(1);
  post.resolve(response({ ok: true, moved: 2, group: "Destination" })); await Promise.resolve();
  reads.resolve({ profiles: [{ id: "one", group: "Destination" }, { id: "two", group: "Destination" }] });
  const result = await first; expect(result?.confirmedIds).toEqual(["one", "two"]); expect(result?.status).toBe("confirmed");
});

test("partial counts never fabricate the identity of moved environments", async () => {
  const controller = createProfileMoveController({ move: async () => response({ ok: true, moved: 1, group: "Target" }), readRoster: async () => ({ profiles: [{ id: "one", group: "Old" }, { id: "two", group: "Target" }] }) });
  const result = await controller.submit({ ids: ["one", "two", "missing"], group: "Target" });
  expect(result?.reportedMoved).toBe(1); expect(result?.confirmedIds).toEqual(["two"]); expect(result?.unresolvedIds).toEqual(["one", "missing"]); expect(result?.missingIds).toEqual(["missing"]); expect(result?.retryIds).toEqual(["one"]);
});

test("an uncertain reply only allows a readback until its destinations are known", async () => {
  let sends = 0, reads = 0;
  const controller = createProfileMoveController({ move: async () => { sends++; return response({ moved: 1, group: "Target" }); }, readRoster: async () => { reads++; return { profiles: [{ id: "one", group: "Target" }] }; } });
  expect((await controller.submit({ ids: ["one"], group: "Target" }))?.status).toBe("unconfirmed"); expect(reads).toBe(0);
  expect(await controller.retry()).toBeNull(); expect(sends).toBe(1);
  expect((await controller.recheck())?.confirmedIds).toEqual(["one"]); expect(sends).toBe(1); expect(reads).toBe(1);
});

test("HTTP errors, missing ok, wrong targets and impossible counts cannot claim success", async () => {
  for (const [body, status] of [[{ ok: true, moved: 1, group: "Target" }, 500], [{ ok: 1, moved: 1, group: "Target" }, 200], [{ ok: true, moved: 2, group: "Target" }, 200], [{ ok: true, moved: -1, group: "Target" }, 200], [{ ok: true, moved: .5, group: "Target" }, 200], [{ ok: true, moved: 1, group: "Other" }, 200], [null, 200], [{}, 200]] as const) {
    let reads = 0; const controller = createProfileMoveController({ move: async () => response(body, status), readRoster: async () => { reads++; return { profiles: [] }; } });
    const result = await controller.submit({ ids: ["one"], group: "Target" }); expect(result?.status).toBe("unconfirmed"); expect(result?.confirmedIds).toEqual([]); expect(result?.retryIds).toEqual([]); expect(reads).toBe(0);
  }
});

test("lost or non-JSON replies retain an uncertain attempt without retaining private error text", async () => {
  for (const mode of ["network", "html"]) {
    let reads = 0;
    const controller = createProfileMoveController({ move: async () => { if (mode === "network") throw new Error("pretend-private-response"); return new Response("<html>pretend-private-response</html>", { status: 500 }); }, readRoster: async () => { reads++; return { profiles: [] }; } });
    const result = await controller.submit({ ids: ["one"], group: "Target" });
    expect(result?.status).toBe("unconfirmed"); expect(result?.retryIds).toEqual([]); expect(reads).toBe(0); expect(controller.isBusy()).toBe(false); expect(JSON.stringify(controller.getSnapshot())).not.toContain("pretend-private-response");
  }
});

test("an explicit rejection retains the same destination for a deliberate retry", async () => {
  const sends: Array<{ ids: string[]; group: string }> = [];
  const controller = createProfileMoveController({ move: async (ids, group) => { sends.push({ ids, group }); return sends.length === 1 ? response({ ok: false, error: "Rejected" }, 423) : response({ ok: true, moved: 1, group }); }, readRoster: async () => ({ profiles: [{ id: "one", group: "Target" }] }) });
  const first = await controller.submit({ ids: ["one"], group: "Target" }); expect(first?.status).toBe("failed"); expect(first?.retryIds).toEqual(["one"]);
  const second = await controller.retry(); expect(second?.status).toBe("confirmed"); expect(sends).toEqual([{ ids: ["one"], group: "Target" }, { ids: ["one"], group: "Target" }]); expect(second?.attempt.id).not.toBe(first?.attempt.id);
});

test("a fresh but malformed roster cannot clear any selection", async () => {
  const controller = createProfileMoveController({ move: async () => response({ ok: true, moved: 1, group: "Target" }), readRoster: async () => ({ profiles: [{ id: "one", group: "Target" }, { id: "one", group: "Other" }] }) });
  const result = await controller.submit({ ids: ["one"], group: "Target" }); expect(result?.status).toBe("unconfirmed"); expect(result?.reportedMoved).toBe(1); expect(result?.confirmedIds).toEqual([]);
});

test("an owner leaving waits for the issued POST, skips new reads and releases its own lease", async () => {
  let reads = 0, released = 0; const post = deferred<Response>();
  const controller = createProfileMoveController({ move: async () => post.promise, readRoster: async () => { reads++; return { profiles: [] }; }, acquire: () => ({ refreshing() {}, release() { released++; } }) });
  const task = controller.submit({ ids: ["one"], group: "Target" }); controller.setActive(false); expect(released).toBe(0);
  post.resolve(response({ ok: true, moved: 1, group: "Target" })); expect(await task).toBeNull(); expect(reads).toBe(0); expect(released).toBe(1); expect(controller.isBusy()).toBe(false);
});

test("an issued verification keeps its lease until the read actually settles after unmount", async () => {
  const reading = deferred<void>(), readback = deferred<{ profiles: { id: string; group: string }[] }>(); let refreshing = 0, released = 0;
  const controller = createProfileMoveController({ move: async () => response({ ok: true, moved: 1, group: "Target" }), readRoster: () => { reading.resolve(); return readback.promise; }, acquire: () => ({ refreshing() { refreshing++; }, release() { released++; } }) });
  const task = controller.submit({ ids: ["one"], group: "Target" }); await reading.promise; expect(refreshing).toBe(1); expect(released).toBe(0);
  controller.setActive(false); expect(released).toBe(0); readback.resolve({ profiles: [{ id: "one", group: "Target" }] }); expect(await task).toBeNull(); expect(released).toBe(1);
});

test("a refusal from the workspace coordinator sends no request and remains retryable", async () => {
  let sends = 0, allow = false;
  const controller = createProfileMoveController({ move: async () => { sends++; return response({ ok: true, moved: 0, group: "" }); }, readRoster: async () => ({ profiles: [{ id: "one", group: "" }] }), acquire: () => allow ? { refreshing() {}, release() {} } : null });
  expect(await controller.submit({ ids: ["one"], group: "" })).toBeNull(); expect(sends).toBe(0); expect(controller.isBusy()).toBe(false);
  allow = true; expect((await controller.submit({ ids: ["one"], group: "" }))?.status).toBe("confirmed"); expect(sends).toBe(1);
});

for (const scenario of ["snapshot-dupe", "failure-retry", "malformed-recheck", "refresh-recheck", "partial", "retry-unresolved", "coordinator-unmount", "pagination", "workspace-change-recheck"]) {
  test(`profile move actual route and DOM: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-move-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile move fixture passed"); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
