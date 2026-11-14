import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { backgroundQaArgs, compareBackgroundTrials, freshPreferences, NETLOG_MAX_BYTES, ownedQaPath, parseBackgroundOptions, requestClass, summarizeNetLog, type BackgroundTrialMetric } from "./qa-network-background-evidence.ts";

describe("bounded, synthetic background-network QA", () => {
  test("requires at least three pairs and bounds observation; unknown/sensitive/path options cannot enter", () => {
    expect(parseBackgroundOptions([])).toEqual({ pairs: 3, observeMs: 10_000 });
    expect(parseBackgroundOptions(["--pairs=5", "--observe-ms=15000"])).toEqual({ pairs: 5, observeMs: 15_000 });
    for (const args of [["--pairs=2"], ["--pairs=6"], ["--observe-ms=4999"], ["--observe-ms=15001"], ["--observe-ms=1e4"], ["--pairs=3", "--pairs=4"], ["--binary=C:/user/chrome.exe"], ["--output=C:/user"], ["--net-log-capture-mode=IncludeSensitive"], ["--unsafeDisableIdentityGates=1"]]) {
      expect(() => parseBackgroundOptions(args)).toThrow();
    }
  });

  test("writes require a strict owned child; traversal/root aliases are rejected", () => {
    const root = resolve("reports/network-background-qa/synthetic-test");
    expect(ownedQaPath(root, "pair-1", "network.json")).toBe(resolve(root, "pair-1/network.json"));
    for (const parts of [[], ["."], [".."], ["../sibling"], [resolve(root, "..", "other-run")]]) expect(() => ownedQaPath(root, ...parts)).toThrow();
  });

  test("candidate changes only the documented numeric preference; common logging retains private stripping and bounds", () => {
    expect(freshPreferences("baseline")).toEqual({});
    expect(freshPreferences("no-preloading")).toEqual({ net: { network_prediction_options: 2 } });
    const logPath = resolve("reports/network-background-qa/synthetic-test/network.json");
    expect(backgroundQaArgs(logPath, 10_000)).toEqual([
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      `--log-net-log=${logPath}`, "--net-log-max-size-mb=8", "--net-log-duration=30",
    ]);
    expect(() => backgroundQaArgs("network.json", 10_000)).toThrow();
    expect(() => backgroundQaArgs(logPath, Infinity)).toThrow();
  });
});

describe("privacy-minimizing NetLog attribution", () => {
  test("deduplicates a URL source, distinguishes synthetic capture and updater/time candidates, drops every sensitive field", () => {
    const source = (id: number) => ({ id, type: 1 });
    const raw = JSON.stringify({ constants: { logEventTypes: { URL_REQUEST_START_JOB: 10, URL_REQUEST_REDIRECTED: 11, "bad-secret-header-name": 12 } }, events: [
      { time: "1000", source: source(1), type: 10, params: { url: "http://clients2.google.com/time/1/current?secret=query-value", headers: ["Authorization: header-value"] } },
      { time: "1001", source: source(1), type: 11, params: { url: "http://clients2.google.com/time/1/current?secret=other", cookie: "cookie-value" } },
      { time: "1002", source: source(2), type: 10, params: { url: "https://user:password-value@fingerprint.aliasmode.invalid/?private=capture-query" } },
      { time: "1003", source: source(3), type: 10, params: { url: "https://update.googleapis.com/service/update2/json?payload=private-payload" } },
      { time: "1004", source: source(4), type: 10, params: { url: "http://maobu-engine-qa.test:32001/roundtrip?private=local-query" } },
      { time: "1005", source: source(5), type: 12, params: { url: "https://accounts.google.com/private-user-path?account=private-account" } },
      { time: "1006", source: source(6), type: 10, params: { url: "file:///C:/Users/private-file" } },
      { time: "1007", source: source(7), type: 10, params: { url: "https://www.google.com/private-query-path?account=secret" } },
    ] });
    const summary = summarizeNetLog(raw);
    expect(summary.available).toBe(true); expect(summary.eventCount).toBe(8); expect(summary.urlSources).toHaveLength(6);
    expect(summary.urlSources[0]).toEqual({ sourceId: 1, host: "clients2.google.com", port: 80, category: "chromium-network-time-candidate", firstEventMs: 0, eventTypes: ["URL_REQUEST_START_JOB", "URL_REQUEST_REDIRECTED"] });
    expect(summary.sourceCountsByCategory["synthetic-fingerprint-capture"]).toBe(1);
    expect(summary.sourceCountsByCategory["chromium-component-update-candidate"]).toBe(1);
    expect(summary.urlSources.find(item => item.sourceId === 5)?.eventTypes).toEqual(["UNKNOWN_EVENT"]);
    const serialized = JSON.stringify(summary);
    for (const secret of ["query-value", "header-value", "cookie-value", "password-value", "capture-query", "private-payload", "local-query", "private-user-path", "private-account", "private-query-path", "private-file", "bad-secret-header-name"]) expect(serialized).not.toContain(secret);
  });

  test("missing/truncated/oversized logs are unavailable rather than evidence of zero requests", () => {
    for (const input of ["", "{\"events\":[", "null", "{}", '{"events":[]}', '{"events":[],"constants":{"logEventTypes":null}}', '{"events":[],"constants":{"logEventTypes":[]}}']) expect(summarizeNetLog(input).available).toBe(false);
    expect(summarizeNetLog(" ".repeat(NETLOG_MAX_BYTES + 1)).reason).toBe("size-limit");
    expect(summarizeNetLog('{"constants":{"logEventTypes":{}},"events":[]}')).toMatchObject({ available: true, eventCount: 0, urlSources: [] });
  });

  test("hostname alone does not prove a network-time/updater subsystem or classify a generic Google URL", () => {
    expect(requestClass("clients2.google.com", "/other")).toBe("other");
    expect(requestClass("update.googleapis.com", "/unrelated")).toBe("other");
    expect(requestClass("www.google.com", "/")).toBe("google-unattributed");
  });
});

describe("paired interpretation", () => {
  const metric = (pair: number, arm: BackgroundTrialMetric["arm"], count: number): BackgroundTrialMetric => ({ pair, arm, passed: true, googleAttempts: count, syntheticAttempts: 2, observedMs: 10_000, startupMs: 1_000, navigationMs: 20 });
  const complete = [1, 2, 3].flatMap(pair => [metric(pair, "baseline", 10), metric(pair, "no-preloading", 8)]);
  test("never silently accepts missing/duplicate/failed pairs", () => {
    expect(() => compareBackgroundTrials([], 0)).toThrow();
    expect(compareBackgroundTrials(complete, 3)).toMatchObject({ valid: true, consistentReduction: true, productionPolicyChanged: false });
    for (const trials of [complete.slice(1), [...complete, complete[0]!], complete.map((item, index) => index ? item : { ...item, passed: false })]) expect(compareBackgroundTrials(trials, 3)).toMatchObject({ valid: false, consistentReduction: false });
  });
  test("an unchanged or mixed pair cannot become a claimed reduction", () => {
    const trials = complete.map(item => item.pair === 2 && item.arm === "no-preloading" ? { ...item, googleAttempts: 10 } : item);
    expect(compareBackgroundTrials(trials, 3)).toMatchObject({ valid: true, consistentReduction: false, interpretation: "no-consistent-reduction-demonstrated" });
  });
});
