/** Opt-in real Firefox processor-cap regression. Uses only verified QA binaries and synthetic data. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "../src/browser-install.ts";
import { firefoxBuildForHost } from "../src/firefox-install.ts";
import { createFirefoxProfileConfig, syncFirefoxTimezone } from "../src/firefox-config.ts";
import { callFirefoxOwner, closeFirefoxOwner, reserveFirefoxOwner, startFirefoxOwner } from "../src/firefox-runtime.ts";
import { assessFingerprintQuality } from "../src/fingerprint-quality.ts";
import { Launcher } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";
import type { Profile } from "../src/types.ts";
import { ENGINE_QA_HOST, ENGINE_QA_USER, ENGINE_QA_PASS, engineQaOrigin, engineQaProxy } from "../test-fixtures/engine-smoke-proxy.ts";

const root = resolve(fileURLToPath(new URL("../reports/engine-qa", import.meta.url))), binary = join(root, "firefox-156.0.1-beta.36/aliasmode.exe");
const hostCores = availableParallelism();
const run = process.env.MAOBU_ENGINE_QA === "1" && process.platform === "win32" && hostCores < 256 ? test : test.skip;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

run("real Firefox156: saved cores above host match the worker, page and quality expectation", async () => {
  const build = firefoxBuildForHost(), savedCores = Math.min(256, Math.max(32, hostCores + 4));
  const official = JSON.parse(readFileSync(join(root, "firefox-official-release.json"), "utf8").replace(/^\uFEFF/, ""));
  const asset = official.assets.find((item: { name: string }) => item.name === "aliasmode-156.0.1-beta.36-win.x86_64.zip");
  expect(asset.digest).toBe(`sha256:${build.archiveSha256}`); expect(await sha256File(binary)).toBe(build.executableSha256);
  expect(readFileSync(join(root, "firefox-SHA256SUMS"), "utf8")).toContain(`${build.archiveSha256}  ${asset.name}`);
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, "run-firefox-cap-"));
  const store = new ProfileStore(join(directory, "synthetic.sqlite")), origin = await engineQaOrigin(), proxy = await engineQaProxy("http", origin.port);
  const profile: Profile = {
    id: "qa-firefox-cap", engine: "firefox", firefox: createFirefoxProfileConfig(1600, 900, "windows", 491739),
    accId: "", name: "Isolated Firefox processor cap QA", group: "engine-qa", platform: "", username: "", password: "", twofa: "",
    proxy: { type: "http", host: "127.0.0.1", port: String(proxy.port), user: ENGINE_QA_USER, pass: ENGINE_QA_PASS },
    ua: "", timezone: "Asia/Shanghai", timezoneManual: true, locale: "en-US", platformOs: "windows", hardware: { cores: savedCores },
    screenWidth: 1600, screenHeight: 900, fingerprintSeed: 491739, cookies: [], seeded: false,
  };
  syncFirefoxTimezone(profile); store.upsertProfile(profile);
  let workerCores: unknown, result: Record<string, unknown> = { engine: "firefox", savedCores, hostCores, verifiedExecutableSha256: build.executableSha256 };
  const launcher = new Launcher({
    store, firefoxBinaryPath: binary, expectedFirefoxBinarySha256: build.executableSha256, manageFirefox: false, headless: true,
    dataRoot: join(directory, "profiles"), chromiumRuntimeRoot: join(directory, "runtime"), lookupExitLocation: async () => null, cdpReadyTimeoutMs: 30_000,
    firefoxRuntime: {
      reserve: reserveFirefoxOwner, call: callFirefoxOwner, close: closeFirefoxOwner,
      start: (input, callbacks) => {
        workerCores = input.config["navigator.hardwareConcurrency"];
        return startFirefoxOwner({ ...input, prefs: { ...input.prefs, "network.dns.disablePrefetch": true, "network.prefetch-next": false,
          "network.http.speculative-parallel-limit": 0, "network.captive-portal-service.enabled": false, "network.connectivity-service.enabled": false, "network.trr.mode": 5 } }, callbacks);
      },
    },
  });
  try {
    expect(savedCores).toBeGreaterThan(hostCores);
    await launcher.start(profile.id, [], { autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
    const launch = store.getLaunch(profile.id)!; expect(await launcher.certifiedActive(profile.id)).toBeTruthy();
    const saved = store.getProfile(profile.id)!;
    expect(saved.hardware!.cores).toBe(savedCores); expect(launch.persona?.hardware?.cores).toBe(savedCores);
    expect(workerCores).toBe(hostCores); expect(saved.fpObserved?.hardwareConcurrency).toBe(hostCores);
    const bridge = await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner!, "playwright-endpoint", {}, { timeoutMs: 15_000 });
    const child = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("../test-fixtures/engine-smoke-page.mjs", import.meta.url)), bridge.endpoint, `http://${ENGINE_QA_HOST}:${origin.port}/`, "firefox"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Isolated Firefox cap page failed: ${stderr}`);
    const page = JSON.parse(stdout); expect(page.cores).toBe(hostCores); expect(page.roundtrip).toBe("中文隔离验收");
    const report = assessFingerprintQuality(saved, { launchState: "current", launch, captureSource: store.getFingerprintSource(profile.id), hostCores });
    const hardware = report.checks.find(check => check.id === "hardware_configuration")!;
    result = { ...result, workerCores, observedCores: saved.fpObserved?.hardwareConcurrency, pageCores: page.cores,
      launchPersonaCores: launch.persona?.hardware?.cores, legacyUncappedComparisonWouldFail: saved.fpObserved?.hardwareConcurrency !== savedCores, hardwareCheck: hardware };
    expect(hardware.status).toBe("pass"); expect(proxy.evidence.authenticated).toBeGreaterThan(0); expect(proxy.evidence.blockedExternal).toBe(0);
    expect(origin.requests.some(item => item.proxyAuthorization)).toBe(false);
    expect(await launcher.stop(profile.id)).toBe(true); expect(alive(launch.pid)).toBe(false); expect(alive(launch.firefoxOwner!.pid)).toBe(false);
    expect(store.getLaunch(profile.id)).toBeNull(); expect(store.getProfile(profile.id)?.hardware?.cores).toBe(savedCores);
    result = { ...result, outcome: "passed", closed: true, closedPids: [launch.pid, launch.firefoxOwner!.pid] };
  } catch (error) { result = { ...result, outcome: "failed", error: error instanceof Error ? error.message : String(error) }; throw error; }
  finally {
    await launcher.stop(profile.id).catch(() => {}); await proxy.close(); await origin.close(); store.close();
    writeFileSync(join(directory, "evidence.json"), JSON.stringify(result, null, 2));
    console.log(`Firefox processor cap evidence: ${join(directory, "evidence.json")}`);
  }
}, 120_000);
