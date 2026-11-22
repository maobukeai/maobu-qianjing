import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  AssistantProposalRegistry,
  createProxyVaultLookup,
  type ProposalStreamEvent,
} from "./assistant-proposals.ts";
import { buildNewProfile } from "./create.ts";
import { handleFeatureSettingsRequest } from "./feature-settings.ts";
import { LocalAssistantService } from "./local-assistant.ts";
import { ProxyVaultStore } from "./src/proxy-vault/proxy-vault-store.ts";
import {
  handleAssistantProposalRoutes,
  type AssistantProposalRouteOptions,
} from "./src/ui/assistant-proposals-routes.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";
import { WorkspaceBusyError } from "./workspace-maintenance.ts";

const stores: ProfileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function makeStore(): ProfileStore {
  const store = new ProfileStore(":memory:", { protection: { key: randomBytes(32) } });
  stores.push(store);
  return store;
}

function makeProfile(id: string, overrides: Partial<Profile> = {}): Profile {
  return {
    ...buildNewProfile({ name: `Env ${id}`, group: "Inbox", username: "u", password: "secret-password" }, () => false),
    id,
    ...overrides,
  };
}

function makeReq(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    omitSettingsHeader?: boolean;
    url?: string;
  } = {},
): Request {
  const method = options.method ?? "GET";
  return new Request(options.url ?? `http://127.0.0.1:50400${path}`, {
    method,
    headers: {
      ...(options.omitSettingsHeader ? {} : { "X-Maobu-Settings": "1" }),
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    ...(method !== "GET"
      ? { body: options.raw ?? JSON.stringify(options.body ?? {}) }
      : {}),
  });
}

async function callRoute(
  req: Request,
  store: ProfileStore,
  options: AssistantProposalRouteOptions = {},
): Promise<Response> {
  const { pathname } = new URL(req.url);
  const res = await handleAssistantProposalRoutes(req, pathname, store, options);
  if (!res) throw new Error(`Expected route handler for ${pathname}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  return res;
}

async function readNdjson(res: Response): Promise<ProposalStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProposalStreamEvent);
}

describe("handleAssistantProposalRoutes security & validation", () => {
  test("returns null for unrelated paths and enforces loopback, same-origin, X-Maobu-Settings, and JSON guards", async () => {
    const store = makeStore();
    const registry = new AssistantProposalRegistry();
    expect(
      await handleAssistantProposalRoutes(
        makeReq("/ui/api/profiles"),
        "/ui/api/profiles",
        store,
        { proposalRegistry: registry },
      ),
    ).toBeNull();

    const pid = "prop_0123456789abcdef";
    const checks: Array<[string, "GET" | "POST"]> = [
      [`/ui/api/assistant/proposals/${pid}`, "GET"],
      [`/ui/api/assistant/proposals/${pid}/execute`, "POST"],
      [`/ui/api/assistant/proposals/${pid}/abort`, "POST"],
    ];

    for (const [path, method] of checks) {
      expect((await callRoute(makeReq(path, { method, omitSettingsHeader: true }), store, { proposalRegistry: registry })).status).toBe(403);
      expect((await callRoute(makeReq(path, { method, headers: { Origin: "https://evil.example" } }), store, { proposalRegistry: registry })).status).toBe(403);
      expect((await callRoute(makeReq(path, { method, headers: { "Sec-Fetch-Site": "cross-site" } }), store, { proposalRegistry: registry })).status).toBe(403);
      expect((await callRoute(makeReq(path, { method, url: `http://evil.example${path}` }), store, { proposalRegistry: registry })).status).toBe(403);
      if (method === "POST") {
        expect(
          (
            await callRoute(
              makeReq(path, { method, headers: { "Content-Type": "text/plain" } }),
              store,
              { proposalRegistry: registry },
            )
          ).status,
        ).toBe(415);
      }
    }

    // Method not allowed & invalid ID checks
    const wrongMethod = await callRoute(makeReq(`/ui/api/assistant/proposals/${pid}`, { method: "POST" }), store, {
      proposalRegistry: registry,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");

    const badId = await callRoute(makeReq("/ui/api/assistant/proposals/not-a-valid-id"), store, {
      proposalRegistry: registry,
    });
    expect(badId.status).toBe(400);
  });
});

describe("chat proposal compilation -> NDJSON execute -> abort -> reconnect", () => {
  test("full two-stage pipeline: chat(proposalMode) compiles, execute streams NDJSON, leases mutation, and emits events", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1", { group: "Inbox" }), makeProfile("p2", { group: "Inbox" })]);
    const registry = new AssistantProposalRegistry();

    const proposalBlock = JSON.stringify({
      version: 1,
      title: "Move p1 and p2 to Ops",
      summary: "Organize inbox profiles into Ops",
      action: {
        type: "batch_move_group",
        profileIds: ["p1", "p2"],
        targetGroup: "Ops",
        allowCreateGroup: true,
      },
    });
    const assistant = new LocalAssistantService({
      transport: async (_endpoint, opts) => {
        if (opts.path === "/api/tags") {
          return { models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 1000 }] };
        }
        return {
          model: "qwen3:8b",
          done: true,
          message: {
            role: "assistant",
            content: `I prepared a group move proposal.\n\n\`\`\`maobu-proposal\n${proposalBlock}\n\`\`\``,
          },
        };
      },
    });

    const chatRes = await handleFeatureSettingsRequest(
      makeReq("/ui/api/settings/assistant/chat", {
        method: "POST",
        body: {
          model: "qwen3:8b",
          messages: [{ role: "user", content: "Move p1 and p2 to Ops" }],
          proposalMode: true,
        },
      }),
      store,
      { assistant, proposalRegistry: registry },
    );
    expect(chatRes?.status).toBe(200);
    const chatData = (await chatRes!.json()) as any;
    expect(chatData.ok).toBe(true);
    expect(chatData.proposal).toBeDefined();
    expect(chatData.proposal.actionType).toBe("batch_move_group");
    expect(chatData.proposal.counts).toEqual({ total: 2, actionable: 2, skipped: 0 });
    // Nothing executed automatically!
    expect(store.getProfile("p1")?.group).toBe("Inbox");
    expect(store.getProfile("p2")?.group).toBe("Inbox");

    // Verify GET status snapshot before execute
    const beforeStatus = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${chatData.proposal.proposalId}`),
      store,
      { proposalRegistry: registry },
    );
    expect(beforeStatus.status).toBe(200);
    const beforeJson = (await beforeStatus.json()) as any;
    expect(beforeJson.execution.status).toBe("compiled");

    // Verify mutation lease + SSE emitEvent + partial selection (only p1)
    let leaseCount = 0;
    let leaseReleased = 0;
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const executeRes = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${chatData.proposal.proposalId}/execute`, {
        method: "POST",
        body: {
          planHash: chatData.proposal.planHash,
          selectedProfileIds: ["p1"],
        },
      }),
      store,
      {
        proposalRegistry: registry,
        workspaceManagement: {
          currentId: () => "",
          acquireMutationLease: () => {
            leaseCount++;
            return () => {
              leaseReleased++;
            };
          },
        } as never,
        emitEvent: (type, payload) => emitted.push({ type, payload }),
      },
    );
    expect(executeRes.status).toBe(200);
    expect(executeRes.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readNdjson(executeRes);
    expect(events.map((e) => e.type)).toEqual(["start", "item", "summary"]);
    expect(leaseCount).toBe(1);
    expect(leaseReleased).toBe(1);
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(store.getProfile("p1")?.group).toBe("Ops");
    expect(store.getProfile("p2")?.group).toBe("Inbox");

    // Reconnect snapshot after completion
    const afterStatus = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${chatData.proposal.proposalId}`),
      store,
      { proposalRegistry: registry },
    );
    const afterJson = (await afterStatus.json()) as any;
    expect(afterJson.execution.status).toBe("completed");
    expect(afterJson.execution.succeeded).toBe(1);
  });

  test("abort endpoint stops queued items mid-stream and returns aborted receipt snapshot", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1"), makeProfile("p2"), makeProfile("p3")]);
    const registry = new AssistantProposalRegistry();

    let startedFirst!: () => void;
    const firstReady = new Promise<void>((r) => {
      startedFirst = r;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const launcher = {
      async start(id: string) {
        if (id === "p1") {
          startedFirst();
          await gate;
        }
        store.recordLaunch({ profileId: id, pid: 1, debugPort: 9222, ws: `ws://127.0.0.1:9222/${id}`, startedAt: 1 });
        return { ws: `ws://127.0.0.1:9222/${id}`, port: 9222 };
      },
      async stop() {
        return true;
      },
      async captureLocalSession() {
        return true;
      },
    };

    const compiled = registry.compileAndStore(
      {
        version: 1,
        title: "Launch 3",
        summary: "Launch 3",
        action: { type: "batch_launch_profiles", profileIds: ["p1", "p2", "p3"], concurrency: 1 },
      },
      store,
      { workspaceId: "ws-abort" },
    );
    const opts: AssistantProposalRouteOptions = {
      proposalRegistry: registry,
      launcher,
      workspaceManagement: {
        currentId: () => "ws-abort",
        acquireMutationLease: () => () => {},
      } as never,
    };

    const execRes = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}/execute`, {
        method: "POST",
        body: { planHash: compiled.planHash },
      }),
      store,
      opts,
    );
    const streamPromise = readNdjson(execRes);
    await firstReady;

    const abortRes = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}/abort`, {
        method: "POST",
        body: {},
      }),
      store,
      opts,
    );
    expect(abortRes.status).toBe(200);
    const abortData = (await abortRes.json()) as any;
    expect(abortData.aborted).toBe(true);

    releaseFirst();
    const events = await streamPromise;
    expect(events.at(-1)?.type).toBe("aborted");

    const reconnect = await callRoute(makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}`), store, opts);
    const reconnectData = (await reconnect.json()) as any;
    expect(reconnectData.execution.status).toBe("aborted");
    expect(reconnectData.execution.succeeded).toBe(1);
    expect(reconnectData.execution.aborted).toBe(2);
  });

  test("workspace busy returns 423 without sticking proposal in running state, and high-risk requires confirmHighRisk", async () => {
    const store = makeStore();
    store.upsertProfile(makeProfile("p1", { proxy: null, proxyError: "broken" }));
    const vault = new ProxyVaultStore(store);
    const px = vault.create({ name: "US-1", group: "US", type: "http", host: "198.51.100.5", port: 8080 });
    vault.recordCheckResult(px.id, { status: "working", latencyMs: 50, ip: "198.51.100.5", country: "US" });
    const proxyVault = createProxyVaultLookup(store);

    const registry = new AssistantProposalRegistry();
    const compiled = registry.compileAndStore(
      {
        version: 1,
        title: "Replace proxy",
        summary: "Replace",
        action: {
          type: "batch_replace_failed_proxies",
          profileIds: ["p1"],
          source: "proxy_vault_healthy",
          skipRunning: true,
        },
      },
      store,
      { workspaceId: "ws-busy", proxyVault },
    );

    const busyRes = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}/execute`, {
        method: "POST",
        body: { planHash: compiled.planHash, confirmHighRisk: true },
      }),
      store,
      {
        proposalRegistry: registry,
        proxyVault,
        workspaceManagement: {
          currentId: () => "ws-busy",
          acquireMutationLease: () => {
            throw new WorkspaceBusyError("Backup in progress");
          },
        } as never,
      },
    );
    expect(busyRes.status).toBe(423);
    expect(registry.getSnapshot(compiled.proposalId, "ws-busy")?.execution.status).toBe("compiled");

    // Missing confirmHighRisk -> 400
    const missingConfirm = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}/execute`, {
        method: "POST",
        body: { planHash: compiled.planHash },
      }),
      store,
      {
        proposalRegistry: registry,
        proxyVault,
        workspaceManagement: { currentId: () => "ws-busy", acquireMutationLease: () => () => {} } as never,
      },
    );
    expect(missingConfirm.status).toBe(400);
    expect(((await missingConfirm.json()) as any).code).toBe("high_risk_confirmation_required");

    // With confirmHighRisk: true -> 200 NDJSON and proxy replaced!
    const okRes = await callRoute(
      makeReq(`/ui/api/assistant/proposals/${compiled.proposalId}/execute`, {
        method: "POST",
        body: { planHash: compiled.planHash, confirmHighRisk: true },
      }),
      store,
      {
        proposalRegistry: registry,
        proxyVault,
        workspaceManagement: { currentId: () => "ws-busy", acquireMutationLease: () => () => {} } as never,
      },
    );
    expect(okRes.status).toBe(200);
    const events = await readNdjson(okRes);
    expect(events.at(-1)?.type).toBe("summary");
    expect(store.getProfile("p1")?.proxy?.host).toBe("198.51.100.5");
  });
});
