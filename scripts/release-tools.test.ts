import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { signedBuildConfig } from "./release-config.mjs";
import { artifactSignature, installerName, publicKey, releaseRepository, releaseVersion, validateProjectVersions } from "./release-utils.mjs";
import { generateReleaseManifest, selectReleaseUploadFiles, validateReleaseManifest, verifyReleaseManifest } from "./release-manifest.mjs";
const roots: string[] = [], parent = resolve(import.meta.dir, "..", "node_modules", ".cache", "release-tools-tests");
afterEach(() => { for (const path of roots.splice(0)) { if (!path.startsWith(parent + sep)) throw new Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); } });
function fixture() { mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, "case-")); roots.push(root); return root; }
function key() { const bytes = Buffer.alloc(42, 1); bytes.write("Ed"); return Buffer.from(`untrusted comment: test-only public fixture\n${bytes.toString("base64")}\n`).toString("base64"); }
function signature(fileName: string) { return Buffer.from(`untrusted comment: structural fixture only\n${Buffer.alloc(74, 1).toString("base64")}\ntrusted comment: timestamp:1\tfile:${fileName}\n${Buffer.alloc(64, 1).toString("base64")}\n`).toString("base64"); }
function environment() { return { MAOBU_UPDATE_PUBLIC_KEY: key(), MAOBU_UPDATE_ENDPOINT: "https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json" }; }

describe("publisher release tooling", () => {
  test("ordinary builds remain unsigned until a publisher is explicitly configured", () => {
    expect(() => signedBuildConfig({})).toThrow("must both be configured"); expect(() => signedBuildConfig({ MAOBU_UPDATE_PUBLIC_KEY: key() })).toThrow();
    expect(() => signedBuildConfig(environment(), { requirePrivateKey: true })).toThrow("TAURI_SIGNING_PRIVATE_KEY");
    const config = signedBuildConfig({ ...environment(), TAURI_SIGNING_PRIVATE_KEY: "test-secret-never-written" }, { requirePrivateKey: true });
    expect(config.bundle.createUpdaterArtifacts).toBe(true); expect(config.plugins.updater.pubkey).toBe(key()); expect(JSON.stringify(config)).not.toContain("test-secret-never-written");
    expect(config.bundle.windows).toBeUndefined();
  });
  test("Windows signing is opt-in and configures the installed certificate and timestamp for Tauri", () => {
    const publisher = { ...environment(), MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT: `\u200e${"ab cd ".repeat(10)}`, MAOBU_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test/rfc3161" };
    expect(signedBuildConfig(publisher).bundle.windows).toEqual({
      certificateThumbprint: "ABCD".repeat(10), digestAlgorithm: "sha256", timestampUrl: publisher.MAOBU_WINDOWS_TIMESTAMP_URL, tsp: true,
    });
    const legacy = signedBuildConfig({ ...publisher, MAOBU_WINDOWS_TIMESTAMP_URL: "http://timestamp.example.test/legacy", MAOBU_WINDOWS_TIMESTAMP_PROTOCOL: "authenticode" });
    expect(legacy.bundle.windows?.timestampUrl).toBe("http://timestamp.example.test/legacy");
    expect(legacy.bundle.windows?.tsp).toBe(false);
  });
  test("Windows signing rejects incomplete settings and keeps endpoint secrets out of errors", () => {
    const thumbprint = "ABCD".repeat(10), timestamp = "https://timestamp.example.test/rfc3161";
    expect(() => signedBuildConfig({ ...environment(), MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint })).toThrow("must both be configured");
    expect(() => signedBuildConfig({ ...environment(), MAOBU_WINDOWS_TIMESTAMP_URL: timestamp })).toThrow("must both be configured");
    expect(() => signedBuildConfig({ ...environment(), MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT: "invalid", MAOBU_WINDOWS_TIMESTAMP_URL: timestamp })).toThrow("40-digit hexadecimal");
    expect(() => signedBuildConfig({ ...environment(), MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint, MAOBU_WINDOWS_TIMESTAMP_URL: timestamp, MAOBU_WINDOWS_TIMESTAMP_PROTOCOL: "invalid" })).toThrow("rfc3161 or authenticode");
    for (const url of ["ftp://timestamp.example.test", "https://person:private-secret@timestamp.example.test", "https://timestamp.example.test?token=private-secret", "https://timestamp.example.test#private-secret"]) {
      expect(() => signedBuildConfig({ ...environment(), MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint, MAOBU_WINDOWS_TIMESTAMP_URL: url })).toThrow("The Windows timestamp URL must use HTTP or HTTPS without credentials, a query, or a fragment");
    }
  });
  test("publisher sources and public keys reject insecure URLs or credential-bearing endpoints", () => {
    for (const endpoint of ["http://example.com/latest.json", "https://user:private-secret@example.com/latest.json", "https://example.com/latest.json?token=private-secret", "file:///tmp/latest.json"]) {
      let text = ""; try { signedBuildConfig({ ...environment(), MAOBU_UPDATE_ENDPOINT: endpoint }); } catch (error) { text = (error as Error).message; } expect(text).not.toContain("private-secret"); expect(text).not.toBe("");
    }
    for (const invalid of ["not-a-key", Buffer.from("secret private key").toString("base64"), key().slice(0, -7)]) expect(() => publicKey(invalid)).toThrow();
  });
  test("release identities use semantic versions and all six source versions must agree", () => {
    expect(validateProjectVersions(resolve(import.meta.dir, ".."))).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => validateProjectVersions(resolve(import.meta.dir, ".."), "99.0.0")).toThrow("mismatch");
    for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-beta.01", "1.0.0/escape"]) expect(() => releaseVersion(version)).toThrow();
    for (const repository of ["https://github.com/a/b", "a/../b", "a/b?token=x", "a/.."]) expect(() => releaseRepository(repository)).toThrow();
  });
  test("manifest generation preserves official signature content and emits reproducible checksums", async () => {
    const root = fixture(), version = "1.2.3-beta.1", name = installerName(version), sig = signature(name);
    writeFileSync(join(root, name), "Inert installer fixture: never executed"); writeFileSync(join(root, `${name}.sig`), sig);
    const result = await generateReleaseManifest({ assetsDirectory: root, repository: "maobukeai/maobu-qianjing", version, notes: "Changes", publishedAt: "2026-11-09T00:00:00.000Z" });
    expect(result.manifest.platforms["windows-x86_64"].signature).toBe(sig);
    expect((await verifyReleaseManifest({ assetsDirectory: root, repository: "maobukeai/maobu-qianjing", version })).version).toBe(version);
    expect(readFileSync(join(root, "SHA256SUMS.txt"), "utf8").trim().split("\n")).toHaveLength(3);
    writeFileSync(join(root, name), "tampered bytes"); await expect(verifyReleaseManifest({ assetsDirectory: root, repository: "maobukeai/maobu-qianjing", version })).rejects.toThrow("checksum");
  });
  test("a manifest cannot pair an inflated version with a trusted signature for an older file", async () => {
    const root = fixture(), version = "1.2.3", name = installerName(version); writeFileSync(join(root, name), "inert fixture"); writeFileSync(join(root, `${name}.sig`), signature(name));
    const { manifest } = await generateReleaseManifest({ assetsDirectory: root, repository: "maobukeai/maobu-qianjing", version });
    expect(() => artifactSignature(manifest.platforms["windows-x86_64"].signature, installerName("9.9.9"))).toThrow("trusted filename");
    for (const url of ["https://evil.example/package.exe", "http://github.com/maobukeai/maobu-qianjing/release.exe"]) expect(() => validateReleaseManifest({ ...manifest, platforms: { "windows-x86_64": { ...manifest.platforms["windows-x86_64"], url } } }, { repository: "maobukeai/maobu-qianjing", version })).toThrow();
    expect(() => validateReleaseManifest({ ...manifest, pub_date: "2026-11-09T00:00:00" }, { repository: "maobukeai/maobu-qianjing", version })).toThrow("metadata");
  });
  test("release selection exposes exactly the six checked upload paths and leaves extra files in place", async () => {
    const root = fixture(), version = "1.2.3-beta.1+build.4", name = installerName(version), repository = "fixture/browser";
    const options = { assetsDirectory: root, version, repository };
    writeFileSync(join(root, name), "Inert installer fixture");
    writeFileSync(join(root, `${name}.sig`), signature(name));
    await generateReleaseManifest(options);
    writeFileSync(join(root, "LICENSE"), "Fixture license");
    await expect(selectReleaseUploadFiles(options)).rejects.toThrow("NOTICE");
    writeFileSync(join(root, "NOTICE"), "Fixture notice");
    const extra = join(root, "unexpected-build-log.txt");
    writeFileSync(extra, "Unselected fixture content");
    const files = [name, `${name}.sig`, "latest.json", "SHA256SUMS.txt", "LICENSE", "NOTICE"].map(file => join(root, file));
    expect(await selectReleaseUploadFiles(options)).toEqual(files);
    const cli = Bun.spawnSync(["node", resolve(import.meta.dir, "release-manifest.mjs"), "--assets-dir", root, "--repository", repository, "--version", version, "--list-assets", "true"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect({ code: cli.exitCode, stderr: cli.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(cli.stdout.toString())).toEqual({ files });
    expect(readFileSync(extra, "utf8")).toBe("Unselected fixture content");
    writeFileSync(join(root, name), "Tampered installer fixture");
    await expect(selectReleaseUploadFiles(options)).rejects.toThrow("checksum");
  });
  test("release selection rejects links and non-file entries for required assets", async () => {
    const root = fixture(), version = "1.2.3", name = installerName(version), repository = "fixture/browser";
    const options = { assetsDirectory: root, version, repository };
    writeFileSync(join(root, name), "Inert installer fixture");
    writeFileSync(join(root, `${name}.sig`), signature(name));
    await generateReleaseManifest(options);
    writeFileSync(join(root, "LICENSE"), "Fixture license");
    const notice = join(root, "NOTICE"), outside = fixture(), linkedRoot = join(outside, "linked-assets");
    linkSync(join(root, "LICENSE"), notice);
    await expect(selectReleaseUploadFiles(options)).rejects.toThrow("hard links");
    unlinkSync(notice);
    mkdirSync(notice);
    await expect(selectReleaseUploadFiles(options)).rejects.toThrow("regular files");
    symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(selectReleaseUploadFiles({ ...options, assetsDirectory: linkedRoot })).rejects.toThrow("unlinked directory");
  });
});
