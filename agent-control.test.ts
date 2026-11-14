import { expect, test } from "bun:test";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PROTOCOL,
  AgentControlHub,
  AgentControlSession,
  parseAgentControlRequest,
  validAgentAuthorization,
} from "./agent-control.ts";
import { buildNewProfile } from "./create.ts";
import type { AgentControlDeps } from "./agent-control.ts";
import { BrowserLaunchError } from "./launcher.ts";

function wire(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id, method, params });
}

test("agent launch errors prefer fixed preflight guidance while preserving codes and other launch failures", async () => {
  for (const [error, code, message] of [
    [new BrowserLaunchError("preflight", "local_proxy_unavailable"), "browser_launch_failed", "The configured local proxy is not listening or did not respond in time. Open your desktop proxy client, enable its local port, then retry."],
    [new BrowserLaunchError("mode_conflict"), "mode_conflict", "browser_launch/mode_conflict (failed)"],
    [new BrowserLaunchError("cdp_readiness"), "browser_launch_failed", "browser_launch/cdp_readiness (failed)"],
    [new BrowserLaunchError("preflight"), "browser_launch_failed", "browser_launch/preflight (failed)"],
  ] as const) {
    Object.assign(error, { cause: new Error("PRIVATE_CAUSE_PASSWORD") });
    const h = harness();
    const session = new AgentControlSession({ ...h.deps, launcher: { ...h.deps.launcher, start: async () => { throw error; } } as any });
    const response = await session.enqueue(wire("browser.open", { profileId: "profile1" }, 7));
    expect(response).toEqual({ protocol: AGENT_CONTROL_PROTOCOL, id: 7, ok: false, error: { code, message } });
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CAUSE_PASSWORD");
    await session.disconnect();
  }
});

test("read-only fingerprint RPC rejects invalid identifiers and extras before reading any profile", async () => {
  const calls: string[] = [];
  const deny = (name: string) => new Proxy({}, { get: (_target, key) => () => { calls.push(`${name}.${String(key)}`); throw new Error("unexpected IO"); } });
  const session = new AgentControlSession({ store: deny("store"), launcher: deny("launcher"), admission: deny("admission") } as unknown as AgentControlDeps);
  for (const params of [
    {}, { profileId: null }, { profileId: 1 }, { profileId: true }, { profileId: {} }, { profileId: [] },
    { profileId: "" }, { profileId: " " }, { profileId: " profile1" }, { profileId: "profile1 " },
    { profileId: "x".repeat(129) }, { profileId: "../profile" }, { profileId: "a/b" }, { profileId: "CON" },
    { profileId: "COM1" }, { profileId: "profile1", measure: true }, { profileId: "profile1", extra: "PRIVATE_INPUT" },
  ]) {
    const result = await session.enqueue(wire("fingerprints.review", params));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INPUT");
  }
  expect(calls).toEqual([]);
  await session.disconnect();
  expect(calls).toEqual([]);
});

test("read-only profile inventory reports stored state without reconciliation or control endpoints", async () => {
  const profile = { id: "fixture", name: "Synthetic profile", group: "QA", platform: "", tags: [], username: "PRIVATE_FIXTURE_USER", password: "PRIVATE_FIXTURE_PASSWORD" };
  const session = new AgentControlSession({
    store: { listProfiles: () => [profile], getLaunch: () => ({ debugPort: 9333, ws: "PRIVATE_FIXTURE_ENDPOINT", headless: true }) },
    launcher: new Proxy({}, { get: () => { throw new Error("inventory must not use the launcher"); } }),
  } as unknown as AgentControlDeps);
  try {
    const result = await session.enqueue(wire("profiles.inventory"));
    expect(result).toMatchObject({ ok: true, result: { liveness: "not-checked", profiles: [
      { id: "fixture", name: "Synthetic profile", group: "QA", platform: "", tags: [], running: true },
    ] } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FIXTURE|9333|headless/);
    expect(await session.enqueue(wire("profiles.inventory", { force: true }))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  } finally { await session.disconnect(); }
});

test("read-only fingerprint RPC accepts the authority's full 128-character ID and reports missing profiles without probing", async () => {
  const reads: string[] = [];
  const session = new AgentControlSession({
    store: { getProfile: (id: string) => { reads.push(id); return null; } },
    launcher: new Proxy({}, { get: () => { throw new Error("browser must not be accessed"); } }),
  } as unknown as AgentControlDeps);
  const id = "A" + "x".repeat(127);
  expect(await session.enqueue(wire("fingerprints.review", { profileId: id }))).toMatchObject({ ok: false, error: { code: "profile_not_found" } });
  expect(reads).toEqual([id]);
  await session.disconnect();
});

test("network discovery RPC validates the complete bounded request before any IO", async () => {
  const probes: unknown[] = [];
  const session = new AgentControlSession({ discoverLocalProxies: async (options: unknown) => { probes.push(options); throw new Error("must not probe"); } } as unknown as AgentControlDeps);
  for (const params of [
    { host: "localhost" }, { host: "8.8.8.8" }, { host: "127.1" }, { host: "[::1]" }, { host: null },
    { ports: [] }, { ports: [0] }, { ports: [65536] }, { ports: [1.5] }, { ports: ["7890"] },
    { ports: [true] }, { ports: [null] }, { ports: "7890" }, { ports: {} }, { ports: null },
    { ports: [7890, 7890] }, { ports: Array.from({ length: 17 }, (_, index) => index + 1) },
    { timeoutMs: 1 }, { host: "127.0.0.1", ports: [7890], target: "PRIVATE_EXTERNAL_TARGET" },
  ]) {
    const result = await session.enqueue(wire("network.discover", params));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_EXTERNAL_TARGET");
  }
  expect(probes).toEqual([]);
  await session.disconnect();
});

test("network discovery RPC forwards only validated loopback options and leaves the fixed probe timeout intact", async () => {
  const probes: unknown[] = [];
  const report = { checkedAt: "2026-11-09T00:00:00Z", host: "127.0.0.1" as const, results: [] };
  const session = new AgentControlSession({ discoverLocalProxies: async (options: unknown) => { probes.push(options); return report; } } as unknown as AgentControlDeps);
  for (const params of [{}, { host: "::1", ports: [1, 65535] }, { host: "127.0.0.1", ports: Array.from({ length: 16 }, (_, index) => index + 1) }]) {
    expect(await session.enqueue(wire("network.discover", params))).toMatchObject({ ok: true, result: { discovery: report } });
  }
  expect(probes).toEqual([{}, { host: "::1", ports: [1, 65535] }, { host: "127.0.0.1", ports: Array.from({ length: 16 }, (_, index) => index + 1) }]);
  await session.disconnect();
});

function harness(options: {
  active?: boolean;
  firefox?: boolean;
  stopResult?: boolean;
  temporary?: boolean;
} = {}) {
  const events: string[] = [];
  let launch = options.active
    ? {
        profileId: "profile1",
        pid: 11,
        debugPort: 9333,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        startedAt: 1,
        headless: true,
        ...(options.firefox ? {
          engine: "firefox" as const,
          firefoxOwner: { endpoint: "http://127.0.0.1:9444/", token: "private-token", pid: 12, browserPid: 13, generation: "generation" },
        } : {}),
      }
    : null;
  let profileExists = true;
  let temporary = options.temporary ?? false;
  let cacheClearing = false;
  const store = {
    getLaunch: (id: string) => id === "profile1" ? launch : null,
    listAgentTemporary: () => temporary ? ["profile1"] : [],
    clearAgentTemporary: (id: string) => {
      events.push(`clear-temp:${id}`);
      temporary = false;
    },
    getProfile: (id: string) => id === "profile1" && profileExists ? { id } : null,
    deleteProfile: (id: string) => {
      events.push(`delete:${id}`);
      profileExists = false;
      temporary = false;
      return true;
    },
  };
  const launcher = {
    certifiedActive: async () => options.active ?? false,
    start: async (_id: string, _urls: string[], open: { headless?: boolean }) => {
      events.push(`start:${open.headless ?? false}`);
      launch = {
        profileId: "profile1",
        pid: 12,
        debugPort: 9444,
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        startedAt: 2,
        headless: open.headless,
      } as typeof launch;
      return {
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        port: 9444,
      };
    },
    stop: async (id: string) => {
      events.push(`stop:${id}`);
      if (options.stopResult === false) return false;
      launch = null;
      cacheClearing = true;
      return true;
    },
    // The post-stop cache delete blocks deletion until it ends.
    cacheCleanupSettled: async (id: string) => { events.push(`cache-settled:${id}`); cacheClearing = false; },
    profileDeletionBlocked: () => cacheClearing,
    removeUserDataDir: (id: string) => events.push(`remove-data:${id}`),
  };
  const admission = {
    run: async (_operation: unknown, fn: () => Promise<unknown>) => await fn(),
  };
  const deps = {
    launcher: launcher as any,
    store: store as any,
    admission: admission as any,
  };
  return {
    deps,
    events,
    session: new AgentControlSession(deps),
    temporary: () => temporary,
    profileExists: () => profileExists,
    restoreTemporaryProfile: () => {
      temporary = true;
      profileExists = true;
    },
  };
}

test("agent protocol validates message shape, size, and authorization", () => {
  expect(parseAgentControlRequest(wire("profiles.list", {}, 7))).toEqual({
    protocol: AGENT_CONTROL_PROTOCOL,
    id: 7,
    method: "profiles.list",
    params: {},
  });
  expect(() => parseAgentControlRequest("{}"))
    .toThrow("invalid protocol shape");
  expect(() => parseAgentControlRequest(new Uint8Array(AGENT_CONTROL_MAX_MESSAGE_BYTES + 1)))
    .toThrow("request size is invalid");

  const nonce = "a".repeat(64);
  expect(validAgentAuthorization(`Bearer ${nonce}`, nonce)).toBe(true);
  expect(validAgentAuthorization(null, nonce)).toBe(false);
  expect(validAgentAuthorization(`Bearer ${"b".repeat(64)}`, nonce)).toBe(false);
});

test("hub cleanup runs at startup but not for each connection", async () => {
  const h = harness({ temporary: true });
  const hub = new AgentControlHub(h.deps);
  await hub.cleanupTemporaryProfiles();
  expect(h.profileExists()).toBe(false);

  h.restoreTemporaryProfile();
  hub.connect();
  await Bun.sleep(0);
  expect(h.profileExists()).toBe(true);
  expect(h.temporary()).toBe(true);
});

test("disconnect closes a browser opened by this connection", async () => {
  const h = harness();
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.ok).toBe(true);
  expect(response.result).toMatchObject({
    profileId: "profile1",
    headless: true,
    alreadyOpen: false,
    ownedByConnection: true,
  });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:true", "stop:profile1"]);
});

test("an explicit detach transfers a CLI-opened browser out of connection cleanup", async () => {
  const h = harness();
  await h.session.enqueue(wire("browser.open", { profileId: "profile1" }));
  const detached = await h.session.enqueue(wire("browser.detach", { profileId: "profile1" }));
  expect(detached).toMatchObject({ ok: true, result: { detached: true } });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:false"]);
});

test("disconnect detaches from an existing browser without closing it", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.result).toMatchObject({
    alreadyOpen: true,
    ownedByConnection: false,
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("disconnect leaves a running browser alone when its status check missed and start reattached", async () => {
  const h = harness();
  const deps = {
    ...h.deps,
    launcher: {
      ...h.deps.launcher,
      start: async () => {
        h.events.push("reattach");
        return { ws: "ws://127.0.0.1:9333/devtools/browser/test", port: 9333, reattached: true };
      },
    },
  };
  const session = new AgentControlSession(deps as any);
  const response = await session.enqueue(wire("browser.open", { profileId: "profile1" }));

  expect(response.result).toMatchObject({ alreadyOpen: true, ownedByConnection: false });
  await session.disconnect();
  expect(h.events).toEqual(["reattach"]);
});

test("Firefox browser status and open keep the owner transport private", async () => {
  const h = harness({ active: true, firefox: true });
  const session = new AgentControlSession({
    ...h.deps,
    firefoxCall: async () => ({ tools: [] }),
  });

  const status = await session.enqueue(wire("browser.status", { profileId: "profile1" }));
  const opened = await session.enqueue(wire("browser.open", { profileId: "profile1" }));

  for (const result of [status, opened]) {
    const text = JSON.stringify(result);
    expect(text).toContain('"engine":"firefox"');
    expect(text).not.toContain("firefoxOwner");
    expect(text).not.toContain("private-token");
    expect(text).not.toContain("firefox://");
    expect(text).not.toContain("debugPort");
    expect(text).not.toContain('"port"');
    expect(text).not.toContain('"ws"');
  }
  await session.disconnect();
});

test("Firefox MCP relays official schemas and calls through the authenticated manager", async () => {
  const h = harness({ active: true, firefox: true });
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const session = new AgentControlSession({
    ...h.deps,
    firefoxCall: async (_owner, operation, payload) => {
      calls.push({ operation, payload });
      return operation === "mcp-list" ? [{ name: "browser_snapshot" }] : { content: [] };
    },
  });

  expect(await session.enqueue(wire("firefox.tools.list", { profileId: "profile1" }))).toMatchObject({
    ok: true, result: { tools: [{ name: "browser_snapshot" }] },
  });
  expect(await session.enqueue(wire("firefox.tools.call", {
    profileId: "profile1", name: "browser_snapshot", arguments: { compact: true },
  }))).toMatchObject({ ok: true, result: { content: [] } });
  expect(calls).toEqual([
    { operation: "mcp-list", payload: {} },
    { operation: "mcp-call", payload: { name: "browser_snapshot", arguments: { compact: true } } },
  ]);
});

test("an existing browser rejects a launch-mode change", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: false,
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "mode_conflict" },
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("temporary profiles delete only after confirmed browser close", async () => {
  const h = harness({ active: true, temporary: true });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({ ok: true, result: { closed: true, deleted: true } });
  expect(h.events).toEqual([
    "stop:profile1",
    "cache-settled:profile1",
    "remove-data:profile1",
    "delete:profile1",
  ]);
  expect(h.temporary()).toBe(false);
  expect(h.profileExists()).toBe(false);
});

test("an unconfirmed close retains the temporary profile marker", async () => {
  const h = harness({ active: true, temporary: true, stopResult: false });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "close_unconfirmed" },
  });
  expect(h.events).toEqual(["stop:profile1"]);
  expect(h.temporary()).toBe(true);
  expect(h.profileExists()).toBe(true);
});

function localEditHarness(active = false) {
  const h = harness({ active });
  const profile = buildNewProfile({ name: "Local account", group: "accounts" }, () => false);
  profile.id = "profile1";
  profile.username = "exact-user";
  profile.password = "old-password";
  profile.email = "keep@example.test";
  profile.cookies = [{ name: "auth_token", value: "session-secret", domain: ".x.com", path: "/" }];
  const saved = new Map([[profile.id, profile]]);
  const deps = {
    ...h.deps,
    store: {
      ...h.deps.store,
      listProfiles: () => [...saved.values()],
      getProfile: (id: string) => saved.get(id) ?? null,
      upsertProfile: (next: typeof profile) => { saved.set(next.id, structuredClone(next)); },
    } as any,
    launcher: { ...h.deps.launcher, reconcileOrphans: async () => {} },

  };
  return { ...h, saved, profile, session: new AgentControlSession(deps) };
}

test("unsupported Agent Control methods are rejected", async () => {
  const h = localEditHarness();
  for (const method of ["unsupported.operation"]) {
    expect(await h.session.enqueue(wire(method))).toMatchObject({ ok: false, error: { code: "unknown_method" } });
  }
});

test("local profile edits retain untouched credentials, cookies, and fingerprint without a server version", async () => {
  const h = localEditHarness();
  const listed = await h.session.enqueue(wire("profiles.list"));
  expect(listed).toMatchObject({ ok: true, result: { profiles: [{ id: "profile1", name: "Local account" }] } });
  expect(JSON.stringify(listed)).not.toContain("old-password");
  const result = await h.session.enqueue(wire("profiles.update", {
    profileId: "profile1", set: { username: "changed-user", password: "new-password", twofa: "", tags: ["backfilled"] },
  }));
  expect(result).toMatchObject({ ok: true, result: { profileId: "profile1", updated: true } });
  const updated = h.saved.get("profile1")!;
  expect(updated).toMatchObject({ username: "changed-user", password: "new-password", email: "keep@example.test", twofa: "", tags: ["backfilled"], fingerprintSeed: h.profile.fingerprintSeed });
  expect(updated.cookies).toEqual(h.profile.cookies);
  expect(JSON.stringify(result)).not.toContain("new-password");
  expect(JSON.stringify(result)).not.toContain("session-secret");
});

test("local profile edits reject active profiles and malformed changes without writing", async () => {
  const h = localEditHarness();
  for (const set of [{}, { cookies: [] }, { password: 123 }, { extensions: "invalid" }, { resolution: "broken" }, { name: "" }]) {
    expect(await h.session.enqueue(wire("profiles.update", { profileId: "profile1", set }))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  expect(h.saved.get("profile1")).toEqual(h.profile);
  expect(await localEditHarness(true).session.enqueue(wire("profiles.update", {
    profileId: "profile1", set: { password: "new-password" },
  }))).toMatchObject({ ok: false, error: { code: "profile_open" } });
});

test("local proxy replacements preview by default and apply without leaking credentials", async () => {
  const h = localEditHarness();
  const replacement = {
    username: "exact-user",
    proxy: { type: "socks5" as const, host: "proxy.test", port: "1080", user: "proxy-user", pass: "private-pass" },
  };
  const preview = await h.session.enqueue(wire("profiles.replaceProxies", { replacements: [replacement] }));
  expect(preview).toMatchObject({ ok: true, result: { dryRun: true, counts: { ready: 1 }, results: [{ index: 0, status: "ready", profileId: "profile1" }] } });
  expect(h.saved.get("profile1")!.proxy).toBeNull();
  const applied = await h.session.enqueue(wire("profiles.replaceProxies", { dryRun: false, replacements: [replacement] }));
  expect(applied).toMatchObject({ ok: true, result: { dryRun: false, counts: { updated: 1 } } });
  expect(h.saved.get("profile1")!.proxy).toEqual(replacement.proxy);
  expect(h.saved.get("profile1")!.cookies).toEqual(h.profile.cookies);
  expect(JSON.stringify(applied)).not.toContain("private-pass");
  expect(await h.session.enqueue(wire("profiles.replaceProxies", { replacements: [replacement] }))).toMatchObject({ ok: true, result: { counts: { unchanged: 1 } } });
});

test("local proxy replacements skip open and duplicate targets and support CSV", async () => {
  const replacement = { profileId: "profile1", proxy: { type: "http", host: "proxy.test", port: "8080", user: "", pass: "" } };
  const h = localEditHarness();
  expect(await h.session.enqueue(wire("profiles.replaceProxies", { dryRun: false, replacements: [replacement, replacement] }))).toMatchObject({
    ok: true, result: { counts: { skipped: 2, updated: 0 }, results: [{ code: "duplicate_target" }, { code: "duplicate_target" }] },
  });
  expect(h.saved.get("profile1")!.proxy).toBeNull();
  expect(await localEditHarness(true).session.enqueue(wire("profiles.replaceProxies", { dryRun: false, replacements: [replacement] }))).toMatchObject({
    ok: true, result: { counts: { skipped: 1, updated: 0 }, results: [{ code: "profile_open" }] },
  });
  const csv = "username,type,host,port,user,pass\nexact-user,http,proxy.test,8080,user,private-csv-pass";
  expect(await h.session.enqueue(wire("profiles.replaceProxies", { csv, dryRun: false }))).toMatchObject({ ok: true, result: { counts: { updated: 1 } } });
  expect(h.saved.get("profile1")!.proxy?.pass).toBe("private-csv-pass");
  expect(await h.session.enqueue(wire("profiles.replaceProxies", { dryRun: "false", replacements: [replacement] }))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

test("Local profiles.create sets the timezone from the proxy", async () => {
    const h = harness();
    const saved: any[] = [];
    const session = new AgentControlSession({ ...h.deps, geoipFetch: async () => Response.json({ status: "success", timezone: "Europe/Paris" }), store: { ...h.deps.store, upsertProfile: (profile: any) => saved.push(profile) } as any });
    const response = await session.enqueue(wire("profiles.create", {
      input: { name: "agent", proxy: { type: "http", host: "proxy.example", port: "8080" } },
    }));
    expect(response).toMatchObject({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ timezone: "Europe/Paris", locale: "fr-FR" });
});

/** Runs `run` as if on Windows x64, Apple Silicon macOS, or Linux x64. */
async function onHost(platform: "win32" | "darwin" | "linux", run: () => Promise<void>): Promise<void> {
  const host = { platform: process.platform, arch: process.arch };
  Object.defineProperties(process, { platform: { value: platform }, arch: { value: platform === "darwin" ? "arm64" : "x64" } });
  try {
    await run();
  } finally {
    Object.defineProperties(process, { platform: { value: host.platform }, arch: { value: host.arch } });
  }
}

// The MCP create tool and `aliasmode-mcp profiles create` both send this request.
test.each([
  ["win32", "chromium", "aliasmode"],
  ["darwin", "firefox", undefined],
  ["linux", "firefox", undefined],
] as const)("profiles.create on %s defaults to %s, and an explicit browser request wins", async (platform, engine, runtime) => {
  const h = harness();
  const saved: any[] = [];
  const session = new AgentControlSession({ ...h.deps, store: { ...h.deps.store, upsertProfile: (profile: any) => saved.push(profile) } as any });
  await onHost(platform, async () => {
    for (const input of [{}, { chromiumRuntime: "cloakbrowser" }, { engine: "chromium" }, { engine: "firefox" }]) {
      expect(await session.enqueue(wire("profiles.create", { input: { name: "agent", ...input } }))).toMatchObject({ ok: true });
    }
  });
  expect(saved.map((profile) => [profile.engine, profile.chromiumRuntime])).toEqual([
    [engine, runtime],
    ["chromium", undefined],
    ["chromium", "aliasmode"],
    ["firefox", undefined],
  ]);
});
