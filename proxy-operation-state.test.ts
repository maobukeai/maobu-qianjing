import { expect, test } from "bun:test";
import { ProxyOperationState, ProxyOperationStateError, type ProxyOperationRow } from "./proxy-operation-state.ts";

const ready = (index: number, profileId = `profile_${index}`): ProxyOperationRow => ({ index, profileId, status: "ready" });
const binding = (state: ProxyOperationState, previewId: string) => ({ operationScope: state.operationScope, previewId, attemptId: crypto.randomUUID() });

test("receipt records keep only fixed fields and retain reviewed row identity", () => {
  const state = new ProxyOperationState();
  const attempt = binding(state, state.issuePreview());
  const supplied = { ...ready(7), proxy: "https://private.invalid", name: "private name" };
  const admitted = state.claim({ ...attempt, rows: [ready(9), supplied] });
  if (admitted.kind !== "started") throw new Error("expected new operation");

  supplied.profileId = "different_profile";
  admitted.operation.rows[0]!.profileId = "different_snapshot";
  expect(state.get(attempt)?.rows).toEqual([ready(7), ready(9)]);
  expect(() => state.record(admitted.owner, { index: 7, profileId: "different_profile", status: "updated" })).toThrow(ProxyOperationStateError);
  expect(state.record(admitted.owner, { index: 7, profileId: "profile_7", status: "updated" })).toBe(true);
  expect(state.finish(admitted.owner)).toMatchObject({ phase: "settled", rows: [
    { index: 7, profileId: "profile_7", status: "updated" },
    { index: 9, profileId: "profile_9", status: "not-started" },
  ] });
  expect(state.record(admitted.owner, { index: 9, profileId: "profile_9", status: "updated" })).toBe(false);
  expect(JSON.stringify(state.get(attempt))).not.toContain("private");
});

test("a live preview keeps its fences until retirement even under capacity pressure", () => {
  let now = 1000;
  const state = new ProxyOperationState({ now: () => now, maxRecords: 2, retentionMs: 1000 });
  const preview = state.issuePreview();
  const first = binding(state, preview), second = binding(state, preview), third = binding(state, preview);

  expect(state.get(first)).toBeNull();
  expect(state.reconcile(first).operation?.phase).toBe("sealed");
  now += 2000;
  expect(state.reconcile(second).operation?.phase).toBe("sealed");
  expect(state.claim({ ...first, rows: [ready(0)] })).toMatchObject({ kind: "existing", operation: { phase: "sealed" } });
  expect(state.reconcile(third)).toMatchObject({ invalidatedPreviewId: preview, operation: { phase: "sealed" } });

  expect(state.currentPreviewId()).toBeNull();
  expect(() => state.claim({ ...first, rows: [ready(0)] })).toThrow("Preview expired");
  expect(state.reconcile(first).operation).toMatchObject({ phase: "retired", total: 0, rows: [] });
  expect(state.get(first)).toBeNull();
  expect(state.issuePreview()).not.toBe(preview);
});

test("retirement and expiry never evict an already admitted worker", () => {
  let now = 1000;
  const state = new ProxyOperationState({ now: () => now, maxRecords: 2, maxRows: 1, retentionMs: 1000 });
  const first = binding(state, state.issuePreview());
  const admitted = state.claim({ ...first, rows: [ready(0)] });
  if (admitted.kind !== "started") throw new Error("expected new operation");

  const second = binding(state, state.issuePreview());
  now += 2000;
  expect(state.reconcile(first).operation?.phase).toBe("running");
  expect(() => state.claim({ ...second, rows: [ready(0)] })).toThrow("still running");
  state.finish(admitted.owner);
  expect(state.claim({ ...second, rows: [ready(0)] }).kind).toBe("started");
  expect(state.get(first)).toBeNull();
  expect(state.reconcile(first).operation?.phase).toBe("retired");

  const otherScope = new ProxyOperationState();
  expect(() => otherScope.reconcile(first)).toThrow("another server session");
  expect(state.reconcile({ ...first, previewId: `z.${crypto.randomUUID()}` }).operation).toBeNull();
});
