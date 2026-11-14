import { createHash, randomBytes } from "node:crypto";
import { createReadStream, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function releaseVersion(value) {
  if (typeof value !== "string" || value.length > 100 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.test(value)) throw new Error("A valid semantic release version without a leading v is required");
  const pre = value.split("+")[0].split("-").slice(1).join("-");
  if (pre.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("Invalid semantic prerelease version");
  return value;
}
export function releaseRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(value) || [".", ".."].includes(value.split("/")[1])) throw new Error("A GitHub owner/repository is required");
  return value;
}
export function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("A valid HTTPS publisher URL is required"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("Publisher URLs must use HTTPS without credentials, queries, or fragments");
  return url.href;
}
export function decodeBase64(value, maximum = 16 * 1024) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error("Invalid Tauri base64 data");
  const bytes = Buffer.from(value.trim(), "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.trim().replace(/=+$/, "")) throw new Error("Invalid Tauri base64 data");
  return bytes;
}
export function publicKey(value) {
  const text = decodeBase64(value, 4096).toString("utf8").trim();
  const lines = text.split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) throw new Error("A Tauri-generated public key is required");
  const bytes = decodeBase64(lines[1]);
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("ascii") !== "Ed") throw new Error("Invalid Tauri public key");
  return value.trim();
}
export function validatePublisherEnvironment(environment, { requirePrivateKey = false } = {}) {
  if (!environment.MAOBU_UPDATE_PUBLIC_KEY || !environment.MAOBU_UPDATE_ENDPOINT) throw new Error("MAOBU_UPDATE_PUBLIC_KEY and MAOBU_UPDATE_ENDPOINT must both be configured. No production key is generated automatically.");
  const key = publicKey(environment.MAOBU_UPDATE_PUBLIC_KEY), endpoint = httpsUrl(environment.MAOBU_UPDATE_ENDPOINT);
  if (requirePrivateKey && !environment.TAURI_SIGNING_PRIVATE_KEY) throw new Error("TAURI_SIGNING_PRIVATE_KEY is required to build a signed release. Configure the publisher secret before running this workflow.");
  return { publicKey: key, endpoint };
}
export function validateProjectVersions(root, expected) {
  const read = path => readFileSync(resolve(root, path), "utf8");
  const current = read("version.ts").match(/ALIASMODE_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const version = releaseVersion(expected ?? current);
  const entries = {
    "version.ts": current,
    "package.json": JSON.parse(read("package.json")).version,
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
    "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"$/m)?.[1],
    "src-tauri/Cargo.lock": read("src-tauri/Cargo.lock").match(/name = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1],
    "agent/runtime-client.mjs": read("agent/runtime-client.mjs").match(/RUNTIME_VERSION\s*=\s*(?:process\.env\.ALIASMODE_APP_VERSION\s*\|\|\s*)?"([^"]+)"/)?.[1],
  };
  for (const [path, value] of Object.entries(entries)) if (value !== version) throw new Error(`Release version mismatch in ${path}; update all app and helper versions before building`);
  return version;
}
export function assertRegularFile(path, maximum = 2 * 1024 ** 3) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum) throw new Error("Release assets must be nonempty regular files within the size limit");
  return stat;
}
export async function sha256(path) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
export function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Release output must not be a linked or special file");
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function installerName(version) { return `MaobuBrowser_${releaseVersion(version)}_x64-setup.exe`; }
export function artifactSignature(value, fileName) {
  const text = decodeBase64(value).toString("utf8");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment: ") || !lines[2].startsWith("trusted comment: ") || decodeBase64(lines[1]).length !== 74 || decodeBase64(lines[3]).length !== 64) throw new Error("Invalid Tauri artifact signature format");
  const files = lines[2].slice("trusted comment: ".length).split("\t").filter(field => field.startsWith("file:"));
  if (files.length !== 1 || files[0] !== `file:${fileName}`) throw new Error("The signed trusted filename does not match this release artifact");
  return value.trim();
}
export function argumentsMap(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]; if (!allowed.includes(name) || Object.hasOwn(result, name)) throw new Error("Unknown or duplicate release argument");
    const value = argv[++index]; if (!value || value.startsWith("--")) throw new Error(`A value is required for ${name}`); result[name] = value;
  }
  return result;
}
