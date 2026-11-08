import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNewProfile } from "./create.ts";
import { Launcher } from "./launcher.ts";
import { diagnoseOverCDP } from "./diagnose.ts";
import { ProfileStore } from "./store.ts";
import type { ProxyType } from "./types.ts";

const binary = process.env.ALIASMODE_LIVE_BROWSER?.trim() ?? "";
const binarySha256 = process.env.ALIASMODE_LIVE_BROWSER_SHA256?.trim() ?? "";
const proxyHost = process.env.ALIASMODE_LIVE_PROXY_HOST?.trim() ?? "";
const proxyPort = process.env.ALIASMODE_LIVE_PROXY_PORT?.trim() ?? "";
const proxyUser = process.env.ALIASMODE_LIVE_PROXY_USER ?? "";
const proxyPass = process.env.ALIASMODE_LIVE_PROXY_PASS ?? "";
const expectedIp = process.env.ALIASMODE_LIVE_PROXY_IP?.trim() ?? "";
const headless = process.env.ALIASMODE_LIVE_HEADFUL !== "1";
const configured = Boolean(binary && binarySha256 && proxyHost && proxyPort && proxyUser && proxyPass && expectedIp);
const liveTest = configured ? test : test.skip;

function removeTestRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
}

async function launchThrough(type: ProxyType, pass = proxyPass): Promise<{
  ip: string;
  launcher: Launcher;
  store: ProfileStore;
  profileId: string;
  root: string;
}> {
  const root = join(tmpdir(), `aliasmode-live-proxy-${type}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const profile = buildNewProfile({
    name: `live-${type}`,
    proxy: { type, host: proxyHost, port: proxyPort, user: proxyUser, pass },
    screen: "1280x800",
  }, () => false);
  store.upsertProfile(profile);
  const launcher = new Launcher({
    store,
    binaryPath: binary,
    expectedBinarySha256: binarySha256,
    dataRoot: join(root, "profiles"),
    headless,
    portRange: { start: 9700, end: 9799 },
    baseArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 45_000,
  });
  try {
    const launched = await launcher.start(profile.id, [], { autoNavigate: false });
    const relayPort = store.getLaunch(profile.id)?.relayPort;
    expect(relayPort).toBeNumber();
    const report = await diagnoseOverCDP(launched.ws, profile, { collectLogin: false });
    if (!report.egress) throw new Error("browser egress diagnostics did not return an IP");
    return { ip: report.egress.ip, launcher, store, profileId: profile.id, root };
  } catch (error) {
    await launcher.stop(profile.id).catch(() => {});
    store.close();
    removeTestRoot(root);
    throw error;
  }
}

async function cleanup(run: Awaited<ReturnType<typeof launchThrough>>): Promise<void> {
  await run.launcher.stop(run.profileId).catch(() => {});
  run.store.close();
  rmSync(run.root, { recursive: true, force: true });
}

async function expectWrongCredentialsToFail(type: "http" | "socks5"): Promise<void> {
  const root = join(tmpdir(), `aliasmode-live-proxy-wrong-${type}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const profile = buildNewProfile({
    name: `live-${type}-wrong-password`,
    proxy: { type, host: proxyHost, port: proxyPort, user: proxyUser, pass: `${proxyPass}-wrong` },
    screen: "1280x800",
  }, () => false);
  store.upsertProfile(profile);
  const launcher = new Launcher({
    store,
    binaryPath: binary,
    expectedBinarySha256: binarySha256,
    dataRoot: join(root, "profiles"),
    headless,
    portRange: { start: 9700, end: 9799 },
    baseArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 45_000,
  });
  try {
    const launched = await launcher.start(profile.id, [], { autoNavigate: false });
    await expect(diagnoseOverCDP(launched.ws, profile, { timeoutMs: 10_000, collectLogin: false }))
      .resolves.toMatchObject({ egress: null });
  } finally {
    await launcher.stop(profile.id).catch(() => {});
    store.close();
    removeTestRoot(root);
  }
}

liveTest("real AliasMode launch authenticates and browses through SOCKS5", async () => {
  const run = await launchThrough("socks5");
  try {
    expect(run.ip).toBe(expectedIp);
  } finally {
    await cleanup(run);
  }
}, 120_000);

liveTest("real AliasMode launch authenticates and browses through HTTP", async () => {
  const run = await launchThrough("http");
  try {
    expect(run.ip).toBe(expectedIp);
  } finally {
    await cleanup(run);
  }
}, 120_000);

liveTest("wrong SOCKS5 credentials block browser egress", async () => {
  await expectWrongCredentialsToFail("socks5");
}, 120_000);

liveTest("wrong HTTP credentials block browser egress", async () => {
  await expectWrongCredentialsToFail("http");
}, 120_000);
