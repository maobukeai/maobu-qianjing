import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "./i18n.tsx";
import { folderScope, type FolderInfo } from "../folders.ts";
import type { TrashProfileView } from "../proxy-tools-types.ts";
import { proxyResultPage } from "./proxies.tsx";
import { createTrashReader, createTrashSelection, createTrashTask, TRASH_FAILURE_REASONS, type TrashAction, type TrashTaskSnapshot } from "./trash-task.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationCoordinator, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { MotionPresence } from "./desktop-motion.tsx";
import "./trash.css";

export function filterTrash(profiles: readonly TrashProfileView[], groups: string[] | null, search: string): TrashProfileView[] {
  const query = search.trim().toLowerCase();
  return profiles.filter(
    profile =>
      (groups === null || groups.includes(profile.group))
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
  onRetry,
  onDismiss,
  onRefresh,
}: {
  snapshot: TrashTaskSnapshot;
  busy: boolean;
  active: boolean;
  retryBlocked: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
}) {
  const { t, language } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(true);
  const [requestedPage, setPage] = useState(0);
  const expand = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<HTMLButtonElement | null>(null);
  const receipt = snapshot.receipt;
  const action = snapshot.attempt?.action ?? receipt?.action;

  useEffect(() => {
    setPage(0);
  }, [receipt?.operationId, attentionOnly]);

  useEffect(() => {
    if (busy || !retryOrigin.current || !active) return;
    const origin = retryOrigin.current;
    retryOrigin.current = null;
    const doc = origin.ownerDocument;
    if (doc.activeElement === doc.body || doc.activeElement === origin) {
      expand.current?.focus({ preventScroll: true });
    }
  }, [busy, receipt, active]);

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
            : action === "purge"
              ? "Permanent deletion confirmed"
              : "Restore confirmed";

  return (
    <MotionPresence present={!!receipt || busy || !!snapshot.blockedReason} kind="panel">
      {() => (
        <section className="trash-task-panel" aria-labelledby={`${id}-title`} aria-busy={busy}>
          <header>
            <div>
              <h3 id={`${id}-title`} data-trash-task-title tabIndex={-1}>{t(headline)}</h3>
              {snapshot.attempt && snapshot.phase !== "confirming" && (
                <p>
                  {t("Latest attempt: {count} IDs · {action}", {
                    count: snapshot.attempt.ids.length,
                    action: t(snapshot.attempt.action === "purge" ? "Permanent deletion" : "Restore"),
                  })}
                </p>
              )}
            </div>
            <div>
              <button
                ref={expand}
                className="btn xs ghost"
                type="button"
                aria-expanded={expanded}
                aria-controls={`${id}-details`}
                onClick={() => setExpanded(value => !value)}
              >
                {t(expanded ? "Hide Trash operation details" : "View Trash operation details")}
              </button>
              <button
                type="button"
                className="iconbtn"
                disabled={busy}
                aria-label={t("Dismiss Trash operation result")}
                onClick={onDismiss}
              >
                ×
              </button>
            </div>
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
                <span>
                  <strong>{receipt.succeededIds.length.toLocaleString(language)}</strong>
                  {t(receipt.action === "purge" ? "Permanently deleted" : "Restored")}
                </span>
                <span>
                  <strong>{receipt.failedIds.length.toLocaleString(language)}</strong>
                  {t("Not completed")}
                </span>
                <span>
                  <strong>{receipt.unconfirmedIds.length.toLocaleString(language)}</strong>
                  {t("Needs confirmation")}
                </span>
              </div>

              {receipt.status === "unconfirmed" && (
                <p className="trash-task-warning" role="alert">
                  {t("Some environments may already have changed. Refresh Trash before starting another operation. Unknown items will not be sent again automatically.")}
                </p>
              )}

              {receipt.refreshFailed && (
                <p className="trash-task-warning" role="alert">
                  {t("The operation response is preserved, but one or more lists could not refresh. A failed refresh does not undo confirmed restores or deletions.")}
                </p>
              )}

              <div id={`${id}-details`} hidden={!expanded}>
                <div className="trash-task-filters">
                  <button
                    type="button"
                    className="btn xs ghost"
                    aria-pressed={attentionOnly}
                    onClick={() => setAttentionOnly(true)}
                  >
                    {t("Items needing review")}
                  </button>
                  <button
                    type="button"
                    className="btn xs ghost"
                    aria-pressed={!attentionOnly}
                    onClick={() => setAttentionOnly(false)}
                  >
                    {t("All operation items")}
                  </button>
                </div>

                <div className="trash-task-list" tabIndex={0} aria-label={t("Trash operation items")}>
                  <ul>
                    {filtered.slice(page * 50, (page + 1) * 50).map(row => (
                      <li key={row.id} data-trash-result-id={row.id}>
                        <div>
                          <code>{row.id}</code>
                          <span>{t(ROW_LABELS[row.status])}</span>
                        </div>
                        {row.reason && <p>{t(TRASH_FAILURE_REASONS[row.reason])}</p>}
                        <small>{t("Attempt {count}", { count: row.attempts })}</small>
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

                <p className="trash-task-privacy">
                  {t("Results contain only environment IDs, fixed reasons and counts. Original account data, paths and raw service errors are excluded.")}
                </p>
              </div>

              {receipt.retryIds.length > 0 && (
                <div className="trash-task-actions">
                  <button
                    className={`btn xs${receipt.action === "purge" ? " trash-purge" : ""}`}
                    type="button"
                    disabled={busy || retryBlocked}
                    onClick={event => {
                      retryOrigin.current = event.currentTarget;
                      onRetry();
                    }}
                  >
                    {t(
                      receipt.action === "purge"
                        ? "Review and retry deleting {count} failed items"
                        : "Retry restoring {count} failed items",
                      { count: receipt.retryIds.length },
                    )}
                  </button>
                  <p>{t("Only original failed IDs are retried. Changed or missing Trash records must be selected again; successful IDs are excluded.")}</p>
                </div>
              )}

              {(receipt.refreshFailed || receipt.status === "unconfirmed") && (
                <div className="trash-task-actions">
                  <button type="button" className="btn xs ghost" disabled={busy} onClick={onRefresh}>
                    {t("Refresh Trash without repeating the operation")}
                  </button>
                </div>
              )}
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
  const latest = useRef({ workspace, onChanged, t, onTaskSnapshotChange });
  latest.current = { workspace, onChanged, t, onTaskSnapshotChange };

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
    confirmPurge: approval => window.confirm(
      latest.current.t("Permanently delete {count} profiles and their saved data? This cannot be undone.", {
        count: approval.count,
      }),
    ),
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

  const [folders, setFolders] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [confirmedGone, setConfirmedGone] = useState<ReadonlyMap<string, string>>(new Map());

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

  const filtered = filterTrash(profiles, folders.length ? folders : null, search);
  const folderProfiles = filterTrash(profiles, folders, "");
  const paged = proxyResultPage(filtered, page);
  const chosen = profiles.filter(isChosen);
  const scopes = new Map(folderTree.map(folder => [folder.name, folderScope(folderTree, folder.name)]));
  const groups = [
    ...new Set([
      ...profiles.map(profile => profile.group),
      ...folderTree
        .filter(folder => profiles.some(profile => scopes.get(folder.name)!.has(profile.group)))
        .map(folder => folder.name),
    ]),
  ].sort();

  const visibleSelection = selection.visibleSummary(filtered.filter(isChosen).map(profile => profile.id));
  const pageSelected = paged.items.filter(isChosen).length;
  const allResultsSelected = filtered.length > 0 && filtered.every(isChosen);
  const busy = operation.phase === "confirming" || operation.phase === "sending" || operation.phase === "refreshing";
  const loading = read.phase === "loading";
  const externalBlock = !!workspace?.snapshot.blocked && workspace.snapshot.operation?.kind !== "profile-trash";
  const mutationBlocked = busy || externalBlock || !read.loaded || read.stale || loading;
  const restoreDenied = chosen.some(profile => !profile.canRestore);
  const purgeDenied = chosen.some(profile => !profile.canPurge);

  const refresh = () => {
    if (!task.isBusy()) void reader.load();
  };

  const begin = (action: TrashAction, targets: readonly TrashProfileView[]) => {
    if (task.isBusy() || mutationBlocked || !targets.length) return;
    for (const profile of targets) originEntries.current.set(profile.id, entryStamp(profile));
    void task.submit(action, targets.map(profile => profile.id));
  };

  const clearUnavailable = () => {
    const available = new Set(chosen.map(profile => profile.id));
    const missing = chosenState.ids.filter(id => !available.has(id));
    for (const id of missing) selectedEntries.current.delete(id);
    selection.set(missing, false);
  };

  const changeFolders = (next: string[]) => {
    setFolders(next);
    setPage(0);
  };

  const resetFilters = () => {
    setSearch("");
    setFolders([]);
    setPage(0);
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
      <header className="tools-intro page-heading">
        <div>
          <h2 className="sect-title" id="trash-page-title" tabIndex={-1}>{t("Trash")}</h2>
          <p className="page-subtitle">
            {t("Restore profiles with their saved identity and session, right back to their original folders.")}
          </p>
        </div>
        <span className="tools-count">
          <strong>{profiles.length.toLocaleString(language)}</strong> {t("profiles in Trash")}
          {read.loadedAt && (
            <small>
              {t("Last read {time}", {
                time: new Date(read.loadedAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
              })}
            </small>
          )}
        </span>
      </header>

      {read.error && (
        <div className="tools-alert" role="alert">
          {t(read.error)}
          {read.loaded && <span> {t("The previous list is shown until a new read succeeds.")}</span>}
          <button className="btn xs ghost" type="button" disabled={busy || loading} onClick={refresh}>
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
        onRetry={() => { void task.retryFailed(); }}
        onDismiss={() => { task.dismiss(); }}
        onRefresh={refresh}
      />

      <div className="trash-layout">
        <aside className="tools-panel trash-folders" aria-label={t("Trash folders")}>
          <div className="tools-panel-head">
            <h3>{t("Restore by folder")}</h3>
            <span>{groups.length}</span>
          </div>
          <p className="tools-hint">
            {t("Folder restoration includes the entire selected branch, including items hidden by search.")}
          </p>
          <button
            type="button"
            className={`folder-all${!folders.length ? " selected" : ""}`}
            onClick={() => changeFolders([])}
          >
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
                <small>
                  {profiles
                    .filter(profile => profile.group === name || scopes.get(name)?.has(profile.group))
                    .length.toLocaleString(language)}
                </small>
              </label>
            ))}
            {!groups.length && <p className="tools-hint">{t("Deleted folders appear here.")}</p>}
          </div>
          <div className="trash-folder-action">
            <button
              type="button"
              className="btn primary"
              disabled={mutationBlocked || !folderProfiles.length || folderProfiles.some(profile => !profile.canRestore)}
              onClick={() => begin("restore", folderProfiles)}
            >
              {folders.length
                ? t("Restore all {count} in folder scope", { count: folderProfiles.length })
                : t("Restore selected folders")}
            </button>
            <p className="tools-hint">
              {folders.length
                ? t("Whole folder scope: {total} · Visible now: {visible} · Hidden by search: {hidden}", {
                    total: folderProfiles.length,
                    visible: filtered.length,
                    hidden: folderProfiles.length - filtered.length,
                  })
                : t("Select one or more folders above.")}
            </p>
          </div>
        </aside>

        <section className="tools-panel trash-results" aria-label={t("Deleted profiles")}>
          <div className="tools-panel-head">
            <div>
              <h3>{folders.length ? t("Selected folders") : t("All deleted profiles")}</h3>
              <p>{t("{count} matching profiles", { count: filtered.length })}</p>
            </div>
            <button type="button" className="btn ghost" disabled={busy || loading} onClick={refresh}>
              {loading ? t("Loading…") : t("Refresh")}
            </button>
          </div>

          <div className="trash-search">
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
            <button
              type="button"
              className="btn"
              disabled={!filtered.length}
              onClick={() => choose(filtered, !allResultsSelected)}
            >
              {t(
                allResultsSelected ? "Unselect {count} matching results" : "Select all {count} results",
                { count: filtered.length },
              )}
            </button>
            {(search || folders.length > 0) && (
              <button type="button" className="btn ghost" onClick={resetFilters}>
                {t("Reset Trash filters")}
              </button>
            )}
          </div>

          {chosenState.ids.length > 0 && (
            <div className="trash-selection">
              <div className="trash-selection-scope">
                <strong>{t("{count} selected in total", { count: visibleSelection.total })}</strong>
                <span>
                  {t("Matching current filters {visible} · Hidden by filters {hidden}", {
                    visible: visibleSelection.visible,
                    hidden: visibleSelection.hidden,
                  })}
                </span>
                <button
                  type="button"
                  className="tlink"
                  onClick={() => {
                    selectedEntries.current.clear();
                    selection.clear();
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
                  onClick={() => begin("restore", chosen)}
                >
                  {t("Restore {count} selected profiles", { count: chosen.length })}
                </button>
                <button
                  type="button"
                  className="btn ghost trash-purge"
                  disabled={mutationBlocked || !chosen.length || purgeDenied}
                  onClick={() => begin("purge", chosen)}
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
                      <th className="tools-checkbox">
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
                      <th>{t("Profile")}</th>
                      <th>{t("Original folder")}</th>
                      <th>{t("Deleted")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.items.map(profile => (
                      <tr
                        key={`${profile.id}-${entryStamp(profile)}`}
                        data-trash-id={profile.id}
                        data-trash-entry={entryStamp(profile)}
                        className={isChosen(profile) ? "is-selected" : ""}
                      >
                        <td className="tools-checkbox">
                          <input
                            type="checkbox"
                            aria-label={t("Select {name}", { name: profile.name || profile.id })}
                            checked={isChosen(profile)}
                            onChange={event => choose([profile], event.target.checked)}
                          />
                        </td>
                        <td>
                          <strong>{profile.name || profile.id}</strong>
                          <small className="tools-mono">{profile.id}</small>
                        </td>
                        <td>
                          <span className="tools-folder-tag">{profile.group || t("Ungrouped")}</span>
                        </td>
                        <td>
                          <time
                            dateTime={new Date(profile.trashedAt).toISOString()}
                            title={new Date(profile.trashedAt).toLocaleString(language)}
                          >
                            {new Date(profile.trashedAt).toLocaleDateString(language, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </time>
                          <small>
                            {new Date(profile.trashedAt).toLocaleTimeString(language, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </small>
                        </td>
                      </tr>
                    ))}
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
            <div className="tools-empty" data-trash-empty-state={emptyState}>
              <span className="tools-empty-symbol" aria-hidden="true">↶</span>
              <h3>
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
              <p>
                {t(
                  emptyState === "error" || emptyState === "stale-empty"
                    ? "Refresh the list before treating it as the current Trash state."
                    : emptyState === "loading"
                      ? "Reading local Trash metadata…"
                      : emptyState === "filter-empty"
                        ? "Try another folder or search term. Your selection is preserved."
                        : "Profiles you move to Trash will appear here. You can restore them at any time.",
                )}
              </p>
              {emptyState === "filter-empty" && (
                <button type="button" className="btn ghost" onClick={resetFilters}>
                  {t("Reset Trash filters")}
                </button>
              )}
              {(emptyState === "error" || emptyState === "stale-empty") && (
                <button type="button" className="btn ghost" disabled={busy || loading} onClick={refresh}>
                  {t("Retry reading Trash")}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <p className="tools-footnote">
        {t("Restoring keeps saved profile data. Permanent deletion removes it and cannot be undone.")}
      </p>
    </div>
  );
}
