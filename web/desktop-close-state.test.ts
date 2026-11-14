import { expect, test } from "bun:test";
import { createDesktopCloseBridge, createDesktopCloseRegistry, type DesktopCloseIntent, type DesktopCloseNative, type DesktopCloseResolution, type DesktopCloseResolved, type DesktopCloseView } from "./desktop-close-state.ts";
const sessionId = "a".repeat(64), requestId = "b".repeat(64);
const intent = (deliveryId = 1): DesktopCloseIntent => ({ sessionId, requestId, deliveryId });
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let onIntent!: (intent: DesktopCloseIntent) => void, onResolved!: (result: DesktopCloseResolved) => void;
  const calls: Array<{ intent: DesktopCloseIntent; decision: string }> = [], unregister: string[] = [], cleanup: string[] = [], views: DesktopCloseView[] = [];
  let registered = 0, captures = 0, restores = 0;
  const native: DesktopCloseNative = {
    listenIntent: async handler => { onIntent = handler; return () => { cleanup.push("intent"); }; },
    listenResolved: async handler => { onResolved = handler; return () => { cleanup.push("resolved"); }; },
    register: async () => { registered++; return { sessionId }; },
    unregister: async value => { unregister.push(value); },
    resolve: async (value, decision) => { calls.push({ intent: { ...value }, decision }); return decision === "hold" ? "holding" : decision === "cancel" ? "cancelled" : "continuing"; },
  };
  const registry = createDesktopCloseRegistry();
  const bridge = createDesktopCloseBridge(native, registry, view => views.push(view), { capture() { captures++; }, restore() { restores++; } });
  return { native, registry, bridge, calls, unregister, cleanup, views, receive: (value = intent()) => onIntent(value), resolved: (value: DesktopCloseResolved) => onResolved(value), get registered() { return registered; }, get captures() { return captures; }, get restores() { return restores; } };
}
test("desktop draft registry stores only fixed labels and boolean flags with per-owner cleanup", () => {
  const registry = createDesktopCloseRegistry(), first = registry.register("profile-create", { dirty: true, busy: false });
  const second = registry.register("profile-create", { dirty: true, busy: true });
  expect(registry.getSnapshot().dirty).toEqual(["profile-create"]);
  expect(registry.getSnapshot().busy).toEqual(["profile-create"]);
  first.dispose(); expect(registry.getSnapshot().dirty).toEqual(["profile-create"]);
  second.update({ dirty: true, busy: false, active: false }); expect(registry.getSnapshot().dirty).toEqual([]);
  second.dispose(); second.update({ dirty: true, busy: true }); expect(registry.getSnapshot().dirty).toEqual([]);
  expect(Object.isFrozen(registry.getSnapshot())).toBe(true);
  expect(Object.isFrozen(registry.getSnapshot().dirty)).toBe(true);
  expect(() => registry.register("PRIVATE_USER_INPUT" as any, { dirty: true, busy: false })).toThrow("Unknown desktop draft label");
  expect(() => registry.register("profile-edit", { dirty: "PRIVATE_PASSWORD" as any, busy: false })).toThrow("booleans only");
});
test("restart review revisions track overlapping owners without duplicating labels or counting clean owners", () => {
  const registry = createDesktopCloseRegistry();
  const clean = registry.register("script-details", { dirty: false, busy: false });
  expect(registry.getSnapshot().revision).toBe(0);
  const first = registry.register("script-details", { dirty: true, busy: false });
  const approved = registry.getSnapshot();
  clean.update({ dirty: true, busy: false });
  expect(registry.getSnapshot()).toEqual({ ...approved, revision: approved.revision + 1 });
  const added = registry.getSnapshot();
  clean.update({ dirty: true, busy: false });
  expect(registry.getSnapshot()).toBe(added);
  first.dispose();
  expect(registry.getSnapshot()).toEqual({ ...added, revision: added.revision + 1 });
});
test("clean native close proceeds once, duplicates merge, and late cancel does not affect another token", async () => {
  const f = fixture(), reply = deferred<DesktopCloseResolution>();
  f.native.resolve = async (value, decision) => { f.calls.push({ intent: value, decision }); return reply.promise; };
  f.bridge.start(); await settle(); f.receive(); f.receive(); f.receive(intent(2));
  expect(f.calls.map(call => call.decision)).toEqual(["proceed"]);
  expect(f.captures).toBe(1); reply.resolve("continuing"); await settle();
  expect(f.views.at(-1)?.phase).toBe("waiting");
  f.resolved({ sessionId: "c".repeat(64), requestId, outcome: "cancelled" });
  f.resolved({ sessionId, requestId: "d".repeat(64), outcome: "cancelled" });
  expect(f.views.at(-1)?.phase).toBe("waiting");
  f.resolved({ sessionId, requestId, outcome: "cancelled" });
  expect(f.views.at(-1)?.phase).toBe("idle"); expect(f.restores).toBe(1); f.bridge.dispose();
});
test("dirty reviews ACK without exiting; saves and busy owners cannot trigger an automatic exit", async () => {
  const f = fixture(), draft = f.registry.register("sync-settings", { dirty: true, busy: true });
  f.bridge.start(); await settle(); f.receive(); await settle();
  expect(f.calls.map(call => call.decision)).toEqual(["hold"]);
  await f.bridge.discardAndClose(); expect(f.calls).toHaveLength(1);
  draft.update({ dirty: false, busy: false }); await settle();
  expect(f.calls).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("confirm");
  await f.bridge.keepEditing(); expect(f.views.at(-1)?.phase).toBe("idle");
  expect(f.calls.map(call => call.decision)).toEqual(["hold", "cancel"]); f.bridge.dispose();
});
test("discard preserves owners and waits for native browser confirmation; native cancellation restores editing", async () => {
  const f = fixture(); f.registry.register("profile-edit", { dirty: true, busy: false });
  f.bridge.start(); await settle(); f.receive(); await settle();
  await f.bridge.discardAndClose(); await f.bridge.discardAndClose();
  expect(f.calls.map(call => call.decision)).toEqual(["hold", "proceed"]);
  expect(f.views.at(-1)?.phase).toBe("waiting"); expect(f.registry.getSnapshot().dirty).toEqual(["profile-edit"]);
  f.resolved({ sessionId, requestId, outcome: "cancelled" });
  expect(f.views.at(-1)?.phase).toBe("idle"); expect(f.registry.getSnapshot().dirty).toEqual(["profile-edit"]); f.bridge.dispose();
});
test("retry delivery uses the latest ACK and ignores older delayed acknowledgements", async () => {
  const f = fixture(), first = deferred<DesktopCloseResolution>(); f.registry.register("extension-defaults", { dirty: true, busy: false });
  f.native.resolve = async (value, decision) => { f.calls.push({ intent: value, decision }); return value.deliveryId === 1 ? first.promise : "holding"; };
  f.bridge.start(); await settle(); f.receive(); f.receive(intent(2)); await settle(); first.resolve("stale"); await settle();
  expect(f.views.at(-1)?.phase).toBe("confirm"); expect(f.captures).toBe(1);
  expect(f.calls.map(call => call.intent.deliveryId)).toEqual([1, 2]); f.bridge.dispose();
});
test("late registration and subscriptions are released after unmount without resolving any close", async () => {
  const f = fixture(), registration = deferred<{ sessionId: string }>(); f.native.register = () => registration.promise;
  f.bridge.start(); await settle(); f.bridge.dispose(); registration.resolve({ sessionId }); await settle();
  expect(f.unregister).toEqual([sessionId]); expect(f.cleanup.sort()).toEqual(["intent", "resolved"]); expect(f.calls).toEqual([]);
  f.receive(); await settle(); expect(f.calls).toEqual([]);
});
test("listener failure never registers or closes, and raw IPC failures cannot appear in the view", async () => {
  const f = fixture(); f.native.listenResolved = async () => { throw new Error("PRIVATE_NATIVE_ERROR"); };
  f.bridge.start(); await settle(); expect(f.registered).toBe(0); expect(f.cleanup).toEqual(["intent"]);
  expect(f.views.at(-1)?.connectionError).toBe(true); expect(JSON.stringify(f.views)).not.toContain("PRIVATE"); f.bridge.dispose();
});
test("unavailable renderer and rejected resolve never claim an exit or clear drafts", async () => {
  const f = fixture(); f.registry.register("profile-create", { dirty: true, busy: false });
  f.bridge.start(); await settle(); f.receive(); await settle();
  f.native.resolve = async () => { throw new Error("PRIVATE_CREDENTIAL"); };
  await f.bridge.discardAndClose(); expect(f.views.at(-1)?.phase).toBe("error");
  expect(JSON.stringify(f.views)).not.toContain("PRIVATE"); expect(f.registry.getSnapshot().dirty).toEqual(["profile-create"]);
  f.resolved({ sessionId, requestId, outcome: "unavailable" });
  expect(f.views.at(-1)?.phase).toBe("error"); await f.bridge.keepEditing(); expect(f.views.at(-1)?.phase).toBe("idle"); f.bridge.dispose();
});
