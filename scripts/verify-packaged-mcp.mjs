import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsProcessIdentityCommand } from "../agent/runtime-client.mjs";
import { READ_ONLY_MCP_TOOLS } from "../agent/mcp-scope.mjs";

const execFileAsync = promisify(execFile);

async function bounded(pending, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function within(parent, path) {
  const rel = relative(parent, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

async function plainTree(path) {
  const entry = await lstat(path);
  assert(!entry.isSymbolicLink(), "MCP fixture must not contain a symlink or junction");
  assert(entry.isDirectory() || entry.isFile(), "MCP fixture contains a special file");
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await plainTree(join(path, name));
  } else {
    assert.equal(entry.nlink, 1, "MCP fixture must not share hard-linked files");
  }
}

/** Copy bytes into new files; never preserve a package's link to another tree. */
async function copyPlainTree(source, destination) {
  const entry = await lstat(source);
  assert(!entry.isSymbolicLink(), "Prepared MCP resources must not contain a symlink or junction");
  if (entry.isDirectory()) {
    await mkdir(destination);
    for (const name of await readdir(source)) await copyPlainTree(join(source, name), join(destination, name));
  } else {
    assert(entry.isFile(), "Prepared MCP resource is not a regular file");
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

async function assertFixtureHome(home) {
  const parent = await realpath(tmpdir());
  const actual = await realpath(home);
  assert.equal(resolve(home), actual, "MCP verification home must be its canonical path");
  assert.equal(dirname(actual), parent, "MCP verification requires the verifier's temporary home");
  assert(basename(actual).startsWith("maobu-local-smoke-"), "MCP verification requires a newly created smoke-test home");
  assert(!(await lstat(home)).isSymbolicLink(), "MCP verification home must not be a junction");
  return actual;
}

function psLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

/** Query only exact copied executable paths, never unrelated user process data. */
async function copiedProcesses(executables, { terminate = false } = {}) {
  const paths = executables.map(path => resolve(path));
  const filter = paths.map(path => `ExecutablePath = '${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(" OR ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$allowed = @(${paths.map(psLiteral).join(",")})`,
    `$owned = @(Get-CimInstance Win32_Process -Filter ${psLiteral(filter)})`,
    "if ($owned.Count -gt 16) { throw 'Unexpected MCP fixture process count' }",
    ...(terminate ? [
      "foreach ($item in $owned) {",
      "  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue",
      "  if ($null -ne $process -and $allowed -contains $process.Path) {",
      "    $process.Kill()",
      "    if (-not $process.WaitForExit(3000)) { throw 'MCP fixture process did not exit' }",
      "  }",
      "}",
      `$owned = @(Get-CimInstance Win32_Process -Filter ${psLiteral(filter)})`,
    ] : []),
    "ConvertTo-Json -InputObject @($owned | Select-Object ProcessId, ParentProcessId, ExecutablePath) -Compress",
  ].join("\n");
  const command = windowsProcessIdentityCommand(process.pid);
  const { stdout } = await execFileAsync(command.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 12_000, maxBuffer: 32 * 1024 });
  const records = JSON.parse(stdout.trim());
  assert(Array.isArray(records) && records.length <= 16, "Invalid MCP fixture process inventory");
  for (const record of records) {
    assert(Number.isInteger(record.ProcessId) && record.ProcessId > 0, "Invalid MCP fixture process ID");
    assert(paths.some(path => path.toLowerCase() === record.ExecutablePath?.toLowerCase()), "MCP process escaped the copied executable paths");
  }
  return records;
}

function noPrivateFields(value) {
  if (!value || typeof value !== "object") return;
  const forbidden = /^(?:nonce|generation|password|username|twofa|email|emailPassword|proxy|cookies|session|fpObserved|fpExpected|fpSource|configurationDigest|launchDigest|ws|debugPort|endpoint|raw|canvas|audio)$/i;
  for (const [key, child] of Object.entries(value)) {
    assert(!forbidden.test(key), "Packaged read-only MCP result contains a private/raw field");
    noPrivateFields(child);
  }
}

function publicResult(result, proof) {
  assert(result && result.isError !== true, "Packaged read-only MCP call failed");
  assert(result.structuredContent && typeof result.structuredContent === "object", "Packaged MCP omitted its structured result");
  const text = JSON.stringify(result);
  assert(!text.includes(proof.nonce) && !text.includes(proof.generation), "Packaged MCP result exposed a runtime capability");
  noPrivateFields(result);
  assert(Array.isArray(result.content) && result.content.length === 1 && result.content[0].type === "text"
    && isDeepStrictEqual(JSON.parse(result.content[0].text), result.structuredContent), "MCP text and structured read-only results differ");
  return result.structuredContent;
}

export async function socksFixture(host = "127.0.0.1") {
  assert(["127.0.0.1", "::1"].includes(host), "Only loopback SOCKS fixtures are supported");
  const sockets = new Map();
  const greeting = Buffer.from([5, 2, 0, 2]);
  let connections = 0;
  let verifiedGreetings = 0;
  let invalid = false;
  const server = createServer(socket => {
    connections++;
    const ended = new Promise(resolveClose => socket.once("close", () => { sockets.delete(socket); resolveClose(); }));
    sockets.set(socket, ended);
    socket.on("error", () => {});
    let bytes = Buffer.alloc(0);
    let answered = false;
    socket.on("data", chunk => {
      const data = Buffer.from(chunk);
      if (data.length > greeting.length - bytes.length) {
        invalid = true;
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, data]);
      if (!greeting.subarray(0, bytes.length).equals(bytes)) {
        invalid = true;
        socket.destroy();
      } else if (bytes.length === 4 && !answered) {
        answered = true;
        verifiedGreetings++;
        socket.write(Buffer.from([5, 2])); // Require authentication; the probe must stop here.
      }
    });
  });
  server.on("error", () => { invalid = true; });
  let closePromise;
  function close() {
    return closePromise ??= bounded(new Promise((resolveClose, reject) => {
      server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolveClose());
      for (const socket of sockets.keys()) socket.destroy();
    }), 5_000, "SOCKS fixture cleanup timed out");
  }
  try {
    await bounded(new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolveListen);
    }), 5_000, "SOCKS fixture startup timed out");
  } catch (error) { await close(); throw error; }
  const port = server.address().port;
  return {
    port,
    async assertGreetingOnly() {
      await bounded(Promise.all(sockets.values()), 3_000, "The SOCKS probe did not close the fixture connection");
      assert(!invalid && connections === 1, "Packaged discovery made unexpected fixture connections");
      assert.equal(verifiedGreetings, 1, "Packaged discovery did not send a complete SOCKS greeting");
    },
    close,
  };
}

/**
 * Exercise the real packaged stdio chain against an already-owned synthetic
 * sidecar. It never starts a native desktop or invokes a browser lifecycle tool.
 */
export async function verifyPackagedMcp({ prepared, version, home, service, profileId }) {
  assert.equal(process.platform, "win32", "This packaged MCP fixture verifies the Windows build");
  const fixtureHome = await assertFixtureHome(home);
  assert.equal(service.root, fixtureHome, "MCP fixture sidecar must own the synthetic default workspace");
  assert.equal(service.workspaceId, "default", "MCP fixture requires the synthetic default workspace");
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId), "Invalid synthetic MCP profile ID");
  const proof = service.agentProof;
  assert(proof && /^[a-f0-9]{64}$/.test(proof.nonce) && /^[a-f0-9]{64}$/.test(proof.generation), "Missing owned sidecar proof");
  assert(Number.isInteger(proof.sidecarPid) && proof.sidecarPid > 0, "Missing owned sidecar process");
  assert.equal(service.origin, `http://127.0.0.1:${proof.port}`, "MCP fixture port does not match the owned sidecar");
  const health = await service.read("/ui/api/health");
  assert(health.ok === true && health.version === version && health.instance === proof.generation && health.root === fixtureHome,
    "MCP fixture health does not match its owned sidecar");
  const before = (await service.read("/ui/api/profiles")).profiles;
  assert(before.length === 1 && before[0].id === profileId && before[0].running === false, "MCP verification requires one unlaunched synthetic profile");
  assert.equal((await service.read("/ui/api/runtime-downloads")).downloads.length, 0, "MCP fixture must start with no engine downloads");

  const fixture = await mkdtemp(join(fixtureHome, "packaged-mcp-"));
  const runtime = join(fixture, "runtime");
  const executables = [join(runtime, "aliasmode-mcp.exe"), join(runtime, "aliasmode-sidecar.exe"), join(runtime, "playwright", "node", "node.exe")];
  let client, transport, listener;
  let phase = "resource isolation";
  let outcome;
  let failure;
  let privateDiagnostics = false;
  try {
    await mkdir(runtime);
    for (const entry of ["aliasmode-mcp.exe", "aliasmode-sidecar.exe", "playwright"]) {
      await copyPlainTree(join(prepared.runtimeRoot, entry), join(runtime, entry));
    }
    await plainTree(runtime);
    assert(!(await readdir(runtime)).some(name => name.toLowerCase() === "aliasmode.exe"), "MCP fixture must not contain a native desktop executable");
    assert.equal(resolve(runtime, "playwright", "agent", "..", "..", "AliasMode.exe"), join(runtime, "AliasMode.exe"), "MCP fallback path escaped its copied runtime");
    for (const path of executables) assert(within(fixture, await realpath(path)), "MCP executable escaped its fixture");

    const appdata = join(fixture, "appdata");
    const localappdata = join(fixture, "localappdata");
    const temporary = join(fixture, "temp");
    for (const path of [join(appdata, "com.maobu.local"), localappdata, temporary]) await mkdir(path, { recursive: true });
    const identity = windowsProcessIdentityCommand(process.pid);
    const { stdout } = await execFileAsync(identity.executable, identity.args, { windowsHide: true, timeout: 5_000, maxBuffer: 1024 });
    const desktopStartedAt = stdout.trim();
    assert(/^\d+$/.test(desktopStartedAt), "Verifier process identity is invalid");
    await writeFile(join(appdata, "com.maobu.local", "agent-runtime.json"), JSON.stringify({
      protocol: "aliasmode-runtime-v1", appVersion: version, generation: proof.generation, nonce: proof.nonce,
      port: proof.port, desktopPid: process.pid, desktopStartedAt, sidecarPid: proof.sidecarPid,
      readiness: "local", createdAt: Math.floor(Date.now() / 1000),
    }), { flag: "wx" });

    // The SDK itself inherits its OS whitelist, never arbitrary application env.
    // Deliberately omit ALIASMODE_RUNTIME_DESCRIPTOR / ALIASMODE_DESKTOP_EXE:
    // discovery must use synthetic APPDATA and the absent copied native exe.
    const env = { APPDATA: appdata, LOCALAPPDATA: localappdata, TEMP: temporary, TMP: temporary,
      ALIASMODE_PLAYWRIGHT_RUNTIME: join(runtime, "playwright") };
    listener = await socksFixture();
    transport = new StdioClientTransport({ command: executables[0], args: ["serve"], env,
      cwd: runtime, stderr: "pipe", maxBufferSize: 2 * 1024 * 1024 });
    let diagnosticTail = "";
    transport.stderr.on("data", chunk => {
      const text = diagnosticTail + chunk.toString("utf8");
      if (text.includes(proof.nonce) || text.includes(proof.generation)) privateDiagnostics = true;
      diagnosticTail = text.slice(-63);
    });
    client = new Client({ name: "maobu-packaged-readonly-verifier", version });
    phase = "initialize";
    await bounded(client.connect(transport, { timeout: 30_000 }), 35_000, "Packaged MCP initialization timed out");
    assert(client.getServerVersion()?.name === "aliasmode" && client.getServerVersion()?.version === version, "Packaged MCP server identity differs");
    const processes = await copiedProcesses(executables);
    const helper = processes.find(item => item.ProcessId === transport.pid && item.ExecutablePath.toLowerCase() === executables[0].toLowerCase());
    const sidecar = processes.find(item => item.ParentProcessId === helper?.ProcessId && item.ExecutablePath.toLowerCase() === executables[1].toLowerCase());
    const node = processes.find(item => item.ParentProcessId === sidecar?.ProcessId && item.ExecutablePath.toLowerCase() === executables[2].toLowerCase());
    assert(helper && sidecar && node && processes.length === 3, "MCP did not use exactly the copied helper, sidecar and packaged Node chain");

    phase = "tools/list";
    const tools = new Map();
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < 4; page++) {
      const listed = await bounded(client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 }), 20_000, "Packaged MCP catalog timed out");
      for (const tool of listed.tools) {
        assert(typeof tool.name === "string" && !tools.has(tool.name) && tools.size < 512, "Packaged MCP catalog contains invalid or duplicate tools");
        tools.set(tool.name, tool);
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
      assert(!cursors.has(cursor), "Packaged MCP catalog repeated a cursor");
      cursors.add(cursor);
    }
    assert(!cursor && tools.size === READ_ONLY_MCP_TOOLS.length && READ_ONLY_MCP_TOOLS.every(name => tools.has(name)),
      "Packaged MCP default must expose only the read-only catalog");
    const catalog = JSON.stringify([...tools.values()]);
    assert(!catalog.includes(proof.nonce) && !catalog.includes(proof.generation), "Packaged MCP catalog exposed a runtime capability");
    for (const name of READ_ONLY_MCP_TOOLS) {
      const hints = tools.get(name).annotations;
      assert(hints?.readOnlyHint === true && hints.destructiveHint === false && hints.openWorldHint === false && hints.idempotentHint === true,
        "Packaged MCP read-only annotations changed");
    }

    phase = "profile inventory";
    const inventory = publicResult(await bounded(client.callTool({ name: "aliasmode_profiles_list", arguments: {} }, undefined, { timeout: 15_000 }),
      20_000, "Packaged profile inventory timed out"), proof);
    assert(inventory.liveness === "not-checked" && inventory.profiles.some(item => item.id === profileId && item.running === false),
      "Packaged profile inventory inferred liveness or lost its synthetic profile");

    phase = "fingerprint review";
    const review = publicResult(await bounded(client.callTool({ name: "aliasmode_fingerprint_review", arguments: { profileId } }, undefined, { timeout: 15_000 }),
      20_000, "Packaged fingerprint review timed out"), proof);
    assert(review.liveness === "not-checked" && review.launchRecordPresent === false && review.report?.profileId === profileId,
      "Packaged fingerprint review inferred liveness or lost its synthetic profile");
    assert(!("running" in review) && !("running" in review.report), "Stored fingerprint review must not claim process liveness");

    phase = "loopback discovery";
    const network = publicResult(await bounded(client.callTool({ name: "aliasmode_network_discover", arguments: { host: "127.0.0.1", ports: [listener.port] } }, undefined, { timeout: 15_000 }),
      20_000, "Packaged network discovery timed out"), proof);
    const result = network.discovery?.results?.[0];
    assert(network.discovery?.host === "127.0.0.1" && network.discovery.results.length === 1 && result.host === "127.0.0.1"
      && result.port === listener.port && result.status === "listening" && result.socks5 === "authentication_required",
      "Packaged network discovery did not identify the isolated SOCKS fixture");
    assert(!JSON.stringify(network).includes('"working"'), "Local discovery must not claim egress connectivity");
    await listener.assertGreetingOnly();
    phase = "direct CLI under a configured proxy";
    let proxyConnections = 0;
    const deniedProxy = createServer(socket => { proxyConnections++; socket.destroy(); });
    await new Promise((resolveListening, reject) => {
      deniedProxy.once("error", reject);
      deniedProxy.listen(0, "127.0.0.1", resolveListening);
    });
    try {
      const address = deniedProxy.address();
      assert(address && typeof address !== "string");
      const proxy = `http://127.0.0.1:${address.port}`;
      const { stdout } = await execFileAsync(executables[0], ["profiles", "list"], {
        cwd: runtime, windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024,
        env: { ...process.env, ...env, ALIASMODE_RUNTIME_DESCRIPTOR: join(appdata, "com.maobu.local", "agent-runtime.json"),
          ALIASMODE_DESKTOP_EXE: join(runtime, "AliasMode.exe"), HTTP_PROXY: proxy, http_proxy: proxy,
          HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" },
      });
      assert.equal(proxyConnections, 0, "Agent authentication must go directly to the desktop loopback service");
      const result = JSON.parse(stdout);
      assert(result.ok === true && result.result.profiles.some(item => item.id === profileId), "Packaged CLI could not read the synthetic profile");
      assert(!stdout.includes(proof.nonce) && !stdout.includes(proof.generation), "Packaged CLI exposed a runtime capability");
    } finally { await new Promise(resolveClosed => deniedProxy.close(resolveClosed)); }
    assert(!privateDiagnostics, "Packaged MCP diagnostics exposed a runtime capability");
    assert.equal((await service.read("/ui/api/runtime-downloads")).downloads.length, 0, "MCP read-only calls downloaded an engine");
    assert(JSON.stringify((await service.read("/ui/api/profiles")).profiles) === JSON.stringify(before), "MCP read-only calls changed profiles or created a launch record");
    outcome = { packagedMcpProtocol: "ok", packagedMcpLocalTools: READ_ONLY_MCP_TOOLS.length, packagedMcpToolCount: tools.size,
      packagedMcpReadOnlyCalls: 3, packagedMcpLiveness: "not-checked", packagedMcpSocksGreetingOnly: true, packagedAgentDirectLoopback: "ok" };
  } catch {
    // Never surface raw MCP/process errors, which can contain descriptor fields.
    failure = new Error(`Packaged MCP verification failed during ${phase}`);
  } finally {
    let cleanedProcesses = false;
    let cleanupFailed = false;
    await bounded(client?.close() ?? Promise.resolve(), 7_000, "MCP client cleanup timed out").catch(() => {});
    await bounded(transport?.close() ?? Promise.resolve(), 7_000, "MCP transport cleanup timed out").catch(() => {});
    try {
      const left = await copiedProcesses(executables);
      if (left.length) assert.equal((await copiedProcesses(executables, { terminate: true })).length, 0, "Owned MCP processes survived cleanup");
      cleanedProcesses = true;
    } catch { cleanupFailed = true; }
    // A process inventory failure must not leave the local TCP fixture open.
    try { await listener?.close(); } catch { cleanupFailed = true; }
    try {
      assert(cleanedProcesses, "Cannot remove resources before owned process cleanup");
      const actual = await realpath(fixture);
      assert(within(fixtureHome, actual) && dirname(actual) === fixtureHome && basename(actual).startsWith("packaged-mcp-")
        && !(await lstat(fixture)).isSymbolicLink(), "Unsafe MCP fixture cleanup path");
      await plainTree(actual);
      await rm(actual, { recursive: true, force: true });
    } catch { cleanupFailed = true; }
    if (cleanupFailed) failure = new Error("Packaged MCP fixture cleanup failed");
  }
  if (privateDiagnostics) failure = new Error("Packaged MCP diagnostics exposed a runtime capability");
  if (failure) throw failure;
  return outcome;
}
