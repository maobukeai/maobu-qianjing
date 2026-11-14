import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["switcher-exit", "device-exit", "device-pending", "workspace-exit", "extension-exit", "extension-pending", "reduced-switcher", "reduced-device", "reduced-workspace", "reduced-extension", "unmount-exit"]) {
  test(`workspace and extension presence: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/workspace-extension-motion-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("workspace and extension motion fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
