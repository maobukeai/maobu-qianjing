import { expect, test } from "bun:test";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAliasModeMcp } from "./mcp-host.mjs";
import { AGENT_CONTROL_PROTOCOL, AgentControlSession, type AgentControlDeps } from "../agent-control.ts";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { buildStoredFingerprintReport } from "../fingerprint-report.ts";
import { createFingerprintSource } from "../fingerprint-source.ts";
import { launchPersona } from "../launcher.ts";
import type { LaunchInfo } from "../types.ts";

async function localSession() {
  const store = new ProfileStore(":memory:");
  const generated = buildNewProfile({ name: "MCP offline review", engine: "chromium", chromiumRuntime: "aliasmode" }, () => false);
  const profile = { ...generated, id: "mcp-review-1", username: "PRIVATE_ACCOUNT", password: "PRIVATE_PASSWORD", twofa: "PRIVATE_2FA",
    proxy: { type: "http" as const, host: "private-proxy.test", port: "8080", user: "PRIVATE_PROXY_USER", pass: "PRIVATE_PROXY_PASS" } };
  store.upsertProfile(profile);
  const launch: LaunchInfo = { profileId: profile.id, pid: 123, debugPort: 9333, ws: "ws://127.0.0.1:9333/PRIVATE_WS", startedAt: Date.now(), persona: launchPersona(profile) };
  store.recordLaunch(launch);
  const observed = { ua: profile.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0", platform: "Win32", canvas: "PRIVATE_RAW_CANVAS", audio: "PRIVATE_RAW_AUDIO", capturedAt: new Date().toISOString(), errors: JSON.stringify({ canvas: "PRIVATE_RAW_ERROR" }) };
  const source = createFingerprintSource(profile, launch);
  store.saveObservedFingerprint(profile.id, observed, null, store.getProfileIncarnation(profile.id)!, source);
  const forbidden: string[] = [];
  const deny = new Proxy({}, { get: (_object, key) => () => { forbidden.push(String(key)); throw new Error("read-only tools cannot drive a browser"); } });
  const session = new AgentControlSession({ store, launcher: deny, admission: deny } as unknown as AgentControlDeps);
  let id = 0;
  const rpc: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = {
    async call(method: string, params: Record<string, unknown> = {}) {
      rpc.push({ method, params });
      const result = await session.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: ++id, method, params }));
      if (!result.ok) throw new Error(result.error!.message);
      return result.result;
    },
    close() {},
  };
  const playwrightEvents: string[] = [];
  const playwright = {
    async initialize() {}, listTools: () => [],
    async attach() { playwrightEvents.push("attach"); throw new Error("must not attach"); },
    async callTool() { playwrightEvents.push("callTool"); throw new Error("must not call a browser tool"); },
    async detach() { playwrightEvents.push("detach"); },
  };
  const host = await createAliasModeMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "readonly-integration", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, host, store, profile, launch, source, rpc, forbidden, playwrightEvents,
    async close() { await client.close(); await host.close(); await session.disconnect(); store.close(); } };
}

test("actual MCP default catalog exposes only the three read-only tools without selecting a browser", async () => {
  const h = await localSession();
  try {
    const tools = (await h.client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(["aliasmode_profiles_list", "aliasmode_fingerprint_review", "aliasmode_network_discover"]);
    for (const name of ["aliasmode_fingerprint_review", "aliasmode_network_discover"]) {
      const tool = tools.find(item => item.name === name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.find(item => item.name === "aliasmode_fingerprint_review")!.inputSchema).toMatchObject({ required: ["profileId"], properties: { profileId: { minLength: 1, maxLength: 128 } } });
    expect(tools.find(item => item.name === "aliasmode_network_discover")!.inputSchema).toMatchObject({ properties: { host: { enum: ["127.0.0.1", "::1"] }, ports: { maxItems: 16, uniqueItems: true } } });
    expect(h.rpc).toEqual([]);
    expect(h.forbidden).toEqual([]);
    expect(h.playwrightEvents).toEqual([]);
  } finally { await h.close(); }
});

test("MCP fingerprint review crosses the real agent session/store boundary without browser or profile mutations", async () => {
  const h = await localSession();
  try {
    const before = JSON.stringify({ profile: h.store.getProfile(h.profile.id), launch: h.store.getLaunch(h.profile.id), source: h.store.getFingerprintSource(h.profile.id) });
    const result = await h.client.callTool({ name: "aliasmode_fingerprint_review", arguments: { profileId: h.profile.id } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(buildStoredFingerprintReport(h.store.getProfile(h.profile.id)!, { launch: h.launch, captureSource: h.source }));
    expect(result.structuredContent).toMatchObject({ launchRecordPresent: true, liveness: "not-checked" });
    expect(result.structuredContent).not.toHaveProperty("running");
    expect((result.structuredContent as any).report).not.toHaveProperty("running");
    expect(JSON.stringify({ profile: h.store.getProfile(h.profile.id), launch: h.store.getLaunch(h.profile.id), source: h.store.getFingerprintSource(h.profile.id) })).toBe(before);
    const text = JSON.stringify(result);
    for (const secret of ["PRIVATE_ACCOUNT", "PRIVATE_PASSWORD", "PRIVATE_2FA", "PRIVATE_PROXY_USER", "PRIVATE_PROXY_PASS", "PRIVATE_WS", "PRIVATE_RAW_CANVAS", "PRIVATE_RAW_AUDIO", "PRIVATE_RAW_ERROR", "private-proxy.test", h.source.configurationDigest, h.source.launchDigest!]) expect(text).not.toContain(secret);
    expect(h.rpc).toEqual([{ method: "fingerprints.review", params: { profileId: h.profile.id } }]);
    expect(h.forbidden).toEqual([]);
    expect(h.playwrightEvents).toEqual([]);
    const missing = await h.client.callTool({ name: "aliasmode_fingerprint_review", arguments: { profileId: "missing-profile" } });
    expect(missing.isError).toBe(true);
    expect(h.forbidden).toEqual([]);
  } finally { await h.close(); }
});

test("MCP host rejects malformed read-only tool arguments before sending an RPC", async () => {
  const h = await localSession();
  try {
    const badProfiles = [{}, { profileId: null }, { profileId: 123 }, { profileId: "" }, { profileId: " " }, { profileId: "x".repeat(129) }, { profileId: "CON" }, { profileId: "a/b" }, { profileId: h.profile.id, measure: true }];
    for (const args of badProfiles) expect((await h.client.callTool({ name: "aliasmode_fingerprint_review", arguments: args })).isError).toBe(true);
    const badNetworks = [{ host: "external.test" }, { host: "localhost" }, { host: "127.1" }, { host: null }, { ports: [] }, { ports: [0] }, { ports: [65536] }, { ports: [1.5] }, { ports: ["7890"] }, { ports: [null] }, { ports: [7890, 7890] }, { ports: Array.from({ length: 17 }, (_, i) => i + 1) }, { timeoutMs: 3000 }, { ports: [7890], destination: "PRIVATE_TARGET" }];
    for (const args of badNetworks) {
      const result = await h.client.callTool({ name: "aliasmode_network_discover", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TARGET");
    }
    expect(h.rpc).toEqual([]);
    expect(h.forbidden).toEqual([]);
    expect(h.playwrightEvents).toEqual([]);
  } finally { await h.close(); }
});

test("actual MCP network discovery sends only local SOCKS method negotiation without CONNECT or credentials", async () => {
  const received: Buffer[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.on("data", data => { received.push(typeof data === "string" ? Buffer.from(data) : data); socket.write(Buffer.from([5, 2])); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  const h = await localSession();
  try {
    const result = await h.client.callTool({ name: "aliasmode_network_discover", arguments: { host: "127.0.0.1", ports: [port] } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ discovery: { host: "127.0.0.1", results: [{ host: "127.0.0.1", port, status: "listening", socks5: "authentication_required", suggestions: [{ type: "socks5", evidence: "handshake" }] }] } });
    expect(Buffer.concat(received)).toEqual(Buffer.from([5, 2, 0, 2]));
    expect(h.rpc).toEqual([{ method: "network.discover", params: { host: "127.0.0.1", ports: [port] } }]);
    expect(h.forbidden).toEqual([]);
    expect(h.playwrightEvents).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('"working"');
  } finally {
    await h.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
