import assert from "node:assert/strict";
import { act } from "react";
import { I18nProvider } from "../web/i18n.tsx";
import { ProxiesPage } from "../web/proxies.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const comparison = process.argv[2] as "same" | "different" | "unknown";
assert.ok(["same", "different", "unknown"].includes(comparison));
let checks = 0;
const fixtureFetch = Object.assign(async (path: RequestInfo | URL) => {
  if (String(path) === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
  assert.equal(path, "/ui/api/proxies/check"); checks++;
  const records = [
    { type: "summary", selectedProfiles: 1, uniqueProxies: 1, duplicatesSkipped: 0 },
    { type: "check", row: { key: "fixture", proxy: "127.0.0.1:7890", status: "working", exitComparison: comparison,
      ...(comparison === "same" ? { reason: "same_exit" } : {}), ip: "203.0.113.42", checkedAt: Date.now(), profiles: [{ id: "synthetic", name: "Fixture", group: "" }] } },
    { type: "done" },
  ];
  return new Response(records.map(record => JSON.stringify(record)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
}, { preconnect: globalThis.fetch.preconnect });
const dom = await createWebDomHarness({ fetch: fixtureFetch });
try {
  await dom.render(<I18nProvider><ProxiesPage groups={[]} active onChanged={async () => { throw new Error("A check must not edit profiles"); }} /></I18nProvider>);
  assert.equal(checks, 0);
  const check = [...dom.container.querySelectorAll("button")].find(button => button.textContent === "Check proxies");
  assert.ok(check);
  await act(async () => { check.click(); });
  await dom.flush();
  assert.equal(checks, 1);
  const connection = dom.container.querySelector("tbody tr td:nth-child(2)");
  assert.ok(connection, dom.container.textContent ?? "No content");
  assert.equal(connection.querySelector(".tools-status")?.textContent, "Reachable");
  assert.ok(!connection.textContent.includes("Dead"));
  assert.ok(connection.textContent.includes(comparison === "same" ? "a separate exit is not confirmed" : comparison === "different" ? "IP reputation and browser leaks need separate checks" : "unavailable for comparison"));
  assert.ok(dom.container.querySelector("tbody tr td:nth-child(3)")?.textContent.includes("203.0.113.42"));
  console.log("proxy comparison interaction fixture passed");
} finally { await dom.cleanup(); }
