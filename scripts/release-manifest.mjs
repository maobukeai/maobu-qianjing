import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argumentsMap, artifactSignature, assertRegularFile, httpsUrl, installerName, releaseRepository, releaseVersion, sha256, writeAtomic } from "./release-utils.mjs";

export function validateReleaseManifest(manifest, { repository, version }) {
  const expectedVersion = releaseVersion(version), repo = releaseRepository(repository), name = installerName(expectedVersion);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.version !== expectedVersion || typeof manifest.notes !== "string" || Buffer.byteLength(manifest.notes) > 128 * 1024 || typeof manifest.pub_date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.pub_date) || !Number.isFinite(Date.parse(manifest.pub_date))) throw new Error("Invalid signed release manifest metadata");
  if (!manifest.platforms || Object.keys(manifest.platforms).length !== 1 || !manifest.platforms["windows-x86_64"]) throw new Error("The release manifest must contain the supported Windows x64 target");
  const platform = manifest.platforms["windows-x86_64"];
  const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(`v${expectedVersion}`)}/${encodeURIComponent(name)}`;
  if (httpsUrl(platform.url) !== url) throw new Error("Release asset URL does not match this repository, version, and installer");
  artifactSignature(platform.signature, name);
  return manifest;
}
export async function generateReleaseManifest({ assetsDirectory, repository, version, notes = "", publishedAt = new Date().toISOString() }) {
  const directory = resolve(assetsDirectory), repo = releaseRepository(repository), release = releaseVersion(version), name = installerName(release);
  const installer = resolve(directory, name), signaturePath = `${installer}.sig`;
  assertRegularFile(installer); assertRegularFile(signaturePath, 16 * 1024);
  const signature = artifactSignature(readFileSync(signaturePath, "utf8"), name);
  const manifest = validateReleaseManifest({ version: release, notes, pub_date: publishedAt, platforms: { "windows-x86_64": { signature, url: `https://github.com/${repo}/releases/download/${encodeURIComponent(`v${release}`)}/${encodeURIComponent(name)}` } } }, { repository: repo, version: release });
  const output = resolve(directory, "latest.json"); writeAtomic(output, `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = await Promise.all([installer, signaturePath, output].map(async path => `${await sha256(path)}  ${basename(path)}`));
  writeAtomic(resolve(directory, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  return { manifest, files: [name, `${name}.sig`, "latest.json", "SHA256SUMS.txt"] };
}
export async function verifyReleaseManifest({ assetsDirectory, repository, version }) {
  const directory = resolve(assetsDirectory), manifestPath = resolve(directory, "latest.json"); assertRegularFile(manifestPath, 256 * 1024);
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")), { repository, version });
  const name = installerName(version), sumsPath = resolve(directory, "SHA256SUMS.txt"); assertRegularFile(sumsPath, 4096);
  const sums = readFileSync(sumsPath, "utf8").trim().split(/\r?\n/);
  const expectedFiles = [name, `${name}.sig`, "latest.json"];
  if (sums.length !== expectedFiles.length) throw new Error("Invalid release checksum file");
  for (const file of expectedFiles) {
    const path = resolve(directory, file); assertRegularFile(path);
    if (!sums.includes(`${await sha256(path)}  ${file}`)) throw new Error("Release asset checksum mismatch");
  }
  if (readFileSync(resolve(directory, `${name}.sig`), "utf8").trim() !== manifest.platforms["windows-x86_64"].signature) throw new Error("Manifest signature does not match the detached artifact signature");
  return manifest;
}

/** The Windows draft and CI artifact consume exactly this set after offline signature verification. */
export async function selectReleaseUploadFiles({ assetsDirectory, repository, version }) {
  const directory = resolve(assetsDirectory);
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(directory, realpathSync(directory)) !== "") {
    throw new Error("Release assets require an unlinked directory");
  }
  const name = installerName(version);
  const assets = [
    [name, 512 * 1024 * 1024], [`${name}.sig`, 16 * 1024],
    ["latest.json", 256 * 1024], ["SHA256SUMS.txt", 4096],
    ["LICENSE", 128 * 1024], ["NOTICE", 128 * 1024],
  ];
  const files = assets.map(([file, limit]) => {
    const path = resolve(directory, file);
    if (assertRegularFile(path, limit).nlink > 1) throw new Error("Release upload files must not be hard links");
    return path;
  });
  await verifyReleaseManifest({ assetsDirectory: directory, repository, version });
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsMap(process.argv.slice(2), ["--assets-dir", "--repository", "--version", "--notes-file", "--verify", "--list-assets"]);
    const options = { assetsDirectory: args["--assets-dir"], repository: args["--repository"], version: args["--version"] };
    if (!options.assetsDirectory) throw new Error("--assets-dir is required");
    if (args["--list-assets"] === "true") {
      const files = await selectReleaseUploadFiles(options);
      process.stdout.write(`${JSON.stringify({ files })}\n`);
    }
    else if (args["--verify"] === "true") { await verifyReleaseManifest(options); process.stdout.write("Release manifest and SHA-256 checks passed; run the offline signature verifier before publication.\n"); }
    else {
      if (args["--notes-file"]) { assertRegularFile(resolve(args["--notes-file"]), 128 * 1024); options.notes = readFileSync(resolve(args["--notes-file"]), "utf8"); }
      const result = await generateReleaseManifest(options); process.stdout.write(`${JSON.stringify({ version: result.manifest.version, files: result.files })}\n`);
    }
  } catch { process.stderr.write("Release manifest validation failed. Check the version, repository, installer, signature, and checksums.\n"); process.exitCode = 1; }
}
