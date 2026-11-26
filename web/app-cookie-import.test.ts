import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["partial-retry", "close-navigation", "refresh-lease", "unknown-no-replay", "original-workspace", "owner-unmount", "pending-review-ownership", "pending-review-retry"]) {
  test(`actual App cookie import: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-cookie-import-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App cookie import fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
