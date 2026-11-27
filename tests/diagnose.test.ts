import { test, expect } from "bun:test";
import { analyze, fingerprintProbe, loginProbe, runDiagnostics, webrtcProbe, type ProfileReport } from "../diagnose.ts";
import { runInNewContext } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import type { Profile } from "../types.ts";

test("fingerprint hashes read actual digest and audio bytes across a realm that forbids TypedArray element access", async () => {
  const canvasUrl = "data:image/png;base64,local-fixture";
  const data = new Float32Array(new ArrayBuffer(4024), 8, 1000);
  data[0] = -3; data[1] = 4; data[2] = 0.5;
  function xray(array: Float32Array): Float32Array {
    return new Proxy(array, { get(target, key) {
      if (key === Symbol.iterator || typeof key === "string" && /^\d+$/.test(key)) throw new Error("TypedArray element access over Xrays is forbidden");
      if (key === "slice") return (start: number, end: number) => xray(target.subarray(start, end));
      return Reflect.get(target, key, target);
    } });
  }
  class AudioContext {
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {} }; }
    createDynamicsCompressor() { return { connect() {} }; }
    async startRendering() { return { getChannelData: () => xray(data) }; }
  }
  const context = { textBaseline: "", font: "", fillStyle: "", fillRect() {}, fillText() {} };
  const sample = await runInNewContext(`(${fingerprintProbe.toString()})()`, {
    window: { OfflineAudioContext: AudioContext }, crypto: webcrypto, TextEncoder,
    Uint8Array: function (buffer: ArrayBuffer) { return new Proxy(new Uint8Array(buffer), { get(target, key) {
      if (key === Symbol.iterator || typeof key === "string" && /^\d+$/.test(key)) throw new Error("TypedArray element access over Xrays is forbidden");
      return Reflect.get(target, key, target);
    } }); },
    document: { createElement: () => ({ getContext: (kind: string) => kind === "2d" ? context : null, toDataURL: () => canvasUrl }) },
  });
  expect(sample.canvasHash).toBe(createHash("sha256").update(canvasUrl).digest("hex"));
  expect(sample.audioHash).toBe(createHash("sha256").update("7.5").digest("hex"));
  expect(sample.errors.canvas).toBeUndefined();
  expect(sample.errors.audio).toBeUndefined();
});

test("fingerprint probe retains audio rejection instead of waiting forever for oncomplete", async () => {
  class AudioContext {
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {} }; }
    createDynamicsCompressor() { return { connect() {} }; }
    async startRendering() { throw new Error("audio rendering failed"); }
  }
  const sample = await runInNewContext(`(${fingerprintProbe.toString()})()`, {
    window: { OfflineAudioContext: AudioContext },
  });
  expect(sample.errors.audio).toContain("audio rendering failed");
  expect(sample.audioHash).toBeUndefined();
});

function report(over: Partial<ProfileReport>): ProfileReport {
  return {
    profileId: "p",
    ok: true,
    proxyConfigured: { host: "1.2.3.4", port: "8080" },
    screenConfigured: { width: 1920, height: 1080 },
    egress: { ip: "1.2.3.4" },
    fingerprint: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143", uaDataPlatform: "Windows", canvasHash: "aaa", audioHash: "x1", webglRenderer: "ANGLE (NVIDIA)" },
    login: { loggedIn: true, loggedOut: false },
    ...over,
  };
}

const SCREEN = (w: number, h: number) => ({ width: w, height: h, availWidth: w, availHeight: h - 40, colorDepth: 24, dpr: 1 });

const REAL_IP = "9.9.9.9";

test("equal browser and system exits report unconfirmed isolation rather than a proven proxy bypass", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: REAL_IP } })], REAL_IP);
  expect(a.proxy.bypassed).toEqual(["p1"]);
  expect(a.proxy.ok).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("exit isolation is unconfirmed"))).toBe(true);
  expect(a.verdicts.some((v) => v.includes("PROXY BYPASSED"))).toBe(false);
});

test("shared browser exits retain independent WebRTC baseline exposure evidence", () => {
  const sharedOnly = analyze([report({ profileId: "shared", egress: { ip: REAL_IP }, webrtcIps: [] })], REAL_IP);
  expect(sharedOnly.webrtcLeaks).toEqual([]);
  expect(sharedOnly.verdicts.some(line => line.includes("exit isolation is unconfirmed"))).toBe(true);
  const exposed = analyze([report({ profileId: "exposed", egress: { ip: REAL_IP }, webrtcIps: [REAL_IP] })], REAL_IP);
  expect(exposed.webrtcLeaks).toEqual(["exposed"]);
  expect(exposed.verdicts.some(line => line.includes("WebRTC leaks real IP on: exposed"))).toBe(true);
});

test("missing baseline IP makes proxy bypass inconclusive, not ok", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: "1.2.3.4" } })], undefined);
  expect(a.proxy.inconclusive).toEqual(["p1"]);
  expect(a.proxy.ok).toEqual([]);
  expect(a.proxy.bypassed).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("could NOT be checked"))).toBe(true);
});

test("proxy ok and matchesConfiguredHost when egress is the proxy host", () => {
  const a = analyze([report({ profileId: "p1", egress: { ip: "1.2.3.4" } })], REAL_IP);
  expect(a.proxy.ok).toEqual(["p1"]);
  expect(a.proxy.matchesConfiguredHost).toEqual(["p1"]);
  expect(a.proxy.bypassed).toEqual([]);
});

test("no egress captured is reported, not treated as ok", () => {
  const a = analyze([report({ profileId: "p1", egress: null })], REAL_IP);
  expect(a.proxy.noEgress).toEqual(["p1"]);
});

test("detects WebRTC real-IP leak", () => {
  const a = analyze([report({ profileId: "p1", webrtcIps: ["192.168.1.5", REAL_IP] })], REAL_IP);
  expect(a.webrtcLeaks).toEqual(["p1"]);
  const clean = analyze([report({ profileId: "p2", webrtcIps: ["192.168.1.5"] })], REAL_IP);
  expect(clean.webrtcLeaks).toEqual([]);
});

test("detects canvas fingerprint collisions across profiles", () => {
  const a = analyze(
    [
      report({ profileId: "p1", fingerprint: { canvasHash: "same", audioHash: "a1" } }),
      report({ profileId: "p2", fingerprint: { canvasHash: "same", audioHash: "a2" } }),
      report({ profileId: "p3", fingerprint: { canvasHash: "unique", audioHash: "a3" } }),
    ],
    REAL_IP,
  );
  expect(a.fingerprintCollisions.canvas.length).toBe(1);
  expect(a.fingerprintCollisions.canvas[0]!.profiles.sort()).toEqual(["p1", "p2"]);
  expect(a.verdicts.some((v) => v.includes("canvas fingerprint COLLISION"))).toBe(true);
});

test("unique canvas hashes produce no collision", () => {
  const a = analyze(
    [
      report({ profileId: "p1", fingerprint: { canvasHash: "h1" } }),
      report({ profileId: "p2", fingerprint: { canvasHash: "h2" } }),
    ],
    REAL_IP,
  );
  expect(a.fingerprintCollisions.canvas).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("canvas fingerprints unique"))).toBe(true);
});

test("flags fingerprint that changes across relaunch", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { canvasHash: "first" }, fingerprintRelaunch: { canvasHash: "second" } })],
    REAL_IP,
  );
  expect(a.unstableFingerprints).toEqual(["p1"]);
});

test("stable fingerprint across relaunch is not flagged", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { canvasHash: "same" }, fingerprintRelaunch: { canvasHash: "same" } })],
    REAL_IP,
  );
  expect(a.unstableFingerprints).toEqual([]);
});

test("flags UA vs UA-CH platform mismatch", () => {
  const a = analyze(
    [report({ profileId: "p1", fingerprint: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143", uaDataPlatform: "macOS", canvasHash: "h" } })],
    REAL_IP,
  );
  expect(a.uaInconsistencies.length).toBe(1);
  expect(a.uaInconsistencies[0]!.profileId).toBe("p1");
});

test("flags a screen resolution mismatch between configured and reported", () => {
  const a = analyze(
    [
      report({
        profileId: "p1",
        screenConfigured: { width: 1920, height: 1080 },
        fingerprint: { canvasHash: "h", screen: SCREEN(1366, 768) },
      }),
    ],
    REAL_IP,
  );
  expect(a.screenMismatches.length).toBe(1);
  expect(a.screenMismatches[0]!.seen).toBe("1366x768");
  expect(a.screenMismatches[0]!.configured).toBe("1920x1080");
  expect(a.verdicts.some((v) => v.includes("screen resolution mismatch"))).toBe(true);
});

test("matching screen resolution is not flagged and reports a pass", () => {
  const a = analyze(
    [
      report({
        profileId: "p1",
        screenConfigured: { width: 1920, height: 1080 },
        fingerprint: { canvasHash: "h", screen: SCREEN(1920, 1080) },
      }),
    ],
    REAL_IP,
  );
  expect(a.screenMismatches).toEqual([]);
  expect(a.verdicts.some((v) => v.includes("screen resolution matches"))).toBe(true);
});

test("tallies login state", () => {
  const a = analyze(
    [
      report({ profileId: "p1", login: { loggedIn: true, loggedOut: false } }),
      report({ profileId: "p2", login: { loggedIn: false, loggedOut: true } }),
      report({ profileId: "p3", login: { loggedIn: false, loggedOut: false } }),
    ],
    REAL_IP,
  );
  expect(a.login.loggedIn).toEqual(["p1"]);
  expect(a.login.loggedOut).toEqual(["p2"]);
  expect(a.login.unknown).toEqual(["p3"]);
});

test("equivalent IPv6 and IPv4-mapped addresses cannot evade bypass or WebRTC checks", () => {
  const ipv6 = analyze([report({ profileId: "v6", egress: { ip: "2001:db8:0:0:0:0:0:1" }, webrtcIps: ["2001:db8::1"] })], "2001:db8::1");
  expect(ipv6.proxy.bypassed).toEqual(["v6"]);
  expect(ipv6.webrtcLeaks).toEqual(["v6"]);
  const mapped = analyze([report({ profileId: "mapped", egress: { ip: "::ffff:192.0.2.1" }, webrtcIps: ["::ffff:c000:201"] })], "192.0.2.1");
  expect(mapped.proxy.bypassed).toEqual(["mapped"]);
  expect(mapped.webrtcLeaks).toEqual(["mapped"]);
});

test("direct system routing is not a configured proxy bypass or WebRTC proxy leak", () => {
  const a = analyze([report({ profileId: "direct", proxyConfigured: null, egress: { ip: REAL_IP }, webrtcIps: [REAL_IP] })], REAL_IP);
  expect(a.proxy.notConfigured).toEqual(["direct"]);
  expect(a.proxy.bypassed).toEqual([]);
  expect(a.proxy.ok).toEqual([]);
  expect(a.webrtcLeaks).toEqual([]);
  expect(a.webrtcCoverage.notApplicable).toEqual(["direct"]);
  expect(a.verdicts.some((line) => line.includes("PROXY BYPASSED"))).toBe(false);
});

test("invalid egress and baseline literals never produce successful routing evidence", () => {
  const missing = analyze([report({ egress: { ip: "ip lookup failed" } })], REAL_IP);
  expect(missing.proxy.noEgress).toEqual(["p"]);
  expect(missing.proxy.ok).toEqual([]);
  const invalidBaseline = analyze([report({ webrtcIps: ["1.2.3.4"] })], "not-an-ip");
  expect(invalidBaseline.proxy.inconclusive).toEqual(["p"]);
  expect(invalidBaseline.webrtcCoverage.inconclusive).toEqual(["p"]);
});

test("WebRTC without a baseline or candidate evidence reports inconclusive", () => {
  for (const webrtcIps of [undefined, [], ["masked.local"], ["bad-address"]]) {
    const a = analyze([report({ webrtcIps })], REAL_IP);
    expect(a.webrtcCoverage.inconclusive).toEqual(["p"]);
    expect(a.webrtcCoverage.checked).toEqual([]);
    expect(a.verdicts.some((line) => line.startsWith("✅") && line.includes("WebRTC"))).toBe(false);
  }
  const a = analyze([report({ webrtcIps: ["192.168.1.2"] })]);
  expect(a.webrtcCoverage.inconclusive).toEqual(["p"]);
});

test("successful measured subsets cannot hide profiles with missing proxy or canvas evidence", () => {
  const a = analyze([
    report({ profileId: "measured1", fingerprint: { canvasHash: "one" } }),
    report({ profileId: "measured2", fingerprint: { canvasHash: "two" } }),
    report({ profileId: "missing", egress: null, fingerprint: null }),
  ], REAL_IP);
  expect(a.fingerprintCoverage.canvas).toEqual(["measured1", "measured2"]);
  expect(a.verdicts.some((line) => line.includes("canvas uniqueness is unmeasured on 1"))).toBe(true);
  expect(a.verdicts.some((line) => line.includes("no egress IP captured for 1"))).toBe(true);
  expect(a.verdicts.some((line) => line.includes("all 3"))).toBe(false);
});

test("zero or one measured canvas cannot pass cross-profile uniqueness", () => {
  for (const profiles of [[], [report({ fingerprint: null })], [report({ fingerprint: { canvasHash: "one" } })]]) {
    const a = analyze(profiles, REAL_IP);
    expect(a.verdicts.some((line) => line.startsWith("✅") && line.includes("canvas"))).toBe(false);
    expect(a.verdicts.some((line) => line.includes("needs at least two measured"))).toBe(true);
  }
});

test("relaunch stability includes audio, screen and graphics, with missing probes inconclusive", () => {
  for (const [first, second] of [
    [{ audioHash: "a" }, { audioHash: "b" }],
    [{ screen: SCREEN(1920, 1080) }, { screen: SCREEN(1440, 900) }],
    [{ webglRenderer: "GPU A" }, { webglRenderer: "GPU B" }],
  ]) {
    const a = analyze([report({ fingerprint: first, fingerprintRelaunch: second })], REAL_IP);
    expect(a.unstableFingerprints).toEqual(["p"]);
  }
  const missing = analyze([report({ fingerprint: { canvasHash: "same", audioHash: "first" }, fingerprintRelaunch: { canvasHash: "same" } })], REAL_IP);
  expect(missing.stability.inconclusive).toEqual(["p"]);
  expect(missing.stability.checked).toEqual([]);
  expect(missing.unstableFingerprints).toEqual([]);
  const notStarted = analyze([report({ relaunchRequested: true })], REAL_IP);
  expect(notStarted.stability.inconclusive).toEqual(["p"]);
});

test("WebRTC probe closes resources on offer rejection and does not leak an unhandled promise", async () => {
  let closed = 0;
  let cleared = 0;
  class Connection {
    onicecandidate: any;
    createDataChannel() {}
    async createOffer() { throw new Error("offer rejected"); }
    async setLocalDescription() {}
    close() { closed++; }
  }
  const candidates = await runInNewContext(`(${webrtcProbe.toString()})()`, {
    RTCPeerConnection: Connection, setTimeout: () => 1, clearTimeout: () => { cleared++; },
  });
  expect(candidates).toEqual([]);
  expect(closed).toBe(1);
  expect(cleared).toBe(1);
});

test("WebRTC candidate parser retains compressed IPv6 and skips mDNS hostnames", async () => {
  let closed = 0;
  class Connection {
    onicecandidate: any;
    createDataChannel() {}
    async createOffer() { return {}; }
    async setLocalDescription() {
      this.onicecandidate({ candidate: { candidate: "candidate:abc123 1 udp 2122260223 2001:db8::1 5000 typ host" } });
      this.onicecandidate({ candidate: { candidate: "candidate:abc124 1 udp 2122260223 hidden.LOCAL 5000 typ host", address: "hidden.LOCAL" } });
      this.onicecandidate({ candidate: null });
    }
    close() { closed++; }
  }
  const candidates = await runInNewContext(`(${webrtcProbe.toString()})()`, {
    RTCPeerConnection: Connection, setTimeout: () => 1, clearTimeout: () => {},
  });
  expect(candidates).toEqual(["2001:db8::1"]);
  expect(closed).toBe(1);
});

const diagnosticProfile: Profile = {
  id: "diag0001", accId: "", name: "Diagnostic fixture", group: "", username: "", password: "", twofa: "", ua: "", timezone: "UTC",
  proxy: { type: "http", host: "proxy.example", port: "8080", user: "", pass: "" },
  screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 123, cookies: [], seeded: false,
};

test("unconfirmed teardown cannot be measured as a successful relaunch", async () => {
  const calls: string[] = [];
  const firstSample = report({ fingerprint: { canvasHash: "original" } });
  const result = await runDiagnostics({ baseUrl: "http://127.0.0.1:50400", profiles: [diagnosticProfile], relaunch: true, log: () => {} }, {
    baseline: async () => REAL_IP,
    fetchFn: (async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      return path.endsWith("/start") ? Response.json({ code: 0, data: { ws: { puppeteer: "ws://fixture" }, debug_port: "9000" } })
        : Response.json({ code: -1, msg: "teardown unconfirmed" });
    }) as typeof fetch,
    sample: async () => ({ fingerprint: firstSample.fingerprint, egress: firstSample.egress, webrtcIps: [], login: null }),
  });
  expect(calls.filter((path) => path.endsWith("/start"))).toHaveLength(1);
  expect(result.profiles[0]!.fingerprint?.canvasHash).toBe("original");
  expect(result.profiles[0]!.ok).toBe(true);
  expect(result.profiles[0]!.fingerprintRelaunch).toBeNull();
  expect(result.analysis.stability.inconclusive).toEqual([diagnosticProfile.id]);
});

test("failed second probe preserves the valid first sample and reports inconclusive stability", async () => {
  let samples = 0;
  let stops = 0;
  const result = await runDiagnostics({ baseUrl: "http://127.0.0.1:50400", profiles: [diagnosticProfile], relaunch: true, log: () => {} }, {
    baseline: async () => REAL_IP,
    fetchFn: (async (input) => {
      if (new URL(String(input)).pathname.endsWith("/stop")) { stops++; return Response.json({ code: 0 }); }
      return Response.json({ code: 0, data: { ws: { puppeteer: "ws://fixture" }, debug_port: "9000" } });
    }) as typeof fetch,
    sample: async () => {
      if (++samples === 2) throw new Error("second probe failed");
      return { fingerprint: { canvasHash: "original" }, egress: { ip: "1.2.3.4" }, webrtcIps: [], login: null };
    },
  });
  expect(samples).toBe(2);
  expect(stops).toBe(2);
  expect(result.profiles[0]!.fingerprint?.canvasHash).toBe("original");
  expect(result.profiles[0]!.ok).toBe(true);
  expect(result.analysis.stability.inconclusive).toEqual([diagnosticProfile.id]);
});

test("fingerprintProbe captures WebGPU, ClientRects, MediaDevices, SpeechSynthesis and leak indicators", async () => {
  const probeEl = {
    textContent: "",
    style: { cssText: "" },
    getBoundingClientRect: () => ({ x: 12.5, y: 20, width: 140.25, height: 18.5, top: 20, left: 12.5 }),
    remove() {},
  };
  const sample = await runInNewContext(`(${fingerprintProbe.toString()})()`, {
    window: {},
    crypto: webcrypto,
    TextEncoder,
    RTCPeerConnection: function () {},
    navigator: {
      userAgent: "Mozilla/5.0",
      gpu: {
        requestAdapter: async () => ({ info: { vendor: "angle-gpu", architecture: "rdna3", description: "Radeon" } }),
      },
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", label: "" },
          { kind: "videoinput", label: "HD Camera" },
          { kind: "audiooutput", label: "" },
        ],
      },
      connection: { effectiveType: "4g" },
    },
    speechSynthesis: {
      getVoices: () => [
        { name: "Voice A", lang: "en-US", localService: true, default: true },
        { name: "Voice B", lang: "zh-CN", localService: false, default: false },
      ],
    },
    document: {
      body: { appendChild() {} },
      createElement: () => probeEl,
    },
  });
  expect(sample.webgpu).toEqual({ available: true, vendor: "angle-gpu", architecture: "rdna3", description: "Radeon" });
  expect(sample.clientRects).toMatchObject({ width: 140.25, height: 18.5, consistent: true });
  expect(typeof sample.clientRects?.hash).toBe("string");
  expect(sample.mediaDevices).toEqual({ count: 3, audioInput: 1, videoInput: 1, audioOutput: 1, labelsExposed: true });
  expect(sample.speechVoices).toMatchObject({ count: 2, defaultVoice: "Voice A" });
  expect(typeof sample.speechVoices?.hash).toBe("string");
  expect(sample.leakIndicators).toEqual({ webrtcApiPresent: true, rtcIceGathererPresent: false, connectionType: "4g" });

  const a = analyze([report({ profileId: "p1", fingerprint: sample, webrtcIps: [REAL_IP] })], REAL_IP);
  expect(a.fingerprintCoverage.webgpu).toEqual(["p1"]);
  expect(a.fingerprintCoverage.clientRects).toEqual(["p1"]);
  expect(a.fingerprintCoverage.mediaDevices).toEqual(["p1"]);
  expect(a.fingerprintCoverage.speechVoices).toEqual(["p1"]);
  expect(a.leakIndicators.webrtcExposed).toEqual(["p1"]);
  expect(a.leakIndicators.webrtcApiActive).toEqual(["p1"]);
  expect(a.leakIndicators.mediaLabelsExposed).toEqual(["p1"]);
  expect(a.leakIndicators.dnsRiskProfiles).toEqual(["p1"]);
});

test("loginProbe supports generic and custom selectors alongside x.com compatibility", async () => {
  const genericLoggedOut = await runInNewContext(`(${loginProbe.toString()})()`, {
    location: { href: "https://erp.example.com/signin", hostname: "erp.example.com" },
    document: {
      title: "Sign in",
      querySelector: (sel: string) => sel.includes('input[type="password"]') ? {} : null,
    },
  });
  expect(genericLoggedOut).toMatchObject({ loggedIn: false, loggedOut: true });

  const customLoggedIn = await runInNewContext(
    `(${loginProbe.toString()})(${JSON.stringify({ selectors: { loggedIn: ["#user-badge"] } })})`,
    {
      location: { href: "https://erp.example.com/dashboard", hostname: "erp.example.com" },
      document: {
        title: "Dashboard",
        querySelector: (sel: string) => sel === "#user-badge" ? {} : null,
      },
    },
  );
  expect(customLoggedIn).toMatchObject({ loggedIn: true, loggedOut: false });

  const xLoggedIn = await runInNewContext(`(${loginProbe.toString()})()`, {
    location: { href: "https://x.com/home", hostname: "x.com" },
    document: {
      title: "Home / X",
      querySelector: (sel: string) => sel.includes("SideNav_NewTweet_Button") ? {} : null,
    },
  });
  expect(xLoggedIn).toMatchObject({ loggedIn: true, loggedOut: false });
});
