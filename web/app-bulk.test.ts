import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["bounded-stop-cross-page", "retry-refresh-gate", "retry-current-state", "strict-api-result", "ineligible-targets", "close-ineligible", "owner-unmount", "workspace-maintenance-gate", "external-workspace-change", "successful-batch-workspace-refresh"]) {
  test(`actual App bulk task: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-bulk-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("actual App bulk task interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
