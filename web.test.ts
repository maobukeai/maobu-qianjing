import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { statePaths } from "./paths.ts";
import { PythonRuntime } from "./python-runtime.ts";
import { ScriptLibrary } from "./scripts.ts";

import { serveAutomationApi, serveDashboard, serveDesktopAutomationApi, } from "./web.ts";
const webSource = readFileSync(join(import.meta.dir, "web.ts"), "utf8");
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
test("desktop automation API owns 127.0.0.1:50400 and desktop startup survives conflicts", async () => {
    const store = new ProfileStore(":memory:");
    const logs: string[] = [];
    const options = {
        launcher: {} as any,
        store,
        log: (message: string) => logs.push(message),
    };
    const server = serveDesktopAutomationApi(options);
    const dashboard = serveDashboard({ ...options, port: 0, log: () => { } });
    try {
        expect(dashboard.port).not.toBe(50400);
        if (server) {
            expect(server.port).toBe(50400);
            const response = await fetch("http://127.0.0.1:50400/status");
            expect(await response.json()).toMatchObject({ code: 0 });
            expect(serveDesktopAutomationApi(options)).toBeUndefined();
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
