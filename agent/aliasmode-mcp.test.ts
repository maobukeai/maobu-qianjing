import { expect, test } from "bun:test";
import { join } from "node:path";

test("unsupported helper commands fail before discovering or starting a desktop runtime", async () => {
  for (const args of [["create", "--name", "test"], ["list"], ["revoke", "--id", "test"], []]) {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "aliasmode-mcp.ts"),
      "remote-mcp",
      ...args,
    ], {
      env: { ...process.env, ALIASMODE_DESKTOP_EXE: join(import.meta.dir, "missing-desktop.exe") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "unknown 猫步·千境 MCP command: remote-mcp",
    });
  }
});

test("MCP scope help and invalid selections exit before starting the host", async () => {
  const helper = join(import.meta.dir, "aliasmode-mcp.ts");
  const help = Bun.spawnSync([process.execPath, helper, "serve", "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("The default scope allows read-only inventory and local diagnostics.");
  for (const args of [["--scope"], ["--scope", "bad"], ["--scope", "browser", "--scope", "full"], ["--full"]]) {
    const child = Bun.spawnSync([process.execPath, helper, "serve", ...args]);
    expect(child.exitCode).toBe(1);
    expect(JSON.parse(child.stdout.toString())).toEqual({ ok: false, error: "Expected serve [--scope read-only|profiles|browser|full]." });
    expect(child.stderr.toString()).toBe("");
  }
});
