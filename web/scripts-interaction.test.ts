import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of [
  "switch-drafts", "discard-undo", "navigation-draft", "hidden-initial", "hidden-python-status", "workspace-owner", "workspace-late-save", "normalized-no-op",
  "save-failure", "save-refresh-failure", "replacement-keeps-draft", "revision-review", "unconfirmed-save",
  "hidden-save", "save-list-pending", "unavailable-draft",
  "run-focus-close", "run-start-once", "run-read-shared", "run-load-retry",
]) {
  test(`script workbench: ${scenario} (isolated real API DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/scripts-usability-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("script usability interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
