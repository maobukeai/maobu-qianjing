import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ALIASMODE_VERSION } from "../version.ts";
import { getIntegrationInfo, type IntegrationInfo } from "./integration-info.ts";
import { probeMcpIntegration } from "./integration-probe.ts";
import { READ_ONLY_MCP_TOOLS } from "./mcp-scope.mjs";

const ready = (): IntegrationInfo => getIntegrationInfo({
  platform: "win32", executablePath: "C:\\Maobu\\aliasmode-sidecar.exe", runtimeRoot: "C:\\Maobu\\playwright", runtimeAvailable: true,
}, { isFile: () => true });

async function fixture(options: { name?: string; version?: string; tools?: string[]; cursor?: string } = {}) {
  const server = new Server({ name: options.name ?? "aliasmode", version: options.version ?? ALIASMODE_VERSION }, { capabilities: { tools: {} } });
  let calls = 0;
  let closed = false;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (options.tools ?? READ_ONLY_MCP_TOOLS).map(name => ({ name, inputSchema: { type: "object" as const } })),
    ...(options.cursor ? { nextCursor: options.cursor } : {}),
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => { calls++; return { content: [] }; });
  server.onclose = () => { closed = true; };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport, calls: () => calls, closed: () => closed };
}

describe("MCP explicit connection check", () => {
  test("completes a real SDK handshake and directory read without invoking tools", async () => {
    const f = await fixture();
    const result = await probeMcpIntegration({}, { inspect: ready, createTransport: () => f.clientTransport });
    expect(result.status).toBe("connected");
    expect(result.connectionVerified).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.tools).toContain("aliasmode_profiles_list");
    expect(result.server).toEqual({ name: "aliasmode", version: ALIASMODE_VERSION });
    expect(f.calls()).toBe(0);
    expect(f.closed()).toBe(true);
  });

  test("does not launch anything when resources or desktop are unavailable", async () => {
    for (const status of ["helper_missing", "runtime_incomplete", "desktop_required"] as const) {
      let started = false;
      const result = await probeMcpIntegration({}, {
        inspect: () => ({ ...ready(), status }),
        createTransport: () => { started = true; throw new Error("must not run"); },
      });
      expect(result.status).toBe("unavailable");
      expect(result.connectionVerified).toBe(false);
      expect(started).toBe(false);
    }
  });

  test("rejects the wrong server and mismatched versions", async () => {
    for (const options of [{ name: "other-server" }, { version: "0.0.0-old" }]) {
      const f = await fixture(options);
      const result = await probeMcpIntegration({}, { inspect: ready, createTransport: () => f.clientTransport });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("unexpected_server");
      expect(f.closed()).toBe(true);
    }
  });

  test("rejects missing read-only tools, excessive scopes and repeating pagination", async () => {
    for (const options of [{ tools: ["aliasmode_profiles_list"] }, { tools: [...READ_ONLY_MCP_TOOLS, "browser_snapshot"] }, { cursor: "loop" }]) {
      const f = await fixture(options);
      const result = await probeMcpIntegration({}, { inspect: ready, createTransport: () => f.clientTransport });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("catalog_invalid");
      expect(result.toolCount).toBe(0);
    }
  });

  test("sanitizes raw transport failures", async () => {
    const result = await probeMcpIntegration({}, { inspect: ready, createTransport: () => { throw new Error("ws://127.0.0.1:9222/secret nonce=SECRET password=abc"); } });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("connection_failed");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("9222");
  });

  test("bounds hanging initialization and closes the transport", async () => {
    let closed = false;
    const transport: Transport = {
      start: async () => {}, send: async () => {},
      close: async () => { closed = true; transport.onclose?.(); },
    };
    const result = await probeMcpIntegration({ timeoutMs: 1_000 }, { inspect: ready, createTransport: () => transport });
    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
    expect(closed).toBe(true);
  });
});
