import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  AssistantProposalError,
  AssistantProposalRegistry,
  buildAssistantActionCatalog,
  buildProposalModeSystemPrompt,
  createProxyVaultLookup,
  FORBIDDEN_PROPOSAL_ACTIONS,
  MAX_CATALOG_PROFILES,
  MAX_PROPOSAL_BLOCK_BYTES,
  MAX_PROPOSAL_TARGETS,
  MAX_STORED_PROPOSALS,
  parseAssistantProposal,
  PROPOSAL_TTL_MS,
  safeActionCatalog,
  stripProposalBlock,
  type AssistantProposalAction,
  type AssistantProxyVaultLookup,
  type ProposalStreamEvent,
} from "./assistant-proposals.ts";
import { buildNewProfile } from "./create.ts";
import { ProxyVaultStore } from "./src/proxy-vault/proxy-vault-store.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

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
  const base = buildNewProfile(
    {
      name: `Profile ${id}`,
      group: "Alpha",
      username: `secret-user-${id}`,
      password: `secret-password-${id}`,
      email: `secret-${id}@example.invalid`,
      emailPassword: `secret-email-pass-${id}`,
      twofa: "JBSWY3DPEHPK3PXP",
    },
    () => false,
  );
  return {
    ...base,
    id,
    cookies: [{ name: "sid", value: `secret-cookie-${id}`, domain: ".example.invalid", path: "/" }],
    proxy: {
      type: "http",
      host: "198.51.100.42",
      port: "8080",
      user: `secret-proxy-user-${id}`,
      pass: `secret-proxy-pass-${id}`,
    },
    ...overrides,
  };
}

function wrapProposal(payload: unknown, prose = "Here is the proposed action."): string {
  return `${prose}\n\n\`\`\`maobu-proposal\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

describe("assistant action catalog redaction & bounds", () => {
  test("buildAssistantActionCatalog never leaks sensitive profile, launch, session, or vault fields", () => {
    const store = makeStore();
    const p1 = makeProfile("p001", { tags: ["vip", "us"] });
    const p2 = makeProfile("p002", { proxy: null, proxyError: "raw-secret-proxy-host.invalid:9999:u:p" });
    (p1 as unknown as Record<string, unknown>).notes = "secret-operator-note-do-not-leak";
    store.upsertProfiles([p1, p2]);
    store.saveSessionBundle("p001", '{"cookies":[{"name":"auth","value":"secret-session-cookie"}]}');
    store.recordLaunch({
      profileId: "p001",
      pid: 4242,
      debugPort: 9444,
      ws: "ws://127.0.0.1:9444/secret-cdp-token",
      startedAt: 1_700_000_000_000,
      firefoxOwner: { port: 9555, token: "secret-firefox-owner-token" } as never,
    });

    const vault = new ProxyVaultStore(store);
    const created = vault.create({
      name: "US Residential 01",
      group: "US-Pool",
      type: "socks5",
      host: "203.0.113.77",
      port: 1080,
      user: "vault-secret-user",
      pass: "vault-secret-pass",
      refreshUrl: "https://refresh.example.com/rotate?token=secret-refresh-token",
      notes: "secret-vault-notes-value",
    });
    vault.recordCheckResult(created.id, {
      status: "working",
      latencyMs: 120,
      ip: "203.0.113.88",
      country: "US",
    });

    const lookup = createProxyVaultLookup(store);
    const catalog = buildAssistantActionCatalog(store, { proxyVault: lookup });
    const prompt = buildProposalModeSystemPrompt(catalog);
    const serialized = JSON.stringify(catalog) + "\n" + prompt;

    expect(catalog.totalProfiles).toBe(2);
    expect(catalog.omittedCount).toBe(0);
    // Anomalous profile (proxyError) is sorted ahead of healthy profile.
    expect(catalog.profiles[0]!.id).toBe("p002");
    expect(catalog.profiles[0]!.proxyError).toBe(true);
    expect(catalog.profiles[1]!.id).toBe("p001");
    expect(catalog.profiles[1]!.running).toBe(true);
    expect(catalog.proxyVaultAvailable).toBe(true);
    expect(catalog.proxyVaultSummary).toEqual([
      {
        vaultId: created.id,
        label: "US Residential 01",
        group: "US-Pool",
        type: "socks5",
        country: "US",
        status: "working",
        assignedCount: 0,
      },
    ]);

    for (const secret of [
      "secret-user-p001",
      "secret-password-p001",
      "secret-p001@example.invalid",
      "secret-email-pass-p001",
      "JBSWY3DPEHPK3PXP",
      "secret-cookie-p001",
      "secret-session-cookie",
      "198.51.100.42",
      "8080",
      "secret-proxy-user-p001",
      "secret-proxy-pass-p001",
      "raw-secret-proxy-host.invalid",
      "secret-cdp-token",
      "9444",
      "secret-firefox-owner-token",
      "secret-operator-note-do-not-leak",
      "203.0.113.77",
      "203.0.113.88",
      "1080",
      "vault-secret-user",
      "vault-secret-pass",
      "secret-refresh-token",
      "refresh.example.com",
      "secret-vault-notes-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("caps profiles at 200, prioritizes anomalies, and stays within RemoteAssistantService 16 KiB system budget", () => {
    const store = makeStore();
    const list: Profile[] = [];
    for (let i = 0; i < 230; i++) {
      const id = `prof_${String(i).padStart(3, "0")}`;
      list.push(
        makeProfile(id, {
          name: `Account ${i}`,
          group: `Group-${i % 15}`,
          tags: [`tag-${i % 20}`],
          proxy: i === 225 ? null : { type: "http", host: "198.51.100.1", port: "8080", user: "", pass: "" },
          proxyError: i === 225 ? "broken" : undefined,
        }),
      );
    }
    store.upsertProfiles(list);

    const catalog = buildAssistantActionCatalog(store);
    expect(catalog.totalProfiles).toBe(230);
    expect(catalog.profiles.length).toBeLessThanOrEqual(MAX_CATALOG_PROFILES);
    expect(catalog.profiles.length + catalog.omittedCount).toBe(230);
    expect(catalog.omittedCount).toBeGreaterThanOrEqual(30);
    // Anomalous profile #225 must be first even though its ID sorts near the end.
    expect(catalog.profiles[0]!.id).toBe("prof_225");
    expect(catalog.profiles[0]!.proxyError).toBe(true);

    const prompt = buildProposalModeSystemPrompt(catalog);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  test("safeActionCatalog strips any injected extra private fields", () => {
    const sanitized = safeActionCatalog({
      profiles: [
        {
          id: "p001",
          name: "Safe Name",
          group: "G1",
          tags: ["t1"],
          engine: "chromium",
          running: false,
          hasProxy: true,
          proxyError: false,
          restartPending: false,
          mobilePersona: false,
          fpStatus: "consistent",
          lastOpenAt: 100,
          password: "leaked-password",
          cookies: [{ value: "leaked-cookie" }],
          notes: "leaked-notes",
          ws: "ws://127.0.0.1:9222/leaked",
        },
      ],
      omittedCount: 0,
      totalProfiles: 1,
      groups: ["G1"],
      tags: ["t1"],
      proxyVaultSummary: [
        {
          vaultId: "pxv_0123456789abcdef",
          label: "Vault-1",
          group: "US",
          type: "http",
          country: "US",
          status: "working",
          assignedCount: 0,
          host: "198.51.100.9",
          pass: "leaked-vault-pass",
          refreshUrl: "https://leaked-refresh.invalid",
        },
      ],
      proxyVaultAvailable: true,
      secretExtra: "leaked-root",
    });

    const json = JSON.stringify(sanitized);
    for (const leaked of ["leaked-password", "leaked-cookie", "leaked-notes", "leaked-vault-pass", "leaked-refresh", "198.51.100.9", "leaked-root"]) {
      expect(json).not.toContain(leaked);
    }
  });
});

describe("proposal parser & strict security validation", () => {
  test("returns none for plain assistant replies and strips fenced block cleanly", () => {
    expect(parseAssistantProposal("Plain advice with ```json\n{\"a\":1}\n```")).toEqual({ status: "none" });
    const text = wrapProposal({
      version: 1,
      title: "Move profiles",
      action: { type: "batch_move_group", profileIds: ["p1"], targetGroup: "US" },
    }, "Review before running:");
    expect(stripProposalBlock(text)).toBe("Review before running:");
    const parsed = parseAssistantProposal(text);
    expect(parsed.status).toBe("ok");
  });

  test("rejects multiple blocks, incomplete blocks, oversized (>16 KiB) blocks, and prototype pollution", () => {
    const oneBlock = wrapProposal({
      version: 1,
      action: { type: "batch_move_group", profileIds: ["p1"], targetGroup: "US" },
    });
    expect(parseAssistantProposal(`${oneBlock}\n${oneBlock}`)).toMatchObject({
      status: "error",
      code: "multiple_proposal_blocks",
    });
    expect(parseAssistantProposal("```maobu-proposal\n{\"version\":1}")).toMatchObject({
      status: "error",
      code: "invalid_proposal_json",
    });

    const huge = `\`\`\`maobu-proposal\n{"version":1,"title":"${"a".repeat(MAX_PROPOSAL_BLOCK_BYTES + 100)}","action":{"type":"batch_move_group","profileIds":["p1"],"targetGroup":"US"}}\n\`\`\``;
    expect(parseAssistantProposal(huge)).toMatchObject({
      status: "error",
      code: "proposal_too_large",
    });

    const protoPolluted = `\`\`\`maobu-proposal\n{"version":1,"__proto__":{"polluted":true},"action":{"type":"batch_move_group","profileIds":["p1"],"targetGroup":"US"}}\n\`\`\``;
    expect(parseAssistantProposal(protoPolluted)).toMatchObject({
      status: "error",
      code: "invalid_proposal_json",
    });
  });

  test("hard-rejects every forbidden action and raw proxy specifications", () => {
    for (const forbidden of [...FORBIDDEN_PROPOSAL_ACTIONS, "delete_profiles", "export_cookies", "run_rpa_script"]) {
      const res = parseAssistantProposal(wrapProposal({ version: 1, action: { type: forbidden, profileIds: ["p1"] } }));
      expect(res).toMatchObject({ status: "error", code: "forbidden_action" });
    }

    // Raw proxy injection inside batch_replace_failed_proxies must be rejected.
    for (const badAction of [
      {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "raw_proxy_string",
        skipRunning: true,
      },
      {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "proxy_vault_healthy",
        skipRunning: true,
        raw_proxy_string: "198.51.100.1:8080:u:p",
      },
      {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "proxy_vault_healthy",
        skipRunning: true,
        host: "198.51.100.1",
      },
      {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "proxy_vault_healthy",
        skipRunning: false,
      },
      {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "proxy_vault_healthy",
        vaultGroup: "http://u:p@198.51.100.1:8080",
        skipRunning: true,
      },
    ]) {
      const res = parseAssistantProposal(wrapProposal({ version: 1, action: badAction }));
      expect(res.status).toBe("error");
    }
  });

  test("enforces MAX_PROPOSAL_TARGETS = 200 and isSafeProfileId", () => {
    const tooMany = Array.from({ length: MAX_PROPOSAL_TARGETS + 1 }, (_, i) => `p${i}`);
    expect(
      parseAssistantProposal(
        wrapProposal({ version: 1, action: { type: "batch_move_group", profileIds: tooMany, targetGroup: "US" } }),
      ),
    ).toMatchObject({ status: "error", code: "too_many_targets" });

    for (const badId of ["../etc/passwd", "CON", "aux", "p 1", "p/1", ""]) {
      expect(
        parseAssistantProposal(
          wrapProposal({ version: 1, action: { type: "batch_move_group", profileIds: [badId], targetGroup: "US" } }),
        ),
      ).toMatchObject({ status: "error", code: "invalid_profile_id" });
    }
  });
});

describe("dry-run compilation, 7 whitelisted actions, Wave 3 Proxy Vault, TOCTOU & abort", () => {
  async function compileAndRun(
    registry: AssistantProposalRegistry,
    store: ProfileStore,
    action: AssistantProposalAction,
    opts: {
      workspaceId?: string;
      proxyVault?: AssistantProxyVaultLookup;
      launcher?: {
        start: (id: string) => Promise<any>;
        stop: (id: string, expected?: any) => Promise<boolean>;
        captureLocalSession: (id: string) => Promise<boolean>;
      };
      selectedProfileIds?: string[];
      confirmHighRisk?: boolean;
      beforeExecute?: (proposalId: string, planHash: string) => void;
    } = {},
  ) {
    const workspaceId = opts.workspaceId ?? "ws-main";
    const compiled = registry.compileAndStore(
      { version: 1, title: "Test proposal", summary: "Test summary", action },
      store,
      { workspaceId, proxyVault: opts.proxyVault },
    );
    opts.beforeExecute?.(compiled.proposalId, compiled.planHash);
    const prepared = registry.prepareExecution(compiled.proposalId, workspaceId, {
      planHash: compiled.planHash,
      selectedProfileIds: opts.selectedProfileIds,
      confirmHighRisk: opts.confirmHighRisk,
    });
    const events: ProposalStreamEvent[] = [];
    const snapshot = await prepared.start(
      { store, launcher: opts.launcher, proxyVault: opts.proxyVault },
      (event) => events.push(event),
    );
    return { compiled, events, snapshot };
  }

  test("1. filter_anomalous_profiles finds anomalies read-only with zero mutations", async () => {
    const store = makeStore();
    const pErr = makeProfile("p_err", { group: "Ops", proxy: null, proxyError: "invalid" });
    const pNoProxy = makeProfile("p_noproxy", { group: "Ops", proxy: null });
    const pMobile = makeProfile("p_mobile", {
      group: "Ops",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    });
    const pOther = makeProfile("p_other", { group: "Other", proxy: null, proxyError: "invalid" });
    store.upsertProfiles([pErr, pNoProxy, pMobile, pOther]);

    const registry = new AssistantProposalRegistry();
    const { compiled, snapshot } = await compileAndRun(registry, store, {
      type: "filter_anomalous_profiles",
      criteria: ["proxy_error", "mobile_persona", "no_proxy"],
      group: "Ops",
    });

    expect(compiled.risk).toBe("read-only");
    expect(compiled.mutatesWorkspace).toBe(false);
    expect(compiled.items.map((item) => item.profileId).sort()).toEqual(["p_err", "p_mobile", "p_noproxy"]);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.filterResult?.profileIds.sort()).toEqual(["p_err", "p_mobile", "p_noproxy"]);
  });

  test("2. batch_move_group honors allowCreateGroup and moves selected subset only", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1", { group: "Alpha" }), makeProfile("p2", { group: "Alpha" })]);
    const registry = new AssistantProposalRegistry();

    const blocked = registry.compileAndStore(
      {
        version: 1,
        title: "Move to new group",
        summary: "Move",
        action: { type: "batch_move_group", profileIds: ["p1", "p2"], targetGroup: "BrandNew", allowCreateGroup: false },
      },
      store,
      { workspaceId: "ws-1" },
    );
    expect(blocked.counts.actionable).toBe(0);
    expect(blocked.warnings.some((w) => w.code === "group_not_found")).toBe(true);

    const { compiled, snapshot } = await compileAndRun(
      registry,
      store,
      { type: "batch_move_group", profileIds: ["p1", "p2"], targetGroup: "BrandNew", allowCreateGroup: true },
      { workspaceId: "ws-1", selectedProfileIds: ["p1"] },
    );
    expect(compiled.warnings.some((w) => w.code === "group_will_be_created")).toBe(true);
    expect(snapshot.succeeded).toBe(1);
    expect(store.getProfile("p1")?.group).toBe("BrandNew");
    expect(store.getProfile("p2")?.group).toBe("Alpha");
  });

  test("3. batch_update_tags supports add/remove/replace with normalizeProfileTags validation", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1", { tags: ["alpha", "beta"] })]);
    const registry = new AssistantProposalRegistry();

    await compileAndRun(registry, store, {
      type: "batch_update_tags",
      profileIds: ["p1"],
      mode: "add",
      tags: ["Gamma", "BETA"],
    });
    expect(store.getProfile("p1")?.tags).toEqual(["alpha", "beta", "Gamma"]);

    await compileAndRun(registry, store, {
      type: "batch_update_tags",
      profileIds: ["p1"],
      mode: "remove",
      tags: ["beta"],
    });
    expect(store.getProfile("p1")?.tags).toEqual(["alpha", "Gamma"]);

    await compileAndRun(registry, store, {
      type: "batch_update_tags",
      profileIds: ["p1"],
      mode: "replace",
      tags: ["clean"],
    });
    expect(store.getProfile("p1")?.tags).toEqual(["clean"]);
  });

  test("4. batch_replace_failed_proxies returns vault_unavailable when empty and binds real Wave 3 Proxy Vault entries", async () => {
    const store = makeStore();
    store.upsertProfiles([
      makeProfile("p_closed_1", { proxy: null, proxyError: "legacy broken" }),
      makeProfile("p_closed_2", { proxy: null, proxyError: "legacy broken" }),
      makeProfile("p_running", { proxy: null, proxyError: "legacy broken" }),
    ]);
    store.recordLaunch({ profileId: "p_running", pid: 100, debugPort: 9222, ws: "ws://127.0.0.1:9222/x", startedAt: 1 });

    const registry = new AssistantProposalRegistry();
    // Unconfigured proxyVault -> vault_unavailable
    const noVault = registry.compileAndStore(
      {
        version: 1,
        title: "Replace proxies",
        summary: "Replace",
        action: {
          type: "batch_replace_failed_proxies",
          profileIds: ["p_closed_1"],
          source: "proxy_vault_healthy",
          skipRunning: true,
        },
      },
      store,
      { workspaceId: "ws-1" },
    );
    expect(noVault.warnings.some((w) => w.code === "vault_unavailable")).toBe(true);
    expect(noVault.items[0]?.skipReason).toBe("vault_unavailable");

    // Configured Wave 3 ProxyVaultStore but empty -> vault_unavailable
    const lookup = createProxyVaultLookup(store);
    const emptyVault = registry.compileAndStore(
      {
        version: 1,
        title: "Replace proxies",
        summary: "Replace",
        action: {
          type: "batch_replace_failed_proxies",
          profileIds: ["p_closed_1"],
          source: "proxy_vault_healthy",
          skipRunning: true,
        },
      },
      store,
      { workspaceId: "ws-1", proxyVault: lookup },
    );
    expect(emptyVault.warnings.some((w) => w.code === "vault_unavailable")).toBe(true);

    // Populate Wave 3 Proxy Vault with 2 healthy proxies on distinct exits + 1 failed proxy.
    const vault = new ProxyVaultStore(store);
    const px1 = vault.create({
      name: "US-Clean-1",
      group: "US",
      type: "http",
      host: "198.51.100.10",
      port: 8001,
      user: "u1",
      pass: "p1",
    });
    const px2 = vault.create({
      name: "US-Clean-2",
      group: "US",
      type: "socks5",
      host: "198.51.100.11",
      port: 8002,
      user: "u2",
      pass: "p2",
    });
    const pxFailed = vault.create({
      name: "US-Dead",
      group: "US",
      type: "http",
      host: "198.51.100.12",
      port: 8003,
    });
    vault.recordCheckResult(px1.id, { status: "working", latencyMs: 80, ip: "198.51.100.101", country: "US" });
    vault.recordCheckResult(px2.id, { status: "working", latencyMs: 90, ip: "198.51.100.102", country: "US" });
    vault.recordCheckResult(pxFailed.id, { status: "failed", latencyMs: null, reason: "timeout" });

    // Require high-risk confirmation!
    const compiled = registry.compileAndStore(
      {
        version: 1,
        title: "Replace failed proxies",
        summary: "Use healthy US vault proxies",
        action: {
          type: "batch_replace_failed_proxies",
          profileIds: ["p_closed_1", "p_closed_2", "p_running"],
          source: "proxy_vault_healthy",
          vaultGroup: "US",
          country: "US",
          avoidDuplicateExit: true,
          skipRunning: true,
        },
      },
      store,
      { workspaceId: "ws-1", proxyVault: lookup },
    );
    expect(compiled.risk).toBe("high");
    expect(compiled.requiresSecondaryConfirm).toBe(true);
    expect(compiled.counts).toEqual({ total: 3, actionable: 2, skipped: 1 });
    expect(compiled.items.find((i) => i.profileId === "p_running")?.skipReason).toBe("profile_running");
    // Preview view must NOT expose raw proxy host/port/auth!
    const compiledJson = JSON.stringify(compiled);
    expect(compiledJson).not.toContain("198.51.100.10");
    expect(compiledJson).not.toContain("p1");

    expect(() =>
      registry.prepareExecution(compiled.proposalId, "ws-1", { planHash: compiled.planHash }),
    ).toThrow(AssistantProposalError);

    const prepared = registry.prepareExecution(compiled.proposalId, "ws-1", {
      planHash: compiled.planHash,
      confirmHighRisk: true,
    });
    const events: ProposalStreamEvent[] = [];
    const snapshot = await prepared.start({ store, proxyVault: lookup }, (ev) => events.push(ev));
    expect(snapshot.status).toBe("completed");
    expect(snapshot.succeeded).toBe(2);

    const updated1 = store.getProfile("p_closed_1")!;
    const updated2 = store.getProfile("p_closed_2")!;
    expect(updated1.proxyError).toBeUndefined();
    expect(updated2.proxyError).toBeUndefined();
    expect(updated1.proxy?.host).not.toBe(updated2.proxy?.host);
    expect(vault.getView(px1.id)?.boundCount).toBe(1);
    expect(vault.getView(px2.id)?.boundCount).toBe(1);
    expect(vault.getView(pxFailed.id)?.boundCount).toBe(0);
  });

  test("5 & 6. batch_launch_profiles & batch_stop_profiles enforce bounded concurrency and captureLocalSession before stop", async () => {
    const store = makeStore();
    store.upsertProfiles([
      makeProfile("p1"),
      makeProfile("p2"),
      makeProfile("p3"),
      makeProfile("p_mobile", { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" }),
      makeProfile("p_open"),
    ]);
    store.recordLaunch({ profileId: "p_open", pid: 10, debugPort: 9222, ws: "ws://127.0.0.1:9222/open", startedAt: 10 });

    let activeLaunches = 0;
    let peakConcurrency = 0;
    const stopOrder: string[] = [];
    const launcher = {
      async start(id: string) {
        activeLaunches++;
        peakConcurrency = Math.max(peakConcurrency, activeLaunches);
        await new Promise((r) => setTimeout(r, 15));
        store.recordLaunch({ profileId: id, pid: 100, debugPort: 9300, ws: `ws://127.0.0.1:9300/${id}`, startedAt: Date.now() });
        activeLaunches--;
        return { port: 9300 };
      },
      async captureLocalSession(id: string) {
        stopOrder.push(`capture:${id}`);
        return true;
      },
      async stop(id: string) {
        stopOrder.push(`stop:${id}`);
        store.clearLaunch(id);
        return true;
      },
    };

    const registry = new AssistantProposalRegistry();
    const launchRun = await compileAndRun(
      registry,
      store,
      { type: "batch_launch_profiles", profileIds: ["p1", "p2", "p3", "p_mobile", "p_open"], concurrency: 2 },
      { launcher },
    );
    expect(launchRun.compiled.counts).toEqual({ total: 5, actionable: 3, skipped: 2 });
    expect(launchRun.snapshot.succeeded).toBe(3);
    expect(peakConcurrency).toBeLessThanOrEqual(2);

    const stopRun = await compileAndRun(
      registry,
      store,
      { type: "batch_stop_profiles", profileIds: ["p1", "p2", "p_mobile"], concurrency: 1 },
      { launcher },
    );
    expect(stopRun.compiled.counts).toEqual({ total: 3, actionable: 2, skipped: 1 });
    expect(stopRun.snapshot.succeeded).toBe(2);
    expect(stopOrder).toEqual(["capture:p1", "stop:p1", "capture:p2", "stop:p2"]);
  });

  test("7. generate_fingerprint_summary aggregates stored reports locally with zero DB writes", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1"), makeProfile("p2", { proxy: null, proxyError: "bad" })]);
    const registry = new AssistantProposalRegistry();

    const { compiled, snapshot } = await compileAndRun(registry, store, {
      type: "generate_fingerprint_summary",
      profileIds: ["p1", "p2"],
    });
    expect(compiled.risk).toBe("read-only");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.succeeded).toBe(2);
    expect(snapshot.fingerprintSummary?.total).toBe(2);
    expect(snapshot.fingerprintSummary?.issues).toBeGreaterThanOrEqual(1);
  });

  test("TOCTOU protection: tampered planHash fails 409, incarnation or state drift skips with version_conflict", async () => {
    const store = makeStore();
    store.upsertProfiles([
      makeProfile("p_ok", { group: "Alpha" }),
      makeProfile("p_recreated", { group: "Alpha" }),
      makeProfile("p_edited", { group: "Alpha" }),
    ]);
    const registry = new AssistantProposalRegistry();
    const compiled = registry.compileAndStore(
      {
        version: 1,
        title: "Move 3 profiles",
        summary: "Move",
        action: { type: "batch_move_group", profileIds: ["p_ok", "p_recreated", "p_edited"], targetGroup: "Beta", allowCreateGroup: true },
      },
      store,
      { workspaceId: "ws-1" },
    );

    // Tampered planHash rejected
    expect(() =>
      registry.prepareExecution(compiled.proposalId, "ws-1", { planHash: "0".repeat(64) }),
    ).toThrow(AssistantProposalError);

    // Drift #1: delete & recreate profile -> new incarnation UUID
    store.deleteProfile("p_recreated");
    store.upsertProfile(makeProfile("p_recreated", { group: "Alpha" }));
    // Drift #2: edit profile group in place -> stateDigest changes
    store.setGroup(["p_edited"], "ManualGroup");

    const prepared = registry.prepareExecution(compiled.proposalId, "ws-1", { planHash: compiled.planHash });
    const snapshot = await prepared.start({ store }, () => {});
    expect(snapshot.succeeded).toBe(1);
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.items.find((i) => i.profileId === "p_ok")?.status).toBe("succeeded");
    expect(snapshot.items.find((i) => i.profileId === "p_recreated")).toMatchObject({
      status: "skipped",
      reason: "version_conflict",
    });
    expect(snapshot.items.find((i) => i.profileId === "p_edited")).toMatchObject({
      status: "skipped",
      reason: "version_conflict",
    });
    expect(store.getProfile("p_ok")?.group).toBe("Beta");
    expect(store.getProfile("p_edited")?.group).toBe("ManualGroup");
  });

  test("bounded 32-entry table, 10-minute TTL expiration, and workspace switch clearing", () => {
    const store = makeStore();
    store.upsertProfile(makeProfile("p1"));
    let clock = 1_700_000_000_000;
    const registry = new AssistantProposalRegistry({ now: () => clock });
    const makeAction = (): AssistantProposalAction => ({
      type: "batch_move_group",
      profileIds: ["p1"],
      targetGroup: "Next",
      allowCreateGroup: true,
    });

    const ids: string[] = [];
    for (let i = 0; i < MAX_STORED_PROPOSALS + 4; i++) {
      const view = registry.compileAndStore({ version: 1, title: `P${i}`, summary: `P${i}`, action: makeAction() }, store, {
        workspaceId: "ws-A",
      });
      ids.push(view.proposalId);
    }
    expect(registry.size()).toBe(MAX_STORED_PROPOSALS);
    expect(registry.getSnapshot(ids[0]!, "ws-A")).toBeNull();
    expect(registry.getSnapshot(ids.at(-1)!, "ws-A")).not.toBeNull();

    // Workspace switch clears all old-workspace entries immediately.
    const wsB = registry.compileAndStore({ version: 1, title: "B", summary: "B", action: makeAction() }, store, {
      workspaceId: "ws-B",
    });
    expect(registry.size()).toBe(1);
    expect(registry.getSnapshot(ids.at(-1)!, "ws-A")).toBeNull();

    // TTL expiration after 10 minutes
    clock += PROPOSAL_TTL_MS + 1;
    expect(registry.getSnapshot(wsB.proposalId, "ws-B")?.expired).toBe(true);
    expect(() =>
      registry.prepareExecution(wsB.proposalId, "ws-B", { planHash: wsB.planHash }),
    ).toThrow(AssistantProposalError);
  });

  test("emergency stop aborts queued items cleanly while letting in-flight item settle, and retry runs only aborted items", async () => {
    const store = makeStore();
    store.upsertProfiles([makeProfile("p1"), makeProfile("p2"), makeProfile("p3")]);
    const registry = new AssistantProposalRegistry();

    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const launched: string[] = [];
    const launcher = {
      async start(id: string) {
        launched.push(id);
        if (id === "p1") {
          releaseFirst();
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
        summary: "Launch",
        action: { type: "batch_launch_profiles", profileIds: ["p1", "p2", "p3"], concurrency: 1 },
      },
      store,
      { workspaceId: "ws-1" },
    );

    const prepared = registry.prepareExecution(compiled.proposalId, "ws-1", { planHash: compiled.planHash });
    const events: ProposalStreamEvent[] = [];
    const running = prepared.start({ store, launcher }, (ev) => events.push(ev));

    await firstStarted;
    const abortRes = registry.abort(compiled.proposalId, "ws-1");
    expect(abortRes).toMatchObject({ found: true, aborted: true });
    resolveGate();

    const firstSnapshot = await running;
    expect(firstSnapshot.status).toBe("aborted");
    expect(firstSnapshot.succeeded).toBe(1);
    expect(firstSnapshot.aborted).toBe(2);
    expect(launched).toEqual(["p1"]);
    expect(events.at(-1)?.type).toBe("aborted");

    // Retry ONLY aborted items (p2, p3) against the same proposal
    const retryPrepared = registry.prepareExecution(compiled.proposalId, "ws-1", {
      planHash: compiled.planHash,
      selectedProfileIds: ["p2", "p3"],
    });
    const retrySnapshot = await retryPrepared.start({ store, launcher }, () => {});
    expect(retrySnapshot.status).toBe("completed");
    expect(retrySnapshot.succeeded).toBe(2);
    expect(launched).toEqual(["p1", "p2", "p3"]);
  });
});
