import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const [language, mode] of [["en-US", "mixed"], ["zh-CN", "mixed"], ["en-US", "all-pass"], ["zh-CN", "all-pass"]]) {
  test(`real fingerprint report view: ${language}/${mode} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/fingerprint-quality-dom.tsx"), language!, mode!], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("localized fingerprint evidence fixture passed");
  }, 15_000);
}
