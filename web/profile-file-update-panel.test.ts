import { expect, test } from "bun:test";
import { resolve } from "node:path";
for (const scenario of ["focus-and-selection", "pagination-and-privacy", "file-format-rejection"]) {
  test(`file update real DOM: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-file-update-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile file update DOM fixture passed"); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
