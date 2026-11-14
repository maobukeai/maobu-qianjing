import { normalizeUpdateRepository, type UpdateChannel, type UpdateSettings } from "./app-settings.ts";
import { ALIASMODE_VERSION } from "./version.ts";

interface ParsedVersion { core: [number, number, number]; prerelease: string[] }
function parseVersion(value: string): ParsedVersion {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(value);
  if (!match) throw new Error("Invalid semantic version");
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  const prerelease = match[4]?.split(".") ?? [];
  if (core.some(part => !Number.isSafeInteger(part)) || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) throw new Error("Invalid semantic version");
  return { core, prerelease };
}
/** SemVer 2.0 precedence; build metadata does not affect update decisions. */
export function compareAppVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const av = a.prerelease[index], bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export interface UpdateAsset { name: string; bytes: number; url: string; sha256: string | null }
export interface UpdateRelease {
  version: string; tag: string; name: string; notes: string; publishedAt: string | null;
  url: string; assets: UpdateAsset[];
}
export interface UpdateCheckResult {
  status: "not-configured" | "up-to-date" | "available" | "error";
  currentVersion: string; repository: string; channel: UpdateChannel; checkedAt: number; cached: boolean;
  latest?: UpdateRelease; error?: string; rateLimitResetAt?: number;
}
export interface AppUpdateOptions { fetch?: typeof fetch; timeoutMs?: number; cacheMs?: number; now?: () => number; currentVersion?: string }
const MAX_RESPONSE_BYTES = 2 * 1024 ** 2;
async function readResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("GitHub release response is too large");
  if (!response.body) throw new Error("GitHub returned an empty release response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("GitHub release response is too large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function release(value: unknown, repository: string, channel: UpdateChannel): UpdateRelease | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.draft !== false || typeof raw.prerelease !== "boolean" || typeof raw.tag_name !== "string" || raw.tag_name.length > 240) return null;
  let parsed: ParsedVersion;
  try { parsed = parseVersion(raw.tag_name); } catch { return null; }
  if (channel === "stable" && (raw.prerelease || parsed.prerelease.length)) return null;
  const tag = raw.tag_name;
  const assets: UpdateAsset[] = [];
  if (Array.isArray(raw.assets)) for (const value of raw.assets.slice(0, 200)) {
    if (!value || typeof value !== "object") continue;
    const asset = value as Record<string, unknown>;
    if (typeof asset.name !== "string" || !asset.name || asset.name.length > 240 || /[\/\\\x00-\x1f\x7f]/.test(asset.name)
      || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.state !== "uploaded") continue;
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
    // Never surface a download URL supplied by an arbitrary payload or another repository.
    try { if (new URL(String(asset.browser_download_url)).href !== new URL(url).href) continue; } catch { continue; }
    assets.push({ name: asset.name, bytes: asset.size, url, sha256: typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null });
  }
  return {
    version: tag.replace(/^v/, ""), tag,
    name: typeof raw.name === "string" ? raw.name.slice(0, 240) : tag,
    notes: typeof raw.body === "string" ? raw.body.slice(0, 24_000) : "",
    publishedAt: typeof raw.published_at === "string" && Number.isFinite(Date.parse(raw.published_at)) ? raw.published_at : null,
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`, assets,
  };
}

/** Queries only the operator-selected public GitHub repository; never downloads or executes installers. */
export class AppUpdateService {
  private readonly request: typeof fetch; private readonly timeoutMs: number; private readonly cacheMs: number;
  private readonly now: () => number; private readonly currentVersion: string;
  private cached: { key: string; result: UpdateCheckResult } | null = null;
  private pending = new Map<string, Promise<UpdateCheckResult>>();
  constructor(options: AppUpdateOptions = {}) {
    this.request = options.fetch ?? fetch; this.timeoutMs = options.timeoutMs ?? 12_000;
    this.cacheMs = options.cacheMs ?? 15 * 60_000; this.now = options.now ?? Date.now;
    this.currentVersion = options.currentVersion ?? ALIASMODE_VERSION; parseVersion(this.currentVersion);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || !Number.isFinite(this.cacheMs) || this.cacheMs < 0) throw new Error("Invalid update service time limits");
  }
  async check(settings: UpdateSettings, options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    const repository = normalizeUpdateRepository(settings.repository);
    if (settings.channel !== "stable" && settings.channel !== "beta") throw new Error("Invalid update channel");
    const base: UpdateCheckResult = { status: "not-configured", repository, channel: settings.channel, currentVersion: this.currentVersion, checkedAt: this.now(), cached: false };
    if (!repository) return base;
    const key = `${repository.toLowerCase()}:${settings.channel}:${this.currentVersion}`;
    const cached = this.cached;
    if (!options.force && cached?.key === key && this.now() >= cached.result.checkedAt && this.now() - cached.result.checkedAt < this.cacheMs) return { ...structuredClone(cached.result), cached: true };
    const existing = this.pending.get(key); if (existing) return structuredClone(await existing);
    const pending = this.perform(base).then(result => {
      if (result.status !== "error") this.cached = { key, result: structuredClone(result) };
      return result;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, pending); return structuredClone(await pending);
  }
  private async perform(base: UpdateCheckResult): Promise<UpdateCheckResult> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.request(`https://api.github.com/repos/${base.repository}/releases?per_page=100`, {
        method: "GET", redirect: "error", signal: abort.signal,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": `Maobu-Qianjing/${this.currentVersion}` },
      });
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        return { ...base, status: "error", error: "GitHub request limit reached. Try again later.", ...(Number.isSafeInteger(reset) && reset > 0 ? { rateLimitResetAt: reset * 1000 } : {}) };
      }
      if (response.status === 404) return { ...base, status: "error", error: "GitHub repository was not found or has no public releases." };
      if (!response.ok) return { ...base, status: "error", error: `GitHub update check failed (HTTP ${response.status}).` };
      const payload = await readResponse(response);
      if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid release list");
      const releases = payload.slice(0, 100).map(value => release(value, base.repository, base.channel)).filter((value): value is UpdateRelease => value !== null);
      releases.sort((a, b) => compareAppVersions(b.version, a.version));
      const latest = releases[0];
      if (!latest) return { ...base, status: "error", error: "No compatible semantic-version release exists in this channel." };
      return { ...base, status: compareAppVersions(latest.version, this.currentVersion) > 0 ? "available" : "up-to-date", latest };
    } catch (error) {
      const timedOut = abort.signal.aborted;
      return { ...base, status: "error", error: timedOut ? "GitHub update check timed out. Try again when the network is available." : error instanceof SyntaxError ? "GitHub returned invalid release data." : "Unable to check GitHub releases. Check your network and repository settings." };
    } finally { clearTimeout(timer); }
  }
}
