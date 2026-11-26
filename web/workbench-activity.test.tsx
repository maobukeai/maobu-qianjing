import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { WorkbenchActivity } from "./workbench-activity.tsx";

test("an empty activity view adds no idle markup or controls", () => {
  expect(renderToStaticMarkup(<I18nProvider><WorkbenchActivity items={[]} /></I18nProvider>)).toBe("");
});

for (const scenario of ["empty", "single-task", "sort-count-progress", "view-focus-exit", "keyboard", "outside-reopen", "remove-focus", "remove-closed-trigger", "reduced", "system-reduce-exit", "width-1440", "width-1280", "width-700", "width-360", "width-320", "unmount"]) {
  test(`workbench activity: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/workbench-activity-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("workbench activity fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
