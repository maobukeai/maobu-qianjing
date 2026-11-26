import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["server-restore", "loading-guard", "late-layout-edit", "save-failure-retry", "two-entry-persistence", "compact-select", "missing-server-value", "unknown-server-value", "read-failure-retry"]) {
  test(`actual App density preference: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-roster-density-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App density fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
