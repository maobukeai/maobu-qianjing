import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeDownload } from "../src/runtime-download.ts";
import { I18nProvider } from "./i18n.tsx";
import { RuntimeDownloadProgressView, runtimeDownloadLabel, runtimeDownloadPercent } from "./runtime-download-progress.tsx";

const download = (receivedBytes: number, totalBytes: number, extra: Partial<RuntimeDownload> = {}): RuntimeDownload => ({ runtime: "firefox", receivedBytes, totalBytes, ...extra });
const english = (source: string, values?: Record<string, string | number>) => source.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key]));
async function view(downloads: RuntimeDownload[], props: Partial<Parameters<typeof RuntimeDownloadProgressView>[0]> = {}) {
  const html = renderToStaticMarkup(<I18nProvider><RuntimeDownloadProgressView downloads={downloads} {...props} /></I18nProvider>);
  let progress: Record<string, string> | undefined;
  await new HTMLRewriter().on("progress", { element(element) { progress = Object.fromEntries(element.attributes); } }).transform(new Response(html)).text();
  return { html, progress: progress! };
}

test("unknown-length and mixed transfers render an indeterminate native progress bar", async () => {
  for (const downloads of [[download(0, 0)], [download(50, 100), download(0, 0)]]) {
    const { html, progress } = await view(downloads);
    expect(html).toContain("Downloading browser…");
    expect(html).not.toMatch(/NaN|Infinity|undefined|\d+%/);
    expect(progress.value).toBeUndefined();
    expect(progress["aria-label"]).toBe("Browser download progress");
    expect(runtimeDownloadLabel(downloads, english)).toBe("Downloading browser…");
  }
});

test("known transfers use byte-weighted progress and share the row label", async () => {
  const downloads = [download(25, 100), download(75, 300)];
  const { html, progress } = await view(downloads);
  expect(progress.value).toBe("25");
  expect(progress.max).toBe("100");
  expect(html).toContain("Downloading browser… 25%");
  expect(runtimeDownloadLabel(downloads, english)).toBe("Downloading browser… 25%");
  expect(runtimeDownloadPercent([download(150, 100)])).toBe(100);
});

test("empty or invalid progress cannot become a false completion percentage", () => {
  for (const downloads of [[], [download(-1, 100)], [download(1, -1)], [download(1, Infinity)], [download(NaN, 100)], [download(1, 2.5)], [download(1, Number.MAX_SAFE_INTEGER), download(0, 1)]]) {
    expect(runtimeDownloadPercent(downloads)).toBeNull();
  }
});

test("paused downloads render paused labels, resume action, and cancel button while preserving percentage", async () => {
  const paused = [download(50 * 1024 * 1024, 100 * 1024 * 1024, { status: "paused", bytesPerSec: 0 })];
  expect(runtimeDownloadLabel(paused, english)).toBe("Download paused · 50%");
  const { html, progress } = await view(paused, { onPause: () => {}, onResume: () => {}, onCancel: () => {} });
  expect(html).toContain("is-paused");
  expect(html).toContain("Download paused · 50%");
  expect(html).toContain("50.0 MB / 100 MB");
  expect(html).toContain("Resume");
  expect(html).toContain("Cancel");
  expect(html).not.toContain(">Pause<");
  expect(progress.value).toBe("50");
});

test("active downloads with speed show transfer rate, pause button, and details toggle", async () => {
  const active = [download(25 * 1024 * 1024, 100 * 1024 * 1024, { status: "downloading", bytesPerSec: 5 * 1024 * 1024 })];
  const { html } = await view(active, { onPause: () => {}, onResume: () => {}, onCancel: () => {} });
  expect(html).toContain("5.0 MB/s");
  expect(html).toContain("15s");
  expect(html).toContain("Pause");
  expect(html).toContain("Cancel");
  expect(html).toContain("Details");
});
