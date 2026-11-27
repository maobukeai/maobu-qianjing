import { lookupExitLocation } from "../../src/geoip.ts";
const url = process.argv[2]!;
const location = await lookupExitLocation({ type: "http", host: "127.0.0.1", port: process.argv[3]!, user: "geo-user", pass: "geo-test-password" }, undefined, {
  endpoints: { geojs: url, ipApi: url, ipinfo: url }, timeoutMs: 1200, geojsTimeoutMs: 1200,
});
console.log(JSON.stringify({ location }));
