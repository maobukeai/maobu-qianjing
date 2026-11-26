import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["file-modal", "paste-modal", "source-switch-file", "source-switch-paste", "explicit-overrides", "group-context-defaults", "pending-draft-freeze", "exit-reopen", "global-drop-cross-page", "false-result", "network-error", "missing-counts", "modal-drop-stage-only", "refresh-gate", "workspace-maintenance-gate"]) {
  test(`actual App import receipt: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-import-receipt-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App import receipt interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
