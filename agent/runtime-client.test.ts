import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  AgentRuntimeClient,
  UnsupportedRuntimeError,
  RUNTIME_PROTOCOL,
  RUNTIME_VERSION,
  defaultRuntimeDescriptorPath,
  discoverRuntime,
  validateRuntimeDescriptor,
  windowsProcessIdentityCommand,
} from "./runtime-client.mjs";

function descriptor() {
  return {
    protocol: RUNTIME_PROTOCOL,
    appVersion: RUNTIME_VERSION,
    generation: "a".repeat(64),
    nonce: "b".repeat(64),
    port: 50400,
    desktopPid: 11,
    desktopStartedAt: "123456",
    sidecarPid: 12,
    readiness: "local",
    createdAt: 1_700_000_000,
  };
}

test("runtime descriptor validation binds protocol, version, process, and nonce", () => {
  expect(validateRuntimeDescriptor(descriptor())).toEqual(descriptor());
  expect(() => validateRuntimeDescriptor({ ...descriptor(), appVersion: "other" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), nonce: "public" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), readiness: "starting" }))
    .toThrow(UnsupportedRuntimeError);
  expect(() => validateRuntimeDescriptor({ ...descriptor(), desktopStartedAt: "" }))
    .toThrow("did not match");
});

test("local adapters reject unsupported descriptors without starting or contacting a desktop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aliasmode-local-runtime-"));
  try {
    for (const readiness of ["account", "unavailable"]) {
      const value = { ...descriptor(), readiness };
      expect(() => validateRuntimeDescriptor(value)).toThrow(UnsupportedRuntimeError);
      const descriptorPath = join(directory, "agent-runtime.json");
      writeFileSync(descriptorPath, JSON.stringify(value));
      await expect(discoverRuntime({
        descriptorPath,
        desktopExecutable: join(directory, "missing-desktop.exe"),
        version: value.appVersion,
        waitMs: 1_000,
      })).rejects.toThrow(UnsupportedRuntimeError);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime discovery does not launch an original installation as a fallback", async () => {
  await expect(discoverRuntime({
    descriptorPath: join(import.meta.dir, "missing-runtime.json"),
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    waitMs: 1_000,
  })).rejects.toThrow("Set ALIASMODE_DESKTOP_EXE to this local build");
});

test("invalid agent responses terminate their WebSocket", () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    terminated = 0;
    terminate() { this.terminated++; this.readyState = 3; }
    close() { this.readyState = 2; }
    send() {}
  }
  const socket = new FakeSocket();
  const client = new AgentRuntimeClient(socket as any);
  socket.emit("message", Buffer.from("not-json"));
  expect(socket.terminated).toBe(1);
  client.close();
  expect(socket.readyState).toBe(3);
});

test("Windows process identity does not depend on PowerShell modules or PATH", () => {
  expect(windowsProcessIdentityCommand(123, { SYSTEMROOT: "C:\\Windows" } as any)).toEqual({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.Process]::GetProcessById(123).StartTime.ToFileTimeUtc()",
    ],
  });
});

test("runtime descriptor path uses the Tauri application data directory", () => {
  expect(defaultRuntimeDescriptorPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" } as any, "win32"))
    .toBe(join("C:\\Users\\me\\AppData\\Roaming", "com.maobu.local", "agent-runtime.json"));
  // Linux follows Tauri's data folder: XDG_DATA_HOME when it is absolute, else ~/.local/share.
  // Linux paths use "/" whatever system runs the code.
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me" } as any, "linux"))
    .toBe("/home/me/.local/share/com.maobu.local/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me", XDG_DATA_HOME: "/data/me" } as any, "linux"))
    .toBe("/data/me/com.maobu.local/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me", XDG_DATA_HOME: "relative" } as any, "linux"))
    .toBe("/home/me/.local/share/com.maobu.local/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({
    ALIASMODE_RUNTIME_DESCRIPTOR: "C:\\fixture\\runtime.json",
  } as any)).toBe("C:\\fixture\\runtime.json");
});
