import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["explicit-network", "direct", "stale-selection", "saved-change", "measurement", "retry-and-close", "source-filters", "safe-copy", "clipboard-unavailable", "copy-lifecycle", "no-measurement-claim", "overview-time-and-actions", "overview-browser-action"]) {
  test(`environment inspection workflow: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/environment-inspection-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..") });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("environment inspection interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
