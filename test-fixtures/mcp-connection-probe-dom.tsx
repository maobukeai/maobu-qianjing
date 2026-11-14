import assert from "node:assert/strict";
import { act } from "react";
import { ALIASMODE_VERSION } from "../version.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { McpConnectionProbe } from "../web/mcp-connection-probe.tsx";
import { FeatureSettingsPanel, type FeatureSettingsTab } from "../web/settings-center.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const checkedAt = Date.parse("2026-11-12T12:00:00.000Z");
const privateDetail = "C:\\PRIVATE_MCP_HELPER\\local.exe";
const connected = {
  checkedAt, status: "connected", connectionVerified: true, message: privateDetail, toolCount: 2,
  tools: ["PRIVATE_FIXTURE_TOOL_1", "PRIVATE_FIXTURE_TOOL_2"],
  server: { name: "aliasmode", version: ALIASMODE_VERSION },
};

async function run(scenario: string) {
  let catalogReads = 0;
  const pending: Array<(value: Response) => void> = [];
  const copies: string[] = [];
  const fetchFixture = async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.cache, "no-store");
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    if (input === "/ui/api/settings/integrations") {
      assert.equal(options?.method, "GET");
      catalogReads++;
      return Response.json({ ok: true, integration: {
        version: ALIASMODE_VERSION, transport: "stdio", status: "ready", checks: [], capabilities: [], workflows: [],
        configs: [
          { id: "generic", label: "Generic configuration", format: "json", content: `inert generic ${catalogReads}` },
          { id: "codex", label: "Codex configuration", format: "toml", content: `inert Codex ${catalogReads}` },
        ],
      } });
    }
    assert.equal(input, "/ui/api/settings/integrations/probe");
    assert.equal(options?.method, "POST");
    assert.equal(options?.body, "{}");
    return new Promise<Response>(resolve => pending.push(resolve));
  };
  const dom = await createWebDomHarness({ fetch: Object.assign(fetchFixture, { preconnect: globalThis.fetch.preconnect }) as typeof fetch });
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: {
    writeText: async (value: string) => { copies.push(value); },
  } });
  const button = (label: string) => {
    const element = [...dom.container.querySelectorAll("button")].find(node => node.textContent.trim() === label);
    assert.ok(element, `Missing button: ${label}`);
    return element;
  };
  const receipt = () => dom.container.querySelector(".mcp-probe-result");
  const render = (tab: FeatureSettingsTab | null = "integrations", sessionKey = "workspace-a") => dom.render(
    <I18nProvider><FeatureSettingsPanel tab={tab} sessionKey={sessionKey} /><button data-outside>Outside action</button></I18nProvider>,
  );
  const settle = async (index: number, response = Response.json({ ok: true, probe: connected })) => {
    assert.ok(pending[index], `Missing probe request ${index}`);
    await act(async () => pending[index]!(response));
    await dom.flush();
  };

  try {
    if (scenario === "revision-while-pending") {
      const busyChanges: boolean[] = [];
      const renderProbe = (catalogRevision: number, ready: boolean) => dom.render(<I18nProvider>
        <McpConnectionProbe active ready={ready} catalogRevision={catalogRevision} onBusyChange={busy => busyChanges.push(busy)} />
      </I18nProvider>);
      await renderProbe(0, false);
      assert.equal(button("Test MCP connection").disabled, true);
      await act(async () => button("Test MCP connection").click());
      assert.equal(pending.length, 0);
      await renderProbe(0, true);
      await act(async () => button("Test MCP connection").click());
      await renderProbe(1, true);
      await settle(0);
      assert.equal(receipt(), null, "A late response must not verify a newer catalog");
      assert.deepEqual(busyChanges, [true, false]);
      await act(async () => button("Test MCP connection").click());
      await settle(1, Response.json({ ok: true, probe: { ...connected, toolCount: 513 } }));
      assert.ok(receipt()?.textContent.includes("Connection not verified"));
      assert.ok(receipt()?.textContent.includes("The local MCP check failed. Try again."));
      assert.ok(!receipt()?.textContent.includes(privateDetail));
      assert.deepEqual(busyChanges, [true, false, true, false]);
      return;
    }

    await render(null);
    assert.equal(catalogReads, 0, "Unvisited settings must not load MCP connection info");
    await render();
    await dom.flush();
    assert.equal(catalogReads, 1);
    assert.equal(pending.length, 0, "Visiting AI & MCP must not run a connection check");
    assert.equal(receipt(), null);
    assert.equal(button("Test MCP connection").disabled, false);
    await act(async () => {
      button("Test MCP connection").click();
      button("Test MCP connection").click();
      button("Refresh connection info").click();
    });
    assert.equal(pending.length, 1, "Same-frame check clicks must coalesce");
    assert.equal(catalogReads, 1, "A pending probe must block a competing refresh immediately");
    assert.equal(button("Checking MCP connection…").getAttribute("aria-busy"), "true");
    assert.equal(button("Refresh connection info").disabled, true);

    if (scenario === "workspace") {
      await render("integrations", "workspace-b");
      await dom.flush();
      assert.equal(catalogReads, 2);
      assert.equal(receipt(), null);
      await act(async () => button("Test MCP connection").click());
      assert.equal(pending.length, 2);
      await settle(0);
      assert.equal(receipt(), null);
      assert.equal(button("Checking MCP connection…").disabled, true);
      assert.equal(button("Refresh connection info").disabled, true);
      await settle(1, Response.json({ ok: true, probe: { ...connected, checkedAt: checkedAt + 1000 } }));
      assert.equal(receipt()?.querySelector("time")?.getAttribute("datetime"), new Date(checkedAt + 1000).toISOString());
      await render();
      await dom.flush();
      assert.equal(catalogReads, 3);
      assert.equal(receipt(), null, "Returning to an earlier workspace starts a fresh check session");
      return;
    }

    if (scenario === "lifecycle") {
      const select = dom.container.querySelector("select");
      assert.ok(select);
      await act(async () => { select.value = "codex"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.equal(dom.container.querySelector(".integration-code")?.textContent, "inert Codex 1");
      await render(null);
      const section = dom.container.querySelector('[data-feature-settings-tab="integrations"]');
      assert.ok(section?.hasAttribute("hidden") && section.hasAttribute("inert"));
      const outside = button("Outside action");
      await act(async () => outside.focus());
      await settle(0);
      assert.equal(dom.window.document.activeElement, outside);
      await render();
      assert.equal(dom.window.document.activeElement, outside, "Returning to settings must not steal focus");
      assert.ok(receipt()?.textContent.includes("Connection verified"));
      assert.equal(dom.container.querySelector(".integration-code")?.textContent, "inert Codex 1");
      assert.equal(catalogReads, 1);
      assert.equal(pending.length, 1);
      return;
    }

    await settle(0);
    assert.ok(receipt()?.textContent.includes("Connection verified"));
    assert.ok(receipt()?.textContent.includes("2 tools discovered"));
    assert.equal(receipt()?.querySelector("time")?.getAttribute("datetime"), new Date(checkedAt).toISOString());
    assert.ok(!receipt()?.textContent.includes("PRIVATE_"));

    if (scenario === "catalog") {
      await act(async () => button("Refresh connection info").click());
      await dom.flush();
      assert.equal(catalogReads, 2);
      assert.equal(receipt(), null);
      assert.equal(dom.container.querySelector(".mcp-probe-note")?.textContent, "Connection info changed. Test again to verify it.");
      assert.equal(pending.length, 1);
      await act(async () => button("Test MCP connection").click());
      await settle(1, Response.json({ ok: true, probe: { ...connected, status: "unavailable", connectionVerified: false, toolCount: 0, tools: [] } }));
      assert.ok(receipt()?.textContent.includes("Refresh connection info before trying again."));
      assert.ok(!receipt()?.textContent.includes("Last verified"));
      return;
    }

    assert.equal(scenario, "safe-retry");
    await act(async () => button("Copy check summary").click());
    assert.deepEqual(copies, [["Connection verified", "Last checked 2026-11-12T12:00:00.000Z", `MCP server version ${ALIASMODE_VERSION}`, "2 tools discovered"].join("\n")]);
    assert.ok(receipt()?.textContent.includes("Copied"));
    await act(async () => button("Test MCP connection").click());
    await settle(1, Response.json({ ok: false, error: privateDetail }, { status: 503 }));
    assert.ok(receipt()?.textContent.includes("Connection not verified"));
    assert.ok(receipt()?.textContent.includes("The local MCP check failed. Try again."));
    assert.ok(receipt()?.textContent.includes("Last verified"));
    assert.equal(receipt()?.querySelectorAll("time")[1]?.getAttribute("datetime"), new Date(checkedAt).toISOString());
    assert.ok(!receipt()?.textContent.includes("PRIVATE_"));
    await act(async () => button("Copy check summary").click());
    assert.match(copies[1]!, /^Connection not verified\nLast checked [0-9T:.-]+Z$/);
    await act(async () => button("Test MCP connection").click());
    await settle(2, Response.json({ ok: true, probe: { ...connected, status: "timeout", connectionVerified: false, toolCount: 0, tools: [] } }));
    assert.ok(receipt()?.textContent.includes("The local MCP check timed out. Try again."));
    assert.ok(receipt()?.textContent.includes("Last verified"));
  } finally {
    await dom.cleanup();
  }
}

await run(process.argv[2]!);
console.log("MCP connection probe fixture passed");
