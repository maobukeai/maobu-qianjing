/** Pure, privacy-minimizing helpers for the opt-in synthetic-network experiment. */
import { isAbsolute, relative, resolve, sep } from "node:path";

export type BackgroundArm = "baseline" | "no-preloading";
export interface BackgroundOptions { pairs: number; observeMs: number }
export const NETLOG_MAX_BYTES = 12 * 1024 * 1024;
export const NETWORK_PREDICTION_PREF = "net.network_prediction_options";

export function parseBackgroundOptions(args: readonly string[]): BackgroundOptions {
  const options = { pairs: 3, observeMs: 10_000 };
  const used = new Set<string>();
  for (const arg of args) {
    const match = /^--(pairs|observe-ms)=(\d+)$/.exec(arg);
    if (!match || used.has(match[1]!)) throw new Error(`Unsupported or repeated QA option: ${arg.split("=")[0]}`);
    used.add(match[1]!);
    if (match[1] === "pairs") options.pairs = Number(match[2]); else options.observeMs = Number(match[2]);
  }
  if (!Number.isInteger(options.pairs) || options.pairs < 3 || options.pairs > 5) throw new Error("QA requires 3–5 pairs");
  if (!Number.isInteger(options.observeMs) || options.observeMs < 5_000 || options.observeMs > 15_000) throw new Error("QA observation must be 5000–15000 ms");
  return options;
}

/** Every write/log/temp/profile path must be a strict child of the new run root. */
export function ownedQaPath(root: string, ...parts: string[]): string {
  const absoluteRoot = resolve(root), target = resolve(root, ...parts), child = relative(absoluteRoot, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("QA path is outside its owned directory");
  return target;
}

export function freshPreferences(arm: BackgroundArm): Record<string, unknown> {
  return arm === "no-preloading" ? { net: { network_prediction_options: 2 } } : {};
}

export function backgroundQaArgs(logPath: string, observeMs: number): string[] {
  if (!isAbsolute(logPath)) throw new Error("NetLog requires an absolute owned path");
  if (!Number.isInteger(observeMs) || observeMs < 5_000 || observeMs > 15_000) throw new Error("Unbounded observation");
  return [
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    `--log-net-log=${logPath}`,
    "--net-log-max-size-mb=8",
    // Hard logging bound independent of a renderer/worker failure. Default capture mode strips private information.
    "--net-log-duration=30",
  ];
}

export function requestClass(host: string, path: string): string {
  if (host === "fingerprint.aliasmode.invalid") return "synthetic-fingerprint-capture";
  if (host === "maobu-engine-qa.test" || host === "127.0.0.1" || host === "localhost") return "owned-loopback";
  if (host === "clients2.google.com" && path === "/time/1/current") return "chromium-network-time-candidate";
  if (host === "update.googleapis.com" && path.startsWith("/service/update2")) return "chromium-component-update-candidate";
  if (host === "accounts.google.com") return "google-account-candidate";
  if (host === "www.google.com") return "google-unattributed";
  return "other";
}
export interface NetLogRequestSummary { sourceId: number; host: string; port: number; category: string; firstEventMs: number | null; eventTypes: string[] }
export interface NetLogSummary { available: boolean; reason?: string; eventCount: number; urlSources: NetLogRequestSummary[]; sourceCountsByCategory: Record<string, number> }

/** Never copies raw paths, queries, headers, credentials, cookies or arbitrary params to the summary. */
export function summarizeNetLog(text: string): NetLogSummary {
  const unavailable = (reason: string): NetLogSummary => ({ available: false, reason, eventCount: 0, urlSources: [], sourceCountsByCategory: {} });
  if (Buffer.byteLength(text) > NETLOG_MAX_BYTES) return unavailable("size-limit");
  let input: any;
  try { input = JSON.parse(text); } catch { return unavailable("invalid-or-unflushed-json"); }
  if (!input || !Array.isArray(input.events) || !input.constants?.logEventTypes || typeof input.constants.logEventTypes !== "object" || Array.isArray(input.constants.logEventTypes)) return unavailable("unexpected-format");
  const typeNames = new Map<number, string>();
  for (const [name, value] of Object.entries(input.constants.logEventTypes)) if (/^[A-Z0-9_]+$/.test(name) && typeof value === "number") typeNames.set(value, name);
  const firstTime = input.events.map((event: any) => Number(event?.time)).find((value: number) => Number.isFinite(value));
  const entries = new Map<string, NetLogRequestSummary>();
  for (const event of input.events) {
    if (!Number.isSafeInteger(event?.source?.id) || event.source.id < 0 || typeof event.params?.url !== "string") continue;
    let url: URL;
    try { url = new URL(event.params.url); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9.\-]+$/.test(host) || host.length > 253) continue;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80)), category = requestClass(host, url.pathname);
    const key = `${event.source.id}|${host}|${port}|${category}`;
    const eventType = typeNames.get(event.type) ?? "UNKNOWN_EVENT";
    const time = Number(event.time);
    let entry = entries.get(key);
    if (!entry) {
      entry = { sourceId: event.source.id, host, port, category, firstEventMs: Number.isFinite(time) && firstTime !== undefined ? time - firstTime : null, eventTypes: [] };
      entries.set(key, entry);
    }
    if (!entry.eventTypes.includes(eventType)) entry.eventTypes.push(eventType);
  }
  const urlSources = [...entries.values()].sort((a, b) => a.sourceId - b.sourceId);
  const sourceCountsByCategory: Record<string, number> = {};
  for (const entry of urlSources) sourceCountsByCategory[entry.category] = (sourceCountsByCategory[entry.category] ?? 0) + 1;
  return { available: true, eventCount: input.events.length, urlSources, sourceCountsByCategory };
}

export interface BackgroundTrialMetric { pair: number; arm: BackgroundArm; passed: boolean; googleAttempts: number; syntheticAttempts: number; observedMs: number; startupMs: number; navigationMs: number }
export function compareBackgroundTrials(trials: readonly BackgroundTrialMetric[], expectedPairs: number) {
  if (!Number.isInteger(expectedPairs) || expectedPairs < 3 || expectedPairs > 5) throw new Error("Comparison requires 3–5 pairs");
  const pairs = Array.from({ length: expectedPairs }, (_, index) => {
    const baseline = trials.filter(trial => trial.pair === index + 1 && trial.arm === "baseline");
    const candidate = trials.filter(trial => trial.pair === index + 1 && trial.arm === "no-preloading");
    const complete = baseline.length === 1 && candidate.length === 1 && baseline[0]!.passed && candidate[0]!.passed;
    return { pair: index + 1, complete, baseline: baseline[0] ?? null, candidate: candidate[0] ?? null,
      googleAttemptDelta: complete ? candidate[0]!.googleAttempts - baseline[0]!.googleAttempts : null };
  });
  const valid = pairs.every(pair => pair.complete);
  return { valid, pairs, consistentReduction: valid && pairs.every(pair => pair.googleAttemptDelta! < 0),
    interpretation: !valid ? "inconclusive-incomplete-or-failed-trials" : pairs.every(pair => pair.googleAttemptDelta! < 0) ? "consistent-in-this-isolated-small-sample-only" : "no-consistent-reduction-demonstrated",
    productionPolicyChanged: false as const };
}
