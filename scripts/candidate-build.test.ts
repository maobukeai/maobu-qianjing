import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { captureCandidateSource, recordCandidateBuild, verifyCandidateBuild } from "./candidate-build.mjs";

const version = "1.2.3";
const versionFiles = {
  "version.ts": `export const ALIASMODE_VERSION = "${version}";\n`,
  "package.json": JSON.stringify({ version }),
  "src-tauri/tauri.conf.json": JSON.stringify({ version }),
  "src-tauri/Cargo.toml": `[package]\nname = "aliasmode-desktop"\nversion = "${version}"\n`,
  "src-tauri/Cargo.lock": `[[package]]\nname = "aliasmode-desktop"\nversion = "${version}"\n`,
  "agent/runtime-client.mjs": `const RUNTIME_VERSION = "${version}";\n`,
};
const testParent = resolve(import.meta.dir, "..", "node_modules", ".cache", "candidate-build-tests");
const testDirectories: string[] = [];

function installerFixture(format: "PE32" | "PE32+" = "PE32", embeddedCertificate = false) {
  const peOffset = 64;
  const optionalOffset = peOffset + 24;
  const is64Bit = format === "PE32+";
  const optionalSize = is64Bit ? 240 : 224;
  const directoriesOffset = optionalOffset + (is64Bit ? 112 : 96);
  const sectionTable = optionalOffset + optionalSize;
  // Header-only, non-runnable fixture. PE structure is checked without loading code.
  const bytes = Buffer.alloc(sectionTable + 40 + (embeddedCertificate ? 8 : 0));
  bytes.write("MZ", 0);
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset);
  bytes.writeUInt16LE(is64Bit ? 0x8664 : 0x14c, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6);
  bytes.writeUInt16LE(optionalSize, peOffset + 20);
  bytes.writeUInt16LE(0x0002, peOffset + 22);
  bytes.writeUInt16LE(is64Bit ? 0x20b : 0x10b, optionalOffset);
  bytes.writeUInt32LE(16, directoriesOffset - 4);
  if (embeddedCertificate) {
    const securityDirectory = directoriesOffset + 4 * 8;
    bytes.writeUInt32LE(sectionTable + 40, securityDirectory);
    bytes.writeUInt32LE(8, securityDirectory + 4);
  }
  return bytes;
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function makeFixture() {
  mkdirSync(testParent, { recursive: true });
  const root = mkdtempSync(join(testParent, "candidate-"));
  testDirectories.push(root);
  for (const [name, body] of Object.entries({
    ...versionFiles, ".gitignore": "dist/\n", "LICENSE": "Fixture license\n", "NOTICE": "Fixture notice\n",
  })) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--all"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Candidate fixture"]);
  const installer = join(root, "dist", "inert-build.exe");
  mkdirSync(dirname(installer));
  writeFileSync(installer, installerFixture());
  const options = {
    projectDirectory: root, outputDirectory: "dist/rc", installer,
    source: await captureCandidateSource(root), browserEngines: "on-demand",
  };
  return { root, installer, options };
}

afterEach(() => {
  const parent = realpathSync(testParent);
  for (const path of testDirectories.splice(0)) {
    const actual = realpathSync(path);
    if (relative(parent, dirname(actual)) !== "") throw new Error("Unsafe candidate test cleanup");
    rmSync(actual, { recursive: true, force: true });
  }
});

describe("unsigned candidate delivery", () => {
  test("fingerprints tracked and untracked sources, excludes ignored artifacts, and preserves the Git base commit", async () => {
    const { root, installer, options } = await makeFixture();
    expect(options.source.sourceDirty).toBe(false);
    writeFileSync(installer, "A different ignored build product");
    expect(await captureCandidateSource(root)).toEqual(options.source);
    writeFileSync(join(root, "new source.ts"), "const value = 1;\n");
    const modified = await captureCandidateSource(root);
    expect(modified.gitCommit).toBe(options.source.gitCommit);
    expect(modified.sourceDirty).toBe(true);
    expect(modified.sourceFingerprint).not.toBe(options.source.sourceFingerprint);
    writeFileSync(join(root, "new source.ts"), "const value = 2;\n");
    expect((await captureCandidateSource(root)).sourceFingerprint).not.toBe(modified.sourceFingerprint);
    writeFileSync(join(root, "NOTICE"), "Changed tracked source.");
    expect((await captureCandidateSource(root)).sourceFingerprint).not.toBe(modified.sourceFingerprint);
  });

  test("records a candidate from a dirty tree and verifies the five files from an independent invocation", async () => {
    const { root, options } = await makeFixture();
    writeFileSync(join(root, "local source.ts"), "const candidate = true;\n");
    const source = await captureCandidateSource(root);
    const record = await recordCandidateBuild({ ...options, source, browserEngines: "bundled-firefox" });
    expect(record).toMatchObject({ version, sourceDirty: true, signed: false, browserEngines: "bundled-firefox" });
    expect(await verifyCandidateBuild({ assetsDirectory: record.output, projectDirectory: root })).toEqual(record);
    const checked = Bun.spawnSync([
      "node", join(import.meta.dir, "candidate-build.mjs"), "verify", "--assets-dir", record.output, "--version", version,
    ], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(checked.stderr.toString()).toBe("");
    expect(JSON.parse(checked.stdout.toString())).toEqual(record);
    expect(readFileSync(join(record.output, "SHA256SUMS.txt"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  test("rejects a source change before publishing and reports an existing candidate's source mismatch", async () => {
    const { root, options } = await makeFixture();
    const record = await recordCandidateBuild(options);
    writeFileSync(join(root, "source changed during build.ts"), "const changed = true;\n");
    await expect(recordCandidateBuild(options)).rejects.toThrow("sources changed during compilation");
    expect(await verifyCandidateBuild({ assetsDirectory: record.output })).toEqual(record);
    await expect(verifyCandidateBuild({ assetsDirectory: record.output, projectDirectory: root })).rejects.toThrow("sources do not match");
  });

  test("fails verification if package bytes, legal notices, or provenance metadata drift", async () => {
    const { options } = await makeFixture();
    const record = await recordCandidateBuild(options);
    for (const path of [record.path, join(record.output, "LICENSE"), record.candidateManifest]) {
      const original = readFileSync(path);
      writeFileSync(path, path === record.candidateManifest
        ? JSON.stringify({ ...JSON.parse(original.toString()), sourceDirty: true })
        : Buffer.concat([original, Buffer.from("tampered")]));
      await expect(verifyCandidateBuild({ assetsDirectory: record.output })).rejects.toThrow("checksum");
      writeFileSync(path, original);
    }
    await expect(verifyCandidateBuild({ assetsDirectory: record.output, version: "9.0.0" })).rejects.toThrow("metadata");
  });

  test("accepts an unsigned PE32+ header alongside the NSIS PE32 fixture", async () => {
    const { installer, options } = await makeFixture();
    writeFileSync(installer, installerFixture("PE32+"));
    const record = await recordCandidateBuild(options);
    expect(await verifyCandidateBuild({ assetsDirectory: record.output })).toEqual(record);
  });

  test("does not publish text, a truncated header, or an input with an embedded certificate table", async () => {
    const { root, installer, options } = await makeFixture();
    for (const { bytes, message } of [
      { bytes: Buffer.from("Non-PE fixture"), message: "Windows PE executable" },
      { bytes: installerFixture().subarray(0, 130), message: "Windows PE executable" },
      { bytes: installerFixture("PE32", true), message: "embedded Authenticode certificate table" },
    ]) {
      writeFileSync(installer, bytes);
      await expect(recordCandidateBuild(options)).rejects.toThrow(message);
      expect(existsSync(join(root, "dist", "rc", "CANDIDATE-BUILD.json"))).toBe(false);
    }
  });

  test("offline verification checks for an embedded certificate table even when the candidate checksums agree", async () => {
    const { options } = await makeFixture();
    const record = await recordCandidateBuild(options);
    const bytes = installerFixture("PE32+", true);
    writeFileSync(record.path, bytes);
    const manifest = JSON.parse(readFileSync(record.candidateManifest, "utf8"));
    manifest.bytes = bytes.length;
    manifest.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(record.candidateManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const sums = [record.artifact, "LICENSE", "NOTICE", "CANDIDATE-BUILD.json"].map(name => {
      const hash = createHash("sha256").update(readFileSync(join(record.output, name))).digest("hex");
      return `${hash}  ${name}`;
    });
    writeFileSync(join(record.output, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
    await expect(verifyCandidateBuild({ assetsDirectory: record.output })).rejects.toThrow("embedded Authenticode certificate table");
  });

  test("refuses concurrent writes, directory links, and linked candidate assets", async () => {
    const { root, installer, options } = await makeFixture();
    const record = await recordCandidateBuild(options);
    writeFileSync(join(record.output, ".candidate-build.lock"), "Other build");
    await expect(recordCandidateBuild(options)).rejects.toThrow("EEXIST");
    expect(await verifyCandidateBuild({ assetsDirectory: record.output })).toEqual(record);
    const linked = join(root, "dist", "linked");
    symlinkSync(record.output, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(recordCandidateBuild({ ...options, outputDirectory: linked })).rejects.toThrow("ordinary directories");
    await expect(recordCandidateBuild({ ...options, outputDirectory: "../escape" })).rejects.toThrow("inside the project");
    rmSync(record.path);
    linkSync(installer, record.path);
    await expect(verifyCandidateBuild({ assetsDirectory: record.output })).rejects.toThrow("hard links");
  });
});
