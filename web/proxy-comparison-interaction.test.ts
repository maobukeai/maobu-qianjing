import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["same", "different", "unknown"]) {
  test(`proxy result presents reachability with ${scenario} exit comparison`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/proxy-comparison-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      expect(output).toContain("proxy comparison interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
