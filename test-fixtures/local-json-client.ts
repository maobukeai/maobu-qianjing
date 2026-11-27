import { LocalJsonTransportError, requestLoopbackJson } from "../src/local-json-transport.ts";
try {
  const result = await requestLoopbackJson(process.argv[2]!, JSON.parse(process.argv[3]!));
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify(error instanceof LocalJsonTransportError ? { code: error.code, message: error.message, status: error.status } : { code: "unexpected" }));
  process.exitCode = 1;
}
