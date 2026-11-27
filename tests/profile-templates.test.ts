import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { buildNewProfile, defaultProfileEngine } from "../src/create.ts";
import { defaultChromiumRuntime } from "../src/aliasmode-chromium.ts";
import { deterministicSeed } from "../src/fingerprint.ts";
import { FIREFOX_RUNTIME_VERSION, firefoxLaunchConfig } from "../src/firefox-config.ts";
import { applyProfileTemplate, captureProfileTemplateSettings, emptyProfileTemplateCatalog, isProfileTemplateId, parseProfileTemplateCatalog, parseProfileTemplateSettings, previewProfileTemplate, PROFILE_TEMPLATE_LIMITS, ProfileTemplateError, ProfileTemplateStore, type ProfileTemplate, type ProfileTemplateErrorCode, type ProfileTemplateSettings } from "../src/profile-templates.ts";

const parent = resolve(import.meta.dir, "..", "node_modules/.cache/profile-template-tests"), roots: string[] = [], links: string[] = [];
afterEach(() => {
  for (const path of links.splice(0)) try { unlinkSync(path); } catch {}
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(parent + sep) || !basename(root).startsWith("templates-")) throw new Error("Unsafe template test cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
const settings: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "windows", screen: "1920x1080", platform: "x.com" };
const automatic: ProfileTemplateSettings = { engine: "chromium", chromiumRuntime: "", platformOs: "", screen: "", platform: "" };
function fixture() { mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "templates-")); roots.push(root); const path = join(root, "profile-templates.json"); return { root, path, store: new ProfileTemplateStore(path, () => Date.parse("2026-11-09T00:00:00.000Z")) }; }
function template(overrides: Partial<ProfileTemplate> = {}): ProfileTemplate { return { id: `tpl_${"a".repeat(32)}`, name: "日常桌面", settings: structuredClone(settings), createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", ...overrides }; }
function errorCode(operation: () => unknown, code: ProfileTemplateErrorCode) {
  try { operation(); throw new Error("Expected template failure"); } catch (error) { expect(error).toBeInstanceOf(ProfileTemplateError); expect((error as ProfileTemplateError).code).toBe(code); expect((error as Error).message).not.toContain("secret-marker"); }
}

test("template settings preserve automatic policy and both explicit Chromium runtime choices", () => {
  expect(parseProfileTemplateSettings(automatic)).toEqual(automatic);
  expect(parseProfileTemplateSettings({ ...settings, screen: " 1440 * 900 ", platform: "X.COM" })).toEqual({ ...settings, screen: "1440x900", platform: "x.com" });
  for (const runtime of ["aliasmode", "cloakbrowser"] as const) expect(parseProfileTemplateSettings({ ...settings, chromiumRuntime: runtime }).chromiumRuntime).toBe(runtime);
  expect(parseProfileTemplateSettings({ ...automatic, engine: "firefox" }).engine).toBe("firefox");
  errorCode(() => parseProfileTemplateSettings({ ...settings, engine: "firefox" }), "invalid-input");
});

test("template persistence schema rejects secrets, identity material, missing fields and unsupported values", () => {
  for (const field of ["password", "username", "cookies", "sessionBundle", "proxy", "group", "customNo", "id", "fingerprintSeed", "ua", "firefox", "extensions", "fpObserved", "controlUrl"]) errorCode(() => parseProfileTemplateSettings({ ...settings, [field]: "secret-marker" }), "invalid-input");
  for (const value of [null, [], {}, { ...settings, screen: null }, { ...settings, engine: "webkit" }, { ...settings, platformOs: "android" }, { ...settings, chromiumRuntime: "remote" }, { ...settings, screen: "999999x1" }]) errorCode(() => parseProfileTemplateSettings(value), "invalid-input");
});

test("platform values contain a domain only and cannot smuggle URL credentials or local control locations", () => {
  for (const platform of ["https://x.com", "user:secret-marker@x.com", "x.com/path", "x.com:9222", "x.com?token=secret-marker", "x.com#secret-marker", "127.0.0.1", "localhost", "server.local", "browser.localhost", "x.com\nsecret-marker", "-broken.com", ".x.com"]) errorCode(() => parseProfileTemplateSettings({ ...settings, platform }), "invalid-input");
  expect(parseProfileTemplateSettings({ ...settings, platform: "help.example.com" }).platform).toBe("help.example.com");
});

test("capturing a draft reads only safe settings without touching any secret getter", () => {
  const draft = { engine: "chromium" as const, chromiumRuntime: "cloakbrowser", platformOs: "windows", screen: "1440x900", platform: "x.com" };
  for (const key of ["name", "group", "username", "password", "proxy", "cookies", "twofa", "email", "sessionBundle", "fingerprintSeed"]) Object.defineProperty(draft, key, { enumerable: true, get: () => { throw new Error("secret-marker getter was read"); } });
  expect(captureProfileTemplateSettings(draft)).toEqual({ ...settings, chromiumRuntime: "cloakbrowser", screen: "1440x900" });
  expect(captureProfileTemplateSettings({}).engine).toBe(defaultProfileEngine());
  errorCode(() => captureProfileTemplateSettings(null as any), "invalid-input");
});

test("applying a template preserves the operator's unrelated draft and previews safe differences only", () => {
  const draft = { name: "My draft", group: "My folder", customNo: "42", username: "my-user", password: "secret-marker", twofa: "secret-marker", proxy: { host: "proxy.local", port: "8000", user: "user", pass: "secret-marker" } };
  const original = structuredClone(draft), target = template();
  const applied = applyProfileTemplate(draft, target);
  expect(draft).toEqual(original); expect(target.settings).toEqual(settings);
  expect(applied).toMatchObject({ ...draft, ...settings });
  const preview = previewProfileTemplate(target, automatic);
  expect(preview).toEqual({ templateId: target.id, freshIdentity: true, changes: [
    { field: "chromiumRuntime", before: "", after: "aliasmode" }, { field: "platformOs", before: "", after: "windows" },
    { field: "screen", before: "", after: "1920x1080" }, { field: "platform", before: "", after: "x.com" },
  ] });
  expect(JSON.stringify(preview)).not.toContain("secret-marker"); expect(previewProfileTemplate(target, settings).changes).toEqual([]);
  expect(applyProfileTemplate(draft, template({ settings: automatic }))).toMatchObject({ chromiumRuntime: undefined, platformOs: undefined, screen: "" });
});

test("templates create fresh identities through the existing Chromium and Firefox builders", () => {
  const firefoxPreset: ProfileTemplateSettings = { ...automatic, engine: "firefox", platformOs: "windows", screen: "1440x900" };
  const idBytes = (value: number) => <T>(bytes: T): T => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw new Error("Expected profile ID bytes");
    bytes.fill(value);
    return bytes;
  };
  for (const preset of [settings, firefoxPreset]) {
    const value = template({ settings: preset });
    const used = new Set<string>();
    const random = spyOn(crypto, "getRandomValues").mockImplementationOnce(idBytes(1));
    let first: ReturnType<typeof buildNewProfile>;
    let second: ReturnType<typeof buildNewProfile>;
    try {
      first = buildNewProfile(applyProfileTemplate({ name: "first" }, value), id => used.has(id));
      used.add(first.id);
      // Exercise the retry when the next ID is already taken.
      random.mockImplementationOnce(idBytes(1)).mockImplementationOnce(idBytes(2));
      second = buildNewProfile(applyProfileTemplate({ name: "second" }, value), id => used.has(id));
    } finally { random.mockRestore(); }

    expect(first.id).toBe("11111111");
    expect(second.id).toBe("22222222");
    expect(second.fingerprintSeed).not.toBe(first.fingerprintSeed);
    for (const profile of [first, second]) {
      expect(profile.fingerprintSeed).toBe(deterministicSeed(profile.id));
      expect(profile.engine).toBe(preset.engine);
      expect([profile.screenWidth, profile.screenHeight]).toEqual(preset.screen.split("x").map(Number));
      expect(profile.cookies).toEqual([]);
      expect(profile.password).toBe("");
      expect(profile.proxy).toBeNull();
      expect(profile.seeded).toBe(false);
      if (preset.engine === "firefox") {
        expect(profile.firefox).toMatchObject({ version: 1, runtimeVersion: FIREFOX_RUNTIME_VERSION, config: {
          "navigator.platform": "Win32", "screen.width": 1440, "screen.height": 900,
        } });
      }
    }
    if (preset.engine === "firefox") {
      // Saved persona samples may coincide. The launch derives canvas and text
      // seeds from the profile's own identity.
      const firstLaunch = firefoxLaunchConfig(first);
      const secondLaunch = firefoxLaunchConfig(second);
      for (const key of ["aliasmode:canvasSeed", "aliasmode:textSeed"]) {
        expect(firstLaunch[key]).toBe(deterministicSeed(`${first.fingerprintSeed}:${key}`));
        expect(secondLaunch[key]).toBe(deterministicSeed(`${second.fingerprintSeed}:${key}`));
        expect(secondLaunch[key]).not.toBe(firstLaunch[key]);
      }
    }
  }
  const auto = buildNewProfile(applyProfileTemplate({}, template({ settings: automatic })), () => false);
  expect(auto.chromiumRuntime).toBe(defaultChromiumRuntime());
  expect(buildNewProfile(applyProfileTemplate({}, template({ settings: { ...settings, chromiumRuntime: "cloakbrowser" } })), () => false).chromiumRuntime).toBeUndefined();
});

test("catalog CRUD persists atomically, normalizes names and uses revisions", () => {
  const f = fixture(); expect(f.store.read()).toEqual(emptyProfileTemplateCatalog()); expect(existsSync(f.path)).toBe(false);
  const saved = f.store.save({ name: "  屏幕预设  ", settings }, 0), first = saved.templates[0]!;
  expect(saved.revision).toBe(1); expect(isProfileTemplateId(first.id)).toBe(true); expect(first.name).toBe("屏幕预设");
  expect(new ProfileTemplateStore(f.path).read()).toEqual(saved); expect(readdirSync(f.root)).toEqual(["profile-templates.json"]);
  first.settings.platform = "changed.example"; expect(f.store.read().templates[0]!.settings.platform).toBe("x.com");
  const renamed = f.store.rename(first.id, "另一个名字", 1); expect(renamed.revision).toBe(2); expect(renamed.templates[0]!.createdAt).toBe(first.createdAt);
  expect(f.store.save({ id: first.id, name: "新配置", settings: automatic }, 2).templates[0]!.settings).toEqual(automatic);
  expect(f.store.remove(first.id, 3)).toEqual({ version: 1, revision: 4, templates: [] });
});

test("stale revisions, duplicate names and missing IDs preserve the original file", () => {
  const f = fixture(), saved = f.store.save({ name: "Preset", settings }, 0), id = saved.templates[0]!.id;
  const before = readFileSync(f.path);
  errorCode(() => f.store.save({ id, name: "Changed", settings }, 0), "revision-conflict");
  errorCode(() => f.store.remove(id, 0), "revision-conflict");
  errorCode(() => f.store.rename(id, "Changed", 0), "revision-conflict");
  errorCode(() => f.store.save({ name: "PRESET", settings }, 1), "duplicate-name");
  errorCode(() => f.store.remove(`tpl_${"b".repeat(32)}`, 1), "not-found");
  errorCode(() => f.store.save({ id: `tpl_${"b".repeat(32)}`, name: "secret-marker", settings }, 1), "not-found");
  expect(readFileSync(f.path)).toEqual(before);
});

test("names, IDs, revisions and catalog capacity are bounded", () => {
  const f = fixture();
  for (const displayName of ["", " ", "x".repeat(81), "😀".repeat(70), "secret-marker\nname", "secret-marker\u202eexe"]) errorCode(() => f.store.save({ name: displayName, settings }, 0), "invalid-input");
  for (const id of ["../secret-marker", "tpl_bad", `tpl_${"A".repeat(32)}`]) errorCode(() => f.store.save({ id, name: "A", settings }, 0), "invalid-input");
  for (const revision of [-1, 1.5, null, "0", Number.MAX_SAFE_INTEGER]) errorCode(() => f.store.save({ name: "A", settings }, revision as any), "invalid-input");
  const catalog = { version: 1, revision: 12, templates: Array.from({ length: 100 }, (_, i) => template({ id: `tpl_${i.toString(16).padStart(32, "0")}`, name: `Template ${i}` })) };
  writeFileSync(f.path, JSON.stringify(catalog));
  errorCode(() => f.store.save({ name: "one too many", settings }, 12), "catalog-full");
  expect(f.store.save({ id: catalog.templates[0]!.id, name: "Renamed at capacity", settings }, 12).templates).toHaveLength(100);
});

test("catalog parsing rejects future formats, duplicate identity, extra fields and malformed timestamps", () => {
  const good = { version: 1, revision: 1, templates: [template()] };
  for (const value of [null, {}, { ...good, version: 2 }, { ...good, password: "secret-marker" }, { ...good, revision: -1 }, { ...good, templates: [template(), template()] }, { ...good, templates: [template(), template({ id: `tpl_${"b".repeat(32)}`, name: "日常桌面" })] }, { ...good, templates: [template({ createdAt: "secret-marker" })] }, { ...good, templates: [template({ updatedAt: "2020-01-01T00:00:00.000Z" })] }, { ...good, templates: [{ ...template(), fingerprintSeed: 1 }] }, { ...good, templates: Array(101).fill(template()) }]) errorCode(() => parseProfileTemplateCatalog(value), "invalid-catalog");
});

test("corrupt, oversized, non-UTF8 and non-file catalogs never expose content or overwrite data", () => {
  const f = fixture();
  for (const content of ['{"password":"secret-marker",BROKEN', "x".repeat(PROFILE_TEMPLATE_LIMITS.fileBytes + 1), Buffer.from([0xff, 0xfe, 0xff])]) {
    writeFileSync(f.path, content); const before = readFileSync(f.path);
    errorCode(() => f.store.read(), "invalid-catalog"); errorCode(() => f.store.save({ name: "new", settings }, 0), "invalid-catalog");
    expect(readFileSync(f.path)).toEqual(before);
  }
  unlinkSync(f.path); mkdirSync(f.path); errorCode(() => f.store.read(), "invalid-catalog");
});

test("linked catalogs and parent junctions are rejected without changing their target", () => {
  const f = fixture(), target = join(f.root, "real.json"); writeFileSync(target, JSON.stringify(emptyProfileTemplateCatalog()));
  symlinkSync(target, f.path, "file"); links.push(f.path);
  errorCode(() => f.store.read(), "invalid-catalog"); errorCode(() => f.store.save({ name: "A", settings }, 0), "invalid-catalog");
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(emptyProfileTemplateCatalog());
  const directory = join(f.root, "linked-parent"); symlinkSync(f.root, directory, process.platform === "win32" ? "junction" : "dir"); links.push(directory);
  errorCode(() => new ProfileTemplateStore(join(directory, "real.json")).read(), "invalid-catalog");
});

test("clock rollback keeps template timestamps monotonic", () => {
  const f = fixture(); let now = Date.parse("2026-11-09T10:00:00.000Z"); const store = new ProfileTemplateStore(f.path, () => now);
  let value = store.save({ name: "A", settings }, 0); const first = value.templates[0]!;
  now += 10_000; value = store.rename(first.id, "B", 1); const updated = value.templates[0]!.updatedAt;
  now -= 20_000; value = store.rename(first.id, "C", 2);
  expect(value.templates[0]!.createdAt).toBe(first.createdAt); expect(value.templates[0]!.updatedAt).toBe(updated);
});
