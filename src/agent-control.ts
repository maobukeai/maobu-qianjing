import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { syncFirefoxTimezone } from "./firefox-config.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import { attachTimezones, type FetchLike } from "./geoip.ts";
import {
  BrowserLaunchError,
  type BrowserOpenOptions,
  type Launcher,
} from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProxyReplacementInputError } from "./proxy-replacements.ts";
import type { ProfileStore } from "./store.ts";
import { editedLocalProfile, replaceLocalProfileProxies } from "../agent/local-profiles.ts";
import { buildStoredFingerprintReport } from "./fingerprint-report.ts";
import { discoverLocalProxies, type LocalProxyDiscoveryOptions } from "./network-diagnostics.ts";
import { isSafeProfileId } from "./profile-id.ts";

export const AGENT_CONTROL_PROTOCOL = "aliasmode-agent-v1";
export const AGENT_CONTROL_PATH = "/api/agent/v1/connect";
export const AGENT_CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface AgentControlRequest {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentControlResponse {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AgentControlDeps {
  launcher: Launcher;
  store: ProfileStore;
  admission: LifecycleAdmissionController;
  firefoxCall?: (owner: FirefoxOwner, operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string) => void;
  geoipFetch?: FetchLike;
  discoverLocalProxies?: typeof discoverLocalProxies;
}

const FIREFOX_CAPABILITIES = ["firefox-native", "cookies", "navigation", "sessions", "mcp", "scripts"] as const;

type FirefoxLaunch = { engine?: "chromium" | "firefox"; firefoxOwner?: FirefoxOwner };

function isFirefoxEngine(launch: unknown): launch is FirefoxLaunch & { engine: "firefox" } {
  return (launch as FirefoxLaunch | null)?.engine === "firefox";
}

function isFirefoxLaunch(launch: unknown): launch is FirefoxLaunch & { engine: "firefox"; firefoxOwner: FirefoxOwner } {
  return isFirefoxEngine(launch) && !!launch.firefoxOwner;
}

function firefoxPublicFields(): { engine: "firefox"; capabilities: readonly string[] } {
  return { engine: "firefox", capabilities: FIREFOX_CAPABILITIES };
}

type SafeProfile = {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  running: boolean;
  engine?: "firefox";
  capabilities?: readonly string[];
  debugPort?: number;
  headless?: boolean;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("invalid_request", "request parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw agentError("invalid_request", `${name} must be a non-empty string`);
  }
  return value.trim();
}

class AgentControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentControlError";
  }
}

function agentError(code: string, message: string): AgentControlError {
  return new AgentControlError(code, message);
}

function errorResponse(id: number, error: unknown): AgentControlResponse {
  if (error instanceof AgentControlError || error instanceof ProxyReplacementInputError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error instanceof AgentControlError ? error.code : "invalid_request",
        message: error.message,
      },
    };
  }
  if (error instanceof BrowserLaunchError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error.failure === "mode_conflict" ? "mode_conflict" : "browser_launch_failed",
        message: error.guidance ?? error.message,
      },
    };
  }
  return {
    protocol: AGENT_CONTROL_PROTOCOL,
    id,
    ok: false,
    error: {
      code: "operation_failed",
      message: error instanceof Error ? error.message : "猫步·千境 operation failed",
    },
  };
}

export function parseAgentControlRequest(raw: string | Uint8Array): AgentControlRequest {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes === 0 || bytes > AGENT_CONTROL_MAX_MESSAGE_BYTES) {
    throw agentError("invalid_request", "agent request size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw agentError("invalid_request", "agent request must be valid JSON");
  }
  const request = object(value);
  if (
    request.protocol !== AGENT_CONTROL_PROTOCOL ||
    !Number.isSafeInteger(request.id) ||
    Number(request.id) < 1 ||
    typeof request.method !== "string" ||
    !request.method
  ) {
    throw agentError("invalid_request", "agent request has an invalid protocol shape");
  }
  if (request.params !== undefined) object(request.params);
  return request as unknown as AgentControlRequest;
}

export function validAgentAuthorization(header: string | null, nonce: string): boolean {
  return /^[a-f0-9]{64}$/.test(nonce) && header === `Bearer ${nonce}`;
}

export class AgentControlSession {
  private readonly openedByConnection = new Set<string>();
  private readonly openedEndpoints = new Map<string, string>();
  private readonly attachedExisting = new Set<string>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private cleanup?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps, private readonly openSignal?: AbortSignal) {}

  enqueue(raw: string | Uint8Array): Promise<AgentControlResponse> {
    let request: AgentControlRequest;
    try {
      request = parseAgentControlRequest(raw);
    } catch (error) {
      return Promise.resolve(errorResponse(1, error));
    }
    const run = this.queue.then(async () => {
      if (this.closed) throw agentError("connection_closed", "agent connection is closing");
      try {
        return {
          protocol: AGENT_CONTROL_PROTOCOL,
          id: request.id,
          ok: true,
          result: await this.dispatch(request.method, request.params ?? {}),
        } satisfies AgentControlResponse;
      } catch (error) {
        return errorResponse(request.id, error);
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  disconnect(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.cleanup = this.queue.then(async () => {
      for (const profileId of [...this.openedByConnection]) {
        await this.closeProfile(profileId).catch((error) => {
          this.deps.log?.(`agent cleanup for ${profileId} remains unconfirmed (${error instanceof Error ? error.message : "failed"})`);
        });
      }
    });
    return this.cleanup;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "profiles.list":
        return { profiles: await this.listProfiles() };
      case "profiles.inventory":
        if (Object.keys(params).length) throw agentError("invalid_request", "Profile inventory takes no parameters");
        return { profiles: this.profileInventory(false), liveness: "not-checked" };
      case "fingerprints.review":
        return this.reviewStoredFingerprint(params);
      case "network.discover":
        return await this.discoverNetwork(params);
      case "profiles.replaceProxies":
        return await this.replaceProfileProxies(params);
      case "profiles.create":
        return await this.createProfile(params);
      case "profiles.update":
        return await this.updateProfile(params);
      case "profiles.delete":
        return await this.deleteProfile(stringParam(params, "profileId"));
      case "browser.open":
        return await this.openProfile(params);
      case "browser.status":
        return await this.profileStatus(stringParam(params, "profileId"));
      case "firefox.tools.list":
        return { tools: await this.firefoxCall(stringParam(params, "profileId"), "mcp-list", {}) };
      case "firefox.tools.call":
        return await this.firefoxCall(stringParam(params, "profileId"), "mcp-call", {
          name: stringParam(params, "name"),
          ...(params.arguments === undefined ? {} : { arguments: object(params.arguments) }),
        });
      case "browser.detach":
        return this.detachProfile(stringParam(params, "profileId"));
      case "browser.close":
        return await this.closeProfile(stringParam(params, "profileId"),
          params.expectedEndpoint === undefined ? undefined : stringParam(params, "expectedEndpoint"));
      default:
        throw agentError("unknown_method", `unknown agent method: ${method}`);
    }
  }

  private reviewStoredFingerprint(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => key !== "profileId") || !isSafeProfileId(params.profileId)) {
      throw agentError("invalid_request", "fingerprint review requires only a valid profileId (1-128 safe characters)");
    }
    const profile = this.deps.store.getProfile(params.profileId);
    if (!profile) throw agentError("profile_not_found", "profile was not found");
    return buildStoredFingerprintReport(profile, {
      launch: this.deps.store.getLaunch(profile.id), captureSource: this.deps.store.getFingerprintSource(profile.id),
    });
  }

  private async discoverNetwork(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => !["host", "ports"].includes(key))
      || params.host !== undefined && params.host !== "127.0.0.1" && params.host !== "::1") {
      throw agentError("invalid_request", "network discovery supports only loopback host and bounded local ports");
    }
    const ports = params.ports;
    if (ports !== undefined && (!Array.isArray(ports) || ports.length < 1 || ports.length > 16
      || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ports).size !== ports.length)) {
      throw agentError("invalid_request", "network discovery requires 1-16 unique integer ports from 1 to 65535");
    }
    const options: LocalProxyDiscoveryOptions = {
      ...(params.host !== undefined ? { host: params.host as "127.0.0.1" | "::1" } : {}),
      ...(ports !== undefined ? { ports: [...ports as number[]] } : {}),
    };
    return { discovery: await (this.deps.discoverLocalProxies ?? discoverLocalProxies)(options) };
  }

  private async replaceProfileProxies(params: Record<string, unknown>) {
    return await this.deps.admission.run(
      { kind: "cleanup", profileIds: this.deps.store.listProfiles().map((profile) => profile.id) },
      () => replaceLocalProfileProxies(this.deps.store, params),
    );
  }

  private async updateProfile(params: Record<string, unknown>) {
    const profileId = stringParam(params, "profileId");
    const set = object(params.set);
    return await this.deps.admission.run({ kind: "cleanup", profileIds: [profileId] }, () => {
      if (this.deps.store.getLaunch(profileId)) throw agentError("profile_open", "close the profile before editing it");
      const profile = this.deps.store.getProfile(profileId);
      if (!profile) throw agentError("profile_not_found", "profile was not found");
      try {
        this.deps.store.upsertProfile(editedLocalProfile(profile, set));
      } catch (error) {
        throw agentError("invalid_request", error instanceof Error ? error.message : "invalid profile edit");
      }
      return { profileId, updated: true as const };
    });
  }

  private async firefoxCall(profileId: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    if (!isFirefoxLaunch(launch)) throw agentError("browser_not_firefox", "This profile is not running in Firefox");
    if (!(await this.deps.launcher.certifiedActive(profileId).catch(() => false))) {
      throw agentError("browser_not_running", "This Firefox profile is not safely running");
    }
    return await (this.deps.firefoxCall ?? callFirefoxOwner)(launch.firefoxOwner, operation, payload);
  }

  private async listProfiles(): Promise<SafeProfile[]> {
    await this.deps.launcher.reconcileOrphans();
    return this.profileInventory(true);
  }

  private profileInventory(includeRuntimeDetails: boolean): SafeProfile[] {
    return this.deps.store.listProfiles().map((profile) => {
      const launch = this.deps.store.getLaunch(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        group: profile.group,
        platform: profile.platform ?? "",
        tags: profile.tags ?? [],
        running: !!launch,
        ...(launch && includeRuntimeDetails ? { ...(isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
      };
    });
  }

  private async createProfile(params: Record<string, unknown>): Promise<{ id: string; temporary: boolean }> {
    const input = object(params.input ?? {});
    const temporary = params.temporary === true;
    const profile = buildNewProfile(input as NewProfileInput, (candidate) => !!this.deps.store.getProfile(candidate));
    if (profile.proxy) {
      await attachTimezones([profile], this.deps.geoipFetch, true).catch(() => {});
      syncFirefoxTimezone(profile);
    }
    this.deps.store.upsertProfile(profile);
    if (temporary) this.deps.store.markAgentTemporary(profile.id);
    return { id: profile.id, temporary };
  }

  private async openProfile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profileId = stringParam(params, "profileId");
    const options: BrowserOpenOptions = {};
    if (params.headless !== undefined) {
      if (typeof params.headless !== "boolean") throw agentError("invalid_request", "headless must be boolean");
      options.headless = params.headless;
    }
    const startupUrls = params.startupUrls === undefined
      ? []
      : Array.isArray(params.startupUrls) && params.startupUrls.every((value) => typeof value === "string" && /^https?:\/\//.test(value))
        ? params.startupUrls as string[]
        : (() => { throw agentError("invalid_request", "startupUrls must contain only HTTP(S) URLs"); })();

    const opened = await this.deps.admission.run(
      { kind: "start", profileIds: [profileId], signal: this.openSignal },
      async () => {
        const alreadyOpen = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
        const existing = alreadyOpen ? this.deps.store.getLaunch(profileId) : null;
        if (existing) {
          if (options.headless !== undefined && existing.headless !== options.headless) {
            throw new BrowserLaunchError("mode_conflict");
          }
          return { ws: existing.ws, port: existing.debugPort, alreadyOpen, headless: existing.headless ?? false };
        }

        const result = await this.deps.launcher.start(profileId, startupUrls, options);
        const launch = this.deps.store.getLaunch(profileId);
        return {
          ws: result.ws,
          port: result.port,
          // A browser that was running before this call (a busy one can fail the check above) is the
          // user's, unless this connection opened it; this connection must not close the user's.
          alreadyOpen: !!result.reattached && !this.openedByConnection.has(profileId),
          headless: launch?.headless ?? options.headless ?? false,
        };
      },
    );

    if (opened.alreadyOpen) this.attachedExisting.add(profileId);
    else {
      this.openedByConnection.add(profileId);
      this.openedEndpoints.set(profileId, opened.ws);
    }
    if (this.closed && !opened.alreadyOpen) await this.closeProfile(profileId);
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    const firefox = isFirefoxEngine(launch) || opened.ws.startsWith("firefox://");
    return {
      profileId,
      ...(firefox
        ? firefoxPublicFields()
        : { ws: opened.ws, port: opened.port }),
      headless: opened.headless,
      alreadyOpen: opened.alreadyOpen,
      ownedByConnection: !opened.alreadyOpen,
    };
  }

  private detachProfile(profileId: string): { profileId: string; detached: true } {
    if (!this.openedByConnection.delete(profileId)) {
      throw agentError("not_owned", "this agent connection does not own the browser");
    }
    this.openedEndpoints.delete(profileId);
    this.attachedExisting.add(profileId);
    return { profileId, detached: true };
  }

  private async profileStatus(profileId: string): Promise<unknown> {
    const running = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
    const launch = this.deps.store.getLaunch(profileId);
    return {
      profileId,
      running,
      state: running ? "running" : launch ? "uncertain" : "closed",
      ...(running && launch ? (
        isFirefoxEngine(launch)
          ? { ...firefoxPublicFields(), headless: launch.headless ?? false }
          : { ws: launch.ws, port: launch.debugPort, headless: launch.headless ?? false }
      ) : {}),
      ownedByConnection: this.openedByConnection.has(profileId),
      attachedExisting: this.attachedExisting.has(profileId),
    };
  }

  private async closeProfile(profileId: string, expectedEndpoint?: string): Promise<{
    profileId: string;
    closed: true;
    deleted: boolean;
  }> {
    return await this.deps.admission.run(
      { kind: "stop", profileIds: [profileId] },
      async () => {
        const expected = expectedEndpoint ?? this.openedEndpoints.get(profileId);
        if (expected && this.deps.store.getLaunch(profileId)?.ws !== expected) {
          this.openedByConnection.delete(profileId);
          this.openedEndpoints.delete(profileId);
          throw agentError("browser_changed", "The browser instance changed; the current browser was left open");
        }
        const closed = await this.deps.launcher.stop(profileId);
        if (!closed) throw agentError("close_unconfirmed", `browser teardown is unconfirmed: ${profileId}`);

        this.openedByConnection.delete(profileId);
        this.openedEndpoints.delete(profileId);
        this.attachedExisting.delete(profileId);
        const temporary = this.deps.store.listAgentTemporary().includes(profileId);
        let deleted = false;
        if (temporary) {
          deleted = await this.deleteClosedProfile(profileId);
        }
        return {
          profileId,
          closed: true as const,
          deleted,
        };
      },
    );
  }

  private async deleteProfile(profileId: string): Promise<{ profileId: string; deleted: boolean }> {
    return await this.deps.admission.run(
      { kind: "cleanup", profileIds: [profileId] },
      async () => {
        if (this.deps.store.getLaunch(profileId)) {
          throw agentError("profile_open", "close the profile before deleting it");
        }
        return { profileId, deleted: await this.deleteClosedProfile(profileId) };
      },
    );
  }

  private async deleteClosedProfile(profileId: string): Promise<boolean> {
    if (!this.deps.store.getProfile(profileId)) {
      this.deps.store.clearAgentTemporary(profileId);
      return false;
    }
    // The cache delete after a close runs on after stop() returns; the profile is closed, so wait for it.
    await this.deps.launcher.cacheCleanupSettled(profileId);
    if (this.deps.launcher.profileDeletionBlocked(profileId)) {
      throw agentError("profile_open", "close the profile before deleting it");
    }
    this.deps.launcher.removeUserDataDir(profileId);
    return this.deps.store.deleteProfile(profileId);
  }
}

export class AgentControlHub {
  private cleanupInFlight?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps) {}

  connect(): AgentControlSession {
    return new AgentControlSession(this.deps);
  }

  cleanupTemporaryProfiles(): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    this.cleanupInFlight = this.doCleanupTemporaryProfiles().finally(() => {
      this.cleanupInFlight = undefined;
    });
    return this.cleanupInFlight;
  }

  private async doCleanupTemporaryProfiles(): Promise<void> {
    for (const profileId of this.deps.store.listAgentTemporary()) {
      if (this.deps.store.getLaunch(profileId)) continue;
      const session = new AgentControlSession(this.deps);
      await session.enqueue(JSON.stringify({
        protocol: AGENT_CONTROL_PROTOCOL,
        id: 1,
        method: "profiles.delete",
        params: { profileId },
      })).catch(() => undefined);
    }
  }
}
