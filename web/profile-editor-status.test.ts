import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { ProfileEditorStatus, type ProfileEditorStatusProps } from "./profile-editor-status.tsx";

function markup(props: ProfileEditorStatusProps) { return renderToStaticMarkup(createElement(I18nProvider, { children: createElement(ProfileEditorStatus, props) })); }
test("create footer describes profile configuration without claiming exit IP or fingerprint verification", () => {
  const html = markup({ kind: "create", createSummary: { browserLabel: "Chromium", hasProxy: false, manualFingerprint: false }, hasValidationError: false, hasSaveError: false, onLocateProblem() {} });
  expect(html).toContain("No profile proxy"); expect(html).toContain("Default fingerprint settings");
  expect(html).not.toMatch(/Direct connection|verified|progressbar|aria-busy|Review changes|View problem/);
});
test("unsafe extra values and unknown runtime labels cannot reach footer markup", () => {
  const html = markup({ kind: "create", createSummary: { browserLabel: "PRIVATE_PASSWORD" as any, hasProxy: true, manualFingerprint: true, credentials: "PRIVATE_CREDENTIALS" } as any, hasValidationError: false, hasSaveError: false, onLocateProblem() {} });
  expect(html).toContain("Profile proxy configured"); expect(html).toContain("Custom fingerprint settings"); expect(html).not.toContain("PRIVATE");
});
for (const scenario of ["edit-review", "error-focus", "save-error", "create-change", "buttons", "reduced"]) {
  test(`profile editor footer real DOM: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/profile-editor-status-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("profile editor status DOM passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
