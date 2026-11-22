/**
 * Two-stage controlled AI Copilot proposal system:
 *   Stage 1: Plain-text model output with optional single ```maobu-proposal JSON block (<= 16 KiB)
 *   Stage 2: Deterministic local validation, dry-run planning, incarnation + HMAC planHash TOCTOU
 *            binding, and explicit human-confirmed streamed execution with emergency stop.
 *
 * Security invariants:
 * - Never auto-executes model output; never enables native model tool_calls.
 * - Never serializes credentials, cookies, sessions, proxy host/port/user/pass, refreshUrl,
 *   CDP ws/debugPort, firefoxOwner, or notes into the model catalog.
 * - Hard-rejects forbidden actions (delete/trash/export/secrets/cookies/scripts/shell/settings/raw proxy).
 * - Enforces MAX_PROPOSAL_TARGETS = 200, isSafeProfileId(), incarnation + stateDigest verification,
 *   and bounded workspace-scoped proposal storage (32 entries, 10-minute TTL, cleared on workspace switch).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isMobileUserAgent } from "./fingerprint.ts";
import { buildStoredFingerprintReport } from "./fingerprint-report.ts";
import { BrowserLaunchError, launchIdentityChanged, type Launcher } from "./launcher.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { normalizeProfileTags, ProfileTagsValidationError } from "./profile-tags.ts";
import {
  isValidProxyVaultId,
  ProxyVaultError,
  ProxyVaultStore,
  type ProxyVaultListResult,
} from "./src/proxy-vault/proxy-vault-store.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile, ProxySpec, ProxyType } from "./types.ts";

export const MAX_PROPOSAL_BLOCK_BYTES = 16 * 1024;
export const MAX_PROPOSAL_TARGETS = 200;
export const MAX_CATALOG_PROFILES = 200;
export const MAX_CATALOG_GROUPS = 100;
export const MAX_CATALOG_TAGS = 100;
export const MAX_CATALOG_VAULT_ITEMS = 200;
export const MAX_CATALOG_JSON_BYTES = 10 * 1024;
export const MAX_STORED_PROPOSALS = 32;
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const PROPOSAL_ID_PATTERN = /^prop_[0-9a-f]{16}$/;
export const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const SENSITIVE_PROFILE_FIELD_BLACKLIST = Object.freeze([
  "username",
  "password",
  "email",
  "emailPassword",
  "twofa",
  "cookies",
  "session_json",
  "proxy.host",
  "proxy.port",
  "proxy.user",
  "proxy.pass",
  "refreshUrl",
  "ws",
  "debugPort",
  "firefoxOwner",
  "notes",
] as const);

export const FORBIDDEN_PROPOSAL_ACTIONS = Object.freeze([
  "delete",
  "trash",
  "export",
  "read_secrets",
  "update_credentials",
  "inject_cookies",
  "run_script",
  "shell_exec",
  "modify_settings",
  "raw_proxy_string",
] as const);

const FORBIDDEN_ACTION_SET = new Set<string>(FORBIDDEN_PROPOSAL_ACTIONS);
const FORBIDDEN_ACTION_SUBSTRING =
  /(?:^|_)(?:delete|trash|remove_profile|purge|export|secret|credential|password|twofa|cookie|script|shell|exec|command|setting|raw_proxy|proxy_string)(?:$|_)/i;

export const ALLOWED_PROPOSAL_ACTION_TYPES = Object.freeze([
  "filter_anomalous_profiles",
  "batch_move_group",
  "batch_update_tags",
  "batch_replace_failed_proxies",
  "batch_launch_profiles",
  "batch_stop_profiles",
  "generate_fingerprint_summary",
] as const);

export const ANOMALY_CRITERIA = Object.freeze([
  "proxy_error",
  "restart_pending",
  "mobile_persona",
  "fp_issues",
  "fp_unmeasured",
  "no_proxy",
] as const);

export type AnomalyCriterion = (typeof ANOMALY_CRITERIA)[number];
export type ProposalRiskLevel = "read-only" | "low" | "medium" | "high";
export type AssistantCatalogFpStatus = "issues" | "review" | "unmeasured" | "consistent";

export type AssistantProposalAction =
  | {
      type: "filter_anomalous_profiles";
      criteria: AnomalyCriterion[];
      group?: string;
      tags?: string[];
    }
  | {
      type: "batch_move_group";
      profileIds: string[];
      targetGroup: string;
      allowCreateGroup?: boolean;
    }
  | {
      type: "batch_update_tags";
      profileIds: string[];
      mode: "add" | "remove" | "replace";
      tags: string[];
    }
  | {
      type: "batch_replace_failed_proxies";
      profileIds: string[];
      source: "proxy_vault_healthy";
      vaultGroup?: string;
      country?: string;
      avoidDuplicateExit?: boolean;
      skipRunning: true;
    }
  | {
      type: "batch_launch_profiles";
      profileIds: string[];
      concurrency?: number;
    }
  | {
      type: "batch_stop_profiles";
      profileIds: string[];
      concurrency?: number;
    }
  | {
      type: "generate_fingerprint_summary";
      profileIds: string[];
    };

export interface AssistantCatalogProfile {
  id: string;
  name: string;
  group: string;
  tags: string[];
  engine: "chromium" | "firefox";
  running: boolean;
  hasProxy: boolean;
  proxyError: boolean;
  restartPending: boolean;
  mobilePersona: boolean;
  fpStatus: AssistantCatalogFpStatus;
  lastOpenAt: number;
}

export interface AssistantProxyVaultSummaryItem {
  vaultId: string;
  label: string;
  group: string;
  type: ProxyType;
  country: string;
  status: string;
  assignedCount: number;
}

export interface AssistantActionCatalog {
  profiles: AssistantCatalogProfile[];
  omittedCount: number;
  totalProfiles: number;
  groups: string[];
  tags: string[];
  proxyVaultSummary: AssistantProxyVaultSummaryItem[];
  proxyVaultAvailable: boolean;
}

export interface AssistantProxyVaultResolvedProxy {
  vaultId: string;
  label: string;
  proxy: ProxySpec;
  group: string;
  country: string;
  exitIp?: string;
}

export interface AssistantProxyVaultLookup {
  listHealthySummary(): AssistantProxyVaultSummaryItem[];
  resolveProxySpec(vaultId: string): AssistantProxyVaultResolvedProxy | null;
  bindProfileToVault?(vaultId: string, profileId: string): { ok: boolean; reason?: string };
}

export type ProposalErrorCode =
  | "multiple_proposal_blocks"
  | "proposal_too_large"
  | "invalid_proposal_json"
  | "forbidden_action"
  | "unsupported_action"
  | "invalid_action_schema"
  | "invalid_profile_id"
  | "too_many_targets"
  | "invalid_proposal_id"
  | "proposal_not_found"
  | "proposal_expired"
  | "plan_hash_mismatch"
  | "proposal_already_running"
  | "high_risk_confirmation_required"
  | "invalid_selection"
  | "nothing_to_execute"
  | "registry_busy";

export class AssistantProposalError extends Error {
  constructor(
    readonly code: ProposalErrorCode,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "AssistantProposalError";
  }
}

export interface ParsedAssistantProposal {
  version: 1;
  title: string;
  summary: string;
  action: AssistantProposalAction;
}

export type ProposalParseResult =
  | { status: "none" }
  | { status: "ok"; proposal: ParsedAssistantProposal }
  | { status: "error"; code: ProposalErrorCode; error: string };

export interface ProposalWarning {
  code: string;
  message: string;
}

export interface CompiledProposalItemView {
  profileId: string;
  profileName: string;
  group: string;
  running: boolean;
  executable: boolean;
  defaultSelected: boolean;
  beforeSummary: string;
  afterSummary: string;
  skipReason?: string;
  skipDetail?: string;
  targetVaultId?: string;
  targetVaultLabel?: string;
}

export interface CompiledProposalView {
  proposalId: string;
  planHash: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  title: string;
  summary: string;
  actionType: AssistantProposalAction["type"];
  action: AssistantProposalAction;
  risk: ProposalRiskLevel;
  requiresSecondaryConfirm: boolean;
  mutatesWorkspace: boolean;
  warnings: ProposalWarning[];
  counts: {
    total: number;
    actionable: number;
    skipped: number;
  };
  items: CompiledProposalItemView[];
}

export type ProposalExecutionItemStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "aborted";

export interface ProposalExecutionItemReceipt {
  profileId: string;
  profileName: string;
  status: ProposalExecutionItemStatus;
  reason?: string;
  detail?: string;
  beforeSummary?: string;
  afterSummary?: string;
  fpSummary?: {
    status: AssistantCatalogFpStatus;
    pass: number;
    warn: number;
    fail: number;
    unknown: number;
  };
  finishedAt?: number;
}

export interface ProposalFingerprintSummary {
  total: number;
  consistent: number;
  review: number;
  issues: number;
  unmeasured: number;
  topChecks: Array<{ id: string; label: string; failCount: number; warnCount: number }>;
}

export interface ProposalFilterResult {
  profileIds: string[];
  criteria: AnomalyCriterion[];
  group?: string;
  tags?: string[];
}

export interface ProposalExecutionSnapshot {
  proposalId: string;
  planHash: string;
  status: "compiled" | "running" | "completed" | "aborted" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  selectedProfileIds: string[];
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  aborted: number;
  items: ProposalExecutionItemReceipt[];
  filterResult?: ProposalFilterResult;
  fingerprintSummary?: ProposalFingerprintSummary;
  error?: string;
}

export type ProposalStreamEvent =
  | {
      type: "start";
      proposalId: string;
      actionType: AssistantProposalAction["type"];
      risk: ProposalRiskLevel;
      total: number;
      selectedProfileIds: string[];
      startedAt: number;
    }
  | {
      type: "item";
      proposalId: string;
      index: number;
      total: number;
      completed: number;
      item: ProposalExecutionItemReceipt;
    }
  | {
      type: "summary";
      proposalId: string;
      snapshot: ProposalExecutionSnapshot;
    }
  | {
      type: "aborted";
      proposalId: string;
      snapshot: ProposalExecutionSnapshot;
    }
  | {
      type: "error";
      proposalId: string;
      code: string;
      error: string;
    };

export interface ProposalExecutionDeps {
  store: ProfileStore;
  launcher?: Pick<Launcher, "start" | "stop" | "captureLocalSession">;
  proxyVault?: AssistantProxyVaultLookup;
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export interface ProposalExecuteInput {
  planHash: string;
  selectedProfileIds?: string[];
  confirmHighRisk?: boolean;
}

export type ProposalCatalogStore = Pick<
  ProfileStore,
  "listProfiles" | "listLaunches" | "listProfileMeta" | "listGroups" | "getFingerprintSource"
>;

interface InternalProposalRecord {
  view: CompiledProposalView;
  incarnations: Record<string, string | null>;
  stateDigests: Record<string, string>;
  appliedProfileIds: Set<string>;
  execution: ProposalExecutionSnapshot;
  abortController: AbortController | null;
}

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const RAW_PROXY_PATTERN = /(?:(?:https?|socks5h?):\/\/|\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b|@)/i;
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_FP_STATUSES = new Set<string>(["issues", "review", "unmeasured", "consistent"]);
const VALID_PROXY_TYPES = new Set<string>(["http", "https", "socks5"]);
const VALID_CRITERIA = new Set<string>(ANOMALY_CRITERIA);
const storeWorkspaceScopes = new WeakMap<object, string>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasPoisonKeys(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasPoisonKeys(item, depth + 1));
  for (const key of Object.keys(value)) {
    if (POISON_KEYS.has(key)) return true;
    if (hasPoisonKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

function sanitizeCatalogText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : cleaned;
}

function validateSafeText(value: unknown, label: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new AssistantProposalError("invalid_action_schema", `${label} must be a string.`);
  }
  if (CONTROL_OR_BIDI.test(value)) {
    throw new AssistantProposalError("invalid_action_schema", `${label} contains forbidden control characters.`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new AssistantProposalError("invalid_action_schema", `${label} must not be empty.`);
  }
  if (Array.from(trimmed).length > maxChars) {
    throw new AssistantProposalError("invalid_action_schema", `${label} exceeds ${maxChars} characters.`);
  }
  return trimmed;
}

function validateProfileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AssistantProposalError("invalid_action_schema", "profileIds must be a non-empty array.");
  }
  if (value.length > MAX_PROPOSAL_TARGETS) {
    throw new AssistantProposalError(
      "too_many_targets",
      `Proposal targets exceed the maximum limit of ${MAX_PROPOSAL_TARGETS} profiles.`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (!isSafeProfileId(raw)) {
      throw new AssistantProposalError("invalid_profile_id", "One or more target profile IDs are invalid.");
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      result.push(raw);
    }
  }
  return result;
}

function checkAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      if (FORBIDDEN_ACTION_SET.has(key.toLowerCase()) || FORBIDDEN_ACTION_SUBSTRING.test(key)) {
        throw new AssistantProposalError(
          "forbidden_action",
          `Forbidden field "${key}" is not allowed in ${context}.`,
        );
      }
      throw new AssistantProposalError(
        "invalid_action_schema",
        `Unexpected field "${key}" in ${context}.`,
      );
    }
  }
}

export function isValidProposalId(value: unknown): value is string {
  return typeof value === "string" && PROPOSAL_ID_PATTERN.test(value);
}

export function actionRiskLevel(type: AssistantProposalAction["type"]): ProposalRiskLevel {
  switch (type) {
    case "filter_anomalous_profiles":
    case "generate_fingerprint_summary":
      return "read-only";
    case "batch_move_group":
    case "batch_update_tags":
      return "low";
    case "batch_launch_profiles":
    case "batch_stop_profiles":
      return "medium";
    case "batch_replace_failed_proxies":
      return "high";
  }
}

export function defaultProposalTitle(action: AssistantProposalAction): string {
  switch (action.type) {
    case "filter_anomalous_profiles":
      return "Locate anomalous profiles";
    case "batch_move_group":
      return action.targetGroup
        ? `Move ${action.profileIds.length} profiles to "${action.targetGroup}"`
        : `Remove ${action.profileIds.length} profiles from their group`;
    case "batch_update_tags":
      return `Update tags on ${action.profileIds.length} profiles (${action.mode})`;
    case "batch_replace_failed_proxies":
      return `Replace proxies on ${action.profileIds.length} profiles from Proxy Vault`;
    case "batch_launch_profiles":
      return `Launch ${action.profileIds.length} profiles`;
    case "batch_stop_profiles":
      return `Stop ${action.profileIds.length} profiles`;
    case "generate_fingerprint_summary":
      return `Summarize fingerprint checks for ${action.profileIds.length} profiles`;
  }
}

/**
 * Real Wave 3 Proxy Vault adapter for `batch_replace_failed_proxies`.
 * Exposes only redacted labels/group/type/country/status/assignedCount to the model catalog,
 * and resolves encrypted ProxySpec locally at dry-run / execution time only.
 */
export function createProxyVaultLookup(store: ProfileStore): AssistantProxyVaultLookup {
  const vault = new ProxyVaultStore(store);
  return {
    listHealthySummary(): AssistantProxyVaultSummaryItem[] {
      let result: ProxyVaultListResult;
      try {
        result = vault.list();
      } catch {
        return [];
      }
      return result.items
        .filter((item) => item.lastStatus === "working")
        .slice(0, MAX_CATALOG_VAULT_ITEMS)
        .map((item) => ({
          vaultId: item.id,
          // Never fall back to raw host/port/endpoint so network coordinates stay out of model prompts.
          label: sanitizeCatalogText(item.name, 80) || item.id,
          group: sanitizeCatalogText(item.group, 64),
          type: item.type,
          country: sanitizeCatalogText(item.lastExitCountry, 32),
          status: item.lastStatus,
          assignedCount: Math.max(0, Math.floor(item.boundCount)),
        }));
    },
    resolveProxySpec(vaultId: string): AssistantProxyVaultResolvedProxy | null {
      if (!isValidProxyVaultId(vaultId)) return null;
      const view = vault.getView(vaultId);
      if (!view || view.lastStatus !== "working") return null;
      try {
        const internal = vault.getInternalRecord(vaultId);
        if (!internal) return null;
        return {
          vaultId: internal.id,
          label: sanitizeCatalogText(internal.name, 80) || internal.id,
          proxy: { ...internal.proxy },
          group: sanitizeCatalogText(internal.group, 64),
          country: sanitizeCatalogText(view.lastExitCountry, 32),
          exitIp: view.lastExitIp || undefined,
        };
      } catch {
        return null;
      }
    },
    bindProfileToVault(vaultId: string, profileId: string): { ok: boolean; reason?: string } {
      try {
        const res = vault.bindProfiles({
          proxyIds: [vaultId],
          profileIds: [profileId],
          mode: "single",
        });
        const row = res.results[0];
        if (!row) return { ok: false, reason: "bind_failed" };
        if (row.status === "skipped") return { ok: false, reason: row.reason ?? "skipped" };
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof ProxyVaultError ? error.code : "bind_failed" };
      }
    },
  };
}

function anomalyPriorityScore(entry: AssistantCatalogProfile): number {
  let score = 0;
  if (entry.proxyError) score += 100;
  if (entry.fpStatus === "issues") score += 50;
  if (entry.restartPending) score += 30;
  if (entry.mobilePersona) score += 20;
  if (entry.fpStatus === "unmeasured") score += 10;
  if (!entry.hasProxy) score += 5;
  if (entry.fpStatus === "review") score += 3;
  return score;
}

/**
 * Safely read non-sensitive profile metadata for explicit proposal-mode context.
 * Strictly excludes credentials, cookies, sessions, raw proxy host/port/auth,
 * refresh URLs, CDP endpoints/debug ports, firefoxOwner, and notes.
 */
export function buildAssistantActionCatalog(
  store: ProposalCatalogStore,
  options: {
    proxyVault?: AssistantProxyVaultLookup;
    maxProfiles?: number;
    maxJsonBytes?: number;
  } = {},
): AssistantActionCatalog {
  const maxProfiles = Math.max(1, Math.min(MAX_CATALOG_PROFILES, options.maxProfiles ?? MAX_CATALOG_PROFILES));
  const maxJsonBytes = Math.max(512, Math.min(MAX_CATALOG_JSON_BYTES, options.maxJsonBytes ?? MAX_CATALOG_JSON_BYTES));

  const profiles = store.listProfiles();
  const launches = new Map(store.listLaunches().map((launch) => [launch.profileId, launch]));
  const meta = store.listProfileMeta();
  const groupSet = new Set<string>();
  const tagSet = new Set<string>();

  for (const group of store.listGroups()) {
    const clean = sanitizeCatalogText(group, 64);
    if (clean) groupSet.add(clean);
  }

  const mapped: AssistantCatalogProfile[] = [];
  for (const profile of profiles) {
    if (!isSafeProfileId(profile.id)) continue;
    const launch = launches.get(profile.id) ?? null;
    const cleanGroup = sanitizeCatalogText(profile.group, 64);
    if (cleanGroup) groupSet.add(cleanGroup);

    const safeTags: string[] = [];
    if (Array.isArray(profile.tags)) {
      for (const rawTag of profile.tags) {
        const cleanTag = sanitizeCatalogText(rawTag, 40);
        if (cleanTag) {
          tagSet.add(cleanTag);
          if (safeTags.length < 10) safeTags.push(cleanTag);
        }
      }
    }

    let fpStatus: AssistantCatalogFpStatus = "unmeasured";
    try {
      const review = buildStoredFingerprintReport(profile, {
        captureSource: store.getFingerprintSource(profile.id),
        launch,
      });
      fpStatus = review.report.status;
    } catch {
      fpStatus = "unmeasured";
    }

    let restartPending = false;
    if (launch) {
      try {
        restartPending = launchIdentityChanged(profile, launch);
      } catch {
        restartPending = false;
      }
    }

    let mobilePersona = false;
    try {
      mobilePersona = typeof profile.ua === "string" && isMobileUserAgent(profile.ua);
    } catch {
      mobilePersona = false;
    }

    mapped.push({
      id: profile.id,
      name: sanitizeCatalogText(profile.name, 80),
      group: cleanGroup,
      tags: safeTags,
      engine: profile.engine === "firefox" ? "firefox" : "chromium",
      running: Boolean(launch),
      hasProxy: Boolean(profile.proxy),
      proxyError: Boolean(profile.proxyError),
      restartPending,
      mobilePersona,
      fpStatus,
      lastOpenAt: Math.max(0, Math.floor(meta.get(profile.id)?.lastOpenAt ?? 0)),
    });
  }

  mapped.sort((a, b) => {
    const diff = anomalyPriorityScore(b) - anomalyPriorityScore(a);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  const groups = [...groupSet].sort((a, b) => a.localeCompare(b)).slice(0, MAX_CATALOG_GROUPS);
  const tags = [...tagSet].sort((a, b) => a.localeCompare(b)).slice(0, MAX_CATALOG_TAGS);

  let proxyVaultSummary: AssistantProxyVaultSummaryItem[] = [];
  let proxyVaultAvailable = false;
  if (options.proxyVault) {
    try {
      const rawVault = options.proxyVault.listHealthySummary();
      proxyVaultSummary = sanitizeVaultSummaryList(rawVault);
      proxyVaultAvailable = proxyVaultSummary.length > 0;
    } catch {
      proxyVaultSummary = [];
      proxyVaultAvailable = false;
    }
  }

  const candidateProfiles = mapped.slice(0, maxProfiles);
  return fitCatalogToByteBudget(
    {
      profiles: candidateProfiles,
      omittedCount: Math.max(0, mapped.length - candidateProfiles.length),
      totalProfiles: mapped.length,
      groups,
      tags,
      proxyVaultSummary,
      proxyVaultAvailable,
    },
    maxJsonBytes,
  );
}

function sanitizeVaultSummaryList(value: unknown): AssistantProxyVaultSummaryItem[] {
  if (!Array.isArray(value)) return [];
  const items: AssistantProxyVaultSummaryItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (items.length >= MAX_CATALOG_VAULT_ITEMS) break;
    if (!isPlainObject(raw)) continue;
    const vaultId = sanitizeCatalogText(raw.vaultId, 64);
    if (!vaultId || seen.has(vaultId)) continue;
    const type = typeof raw.type === "string" && VALID_PROXY_TYPES.has(raw.type) ? (raw.type as ProxyType) : "http";
    const assignedCount =
      typeof raw.assignedCount === "number" && Number.isSafeInteger(raw.assignedCount) && raw.assignedCount >= 0
        ? raw.assignedCount
        : 0;
    seen.add(vaultId);
    items.push({
      vaultId,
      label: sanitizeCatalogText(raw.label, 80) || vaultId,
      group: sanitizeCatalogText(raw.group, 64),
      type,
      country: sanitizeCatalogText(raw.country, 32),
      status: sanitizeCatalogText(raw.status, 32) || "working",
      assignedCount,
    });
  }
  return items;
}

function fitCatalogToByteBudget(catalog: AssistantActionCatalog, maxJsonBytes: number): AssistantActionCatalog {
  const result: AssistantActionCatalog = {
    profiles: [...catalog.profiles],
    omittedCount: catalog.omittedCount,
    totalProfiles: catalog.totalProfiles,
    groups: [...catalog.groups],
    tags: [...catalog.tags],
    proxyVaultSummary: [...catalog.proxyVaultSummary],
    proxyVaultAvailable: catalog.proxyVaultAvailable,
  };

  while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxJsonBytes) {
    if (result.profiles.length > 0) {
      const drop = Math.max(1, Math.ceil(result.profiles.length * 0.2));
      result.profiles.splice(result.profiles.length - drop, drop);
      result.omittedCount = Math.max(0, result.totalProfiles - result.profiles.length);
    } else if (result.proxyVaultSummary.length > 0) {
      const drop = Math.max(1, Math.ceil(result.proxyVaultSummary.length * 0.25));
      result.proxyVaultSummary.splice(result.proxyVaultSummary.length - drop, drop);
    } else if (result.tags.length > 0) {
      result.tags.splice(Math.floor(result.tags.length / 2));
    } else if (result.groups.length > 0) {
      result.groups.splice(Math.floor(result.groups.length / 2));
    } else {
      break;
    }
  }
  return result;
}

/**
 * Reconstruct a strictly redacted AssistantActionCatalog from untrusted/provider input
 * so extra private fields can never leak into model prompts.
 */
export function safeActionCatalog(
  value: unknown,
  maxJsonBytes = MAX_CATALOG_JSON_BYTES,
): AssistantActionCatalog {
  if (!isPlainObject(value) || !Array.isArray(value.profiles)) {
    throw new AssistantProposalError("invalid_action_schema", "Invalid assistant action catalog.");
  }
  const profiles: AssistantCatalogProfile[] = [];
  const seenIds = new Set<string>();
  for (const raw of value.profiles) {
    if (profiles.length >= MAX_CATALOG_PROFILES) break;
    if (!isPlainObject(raw) || !isSafeProfileId(raw.id) || seenIds.has(raw.id)) continue;
    seenIds.add(raw.id);
    const fpStatus =
      typeof raw.fpStatus === "string" && VALID_FP_STATUSES.has(raw.fpStatus)
        ? (raw.fpStatus as AssistantCatalogFpStatus)
        : "unmeasured";
    const lastOpenAt =
      typeof raw.lastOpenAt === "number" && Number.isSafeInteger(raw.lastOpenAt) && raw.lastOpenAt >= 0
        ? raw.lastOpenAt
        : 0;
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .map((tag) => sanitizeCatalogText(tag, 40))
          .filter(Boolean)
          .slice(0, 10)
      : [];
    profiles.push({
      id: raw.id,
      name: sanitizeCatalogText(raw.name, 80),
      group: sanitizeCatalogText(raw.group, 64),
      tags,
      engine: raw.engine === "firefox" ? "firefox" : "chromium",
      running: raw.running === true,
      hasProxy: raw.hasProxy === true,
      proxyError: raw.proxyError === true,
      restartPending: raw.restartPending === true,
      mobilePersona: raw.mobilePersona === true,
      fpStatus,
      lastOpenAt,
    });
  }

  const totalProfiles =
    typeof value.totalProfiles === "number" &&
    Number.isSafeInteger(value.totalProfiles) &&
    value.totalProfiles >= profiles.length
      ? value.totalProfiles
      : profiles.length +
        (typeof value.omittedCount === "number" && Number.isSafeInteger(value.omittedCount) && value.omittedCount > 0
          ? value.omittedCount
          : 0);

  const groups = Array.isArray(value.groups)
    ? [...new Set(value.groups.map((item) => sanitizeCatalogText(item, 64)).filter(Boolean))].slice(
        0,
        MAX_CATALOG_GROUPS,
      )
    : [];
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags.map((item) => sanitizeCatalogText(item, 40)).filter(Boolean))].slice(0, MAX_CATALOG_TAGS)
    : [];
  const proxyVaultSummary = sanitizeVaultSummaryList(value.proxyVaultSummary);
  const proxyVaultAvailable = value.proxyVaultAvailable === true && proxyVaultSummary.length > 0;

  return fitCatalogToByteBudget(
    {
      profiles,
      omittedCount: Math.max(0, totalProfiles - profiles.length),
      totalProfiles,
      groups,
      tags,
      proxyVaultSummary,
      proxyVaultAvailable,
    },
    maxJsonBytes,
  );
}

const PROPOSAL_PROMPT_HEADER =
  "\nAction proposal mode is explicitly enabled by the operator. You STILL cannot execute actions or invoke tools directly; never claim an action was performed. " +
  "When appropriate, include a concise explanation plus AT MOST ONE fenced JSON block tagged ```maobu-proposal (<= 16 KiB) with shape " +
  '{"version":1,"title":"...","summary":"...","action":{...}}. ' +
  "Allowed action types ONLY:\n" +
  '1) {"type":"filter_anomalous_profiles","criteria":["proxy_error"|"restart_pending"|"mobile_persona"|"fp_issues"|"fp_unmeasured"|"no_proxy"],"group"?:string,"tags"?:string[]}\n' +
  '2) {"type":"batch_move_group","profileIds":string[],"targetGroup":string,"allowCreateGroup"?:boolean}\n' +
  '3) {"type":"batch_update_tags","profileIds":string[],"mode":"add"|"remove"|"replace","tags":string[]}\n' +
  '4) {"type":"batch_replace_failed_proxies","profileIds":string[],"source":"proxy_vault_healthy","vaultGroup"?:string,"country"?:string,"avoidDuplicateExit"?:boolean,"skipRunning":true}\n' +
  '5) {"type":"batch_launch_profiles","profileIds":string[],"concurrency"?:1..4}\n' +
  '6) {"type":"batch_stop_profiles","profileIds":string[],"concurrency"?:1..4}\n' +
  '7) {"type":"generate_fingerprint_summary","profileIds":string[]}\n' +
  "NEVER output delete, trash, export, credentials, cookies, scripts, shell commands, settings edits, or raw proxy host:port:user:pass strings. " +
  "Use only profile IDs from this redacted workspace catalog (max 200 targets):\n";

export function buildProposalModeSystemPrompt(
  catalog: AssistantActionCatalog,
  maxBytes = 12 * 1024,
): string {
  const headerBytes = Buffer.byteLength(PROPOSAL_PROMPT_HEADER, "utf8");
  const budget = Math.max(512, maxBytes - headerBytes);
  const fitted = fitCatalogToByteBudget(catalog, budget);
  return PROPOSAL_PROMPT_HEADER + JSON.stringify(fitted);
}

export function extractProposalBlock(
  content: string,
):
  | { found: false }
  | { found: true; rawJson: string }
  | { found: "error"; code: ProposalErrorCode; message: string } {
  if (typeof content !== "string" || !content.includes("maobu-proposal")) {
    return { found: false };
  }
  const openRegex = /(?:^|\r?\n)[ \t]*```[ \t]*maobu-proposal[ \t]*(?:\r?\n|$)/g;
  const opens: Array<{ start: number; bodyStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = openRegex.exec(content)) !== null) {
    opens.push({ start: match.index, bodyStart: match.index + match[0].length });
  }
  if (opens.length === 0) return { found: false };
  if (opens.length > 1) {
    return {
      found: "error",
      code: "multiple_proposal_blocks",
      message: "Only one maobu-proposal JSON block is allowed per assistant response.",
    };
  }
  const bodyStart = opens[0]!.bodyStart;
  const remainder = content.slice(bodyStart);
  const closeMatch = /(?:^|\r?\n)[ \t]*```[ \t]*(?:\r?\n|$)/.exec(remainder);
  if (!closeMatch) {
    return {
      found: "error",
      code: "invalid_proposal_json",
      message: "The maobu-proposal block is incomplete or missing a closing fence.",
    };
  }
  const rawJson = remainder.slice(0, closeMatch.index).trim();
  if (!rawJson) {
    return {
      found: "error",
      code: "invalid_proposal_json",
      message: "The maobu-proposal block is empty.",
    };
  }
  if (Buffer.byteLength(rawJson, "utf8") > MAX_PROPOSAL_BLOCK_BYTES) {
    return {
      found: "error",
      code: "proposal_too_large",
      message: "The maobu-proposal block exceeds the 16 KiB limit.",
    };
  }
  return { found: true, rawJson };
}

export function stripProposalBlock(content: string): string {
  const stripped = content.replace(
    /(?:^|\r?\n)[ \t]*```[ \t]*maobu-proposal[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/g,
    "\n",
  );
  return stripped.trim();
}

export function validateProposalAction(value: unknown): AssistantProposalAction {
  if (!isPlainObject(value) || hasPoisonKeys(value)) {
    throw new AssistantProposalError("invalid_action_schema", "Action payload must be a plain JSON object.");
  }
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new AssistantProposalError("invalid_action_schema", "Action type must be a non-empty string.");
  }
  const actionType = value.type.trim();
  const normalizedType = actionType.toLowerCase();
  if (FORBIDDEN_ACTION_SET.has(normalizedType) || FORBIDDEN_ACTION_SUBSTRING.test(normalizedType)) {
    throw new AssistantProposalError(
      "forbidden_action",
      `Action type "${actionType}" is permanently forbidden by local security policy.`,
    );
  }

  switch (actionType) {
    case "filter_anomalous_profiles": {
      checkAllowedKeys(value, ["type", "criteria", "group", "tags"], "filter_anomalous_profiles");
      if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > ANOMALY_CRITERIA.length) {
        throw new AssistantProposalError("invalid_action_schema", "criteria must contain 1 to 6 anomaly filters.");
      }
      const criteria: AnomalyCriterion[] = [];
      const seen = new Set<string>();
      for (const raw of value.criteria) {
        if (typeof raw !== "string" || !VALID_CRITERIA.has(raw)) {
          throw new AssistantProposalError("invalid_action_schema", "Unsupported anomaly filter criterion.");
        }
        if (!seen.has(raw)) {
          seen.add(raw);
          criteria.push(raw as AnomalyCriterion);
        }
      }
      const group =
        value.group !== undefined ? validateSafeText(value.group, "group", 200, false) : undefined;
      let tags: string[] | undefined;
      if (value.tags !== undefined) {
        if (!Array.isArray(value.tags)) {
          throw new AssistantProposalError("invalid_action_schema", "tags must be an array of strings.");
        }
        try {
          tags = normalizeProfileTags(value.tags);
        } catch (error) {
          throw new AssistantProposalError(
            "invalid_action_schema",
            error instanceof ProfileTagsValidationError ? error.message : "Invalid tags filter.",
          );
        }
      }
      return {
        type: "filter_anomalous_profiles",
        criteria,
        ...(group !== undefined ? { group } : {}),
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      };
    }

    case "batch_move_group": {
      checkAllowedKeys(value, ["type", "profileIds", "targetGroup", "allowCreateGroup"], "batch_move_group");
      const profileIds = validateProfileIds(value.profileIds);
      const targetGroup = validateSafeText(value.targetGroup, "targetGroup", 200, true);
      if (value.allowCreateGroup !== undefined && typeof value.allowCreateGroup !== "boolean") {
        throw new AssistantProposalError("invalid_action_schema", "allowCreateGroup must be a boolean.");
      }
      return {
        type: "batch_move_group",
        profileIds,
        targetGroup,
        ...(value.allowCreateGroup !== undefined ? { allowCreateGroup: value.allowCreateGroup } : {}),
      };
    }

    case "batch_update_tags": {
      checkAllowedKeys(value, ["type", "profileIds", "mode", "tags"], "batch_update_tags");
      const profileIds = validateProfileIds(value.profileIds);
      if (value.mode !== "add" && value.mode !== "remove" && value.mode !== "replace") {
        throw new AssistantProposalError("invalid_action_schema", "mode must be add, remove, or replace.");
      }
      if (!Array.isArray(value.tags)) {
        throw new AssistantProposalError("invalid_action_schema", "tags must be an array of strings.");
      }
      let tags: string[];
      try {
        tags = normalizeProfileTags(value.tags);
      } catch (error) {
        throw new AssistantProposalError(
          "invalid_action_schema",
          error instanceof ProfileTagsValidationError ? error.message : "Invalid profile tags.",
        );
      }
      if ((value.mode === "add" || value.mode === "remove") && tags.length === 0) {
        throw new AssistantProposalError("invalid_action_schema", `tags must not be empty for mode "${value.mode}".`);
      }
      return {
        type: "batch_update_tags",
        profileIds,
        mode: value.mode,
        tags,
      };
    }

    case "batch_replace_failed_proxies": {
      checkAllowedKeys(
        value,
        ["type", "profileIds", "source", "vaultGroup", "country", "avoidDuplicateExit", "skipRunning"],
        "batch_replace_failed_proxies",
      );
      const profileIds = validateProfileIds(value.profileIds);
      if (value.source !== "proxy_vault_healthy") {
        throw new AssistantProposalError(
          "forbidden_action",
          'batch_replace_failed_proxies must use source: "proxy_vault_healthy"; raw proxy specifications are forbidden.',
        );
      }
      if (value.skipRunning !== true) {
        throw new AssistantProposalError(
          "invalid_action_schema",
          "batch_replace_failed_proxies requires skipRunning: true.",
        );
      }
      let vaultGroup: string | undefined;
      if (value.vaultGroup !== undefined) {
        vaultGroup = validateSafeText(value.vaultGroup, "vaultGroup", 200, false);
        if (RAW_PROXY_PATTERN.test(vaultGroup)) {
          throw new AssistantProposalError("forbidden_action", "Raw proxy coordinates are forbidden in vaultGroup.");
        }
      }
      let country: string | undefined;
      if (value.country !== undefined) {
        country = validateSafeText(value.country, "country", 64, false);
        if (RAW_PROXY_PATTERN.test(country)) {
          throw new AssistantProposalError("forbidden_action", "Raw proxy coordinates are forbidden in country.");
        }
      }
      if (value.avoidDuplicateExit !== undefined && typeof value.avoidDuplicateExit !== "boolean") {
        throw new AssistantProposalError("invalid_action_schema", "avoidDuplicateExit must be a boolean.");
      }
      return {
        type: "batch_replace_failed_proxies",
        profileIds,
        source: "proxy_vault_healthy",
        ...(vaultGroup !== undefined ? { vaultGroup } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(value.avoidDuplicateExit !== undefined ? { avoidDuplicateExit: value.avoidDuplicateExit } : {}),
        skipRunning: true,
      };
    }

    case "batch_launch_profiles": {
      checkAllowedKeys(value, ["type", "profileIds", "concurrency"], "batch_launch_profiles");
      const profileIds = validateProfileIds(value.profileIds);
      const concurrency = validateConcurrency(value.concurrency);
      return {
        type: "batch_launch_profiles",
        profileIds,
        ...(concurrency !== undefined ? { concurrency } : {}),
      };
    }

    case "batch_stop_profiles": {
      checkAllowedKeys(value, ["type", "profileIds", "concurrency"], "batch_stop_profiles");
      const profileIds = validateProfileIds(value.profileIds);
      const concurrency = validateConcurrency(value.concurrency);
      return {
        type: "batch_stop_profiles",
        profileIds,
        ...(concurrency !== undefined ? { concurrency } : {}),
      };
    }

    case "generate_fingerprint_summary": {
      checkAllowedKeys(value, ["type", "profileIds"], "generate_fingerprint_summary");
      const profileIds = validateProfileIds(value.profileIds);
      return {
        type: "generate_fingerprint_summary",
        profileIds,
      };
    }

    default:
      throw new AssistantProposalError("unsupported_action", `Unsupported proposal action type "${actionType}".`);
  }
}

function validateConcurrency(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new AssistantProposalError("invalid_action_schema", "concurrency must be an integer between 1 and 4.");
  }
  return value;
}

export function parseAssistantProposal(content: string): ProposalParseResult {
  const extracted = extractProposalBlock(content);
  if (extracted.found === false) return { status: "none" };
  if (extracted.found === "error") {
    return { status: "error", code: extracted.code, error: extracted.message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.rawJson);
  } catch {
    return { status: "error", code: "invalid_proposal_json", error: "The maobu-proposal JSON could not be parsed." };
  }
  if (!isPlainObject(parsed) || hasPoisonKeys(parsed)) {
    return {
      status: "error",
      code: "invalid_proposal_json",
      error: "The maobu-proposal block must contain a JSON object.",
    };
  }

  try {
    checkAllowedKeys(parsed, ["version", "title", "summary", "action"], "proposal envelope");
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new AssistantProposalError("invalid_action_schema", "Proposal version must be 1.");
    }
    const action = validateProposalAction(parsed.action);
    const title =
      parsed.title !== undefined && typeof parsed.title === "string" && parsed.title.trim()
        ? validateSafeText(parsed.title, "title", 160, false)
        : defaultProposalTitle(action);
    const summary =
      parsed.summary !== undefined && typeof parsed.summary === "string" && parsed.summary.trim()
        ? validateSafeText(parsed.summary, "summary", 500, false)
        : title;
    return {
      status: "ok",
      proposal: { version: 1, title, summary, action },
    };
  } catch (error) {
    if (error instanceof AssistantProposalError) {
      return { status: "error", code: error.code, error: error.message };
    }
    return { status: "error", code: "invalid_action_schema", error: "Proposal validation failed." };
  }
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function computeItemStateDigest(
  actionType: AssistantProposalAction["type"],
  store: ProfileStore,
  profileId: string,
): string {
  const incarnation = store.getProfileIncarnation(profileId);
  const profile = store.getProfile(profileId);
  const launch = store.getLaunch(profileId);
  switch (actionType) {
    case "filter_anomalous_profiles":
    case "generate_fingerprint_summary":
      return sha256Hex([incarnation]);
    case "batch_move_group":
      return sha256Hex([incarnation, profile?.group ?? null]);
    case "batch_update_tags":
      return sha256Hex([incarnation, profile?.tags ?? null]);
    case "batch_replace_failed_proxies":
      return sha256Hex([
        incarnation,
        Boolean(launch),
        profile?.proxyError ?? "",
        profile?.proxy ? sha256Hex(profile.proxy) : null,
      ]);
    case "batch_launch_profiles":
    case "batch_stop_profiles":
      return sha256Hex([
        incarnation,
        Boolean(launch),
        launch?.startedAt ?? null,
        profile?.proxyError ?? "",
        profile ? isMobileUserAgent(profile.ua) : null,
      ]);
  }
}

function computeNextTags(current: readonly string[], mode: "add" | "remove" | "replace", tags: readonly string[]): string[] {
  if (mode === "replace") return normalizeProfileTags([...tags]);
  if (mode === "add") return normalizeProfileTags([...current, ...tags]);
  const removeKeys = new Set(tags.map((tag) => tag.trim().normalize("NFC").toLowerCase()));
  return current.filter((tag) => !removeKeys.has(tag.trim().normalize("NFC").toLowerCase()));
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function evaluateProfileAnomalies(
  profile: Profile,
  store: ProfileStore,
  launch: ReturnType<ProfileStore["getLaunch"]>,
): Set<AnomalyCriterion> {
  const matched = new Set<AnomalyCriterion>();
  if (profile.proxyError) matched.add("proxy_error");
  if (!profile.proxy && !profile.proxyError) matched.add("no_proxy");
  if (launch && launchIdentityChanged(profile, launch)) matched.add("restart_pending");
  if (isMobileUserAgent(profile.ua)) matched.add("mobile_persona");
  const review = buildStoredFingerprintReport(profile, {
    captureSource: store.getFingerprintSource(profile.id),
    launch,
  });
  if (review.report.status === "issues") matched.add("fp_issues");
  if (review.report.status === "unmeasured") matched.add("fp_unmeasured");
  return matched;
}

function sanitizeExecutionError(error: unknown): string {
  if (error instanceof BrowserLaunchError && error.guidance) return error.guidance;
  if (error instanceof AssistantProposalError || error instanceof ProfileTagsValidationError) return error.message;
  if (error instanceof ProxyVaultError) return error.message;
  return "Operation failed for this profile.";
}

async function runBoundedPool<T>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<void>,
  onAbortedQueued: (item: T, index: number) => void,
): Promise<void> {
  const limit = Math.max(1, Math.min(4, concurrency));
  let cursor = 0;

  const runner = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      if (signal.aborted) {
        onAbortedQueued(items[idx]!, idx);
        continue;
      }
      await worker(items[idx]!, idx);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
}

export class AssistantProposalRegistry {
  private readonly secretKey = randomBytes(32);
  private readonly entries = new Map<string, InternalProposalRecord>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private activeWorkspaceId: string | null = null;

  constructor(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_STORED_PROPOSALS);
    this.ttlMs = Math.max(1_000, options.ttlMs ?? PROPOSAL_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  size(): number {
    return this.entries.size;
  }

  /** Clear all stored proposals (or all belonging to another workspace on switch). */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.abortController?.abort();
    }
    this.entries.clear();
    this.activeWorkspaceId = null;
  }

  clearWorkspace(workspaceId?: string): void {
    for (const [id, entry] of this.entries) {
      if (!workspaceId || entry.view.workspaceId === workspaceId) {
        entry.abortController?.abort();
        this.entries.delete(id);
      }
    }
    if (!workspaceId || this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = null;
    }
  }

  private syncWorkspace(workspaceId: string): void {
    if (this.activeWorkspaceId !== null && this.activeWorkspaceId !== workspaceId) {
      this.clearWorkspace(this.activeWorkspaceId);
    }
    this.activeWorkspaceId = workspaceId;
  }

  private pruneExpired(): void {
    const current = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.execution.status !== "running" && current > entry.view.expiresAt) {
        this.entries.delete(id);
      }
    }
  }

  private evictIfFull(): void {
    while (this.entries.size >= this.maxEntries) {
      let evicted = false;
      for (const [id, entry] of this.entries) {
        if (entry.execution.status !== "running") {
          this.entries.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        throw new AssistantProposalError(
          "registry_busy",
          "Too many active proposal executions are in progress.",
          409,
        );
      }
    }
  }

  private signPlanHash(
    view: Omit<CompiledProposalView, "planHash">,
    incarnations: Record<string, string | null>,
    stateDigests: Record<string, string>,
  ): string {
    return createHmac("sha256", this.secretKey)
      .update(
        JSON.stringify({
          v: 1,
          workspaceId: view.workspaceId,
          proposalId: view.proposalId,
          actionType: view.actionType,
          resolvedItems: view.items.map((item) => ({
            profileId: item.profileId,
            executable: item.executable,
            beforeSummary: item.beforeSummary,
            afterSummary: item.afterSummary,
            targetVaultId: item.targetVaultId ?? null,
          })),
          incarnations,
          stateDigests,
        }),
      )
      .digest("hex");
  }

  private verifyPlanHash(entry: InternalProposalRecord, candidate: string): boolean {
    if (typeof candidate !== "string" || !PLAN_HASH_PATTERN.test(candidate)) return false;
    const expected = this.signPlanHash(entry.view, entry.incarnations, entry.stateDigests);
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
  }

  /**
   * Deterministically dry-run compile a validated proposal against current workspace state,
   * capture profile incarnations & state digests, sign HMAC planHash, and store boundedly.
   */
  compileAndStore(
    parsed: ParsedAssistantProposal,
    store: ProfileStore,
    options: { workspaceId: string; proxyVault?: AssistantProxyVaultLookup },
  ): CompiledProposalView {
    this.syncWorkspace(options.workspaceId);
    this.pruneExpired();
    this.evictIfFull();

    const proposalId = `prop_${randomBytes(8).toString("hex")}`;
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const action = parsed.action;
    const risk = actionRiskLevel(action.type);
    const warnings: ProposalWarning[] = [];
    const items: CompiledProposalItemView[] = [];
    const incarnations: Record<string, string | null> = {};
    const stateDigests: Record<string, string> = {};

    const recordBinding = (profileId: string) => {
      incarnations[profileId] = store.getProfileIncarnation(profileId);
      stateDigests[profileId] = computeItemStateDigest(action.type, store, profileId);
    };

    switch (action.type) {
      case "filter_anomalous_profiles": {
        const launches = new Map(store.listLaunches().map((launch) => [launch.profileId, launch]));
        const tagFilters = (action.tags ?? []).map((tag) => tag.toLowerCase());
        let matchedTotal = 0;

        for (const profile of store.listProfiles()) {
          if (action.group !== undefined && profile.group !== action.group) continue;
          if (tagFilters.length > 0) {
            const profileTags = new Set((profile.tags ?? []).map((tag) => tag.toLowerCase()));
            if (!tagFilters.every((tag) => profileTags.has(tag))) continue;
          }
          const launch = launches.get(profile.id) ?? null;
          const anomalies = evaluateProfileAnomalies(profile, store, launch);
          const matchedCriteria = action.criteria.filter((criterion) => anomalies.has(criterion));
          if (matchedCriteria.length === 0) continue;

          matchedTotal++;
          if (items.length >= MAX_PROPOSAL_TARGETS) continue;
          recordBinding(profile.id);
          items.push({
            profileId: profile.id,
            profileName: profile.name,
            group: profile.group,
            running: Boolean(launch),
            executable: true,
            defaultSelected: true,
            beforeSummary: matchedCriteria.join(", "),
            afterSummary: "Locate in profile roster",
          });
        }

        if (matchedTotal > MAX_PROPOSAL_TARGETS) {
          warnings.push({
            code: "targets_truncated",
            message: `Matched ${matchedTotal} profiles; showing the first ${MAX_PROPOSAL_TARGETS}.`,
          });
        }
        if (items.length === 0) {
          warnings.push({
            code: "no_matching_profiles",
            message: "No profiles currently match the requested anomaly criteria.",
          });
        }
        break;
      }

      case "batch_move_group": {
        const existingGroups = new Set(store.listGroups());
        const needsNewGroup = action.targetGroup !== "" && !existingGroups.has(action.targetGroup);
        const creationBlocked = needsNewGroup && action.allowCreateGroup !== true;
        if (creationBlocked) {
          warnings.push({
            code: "group_not_found",
            message: `Target group "${action.targetGroup}" does not exist and allowCreateGroup is false.`,
          });
        } else if (needsNewGroup) {
          warnings.push({
            code: "group_will_be_created",
            message: `Target group "${action.targetGroup}" will be created during execution.`,
          });
        }

        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: action.targetGroup || "(Ungrouped)",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          if (creationBlocked) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: profile.group || "(Ungrouped)",
              afterSummary: action.targetGroup,
              skipReason: "group_not_found",
              skipDetail: "Target group does not exist.",
            });
            continue;
          }
          if (profile.group === action.targetGroup) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: profile.group || "(Ungrouped)",
              afterSummary: action.targetGroup || "(Ungrouped)",
              skipReason: "no_change",
              skipDetail: "Profile is already in the target group.",
            });
            continue;
          }
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running,
            executable: true,
            defaultSelected: true,
            beforeSummary: profile.group || "(Ungrouped)",
            afterSummary: action.targetGroup || "(Ungrouped)",
          });
        }
        break;
      }

      case "batch_update_tags": {
        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: action.tags.join(", ") || "(None)",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          const currentTags = profile.tags ?? [];
          let nextTags: string[];
          try {
            nextTags = computeNextTags(currentTags, action.mode, action.tags);
          } catch (error) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: currentTags.join(", ") || "(None)",
              afterSummary: currentTags.join(", ") || "(None)",
              skipReason: "tag_limit_exceeded",
              skipDetail: error instanceof ProfileTagsValidationError ? error.message : "Tag limit exceeded.",
            });
            continue;
          }
          if (sameStringList(currentTags, nextTags)) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: currentTags.join(", ") || "(None)",
              afterSummary: nextTags.join(", ") || "(None)",
              skipReason: "no_change",
              skipDetail: "Tags would remain unchanged.",
            });
            continue;
          }
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running,
            executable: true,
            defaultSelected: true,
            beforeSummary: currentTags.join(", ") || "(None)",
            afterSummary: nextTags.join(", ") || "(None)",
          });
        }
        break;
      }

      case "batch_replace_failed_proxies": {
        const lookup = options.proxyVault;
        const allHealthy = lookup ? sanitizeVaultSummaryList(lookup.listHealthySummary()) : [];
        const filteredHealthy = allHealthy.filter((entry) => {
          if (action.vaultGroup !== undefined && entry.group !== action.vaultGroup) return false;
          if (action.country !== undefined && entry.country.toLowerCase() !== action.country.toLowerCase()) return false;
          return true;
        });

        const vaultUnavailable = !lookup || filteredHealthy.length === 0;
        if (vaultUnavailable) {
          warnings.push({
            code: "vault_unavailable",
            message: !lookup
              ? "Proxy Vault lookup is not configured for this workspace."
              : allHealthy.length === 0
                ? "Proxy Vault has no verified healthy proxies available."
                : "No healthy Proxy Vault entries match the requested group/country filters.",
          });
        }

        // Pre-resolve candidate metadata locally (never exposed as raw host/port/user/pass).
        const candidates = filteredHealthy
          .map((summary) => {
            const resolved = lookup?.resolveProxySpec(summary.vaultId) ?? null;
            return resolved
              ? {
                  summary,
                  resolved,
                  simulatedAssigned: summary.assignedCount,
                }
              : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => a.simulatedAssigned - b.simulatedAssigned || a.summary.vaultId.localeCompare(b.summary.vaultId));

        if (!vaultUnavailable && candidates.length === 0) {
          warnings.push({
            code: "vault_unavailable",
            message: "Healthy Proxy Vault entries could not be resolved locally.",
          });
        }

        const usedExitIps = new Set<string>();
        const usedVaultIds = new Set<string>();
        let insufficientCount = 0;

        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: "Skipped",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          const beforeSummary = profile.proxyError
            ? "Proxy error"
            : profile.proxy
              ? "Configured proxy"
              : "No proxy";
          if (running) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: true,
              executable: false,
              defaultSelected: false,
              beforeSummary,
              afterSummary: "Skipped (running)",
              skipReason: "profile_running",
              skipDetail: "Close the running browser before replacing its proxy.",
            });
            continue;
          }
          if (candidates.length === 0) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: false,
              executable: false,
              defaultSelected: false,
              beforeSummary,
              afterSummary: "Unavailable",
              skipReason: "vault_unavailable",
              skipDetail: "No healthy proxy is available in Proxy Vault.",
            });
            continue;
          }

          candidates.sort(
            (a, b) => a.simulatedAssigned - b.simulatedAssigned || a.summary.vaultId.localeCompare(b.summary.vaultId),
          );
          let chosen = candidates[0]!;
          if (action.avoidDuplicateExit) {
            const distinct = candidates.find(
              (candidate) =>
                !usedVaultIds.has(candidate.summary.vaultId) &&
                (!candidate.resolved.exitIp || !usedExitIps.has(candidate.resolved.exitIp)),
            );
            if (!distinct) {
              insufficientCount++;
              items.push({
                profileId,
                profileName: profile.name,
                group: profile.group,
                running: false,
                executable: false,
                defaultSelected: false,
                beforeSummary,
                afterSummary: "Skipped (no distinct exit)",
                skipReason: "no_distinct_exit_proxy",
                skipDetail: "Not enough distinct healthy Proxy Vault exits to satisfy avoidDuplicateExit.",
              });
              continue;
            }
            chosen = distinct;
          }

          chosen.simulatedAssigned++;
          usedVaultIds.add(chosen.summary.vaultId);
          if (chosen.resolved.exitIp) usedExitIps.add(chosen.resolved.exitIp);

          const countrySuffix = chosen.summary.country ? ` (${chosen.summary.country})` : "";
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running: false,
            executable: true,
            defaultSelected: true,
            beforeSummary,
            afterSummary: `Vault: ${chosen.summary.label}${countrySuffix}`,
            targetVaultId: chosen.summary.vaultId,
            targetVaultLabel: chosen.summary.label,
          });
        }

        if (insufficientCount > 0) {
          warnings.push({
            code: "insufficient_healthy_proxies",
            message: `${insufficientCount} profile(s) were skipped because not enough distinct healthy vault exits were available.`,
          });
        }
        break;
      }

      case "batch_launch_profiles": {
        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: "Skipped",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          if (running) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: true,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Running",
              afterSummary: "Already running",
              skipReason: "already_running",
              skipDetail: "Profile browser is already open.",
            });
            continue;
          }
          if (isMobileUserAgent(profile.ua)) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: false,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Mobile persona",
              afterSummary: "Skipped",
              skipReason: "mobile_persona",
              skipDetail: "Convert this mobile persona to desktop before launching.",
            });
            continue;
          }
          if (profile.proxyError) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: false,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Proxy error",
              afterSummary: "Skipped",
              skipReason: "proxy_error",
              skipDetail: "Fix or replace the quarantined proxy before launching.",
            });
            continue;
          }
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running: false,
            executable: true,
            defaultSelected: true,
            beforeSummary: "Stopped",
            afterSummary: "Launch browser",
          });
        }
        break;
      }

      case "batch_stop_profiles": {
        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: "Skipped",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          if (!running) {
            items.push({
              profileId,
              profileName: profile.name,
              group: profile.group,
              running: false,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Stopped",
              afterSummary: "Already stopped",
              skipReason: "not_running",
              skipDetail: "Profile browser is not currently running.",
            });
            continue;
          }
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running: true,
            executable: true,
            defaultSelected: true,
            beforeSummary: "Running",
            afterSummary: "Save session & stop",
          });
        }
        break;
      }

      case "generate_fingerprint_summary": {
        for (const profileId of action.profileIds) {
          recordBinding(profileId);
          const profile = store.getProfile(profileId);
          const running = Boolean(store.getLaunch(profileId));
          if (!profile) {
            items.push({
              profileId,
              profileName: profileId,
              group: "",
              running,
              executable: false,
              defaultSelected: false,
              beforeSummary: "Missing",
              afterSummary: "Skipped",
              skipReason: "profile_not_found",
              skipDetail: "Profile does not exist or is in Trash.",
            });
            continue;
          }
          items.push({
            profileId,
            profileName: profile.name,
            group: profile.group,
            running,
            executable: true,
            defaultSelected: true,
            beforeSummary: running ? "Running" : "Stopped",
            afterSummary: "Aggregate stored fingerprint checks",
          });
        }
        break;
      }
    }

    const actionable = items.filter((item) => item.executable).length;
    const baseView: Omit<CompiledProposalView, "planHash"> = {
      proposalId,
      workspaceId: options.workspaceId,
      createdAt,
      expiresAt,
      title: parsed.title,
      summary: parsed.summary,
      actionType: action.type,
      action,
      risk,
      requiresSecondaryConfirm: risk === "high",
      mutatesWorkspace: risk !== "read-only",
      warnings,
      counts: {
        total: items.length,
        actionable,
        skipped: items.length - actionable,
      },
      items,
    };
    const planHash = this.signPlanHash(baseView, incarnations, stateDigests);
    const view: CompiledProposalView = { ...baseView, planHash };

    const initialExecution: ProposalExecutionSnapshot = {
      proposalId,
      planHash,
      status: "compiled",
      startedAt: null,
      finishedAt: null,
      selectedProfileIds: [],
      total: 0,
      completed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      aborted: 0,
      items: [],
    };

    this.entries.set(proposalId, {
      view,
      incarnations,
      stateDigests,
      appliedProfileIds: new Set<string>(),
      execution: initialExecution,
      abortController: null,
    });
    return structuredClone(view);
  }

  getSnapshot(
    proposalId: string,
    workspaceId: string,
  ): { proposal: CompiledProposalView; execution: ProposalExecutionSnapshot; expired: boolean } | null {
    if (!isValidProposalId(proposalId)) return null;
    const entry = this.entries.get(proposalId);
    if (!entry || entry.view.workspaceId !== workspaceId) return null;
    const expired = entry.execution.status !== "running" && this.now() > entry.view.expiresAt;
    return {
      proposal: structuredClone(entry.view),
      execution: structuredClone(entry.execution),
      expired,
    };
  }

  abort(
    proposalId: string,
    workspaceId: string,
  ): { found: false } | { found: true; aborted: boolean; snapshot: ProposalExecutionSnapshot } {
    if (!isValidProposalId(proposalId)) return { found: false };
    const entry = this.entries.get(proposalId);
    if (!entry || entry.view.workspaceId !== workspaceId) return { found: false };
    if (entry.execution.status === "running" && entry.abortController && !entry.abortController.signal.aborted) {
      entry.abortController.abort();
      return { found: true, aborted: true, snapshot: structuredClone(entry.execution) };
    }
    return { found: true, aborted: false, snapshot: structuredClone(entry.execution) };
  }

  /**
   * Validate execute request synchronously BEFORE opening an NDJSON stream so HTTP 4xx/409/410
   * errors return proper JSON status codes immediately.
   */
  prepareExecution(
    proposalId: string,
    workspaceId: string,
    input: ProposalExecuteInput,
  ): {
    proposal: CompiledProposalView;
    selectedItems: CompiledProposalItemView[];
    start: (
      deps: ProposalExecutionDeps,
      send: (event: ProposalStreamEvent) => void,
    ) => Promise<ProposalExecutionSnapshot>;
  } {
    if (!isValidProposalId(proposalId)) {
      throw new AssistantProposalError("invalid_proposal_id", "Invalid proposal ID.", 400);
    }
    const entry = this.entries.get(proposalId);
    if (!entry || entry.view.workspaceId !== workspaceId) {
      throw new AssistantProposalError("proposal_not_found", "Action proposal not found or cleared.", 404);
    }
    if (entry.execution.status === "running") {
      throw new AssistantProposalError("proposal_already_running", "This proposal is already executing.", 409);
    }
    if (this.now() > entry.view.expiresAt) {
      this.entries.delete(proposalId);
      throw new AssistantProposalError(
        "proposal_expired",
        "This action proposal has expired. Ask the assistant to generate a fresh proposal.",
        410,
      );
    }
    if (!this.verifyPlanHash(entry, input.planHash)) {
      throw new AssistantProposalError(
        "plan_hash_mismatch",
        "Proposal plan verification failed. Preview a fresh proposal before executing.",
        409,
      );
    }
    if (entry.view.requiresSecondaryConfirm && input.confirmHighRisk !== true) {
      throw new AssistantProposalError(
        "high_risk_confirmation_required",
        "High-risk proxy replacement requires explicit secondary confirmation.",
        400,
      );
    }

    const itemById = new Map(entry.view.items.map((item) => [item.profileId, item]));
    let selectedItems: CompiledProposalItemView[];
    if (input.selectedProfileIds !== undefined) {
      if (!Array.isArray(input.selectedProfileIds) || input.selectedProfileIds.length > MAX_PROPOSAL_TARGETS) {
        throw new AssistantProposalError("invalid_selection", "selectedProfileIds is invalid or exceeds limit.", 400);
      }
      const uniqueIds: string[] = [];
      const seen = new Set<string>();
      for (const raw of input.selectedProfileIds) {
        if (!isSafeProfileId(raw) || !itemById.has(raw)) {
          throw new AssistantProposalError(
            "invalid_selection",
            "selectedProfileIds must only include profile IDs from the compiled proposal.",
            400,
          );
        }
        if (!seen.has(raw)) {
          seen.add(raw);
          uniqueIds.push(raw);
        }
      }
      selectedItems = uniqueIds.map((id) => itemById.get(id)!).filter((item) => item.executable);
    } else {
      selectedItems = entry.view.items.filter((item) => item.executable);
    }

    if (selectedItems.length === 0) {
      throw new AssistantProposalError("nothing_to_execute", "No executable target profiles are selected.", 400);
    }

    // Reserve running state immediately before stream start to prevent race conditions.
    const abortController = new AbortController();
    const startedAt = this.now();
    const initialReceipts: ProposalExecutionItemReceipt[] = selectedItems.map((item) => ({
      profileId: item.profileId,
      profileName: item.profileName,
      status: "pending",
      beforeSummary: item.beforeSummary,
      afterSummary: item.afterSummary,
    }));
    entry.abortController = abortController;
    entry.execution = {
      proposalId: entry.view.proposalId,
      planHash: entry.view.planHash,
      status: "running",
      startedAt,
      finishedAt: null,
      selectedProfileIds: selectedItems.map((item) => item.profileId),
      total: selectedItems.length,
      completed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      aborted: 0,
      items: initialReceipts,
    };

    return {
      proposal: structuredClone(entry.view),
      selectedItems: structuredClone(selectedItems),
      start: (deps, send) => this.runPreparedExecution(entry, selectedItems, abortController, deps, send),
    };
  }

  private async runPreparedExecution(
    entry: InternalProposalRecord,
    selectedItems: CompiledProposalItemView[],
    abortController: AbortController,
    deps: ProposalExecutionDeps,
    send: (event: ProposalStreamEvent) => void,
  ): Promise<ProposalExecutionSnapshot> {
    const { store, launcher, proxyVault, emitEvent } = deps;
    const action = entry.view.action;
    const signal = abortController.signal;
    const exec = entry.execution;

    const emitTask = (state: string, extra: Record<string, unknown> = {}) => {
      try {
        emitEvent?.("task.updated", {
          kind: "assistant_proposal",
          proposalId: entry.view.proposalId,
          actionType: action.type,
          state,
          completed: exec.completed,
          total: exec.total,
          succeeded: exec.succeeded,
          skipped: exec.skipped,
          failed: exec.failed,
          aborted: exec.aborted,
          ...extra,
        });
      } catch {
        // Event broadcast failure must never break execution.
      }
    };

    const recordItem = (index: number, receipt: ProposalExecutionItemReceipt) => {
      exec.items[index] = receipt;
      exec.completed++;
      if (receipt.status === "succeeded") exec.succeeded++;
      else if (receipt.status === "skipped") exec.skipped++;
      else if (receipt.status === "failed") exec.failed++;
      else if (receipt.status === "aborted") exec.aborted++;
      send({
        type: "item",
        proposalId: entry.view.proposalId,
        index,
        total: exec.total,
        completed: exec.completed,
        item: structuredClone(receipt),
      });
    };

    const checkVersionConflict = (profileId: string): boolean => {
      const expectedIncarnation = entry.incarnations[profileId] ?? null;
      const expectedDigest = entry.stateDigests[profileId];
      const currentIncarnation = store.getProfileIncarnation(profileId);
      if (currentIncarnation !== expectedIncarnation) return true;
      const currentDigest = computeItemStateDigest(action.type, store, profileId);
      return currentDigest !== expectedDigest;
    };

    const fpCounts = { total: 0, consistent: 0, review: 0, issues: 0, unmeasured: 0 };
    const fpCheckTallies = new Map<string, { id: string; label: string; failCount: number; warnCount: number }>();
    const matchedFilterIds: string[] = [];

    send({
      type: "start",
      proposalId: entry.view.proposalId,
      actionType: action.type,
      risk: entry.view.risk,
      total: exec.total,
      selectedProfileIds: [...exec.selectedProfileIds],
      startedAt: exec.startedAt!,
    });
    emitTask("running");

    try {
      const concurrency =
        action.type === "batch_launch_profiles" || action.type === "batch_stop_profiles"
          ? action.concurrency ?? 2
          : 1;

      await runBoundedPool(
        selectedItems,
        concurrency,
        signal,
        async (item, index) => {
          const base = {
            profileId: item.profileId,
            profileName: item.profileName,
            beforeSummary: item.beforeSummary,
            afterSummary: item.afterSummary,
          };

          if (entry.view.mutatesWorkspace && entry.appliedProfileIds.has(item.profileId)) {
            recordItem(index, {
              ...base,
              status: "skipped",
              reason: "already_applied",
              detail: "Already applied by an earlier run of this proposal.",
              finishedAt: this.now(),
            });
            return;
          }

          if (checkVersionConflict(item.profileId)) {
            recordItem(index, {
              ...base,
              status: "skipped",
              reason: "version_conflict",
              detail: "Profile state changed since preview; skipped to prevent stale changes.",
              finishedAt: this.now(),
            });
            return;
          }

          exec.items[index] = { ...base, status: "running" };

          try {
            switch (action.type) {
              case "filter_anomalous_profiles": {
                const profile = store.getProfile(item.profileId);
                if (!profile) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "profile_not_found",
                    detail: "Profile no longer exists.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                matchedFilterIds.push(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: item.beforeSummary,
                  finishedAt: this.now(),
                });
                return;
              }

              case "batch_move_group": {
                const moved = store.setGroup([item.profileId], action.targetGroup);
                if (moved === 0) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "no_change",
                    detail: "Profile was already in the target group or missing.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                entry.appliedProfileIds.add(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: `Moved to ${action.targetGroup || "(Ungrouped)"}`,
                  finishedAt: this.now(),
                });
                return;
              }

              case "batch_update_tags": {
                const profile = store.getProfile(item.profileId);
                if (!profile) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "profile_not_found",
                    detail: "Profile no longer exists.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                const nextTags = computeNextTags(profile.tags ?? [], action.mode, action.tags);
                profile.tags = nextTags;
                store.upsertProfile(profile);
                entry.appliedProfileIds.add(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: nextTags.length ? nextTags.join(", ") : "(None)",
                  finishedAt: this.now(),
                });
                return;
              }

              case "batch_replace_failed_proxies": {
                if (!proxyVault || !item.targetVaultId) {
                  recordItem(index, {
                    ...base,
                    status: "failed",
                    reason: "vault_unavailable",
                    detail: "Proxy Vault entry is unavailable.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                if (store.getLaunch(item.profileId)) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "profile_running",
                    detail: "Skipped running profile.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                const resolved = proxyVault.resolveProxySpec(item.targetVaultId);
                if (!resolved) {
                  recordItem(index, {
                    ...base,
                    status: "failed",
                    reason: "vault_entry_unavailable",
                    detail: "Selected Proxy Vault entry is no longer healthy or available.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                if (typeof proxyVault.bindProfileToVault === "function") {
                  const bound = proxyVault.bindProfileToVault(item.targetVaultId, item.profileId);
                  if (!bound.ok) {
                    recordItem(index, {
                      ...base,
                      status: bound.reason === "profile_open" ? "skipped" : "failed",
                      reason: bound.reason ?? "bind_failed",
                      detail: "Could not bind proxy from Proxy Vault.",
                      finishedAt: this.now(),
                    });
                    return;
                  }
                } else {
                  const profile = store.getProfile(item.profileId);
                  if (!profile) {
                    recordItem(index, {
                      ...base,
                      status: "skipped",
                      reason: "profile_not_found",
                      detail: "Profile no longer exists.",
                      finishedAt: this.now(),
                    });
                    return;
                  }
                  const nextProfile: Profile = {
                    ...profile,
                    proxy: { ...resolved.proxy },
                    timezone: profile.timezoneManual ? profile.timezone : "",
                  };
                  delete nextProfile.proxyError;
                  store.upsertProfile(nextProfile);
                }
                entry.appliedProfileIds.add(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: `Assigned ${resolved.label}`,
                  finishedAt: this.now(),
                });
                return;
              }

              case "batch_launch_profiles": {
                if (!launcher) {
                  recordItem(index, {
                    ...base,
                    status: "failed",
                    reason: "launcher_unavailable",
                    detail: "Browser launcher service is unavailable.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                if (store.getLaunch(item.profileId)) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "already_running",
                    detail: "Profile browser is already open.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                await launcher.start(item.profileId);
                entry.appliedProfileIds.add(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: "Browser launched",
                  finishedAt: this.now(),
                });
                return;
              }

              case "batch_stop_profiles": {
                if (!launcher) {
                  recordItem(index, {
                    ...base,
                    status: "failed",
                    reason: "launcher_unavailable",
                    detail: "Browser launcher service is unavailable.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                const launch = store.getLaunch(item.profileId);
                if (!launch) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "not_running",
                    detail: "Profile browser is already stopped.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                await launcher.captureLocalSession(item.profileId);
                const stopped = await launcher.stop(item.profileId, launch);
                if (!stopped) {
                  recordItem(index, {
                    ...base,
                    status: "failed",
                    reason: "teardown_unconfirmed",
                    detail: "Browser teardown could not be confirmed.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                entry.appliedProfileIds.add(item.profileId);
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: "Session saved & browser stopped",
                  finishedAt: this.now(),
                });
                return;
              }

              case "generate_fingerprint_summary": {
                const profile = store.getProfile(item.profileId);
                if (!profile) {
                  recordItem(index, {
                    ...base,
                    status: "skipped",
                    reason: "profile_not_found",
                    detail: "Profile no longer exists.",
                    finishedAt: this.now(),
                  });
                  return;
                }
                const review = buildStoredFingerprintReport(profile, {
                  captureSource: store.getFingerprintSource(item.profileId),
                  launch: store.getLaunch(item.profileId),
                });
                const report = review.report;
                fpCounts.total++;
                fpCounts[report.status]++;
                for (const check of report.checks) {
                  if (check.status !== "fail" && check.status !== "warn") continue;
                  const tally = fpCheckTallies.get(check.id) ?? {
                    id: check.id,
                    label: check.label,
                    failCount: 0,
                    warnCount: 0,
                  };
                  if (check.status === "fail") tally.failCount++;
                  else tally.warnCount++;
                  fpCheckTallies.set(check.id, tally);
                }
                recordItem(index, {
                  ...base,
                  status: "succeeded",
                  detail: `${report.status} (${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail)`,
                  fpSummary: {
                    status: report.status,
                    pass: report.summary.pass,
                    warn: report.summary.warn,
                    fail: report.summary.fail,
                    unknown: report.summary.unknown,
                  },
                  finishedAt: this.now(),
                });
                return;
              }
            }
          } catch (error) {
            recordItem(index, {
              ...base,
              status: "failed",
              reason: "execution_failed",
              detail: sanitizeExecutionError(error),
              finishedAt: this.now(),
            });
          }
        },
        (item, index) => {
          recordItem(index, {
            profileId: item.profileId,
            profileName: item.profileName,
            beforeSummary: item.beforeSummary,
            afterSummary: item.afterSummary,
            status: "aborted",
            reason: "aborted_by_user",
            detail: "Cancelled by emergency stop.",
            finishedAt: this.now(),
          });
        },
      );

      if (action.type === "filter_anomalous_profiles") {
        exec.filterResult = {
          profileIds: matchedFilterIds,
          criteria: [...action.criteria],
          ...(action.group !== undefined ? { group: action.group } : {}),
          ...(action.tags !== undefined ? { tags: [...action.tags] } : {}),
        };
      }
      if (action.type === "generate_fingerprint_summary") {
        exec.fingerprintSummary = {
          ...fpCounts,
          topChecks: [...fpCheckTallies.values()]
            .sort((a, b) => b.failCount - a.failCount || b.warnCount - a.warnCount || a.id.localeCompare(b.id))
            .slice(0, 8),
        };
      }

      exec.finishedAt = this.now();
      if (signal.aborted) {
        exec.status = "aborted";
        const snapshot = structuredClone(exec);
        send({ type: "aborted", proposalId: entry.view.proposalId, snapshot });
        emitTask("aborted");
        return snapshot;
      }

      exec.status = "completed";
      const snapshot = structuredClone(exec);
      send({ type: "summary", proposalId: entry.view.proposalId, snapshot });
      emitTask("completed");
      return snapshot;
    } catch (error) {
      exec.finishedAt = this.now();
      exec.status = "failed";
      exec.error = sanitizeExecutionError(error);
      const snapshot = structuredClone(exec);
      send({
        type: "error",
        proposalId: entry.view.proposalId,
        code: "execution_error",
        error: exec.error,
      });
      emitTask("failed", { error: exec.error });
      return snapshot;
    } finally {
      if (entry.abortController === abortController) {
        entry.abortController = null;
      }
    }
  }
}

const defaultProposalRegistry = new AssistantProposalRegistry();

export function getDefaultProposalRegistry(): AssistantProposalRegistry {
  return defaultProposalRegistry;
}

export function resolveProposalWorkspaceId(
  store: object,
  options: { workspaceManagement?: { currentId(): string }; paths?: { root: string } } = {},
): string {
  const managed = options.workspaceManagement?.currentId();
  if (managed) return managed;
  if (options.paths?.root) return options.paths.root;
  let fallback = storeWorkspaceScopes.get(store);
  if (!fallback) {
    fallback = `mem_${randomBytes(8).toString("hex")}`;
    storeWorkspaceScopes.set(store, fallback);
  }
  return fallback;
}

export function parseAndCompileProposalFromReply(
  content: string,
  store: ProfileStore,
  options: {
    workspaceId: string;
    registry?: AssistantProposalRegistry;
    proxyVault?: AssistantProxyVaultLookup;
  },
): { proposal: CompiledProposalView | null; proposalParseError?: string } {
  const parsed = parseAssistantProposal(content);
  if (parsed.status === "none") return { proposal: null };
  if (parsed.status === "error") {
    return { proposal: null, proposalParseError: parsed.error };
  }
  try {
    const registry = options.registry ?? defaultProposalRegistry;
    const compiled = registry.compileAndStore(parsed.proposal, store, {
      workspaceId: options.workspaceId,
      proxyVault: options.proxyVault,
    });
    return { proposal: compiled };
  } catch (error) {
    return {
      proposal: null,
      proposalParseError: error instanceof AssistantProposalError ? error.message : "Could not compile action proposal.",
    };
  }
}
