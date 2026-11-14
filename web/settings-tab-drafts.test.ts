import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["draft-sync", "draft-updates", "failed-sync", "failed-updates", "workspace-isolation", "hidden-native", "hidden-load", "hidden-focus", "null-tab", "network-memory"]) {
  test(`settings drafts survive tab navigation: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/settings-tab-drafts-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("settings tab drafts fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
