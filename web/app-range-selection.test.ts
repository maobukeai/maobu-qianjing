import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["pointer-span", "clear-span-preserves-others", "keyboard", "filter-preserves-hidden", "filter-return-reset", "sort-reset", "collapse-reset", "page-reset", "explicit-clear-reset", "group-selection-reset", "repeat-explicit-event"]) {
  test(`actual App range selection: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/app-range-selection-dom.ts"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("actual App range selection fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
