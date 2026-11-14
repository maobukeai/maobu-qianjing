import { expect, test } from "bun:test";
import { MAX_SINGLE_PROXY_ASSIGNMENT_IDS, SingleProxyPreviewInputError, validateSingleProxyCredentials, validateSingleProxyPreviewInput } from "./proxy-single-preview.ts";

const request = {
  mode: "single" as const,
  scope: { ids: ["saved_b", "saved_a"] },
  proxy: { type: "http" as const, host: "::1" as const, port: 80 },
};

test("structured HTTP input keeps port 80 and exact ordered IDs on IPv6", () => {
  const result = validateSingleProxyPreviewInput(request);
  expect(result).toEqual({ ids: ["saved_b", "saved_a"], proxy: { type: "http", host: "::1", port: 80, user: "", pass: "" } });
  result.ids.reverse();
  expect(request.scope.ids).toEqual(["saved_b", "saved_a"]);
});

test("missing, broad, duplicate, invalid or oversized scope is refused before planning", () => {
  for (const scope of [undefined, { ids: [] }, { all: true, ids: ["saved_a"] }, { groups: ["all"], ids: ["saved_a"] }, { ids: ["saved_a", "saved_a"] }, { ids: [".."] }, { ids: ["NUL"] }, { ids: Array(MAX_SINGLE_PROXY_ASSIGNMENT_IDS + 1).fill("saved_a") }]) {
    expect(() => validateSingleProxyPreviewInput({ ...request, scope })).toThrow(SingleProxyPreviewInputError);
  }
});

test("only the two discovered literal hosts and numeric in-range ports are accepted", () => {
  for (const host of ["localhost", "127.0.0.2", "[::1]", "::ffff:127.0.0.1", "proxy.invalid", "127.0.0.1\n"]) {
    expect(() => validateSingleProxyPreviewInput({ ...request, proxy: { ...request.proxy, host } })).toThrow(SingleProxyPreviewInputError);
  }
  for (const port of [0, 65536, 80.1, Infinity, "80"]) {
    expect(() => validateSingleProxyPreviewInput({ ...request, proxy: { ...request.proxy, port } })).toThrow(SingleProxyPreviewInputError);
  }
  expect(() => validateSingleProxyPreviewInput({ ...request, requiresAuthentication: true })).toThrow(SingleProxyPreviewInputError);
});

test("SOCKS5 authentication validates both fields and their UTF-8 byte lengths", () => {
  const proxy = { type: "socks5", host: "127.0.0.1", port: 1080 };
  expect(validateSingleProxyPreviewInput({ ...request, proxy }).proxy).toMatchObject({ user: "", pass: "" });
  for (const credentials of [{}, { user: "operator" }, { pass: "secret" }, { user: " ", pass: "secret" }, { user: "密".repeat(86), pass: "secret" }, { user: "operator", pass: "密".repeat(86) }]) {
    expect(() => validateSingleProxyPreviewInput({ ...request, proxy: { ...proxy, ...credentials }, requiresAuthentication: true })).toThrow(SingleProxyPreviewInputError);
  }
  expect(validateSingleProxyPreviewInput({ ...request, proxy: { ...proxy, user: " 密 ", pass: " 密:@/% " }, requiresAuthentication: true }).proxy).toMatchObject({ user: "密", pass: " 密:@/% " });
  expect(validateSingleProxyCredentials("socks5", "密".repeat(85), "密".repeat(85))).toMatchObject({ user: "密".repeat(85), pass: "密".repeat(85) });
});

test("HTTP credentials preserve passwords and errors do not quote supplied secrets", () => {
  expect(validateSingleProxyCredentials("http", " operator ", undefined)).toEqual({ user: "operator", pass: "" });
  expect(validateSingleProxyCredentials("http", "operator", " :@/% ")).toEqual({ user: "operator", pass: " :@/% " });
  expect(() => validateSingleProxyCredentials("http", "operator:bad", "")).toThrow("HTTP proxy usernames cannot contain a colon.");
  expect(() => validateSingleProxyCredentials("http", undefined, "hidden credential")).toThrow("Enter a username before adding a proxy password.");
  expect(() => validateSingleProxyCredentials("http", "operator", "hidden\ncredential")).toThrow("Proxy credentials are too long or contain unsupported characters.");
  expect(() => validateSingleProxyCredentials("http", "密".repeat(342), "")).toThrow(SingleProxyPreviewInputError);
});
