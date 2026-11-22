import { test, expect } from "bun:test";
import { availableLanguages, detectLanguage, languageNativeName, translate } from "./i18n.tsx";
import enUS from "./locales/en-US.json";
import ruRU from "./locales/ru-RU.json";
import zhCN from "./locales/zh-CN.json";

const tables = {
  "en-US": enUS as Record<string, string>,
  "ru-RU": ruRU as Record<string, string>,
  "zh-CN": zhCN as Record<string, string>,
};

// Keys are the English source strings, so en-US only carries the keys whose
// value differs from the key. Every translated key must still exist in the UI
// source (including local service errors shown by t(error)), or it is dead.
test("every zh-CN key is an English string used by the UI or its local service errors", async () => {
  const sources = await Promise.all(
    ["app.tsx", "proxies.tsx", "scripts.tsx", "trash.tsx", "workspace-manager.tsx", "workspaces-api.ts", "window-chrome.tsx", "settings-center.tsx", "settings-api.ts", "runtime-download-progress.tsx", "browser-runtime-settings.tsx", "proxy-resources.tsx", "proxy-check-presentation.ts", "fingerprint-import-badge.tsx", "../fingerprint-import-comparison.ts", "profile-templates.tsx", "profile-templates-api.ts", "command-palette.tsx", "signed-updates.tsx", "signed-update-api.ts", "local-assistant.tsx", "local-assistant-api.ts", "fingerprint-assistant-brief.ts", "local-proxy-preflight-settings.tsx", "external-links.ts", "../local-assistant.ts", "../profile-templates.ts", "../profile-template-routes.ts", "../app-settings.ts", "../app-updates.ts", "../encrypted-sync.ts", "../feature-settings.ts", "../network-diagnostics.ts", "../fingerprint-review.ts", "../fingerprint-quality.ts", "../fingerprint-check-presentation.ts", "../agent/integration-info.ts", "../launcher.ts", "../src-tauri/src/signed_updates.rs", "../src-tauri/src/shutdown.rs"]
      .map((file) => Bun.file(new URL(`./${file}`, import.meta.url)).text()),
  );
  const pageSources = await Promise.all(["extensions-page.tsx", "environment-inspection.tsx", "roster-views.tsx", "profile-edit-patch.ts", "edit-changes-summary.tsx", "profile-move.tsx", "profile-move-controller.ts", "profile-search.ts", "roster-density.tsx", "../roster-density-state.ts", "import-receipt.tsx", "import-receipt-data.ts", "profile-tags.tsx", "../profile-tags.ts", "desktop-motion.tsx", "proxy-workflow.ts", "proxy-problem-summary.ts", "profile-reuse-api.ts", "bulk-profile-task.ts", "bulk-profile-task-panel.tsx", "workbench-shortcuts.ts", "shortcut-help.tsx", "workspace-operations.tsx", "background-script-run.tsx", "background-script-run-state.ts", "../profile-view-state.ts", "api.ts"].map(file => Bun.file(new URL(`./${file}`, import.meta.url)).text()));
  const cookieSources = await Promise.all(["cookie-import-task.ts", "cookie-import-task-panel.tsx", "profile-file-update.ts", "profile-file-update-panel.tsx", "unsaved-changes-guard.tsx", "workbench-activity.tsx", "trash-task.ts", "chromium-preloading-settings.tsx", "chromium-memory-saver-settings.tsx", "../chromium-preloading-preferences.ts", "desktop-close.tsx", "desktop-close-state.ts", "../extension-group-revision.ts", "profile-editor-status.tsx", "local-proxy-assignment-draft.tsx", "../proxy-single-preview.ts", "signed-update-draft-dialog.tsx", "mcp-connection-probe.tsx"].map(file => Bun.file(new URL(`./${file}`, import.meta.url)).text()));
  const modelSources = await Promise.all(["about-popover.tsx", "model-services.tsx", "assistant-api-sidebar.tsx", "assistant-services-api.ts", "../assistant-model-services.ts", "../remote-assistant.ts", "editor-window-controls.tsx", "error-boundary.tsx", "ui-primitives.tsx", "features/copy-field.tsx", "features/log-modal.tsx", "features/move-folder-modal.tsx", "features/settings-panel.tsx", "hooks/use-profile-selection.ts", "hooks/use-roster-polling.ts"].map(file => Bun.file(new URL(`./${file}`, import.meta.url)).text()));
  const layoutSources = await Promise.all(["features/workbench-sidebar.tsx", "features/roster-navigation.tsx", "features/profile-details.tsx", "features/profile-editor-layout.tsx", "features/profile-form-helpers.tsx", "features/profile-roster-row.tsx", "features/profile-roster-table.tsx", "features/profile-create-modal.tsx", "features/profile-edit-modal.tsx", "features/profile-import-modal.tsx", "components/action-dock.tsx", "components/toast-stack.tsx", "components/roster-skeleton.tsx", "hooks/use-roster-events.ts", "hooks/use-roster-query.ts", "hooks/use-virtual-list.ts", "hooks/use-flip-group.ts", "proxy-vault-api.ts", "proxy-vault-panel.tsx", "window-control-api.ts", "window-sync-panel.tsx", "resource-monitor-api.ts", "resource-dashboard.tsx", "data-saver-settings.tsx"].map(file => Bun.file(new URL(`./${file}`, import.meta.url)).text()));
  const source = [...sources, ...pageSources, ...cookieSources, ...modelSources, ...layoutSources].join("\n").replaceAll("\r\n", "\n");
  const settingsSource = await Bun.file(new URL("../app-settings.ts", import.meta.url)).text();
  const settingsErrors = new Set<string>();
  if (settingsSource.includes('${name} must be an object')) {
    for (const [, name] of settingsSource.matchAll(/\bobject\([^,\n]+, "([^"]+)"\)/g)) settingsErrors.add(`${name} must be an object`);
  }
  if (settingsSource.includes('Unknown ${name} setting')) {
    for (const [, name] of settingsSource.matchAll(/\bkeys\([^,\n]+, \[[^\]\n]*\], "([^"]+)"\)/g)) settingsErrors.add(`Unknown ${name} setting`);
  }
  const stale = Object.keys(tables["zh-CN"]).filter((key) => !key.startsWith("language.") && !source.includes(key) && !settingsErrors.has(key));
  expect(stale).toEqual([]);
});

test("t() returns the translation for the active language", () => {
  expect(translate(tables, "zh-CN", "Appearance")).toBe(tables["zh-CN"]!["Appearance"]!);
  expect(translate(tables, "en-US", "Appearance")).toBe("Appearance");
});

test("t() falls back to English for missing keys", () => {
  const partial = {
    "en-US": { hello: "Hello" },
    "xx-YY": {} as Record<string, string>,
  };
  // Missing in xx-YY → English catalog value.
  expect(translate(partial, "xx-YY", "hello")).toBe("Hello");
  // Missing everywhere → the key itself.
  expect(translate(partial, "xx-YY", "unknown.key")).toBe("unknown.key");
  // Unknown language → English catalog.
  expect(translate(partial, "zz-ZZ", "hello")).toBe("Hello");
});

test("t() interpolates {name} and {{name}} placeholders", () => {
  const partial = { "en-US": { greeting: "Hello {name}", formal: "Hi {{name}}" } };
  expect(translate(partial, "en-US", "greeting", { name: "Ada" })).toBe("Hello Ada");
  expect(translate(partial, "en-US", "formal", { name: "Ada" })).toBe("Hi Ada");
  expect(translate(partial, "en-US", "greeting")).toBe("Hello {name}");
});

test("availableLanguages lists bundled locales with native names", () => {
  expect(availableLanguages()).toContain("en-US");
  expect(availableLanguages()).toContain("zh-CN");
  expect(languageNativeName("en-US")).toBe("English");
  expect(languageNativeName("zh-CN")).toBe("简体中文");
  expect(languageNativeName("xx-YY")).toBe("xx-YY");
});

test("ru-RU keeps full key and placeholder parity with zh-CN", () => {
  const zhKeys = Object.keys(tables["zh-CN"]);
  const ruKeys = Object.keys(tables["ru-RU"]);
  const missing = zhKeys.filter((key) => !(key in tables["ru-RU"]));
  const extra = ruKeys.filter((key) => !(key in tables["zh-CN"]));
  expect(missing).toEqual([]);
  expect(extra).toEqual([]);

  const placeholders = (text: string) => [...text.matchAll(/\{\{?[a-zA-Z0-9_]+\}?\}/g)].map((m) => m[0]).sort();
  for (const key of zhKeys) {
    const ruValue = tables["ru-RU"]![key]!;
    expect(ruValue.trim().length).toBeGreaterThan(0);
    if (!key.startsWith("language.")) {
      expect(placeholders(ruValue)).toEqual(placeholders(key));
    }
  }
});

test("detectLanguage matches the system language exactly, then by primary tag", () => {
  const known = ["en-US", "zh-CN", "ru-RU"];
  expect(detectLanguage(["zh-CN", "en"], known)).toBe("zh-CN");
  expect(detectLanguage(["zh-Hans-CN", "en-GB"], known)).toBe("zh-CN");
  expect(detectLanguage(["ru"], known)).toBe("ru-RU");
  expect(detectLanguage(["en-GB", "zh"], known)).toBe("en-US");
  expect(detectLanguage(["fr-FR", "de"], known)).toBeNull();
  expect(detectLanguage([], known)).toBeNull();
});
