import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { AppSettingsStore } from "./app-settings.ts";
import { handleFeatureSettingsRequest } from "./feature-settings.ts";
import { createLocalProxyPreflight } from "./local-proxy-preflight.ts";
import { statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { Launcher } from "./launcher.ts";
import { handleUiRequest } from "./ui.ts";
import { createServer } from "node:net";
const parent = resolve(import.meta.dir, "node_modules/.cache/local-proxy-settings-tests"), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(parent + sep) || !basename(root).startsWith("settings-")) throw new Error("Unsafe local proxy fixture cleanup"); rmSync(root, { recursive: true, force: true }); } });
test("settings HTTP saves only the network preference and the fresh-launch callback reads changes", async () => {
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "settings-")); roots.push(root);
  const paths = statePaths(root), settings = new AppSettingsStore(join(root, "app-settings.json"));
  const store = new Proxy({} as ProfileStore, { get() { throw new Error("Network preferences must not access profiles"); } });
  const request = (method = "GET", value?: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:50400/ui/api/settings", { method, headers: { "X-Maobu-Settings": "1", ...(method === "GET" ? {} : { "Content-Type": "application/json" }), ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(value) }) });
  const initial = await handleFeatureSettingsRequest(request(), store, { paths }); expect((await initial!.json()).settings.network).toEqual({ checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default", chromiumMemorySaver: false }); expect(existsSync(settings.path)).toBe(false);
  settings.patch({ updates: { repository: "maobu/browser" }, sync: { folder: join(root, "snapshots"), retainSnapshots: 12 } });
  const before = settings.read(); let probes = 0; const check = createLocalProxyPreflight(() => settings.read(), { probe: async () => { probes++; } });
  await check({ type: "http", host: "127.0.0.1", port: "7890" }); expect(probes).toBe(0);
  const saved = await handleFeatureSettingsRequest(request("PATCH", { network: { checkLocalProxyBeforeLaunch: true } }), store, { paths }); expect(saved!.status).toBe(200);
  expect(settings.read()).toEqual({ ...before, network: { checkLocalProxyBeforeLaunch: true, chromiumPreloading: "browser-default", chromiumMemorySaver: false } });
  await check({ type: "http", host: "127.0.0.1", port: "7890" }); expect(probes).toBe(1);
  const original = readFileSync(settings.path);
  for (const network of [null, { checkLocalProxyBeforeLaunch: "true" }, { checkLocalProxyBeforeLaunch: true, password: "private-settings-marker" }]) {
    const rejected = await handleFeatureSettingsRequest(request("PATCH", { network }), store, { paths }); expect(rejected!.status).toBe(400); expect(await rejected!.text()).not.toContain("private-settings-marker"); expect(readFileSync(settings.path)).toEqual(original);
  }
  const forbidden = await handleFeatureSettingsRequest(request("PATCH", { network: { checkLocalProxyBeforeLaunch: false } }, { Origin: "https://outside.invalid" }), store, { paths }); expect(forbidden!.status).toBe(403); expect(readFileSync(settings.path)).toEqual(original);
});

test("a real closed local port blocks the production launch path before runtime downloads", async () => {
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "settings-")); roots.push(root);
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const paths = statePaths(root), preferences = new AppSettingsStore(join(root, "app-settings.json")), store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", proxy: { type: "http", host: "127.0.0.1", port: String(port), user: "private-user", pass: "private-password" } }, () => false); store.upsertProfile(profile);
  preferences.patch({ network: { checkLocalProxyBeforeLaunch: true } }); let downloads = 0, lookups = 0, spawned = 0;
  const launcher = new Launcher({ store, dataRoot: paths.profiles, hostPlatform: "win32", hostArch: "x64",
    checkLocalProxyBeforeLaunch: createLocalProxyPreflight(() => preferences.read()),
    ensureAliasmodeChromium: async () => { downloads++; throw new Error("must not download"); },
    lookupExitLocation: async () => { lookups++; return null; }, spawn: () => { spawned++; throw new Error("must not spawn"); },
  });
  try {
    const response = await handleUiRequest(new Request(`http://127.0.0.1:50400/ui/api/profiles/${profile.id}/open`, { method: "POST" }), launcher, store, { paths });
    expect(response!.status).toBe(500); const data = await response!.json(); expect(data.error).toContain("configured local proxy");
    for (const secret of ["private-user", "private-password", root]) expect(JSON.stringify(data)).not.toContain(secret);
    expect(downloads).toBe(0); expect(lookups).toBe(0); expect(spawned).toBe(0); expect(store.getLaunch(profile.id)).toBeNull(); expect(existsSync(paths.profiles)).toBe(false);
  } finally { store.close(); }
});
