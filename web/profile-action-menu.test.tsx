import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { ProfileActionMenu } from "./profile-action-menu.tsx";

test("an unopened row menu renders an accessible trigger without a server-side portal", () => {
  const markup = renderToStaticMarkup(<ProfileActionMenu label="Actions for fixture" icon={null}><button role="menuitem">Edit</button></ProfileActionMenu>);
  expect(markup).toContain('aria-haspopup="menu"'); expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('role="menu"'); expect(markup).not.toContain("desktop-motion-presence");
});
for (const scenario of ["row-activation-exit", "row-reopen-position", "row-outside-reduce", "row-layout-focus", "row-keyboard-refresh"]) {
  test(`row action menu motion: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/menu-motion-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("menu motion interaction fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 15_000);
}

test("profile roster row menu exposes Delete environment (enabled when stopped, disabled when running)", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { act } from "react";
    import { createWebDomHarness } from "./test-fixtures/web-dom.ts";
    import { I18nProvider } from "./web/i18n.tsx";
    import { ProfileRosterRow } from "./web/features/profile-roster-row.tsx";

    const dom = await createWebDomHarness();
    const deleted = [];
    const baseProfile = {
      id: "p1", name: "Env One", group: "", engine: "chromium", runtime: "aliasmode", runtimeLabel: "Chromium",
      proxy: "", proxyError: null, os: "windows", running: false, pid: null, debugPort: null,
      notes: "", tags: [], lastOpenedAt: null, mobilePersona: null, has2fa: false,
      extensions: [], cookieCount: 0, dirty: false,
    };
    const handlers = {
      openDetails: () => {}, openEdit: () => {}, openPendingCookies: async () => {}, openCookie: () => {},
      act: async () => {}, openInspection: () => {}, reuseProfileConfiguration: async () => {}, openProfileTags: () => {},
      copy2fa: async () => {}, toggleFavorite: async () => {}, changeProfileSelection: () => {},
      setLaunchFailure: () => {}, openNetworkSettings: () => {}, openLogs: () => {},
      deleteProfile: async (p) => { deleted.push(p.id); },
    };
    const rowProps = (p) => ({
      p, no: { value: "1", custom: false }, isSelected: false, isBusy: false, isFavorite: false,
      isReuseLoading: false, twoFaFlashed: false, startLabel: "Start", launchFailure: undefined,
      rosterScope: "all", language: "en-US", hiddenCols: new Set(), viewPreferencesReady: true,
      viewPreferenceBusy: false, rangeKeyboardActivation: { current: null }, handlers, t: (s) => s,
    });

    try {
      await dom.render(<I18nProvider><table><tbody><ProfileRosterRow {...rowProps(baseProfile)} /></tbody></table></I18nProvider>);
      const primary = dom.container.querySelector(".profile-name-primary");
      assert.ok(primary);
      assert.ok(primary.querySelector(".profile-name-line"));
      assert.ok(primary.querySelector(".sub .profile-engine-chip"));
      const trigger = dom.container.querySelector(".profile-menu-trigger");
      assert.ok(trigger);
      await act(async () => { trigger.click(); });
      const menu = dom.window.document.querySelector(".profile-actions-menu[role='menu']");
      assert.ok(menu);
      const delBtn = [...menu.querySelectorAll("button")].find((b) => b.textContent?.includes("Delete environment"));
      assert.ok(delBtn);
      assert.equal(delBtn.disabled, false);
      await act(async () => { delBtn.click(); });
      assert.deepEqual(deleted, ["p1"]);

      await dom.render(<I18nProvider><table><tbody><ProfileRosterRow {...rowProps({ ...baseProfile, running: true })} /></tbody></table></I18nProvider>);
      const stopBtn = dom.container.querySelector(".row-stop");
      assert.ok(stopBtn);
      assert.equal(stopBtn.disabled, false);
      assert.ok(stopBtn.textContent?.includes("Stop"));

      await dom.render(<I18nProvider><table><tbody><ProfileRosterRow {...{ ...rowProps({ ...baseProfile, running: true }), isBusy: true }} /></tbody></table></I18nProvider>);
      const busyStopBtn = dom.container.querySelector(".row-stop");
      assert.ok(busyStopBtn);
      assert.equal(busyStopBtn.disabled, true);
      assert.ok(busyStopBtn.textContent?.includes("Stopping…"));

      const trigger2 = dom.container.querySelector(".profile-menu-trigger");
      await act(async () => { trigger2.click(); });
      const menu2 = dom.window.document.querySelector(".profile-actions-menu[role='menu']");
      const delBtn2 = [...menu2.querySelectorAll("button")].find((b) => b.textContent?.includes("Delete environment"));
      assert.ok(delBtn2);
      assert.equal(delBtn2.disabled, true);
      assert.equal(delBtn2.getAttribute("title"), "Stop this environment before deleting it.");
      console.log("row-delete-option passed");
    } finally {
      await dom.unmount();
    }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 12_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("row-delete-option passed");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}, 15_000);
