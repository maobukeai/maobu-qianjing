import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const scenario of ["navigation-memory", "navigation-stops", "navigation-unconfirmed", "readonly-navigation", "cancel-late", "cancel-false", "cancel-error", "workspace-memory", "workspace-inflight", "workspace-models", "workspace-cancel-late", "workspace-boundary-click", "connection-retry", "model-disappeared", "wait-clock", "no-storage", "empty-scroll", "reading-focus", "desktop-draft", "welcome-preserves-draft", "copy-conversation", "find-conversation", "api-service-context", "api-service-readiness"]) {
  test(`local assistant workspace ownership: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/local-assistant-session-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("local assistant workspace session fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
