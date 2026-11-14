/** Raw loopback-only CONNECT fixture, including Bun versions whose HTTP server lacks CONNECT. */
import { createServer, connect, type Socket } from "node:net";

export async function createConnectProxy(options: {
  targetPort?: number;
  status?: number;
  onConnect?: (request: { authority: string; headers: Record<string, string> }) => void;
}) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on("error", () => socket.destroy()); socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    let pending = Buffer.alloc(0);
    const receive = (raw: Buffer | string) => {
      pending = Buffer.concat([pending, typeof raw === "string" ? Buffer.from(raw) : raw]);
      if (pending.length > 16 * 1024) { client.destroy(); return; }
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", receive);
      const lines = pending.subarray(0, end).toString("latin1").split("\r\n");
      const match = lines.shift()?.match(/^CONNECT ([^ ]+) HTTP\/1\.[01]$/);
      if (!match) { client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); return; }
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      options.onConnect?.({ authority: match[1]!, headers });
      if (options.status && options.status !== 200) {
        client.end(`HTTP/1.1 ${options.status} Fixture Response\r\nContent-Length: 0\r\n\r\n`); return;
      }
      if (!options.targetPort) { client.destroy(); return; }
      const origin = track(connect({ host: "127.0.0.1", port: options.targetPort }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (pending.length > end + 4) origin.write(pending.subarray(end + 4));
        client.pipe(origin); origin.pipe(client);
      }));
      client.once("close", () => origin.destroy()); origin.once("close", () => client.destroy());
    };
    client.on("data", receive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
