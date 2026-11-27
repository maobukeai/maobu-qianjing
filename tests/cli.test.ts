import { expect, test } from "bun:test";

import { CLOAKPIT_IMPORT_COMMAND, dispatchReadSessionWorker, lifecycleAdmissionOptionsFromEnv, runCompiledSidecarSmoke, runCloakpitImportCommand } from "../cli.ts";

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import net from "node:net";

import { statePaths } from "../paths.ts";

import { applySourceRuntime, type SourceRuntime } from "../source-runtime.ts";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";

async function removeTemporaryRoot(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      // Antivirus on Windows runners can hold a fresh temporary file for several seconds.
      if ((error as { code?: string }).code !== "EBUSY" || attempt === 50) throw error;
      Bun.gc(true);
      await Bun.sleep(200);
    }
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("test loopback port is unavailable");
  return address.port;
}

test("migration-only command dispatches directly and reports required restrictions", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-"));
  const calls: unknown[][] = [];
  const result = await runCloakpitImportCommand([
    "--source", "C:\\Cloakpit",
    "--state-root", root,
    "--cloakpit-profile-root", "D:\\LegacyProfiles",
  ], async (...args) => {
    calls.push(args);
    return { status: "migrated", profileCount: 2 };
  });
  expect(calls).toEqual([["C:\\Cloakpit", statePaths(root), { profileRoot: "D:\\LegacyProfiles" }]]);
  expect(result.ok).toBe(true);
  expect(result.message).toContain("DPAPI");
  expect(result.message).toContain("persona fields are preserved");
  expect(result.message).toContain("runtime or browser differences");
});

test("internal migration command exits before normal startup creates state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-main-"));
  const destination = join(parent, "destination");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "..", "cli.ts"),
    "__import-cloakpit",
    "--source", join(parent, "missing"),
    "--state-root", destination,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  expect(existsSync(destination)).toBe(false);
});

test("source start reports an unavailable managed runtime before creating application state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-node-"));
  const stateRoot = join(parent, "state");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "..", "cli.ts"),
    "start",
    "--state-root", stateRoot,
  ], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, ALIASMODE_PLAYWRIGHT_RUNTIME: join(parent, "missing-runtime") },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("packaged Playwright runtime is incomplete");
  expect(stderr).toContain("bun cli.ts setup");
  expect(existsSync(stateRoot)).toBe(false);
  await removeTemporaryRoot(parent);
});

test("source start loads a managed runtime from its custom state root before verification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-runtime-"));
  const root = join(cwd, "custom-state");
  mkdirSync(root);
  const node = Bun.which("node");
  if (!node) throw new Error("test Node runtime is unavailable");
  const runtime: SourceRuntime = {
    version: 1,
    node: resolve(node),
    chromium: { path: join(root, "managed-chromium"), sha256: "a".repeat(64) },
    firefox: { path: join(root, "managed-firefox"), sha256: "b".repeat(64) },
  };
  writeFileSync(join(root, "browser-runtime.json"), JSON.stringify(runtime));
  const applied: NodeJS.ProcessEnv = { PATH: "" };
  applySourceRuntime(root, applied);
  expect(applied.PATH).toStartWith(dirname(runtime.node));
  expect(applied.CLOAKBROWSER_BINARY_SHA256).toBe(runtime.chromium.sha256);
  expect(applied.ALIASMODE_FIREFOX_BINARY_SHA256).toBe(runtime.firefox.sha256);

  const port = await freeLoopbackPort();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "", ALIASMODE_PLAYWRIGHT_RUNTIME: "" };
  delete env.CLOAKBROWSER_BINARY_PATH;
  delete env.CLOAKBROWSER_BINARY_SHA256;
  delete env.ALIASMODE_FIREFOX_BINARY_PATH;
  delete env.ALIASMODE_FIREFOX_BINARY_SHA256;
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "..", "cli.ts"),
    "start",
    "--port", String(port),
    "--state-root", root, "--no-auth",
  ], { cwd, stdout: "pipe", stderr: "ignore", env });
  const output = new Response(child.stdout).text();
  let logs = "";
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/ui/api/health`);
        if (health.ok) break;
      } catch { }
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
    }
    expect(health?.ok).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    logs = await output;
    await removeTemporaryRoot(cwd);
  }
  expect(logs).toContain("local mode:");
});

for (const mode of ["unconfigured", "local", "cloud"] as const) {
  test(`source start reports ${mode} recovery and serves the loopback dashboard`, async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-start-"));
    if (mode !== "unconfigured") {
      writeFileSync(statePaths(stateRoot).config, JSON.stringify({
        version: 1, mode, localAnalytics: true, cloudUrl: mode === "cloud" ? "http://127.0.0.1:1" : undefined,
      }));
    }
    const port = await freeLoopbackPort();
    const child = Bun.spawn([
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "..", "cli.ts"),
      "start",
      "--port", String(port),
      "--state-root", stateRoot,
    ], {
      cwd: stateRoot,
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        HUB_URL: "",
        ALIASMODE_CLOUD_URL: "http://127.0.0.1:1",
        ALIASMODE_SUPABASE_URL: "http://127.0.0.1:1",
        ALIASMODE_SUPABASE_ANON_KEY: "source-start-fixture",
        CLOAKBROWSER_BINARY_PATH: process.execPath,
        CLOAKBROWSER_BINARY_SHA256: "0".repeat(64),
      },
    });
    let token = "";
    let sawOutput = "";
    const output = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sawOutput += decoder.decode(value, { stream: true });
        const m = sawOutput.match(/dashboard access URL: http:\/\/127\.0\.0\.1:\d+\/\?token=([a-f0-9]{64})/);
        if (m) token = m[1]!;
      }
    })();
    try {
      let health: Response | undefined;
      let unauthStatus = 0;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          if (!token) { await Bun.sleep(100); continue; }
          const unauth = await fetch(`http://127.0.0.1:${port}/ui/api/health`);
          unauthStatus = unauth.status;
          health = await fetch(`http://127.0.0.1:${port}/ui/api/health`, { headers: { Authorization: `Bearer ${token}` } });
          if (health.ok) break;
        } catch { }
        if (await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
      }
      expect(unauthStatus).toBe(401);
      expect(health?.ok).toBe(true);
      expect(await health?.json()).toMatchObject({ ok: true });
    } finally {
      child.kill();
      await child.exited;
      await output;
      await removeTemporaryRoot(stateRoot);
    }
    const logs = sawOutput;
    expect(logs).toContain("local mode:");
    expect(logs).not.toContain("NOT connected to a hub");
    const phases = ["initializing autofill bridge", "checking 0 saved browser process(es)", "browser recovery checks complete"];
    const positions = phases.map((phase) => logs.indexOf(`startup: ${phase}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(logs.includes("startup: verifying surviving local browsers")).toBe(true);
  });
}

test("compiled sidecar smoke restores before navigation and capture", async () => {
  const events: string[] = [];
  await runCompiledSidecarSmoke("http://127.0.0.1:9222", {
    async writeSession(endpoint, bundle) {
      events.push(`write:${endpoint}`);
      expect(JSON.parse(bundle)).toEqual({
        cookies: [{
          name: "aliasmode_smoke",
          value: "live",
          domain: ".x.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [{
          origin: "https://web.telegram.org",
          localStorage: [{ name: "aliasmode_smoke", value: "live" }],
        }],
      });
    },
    async assertAlive(endpoint) {
      events.push(`alive:${endpoint}`);
    },
    async webSocketEndpoint(endpoint) {
      events.push(`resolve:${endpoint}`);
      return "ws://127.0.0.1:9222/devtools/browser/current";
    },
    async navigate(endpoint) {
      events.push(`navigate:${endpoint}`);
    },
    async readSession(endpoint) {
      events.push(`read:${endpoint}`);
      return JSON.stringify({ cookies: [{ name: "aliasmode_smoke", value: "live" }] });
    },
  });
  expect(events).toEqual([
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "resolve:http://127.0.0.1:9222",
    "write:ws://127.0.0.1:9222/devtools/browser/current",
    "alive:http://127.0.0.1:9222",
    "navigate:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "read:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
  ]);
});

test("unsupported internal commands exit before binding a server or creating state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "maobu-no-cloud-command-"));
  const stateRoot = join(parent, "must-not-be-created");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "__cloud-restore-fixture", "--state-root", stateRoot], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(output).not.toContain("fixture listening");
  expect(error).toContain("local commands only");
  expect(existsSync(stateRoot)).toBe(false);
  await removeTemporaryRoot(parent);
});

test("CLI dispatches the session worker before normal command parsing", async () => {
  const events: string[] = [];
  expect(await dispatchReadSessionWorker(["list"], {
    async readSession() { throw new Error("must not run"); },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(false);
  expect(events).toEqual([]);

  expect(await dispatchReadSessionWorker(["--read-session-worker", "ws://capture"], {
    async readSession(ws) {
      expect(ws).toBe("ws://capture");
      return "captured bundle";
    },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(true);
  expect(events).toEqual([
    JSON.stringify({ ok: true, bundle: "captured bundle" }),
    "exit:0",
  ]);
});

test("lifecycle admission env config is optional and parses positive integers", () => {
  expect(lifecycleAdmissionOptionsFromEnv({})).toEqual({});
  expect(lifecycleAdmissionOptionsFromEnv({
    ALIASMODE_LIFECYCLE_CAP: "6",
    ALIASMODE_LIFECYCLE_WAIT_MS: "180000",
  })).toEqual({ limit: 6, queueWaitMs: 180_000 });
});

test("invalid lifecycle admission env config fails startup validation", () => {
  for (const [name, value] of [
    ["ALIASMODE_LIFECYCLE_CAP", "0"],
    ["ALIASMODE_LIFECYCLE_CAP", "4.5"],
    ["ALIASMODE_LIFECYCLE_CAP", "NaN"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", "Infinity"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", ""],
  ] as const) {
    expect(() => lifecycleAdmissionOptionsFromEnv({ [name]: value })).toThrow(`${name} must be a positive integer`);
  }
});

test("desktop local startup serves saved profiles without downloading engines and shuts down over owned IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "maobu-local-ipc-"));
  const paths = statePaths(root);
  const store = new ProfileStore(paths.database);
  const profile = buildNewProfile({ name: "Saved local profile" }, () => false);
  store.upsertProfile(profile);
  store.close();
  const nonce = "a".repeat(64);
  const dashboardSession = "c".repeat(64);
  const child = Bun.spawn([
    process.execPath, "--no-env-file", join(import.meta.dir, "..", "cli.ts"), "start",
    "--state-root", root, "--desktop-root", root, "--desktop-stdio", "--port", "0",
  ], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env, ALIASMODE_PLAYWRIGHT_RUNTIME: "", ALIASMODE_DESKTOP_NONCE: nonce,
      ALIASMODE_AGENT_NONCE: "b".repeat(64), ALIASMODE_DESKTOP_VERSION: "local-test",
      MAOBU_DESKTOP_SESSION: dashboardSession, MAOBU_DESKTOP_AUTOMATION_TOKEN: "",
    },
  });
  const records: Array<{ event: string; nonce: string; port?: number }> = [];
  let acceptReady!: (record: { port: number }) => void;
  const ready = new Promise<{ port: number }>((resolve) => { acceptReady = resolve; });
  const output = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      for (; ;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const record = JSON.parse(line);
          if (record.protocol !== "aliasmode-desktop-v1") continue;
          records.push(record);
          if (record.event === "ready") acceptReady(record);
        } catch { }
      }
    }
  })();
  const errorOutput = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const record = await Promise.race([ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("local desktop did not become ready")), 8_000);
    })]);
    const origin = `http://127.0.0.1:${record.port}`;
    const read = (path: string) => fetch(`${origin}/ui/api/${path}`, { headers: { "X-Maobu-Desktop-Session": dashboardSession } }).then(response => response.json());
    expect((await fetch(`${origin}/ui/api/profiles/${profile.id}`)).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/status`)).status).toBe(404);
    expect(await read("app-mode")).toMatchObject({ mode: "local", localOnly: true });
    expect(await read("profiles")).toMatchObject({ profiles: [{ id: profile.id, name: "Saved local profile" }] });
    expect(await read("runtime-downloads")).toEqual({ downloads: [] });
    child.stdin.write(JSON.stringify({ protocol: "aliasmode-desktop-v1", command: "shutdown", nonce }) + "\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await output;
    expect(await errorOutput).not.toContain("FATAL");
    expect(records).toContainEqual(expect.objectContaining({ event: "shutdown-complete", nonce }));
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
    await child.exited;
    await output;
    await removeTemporaryRoot(root);
  }
}, 15_000);
