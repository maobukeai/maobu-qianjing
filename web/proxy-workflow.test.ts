import { expect, test } from "bun:test";
import { analyzeProxyList, matchingProxyChecks, matchingProxyReplacements, proxyCheckOverview, proxyRosterSignature, proxyScopeOverview } from "./proxy-workflow.ts";
import type { ProxyCheckView } from "../src/proxy-tools-types.ts";

const profiles = [
  { id: "a", group: "Sales", running: true, proxy: "proxy.example:8080" },
  { id: "b", group: "Sales", running: false, proxy: null },
  { id: "c", group: "", running: false, proxy: null, proxyError: "invalid" },
];
test("scope overview uses all selected environments rather than a visible page or redacted endpoint identities", () => {
  expect(proxyScopeOverview(profiles, { groups: ["Sales"] })).toEqual({ total: 2, running: 1, configured: 1, missing: 1, invalid: 0 });
  expect(proxyScopeOverview(profiles, { all: true, ids: ["c"] })).toEqual({ total: 1, running: 0, configured: 0, missing: 0, invalid: 1 });
  expect(proxyScopeOverview(profiles, { groups: [] }).total).toBe(0);
  const original = proxyRosterSignature(profiles, { all: true });
  expect(proxyRosterSignature([...profiles].reverse(), { all: true })).toBe(original);
  expect(proxyRosterSignature(profiles.map(item => item.id === "a" ? { ...item, running: false } : item), { all: true })).not.toBe(original);
});

test("proxy draft feedback identifies physical line numbers without returning an address or credential", () => {
  const report = analyzeProxyList("\nproxy.example:8080:person:PRIVATE_DRAFT_SECRET\ninvalid-proxy\n\nsocks5://person:PRIVATE_DRAFT_SECRET@proxy.example:1080\nhttps://secure.example:8443\nproxy.example:8080:person:PRIVATE_DRAFT_SECRET");
  expect(report).toEqual({ total: 5, readable: 4, repeated: 1, https: 1, invalidRows: [3] });
  expect(JSON.stringify(report)).not.toContain("PRIVATE_DRAFT_SECRET");
  expect(JSON.stringify(report)).not.toContain("proxy.example");
  expect(analyzeProxyList("[2001:db8::1]:1080:user:pass\nhttp://user:pass@proxy.example:8080").invalidRows).toEqual([]);
  expect(analyzeProxyList("host name:8080\nproxy.example:0\nftp://proxy.example:21\nproxy.example:8080::secret").invalidRows).toEqual([1, 2, 3, 4]);
});

test("result searches cover the complete redacted inventory independently of result paging", () => {
  const rows: ProxyCheckView[] = Array.from({ length: 75 }, (_, index) => ({ key: String(index), proxy: `proxy${index}.example:8080`, ip: `192.0.2.${index}`, status: index === 74 ? "failed" : "working", checkedAt: 1, profiles: [{ id: `p${index}`, name: `Environment ${index}`, group: "Sales" }] }));
  expect(matchingProxyChecks(rows, "environment 74")).toEqual([rows[74]!]);
  expect(matchingProxyChecks(rows, " 192.0.2.74 ")).toEqual([rows[74]!]);
  expect(matchingProxyChecks(rows, "no-match")).toEqual([]);
  expect(matchingProxyReplacements([{ index: 1, profileId: "p74", name: "Environment 74", group: "Sales", previousProxy: "old.example:8080", proxy: "new.example:1080", status: "ready" }], "new.example")).toHaveLength(1);
  expect(proxyCheckOverview(rows)).toEqual({ completed: 75, reachable: 74, review: 1, retry: 1 });
});
