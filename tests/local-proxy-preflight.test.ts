import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { defaultAppSettings } from "../app-settings.ts";
import { createLocalProxyPreflight, LOCAL_PROXY_PREFLIGHT_TIMEOUT_MS, LocalProxyPreflightError, loopbackProxyTarget, probeLoopbackProxy, type LocalProxyEndpoint } from "../local-proxy-preflight.ts";

const endpoint = (port: number, type: "http" | "https" | "socks5" = "http", host = "127.0.0.1"): LocalProxyEndpoint => ({ host, port: String(port), type });
const enabled = () => ({ ...defaultAppSettings(), network: { checkLocalProxyBeforeLaunch: true } });
async function listener(onData: (socket: Socket, chunk: Buffer) => void = () => {}) {
  const sockets = new Set<Socket>(), received: Buffer[] = [];
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("data", chunk => { const data = Buffer.from(chunk); received.push(data); onData(socket, data); }); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: (server.address() as { port: number }).port, received, sockets, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test("loopback classification pins localhost and rejects remote hosts without DNS", () => {
  expect(loopbackProxyTarget(endpoint(7890, "http", "localhost"))?.hosts).toEqual(["127.0.0.1", "::1"]);
  for (const host of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) expect(loopbackProxyTarget(endpoint(7890, "http", host))).not.toBeNull();
  for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:127.0.0.1]", "0:0:0:0:0:ffff:7f00:1"]) {
    expect(loopbackProxyTarget(endpoint(7890, "http", host))?.hosts).toEqual(["127.0.0.1"]);
    expect(loopbackProxyTarget(endpoint(7890, "http", host))?.key).toBe(loopbackProxyTarget(endpoint(7890))?.key);
  }
  for (const host of ["proxy.example", "localhost.example", "192.168.1.1", "::2", "8.8.8.8", "127.example", "127.1", "2130706433", "::ffff:192.168.1.1", "::ffff:808:808"]) expect(loopbackProxyTarget(endpoint(7890, "http", host))).toBeNull();
  for (const port of ["0", "65536", "1e3", "80/path"]) expect(() => loopbackProxyTarget({ ...endpoint(1), port })).toThrow(LocalProxyPreflightError);
  expect(LOCAL_PROXY_PREFLIGHT_TIMEOUT_MS).toBe(800);
});
test("factory construction, disabled settings and remote endpoints never probe", async () => {
  let reads = 0, probes = 0;
  const check = createLocalProxyPreflight(() => { reads++; return defaultAppSettings(); }, { probe: async () => { probes++; } });
  expect(reads).toBe(0); await check(endpoint(7890)); await check(endpoint(7890, "http", "remote.example"));
  expect(reads).toBe(1); expect(probes).toBe(0);
  const { network: _network, ...legacy } = defaultAppSettings(); await createLocalProxyPreflight(() => legacy, { probe: async () => { probes++; } })(endpoint(7890)); expect(probes).toBe(0);
});
test("HTTP and HTTPS perform TCP only without credentials or application requests", async () => {
  const service = await listener();
  try {
    for (const type of ["http", "https"] as const) {
      const input = endpoint(service.port, type); Object.defineProperty(input, "user", { get() { throw new Error("private-user getter must not be read"); } }); Object.defineProperty(input, "pass", { get() { throw new Error("private-pass getter must not be read"); } });
      await createLocalProxyPreflight(enabled)(input);
    }
    expect(service.received).toEqual([]);
  } finally { await service.close(); }
});
test("IPv4-mapped endpoints check real literal listeners and cannot bypass a closed local port", async () => {
  const service = await listener();
  try { for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]"]) await createLocalProxyPreflight(enabled)(endpoint(service.port, "http", host)); expect(service.received).toEqual([]); }
  finally { await service.close(); }
  // Bun 1.2/1.3 on Windows can crash after these two real socket rejections
  // use its rejects matcher before the next split-method test. Await each
  // rejection directly and assert the identical public error contract.
  for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    let failure: unknown;
    try { await createLocalProxyPreflight(enabled)(endpoint(service.port, "http", host)); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "local_proxy_unavailable" });
  }
  let reads = 0;
  const check = createLocalProxyPreflight(() => { reads++; throw new Error("private-settings-password"); });
  await check(endpoint(service.port, "http", "::ffff:192.168.1.1")); expect(reads).toBe(0);
});
test("SOCKS accepts split method replies without transmitting authentication or CONNECT", async () => {
  for (const method of [0, 2]) {
    const service = await listener(socket => { socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([method])), 5); });
    try { await createLocalProxyPreflight(enabled)(endpoint(service.port, "socks5")); expect(Buffer.concat(service.received)).toEqual(Buffer.from([5, 2, 0, 2])); }
    finally { await service.close(); }
  }
});
test("a closed port or SOCKS protocol rejection gives a fixed public error", async () => {
  const closed = await listener(); await closed.close();
  await expect(createLocalProxyPreflight(enabled)(endpoint(closed.port))).rejects.toMatchObject({ code: "local_proxy_unavailable" });
  for (const reply of [Buffer.from([5, 255]), Buffer.from("private-response-body")]) {
    const service = await listener(socket => socket.write(reply));
    try { await expect(createLocalProxyPreflight(enabled)(endpoint(service.port, "socks5"))).rejects.toMatchObject({ code: "local_proxy_protocol" }); }
    finally { await service.close(); }
  }
});
test("silent SOCKS connections time out with bounded input and close their sockets", async () => {
  const service = await listener();
  try {
    await expect(probeLoopbackProxy(loopbackProxyTarget(endpoint(service.port, "socks5"))!, 40)).rejects.toMatchObject({ code: "local_proxy_unavailable" });
    expect(Buffer.concat(service.received)).toEqual(Buffer.from([5, 2, 0, 2]));
    await new Promise(resolve => setTimeout(resolve, 10)); expect(service.sockets.size).toBe(0);
    await expect(probeLoopbackProxy(loopbackProxyTarget(endpoint(service.port))!, 801)).rejects.toBeInstanceOf(LocalProxyPreflightError);
  } finally { await service.close(); }
});
test("localhost checks literal loopbacks and works without global fetch or proxy configuration", async () => {
  const service = await listener(), original = globalThis.fetch, proxy = process.env.HTTP_PROXY;
  globalThis.fetch = (() => { throw new Error("Global fetch must not be used"); }) as unknown as typeof fetch; process.env.HTTP_PROXY = "http://external-proxy.invalid:1234";
  try { await createLocalProxyPreflight(enabled)(endpoint(service.port, "http", "localhost")); expect(service.received).toEqual([]); }
  finally { globalThis.fetch = original; if (proxy === undefined) { process.env.HTTP_PROXY = ""; delete process.env.HTTP_PROXY; } else process.env.HTTP_PROXY = proxy; await service.close(); }
});
test("only simultaneous endpoint checks coalesce and completion or failure is never cached", async () => {
  let calls = 0, release!: () => void; let gate = new Promise<void>(resolve => { release = resolve; });
  const check = createLocalProxyPreflight(enabled, { probe: async () => { calls++; await gate; } });
  const first = check(endpoint(7890)), second = check(endpoint(7890)); await Promise.resolve(); expect(calls).toBe(1); release(); await Promise.all([first, second]);
  gate = Promise.resolve(); await check(endpoint(7890)); expect(calls).toBe(2);
  let failures = 0; const failing = createLocalProxyPreflight(enabled, { probe: async () => { failures++; throw new Error("private-response-body"); } });
  for (let i = 0; i < 2; i++) await expect(failing(endpoint(7890))).rejects.toMatchObject({ code: "local_proxy_unavailable", message: "The configured local proxy could not pass the startup check." });
  expect(failures).toBe(2);
});
test("unreadable or malformed settings block only loopback checks without leaking raw content", async () => {
  for (const read of [() => { throw new Error("private-settings-password"); }, () => ({ ...defaultAppSettings(), network: { checkLocalProxyBeforeLaunch: "secret" } }) as any]) {
    const check = createLocalProxyPreflight(read);
    await expect(check(endpoint(7890))).rejects.toMatchObject({ code: "local_proxy_settings", message: "The configured local proxy could not pass the startup check." });
    await check(endpoint(7890, "http", "remote.example"));
  }
});
