import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { ProfileActionMenu } from "./profile-action-menu.tsx";

test("an unopened row menu renders an accessible trigger without a server-side portal", () => {
  const markup = renderToStaticMarkup(<ProfileActionMenu label="Actions for fixture" icon={null}><button role="menuitem">Edit</button></ProfileActionMenu>);
  expect(markup).toContain('aria-haspopup="menu"'); expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('role="menu"'); expect(markup).not.toContain("desktop-motion-presence");
});
for (const scenario of ["row-activation-exit", "row-reopen-position", "row-outside-reduce", "row-layout-focus"]) {
  test(`row action menu motion: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/menu-motion-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("menu motion interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
