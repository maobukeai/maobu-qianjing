import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentControlSession, AGENT_CONTROL_PROTOCOL, type AgentControlDeps } from "./agent-control.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { ScriptInput, ScriptLanguage, ScriptRecord, ScriptSummary } from "./contracts/local.ts";
import { resolvePlaywrightRuntime, type PlaywrightRuntimeLayout } from "./playwright-runtime.ts";
import { PYTHON_RUNTIME_FAILED, type PythonRuntime } from "./python-runtime.ts";
export class ScriptError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
export function scriptInput(value: any): ScriptInput {
    if (!value || typeof value.name !== "string" || !value.name.trim()
        || typeof value.description !== "string" || typeof value.source !== "string" || !value.source.trim()
        || !["javascript", "python"].includes(value.language)) {
        throw new ScriptError("A name, description, source, and supported language are required");
    }
    return { name: value.name.trim(), description: value.description, language: value.language, source: value.source };
}
function revision(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 1)
        throw new ScriptError("A valid expected revision is required");
}
export interface ScriptLibraryOptions {
    platform?: NodeJS.Platform;
    rename?: (source: string, target: string) => void;
    sleep?: (milliseconds: number) => Promise<void>;
}
const SCRIPT_RENAME_DELAYS = [10, 25, 50, 100, 200] as const;
const scriptLibraryWrites = new Map<string, Promise<void>>();
export class ScriptLibrary {
    readonly directory: string;
    private readonly writeKey: string;
    constructor(root: string, private readonly options: ScriptLibraryOptions = {}) {
        this.directory = join(root, "custom-scripts");
        const path = resolve(this.directory, "local.json");
        this.writeKey = process.platform === "win32" ? path.toLowerCase() : path;
    }
    private cached(): ScriptRecord[] { const path = join(this.directory, "local.json"); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []; }
    /** Serialize the entire read/validate/replace transaction, including across instances. */
    private mutate<T>(work: () => Promise<T>): Promise<T> {
        const previous = scriptLibraryWrites.get(this.writeKey) ?? Promise.resolve();
        const result = previous.then(work);
        const settled = result.then(() => {}, () => {});
        scriptLibraryWrites.set(this.writeKey, settled);
        void settled.then(() => { if (scriptLibraryWrites.get(this.writeKey) === settled) scriptLibraryWrites.delete(this.writeKey); });
        return result;
    }
    private async write(scripts: ScriptRecord[]): Promise<void> {
        mkdirSync(this.directory, { recursive: true });
        const path = join(this.directory, "local.json");
        const temporary = path + "." + randomUUID() + ".tmp";
        let temporaryOwned = false;
        try {
            const descriptor = openSync(temporary, "wx", 0o600);
            temporaryOwned = true;
            try { writeFileSync(descriptor, JSON.stringify(scripts)); }
            finally { closeSync(descriptor); }
            for (let attempt = 0; ; attempt++) {
                try {
                    (this.options.rename ?? renameSync)(temporary, path);
                    return;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException)?.code;
                    if ((this.options.platform ?? process.platform) !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= SCRIPT_RENAME_DELAYS.length) throw error;
                    // Windows scanners/indexers can briefly lock the old or new file.
                    // Keep the old JSON intact and retry the same atomic replacement.
                    await (this.options.sleep ?? ((milliseconds) => new Promise<void>(done => setTimeout(done, milliseconds))))(SCRIPT_RENAME_DELAYS[attempt]!);
                }
            }
        }
        catch (error) {
            try { if (temporaryOwned) rmSync(temporary, { force: true }); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], "Script save failed and its temporary file could not be removed", { cause: error }); }
            throw error;
        }
    }
    async list(): Promise<ScriptSummary[]> { return (await this.info()).scripts; }
    async info(): Promise<{
        scripts: ScriptSummary[];
    }> { return { scripts: this.cached().map(({ source, ...summary }) => summary) }; }
    async get(id: string): Promise<ScriptRecord> { const script = this.cached().find(item => item.id === id); if (!script)
        throw new ScriptError("Script not found", 404); return script; }
    async save(value: ScriptInput, id?: string, expectedRevision?: number): Promise<ScriptRecord> {
        const input = scriptInput(value);
        if (id)
            revision(expectedRevision);
        return this.mutate(async () => {
            const scripts = this.cached();
            const previous = id ? scripts.find(item => item.id === id) : undefined;
            if (id && !previous)
                throw new ScriptError("Script not found", 404);
            if (previous && previous.revision !== expectedRevision)
                throw new ScriptError("Script changed; reload before saving", 409);
            const now = new Date().toISOString();
            const script = { ...input, id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
            await this.write([...scripts.filter(item => item.id !== script.id), script]);
            return script;
        });
    }
    async delete(id: string, expectedRevision: number): Promise<void> {
        revision(expectedRevision);
        return this.mutate(async () => {
            const scripts = this.cached(), script = scripts.find(item => item.id === id);
            if (!script) throw new ScriptError("Script not found", 404);
            if (script.revision !== expectedRevision) throw new ScriptError("Script changed; reload before deleting", 409);
            await this.write(scripts.filter(item => item.id !== id));
        });
    }
}
export interface ScriptRun {
    id: string;
    scriptName: string;
    status: "running" | "stopping" | "finished";
    profiles: Array<{
        id: string;
        name: string;
        status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
        error?: string;
        warning?: string;
    }>;
}
interface RunRequest {
    scriptId: string;
    profileIds: string[];
    inputs: Record<string, unknown>;
    useCredentials: boolean;
    concurrency?: number;
}
interface RunnerInput {
    endpoint: string;
    engine?: "firefox";
    profile: {
        id: string;
        name: string;
        group: string;
        platform: string;
    };
    inputs: Record<string, unknown>;
    credentials: Record<string, string> | null;
}
export type ScriptExecution = (options: {
    scriptPath: string;
    language: ScriptLanguage;
    input: RunnerInput;
    logFd: number;
    signal: AbortSignal;
    /** The interpreter of the downloaded Python runtime; packaged Python scripts need it. */
    python?: string;
}) => Promise<void>;
interface ScriptRunner {
    executable: string;
    runner: string;
}
export interface ScriptRuntimeVerificationOptions {
    runtime?: PlaywrightRuntimeLayout;
    env?: NodeJS.ProcessEnv;
    python?: string;
}
function scriptRunnerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]) {
        if (source[key] !== undefined)
            env[key] = source[key];
    }
    return env;
}
function supportsSourceScripts(): boolean {
    return process.platform === "darwin" || (process.platform === "linux" && process.arch === "x64");
}
const PYTHON_NOT_READY = "The Python runtime is not ready. Run the script again to download it.";
/** The desktop app runs Python scripts on the downloaded runtime (`python`), a source checkout on python3. */
export function resolveScriptRunner(language: ScriptLanguage, runtime = resolvePlaywrightRuntime(), python?: string): ScriptRunner {
    if (runtime.kind === "source" && !supportsSourceScripts()) {
        throw new ScriptError("Scripts require the packaged desktop runtime", 503);
    }
    if (runtime.kind === "packaged" && language === "python" && !python)
        throw new ScriptError(PYTHON_NOT_READY, 503);
    return {
        executable: runtime.kind === "source"
            ? language === "python" ? "python3" : runtime.nodeExecutable
            : language === "python" ? python! : runtime.nodeExecutable,
        runner: join(runtime.root, "agent", language === "python" ? "script-runner.py" : "script-runner.mjs"),
    };
}
async function sourceCommandAvailable(executable: string, args: string[], runtime: PlaywrightRuntimeLayout, env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
        const child = Bun.spawn([executable, ...args], { cwd: runtime.root, env, stdout: "ignore", stderr: "ignore" });
        return await child.exited === 0;
    }
    catch {
        return false;
    }
}
export async function verifyScriptRuntime(language: ScriptLanguage, options: ScriptRuntimeVerificationOptions = {}): Promise<ScriptRunner> {
    const runtime = options.runtime ?? resolvePlaywrightRuntime();
    const resolved = resolveScriptRunner(language, runtime, options.python);
    if (!existsSync(resolved.executable) && runtime.kind === "packaged") {
        throw new ScriptError(language === "python" ? PYTHON_NOT_READY : "The script runtime is missing; repair the local desktop installation", 503);
    }
    if (!existsSync(resolved.runner)) {
        throw new ScriptError(runtime.kind === "source"
            ? "The source script runner is missing; restore the local source checkout"
            : "The script runtime is missing; repair the local desktop installation", 503);
    }
    if (runtime.kind !== "source")
        return resolved;
    const env = scriptRunnerEnvironment(options.env);
    const available = language === "javascript"
        ? await sourceCommandAvailable(resolved.executable, ["-e", "const p = require('playwright-core/package.json'); if (+process.versions.node.split('.')[0] < 18 || p.version !== '1.58.2') process.exit(1)"], runtime, env)
        : await sourceCommandAvailable(resolved.executable, ["-c", "from playwright.async_api import async_playwright\nfrom playwright._repo_version import version\nraise SystemExit(not version.startswith('1.58.'))"], runtime, env);
    if (!available) {
        throw new ScriptError(language === "javascript"
            ? "Source JavaScript scripts require Node.js 18 or newer and compatible Playwright 1.58.2 installed"
            : "Source Python scripts require Python 3 with compatible Playwright 1.58.x installed", 503);
    }
    return resolved;
}
export const executeScript: ScriptExecution = async ({ scriptPath, language, input, logFd, signal, python }) => {
    signal.throwIfAborted();
    const { executable, runner } = await verifyScriptRuntime(language, { python });
    signal.throwIfAborted();
    const pythonArgs = ["-u", "-X", "utf8"];
    const child = spawn(executable, [...(language === "python" ? pythonArgs : []), runner, scriptPath], {
        windowsHide: true, detached: process.platform !== "win32", env: scriptRunnerEnvironment(), stdio: ["pipe", logFd, logFd],
    });
    let termination: Promise<void> | undefined;
    const stop = () => {
        termination ??= (async () => {
            if (!child.pid || child.exitCode !== null || child.signalCode !== null)
                return;
            if (process.platform === "win32") {
                const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
                if (await kill.exited !== 0 && child.exitCode === null && child.signalCode === null)
                    throw new Error("Script process termination was not confirmed");
            }
            else {
                try {
                    process.kill(-child.pid, "SIGKILL");
                }
                catch (error: any) {
                    if (error.code !== "ESRCH")
                        throw error;
                }
            }
        })().catch((error) => {
            // Keep waiting for exit; browser cleanup must not race a live script.
            writeFileSync(logFd, `\nCould not stop script: ${error instanceof Error ? error.message : String(error)}\n`);
        });
    };
    signal.addEventListener("abort", stop, { once: true });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    // EOF is reserved for parent death; the runner reads its input from the first line.
    child.stdin!.on("error", () => { });
    child.stdin!.write(`${JSON.stringify(input)}\n`);
    if (signal.aborted)
        stop();
    try {
        const code = await exited;
        await termination;
        signal.throwIfAborted();
        if (code !== 0)
            throw new Error(`Script exited with code ${code ?? "unknown"}; see its log`);
    }
    finally {
        signal.removeEventListener("abort", stop);
        child.stdin!.destroy();
    }
};
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_MAX_RUN_HISTORY = 20;

interface ActiveRun {
    view: ScriptRun;
    directory: string;
    logPath: string;
    abort: AbortController;
    done: Promise<void>;
}
export class ScriptSupervisor {
    private readonly runs = new Map<string, ActiveRun>();
    private readonly lockedProfiles = new Map<string, string>();
    private latestRunId?: string;
    private readonly maxConcurrentRuns: number;
    private readonly maxRunHistory: number;
    private closing = false;
    constructor(private readonly options: AgentControlDeps & {
        root: string;
        library: ScriptLibrary;
        execute?: ScriptExecution;
        /** The downloaded Python runtime of the desktop app; a source checkout runs python3. */
        python?: PythonRuntime;
        /** Maximum concurrent script runs across disjoint profiles (default 4). */
        maxConcurrentRuns?: number;
        /** Maximum number of completed/active runs whose metadata & logs are retained (default 20). */
        maxRunHistory?: number;
        /** Called whenever a run transitions phase or a profile item updates status. */
        onRunChanged?: (run: ScriptRun) => void;
    }) {
        const concurrent = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
        const history = options.maxRunHistory ?? DEFAULT_MAX_RUN_HISTORY;
        if (!Number.isSafeInteger(concurrent) || concurrent < 1)
            throw new ScriptError("maxConcurrentRuns must be a positive whole number");
        if (!Number.isSafeInteger(history) || history < 1)
            throw new ScriptError("maxRunHistory must be a positive whole number");
        this.maxConcurrentRuns = concurrent;
        this.maxRunHistory = history;
    }
    status(id?: string): ScriptRun | null {
        if (id !== undefined) {
            const found = this.runs.get(id);
            return found ? structuredClone(found.view) : null;
        }
        const entries = [...this.runs.values()];
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i]!.view.status !== "finished")
                return structuredClone(entries[i]!.view);
        }
        const latest = this.latestRunId ? this.runs.get(this.latestRunId) : entries.at(-1);
        return latest ? structuredClone(latest.view) : null;
    }
    listRuns(): ScriptRun[] {
        return [...this.runs.values()].reverse().map((entry) => structuredClone(entry.view));
    }
    private emitRunChanged(run: ActiveRun): void {
        if (!this.options.onRunChanged)
            return;
        try {
            this.options.onRunChanged(structuredClone(run.view));
        }
        catch (error) {
            this.options.log?.(`script run listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    private pruneHistory(): void {
        if (this.runs.size < this.maxRunHistory)
            return;
        for (const [runId, entry] of this.runs) {
            if (this.runs.size < this.maxRunHistory)
                break;
            if (entry.view.status !== "finished")
                continue;
            this.runs.delete(runId);
            rmSync(entry.directory, { recursive: true, force: true });
        }
    }
    start(request: RunRequest): ScriptRun {
        if (this.closing)
            throw new ScriptError("Script execution is unavailable while the app shuts down", 409);
        if (!request || typeof request.scriptId !== "string" || !request.scriptId
            || !Array.isArray(request.profileIds) || !request.profileIds.length || !request.profileIds.every((id) => typeof id === "string" && id)
            || !request.inputs || typeof request.inputs !== "object" || Array.isArray(request.inputs) || typeof request.useCredentials !== "boolean") {
            throw new ScriptError("Choose a script, profiles, and a JSON object for inputs");
        }
        const concurrency = request.concurrency === undefined ? 10 : request.concurrency;
        if (!Number.isSafeInteger(concurrency) || concurrency < 1)
            throw new ScriptError("Parallel browsers must be a positive whole number");
        const activeCount = [...this.runs.values()].filter((entry) => entry.view.status !== "finished").length;
        if (activeCount >= this.maxConcurrentRuns)
            throw new ScriptError("A script is already running", 409);
        const uniqueProfileIds = [...new Set(request.profileIds)];
        for (const profileId of uniqueProfileIds) {
            if (this.lockedProfiles.has(profileId))
                throw new ScriptError(`A script is already running for profile ${profileId}`, 409);
        }
        this.pruneHistory();
        mkdirSync(this.options.library.directory, { recursive: true });
        const directory = mkdtempSync(join(this.options.library.directory, "run-"));
        const runId = randomUUID();
        const run: ActiveRun = {
            view: { id: runId, scriptName: "Script", status: "running", profiles: uniqueProfileIds.map((id) => ({ id, name: id, status: "queued" })) },
            directory, logPath: join(directory, "output.log"), abort: new AbortController(), done: Promise.resolve(),
        };
        writeFileSync(run.logPath, "", { mode: 0o600 });
        for (const profileId of uniqueProfileIds)
            this.lockedProfiles.set(profileId, runId);
        this.runs.set(runId, run);
        this.latestRunId = runId;
        this.emitRunChanged(run);
        run.done = this.run(run, { ...request, concurrency });
        return structuredClone(run.view);
    }
    async stop(id?: string): Promise<ScriptRun | null> {
        if (id !== undefined) {
            const run = this.runs.get(id);
            if (!run)
                return null;
            if (run.view.status !== "finished") {
                run.view.status = "stopping";
                this.emitRunChanged(run);
                run.abort.abort();
                await run.done;
            }
            return structuredClone(run.view);
        }
        const active = [...this.runs.values()].filter((run) => run.view.status !== "finished");
        await Promise.all(active.map(async (run) => {
            run.view.status = "stopping";
            this.emitRunChanged(run);
            run.abort.abort();
            await run.done;
        }));
        return this.status();
    }
    async settled(id?: string): Promise<void> {
        if (id !== undefined) {
            await (this.runs.get(id)?.done ?? Promise.resolve());
            return;
        }
        await Promise.all([...this.runs.values()].map((run) => run.done));
    }
    async shutdown(): Promise<void> {
        this.closing = true;
        const entries = [...this.runs.values()];
        for (const run of entries)
            run.abort.abort();
        await Promise.all(entries.map((run) => run.done));
        for (const run of entries)
            rmSync(run.directory, { recursive: true, force: true });
        this.lockedProfiles.clear();
    }
    log(id: string, offset: number): {
        text: string;
        nextOffset: number;
    } {
        const run = this.runs.get(id);
        if (!run)
            throw new ScriptError("Run not found", 404);
        if (!Number.isSafeInteger(offset) || offset < 0)
            throw new ScriptError("Invalid log offset");
        const fd = openSync(run.logPath, "r");
        try {
            const buffer = Buffer.alloc(64 * 1024);
            const length = readSync(fd, buffer, 0, buffer.length, offset);
            // Keep an incomplete UTF-8 character for the next poll.
            let end = length;
            let start = length - 1;
            while (start >= 0 && (buffer[start]! & 0xc0) === 0x80)
                start--;
            const lead = buffer[start] ?? 0;
            const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
            if (start >= 0 && length - start < width && (length === buffer.length || run.view.status !== "finished"))
                end = start;
            return { text: buffer.subarray(0, end).toString("utf8"), nextOffset: offset + end };
        }
        finally {
            closeSync(fd);
        }
    }
    /**
     * Wait for the downloaded Python runtime before a Python script opens any profile. The
     * first run downloads it and writes the progress to the run log; Stop ends the wait.
     */
    private async preparePython(fd: number, signal: AbortSignal): Promise<string | undefined> {
        const python = this.options.python;
        if (!python)
            return undefined;
        if (python.installed())
            return python.executable;
        writeFileSync(fd, `Downloading the Python runtime for Python scripts (${Math.round(python.totalBytes / 1e6)} MB, once)\n`);
        let reported = -1;
        const unsubscribe = python.onProgress(({ receivedBytes, totalBytes }) => {
            const percent = Math.floor(receivedBytes * 10 / totalBytes) * 10;
            if (percent <= reported)
                return;
            reported = percent;
            writeFileSync(fd, `Python runtime download: ${percent}%\n`);
        });
        let abort = () => { };
        try {
            const executable = await Promise.race([
                python.ensure(),
                new Promise<never>((_, reject) => {
                    abort = () => reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: true });
                }),
            ]);
            writeFileSync(fd, "Python runtime ready\n");
            return executable;
        }
        catch (error) {
            signal.throwIfAborted();
            writeFileSync(fd, `Python runtime download failed: ${error instanceof Error ? error.message : String(error)}\n`);
            throw new ScriptError(PYTHON_RUNTIME_FAILED, 503);
        }
        finally {
            unsubscribe();
            signal.removeEventListener("abort", abort);
        }
    }
    private async run(run: ActiveRun, request: RunRequest & {
        concurrency: number;
    }): Promise<void> {
        const signal = run.abort.signal;
        const fd = openSync(run.logPath, "a");
        try {
            const script = await this.options.library.get(request.scriptId);
            run.view.scriptName = script.name;
            this.emitRunChanged(run);
            const python = script.language === "python" ? await this.preparePython(fd, signal) : undefined;
            if (!this.options.execute)
                await verifyScriptRuntime(script.language, { python });
            const path = join(run.directory, script.language === "python" ? "script.py" : "script.mjs");
            writeFileSync(path, script.source, { mode: 0o600 });
            const runProfile = async (item: ScriptRun["profiles"][number]) => {
                if (signal.aborted) {
                    item.status = "cancelled";
                    this.emitRunChanged(run);
                    return;
                }
                const session = new AgentControlSession(this.options, signal);
                let owned = false;
                let endpoint: string | undefined;
                const call = async (method: string) => {
                    const response = await session.enqueue(JSON.stringify({
                        protocol: AGENT_CONTROL_PROTOCOL, id: 1, method,
                        params: { profileId: item.id, ...(method === "browser.close" ? { expectedEndpoint: endpoint } : {}) },
                    }));
                    if (!response.ok)
                        throw new Error(response.error?.message ?? "Browser operation failed");
                    return response.result as {
                        ws: string;
                        ownedByConnection: boolean;
                    };
                };
                try {
                    signal.throwIfAborted();
                    item.status = "running";
                    this.emitRunChanged(run);
                    const opened = await call("browser.open") as {
                        ws?: string;
                        engine?: string;
                        ownedByConnection: boolean;
                    };
                    owned = opened.ownedByConnection;
                    endpoint = opened.ws;
                    signal.throwIfAborted();
                    const profile = this.options.store.getProfile(item.id);
                    if (!profile)
                        throw new ScriptError("Profile not found", 404);
                    item.name = profile.name;
                    this.emitRunChanged(run);
                    writeFileSync(fd, `\n--- ${profile.name || item.id} ---\n`);
                    const input = {
                        profile: { id: item.id, name: profile.name, group: profile.group, platform: profile.platform ?? "" },
                        inputs: request.inputs,
                        credentials: request.useCredentials ? Object.fromEntries(["username", "password", "email", "emailPassword", "twofa"].map((key) => [key, (profile as unknown as Record<string, string>)[key] ?? ""])) : null,
                    };
                    if (opened.engine === "firefox") {
                        const launch = this.options.store.getLaunch(item.id) as {
                            firefoxOwner?: FirefoxOwner;
                        } | null;
                        if (!launch?.firefoxOwner)
                            throw new ScriptError("Firefox browser owner is unavailable", 503);
                        const { endpoint } = await callFirefoxOwner<{
                            endpoint?: unknown;
                        }>(launch.firefoxOwner, "playwright-endpoint", {}, { signal });
                        if (typeof endpoint !== "string" || !endpoint)
                            throw new ScriptError("Firefox browser endpoint is unavailable", 503);
                        await (this.options.execute ?? executeScript)({
                            scriptPath: path, language: script.language, logFd: fd, signal, python,
                            input: { endpoint, engine: "firefox", ...input },
                        });
                    }
                    else {
                        await (this.options.execute ?? executeScript)({
                            scriptPath: path, language: script.language, logFd: fd, signal, python,
                            input: { endpoint: opened.ws!, ...input },
                        });
                    }
                    item.status = signal.aborted ? "cancelled" : "succeeded";
                    this.emitRunChanged(run);
                }
                catch (error) {
                    item.status = signal.aborted ? "cancelled" : "failed";
                    if (!signal.aborted)
                        item.error = error instanceof Error ? error.message : "Script failed";
                    this.emitRunChanged(run);
                }
                finally {
                    if (owned) {
                        try {
                            await call("browser.close");
                        }
                        catch (error) {
                            item.warning = error instanceof Error ? error.message : "Browser cleanup was not confirmed";
                            this.emitRunChanged(run);
                            // Durable browser ownership remains with the launcher; do not retry against a replacement browser.
                            await call("browser.detach").catch(() => { });
                        }
                    }
                    await session.disconnect();
                }
            };
            const profiles = run.view.profiles.values();
            await Promise.all(Array.from({ length: Math.min(request.concurrency, run.view.profiles.length) }, async () => {
                for (const item of profiles)
                    await runProfile(item);
            }));
        }
        catch (error) {
            for (const item of run.view.profiles.filter((item) => item.status === "queued")) {
                item.status = signal.aborted ? "cancelled" : "failed";
                if (!signal.aborted)
                    item.error = error instanceof Error ? error.message : "Script could not start";
            }
            this.emitRunChanged(run);
        }
        finally {
            closeSync(fd);
            run.view.status = "finished";
            for (const item of run.view.profiles) {
                if (this.lockedProfiles.get(item.id) === run.view.id)
                    this.lockedProfiles.delete(item.id);
            }
            this.emitRunChanged(run);
        }
    }
}
