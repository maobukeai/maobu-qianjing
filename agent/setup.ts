import spawn from "cross-spawn";

export type SetupClient = "claude" | "codex" | "openclaw" | "hermes";

export interface CommandResult {
  found: boolean;
  code: number;
}

export type CommandRunner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

const CLIENTS: Record<SetupClient, {
  command: string;
  add: (command: string, args: string[]) => string[];
  input?: string;
}> = {
  claude: {
    command: "claude",
    add: (command, args) => ["mcp", "add", "--scope", "user", "aliasmode", "--", command, ...args],
  },
  codex: {
    command: "codex",
    add: (command, args) => ["mcp", "add", "aliasmode", "--", command, ...args],
  },
  openclaw: {
    command: "openclaw",
    add: (command, args) => [
      "mcp", "add", "aliasmode", "--command", command,
      ...args.flatMap((arg) => ["--arg", arg]),
    ],
  },
  hermes: {
    command: "hermes",
    add: (command, args) => ["mcp", "add", "aliasmode", "--command", command, "--args", ...args],
    input: "y\n",
  },
};

export const defaultCommandRunner: CommandRunner = async (command, args, input) => {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    if (input !== undefined) child.stdin?.end(input);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ found: error.code !== "ENOENT", code: 1 });
    });
    child.once("exit", (code) => resolve({ found: true, code: code ?? 1 }));
  });
};

export async function configureClients(options: {
  helper: string;
  command?: string;
  args?: string[];
  clients?: SetupClient[];
  run?: CommandRunner;
}) {
  const run = options.run ?? defaultCommandRunner;
  const command = options.command ?? options.helper;
  const commandArgs = options.args ?? ["serve"];
  const clients = [...new Set(options.clients ?? (Object.keys(CLIENTS) as SetupClient[]))];
  const statuses: Array<{
    client: SetupClient;
    status: "configured" | "not_installed" | "failed";
    restartRequired: boolean;
    reason?: "command_not_found" | "registration_failed";
  }> = [];

  for (const client of clients) {
    const config = CLIENTS[client];
    const detected = await run(config.command, ["--version"]);
    if (!detected.found) {
      statuses.push({
        client,
        status: "not_installed",
        restartRequired: false,
        reason: "command_not_found",
      });
      continue;
    }
    // Let the client's own add/upsert operation handle an existing entry. Never
    // pre-delete it: registration can fail (or an older CLI can reject these
    // flags), and a rejected add must not discard the user's working server.
    // A CLI that refuses an existing name reports failure and leaves the
    // copyable generic configuration available for manual reconciliation.
    const added = await run(config.command, config.add(command, commandArgs), config.input);
    statuses.push({
      client,
      status: added.code === 0 ? "configured" : "failed",
      restartRequired: added.code === 0,
      ...(added.code === 0 ? {} : { reason: "registration_failed" as const }),
    });
  }

  return {
    helper: options.helper,
    mcp: { command, args: commandArgs },
    clients: statuses,
    generic: {
      mcpServers: {
        aliasmode: {
          command,
          args: commandArgs,
        },
      },
    },
  };
}
