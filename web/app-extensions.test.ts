import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["remove-unrelated", "remove-selected", "defaults-refresh-failure", "roster-refresh-failure", "cross-group-discard", "conflict-409", "invalid-preview", "missing-group-draft", "all-missing-drafts"]) {
  test(`actual App extension drafts: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-extensions-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("actual App extensions fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 18_000);
}
