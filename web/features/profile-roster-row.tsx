import * as React from "react";
import type { RosterScope } from "../../profile-view-state.ts";
import { closeProfile, openProfile, raiseProfile, restartProfile, type UiProfile } from "../api.ts";
import type { InspectionEditField } from "../environment-inspection.tsx";
import { FingerprintImportBadge } from "../fingerprint-import-badge.tsx";
import type { ColumnKey } from "../hooks/use-roster-query.ts";
import { InlineProfileNameEditor, QuickProfileNotesEditor } from "../inline-profile-editors.tsx";
import { ProfileActionMenu } from "../profile-action-menu.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import { browserLabel, launchRecovery, PlatformPill, StatusDot } from "./profile-form-helpers.tsx";

const Icon = AppIcon;

export interface ProfileRosterRowHandlers {
  openDetails: (id: string, trigger?: HTMLButtonElement | null) => void;
  openEdit: (id: string, field?: InspectionEditField, trigger?: HTMLButtonElement) => void;
  openPendingCookies: (profile: UiProfile) => Promise<void>;
  openCookie: (targets: UiProfile[]) => void;
  act: (id: string, fn: (id: string) => Promise<any>) => Promise<void>;
  openInspection: (id: string) => void;
  reuseProfileConfiguration: (id: string, name: string) => Promise<void>;
  openProfileTags: (profile: UiProfile) => void;
  copy2fa: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  changeProfileSelection: (id: string, event: React.ChangeEvent<HTMLInputElement>) => void;
  setLaunchFailure: (id: string, message: string | null) => void;
  openNetworkSettings: () => void;
  openLogs: () => void;
  trimMemory?: (id: string) => Promise<void>;
  hibernateProfile?: (id: string) => Promise<void>;
  deleteProfile?: (profile: UiProfile) => Promise<void>;
}

export interface ProfileRosterRowProps {
  p: UiProfile;
  no: { value: string; custom: boolean };
  isSelected: boolean;
  isBusy: boolean;
  isFavorite: boolean;
  isReuseLoading: boolean;
  twoFaFlashed: boolean;
  startLabel: string;
  launchFailure: string | undefined;
  rosterScope: RosterScope;
  language: string;
  hiddenCols: ReadonlySet<ColumnKey>;
  viewPreferencesReady: boolean;
  viewPreferenceBusy: boolean;
  rangeKeyboardActivation: React.MutableRefObject<{ id: string; shiftKey: boolean } | null>;
  handlers: ProfileRosterRowHandlers;
  t: (source: string, values?: Record<string, string | number>) => string;
  /** Attached by useVirtualList for shared ResizeObserver dynamic measurement. */
  rowRef?: React.Ref<HTMLTableRowElement>;
  /** Flat virtual item key used by keyboard roving focus and pinned keep-alive tracking. */
  flatKey?: string;
  /** 1-based ARIA row index for virtualized tables. */
  ariaRowIndex?: number;
  /** Optional Wave 3 resource telemetry chips slot (e.g. RSS / CPU / memory saver badge). */
  resourceChips?: React.ReactNode;
  /** Optional Wave 4 inline-rename props (pinned automatically by ProfileRosterTable). */
  editingName?: boolean;
  inlineRenameDraft?: string;
  onStartInlineRename?: (id: string) => void;
  onChangeInlineRename?: (value: string) => void;
  onCommitInlineRename?: (id: string) => void;
  onCancelInlineRename?: () => void;
  /** Optional Wave 4 self-contained inline name & quick notes editors. */
  onSaveInlineName?: (id: string, nextName: string) => Promise<void>;
  onInlineNameSaved?: (id: string, nextName: string) => void;
  onInlineNameEditingChange?: (id: string, editing: boolean) => void;
  onSaveQuickNotes?: (id: string, nextNotes: string) => Promise<void>;
  onQuickNotesSaved?: (id: string, nextNotes: string) => void;
  onQuickNotesOpenChange?: (id: string, open: boolean) => void;
  onInlineEditorError?: (message: string) => void;
}

export const ProfileRosterRow = React.memo(function ProfileRosterRow({
  p,
  no,
  isSelected,
  isBusy,
  isFavorite,
  isReuseLoading,
  twoFaFlashed,
  startLabel,
  launchFailure,
  rosterScope,
  language,
  hiddenCols,
  viewPreferencesReady,
  viewPreferenceBusy,
  rangeKeyboardActivation,
  handlers,
  t,
  rowRef,
  flatKey,
  ariaRowIndex,
  resourceChips,
  editingName = false,
  inlineRenameDraft,
  onStartInlineRename,
  onChangeInlineRename,
  onCommitInlineRename,
  onCancelInlineRename,
  onSaveInlineName,
  onInlineNameSaved,
  onInlineNameEditingChange,
  onSaveQuickNotes,
  onQuickNotesSaved,
  onQuickNotesOpenChange,
  onInlineEditorError,
}: ProfileRosterRowProps) {
  const {
    openDetails,
    openEdit,
    openPendingCookies,
    openCookie,
    act,
    openInspection,
    reuseProfileConfiguration,
    openProfileTags,
    copy2fa,
    toggleFavorite,
    changeProfileSelection,
  } = handlers;
  const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
  const openLabel = (_profile: UiProfile) => startLabel;
  // live through the local cache. Only rows locked by ANOTHER
  // session stay read-only — that writer owns the profile.
  const canEditRow = true;
  const recovery = launchFailure ? launchRecovery(launchFailure) : null;
  const failureId = launchFailure ? `profile-launch-failure-${p.id}` : undefined;

  return (
    <tr
      ref={rowRef}
      data-profile-id={p.id}
      data-flat-key={flatKey}
      aria-rowindex={ariaRowIndex}
      className={`${p.running ? "running" : ""}${isSelected ? " selected" : ""}`}
    >
      <td className="chk">
        <input
          type="checkbox"
          aria-label={t("Select {profile}", { profile: p.name })}
          aria-describedby="profile-range-selection-hint"
          title={t("Shift-click to select a range")}
          checked={isSelected}
          onPointerDown={() => { rangeKeyboardActivation.current = null; }}
          onKeyDown={(event) => { rangeKeyboardActivation.current = event.key === " " ? { id: p.id, shiftKey: event.shiftKey } : null; }}
          onBlur={() => { rangeKeyboardActivation.current = null; }}
          onChange={(event) => changeProfileSelection(p.id, event)}
        />
      </td>
      {columnVisible("no") && (
        <td className="col-no">
          <span className={`no-text${no.custom ? " custom" : ""}`} title={`${no.custom ? t("Custom NO.") : t("Serial")} ${no.value}`}>{no.value}</span>
        </td>
      )}
      {columnVisible("name") && (
        <td className="col-name" title={`${p.name}\n${p.id}`}>
          <span className="name-cell">
            <span className="profile-name-primary">
              <span className="profile-name-line">
                <button
                  type="button"
                  className={`profile-favorite${isFavorite ? " is-favorite" : ""}`}
                  aria-pressed={isFavorite}
                  aria-label={t(isFavorite ? "Remove {profile} from favorites" : "Add {profile} to favorites", { profile: p.name })}
                  title={t(isFavorite ? "Remove from favorites" : "Add to favorites")}
                  disabled={!viewPreferencesReady || viewPreferenceBusy}
                  onClick={() => void toggleFavorite(p.id)}
                >
                  <Icon name="star" />
                </button>
                {onInlineNameSaved || onSaveInlineName ? (
                  <InlineProfileNameEditor
                    profileId={p.id}
                    name={p.name}
                    disabled={isBusy}
                    badge={<FingerprintImportBadge p={p} />}
                    onOpenEdit={openEdit}
                    onSaveName={onSaveInlineName}
                    onSaved={onInlineNameSaved}
                    onError={onInlineEditorError}
                    onEditingChange={(editing) => onInlineNameEditingChange?.(p.id, editing)}
                  />
                ) : editingName ? (
                  <input
                    type="text"
                    autoFocus
                    className="profile-inline-rename-input"
                    aria-label={t("Rename {profile}", { profile: p.name })}
                    value={inlineRenameDraft ?? p.name}
                    onChange={(event) => onChangeInlineRename?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onCommitInlineRename?.(p.id);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        onCancelInlineRename?.();
                      }
                    }}
                    onBlur={() => onCommitInlineRename?.(p.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="n profile-name-button"
                    disabled={isBusy}
                    aria-label={t("Edit {profile}", { profile: p.name })} onClick={() => openEdit(p.id)}
                    onDoubleClick={onStartInlineRename ? (event) => { event.preventDefault(); onStartInlineRename(p.id); } : undefined}
                  >
                    <span className="profile-name-text">{p.name}</span>
                    <FingerprintImportBadge p={p} />
                  </button>
                )}
              </span>
              <span className="sub">
                <span className="profile-serial" title={p.id}>#{no.value}</span>
                {rosterScope === "recent" && <span>{p.group || t("Ungrouped")}</span>}
                {rosterScope === "recent" && !!p.lastOpenAt && (
                  <time dateTime={new Date(p.lastOpenAt).toISOString()} title={new Date(p.lastOpenAt).toLocaleString(language)}>
                    {t("Last launch · {time}", { time: new Date(p.lastOpenAt).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}
                  </time>
                )}
                <span className="profile-engine-chip" title={p.engine === "firefox" ? "Native Firefox profile · no CDP, PDF, or Chrome extensions" : `${browserLabel(p.engine, p.chromiumRuntime)} · CDP, PDF, and Chrome extensions`}>
                  {browserLabel(p.engine, p.chromiumRuntime)}
                </span>
                {resourceChips}
                {(onQuickNotesSaved || onSaveQuickNotes) && (
                  <QuickProfileNotesEditor
                    profileId={p.id}
                    profileName={p.name}
                    notes={p.notes ?? ""}
                    disabled={isBusy}
                    variant="inline"
                    onSaveNotes={onSaveQuickNotes}
                    onSaved={onQuickNotesSaved}
                    onError={onInlineEditorError}
                    onOpenChange={(open) => onQuickNotesOpenChange?.(p.id, open)}
                  />
                )}
              </span>
            </span>
            {p.tags.length > 0 && (
              <button type="button" className="profile-tags-preview" aria-label={t("Manage tags for {profile}", { profile: p.name })} disabled={isBusy} onClick={() => openProfileTags(p)}>
                {p.tags.slice(0, 2).map((tag) => <span key={tag} title={tag}>{tag}</span>)}
                {p.tags.length > 2 && <small>+{p.tags.length - 2}</small>}
              </button>
            )}
            {(p.restartPending || !!p.pendingCookieCount) && (
              <span className="status">
                {p.restartPending && (
                  <button
                    type="button"
                    className="status-chip warn tip"
                    data-tip={t("Saved proxy or fingerprint changes apply when this browser restarts. Click to restart it now.")}
                    aria-label={t("Restart {profile} so the saved changes apply", { profile: p.name })}
                    disabled={isBusy}
                    onClick={() => act(p.id, restartProfile)}
                  >
                    <Icon name="refresh" className="sm" />
                    {t("Applies at next start")}
                  </button>
                )}
                {!!p.pendingCookieCount && (
                  <button
                    type="button"
                    className="status-chip tip"
                    data-tip={t("The browser sets these cookies the next time it starts. Click to see or remove them.")}
                    onClick={() => void openPendingCookies(p)}
                  >
                    <Icon name="cookie" className="sm" />
                    {t("{count} cookie(s) at next start", { count: String(p.pendingCookieCount) })}
                  </button>
                )}
              </span>
            )}
          </span>
        </td>
      )}
      {columnVisible("group") && (
        <td className="col-group" title={p.group}>
          {p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}
        </td>
      )}
      {columnVisible("platform") && <td className="col-platform"><PlatformPill platform={p.platform} /></td>}
      {columnVisible("tags") && (
        <td className="col-tags" title={p.tags?.length ? p.tags.join(", ") : "No tags"}>
          {p.tags?.length ? p.tags.map((tag) => <span key={tag} className="chip">{tag}</span>) : <span className="muted">—</span>}
        </td>
      )}
      {columnVisible("proxy") && (
        <td className="col-proxy" title={p.proxyError || p.proxy || "no proxy"}>
          {p.proxyError ? (
            <span className="proxy-cell bad"><Icon name="warning" className="sm" />{t("Invalid proxy — edit to fix")}</span>
          ) : p.proxy ? (
            <span className="proxy-cell">{p.proxy}</span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      )}
      {columnVisible("status") && (
        <td className="col-status">
          <span className={`profile-status${p.running ? " running" : ""}`}>
            <StatusDot running={p.running} />
            {p.running ? t("Running") : t("Stopped")}
          </span>
        </td>
      )}
      {columnVisible("action") && (
        <td className="col-action">
          <span className="rowactions">
            <button
              type="button"
              className="iconbtn profile-details-trigger"
              aria-label={t("View details for {profile}", { profile: p.name })}
              title={t("Environment details")}
              onClick={(event) => openDetails(p.id, event.currentTarget)}
            >
              <Icon name="window" className="sm" />
            </button>
            {p.running ? (
              <button className="btn sm row-stop" aria-label={t("Stop {profile}", { profile: p.name })} disabled={isBusy} onClick={() => act(p.id, closeProfile)}>
                <Icon name="power" className="sm" />
                {t(isBusy ? "Stopping…" : "Stop")}
              </button>
            ) : p.mobilePersona ? (
              <button className="btn sm warn" disabled={isBusy} title={t("Convert this mobile persona to a desktop device")} onClick={() => openEdit(p.id)}>
                <Icon name="laptop" className="sm" />
                {t("Convert")}
              </button>
            ) : (
              <button
                className="btn sm primary row-start"
                aria-label={t(recovery === "download" ? "Retry download for {profile}" : recovery ? "Retry starting {profile}" : "Start {profile}", { profile: p.name })}
                aria-describedby={failureId}
                disabled={isBusy}
                onClick={() => void act(p.id, openProfile)}
              >
                <Icon name={recovery ? "refresh" : "play"} className="sm" />
                {openLabel(p)}
              </button>
            )}
            <ProfileActionMenu label={t("Actions for {profile}", { profile: p.name })} icon={<Icon name="more" className="sm" />}>
              <button role="menuitem" className="pop-item" onClick={() => openInspection(p.id)}><Icon name="activity" className="sm" />{t("Inspect network & fingerprint")}</button>
              {canEditRow && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => openEdit(p.id)}><Icon name="edit" className="sm" />{t("Edit profile")}</button>}
              {canEditRow && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => openProfileTags(p)}><Icon name="hash" className="sm" />{t("Manage tags")}</button>}
              <button role="menuitem" className="pop-item" disabled={isReuseLoading} onClick={() => void reuseProfileConfiguration(p.id, p.name)}><Icon name="copy" className="sm" />{t("Create from this configuration")}</button>
              {canEditRow && <button role="menuitem" className="pop-item" onClick={() => openCookie([p])}><Icon name="cookie" className="sm" />{t("Add cookies")}</button>}
              {p.has2fa && <button role="menuitem" className="pop-item" onClick={() => copy2fa(p.id)}><Icon name={twoFaFlashed ? "check" : "key"} className="sm" />{twoFaFlashed ? t("Copied") : t("Copy current 2FA code")}</button>}
              {p.running && p.engine === "chromium" && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => act(p.id, raiseProfile)}><Icon name="raise" className="sm" />{t("Bring to front")}</button>}
              {p.running && handlers.trimMemory && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => void handlers.trimMemory!(p.id)}><Icon name="activity" className="sm" />{t("Trim memory")}</button>}
              {p.running && handlers.hibernateProfile && <button role="menuitem" className="pop-item" disabled={isBusy} onClick={() => void handlers.hibernateProfile!(p.id)}><Icon name="moon" className="sm" />{t("Save session & hibernate")}</button>}
              {handlers.deleteProfile && (
                <>
                  <div className="pop-sep" role="separator" />
                  <button
                    role="menuitem"
                    className="pop-item danger"
                    disabled={isBusy || p.running}
                    title={p.running ? t("Stop this environment before deleting it.") : undefined}
                    onClick={() => void handlers.deleteProfile!(p)}
                  >
                    <Icon name="trash" className="sm" />
                    {t("Delete environment")}
                  </button>
                </>
              )}
            </ProfileActionMenu>
          </span>
        </td>
      )}
    </tr>
  );
});

export interface ProfileLaunchFailureRowProps {
  p: UiProfile;
  message: string;
  visibleColumnCount: number;
  isBusy: boolean;
  handlers: Pick<ProfileRosterRowHandlers, "openEdit" | "openNetworkSettings" | "openLogs" | "setLaunchFailure">;
  t: (source: string, values?: Record<string, string | number>) => string;
  rowRef?: React.Ref<HTMLTableRowElement>;
  flatKey?: string;
  ariaRowIndex?: number;
}

export const ProfileLaunchFailureRow = React.memo(function ProfileLaunchFailureRow({
  p,
  message,
  visibleColumnCount,
  isBusy,
  handlers,
  t,
  rowRef,
  flatKey,
  ariaRowIndex,
}: ProfileLaunchFailureRowProps) {
  const recovery = launchRecovery(message);
  const failureId = `profile-launch-failure-${p.id}`;
  return (
    <tr ref={rowRef} data-flat-key={flatKey} aria-rowindex={ariaRowIndex} className="profile-launch-feedback">
      <td colSpan={visibleColumnCount}>
        <div className="profile-launch-notice">
          <Icon name="warning" className="sm" />
          <div className="profile-launch-detail">
            <p id={failureId} role="alert">
              <strong>{t(recovery === "download" ? "Browser download failed" : "Browser start failed")}</strong> {t(message)}
            </p>
            {recovery === "proxy" && (
              <button type="button" className="btn xs ghost" disabled={isBusy} onClick={(event) => handlers.openEdit(p.id, "proxy", event.currentTarget)}>
                {t("Review proxy settings")}
              </button>
            )}
            {recovery === "network" && (
              <button type="button" className="btn xs ghost" onClick={handlers.openNetworkSettings}>
                {t("Network & proxies")}
              </button>
            )}
            {recovery === "logs" && (
              <button type="button" className="btn xs ghost" onClick={handlers.openLogs}>
                {t("View logs")}
              </button>
            )}
          </div>
          <button
            type="button"
            className="iconbtn profile-launch-dismiss"
            aria-label={t("Dismiss start failure for {profile}", { profile: p.name })}
            onClick={(event) => {
              event.currentTarget.closest("tr")?.previousElementSibling?.querySelector<HTMLButtonElement>(".row-start")?.focus({ preventScroll: true });
              handlers.setLaunchFailure(p.id, null);
            }}
          >
            <Icon name="close" className="sm" />
          </button>
        </div>
      </td>
    </tr>
  );
});
