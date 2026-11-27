/** A verified Firefox installation created only when a local profile is opened. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { firefoxBuildForHost, firefoxInstallDirectoryPrefix, installFirefox, type FirefoxRuntimeBuild } from "./firefox-install.ts";
import { sha256File } from "./browser-install.ts";

const installations = new Map<string, Promise<string>>();
export const FIREFOX_MANAGED_RECORD = "installed.json";

export function firefoxManagedDirectory(platform: NodeJS.Platform, arch: string): string {
  return `firefox-${platform}-${arch}-managed`;
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

export async function ensureManagedFirefox(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  dependencies: {
    build?: FirefoxRuntimeBuild;
    install?: typeof installFirefox;
  } = {},
): Promise<string> {
  const build = dependencies.build ?? firefoxBuildForHost(platform, arch);
  const root = resolve(runtimeRoot, firefoxManagedDirectory(platform, arch));
  const key = `${root}:${build.executableSha256}`;
  const pending = installations.get(key);
  if (pending) return pending;
  const installation = (async () => {
    mkdirSync(resolve(runtimeRoot), { recursive: true });
    const canonicalParent = realpathSync(resolve(runtimeRoot));
    mkdirSync(root, { recursive: true });
    const canonicalRoot = realpathSync(root);
    if (!contained(canonicalParent, canonicalRoot)) throw new Error("Firefox managed directory escaped its runtime root");
    const metadata = join(canonicalRoot, FIREFOX_MANAGED_RECORD);
    const verify = async (path: string): Promise<string> => {
      const canonical = realpathSync(path);
      if (!contained(canonicalRoot, canonical)) throw new Error("Firefox executable escaped its managed directory");
      if (!statSync(canonical).isFile()) throw new Error("Managed Firefox executable is not a regular file");
      if (await sha256File(canonical) !== build.executableSha256) throw new Error("Managed Firefox SHA-256 mismatch");
      return canonical;
    };
    if (existsSync(metadata)) {
      try {
        const saved = JSON.parse(readFileSync(metadata, "utf8"));
        if (saved.sha256 === build.executableSha256 && typeof saved.path === "string" && !isAbsolute(saved.path)) {
          return await verify(join(canonicalRoot, saved.path));
        }
      } catch { /* A damaged cache is replaced only by a newly verified install. */ }
    }
    const installed = await (dependencies.install ?? installFirefox)({ cwd: canonicalRoot, platform, arch, writeEnv: false });
    const executable = await verify(installed.path);
    if (installed.sha256 !== build.executableSha256) throw new Error("Installed Firefox approval does not match its pinned build");
    const temporary = `${metadata}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ path: relative(canonicalRoot, executable), sha256: build.executableSha256 }), { mode: 0o600 });
    renameSync(temporary, metadata);
    return executable;
  })();
  installations.set(key, installation);
  try { return await installation; }
  finally { installations.delete(key); }
}

/**
 * Remove Firefox installs left by earlier pinned builds. Each install gets its own folder under
 * `<managed>/browser/`, so upgrades otherwise keep every old copy. The folder named by
 * installed.json stays, as does any folder holding one of `inUse` (a live browser's executable)
 * and any install still running. Without a readable record nothing is removed.
 */
export function pruneManagedFirefoxRuntimes(
  runtimeRoot: string,
  inUse: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (installations.size > 0) return;
  let canonicalRoot: string;
  let saved: { path?: unknown };
  try {
    canonicalRoot = realpathSync(resolve(runtimeRoot, firefoxManagedDirectory(platform, arch)));
    saved = JSON.parse(readFileSync(join(canonicalRoot, FIREFOX_MANAGED_RECORD), "utf8"));
  } catch {
    return;
  }
  if (typeof saved.path !== "string" || isAbsolute(saved.path)) return;
  const current = resolve(canonicalRoot, saved.path);
  if (!contained(canonicalRoot, current)) return;
  let cache: string;
  try { cache = realpathSync(join(canonicalRoot, "browser")); } catch { return; }
  if (!contained(canonicalRoot, cache)) return;
  let entries: string[];
  try { entries = readdirSync(cache); } catch { return; }
  const liveTargets = inUse.map((executable) => {
    const resolved = resolve(executable);
    try { return realpathSync(resolved); } catch { return resolved; }
  });
  const prefix = firefoxInstallDirectoryPrefix(platform, arch);
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(cache, entry);
    try {
      if (lstatSync(path).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (contained(path, current)) continue;
    if (liveTargets.some((executable) => contained(path, executable))) continue;
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
}
