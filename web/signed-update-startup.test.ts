import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["guards", "available", "stale", "manual", "preference", "failure"]) {
  test(`signed startup ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/signed-update-startup-dom.tsx"), scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("signed startup fixture passed");
  }, 15000);
}
