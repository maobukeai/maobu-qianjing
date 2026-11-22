import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { checkProxy, type ProxyCheckResult, type RuntimeDownload } from "./api.ts";
import { proxyCheckNote } from "./proxy-check-presentation.ts";
import { LocalProxyPreflightSettings } from "./local-proxy-preflight-settings.tsx";
import { ChromiumPreloadingSettings } from "./chromium-preloading-settings.tsx";
import { ChromiumMemorySaverSettings } from "./chromium-memory-saver-settings.tsx";
import { presentFingerprintCheck } from "../fingerprint-check-presentation.ts";
import type { LocalProxyDiscoveryRequest, LocalProxyHost } from "../network-diagnostics.ts";
import { checkForUpdate, createSyncFile, discoverProxies, fetchFingerprintReports, fetchIntegrationInfo, fetchLastUpdate, fetchSettings, fetchSyncFiles, importSyncFile, measureFingerprint, patchSettings, previewSyncFile, type AppSettings, type FingerprintReport, type IntegrationInfo, type LocalDiscovery, type SyncFileRecord, type SyncPreview, type UpdateResult } from "./settings-api.ts";
import "./settings-center.css";
import { ProxyResources } from "./proxy-resources.tsx";
import { SignedUpdateCard, type SignedUpdateStartupController } from "./signed-updates.tsx";
import { BrowserRuntimeSettings } from "./browser-runtime-settings.tsx";
import { McpConnectionProbe } from "./mcp-connection-probe.tsx";
import { copyText } from "./clipboard.ts";
import { useOptionalWorkspaceOperations, workspaceOperationMessage, type WorkspaceOperationLease } from "./workspace-operations.tsx";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { ModelServicesPanel } from "./model-services.tsx";

export type FeatureSettingsTab = "network" | "fingerprints" | "models" | "integrations" | "sync" | "updates";
export interface LocalProxyDraftCandidate {
  host: LocalProxyHost;
  port: number;
  type: "http" | "socks5";
  evidence: "handshake" | "port_hint";
  socks5AuthRequired: boolean;
}
interface NetworkPanelProps {
  onCreateWithLocalProxy?: (candidate: LocalProxyDraftCandidate, trigger: HTMLButtonElement) => void;
  onAssignLocalProxy?: (candidate: LocalProxyDraftCandidate, trigger: HTMLButtonElement) => void;
  onResumeLocalProxyAssignment?: () => void;
  localProxyAssignmentBlocked?: boolean;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function date(value: string | number): string { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString(); }
function Glyph({ kind }: { kind: "network" | "fingerprints" | "integrations" | "sync" | "updates" }) {
  const paths = {
    network: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a17 17 0 010 18 17 17 0 010-18" /></>,
    fingerprints: <><path d="M5 12a7 7 0 0114 0M8 12a4 4 0 018 0v2c0 3-1 5-2 7M11 12a1 1 0 012 0v3c0 3-1 5-2 6M5 15c0 2-.5 3-1 4M8 15c0 3-1 5-2 6" /></>,
    integrations: <><rect x="4" y="6" width="16" height="14" rx="4" /><path d="M12 2v4M1 11v5M23 11v5M9 16h6M8 11h.01M16 11h.01" /></>,
    sync: <><path d="M20 7a9 9 0 00-15 0L2 10M2 4v6h6M4 17a9 9 0 0015 0l3-3M22 20v-6h-6" /></>,
    updates: <><path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3" /></>,
  };
  return <svg className="feature-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
function Heading({ kind, title, description }: { kind: Exclude<FeatureSettingsTab, "models">; title: string; description: string }) {
  const { t } = useTranslation();
  return <div className="feature-heading"><span className="feature-heading-icon"><Glyph kind={kind} /></span><div><h2>{t(title)}</h2><p>{t(description)}</p></div></div>;
}
function Alert({ error }: { error: string | null }) { const { t } = useTranslation(); return error ? <div className="feature-alert" role="alert">{t(error)}</div> : null; }
function Loading() { const { t } = useTranslation(); return <p className="feature-loading" role="status">{t("Loading…")}</p>; }
interface PanelTask { current(): boolean; finish(): void }
/** Synchronous per-operation locks also invalidate requests from an earlier mount. */
function usePanelTasks() {
  const lifecycle = useRef({ active: true, generation: 0, running: new Map<string, symbol>() });
  useEffect(() => {
    lifecycle.current.active = true;
    return () => { lifecycle.current.active = false; lifecycle.current.generation++; lifecycle.current.running.clear(); };
  }, []);
  return (key: string): PanelTask | null => {
    const state = lifecycle.current;
    if (!state.active || state.running.has(key)) return null;
    const token = Symbol(key), generation = state.generation;
    state.running.set(key, token);
    return {
      current: () => state.active && state.generation === generation && state.running.get(key) === token,
      finish: () => { if (state.running.get(key) === token) state.running.delete(key); },
    };
  };
}
function CopyButton({ value, label = "Copy", accessibleLabel }: { value: string; label?: string; accessibleLabel?: string }) {
  const { t } = useTranslation(); const [status, setStatus] = useState("");
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(""), 2500); return () => clearTimeout(timer); }, [status]);
  return <span className="feature-copy"><button type="button" className="btn xs" disabled={!value} aria-label={accessibleLabel} onClick={() => { void copyText(value).then(() => setStatus("Copied")).catch(() => setStatus("Copy failed. Select and copy the text.")); }}>{t(label)}</button><span role="status">{t(status)}</span></span>;
}

const DISCOVERY_PORTS_ERROR = "Enter 1–16 unique ports from 1 to 65535, separated by commas.";

function discoveryInput(host: LocalProxyHost, draft: string): LocalProxyDiscoveryRequest {
  const input = draft.trim();
  if (!input) return host === "127.0.0.1" ? {} : { host };
  const tokens = input.split(/[,，]/, 17).map(token => token.trim());
  if (tokens.length > 16 || tokens.some(token => !/^\d{1,5}$/.test(token))) throw new Error(DISCOVERY_PORTS_ERROR);
  const ports = tokens.map(Number);
  if (ports.some(port => port < 1 || port > 65535) || new Set(ports).size !== ports.length) throw new Error(DISCOVERY_PORTS_ERROR);
  return { host, ports };
}

function localProxyEndpoint(host: LocalProxyHost, port: number): string {
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}

function NetworkPanel({ onCreateWithLocalProxy, onAssignLocalProxy, onResumeLocalProxyAssignment, localProxyAssignmentBlocked }: NetworkPanelProps) {
  const { t } = useTranslation();
  const begin = usePanelTasks();
  const [host, setHost] = useState<LocalProxyHost>("127.0.0.1");
  const [ports, setPorts] = useState("");
  const [discovery, setDiscovery] = useState<LocalDiscovery | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null), [checks, setChecks] = useState<Record<string, ProxyCheckResult & { checkedAt: number }>>({});
  const listening = discovery?.results.filter(result => result.status === "listening") ?? [];
  const locked = busy || checking !== null;
  const portHint = React.useId();

  function clearDiscovery() {
    setError(null);
    setChecks({});
    setDiscovery(null);
  }
  function changeOptions(update: () => void) {
    const task = begin("network");
    if (!task) return;
    update();
    clearDiscovery();
    task.finish();
  }
  async function scan() {
    const task = begin("network");
    if (!task) return;
    try {
      const input = discoveryInput(host, ports);
      setBusy(true);
      clearDiscovery();
      const result = await discoverProxies(input);
      if (task.current()) setDiscovery(result);
    } catch (error) {
      if (task.current()) setError(message(error));
    } finally {
      if (task.current()) setBusy(false);
      task.finish();
    }
  }
  async function verify(host: LocalProxyHost, port: number, type: "http" | "socks5") {
    const task = begin("network");
    if (!task) return;
    const key = `${localProxyEndpoint(host, port)}/${type}`;
    setChecking(key); setError(null);
    setChecks(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const result = await checkProxy({ type, host, port: String(port), user: "", pass: "" });
      if (task.current()) setChecks(previous => ({ ...previous, [key]: { ...result, checkedAt: Date.now() } }));
    } catch (error) {
      if (task.current()) setError(message(error));
    } finally {
      if (task.current()) setChecking(null);
      task.finish();
    }
  }
  return <div className="feature-panel">
    <Heading kind="network" title="Network & proxies" description="Connect your desktop proxy, then verify the actual exit connection." />
    <LocalProxyPreflightSettings />
    <ChromiumPreloadingSettings />
    <ChromiumMemorySaverSettings />
    <section className="feature-card">
      <div className="feature-card-title"><div><h3>{t("Desktop proxy discovery")}</h3><p>{t("Find local listeners used by Clash, Mihomo, v2rayN and other desktop clients.")}</p></div></div>
      <form onSubmit={event => { event.preventDefault(); void scan(); }}>
        <div className="feature-grid">
          <label className="fld"><span>{t("Loopback address")}</span>
            <select value={host} disabled={locked} onChange={event => {
              const value = event.target.value;
              if (value === "127.0.0.1" || value === "::1") changeOptions(() => setHost(value));
            }}>
              <option value="127.0.0.1">IPv4 (127.0.0.1)</option><option value="::1">IPv6 (::1)</option>
            </select>
          </label>
          <label className="fld"><span id={`${portHint}-label`}>{t("Custom ports (optional)")}</span>
            <input type="text" value={ports} placeholder="7890, 1080" autoComplete="off" spellCheck={false} disabled={locked}
              aria-labelledby={`${portHint}-label`} aria-describedby={portHint} aria-invalid={error === DISCOVERY_PORTS_ERROR || undefined} onChange={event => {
                const value = event.target.value;
                changeOptions(() => setPorts(value));
              }} />
            <small id={portHint}>{t("Use commas to separate up to 16 unique ports. Leave blank to use common ports.")}</small>
          </label>
        </div>
        <div className="feature-actions"><button type="submit" className="btn primary" disabled={locked} aria-busy={busy}>{t(busy ? "Scanning…" : "Discover local proxies")}</button></div>
      </form>
      <div className="feature-inline-note">{t("Discovery checks loopback ports only. A listening port still needs an exit check.")}</div>
      <Alert error={error} />
      {onResumeLocalProxyAssignment && <div className="feature-actions"><button className="btn" type="button" onClick={onResumeLocalProxyAssignment}>{t("Return to proxy assignment draft")}</button></div>}
      {discovery && <><div className="feature-result-meta"><span>{t("{count} local listeners", { count: listening.length })}</span><time>{date(discovery.checkedAt)}</time></div>
        {!listening.length && <p className="feature-empty">{t("No local proxy listener found. Open your desktop proxy client and enable its local HTTP or SOCKS port.")}</p>}
        {listening.map(result => {
          const endpoint = localProxyEndpoint(result.host, result.port);
          return <div className="local-proxy-result" key={endpoint}>
            <div className="local-proxy-address"><span className="feature-dot" /><strong className="mono">{endpoint}</strong><span className="feature-badge">{result.latencyMs ?? "—"} ms</span></div>
            <p>{t(result.socks5 === "available" ? "SOCKS5 handshake confirmed" : result.socks5 === "authentication_required" ? "SOCKS5 requires authentication" : "TCP listener detected; protocol needs verification")}</p>
            <div className="feature-actions">{result.suggestions.map(suggestion => {
              const key = `${endpoint}/${suggestion.type}`, protocol = suggestion.type.toUpperCase();
              const checked = checks[key], note = checked && proxyCheckNote(checked);
              const candidate: LocalProxyDraftCandidate = {
                host: result.host, port: result.port, type: suggestion.type, evidence: suggestion.evidence,
                socks5AuthRequired: suggestion.type === "socks5" && result.socks5 === "authentication_required",
              };
              return <React.Fragment key={key}>
                <CopyButton value={`${suggestion.type}://${endpoint}`} label={suggestion.type === "http" ? "Copy HTTP" : "Copy SOCKS5"}
                  accessibleLabel={t("Copy {protocol} proxy for {endpoint}", { protocol, endpoint })} />
                <button className="btn xs" type="button" aria-label={t("Verify {protocol} exit for {endpoint}", { protocol, endpoint })}
                  disabled={locked} onClick={() => void verify(result.host, result.port, suggestion.type)}>
                  {t(checking === key ? "Checking…" : "Verify exit")} · {protocol}
                </button>
                {onCreateWithLocalProxy && <button className="btn xs" type="button"
                  aria-label={t("Use {protocol} proxy at {endpoint} in a new profile", { protocol, endpoint })}
                  disabled={locked} onClick={event => onCreateWithLocalProxy(candidate, event.currentTarget)}>
                  {t("Use in new profile")}
                </button>}
                {onAssignLocalProxy && <button className="btn xs" type="button"
                  aria-label={t("Assign {protocol} proxy at {endpoint} to existing profiles", { protocol, endpoint })}
                  disabled={locked || localProxyAssignmentBlocked || !!onResumeLocalProxyAssignment}
                  onClick={event => onAssignLocalProxy(candidate, event.currentTarget)}>
                  {t("Assign to existing profiles")}
                </button>}
                {checked && <span className={`feature-check-result ${checked.status}`} role="status">
                  {t(checked.status)} · {checked.ip ?? ""} {checked.country ?? ""} · {checked.successes}/{checked.attempts} · {date(checked.checkedAt)}
                  {note && <small className="proxy-exit-note">{t(note)}</small>}
                </span>}
              </React.Fragment>;
            })}</div>
          </div>;
        })}
        <details className="feature-details"><summary>{t("All checked ports")}</summary><div className="port-list">{discovery.results.map(result => {
          const endpoint = localProxyEndpoint(result.host, result.port);
          return <span key={endpoint} className={`feature-badge ${result.status === "listening" ? "positive" : ""}`}>{endpoint} · {t(result.status)}</span>;
        })}</div></details>
      </>}
    </section>
    <div className="feature-grid"><section className="feature-card"><span className="feature-eyebrow">{t("Choose your route")}</span><h3>{t("Match the proxy to your work")}</h3><ul className="feature-guide"><li><strong>{t("Desktop client")}</strong><span>{t("Reuse a local HTTP or SOCKS endpoint. Keep the client running while profiles use it.")}</span></li><li><strong>{t("Dedicated proxy")}</strong><span>{t("Use a provider or server you control when a stable exit IP and clear ownership matter.")}</span></li><li><strong>{t("Public proxy lists")}</strong><span>{t("Free endpoints have unknown operators and changing availability. A successful check does not certify IP reputation.")}</span></li></ul></section>
    <section className="feature-card"><span className="feature-eyebrow">{t("Connection checklist")}</span><h3>{t("Verify before assigning")}</h3><ol className="feature-steps"><li>{t("Confirm the proxy protocol and authentication.")}</li><li>{t("Verify the exit IP and country using the proxy check.")}</li><li>{t("Assign the endpoint in the profile editor, then align timezone and language.")}</li><li>{t("Reopen the profile to apply network changes.")}</li></ol><p className="feature-inline-note">{t("Connection checks measure reachability and exit location. IP reputation, DNS and WebRTC need separate evidence.")}</p></section></div>
    <ProxyResources />
  </div>;
}

function FingerprintCheckRow({ check }: { check: FingerprintReport["checks"][number] }) {
  const { t, language } = useTranslation();
  const view = presentFingerprintCheck(check, t, language);
  return <div className="quality-check"><span className={`quality-mark ${view.status}`} aria-label={t(view.status)}>{view.status === "pass" ? "✓" : view.status === "fail" ? "!" : view.status === "warn" ? "△" : "·"}</span><div><strong>{view.label}</strong><p>{view.detail}</p>
    {view.evidenceRows.length > 0 && <dl className="quality-evidence">{view.evidenceRows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {view.evidenceNote && <p className="quality-evidence-note">{view.evidenceNote}</p>}
    {view.recommendation && <span className="quality-recommendation">{view.recommendation}</span>}
  </div><span className="feature-badge">{t(view.status)}</span></div>;
}

interface FingerprintsPanelProps {
  onEditProfile?: (id: string) => void;
  onInspectProfile?: (id: string) => void;
  onExplainFingerprint?: (report: FingerprintReport) => void;
  fingerprintRefreshVersion?: number;
}
function FingerprintsPanel({ onEditProfile, onInspectProfile, onExplainFingerprint, fingerprintRefreshVersion = 0 }: FingerprintsPanelProps) {
  const { t } = useTranslation(); const [reports, setReports] = useState<FingerprintReport[] | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(true), [selected, setSelected] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const requests = useRef({ mounted: true, generation: 0, loading: false, measurement: null as symbol | null });
  useEffect(() => {
    requests.current.mounted = true;
    return () => { requests.current.mounted = false; requests.current.generation++; requests.current.loading = false; requests.current.measurement = null; };
  }, []);
  async function load(force = false) {
    const state = requests.current;
    if (!state.mounted || !force && (state.loading || state.measurement)) return;
    const generation = ++state.generation;
    state.loading = true; setBusy(true); setError(null);
    try {
      const value = await fetchFingerprintReports();
      if (!state.mounted || state.generation !== generation) return;
      setReports(value); setSelected(current => current || value[0]?.profileId || "");
    } catch (error) { if (state.mounted && state.generation === generation) setError(message(error)); }
    finally { if (state.mounted && state.generation === generation) { state.loading = false; setBusy(false); } }
  }
  // A save must start a newer read even if an older review is still pending.
  useEffect(() => { void load(true); }, [fingerprintRefreshVersion]);
  const report = reports?.find(item => item.profileId === selected);
  const missingSelected = reports !== null && !!selected && !report;
  const visibleChecks = report?.checks.filter(check => !attentionOnly || check.status !== "pass") ?? [];
  async function measure() {
    const state = requests.current;
    if (!report || !report.running || !state.mounted || state.loading || state.measurement) return;
    const generation = ++state.generation, measurement = Symbol("measurement"), profileId = report.profileId;
    state.measurement = measurement;
    setMeasuring(true); setError(null);
    try { const updated = await measureFingerprint(profileId); if (state.mounted && state.generation === generation && state.measurement === measurement) setReports(current => current?.map(item => item.profileId === profileId ? updated : item) ?? []); }
    catch (error) { if (state.mounted && state.generation === generation && state.measurement === measurement) setError(message(error)); }
    finally { if (state.mounted && state.measurement === measurement) { state.measurement = null; setMeasuring(false); } }
  }
  function actOnReport(action?: (report: FingerprintReport) => void) {
    if (!report || !action || requests.current.loading || requests.current.measurement || !requests.current.mounted) return;
    try { action(report); } catch (error) { setError(message(error)); }
  }
  const counts = { issues: 0, review: 0, unmeasured: 0, consistent: 0 }; for (const item of reports ?? []) counts[item.status]++;
  const labels = { issues: "Needs attention", review: "Review suggested", unmeasured: "Not measured", consistent: "Consistent" };
  return <div className="feature-panel"><Heading kind="fingerprints" title="Fingerprint quality" description="Review configuration consistency and evidence from the last browser measurement." />
    <Alert error={error} />
    <div className="quality-overview">{Object.entries(labels).map(([key, label]) => <div className={`quality-stat ${key}`} key={key}><span>{t(label)}</span><strong>{reports ? counts[key as keyof typeof counts] : "—"}</strong></div>)}</div>
    <section className="feature-card"><div className="feature-card-title"><div><h3>{t("Profile inspection")}</h3><p>{t("This review does not open browsers or send profile data to a third party.")}</p></div><button className="btn" type="button" disabled={busy || measuring} onClick={() => void load()}>{t(busy ? "Checking…" : "Run review")}</button></div>
      {busy && !reports ? <Loading /> : reports?.length === 0 && !selected ? <p className="feature-empty">{t("Create a profile to inspect its fingerprint configuration.")}</p> : reports && <><label className="fld"><span>{t("Profile")}</span><select value={selected} disabled={busy || measuring} onChange={event => setSelected(event.target.value)}>{missingSelected && <option value={selected} disabled>{t("Selected profile unavailable")}</option>}{reports.map(item => <option key={item.profileId} value={item.profileId}>{item.name || item.profileId} · {t(labels[item.status])}</option>)}</select></label>
        {(onEditProfile || onInspectProfile || onExplainFingerprint) && <div className="feature-actions">
          {onInspectProfile && <button type="button" className="btn" disabled={busy || measuring || !report} onClick={() => actOnReport(item => onInspectProfile(item.profileId))}>{t("Inspect network & fingerprint")}</button>}
          {onEditProfile && <button type="button" className="btn" disabled={busy || measuring || !report} aria-label={report ? t("Edit {profile}", { profile: report.name || report.profileId }) : undefined} onClick={() => actOnReport(item => onEditProfile(item.profileId))}>{t("Edit profile configuration")}</button>}
          {onExplainFingerprint && <button type="button" className="btn" disabled={busy || measuring || !report} onClick={() => actOnReport(onExplainFingerprint)}>{t("Draft AI explanation")}</button>}
        </div>}
        {missingSelected && <Alert error="The selected profile is no longer available. Refresh the review or choose another profile." />}
        {report && <><div className="feature-result-meta"><span className={`feature-badge ${report.status === "consistent" ? "positive" : ""}`}>{t(labels[report.status])}</span><span>{report.measuredAt ? `${t("Last measurement")}: ${date(report.measuredAt)}` : t("No runtime measurement yet")}</span></div>
        <div className="feature-actions"><button className="btn primary" type="button" disabled={busy || measuring || !report.running} aria-busy={measuring} onClick={() => void measure()}>{t(measuring ? "Measuring fingerprint…" : "Measure running browser")}</button><span className="muted">{t(report.running ? "Uses an isolated local probe page in this browser." : "Open this profile, then refresh the review to collect a live measurement.")}</span></div>
        <div className="quality-filter"><label><input type="checkbox" checked={attentionOnly} onChange={event => setAttentionOnly(event.target.checked)} />{t("Only items needing attention")}</label><span>{t("Showing {count} of {total} checks", { count: visibleChecks.length, total: report.checks.length })}</span></div><div className="quality-checks">{visibleChecks.map(check => <FingerprintCheckRow key={check.id} check={check} />)}</div>{!visibleChecks.length && <p className="feature-empty">{t("No items need attention in this stored report.")}</p>}
      </>}</>}
    </section><p className="feature-inline-note">{t("A consistent configuration is not a guarantee of anonymity or a website acceptance score. Unmeasured fields remain unknown.")}</p>
  </div>;
}

function IntegrationsPanel({ active, onOpenAssistant }: { active: boolean; onOpenAssistant?: () => void }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<IntegrationInfo | null>(null), [error, setError] = useState<string | null>(null), [configId, setConfigId] = useState("");
  const [probing, setProbing] = useState(false);
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const loadingNow = useRef(true), probingNow = useRef(false);
  useEffect(() => {
    let live = true;
    void fetchIntegrationInfo().then(value => { if (live) setInfo(value); })
      .catch(error => { if (live) { setInfo(null); setError(message(error)); } })
      .finally(() => { if (live) { loadingNow.current = false; setLoading(false); } });
    return () => { live = false; };
  }, [revision]);
  function refresh() {
    if (!active || loadingNow.current || probingNow.current) return;
    loadingNow.current = true;
    setLoading(true);
    setError(null);
    setRevision(value => value + 1);
  }
  const config = loading ? undefined : info?.configs.find(item => item.id === configId) ?? info?.configs[0];
  return <div className="feature-panel"><Heading kind="integrations" title="AI & MCP" description="Give your AI assistant a local browser workspace with real, inspectable capabilities." /><div className="feature-actions">{onOpenAssistant && <button className="btn primary" type="button" onClick={onOpenAssistant}>{t("Open AI workspace")}</button>}<button className="btn" type="button" disabled={loading || probing} aria-busy={loading} onClick={refresh}>{t("Refresh connection info")}</button></div><Alert error={error} />
    {!info && !error && <Loading />}{info && <><section className="feature-card"><div className="feature-card-title"><div><h3>{t("Connect your assistant")}</h3><p>{t("Use a stdio MCP client to manage local profiles and automate the browser.")}</p></div><span className={`feature-badge ${!loading && info.status === "ready" ? "positive" : ""}`}>{t(loading ? "Loading…" : info.status === "ready" ? "Ready to connect" : "Setup required")}</span></div>
      <div className="integration-checks">{info.checks.map(check => <p key={check.id}><span className={`quality-mark ${check.status}`}>{check.status === "pass" ? "✓" : "△"}</span>{t(check.message)}</p>)}</div>
      <McpConnectionProbe active={active} ready={!loading && info.status === "ready"} catalogRevision={revision} onBusyChange={busy => { probingNow.current = busy; setProbing(busy); }} />
      {config && <><div className="feature-card-title"><label className="fld grow"><span>{t("Client configuration")}</span><select value={config.id} onChange={event => setConfigId(event.target.value)}>{info.configs.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><CopyButton value={config.content} label="Copy configuration" /></div>{config.content ? <pre className="integration-code" tabIndex={0}>{config.content}</pre> : <p className="feature-inline-note">{t("Build and launch the desktop app to obtain a verified MCP helper path.")}</p>}</>}
    </section><div className="feature-grid">{info.capabilities.map(capability => <section className="feature-card integration-capability" key={capability.id}><h3>{t(capability.label)}</h3><p>{t(capability.description)}</p><div className="feature-actions">{capability.engines.map(engine => <span className="feature-badge" key={engine}>{engine}</span>)}</div></section>)}</div>
    <section className="feature-card"><span className="feature-eyebrow">{t("Try a workflow")}</span><h3>{t("Start with a clear instruction")}</h3><div className="workflow-list">{info.workflows.map(workflow => <div key={workflow.id}><strong>{t(workflow.label)}</strong><p>{t(workflow.prompt)}</p><CopyButton value={t(workflow.prompt)} label="Copy prompt" /></div>)}</div></section></>}
  </div>;
}

interface RuntimeDownloadStatusProps {
  runtimeDownloads?: readonly RuntimeDownload[];
  runtimeDownloadsStale?: boolean;
}

function UpdatesPanel({ signedUpdateStartup, active = true, runtimeDownloads, runtimeDownloadsStale }: RuntimeDownloadStatusProps & { signedUpdateStartup?: SignedUpdateStartupController; active?: boolean }) {
  const { t } = useTranslation(); const [settings, setSettings] = useState<AppSettings | null>(null), [result, setResult] = useState<UpdateResult | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const begin = usePanelTasks(), draftRevision = useRef(0), historyRevision = useRef(0);
  const [dirty, setDirty] = useState(false);
  useDesktopCloseDraft("update-settings", { dirty, busy });
  const [settingsLoading, setSettingsLoading] = useState(true), [settingsError, setSettingsError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState<string | null>(null);
  async function loadSettings() {
    const task = begin("settings"); if (!task) return;
    setSettingsLoading(true); setSettingsError(null);
    try { const value = await fetchSettings(); if (task.current()) setSettings(value); }
    catch (error) { if (task.current()) setSettingsError(message(error)); }
    finally { if (task.current()) setSettingsLoading(false); task.finish(); }
  }
  async function loadHistory() {
    const task = begin("history"); if (!task) return;
    const draft = draftRevision.current, history = historyRevision.current;
    setHistoryLoading(true); setHistoryError(null);
    try { const value = await fetchLastUpdate(); if (task.current() && draft === draftRevision.current && history === historyRevision.current) setResult(value); }
    catch (error) { if (task.current() && history === historyRevision.current) setHistoryError(message(error)); }
    finally { if (task.current()) setHistoryLoading(false); task.finish(); }
  }
  useEffect(() => { void loadSettings(); void loadHistory(); }, []);
  async function save(check = false) {
    if (!settings) return;
    const task = begin("mutation"); if (!task) return;
    historyRevision.current++; setResult(null); setHistoryError(null); setBusy(true); setError(null); setSaved(false);
    try {
      const value = await patchSettings({ updates: settings.updates }); if (!task.current()) return;
      setSettings(value); setSaved(true); setDirty(false);
      if (check) { const update = await checkForUpdate(); if (task.current()) setResult(update); }
    } catch (error) { if (task.current()) setError(message(error)); }
    finally { if (task.current()) setBusy(false); task.finish(); }
  }
  function edit(updates: Partial<AppSettings["updates"]>) { draftRevision.current++; setSettings(previous => previous ? { ...previous, updates: { ...previous.updates, ...updates } } : null); setSaved(false); setDirty(true); setResult(null); }
  const matchingResult = settings && result?.repository === settings.updates.repository && result?.channel === settings.updates.channel ? result : null;
  const labels = { "not-configured": "Choose a release repository", "up-to-date": "No newer GitHub release", available: "New GitHub release found", error: "Could not read GitHub releases" };
  return <div className="feature-panel"><Heading kind="updates" title="App updates" description="Review trusted app updates and follow release announcements." /><p className="feature-inline-note updates-source-note">{t("Install this app from its publisher's trusted channel below. The optional GitHub repository is for release announcements and does not change the installation source.")}</p>{active && <SignedUpdateCard startup={signedUpdateStartup} />}<Alert error={error} /><Alert error={settingsError} />
    {!settings && <div className="feature-actions"><button type="button" className="btn" disabled={settingsLoading} aria-busy={settingsLoading} onClick={() => void loadSettings()}>{t(settingsLoading ? "Loading…" : "Retry settings")}</button></div>}{settings && <section className="feature-card github-announcements"><div className="feature-card-title"><div><h3>{t("GitHub release announcements")}</h3><p>{t("Follow a repository for release notes. Changing this repository does not enable app installation.")}</p></div><span className="feature-badge">GitHub Releases</span></div>
      <label className="fld"><span>{t("Release repository")}</span><input spellCheck={false} autoComplete="off" placeholder="owner/repository" value={settings.updates.repository} disabled={busy} onChange={event => edit({ repository: event.target.value })} /><small>{t("Use owner/repository. No repository is selected by default.")}</small></label>
      <label className="fld"><span>{t("Release channel")}</span><select value={settings.updates.channel} disabled={busy} onChange={event => edit({ channel: event.target.value as "stable" | "beta" })}><option value="stable">{t("Stable releases")}</option><option value="beta">{t("Include prereleases")}</option></select></label>
      <label className="feature-toggle"><span><strong>{t("Check on startup")}</strong><small>{t("Check the configured GitHub repository when this workspace opens.")}</small></span><input type="checkbox" role="switch" checked={settings.updates.checkOnStartup} disabled={busy} onChange={event => edit({ checkOnStartup: event.target.checked })} /></label>
      <div className="feature-actions"><button className="btn" type="button" disabled={busy} onClick={() => void save()}>{t("Save settings")}</button><button className="btn primary" type="button" disabled={busy || !settings.updates.repository.trim()} onClick={() => void save(true)}>{t(busy ? "Checking…" : "Save & check for updates")}</button>{saved && <span className="feature-success" role="status">{t("Saved")}</span>}{dirty && <span className="feature-inline-note" role="status">{t("Changes not saved")}</span>}</div>
    </section>}
    <section className="feature-card"><div className="feature-card-title"><div><h3>{t("Last GitHub check")}</h3><p>{t("Read the last check from this session without contacting GitHub.")}</p></div><button type="button" className="btn" disabled={historyLoading || busy} aria-busy={historyLoading} onClick={() => void loadHistory()}>{t(historyLoading ? "Loading…" : "Reload last check")}</button></div><Alert error={historyError} /></section>
    {matchingResult && <section className="feature-card update-result" aria-live="polite"><span className={`feature-badge ${matchingResult.status === "available" || matchingResult.status === "up-to-date" ? "positive" : ""}`}>{t(labels[matchingResult.status])}</span><h3>{matchingResult.latest?.name || `${t("Current version")} ${matchingResult.currentVersion}`}</h3>{matchingResult.error && <p className="feature-alert">{t(matchingResult.error)}</p>}<p>{t("Current version")}: {matchingResult.currentVersion}{matchingResult.latest ? ` → ${matchingResult.latest.version}` : ""}</p><p className="muted">{matchingResult.repository} · {t(matchingResult.channel === "stable" ? "Stable releases" : "Include prereleases")} · {t("Last checked")}: {date(matchingResult.checkedAt)}</p>{matchingResult.latest && <><pre className="release-notes">{matchingResult.latest.notes || t("No release notes provided.")}</pre><a className="btn primary" href={matchingResult.latest.url} target="_blank" rel="noreferrer">{t("View release on GitHub")} ↗</a><p className="feature-inline-note">{t("Review the publisher and release assets before installing. Automatic installation requires a signed release channel.")}</p></>}</section>}
    {active && <BrowserRuntimeSettings downloads={runtimeDownloads} downloadStatusUnavailable={runtimeDownloadsStale} />}
  </div>;
}

interface SyncPanelProps { onProfilesImported?: () => Promise<void>; onLocateSnapshotProfile?: (id: string) => void; }
interface SnapshotReview { file: SyncFileRecord; revision: number; preview: SyncPreview; previewHash: string; }
interface SnapshotImportResult {
  kind: "imported";
  fileName: string;
  completedAt: number;
  counts: { imported: number; skipped: number };
  profiles: { id: string; name: string }[];
  refresh: "pending" | "ready" | "failed";
}
type SnapshotCompletion = SnapshotImportResult | { kind: "created"; completedAt: number; profileCount: number };
type SnapshotFocus = "password" | "preview" | "review" | "result";
const snapshotReceiptPageSize = 10;
function sameSnapshotFile(left: SyncFileRecord, right: SyncFileRecord) {
  return left.fileName === right.fileName && left.createdAt === right.createdAt && left.modifiedAt === right.modifiedAt && left.bytes === right.bytes && left.sha256 === right.sha256;
}
function SyncPanel({ onProfilesImported, onLocateSnapshotProfile, active = true }: SyncPanelProps & { active?: boolean }) {
  const { t } = useTranslation(); const [settings, setSettings] = useState<AppSettings | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(true), [saved, setSaved] = useState(false);
  const begin = usePanelTasks();
  const workspaceOperations = useOptionalWorkspaceOperations(), coordinator = workspaceOperations?.coordinator;
  const [files, setFiles] = useState<SyncFileRecord[]>([]), [fileName, setFileName] = useState(""), [password, setPassword] = useState(""), [dirty, setDirty] = useState(false), [preview, setPreview] = useState<SnapshotReview | null>(null);
  const [completion, setCompletion] = useState<SnapshotCompletion | null>(null), [receiptPage, setReceiptPage] = useState(0);
  const [reviewFileChanged, setReviewFileChanged] = useState(false);
  const [operation, setOperation] = useState<"load" | "files" | "save" | "create" | "preview" | "import" | "import-refresh" | "receipt-refresh" | null>("load"), [filesError, setFilesError] = useState<string | null>(null);
  const selectedFile = useRef(fileName), reviewRevision = useRef(0), verifiedFiles = useRef<SyncFileRecord[] | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null), previewButton = useRef<HTMLButtonElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterOperation = useRef<{ target: SnapshotFocus; origin: Element | null; revision: number } | null>(null);
  const activePage = useRef(active); activePage.current = active;
  const activation = useRef(0), filesPending = useRef(false), reviewId = React.useId(), resultId = React.useId();
  const renderedRevision = reviewRevision.current;
  const listedFile = files.find(file => file.fileName === fileName);
  const matchingReview = preview && preview.revision === renderedRevision && listedFile && sameSnapshotFile(preview.file, listedFile) ? preview : null;
  useDesktopCloseDraft("sync-settings", { dirty: dirty || password.length > 0 || !!matchingReview, busy: busy && (operation === "save" || operation === "create" || operation === "import" || operation === "import-refresh") });
  React.useLayoutEffect(() => {
    if (!active) { activation.current++; focusAfterOperation.current = null; }
  }, [active]);
  React.useLayoutEffect(() => {
    const request = focusAfterOperation.current;
    if (!active || busy || !request) return;
    focusAfterOperation.current = null;
    if (request.revision !== reviewRevision.current || (document.activeElement !== document.body && document.activeElement !== request.origin)) return;
    const target = request.target === "result" ? resultHeading.current : request.target === "review" ? reviewHeading.current : request.target === "password" ? passwordInput.current : previewButton.current;
    target?.focus({ preventScroll: request.target === "password" || request.target === "preview" });
  }, [busy, active]);
  useEffect(() => { if (active && !busy && !dirty && settings?.sync.enabled && filesPending.current) void refresh(); }, [active, busy, dirty, settings?.sync.enabled]);
  async function loadSettings() {
    const task = begin("work"); if (!task) return;
    setBusy(true); setOperation("load"); setError(null);
    try { const value = await fetchSettings(); if (!task.current()) return; setSettings(value); if (value.sync.enabled) await reloadFiles(task); }
    catch (error) { if (task.current()) setError(message(error)); }
    finally { if (task.current()) { setBusy(false); setOperation(null); } task.finish(); }
  }
  useEffect(() => { void loadSettings(); }, []);
  function invalidateReview(fileChanged = false) {
    focusAfterOperation.current = null;
    setPreview(null);
    setReviewFileChanged(fileChanged);
    return ++reviewRevision.current;
  }
  function chooseFile(next: string) {
    selectedFile.current = next;
    setFileName(next);
    invalidateReview();
  }
  function editPassword(next: string) {
    setPassword(next);
    invalidateReview();
  }
  function clearFiles() {
    verifiedFiles.current = null;
    chooseFile("");
    setFiles([]);
    setFilesError(null);
  }
  function edit(sync: Partial<AppSettings["sync"]>) {
    setSettings(previous => previous ? { ...previous, sync: { ...previous.sync, ...sync } } : null);
    setSaved(false);
    setDirty(true);
    if ("folder" in sync) { clearFiles(); setCompletion(null); }
    else invalidateReview();
  }
  async function reloadFiles(task: PanelTask) {
    if (!task.current()) return;
    verifiedFiles.current = null;
    // A late settings/save result may arrive after its tab was hidden. Read the
    // snapshot folder once when the user returns, rather than from a hidden panel.
    if (!activePage.current) { filesPending.current = true; return; }
    filesPending.current = false;
    setFilesError(null);
    try {
      const value = await fetchSyncFiles();
      if (!task.current()) return;
      const selected = value.find(file => file.fileName === selectedFile.current);
      if (selectedFile.current && !selected) chooseFile("");
      else if (selected && matchingReview && matchingReview.revision === reviewRevision.current && !sameSnapshotFile(matchingReview.file, selected)) invalidateReview(true);
      setFiles(value);
      verifiedFiles.current = value;
    }
    catch (error) { if (task.current()) setFilesError(message(error)); }
  }
  async function refresh() {
    const task = begin("work"); if (!task) return;
    setBusy(true); setOperation("files");
    try { await reloadFiles(task); }
    finally { if (task.current()) { setBusy(false); setOperation(null); } task.finish(); }
  }
  async function save() {
    if (!settings) return;
    const task = begin("work"); if (!task) return;
    setBusy(true); setOperation("save"); setError(null);
    try {
      const value = await patchSettings({ sync: settings.sync }); if (!task.current()) return;
      setSettings(value); setSaved(true); setDirty(false);
      if (!value.sync.enabled || value.sync.folder !== settings.sync.folder) clearFiles();
      if (value.sync.enabled) await reloadFiles(task);
    } catch (error) { if (task.current()) setError(message(error)); }
    finally { if (task.current()) { setBusy(false); setOperation(null); } task.finish(); }
  }
  async function refreshImportViews(lease: WorkspaceOperationLease | null) {
    if (lease) coordinator?.setPhase(lease, "refreshing");
    const refreshed = await Promise.allSettled([
      Promise.resolve().then(() => onProfilesImported?.()),
      lease ? coordinator?.refreshWorkspaceViews(lease) : Promise.resolve(),
    ]);
    return refreshed.every(item => item.status === "fulfilled");
  }
  async function retryImportRefresh(receipt: SnapshotImportResult) {
    if (!activePage.current || busy || completion !== receipt || receipt.refresh !== "failed") return;
    const task = begin("work"); if (!task) return;
    const lease = coordinator?.acquire("profile-import") ?? null;
    if (coordinator && !lease) { task.finish(); setError(workspaceOperationMessage(coordinator.getSnapshot())); return; }
    const revision = reviewRevision.current, startedActivation = activation.current, origin = document.activeElement;
    const pending: SnapshotImportResult = { ...receipt, refresh: "pending" };
    setBusy(true); setOperation("receipt-refresh"); setError(null); setCompletion(pending);
    try {
      const ready = await refreshImportViews(lease);
      if (!task.current()) return;
      setCompletion(previous => previous === pending ? { ...pending, refresh: ready ? "ready" : "failed" } : previous);
      if (activePage.current && activation.current === startedActivation) focusAfterOperation.current = { target: "result", origin, revision };
    } finally {
      if (lease) coordinator?.release(lease);
      if (task.current()) { setBusy(false); setOperation(null); }
      task.finish();
    }
  }
  async function operate(kind: "create" | "preview" | "import") {
    if (!activePage.current || locked || renderedRevision !== reviewRevision.current || !passwordReady) return;
    // The displayed list may lag a read or an input event by one render.
    const currentFile = verifiedFiles.current?.find(file => file.fileName === selectedFile.current);
    const file = currentFile && listedFile && sameSnapshotFile(currentFile, listedFile) ? currentFile : null;
    const review = matchingReview;
    if (kind === "preview" && !file || kind === "import" && (!file || !review || review.preview.newCount === 0)) return;
    const task = begin("work"); if (!task) return;
    const lease = kind === "import" ? coordinator?.acquire("profile-import") : null;
    if (kind === "import" && coordinator && !lease) { task.finish(); setError(workspaceOperationMessage(coordinator.getSnapshot())); return; }
    const revision = renderedRevision, startedActivation = activation.current, origin = document.activeElement;
    const queueFocus = (target: SnapshotFocus, currentRevision: number) => {
      if (activePage.current && activation.current === startedActivation) focusAfterOperation.current = { target, origin, revision: currentRevision };
    };
    setBusy(true); setOperation(kind); setError(null);
    try {
      if (kind === "create") {
        const result = await createSyncFile(password);
        if (!task.current()) return;
        if (revision === reviewRevision.current) editPassword("");
        setCompletion({ kind: "created", completedAt: Date.now(), profileCount: result.profileCount });
        await reloadFiles(task);
      } else if (kind === "preview" && file) {
        setReviewFileChanged(false);
        const result = await previewSyncFile(file.fileName, password);
        if (!task.current() || revision !== reviewRevision.current) return;
        setPreview({ ...result, file, revision });
        queueFocus("review", revision);
      } else if (review) {
        const result = await importSyncFile(review.file.fileName, password, review.previewHash);
        if (!task.current()) return;
        if (revision === reviewRevision.current) editPassword("");
        const completedRevision = reviewRevision.current;
        // The server binds the exact additions to the preview token. When a
        // response disagrees with the review, keep counts without guessing IDs.
        const profiles = result.imported === review.preview.newCount && result.skipped === review.preview.conflictCount
          ? review.preview.profiles.filter(profile => !profile.conflict).map(({ id, name }) => ({ id, name })) : [];
        const receipt: SnapshotImportResult = { kind: "imported", fileName: review.file.fileName, completedAt: Date.now(), counts: { imported: result.imported, skipped: result.skipped }, profiles, refresh: "pending" };
        setCompletion(receipt); setReceiptPage(0);
        setOperation("import-refresh");
        const ready = await refreshImportViews(lease ?? null);
        if (!task.current()) return;
        setCompletion(previous => previous === receipt ? { ...receipt, refresh: ready ? "ready" : "failed" } : previous);
        queueFocus("result", completedRevision);
      }
    } catch (error) {
      if (!task.current() || kind === "preview" && revision !== reviewRevision.current) return;
      const detail = message(error);
      setError(detail);
      if (kind === "preview") queueFocus("password", invalidateReview());
      else if (kind === "import" && detail === "Preview this snapshot again before importing" && revision === reviewRevision.current) queueFocus("preview", invalidateReview());
    } finally {
      if (lease) coordinator?.release(lease);
      if (task.current()) { setBusy(false); setOperation(null); }
      task.finish();
    }
  }
  const locked = busy || dirty || !settings?.sync.enabled;
  const restoreLocked = locked || !verifiedFiles.current;
  const passwordReady = Array.from(password).length >= 10;
  const receiptPages = completion?.kind === "imported" ? Math.ceil(completion.profiles.length / snapshotReceiptPageSize) : 0;
  const phases = { load: "Loading snapshot settings…", files: "Refreshing snapshot files…", save: "Saving folder settings…", create: "Encrypting and saving your snapshot…", preview: "Unlocking snapshot preview…", import: "Importing new profiles…", "import-refresh": "Refreshing environment lists…", "receipt-refresh": "Refreshing environment lists…" };
  return <div className="feature-panel"><Heading kind="sync" title="Sync & portability" description="Keep encrypted profile snapshots in a folder you control." />
    {settings && <section className="feature-card sync-status-summary" aria-label={t("Snapshot status")}><div className="feature-card-title"><div><h3>{t("Your snapshot storage")}</h3><p>{t("Snapshots are saved when you choose. Your own sync app can copy this folder between devices.")}</p></div><span className={`feature-badge ${settings.sync.enabled && !dirty && !filesError ? "positive" : ""}`}>{t(dirty ? "Changes not saved" : !settings.sync.enabled ? "Snapshots disabled" : filesError ? "Folder needs attention" : "Manual snapshots enabled")}</span></div>{settings.sync.folder && <p className="sync-folder-path mono">{settings.sync.folder}</p>}<p className="feature-inline-note">{t("This app saves encrypted files locally. Cloud upload and availability on other devices are managed by your sync app.")}</p></section>}
    {operation && <div className="sync-operation" role="status" aria-live="polite"><progress aria-label={t(phases[operation])} /><span>{t(phases[operation])}</span></div>}
    {completion?.kind === "created" && <div className="sync-last-result" role="status"><span>{t("Last completed action in this session")} · {date(completion.completedAt)}</span><strong>{t("Encrypted snapshot saved · {count} profiles", { count: completion.profileCount })}</strong></div>}
    {completion?.kind === "imported" && <section className="sync-last-result sync-import-receipt" aria-labelledby={resultId}>
      <span>{t("Last completed action in this session")} · {date(completion.completedAt)}</span>
      <h3 id={resultId} ref={resultHeading} tabIndex={-1}>{t("Import result")}</h3>
      <strong role="status">{t("{imported} imported · {skipped} skipped", completion.counts)}</strong>
      <code>{completion.fileName}</code>
      {completion.refresh === "failed" && <div className="feature-alert sync-import-refresh-error" role="alert">
        <p>{t("Profiles were imported, but the lists could not refresh. Refresh environments to see the result.")}</p>
        <button className="btn xs" type="button" disabled={busy || workspaceOperations?.snapshot.blocked === true} onClick={() => void retryImportRefresh(completion)}>{t("Refresh environments")}</button>
      </div>}
      {!!receiptPages && <details className="sync-receipt-profiles" key={completion.completedAt}>
        <summary>{t("Imported environments")}</summary>
        <ul>{completion.profiles.slice(receiptPage * snapshotReceiptPageSize, (receiptPage + 1) * snapshotReceiptPageSize).map(profile => <li key={profile.id}>
          <span>{profile.name || profile.id}</span>
          {onLocateSnapshotProfile && <button className="btn xs ghost" type="button" aria-label={t("Locate {profile} in list", { profile: profile.name || profile.id })} disabled={completion.refresh !== "ready"} onClick={() => { if (activePage.current && completion.refresh === "ready") onLocateSnapshotProfile(profile.id); }}>{t("Locate in list")}</button>}
        </li>)}</ul>
        {receiptPages > 1 && <div className="sync-receipt-pagination">
          <span>{t("Page {page} / {pages}", { page: receiptPage + 1, pages: receiptPages })}</span>
          <button className="btn xs ghost" type="button" disabled={receiptPage === 0} onClick={() => setReceiptPage(page => Math.max(0, page - 1))}>{t("Previous")}</button>
          <button className="btn xs ghost" type="button" disabled={receiptPage + 1 >= receiptPages} onClick={() => setReceiptPage(page => Math.min(receiptPages - 1, page + 1))}>{t("Next")}</button>
        </div>}
      </details>}
    </section>}
    <Alert error={error} />
    {!settings && <div className="feature-actions"><button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => void loadSettings()}>{t(busy ? "Loading…" : "Retry settings")}</button></div>}{settings && <section className="feature-card"><div className="feature-card-title"><div><h3>{t("Your folder, your storage")}</h3><p>{t("Use a local folder, an external drive, or a folder managed by OneDrive or Syncthing.")}</p></div><span className="feature-badge">{t("Encrypted snapshots")}</span></div>
      <label className="fld"><span>{t("Sync folder")}</span><input spellCheck={false} value={settings.sync.folder} placeholder={"C:\\Users\\you\\OneDrive\\Maobu"} disabled={busy} onChange={event => edit({ folder: event.target.value })} /><small>{t("Enter an absolute path. Your sync client transports the encrypted files.")}</small></label>
      <label className="fld"><span>{t("Snapshots to retain")}</span><input type="number" min={1} max={100} value={settings.sync.retainSnapshots} disabled={busy} onChange={event => edit({ retainSnapshots: Number(event.target.value) })} /></label>
      <label className="feature-toggle"><span><strong>{t("Enable folder snapshots")}</strong><small>{t("Save snapshots manually; each snapshot keeps an independent copy.")}</small></span><input type="checkbox" role="switch" checked={settings.sync.enabled} disabled={busy} onChange={event => edit({ enabled: event.target.checked })} /></label>
      <div className="feature-actions"><button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{t(operation === "save" ? "Saving…" : "Save settings")}</button>{saved && <span className="feature-success" role="status">{t("Saved")}</span>}</div>
    </section>}
    {settings?.sync.enabled && <section className="feature-card"><div className="feature-card-title"><div><h3>{t("Encrypted profile snapshots")}</h3><p>{t("Your password encrypts each snapshot and is never stored by this app.")}</p></div><button className="btn xs" type="button" disabled={locked} onClick={() => void refresh()}>{t("Refresh files")}</button></div>
      {filesError && <div className="feature-alert sync-files-error" role="alert"><strong>{t("Could not refresh snapshot files. Previous files and your input are kept.")}</strong><p>{t(filesError)}</p><button className="btn xs" type="button" disabled={locked} onClick={() => void refresh()}>{t("Retry file list")}</button></div>}
      {!busy && !filesError && !files.length && <p className="feature-inline-note">{t("No snapshots yet. Create one here, or wait for your sync app to copy files into this folder and refresh.")}</p>}
      {dirty && <p className="feature-inline-note">{t("Save folder changes before working with snapshots.")}</p>}
      <label className="fld"><span>{t("Snapshot password")}</span><input ref={passwordInput} type="password" autoComplete="new-password" value={password} disabled={locked} onChange={event => editPassword(event.target.value)} /><small>{t("Use at least 10 characters. Keep your password to restore on another device.")}</small></label>
      <div className="feature-actions"><button className="btn primary" type="button" disabled={locked || !passwordReady} onClick={() => void operate("create")}>{t(operation === "create" ? "Encrypting snapshot…" : "Create encrypted snapshot")}</button></div>
      <div className="sync-restore">
        <h3>{t("Restore from your folder")}</h3>
        <label className="fld"><span>{t("Snapshot file")}</span><select value={fileName} disabled={restoreLocked} onChange={event => chooseFile(event.target.value)}><option value="">{t("Select a snapshot")}</option>{files.map(file => <option key={file.fileName} value={file.fileName}>{date(file.createdAt)} · {(file.bytes / 1024).toFixed(1)} KB · {file.fileName.slice(-23)}</option>)}</select></label>
        <div className="feature-actions"><button ref={previewButton} className="btn" type="button" disabled={restoreLocked || !listedFile || !passwordReady} onClick={() => void operate("preview")}>{t("Preview snapshot")}</button><span className="muted">{t("Matching environment IDs in the list, Trash, or running browser records are skipped.")}</span></div>
        {reviewFileChanged && <p className="feature-inline-note" role="status">{t("The snapshot file changed. Preview it again before importing.")}</p>}
        {matchingReview && <section className="sync-preview" aria-labelledby={reviewId}>
          <header className="sync-review-file">
            <h4 id={reviewId} ref={reviewHeading} tabIndex={-1}>{t("Review snapshot")}</h4>
            <p><time>{date(matchingReview.file.createdAt)}</time> · <code>{matchingReview.file.fileName}</code></p>
          </header>
          <div className="feature-result-meta"><strong>{t("{count} new profiles", { count: matchingReview.preview.newCount })}</strong><span>{t("{count} conflicts skipped", { count: matchingReview.preview.conflictCount })}</span></div>
          <ul>{matchingReview.preview.profiles.map(profile => <li key={profile.id}><span>{profile.name || profile.id}</span><span className="feature-badge">{t(profile.conflict ? "Conflict · skip" : "New profile")}</span></li>)}</ul>
          {workspaceOperations?.snapshot.blocked && operation !== "import" && operation !== "import-refresh" && <p className="feature-inline-note" role="status">{t(workspaceOperationMessage(workspaceOperations.snapshot))}</p>}
          {matchingReview.preview.newCount === 0 ? <p className="feature-inline-note" role="status">{t("There are no new environments in this snapshot. Choose another snapshot or check the environment list and Trash for the originals.")}</p>
            : <button className="btn primary" type="button" disabled={restoreLocked || workspaceOperations?.snapshot.blocked === true} onClick={() => void operate("import")}>{t("Import new profiles")}</button>}
        </section>}
      </div>
    </section>}
    <section className="feature-card"><h3>{t("Portable profiles, recoverable workspaces")}</h3><p>{t("Profile snapshots carry saved configuration and sessions. Full workspace backups also include browser storage, extensions and scripts; manage them from Workspace management.")}</p><p className="feature-inline-note">{t("Close profiles before capturing complete browser storage. A saved session only contains data captured by this app.")}</p></section>
  </div>;
}

type FeatureSettingsPanelProps = FingerprintsPanelProps & NetworkPanelProps & SyncPanelProps & RuntimeDownloadStatusProps & { tab: FeatureSettingsTab | null; sessionKey?: string | null; onOpenAssistant?: () => void; signedUpdateStartup?: SignedUpdateStartupController };

/** Keep editable settings in this workspace's tab session, without mounting unvisited panels. */
function FeatureSettingsSession({ tab, sessionKey, onOpenAssistant, onCreateWithLocalProxy, onAssignLocalProxy, onResumeLocalProxyAssignment, localProxyAssignmentBlocked, signedUpdateStartup, onProfilesImported, onLocateSnapshotProfile, runtimeDownloads, runtimeDownloadsStale, ...fingerprints }: FeatureSettingsPanelProps) {
  const visited = useRef(new Set<Exclude<FeatureSettingsTab, "fingerprints">>());
  if (tab && tab !== "fingerprints") visited.current.add(tab);
  return <>
    {visited.current.has("sync") && <div key="sync" className="feature-settings-section" data-feature-settings-tab="sync" hidden={tab !== "sync"} inert={tab !== "sync" || undefined}><SyncPanel active={tab === "sync"} onProfilesImported={onProfilesImported} onLocateSnapshotProfile={onLocateSnapshotProfile} /></div>}
    {visited.current.has("updates") && <div key="updates" className="feature-settings-section" data-feature-settings-tab="updates" hidden={tab !== "updates"} inert={tab !== "updates" || undefined}><UpdatesPanel active={tab === "updates"} signedUpdateStartup={signedUpdateStartup} runtimeDownloads={runtimeDownloads} runtimeDownloadsStale={runtimeDownloadsStale} /></div>}
    {visited.current.has("network") && <div key="network" className="feature-settings-section" data-feature-settings-tab="network" hidden={tab !== "network"} inert={tab !== "network" || undefined}><NetworkPanel onCreateWithLocalProxy={onCreateWithLocalProxy} onAssignLocalProxy={onAssignLocalProxy} onResumeLocalProxyAssignment={onResumeLocalProxyAssignment} localProxyAssignmentBlocked={localProxyAssignmentBlocked} /></div>}
    {tab === "fingerprints" && <FingerprintsPanel {...fingerprints} />}
    {visited.current.has("models") && <div key="models" className="feature-settings-section" data-feature-settings-tab="models" hidden={tab !== "models"} inert={tab !== "models" || undefined}><ModelServicesPanel active={tab === "models"} workspaceId={sessionKey ?? null} /></div>}
    {visited.current.has("integrations") && <div key="integrations" className="feature-settings-section" data-feature-settings-tab="integrations" hidden={tab !== "integrations"} inert={tab !== "integrations" || undefined}><IntegrationsPanel active={tab === "integrations"} onOpenAssistant={onOpenAssistant} /></div>}
  </>;
}

export function FeatureSettingsPanel(props: FeatureSettingsPanelProps) {
  const workspace = useOptionalWorkspaceOperations();
  const workspaceId = props.sessionKey !== undefined ? props.sessionKey : workspace?.snapshot.workspaceId;
  if (workspace && !workspaceId) return <Loading />;
  return <FeatureSettingsSession key={workspaceId ?? "local"} {...props} sessionKey={workspaceId} />;
}
