import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["handoff", "wrong-preview-target"]) {
  test(`local proxy assignment: ${scenario} (isolated DOM)`, async () => {
    const fixture = resolve(import.meta.dir, "../test-fixtures/local-proxy-assignment-page-dom.tsx");
    const child = Bun.spawn([process.execPath, "--no-env-file", fixture, scenario], {
      stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, ".."),
    });
    const timer = setTimeout(() => child.kill(), 8_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("local proxy assignment fixture passed");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }, 10_000);
}
