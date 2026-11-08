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
