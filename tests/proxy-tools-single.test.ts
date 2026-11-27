import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "../src/create.ts";
import type { Launcher } from "../src/launcher.ts";
import type { ProxyOperationBinding, ProxyOperationSnapshot } from "../src/proxy-operation-state.ts";
import type { ProxyPreview, ProxyProgressEvent, SingleProxyPreviewInput } from "../src/proxy-tools-types.ts";
import { ProfileStore } from "../src/store.ts";
import { handleUiRequest, type UiRuntimeOptions } from "../src/ui.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const oldProxy = { type: "http" as const, host: "old.invalid", port: "8800", user: "old-operator", pass: "old-private-password" };

function fixture(ids: string[]) {
  const store = new ProfileStore(":memory:");
  stores.push(store);
  for (const [index, id] of ids.entries()) {
    store.upsertProfile({ ...buildNewProfile({ name: id, group: `Group ${index}`, proxy: oldProxy }, () => false), id });
  }
  const cleaned: string[] = [], reads: string[] = [];
  const blocked = new Set<string>();
  let lookups = 0;
  store.listProfiles = () => { throw new Error("Single assignment must not enumerate the workspace"); };
  const read = store.getProfile.bind(store);
  store.getProfile = id => { reads.push(id); return read(id); };
  const launcher = {
    cacheCleanupSettled: async (id: string) => { cleaned.push(id); },
    profileDeletionBlocked: (id: string) => blocked.has(id),
  } as unknown as Launcher;
  const options: UiRuntimeOptions = {
    timezoneFetch: async () => {
      lookups++;
      return Response.json({ timezone: "Europe/Paris", country_code: "FR" });
    },
  };
  async function request(action: string, body?: unknown) {
    const init = body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    };
    return (await handleUiRequest(new Request(`http://127.0.0.1:55660/ui/api/proxies/${action}`, init), launcher, store, options))!;
  }
  async function preview(input: SingleProxyPreviewInput) {
    const response = await request("preview", input);
    expect(response.status).toBe(200);
    return await response.json() as ProxyPreview & { operationScope: string };
  }
  async function apply(binding: ProxyOperationBinding) {
    const response = await request("apply", binding);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    return (await response.text()).trim().split("\n").map(line => JSON.parse(line)) as ProxyProgressEvent[];
  }
  async function status({ attemptId, operationScope, previewId }: ProxyOperationBinding) {
    const query = new URLSearchParams({ operationScope, previewId });
    const response = await request(`operations/${attemptId}?${query}`);
    expect(response.status).toBe(200);
    return (await response.json() as { operation: ProxyOperationSnapshot }).operation;
  }
  return { store, cleaned, reads, blocked, request, preview, apply, status, read, lookups: () => lookups };
}

function binding(preview: ProxyPreview & { operationScope: string }): ProxyOperationBinding {
  return { attemptId: crypto.randomUUID(), previewId: preview.previewId, operationScope: preview.operationScope };
}

test("typed HTTP preview uses the same IPv6 port 80 on each exact selected environment", async () => {
  const f = fixture(["p1", "p2", "p3", "p4"]);
  f.blocked.add("p4");
  const writes: string[] = [];
  f.store.onProfileSaved = profile => { writes.push(profile.id); };
  const preview = await f.preview({ mode: "single", scope: { ids: ["p2", "missing_fixture", "p4", "p1"] }, proxy: { type: "http", host: "::1", port: 80 } });
  expect(preview.unusedProxies).toBe(0);
  expect(preview.rows.map(row => [row.index, row.profileId, row.status, row.proxy, row.code])).toEqual([
    [0, "p2", "ready", "http://[::1]:80", undefined],
    [1, "missing_fixture", "missing", "http://[::1]:80", "no_editable_match"],
    [2, "p4", "skipped", "http://[::1]:80", "profile_open"],
    [3, "p1", "ready", "http://[::1]:80", undefined],
  ]);
  expect(f.reads).toEqual(["p2", "missing_fixture", "p4", "p1"]);
  expect(f.cleaned).toEqual(["p2", "p4", "p1"]);
  expect(f.lookups()).toBe(0);
  expect(writes).toEqual([]);
  expect(JSON.stringify(preview)).not.toContain(oldProxy.pass);

  const attempt = binding(preview);
  expect((await f.apply(attempt)).at(-1)).toEqual({ type: "done" });
  expect(writes).toEqual(["p2", "p1"]);
  expect(f.lookups()).toBeGreaterThan(0);
  expect(f.reads).not.toContain("p3");
  expect(f.cleaned).not.toContain("p3");
  for (const id of ["p1", "p2"]) expect(f.read(id)?.proxy).toMatchObject({ type: "http", host: "::1", port: "80" });
  for (const id of ["p3", "p4"]) expect(f.read(id)?.proxy).toEqual(oldProxy);
  expect((await f.status(attempt)).rows.map(row => row.status)).toEqual(["updated", "missing", "skipped", "updated"]);

  // Retrying a skipped environment uses the same connection and cannot pull
  // another ID into the batch, including one that never had a reviewed row.
  f.blocked.clear();
  f.reads.length = 0;
  const retryResponse = await f.request("retry-preview", { previewId: preview.previewId, ids: ["p1", "p3", "p4"] });
  const retry = await retryResponse.json() as ProxyPreview & { operationScope: string };
  expect(retry.rows.map(row => [row.index, row.profileId, row.status])).toEqual([[2, "p4", "ready"]]);
  expect(f.reads).toEqual(["p4"]);
  await f.apply(binding(retry));
  expect(writes).toEqual(["p2", "p1", "p4"]);
  expect(f.read("p3")?.proxy).toEqual(oldProxy);
});

test("authenticated SOCKS5 keeps credentials only in the private plan and saved settings", async () => {
  const f = fixture(["p1"]);
  const user = "operator_credential", pass = " private_pass:@/% ";
  const input = { mode: "single", scope: { ids: ["p1"] }, proxy: { type: "socks5", host: "127.0.0.1", port: 1080, user, pass }, requiresAuthentication: true } satisfies SingleProxyPreviewInput;
  const preview = await f.preview(input);
  const attempt = binding(preview);
  const progress = await f.apply(attempt);
  const receipt = await f.status(attempt);
  const publicPayloads = JSON.stringify([preview, progress, receipt]);
  expect(publicPayloads).not.toContain(user);
  expect(publicPayloads).not.toContain(pass.trim());
  expect(publicPayloads).not.toContain(oldProxy.pass);
  expect(receipt.rows).toEqual([{ index: 0, profileId: "p1", status: "updated" }]);
  expect(f.read("p1")?.proxy).toEqual({ type: "socks5", host: "127.0.0.1", port: "1080", user, pass });
});

test("all-missing IDs produce ordered missing rows; an invalid scope never reads inventory", async () => {
  const f = fixture(["excluded_fixture"]);
  const proxy = { type: "http", host: "127.0.0.1", port: 7890 } as const;
  const preview = await f.preview({ mode: "single", scope: { ids: ["gone_2", "gone_1"] }, proxy });
  expect(preview.rows.map(row => [row.profileId, row.status])).toEqual([["gone_2", "missing"], ["gone_1", "missing"]]);
  expect(f.reads).toEqual(["gone_2", "gone_1"]);
  expect(f.cleaned).toEqual([]);
  f.reads.length = 0;
  for (const scope of [{ ids: [] }, { ids: ["excluded_fixture", "excluded_fixture"] }, { all: true }, { all: true, ids: ["excluded_fixture"] }]) {
    expect((await f.request("preview", { mode: "single", scope, proxy })).status).toBe(400);
  }
  expect(f.reads).toEqual([]);
  expect(f.lookups()).toBe(0);
  const attempt = binding(preview);
  await f.apply(attempt);
  expect(f.reads).not.toContain("excluded_fixture");
  expect(f.read("excluded_fixture")?.proxy).toEqual(oldProxy);
  expect((await f.status(attempt)).rows.every(row => row.status === "missing")).toBe(true);
});
