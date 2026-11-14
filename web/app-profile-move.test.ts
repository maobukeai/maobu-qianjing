import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["success-dupe", "failure-retry", "uncertain-recheck", "read-failure", "read-gate-maintenance", "selection-preserved", "same-id-new-intent", "ungrouped", "new-group-freeze", "owner-unmount", "literal-group-name", "retry-keeps-new-target", "partial-missing"]) {
  test(`actual App profile move: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-profile-move-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App profile move fixture passed"); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
