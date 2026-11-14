import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["manage-services", "retry-and-workspace-switch"]) {
  test(`model services: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/model-services-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("model services interaction fixture passed");
  }, 15_000);
}
