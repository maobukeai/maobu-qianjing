import { expect, test } from "bun:test";
import { resolve } from "node:path";
for (const scenario of ["dirty-keep", "discard-native-cancel", "busy", "busy-clean", "clean", "keyboard", "sending-focus", "draft-scroll", "nested-guard", "reduced", "exit-inert", "cancel-rejection", "unmount", "late-cancel", "connection-error", "broken-metadata", "owner-isolation", "inert-restoration"]) {
  test(`desktop close real DOM: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/desktop-close-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("desktop close DOM passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 14_000);
}
