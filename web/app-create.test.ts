import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["success", "response-error", "network-error", "forced-host-auto", "settings-navigation", "local-proxy-draft", "workspace-quick-switch", "reuse-success", "reuse-late", "reuse-failure", "reuse-host-override", "launch-recovery"]) {
  const subject = scenario === "settings-navigation" ? "settings navigation" : scenario === "workspace-quick-switch" ? "workspace navigation" : scenario === "launch-recovery" ? "launch recovery" : "creation lifecycle";
  test(`actual App ${subject}: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-create-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("full App creation interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
