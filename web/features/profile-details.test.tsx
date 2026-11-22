import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UiProfile } from "../api.ts";
import { I18nProvider } from "../i18n.tsx";
import { ProfileDetailsPanel } from "./profile-details.tsx";

test("details expose only roster summary fields without credentials or verification claims", () => {
  const profile = {
    id: "environment-a", name: "QA profile", engine: "chromium", chromiumRuntime: "aliasmode", group: "QA", platform: "example.test", tags: ["test"],
    proxy: "user:PRIVATE_PROXY_PASSWORD@127.0.0.1:8080", timezone: "Asia/Shanghai", cookieCount: 3, seeded: true, screen: "1920x1080", has2fa: true,
    serial: 7, running: true, restartPending: true, debugPort: 49999,
    fpVerdict: { verdict: "match", differences: [] }, fpCapturedAt: "PRIVATE_SAMPLE", password: "PRIVATE_ACCOUNT_PASSWORD", controlURL: "PRIVATE_CONTROL_URL",
  } as UiProfile;
  const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(ProfileDetailsPanel, { profile, onClose() {}, onEdit() {}, onInspect() {} }) }));
  expect(html).toContain('role="complementary"');
  expect(html).toContain("QA profile"); expect(html).toContain("Chromium"); expect(html).toContain("Proxy details unavailable");
  expect(html).toContain("Saved changes apply at the next start."); expect(html).toContain("Saved cookies");
  expect(html).not.toMatch(/PRIVATE_|49999|aria-modal|role="dialog"|Stored import match|Fingerprint passed/);
  const empty = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(ProfileDetailsPanel, { profile: null, onClose() {}, onEdit() {}, onInspect() {} }) }));
  expect(empty).toBe("");
});

test("details DOM keeps table focus available and actions target the current profile", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../../test-fixtures/profile-details-dom.tsx")], {
    cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("profile details DOM passed");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}, 12_000);
