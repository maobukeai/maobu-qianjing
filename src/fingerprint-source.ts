/** Private local measurement provenance. Never exported as profile or attestation data. */
import { createHash } from "node:crypto";
import type { LaunchInfo, Profile } from "./types.ts";

export interface FingerprintCaptureSource { version: 1; configurationDigest: string; launchDigest: string | null }
export const FINGERPRINT_SOURCE_FIELDS = ["engine", "chromiumRuntime", "firefox", "hardware", "ua", "platformOs", "proxy", "proxyError",
  "timezone", "locale", "screenWidth", "screenHeight", "displayScale", "fingerprintSeed", "extensions"] as const;
function canonical(value: unknown): unknown {
  if (value === undefined || value === "" || Array.isArray(value) && !value.length) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function fingerprintConfigurationDigest(profile: Profile): string {
  return digest(Object.fromEntries(FINGERPRINT_SOURCE_FIELDS.map(key => [key, key === "engine" ? profile.engine ?? "chromium" : profile[key]])));
}
export function fingerprintLaunchDigest(launch: LaunchInfo): string {
  return digest([launch.profileId, launch.engine ?? "chromium", launch.pid, launch.debugPort, launch.startedAt, launch.rootStartTime,
    launch.processGroupId, launch.binarySha256, launch.firefoxOwner?.generation]);
}
export function createFingerprintSource(profile: Profile, launch?: LaunchInfo | null): FingerprintCaptureSource {
  return { version: 1, configurationDigest: fingerprintConfigurationDigest(profile), launchDigest: launch ? fingerprintLaunchDigest(launch) : null };
}
export function parseFingerprintSource(value: unknown): FingerprintCaptureSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || typeof source.configurationDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.configurationDigest)
    || source.launchDigest !== null && (typeof source.launchDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.launchDigest))) return null;
  return { version: 1, configurationDigest: source.configurationDigest, launchDigest: source.launchDigest };
}
