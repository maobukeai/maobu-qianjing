/** One offline report shared by settings and local agent tools. Never probes a browser. */
import { assessFingerprintQuality, type FingerprintQualityReport } from "./fingerprint-quality.ts";
import { launchIdentityChanged } from "./launcher.ts";
import type { FingerprintCaptureSource } from "./fingerprint-source.ts";
import type { LaunchInfo, Profile } from "./types.ts";

export interface StoredFingerprintReview {
  report: FingerprintQualityReport & { name: string };
  /** A stored row is bookkeeping evidence, not proof that its process still exists. */
  launchRecordPresent: boolean;
  liveness: "not-checked";
}

export interface StoredFingerprintReviewOptions {
  launch?: LaunchInfo | null;
  captureSource?: FingerprintCaptureSource | null;
  now?: number;
  hostCores?: number;
}

/**
 * Read existing configuration, launch identity and capture provenance only.
 * Private profile fields, owner endpoints and provenance digests are inputs to
 * consistency checks; none are returned. A missing record never proves closure.
 */
export function buildStoredFingerprintReport(profile: Profile, options: StoredFingerprintReviewOptions = {}): StoredFingerprintReview {
  const launch = options.launch?.profileId === profile.id ? options.launch : null;
  const launchState = launch ? !launch.persona ? "unknown" : launchIdentityChanged(profile, launch) ? "pending" : "current" : undefined;
  const report = assessFingerprintQuality(profile, {
    launchState, launch, captureSource: options.captureSource, now: options.now, hostCores: options.hostCores,
  });
  return {
    report: { name: profile.name, ...report },
    launchRecordPresent: !!launch,
    liveness: "not-checked",
  };
}
