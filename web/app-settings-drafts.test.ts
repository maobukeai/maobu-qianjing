import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["tab-roundtrip", "page-roundtrip", "prepared-switch", "workspace-isolation", "local-proxy-handoff", "scripts-roundtrip", "runtime-activity"]) {
  test(`actual App draft integration: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-settings-drafts-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("actual App settings drafts fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
