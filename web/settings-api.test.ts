import { afterEach, expect, test } from "bun:test";
import * as api from "./settings-api.ts";
import { defaultAppSettings } from "../app-settings.ts";
import { getIntegrationInfo } from "../agent/integration-info.ts";
import type { LocalProxyDiscoveryReport } from "../network-diagnostics.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function response(value: unknown, status = 200) { globalThis.fetch = (async () => Response.json(value, { status })) as unknown as typeof fetch; }

test("settings calls send same-origin credentials and the local request header", async () => {
  const seen: { path: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = (async (path: unknown, init?: RequestInit) => { seen.push({ path, init }); return Response.json({ ok: true, settings: defaultAppSettings() }); }) as unknown as typeof fetch;
  await api.fetchSettings(); await api.patchSettings({ updates: { channel: "beta" } });
  expect(seen[0]?.path).toBe("/ui/api/settings"); expect(seen[0]?.init?.credentials).toBe("same-origin");
  expect(new Headers(seen[0]?.init?.headers).get("X-Maobu-Settings")).toBe("1");
  expect(seen[1]?.init?.method).toBe("PATCH"); expect(JSON.parse(String(seen[1]?.init?.body))).toEqual({ updates: { channel: "beta" } });
});
test("incomplete success responses fail explicitly instead of crashing panels or enabling actions", async () => {
  response({ ok: true });
  for (const call of [api.fetchSettings, () => api.patchSettings({}), api.fetchLastUpdate, api.checkForUpdate, api.discoverProxies,
    api.fetchFingerprintReports, () => api.measureFingerprint("profile01"), api.fetchIntegrationInfo, api.probeIntegration,
    api.fetchSyncFiles, () => api.createSyncFile("private-test-password"), () => api.previewSyncFile("file", "private-test-password"), () => api.importSyncFile("file", "private-test-password", "a".repeat(64))]) {
    await expect(call()).rejects.toThrow("Settings response was incomplete");
  }
});
test("invalid response envelopes and non-JSON bodies have useful fixed failures", async () => {
  for (const value of [null, [], 123, "bad"]) { response(value); await expect(api.fetchSettings()).rejects.toThrow("invalid response"); }
  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as unknown as typeof fetch;
  await expect(api.fetchSettings()).rejects.toThrow("invalid response");
  response({ ok: false, error: "Local service unavailable" }, 503); await expect(api.fetchSettings()).rejects.toThrow("Local service unavailable");
});
test("configuration and fingerprint report schemas are checked before rendering", async () => {
  response({ ok: true, settings: { ...defaultAppSettings(), sync: { enabled: true, folder: "/tmp", retainSnapshots: 0 } } });
  await expect(api.fetchSettings()).rejects.toThrow("incomplete");
  response({ ok: true, reports: [{ profileId: "p1", name: "Research", status: "consistent", summary: { pass: 1 }, checks: [] }] });
  await expect(api.fetchFingerprintReports()).rejects.toThrow("incomplete");
  response({ ok: true, reports: [] }); expect(await api.fetchFingerprintReports()).toEqual([]);
});
test("release results accept no check yet and reject executable or foreign web links", async () => {
  response({ ok: true, update: null }); expect(await api.fetchLastUpdate()).toBe(null);
  const update = { status: "available", currentVersion: "0.1.0", repository: "owner/repo", channel: "stable", checkedAt: 100, cached: false,
    latest: { version: "0.2.0", tag: "v0.2.0", name: "Update", notes: "notes", publishedAt: null, url: "https://github.com/owner/repo/releases/tag/v0.2.0", assets: [] } };
  response({ ok: true, update }); expect((await api.fetchLastUpdate())?.latest?.version).toBe("0.2.0");
  for (const url of ["javascript:alert(1)", "https://outside.invalid/release", "https://user@github.com/release"]) {
    response({ ok: true, update: { ...update, latest: { ...update.latest, url } } }); await expect(api.fetchLastUpdate()).rejects.toThrow("incomplete");
  }
});
test("integration resource results and loopback discovery validate their nested lists", async () => {
  const integration = getIntegrationInfo(); response({ ok: true, integration }); expect((await api.fetchIntegrationInfo()).transport).toBe("stdio");
  response({ ok: true, integration: { ...integration, capabilities: [{}] } }); await expect(api.fetchIntegrationInfo()).rejects.toThrow("incomplete");
  response({ ok: true, discovery: { checkedAt: "2026-11-09T00:00:00Z", host: "127.0.0.1", results: [{ host: "127.0.0.1", port: 7890, status: "listening", socks5: "available", latencyMs: 0, suggestions: [{ type: "socks5", evidence: "handshake" }] }] } });
  expect((await api.discoverProxies()).results[0]?.port).toBe(7890);
});

test("custom discovery sends the selected IPv6 target and rejects substituted addresses or ports", async () => {
  const options = { host: "::1" as const, ports: [11555, 11556] };
  const row: LocalProxyDiscoveryReport["results"][number] = { host: "::1", port: 11555, status: "listening", socks5: "available", latencyMs: 0, suggestions: [{ type: "socks5", evidence: "handshake" }] };
  const discovery: LocalProxyDiscoveryReport = { host: "::1", checkedAt: "2026-11-09T00:00:00Z", results: [row, { ...row, port: 11556 }] };
  globalThis.fetch = (async (path: unknown, init?: RequestInit) => {
    expect(path).toBe("/ui/api/settings/network/discover");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(options);
    return Response.json({ ok: true, discovery });
  }) as unknown as typeof fetch;
  expect(await api.discoverProxies(options)).toEqual(discovery);
  for (const invalid of [
    { ...discovery, host: "127.0.0.1" },
    { ...discovery, results: [row, { ...row, port: 11556, host: "outside.invalid" }] },
    { ...discovery, results: [row, { ...row, port: 11557 }] },
    { ...discovery, results: [row, row] },
    { ...discovery, results: [row] },
  ]) {
    response({ ok: true, discovery: invalid });
    await expect(api.discoverProxies(options)).rejects.toThrow("incomplete");
  }
});

test("old settings responses gain a disabled network preference and new network fields stay strict", async () => {
  const { network: _network, ...legacy } = defaultAppSettings();
  response({ ok: true, settings: legacy }); expect((await api.fetchSettings()).network).toEqual({ checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false });
  response({ ok: true, settings: legacy }); expect((await api.patchSettings({ network: { checkLocalProxyBeforeLaunch: true } })).network).toEqual({ checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false });
  for (const network of [null, {}, { checkLocalProxyBeforeLaunch: "true" }, { checkLocalProxyBeforeLaunch: true, password: "forbidden" }]) {
    response({ ok: true, settings: { ...legacy, network } }); await expect(api.fetchSettings()).rejects.toThrow("incomplete");
  }
  response({ ok: true, settings: { ...legacy, network: { checkLocalProxyBeforeLaunch: true } } }); expect((await api.fetchSettings()).network.checkLocalProxyBeforeLaunch).toBe(true);
});

test("page preloading responses accept only the two supported intent values and normalize old servers", async () => {
  const settings = defaultAppSettings();
  for (const chromiumPreloading of ["browser-default", "disabled"] as const) {
    response({ ok: true, settings: { ...settings, network: { checkLocalProxyBeforeLaunch: true, chromiumPreloading } } });
    expect((await api.fetchSettings()).network).toEqual({ checkLocalProxyBeforeLaunch: true, chromiumPreloading, chromiumMemorySaver: false });
  }
  for (const chromiumPreloading of [null, 2, "off", true, {}, []]) {
    response({ ok: true, settings: { ...settings, network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading } } });
    await expect(api.fetchSettings()).rejects.toThrow("incomplete");
  }
  response({ ok: true, settings: { ...settings, network: { checkLocalProxyBeforeLaunch: true } } });
  expect((await api.fetchSettings()).network.chromiumPreloading).toBe("browser-default");
});

test("fingerprint DTOs accept legacy checks and validate optional messages and projected evidence", async () => {
  const check = { id: "hardware_configuration", label: "Measured processors and configuration", status: "warn", detail: "The measured processor count differs from the effective launch policy." };
  const report = { profileId: "profile1", name: "Research", status: "review", summary: { pass: 0, warn: 1, fail: 0, unknown: 0 }, checks: [check] };
  response({ ok: true, reports: [report] }); expect((await api.fetchFingerprintReports())[0]?.checks[0]?.detail).toBe(check.detail);
  const evidence = { kind: "processors" as const, expected: 8, actual: 32, saved: 32, hostAvailable: 8 };
  response({ ok: true, reports: [{ ...report, checks: [{ ...check, evidence }] }] }); expect((await api.fetchFingerprintReports())[0]?.checks[0]?.evidence).toEqual(evidence);
  for (const extra of [{ detailMessage: { kind: "probe-errors", count: "PRIVATE" } }, { evidence: { ...evidence, rawSample: "PRIVATE" } }, { evidence: { kind: "locale", expected: "en-US", actual: "en-US-x-secret" } }]) {
    response({ ok: true, reports: [{ ...report, checks: [{ ...check, ...extra }] }] }); await expect(api.fetchFingerprintReports()).rejects.toThrow("incomplete");
  }
});
test("sync previews reject impossible counts and unknown file formats before enabling import", async () => {
  const preview = { profileCount: 1, sessionCount: 0, newCount: 1, conflictCount: 0, profiles: [{ id: "p1", name: "Research", group: "", conflict: false, hasSession: false }] };
  response({ ok: true, preview, previewHash: "a".repeat(64) }); expect((await api.previewSyncFile("file", "password-for-test")).preview.newCount).toBe(1);
  response({ ok: true, preview: { ...preview, conflictCount: 1 }, previewHash: "a".repeat(64) }); await expect(api.previewSyncFile("file", "password-for-test")).rejects.toThrow("incomplete");
  response({ ok: true, files: [{ fileName: "../../outside", bytes: 123, createdAt: 0, modifiedAt: 0 }] }); await expect(api.fetchSyncFiles()).rejects.toThrow("incomplete");
});

test("network resource settings validate firefoxMemorySaver, dataSaver, and batchLaunchMemoryGuard strictly", async () => {
  api.resetSharedSettingsCache();
  const base = defaultAppSettings();
  const extendedNetwork = {
    checkLocalProxyBeforeLaunch: false,
    chromiumPreloading: "browser-default" as const,
    chromiumMemorySaver: true,
    firefoxMemorySaver: true,
    dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: true },
    batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 88, minAvailableMb: 1536 },
  };
  response({ ok: true, settings: { ...base, network: extendedNetwork } });
  expect((await api.fetchSettings()).network).toEqual(extendedNetwork);

  // Align strictly with backend app-settings.ts bounds: soft 30..95, hard 40..99, soft < hard, minAvailableMb 128..65536
  for (const edgeValidGuard of [
    { enabled: true, softWatermarkPercent: 30, hardWatermarkPercent: 40, minAvailableMb: 128 },
    { enabled: true, softWatermarkPercent: 95, hardWatermarkPercent: 99, minAvailableMb: 65536 },
  ]) {
    const edgeNetwork = { ...extendedNetwork, batchLaunchMemoryGuard: edgeValidGuard };
    response({ ok: true, settings: { ...base, network: edgeNetwork } });
    expect((await api.fetchSettings()).network).toEqual(edgeNetwork);
  }

  for (const badNetwork of [
    { ...extendedNetwork, firefoxMemorySaver: "yes" },
    { ...extendedNetwork, dataSaver: { enabled: true, blockImages: true, blockMedia: false, blockFonts: false, extra: true } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 29, hardWatermarkPercent: 40, minAvailableMb: 1536 } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 75, minAvailableMb: 1536 } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 90, hardWatermarkPercent: 80, minAvailableMb: 1536 } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 100, minAvailableMb: 1536 } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 88, minAvailableMb: 127 } },
    { ...extendedNetwork, batchLaunchMemoryGuard: { enabled: true, softWatermarkPercent: 75, hardWatermarkPercent: 88, minAvailableMb: 65537 } },
  ]) {
    response({ ok: true, settings: { ...base, network: badNetwork } });
    await expect(api.fetchSettings()).rejects.toThrow("incomplete");
  }
});

test("fetchSettingsShared reuses an in-flight or just-resolved read without issuing extra requests", async () => {
  api.resetSharedSettingsCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ ok: true, settings: defaultAppSettings() });
  }) as unknown as typeof fetch;

  const [first, shared] = await Promise.all([api.fetchSettings(), api.fetchSettingsShared()]);
  expect(calls).toBe(1);
  expect(shared).toEqual(first);
  const cached = await api.fetchSettingsShared();
  expect(calls).toBe(1);
  expect(cached).toEqual(first);
});
