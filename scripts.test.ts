import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptLibrary, ScriptSupervisor, resolveScriptRunner, verifyScriptRuntime, type ScriptExecution } from "./scripts.ts";
import { handleUiRequest } from "./ui.ts";

import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { PYTHON_RUNTIME_FAILED, PythonRuntime } from "./python-runtime.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), "aliasmode-scripts-")); roots.push(dir); return dir; }
const input = { name: "Visit", description: "Example", language: "javascript" as const, source: "export default async () => {};" };
function harness(execute: ScriptExecution = async () => { }, options: {
    active?: string[];
    profileIds?: string[];
    admission?: LifecycleAdmissionController;
    close?: (id: string) => Promise<void>;

    firefoxOwner?: any;
    realExecute?: boolean;
    python?: PythonRuntime;
    maxConcurrentRuns?: number;
    maxRunHistory?: number;
} = {}) {
    const directory = root();
    const events: string[] = [];
    const launch = (id: string) => options.firefoxOwner
        ? { ws: `firefox://127.0.0.1:9000/${options.firefoxOwner.generation}`, debugPort: 9000, engine: "firefox", firefoxOwner: options.firefoxOwner }
        : { ws: `ws://test/${id}`, debugPort: 9000 };
    const launches = new Map((options.active ?? []).map((id) => [id, launch(id)]));
    const profiles = (options.profileIds ?? ["a", "b", "c"]).map((id) => ({ id, name: id, group: "", platform: "", username: `user-${id}`, password: `test-password-${id}`, twofa: "" }));
    const library = new ScriptLibrary(directory);
    const supervisor = new ScriptSupervisor({
        root: directory, library, python: options.python, maxConcurrentRuns: options.maxConcurrentRuns, maxRunHistory: options.maxRunHistory, ...(options.realExecute ? {} : { execute }),
        store: { getProfile: (id: string) => profiles.find((p) => p.id === id), getLaunch: (id: string) => launches.get(id), listAgentTemporary: () => [] } as any,
        launcher: {
            certifiedActive: async (id: string) => launches.has(id),
            start: async (id: string) => { events.push(`open:${id}`); const value = launch(id); launches.set(id, value); return { ws: value.ws, port: 9000 }; },
            stop: async (id: string) => { await options.close?.(id); events.push(`close:${id}`); launches.delete(id); return true; },
        } as any,
        admission: options.admission ?? { run: async (_: unknown, work: () => Promise<unknown>) => work() } as any,
    });
    return { library, supervisor, events, directory, launches };
}
const sourceRuntime = {
    kind: "source" as const,
    root: import.meta.dir,
    nodeExecutable: "node",
    workerPath: join(import.meta.dir, "playwright-worker.mjs"),
};
test("source scripts resolve the checked-in runners through system executables", async () => {
    if (!((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64")))
        return;
    expect(resolveScriptRunner("javascript", sourceRuntime)).toEqual({
        executable: "node", runner: join(import.meta.dir, "agent", "script-runner.mjs"),
    });
    expect(resolveScriptRunner("python", sourceRuntime)).toEqual({
        executable: "python3", runner: join(import.meta.dir, "agent", "script-runner.py"),
    });
    await expect(verifyScriptRuntime("javascript", { runtime: sourceRuntime })).resolves.toEqual({
        executable: "node", runner: join(import.meta.dir, "agent", "script-runner.mjs"),
    });
});
test("source script prerequisite errors are clear", async () => {
    if (!((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64")))
        return;
    const emptyPath = root();
    await expect(verifyScriptRuntime("javascript", { runtime: sourceRuntime, env: { PATH: emptyPath } }))
        .rejects.toThrow("Node.js 18 or newer and compatible Playwright");
    await expect(verifyScriptRuntime("python", { runtime: sourceRuntime, env: { PATH: emptyPath } }))
        .rejects.toThrow("Python 3 with compatible Playwright");
});
test("a missing runtime fails before a script opens a profile", async () => {
    const previous = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
    process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = root();
    try {
        const h = harness(undefined, { realExecute: true });
        const script = await h.library.save(input);
        h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
        await h.supervisor.settled();
        expect(h.events).toEqual([]);
        expect(h.supervisor.status()?.profiles[0]?.error).toContain("script runtime is missing");
    }
    finally {
        if (previous === undefined)
            delete process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
        else
            process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = previous;
    }
});
const pythonInput = { ...input, name: "Visit in Python", language: "python" as const, source: "async def run(**_):\n    pass\n" };
/** A Python runtime whose one pinned download comes from `fetch`. */
function fakePython(fetch: (url: string, init: RequestInit) => Promise<Response>): PythonRuntime {
    const bytes = new TextEncoder().encode("python archive");
    return new PythonRuntime(join(root(), "runtimes"), {
        platform: "win32", fetch, attempts: 1, sleep: async () => { }, check: async () => { },
        pins: { archive: { url: "https://python.test/python.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, wheels: [] },
        unpack: async (_archive, directory) => {
            const python = join(directory, "python");
            mkdirSync(join(python, "Lib", "site-packages", "playwright", "driver"), { recursive: true });
            writeFileSync(join(python, "python.exe"), "");
            writeFileSync(join(python, "Lib", "site-packages", "playwright", "driver", "node.exe"), "");
            return python;
        },
    });
}
test("a Python script waits for the Python runtime download before it opens a profile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const python = fakePython(async () => { await gate; return new Response("python archive"); });
    const interpreters: Array<string | undefined> = [];
    const h = harness(async ({ python: interpreter }) => { interpreters.push(interpreter); }, { python });
    const script = await h.library.save(pythonInput);
    const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await Bun.sleep(20);
    expect(h.events).toEqual([]);
    expect(h.supervisor.status()).toMatchObject({ scriptName: "Visit in Python", status: "running", profiles: [{ status: "queued" }] });
    expect(python.status().state).toBe("downloading");
    release();
    await h.supervisor.settled();
    expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
    expect(interpreters).toEqual([python.executable]);
    const log = h.supervisor.log(run.id, 0).text;
    expect(log).toContain("Downloading the Python runtime for Python scripts");
    expect(log).toContain("Python runtime download: 100%");
    expect(log).toContain("Python runtime ready");
    // An installed runtime starts the next run at once, without a download note.
    const next = h.supervisor.start({ scriptId: script.id, profileIds: ["b"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(h.supervisor.log(next.id, 0).text).not.toContain("Python runtime");
    expect(interpreters).toEqual([python.executable, python.executable]);
});
test("a failed Python runtime download fails the run clearly before any profile opens", async () => {
    const python = fakePython(async () => { throw new Error("network is down"); });
    let executed = false;
    const h = harness(async () => { executed = true; }, { python });
    const script = await h.library.save(pythonInput);
    const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(executed).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.supervisor.status()?.profiles).toEqual([
        { id: "a", name: "a", status: "failed", error: PYTHON_RUNTIME_FAILED },
        { id: "b", name: "b", status: "failed", error: PYTHON_RUNTIME_FAILED },
    ]);
    expect(h.supervisor.log(run.id, 0).text).toContain("Python runtime download failed: network is down");
    expect(python.status()).toMatchObject({ state: "failed", error: "network is down" });
});
test("Stop ends the wait for the Python runtime", async () => {
    const python = fakePython(() => new Promise<Response>(() => { }));
    const h = harness(async () => { throw new Error("must not run"); }, { python });
    const script = await h.library.save(pythonInput);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await Bun.sleep(20);
    const stopped = await h.supervisor.stop();
    expect(stopped?.status).toBe("finished");
    expect(stopped?.profiles[0]?.status).toBe("cancelled");
    expect(h.events).toEqual([]);
});
test("packaged Python scripts run only on the downloaded runtime", async () => {
    const packaged = { kind: "packaged" as const, root: root(), nodeExecutable: "node", workerPath: "worker.mjs" };
    expect(() => resolveScriptRunner("python", packaged)).toThrow("The Python runtime is not ready. Run the script again to download it.");
    expect(resolveScriptRunner("python", packaged, "/runtimes/python/python.exe").executable).toBe("/runtimes/python/python.exe");
    await expect(verifyScriptRuntime("python", { runtime: packaged, python: join(packaged.root, "missing.exe") }))
        .rejects.toThrow("The Python runtime is not ready");
});
test("JavaScript scripts run on the bundled Node and never download Python", async () => {
    const requests: string[] = [];
    const python = fakePython(async (url) => { requests.push(url); return new Response("python archive"); });
    const languages: string[] = [];
    const h = harness(async ({ language, python: interpreter }) => { languages.push(`${language}:${interpreter ?? ""}`); }, { python });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
    expect(languages).toEqual(["javascript:"]);
    expect(requests).toEqual([]);
    expect(existsSync(python.directory)).toBe(false);
});
test("listing and saving scripts report Python readiness without downloading it", async () => {
    const requests: string[] = [];
    const python = fakePython(async (url) => { requests.push(url); return new Response("python archive"); });
    const h = harness(undefined, { python });
    const nonce = "c".repeat(64);
    const request = async (path: string, method = "GET", body?: unknown) => {
        const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, {
            method, headers: { authorization: `Bearer ${nonce}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
            ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        }), {} as any, {} as any, { scripts: { library: h.library, runner: h.supervisor, nonce, python } });
        expect(response?.status).toBe(200);
        return response!.json();
    };
    expect((await request("/python-runtime")).python).toMatchObject({ state: "missing" });
    await request("", "POST", input);
    await request("");
    expect(requests).toEqual([]);
    const created = (await request("", "POST", pythonInput)).script;
    await request("");
    await request(`/${created.id}`, "PATCH", { ...pythonInput, name: "Updated Python", expectedRevision: created.revision });
    await request(`/${created.id}`);
    expect(requests).toEqual([]);
    expect((await request("/python-runtime")).python).toMatchObject({ state: "missing" });
    expect(existsSync(python.directory)).toBe(false);
    const source = { scripts: { library: h.library, runner: h.supervisor, nonce } };
    const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts/python-runtime", {
        headers: { authorization: `Bearer ${nonce}` },
    }), {} as any, {} as any, source);
    expect(await response!.json()).toEqual({ ok: true, python: null });
});
test("the user can retry a failed Python runtime download from the scripts page", async () => {
    let down = true;
    const python = fakePython(async () => { if (down)
        throw new Error("network is down"); return new Response("python archive"); });
    const h = harness(undefined, { python });
    const nonce = "d".repeat(64);
    const call = async (method: string) => (await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts/python-runtime", {
        method, headers: { authorization: `Bearer ${nonce}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
    }), {} as any, {} as any, { scripts: { library: h.library, runner: h.supervisor, nonce, python } }))!.json();
    await h.library.save(pythonInput);
    await call("POST");
    await python.ensure().catch(() => undefined);
    expect((await call("GET")).python).toMatchObject({ state: "failed", error: "network is down" });
    down = false;
    expect((await call("POST")).python.state).toBe("downloading");
    await python.ensure();
    expect((await call("GET")).python.state).toBe("ready");
});
test("local script imports never execute, survive reload, and check revisions", async () => {
    const h = harness();
    const script = await h.library.save(input);
    expect(h.events).toEqual([]);
    expect(await new ScriptLibrary(h.directory).get(script.id)).toEqual(script);
    expect(await h.library.list()).toEqual([expect.objectContaining({ id: script.id, revision: 1 })]);
    expect(JSON.stringify(await h.library.list())).not.toContain(input.source);
    await h.library.save({ ...input, name: "Updated" }, script.id, 1);
    await expect(h.library.save(input, script.id, 1)).rejects.toThrow("changed");
    await expect(h.library.delete(script.id, 1)).rejects.toThrow("changed");
    await h.library.delete(script.id, 2);
    expect(await h.library.list()).toEqual([]);
});
function renameFailure(code: string): NodeJS.ErrnoException { return Object.assign(new Error(`Injected rename ${code}`), { code }); }
function scriptWriteGate() {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    return { waiting, entered, release, resume };
}
test("Windows script-library replacement retries temporary locks while keeping the old complete file", async () => {
    const directory = root(), original = await new ScriptLibrary(directory).save(input);
    const path = join(directory, "custom-scripts", "local.json"), before = readFileSync(path, "utf8");
    const delays: number[] = [];
    let attempts = 0;
    const library = new ScriptLibrary(directory, {
        platform: "win32",
        rename: (source, target) => {
            attempts++;
            if (attempts <= 2) throw renameFailure(attempts === 1 ? "EPERM" : "EACCES");
            renameSync(source, target);
        },
        sleep: async (delay) => {
            delays.push(delay);
            expect(readFileSync(path, "utf8")).toBe(before);
            expect(JSON.parse(readFileSync(path, "utf8"))[0].revision).toBe(1);
        },
    });
    const saved = await library.save({ ...input, name: "After a temporary lock" }, original.id, 1);
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 25]);
    expect(saved.revision).toBe(2);
    expect(await new ScriptLibrary(directory).get(saved.id)).toEqual(saved);
    expect(readdirSync(library.directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
test("persistent Windows rename locks exhaust the bound without changing the file and do not poison the queue", async () => {
    const directory = root(), original = await new ScriptLibrary(directory).save(input);
    const path = join(directory, "custom-scripts", "local.json"), before = readFileSync(path, "utf8");
    const delays: number[] = [];
    let locked = true, attempts = 0;
    const library = new ScriptLibrary(directory, {
        platform: "win32",
        rename: (source, target) => { attempts++; if (locked) throw renameFailure("EBUSY"); renameSync(source, target); },
        sleep: async (delay) => { delays.push(delay); expect(readFileSync(path, "utf8")).toBe(before); },
    });
    await expect(library.save({ ...input, name: "Must not be committed" }, original.id, 1)).rejects.toMatchObject({ code: "EBUSY" });
    expect(attempts).toBe(6);
    expect(delays).toEqual([10, 25, 50, 100, 200]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect((await library.get(original.id)).revision).toBe(1);
    expect(readdirSync(library.directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
    locked = false;
    expect((await library.save({ ...input, name: "Recovered" }, original.id, 1)).revision).toBe(2);
    expect(attempts).toBe(7);
});
test("non-transient rename errors and non-Windows locks fail without retrying", async () => {
    for (const [platform, code] of [["win32", "EIO"], ["linux", "EPERM"]] as const) {
        const directory = root(), original = await new ScriptLibrary(directory).save(input);
        const path = join(directory, "custom-scripts", "local.json"), before = readFileSync(path, "utf8");
        let attempts = 0, sleeps = 0;
        const library = new ScriptLibrary(directory, { platform, rename: () => { attempts++; throw renameFailure(code); }, sleep: async () => { sleeps++; } });
        await expect(library.delete(original.id, 1)).rejects.toMatchObject({ code });
        expect(attempts).toBe(1); expect(sleeps).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(readdirSync(library.directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
    }
});
test("same-root library instances serialize reads and revisions across an asynchronous rename retry", async () => {
    const directory = root();
    let gate = scriptWriteGate(), blockNext = true, otherWrites = 0;
    const first = new ScriptLibrary(directory, {
        platform: "win32",
        rename: (source, target) => { if (blockNext) { blockNext = false; throw renameFailure("EPERM"); } renameSync(source, target); },
        sleep: async () => { gate.entered(); await gate.resume; },
    });
    const second = new ScriptLibrary(directory, { rename: (source, target) => { otherWrites++; renameSync(source, target); } });
    const createA = first.save({ ...input, name: "First new script" });
    await gate.waiting;
    const createB = second.save({ ...input, name: "Second new script" });
    await Promise.resolve();
    expect(otherWrites).toBe(0);
    gate.release();
    const [a, b] = await Promise.all([createA, createB]);
    expect((await first.list()).map(script => script.id).sort()).toEqual([a.id, b.id].sort());

    gate = scriptWriteGate(); blockNext = true;
    const updateA = first.save({ ...input, name: "Winning update" }, a.id, a.revision);
    await gate.waiting;
    const updateB = second.save({ ...input, name: "Stale update" }, a.id, a.revision);
    // Attach both rejection handlers before releasing the first writer.
    const outcomes = Promise.allSettled([updateA, updateB]);
    gate.release();
    const results = await outcomes;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.status : undefined).toBe(409);
    expect(await first.get(a.id)).toMatchObject({ name: "Winning update", revision: 2 });
    expect(await first.get(b.id)).toMatchObject({ name: "Second new script", revision: 1 });
    expect(otherWrites).toBe(1);
    expect(readdirSync(first.directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
test("runs only selected profiles sequentially and closes only job-opened browsers", async () => {
    const calls: any[] = [];
    const h = harness(async (request) => { calls.push(request.input); }, { active: ["a"] });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: { url: "https://example.test" }, useCredentials: false, concurrency: 1 });
    await h.supervisor.settled();
    expect(calls.map((call) => call.profile.id)).toEqual(["a", "b"]);
    expect(calls.every((call) => call.credentials === null)).toBe(true);
    expect(h.events).toEqual(["open:b", "close:b"]);
    expect(h.launches.has("a")).toBe(true);
    expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["succeeded", "succeeded"]);
});
async function until(check: () => boolean) {
    const deadline = Date.now() + 1000;
    while (!check() && Date.now() < deadline)
        await Bun.sleep(1);
    expect(check()).toBe(true);
}
for (const concurrency of [undefined, 1, 30, 100]) {
    test(`parallel runs respect concurrency ${concurrency ?? "default 10"} and refill individual slots`, async () => {
        const profileIds = Array.from({ length: 30 }, (_, i) => `profile-${i}`);
        const waiting = new Map<string, () => void>();
        const called: string[] = [];
        let peak = 0;
        const h = harness(async ({ input: data, signal }) => {
            called.push(data.profile.id);
            await new Promise<void>((resolve) => {
                waiting.set(data.profile.id, resolve);
                peak = Math.max(peak, waiting.size);
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
            waiting.delete(data.profile.id);
        }, { profileIds, admission: new LifecycleAdmissionController() });
        const script = await h.library.save(input);
        h.supervisor.start({ scriptId: script.id, profileIds: [...profileIds, profileIds[0]!], inputs: {}, useCredentials: false, concurrency });
        const limit = Math.min(concurrency ?? 10, profileIds.length);
        try {
            await until(() => waiting.size === limit);
            expect(called).toHaveLength(limit);
            if (limit < profileIds.length) {
                waiting.get(profileIds[0]!)!();
                await until(() => called.length === limit + 1);
                expect(waiting.size).toBe(limit);
                expect(h.events).toContain(`close:${profileIds[0]}`);
            }
            while (h.supervisor.status()?.status !== "finished") {
                for (const finish of waiting.values())
                    finish();
                await Bun.sleep(1);
            }
            expect(peak).toBe(limit);
            expect(called).toHaveLength(30);
            expect(new Set(called).size).toBe(30);
            expect(h.supervisor.status()?.profiles.every((p) => p.status === "succeeded")).toBe(true);
            expect(h.launches.size).toBe(0);
        }
        finally {
            await h.supervisor.stop();
        }
    });
}
test("parallel slots remain occupied until browser cleanup finishes, and failures refill slots", async () => {
    let finishClose!: () => void;
    const close = new Promise<void>((resolve) => { finishClose = resolve; });
    const waiting = new Map<string, () => void>();
    const h = harness(async ({ input: data, signal }) => {
        if (data.profile.id === "a")
            throw new Error("script failed");
        await new Promise<void>((resolve) => {
            waiting.set(data.profile.id, resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
    }, { close: async (id) => { if (id === "a")
            await close; } });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false, concurrency: 2 });
    try {
        await until(() => waiting.has("b") && h.supervisor.status()?.profiles[0]?.status === "failed");
        expect(h.events).toEqual(["open:a", "open:b"]);
        expect(h.supervisor.status()?.profiles[2]?.status).toBe("queued");
        finishClose();
        await until(() => waiting.has("c"));
        for (const finish of waiting.values())
            finish();
        await h.supervisor.settled();
        expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["failed", "succeeded", "succeeded"]);
    }
    finally {
        finishClose();
        await h.supervisor.stop();
    }
});
for (const action of ["stop", "shutdown"] as const) {
    test(`${action} waits for all parallel runners and cleanup, cancels queued profiles, and preserves existing browsers`, async () => {
        const started: string[] = [];
        let finish!: () => void;
        const release = new Promise<void>((resolve) => { finish = resolve; });
        const h = harness(async ({ input: data, signal, logFd }) => {
            started.push(data.profile.id);
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            await release;
            writeFileSync(logFd, `stopped:${data.profile.id}\n`);
            h.events.push(`terminated:${data.profile.id}`);
        }, { active: ["a"] });
        const script = await h.library.save(input);
        h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false, concurrency: 2 });
        try {
            await until(() => started.length === 2);
            let done = false;
            const stopping = h.supervisor[action]().then(() => { done = true; });
            await Bun.sleep(1);
            expect(done).toBe(false);
            expect(h.supervisor.status()?.status).not.toBe("finished");
            expect(h.events).toEqual(["open:b"]);
            finish();
            await stopping;
            expect(h.events).toContain("close:b");
            expect(h.events.indexOf("terminated:b")).toBeLessThan(h.events.indexOf("close:b"));
            expect(h.launches.has("a")).toBe(true);
            expect(h.events).not.toContain("open:c");
            expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
        }
        finally {
            finish();
            await h.supervisor.stop();
        }
    });
}
test("Stop removes parallel browser opens waiting for lifecycle admission", async () => {
    const admission = new LifecycleAdmissionController({ limit: 1 });
    let release!: () => void;
    const blocker = admission.run({ kind: "start" }, () => new Promise<void>((resolve) => { release = resolve; }));
    const h = harness(undefined, { admission });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b", "c"], inputs: {}, useCredentials: false });
    try {
        await until(() => admission.stats().queued === 3);
        const stopping = h.supervisor.stop();
        await until(() => admission.stats().queued === 0);
        await stopping;
        expect(h.events).toEqual([]);
        expect(h.supervisor.status()?.profiles.every((p) => p.status === "cancelled")).toBe(true);
    }
    finally {
        release();
        await blocker;
        await h.supervisor.stop();
    }
});
test("invalid parallel limits fail before creating a run", async () => {
    const h = harness();
    const script = await h.library.save(input);
    for (const concurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null]) {
        expect(() => h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false, concurrency: concurrency as number })).toThrow("positive whole number");
    }
    expect(h.supervisor.status()).toBeNull();
    expect(h.events).toEqual([]);
});
test("Firefox scripts use a private Playwright endpoint in the external runner", async () => {
    const requests: any[] = [];
    const executions: any[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            requests.push(await request.json());
            return Response.json({ version: 1, ok: true, result: { endpoint: "ws://127.0.0.1:9223/private" } });
        },
    });
    const owner = {
        endpoint: `http://127.0.0.1:${server.port}/`, token: "private-token", pid: 12, browserPid: 13, generation: "generation",
    };
    const h = harness(async (options) => { executions.push(options); }, { firefoxOwner: owner });
    try {
        const script = await h.library.save(input);
        h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: { url: "https://example.test" }, useCredentials: false });
        await h.supervisor.settled();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            operation: "playwright-endpoint",
            payload: { ownerGeneration: "generation" },
        });
        expect(executions).toHaveLength(1);
        expect(executions[0].input).toMatchObject({
            endpoint: "ws://127.0.0.1:9223/private", engine: "firefox",
            profile: { id: "a" }, inputs: { url: "https://example.test" }, credentials: null,
        });
        expect(h.supervisor.status()?.profiles[0]?.status).toBe("succeeded");
        expect(h.supervisor.log(h.supervisor.status()!.id, 0).text).not.toContain("9223/private");
    }
    finally {
        server.stop(true);
    }
});
test("Firefox script cancellation aborts the external runner before browser cleanup", async () => {
    const requests: any[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            requests.push(await request.json());
            return Response.json({ version: 1, ok: true, result: { endpoint: "ws://127.0.0.1:9223/private" } });
        },
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const h = harness(async ({ signal }) => {
        started();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    }, { firefoxOwner: {
            endpoint: `http://127.0.0.1:${server.port}/`, token: "private-token", pid: 12, browserPid: 13, generation: "generation",
        } });
    try {
        const script = await h.library.save(input);
        h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
        await ready;
        await h.supervisor.stop();
        expect(requests).toHaveLength(1);
        expect(requests[0].operation).toBe("playwright-endpoint");
        expect(h.events).toEqual(["open:a", "close:a"]);
        expect(h.supervisor.status()?.profiles[0]?.status).toBe("cancelled");
    }
    finally {
        server.stop(true);
    }
});
test("a browser reopened outside the run is not closed by script cleanup", async () => {
    const h = harness(async () => { h.launches.set("a", { ws: "ws://test/replacement", debugPort: 9001 }); });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(h.events).toEqual(["open:a"]);
    expect(h.launches.get("a")?.ws).toBe("ws://test/replacement");
    expect(h.supervisor.status()?.profiles[0]?.warning).toContain("left open");
});
test("saved login fields require opt-in and never enter status or cached scripts", async () => {
    const calls: any[] = [];
    const h = harness(async ({ input: data }) => { calls.push(data); });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["b"], inputs: {}, useCredentials: true });
    await h.supervisor.settled();
    expect(calls[0].credentials).toMatchObject({ username: "user-b", password: "test-password-b" });
    expect(JSON.stringify(h.supervisor.status())).not.toContain("test-password");
    expect(JSON.stringify(await h.library.get(script.id))).not.toContain("test-password");
});
test("Stop kills active work before close, cancels remaining profiles, and rejects overlapping runs", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const h = harness(async ({ signal }) => {
        started();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { h.events.push("terminated"); reject(new Error("stopped")); }, { once: true }));
    });
    const script = await h.library.save(input);
    const request = { scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false, concurrency: 1 };
    h.supervisor.start(request);
    await ready;
    expect(() => h.supervisor.start(request)).toThrow("already running");
    await h.supervisor.stop();
    expect(h.events).toEqual(["open:a", "terminated", "close:a"]);
    expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["cancelled", "cancelled"]);
});
test("a profile failure does not retry or skip the remaining selected profiles", async () => {
    const called: string[] = [];
    const h = harness(async ({ input: data }) => { called.push(data.profile.id); if (data.profile.id === "a")
        throw new Error("Script exited with code 1"); });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false, concurrency: 1 });
    await h.supervisor.settled();
    expect(called).toEqual(["a", "b"]);
    expect(h.supervisor.status()?.profiles.map((p) => p.status)).toEqual(["failed", "succeeded"]);
    expect(h.events).toEqual(["open:a", "close:a", "open:b", "close:b"]);
});
test("run source is fixed while the library entry is replaced", async () => {
    const seen: string[] = [];
    const h = harness(async ({ scriptPath }) => {
        seen.push(readFileSync(scriptPath, "utf8"));
        if (seen.length === 1)
            await h.library.save({ ...input, source: "replacement" }, script.id, 1);
    });
    const script = await h.library.save(input);
    h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    expect(seen).toEqual([input.source, input.source]);
});
test("local logs are incremental and unknown runs cannot be read", async () => {
    const h = harness(async ({ logFd }) => { writeFileSync(logFd, "profile output\n"); });
    const script = await h.library.save(input);
    const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await h.supervisor.settled();
    const log = h.supervisor.log(run.id, 0);
    expect(log.text).toContain("profile output");
    expect(h.supervisor.log(run.id, log.nextOffset).text).toBe("");
    expect(() => h.supervisor.log("another-run", 0)).toThrow();
});
test("all script API operations require the desktop nonce and trusted origin", async () => {
    const h = harness();
    const nonce = "a".repeat(64);
    const options = { scripts: { library: h.library, runner: h.supervisor, nonce } };
    for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/run"], ["POST", "/run"], ["POST", "/stop"], ["GET", "/log"], ["GET", "/id"], ["PATCH", "/id"], ["DELETE", "/id"], ["GET", "/python-runtime"], ["POST", "/python-runtime"]]) {
        const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/scripts${path}`, { method }), {} as any, {} as any, options);
        expect(response?.status).toBe(401);
    }
    const foreign = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts", {
        headers: { authorization: `Bearer ${nonce}`, origin: "https://foreign.test" },
    }), {} as any, {} as any, options);
    expect(foreign?.status).toBe(403);
    const imported = await handleUiRequest(new Request("http://127.0.0.1/ui/api/scripts", {
        method: "POST", headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" }, body: JSON.stringify(input),
    }), {} as any, {} as any, options);
    expect(imported?.status).toBe(200);
    expect(imported?.headers.get("cache-control")).toBe("no-store");
    expect(h.events).toEqual([]);
    expect((await h.library.list()).length).toBe(1);
});
test("shutdown rejects new script runs before any browser opens", async () => {
    const h = harness();
    const script = await h.library.save(input);
    await h.supervisor.shutdown();
    expect(() => h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false })).toThrow("shuts down");
    expect(h.events).toEqual([]);
});
test("disjoint profiles run concurrently while overlapping profiles and explicit single-slot limits reject", async () => {
    const gates = new Map<string, () => void>();
    const running = new Set<string>();
    const h = harness(async ({ input: data, logFd }) => {
        running.add(data.profile.id);
        writeFileSync(logFd, `running:${data.profile.id}\n`);
        await new Promise<void>((resolve) => gates.set(data.profile.id, resolve));
        running.delete(data.profile.id);
    }, { profileIds: ["a", "b", "c", "d"] });
    const script = await h.library.save(input);
    const run1 = h.supervisor.start({ scriptId: script.id, profileIds: ["a", "b"], inputs: {}, useCredentials: false });
    await until(() => gates.has("a") && gates.has("b"));
    expect(() => h.supervisor.start({ scriptId: script.id, profileIds: ["b", "c"], inputs: {}, useCredentials: false })).toThrow("already running");
    const run2 = h.supervisor.start({ scriptId: script.id, profileIds: ["c", "d"], inputs: {}, useCredentials: false });
    await until(() => gates.has("c") && gates.has("d"));
    expect(running.size).toBe(4);
    for (const resolve of gates.values()) resolve();
    await h.supervisor.settled();
    expect(h.supervisor.status(run1.id)?.status).toBe("finished");
    expect(h.supervisor.status(run2.id)?.status).toBe("finished");
    expect(h.supervisor.log(run1.id, 0).text).toContain("running:a");
    expect(h.supervisor.log(run2.id, 0).text).toContain("running:c");

    const single = harness(async ({ input: data }) => {
        await new Promise<void>((resolve) => gates.set(`single-${data.profile.id}`, resolve));
    }, { maxConcurrentRuns: 1 });
    const s2 = await single.library.save(input);
    single.supervisor.start({ scriptId: s2.id, profileIds: ["a"], inputs: {}, useCredentials: false });
    await until(() => gates.has("single-a"));
    expect(() => single.supervisor.start({ scriptId: s2.id, profileIds: ["b"], inputs: {}, useCredentials: false })).toThrow("already running");
    gates.get("single-a")!();
    await single.supervisor.settled();
});
test("retains bounded run history and logs across subsequent runs", async () => {
    let counter = 0;
    const h = harness(async ({ logFd }) => { writeFileSync(logFd, `run-log-${++counter}\n`); }, { maxRunHistory: 3 });
    const script = await h.library.save(input);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
        const run = h.supervisor.start({ scriptId: script.id, profileIds: ["a"], inputs: {}, useCredentials: false });
        ids.push(run.id);
        await h.supervisor.settled(run.id);
    }
    expect(h.supervisor.listRuns().map((r) => r.id)).toEqual([ids[3]!, ids[2]!, ids[1]!]);
    expect(() => h.supervisor.log(ids[0]!, 0)).toThrow("Run not found");
    expect(h.supervisor.log(ids[1]!, 0).text).toContain("run-log-2");
    expect(h.supervisor.log(ids[3]!, 0).text).toContain("run-log-4");
});
