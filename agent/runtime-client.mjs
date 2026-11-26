import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join, posix, win32 } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import NodeWebSocket from "ws";

export const RUNTIME_PROTOCOL = "aliasmode-runtime-v1";
export const AGENT_PROTOCOL = "aliasmode-agent-v1";
export const AGENT_PATH = "/api/agent/v1/connect";
export const RUNTIME_VERSION = process.env.ALIASMODE_APP_VERSION || "3.0.0";
const STARTUP_WAIT_MS = 180_000;
const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_HEALTH_HEADERS = 4 * 1024;
// Replies can be much larger than requests, e.g. a large local profile list.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);
// Windows and Linux report a tick count. macOS reports the `ps -o lstart=` date.
const START_IDENTITY = /^(?:\d+|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})$/;

function validNonce(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export class UnsupportedRuntimeError extends Error {
  constructor() {
    super("This adapter requires a local desktop runtime.");
    this.code = "unsupported_runtime";
  }
}

export function validateRuntimeDescriptor(value, expectedVersion = RUNTIME_VERSION) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime descriptor is invalid");
  if (typeof value.readiness === "string" && value.readiness !== "local") throw new UnsupportedRuntimeError();
  if (
    value.protocol !== RUNTIME_PROTOCOL ||
    value.appVersion !== expectedVersion ||
    !validNonce(value.generation) ||
    !validNonce(value.nonce) ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535 ||
    !Number.isInteger(value.desktopPid) || value.desktopPid < 1 ||
    !Number.isInteger(value.sidecarPid) || value.sidecarPid < 1 ||
    typeof value.desktopStartedAt !== "string" || !START_IDENTITY.test(value.desktopStartedAt) ||
    value.readiness !== "local" ||
    !Number.isInteger(value.createdAt) || value.createdAt < 1
  ) {
    throw new Error("runtime descriptor did not match this 猫步·千境 adapter");
  }
  return value;
}

/** The XDG data folder that holds the Linux app (aliasmode) and its data (com.maobu.local). */
function linuxDataHome(env) {
  if (env.XDG_DATA_HOME?.startsWith("/")) return env.XDG_DATA_HOME;
  if (!env.HOME) throw new Error("HOME is required to discover 猫步·千境");
  return posix.join(env.HOME, ".local", "share");
}

export function defaultRuntimeDescriptorPath(env = process.env, platform = process.platform) {
  if (env.ALIASMODE_RUNTIME_DESCRIPTOR) return env.ALIASMODE_RUNTIME_DESCRIPTOR;
  if (platform === "darwin") {
    if (!env.HOME) throw new Error("HOME is required to discover 猫步·千境");
    return posix.join(env.HOME, "Library", "Application Support", "com.maobu.local", "agent-runtime.json");
  }
  if (platform === "linux") return posix.join(linuxDataHome(env), "com.maobu.local", "agent-runtime.json");
  if (!env.APPDATA) throw new Error("APPDATA is required to discover 猫步·千境");
  return join(env.APPDATA, "com.maobu.local", "agent-runtime.json");
}

export function windowsProcessIdentityCommand(pid, env = process.env) {
  const executable = env.SYSTEMROOT
    ? win32.join(env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return {
    executable,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`,
    ],
  };
}

async function processStartIdentity(pid) {
  if (process.platform === "win32") {
    const command = windowsProcessIdentityCommand(pid);
    const { stdout } = await execFileAsync(
      command.executable,
      command.args,
      { windowsHide: true, timeout: 5_000, maxBuffer: 1024 },
    );
    const value = stdout.trim();
    if (!/^\d+$/.test(value)) throw new Error("desktop process identity is invalid");
    return value;
  }
  if (process.platform === "darwin") {
    // Keep in step with current_process_start_identity in src-tauri/src/runtime_descriptor.rs.
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { env: { LC_ALL: "C", TZ: "UTC" }, timeout: 5_000, maxBuffer: 1024 },
    );
    const value = stdout.trim();
    if (!START_IDENTITY.test(value)) throw new Error("desktop process identity is invalid");
    return value;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const value = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/)[19] : undefined;
  if (!value || !/^\d+$/.test(value)) throw new Error("desktop process identity is invalid");
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function connectLoopback(port) {
  return connect({ host: "127.0.0.1", port, family: 4 });
}

function readLocalHealth(descriptor) {
  // Bun's HTTP client can consult proxy variables even with agent: false.
  // This fixed HTTP/1.0 request uses a direct socket and a bounded, close-delimited reply.
  return new Promise((resolve, reject) => {
    const socket = connectLoopback(descriptor.port);
    const chunks = [];
    let received = 0;
    const timer = setTimeout(() => socket.destroy(new Error("猫步·千境 health proof timed out")), 2_000);
    socket.once("connect", () => socket.write(
      `GET /ui/api/health HTTP/1.0\r\nHost: 127.0.0.1:${descriptor.port}\r\nAuthorization: Bearer ${descriptor.nonce}\r\nConnection: close\r\n\r\n`,
    ));
    socket.on("data", chunk => {
      if (received + chunk.length > MAX_HEALTH_HEADERS + MAX_HEALTH_BYTES) {
        socket.destroy(new Error("猫步·千境 health proof is oversized"));
        return;
      }
      received += chunk.length;
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const response = Buffer.concat(chunks, received);
      const split = response.indexOf("\r\n\r\n");
      const headers = split < 0 || split > MAX_HEALTH_HEADERS ? "" : response.toString("latin1", 0, split);
      const body = response.subarray(split + 4);
      if (!/^HTTP\/1\.[01] 200(?: |\r\n|$)/.test(headers) || /\r\ntransfer-encoding:/i.test(headers) || body.length > MAX_HEALTH_BYTES) {
        reject(new Error("猫步·千境 health proof failed"));
      } else resolve(body);
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("猫步·千境 health connection closed"));
    });
  });
}

async function verifyHealth(descriptor) {
  if (!processExists(descriptor.desktopPid) || !processExists(descriptor.sidecarPid)) {
    throw new Error("猫步·千境 runtime processes are not active");
  }
  if (await processStartIdentity(descriptor.desktopPid) !== descriptor.desktopStartedAt) {
    throw new Error("猫步·千境 desktop process identity changed");
  }
  const health = JSON.parse((await readLocalHealth(descriptor)).toString("utf8"));
  if (
    health.ok !== true ||
    health.version !== descriptor.appVersion ||
    health.instance !== descriptor.generation
  ) {
    throw new Error("猫步·千境 health proof did not match the discovered runtime");
  }
}

function listen(socket, event, handler, once = false) {
  const method = once ? "once" : "on";
  if (typeof socket[method] === "function") {
    socket[method](event, handler);
    return;
  }
  socket.addEventListener(event, (value) => {
    handler(event === "message" ? value.data : value);
  }, { once });
}

function terminate(socket) {
  if (typeof socket.terminate === "function") socket.terminate();
  else socket.close();
}

export class AgentRuntimeClient {
  constructor(socket) {
    this.socket = socket;
    this.nativeSocket = typeof socket.on !== "function";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    listen(socket, "message", (data) => this.#onMessage(data));
    listen(socket, "close", () => this.#onClose(new Error("猫步·千境 agent connection closed")));
    listen(socket, "error", () => this.#onClose(new Error("猫步·千境 agent connection failed")));
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("猫步·千境 agent connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ protocol: AGENT_PROTOCOL, id, method, params });
      if (this.nativeSocket) {
        try {
          this.socket.send(payload);
        } catch {
          this.pending.delete(id);
          reject(new Error("猫步·千境 agent request could not be sent"));
        }
        return;
      }
      this.socket.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error("猫步·千境 agent request could not be sent"));
      });
    });
  }

  close() {
    if (this.socket.readyState === 1) this.socket.close();
    else if (this.socket.readyState === 0) terminate(this.socket);
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(new Error("猫步·千境 agent connection closed"));
  }

  #onMessage(data) {
    let value;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      this.#onClose(new Error("猫步·千境 returned malformed agent data"));
      return;
    }
    if (
      value?.protocol !== AGENT_PROTOCOL ||
      !Number.isSafeInteger(value.id) ||
      typeof value.ok !== "boolean"
    ) {
      this.#onClose(new Error("猫步·千境 returned an invalid agent response"));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.ok) pending.resolve(value.result);
    else {
      const error = new Error(value.error?.message || "猫步·千境 operation failed");
      error.code = value.error?.code || "operation_failed";
      pending.reject(error);
    }
  }

  #onClose(error) {
    if (this.socket.readyState === 1 || this.socket.readyState === 0) {
      terminate(this.socket);
    }
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function connectAgent(descriptor) {
  await verifyHealth(descriptor);
  const url = `ws://127.0.0.1:${descriptor.port}${AGENT_PATH}`;
  const socket = new NodeWebSocket(url, AGENT_PROTOCOL, {
    agent: false,
    createConnection: () => connectLoopback(descriptor.port),
    headers: { Authorization: `Bearer ${descriptor.nonce}` },
    maxPayload: MAX_RESPONSE_BYTES,
    handshakeTimeout: 5_000,
    followRedirects: false,
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const failed = (message) => {
      if (settled) return;
      settled = true;
      terminate(socket);
      reject(new Error(message));
    };
    listen(socket, "open", () => {
      if (settled) return;
      settled = true;
      resolve();
    }, true);
    listen(socket, "error", (error) => {
      failed(`猫步·千境 agent handshake failed: ${error?.message || "connection error"}`);
    }, true);
    listen(socket, "unexpected-response", (_request, response) => {
      failed(`猫步·千境 agent handshake was rejected with status ${response.statusCode}`);
    }, true);
  });
  if (socket.protocol !== AGENT_PROTOCOL) {
    socket.close();
    throw new Error("猫步·千境 agent protocol negotiation failed");
  }
  return new AgentRuntimeClient(socket);
}

function defaultDesktopExecutable(env = process.env) {
  if (env.ALIASMODE_DESKTOP_EXE) return env.ALIASMODE_DESKTOP_EXE;
  throw new Error("Set ALIASMODE_DESKTOP_EXE to this local build to start the desktop app");
}

function launchBackground(executable) {
  if (!existsSync(executable)) throw new Error("猫步·千境 is not installed at the expected path");
  const child = spawn(executable, ["--background"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function readRuntimeDescriptor(path, version) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("猫步·千境 runtime descriptor is unavailable");
  }
  try {
    return validateRuntimeDescriptor(JSON.parse(text), version);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("猫步·千境 runtime descriptor is malformed");
    throw error;
  }
}

export async function discoverRuntime(options = {}) {
  const descriptorPath = options.descriptorPath || defaultRuntimeDescriptorPath(options.env);
  const desktopEnv = options.env ?? process.env;
  const desktopExecutable = options.desktopExecutable || desktopEnv.ALIASMODE_DESKTOP_EXE;
  const deadline = Date.now() + (options.waitMs ?? STARTUP_WAIT_MS);
  let launched;
  let lastError = new Error("猫步·千境 runtime is not ready");

  while (Date.now() < deadline) {
    try {
      const descriptor = await readRuntimeDescriptor(
        descriptorPath,
        options.version || RUNTIME_VERSION,
      );
      const client = await connectAgent(descriptor);
      return { client, descriptor };
    } catch (error) {
      // Never launch a desktop when a different runtime protocol is configured.
      if (error instanceof UnsupportedRuntimeError) throw error;
      lastError = error instanceof Error ? error : lastError;
      if (launched?.exitCode !== null && launched?.exitCode !== undefined) {
        throw new Error(`猫步·千境 desktop exited before runtime readiness with code ${launched.exitCode}`);
      }
      if (!launched) launched = launchBackground(desktopExecutable || defaultDesktopExecutable(desktopEnv));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`猫步·千境 did not become ready: ${lastError.message}`);
}
