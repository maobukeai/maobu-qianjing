import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserRuntimeSettings } from "./browser-runtime-settings.tsx";
import { I18nProvider } from "./i18n.tsx";

test("browser runtime card can render before the catalog is fetched", () => {
  const markup = renderToStaticMarkup(<I18nProvider><BrowserRuntimeSettings /></I18nProvider>);
  expect(markup).toContain("Browser runtimes");
  expect(markup).toContain("Loading…");
  expect(markup).not.toContain("Files found · unverified");
});

for (const scenario of ["refresh", "retry", "unmount", "transfers"]) {
  test(`browser runtime card ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../test-fixtures/browser-runtime-settings-dom.tsx"), scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("browser runtime settings fixture passed");
  }, 15000);
}
