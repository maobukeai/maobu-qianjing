import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import { ProxiesPage } from "./proxies.tsx";
import { assessBindRisk, ProxyVaultPanel } from "./proxy-vault-panel.tsx";
import {
  applyProxyVaultImport,
  bindProxyVaultEntries,
  checkProxyVaultStream,
  fetchProxyVault,
  fetchProxyVaultEdit,
  formatVaultEndpoint,
  ingestProxyVaultFromProfiles,
  previewProxyVaultImport,
  ProxyVaultError,
  refreshProxyVaultIp,
  sanitizeVaultMessage,
  syncProxyVaultBoundProfiles,
  updateProxyVaultEntry,
  type ProxyVaultCheckEvent,
  type ProxyVaultEntry,
} from "./proxy-vault-api.ts";

function makeEntry(overrides: Partial<ProxyVaultEntry> = {}): ProxyVaultEntry {
  return {
    id: "pxv_001",
    name: "US Residential #1",
    group: "US-East",
    type: "socks5",
    host: "us1.proxy.example",
    port: 1080,
    hasAuth: true,
    hasRefreshUrl: true,
    refreshUrlHost: "rotate.proxy.example",
    notes: "Primary pool",
    lastStatus: "working",
    lastReason: "",
    lastLatencyMs: 88,
    lastExitIp: "198.51.100.11",
    lastExitCountry: "US",
    lastExitRegion: "NY",
    lastExitCity: "New York",
    lastExitRotating: true,
    lastExitComparison: "different",
    lastCheckedAt: 1_700_000_000_000,
    lastRefreshedAt: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    boundProfiles: [
      {
        profileId: "p1",
        name: "Store Alpha",
        group: "Sales",
        platform: "amazon.com",
        running: false,
        drifted: false,
        boundAt: 1_700_000_000_000,
      },
    ],
    riskLevel: "none",
    risks: [],
    ...overrides,
  };
}

async function createHarness(fetchImpl: typeof fetch) {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  setGlobal("window", dom);
  setGlobal("document", dom.document);
  setGlobal("navigator", dom.navigator);
  setGlobal("localStorage", dom.localStorage);
  setGlobal("HTMLElement", dom.HTMLElement);
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("HTMLTextAreaElement", dom.HTMLTextAreaElement);
  setGlobal("HTMLSelectElement", dom.HTMLSelectElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("KeyboardEvent", dom.KeyboardEvent);
  setGlobal("fetch", fetchImpl);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { createRoot } = await import("react-dom/client");
  const rawContainer = dom.document.createElement("div");
  dom.document.body.appendChild(rawContainer);
  const container = rawContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  };
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 15));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else Reflect.deleteProperty(globalThis, k);
    }
  };
  return { dom, container, root, flush, cleanup };
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("ProxyVaultPanel & API", () => {
  test("sanitizes proxy credentials and refresh tokens from errors and formats IPv6 endpoints", () => {
    expect(
      sanitizeVaultMessage("Failed socks5://alice:TOP_SECRET@proxy.example:1080 via https://api.example/rotate?token=XYZ"),
    ).not.toContain("TOP_SECRET");
    expect(
      sanitizeVaultMessage("Error https://api.example/rotate?token=SECRET_TOKEN"),
    ).not.toContain("SECRET_TOKEN");
    expect(formatVaultEndpoint({ type: "http", host: "2001:db8::1", port: 8080 })).toBe("http://[2001:db8::1]:8080");
  });

  test("assessBindRisk flags high risk on same-platform collision and medium risk on cross-platform sharing", () => {
    const proxy = makeEntry({
      boundProfiles: [
        { profileId: "p1", name: "Shop 1", group: "Ops", platform: "tiktok.com", running: false, drifted: false, boundAt: 1 },
      ],
    });
    const high = assessBindRisk(
      [proxy],
      [{ id: "p2", name: "Shop 2", group: "Ops", platform: "tiktok.com", running: false }],
      "single",
      1,
    );
    expect(high.level).toBe("high");
    expect(high.reasons.some((r) => r.includes("same platform"))).toBe(true);

    const med = assessBindRisk(
      [proxy],
      [{ id: "p3", name: "Shop 3", group: "Ops", platform: "reddit.com", running: false }],
      "single",
      1,
    );
    expect(med.level).toBe("medium");
  });

  test("renders desensitized vault entries, filters by risk/group, streams NDJSON check, refreshes IP, and ingests", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const entries: ProxyVaultEntry[] = [
      makeEntry({ id: "pxv_1", name: "US Fast", group: "US", lastLatencyMs: 72, riskLevel: "none", hasRefreshUrl: true }),
      makeEntry({
        id: "pxv_2",
        name: "DE Shared",
        group: "EU",
        host: "de.proxy.example",
        port: 8080,
        type: "http",
        hasRefreshUrl: false,
        lastStatus: "unstable",
        lastLatencyMs: 320,
        riskLevel: "high",
        risks: [{ code: "same_platform_binding", level: "high", platform: "x.com", profileIds: ["p1", "p2"] }],
        boundProfiles: [
          { profileId: "p1", name: "X One", group: "Social", platform: "x.com", running: false, drifted: true, boundAt: 1 },
          { profileId: "p2", name: "X Two", group: "Social", platform: "x.com", running: true, drifted: false, boundAt: 2 },
        ],
      }),
    ];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, method, body });

      if (url.pathname === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      if (url.pathname === "/ui/api/proxy-vault" && method === "GET") {
        return Response.json({ ok: true, entries, groups: ["US", "EU"] });
      }
      if (url.pathname === "/ui/api/proxy-vault/check" && method === "POST") {
        const updated = makeEntry({ id: "pxv_1", name: "US Fast", group: "US", lastLatencyMs: 64, lastExitIp: "198.51.100.99" });
        const ndjson = [
          JSON.stringify({ type: "progress", completed: 1, total: 1 }),
          JSON.stringify({ type: "result", entry: updated }),
          JSON.stringify({ type: "done", checked: 1 }),
        ].join("\n") + "\n";
        return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (url.pathname === "/ui/api/proxy-vault/pxv_1/refresh-ip" && method === "POST") {
        const updated = makeEntry({ id: "pxv_1", name: "US Fast", group: "US", lastExitIp: "203.0.113.55", lastLatencyMs: 91 });
        return Response.json({ ok: true, entry: updated, exitIp: "203.0.113.55", refreshedAt: Date.now() });
      }
      if (url.pathname === "/ui/api/proxy-vault/ingest-from-profiles" && method === "POST") {
        return Response.json({ ok: true, ingested: 3, skippedDuplicates: 1, bound: 2 });
      }
      return Response.json({ ok: false, error: "Unexpected" }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <ProxyVaultPanel
            active
            profiles={[
              { id: "p1", name: "X One", group: "Social", platform: "x.com", running: false },
              { id: "p2", name: "X Two", group: "Social", platform: "x.com", running: true },
            ]}
            onChanged={async () => {}}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(h.container.textContent).toContain("US Fast");
    expect(h.container.textContent).toContain("72 ms");
    expect(h.container.textContent).toContain("High risk");
    expect(h.container.textContent).toContain("Refresh · rotate.proxy.example");

    // Filter to High risk only
    const highBtn = [...h.container.querySelectorAll<HTMLButtonElement>(".vault-risk-pills button")].find(
      (b) => b.textContent?.trim() === "High risk",
    )!;
    await act(async () => { highBtn.click(); });
    expect(h.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(h.container.textContent).toContain("DE Shared");

    // Reset filter to All
    const allBtn = [...h.container.querySelectorAll<HTMLButtonElement>(".vault-risk-pills button")].find(
      (b) => b.textContent?.trim() === "All",
    )!;
    await act(async () => { allBtn.click(); });
    expect(h.container.querySelectorAll("tbody tr")).toHaveLength(2);

    // Explicit Refresh IP on dynamic proxy
    const refreshBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Refresh IP",
    )!;
    await act(async () => { refreshBtn.click(); });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/proxy-vault/pxv_1/refresh-ip")).toBe(true);
    expect(h.container.textContent).toContain("203.0.113.55");

    // NDJSON Check all
    const checkAllBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Check all",
    )!;
    await act(async () => { checkAllBtn.click(); });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/proxy-vault/check")).toBe(true);

    // Ingest from environments
    const ingestBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Ingest from environments"),
    )!;
    await act(async () => { ingestBtn.click(); });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/proxy-vault/ingest-from-profiles")).toBe(true);
    expect(h.container.textContent).toContain("Ingested 3 proxies");
  });

  test("two-stage batch import and risk-confirmed environment binding work end-to-end", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const entries = [
      makeEntry({
        id: "pxv_bind",
        name: "Shared Pool",
        boundProfiles: [
          { profileId: "p1", name: "TikTok A", group: "Ops", platform: "tiktok.com", running: false, drifted: false, boundAt: 1 },
        ],
      }),
    ];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, method, body });

      if (url.pathname === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      if (url.pathname === "/ui/api/proxy-vault" && method === "GET") {
        return Response.json({ ok: true, entries, groups: ["US-East"] });
      }
      if (url.pathname === "/ui/api/proxy-vault/import/preview" && method === "POST") {
        return Response.json({
          ok: true,
          preview: {
            total: 2,
            valid: 1,
            newCount: 1,
            duplicateCount: 0,
            invalidCount: 1,
            rows: [
              { line: 1, status: "new", type: "http", host: "new.example", port: 8080, hasAuth: true },
              { line: 2, status: "invalid", reason: "Invalid port" },
            ],
          },
        });
      }
      if (url.pathname === "/ui/api/proxy-vault/import/apply" && method === "POST") {
        return Response.json({ ok: true, inserted: 1, updated: 0, skipped: 0, invalid: 1 });
      }
      if (url.pathname === "/ui/api/proxy-vault/bind" && method === "POST") {
        return Response.json({ ok: true, updated: 1, skippedRunning: 0, updatedIds: ["p2"], skippedIds: [], riskSummary: { high: 1, medium: 0, warnings: [] } });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;
    let changedCount = 0;

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <ProxyVaultPanel
            active
            profiles={[
              { id: "p1", name: "TikTok A", group: "Ops", platform: "tiktok.com", running: false },
              { id: "p2", name: "TikTok B", group: "Ops", platform: "tiktok.com", running: false },
            ]}
            onChanged={async () => { changedCount++; }}
          />
        </I18nProvider>,
      );
    });
    await h.flush();

    // Open Batch Import modal
    const importBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Batch import"),
    )!;
    await act(async () => { importBtn.click(); });
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(h.dom.HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "http://u:p@new.example:8080\nbad-line",
      );
      textarea.dispatchEvent(new h.dom.Event("input", { bubbles: true }) as unknown as Event);
      textarea.dispatchEvent(new h.dom.Event("change", { bubbles: true }) as unknown as Event);
      textarea.dispatchEvent(new h.dom.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });

    const previewBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Preview import",
    )!;
    await act(async () => { previewBtn.click(); });
    await h.flush();
    expect(h.container.textContent).toContain("new.example:8080");

    const applyBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Import 1 valid proxies"),
    )!;
    await act(async () => { applyBtn.click(); });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/proxy-vault/import/apply")).toBe(true);

    // Open Bind modal on pxv_bind -> select TikTok B -> same-platform high risk requires confirmation
    const bindBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Bind",
    )!;
    await act(async () => { bindBtn.click(); });
    const targetCheckbox = [...h.container.querySelectorAll<HTMLLabelElement>(".vault-bind-profile-row")]
      .find((row) => row.textContent?.includes("TikTok B"))!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => { targetCheckbox.click(); });

    const submitBindBtn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Bind to 1 environments"),
    )!;
    expect(submitBindBtn.disabled).toBe(true);
    expect(h.container.textContent).toContain("High anti-association risk detected");

    const riskCheckbox = h.container.querySelector<HTMLInputElement>(".vault-risk-confirm-box input[type='checkbox']")!;
    await act(async () => { riskCheckbox.click(); });
    expect(submitBindBtn.disabled).toBe(false);

    await act(async () => { submitBindBtn.click(); });
    await h.flush();
    expect(requests.some((r) => r.path === "/ui/api/proxy-vault/bind")).toBe(true);
    expect(changedCount).toBe(1);
  });

  test("ProxiesPage exposes 3 tabs with Check default and lazy-loads Vault only when selected", async () => {
    const paths: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      paths.push(path);
      if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
      if (path === "/ui/api/proxy-vault") return Response.json({ ok: true, entries: [makeEntry()], groups: ["US-East"] });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    await act(async () => {
      h.root.render(
        <I18nProvider>
          <ProxiesPage active groups={["Sales"]} profiles={[]} onChanged={async () => {}} />
        </I18nProvider>,
      );
    });
    await h.flush();

    const tabs = [...h.container.querySelectorAll<HTMLButtonElement>(".tools-tabs button")];
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.textContent).toContain("Check proxies");
    expect(tabs[1]?.textContent).toContain("Replace proxies");
    expect(tabs[2]?.textContent).toContain("Proxy vault");
    expect(paths.filter((p) => p === "/ui/api/proxy-vault")).toHaveLength(0);

    await act(async () => { tabs[2]!.click(); });
    await h.flush();
    expect(paths.filter((p) => p === "/ui/api/proxy-vault")).toHaveLength(1);
    expect(h.container.querySelector("[data-proxy-vault-panel]")).toBeTruthy();
  });

  test("client parses w3-backend-vault canonical response envelopes, NDJSON start/result events, and retryAfterMs", async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    const canonicalItem = {
      id: "pxv_0123456789abcdef",
      name: "Canon #1",
      group: "EU",
      type: "socks5",
      host: "eu1.proxy.example",
      port: 1080,
      endpoint: "socks5://eu1.proxy.example:1080",
      hasAuth: true,
      hasRefreshUrl: true,
      refreshUrlHost: "rotate.proxy.example",
      notes: "",
      lastStatus: "working",
      lastReason: "",
      lastLatencyMs: 64,
      lastExitIp: "203.0.113.7",
      lastExitCountry: "DE",
      lastExitRegion: "HE",
      lastExitCity: "Frankfurt",
      lastExitRotating: false,
      lastExitComparison: "different",
      lastCheckedAt: 1700000100000,
      lastRefreshedAt: 1700000200000,
      createdAt: 1700000000000,
      updatedAt: 1700000200000,
      boundProfiles: [
        { id: "p-1", name: "Shop A", group: "EU", platform: "tiktok", running: false, inSync: false, boundAt: 1700000050000 },
      ],
      boundCount: 1,
      outOfSyncCount: 1,
      riskLevel: "high",
      risks: [
        {
          code: "same_platform_binding",
          severity: "high",
          platform: "tiktok",
          relatedProxyIds: ["pxv_fedcba9876543210"],
          profiles: [{ id: "p-1", name: "Shop A", group: "EU", platform: "tiktok" }],
        },
      ],
    };

    let refreshCall = 0;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/ui/api/proxy-vault" && method === "GET") {
        return Response.json({ ok: true, items: [canonicalItem], groups: ["EU"], summary: { total: 1 } });
      }
      if (path === "/ui/api/proxy-vault/pxv_0123456789abcdef/edit") {
        return Response.json({
          ok: true,
          item: {
            id: canonicalItem.id,
            name: canonicalItem.name,
            group: canonicalItem.group,
            type: canonicalItem.type,
            host: canonicalItem.host,
            port: canonicalItem.port,
            user: "alice",
            pass: "secret",
            refreshUrl: "https://rotate.proxy.example/next",
            notes: "",
            hasAuth: true,
            hasRefreshUrl: true,
            refreshUrlHost: "rotate.proxy.example",
            boundCount: 1,
            outOfSyncCount: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        });
      }
      if (path === "/ui/api/proxy-vault/pxv_0123456789abcdef" && method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, item: canonicalItem, credentialsChanged: false, outOfSyncCount: 0 });
      }
      if (path === "/ui/api/proxy-vault/import/preview") {
        return Response.json({
          ok: true,
          detectedFormat: "text",
          duplicateStrategy: "skip_duplicates",
          summary: {
            totalRows: 3,
            validRows: 2,
            newCount: 1,
            duplicateExistingCount: 1,
            duplicateInBatchCount: 0,
            invalidCount: 1,
            wouldCreate: 1,
            wouldUpdate: 0,
            wouldSkip: 1,
          },
          rows: [
            { index: 0, line: 1, status: "new", type: "http", host: "1.1.1.1", port: 8080, hasAuth: false, hasRefreshUrl: false },
            { index: 1, line: 2, status: "duplicate_existing", type: "socks5", host: "eu1.proxy.example", port: 1080 },
            { index: 2, line: 3, status: "invalid", error: "Bad port" },
          ],
        });
      }
      if (path === "/ui/api/proxy-vault/import/apply") {
        return Response.json({ ok: true, created: 1, updated: 0, skipped: 1, invalid: 1 });
      }
      if (path === "/ui/api/proxy-vault/check") {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(`${JSON.stringify({ type: "start", total: 1, concurrency: 4 })}\n`));
            controller.enqueue(
              enc.encode(
                `${JSON.stringify({ type: "result", proxyId: canonicalItem.id, item: canonicalItem, completed: 1, total: 1 })}\n`,
              ),
            );
            controller.enqueue(enc.encode(`${JSON.stringify({ type: "done", total: 1, completed: 1 })}\n`));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
        });
      }
      if (path === "/ui/api/proxy-vault/pxv_0123456789abcdef/refresh-ip") {
        refreshCall += 1;
        if (refreshCall === 1) {
          return Response.json({
            ok: true,
            proxyId: canonicalItem.id,
            refreshedAt: 1700000999000,
            rechecked: true,
            checkResult: { ip: "198.51.100.77", latencyMs: 52 },
            item: { ...canonicalItem, lastExitIp: "198.51.100.77", lastLatencyMs: 52 },
          });
        }
        return Response.json(
          { ok: false, code: "cooldown_active", retryAfterMs: 4200, error: "Please wait." },
          { status: 429 },
        );
      }
      if (path === "/ui/api/proxy-vault/bind") {
        return Response.json({
          ok: true,
          dryRun: false,
          mode: "single",
          profilesPerProxy: 1,
          updated: 1,
          unchanged: 0,
          skipped: 1,
          results: [
            { profileId: "p-1", proxyId: canonicalItem.id, status: "bound" },
            { profileId: "p-2", proxyId: canonicalItem.id, status: "skipped", reason: "profile_open" },
          ],
          riskSummary: {
            highestRisk: "high",
            highCount: 1,
            mediumCount: 0,
            byProxy: {
              [canonicalItem.id]: {
                riskLevel: "high",
                risks: canonicalItem.risks,
                boundProfiles: canonicalItem.boundProfiles,
              },
            },
          },
        });
      }
      if (path === "/ui/api/proxy-vault/sync-bound/pxv_0123456789abcdef") {
        return Response.json({ ok: true, updated: 2, unchanged: 0, skipped: 1, results: [] });
      }
      if (path === "/ui/api/proxy-vault/ingest-from-profiles") {
        return Response.json({ ok: true, scanned: 4, created: 2, reused: 1, bound: 3 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    const list = await fetchProxyVault();
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.boundProfiles[0]?.drifted).toBe(true);
    expect(list.entries[0]?.risks[0]?.level).toBe("high");
    expect(list.entries[0]?.risks[0]?.profileIds).toEqual(["p-1"]);
    expect(list.entries[0]?.risks[0]?.otherProxyIds).toEqual(["pxv_fedcba9876543210"]);

    const edit = await fetchProxyVaultEdit(canonicalItem.id);
    expect(edit.user).toBe("alice");
    expect(edit.refreshUrl).toBe("https://rotate.proxy.example/next");

    const updated = await updateProxyVaultEntry(canonicalItem.id, { notes: "Edited", clearRefreshUrl: true });
    expect(updated.boundCount).toBe(0);
    expect(patchBodies[0]?.refreshUrl).toBe("");

    const preview = await previewProxyVaultImport({ text: "http://1.1.1.1:8080" });
    expect(preview.total).toBe(3);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.rows[1]?.status).toBe("duplicate");
    expect(preview.rows[2]?.reason).toBe("Bad port");

    const applied = await applyProxyVaultImport({ text: "http://1.1.1.1:8080", strategy: "skip_duplicates" });
    expect(applied.inserted).toBe(1);

    const events: ProxyVaultCheckEvent[] = [];
    await checkProxyVaultStream({ ids: [canonicalItem.id] }, (ev) => events.push(ev));
    expect(events.map((e) => e.type)).toEqual(["progress", "result", "progress", "done"]);
    expect(events[3]).toEqual({ type: "done", checked: 1 });

    const refreshed = await refreshProxyVaultIp(canonicalItem.id, { recheck: true });
    expect(refreshed.exitIp).toBe("198.51.100.77");
    expect(refreshed.latencyMs).toBe(52);
    let cooldownErr: unknown;
    try {
      await refreshProxyVaultIp(canonicalItem.id);
    } catch (err) {
      cooldownErr = err;
    }
    expect(cooldownErr).toBeInstanceOf(ProxyVaultError);
    expect((cooldownErr as ProxyVaultError).cooldownRemainingMs).toBe(4200);

    const bound = await bindProxyVaultEntries({
      proxyIds: [canonicalItem.id],
      profileIds: ["p-1", "p-2"],
      mode: "single",
    });
    expect(bound.updated).toBe(1);
    expect(bound.skippedRunning).toBe(1);
    expect(bound.updatedIds).toEqual(["p-1"]);
    expect(bound.skippedIds).toEqual(["p-2"]);
    expect(bound.riskSummary.high).toBe(1);
    expect(bound.riskSummary.warnings).toHaveLength(1);

    const synced = await syncProxyVaultBoundProfiles(canonicalItem.id);
    expect(synced).toEqual({ updated: 2, skippedRunning: 1 });

    const ingested = await ingestProxyVaultFromProfiles();
    expect(ingested).toEqual({ ingested: 2, skippedDuplicates: 1, bound: 3 });
  });
});
