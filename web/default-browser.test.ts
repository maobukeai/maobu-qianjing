import { describe, expect, test } from "bun:test";
import type { UiProfile } from "./api.ts";
import {
  buildPickerCandidates,
  DEFAULT_BROWSER_ROUTING_CONFIG,
  matchDomainRule,
  normalizeRuleDomain,
  parseExternalHttpUrl,
  resolveExternalUrlRoute,
  upsertDomainRule,
} from "./default-browser.ts";

function makeProfile(id: string, overrides: Partial<UiProfile> = {}): UiProfile {
  return {
    id,
    name: `Env ${id}`,
    engine: "chromium",
    group: "",
    platform: "",
    tags: [],
    proxy: null,
    timezone: "UTC",
    cookieCount: 0,
    seeded: false,
    screen: "1920x1080",
    has2fa: false,
    running: false,
    serial: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

describe("default browser URL & domain helpers", () => {
  test("validates only http:// and https:// URLs", () => {
    expect(parseExternalHttpUrl("https://Mail.Google.com/a?x=1")).toEqual({
      url: "https://mail.google.com/a?x=1",
      hostname: "mail.google.com",
    });
    expect(parseExternalHttpUrl("http://localhost:3000/callback")).toEqual({
      url: "http://localhost:3000/callback",
      hostname: "localhost",
    });
    expect(parseExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseExternalHttpUrl("file:///C:/test.html")).toBeNull();
    expect(parseExternalHttpUrl("not a url")).toBeNull();
  });

  test("normalizes domains and matches exact rules before wildcards", () => {
    expect(normalizeRuleDomain("HTTPS://Sub.GitHub.COM/org/repo")).toBe("sub.github.com");
    expect(normalizeRuleDomain("*.github.com")).toBe("*.github.com");
    expect(normalizeRuleDomain("bad.*.com")).toBeNull();
    expect(normalizeRuleDomain("two words")).toBeNull();

    const rules = [
      { domain: "*.google.com", profileId: "p-wild" },
      { domain: "mail.google.com", profileId: "p-mail" },
      { domain: "*.ads.google.com", profileId: "p-ads" },
    ];
    expect(matchDomainRule("mail.google.com", rules)?.profileId).toBe("p-mail");
    expect(matchDomainRule("console.ads.google.com", rules)?.profileId).toBe("p-ads");
    expect(matchDomainRule("docs.google.com", rules)?.profileId).toBe("p-wild");
    expect(matchDomainRule("google.com", rules)).toBeNull();
  });
});

describe("resolveExternalUrlRoute", () => {
  const p1 = makeProfile("p1", { name: "US Shop", running: true });
  const p2 = makeProfile("p2", { name: "EU Billing", running: true });
  const p3 = makeProfile("p3", { name: "Stopped Vault", running: false });

  test("opens directly on domain rule match regardless of mode", () => {
    const config = upsertDomainRule(
      { ...DEFAULT_BROWSER_ROUTING_CONFIG, mode: "always-ask" },
      "billing.example.com",
      "p3",
    );
    const decision = resolveExternalUrlRoute("https://billing.example.com/invoice", [p1, p2, p3], config);
    expect(decision).toMatchObject({
      action: "open",
      reason: "domain-rule",
      ruleDomain: "billing.example.com",
    });
    if (decision.action === "open") expect(decision.profile.id).toBe("p3");
  });

  test("smart mode auto-opens when exactly 1 profile is running and asks when 0 or 2+", () => {
    const singleDecision = resolveExternalUrlRoute(
      "https://example.com/",
      [p1, { ...p2, running: false }, p3],
      DEFAULT_BROWSER_ROUTING_CONFIG,
    );
    expect(singleDecision).toMatchObject({ action: "open", reason: "single-running" });

    const multiDecision = resolveExternalUrlRoute(
      "https://example.com/",
      [p1, p2, p3],
      DEFAULT_BROWSER_ROUTING_CONFIG,
    );
    expect(multiDecision).toMatchObject({ action: "pick", reason: "multiple-running" });

    const noneDecision = resolveExternalUrlRoute(
      "https://example.com/",
      [{ ...p1, running: false }, p3],
      DEFAULT_BROWSER_ROUTING_CONFIG,
    );
    expect(noneDecision).toMatchObject({ action: "pick", reason: "no-running" });
  });

  test("fixed-profile mode opens bound profile directly and falls back to picker if missing", () => {
    const fixedConfig = {
      ...DEFAULT_BROWSER_ROUTING_CONFIG,
      mode: "fixed-profile" as const,
      defaultProfileId: "p3",
    };
    const hit = resolveExternalUrlRoute("https://news.ycombinator.com", [p1, p3], fixedConfig);
    expect(hit).toMatchObject({ action: "open", reason: "fixed-profile" });

    const missing = resolveExternalUrlRoute(
      "https://news.ycombinator.com",
      [p1],
      fixedConfig,
    );
    expect(missing).toMatchObject({ action: "pick", reason: "missing-fixed-profile" });
  });
});

describe("buildPickerCandidates", () => {
  test("hides bulk stopped profiles by default on 120 profiles and supports search + runningOnly", () => {
    const roster: UiProfile[] = [
      makeProfile("run-1", { name: "Amazon US #1", running: true, lastOpenAt: 500, group: "Amazon" }),
      makeProfile("run-2", { name: "Shopify UK", running: true, lastOpenAt: 900, group: "Shopify" }),
      makeProfile("fav-1", { name: "VIP Starred", running: false, serial: 3 }),
    ];
    for (let i = 4; i <= 120; i++) {
      roster.push(
        makeProfile(`stop-${i}`, {
          name: i === 88 ? "Special TikTok Store" : `Stopped Profile ${i}`,
          running: false,
          serial: i,
          tags: i === 88 ? ["tiktok", "vip"] : [],
        }),
      );
    }
    const favs = new Set(["fav-1"]);

    const initial = buildPickerCandidates(roster, favs, "", false);
    expect(initial.running.map((p) => p.id)).toEqual(["run-2", "run-1"]);
    expect(initial.favorites.map((p) => p.id)).toEqual(["fav-1"]);
    expect(initial.hiddenStoppedCount).toBe(117);

    const runningOnly = buildPickerCandidates(roster, favs, "", true);
    expect(runningOnly.running.length).toBe(2);
    expect(runningOnly.favorites.length).toBe(0);

    const searchedAll = buildPickerCandidates(roster, favs, "tiktok", false);
    expect(searchedAll.searchMatches.map((p) => p.id)).toEqual(["stop-88"]);

    const searchedRunning = buildPickerCandidates(roster, favs, "tiktok", true);
    expect(searchedRunning.searchMatches).toEqual([]);
  });
});
