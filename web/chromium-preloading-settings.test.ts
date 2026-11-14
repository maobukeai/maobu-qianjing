import { expect, test } from "bun:test";
import { resolve } from "node:path";
for (const scenario of ["save", "legacy", "restore", "load-retry", "save-failure", "unacknowledged", "double-submit", "unmount"]) {
  test(`Chromium preloading workspace settings: ${scenario} (actual DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/chromium-preloading-settings-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, ".."), timeout: 12_000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("Chromium preloading settings fixture passed");
  }, 15_000);
}
