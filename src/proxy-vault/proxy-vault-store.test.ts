import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildNewProfile } from "../../create.ts";
import { ENCRYPTED_VALUE_PREFIX } from "../../dpapi.ts";
import { ProfileStore } from "../../store.ts";
import {
  computeProxyEndpointHash,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  ProxyVaultError,
  ProxyVaultStore,
} from "./proxy-vault-store.ts";

function createTestStore(): ProfileStore {
  return new ProfileStore(":memory:", { protection: { key: randomBytes(32) } });
}

function addProfile(
  store: ProfileStore,
  id: string,
  overrides: {
    name?: string;
    group?: string;
    platform?: string;
    proxy?: { type?: "http" | "https" | "socks5"; host?: string; port?: string; user?: string; pass?: string };
  } = {},
) {
  const p = buildNewProfile(
    {
      name: overrides.name ?? id,
      group: overrides.group ?? "g1",
      platform: overrides.platform ?? "",
      ...(overrides.proxy ? { proxy: overrides.proxy } : {}),
    },
    () => false,
  );
  p.id = id;
  store.upsertProfile(p);
  return p;
}

describe("ProxyVaultStore", () => {
  test("CRUD encrypts credentials & refreshUrl at rest, canonicalizes host, and never exposes secrets or endpoint_hash in list views", () => {
    const store = createTestStore();
    try {
      const vault = new ProxyVaultStore(store);
      const created = vault.create({
        name: "US Residential #1",
        group: "US",
        type: "socks5",
        host: "[2001:0DB8::0001]",
        port: 1080,
        user: "vault-user",
        pass: "vault-secret-pass",
        refreshUrl: "https://rotate.provider.example/v1/ip?token=TOP_SECRET_REFRESH",
        notes: "Primary account proxy",
      });

      expect(created.id).toMatch(/^pxv_[0-9a-f]{16}$/);
      expect(created.host).toBe("2001:db8::1");
      expect(created.endpoint).toBe("socks5://[2001:db8::1]:1080");
      expect(created.hasAuth).toBe(true);
      expect(created.hasRefreshUrl).toBe(true);
      expect(created.refreshUrlHost).toBe("rotate.provider.example");

      // Raw SQLite row stores encrypted auth & refresh URL
      const raw = store
        .rawDatabase()
        .query<{ auth_encrypted: string; refresh_url_encrypted: string; endpoint_hash: string }, [string]>(
          "SELECT auth_encrypted, refresh_url_encrypted, endpoint_hash FROM proxy_vault WHERE id = ?",
        )
        .get(created.id)!;
      expect(raw.auth_encrypted.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true);
      expect(raw.refresh_url_encrypted.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true);
      expect(raw.auth_encrypted).not.toContain("vault-secret-pass");
      expect(raw.refresh_url_encrypted).not.toContain("TOP_SECRET_REFRESH");

      // List view is strictly redacted
      const listJson = JSON.stringify(vault.list());
      expect(listJson).not.toContain("vault-secret-pass");
      expect(listJson).not.toContain("TOP_SECRET_REFRESH");
      expect(listJson).not.toContain(raw.endpoint_hash);
      expect(listJson).not.toContain("endpoint_hash");
      expect(listJson).not.toContain("endpointHash");

      // Edit view decrypts fields for explicit single-item edit
      const edit = vault.getEditView(created.id)!;
      expect(edit.user).toBe("vault-user");
      expect(edit.pass).toBe("vault-secret-pass");
      expect(edit.refreshUrl).toBe("https://rotate.provider.example/v1/ip?token=TOP_SECRET_REFRESH");

      // Metadata-only update preserves encrypted auth & refreshUrl
      const renamed = vault.update(created.id, { name: "Renamed Residential" });
      expect(renamed.credentialsChanged).toBe(false);
      expect(vault.getEditView(created.id)!.pass).toBe("vault-secret-pass");
      expect(vault.getEditView(created.id)!.refreshUrl).toBe(
        "https://rotate.provider.example/v1/ip?token=TOP_SECRET_REFRESH",
      );

      // Clear auth & refreshUrl explicitly
      const cleared = vault.update(created.id, { clearAuth: true, refreshUrl: "" });
      expect(cleared.credentialsChanged).toBe(true);
      expect(cleared.item.hasAuth).toBe(false);
      expect(cleared.item.hasRefreshUrl).toBe(false);
      expect(cleared.item.refreshUrlHost).toBe("");
      expect(vault.getEditView(created.id)!.user).toBe("");
      expect(vault.getEditView(created.id)!.refreshUrl).toBe("");

      expect(vault.delete(created.id)).toBe(true);
      expect(vault.getView(created.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("batch import preview/apply supports text & both CSV schemas, strategies, and hard 2000-row / 2 MiB limits", () => {
    const store = createTestStore();
    try {
      const vault = new ProxyVaultStore(store);
      const existing = vault.create({
        name: "OldName",
        group: "US",
        type: "http",
        host: "198.51.100.10",
        port: 8080,
        user: "u1",
        pass: "p1",
      });

      // Text import with duplicate existing + duplicate in batch + invalid row
      const textInput = [
        "# comment line",
        "198.51.100.10:8080:u1:p1",
        "socks5://u2:secret-p2@198.51.100.11:1080",
        "socks5://u2:secret-p2@198.51.100.11:1080",
        "not-a-valid-proxy-line",
      ].join("\n");

      const preview = vault.previewImport({ input: textInput, defaultGroup: "Batch1" });
      expect(preview.detectedFormat).toBe("text");
      expect(preview.summary).toEqual({
        totalRows: 4,
        validRows: 3,
        newCount: 1,
        duplicateExistingCount: 1,
        duplicateInBatchCount: 1,
        invalidCount: 1,
        wouldCreate: 1,
        wouldUpdate: 0,
        wouldSkip: 2,
      });
      // Preview never echoes credentials
      expect(JSON.stringify(preview)).not.toContain("secret-p2");

      const applied = vault.applyImport({ input: textInput, defaultGroup: "Batch1" });
      expect(applied).toMatchObject({ created: 1, updated: 0, skipped: 2, invalid: 1 });

      // CSV structured schema with update_existing + SSRF-blocked refresh URL row
      const csvStructured = [
        "name,group,type,host,port,user,pass,refreshUrl,notes",
        "UpdatedName,EU,http,198.51.100.10,8080,u1,p1,https://rotate.example.com/ok?k=SECRET1,updated note",
        "NewCsv,JP,https,198.51.100.12,8443,u3,p3,https://rotate.example.com/jp?k=SECRET2,jp note",
        "BadSsrf,JP,http,198.51.100.13,8080,,,http://169.254.169.254/latest/meta-data,ssrf",
      ].join("\n");

      const csvPreview = vault.previewImport({ input: csvStructured, duplicateStrategy: "update_existing" });
      expect(csvPreview.detectedFormat).toBe("csv");
      expect(csvPreview.summary).toMatchObject({
        totalRows: 3,
        newCount: 1,
        duplicateExistingCount: 1,
        invalidCount: 1,
        wouldCreate: 1,
        wouldUpdate: 1,
      });
      expect(JSON.stringify(csvPreview)).not.toContain("SECRET1");
      expect(JSON.stringify(csvPreview)).not.toContain("SECRET2");

      const csvApplied = vault.applyImport({ input: csvStructured, duplicateStrategy: "update_existing" });
      expect(csvApplied).toMatchObject({ created: 1, updated: 1, skipped: 0, invalid: 1 });
      const refreshedExisting = vault.getView(existing.id)!;
      expect(refreshedExisting.name).toBe("UpdatedName");
      expect(refreshedExisting.group).toBe("EU");
      expect(refreshedExisting.refreshUrlHost).toBe("rotate.example.com");

      // CSV compact schema (`proxy,name,group,refreshUrl,notes`)
      const csvCompact = [
        "proxy,name,group,refreshUrl,notes",
        "socks5://198.51.100.14:1080,CompactOne,SG,,compact note",
      ].join("\n");
      const compactRes = vault.applyImport({ input: csvCompact });
      expect(compactRes.detectedFormat).toBe("csv");
      expect(compactRes.created).toBe(1);

      // Hard limits: > 2000 rows & > 2 MiB rejected
      const tooManyRows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `198.51.100.1:${1000 + (i % 50000)}`).join("\n");
      expect(() => vault.previewImport({ input: tooManyRows })).toThrow(ProxyVaultError);

      const oversized = "198.51.100.1:8080\n".repeat(Math.ceil(MAX_IMPORT_BYTES / 18) + 10);
      let sizeErr: unknown;
      try {
        vault.previewImport({ input: oversized });
      } catch (e) {
        sizeErr = e;
      }
      expect(sizeErr).toBeInstanceOf(ProxyVaultError);
      expect((sizeErr as ProxyVaultError).status).toBe(413);
    } finally {
      store.close();
    }
  });

  test("bind (single & round_robin + dryRun), syncBoundProfiles, and ingestFromProfiles maintain consistency", () => {
    const store = createTestStore();
    try {
      const vault = new ProxyVaultStore(store);
      addProfile(store, "prof01", { name: "Alpha", group: "Ops", platform: "x.com" });
      addProfile(store, "prof02", { name: "Beta", group: "Ops", platform: "x.com" });
      addProfile(store, "prof03", { name: "Gamma", group: "Ops", platform: "telegram.org" });
      addProfile(store, "prof04", { name: "DeltaRunning", group: "Ops", platform: "x.com" });
      store.recordLaunch({
        profileId: "prof04",
        pid: 9999,
        debugPort: 9222,
        ws: "ws://127.0.0.1:9222",
        startedAt: Date.now(),
      });

      const v1 = vault.create({ name: "P1", group: "US", type: "http", host: "198.51.100.21", port: 8080, user: "u1", pass: "p1" });
      const v2 = vault.create({ name: "P2", group: "US", type: "socks5", host: "198.51.100.22", port: 1080, user: "u2", pass: "p2" });

      // Dry-run bind of single proxy to two same-platform profiles previews high risk without mutating DB
      const previewBind = vault.bindProfiles({
        proxyIds: [v1.id],
        profileIds: ["prof01", "prof02", "prof04"],
        mode: "single",
        dryRun: true,
      });
      expect(previewBind.dryRun).toBe(true);
      expect(previewBind.updated).toBe(2);
      expect(previewBind.skipped).toBe(1);
      expect(previewBind.riskSummary.highestRisk).toBe("high");
      expect(previewBind.riskSummary.byProxy[v1.id]!.risks.some((r) => r.code === "same_platform_binding")).toBe(true);
      expect(store.getProfile("prof01")!.proxy).toBeNull();

      // Round-robin bind across v1 & v2 (prof01 -> v1, prof02 -> v2, prof03 -> v1, prof04 skipped open)
      const appliedBind = vault.bindProfiles({
        proxyIds: [v1.id, v2.id],
        profileIds: ["prof01", "prof02", "prof03", "prof04"],
        mode: "round_robin",
        profilesPerProxy: 1,
      });
      expect(appliedBind.updated).toBe(3);
      expect(appliedBind.skipped).toBe(1);
      expect(appliedBind.results.find((r) => r.profileId === "prof04")).toMatchObject({
        status: "skipped",
        reason: "profile_open",
      });
      expect(store.getProfile("prof01")!.proxy?.host).toBe("198.51.100.21");
      expect(store.getProfile("prof02")!.proxy?.host).toBe("198.51.100.22");
      expect(store.getProfile("prof03")!.proxy?.host).toBe("198.51.100.21");
      expect(store.getProfile("prof04")!.proxy).toBeNull();

      // v1 is bound to prof01 (x.com) + prof03 (telegram.org) -> medium shared_binding
      expect(appliedBind.riskSummary.byProxy[v1.id]!.riskLevel).toBe("medium");

      // Edit v1 credentials -> bound profiles become out-of-sync
      const edited = vault.update(v1.id, { pass: "p1-rotated" });
      expect(edited.credentialsChanged).toBe(true);
      expect(edited.outOfSyncCount).toBe(2);

      // Mark prof03 running -> syncBoundProfiles updates prof01 and skips prof03
      store.recordLaunch({
        profileId: "prof03",
        pid: 8888,
        debugPort: 9223,
        ws: "ws://127.0.0.1:9223",
        startedAt: Date.now(),
      });
      const syncRes = vault.syncBoundProfiles(v1.id);
      expect(syncRes.updated).toBe(1);
      expect(syncRes.skipped).toBe(1);
      expect(store.getProfile("prof01")!.proxy?.pass).toBe("p1-rotated");
      expect(store.getProfile("prof03")!.proxy?.pass).toBe("p1");
      expect(vault.getView(v1.id)!.outOfSyncCount).toBe(1);

      // Ingest proxies already stored directly on profiles (deduplicating duplicates)
      addProfile(store, "prof05", {
        name: "DirectA",
        group: "Direct",
        proxy: { type: "http", host: "203.0.113.88", port: "3128", user: "du", pass: "dp" },
      });
      addProfile(store, "prof06", {
        name: "DirectB",
        group: "Direct",
        proxy: { type: "http", host: "203.0.113.88", port: "3128", user: "du", pass: "dp" },
      });
      const ingest = vault.ingestFromProfiles({ profileIds: ["prof05", "prof06"], bind: true });
      expect(ingest).toMatchObject({ scanned: 2, created: 1, reused: 1, bound: 2, skippedWithoutProxy: 0 });

      const ingestedView = vault.getView(ingest.createdIds[0]!)!;
      expect(ingestedView.boundCount).toBe(2);
      expect(computeProxyEndpointHash(store.getProfile("prof05")!.proxy!)).toBe(
        vault.getInternalRecord(ingestedView.id)!.endpointHash,
      );
    } finally {
      store.close();
    }
  });
});
