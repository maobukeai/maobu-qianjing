import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { argumentsMap, assertRegularFile, installerName, releaseVersion, sha256, validateProjectVersions } from "./release-utils.mjs";

const manifestName = "CANDIDATE-BUILD.json";
const sumsName = "SHA256SUMS.txt";
const notices = ["LICENSE", "NOTICE"];
const installerLimit = 512 * 1024 * 1024;
const sourceHashPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error("Cannot identify candidate sources in the Git checkout");
  return result.stdout;
}

async function info(path) {
  try { return await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function insideProject(root, requested) {
  const directory = resolve(root, requested);
  const suffix = relative(root, directory);
  if (!suffix || isAbsolute(suffix) || suffix.split(sep)[0] === "..") throw new Error("Candidate output must stay inside the project directory");
  let current = root;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    const metadata = await info(current);
    if (metadata && (!metadata.isDirectory() || relative(current, await realpath(current)) !== "")) {
      throw new Error("Candidate output must use ordinary directories inside the checkout");
    }
  }
  return directory;
}

/** Fingerprint the working sources rather than treating the current Git commit as the built tree. */
export async function captureCandidateSource(projectDirectory) {
  const root = await realpath(projectDirectory);
  const version = validateProjectVersions(root);
  const gitCommit = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!commitPattern.test(gitCommit)) throw new Error("Cannot identify the candidate's source commit");
  const sourceDirty = git(root, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"]).length > 0;
  const trackedPaths = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0");
  const paths = [...new Set(trackedPaths.filter(Boolean))].sort();
  const records = [];
  for (let start = 0; start < paths.length; start += 32) {
    const batch = paths.slice(start, start + 32);
    records.push(...await Promise.all(batch.map(async name => {
      const path = resolve(root, name);
      const metadata = await info(path);
      if (!metadata) return [name, "missing"];
      if (metadata.isSymbolicLink()) return [name, "link", await readlink(path)];
      if (!metadata.isFile() || relative(path, await realpath(path)) !== "") {
        throw new Error("Candidate source inventory contains a special file or a linked directory");
      }
      return [name, "file", await sha256(path)];
    })));
  }
  const sourceFingerprint = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  return { version, gitCommit, sourceDirty, sourceFingerprint };
}

function validateCandidate(metadata, expectedVersion) {
  const version = releaseVersion(metadata?.version);
  if ((expectedVersion && version !== expectedVersion) || metadata.artifact !== installerName(version)
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > installerLimit
    || typeof metadata.sha256 !== "string" || !sourceHashPattern.test(metadata.sha256)
    || typeof metadata.sourceFingerprint !== "string" || !sourceHashPattern.test(metadata.sourceFingerprint)
    || typeof metadata.gitCommit !== "string" || !commitPattern.test(metadata.gitCommit) || typeof metadata.sourceDirty !== "boolean"
    || metadata.signed !== false || metadata.updaterSigned !== false || metadata.authenticodeVerified !== false
    || !["on-demand", "bundled-firefox"].includes(metadata.browserEngines)
    || typeof metadata.builtAt !== "string" || !Number.isFinite(Date.parse(metadata.builtAt))) {
    throw new Error("Invalid unsigned candidate metadata");
  }
  return metadata;
}

/** Inspect the PE headers without invoking Windows trust services or loading the installer. */
async function assertUnsignedPe(path, size) {
  const invalid = () => new Error("Candidate installer must contain a valid Windows PE executable header");
  const file = await open(path, "r");
  try {
    async function readHeader(offset, length) {
      if (offset + length > size) throw invalid();
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw invalid();
      return buffer;
    }
    const dos = await readHeader(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw invalid();
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < dos.length) throw invalid();

    const coff = await readHeader(peOffset, 24);
    const sections = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const characteristics = coff.readUInt16LE(22);
    if (coff.readUInt32LE(0) !== 0x00004550 || !sections
      || !(characteristics & 0x0002) || (characteristics & 0x2000) || optionalSize < 2
      || peOffset + coff.length + optionalSize + sections * 40 > size) throw invalid();

    const optional = await readHeader(peOffset + coff.length, optionalSize);
    const magic = optional.readUInt16LE(0);
    // An x64 package can have a 32-bit NSIS launcher. Both optional-header layouts are valid.
    const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directoriesOffset || optional.length < directoriesOffset) throw invalid();
    const directories = optional.readUInt32LE(directoriesOffset - 4);
    if (directories * 8 > optional.length - directoriesOffset) throw invalid();
    const securityDirectory = directoriesOffset + 4 * 8;
    if (directories > 4 && (optional.readUInt32LE(securityDirectory) || optional.readUInt32LE(securityDirectory + 4))) {
      throw new Error("Unsigned candidate installer contains an embedded Authenticode certificate table");
    }
  } finally {
    await file.close();
  }
}

/** @param {{ assetsDirectory: string, version?: string, projectDirectory?: string }} options */
export async function verifyCandidateBuild({ assetsDirectory, version, projectDirectory }) {
  const directory = resolve(assetsDirectory);
  if (!(await info(directory))?.isDirectory() || relative(directory, await realpath(directory)) !== "") {
    throw new Error("Candidate assets require an ordinary directory");
  }
  function file(name, limit) {
    const path = join(directory, name);
    const metadata = assertRegularFile(path, limit);
    if (metadata.nlink !== 1) throw new Error("Candidate assets must not be hard links");
    return { path, metadata };
  }
  const manifestPath = file(manifestName, 16 * 1024).path;
  const candidate = validateCandidate(JSON.parse(await readFile(manifestPath, "utf8")), version);
  const installer = file(candidate.artifact, installerLimit);
  const sums = await readFile(file(sumsName, 4096).path, "utf8");
  const checksum = await sha256(installer.path);
  const otherSums = await Promise.all([...notices, manifestName].map(async name => `${await sha256(file(name, 128 * 1024).path)}  ${name}`));
  if (installer.metadata.size !== candidate.bytes || checksum !== candidate.sha256
    || sums.replace(/\r\n/g, "\n").trimEnd() !== [`${checksum}  ${candidate.artifact}`, ...otherSums].join("\n")) {
    throw new Error("Candidate asset checksum or installer size does not match");
  }
  await assertUnsignedPe(installer.path, installer.metadata.size);
  if (projectDirectory) {
    const root = await realpath(projectDirectory);
    const source = await captureCandidateSource(root);
    if (Object.keys(source).some(key => source[key] !== candidate[key])) throw new Error("Candidate sources do not match this working tree");
    for (const notice of notices) {
      if (await sha256(join(root, notice)) !== await sha256(join(directory, notice))) throw new Error("Candidate legal notice does not match its source");
    }
  }
  return { ...candidate, output: directory, path: installer.path, candidateManifest: manifestPath };
}

export async function recordCandidateBuild({ projectDirectory, outputDirectory, installer, source, browserEngines }) {
  const root = await realpath(projectDirectory);
  const current = await captureCandidateSource(root);
  if (Object.keys(current).some(key => current[key] !== source?.[key])) throw new Error("Candidate sources changed during compilation. Rebuild the candidate from a stable working tree.");
  const output = await insideProject(root, outputDirectory);
  const installerInfo = assertRegularFile(installer, installerLimit);
  await mkdir(output, { recursive: true });
  if (relative(output, await realpath(output)) !== "") throw new Error("Candidate output is no longer inside the checkout");

  const lockPath = join(output, ".candidate-build.lock");
  const lock = await open(lockPath, "wx");
  let staging;
  const artifact = installerName(current.version);
  const fileNames = [artifact, sumsName, ...notices, manifestName];
  try {
    for (const name of fileNames) {
      const existing = await info(join(output, name));
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error("Candidate output contains a linked or special asset");
    }
    staging = await mkdtemp(join(output, ".candidate-"));
    const stagedInstaller = join(staging, artifact);
    await copyFile(installer, stagedInstaller, constants.COPYFILE_EXCL);
    const candidate = validateCandidate({
      ...current, artifact, bytes: installerInfo.size, sha256: await sha256(stagedInstaller),
      signed: false, updaterSigned: false, authenticodeVerified: false, browserEngines,
      builtAt: new Date().toISOString(),
      signingNote: "Unsigned release candidate for local acceptance. Use the signed release builder for distribution.",
    });
    for (const notice of notices) await copyFile(join(root, notice), join(staging, notice), constants.COPYFILE_EXCL);
    const stagedManifest = join(staging, manifestName);
    const manifest = await open(stagedManifest, "wx");
    try { await manifest.writeFile(`${JSON.stringify(candidate, null, 2)}\n`); } finally { await manifest.close(); }
    const otherSums = await Promise.all([...notices, manifestName].map(async name => `${await sha256(join(staging, name))}  ${name}`));
    const sums = await open(join(staging, sumsName), "wx");
    try { await sums.writeFile(`${[`${candidate.sha256}  ${artifact}`, ...otherSums].join("\n")}\n`); } finally { await sums.close(); }
    await verifyCandidateBuild({ assetsDirectory: staging, version: current.version });
    // Publish the manifest last so readers cannot accept a partially replaced candidate.
    for (const name of fileNames) await rename(join(staging, name), join(output, name));
    return { ...candidate, output, path: join(output, artifact), candidateManifest: join(output, manifestName) };
  } finally {
    try {
      if (staging && dirname(staging) === output && relative(staging, await realpath(staging)) === "") {
        for (const name of fileNames) {
          const path = join(staging, name);
          if (await info(path)) await unlink(path);
        }
        await rmdir(staging);
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    const options = argumentsMap(argv, ["--project", "--output", "--installer", "--source", "--browser-engines", "--assets-dir", "--version"]);
    let result;
    if (command === "source" && options["--project"]) {
      if (options["--output"]) await insideProject(await realpath(options["--project"]), options["--output"]);
      result = await captureCandidateSource(options["--project"]);
    } else if (command === "record" && options["--project"] && options["--output"] && options["--installer"] && options["--source"]) {
      result = await recordCandidateBuild({
        projectDirectory: options["--project"], outputDirectory: options["--output"], installer: options["--installer"],
        source: JSON.parse(await readFile(options["--source"], "utf8")), browserEngines: options["--browser-engines"],
      });
    } else if (command === "verify" && options["--assets-dir"]) {
      result = await verifyCandidateBuild({
        assetsDirectory: options["--assets-dir"], version: options["--version"], projectDirectory: options["--project"],
      });
    } else {
      throw new Error("Use source --project, record --project --output --installer --source --browser-engines, or verify --assets-dir");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Candidate build check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
