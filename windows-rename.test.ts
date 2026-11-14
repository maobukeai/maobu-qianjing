import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renameWithWindowsRetry, renameWithWindowsRetrySync } from "./windows-rename.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "maobu-rename-")); roots.push(root);
  const source = join(root, "next.json"), destination = join(root, "current.json");
  writeFileSync(source, "new-data"); writeFileSync(destination, "original-data");
  return { source, destination };
}
function sharingError(code = "EPERM") { return Object.assign(new Error("held by another handle"), { code }); }

test("Windows retries the same atomic rename while retaining original bytes until it succeeds", () => {
  const f = fixture(), delays: number[] = [], calls: string[][] = [];
  renameWithWindowsRetrySync(f.source, f.destination, {
    platform: "win32", sleep: delay => { delays.push(delay); },
    rename: (from, to) => {
      calls.push([from, to]);
      if (calls.length < 3) {
        expect(readFileSync(f.source, "utf8")).toBe("new-data");
        expect(readFileSync(f.destination, "utf8")).toBe("original-data");
        throw sharingError(calls.length === 1 ? "EPERM" : "EBUSY");
      }
      renameSync(from, to);
    },
  });
  expect(delays).toEqual([10, 20]);
  expect(calls).toEqual(Array.from({ length: 3 }, () => [f.source, f.destination]));
  expect(readFileSync(f.destination, "utf8")).toBe("new-data"); expect(existsSync(f.source)).toBe(false);
});

test("a lasting Windows lock exhausts a 150ms schedule and preserves source and destination", () => {
  const f = fixture(), delays: number[] = [], error = sharingError(); let attempts = 0, thrown: unknown;
  try { renameWithWindowsRetrySync(f.source, f.destination, {
    platform: "win32", sleep: delay => { delays.push(delay); }, rename: () => { attempts++; throw error; },
  }); } catch (value) { thrown = value; }
  expect(thrown).toBe(error); expect(attempts).toBe(5); expect(delays).toEqual([10, 20, 40, 80]);
  expect(readFileSync(f.source, "utf8")).toBe("new-data");
  expect(readFileSync(f.destination, "utf8")).toBe("original-data");
});

test("non-Windows sharing failures and non-sharing errors are never retried or wrapped", () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "EACCES"], ["win32", "ENOENT"], ["win32", "EXDEV"], ["win32", "ENOTEMPTY"]] as const) {
    const error = sharingError(code); let attempts = 0, sleeps = 0, thrown: unknown;
    try { renameWithWindowsRetrySync("source", "destination", { platform, rename: () => { attempts++; throw error; }, sleep: () => { sleeps++; } }); }
    catch (value) { thrown = value; }
    expect(thrown).toBe(error); expect(attempts).toBe(1); expect(sleeps).toBe(0);
  }
});

test("async migration retries yield on the same bounded schedule and retain failure identity", async () => {
  const f = fixture(), delays: number[] = []; let attempts = 0;
  await renameWithWindowsRetry(f.source, f.destination, {
    platform: "win32", sleep: async delay => { delays.push(delay); },
    rename: (from, to) => { attempts++; if (attempts < 5) throw sharingError(); renameSync(from, to); },
  });
  expect(delays).toEqual([10, 20, 40, 80]); expect(readFileSync(f.destination, "utf8")).toBe("new-data");
  const held = sharingError("EBUSY"); let thrown: unknown;
  try { await renameWithWindowsRetry("source", "destination", { platform: "win32", rename: () => { throw held; }, sleep: async () => {} }); }
  catch (error) { thrown = error; }
  expect(thrown).toBe(held);
});

test("a new structural error during a retry is reported immediately without exhausting the schedule", async () => {
  const delays: number[] = [], missing = Object.assign(new Error("source no longer exists"), { code: "ENOENT" }); let calls = 0, thrown: unknown;
  try { await renameWithWindowsRetry("source", "destination", {
    platform: "win32", sleep: async delay => { delays.push(delay); }, rename: () => { if (++calls === 1) throw sharingError(); throw missing; },
  }); } catch (error) { thrown = error; }
  expect(thrown).toBe(missing); expect(calls).toBe(2); expect(delays).toEqual([10]);
});
