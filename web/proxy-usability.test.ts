import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["workflow-navigation", "input-validation", "stale-preview", "operation-context", "result-search", "loading-scope", "folder-hierarchy", "targeted-replacement", "targeted-receipt"]) {
  test(`proxy usability workflow: ${scenario} (isolated real DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/proxy-usability-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..") });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("proxy usability interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
