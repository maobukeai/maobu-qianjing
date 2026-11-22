import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Launcher } from "./launcher.ts";
import { ensureStateDirectories, statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import { handleDiagnosticsRoutes } from "./src/ui/diagnostics-routes.ts";
import { extractZipTo } from "./unzip.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "maobu-diag-routes-"));
  cleanups.push(() => {
    const resolved = resolve(home);
    const tmp = resolve(tmpdir());
    if (!resolved.startsWith(`${tmp}\\maobu-diag-routes-`) && !resolved.startsWith(`${tmp}/maobu-diag-routes-`)) {
      throw new Error("Unexpected fixture path");
    }
    rmSync(home, { recursive: true, force: true });
  });
  const paths = statePaths(home);
  ensureStateDirectories(paths);
  mkdirSync(join(paths.root, "logs"), { recursive: true });
  writeFileSync(join(paths.root, "logs", "aliasmode-2026-11-22.log"), "INFO ready token=secret_route_token_123\n");
  const store = new ProfileStore(paths.database);
  cleanups.push(() => store.close());
  const launcher = {
    dataDriveFreeBytes: () => 80 * 1024 ** 3,
  } as unknown as Launcher;

  const opts = {
    paths,
    workspaceHome: home,
    probeTcpPort: async () => "closed" as const,
    getIntegration: () => ({
      version: "0.20.0",
      transport: "stdio" as const,
      status: "desktop_required" as const,
      connectionVerified: false as const,
      helperPath: null,
      configs: [],
      checks: [],
      capabilities: [],
      tools: [],
      workflows: [],
    }),
    now: () => new Date("2026-11-22T14:30:00.000Z"),
  };

  return { home, paths, store, launcher, opts };
}

describe("handleDiagnosticsRoutes", () => {
  test("returns null for non-diagnostics routes and enforces guards", async () => {
    const f = fixture();
    expect(
      await handleDiagnosticsRoutes(
        new Request("http://127.0.0.1:50401/ui/api/health"),
        "/ui/api/health",
        f.launcher,
        f.store,
        f.opts,
      ),
    ).toBeNull();

    const missingHeader = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      "/ui/api/diagnostics/run",
      f.launcher,
      f.store,
      f.opts,
    );
    expect(missingHeader?.status).toBe(403);

    const wrongMethod = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/run", {
        method: "GET",
        headers: { "X-Maobu-Settings": "1" },
      }),
      "/ui/api/diagnostics/run",
      f.launcher,
      f.store,
      f.opts,
    );
    expect(wrongMethod?.status).toBe(405);

    const crossOrigin = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/export", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "X-Maobu-Settings": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format: "zip" }),
      }),
      "/ui/api/diagnostics/export",
      f.launcher,
      f.store,
      f.opts,
    );
    expect(crossOrigin?.status).toBe(403);
  });

  test("POST /ui/api/diagnostics/run returns 6 checks with desktopProbe metadata", async () => {
    const f = fixture();
    const res = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/run", {
        method: "POST",
        headers: {
          "X-Maobu-Settings": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          includeMcpProbe: false,
          desktopProbe: {
            platform: "windows",
            arch: "x86_64",
            osName: "Windows 11",
            osVersion: "24H2 (Build 26100.2033)",
            osBuild: 26100,
            webview2Version: "131.0.2903.51",
            webview2Available: true,
          },
        }),
      }),
      "/ui/api/diagnostics/run",
      f.launcher,
      f.store,
      { ...f.opts, health: { version: "0.20.0", root: f.home, instance: "inst_1" } },
    );

    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.report.checks).toHaveLength(6);
    expect(body.report.checks[0].status).toBe("pass");
  });

  test("POST /ui/api/diagnostics/export supports redacted ZIP and JSON downloads with SHA-256 header", async () => {
    const f = fixture();
    const zipRes = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/export", {
        method: "POST",
        headers: {
          "X-Maobu-Settings": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format: "zip", includeLogs: true }),
      }),
      "/ui/api/diagnostics/export",
      f.launcher,
      f.store,
      f.opts,
    );

    expect(zipRes?.status).toBe(200);
    expect(zipRes?.headers.get("content-type")).toBe("application/zip");
    expect(zipRes?.headers.get("content-disposition")).toContain("maobu-diagnostics-20261122-143000.zip");
    const zipBytes = new Uint8Array(await zipRes!.arrayBuffer());
    expect(zipRes?.headers.get("x-diagnostics-sha256")).toBe(
      createHash("sha256").update(zipBytes).digest("hex"),
    );

    const outDir = mkdtempSync(join(tmpdir(), "maobu-diag-route-unzip-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    await extractZipTo(zipBytes, outDir);
    expect(readFileSync(join(outDir, "redacted-sidecar.log"), "utf8")).not.toContain("secret_route_token_123");

    const jsonRes = await handleDiagnosticsRoutes(
      new Request("http://127.0.0.1:50401/ui/api/diagnostics/export", {
        method: "POST",
        headers: {
          "X-Maobu-Settings": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format: "json" }),
      }),
      "/ui/api/diagnostics/export",
      f.launcher,
      f.store,
      f.opts,
    );
    expect(jsonRes?.status).toBe(200);
    expect(jsonRes?.headers.get("content-type")).toContain("application/json");
    const jsonText = await jsonRes!.text();
    expect(jsonRes?.headers.get("x-diagnostics-sha256")).toBe(
      createHash("sha256").update(jsonText, "utf8").digest("hex"),
    );
    expect(JSON.parse(jsonText).checks).toHaveLength(6);
  });
});
