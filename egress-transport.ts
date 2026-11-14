/** Bounded GET-only exit transport. Raw sockets never consult proxy environment variables. */
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

const MAX_BODY = 64 * 1024, MAX_HEAD = 32 * 1024, MAX_WIRE = 256 * 1024, MAX_REDIRECTS = 4;
/** An unusable checker response is not objective evidence of a broken proxy. */
export class EgressResponseError extends Error {
  constructor(message: string) { super(message); this.name = "EgressResponseError"; }
}
export interface EgressTransportOptions {
  /** Omitted means direct TCP. A port always means this loopback HTTP relay. */
  relayPort?: number;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}
function endpointUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Egress endpoint must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Egress endpoint must not include credentials");
  url.hash = "";
  return url;
}
function hostOf(url: URL): string { return url.hostname.replace(/^\[|]$/g, ""); }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error("Egress request aborted"); }
export async function openTcp(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const aborted = () => { socket.destroy(); cleanup(); reject(abortError(signal)); };
    const failed = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const cleanup = () => { signal.removeEventListener("abort", aborted); socket.off("error", failed); };
    socket.on("error", () => {});
    socket.once("error", failed);
    socket.once("connect", () => { cleanup(); resolve(socket); });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** One HTTP/1.x response, with strict framing and bounded metadata/body buffers. */
export function readHttp(socket: Socket, request: string | Buffer, signal: AbortSignal, connectOnly = false,
  limits: { maxBodyBytes?: number; maxWireBytes?: number } = {}): Promise<Response> {
  const maxBody = limits.maxBodyBytes ?? MAX_BODY;
  const maxWire = limits.maxWireBytes ?? MAX_WIRE;
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0), wire = 0, length = 0;
    let status = 0, headers: Headers | undefined, contentLength: number | undefined;
    let chunked = false, chunkSize: number | undefined, trailers = false, settled = false;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      socket.off("data", data); socket.off("error", failed); socket.off("end", ended); socket.off("close", closed);
      signal.removeEventListener("abort", aborted); socket.pause();
    };
    const failed = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const fail = (message: string) => failed(new EgressResponseError(message));
    const aborted = () => { failed(abortError(signal)); socket.destroy(); };
    const finish = () => {
      if (settled) return;
      settled = true; cleanup();
      try { resolve(new Response([204, 205, 304].includes(status) || connectOnly ? null : Buffer.concat(chunks, length), { status, headers })); }
      catch { reject(new EgressResponseError("Invalid egress HTTP response")); }
    };
    const ended = () => {
      if (headers && contentLength === undefined && !chunked && !connectOnly) finish();
      else fail("Egress response ended before its declared body completed");
    };
    const closed = () => { if (!settled) fail("Egress connection closed before a complete response"); };
    const append = (chunk: Buffer) => {
      if (length + chunk.length > maxBody) { fail("Egress response is too large"); return false; }
      chunks.push(chunk); length += chunk.length; return true;
    };
    const body = () => {
      if (connectOnly || [204, 205, 304].includes(status)) {
        if (connectOnly && pending.length) socket.unshift(pending);
        finish(); return;
      }
      if (!chunked) {
        const needed = contentLength === undefined ? pending.length : contentLength - length;
        if (!append(pending.subarray(0, needed))) return;
        pending = Buffer.alloc(0);
        if (contentLength !== undefined && length === contentLength) finish();
        return;
      }
      while (!settled) {
        if (trailers) {
          if (pending.length >= 2 && pending.subarray(0, 2).toString() === "\r\n") { finish(); return; }
          const end = pending.indexOf("\r\n\r\n");
          if (end >= 0) {
            if (end > MAX_HEAD) { fail("Egress trailers are too large"); return; }
            const lines = pending.subarray(0, end).toString("latin1").split("\r\n");
            if (lines.some((line) => !/^[!#$%&'*+.^_`|~0-9a-z-]+:[ \t]*[^\r\n]*$/i.test(line)
              || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)
              || /^(?:content-length|transfer-encoding):/i.test(line))) { fail("Invalid egress trailers"); return; }
            finish(); return;
          }
          if (pending.length > MAX_HEAD) fail("Egress trailers are too large");
          return;
        }
        if (chunkSize === undefined) {
          const end = pending.indexOf("\r\n");
          if (end < 0) { if (pending.length > 1024) fail("Invalid egress chunk framing"); return; }
          if (end > 1024) { fail("Invalid egress chunk framing"); return; }
          const line = pending.subarray(0, end).toString("latin1");
          if (!/^[0-9a-f]{1,8}(?:;[^\r\n]*)?$/i.test(line) || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) { fail("Invalid egress chunk framing"); return; }
          chunkSize = Number.parseInt(line.split(";")[0]!, 16); pending = pending.subarray(end + 2);
          if (length + chunkSize > maxBody) { fail("Egress response is too large"); return; }
          if (chunkSize === 0) { trailers = true; continue; }
        }
        if (pending.length < chunkSize + 2) return;
        if (pending.subarray(chunkSize, chunkSize + 2).toString() !== "\r\n") { fail("Invalid egress chunk terminator"); return; }
        if (!append(pending.subarray(0, chunkSize))) return;
        pending = pending.subarray(chunkSize + 2); chunkSize = undefined;
      }
    };
    const data = (raw: Buffer | string) => {
      const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
      wire += chunk.length;
      if (wire > maxWire) { fail("Egress response wire limit exceeded"); return; }
      pending = Buffer.concat([pending, chunk]);
      if (!headers) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) { if (pending.length > MAX_HEAD) fail("Egress response headers are too large"); return; }
        if (end > MAX_HEAD) { fail("Egress response headers are too large"); return; }
        const lines = pending.subarray(0, end).toString("latin1").split("\r\n");
        const match = lines.shift()?.match(/^HTTP\/1\.[01] ([2-5]\d\d)(?: [^\r\n]*)?$/);
        if (!match) { fail("Invalid egress HTTP status"); return; }
        status = Number(match[1]); headers = new Headers();
        for (const line of lines) {
          const field = line.match(/^([!#$%&'*+.^_`|~0-9a-z-]+):[ \t]*([^\r\n]*)$/i);
          if (!field || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) { fail("Invalid egress HTTP header"); return; }
          try { headers.append(field[1]!, field[2]!.trim()); } catch { fail("Invalid egress HTTP header"); return; }
        }
        const framing = headers.get("content-length"), encoding = headers.get("transfer-encoding");
        if (framing !== null && (!/^\d+$/.test(framing) || encoding !== null)) { fail("Ambiguous egress response framing"); return; }
        if (encoding !== null && encoding.toLowerCase() !== "chunked") { fail("Unsupported egress transfer encoding"); return; }
        if (framing !== null) {
          contentLength = Number(framing);
          if (!Number.isSafeInteger(contentLength) || contentLength > maxBody) { fail("Egress response is too large"); return; }
        }
        chunked = encoding !== null; pending = pending.subarray(end + 4);
      }
      body();
    };
    if (signal.aborted) { aborted(); return; }
    if (socket.destroyed) { fail("Egress connection is unavailable"); return; }
    socket.on("data", data); socket.once("error", failed); socket.once("end", ended); socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    socket.resume();
    if (typeof request === "string") socket.write(request, "latin1");
    else socket.write(request);
  });
}

async function oneRequest(url: URL, options: EgressTransportOptions & { signal: AbortSignal }): Promise<Response> {
  const host = hostOf(url), targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const socket = await openTcp(options.relayPort ? "127.0.0.1" : host, options.relayPort ?? targetPort, options.signal);
  let active: Socket | TLSSocket = socket;
  const abort = () => active.destroy();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    options.signal.throwIfAborted();
    if (options.relayPort && url.protocol === "https:") {
      const authority = `${host.includes(":") ? `[${host}]` : host}:${targetPort}`;
      const reply = await readHttp(socket, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`, options.signal, true);
      if (reply.status < 200 || reply.status >= 300) return reply;
    }
    if (url.protocol === "https:") {
      active = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ socket, host, servername: isIP(host) ? undefined : host, rejectUnauthorized: true });
        active = secure;
        secure.once("secureConnect", () => resolve(secure)); secure.once("error", reject);
        secure.once("close", () => { if (!secure.authorized) reject(new Error("Egress TLS handshake failed")); });
        secure.resume();
      });
    }
    const target = options.relayPort && url.protocol === "http:" ? url.href : `${url.pathname || "/"}${url.search}`;
    return await readHttp(active, `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: application/json, text/plain\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`, options.signal);
  } finally {
    options.signal.removeEventListener("abort", abort); active.destroy(); socket.destroy();
  }
}

/** GET with certificate verification, 64 KiB bodies, explicit routing and four redirects. */
export async function fetchEgressEndpoint(endpoint: string, options: EgressTransportOptions = {}): Promise<Response> {
  if (options.relayPort !== undefined && (!Number.isInteger(options.relayPort) || options.relayPort < 1 || options.relayPort > 65535)) throw new Error("Invalid local egress relay port");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid egress timeout");
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Egress request timed out")), timeoutMs);
  const boundedOptions = { ...options, signal: controller.signal };
  try {
    let url = endpointUrl(endpoint);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      boundedOptions.signal.throwIfAborted();
      const response = await oneRequest(url, boundedOptions);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirect === MAX_REDIRECTS) throw new EgressResponseError("Too many egress redirects");
      let next: URL;
      try { next = endpointUrl(new URL(location, url).href); }
      catch { throw new EgressResponseError("Invalid egress redirect location"); }
      if (url.protocol === "https:" && next.protocol === "http:") throw new EgressResponseError("Egress redirect attempted an HTTPS downgrade");
      url = next;
    }
    throw new EgressResponseError("Too many egress redirects");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
  }
}
