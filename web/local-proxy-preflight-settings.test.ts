import { expect, test } from "bun:test";
import { resolve } from "node:path";
for (const scenario of ["save", "legacy", "load-retry", "save-failure", "same-frame-save"]) {
  test(`local proxy startup preference: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/local-proxy-preflight-settings-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..") });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("local proxy startup preference fixture passed");
  }, 15000);
}
