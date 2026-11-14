/** @typedef {"read-only" | "profiles" | "browser" | "full"} McpScope */

export const DEFAULT_MCP_SCOPE = "read-only";
export const MCP_SCOPE_USAGE = "serve [--scope read-only|profiles|browser|full]";
export const READ_ONLY_MCP_ARGS = Object.freeze(["serve", "--scope", DEFAULT_MCP_SCOPE]);

/** @type {Readonly<Record<string, Exclude<McpScope, "full">>>} */
const LOCAL_TOOL_SCOPES = Object.freeze({
  aliasmode_profiles_list: "read-only",
  aliasmode_fingerprint_review: "read-only",
  aliasmode_network_discover: "read-only",
  aliasmode_profiles_replace_proxies: "profiles",
  aliasmode_profile_create: "profiles",
  aliasmode_profile_update: "profiles",
  aliasmode_profile_delete: "profiles",
  aliasmode_browser_open: "browser",
  aliasmode_browser_select: "browser",
  aliasmode_browser_status: "browser",
  aliasmode_browser_close: "browser",
  browser_close: "browser",
});

export const READ_ONLY_MCP_TOOLS = Object.freeze(Object.keys(LOCAL_TOOL_SCOPES)
  .filter(name => LOCAL_TOOL_SCOPES[name] === DEFAULT_MCP_SCOPE));

/** @param {readonly unknown[]} args @returns {McpScope} */
export function parseMcpScopeArgs(args) {
  if (args.length === 0) return DEFAULT_MCP_SCOPE;
  const scope = args[1];
  if (args.length === 2 && args[0] === "--scope" &&
      (scope === "read-only" || scope === "profiles" || scope === "browser" || scope === "full")) return scope;
  throw new Error(`Expected ${MCP_SCOPE_USAGE}.`);
}

/** @param {string} name @returns {Exclude<McpScope, "full"> | undefined} */
export function localMcpToolScope(name) {
  return Object.hasOwn(LOCAL_TOOL_SCOPES, name) ? LOCAL_TOOL_SCOPES[name] : undefined;
}
