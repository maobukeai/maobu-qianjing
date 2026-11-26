import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "./i18n.tsx";
import { folderScope, folderTree as buildFolderTree, type FolderInfo } from "../folders.ts";
import type { TrashProfileView } from "../proxy-tools-types.ts";
import { proxyResultPage } from "./proxies.tsx";
import { createTrashReader, createTrashSelection, createTrashTask, TRASH_FAILURE_REASONS, type TrashAction, type TrashTaskSnapshot } from "./trash-task.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationCoordinator, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
import { AppIcon, useConfirmDialog } from "./ui-primitives.tsx";
import "./trash.css";

export function filterTrash(profiles: readonly TrashProfileView[], groups: string[] | null, search: string): TrashProfileView[] {
  const query = search.trim().toLowerCase();
  const scope = groups === null ? null : new Set(groups);
  return profiles.filter(
    profile =>
      (!scope || scope.has(profile.group))
      && (!query || [profile.id, profile.name, profile.group].some(value => value.toLowerCase().includes(query))),
  );
}

const entryStamp = (profile: TrashProfileView) => `${profile.trashedAt}:${profile.version ?? "none"}`;

const ROW_LABELS = {
  pending: "Waiting",
  restored: "Restored",
  purged: "Permanently deleted",
  failed: "Not completed",
  unconfirmed: "Needs confirmation",
} as const;

function TrashTaskPanel({
  snapshot,
  busy,
  active,
  retryBlocked,
  headingRef,
  onRetry,
  onDismiss,
  onRefresh,
}: {
  snapshot: TrashTaskSnapshot;
  busy: boolean;
  active: boolean;
  retryBlocked: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onRetry: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
}) {
  const { t, language } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [includeAll, setIncludeAll] = useState(false);
  const [requestedPage, setPage] = useState(0);
  const expand = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<{ button: HTMLButtonElement; attemptId: number | undefined } | null>(null);
  const receipt = snapshot.receipt;
  const hasReviewItems = !!(receipt?.failedIds.length || receipt?.unconfirmedIds.length);
  const attentionOnly = hasReviewItems && !includeAll;
  const action = snapshot.attempt?.action ?? receipt?.action;
  const confirming = snapshot.phase === "confirming";

  useEffect(() => {
    setPage(0);
  }, [receipt?.operationId, attentionOnly]);

  useEffect(() => {
    setExpanded(false);
    setIncludeAll(false);
  }, [receipt?.operationId]);

  useEffect(() => {
    if (busy || !retryOrigin.current || !active) return;
    const { button: origin, attemptId } = retryOrigin.current;
    retryOrigin.current = null;
    if (attemptId === snapshot.attempt?.id) return;
    const doc = origin.ownerDocument;
    if (doc.activeElement === doc.body || doc.activeElement === origin) {
      expand.current?.focus({ preventScroll: true });
    }
  }, [busy, snapshot.attempt?.id, active]);

  const filtered = receipt?.rows.filter(row => !attentionOnly || row.status === "failed" || row.status === "unconfirmed") ?? [];
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const page = Math.min(requestedPage, pages - 1);

  const headline = snapshot.phase === "confirming"
    ? "Waiting for permanent deletion confirmation…"
    : snapshot.phase === "sending"
      ? action === "purge"
        ? "Permanently deleting approved Trash items…"
        : "Restoring selected Trash items…"
      : snapshot.phase === "refreshing"
        ? "Refreshing lists after the Trash operation…"
        : receipt?.status === "unconfirmed"
          ? "Trash result needs confirmation"
          : receipt?.status === "partial" || receipt?.status === "failed"
            ? "Trash operation needs review"
            : !receipt && snapshot.blockedReason
              ? "Trash operation blocked"
              : action === "purge"
                ? "Permanent deletion confirmed"
                : "Restore confirmed";

  return (
    <MotionPresence present={!!receipt || busy || !!snapshot.blockedReason} kind="panel">
      {() => (
        <section className="trash-task-panel" aria-labelledby={`${id}-title`} aria-busy={busy}>
          <header>
            <h3 ref={headingRef} id={`${id}-title`} data-trash-task-title tabIndex={-1}>{t(headline)}</h3>
            <button
              type="button"
              className="iconbtn"
              disabled={busy}
              aria-label={t("Dismiss Trash operation result")}
              onClick={onDismiss}
            >
              <AppIcon name="close" className="sm" />
            </button>
          </header>

          {busy && (
            <p className="trash-task-progress" role="status">
              <i aria-hidden="true" />
              {t(
                snapshot.phase === "confirming"
                  ? "Only the exact IDs in the product confirmation can be permanently deleted."
                  : snapshot.phase === "refreshing"
                    ? "Confirmed results are preserved while Trash, environments and workspace lists finish refreshing."
                    : "The request is already owned by this task. Leaving the page does not cancel items already sent.",
              )}
            </p>
          )}

          {snapshot.blockedReason && (
            <p className="trash-task-warning" role="alert">{t(snapshot.blockedReason)}</p>
          )}

          {receipt && (
            <>
              <div className="trash-task-counts" role="status">
                {receipt.succeededIds.length > 0 && <span>
                  <strong>{receipt.succeededIds.length.toLocaleString(language)}</strong>
                  {t(receipt.action === "purge" ? "Permanently deleted" : "Restored")}
                </span>}
                {receipt.failedIds.length > 0 && <span className="needs-review">
                  <strong>{receipt.failedIds.length.toLocaleString(language)}</strong>
                  {t("Not completed")}
                </span>}
                {receipt.unconfirmedIds.length > 0 && <span className="needs-review">
                  <strong>{receipt.unconfirmedIds.length.toLocaleString(language)}</strong>
                  {t("Needs confirmation")}
                </span>}
              </div>

              {receipt.status === "unconfirmed" && (
                <p className="trash-task-warning" role="alert">
                  {t("Refresh Trash to check what changed. Unconfirmed items aren’t retried automatically.")}
                </p>
              )}

              {receipt.refreshFailed && receipt.status !== "unconfirmed" && (
                <p className="trash-task-warning" role="alert">
                  {t("Some lists could not refresh. Confirmed results still apply.")}
                </p>
              )}

              <div className="trash-task-actions">
                {receipt.retryIds.length > 0 && (
                  <button
                    className={`btn xs${receipt.action === "purge" ? " trash-purge" : ""}`}
                    type="button"
                    disabled={(busy && !confirming) || retryBlocked}
                    aria-disabled={confirming || undefined}
                    onClick={event => {
                      retryOrigin.current = { button: event.currentTarget, attemptId: snapshot.attempt?.id };
                      onRetry();
                    }}
                  >
                    {t(
                      receipt.action === "purge"
                        ? "Review and retry deleting {count} failed items"
                        : "Retry restoring {count} failed items",
                      { count: receipt.retryIds.length.toLocaleString(language) },
                    )}
                  </button>
                )}
                {(receipt.refreshFailed || receipt.status === "unconfirmed") && (
                  <button type="button" className="btn xs" disabled={busy}
                    aria-label={t("Refresh Trash without repeating the operation")} onClick={onRefresh}>
                    <AppIcon name="refresh" className="sm" />{t("Refresh")}
                  </button>
                )}
                <button ref={expand} className="btn xs ghost" type="button" aria-expanded={expanded}
                  aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>
                  {t(expanded ? "Hide Trash operation details" : "View Trash operation details")}
                </button>
              </div>

              <div id={`${id}-details`} hidden={!expanded}>
                {hasReviewItems && <div className="trash-task-filters" role="group" aria-label={t("Trash operation items")}>
                  <button
                    type="button"
                    className="btn xs ghost"
                    aria-pressed={attentionOnly}
                    onClick={() => setIncludeAll(false)}
                  >
                    {t("Items needing review")}
                  </button>
                  <button
                    type="button"
                    className="btn xs ghost"
                    aria-pressed={!attentionOnly}
                    onClick={() => setIncludeAll(true)}
                  >
                    {t("All operation items")}
                  </button>
                </div>}

                <div className="trash-task-list" tabIndex={0} role="region" aria-label={t("Trash operation items")}>
                  <ul>
                    {filtered.slice(page * 50, (page + 1) * 50).map(row => (
                      <li key={row.id} data-trash-result-id={row.id}>
                        <div>
                          <code>{row.id}</code>
                          <span>{t(ROW_LABELS[row.status])}</span>
                        </div>
                        {row.reason && <p>{t(TRASH_FAILURE_REASONS[row.reason])}</p>}
                        {row.attempts > 1 && <small>{t("Attempt {count}", { count: row.attempts.toLocaleString(language) })}</small>}
                      </li>
                    ))}
                  </ul>
                  {!filtered.length && <p>{t("No operation items need review in this result.")}</p>}
                </div>

                {pages > 1 && (
                  <div className="trash-task-pager">
                    <button className="btn xs" type="button" disabled={!page} onClick={() => setPage(page - 1)}>
                      {t("Previous")}
                    </button>
                    <span>{t("Page {page} / {pages}", { page: page + 1, pages })}</span>
                    <button className="btn xs" type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                      {t("Next")}
                    </button>
                  </div>
                )}

              </div>
            </>
          )}

          {snapshot.history.length > 0 && (
            <details className="trash-task-history">
              <summary>{t("Earlier Trash results ({count})", { count: snapshot.history.length })}</summary>
              <ul>
                {[...snapshot.history].reverse().map(previous => (
                  <li key={previous.operationId}>
                    {t(previous.action === "restore" ? "Restore" : "Permanent deletion")}
                    {" · "}
                    {t("Confirmed {confirmed} · Not completed {failed} · Unknown {unknown}", {
                      confirmed: previous.succeededIds.length,
                      failed: previous.failedIds.length,
                      unknown: previous.unconfirmedIds.length,
                    })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </MotionPresence>
  );
}

export interface TrashPageProps {
  active?: boolean;
  onChanged: () => Promise<void>;
  folderTree?: FolderInfo[];
  onTaskSnapshotChange?: (snapshot: TrashTaskSnapshot) => void;
}

export function TrashPage({ active = true, onChanged, folderTree = [], onTaskSnapshotChange }: TrashPageProps) {
  const { t, language } = useTranslation();
  const workspace = useOptionalWorkspaceOperations();
  const { requestConfirm, cancelConfirm, confirmDialogNode } = useConfirmDialog({ portal: true });
  const latest = useRef({ active, workspace, onChanged, t, language, onTaskSnapshotChange });
  latest.current = { active, workspace, onChanged, t, language, onTaskSnapshotChange };

  const [selection] = useState(() => createTrashSelection());
  const [reader] = useState(() => createTrashReader());
  const originEntries = useRef(new Map<string, string>());
  const selectedEntries = useRef(new Map<string, string>());
  const heldLease = useRef<{ coordinator: WorkspaceOperationCoordinator; lease: WorkspaceOperationLease } | null>(null);

  const [task] = useState(() => createTrashTask({
    selection,
    workspaceId: () => latest.current.workspace?.snapshot.workspaceId ?? null,
    acquire: id => {
      const coordinator = latest.current.workspace?.coordinator;
      if (!coordinator) return { release() {} };
      const lease = coordinator.acquire("profile-trash", id);
      if (!lease) return null;
      const owner = { coordinator, lease };
      heldLease.current = owner;
      return {
        refreshing: () => coordinator.setPhase(lease, "refreshing"),
        release: () => {
          coordinator.release(lease);
          if (heldLease.current === owner) heldLease.current = null;
        },
      };
    },
    confirmPurge: approval => {
      const { active, t, language } = latest.current;
      if (!active) return false;
      return requestConfirm({
        title: t("Permanent deletion"),
        message: t("Permanently delete {count} profiles and their saved data? This cannot be undone.", {
          count: approval.count.toLocaleString(language),
        }),
        confirmLabel: t("Delete permanently"),
        tone: "danger",
      });
    },
    validateRetry: attempt => {
      const current = reader.getSnapshot();
      if (!current.loaded || current.stale || current.phase !== "ready") return false;
      const rows = new Map(current.profiles.map(profile => [profile.id, profile]));
      return attempt.ids.every(id => {
        const row = rows.get(id);
        return !!row && originEntries.current.get(id) === entryStamp(row);
      });
    },
    refreshTrash: reader.refresh,
    onChanged: () => latest.current.onChanged(),
    refreshWorkspace: async () => {
      const held = heldLease.current;
      if (held) await held.coordinator.refreshWorkspaceViews(held.lease);
    },
  }));

  const read = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const chosenState = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
  const operation = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);

  useEffect(() => {
    latest.current.onTaskSnapshotChange?.(operation);
  }, [operation]);
  useEffect(() => {
    if (!active) cancelConfirm();
  }, [active, cancelConfirm]);

  const [folders, setFolders] = useState<string[]>([]);
  const [foldersExpanded, setFoldersExpanded] = useState(false);
  const folderFiltersId = useId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [confirmedGone, setConfirmedGone] = useState<ReadonlyMap<string, string>>(new Map());
  const refreshButton = useRef<HTMLButtonElement>(null);
  const resultsRegion = useRef<HTMLElement>(null);
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const restoreOrigin = useRef<{ button: HTMLButtonElement; previousAttempt: number | undefined } | null>(null);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(language, { month: "short", day: "numeric", year: "numeric" }), [language]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }), [language]);

  useEffect(() => {
    if (active && !task.isBusy()) void reader.load();
  }, [active, workspace?.snapshot.workspaceId]);

  useEffect(() => () => {
    reader.dispose();
    task.dispose();
  }, []);

  useLayoutEffect(() => {
    if (!operation.receipt?.succeededIds.length) return;
    setConfirmedGone(previous => {
      const next = new Map(previous);
      let changed = false;
      for (const id of operation.receipt!.succeededIds) {
        const stamp = originEntries.current.get(id);
        if (stamp && next.get(id) !== stamp) {
          next.set(id, stamp);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [operation.receipt]);

  const profiles = useMemo(
    () => read.profiles.filter(profile => confirmedGone.get(profile.id) !== entryStamp(profile)),
    [read.profiles, confirmedGone],
  );
  const selected = useMemo(() => new Set(chosenState.ids), [chosenState]);
  const isChosen = (profile: TrashProfileView) =>
    selected.has(profile.id) && selectedEntries.current.get(profile.id) === entryStamp(profile);

  const choose = (targets: readonly TrashProfileView[], checked: boolean) => {
    for (const profile of targets) {
      if (checked) selectedEntries.current.set(profile.id, entryStamp(profile));
      else selectedEntries.current.delete(profile.id);
    }
    selection.set(targets.map(profile => profile.id), checked);
  };

  const filtered = useMemo(() => filterTrash(profiles, folders.length ? folders : null, search), [profiles, folders, search]);
  const folderProfiles = useMemo(() => filterTrash(profiles, folders, ""), [profiles, folders]);
  const groupDetails = useMemo(() => buildFolderTree(folderTree), [folderTree]);
  const groupCounts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const profile of profiles) direct.set(profile.group, (direct.get(profile.group) ?? 0) + 1);
    const counts = new Map(direct);
    for (const { name, ancestors } of groupDetails) {
      const count = direct.get(name);
      if (!count) continue;
      for (const ancestor of ancestors) counts.set(ancestor, (counts.get(ancestor) ?? 0) + count);
    }
    return counts;
  }, [profiles, groupDetails]);
  const paged = proxyResultPage(filtered, page);
  const chosen = profiles.filter(isChosen);
  const groups = useMemo(() => [...groupCounts.keys()].sort(), [groupCounts]);

  const visibleSelection = selection.visibleSummary(filtered.filter(isChosen).map(profile => profile.id));
  const selectedGroups = groups.filter(group => folders.includes(group)).length;
  const pageSelected = paged.items.filter(isChosen).length;
  const allResultsSelected = filtered.length > 0 && filtered.every(isChosen);
  const confirming = operation.phase === "confirming";
  const operationActive = operation.phase === "sending" || operation.phase === "refreshing";
  const busy = confirming || operationActive;
  const loading = read.phase === "loading";
  const externalBlock = !!workspace?.snapshot.blocked && workspace.snapshot.operation?.kind !== "profile-trash";
  const mutationUnavailable = externalBlock || !read.loaded || read.stale || loading;
  const mutationBlocked = busy || mutationUnavailable;
  const restoreDenied = chosen.some(profile => !profile.canRestore);
  const purgeDenied = chosen.some(profile => !profile.canPurge);

  useLayoutEffect(() => {
    if (!active) {
      restoreOrigin.current = null;
      return;
    }
    const origin = restoreOrigin.current;
    if (!origin || operation.phase !== "settled" || operation.attempt?.id === origin.previousAttempt) return;
    restoreOrigin.current = null;
    const doc = origin.button.ownerDocument;
    if (doc.activeElement === origin.button || doc.activeElement === doc.body) taskHeading.current?.focus();
  }, [active, operation.phase, operation.attempt?.id]);

  const refresh = () => {
    if (!task.isBusy() && reader.getSnapshot().phase !== "loading") void reader.load();
  };

  const retryRead = () => {
    refreshButton.current?.focus();
    refresh();
  };

  const begin = (action: TrashAction, targets: readonly TrashProfileView[], button: HTMLButtonElement) => {
    if (task.isBusy() || mutationBlocked || !targets.length) return;
    for (const profile of targets) originEntries.current.set(profile.id, entryStamp(profile));
    const origin = action === "restore" && button.ownerDocument.activeElement === button
      ? { button, previousAttempt: operation.attempt?.id }
      : null;
    restoreOrigin.current = origin;
    void task.submit(action, targets.map(profile => profile.id)).then(result => {
      if (!result && restoreOrigin.current === origin) restoreOrigin.current = null;
    });
  };

  const clearUnavailable = () => {
    const available = new Set(chosen.map(profile => profile.id));
    const missing = chosenState.ids.filter(id => !available.has(id));
    for (const id of missing) selectedEntries.current.delete(id);
    selection.set(missing, false);
    resultsRegion.current?.focus();
  };

  const changeFolders = (next: string[]) => {
    setFolders(next);
    setPage(0);
  };

  const resetFilters = () => {
    setSearch("");
    setFolders([]);
    setPage(0);
    resultsRegion.current?.focus();
  };

  const emptyState = !read.loaded
    ? read.phase === "error"
      ? "error"
      : "loading"
    : !profiles.length
      ? read.stale
        ? "stale-empty"
        : "empty"
      : "filter-empty";

  return (
    <div className="workspace proxy-page trash-page" hidden={!active} aria-labelledby="trash-page-title" aria-busy={busy || loading}>
      {active && confirmDialogNode}
      <header className="tools-intro page-heading">
        <div className="trash-heading-title">
          <h1 id="trash-page-title" tabIndex={-1}>{t("Trash")}</h1>
          {read.loaded && <span className="trash-heading-pill">{t("In Trash")} · {profiles.length.toLocaleString(language)}</span>}
        </div>
        <button ref={refreshButton} type="button" className="btn trash-refresh" aria-disabled={busy || loading || undefined} onClick={refresh}
          title={read.loadedAt ? t("Last read {time}", {
            time: new Date(read.loadedAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
          }) : undefined}>
          <AppIcon name="refresh" className="sm" />
          {loading ? t("Loading…") : t("Refresh")}
        </button>
      </header>

      {read.error && profiles.length > 0 && (
        <div className="tools-alert trash-read-alert" role="alert">
          <span>{t(read.error)} {t("The previous list is shown until a new read succeeds.")}</span>
          <button className="btn xs ghost" type="button" disabled={busy || loading} onClick={retryRead}>
            {t("Retry reading Trash")}
          </button>
        </div>
      )}

      {externalBlock && workspace && (
        <div className="tools-alert" role="status">{t(workspaceOperationMessage(workspace.snapshot))}</div>
      )}

      <TrashTaskPanel
        snapshot={operation}
        busy={busy}
        active={active}
        retryBlocked={externalBlock || loading}
        headingRef={taskHeading}
        onRetry={() => { void task.retryFailed(); }}
        onDismiss={() => { if (task.dismiss()) refreshButton.current?.focus(); }}
        onRefresh={retryRead}
      />

      <div className="trash-kpi-ribbon">
        <div className="trash-kpi-card">
          <div className="trash-kpi-top">
            <span>{t("Deleted profiles")}</span>
            <span className="trash-kpi-pill is-accent">{t("Local")}</span>
          </div>
          <div className="trash-kpi-val">
            <strong>{read.loaded ? profiles.length.toLocaleString(language) : "—"}</strong>
            <span>{read.loaded ? t("{count} environments", { count: profiles.length }) : ""}</span>
          </div>
        </div>
        <div className="trash-kpi-card">
          <div className="trash-kpi-top">
            <span>{t("Original folder")}</span>
            <span className="trash-kpi-pill">{t("Groups")}</span>
          </div>
          <div className="trash-kpi-val">
            <strong>{read.loaded ? groups.length.toLocaleString(language) : "—"}</strong>
            <span>{read.loaded ? t("Restore by folder") : ""}</span>
          </div>
        </div>
        <div className="trash-kpi-card">
          <div className="trash-kpi-top">
            <span>{t("Selected environments")}</span>
            <span className={`trash-kpi-pill${chosenState.ids.length > 0 ? " is-success" : ""}`}>{t(chosenState.ids.length > 0 ? "Ready" : "Idle")}</span>
          </div>
          <div className="trash-kpi-val">
            <strong>{read.loaded ? chosenState.ids.length.toLocaleString(language) : "—"}</strong>
            <span>{read.loaded ? t("{count} selected", { count: chosenState.ids.length }) : ""}</span>
          </div>
        </div>
        <div className="trash-kpi-card">
          <div className="trash-kpi-top">
            <span>{t("Restore")}</span>
            <span className="trash-kpi-pill is-warn">{t("Permanent deletion")}</span>
          </div>
          <div className="trash-kpi-val">
            <strong>{read.loaded ? filtered.length.toLocaleString(language) : "—"}</strong>
            <span>{read.loaded ? t("{count} environments", { count: filtered.length }) : ""}</span>
          </div>
        </div>
      </div>

      <div className={`trash-layout${profiles.length ? "" : " trash-layout-empty"}`}>
        {profiles.length > 0 && <aside className="tools-panel trash-folders" aria-label={t("Trash folders")} data-expanded={foldersExpanded}>
          <div className="tools-panel-head trash-folders-heading">
            <h3><AppIcon name="folders" className="sm" />{t("Restore by folder")}</h3>
            <span>{groups.length.toLocaleString(language)}</span>
          </div>
          <button type="button" className="trash-folders-disclosure" aria-controls={folderFiltersId} aria-expanded={foldersExpanded} onClick={() => setFoldersExpanded(open => !open)}>
            <AppIcon name="folders" />
            <span>{t("Trash folders")}</span>
            <small>{selectedGroups
              ? t("{count} selected", { count: selectedGroups.toLocaleString(language) })
              : groups.length.toLocaleString(language)}
            </small>
            <AppIcon name={foldersExpanded ? "chevronUp" : "chevronDown"} className="sm" />
          </button>
          <div id={folderFiltersId} className="trash-folder-filters">
            <button
              type="button"
              className={`folder-all${!folders.length ? " selected" : ""}`}
              aria-pressed={!folders.length}
              onClick={() => changeFolders([])}
            >
              <AppIcon name="folders" className="sm" />
              {t("All deleted profiles")} <span>{profiles.length.toLocaleString(language)}</span>
            </button>
            <div className="trash-folder-list">
              {groups.map(name => (
                <label className={`folder-choice${folders.includes(name) ? " selected" : ""}`} key={name}>
                  <input
                    type="checkbox"
                    aria-label={t("Folder {name}", { name: name || t("Ungrouped") })}
                    checked={folders.includes(name)}
                    onChange={event => {
                      const branch = new Set([name, ...folderScope(folderTree, name)]);
                      changeFolders(
                        event.target.checked
                          ? [...new Set([...folders, ...branch])]
                          : folders.filter(group => !branch.has(group)),
                      );
                    }}
                  />
                  <span>{name || t("Ungrouped")}</span>
                  <small>{groupCounts.get(name)!.toLocaleString(language)}</small>
                </label>
              ))}
            </div>
            {folders.length > 0 && <div className="trash-folder-action">
              {search.trim() && <p className="tools-hint">
                {t("Whole folder scope: {total} · Visible now: {visible} · Hidden by search: {hidden}", {
                  total: folderProfiles.length,
                  visible: filtered.length,
                  hidden: folderProfiles.length - filtered.length,
                })}
              </p>}
              <button
                type="button"
                className="btn primary"
                disabled={mutationBlocked || !folderProfiles.length || folderProfiles.some(profile => !profile.canRestore)}
                onClick={event => begin("restore", folderProfiles, event.currentTarget)}
              >
                {t("Restore all {count} in folder scope", { count: folderProfiles.length })}
              </button>
            </div>}
          </div>
        </aside>}

        <section ref={resultsRegion} tabIndex={-1} className="tools-panel trash-results" aria-label={t("Deleted profiles")}>
          {profiles.length > 0 && <div className="trash-search">
            <div className="trash-search-field">
              <AppIcon name="search" className="sm" />
              <input
                className="input"
                aria-label={t("Search Trash")}
                type="search"
                placeholder={t("Search by name, ID, or folder…")}
                value={search}
                onChange={event => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </div>
            {filtered.length > 0 && <button
              type="button"
              className="btn"
              onClick={() => choose(filtered, !allResultsSelected)}
            >
              {t(
                allResultsSelected ? "Unselect {count} matching results" : "Select all {count} results",
                { count: filtered.length },
              )}
            </button>}
            {filtered.length > 0 && (search || folders.length > 0) && (
              <button type="button" className="btn ghost" onClick={resetFilters}>
                {t("Reset Trash filters")}
              </button>
            )}
          </div>}

          {chosenState.ids.length > 0 && (
            <div className="trash-selection">
              <div className="trash-selection-scope">
                <strong>{t("{count} selected in total", { count: visibleSelection.total })}</strong>
                {visibleSelection.hidden > 0 && <span>
                  {t("Matching current filters {visible} · Hidden by filters {hidden}", {
                    visible: visibleSelection.visible,
                    hidden: visibleSelection.hidden,
                  })}
                </span>}
                <button
                  type="button"
                  className="tlink"
                  onClick={() => {
                    selectedEntries.current.clear();
                    selection.clear();
                    resultsRegion.current?.focus();
                  }}
                >
                  {t("Clear all selection")}
                </button>
              </div>
              <div className="proxy-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={mutationBlocked || !chosen.length || restoreDenied}
                  onClick={event => begin("restore", chosen, event.currentTarget)}
                >
                  {t("Restore {count} selected profiles", { count: chosen.length })}
                </button>
                <button
                  type="button"
                  className="btn trash-purge"
                  disabled={operationActive || mutationUnavailable || !chosen.length || purgeDenied}
                  aria-disabled={confirming || undefined}
                  onClick={event => begin("purge", chosen, event.currentTarget)}
                >
                  {t("Delete permanently")}
                </button>
              </div>
              {chosen.length < chosenState.ids.length && (
                <p className="tools-hint">
                  {t("Some selected records changed or are no longer in the confirmed Trash list. Select new records explicitly or clear old selections.")}{" "}
                  <button type="button" className="tlink" onClick={clearUnavailable}>
                    {t("Clear unavailable selections")}
                  </button>
                </p>
              )}
              {(restoreDenied || purgeDenied) && (
                <p className="tools-hint">{t("Some selected environments cannot be changed with the current access.")}</p>
              )}
            </div>
          )}

          {filtered.length > 0 ? (
            <>
              <div className="proxy-table-wrap">
                <table className="profile-table proxy-table trash-table">
                  <thead>
                    <tr>
                      <th scope="col" className="tools-checkbox">
                        <input
                          type="checkbox"
                          aria-label={t("Select this page")}
                          checked={pageSelected === paged.items.length}
                          ref={input => {
                            if (input) input.indeterminate = pageSelected > 0 && pageSelected < paged.items.length;
                          }}
                          onChange={event => choose(paged.items, event.target.checked)}
                        />
                      </th>
                      <th scope="col">{t("Profile")}</th>
                      <th scope="col" className="trash-desktop-meta">{t("Original folder")}</th>
                      <th scope="col" className="trash-desktop-meta">{t("Deleted")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.items.map(profile => {
                      const date = new Date(profile.trashedAt);
                      const dateTime = date.toISOString();
                      const day = dateFormat.format(date);
                      const time = timeFormat.format(date);
                      const group = profile.group || t("Ungrouped");
                      const name = profile.name || profile.id;
                      const stamp = entryStamp(profile);
                      const checked = isChosen(profile);
                      return (
                        <tr key={`${profile.id}-${stamp}`} data-trash-id={profile.id} data-trash-entry={stamp} className={checked ? "is-selected" : ""}>
                          <td className="tools-checkbox">
                            <input
                              type="checkbox"
                              aria-label={t("Select {name}", { name })}
                              checked={checked}
                              onChange={event => choose([profile], event.target.checked)}
                            />
                          </td>
                          <td>
                            <strong>{name}</strong>
                            <small className="tools-mono">{profile.id}</small>
                            <div className="trash-mobile-meta">
                              <span><span className="sr-only">{t("Original folder")} </span>{group}</span>
                              <time dateTime={dateTime}><span className="sr-only">{t("Deleted")} </span>{day} {time}</time>
                            </div>
                          </td>
                          <td className="trash-desktop-meta"><span className="tools-folder-tag">{group}</span></td>
                          <td className="trash-desktop-meta"><time dateTime={dateTime} title={date.toLocaleString(language)}>{day}<small>{time}</small></time></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="proxy-pager">
                <span>
                  {t("{from}–{to} of {total}", {
                    from: paged.page * 50 + 1,
                    to: Math.min((paged.page + 1) * 50, filtered.length),
                    total: filtered.length,
                  })}
                </span>
                <button type="button" className="btn" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>
                  {t("Previous")}
                </button>
                <span>{paged.page + 1} / {paged.pages}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={paged.page + 1 >= paged.pages}
                  onClick={() => setPage(paged.page + 1)}
                >
                  {t("Next")}
                </button>
              </div>
            </>
          ) : (
            <div className="tools-empty" data-trash-empty-state={emptyState} role={emptyState === "loading" ? "status" : undefined}>
              <span className="tools-empty-symbol" aria-hidden="true"><AppIcon name={emptyState === "filter-empty" ? "search" : "trash"} /></span>
              <h3 role={emptyState === "error" || emptyState === "stale-empty" ? "alert" : undefined}>
                {t(
                  emptyState === "error"
                    ? "Trash could not be loaded"
                    : emptyState === "loading"
                      ? "Loading Trash…"
                      : emptyState === "empty"
                        ? "Trash is empty"
                        : emptyState === "stale-empty"
                          ? "The last confirmed Trash list was empty"
                          : "No matching profiles",
                )}
              </h3>
              {emptyState === "filter-empty" && <p>{t("Try another folder or search term.")}</p>}
              {emptyState === "filter-empty" && (
                <button type="button" className="btn ghost" onClick={resetFilters}>
                  {t("Reset Trash filters")}
                </button>
              )}
              {(emptyState === "error" || emptyState === "stale-empty") && (
                <button type="button" className="btn ghost" disabled={busy || loading} onClick={retryRead}>
                  {t("Retry reading Trash")}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

    </div>
  );
}
