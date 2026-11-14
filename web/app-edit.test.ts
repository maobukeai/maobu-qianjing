import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["load-retry", "load-malformed", "same-id-load", "same-id-error", "save-success", "save-response-error", "save-network-error", "save-conflict", "totp-session", "quality-edit", "quality-assistant", "signed-startup-view", "signed-startup-dismiss", "edit-noop", "edit-concurrent-fields", "edit-quarantine-preserve", "edit-quarantine-clear", "edit-timezone-rebase", "edit-invalid-locale", "edit-extensions-clear", "edit-legacy-partial", "edit-missing-ok", "edit-fingerprint-confirm"]) {
  test(`actual App workflow: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-edit-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("full App edit interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
