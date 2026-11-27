import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { LifecycleAdmissionController } from "../lifecycle-admission.ts";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import { statePaths } from "../paths.ts";
import { PythonRuntime } from "../python-runtime.ts";
import { ScriptLibrary } from "../scripts.ts";

import { serveAutomationApi, serveDashboard, serveDesktopAutomationApi, STANDALONE_SESSION_COOKIE, STANDALONE_SESSION_HEADER } from "../web.ts";
const webSource = readFileSync(join(import.meta.dir, "..", "web.ts"), "utf8");

function rawLocalRequest(port: number, path: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`));
        let received = "";
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("isolated local request timed out")); }, 2000);
        socket.on("data", (data) => received += data);
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
        socket.once("end", () => {
            clearTimeout(timer);
            resolve({ status: Number(received.match(/^HTTP\/1\.[01] (\d+)/)?.[1]), body: received.slice(received.indexOf("\r\n\r\n") + 4) });
        });
    });
}
test("profile identity cards do not fetch egress IP automatically", () => {
    expect(webSource).not.toContain("ip-api.com/json");
    expect(webSource).not.toContain("checking egress IP");
    expect(webSource).toContain('engine === "firefox" ? "Firefox"');
    expect(webSource).toContain("no CDP, PDF, or Chrome extensions");
});
test("identity cards load stored Chromium and Firefox metadata without egress lookup", async () => {
    const store = new ProfileStore(":memory:");
    const chromium = buildNewProfile({ chromiumRuntime: "cloakbrowser", name: "Chromium card" }, () => false);
    const firefox = buildNewProfile({ engine: "firefox", name: "Firefox card" }, (id) => id === chromium.id);
    const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode", name: "Chromium 155 card" }, (id) => id === chromium.id || id === firefox.id);
    store.upsertProfiles([chromium, firefox, chromium155]);
    const server = serveDashboard({ port: 0, launcher: {} as any, store, log: () => { } });
    try {
        for (const [profile, browser] of [
            [chromium, "CloakBrowser"],
            [firefox, "Firefox"],
            [chromium155, "Chromium"],
        ] as const) {
            const response = await fetch(`http://127.0.0.1:${server.port}/card?id=${profile.id}`);
            expect(response.status).toBe(200);
            const card = await response.text();
            expect(card).toContain(browser);
            expect(card).not.toContain("AliasMode");
            expect(card).toContain(profile.timezone || "—");
            expect(card).not.toContain("ip-api.com");
        }
    }
    finally {
        await server.stop(true);
        store.close();
    }
});
test("dashboard serves in production mode so it never watches the app folder", async () => {
    const server = serveDashboard({ port: 0, launcher: {} as any, store: {} as any, log: () => { } });
    try {
        expect(server.development).toBe(false);
    }
    finally {
        await server.stop(true);
    }
});
test("desktop startup with a saved Python script does not prepare Python", async () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-idle-python-"));
    const store = new ProfileStore(":memory:");
    const previous = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
    const ensure = spyOn(PythonRuntime.prototype, "ensure").mockImplementation(() => Promise.reject(new Error("unexpected automatic install")));
    let server: ReturnType<typeof serveDashboard> | undefined;
    try {
        await new ScriptLibrary(root).save({ name: "Saved Python", description: "", language: "python", source: "async def run(**_):\n    pass\n" });
        process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = join(root, "packaged-runtime");
        server = serveDashboard({ port: 0, launcher: {} as any, store, paths: statePaths(root), agentNonce: "c".repeat(64), log: () => { } });
        const response = await fetch(`http://127.0.0.1:${server.port}/ui/api/scripts`, { headers: { authorization: `Bearer ${"c".repeat(64)}` } });
        expect(response.status).toBe(200);
        expect((await response.json()).scripts).toHaveLength(1);
        expect(ensure).not.toHaveBeenCalled();
    }
    finally {
        await server?.stopScripts();
        await server?.stop(true);
        ensure.mockRestore();
        if (previous === undefined) delete process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
        else process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = previous;
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});
test("retired hosted health ingestion consistently rejects requests", async () => {
 const server=serveDashboard({port:0,launcher:{} as any,store:{} as any,log:()=>{}});
 try { for(const origin of [undefined,"https://attacker.example"]){const response=await fetch(`http://127.0.0.1:${server.port}/api/xactions/health-snapshot`,{method:"POST",headers:origin?{origin}:undefined,body:"{}"});expect(response.status).toBe(410);} }finally{await server.stop(true);}
});
test("automation API serves compatibility routes without desktop UI", async () => {
    const store = new ProfileStore(":memory:");
    let publishes = 0;
    const server = serveAutomationApi({
        port: 0,
        launcher: {} as any,
        store,

        log: () => { },
    });
    try {
        const origin = `http://127.0.0.1:${server.port}`;
        const status = await fetch(`${origin}/api/v1/status`).then((response) => response.json());
        expect(status.code).toBe(0);
        const profiles = await fetch(`${origin}/api/v1/user/list?page=1&page_size=10`).then((response) => response.json());
        expect(profiles).toMatchObject({ code: 0, data: { list: [] } });
        const health = await fetch(`${origin}/api/xactions/health-snapshot`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profiles: [{ profileId: "p1", suspended: false }] }),
        });
        expect(health.status).toBe(410);
        expect(publishes).toBe(0);
        for (const path of ["/", "/ui/api/health", "/card?id=p1", "/api/agent/v1/connect"]) {
            const response = await fetch(`${origin}${path}`);
            expect(response.headers.get("content-type")).not.toContain("text/html");
            expect(await response.text()).not.toContain("<!doctype html>");
        }
    }
    finally {
        await server.stop(true);
        store.close();
    }
});
test("dashboard and automation API share lifecycle admission", async () => {
    const store = new ProfileStore(":memory:");
    const admission = new LifecycleAdmissionController({ limit: 1 });
    let release = () => { };
    const blocker = admission.run({ kind: "start", profileIds: ["held"] }, () => new Promise<void>((resolve) => { release = resolve; }));
    const dashboard = serveDashboard({
        port: 0,
        launcher: {} as any,
        store,
        lifecycleAdmission: admission,
        log: () => { },
    });
    const automation = serveAutomationApi({
        port: 0,
        launcher: {} as any,
        store,
        lifecycleAdmission: admission,
        log: () => { },
    });
    try {
        const dashboardStatus = await fetch(`http://127.0.0.1:${dashboard.port}/status`).then((response) => response.json());
        const automationStatus = await fetch(`http://127.0.0.1:${automation.port}/status`).then((response) => response.json());
        expect(dashboardStatus.data.admission.inFlight).toBe(1);
        expect(automationStatus.data.admission.inFlight).toBe(1);
    }
    finally {
        release();
        await blocker;
        await Promise.all([dashboard.stop(true), automation.stop(true)]);
        store.close();
    }
});
test("desktop automation is opt-in and requires its own bearer token", async () => {
    const store = new ProfileStore(":memory:");
    const logs: string[] = [];
    const options = {
        launcher: {} as any,
        store,
        log: (message: string) => logs.push(message),
    };
    expect(serveDesktopAutomationApi(options)).toBeUndefined();
    const automationToken = "c".repeat(64);
    const server = serveDesktopAutomationApi({ ...options, automationToken });
    const dashboard = serveDashboard({ ...options, port: 0, log: () => { } });
    try {
        expect(dashboard.port).not.toBe(50400);
        if (server) {
            expect(server.port).toBe(50400);
            const statusUrl = "http://127.0.0.1:50400/status";
            expect((await fetch(statusUrl)).status).toBe(401);
            expect((await fetch(statusUrl, { headers: { Authorization: `Bearer ${"d".repeat(64)}` } })).status).toBe(401);
            const response = await fetch(statusUrl, { headers: { Authorization: `Bearer ${automationToken}` } });
            expect(await response.json()).toMatchObject({ code: 0 });
            expect(serveDesktopAutomationApi({ ...options, automationToken })).toBeUndefined();
        }
        expect(logs.some((message) => message.includes("automation API could not bind to http://127.0.0.1:50400"))).toBeTrue();
        expect(logs.filter((message) => message.includes("automation API on")).length)
            .toBe(server ? 1 : 0);
        const health = await fetch(`http://127.0.0.1:${dashboard.port}/ui/api/health`);
        expect(health.status).toBe(200);
    }
    finally {
        await Promise.all([server?.stop(true), dashboard.stop(true)]);
        store.close();
    }
});

for (const [name, create] of [["dashboard", serveDashboard], ["automation", serveAutomationApi]] as const) {
    test(`${name} rejects cross-site image/form requests and rebound Host before any profile action`, async () => {
        const store = new ProfileStore(":memory:");
        const profile = buildNewProfile({ engine: "chromium", name: "Isolated HTTP boundary fixture" }, () => false);
        store.upsertProfile(profile);
        let starts = 0, stops = 0;
        const launcher = { start: async () => { starts++; return { ws: "ws://fixture", port: 9000 }; }, stop: async () => { stops++; return true; }, captureLocalSession: async () => {}, reconcileOrphans: async () => {} } as any;
        const server = create({ port: 0, launcher, store, log: () => {} });
        const origin = `http://127.0.0.1:${server.port}`;
        const startPath = `/api/v1/browser/start?user_id=${profile.id}`;
        try {
            for (const path of [startPath, `/api/v1/browser/stop?user_id=${profile.id}`]) {
                expect((await fetch(origin + path, { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" } })).status).toBe(403);
                expect((await fetch(origin + path, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" })).status).toBe(403);
            }
            expect((await fetch(origin + startPath, { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
            expect((await rawLocalRequest(server.port!, startPath, `evil.test:${server.port}`)).status).toBe(403);
            expect((await rawLocalRequest(server.port!, startPath, `127.0.0.1:${server.port! + 1}`)).status).toBe(403);
            expect((await rawLocalRequest(server.port!, startPath, "localhost")).status).toBe(403);
            expect((await fetch(origin + startPath, { headers: { Referer: "https://evil.test/legacy-image" } })).status).toBe(403);
            expect(starts).toBe(0); expect(stops).toBe(0);
            // Existing AdsPower CLI GET semantics and normal same-origin UI remain intact.
            expect((await fetch(origin + startPath)).status).toBe(200);
            expect(starts).toBe(1);
            for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]) {
                const response = await rawLocalRequest(server.port!, "/api/v1/status", host, { Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" });
                expect(response.status).toBe(200); expect(JSON.parse(response.body).code).toBe(0);
            }
            if (name === "dashboard") {
                expect((await fetch(`${origin}/ui/api/profiles/${profile.id}/open`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "text/plain" }, body: "" })).status).toBe(403);
                expect((await fetch(`${origin}/ui/api/profiles/${profile.id}/open`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
                expect(starts).toBe(2);
                expect((await fetch(`${origin}/card?id=${profile.id}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
            }
        } finally { await server.stop(true); store.close(); }
    });
}

test("dashboard protects workspace capability and agent handshake while allowing same-origin UI", async () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-http-boundary-"));
    const store = new ProfileStore(":memory:");
    const nonce = "e".repeat(64);
    const server = serveDashboard({ port: 0, store, paths: statePaths(root), launcher: { reconcileOrphans: async () => {} } as any, agentNonce: nonce, log: () => {} });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
        const legitimate = await fetch(`${origin}/ui/api/workspace/capability`, { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } });
        expect(legitimate.status).toBe(200);
        const token = (await legitimate.json()).token;
        expect(typeof token).toBe("string");
        for (const path of ["/ui/api/workspace/capability", "/api/agent/v1/connect"]) {
            const blocked = await fetch(origin + path, { headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site", Authorization: `Bearer ${nonce}`, "sec-websocket-protocol": "aliasmode-agent-v1" } });
            expect(blocked.status).toBe(403); expect(await blocked.text()).not.toContain(token);
            expect((await rawLocalRequest(server.port!, path, `evil.test:${server.port}`)).status).toBe(403);
        }
    } finally { await server.stopScripts(); await server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("actual server rejects a non-loopback TCP peer even when its Host is forged as local", async () => {
    const server = serveAutomationApi({ port: 0, store: {} as any, launcher: {} as any, log: () => {} });
    const requestIP = spyOn(server, "requestIP").mockReturnValue({ address: "203.0.113.9", family: "IPv4", port: 12345 });
    try { expect((await fetch(`http://127.0.0.1:${server.port}/status`)).status).toBe(403); }
    finally { requestIP.mockRestore(); await server.stop(true); }
});

test("dashboard enforces security headers, scopes agentNonce to /ui/api/health in desktop mode, and supports standalone accessToken", async () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-web-sec-"));
    const store = new ProfileStore(":memory:");
    const profile = buildNewProfile({ engine: "chromium", name: "Security header profile" }, () => false);
    store.upsertProfile(profile);
    const paths = statePaths(root);
    const agentNonce = "a".repeat(64);
    const desktopSession = "b".repeat(64);
    const desktopServer = serveDashboard({
        port: 0,
        store,
        paths,
        launcher: { reconcileOrphans: async () => {}, browserRuntimeDeployment: undefined } as any,
        agentNonce,
        dashboardSession: desktopSession,
        log: () => {},
    });
    const desktopOrigin = `http://127.0.0.1:${desktopServer.port}`;
    try {
        const spa = await fetch(`${desktopOrigin}/`);
        expect(spa.status).toBe(200);
        expect(spa.headers.get("x-content-type-options")).toBe("nosniff");
        expect(spa.headers.get("x-frame-options")).toBe("DENY");
        expect(spa.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

        // agentNonce alone authorizes /ui/api/health, NOT /ui/api/scripts or /ui/api/profiles.
        expect((await fetch(`${desktopOrigin}/ui/api/health`, { headers: { Authorization: `Bearer ${agentNonce}` } })).status).toBe(200);
        expect((await fetch(`${desktopOrigin}/ui/api/scripts`, { headers: { Authorization: `Bearer ${agentNonce}` } })).status).toBe(401);
        expect((await fetch(`${desktopOrigin}/ui/api/profiles`, { headers: { Authorization: `Bearer ${agentNonce}` } })).status).toBe(401);

        // With X-Maobu-Desktop-Session + agentNonce, /ui/api/scripts succeeds and API security headers are set.
        const scriptsRes = await fetch(`${desktopOrigin}/ui/api/scripts`, {
            headers: { "X-Maobu-Desktop-Session": desktopSession, Authorization: `Bearer ${agentNonce}` },
        });
        expect(scriptsRes.status).toBe(200);
        expect(scriptsRes.headers.get("x-content-type-options")).toBe("nosniff");
        expect(scriptsRes.headers.get("x-frame-options")).toBe("DENY");

        const cardRes = await fetch(`${desktopOrigin}/card?id=${profile.id}`, {
            headers: { "X-Maobu-Desktop-Session": desktopSession },
        });
        expect(cardRes.status).toBe(200);
        expect(cardRes.headers.get("x-frame-options")).toBe("DENY");
        expect(cardRes.headers.get("content-security-policy")).toContain("default-src 'none'");
    } finally {
        await desktopServer.stopScripts();
        await desktopServer.stop(true);
    }

    // Standalone accessToken flow: ?token= -> 302 Set-Cookie, Bearer, X-Maobu-Session, Cookie.
    const accessToken = "c".repeat(64);
    const standalone = serveDashboard({
        port: 0,
        store,
        paths,
        launcher: { reconcileOrphans: async () => {}, browserRuntimeDeployment: undefined } as any,
        accessToken,
        log: () => {},
    });
    const standaloneOrigin = `http://127.0.0.1:${standalone.port}`;
    try {
        const unauthRoot = await fetch(`${standaloneOrigin}/`);
        expect(unauthRoot.status).toBe(401);
        expect(await unauthRoot.text()).toContain("?token=<token>");
        expect((await fetch(`${standaloneOrigin}/ui/api/profiles`)).status).toBe(401);
        expect((await fetch(`${standaloneOrigin}/ui/api/workspace/capability`)).status).toBe(401);
        expect((await fetch(`${standaloneOrigin}/api/v1/status`)).status).toBe(401);

        const login = await fetch(`${standaloneOrigin}/?token=${accessToken}`, { redirect: "manual" });
        expect(login.status).toBe(302);
        expect(login.headers.get("location")).toBe("/");
        const setCookie = login.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain(`${STANDALONE_SESSION_COOKIE}=${accessToken}`);
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Strict");

        const cookieHeader = `${STANDALONE_SESSION_COOKIE}=${accessToken}`;
        const authedRoot = await fetch(`${standaloneOrigin}/`, { headers: { Cookie: cookieHeader } });
        expect(authedRoot.status).toBe(200);
        expect(authedRoot.headers.get("content-security-policy")).toContain("ipc: http://ipc.localhost https://ipc.localhost");
        expect((await fetch(`${standaloneOrigin}/ui/api/profiles`, { headers: { Cookie: cookieHeader } })).status).toBe(200);
        expect((await fetch(`${standaloneOrigin}/ui/api/workspace/capability`, { headers: { Cookie: cookieHeader } })).status).toBe(200);
        expect((await fetch(`${standaloneOrigin}/ui/api/profiles`, { headers: { [STANDALONE_SESSION_HEADER]: accessToken } })).status).toBe(200);
        expect((await fetch(`${standaloneOrigin}/api/v1/status`, { headers: { Authorization: `Bearer ${accessToken}` } })).status).toBe(200);
    } finally {
        await standalone.stopScripts();
        await standalone.stop(true);
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("serveDesktopAutomationApi logs a clear warning instead of swallowing bind failures silently", async () => {
    const warnings: string[] = [];
    let blocker: ReturnType<typeof Bun.serve> | undefined;
    try {
        blocker = Bun.serve({ port: 50400, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    } catch {
        // Port 50400 already in use on host still exercises the bind-failure warning path.
    }
    try {
        const result = serveDesktopAutomationApi({
            store: {} as any,
            launcher: {} as any,
            automationToken: "f".repeat(64),
            log: (msg) => warnings.push(msg),
        });
        expect(result).toBeUndefined();
        expect(warnings.some((m) => m.includes("WARNING:") && m.includes("50400"))).toBe(true);
    } finally {
        await blocker?.stop(true);
    }
});

test("serveDashboard enforces 423 Locked app-lock gate across protected routes while allowing unlock", async () => {
    const root = mkdtempSync(join(tmpdir(), "maobu-web-applock-"));
    const paths = statePaths(root);
    const store = new ProfileStore(paths.database);
    const server = serveDashboard({
        port: 0,
        paths,
        workspaceHome: root,
        store,
        launcher: {
            reconcileOrphans: async () => 0,
            dataDriveFreeBytes: () => 50 * 1024 ** 3,
        } as any,
        log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const modeRes = await fetch(`${base}/ui/api/app-mode`);
        expect(modeRes.status).toBe(200);
        expect((await modeRes.json() as { appLockAvailable?: boolean }).appLockAvailable).toBe(true);

        const setupRes = await fetch(`${base}/ui/api/app-lock/setup`, {
            method: "POST",
            headers: { "content-type": "application/json", "X-Maobu-Settings": "1" },
            body: JSON.stringify({ password: "master-pass-123", idleTimeoutMinutes: 15, lockOnStartup: true }),
        });
        expect(setupRes.status).toBe(200);

        const lockRes = await fetch(`${base}/ui/api/app-lock/lock`, {
            method: "POST",
            headers: { "content-type": "application/json", "X-Maobu-Settings": "1" },
            body: "{}",
        });
        expect(lockRes.status).toBe(200);
        expect((await lockRes.json() as { status: { locked: boolean } }).status.locked).toBe(true);

        // Protected endpoints must return 423 Locked with security headers
        const blockedProfiles = await fetch(`${base}/ui/api/profiles`);
        expect(blockedProfiles.status).toBe(423);
        expect(blockedProfiles.headers.get("x-content-type-options")).toBe("nosniff");
        expect(blockedProfiles.headers.get("x-frame-options")).toBe("DENY");
        expect((await blockedProfiles.json() as { code?: string }).code).toBe("app_locked");

        const blockedCard = await fetch(`${base}/card?id=nonexistent`);
        expect(blockedCard.status).toBe(423);

        // Allowlisted shell/status/unlock endpoints stay reachable
        expect((await fetch(`${base}/`)).status).toBe(200);
        expect((await fetch(`${base}/ui/api/app-mode`)).status).toBe(200);
        expect((await fetch(`${base}/ui/api/app-lock/status`)).status).toBe(200);

        const unlockRes = await fetch(`${base}/ui/api/app-lock/unlock`, {
            method: "POST",
            headers: { "content-type": "application/json", "X-Maobu-Settings": "1" },
            body: JSON.stringify({ password: "master-pass-123" }),
        });
        expect(unlockRes.status).toBe(200);
        expect((await unlockRes.json() as { status: { locked: boolean } }).status.locked).toBe(false);

        const profilesAfterUnlock = await fetch(`${base}/ui/api/profiles`);
        expect(profilesAfterUnlock.status).toBe(200);
    } finally {
        await server.stopScripts();
        await server.stop(true);
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});
