import { expect, test } from "bun:test";
import { AGENT_CONTROL_MAX_MESSAGE_BYTES } from "./agent-control.ts";
import { parseProxyReplacementCsv, ProxyReplacementInputError } from "./proxy-replacements.ts";

test("proxy CSV preserves BOM, CRLF, quoted fields, commas, and escaped quotes", () => {
  const csv = '\uFEFFusername,type,host,port,user,pass\r\n"account,one",socks5,"[2001:db8::1]",01080,"proxy,user","p,a""ss"\r\n';
  expect(parseProxyReplacementCsv(csv)).toEqual([{
    username: "account,one", proxy: { type: "socks5", host: "[2001:db8::1]", port: "01080", user: "proxy,user", pass: 'p,a"ss' },
  }]);
});

test("proxy CSV supports stable local profile IDs", () => {
  expect(parseProxyReplacementCsv("profileId,type,host,port,user,pass\np1,http,proxy.test,8080,,")).toEqual([{
    profileId: "p1", proxy: { type: "http", host: "proxy.test", port: "8080", user: "", pass: "" },
  }]);
});

test("proxy CSV rejects malformed records and unsupported headers without exposing credentials", () => {
  const cases = [
    'username,type,host,port,user,pass\n"private-record,http,host,80,,',
    "type,host,port,user,pass\nhttp,host,80,,",
    "username,profileId,type,host,port,user,pass\nuser,id,http,host,80,,",
    "username,type,host,port,user,pass,extra\nuser,http,host,80,,,secret-value",
    "username,type,host,port,user,pass\n",
    "profileId,type,host,port,user,pass,expectedVersion\np1,http,host,80,,,7",
  ];
  for (const csv of cases) {
    expect(() => parseProxyReplacementCsv(csv)).toThrow(ProxyReplacementInputError);
    try { parseProxyReplacementCsv(csv); } catch (error) {
      expect(String(error)).not.toContain("private-record");
      expect(String(error)).not.toContain("secret-value");
    }
  }
});

test("a large local proxy request fits the Agent Control message limit", () => {
  const replacements = Array.from({ length: 1645 }, (_, index) => ({
    username: `account-${index}`, proxy: { type: "socks5", host: "representative-proxy.example", port: "65535", user: "proxy-user", pass: "proxy-password" },
  }));
  const message = JSON.stringify({ protocol: "aliasmode-agent-v1", id: 1, method: "profiles.replaceProxies", params: { replacements } });
  expect(Buffer.byteLength(message)).toBeLessThan(AGENT_CONTROL_MAX_MESSAGE_BYTES);
});
