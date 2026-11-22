import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourcePolicyStore } from "./resource-policy-store.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ResourcePolicyStore", () => {
  test("creates profile_resource_policies idempotently without views, triggers, or virtual tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "maobu-rps-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "profiles.sqlite");

    const store1 = new ResourcePolicyStore(dbPath);
    try {
      expect(store1.get("p1")).toEqual({
        profileId: "p1",
        memorySaverMode: "inherit",
        dataSaver: { mode: "inherit" },
        updatedAt: 0,
      });
      const saved = store1.set("p1", {
        memorySaverMode: "on",
        dataSaver: { mode: "on", blockImages: true, blockFonts: true },
      }, 1_700_000_000_000);
      expect(saved).toEqual({
        profileId: "p1",
        memorySaverMode: "on",
        dataSaver: { mode: "on", blockImages: true, blockFonts: true },
        updatedAt: 1_700_000_000_000,
      });
    } finally {
      store1.close();
    }

    // Reopen idempotently and verify schema stays backup-safe (plain table only)
    const store2 = new ResourcePolicyStore(dbPath);
    try {
      expect(store2.get("p1")).toEqual({
        profileId: "p1",
        memorySaverMode: "on",
        dataSaver: { mode: "on", blockImages: true, blockFonts: true },
        updatedAt: 1_700_000_000_000,
      });
      expect(store2.list()).toHaveLength(1);
    } finally {
      store2.close();
    }

    const inspectDb = new Database(dbPath, { readonly: true });
    try {
      const forbidden = inspectDb
        .query("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') OR upper(sql) LIKE '%CREATE VIRTUAL TABLE%' LIMIT 1")
        .get();
      expect(forbidden).toBeNull();
    } finally {
      inspectDb.close();
    }
  });

  test("supports partial updates, inherit cleanup, delete, validation, and corrupt JSON fallback", () => {
    const db = new Database(":memory:");
    const store = new ResourcePolicyStore(db);
    try {
      store.set("p1", { memorySaverMode: "off" }, 100);
      expect(store.get("p1").memorySaverMode).toBe("off");
      expect(store.get("p1").dataSaver).toEqual({ mode: "inherit" });

      // Partial patch keeps memorySaverMode
      store.set("p1", { dataSaver: "off" }, 200);
      expect(store.get("p1")).toEqual({
        profileId: "p1",
        memorySaverMode: "off",
        dataSaver: { mode: "off" },
        updatedAt: 200,
      });

      // Returning both to inherit removes the row
      store.set("p1", { memorySaverMode: "inherit", dataSaver: "inherit" }, 300);
      expect(store.list()).toEqual([]);

      // Validation errors
      expect(() => store.get("../escape")).toThrow();
      expect(() => store.set("p1", { memorySaverMode: "invalid" })).toThrow();
      expect(() => store.set("p1", { dataSaver: { mode: "on", blockImages: "yes" } })).toThrow();
      expect(() => store.set("p1", { unknown: 1 })).toThrow();

      // Corrupt JSON in DB degrades cleanly to inherit instead of crashing launches
      db.query(
        "INSERT INTO profile_resource_policies (profile_id, memory_saver_mode, data_saver_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run("p2", "on", "{not-json", 400);
      expect(store.get("p2")).toEqual({
        profileId: "p2",
        memorySaverMode: "on",
        dataSaver: { mode: "inherit" },
        updatedAt: 400,
      });
      expect(store.delete("p2")).toBe(true);
      expect(store.delete("p2")).toBe(false);
    } finally {
      store.close();
      db.close();
    }
  });
});
