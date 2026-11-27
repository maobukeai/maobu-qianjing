import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_CONTROL_PROTOCOL,
  AgentControlSession,
  type AgentControlDeps,
} from "./agent-control.ts";
import type {
  RpaCodegenOptions,
  RpaCodegenResult,
  RpaRecordedStep,
  RpaRecorderState,
  RpaRecorderStatus,
} from "../contracts/local.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import { resolvePlaywrightRuntime, type PlaywrightRuntimeLayout } from "./playwright-runtime.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "./profile-id.ts";
import { generateRpaScript } from "./rpa-codegen.ts";

export const DEFAULT_RECORDER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_RECORDED_STEPS = 500;
const RECORDER_READY_TIMEOUT_MS = 30_000;
const RECORDER_STOP_GRACE_MS = 3_000;

export class RpaRecorderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RpaRecorderError";
  }
}

export function scriptRunnerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "APPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ]) {
    if (source[key] !== undefined) {
      env[key] = source[key];
    }
  }
  return env;
}

export function supportsSourceScripts(): boolean {
  return process.platform === "darwin" || (process.platform === "linux" && process.arch === "x64");
}

export interface RecorderRuntimeSpec {
  executable: string;
  recorderScript: string;
}

export function resolveRecorderRunner(runtime: PlaywrightRuntimeLayout = resolvePlaywrightRuntime()): RecorderRuntimeSpec {
  if (runtime.kind === "source" && !supportsSourceScripts()) {
    throw new RpaRecorderError("Scripts require the packaged desktop runtime", 503);
  }
  return {
    executable: runtime.nodeExecutable,
    recorderScript: join(runtime.root, "agent", "script-recorder.mjs"),
  };
}

export function verifyRecorderRuntime(runtime: PlaywrightRuntimeLayout = resolvePlaywrightRuntime()): RecorderRuntimeSpec {
  const resolved = resolveRecorderRunner(runtime);
  if (runtime.kind === "packaged" && !existsSync(resolved.executable)) {
    throw new RpaRecorderError("The script runtime is missing; repair the local desktop installation", 503);
  }
  if (!existsSync(resolved.recorderScript)) {
    throw new RpaRecorderError(
      runtime.kind === "source"
        ? "The source script recorder is missing; restore the local source checkout"
        : "The script runtime is missing; repair the local desktop installation",
      503,
    );
  }
  return resolved;
}

export interface RecorderChildProcess {
  pid?: number;
  writeLine(line: string): void;
  closeStdin(): void;
  onLine(handler: (line: string) => void): void;
  onStderr(handler: (text: string) => void): void;
  exited: Promise<number | null>;
  terminate(): Promise<void>;
}

export type RecorderProcessFactory = (options: {
  endpoint: string;
  engine: "chromium" | "firefox";
  debounceMs: number;
}) => Promise<RecorderChildProcess> | RecorderChildProcess;

function spawnRealRecorderProcess(runtime?: PlaywrightRuntimeLayout): RecorderChildProcess {
  const { executable, recorderScript } = verifyRecorderRuntime(runtime);
  const child: ChildProcess = spawn(executable, [recorderScript], {
    windowsHide: true,
    detached: process.platform !== "win32",
    env: scriptRunnerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lineHandlers: Array<(line: string) => void> = [];
  const stderrHandlers: Array<(text: string) => void> = [];
  let stdoutBuffer = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        for (const handler of lineHandlers) handler(line);
      }
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const handler of stderrHandlers) handler(chunk);
  });

  child.stdin?.on("error", () => {});

  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code));
  });

  let terminating: Promise<void> | undefined;
  const terminate = () => {
    terminating ??= (async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        });
        await kill.exited;
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error: any) {
          if (error?.code !== "ESRCH") {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }
      }
    })().catch(() => {});
    return terminating;
  };

  return {
    pid: child.pid,
    writeLine(line: string) {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${line}\n`);
      }
    },
    closeStdin() {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    },
    onLine(handler) {
      lineHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    exited,
    terminate,
  };
}

const VALID_KINDS = new Set(["goto", "click", "fill", "select", "press"]);
const VALID_STRATEGIES = new Set(["testid", "id", "role", "aria-label", "name", "placeholder", "text", "css"]);

/**
 * Defense-in-depth step sanitizer: validates structure and guarantees plaintext
 * values are NEVER retained on sensitive (`password`/`twofa`/`masked`) steps.
 */
export function sanitizeRecordedStep(raw: unknown, fallbackIndex: number): RpaRecordedStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const kind = src.kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return null;
  const index = Number.isSafeInteger(src.index) && Number(src.index) > 0 ? Number(src.index) : fallbackIndex;
  const timestamp = typeof src.timestamp === "number" && Number.isFinite(src.timestamp) ? src.timestamp : Date.now();
  const id = typeof src.id === "string" && src.id.trim() ? src.id.trim().slice(0, 64) : `step-${index}`;

  const step: RpaRecordedStep = {
    id,
    index,
    kind: kind as RpaRecordedStep["kind"],
    timestamp,
  };

  if (typeof src.url === "string" && /^https?:\/\//i.test(src.url.trim())) {
    step.url = src.url.trim().slice(0, 2048);
  }
  if (typeof src.selector === "string" && src.selector.trim()) {
    step.selector = src.selector.trim().slice(0, 512);
  }
  if (typeof src.selectorStrategy === "string" && VALID_STRATEGIES.has(src.selectorStrategy)) {
    step.selectorStrategy = src.selectorStrategy as RpaRecordedStep["selectorStrategy"];
  }
  if (typeof src.role === "string" && src.role.trim()) {
    step.role = src.role.trim().slice(0, 64);
  }
  if (typeof src.accessibleName === "string" && src.accessibleName.trim()) {
    step.accessibleName = src.accessibleName.trim().slice(0, 120);
  }
  if (typeof src.label === "string" && src.label.trim()) {
    step.label = src.label.trim().slice(0, 160);
  }
  if (typeof src.key === "string" && src.key.trim()) {
    step.key = src.key.trim().slice(0, 32);
  }
  if (typeof src.tagName === "string" && src.tagName.trim()) {
    step.tagName = src.tagName.trim().toLowerCase().slice(0, 32);
  }
  if (typeof src.inputParamName === "string" && src.inputParamName.trim()) {
    step.inputParamName = src.inputParamName.trim().slice(0, 48);
  }

  const isSensitive = src.credentialRef === "password" || src.credentialRef === "twofa" || src.masked === true;
  if (isSensitive) {
    step.credentialRef = src.credentialRef === "twofa" ? "twofa" : "password";
    step.masked = true;
    // Plaintext value is intentionally dropped.
  } else if ((kind === "fill" || kind === "select") && typeof src.value === "string") {
    step.value = src.value.slice(0, 4000);
  }

  if (kind === "goto" && !step.url) return null;
  return step;
}

export interface RpaRecorderStartRequest {
  profileId: string;
  startupUrl?: string;
}

export interface RpaRecorderStopRequest {
  closeBrowser?: boolean;
}

export interface RpaRecorderManagerOptions extends AgentControlDeps {
  /** Check whether a profile is currently locked by an active ScriptSupervisor run. */
  isProfileLockedByScripts?: (profileId: string) => boolean;
  /** Notified whenever the recorder releases its locked profile (e.g., to wake queued script runs). */
  onProfileReleased?: () => void;
  /** Optional listener notified whenever recorder state or steps update. */
  onStatusChanged?: (status: RpaRecorderStatus) => void;
  /** Override idle cleanup timeout (default 30 minutes). */
  idleTimeoutMs?: number;
  /** Override fill debounce interval in ms (default 400). */
  debounceMs?: number;
  /** Override runtime layout resolution (primarily for tests). */
  runtime?: PlaywrightRuntimeLayout;
  /** Injectable process factory (primarily for tests). */
  spawn?: RecorderProcessFactory;
}

interface ActiveSession {
  sessionId: string;
  profileId: string;
  profileName: string;
  engine: "chromium" | "firefox";
  endpoint: string;
  ownedByConnection: boolean;
  startedAt: number;
  lastActivityAt: number;
  steps: RpaRecordedStep[];
  state: RpaRecorderState;
  error: string | null;
  control: AgentControlSession;
  abort: AbortController;
  child: RecorderChildProcess | null;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<RpaRecorderStatus>;
}

export class RpaRecorderManager {
  private active: ActiveSession | null = null;
  private lastSteps: RpaRecordedStep[] = [];
  private lastError: string | null = null;
  private closing = false;
  private readonly idleTimeoutMs: number;
  private readonly debounceMs: number;

  constructor(private readonly options: RpaRecorderManagerOptions) {
    this.idleTimeoutMs = Math.max(10, options.idleTimeoutMs ?? DEFAULT_RECORDER_IDLE_TIMEOUT_MS);
    this.debounceMs = Math.max(0, options.debounceMs ?? 400);
  }

  isProfileLocked(profileId: string): boolean {
    return this.active !== null && this.active.profileId === profileId;
  }

  lockedProfileId(): string | null {
    return this.active ? this.active.profileId : null;
  }

  status(): RpaRecorderStatus {
    if (!this.active) {
      return {
        state: this.lastError ? "error" : "idle",
        sessionId: null,
        profileId: null,
        profileName: null,
        engine: null,
        ownedByConnection: false,
        startedAt: null,
        lastActivityAt: null,
        steps: structuredClone(this.lastSteps),
        error: this.lastError,
      };
    }
    return {
      state: this.active.state,
      sessionId: this.active.sessionId,
      profileId: this.active.profileId,
      profileName: this.active.profileName,
      engine: this.active.engine,
      ownedByConnection: this.active.ownedByConnection,
      startedAt: this.active.startedAt,
      lastActivityAt: this.active.lastActivityAt,
      steps: structuredClone(this.active.steps),
      error: this.active.error,
    };
  }

  private emitStatus(): void {
    if (!this.options.onStatusChanged) return;
    try {
      this.options.onStatusChanged(this.status());
    } catch (error) {
      this.options.log?.(`recorder status listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resetIdleTimer(session: ActiveSession): void {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      if (this.active !== session) return;
      this.options.log?.(`RPA recorder session ${session.sessionId} reached idle timeout; cleaning up.`);
      void this.stop({ closeBrowser: true }).catch(() => {});
    }, this.idleTimeoutMs);
    if (typeof (session.idleTimer as { unref?: () => void }).unref === "function") {
      (session.idleTimer as { unref: () => void }).unref();
    }
  }

  private clearIdleTimer(session: ActiveSession): void {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
  }

  async start(request: RpaRecorderStartRequest): Promise<RpaRecorderStatus> {
    if (this.closing) {
      throw new RpaRecorderError("Recorder is unavailable while the app shuts down", 409);
    }
    if (this.active) {
      throw new RpaRecorderError("A recording session is already active in this workspace", 409);
    }
    if (!request || typeof request !== "object" || !isSafeProfileId(request.profileId)) {
      throw new RpaRecorderError(PROFILE_ID_ERROR, 400);
    }
    const profileId = request.profileId;
    let startupUrls: string[] | undefined;
    if (request.startupUrl !== undefined && request.startupUrl !== "") {
      if (typeof request.startupUrl !== "string" || !/^https?:\/\//i.test(request.startupUrl.trim())) {
        throw new RpaRecorderError("startupUrl must be a valid http:// or https:// URL", 400);
      }
      startupUrls = [request.startupUrl.trim()];
    }
    if (this.options.isProfileLockedByScripts?.(profileId)) {
      throw new RpaRecorderError(`A script is already running for profile ${profileId}`, 409);
    }
    const profile = this.options.store.getProfile(profileId);
    if (!profile) {
      throw new RpaRecorderError("Profile not found", 404);
    }
    if (!this.options.spawn) {
      verifyRecorderRuntime(this.options.runtime);
    }

    const now = Date.now();
    const abort = new AbortController();
    const control = new AgentControlSession(this.options, abort.signal);
    const session: ActiveSession = {
      sessionId: randomUUID(),
      profileId,
      profileName: profile.name || profileId,
      engine: profile.engine === "firefox" ? "firefox" : "chromium",
      endpoint: "",
      ownedByConnection: false,
      startedAt: now,
      lastActivityAt: now,
      steps: [],
      state: "starting",
      error: null,
      control,
      abort,
      child: null,
    };

    // Reserve lock immediately to prevent concurrent starts or script runs on this profile.
    this.active = session;
    this.lastError = null;
    this.emitStatus();

    const callAgent = async (method: string, params: Record<string, unknown>) => {
      const response = await control.enqueue(
        JSON.stringify({
          protocol: AGENT_CONTROL_PROTOCOL,
          id: 1,
          method,
          params,
        }),
      );
      if (!response.ok) {
        throw new RpaRecorderError(response.error?.message ?? "Browser operation failed", 502);
      }
      return response.result as Record<string, unknown>;
    };

    try {
      const opened = await callAgent("browser.open", {
        profileId,
        headless: false,
        ...(startupUrls ? { startupUrls } : {}),
      });
      session.ownedByConnection = opened.ownedByConnection === true;
      const isFirefox = opened.engine === "firefox";
      session.engine = isFirefox ? "firefox" : "chromium";

      if (isFirefox) {
        const launch = this.options.store.getLaunch(profileId) as { firefoxOwner?: FirefoxOwner } | null;
        if (!launch?.firefoxOwner) {
          throw new RpaRecorderError("Firefox browser owner is unavailable", 503);
        }
        const { endpoint } = await callFirefoxOwner<{ endpoint?: unknown }>(
          launch.firefoxOwner,
          "playwright-endpoint",
          {},
          { signal: abort.signal },
        );
        if (typeof endpoint !== "string" || !endpoint) {
          throw new RpaRecorderError("Firefox browser endpoint is unavailable", 503);
        }
        session.endpoint = endpoint;
      } else {
        if (typeof opened.ws !== "string" || !opened.ws) {
          throw new RpaRecorderError("Browser debugging endpoint is unavailable", 503);
        }
        session.endpoint = opened.ws;
      }

      const child = this.options.spawn
        ? await this.options.spawn({
            endpoint: session.endpoint,
            engine: session.engine,
            debounceMs: this.debounceMs,
          })
        : spawnRealRecorderProcess(this.options.runtime);
      session.child = child;

      let readySettled = false;
      let resolveReady!: () => void;
      let rejectReady!: (err: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const readyTimer = setTimeout(() => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new RpaRecorderError("Recorder timed out waiting for browser attachment", 504));
        }
      }, RECORDER_READY_TIMEOUT_MS);

      let stderrTail = "";
      child.onStderr((text) => {
        stderrTail = `${stderrTail}${text}`.slice(-1000);
      });

      child.onLine((line) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (parsed.type === "ready") {
          if (!readySettled) {
            readySettled = true;
            clearTimeout(readyTimer);
            resolveReady();
          }
          return;
        }
        if (parsed.type === "step") {
          if (session.steps.length >= MAX_RECORDED_STEPS) return;
          const sanitized = sanitizeRecordedStep(parsed.step, session.steps.length + 1);
          if (!sanitized) return;
          sanitized.index = session.steps.length + 1;
          sanitized.id = `step-${sanitized.index}`;
          session.steps.push(sanitized);
          session.lastActivityAt = Date.now();
          this.resetIdleTimer(session);
          this.emitStatus();
          return;
        }
        if (parsed.type === "error") {
          const rawMsg = typeof parsed.message === "string" ? parsed.message : "Recorder process error";
          const safeMsg = session.engine === "firefox" && session.endpoint
            ? rawMsg.replaceAll(session.endpoint, "private Firefox endpoint")
            : rawMsg;
          if (!readySettled) {
            readySettled = true;
            clearTimeout(readyTimer);
            rejectReady(new RpaRecorderError(safeMsg, 500));
          } else {
            session.error = safeMsg;
            this.lastError = safeMsg;
            this.emitStatus();
          }
        }
      });

      void child.exited.then((code) => {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          const safeStderr = session.engine === "firefox" && session.endpoint
            ? stderrTail.replaceAll(session.endpoint, "private Firefox endpoint")
            : stderrTail;
          rejectReady(new RpaRecorderError(safeStderr.trim() || `Recorder exited unexpectedly (code ${code ?? "unknown"})`, 500));
          return;
        }
        if (this.active === session && !session.stopping) {
          // Unexpected child exit while recording: clean up session without closing user's browser.
          void this.finalizeSession(session, { closeBrowser: false, error: code && code !== 0 ? `Recorder exited (code ${code})` : null });
        }
      });

      child.writeLine(JSON.stringify({
        endpoint: session.endpoint,
        engine: session.engine,
        debounceMs: this.debounceMs,
      }));

      await readyPromise;
      clearTimeout(readyTimer);

      if (this.active !== session) {
        throw new RpaRecorderError("Recording session was cancelled during startup", 409);
      }

      session.state = "recording";
      session.lastActivityAt = Date.now();
      this.resetIdleTimer(session);
      this.emitStatus();
      return this.status();
    } catch (error) {
      await this.finalizeSession(session, {
        closeBrowser: session.ownedByConnection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof RpaRecorderError
        ? error
        : new RpaRecorderError(error instanceof Error ? error.message : "Failed to start recorder", 500);
    }
  }

  private async finalizeSession(
    session: ActiveSession,
    options: { closeBrowser: boolean; error?: string | null },
  ): Promise<RpaRecorderStatus> {
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      session.state = "stopping";
      this.clearIdleTimer(session);
      this.emitStatus();

      const child = session.child;
      if (child) {
        try {
          child.writeLine(JSON.stringify({ cmd: "stop" }));
        } catch {}
        const finished = await Promise.race([
          child.exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RECORDER_STOP_GRACE_MS)),
        ]);
        if (!finished) {
          await child.terminate();
          await Promise.race([
            child.exited,
            new Promise<void>((resolve) => setTimeout(resolve, 1000)),
          ]);
        }
        try {
          child.closeStdin();
        } catch {}
      }

      const callControl = async (method: string, params: Record<string, unknown>) => {
        const res = await session.control.enqueue(
          JSON.stringify({
            protocol: AGENT_CONTROL_PROTOCOL,
            id: 2,
            method,
            params,
          }),
        );
        return res;
      };

      try {
        if (session.ownedByConnection) {
          if (options.closeBrowser) {
            const closeRes = await callControl("browser.close", {
              profileId: session.profileId,
              ...(session.engine === "chromium" && session.endpoint ? { expectedEndpoint: session.endpoint } : {}),
            });
            if (!closeRes.ok) {
              await callControl("browser.detach", { profileId: session.profileId }).catch(() => {});
            }
          } else {
            // Keep recorder-launched browser open by detaching before AgentControlSession.disconnect().
            await callControl("browser.detach", { profileId: session.profileId }).catch(() => {});
          }
        }
      } finally {
        await session.control.disconnect().catch(() => {});
      }

      this.lastSteps = structuredClone(session.steps);
      this.lastError = options.error ?? null;
      if (this.active === session) {
        this.active = null;
      }
      this.emitStatus();
      this.options.onProfileReleased?.();
      return this.status();
    })();
    return session.stopping;
  }

  async stop(request: RpaRecorderStopRequest = {}): Promise<RpaRecorderStatus> {
    const session = this.active;
    if (!session) {
      return this.status();
    }
    const closeBrowser = request?.closeBrowser === true;
    return await this.finalizeSession(session, { closeBrowser, error: null });
  }

  codegen(input: { steps?: unknown; options?: RpaCodegenOptions } = {}): RpaCodegenResult {
    let resolvedSteps: RpaRecordedStep[];
    if (input.steps !== undefined) {
      if (!Array.isArray(input.steps)) {
        throw new RpaRecorderError("steps must be an array", 400);
      }
      if (input.steps.length > MAX_RECORDED_STEPS) {
        throw new RpaRecorderError(`steps exceeds maximum of ${MAX_RECORDED_STEPS}`, 400);
      }
      resolvedSteps = [];
      for (let i = 0; i < input.steps.length; i++) {
        const sanitized = sanitizeRecordedStep(input.steps[i], i + 1);
        if (sanitized) {
          sanitized.index = resolvedSteps.length + 1;
          resolvedSteps.push(sanitized);
        }
      }
    } else {
      resolvedSteps = structuredClone(this.active ? this.active.steps : this.lastSteps);
    }

    const opts = input.options && typeof input.options === "object" && !Array.isArray(input.options)
      ? input.options
      : {};
    return generateRpaScript(resolvedSteps, opts);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.active) {
      await this.finalizeSession(this.active, { closeBrowser: true, error: null });
    }
  }
}
