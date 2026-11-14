import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceCatalog, WORKSPACE_REGISTRY_FILE, writeWorkspaceJson } from "./workspaces.ts";
const roots: string[] = [];
function home() { const root = mkdtempSync(join(tmpdir(), "maobu-catalog-test-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("maobu-catalog-test-")) throw new Error("Unsafe test cleanup"); rmSync(root, { recursive: true, force: true }); } });

test("default preserves legacy data and other workspaces use isolated fixed ID paths", () => {
  const root = home(); writeFileSync(join(root, "profiles.sqlite"), "legacy-data"); mkdirSync(join(root, "profiles")); writeFileSync(join(root, "profiles", "legacy"), "original");
  const catalog = new WorkspaceCatalog(root, root);
  expect(catalog.currentId()).toBe("default"); expect(catalog.activeId()).toBe("default");
  const entry = catalog.create({ name: "  客户 A  ", color: "#628ac7", icon: "briefcase" });
  expect(entry.id).toMatch(/^ws_[0-9a-f]{32}$/); expect(entry.name).toBe("客户 A"); expect(entry.lastOpenedAt).toBe(0);
  const path = catalog.pathFor(entry.id); expect(path).toBe(join(root, "workspaces", entry.id));
  writeFileSync(join(path, "profiles.sqlite"), "independent");
  catalog.setActive(entry.id);
  expect(catalog.currentId()).toBe("default"); expect(catalog.activeId()).toBe(entry.id);
  expect(new WorkspaceCatalog(root, path).currentId()).toBe(entry.id);
  expect(readFileSync(join(root, "profiles.sqlite"), "utf8")).toBe("legacy-data");
  expect(readFileSync(join(root, "profiles", "legacy"), "utf8")).toBe("original");
  expect(() => catalog.pathFor("../outside")).toThrow();
  expect(() => new WorkspaceCatalog(root, join(root, "unregistered"))).toThrow();
});
test("names, appearance, switching and reversible archive rules persist", () => {
  const root = home(), catalog = new WorkspaceCatalog(root, root);
  const first = catalog.create({ name: "Client A" }); const second = catalog.create({ name: "Client B" });
  for (const input of [{ name: " client a " }, { name: "" }, { name: "长".repeat(41) }, { name: "Bad\nname" }, { name: "Invalid", color: "red" }, { name: "Invalid", icon: "<svg>" }]) expect(() => catalog.create(input)).toThrow();
  catalog.update(first.id, { name: "运营", color: "#638f77", icon: "globe" });
  expect(catalog.list().find(item => item.id === first.id)).toMatchObject({ name: "运营", color: "#638f77", icon: "globe" });
  expect(() => catalog.update(first.id, { name: "Client B" })).toThrow();
  expect(() => catalog.archive("default")).toThrow();
  catalog.setActive(first.id); expect(() => catalog.archive(first.id)).toThrow();
  expect(catalog.archive(second.id).archived).toBe(true); expect(() => catalog.setActive(second.id)).toThrow();
  expect(catalog.archive(second.id, false).archived).toBe(false); catalog.setActive(second.id);
  const saved = JSON.parse(readFileSync(join(root, WORKSPACE_REGISTRY_FILE), "utf8"));
  expect(saved.activeId).toBe(second.id); expect(saved.workspaces.every((item: any) => Number.isSafeInteger(item.lastOpenedAt))).toBe(true);
});
test("bad registries and a live writer lock are rejected without replacing original bytes", () => {
  const root = home(); const catalog = new WorkspaceCatalog(root, root);
  const path = join(root, WORKSPACE_REGISTRY_FILE); const original = readFileSync(path, "utf8");
  const valid = JSON.parse(original);
  const cases = ["broken-json", JSON.stringify({ ...valid, activeId: "ws_" + "a".repeat(32) }), JSON.stringify({ ...valid, workspaces: [valid.workspaces[0], valid.workspaces[0]] }), JSON.stringify({ ...valid, workspaces: [{ ...valid.workspaces[0], lastOpenedAt: null }] }), JSON.stringify({ ...valid, workspaces: [{ ...valid.workspaces[0], archived: true }] })];
  for (const value of cases) { writeFileSync(path, value); expect(() => new WorkspaceCatalog(root, root)).toThrow(); expect(readFileSync(path, "utf8")).toBe(value); }
  writeFileSync(path, original); const lock = join(root, "desktop-workspaces.lock"); writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "another-writer" }));
  expect(() => catalog.create({ name: "Blocked" })).toThrow("busy"); expect(readFileSync(path, "utf8")).toBe(original); unlinkSync(lock);
  expect(catalog.create({ name: "After unlock" }).name).toBe("After unlock");
});
test("linked home and workspace containers are rejected without following them", () => {
  const root = home(); const outside = home(); writeFileSync(join(outside, "keep"), "safe");
  const linked = join(root, "linked"); symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  expect(() => new WorkspaceCatalog(linked, linked)).toThrow();
  const catalog = new WorkspaceCatalog(root, root); symlinkSync(outside, join(root, "workspaces"), process.platform === "win32" ? "junction" : "dir");
  expect(() => catalog.create({ name: "No links" })).toThrow();
  expect(existsSync(join(outside, WORKSPACE_REGISTRY_FILE))).toBe(false); expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
});

test("atomic metadata replacement retains old bytes on serialization failure and removes private temporaries", () => {
  const root = home(), path = join(root, "metadata.json");
  for (let revision = 0; revision < 100; revision++) {
    writeWorkspaceJson(path, { revision, name: "正常原子更新" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ revision, name: "正常原子更新" });
  }
  const before = readFileSync(path, "utf8"), cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => writeWorkspaceJson(path, cyclic)).toThrow();
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
