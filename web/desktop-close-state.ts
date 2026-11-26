/** This registry deliberately cannot hold form values, account names or passwords. */
export const DESKTOP_DRAFT_LABELS = {
  "profile-create": "New profile",
  "profile-edit": "Edit profile",
  "extension-install": "Add extension",
  "extension-defaults": "Extension defaults",
  "sync-settings": "Snapshot settings",
  "update-settings": "Update settings",
  "workspace-task": "Workspace task",
  "network-settings": "Network settings",
  "app-lock-settings": "App master password lock",
  "assistant-draft": "AI message draft",
  "assistant-service-draft": "Model service settings draft",
  "proxy-assignment-draft": "Local proxy assignment draft",
  "proxy-replacement-draft": "Proxy replacement draft",
  "script-details": "Script details",
  "workspace-metadata": "Workspace details",
} as const;
export type DesktopDraftLabel = keyof typeof DESKTOP_DRAFT_LABELS;
export interface DesktopDraftFlags { dirty: boolean; busy: boolean; active?: boolean }
export interface DesktopDraftSnapshot { readonly dirty: readonly DesktopDraftLabel[]; readonly busy: readonly DesktopDraftLabel[]; readonly revision: number }
export const EMPTY_DESKTOP_DRAFT_SNAPSHOT: DesktopDraftSnapshot = Object.freeze({ dirty: Object.freeze([]), busy: Object.freeze([]), revision: 0 });
export function createDesktopCloseRegistry() {
  const entries = new Map<symbol, { label: DesktopDraftLabel; dirty: boolean; busy: boolean }>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_DESKTOP_DRAFT_SNAPSHOT;
  function publish() {
    const dirty = [...new Set([...entries.values()].filter(value => value.dirty).map(value => value.label))];
    const busy = [...new Set([...entries.values()].filter(value => value.busy).map(value => value.label))];
    // A second dirty owner under the same display label still changes what a restart can discard.
    snapshot = Object.freeze({ dirty: Object.freeze(dirty), busy: Object.freeze(busy), revision: snapshot.revision + 1 });
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register(label: DesktopDraftLabel, initial: DesktopDraftFlags) {
      if (!Object.hasOwn(DESKTOP_DRAFT_LABELS, label)) throw new Error("Unknown desktop draft label");
      const owner = Symbol(label); let disposed = false;
      const update = (flags: DesktopDraftFlags) => {
        if (disposed) return;
        if (typeof flags.dirty !== "boolean" || typeof flags.busy !== "boolean" || flags.active !== undefined && typeof flags.active !== "boolean") throw new Error("Desktop draft state accepts booleans only");
        if (flags.active === false || (!flags.dirty && !flags.busy)) {
          if (entries.delete(owner)) publish();
          return;
        }
        const previous = entries.get(owner);
        if (previous?.dirty === flags.dirty && previous.busy === flags.busy) return;
        entries.set(owner, { label, dirty: flags.dirty, busy: flags.busy });
        publish();
      };
      update(initial);
      return { update, dispose() { if (disposed) return; disposed = true; if (entries.delete(owner)) publish(); } };
    },
  };
}
export type DesktopCloseRegistry = ReturnType<typeof createDesktopCloseRegistry>;
export interface DesktopCloseIntent { sessionId: string; requestId: string; deliveryId: number }
export interface DesktopCloseResolved { sessionId: string; requestId: string; outcome: "cancelled" | "unavailable" }
export type DesktopCloseResolution = "holding" | "cancelled" | "continuing" | "stale";
export interface DesktopCloseNative {
  listenIntent(callback: (intent: DesktopCloseIntent) => void): Promise<() => void>;
  listenResolved(callback: (result: DesktopCloseResolved) => void): Promise<() => void>;
  register(): Promise<{ sessionId: string }>;
  unregister(sessionId: string): Promise<void>;
  resolve(intent: DesktopCloseIntent, decision: "hold" | "cancel" | "proceed"): Promise<DesktopCloseResolution>;
}
export interface DesktopCloseView {
  phase: "idle" | "confirm" | "waiting" | "error";
  dirty: readonly DesktopDraftLabel[];
  busy: readonly DesktopDraftLabel[];
  sending: boolean;
  connectionError: boolean;
  revision: number;
}
export const EMPTY_DESKTOP_CLOSE_VIEW: DesktopCloseView = { phase: "idle", dirty: [], busy: [], sending: false, connectionError: false, revision: 0 };
const validToken = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validIntent(value: DesktopCloseIntent) { return value && validToken(value.sessionId) && validToken(value.requestId) && Number.isSafeInteger(value.deliveryId) && value.deliveryId > 0; }

/** Single renderer owner; late subscriptions/replies can never approve a later request. */
export function createDesktopCloseBridge(native: DesktopCloseNative, registry: DesktopCloseRegistry, publish: (view: DesktopCloseView) => void, focus: { capture(): void; restore(): void } = { capture() {}, restore() {} }) {
  let disposed = false, started = false, sessionId: string | null = null, pending: DesktopCloseIntent | null = null, earlyIntent: DesktopCloseIntent | null = null;
  let action = 0, deciding = false, view = EMPTY_DESKTOP_CLOSE_VIEW;
  const unlisten = new Set<() => void>();
  const update = (change: Partial<DesktopCloseView>) => { if (disposed) return; view = { ...view, ...change, revision: view.revision + 1 }; publish(view); };
  const release = (callback: () => void) => { try { void Promise.resolve(callback()).catch(() => {}); } catch {} };
  const owns = (intent: DesktopCloseIntent) => !disposed && pending?.sessionId === intent.sessionId && pending.requestId === intent.requestId;
  const clear = (error = false) => {
    pending = null; deciding = false; action++;
    update({ phase: error ? "error" : "idle", dirty: [], busy: [], sending: false });
    focus.restore();
  };
  const snapshot = () => { const value = registry.getSnapshot(); return { dirty: value.dirty, busy: value.busy }; };
  const decide = async (decision: "cancel" | "proceed") => {
    if (disposed || !pending || deciding || view.phase === "waiting") return;
    if (decision === "proceed" && registry.getSnapshot().busy.length) { update({ phase: "confirm", ...snapshot() }); return; }
    const intent = { ...pending }, revision = ++action;
    deciding = true; update({ sending: true });
    try {
      const result = await native.resolve(intent, decision);
      if (!owns(intent) || revision !== action) return;
      deciding = false;
      if (result === "cancelled") clear();
      else if (result === "continuing" && decision === "proceed") update({ phase: "waiting", sending: false });
      else clear(true);
    } catch {
      if (owns(intent) && revision === action) { deciding = false; update({ phase: "error", sending: false }); }
    }
  };
  const hold = async (intent: DesktopCloseIntent) => {
    const revision = action;
    try {
      const result = await native.resolve(intent, "hold");
      if (!owns(intent) || pending?.deliveryId !== intent.deliveryId || action !== revision || view.phase !== "confirm") return;
      if (result !== "holding") clear(true);
    } catch { if (owns(intent) && pending?.deliveryId === intent.deliveryId && action === revision && view.phase === "confirm") update({ phase: "error", sending: false }); }
  };
  const receive = (intent: DesktopCloseIntent) => {
    if (disposed || !validIntent(intent)) return;
    if (!sessionId) { earlyIntent = intent; return; }
    if (intent.sessionId !== sessionId) return;
    if (pending?.requestId === intent.requestId) {
      if (intent.deliveryId <= pending.deliveryId) return;
      pending = { ...intent };
      if (!deciding && view.phase !== "waiting") { update({ ...snapshot() }); void hold(intent); }
      return;
    }
    pending = { ...intent }; deciding = false; action++;
    focus.capture();
    const current = snapshot();
    update({ phase: "confirm", ...current, sending: false });
    if (!current.dirty.length && !current.busy.length) void decide("proceed");
    else void hold(intent);
  };
  const resolved = (result: DesktopCloseResolved) => {
    if (!result || result.sessionId !== sessionId || !pending || result.requestId !== pending.requestId) return;
    if (result.outcome === "cancelled") clear();
    else if (result.outcome === "unavailable") clear(true);
  };
  return {
    start() {
      if (started || disposed) return; started = true;
      const stopRegistry = registry.subscribe(() => { if (pending && view.phase === "confirm") update(snapshot()); });
      unlisten.add(stopRegistry);
      void (async () => {
        try {
          const results = await Promise.allSettled([native.listenIntent(receive), native.listenResolved(resolved)]);
          let failed = false;
          for (const result of results) {
            if (result.status === "rejected") failed = true;
            else if (disposed) release(result.value); else unlisten.add(result.value);
          }
          if (disposed) return;
          if (failed) throw new Error("Desktop close listener unavailable");
          const registration = await native.register();
          if (!validToken(registration.sessionId)) throw new Error("Invalid desktop close registration");
          if (disposed) { void native.unregister(registration.sessionId).catch(() => {}); return; }
          sessionId = registration.sessionId;
          if (earlyIntent) { const intent = earlyIntent; earlyIntent = null; receive(intent); }
        } catch { if (!disposed) { for (const callback of unlisten) release(callback); unlisten.clear(); update({ connectionError: true }); } }
      })();
    },
    keepEditing() { if (view.phase === "error" && !pending) { update({ phase: "idle" }); return; } return decide("cancel"); },
    discardAndClose() { return decide("proceed"); },
    dispose() {
      if (disposed) return; disposed = true; pending = null; earlyIntent = null; action++;
      for (const callback of unlisten) release(callback); unlisten.clear();
      if (sessionId) { const ownedSession = sessionId; sessionId = null; void native.unregister(ownedSession).catch(() => {}); }
    },
  };
}
