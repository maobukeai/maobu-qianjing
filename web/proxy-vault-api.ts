/** Typed client for the local Proxy Vault (`/ui/api/proxy-vault*`) endpoints. */
import { getStandaloneSessionToken } from "./api.ts";

export type ProxyVaultProtocol = "http" | "https" | "socks5";
export type ProxyVaultStatus =
  | "unchecked"
  | "working"
  | "unstable"
  | "failed"
  | "unavailable"
  | "unsupported";
export type ProxyVaultRiskLevel = "none" | "medium" | "high";
export type ProxyVaultRiskCode =
  | "same_platform_binding"
  | "duplicate_exit_ip_same_platform"
  | "same_host_exit"
  | "shared_binding"
  | "duplicate_proxy"
  | "duplicate_exit_ip";
export type ProxyVaultImportStrategy = "skip_duplicates" | "update_existing";
export type ProxyVaultBindMode = "single" | "round_robin";

export interface ProxyVaultRiskItem {
  code: ProxyVaultRiskCode;
  level: "high" | "medium";
  platform?: string;
  profileIds?: string[];
  otherProxyIds?: string[];
  exitIp?: string;
  message?: string;
}

export interface ProxyVaultBoundProfile {
  profileId: string;
  name: string;
  group: string;
  platform: string;
  running: boolean;
  drifted: boolean;
  boundAt: number;
}

export interface ProxyVaultEntry {
  id: string;
  name: string;
  group: string;
  type: ProxyVaultProtocol;
  host: string;
  port: number;
  hasAuth: boolean;
  hasRefreshUrl: boolean;
  refreshUrlHost: string;
  notes: string;
  lastStatus: ProxyVaultStatus;
  lastReason: string;
  lastLatencyMs: number | null;
  lastExitIp: string;
  lastExitCountry: string;
  lastExitRegion: string;
  lastExitCity: string;
  lastExitRotating: boolean;
  lastExitComparison: "" | "same" | "different" | "unknown";
  lastCheckedAt: number;
  lastRefreshedAt: number;
  createdAt: number;
  updatedAt: number;
  boundProfiles: ProxyVaultBoundProfile[];
  riskLevel: ProxyVaultRiskLevel;
  risks: ProxyVaultRiskItem[];
}

export interface ProxyVaultEditView extends ProxyVaultEntry {
  user: string;
  pass: string;
  refreshUrl: string;
}

export interface ProxyVaultUpsertInput {
  name?: string;
  group?: string;
  type: ProxyVaultProtocol;
  host: string;
  port: number;
  user?: string;
  pass?: string;
  clearAuth?: boolean;
  refreshUrl?: string;
  clearRefreshUrl?: boolean;
  notes?: string;
}

export interface ProxyVaultListFilters {
  group?: string;
  q?: string;
  risk?: "all" | "high" | "medium" | "any";
}

export interface ProxyVaultListResult {
  entries: ProxyVaultEntry[];
  groups: string[];
}

export interface ProxyVaultImportPreviewRow {
  line: number;
  status: "new" | "duplicate" | "invalid";
  name?: string;
  group?: string;
  type?: ProxyVaultProtocol;
  host?: string;
  port?: number;
  hasAuth?: boolean;
  hasRefreshUrl?: boolean;
  reason?: string;
  existingId?: string;
}

export interface ProxyVaultImportPreview {
  total: number;
  valid: number;
  newCount: number;
  duplicateCount: number;
  invalidCount: number;
  rows: ProxyVaultImportPreviewRow[];
}

export interface ProxyVaultImportApplyResult {
  inserted: number;
  updated: number;
  skipped: number;
  invalid: number;
}

export type ProxyVaultCheckEvent =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; entry: ProxyVaultEntry }
  | { type: "done"; checked?: number }
  | { type: "error"; error?: string };

export interface ProxyVaultRefreshIpResult {
  entry?: ProxyVaultEntry;
  refreshedAt: number;
  exitIp?: string;
  latencyMs?: number | null;
  rechecked?: boolean;
  cooldownRemainingMs?: number;
}

export interface ProxyVaultBindRequest {
  proxyIds: string[];
  profileIds: string[];
  mode: ProxyVaultBindMode;
  profilesPerProxy?: number;
  confirmRisk?: boolean;
}

export interface ProxyVaultBindResult {
  updated: number;
  skippedRunning: number;
  updatedIds: string[];
  skippedIds: string[];
  riskSummary: {
    high: number;
    medium: number;
    warnings: ProxyVaultRiskItem[];
  };
}

export interface ProxyVaultSyncBoundResult {
  updated: number;
  skippedRunning: number;
}

export interface ProxyVaultIngestResult {
  ingested: number;
  skippedDuplicates: number;
  bound: number;
}

export class ProxyVaultError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly cooldownRemainingMs?: number;
  constructor(
    message: string,
    options?: { status?: number; code?: string; cooldownRemainingMs?: number },
  ) {
    super(message);
    this.name = "ProxyVaultError";
    this.status = options?.status ?? 0;
    this.code = options?.code;
    this.cooldownRemainingMs = options?.cooldownRemainingMs;
  }
}

const VALID_PROTOCOLS = new Set<string>(["http", "https", "socks5"]);
const VALID_STATUSES = new Set<string>([
  "unchecked",
  "working",
  "unstable",
  "failed",
  "unavailable",
  "unsupported",
]);
const VALID_RISK_LEVELS = new Set<string>(["none", "medium", "high"]);
const VALID_RISK_CODES = new Set<string>([
  "same_platform_binding",
  "duplicate_exit_ip_same_platform",
  "same_host_exit",
  "shared_binding",
  "duplicate_proxy",
  "duplicate_exit_ip",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

/** Scrub credentials and URL tokens from client-facing error messages. */
export function sanitizeVaultMessage(raw: string): string {
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/((?:\[[^\]]+\]|[a-z0-9._-]+):\d{1,5}):[^:\s;,]+:[^\s;,]+/gi, "$1:[redacted]")
    .slice(0, 400);
}

function normalizeRiskItem(raw: unknown): ProxyVaultRiskItem | null {
  if (!isRecord(raw)) return null;
  const code = asString(raw.code);
  const level = asString(raw.level ?? raw.severity);
  if (!VALID_RISK_CODES.has(code) || (level !== "high" && level !== "medium")) return null;
  const item: ProxyVaultRiskItem = {
    code: code as ProxyVaultRiskCode,
    level,
  };
  if (typeof raw.platform === "string" && raw.platform) item.platform = raw.platform;
  if (Array.isArray(raw.profileIds)) {
    item.profileIds = raw.profileIds.filter((id): id is string => typeof id === "string");
  } else if (Array.isArray(raw.profiles)) {
    const ids = raw.profiles
      .filter(isRecord)
      .map((profile) => asString(profile.id ?? profile.profileId))
      .filter(Boolean);
    if (ids.length > 0) item.profileIds = ids;
  }
  const related = Array.isArray(raw.otherProxyIds)
    ? raw.otherProxyIds
    : Array.isArray(raw.relatedProxyIds)
      ? raw.relatedProxyIds
      : null;
  if (related) {
    item.otherProxyIds = related.filter((id): id is string => typeof id === "string");
  }
  if (typeof raw.exitIp === "string" && raw.exitIp) item.exitIp = raw.exitIp;
  if (typeof raw.message === "string" && raw.message) item.message = sanitizeVaultMessage(raw.message);
  return item;
}

function normalizeBoundProfile(raw: unknown): ProxyVaultBoundProfile | null {
  if (!isRecord(raw)) return null;
  const profileId = asString(raw.profileId ?? raw.id);
  if (!profileId) return null;
  const drifted =
    raw.drifted !== undefined
      ? asBool(raw.drifted)
      : raw.outOfSync !== undefined
        ? asBool(raw.outOfSync)
        : raw.inSync !== undefined
          ? !asBool(raw.inSync)
          : false;
  return {
    profileId,
    name: asString(raw.name, profileId),
    group: asString(raw.group),
    platform: asString(raw.platform),
    running: asBool(raw.running),
    drifted,
    boundAt: asFiniteNumber(raw.boundAt),
  };
}

export function normalizeProxyVaultEntry(raw: unknown): ProxyVaultEntry {
  if (!isRecord(raw)) throw new ProxyVaultError("Proxy vault returned invalid data.");
  const id = asString(raw.id);
  const protocol = asString(raw.type).toLowerCase();
  const host = asString(raw.host);
  const port = asFiniteNumber(raw.port, -1);
  if (!id || !VALID_PROTOCOLS.has(protocol) || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyVaultError("Proxy vault returned an invalid proxy entry.");
  }
  const rawStatus = asString(raw.lastStatus ?? raw.last_status, "unchecked");
  const lastStatus: ProxyVaultStatus = VALID_STATUSES.has(rawStatus)
    ? (rawStatus as ProxyVaultStatus)
    : "unchecked";
  const rawRisk = asString(raw.riskLevel ?? raw.risk_level, "none");
  const riskLevel: ProxyVaultRiskLevel = VALID_RISK_LEVELS.has(rawRisk)
    ? (rawRisk as ProxyVaultRiskLevel)
    : "none";
  const rawComparison = asString(raw.lastExitComparison ?? raw.last_exit_comparison);
  const lastExitComparison =
    rawComparison === "same" || rawComparison === "different" || rawComparison === "unknown"
      ? rawComparison
      : "";
  const latencyRaw = raw.lastLatencyMs ?? raw.last_latency_ms;
  const lastLatencyMs =
    typeof latencyRaw === "number" && Number.isFinite(latencyRaw) && latencyRaw >= 0
      ? Math.round(latencyRaw)
      : null;

  const rawBound = Array.isArray(raw.boundProfiles) ? raw.boundProfiles : [];
  const rawRisks = Array.isArray(raw.risks) ? raw.risks : [];

  return {
    id,
    name: asString(raw.name),
    group: asString(raw.group),
    type: protocol as ProxyVaultProtocol,
    host,
    port,
    hasAuth: asBool(raw.hasAuth ?? raw.has_auth),
    hasRefreshUrl: asBool(raw.hasRefreshUrl ?? raw.has_refresh_url),
    refreshUrlHost: asString(raw.refreshUrlHost ?? raw.refresh_url_host),
    notes: asString(raw.notes),
    lastStatus,
    lastReason: asString(raw.lastReason ?? raw.last_reason),
    lastLatencyMs,
    lastExitIp: asString(raw.lastExitIp ?? raw.last_exit_ip),
    lastExitCountry: asString(raw.lastExitCountry ?? raw.last_exit_country),
    lastExitRegion: asString(raw.lastExitRegion ?? raw.last_exit_region),
    lastExitCity: asString(raw.lastExitCity ?? raw.last_exit_city),
    lastExitRotating: asBool(raw.lastExitRotating ?? raw.last_exit_rotating),
    lastExitComparison,
    lastCheckedAt: asFiniteNumber(raw.lastCheckedAt ?? raw.last_checked_at),
    lastRefreshedAt: asFiniteNumber(raw.lastRefreshedAt ?? raw.last_refreshed_at),
    createdAt: asFiniteNumber(raw.createdAt ?? raw.created_at),
    updatedAt: asFiniteNumber(raw.updatedAt ?? raw.updated_at),
    boundProfiles: rawBound.map(normalizeBoundProfile).filter((item): item is ProxyVaultBoundProfile => item !== null),
    riskLevel,
    risks: rawRisks.map(normalizeRiskItem).filter((item): item is ProxyVaultRiskItem => item !== null),
  };
}

function buildHeaders(hasJsonBody: boolean, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (hasJsonBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStandaloneSessionToken();
  if (token && !headers.has("X-Maobu-Session") && !headers.has("Authorization")) {
    headers.set("X-Maobu-Session", token);
  }
  return headers;
}

async function vaultFetch(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; accept?: string } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined || method === "POST" || method === "PATCH" || method === "DELETE";
  return fetch(`/ui/api/proxy-vault${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: buildHeaders(hasBody, options.accept ? { Accept: options.accept } : undefined),
    ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function parseJsonEnvelope(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProxyVaultError(
      response.status === 404 || response.status === 501 || response.status === 503
        ? "Proxy vault is not available on this server."
        : "Proxy vault returned an invalid response.",
      { status: response.status },
    );
  }
  if (!isRecord(body)) {
    throw new ProxyVaultError("Proxy vault returned an invalid response.", { status: response.status });
  }
  if (!response.ok || body.ok === false) {
    const code = typeof body.code === "string" ? body.code : undefined;
    const rawCooldown = body.cooldownRemainingMs ?? body.retryAfterMs;
    const cooldownRemainingMs =
      typeof rawCooldown === "number" && Number.isFinite(rawCooldown)
        ? rawCooldown
        : undefined;
    if (response.status === 404 || response.status === 501 || response.status === 503) {
      throw new ProxyVaultError(
        typeof body.error === "string" && body.error.trim()
          ? sanitizeVaultMessage(body.error)
          : "Proxy vault is not available on this server.",
        { status: response.status, code, cooldownRemainingMs },
      );
    }
    const rawMsg = typeof body.error === "string" && body.error.trim()
      ? sanitizeVaultMessage(body.error)
      : "Proxy vault request failed.";
    throw new ProxyVaultError(rawMsg, { status: response.status, code, cooldownRemainingMs });
  }
  return body;
}

export function formatVaultEndpoint(entry: Pick<ProxyVaultEntry, "type" | "host" | "port">): string {
  const host = entry.host.includes(":") && !entry.host.startsWith("[") ? `[${entry.host}]` : entry.host;
  return `${entry.type}://${host}:${entry.port}`;
}

export async function fetchProxyVault(
  filters: ProxyVaultListFilters = {},
  signal?: AbortSignal,
): Promise<ProxyVaultListResult> {
  const params = new URLSearchParams();
  if (filters.group) params.set("group", filters.group);
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.risk && filters.risk !== "all") params.set("risk", filters.risk);
  const query = params.toString();
  const response = await vaultFetch(query ? `?${query}` : "", { method: "GET", signal });
  const body = await parseJsonEnvelope(response);
  const rawList = Array.isArray(body.entries)
    ? body.entries
    : Array.isArray(body.proxies)
      ? body.proxies
      : Array.isArray(body.items)
        ? body.items
        : null;
  if (!rawList) throw new ProxyVaultError("Proxy vault returned incomplete data.");
  const entries = rawList.map(normalizeProxyVaultEntry);
  const groups = Array.isArray(body.groups)
    ? body.groups.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
    : [...new Set(entries.map((item) => item.group).filter(Boolean))].sort();
  return { entries, groups };
}

export async function fetchProxyVaultEdit(id: string, signal?: AbortSignal): Promise<ProxyVaultEditView> {
  const response = await vaultFetch(`/${encodeURIComponent(id)}/edit`, { method: "GET", signal });
  const body = await parseJsonEnvelope(response);
  const raw = body.item ?? body.entry ?? body.proxy ?? body;
  const entry = normalizeProxyVaultEntry(raw);
  const record = isRecord(raw) ? raw : {};
  return {
    ...entry,
    user: asString(record.user),
    pass: asString(record.pass),
    refreshUrl: asString(record.refreshUrl ?? record.refresh_url),
  };
}

export async function createProxyVaultEntry(input: ProxyVaultUpsertInput): Promise<ProxyVaultEntry> {
  const response = await vaultFetch("", { method: "POST", body: input });
  const body = await parseJsonEnvelope(response);
  return normalizeProxyVaultEntry(body.item ?? body.entry ?? body.proxy ?? body);
}

export async function updateProxyVaultEntry(
  id: string,
  input: Partial<ProxyVaultUpsertInput>,
): Promise<{ entry: ProxyVaultEntry; boundCount: number }> {
  const payload =
    input.clearRefreshUrl && input.refreshUrl === undefined
      ? { ...input, refreshUrl: "" }
      : input;
  const response = await vaultFetch(`/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
  const body = await parseJsonEnvelope(response);
  const entry = normalizeProxyVaultEntry(body.item ?? body.entry ?? body.proxy ?? body);
  const boundCount =
    body.credentialsChanged === false
      ? 0
      : asFiniteNumber(body.boundCount ?? body.outOfSyncCount, entry.boundProfiles.length);
  return { entry, boundCount };
}

export async function deleteProxyVaultEntry(id: string): Promise<void> {
  const response = await vaultFetch(`/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
  await parseJsonEnvelope(response);
}

export async function deleteProxyVaultBatch(ids: string[]): Promise<{ deleted: number }> {
  const response = await vaultFetch("/delete", { method: "POST", body: { ids } });
  const body = await parseJsonEnvelope(response);
  return { deleted: asFiniteNumber(body.deleted, ids.length) };
}

export async function previewProxyVaultImport(
  input: { text: string; defaultGroup?: string; strategy?: ProxyVaultImportStrategy },
  signal?: AbortSignal,
): Promise<ProxyVaultImportPreview> {
  const response = await vaultFetch("/import/preview", { method: "POST", body: input, signal });
  const body = await parseJsonEnvelope(response);
  const preview = isRecord(body.preview) ? body.preview : body;
  const summary = isRecord(preview.summary) ? preview.summary : preview;
  const rawRows = Array.isArray(preview.rows) ? preview.rows : [];
  const rows: ProxyVaultImportPreviewRow[] = rawRows
    .filter(isRecord)
    .map((row, index) => {
      const status = asString(row.status);
      const safeStatus: ProxyVaultImportPreviewRow["status"] =
        status === "new"
          ? "new"
          : status === "duplicate" || status === "duplicate_existing" || status === "duplicate_in_batch"
            ? "duplicate"
            : "invalid";
      const protocol = asString(row.type).toLowerCase();
      const rawReason = typeof row.reason === "string" ? row.reason : typeof row.error === "string" ? row.error : undefined;
      return {
        line: asFiniteNumber(row.line, index + 1),
        status: safeStatus,
        ...(typeof row.name === "string" ? { name: row.name } : {}),
        ...(typeof row.group === "string" ? { group: row.group } : {}),
        ...(VALID_PROTOCOLS.has(protocol) ? { type: protocol as ProxyVaultProtocol } : {}),
        ...(typeof row.host === "string" ? { host: row.host } : {}),
        ...(typeof row.port === "number" && Number.isInteger(row.port) ? { port: row.port } : {}),
        ...(row.hasAuth !== undefined ? { hasAuth: asBool(row.hasAuth) } : {}),
        ...(row.hasRefreshUrl !== undefined ? { hasRefreshUrl: asBool(row.hasRefreshUrl) } : {}),
        ...(rawReason ? { reason: sanitizeVaultMessage(rawReason) } : {}),
        ...(typeof row.existingId === "string" ? { existingId: row.existingId } : {}),
      };
    });
  const newCount = asFiniteNumber(summary.newCount, rows.filter((r) => r.status === "new").length);
  const dupFallback =
    typeof summary.duplicateExistingCount === "number" || typeof summary.duplicateInBatchCount === "number"
      ? asFiniteNumber(summary.duplicateExistingCount) + asFiniteNumber(summary.duplicateInBatchCount)
      : rows.filter((r) => r.status === "duplicate").length;
  const duplicateCount = asFiniteNumber(summary.duplicateCount, dupFallback);
  const invalidCount = asFiniteNumber(
    summary.invalidCount,
    rows.filter((r) => r.status === "invalid").length,
  );
  const total = asFiniteNumber(summary.total ?? summary.totalRows, rows.length);
  const valid = asFiniteNumber(summary.valid ?? summary.validRows, newCount + duplicateCount);
  return { total, valid, newCount, duplicateCount, invalidCount, rows };
}

export async function applyProxyVaultImport(input: {
  text: string;
  defaultGroup?: string;
  strategy: ProxyVaultImportStrategy;
}): Promise<ProxyVaultImportApplyResult> {
  const response = await vaultFetch("/import/apply", { method: "POST", body: input });
  const body = await parseJsonEnvelope(response);
  return {
    inserted: asFiniteNumber(body.inserted ?? body.created),
    updated: asFiniteNumber(body.updated),
    skipped: asFiniteNumber(body.skipped),
    invalid: asFiniteNumber(body.invalid),
  };
}

/** Stream NDJSON check progress for vault entries using `fetch()` + `ReadableStream`. */
export async function checkProxyVaultStream(
  scope: { ids?: string[]; group?: string; all?: boolean; concurrency?: number },
  onEvent: (event: ProxyVaultCheckEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await vaultFetch("/check", {
    method: "POST",
    body: scope,
    signal,
    accept: "application/x-ndjson, application/json",
  });
  if (!response.ok) {
    await parseJsonEnvelope(response);
    return;
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || !contentType.includes("ndjson")) {
    throw new ProxyVaultError("Proxy vault check could not start. Check server version.", {
      status: response.status,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  const accept = (line: string) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ProxyVaultError("Proxy check stream returned incomplete data.");
    }
    if (!isRecord(record) || done) {
      throw new ProxyVaultError("Proxy check stream returned invalid data.");
    }
    const kind = asString(record.type);
    if (kind === "start") {
      onEvent({
        type: "progress",
        completed: 0,
        total: asFiniteNumber(record.total),
      });
    } else if (kind === "progress") {
      onEvent({
        type: "progress",
        completed: asFiniteNumber(record.completed),
        total: asFiniteNumber(record.total),
      });
    } else if (kind === "result" || kind === "entry" || kind === "check") {
      const entryRaw = record.item ?? record.entry ?? record.proxy ?? record.row;
      if (entryRaw) {
        onEvent({ type: "result", entry: normalizeProxyVaultEntry(entryRaw) });
      }
      if (typeof record.completed === "number" && typeof record.total === "number") {
        onEvent({
          type: "progress",
          completed: asFiniteNumber(record.completed),
          total: asFiniteNumber(record.total),
        });
      }
    } else if (kind === "done") {
      done = true;
      const checked =
        typeof record.checked === "number"
          ? record.checked
          : typeof record.completed === "number"
            ? record.completed
            : undefined;
      onEvent({
        type: "done",
        ...(checked !== undefined ? { checked } : {}),
      });
    } else if (kind === "error") {
      const msg = typeof record.error === "string" && record.error.trim()
        ? sanitizeVaultMessage(record.error)
        : "Proxy check failed. Completed results remain available.";
      throw new ProxyVaultError(msg);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        accept(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    if (!done) {
      throw new ProxyVaultError("Proxy check was interrupted before finishing.");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function refreshProxyVaultIp(
  id: string,
  options: { recheck?: boolean } = {},
): Promise<ProxyVaultRefreshIpResult> {
  const response = await vaultFetch(`/${encodeURIComponent(id)}/refresh-ip`, {
    method: "POST",
    body: { recheck: options.recheck ?? true },
  });
  const body = await parseJsonEnvelope(response);
  const rawEntry = body.item ?? body.entry ?? body.proxy;
  const entry = rawEntry ? normalizeProxyVaultEntry(rawEntry) : undefined;
  const checkResult = isRecord(body.checkResult) ? body.checkResult : null;
  const exitIp =
    typeof body.exitIp === "string"
      ? body.exitIp
      : typeof checkResult?.ip === "string"
        ? checkResult.ip
        : entry?.lastExitIp || undefined;
  const latencyMs =
    typeof body.latencyMs === "number" || body.latencyMs === null
      ? (body.latencyMs as number | null)
      : typeof checkResult?.latencyMs === "number" || checkResult?.latencyMs === null
        ? (checkResult.latencyMs as number | null)
        : entry?.lastLatencyMs;
  const rawCooldown = body.cooldownRemainingMs ?? body.retryAfterMs;
  return {
    entry,
    refreshedAt: asFiniteNumber(body.refreshedAt, Date.now()),
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(typeof body.rechecked === "boolean" ? { rechecked: body.rechecked } : {}),
    ...(typeof rawCooldown === "number" ? { cooldownRemainingMs: rawCooldown } : {}),
  };
}

export async function bindProxyVaultEntries(
  req: ProxyVaultBindRequest,
): Promise<ProxyVaultBindResult> {
  const response = await vaultFetch("/bind", { method: "POST", body: req });
  const body = await parseJsonEnvelope(response);
  const summaryRaw = isRecord(body.riskSummary) ? body.riskSummary : {};
  let warnings: ProxyVaultRiskItem[] = [];
  if (Array.isArray(summaryRaw.warnings)) {
    warnings = summaryRaw.warnings
      .map(normalizeRiskItem)
      .filter((item): item is ProxyVaultRiskItem => item !== null);
  } else if (isRecord(summaryRaw.byProxy)) {
    for (const proxySummary of Object.values(summaryRaw.byProxy)) {
      if (!isRecord(proxySummary) || !Array.isArray(proxySummary.risks)) continue;
      for (const risk of proxySummary.risks) {
        const normalized = normalizeRiskItem(risk);
        if (normalized) warnings.push(normalized);
      }
    }
  }
  const rows = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
  const updatedIds = Array.isArray(body.updatedIds)
    ? body.updatedIds.filter((id): id is string => typeof id === "string")
    : rows
        .filter((row) => row.status === "bound" && typeof row.profileId === "string")
        .map((row) => row.profileId as string);
  const skippedIds = Array.isArray(body.skippedIds)
    ? body.skippedIds.filter((id): id is string => typeof id === "string")
    : rows
        .filter((row) => row.status === "skipped" && typeof row.profileId === "string")
        .map((row) => row.profileId as string);
  const skippedRunning =
    body.skippedRunning !== undefined
      ? asFiniteNumber(body.skippedRunning)
      : body.skipped !== undefined
        ? asFiniteNumber(body.skipped)
        : rows.filter((row) => row.status === "skipped" && row.reason === "profile_open").length;
  return {
    updated: asFiniteNumber(body.updated),
    skippedRunning,
    updatedIds,
    skippedIds,
    riskSummary: {
      high: asFiniteNumber(summaryRaw.high ?? summaryRaw.highCount),
      medium: asFiniteNumber(summaryRaw.medium ?? summaryRaw.mediumCount),
      warnings,
    },
  };
}

export async function syncProxyVaultBoundProfiles(id: string): Promise<ProxyVaultSyncBoundResult> {
  const response = await vaultFetch(`/sync-bound/${encodeURIComponent(id)}`, {
    method: "POST",
    body: {},
  });
  const body = await parseJsonEnvelope(response);
  return {
    updated: asFiniteNumber(body.updated),
    skippedRunning: asFiniteNumber(body.skippedRunning ?? body.skipped),
  };
}

export async function ingestProxyVaultFromProfiles(): Promise<ProxyVaultIngestResult> {
  const response = await vaultFetch("/ingest-from-profiles", { method: "POST", body: {} });
  const body = await parseJsonEnvelope(response);
  return {
    ingested: asFiniteNumber(body.ingested ?? body.created),
    skippedDuplicates: asFiniteNumber(body.skippedDuplicates ?? body.reused),
    bound: asFiniteNumber(body.bound),
  };
}
