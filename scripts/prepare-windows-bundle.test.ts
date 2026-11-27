import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSidecar, loadVerifiedNodeArchive, NODE_WINDOWS_X64_CACHE_NAME, prepareWindowsBundle, sidecarCompileEnvironment, stageAgentRuntime, WINDOWS_SIDECAR_TARGET } from "./prepare-windows-bundle.ts";
import { MCP_MODE } from "../src/sidecar-entry.ts";
import { ALIASMODE_VERSION } from "../src/version.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function firefoxArchive(executable = "owned-firefox"): { bytes: Uint8Array; archiveSha256: string; executableSha256: string } {
  const name = new TextEncoder().encode("firefox/aliasmode.exe");
  const contents = new TextEncoder().encode(executable);
  const local = new Uint8Array(30 + name.length + contents.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(18, contents.length, true);
  localView.setUint32(22, contents.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(contents, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(20, contents.length, true);
  centralView.setUint32(24, contents.length, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const bytes = new Uint8Array(local.length + central.length + end.length);
  bytes.set(local);
  bytes.set(central, local.length);
  bytes.set(end, local.length + central.length);
  return {
    bytes,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    executableSha256: sha256(executable),
  };
}

test("Windows sidecar supports x64 CPUs without AVX2", () => {
  expect(WINDOWS_SIDECAR_TARGET).toBe("bun-windows-x64-baseline");
});

test("one sidecar program also runs the MCP helper behind the aliasmode-mcp launcher", () => {
  const repo = join(import.meta.dir, "..");
  const tauri = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
  expect(tauri.bundle.externalBin).toEqual(["binaries/aliasmode-sidecar"]);
  const cargo = readFileSync(join(repo, "src-tauri", "Cargo.toml"), "utf8");
  expect(cargo).toContain(`default-run = "aliasmode"`);
  expect(cargo).toContain(`name = "aliasmode-mcp"\npath = "src/bin/aliasmode-mcp.rs"`);
  const launcher = readFileSync(join(repo, "src-tauri", "src", "bin", "aliasmode-mcp.rs"), "utf8");
  expect(launcher).toContain(`const MCP_MODE: &str = "${MCP_MODE}";`);

  const helper = Bun.spawnSync([process.execPath, "src/sidecar-entry.ts", MCP_MODE, "version"], { cwd: repo });
  expect(helper.exitCode).toBe(0);
  expect(JSON.parse(helper.stdout.toString())).toEqual({ ok: true, result: { version: ALIASMODE_VERSION } });
  const failed = Bun.spawnSync([process.execPath, "src/sidecar-entry.ts", MCP_MODE, "unknown"], { cwd: repo });
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.stdout.toString())).toMatchObject({ ok: false });
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-windows-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "maobu-browser" }));
  writeFileSync(join(cwd, "src-tauri", "tauri.conf.json"), JSON.stringify({ identifier: "com.maobu.local" }));
  writeFileSync(join(cwd, "playwright-worker.mjs"), "worker");
  writeFileSync(join(cwd, "firefox-worker.mjs"), "firefox worker");
  mkdirSync(join(cwd, "agent"), { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "mcp-scope.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-recorder.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) {
    writeFileSync(join(cwd, "agent", file), file);
  }
  const dependencies: Record<string, { version: string; dependencies?: Record<string, string> }> = {
    "playwright-core": { version: "1.58.2" },
    "ws": { version: "8.21.0" },
    "@modelcontextprotocol/sdk": { version: "1.30.0", dependencies: { zod: "1.0.0" } },
    "@playwright/mcp": {
      version: "0.0.56",
      dependencies: { playwright: "1.58.0-alpha-2026-01-16", "playwright-core": "1.58.0-alpha-2026-01-16" },
    },
    "playwright": { version: "1.58.0-alpha-2026-01-16", dependencies: { "playwright-core": "1.58.0-alpha-2026-01-16" } },
    "zod": { version: "1.0.0" },
  };
  for (const [dependency, manifest] of Object.entries(dependencies)) {
    const root = join(cwd, "node_modules", ...dependency.split("/"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: dependency, ...manifest }));
  }
  return cwd;
}

test("Windows bundle preparation packages owned Firefox with verified hashes and no CloakBrowser", async () => {
  const cwd = workspace();
  const firefox = firefoxArchive();
  const staging = join(cwd, "src-tauri", "target", "desktop-staging");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "stale"), "remove");
  try {
    const metadata = await prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: firefox,
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => {
        mkdirSync(join(root, "node"), { recursive: true });
        writeFileSync(join(root, "node", "node.exe"), "node");
      },
    });

    // The app downloads CloakBrowser on first use, so the installer carries none.
    expect(metadata).toEqual({
      firefox: {
        executable: "firefox/aliasmode.exe",
        sha256: firefox.executableSha256,
        version: "156.0.1-beta.36",
        archiveSha256: firefox.archiveSha256,
      },
    });
    expect(existsSync(join(staging, "stale"))).toBe(false);
    expect(existsSync(join(cwd, "src-tauri", "resources", "cloakbrowser"))).toBe(false);
    expect(readFileSync(join(cwd, "src-tauri", "resources", "firefox", "firefox", "aliasmode.exe"), "utf8")).toBe("owned-firefox");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node.exe"), "utf8")).toBe("node");
    // Python scripts download their runtime on first use; the bundle carries no Python.
    expect(existsSync(join(cwd, "src-tauri", "resources", "playwright", "python"))).toBe(false);
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "script-runner.mjs"), "utf8")).toBe("script-runner.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "script-runner.py"), "utf8")).toBe("script-runner.py");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "worker.mjs"), "utf8")).toBe("worker");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "playwright-worker.mjs"), "utf8")).toBe("worker");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "firefox-worker.mjs"), "utf8")).toBe("firefox worker");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "playwright-core", "package.json"), "utf8")).version).toBe("1.58.2");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "ws", "package.json"), "utf8")).version).toBe("8.21.0");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8")).version).toBe("1.30.0");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "@playwright", "mcp", "package.json"), "utf8")).version).toBe("0.0.56");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "playwright", "package.json"), "utf8")).version).toBe("1.58.0-alpha-2026-01-16");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "node_modules", "zod", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "mcp-host.mjs"), "utf8")).toBe("mcp-host.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "resources", "playwright", "agent", "mcp-scope.mjs"), "utf8")).toBe("mcp-scope.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "binaries", "aliasmode-sidecar-x86_64-pc-windows-msvc.exe"), "utf8")).toBe("sidecar");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe(`${ALIASMODE_VERSION}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a Firefox archive hash mismatch", async () => {
  const cwd = workspace();
  const archive = firefoxArchive();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: { ...archive, archiveSha256: sha256("replaced") },
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
    })).rejects.toThrow("Firefox archive SHA-256 does not match the approved CI artifact");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows bundle preparation rejects a Firefox executable hash mismatch", async () => {
  const cwd = workspace();
  const archive = firefoxArchive();
  try {
    await expect(prepareWindowsBundle({
      cwd,
      platform: "win32",
      arch: "x64",
      firefoxArchive: { ...archive, executableSha256: sha256("replaced") },
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
    })).rejects.toThrow("Firefox executable does not match the approved SHA-256");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("desktop bundle preparation is Windows x64 only", async () => {
  await expect(prepareWindowsBundle({ platform: "linux", arch: "x64" })).rejects.toThrow("Windows x64");
  await expect(prepareWindowsBundle({ platform: "win32", arch: "arm64" })).rejects.toThrow("Windows x64");
});

test("standard Windows bundles do not install or require any browser engine", async () => {
  const cwd = workspace();
  try {
    const metadata = await prepareWindowsBundle({ cwd, platform: "win32", arch: "x64", bundleFirefox: false,
      compileSidecar: async (output) => { writeFileSync(output, "sidecar"); },
      installNode: async (root) => { mkdirSync(join(root, "node"), { recursive: true }); writeFileSync(join(root, "node", "node.exe"), "node"); },
    });
    expect(metadata).toEqual({ firefox: null });
    expect(existsSync(join(cwd, "src-tauri", "resources", "firefox", "aliasmode.exe"))).toBe(false);
    expect(existsSync(join(cwd, "src-tauri", "resources", "cloakbrowser"))).toBe(false);
    expect(readFileSync(join(cwd, "src-tauri", "resources", "firefox", "ON-DEMAND.txt"), "utf8")).toContain("downloaded and verified");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual({ firefox: null });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function fakePreparation(cwd: string) {
  return {
    cwd, platform: "win32" as const, arch: "x64", bundleFirefox: false,
    compileSidecar: async (output: string) => { writeFileSync(output, "sidecar"); },
    installNode: async (root: string) => { mkdirSync(join(root, "node"), { recursive: true }); writeFileSync(join(root, "node", "node.exe"), "node"); },
  };
}

test("agent runtime staging requires the recorder that the desktop loads", () => {
  const cwd = workspace();
  try {
    unlinkSync(join(cwd, "agent", "script-recorder.mjs"));
    expect(() => stageAgentRuntime(cwd, join(cwd, "stage"))).toThrow("script-recorder.mjs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
function cachePath(cwd: string): string { return join(cwd, "node_modules", ".cache", "maobu-desktop", NODE_WINDOWS_X64_CACHE_NAME); }

test("preparation refuses an unrelated explicit workspace before removing existing output", async () => {
  const cwd = workspace(), staging = join(cwd, "src-tauri", "target", "desktop-staging");
  mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, "keep"), "existing output");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "another-project" }));
  try {
    await expect(prepareWindowsBundle(fakePreparation(cwd))).rejects.toThrow("Maobu project manifests");
    expect(readFileSync(join(staging, "keep"), "utf8")).toBe("existing output");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the default cwd must be the source root, while explicit fixture workspaces remain supported", () => {
  const cwd = workspace();
  try {
    const module = join(import.meta.dir, "prepare-windows-bundle.ts");
    const script = `const { prepareWindowsBundle } = await import(${JSON.stringify(module.replaceAll("\\", "/"))});
      try { await prepareWindowsBundle({ platform: "win32", arch: "x64", compileSidecar: async () => { throw new Error("incorrectly reached compiler"); }, installNode: async () => {} }); process.exit(2); }
      catch (error) { if (!error.message.includes("source project root")) { console.error(error.message); process.exit(3); } }`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { cwd });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(existsSync(join(cwd, "src-tauri", "resources"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("all cleanup roots are checked before deletion when a resource root is a junction", async () => {
  const cwd = workspace(), outside = workspace();
  const staging = join(cwd, "src-tauri", "target", "desktop-staging"), linked = join(cwd, "src-tauri", "resources", "playwright");
  mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, "keep"), "existing staging");
  mkdirSync(join(cwd, "src-tauri", "resources"), { recursive: true });
  writeFileSync(join(outside, "keep"), "outside");
  try {
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareWindowsBundle(fakePreparation(cwd))).rejects.toThrow("symbolic links or junctions");
    expect(readFileSync(join(staging, "keep"), "utf8")).toBe("existing staging");
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  } finally {
    if (existsSync(linked)) unlinkSync(linked);
    rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});

test("cleanup refuses a linked ancestor or descendant rather than traversing another directory", async () => {
  for (const placement of ["ancestor", "descendant"] as const) {
    const cwd = workspace(), outside = workspace();
    const target = join(cwd, "src-tauri", "target"), staging = join(target, "desktop-staging");
    const linked = placement === "ancestor" ? target : join(staging, "linked");
    writeFileSync(join(outside, "keep"), "outside");
    try {
      if (placement === "descendant") mkdirSync(staging, { recursive: true });
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(prepareWindowsBundle(fakePreparation(cwd))).rejects.toThrow("symbolic links or junctions");
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
    } finally {
      if (existsSync(linked)) unlinkSync(linked);
      rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("the Node archive cache rechecks every hit and replaces a corrupt entry only with verified bytes", async () => {
  const cwd = workspace(), bytes = new TextEncoder().encode("verified fixture archive"), expected = sha256("verified fixture archive");
  let downloads = 0;
  const options = { expectedSha256: expected, download: async () => { downloads++; return bytes; } };
  try {
    expect(await loadVerifiedNodeArchive(cwd, options)).toEqual(bytes);
    expect(await loadVerifiedNodeArchive(cwd, options)).toEqual(bytes); expect(downloads).toBe(1);
    writeFileSync(cachePath(cwd), "corrupt after first hit");
    expect(await loadVerifiedNodeArchive(cwd, options)).toEqual(bytes); expect(downloads).toBe(2);
    expect(readFileSync(cachePath(cwd))).toEqual(Buffer.from(bytes));
    expect(readdirSync(join(cwd, "node_modules", ".cache", "maobu-desktop"))).toEqual([NODE_WINDOWS_X64_CACHE_NAME]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("failed downloads and hash mismatches preserve an existing Node cache", async () => {
  const cwd = workspace(), cache = cachePath(cwd);
  mkdirSync(join(cwd, "node_modules", ".cache", "maobu-desktop"), { recursive: true }); writeFileSync(cache, "old corrupted archive");
  try {
    const failure = new Error("fixture download unavailable");
    await expect(loadVerifiedNodeArchive(cwd, { expectedSha256: sha256("verified"), download: async () => { throw failure; } })).rejects.toBe(failure);
    expect(readFileSync(cache, "utf8")).toBe("old corrupted archive");
    await expect(loadVerifiedNodeArchive(cwd, { download: async () => new TextEncoder().encode("not the official ZIP") })).rejects.toThrow("SHA-256 mismatch");
    expect(readFileSync(cache, "utf8")).toBe("old corrupted archive");
    expect(readdirSync(join(cwd, "node_modules", ".cache", "maobu-desktop"))).toEqual([NODE_WINDOWS_X64_CACHE_NAME]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the preparation download injection cannot bypass the pinned official Node digest", async () => {
  const cwd = workspace();
  const { installNode: _installNode, ...options } = fakePreparation(cwd);
  try {
    await expect(prepareWindowsBundle({ ...options, downloadNode: async () => new TextEncoder().encode("unapproved runtime") })).rejects.toThrow("official Node runtime SHA-256 mismatch");
    expect(existsSync(cachePath(cwd))).toBe(false);
    expect(existsSync(join(cwd, "src-tauri", "resources", "playwright", "node", "node.exe"))).toBe(false);
    expect(existsSync(join(cwd, "src-tauri", "generated", "browser.json"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("cache paths are rechecked after an asynchronous download before publishing", async () => {
  const cwd = workspace(), outside = workspace(), linked = join(cwd, "node_modules", ".cache");
  const bytes = new TextEncoder().encode("verified fixture archive");
  try {
    await expect(loadVerifiedNodeArchive(cwd, { expectedSha256: sha256("verified fixture archive"), download: async () => {
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir"); return bytes;
    } })).rejects.toThrow("symbolic links or junctions");
    expect(existsSync(join(outside, "maobu-desktop"))).toBe(false);
  } finally {
    if (existsSync(linked)) unlinkSync(linked);
    rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});

test("cache publication is an atomic rename and its failure preserves the old cache", async () => {
  const cwd = workspace(), cache = cachePath(cwd), bytes = new TextEncoder().encode("verified fixture archive");
  mkdirSync(join(cwd, "node_modules", ".cache", "maobu-desktop"), { recursive: true }); writeFileSync(cache, "old archive");
  const failure = new Error("fixture persistent rename denial"); let published = false;
  try {
    await expect(loadVerifiedNodeArchive(cwd, { expectedSha256: sha256("verified fixture archive"), download: async () => bytes, rename(from, to) {
      published = true; expect(to).toBe(cache); expect(readFileSync(from)).toEqual(Buffer.from(bytes));
      expect(readFileSync(to, "utf8")).toBe("old archive"); throw failure;
    } })).rejects.toBe(failure);
    expect(published).toBe(true); expect(readFileSync(cache, "utf8")).toBe("old archive");
    expect(readdirSync(join(cwd, "node_modules", ".cache", "maobu-desktop"))).toEqual([NODE_WINDOWS_X64_CACHE_NAME]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("cache directories and cache files cannot be linked to another location", async () => {
  for (const placement of ["directory", "file"] as const) {
    const cwd = workspace(), outside = workspace(), cacheDirectory = join(cwd, "node_modules", ".cache");
    const linked = placement === "directory" ? cacheDirectory : cachePath(cwd);
    let downloads = 0;
    try {
      if (placement === "file") {
        mkdirSync(join(cacheDirectory, "maobu-desktop"), { recursive: true }); writeFileSync(join(outside, "archive"), "external archive");
      }
      symlinkSync(placement === "directory" ? outside : join(outside, "archive"), linked, placement === "directory" ? (process.platform === "win32" ? "junction" : "dir") : "file");
      await expect(loadVerifiedNodeArchive(cwd, { download: async () => { downloads++; return new Uint8Array(); } })).rejects.toThrow("symbolic links or junctions");
      expect(downloads).toBe(0);
      if (placement === "file") expect(readFileSync(join(outside, "archive"), "utf8")).toBe("external archive");
    } finally {
      if (existsSync(linked)) unlinkSync(linked);
      rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("sidecar environment filters signing names before reading their values and does not change its input", () => {
  const environment: NodeJS.ProcessEnv = { PATH: "fixture-path", NORMAL_BUILD_VALUE: "enabled" };
  for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "tauri_signing_private_key"]) {
    Object.defineProperty(environment, name, { enumerable: true, get() { throw new Error("signing value must never be read"); } });
  }
  expect(sidecarCompileEnvironment(environment)).toEqual({ PATH: "fixture-path", NORMAL_BUILD_VALUE: "enabled" });
  expect(Object.keys(environment)).toContain("TAURI_SIGNING_PRIVATE_KEY");
  expect(Object.keys(environment)).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
});

test("the compiler child receives an explicit signing-free environment", async () => {
  const parentNames = Object.keys(process.env); let invoked = false;
  await compileSidecar("fixture-source", "fixture-sidecar", WINDOWS_SIDECAR_TARGET, (command, options) => {
    invoked = true; expect(command).toContain(`--target=${WINDOWS_SIDECAR_TARGET}`);
    expect(options.cwd).toBe("fixture-source"); expect(options.stdout).toBe("inherit");
    expect(Object.keys(options.env).some(name => /^TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?$/i.test(name))).toBe(false);
    return { exited: Promise.resolve(0) };
  });
  expect(invoked).toBe(true); expect(Object.keys(process.env)).toEqual(parentNames);
});
