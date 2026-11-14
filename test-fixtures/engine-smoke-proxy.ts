/** Strictly local real-browser fixtures; they cannot relay to any external destination. */
import net, { type AddressInfo, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";

export const ENGINE_QA_HOST = "maobu-engine-qa.test";
export const ENGINE_QA_USER = "fixture-user";
export const ENGINE_QA_PASS = "fixture-password-only";
export interface ProxyEvidence { authenticated: number; rejectedAuth: number; forwarded: number; blockedExternal: number; targets: string[] }

export async function engineQaOrigin() {
  const requests: { path: string; proxyAuthorization: boolean; body: string }[] = [];
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: request.url ?? "", proxyAuthorization: request.headers["proxy-authorization"] !== undefined, body });
    response.setHeader("Connection", "close");
    if (request.url === "/roundtrip") { response.end(body); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Set-Cookie", "engine_qa=local_only; SameSite=Strict; Path=/");
    response.end("<!doctype html><meta charset=utf-8><title>Maobu isolated engine QA</title><h1>本机真实内核验收</h1>");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export async function engineQaProxy(type: "http" | "socks5", originPort: number, onTarget?: (host: string, port: number) => void) {
  const evidence: ProxyEvidence = { authenticated: 0, rejectedAuth: 0, forwarded: 0, blockedExternal: 0, targets: [] };
  const sockets = new Set<Socket>();
  function track(socket: Socket) { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy()); }
  const server = net.createServer(socket => {
    track(socket);
    let pending = Buffer.alloc(0), phase: "greeting" | "auth" | "connect" | "http" | "piping" = type === "http" ? "http" : "greeting";
    function forward(host: string, port: number, first: Buffer, connected?: () => void) {
      evidence.targets.push(`${host}:${port}`);
      onTarget?.(host, port);
      // Pin the only permitted synthetic hostname to this fixture's literal loopback.
      if (host !== ENGINE_QA_HOST || port !== originPort) {
        evidence.blockedExternal++;
        if (type === "http") socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        else socket.end(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 0]));
        return;
      }
      phase = "piping";
      socket.removeListener("data", onData);
      socket.pause();
      const upstream = net.connect({ host: "127.0.0.1", port: originPort }); track(upstream);
      socket.once("close", () => upstream.destroy()); upstream.once("close", () => socket.destroy());
      upstream.once("connect", () => {
        evidence.forwarded++; connected?.();
        if (first.length) upstream.write(first);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
    }
    function onData(chunk: Buffer | string) {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (pending.length > 64 * 1024) { socket.destroy(); return; }
      while (!socket.destroyed) {
        if (phase === "greeting") {
          if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
          const greeting = pending.subarray(0, 2 + pending[1]!); pending = pending.subarray(greeting.length);
          if (greeting[0] !== 5 || !greeting.subarray(2).includes(2)) { socket.end(Buffer.from([5, 255])); return; }
          socket.write(Buffer.from([5, 2])); phase = "auth"; continue;
        }
        if (phase === "auth") {
          if (pending.length < 2 || pending.length < 3 + pending[1]!) return;
          const userLength = pending[1]!, passLength = pending[2 + userLength]!, total = 3 + userLength + passLength;
          if (pending.length < total) return;
          const auth = pending.subarray(0, total); pending = pending.subarray(total);
          if (auth[0] !== 1 || auth.subarray(2, 2 + userLength).toString() !== ENGINE_QA_USER || auth.subarray(3 + userLength).toString() !== ENGINE_QA_PASS) {
            evidence.rejectedAuth++; socket.end(Buffer.from([1, 1])); return;
          }
          evidence.authenticated++; socket.write(Buffer.from([1, 0])); phase = "connect"; continue;
        }
        if (phase === "connect") {
          if (pending.length < 5) return;
          if (pending[0] !== 5 || pending[1] !== 1 || pending[3] !== 3) { socket.destroy(); return; }
          const hostLength = pending[4]!, total = 7 + hostLength;
          if (pending.length < total) return;
          const host = pending.subarray(5, 5 + hostLength).toString("ascii"), port = pending.readUInt16BE(5 + hostLength);
          const first = pending.subarray(total); pending = Buffer.alloc(0);
          forward(host, port, first, () => socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))); return;
        }
        if (phase === "http") {
          const end = pending.indexOf("\r\n\r\n"); if (end === -1) return;
          const lines = pending.subarray(0, end).toString("latin1").split("\r\n");
          const [method, target, version] = lines.shift()!.split(" ");
          const auth = lines.find(line => /^proxy-authorization:/i.test(line))?.replace(/^[^:]+:\s*/, "");
          if (auth !== `Basic ${Buffer.from(`${ENGINE_QA_USER}:${ENGINE_QA_PASS}`).toString("base64")}`) {
            evidence.rejectedAuth++; socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
          }
          evidence.authenticated++;
          if (method === "CONNECT") {
            const [host, port] = target!.split(":");
            forward(host!, Number(port), pending.subarray(end + 4), () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")); return;
          }
          let url: URL; try { url = new URL(target!); } catch { socket.destroy(); return; }
          const clean = lines.filter(line => !/^proxy-(authorization|connection):/i.test(line) && !/^connection:/i.test(line));
          const head = `${method} ${url.pathname}${url.search} ${version}\r\n${clean.join("\r\n")}\r\nConnection: close\r\n\r\n`;
          forward(url.hostname, Number(url.port || 80), Buffer.concat([Buffer.from(head, "latin1"), pending.subarray(end + 4)])); return;
        }
        return;
      }
    }
    socket.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: (server.address() as AddressInfo).port, evidence, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}
