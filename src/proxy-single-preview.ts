import { isSafeProfileId } from "./profile-id.ts";

export type SingleProxyType = "http" | "socks5";
export type SingleProxyHost = "127.0.0.1" | "::1";

export interface SingleProxyPreviewInput {
  mode: "single";
  scope: { ids: string[] };
  proxy: { type: SingleProxyType; host: SingleProxyHost; port: number; user?: string; pass?: string };
  requiresAuthentication?: boolean;
}

export interface ValidatedSingleProxyPreviewInput {
  ids: string[];
  proxy: { type: SingleProxyType; host: SingleProxyHost; port: number; user: string; pass: string };
}

// The operation receipt can track at most this many rows in a single attempt.
export const MAX_SINGLE_PROXY_ASSIGNMENT_IDS = 100_000;

export class SingleProxyPreviewInputError extends Error {
  override readonly name = "SingleProxyPreviewInputError";
}

const controls = /[\x00-\x1f\x7f]/;

function credential(value: unknown, maxBytes: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maxBytes || controls.test(value) || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new SingleProxyPreviewInputError("Proxy credentials are too long or contain unsupported characters.");
  }
  return value;
}

/** Shared form and server validation. Error messages never include supplied values. */
export function validateSingleProxyCredentials(type: SingleProxyType, suppliedUser: unknown, suppliedPass: unknown, requiresAuthentication = false): { user: string; pass: string } {
  const maxBytes = type === "socks5" ? 255 : 1024;
  const user = credential(suppliedUser, maxBytes).trim();
  const pass = credential(suppliedPass, maxBytes);
  if (type === "socks5" && (requiresAuthentication || user || pass) && (!user || !pass)) {
    throw new SingleProxyPreviewInputError("Enter both the username and password for this SOCKS5 proxy.");
  }
  if (type === "http" && user.includes(":")) {
    throw new SingleProxyPreviewInputError("HTTP proxy usernames cannot contain a colon.");
  }
  if (type === "http" && pass && !user) {
    throw new SingleProxyPreviewInputError("Enter a username before adding a proxy password.");
  }
  return { user, pass };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

/** Explicit IDs are the entire scope. Other selectors never widen it. */
export function validateSingleProxyPreviewInput(value: unknown): ValidatedSingleProxyPreviewInput {
  if (!record(value) || value.mode !== "single" || !hasOnly(value, ["mode", "scope", "proxy", "requiresAuthentication"])) {
    throw new SingleProxyPreviewInputError("This local proxy assignment request is invalid.");
  }
  const scope = value.scope;
  if (!record(scope) || !hasOnly(scope, ["ids"]) || !Array.isArray(scope.ids) || !scope.ids.length || scope.ids.length > MAX_SINGLE_PROXY_ASSIGNMENT_IDS) {
    throw new SingleProxyPreviewInputError("Select the environments for this local proxy assignment.");
  }
  const ids = new Set<string>();
  for (const id of scope.ids) {
    if (!isSafeProfileId(id) || ids.has(id)) throw new SingleProxyPreviewInputError("The selected environment IDs must be valid and unique.");
    ids.add(id);
  }

  const proxy = value.proxy;
  if (!record(proxy) || !hasOnly(proxy, ["type", "host", "port", "user", "pass"])
      || (proxy.type !== "http" && proxy.type !== "socks5") || (proxy.host !== "127.0.0.1" && proxy.host !== "::1")
      || typeof proxy.port !== "number" || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new SingleProxyPreviewInputError("Choose a local HTTP or SOCKS5 listener with a valid port.");
  }
  const requiresAuthentication = value.requiresAuthentication;
  if (requiresAuthentication !== undefined && typeof requiresAuthentication !== "boolean" || requiresAuthentication === true && proxy.type !== "socks5") {
    throw new SingleProxyPreviewInputError("The local proxy authentication option is invalid.");
  }
  const credentials = validateSingleProxyCredentials(proxy.type, proxy.user, proxy.pass, requiresAuthentication);
  return { ids: [...ids], proxy: { type: proxy.type, host: proxy.host, port: proxy.port, ...credentials } };
}
