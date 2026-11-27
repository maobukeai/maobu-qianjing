import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ALIASMODE_VERSION } from "../src/version.ts";
import { READ_ONLY_MCP_ARGS } from "./mcp-scope.mjs";
import catalog from "../docs/public/mcp-tools/current-source.json";

export interface IntegrationConfig {
  id: "generic" | "codex" | "vscode";
  label: string;
  format: "json" | "toml";
  content: string;
  destination: string;
}

export interface IntegrationCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface IntegrationInfo {
  version: string;
  transport: "stdio";
  status: "ready" | "helper_missing" | "runtime_incomplete" | "desktop_required";
  /** Filesystem readiness is separate from an MCP client completing a handshake. */
  connectionVerified: false;
  helperPath: string | null;
  configs: IntegrationConfig[];
  capabilities: Array<{ id: string; label: string; description: string; engines: string[] }>;
  tools: Array<{ name: string; title: string; description: string; readOnly: boolean; destructive: boolean; openWorld: boolean }>;
  workflows: Array<{ id: string; label: string; prompt: string }>;
  checks: IntegrationCheck[];
}

export interface IntegrationInfoOptions {
  helperPath?: string;
  runtimeRoot?: string;
  runtimeAvailable?: boolean;
  platform?: NodeJS.Platform;
  executablePath?: string;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function validAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  return value.length > 0 && value.length <= 32_767 && !/[\u0000-\u001f\u007f]/.test(value)
    && path.isAbsolute(value) && (platform !== "win32" || !value.includes('"'));
}

/** Copyable configuration only: never edits a client config, launches a process, or reads the runtime nonce. */
export function getIntegrationInfo(
  options: IntegrationInfoOptions = {},
  dependencies: { isFile?: (path: string) => boolean } = {},
): IntegrationInfo {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const file = dependencies.isFile ?? isFile;
  const executable = options.executablePath ?? process.execPath;
  const helperName = platform === "win32" ? "aliasmode-mcp.exe" : "aliasmode-mcp";
  const proposedHelper = options.helperPath ?? path.join(path.dirname(executable), helperName);
  const validHelper = validAbsolutePath(proposedHelper, platform);
  const helperPresent = validHelper && file(proposedHelper);
  const helperPath = helperPresent ? proposedHelper : null;
  const base = path.dirname(proposedHelper);
  const runtimeRoot = options.runtimeRoot ?? process.env.ALIASMODE_PLAYWRIGHT_RUNTIME
    ?? (platform === "darwin" ? path.join(base, "..", "Resources", "playwright")
      : platform === "linux" ? path.join(base, "..", "lib", "AliasMode", "playwright")
      : path.join(base, "playwright"));
  const sidecarPath = path.join(base, platform === "win32" ? "aliasmode-sidecar.exe" : "aliasmode-sidecar");
  const runtimePresent = helperPresent && validAbsolutePath(runtimeRoot, platform)
    && file(sidecarPath)
    && file(path.join(runtimeRoot, "node", platform === "win32" ? "node.exe" : "node"))
    && file(path.join(runtimeRoot, "agent", "mcp-host.mjs"))
    && file(path.join(runtimeRoot, "agent", "mcp-scope.mjs"))
    && file(path.join(runtimeRoot, "agent", "runtime-client.mjs"))
    && file(path.join(runtimeRoot, "agent", "playwright-proxy.mjs"));
  const configs: IntegrationConfig[] = [];
  if (helperPath && runtimePresent) {
    const server = { command: helperPath, args: READ_ONLY_MCP_ARGS };
    configs.push({
      id: "generic", label: "Claude Desktop / Cursor", format: "json",
      destination: "Claude Desktop: claude_desktop_config.json · Cursor: .cursor/mcp.json",
      content: JSON.stringify({ mcpServers: { aliasmode: server } }, null, 2),
    });
    configs.push({
      id: "codex", label: "Codex", format: "toml", destination: "~/.codex/config.toml",
      // A JSON string is also a TOML basic string for the validated path above.
      // The desktop discovery deadline is 180 seconds, longer than the client's default.
      content: `[mcp_servers.aliasmode]\ncommand = ${JSON.stringify(helperPath)}\nargs = ${JSON.stringify(READ_ONLY_MCP_ARGS)}\nstartup_timeout_sec = 180\ntool_timeout_sec = 120\n`,
    });
    configs.push({
      id: "vscode", label: "VS Code", format: "json", destination: ".vscode/mcp.json",
      content: JSON.stringify({ servers: { aliasmode: { type: "stdio", ...server } } }, null, 2),
    });
  }
  const status = !helperPresent ? "helper_missing" : !runtimePresent ? "runtime_incomplete"
    : options.runtimeAvailable ? "ready" : "desktop_required";
  return {
    version: ALIASMODE_VERSION, transport: "stdio", status, connectionVerified: false, helperPath, configs,
    capabilities: [
      { id: "profiles", label: "环境管理", description: "列出、新建和编辑本地环境；会话数据保存在本机。", engines: ["chromium", "firefox"] },
      { id: "proxy-preview", label: "代理变更预览", description: "批量替换代理默认先预览，跳过运行中或匹配不明确的环境。", engines: ["chromium", "firefox"] },
      { id: "local-diagnostics", label: "Local diagnostics", description: "Review saved fingerprint evidence and detect local proxy listeners without opening a browser.", engines: ["chromium", "firefox"] },
      { id: "browser", label: "浏览器自动化", description: "打开和选择环境后，使用快照、导航、点击与截图等工具；可用工具由运行内核决定。", engines: ["chromium", "firefox"] },
      { id: "chromium-tools", label: "Chromium 扩展能力", description: "支持 CDP、PDF 等 Chromium 能力；Firefox 不提供 CDP 与 PDF。", engines: ["chromium"] },
    ],
    tools: catalog.aliasModeTools.map((tool) => ({
      name: tool.name, title: tool.annotations.title, description: tool.description,
      readOnly: tool.annotations.readOnlyHint, destructive: tool.annotations.destructiveHint,
      openWorld: tool.annotations.openWorldHint,
    })),
    workflows: [
      { id: "local-readiness", label: "Fingerprint & proxy readiness", prompt: "Inspect the profile I specify with aliasmode_fingerprint_review, then use aliasmode_network_discover to find local proxy listeners. Separate saved fingerprint evidence from unchecked process liveness and missing measurements. Summarize findings and next steps without opening a browser or changing settings." },
      { id: "inventory", label: "环境巡检", prompt: "请使用猫步 MCP 列出我的本地浏览器环境，按分组总结数量和运行状态，并指出缺少代理的环境。只读取信息，不修改环境。" },
      { id: "proxy-preview", label: "代理替换计划", prompt: "请先列出猫步本地环境。等我提供代理清单后，用 dryRun=true 预览代理替换，说明将改变的环境和跳过原因；在我确认前不要应用。" },
      { id: "qa", label: "网站兼容性检查", prompt: "请等我指定环境和自有测试网站后，使用猫步 MCP 打开该环境并检查页面加载、标题和可访问性快照，记录问题。不要提交表单、付款或发送消息。" },
    ],
    checks: [
      { id: "helper", status: helperPresent ? "pass" : "fail", message: helperPresent ? "已找到本机 MCP 启动程序。" : "未找到本机 MCP 启动程序，请完成桌面构建并从桌面版打开设置。" },
      { id: "runtime", status: runtimePresent ? "pass" : "fail", message: runtimePresent ? "MCP 运行所需的 sidecar、Node 与协议模块已就绪。" : "MCP 运行资源不完整，请重新准备或安装桌面资源。" },
      { id: "desktop", status: options.runtimeAvailable ? "pass" : "warn", message: options.runtimeAvailable ? "桌面服务已就绪。" : "当前页面未确认桌面服务；连接前请打开桌面应用。" },
      { id: "scope", status: "pass", message: "Client configurations use read-only permissions. Choose --scope profiles to create, edit, or delete environments, --scope browser to control browsers, or --scope full for both." },
      { id: "handshake", status: "warn", message: "尚未验证客户端 MCP 握手。粘贴配置并重启客户端后，在客户端工具列表中确认 aliasmode。" },
    ],
  };
}
