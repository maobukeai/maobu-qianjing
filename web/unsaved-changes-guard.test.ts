import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["clean", "frozen-intent", "keep-editing", "keyboard", "reset", "unmount", "throw", "clean-throw", "fallback", "discard-focus", "reduced"]) {
  test(`unsaved editor close guard: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/unsaved-changes-guard-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("unsaved changes guard fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
