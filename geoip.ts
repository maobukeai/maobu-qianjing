/** Best-effort import- and launch-time timezone enrichment and shared SOCKS5 tunneling. */

import { connect as netConnect, type Socket } from "node:net";
import { startProxyRelay, type ProxyRelay } from "./proxy-relay.ts";
import type { ProxySpec } from "./types.ts";
import { localeForCountry, localeForTimezone } from "./profile-locale.ts";
import { canonicalIp } from "./ip.ts";
import { fetchEgressEndpoint } from "./egress-transport.ts";
import { normalizeProxySpec } from "./proxy.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok?: boolean; json(): Promise<any> }>;

function readExactly(socket: Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onClose);
      socket.off("close", onClose);
      socket.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    // A proxy that rejects the handshake by simply closing the connection (no
    // SOCKS error reply, no socket error) would otherwise leave this read
    // pending until the full timeout. Fail fast on end/close instead.
    const onClose = () => {
      cleanup();
      reject(new Error("SOCKS5 proxy closed the connection before the expected response"));
    };
    const onData = (raw: Buffer | Uint8Array) => {
      const chunk = Buffer.from(raw);
      const needed = length - received;
      if (chunk.length <= needed) {
        chunks.push(chunk);
        received += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, needed));
        received += needed;
        socket.pause();
        socket.unshift(chunk.subarray(needed));
      }
      if (received === length) {
        cleanup();
        resolve(Buffer.concat(chunks, length));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 proxy response timed out"));
    }, timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onClose);
    socket.on("close", onClose);
    socket.resume();
  });
}

/** Open an RFC 1928/1929 TCP tunnel, keeping DNS resolution at the proxy. */
export async function openSocks5Tunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
  onSocket?: (socket: Socket) => void,
): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: Number(proxy.port) });
  onSocket?.(socket);
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SOCKS5 proxy connection timed out")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });

    const wantsAuth = !!proxy.user;
    // Credentials are an identity boundary: never advertise NO AUTH alongside
    // username/password, because a proxy selecting it would silently downgrade
    // an authenticated (often geo-targeted) session.
    socket.write(Buffer.from(wantsAuth ? [5, 1, 2] : [5, 1, 0]));
    const greeting = await readExactly(socket, 2, timeoutMs);
    if (greeting[0] !== 5 || greeting[1] === 0xff) throw new Error("SOCKS5 proxy rejected all authentication methods");
    if (wantsAuth) {
      if (greeting[1] !== 2) {
        throw new Error(`SOCKS5 proxy refused required username/password authentication (selected ${greeting[1]})`);
      }
      const user = Buffer.from(proxy.user, "utf8");
      const pass = Buffer.from(proxy.pass, "utf8");
      if (!user.length || user.length > 255 || pass.length > 255) throw new Error("invalid SOCKS5 username/password length");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readExactly(socket, 2, timeoutMs);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 proxy authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 proxy selected unsupported authentication method ${greeting[1]}`);
    }

    const domain = Buffer.from(host, "ascii");
    if (!domain.length || domain.length > 255) throw new Error("invalid SOCKS5 destination hostname");
    socket.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, domain.length]),
      domain,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const reply = await readExactly(socket, 4, timeoutMs);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 CONNECT failed with status ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3
      ? (await readExactly(socket, 1, timeoutMs))[0]!
      : -1;
    if (addressLength < 0) throw new Error(`SOCKS5 CONNECT returned unknown address type ${reply[3]}`);
    await readExactly(socket, addressLength + 2, timeoutMs);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export type ExitLocation = { timezone: string; country?: string; ip?: string };
export const DEFAULT_EXIT_LOCATION_ENDPOINTS = {
  geojs: "https://get.geojs.io/v1/ip/geo.json",
  ipApi: "https://ipinfo.io/json",
  ipinfo: "https://v6.ipinfo.io/json",
} as const;
export interface ExitLocationOptions {
  /** Alternate operator/test services; all requests retain the selected route. */
  endpoints?: Partial<Record<keyof typeof DEFAULT_EXIT_LOCATION_ENDPOINTS, string>>;
  timeoutMs?: number;
  geojsTimeoutMs?: number;
  /** Streamed writes must settle already-started checks before closing their relay. */
  settlePending?: boolean;
}

/** Location and address of the connection's exit IP, using the profile proxy when present. */
export async function lookupExitLocation(
  proxy: ProxySpec | null,
  fetchFn?: FetchLike,
  options: ExitLocationOptions = {},
): Promise<ExitLocation | null> {
  let relay: ProxyRelay | undefined;
  const pending: Promise<ExitLocation | null>[] = [];
  const completion = options.settlePending ? new AbortController() : undefined;
  try {
    if (proxy) {
      const normalized = normalizeProxySpec(proxy);
      if (!normalized || normalized.type === "https") return null;
      relay = await startProxyRelay({
        type: normalized.type,
        host: normalized.host,
        port: Number(normalized.port),
        user: normalized.user,
        pass: normalized.pass,
      });
    }
    const endpoints = { ...DEFAULT_EXIT_LOCATION_ENDPOINTS, ...options.endpoints };
    const timeoutMs = options.timeoutMs ?? 10_000;
    const geojsTimeoutMs = options.geojsTimeoutMs ?? 4_000;
    const init = {
      ...(relay ? { proxy: `http://127.0.0.1:${relay.port}` } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit;
    const ask = (url: string, deadline: AbortSignal, requestTimeout: number, read: (row: any) => ExitLocation | null) => {
      // Keep the existing per-check deadlines; once a preferred answer is
      // selected, actively abort redundant checks and wait for their cleanup.
      const signal = completion ? AbortSignal.any([deadline, completion.signal]) : deadline;
      const request = (async () => {
        try {
          const response = fetchFn ? await fetchFn(url, { ...init, signal })
            : await fetchEgressEndpoint(url, { relayPort: relay?.port, signal, timeoutMs: requestTimeout });
          if (response.ok === false) return null;
          return read(await response.json());
        } catch {
          return null;
        }
      })();
      pending.push(request);
      return request;
    };
    // IP check sites mostly locate an address with MaxMind's data, and ip-api.com, the app's first
    // source, names another zone for some addresses. GeoJS answers from MaxMind's free GeoLite2
    // City data, keyless over HTTPS, so both are asked at once and GeoJS's zone wins when it has
    // one. Its shorter timeout leaves a launch's 5 s wait for ip-api.com's answer if GeoJS hangs.
    const maxMind = ask(endpoints.geojs, AbortSignal.timeout(geojsTimeoutMs), geojsTimeoutMs, (row) =>
      typeof row?.timezone === "string" && row.timezone ? withIp({ timezone: row.timezone, country: row.country_code }, row.ip) : null);
    const ipApi = ask(endpoints.ipApi, init.signal!, timeoutMs, (row) => {
      if (!row || row.status === "fail" || row.success === false) return null;
      if (row.status !== undefined && row.status !== "success") return null;
      const timezone = typeof row.timezone === "string" ? row.timezone : typeof row.timezone?.id === "string" ? row.timezone.id : "";
      if (!timezone) return null;
      const country = row.countryCode ?? row.country_code ?? row.country;
      return withIp({ timezone, country }, row.query ?? row.ip);
    });
    const found = await maxMind ?? await ipApi;
    if (found) return found;
    // ip-api.com is IPv4-only; an IPv6-only exit falls through to v6.ipinfo.io.
    return await ask(endpoints.ipinfo, AbortSignal.timeout(timeoutMs), timeoutMs, (row) =>
      typeof row?.timezone === "string" && row.timezone ? withIp({ timezone: row.timezone, country: row.country }, row.ip) : null);
  } catch {
    return null;
  } finally {
    if (completion) {
      completion.abort();
      await Promise.allSettled(pending);
    }
    relay?.close();
  }
}

function withIp<T extends object>(location: T, raw: unknown): T & { ip?: string } {
  const ip = typeof raw === "string" ? canonicalIp(raw) : null;
  return ip ? { ...location, ip } : location;
}

// Profiles that share a proxy often open together, and ip-api.com answers 45 requests a minute
// per address, so one answer serves each proxy for a minute. A failed lookup is not kept.
const EXIT_REUSE_MS = 60_000;
const exits = new Map<string, { at: number; location: Promise<ExitLocation | null> }>();

/**
 * Where a proxy's traffic leaves from (timezone, country and address), looked up through the
 * proxy and never directly. Waits at most `waitMs`; an answer that comes later still serves the
 * next launch. A changed proxy (type, host, port or login) gets its own lookup.
 */
export async function lookupProxyExitLocation(
  proxy: ProxySpec,
  opts: { fetchFn?: FetchLike; waitMs?: number; now?: () => number } = {},
): Promise<ExitLocation | null> {
  const now = opts.now ?? Date.now;
  const key = JSON.stringify([proxy.type, proxy.host, String(proxy.port), proxy.user ?? "", proxy.pass ?? ""]);
  let entry = exits.get(key);
  if (!entry || now() - entry.at >= EXIT_REUSE_MS) {
    for (const [old, value] of exits) if (now() - value.at >= EXIT_REUSE_MS) exits.delete(old);
    const created = { at: now(), location: lookupExitLocation(proxy, opts.fetchFn) };
    exits.set(key, created);
    void created.location.then((location) => { if (!location && exits.get(key) === created) exits.delete(key); });
    entry = created;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.location,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.waitMs ?? 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupExitTimezone(proxy: ProxySpec | null, fetchFn?: FetchLike): Promise<string | null> {
  return (await lookupExitLocation(proxy, fetchFn))?.timezone ?? null;
}

/**
 * Resolve and attach `timezone` to each profile from its proxy's exit IP, so
 * gateway/rotating proxies get the timezone they actually exit in. Mutates and
 * returns the same array. Profiles without a proxy (or unresolved) keep
 * whatever timezone they already had. A gateway's location is not its exit.
 */
export async function attachTimezones<T extends { proxy: ProxySpec | null; timezone: string; locale?: string }>(
  profiles: T[],
  fetchFn?: FetchLike,
  refreshLocale = false,
  locationOptions: ExitLocationOptions = {},
): Promise<{ profiles: T[]; resolved: number }> {
  const withProxy = profiles.filter((p) => p.proxy?.host);
  if (withProxy.length === 0) return { profiles, resolved: 0 };
  let resolved = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, withProxy.length) }, async () => {
    while (next < withProxy.length) {
      const p = withProxy[next++]!;
      const location = await lookupExitLocation(p.proxy!, fetchFn, locationOptions);
      if (location) {
        p.timezone = location.timezone;
        if (refreshLocale || !p.locale) p.locale = localeForCountry(location.country) ?? localeForTimezone(location.timezone);
        resolved++;
      }
    }
  }));
  return { profiles, resolved };
}
