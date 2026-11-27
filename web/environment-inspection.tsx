import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { checkProxy, fetchProfileEdit, ProxyCheckError, type ProxyCheckResult, type UiProfile } from "./api.ts";
import { fetchFingerprintReports, measureFingerprint, type FingerprintReport } from "./settings-api.ts";
import { presentFingerprintCheck, type FingerprintCheckStatus, type FingerprintTranslator } from "../src/fingerprint-check-presentation.ts";
import { parsePastedProxy } from "./proxy-input.ts";
import { proxyCheckNote } from "./proxy-check-presentation.ts";
import { ProfileTimeline } from "./profile-timeline.tsx";
import { useTranslation } from "./i18n.tsx";
import "./environment-inspection.css";

export type InspectionEditField = "proxy" | "resolution" | "timezone" | "locale" | "cores" | "fingerprintSeed";

export interface EnvironmentInspectionPageProps {
  active: boolean;
  profile: UiProfile | null;
  refreshVersion?: number;
  onBack: () => void;
  onEditProfile: (id: string, field?: InspectionEditField, trigger?: HTMLButtonElement) => void;
  onExplainFingerprint: (report: FingerprintReport) => void;
  onOpenLogs?: () => void;
  onRetryLaunch?: (id: string) => void | Promise<void>;
}
type Task = "review" | "proxy" | "measure";
interface ExitObservation { result: ProxyCheckResult; checkedAt: number }
const REPORT_LABELS = { issues: "Needs attention", review: "Review suggested", unmeasured: "Not measured", consistent: "Consistent" };
const EXIT_LABELS = { working: "Proxy reachable", unstable: "Mixed reachability", failed: "Connection failed", unavailable: "Check unavailable" };
export type InspectionEvidenceSource = "configuration" | "measurement" | "provenance" | "route" | "other";
const SOURCE_LABELS: Record<InspectionEvidenceSource, string> = { configuration: "Saved configuration", measurement: "Browser sample checks", provenance: "Sample source and freshness", route: "Saved route configuration", other: "Other report evidence" };
// Classify the backend's known check IDs, never the wording or a passing result.
const CHECKS: Record<string, { source: InspectionEvidenceSource; label: string }> = {
  identity_seed: { source: "configuration", label: "Fixed identity seed" }, screen_config: { source: "configuration", label: "Screen configuration" },
  timezone_config: { source: "configuration", label: "Timezone configuration" }, locale_config: { source: "configuration", label: "Language configuration" },
  desktop_persona: { source: "configuration", label: "Desktop identity" }, engine_identity: { source: "configuration", label: "Engine identity" },
  proxy_config: { source: "route", label: "Network route configuration" }, runtime_config: { source: "provenance", label: "Applied runtime configuration" },
  browser_sample: { source: "provenance", label: "Browser measurement" }, capture_source: { source: "provenance", label: "Measurement source and current identity" },
  sample_coverage: { source: "provenance", label: "Measurement coverage" }, sample_freshness: { source: "provenance", label: "Measurement time" },
  measured_persona: { source: "measurement", label: "Measured desktop identity" }, platform_consistency: { source: "measurement", label: "Measured system consistency" },
  platform_configuration: { source: "measurement", label: "Measured system and configuration" }, hardware_configuration: { source: "measurement", label: "Measured processors and configuration" },
  locale_configuration: { source: "measurement", label: "Measured language and configuration" }, screen_measurement: { source: "measurement", label: "Measured screen and configuration" },
  screen_available: { source: "measurement", label: "Available screen bounds" }, timezone_measurement: { source: "measurement", label: "Measured timezone and configuration" },
  language_consistency: { source: "measurement", label: "Measured language consistency" }, sample_errors: { source: "measurement", label: "Measurement completeness" },
  import_attestation: { source: "measurement", label: "Imported identity check" },
};
const PRIORITY: Record<FingerprintCheckStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };
const EDIT_FIELDS: Partial<Record<string, { field: InspectionEditField; label: string }>> = {
  proxy_config: { field: "proxy", label: "Proxy" },
  screen_config: { field: "resolution", label: "Screen" },
  timezone_config: { field: "timezone", label: "Timezone" },
  locale_config: { field: "locale", label: "Language" },
  identity_seed: { field: "fingerprintSeed", label: "Fingerprint seed" },
  screen_measurement: { field: "resolution", label: "Screen" },
  timezone_measurement: { field: "timezone", label: "Timezone" },
  locale_configuration: { field: "locale", label: "Language" },
  hardware_configuration: { field: "cores", label: "CPU" },
};
export function inspectionEvidenceSource(id: string): InspectionEvidenceSource { return Object.hasOwn(CHECKS, id) ? CHECKS[id]!.source : "other"; }
const validDate = (value: unknown): string | null => {
  if ((typeof value !== "string" && typeof value !== "number") || !Number.isFinite(new Date(value).getTime())) return null;
  return new Date(value).toISOString();
};
export function inspectionMeasurementCoverage(report: Pick<FingerprintReport, "checks" | "measuredAt">) {
  const status = (id: string) => { const matches = report.checks.filter(check => check.id === id); return matches.length === 1 ? matches[0]!.status : null; };
  const sampleAvailable = status("browser_sample") === "pass";
  const timestampAvailable = validDate(report.measuredAt) !== null;
  return { sampleAvailable, timestampAvailable, linkedCurrentSample: sampleAvailable && timestampAvailable
    && ["capture_source", "runtime_config", "sample_freshness", "sample_coverage"].every(id => status(id) === "pass") };
}
type InspectionNextStep = "review" | "findings" | "browser" | "network";
export function inspectionOverview(report: FingerprintReport | null, options: { proxyConfigured?: boolean; proxyStatus?: ProxyCheckResult["status"] | null; proxyError?: boolean; configurationChanged?: boolean } = {}) {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of report?.checks ?? []) if (Object.hasOwn(counts, check.status)) counts[check.status]++;
  const coverage = report ? inspectionMeasurementCoverage(report) : null;
  let headline = "More evidence is needed", tone: "unknown" | "issue" | "review" | "consistent" = "unknown", next: InspectionNextStep = "browser";
  if (!report) { headline = "Saved review unavailable"; next = "review"; }
  else if (counts.fail) { headline = "Resolve {count} issues first"; tone = "issue"; next = "findings"; }
  else if (options.proxyError || options.proxyStatus === "failed" || options.proxyStatus === "unstable") {
    headline = "Review the network connection first"; tone = options.proxyStatus === "failed" ? "issue" : "review"; next = "network";
  }
  else if (counts.warn) { headline = "Review {count} warnings next"; tone = "review"; next = "findings"; }
  else if (counts.unknown) next = "findings";
  else if (options.configurationChanged || !coverage?.linkedCurrentSample) next = "browser";
  else if (options.proxyConfigured && options.proxyStatus !== "working") next = "network";
  else { headline = "Stored checks have no reported issues"; tone = "consistent"; next = "findings"; }
  return { counts, coverage, headline, tone, next };
}

function InspectionEvidenceFact({ source, title, status, timeLabel, timestamp, empty, formatDate }: {
  source: string; title: string; status: string; timeLabel: string; timestamp?: number | string | null;
  empty: string; formatDate: (value: number | string) => string;
}) {
  const canonicalTime = validDate(timestamp);
  return <div className="inspection-evidence-fact" data-evidence-fact={source}>
    <strong>{title}</strong><span className="inspection-evidence-state">{status}</span>
    <dl className="inspection-evidence-time"><div><dt>{timeLabel}</dt><dd>{canonicalTime
      ? <time dateTime={canonicalTime}>{formatDate(timestamp!)}</time> : empty}</dd></div></dl>
  </div>;
}

function InspectionOverview({ headline, tone, nextLabel, action, children, evidenceNotes }: {
  headline: string; tone: ReturnType<typeof inspectionOverview>["tone"]; nextLabel?: string;
  action: ReactNode; children: ReactNode; evidenceNotes: readonly string[];
}) {
  const { t } = useTranslation();
  const toneGlyph = tone === "issue" ? "!" : tone === "review" ? "△" : tone === "consistent" ? "✓" : "?";
  return <section className={`inspection-overview is-${tone}`} aria-labelledby="inspection-overview-title" data-inspection-tone={tone}>
    <div className="inspection-overview-heading">
      <div className="inspection-overview-lead">
        <span className={`inspection-tone-badge is-${tone}`} aria-hidden="true">{toneGlyph}</span>
        <div>
          <h2 id="inspection-overview-title">{headline}</h2>
        </div>
      </div>
      <div className="inspection-overview-next">
        <span className="inspection-step-label">{t("Next step")}</span>{nextLabel && <strong>{nextLabel}</strong>}{action}
      </div>
    </div>
    <div className="inspection-evidence-sources" aria-label={t("Evidence overview")}>{children}</div>
    <details className="inspection-evidence-notes">
      <summary>{t("Details")}</summary>
      <ul>{evidenceNotes.map(note => <li key={note}>{t(note)}</li>)}</ul>
    </details>
  </section>;
}
/** Anonymous clipboard projection: fixed vocabulary, counts and canonical dates only. No raw report text or network observation enters it. */
export function buildInspectionDiagnosticSummary(report: FingerprintReport, options: { reviewedAt?: number | null; proxyStatus?: ProxyCheckResult["status"] | null; configurationChanged?: boolean } = {}, t: FingerprintTranslator = (value, values) => value.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] === undefined ? match : String(values[key]))) {
  const known = new Map<string, FingerprintCheckStatus>(); let omitted = 0;
  for (const check of report.checks) {
    if (!Object.hasOwn(CHECKS, check.id) || !Object.hasOwn(PRIORITY, check.status)) { omitted++; continue; }
    const previous = known.get(check.id);
    if (!previous || PRIORITY[check.status] < PRIORITY[previous]) known.set(check.id, check.status);
  }
  const totals = { pass: 0, warn: 0, fail: 0, unknown: 0 }; for (const status of known.values()) totals[status]++;
  const coverage = inspectionMeasurementCoverage(report), lines = [t("Anonymous environment inspection summary"),
    t("Recognized checks: {total} · Passed {pass} · Warnings {warn} · Issues {fail} · Unknown {unknown}", { total: known.size, ...totals }),
    t("Local report read: {time}", { time: validDate(options.reviewedAt) ?? t("Not available") }),
    t("Browser sample time: {time}", { time: validDate(report.measuredAt) ?? t("Not available") }),
    t(coverage.linkedCurrentSample ? "Stored sample source, launch, coverage and time were reported as consistent. This is historical evidence."
      : coverage.sampleAvailable ? "A stored browser sample is available; its source, coverage and time still need review." : "No usable browser sample is confirmed. Configuration checks do not establish measured browser identity."),
    t("Explicit proxy check: {status}", { status: t(options.proxyStatus && Object.hasOwn(EXIT_LABELS, options.proxyStatus) ? EXIT_LABELS[options.proxyStatus] : "Not checked") }),
  ];
  if (options.configurationChanged) lines.push(t("Configuration changed during this inspection; repeat the affected checks."));
  for (const [id, status] of [...known].sort((a, b) => PRIORITY[a[1]] - PRIORITY[b[1]])) {
    lines.push(`- ${t(SOURCE_LABELS[CHECKS[id]!.source])} · ${t(CHECKS[id]!.label)} · ${t(status)}`);
  }
  if (omitted) lines.push(t("Additional unrecognized report categories: {count}", { count: omitted }));
  lines.push(t("Reachability does not establish IP reputation, DNS or WebRTC leak safety."),
    t("Names, environment identifiers, cookie data, proxy credentials, IP addresses and raw evidence are excluded."));
  return lines.join("\n");
}

/** An inspectable workflow: report reads are local; network and browser probes are explicit. */
export function EnvironmentInspectionPage({ active, profile, refreshVersion = 0, onBack, onEditProfile, onExplainFingerprint, onOpenLogs, onRetryLaunch }: EnvironmentInspectionPageProps) {
  const { t, language } = useTranslation();
  const id = profile?.id ?? "";
  // UiProfile.proxy is a display value. Never parse it or send it as credentials.
  const signature = JSON.stringify([profile?.proxy, profile?.proxyError, profile?.timezone, profile?.screen, profile?.restartPending]);
  const [report, setReport] = useState<FingerprintReport | null>(null);
  const [reviewedAt, setReviewedAt] = useState<number | null>(null);
  const [exit, setExit] = useState<ExitObservation | null>(null);
  const [busy, setBusy] = useState<Task | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<InspectionEvidenceSource | "all">("all");
  const [search, setSearch] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const copying = useRef(false), findingsHeading = useRef<HTMLHeadingElement>(null);
  const [configurationChanged, setConfigurationChanged] = useState(false);
  const ownership = useRef({ id: "", signature: "", refreshVersion, active: false, generation: 0, busy: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const formatDate = (value: number | string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : t("Not available");
  };
  const owns = (generation: number, profileId: string) => {
    const state = ownership.current;
    return state.active && state.id === profileId && state.generation === generation;
  };
  async function review(force = false) {
    const state = ownership.current;
    if (!state.active || !id || state.id !== id || state.busy && !force) return;
    const generation = ++state.generation;
    state.busy = true; setBusy("review"); setReviewError(null); setMeasurementError(null);
    setCopyFeedback(null);
    // A new read never presents the old configuration as the current review.
    setReport(null); setReviewedAt(null);
    try {
      const reports = await fetchFingerprintReports();
      if (!owns(generation, id)) return;
      const current = reports.find(item => item.profileId === id);
      if (!current) { setReviewError("This environment is no longer available. Return to the environment list."); return; }
      setReport(current); setReviewedAt(Date.now());
    } catch {
      if (owns(generation, id)) setReviewError("The saved fingerprint review could not be loaded. Try again.");
    } finally {
      if (owns(generation, id)) { state.busy = false; setBusy(null); }
    }
  }
  useLayoutEffect(() => {
    const state = ownership.current;
    const changed = !!state.id && state.id === id && (state.signature !== signature || state.refreshVersion !== refreshVersion);
    const different = state.id !== id;
    state.generation++; state.id = id; state.active = active; state.signature = signature; state.refreshVersion = refreshVersion; state.busy = false;
    setBusy(null);
    if (different || changed) {
      setExit(null); setReport(null); setReviewedAt(null); setProxyError(null); setReviewError(null); setMeasurementError(null);
      setConfigurationChanged(changed);
      setCopyFeedback(null);
      if (different) { setShowPassed(false); setShowTimeline(false); setSourceFilter("all"); setSearch(""); }
    }
    if (active && id) void review(true);
    return () => { state.generation++; state.active = false; state.busy = false; };
  }, [active, id, signature, refreshVersion]);
  useLayoutEffect(() => { if (active) heading.current?.focus({ preventScroll: true }); }, [active, id]);

  async function inspectExit() {
    const state = ownership.current;
    if (!profile?.proxy || !active || state.busy || state.id !== id) return;
    const generation = ++state.generation;
    state.busy = true; setBusy("proxy"); setExit(null); setProxyError(null);
    setCopyFeedback(null);
    try {
      // Full saved detail contains credentials. It stays in this function and
      // is never placed in React state, logs, the DOM, or the AI suggestion.
      const saved = await fetchProfileEdit(id);
      if (!owns(generation, id)) return;
      if (saved.id !== id || typeof saved.proxy !== "string" || !saved.proxy.trim()
        || !["http", "socks5"].includes(saved.proxyType) || /^\s*https:\/\//i.test(saved.proxy)) {
        setProxyError("The saved proxy could not be checked. Review its protocol and address."); return;
      }
      let proxy;
      try { proxy = parsePastedProxy(saved.proxy, saved.proxyType === "socks5" ? "socks5" : "http"); }
      catch { setProxyError("The saved proxy could not be checked. Review its protocol and address."); return; }
      const result = await checkProxy(proxy);
      if (owns(generation, id)) setExit({ result, checkedAt: Date.now() });
    } catch (error) {
      if (owns(generation, id)) setProxyError(error instanceof ProxyCheckError && error.kind === "invalid"
        ? "The saved proxy could not be checked. Review its protocol and address." : "The proxy check is unavailable. Try again or edit the saved connection.");
    } finally {
      if (owns(generation, id)) { state.busy = false; setBusy(null); }
    }
  }
  const measurable = profile?.engine === "chromium" && profile.running && report?.running && !profile.restartPending;
  async function measure() {
    const state = ownership.current;
    if (!measurable || !active || !report || state.busy || state.id !== id) return;
    const generation = ++state.generation;
    state.busy = true; setBusy("measure"); setMeasurementError(null);
    setCopyFeedback(null);
    try {
      const updated = await measureFingerprint(id);
      if (!owns(generation, id)) return;
      if (updated.profileId !== id) throw new Error("Unexpected environment report");
      setReport(updated); setReviewedAt(Date.now());
    } catch {
      if (owns(generation, id)) setMeasurementError("The browser measurement could not be completed. The previous report is preserved. Refresh the review and try again.");
    } finally {
      if (owns(generation, id)) { state.busy = false; setBusy(null); }
    }
  }
  const presented = useMemo(() => (report?.checks ?? []).map((check, index) => ({ check, index, source: inspectionEvidenceSource(check.id), view: presentFingerprintCheck(check, t, language) }))
    .sort((a, b) => PRIORITY[a.check.status] - PRIORITY[b.check.status] || a.index - b.index), [report, t, language]);
  const query = search.trim().toLocaleLowerCase(language);
  const checks = presented.filter(item => (showPassed || item.check.status !== "pass") && (sourceFilter === "all" || item.source === sourceFilter)
    && (!query || [item.view.label, item.view.detail, item.view.recommendation, t(SOURCE_LABELS[item.source]), ...item.view.evidenceRows.flatMap(row => [row.label, row.value])]
      .filter(Boolean).join(" ").toLocaleLowerCase(language).includes(query)));
  const overview = inspectionOverview(report, { proxyConfigured: !!profile?.proxy, proxyStatus: exit?.result.status, proxyError: !!proxyError, configurationChanged });
  const { counts, coverage } = overview;
  const totalChecks = counts.pass + counts.warn + counts.fail + counts.unknown;
  const reportLabel = !report ? "Not checked" : counts.fail ? REPORT_LABELS.issues : !coverage?.sampleAvailable ? "Measurement missing"
    : counts.warn || counts.unknown ? REPORT_LABELS.review : coverage.linkedCurrentSample ? "Stored checks consistent" : "Sample source or freshness needs review";
  const safeSummary = useMemo(() => report ? buildInspectionDiagnosticSummary(report, { reviewedAt, proxyStatus: exit?.result.status, configurationChanged }, t) : "", [report, reviewedAt, exit?.result.status, configurationChanged, t]);
  async function copySummary() {
    if (!active || !report || ownership.current.busy || copying.current) return;
    copying.current = true; setCopyFeedback(null); const generation = ownership.current.generation;
    try { await navigator.clipboard.writeText(safeSummary); if (owns(generation, id)) setCopyFeedback("Safe diagnostic summary copied."); }
    catch { if (owns(generation, id)) setCopyFeedback("Clipboard access is unavailable. Open the safe summary preview to select and copy it manually."); }
    finally { copying.current = false; }
  }
  function showAttention() { setShowPassed(false); setSourceFilter("all"); setSearch(""); findingsHeading.current?.focus({ preventScroll: true }); findingsHeading.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }
  function showEvidence(section: "browser" | "network") {
    const target = heading.current?.closest(".inspection-workspace")?.querySelector<HTMLHeadingElement>(section === "browser" ? "#inspection-fingerprint-title" : "#inspection-route-title");
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
  const note = exit ? proxyCheckNote(exit.result) : null;
  function edit(field?: InspectionEditField, trigger?: HTMLButtonElement) { if (active && profile && !ownership.current.busy) onEditProfile(id, field, trigger); }
  function explain() { if (active && report && !ownership.current.busy) onExplainFingerprint(report); }
  const nextLabel = overview.next === "network" ? "Check saved proxy"
    : overview.next === "browser" ? measurable ? "Collect a new browser measurement" : "Return to environments to reopen or inspect" : undefined;
  const nextAction = overview.next === "review"
    ? <button className="btn" type="button" disabled={!!busy} onClick={() => void review()}>{t("Refresh review")}</button>
    : overview.next === "findings"
      ? <button className="btn" type="button" disabled={!!busy} onClick={showAttention}>{t("View checks needing review")}</button>
      : <button className="btn" type="button" disabled={!!busy} onClick={() => showEvidence(overview.next as "browser" | "network")}>{t(overview.next === "browser" ? "Review browser evidence" : "Review network evidence")}</button>;
  return <div className="workspace inspection-workspace" hidden={!active} aria-labelledby="inspection-page-title">
    <header className="page-heading inspection-heading">
      <div>
        <button className="btn xs ghost inspection-back" type="button" onClick={onBack}>← {t("Back to environments")}</button>
        <h1 id="inspection-page-title" ref={heading} tabIndex={-1}>{t("Environment inspection")}</h1>
        {!profile && <p className="page-subtitle">{t("This environment is no longer available. Return to the environment list.")}</p>}
      </div>
      {profile && <div className="inspection-profile">
        <span className="inspection-profile-avatar" aria-hidden="true">{(profile.name || id).trim().slice(0, 2).toUpperCase() || "MB"}</span>
        <div className="inspection-profile-meta">
          <strong>{profile.name || id}</strong>
          <span className={profile.running ? "is-running" : undefined}>{profile.engine === "firefox" ? "Firefox" : "Chromium"} · {t(profile.running ? "Running" : "Stopped")}</span>
        </div>
      </div>}
    </header>
    {profile && <div className="inspection-scroll">
      {configurationChanged && <p className="inspection-change" role="status">{t("Saved configuration changed. Check the exit again and collect a new browser measurement after reopening the environment.")}</p>}
      <InspectionOverview headline={t(busy === "review" ? "Loading the saved review…" : overview.headline, { count: counts.fail || counts.warn })}
        tone={overview.tone} nextLabel={nextLabel && t(nextLabel)} action={nextAction}
        evidenceNotes={[
          "Local settings only. These passes do not prove what a browser reports.",
          coverage?.sampleAvailable && !coverage.timestampAvailable ? "The stored sample has no usable capture time." : "Loading a report does not collect a new browser measurement.",
          "A separate on-demand observation. It is not part of fingerprint pass counts.",
          "The measurement uses an isolated local probe page in the already running browser.",
          "Counts describe the checks in this stored report, not an anonymity score or a completed browser acceptance test.",
          "Check the saved proxy on demand. Authentication details are never shown or added to AI drafts.",
          "Reachability, a separate exit IP, IP reputation and browser leaks are different checks.",
          "After saving, refresh the review and repeat the checks affected by your changes.",
          "The summary covers the full stored report, including checks hidden by filters.",
          "A consistent configuration is not a guarantee of anonymity or a website acceptance score. Unmeasured fields remain unknown.",
        ]}>
        <InspectionEvidenceFact source="configuration" title={t("Saved configuration")}
          status={report ? t("{count} local checks", { count: presented.filter(item => item.source === "configuration" || item.source === "route").length }) : t("Not checked")}
          timeLabel={t("Configuration reviewed")} timestamp={reviewedAt} empty={t("Not available")} formatDate={formatDate} />
        <InspectionEvidenceFact source="browser" title={t("Stored browser measurement")}
          status={t(!coverage?.sampleAvailable ? "No usable sample confirmed" : coverage.linkedCurrentSample ? "Source and freshness reported consistent" : "Sample source or freshness needs review")}
          timeLabel={t("Last browser measurement")} timestamp={report?.measuredAt} empty={t(report?.measuredAt ? "Not available" : "No runtime measurement yet")} formatDate={formatDate} />
        <InspectionEvidenceFact source="network" title={t("Explicit proxy check")} status={t(exit ? EXIT_LABELS[exit.result.status] : profile.proxy ? "Not checked" : "No proxy configured")}
          timeLabel={t("Last proxy check")} timestamp={exit?.checkedAt} empty={t("Not checked")} formatDate={formatDate} />
      </InspectionOverview>
      <div className="inspection-workbench">
        <div className="inspection-main-col">
          <section className="inspection-card inspection-findings" aria-labelledby="inspection-findings-title">
            <div className="inspection-card-heading">
              <h2 id="inspection-findings-title" ref={findingsHeading} tabIndex={-1}>{t("Findings and next steps")}</h2>
              {report && <label className={`inspection-filter${!showPassed ? " is-checked" : ""}`}>
                <input type="checkbox" checked={!showPassed} onChange={event => setShowPassed(!event.target.checked)} />
                <span className="inspection-filter-switch" aria-hidden="true"><span className="inspection-filter-thumb" /></span>
                <span>{t("Only checks needing review")}</span>
              </label>}
            </div>
            {report && <div className="inspection-report-tools"><label className="inspection-search"><span className="sr-only">{t("Search report")}</span><input type="search" value={search} placeholder={t("Search checks, guidance or evidence")} onChange={event => setSearch(event.target.value)} /></label><label className="inspection-source-filter"><span className="sr-only">{t("Evidence source")}</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value as InspectionEvidenceSource | "all")}><option value="all">{t("All evidence sources")}</option>{(Object.keys(SOURCE_LABELS) as InspectionEvidenceSource[]).map(source => <option key={source} value={source}>{t(SOURCE_LABELS[source])} ({presented.filter(item => item.source === source).length})</option>)}</select></label><button className="btn xs ghost" type="button" disabled={!search && sourceFilter === "all" && !showPassed} onClick={() => { setSearch(""); setSourceFilter("all"); setShowPassed(false); }}>{t("Reset report filters")}</button><p role="status">{t("Showing {shown} of {total} checks · issues, warnings and unknowns first", { shown: checks.length, total: presented.length })}</p></div>}
            {!report ? <p className="inspection-note">{t(busy === "review" ? "Loading the saved review…" : "Refresh the review to inspect this environment.")}</p> : <div className="inspection-checks">
              {checks.map(({ view, source, index }) => {
                const configuration = source === "configuration" || source === "route";
                const mismatch = source === "measurement" && (view.status === "fail" || view.status === "warn");
                const setting = (configuration || mismatch) && Object.hasOwn(EDIT_FIELDS, view.id) ? EDIT_FIELDS[view.id] : undefined;
                return <article className={`inspection-check ${view.status}`} key={`${view.id}-${index}`} data-check-id={view.id} data-evidence-source={source}>
                  <span className="inspection-check-mark" aria-hidden="true">{view.status === "fail" ? "!" : view.status === "warn" ? "△" : view.status === "pass" ? "✓" : "·"}</span>
                  <div>
                    <div className="inspection-check-title">
                      <h3>{view.label}</h3>
                      <div className="inspection-check-badges">
                        <span className="inspection-source-label">{t(SOURCE_LABELS[source])}</span>
                        <span className="inspection-check-status">{t(view.status)}</span>
                      </div>
                    </div>
                    <p>{view.detail}</p>
                    {(view.evidenceRows.length > 0 || view.evidenceNote) && <details className="inspection-check-evidence">
                      <summary>{t("View evidence ({count})", { count: view.evidenceRows.length })}</summary>
                      {view.evidenceRows.length > 0 && <dl>{view.evidenceRows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
                      {view.evidenceNote && <p className="inspection-note">{view.evidenceNote}</p>}
                    </details>}
                    {view.recommendation && <p className="inspection-recommendation">{view.recommendation}</p>}
                    {view.status !== "pass" && source !== "other" && <div className="inspection-check-actions">
                      {(configuration || setting) && <button className="btn xs ghost" type="button" disabled={!!busy} onClick={event => edit(setting?.field, event.currentTarget)}>
                        {setting ? t("Review {setting} settings", { setting: t(setting.label) }) : t("Review configuration")}
                      </button>}
                      {!configuration && (measurable ? <button className="btn xs ghost" type="button" disabled={!!busy} onClick={() => void measure()}>{t("Collect a new browser measurement")}</button>
                        : <button className="btn xs ghost" type="button" disabled={!!busy} onClick={onBack}>{t("Return to environments to reopen or inspect")}</button>)}
                    </div>}
                  </div>
                </article>;
              })}
              {!checks.length && <p className="inspection-empty">{t(query || sourceFilter !== "all" ? "No checks match these filters. Reset the filters to see the report." : "No stored checks need review here. Browser measurement and network coverage are listed separately above.")}</p>}
            </div>}
            <div className="inspection-next-actions"><button className="btn primary" type="button" disabled={!!busy} onClick={event => edit(undefined, event.currentTarget)}>{t("Edit profile configuration")}</button><button className="btn" type="button" disabled={!!busy || !report} onClick={explain}>{t("Draft AI explanation")}</button></div>
          </section>
          <section className="inspection-card inspection-timeline" aria-labelledby="inspection-timeline-title">
            <div className="inspection-card-heading">
              <div>
                <h2 id="inspection-timeline-title">{t("Activity timeline")}</h2>
              </div>
              <button
                className="btn xs"
                type="button"
                aria-expanded={showTimeline}
                onClick={() => setShowTimeline((prev) => !prev)}
              >
                {t(showTimeline ? "Hide activity timeline" : "Show activity timeline")}
              </button>
            </div>
            {showTimeline && (
              <ProfileTimeline
                profileId={id}
                hasProxy={!!profile.proxy && !profile.proxyError}
                running={profile.running}
                onOpenLogs={onOpenLogs}
                onRetryLaunch={onRetryLaunch}
                onEditProxy={() => edit("proxy")}
                onCheckProxyComplete={(result) => setExit({ result, checkedAt: result.checkedAt })}
              />
            )}
          </section>
        </div>
        <aside className="inspection-rail">
          <section className="inspection-card inspection-fingerprint" aria-labelledby="inspection-fingerprint-title" aria-busy={busy === "review" || busy === "measure"}>
            <div className="inspection-card-heading"><h2 id="inspection-fingerprint-title" tabIndex={-1}>{t("Fingerprint review")}</h2>{report && <span className={`feature-badge ${!counts.fail && !counts.warn && !counts.unknown && coverage?.linkedCurrentSample ? "positive" : ""}`}>{t(reportLabel)}</span>}</div>
            {report && totalChecks > 0 && (
              <div className="inspection-dist-bar" aria-hidden="true">
                {counts.pass > 0 && <span className="inspection-dist-seg is-pass" style={{ width: `${(counts.pass / totalChecks) * 100}%` }} />}
                {counts.warn > 0 && <span className="inspection-dist-seg is-warn" style={{ width: `${(counts.warn / totalChecks) * 100}%` }} />}
                {counts.fail > 0 && <span className="inspection-dist-seg is-fail" style={{ width: `${(counts.fail / totalChecks) * 100}%` }} />}
                {counts.unknown > 0 && <span className="inspection-dist-seg is-unknown" style={{ width: `${(counts.unknown / totalChecks) * 100}%` }} />}
              </div>
            )}
            {report && <div className="inspection-counts" aria-label={t("Stored report check counts")}><span className={counts.pass ? "has-passes" : undefined}>{t("{count} passed", { count: counts.pass })}</span><span className={counts.warn ? "has-warnings" : undefined}>{t("{count} warnings", { count: counts.warn })}</span><span className={counts.fail ? "has-issues" : undefined}>{t("{count} failed", { count: counts.fail })}</span><span className={counts.unknown ? "has-unknowns" : undefined}>{t("{count} unknown", { count: counts.unknown })}</span></div>}
            <div className="inspection-buttons">
              <button className="btn primary" type="button" disabled={!!busy || !measurable} aria-busy={busy === "measure"} onClick={() => void measure()}>{t(busy === "measure" ? "Measuring fingerprint…" : "Measure running browser")}</button>
              <button className="btn" type="button" disabled={!!busy} onClick={() => void review()}>{t(busy === "review" ? "Checking…" : "Refresh review")}</button>
            </div>
            {(profile.restartPending || profile.engine === "firefox" || !profile.running) && (
              <p className="inspection-note">{t(profile.restartPending ? "The running browser uses an older saved configuration. Reopen it before measuring again." : profile.engine === "firefox" ? "Runtime measurement here requires a running Chromium environment. Saved Firefox configuration can still be reviewed." : "Open this environment yourself, then refresh the review to enable a browser measurement.")}</p>
            )}
            {reviewError && <p className="inspection-error" role="alert">{t(reviewError)}</p>}
            {measurementError && <p className="inspection-error" role="alert">{t(measurementError)}</p>}
          </section>
          <section className="inspection-card inspection-network" aria-labelledby="inspection-route-title">
            <div className="inspection-card-heading"><h2 id="inspection-route-title" tabIndex={-1}>{t("Network exit")}</h2><span className="feature-badge">{t(profile.proxy ? "Saved proxy configuration" : "Direct connection")}</span></div>
            {!profile.proxy && <p>{t("No proxy is saved for this environment. A direct connection is not a verified proxy exit.")}</p>}
            <button className="btn" type="button" disabled={!!busy || !profile.proxy} aria-busy={busy === "proxy"} onClick={() => void inspectExit()}>{t(busy === "proxy" ? "Checking saved proxy…" : "Check saved proxy")}</button>
            {proxyError && <p className="inspection-error" role="alert">{t(proxyError)}</p>}
            {exit && <div className={`inspection-exit-result ${exit.result.status}`} role="status"><strong>{t(EXIT_LABELS[exit.result.status])}</strong>
              <dl><div><dt>{t("Observed exit IP")}</dt><dd>{exit.result.ip || t("Not available")}</dd></div><div><dt>{t("Exit location")}</dt><dd>{[exit.result.country, exit.result.region, exit.result.city].filter(Boolean).join(" · ") || t("Not available")}</dd></div><div><dt>{t("Last checked")}</dt><dd>{formatDate(exit.checkedAt)}</dd></div></dl>
              {note && <p>{t(note)}</p>}
            </div>}
          </section>
          {report && <section className="inspection-card inspection-safe-summary" aria-labelledby="inspection-safe-summary-title"><div className="inspection-card-heading"><div><h2 id="inspection-safe-summary-title">{t("Share a safe diagnostic summary")}</h2><p>{t("Copies fixed check categories, status counts and timestamps. It excludes account data, IP addresses and raw evidence.")}</p></div><button className="btn xs" type="button" disabled={!!busy} onClick={() => void copySummary()}>{t("Copy safe summary")}</button></div>{copyFeedback && <p className="inspection-copy-feedback" role="status">{t(copyFeedback)}</p>}<details><summary>{t("Preview safe summary")}</summary><pre tabIndex={0}>{safeSummary}</pre></details></section>}
        </aside>
      </div>
    </div>}
  </div>;
}
