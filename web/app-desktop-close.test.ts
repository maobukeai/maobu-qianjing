import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["loading-host", "create-dirty", "edit-dirty", "create-saving", "edit-saving", "settings-cross-page", "network-unsaved", "app-lock-unsaved", "app-lock-saving", "extension-source", "extension-other-group"]) {
  test(`actual App desktop close owners: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-desktop-close-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("actual App desktop close fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 18_000);
}
