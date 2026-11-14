/** Optional, bounded readiness checks on the configured loopback endpoint. No credentials or destinations. */
import { createConnection, isIP } from "node:net";
import type { AppSettings } from "./app-settings.ts";
import type { ProxySpec } from "./types.ts";
import { canonicalIp } from "./ip.ts";

export type LocalProxyEndpoint = Readonly<Pick<ProxySpec, "type" | "host" | "port">>;
export type LocalProxyPreflightCode = "local_proxy_unavailable" | "local_proxy_protocol" | "local_proxy_settings";
export class LocalProxyPreflightError extends Error {
  constructor(readonly code: LocalProxyPreflightCode) { super("The configured local proxy could not pass the startup check."); this.name = "LocalProxyPreflightError"; }
}
export const LOCAL_PROXY_PREFLIGHT_TIMEOUT_MS = 800;
export interface LoopbackProxyTarget { hosts: readonly string[]; port: number; type: ProxySpec["type"]; key: string }
/** Literal classification only: localhost never reaches DNS, and remote addresses are outside this feature. */
export function loopbackProxyTarget(endpoint: LocalProxyEndpoint): LoopbackProxyTarget | null {
  const host = endpoint.host.toLowerCase(), literal = canonicalIp(host); let hosts: string[];
  if (host === "localhost") hosts = ["127.0.0.1", "::1"];
  else if (literal === "::1" || literal && isIP(literal) === 4 && literal.startsWith("127.")) hosts = [literal];
  else return null;
  const port = Number(endpoint.port);
  if (!/^\d{1,5}$/.test(endpoint.port) || !Number.isInteger(port) || port < 1 || port > 65535 || !["http", "https", "socks5"].includes(endpoint.type)) throw new LocalProxyPreflightError("local_proxy_unavailable");
  return { hosts, port, type: endpoint.type, key: `${endpoint.type}/${hosts.join(",")}/${port}` };
}

/** TCP for HTTP(S); SOCKS method negotiation only, with no authentication or CONNECT request. */
export async function probeLoopbackProxy(target: LoopbackProxyTarget, timeoutMs = LOCAL_PROXY_PREFLIGHT_TIMEOUT_MS): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LOCAL_PROXY_PREFLIGHT_TIMEOUT_MS) throw new LocalProxyPreflightError("local_proxy_unavailable");
  // This exported boundary accepts only the already-literal loopback hosts, even if called directly.
  if (!target.hosts.length || target.hosts.length > 2 || target.hosts.some(host => host !== "::1" && !(isIP(host) === 4 && host.startsWith("127.")))
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !["http", "https", "socks5"].includes(target.type)) throw new LocalProxyPreflightError("local_proxy_unavailable");
  await new Promise<void>((resolve, reject) => {
    const sockets: ReturnType<typeof createConnection>[] = []; let settled = false, remaining = target.hosts.length, protocolFailure = false;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (ok) resolve(); else reject(new LocalProxyPreflightError(protocolFailure ? "local_proxy_protocol" : "local_proxy_unavailable"));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    for (const host of target.hosts) {
      let ended = false, received = Buffer.alloc(0);
      const failed = (protocol = false) => { if (ended || settled) return; ended = true; protocolFailure ||= protocol; if (--remaining === 0) finish(false); };
      let socket: ReturnType<typeof createConnection>;
      try { socket = createConnection({ host, port: target.port }); } catch { failed(); continue; }
      sockets.push(socket);
      socket.once("error", () => failed());
      socket.once("close", () => failed());
      socket.once("connect", () => {
        if (settled) return socket.destroy();
        if (target.type !== "socks5") return finish(true);
        socket.write(Buffer.from([5, 2, 0, 2]));
      });
      if (target.type === "socks5") socket.on("data", chunk => {
        if (settled || ended) return;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        received = Buffer.concat([received, bytes.subarray(0, 2 - received.length)]);
        if (received.length < 2) return;
        if (received[0] === 5 && (received[1] === 0 || received[1] === 2)) finish(true);
        else { socket.destroy(); failed(true); }
      });
    }
  });
}

/** Constructor-free factory has no IO. Completed checks are never cached into later launches. */
export function createLocalProxyPreflight(
  readSettings: () => AppSettings,
  dependencies: { probe?: typeof probeLoopbackProxy } = {},
): (endpoint: LocalProxyEndpoint) => Promise<void> {
  const pending = new Map<string, Promise<void>>(), probe = dependencies.probe ?? probeLoopbackProxy;
  return async endpoint => {
    const target = loopbackProxyTarget(endpoint); if (!target) return;
    let enabled: boolean;
    try {
      const settings = readSettings(), value = settings.network?.checkLocalProxyBeforeLaunch;
      if (settings.network !== undefined && typeof value !== "boolean") throw new Error("invalid");
      enabled = value === true;
    } catch { throw new LocalProxyPreflightError("local_proxy_settings"); }
    if (!enabled) return;
    const active = pending.get(target.key); if (active) return active;
    let work!: Promise<void>;
    work = Promise.resolve().then(() => probe(target)).catch(error => {
      throw error instanceof LocalProxyPreflightError ? error : new LocalProxyPreflightError("local_proxy_unavailable");
    }).finally(() => { if (pending.get(target.key) === work) pending.delete(target.key); });
    pending.set(target.key, work); return work;
  };
}
