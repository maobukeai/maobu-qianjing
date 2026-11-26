import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UiProfile } from "./api.ts";

export interface DefaultBrowserStatus {
  supported: boolean;
  registered: boolean;
  registrationCurrent: boolean;
  isDefaultHttp: boolean;
  isDefaultHttps: boolean;
  isDefault: boolean;
  currentHttpProgId: string | null;
  currentHttpsProgId: string | null;
  exePath: string | null;
}

export interface ExternalUrlEvent {
  id: number;
  url: string;
  receivedAtMs: number;
}

export type DefaultBrowserRoutingMode = "smart" | "always-ask" | "fixed-profile";

export interface DomainRoutingRule {
  domain: string;
  profileId: string;
}

export interface DefaultBrowserRoutingConfig {
  mode: DefaultBrowserRoutingMode;
  autoOpenSingleRunning: boolean;
  defaultProfileId: string;
  pickerRunningOnly: boolean;
  domainRules: DomainRoutingRule[];
}

export type ExternalUrlRouteDecision =
  | {
      action: "open";
      url: string;
      hostname: string;
      profile: UiProfile;
      reason: "domain-rule" | "fixed-profile" | "single-running";
      ruleDomain?: string;
    }
  | {
      action: "pick";
      url: string;
      hostname: string;
      reason: "no-running" | "multiple-running" | "always-ask" | "missing-fixed-profile";
      matchedRuleDomain?: string;
    }
  | {
      action: "invalid";
      url: string;
      error: string;
    };

export interface PickerCandidateGroup {
  running: UiProfile[];
  favorites: UiProfile[];
  recent: UiProfile[];
  searchMatches: UiProfile[];
  hiddenStoppedCount: number;
  hasSearchQuery: boolean;
}

export const EXTERNAL_URL_EVENT = "maobu:external-url";
const STORAGE_KEY_PREFIX = "maobu.defaultBrowser.routing.v1";
const MAX_DOMAIN_RULES = 200;
const MAX_URL_LENGTH = 4096;

export const DEFAULT_BROWSER_ROUTING_CONFIG: DefaultBrowserRoutingConfig = {
  mode: "smart",
  autoOpenSingleRunning: true,
  defaultProfileId: "",
  pickerRunningOnly: false,
  domainRules: [],
};

export function isDesktopDefaultBrowserHost(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === "function" &&
    isTauri()
  );
}

export function parseExternalHttpUrl(raw: string): { url: string; hostname: string } | null {
  if (!raw || raw.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return null;
    }
    return {
      url: parsed.toString(),
      hostname: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function normalizeRuleDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253 || /\s|[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = parseExternalHttpUrl(candidate);
    if (!parsed) return null;
    candidate = parsed.hostname;
  } else {
    candidate = candidate.replace(/\/.*$/, "");
  }

  const wildcard = candidate.startsWith("*.");
  const bare = wildcard ? candidate.slice(2) : candidate;
  if (!bare || bare.includes("*") || bare.includes("..") || bare.startsWith(".") || bare.endsWith(".")) {
    return null;
  }
  if (!bare.includes(".")) {
    // Allow single-label hosts like "localhost", reject punctuation garbage.
    if (!/^[a-z0-9-]+$/.test(bare)) return null;
  } else {
    const labels = bare.split(".");
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label))) {
      return null;
    }
  }
  return wildcard ? `*.${bare}` : bare;
}

export function matchDomainRule(
  hostname: string,
  rules: readonly DomainRoutingRule[],
): DomainRoutingRule | null {
  const normalizedHost = hostname.trim().toLowerCase();
  if (!normalizedHost) return null;

  let wildcardMatch: DomainRoutingRule | null = null;
  let wildcardLength = -1;

  for (const rule of rules) {
    const domain = normalizeRuleDomain(rule.domain);
    if (!domain) continue;
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2);
      if (
        normalizedHost.endsWith(`.${suffix}`) &&
        normalizedHost.length > suffix.length + 1 &&
        suffix.length > wildcardLength
      ) {
        wildcardMatch = { domain, profileId: rule.profileId };
        wildcardLength = suffix.length;
      }
    } else if (normalizedHost === domain) {
      return { domain, profileId: rule.profileId };
    }
  }
  return wildcardMatch;
}

export function normalizeDefaultBrowserConfig(raw: unknown): DefaultBrowserRoutingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_BROWSER_ROUTING_CONFIG, domainRules: [] };
  }
  const obj = raw as Record<string, unknown>;
  const mode: DefaultBrowserRoutingMode =
    obj.mode === "smart" || obj.mode === "always-ask" || obj.mode === "fixed-profile"
      ? obj.mode
      : "smart";
  const autoOpenSingleRunning =
    typeof obj.autoOpenSingleRunning === "boolean" ? obj.autoOpenSingleRunning : true;
  const defaultProfileId =
    typeof obj.defaultProfileId === "string" ? obj.defaultProfileId.trim() : "";
  const pickerRunningOnly =
    typeof obj.pickerRunningOnly === "boolean" ? obj.pickerRunningOnly : false;

  const seenDomains = new Set<string>();
  const domainRules: DomainRoutingRule[] = [];
  if (Array.isArray(obj.domainRules)) {
    for (const item of obj.domainRules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const domain = normalizeRuleDomain(String((item as { domain?: unknown }).domain ?? ""));
      const profileId =
        typeof (item as { profileId?: unknown }).profileId === "string"
          ? (item as { profileId: string }).profileId.trim()
          : "";
      if (!domain || !profileId || seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      domainRules.push({ domain, profileId });
      if (domainRules.length >= MAX_DOMAIN_RULES) break;
    }
  }

  return {
    mode,
    autoOpenSingleRunning,
    defaultProfileId,
    pickerRunningOnly,
    domainRules,
  };
}

function storageKey(workspaceId: string | null | undefined): string {
  return `${STORAGE_KEY_PREFIX}:${workspaceId?.trim() || "default"}`;
}

export function loadDefaultBrowserConfig(
  workspaceId: string | null | undefined,
): DefaultBrowserRoutingConfig {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_BROWSER_ROUTING_CONFIG, domainRules: [] };
  }
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return { ...DEFAULT_BROWSER_ROUTING_CONFIG, domainRules: [] };
    return normalizeDefaultBrowserConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BROWSER_ROUTING_CONFIG, domainRules: [] };
  }
}

export function saveDefaultBrowserConfig(
  workspaceId: string | null | undefined,
  config: DefaultBrowserRoutingConfig,
): DefaultBrowserRoutingConfig {
  const normalized = normalizeDefaultBrowserConfig(config);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(storageKey(workspaceId), JSON.stringify(normalized));
    } catch {
      // Ignore storage quota errors cleanly.
    }
  }
  return normalized;
}

export function upsertDomainRule(
  config: DefaultBrowserRoutingConfig,
  rawDomain: string,
  profileId: string,
): DefaultBrowserRoutingConfig {
  const domain = normalizeRuleDomain(rawDomain);
  const trimmedProfileId = profileId.trim();
  if (!domain || !trimmedProfileId) return config;

  const filtered = config.domainRules.filter((rule) => rule.domain !== domain);
  const nextRules = [{ domain, profileId: trimmedProfileId }, ...filtered].slice(0, MAX_DOMAIN_RULES);
  return { ...config, domainRules: nextRules };
}

export function removeDomainRule(
  config: DefaultBrowserRoutingConfig,
  domain: string,
): DefaultBrowserRoutingConfig {
  const normalized = normalizeRuleDomain(domain) ?? domain.trim().toLowerCase();
  return {
    ...config,
    domainRules: config.domainRules.filter((rule) => rule.domain !== normalized),
  };
}

export function resolveExternalUrlRoute(
  rawUrl: string,
  profiles: readonly UiProfile[],
  config: DefaultBrowserRoutingConfig,
): ExternalUrlRouteDecision {
  const parsed = parseExternalHttpUrl(rawUrl);
  if (!parsed) {
    return {
      action: "invalid",
      url: rawUrl,
      error: "URL must be a valid http:// or https:// address",
    };
  }

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const matchedRule = matchDomainRule(parsed.hostname, config.domainRules);
  if (matchedRule) {
    const bound = byId.get(matchedRule.profileId);
    if (bound && !bound.mobilePersona) {
      return {
        action: "open",
        url: parsed.url,
        hostname: parsed.hostname,
        profile: bound,
        reason: "domain-rule",
        ruleDomain: matchedRule.domain,
      };
    }
  }

  if (config.mode === "fixed-profile") {
    const fixed = config.defaultProfileId ? byId.get(config.defaultProfileId) : undefined;
    if (fixed && !fixed.mobilePersona) {
      return {
        action: "open",
        url: parsed.url,
        hostname: parsed.hostname,
        profile: fixed,
        reason: "fixed-profile",
      };
    }
    return {
      action: "pick",
      url: parsed.url,
      hostname: parsed.hostname,
      reason: "missing-fixed-profile",
      ...(matchedRule ? { matchedRuleDomain: matchedRule.domain } : {}),
    };
  }

  const running = profiles.filter((profile) => profile.running && !profile.mobilePersona);
  if (config.mode === "smart" && config.autoOpenSingleRunning && running.length === 1) {
    return {
      action: "open",
      url: parsed.url,
      hostname: parsed.hostname,
      profile: running[0]!,
      reason: "single-running",
    };
  }

  return {
    action: "pick",
    url: parsed.url,
    hostname: parsed.hostname,
    reason:
      config.mode === "always-ask"
        ? "always-ask"
        : running.length === 0
          ? "no-running"
          : "multiple-running",
    ...(matchedRule ? { matchedRuleDomain: matchedRule.domain } : {}),
  };
}

function compareProfilesForPicker(a: UiProfile, b: UiProfile): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  const openDiff = (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0);
  if (openDiff !== 0) return openDiff;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function profileDisplayNumber(profile: UiProfile): string {
  const custom = profile.customNo?.trim();
  if (custom) return custom;
  if (typeof profile.serial === "number" && Number.isFinite(profile.serial)) {
    return `#${profile.serial}`;
  }
  return "";
}

function matchesSearchQuery(profile: UiProfile, tokens: readonly string[]): boolean {
  const haystack = [
    profile.name,
    profile.id,
    profile.customNo ?? "",
    typeof profile.serial === "number" ? String(profile.serial) : "",
    typeof profile.serial === "number" ? `#${profile.serial}` : "",
    profile.group,
    profile.platform,
    profile.proxy ?? "",
    ...(profile.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function buildPickerCandidates(
  profiles: readonly UiProfile[],
  favoriteProfileIds: ReadonlySet<string>,
  query: string,
  runningOnly: boolean,
): PickerCandidateGroup {
  const eligible = profiles.filter((profile) => !profile.mobilePersona);
  const trimmedQuery = query.trim().toLowerCase();
  if (trimmedQuery) {
    const tokens = trimmedQuery.split(/\s+/).filter(Boolean);
    const matches = eligible
      .filter((profile) => (!runningOnly || profile.running) && matchesSearchQuery(profile, tokens))
      .sort(compareProfilesForPicker)
      .slice(0, 30);
    return {
      running: [],
      favorites: [],
      recent: [],
      searchMatches: matches,
      hiddenStoppedCount: eligible.filter((p) => !p.running).length,
      hasSearchQuery: true,
    };
  }

  const running = eligible.filter((profile) => profile.running).sort(compareProfilesForPicker);
  const runningIds = new Set(running.map((profile) => profile.id));

  const favorites = runningOnly
    ? []
    : eligible
        .filter((profile) => !runningIds.has(profile.id) && favoriteProfileIds.has(profile.id))
        .sort(compareProfilesForPicker)
        .slice(0, 6);

  const favoriteIds = new Set(favorites.map((profile) => profile.id));
  const recent =
    !runningOnly && running.length === 0 && favorites.length === 0
      ? eligible.slice().sort(compareProfilesForPicker).slice(0, 6)
      : [];

  const shownCount = running.length + favorites.length + recent.length;
  const totalStopped = eligible.length - running.length;
  const hiddenStoppedCount = Math.max(0, totalStopped - (shownCount - running.length));

  return {
    running,
    favorites,
    recent,
    searchMatches: [],
    hiddenStoppedCount,
    hasSearchQuery: false,
  };
}

export async function fetchDefaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (!isDesktopDefaultBrowserHost()) {
    return {
      supported: false,
      registered: false,
      registrationCurrent: false,
      isDefaultHttp: false,
      isDefaultHttps: false,
      isDefault: false,
      currentHttpProgId: null,
      currentHttpsProgId: null,
      exePath: null,
    };
  }
  return invoke<DefaultBrowserStatus>("default_browser_status");
}

export async function registerDefaultBrowser(): Promise<DefaultBrowserStatus> {
  return invoke<DefaultBrowserStatus>("default_browser_register");
}

export async function openDefaultBrowserSystemSettings(): Promise<void> {
  await invoke("default_browser_open_settings");
}

export async function unregisterDefaultBrowser(): Promise<DefaultBrowserStatus> {
  return invoke<DefaultBrowserStatus>("default_browser_unregister");
}

export async function takePendingExternalUrls(): Promise<ExternalUrlEvent[]> {
  if (!isDesktopDefaultBrowserHost()) return [];
  return invoke<ExternalUrlEvent[]>("default_browser_take_pending_urls");
}

export async function listenExternalUrls(
  onUrl: (event: ExternalUrlEvent) => void,
): Promise<() => void> {
  if (!isDesktopDefaultBrowserHost()) return () => {};
  return getCurrentWindow().listen<ExternalUrlEvent>(EXTERNAL_URL_EVENT, (event) => {
    if (event.payload && typeof event.payload.url === "string") {
      onUrl(event.payload);
    }
  });
}
