import assert from "node:assert/strict";
import { act } from "react";
import type { RuntimeDownload } from "../runtime-download.ts";
import { BrowserRuntimeSettings } from "../web/browser-runtime-settings.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import type { BrowserRuntimeInventory } from "../web/settings-api.ts";
import { createWebDomHarness } from "./web-dom.ts";

const catalog: BrowserRuntimeInventory = {
  host: { platform: "darwin", arch: "arm64" }, checked: false,
  defaultRuntime: "aliasmode-firefox", chromiumDefault: "aliasmode-chromium",
  runtimes: [
    { id: "aliasmode-chromium", pinnedVersion: "155.0.8059.85-aliasmode.5", hostSupported: true, source: "managed", cache: "not-checked" },
    { id: "cloakbrowser", pinnedVersion: "145.0.7632.109.2", hostSupported: true, source: "configured", cache: "not-applicable" },
    { id: "aliasmode-firefox", pinnedVersion: "156.0.1-beta.36", hostSupported: true, source: "managed", cache: "not-checked" },
  ],
};
const inspected: BrowserRuntimeInventory = {
  ...catalog, checked: true,
  runtimes: catalog.runtimes.map(runtime => ({ ...runtime,
    cache: runtime.id === "aliasmode-chromium" ? "present-unverified" : runtime.id === "aliasmode-firefox" ? "missing" : "not-applicable",
  })),
};
const activeDownloads: readonly RuntimeDownload[] = [
  { runtime: "aliasmode", receivedBytes: 15_000_000, totalBytes: 60_000_000 },
  { runtime: "firefox", receivedBytes: 75_000_000, totalBytes: 100_000_000 },
  { runtime: "firefox", receivedBytes: 3_500_000, totalBytes: 0 },
  { runtime: "cloakbrowser", receivedBytes: Number.POSITIVE_INFINITY, totalBytes: 90_000_000 },
];

async function run(scenario: string) {
  const requests: { method: string; signal: AbortSignal }[] = [];
  let rejectCatalog = scenario === "retry" || scenario === "transfers";
  let rejectCheck = scenario === "retry";
  let finishCheck: ((response: Response) => void) | undefined;
  const fetchFixture = async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ language: "en-US" });
    const method = options?.method;
    assert.ok(method === "GET" || method === "POST");
    assert.ok(options?.signal);
    assert.equal(options.credentials, "same-origin");
    assert.equal(new Headers(options.headers).get("X-Maobu-Settings"), "1");
    requests.push({ method, signal: options.signal });
    if (method === "GET") {
      assert.equal(input, "/ui/api/settings/runtimes");
      assert.equal(options.body, undefined);
      if (rejectCatalog) {
        rejectCatalog = false;
        return Response.json({ ok: true, inventory: { ...catalog, checked: true } });
      }
      return Response.json({ ok: true, inventory: catalog });
    }
    assert.equal(input, "/ui/api/settings/runtimes/inspect");
    assert.equal(options.body, "{}");
    if (rejectCheck) {
      rejectCheck = false;
      return Response.json({ ok: false, error: "private fixture path" }, { status: 503 });
    }
    return new Promise<Response>(resolve => { finishCheck = resolve; });
  };
  const dom = await createWebDomHarness({ fetch: Object.assign(fetchFixture, { preconnect: globalThis.fetch.preconnect }) as typeof fetch });
  const button = (text: string) => {
    const found = [...dom.container.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
    assert.ok(found, `Missing button: ${text}`);
    return found;
  };
  const render = (downloads?: readonly RuntimeDownload[]) => dom.render(<I18nProvider><BrowserRuntimeSettings downloads={downloads} /></I18nProvider>);
  const card = (id: string) => {
    const found = dom.container.querySelector(`[data-browser-runtime="${id}"]`);
    assert.ok(found, `Missing runtime card: ${id}`);
    return found;
  };
  const checkDownloads = () => {
    const firefox = card("aliasmode-firefox");
    const firefoxBars = [...firefox.querySelectorAll("progress")];
    assert.equal(firefoxBars.length, 2);
    assert.equal(firefoxBars[0]!.getAttribute("value"), "75");
    assert.equal(firefoxBars[1]!.hasAttribute("value"), false);
    assert.ok(firefox.textContent.includes("75 MB of 100 MB"));
    assert.ok(firefox.textContent.includes("Downloaded 3.5 MB · Total size unknown"));
    assert.ok(firefox.textContent.includes("Transfer 1") && firefox.textContent.includes("Transfer 2"));
    for (const [index, progress] of firefoxBars.entries()) {
      const labels = progress.getAttribute("aria-labelledby")!.split(" ").map(id => dom.window.document.getElementById(id)?.textContent);
      assert.deepEqual(labels, ["AliasMode Firefox", "Downloading browser…", `Transfer ${index + 1}`]);
    }
    assert.equal(card("aliasmode-chromium").querySelector("progress")?.getAttribute("value"), "25");
    const cloak = card("cloakbrowser");
    assert.equal(cloak.querySelector("progress")?.hasAttribute("value"), false);
    assert.ok(cloak.textContent.includes("Downloaded size unavailable"));
    assert.ok(!dom.container.textContent.includes("Infinity"));
  };
  try {
    await render(scenario === "transfers" ? activeDownloads : undefined);
    await dom.flush();
    assert.deepEqual(requests.map(item => item.method), ["GET"]);
    const heading = dom.container.querySelector("[data-browser-runtime-settings-heading]");
    assert.ok(heading instanceof dom.window.HTMLElement);
    assert.equal(heading.tagName, "H3");
    assert.equal(heading.tabIndex, -1);
    await act(async () => heading.focus());
    assert.equal(dom.window.document.activeElement, heading);
    if (scenario === "retry" || scenario === "transfers") {
      assert.equal(dom.container.querySelector('[role="alert"]')?.textContent, "Could not load browser runtimes. Try again.");
      if (scenario === "transfers") checkDownloads();
      await act(async () => button("Try again").click());
      await dom.flush();
    }
    assert.ok(dom.container.textContent?.includes("Cache not checked"));
    assert.ok(dom.container.textContent?.includes("Default when engine is unspecified"));
    assert.ok(dom.container.textContent?.includes("Chromium default"));
    assert.ok(dom.container.textContent?.includes("Executable version not measured"));
    assert.equal(requests.filter(item => item.method === "POST").length, 0);
    if (scenario === "transfers") {
      checkDownloads();
      const next = activeDownloads.map(download => download.runtime === "aliasmode" ? { ...download, receivedBytes: 45_000_000 } : download);
      await render(next);
      assert.equal(card("aliasmode-chromium").querySelector("progress")?.getAttribute("value"), "75");
      assert.equal(requests.length, 2, "Snapshot updates must not issue requests");
    }
    await act(async () => button("Refresh local cache").click());
    await dom.flush();
    if (scenario === "retry") {
      assert.equal(dom.container.querySelector('[role="alert"]')?.textContent, "Could not refresh the browser cache. Try again.");
      assert.ok(!dom.container.textContent?.includes("private fixture path"));
      assert.ok(dom.container.textContent?.includes("Cache not checked"));
      await act(async () => button("Refresh local cache").click());
    }
    assert.equal(button("Checking cache…").disabled, true);
    const pending = requests.at(-1)!;
    assert.equal(pending.method, "POST");
    assert.ok(finishCheck);
    if (scenario === "unmount") {
      await dom.unmount();
      assert.equal(pending.signal.aborted, true);
      await act(async () => finishCheck!(Response.json({ ok: true, inventory: inspected })));
      assert.equal(dom.container.textContent, "");
      return;
    }
    await act(async () => finishCheck!(Response.json({ ok: true, inventory: inspected })));
    await dom.flush();
    assert.ok(dom.container.textContent?.includes("Files found · unverified"));
    assert.ok(dom.container.textContent?.includes("Not cached"));
    assert.ok(dom.container.textContent?.includes("Showing the last local cache check."));
    assert.equal(button("Refresh local cache").disabled, false);
    assert.equal(dom.container.querySelector('[role="alert"]'), null);
    if (scenario === "transfers") {
      const count = requests.length;
      await render([]);
      assert.equal(dom.container.querySelectorAll("progress").length, 0);
      assert.ok(card("aliasmode-firefox").textContent.includes("Not cached"));
      assert.ok(card("aliasmode-chromium").textContent.includes("Files found · unverified"));
      assert.ok(!dom.container.textContent.includes("Ready"));
      assert.equal(requests.length, count, "Disappearing transfers must not inspect the cache or reload the inventory");
    }
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "refresh"); console.log("browser runtime settings fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
