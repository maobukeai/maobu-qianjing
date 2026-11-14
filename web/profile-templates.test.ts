import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["apply", "apply-rejected", "save-and-escape", "staged-delete", "revision-conflict", "load-retry", "disabled"]) {
  test(`profile presets: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/profile-templates-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile preset interaction fixture passed");
  }, 15_000);
}
