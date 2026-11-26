import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["add-and-save", "cancel", "failure-retry", "limits", "legacy-repair", "clear", "remove-focus", "stale-success", "stale-failure", "stale-session", "keyboard", "motion-exit", "motion-reopen", "reduced-motion"]) {
  test(`profile tags: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-tags-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile tags interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
