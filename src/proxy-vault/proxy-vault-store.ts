/**
 * SQLite-backed Proxy Vault store, batch importer, binding materializer,
 * and profile ingestion service.
 *
 * All vault secrets (proxy auth credentials & refresh URLs) are encrypted at rest
 * using ProfileStore's LocalSecretProtector (enc:v1:... AES-256-GCM / DPAPI).
 * Never exposes `endpoint_hash`, plaintext passwords, or refresh URLs in list views.
 */

import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { parse as parseCsv } from "csv-parse/sync";
import { canonicalIp } from "../../ip.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "../../profile-id.ts";
import { normalizeProxySpec, parseProxySpec, type ProxyInput } from "../../proxy.ts";
import type { ProfileStore } from "../../store.ts";
import type { Profile, ProxySpec, ProxyType } from "../../types.ts";
import { validateRefreshUrlSyntax, ProxyRefreshError } from "./proxy-refresh-url.ts";
import {
  evaluateProxyVaultRisks,
  highestRiskLevel,
  type ProxyRiskLevel,
  type ProxyVaultRiskBindingInput,
  type ProxyVaultRiskItem,
  type ProxyVaultRiskProxyInput,
} from "./proxy-vault-risk.ts";

export const PROXY_VAULT_ID_PATTERN = /^pxv_[0-9a-f]{16}$/;
export const MAX_VAULT_NAME_LENGTH = 200;
export const MAX_VAULT_GROUP_LENGTH = 200;
export const MAX_VAULT_NOTES_LENGTH = 2000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export type ProxyVaultStatus =
  | "unchecked"
  | "working"
  | "unstable"
  | "failed"
  | "unavailable"
  | "unsupported";

export type ProxyExitComparison = "" | "same" | "different" | "unknown";
export type ImportDuplicateStrategy = "skip_duplicates" | "update_existing";
export type BindMode = "single" | "round_robin";

export class ProxyVaultError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "ProxyVaultError";
  }
}

export interface ProxyVaultBoundProfileView {
  id: string;
  name: string;
  group: string;
  platform: string;
  running: boolean;
  inSync: boolean;
  boundAt: number;
}

export interface ProxyVaultItemView {
  id: string;
  name: string;
  group: string;
  type: ProxyType;
  host: string;
  port: number;
  endpoint: string;
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
  lastExitComparison: ProxyExitComparison;
  lastCheckedAt: number;
  lastRefreshedAt: number;
  createdAt: number;
  updatedAt: number;
  boundProfiles: ProxyVaultBoundProfileView[];
  boundCount: number;
  outOfSyncCount: number;
  riskLevel: ProxyRiskLevel;
  risks: ProxyVaultRiskItem[];
}

export interface ProxyVaultEditView {
  id: string;
  name: string;
  group: string;
  type: ProxyType;
  host: string;
  port: number;
  user: string;
  pass: string;
  refreshUrl: string;
  notes: string;
  hasAuth: boolean;
  hasRefreshUrl: boolean;
  refreshUrlHost: string;
  boundCount: number;
  outOfSyncCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProxyVaultInternalRecord {
  id: string;
  name: string;
  group: string;
  proxy: ProxySpec;
  endpointHash: string;
  hasAuth: boolean;
  hasRefreshUrl: boolean;
  refreshUrl: string;
  refreshUrlHost: string;
  lastRefreshedAt: number;
}

export interface ProxyVaultListFilter {
  group?: string;
  q?: string;
  risk?: string;
}

export interface ProxyVaultListSummary {
  total: number;
  filtered: number;
  highRisk: number;
  mediumRisk: number;
  working: number;
  unstable: number;
  failed: number;
  unavailable: number;
  unchecked: number;
  unsupported: number;
  boundProxies: number;
}

export interface ProxyVaultListResult {
  items: ProxyVaultItemView[];
  groups: string[];
  summary: ProxyVaultListSummary;
}

export interface CreateProxyVaultInput {
  name?: unknown;
  group?: unknown;
  type?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  pass?: unknown;
  proxy?: unknown;
  refreshUrl?: unknown;
  notes?: unknown;
}

export interface UpdateProxyVaultInput extends CreateProxyVaultInput {
  clearAuth?: unknown;
}

export interface ImportProxyVaultInput {
  input: string;
  format?: "auto" | "text" | "csv";
  defaultType?: ProxyType;
  defaultGroup?: string;
  duplicateStrategy?: ImportDuplicateStrategy;
}

export interface ImportPreviewRow {
  index: number;
  line: number;
  name: string;
  group: string;
  type: ProxyType | null;
  host: string;
  port: number | null;
  endpoint: string | null;
  hasAuth: boolean;
  hasRefreshUrl: boolean;
  refreshUrlHost: string;
  notes: string;
  status: "new" | "duplicate_existing" | "duplicate_in_batch" | "invalid";
  action: "create" | "update" | "skip" | "error";
  existingId?: string;
  existingName?: string;
  error?: string;
}

export interface ImportPreviewResult {
  detectedFormat: "text" | "csv";
  duplicateStrategy: ImportDuplicateStrategy;
  summary: {
    totalRows: number;
    validRows: number;
    newCount: number;
    duplicateExistingCount: number;
    duplicateInBatchCount: number;
    invalidCount: number;
    wouldCreate: number;
    wouldUpdate: number;
    wouldSkip: number;
  };
  rows: ImportPreviewRow[];
}

export interface ImportApplyResult {
  detectedFormat: "text" | "csv";
  duplicateStrategy: ImportDuplicateStrategy;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  createdIds: string[];
  updatedIds: string[];
  errors: Array<{ line: number; error: string }>;
}

export interface BindProfilesInput {
  proxyIds: readonly string[];
  profileIds: readonly string[];
  mode?: BindMode;
  profilesPerProxy?: number;
  dryRun?: boolean;
}

export interface BindProfileRowResult {
  profileId: string;
  profileName?: string;
  proxyId: string;
  proxyName?: string;
  status: "bound" | "unchanged" | "skipped";
  reason?: "profile_not_found" | "profile_open";
}

export interface BindRiskSummary {
  highestRisk: ProxyRiskLevel;
  highCount: number;
  mediumCount: number;
  byProxy: Record<
    string,
    {
      riskLevel: ProxyRiskLevel;
      risks: ProxyVaultRiskItem[];
      boundProfiles: ProxyVaultBoundProfileView[];
    }
  >;
}

export interface BindProfilesResult {
  dryRun: boolean;
  mode: BindMode;
  profilesPerProxy: number;
  updated: number;
  unchanged: number;
  skipped: number;
  results: BindProfileRowResult[];
  riskSummary: BindRiskSummary;
}

export interface SyncBoundRowResult {
  profileId: string;
  profileName: string;
  status: "updated" | "unchanged" | "skipped";
  reason?: "profile_open";
}

export interface SyncBoundProfilesResult {
  proxyId: string;
  dryRun: boolean;
  updated: number;
  unchanged: number;
  skipped: number;
  results: SyncBoundRowResult[];
}

export interface IngestFromProfilesInput {
  profileIds?: readonly string[];
  bind?: boolean;
  defaultGroup?: string;
}

export interface IngestFromProfilesResult {
  scanned: number;
  created: number;
  reused: number;
  bound: number;
  skippedWithoutProxy: number;
  skippedInvalid: number;
  createdIds: string[];
}

export interface VaultCheckTelemetry {
  status: Exclude<ProxyVaultStatus, "unchecked">;
  reason?: string;
  latencyMs: number | null;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  rotating?: boolean;
  exitComparison?: "same" | "different" | "unknown";
  checkedAt?: number;
}

interface RawVaultRow {
  id: string;
  name: string;
  group: string;
  type: ProxyType;
  host: string;
  port: number;
  auth_encrypted: string;
  has_auth: number;
  endpoint_hash: string;
  refresh_url_encrypted: string;
  has_refresh_url: number;
  refresh_url_host: string;
  notes: string;
  last_status: ProxyVaultStatus;
  last_reason: string;
  last_latency_ms: number | null;
  last_exit_ip: string;
  last_exit_country: string;
  last_exit_region: string;
  last_exit_city: string;
  last_exit_rotating: number;
  last_exit_comparison: ProxyExitComparison;
  last_checked_at: number;
  last_refreshed_at: number;
  created_at: number;
  updated_at: number;
}

interface RawActiveBindingRow {
  profile_id: string;
  proxy_id: string;
  bound_at: number;
  synced_endpoint_hash: string;
  profile_name: string;
  profile_group: string;
  profile_platform: string;
  running: number;
}

interface ParsedImportCandidate {
  index: number;
  line: number;
  name: string;
  group: string;
  proxy: ProxySpec | null;
  canonicalHost: string;
  port: number | null;
  endpointHash: string | null;
  refreshUrl: string;
  refreshUrlHost: string;
  notes: string;
  error?: string;
}

export function isValidProxyVaultId(value: unknown): value is string {
  return typeof value === "string" && PROXY_VAULT_ID_PATTERN.test(value);
}

export function generateProxyVaultId(): string {
  return `pxv_${randomBytes(8).toString("hex")}`;
}

/** Return unbracketed compressed IPv6 or canonical IPv4 or lowercase domain name. */
export function canonicalProxyHost(rawHost: string): string {
  const trimmed = rawHost.trim().replace(/^\[|\]$/g, "");
  if (!trimmed) throw new ProxyVaultError("Proxy host is empty.");
  if (isIP(trimmed) !== 0) {
    const ip = canonicalIp(trimmed);
    if (!ip) throw new ProxyVaultError("Proxy host is not a valid IP address.");
    return ip;
  }
  try {
    const parsed = new URL(`http://${trimmed}/`);
    if (!parsed.hostname) throw new Error("empty");
    return parsed.hostname.toLowerCase();
  } catch {
    throw new ProxyVaultError("Proxy host is not a valid hostname or IP address.");
  }
}

/**
 * Deterministic SHA-256 fingerprint of `[type, canonicalHost, port, user, pass]`.
 * Internal deduplication & correlation key only — never send to UI clients.
 */
export function computeProxyEndpointHash(input: ProxySpec | ProxyInput): string {
  const spec = normalizeProxySpec(input);
  if (!spec) throw new ProxyVaultError("Proxy specification is required.");
  const host = canonicalProxyHost(spec.host);
  const port = Number(spec.port);
  return createHash("sha256")
    .update(JSON.stringify([spec.type, host, port, spec.user, spec.pass]))
    .digest("hex");
}

export function formatVaultEndpoint(type: ProxyType, host: string, port: number): string {
  const renderedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${type}://${renderedHost}:${port}`;
}

function validateTextField(raw: unknown, label: string, maxChars: number, trim = true): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ProxyVaultError(`${label} must be a string.`);
  const value = trim ? raw.trim() : raw;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ProxyVaultError(`${label} contains invalid control characters.`);
  }
  if (Array.from(value).length > maxChars) {
    throw new ProxyVaultError(`${label} exceeds the ${maxChars}-character limit.`);
  }
  return value;
}

function resolveCreateProxySpec(input: CreateProxyVaultInput): ProxySpec {
  try {
    if (typeof input.proxy === "string" && input.proxy.trim()) {
      const parsed = parseProxySpec(input.type ?? "http", input.proxy);
      if (!parsed) throw new Error("proxy is required");
      return {
        ...parsed,
        host: canonicalProxyHost(parsed.host),
      };
    }
    const normalized = normalizeProxySpec({
      type: input.type,
      host: input.host,
      port: input.port,
      user: input.user,
      pass: input.pass,
    });
    if (!normalized) throw new Error("proxy host and port are required");
    return {
      ...normalized,
      host: canonicalProxyHost(normalized.host),
    };
  } catch (error) {
    if (error instanceof ProxyVaultError) throw error;
    throw new ProxyVaultError(error instanceof Error ? error.message : "Invalid proxy settings.");
  }
}

const CSV_STRUCTURED_HEADERS = new Set([
  "name",
  "group",
  "type",
  "host",
  "port",
  "user",
  "pass",
  "refreshurl",
  "refresh_url",
  "notes",
]);

const CSV_COMPACT_HEADERS = new Set([
  "proxy",
  "type",
  "name",
  "group",
  "refreshurl",
  "refresh_url",
  "notes",
]);

function normalizeCsvHeader(raw: string): string {
  return raw.trim().toLowerCase();
}

function looksLikeCsvHeader(firstLine: string): boolean {
  let records: string[][];
  try {
    records = parseCsv(firstLine, { bom: true, relax_column_count: true }) as string[][];
  } catch {
    return false;
  }
  const cols = records[0]?.map(normalizeCsvHeader).filter(Boolean) ?? [];
  if (cols.length < 2) return false;
  const isCompact = cols.includes("proxy") && cols.every((c) => CSV_COMPACT_HEADERS.has(c));
  const isStructured =
    cols.includes("host") && cols.includes("port") && cols.every((c) => CSV_STRUCTURED_HEADERS.has(c));
  return isCompact || isStructured;
}

export class ProxyVaultStore {
  constructor(private readonly store: ProfileStore) {}

  private encryptAuth(user: string, pass: string): { authEncrypted: string; hasAuth: number } {
    if (!user) return { authEncrypted: "", hasAuth: 0 };
    return {
      authEncrypted: this.store.secretProtector().encrypt(JSON.stringify({ user, pass })),
      hasAuth: 1,
    };
  }

  private decryptAuth(raw: string, hasAuth: number): { user: string; pass: string; readable: boolean } {
    if (!hasAuth || !raw) return { user: "", pass: "", readable: true };
    try {
      const plaintext = this.store.secretProtector().decrypt(raw);
      const parsed = JSON.parse(plaintext) as { user?: unknown; pass?: unknown } | null;
      if (!parsed || typeof parsed !== "object") return { user: "", pass: "", readable: false };
      return {
        user: typeof parsed.user === "string" ? parsed.user : "",
        pass: typeof parsed.pass === "string" ? parsed.pass : "",
        readable: true,
      };
    } catch {
      return { user: "", pass: "", readable: false };
    }
  }

  private encryptRefreshUrl(raw: unknown): {
    refreshUrlEncrypted: string;
    hasRefreshUrl: number;
    refreshUrlHost: string;
  } {
    if (raw === undefined || raw === null) {
      return { refreshUrlEncrypted: "", hasRefreshUrl: 0, refreshUrlHost: "" };
    }
    if (typeof raw !== "string") {
      throw new ProxyVaultError("Refresh URL must be a string.");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return { refreshUrlEncrypted: "", hasRefreshUrl: 0, refreshUrlHost: "" };
    }
    try {
      const validated = validateRefreshUrlSyntax(trimmed);
      return {
        refreshUrlEncrypted: this.store.secretProtector().encrypt(validated.url.href),
        hasRefreshUrl: 1,
        refreshUrlHost: validated.displayHost,
      };
    } catch (error) {
      if (error instanceof ProxyRefreshError) {
        throw new ProxyVaultError(error.message, error.status, error.code);
      }
      throw new ProxyVaultError("Invalid refresh URL.");
    }
  }

  private decryptRefreshUrl(raw: string, hasRefreshUrl: number): { url: string; readable: boolean } {
    if (!hasRefreshUrl || !raw) return { url: "", readable: true };
    try {
      return { url: this.store.secretProtector().decrypt(raw), readable: true };
    } catch {
      return { url: "", readable: false };
    }
  }

  private loadAllRawRows(): RawVaultRow[] {
    return this.store
      .rawDatabase()
      .query<RawVaultRow, []>(
        `SELECT id, name, "group", type, host, port, auth_encrypted, has_auth, endpoint_hash,
                refresh_url_encrypted, has_refresh_url, refresh_url_host, notes,
                last_status, last_reason, last_latency_ms, last_exit_ip, last_exit_country,
                last_exit_region, last_exit_city, last_exit_rotating, last_exit_comparison,
                last_checked_at, last_refreshed_at, created_at, updated_at
           FROM proxy_vault
          ORDER BY created_at DESC, id ASC`,
      )
      .all();
  }

  private loadRawRow(id: string): RawVaultRow | null {
    if (!isValidProxyVaultId(id)) return null;
    return (
      this.store
        .rawDatabase()
        .query<RawVaultRow, [string]>(
          `SELECT id, name, "group", type, host, port, auth_encrypted, has_auth, endpoint_hash,
                  refresh_url_encrypted, has_refresh_url, refresh_url_host, notes,
                  last_status, last_reason, last_latency_ms, last_exit_ip, last_exit_country,
                  last_exit_region, last_exit_city, last_exit_rotating, last_exit_comparison,
                  last_checked_at, last_refreshed_at, created_at, updated_at
             FROM proxy_vault
            WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  private loadActiveBindings(): RawActiveBindingRow[] {
    return this.store
      .rawDatabase()
      .query<RawActiveBindingRow, []>(
        `SELECT b.profile_id, b.proxy_id, b.bound_at, b.synced_endpoint_hash,
                p.name AS profile_name, p."group" AS profile_group, p.platform AS profile_platform,
                EXISTS(SELECT 1 FROM launches l WHERE l.profile_id = p.id) AS running
           FROM profile_proxy_bindings b
           INNER JOIN profiles p ON p.id = b.profile_id
          WHERE p.trashed_at = 0
          ORDER BY b.bound_at ASC, b.profile_id ASC`,
      )
      .all();
  }

  private buildItemViews(
    rows: readonly RawVaultRow[],
    bindings: readonly RawActiveBindingRow[],
  ): ProxyVaultItemView[] {
    const riskProxies: ProxyVaultRiskProxyInput[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      endpointHash: row.endpoint_hash,
      lastExitIp: row.last_exit_ip,
      lastExitComparison: row.last_exit_comparison,
    }));
    const riskBindings: ProxyVaultRiskBindingInput[] = bindings.map((row) => ({
      proxyId: row.proxy_id,
      profileId: row.profile_id,
      profileName: row.profile_name,
      profileGroup: row.profile_group,
      platform: row.profile_platform,
    }));
    const riskMap = evaluateProxyVaultRisks(riskProxies, riskBindings);

    const bindingsByProxy = new Map<string, RawActiveBindingRow[]>();
    for (const binding of bindings) {
      const list = bindingsByProxy.get(binding.proxy_id) ?? [];
      list.push(binding);
      bindingsByProxy.set(binding.proxy_id, list);
    }

    return rows.map((row) => {
      const rawBound = bindingsByProxy.get(row.id) ?? [];
      const boundProfiles: ProxyVaultBoundProfileView[] = rawBound.map((b) => ({
        id: b.profile_id,
        name: b.profile_name,
        group: b.profile_group,
        platform: b.profile_platform,
        running: b.running === 1,
        inSync: b.synced_endpoint_hash === row.endpoint_hash,
        boundAt: b.bound_at,
      }));
      const outOfSyncCount = boundProfiles.filter((b) => !b.inSync).length;
      const riskEval = riskMap.get(row.id) ?? { riskLevel: "none" as const, risks: [] };
      return {
        id: row.id,
        name: row.name,
        group: row.group,
        type: row.type,
        host: row.host,
        port: row.port,
        endpoint: formatVaultEndpoint(row.type, row.host, row.port),
        hasAuth: row.has_auth === 1,
        hasRefreshUrl: row.has_refresh_url === 1,
        refreshUrlHost: row.refresh_url_host,
        notes: row.notes,
        lastStatus: row.last_status,
        lastReason: row.last_reason,
        lastLatencyMs: row.last_latency_ms ?? null,
        lastExitIp: row.last_exit_ip,
        lastExitCountry: row.last_exit_country,
        lastExitRegion: row.last_exit_region,
        lastExitCity: row.last_exit_city,
        lastExitRotating: row.last_exit_rotating === 1,
        lastExitComparison: row.last_exit_comparison,
        lastCheckedAt: row.last_checked_at,
        lastRefreshedAt: row.last_refreshed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        boundProfiles,
        boundCount: boundProfiles.length,
        outOfSyncCount,
        riskLevel: riskEval.riskLevel,
        risks: riskEval.risks,
      };
    });
  }

  private toInternalRecord(row: RawVaultRow): ProxyVaultInternalRecord {
    const auth = this.decryptAuth(row.auth_encrypted, row.has_auth);
    if (!auth.readable) {
      throw new ProxyVaultError(
        "Stored proxy credentials could not be decrypted with this local key.",
        500,
        "secret_unreadable",
      );
    }
    const refresh = this.decryptRefreshUrl(row.refresh_url_encrypted, row.has_refresh_url);
    return {
      id: row.id,
      name: row.name,
      group: row.group,
      proxy: {
        type: row.type,
        host: row.host,
        port: String(row.port),
        user: auth.user,
        pass: auth.pass,
      },
      endpointHash: row.endpoint_hash,
      hasAuth: row.has_auth === 1,
      hasRefreshUrl: row.has_refresh_url === 1,
      refreshUrl: refresh.readable ? refresh.url : "",
      refreshUrlHost: row.refresh_url_host,
      lastRefreshedAt: row.last_refreshed_at,
    };
  }

  /** List redacted proxy vault entries with anti-correlation risk evaluation and filtering. */
  list(filter: ProxyVaultListFilter = {}): ProxyVaultListResult {
    const rows = this.loadAllRawRows();
    const bindings = this.loadActiveBindings();
    const allViews = this.buildItemViews(rows, bindings);

    const groups = [...new Set(allViews.map((item) => item.group).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );

    const summary: ProxyVaultListSummary = {
      total: allViews.length,
      filtered: allViews.length,
      highRisk: 0,
      mediumRisk: 0,
      working: 0,
      unstable: 0,
      failed: 0,
      unavailable: 0,
      unchecked: 0,
      unsupported: 0,
      boundProxies: 0,
    };
    for (const item of allViews) {
      if (item.riskLevel === "high") summary.highRisk++;
      else if (item.riskLevel === "medium") summary.mediumRisk++;
      summary[item.lastStatus]++;
      if (item.boundCount > 0) summary.boundProxies++;
    }

    const groupFilter = filter.group?.trim();
    const qFilter = filter.q?.trim().toLowerCase();
    const riskFilter = filter.risk?.trim().toLowerCase();

    const filtered = allViews.filter((item) => {
      if (groupFilter !== undefined && groupFilter !== "") {
        if (groupFilter === "__ungrouped__") {
          if (item.group !== "") return false;
        } else if (item.group !== groupFilter) {
          return false;
        }
      }
      if (riskFilter) {
        if (riskFilter === "high" && item.riskLevel !== "high") return false;
        if (riskFilter === "medium" && item.riskLevel !== "medium") return false;
        if (riskFilter === "none" && item.riskLevel !== "none") return false;
        if ((riskFilter === "any" || riskFilter === "flagged") && item.riskLevel === "none") return false;
      }
      if (qFilter) {
        const haystacks = [
          item.id,
          item.name,
          item.group,
          item.host,
          String(item.port),
          item.endpoint,
          item.lastExitIp,
          item.lastExitCountry,
          item.lastExitCity,
          item.refreshUrlHost,
          item.notes,
          ...item.boundProfiles.flatMap((b) => [b.id, b.name, b.platform]),
        ];
        if (!haystacks.some((value) => value.toLowerCase().includes(qFilter))) {
          return false;
        }
      }
      return true;
    });

    summary.filtered = filtered.length;
    return { items: filtered, groups, summary };
  }

  getView(id: string): ProxyVaultItemView | null {
    if (!isValidProxyVaultId(id)) return null;
    const rows = this.loadAllRawRows();
    if (!rows.some((row) => row.id === id)) return null;
    const bindings = this.loadActiveBindings();
    return this.buildItemViews(rows, bindings).find((item) => item.id === id) ?? null;
  }

  /** Decrypted single-item view returned strictly by `GET /ui/api/proxy-vault/:id/edit`. */
  getEditView(id: string): ProxyVaultEditView | null {
    const row = this.loadRawRow(id);
    if (!row) return null;
    const auth = this.decryptAuth(row.auth_encrypted, row.has_auth);
    const refresh = this.decryptRefreshUrl(row.refresh_url_encrypted, row.has_refresh_url);
    const activeBindings = this.loadActiveBindings().filter((b) => b.proxy_id === id);
    const outOfSyncCount = activeBindings.filter((b) => b.synced_endpoint_hash !== row.endpoint_hash).length;
    return {
      id: row.id,
      name: row.name,
      group: row.group,
      type: row.type,
      host: row.host,
      port: row.port,
      user: auth.readable ? auth.user : "",
      pass: auth.readable ? auth.pass : "",
      refreshUrl: refresh.readable ? refresh.url : "",
      notes: row.notes,
      hasAuth: row.has_auth === 1,
      hasRefreshUrl: row.has_refresh_url === 1,
      refreshUrlHost: row.refresh_url_host,
      boundCount: activeBindings.length,
      outOfSyncCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getInternalRecord(id: string): ProxyVaultInternalRecord | null {
    const row = this.loadRawRow(id);
    return row ? this.toInternalRecord(row) : null;
  }

  selectForCheck(selector: { ids?: readonly string[]; group?: string; all?: boolean }): ProxyVaultInternalRecord[] {
    const rows = this.loadAllRawRows();
    let chosen: RawVaultRow[];
    if (selector.all === true) {
      chosen = rows;
    } else if (selector.ids && selector.ids.length > 0) {
      const idSet = new Set(selector.ids);
      chosen = rows.filter((row) => idSet.has(row.id));
    } else if (typeof selector.group === "string") {
      const targetGroup = selector.group.trim();
      chosen = rows.filter((row) => (targetGroup === "__ungrouped__" ? row.group === "" : row.group === targetGroup));
    } else {
      throw new ProxyVaultError("Specify ids, group, or all=true to check proxies.");
    }
    return chosen.map((row) => this.toInternalRecord(row));
  }

  create(input: CreateProxyVaultInput): ProxyVaultItemView {
    const proxy = resolveCreateProxySpec(input);
    const name = validateTextField(input.name, "Proxy name", MAX_VAULT_NAME_LENGTH);
    const group = validateTextField(input.group, "Proxy group", MAX_VAULT_GROUP_LENGTH);
    const notes = validateTextField(input.notes, "Proxy notes", MAX_VAULT_NOTES_LENGTH, false);
    const { authEncrypted, hasAuth } = this.encryptAuth(proxy.user, proxy.pass);
    const { refreshUrlEncrypted, hasRefreshUrl, refreshUrlHost } = this.encryptRefreshUrl(input.refreshUrl);
    const endpointHash = computeProxyEndpointHash(proxy);
    const now = Date.now();
    const id = generateProxyVaultId();

    this.store.withTransaction(() => {
      this.store
        .rawDatabase()
        .query(
          `INSERT INTO proxy_vault (
             id, name, "group", type, host, port,
             auth_encrypted, has_auth, endpoint_hash,
             refresh_url_encrypted, has_refresh_url, refresh_url_host,
             notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          group,
          proxy.type,
          proxy.host,
          Number(proxy.port),
          authEncrypted,
          hasAuth,
          endpointHash,
          refreshUrlEncrypted,
          hasRefreshUrl,
          refreshUrlHost,
          notes,
          now,
          now,
        );
    });

    return this.getView(id)!;
  }

  update(
    id: string,
    input: UpdateProxyVaultInput,
  ): { item: ProxyVaultItemView; credentialsChanged: boolean; outOfSyncCount: number } {
    if (!isValidProxyVaultId(id)) {
      throw new ProxyVaultError("Invalid proxy vault ID.", 400, "invalid_id");
    }
    const existing = this.loadRawRow(id);
    if (!existing) {
      throw new ProxyVaultError("Proxy vault entry not found.", 404, "not_found");
    }

    const existingAuth = this.decryptAuth(existing.auth_encrypted, existing.has_auth);
    let nextProxy: ProxySpec;
    if (typeof input.proxy === "string" && input.proxy.trim()) {
      nextProxy = resolveCreateProxySpec({ type: input.type ?? existing.type, proxy: input.proxy });
    } else {
      const hasAuthPatch =
        input.clearAuth === true || input.user !== undefined || input.pass !== undefined;
      let user = existingAuth.readable ? existingAuth.user : "";
      let pass = existingAuth.readable ? existingAuth.pass : "";
      if (input.clearAuth === true) {
        user = "";
        pass = "";
      } else if (hasAuthPatch) {
        user = input.user !== undefined ? String(input.user ?? "") : user;
        pass = input.pass !== undefined ? String(input.pass ?? "") : pass;
      }
      nextProxy = resolveCreateProxySpec({
        type: input.type ?? existing.type,
        host: input.host ?? existing.host,
        port: input.port ?? existing.port,
        user,
        pass,
      });
    }

    const name = input.name !== undefined
      ? validateTextField(input.name, "Proxy name", MAX_VAULT_NAME_LENGTH)
      : existing.name;
    const group = input.group !== undefined
      ? validateTextField(input.group, "Proxy group", MAX_VAULT_GROUP_LENGTH)
      : existing.group;
    const notes = input.notes !== undefined
      ? validateTextField(input.notes, "Proxy notes", MAX_VAULT_NOTES_LENGTH, false)
      : existing.notes;

    const { authEncrypted, hasAuth } = this.encryptAuth(nextProxy.user, nextProxy.pass);
    const nextEndpointHash = computeProxyEndpointHash(nextProxy);
    const credentialsChanged = nextEndpointHash !== existing.endpoint_hash;

    const refreshFields =
      input.refreshUrl !== undefined
        ? this.encryptRefreshUrl(input.refreshUrl)
        : {
            refreshUrlEncrypted: existing.refresh_url_encrypted,
            hasRefreshUrl: existing.has_refresh_url,
            refreshUrlHost: existing.refresh_url_host,
          };

    const now = Date.now();
    this.store.withTransaction(() => {
      this.store
        .rawDatabase()
        .query(
          `UPDATE proxy_vault
              SET name = ?, "group" = ?, type = ?, host = ?, port = ?,
                  auth_encrypted = ?, has_auth = ?, endpoint_hash = ?,
                  refresh_url_encrypted = ?, has_refresh_url = ?, refresh_url_host = ?,
                  notes = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          name,
          group,
          nextProxy.type,
          nextProxy.host,
          Number(nextProxy.port),
          authEncrypted,
          hasAuth,
          nextEndpointHash,
          refreshFields.refreshUrlEncrypted,
          refreshFields.hasRefreshUrl,
          refreshFields.refreshUrlHost,
          notes,
          now,
          id,
        );
    });

    const item = this.getView(id)!;
    return {
      item,
      credentialsChanged,
      outOfSyncCount: item.outOfSyncCount,
    };
  }

  delete(id: string): boolean {
    if (!isValidProxyVaultId(id)) {
      throw new ProxyVaultError("Invalid proxy vault ID.", 400, "invalid_id");
    }
    return this.store.withTransaction(() => {
      const db = this.store.rawDatabase();
      db.query(`DELETE FROM profile_proxy_bindings WHERE proxy_id = ?`).run(id);
      const res = db.query(`DELETE FROM proxy_vault WHERE id = ?`).run(id);
      return Number(res.changes) > 0;
    });
  }

  deleteMany(ids: readonly string[]): { deleted: number; deletedIds: string[] } {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ProxyVaultError("Select at least one proxy to delete.");
    }
    const unique = [...new Set(ids)];
    if (unique.some((id) => !isValidProxyVaultId(id))) {
      throw new ProxyVaultError("One or more proxy vault IDs are invalid.", 400, "invalid_id");
    }
    const deletedIds: string[] = [];
    this.store.withTransaction(() => {
      const db = this.store.rawDatabase();
      const deleteBindings = db.query(`DELETE FROM profile_proxy_bindings WHERE proxy_id = ?`);
      const deleteVault = db.query(`DELETE FROM proxy_vault WHERE id = ?`);
      for (const id of unique) {
        deleteBindings.run(id);
        const res = deleteVault.run(id);
        if (Number(res.changes) > 0) deletedIds.push(id);
      }
    });
    return { deleted: deletedIds.length, deletedIds };
  }

  private parseImportCandidates(input: ImportProxyVaultInput): {
    detectedFormat: "text" | "csv";
    candidates: ParsedImportCandidate[];
  } {
    if (typeof input.input !== "string") {
      throw new ProxyVaultError("Import input must be a string.");
    }
    const bytes = Buffer.byteLength(input.input, "utf8");
    if (bytes > MAX_IMPORT_BYTES) {
      throw new ProxyVaultError("Import payload exceeds the 2 MiB size limit.", 413, "payload_too_large");
    }
    const trimmed = input.input.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
      throw new ProxyVaultError("Import input is empty.");
    }

    const defaultType: ProxyType = input.defaultType ?? "http";
    const defaultGroup = validateTextField(input.defaultGroup ?? "", "Default group", MAX_VAULT_GROUP_LENGTH);

    const rawLines = trimmed.split(/\r?\n/);
    const firstNonEmpty = rawLines.find((line) => line.trim().length > 0) ?? "";
    const detectedFormat: "text" | "csv" =
      input.format === "csv"
        ? "csv"
        : input.format === "text"
          ? "text"
          : looksLikeCsvHeader(firstNonEmpty)
            ? "csv"
            : "text";

    const candidates: ParsedImportCandidate[] = [];

    if (detectedFormat === "csv") {
      let records: string[][];
      try {
        records = parseCsv(trimmed, {
          bom: true,
          skip_empty_lines: true,
          relax_column_count: true,
        }) as string[][];
      } catch {
        throw new ProxyVaultError("CSV import input could not be parsed.");
      }
      if (records.length < 2) {
        throw new ProxyVaultError("CSV import must include a header row and at least one data row.");
      }
      const headers = records[0]!.map(normalizeCsvHeader);
      if (headers.some((h) => !h) || new Set(headers).size !== headers.length) {
        throw new ProxyVaultError("CSV headers must be unique and non-empty.");
      }
      const isCompact = headers.includes("proxy") && headers.every((h) => CSV_COMPACT_HEADERS.has(h));
      const isStructured =
        headers.includes("host") &&
        headers.includes("port") &&
        headers.every((h) => CSV_STRUCTURED_HEADERS.has(h));
      if (!isCompact && !isStructured) {
        throw new ProxyVaultError(
          "CSV headers must match either (name,group,type,host,port,user,pass,refreshUrl,notes) or (proxy,name,group,refreshUrl,notes).",
        );
      }

      const dataRows = records.slice(1);
      if (dataRows.length > MAX_IMPORT_ROWS) {
        throw new ProxyVaultError(`Import exceeds the ${MAX_IMPORT_ROWS}-row limit.`, 400, "too_many_rows");
      }

      dataRows.forEach((values, idx) => {
        const line = idx + 2;
        if (values.length > headers.length) {
          candidates.push({
            index: idx,
            line,
            name: "",
            group: defaultGroup,
            proxy: null,
            canonicalHost: "",
            port: null,
            endpointHash: null,
            refreshUrl: "",
            refreshUrlHost: "",
            notes: "",
            error: "Row has more columns than the CSV header.",
          });
          return;
        }
        const rowMap = new Map<string, string>();
        headers.forEach((h, i) => rowMap.set(h, values[i] ?? ""));
        const rawRefresh = rowMap.get("refreshurl") ?? rowMap.get("refresh_url") ?? "";
        try {
          const name = validateTextField(rowMap.get("name") ?? "", "Proxy name", MAX_VAULT_NAME_LENGTH);
          const group =
            validateTextField(rowMap.get("group") ?? "", "Proxy group", MAX_VAULT_GROUP_LENGTH) || defaultGroup;
          const notes = validateTextField(rowMap.get("notes") ?? "", "Proxy notes", MAX_VAULT_NOTES_LENGTH, false);
          const proxy = isCompact
            ? resolveCreateProxySpec({
                type: rowMap.get("type") || defaultType,
                proxy: rowMap.get("proxy") ?? "",
              })
            : resolveCreateProxySpec({
                type: rowMap.get("type") || defaultType,
                host: rowMap.get("host") ?? "",
                port: rowMap.get("port") ?? "",
                user: rowMap.get("user") ?? "",
                pass: rowMap.get("pass") ?? "",
              });
          let refreshUrl = "";
          let refreshUrlHost = "";
          if (rawRefresh.trim()) {
            const validated = validateRefreshUrlSyntax(rawRefresh);
            refreshUrl = validated.url.href;
            refreshUrlHost = validated.displayHost;
          }
          candidates.push({
            index: idx,
            line,
            name,
            group,
            proxy,
            canonicalHost: proxy.host,
            port: Number(proxy.port),
            endpointHash: computeProxyEndpointHash(proxy),
            refreshUrl,
            refreshUrlHost,
            notes,
          });
        } catch (error) {
          candidates.push({
            index: idx,
            line,
            name: (rowMap.get("name") ?? "").trim().slice(0, MAX_VAULT_NAME_LENGTH),
            group: (rowMap.get("group") ?? "").trim().slice(0, MAX_VAULT_GROUP_LENGTH) || defaultGroup,
            proxy: null,
            canonicalHost: "",
            port: null,
            endpointHash: null,
            refreshUrl: "",
            refreshUrlHost: "",
            notes: "",
            error:
              error instanceof ProxyRefreshError || error instanceof ProxyVaultError
                ? error.message
                : "Invalid proxy row.",
          });
        }
      });
    } else {
      const nonEmptyLines: Array<{ line: number; text: string }> = [];
      rawLines.forEach((rawLine, i) => {
        const text = rawLine.trim();
        if (!text || text.startsWith("#")) return;
        nonEmptyLines.push({ line: i + 1, text });
      });
      if (nonEmptyLines.length === 0) {
        throw new ProxyVaultError("Import input contains no proxy entries.");
      }
      if (nonEmptyLines.length > MAX_IMPORT_ROWS) {
        throw new ProxyVaultError(`Import exceeds the ${MAX_IMPORT_ROWS}-row limit.`, 400, "too_many_rows");
      }

      nonEmptyLines.forEach(({ line, text }, idx) => {
        try {
          const parsed = parseProxySpec(defaultType, text);
          if (!parsed) throw new Error("empty proxy");
          const proxy: ProxySpec = { ...parsed, host: canonicalProxyHost(parsed.host) };
          candidates.push({
            index: idx,
            line,
            name: "",
            group: defaultGroup,
            proxy,
            canonicalHost: proxy.host,
            port: Number(proxy.port),
            endpointHash: computeProxyEndpointHash(proxy),
            refreshUrl: "",
            refreshUrlHost: "",
            notes: "",
          });
        } catch {
          candidates.push({
            index: idx,
            line,
            name: "",
            group: defaultGroup,
            proxy: null,
            canonicalHost: "",
            port: null,
            endpointHash: null,
            refreshUrl: "",
            refreshUrlHost: "",
            notes: "",
            error: "Invalid proxy format. Expected host:port[:user:pass] or a proxy URL.",
          });
        }
      });
    }

    return { detectedFormat, candidates };
  }

  private evaluateImportPlan(input: ImportProxyVaultInput): {
    detectedFormat: "text" | "csv";
    duplicateStrategy: ImportDuplicateStrategy;
    rows: ImportPreviewRow[];
    candidates: ParsedImportCandidate[];
    existingByHash: Map<string, RawVaultRow>;
  } {
    const duplicateStrategy: ImportDuplicateStrategy = input.duplicateStrategy ?? "skip_duplicates";
    if (duplicateStrategy !== "skip_duplicates" && duplicateStrategy !== "update_existing") {
      throw new ProxyVaultError("duplicateStrategy must be skip_duplicates or update_existing.");
    }

    const { detectedFormat, candidates } = this.parseImportCandidates(input);
    const existingRows = this.loadAllRawRows();
    const existingByHash = new Map<string, RawVaultRow>();
    for (const row of existingRows) {
      if (!existingByHash.has(row.endpoint_hash)) {
        existingByHash.set(row.endpoint_hash, row);
      }
    }

    const seenBatchHashes = new Set<string>();
    const rows: ImportPreviewRow[] = candidates.map((candidate) => {
      if (candidate.error || !candidate.proxy || !candidate.endpointHash || candidate.port === null) {
        return {
          index: candidate.index,
          line: candidate.line,
          name: candidate.name,
          group: candidate.group,
          type: null,
          host: "",
          port: null,
          endpoint: null,
          hasAuth: false,
          hasRefreshUrl: false,
          refreshUrlHost: "",
          notes: candidate.notes,
          status: "invalid",
          action: "error",
          error: candidate.error ?? "Invalid proxy row.",
        };
      }

      const base = {
        index: candidate.index,
        line: candidate.line,
        name: candidate.name,
        group: candidate.group,
        type: candidate.proxy.type,
        host: candidate.canonicalHost,
        port: candidate.port,
        endpoint: formatVaultEndpoint(candidate.proxy.type, candidate.canonicalHost, candidate.port),
        hasAuth: candidate.proxy.user.length > 0,
        hasRefreshUrl: candidate.refreshUrl.length > 0,
        refreshUrlHost: candidate.refreshUrlHost,
        notes: candidate.notes,
      };

      if (seenBatchHashes.has(candidate.endpointHash)) {
        return {
          ...base,
          status: "duplicate_in_batch",
          action: "skip",
        };
      }
      seenBatchHashes.add(candidate.endpointHash);

      const existing = existingByHash.get(candidate.endpointHash);
      if (existing) {
        return {
          ...base,
          status: "duplicate_existing",
          action: duplicateStrategy === "update_existing" ? "update" : "skip",
          existingId: existing.id,
          existingName: existing.name,
        };
      }

      return {
        ...base,
        status: "new",
        action: "create",
      };
    });

    return { detectedFormat, duplicateStrategy, rows, candidates, existingByHash };
  }

  previewImport(input: ImportProxyVaultInput): ImportPreviewResult {
    const { detectedFormat, duplicateStrategy, rows } = this.evaluateImportPlan(input);
    let newCount = 0;
    let duplicateExistingCount = 0;
    let duplicateInBatchCount = 0;
    let invalidCount = 0;
    let wouldCreate = 0;
    let wouldUpdate = 0;
    let wouldSkip = 0;

    for (const row of rows) {
      if (row.status === "new") newCount++;
      else if (row.status === "duplicate_existing") duplicateExistingCount++;
      else if (row.status === "duplicate_in_batch") duplicateInBatchCount++;
      else invalidCount++;

      if (row.action === "create") wouldCreate++;
      else if (row.action === "update") wouldUpdate++;
      else if (row.action === "skip") wouldSkip++;
    }

    return {
      detectedFormat,
      duplicateStrategy,
      summary: {
        totalRows: rows.length,
        validRows: rows.length - invalidCount,
        newCount,
        duplicateExistingCount,
        duplicateInBatchCount,
        invalidCount,
        wouldCreate,
        wouldUpdate,
        wouldSkip,
      },
      rows,
    };
  }

  applyImport(input: ImportProxyVaultInput): ImportApplyResult {
    const plan = this.evaluateImportPlan(input);
    const createdIds: string[] = [];
    const updatedIds: string[] = [];
    const errors: Array<{ line: number; error: string }> = [];
    let skipped = 0;

    this.store.withTransaction(() => {
      const db = this.store.rawDatabase();
      const insertStmt = db.query(
        `INSERT INTO proxy_vault (
           id, name, "group", type, host, port,
           auth_encrypted, has_auth, endpoint_hash,
           refresh_url_encrypted, has_refresh_url, refresh_url_host,
           notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateStmt = db.query(
        `UPDATE proxy_vault
            SET name = ?, "group" = ?,
                refresh_url_encrypted = ?, has_refresh_url = ?, refresh_url_host = ?,
                notes = ?, updated_at = ?
          WHERE id = ?`,
      );

      const now = Date.now();
      for (let i = 0; i < plan.rows.length; i++) {
        const previewRow = plan.rows[i]!;
        const candidate = plan.candidates[i]!;
        if (previewRow.action === "error") {
          errors.push({ line: previewRow.line, error: previewRow.error ?? "Invalid proxy row." });
          continue;
        }
        if (previewRow.action === "skip") {
          skipped++;
          continue;
        }
        if (previewRow.action === "create" && candidate.proxy && candidate.endpointHash && candidate.port !== null) {
          const id = generateProxyVaultId();
          const { authEncrypted, hasAuth } = this.encryptAuth(candidate.proxy.user, candidate.proxy.pass);
          const refresh = candidate.refreshUrl
            ? this.encryptRefreshUrl(candidate.refreshUrl)
            : { refreshUrlEncrypted: "", hasRefreshUrl: 0, refreshUrlHost: "" };
          insertStmt.run(
            id,
            candidate.name,
            candidate.group,
            candidate.proxy.type,
            candidate.canonicalHost,
            candidate.port,
            authEncrypted,
            hasAuth,
            candidate.endpointHash,
            refresh.refreshUrlEncrypted,
            refresh.hasRefreshUrl,
            refresh.refreshUrlHost,
            candidate.notes,
            now,
            now,
          );
          createdIds.push(id);
          continue;
        }
        if (previewRow.action === "update" && candidate.endpointHash) {
          const existing = plan.existingByHash.get(candidate.endpointHash);
          if (!existing) {
            skipped++;
            continue;
          }
          const nextName = candidate.name || existing.name;
          const nextGroup = candidate.group || existing.group;
          const nextNotes = candidate.notes || existing.notes;
          const refresh = candidate.refreshUrl
            ? this.encryptRefreshUrl(candidate.refreshUrl)
            : {
                refreshUrlEncrypted: existing.refresh_url_encrypted,
                hasRefreshUrl: existing.has_refresh_url,
                refreshUrlHost: existing.refresh_url_host,
              };
          updateStmt.run(
            nextName,
            nextGroup,
            refresh.refreshUrlEncrypted,
            refresh.hasRefreshUrl,
            refresh.refreshUrlHost,
            nextNotes,
            now,
            existing.id,
          );
          updatedIds.push(existing.id);
        }
      }
    });

    return {
      detectedFormat: plan.detectedFormat,
      duplicateStrategy: plan.duplicateStrategy,
      created: createdIds.length,
      updated: updatedIds.length,
      skipped,
      invalid: errors.length,
      createdIds,
      updatedIds,
      errors,
    };
  }

  /**
   * Bind 1..N vault proxies to 1..N profiles in `single` or `round_robin` mode.
   * Materializes the ProxySpec onto closed profiles in the same transaction; running
   * profiles are safely skipped. Supports `dryRun: true` for pre-bind risk preview.
   */
  bindProfiles(input: BindProfilesInput): BindProfilesResult {
    const proxyIds = [...new Set(input.proxyIds)];
    const profileIds = [...new Set(input.profileIds)];
    if (proxyIds.length === 0) throw new ProxyVaultError("Select at least one proxy from the vault.");
    if (profileIds.length === 0) throw new ProxyVaultError("Select at least one profile to bind.");
    if (proxyIds.some((id) => !isValidProxyVaultId(id))) {
      throw new ProxyVaultError("One or more proxy vault IDs are invalid.", 400, "invalid_id");
    }
    if (profileIds.some((id) => !isSafeProfileId(id))) {
      throw new ProxyVaultError(PROFILE_ID_ERROR, 400, "invalid_profile_id");
    }

    const mode: BindMode = input.mode ?? (proxyIds.length === 1 ? "single" : "round_robin");
    if (mode !== "single" && mode !== "round_robin") {
      throw new ProxyVaultError("mode must be single or round_robin.");
    }
    if (mode === "single" && proxyIds.length !== 1) {
      throw new ProxyVaultError("single bind mode requires exactly one proxyId.");
    }

    const profilesPerProxy = input.profilesPerProxy ?? 1;
    if (!Number.isInteger(profilesPerProxy) || profilesPerProxy < 1 || profilesPerProxy > 10_000) {
      throw new ProxyVaultError("profilesPerProxy must be a positive integer.");
    }
    const dryRun = input.dryRun === true;

    const internalById = new Map<string, ProxyVaultInternalRecord>();
    for (const proxyId of proxyIds) {
      const record = this.getInternalRecord(proxyId);
      if (!record) {
        throw new ProxyVaultError(`Proxy vault entry not found: ${proxyId}`, 404, "not_found");
      }
      internalById.set(proxyId, record);
    }

    const assignments = profileIds.map((profileId, idx) => {
      const assignedProxyId =
        mode === "single"
          ? proxyIds[0]!
          : proxyIds[Math.floor(idx / profilesPerProxy) % proxyIds.length]!;
      return { profileId, proxy: internalById.get(assignedProxyId)! };
    });

    const results: BindProfileRowResult[] = [];
    const simulatedAssignments = new Map<string, { proxyId: string; endpointHash: string; profile: Profile }>();
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const now = Date.now();

    const execute = () => {
      const db = this.store.rawDatabase();
      const existingBindingStmt = db.query<{ proxy_id: string; synced_endpoint_hash: string }, [string]>(
        `SELECT proxy_id, synced_endpoint_hash FROM profile_proxy_bindings WHERE profile_id = ?`,
      );
      const upsertBindingStmt = db.query(
        `INSERT INTO profile_proxy_bindings (profile_id, proxy_id, bound_at, synced_endpoint_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           proxy_id = excluded.proxy_id,
           bound_at = excluded.bound_at,
           synced_endpoint_hash = excluded.synced_endpoint_hash`,
      );

      for (const { profileId, proxy } of assignments) {
        const profile = this.store.getProfile(profileId);
        if (!profile) {
          skipped++;
          results.push({
            profileId,
            proxyId: proxy.id,
            proxyName: proxy.name,
            status: "skipped",
            reason: "profile_not_found",
          });
          continue;
        }
        if (this.store.getLaunch(profileId)) {
          skipped++;
          results.push({
            profileId,
            profileName: profile.name,
            proxyId: proxy.id,
            proxyName: proxy.name,
            status: "skipped",
            reason: "profile_open",
          });
          continue;
        }

        const currentBinding = existingBindingStmt.get(profileId);
        const currentProfileHash =
          !profile.proxyError && profile.proxy ? computeProxyEndpointHash(profile.proxy) : null;
        const alreadySynced =
          currentProfileHash === proxy.endpointHash &&
          currentBinding?.proxy_id === proxy.id &&
          currentBinding?.synced_endpoint_hash === proxy.endpointHash;

        if (!dryRun) {
          if (currentProfileHash !== proxy.endpointHash || profile.proxyError) {
            const nextProfile: Profile = {
              ...profile,
              proxy: { ...proxy.proxy },
              timezone: profile.timezoneManual ? profile.timezone : "",
            };
            delete nextProfile.proxyError;
            this.store.upsertProfile(nextProfile);
          }
          upsertBindingStmt.run(profileId, proxy.id, now, proxy.endpointHash);
        } else {
          simulatedAssignments.set(profileId, {
            proxyId: proxy.id,
            endpointHash: proxy.endpointHash,
            profile,
          });
        }

        if (alreadySynced) {
          unchanged++;
          results.push({
            profileId,
            profileName: profile.name,
            proxyId: proxy.id,
            proxyName: proxy.name,
            status: "unchanged",
          });
        } else {
          updated++;
          results.push({
            profileId,
            profileName: profile.name,
            proxyId: proxy.id,
            proxyName: proxy.name,
            status: "bound",
          });
        }
      }
    };

    if (dryRun) {
      execute();
    } else {
      this.store.withTransaction(execute);
    }

    // Build post-bind risk summary across all involved vault proxies.
    const allRows = this.loadAllRawRows();
    let effectiveBindings = this.loadActiveBindings();
    if (dryRun && simulatedAssignments.size > 0) {
      effectiveBindings = effectiveBindings.filter((b) => !simulatedAssignments.has(b.profile_id));
      for (const [profileId, sim] of simulatedAssignments) {
        effectiveBindings.push({
          profile_id: profileId,
          proxy_id: sim.proxyId,
          bound_at: now,
          synced_endpoint_hash: sim.endpointHash,
          profile_name: sim.profile.name,
          profile_group: sim.profile.group,
          profile_platform: sim.profile.platform ?? "",
          running: 0,
        });
      }
    }

    const viewsById = new Map(this.buildItemViews(allRows, effectiveBindings).map((view) => [view.id, view]));
    const byProxy: BindRiskSummary["byProxy"] = {};
    const allRisks: ProxyVaultRiskItem[] = [];
    let highCount = 0;
    let mediumCount = 0;

    for (const proxyId of proxyIds) {
      const view = viewsById.get(proxyId);
      if (!view) continue;
      byProxy[proxyId] = {
        riskLevel: view.riskLevel,
        risks: view.risks,
        boundProfiles: view.boundProfiles,
      };
      allRisks.push(...view.risks);
      if (view.riskLevel === "high") highCount++;
      else if (view.riskLevel === "medium") mediumCount++;
    }

    return {
      dryRun,
      mode,
      profilesPerProxy,
      updated,
      unchanged,
      skipped,
      results,
      riskSummary: {
        highestRisk: highestRiskLevel(allRisks),
        highCount,
        mediumCount,
        byProxy,
      },
    };
  }

  /** Push edited vault proxy credentials down to all closed bound profiles. */
  syncBoundProfiles(proxyId: string, options: { dryRun?: boolean } = {}): SyncBoundProfilesResult {
    if (!isValidProxyVaultId(proxyId)) {
      throw new ProxyVaultError("Invalid proxy vault ID.", 400, "invalid_id");
    }
    const vaultRecord = this.getInternalRecord(proxyId);
    if (!vaultRecord) {
      throw new ProxyVaultError("Proxy vault entry not found.", 404, "not_found");
    }
    const dryRun = options.dryRun === true;

    const activeBindings = this.loadActiveBindings().filter((b) => b.proxy_id === proxyId);
    const results: SyncBoundRowResult[] = [];
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const now = Date.now();

    const execute = () => {
      const upsertBindingStmt = this.store.rawDatabase().query(
        `INSERT INTO profile_proxy_bindings (profile_id, proxy_id, bound_at, synced_endpoint_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           proxy_id = excluded.proxy_id,
           synced_endpoint_hash = excluded.synced_endpoint_hash`,
      );

      for (const binding of activeBindings) {
        const profile = this.store.getProfile(binding.profile_id);
        if (!profile) continue;
        if (this.store.getLaunch(profile.id)) {
          skipped++;
          results.push({
            profileId: profile.id,
            profileName: profile.name,
            status: "skipped",
            reason: "profile_open",
          });
          continue;
        }
        const currentHash =
          !profile.proxyError && profile.proxy ? computeProxyEndpointHash(profile.proxy) : null;
        const alreadyInSync =
          currentHash === vaultRecord.endpointHash &&
          binding.synced_endpoint_hash === vaultRecord.endpointHash;

        if (alreadyInSync) {
          unchanged++;
          results.push({
            profileId: profile.id,
            profileName: profile.name,
            status: "unchanged",
          });
          continue;
        }

        if (!dryRun) {
          if (currentHash !== vaultRecord.endpointHash || profile.proxyError) {
            const nextProfile: Profile = {
              ...profile,
              proxy: { ...vaultRecord.proxy },
              timezone: profile.timezoneManual ? profile.timezone : "",
            };
            delete nextProfile.proxyError;
            this.store.upsertProfile(nextProfile);
          }
          upsertBindingStmt.run(profile.id, vaultRecord.id, binding.bound_at || now, vaultRecord.endpointHash);
        }
        updated++;
        results.push({
          profileId: profile.id,
          profileName: profile.name,
          status: "updated",
        });
      }
    };

    if (dryRun) {
      execute();
    } else {
      this.store.withTransaction(execute);
    }

    return {
      proxyId,
      dryRun,
      updated,
      unchanged,
      skipped,
      results,
    };
  }

  /** Deduplicate and ingest proxies already saved on existing profiles into the vault. */
  ingestFromProfiles(input: IngestFromProfilesInput = {}): IngestFromProfilesResult {
    const bind = input.bind !== false;
    const defaultGroup =
      input.defaultGroup !== undefined
        ? validateTextField(input.defaultGroup, "Default group", MAX_VAULT_GROUP_LENGTH)
        : undefined;

    let profiles: Profile[];
    if (input.profileIds !== undefined) {
      const uniqueIds = [...new Set(input.profileIds)];
      if (uniqueIds.some((id) => !isSafeProfileId(id))) {
        throw new ProxyVaultError(PROFILE_ID_ERROR, 400, "invalid_profile_id");
      }
      profiles = uniqueIds
        .map((id) => this.store.getProfile(id))
        .filter((profile): profile is Profile => profile !== null);
    } else {
      profiles = this.store.listProfiles();
    }

    const createdIds: string[] = [];
    let created = 0;
    let reused = 0;
    let bound = 0;
    let skippedWithoutProxy = 0;
    let skippedInvalid = 0;

    this.store.withTransaction(() => {
      const db = this.store.rawDatabase();
      const existingByHash = new Map<string, string>();
      for (const row of this.loadAllRawRows()) {
        if (!existingByHash.has(row.endpoint_hash)) {
          existingByHash.set(row.endpoint_hash, row.id);
        }
      }

      const insertVaultStmt = db.query(
        `INSERT INTO proxy_vault (
           id, name, "group", type, host, port,
           auth_encrypted, has_auth, endpoint_hash,
           refresh_url_encrypted, has_refresh_url, refresh_url_host,
           notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, '', '', ?, ?)`,
      );
      const getBindingStmt = db.query<{ proxy_id: string; synced_endpoint_hash: string }, [string]>(
        `SELECT proxy_id, synced_endpoint_hash FROM profile_proxy_bindings WHERE profile_id = ?`,
      );
      const upsertBindingStmt = db.query(
        `INSERT INTO profile_proxy_bindings (profile_id, proxy_id, bound_at, synced_endpoint_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           proxy_id = excluded.proxy_id,
           bound_at = excluded.bound_at,
           synced_endpoint_hash = excluded.synced_endpoint_hash`,
      );

      const now = Date.now();
      for (const profile of profiles) {
        if (profile.proxyError) {
          skippedInvalid++;
          continue;
        }
        if (!profile.proxy) {
          skippedWithoutProxy++;
          continue;
        }
        let spec: ProxySpec;
        let endpointHash: string;
        try {
          const normalized = normalizeProxySpec(profile.proxy);
          if (!normalized) {
            skippedWithoutProxy++;
            continue;
          }
          spec = { ...normalized, host: canonicalProxyHost(normalized.host) };
          endpointHash = computeProxyEndpointHash(spec);
        } catch {
          skippedInvalid++;
          continue;
        }

        let proxyId = existingByHash.get(endpointHash);
        if (!proxyId) {
          proxyId = generateProxyVaultId();
          const { authEncrypted, hasAuth } = this.encryptAuth(spec.user, spec.pass);
          const group = (defaultGroup ?? profile.group ?? "").trim().slice(0, MAX_VAULT_GROUP_LENGTH);
          const rawName = profile.name
            ? `${profile.name} (${spec.host}:${spec.port})`
            : `${spec.host}:${spec.port}`;
          const name = rawName.trim().slice(0, MAX_VAULT_NAME_LENGTH);
          insertVaultStmt.run(
            proxyId,
            name,
            group,
            spec.type,
            spec.host,
            Number(spec.port),
            authEncrypted,
            hasAuth,
            endpointHash,
            now,
            now,
          );
          existingByHash.set(endpointHash, proxyId);
          createdIds.push(proxyId);
          created++;
        } else {
          reused++;
        }

        if (bind) {
          const existingBinding = getBindingStmt.get(profile.id);
          if (
            existingBinding?.proxy_id !== proxyId ||
            existingBinding?.synced_endpoint_hash !== endpointHash
          ) {
            upsertBindingStmt.run(profile.id, proxyId, now, endpointHash);
            bound++;
          }
        }
      }
    });

    return {
      scanned: profiles.length,
      created,
      reused,
      bound,
      skippedWithoutProxy,
      skippedInvalid,
      createdIds,
    };
  }

  /** Persist check status, latency median, and exit IP telemetry onto a vault entry. */
  recordCheckResult(proxyId: string, telemetry: VaultCheckTelemetry): ProxyVaultItemView | null {
    if (!isValidProxyVaultId(proxyId)) return null;
    const now = telemetry.checkedAt ?? Date.now();
    const exitIp = telemetry.ip ? canonicalIp(telemetry.ip) ?? "" : "";
    const latency =
      telemetry.latencyMs !== null && Number.isFinite(telemetry.latencyMs) && telemetry.latencyMs >= 0
        ? Math.round(telemetry.latencyMs)
        : null;
    const changed = this.store.withTransaction(() => {
      const res = this.store
        .rawDatabase()
        .query(
          `UPDATE proxy_vault
              SET last_status = ?,
                  last_reason = ?,
                  last_latency_ms = ?,
                  last_exit_ip = ?,
                  last_exit_country = ?,
                  last_exit_region = ?,
                  last_exit_city = ?,
                  last_exit_rotating = ?,
                  last_exit_comparison = ?,
                  last_checked_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          telemetry.status,
          telemetry.reason ?? "",
          latency,
          exitIp,
          telemetry.country ?? "",
          telemetry.region ?? "",
          telemetry.city ?? "",
          telemetry.rotating ? 1 : 0,
          telemetry.exitComparison ?? "",
          now,
          now,
          proxyId,
        );
      return Number(res.changes) > 0;
    });
    return changed ? this.getView(proxyId) : null;
  }

  recordRefreshTimestamp(proxyId: string, refreshedAt = Date.now()): void {
    if (!isValidProxyVaultId(proxyId)) return;
    this.store.withTransaction(() => {
      this.store
        .rawDatabase()
        .query(`UPDATE proxy_vault SET last_refreshed_at = ?, updated_at = ? WHERE id = ?`)
        .run(refreshedAt, refreshedAt, proxyId);
    });
  }
}
