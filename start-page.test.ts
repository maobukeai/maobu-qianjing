import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAppSettings, parseAppSettings, resolveOpenStartPageOnLaunch } from "./app-settings.ts";
import { renderStartPageHtml, START_PAGE_FILENAME, writeProfileStartPage } from "./src/launcher/start-page.ts";
import type { Profile } from "./types.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "prof-test-1",
    accId: "acc-1",
    name: "Shop <script>alert(1)</script> Alpha",
    group: "US & EU",
    username: "",
    password: "",
    twofa: "",
    proxy: {
      type: "http",
      host: "198.51.100.42",
      port: "8080",
      user: "sensitive-proxy-user",
      pass: "super-secret-proxy-pass",
    },
    ua: "",
    platformOs: "windows",
    screenWidth: 1920,
    screenHeight: 1080,
    timezone: "America/New_York",
    locale: "en-US",
    fingerprintSeed: 123456789,
    cookies: [],
    seeded: false,
    extensions: [],
    ...overrides,
  };
}

describe("local start page generator", () => {
  test("escapes HTML fields, strips proxy credentials, and stays zero-traffic", () => {
    const html = renderStartPageHtml({
      profile: makeProfile(),
      serial: 7,
      exitIp: "203.0.113.99",
      engineLabel: "Chromium 155",
      kernelVersion: "155.0.8059.85",
    });

    expect(html).toContain("#7 · Shop &lt;script&gt;alert(1)&lt;/script&gt; Alpha");
    expect(html).toContain("US &amp; EU");
    expect(html).toContain("http://198.51.100.42:8080");
    expect(html).toContain("203.0.113.99");
    expect(html).toContain("America/New_York");
    expect(html).toContain("en-US");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("sensitive-proxy-user");
    expect(html).not.toContain("super-secret-proxy-pass");
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).toContain('<html lang="zh-CN" data-theme="light">');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).not.toContain("prefers-color-scheme: dark");
    for (const url of [
      "https://www.browserscan.net/zh",
      "https://ping0.cc/",
      "https://ipcheck.ing/",
      "https://www.yalala.com/",
      "https://whoer.net/zh",
    ]) {
      expect(html).toContain(url);
    }
  });

  test("writeProfileStartPage writes maobu-start.html atomically and returns a file:// URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maobu-start-page-"));
    try {
      const url = await writeProfileStartPage(dir, {
        profile: makeProfile({ customNo: "88", proxy: null }),
        serial: 1,
        engineLabel: "Firefox",
      });
      expect(url.startsWith("file://")).toBe(true);
      const writtenPath = fileURLToPath(url);
      expect(writtenPath).toBe(join(dir, START_PAGE_FILENAME));
      const content = readFileSync(writtenPath, "utf8");
      expect(content).toContain("#88 · Shop");
      expect(content).toContain("直连 (未配置代理)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openStartPageOnLaunch settings", () => {
  test("defaults to true via resolver while keeping serialized default clean", () => {
    const def = defaultAppSettings();
    expect(def.network?.openStartPageOnLaunch).toBeUndefined();
    expect(resolveOpenStartPageOnLaunch(def.network)).toBe(true);

    const parsedFalse = parseAppSettings({
      ...def,
      network: { checkLocalProxyBeforeLaunch: false, openStartPageOnLaunch: false },
    });
    expect(parsedFalse.network?.openStartPageOnLaunch).toBe(false);
    expect(resolveOpenStartPageOnLaunch(parsedFalse.network)).toBe(false);

    const parsedTrue = parseAppSettings({
      ...def,
      network: { checkLocalProxyBeforeLaunch: false, openStartPageOnLaunch: true },
    });
    expect(parsedTrue.network?.openStartPageOnLaunch).toBe(true);
    expect(resolveOpenStartPageOnLaunch(parsedTrue.network)).toBe(true);

    expect(() =>
      parseAppSettings({
        ...def,
        network: { checkLocalProxyBeforeLaunch: false, openStartPageOnLaunch: "yes" },
      }),
    ).toThrow("Invalid network settings");
  });
});
