/** Browser half runs on Node, matching the production Playwright transport. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
const fixture = { url: process.argv[2] };
const output = process.argv[3];
const fixtureRows = Number(process.argv[4]);
console.log("UI QA: launching isolated Chrome with Node");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const outsideRequests = [];
const results = [];
let page;

function localeStrings(locale) {
  const messages = JSON.parse(readFileSync(new URL(`../web/locales/${locale}.json`, import.meta.url), "utf8"));
  return (key) => messages[key] ?? key;
}

async function checkLayout(locator, view) {
  const overflow = await locator.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.width + 2, `${view} overflows (${overflow.scroll}px within ${overflow.width}px)`);
  return overflow;
}

async function checkDesktopBridge(page, t) {
  assert.equal(await page.locator("html").getAttribute("data-qa-window-controls"), "simulated",
    "The desktop fixture must initialize under the production page CSP");
  const controls = page.getByRole("group", { name: t("Window controls"), exact: true });
  const maximize = controls.getByRole("button", { name: t("Maximize window"), exact: true });
  const restore = controls.getByRole("button", { name: t("Restore window"), exact: true });
  await maximize.press("Enter");
  await restore.waitFor();
  assert.equal(await page.locator("html").getAttribute("data-qa-window-maximized"), "true");
  await restore.press("Enter");
  await maximize.waitFor();
  assert.equal(await page.locator("html").getAttribute("data-qa-window-maximized"), "false");
  return { desktopControlsLoaded: true, keyboardMaximizeAndRestore: true };
}

async function checkImport(page, t, variant) {
  const trigger = page.locator(".profiles-workspace .page-actions").getByRole("button", { name: t("Import profiles"), exact: true });
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: t("Import profiles"), exact: true });
  await dialog.waitFor();
  await checkLayout(dialog, "Import dialog");
  const submit = dialog.getByRole("button", { name: t("Import profiles"), exact: true });
  const rules = dialog.locator(".import-transfer-details");
  const drop = dialog.locator(".bulkdrop");
  if (variant === "light-320") {
    const initial = await dialog.evaluate(panel => {
      const body = panel.querySelector(".modal-body");
      const footer = panel.querySelector(".modal-foot");
      const edge = body.getBoundingClientRect().bottom;
      return {
        fitsFirstView: body.scrollHeight <= body.clientHeight + 2,
        overridesVisible: panel.querySelector(".profile-import-assignments").getBoundingClientRect().bottom <= edge,
        rulesVisible: panel.querySelector(".import-transfer-details summary").getBoundingClientRect().bottom <= edge,
        footerVisible: footer.getBoundingClientRect().bottom <= window.innerHeight,
      };
    });
    assert.ok(Object.values(initial).every(Boolean), "At 320×530 the empty import shows the options, rules, and actions without scrolling");
  }
  const filename = "ui-qa.csv";
  const longName = `ui-qa-${"long-filename-".repeat(8)}.csv`;
  const file = name => ({ name, mimeType: "text/csv", buffer: Buffer.from("id,name\nui_qa_import,UI QA\n") });
  assert.equal(await drop.evaluate(node => node === document.activeElement), true, "The upload area receives initial focus");
  assert.equal(await submit.isEnabled(), false, "An import requires an explicit input");
  assert.equal(await rules.getAttribute("open"), null);
  await rules.locator("summary").press("Space");
  assert.equal(await rules.getAttribute("open"), "", "Import rules must open from the keyboard");
  await rules.locator("summary").press("Space");
  await rules.locator("summary").evaluate(node => node.blur());
  await page.screenshot({ path: join(output, `import-file-${variant}.png`) });
  if (variant === "light-1440") await dialog.screenshot({ path: join(output, "import-dialog-light.png") });

  const [template] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: t("CSV template"), exact: true }).press("Enter"),
  ]);
  assert.equal(template.suggestedFilename(), "maobu-qianjing-template.csv");
  await template.delete();

  const [picker] = await Promise.all([
    page.waitForEvent("filechooser"),
    drop.press("Enter"),
  ]);
  await picker.setFiles([file(filename), file(longName)]);
  await dialog.getByText(filename, { exact: true }).waitFor();
  await dialog.getByText(t("{count} files selected").replace("{count}", "2"), { exact: true }).waitFor();
  await checkLayout(dialog.locator(".profile-import-queue"), "File queue with a long filename");
  await page.screenshot({ path: join(output, `import-staged-${variant}.png`) });
  assert.equal(await submit.isEnabled(), true, "Choosing a file stages it for review");
  const fromFile = dialog.getByRole("button", { name: t("From file"), exact: true });
  const paste = dialog.getByRole("button", { name: t("Paste text"), exact: true });
  const pastedDraft = "id=ui_qa_import\nname=UI QA";
  await paste.press("Enter");
  assert.equal(await submit.isEnabled(), false, "Staged files cannot enable an empty paste import");
  await dialog.locator("textarea").fill(pastedDraft);
  await fromFile.press("Enter");
  assert.equal(await dialog.getByText(filename, { exact: true }).isVisible(), true, "Keyboard source switches keep staged files");
  await dialog.getByRole("button", { name: t("Remove file {name}").replace("{name}", filename), exact: true }).press("Enter");
  assert.equal(await drop.evaluate(node => node === document.activeElement), true, "Removing a file restores a usable focus target");
  assert.equal(await submit.isEnabled(), true);
  await dialog.getByRole("button", { name: t("Remove file {name}").replace("{name}", longName), exact: true }).press("Enter");
  assert.equal(await submit.isEnabled(), false, "A retained pasted draft cannot enable an empty file import");
  await paste.press("Enter");
  assert.equal(await dialog.locator("textarea").inputValue(), pastedDraft, "Keyboard source switches keep pasted drafts");
  assert.equal(await dialog.getByText(t("1 record detected"), { exact: true }).isVisible(), true);
  assert.equal(await submit.isEnabled(), true);
  await page.screenshot({ path: join(output, `import-paste-${variant}.png`) });
  const panel = await dialog.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(panel && viewport && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height,
    "The import dialog, including its actions, fits the viewport");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "Closing the editor restores focus to its trigger");
}

async function openSidebarPage(page, t, label, selector) {
  await page.locator(".sidebar").getByRole("button", { name: t(label), exact: true }).click();
  await page.locator(selector).waitFor();
  await checkLayout(page.locator(".workspace-content"), label);
}

async function selectSettingsSection(page, section) {
  const picker = page.locator("[data-settings-section-picker]");
  if (await picker.isVisible()) {
    await picker.selectOption(section);
    assert.equal(await picker.inputValue(), section);
  } else {
    await page.locator(`#settings-tab-${section}`).press("Enter");
    await page.locator(`#settings-tab-${section}[aria-selected=true]`).waitFor();
  }
}

async function checkCompactSettings(context, t) {
  const settings = await context.newPage();
  try {
    await settings.setViewportSize({ width: 320, height: 420 });
    await settings.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await settings.locator("tr[data-profile-id]").first().waitFor();
    const header = settings.locator(".workspace-header");
    await checkLayout(header, "Desktop title bar at 320px");
    const titlebarControls = await header.locator(".window-controls button").evaluateAll(buttons => buttons.map(button => {
      const bounds = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }));
    assert.deepEqual(titlebarControls, [true, true, true], "Minimize, maximize, and close must be clickable at minimum width");

    const helpTrigger = settings.locator(".shortcut-help-trigger");
    await helpTrigger.press("Enter");
    const help = settings.getByRole("dialog", { name: t("Keyboard shortcuts"), exact: true });
    const helpClose = help.getByRole("button", { name: t("Close keyboard shortcuts"), exact: true });
    assert.equal(await helpClose.evaluate(button => document.activeElement === button), true);
    await helpClose.press("PageDown");
    await settings.waitForFunction(() => document.querySelector(".shortcut-help-body")?.scrollTop > 0);
    assert.ok(await help.locator(".shortcut-help-note").isVisible());
    await help.screenshot({ path: join(output, "shortcut-help-320.png") });
    await settings.keyboard.press("Escape");
    await help.waitFor({ state: "hidden" });
    assert.equal(await helpTrigger.evaluate(button => document.activeElement === button), true);

    await settings.keyboard.press("Control+k");
    const palette = settings.getByRole("dialog", { name: t("Quick commands"), exact: true });
    const search = settings.getByRole("combobox", { name: t("Search commands"), exact: true });
    await search.waitFor();
    const completeOptions = await palette.locator(".command-palette-results").evaluate(list => {
      const area = list.getBoundingClientRect();
      return [...list.querySelectorAll('[role="option"]')].filter(option => {
        const row = option.getBoundingClientRect();
        return row.height && row.top >= area.top && row.bottom <= area.bottom;
      }).length;
    });
    assert.ok(completeOptions >= 5, "At least five commands must be fully visible at 320×420");
    await palette.screenshot({ path: join(output, "command-palette-320.png") });
    await search.fill("ui-qa-unmatched-command-1640");
    await palette.getByRole("status").filter({ hasText: t("No matching commands") }).waitFor();
    assert.equal(await palette.locator(".command-palette-footer").count(), 0, "Empty results do not advertise an Enter action");
    await palette.screenshot({ path: join(output, "command-palette-empty-320.png") });
    await palette.getByRole("button", { name: t("Clear search"), exact: true }).press("Enter");
    assert.equal(await search.inputValue(), "");
    assert.equal(await search.evaluate(input => document.activeElement === input), true);
    await settings.setViewportSize({ width: 320, height: 530 });
    await search.fill(t("Network & proxies"));
    await search.press("Enter");
    const picker = settings.getByRole("combobox", { name: t("Settings sections"), exact: true });
    await picker.waitFor();
    await settings.waitForFunction(() => document.activeElement?.hasAttribute("data-settings-section-picker"));
    assert.equal(await picker.inputValue(), "network", "Command navigation focuses the actual narrow settings section control");
    assert.equal(await picker.locator("option").count(), 8);
    await picker.press("Home");
    assert.equal(await picker.inputValue(), "account");
    await settings.locator(".desktop-motion-settings select.settings-compact-choice").waitFor();
    await checkLayout(settings.locator(".settingspage"), "General settings at 320px");
    await settings.screenshot({ path: join(output, "settings-general-320.png") });

    await settings.route("**/ui/api/diagnostics/run", route => route.fulfill({ json: {
      ok: true,
      reportId: "ui-qa-system-diagnostics",
      report: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        appVersion: "0.20.0",
        overallStatus: "warn",
        summary: { pass: 1, warn: 1, fail: 0, skipped: 0 },
        checks: [
          { id: "sqlite", title: "SQLite Database Integrity", status: "pass", summary: "UI fixture ready", durationMs: 3, details: {} },
          { id: "disk_space", title: "Disk Space & Workspace Storage", status: "warn", summary: "UI fixture warning", durationMs: 5, details: {} },
        ],
      },
    } }));
    await selectSettingsSection(settings, "advanced");
    await settings.getByRole("button", { name: t("Run diagnostics"), exact: true }).press("Enter");
    const summary = settings.locator("[data-diag-summary]");
    await summary.waitFor();
    assert.equal(await summary.locator(".diag-count-warn").count(), 1, "A diagnostic warning gets a labeled highlight");
    assert.ok(await summary.evaluate(node => node.nextElementSibling?.classList.contains("diag-export-area")),
      "Diagnostic totals are presented before export controls");
    await checkLayout(settings.locator(".diagnostics-box"), "Diagnostic results at 320px");
    await settings.screenshot({ path: join(output, "settings-diagnostics-320.png") });

    await selectSettingsSection(settings, "account");
    await settings.setViewportSize({ width: 1440, height: 900 });
    await settings.locator("#settings-tab-account[aria-selected=true]").waitFor();
    assert.equal(await picker.isVisible(), false, "Widening the window restores the keyboard tab strip");
    return { sectionCount: 8, compactFocus: true, keyboardSelection: true, wideTabsRestored: true, titlebarControlsReachable: true, diagnosticSummaryFirst: true, shortcutKeyboardScroll: true, completeCommandsAt320x420: completeOptions, emptyCommandResetFocus: true };
  } finally {
    await settings.close();
  }
}

async function checkTrashConfirmation(page, t, variant) {
  const trash = page.locator(".trash-page");
  const item = trash.locator("tr[data-trash-id]").first().getByRole("checkbox");
  await item.press("Space");
  const trigger = trash.getByRole("button", { name: t("Delete permanently"), exact: true });
  const dialog = page.getByRole("alertdialog", { name: t("Permanent deletion"), exact: true });
  let purgeRequests = 0, nativeDialogs = 0;
  const onRequest = request => {
    if (new URL(request.url()).pathname === "/ui/api/trash/purge") purgeRequests++;
  };
  const onDialog = async prompt => {
    nativeDialogs++;
    await prompt.dismiss();
  };
  page.on("request", onRequest);
  page.on("dialog", onDialog);
  try {
    await trigger.press("Enter");
    await dialog.waitFor();
    await checkLayout(dialog, "Permanent deletion dialog");
    const header = await dialog.locator(".modal-head").evaluate(node => ({
      height: node.getBoundingClientRect().height,
      closeGap: node.getBoundingClientRect().right - node.querySelector(".modal-close").getBoundingClientRect().right,
      padding: parseFloat(getComputedStyle(node).paddingRight),
    }));
    assert.ok(header.height <= 72 && Math.abs(header.closeGap - header.padding) <= 1, "Confirmation has a compact header with Close aligned to the edge");
    const cancel = dialog.getByRole("button", { name: t("Cancel"), exact: true });
    assert.equal(await cancel.evaluate(node => node === document.activeElement), true, "Permanent deletion starts on Cancel");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    const confirm = dialog.getByRole("button", { name: t("Delete permanently"), exact: true });
    assert.equal(await confirm.evaluate(node => node === document.activeElement), true, "Keyboard focus wraps inside the confirmation");
    await cancel.focus();
    await page.screenshot({ path: join(output, `trash-confirm-${variant}.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "Cancelling restores focus to the Delete permanently trigger");
    assert.equal(await item.isChecked(), true, "Leaving the confirmation keeps the selection");
    assert.equal(purgeRequests, 0, "Closing a confirmation must not request permanent deletion");
    assert.equal(nativeDialogs, 0, "The desktop and web views should use their in-app confirmation");
    await item.press("Space");
  } finally {
    page.off("request", onRequest);
    page.off("dialog", onDialog);
  }
}

async function checkSecondaryPages(page, t, variant) {
  for (const { label, selector, file } of [
    { label: "Scripts", selector: ".scripts-page", file: "scripts" },
    { label: "Manage extensions", selector: ".extensions-workspace", file: "extensions" },
    { label: "Trash", selector: ".trash-page", file: "trash" },
  ]) {
    await openSidebarPage(page, t, label, selector);
    await page.screenshot({ path: join(output, `${file}-${variant}.png`) });
    if (file === "trash") await checkTrashConfirmation(page, t, variant);
    if (file === "extensions") {
      const add = page.getByRole("button", { name: t("Add extension"), exact: true });
      await add.and(page.locator(":enabled")).press("Enter");
      const installer = page.locator(".extensions-installer");
      await installer.waitFor();
      await checkLayout(installer, "Extension installer");
      await page.screenshot({ path: join(output, `extension-installer-${variant}.png`) });
      const archive = installer.getByRole("button", { name: t("ZIP/CRX archive"), exact: true });
      await archive.press("Enter");
      assert.equal(await archive.getAttribute("aria-pressed"), "true");
      assert.equal(await archive.evaluate(button => document.activeElement === button), true, "Switching sources keeps focus on the control");
      await installer.getByRole("button", { name: t("Choose ZIP/CRX files"), exact: true }).waitFor();
      await archive.press("Escape");
      await installer.waitFor({ state: "hidden" });
      assert.equal(await add.evaluate(button => document.activeElement === button), true, "Closing the installer restores its opener");
    }
  }
  await openSidebarPage(page, t, "Settings", ".settings-workspace");
  await selectSettingsSection(page, "account");
  await page.locator(".settings-appearance").waitFor();
  await checkLayout(page.locator(".settings-appearance"), "Appearance settings");
  await page.screenshot({ path: join(output, `settings-appearance-${variant}.png`) });
  const settingsPicker = page.getByRole("combobox", { name: t("Settings sections"), exact: true });
  if (await settingsPicker.isVisible()) {
    assert.equal(await settingsPicker.locator("option").count(), 8, "Every settings section is discoverable in the narrow picker");
    await settingsPicker.press("ArrowDown");
    assert.equal(await settingsPicker.inputValue(), "network", "Arrow keys switch the focused settings picker");
    assert.equal(await settingsPicker.evaluate(node => node === document.activeElement), true);
  } else {
    await page.locator("#settings-tab-account").press("ArrowRight");
    const networkTab = page.locator("#settings-tab-network[aria-selected=true]");
    await networkTab.waitFor();
    assert.equal(await networkTab.evaluate(node => node === document.activeElement), true, "The selected settings tab must receive focus");
  }
  await checkLayout(page.locator(".settingspage"), "Network settings");
  await page.screenshot({ path: join(output, `settings-network-${variant}.png`) });
  if (variant === "russian-dark-520") {
    const compactViewport = page.viewportSize();
    await page.setViewportSize({ width: 1040, height: 780 });
    const tabs = page.getByRole("tablist", { name: t("Settings sections"), exact: true });
    await tabs.waitFor();
    await checkLayout(tabs, "Russian settings tabs at 1040px");
    await page.screenshot({ path: join(output, "settings-tabs-russian-dark-1040.png") });
    await page.setViewportSize(compactViewport);
  }
  await selectSettingsSection(page, "updates");
  await page.locator(".browser-runtime-settings").waitFor();
  await checkLayout(page.locator(".settingspage"), "Update and runtime settings");
  await page.screenshot({ path: join(output, `settings-runtime-${variant}.png`) });

  await page.locator(".wm-rail-switcher .wm-workspace-trigger").click();
  await page.getByRole("menuitem", { name: t("Manage workspaces"), exact: true }).click();
  await page.locator(".wm-page").waitFor();
  await checkLayout(page.locator(".workspace-content"), "Workspace management");
  await checkLayout(page.locator(".wm-page-body"), "Workspace management body");
  await page.screenshot({ path: join(output, `workspaces-${variant}.png`) });
  await page.locator("#wm-tab-workspaces").focus();
  await page.keyboard.press("ArrowRight");
  const backups = page.locator("#wm-tab-backups[aria-selected=true]");
  await backups.waitFor();
  assert.equal(await backups.evaluate(node => node === document.activeElement), true, "The selected workspace tab must receive focus");
  const backupGuide = page.locator(".wm-backup-scope");
  assert.equal(await backupGuide.getAttribute("open"), null);
  await backupGuide.locator("summary").press("Enter");
  assert.equal(await backupGuide.getAttribute("open"), "");
  await checkLayout(page.locator(".wm-page-body"), "Backup and restore body");
  await page.screenshot({ path: join(output, `backups-${variant}.png`) });
  await openSidebarPage(page, t, "All profiles", ".profiles-workspace");
}

async function checkGroupManagement(context, t) {
  const groupsPage = await context.newPage();
  groupsPage.setDefaultTimeout(15_000);
  groupsPage.on("pageerror", error => errors.push(error.message));
  const sourceParent = "海外业务";
  const destination = "国内运营";
  const name = "【模拟】分组布局检查 · 有较长名称的子分组";
  const sourcePath = `${sourceParent}/${name}`;
  const movedPath = `${destination}/${name}`;
  const waitForFocus = locator => locator.and(groupsPage.locator(":focus")).waitFor();
  const waitForGroupMutation = suffix => groupsPage.waitForResponse(response =>
    new URL(response.url()).pathname === `/ui/api/groups/${suffix}` && response.request().method() === "POST");
  const assertActionFits = async (button, label) => {
    const bounds = await button.boundingBox();
    const viewport = groupsPage.viewportSize();
    assert.ok(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
    `${label} must fit in the window`);
  };
  try {
    await groupsPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await groupsPage.locator("tr[data-profile-id]").first().waitFor();
    const trigger = groupsPage.locator(".profile-group-manager").getByRole("button", { name: t("Manage groups"), exact: true });
    const dialog = groupsPage.getByRole("dialog", { name: t("Manage groups"), exact: true });
    const rowActions = path => dialog.locator(`[data-managed-group="${path}"]`);
    const newGroup = dialog.getByRole("button", { name: t("New group"), exact: true });
    await trigger.press("Enter");
    await dialog.waitFor();
    await checkLayout(dialog, "Manage groups at 1440px");
    await groupsPage.screenshot({ path: join(output, "groups-manage-light-1440.png") });
    await groupsPage.setViewportSize({ width: 320, height: 530 });
    await checkLayout(dialog, "Manage groups at 320px");
    await assertActionFits(newGroup, "New group");
    const close = dialog.getByRole("button", { name: t("Close"), exact: true });
    await waitForFocus(close);
    await groupsPage.keyboard.press("Shift+Tab");
    await waitForFocus(newGroup);
    await groupsPage.keyboard.press("Tab");
    await waitForFocus(close);

    await rowActions(sourceParent).press("Enter");
    await dialog.getByRole("button", { name: t("New subfolder"), exact: true }).press("Enter");
    const input = dialog.getByRole("textbox", { name: t("New group name"), exact: true });
    const create = dialog.getByRole("button", { name: t("Create"), exact: true });
    await waitForFocus(input);
    assert.equal(await create.isEnabled(), false, "Creating a group requires a name");
    await input.fill(name);
    await assertActionFits(create, "Create group");
    await groupsPage.screenshot({ path: join(output, "groups-create-child-light-320.png") });
    const created = waitForGroupMutation("create");
    await input.press("Enter");
    assert.equal((await (await created).json()).folder.name, sourcePath);
    await waitForFocus(rowActions(sourcePath));

    await rowActions(sourcePath).press("Enter");
    const moveAction = dialog.getByRole("button", { name: t("Move to…"), exact: true });
    await checkLayout(dialog.locator(".group-management-actions"), "Group actions at 320px");
    await assertActionFits(moveAction, "Move group menu action");
    await groupsPage.screenshot({ path: join(output, "groups-actions-light-320.png") });
    await moveAction.press("Enter");
    const moveDialog = groupsPage.getByRole("dialog", { name: t("Move group"), exact: true });
    const parent = moveDialog.getByRole("combobox", { name: t("Parent folder"), exact: true });
    const move = moveDialog.getByRole("button", { name: t("Move"), exact: true });
    await parent.waitFor();
    assert.equal(await parent.inputValue(), sourceParent);
    assert.equal(await parent.locator(`option[value="${sourcePath}"]`).count(), 0, "A group cannot be moved into itself");
    assert.equal(await move.isEnabled(), false, "The current parent cannot be submitted as a move");
    await parent.selectOption(destination);
    await moveDialog.getByText(movedPath, { exact: true }).waitFor();
    await checkLayout(moveDialog, "Move group at 320px");
    await assertActionFits(move, "Move group confirmation");
    await groupsPage.screenshot({ path: join(output, "groups-move-light-320.png") });
    await groupsPage.keyboard.press("Escape");
    await moveDialog.waitFor({ state: "hidden" });
    await waitForFocus(rowActions(sourcePath));
    await rowActions(sourcePath).press("Enter");
    await moveAction.press("Enter");
    assert.equal(await parent.inputValue(), sourceParent, "Cancelling a move leaves the original parent in place");
    await parent.selectOption(destination);
    const moved = waitForGroupMutation("move");
    await move.press("Enter");
    assert.equal((await (await moved).json()).folder.name, movedPath);
    await moveDialog.waitFor({ state: "hidden" });
    await waitForFocus(rowActions(movedPath));

    await rowActions(movedPath).press("Enter");
    await dialog.getByRole("button", { name: t("Delete"), exact: true }).press("Enter");
    const confirm = groupsPage.getByRole("alertdialog", { name: t("Delete group"), exact: true });
    await waitForFocus(confirm.getByRole("button", { name: t("Cancel"), exact: true }));
    const removed = waitForGroupMutation("delete");
    await confirm.getByRole("button", { name: t("Delete"), exact: true }).press("Enter");
    assert.equal((await (await removed).json()).ok, true);
    await rowActions(movedPath).waitFor({ state: "hidden" });
    await groupsPage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await waitForFocus(trigger);
    return { minWidth: 320, keyboardFocusWrap: true, childCreated: true, movePreviewAndCancellation: true, moveSaved: true };
  } finally {
    await groupsPage.close();
  }
}

async function checkRowActionNavigation(context, t) {
  const actions = await context.newPage();
  actions.setDefaultTimeout(15_000);
  actions.on("pageerror", error => errors.push(error.message));
  try {
    await actions.setViewportSize({ width: 320, height: 420 });
    await actions.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const trigger = actions.locator("tr[data-profile-id]").first().locator(".profile-menu-trigger");
    await trigger.waitFor();
    await actions.evaluate(() => document.fonts.ready);
    await trigger.scrollIntoViewIfNeeded();
    const menu = actions.getByRole("menu", { name: await trigger.getAttribute("aria-label"), exact: true });
    const enabled = menu.locator('button[role="menuitem"]:not(:disabled)');
    await trigger.press("ArrowUp");
    await menu.waitFor();
    assert.equal(await enabled.last().evaluate(item => item === document.activeElement), true, "ArrowUp opens on the final enabled action");
    await checkLayout(menu, "Environment actions at 320px");
    await actions.screenshot({ path: join(output, "row-actions-keyboard-320.png") });
    await actions.keyboard.press("Home");
    assert.equal(await enabled.first().evaluate(item => item === document.activeElement), true, "Home moves within the menu");
    await actions.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "Escape restores focus to the matched row");
    await trigger.press("ArrowDown");
    assert.equal(await enabled.first().evaluate(item => item === document.activeElement), true, "ArrowDown opens on the first enabled action");
    await actions.keyboard.press("Shift+Tab");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node !== document.activeElement && !!node.closest("tr").contains(document.activeElement)), true, "Shift+Tab returns to the previous control on the same row");
    await trigger.press("ArrowDown");
    await menu.getByRole("menuitem", { name: t("Manage tags"), exact: true }).press("Enter");
    const tags = actions.locator('.profile-tags-dialog[role="dialog"]');
    const entry = tags.locator(".profile-tags-entry input");
    await entry.fill("qa draft");
    await actions.mouse.click(6, 6);
    assert.equal(await entry.inputValue(), "qa draft", "Clicking outside the tag editor retains a draft");
    assert.equal(await entry.evaluate(input => input === document.activeElement), true);
    await actions.screenshot({ path: join(output, "tag-draft-320.png") });
    await actions.keyboard.press("Escape");
    await tags.waitFor({ state: "hidden" });
    return { narrowWidth: 320, openedAtBothEnds: true, escapeRestoredFocus: true, reverseTabExitedMenu: true, tagDraftSurvivedOutsideClick: true };
  } finally {
    await actions.close();
  }
}

async function checkOnboardingChecklist(context) {
  const onboarding = await context.newPage();
  onboarding.setDefaultTimeout(15_000);
  onboarding.on("pageerror", error => errors.push(error.message));
  try {
    await onboarding.setViewportSize({ width: 320, height: 530 });
    await onboarding.addInitScript(() => localStorage.setItem("aliasmode.onboarding.state", "open"));
    await onboarding.route("**/ui/api/profiles", route => route.fulfill({ json: { ok: true, profiles: [], groups: [], folders: [] } }));
    await onboarding.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const checklist = onboarding.locator('.onboarding-banner[data-onboarding-checklist="open"]');
    const steps = checklist.locator(".onboarding-steps");
    await steps.waitFor();
    await onboarding.evaluate(() => document.fonts.ready);
    assert.equal(await steps.locator("li").count(), 4);
    assert.equal(await steps.locator(".onboarding-step-actions button").count(), 6);
    await checkLayout(checklist, "Quick-start checklist at 320px");
    const compact = await checklist.evaluate(panel => {
      const footer = document.querySelector(".workspace-footer").getBoundingClientRect();
      return {
        height: Math.ceil(panel.getBoundingClientRect().height),
        actionsVisible: Array.from(panel.querySelectorAll(".onboarding-step-actions button"))
          .every(button => button.getBoundingClientRect().bottom <= footer.top),
      };
    });
    assert.equal(compact.actionsVisible, true, "A new workspace must show every quick-start action in a 320×530 window");
    await onboarding.screenshot({ path: join(output, "onboarding-light-320.png") });
    await onboarding.setViewportSize({ width: 1100, height: 780 });
    const desktopColumns = await steps.evaluate(list => new Set([...list.children].map(item => item.offsetTop)).size === 1);
    assert.equal(desktopColumns, true, "The four steps sit on one row when the checklist is wide enough");
    return { compact, desktopColumns: 4 };
  } finally {
    await onboarding.close();
  }
}

async function checkKeyboardRoster(page, t) {
  const pageSize = page.getByRole("combobox", { name: t("Rows per page"), exact: true });
  const originalSize = await pageSize.inputValue();
  await pageSize.selectOption("0");
  await page.waitForFunction(() => document.querySelector(".pager select")?.value === "0");
  const viewport = page.locator(".profile-browser > .tablewrap");
  const first = viewport.locator('tr[data-profile-id] input[type="checkbox"]').first();
  await first.focus();
  const start = await first.evaluate(node => node.closest("tr")?.dataset.flatKey);
  const move = async (key, from) => {
    await page.keyboard.press(key);
    await page.waitForFunction(previous => {
      const row = document.activeElement?.closest("tr[data-flat-key]");
      return row && row.getAttribute("data-flat-key") !== previous;
    }, from);
    const focused = await viewport.evaluate(node => {
      const control = node.ownerDocument.activeElement;
      const row = control?.closest("tr[data-flat-key]");
      if (!row || !node.contains(control)) return { row: null, visible: false };
      const viewportTop = node.getBoundingClientRect().top;
      const top = Math.max(viewportTop, node.querySelector("thead").getBoundingClientRect().bottom);
      const bottom = viewportTop + node.clientTop + node.clientHeight;
      const target = control.getBoundingClientRect();
      return { row: row.getAttribute("data-flat-key"), visible: target.top >= top - 1 && target.bottom <= bottom + 1 };
    });
    assert.ok(focused.visible, `Roster focus after ${key} must be visible below the sticky header`);
    return focused.row;
  };
  const end = await move("End", start);
  const mounted = await viewport.locator("tr[data-profile-id]").count();
  if (fixtureRows >= 200) {
    const nearEnd = await viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= node.clientHeight);
    assert.ok(nearEnd, "End must scroll the virtual roster to its last screen");
    assert.ok(mounted < 100, `The virtual roster mounted ${mounted} of ${fixtureRows} environments`);
  }
  await move("Home", end);
  assert.ok(await viewport.evaluate(node => node.scrollTop <= 2), "Home must bring the beginning of the roster back into view");
  await pageSize.selectOption(originalSize);
  return { profiles: fixtureRows, mountedAfterEnd: mounted };
}

async function checkRosterRecovery(context, t) {
  const recoveryPage = await context.newPage();
  await recoveryPage.setViewportSize({ width: 320, height: 740 });
  recoveryPage.on("pageerror", error => errors.push(error.message));
  let roster = "unavailable";
  let releaseStalledRead;
  const stalledRead = new Promise(resolve => { releaseStalledRead = resolve; });
  await recoveryPage.route("**/ui/api/profiles", async route => {
    if (roster === "unavailable") return route.fulfill({ status: 503, json: { ok: false, error: "Synthetic roster outage" } });
    if (roster === "stalled") {
      await stalledRead;
      await route.abort().catch(() => {});
      return;
    }
    if (roster === "empty") return route.fulfill({ json: { ok: true, profiles: [], groups: [], folders: [] } });
    return route.continue();
  });
  try {
    await recoveryPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const notice = recoveryPage.locator(".roster-recovery");
    const firstProfile = recoveryPage.locator("tr[data-profile-id]").first();
    const retry = notice.getByRole("button", { name: t("Retry"), exact: true });
    await notice.getByText(t("Could not load environments."), { exact: true }).waitFor();
    assert.equal(await recoveryPage.locator(".profile-table, .onboarding-checklist").count(), 0, "Initial failure cannot render an empty roster or onboarding");
    const brand = recoveryPage.locator(".desktop-brand");
    assert.equal(await brand.locator("strong").isVisible(), false, "The narrow title bar should not show partially clipped brand text");
    await brand.press("Enter");
    await recoveryPage.locator("#about-popover-dialog").waitFor();
    await recoveryPage.keyboard.press("Escape");
    assert.equal(await brand.evaluate(node => node === document.activeElement), true, "The compact brand button still opens About and restores keyboard focus");
    await checkLayout(recoveryPage.locator("html"), "Environment load failure at 320px");
    await recoveryPage.screenshot({ path: join(output, "profiles-unavailable-320.png") });

    roster = "available";
    await retry.press("Enter");
    await notice.waitFor({ state: "hidden" });
    await firstProfile.waitFor();
    assert.equal(await recoveryPage.locator("#profiles-page-title:focus").count(), 1, "Keyboard retry restores focus to the roster heading");
    const firstId = await firstProfile.getAttribute("data-profile-id");

    roster = "stalled";
    const timedOutRequest = recoveryPage.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/ui/api/profiles");
    await recoveryPage.getByRole("button", { name: t("Refresh profiles"), exact: true }).press("Enter");
    await notice.getByText(t("Refresh failed. Showing the last loaded list."), { exact: true }).waitFor();
    releaseStalledRead();
    await timedOutRequest;
    assert.equal(await firstProfile.getAttribute("data-profile-id"), firstId, "A later failure retains the last loaded rows");
    await checkLayout(recoveryPage.locator("html"), "Environment refresh failure at 320px");
    await recoveryPage.screenshot({ path: join(output, "profiles-stale-320.png") });
    roster = "available";
    await retry.press("Enter");
    await notice.waitFor({ state: "hidden" });
    await firstProfile.waitFor();

    roster = "empty";
    await recoveryPage.getByRole("button", { name: t("Refresh profiles"), exact: true }).press("Enter");
    const empty = recoveryPage.locator(".profile-browser .workspace-empty");
    await empty.getByText(t("No profiles yet"), { exact: true }).waitFor();
    await checkLayout(empty, "Confirmed empty environment list at 320px");
    assert.equal(await recoveryPage.locator(".profile-table").isVisible(), false, "Confirmed workspace empty state hides table headers");
    assert.equal(await recoveryPage.locator(".statusbar .pager").isVisible(), false, "Confirmed workspace empty state hides pagination");
    const checklist = recoveryPage.locator(".onboarding-banner");
    assert.equal(await checklist.getAttribute("data-onboarding-checklist"), "collapsed", "Narrow first-run layout keeps the roster in view");
    await empty.getByRole("button", { name: t("New Profile"), exact: true }).click({ trial: true });
    await recoveryPage.screenshot({ path: join(output, "profiles-empty-320.png") });
    await checklist.getByRole("button", { name: t("Expand"), exact: true }).press("Enter");
    assert.equal(await checklist.getAttribute("data-onboarding-checklist"), "open");
    await empty.getByRole("button", { name: t("New Profile"), exact: true }).click({ trial: true });
    return { initialFailure: "recovered", hungReadTimedOut: true, refreshFailure: "retained-and-recovered", confirmedEmpty: true };
  } finally {
    releaseStalledRead();
    await recoveryPage.close();
  }
}

async function checkSseRecovery(context) {
  const streamPage = await context.newPage();
  streamPage.on("pageerror", error => errors.push(error.message));
  let rosterReads = 0;
  streamPage.on("request", request => {
    if (new URL(request.url()).pathname === "/ui/api/profiles") rosterReads++;
  });
  await streamPage.route("**/ui/api/app-mode", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), eventsStream: true } });
  });
  await streamPage.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const probes = { attempts: 0, cancelled: 0 };
    window.__maobuQaSse = probes;
    window.fetch = (input, init) => {
      if (input !== "/ui/api/events") return realFetch(input, init);
      const firstAttempt = ++probes.attempts === 1;
      const stream = new ReadableStream({
        start(controller) {
          const frame = firstAttempt ? ": keepalive\n\n" : 'id: 1\nevent: connected\ndata: {"protocol":1}\n\n';
          controller.enqueue(new TextEncoder().encode(frame));
        },
        cancel() { probes.cancelled++; },
      });
      return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  try {
    await streamPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await streamPage.locator("tr[data-profile-id]").first().waitFor();
    const initialReads = rosterReads;
    await streamPage.waitForFunction(() => window.__maobuQaSse.cancelled === 1 && window.__maobuQaSse.attempts === 2, undefined, { timeout: 15_000 });
    assert.ok(rosterReads > initialReads, "An event stream without a handshake triggers a fallback read");
    return { cancelledUnresponsiveStream: true, reconnected: true, fallbackRosterReads: rosterReads - initialReads };
  } finally {
    await streamPage.close();
  }
}

async function checkStartupRecovery(context, t) {
  const startup = await context.newPage();
  await startup.setViewportSize({ width: 320, height: 420 });
  startup.on("pageerror", error => errors.push(error.message));
  let requests = 0, navigations = 0, releaseRetry;
  const heldRetry = new Promise(resolve => { releaseRetry = resolve; });
  startup.on("request", request => {
    if (request.isNavigationRequest()) navigations++;
  });
  await startup.route("**/ui/api/app-mode", async route => {
    if (++requests === 1) {
      return route.fulfill({ status: 503, json: { localOnly: true, mode: "local", error: "QA_STARTUP_INTERNAL /workspace/private.log" } });
    }
    await heldRetry;
    await route.fallback();
  });
  try {
    await startup.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const card = startup.locator(".startup-card");
    const error = card.getByRole("alert");
    await error.getByRole("heading", { name: t("Could not load the dashboard."), exact: true }).waitFor();
    assert.doesNotMatch(await card.textContent(), /QA_STARTUP_INTERNAL|private\.log/);
    assert.equal(await startup.locator(".profiles-workspace").count(), 0);
    await checkLayout(card, "Startup failure card at 320px");
    await card.screenshot({ path: join(output, "startup-failure-320.png") });
    const retry = card.getByRole("button", { name: t("Try again"), exact: true });
    const waitForRetry = startup.waitForRequest("**/ui/api/app-mode");
    await retry.press("Enter");
    await waitForRetry;
    assert.equal(await retry.getAttribute("aria-disabled"), "true");
    await startup.keyboard.press("Enter");
    assert.equal(requests, 2, "Repeat activation must not start another local request");
    assert.equal(await retry.evaluate(node => document.activeElement === node), true);
    releaseRetry();
    await startup.locator("tr[data-profile-id]").first().waitFor();
    assert.equal(navigations, 1, "Startup retry stays in the original document");
    assert.equal(await startup.locator("#profiles-page-title").evaluate(node => node === document.activeElement), true);
  } finally {
    releaseRetry();
    await startup.close();
  }

  const session = await context.newPage();
  session.on("pageerror", error => errors.push(error.message));
  try {
    await session.setViewportSize({ width: 320, height: 420 });
    await session.route("**/ui/api/app-mode", route => route.fulfill({ status: 401, json: { error: "QA_SESSION_INTERNAL" } }));
    await session.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const form = session.locator('.startup-card[data-startup-phase="session"]');
    await form.getByRole("heading", { name: t("Session token required"), exact: true }).waitFor();
    const input = form.getByLabel(t("Session token"), { exact: true });
    assert.equal(await input.getAttribute("type"), "password");
    assert.doesNotMatch(await form.textContent(), /QA_SESSION_INTERNAL/);
    assert.equal(await session.locator(".profiles-workspace").count(), 0);
    await checkLayout(form, "Session prompt at 320px");
    await form.screenshot({ path: join(output, "startup-session-320.png") });
  } finally {
    await session.close();
  }
  return { inlineRetry: true, duplicateRetryBlocked: true, restoredFocus: true, sessionPrompt: true, rawErrorHidden: true };
}

async function checkAppLockRecovery(context, t) {
  const lockPage = await context.newPage();
  await lockPage.setViewportSize({ width: 960, height: 640 });
  lockPage.on("pageerror", error => errors.push(error.message));
  const status = { configured: true, enabled: true, locked: true, lockOnStartup: true, idleTimeoutMinutes: 15,
    failedAttempts: 0, cooldownUntil: 0, retryAfterMs: 0, lastActivityAt: 0, updatedAt: null, corrupt: false };
  let reads = 0, rosterReads = 0, unlocks = 0, manualLocks = 0;
  let markActivityStarted, releaseActivity, markConfigureStarted, releaseConfigure;
  const activityStarted = new Promise(resolve => { markActivityStarted = resolve; });
  const activityGate = new Promise(resolve => { releaseActivity = resolve; });
  const configureStarted = new Promise(resolve => { markConfigureStarted = resolve; });
  const configureGate = new Promise(resolve => { releaseConfigure = resolve; });
  await lockPage.route("**/ui/api/app-mode", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), appLockAvailable: true } });
  });
  await lockPage.route("**/ui/api/app-lock/status", route => ++reads === 1
    ? route.fulfill({ status: 503, json: { ok: false, error: "Synthetic app lock status outage" } })
    : route.fulfill({ json: { ok: true, status } }));
  await lockPage.route("**/ui/api/app-lock/unlock", route => {
    assert.equal(route.request().method(), "POST");
    assert.equal(route.request().postDataJSON().password, "synthetic-qa-password");
    unlocks++;
    status.locked = false;
    return route.fulfill({ json: { ok: true, status } });
  });
  await lockPage.route("**/ui/api/app-lock/activity", async route => {
    const snapshot = { ...status };
    markActivityStarted();
    await activityGate;
    await route.fulfill({ json: { ok: true, status: snapshot } });
  });
  await lockPage.route("**/ui/api/app-lock/lock", route => {
    manualLocks++;
    status.locked = true;
    return route.fulfill({ json: { ok: true, status } });
  });
  await lockPage.route("**/ui/api/app-lock/configure", async route => {
    const input = route.request().postDataJSON();
    assert.equal(input.currentPassword, "synthetic-qa-password");
    assert.equal(input.idleTimeoutMinutes, 30);
    status.idleTimeoutMinutes = input.idleTimeoutMinutes;
    const snapshot = { ...status };
    markConfigureStarted();
    await configureGate;
    await route.fulfill({ json: { ok: true, status: snapshot } });
  });
  lockPage.on("request", request => {
    if (new URL(request.url()).pathname === "/ui/api/profiles") rosterReads++;
  });
  try {
    await lockPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const error = lockPage.locator(".desktop-loading-shell").getByRole("alert").filter({ hasText: t("Could not load app lock status.") });
    await error.waitFor();
    assert.equal(await lockPage.locator(".folded-workbench").count(), 0, "Unknown lock status must keep the workspace closed");
    await checkLayout(lockPage.locator("html"), "App lock status failure at 960px");
    await lockPage.screenshot({ path: join(output, "app-lock-status-unavailable-960.png") });
    await lockPage.getByRole("button", { name: t("Try again"), exact: true }).press("Enter");
    const lock = lockPage.locator('[data-app-lock-screen="true"]');
    const unlock = async () => {
      await lock.locator("input[type=password]").fill("synthetic-qa-password");
      await lock.getByRole("button", { name: t("Unlock"), exact: true }).press("Enter");
      await lock.waitFor({ state: "hidden" });
    };
    const waitForPaint = () => lockPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await lock.waitFor();
    assert.equal(reads, 2, "Status retry should request a single fresh snapshot");
    assert.equal(rosterReads, 0, "No roster reads can run before unlock");
    await unlock();
    await lockPage.locator("tr[data-profile-id]").first().waitFor();
    assert.equal(unlocks, 1);
    assert.ok(rosterReads > 0, "Unlock starts the roster read");
    await lockPage.locator(".profile-filter-row").click();
    await activityStarted;
    await lockPage.keyboard.press("Control+Shift+L");
    await lock.waitFor();
    assert.equal(manualLocks, 1);
    const delayedResponse = lockPage.waitForResponse("**/ui/api/app-lock/activity");
    releaseActivity();
    await (await delayedResponse).finished();
    await waitForPaint();
    assert.equal(await lock.isVisible(), true, "A delayed activity response cannot reopen the app after locking");

    await unlock();
    await lockPage.locator(".topbar-settings").click();
    const settings = lockPage.locator(".app-lock-settings-form");
    const idle = settings.locator("select");
    const currentPassword = settings.locator('[autocomplete="current-password"]');
    await idle.selectOption("30");
    await currentPassword.fill("synthetic-qa-password");
    await selectSettingsSection(lockPage, "network");
    await selectSettingsSection(lockPage, "account");
    assert.equal(await idle.inputValue(), "30", "Lock preferences survive switching settings tabs");
    assert.equal(await currentPassword.inputValue(), "", "Leaving the form clears the temporary password");
    await currentPassword.fill("synthetic-qa-password");
    await settings.getByRole("button", { name: t("Save lock settings"), exact: true }).press("Enter");
    await configureStarted;
    await lockPage.keyboard.press("Control+Shift+L");
    await lock.waitFor();
    assert.equal(manualLocks, 2);
    const delayedConfigure = lockPage.waitForResponse("**/ui/api/app-lock/configure");
    releaseConfigure();
    await (await delayedConfigure).finished();
    await waitForPaint();
    assert.equal(await lock.isVisible(), true, "A delayed settings receipt cannot reopen the app after locking");
    await unlock();
    assert.equal(await idle.inputValue(), "30", "The saved settings remain visible after a deliberate unlock");
    return { failedStatus: "recovered", rosterLoadedAfterUnlock: true, delayedActivityKeepsAppLocked: true, delayedSettingsKeepAppLocked: true, draftSurvivesTabs: true };
  } finally {
    releaseActivity();
    releaseConfigure();
    await lockPage.close();
  }
}

async function checkResourceRecovery(context, t) {
  const resourcePage = await context.newPage();
  await resourcePage.setViewportSize({ width: 520, height: 740 });
  resourcePage.on("pageerror", error => errors.push(error.message));
  const live = {
    ts: 200, host: { totalBytes: 10_000_000_000, availableBytes: 2_700_000_000, memoryLoadPercent: 73 },
    profiles: [{
      profileId: "resource-qa-only", name: "Synthetic environment with a long name",
      processCount: 9, rssBytes: 1_331_000_000, cpuPercent: 7.5,
    }],
    hibernatedProfileIds: ["resource-saved-session"],
    watermark: { level: "normal", recommendedConcurrency: 4 },
  };
  await resourcePage.route("**/ui/api/app-mode", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), eventsStream: false } });
  });
  await resourcePage.addInitScript(sample => {
    const originalFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = (input, init) => {
      if (input === "/ui/api/metrics/snapshot") {
        const payload = { ok: true, snapshot: { ...sample, ts: 100, host: { ...sample.host, memoryLoadPercent: 32 } } };
        const response = Response.json(payload);
        // Hold JSON delivery outside the browser's transport timeout so this
        // test can release an older sample after the live stream has recovered.
        const body = new Promise(resolve => {
          window.releaseResourceQaSnapshot = () => resolve(payload);
        });
        response.json = () => body;
        return Promise.resolve(response);
      }
      if (input !== "/ui/api/metrics/stream") return originalFetch(input, init);
      if (++attempts === 1) return Promise.resolve(Response.json({ ok: false }, { status: 503 }));
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`event: metrics.snapshot\ndata: ${JSON.stringify(sample)}\n\n`)); },
      });
      return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    };
  }, live);
  try {
    await resourcePage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const trigger = resourcePage.locator(".resource-top-capsule");
    await trigger.press("Enter");
    const panel = resourcePage.getByRole("dialog", { name: t("Real-time resource monitor"), exact: true });
    const close = panel.getByRole("button", { name: t("Close"), exact: true });
    await close.waitFor();
    assert.equal(await close.evaluate(node => node === document.activeElement), true, "Opening the drawer moves focus to Close");
    const status = panel.locator(".resdash-head [role=status]");
    await status.filter({ hasText: t("Resource monitoring interrupted. Reconnecting…") }).waitFor();
    await resourcePage.screenshot({ path: join(output, "resource-monitor-reconnecting-520.png") });
    await status.filter({ hasText: t("Live telemetry active (pauses when window is hidden)") }).waitFor();
    const load = panel.locator(".resdash-host-row strong");
    assert.equal(await load.textContent(), "73%");
    await resourcePage.waitForFunction(() => typeof window.releaseResourceQaSnapshot === "function");
    await resourcePage.evaluate(() => {
      window.releaseResourceQaSnapshot();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await load.textContent(), "73%", "A delayed snapshot cannot replace the newest live measurement");
    await checkLayout(panel, "Resource drawer at 520px");
    await resourcePage.screenshot({ path: join(output, "resource-monitor-recovered-520.png") });
    await resourcePage.setViewportSize({ width: 320, height: 620 });
    const resourceBody = panel.locator(".resdash-body");
    await checkLayout(resourceBody, "Resource dashboard at 320px");
    const runningList = panel.locator(".resdash-list[role=list]");
    assert.equal(await runningList.evaluate(node => node.scrollHeight <= node.clientHeight + 1), true,
      "Resource actions must not be clipped to make the entire panel fit vertically");
    const refresh = panel.getByRole("button", { name: t("Refresh resource metrics"), exact: true });
    const wake = panel.getByRole("button", { name: t("Wake"), exact: true });
    await refresh.press("Shift+Tab");
    assert.equal(await wake.evaluate(node => node === document.activeElement), true, "Reverse Tab stays inside the drawer");
    assert.equal(await wake.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), true, "The wrapped control stays visible");
    await resourcePage.keyboard.press("Tab");
    assert.equal(await refresh.evaluate(node => node === document.activeElement), true, "Tab wraps to the first control");
    await resourceBody.evaluate(node => { node.scrollTop = 0; });
    await resourcePage.screenshot({ path: join(output, "resource-monitor-recovered-320.png") });
    await resourcePage.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true, "Escape returns focus to the monitor trigger");
    return { temporaryFailureRecovered: true, olderSnapshotIgnored: true, drawerKeyboard: true, narrowWidth: 320 };
  } finally {
    await resourcePage.close();
  }
}

async function checkPackageReview(context, t) {
  const packagePage = await context.newPage();
  await packagePage.setViewportSize({ width: 520, height: 740 });
  packagePage.on("pageerror", error => errors.push(error.message));
  const base = fixture.url + "/ui/api/profiles";
  const headers = { Origin: fixture.url };
  const password = "synthetic-package-review";
  const { profiles } = await (await context.request.get(base)).json();
  const target = profiles.findLast(profile => !profile.running);
  assert.ok(target);
  const targetPath = base + "/" + encodeURIComponent(target.id);
  const changedName = target.name + " · QA revision";
  const exported = await context.request.post(base + "/package/export", {
    headers, data: { ids: [target.id], password, includeSecrets: false, includeSessions: false },
  });
  assert.equal(exported.status(), 200, "Fixture creates a real encrypted export from the stopped environment");
  try {
    await packagePage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await packagePage.locator("tr[data-profile-id]").first().waitFor();
    await packagePage.getByRole("button", { name: t("Command palette"), exact: true }).click();
    const palette = packagePage.locator('[data-command-palette="true"]');
    const command = t("Import encrypted profile package (.mqprofile)");
    await palette.getByRole("combobox").fill("mqprofile");
    await palette.getByRole("option").filter({ hasText: command }).click();
    const dialog = packagePage.getByRole("dialog", { name: command, exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "qa-review.mqprofile", mimeType: "application/octet-stream", buffer: await exported.body(),
    });
    const passwordInput = dialog.locator("#pkg-import-password");
    await passwordInput.fill(password);
    const decrypt = dialog.getByRole("button", { name: t("Decrypt & preview"), exact: true });
    const overwrite = dialog.locator('input[value="overwrite_closed"]');
    const confirm = dialog.locator(".pkg-overwrite-confirm input");
    const commit = dialog.getByRole("button", { name: t("Import {count} environments").replace("{count}", "1"), exact: true });
    await decrypt.press("Enter");
    await overwrite.check();
    await confirm.check();

    const changed = await context.request.post(targetPath + "/update", { headers, data: { set: { name: changedName } } });
    assert.equal(changed.status(), 200);
    const failedCommit = packagePage.waitForResponse(response => response.url().endsWith("/package/import"));
    await commit.press("Enter");
    assert.equal((await failedCommit).status(), 409, "A changed target requires a fresh review");
    const recoveryMessage = dialog.locator(".modal-foot").getByRole("alert");
    await recoveryMessage.waitFor();
    assert.equal(await recoveryMessage.textContent(), t("This package preview is no longer available. Review it again before importing."));
    assert.equal(await overwrite.isDisabled(), true, "An outdated review cannot be edited");
    assert.equal(await decrypt.isEnabled(), true, "Conflict recovery keeps the encrypted file and password available for re-review");
    assert.equal((await (await context.request.get(targetPath)).json()).profile.name, changedName);
    await checkLayout(dialog, "Package review recovery at 520px");
    await packagePage.screenshot({ path: join(output, "package-review-retry-520.png") });

    await decrypt.press("Enter");
    await commit.waitFor();
    await overwrite.check();
    assert.equal(await confirm.isChecked(), false, "A fresh preview requires explicit new overwrite consent");
    await confirm.check();
    const acceptedCommit = packagePage.waitForResponse(response => response.url().endsWith("/package/import"));
    await commit.press("Enter");
    assert.equal((await acceptedCommit).status(), 200);
    await dialog.locator(".pkg-receipt").waitFor();
    assert.equal((await (await context.request.get(targetPath)).json()).profile.name, target.name);
    return { staleTargetProtected: true, reviewedAgain: true, overwriteExplicitlyConfirmed: true };
  } finally {
    await packagePage.close();
  }
}

async function checkFileUpdate(context, t) {
  const filePage = await context.newPage();
  await filePage.setViewportSize({ width: 320, height: 640 });
  filePage.setDefaultTimeout(15_000);
  filePage.on("pageerror", error => errors.push(error.message));
  let submissions = 0;
  filePage.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/profiles/update-file")) submissions++;
  });
  try {
    await filePage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await filePage.locator("tr[data-profile-id] .chk input").first().check();
    await filePage.getByRole("button", { name: t("More actions"), exact: true }).press("Enter");
    const trigger = filePage.getByRole("button", { name: t("Edit from file"), exact: true });
    await trigger.press("Enter");
    const dialog = filePage.getByRole("dialog", { name: t("Update profiles from file"), exact: true });
    const chooser = dialog.locator(".profile-file-update-drop");
    const submit = dialog.getByRole("button", { name: t("Update profiles"), exact: true });
    const selected = dialog.locator(".profile-file-update-selection");
    await chooser.waitFor();
    assert.equal(await chooser.evaluate(node => node === document.activeElement), true);
    assert.equal(await submit.isDisabled(), true);
    const guide = dialog.locator(".profile-file-update-guide");
    assert.equal(await guide.getAttribute("open"), null);
    await guide.locator("summary").press("Enter");
    assert.equal(await guide.getAttribute("open"), "");
    await guide.locator("summary").press("Enter");
    await checkLayout(dialog, "File update dialog at 320px");
    await dialog.screenshot({ path: join(output, "file-update-320.png") });

    const [filePicker] = await Promise.all([filePage.waitForEvent("filechooser"), chooser.press("Enter")]);
    const draft = { name: "example-private-name.csv", mimeType: "text/csv", buffer: Buffer.from("id,name\nqa_file_update_unmatched,Example\n") };
    await filePicker.setFiles(draft);
    await selected.waitFor();
    assert.equal(await submit.isEnabled(), true);
    assert.equal(await dialog.getByText(draft.name, { exact: true }).count(), 0, "The picker summary omits local filenames");
    await chooser.evaluate(node => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["unsupported"], "unsupported.pdf", { type: "application/pdf" }));
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await dialog.getByRole("alert").waitFor();
    assert.equal(await selected.count(), 0, "An invalid replacement clears the previous file");
    assert.equal(await submit.isDisabled(), true, "An invalid replacement cannot submit the earlier selection");
    assert.equal(submissions, 0);
    await dialog.locator('input[type="file"]').setInputFiles(draft);
    await selected.waitFor();

    const written = filePage.waitForResponse(response => response.url().endsWith("/profiles/update-file"));
    await submit.press("Enter");
    assert.equal((await written).status(), 200);
    const details = dialog.getByRole("button", { name: t("View file update details"), exact: true });
    await details.waitFor();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    await details.press("Enter");
    const receipt = dialog.locator('[data-outcome="no-changes"]');
    await receipt.waitFor();
    const unmatched = receipt.getByText(t("View {count} distinct unmatched IDs").replace("{count}", "1"), { exact: true });
    await unmatched.press("Enter");
    assert.equal(await receipt.getByText("qa_file_update_unmatched", { exact: true }).isVisible(), true);
    assert.equal(submissions, 1);
    await checkLayout(receipt, "File update receipt at 320px");
    await dialog.screenshot({ path: join(output, "file-update-receipt-320.png") });
    await filePage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    return { invalidReplacementBlocked: true, singleSubmission: true, expandableReceipt: true, narrowWidth: 320 };
  } finally {
    await filePage.close();
  }
}

async function checkLogs(context, t) {
  const logPage = await context.newPage();
  await logPage.setViewportSize({ width: 320, height: 620 });
  logPage.setDefaultTimeout(15_000);
  logPage.on("pageerror", error => errors.push(error.message));
  let requests = 0;
  let releaseFirst, finishFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const firstFinished = new Promise(resolve => { finishFirst = resolve; });
  const filename = "aliasmode-2026-11-24.log";
  const content = Array.from({ length: 100 }, (_, index) => `Example ${index} ${"long-log-line-".repeat(21)}`).join("\n");
  await logPage.route("**/ui/api/logs", async route => {
    switch (++requests) {
      case 1:
        await held;
        await route.fulfill({ json: { ok: true, file: filename, content: "Stale log response" } }).catch(() => {});
        finishFirst();
        break;
      case 2:
        await route.fulfill({ status: 503, json: { ok: false, error: "INTERNAL_LOG_ERROR_QA" } });
        break;
      case 3:
        await route.fulfill({ json: { ok: true, file: filename, content } });
        break;
      default:
        await route.fulfill({ json: { ok: false, error: "no log file yet" } });
    }
  });
  try {
    await logPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const device = logPage.locator(".wm-device-trigger.is-rail");
    await device.press("Enter");
    await Promise.all([
      logPage.waitForRequest("**/ui/api/logs"),
      logPage.locator(".wm-device-popover").getByRole("button", { name: t("View logs"), exact: true }).press("Enter"),
    ]);
    const dialog = logPage.getByRole("dialog", { name: t("Detailed logs"), exact: true });
    await dialog.getByRole("status").filter({ hasText: t("Loading logs…") }).waitFor();
    await logPage.waitForFunction(() => document.querySelector(".log-viewer-reload")?.getAttribute("aria-disabled") === "true");
    await logPage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await device.evaluate(node => document.activeElement === node), true);
    releaseFirst();
    await firstFinished;
    await logPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 0, "A cancelled read cannot reopen the log viewer");

    await openSidebarPage(logPage, t, "Settings", ".settings-workspace");
    await selectSettingsSection(logPage, "advanced");
    const picker = logPage.getByRole("combobox", { name: t("Settings sections"), exact: true });
    assert.equal(await picker.inputValue(), "advanced");
    const logLocation = logPage.locator(".settings-log-location");
    assert.equal(await logLocation.getAttribute("open"), null);
    await logLocation.locator("summary").press("Space");
    assert.ok(await logLocation.locator("code").isVisible());
    await logLocation.locator("summary").press("Space");
    const settingsEntry = logPage.getByRole("button", { name: t("View detailed logs"), exact: true });
    await settingsEntry.press("Enter");
    await dialog.getByRole("alert").filter({ hasText: t("Logs could not be loaded.") }).waitFor();
    assert.equal(await dialog.getByText("INTERNAL_LOG_ERROR_QA").count(), 0);
    await dialog.getByRole("button", { name: t("Retry"), exact: true }).press("Enter");
    const outputRegion = dialog.getByRole("region", { name: t("Log output"), exact: true });
    await outputRegion.waitFor();
    assert.equal(await dialog.locator(".log-viewer-filename").textContent(), filename);
    await checkLayout(outputRegion, "Long log lines at 320px");
    await outputRegion.press("PageDown");
    await logPage.waitForFunction(() => (document.querySelector(".log-viewer-output")?.scrollTop ?? 0) > 0);
    await dialog.screenshot({ path: join(output, "logs-320.png") });
    await dialog.locator(".log-viewer-reload").press("Enter");
    await dialog.getByRole("status").filter({ hasText: t("No logs yet.") }).waitFor();
    await logPage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await settingsEntry.evaluate(node => document.activeElement === node), true);
    assert.equal(requests, 4);
    const response = await context.request.get(fixture.url + "/ui/api/logs");
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["cache-control"], "no-store");
    return { lateReadIgnored: true, failureRecovered: true, keyboardScroll: true, emptyState: true, narrowWidth: 320 };
  } finally {
    releaseFirst();
    await logPage.close();
  }
}

async function checkImportReceipt(context, t) {
  const receiptPage = await context.newPage();
  await receiptPage.setViewportSize({ width: 320, height: 650 });
  receiptPage.setDefaultTimeout(15_000);
  receiptPage.on("pageerror", error => errors.push(error.message));
  await receiptPage.route("**/ui/api/import/upload", route => route.fulfill({ json: {
    ok: true, files: 1, profiles: 23, cookiesStripped: 2, skipped: 3,
    errors: Array.from({ length: 55 }, (_, index) => ({
      file: "qa-source.csv", id: `qa_review_${index}`, error: "RAW_IMPORT_ERROR_QA", quarantined: index === 0,
    })),
  } }));
  try {
    await receiptPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const trigger = receiptPage.locator(".profiles-workspace .page-actions").getByRole("button", { name: t("Import profiles"), exact: true });
    await trigger.press("Enter");
    const dialog = receiptPage.getByRole("dialog", { name: t("Import profiles"), exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({ name: "qa-source.csv", mimeType: "text/csv", buffer: Buffer.from("id,name\nqa_source,Example\n") });
    await dialog.getByRole("button", { name: t("Import profiles"), exact: true }).press("Enter");
    const receipt = receiptPage.locator(".import-receipt");
    const expand = receipt.getByRole("button", { name: t("View import details"), exact: true });
    await expand.waitFor();
    await dialog.waitFor({ state: "hidden" });
    await receipt.and(receiptPage.locator('[aria-busy="false"]')).waitFor();
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    assert.equal(await receipt.locator(".import-receipt-list li").count(), 0, "Collapsed receipts do not mount hidden review rows");
    assert.deepEqual(await receipt.locator(".import-receipt-totals strong").allTextContents(), ["3", "2", "55"]);
    await checkLayout(receipt, "Import receipt summary at 320px");
    await receipt.screenshot({ path: join(output, "import-receipt-compact-320.png") });

    await expand.press("Enter");
    const region = receipt.getByRole("region", { name: t("Reported import items"), exact: true });
    assert.equal(await region.getByRole("listitem").count(), 50);
    await region.focus();
    assert.equal(await region.evaluate(node => document.activeElement === node), true);
    assert.ok(await region.evaluate(node => { node.scrollTop = 80; return node.scrollTop; }) > 0);
    await receipt.getByRole("button", { name: t("Next"), exact: true }).press("Enter");
    assert.equal(await region.getByRole("listitem").count(), 5);
    assert.deepEqual(await region.evaluate(node => ({ focused: document.activeElement === node, scroll: node.scrollTop })), { focused: true, scroll: 0 });
    assert.equal(await receipt.getByText("RAW_IMPORT_ERROR_QA").count(), 0);
    await checkLayout(receipt, "Expanded import receipt at 320px");
    await receipt.getByRole("button", { name: t("Dismiss import result"), exact: true }).and(receiptPage.locator(":enabled")).press("Enter");
    await receipt.waitFor({ state: "hidden" });
    await receiptPage.waitForFunction(() => document.activeElement?.id === "profiles-page-title");
    return { deferredDetails: true, keyboardPaging: true, dismissedFocusRestored: true, narrowWidth: 320 };
  } finally {
    await receiptPage.close();
  }
}

async function checkProfileDetails(context, t) {
  const detailPage = await context.newPage();
  await detailPage.setViewportSize({ width: 320, height: 530 });
  detailPage.setDefaultTimeout(15_000);
  detailPage.on("pageerror", error => errors.push(error.message));
  await detailPage.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.qaTimelineSignals = [];
    window.fetch = (input, options) => {
      if (typeof input === "string" && /\/timeline(?:\?|$)/.test(input) && options?.method === "GET") {
        window.qaTimelineSignals.push(options.signal);
      }
      return fetch(input, options);
    };
  });
  let freshReads = 0;
  let olderReads = 0;
  let deletions = 0;
  let releaseRead;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const row = (profileId, id, summary) => ({
    profileId, id, summary, createdAt: 1_795_000_200_000, eventType: "config.updated",
    actor: "user", status: "ok", detail: { fields: ["name"] }, recoveryKind: "",
  });
  await detailPage.route("**/ui/api/profiles/*/timeline*", async route => {
    const url = new URL(route.request().url());
    const profileId = decodeURIComponent(url.pathname.split("/").at(-2));
    if (route.request().method() === "DELETE") {
      deletions++;
      return route.fulfill({ json: { ok: true, profileId, removed: 2 } });
    }
    if (url.searchParams.has("beforeId")) {
      if (++olderReads === 1) return route.fulfill({ status: 503, json: { ok: false } });
      return route.fulfill({ json: { ok: true, profileId, events: [row(profileId, 10, "Older QA activity")], hasMore: false, nextBeforeId: null } });
    }
    if (++freshReads === 1) return route.fulfill({ status: 503, json: { ok: false, error: "INTERNAL_TIMELINE_QA" } });
    if (freshReads === 3) {
      await held;
      return route.fulfill({ json: { ok: true, profileId, events: [row(profileId, 99, "Late QA activity")], hasMore: false, nextBeforeId: null } }).catch(() => {});
    }
    return route.fulfill({ json: { ok: true, profileId, events: [row(profileId, 20, "Recent QA activity")], hasMore: true, nextBeforeId: 20 } });
  });
  try {
    await detailPage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await detailPage.locator(".profile-details-trigger").first().click();
    const panel = detailPage.locator(".profile-details-panel");
    const overview = panel.getByRole("tab", { name: t("Overview"), exact: true });
    const activity = panel.getByRole("tab", { name: t("Activity timeline"), exact: true });
    const draft = panel.locator(".quick-notes-panel textarea");
    await panel.locator(".quick-notes-edit-btn").click();
    await draft.fill("Unsaved QA draft");
    assert.ok((await panel.locator(".profile-details-content").boundingBox())?.height >= 100);
    await overview.press("ArrowRight");
    assert.equal(await activity.evaluate(node => node === document.activeElement), true);
    assert.equal(await overview.getAttribute("aria-selected"), "true");
    assert.equal(freshReads, 0, "Moving between tabs with arrows must not start an activity read");
    await detailPage.keyboard.press("Enter");
    await panel.getByRole("alert").filter({ hasText: t("Unable to load activity timeline.") }).waitFor();
    assert.equal(await panel.getByText(t("No activity recorded for this environment yet.")).count(), 0);
    assert.equal(await panel.getByText("INTERNAL_TIMELINE_QA").count(), 0);
    await panel.getByRole("button", { name: t("Retry"), exact: true }).press("Enter");
    await panel.getByText("Recent QA activity", { exact: true }).waitFor();
    await panel.getByRole("button", { name: t("Load older activity"), exact: true }).press("Enter");
    const retryOlder = panel.getByRole("button", { name: t("Retry loading older activity"), exact: true });
    await retryOlder.waitFor();
    assert.equal(await retryOlder.evaluate(node => node === document.activeElement), true);
    assert.equal(await panel.getByText("Recent QA activity", { exact: true }).isVisible(), true);
    await retryOlder.press("Enter");
    await panel.getByText("Older QA activity", { exact: true }).waitFor();
    await checkLayout(panel, "Profile details at 320×530");
    await panel.screenshot({ path: join(output, "profile-activity-320x530.png") });

    await Promise.all([
      detailPage.waitForRequest("**/ui/api/profiles/*/timeline*"),
      panel.getByRole("button", { name: t("Refresh timeline"), exact: true }).press("Enter"),
    ]);
    await overview.press("Enter");
    assert.equal(await draft.inputValue(), "Unsaved QA draft");
    await detailPage.waitForFunction(() => window.qaTimelineSignals.at(-1)?.aborted === true);
    releaseRead();
    await activity.press("Enter");
    await panel.getByText("Recent QA activity", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Late QA activity", { exact: true }).count(), 0);
    const clear = panel.getByRole("button", { name: t("Clear timeline"), exact: true });
    await clear.press("Enter");
    const confirmation = detailPage.getByRole("alertdialog", { name: t("Clear activity timeline?"), exact: true });
    await confirmation.waitFor();
    assert.equal(deletions, 0);
    await detailPage.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    assert.equal(await clear.evaluate(node => node === document.activeElement), true);
    await clear.press("Enter");
    await confirmation.getByRole("button", { name: t("Confirm clear"), exact: true }).press("Enter");
    await confirmation.waitFor({ state: "hidden" });
    await panel.getByText(t("No activity recorded for this environment yet."), { exact: true }).waitFor();
    assert.equal(deletions, 1);
    return { keyboardTabs: true, draftRetained: true, retryPreservesRows: true, backgroundReadCancelled: true, explicitClear: true, narrowWidth: 320 };
  } finally {
    releaseRead();
    await detailPage.close();
  }
}

async function checkWorkspaceSwitcher(context, t) {
  const workspacePage = await context.newPage();
  await workspacePage.setViewportSize({ width: 320, height: 360 });
  workspacePage.on("pageerror", error => errors.push(error.message));
  const current = { id: "default", name: "Current QA workspace", color: "#8169c8", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 };
  const workspaces = Array.from({ length: 24 }, (_, index) => ({
    ...current, id: `qa-${index}`, name: `QA Workspace With Independent Records ${index + 1}`,
  })).concat(current);
  const offlineMessage = "The local service could not be reached.";
  let offline = false;
  await workspacePage.route(`${fixture.url}/ui/api/workspaces`, route => {
    assert.equal(route.request().method(), "GET");
    return offline
      ? route.fulfill({ status: 503, json: { ok: false, error: offlineMessage } })
      : route.fulfill({ json: { ok: true, currentId: current.id, activeId: current.id, workspaces } });
  });
  const trigger = workspacePage.locator(".wm-rail-switcher .wm-workspace-trigger");
  const menu = workspacePage.getByRole("menu", { name: t("Workspaces"), exact: true });
  const waitForVisibleCurrent = () => workspacePage.waitForFunction(() => {
    const selected = document.activeElement;
    const panel = selected?.closest(".wm-switcher-popover");
    if (!panel || selected.getAttribute("aria-checked") !== "true") return false;
    const item = selected.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    return item.top >= bounds.top && item.bottom <= bounds.bottom;
  });
  try {
    await workspacePage.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await trigger.getByText(current.name, { exact: true }).waitFor({ state: "attached" });
    await trigger.press("ArrowDown");
    await menu.waitFor();
    await waitForVisibleCurrent();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= 313 && bounds.y + bounds.height <= 353, "The focused menu stays within the viewport");
    await workspacePage.screenshot({ path: join(output, "workspace-switcher-keyboard-320.png") });
    await workspacePage.keyboard.press("Home");
    assert.equal(await menu.getByRole("menuitemradio").first().evaluate(node => node === document.activeElement), true);
    await workspacePage.keyboard.press("ArrowUp");
    assert.equal(await menu.getByRole("menuitem", { name: t("Manage workspaces"), exact: true }).evaluate(node => node === document.activeElement), true);
    await workspacePage.keyboard.press("Escape");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);

    offline = true;
    await workspacePage.reload({ waitUntil: "domcontentloaded" });
    await trigger.press("ArrowDown");
    await menu.getByText(t(offlineMessage), { exact: true }).waitFor();
    offline = false;
    await menu.getByRole("menuitem", { name: t("Retry"), exact: true }).press("Enter");
    await waitForVisibleCurrent();
    assert.equal(await menu.getByText(t(offlineMessage), { exact: true }).count(), 0);
    return { workspaces: workspaces.length, currentVisibleOnOpen: true, retryRestoresFocus: true };
  } finally {
    await workspacePage.close();
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "zh-CN" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === fixture.url || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    outsideRequests.push(url.origin); return route.abort();
  });
  await context.addInitScript(() => {
    localStorage.setItem("aliasmode.shell.theme", "light");
    localStorage.setItem("aliasmode.shell.language", "zh-CN");
    localStorage.setItem("aliasmode.shell.sidebarCollapsed", "0");
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  console.log("UI QA: opening synthetic workspace");
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.locator("tr[data-profile-id]").first().waitFor();
  console.log("UI QA: production roster rendered");
  await page.locator('.roster-view-select select:enabled').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const zh = localeStrings("zh-CN");
  const desktopBridge = await checkDesktopBridge(page, zh);
  const [rosterRecovery, sseRecovery] = await Promise.all([checkRosterRecovery(context, zh), checkSseRecovery(context)]);
  const startupRecovery = await checkStartupRecovery(context, zh);
  const appLockRecovery = await checkAppLockRecovery(context, zh);
  const resourceRecovery = await checkResourceRecovery(context, zh);
  const packageReview = await checkPackageReview(context, zh);
  const fileUpdate = await checkFileUpdate(context, zh);
  const logs = await checkLogs(context, zh);
  const compactSettings = await checkCompactSettings(context, zh);
  const importReceipt = await checkImportReceipt(context, zh);
  const profileDetails = await checkProfileDetails(context, zh);
  const workspaceSwitcher = await checkWorkspaceSwitcher(context, zh);
  const groupManagement = await checkGroupManagement(context, zh);
  const rowActionNavigation = await checkRowActionNavigation(context, zh);
  const onboarding = await checkOnboardingChecklist(context);
  await page.screenshot({ path: join(output, "profiles-light-1440.png") });
  await checkImport(page, zh, "light-1440");
  assert.equal(await page.locator(".sidebar.collapsed").count(), 0);
  assert.equal(await page.locator(".roster-navigation .roster-views").count(), 1);
  assert.equal(await page.locator(".profiles-workspace > .roster-views").count(), 0);
  const comfortableHeight = await page.locator("tr[data-profile-id]").first().evaluate(node => node.getBoundingClientRect().height);
  await page.locator(".profile-view-tools .headactions .menuwrap > button").click();
  await page.locator('.roster-density-options button[role="radio"]').filter({ hasText: "紧凑" }).click();
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-roster-density') === 'compact');
  const compactHeight = await page.locator("tr[data-profile-id]").first().evaluate(node => node.getBoundingClientRect().height);
  assert.ok(compactHeight < comfortableHeight, "Display settings must actually change the row density");
  await page.locator('.roster-density-options button[role="radio"]').filter({ hasText: "舒适" }).click();
  await page.locator(".profile-view-tools .headactions .menuwrap > button").click();
  await page.locator('.roster-group-link[title="海外业务"]').click();
  assert.equal(await page.locator('.roster-group-link[title="海外业务"]').getAttribute('aria-current'), 'true');
  await page.locator('.roster-group-link').first().click();
  await page.locator(".profile-details-trigger").first().click();
  await page.locator(".profile-details-panel").waitFor();
  assert.equal(await page.locator(".profile-details-panel [data-profile-field], .profile-details-panel input[type=password]").count(), 0);
  await page.screenshot({ path: join(output, "profile-details-light.png") });
  await page.locator(".profile-details-close").click();
  await page.locator(".profile-name-button").first().click();
  await page.locator(".profile-edit-fields .profile-editor-layout").waitFor();
  const account = page.locator(".profile-editor-section-link").filter({ hasText: "账号" });
  await account.click();
  await page.waitForFunction(() => document.querySelector('.profile-editor-section-link[aria-current]')?.textContent?.includes('账号'));
  const editorOverflow = await page.locator(".modal.profile-editor").evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  assert.ok(editorOverflow.scroll <= editorOverflow.width + 2, "The editor must fit its window");
  await page.screenshot({ path: join(output, "profile-editor-light.png") });
  await page.locator(".profile-editor .modal-close").click();
  await page.locator(".profile-editor").waitFor({ state: "hidden" });
  await page.locator(".profile-details-trigger").first().click();
  await page.locator(".profile-details-actions button").last().click();
  await page.locator(".inspection-counts").waitFor();
  await page.screenshot({ path: join(output, "inspection-light.png") });
  await page.locator('.sidenav .navitem[aria-label="代理管理"]').click();
  await page.locator('.proxy-page .tools-tabs button').filter({ hasText: "替换代理" }).click();
  assert.equal(await page.locator('.proxy-workflow-navigation [data-proxy-workflow-step]').count(), 4);
  await page.locator('[data-proxy-workflow-step="input"]').click();
  assert.equal(await page.locator('.proxy-workflow-target:focus').count(), 1);
  await page.screenshot({ path: join(output, "proxy-workflow-light.png") });
  const proxyInput = page.locator(".proxy-input-panel");
  const [proxyPicker] = await Promise.all([
    page.waitForEvent("filechooser"),
    proxyInput.getByRole("button", { name: zh("Or upload a file"), exact: true }).press("Enter"),
  ]);
  const sampleProxy = "203.0.113.42:8080";
  await proxyPicker.setFiles({ name: "proxy-qa.txt", mimeType: "text/plain", buffer: Buffer.from(sampleProxy) });
  await page.waitForFunction((input) => document.querySelector(".proxy-input-panel textarea")?.value === input, sampleProxy);
  await proxyInput.locator(".proxy-input-feedback").waitFor();
  await proxyInput.locator("textarea").fill("");
  await page.locator('.sidenav .navitem[aria-label="AI 工作台"]').click();
  await page.locator('.assistant-session-guide').waitFor();
  assert.equal(await page.locator('.assistant-session-guide').getAttribute('open'), null);
  await page.screenshot({ path: join(output, "assistant-light.png") });
  await checkSecondaryPages(page, zh, "light-1440");
  const keyboardRoster = await checkKeyboardRoster(page, zh);
  for (const viewport of [{ width: 1024, height: 768 }, { width: 960, height: 640 }, { width: 520, height: 740 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(output, `profiles-${viewport.width}.png`) });
    const overflow = await checkLayout(page.locator("html"), `Environment list at ${viewport.width}px`);
    results.push({ viewport, overflow });
  }
  await page.setViewportSize({ width: 320, height: 530 });
  await checkImport(page, zh, "light-320");
  const shortRosterCheckbox = page.locator("tr[data-profile-id] .chk input").first();
  const shortTableHeight = (await page.locator(".profile-browser > .tablewrap").boundingBox())?.height;
  const hasDetails = await page.locator(".profile-browser.has-details").count() > 0;
  assert.ok(shortTableHeight >= (hasDetails ? 145 : 170),
    `The environment list must retain a usable height in a short window (measured ${shortTableHeight}px)`);
  await shortRosterCheckbox.check();
  assert.equal(await shortRosterCheckbox.isChecked(), true, "The first environment is selectable with a pointer in a short window");
  await page.screenshot({ path: join(output, "profiles-selected-320x530.png") });
  const moreActions = page.locator(".bulk-tools-toggle");
  await moreActions.press("Enter");
  const destination = page.locator(".action-dock-tray select.move-group");
  await destination.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches(".action-dock-tray select.move-group"));
  await destination.click({ trial: true });
  await page.screenshot({ path: join(output, "profiles-bulk-tools-320x530.png") });
  await destination.press("Escape");
  await destination.waitFor({ state: "hidden" });
  assert.equal(await moreActions.evaluate(button => document.activeElement === button), true, "Escape returns focus to the bulk actions trigger");
  const shortRoster = { viewport: { width: 320, height: 530 }, tableHeight: shortTableHeight, detailsVisible: hasDetails, pointerSelection: true, bulkDestinationReachable: true };
  await shortRosterCheckbox.uncheck();
  await checkLayout(page.locator("html"), "Environment list at 320×530");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("aliasmode.shell.theme", "dark"); document.cookie = "aliasmode.shell.theme=dark; Path=/; SameSite=Strict"; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("tr[data-profile-id]").first().waitFor();
  await page.screenshot({ path: join(output, "profiles-dark-1440.png") });
  await page.locator('.wm-device-trigger').click();
  await page.locator('.wm-device-language select').selectOption('ru-RU');
  await page.waitForFunction(() => document.documentElement.lang === 'ru-RU');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(output, "profiles-russian-dark.png") });
  await page.setViewportSize({ width: 520, height: 740 });
  const ru = localeStrings("ru-RU");
  await checkImport(page, ru, "russian-dark-520");
  await openSidebarPage(page, ru, "AI workspace", ".assistant-workspace");
  const modelSettings = page.getByRole("button", { name: ru("Model settings"), exact: true });
  await modelSettings.press("Enter");
  const connection = page.locator(".assistant-connection");
  await connection.waitFor();
  assert.equal(await page.locator(".assistant-chat").isVisible(), false, "Model settings use the workspace width on a narrow screen");
  await checkLayout(connection, "AI model settings at 520px");
  await page.screenshot({ path: join(output, "assistant-model-settings-russian-dark-520.png") });
  await connection.locator(".assistant-settings-close").press("Escape");
  await connection.waitFor({ state: "hidden" });
  assert.equal(await modelSettings.evaluate(node => node === document.activeElement), true, "Closing model settings returns focus to the entry button");
  await checkSecondaryPages(page, ru, "russian-dark-520");
  assert.deepEqual(errors, []);
  assert.deepEqual(outsideRequests, []);
  writeFileSync(join(output, "result.json"), JSON.stringify({ fixture: "synthetic", desktopBridge, results, shortRoster, keyboardRoster, rosterRecovery, sseRecovery, startupRecovery, appLockRecovery, resourceRecovery, packageReview, fileUpdate, logs, compactSettings, importReceipt, profileDetails, workspaceSwitcher, groupManagement, rowActionNavigation, onboarding, errors, outsideRequests }, null, 2));
  console.log(JSON.stringify({ ok: true, output, desktopBridge, results, shortRoster, keyboardRoster, rosterRecovery, sseRecovery, startupRecovery, appLockRecovery, resourceRecovery, packageReview, fileUpdate, logs, compactSettings, importReceipt, profileDetails, workspaceSwitcher, groupManagement, rowActionNavigation, onboarding }));
  await context.close();
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png"), timeout: 5_000 }).catch(() => {});
  throw error;
} finally { await browser.close(); }
