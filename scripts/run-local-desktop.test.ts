import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { prepareLocalDesktop } from "./run-local-desktop.mjs";

const recorder = "playwright/agent/script-recorder.mjs";
const dependency = "playwright/node_modules/playwright-core/lib/index.js";

async function withBuild(run: (fixture: {
  build: string;
  runtimeDirectory: string;
  write: (entry: string, content: string) => Promise<void>;
  setBrowserMetadata: (firefox: { executable: string } | null) => Promise<void>;
  prepare: () => ReturnType<typeof prepareLocalDesktop>;
}) => Promise<void>) {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, "maobu-launcher-test-"));
  const projectDirectory = join(root, "中文项目");
  const runtimeDirectory = join(root, "runtime");
  const build = join(projectDirectory, "src-tauri", "target", "debug");
  const metadataPath = join(projectDirectory, "src-tauri", "generated", "browser.json");
  const write = async (entry: string, content: string) => {
    const path = join(build, entry);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const setBrowserMetadata = (firefox: { executable: string } | null) => writeFile(metadataPath, JSON.stringify({ firefox }));
  try {
    const entries = [
      "aliasmode.exe", "aliasmode-sidecar.exe", "aliasmode-mcp.exe", "playwright/package.json",
      "playwright/node/node.exe", "playwright/worker.mjs", "playwright/playwright-worker.mjs",
      "playwright/firefox-worker.mjs", ...[
        "mcp-host.mjs", "mcp-scope.mjs", "playwright-proxy.mjs", "playwright-runner.mjs",
        "runtime-client.mjs", "script-runner.mjs", "script-runner.py",
      ].map((name) => `playwright/agent/${name}`),
      recorder, dependency, ...["playwright-core", "@playwright/mcp", "@modelcontextprotocol/sdk", "playwright"]
        .map((name) => `playwright/node_modules/${name}/package.json`),
    ];
    await Promise.all(entries.map((entry) => write(entry, entry)));
    await mkdir(dirname(metadataPath), { recursive: true });
    await setBrowserMetadata(null);
    await writeFile(join(projectDirectory, "LICENSE"), "license fixture");
    await writeFile(join(projectDirectory, "NOTICE"), "notice fixture");
    await run({
      build, runtimeDirectory, write, setBrowserMetadata,
      prepare: () => prepareLocalDesktop({ projectDirectory, runtimeDirectory }),
    });
  } finally {
    const actualRoot = await realpath(root);
    if (actualRoot === root && dirname(actualRoot) === base) await rm(root, { recursive: true, force: true });
  }
}

test("the recorder and dependency contents invalidate an existing runtime from a Chinese source path", async () => {
  await withBuild(async ({ prepare, write }) => {
    const original = await prepare();
    expect(original.bundledFirefox).toBe(false);
    expect(original.runtimeRoot).toMatch(/MaobuBrowser-local-[a-f0-9]{16}$/);
    await write(recorder, "new recorder");
    const updatedRecorder = await prepare();
    expect(updatedRecorder.runtimeRoot).not.toBe(original.runtimeRoot);
    expect(await readFile(join(updatedRecorder.runtimeRoot, recorder), "utf8")).toBe("new recorder");
    await write(dependency, "updated Playwright package code");
    const updatedDependency = await prepare();
    expect(updatedDependency.runtimeRoot).not.toBe(updatedRecorder.runtimeRoot);
    expect(await readFile(join(updatedDependency.runtimeRoot, dependency), "utf8")).toBe("updated Playwright package code");
    expect(await prepare()).toEqual(updatedDependency);
  });
});

test("a runtime without the required recorder is rejected before a cache is published", async () => {
  await withBuild(async ({ prepare, build, runtimeDirectory }) => {
    await unlink(join(build, recorder));
    await expect(prepare()).rejects.toThrow(recorder);
    expect(await readdir(runtimeDirectory)).toEqual([]);
  });
});

test("a ready marker does not conceal a changed, missing, or extra runtime resource", async () => {
  await withBuild(async ({ prepare }) => {
    const { runtimeRoot } = await prepare();
    const extra = join(runtimeRoot, "playwright", "unexpected.mjs");
    await writeFile(extra, "extra");
    await expect(prepare()).rejects.toThrow("playwright/unexpected.mjs");
    await unlink(extra);
    await writeFile(join(runtimeRoot, dependency), "changed");
    await expect(prepare()).rejects.toThrow(dependency);
    await unlink(join(runtimeRoot, dependency));
    await expect(prepare()).rejects.toThrow(dependency);
  });
});

test("concurrent cold preparations agree on one complete cache and clean up their staging directories", async () => {
  await withBuild(async ({ prepare, runtimeDirectory }) => {
    const [first, second] = await Promise.all([prepare(), prepare()]);
    expect(second).toEqual(first);
    expect(await readdir(runtimeDirectory)).toEqual([basename(first.runtimeRoot)]);
    expect(await readFile(join(first.runtimeRoot, recorder), "utf8")).toBe(recorder);
  });
});

test("optional offline Firefox support files participate in the cache identity", async () => {
  await withBuild(async ({ prepare, write, setBrowserMetadata }) => {
    await setBrowserMetadata({ executable: "bin/aliasmode.exe" });
    await write("firefox/bin/aliasmode.exe", "browser fixture");
    await write("firefox/bin/browser-support.dll", "first support file");
    const first = await prepare();
    expect(first.bundledFirefox).toBe(true);
    await write("firefox/bin/browser-support.dll", "second support file");
    const second = await prepare();
    expect(second.runtimeRoot).not.toBe(first.runtimeRoot);
    await setBrowserMetadata({ executable: "../aliasmode.exe" });
    await expect(prepare()).rejects.toThrow("浏览器资源路径无效");
  });
});
