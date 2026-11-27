/** Opt-in production setting integration. Existing pinned local engine, synthetic state only. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASMODE_CHROMIUM_ARCHIVE_SHA256, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../aliasmode-chromium.ts";
import { AppSettingsStore } from "../app-settings.ts";
import { sha256File } from "../browser-install.ts";
import { CHROMIUM_PRELOADING_RECORD } from "../chromium-preloading-preferences.ts";
import { createFingerprintSource } from "../fingerprint-source.ts";
import { Launcher } from "../launcher.ts";
import { createLocalProxyPreflight } from "../local-proxy-preflight.ts";
import { ProfileStore } from "../store.ts";
import type { Profile } from "../types.ts";
import { ENGINE_QA_HOST, ENGINE_QA_PASS, ENGINE_QA_USER, engineQaOrigin, engineQaProxy } from "../test-fixtures/engine-smoke-proxy.ts";

const run = process.env.MAOBU_ENGINE_QA === "1" && process.platform === "win32" ? test : test.skip;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function pageEvidence(endpoint: string, originPort: number) {
  const child = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("../test-fixtures/network-background-page.mjs", import.meta.url)), endpoint, `http://${ENGINE_QA_HOST}:${originPort}/`], { stdout: "pipe", stderr: "pipe", timeout: 25_000 });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); return JSON.parse(stdout);
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
}

run("real managed Chromium155 workspace preloading applies next launch, leaves live session alone and restores original extended value", async () => {
  const assets = resolve(import.meta.dir, "..", "reports/engine-qa"), binary = join(assets, "aliasmode-chromium-155.0.8059.85-windows-x64/chrome.exe");
  const archive = "aliasmode-chromium-155.0.8059.85-windows-x64.zip";
  const release = JSON.parse(readFileSync(join(assets, "chromium-official-release.json"), "utf8").replace(/^\uFEFF/, ""));
  expect(release.assets.find((asset: { name: string }) => asset.name === archive)?.digest).toBe(`sha256:${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}`);
  expect(readFileSync(join(assets, "chromium-SHA256SUMS.txt"), "utf8")).toContain(`${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}  ${archive}`);
  expect(await sha256File(join(assets, archive))).toBe(ALIASMODE_CHROMIUM_ARCHIVE_SHA256);
  expect(await sha256File(binary)).toBe(ALIASMODE_CHROMIUM_EXECUTABLE_SHA256);
  const reports = resolve(import.meta.dir, "..", "reports/network-background-qa"); mkdirSync(reports, { recursive: true });
  const directory = mkdtempSync(join(reports, "preloading-setting-")), store = new ProfileStore(join(directory, "synthetic.sqlite"));
  const origin = await engineQaOrigin();
  try {
    const proxy = await engineQaProxy("http", origin.port);
    try {
      const settings = new AppSettingsStore(join(directory, "app-settings.json"));
      settings.patch({ network: { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "disabled" } });
      const profile: Profile = {
        id: "preloading-setting-qa", accId: "", name: "Synthetic workspace preloading QA", group: "engine-qa", platform: "",
        engine: "chromium", chromiumRuntime: "aliasmode", username: "", password: "", twofa: "",
        proxy: { type: "http", host: "127.0.0.1", port: String(proxy.port), user: ENGINE_QA_USER, pass: ENGINE_QA_PASS },
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        timezone: "Asia/Shanghai", timezoneManual: true, locale: "en-US", platformOs: "windows",
        screenWidth: 1600, screenHeight: 900, displayScale: 1, fingerprintSeed: 482731,
        hardware: { cores: Math.min(4, availableParallelism()) }, cookies: [], seeded: false,
      };
      store.upsertProfile(profile);
      const userDataDir = join(directory, "profiles", profile.id), prefs = join(userDataDir, "Default", "Preferences"), record = join(userDataDir, CHROMIUM_PRELOADING_RECORD);
      mkdirSync(join(userDataDir, "Default"), { recursive: true }); writeFileSync(prefs, JSON.stringify({ net: { network_prediction_options: 3, synthetic_keep: true } }));
      const logs: string[] = [], pids: number[] = []; let getterReads = 0, preflights = 0;
      const check = createLocalProxyPreflight(() => settings.read());
      const launcher = new Launcher({ store, binaryPath: binary, expectedBinarySha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
        ensureAliasmodeChromium: async () => binary, chromiumRuntimeRoot: join(directory, "runtime"), dataRoot: join(directory, "profiles"),
        headless: true, portRange: { start: 26000, end: 26999 }, lookupExitLocation: async () => null,
        checkLocalProxyBeforeLaunch: async endpoint => { preflights++; await check(endpoint); },
        chromiumPreloading: () => { getterReads++; return settings.read().network?.chromiumPreloading ?? "browser-default"; },
        baseArgs: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
        log: line => logs.push(line), cdpReadyTimeoutMs: 20_000,
      });
      const evidence: any = { version: 1, startedAt: new Date().toISOString(), outcome: "failed", directory, verifiedExecutableSha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, originalPreference: 3 };
      try {
        const first = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
        const launch = store.getLaunch(profile.id)!; pids.push(launch.pid); expect(launch.pid).toBeGreaterThan(0); expect(await launcher.certifiedActive(profile.id)).toBeTruthy();
        expect(existsSync(record)).toBe(true);
        const before = store.getProfile(profile.id)!; const captured = store.getFingerprintSource(profile.id);
        expect(captured).toEqual(createFingerprintSource(before, launch));
        expect(before.fpObserved?.canvas).toMatch(/^[a-f0-9]{64}$/); expect(before.fpObserved?.audio).toMatch(/^[a-f0-9]{64}$/);
        const disabled = await pageEvidence(first.ws, origin.port); expect(disabled.preference.value).toBe(2); expect(disabled.page.roundtrip).toBe("中文隔离验收");
        evidence.disabled = { page: disabled, observed: before.fpObserved, captureSource: captured };
        settings.patch({ network: { chromiumPreloading: "browser-default" } });
        const live = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
        expect(live.ws).toBe(first.ws); expect(store.getLaunch(profile.id)!.pid).toBe(launch.pid);
        expect(getterReads).toBe(1); expect(preflights).toBe(1); expect(store.getFingerprintSource(profile.id)).toEqual(captured);
        const unchanged = await pageEvidence(live.ws, origin.port); expect(unchanged.preference.value).toBe(2);
        evidence.liveAfterDefaultSaved = { page: unchanged, sameGeneration: true, getterReads, preflights };
        expect(await launcher.stop(profile.id)).toBe(true); expect(alive(launch.pid)).toBe(false);
        const second = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
        const next = store.getLaunch(profile.id)!; pids.push(next.pid); expect(next.pid).toBeGreaterThan(0); expect(await launcher.certifiedActive(profile.id)).toBeTruthy();
        expect(existsSync(record)).toBe(false);
        const after = store.getProfile(profile.id)!;
        expect(store.getFingerprintSource(profile.id)).toEqual(createFingerprintSource(after, next));
        expect(store.getFingerprintSource(profile.id)?.launchDigest).not.toBe(captured?.launchDigest);
        expect(after.fpObserved?.canvas).toBe(before.fpObserved?.canvas); expect(after.fpObserved?.audio).toBe(before.fpObserved?.audio);
        const restored = await pageEvidence(second.ws, origin.port); expect(restored.preference.value).toBe(3); expect(restored.page.roundtrip).toBe("中文隔离验收");
        expect(getterReads).toBe(2); expect(preflights).toBe(2);
        expect(JSON.parse(readFileSync(prefs, "utf8")).net.synthetic_keep).toBe(true);
        expect(origin.requests.some(request => request.proxyAuthorization)).toBe(false);
        evidence.restored = { page: restored, observed: after.fpObserved, captureSource: store.getFingerprintSource(profile.id) };
        expect(await launcher.stop(profile.id)).toBe(true); expect(alive(next.pid)).toBe(false); expect(store.getLaunch(profile.id)).toBeNull();
        evidence.outcome = "passed";
      } catch (error) { evidence.error = error instanceof Error ? error.message : "Unknown synthetic QA failure"; throw error; }
      finally {
        await launcher.stop(profile.id).catch(error => logs.push(`cleanup: ${String(error)}`));
        evidence.finishedAt = new Date().toISOString(); evidence.getterReads = getterReads; evidence.preflights = preflights;
        evidence.closedPids = pids; evidence.remainingRecordedPids = pids.filter(alive); evidence.closed = evidence.remainingRecordedPids.length === 0 && store.getLaunch(profile.id) === null;
        evidence.proxy = proxy.evidence; evidence.originRequests = origin.requests; evidence.logs = logs;
        writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
      }
    } finally { await proxy.close(); }
  } finally { await origin.close(); store.close(); }
}, 120_000);
