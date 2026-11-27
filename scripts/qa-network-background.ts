/**
 * Opt-in, local-only Chromium155 background-network A/B. No downloads, user state,
 * external relay, production preference/launcher changes, or destructive cleanup.
 * Run: bun --no-env-file scripts/qa-network-background.ts
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASMODE_CHROMIUM_ARCHIVE_SHA256, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { AppSettingsStore } from "../src/app-settings.ts";
import { captureFingerprint } from "../src/fingerprint-capture.ts";
import { createFingerprintSource } from "../src/fingerprint-source.ts";
import { Launcher } from "../src/launcher.ts";
import { createLocalProxyPreflight } from "../src/local-proxy-preflight.ts";
import { ProfileStore } from "../src/store.ts";
import type { Profile } from "../src/types.ts";
import { ENGINE_QA_HOST, ENGINE_QA_PASS, ENGINE_QA_USER, engineQaOrigin, engineQaProxy } from "../test-fixtures/engine-smoke-proxy.ts";
import { backgroundQaArgs, compareBackgroundTrials, freshPreferences, NETLOG_MAX_BYTES, NETWORK_PREDICTION_PREF, ownedQaPath, parseBackgroundOptions, summarizeNetLog, type BackgroundArm, type BackgroundOptions, type BackgroundTrialMetric } from "./qa-network-background-evidence.ts";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assets = join(project, "reports", "engine-qa");
const binary = join(assets, "aliasmode-chromium-155.0.8059.85-windows-x64", "chrome.exe");
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function save(path: string, value: unknown) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" }); }

async function verifyAssets() {
  if (process.platform !== "win32") throw new Error("This QA is restricted to the verified Windows Chromium155 asset");
  const official = JSON.parse(readFileSync(join(assets, "chromium-official-release.json"), "utf8").replace(/^\uFEFF/, ""));
  const name = "aliasmode-chromium-155.0.8059.85-windows-x64.zip";
  strictEqual(official.assets.find((asset: { name: string }) => asset.name === name)?.digest, `sha256:${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}`);
  ok(readFileSync(join(assets, "chromium-SHA256SUMS.txt"), "utf8").includes(`${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}  ${name}`));
  // Do not follow an accidentally repointed asset directory into another runtime or user environment.
  strictEqual(realpathSync(binary).toLowerCase(), resolve(binary).toLowerCase());
  strictEqual(await sha256File(join(assets, name)), ALIASMODE_CHROMIUM_ARCHIVE_SHA256);
  strictEqual(await sha256File(binary), ALIASMODE_CHROMIUM_EXECUTABLE_SHA256);
}

async function readPage(endpoint: string, port: number, denied = false) {
  const node = Bun.which("node");
  if (!node) throw new Error("An existing local Node runtime is required; QA does not install one");
  const child = Bun.spawn([node, fileURLToPath(new URL("../test-fixtures/network-background-page.mjs", import.meta.url)), endpoint, `http://${ENGINE_QA_HOST}:${port}/`, denied ? "denied" : "good"], {
    stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Synthetic page helper failed (${code}): ${stderr.slice(0, 2000)}`);
    if (stdout.length > 16_384) throw new Error("Unexpected page evidence size");
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

async function trial(runRoot: string, pair: number, arm: BackgroundArm, options: BackgroundOptions) {
  const directory = ownedQaPath(runRoot, `pair-${pair}-${arm}`);
  mkdirSync(directory, { recursive: false });
  const store = new ProfileStore(ownedQaPath(directory, "synthetic.sqlite"));
  try {
  const origin = await engineQaOrigin();
  try {
  const events: { elapsedMs: number; host: string; port: number; phase: string }[] = [];
  let started = Date.now(), phase = "setup";
  let eventLimitExceeded = false;
  const proxy = await engineQaProxy("http", origin.port, (host, port) => {
    if (events.length >= 10_000) { eventLimitExceeded = true; return; }
    events.push({ elapsedMs: Date.now() - started, host, port, phase });
  });
  try {
  const logs: string[] = [], pids: number[] = [];
  const transitions: { phase: string; elapsedMs: number }[] = [];
  function mark(next: string) { phase = next; transitions.push({ phase, elapsedMs: Date.now() - started }); }
  const profile: Profile = {
    id: "network-background-qa", accId: "", name: "Synthetic network background QA", group: "engine-qa", platform: "",
    engine: "chromium", chromiumRuntime: "aliasmode", username: "", password: "", twofa: "",
    proxy: { type: "http", host: "127.0.0.1", port: String(proxy.port), user: ENGINE_QA_USER, pass: ENGINE_QA_PASS },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    timezone: "Asia/Shanghai", timezoneManual: true, locale: "en-US", platformOs: "windows",
    screenWidth: 1600, screenHeight: 900, displayScale: 1, fingerprintSeed: 482731,
    hardware: { cores: Math.min(4, availableParallelism()) }, cookies: [], seeded: false,
  };
  store.upsertProfile(profile);
  const settings = new AppSettingsStore(ownedQaPath(directory, "app-settings.json"));
  settings.patch({ network: { checkLocalProxyBeforeLaunch: true } });
  const preflight = createLocalProxyPreflight(() => settings.read());
  let checks = 0;
  const netlogPath = ownedQaPath(directory, "network.json");
  const log = (line: string) => { if (logs.length < 400) logs.push(line.slice(0, 2000)); };
  const common = {
    store, binaryPath: binary, expectedBinarySha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
    ensureAliasmodeChromium: async () => binary,
    chromiumRuntimeRoot: ownedQaPath(directory, "runtime"), dataRoot: ownedQaPath(directory, "profiles"),
    headless: true, portRange: { start: 25000, end: 25999 }, lookupExitLocation: async () => null,
    checkLocalProxyBeforeLaunch: async (endpoint: Parameters<typeof preflight>[0]) => { checks++; await preflight(endpoint); },
    captureFingerprint: (ws: string) => captureFingerprint(ws, { timeoutMs: 8_000 }),
    cdpReadyTimeoutMs: 15_000, gracefulStopMs: 3_000, log,
  };
  const launcher = new Launcher({ ...common, baseArgs: backgroundQaArgs(netlogPath, options.observeMs) });
  // Bad-auth verification deliberately uses no NetLog flag, so it cannot overwrite the A/B capture.
  const deniedLauncher = new Launcher({ ...common, baseArgs: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
  const prefsDirectory = ownedQaPath(directory, "profiles", profile.id, "Default");
  mkdirSync(prefsDirectory, { recursive: true });
  writeFileSync(ownedQaPath(prefsDirectory, "Preferences"), JSON.stringify(freshPreferences(arm)), { flag: "wx" });
  const evidence: any = { version: 1, pair, arm, outcome: "failed", startedAt: new Date().toISOString(),
    control: "One changed preference only; all other launch/persona/proxy settings held equivalent",
    requestedPreference: arm === "no-preloading" ? 2 : "native-default-unset",
    netLogCaptureMode: "Default (Strip private information)", netLogMaximumMiB: 8, netLogDurationSeconds: 30,
    verifiedExecutableSha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
    ownedDirectory: directory, observeTargetMs: options.observeMs,
  };
  let metric: BackgroundTrialMetric | null = null;
  try {
    started = Date.now(); mark("good-start-including-production-capture");
    const opened = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
    const launch = store.getLaunch(profile.id)!;
    ok(launch?.pid > 0); pids.push(launch.pid);
    strictEqual(launch.userDataDir, ownedQaPath(directory, "profiles", profile.id));
    ok(await launcher.certifiedActive(profile.id));
    const saved = store.getProfile(profile.id)!;
    ok(saved.fpObserved?.capturedAt);
    strictEqual(saved.fpObserved.language, "en-US"); strictEqual(saved.fpObserved.timezone, "Asia/Shanghai");
    strictEqual(saved.fpObserved.screen, "1600*900"); strictEqual(saved.fpObserved.hardwareConcurrency, profile.hardware!.cores);
    ok(/^[0-9a-f]{64}$/.test(saved.fpObserved.canvas ?? "")); ok(/^[0-9a-f]{64}$/.test(saved.fpObserved.audio ?? ""));
    deepStrictEqual(store.getFingerprintSource(profile.id), createFingerprintSource(saved, launch));
    evidence.startupMs = Date.now() - started;
    evidence.identity = { observed: saved.fpObserved, captureSource: createFingerprintSource(saved, launch), certified: true };
    mark("owned-settings-readback-and-loopback-page");
    const page = await readPage(opened.ws, origin.port);
    strictEqual(page.preference?.key, NETWORK_PREDICTION_PREF);
    ok(typeof page.preference.value === "number");
    if (arm === "no-preloading") strictEqual(page.preference.value, 2);
    else ok([0, 1].includes(page.preference.value), "Native baseline must actually have standard preloading enabled");
    strictEqual(page.page.title, "Maobu isolated engine QA");
    ok(page.page.text.includes("本机真实内核验收")); strictEqual(page.page.roundtrip, "中文隔离验收");
    ok(page.page.cookie.includes("engine_qa=local_only")); strictEqual(page.page.language, saved.fpObserved.language);
    strictEqual(page.page.timezone, saved.fpObserved.timezone); strictEqual(page.page.cores, saved.fpObserved.hardwareConcurrency);
    strictEqual(page.page.screen, saved.fpObserved.screen);
    evidence.page = page;
    evidence.verificationCompletedMs = Date.now() - started;
    ok(evidence.verificationCompletedMs < options.observeMs, "Startup/page verification exceeded the fixed observation window");
    mark("fixed-window-idle");
    await sleep(Math.max(0, options.observeMs - (Date.now() - started)));
    evidence.observedMs = Date.now() - started;
    ok(evidence.observedMs <= options.observeMs + 1_000, "Observation window scheduling overrun");
    ok(!eventLimitExceeded, "Unexpected fixture target volume exceeded the evidence bound");
    // Freeze the comparison before shutdown and the deliberately bad-auth phase.
    evidence.comparisonEvents = events.filter(event => event.elapsedMs <= evidence.observedMs);
    evidence.proxyDuringObservation = structuredClone(proxy.evidence);
    mark("good-shutdown");
    strictEqual(await launcher.stop(profile.id), true); strictEqual(alive(launch.pid), false);
    strictEqual(store.getLaunch(profile.id), null);
    ok(existsSync(netlogPath)); ok(statSync(netlogPath).size <= NETLOG_MAX_BYTES, "NetLog exceeded safety size bound");
    evidence.netLogBytes = statSync(netlogPath).size;
    evidence.netLog = summarizeNetLog(readFileSync(netlogPath, "utf8"));
    ok(evidence.netLog.available, `NetLog unavailable: ${evidence.netLog.reason}`);
    ok(evidence.netLog.urlSources.some((entry: { category: string }) => entry.category === "synthetic-fingerprint-capture"), "NetLog must associate the production synthetic capture");

    mark("wrong-auth-start");
    const beforeDenied = origin.requests.length;
    const beforeRejections = proxy.evidence.rejectedAuth;
    store.upsertProfile({ ...store.getProfile(profile.id)!, proxy: { ...profile.proxy!, pass: "deliberately-wrong-fixture-password" } });
    const denied = await deniedLauncher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
    const deniedPid = store.getLaunch(profile.id)!.pid; pids.push(deniedPid);
    const deniedPage = await readPage(denied.ws, origin.port, true);
    strictEqual(deniedPage.blocked, true);
    strictEqual(origin.requests.length, beforeDenied); ok(proxy.evidence.rejectedAuth > beforeRejections);
    ok(!origin.requests.some(request => request.proxyAuthorization));
    strictEqual(await deniedLauncher.stop(profile.id), true); strictEqual(alive(deniedPid), false);
    strictEqual(checks, 2);
    evidence.wrongCredentials = { blocked: true, originRequestsAdded: 0, networkError: deniedPage.networkError };
    evidence.originNeverReceivedProxyAuthorization = true;
    const observedEvents = evidence.comparisonEvents as typeof events;
    metric = { pair, arm, passed: true,
      googleAttempts: observedEvents.filter(event => event.host === "www.google.com" || event.host.endsWith(".google.com") || event.host.endsWith(".googleapis.com")).length,
      syntheticAttempts: observedEvents.filter(event => event.host === "fingerprint.aliasmode.invalid").length,
      observedMs: evidence.observedMs, startupMs: evidence.startupMs, navigationMs: page.navigationMs };
    evidence.metric = metric; evidence.outcome = "passed";
  } catch (error) {
    evidence.error = error instanceof Error ? error.message.slice(0, 3000) : "Unknown QA failure";
  } finally {
    mark("finally-cleanup");
    const currentPid = store.getLaunch(profile.id)?.pid;
    if (currentPid && !pids.includes(currentPid)) pids.push(currentPid);
    // Both launchers reference this fixture's store only. Production ownership gates stay enabled.
    for (const ownedLauncher of [launcher, deniedLauncher]) {
      try { await ownedLauncher.stop(profile.id); } catch (error) { log(`cleanup: ${String(error)}`); }
    }
    evidence.closedPids = pids;
    evidence.remainingRecordedPids = pids.filter(alive);
    evidence.closed = evidence.remainingRecordedPids.length === 0 && store.getLaunch(profile.id) === null;
    if (!evidence.closed) { evidence.outcome = "failed"; if (metric) metric.passed = false; }
    evidence.localProxyStartupChecks = checks;
    evidence.proxyAllPhases = structuredClone(proxy.evidence);
    evidence.targetEvents = events; evidence.transitions = transitions;
    evidence.originRequests = origin.requests;
    evidence.finishedAt = new Date().toISOString(); evidence.logs = logs;
    save(ownedQaPath(directory, "evidence.json"), evidence);
  }
  return { metric, evidencePath: ownedQaPath(directory, "evidence.json"), passed: evidence.outcome === "passed", error: evidence.error ?? null };
  } finally { await proxy.close(); }
  } finally { await origin.close(); }
  } finally { store.close(); }
}

export async function runNetworkBackgroundQa(args: readonly string[]) {
  const options = parseBackgroundOptions(args);
  await verifyAssets();
  const reportRoot = join(project, "reports", "network-background-qa");
  mkdirSync(reportRoot, { recursive: true });
  const runRoot = mkdtempSync(join(reportRoot, "run-"));
  const temp = ownedQaPath(runRoot, "temp"); mkdirSync(temp);
  const environment = { TEMP: temp, TMP: temp, ALIASMODE_PLAYWRIGHT_RUNTIME: "", ALIASMODE_SESSION_LAUNCH: "0", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const trials: Awaited<ReturnType<typeof trial>>[] = [], metrics: BackgroundTrialMetric[] = [];
  const manifest: any = { version: 1, startedAt: new Date().toISOString(), options, binary, verifiedExecutableSha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
    isolation: "Fresh synthetic state; owned loopback HTTP proxy forwards only its own fixture origin; deny-all hostname resolver; headless; no downloads; no user data; no deletion",
    observation: "Fixed window from immediately before Launcher.start, includes production capture, owned settings readback, local page and idle; proxy counts frozen before shutdown/wrong-auth",
    commonExtraArgs: backgroundQaArgs(ownedQaPath(runRoot, "example-network.json"), options.observeMs),
    candidate: { key: NETWORK_PREDICTION_PREF, baseline: "native unset default, read back as standard 0/1", changed: 2 },
    productionPolicyChanged: false, trials,
  };
  const manifestPath = ownedQaPath(runRoot, "manifest.json");
  try {
    for (const [key, value] of Object.entries(environment)) process.env[key] = value;
    save(manifestPath, manifest);
    console.log(`Isolated Chromium155 background QA: ${runRoot}`);
    for (let pair = 1; pair <= options.pairs; pair++) {
      // Counterbalance the middle pair to expose order/warm-cache effects rather than always favoring the second arm.
      const arms: BackgroundArm[] = pair % 2 === 0 ? ["no-preloading", "baseline"] : ["baseline", "no-preloading"];
      for (const arm of arms) {
        const result = await trial(runRoot, pair, arm, options);
        trials.push(result); if (result.metric) metrics.push(result.metric);
        console.log(`pair ${pair} ${arm}: ${result.passed ? "PASS" : "FAIL"}${result.metric ? `; Google target attempts=${result.metric.googleAttempts}; synthetic=${result.metric.syntheticAttempts}` : `; ${result.error}`}`);
        save(manifestPath, manifest);
        // A failed safety/correctness case must not be hidden by continuing to collect a favorable arm.
        if (!result.passed) throw new Error(`Synthetic QA failed: pair ${pair} ${arm}; evidence retained`);
      }
    }
  } finally {
    manifest.finishedAt = new Date().toISOString(); manifest.comparison = compareBackgroundTrials(metrics, options.pairs);
    save(manifestPath, manifest);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`Evidence manifest: ${manifestPath}`);
  }
  return manifest;
}

if (import.meta.main) {
  try { await runNetworkBackgroundQa(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Background QA failed"); process.exitCode = 1; }
}
