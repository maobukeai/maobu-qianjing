/** Real closed-loopback refusal through the existing GUI, MCP and AdsPower facades. */
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentControlSession, AGENT_CONTROL_PROTOCOL } from "./agent-control.ts";
import { createAliasModeMcp } from "./agent/mcp-host.mjs";
import { defaultAppSettings } from "./app-settings.ts";
import { buildNewProfile } from "./create.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { createLocalProxyPreflight } from "./local-proxy-preflight.ts";
import { Launcher } from "./launcher.ts";
import { statePaths } from "./paths.ts";
import { handleRequest } from "./server.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

const guidance = "The configured local proxy is not listening or did not respond in time. Open your desktop proxy client, enable its local port, then retry.";

test("real closed local proxy returns the same safe action guidance through GUI, MCP and AdsPower without a spawn", async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const paths = statePaths(resolve(import.meta.dir, `node_modules/.cache/local-proxy-guidance-${crypto.randomUUID()}`));
  const store = new ProfileStore(":memory:");
  const profile = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows",
    proxy: { type: "http", host: "127.0.0.1", port: String(port), user: "PRIVATE_GUIDANCE_USER", pass: "PRIVATE_GUIDANCE_PASSWORD" } }, () => false);
  store.upsertProfile(profile);
  const settings = { ...defaultAppSettings(), network: { checkLocalProxyBeforeLaunch: true } };
  let downloads = 0, lookups = 0, spawns = 0;
  const launcher = new Launcher({ store, dataRoot: paths.profiles, hostPlatform: "win32", hostArch: "x64",
    checkLocalProxyBeforeLaunch: createLocalProxyPreflight(() => settings),
    ensureAliasmodeChromium: async () => { downloads++; throw new Error("PRIVATE_DOWNLOAD_CAUSE"); },
    lookupExitLocation: async () => { lookups++; return null; },
    spawn: () => { spawns++; throw new Error("PRIVATE_SPAWN_CAUSE"); },
  });
  const session = new AgentControlSession({ store, launcher, admission: new LifecycleAdmissionController() });
  let requestId = 0, browserAttachments = 0;
  const runtime = {
    async call(method: string, params: Record<string, unknown> = {}) {
      const result = await session.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: ++requestId, method, params }));
      if (!result.ok) throw new Error(result.error!.message);
      return result.result;
    }, close() {},
  };
  const host = await createAliasModeMcp({ scope: "browser", discovered: { client: runtime }, playwright: {
    async initialize() {}, listTools: () => [], async attach() { browserAttachments++; }, async detach() {}, async callTool() { browserAttachments++; },
  } });
  const client = new Client({ name: "launch-guidance-fixture", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const gui = await handleUiRequest(new Request(`http://127.0.0.1:50400/ui/api/profiles/${profile.id}/open`, { method: "POST" }), launcher, store, { paths });
    expect(gui!.status).toBe(500);
    const guiBody = await gui!.json();
    expect(guiBody).toEqual({ ok: false, error: guidance });
    const rpc = await session.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: ++requestId, method: "browser.open", params: { profileId: profile.id } }));
    expect(rpc).toMatchObject({ ok: false, error: { code: "browser_launch_failed", message: guidance } });
    const mcp = await client.callTool({ name: "aliasmode_browser_open", arguments: { profileId: profile.id } });
    expect(mcp).toMatchObject({ isError: true, content: [{ type: "text", text: guidance }] });
    const ads = await handleRequest(new Request(`http://127.0.0.1:50400/api/v1/browser/start?user_id=${profile.id}`), launcher, store);
    expect(ads.status).toBe(200);
    const adsBody = await ads.json();
    expect(adsBody).toEqual({ code: -1, msg: guidance, data: {} });
    const output = JSON.stringify({ guiBody, rpc, mcp, adsBody });
    for (const secret of ["PRIVATE_GUIDANCE_USER", "PRIVATE_GUIDANCE_PASSWORD", "PRIVATE_DOWNLOAD_CAUSE", "PRIVATE_SPAWN_CAUSE", paths.root]) expect(output).not.toContain(secret);
    expect({ downloads, lookups, spawns, browserAttachments }).toEqual({ downloads: 0, lookups: 0, spawns: 0, browserAttachments: 0 });
    expect(store.getLaunch(profile.id)).toBeNull();
    expect(existsSync(paths.root)).toBe(false);
  } finally { await client.close(); await host.close(); await session.disconnect(); store.close(); }
});
