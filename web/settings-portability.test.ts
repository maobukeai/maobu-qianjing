import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["create-refresh-failure", "preview-refresh-preserve", "expired-preview", "failure-keeps-success", "disabled-empty", "announcement-source", "status-retry", "import-workspace-gate", "import-unmount", "import-refresh-failure", "import-receipt", "import-receipt-page", "import-receipt-count-mismatch", "import-receipt-focus-moved", "all-conflicts", "missing-selected-file", "preview-new-focus"]) {
  test(`update and snapshot usability: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/settings-portability-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("settings portability fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
