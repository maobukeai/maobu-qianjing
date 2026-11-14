import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["save-snapshot", "failure-retry", "apply-view", "delete-undo", "undo-retry", "duplicate-submit", "loading-guard", "name-validation", "view-limit", "unmount-pending"]) {
  test(`saved environment views: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/roster-views-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("roster views interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
