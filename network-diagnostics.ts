/** Bounded, loopback-only discovery. A listening port is not an egress or privacy test. */
import { createConnection } from "node:net";
import type { ProxyType } from "./types.ts";

export const COMMON_LOCAL_PROXY_PORTS = [7890, 7891, 7892, 1080, 10808, 10809, 2080] as const;
export type LocalProxyHost = "127.0.0.1" | "::1";
export interface LocalProxyDiscoveryResult {
  host: LocalProxyHost;
  port: number;
  status: "listening" | "closed" | "timeout" | "unavailable";
  latencyMs: number | null;
  socks5: "available" | "authentication_required" | "rejected" | "unknown";
  suggestions: Array<{ type: Extract<ProxyType, "http" | "socks5">; evidence: "handshake" | "port_hint" }>;
}
export interface LocalProxyDiscoveryRequest {
  ports?: readonly number[];
  host?: LocalProxyHost;
}
export interface LocalProxyDiscoveryOptions extends LocalProxyDiscoveryRequest {
  timeoutMs?: number;
}
export interface LocalProxyDiscoveryReport {
  checkedAt: string;
  host: LocalProxyHost;
  results: LocalProxyDiscoveryResult[];
}

function discoveryTargets(host: unknown = "127.0.0.1", ports: unknown = COMMON_LOCAL_PROXY_PORTS): Required<LocalProxyDiscoveryRequest> {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Local proxy discovery only supports loopback IP literals");
  const invalidPorts = "Choose between 1 and 16 unique local ports from 1 to 65535";
  if (!Array.isArray(ports) || ports.length < 1 || ports.length > 16) throw new Error(invalidPorts);
  const seen = new Set<number>();
  for (const port of ports) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || seen.has(port)) throw new Error(invalidPorts);
    seen.add(port);
  }
  return { host, ports };
}

/** Resolve only omitted settings to defaults, before the discovery transport runs. */
export function parseLocalProxyDiscoveryRequest(input: unknown): Required<LocalProxyDiscoveryRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
  const options = input as Record<string, unknown>;
  if (Object.keys(options).some(key => key !== "host" && key !== "ports")) throw new Error("Unsupported network discovery option");
  return discoveryTargets(options.host, options.ports);
}

function suggestedProtocols(port: number): LocalProxyDiscoveryResult["suggestions"] {
  const types: Array<"http" | "socks5"> = [7891, 1080].includes(port)
    ? ["socks5", "http"] : ["http", "socks5"];
  return types.map((type) => ({ type, evidence: "port_hint" }));
}

async function probeLocalPort(host: LocalProxyHost, port: number, timeoutMs: number): Promise<LocalProxyDiscoveryResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let connected = false;
    let latencyMs: number | null = null;
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => finish(connected ? "listening" : "timeout"), timeoutMs);
    const finish = (status: LocalProxyDiscoveryResult["status"], socks5: LocalProxyDiscoveryResult["socks5"] = "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ host, port, status, latencyMs, socks5, suggestions: status === "listening"
        ? socks5 === "available" || socks5 === "authentication_required"
          ? [{ type: "socks5", evidence: "handshake" }]
          : suggestedProtocols(port)
        : [] });
    };
    socket.once("connect", () => {
      connected = true;
      latencyMs = Math.max(0, Math.round(performance.now() - started));
      // RFC 1928 method negotiation only: no CONNECT, target address, credentials,
      // or outbound request. Offering auth is enough to recognize protected listeners.
      socket.write(Buffer.from([5, 2, 0, 2]));
    });
    socket.on("data", (data) => {
      // A protocol negotiation needs exactly two bytes; don't buffer banners/bodies.
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      received = Buffer.concat([received, bytes.subarray(0, 2 - received.length)]);
      if (received.length < 2) return;
      if (received[0] !== 5) return finish("listening");
      if (received[1] === 0) return finish("listening", "available");
      if (received[1] === 2) return finish("listening", "authentication_required");
      finish("listening", "rejected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => finish(connected ? "listening"
      : error.code === "ECONNREFUSED" ? "closed"
      : error.code === "ETIMEDOUT" ? "timeout" : "unavailable"));
    socket.once("close", () => finish(connected ? "listening" : "closed"));
  });
}

/**
 * Probe at most 16 user-selected local ports. Results never claim that a proxy
 * works, changes the public IP, prevents DNS/WebRTC leaks, or has a clean IP.
 * Run the existing checkProxy separately to verify outbound connectivity.
 */
export async function discoverLocalProxies(options: LocalProxyDiscoveryOptions = {}): Promise<LocalProxyDiscoveryReport> {
  const { host, ports } = discoveryTargets(options.host, options.ports);
  const { timeoutMs = 650 } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 3000) throw new Error("Local probe timeout must be between 50 and 3000 ms");
  const results = await Promise.all(ports.map(port => probeLocalPort(host, port, timeoutMs)));
  return { checkedAt: new Date().toISOString(), host, results };
}
