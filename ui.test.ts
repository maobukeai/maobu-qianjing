import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { BrowserLaunchError, Launcher, launchPersona } from "./launcher.ts";
import { parseExport } from "./parse.ts";
import { deriveFingerprintFlags, editedProfileHardware } from "./fingerprint.ts";
import { listUiProfiles, handleUiRequest, LOW_DISK_SPACE_BYTES } from "./ui.ts";
import { defaultChromiumRuntime as defaultRuntimePolicy } from "./aliasmode-chromium.ts";
import { buildNewProfile } from "./create.ts";
import { trackRuntimeDownload } from "./runtime-download.ts";
import { readXlsx, writeXlsx } from "./xlsx.ts";
import { AppConfigStore } from "./app-config.ts";

import type { ProxyCheckResult } from "./proxy-check.ts";
import type { Profile, ProxySpec } from "./types.ts";
const SAMPLE = `id=k1d0cd11
name=sophia
group=va1
username=account-user
password=SECRETpw
email=mailbox@example.com
emailpassword=MAILSECRETpw
fakey=TOTPSEED
cookie=[{"name":"auth_token","value":"COOKIEVAL","domain":".x.com","path":"/","expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:proxyuser:PROXYPASS
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;
function store(): ProfileStore {
    const s = new ProfileStore(":memory:");
    for (const p of parseExport(SAMPLE).profiles)
        s.upsertProfile(p);
    return s;
}
function firefoxProfile(s: ProfileStore, id: string): Profile {
    const base = s.getProfile("k1d0cd11")!;
    return {
        ...base,
        id,
        engine: "firefox",
        firefox: {
            version: 1,
            runtimeVersion: "test-firefox",
            config: { timezone: "UTC" },
        },
    };
}
/** One exit lookup asks GeoJS (MaxMind's data) and ip-api.com at once. */
const EXIT_LOOKUP_CALLS = [["https://get.geojs.io/v1/ip/geo.json"], ["https://ipinfo.io/json"]];
function timezoneFetch(timezones: Record<string, string>, calls?: string[][]) {
    return async (url: string, _init: RequestInit) => {
        calls?.push([url]);
        const timezone = Object.values(timezones)[0];
        return { json: async () => timezone ? { status: "success", timezone } : { status: "fail" } };
    };
}
const EXTENSION_ZIP = Buffer.from("UEsDBBQAAAAAAFtxHl1SmQ+hOwAAADsAAAANAAAAbWFuaWZlc3QuanNvbnsibWFuaWZlc3RfdmVyc2lvbiI6MywibmFtZSI6IlJvdXRlIEZpeHR1cmUiLCJ2ZXJzaW9uIjoiMSJ9UEsBAhQDFAAAAAAAW3EeXVKZD6E7AAAAOwAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAZgAAAAAA", "base64");
function extensionId(publicKey: Uint8Array): string {
    const digest = createHash("sha256").update(publicKey).digest();
    return [...digest.subarray(0, 16)]
        .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
        .join("");
}
const extensionKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const extensionPublicKey = new Uint8Array(extensionKeys.publicKey.export({ format: "der", type: "spki" }));
function extensionCrx(): Uint8Array {
    const signature = new Uint8Array(sign("sha1", EXTENSION_ZIP, extensionKeys.privateKey));
    const header = new Uint8Array(16);
    header.set(new TextEncoder().encode("Cr24"));
    const view = new DataView(header.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(8, extensionPublicKey.length, true);
    view.setUint32(12, signature.length, true);
    const out = new Uint8Array(header.length + extensionPublicKey.length + signature.length + EXTENSION_ZIP.length);
    out.set(header);
    out.set(extensionPublicKey, header.length);
    out.set(signature, header.length + extensionPublicKey.length);
    out.set(EXTENSION_ZIP, header.length + extensionPublicKey.length + signature.length);
    return out;
}
function extensionResponse(): Response {
    const bytes = extensionCrx();
    return new Response(bytes.buffer as ArrayBuffer);
}
test("listUiProfiles exposes metadata but redacts every secret", () => {
    const s = store();
    const saved = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...saved, extensions: ["extension-alpha", "extension-beta"] });
    const list = listUiProfiles(s);
    const p = list[0]!;
    expect(p.proxy).toBe("1.2.3.4:8080"); // host:port only
    expect(p.cookieCount).toBe(1);
    expect(p.screen).toBe("1680x1050");
    expect(p.running).toBe(false);
    expect(p.extensions).toEqual(["extension-alpha", "extension-beta"]);
    const json = JSON.stringify(list);
    for (const secret of ["account-user", "SECRETpw", "MAILSECRETpw", "mailbox@example.com", "TOTPSEED", "COOKIEVAL", "PROXYPASS", "proxyuser"]) {
        expect(json.includes(secret)).toBe(false);
    }
    s.close();
});
test("configuration reuse reads only safe creation fields for both browser engines without changing the source", async () => {
    const s = store();
    const base = s.getProfile("k1d0cd11")!;
    const setups: Profile[] = [
        { ...base, id: "reuse-cloak", engine: "chromium", chromiumRuntime: undefined, platformOs: "windows" },
        { ...base, id: "reuse-alias", engine: "chromium", chromiumRuntime: "aliasmode", platformOs: "linux" },
        { ...firefoxProfile(s, "reuse-firefox"), chromiumRuntime: undefined, platformOs: "macos" },
    ];
    const sources = setups.map(source => ({ ...source, name: "Reuse source", group: "QA group", platform: "EXAMPLE.COM", fingerprintSeed: 9283746, customNo: "8024", extensions: ["PRIVATE_EXTENSION"], tags: ["PRIVATE_TAG"] }));
    for (const source of sources) s.upsertProfile(source);
    s.recordLaunch({ profileId: "reuse-cloak", pid: 1, debugPort: 9412, ws: "ws://PRIVATE_CONTROL_ENDPOINT", startedAt: 123 });
    const before = s.listProfiles();
    const launch = s.getLaunch("reuse-cloak");
    const launcher = new Proxy({}, { get() { throw new Error("Reading reuse settings must not invoke the launcher"); } }) as any;
    for (const source of sources) {
        const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${source.id}/reuse`), launcher, s);
        expect(response!.status).toBe(200);
        expect(response!.headers.get("cache-control")).toBe("no-store");
        const text = await response!.text(), body = JSON.parse(text);
        const runtime = source.engine === "firefox" ? {} : { chromiumRuntime: source.chromiumRuntime ?? "cloakbrowser" };
        expect(body).toEqual({ ok: true, profile: {
            sourceId: source.id, name: "Reuse source", group: "QA group", engine: source.engine,
            ...runtime, platformOs: source.platformOs, screen: "1680x1050", platform: "example.com",
        } });
        for (const secret of ["account-user", "SECRETpw", "MAILSECRETpw", "mailbox@example.com", "TOTPSEED", "COOKIEVAL", "PROXYPASS", "proxyuser", "PRIVATE_EXTENSION", "PRIVATE_TAG", "PRIVATE_CONTROL_ENDPOINT", "9283746", "8024", source.ua]) expect(text).not.toContain(secret);
    }
    expect(s.listProfiles()).toEqual(before);
    expect(s.getLaunch("reuse-cloak")).toEqual(launch);
    s.close();
});
test("configuration reuse rejects missing or unsafe source IDs and cannot create through another method", async () => {
    const s = store(), before = s.listProfiles();
    const launcher = new Proxy({}, { get() { throw new Error("reuse route must remain read-only"); } }) as any;
    const missing = await handleUiRequest(new Request("http://x/ui/api/profiles/missing-profile/reuse"), launcher, s);
    expect(missing!.status).toBe(404);
    expect(await missing!.json()).toMatchObject({ ok: false, code: "not-found" });
    for (const encoded of ["", "%ZZ", "CON", "_invalid", "bad%2Fid", "a".repeat(129)]) {
        const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${encoded}/reuse`), launcher, s);
        expect(response!.status).toBe(400);
        expect(await response!.json()).toMatchObject({ ok: false, code: "invalid-id" });
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/reuse", { method }), launcher, s);
        expect(response!.status).toBe(405);
        expect(response!.headers.get("allow")).toBe("GET");
        expect(response!.headers.get("cache-control")).toBe("no-store");
    }
    expect(s.listProfiles()).toEqual(before);
    s.close();
});
test("configuration reuse leaves unsupported mobile and legacy settings untouched with a fixed explanation", async () => {
    const s = store(), base = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...base, id: "reuse-mobile", ua: "Mozilla/5.0 (Linux; Android 14) Mobile PRIVATE_UA", platformOs: "windows", screenWidth: 390, screenHeight: 844 });
    const mobile = await handleUiRequest(new Request("http://x/ui/api/profiles/reuse-mobile/reuse"), {} as any, s);
    expect(mobile!.status).toBe(409);
    expect(await mobile!.json()).toMatchObject({ ok: false, code: "mobile-profile" });
    for (const [id, sql] of [
        ["reuse-legacy-screen", "UPDATE profiles SET screen_width = 0 WHERE id = ?"],
        ["reuse-legacy-os", "UPDATE profiles SET platform_os = 'android' WHERE id = ?"],
        ["reuse-legacy-platform", "UPDATE profiles SET platform = 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.com/private' WHERE id = ?"],
    ] as const) {
        s.upsertProfile({ ...base, id });
        // Simulate rows saved by an older build; current writes correctly
        // reject these values before they can enter the database.
        (s as any)["db"].query(sql).run(id);
        const before = s.getProfile(id);
        const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}/reuse`), {} as any, s);
        expect(response!.status).toBe(409);
        const text = await response!.text();
        expect(JSON.parse(text)).toMatchObject({ ok: false, code: "invalid-settings" });
        expect(text).not.toContain("PRIVATE_");
        expect(s.getProfile(id)).toEqual(before);
    }
    s.close();
});
test("a quarantined legacy proxy stays visible and repairable without exposing credentials", async () => {
    const s = store();
    const raw = JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "legacy-user", pass: "legacy-pass" });
    (s as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(raw, "k1d0cd11");
    const roster = listUiProfiles(s);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.proxy).toBeNull();
    expect(roster[0]!.proxyError).toContain("unsupported proxy type");
    expect(JSON.stringify(roster)).not.toContain("legacy-pass");
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
    const edit = (await response!.json()).profile;
    expect(edit.proxy).toBe("");
    expect(edit.proxyError).toContain("unsupported proxy type");
    s.close();
});
test("proxy check route works locally without storing proxy data", async () => {
    const s = store();
    const before = structuredClone(s.getProfile("k1d0cd11"));
    const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-proxy-check-"));
    const appConfig = new AppConfigStore(join(root, "config.json"));
    appConfig.setMode("local");
    const checked: ProxySpec[] = [];
    const results: ProxyCheckResult[] = [
        { status: "working", attempts: 3, successes: 3, ip: "203.0.113.10", country: "US", rotating: false },
        { status: "working", attempts: 3, successes: 3, ip: "203.0.113.10", reason: "same_exit", exitComparison: "same" },
        { status: "working", attempts: 3, successes: 3, ip: "203.0.113.12", exitComparison: "different" },
        { status: "unstable", attempts: 3, successes: 2, reason: "intermittent", ip: "203.0.113.11" },
        { status: "failed", attempts: 3, successes: 0, reason: "authentication_failed" },
        { status: "unavailable", attempts: 3, successes: 0, reason: "check_unavailable" },
    ];
    for (const expected of results) {
        const response = await handleUiRequest(new Request("http://x/ui/api/proxy/check", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://x" },
            body: JSON.stringify({
                proxy: {
                    type: "socks5",
                    host: " proxy.example ",
                    port: "01080",
                    user: " proxy-user ",
                    pass: "private-password",
                },
            }),
        }), {} as any, s, {
            appConfig,
            proxyCheck: async (proxy: ProxySpec) => {
                checked.push(proxy);
                return { ...expected, pass: "must-not-leak" } as ProxyCheckResult;
            },
        } as any);
        expect(response!.status).toBe(200);
        expect(response!.headers.get("cache-control")).toBe("no-store");
        expect(await response!.json()).toEqual({ ok: true, ...expected });
    }
    expect(checked).toEqual(Array.from({ length: results.length }, () => ({
        type: "socks5",
        host: "proxy.example",
        port: "1080",
        user: "proxy-user",
        pass: "private-password",
    })));
    expect(s.getProfile("k1d0cd11")).toEqual(before);
    s.close();
    rmSync(root, { recursive: true, force: true });
});
test("proxy check route rejects untrusted or invalid input without echoing credentials", async () => {
    const s = store();
    let checks = 0;
    const options = {
        proxyCheck: async () => {
            checks++;
            throw new Error("checker exposed private-password");
        },
    } as any;
    const request = (body: unknown, headers: HeadersInit = { "content-type": "application/json" }) => handleUiRequest(new Request("http://x/ui/api/proxy/check", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
    }), {} as any, s, options);
    const untrusted = await request({}, { "content-type": "text/plain" });
    expect(untrusted!.status).toBe(415);
    expect(untrusted!.headers.get("cache-control")).toBe("no-store");
    const crossOrigin = await request({}, {
        "content-type": "application/json",
        origin: "https://outside.invalid",
    });
    expect(crossOrigin!.status).toBe(403);
    for (const body of [
        { proxy: { host: "", port: "" } },
        { proxy: { host: "proxy.example", port: "not-a-port" } },
        { proxy: { type: "https", host: "proxy.example", port: "8443" } },
        { proxy: { type: "private-password", host: "proxy.example", port: "8080" } },
        "not-json",
    ]) {
        const response = await request(body);
        const text = await response!.text();
        expect(response!.status).toBe(400);
        expect(response!.headers.get("cache-control")).toBe("no-store");
        expect(text).not.toContain("private-password");
        expect(text).not.toContain("proxy.example");
    }
    expect(checks).toBe(0);
    const failed = await request({
        proxy: {
            type: "http",
            host: "proxy.example",
            port: "8080",
            user: "proxy-user",
            pass: "private-password",
        },
    });
    const failureText = await failed!.text();
    expect(failed!.status).toBe(500);
    expect(failed!.headers.get("cache-control")).toBe("no-store");
    expect(failureText).toContain("Proxy check failed");
    expect(failureText).not.toContain("private-password");
    expect(failureText).not.toContain("checker exposed");
    expect(checks).toBe(1);
    s.close();
});
test("full profile edit keeps account and mailbox credentials in separate fields", async () => {
    const s = store();
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
    const edit = (await response!.json()).profile;
    expect(edit).toMatchObject({
        username: "account-user",
        password: "SECRETpw",
        email: "mailbox@example.com",
        emailPassword: "MAILSECRETpw",
        twofa: "TOTPSEED",
    });
    const updated = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: {
                username: "account-user", password: "linkedin-pass",
                email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
            } }),
    }), {} as any, s);
    expect(updated!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({
        username: "account-user", password: "linkedin-pass",
        email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
    });
    s.close();
});
test("listUiProfiles reflects running status from the launches table", () => {
    const s = store();
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 123 });
    const p = listUiProfiles(s)[0]!;
    expect(p.running).toBe(true);
    expect(p.debugPort).toBe(9412);
    s.close();
});
test("open/close routes call the launcher", async () => {
    const s = store();
    const calls: string[] = [];
    const launcher: any = {
        start: async (id: string) => { calls.push(`start:${id}`); return { ws: "ws://x", port: 9333 }; },
        stop: async (id: string) => { calls.push(`stop:${id}`); return true; },
        captureLocalSession: async (id: string) => { calls.push(`capture:${id}`); return false; },
    };
    const open = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }), launcher, s);
    expect((await open!.json()).ok).toBe(true);
    const close = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/close", { method: "POST" }), launcher, s);
    expect((await close!.json()).ok).toBe(true);
    expect(calls).toEqual(["start:k1d0cd11", "capture:k1d0cd11", "stop:k1d0cd11"]);
    s.close();
});
test("Firefox open responses do not expose the internal port", async () => {
    const s = store();
    s.upsertProfile(firefoxProfile(s, "firefox-open"));
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/firefox-open/open", { method: "POST" }), { start: async () => ({ port: 9333 }) } as any, s);
    expect(await response!.json()).toEqual({
        ok: true,
        engine: "firefox",
        capabilities: { cdp: false, pdf: false, chromeExtensions: false },
    });
    s.close();
});
test("cookie route rejects untrusted and malformed requests, and keeps cookies for a closed profile", async () => {
    const s = store();
    let certifications = 0;
    let writes = 0;
    const launcher = { certifiedActive: async () => { certifications++; return false; } } as any;
    const options = { setCookies: async () => { writes++; } } as any;
    const untrusted = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://outside.invalid" },
        body: "{}",
    }), launcher, s, options);
    expect(untrusted!.status).toBe(415);
    const crossOrigin = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://outside.invalid" },
        body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
    }), launcher, s, options);
    expect(crossOrigin!.status).toBe(403);
    for (const body of [
        { name: "", value: "value", domain: "example.com", path: "/" },
        { name: "bad name", value: "value", domain: "example.com", path: "/" },
        { name: "bad=name", value: "value", domain: "example.com", path: "/" },
        { name: "name", value: "bad;value", domain: "example.com", path: "/" },
        { name: "name", value: "value", domain: "", path: "/" },
        { name: "name", value: "value", domain: "example.com", path: "account" },
        { text: "not cookies" },
        { text: "[]" },
    ]) {
        const malformed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }), launcher, s, options);
        expect(malformed!.status).toBe(400);
    }
    expect(s.getPendingCookies("k1d0cd11")).toEqual([]);
    const closed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
    }), launcher, s, options);
    expect(closed!.status).toBe(200);
    expect(await closed!.json()).toEqual({ ok: true, applied: "next-start", count: 1 });
    expect(s.getPendingCookies("k1d0cd11")).toMatchObject([{ name: "session", value: "value", domain: "example.com", path: "/" }]);
    expect(listUiProfiles(s).find((profile) => profile.id === "k1d0cd11")!.pendingCookieCount).toBe(1);
    // The pending list shows domain and name only, and can be removed.
    const listed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/pending-cookies"), launcher, s, options);
    expect(await listed!.json()).toEqual({ ok: true, cookies: [{ domain: "example.com", name: "session" }] });
    const removed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/pending-cookies/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    }), launcher, s, options);
    expect(await removed!.json()).toEqual({ ok: true, removed: 1 });
    expect(s.getPendingCookies("k1d0cd11")).toEqual([]);
    expect(listUiProfiles(s).find((profile) => profile.id === "k1d0cd11")!.pendingCookieCount).toBeUndefined();
    // A recorded browser that is not certified yet (still starting) gets nothing.
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
    const starting = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "other", value: "value", domain: "example.com", path: "/" }),
    }), launcher, s, options);
    expect(starting!.status).toBe(409);
    expect(await starting!.json()).toEqual({ ok: false, error: "profile browser is not open" });
    expect(certifications).toBe(1);
    expect(writes).toBe(0);
    expect(s.getPendingCookies("k1d0cd11")).toHaveLength(0);
    s.close();
});
test("bulk cookie route sets open browsers now and keeps cookies for closed profiles", async () => {
    const s = store();
    const first = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...first, id: "k1closed", name: "closed" });
    s.upsertProfile(firefoxProfile(s, "k1firefox"));
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://chromium", startedAt: 1 });
    s.recordLaunch({ profileId: "k1firefox", engine: "firefox", pid: 2, debugPort: 9413, ws: "firefox://live", startedAt: 1 });
    const calls: Array<{
        ws: string;
        cookies: any[];
    }> = [];
    const post = (body: unknown) => handleUiRequest(new Request("http://x/ui/api/profiles/cookies", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), { certifiedActive: async () => true } as any, s, {
        setCookies: async (ws: string, cookies: any[]) => { calls.push({ ws, cookies }); },
    } as any);
    const json = JSON.stringify([
        { name: "auth_token", value: "a1", domain: ".x.com", path: "/", secure: true, httpOnly: true, expirationDate: 1800000000, sameSite: "no_restriction", partitionKey: "https://x.com" },
        { name: "ct0", value: "c1", domain: ".x.com", path: "/", session: true },
    ]);
    const response = await post({ ids: ["k1d0cd11", "k1closed", "k1firefox"], text: json });
    expect(await response!.json()).toEqual({ ok: true, count: 2, live: 2, nextStart: 1, errors: [] });
    expect(calls.map((call) => call.ws)).toEqual(["ws://chromium", "firefox://live"]);
    expect(calls[0]!.cookies[0]).toMatchObject({ name: "auth_token", sameSite: "None", secure: true, partitionKey: "https://x.com", expires: 1800000000 });
    // Firefox has no Chromium cookie partitions.
    expect(calls[1]!.cookies[0].partitionKey).toBeUndefined();
    expect(s.getPendingCookies("k1closed").map((cookie) => cookie.name)).toEqual(["auth_token", "ct0"]);
    // cookies.txt replaces a pending cookie with the same name, domain and path.
    const netscape = "# Netscape HTTP Cookie File\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1800000000\tct0\tc2\n";
    expect(await (await post({ ids: ["k1closed"], text: netscape }))!.json()).toMatchObject({ ok: true, count: 1, nextStart: 1 });
    expect(s.getPendingCookies("k1closed")).toEqual([
        expect.objectContaining({ name: "auth_token", value: "a1" }),
        { name: "ct0", value: "c2", domain: ".x.com", path: "/", httpOnly: true, secure: true, expires: 1800000000 },
    ]);
    const unknown = await post({ ids: ["k1closed", "missing"], name: "a", value: "b", domain: "x.com" });
    expect(await unknown!.json()).toMatchObject({ ok: false, nextStart: 1, errors: [{ id: "missing", error: "no such profile" }] });
    s.close();
});
test("cookie route never returns the cookie value or a raw worker error", async () => {
    const s = store();
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
    const secret = "private-cookie-value";
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "session", value: secret, domain: "example.com", path: "/" }),
    }), { certifiedActive: async () => true } as any, s, {
        setCookies: async () => { throw new Error(`worker rejected ${secret}`); },
    } as any);
    const body = await response!.text();
    expect(response!.status).toBe(500);
    expect(body).toContain("cookie could not be added");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("worker rejected");
    s.close();
});
test("a refused Local open shows what happened instead of its bare launch code", async () => {
    const s = store();
    const launcher: any = { start: async () => { throw new BrowserLaunchError("preflight", "cookie_key_unreadable"); } };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }), launcher, s);
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toBe(new BrowserLaunchError("preflight", "cookie_key_unreadable").guidance);
    s.close();
});
test("the disk space check warns only below the threshold and when the drive can be read", async () => {
    const s = store();
    for (const [freeBytes, low] of [[LOW_DISK_SPACE_BYTES - 1, true], [LOW_DISK_SPACE_BYTES, false], [null, false]] as const) {
        const launcher: any = { dataDriveFreeBytes: () => freeBytes };
        const res = await handleUiRequest(new Request("http://x/ui/api/disk-space"), launcher, s);
        expect(await res!.json()).toEqual({ ok: true, freeBytes, low });
    }
    s.close();
});
test("open on an unknown profile 404s without touching the launcher", async () => {
    const s = store();
    const launcher: any = { start: async () => { throw new Error("must not be called"); } };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/nope/open", { method: "POST" }), launcher, s);
    expect(res!.status).toBe(404);
    s.close();
});
test("GET /ui/api/health is independent of launcher state", async () => {
    const s = store();
    const res = await handleUiRequest(new Request("http://x/ui/api/health"), new Proxy({}, { get: () => { throw new Error("launcher must not be touched"); } }) as any, s);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, version: expect.any(String), root: import.meta.dir });
    s.close();
});
test("GET /ui/api/health uses desktop parent metadata when supplied", async () => {
    const s = store();
    const health = { version: "0.1.0-beta.1", root: "C:\\AliasMode", instance: "ab".repeat(32) };
    const res = await handleUiRequest(new Request("http://x/ui/api/health"), {} as any, s, { health });
    expect(await res!.json()).toEqual({ ok: true, ...health });
    s.close();
});
test("GET /ui/api/profiles clears a stale launch row before reporting status", async () => {
    const s = store();
    // A launch row whose browser is gone (crash / external teardown).
    s.recordLaunch({
        profileId: "k1d0cd11",
        pid: 99999,
        debugPort: 9999,
        ws: "ws://x",
        startedAt: 1,
        binaryPath: "/fake",
        userDataDir: "/tmp/ui-recon/k1d0cd11",
        processGroupId: 99999,
        rootStartTime: "1",
    });
    const launcher = new Launcher({
        store: s,
        binaryPath: "/fake",
        unsafeDisableIdentityGates: true,
        dataRoot: "/tmp/ui-recon",
        spawn: () => ({ pid: 1, kill() { } }),
        fetch: async () => ({ ok: false, json: async () => ({}) }), // CDP port is dead
        ensureCookies: async () => ({ injected: false }),
        killPid: async () => { },
        isPidAlive: () => false,
        findOwnedBrowserPids: async () => [],
        cdpReadyTimeoutMs: 100,
    });
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
    const body = await res!.json();
    expect(body.profiles[0].running).toBe(false); // not shown as running
    expect(body).not.toHaveProperty("healthSources");
    expect(s.getLaunch("k1d0cd11")).toBeNull(); // stale row reconciled away
    s.close();
});
test("GET /ui/api/profiles returns a JSON error when local reconciliation fails", async () => {
    const s = store();
    const launcher: any = { reconcileOrphans: async () => { throw new Error("process scan unavailable"); } };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
    expect(res!.status).toBe(500);
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect((await res!.json()).error).toBe("profile roster failed: process scan unavailable");
    s.close();
});
test("Local group creation keeps an empty group in the profile roster", async () => {
    const s = store();
    const created = await handleUiRequest(new Request("http://x/ui/api/groups/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Empty group" }),
    }), {} as any, s);
    expect(created!.status).toBe(200);
    expect(await created!.json()).toEqual({ ok: true, name: "Empty group", folder: { name: "Empty group", parentName: null, label: "Empty group" } });
    const reserved = await handleUiRequest(new Request("http://x/ui/api/groups/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "all" }),
    }), {} as any, s);
    expect(reserved!.status).toBe(400);
    const roster = await handleUiRequest(new Request("http://x/ui/api/profiles"), { reconcileOrphans: async () => { } } as any, s);
    expect((await roster!.json()).groups).toContain("Empty group");
    s.close();
});
test("Local folder routes preserve explicit parents through create, rename and move", async () => {
    const s = store();
    const request = (path: string, body: unknown) => handleUiRequest(new Request(`http://x/ui/api/groups/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), {} as any, s);
    try {
        await request("create", { name: "Facebook" });
        const created = await request("create", { name: "Fitness", parentName: "Facebook" });
        expect((await created!.json()).folder).toEqual({ name: "Facebook/Fitness", parentName: "Facebook", label: "Fitness" });
        const renamed = await request("rename", { from: "Facebook/Fitness", to: "Health" });
        expect((await renamed!.json()).folder.name).toBe("Facebook/Health");
        expect((await request("move", { name: "Facebook", parentName: "Facebook/Health" }))!.status).toBe(400);
        const moved = await request("move", { name: "Facebook/Health", parentName: null });
        expect((await moved!.json()).folder).toEqual({ name: "Health", parentName: null, label: "Health" });
    }
    finally {
        s.close();
    }
});
test("move route reassigns selected profiles' group", async () => {
    const s = store();
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"], group: "newgrp" }) }), {} as any, s);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.moved).toBe(1);
    expect(listUiProfiles(s)[0]!.group).toBe("newgrp");
    s.close();
});
test("group extension route replaces members and lists defaults", async () => {
    const s = store();
    const saved = await handleUiRequest(new Request("http://x/ui/api/groups/extensions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: "va1", extensions: ["e2", "e1", "e2"] }),
    }), {} as any, s);
    expect(saved!.status).toBe(200);
    expect(await saved!.json()).toMatchObject({ ok: true, updatedCount: 1 });
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["e2", "e1"]);
    const listed = await handleUiRequest(new Request("http://x/ui/api/groups/extensions"), {} as any, s);
    expect(await listed!.json()).toEqual({
        ok: true,
        groups: [{ name: "va1", extensions: ["e2", "e1"] }],
    });
    s.close();
});
test("new profiles and moves inherit Local group extension defaults", async () => {
    const s = store();
    s.registerGroup("With defaults");
    s.setGroupExtensionDefaults("With defaults", ["e1"]);
    const created = await handleUiRequest(new Request("http://x/ui/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new", group: "With defaults", engine: "chromium" }),
    }), {} as any, s);
    const createdId = (await created!.json()).id;
    expect(s.getProfile(createdId)!.extensions).toEqual(["e1"]);
    const moved = await handleUiRequest(new Request("http://x/ui/api/profiles/move", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"], group: "With defaults" }),
    }), {} as any, s);
    expect(moved!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["e1"]);
    s.close();
});
test("single and file group edits inherit unless extensions are explicit", async () => {
    const s = store();
    s.registerGroup("Defaulted");
    s.setGroupExtensionDefaults("Defaulted", ["group-extension"]);
    const inherited = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { group: "Defaulted" } }),
    }), {} as any, s);
    expect(inherited!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["group-extension"]);
    const explicit = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { group: "va1", extensions: ["chosen"] } }),
    }), {} as any, s);
    expect(explicit!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["chosen"]);
    const form = new FormData();
    form.append("files", new File(["id,group\nk1d0cd11,Defaulted\n"], "updates.csv"));
    const fromFile = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s);
    expect(fromFile!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["group-extension"]);
    s.close();
});
test("move route with no ids is a 400", async () => {
    const s = store();
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [], group: "x" }) }), {} as any, s);
    expect(res!.status).toBe(400);
    s.close();
});
test("upload route imports profiles from posted files", async () => {
    const s = new ProfileStore(":memory:");
    // No proxy line → geoip is skipped (no network in the test).
    const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
    const form = new FormData();
    form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.profiles).toBe(1);
    expect(s.getProfile("k1up0001")!.group).toBe("ug");
    s.close();
});
test("upload route atomically imports two AdsPower profiles from one pasted file", async () => {
    const s = new ProfileStore(":memory:");
    const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
    const form = new FormData();
    form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, files: 1, profiles: 2 });
    expect(s.count()).toBe(2);
    expect(s.getProfile("k1up0002")).not.toBeNull();
    expect(s.getProfile("k1up0003")).not.toBeNull();
    s.close();
});
test("upload route rejects a malformed AdsPower record without partial writes", async () => {
    const s = store();
    const beforeCount = s.count();
    const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=0x0\n******************`;
    const form = new FormData();
    form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("invalid resolution");
    expect(s.count()).toBe(beforeCount);
    expect(s.getProfile("k1up0002")).toBeNull();
    expect(s.getProfile("k1up0003")).toBeNull();
    s.close();
});
test("upload route applies group override in local mode", async () => {
    const s = new ProfileStore(":memory:");
    const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=fromfile\ncookie=[]\nresolution=1280*720\n******************`;
    const form = new FormData();
    form.append("group", "selected");
    form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect((await res!.json()).ok).toBe(true);
    expect(s.getProfile("k1up0001")!.group).toBe("selected");
    s.close();
});
test("upload route imports JSON and XLSX provider files in Local mode", async () => {
    const s = new ProfileStore(":memory:");
    const form = new FormData();
    form.append("files", new File([JSON.stringify({ profiles: [{
                    _id: "localjson1",
                    name: "GoLogin JSON",
                    navigator: { resolution: "1600x900", platform: "Win32" },
                }] })], "gologin.json", { type: "application/json" }));
    const workbook = await writeXlsx(["Profile ID", "Profile Name", "Operating System"], [["localxlsx1", "HideMyAcc sheet", "mac"]]);
    form.append("files", new File([workbook as unknown as BlobPart], "hidemyacc.xlsx"));
    const response = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, files: 2, profiles: 2 });
    expect(s.getProfile("localjson1")).toMatchObject({ name: "GoLogin JSON", platformOs: "windows" });
    expect(s.getProfile("localxlsx1")).toMatchObject({ name: "HideMyAcc sheet", platformOs: "macos" });
    s.close();
});
test("upload route with no files is a 400", async () => {
    const s = new ProfileStore(":memory:");
    const res = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: new FormData() }), {} as any, s);
    expect(res!.status).toBe(400);
    s.close();
});
test("upload route reports unsupported archives as bad input", async () => {
    const s = new ProfileStore(":memory:");
    const form = new FormData();
    form.append("files", new File(["PKencrypted-profile"], "multilogin.zip", { type: "application/zip" }));
    const response = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect(response!.status).toBe(400);
    expect((await response!.json()).error).toContain("encrypted or proprietary");
    expect(s.count()).toBe(0);
    s.close();
});
test("upload route reports an open-profile import conflict as 409", async () => {
    const s = store();
    s.recordLaunch({
        profileId: "k1d0cd11",
        pid: 123,
        debugPort: 9333,
        ws: "ws://127.0.0.1:9333/devtools/browser/live",
        startedAt: Date.now(),
    });
    const form = new FormData();
    form.append("files", new File(["id=k1d0cd11\nname=changed\n******************"], "profile.txt"));
    const response = await handleUiRequest(new Request("http://x/ui/api/import/upload", { method: "POST", body: form }), {} as any, s);
    expect(response!.status).toBe(409);
    expect((await response!.json()).error).toContain("currently open");
    s.close();
});

test("bulk update validates every row before atomically writing any profile", async () => {
    const s = store();
    const first = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
    const csv = [
        "id,name,proxy,proxytype",
        "k1d0cd11,renamed,proxy.example:8080:u:p,http",
        "k1d0cd22,also-renamed,malformed,http",
    ].join("\n");
    const form = new FormData();
    form.append("files", new File([csv], "updates.csv", { type: "text/csv" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s);
    const body = await res!.json();
    expect(res!.status).toBe(400);
    expect(body.updated).toBe(0);
    expect(body.errors).toEqual([{ id: "k1d0cd22", error: expect.stringContaining("proxy must be") }]);
    expect(s.getProfile("k1d0cd11")!.name).toBe("sophia");
    expect(s.getProfile("k1d0cd22")!.name).toBe("second");
    s.close();
});
test("a short CSV update row preserves omitted trailing identity fields", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "America/Los_Angeles";
    s.upsertProfile(before);
    const form = new FormData();
    form.append("files", new File([
        "id,name,proxy,proxytype,resolution\n" +
            "k1d0cd11,renamed",
    ], "updates.csv", { type: "text/csv" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s);
    expect(res!.status).toBe(200);
    const after = s.getProfile("k1d0cd11")!;
    expect(after.name).toBe("renamed");
    expect(after.proxy).toEqual(before.proxy);
    expect(after.timezone).toBe("America/Los_Angeles");
    expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
    s.close();
});
test("bulk proxy edits resolve changed timezones", async () => {
    const s = store();
    const first = s.getProfile("k1d0cd11")!;
    first.timezone = "America/Los_Angeles";
    s.upsertProfile(first);
    s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
    const form = new FormData();
    form.append("files", new File([
        "id,proxy,proxytype\n" +
            "k1d0cd11,first-proxy.example:8080:u:p,http\n" +
            "k1d0cd22,second-proxy.example:1080:u:p,socks5",
    ], "updates.csv", { type: "text/csv" }));
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s, { timezoneFetch: timezoneFetch({ "first-proxy.example": "Europe/London" }, calls) });
    expect(res!.status).toBe(200);
    expect(calls).toEqual([...EXIT_LOOKUP_CALLS, ...EXIT_LOOKUP_CALLS]);
    expect(s.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
    expect(s.getProfile("k1d0cd22")!.timezone).toBe("Europe/London");
    s.close();
});
test("single edits reject malformed resolutions without changing stored identity", async () => {
    for (const resolution of ["", "0x0", "319x1080", "99999x1080", "1920xnope"]) {
        const s = store();
        const before = s.getProfile("k1d0cd11")!;
        const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { resolution } }),
        }), {} as any, s);
        expect(res!.status).toBe(500);
        expect((await res!.json()).error).toContain("invalid resolution");
        const after = s.getProfile("k1d0cd11")!;
        expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
        s.close();
    }
});
test("Firefox profiles reject Chrome extension changes", async () => {
    const s = store();
    s.upsertProfile(firefoxProfile(s, "firefox-ext"));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/firefox-ext/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { extensions: ["chrome-extension"] } }),
    }), {} as any, s);
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toMatch(/Firefox profiles/);
    s.close();
});
test("a Firefox screen edit saves the screen with its usable area and a window inside it, also while open", async () => {
    const s = store();
    const profile = firefoxProfile(s, "firefox-screen");
    profile.screenWidth = 2560;
    profile.screenHeight = 1440;
    profile.firefox!.config = {
        ...profile.firefox!.config, "navigator.platform": "Win32", "screen.width": 2560, "screen.height": 1440,
        "window.outerWidth": 1664, "window.outerHeight": 1296, "window.innerWidth": 1648, "window.innerHeight": 1190,
    };
    s.upsertProfile(profile);
    const edit = () => handleUiRequest(new Request("http://x/ui/api/profiles/firefox-screen/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { resolution: "1366x768" } }) }), {} as any, s);
    s.recordLaunch({
        profileId: "firefox-screen", pid: 1, debugPort: 9412, ws: "firefox://live", startedAt: 123,
        persona: launchPersona(s.getProfile("firefox-screen")!),
    });
    const open = await edit();
    expect(open!.status).toBe(200);
    // Saved now; the open browser keeps its launch screen until it restarts.
    expect(await open!.json()).toEqual({ ok: true, restartRequired: true });
    expect(s.getLaunch("firefox-screen")!.persona).toMatchObject({ screenWidth: 2560, screenHeight: 1440 });
    s.clearLaunch("firefox-screen");
    const saved = s.getProfile("firefox-screen")!;
    expect([saved.screenWidth, saved.screenHeight]).toEqual([1366, 768]);
    expect(saved.firefox!.config).toMatchObject({
        "screen.width": 1366, "screen.height": 768, "screen.availWidth": 1366, "screen.availHeight": 720,
        "window.outerWidth": 888, "window.outerHeight": 691, "window.innerWidth": 872, "window.innerHeight": 585, timezone: "UTC",
    });
    s.close();
});
test("a malformed nonblank proxy edit is rejected without removing the existing proxy", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "America/Los_Angeles";
    s.upsertProfile(before);
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { proxy: "proxy.example:not-a-port" } }),
    }), {} as any, s);
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toContain("invalid proxy port");
    const after = s.getProfile("k1d0cd11")!;
    expect(after.proxy).toEqual(before.proxy);
    expect(after.timezone).toBe("America/Los_Angeles");
    s.close();
});
test("a changed proxy gets its exit timezone", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "America/Los_Angeles";
    s.upsertProfile(before);
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { proxyType: "socks5", proxy: "new-proxy.example:1080:user:pass" } }),
    }), {} as any, s, { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) });
    expect(res!.status).toBe(200);
    expect(calls).toEqual(EXIT_LOOKUP_CALLS);
    expect(s.getProfile("k1d0cd11")).toMatchObject({
        proxy: { type: "socks5", host: "new-proxy.example", port: "1080", user: "user", pass: "pass" },
        timezone: "Europe/Paris",
    });
    s.close();
});
test("a typed timezone stays when the proxy changes, and a blank one follows the proxy again", async () => {
    const s = store();
    const update = (set: Record<string, unknown>) => handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set }) }), {} as any, s, { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, []) });
    expect((await update({ timezone: "America/Chicago" }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "America/Chicago", timezoneManual: true });
    expect((await update({ proxyType: "http", proxy: "new-proxy.example:8080" }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "America/Chicago", timezoneManual: true });
    expect((await update({ timezone: "" }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.timezoneManual).toBeUndefined();
    expect((await update({ proxyType: "http", proxy: "other-proxy.example:8080" }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "Europe/Paris" });
    s.close();
});
test("CPU cores and the seed can be typed, and a blank count goes back to automatic", async () => {
    const s = store();
    const update = (set: Record<string, unknown>) => handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set }) }), {} as any, s);
    const seed = s.getProfile("k1d0cd11")!.fingerprintSeed;
    expect((await update({ cores: "6", fingerprintSeed: String(seed + 1) }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({ hardware: { cores: 6 }, fingerprintSeed: seed + 1 });
    expect((await update({ cores: "" }))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.hardware).toEqual(editedProfileHardware(s.getProfile("k1d0cd11")!, undefined));
    expect((await update({ cores: "0" }))!.status).toBe(500);
    expect((await update({ fingerprintSeed: "abc" }))!.status).toBe(500);
    s.close();
});
test("a proxy edit keeps changes saved during its timezone lookup", async () => {
    for (const launch of [false, true]) {
        const s = store();
        const before = s.getProfile("k1d0cd11")!;
        before.timezone = "America/Los_Angeles";
        s.upsertProfile(before);
        const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { proxyType: "http", proxy: "new-proxy.example:8080" } }),
        }), {} as any, s, { timezoneFetch: async () => {
                const updated = s.getProfile("k1d0cd11")!;
                updated.name = "renamed during lookup";
                s.upsertProfile(updated);
                if (launch)
                    s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
                return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
            } });
        expect(res!.status).toBe(200);
        expect(s.getProfile("k1d0cd11")).toMatchObject({
            name: "renamed during lookup",
            proxy: { host: "new-proxy.example" },
            // Saved for the next start also when a browser opened during the lookup.
            timezone: "Europe/Paris",
        });
        s.close();
    }
});
test("bulk proxy edits keep changes saved during the timezone lookups", async () => {
    const s = store();
    const form = new FormData();
    form.append("files", new File(["id,proxy,proxytype\nk1d0cd11,new-proxy.example:8080,http"], "updates.csv", { type: "text/csv" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s, { timezoneFetch: async () => {
            const updated = s.getProfile("k1d0cd11")!;
            updated.name = "renamed during lookup";
            s.upsertProfile(updated);
            return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
        } });
    expect(res!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({
        name: "renamed during lookup",
        proxy: { host: "new-proxy.example" },
        timezone: "Europe/Paris",
    });
    s.close();
});
test("bulk proxy edits save an open profile for its next start", async () => {
    const s = store();
    s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
    const form = new FormData();
    form.append("files", new File(["id,proxy,proxytype\nk1d0cd11,new-proxy.example:8080,http"], "updates.csv", { type: "text/csv" }));
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s, { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) });
    expect(res!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({ proxy: { host: "new-proxy.example" }, timezone: "Europe/Paris" });
    expect(s.getLaunch("k1d0cd11")).not.toBeNull();
    s.close();
});
test("an explicit timezone action updates a Local proxy timezone", async () => {
    const s = store();
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    }), {} as any, s, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, timezone: "Europe/London", locale: "en-GB" });
    expect(calls).toEqual(EXIT_LOOKUP_CALLS);
    expect(s.getProfile("k1d0cd11")!.locale).toBe("en-GB");
    expect(s.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
    s.close();
});
test("an explicit timezone action updates Firefox configuration", async () => {
    const s = store();
    s.upsertProfile(firefoxProfile(s, "firefox-timezone"));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/firefox-timezone/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    }), {} as any, s, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }) });
    expect(res!.status).toBe(200);
    expect(s.getProfile("firefox-timezone")!).toMatchObject({
        timezone: "Europe/London",
        locale: "en-GB",
        firefox: { config: { timezone: "Europe/London", "navigator.language": "en-GB", "locale:all": "en-GB, en" } },
    });
    s.close();
});
test("explicit connection timezone lookup supports system VPNs in both engines", async () => {
    for (const engine of ["chromium", "firefox"] as const) {
        const s = store();
        const profile = engine === "firefox" ? firefoxProfile(s, "vpn-profile") : { ...s.getProfile("k1d0cd11")!, id: "vpn-profile" };
        profile.proxy = null;
        profile.timezone = "UTC";
        s.upsertProfile(profile);
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles/vpn-profile/timezone", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        }), {} as any, s, { timezoneFetch: async (_url, init) => {
                expect(init).not.toHaveProperty("proxy");
                return { json: async () => ({ status: "success", timezone: "America/Toronto" }) };
            } });
        expect(response!.status).toBe(200);
        expect(await response!.json()).toMatchObject({ ok: true, timezone: "America/Toronto" });
        const saved = s.getProfile(profile.id)!;
        expect(saved.timezone).toBe("America/Toronto");
        expect(saved.fingerprintSeed).toBe(profile.fingerprintSeed);
        expect(saved.cookies).toEqual(profile.cookies);
        if (engine === "firefox")
            expect(saved.firefox!.config.timezone).toBe(saved.timezone);
        s.close();
    }
});
test("timezone lookup does not treat a quarantined proxy as a direct connection", async () => {
    const s = store();
    const profile = s.getProfile("k1d0cd11")!;
    profile.proxy = null;
    profile.proxyError = "Invalid proxy port";
    s.upsertProfile(profile);
    let calls = 0;
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {} as any, s, { timezoneFetch: async () => {
            calls++;
            return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
        } });
    expect(response!.status).toBe(400);
    expect(calls).toBe(0);
    expect(s.getProfile(profile.id)).toEqual(profile);
    s.close();
});
test("failed timezone lookups report failure without changing the saved identity", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "Europe/Paris";
    s.upsertProfile(before);
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {} as any, s, { timezoneFetch: async () => { throw new Error("offline"); } });
    expect(response!.status).toBe(502);
    expect(await response!.json()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(s.getProfile(before.id)).toEqual(before);
    s.close();
});
test("timezone lookup cannot overwrite a changed connection or unrelated edits", async () => {
    for (const changeProxy of [false, true]) {
        const s = store();
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        }), {} as any, s, { timezoneFetch: async () => {
                const updated = s.getProfile("k1d0cd11")!;
                updated.name = "edited while lookup was pending";
                if (changeProxy)
                    updated.proxy = null;
                s.upsertProfile(updated);
                return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
            } });
        expect(response!.status).toBe(changeProxy ? 409 : 200);
        expect(s.getProfile("k1d0cd11")!.name).toBe("edited while lookup was pending");
        expect(s.getProfile("k1d0cd11")!.timezone).toBe(changeProxy ? "" : "Europe/Paris");
        s.close();
    }
});
test("an explicit blank proxy edit preserves the stored timezone", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "America/Los_Angeles";
    s.upsertProfile(before);
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { proxy: "" } }),
    }), {} as any, s, { timezoneFetch: timezoneFetch({}, calls) });
    expect(res!.status).toBe(200);
    expect(calls).toEqual([]);
    expect(s.getProfile("k1d0cd11")!.proxy).toBeNull();
    expect(s.getProfile("k1d0cd11")!.timezone).toBe("America/Los_Angeles");
    s.close();
});
test("an IPv6 proxy round-trips through the edit view without losing its identity", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.proxy = { type: "socks5", host: "2001:db8::1", port: "1080", user: "user", pass: "p:ss" };
    before.timezone = "America/New_York";
    s.upsertProfile(before);
    const calls: string[][] = [];
    const detail = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
    const edit = (await detail!.json()).profile;
    expect(edit.proxy).toBe("[2001:db8::1]:1080:user:p:ss");
    const saved = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { proxy: edit.proxy, proxyType: edit.proxyType } }),
    }), {} as any, s, { timezoneFetch: timezoneFetch({}, calls) });
    expect(saved!.status).toBe(200);
    expect(calls).toEqual([]);
    expect(s.getProfile("k1d0cd11")!.proxy).toEqual(before.proxy);
    expect(s.getProfile("k1d0cd11")!.timezone).toBe("America/New_York");
    s.close();
});
test("Chrome Web Store endpoint installs once and reuses the registered extension", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
    const id = extensionId(extensionPublicKey);
    const assignmentsBefore = s.listProfiles().map((profile) => profile.extensions ?? []);
    let fetches = 0;
    const request = () => new Request("http://x/ui/api/extensions/web-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: `https://chromewebstore.google.com/detail/fixture/${id}` }),
    });
    const first = await handleUiRequest(request(), {} as any, s, {
        paths: { extensions: root } as any,
        extensionFetch: async () => { fetches++; return extensionResponse(); },
    });
    expect(first!.status).toBe(200);
    expect(await first!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: false });
    expect(s.getExtension(id)?.loadDir).toBe(join(root, id));
    expect(existsSync(join(root, id, "manifest.json"))).toBe(true);
    const second = await handleUiRequest(request(), {} as any, s, {
        paths: { extensions: root } as any,
        extensionFetch: async () => { fetches++; throw new Error("must not fetch again"); },
    });
    expect(second!.status).toBe(200);
    expect(await second!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: true });
    expect(fetches).toBe(1);
    expect(s.listProfiles().map((profile) => profile.extensions ?? [])).toEqual(assignmentsBefore);
    s.close();
});
test("Chrome Web Store endpoint leaves no registry or files after identity failure", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
    const requestedId = "a".repeat(32);
    expect(requestedId).not.toBe(extensionId(extensionPublicKey));
    const response = await handleUiRequest(new Request("http://x/ui/api/extensions/web-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: requestedId }),
    }), {} as any, s, {
        paths: { extensions: root } as any,
        extensionFetch: async () => extensionResponse(),
    });
    expect(response!.status).toBe(500);
    expect(s.getExtension(requestedId)).toBeNull();
    expect(existsSync(join(root, requestedId))).toBe(false);
    s.close();
});
test("Chrome Web Store endpoint rejects cross-origin simple requests", async () => {
    const s = store();
    let fetches = 0;
    const response = await handleUiRequest(new Request("http://x/ui/api/extensions/web-store", {
        method: "POST",
        headers: {
            "Content-Type": "text/plain",
            Origin: "https://example.com",
        },
        body: JSON.stringify({ source: extensionId(extensionPublicKey) }),
    }), {} as any, s, {
        extensionFetch: async () => {
            fetches++;
            return extensionResponse();
        },
    });
    expect(response!.status).toBe(415);
    expect(fetches).toBe(0);
    expect(s.listExtensions()).toEqual([]);
    s.close();
});
test("extension assignment also saves open profiles for their next start", async () => {
    const s = store();
    const first = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...first, id: "k1d0cd22", name: "second", extensions: [] });
    s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
    s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/extensions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11", "k1d0cd22"], extensionId: "ext-one", op: "add" }),
    }), {} as any, s);
    expect(res!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["ext-one"]);
    expect(s.getProfile("k1d0cd22")!.extensions).toEqual(["ext-one"]);
    s.close();
});
test("extension deletion cannot mutate the persona of an open profile", async () => {
    const s = store();
    s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
    expect(s.assignExtension(["k1d0cd11"], "ext-one", true)).toBe(1);
    s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
    const res = await handleUiRequest(new Request("http://x/ui/api/extensions/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ext-one" }),
    }), {} as any, s);
    expect(res!.status).toBe(409);
    expect(s.getExtension("ext-one")).not.toBeNull();
    expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["ext-one"]);
    s.close();
});
test("closed fingerprint edits persist and preserve the rest of the identity", async () => {
    for (const engine of ["chromium", "firefox"] as const) {
        const s = store();
        const id = engine === "firefox" ? "firefox-edit" : "k1d0cd11";
        if (engine === "firefox")
            s.upsertProfile(firefoxProfile(s, id));
        const before = s.getProfile(id)!;
        const calls: string[][] = [];
        for (const timezone of ["Europe/Paris", ""]) {
            const set = { timezone, proxy: "next-proxy.example:8080", ...(engine === "chromium" ? { platformOs: "macos", resolution: "1920x1080" } : {}) };
            const res = await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}/update`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set }),
            }), {} as any, s, { timezoneFetch: timezoneFetch({}, calls) });
            expect(res!.status).toBe(200);
            const saved = s.getProfile(id)!;
            expect(saved.timezone).toBe(timezone);
            expect(saved.locale).toBe(before.locale);
            expect(saved.cookies).toEqual(before.cookies);
            expect(saved.fingerprintSeed).toBe(before.fingerprintSeed);
            expect(saved.ua).toBe(before.ua);
            if (engine === "firefox") {
                const { timezone: _timezone, ...config } = before.firefox!.config;
                expect(saved.firefox!.config).toEqual({ ...config, ...(timezone ? { timezone } : {}) });
            }
            else {
                expect(saved).toMatchObject({ platformOs: "macos", screenWidth: 1920, screenHeight: 1080 });
                const flags = deriveFingerprintFlags(saved);
                expect(flags).toContain("--fingerprint-platform=macos");
                expect(flags).toContain("--fingerprint-screen-width=1920");
                expect(flags.filter((flag) => flag.startsWith("--fingerprint-timezone="))).toEqual(timezone ? [`--fingerprint-timezone=${timezone}`] : []);
            }
            const detail = await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}`), {} as any, s);
            expect((await detail!.json()).profile.timezone).toBe(timezone);
        }
        expect(calls).toEqual([]);
        s.close();
    }
});
test("Firefox rejects OS edits and invalid timezone edits leave the profile unchanged", async () => {
    const s = store();
    s.upsertProfile(firefoxProfile(s, "firefox-edit"));
    const before = s.getProfile("firefox-edit");
    for (const set of [{ platformOs: "macos" }, { timezone: "Europe/Not_A_Zone" }]) {
        const res = await handleUiRequest(new Request("http://x/ui/api/profiles/firefox-edit/update", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set }),
        }), {} as any, s);
        expect((await res!.json()).ok).toBe(false);
        expect(s.getProfile("firefox-edit")).toEqual(before);
    }
    s.close();
});
test("timezone lookup of an open profile saves the timezone for its next start", async () => {
    const s = store();
    s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1, persona: launchPersona(s.getProfile("k1d0cd11")!) });
    const calls: string[][] = [];
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {} as any, s, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, timezone: "Europe/London", restartRequired: true });
    s.close();
});
test("mobile persona conversion preserves the account and replaces only incoherent device fields", async () => {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36";
    before.screenWidth = 412;
    before.screenHeight = 915;
    before.timezone = "America/New_York";
    before.tags = ["priority"];
    before.extensions = ["ext-one"];
    s.upsertProfile(before);
    const detail = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
    const edit = (await detail!.json()).profile;
    expect(edit.mobilePersona).toBe(true);
    expect(edit.desktopConversion.platform).toBe("windows");
    expect(edit.desktopConversion.screenChanged).toBe(true);
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }), {} as any, s);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toMatchObject({ ok: true, changed: true, platform: "windows", screenChanged: true });
    const after = s.getProfile("k1d0cd11")!;
    expect(after.ua).toContain("Windows NT 10.0");
    expect(after.ua.toLowerCase()).not.toContain("mobile");
    expect(after.screenWidth).toBeGreaterThanOrEqual(1024);
    for (const key of ["id", "accId", "username", "password", "email", "emailPassword", "twofa", "proxy", "timezone", "fingerprintSeed", "cookies", "seeded", "tags", "extensions"] as const) {
        expect(after[key]).toEqual(before[key]);
    }
    s.close();
});
test("mobile persona conversion is idempotent and refuses local mutation while open", async () => {
    const s = store();
    const p = s.getProfile("k1d0cd11")!;
    p.ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148";
    s.upsertProfile(p);
    s.recordLaunch({ profileId: p.id, pid: 123, debugPort: 9333, ws: "ws://live", startedAt: 1 });
    const blocked = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }), {} as any, s);
    expect(blocked!.status).toBe(409);
    expect(s.getProfile(p.id)!.ua).toContain("iPhone");
    s.clearLaunch(p.id);
    const converted = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }), {} as any, s);
    expect((await converted!.json()).platform).toBe("macos");
    const repeated = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }), {} as any, s);
    expect(await repeated!.json()).toEqual({ ok: true, changed: false });
    s.close();
});
test("bulk updates also change open profiles", async () => {
    const s = store();
    const first = s.getProfile("k1d0cd11")!;
    s.upsertProfile({ ...first, id: "k1bulk02", name: "second-before" });
    s.recordLaunch({ profileId: "k1bulk02", pid: 123, debugPort: 9334, ws: "ws://live", startedAt: 1 });
    const form = new FormData();
    form.append("file", new File([
        [
            "id,name",
            "k1d0cd11,first-after",
            "k1bulk02,second-after",
        ].join("\n"),
    ], "updates.csv", { type: "text/csv" }));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s);
    expect(res!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.name).toBe("first-after");
    expect(s.getProfile("k1bulk02")!.name).toBe("second-after");
    expect(s.getLaunch("k1bulk02")).not.toBeNull();
    s.close();
});
test("create (local mode) sets the timezone from the proxy", async () => {
    for (const engine of ["chromium", "firefox"] as const) {
        const s = new ProfileStore(":memory:");
        const calls: string[][] = [];
        const res = await handleUiRequest(new Request("http://x/ui/api/profiles", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine, name: "fresh", proxy: { type: "http", host: "new-proxy.example", port: "8080" } }),
        }), {} as any, s, { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) });
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(calls).toEqual(EXIT_LOOKUP_CALLS);
        const saved = s.getProfile(body.id)!;
        expect(saved).toMatchObject({ timezone: "Europe/Paris", locale: "fr-FR" });
        if (engine === "firefox")
            expect(saved.firefox!.config.timezone).toBe("Europe/Paris");
        s.close();
    }
});
test("create (local mode) keeps the host timezone when the proxy lookup fails", async () => {
    const s = new ProfileStore(":memory:");
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "fresh", proxy: { type: "http", host: "new-proxy.example", port: "8080" } }),
    }), {} as any, s, { timezoneFetch: async () => { throw new Error("offline"); } });
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(s.getProfile(body.id)!.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    s.close();
});
test("blank Local creation and edit do not request timezones for either browser", async () => {
    for (const engine of ["chromium", "firefox"] as const) {
        const s = new ProfileStore(":memory:");
        const calls: string[][] = [];
        const created = await handleUiRequest(new Request("http://x/ui/api/profiles", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine }),
        }), {} as any, s, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) });
        const body = await created!.json();
        expect(body.ok).toBe(true);
        expect(calls).toEqual([]);
        const edited = await handleUiRequest(new Request(`http://x/ui/api/profiles/${body.id}/update`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { name: `${engine}-edited` } }),
        }), {} as any, s, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) });
        expect((await edited!.json()).ok).toBe(true);
        expect(calls).toEqual([]);
        expect(s.getProfile(body.id)).toMatchObject({ engine, name: `${engine}-edited` });
        s.close();
    }
});
test("create (local mode) adds a new profile", async () => {
    const s = new ProfileStore(":memory:");
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "fresh", group: "g" }) }), {} as any, s);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(s.getProfile(body.id)!.name).toBe("fresh");
    s.close();
});
test("creating a Firefox profile starts the background download of its font pack", async () => {
    const s = new ProfileStore(":memory:");
    const prefetched: Profile[][] = [];
    const launcher = { prefetchFirefoxFontPacks: (profiles: Profile[]) => { prefetched.push(profiles); } } as any;
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mac", engine: "firefox", platformOs: "macos" }) }), launcher, s);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(prefetched.map((profiles) => profiles.map((profile) => [profile.id, profile.engine, profile.platformOs])))
        .toEqual([[[body.id, "firefox", "macos"]]]);
    s.close();
});
test("local-mode streamed export reports progress after each profile", async () => {
    const s = store();
    s.upsertProfile({ ...s.getProfile("k1d0cd11")!, id: "local0002", name: "second" });
    const captured: string[] = [];
    const launcher = { async captureLocalSession(id: string) { captured.push(id); return false; } } as any;
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/export", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11", "local0002"], format: "txt", stream: true }),
    }), launcher, s);
    const records = (await response!.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.type === "progress").map((record) => record.completed)).toEqual([0, 1, 2]);
    const file = records.at(-1)!;
    expect(file.type).toBe("file");
    const text = Buffer.from(file.data, "base64").toString("utf8");
    expect(parseExport(text).profiles.map((profile) => profile.id)).toEqual(["k1d0cd11", "local0002"]);
    expect(captured).toEqual(["k1d0cd11", "local0002"]);
    s.close();
});
test("export as xlsx returns a workbook carrying the full identity", async () => {
    const s = store();
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/export", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"], format: "xlsx" }),
    }), new Launcher({ store: s }), s, null as any);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-disposition")).toContain("aliasmode-export.xlsx");
    expect(res!.headers.get("content-type")).toContain("spreadsheetml.sheet");
    const rows = await readXlsx(new Uint8Array(await res!.arrayBuffer()));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("k1d0cd11");
    expect(rows[0]!.proxy).toBe("1.2.3.4:8080:proxyuser:PROXYPASS");
    expect(rows[0]!.resolution).toBe("1680*1050");
    // The identity the export exists to move: cookies and the user-agent.
    expect(JSON.parse(rows[0]!.cookie!)[0].name).toBe("auth_token");
    expect(rows[0]!.ua).toContain("Chrome/143.0.0.0");
    s.close();
});
test("update-file accepts an edited .xlsx and applies only editable columns", async () => {
    const s = store();
    const book = await writeXlsx(["id", "name", "group", "cookie"], [["k1d0cd11", "renamed", "NewGroup", "[]"]]);
    const form = new FormData();
    form.append("files", new File([book as unknown as BlobPart], "edited.xlsx"));
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }), {} as any, s, null as any);
    const body = (await res!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(1);
    const p = s.getProfile("k1d0cd11")!;
    expect(p.name).toBe("renamed");
    expect(p.group).toBe("NewGroup");
    // Identity columns stay inert on re-upload, exactly as for .txt and .csv.
    expect(p.cookies).toHaveLength(1);
    s.close();
});
test("delete (standalone) blocks an open profile without stopping it or removing its data", async () => {
    const s = store();
    const dataRoot = join("/tmp", `ui-del-${process.pid}-${s.count()}`);
    const launcher: any = {
        cacheCleanupSettled: async () => { },
        profileDeletionBlocked: () => true,
        stop: async () => { throw new Error("must not stop an open profile during delete"); },
        removeUserDataDir: () => { throw new Error("must not remove an open profile"); },
    };
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
    const dir = join(dataRoot, "k1d0cd11");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cookies"), "logged-in");
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"] }) }), launcher, s);
    const body = await res!.json();
    expect(res!.status).toBe(409);
    expect(body).toMatchObject({ ok: false, deleted: 0, locked: ["k1d0cd11"] });
    expect(existsSync(dir)).toBe(true);
    expect(s.getProfile("k1d0cd11")).not.toBeNull();
    rmSync(dataRoot, { recursive: true, force: true });
    s.close();
});
test("delete (standalone) keeps a mixed open and closed selection atomic", async () => {
    const s = store();
    const closedId = "closed001";
    s.upsertProfile({ ...s.getProfile("k1d0cd11")!, id: closedId, name: "closed" });
    const dataRoot = join("/tmp", `ui-del-mixed-${process.pid}-${s.count()}`);
    const openDir = join(dataRoot, "k1d0cd11");
    const closedDir = join(dataRoot, closedId);
    mkdirSync(openDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
    writeFileSync(join(openDir, "Cookies"), "open");
    writeFileSync(join(closedDir, "Cookies"), "closed");
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
    const launcher: any = {
        cacheCleanupSettled: async () => { },
        profileDeletionBlocked: (id: string) => id === "k1d0cd11",
        stop: async () => { throw new Error("must not stop profiles during delete"); },
        removeUserDataDir: () => { throw new Error("must not mutate a blocked batch"); },
    };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [closedId, "k1d0cd11"] }),
    }), launcher, s);
    expect(res!.status).toBe(409);
    expect(await res!.json()).toMatchObject({ deleted: 0, locked: ["k1d0cd11"] });
    expect(s.getProfile(closedId)).not.toBeNull();
    expect(s.getProfile("k1d0cd11")).not.toBeNull();
    expect(existsSync(closedDir)).toBe(true);
    expect(existsSync(openDir)).toBe(true);
    rmSync(dataRoot, { recursive: true, force: true });
    s.close();
});
test("delete (standalone) trashes a closed profile without calling stop or removing data", async () => {
    const s = store();
    const calls: string[] = [];
    const launcher: any = {
        cacheCleanupSettled: async () => { },
        profileDeletionBlocked: () => false,
        stop: async () => { throw new Error("delete must not stop a profile"); },
        removeUserDataDir: (id: string) => { calls.push(id); return true; },
    };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"] }) }), launcher, s);
    expect(await res!.json()).toMatchObject({ ok: true, deleted: 1, locked: [] });
    expect(calls).toEqual([]);
    expect(s.getProfile("k1d0cd11")).toBeNull();
    expect(s.listTrashed().map((p) => p.id)).toEqual(["k1d0cd11"]);
    s.close();
});
test("delete (standalone) keeps recoverable data without cleanup and is idempotent", async () => {
    const s = store();
    const launcher: any = {
        cacheCleanupSettled: async () => { },
        profileDeletionBlocked: () => false,
        removeUserDataDir: () => { throw new Error("Trash must not clean up saved data"); },
    };
    const request = () => new Request("http://x/ui/api/profiles/delete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["k1d0cd11"] }),
    });
    const first = await handleUiRequest(request(), launcher, s);
    expect(first!.status).toBe(200);
    expect(await first!.json()).toMatchObject({ ok: true, deleted: 1 });
    const retried = await handleUiRequest(request(), launcher, s);
    expect(retried!.status).toBe(200);
    expect(await retried!.json()).toMatchObject({ ok: true, deleted: 0 });
    expect(s.listTrashed()).toHaveLength(1);
    expect(s.restoreProfile("k1d0cd11")).toBe(true);
    expect(s.getProfile("k1d0cd11")).not.toBeNull();
    s.close();
});
test("delete with an unknown id never touches the launcher (no rmSync on a crafted path)", async () => {
    const s = store();
    const launcher: any = {
        stop: async () => { throw new Error("must not be called"); },
        userDataDir: () => { throw new Error("must not be called"); },
    };
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["../../etc"] }) }), launcher, s);
    expect((await res!.json()).deleted).toBe(0);
    s.close();
});
test("handleUiRequest returns null for non-ui paths (falls through to the AdsPower API)", async () => {
    const s = store();
    const res = await handleUiRequest(new Request("http://x/api/v1/status"), {} as any, s);
    expect(res).toBeNull();
    s.close();
});
test("app mode API exposes a local-only first launch and persists Local selection", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
    const appConfig = new AppConfigStore(join(root, "config.json"));
    const initial = await handleUiRequest(new Request("http://x/ui/api/app-mode"), {} as any, s, { appConfig });
    const { chromiumRuntime: _forcedRuntime, defaultChromiumRuntime, defaultEngine, ...config } = await initial!.json();
    expect(config).toEqual({ version: 1, mode: "local", localOnly: true, localAnalytics: false, restartRequired: false });
    // Auto must describe the same runtime policy used by the new-profile builder.
    expect(defaultChromiumRuntime).toBe(defaultRuntimePolicy());
    // New profiles start on AliasMode Chromium on Windows and AliasMode Firefox on macOS and Linux.
    expect(defaultEngine).toBe(process.platform === "win32" ? "chromium" : "firefox");
    const selected = await handleUiRequest(new Request("http://x/ui/api/app-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "local" }),
    }), {} as any, s, { appConfig });
    expect(await selected!.json()).toEqual({
        ok: true,
        config: { version: 1, mode: "local", localAnalytics: false },
        restartRequired: false,
    });
    expect(appConfig.read().mode).toBe("local");
    s.close();
});
test("app mode Auto matches actual profile creation across Windows and Mac runtime policies", async () => {
    const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!;
    const archProperty = Object.getOwnPropertyDescriptor(process, "arch")!;
    const hadBinary = Object.hasOwn(process.env, "CLOAKBROWSER_BINARY_PATH"), originalBinary = process.env.CLOAKBROWSER_BINARY_PATH;
    const forbidden = new Proxy({}, { get() { throw new Error("App mode policy must not access profiles or launch browsers"); } });
    const cases: Array<{ platform: NodeJS.Platform; arch: string; binary?: string; expected?: "aliasmode"; forced?: "aliasmode"; defaultEngine: string }> = [
        { platform: "win32", arch: "x64", expected: "aliasmode", defaultEngine: "chromium" },
        { platform: "win32", arch: "x64", binary: "C:\\inert-config\\chrome.exe", expected: "aliasmode", defaultEngine: "chromium" },
        { platform: "darwin", arch: "arm64", expected: "aliasmode", forced: "aliasmode", defaultEngine: "firefox" },
        { platform: "darwin", arch: "arm64", binary: "/inert-config/cloakbrowser", defaultEngine: "firefox" },
        { platform: "darwin", arch: "x64", defaultEngine: "firefox" },
        { platform: "linux", arch: "x64", expected: "aliasmode", defaultEngine: "firefox" },
    ];
    try {
        for (const scenario of cases) {
            Object.defineProperty(process, "platform", { ...platformProperty, value: scenario.platform });
            Object.defineProperty(process, "arch", { ...archProperty, value: scenario.arch });
            if (scenario.binary) process.env.CLOAKBROWSER_BINARY_PATH = scenario.binary; else delete process.env.CLOAKBROWSER_BINARY_PATH;
            const result = await handleUiRequest(new Request("http://127.0.0.1/ui/api/app-mode"), forbidden as any, forbidden as any);
            expect(result?.status).toBe(200);
            const config = await result!.json(), profile = buildNewProfile({ engine: "chromium" }, () => false);
            expect(config.defaultChromiumRuntime).toBe(scenario.expected);
            expect(config.defaultChromiumRuntime).toBe(profile.chromiumRuntime);
            expect(Object.hasOwn(config, "defaultChromiumRuntime")).toBe(scenario.expected !== undefined);
            expect(config.chromiumRuntime).toBe(scenario.forced);
            expect(config.defaultEngine).toBe(scenario.defaultEngine);
            expect(JSON.stringify(config)).not.toContain("inert-config");
        }
    } finally {
        Object.defineProperty(process, "platform", platformProperty); Object.defineProperty(process, "arch", archProperty);
        if (hadBinary && originalBinary !== undefined) process.env.CLOAKBROWSER_BINARY_PATH = originalBinary; else delete process.env.CLOAKBROWSER_BINARY_PATH;
    }
});
test("runtime downloads route lists each download in progress with the bytes of its part", async () => {
    const s = store();
    const read = async () => {
        const response = await handleUiRequest(new Request("http://x/ui/api/runtime-downloads"), {} as any, s);
        expect(response!.headers.get("cache-control")).toBe("no-store");
        return response!.json();
    };
    expect(await read()).toEqual({ downloads: [] });
    const dir = mkdtempSync(join(tmpdir(), "aliasmode-runtime-download-"));
    const partial = join(dir, "runtime.part");
    const unknownPartial = join(dir, "unknown-runtime.part");
    writeFileSync(partial, "x".repeat(42));
    writeFileSync(unknownPartial, "x".repeat(13));
    let finish!: () => void, finishUnknown!: () => void;
    const download = trackRuntimeDownload("aliasmode", partial, 100, () => new Promise<void>((resolve) => { finish = resolve; }));
    const unknown = trackRuntimeDownload("firefox", unknownPartial, 0, () => new Promise<void>((resolve) => { finishUnknown = resolve; }));
    try {
      expect(await read()).toEqual({ downloads: [{ runtime: "aliasmode", receivedBytes: 42, totalBytes: 100 }, { runtime: "firefox", receivedBytes: 13, totalBytes: 0 }] });
      writeFileSync(unknownPartial, "x".repeat(27));
      expect((await read()).downloads[1]).toEqual({ runtime: "firefox", receivedBytes: 27, totalBytes: 0 });
    } finally {
      finish(); finishUnknown();
      await Promise.all([download, unknown]);
      rmSync(dir, { recursive: true, force: true });
      s.close();
    }
    expect(await read()).toEqual({ downloads: [] });
});
test("app mode API rejects cross-origin JSON requests", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
    const appConfig = new AppConfigStore(join(root, "config.json"));
    const response = await handleUiRequest(new Request("http://x/ui/api/app-mode", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ mode: "local" }),
    }), {} as any, s, { appConfig });
    expect(response!.status).toBe(403);
    expect(appConfig.read().mode).toBe("local");
    s.close();
});
test("app mode API rejects cross-site simple requests", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
    const appConfig = new AppConfigStore(join(root, "config.json"));
    const response = await handleUiRequest(new Request("http://x/ui/api/app-mode", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://attacker.example" },
        body: JSON.stringify({ mode: "local" }),
    }), {} as any, s, { appConfig });
    expect(response!.status).toBe(415);
    expect(appConfig.read().mode).toBe("local");
    s.close();
});
test("the roster carries each profile's serial and custom NO.", () => {
    const s = store();
    const [before] = listUiProfiles(s);
    expect(before!.serial).toBe(s.getSerial("k1d0cd11")!);
    expect(before!.customNo).toBe(""); // unset -> the UI falls back to the serial
    s.upsertProfile({ ...s.getProfile("k1d0cd11")!, customNo: "907341" });
    expect(listUiProfiles(s)[0]!.customNo).toBe("907341");
    s.close();
});
test("editing a custom NO. validates digits and survives a reopen of the editor", async () => {
    const s = store();
    const save = (customNo: string) => handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { customNo } }),
    }), {} as any, s);
    expect((await save("4421"))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421");
    const view = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
    expect((await view!.json()).profile.customNo).toBe("4421");
    const rejected = await save("44-21");
    expect(rejected!.status).toBe(500);
    expect((await rejected!.json()).error).toContain("digits only");
    expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421"); // rejected edit changed nothing
    expect((await save(""))!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")!.customNo).toBe("");
    s.close();
});
test("creating a profile stores the credentials supplied with it", async () => {
    const s = store();
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
            username: "fresh_user", password: "fresh-pass",
            email: "fresh@example.com", emailPassword: "mailbox-pass",
            twofa: "JBSWY3DPEHPK3PXP",
        }),
    }), {} as any, s);
    const { ok, id } = await response!.json();
    expect(ok).toBe(true);
    // The create endpoint has always accepted these; this pins that the dialog is
    // not the only thing that can set them and that none are silently dropped.
    expect(s.getProfile(id)).toMatchObject({
        name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
        username: "fresh_user", password: "fresh-pass",
        email: "fresh@example.com", emailPassword: "mailbox-pass",
        twofa: "JBSWY3DPEHPK3PXP",
    });
    s.close();
});
test("the dashboard profile payload carries a redacted recomputed import comparison alongside the legacy verdict", () => {
    const s = store();
    s.upsertProfile({ ...s.getProfile("k1d0cd11")!, fpExpected: { canvas: "a3f19c8e" } });
    s.saveObservedFingerprint("k1d0cd11", { canvas: "deadbeef", capturedAt: "2026-08-29T11:04:22Z" }, { verdict: "mismatch", differences: [{ field: "canvas", expected: "a3f19c8e", observed: "deadbeef" }] });
    const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
    expect(row.fpVerdict!.verdict).toBe("mismatch");
    expect(row.fpVerdict!.differences[0]!.field).toBe("canvas");
    expect(row.fpCapturedAt).toBe("2026-08-29T11:04:22Z");
    expect(row.fpImportComparison).toEqual({ expectedCount: 1, comparedCount: 1, matchedCount: 0, differenceFields: ["canvas"], missingFields: [], capturedAt: "2026-08-29T11:04:22.000Z" });
    expect(JSON.stringify(row.fpImportComparison)).not.toContain("a3f19c8e");
    expect(JSON.stringify(row.fpImportComparison)).not.toContain("deadbeef");
    s.close();
});
test("a profile that has never been probed carries no verdict", () => {
    const s = store();
    const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
    expect(row.fpVerdict).toBeNull();
    expect(row.fpCapturedAt).toBe("");
    expect(row.fpImportComparison).toBeNull();
    s.close();
});
test("the roster never promotes an empty or incomplete legacy stored match into a full import match", async () => {
    const s = store();
    try {
        s.saveObservedFingerprint("k1d0cd11", { canvas: "PRIVATE_SAMPLE", capturedAt: "PRIVATE_TIME" }, { verdict: "match", differences: [] });
        expect(listUiProfiles(s)[0]!.fpImportComparison).toBeNull();
        s.upsertProfile({ ...s.getProfile("k1d0cd11")!, fpExpected: { canvas: "PRIVATE_SAMPLE", audio: "PRIVATE_MISSING" } });
        expect(listUiProfiles(s)[0]!.fpImportComparison).toEqual({ expectedCount: 2, comparedCount: 1, matchedCount: 1, differenceFields: [], missingFields: ["audio"] });
        const malformed = { toString: 0, valueOf: 0 };
        s.upsertProfile({
            ...s.getProfile("k1d0cd11")!, id: "legacy-bad-sample",
            fpExpected: { canvas: "fixture", audio: malformed, hardwareConcurrency: 8 } as unknown as Profile["fpExpected"],
            fpObserved: { canvas: malformed, audio: "fixture", hardwareConcurrency: "8" } as unknown as Profile["fpObserved"],
        });
        const launcher = { reconcileOrphans: async () => {} } as unknown as Launcher;
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
        expect(response!.status).toBe(200);
        const roster = await response!.json() as { profiles: ReturnType<typeof listUiProfiles> };
        expect(roster.profiles).toHaveLength(2);
        expect(roster.profiles.find(p => p.id === "legacy-bad-sample")?.fpImportComparison).toEqual({
            expectedCount: 2, comparedCount: 1, matchedCount: 1, differenceFields: [], missingFields: ["canvas"],
        });
    } finally { s.close(); }
});
test("roster import summaries reuse the bulk profile mapping without per-profile provenance or IO calls", () => {
    const s = store();
    try {
        s.upsertProfile({ ...s.getProfile("k1d0cd11")!, fpExpected: { canvas: "PRIVATE" }, fpObserved: { canvas: "PRIVATE" } });
        const calls: string[] = [];
        const allowed = new Set(["listLaunches", "listProfileMeta", "pendingCookieCounts", "listProfiles"]);
        const bulkOnly = new Proxy(s, { get(target, property) {
            const name = String(property); calls.push(name);
            if (!allowed.has(name)) throw new Error("The roster must not add provenance, liveness or per-profile IO");
            return (target as any)[property].bind(target);
        } });
        expect(listUiProfiles(bulkOnly)[0]!.fpImportComparison).toMatchObject({ expectedCount: 1, comparedCount: 1, matchedCount: 1 });
        expect(calls).toEqual(["listLaunches", "listProfileMeta", "pendingCookieCounts", "listProfiles"]);
    } finally { s.close(); }
});
test("shell-language round-trips through the server and rejects invalid tags", async () => {
    const s = store();
    const root = mkdtempSync(join(tmpdir(), "shell-lang-"));
    const paths = { root } as any;
    const call = (req: Request) => handleUiRequest(req, {} as any, s, { paths });
    // Nothing stored yet: null, so the UI follows the system language.
    let res = await call(new Request("http://x/ui/api/shell-language"));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ language: null });
    // Store Chinese, read it back.
    res = await call(new Request("http://x/ui/api/shell-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: "zh-CN" }),
    }));
    expect(await res!.json()).toMatchObject({ ok: true, language: "zh-CN" });
    res = await call(new Request("http://x/ui/api/shell-language"));
    expect(await res!.json()).toEqual({ language: "zh-CN" });
    expect(existsSync(join(root, "shell.json"))).toBe(true);
    // Invalid tags fall back to English instead of being stored.
    res = await call(new Request("http://x/ui/api/shell-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: "../../etc/passwd" }),
    }));
    expect(await res!.json()).toMatchObject({ ok: true, language: "en-US" });
    res = await call(new Request("http://x/ui/api/shell-language"));
    expect(await res!.json()).toEqual({ language: "en-US" });
    s.close();
    rmSync(root, { recursive: true, force: true });
});
test("retired hosted fingerprint checks never navigate a running profile to an author website", async () => {
    const s = store();
    s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
    const opened: Array<{
        ws: string;
        urls: string[];
        replace: boolean;
    }> = [];
    let active = true;
    const launcher = {
        certifiedActive: async () => active,
        navigate: async (ws: string, urls: string[], replace: boolean) => { opened.push({ ws, urls, replace }); },
    } as any;
    const request = (page: unknown) => handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/check-fingerprint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page }),
    }), launcher, s, {} as any);
    expect((await request("ru"))!.status).toBe(410);
    expect((await request("https://evil.invalid/"))!.status).toBe(410);
    expect(opened).toEqual([]);
    active = false;
    const closed = await request("en");
    expect(closed!.status).toBe(410);
    expect(opened).toHaveLength(0);
    s.close();
});

test("tags-only edits normalize labels without reading credentials or changing browser identity", async () => {
    const s = store();
    try {
        const before = s.getProfile("k1d0cd11")!;
        let networkCalls = 0;
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ set: { tags: [" Work ", "work", "e\u0301", "é"] } }),
        }), {} as Launcher, s, { timezoneFetch: async () => { networkCalls++; throw new Error("Unexpected network call"); } });
        expect(response!.status).toBe(200);
        expect(await response!.json()).toEqual({ ok: true });
        expect(s.getProfile("k1d0cd11")).toEqual({ ...before, tags: ["Work", "é"] });
        expect(networkCalls).toBe(0);
    } finally { s.close(); }
});

test("invalid tags return a bounded validation error and leave the complete profile untouched", async () => {
    const s = store();
    try {
        const before = s.getProfile("k1d0cd11")!;
        for (const tags of [["SECRET\u0000tag"], ["x".repeat(41)], Array.from({ length: 21 }, (_, index) => String(index)), [42], null]) {
            const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ set: { name: "Must not persist", tags } }),
            }), {} as Launcher, s);
            expect(response!.status).toBe(400);
            const result = await response!.json();
            expect(result.ok).toBe(false);
            expect(result.error).not.toContain("SECRET");
            expect(s.getProfile("k1d0cd11")).toEqual(before);
        }
    } finally { s.close(); }
});

test("a tags-only empty list clears labels and preserves all other fields", async () => {
    const s = store();
    try {
        const existing = s.getProfile("k1d0cd11")!;
        existing.tags = ["Existing"];
        s.upsertProfile(existing);
        const before = s.getProfile("k1d0cd11")!;
        const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/update", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { tags: [] } }),
        }), {} as Launcher, s);
        expect(response!.status).toBe(200);
        expect(s.getProfile("k1d0cd11")).toEqual({ ...before, tags: [] });
    } finally { s.close(); }
});

test(":id routes return 400 JSON on malformed percent-encoding and unsafe profile ids", async () => {
    const s = store();
    try {
        const routes: Array<[string, RequestInit?]> = [
            ["/ui/api/profiles/%ZZ"],
            ["/ui/api/profiles/%ZZ/totp"],
            ["/ui/api/profiles/%ZZ/pending-cookies"],
            ["/ui/api/profiles/%ZZ/open", { method: "POST" }],
            ["/ui/api/profiles/%ZZ/raise", { method: "POST" }],
            ["/ui/api/profiles/%ZZ/convert-mobile", { method: "POST" }],
            ["/ui/api/profiles/%ZZ/update", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
            ["/ui/api/profiles/CON"],
            ["/ui/api/profiles/CON/totp"],
            ["/ui/api/profiles/..%2Fevil/open", { method: "POST" }],
            ["/ui/api/profiles/_bad/raise", { method: "POST" }],
        ];
        for (const [path, init] of routes) {
            const res = await handleUiRequest(new Request(`http://x${path}`, init), {} as Launcher, s);
            expect(res!.status).toBe(400);
            expect((await res!.json()).ok).toBe(false);
            expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
            expect(res!.headers.get("x-frame-options")).toBe("DENY");
            expect(res!.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        }
    } finally { s.close(); }
});

test("mutating JSON POST routes reject non-JSON Content-Type (415) and cross-origin requests (403) before modifying state", async () => {
    const s = store();
    try {
        const beforeCount = s.count();
        const beforeName = s.getProfile("k1d0cd11")!.name;
        const cases: Array<[string, unknown]> = [
            ["/ui/api/profiles", { name: "csrf-profile" }],
            ["/ui/api/profiles/move", { ids: ["k1d0cd11"], group: "csrf" }],
            ["/ui/api/profiles/delete", { ids: ["k1d0cd11"] }],
            ["/ui/api/profiles/k1d0cd11/update", { set: { name: "hacked" } }],
            ["/ui/api/profiles/extensions", { ids: ["k1d0cd11"], extensionId: "ext1", op: "add" }],
            ["/ui/api/groups/create", { name: "csrf-group" }],
            ["/ui/api/groups/rename", { from: "g", to: "csrf" }],
            ["/ui/api/groups/delete", { name: "g" }],
            ["/ui/api/extensions/delete", { id: "ext1" }],
            ["/ui/api/shell-language", { language: "zh-CN" }],
        ];
        for (const [path, payload] of cases) {
            const noCt = await handleUiRequest(new Request(`http://x${path}`, {
                method: "POST",
                body: JSON.stringify(payload),
            }), {} as Launcher, s);
            expect(noCt!.status).toBe(415);

            const crossOrigin = await handleUiRequest(new Request(`http://x${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: "https://evil.example" },
                body: JSON.stringify(payload),
            }), {} as Launcher, s);
            expect(crossOrigin!.status).toBe(403);

            const crossSite = await handleUiRequest(new Request(`http://x${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
                body: JSON.stringify(payload),
            }), {} as Launcher, s);
            expect(crossSite!.status).toBe(403);
        }
        expect(s.count()).toBe(beforeCount);
        expect(s.getProfile("k1d0cd11")!.name).toBe(beforeName);
    } finally { s.close(); }
});

test("handleUiRequest routes Wave 3 proxy-vault, metrics, registered-launches, and resource-policy endpoints with security headers and event-bus integration", async () => {
    const s = store();
    const { UiEventBus } = await import("./src/ui/events-bus.ts");
    const { WorkspaceMaintenance } = await import("./workspace-maintenance.ts");
    const bus = new UiEventBus({ coalesceWindowMs: 0, store: s });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = ((type: any, payload: any) => {
        emitted.push({ type, payload });
        return origEmit(type, payload);
    }) as typeof bus.emit;
    s.onMutation = (event) => bus.handleStoreMutation(event);

    const assertSecurityHeaders = (res: Response) => {
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(res.headers.get("cache-control")).toContain("no-store");
    };

    try {
        // 1. Proxy Vault create -> list -> bind -> roster.changed SSE event
        const createRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/proxy-vault", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: "Wave3 US Residential",
                    group: "us-east",
                    type: "http",
                    host: "198.51.100.42",
                    port: 8080,
                    user: "vault-user",
                    pass: "VAULT_SECRET_PASS",
                }),
            }),
            {} as Launcher,
            s,
        );
        expect(createRes).not.toBeNull();
        expect(createRes!.status).toBe(200);
        assertSecurityHeaders(createRes!);
        const created = await createRes!.json() as { ok: boolean; id: string };
        expect(created.ok).toBe(true);
        expect(created.id).toMatch(/^pxv_[0-9a-f]{16}$/);

        const listRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/proxy-vault"),
            {} as Launcher,
            s,
        );
        expect(listRes!.status).toBe(200);
        assertSecurityHeaders(listRes!);
        const listRaw = await listRes!.text();
        expect(listRaw).not.toContain("VAULT_SECRET_PASS");
        expect(listRaw).not.toContain("endpoint_hash");
        const listBody = JSON.parse(listRaw) as { ok: boolean; items: Array<{ id: string }> };
        expect(listBody.ok).toBe(true);
        expect(listBody.items.some((item) => item.id === created.id)).toBe(true);

        emitted.length = 0;
        const bindRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/proxy-vault/bind", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ proxyIds: [created.id], profileIds: ["k1d0cd11"], mode: "single" }),
            }),
            {} as Launcher,
            s,
        );
        expect(bindRes!.status).toBe(200);
        assertSecurityHeaders(bindRes!);
        expect((await bindRes!.json() as { updated: number }).updated).toBe(1);
        expect(emitted.some((ev) => ev.type === "roster.changed")).toBe(true);

        // 2. Streaming /ui/api/proxy-vault/check carries security headers & acquires/releases workspace mutation lease
        const maintenance = new WorkspaceMaintenance();
        let leaseAcquired = 0;
        let leaseReleased = 0;
        const checkRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/proxy-vault/check", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [created.id] }),
            }),
            {} as Launcher,
            s,
            {
                workspaceManagement: {
                    isManagementPath: () => false,
                    acquireMutationLease: () => {
                        leaseAcquired++;
                        const release = maintenance.acquireMutationLease();
                        return () => {
                            leaseReleased++;
                            release();
                        };
                    },
                } as any,
                proxyVaultCheckOptions: {
                    attempts: 1,
                    endpoints: ["http://egress.test/json"],
                    relayFactory: async () => ({ port: 19999, close: () => {} }),
                    fetchDirect: async () => ({ ip: "198.51.100.1" }),
                    fetchEgress: async () => new Response(JSON.stringify({ ip: "203.0.113.42", country: "US" }), { status: 200 }),
                },
            },
        );
        expect(checkRes!.status).toBe(200);
        assertSecurityHeaders(checkRes!);
        expect(checkRes!.headers.get("content-type")).toContain("application/x-ndjson");
        const ndjsonText = await checkRes!.text();
        expect(ndjsonText).toContain("\"type\":\"done\"");
        expect(leaseAcquired).toBe(1);
        expect(leaseReleased).toBe(1);

        // 3. /ui/api/metrics/snapshot & /ui/api/windows/registered-launches with security headers
        const snapRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/metrics/snapshot"),
            {} as Launcher,
            s,
        );
        expect(snapRes!.status).toBe(200);
        assertSecurityHeaders(snapRes!);
        expect((await snapRes!.json() as { ok: boolean; snapshot: unknown }).ok).toBe(true);

        const winRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/windows/registered-launches"),
            {} as Launcher,
            s,
        );
        expect(winRes!.status).toBe(200);
        assertSecurityHeaders(winRes!);
        expect((await winRes!.json() as { ok: boolean; launches: unknown[] }).ok).toBe(true);

        // 4. Schema v3 profile_resource_policies works directly via ProfileStore.rawDatabase() fallback & cleans up on delete
        const patchPolicyRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/resource-policy", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ memorySaverMode: "on", dataSaver: { mode: "on", blockImages: true } }),
            }),
            {} as Launcher,
            s,
        );
        expect(patchPolicyRes!.status).toBe(200);
        assertSecurityHeaders(patchPolicyRes!);
        expect((await patchPolicyRes!.json() as { policy: { memorySaverMode: string } }).policy.memorySaverMode).toBe("on");

        s.deleteProfile("k1d0cd11");
        const remainingBindings = s.rawDatabase().query<{ c: number }, [string]>(
            "SELECT COUNT(*) AS c FROM profile_proxy_bindings WHERE profile_id = ?",
        ).get("k1d0cd11")!.c;
        const remainingPolicies = s.rawDatabase().query<{ c: number }, [string]>(
            "SELECT COUNT(*) AS c FROM profile_resource_policies WHERE profile_id = ?",
        ).get("k1d0cd11")!.c;
        expect(remainingBindings).toBe(0);
        expect(remainingPolicies).toBe(0);
    } finally {
        bus.closeAll();
        s.close();
    }
});

test("handleUiRequest routes Wave 4 app-lock, diagnostics, assistant proposals, .mqprofile package, timeline, and appLockAvailable capability", async () => {
    const { AppLockService } = await import("./app-lock.ts");
    const s = store();
    const home = mkdtempSync(join(tmpdir(), "maobu-w4-ui-wiring-"));
    const appLock = new AppLockService({ home });
    const assertSecurityHeaders = (res: Response) => {
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    };
    try {
        // 1. appLockAvailable is only advertised when appLock is wired
        const modeWithoutLock = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/app-mode"), {} as Launcher, s);
        expect(modeWithoutLock!.status).toBe(200);
        expect((await modeWithoutLock!.json() as { appLockAvailable?: boolean }).appLockAvailable).toBeUndefined();

        const modeWithLock = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/app-mode"), {} as Launcher, s, { appLock });
        expect(modeWithLock!.status).toBe(200);
        expect((await modeWithLock!.json() as { appLockAvailable?: boolean }).appLockAvailable).toBe(true);

        // 2. App Lock route wired
        const lockStatusRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/app-lock/status"),
            {} as Launcher,
            s,
            { appLock },
        );
        expect(lockStatusRes!.status).toBe(200);
        assertSecurityHeaders(lockStatusRes!);
        expect((await lockStatusRes!.json() as { ok: boolean; status: { enabled: boolean; locked: boolean } }).status.locked).toBe(false);

        // 3. Diagnostics route wired
        const diagRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/diagnostics/run", {
                method: "POST",
                headers: { "content-type": "application/json", "X-Maobu-Settings": "1" },
                body: JSON.stringify({ includeMcpProbe: false }),
            }),
            { dataDriveFreeBytes: () => 50 * 1024 ** 3 } as unknown as Launcher,
            s,
            { workspaceHome: home },
        );
        expect(diagRes!.status).toBe(200);
        assertSecurityHeaders(diagRes!);
        const diagBody = await diagRes!.json() as { ok: boolean; report: { checks: unknown[] } };
        expect(diagBody.ok).toBe(true);
        expect(diagBody.report.checks.length).toBe(6);

        // 4. Assistant proposals route wired (unknown proposalId -> 404 from proposal route, not unknown ui route)
        const propRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/assistant/proposals/prop_0000000000000000", {
                headers: { "X-Maobu-Settings": "1" },
            }),
            {} as Launcher,
            s,
        );
        expect(propRes!.status).toBe(404);
        assertSecurityHeaders(propRes!);
        expect((await propRes!.json() as { code?: string }).code).toBe("proposal_not_found");

        // 5. Profile timeline & credential-free check-proxy routes precede handleProfilesUiRoutes
        const tlRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/timeline"),
            {} as Launcher,
            s,
        );
        expect(tlRes!.status).toBe(200);
        assertSecurityHeaders(tlRes!);
        expect((await tlRes!.json() as { ok: boolean; events: unknown[] }).ok).toBe(true);

        const proxyCheckRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/check-proxy", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            }),
            {} as Launcher,
            s,
            {
                proxyCheck: async () => ({ status: "working", attempts: 1, successes: 1, ip: "203.0.113.9", country: "US" }),
            },
        );
        expect(proxyCheckRes!.status).toBe(200);
        assertSecurityHeaders(proxyCheckRes!);
        const proxyCheckBody = await proxyCheckRes!.json() as { ok: boolean; status: string; ip?: string };
        expect(proxyCheckBody.ok).toBe(true);
        expect(proxyCheckBody.status).toBe("working");
        expect(JSON.stringify(proxyCheckBody)).not.toContain("PROXYPASS");

        // 6. Encrypted .mqprofile package export route precedes handleProfilesUiRoutes
        const pkgRes = await handleUiRequest(
            new Request("http://127.0.0.1:50400/ui/api/profiles/package/export", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: ["k1d0cd11"], password: "correct-horse-battery", includeSecrets: false, includeSessions: false }),
            }),
            { captureLocalSession: async () => undefined } as unknown as Launcher,
            s,
        );
        expect(pkgRes!.status).toBe(200);
        assertSecurityHeaders(pkgRes!);
        expect(pkgRes!.headers.get("content-disposition")).toContain(".mqprofile");
    } finally {
        s.close();
        rmSync(home, { recursive: true, force: true });
    }
});
