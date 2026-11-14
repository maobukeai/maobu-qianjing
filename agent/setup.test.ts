import { expect, test } from "bun:test";
import { configureClients, type CommandRunner } from "./setup.ts";

test("setup uses each client's supported MCP registration command", async () => {
  const calls: Array<[string, string[]]> = [];
  const inputs: Array<[string, string[], string | undefined]> = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push([command, args]);
    inputs.push([command, args, input]);
    return { found: true, code: 0 };
  };
  const helper = "C:\\Program Files\\AliasMode\\aliasmode-mcp.exe";
  const command = "C:\\Program Files\\AliasMode\\playwright\\node\\node.exe";
  const host = "C:\\Program Files\\AliasMode\\playwright\\agent\\mcp-host.mjs";
  const result = await configureClients({ helper, command, args: [host], run });

  expect(result.clients).toEqual([
    { client: "claude", status: "configured", restartRequired: true },
    { client: "codex", status: "configured", restartRequired: true },
    { client: "openclaw", status: "configured", restartRequired: true },
    { client: "hermes", status: "configured", restartRequired: true },
  ]);
  expect(calls.some(([, args]) => ["remove", "unset"].includes(args[1] ?? ""))).toBe(false);
  expect(calls).toContainEqual([
    "claude",
    ["mcp", "add", "--scope", "user", "aliasmode", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "codex",
    ["mcp", "add", "aliasmode", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "openclaw",
    ["mcp", "add", "aliasmode", "--command", command, "--arg", host],
  ]);
  expect(calls).toContainEqual([
    "hermes",
    ["mcp", "add", "aliasmode", "--command", command, "--args", host],
  ]);
  expect(inputs).toContainEqual([
    "hermes",
    ["mcp", "add", "aliasmode", "--command", command, "--args", host],
    "y\n",
  ]);
  expect(inputs.filter(([client]) => client !== "hermes").every(([, , input]) => input === undefined)).toBe(true);
  expect(result.generic.mcpServers.aliasmode).toEqual({ command, args: [host] });
});

test("setup reports a detected client registration failure", async () => {
  const run: CommandRunner = async (_command, args) => ({
    found: true,
    code: args[1] === "add" ? 1 : 0,
  });
  const result = await configureClients({
    helper: "C:\\AliasMode\\aliasmode-mcp.exe",
    clients: ["claude"],
    run,
  });
  expect(result.clients).toEqual([{
    client: "claude",
    status: "failed",
    restartRequired: false,
    reason: "registration_failed",
  }]);
});

test("setup is repeatable and reports clients that are not installed", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") return { found: false, code: 1 };
    return { found: true, code: 0 };
  };
  const options = {
    helper: "C:\\AliasMode\\aliasmode-mcp.exe",
    clients: ["claude", "codex"] as const,
    run,
  };

  const first = await configureClients({ ...options, clients: [...options.clients] });
  const firstCalls = [...calls];
  calls.length = 0;
  const second = await configureClients({ ...options, clients: [...options.clients] });

  expect(second).toEqual(first);
  expect(first.mcp).toEqual({ command: options.helper, args: ["serve"] });
  expect(calls).toEqual(firstCalls);
  expect(first.clients[1]).toEqual({
    client: "codex",
    status: "not_installed",
    restartRequired: false,
    reason: "command_not_found",
  });
  expect(calls.some((call) => call.startsWith("codex mcp add"))).toBe(false);
});

test("failed registration never deletes the existing client configuration", async () => {
  for (const client of ["claude", "codex", "openclaw", "hermes"] as const) {
    const existing = { command: "C:\\Existing\\aliasmode-mcp.exe", args: ["serve"] };
    let saved: typeof existing | null = structuredClone(existing);
    const run: CommandRunner = async (_command, args) => {
      if (["remove", "unset"].includes(args[1] ?? "")) saved = null;
      return { found: true, code: args[1] === "add" ? 1 : 0 };
    };
    const result = await configureClients({ helper: "C:\\New\\aliasmode-mcp.exe", clients: [client], run });
    expect(saved).toEqual(existing);
    expect(result.clients[0]?.status).toBe("failed");
    expect(result.clients[0]?.restartRequired).toBe(false);
    expect(result.generic.mcpServers.aliasmode.command).toBe("C:\\New\\aliasmode-mcp.exe");
  }
});

test("a repeated client selection does not register the same client twice", async () => {
  const calls: string[][] = [];
  const result = await configureClients({
    helper: "C:\\Maobu\\aliasmode-mcp.exe", clients: ["codex", "codex"],
    run: async (_command, args) => { calls.push(args); return { found: true, code: 0 }; },
  });
  expect(result.clients.length).toBe(1);
  expect(calls.filter(args => args[1] === "add").length).toBe(1);
});
