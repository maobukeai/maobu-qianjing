import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

export type WorkspaceOperationKind = "profile-batch" | "profile-import" | "profile-move" | "profile-cookies" | "profile-file-update" | "profile-trash" | "profile-proxies" | "workspace-switch" | "workspace-backup" | "workspace-restore" | "app-restart";
export interface WorkspaceOperationLease {
  readonly id: number;
  readonly kind: WorkspaceOperationKind;
  readonly workspaceId: string;
}
export interface WorkspaceOperationSnapshot {
  readonly workspaceId: string | null;
  readonly operation: (WorkspaceOperationLease & { readonly phase: "running" | "refreshing" }) | null;
  readonly workspaceJob: { readonly id: string; readonly kind: "backup" | "restore"; readonly phase: "running" | "refreshing" } | null;
  readonly restartPending: boolean;
  readonly nativeUpdateBusy: boolean;
  readonly blocked: boolean;
}

/** Session-only ownership. UI state alone cannot exclude two actions in one frame. */
export function createWorkspaceOperationCoordinator(initial?: { currentId: string; activeId: string }) {
  let sequence = 0;
  let owner: WorkspaceOperationLease | null = null;
  let snapshot: WorkspaceOperationSnapshot = Object.freeze({ workspaceId: initial?.currentId ?? null, operation: null, workspaceJob: null, restartPending: !!initial && initial.currentId !== initial.activeId, nativeUpdateBusy: false, blocked: !initial || initial.currentId !== initial.activeId });
  const listeners = new Set<() => void>();
  const refreshers = new Set<() => Promise<unknown>>();
  const settling = new Map<string, Promise<void>>();
  function update(patch: Partial<WorkspaceOperationSnapshot>) {
    const next = { ...snapshot, ...patch };
    next.blocked = !next.workspaceId || !!next.operation || !!next.workspaceJob || next.restartPending || next.nativeUpdateBusy;
    if (Object.keys(patch).every(key => snapshot[key as keyof WorkspaceOperationSnapshot] === next[key as keyof WorkspaceOperationSnapshot])) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }
  const coordinator = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    registerWorkspaceRefresh(refresh: () => Promise<unknown>) { refreshers.add(refresh); return () => { refreshers.delete(refresh); }; },
    async refreshWorkspaceViews(lease: WorkspaceOperationLease) {
      if (owner !== lease) return;
      const results = await Promise.allSettled([...refreshers].map(refresh => Promise.resolve().then(refresh)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    setWorkspace(currentId: string, activeId: string) { update({ workspaceId: currentId, restartPending: currentId !== activeId }); },
    setNativeUpdateBusy(value: boolean) { update({ nativeUpdateBusy: value }); },
    acquire(kind: WorkspaceOperationKind, workspaceId = snapshot.workspaceId, options?: { allowPreparedRestart?: boolean }): WorkspaceOperationLease | null {
      if (!workspaceId || workspaceId !== snapshot.workspaceId || owner || snapshot.workspaceJob || snapshot.nativeUpdateBusy || snapshot.restartPending && !(kind === "app-restart" && options?.allowPreparedRestart)) return null;
      owner = Object.freeze({ id: ++sequence, kind, workspaceId });
      update({ operation: Object.freeze({ ...owner, phase: "running" }) });
      return owner;
    },
    release(lease: WorkspaceOperationLease) {
      if (owner !== lease) return false;
      owner = null;
      update({ operation: null });
      return true;
    },
    setPhase(lease: WorkspaceOperationLease, phase: "running" | "refreshing") {
      if (owner !== lease || snapshot.operation?.phase === phase) return;
      update({ operation: Object.freeze({ ...lease, phase }) });
    },
    canContinueBatch(lease: WorkspaceOperationLease | null, workspaceId = snapshot.workspaceId) {
      return !!lease && owner === lease && lease.kind === "profile-batch" && lease.workspaceId === workspaceId && workspaceId === snapshot.workspaceId && !snapshot.restartPending && !snapshot.workspaceJob && !snapshot.nativeUpdateBusy;
    },
    observeWorkspaceJob(job: { id: string; kind: "backup" | "restore" }) {
      if (snapshot.workspaceJob?.id === job.id) return;
      update({ workspaceJob: Object.freeze({ id: job.id, kind: job.kind, phase: "running" }) });
    },
    finishWorkspaceJob(id: string, refresh: () => Promise<unknown>): Promise<void> {
      const existing = settling.get(id);
      if (existing) return existing;
      if (snapshot.workspaceJob?.id !== id) return Promise.resolve();
      update({ workspaceJob: Object.freeze({ ...snapshot.workspaceJob, phase: "refreshing" }) });
      // Keep ownership through refresh, even if the initiating page unmounts.
      const pending = Promise.resolve().then(refresh).then(() => {}).finally(() => {
        settling.delete(id);
        if (snapshot.workspaceJob?.id === id) update({ workspaceJob: null });
      });
      settling.set(id, pending);
      return pending;
    },
  };
  return coordinator;
}
export type WorkspaceOperationCoordinator = ReturnType<typeof createWorkspaceOperationCoordinator>;

export function workspaceOperationMessage(snapshot: WorkspaceOperationSnapshot): string {
  if (snapshot.operation?.kind === "profile-proxies") return snapshot.operation.phase === "refreshing" ? "Refreshing proxy assignment results. Workspace actions will unlock shortly." : "A proxy assignment is in progress. Wait for its result before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-trash") return snapshot.operation.phase === "refreshing" ? "Refreshing recycle bin results. Workspace actions will unlock shortly." : "A recycle bin operation is in progress. Wait for its result before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-file-update") return snapshot.operation.phase === "refreshing" ? "Refreshing file update results. Workspace actions will unlock shortly." : "A file update is in progress. Wait for its result before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-cookies") return snapshot.operation.phase === "refreshing" ? "Refreshing cookie import results. Workspace actions will unlock shortly." : "A cookie import is in progress. Wait for its result before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-move") return snapshot.operation.phase === "refreshing" ? "Confirming the destination groups. Workspace actions will unlock shortly." : "An environment move is in progress. Wait for confirmation before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-import") return snapshot.operation.phase === "refreshing" ? "Refreshing imported environments. Workspace actions will unlock shortly." : "An import is in progress. Wait for its result before switching workspaces, backing up, restoring or installing an update.";
  if (snapshot.operation?.kind === "profile-batch") return snapshot.operation.phase === "refreshing" ? "Refreshing the environment list. Workspace actions will unlock shortly." : "An environment batch task is running. Workspace switching, backups, restores, and app installation are available after it finishes.";
  if (snapshot.nativeUpdateBusy || snapshot.operation?.kind === "app-restart") return "Wait for the app update or restart to finish before starting environment tasks.";
  if (snapshot.workspaceJob?.phase === "refreshing") return "Refreshing workspace data. Environment tasks will unlock shortly.";
  if (snapshot.workspaceJob || snapshot.operation?.kind === "workspace-backup" || snapshot.operation?.kind === "workspace-restore") return "Wait for the workspace backup or restore task to finish before starting environment tasks.";
  if (snapshot.restartPending || snapshot.operation?.kind === "workspace-switch") return "Finish or cancel the prepared workspace switch before starting environment tasks.";
  return "Wait for the workspace to load before starting environment tasks.";
}
const WorkspaceOperationsContext = createContext<WorkspaceOperationCoordinator | null>(null);
export function WorkspaceOperationsProvider({ coordinator, children }: { coordinator: WorkspaceOperationCoordinator; children: ReactNode }) { return <WorkspaceOperationsContext.Provider value={coordinator}>{children}</WorkspaceOperationsContext.Provider>; }
const emptySnapshot = createWorkspaceOperationCoordinator().getSnapshot();
const noSubscription = () => () => {};
const getEmptySnapshot = () => emptySnapshot;
export function useOptionalWorkspaceOperations() {
  const coordinator = useContext(WorkspaceOperationsContext);
  const snapshot = useSyncExternalStore(coordinator?.subscribe ?? noSubscription, coordinator?.getSnapshot ?? getEmptySnapshot, coordinator?.getSnapshot ?? getEmptySnapshot);
  return coordinator ? { coordinator, snapshot } : null;
}
export function useWorkspaceOperations() {
  const value = useOptionalWorkspaceOperations();
  if (!value) throw new Error("WorkspaceProvider is required.");
  return value;
}
