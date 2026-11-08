import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";

export const DESKTOP_PROTOCOL = "aliasmode-desktop-v1";
const NONCE_RE = /^[a-f0-9]{64}$/;

export interface DesktopHealthMetadata {
  version: string;
  root: string;
  instance: string;
}

export interface DesktopReadyRecord {
  protocol: typeof DESKTOP_PROTOCOL;
  event: "ready";
  nonce: string;
  pid: number;
  port: number;
}

interface ManagedServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  stopScripts?(): Promise<void>;
}

interface ManagedStore {
  listLaunches(): Array<{ profileId: string }>;
  close(): void;
}

interface ManagedLauncher {
  stop(profileId: string): Promise<boolean>;
}

export interface ManagedDesktopRuntimeOptions {
  server: ManagedServer;
  automationServer?: ManagedServer;
  admission: LifecycleAdmissionController;
  store: ManagedStore;
  launcher: ManagedLauncher;
  stopInbox?: () => void | Promise<void>;
  wait?: (ms: number) => Promise<void>;
  shutdownTimeoutMs?: number;
}

export function agentControlNonce(
  env: Record<string, string | undefined>,
): string | null {
  const nonce = env.ALIASMODE_AGENT_NONCE;
  if (nonce === undefined) return null;
  if (!NONCE_RE.test(nonce)) {
    throw new Error("ALIASMODE_AGENT_NONCE must be 64 lowercase hexadecimal characters");
  }
  return nonce;
}

export function desktopHealthMetadata(
  env: Record<string, string | undefined>,
  root: string | undefined,
): DesktopHealthMetadata | null {
  const desktop = env.ALIASMODE_DESKTOP_NONCE !== undefined || root !== undefined;
  if (!desktop) return null;
  const instance = env.ALIASMODE_DESKTOP_NONCE ?? "";
  const version = env.ALIASMODE_DESKTOP_VERSION ?? "";
  if (!NONCE_RE.test(instance)) throw new Error("ALIASMODE_DESKTOP_NONCE must be 64 lowercase hexadecimal characters");
  if (!version.trim()) throw new Error("ALIASMODE_DESKTOP_VERSION is required in desktop mode");
  if (!root) throw new Error("--desktop-root is required in desktop mode");
  return { instance, version: version.trim(), root };
}

export function desktopReadyRecord(nonce: string, port: number, pid = process.pid): DesktopReadyRecord {
  if (!NONCE_RE.test(nonce)) throw new Error("desktop readiness nonce is invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("desktop readiness port is invalid");
  if (!Number.isInteger(pid) || pid < 1) throw new Error("desktop readiness pid is invalid");
  return { protocol: DESKTOP_PROTOCOL, event: "ready", nonce, pid, port };
}

export function isDesktopShutdownCommand(line: string, nonce: string): boolean {
  if (!NONCE_RE.test(nonce)) return false;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return value.protocol === DESKTOP_PROTOCOL && value.command === "shutdown" && value.nonce === nonce;
  } catch {
    return false;
  }
}

async function beforeDeadline<T>(pending: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("desktop shutdown deadline expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("desktop shutdown deadline expired")), remaining);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopServers(servers: ManagedServer[]): Promise<void> {
  const results = await Promise.allSettled(
    servers.map((server) => Promise.resolve().then(() => server.stop(false))),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export class ManagedDesktopRuntime {
  private shutdownInFlight: Promise<void> | null = null;

  constructor(private readonly options: ManagedDesktopRuntimeOptions) { }

  shutdown(): Promise<void> {
    if (!this.shutdownInFlight) this.shutdownInFlight = this.runShutdown();
    return this.shutdownInFlight;
  }

  private async runShutdown(): Promise<void> {
    const {
      server,
      automationServer,
      admission,
      store,
      launcher,
      stopInbox = () => { },
      wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      shutdownTimeoutMs = 7 * 60_000,
    } = this.options;

    const deadline = Date.now() + shutdownTimeoutMs;
    let failure: unknown;
    try {
      await beforeDeadline(stopServers([
        server,
        ...(automationServer ? [automationServer] : []),
      ]), deadline);
      await beforeDeadline(server.stopScripts?.() ?? Promise.resolve(), deadline);
      try {
        await beforeDeadline(Promise.resolve(stopInbox()), deadline);
      } catch (error) {
        failure ??= error;
      }
      while (admission.stats().inFlight > 0 || admission.stats().queued > 0) {
        if (Date.now() >= deadline) throw new Error("lifecycle requests did not settle before desktop shutdown");
        await wait(25);
      }

      const failed: string[] = [];
      for (const { profileId } of store.listLaunches()) {
        try {
          if (await beforeDeadline(launcher.stop(profileId), deadline) !== true) failed.push(profileId);
        } catch {
          failed.push(profileId);
        }
      }
      if (failed.length) {
        throw new Error(`browser teardown was not confirmed for ${failed.length} profile(s)`);
      }
    } catch (error) {
      failure ??= error;
    } finally {
      try {
        store.close();
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) throw failure;
  }
}
