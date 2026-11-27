import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { ProxyRefreshCooldown, ProxyRefreshError } from "../src/proxy-vault/proxy-refresh-url.ts";
import {
  handleProxyVaultRoutes,
  type ProxyVaultRouteOptions,
} from "../src/ui/proxy-vault-routes.ts";

function makeStore(): ProfileStore {
  return new ProfileStore(":memory:", { protection: { key: randomBytes(32) } });
}

function jsonReq(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:41999${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function getReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:41999${path}`, { method: "GET", headers });
}

async function callRoute(
  req: Request,
  store: ProfileStore,
  options: ProxyVaultRouteOptions = {},
): Promise<Response> {
  const { pathname } = new URL(req.url);
  const res = await handleProxyVaultRoutes(req, pathname, store, options);
  if (!res) throw new Error(`Route not handled: ${req.method} ${pathname}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res;
}

describe("handleProxyVaultRoutes", () => {
  test("returns null for non-vault paths and enforces rejectUntrustedJsonMutation + Cache-Control: no-store on all mutating routes", async () => {
    const store = makeStore();
    try {
      expect(await handleProxyVaultRoutes(getReq("/ui/api/profiles"), "/ui/api/profiles", store)).toBeNull();

      const mutatingCalls: Array<[string, "POST" | "PATCH" | "DELETE"]> = [
        ["/ui/api/proxy-vault", "POST"],
        ["/ui/api/proxy-vault/pxv_0123456789abcdef", "PATCH"],
        ["/ui/api/proxy-vault/pxv_0123456789abcdef", "DELETE"],
        ["/ui/api/proxy-vault/delete", "POST"],
        ["/ui/api/proxy-vault/import/preview", "POST"],
        ["/ui/api/proxy-vault/import/apply", "POST"],
        ["/ui/api/proxy-vault/check", "POST"],
        ["/ui/api/proxy-vault/pxv_0123456789abcdef/refresh-ip", "POST"],
        ["/ui/api/proxy-vault/bind", "POST"],
        ["/ui/api/proxy-vault/sync-bound/pxv_0123456789abcdef", "POST"],
        ["/ui/api/proxy-vault/ingest-from-profiles", "POST"],
      ];

      for (const [path, method] of mutatingCalls) {
        // Missing Content-Type: application/json -> 415 with Cache-Control: no-store
        const noCt = await callRoute(new Request(`http://127.0.0.1:41999${path}`, { method }), store);
        expect(noCt.status).toBe(415);

        // Cross-origin Origin header -> 403 with Cache-Control: no-store
        const crossOrigin = await callRoute(
          jsonReq(path, method, {}, { Origin: "https://evil.example" }),
          store,
        );
        expect(crossOrigin.status).toBe(403);

        // Cross-site Sec-Fetch-Site header -> 403 with Cache-Control: no-store
        const crossSite = await callRoute(
          jsonReq(path, method, {}, { "Sec-Fetch-Site": "cross-site" }),
          store,
        );
        expect(crossSite.status).toBe(403);
      }
    } finally {
      store.close();
    }
  });

  test("full CRUD, edit plaintext, filter queries, batch delete, and import preview/apply", async () => {
    const store = makeStore();
    try {
      // Create
      const createdRes = await callRoute(
        jsonReq("/ui/api/proxy-vault", "POST", {
          name: "NY-Res-1",
          group: "US",
          type: "http",
          host: "198.51.100.1",
          port: 8080,
          user: "alice",
          pass: "super-secret-password",
          refreshUrl: "https://rotate.example.com/ip?key=SECRET_KEY_123",
          notes: "tier-1",
        }),
        store,
      );
      expect(createdRes.status).toBe(200);
      const created = (await createdRes.json()) as any;
      expect(created.ok).toBe(true);
      expect(created.id).toMatch(/^pxv_[0-9a-f]{16}$/);
      expect(created.item.hasAuth).toBe(true);
      expect(created.item.hasRefreshUrl).toBe(true);
      expect(created.item.refreshUrlHost).toBe("rotate.example.com");
      expect(JSON.stringify(created)).not.toContain("super-secret-password");
      expect(JSON.stringify(created)).not.toContain("SECRET_KEY_123");

      // Edit view (decrypted single-item)
      const editRes = await callRoute(getReq(`/ui/api/proxy-vault/${created.id}/edit`), store);
      expect(editRes.status).toBe(200);
      const editJson = (await editRes.json()) as any;
      expect(editJson.item).toMatchObject({
        id: created.id,
        user: "alice",
        pass: "super-secret-password",
        refreshUrl: "https://rotate.example.com/ip?key=SECRET_KEY_123",
      });

      // Import preview & apply
      const csv = [
        "name,group,type,host,port,user,pass,refreshUrl,notes",
        "EU-1,EU,socks5,198.51.100.2,1080,bob,bob-secret,,eu proxy",
        "EU-2,EU,socks5,198.51.100.3,1080,,,,no auth",
      ].join("\n");
      const prevRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/import/preview", "POST", { input: csv }),
        store,
      );
      const prevJson = (await prevRes.json()) as any;
      expect(prevJson.ok).toBe(true);
      expect(prevJson.summary.wouldCreate).toBe(2);
      expect(JSON.stringify(prevJson)).not.toContain("bob-secret");

      const applyRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/import/apply", "POST", { input: csv }),
        store,
      );
      const applyJson = (await applyRes.json()) as any;
      expect(applyJson.ok).toBe(true);
      expect(applyJson.created).toBe(2);

      // List with ?group=&q=&risk=
      const listEuRes = await callRoute(getReq("/ui/api/proxy-vault?group=EU&q=198.51.100.2"), store);
      const listEu = (await listEuRes.json()) as any;
      expect(listEu.items).toHaveLength(1);
      expect(listEu.items[0].name).toBe("EU-1");
      expect(listEu.groups).toEqual(["EU", "US"]);

      // PATCH
      const patchRes = await callRoute(
        jsonReq(`/ui/api/proxy-vault/${created.id}`, "PATCH", { name: "NY-Res-Updated" }),
        store,
      );
      const patchJson = (await patchRes.json()) as any;
      expect(patchJson.ok).toBe(true);
      expect(patchJson.item.name).toBe("NY-Res-Updated");
      expect(patchJson.credentialsChanged).toBe(false);

      // Single DELETE + Batch DELETE
      const delSingleRes = await callRoute(jsonReq(`/ui/api/proxy-vault/${created.id}`, "DELETE"), store);
      expect(delSingleRes.status).toBe(200);
      expect(await delSingleRes.json()).toEqual({ ok: true, deleted: true, id: created.id });

      const delBatchRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/delete", "POST", { ids: applyJson.createdIds }),
        store,
      );
      expect(delBatchRes.status).toBe(200);
      expect((await delBatchRes.json()).deleted).toBe(2);
    } finally {
      store.close();
    }
  });

  test("bind, sync-bound, ingest-from-profiles, NDJSON check stream, and refresh-ip with 5s cooldown & recheck", async () => {
    const store = makeStore();
    try {
      const p1 = buildNewProfile({ name: "X-One", group: "Ops", platform: "x.com" }, () => false);
      p1.id = "route01";
      const p2 = buildNewProfile(
        {
          name: "X-Two",
          group: "Ops",
          platform: "x.com",
          proxy: { type: "http", host: "203.0.113.50", port: "8080", user: "iu", pass: "ip" },
        },
        () => false,
      );
      p2.id = "route02";
      store.upsertProfile(p1);
      store.upsertProfile(p2);

      // Ingest from profiles
      const ingestRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/ingest-from-profiles", "POST", {}),
        store,
      );
      const ingestJson = (await ingestRes.json()) as any;
      expect(ingestJson).toMatchObject({ ok: true, scanned: 2, created: 1, bound: 1, skippedWithoutProxy: 1 });
      const ingestedId = ingestJson.createdIds[0] as string;

      // Add refresh URL to ingested proxy
      await callRoute(
        jsonReq(`/ui/api/proxy-vault/${ingestedId}`, "PATCH", {
          refreshUrl: "https://rotate.example.com/change?api_key=NEVER_ECHO_THIS",
        }),
        store,
      );

      // Bind ingested proxy to p1 as well (same platform x.com -> high risk)
      const bindRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/bind", "POST", {
          proxyId: ingestedId,
          profileIds: ["route01"],
          mode: "single",
        }),
        store,
      );
      const bindJson = (await bindRes.json()) as any;
      expect(bindJson.ok).toBe(true);
      expect(bindJson.updated).toBe(1);
      expect(bindJson.riskSummary.highestRisk).toBe("high");
      expect(bindJson.riskSummary.byProxy[ingestedId].risks.some((r: any) => r.code === "same_platform_binding")).toBe(true);

      // List filtered by ?risk=high
      const highRiskRes = await callRoute(getReq("/ui/api/proxy-vault?risk=high"), store);
      const highRiskJson = (await highRiskRes.json()) as any;
      expect(highRiskJson.items).toHaveLength(1);
      expect(highRiskJson.items[0].id).toBe(ingestedId);

      // Edit vault credentials and sync-bound
      await callRoute(
        jsonReq(`/ui/api/proxy-vault/${ingestedId}`, "PATCH", { pass: "rotated-pass" }),
        store,
      );
      const syncRes = await callRoute(
        jsonReq(`/ui/api/proxy-vault/sync-bound/${ingestedId}`, "POST", {}),
        store,
      );
      const syncJson = (await syncRes.json()) as any;
      expect(syncJson).toMatchObject({ ok: true, updated: 2, skipped: 0 });
      expect(store.getProfile("route01")!.proxy?.pass).toBe("rotated-pass");
      expect(store.getProfile("route02")!.proxy?.pass).toBe("rotated-pass");

      // NDJSON concurrent check stream
      const mockCheckOpts: ProxyVaultRouteOptions["proxyVaultCheckOptions"] = {
        attempts: 2,
        endpoints: ["http://egress.test/json"],
        relayFactory: async () => ({ port: 44444, close: () => {} }),
        fetchDirect: async () => ({ ip: "198.51.100.1" }),
        fetchEgress: async (_endpoint, opts) => {
          expect(opts.relayPort).toBe(44444);
          return new Response(JSON.stringify({ ip: "203.0.113.99", country: "US" }), { status: 200 });
        },
      };

      const checkRes = await callRoute(
        jsonReq("/ui/api/proxy-vault/check", "POST", { ids: [ingestedId], concurrency: 4 }),
        store,
        { proxyVaultCheckOptions: mockCheckOpts },
      );
      expect(checkRes.headers.get("content-type")).toContain("application/x-ndjson");
      const lines = (await checkRes.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ type: "start", total: 1, concurrency: 4 });
      expect(lines[1]).toMatchObject({
        type: "result",
        proxyId: ingestedId,
        completed: 1,
        total: 1,
        result: { status: "working", ip: "203.0.113.99" },
      });
      expect(lines[2]).toMatchObject({ type: "done", total: 1, completed: 1, working: 1, cancelled: false });

      // Explicit refresh-ip with recheck=true + 5s cooldown enforcement
      const cooldown = new ProxyRefreshCooldown(5_000);
      let refreshCalls = 0;
      const routeOpts: ProxyVaultRouteOptions = {
        proxyVaultCheckOptions: {
          ...mockCheckOpts,
          fetchEgress: async () =>
            new Response(JSON.stringify({ ip: "203.0.113.120", country: "CA" }), { status: 200 }),
        },
        proxyVaultRefreshCooldown: cooldown,
        proxyVaultRefreshTrigger: async (rawUrl) => {
          refreshCalls++;
          expect(rawUrl).toContain("NEVER_ECHO_THIS");
          return { ok: true, httpStatus: 200, redirects: 0, refreshedAt: Date.now() };
        },
      };

      const refreshRes = await callRoute(
        jsonReq(`/ui/api/proxy-vault/${ingestedId}/refresh-ip`, "POST", { recheck: true }),
        store,
        routeOpts,
      );
      expect(refreshRes.status).toBe(200);
      const refreshJson = (await refreshRes.json()) as any;
      expect(refreshJson).toMatchObject({ ok: true, proxyId: ingestedId, httpStatus: 200, rechecked: true });
      expect(refreshJson.item.lastExitIp).toBe("203.0.113.120");
      expect(refreshJson.item.lastExitCountry).toBe("CA");
      expect(JSON.stringify(refreshJson)).not.toContain("NEVER_ECHO_THIS");

      // Second call within 5s -> HTTP 429 cooldown_active
      const throttledRes = await callRoute(
        jsonReq(`/ui/api/proxy-vault/${ingestedId}/refresh-ip`, "POST", {}),
        store,
        routeOpts,
      );
      expect(throttledRes.status).toBe(429);
      const throttledJson = (await throttledRes.json()) as any;
      expect(throttledJson.code).toBe("cooldown_active");
      expect(throttledJson.retryAfterMs).toBeGreaterThan(0);
      expect(refreshCalls).toBe(1);

      // SSRF failure from refresh trigger returns 400 and never echoes URL
      const freshCooldown = new ProxyRefreshCooldown(0);
      const ssrfRes = await callRoute(
        jsonReq(`/ui/api/proxy-vault/${ingestedId}/refresh-ip`, "POST", {}),
        store,
        {
          proxyVaultRefreshCooldown: freshCooldown,
          proxyVaultRefreshTrigger: async () => {
            throw new ProxyRefreshError("Refresh endpoint resolves to a restricted network address.", "ssrf_blocked", 400);
          },
        },
      );
      expect(ssrfRes.status).toBe(400);
      const ssrfBody = await ssrfRes.text();
      expect(ssrfBody).toContain("ssrf_blocked");
      expect(ssrfBody).not.toContain("NEVER_ECHO_THIS");
    } finally {
      store.close();
    }
  });
});
