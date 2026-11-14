import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["library-search", "group-preview", "stale-preview", "remove-retry", "remove-stale", "loading-guard", "preview-failure", "preview-missing", "server-preview", "preview-pending", "preview-unmount", "preview-selection-changed", "stale-data", "unavailable-group", "confirm-recovery", "large-frozen-review"]) {
  test(`extension management: ${scenario}`, async () => {
    const fixture = scenario === "large-frozen-review" ? "extensions-scale-dom.tsx" : "extensions-page-dom.tsx";
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures", fixture), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      expect(output).toContain("extension management fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
