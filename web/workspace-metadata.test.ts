import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const [scenario, name] of [
  ["rebase", "workspace metadata follows clean refreshes, reviews conflicts and retains rejected drafts"],
  ["archive", "workspace archive reconciles the real metadata receipt when the catalog read fails"],
  ["restart", "workspace switch and retry review live drafts without clearing them on dismissal or failure"],
] as const) {
  test(name, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/workspace-metadata-dom.tsx"), scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("workspace metadata fixture passed");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }, 12_000);
}
