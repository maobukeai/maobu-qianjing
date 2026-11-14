import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["download-failure", "refresh-failure", "check-failure", "navigation-busy", "draft-cancel", "draft-recheck", "scope-changed", "native-overlay"]) {
  test(`signed update interactions: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/signed-updates-dom.tsx"), scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("signed update interaction fixture passed");
  }, 15_000);
}
