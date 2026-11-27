import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNewProfile } from "../create.ts";
import { managedChromiumLocation } from "../aliasmode-chromium.ts";
import { FIREFOX_RUNTIME_BUILDS, firefoxInstallDirectoryPrefix } from "../firefox-install.ts";
import { FIREFOX_MANAGED_RECORD, firefoxManagedDirectory } from "../firefox-managed.ts";
import type { Launcher } from "../launcher.ts";
import { ensureStateDirectories, statePaths } from "../paths.ts";
import type { RuntimeInventoryDeployment } from "../runtime-inventory.ts";
import { ProfileStore } from "../store.ts";
import {
  buildZipArchive,
  createDiagnosticZip,
  MAX_DIAGNOSTIC_ZIP_BYTES,
  redactDiagnosticText,
  runSystemDiagnostics,
} from "../system-diagnostics.ts";
import { extractZipTo } from "../unzip.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    const resolved = resolve(dir);
    const tmp = resolve(tmpdir());
    if (!resolved.startsWith(`${tmp}\\${prefix}`) && !resolved.startsWith(`${tmp}/${prefix}`)) {
      throw new Error("Unexpected fixture directory");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeFixture(freeBytes: number | null = 50 * 1024 ** 3) {
  const home = makeTempDir("maobu-diag-");
  const paths = statePaths(home);
  ensureStateDirectories(paths);
  const store = new ProfileStore(paths.database);
  cleanups.push(() => store.close());

  const secretProfile = buildNewProfile(
    {
      name: "UltraSecretAccountName",
      engine: "chromium",
      group: "VIPSecrets",
      username: "secret_login_user",
      password: "MySuperSecretPassword!99",
      email: "vip@secret-domain.example",
      emailPassword: "EmailSecretPassword!88",
      twofa: "JBSWY3DPEHPK3PXP",
      proxy: {
        type: "socks5",
        host: "198.51.100.77",
        port: "1080",
        user: "proxy_user_secret",
        pass: "proxy_pass_secret",
      },
    },
    () => false,
  );
  secretProfile.cookies = [
    {
      name: "session_auth",
      value: "cookie_secret_value_xyz123",
      domain: ".example.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      secure: true,
      sameSite: "Lax",
    },
  ];
  store.upsertProfile(secretProfile);

  const launcher = {
    dataDriveFreeBytes: () => freeBytes,
  } as unknown as Pick<Launcher, "dataDriveFreeBytes">;

  return { home, paths, store, launcher, secretProfile };
}

describe("redactDiagnosticText", () => {
  test("strips local paths, usernames, Bearer/hex tokens, passwords, user:pass@, public IPs, Cookies, and CDP URLs", () => {
    const raw = [
      "Windows path: C:\\Users\\AliceSmith\\AppData\\Local\\Maobu\\profiles\\p1",
      "POSIX path: /Users/alicesmith/.config/maobu and /home/bob/data",
      "Auth header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      "Session header: X-Maobu-Desktop-Session: deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      "Query secret: password=TopSecretPass123&token=Tok987654321&api_key=sk-live-secret99",
      "Proxy URL: socks5://alice_proxy:secret_proxy_pw@203.0.113.45:1080",
      "Bare proxy: bob_proxy:secret_pw2@198.51.100.22:8080",
      "Cookie: sid=my_secret_cookie_value; csrftoken=csrf123",
      "CDP endpoint: ws://127.0.0.1:9222/devtools/browser/12345678-1234-1234-1234-123456789abc",
      "Public IPv6: 2001:db8:85a3::8a2e:370:7334",
      "Safe loopback: 127.0.0.1 and ::1",
      "Safe version: WebView2/130.0.2849.68 and sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ].join("\n");

    const redacted = redactDiagnosticText(raw, {
      env: {
        USERPROFILE: "C:\\Users\\AliceSmith",
        LOCALAPPDATA: "C:\\Users\\AliceSmith\\AppData\\Local",
        USERNAME: "AliceSmith",
      },
      homeDir: "C:\\Users\\AliceSmith",
      username: "AliceSmith",
    });

    expect(redacted).not.toContain("AliceSmith");
    expect(redacted).not.toContain("alicesmith");
    expect(redacted).not.toContain("/home/bob");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("deadbeef0123456789abcdef");
    expect(redacted).not.toContain("TopSecretPass123");
    expect(redacted).not.toContain("Tok987654321");
    expect(redacted).not.toContain("sk-live-secret99");
    expect(redacted).not.toContain("alice_proxy");
    expect(redacted).not.toContain("secret_proxy_pw");
    expect(redacted).not.toContain("secret_pw2");
    expect(redacted).not.toContain("my_secret_cookie_value");
    expect(redacted).not.toContain("devtools/browser/");
    expect(redacted).not.toContain("203.0.113.45");
    expect(redacted).not.toContain("198.51.100.22");
    expect(redacted).not.toContain("2001:db8:85a3::8a2e:370:7334");

    // Loopback, version, and labeled sha256 remain readable
    expect(redacted).toContain("<APP_DATA>");
    expect(redacted).toContain("<USER_HOME>");
    expect(redacted).toContain("[REDACTED_CDP_URL]");
    expect(redacted).toContain("127.0.0.1");
    expect(redacted).toContain("::1");
    expect(redacted).toContain("130.0.2849.68");
    expect(redacted).toContain("sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("runSystemDiagnostics & createDiagnosticZip", () => {
  test("executes all 6 checks, verifies streaming SHA-256 hashes, and never leaks profile records", async () => {
    const f = makeFixture(40 * 1024 ** 3);
    const runtimeRoot = join(f.home, "runtimes");
    const platform = "win32" as const;
    const arch = "x64";

    // Stage a managed Chromium binary and a Firefox binary with a deliberate hash mismatch
    const chromiumLoc = managedChromiumLocation("aliasmode", platform, arch)!;
    const chromiumExe = join(runtimeRoot, chromiumLoc.directory, ...chromiumLoc.executable.split("/"));
    mkdirSync(resolve(chromiumExe, ".."), { recursive: true });
    writeFileSync(chromiumExe, "chromium-binary-fixture");
    const expectedChromiumSha = createHash("sha256").update("chromium-binary-fixture").digest("hex");

    const fxBuild = FIREFOX_RUNTIME_BUILDS.find((b) => b.platform === platform && b.arch === arch)!;
    const fxDir = join(runtimeRoot, firefoxManagedDirectory(platform, arch));
    const fxRelPath = `browser/${firefoxInstallDirectoryPrefix(platform, arch)}Ab12Cd/${fxBuild.executablePath}`;
    const fxExe = join(fxDir, ...fxRelPath.split("/"));
    mkdirSync(resolve(fxExe, ".."), { recursive: true });
    writeFileSync(fxExe, "tampered-firefox-binary");
    writeFileSync(
      join(fxDir, FIREFOX_MANAGED_RECORD),
      JSON.stringify({ path: fxRelPath, sha256: fxBuild.executableSha256 }),
    );

    const deployment: RuntimeInventoryDeployment = {
      runtimeRoot,
      platform,
      arch,
      chromiumDefault: "aliasmode-chromium",
      cloakSource: "managed",
      firefoxSource: "managed",
    };

    const report = await runSystemDiagnostics({
      store: f.store,
      launcher: f.launcher,
      paths: f.paths,
      workspaceHome: f.home,
      runtimeInventory: deployment,
      desktopAvailable: true,
      dashboardPort: 51234,
      automationPort: 50400,
      includeMcpProbe: true,
      desktopProbe: {
        platform: "windows",
        arch: "x86_64",
        osName: "Windows 11",
        osVersion: "23H2 (Build 22631.4317)",
        osBuild: 22631,
        webview2Version: "130.0.2849.68",
        webview2Channel: "machine-wow64",
        webview2Available: true,
      },
      probeTcpPort: async () => "listening",
      getIntegration: () => ({
        version: "0.20.0",
        transport: "stdio" as const,
        status: "ready" as const,
        connectionVerified: false as const,
        helperPath: "C:\\Users\\AliceSmith\\AppData\\Local\\Maobu\\aliasmode-mcp.exe",
        configs: [],
        checks: [{ id: "helper", status: "pass" as const, message: "Helper OK at C:\\Users\\AliceSmith\\AppData\\Local\\Maobu" }],
        capabilities: [],
        tools: [],
        workflows: [],
      }),
      probeMcp: async () => ({
        checkedAt: Date.now(),
        status: "connected",
        connectionVerified: true,
        message: "ok",
        toolCount: 3,
        tools: ["browser_list", "browser_status", "browser_inspect"],
        server: { name: "aliasmode", version: "0.20.0" },
      }),
    });

    expect(report.checks).toHaveLength(6);
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    expect(byId.get("webview2_os")?.status).toBe("pass");
    expect(byId.get("ports")?.status).toBe("pass");
    expect(byId.get("sqlite")?.status).toBe("pass");
    expect((byId.get("sqlite")?.details.counts as any).profiles).toBe(1);
    // Firefox binary was tampered -> runtimes check must fail and report streaming SHA-256!
    expect(byId.get("runtimes")?.status).toBe("fail");
    const runtimesList = byId.get("runtimes")?.details.browserRuntimes as Array<Record<string, unknown>>;
    expect(runtimesList.find((r) => r.id === "aliasmode-chromium")?.sha256).toBe(expectedChromiumSha);
    expect(runtimesList.find((r) => r.id === "aliasmode-firefox")?.hashMatch).toBe(false);
    expect(byId.get("disk_space")?.status).toBe("pass");
    expect(byId.get("mcp")?.status).toBe("pass");

    // Zero profile records or sensitive strings anywhere in serialized report
    const serialized = JSON.stringify(report);
    for (const secret of [
      "UltraSecretAccountName",
      "secret_login_user",
      "MySuperSecretPassword!99",
      "EmailSecretPassword!88",
      "JBSWY3DPEHPK3PXP",
      "proxy_user_secret",
      "proxy_pass_secret",
      "cookie_secret_value_xyz123",
      "198.51.100.77",
      "AliceSmith",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("marks webview2_os as skipped outside desktop shell and warns on low disk space", async () => {
    const f = makeFixture(2 * 1024 ** 3); // 2 GiB (< 5 GiB threshold)
    const report = await runSystemDiagnostics({
      store: f.store,
      launcher: f.launcher,
      paths: f.paths,
      desktopAvailable: false,
      probeTcpPort: async () => "closed",
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
    });

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get("webview2_os")?.status).toBe("skipped");
    expect(byId.get("disk_space")?.status).toBe("warn");
    expect(byId.get("mcp")?.status).toBe("warn");
  });

  test("builds valid standard ZIP with redacted log tails strictly under 2 MiB", async () => {
    const f = makeFixture();
    const logsDir = join(f.paths.root, "logs");
    mkdirSync(logsDir, { recursive: true });
    // Create a large sidecar log (> 3 MiB) containing secrets at the tail
    const fillerLine = "2026-11-22 INFO heartbeat ok\n".repeat(120_000);
    const tailSecrets = [
      "2026-11-22 WARN proxy socks5://user1:SuperSecretPass@203.0.113.99:1080 failed",
      "2026-11-22 INFO path C:\\Users\\BobOperator\\AppData\\Local\\Maobu\\profiles",
      "2026-11-22 INFO cdp ws://127.0.0.1:9222/devtools/browser/abcdef12-3456-7890-abcd-ef1234567890",
      "2026-11-22 INFO Cookie: sid=secret_sid_value_999",
    ].join("\n");
    writeFileSync(join(logsDir, "aliasmode-2026-11-22.log"), fillerLine + tailSecrets);
    writeFileSync(
      join(logsDir, "desktop-panic.log"),
      "[maobu-desktop panic] Authorization: Bearer super_secret_bearer_token_1234567890 at /Users/bob/app\n",
    );

    const bundle = await createDiagnosticZip({
      store: f.store,
      launcher: f.launcher,
      paths: f.paths,
      workspaceHome: f.home,
      desktopAvailable: false,
      probeTcpPort: async () => "closed",
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
    });

    expect(bundle.zipBytes.byteLength).toBeGreaterThan(0);
    expect(bundle.zipBytes.byteLength).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ZIP_BYTES);
    expect(bundle.entries).toEqual(["diagnostic-report.json", "redacted-sidecar.log", "redacted-panic.log"]);
    expect(bundle.sha256).toBe(createHash("sha256").update(bundle.zipBytes).digest("hex"));

    // Verify ZIP extracts cleanly using the repository's strict unzip.ts!
    const extractedDir = makeTempDir("maobu-diag-unzip-");
    await extractZipTo(bundle.zipBytes, extractedDir);

    const extractedReport = readFileSync(join(extractedDir, "diagnostic-report.json"), "utf8");
    const extractedSidecar = readFileSync(join(extractedDir, "redacted-sidecar.log"), "utf8");
    const extractedPanic = readFileSync(join(extractedDir, "redacted-panic.log"), "utf8");

    expect(JSON.parse(extractedReport).checks).toHaveLength(6);
    expect(extractedSidecar).toContain("[REDACTED]:[REDACTED]@");
    expect(extractedSidecar).toContain("<USER_HOME>");
    expect(extractedSidecar).toContain("[REDACTED_CDP_URL]");
    expect(extractedSidecar).not.toContain("SuperSecretPass");
    expect(extractedSidecar).not.toContain("BobOperator");
    expect(extractedSidecar).not.toContain("203.0.113.99");
    expect(extractedSidecar).not.toContain("secret_sid_value_999");

    expect(extractedPanic).not.toContain("super_secret_bearer_token_1234567890");
    expect(extractedPanic).not.toContain("/Users/bob");
  });

  test("buildZipArchive produces valid PKZIP archives for both small and compressible entries", async () => {
    const zip = buildZipArchive([
      { name: "tiny.txt", content: "hi" },
      { name: "repeat.txt", content: "maobu-diagnostics ".repeat(500) },
    ]);
    const extractedDir = makeTempDir("maobu-zip-check-");
    await extractZipTo(zip, extractedDir);
    expect(readFileSync(join(extractedDir, "tiny.txt"), "utf8")).toBe("hi");
    expect(readFileSync(join(extractedDir, "repeat.txt"), "utf8")).toBe("maobu-diagnostics ".repeat(500));
  });
});
