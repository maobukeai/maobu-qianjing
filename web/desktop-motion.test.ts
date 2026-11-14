import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DESKTOP_MOTION_KEY, desktopMotionCookie, readDesktopMotionPreference, resolveDesktopMotion } from "./desktop-motion.tsx";

test("desktop motion uses the host cookie across random loopback ports", () => {
  expect(readDesktopMotionPreference(`other=value; ${DESKTOP_MOTION_KEY}=reduced`, "full")).toBe("reduced");
  expect(readDesktopMotionPreference(`${DESKTOP_MOTION_KEY}=full`, "reduced")).toBe("full");
  expect(desktopMotionCookie("reduced")).toBe("aliasmode.shell.motion=reduced; Path=/; Max-Age=31536000; SameSite=Strict");
});
test("unrecognized saved motion values safely fall back to the system", () => {
  expect(readDesktopMotionPreference(`${DESKTOP_MOTION_KEY}=invalid`, "reduced")).toBe("reduced");
  expect(readDesktopMotionPreference("", "invalid")).toBe("system");
  expect(readDesktopMotionPreference("", null)).toBe("system");
});
test("system reduced motion takes priority even when full motion was selected", () => {
  for (const preference of ["system", "reduced", "full"] as const) expect(resolveDesktopMotion(preference, true)).toBe("reduced");
  expect(resolveDesktopMotion("system", false)).toBe("full");
  expect(resolveDesktopMotion("reduced", false)).toBe("reduced");
});
for (const scenario of ["preference", "presence", "reduced-exit", "panel", "storage-blocked"]) {
  test(`desktop motion interaction: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/desktop-motion-dom.tsx"), scenario], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..") });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("desktop motion interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}
