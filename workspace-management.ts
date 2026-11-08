import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { StatePaths } from "./paths.ts";
import type { ScriptSupervisor } from "./scripts.ts";
import { validAgentAuthorization } from "./agent-control.ts";
import { WorkspaceCatalog, writeWorkspaceJson } from "./workspaces.ts";
import { WorkspaceBackupService } from "./workspace-backups.ts";
import { WorkspaceBusyError, WorkspaceMaintenance, workspaceRequestMutates } from "./workspace-maintenance.ts";
import { GROUP_DISCLOSURE_KEY, isGroupDisclosureValue } from "./profile-group-state.ts";

const PREFIX = "/ui/api/workspace";
const MAX_JSON_BYTES = 16 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface WorkspaceManagementOptions {
  home: string;
  paths: StatePaths;
  store: ProfileStore;
  launcher: Launcher;
  agentNonce?: string;
}

/** Management has one authoritative context for both HTTP servers and agent sockets. */
export class WorkspaceManagement {
  readonly catalog: WorkspaceCatalog;
  readonly maintenance = new WorkspaceMaintenance();
  readonly backups: WorkspaceBackupService;
  private readonly token = randomBytes(32).toString("hex");
  private scripts?: ScriptSupervisor;
  private upload: Promise<Response> | null = null;
  private cleanups = new Set<Promise<unknown>>();
  private activationRelease: (() => void) | null = null;
  private overviewScan?: { time: number; promise: Promise<number> };
  private preferenceWrite: Promise<unknown> = Promise.resolve();

  constructor(readonly options: WorkspaceManagementOptions) {
    this.catalog = new WorkspaceCatalog(resolve(options.home), resolve(options.paths.root));
    this.backups = new WorkspaceBackupService({
      catalog: this.catalog,
      assertIdle: () => this.assertIdle(),
      exclusive: (work) => this.maintenance.exclusive(work),
    });
    options.launcher.setWorkspaceMaintenanceGuard?.(() => this.maintenance.assertWritable());
  }

  attachScripts(scripts?: ScriptSupervisor): void { this.scripts = scripts; }
  async settled(): Promise<void> {
    await this.upload?.catch(() => {});
    await Promise.all(this.backups.jobs().filter((job) => job.status === "queued" || job.status === "running").map((job) => this.backups.wait(job.id)));
    await Promise.allSettled([...this.cleanups]);
  }
  currentId(): string { return this.catalog.currentId(); }
  mutation<T>(work: () => Promise<T>): Promise<T> { return this.maintenance.mutation(work); }
  async cleanup<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.maintenance.cleanup(work); this.cleanups.add(pending);
    try { return await pending; } finally { this.cleanups.delete(pending); }
  }

  /** The management routes acquire their own barrier; other writes share this lease. */
  async dispatch(request: Request, next: () => Promise<Response>): Promise<Response> {
    if (this.isManagementPath(new URL(request.url).pathname)) return next();
    if (!workspaceRequestMutates(request)) return next();
    try { return await this.mutation(next); }
    catch (error) {
      if (error instanceof WorkspaceBusyError) return json({ ok: false, code: "workspace_busy", error: error.message }, 423);
      throw error;
    }
  }

  isManagementPath(path: string): boolean { return path === PREFIX || path.startsWith(PREFIX + "/") || path === PREFIX + "s" || path.startsWith(PREFIX + "s/"); }
  private scriptRunning(): boolean { const run = this.scripts?.status(); return !!run && run.status !== "finished"; }
  private async assertIdle(): Promise<void> {
    if (this.scriptRunning()) throw new WorkspaceBusyError("Stop the running script before backing up or switching this workspace.");
    const ids = new Set([...this.options.store.listProfiles().map((p) => p.id), ...this.options.store.listTrashed().map((p) => p.id), ...this.options.store.listLaunches().map((p) => p.profileId)]);
    if (this.options.store.listLaunches().length || [...ids].some((id) => this.options.launcher.profileDeletionBlocked(id))) {
      throw new WorkspaceBusyError("Close running browsers and wait for pending browser operations before continuing.");
    }
  }

  private authorized(request: Request): boolean {
    if (this.options.agentNonce && validAgentAuthorization(request.headers.get("authorization"), this.options.agentNonce)) return true;
    const url = new URL(request.url);
    // A query capability is accepted only for the browser's native attachment download.
    const supplied = request.headers.get("X-Maobu-Workspace-Capability")
      ?? (request.method === "GET" && /\/backups\/bak_[a-f0-9]{32}\/download$/.test(url.pathname) ? url.searchParams.get("capability") : null);
    return typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw Object.assign(new Error("application/json is required"), { status: 415 });
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_JSON_BYTES) throw Object.assign(new Error("Workspace request is too large"), { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw Object.assign(new Error("Workspace request is too large"), { status: 413 });
    const body: unknown = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Workspace request must be a JSON object");
    return body as Record<string, unknown>;
  }

  private jobView(job: any): Record<string, unknown> {
    return {
      ...job,
      kind: job.kind ?? (job.type === "create" ? "backup" : "restore"),
      completed: typeof job.completed === "number" ? job.completed : job.completedBytes ?? job.completedFiles ?? 0,
      total: typeof job.total === "number" ? job.total : job.totalBytes ?? job.totalFiles ?? 0,
      result: {
        ...(job.backupId ? { backupId: job.backupId } : {}),
        ...(job.restoredWorkspaceId ? { workspaceId: job.restoredWorkspaceId } : {}),
        ...(job.result ?? {}),
      },
    };
  }

  private async preferences(): Promise<Record<string, string>> {
    const path = join(this.options.paths.root, "workspace-settings.json");
    let entry;
    try { entry = await lstat(path); } catch (error: any) { if (error?.code === "ENOENT") return {}; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 32 * 1024) throw new Error("Workspace display settings could not be read");
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) throw new Error("Workspace display settings could not be read");
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.values)) { this.validatePreference(key, value); values[key] = value as string; }
    return values;
  }

  private validatePreference(key: unknown, value: unknown): void {
    if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid workspace display preference");
    if (key === "aliasmode.roster.pageSize" && ["20", "25", "50", "100", "200"].includes(value)) return;
    if (key === "aliasmode.shell.sidebarCollapsed" && ["0", "1"].includes(value)) return;
    if (key === GROUP_DISCLOSURE_KEY && isGroupDisclosureValue(value)) return;
    if (key === "aliasmode.roster.hiddenColumns") {
      const parsed: unknown = JSON.parse(value);
      const known = ["no", "name", "group", "platform", "tags", "proxy", "status", "action"];
      if (Array.isArray(parsed) && parsed.length <= known.length && parsed.every((item) => known.includes(item)) && new Set(parsed).size === parsed.length) return;
    }
    throw new Error("Invalid workspace display preference");
  }

  private async savePreference(body: Record<string, unknown>): Promise<void> {
    this.validatePreference(body.key, body.value);
    await this.maintenance.mutation(() => {
      const pending = this.preferenceWrite.then(async () => {
        const values = await this.preferences();
        values[body.key as string] = body.value as string;
        this.catalog.pathFor(this.currentId());
        writeWorkspaceJson(join(this.options.paths.root, "workspace-settings.json"), { version: 1, values });
      });
      this.preferenceWrite = pending.catch(() => {});
      return pending;
    });
  }

  private async workspaceBytes(): Promise<number> {
    if (this.overviewScan && Date.now() - this.overviewScan.time < 10_000) return this.overviewScan.promise;
    const root = this.options.paths.root;
    const scan = async (path: string): Promise<number> => {
      let entry;
      try { entry = await lstat(path); } catch (error: any) { if (error?.code === "ENOENT") return 0; throw error; }
      if (entry.isSymbolicLink()) return 0;
      if (entry.isFile()) return entry.size;
      if (!entry.isDirectory()) return 0;
      let bytes = 0;
      for (const child of await readdir(path)) bytes += await scan(join(path, child));
      return bytes;
    };
    const promise = (async () => {
      let bytes = 0;
      for (const name of ["profiles.sqlite", "profiles.sqlite-wal", "profiles.sqlite-shm", "profiles", "extensions", "custom-scripts", "inbox", "config.json", "shell.json"])
        bytes += await scan(join(root, name));
      return bytes;
    })();
    this.overviewScan = { time: Date.now(), promise };
    try { return await promise; } catch (error) { this.overviewScan = undefined; throw error; }
  }

  async overview(): Promise<Record<string, unknown>> {
    const run = this.scripts?.status();
    const records = this.backups.listBackups();
    return {
      ok: true, workspaceId: this.currentId(), root: this.options.paths.root,
      profileCount: this.options.store.count(), groupCount: this.options.store.listGroups().length,
      trashCount: this.options.store.listTrashed().length, runningCount: this.options.store.listLaunches().length,
      bytes: await this.workspaceBytes(), freeBytes: await this.options.launcher.dataDriveFreeBytes(),
      lastBackupAt: records.reduce((latest, record) => Math.max(latest, Number(record.createdAt) || 0), 0) || null,
      backupBusy: this.backups.busy() || !!this.upload, uploading: !!this.upload, maintenance: this.maintenance.label(), scriptRunning: !!run && run.status !== "finished",
    };
  }

  private async activate(id: string, closeRunning: boolean): Promise<Response> {
    if (this.upload) throw new WorkspaceBusyError("Wait for the backup upload to finish before switching workspaces.");
    if (id === this.currentId()) return json({ ok: true, restartRequired: false, workspaceId: id });
    // Validate destination before closing anything in the current workspace.
    const destination = this.catalog.list().find((workspace) => workspace.id === id);
    if (!destination || destination.archived) return json({ ok: false, error: "Choose an available workspace" }, 404);
    const release = await this.maintenance.acquire("switch");
    try {
      if (closeRunning) {
        await this.scripts?.stop();
        const launches = this.options.store.listLaunches();
        const stopped = await Promise.allSettled(launches.map(async (launch) => {
          if (!await this.options.launcher.stop(launch.profileId)) throw new Error("A browser could not be closed safely");
          await this.options.launcher.cacheCleanupSettled(launch.profileId);
        }));
        if (stopped.some((result) => result.status === "rejected")) throw new WorkspaceBusyError("Some browsers could not be closed safely. The workspace has not changed.");
      }
      await this.assertIdle();
      this.catalog.setActive(id);
      this.activationRelease = release;
      return json({ ok: true, restartRequired: true, workspaceId: id });
    } catch (error) { release(); throw error; }
  }

  private async restore(request: Request): Promise<Response> {
    this.maintenance.assertWritable();
    if (this.upload || this.backups.busy()) throw new WorkspaceBusyError("A workspace backup or restore is already running.");
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.startsWith("application/json")) {
      const body = await this.body(request);
      this.maintenance.assertWritable();
      if (this.upload || this.backups.busy()) throw new WorkspaceBusyError("A workspace backup or restore is already running.");
      if (typeof body.backupId !== "string") throw new Error("Choose a backup to restore");
      return json({ ok: true, job: this.jobView(this.backups.startRestore({ backupId: body.backupId, ...(typeof body.name === "string" ? { name: body.name } : {}) })) }, 202);
    }
    const pending = this.maintenance.mutation(() => this.receiveArchive(request, type));
    this.upload = pending;
    try { return await pending; } finally { this.upload = null; }
  }

  private async receiveArchive(request: Request, type: string): Promise<Response> {
    if (!type.startsWith("application/octet-stream")) {
      return json({ ok: false, error: "Upload a workspace backup file" }, 415);
    }
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_UPLOAD_BYTES) return json({ ok: false, error: "Backup files must be smaller than 20 GB" }, 413);
    const directory = join(this.options.paths.root, "backups", ".uploads");
    const backupDirectory = await lstat(this.backups.directory);
    if (!backupDirectory.isDirectory() || backupDirectory.isSymbolicLink()) throw new Error("The backup directory is unsafe");
    await mkdir(directory, { recursive: true });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("The backup upload directory is unsafe");
    const path = join(directory, `upload_${randomBytes(16).toString("hex")}.mqbackup`);
    try {
      this.catalog.pathFor(this.currentId());
      const stream = request.body;
      if (!stream) throw new Error("The backup file is empty");
      const reader = stream.getReader();
      let size = 0;
      try {
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        const sink = Bun.file(path).writer();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_UPLOAD_BYTES) throw new Error("Backup files must be smaller than 20 GB");
            sink.write(chunk.value);
            await sink.flush();
          }
        } finally { await sink.end(); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!size) throw new Error("The backup file is empty");
      const job = this.backups.startRestore({ archivePath: path });
      void this.backups.wait(job.id).finally(() => rm(path, { force: true })).catch(() => {});
      return json({ ok: true, job: this.jobView(job) }, 202);
    } catch (error) { await rm(path, { force: true }); throw error; }
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!this.isManagementPath(url.pathname)) return null;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase()))
      return json({ ok: false, error: "Workspace management requires a loopback host" }, 403);
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")
      return json({ ok: false, error: "Cross-origin workspace requests are forbidden" }, 403);
    if (url.pathname === PREFIX + "/capability" && request.method === "GET") return json({ ok: true, token: this.token });
    if (!this.authorized(request)) return json({ ok: false, error: "Workspace authorization failed" }, 401);
    try {
      if (url.pathname === PREFIX + "s" && request.method === "GET")
        return json({ ok: true, currentId: this.currentId(), activeId: this.catalog.activeId(), workspaces: this.catalog.list() });
      if (url.pathname === PREFIX + "s" && request.method === "POST") {
        const body = await this.body(request);
        return await this.maintenance.mutation(async () => json({ ok: true, workspace: this.catalog.create(body as any) }, 201));
      }
      if (url.pathname === PREFIX + "s/activation/cancel" && request.method === "POST") {
        await this.body(request);
        if (this.activationRelease) {
          this.catalog.setActive(this.currentId());
          this.activationRelease(); this.activationRelease = null;
        }
        return json({ ok: true });
      }
      const workspace = /^\/ui\/api\/workspaces\/([^/]+)(?:\/(archive|activate))?$/.exec(url.pathname);
      if (workspace) {
        const id = workspace[1]!;
        const operation = workspace[2];
        if (!operation && request.method === "PATCH") {
          const body = await this.body(request);
          return await this.maintenance.mutation(async () => json({ ok: true, workspace: this.catalog.update(id, body as any) }));
        }
        if (operation === "archive" && request.method === "POST") {
          const body = await this.body(request);
          if (typeof body.archived !== "boolean") throw new Error("Choose whether to archive or restore the workspace");
          return await this.maintenance.mutation(async () => json({ ok: true, workspace: this.catalog.archive(id, body.archived as boolean) }));
        }
        if (operation === "activate" && request.method === "POST") {
          const body = await this.body(request);
          return await this.activate(id, body.closeRunning === true);
        }
      }
      if (url.pathname === PREFIX + "/overview" && request.method === "GET") return json(await this.overview());
      if (url.pathname === PREFIX + "/preferences" && request.method === "GET") return json({ ok: true, preferences: await this.preferences() });
      if (url.pathname === PREFIX + "/preferences" && request.method === "POST") { await this.savePreference(await this.body(request)); return json({ ok: true }); }
      if (url.pathname === PREFIX + "/backups" && request.method === "GET") return json({ ok: true, backups: this.backups.listBackups().map(({ path: _path, ...record }: any) => record), jobs: this.backups.jobs().map((job) => this.jobView(job)) });
      if (url.pathname === PREFIX + "/backups" && request.method === "POST") {
        await this.body(request);
        this.maintenance.assertWritable();
        if (this.upload) throw new WorkspaceBusyError("Wait for the backup upload to finish before creating a backup.");
        return json({ ok: true, job: this.jobView(this.backups.startCreate()) }, 202);
      }
      if (url.pathname === PREFIX + "/restore" && request.method === "POST") return await this.restore(request);
      const job = /^\/ui\/api\/workspace\/jobs\/(job_[a-f0-9]{32})$/.exec(url.pathname);
      if (job && request.method === "GET") {
        const current = this.backups.getJob(job[1]!);
        return current ? json({ ok: true, job: this.jobView(current) }) : json({ ok: false, error: "Workspace job was not found" }, 404);
      }
      const download = /^\/ui\/api\/workspace\/backups\/(bak_[a-f0-9]{32})\/download$/.exec(url.pathname);
      if (download && request.method === "GET") {
        const file = this.backups.getBackupFile(download[1]!);
        let hash = file.sha256;
        if (!hash) { const digest = createHash("sha256"); for await (const chunk of createReadStream(file.path)) digest.update(chunk); hash = digest.digest("hex"); }
        return new Response(Bun.file(file.path), { headers: { ...NO_STORE, "Content-Type": "application/octet-stream", "Content-Length": String(file.size), "Content-Disposition": `attachment; filename="${download[1]}.mqbackup"`, "X-Backup-SHA256": hash } });
      }
      return json({ ok: false, error: "Unknown workspace operation" }, 404);
    } catch (error: any) {
      return json({ ok: false, ...(error instanceof WorkspaceBusyError ? { code: "workspace_busy" } : {}), error: detail(error) }, Number.isInteger(error?.status) ? error.status : 400);
    }
  }
}
