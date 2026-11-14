import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isSafeProfileId } from "../profile-id.ts";
import { MAX_SINGLE_PROXY_ASSIGNMENT_IDS, SingleProxyPreviewInputError, validateSingleProxyCredentials, type SingleProxyPreviewInput } from "../proxy-single-preview.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useTranslation } from "./i18n.tsx";
import type { LocalProxyDraftCandidate } from "./settings-center.tsx";
import "./local-proxy-assignment-draft.css";

export interface LocalProxyAssignmentIntent {
  requestId: number;
  workspaceId: string;
  candidate: LocalProxyDraftCandidate;
}

export interface LocalProxyAssignmentProfile {
  id: string;
  name: string;
  group: string;
  running: boolean;
}

export interface LocalProxyAssignmentDraftProps {
  candidate: LocalProxyDraftCandidate;
  profiles?: readonly LocalProxyAssignmentProfile[];
  active: boolean;
  loading?: boolean;
  disabled?: boolean;
  hasPreviousReview?: boolean;
  onPreview: (input: SingleProxyPreviewInput) => Promise<boolean>;
  onDismiss: () => void;
}

const PAGE_SIZE = 24;

export function localProxyAssignmentEndpoint(proxy: Pick<SingleProxyPreviewInput["proxy"], "type" | "host" | "port">): string {
  const address = proxy.host === "::1" ? "[::1]" : proxy.host;
  return `${proxy.type}://${address}:${proxy.port}`;
}

/** Each handoff mounts a fresh draft. Credentials stay here until an explicit preview request. */
export function LocalProxyAssignmentDraft({ candidate, profiles, active, loading, disabled, hasPreviousReview, onPreview, onDismiss }: LocalProxyAssignmentDraftProps) {
  const { t, language } = useTranslation();
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmReview, setConfirmReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useDesktopCloseDraft("proxy-assignment-draft", { dirty: selected.size > 0 || username.length > 0 || password.length > 0, busy: false });
  const submitting = useRef(false);
  const mounted = useRef(false);
  const focused = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const keepReviewButton = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const restorePreviewFocus = useRef(false);
  const id = useId();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (!active || focused.current) return;
    focused.current = true;
    title.current?.focus({ preventScroll: true });
    title.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  useLayoutEffect(() => {
    if (active && confirmReview) keepReviewButton.current?.focus({ preventScroll: true });
    if (active && !confirmReview && restorePreviewFocus.current) {
      restorePreviewFocus.current = false;
      previewButton.current?.focus({ preventScroll: true });
    }
  }, [active, confirmReview]);

  const roster = useMemo(() => {
    const byId = new Map<string, LocalProxyAssignmentProfile>();
    for (const profile of profiles ?? []) if (isSafeProfileId(profile.id) && !byId.has(profile.id)) byId.set(profile.id, profile);
    return byId;
  }, [profiles]);
  const eligible = useMemo(() => [...selected].filter(profileId => roster.has(profileId)), [selected, roster]);
  const missing = selected.size - eligible.length;
  const running = eligible.filter(profileId => roster.get(profileId)?.running).length;
  const atSelectionLimit = selected.size >= MAX_SINGLE_PROXY_ASSIGNMENT_IDS;
  const ungrouped = t("Ungrouped");
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(language);
    return [...roster.values()].filter(profile => (!onlySelected || selected.has(profile.id)) && (
      !needle || [profile.name, profile.id, profile.group || ungrouped].some(value => value.toLocaleLowerCase(language).includes(needle))
    ));
  }, [query, language, onlySelected, selected, roster, ungrouped]);
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const requiresAuthentication = candidate.type === "socks5" && candidate.socks5AuthRequired;
  const endpoint = localProxyAssignmentEndpoint(candidate);
  const validEndpoint = (candidate.type === "http" || candidate.type === "socks5") && (candidate.host === "127.0.0.1" || candidate.host === "::1")
    && Number.isInteger(candidate.port) && candidate.port >= 1 && candidate.port <= 65535;

  let credentials: { user: string; pass: string } | null = null;
  let credentialIssue: string | null = null;
  try { credentials = validateSingleProxyCredentials(candidate.type, username, password, requiresAuthentication); }
  catch (error) { credentialIssue = error instanceof SingleProxyPreviewInputError ? error.message : "The proxy credentials are not valid."; }

  const locked = !!(disabled || loading || pending);
  const canPreview = active && !locked && validEndpoint && eligible.length > 0 && missing === 0 && credentials !== null;
  const resetReviewPrompt = () => { setConfirmReview(false); setFailed(false); };

  function toggle(profileId: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(profileId)) next.delete(profileId);
      else if (next.size < MAX_SINGLE_PROXY_ASSIGNMENT_IDS) next.add(profileId);
      return next;
    });
    resetReviewPrompt();
  }

  async function preview(replaceReview = false) {
    if (!canPreview || !credentials || submitting.current) return;
    if (hasPreviousReview && !replaceReview) { setConfirmReview(true); return; }
    const input: SingleProxyPreviewInput = {
      mode: "single",
      scope: { ids: eligible },
      proxy: { type: candidate.type, host: candidate.host, port: candidate.port, ...credentials },
      ...(requiresAuthentication ? { requiresAuthentication: true } : {}),
    };
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      const accepted = await onPreview(input);
      if (!mounted.current) return;
      if (accepted) { setPassword(""); setUsername(""); }
      else setFailed(true);
    } catch { if (mounted.current) setFailed(true); }
    finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return <section className="tools-panel local-proxy-assignment" aria-labelledby={`${id}-title`}>
    <header className="tools-panel-head">
      <div>
        <h3 id={`${id}-title`} ref={title} tabIndex={-1} data-local-proxy-draft-title>{t("Assign local proxy to existing environments")}</h3>
        <p><code className="tools-mono">{endpoint}</code></p>
      </div>
    </header>
    <div className="tools-panel-body local-proxy-assignment-body">
      <p className="tools-hint">{t("Choose the environments for this proxy, then preview the changes. Open environments will be skipped.")}</p>
      {disabled && !pending && <p className="tools-hint" role="status">{t("The current task must finish before this proxy can be previewed.")}</p>}
      {!validEndpoint && <p className="tools-alert" role="alert">{t("This local proxy endpoint is invalid. Return to Network settings and choose it again.")}</p>}
      <div className="local-proxy-assignment-toolbar">
        <label><span className="sr-only">{t("Search environments")}</span><input className="input" type="search" value={query} disabled={locked} placeholder={t("Search by name, ID or folder")} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <label className="proxy-choice"><input type="checkbox" checked={onlySelected} disabled={locked} onChange={event => { setOnlySelected(event.target.checked); setPage(0); }} />{t("Show selected only")}</label>
        <button type="button" className="btn" disabled={locked || !selected.size} onClick={() => { setSelected(new Set()); setOnlySelected(false); setPage(0); resetReviewPrompt(); }}>{t("Clear selection")}</button>
      </div>
      <p className="tools-hint local-proxy-selection-count" role="status">
        {t("{count} selected", { count: selected.size })}
        {running > 0 && <> · {t("{count} running and will be skipped", { count: running })}</>}
        {atSelectionLimit && <> · {t("Selection limit reached")}</>}
      </p>
      {missing > 0 && <div className="local-proxy-selection-warning"><p>{t("{count} selected environments are no longer available.", { count: missing })}</p>
        <button type="button" className="btn xs" disabled={locked} onClick={() => { setSelected(new Set(eligible)); resetReviewPrompt(); }}>{t("Remove unavailable selections")}</button>
      </div>}
      {loading ? <p className="tools-hint" role="status">{t("Loading environments…")}</p> : rows.length ? <ul className="local-proxy-assignment-list" aria-label={t("Environments to assign")}>
        {rows.map(profile => <li key={profile.id}><label>
          <input type="checkbox" checked={selected.has(profile.id)} disabled={locked || atSelectionLimit && !selected.has(profile.id)} onChange={() => toggle(profile.id)} />
          <span className="local-proxy-profile-name"><strong>{profile.name || profile.id}</strong><small>{profile.group || ungrouped} · {profile.id}</small></span>
          {profile.running && <span className="local-proxy-running">{t("Running")}</span>}
        </label></li>)}
      </ul> : <p className="tools-hint local-proxy-assignment-empty">{t(onlySelected ? "No selected environments match this search." : query.trim() ? "No environments match this search." : "No environments are available to select.")}</p>}
      {pageCount > 1 && <div className="proxy-pager local-proxy-assignment-pages">
        <span>{t("{total} rows", { total: matches.length.toLocaleString(language) })}</span>
        <button className="btn" type="button" disabled={locked || currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("Previous")}</button>
        <span>{t("Page {page} / {pages}", { page: currentPage + 1, pages: pageCount })}</span>
        <button className="btn" type="button" disabled={locked || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("Next")}</button>
      </div>}
      <details className="local-proxy-auth" open={requiresAuthentication || undefined}>
        <summary>{t(requiresAuthentication ? "Proxy authentication required" : "Proxy authentication (optional)")}</summary>
        <div className="local-proxy-auth-fields">
          <label className="fld"><span>{t("Proxy username")}</span><input className="input" type="text" value={username} disabled={locked} autoComplete="off" spellCheck={false} aria-invalid={!!credentialIssue || undefined} aria-describedby={credentialIssue ? `${id}-credentials` : undefined} onChange={event => { setUsername(event.target.value); resetReviewPrompt(); }} /></label>
          <label className="fld"><span>{t("Proxy password")}</span><input className="input" type="password" value={password} disabled={locked} autoComplete="new-password" spellCheck={false} aria-invalid={!!credentialIssue || undefined} aria-describedby={credentialIssue ? `${id}-credentials` : undefined} onChange={event => { setPassword(event.target.value); resetReviewPrompt(); }} /></label>
        </div>
      </details>
      {credentialIssue && <p className="proxy-input-error" id={`${id}-credentials`}>{t(credentialIssue)}</p>}
      {failed && <p className="tools-alert" role="alert">{t("The local proxy preview could not be prepared. Your selection is still available.")}</p>}
      {confirmReview && <p className="local-proxy-review-prompt" role="status">{t("A new preview replaces the current review. Your manual inputs and previous results stay available.")}</p>}
      <footer className="local-proxy-assignment-actions">
        <button type="button" className="btn" disabled={pending} onClick={onDismiss}>{t("Cancel")}</button>
        {confirmReview ? <>
          <button type="button" className="btn" ref={keepReviewButton} disabled={pending} onClick={() => { restorePreviewFocus.current = true; setConfirmReview(false); }}>{t("Keep current review")}</button>
          <button type="button" className="btn primary" disabled={!canPreview} onClick={() => void preview(true)}>{t(pending ? "Preparing preview…" : "Replace review and preview")}</button>
        </> : <button type="button" className="btn primary" ref={previewButton} disabled={!canPreview} onClick={() => void preview()}>{t(pending ? "Preparing preview…" : "Preview selected environments")}</button>}
      </footer>
    </div>
  </section>;
}
