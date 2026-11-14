/** Explicit loopback JSON RPC for local model providers. No global fetch or proxy environment. */
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { EgressResponseError, openTcp, readHttp } from "./egress-transport.ts";

export type LocalJsonTransportErrorCode = "invalid_endpoint" | "invalid_request" | "request_too_large" | "response_too_large"
  | "timeout" | "cancelled" | "http_error" | "redirect_rejected" | "invalid_json" | "unavailable";
const MESSAGES: Record<LocalJsonTransportErrorCode, string> = {
  invalid_endpoint: "Local AI endpoint must be a loopback HTTP(S) root URL",
  invalid_request: "Invalid local AI JSON request",
  request_too_large: "Local AI request exceeds 128 KiB",
  response_too_large: "Local AI response exceeds 256 KiB",
  timeout: "Local AI request timed out",
  cancelled: "Local AI request was cancelled",
  http_error: "Local AI service returned an unsuccessful HTTP status",
  redirect_rejected: "Local AI redirects are not allowed",
  invalid_json: "Local AI service returned invalid JSON",
  unavailable: "Local AI service is unavailable",
};
export class LocalJsonTransportError extends Error {
  constructor(readonly code: LocalJsonTransportErrorCode, readonly status?: number) {
    super(MESSAGES[code]); this.name = "LocalJsonTransportError";
  }
}
export interface LoopbackJsonRequestOptions {
  method: "GET" | "POST";
  path: "/api/tags" | "/api/chat";
  body?: unknown;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

function rootEndpoint(endpoint: string): URL {
  if (typeof endpoint !== "string" || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i.test(endpoint)) {
    throw new LocalJsonTransportError("invalid_endpoint");
  }
  try {
    const url = new URL(endpoint);
    if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error();
    return url;
  } catch { throw new LocalJsonTransportError("invalid_endpoint"); }
}

/** Supports only Ollama's model listing and nonstreaming chat routes. */
export async function requestLoopbackJson(endpoint: string, options: LoopbackJsonRequestOptions): Promise<unknown> {
  const url = rootEndpoint(endpoint);
  if (!options || !((options.method === "GET" && options.path === "/api/tags" && options.body === undefined)
    || (options.method === "POST" && options.path === "/api/chat" && options.body !== undefined))) throw new LocalJsonTransportError("invalid_request");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new LocalJsonTransportError("invalid_request");
  let body = Buffer.alloc(0);
  if (options.method === "POST") {
    try {
      const json = JSON.stringify(options.body);
      if (json === undefined) throw new Error();
      body = Buffer.from(json, "utf8");
    } catch { throw new LocalJsonTransportError("invalid_request"); }
    if (body.length > 128 * 1024) throw new LocalJsonTransportError("request_too_large");
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted) throw new LocalJsonTransportError("cancelled");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let socket: Socket | undefined, active: Socket | TLSSocket | undefined;
  const close = () => { active?.destroy(); socket?.destroy(); };
  controller.signal.addEventListener("abort", close, { once: true });
  try {
    const hostname = url.hostname.replace(/^\[|]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    // localhost is pinned to loopback and never sent to DNS or a configured proxy.
    socket = await openTcp(hostname === "localhost" ? "127.0.0.1" : hostname, port, controller.signal);
    active = socket;
    if (url.protocol === "https:") {
      active = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ socket, host: hostname, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true });
        active = secure;
        secure.once("secureConnect", () => resolve(secure)); secure.once("error", reject);
        secure.once("close", () => { if (!secure.authorized) reject(new Error("Local TLS handshake failed")); });
        secure.resume();
      });
    }
    controller.signal.throwIfAborted();
    const head = `${options.method} ${options.path} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n`
      + (options.method === "POST" ? `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${body.length}\r\n` : "") + "\r\n";
    const response = await readHttp(active, Buffer.concat([Buffer.from(head, "latin1"), body]), controller.signal, false,
      { maxBodyBytes: 256 * 1024, maxWireBytes: 1024 * 1024 });
    if (response.status >= 300 && response.status < 400) throw new LocalJsonTransportError("redirect_rejected");
    if (!response.ok) throw new LocalJsonTransportError("http_error", response.status);
    try {
      const bytes = await response.arrayBuffer();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new LocalJsonTransportError("invalid_json"); }
  } catch (error) {
    if (error instanceof LocalJsonTransportError) throw error;
    if (timedOut) throw new LocalJsonTransportError("timeout");
    if (options.signal?.aborted) throw new LocalJsonTransportError("cancelled");
    if (error instanceof EgressResponseError && /too large|wire limit/.test(error.message)) throw new LocalJsonTransportError("response_too_large");
    throw new LocalJsonTransportError("unavailable");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", close); close();
  }
}
