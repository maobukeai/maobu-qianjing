#!/usr/bin/env bun
/** Local browser profile manager and desktop sidecar. */

import { parseExport, decodeText, splitRecords } from "./parse.ts";
import { ProfileStore } from "./store.ts";
import { Launcher } from "./launcher.ts";
import { linuxChromiumSandboxBlocked } from "./aliasmode-chromium.ts";
import { AutofillBridge } from "./autofill-bridge.ts";
import { defaultPlaywrightRuntimeRoot, runPlaywrightWorker, verifyPlaywrightRuntime } from "./playwright-runtime.ts";
import { isStandaloneRequestAuthorized, serveDashboard, serveDesktopAutomationApi } from "./web.ts";
import { LifecycleAdmissionController, type LifecycleAdmissionOptions } from "./lifecycle-admission.ts";
import { playwrightTransportAttribution, readSession, readSessionInSubprocess, READ_SESSION_WORKER_ARG, runReadSessionWorker, writeSession } from "./session.ts";
import { importBuffers, importInbox, watchInbox } from "./inbox.ts";
import { ensureStateDirectories, resolveStateRoot, statePaths, type StatePaths } from "./paths.ts";
import { migrateLegacyState, type LegacyMigrationResult, type MigrationOptions } from "./migration.ts";
import { AppConfigStore } from "./app-config.ts";
import { AppSettingsStore } from "./app-settings.ts";
import { createLocalProxyPreflight } from "./local-proxy-preflight.ts";
import { runDiagnostics } from "./diagnose.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDuckDuckGoDefault } from "./search-provider.ts";
import { installCloakBrowser } from "./browser-install.ts";
import { installFirefox } from "./firefox-install.ts";
import { applySourceRuntime, setupSourceRuntime } from "./source-runtime.ts";
import { ALIASMODE_VERSION } from "./version.ts";
import { DESKTOP_PROTOCOL, DESKTOP_SESSION_HEADER, ManagedDesktopRuntime, agentControlNonce, desktopAutomationToken, desktopDashboardSession, desktopHealthMetadata, desktopReadyRecord, isDesktopShutdownCommand, type DesktopHealthMetadata } from "./desktop-runtime.ts";
import { WorkspaceManagement } from "./workspace-management.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export const CLOAKPIT_IMPORT_COMMAND = "__import-cloakpit";

const IMPORT_RESTRICTION = "Windows DPAPI protects persisted browser secrets, so this import works only for the same Windows machine and account. Persisted persona fields are preserved, but runtime or browser differences can change the account-visible fingerprint.";

export async function runCloakpitImportCommand(
  args: string[],
  migrate: (source: string, destination: StatePaths, options?: MigrationOptions) => Promise<LegacyMigrationResult> = migrateLegacyState,
): Promise<{ ok: boolean; message: string }> {
  const source = flag(args, "source") ?? (existsSync(join("C:\\Cloakpit", "profiles.sqlite")) ? "C:\\Cloakpit" : undefined);
  if (!source) return { ok: false, message: `No Cloakpit source was selected. Pass an explicit source path. ${IMPORT_RESTRICTION}` };
  try {
    const result = await migrate(source, statePaths(resolveStateRoot(args)), {
      profileRoot: flag(args, "cloakpit-profile-root"),
    });
    if (result.status === "not_found") {
      return { ok: false, message: `No profiles.sqlite was found in ${resolve(source)}. ${IMPORT_RESTRICTION}` };
    }
    return {
      ok: true,
      message: `Imported ${result.profileCount} Cloakpit profile(s). ${IMPORT_RESTRICTION}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${detail}. ${IMPORT_RESTRICTION}` };
  }
}

export function lifecycleAdmissionOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): LifecycleAdmissionOptions {
  const options: LifecycleAdmissionOptions = {};
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const limit = read("ALIASMODE_LIFECYCLE_CAP");
  const queueWaitMs = read("ALIASMODE_LIFECYCLE_WAIT_MS");
  if (limit !== undefined) options.limit = limit;
  if (queueWaitMs !== undefined) options.queueWaitMs = queueWaitMs;
  return options;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function startMemoryAttributionLog(): void {
  const report = () => {
    const memory = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const transports = playwrightTransportAttribution();
    console.log("[memory] rss=" + mb(memory.rss) + "MB heap=" + mb(memory.heapUsed) + "/" + mb(memory.heapTotal) + "MB" +
      " parentTransports=" + transports.active + "/" + transports.opened + "/" + transports.closed + " forcedTransports=" + transports.forced);
  };
  report();
  const timer = setInterval(report, 60_000);
  timer.unref?.();
}

function attachDesktopControl(
  runtime: ManagedDesktopRuntime,
  health: DesktopHealthMetadata,
  port: number,
): void {
  let input = "";
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    void runtime.shutdown()
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-complete", nonce: health.instance })}\n`,
          () => process.exit(0),
        );
      })
      .catch((error) => {
        console.error(`desktop shutdown cleanup unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
        process.stdout.write(
          `${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-failed", nonce: health.instance })}\n`,
          () => process.exit(1),
        );
      });
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    for (; ;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (isDesktopShutdownCommand(line, health.instance)) shutdown();
    }
  });
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(`${JSON.stringify(desktopReadyRecord(health.instance, port))}\n`);
}

const UNSAFE_CANARY_TIMEOUT_MS = 600_000;

function makeLauncher(
  store: ProfileStore,
  rest: string[],
  defaultDataRoot = "profiles",
  // Browser runtimes are downloaded only when a profile is explicitly opened.
  chromiumRuntimeRoot?: string,
  settingsPath?: string,
): Launcher {
  const unsafeCanary = has(rest, "unsafe-disable-identity-gates");
  const autofill = new AutofillBridge(store);
  autofill.listen();
  const preferences = settingsPath ? new AppSettingsStore(settingsPath) : undefined;
  return new Launcher({
    store,
    autofill,
    ...(preferences ? { checkLocalProxyBeforeLaunch: createLocalProxyPreflight(() => preferences.read()) } : {}),
    ...(preferences ? { chromiumPreloading: () => preferences.read().network?.chromiumPreloading ?? "browser-default" } : {}),
    dataRoot: defaultDataRoot,
    ...(chromiumRuntimeRoot ? { chromiumRuntimeRoot } : {}),
    headless: has(rest, "headless"),
    // Explicit canary-only escape hatch for constrained test hosts where a
    // full browser identity probe cannot complete. Never enable in production.
    unsafeDisableIdentityGates: unsafeCanary,
    ...(unsafeCanary ? { cdpReadyTimeoutMs: UNSAFE_CANARY_TIMEOUT_MS } : {}),
    // AliasMode owns the browser process, but it is not the external campaign
    // client that requested it. Keep the ownership namespaces distinct so that
    // client can identify a dead browser while AliasMode stays up.
    // A forwarded external launcher marker remains in launchArgs untouched.
    // Containers with user namespaces disabled can opt out of Chromium's
    // sandbox explicitly; normal hosts keep the sandbox enabled by default.
    baseArgs: [
      `--aliasmode-launcher-pid=${process.pid}`,
      ...(has(rest, "no-sandbox") ? ["--no-sandbox"] : []),
    ],
    ...(process.platform === "linux" && !has(rest, "no-sandbox") ? { chromiumSandboxBlocked: () => linuxChromiumSandboxBlocked() } : {}),
    ...(unsafeCanary ? {} : { ensureSearchProvider: ensureDuckDuckGoDefault }),
  });
}

async function importPath(store: ProfileStore, target: string | undefined, defaultInbox: string): Promise<void> {
  // No arg, or a directory → import the inbox / that directory.
  if (!target || target.startsWith("--") || isDir(target ?? "")) {
    const dir = !target || target.startsWith("--") ? defaultInbox : target;
    const r = await importInbox(store, dir);
    console.log(`imported ${r.profiles} profile(s) from ${r.files} file(s) in ${dir}; stripped ${r.cookiesStripped} extension cookie(s); reported ${r.errors.length} invalid record(s)`);
    return;
  }
  // A single file.
  const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
  const result = await importBuffers(store, [{ name: target, bytes }]);
  console.log(
    `imported ${result.profiles} profile(s) from ${target}; stripped ${result.cookiesStripped} ` +
    `extension cookie(s); skipped ${result.skipped}; reported ${result.errors.length} invalid record(s)`,
  );
}

export async function dispatchReadSessionWorker(
  argv: string[],
  deps: Parameters<typeof runReadSessionWorker>[1] = {
    readSession,
    write: (value) => Bun.write(Bun.stdout, value),
    exit: (code) => process.exit(code),
  },
): Promise<boolean> {
  if (argv[0] !== READ_SESSION_WORKER_ARG) return false;
  await runReadSessionWorker(argv, deps);
  return true;
}

export interface CompiledSidecarSmokeDeps {
  writeSession: (endpoint: string, bundle: string) => Promise<void>;
  readSession: (endpoint: string) => Promise<string>;
  navigate: (endpoint: string) => Promise<void>;
  assertAlive: (endpoint: string) => Promise<void>;
  webSocketEndpoint: (endpoint: string) => Promise<string>;
}

async function assertCdpAlive(endpoint: string): Promise<void> {
  const versionUrl = new URL(endpoint);
  if (versionUrl.protocol !== "http:" && versionUrl.protocol !== "https:") {
    throw new Error("compiled sidecar smoke requires an HTTP CDP endpoint");
  }
  versionUrl.pathname = "/json/version";
  versionUrl.search = "";
  versionUrl.hash = "";
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("compiled sidecar smoke lost the CDP endpoint");
}

async function currentCdpWebSocketEndpoint(endpoint: string): Promise<string> {
  const versionUrl = new URL(endpoint);
  if (versionUrl.protocol !== "http:" && versionUrl.protocol !== "https:") {
    throw new Error("compiled sidecar smoke requires an HTTP CDP endpoint");
  }
  versionUrl.pathname = "/json/version";
  versionUrl.search = "";
  versionUrl.hash = "";
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("compiled sidecar smoke could not resolve the CDP websocket");
  const body = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || !/^wss?:\/\//.test(body.webSocketDebuggerUrl)) {
    throw new Error("compiled sidecar smoke received an invalid CDP websocket");
  }
  return body.webSocketDebuggerUrl;
}

async function navigateSmokePage(endpoint: string): Promise<void> {
  await runPlaywrightWorker("navigate", {
    endpoint,
    urls: ["about:blank"],
    connectTimeoutMs: 30_000,
  });
}

export async function runCompiledSidecarSmoke(
  endpoint: string,
  deps: CompiledSidecarSmokeDeps = {
    writeSession,
    readSession: readSessionInSubprocess,
    navigate: navigateSmokePage,
    assertAlive: assertCdpAlive,
    webSocketEndpoint: currentCdpWebSocketEndpoint,
  },
): Promise<void> {
  const smokeCookie = {
    name: "aliasmode_smoke",
    value: "live",
    domain: ".x.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };
  const smokeBundle = JSON.stringify({
    cookies: [smokeCookie],
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [{ name: "aliasmode_smoke", value: "live" }],
    }],
  });
  await deps.writeSession(endpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  // The second authoritative write exercises cookie clearing against pre-existing browser state.
  await deps.writeSession(endpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  // Exercise the current identity-bound websocket transport too.
  const webSocketEndpoint = await deps.webSocketEndpoint(endpoint);
  await deps.writeSession(webSocketEndpoint, smokeBundle);
  await deps.assertAlive(endpoint);
  await deps.navigate(endpoint);
  await deps.assertAlive(endpoint);
  const bundle = JSON.parse(await deps.readSession(endpoint));
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.cookies)) {
    throw new Error("compiled sidecar capture returned an invalid session bundle");
  }
  if (!bundle.cookies.some((cookie: any) => cookie?.name === smokeCookie.name && cookie?.value === smokeCookie.value)) {
    throw new Error("compiled sidecar capture lost the restored cookie");
  }
  await deps.assertAlive(endpoint);
}

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;

/** Mirror console output to <root>/logs/aliasmode-<date>.log (rotates at 2 MB). Best-effort. */
function installFileLogging(root: string): void {
  try {
    const dir = join(root, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `aliasmode-${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(file, `${new Date().toISOString()} sidecar start v${ALIASMODE_VERSION} pid=${process.pid}\n`);
    const write = (stream: NodeJS.WriteStream, args: unknown[]) => {
      try {
        const line = new Date().toISOString() + " " + args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n";
        if (statSync(file).size > MAX_LOG_FILE_BYTES) renameSync(file, file.replace(/\.log$/, ".1.log"));
        appendFileSync(file, line);
      } catch {
        try { appendFileSync(file, new Date().toISOString() + " " + args.join(" ") + "\n"); } catch { }
      }
      stream.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
    };
    console.log = (...args: unknown[]) => write(process.stdout, args);
    console.error = (...args: unknown[]) => write(process.stderr, args);
  } catch {
    // Logging must never break startup.
  }
}

function installLocalShutdown(runtime: ManagedDesktopRuntime): void {
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    void runtime.shutdown().then(() => process.exit(0)).catch(() => {
      console.error("Local browser cleanup could not be confirmed");
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function matchesHexSecret(supplied: string | null, expected: string): boolean {
  return supplied !== null && /^[a-f0-9]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

async function startLocalServer(
  rest: string[], paths: StatePaths, dbPath: string, profileDataRoot: string, appConfig: AppConfigStore,
  health: DesktopHealthMetadata | null, nonce: string | null, importOnStart: boolean,
  desktopAccess?: { dashboardSession: string; automationToken?: string },
  standaloneAccessToken?: string,
): Promise<void> {
  const store = new ProfileStore(dbPath);
  const workspaceHome = resolve(flag(rest, "workspace-home") ?? paths.root);
  const admission = new LifecycleAdmissionController(lifecycleAdmissionOptionsFromEnv());
  console.log("local mode: preparing browser recovery");
  console.log("startup: initializing autofill bridge");
  const launcher = makeLauncher(store, rest, profileDataRoot, join(workspaceHome, "runtimes"), join(paths.root, "app-settings.json"));
  console.log("startup: checking " + store.listLaunches().length + " saved browser process(es)");
  await launcher.reconcileOrphans();
  console.log("startup: verifying surviving local browsers");
  await launcher.certifySurvivors();
  console.log("startup: browser recovery checks complete");
  startMemoryAttributionLog();
  const workspaceManagement = new WorkspaceManagement({
    home: workspaceHome,
    paths,
    store,
    launcher,
    agentNonce: nonce ?? undefined,
    authorizeSession: (request) => {
      if (desktopAccess?.dashboardSession) {
        return matchesHexSecret(request.headers.get(DESKTOP_SESSION_HEADER), desktopAccess.dashboardSession);
      }
      if (standaloneAccessToken) {
        return isStandaloneRequestAuthorized(request, standaloneAccessToken);
      }
      return true;
    },
  });
  let stopInbox: (() => void) | undefined;
  if (importOnStart) {
    const imported = await importInbox(store, paths.inbox).catch((error) => {
      console.error("startup inbox import deferred: " + (error instanceof Error ? error.message : String(error)));
      return null;
    });
    if (imported) console.log("imported " + imported.profiles + " profile(s) from " + imported.files + " file(s); store holds " + store.count());
    stopInbox = watchInbox(store, paths.inbox, console.log, { canImport: () => !workspaceManagement.maintenance.busy(), admit: (work) => workspaceManagement.mutation(work) });
  }
  const requestedWorkspaceId = flag(rest, "workspace-id");
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceManagement.currentId()) throw new Error("The desktop workspace does not match its data directory");
  if (workspaceManagement.catalog.activeId() === workspaceManagement.currentId()) workspaceManagement.catalog.setActive(workspaceManagement.currentId());
  const automationServer = desktopAccess?.automationToken ? serveDesktopAutomationApi({
    launcher, store, lifecycleAdmission: admission, appConfig, workspaceManagement, automationToken: desktopAccess.automationToken,
  }) : undefined;
  const server = serveDashboard({
    launcher, store, port: Number(flag(rest, "port") ?? 50400), lifecycleAdmission: admission, appConfig, paths,
    health, agentNonce: nonce ?? undefined, workspaceManagement, workspaceHome, runtimeInventory: launcher.browserRuntimeDeployment,
    dashboardSession: desktopAccess?.dashboardSession,
    accessToken: standaloneAccessToken,
  });
  if (!health && standaloneAccessToken && server.port) {
    console.log(`dashboard access URL: http://127.0.0.1:${server.port}/?token=${standaloneAccessToken}`);
    console.log("standalone access token required (pass --no-auth or MAOBU_NO_AUTH=1 to disable)");
  }
  const runtime = new ManagedDesktopRuntime({ server, automationServer, admission, store, launcher, stopInbox });
  if (health) {
    if (!server.port) throw new Error("desktop sidecar did not receive a loopback port");
    attachDesktopControl(runtime, health, server.port);
  } else installLocalShutdown(runtime);
}

async function main() {
  const argv = process.argv.slice(2);
  const commands = new Set(["setup", "install-browser", "start", "import", "inspect", "serve", "diagnose", "list", "__sidecar-smoke", CLOAKPIT_IMPORT_COMMAND, READ_SESSION_WORKER_ARG]);
  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
    console.log("commands: setup | install-browser | start | import [file|dir] | inspect <file> | serve | diagnose | list");
    return;
  }
  if (!commands.has(argv[0])) {
    console.error("Unsupported command. This build contains local commands only.");
    process.exitCode = 1;
    return;
  }
  if (argv[0] === CLOAKPIT_IMPORT_COMMAND) {
    const result = await runCloakpitImportCommand(argv.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    // ONLY the known Bun+Playwright ws-upgrade noise is non-fatal. Anything
    // else (a DB failure, an unhandled launcher path) is a real bug — surface it
    // loudly and exit rather than masking it as "(non-fatal)" and continuing in
    // a possibly-corrupt state. The desktop enters a static degraded state.
    if (msg.includes("not implemented in bun") || msg.includes("WebSocket 'upgrade'")) {
      console.error("[aliasmode] (non-fatal) Bun ws-upgrade noise");
      return;
    }
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    console.error(`[aliasmode] FATAL unhandled rejection: ${detail}`);
    process.exit(1);
  });
  const compiled = typeof ALIASMODE_COMPILED !== "undefined" && ALIASMODE_COMPILED === true;
  if (compiled) {
    const runtime = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME?.trim() || defaultPlaywrightRuntimeRoot();
    process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = runtime;
    await verifyPlaywrightRuntime(runtime);
  }
  if (await dispatchReadSessionWorker(argv)) return;
  const [cmd, ...rest] = argv;
  const paths = statePaths(resolveStateRoot(rest));
  if (cmd === "setup") {
    ensureStateDirectories(paths);
    try {
      await setupSourceRuntime(paths.root);
    } catch (error) {
      // Setup errors describe downloads, hashes, and disk space, never credentials.
      console.error(`[aliasmode] setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
    console.log(`猫步·千境源码运行环境已准备就绪。请重新启动猫步·千境：\n  bun cli.ts start --state-root ${paths.root}`);
    return;
  }
  if (!compiled) applySourceRuntime(paths.root);
  if (!compiled && (cmd === "start" || cmd === "serve")) {
    try {
      await verifyPlaywrightRuntime();
    } catch (error) {
      console.error(`[aliasmode] ${error instanceof Error ? error.message : "source Playwright runtime is unavailable"}`);
      console.error("[aliasmode] Run bun cli.ts setup to install the verified source runtime.");
      throw error;
    }
  }
  const desktop = has(rest, "desktop-stdio");
  installFileLogging(paths.root);
  if (desktop && cmd !== "start") throw new Error("--desktop-stdio is supported only by the start command");
  const desktopHealth = desktop
    ? desktopHealthMetadata(process.env, flag(rest, "desktop-root"))
    : null;
  const agentNonce = desktop ? agentControlNonce(process.env) : null;
  if (desktop && !agentNonce) throw new Error("ALIASMODE_AGENT_NONCE is required in desktop mode");
  const desktopAccess = desktop ? { dashboardSession: desktopDashboardSession(process.env), automationToken: desktopAutomationToken(process.env) } : undefined;
  const noAuth = has(rest, "no-auth") || process.env.MAOBU_NO_AUTH === "1";
  const standaloneToken = !desktop && (cmd === "start" || cmd === "serve") && !noAuth
    ? randomBytes(32).toString("hex")
    : undefined;
  // Do not pass desktop HTTP credentials through to browser and script children.
  delete process.env.ALIASMODE_DESKTOP_NONCE;
  delete process.env.ALIASMODE_AGENT_NONCE;
  delete process.env.MAOBU_DESKTOP_SESSION;
  delete process.env.MAOBU_DESKTOP_AUTOMATION_TOKEN;
  ensureStateDirectories(paths);
  const appConfig = new AppConfigStore(paths.config);
  const dbPath = flag(rest, "db") ? resolve(flag(rest, "db")!) : paths.database;
  const profileDataRoot = flag(rest, "data-root") ? resolve(flag(rest, "data-root")!) : paths.profiles;
  switch (cmd) {
    case "__sidecar-smoke": {
      const endpoint = flag(rest, "cdp-endpoint");
      if (!endpoint) throw new Error("compiled sidecar smoke requires --cdp-endpoint");
      await runCompiledSidecarSmoke(endpoint);
      console.log("compiled sidecar restored, navigated, and captured a session over Playwright CDP");
      break;
    }
    case "install-browser": {
      const engine = flag(rest, "engine") ?? (has(rest, "engine") ? "" : "chromium");
      if (engine === "firefox") {
        const archive = flag(rest, "archive");
        if (!archive || archive.startsWith("--")) {
          console.error("Usage: bun cli.ts install-browser --engine firefox --archive <owned-build.zip>");
          process.exitCode = 1;
          break;
        }
        try {
          const installed = await installFirefox({ archive, cwd: paths.root });
          console.log(`Firefox 已安装并固定版本：\n${installed.path}\nSHA-256 ${installed.sha256}`);
          console.log("请重新启动猫步·千境以使用该浏览器。");
        } catch (error) {
          console.error(error instanceof Error ? error.message : "Firefox 安装失败");
          process.exitCode = 1;
        }
        break;
      }
      if (engine !== "chromium") {
        console.error("Browser engine must be chromium or firefox");
        process.exitCode = 1;
        break;
      }
      console.log("Installing the official CloakBrowser binary (one-time download)...");
      const installed = await installCloakBrowser({ cwd: paths.root });
      console.log(`CloakBrowser installed and pinned:\n${installed.path}\nSHA-256 ${installed.sha256}`);
      console.log("请重新启动猫步·千境以使用该浏览器。");
      break;
    }
    case "import": {
      const store = new ProfileStore(dbPath);
      await importPath(store, rest[0], paths.inbox);
      console.log(`store now holds ${store.count()} profile(s) at ${dbPath}`);
      store.close();
      break;
    }
    case "diagnose": {
      const store = new ProfileStore(dbPath);
      const all = store.listProfiles();
      store.close();
      const profiles = all.slice(0, Number(flag(rest, "count") ?? 10));
      if (profiles.length === 0) {
        console.error("no profiles imported yet — run `import` or `start` first");
        process.exit(1);
      }
      mkdirSync(paths.reports, { recursive: true });
      const out = flag(rest, "out") ?? resolve(paths.reports, "diagnose-latest.json");
      // Write after every profile so a partial/interrupted run still leaves a
      // usable report on disk instead of nothing.
      const report = await runDiagnostics({
        baseUrl: `http://127.0.0.1:${Number(flag(rest, "port") ?? 50400)}`,
        profiles,
        relaunch: has(rest, "relaunch"),
        collectLogin: !has(rest, "no-login"),
        onProgress: (r) => writeFileSync(out, JSON.stringify(r, null, 2)),
      });
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log("\n=== VERDICTS ===");
      for (const line of report.analysis.verdicts) console.log(line);
      console.log(`\nFull report written to ${out} — forward this file for review.`);
      break;
    }
    case "inspect": {
      // Diagnostic dump that is SAFE to forward: shows field names and value
      // lengths only — never cookie/password/2FA values. The bare `id` is shown
      // because it's a non-secret profile handle and confirms parsing worked.
      const file = rest[0];
      if (!file || file.startsWith("--")) throw new Error("usage: inspect <file>");
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      const text = decodeText(bytes);
      const recs = splitRecords(text);
      const summary = parseExport(text);
      const hex = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const enc = text.length > 0 && bytes.length / text.length > 1.8 ? "utf-16(ish)" : "utf-8(ish)";
      console.log(`file: ${file}`);
      console.log(`bytes: ${bytes.length}  decodedChars: ${text.length}  firstBytes: ${hex}  encoding: ${enc}`);
      console.log(`records: ${recs.length}  parseableProfiles: ${summary.profiles.length}  skipped(no id): ${summary.skipped}`);
      if (recs[0]) {
        console.log(`record[0] id: ${JSON.stringify(recs[0].id ?? "(missing)")}`);
        const shape = Object.entries(recs[0]).map(([k, v]) => (k === "id" ? `id=${v}` : `${k}=<${v.length} chars>`));
        console.log(`record[0] fields: ${shape.join("  ")}`);
      }
      if (recs.length && !summary.profiles.length) {
        console.log(`(records found but none had an "id" field — likely a separator or field-name mismatch)`);
      } else if (!recs.length) {
        console.log(`(no records split out — check encoding (firstBytes) or the record separator)`);
      }
      break;
    }
    case "list": {
      const store = new ProfileStore(dbPath);
      for (const p of store.listProfiles()) {
        console.log(
          `${p.id}\t${p.name}\tseed=${p.fingerprintSeed}\t${p.screenWidth}x${p.screenHeight}\ttz=${p.timezone || "default"}\t` +
          `proxy=${p.proxy ? `${p.proxy.host}:${p.proxy.port}` : "none"}\tcookies=${p.cookies.length}\tseeded=${p.seeded}`,
        );
      }
      store.close();
      break;
    }
    case "start":
    case "serve": {
      await startLocalServer(rest, paths, dbPath, profileDataRoot, appConfig, desktopHealth, agentNonce, cmd === "start", desktopAccess, standaloneToken);
      break;
    }
  }
}

export function runCli(): void {
  main().catch((error) => {
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    console.error(`[aliasmode] FATAL command failure: ${detail}`);
    process.exit(1);
  });
}

if (import.meta.main) runCli();
