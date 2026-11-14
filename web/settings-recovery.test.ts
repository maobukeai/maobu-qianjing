import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["updates-history", "updates-settings", "sync-settings", "updates-navigation", "sync-navigation", "updates-save-navigation", "sync-save-navigation", "updates-history-save-race", "network-names-en", "network-names-zh", "network-custom"]) {
  test(`settings recovery: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/settings-recovery-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("settings recovery interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
