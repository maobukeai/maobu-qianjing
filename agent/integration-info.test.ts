import { describe, expect, test } from "bun:test";
import { getIntegrationInfo } from "./integration-info.ts";
import catalog from "../docs/public/mcp-tools/current-source.json";

const executablePath = "C:\\Program Files\\猫步千境\\aliasmode-sidecar.exe";
const helperPath = "C:\\Program Files\\猫步千境\\aliasmode-mcp.exe";
const runtimeRoot = "C:\\Program Files\\猫步千境\\playwright";
const options = { platform: "win32" as const, executablePath, runtimeRoot, runtimeAvailable: true };
const complete = { isFile: () => true };
const readOnlyArgs = ["serve", "--scope", "read-only"];

describe("AI integration readiness", () => {
  test("generates valid client formats for paths with spaces, unicode and Windows separators", () => {
    const info = getIntegrationInfo(options, complete);
    expect(info.status).toBe("ready");
    expect(info.helperPath).toBe(helperPath);
    expect(info.connectionVerified).toBe(false);
    const generic = JSON.parse(info.configs.find(c => c.id === "generic")!.content);
    expect(generic.mcpServers.aliasmode).toEqual({ command: helperPath, args: readOnlyArgs });
    const vscode = JSON.parse(info.configs.find(c => c.id === "vscode")!.content);
    expect(vscode.servers.aliasmode).toEqual({ type: "stdio", command: helperPath, args: readOnlyArgs });
    const codex = Bun.TOML.parse(info.configs.find(c => c.id === "codex")!.content) as any;
    expect(codex.mcp_servers.aliasmode.command).toBe(helperPath);
    expect(codex.mcp_servers.aliasmode.args).toEqual(readOnlyArgs);
    expect(codex.mcp_servers.aliasmode.startup_timeout_sec).toBe(180);
  });

  test("does not generate a fictitious executable for source-only or missing installations", () => {
    const info = getIntegrationInfo(options, { isFile: () => false });
    expect(info.status).toBe("helper_missing");
    expect(info.helperPath).toBeNull();
    expect(info.configs).toEqual([]);
    expect(info.checks.find(c => c.id === "helper")?.status).toBe("fail");
  });

  test("requires all bridge resources before offering copyable configuration", () => {
    for (const suffix of ["aliasmode-sidecar.exe", "node.exe", "mcp-host.mjs", "mcp-scope.mjs", "runtime-client.mjs", "playwright-proxy.mjs"]) {
      const info = getIntegrationInfo(options, { isFile: p => !p.endsWith(suffix) });
      expect(info.status).toBe("runtime_incomplete");
      expect(info.configs).toEqual([]);
    }
  });

  test("keeps desktop readiness distinct from client connection verification", () => {
    const info = getIntegrationInfo({ ...options, runtimeAvailable: false }, complete);
    expect(info.status).toBe("desktop_required");
    expect(info.configs.length).toBe(3);
    expect(info.checks.find(c => c.id === "handshake")?.status).toBe("warn");
  });

  test("rejects relative paths, control characters and invalid Windows quotes", () => {
    for (const invalid of ["helper.exe", "C:\\helper\n.exe", 'C:\\bad"helper.exe', "C:\\bad\u0000helper.exe"]) {
      const info = getIntegrationInfo({ ...options, helperPath: invalid }, complete);
      expect(info.status).toBe("helper_missing");
      expect(info.helperPath).toBeNull();
      expect(info.configs).toEqual([]);
    }
  });

  test("keeps capability tool names aligned with the generated source catalog", () => {
    const info = getIntegrationInfo(options, complete);
    expect(info.tools.map(t => t.name)).toEqual(catalog.aliasModeTools.map(t => t.name));
    expect(info.tools.some(t => t.name === "aliasmode_profiles_replace_proxies" && t.destructive)).toBe(true);
    const text = JSON.stringify(info);
    expect(text).not.toContain("agent-runtime.json");
    expect(text).not.toContain("nonce");
    expect(text).not.toContain("ws://");
  });

  test("resolves macOS and Linux bundled layouts without Windows path separators", () => {
    const paths: string[] = [];
    const dependencies = { isFile: (p: string) => { paths.push(p); return true; } };
    const mac = getIntegrationInfo({ platform: "darwin", executablePath: "/Applications/Maobu.app/Contents/MacOS/aliasmode-sidecar", runtimeRoot: "/Applications/Maobu.app/Contents/Resources/playwright" }, dependencies);
    expect(mac.helperPath).toBe("/Applications/Maobu.app/Contents/MacOS/aliasmode-mcp");
    expect(paths).toContain("/Applications/Maobu.app/Contents/Resources/playwright/node/node");
    paths.length = 0;
    const linux = getIntegrationInfo({ platform: "linux", executablePath: "/opt/maobu/bin/aliasmode-sidecar", runtimeRoot: "/opt/maobu/lib/AliasMode/playwright" }, dependencies);
    expect(linux.helperPath).toBe("/opt/maobu/bin/aliasmode-mcp");
    expect(paths).toContain("/opt/maobu/lib/AliasMode/playwright/agent/mcp-host.mjs");
  });
});
