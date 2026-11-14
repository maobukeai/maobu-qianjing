import { expect, test } from "bun:test";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints } from "./egress.ts";
import { EgressResponseError } from "./egress-transport.ts";

test("parseEgressResponse accepts JSON and plain IPv4/IPv6 responses", () => {
  expect(parseEgressResponse('{"ip":"203.0.113.4","country":"US"}')).toEqual({ ip: "203.0.113.4", country: "US" });
  expect(parseEgressResponse('{"query":"2001:db8::1"}')).toEqual({ ip: "2001:db8::1" });
  expect(parseEgressResponse("198.51.100.9\n")).toEqual({ ip: "198.51.100.9" });
});

test("parseEgressResponse rejects malformed responses", () => {
  expect(parseEgressResponse("")).toBeNull();
  expect(parseEgressResponse("not an ip")).toBeNull();
  expect(parseEgressResponse('{"ip":"localhost"}')).toBeNull();
});

test("egress endpoints support an operator override and reject invalid schemes", () => {
  expect(resolveEgressEndpoints("https://one.example/ip, http://127.0.0.1:8080/ip")).toEqual([
    "https://one.example/ip",
    "http://127.0.0.1:8080/ip",
  ]);
  expect(() => resolveEgressEndpoints("")).toThrow("at least one URL");
  expect(() => resolveEgressEndpoints("file:///tmp/ip")).toThrow("must use http or https");
});

test("direct egress reports request and service failures without exposing raw errors", async () => {
  const seen: string[] = [];
  const failures: string[] = [];
  const info = await fetchDirectEgress({
    endpoints: ["https://one.test/ip", "https://two.test/ip"],
  }, (async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint.includes("one")) throw new Error("unavailable");
    return new Response('{"ip":"198.51.100.7"}');
  }) as typeof fetch, (failure) => failures.push(failure));

  expect(info).toEqual({ ip: "198.51.100.7" });
  expect(seen).toEqual(["https://one.test/ip", "https://two.test/ip"]);
  expect(failures).toEqual(["request_failed"]);

  await expect(fetchDirectEgress({ endpoints: ["https://one.test/ip"] },
    (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    (failure) => failures.push(failure),
  )).resolves.toBeNull();
  expect(failures).toEqual(["request_failed", "service_failed"]);

  await expect(fetchDirectEgress({ endpoints: ["http://one.test/ip"] },
    (async () => new Response("proxy authentication required", { status: 407 })) as unknown as typeof fetch,
    (failure) => failures.push(failure),
  )).resolves.toBeNull();
  expect(failures).toEqual([
    "request_failed",
    "service_failed",
    "proxy_authentication_failed",
  ]);
});

test("invalid checker protocol data is a service failure and endpoint errors redact credentials", async () => {
  const failures: string[] = [];
  await expect(fetchDirectEgress({ endpoints: ["https://fixture.test/ip"] },
    (async () => { throw new EgressResponseError("Invalid response framing"); }) as unknown as typeof fetch,
    (failure) => failures.push(failure),
  )).resolves.toBeNull();
  expect(failures).toEqual(["service_failed"]);
  expect(() => resolveEgressEndpoints("https://user:private-password@fixture.test/ip")).toThrow("must not contain credentials");
  try { resolveEgressEndpoints("https://user:private-password@"); } catch (error) {
    expect(String(error)).not.toContain("private-password");
  }
});

test("default egress ignores global fetch replacement while explicit injection remains supported", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip: "198.51.100.50" }) });
  globalThis.fetch = (async () => { calls++; return Response.json({ ip: "203.0.113.50" }); }) as unknown as typeof fetch;
  try {
    expect(await fetchDirectEgress({ endpoints: [`http://127.0.0.1:${server.port}/ip`] })).toEqual({ ip: "198.51.100.50" });
    expect(calls).toBe(0);
    expect(await fetchDirectEgress({ endpoints: ["https://must-not-resolve.invalid/ip"] }, globalThis.fetch)).toEqual({ ip: "203.0.113.50" });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = previous; server.stop(true); }
});
