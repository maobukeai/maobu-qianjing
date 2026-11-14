import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverRuntime, RUNTIME_VERSION } from "./runtime-client.mjs";
import { PlaywrightToolProxy } from "./playwright-proxy.mjs";
import { DEFAULT_MCP_SCOPE, localMcpToolScope, parseMcpScopeArgs } from "./mcp-scope.mjs";

const VERSION = RUNTIME_VERSION;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const FIREFOX_FILTERED_TOOLS = new Set(["browser_close", "browser_install", "browser_pdf_save"]);

function firefoxTools(tools) {
  return tools.filter((tool) => !FIREFOX_FILTERED_TOOLS.has(tool.name) && !/pdf/i.test(tool.name));
}

function safeBrowserResult(value) {
  if (value?.engine !== "firefox") return value;
  const {
    profileId, running, state, engine, capabilities, headless, alreadyOpen,
    ownedByConnection, attachedExisting, selected, closed, deleted, detached,
  } = value;
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(state !== undefined ? { state } : {}),
    engine,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(headless !== undefined ? { headless } : {}),
    ...(alreadyOpen !== undefined ? { alreadyOpen } : {}),
    ...(ownedByConnection !== undefined ? { ownedByConnection } : {}),
    ...(attachedExisting !== undefined ? { attachedExisting } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(closed !== undefined ? { closed } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(detached !== undefined ? { detached } : {}),
  };
}
const PROFILE_ID = { type: "string", minLength: 1 };
// The sidecar's profile-id.ts remains authoritative; these tool bounds reject
// malformed arguments before an RPC, including Windows device-name aliases.
const REVIEW_PROFILE_ID = { ...PROFILE_ID, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" };
const PROXY_REPLACEMENT_ROW = {
  type: "object",
  properties: {
    profileId: PROFILE_ID,
    username: { type: "string", minLength: 1, maxLength: 255 },
    proxy: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["http", "https", "socks5"] },
        host: { type: "string" },
        port: { type: "string" },
        user: { type: "string" },
        pass: { type: "string" },
      },
      required: ["type", "host", "port", "user", "pass"],
      additionalProperties: false,
    },
  },
  required: ["proxy"],
  oneOf: [
    { required: ["profileId"], not: { required: ["username"] } },
    { required: ["username"], not: { required: ["profileId"] } },
  ],
  additionalProperties: false,
};

function diagnose(message) {
  if (process.env.ALIASMODE_MCP_DIAGNOSTICS === "1") {
    process.stderr.write(`[aliasmode-mcp-host] ${message}\n`);
  }
}

function toolAnnotations(title, { readOnly = false, destructive = false, openWorld = false } = {}) {
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: openWorld,
  };
}

const ALIAS_TOOLS = [
  {
    name: "aliasmode_profiles_list",
    description: "List local 猫步·千境 profiles and their current browser state.",
    annotations: toolAnnotations("List 猫步·千境 profiles"),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_fingerprint_review",
    description: "Review one local profile's saved configuration and stored fingerprint evidence. This never starts, measures, or probes a browser. launchRecordPresent is bookkeeping only; liveness is not-checked. No credentials, raw samples, endpoints, or private provenance digests are returned.",
    annotations: { ...toolAnnotations("Review stored fingerprint evidence", { readOnly: true }), idempotentHint: true },
    inputSchema: {
      type: "object", properties: { profileId: REVIEW_PROFILE_ID }, required: ["profileId"], additionalProperties: false,
    },
  },
  {
    name: "aliasmode_network_discover",
    description: "Discover local desktop proxy listeners on literal loopback addresses only. Checks at most 16 local ports and sends a SOCKS method-negotiation greeting without credentials or CONNECT. Does not contact external sites or change settings. A listener or handshake does not prove exit connectivity, IP reputation, DNS isolation, or WebRTC privacy.",
    annotations: { ...toolAnnotations("Discover local proxy listeners", { readOnly: true }), idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", enum: ["127.0.0.1", "::1"], default: "127.0.0.1" },
        ports: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 65535 }, description: "Defaults to bounded common desktop HTTP/SOCKS proxy ports." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profiles_replace_proxies",
    description: "Preview or apply proxy replacements to closed local 猫步·千境 profiles. The default is a dry run; open and ambiguous profiles are skipped.",
    annotations: toolAnnotations("Replace 猫步·千境 profile proxies", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        replacements: {
          type: "array",
          minItems: 1,
          items: PROXY_REPLACEMENT_ROW,
        },
        csv: { type: "string", minLength: 1 },
      },
      oneOf: [
        { required: ["replacements"], not: { required: ["csv"] } },
        { required: ["csv"], not: { required: ["replacements"] } },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_create",
    description: "Create a persistent 猫步·千境 profile, or an explicit temporary profile. Without engine, Windows creates a Chromium profile, and macOS and Linux create a Firefox profile.",
    annotations: toolAnnotations("Create a 猫步·千境 profile"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        group: { type: "string" },
        platform: { type: "string" },
        engine: { type: "string", enum: ["chromium", "firefox"] },
        chromiumRuntime: {
          type: "string",
          enum: ["aliasmode", "cloakbrowser"],
          description: "Chromium profiles only. aliasmode (Chromium 155) is the default where this computer can run it. CloakBrowser profiles on one computer can be linked to each other.",
        },
        screen: { type: "string" },
        proxy: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["http", "https", "socks5"] },
                host: { type: "string" },
                port: { type: "string" },
                user: { type: "string" },
                pass: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        temporary: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_update",
    description: "Edit a closed local 猫步·千境 profile by ID. Only supplied fields change; empty strings clear fields. Sessions and cookies are preserved. Returns confirmation, not credentials.",
    annotations: toolAnnotations("Edit a local 猫步·千境 profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        set: {
          type: "object",
          properties: {
            name: { type: "string" },
            group: { type: "string" },
            platform: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            email: { type: "string" },
            emailPassword: { type: "string" },
            twofa: { type: "string" },
            proxy: { type: "string", description: "host:port:user:pass, or an empty string to remove the proxy" },
            proxyType: { type: "string" },
            resolution: { type: "string", description: "WIDTH*HEIGHT" },
            extensions: { type: "array", items: { type: "string" } },
            tags: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ["profileId", "set"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_delete",
    description: "Delete a closed 猫步·千境 profile.",
    annotations: toolAnnotations("Delete a 猫步·千境 profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_open",
    description: "Open a 猫步·千境 browser and select it for Playwright actions.",
    annotations: toolAnnotations("Open a 猫步·千境 browser", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        headless: { type: "boolean", default: false },
        startupUrls: {
          type: "array",
          items: { type: "string", pattern: "^https?://" },
        },
        select: { type: "boolean", default: true },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_select",
    description: "Select an open 猫步·千境 browser for subsequent Playwright actions.",
    annotations: toolAnnotations("Select a 猫步·千境 browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_status",
    description: "Get the selected browser state, or the state of one profile.",
    annotations: toolAnnotations("Get 猫步·千境 browser status", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_close",
    description: "Safely capture and close one 猫步·千境 browser.",
    annotations: toolAnnotations("Close a 猫步·千境 browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Safely capture and close the selected 猫步·千境 browser.",
    annotations: toolAnnotations("Close the selected 猫步·千境 browser", { destructive: true }),
    inputSchema: EMPTY_SCHEMA,
  },
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "猫步·千境 operation failed";
  return message.replace(/wss?:\/\/\S+/gi, "CDP endpoint").slice(0, 500);
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: safeError(error) }],
  };
}

function profileInput(args) {
  const { temporary = false, ...input } = args;
  return { input, temporary };
}

function readOnlyArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  if (name === "aliasmode_fingerprint_review") {
    const id = args.profileId;
    if (Object.keys(args).some(key => key !== "profileId") || typeof id !== "string" || id.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
      throw new Error("fingerprint review requires only a valid profileId (1-128 safe characters)");
    }
    return { profileId: id };
  }
  if (Object.keys(args).some(key => !["host", "ports"].includes(key))
    || args.host !== undefined && args.host !== "127.0.0.1" && args.host !== "::1") {
    throw new Error("network discovery supports only loopback host and bounded local ports");
  }
  const ports = args.ports;
  if (ports !== undefined && (!Array.isArray(ports) || ports.length < 1 || ports.length > 16
    || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ports).size !== ports.length)) {
    throw new Error("network discovery requires 1-16 unique integer ports from 1 to 65535");
  }
  return { ...(args.host !== undefined ? { host: args.host } : {}), ...(ports !== undefined ? { ports: [...ports] } : {}) };
}

export async function createAliasModeMcp(options = {}) {
  const scope = parseMcpScopeArgs(options.scope === undefined ? [] : ["--scope", options.scope]);
  const browserEnabled = scope === "browser" || scope === "full";
  const playwright = browserEnabled ? options.playwright ?? new PlaywrightToolProxy(VERSION) : undefined;
  await playwright?.initialize();
  const discovered = options.discovered ?? await discoverRuntime(options.runtime);
  const runtime = discovered.client;
  const server = new Server(
    { name: "aliasmode", version: VERSION },
    { capabilities: { tools: {} } },
  );
  let selectedProfileId;
  let selectedEngine;
  let selectedFirefoxTools = [];
  const ownedProfileIds = new Set();
  let closing;

  const selectedTools = () => (selectedEngine === "firefox" ? selectedFirefoxTools : playwright?.listTools() ?? [])
    .filter(tool => !localMcpToolScope(tool.name));
  const localTools = ALIAS_TOOLS.filter(tool => {
    const required = localMcpToolScope(tool.name);
    return required && (required === DEFAULT_MCP_SCOPE || required === scope || scope === "full");
  }).map(tool => scope === "full" || tool.name !== "aliasmode_profiles_list" ? tool : {
    ...tool,
    description: "List local 猫步·千境 profiles and their recorded browser state. Process liveness is not checked. Browser control endpoints are excluded.",
    annotations: { ...toolAnnotations("List 猫步·千境 profiles", { readOnly: true }), idempotentHint: true },
  });
  const localToolNames = new Set(localTools.map(tool => tool.name));

  const selectBrowser = async (profileId, knownStatus) => {
    const status = knownStatus ?? await runtime.call("browser.status", { profileId });
    if (!status.running) throw new Error("open this 猫步·千境 profile before selecting it");
    const wasChromium = selectedEngine === "chromium";
    selectedProfileId = undefined;
    selectedEngine = undefined;
    selectedFirefoxTools = [];
    if (wasChromium) await playwright.detach();
    if (status.engine === "firefox") {
      const result = await runtime.call("firefox.tools.list", { profileId });
      selectedFirefoxTools = firefoxTools(result.tools ?? []);
      selectedProfileId = profileId;
      selectedEngine = "firefox";
      return safeBrowserResult({ ...status, selected: true });
    }
    if (!status.ws) throw new Error("open this 猫步·千境 profile before selecting it");
    await playwright.attach(status.ws);
    selectedProfileId = profileId;
    selectedEngine = "chromium";
    return {
      profileId,
      selected: true,
      running: true,
      port: status.port,
      headless: status.headless,
    };
  };

  const closeBrowser = async (profileId) => {
    const target = profileId || selectedProfileId;
    if (!target) throw new Error("select an open 猫步·千境 browser first");
    const selected = target === selectedProfileId;
    const engine = selectedEngine;
    if (selected) await playwright.detach();
    try {
      const result = await runtime.call("browser.close", { profileId: target });
      ownedProfileIds.delete(target);
      if (selected) {
        selectedProfileId = undefined;
        selectedEngine = undefined;
        selectedFirefoxTools = [];
      }
      return safeBrowserResult(result);
    } catch (error) {
      if (selected) {
        const status = await runtime.call("browser.status", { profileId: target }).catch(() => undefined);
        if (status?.running) {
          if (engine === "firefox") await selectBrowser(target, status).catch(() => {});
          else if (status.ws) await playwright.attach(status.ws).catch(() => {});
        }
      }
      throw error;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...localTools, ...selectedTools()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (!localToolNames.has(name) && !selectedTools().some(tool => tool.name === name)) {
        throw new Error("This tool is unavailable in the configured MCP scope.");
      }
      if (name === "aliasmode_profiles_list") {
        return toolResult(await runtime.call(scope === "full" ? "profiles.list" : "profiles.inventory"));
      }
      if (name === "aliasmode_fingerprint_review") {
        return toolResult(await runtime.call("fingerprints.review", readOnlyArguments(name, args)));
      }
      if (name === "aliasmode_network_discover") {
        return toolResult(await runtime.call("network.discover", readOnlyArguments(name, args)));
      }
      if (name === "aliasmode_profiles_replace_proxies") {
        return toolResult(await runtime.call("profiles.replaceProxies", args));
      }
      if (name === "aliasmode_profile_create") {
        return toolResult(await runtime.call("profiles.create", profileInput(args)));
      }
      if (name === "aliasmode_profile_update") {
        return toolResult(await runtime.call("profiles.update", args));
      }
      if (name === "aliasmode_profile_delete") {
        return toolResult(await runtime.call("profiles.delete", { profileId: args.profileId }));
      }
      if (name === "aliasmode_browser_open") {
        const opened = await runtime.call("browser.open", {
          profileId: args.profileId,
          ...(args.headless !== undefined ? { headless: args.headless } : {}),
          ...(args.startupUrls ? { startupUrls: args.startupUrls } : {}),
        });
        if (opened.ownedByConnection) ownedProfileIds.add(args.profileId);
        if (args.select !== false) {
          try {
            await selectBrowser(args.profileId, {
              running: true,
              ...(opened.engine === "firefox"
                ? { engine: "firefox", capabilities: opened.capabilities, headless: opened.headless }
                : { ws: opened.ws, port: opened.port, headless: opened.headless }),
            });
          } catch (error) {
            if (opened.ownedByConnection) {
              const closed = await runtime.call("browser.close", { profileId: args.profileId })
                .then(() => true, () => false);
              if (closed) ownedProfileIds.delete(args.profileId);
            }
            throw error;
          }
        }
        return toolResult(safeBrowserResult({
          profileId: opened.profileId,
          ...(opened.engine === "firefox"
            ? { engine: "firefox", capabilities: opened.capabilities }
            : { port: opened.port }),
          headless: opened.headless,
          alreadyOpen: opened.alreadyOpen,
          selected: args.select !== false,
        }));
      }
      if (name === "aliasmode_browser_select") {
        return toolResult(await selectBrowser(args.profileId));
      }
      if (name === "aliasmode_browser_status") {
        const profileId = args.profileId || selectedProfileId;
        if (!profileId) throw new Error("select an open 猫步·千境 browser first");
        const status = await runtime.call("browser.status", { profileId });
        const { ws: _ws, firefoxOwner: _firefoxOwner, ...safeStatus } = safeBrowserResult(status);
        return toolResult({ ...safeStatus, selected: profileId === selectedProfileId });
      }
      if (name === "aliasmode_browser_close" || name === "browser_close") {
        return toolResult(await closeBrowser(args.profileId));
      }
      if (!selectedProfileId) throw new Error("select an open 猫步·千境 browser first");
      if (selectedEngine === "firefox") {
        return await runtime.call("firefox.tools.call", {
          profileId: selectedProfileId,
          name,
          arguments: args,
        });
      }
      return await playwright.callTool(name, args);
    } catch (error) {
      return errorResult(error);
    }
  });

  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      diagnose("close started");
      await playwright?.detach();
      diagnose("playwright detached");
      for (const profileId of [...ownedProfileIds]) {
        diagnose("owned browser close started");
        const closed = await runtime.call("browser.close", { profileId })
          .then(() => true, () => false);
        diagnose(`owned browser close finished closed=${closed}`);
        if (closed) ownedProfileIds.delete(profileId);
      }
      runtime.close();
      diagnose("runtime closed");
    })();
    return closing;
  };
  server.onclose = () => { void close(); };
  return { server, close };
}

export function sanitizeEnvironment(env = process.env) {
  const allowed = new Set([
    "APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
    "ALIASMODE_APP_VERSION", "ALIASMODE_DESKTOP_EXE", "ALIASMODE_MCP_DIAGNOSTICS",
    "ALIASMODE_RUNTIME_DESCRIPTOR",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
    // Linux: the app that the host may start needs the desktop session, and the data folder.
    "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  ]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key.toUpperCase())) delete env[key];
  }
}

async function main() {
  sanitizeEnvironment();
  const scope = parseMcpScopeArgs(process.argv.slice(2));
  const desktopExecutable = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    // macOS: Contents/Resources -> Contents/MacOS; Linux: lib/<app> -> bin.
    ...(process.platform === "darwin" ? ["..", "MacOS", "aliasmode"]
      : process.platform === "linux" ? ["..", "..", "bin", "aliasmode"] : ["AliasMode.exe"]),
  );
  const host = await createAliasModeMcp({ scope, runtime: { desktopExecutable } });
  let shuttingDown = false;
  const shutdown = (event = "signal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    diagnose(`shutdown requested event=${event}`);
    void host.close().finally(() => {
      diagnose("shutdown complete");
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("end", () => shutdown("stdin-end"));
  process.stdin.once("close", () => shutdown("stdin-close"));
  await host.server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`猫步·千境 MCP could not start: ${safeError(error)}`);
    console.error("Run 猫步·千境 setup again or open the app once.");
    process.exit(1);
  });
}
