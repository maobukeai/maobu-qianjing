/**
 * Regenerates the public documentation contracts in docs/public from the real
 * Local API and MCP host code, so the website copies them instead of retyping.
 *
 *   bun scripts/generate-public-docs.mjs                  rewrite current-source catalog + manifest
 *   bun scripts/generate-public-docs.mjs --check          fail when the committed files drift
 *
 * MCP tool catalogs are produced by connecting an in-memory MCP client to the
 * real `createAliasModeMcp` server with a fake browser proxy and runtime, so no
 * browser or AliasMode runtime is needed. Playwright tools come from the real
 * pinned @playwright/mcp package through PlaywrightToolProxy.initialize().
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DOCS_DIR = join(ROOT, "docs", "public");
export const OPENAPI_PATH = "local-api.openapi.json";
export const MANIFEST_PATH = "manifest.json";
export const CATALOG_DIR = "mcp-tools";
export const CURRENT_CATALOG_PATH = `${CATALOG_DIR}/current-source.json`;
const CATALOG_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stringList(text) {
  return [...(text ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Capabilities, filtered tools, and listing behaviour, read from playwright-proxy.mjs source text. */
export function playwrightMetaFromSource(source) {
  const capabilities = stringList(source.match(/(?:CAPABILITIES\s*=|capabilities:)\s*\[([^\]]*)\]/)?.[1]);
  const filtered = stringList(source.match(/FILTERED_TOOLS\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1]);
  if (!capabilities.length || !filtered.length) {
    throw new Error("could not read CAPABILITIES and FILTERED_TOOLS from agent/playwright-proxy.mjs");
  }
  return {
    capabilities,
    filtered,
    availability: /^\s*async initialize\(\)/m.test(source) ? "listed-before-selection" : "after-browser-selection",
  };
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    inputSchema: tool.inputSchema,
  };
}

function isAliasModeTool(tool) {
  return tool.name.startsWith("aliasmode_") || tool.name === "browser_close";
}

async function listPlaywrightTools(version) {
  const { PlaywrightToolProxy } = await import(pathToFileURL(join(ROOT, "agent", "playwright-proxy.mjs")).href);
  const proxy = new PlaywrightToolProxy(version);
  await proxy.initialize();
  return proxy.listTools().map(publicTool);
}

/** List the tools the AliasMode MCP host at `mcpHostPath` serves, via an in-memory MCP client. */
async function listHostTools(mcpHostPath, playwrightTools) {
  const { createAliasModeMcp } = await import(pathToFileURL(mcpHostPath).href);
  const refuse = () => {
    throw new Error("the public docs generator never drives a browser");
  };
  const host = await createAliasModeMcp({
    scope: "full",
    playwright: {
      async initialize() {},
      listTools: () => playwrightTools,
      attach: refuse,
      callTool: refuse,
      async detach() {},
    },
    discovered: { client: { call: refuse, close() {} } },
  });
  const client = new Client({ name: "aliasmode-public-docs", version: "0" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map(publicTool);
  } finally {
    await client.close().catch(() => {});
    await host.server.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

function catalog({ aliasModeVersion, status, sourceRef, playwrightMcpVersion, meta, tools }) {
  return {
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    aliasModeVersion,
    status,
    sourceRef,
    playwrightMcpVersion,
    playwrightCapabilities: meta.capabilities,
    filteredPlaywrightTools: meta.filtered,
    playwrightToolAvailability: meta.availability,
    aliasModeTools: tools.filter(isAliasModeTool),
    playwrightTools: tools.filter((tool) => !isAliasModeTool(tool)),
  };
}

export async function generateCurrentSourceCatalog() {
  const pkg = readJson(join(ROOT, "package.json"));
  const meta = playwrightMetaFromSource(readFileSync(join(ROOT, "agent", "playwright-proxy.mjs"), "utf8"));
  const playwrightTools = await listPlaywrightTools(pkg.version);
  const tools = await listHostTools(join(ROOT, "agent", "mcp-host.mjs"), playwrightTools);
  return catalog({
    aliasModeVersion: pkg.version,
    status: "source",
    sourceRef: "source",
    playwrightMcpVersion: pkg.dependencies["@playwright/mcp"],
    meta,
    tools,
  });
}

/** Stamp the package version into the hand-written OpenAPI document. */
export function stampOpenApi(text, productVersion) {
  const doc = JSON.parse(text);
  doc.info.version = productVersion;
  return serialize(doc);
}

export function buildManifest({ productVersion, openapiText, currentCatalogText }) {
  const mcpCatalogs = { "current-source": { path: CURRENT_CATALOG_PATH, sha256: sha256(currentCatalogText) } };
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    productVersion,
    openapi: { path: OPENAPI_PATH, sha256: sha256(openapiText) },
    mcpCatalogs,
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main(argv) {
  if (argv.some((argument) => argument !== "--check")) fail("usage: bun scripts/generate-public-docs.mjs [--check]");
  const check = argv.includes("--check");
  const productVersion = readJson(join(ROOT, "package.json")).version;
  const openapiPath = join(PUBLIC_DOCS_DIR, OPENAPI_PATH);
  const openapiText = stampOpenApi(readFileSync(openapiPath, "utf8"), productVersion);
  const currentCatalogText = serialize(await generateCurrentSourceCatalog());
  const manifestText = serialize(buildManifest({ productVersion, openapiText, currentCatalogText }));
  const outputs = [
    [openapiPath, openapiText],
    [join(PUBLIC_DOCS_DIR, CURRENT_CATALOG_PATH), currentCatalogText],
    [join(PUBLIC_DOCS_DIR, MANIFEST_PATH), manifestText],
  ];

  if (!check) {
    mkdirSync(join(PUBLIC_DOCS_DIR, CATALOG_DIR), { recursive: true });
    for (const [path, text] of outputs) writeFileSync(path, text);
    console.log(`wrote ${outputs.map(([path]) => relative(ROOT, path)).join(", ")}`);
    return;
  }

  const problems = [];
  for (const [path, expected] of outputs) {
    const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (actual !== expected) problems.push(`${relative(ROOT, path)} is out of date`);
  }
  if (problems.length) fail(`${problems.join("\n")}\nRun \`bun run docs:public\` and commit the result.`);
  console.log("public docs are up to date");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
