import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_PROTOCOL,
  ManagedDesktopRuntime,
  agentControlNonce,
  desktopHealthMetadata,
  desktopReadyRecord,
  isDesktopShutdownCommand,
} from "../src/desktop-runtime.ts";

const NONCE = "ab".repeat(32);

function admission(inFlight = 0, queued = 0): any {
  return { stats: () => ({ inFlight, queued }) };
}

test("desktop health metadata requires a nonce, version, and root", () => {
  expect(desktopHealthMetadata({}, undefined)).toBeNull();
  expect(desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: NONCE,
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop")).toEqual({
    instance: NONCE,
    version: "0.1.0-beta.1",
    root: "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop",
  });
  expect(() => desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: "not-a-nonce",
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "root")).toThrow("64 lowercase hexadecimal");
});

test("agent control uses a separate validated desktop nonce", () => {
  expect(agentControlNonce({})).toBeNull();
  expect(agentControlNonce({ ALIASMODE_AGENT_NONCE: NONCE })).toBe(NONCE);
  expect(() => agentControlNonce({ ALIASMODE_AGENT_NONCE: "invalid" }))
    .toThrow("ALIASMODE_AGENT_NONCE");
});

test("desktop readiness is emitted only for a valid owned port and pid", () => {
  expect(desktopReadyRecord(NONCE, 49_152, 42)).toEqual({
    protocol: DESKTOP_PROTOCOL,
    event: "ready",
    nonce: NONCE,
    pid: 42,
    port: 49_152,
  });
  expect(() => desktopReadyRecord(NONCE, 0, 42)).toThrow("port is invalid");
  expect(() => desktopReadyRecord(NONCE, 49_152, 0)).toThrow("pid is invalid");
});

test("desktop control accepts only the fixed nonce-bound shutdown command", () => {
  const valid = JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: NONCE });
  expect(isDesktopShutdownCommand(valid, NONCE)).toBe(true);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: "cd".repeat(32) }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "run", nonce: NONCE }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand("not json", NONCE)).toBe(false);
});

test("desktop control gracefully shuts down when the parent stdin pipe closes", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
  expect(source).toContain('process.stdin.once("end", shutdown);');
  expect(source).toContain('process.stdin.once("close", shutdown);');
});

test("desktop shutdown coalesces and closes both listeners before authoritative local launches", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); } },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => { events.push("store"); },
    },
    launcher: { stop: async (id) => { events.push(`stop:${id}`); return true; } },
    stopInbox: () => { events.push("inbox"); },
  });

  const first = runtime.shutdown();
  const second = runtime.shutdown();
  expect(first).toBe(second);
  await first;
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.slice(2)).toEqual(["inbox", "stop:one", "stop:two", "store"]);
});

test("desktop shutdown stops script workers before browser capture and store close", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); }, stopScripts: async () => { events.push("scripts"); } },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { events.push("store"); } },
    launcher: { stop: async () => { events.push("browser"); return true; } },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "scripts", "browser", "store"]);
});

test("desktop shutdown attempts both listener stops when one fails", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); throw new Error("automation stop failed"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => true },
  });

  await expect(runtime.shutdown()).rejects.toThrow("automation stop failed");
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.at(-1)).toBe("store");
});

test("desktop shutdown attempts every local browser after one stop throws", async () => {
  const attempted: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { } },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => { },
    },
    launcher: {
      stop: async (id) => {
        attempted.push(id);
        if (id === "one") throw new Error("stop failed");
        return true;
      },
    },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(attempted).toEqual(["one", "two"]);
});

test("desktop shutdown fails closed when browser teardown is unconfirmed", async () => {
  let storeClosed = false;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { } },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { storeClosed = true; } },
    launcher: { stop: async () => false },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(storeClosed).toBe(true);
});

test("the local installer does not invoke upstream global process-killing hooks", () => {
  const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "src-tauri", "tauri.conf.json"), "utf8"));
  expect(config.bundle.windows.nsis.installerHooks).toBeUndefined();
});
