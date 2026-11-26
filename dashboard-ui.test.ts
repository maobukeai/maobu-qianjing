import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { localeTimezoneMismatch } from "./profile-locale.ts";
import { ProfileActionMenu } from "./web/profile-action-menu.tsx";
import { I18nProvider, translate } from "./web/i18n.tsx";
import { inProfileScope, type RosterScope } from "./profile-view-state.ts";
import { createBulkProfileTask } from "./web/bulk-profile-task.ts";
import { BulkProfileTaskPanel } from "./web/bulk-profile-task-panel.tsx";
import { PROFILE_EDIT_FORM_FIELDS } from "./web/profile-edit-patch.ts";
import { WorkbenchSidebar } from "./web/features/workbench-sidebar.tsx";
import { COLUMNS, computeRosterPipeline, paginateRoster } from "./web/hooks/use-roster-query.ts";
const readWebSource = (...segments: string[]) => readFileSync(join(import.meta.dir, "web", ...segments), "utf8").replaceAll("\r\n", "\n");
const appShell = readWebSource("app.tsx");
const rosterQuerySource = readWebSource("hooks", "use-roster-query.ts");
const virtualListSource = readWebSource("hooks", "use-virtual-list.ts");
const formHelpersSource = readWebSource("features", "profile-form-helpers.tsx");
const rosterRowSource = readWebSource("features", "profile-roster-row.tsx");
const rosterTableSource = readWebSource("features", "profile-roster-table.tsx");
const createModalSource = readWebSource("features", "profile-create-modal.tsx");
const editModalSource = readWebSource("features", "profile-edit-modal.tsx");
const importModalSource = readWebSource("features", "profile-import-modal.tsx");
const actionDockSource = readWebSource("components", "action-dock.tsx");
const toastStackSource = readWebSource("components", "toast-stack.tsx");
const rosterSkeletonSource = readWebSource("components", "roster-skeleton.tsx");
const app = [
    appShell,
    rosterQuerySource,
    virtualListSource,
    formHelpersSource,
    rosterRowSource,
    rosterTableSource,
    createModalSource,
    editModalSource,
    importModalSource,
    actionDockSource,
    toastStackSource,
    rosterSkeletonSource,
].join("\n");
const extensionPage = readFileSync(join(import.meta.dir, "web", "extensions-page.tsx"), "utf8");
const baseStyles = readFileSync(join(import.meta.dir, "web", "styles.css"), "utf8").replaceAll("\r\n", "\n");
const workbenchStyles = readFileSync(join(import.meta.dir, "web", "workbench-layout.css"), "utf8").replaceAll("\r\n", "\n");
const styles = `${baseStyles}\n${workbenchStyles}`;
const rosterNavigationStyles = readFileSync(join(import.meta.dir, "web", "features", "roster-navigation.css"), "utf8").replaceAll("\r\n", "\n");
const logo = readFileSync(join(import.meta.dir, "web", "maobu-mark.png"));
const notice = readFileSync(join(import.meta.dir, "NOTICE"), "utf8");
const actionMenu = readFileSync(join(import.meta.dir, "web", "profile-action-menu.tsx"), "utf8").replaceAll("\r\n", "\n");
const cookieImportUi = readFileSync(join(import.meta.dir, "web", "cookie-import-task-panel.tsx"), "utf8");
const fileUpdateUi = readFileSync(join(import.meta.dir, "web", "profile-file-update-panel.tsx"), "utf8");
const defaultPageSize = Number(rosterQuerySource.match(/export const PROFILE_PAGE_SIZE = (\d+);/)?.[1]);

function sidebarMarkup(overrides: Partial<Parameters<typeof WorkbenchSidebar>[0]> = {}) {
    return renderToStaticMarkup(createElement(I18nProvider, { children: createElement(WorkbenchSidebar, {
        compact: false, collapsed: false, forced: false, view: "profiles", profileCount: 3, extensionCount: 2, loaded: true,
        onToggle() {}, onNavigate() {}, onProfiles() {}, onExtensions() {}, onSettings() {}, switcher: null, device: null, ...overrides,
    }) }));
}

/** Execute production selectors, rather than maintaining a second filter in tests. */
function sourceBetween(start: string, end: string, sourceText = app): string {
    const from = sourceText.indexOf(start);
    const to = sourceText.indexOf(end, from + start.length);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return sourceText.slice(from, to);
}
function rosterColumns(): Array<{ key: string; label: string; width: number; sort: boolean }> {
    return [...COLUMNS];
}
type RosterProfile = { id: string; name: string; group: string; running: boolean; proxy?: string | null; tags?: string[]; platform?: string; lastOpenAt?: number; proxyError?: string };
function rosterPipeline(profiles: RosterProfile[], options: {
    q?: string; group?: string; scope?: Set<string>; status?: "all" | "running" | "stopped";
    sort?: { key: string; dir: 1 | -1 }; page?: number; pageSize?: number;
    numbering?: Map<string, { value: string }>;
    quickScope?: RosterScope; favorites?: string[];
} = {}) {
    return computeRosterPipeline({
        profiles,
        group: options.group ?? "all",
        selectedScope: options.scope ?? new Set([options.group ?? "all"]),
        q: options.q ?? "",
        numbering: options.numbering ?? new Map(profiles.map((profile, index) => [profile.id, { value: String(index + 1) }])),
        profileStatus: options.status ?? "all",
        sort: (options.sort as { key: any; dir: 1 | -1 }) ?? { key: "no", dir: 1 },
        pageSize: options.pageSize ?? defaultPageSize,
        profilePage: options.page ?? 0,
        rosterScope: options.quickScope ?? "all",
        favoriteProfileIds: new Set(options.favorites ?? []),
    });
}
test("dashboard renders the local brand image from its bundled asset", () => {
    expect(app).toContain("function MaobuMark(");
    expect(app).toContain('import maobuMarkUrl from "./maobu-mark.png"');
    expect(app).toContain('src={maobuMarkUrl} width={32} height={32} alt=""');
    expect(app).toContain('<MaobuMark />猫步·千境');
    expect(app).not.toContain("AliasLoop");
    expect(logo.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
test("dashboard is a local-only shell without account or mode switching", () => { expect(app).toContain("猫步·千境"); expect(app).toContain('readiness: "local"'); expect(app).not.toContain("ModeSwitchConfirmation"); expect(app).not.toContain("Sign in to AliasMode Cloud"); expect(app).not.toContain("requestModeSwitch"); });
test("dashboard offers HTTPS proxies in both profile forms", () => {
    expect(app.match(/<option value="https">https<\/option>/g)).toHaveLength(2);
});
test("dashboard warns about low disk space without blocking anything", () => {
    expect(app).toContain("const timer = setInterval(check, 60_000);");
    expect(app).toContain("{diskSpace?.low && diskSpace.freeBytes !== null && !diskWarningDismissed && (");
    expect(app).toContain('<div className="update-banner update-result warning" role="alert">');
    expect(app).toContain('aria-label={t("Dismiss disk space warning")}');
    // The warning never disables an action.
    expect(app).not.toMatch(/disabled=\{[^}]*diskSpace/);
});
test("dashboard contains long roster labels inside the window", () => {
    expect(app).toContain('className="profile-table"');
    // The truncatable name now also opens the profile sheet by keyboard or click.
    expect(app).toContain('className="n profile-name-button"');
    expect(app).toContain('aria-label={t("Edit {profile}", { profile: p.name })} onClick={() => openEdit(p.id)}');
    expect(app).toContain('<td className="col-group" title={p.group}>');
    expect(app).toContain('className="select move-group"');
    // Every truncatable cell carries its full value as a title, so hovering shows
    // what the ellipsis hid.
    expect(app).toContain('title={`${p.name}\\n${p.id}`}');
    expect(app).toContain('title={p.tags?.length ? p.tags.join(", ") : "No tags"}');
    expect(app).toContain('title={p.proxyError || p.proxy || "no proxy"}');
    // Fixed layout plus per-column clipping keeps a long value inside its cell.
    expect(styles).toContain("table-layout: fixed");
    expect(styles).toContain("td.col-no, td.col-name, td.col-group, td.col-tags, td.col-proxy { overflow: hidden; text-overflow: ellipsis; }");
});
test("dashboard shows close warnings without an open-only prefix", async () => {
    // Batch outcomes now belong to the production task runner and its result panel.
    expect(app).toContain('const closeSelected = () => bulkRun("close");');
    expect(app).toContain("const task = createBulkProfileTask({ action, targets, concurrency: 4, run: async id => {");
    expect(app).toContain('action === "close" ? closeProfile : restartProfile');
    const snapshot = await createBulkProfileTask({ action: "close", targets: [{ id: "warning", name: "Closing with warning" }, { id: "failure", name: "Unconfirmed close" }], run: async id => id === "warning"
        ? { ok: true, warning: "Browser teardown completed with a warning" } : { ok: false, error: "Browser teardown remains unconfirmed" } }).start();
    expect(snapshot.rows[0]).toMatchObject({ status: "succeeded", warning: "Browser teardown completed with a warning" });
    expect(snapshot.rows[1]).toMatchObject({ status: "failed", error: "Browser teardown remains unconfirmed" });
    const markup = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(BulkProfileTaskPanel, { snapshot, expanded: true, onExpandedChange() {}, onStopPending() {}, onRetryFailed() {}, onDismiss() {} }) }));
    expect(markup).toContain("Batch close");
    expect(markup).toContain("Browser teardown completed with a warning");
    expect(markup).toContain("Browser teardown remains unconfirmed");
    expect(markup).not.toContain("Opened —");
});
test("dashboard lists the supported profile platforms", () => {
    for (const platform of [
        "x.com",
        "instagram.com",
        "facebook.com",
        "tiktok.com",
        "linkedin.com",
        "reddit.com",
        "telegram.org",
    ]) {
        expect(app).toContain(`value: "${platform}"`);
    }
});
test("New and Edit profile dialogs keep proxy validation without provider promotions", () => {
    const create = createModalSource.slice(createModalSource.indexOf("<MotionPresence present={showCreate}>"));
    const edit = editModalSource.slice(editModalSource.indexOf("<MotionPresence present={!!editId}>"));
    for (const modal of [create, edit]) {
        expect(modal).toContain("Check proxy");
        expect(modal).toContain("<ProxyCheckFeedback");
    }
    expect(app).toContain("generation === createProxyCheckGeneration.current");
    expect(app).toContain("generation === editProxyCheckGeneration.current");
    expect(app).not.toContain("ProxyProviderOffer");
    expect(app).not.toContain("proxyOfferUrl");
    expect(app).not.toContain("nobleproxy.com");
    expect(app).not.toContain("xreacher.com");
    for (const tone of ["working", "unstable", "failed", "unavailable"])
        expect(styles).toContain(`<TONE>`.replace("<TONE>", ".proxy-check-result." + tone));
});
test("dashboard selects browser for new profiles", () => {
    const createModal = createModalSource.slice(createModalSource.indexOf("<MotionPresence present={showCreate}>"));
    const editModal = editModalSource.slice(editModalSource.indexOf("<MotionPresence present={!!editId}>"));
    expect(createModal).toContain('className="browser-options"');
    expect(createModal).toContain('engine: "chromium", label: "Chrome"');
    expect(createModal).toContain('engine: "firefox", label: "Firefox"');
    // The help text follows the engine that this computer creates, such as Chromium 155 on a Mac.
    expect(createModal).toContain('profileCreationRuntime("chromium", form.chromiumRuntime, appMode?.chromiumRuntime) ?? appMode?.defaultChromiumRuntime');
    expect(createModal).toContain('const runtime = browserLabel(engine, selectedRuntime === "cloakbrowser" ? "" : selectedRuntime);');
    expect(createModal).toContain('type="radio" name="browser-engine"');
    expect(createModal).toContain('checked={form.engine === engine}');
    expect(createModal).toContain('setF("engine", engine)');
    expect(createModal).toContain('aria-label={`${label}: ${runtime}`}');
    expect(createModal).toContain('data-tip={runtime}');
    expect(createModal).not.toContain('<select value={form.engine}');
    // The browser choice comes before the optional Proxy and Fingerprint sections.
    expect(createModal.indexOf('className="browser-options"')).toBeLessThan(createModal.indexOf('open={createProxyOpen}'));
    expect(createModal.indexOf('open={createProxyOpen}')).toBeLessThan(createModal.indexOf('<FingerprintSettings'));
    expect(createModal.indexOf('className="browser-options"')).toBeLessThan(createModal.indexOf('className="modal-foot profile-editor-status-footer"'));
    expect(styles).toContain('.browser-info:focus-visible::after');
    expect(styles).toContain('.browser-card:has(input:focus-visible)');
    expect(styles).toContain('.browser-card:has(input:checked) { background: var(--browser-selected);');
    expect(styles).not.toContain('.browser-option:has(input:checked) { color: var(--browser-surface); }');
    expect(app).toContain("engine: form.engine,");
    expect(editModal).toContain('value={editEngine ? browserLabel(editEngine, editChromiumRuntime) : ""} readOnly');
    expect(editModal).not.toContain('setEF("engine"');
    expect(editModal).not.toContain('setEF("chromiumRuntime"');
    // New profiles start on this computer's default engine: AliasMode Chromium on Windows, AliasMode
    // Firefox on macOS and Linux. Chromium 155 is AliasMode Chromium on every computer.
    expect(app).toContain('return chromiumRuntime ? "Chromium" : "CloakBrowser";');
    expect(app).not.toContain("155 beta");
    const beginCreate = sourceBetween("const beginCreate =", "const reuseProfileConfiguration =", createModalSource);
    expect(beginCreate).toContain("const draft: typeof BLANK_FORM = {");
    expect(beginCreate).toContain('engine: appMode?.defaultEngine ?? "chromium"');
    expect(beginCreate).toContain('chromiumRuntime: appMode?.defaultChromiumRuntime ?? ""');
    expect(beginCreate.indexOf("const draft:")).toBeLessThan(beginCreate.indexOf("if (reuse)"));
    expect(beginCreate).toContain("setForm(draft);");
    // Execute the real draft initialization, including the safe reuse overlay.
    // Mounted success/late/failure/host-override flows also run in web/app-create.test.ts.
    const draftSource = new Bun.Transpiler({ loader: "ts" }).transformSync(`${sourceBetween("export const BLANK_FORM =", "export type CreateProfileForm =", formHelpersSource).replace("export const BLANK_FORM", "const BLANK_FORM")}\n${beginCreate}`);
    const prepareDraft = new Function("appMode", "group", "reuse", "t", `
      const showCreate = false, createInFlight = { current: false }, isEditSessionOpen = () => false, createReturnFocus = { current: null }, profiles = [];
      const createCloseGuard = { reset() {} }, initialCreateForm = { current: null };
      const cancelReuseRead = () => {}, resetCreateProxyCheck = () => {}, noop = () => {};
      const setCreateReuseSource = noop, setCreateProxySource = noop, setProxyPaste = noop, setProxyPasteOk = noop, setProxyPasteInvalid = noop, setCreateErr = noop, setCreateProxyOpen = noop, setShowCreate = noop;
      let form; const setForm = value => { form = value; };
      ${draftSource}\n beginCreate(undefined, undefined, reuse); return form;
    `);
    const t = (source: string, values?: Record<string, string | number>) => translate({ "en-US": {} }, "en-US", source, values);
    expect(prepareDraft({ defaultEngine: "firefox", defaultChromiumRuntime: "" }, "Work", undefined, t)).toMatchObject({ engine: "firefox", chromiumRuntime: "", group: "Work" });
    expect(prepareDraft({ defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" }, "all", undefined, t)).toMatchObject({ engine: "chromium", chromiumRuntime: "aliasmode", group: "" });
    expect(prepareDraft(null, "all", undefined, t)).toMatchObject({ engine: "chromium", chromiumRuntime: "", group: "" });
    const reused = prepareDraft({ defaultEngine: "chromium", defaultChromiumRuntime: "aliasmode" }, "Other", { sourceId: "source", name: "Source", group: "QA", engine: "chromium", chromiumRuntime: "cloakbrowser", platformOs: "windows", screen: "1680x1050", platform: "example.com", username: "SECRET", host: "secret.invalid", fingerprintSeed: 123, customNo: "123" }, t);
    expect(reused).toMatchObject({ name: "Source copy", group: "QA", engine: "chromium", chromiumRuntime: "", platformOs: "windows", screen: "1680x1050", platform: "example.com", username: "", host: "", customNo: "" });
    expect(reused).not.toHaveProperty("fingerprintSeed");
    // Chrome version: 155 is the default where this computer can run it, and 146 stays the default
    // elsewhere. Choosing 146 uses CloakBrowser.
    expect(createModal).toContain('{form.engine === "chromium" && !appMode?.chromiumRuntime && (');
    expect(createModal).toContain('? <><option value="aliasmode">{t("Chromium 155 (default)")}</option><option value="">{t("CloakBrowser 146")}</option></>');
    expect(createModal).toContain(': <><option value="">{t("CloakBrowser 146 (default)")}</option><option value="aliasmode">{t("Chromium 155")}</option></>}');
    expect(app).toContain('chromiumRuntime: "" as FormChromiumRuntime');
    expect(app).toContain('...(createRuntimeInput ? { chromiumRuntime: createRuntimeInput } : {}),');
    expect(createModal).toContain('<option value="auto">{t("Device default")}</option>');
    // A CloakBrowser choice or profile shows the linkability note, in every bundled language.
    const note = "CloakBrowser profiles on one computer can be linked to each other. Use Chromium or Firefox for separate identities.";
    expect(app).toContain(`export const CLOAKBROWSER_NOTE = "${note}";`);
    expect(createModal).toMatch(/!form\.chromiumRuntime\s+\? t\(CLOAKBROWSER_NOTE\)/);
    expect(editModal).toContain('{editEngine === "chromium" && !editChromiumRuntime && <small>{t(CLOAKBROWSER_NOTE)}</small>}');
    // The browser stays unknown until the profile loads, so a failed load never claims CloakBrowser.
    expect(app).toContain('useState<"chromium" | "firefox" | null>(null)');
    expect(app).not.toContain('setEditEngine("chromium")');
    expect(editModal).toContain("{editEngine && (");
    expect(editModal).toContain("<FingerprintSettings");
    // The fingerprint hints hold for every engine, so they name none.
    const hints = [
        "The browser keeps the locked values coordinated. Screen and operating system are the only fingerprint settings you can override.",
        "Leave timezone or CPU blank for automatic settings. Screen size and fingerprint seed need explicit values; a blank language keeps the saved language. A timezone you type stays when the proxy changes.",
        "We recommend keeping every setting automatic. Custom values can make the browser look inconsistent, easier to detect, and can trigger account checks.",
    ];
    for (const hint of hints)
        expect(app).toContain(`t("${hint}")`);
    expect(app).not.toContain("CloakBrowser keeps the locked values");
    expect(app).not.toContain("CloakBrowser controls the other values");
    for (const locale of ["ru-RU", "zh-CN"]) {
        const catalog = JSON.parse(readFileSync(join(import.meta.dir, "web", "locales", `${locale}.json`), "utf8"));
        expect(catalog[note]).toContain("Chromium");
        for (const hint of hints)
            expect(catalog[hint]).toBeTruthy();
    }
    expect(app).toContain('Native Firefox profile · no CDP, PDF, or Chrome extensions');
    expect(app).toContain('p.running && p.engine === "chromium" && <button role="menuitem"');
    expect(app).toContain('selectedProfilesSupportChromeExtensions');
});
test("both engines offer OS choices at creation and only Chromium allows later OS edits", () => {
    const settings = formHelpersSource.slice(formHelpersSource.indexOf("export function FingerprintSettings("), formHelpersSource.indexOf("export function FingerprintSettings(") + 4200);
    expect(settings).not.toMatch(/\{engine === "chromium" && \(\s*<label className="fld">\s*<span>Operating system/);
    for (const os of ["windows", "macos", "linux"])
        expect(settings).toContain(`<option value="${os}">`);
    expect(settings).toContain("{onPlatformOsChange ? (");
    expect(settings).toContain("onPlatformOsChange(event.target.value)");
    expect(settings).toContain('readOnly tabIndex={-1} className="ro"');
    expect(app).toContain('platformOs={form.platformOs} onPlatformOsChange={(value) => setF("platformOs", value)}');
    expect(app).toContain('platformOs={editForm.platformOs ?? ""} onPlatformOsChange={editEngine === "chromium" ? (value) => setEF("platformOs", value) : undefined}');
});
test("Local timezone follows the proxy and can be refreshed on request", () => {
    expect(app).toContain("Stored · set from the proxy automatically");
    expect(app).toContain("refreshProfileTimezone(id)");
    expect(app).toContain("Set timezone and language from proxy");
});
test("Edit shows the profile language and flags one that does not match the timezone", () => {
    expect(app).toContain("localeTimezoneMismatch(editForm.locale, editForm.timezone ?? \"\")");
    expect(localeTimezoneMismatch("en-GB", "America/New_York")).toBe(true);
    expect(localeTimezoneMismatch("en-US", "America/New_York")).toBe(false);
    expect(localeTimezoneMismatch("en", "America/New_York")).toBe(false);
    expect(localeTimezoneMismatch("en-GB", "Not/AZone")).toBe(false);
});
test("every editable row and the selection bar can add cookies; closed profiles get them at next start", () => {
    const menu = sourceBetween('<ProfileActionMenu label={t("Actions for {profile}"', "</ProfileActionMenu>");
    expect(menu).toMatch(/canEditRow && <button role="menuitem"[^\n]+onClick=\{\(\) => openCookie\(\[p\]\)\}/);
    expect(app).toContain("onClick={() => openCookie([p])}");
    expect(app).toContain("onClick={() => openCookie(profiles.filter((profile) => selected.has(profile.id)))}");
    // Add cookies is a general menu item, before the running-Chromium-only focus action.
    expect(menu.indexOf("openCookie([p])")).toBeLessThan(menu.indexOf('p.running && p.engine === "chromium"'));
    expect(app).toContain('<CookieImportTaskDialog task={cookieImport.task}');
    expect(cookieImportUi).toContain('role="dialog" aria-modal="true"');
    for (const field of ["Name", "Value", "Domain", "Path"]) expect(cookieImportUi).toContain(`<span>{t("${field}")}</span>`);
    expect(cookieImportUi).toContain('type="password" autoComplete="off"');
    expect(cookieImportUi).toContain('"Paste cookie JSON" : "Paste cookies.txt content"');
    expect(cookieImportUi).toContain('task.submit(targets, input)');
    expect(app).toContain('{t("{count} cookie(s) at next start", { count: String(p.pendingCookieCount) })}');
    expect(app).not.toContain('className="modal-backdrop" onClick={closeCookie}');
});
test("bulk import uploads provider files unchanged", () => {
    expect(app).toContain('const list = Array.from(files);');
    expect(app).toMatch(/const uploads = bulkSource === "file"\s*\? bulkFiles/);
    expect(app).not.toContain("prepUploads");
    expect(app).not.toContain("csvToBlocks");
    expect(app).toContain('accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"');
    for (const provider of ["AdsPower", "GoLogin", "Multilogin", "Dolphin Anty", "HideMyAcc", "Incogniton", "Donut"]) {
        expect(app).toContain(provider);
    }
});
test("the group manager edits persistent local groups without workspace roles", () => {
    expect(app).toContain("setRegisteredGroups(roster.groups)");
    expect(app).toContain("folderTree(folders)");
    expect(app).toContain('className="group-management-dialog"');
    expect(app).toContain('t("New group")');
    expect(app).toContain("await createGroup(name, newFolderParent)");
    expect(app).toContain("await deleteGroup(g)");
    expect(app).not.toContain("cloudWorkspaceAction");
    expect(app).toContain("await moveGroup(source.name, folderParent)");
});
test("the roster numbers every profile and prefers a custom NO. over the serial", () => {
    // Mirrors profileDisplayNo in launcher.ts so the row, the browser window title
    // and the identity bookmark all show the same number.
    expect(app).toContain("export function displayNo(");
    expect(app).toContain('const custom = (profile.customNo ?? "").trim();');
    expect(app).toContain("if (custom) return { value: custom, custom: true };");
    expect(app).toContain("if (profile.serial != null) return { value: String(profile.serial), custom: false };");
    // Numbering is resolved against the unsorted roster, so sorting cannot renumber rows.
    expect(app).toContain("profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));");
    expect(app).toContain('className={`no-text${no.custom ? " custom" : ""}`}');
    // The number stands alone — the colored identity disc was removed on request.
    expect(app).not.toContain("ProfileAvatar");
    expect(styles).not.toContain(".no-avatar");
});
test("the custom NO. editor is Local-only and digits-only", () => {
    expect(app).toContain("export const MAX_CUSTOM_NO = 12;"); // matches MAX_CUSTOM_NO_LENGTH in parse.ts
    expect(app).toContain("<span>{t(\"Custom NO.\")}</span>");
    expect(app).toContain("<small>{t(\"Digits only · blank uses the serial\")}</small>");
    // The placeholder shows the serial that would be used instead, so an empty
    // field is never ambiguous about what the browser window will display.
    expect(app).toContain('placeholder={editSerial != null ? String(editSerial) : t("Automatic")}');
    expect(app).toContain('setEF("customNo", e.target.value.replace(/\\D/g, "").slice(0, MAX_CUSTOM_NO))');
    expect(PROFILE_EDIT_FORM_FIELDS).toContain("customNo");
    expect(app).toContain("updateProfile(session.id, changes.patch)");
    expect(app).toContain('...({ customNo: form.customNo }),');
});
test("the roster is sortable, pageable and its columns are selectable", () => {
    expect(app).toContain("const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: \"no\", dir: 1 });");
    expect(app).toContain("current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }");
    // A running browser is the row an operator acts on next, so it outranks the sort column.
    expect(app).toContain("if (a.running !== b.running) return a.running ? -1 : 1;");
    expect(app).toContain('aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}');
    expect(app).toContain('aria-label={t("Choose visible columns")}');
    expect(app).toContain('aria-label={t("Rows per page")}');
    expect(app).toContain('<button type="button" className="th-inner" onClick={() => onToggleSort(key)}>');
    expect(defaultPageSize).toBe(20);
    expect(app).toContain("export const PAGE_SIZES = [20, 25, 50, 100, 200, 0];");
    expect(app).toContain('export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["no", "group", "platform", "tags"];');
    // Layout preferences are a convenience; disabled storage must not break the roster.
    expect(app).toContain("return new Set(DEFAULT_HIDDEN_COLUMNS);");
    expect(app).toContain("catch { /* private mode / disabled storage */ }");
});
test("search matches tags, proxy, group, number, name and ID within the chosen folder and status", () => {
    const profiles: RosterProfile[] = [
        { id: "alpha", name: "First", group: "A", tags: ["Warm", "Priority"], proxy: "Proxy.Example:8080", running: true },
        { id: "beta", name: "Second", group: "B", tags: ["warm"], proxy: "192.0.2.61:1080", running: false },
        { id: "gamma", name: "Third", group: "A", tags: [], proxy: null, running: false },
        { id: "delta", name: "Fourth", group: "A", running: false },
    ];
    const numbering = new Map(profiles.map((p, i) => [p.id, { value: String(i + 101) }]));
    const ids = (q: string, group = "all", status: "all" | "running" | "stopped" = "all") => rosterPipeline(profiles, { q, group, status, numbering }).filtered.map(p => p.id);
    expect(ids("WARM")).toEqual(["alpha", "beta"]);
    expect(ids("warm", "A")).toEqual(["alpha"]);
    expect(ids("rior")).toEqual(["alpha"]);
    expect(ids("GAMMA")).toEqual(["gamma"]);
    expect(ids("FOURTH")).toEqual(["delta"]);
    expect(ids("103")).toEqual(["gamma"]);
    expect(ids("missing")).toEqual([]);
    expect(ids("", "A")).toEqual(["alpha", "gamma", "delta"]);
    expect(ids("PROXY.EXAMPLE")).toEqual(["alpha"]);
    expect(ids("192.0.2.61:1080")).toEqual(["beta"]);
    expect(ids("192.0.2.61", "A")).toEqual([]);
    expect(ids("warm", "all", "running")).toEqual(["alpha"]);
    expect(ids("warm", "all", "stopped")).toEqual(["beta"]);
    expect(ids("Fourth", "all", "running")).toEqual([]);
    expect(rosterPipeline(profiles, { q: "warm", group: "Parent", scope: new Set(["Parent", "A"]), numbering }).filtered.map(p => p.id)).toEqual(["alpha"]);
    const tagged = Array.from({ length: 60 }, (_, i) => ({ id: `p-${i}`, name: "Profile", group: "A", tags: ["Warm"], running: false }));
    const matched = rosterPipeline(tagged, { group: "A", q: "warm" }).filtered;
    const selection = rosterSelection(matched, new Set(["other-folder"]), "A", "warm");
    selection.selectAllFiltered();
    expect(selection.selected().size).toBe(60);
    expect(selection.selected().has("other-folder")).toBe(false);
    const page = rosterSelection(matched, new Set(), "A", "warm", 1);
    page.toggleAll();
    expect(page.selected().size).toBe(20);
    const legacyPage = rosterSelection(matched, new Set(), "A", "warm", 1, 50);
    legacyPage.toggleAll();
    expect(legacyPage.selected().size).toBe(10);
});
test("profile heading and empty state expose import without cloud permissions", () => {
    const heading = sourceBetween('className="page-heading"', 'className="profile-status-tabs"', appShell);
    const empty = rosterTableSource.slice(rosterTableSource.indexOf('className="empty-actions"'), rosterTableSource.indexOf('className="empty-actions"') + 450);
    expect(heading).toContain("onClick={importModal.openBulk}");
    expect(heading).not.toContain("canEditCloud");
    expect(empty).toContain("onClick={onOpenBulk}");
    expect(empty).not.toContain("canEditCloud");
    expect(heading).toContain('{t("Import profiles")}');
    expect(heading).toContain("onClick={createModal.openCreate}");
});
function rosterSelection(filtered: {
    id: string;
}[], selected = new Set<string>(), group = "all", q = "", page = 0, pageSize = defaultPageSize) {
    const visible = paginateRoster(filtered, pageSize, page).visibleProfiles;
    const source = sourceBetween("const allVisibleSelected =", "const completeMove =", appShell);
    const controls = new Function("selectableProfiles", "filtered", "selected", "group", "q", "setSelected", "t", "useMemo", `${source}
    return { toggleAll, selectAllFiltered, allFilteredSelected, selectedOutsideFilter, selectionScope };`)(visible, filtered, selected, group, q, (next: Set<string> | ((current: Set<string>) => Set<string>)) => {
        selected = typeof next === "function" ? next(selected) : next;
    }, (source: string, values?: Record<string, string | number>) => translate({ "en-US": {} }, "en-US", source, values),
    (compute: () => unknown) => compute());
    return { ...controls, selected: () => selected };
}
test("page selection stays page-only and scope selection reaches all 1600 profiles", () => {
    const profiles = Array.from({ length: 1600 }, (_, i) => ({ id: `profile-${i}` }));
    const page = rosterSelection(profiles);
    page.toggleAll();
    expect([...page.selected()]).toEqual(profiles.slice(0, 20).map((p) => p.id));
    const secondPage = rosterSelection(profiles, page.selected(), "all", "", 1);
    secondPage.toggleAll();
    expect([...secondPage.selected()]).toEqual(profiles.slice(0, 40).map((p) => p.id));
    const deselectSecond = rosterSelection(profiles, secondPage.selected(), "all", "", 1);
    deselectSecond.toggleAll();
    expect([...deselectSecond.selected()]).toEqual(profiles.slice(0, 20).map((p) => p.id));
    const scope = rosterSelection(profiles, page.selected());
    expect(scope.allFilteredSelected).toBe(false);
    scope.selectAllFiltered();
    expect([...scope.selected()]).toEqual(profiles.map((p) => p.id));
    expect(rosterSelection(profiles, scope.selected(), "all", "", 12).allFilteredSelected).toBe(true);
});
test("folder and search scope selection replaces unrelated hidden selections", () => {
    const profiles = Array.from({ length: 1600 }, (_, i) => ({ id: `folder-${i}` }));
    const scope = rosterSelection(profiles, new Set(["other-folder"]), "Imported");
    expect(scope.selectedOutsideFilter).toBe(1);
    expect(scope.selectionScope).toContain("Imported");
    scope.selectAllFiltered();
    expect([...scope.selected()]).toEqual(profiles.map((p) => p.id));
    expect(scope.selected().has("other-folder")).toBe(false);
    const matches = profiles.filter((_, i) => i % 2 === 0);
    const search = rosterSelection(matches, scope.selected(), "Imported", "search");
    expect(search.selectedOutsideFilter).toBe(800);
    expect(search.allFilteredSelected).toBe(false);
    search.selectAllFiltered();
    expect([...search.selected()]).toEqual(matches.map((p) => p.id));
    expect(rosterSelection([], new Set()).allFilteredSelected).toBe(false);
});

test("status and proxy search filter the complete folder scope before paging and bulk selection", () => {
    const profiles: RosterProfile[] = Array.from({ length: 240 }, (_, index) => ({
        id: `profile-${index}`, name: `Profile ${index}`, group: index % 2 ? "B" : "A",
        running: index % 3 === 0, proxy: index < 180 ? "192.0.2.12:8080" : "203.0.113.24:1080",
    }));
    const options = { q: "192.0.2.12", group: "Parent", scope: new Set(["Parent", "A"]), status: "running" as const };
    const first = rosterPipeline(profiles, options);
    const second = rosterPipeline(profiles, { ...options, page: 1 });
    expect(first.matchingProfiles).toHaveLength(90);
    expect(first.matchingRunningCount).toBe(30);
    expect(first.filtered.map(profile => profile.id)).toEqual(Array.from({ length: 30 }, (_, index) => `profile-${index * 6}`));
    expect(first.visibleProfiles).toHaveLength(20);
    expect(second.visibleProfiles).toHaveLength(10);
    expect(first.profilePageCount).toBe(2);
    const page = rosterSelection(first.filtered, new Set(), "Parent", options.q, 1);
    page.toggleAll();
    expect([...page.selected()]).toEqual(second.visibleProfiles.map(profile => profile.id));
    const scope = rosterSelection(first.filtered, new Set([...page.selected(), "outside-filter"]), "Parent", options.q);
    expect(scope.selectedOutsideFilter).toBe(1);
    scope.selectAllFiltered();
    expect([...scope.selected()]).toEqual(first.filtered.map(profile => profile.id));
    const stopped = rosterPipeline(profiles, { ...options, status: "stopped" });
    expect(stopped.filtered).toHaveLength(60);
    expect(rosterSelection(stopped.filtered, scope.selected()).selectedOutsideFilter).toBe(30);
    for (const status of ["all", "running", "stopped"]) {
        expect(app).toContain(`aria-pressed={profileStatus === "${status}"}`);
        expect(app).toContain(`onClick={() => setProfileStatus("${status}")}`);
    }
});

test("sorting keeps running rows first without renumbering and paging clamps after results shrink", () => {
    const profiles: RosterProfile[] = [
        { id: "first", name: "Zulu", group: "A", running: false },
        { id: "second", name: "Alpha", group: "A", running: true },
        { id: "third", name: "Bravo", group: "A", running: false },
    ];
    expect(rosterPipeline(profiles, { sort: { key: "name", dir: -1 } }).filtered.map(profile => profile.id)).toEqual(["second", "first", "third"]);
    expect(profiles.map(profile => profile.id)).toEqual(["first", "second", "third"]);
    const shrunk = rosterPipeline(profiles, { page: 100 });
    expect(shrunk.visibleProfilePage).toBe(0);
    expect(shrunk.visibleProfiles).toHaveLength(3);
    const empty = rosterPipeline(profiles, { q: "no-match", page: 100 });
    expect(empty.profilePageCount).toBe(1);
    expect(empty.visibleProfilePage).toBe(0);
    expect(empty.visibleProfiles).toEqual([]);
});

test("a filter reset wins over a simultaneous page clamp; deleting the last page only clamps", () => {
    const source = sourceBetween("useEffect(() => {\n    const previous = previousProfileFilters.current;", "const rangeViewKey =", appShell);
    const original = { q: "", group: "all", pageSize: 20, profileStatus: "all", selectedTagsKey: "", tagMode: "any", locatedIdsKey: "" };
    const commit = (previous: typeof original, current: typeof original, page: number, visiblePage: number) => {
        const writes: number[] = [];
        const ref = { current: { ...previous } };
        new Function("previousProfileFilters", "q", "group", "pageSize", "profileStatus", "selectedTagsKey", "tagMode", "locatedIdsKey", "profilePage", "visibleProfilePage", "setProfilePage", "useEffect", source)(
            ref, current.q, current.group, current.pageSize, current.profileStatus, current.selectedTagsKey, current.tagMode, current.locatedIdsKey, page, visiblePage,
            (next: number) => writes.push(next), (effect: () => void) => effect(),
        );
        expect(ref.current).toEqual(current);
        return writes;
    };
    // Starting at index 3, 30 search results have two pages: the clamp is index 1,
    // but a changed filter must reset to index 0 in this same commit.
    for (const changed of [{ q: "192.0.2.12" }, { group: "A" }, { pageSize: 50 }, { profileStatus: "running" }, { selectedTagsKey: "vip" }, { tagMode: "all" }, { locatedIdsKey: "p1\0p2" }]) {
        expect(commit(original, { ...original, ...changed }, 3, 1)).toEqual([0]);
    }
    expect(commit(original, original, 3, 1)).toEqual([1]);
    expect(commit(original, original, 1, 1)).toEqual([]);
});

test("the 20-row default preserves valid saved page sizes and survives unavailable storage", () => {
    const source = new Bun.Transpiler({ loader: "ts" }).transformSync(sourceBetween("export function readPageSize()", "/**\n * The number an operator sees", rosterQuerySource).replace("export function readPageSize", "function readPageSize"));
    const sizes = JSON.parse(rosterQuerySource.match(/export const PAGE_SIZES = (\[[^\]]+\]);/)![1]!);
    const key = rosterQuerySource.match(/export const PAGE_SIZE_KEY = "([^"]+)";/)![1]!;
    const read = (getItem: () => string | null) => new Function("localStorage", "PAGE_SIZES", "PROFILE_PAGE_SIZE", "PAGE_SIZE_KEY", `${source}\nreturn readPageSize();`)({ getItem }, sizes, defaultPageSize, key);
    expect(read(() => null)).toBe(20);
    expect(read(() => "50")).toBe(50);
    expect(read(() => "200")).toBe(200);
    expect(read(() => "0")).toBe(0);
    expect(read(() => "3")).toBe(20);
    expect(read(() => "invalid")).toBe(20);
    expect(read(() => { throw new Error("Storage unavailable"); })).toBe(20);
});
test("selection controls expose scope selection and clearing without changing export permissions", () => {
    expect(app).not.toContain("allVisibleSelected && !allFilteredSelected");
    expect(actionDockSource).toContain("disabled={deleting || allFilteredSelected}");
    expect(appShell).toContain("onSelectAllFiltered={() => { rangeSelectionAnchor.current = null; selectAllFiltered(); }}");
    expect(actionDockSource).toContain('aria-label={t("Clear selection")}');
    expect(actionDockSource).toContain("onClick={onClear}");
    expect(appShell).toContain("onClear={() => { rangeSelectionAnchor.current = null; setSelected(new Set()); }}");
    expect(app).toContain('q.trim() ? t("matching profiles") : t("profiles")');
    expect(app).toContain('t("{count} {kind} in “{group}”",');
    expect(app).toContain("const ids = [...selected];");
    expect(app).toContain("await exportProfiles(ids, format, (progress) => setExportProgress(progress));");
});
test("export shows live progress, blocks duplicate exports, and always clears busy state", async () => {
    const source = appShell
        .slice(appShell.indexOf("const exportSelected = async"), appShell.indexOf("// ---- File-based bulk update"))
        .replace("(format: ExportFormat)", "(format)"); // strip the one TS annotation for plain-JS evaluation
    expect(source).toContain("exportProfiles(ids, format, (progress) => setExportProgress(progress))");
    const makeExportSelected = new Function("selected", "exportProgress", "exportProfiles", "setExportOpen", "setActionErr", "setExportProgress", "flash", `${source}\nreturn (format) => exportSelected(format);`);
    const ids = new Set(["a", "b", "c"]);
    const progress: unknown[] = [];
    let opened = false;
    let err: string | null = "stale";
    const flashes: string[] = [];
    type ExportFn = (ids: string[], format: string, onProgress?: (p: {
        completed: number;
        total: number;
    }) => void) => Promise<void>;
    const run = (busy: unknown, impl: ExportFn): ((format: string) => Promise<void>) => makeExportSelected(ids, busy, impl, () => { opened = false; }, (e: string | null) => { err = e; }, (p: unknown) => { progress.push(p); }, (m: string) => { flashes.push(m); }) as (format: string) => Promise<void>;
    await run(null, async (_ids, _format, onProgress) => {
        onProgress?.({ completed: 3, total: 3 });
        await new Promise((resolve) => setTimeout(resolve, 1));
    })("txt");
    expect(progress).toEqual([{ completed: 0, total: 3 }, { completed: 3, total: 3 }, null]); // seeded → live → cleared
    expect(opened).toBe(false); // the format menu closes before the request starts
    expect(err).toBeNull(); // a stale action error is cleared, not left visible
    expect(flashes).toEqual(["Exported 3 profiles as TXT"]);
    progress.length = 0;
    let called = 0;
    await run({ completed: 0, total: 3 }, async () => { called++; })("txt"); // already exporting
    expect(called).toBe(0); // a second export never starts while one is in flight
    await run(null, async () => { throw new Error("Export interrupted"); })("txt");
    expect(progress.at(-1)).toBeNull(); // busy state clears on failure too
    expect(err).toBe("Error: Export interrupted");
    expect(flashes).toEqual(["Exported 3 profiles as TXT"]); // no success banner for the failure
});
test("export progress banner renders counts, the build phase, and disables competing actions", () => {
    expect(app).toContain('const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);');
    expect(app).toContain('exportProgress.completed >= exportProgress.total');
    expect(app).toContain('"Building export file…"');
    expect(app).toContain('t("Preparing export: {completed} / {total} profiles", { completed: exportProgress.completed.toLocaleString(), total: exportProgress.total.toLocaleString() })');
    expect(app).toContain('disabled={!selected.size || !!exportProgress}'); // export menu + file-update dialog
    expect(app).toContain("{exportOpen && selected.size > 0 && !exportProgress && (");
});
test("header controls stay reachable and dismissable", () => {
    expect(app).toContain("function useDismiss<T extends HTMLElement>(open: boolean, close: () => void)");
    expect(app).toContain('document.addEventListener("mousedown", onDown);');
    expect(app).toContain('if (event.key === "Escape") onClose.current();');
    expect(app).toContain('aria-label={t("Refresh profiles")}');
    expect(app).toContain('aria-label={t("Settings")} onClick={openSettings}');
    expect(app).toContain("onSettings={openSettings}");
    expect(sidebarMarkup()).toContain('<span class="navlabel">Settings</span>');
});
test("the dashboard typeface is bundled, never fetched at runtime", () => {
    // AliasMode is local-first and must render correctly with no network, so the
    // face ships with the app. A CDN @import or an https font URL is a regression.
    expect(styles).toContain('src: url("./fonts/inter-latin.woff2") format("woff2")');
    expect(styles).toContain('src: url("./fonts/inter-latin-ext.woff2") format("woff2")');
    expect(styles).not.toContain("fonts.googleapis.com");
    expect(styles).not.toContain("fonts.gstatic.com");
    expect(styles).not.toMatch(/@import\s+url\(/);
    for (const file of ["inter-latin.woff2", "inter-latin-ext.woff2"]) {
        const bytes = readFileSync(join(import.meta.dir, "web", "fonts", file));
        expect(bytes.length).toBeGreaterThan(1000);
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2"); // real woff2, not an error page
    }
    // One variable file per subset covers every weight the UI asks for.
    expect(styles).toContain("font-weight: 100 900;");
    expect(styles).toContain("font-display: swap;");
    // Splitting by unicode-range keeps a latin-only roster off the larger subset.
    expect(styles.match(/unicode-range:/g)?.length).toBe(2);
    // SIL OFL requires the license to travel with the font.
    const license = readFileSync(join(import.meta.dir, "web", "fonts", "Inter-LICENSE.txt"), "utf8");
    expect(license).toContain("SIL OPEN FONT LICENSE");
    expect(notice).toContain("Inter typeface");
});
test("New and Edit open accessible centred editors; management sections remain pages", () => {
    const views = app.match(/const \[view, setView\] = useState<([^>]+)>\("profiles"\)/)?.[1];
    expect(views).toBeDefined();
    expect([...views!.matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual(expect.arrayContaining([
        "profiles", "scripts", "settings", "extensions", "proxies", "trash", "workspaces", "assistant",
    ]));
    expect(app).toContain("const [showCreate, setShowCreate] = useState(false);");
    expect(app).toContain('aria-labelledby="create-profile-title"');
    expect(app).toContain('aria-labelledby="edit-profile-title"');
    const create = createModalSource.slice(createModalSource.indexOf("<MotionPresence present={showCreate}>"));
    const edit = editModalSource.slice(editModalSource.indexOf("<MotionPresence present={!!editId}>"));
    for (const editor of [create, edit]) {
        expect(editor).toContain('className="modal-backdrop profile-editor-backdrop"');
        expect(editor).toContain('className="modal profile-editor"');
        expect(editor).toContain('role="dialog"');
        expect(editor).toContain('aria-modal="true"');
    }
    expect(styles).toMatch(/\.profile-editor-backdrop\s*\{[^}]*justify-content:\s*center[^}]*align-items:\s*center/);
    expect(styles).toMatch(/\.modal\.profile-editor\s*\{[^}]*max-height:\s*calc\(100dvh - 64px\)/);
    const closeCreate = sourceBetween("const finishCloseCreate =", "const closeCreate =", createModalSource);
    expect(closeCreate.indexOf("if (createInFlight.current) return;")).toBeLessThan(closeCreate.indexOf("cancelReuseRead();"));
    expect(closeCreate.indexOf("cancelReuseRead();")).toBeLessThan(closeCreate.indexOf("setShowCreate(false);"));
    expect(closeCreate).toContain("resetCreateProxyCheck();");
    expect(closeCreate).toContain("setCreateReuseSource(null);");
    expect(closeCreate).toContain("setForm(BLANK_FORM);");
    const closeDraft = new Function("busy", `
      const calls = [], createInFlight = { current: busy }, BLANK_FORM = { name: "" };
      const cancelReuseRead = () => calls.push(["cancelReuse"]), resetCreateProxyCheck = () => calls.push(["resetProxyCheck"]);
      const setShowCreate = value => calls.push(["showCreate", value]), setCreateProxySource = value => calls.push(["proxySource", value]), setCreateReuseSource = value => calls.push(["reuseSource", value]);
      const setForm = value => calls.push(["form", value]), setProxyPaste = value => calls.push(["proxyPaste", value]), setProxyPasteOk = value => calls.push(["proxyPasteOk", value]), setCreateErr = value => calls.push(["error", value]);
      const setProxyPasteInvalid = value => calls.push(["proxyPasteInvalid", value]);
      ${closeCreate}\n finishCloseCreate(); return calls;
    `);
    expect(closeDraft(true)).toEqual([]);
    expect(closeDraft(false)).toEqual([["cancelReuse"], ["resetProxyCheck"], ["showCreate", false], ["proxySource", null], ["reuseSource", null], ["form", { name: "" }], ["proxyPaste", ""], ["proxyPasteOk", null], ["proxyPasteInvalid", false], ["error", null]]);
    expect(app).toContain("PAGE_TITLES[view]");
    // The real request timing, failed-detail recovery and save guards are
    // exercised by web/app-edit.test.ts against the mounted App.
});
test("a running row with saved proxy or fingerprint changes offers a restart", () => {
    expect(app).toContain("{p.restartPending && (");
    expect(app).toContain('{t("Applies at next start")}');
    expect(app).toContain("onClick={() => act(p.id, restartProfile)}");
    expect(app).toContain("if (r.restartRequired) onFlash(");
    // The restart is the status chip on its own line in the name cell, so the row actions keep their width.
    expect(app).toContain('className="status-chip warn tip"');
    expect(app).not.toContain('{t("Restart now")}');
});
test("pending cookies of a closed profile can be seen (domain and name) and removed", () => {
    expect(app).toContain("onClick={() => void openPendingCookies(p)}");
    expect(app).toContain("await fetchPendingCookies(profile.id, request.signal)");
    expect(app).toContain("await clearPendingCookies(pendingView.profile.id)");
    expect(app).toContain('<th scope="col">{t("Domain")}</th><th scope="col">{t("Cookie name")}</th>');
    expect(app).toContain('<tr key={index}><td><bdi>{cookie.domain}</bdi></td><td><bdi>{cookie.name}</bdi></td></tr>');
    expect(app).toContain('{t("Remove pending cookies")}');
});
test("the sidebar collapses to an icon rail and remembers it", () => {
    expect(app).toContain('const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";');
    expect(app).toContain("function readSidebarCollapsed(): boolean {");
    expect(app).toContain('writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1")');
    expect(app).toContain('<WorkbenchSidebar compact={sidebarIsCompact} collapsed={sidebarCollapsed} forced={railForced}');
    expect(app).toContain('onToggle={toggleSidebar}');
    const expanded = sidebarMarkup(), compact = sidebarMarkup({ compact: true, collapsed: true });
    expect(expanded).toContain('aria-label="Collapse sidebar"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(compact).toContain('class="sidebar collapsed"');
    expect(compact).toContain('aria-label="Expand sidebar"');
    expect(compact).toContain('aria-expanded="false"');
    // Labels must be elements, not bare text, or they cannot be hidden on the rail.
    expect(compact).toContain('<span class="navlabel">All profiles</span>');
    expect(app).toContain('import "./workbench-layout.css";');
    expect(styles).toContain(".sidebar.collapsed");
    expect(styles).toContain(".rail-toggle");
    // Every rail item needs a hover label once its text is gone.
    expect(compact).toContain('data-tip="All profiles"');
    expect(compact).toContain('data-tip="Settings"');
});
test("short sidebars keep folder space and let navigation scroll without clipping rail tooltips", () => {
    const navigation = baseStyles.match(/\n\.sidenav \{([^}]+)\}/)?.[1] ?? "";
    expect(navigation).toContain("min-height: 0");
    const shellNavigation = workbenchStyles.match(/\.folded-workbench \.sidenav \{([^}]+)\}/)?.[1] ?? "";
    expect(shellNavigation).toContain("overflow: visible");
    const collections = rosterNavigationStyles.match(/^\.roster-navigation \{([^}]+)\}/)?.[1] ?? "";
    expect(collections).toContain("min-height: 0");
    expect(collections).toContain("flex: 1 1 auto");
    expect(collections).toContain("overflow: auto");
    expect(rosterNavigationStyles).toContain(".roster-navigation.is-compact { overflow: visible;");
    expect(rosterNavigationStyles).toMatch(/\.roster-navigation\.is-compact \.roster-navigation-panel\s*\{[^}]*position:\s*fixed[^}]*max-height:\s*calc\(100dvh - 140px\)[^}]*overflow-y:\s*auto/);
    const compact = workbenchStyles.slice(workbenchStyles.indexOf("@media (max-height: 580px)"), workbenchStyles.indexOf("@media (pointer: coarse)"));
    expect(styles).not.toContain(".sidecredit");
    expect(compact).toContain(".folded-workbench > .sidebar { overflow-y: auto; overflow-x: hidden; }");
    expect(compact).toMatch(/\.sidebar\.collapsed \.navitem\[data-tip\]::after\s*\{[^}]*position:\s*fixed/);
    expect(compact).not.toMatch(/\.sidefoot\s*\{[^}]*display:\s*none/);
});
test("roster columns declare their own width and never collapse", () => {
    // One registry drives the header cells and the table's min-width, so a column
    // cannot be squeezed below a readable size.
    const columns = rosterColumns();
    expect(new Set(columns.map(column => column.key)).size).toBe(columns.length);
    expect(columns.every(column => column.width > 0 && column.label)).toBe(true);
    expect(Number(app.match(/const CHECKBOX_COLUMN_WIDTH = (\d+);/)?.[1])).toBeGreaterThan(0);
    expect(app).toContain("const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);");
    expect(app).toContain('style={{ minWidth: tableMinWidth }}');
    // Every column declares a width, so a wide window's extra space spreads
    // proportionally across all of them — no single column hoards it.
    expect(app).toContain("const style = { width: column.width } as CSSProperties;");
    expect(app).toContain('const label = t(column.label);');
    // Widths live in the registry only — a stray CSS width would silently win.
    expect(styles).not.toMatch(/th\.col-\w+, td\.col-\w+ \{ width:/);
    expect(styles).toContain("table-layout: fixed");
    expect(styles).toContain(".tablewrap { flex: 1; min-height: 0; overflow: auto; }");
});
test("the roster keeps only the columns that matter and stays compact", () => {
    // Health, Created and Last opened were removed on request; what is left is
    // identity, grouping, connectivity — and the one button every row needs.
    for (const key of ["health", "created", "opened"]) {
        expect(app).not.toContain(`key: "${key}"`);
    }
    const columns = rosterColumns();
    expect(columns.find(column => column.key === "status")).toMatchObject({ label: "Status" });
    expect(columns.find(column => column.key === "action")).toMatchObject({ label: "Action", sort: false });
    expect(columns.filter(column => !["platform", "tags"].includes(column.key)).map(column => column.key)).toEqual(["no", "name", "group", "proxy", "status", "action"]);
    expect(app).toContain('className="col-status"');
    expect(app).toContain('{p.running ? t("Running") : t("Stopped")}');
    expect(app).not.toContain("healthFilter");
});
test("rows expose start or stop directly and keep secondary actions in an accessible click menu", () => {
    const row = sourceBetween('{columnVisible("action") && (', "</ProfileActionMenu>");
    expect(row).toMatch(/aria-label=\{t\([^\n]*"Start \{profile\}", \{ profile: p\.name \}\)\}/);
    expect(row).toContain('aria-label={t("Stop {profile}", { profile: p.name })}');
    expect(row).toContain("act(p.id, openProfile)");
    expect(row).toContain("act(p.id, closeProfile)");
    expect(row).toContain('<ProfileActionMenu label={t("Actions for {profile}", { profile: p.name })}');
    for (const action of ["openEdit(p.id)", "openCookie([p])", "copy2fa(p.id)", "act(p.id, raiseProfile)"]) expect(row).toContain(action);
    expect(row).toContain('{p.has2fa && <button role="menuitem"');
    expect(row).toContain('p.running && p.engine === "chromium" && <button role="menuitem"');
    const html = renderToStaticMarkup(createElement(ProfileActionMenu, {
        label: "Actions for QA", icon: null, children: createElement("button", { role: "menuitem" }, "Edit"),
    }));
    expect(html).toContain('aria-label="Actions for QA"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    // Portal placement prevents table clipping; keyboard users can open, traverse and dismiss it.
    expect(actionMenu).toContain("createPortal(");
    expect(actionMenu).toContain("document.body)");
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"]) expect(actionMenu).toContain(`"${key}"`);
    expect(actionMenu).toContain("trigger.current?.focus({ preventScroll: true })");
    expect(actionMenu).toContain('document.removeEventListener("pointerdown", dismiss)');
    expect(app).not.toContain("rowquick");
    expect(styles).not.toContain(".rowquick");
});
test("the Action column stays reachable while the roster scrolls sideways", () => {
    expect(styles).toContain("position: sticky; right: 0;");
    // A sticky cell has no row behind it, so every row state repaints its own opaque fill.
    expect(styles).toContain(".profile-table tbody tr.selected td.col-action { background: var(--table-row-selected); }");
    expect(styles).toContain(".profile-table tbody tr.selected:hover td.col-action { background: var(--table-row-selected-hover); }");
    expect(styles).toContain(".profile-table thead th.col-action { z-index: 3; background: var(--surface-sunken); }");
    // Hover labels must paint above the next row's sticky Action cell.
    expect(styles).toContain(".profile-table tbody tr:hover td.col-action { background: var(--table-row-hover); z-index: 2; }");
    // The edge shadow only appears once there is content underneath it.
    expect(app).toContain("onTableScrolledChange(event.currentTarget.scrollLeft > 0)");
    expect(styles).toContain(".tablewrap.scrolled td.col-action::before");
});
test("small windows keep navigation and dialogs keep typed input", () => {
    // Below the rail breakpoint the sidebar becomes the icon rail instead of
    // disappearing — a resizable desktop app must never lose its navigation.
    expect(app).toContain('const RAIL_MEDIA = "(max-width: 760px)";');
    expect(app).toContain("sidebarCollapsed || railForced");
    expect(styles).not.toContain(".sidebar { display: none; }");
    // Long sheets scroll their body while their close/save controls stay reachable.
    expect(styles).toMatch(/\.modal-body\s*\{[^}]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.modal-foot\s*\{[^}]*flex:\s*0 0 auto/);
    // Escape closes the open dialog; a stray backdrop click never discards a form.
    expect(app).toContain('if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;');
    expect(app).not.toContain('className="modal-backdrop" onClick={closeCreate}');
    expect(app).not.toContain('className="modal-backdrop" onClick={closeEdit}');
    expect(app).not.toContain('className="modal-backdrop" onClick={closeBulk}');
});
test("import offers one source at a time and counts what was pasted", () => {
    // Two full-height inputs stacked left it ambiguous which one Import would read.
    expect(app).toContain('const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");');
    expect(app).toContain('aria-label={t("Import source")}');
    expect(app).toContain('aria-pressed={bulkSource === "file"}');
    expect(app).toContain('aria-pressed={bulkSource === "paste"}');
    // Every AdsPower record opens with its own id= line, so this count is exact.
    expect(app).toContain("export function countPastedRecords(text: string): number {");
    expect(app).toContain('return (text.match(/^id=/gm) ?? []).length;');
    expect(app).toContain('t("1 record detected")');
    expect(app).toContain('t("{count} records detected", { count: pastedRecordCount })');
    // Chosen files are individually removable rather than a comma-joined string.
    expect(app).toContain('<ul className="filelist">');
    expect(app).toContain('aria-label={t("Remove file {name}", { name: file.name })}');
    expect(app).toContain(">{t(\"Clear all\")}</button>");
    expect(styles).toContain(".segmented");
});
test("no legacy arrow glyphs survive in place of icons", () => {
    // These predate the icon set; a stray one means a control was missed.
    for (const glyph of ["⤓", "⤒", "↩", "🧩", "📄", "▸", "▾"]) {
        expect(app).not.toContain(glyph);
    }
});
test("Extensions is a page, consistent with the rest of the shell", () => {
    // It was the last modal among pages, and opening it from Settings stacked a
    // dialog over a page.
    expect(app).toContain('setView("extensions")');
    expect(app).not.toContain("showExts");
    expect(app).toContain('view === "extensions" ? (');
    expect(app).toContain("onExtensions={openExtensions}");
    expect(sidebarMarkup({ view: "extensions" })).toMatch(/<button[^>]*aria-current="page"[^>]*aria-label="Manage extensions"/);
    expect(app).toContain('extensions: "Extensions",');
});
test("the dark theme is a token swap, and native controls follow it", () => {
    expect(styles).toContain(':root[data-theme="dark"] {');
    // Without color-scheme the browser keeps painting checkboxes and scrollbars light.
    expect(styles).toContain("color-scheme: dark;");
    expect(styles).toContain("color-scheme: light;");
    // Nothing may hardcode a light surface, or it survives into the dark theme —
    // this is exactly how the modal header stayed white.
    const rules = styles.slice(styles.indexOf("\n}", styles.indexOf(":root {")));
    expect(rules).not.toContain("linear-gradient(180deg, #ffffff");
    expect(rules).not.toMatch(/background: #fff/);
    // Two near-black brand tiles would vanish on a dark row.
    expect(styles).toContain(':root[data-theme="dark"] .platform-pill .glyph.pm-x');
    // Light is the out-of-the-box default; Dark and follow-the-OS System are
    // opt-in from Settings. A host-only cookie survives the desktop app's changing port.
    expect(app).toContain('from "./theme.ts";');
    expect(app).toContain("return readThemeChoice(cookies, stored);");
    expect(app).toContain("document.cookie = themeCookie(choice);");
    // The app resolves "system" itself rather than duplicating the palette.
    expect(app).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(app).toContain("document.documentElement.dataset.theme =");
    expect(app).toContain('media.addEventListener("change", apply)');
});
test("sidebar keeps local extension management without original-author support links", () => {
    expect(sidebarMarkup()).toContain('<span class="navlabel">Manage extensions</span>');
    expect(app).not.toContain('href="https://aliasmode.com/support/"');
    expect(app).not.toContain("PROJECT_LINKS");
    expect(app).toContain("fetchExtensions()");
});
test("file editing keeps export and template entry points and explains original-ID matching", () => {
    expect(app).toContain('<ProfileFileUpdateDialog open={showUpdate} task={fileUpdate.task}');
    expect(app).toContain('onExport={exportSelected} onDownloadTemplate=');
    expect(fileUpdateUi).toContain('File IDs control the update. List selections are ignored and unmatched IDs are skipped.');
    expect(fileUpdateUi).toContain('locale and custom_no.');
    expect(fileUpdateUi).toContain('<ProfileFileUpdatePanel snapshot={snapshot}');
});
test("the existing Extensions page installs from a Web Store URL and keeps archive upload", () => {
    expect(extensionPage).toContain("Chrome Web Store");
    expect(extensionPage).toContain('aria-label={t("Chrome Web Store URL or extension ID")}');
    expect(app).toContain("installWebStoreExtension(source)");
    expect(extensionPage).toContain("How extensions are applied");
    expect(extensionPage).toContain("Choose group defaults here, or edit a single environment's extensions.");
    expect(extensionPage).toContain("Choose ZIP/CRX files");
    expect(extensionPage).toContain('accept=".zip,.crx,application/zip,application/x-chrome-extension"');
    expect(app).not.toContain("Chrome Web Store installs are not supported in AliasMode");
    expect(app.match(/setView\("extensions"\)/g)).toHaveLength(1);
});
test("Firefox shows its screen, editable at creation and when editing", () => {
    const settings = formHelpersSource.slice(formHelpersSource.indexOf("export function FingerprintSettings("), formHelpersSource.indexOf("export function FingerprintSettings(") + 4200);
    expect(settings).not.toMatch(/\{engine === "chromium" && \(\s*<label className="fld">\s*<span>Screen/);
    expect(settings).toContain("onChange={(event) => onScreenChange(event.target.value)}");
    expect(app).not.toContain("screenReadOnly");
    expect(app).toContain("screen: form.screen,");
    expect(app).toContain("allowAutomaticScreen={false}");
    expect(settings).toContain('t("Required · e.g. 1920x1080")');
    expect(app).toContain('t("Leave timezone or CPU blank for automatic settings. Screen size and fingerprint seed need explicit values; a blank language keeps the saved language. A timezone you type stays when the proxy changes.")');
});


test("actual roster quick views combine favorites with group/status/search and order recent launches", () => {
  const now = Date.now();
  const profiles = [
    { id: "a", name: "Research A", group: "Work", running: true, lastOpenAt: now - 20_000 },
    { id: "b", name: "Research B", group: "Work", running: false, lastOpenAt: now - 1_000 },
    { id: "c", name: "Other", group: "Home", running: true, lastOpenAt: 0 },
  ];
  expect(rosterPipeline(profiles, { quickScope: "favorites", favorites: ["a", "b"], group: "Work", q: "Research", status: "running" }).filtered.map(profile => profile.id)).toEqual(["a"]);
  expect(rosterPipeline(profiles, { quickScope: "recent" }).filtered.map(profile => profile.id)).toEqual(["b", "a"]);
});
