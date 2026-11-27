import { fetchEgressEndpoint } from "../../src/egress-transport.ts";
try {
  const response = await fetchEgressEndpoint(process.argv[2]!, { relayPort: Number(process.argv[3]), signal: AbortSignal.timeout(3_000) });
  console.log(JSON.stringify({ status: response.status, body: await response.text() }));
} catch (error) {
  console.log(JSON.stringify({ failed: true, name: error instanceof Error ? error.name : "unknown", code: error && typeof error === "object" && "code" in error ? error.code : "unknown" }));
  process.exitCode = 1;
}
