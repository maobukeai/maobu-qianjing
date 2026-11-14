import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeDownload } from "../runtime-download.ts";
import { I18nProvider } from "./i18n.tsx";
import { RuntimeDownloadProgressView, runtimeDownloadLabel, runtimeDownloadPercent } from "./runtime-download-progress.tsx";

const download = (receivedBytes: number, totalBytes: number): RuntimeDownload => ({ runtime: "firefox", receivedBytes, totalBytes });
const english = (source: string, values?: Record<string, string | number>) => source.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key]));
async function view(downloads: RuntimeDownload[]) {
  const html = renderToStaticMarkup(<I18nProvider><RuntimeDownloadProgressView downloads={downloads} /></I18nProvider>);
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
