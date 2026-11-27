import { expect, test } from "bun:test";
import type { ProxyCheckView } from "../src/proxy-tools-types.ts";
import { proxyProblemSummary, proxySummaryEndpoint } from "./proxy-problem-summary.ts";

test("problem summary reconstructs endpoints without URL or legacy authentication", () => {
  for (const [input, output] of [
    ["http://person:PRIVATE_SECRET@proxy.example:8080/?token=PRIVATE_SECRET", "http://proxy.example:8080"],
    ["proxy.example:8080:person:PRIVATE_SECRET:more", "http://proxy.example:8080"],
    ["socks5://person:PRIVATE_SECRET@[2001:db8::1]:1080", "socks5://[2001:db8::1]:1080"],
    ["https://person:PRIVATE_SECRET@proxy.example:443", "https://proxy.example:443"],
    ["http://proxy.example:80", "http://proxy.example:80"],
    ["unreadable PRIVATE_SECRET", null], ["ftp://person:PRIVATE_SECRET@proxy.example:21", null], ["socks5://proxy.example", null],
  ] as const) expect(proxySummaryEndpoint(input)).toBe(output);
});

test("problem summary excludes successes, raw reasons, exits, keys and credentials in metadata", () => {
  const t = (key: string, values?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? `{${name}}`));
  const rows: ProxyCheckView[] = [
    { key: "PRIVATE_KEY", proxy: "http://person:PRIVATE_PROXY_SECRET@proxy.example:8080", status: "failed", reason: "PRIVATE_RAW_REASON", ip: "203.0.113.70", checkedAt: 1,
      profiles: [{ id: "failed", name: "Environment\tOne http://person:PRIVATE_NAME_SECRET@other.example:8080", group: "Authorization: Bearer PRIVATE_AUTH_SECRET" }] },
    { key: "success", proxy: "http://success.example:8080", status: "working", ip: "203.0.113.71", checkedAt: 1, profiles: [{ id: "success", name: "Successful environment", group: "" }] },
  ];
  const text = proxyProblemSummary(rows, { t, complete: false, statusLabel: () => "Connection failed", reasonLabel: () => "Check could not complete" });
  expect(text).toContain("1 problem results · 1 affected environments");
  expect(text).toContain("Partial results only"); expect(text).toContain("http://proxy.example:8080");
  expect(text).toContain("Environment One http://[redacted]@other.example:8080");
  for (const excluded of ["PRIVATE_", "203.0.113.", "Successful environment", "success.example"]) expect(text).not.toContain(excluded);
  expect(text.split("\n").at(-1)?.split("\t")).toHaveLength(4);
});
