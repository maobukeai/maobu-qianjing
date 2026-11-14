import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["edit-review", "edit-invalid-screen", "edit-save-error", "create-summary", "create-save-error", "create-pending-proxy", "create-clipboard-proxy", "create-window-controls", "edit-window-controls", "inspection-field-focus"]) {
  test(`actual App editor status: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-editor-status-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App editor status fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 18_000);
}
