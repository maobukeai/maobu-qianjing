import { afterEach, describe, expect, test } from "bun:test";
import { buildNewProfile } from "../src/create.ts";
import {
  clearProfileEvents,
  inferLaunchFailureRecoveryKind,
  listProfileEvents,
  MAX_PROFILE_EVENTS,
  recordProfileEvent,
  redactTimelineText,
  sanitizeTimelineDetail,
} from "../src/profile-timeline.ts";
import { ProfileStore } from "../src/store.ts";

const stores: ProfileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
});

function memStore(): ProfileStore {
  const store = new ProfileStore(":memory:");
  stores.push(store);
  return store;
}

describe("profile operation timeline", () => {
  test("redacts passwords, tokens, proxy auth, CDP URLs, and sensitive detail keys", () => {
    const raw =
      "Failed connecting via socks5://alice:SUPER_SECRET_PASS@1.2.3.4:1080 " +
      "ws://127.0.0.1:9222/devtools/browser/abc-123 Bearer eyJhbGciOiJIUzI1NiJ9.secret " +
      "password=MY_PASSWORD token=MY_TOKEN enc:v1:abc123 DPAPI:xyz789";
    const redacted = redactTimelineText(raw);
    for (const secret of [
      "SUPER_SECRET_PASS",
      "ws://127.0.0.1:9222",
      "eyJhbGciOiJIUzI1NiJ9",
      "MY_PASSWORD",
      "MY_TOKEN",
      "enc:v1:abc123",
      "DPAPI:xyz789",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED_WS]");
    expect(redacted).toContain("[REDACTED]");

    const { detail, json } = sanitizeTimelineDetail({
      fields: ["name", "proxy"],
      password: "PRIVATE_PASSWORD",
      proxyPass: "PRIVATE_PROXY_PASS",
      twofa: "PRIVATE_2FA",
      cookies: [{ name: "sid", value: "PRIVATE_COOKIE" }],
      ws: "ws://127.0.0.1:9222/devtools/browser/1",
      nested: {
        ok: true,
        api_key: "PRIVATE_API_KEY",
        note: "http://u:PRIVATE_URL_PASS@host.test",
      },
    });
    expect(detail.fields).toEqual(["name", "proxy"]);
    expect(detail.password).toBeUndefined();
    expect(detail.proxyPass).toBeUndefined();
    expect(detail.twofa).toBeUndefined();
    expect(detail.cookies).toBeUndefined();
    expect(detail.ws).toBeUndefined();
    expect(json).not.toContain("PRIVATE_");
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(2048);
  });

  test("enforces per-profile 200-event lazy retention and cursor pagination", () => {
    const store = memStore();
    const p1 = buildNewProfile({ name: "Timeline A" }, () => false);
    p1.id = "tl_a";
    const p2 = buildNewProfile({ name: "Timeline B" }, () => false);
    p2.id = "tl_b";
    store.upsertProfiles([p1, p2]);

    const baseTime = 1_795_000_000_000;
    for (let i = 1; i <= 215; i++) {
      recordProfileEvent(store, {
        profileId: "tl_a",
        eventType: i % 2 === 0 ? "launch.started" : "config.updated",
        status: "ok",
        actor: "user",
        summary: `Event #${i}`,
        createdAt: baseTime + i * 1000,
      });
    }
    recordProfileEvent(store, {
      profileId: "tl_b",
      eventType: "profile.created",
      status: "ok",
      actor: "user",
      summary: "Isolated profile event",
      createdAt: baseTime,
    });

    const first = listProfileEvents(store, "tl_a", { limit: 100 });
    expect(first.events).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.events[0]?.summary).toBe("Event #215");

    const second = listProfileEvents(store, "tl_a", { limit: 100, beforeId: first.nextBeforeId! });
    expect(second.events).toHaveLength(100);
    expect(second.hasMore).toBe(false);
    expect(second.events[99]?.summary).toBe("Event #16");

    // Verify exact 200 cap in SQLite.
    const totalA = store
      .rawDatabase()
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM profile_events WHERE profile_id = ?")
      .get("tl_a")!.n;
    expect(totalA).toBe(MAX_PROFILE_EVENTS);

    // Other profile events remain untouched.
    expect(listProfileEvents(store, "tl_b").events).toHaveLength(1);

    // Type filter works cleanly.
    const launchesOnly = listProfileEvents(store, "tl_a", { type: "launch.started", limit: 10 });
    expect(launchesOnly.events).toHaveLength(10);
    expect(launchesOnly.events.every((e) => e.eventType === "launch.started")).toBe(true);

    // Clear removes only target profile's events.
    expect(clearProfileEvents(store, "tl_a")).toBe(MAX_PROFILE_EVENTS);
    expect(listProfileEvents(store, "tl_a").events).toEqual([]);
    expect(listProfileEvents(store, "tl_b").events).toHaveLength(1);
  });

  test("preserves timeline on trashProfile and cascade-deletes on deleteProfile", () => {
    const store = memStore();
    const profile = buildNewProfile({ name: "Trashable" }, () => false);
    profile.id = "tl_trash";
    store.upsertProfile(profile);
    recordProfileEvent(store, {
      profileId: "tl_trash",
      eventType: "profile.created",
      status: "ok",
      summary: "Created",
    });

    expect(store.trashProfile("tl_trash")).toBe(true);
    expect(listProfileEvents(store, "tl_trash").events).toHaveLength(1);

    expect(store.deleteProfile("tl_trash")).toBe(true);
    expect(listProfileEvents(store, "tl_trash").events).toEqual([]);
  });

  test("never throws when the underlying store write fails", () => {
    const brokenStore = {
      rawDatabase() {
        throw new Error("disk full");
      },
      withTransaction() {
        throw new Error("disk full");
      },
    };
    expect(
      recordProfileEvent(brokenStore as any, {
        profileId: "safe_id",
        eventType: "launch.started",
        status: "ok",
        summary: "Should never throw",
      }),
    ).toBeNull();
  });

  test("infers appropriate contextual recovery kinds for launch failures", () => {
    expect(inferLaunchFailureRecoveryKind("Proxy 407 authentication failed")).toBe("proxy");
    expect(inferLaunchFailureRecoveryKind("Connection timed out resolving DNS")).toBe("network");
    expect(inferLaunchFailureRecoveryKind("Chromium binary is not installed")).toBe("runtime");
    expect(inferLaunchFailureRecoveryKind("Unexpected browser exit code 1")).toBe("retry_start");
  });
});
