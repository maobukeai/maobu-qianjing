import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ALIASMODE_VERSION } from "../src/version.ts";
import { getIntegrationInfo, type IntegrationInfo, type IntegrationInfoOptions } from "./integration-info.ts";
import { READ_ONLY_MCP_ARGS, READ_ONLY_MCP_TOOLS } from "./mcp-scope.mjs";

export interface IntegrationProbeResult {
  checkedAt: number;
  status: "connected" | "unavailable" | "timeout" | "failed";
  connectionVerified: boolean;
  message: string;
  toolCount: number;
  tools: string[];
  server?: { name: "aliasmode"; version: string };
  errorCode?: "resources_unavailable" | "desktop_unavailable" | "timeout" | "unexpected_server" | "catalog_invalid" | "connection_failed";
}

export interface IntegrationProbeOptions extends IntegrationInfoOptions {
  timeoutMs?: number;
}

interface ProbeDependencies {
  inspect?: (options: IntegrationInfoOptions) => IntegrationInfo;
  createTransport?: (helperPath: string) => Transport;
}

class ProbeFailure extends Error {
  constructor(readonly code: "unexpected_server" | "catalog_invalid") { super(code); }
}

function transportFor(helperPath: string): StdioClientTransport {
  const env: Record<string, string> = {};
  // Retain only runtime discovery and desktop session keys beyond the SDK's
  // default OS environment. Credentials and arbitrary application env stay out.
  for (const key of ["ALIASMODE_PLAYWRIGHT_RUNTIME", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return new StdioClientTransport({
    command: helperPath, args: [...READ_ONLY_MCP_ARGS], env, stderr: "ignore", maxBufferSize: 2 * 1024 * 1024,
  });
}

/** Explicit, bounded protocol check. Initializes MCP and lists tools; never invokes a tool or opens a browser profile. */
export async function probeMcpIntegration(
  options: IntegrationProbeOptions = {},
  dependencies: ProbeDependencies = {},
): Promise<IntegrationProbeResult> {
  const checkedAt = Date.now();
  const readiness = (dependencies.inspect ?? getIntegrationInfo)(options);
  const empty = { checkedAt, connectionVerified: false, toolCount: 0, tools: [] };
  if (readiness.status !== "ready" || !readiness.helperPath) return {
    ...empty, status: "unavailable",
    errorCode: readiness.status === "desktop_required" ? "desktop_unavailable" : "resources_unavailable",
    message: readiness.status === "desktop_required" ? "请先打开桌面应用，再检查 MCP 连接。" : "本机 MCP 资源不完整，请先完成桌面安装或构建。",
  };
  const requestedTimeout = options.timeoutMs ?? 15_000;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(30_000, Math.max(1_000, requestedTimeout)) : 15_000;
  const abort = new AbortController();
  const client = new Client({ name: "maobu-connection-check", version: ALIASMODE_VERSION });
  let transport: Transport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  const check = async (): Promise<IntegrationProbeResult> => {
    transport = (dependencies.createTransport ?? transportFor)(readiness.helperPath!);
    await client.connect(transport, { signal: abort.signal, timeout: timeoutMs });
    const server = client.getServerVersion();
    if (server?.name !== "aliasmode" || server.version !== ALIASMODE_VERSION) throw new ProbeFailure("unexpected_server");
    const tools = new Set<string>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const response = await client.listTools(cursor ? { cursor } : {}, { signal: abort.signal, timeout: timeoutMs });
      for (const tool of response.tools) {
        if (!READ_ONLY_MCP_TOOLS.includes(tool.name) || tools.has(tool.name)) throw new ProbeFailure("catalog_invalid");
        tools.add(tool.name);
      }
      cursor = response.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new ProbeFailure("catalog_invalid");
      cursors.add(cursor);
    }
    if (cursor || tools.size !== READ_ONLY_MCP_TOOLS.length) throw new ProbeFailure("catalog_invalid");
    return {
      checkedAt, status: "connected", connectionVerified: true,
      message: "MCP 握手与工具目录读取成功；未执行任何浏览器工具。",
      toolCount: tools.size, tools: [...tools], server: { name: "aliasmode", version: server.version },
    };
  };
  try {
    return await Promise.race([check(), deadline]);
  } catch (error) {
    if (timedOut) return { ...empty, status: "timeout", errorCode: "timeout", message: "MCP 连接检查超时，请确认桌面服务可用后重试。" };
    const code = error instanceof ProbeFailure ? error.code : "connection_failed";
    const message = code === "unexpected_server" ? "MCP 服务名称或版本与本机应用不一致，请重新准备桌面资源。"
      : code === "catalog_invalid" ? "MCP 工具目录不完整或无效，请重新准备桌面资源。"
      : "MCP 连接失败，请确认桌面资源和本地服务正常后重试。";
    // Do not return raw subprocess errors: they can contain environment data,
    // connection endpoints or credentials emitted by a failing server.
    return { ...empty, status: "failed", errorCode: code, message };
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}
