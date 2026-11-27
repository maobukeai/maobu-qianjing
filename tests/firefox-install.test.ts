import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserEnvText } from "../src/browser-install.ts";
import { firefoxBuildForHost, firefoxReleaseArchiveUrl, installFirefox, type FirefoxRuntimeBuild } from "../src/firefox-install.ts";
import { runtimeDownloads } from "../src/runtime-download.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

for (const args of [["--engine", "firefox"], ["--engine", "invalid"]]) {
  test(`browser setup rejects incomplete engine options: ${args.join(" ")}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aliasmode-firefox-setup-cli-"));
    roots.push(cwd);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "install-browser", ...args], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });
}


function fixture(platform: "linux" | "darwin" = "linux", writeEnv = true) {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-firefox-install-"));
  roots.push(cwd);
  const archive = join(cwd, "owned-browser.zip");
  writeFileSync(archive, "approved archive");
  if (writeEnv) {
    writeFileSync(join(cwd, ".env"), "CLOAKBROWSER_BINARY_PATH=existing-chromium\nALIASMODE_FIREFOX_BINARY_PATH=old-firefox\nALIASMODE_FIREFOX_BINARY_SHA256=old-hash\n");
  }
  const build: FirefoxRuntimeBuild = {
    platform, arch: platform === "darwin" ? "arm64" : "x64",
    executablePath: platform === "darwin" ? "AliasMode.app/Contents/MacOS/aliasmode" : "aliasmode",
    archiveSha256: hash("approved archive"), executableSha256: hash("approved executable"),
  };
  const extract = async (_archive: string, destination: string) => {
    const executable = join(destination, build.executablePath);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "approved executable", { mode: 0o755 });
    writeFileSync(join(destination, "runtime-resource"), "preserved");
  };
  return { cwd, archive, build, extract };
}

function streaming(chunks: string[], options: {
  neverEnd?: boolean;
  neverFinishCancel?: boolean;
  onCancel?: () => void;
  onRead?: () => void;
} = {}) {
  let index = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      options.onRead?.();
      const chunk = chunks[index++];
      if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
      else if (!options.neverEnd) controller.close();
    },
    cancel() {
      cancellations++;
      options.onCancel?.();
      if (options.neverFinishCancel) return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  return { body, get cancellations() { return cancellations; } };
}

function downloadDirectories(cwd: string): string[] {
  return readdirSync(cwd).filter(entry => entry.startsWith(".aliasmode-firefox-download-"));
}

test("Firefox setup selects only matching host builds", () => {
  const { build } = fixture();
  expect(firefoxBuildForHost("linux", "x64", [build])).toBe(build);
  expect(() => firefoxBuildForHost("linux", "arm64", [build])).toThrow("Linux");
  expect(() => firefoxBuildForHost("darwin", "x64", [build])).toThrow("macOS");
});

test("Firefox setup includes approved builds for every supported host", () => {
  for (const [platform, arch] of [["win32", "x64"], ["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const) {
    const build = firefoxBuildForHost(platform, arch);
    expect(build).toMatchObject({ platform, arch });
    expect(build.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(build.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("Firefox setup uses the exact approved public release archive for each host", () => {
  const expected = {
    "linux-x64": "aliasmode-156.0.1-beta.36-lin.x86_64.zip",
    "darwin-arm64": "aliasmode-156.0.1-beta.36-mac.arm64.zip",
    "darwin-x64": "aliasmode-156.0.1-beta.36-mac.x86_64.zip",
    "win32-x64": "aliasmode-156.0.1-beta.36-win.x86_64.zip",
  };
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]] as const) {
    const archive = expected[`${platform}-${arch}` as keyof typeof expected];
    expect(firefoxReleaseArchiveUrl(firefoxBuildForHost(platform, arch))).toBe(
      `https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-156.0.1-beta.36-r14/${archive}`,
    );
  }
});

test("Firefox setup downloads, verifies, and pins the host release without environment output", async () => {
  const f = fixture("darwin", false);
  let requested = "";
  const result = await installFirefox({ cwd: f.cwd, platform: "darwin", arch: "arm64", writeEnv: false }, {
    builds: [f.build],
    extract: f.extract,
    fetch: async (input, init) => {
      requested = String(input);
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response("approved archive", { headers: { "content-length": String(Buffer.byteLength("approved archive")) } });
    },
  });

  expect(requested).toBe("https://github.com/aliasmode/aliasmode-firefox/releases/download/aliasmode-runtime-156.0.1-beta.36-r14/aliasmode-156.0.1-beta.36-mac.arm64.zip");
  expect(result.sha256).toBe(f.build.executableSha256);
  expect(existsSync(join(f.cwd, ".env"))).toBe(false);
  expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
});

test("Firefox setup completes a redirected streaming download before extraction", async () => {
  const f = fixture("linux", false);
  const archive = "approved archive".repeat(65_536);
  f.build.archiveSha256 = hash(archive);
  const release = firefoxReleaseArchiveUrl(f.build);
  const asset = "https://release-assets.githubusercontent.com/fixture/approved.zip?signature=fixture";
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request): Response {
      if (new URL(request.url).pathname === "/release") return Response.redirect(asset);
      return new Response(new ReadableStream({
        async start(controller) {
          for (let offset = 0; offset < archive.length; offset += 65_536) {
            controller.enqueue(new TextEncoder().encode(archive.slice(offset, offset + 65_536)));
            await Bun.sleep(1);
          }
          controller.close();
        },
      }));
    },
  });
  try {
    const result = await installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
      builds: [f.build], fetch: (input, init) => {
        requests.push(input);
        expect(init.redirect).toBe("manual");
        const path = input === release ? "release" : input === asset ? "archive" : null;
        if (!path) throw new Error("unexpected Firefox fixture URL");
        return fetch(new URL(path, server.url), init);
      },
      extract: async (path, destination) => {
        expect(readFileSync(path, "utf8")).toBe(archive);
        await f.extract(path, destination);
      },
    });
    expect(result.sha256).toBe(f.build.executableSha256);
    expect(requests).toEqual([release, asset]);
    expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("Firefox setup removes its failed public release download", async () => {
  const f = fixture("linux", false);
  const fixtureBody = streaming(["missing"], { neverEnd: true });
  const response = new Response(fixtureBody.body, { status: 404 });
  let signal: AbortSignal | null | undefined;
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
    builds: [f.build],
    extract: f.extract,
    fetch: async (_input, init) => { signal = init.signal; return response; },
  })).rejects.toThrow("download failed (HTTP 404)");

  expect(readdirSync(f.cwd).some((entry) => entry.startsWith(".aliasmode-firefox-download-"))).toBe(false);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  expect(fixtureBody.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(signal!.aborted).toBe(true);
});

test("Firefox rejects an endless oversized response before writing its excess chunk", async () => {
  const f = fixture("linux");
  let savedAtCancel = -1;
  const fixtureBody = streaming(["1234", "56789"], { neverEnd: true, onCancel() {
    const directory = join(f.cwd, downloadDirectories(f.cwd)[0]!);
    savedAtCancel = statSync(join(directory, readdirSync(directory)[0]!)).size;
  } });
  const response = new Response(fixtureBody.body);
  const originalEnv = readFileSync(join(f.cwd, ".env"), "utf8");
  let signal: AbortSignal | null | undefined;
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], archiveLimitBytes: 8,
    fetch: async (_input, init) => { signal = init.signal; return response; },
    extract: async () => { throw new Error("oversized archive must not be extracted"); },
  })).rejects.toThrow("exceeded its archive byte limit");
  expect(savedAtCancel).toBe(4);
  expect(fixtureBody.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(signal!.aborted).toBe(true);
  expect(downloadDirectories(f.cwd)).toEqual([]);
  expect(runtimeDownloads()).toEqual([]);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  expect(readFileSync(join(f.cwd, ".env"), "utf8")).toBe(originalEnv);
});

test("Firefox's deadline rejects a full-length response without EOF even if the body ignores abort", async () => {
  const f = fixture("linux", false);
  const fixtureBody = streaming(["approved archive"], { neverEnd: true, neverFinishCancel: true });
  const response = new Response(fixtureBody.body, { headers: { "content-length": String(Buffer.byteLength("approved archive")) } });
  let signal: AbortSignal | null | undefined;
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], downloadTimeoutMs: 75,
    fetch: async (_input, init) => { signal = init.signal; return response; },
    extract: f.extract,
  })).rejects.toThrow("download timed out");
  expect(fixtureBody.cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
  expect(signal!.aborted).toBe(true);
  expect(downloadDirectories(f.cwd)).toEqual([]);
  expect(runtimeDownloads()).toEqual([]);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
}, 1_000);

test("Firefox's deadline cancels a response that arrives after an ignored abort", async () => {
  const f = fixture("linux", false);
  const fixtureBody = streaming([], { neverEnd: true });
  let answer!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], downloadTimeoutMs: 50,
    fetch: (_input, init) => { signal = init.signal; return new Promise(resolve => { answer = resolve; }); },
    extract: f.extract,
  })).rejects.toThrow("download timed out");
  expect(signal!.aborted).toBe(true);
  answer(new Response(fixtureBody.body));
  await Promise.resolve();
  expect(fixtureBody.cancellations).toBe(1);
  expect(downloadDirectories(f.cwd)).toEqual([]);
  expect(runtimeDownloads()).toEqual([]);
}, 1_000);

test("Firefox rejects inflated or malformed identity Content-Length before opening an archive", async () => {
  for (const length of ["9", "4, 4", "-1", "9007199254740992"]) {
    const f = fixture("linux", false);
    let savedFiles: string[] = [];
    const fixtureBody = streaming(["abcd"], { neverEnd: true, onCancel() {
      savedFiles = readdirSync(join(f.cwd, downloadDirectories(f.cwd)[0]!));
    } });
    await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
      builds: [f.build], archiveLimitBytes: 8, extract: f.extract,
      fetch: async () => new Response(fixtureBody.body, { headers: { "content-length": length } }),
    })).rejects.toThrow(length === "9" ? "archive byte limit" : "invalid Content-Length");
    expect(savedFiles).toEqual([]);
    expect(fixtureBody.cancellations).toBe(1);
    expect(downloadDirectories(f.cwd)).toEqual([]);
    expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  }
});

test("Firefox rejects identity bodies whose actual lengths disagree with their declared lengths", async () => {
  for (const [declared, error] of [["2", "exceeded Content-Length"], ["4", "ended before Content-Length"]] as const) {
    const f = fixture("linux", false);
    const fixtureBody = streaming(["abc"]);
    await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
      builds: [f.build], archiveLimitBytes: 8, extract: f.extract,
      fetch: async () => new Response(fixtureBody.body, { headers: { "content-length": declared } }),
    })).rejects.toThrow(error);
    expect(downloadDirectories(f.cwd)).toEqual([]);
    expect(runtimeDownloads()).toEqual([]);
    expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  }
});

test("Firefox bounds decoded bytes independently of the encoded Content-Length and leaves progress indeterminate", async () => {
  const f = fixture("linux", false);
  const progress: number[] = [];
  const fixtureBody = streaming(["approved", " archive"], { onRead() {
    progress.push(runtimeDownloads().find(download => download.runtime === "firefox")!.totalBytes);
  } });
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
    builds: [f.build], archiveLimitBytes: 16, extract: f.extract,
    // Model fetch's decoded body and the original encoded response headers.
    fetch: async () => new Response(fixtureBody.body, { headers: { "content-length": "2", "content-encoding": "gzip" } }),
  })).resolves.toMatchObject({ sha256: f.build.executableSha256 });
  expect(progress).toEqual([0, 0, 0]);
  expect(runtimeDownloads()).toEqual([]);
  expect(downloadDirectories(f.cwd)).toEqual([]);

  const oversized = streaming(["123", "456"], { neverEnd: true });
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
    builds: [f.build], archiveLimitBytes: 4, extract: f.extract,
    fetch: async () => new Response(oversized.body, { headers: { "content-length": "2", "content-encoding": "gzip" } }),
  })).rejects.toThrow("archive byte limit");
  expect(oversized.cancellations).toBe(1);
  expect(downloadDirectories(f.cwd)).toEqual([]);
});

test("Firefox cancels redirected bodies and rejects insecure targets before requesting them", async () => {
  for (const target of ["http://fixture.invalid/archive.zip", "https://test:secret@fixture.invalid/archive.zip"]) {
    const f = fixture("linux", false);
    const fixtureBody = streaming(["redirect"], { neverEnd: true });
    const requests: string[] = [];
    await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
      builds: [f.build], extract: f.extract,
      fetch: async input => {
        requests.push(input);
        return new Response(fixtureBody.body, { status: 302, headers: { location: target } });
      },
    })).rejects.toThrow("requires HTTPS without URL credentials");
    expect(requests).toEqual([firefoxReleaseArchiveUrl(f.build)]);
    expect(fixtureBody.cancellations).toBe(1);
    expect(downloadDirectories(f.cwd)).toEqual([]);
  }
});

test("Firefox bounds HTTPS redirect chains and cleans every intermediate response", async () => {
  const f = fixture("linux", false);
  const bodies: ReturnType<typeof streaming>[] = [];
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], extract: f.extract,
    fetch: async (_input, init) => {
      expect(init.redirect).toBe("manual");
      const next = streaming([], { neverEnd: true });
      bodies.push(next);
      return new Response(next.body, { status: 307, headers: { location: `/fixture-redirect/${bodies.length}` } });
    },
  })).rejects.toThrow("redirect limit");
  expect(bodies).toHaveLength(9);
  expect(bodies.every(body => body.cancellations === 1)).toBe(true);
  expect(downloadDirectories(f.cwd)).toEqual([]);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
});

test("Firefox verifies the downloaded archive hash before invoking extraction", async () => {
  const f = fixture("linux", false);
  let extracted = false;
  await expect(installFirefox({ cwd: f.cwd, platform: "linux", arch: "x64", writeEnv: false }, {
    builds: [f.build], fetch: async () => new Response("unapproved file"),
    extract: async () => { extracted = true; },
  })).rejects.toThrow("archive does not match the approved host build SHA-256");
  expect(extracted).toBe(false);
  expect(downloadDirectories(f.cwd)).toEqual([]);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
});

test("Firefox configuration preserves Chromium pins and replaces only Firefox pins", () => {
  const value = browserEnvText("CLOAKBROWSER_BINARY_PATH=chromium\nALIASMODE_FIREFOX_BINARY_PATH=old\nALIASMODE_FIREFOX_BINARY_SHA256=old\n", "/new firefox/aliasmode", "a".repeat(64), "\n", "ALIASMODE_FIREFOX");
  expect(value).toContain("CLOAKBROWSER_BINARY_PATH=chromium\n");
  expect(value).toContain("ALIASMODE_FIREFOX_BINARY_PATH=/new firefox/aliasmode\n");
  expect(value).toContain(`ALIASMODE_FIREFOX_BINARY_SHA256=${"a".repeat(64)}\n`);
  expect(value).not.toContain("=old");
});

for (const platform of ["linux", "darwin"] as const) {
  test(`Firefox setup pins the complete verified ${platform} runtime`, async () => {
    const f = fixture(platform);
    const result = await installFirefox({ archive: f.archive, cwd: f.cwd, platform, arch: f.build.arch }, { builds: [f.build], extract: f.extract });
    expect(result.sha256).toBe(f.build.executableSha256);
    expect(result.path.replaceAll("\\", "/").endsWith(f.build.executablePath)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("approved executable");
    if (process.platform !== "win32") expect(() => accessSync(result.path, constants.X_OK)).not.toThrow();
    const directories = readdirSync(join(f.cwd, "browser"));
    expect(directories).toHaveLength(1);
    expect(readFileSync(join(f.cwd, "browser", directories[0]!, "runtime-resource"), "utf8")).toBe("preserved");
    const config = readFileSync(join(f.cwd, ".env"), "utf8");
    expect(config).toContain("CLOAKBROWSER_BINARY_PATH=existing-chromium\n");
    expect(config).toContain(`ALIASMODE_FIREFOX_BINARY_PATH=${result.path}`);
    expect(config).toContain(`ALIASMODE_FIREFOX_BINARY_SHA256=${result.sha256}`);
    const second = await installFirefox({ archive: f.archive, cwd: f.cwd, platform, arch: f.build.arch }, { builds: [f.build], extract: f.extract });
    expect(second.path).not.toBe(result.path);
    expect(readFileSync(result.path, "utf8")).toBe("approved executable");
  });
}

test("Firefox setup rejects an unapproved archive before extraction or config changes", async () => {
  const f = fixture();
  const original = readFileSync(join(f.cwd, ".env"), "utf8");
  writeFileSync(f.archive, "wrong platform or modified archive");
  let extracted = false;
  await expect(installFirefox({ archive: f.archive, cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], extract: async () => { extracted = true; },
  })).rejects.toThrow("SHA-256");
  expect(extracted).toBe(false);
  expect(existsSync(join(f.cwd, "browser"))).toBe(false);
  expect(readFileSync(join(f.cwd, ".env"), "utf8")).toBe(original);
});

test("Firefox setup removes only its failed extraction and preserves prior configuration", async () => {
  const f = fixture();
  const original = readFileSync(join(f.cwd, ".env"), "utf8");
  const previous = join(f.cwd, "browser", "existing-runtime");
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "in-use"), "keep");
  await expect(installFirefox({ archive: f.archive, cwd: f.cwd, platform: "linux", arch: "x64" }, {
    builds: [f.build], extract: async (archive, destination) => {
      await f.extract(archive, destination);
      writeFileSync(join(destination, f.build.executablePath), "modified executable");
    },
  })).rejects.toThrow("SHA-256");
  expect(readdirSync(join(f.cwd, "browser"))).toEqual(["existing-runtime"]);
  expect(readFileSync(join(previous, "in-use"), "utf8")).toBe("keep");
  expect(readFileSync(join(f.cwd, ".env"), "utf8")).toBe(original);
});
