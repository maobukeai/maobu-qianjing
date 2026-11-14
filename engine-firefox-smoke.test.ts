/** Opt-in AliasMode Firefox verification against exclusively local synthetic servers. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./browser-install.ts";
import { firefoxBuildForHost } from "./firefox-install.ts";
import { createFirefoxProfileConfig, syncFirefoxTimezone } from "./firefox-config.ts";
import { callFirefoxOwner, closeFirefoxOwner, reserveFirefoxOwner, startFirefoxOwner } from "./firefox-runtime.ts";
import { createFingerprintSource } from "./fingerprint-source.ts";
import { AppSettingsStore } from "./app-settings.ts";
import { createLocalProxyPreflight } from "./local-proxy-preflight.ts";
import { Launcher } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";
import { ENGINE_QA_HOST, ENGINE_QA_USER, ENGINE_QA_PASS, engineQaOrigin, engineQaProxy } from "./test-fixtures/engine-smoke-proxy.ts";

const root = resolve(fileURLToPath(new URL("./reports/engine-qa", import.meta.url)));
const binary = join(root, "firefox-156.0.1-beta.36/aliasmode.exe");
const run = process.env.MAOBU_ENGINE_QA === "1" && process.platform === "win32" ? test : test.skip;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

for (const type of ["http", "socks5"] as const) {
  run(`real Firefox156: ${type} authentication, owned capture and session shutdown`, async () => {
    const build = firefoxBuildForHost();
    const official = JSON.parse(readFileSync(join(root, "firefox-official-release.json"), "utf8").replace(/^\uFEFF/, ""));
    const asset = official.assets.find((item: { name: string }) => item.name === "aliasmode-156.0.1-beta.36-win.x86_64.zip");
    expect(asset.digest).toBe(`sha256:${build.archiveSha256}`);
    expect(await sha256File(join(root, asset.name))).toBe(build.archiveSha256);
    expect(await sha256File(binary)).toBe(build.executableSha256);
    expect(readFileSync(join(root, "firefox-SHA256SUMS"), "utf8")).toContain(`${build.archiveSha256}  ${asset.name}`);
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, `run-firefox-${type}-`));
    const store = new ProfileStore(join(directory, "synthetic.sqlite"));
    const origin = await engineQaOrigin(), proxy = await engineQaProxy(type, origin.port);
    const logs: string[] = [];
    const profile: Profile = {
      id: `qa-firefox-${type}`, engine: "firefox", firefox: createFirefoxProfileConfig(1600, 900, "windows", 492731),
      accId: "", name: `Isolated Firefox QA ${type}`, group: "engine-qa", platform: "", username: "", password: "", twofa: "",
      proxy: { type, host: "127.0.0.1", port: String(proxy.port), user: ENGINE_QA_USER, pass: ENGINE_QA_PASS },
      ua: "", timezone: "Asia/Shanghai", timezoneManual: true, locale: "en-US", platformOs: "windows",
      hardware: { cores: Math.min(4, availableParallelism()) }, screenWidth: 1600, screenHeight: 900, fingerprintSeed: 492731, cookies: [], seeded: false,
    };
    syncFirefoxTimezone(profile);
    store.upsertProfile(profile);
    const preferences = new AppSettingsStore(join(directory, "app-settings.json"));
    preferences.patch({ network: { checkLocalProxyBeforeLaunch: true } });
    const preflight = createLocalProxyPreflight(() => preferences.read());
    let preflightChecks = 0;
    const launcher = new Launcher({
      store, firefoxBinaryPath: binary, expectedFirefoxBinarySha256: build.executableSha256, manageFirefox: false,
      dataRoot: join(directory, "profiles"), chromiumRuntimeRoot: join(directory, "runtime"), headless: true,
      lookupExitLocation: async () => null, log: line => logs.push(line), cdpReadyTimeoutMs: 30_000,
      checkLocalProxyBeforeLaunch: async endpoint => { preflightChecks++; await preflight(endpoint); },
      firefoxRuntime: {
        reserve: reserveFirefoxOwner, call: callFirefoxOwner, close: closeFirefoxOwner,
        // Add network-isolation prefs only; production launch/capture/ownership remains in use.
        start: (input, options) => startFirefoxOwner({ ...input, prefs: {
          ...input.prefs, "network.dns.disablePrefetch": true, "network.prefetch-next": false,
          "network.http.speculative-parallel-limit": 0, "network.captive-portal-service.enabled": false,
          "network.connectivity-service.enabled": false, "network.trr.mode": 5,
        } }, options),
      },
    });
    let result: Record<string, unknown> = { engine: "firefox", type, verifiedExecutableSha256: build.executableSha256 };
    async function pageEvidence() {
      const launch = store.getLaunch(profile.id)!;
      const bridge = await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner!, "playwright-endpoint", {}, { timeoutMs: 15_000 });
      const child = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("./test-fixtures/engine-smoke-page.mjs", import.meta.url)), bridge.endpoint, `http://${ENGINE_QA_HOST}:${origin.port}/`, "firefox"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }
    try {
      await launcher.start(profile.id, [], { autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      const first = store.getLaunch(profile.id)!;
      expect(first.pid).toBeGreaterThan(0);
      expect(first.userDataDir?.startsWith(directory)).toBe(true);
      expect(await launcher.certifiedActive(profile.id)).toBeTruthy();
      const saved = store.getProfile(profile.id)!;
      expect(saved.fpObserved?.capturedAt).toBeTruthy();
      expect(saved.fpObserved?.language).toBe("en-US");
      expect(saved.fpObserved?.timezone).toBe("Asia/Shanghai");
      expect(saved.fpObserved?.screen).toBe("1600*900");
      expect(saved.fpObserved?.hardwareConcurrency).toBe(profile.hardware!.cores);
      expect(saved.fpObserved?.canvas).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.fpObserved?.audio).toMatch(/^[0-9a-f]{64}$/);
      expect(store.getFingerprintSource(profile.id)).toEqual(createFingerprintSource(saved, first));
      if (process.env.MAOBU_ENGINE_QA_REALM === "1") {
        const bridge = await callFirefoxOwner<{ endpoint: string }>(first.firefoxOwner!, "playwright-endpoint", {}, { timeoutMs: 15_000 });
        const child = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("./test-fixtures/firefox-realm-probe.mjs", import.meta.url)), bridge.endpoint], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code !== 0) throw new Error(`Local Firefox realm probe failed: ${stderr}`);
        writeFileSync(join(directory, "realm-probe.json"), stdout);
      }
      const read = await pageEvidence();
      if (read.code !== 0) throw new Error(`Isolated Firefox page failed: ${read.stderr}`);
      const page = JSON.parse(read.stdout);
      expect(page.title).toBe("Maobu isolated engine QA");
      expect(page.roundtrip).toBe("中文隔离验收");
      expect(page.cookie).toContain("engine_qa=local_only");
      expect(page.language).toBe(saved.fpObserved?.language);
      expect(page.timezone).toBe(saved.fpObserved?.timezone);
      expect(page.screen).toBe(saved.fpObserved?.screen);
      expect(page.cores).toBe(saved.fpObserved?.hardwareConcurrency);
      expect(proxy.evidence.authenticated).toBeGreaterThan(0);
      expect(proxy.evidence.forwarded).toBeGreaterThanOrEqual(2);
      expect(proxy.evidence.rejectedAuth).toBe(0);
      expect(origin.requests.some(item => item.proxyAuthorization)).toBe(false);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(first.pid)).toBe(false);
      expect(alive(first.firefoxOwner!.pid)).toBe(false);
      expect(store.getLaunch(profile.id)).toBeNull();
      await launcher.start(profile.id, [], { autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      const second = store.getLaunch(profile.id)!;
      expect(second.firefoxOwner!.generation).not.toBe(first.firefoxOwner!.generation);
      expect(store.getFingerprintSource(profile.id)).toEqual(createFingerprintSource(store.getProfile(profile.id)!, second));
      expect(store.getFingerprintSource(profile.id)?.launchDigest).not.toBe(createFingerprintSource(saved, first).launchDigest);
      expect(store.getProfile(profile.id)?.fpObserved?.canvas).toBe(saved.fpObserved?.canvas);
      expect(store.getProfile(profile.id)?.fpObserved?.audio).toBe(saved.fpObserved?.audio);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(second.pid)).toBe(false);
      expect(alive(second.firefoxOwner!.pid)).toBe(false);
      const beforeDenied = origin.requests.length;
      store.upsertProfile({ ...store.getProfile(profile.id)!, proxy: { ...profile.proxy!, pass: "deliberately-wrong-fixture-password" } });
      await launcher.start(profile.id, [], { autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      const deniedLaunch = store.getLaunch(profile.id)!;
      const denied = await pageEvidence();
      expect(denied.code).not.toBe(0);
      expect(proxy.evidence.rejectedAuth).toBeGreaterThan(0);
      expect(origin.requests.length).toBe(beforeDenied);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(deniedLaunch.pid)).toBe(false);
      expect(alive(deniedLaunch.firefoxOwner!.pid)).toBe(false);
      expect(preflightChecks).toBe(3);
      result = { ...result, outcome: "passed", localProxyStartupChecks: preflightChecks, page, observed: saved.fpObserved, captureSource: createFingerprintSource(saved, first), proxy: proxy.evidence, originRequests: origin.requests, wrongCredentialsBlocked: true, closedPids: [first.pid, first.firefoxOwner!.pid, second.pid, second.firefoxOwner!.pid, deniedLaunch.pid, deniedLaunch.firefoxOwner!.pid], closed: true };
    } catch (error) {
      result = { ...result, outcome: "failed", error: error instanceof Error ? error.message : String(error), proxy: proxy.evidence, originRequests: origin.requests };
      throw error;
    } finally {
      await launcher.stop(profile.id).catch(error => logs.push(`cleanup: ${String(error)}`));
      await proxy.close(); await origin.close();
      writeFileSync(join(directory, "evidence.json"), JSON.stringify({ ...result, logs }, null, 2));
      store.close();
    }
  }, 180_000);
}
