import { afterEach, describe, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { createSyncSnapshot, sealSyncSnapshot } from "./encrypted-sync.ts";
import {
  applyProfilePackageImport,
  createProfilePackage,
  MAX_PROFILE_PACKAGE_PROFILES,
  openProfilePackage,
  PROFILE_PACKAGE_MAGIC,
  ProfilePackageError,
  ProfilePackagePreviewStore,
  sealProfilePackage,
  validateProfilePackage,
} from "./profile-package.ts";
import { listProfileEvents } from "./profile-timeline.ts";
import { ProfileStore } from "./store.ts";

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

function sampleProfile(id: string, name = `Env ${id}`) {
  const profile = buildNewProfile(
    {
      name,
      group: "Ops",
      username: `user_${id}`,
      password: `pass_${id}_secret`,
      email: `${id}@example.test`,
      emailPassword: `mail_${id}_secret`,
      twofa: "JBSWY3DPEHPK3PXP",
      proxy: { type: "socks5", host: "proxy.example.test", port: "1080", user: "px_user", pass: "px_secret" },
    },
    () => false,
  );
  profile.id = id;
  profile.tags = ["vip", "us"];
  profile.notes = "Operator memo\nLine 2";
  return profile;
}

const SAMPLE_SESSION = JSON.stringify({
  cookies: [{ name: "sid", value: "session_cookie_secret", domain: ".example.test", path: "/" }],
  origins: [{ origin: "https://example.test", localStorage: [{ name: "tok", value: "ls_secret" }] }],
  tabs: ["https://example.test/dashboard"],
});

const PASSWORD = "correct-package-password-123";

describe("encrypted .mqprofile package container", () => {
  test("seals with MAOBU-PROFILE magic, encrypts all secrets, and round-trips cleanly", async () => {
    const p1 = sampleProfile("pkg_001", "Alpha");
    const p2 = sampleProfile("pkg_002", "Beta");
    const payload = createProfilePackage([p1, p2], {
      sessions: new Map([[p1.id, SAMPLE_SESSION]]),
      includeSecrets: true,
      includeSessions: true,
      now: 1_795_000_000_000,
    });

    const sealed = await sealProfilePackage(payload, PASSWORD);
    expect(sealed.subarray(0, PROFILE_PACKAGE_MAGIC.length).equals(PROFILE_PACKAGE_MAGIC)).toBe(true);
    for (const secret of [
      "pass_pkg_001_secret",
      "mail_pkg_001_secret",
      "px_secret",
      "JBSWY3DPEHPK3PXP",
      "session_cookie_secret",
      "ls_secret",
      "Operator memo",
      PASSWORD,
    ]) {
      expect(sealed.includes(Buffer.from(secret))).toBe(false);
    }

    const opened = await openProfilePackage(sealed, PASSWORD);
    expect(opened).toEqual(payload);
    expect(opened.profiles[0]?.notes).toBe("Operator memo\nLine 2");

    // Rejects wrong password, tampered header/ciphertext, and .mqsync format confusion.
    await expect(openProfilePackage(sealed, "wrong-password-123")).rejects.toThrow("password and file integrity");
    for (const offset of [PROFILE_PACKAGE_MAGIC.length + 2, PROFILE_PACKAGE_MAGIC.length + 20, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[offset] = tampered[offset]! ^ 0xff;
      await expect(openProfilePackage(tampered, PASSWORD)).rejects.toThrow(ProfilePackageError);
    }
    const syncBytes = await sealSyncSnapshot(createSyncSnapshot([p1], {}), PASSWORD);
    await expect(openProfilePackage(syncBytes, PASSWORD)).rejects.toThrow("Unsupported encrypted profile package format");
  });

  test("includeSecrets=false strips credentials/proxy auth and includeSessions=false omits sessions", async () => {
    const p1 = sampleProfile("pkg_strip");
    const payload = createProfilePackage([p1], {
      sessions: { [p1.id]: SAMPLE_SESSION },
      includeSecrets: false,
      includeSessions: false,
    });
    const opened = await openProfilePackage(await sealProfilePackage(payload, PASSWORD), PASSWORD);
    const out = opened.profiles[0]!;
    expect(out.password).toBe("");
    expect(out.emailPassword).toBe("");
    expect(out.twofa).toBe("");
    expect(out.proxy?.host).toBe("proxy.example.test");
    expect(out.proxy?.user).toBe("");
    expect(out.proxy?.pass).toBe("");
    expect(out.notes).toBe("Operator memo\nLine 2");
    expect(opened.sessions).toEqual({});
  });

  test("enforces password UTF-8 byte limits (10..1024), profile count (<=2000), and schema validation", async () => {
    const p1 = sampleProfile("pkg_limit");
    const payload = createProfilePackage([p1]);

    await expect(sealProfilePackage(payload, "short9999")).rejects.toThrow("10 and 1024");
    await expect(sealProfilePackage(payload, "a".repeat(1025))).rejects.toThrow("10 and 1024");
    // Exact 10 bytes passes
    const sealed10 = await sealProfilePackage(payload, "0123456789");
    expect((await openProfilePackage(sealed10, "0123456789")).profiles).toHaveLength(1);

    expect(() => validateProfilePackage({ ...payload, profiles: [] })).toThrow(ProfilePackageError);
    expect(() =>
      validateProfilePackage({
        ...payload,
        profiles: Array.from({ length: MAX_PROFILE_PACKAGE_PROFILES + 1 }, () => p1),
      }),
    ).toThrow(ProfilePackageError);
    expect(() =>
      validateProfilePackage({
        ...payload,
        profiles: [{ ...p1, unsupportedField: "nope" }],
      }),
    ).toThrow(ProfilePackageError);
  });

  test("preview store enforces TTL, max 4 cap, workspace binding, HMAC token verification, and one-time consumption", async () => {
    const store = memStore();
    let now = 1_000_000;
    const previews = new ProfilePackagePreviewStore({ ttlMs: 60_000, maxEntries: 4, now: () => now });

    const p1 = sampleProfile("prev_1");
    const payload = createProfilePackage([p1], { sessions: { [p1.id]: SAMPLE_SESSION } });
    const raw = await sealProfilePackage(payload, PASSWORD);

    const created = previews.create(payload, raw, store, "ws-a");
    // Redacted preview never contains secrets.
    const serialized = JSON.stringify(created);
    for (const secret of ["pass_prev_1_secret", "px_secret", "session_cookie_secret", "JBSWY3DPEHPK3PXP"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(created.profiles[0]?.proxyDisplay).toBe("proxy.example.test:1080");

    // Wrong workspace or wrong token fails without consuming.
    expect(() => previews.consume(created.previewId, created.previewToken, "ws-b")).toThrow("invalid or expired");
    expect(() => previews.consume(created.previewId, "0".repeat(64), "ws-a")).toThrow("invalid or expired");

    // Valid consume succeeds once, then replay is rejected.
    expect(previews.consume(created.previewId, created.previewToken, "ws-a").profiles[0]?.id).toBe("prev_1");
    expect(() => previews.consume(created.previewId, created.previewToken, "ws-a")).toThrow("invalid or expired");

    // Capacity cap of 4 evicts oldest.
    const batch = Array.from({ length: 5 }, () => previews.create(payload, raw, store, "ws-a"));
    expect(previews.size()).toBe(4);
    expect(() => previews.consume(batch[0]!.previewId, batch[0]!.previewToken, "ws-a")).toThrow("invalid or expired");

    // TTL expiration rejects stale preview.
    now += 60_001;
    expect(() => previews.consume(batch[4]!.previewId, batch[4]!.previewToken, "ws-a")).toThrow("invalid or expired");
  });

  test("applyProfilePackageImport handles skip, clone_new_id (with session remap), and overwrite_closed (force skipping running/trashed)", () => {
    const store = memStore();
    const existingClosed = sampleProfile("closed_1", "Old Closed");
    existingClosed.notes = "Old note";
    const existingRunning = sampleProfile("running_1", "Old Running");
    const existingTrashed = sampleProfile("trashed_1", "Old Trashed");
    store.upsertProfiles([existingClosed, existingRunning, existingTrashed]);
    store.trashProfile("trashed_1");
    store.recordLaunch({
      profileId: "running_1",
      pid: 99999,
      debugPort: 9222,
      ws: "ws://127.0.0.1:9222/devtools/browser/test",
      startedAt: Date.now(),
    });

    const incomingClosed = { ...sampleProfile("closed_1", "New Closed"), notes: "Updated note" };
    const incomingRunning = sampleProfile("running_1", "New Running");
    const incomingTrashed = sampleProfile("trashed_1", "New Trashed");
    const incomingBrandNew = sampleProfile("fresh_1", "Brand New");
    const payload = createProfilePackage(
      [incomingClosed, incomingRunning, incomingTrashed, incomingBrandNew],
      {
        sessions: {
          closed_1: SAMPLE_SESSION,
          running_1: SAMPLE_SESSION,
          trashed_1: SAMPLE_SESSION,
          fresh_1: SAMPLE_SESSION,
        },
      },
    );

    // 1. Preview classifies conflict reasons accurately.
    const previews = new ProfilePackagePreviewStore();
    const preview = previews.create(payload, Buffer.from("dummy"), store, "default");
    expect(preview.newCount).toBe(1);
    expect(preview.conflictCount).toBe(3);
    expect(preview.runningConflictCount).toBe(1);
    expect(preview.trashedConflictCount).toBe(1);
    expect(Object.fromEntries(preview.profiles.map((p) => [p.id, p.conflictReason]))).toEqual({
      closed_1: "existing_active",
      running_1: "running",
      trashed_1: "existing_trashed",
      fresh_1: null,
    });

    // 2. Strategy: skip -> only fresh_1 imported.
    const skipRes = applyProfilePackageImport(store, payload, { strategy: "skip" });
    expect(skipRes).toMatchObject({ importedCount: 1, clonedCount: 0, overwrittenCount: 0, skippedCount: 3 });
    expect(store.getProfile("fresh_1")?.name).toBe("Brand New");
    expect(store.getPendingSessionBundle("fresh_1")).toBe(SAMPLE_SESSION);
    expect(store.getProfile("closed_1")?.name).toBe("Old Closed");

    // 3. Strategy: clone_new_id -> conflicts cloned with new IDs, remapped sessions, and " (导入)" suffix.
    const cloneRes = applyProfilePackageImport(store, payload, {
      strategy: "clone_new_id",
      selectedIds: ["closed_1", "running_1"],
    });
    expect(cloneRes).toMatchObject({ importedCount: 0, clonedCount: 2, overwrittenCount: 0, skippedCount: 2 });
    const clonedClosed = cloneRes.items.find((item) => item.sourceId === "closed_1")!;
    expect(clonedClosed.action).toBe("cloned");
    expect(clonedClosed.targetId).not.toBe("closed_1");
    expect(store.getProfile(clonedClosed.targetId!)?.name).toBe("New Closed (导入)");
    expect(store.getPendingSessionBundle(clonedClosed.targetId!)).toBe(SAMPLE_SESSION);

    // 4. Strategy: overwrite_closed -> overwrites closed_1, FORCE SKIPS running_1 and trashed_1.
    const overwriteRes = applyProfilePackageImport(store, payload, {
      strategy: "overwrite_closed",
      selectedIds: ["closed_1", "running_1", "trashed_1"],
    });
    expect(overwriteRes).toMatchObject({ importedCount: 0, clonedCount: 0, overwrittenCount: 1, skippedCount: 3 });
    expect(store.getProfile("closed_1")?.name).toBe("New Closed");
    expect(store.getProfile("closed_1")?.notes).toBe("Updated note");
    expect(store.getPendingSessionBundle("closed_1")).toBe(SAMPLE_SESSION);
    expect(store.getProfile("running_1")?.name).toBe("Old Running");
    expect(store.isTrashed("trashed_1")).toBe(true);

    // Timeline records package.imported for imported/overwritten profile.
    const events = listProfileEvents(store, "closed_1").events;
    expect(events.some((event) => event.eventType === "package.imported")).toBe(true);
  });
});
