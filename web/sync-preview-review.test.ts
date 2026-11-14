import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["exact-review", "list-recovery", "stale-response", "focus-draft"]) {
  test(`snapshot review: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/sync-preview-review-dom.tsx"), scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("sync preview review fixture passed");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }, 12_000);
}
