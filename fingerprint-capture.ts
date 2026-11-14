/**
 * Measure a launched browser's fingerprint, once, quietly.
 *
 * Two rules govern this file:
 *
 *  1. It runs in its OWN locally fulfilled secure page, never an account tab.
 *     The document is intercepted locally; no external request is sent.
 *  2. It can never fail a launch. Identity capture is bookkeeping. Every
 *     failure path here logs and returns — see recordCapture.
 */

import { runPlaywrightWorker, type PlaywrightWorkerOptions } from "./playwright-runtime.ts";
import { fingerprintProbe, type FingerprintSample } from "./diagnose.ts";
import { captureAttestationVerdict, observedFromSample } from "./fingerprint-attestation.ts";
import type { FingerprintVerdict, ObservedFingerprint, Profile } from "./types.ts";
import type { LaunchInfo } from "./types.ts";
import { createFingerprintSource, type FingerprintCaptureSource } from "./fingerprint-source.ts";

const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;

/** Read the live fingerprint over CDP from an isolated secure page. */
export async function captureFingerprint(
  ws: string,
  opts: PlaywrightWorkerOptions = {},
): Promise<FingerprintSample | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  return runPlaywrightWorker<FingerprintSample>("page", {
    endpoint: ws,
    kind: "fingerprint",
    temporary: true,
    fingerprintScript: `(${fingerprintProbe.toString()})()`,
    connectTimeoutMs: timeoutMs,
  }, { ...opts, timeoutMs: timeoutMs + 10_000 });
}

export interface RecordCaptureArgs {
  profile: Profile;
  capture: () => Promise<FingerprintSample | null>;
  save: (profileId: string, observed: ObservedFingerprint, verdict: FingerprintVerdict | null, source: FingerprintCaptureSource) => unknown;
  launch?: LaunchInfo | null;
  log: (msg: string) => void;
  /** WebRTC policy in force for this launch; recorded, never compared. */
  webrtc?: string;
}

/**
 * Run a capture and persist it, plus a verdict when the profile carries an
 * expectation to check against. Swallows everything: the caller is a launch.
 *
 * Returns true when a row was actually written. The launcher needs to know:
 * it guards the rest of the launch with a JSON snapshot of the profile, and
 * this write makes that snapshot stale.
 */
export async function recordCapture(args: RecordCaptureArgs): Promise<boolean> {
  const { profile, capture, save, log, webrtc } = args;
  const source = createFingerprintSource(profile, args.launch);
  let sample: FingerprintSample | null;
  try {
    sample = await capture();
  } catch (err) {
    log(`fingerprint capture failed for ${profile.id} (continuing): ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (!sample) return false;
  const observed = observedFromSample(sample, { webrtc, capturedAt: new Date().toISOString() });
  const verdict = captureAttestationVerdict(profile.fpExpected, observed);
  if (observed.errors) log(`${profile.id}: fingerprint fields unavailable (${Object.keys(sample.errors!).join(", ")})`);
  try {
    if (save(profile.id, observed, verdict, source) === false) return false;
  } catch (err) {
    log(
      `fingerprint capture could not be stored for ${profile.id} (continuing): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
  if (verdict?.verdict === "mismatch") {
    const fields = verdict.differences.map((d) => d.field).join(", ");
    log(`${profile.id}: FINGERPRINT MISMATCH against the imported attestation (${fields})`);
  }
  return true;
}
