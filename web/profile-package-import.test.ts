import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["busy-source", "expired-review"]) {
  test(`package import review: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-package-import-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("profile package import fixture passed");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  });
}
