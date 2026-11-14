/** Opt-in real kernel QA. This test never downloads an engine or reads the app's state. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASMODE_CHROMIUM_ARCHIVE_SHA256, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "./aliasmode-chromium.ts";
import { sha256File } from "./browser-install.ts";
import { Launcher } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import { createFingerprintSource } from "./fingerprint-source.ts";
import { AppSettingsStore } from "./app-settings.ts";
import { createLocalProxyPreflight } from "./local-proxy-preflight.ts";
import type { Profile } from "./types.ts";
import { ENGINE_QA_HOST, ENGINE_QA_PASS, ENGINE_QA_USER, engineQaOrigin, engineQaProxy } from "./test-fixtures/engine-smoke-proxy.ts";

const enabled = process.env.MAOBU_ENGINE_QA === "1";
const root = resolve(fileURLToPath(new URL("./reports/engine-qa", import.meta.url)));
const binary = resolve(root, "aliasmode-chromium-155.0.8059.85-windows-x64/chrome.exe");
const run = enabled && process.platform === "win32" ? test : test.skip;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function readPage(ws: string, originPort: number) {
  const child = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("./test-fixtures/engine-smoke-page.mjs", import.meta.url)), ws, `http://${ENGINE_QA_HOST}:${originPort}/`], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

for (const type of ["http", "socks5"] as const) {
  run(`real Chromium155: ${type} authenticated loopback route, persona evidence and owned shutdown`, async () => {
    // Every official asset hash must agree with the source pin before any browser executes.
    const official = JSON.parse(readFileSync(join(root, "chromium-official-release.json"), "utf8").replace(/^\uFEFF/, ""));
    const asset = official.assets.find((item: { name: string }) => item.name === "aliasmode-chromium-155.0.8059.85-windows-x64.zip");
    expect(asset.digest).toBe(`sha256:${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}`);
    expect(await sha256File(join(root, asset.name))).toBe(ALIASMODE_CHROMIUM_ARCHIVE_SHA256);
    expect(await sha256File(binary)).toBe(ALIASMODE_CHROMIUM_EXECUTABLE_SHA256);
    const checksum = readFileSync(join(root, "chromium-SHA256SUMS.txt"), "utf8");
    expect(checksum).toContain(`${ALIASMODE_CHROMIUM_ARCHIVE_SHA256}  ${asset.name}`);

    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, `run-${type}-`));
    const store = new ProfileStore(join(directory, "synthetic.sqlite"));
    const origin = await engineQaOrigin();
    const proxy = await engineQaProxy(type, origin.port);
    const logs: string[] = [];
    const profile: Profile = {
      id: `qa-${type}`, accId: "", name: `Isolated engine QA ${type}`, group: "engine-qa", platform: "",
      engine: "chromium", chromiumRuntime: "aliasmode", username: "", password: "", twofa: "",
      proxy: { type, host: "127.0.0.1", port: String(proxy.port), user: ENGINE_QA_USER, pass: ENGINE_QA_PASS },
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      timezone: "Asia/Shanghai", timezoneManual: true, locale: "en-US", platformOs: "windows",
      screenWidth: 1600, screenHeight: 900, displayScale: 1, fingerprintSeed: 482731,
      hardware: { cores: Math.min(4, availableParallelism()) }, cookies: [], seeded: false,
    };
    store.upsertProfile(profile);
    const preferences = new AppSettingsStore(join(directory, "app-settings.json"));
    preferences.patch({ network: { checkLocalProxyBeforeLaunch: true } });
    const preflight = createLocalProxyPreflight(() => preferences.read());
    let preflightChecks = 0;
    const launcher = new Launcher({
      store, binaryPath: binary, expectedBinarySha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
      ensureAliasmodeChromium: async () => binary,
      chromiumRuntimeRoot: join(directory, "runtime"), dataRoot: join(directory, "profiles"),
      headless: true, portRange: { start: 24000, end: 24999 },
      // No remote geoIP request or automatic account navigation belongs to this fixture.
      lookupExitLocation: async () => null,
      checkLocalProxyBeforeLaunch: async endpoint => { preflightChecks++; await preflight(endpoint); },
      baseArgs: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
      log: line => logs.push(line), cdpReadyTimeoutMs: 30_000,
    });
    let result: Record<string, unknown> = { engine: "chromium", type, verifiedExecutableSha256: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 };
    try {
      const opened = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      const launch = store.getLaunch(profile.id)!;
      expect(launch.pid).toBeGreaterThan(0);
      expect(launch.userDataDir?.startsWith(directory)).toBe(true);
      expect(await launcher.certifiedActive(profile.id)).toBeTruthy();
      const saved = store.getProfile(profile.id)!;
      expect(saved.fpObserved?.capturedAt).toBeTruthy();
      expect(saved.fpObserved?.language).toBe("en-US");
      expect(saved.fpObserved?.timezone).toBe("Asia/Shanghai");
      expect(saved.fpObserved?.screen).toBe("1600*900");
      expect(saved.fpObserved?.hardwareConcurrency).toBe(profile.hardware!.cores);
      expect(saved.fpObserved?.canvas).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.fpObserved?.audio).toMatch(/^[0-9a-f]{64}$/);
      expect(store.getFingerprintSource(profile.id)).toEqual(createFingerprintSource(saved, launch));

      const { stdout, stderr, code } = await readPage(opened.ws, origin.port);
      if (code !== 0) throw new Error(`Isolated CDP page worker failed: ${stderr}`);
      const page = JSON.parse(stdout);
      expect(page.title).toBe("Maobu isolated engine QA");
      expect(page.text).toContain("本机真实内核验收");
      expect(page.roundtrip).toBe("中文隔离验收");
      expect(page.cookie).toContain("engine_qa=local_only");
      expect(page.language).toBe(saved.fpObserved!.language);
      expect(page.timezone).toBe(saved.fpObserved!.timezone);
      expect(page.screen).toBe(saved.fpObserved!.screen);
      expect(page.cores).toBe(saved.fpObserved!.hardwareConcurrency);
      expect(proxy.evidence.authenticated).toBeGreaterThan(0);
      expect(proxy.evidence.forwarded).toBeGreaterThanOrEqual(2);
      expect(proxy.evidence.rejectedAuth).toBe(0);
      expect(origin.requests.some(item => item.path === "/roundtrip" && item.body === "中文隔离验收")).toBe(true);
      expect(origin.requests.some(item => item.proxyAuthorization)).toBe(false);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(launch.pid)).toBe(false);
      expect(store.getLaunch(profile.id)).toBeNull();
      expect(await launcher.certifiedActive(profile.id)).toBeFalsy();
      // A new session must not adopt provenance from the old generation.
      const reopened = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      expect(reopened.ws).not.toBe(opened.ws);
      const second = store.getLaunch(profile.id)!;
      expect(store.getFingerprintSource(profile.id)).toEqual(createFingerprintSource(store.getProfile(profile.id)!, second));
      expect(store.getFingerprintSource(profile.id)?.launchDigest).not.toBe(createFingerprintSource(saved, launch).launchDigest);
      expect(store.getProfile(profile.id)?.fpObserved?.canvas).toBe(saved.fpObserved?.canvas);
      expect(store.getProfile(profile.id)?.fpObserved?.audio).toBe(saved.fpObserved?.audio);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(second.pid)).toBe(false);

      // Bad fixture credentials must fail closed, never silently use a direct route.
      const beforeDenied = origin.requests.length;
      store.upsertProfile({ ...store.getProfile(profile.id)!, proxy: { ...profile.proxy!, pass: "deliberately-wrong-fixture-password" } });
      const deniedLaunch = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLocalSession: false, restoreLastSession: false });
      const deniedPid = store.getLaunch(profile.id)!.pid;
      const denied = await readPage(deniedLaunch.ws, origin.port);
      expect(denied.code).not.toBe(0);
      expect(denied.stderr).toMatch(/page\.goto: net::ERR_/);
      expect(proxy.evidence.rejectedAuth).toBeGreaterThan(0);
      expect(origin.requests.length).toBe(beforeDenied);
      expect(await launcher.stop(profile.id)).toBe(true);
      expect(alive(deniedPid)).toBe(false);
      expect(preflightChecks).toBe(3);
      result = { ...result, outcome: "passed", localProxyStartupChecks: preflightChecks, page, observed: saved.fpObserved, captureSource: createFingerprintSource(saved, launch), proxy: proxy.evidence, originRequests: origin.requests, wrongCredentialsBlocked: true, closedPids: [launch.pid, second.pid, deniedPid], closed: true };
    } catch (error) {
      result = { ...result, outcome: "failed", error: error instanceof Error ? error.message : String(error), proxy: proxy.evidence, originRequests: origin.requests };
      throw error;
    } finally {
      // Production ownership gates remain enabled. Only this fixture's synthetic id can be stopped.
      await launcher.stop(profile.id).catch(error => logs.push(`cleanup: ${String(error)}`));
      await proxy.close(); await origin.close();
      writeFileSync(join(directory, "evidence.json"), JSON.stringify({ ...result, logs }, null, 2));
      store.close();
    }
  }, 180_000);
}
