import type { ProxyReplacementResult, ProxyReplacementsResponse } from "../contracts/local.ts";
import { setFirefoxScreen } from "../src/firefox-config.ts";
import { parseStrictProxy, parseStrictResolution } from "../src/parse.ts";
import { assertValidProfile, isValidProfileName } from "../src/profile-validation.ts";
import { normalizeProxySpec, proxyIdentityKey } from "../src/proxy.ts";
import { parseProxyReplacementCsv, ProxyReplacementInputError } from "../src/proxy-replacements.ts";
import type { ProfileStore } from "../src/store.ts";
import type { Profile, ProxySpec } from "../src/types.ts";

function invalid(message: string): never {
  throw new ProxyReplacementInputError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Edit only the exposed fields, retaining local cookies, persona, and session files. */
export function editedLocalProfile(profile: Profile, set: Record<string, unknown>): Profile {
  const strings = ["name", "group", "platform", "username", "password", "email", "emailPassword", "twofa", "proxy", "proxyType", "resolution"];
  if (!Object.keys(set).length) invalid("set must contain an editable field");
  for (const [field, value] of Object.entries(set)) {
    const valid = strings.includes(field) ? typeof value === "string"
      : field === "extensions" || field === "tags"
        ? field === "tags" && typeof value === "string" || Array.isArray(value) && value.every((item) => typeof item === "string")
        : false;
    if (!valid) invalid(`invalid editable field: ${field}`);
  }
  if ("name" in set && !isValidProfileName(set.name)) invalid("profile name must be non-empty");
  const next = structuredClone(profile);
  for (const field of ["name", "group", "platform", "username", "password", "email", "emailPassword", "twofa"] as const) {
    if (field in set) next[field] = set[field] as string;
  }
  if ("resolution" in set) {
    const { width, height } = parseStrictResolution(set.resolution);
    if (next.engine === "firefox") setFirefoxScreen(next, width, height);
    next.screenWidth = width;
    next.screenHeight = height;
  }
  if ("proxy" in set) {
    try { next.proxy = parseStrictProxy(set.proxyType ?? profile.proxy?.type ?? "http", set.proxy); }
    catch { invalid("invalid editable proxy"); }
    delete next.proxyError;
  }
  if ("extensions" in set) {
    const extensions = set.extensions as string[];
    if (next.engine === "firefox" && extensions.length) invalid("Chrome extensions are not supported by Firefox profiles");
    next.extensions = [...extensions];
  }
  if ("tags" in set) next.tags = Array.isArray(set.tags)
    ? [...set.tags] as string[]
    : (set.tags as string).split(",").map((tag) => tag.trim()).filter(Boolean);
  assertValidProfile(next);
  return next;
}

/** A synchronous local preview/apply: no account, server request, or credential-bearing response. */
export function replaceLocalProfileProxies(store: ProfileStore, input: Record<string, unknown>): ProxyReplacementsResponse {
  if (Object.keys(input).some((key) => !["dryRun", "csv", "replacements"].includes(key)) ||
      input.dryRun !== undefined && typeof input.dryRun !== "boolean" ||
      (input.csv !== undefined) === (input.replacements !== undefined)) invalid("provide replacements or csv and an optional boolean dryRun");
  const replacements = input.csv !== undefined
    ? typeof input.csv === "string" ? parseProxyReplacementCsv(input.csv) : invalid("csv must be a string")
    : Array.isArray(input.replacements) && input.replacements.length ? input.replacements : invalid("replacements must be a non-empty array");
  const dryRun = input.dryRun !== false;
  const profiles = store.listProfiles();
  const plans: Array<{ result: ProxyReplacementResult; profile?: Profile; next?: ProxySpec }> = replacements.map((row, index) => {
    const result: ProxyReplacementResult = { index, status: "skipped", code: "invalid_row" };
    if (!record(row) || Object.keys(row).some((key) => !["profileId", "username", "proxy"].includes(key)) ||
        (typeof row.profileId === "string") === (typeof row.username === "string") ||
        !(String(row.profileId ?? row.username).trim()) || !record(row.proxy) ||
        Object.keys(row.proxy).some((key) => !["type", "host", "port", "user", "pass"].includes(key)) ||
        ["type", "host", "port", "user", "pass"].some((key) => typeof (row.proxy as Record<string, unknown>)[key] !== "string")) return { result };
    let next: ProxySpec | null;
    try { next = normalizeProxySpec(row.proxy); }
    catch { return { result: { ...result, code: "invalid_proxy" } }; }
    if (!next) return { result: { ...result, code: "invalid_proxy" } };
    const matches = profiles.filter((profile) => row.profileId !== undefined ? profile.id === row.profileId : profile.username === row.username);
    if (!matches.length) return { result: { index, status: "missing", code: "no_editable_match" } };
    if (matches.length !== 1) return { result: { ...result, code: "ambiguous_username" } };
    const profile = matches[0]!;
    return {
      profile, next,
      result: { index, profileId: profile.id, ...(store.getLaunch(profile.id)
        ? { status: "skipped" as const, code: "profile_open" as const }
        : !profile.proxyError && proxyIdentityKey(profile.proxy) === proxyIdentityKey(next)
          ? { status: "unchanged" as const }
          : { status: "ready" as const }) },
    };
  });
  const targets = new Map<string, number>();
  for (const plan of plans) if (plan.profile) targets.set(plan.profile.id, (targets.get(plan.profile.id) ?? 0) + 1);
  for (const plan of plans) {
    if (plan.profile && targets.get(plan.profile.id)! > 1) plan.result = { ...plan.result, status: "skipped", code: "duplicate_target" };
    if (!dryRun && plan.profile && plan.next && plan.result.status === "ready") {
      const next = { ...plan.profile, proxy: plan.next };
      delete next.proxyError;
      store.upsertProfile(next);
      plan.result = { ...plan.result, status: "updated" };
    }
  }
  const results = plans.map((plan) => plan.result);
  return {
    ok: true, dryRun,
    counts: {
      received: results.length, matched: results.filter((row) => !!row.profileId).length,
      ready: results.filter((row) => row.status === "ready").length,
      updated: results.filter((row) => row.status === "updated").length,
      unchanged: results.filter((row) => row.status === "unchanged").length,
      missing: results.filter((row) => row.status === "missing").length,
      skipped: results.filter((row) => row.status === "skipped").length,
    },
    results,
    missingUsernames: results.flatMap((row) => row.status === "missing" && typeof replacements[row.index]?.username === "string" ? [replacements[row.index].username] : []),
  };
}
