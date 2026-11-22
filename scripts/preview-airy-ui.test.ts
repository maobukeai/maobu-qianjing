import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const frameless of [false, true]) {
  test(`isolated UI fixture authenticates browser GETs and retains real workspace protection (${frameless ? "frameless" : "browser"})`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "preview-airy-ui.ts"), "--smoke", ...(frameless ? ["--frameless"] : [])], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("UI QA smoke passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 35_000);
}
