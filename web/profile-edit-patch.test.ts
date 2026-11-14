import { expect, test } from "bun:test";
import { buildProfileEditPatch, captureProfileEditSnapshot, ProfileEditPatchError, type ProfileEditSnapshot } from "./profile-edit-patch.ts";

const form = () => ({ name: "Environment", group: "Old group", platform: "x.com", proxy: "proxy.example:8080:person:PRIVATE_PROXY_SECRET", proxyType: "http", username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", email: "PRIVATE_EMAIL", emailPassword: "PRIVATE_EMAIL_PASSWORD", twofa: "PRIVATE_2FA", resolution: "1920*1080", tags: "warmup, priority", customNo: "001", platformOs: "windows", timezone: "UTC", locale: "en-US", cores: "8", fingerprintSeed: "777" });
const snapshot = (overrides: Record<string, string> = {}, options: Partial<Omit<ProfileEditSnapshot, "form">> = {}) => captureProfileEditSnapshot({ form: { ...form(), ...overrides }, extensions: ["one", "two"], engine: "chromium", ...options });

test("edit snapshots capture only complete allowlisted fields and cannot be mutated by their source", () => {
  const source = form(); Object.defineProperty(source, "cookies", { enumerable: true, get() { throw new Error("Private unrelated data was read"); } });
  const initial = captureProfileEditSnapshot({ form: source, extensions: ["one", "one"], engine: "chromium" }); source.password = "changed elsewhere";
  expect(initial.form.password).toBe("PRIVATE_PASSWORD"); expect(initial.extensions).toEqual(["one"]); expect(Object.isFrozen(initial.form)).toBe(true);
  expect(() => captureProfileEditSnapshot({ form: { name: "only a name" }, extensions: [], engine: "chromium" })).toThrow(ProfileEditPatchError);
  expect(() => captureProfileEditSnapshot({ form: { ...form(), get password(): string { throw new Error("PRIVATE_RAW_ERROR"); } }, extensions: [], engine: "chromium" })).toThrow("Profile details are incomplete.");
});

test("name-only patches never carry unchanged credentials, proxy, tags, custom number or fingerprint fields", () => {
  const initial = snapshot(), result = buildProfileEditPatch(initial, { form: { ...initial.form, name: "Renamed" }, extensions: [...initial.extensions] });
  expect(result.patch).toEqual({ name: "Renamed" }); expect(result.summary.count).toBe(1); expect(result.summary.nextStartCount).toBe(0);
  expect(result.summary.changes).toEqual([{ field: "name", label: "Name", effect: "stored", clearing: false }]); expect(JSON.stringify(result.summary)).not.toContain("PRIVATE");
});

test("equivalent numeric, language, screen, tag and extension representations are not changes", () => {
  const initial = snapshot();
  const result = buildProfileEditPatch(initial, { form: { ...initial.form, resolution: "01920 × 01080", cores: "08", fingerprintSeed: "0777", locale: "EN-us", tags: "warmup,priority,warmup", customNo: " 001 " }, extensions: ["two", "one", "one"] });
  expect(result.patch).toEqual({}); expect(result.summary.hasChanges).toBe(false); expect(result.summary.requiresFingerprintConfirmation).toBe(false);
});

test("explicit clears are preserved without expanding the update to unrelated fields", () => {
  const initial = snapshot(), result = buildProfileEditPatch(initial, { form: { ...initial.form, password: "", emailPassword: "", twofa: "", tags: "", customNo: "", timezone: "", cores: "", platformOs: "", proxy: "" }, extensions: [] });
  expect(result.patch).toEqual({ password: "", emailPassword: "", twofa: "", tags: [], customNo: "", platformOs: "", timezone: "", cores: "", proxy: "", proxyType: "http", extensions: [] });
  expect(result.summary.count).toBe(10); expect(result.summary.nextStartCount).toBe(5); expect(result.summary.changes.every(change => change.clearing)).toBe(true); expect(result.summary.requiresFingerprintConfirmation).toBe(true);
});

test("proxy protocol changes carry their paired address, while blank protocol-only drafts remain no-ops", () => {
  const initial = snapshot(); expect(buildProfileEditPatch(initial, { form: { ...initial.form, proxyType: "socks5" }, extensions: initial.extensions }).patch).toEqual({ proxy: initial.form.proxy, proxyType: "socks5" });
  const missing = snapshot({ proxy: "" }); expect(buildProfileEditPatch(missing, { form: { ...missing.form, proxyType: "socks5" }, extensions: missing.extensions }).patch).toEqual({});
  const quarantined = snapshot({ proxy: "" }, { proxyQuarantined: true });
  expect(buildProfileEditPatch(quarantined, { form: quarantined.form, extensions: quarantined.extensions }).patch).toEqual({});
  expect(buildProfileEditPatch(quarantined, { form: quarantined.form, extensions: quarantined.extensions, clearQuarantinedProxy: true }).patch).toEqual({ proxy: "", proxyType: "http" });
  expect(buildProfileEditPatch(initial, { form: { ...initial.form, proxy: ` ${initial.form.proxy} ` }, extensions: initial.extensions }).patch).toEqual({});
});

test("extension and group semantics retain explicit Chromium selection and server-applied group defaults", () => {
  const initial = snapshot();
  const moved = buildProfileEditPatch(initial, { form: { ...initial.form, group: "New group" }, extensions: initial.extensions }); expect(moved.patch).toEqual({ group: "New group" }); expect(moved.summary.groupDefaultsMayApply).toBe(true);
  const explicit = buildProfileEditPatch(initial, { form: { ...initial.form, group: "New group" }, extensions: [] }); expect(explicit.patch.extensions).toEqual([]); expect(explicit.summary.groupDefaultsMayApply).toBe(false);
  const firefox = snapshot({}, { engine: "firefox" }); expect(buildProfileEditPatch(firefox, { form: firefox.form, extensions: [] }).patch).toEqual({});
  expect(() => buildProfileEditPatch(firefox, { form: { ...firefox.form, platformOs: "macos" }, extensions: firefox.extensions })).toThrow("Firefox operating system cannot be changed");
});

test("timezone presence preserves automatic policy, explicit clears restore automatic, and proxy refresh can rebase", () => {
  for (const timezoneManual of [false, true]) {
    const initial = snapshot({}, { timezoneManual });
    const proxy = buildProfileEditPatch(initial, { form: { ...initial.form, proxy: "new.example:8080" }, extensions: initial.extensions }); expect(proxy.patch).not.toHaveProperty("timezone");
    expect(buildProfileEditPatch(initial, { form: { ...initial.form, timezone: "Europe/Paris" }, extensions: initial.extensions }).patch).toEqual({ timezone: "Europe/Paris" });
    expect(buildProfileEditPatch(initial, { form: { ...initial.form, timezone: "" }, extensions: initial.extensions }).patch).toEqual({ timezone: "" });
    const rebased = captureProfileEditSnapshot({ ...initial, form: { ...initial.form, timezone: "Europe/Paris", locale: "fr-FR" }, timezoneManual: false });
    const renamed = buildProfileEditPatch(rebased, { form: { ...rebased.form, name: "After automatic refresh" }, extensions: rebased.extensions }); expect(renamed.patch).toEqual({ name: "After automatic refresh" }); expect(renamed.summary.fingerprintChanged).toBe(false);
  }
});

test("unsupported locale clearing is disclosed as a no-op rather than counted as a saved change", () => {
  const initial = snapshot(), result = buildProfileEditPatch(initial, { form: { ...initial.form, locale: "" }, extensions: initial.extensions });
  expect(result.patch).toEqual({}); expect(result.summary.hasChanges).toBe(false); expect(result.summary.notices[0]?.code).toBe("locale-clear-unsupported"); expect(result.summary.requiresFingerprintConfirmation).toBe(false);
});

test("unchanged legacy-invalid fields do not block ordinary edits, while newly invalid fields use fixed errors", () => {
  const initial = snapshot({ tags: Array.from({ length: 21 }, (_, index) => `old${index}`).join(","), resolution: "legacy", fingerprintSeed: "", locale: "invalid language" });
  expect(buildProfileEditPatch(initial, { form: { ...initial.form, name: "Still editable" }, extensions: initial.extensions }).patch).toEqual({ name: "Still editable" });
  for (const changed of [{ resolution: "PRIVATE_BAD_SCREEN" }, { fingerprintSeed: "PRIVATE_BAD_SEED" }, { locale: "PRIVATE BAD LANGUAGE" }, { cores: "PRIVATE_BAD_CORES" }, { customNo: "PRIVATE_CUSTOM_NO" }]) {
    let error: unknown; try { buildProfileEditPatch(initial, { form: { ...initial.form, ...changed }, extensions: initial.extensions }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProfileEditPatchError); expect((error as Error).message).not.toContain("PRIVATE");
  }
  expect(() => buildProfileEditPatch(initial, { form: { ...initial.form, resolution: "" }, extensions: initial.extensions })).toThrow("this editor cannot clear the saved screen size");
  const changedPassword = buildProfileEditPatch(initial, { form: { ...initial.form, password: " keep whitespace " }, extensions: initial.extensions }); expect(changedPassword.patch).toEqual({ password: " keep whitespace " });
});
