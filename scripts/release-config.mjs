import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argumentsMap, validateProjectVersions, validatePublisherEnvironment, writeAtomic } from "./release-utils.mjs";

function windowsSigningConfig(environment) {
  const thumbprint = (environment.MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT ?? "").trim();
  const timestamp = (environment.MAOBU_WINDOWS_TIMESTAMP_URL ?? "").trim();
  const protocol = (environment.MAOBU_WINDOWS_TIMESTAMP_PROTOCOL ?? "").trim().toLowerCase();
  if (!thumbprint && !timestamp && !protocol) return undefined;
  if (!thumbprint || !timestamp) throw new Error("MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT and MAOBU_WINDOWS_TIMESTAMP_URL must both be configured for Windows code signing");

  // Certificate Manager can copy a left-to-right mark and spaces into a thumbprint.
  const certificateThumbprint = thumbprint.replace(/[\s\u200e]/gu, "").toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(certificateThumbprint)) throw new Error("The Windows code-signing certificate thumbprint must be a 40-digit hexadecimal SHA-1 thumbprint");
  if (protocol && protocol !== "rfc3161" && protocol !== "authenticode") throw new Error("MAOBU_WINDOWS_TIMESTAMP_PROTOCOL must be rfc3161 or authenticode");

  const invalidTimestamp = () => new Error("The Windows timestamp URL must use HTTP or HTTPS without credentials, a query, or a fragment");
  if (!/^https?:\/\//i.test(timestamp) || /[\x00-\x20\x7f\\?#]/u.test(timestamp)) throw invalidTimestamp();
  let url;
  try { url = new URL(timestamp); } catch { throw invalidTimestamp(); }
  if (!url.hostname || url.username || url.password) throw invalidTimestamp();
  return { certificateThumbprint, digestAlgorithm: "sha256", timestampUrl: url.href, tsp: protocol !== "authenticode" };
}

export function signedBuildConfig(environment, options = {}) {
  const publisher = validatePublisherEnvironment(environment, options);
  const windows = windowsSigningConfig(environment);
  return { bundle: { createUpdaterArtifacts: true, ...(windows ? { windows } : {}) }, plugins: { updater: { pubkey: publisher.publicKey, endpoints: [publisher.endpoint], windows: { installMode: "passive" } } } };
}
export function prepareSignedBuild({ root = resolve(fileURLToPath(new URL("..", import.meta.url))), output, version, environment = process.env, requirePrivateKey = false } = {}) {
  const release = validateProjectVersions(root, version);
  const configuration = signedBuildConfig(environment, { requirePrivateKey });
  const target = resolve(root, output ?? "node_modules/.cache/release/tauri.signed.conf.json");
  writeAtomic(target, `${JSON.stringify(configuration, null, 2)}\n`);
  return { version: release, configurationPath: target };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsMap(process.argv.slice(2), ["--output", "--version", "--require-private-key"]);
    const result = prepareSignedBuild({ output: args["--output"], version: args["--version"], requirePrivateKey: args["--require-private-key"] === "true" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`Signed release configuration failed: ${error instanceof Error ? error.message : "invalid configuration"}\n`); process.exitCode = 1; }
}
