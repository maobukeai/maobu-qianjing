import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["references", "invalid-304", "legacy-clears-tag", "failure-preserves", "origin-isolation", "late-200", "late-304", "late-failure", "parse-race", "benchmark"]) {
  test(`profile roster conditional client: ${scenario} (isolated)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-roster-etag-client.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile roster conditional client fixture passed");
      if (scenario === "benchmark") console.log(stdout.trim());
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
