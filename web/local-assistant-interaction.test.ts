import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["context-and-memory", "cancel-restores-draft", "unmount-cancels", "suggestion-append", "suggestion-overflow", "suggestion-dismiss", "settings-toggle", "task-context-and-progress", "failure-restores-draft"]) {
  test(`local assistant interaction: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/local-assistant-dom.tsx"), scenario], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      expect(output).toContain("local assistant interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
